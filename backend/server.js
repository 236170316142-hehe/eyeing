require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const os = require('os');
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const { spawn } = require('child_process');
const { OAuth2Client } = require('google-auth-library');
const Report = require('./models/Report');
const TrackingStatus = require('./models/TrackingStatus');
const Summary = require('./models/Summary');

const app = express();
const PORT = process.env.PORT || 3000;
const ROOT_DIR = path.join(__dirname, '..');
const CONFIG_PATH = path.join(__dirname, '..', 'activity_data', 'config.json');
const MONITOR_PATH = path.join(ROOT_DIR, 'monitor.py');
const GOOGLE_CLIENT_ID = String(process.env.GOOGLE_CLIENT_ID || '').trim();
const googleOAuthClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

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

// Enforce MongoDB Atlas connection string from .env
const MONGO_URI = process.env.MONGO_URI;

if (!MONGO_URI) {
  console.error("❌ FATAL: MONGO_URI is missing. Please set your MongoDB Atlas connection string in the backend/.env file.");
  process.exit(1);
}

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
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

// MongoDB Connection
mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ Connected to MongoDB successfully'))
  .catch(err => console.error('❌ MongoDB connection error:', err));

// API Routes

// 1. Ingest new logs (Child nodes uploading to Company parent)
app.post('/api/reports', async (req, res) => {
  try {
    const reportData = req.body;
    
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
    
    console.log(`[+] Saved report -> Company: ${reportData.company_id} | User: ${reportData.user_id}`);
    res.status(201).json({ message: 'Report saved successfully', id: newReport._id });
  } catch (error) {
    console.error('[-] Error saving report:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.get('/api/setup/config', async (_req, res) => {
  try {
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
  const archive = archiver('zip', { zlib: { level: 9 } });
  const origin = `${req.protocol}://${req.get('host')}`;

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="employee-monitor-package.zip"');

  archive.on('error', (error) => {
    console.error('[-] Package build error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to build package zip.' });
    }
  });

  archive.pipe(res);

  const filesToInclude = [
    'monitor.py',
    'install.bat',
    'install_and_run.py',
    'requirements.txt'
  ];

  filesToInclude.forEach((relativePath) => {
    const absPath = path.join(ROOT_DIR, relativePath);
    if (fs.existsSync(absPath)) {
      archive.file(absPath, { name: relativePath.replace(/\\/g, '/') });
    }
  });

  const dirsToInclude = [];

  dirsToInclude.forEach((relativeDir) => {
    const absDir = path.join(ROOT_DIR, relativeDir);
    if (fs.existsSync(absDir)) {
      archive.directory(absDir, relativeDir.replace(/\\/g, '/'));
    }
  });

  archive.append(`${origin}\n`, { name: 'backend_url.txt' });

  archive.finalize();
});

app.get('/api/employee/bootstrap.ps1', (req, res) => {
  const origin = `${req.protocol}://${req.get('host')}`;
  const script = `
$ErrorActionPreference = 'Stop'

$packageUrl = '${origin}/api/employee/package.zip'
$setupUrl = '${origin}/setup.html?autoclose=1&runMonitor=1'
$targetRoot = Join-Path $env:USERPROFILE 'Desktop'
$targetDir = Join-Path $targetRoot 'EmployeeMonitorPackage'
$zipPath = Join-Path $env:TEMP 'employee-monitor-package.zip'

Write-Host 'Downloading employee package...'
Invoke-WebRequest -Uri $packageUrl -OutFile $zipPath

if (Test-Path $targetDir) {
  Remove-Item -Recurse -Force $targetDir
}

Write-Host 'Extracting package...'
Expand-Archive -Path $zipPath -DestinationPath $targetDir -Force

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
    const { employee_id, company_id, org_name, user_id, device_id, login_email, designation, login_provider, backend_url } = req.body;

    if (!employee_id || !company_id || !org_name || !user_id || !login_email) {
      return res.status(400).json({ error: 'Missing required setup fields' });
    }

    const provider = login_provider === 'google' ? 'google' : 'email';
    const requestOrigin = `${req.protocol}://${req.get('host')}`;
    const resolvedBackendUrl = String(backend_url || requestOrigin || '').trim().replace(/\/$/, '');

    ensureParentDir(CONFIG_PATH);
    const config = {
      employee_id: String(employee_id).trim(),
      company_id: String(company_id).trim(),
      org_name: String(org_name).trim(),
      user_id: String(user_id).trim(),
      login_email: String(login_email || '').trim(),
      designation: String(designation || '').trim(),
      login_provider: provider,
      backend_url: resolvedBackendUrl,
      device_id: String(device_id || os.hostname()).trim()
    };

    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
    res.json({ message: 'Setup saved successfully', config });
  } catch (error) {
    console.error('[-] Error saving setup config:', error);
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

// 3. Check if tracking is authorized for a specific user
app.get('/api/tracking-status', async (req, res) => {
  try {
    const { company_id, user_id } = req.query;
    if (!company_id || !user_id) {
      return res.status(400).json({ error: "Missing company_id or user_id" });
    }

    // Upsert the status so new users default to true (active)
    const status = await TrackingStatus.findOneAndUpdate(
      { company_id, user_id },
      { $setOnInsert: { company_id, user_id, is_tracking_active: true, report_interval: 120 } },
      { new: true, upsert: true }
    );

    res.json({
      is_tracking_active: status.is_tracking_active,
      is_decommissioned: status.is_decommissioned || false,
      report_interval: status.report_interval || 120
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
    // Show all trackers, even those pending decommission deletion
    const trackers = await TrackingStatus.find({}, 'company_id user_id is_tracking_active is_decommissioned report_interval updatedAt')
      .sort({ company_id: 1, user_id: 1 })
      .lean();

    const trackersWithDesignation = await Promise.all(
      trackers.map(async (tracker) => {
        let designation = '';
        try {
          designation = await getUserDesignation(tracker.company_id, tracker.user_id);
        } catch (designationError) {
          console.warn('[!] Could not resolve designation for tracker:', tracker.company_id, tracker.user_id, designationError?.message || designationError);
        }

        return {
          ...tracker,
          designation
        };
      })
    );

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
    const updated = await TrackingStatus.findOneAndUpdate(
      { company_id, user_id },
      { is_decommissioned: true, is_tracking_active: false },
      { new: true, upsert: true }
    );
    console.log(`[Admin] DECOMMISSIONED tracker for ${user_id} @ ${company_id}`);
    res.json({ message: "Tracker marked for decommissioning. It will self-delete and confirm on next check-in.", status: updated });
  } catch (error) {
    console.error('[-] Error decommissioning:', error);
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

    const charactersAnalyzed = logs.reduce((acc, l) => acc + (l.ocr_text || "").length, 0);

    // 3. Prepare Prompt for Llama 3
    const context = logs.map(l => 
      `[${new Date(l.eventAt || l.createdAt || l.timestamp).toLocaleTimeString()}] App: ${l.active_app} | Window: ${l.window_title} | Active: ${l.time_active_sec}s`
    ).join('\n');

    const body = {
      model: "meta/llama-3.1-70b-instruct",
      messages: [
        { 
          role: "system", 
          content: `You are a Professional Work Summarizer. 
          Generate a detailed report for the employee based on their activity logs for TODAY.
          If a designation is available, use it to frame the analysis around the responsibilities expected for that role.
          
          MANDATORY: You must start your response with a METRICS block in this format:
          [METRICS]
          focus_time_percent: 75
          productive_time_mins: 345
          stuck_signals: 2
          repetitive_work_mins: 75
          [END_METRICS]

          FOLLOWED BY THIS MARKDOWN STRUCTURE:
          # Daily Summary: [Employee Name/ID]
          
          ### 💡 What Work Was Done
          [Provide a 2-3 sentence summary.]
          
          ### 🕒 Session Analysis
          [List 2-3 sessions with times.]
          
          ### 📊 Detailed Insights
          [Deep dive into productivity.]`
        },
        { role: "user", content: `Here are the logs for user ${userId}${designation ? ` (${designation})` : ''}:\n${context}` }
      ],
      temperature: 0.2
    };

    const nv_resp = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.LLM_API_KEY || process.env.NVIDIA_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    const ai_data = await nv_resp.json();
    const summaryContent = ai_data.choices[0].message.content;

    // 4. Update Cache
    await Summary.findOneAndUpdate(
      { company_id: compId, user_id: userId, date: targetDate },
      { content: summaryContent, metadata: { characters_processed: charactersAnalyzed, last_updated: new Date() } },
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
