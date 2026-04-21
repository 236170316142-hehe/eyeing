require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const archiver = require('archiver');
const { spawn } = require('child_process');
const { OAuth2Client } = require('google-auth-library');
const Report = require('./models/Report');
const TrackingStatus = require('./models/TrackingStatus');
const Summary = require('./models/Summary');
const SetupProfile = require('./models/SetupProfile');

const app = express();
const PORT = process.env.PORT || 3000;
const ROOT_DIR = path.join(__dirname, '..');
const CONFIG_PATH = path.join(__dirname, '..', 'activity_data', 'config.json');
const MONITOR_PATH = path.join(ROOT_DIR, 'monitor.py');
const GOOGLE_CLIENT_ID = String(process.env.GOOGLE_CLIENT_ID || '').trim();
const PUBLIC_BACKEND_URL = String(process.env.PUBLIC_BACKEND_URL || process.env.RENDER_EXTERNAL_URL || 'https://eyeing.onrender.com').trim().replace(/\/$/, '');
const ADMIN_USERNAME = String(process.env.ADMIN_USERNAME || '').trim();
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || '').trim();
const HAS_ADMIN_AUTH = Boolean(ADMIN_USERNAME && ADMIN_PASSWORD);
const googleOAuthClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

function getPublicBaseUrl(req) {
  if (PUBLIC_BACKEND_URL) {
    return PUBLIC_BACKEND_URL;
  }

  return `${req.protocol}://${req.get('host')}`;
}

function buildDayBounds(date) {
  const [y, m, d] = date.split('-').map(Number);
  const start = new Date(y, m - 1, d, 0, 0, 0, 0);
  const end = new Date(y, m - 1, d, 23, 59, 59, 999);

  return {
    start,
    end
  };
}

function getLocalDateString(date = new Date()) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function normalizeIdentity(value) {
  return String(value || '').trim();
}

function shouldResolveIdentity(companyId, userId) {
  const company = normalizeIdentity(companyId).toUpperCase();
  const user = normalizeIdentity(userId).toUpperCase();

  if (!company || !user) return true;
  if (company === 'UNKNOWN' || user === 'UNKNOWN') return true;
  if (company === 'ACME_001' && user === 'DEFAULT_USER') return true;

  return false;
}

async function resolveSetupProfile({ installId, deviceId }) {
  if (!HAS_MONGO) return null;

  const install = normalizeIdentity(installId);
  const device = normalizeIdentity(deviceId);

  const clauses = [];
  if (install) clauses.push({ install_id: install });
  if (device) clauses.push({ device_id: device });
  if (!clauses.length) return null;

  return SetupProfile.findOne({ $or: clauses }).sort({ updatedAt: -1 }).lean();
}

async function purgeTrackerArtifacts(companyId, userId, { removeTrackingStatus = false } = {}) {
  const [reportDel, summaryDel, setupDel] = await Promise.all([
    Report.deleteMany({ company_id: companyId, user_id: userId }),
    Summary.deleteMany({ company_id: companyId, user_id: userId }),
    SetupProfile.deleteMany({ company_id: companyId, user_id: userId }),
  ]);

  let statusDel = null;
  if (removeTrackingStatus) {
    statusDel = await TrackingStatus.deleteOne({ company_id: companyId, user_id: userId });
  }

  return {
    reportsDeleted: reportDel.deletedCount || 0,
    summariesDeleted: summaryDel.deletedCount || 0,
    setupProfilesDeleted: setupDel.deletedCount || 0,
    trackingStatusDeleted: statusDel?.deletedCount || 0,
  };
}

// Enforce MongoDB Atlas connection string from .env
const MONGO_URI = process.env.MONGO_URI;
const HAS_MONGO = Boolean(MONGO_URI);

if (!HAS_MONGO) {
  console.warn("⚠️ MONGO_URI is missing. Running in local setup-only mode (admin/report DB features disabled).");
}

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));

  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function parseBasicAuthHeader(headerValue) {
  if (!headerValue || !headerValue.startsWith('Basic ')) {
    return null;
  }

  try {
    const decoded = Buffer.from(headerValue.slice(6), 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    if (separator < 0) return null;

    return {
      username: decoded.slice(0, separator),
      password: decoded.slice(separator + 1)
    };
  } catch (_error) {
    return null;
  }
}

function requireAdminAuth(req, res, next) {
  if (!HAS_ADMIN_AUTH) {
    return res.status(503).json({
      error: 'Admin access is not configured on server. Set ADMIN_USERNAME and ADMIN_PASSWORD.'
    });
  }

  const parsed = parseBasicAuthHeader(req.headers.authorization || '');
  if (!parsed || !safeEqual(parsed.username, ADMIN_USERNAME) || !safeEqual(parsed.password, ADMIN_PASSWORD)) {
    res.set('WWW-Authenticate', 'Basic realm="Employee Admin"');
    return res.status(401).json({ error: 'Admin authentication required.' });
  }

  next();
}

// Protect admin surfaces so URL manipulation by employees cannot bypass access controls.
app.use('/admin.html', requireAdminAuth);
app.use('/api/admin', requireAdminAuth);
app.use('/api/reports/hierarchy', requireAdminAuth);
app.use('/api/reports/employee', requireAdminAuth);

app.use(express.static(path.join(__dirname, 'public')));

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function isLocalRequest(req) {
  const value = String(req.ip || req.socket?.remoteAddress || '').toLowerCase();
  return value.includes('127.0.0.1') || value.includes('::1') || value.endsWith('::ffff:127.0.0.1');
}

function readSetupConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch (error) {
    return null;
  }
}

function withTimeout(promise, ms, label = 'Operation') {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    })
  ]);
}

const EMPLOYEE_PACKAGE_DEFINITIONS = {
  windows: {
    label: 'Windows',
    archiveName: 'employee-monitor-windows.zip',
    includeBatchLauncher: true,
    includeUnixLauncher: false
  },
  macos: {
    label: 'macOS',
    archiveName: 'employee-monitor-macos.zip',
    includeBatchLauncher: false,
    includeUnixLauncher: true,
    includeMacCommandLauncher: true
  },
  linux: {
    label: 'Linux',
    archiveName: 'employee-monitor-linux.zip',
    includeBatchLauncher: false,
    includeUnixLauncher: true,
    includeMacCommandLauncher: false
  }
};

function normalizeEmployeePackagePlatform(value) {
  const normalized = String(value || '').trim().toLowerCase();

  if (['win', 'windows', 'win32'].includes(normalized)) return 'windows';
  if (['mac', 'macos', 'darwin', 'osx'].includes(normalized)) return 'macos';
  if (['linux', 'ubuntu', 'debian'].includes(normalized)) return 'linux';

  if (EMPLOYEE_PACKAGE_DEFINITIONS[normalized]) return normalized;

  return 'windows';
}

function getEmployeePackageDefinition(platform) {
  return EMPLOYEE_PACKAGE_DEFINITIONS[normalizeEmployeePackagePlatform(platform)];
}

function buildUnixLauncherScript() {
  return `#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

PYTHON_BIN="\${PYTHON:-}"
if [ -z "$PYTHON_BIN" ]; then
  if command -v python3 >/dev/null 2>&1; then
    PYTHON_BIN="$(command -v python3)"
  elif command -v python >/dev/null 2>&1; then
    PYTHON_BIN="$(command -v python)"
  else
    echo "Python 3 is required but was not found on PATH."
    exit 1
  fi
fi

exec "$PYTHON_BIN" install_and_run.py --autostart
`;
}

function buildMacCommandLauncher() {
  return `#!/usr/bin/env bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec /bin/bash "$SCRIPT_DIR/install.sh"
`;
}

function buildEmployeePackageReadme(platformLabel, origin) {
  return `Employee Monitor ${platformLabel} package

This archive is generated live from the Render backend so it always includes the latest app files and backend URL.

Included files:
- monitor.py
- install_and_run.py
- requirements.txt
- backend_url.txt
- backend/public/setup.html
- backend/public/employee-distribution.html

Launcher:
- Windows: install.bat
- macOS and Linux: install.sh

Launch the installer from this folder, or run it from a terminal with the platform launcher.

Backend URL:
${origin}
`;
}

function buildEmployeePackageManifest(platformDefinition, origin) {
  return JSON.stringify({
    generatedAt: new Date().toISOString(),
    platform: platformDefinition.label,
    backendUrl: origin,
    files: [
      'monitor.py',
      'install_and_run.py',
      'requirements.txt',
      'backend_url.txt',
      'backend/public/setup.html',
      'backend/public/employee-distribution.html'
    ]
  }, null, 2);
}

function addEmployeePackageFiles(archive, platformDefinition, origin) {
  const rootFiles = [
    'monitor.py',
    'install_and_run.py',
    'requirements.txt'
  ];

  rootFiles.forEach((relativePath) => {
    const absPath = path.join(ROOT_DIR, relativePath);
    if (fs.existsSync(absPath)) {
      archive.file(absPath, { name: relativePath.replace(/\\/g, '/') });
    }
  });

  if (platformDefinition.includeBatchLauncher) {
    const installBat = path.join(ROOT_DIR, 'install.bat');
    if (fs.existsSync(installBat)) {
      archive.file(installBat, { name: 'install.bat' });
    }
  }

  const webAssets = [
    'backend/public/setup.html',
    'backend/public/employee-distribution.html'
  ];

  webAssets.forEach((relativePath) => {
    const absPath = path.join(ROOT_DIR, relativePath);
    if (fs.existsSync(absPath)) {
      archive.file(absPath, { name: relativePath.replace(/\\/g, '/') });
    }
  });

  if (platformDefinition.includeUnixLauncher) {
    archive.append(buildUnixLauncherScript(), { name: 'install.sh', mode: 0o755 });

    if (platformDefinition.includeMacCommandLauncher) {
      archive.append(buildMacCommandLauncher(), { name: 'install.command', mode: 0o755 });
    }
  }

  archive.append(buildEmployeePackageReadme(platformDefinition.label, origin), { name: 'README.txt' });
  archive.append(buildEmployeePackageManifest(platformDefinition, origin), { name: 'manifest.json' });
  archive.append(`${origin}\n`, { name: 'backend_url.txt' });
}

function streamEmployeePackage(req, res, platform) {
  const origin = getPublicBaseUrl(req);
  const platformDefinition = getEmployeePackageDefinition(platform);
  const archive = archiver('zip', { zlib: { level: 9 } });

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Disposition', `attachment; filename="${platformDefinition.archiveName}"`);

  archive.on('error', (error) => {
    console.error('[-] Package build error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to build package zip.' });
    }
  });

  archive.pipe(res);
  addEmployeePackageFiles(archive, platformDefinition, origin);
  archive.finalize();
}

async function getUserDesignation(companyId, userId) {
  const latestWithDesignation = await Report.findOne({
    company_id: companyId,
    user_id: userId,
    designation: { $exists: true, $ne: '' }
  }).sort({ createdAt: -1 });

  if (latestWithDesignation && latestWithDesignation.designation) {
    return String(latestWithDesignation.designation).trim();
  }

  const config = readSetupConfig();
  if (config && config.company_id === companyId && config.user_id === userId && config.designation) {
    return String(config.designation).trim();
  }

  return '';
}

function parseReportMoment(report) {
  const rawValue = report?.eventAt || report?.timestamp || report?.createdAt;
  const moment = new Date(rawValue);
  return Number.isNaN(moment.getTime()) ? null : moment;
}

function formatSummaryTime(moment, timezoneOffsetMinutes = 0) {
  if (!moment) return '--';
  const shifted = new Date(moment.getTime() - (Number(timezoneOffsetMinutes) || 0) * 60000);
  return `${String(shifted.getUTCHours() % 12 || 12)}:${String(shifted.getUTCMinutes()).padStart(2, '0')} ${shifted.getUTCHours() >= 12 ? 'PM' : 'AM'}`;
}

function formatSummaryDuration(seconds) {
  const totalSeconds = Math.max(0, Math.round(Number(seconds || 0)));
  const minutes = Math.floor(totalSeconds / 60);
  const remainingSeconds = totalSeconds % 60;

  if (minutes <= 0) {
    return `${remainingSeconds || 1} sec`;
  }

  if (remainingSeconds === 0) {
    return `${minutes} min`;
  }

  return `${minutes} min ${remainingSeconds} sec`;
}

function buildDeterministicDailySummary({ companyId, userId, designation, reports, targetDate, timezoneOffsetMinutes = 0 }) {
  const sortedReports = [...reports]
    .map((report) => ({ report, moment: parseReportMoment(report) }))
    .filter((entry) => entry.moment)
    .sort((left, right) => left.moment - right.moment);

  const activeMinutes = sortedReports.reduce((sum, entry) => sum + Number(entry.report.time_active_sec || 0), 0) / 60;
  const idleMinutes = sortedReports.reduce((sum, entry) => sum + Number(entry.report.time_idle_sec || 0), 0) / 60;
  const totalKeys = sortedReports.reduce((sum, entry) => sum + Number(entry.report.keyboard_key_presses || 0), 0);
  const totalClicks = sortedReports.reduce((sum, entry) => sum + Number(entry.report.mouse_clicks || 0), 0);
  const focusRatio = Math.round((activeMinutes / Math.max(1, activeMinutes + idleMinutes)) * 100);

  const appTotals = new Map();
  sortedReports.forEach(({ report }) => {
    const appName = String(report.active_app || 'Unknown').trim() || 'Unknown';
    const seconds = Number(report.time_active_sec || 0);
    appTotals.set(appName, (appTotals.get(appName) || 0) + seconds);
  });

  const topAppEntry = Array.from(appTotals.entries())
    .sort((left, right) => right[1] - left[1])[0];

  const topApp = topAppEntry ? `${topAppEntry[0]} (${Math.round(topAppEntry[1] / 60)}m)` : 'N/A';
  const unknownReports = sortedReports.filter(({ report }) => {
    const app = String(report.active_app || '').trim().toLowerCase();
    return !app || app === 'unknown' || app === 'unknown application';
  }).length;

  const firstMoment = sortedReports[0]?.moment || null;
  const lastMoment = sortedReports[sortedReports.length - 1]?.moment || null;

  const sessionLines = sortedReports.slice(0, 4).map(({ report, moment }) => {
    const start = formatSummaryTime(moment, timezoneOffsetMinutes);
    const duration = formatSummaryDuration(report.time_active_sec);
    const endMoment = moment ? new Date(moment.getTime() + Math.max(0, Number(report.time_active_sec || 0)) * 1000) : null;
    const end = formatSummaryTime(endMoment, timezoneOffsetMinutes);
    const appName = String(report.active_app || 'Unknown').trim() || 'Unknown';
    const title = String(report.window_title || 'Untitled Window').trim() || 'Untitled Window';
    return `- ${start} - ${end}: ${appName} - ${title} (${duration})`;
  });

  const noMoreSessionsLine = sortedReports.length > 4 ? '' : '- No other significant sessions were recorded.';

  const opening = activeMinutes > 0
    ? `The user had ${activeMinutes.toFixed(1)} minutes of active time and ${idleMinutes.toFixed(1)} minutes idle across ${sortedReports.length} report(s) on ${targetDate}.`
    : `No active work time was recorded for ${targetDate}.`;

  const workSummary = unknownReports > 0
    ? `Most of the day was spent in unknown applications, and ${unknownReports} report(s) were not tied to a clear app name.`
    : `The main work was concentrated in ${topApp}.`;

  const roleContext = designation
    ? `As a ${designation}, the activity pattern suggests ${focusRatio >= 60 ? 'a steady work session' : 'low focus and fragmented execution'}.`
    : `The activity pattern suggests ${focusRatio >= 60 ? 'a steady work session' : 'low focus and fragmented execution'}.`;

  return [
    `[METRICS] focus_time_percent: ${focusRatio} productive_time_mins: ${Math.round(activeMinutes)} stuck_signals: ${unknownReports} repetitive_work_mins: 0 [END_METRICS]`,
    `# Daily Summary: User ${userId}${designation ? ` (${designation})` : ''}`,
    '',
    '### 💡 What Work Was Done',
    workSummary,
    opening,
    roleContext,
    '',
    '### 🕒 Session Analysis',
    ...(sessionLines.length ? sessionLines : ['- No report sessions were recorded.']),
    noMoreSessionsLine,
    '',
    '### 📊 Detailed Insights',
    `The work pattern is measured from ${sortedReports.length} report(s) for ${companyId} / ${userId}. The top application was ${topApp}, total input volume was ${totalKeys + totalClicks}, and the focus ratio was ${focusRatio}%.`,
    focusRatio >= 60
      ? 'The day appears reasonably productive and time-aligned with sustained active windows.'
      : 'The day shows weak concentration and a high likelihood of context switching or stalled activity.',
  ].filter(Boolean).join('\n');
}

// MongoDB Connection
if (HAS_MONGO) {
  mongoose.connect(MONGO_URI)
    .then(() => console.log('✅ Connected to MongoDB successfully'))
    .catch(err => console.error('❌ MongoDB connection error:', err));
}

// API Routes

// 1. Ingest new logs (Child nodes uploading to Company parent)
app.post('/api/reports', async (req, res) => {
  try {
    const reportData = req.body;

    // If monitor is still on placeholder IDs, remap to saved setup profile by install_id/device_id.
    if (shouldResolveIdentity(reportData.company_id, reportData.user_id)) {
      const profile = await resolveSetupProfile({
        installId: reportData.install_id,
        deviceId: reportData.device_id
      });

      if (profile) {
        reportData.company_id = normalizeIdentity(profile.company_id);
        reportData.user_id = normalizeIdentity(profile.user_id);
        reportData.org_name = normalizeIdentity(profile.org_name) || reportData.org_name;
        reportData.employee_id = normalizeIdentity(profile.employee_id) || reportData.employee_id;
        reportData.designation = normalizeIdentity(profile.designation) || reportData.designation;
        reportData.device_id = normalizeIdentity(profile.device_id) || reportData.device_id;
      }
    }
    
    // Automatically map older tester reports: if user_id is missing but employee_id exists, use it.
    if (!reportData.user_id && reportData.employee_id) {
      reportData.user_id = reportData.employee_id;
    }
    
    // Ensure vital hierarchy ids are present
    if (!reportData.company_id || !reportData.user_id) {
      return res.status(400).json({ error: "Missing company_id or user_id in payload" });
    }

    const newReport = new Report(reportData);
    await newReport.save();

    // Ensure user appears in admin tracker directory even before manual toggles.
    await TrackingStatus.findOneAndUpdate(
      { company_id: reportData.company_id, user_id: reportData.user_id },
      {
        $setOnInsert: {
          is_tracking_active: true,
          is_decommissioned: false,
          report_interval: 120,
          last_updated_by: 'report-ingest'
        }
      },
      { upsert: true, new: true }
    );
    
    console.log(`[+] Saved report -> Company: ${reportData.company_id} | User: ${reportData.user_id}`);
    res.status(201).json({ message: 'Report saved successfully', id: newReport._id });
  } catch (error) {
    console.error('[-] Error saving report:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.get('/api/setup/config', async (_req, res) => {
  try {
    if (!isLocalRequest(_req)) {
      return res.json({ exists: false });
    }

    if (!fs.existsSync(CONFIG_PATH)) {
      return res.json({ exists: false });
    }

    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    const config = JSON.parse(raw);
    res.json({ exists: true, config });
  } catch (error) {
    console.error('[-] Error reading setup config:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.get('/api/employee/package.zip', (req, res) => {
  streamEmployeePackage(req, res, 'windows');
});

app.get('/api/employee/windows.zip', (req, res) => {
  streamEmployeePackage(req, res, 'windows');
});

app.get('/api/employee/macos.zip', (req, res) => {
  streamEmployeePackage(req, res, 'macos');
});

app.get('/api/employee/linux.zip', (req, res) => {
  streamEmployeePackage(req, res, 'linux');
});

app.get('/api/employee/bootstrap.ps1', (req, res) => {
  const origin = getPublicBaseUrl(req);
  const script = `
$ErrorActionPreference = 'Stop'

$packageUrl = '${origin}/api/employee/package.zip'
$targetRoot = Join-Path $env:USERPROFILE 'Desktop'
$targetDir = Join-Path $targetRoot 'EmployeeMonitorPackage'
$zipPath = Join-Path $env:TEMP 'employee-monitor-package.zip'
$installId = [guid]::NewGuid().ToString('N')
$deviceId = $env:COMPUTERNAME

$env:INSTALL_ID = $installId
$env:DEVICE_ID = $deviceId
$env:SKIP_SETUP_OPEN = '1'

$setupUrl = '${origin}/setup.html?autoclose=1&runMonitor=1&device_id=' + [uri]::EscapeDataString($deviceId) + '&install_id=' + [uri]::EscapeDataString($installId)

Write-Host 'Downloading employee package...'
Invoke-WebRequest -Uri $packageUrl -OutFile $zipPath

if (Test-Path $targetDir) {
  Remove-Item -Recurse -Force $targetDir
}

Write-Host 'Extracting package...'
Expand-Archive -Path $zipPath -DestinationPath $targetDir -Force
cmd /c attrib +h +s "$targetDir" >nul 2>&1

$installer = Join-Path $targetDir 'install.bat'
if (-not (Test-Path $installer)) {
  throw 'install.bat not found in extracted package.'
}

Write-Host 'Running install.bat (pass 1)...'
Start-Process -FilePath $installer -WorkingDirectory $targetDir -Wait

Write-Host 'Running install.bat (pass 2)...'
Start-Process -FilePath $installer -WorkingDirectory $targetDir -Wait

Write-Host 'Opening employee setup page...'
Start-Process $setupUrl

Write-Host 'Setup page opened. After Save, the page will try to close and start monitor automatically.'
`;

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="employee-bootstrap.ps1"');
  res.send(script.trim());
});

app.post('/api/setup/launch-monitor', async (req, res) => {
  try {
    if (!isLocalRequest(req)) {
      return res.status(403).json({ error: 'Launch is only allowed from localhost.' });
    }

    if (!fs.existsSync(MONITOR_PATH)) {
      return res.status(404).json({ error: 'monitor.py not found.' });
    }

    const command = process.platform === 'win32' ? 'pythonw' : 'python3';
    const fallback = process.platform === 'win32' ? 'python' : 'python3';

    let child;
    try {
      child = spawn(command, [MONITOR_PATH], {
        cwd: ROOT_DIR,
        detached: true,
        stdio: 'ignore'
      });
    } catch (_error) {
      child = spawn(fallback, [MONITOR_PATH], {
        cwd: ROOT_DIR,
        detached: true,
        stdio: 'ignore'
      });
    }

    child.unref();

    res.json({ message: 'Monitor launch requested.' });
  } catch (error) {
    console.error('[-] Failed to launch monitor:', error);
    res.status(500).json({ error: 'Failed to launch monitor.' });
  }
});

app.get('/api/setup/auth/providers', (_req, res) => {
  res.json({
    googleEnabled: Boolean(GOOGLE_CLIENT_ID),
    googleClientId: GOOGLE_CLIENT_ID || null
  });
});

app.post('/api/setup/google/verify', async (req, res) => {
  try {
    const { idToken } = req.body;

    if (!GOOGLE_CLIENT_ID || !googleOAuthClient) {
      return res.status(400).json({ error: 'Google OAuth is not configured on the backend.' });
    }

    if (!idToken || typeof idToken !== 'string') {
      return res.status(400).json({ error: 'Missing Google ID token.' });
    }

    const ticket = await googleOAuthClient.verifyIdToken({
      idToken,
      audience: GOOGLE_CLIENT_ID
    });

    const payload = ticket.getPayload();
    if (!payload || !payload.email) {
      return res.status(400).json({ error: 'Google token did not include an email.' });
    }

    res.json({
      provider: 'google',
      email: String(payload.email).trim(),
      name: payload.name || '',
      picture: payload.picture || ''
    });
  } catch (error) {
    console.error('[-] Google token verification failed:', error?.message || error);
    res.status(401).json({ error: 'Google token verification failed.' });
  }
});

app.post('/api/setup/save', async (req, res) => {
  try {
    const { employee_id, company_id, org_name, user_id, device_id, login_email, designation, login_provider, backend_url, install_id } = req.body;

    if (!employee_id || !company_id || !org_name || !user_id || !login_email) {
      return res.status(400).json({ error: 'Missing required setup fields' });
    }

    const provider = login_provider === 'google' ? 'google' : 'email';
    const requestOrigin = getPublicBaseUrl(req);
    const incomingBackendUrl = String(backend_url || '').trim().replace(/\/$/, '');
    const isLocalCandidate = incomingBackendUrl.startsWith('http://localhost') || incomingBackendUrl.startsWith('http://127.0.0.1');
    const resolvedBackendUrl = (!incomingBackendUrl || isLocalCandidate)
      ? requestOrigin
      : incomingBackendUrl;

    const config = {
      employee_id: String(employee_id).trim(),
      company_id: String(company_id).trim(),
      org_name: String(org_name).trim(),
      user_id: String(user_id).trim(),
      login_email: String(login_email || '').trim(),
      designation: String(designation || '').trim(),
      login_provider: provider,
      backend_url: resolvedBackendUrl,
      device_id: String(device_id || '').trim()
    };

    const installId = String(install_id || '').trim();

    if (!config.device_id && !installId) {
      return res.status(400).json({ error: 'Missing device identity. Provide device_id or install_id.' });
    }

    if (!config.device_id) {
      config.device_id = `install:${installId}`;
    }

    if (isLocalRequest(req)) {
      ensureParentDir(CONFIG_PATH);
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
    }

    let trackerWarning = '';

    // Register the tracker row during setup so admin can see users immediately.
    // This should not block the local setup flow if Mongo is temporarily unavailable.
    try {
      await TrackingStatus.findOneAndUpdate(
        { company_id: config.company_id, user_id: config.user_id },
        {
          $setOnInsert: {
            is_tracking_active: true,
            is_decommissioned: false,
            report_interval: 120,
            last_updated_by: 'setup'
          }
        },
        { upsert: true, new: true }
      );
    } catch (trackerError) {
      trackerWarning = trackerError?.message || 'Tracker registration skipped.';
      console.warn('[-] Tracker registration skipped during setup save:', trackerWarning);
    }

    // Persist setup profile for remote monitor identity resolution.
    if (HAS_MONGO) {
      try {
        const selector = installId
          ? { install_id: installId }
          : { device_id: config.device_id };

        await SetupProfile.findOneAndUpdate(
          selector,
          {
            install_id: installId || undefined,
            device_id: config.device_id,
            employee_id: config.employee_id,
            company_id: config.company_id,
            org_name: config.org_name,
            user_id: config.user_id,
            login_email: config.login_email,
            designation: config.designation,
            login_provider: config.login_provider,
            backend_url: config.backend_url,
            last_seen_at: new Date()
          },
          { upsert: true, new: true, setDefaultsOnInsert: true }
        );
      } catch (profileError) {
        console.warn('[-] Setup profile persistence skipped:', profileError?.message || profileError);
      }
    }

    res.json({
      message: 'Setup saved successfully',
      config,
      install_id: installId || undefined,
      warning: trackerWarning || undefined
    });
  } catch (error) {
    console.error('[-] Error saving setup config:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.get('/api/setup/resolve', async (req, res) => {
  try {
    const installId = normalizeIdentity(req.query.install_id);
    const deviceId = normalizeIdentity(req.query.device_id);

    if (!installId && !deviceId) {
      return res.status(400).json({ error: 'Missing install_id or device_id' });
    }

    const profile = await resolveSetupProfile({ installId, deviceId });
    if (!profile) {
      return res.json({ exists: false });
    }

    return res.json({
      exists: true,
      config: {
        employee_id: normalizeIdentity(profile.employee_id),
        company_id: normalizeIdentity(profile.company_id),
        org_name: normalizeIdentity(profile.org_name),
        user_id: normalizeIdentity(profile.user_id),
        login_email: normalizeIdentity(profile.login_email),
        designation: normalizeIdentity(profile.designation),
        login_provider: normalizeIdentity(profile.login_provider) || 'email',
        backend_url: normalizeIdentity(profile.backend_url) || getPublicBaseUrl(req),
        device_id: normalizeIdentity(profile.device_id)
      }
    });
  } catch (error) {
    console.error('[-] Error resolving setup profile:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// 2. Fetch hierarchy data (Parent Company -> Child Users -> Reports)
app.get('/api/reports/hierarchy/:company_id', async (req, res) => {
  try {
    const companyId = req.params.company_id;
    
    // Aggregate data into Company -> Users tree
    const hierarchy = await Report.aggregate([
      { $match: { company_id: companyId } },
      { $sort: { timestamp: -1 } },
      { 
        $group: {
          _id: "$user_id",
          employee_id: { $first: "$employee_id" },
          org_name: { $first: "$org_name" },
          total_reports: { $sum: 1 },
          latest_activity: { $first: "$timestamp" },
          reports: { $push: "$$ROOT" }
        }
      },
      {
        $project: {
          _id: 0,
          user_id: "$_id",
          employee_id: 1,
          org_name: 1,
          total_reports: 1,
          latest_activity: 1,
          reports: 1
        }
      }
    ]);

    res.json({
      company_id: companyId,
      users: hierarchy
    });
  } catch (error) {
    console.error('[-] Error fetching hierarchy:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// 2b. Fetch all reports for a SPECIFIC employee (Supports ?date=YYYY-MM-DD)
app.get('/api/reports/employee/:company_id/:user_id', async (req, res) => {
  try {
    const { company_id, user_id } = req.params;
    const { date } = req.query; 

    const pipeline = [
      { $match: { company_id, user_id } },
      {
        $addFields: {
          eventAt: {
            $ifNull: [
              { $convert: { input: '$timestamp', to: 'date', onError: null, onNull: null } },
              '$createdAt'
            ]
          }
        }
      }
    ];

    if (date) {
      const day = buildDayBounds(date);
      pipeline.push({ $match: { eventAt: { $gte: day.start, $lte: day.end } } });
      console.log(`[Query] ${user_id} @ ${date} -> Range: ${day.start.toISOString()} to ${day.end.toISOString()}`);
    }

    pipeline.push({ $sort: { eventAt: -1, createdAt: -1 } });

    const reports = await Report.aggregate(pipeline);
    res.json(reports);
  } catch (error) {
    console.error('[-] Error fetching employee reports:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// 2c. Fetch reports for a date range (used for weekly heatmaps and app breakdowns)
app.get('/api/reports/employee/:company_id/:user_id/range', async (req, res) => {
  try {
    const { company_id, user_id } = req.params;
    const { start, end } = req.query;

    if (!start || !end) {
      return res.status(400).json({ error: 'Missing start or end date' });
    }

    const startDate = new Date(`${start}T00:00:00.000`);
    const endDate = new Date(`${end}T23:59:59.999`);

    const reports = await Report.aggregate([
      { $match: { company_id, user_id } },
      {
        $addFields: {
          eventAt: {
            $ifNull: [
              { $convert: { input: '$timestamp', to: 'date', onError: null, onNull: null } },
              '$createdAt'
            ]
          }
        }
      },
      { $match: { eventAt: { $gte: startDate, $lte: endDate } } },
      { $sort: { eventAt: 1, createdAt: 1 } }
    ]);

    res.json(reports);
  } catch (error) {
    console.error('[-] Error fetching ranged employee reports:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// 2d. Fetch report stats for a specific employee (all-time count + latest event)
app.get('/api/reports/employee/:company_id/:user_id/stats', async (req, res) => {
  try {
    const { company_id, user_id } = req.params;

    const result = await Report.aggregate([
      { $match: { company_id, user_id } },
      {
        $addFields: {
          eventAt: {
            $ifNull: [
              { $convert: { input: '$timestamp', to: 'date', onError: null, onNull: null } },
              '$createdAt'
            ]
          }
        }
      },
      {
        $group: {
          _id: null,
          total_reports: { $sum: 1 },
          latest_event_at: { $max: '$eventAt' }
        }
      }
    ]);

    const stats = result[0] || { total_reports: 0, latest_event_at: null };
    res.json({
      company_id,
      user_id,
      total_reports: stats.total_reports || 0,
      latest_event_at: stats.latest_event_at || null
    });
  } catch (error) {
    console.error('[-] Error fetching employee report stats:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// 3. Check if tracking is authorized for a specific user
app.get('/api/tracking-status', async (req, res) => {
  try {
    let { company_id, user_id, device_id, install_id } = req.query;

    if (shouldResolveIdentity(company_id, user_id)) {
      const profile = await resolveSetupProfile({ installId: install_id, deviceId: device_id });
      if (profile) {
        company_id = normalizeIdentity(profile.company_id);
        user_id = normalizeIdentity(profile.user_id);
      }
    }

    if (!company_id || !user_id) {
      return res.status(400).json({ error: "Missing company_id or user_id (or unresolved device_id/install_id)" });
    }

    // Upsert the status so new users default to true (active)
    const status = await TrackingStatus.findOneAndUpdate(
      { company_id, user_id },
      {
        $setOnInsert: {
          company_id,
          user_id,
          is_tracking_active: true,
          is_decommissioned: false,
          report_interval: 120,
          last_updated_by: 'tracker-poll'
        },
        $set: {
          last_seen_at: new Date()
        }
      },
      { new: true, upsert: true }
    );

    res.json({
      is_tracking_active: status.is_tracking_active,
      is_decommissioned: status.is_decommissioned || false,
      report_interval: status.report_interval || 120,
      company_id: status.company_id,
      user_id: status.user_id
    });
  } catch (error) {
    console.error('[-] Error checking tracking status:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// 4. Admin Endpoint to Toggle Tracking ON/OFF
app.post('/api/admin/toggle-tracking', async (req, res) => {
  try {
    const { company_id, user_id, is_active } = req.body;
    if (!company_id || !user_id || typeof is_active !== 'boolean') {
      return res.status(400).json({ error: "Invalid payload. Require company_id, user_id, and is_active (boolean)" });
    }

    const updated = await TrackingStatus.findOneAndUpdate(
      { company_id, user_id },
      { is_tracking_active: is_active },
      { new: true, upsert: true }
    );

    console.log(`[Admin] Tracking for ${user_id} @ ${company_id} set to: ${is_active}`);
    res.json({ message: "Status updated successfully", current_status: updated });
  } catch (error) {
    console.error('[-] Error updating tracking status:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// 5. Admin Endpoint to Fetch All Registered Trackers
app.get('/api/admin/trackers', async (req, res) => {
  try {
    // Show trackers from status collection and also fallback users discovered from reports.
    const trackers = await withTimeout(
      TrackingStatus.find({}, 'company_id user_id is_tracking_active is_decommissioned report_interval updatedAt')
        .sort({ company_id: 1, user_id: 1 })
        .lean(),
      8000,
      'TrackingStatus query'
    );

    const merged = new Map();
    trackers.forEach((tracker) => {
      const key = `${tracker.company_id}::${tracker.user_id}`;
      merged.set(key, {
        ...tracker,
        designation: ''
      });
    });

    const reportUsers = await withTimeout(
      Report.aggregate([
        { $match: { company_id: { $exists: true, $ne: '' }, user_id: { $exists: true, $ne: '' } } },
        { $sort: { createdAt: -1 } },
        {
          $group: {
            _id: { company_id: '$company_id', user_id: '$user_id' },
            latestDesignation: { $first: '$designation' }
          }
        }
      ]),
      8000,
      'Report aggregate query'
    );

    reportUsers.forEach((entry) => {
      const companyId = String(entry?._id?.company_id || '').trim();
      const userId = String(entry?._id?.user_id || '').trim();
      if (!companyId || !userId) return;

      const key = `${companyId}::${userId}`;
      if (!merged.has(key)) {
        merged.set(key, {
          _id: key,
          company_id: companyId,
          user_id: userId,
          is_tracking_active: true,
          is_decommissioned: false,
          report_interval: 120,
          updatedAt: null,
          designation: String(entry?.latestDesignation || '').trim()
        });
      } else if (!merged.get(key).designation && entry?.latestDesignation) {
        merged.get(key).designation = String(entry.latestDesignation).trim();
      }
    });

    const trackersWithDesignation = Array.from(merged.values());

    trackersWithDesignation.sort((a, b) => {
      if (a.company_id === b.company_id) {
        return String(a.user_id).localeCompare(String(b.user_id));
      }
      return String(a.company_id).localeCompare(String(b.company_id));
    });

    res.json(trackersWithDesignation);
  } catch (error) {
    console.error('[-] Error fetching trackers list:', error);
    // Keep admin page usable even if DB temporarily fails.
    res.json([]);
  }
});

// 6. Admin Endpoint to Permanently Decommission a Tracker (Remote Uninstall)
app.post('/api/admin/decommission', async (req, res) => {
  try {
    const { company_id, user_id } = req.body;
    if (!company_id || !user_id) {
      return res.status(400).json({ error: "Missing company_id or user_id" });
    }

    const purgeCounts = await purgeTrackerArtifacts(company_id, user_id, { removeTrackingStatus: false });
    const updated = await TrackingStatus.findOneAndUpdate(
      { company_id, user_id },
      {
        is_decommissioned: true,
        is_tracking_active: false,
        decommission_requested_at: new Date(),
        last_updated_by: 'admin-decommission'
      },
      { new: true, upsert: true }
    );

    const lastSeenAt = updated?.last_seen_at ? new Date(updated.last_seen_at) : null;
    const staleCutoffMs = 5 * 60 * 1000;
    const offlineWarning = !lastSeenAt || (Date.now() - lastSeenAt.getTime()) > staleCutoffMs
      ? 'Device has not checked in recently. Uninstall will complete when that PC is online and monitor is running.'
      : '';

    console.log(`[Admin] DECOMMISSIONED tracker for ${user_id} @ ${company_id}`);
    res.json({
      message: "Tracker data purged from the cloud and marked for local self-delete.",
      offlineWarning: offlineWarning || undefined,
      status: updated,
      purgeCounts
    });
  } catch (error) {
    console.error('[-] Error decommissioning:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// 6b. Hard delete a tracker and all cloud data immediately.
app.post('/api/admin/purge-user', async (req, res) => {
  try {
    const { company_id, user_id } = req.body;
    if (!company_id || !user_id) {
      return res.status(400).json({ error: 'Missing company_id or user_id' });
    }

    const purgeCounts = await purgeTrackerArtifacts(company_id, user_id, { removeTrackingStatus: false });
    const status = await TrackingStatus.findOneAndUpdate(
      { company_id, user_id },
      {
        is_decommissioned: true,
        is_tracking_active: false,
        decommission_requested_at: new Date(),
        last_updated_by: 'admin-purge-user'
      },
      { new: true, upsert: true }
    );
    console.log(`[Admin] PURGED tracker data for ${user_id} @ ${company_id}`);
    res.json({
      message: 'User data deleted from the cloud and queued for local uninstall.',
      purgeCounts,
      status
    });
  } catch (error) {
    console.error('[-] Error purging tracker:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// 7. Tracker Callback to Confirm Self-Deletion and Wipe All Cloud Data
app.post('/api/tracker/confirm-deletion', async (req, res) => {
  try {
    const { company_id, user_id } = req.body;
    
    // 1. Delete associated reports
    const reportDel = await Report.deleteMany({ company_id, user_id });
    
    // 2. Delete the tracking status entry
    const statusDel = await TrackingStatus.deleteOne({ company_id, user_id });
    
    console.log(`[CLEANUP] Permanently wiped all data for ${user_id} @ ${company_id}. Reports: ${reportDel.deletedCount}`);
    res.json({ message: "Cloud data wiped successfully." });
  } catch (error) {
    console.error('[-] Error during permanent cleanup:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// 8. Admin Endpoint to Update Reporting Interval
app.post('/api/admin/update-interval', async (req, res) => {
  try {
    const { company_id, user_id, interval } = req.body;
    if (!company_id || !user_id || !interval) {
      return res.status(400).json({ error: "Missing required fields" });
    }
    
    const updated = await TrackingStatus.findOneAndUpdate(
      { company_id, user_id },
      { report_interval: parseInt(interval) },
      { new: true, upsert: true }
    );
    
    console.log(`[Admin] UPDATED interval for ${user_id} to ${interval}s`);
    res.json({ message: "Interval updated.", interval: updated.report_interval });
  } catch (error) {
    console.error('[-] Error updating interval:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// 9. Admin Performance Chatbot (NVIDIA RAG)
app.post('/api/admin/chat', async (req, res) => {
  try {
    const { message, company_id, user_id } = req.body;
    const NV_KEY = process.env.LLM_API_KEY || process.env.NVIDIA_API_KEY;

    if (!NV_KEY || NV_KEY.includes('YOUR-KEY-HERE')) {
      return res.status(400).json({ error: "NVIDIA API Key not configured in .env" });
    }

    // 1. Fetch performance context
    let context = "";
    if (user_id && company_id) {
      const designation = await getUserDesignation(company_id, user_id);
      // User-specific aggregation (Lifetime)
      const stats = await Report.aggregate([
        { $match: { company_id, user_id } },
        { $group: {
            _id: null,
            total_active: { $sum: "$time_active_sec" },
            total_idle: { $sum: "$time_idle_sec" },
            total_keys: { $sum: "$keyboard_key_presses" },
            total_clicks: { $sum: "$mouse_clicks" },
            top_apps: { $push: "$active_app" }
        }}
      ]);

      const lifetime = stats[0] || {};
      const logs = await Report.find({ company_id, user_id }).sort({ timestamp: -1 }).limit(20);
      const appCounts = (lifetime.top_apps || []).reduce((acc, a) => { acc[a] = (acc[a] || 0) + 1; return acc; }, {});
      const top3Apps = Object.entries(appCounts).sort((a,b) => b[1] - a[1]).slice(0,3).map(x => x[0]).join(', ');

      context = `FOCUS USER: ${user_id} (@ ${company_id})
      DESIGNATION: ${designation || 'Not specified'}
      LIFETIME SUMMARY:
      - Active: ${Math.round((lifetime.total_active || 0)/60)}m, Idle: ${Math.round((lifetime.total_idle || 0)/60)}m
      - Total Inputs: ${lifetime.total_keys || 0} keys, ${lifetime.total_clicks || 0} clicks
      - Top Apps: ${top3Apps || "N/A"}
      
      RECENT ACTIVITY SAMPLE:
      ${logs.map(l => `- ${l.timestamp}: ${l.active_app} (${l.window_title})`).join('\n')}`;
    } else {
      // Global Company Aggregation
      const stats = await Report.aggregate([
        { $group: {
            _id: "$user_id",
            total_reports: { $sum: 1 },
            active: { $sum: "$time_active_sec" }
        }},
        { $sort: { active: -1 } },
        { $limit: 10 }
      ]);

      context = `GLOBAL COMPANY ANALYSIS (All Users):
      Current Top Contributors (by active time):
      ${stats.map(s => `- User ${s._id}: ${s.total_reports} reports, ${Math.round(s.active/60)}m active`).join('\n')}`;
    }

    // 2. Query NVIDIA LLM
    const body = {
      model: "meta/llama-3.1-70b-instruct",
      messages: [
        { 
          role: "system", 
          content: `You are the Lead Performance Analyst. 
          Use the provided context to answer questions. 
          - If the context is GLOBAL, analyze company-wide patterns.
          - If the context is for a FOCUS USER, be specific about their strengths/weaknesses and compare them to the user's designation.
          Always use Markdown headers, bolding, and lists for a professional look.
          
          CONTEXT DATA:
          ${context}`
        },
        { role: "user", content: message }
      ],
      temperature: 0.5,
      max_tokens: 1024
    };

    const response = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${NV_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    const data = await response.json();
    res.json({ answer: data.choices[0].message.content });

  } catch (err) {
    console.error("Chat error:", err);
    res.status(500).json({ error: "Failed to generate AI response." });
  }
});

// --- Automatic Work Summaries Endpoint ---
app.get('/api/admin/summary/:compId/:userId', async (req, res) => {
  try {
    const { compId, userId } = req.params;
    const { date, regen } = req.query;
    const forceRegen = regen === 'true';
    const timezoneOffsetMinutes = Number(req.query.tz_offset ?? req.query.timezoneOffset ?? 0);
    
    // Default to today if no date provided
    const targetDate = date || getLocalDateString();
    const designation = await getUserDesignation(compId, userId);

    const day = buildDayBounds(targetDate);

    // Check the latest activity for this exact day to avoid serving stale cached summaries.
    const latestDayLog = await Report.aggregate([
      { $match: { company_id: compId, user_id: userId } },
      {
        $addFields: {
          eventAt: {
            $ifNull: [
              { $convert: { input: '$timestamp', to: 'date', onError: null, onNull: null } },
              '$createdAt'
            ]
          }
        }
      },
      { $match: { eventAt: { $gte: day.start, $lte: day.end } } },
      { $sort: { eventAt: -1, createdAt: -1 } },
      { $limit: 1 },
      { $project: { _id: 0, eventAt: 1, createdAt: 1 } }
    ]);

    const latestDayEventAt = latestDayLog[0]?.eventAt || latestDayLog[0]?.createdAt || null;

    // 1. Check cache first
    const cached = await Summary.findOne({ company_id: compId, user_id: userId, date: targetDate });
    if (cached && !forceRegen) {
      const cachedUpdatedAt = new Date(cached?.metadata?.last_updated || cached.updatedAt || 0);
      const latestLogAt = latestDayEventAt ? new Date(latestDayEventAt) : null;
      const isFresh = !latestLogAt || cachedUpdatedAt >= latestLogAt;

      if (isFresh) {
        return res.json({ summary: cached.content, cached: true });
      }
    }

    // 2. Fetch all reports for the target day
    const logs = await Report.aggregate([
      { $match: { company_id: compId, user_id: userId } },
      {
        $addFields: {
          eventAt: {
            $ifNull: [
              { $convert: { input: '$timestamp', to: 'date', onError: null, onNull: null } },
              '$createdAt'
            ]
          }
        }
      },
      { $match: { eventAt: { $gte: day.start, $lte: day.end } } },
      { $sort: { eventAt: 1, createdAt: 1 } }
    ]);

    if (logs.length === 0) {
      return res.json({ summary: `No activity logs found for ${targetDate}.`, cached: false });
    }

    const summaryContent = buildDeterministicDailySummary({
      companyId: compId,
      userId,
      designation,
      reports: logs,
      targetDate,
      timezoneOffsetMinutes
    });

    const charactersAnalyzed = logs.reduce((acc, l) => acc + (l.ocr_text || "").length, 0);

    // 4. Update Cache
    await Summary.findOneAndUpdate(
      { company_id: compId, user_id: userId, date: targetDate },
      { content: summaryContent, metadata: { characters_processed: charactersAnalyzed, last_updated: new Date(), generated_by: 'deterministic-summary' } },
      { upsert: true, new: true }
    );

    res.json({ summary: summaryContent, cached: false, analyzed: charactersAnalyzed });

  } catch (err) {
    console.error("Summary error:", err);
    res.status(500).json({ error: "Failed to generate summary." });
  }
});

// Start Server
app.listen(PORT, () => {
  console.log(`\n================================`);
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`   Database URL: ${MONGO_URI}`);
  console.log(`================================\n`);
});
