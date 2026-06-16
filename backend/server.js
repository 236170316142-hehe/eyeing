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

function buildDayBounds(date, timezoneOffsetMinutes = 0) {
  const [y, m, d] = date.split('-').map(Number);
  const offsetMs = Number(timezoneOffsetMinutes) * 60000;
  const start = new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0) + offsetMs);
  const end = new Date(Date.UTC(y, m - 1, d, 23, 59, 59, 999) + offsetMs);

  return {
    start,
    end
  };
}

function getLocalDateString(date = new Date()) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function shiftDateString(dateString, deltaDays) {
  const [year, month, day] = String(dateString || '').split('-').map(Number);
  if (!year || !month || !day) return getLocalDateString();

  const shifted = new Date(Date.UTC(year, month - 1, day));
  shifted.setUTCDate(shifted.getUTCDate() + Number(deltaDays || 0));
  return shifted.toISOString().slice(0, 10);
}

function isGreetingOnlyMessage(message) {
  const normalized = String(message || '').toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!normalized) return false;

  return /^(hi|hello|hey|heya|hiya|helo|hii|heyy|yo|sup|howdy|greetings|good morning|good afternoon|good evening|what['']?s up|wassup|whats up)( there)?$/.test(normalized);
}

function resolveChatTargetDate(message, requestedDate) {
  const explicitDate = normalizeIdentity(requestedDate);
  if (explicitDate) return explicitDate;

  const normalized = String(message || '').toLowerCase();
  const today = getLocalDateString();

  if (/\bday before yesterday\b/.test(normalized)) return shiftDateString(today, -2);
  if (/\byesterday\b/.test(normalized)) return shiftDateString(today, -1);
  if (/\btoday\b/.test(normalized)) return today;

  return null;
}

function normalizeIdentity(value) {
  return String(value || '').trim();
}

function buildReportSignature(report) {
  const companyId = normalizeIdentity(report?.company_id);
  const userId = normalizeIdentity(report?.user_id);
  const deviceId = normalizeIdentity(report?.device_id);
  const timestamp = normalizeIdentity(report?.timestamp);
  const app = normalizeIdentity(report?.active_app);
  const title = normalizeIdentity(report?.window_title);
  const activeSec = Number(report?.time_active_sec || 0).toFixed(2);
  const idleSec = Number(report?.time_idle_sec || 0).toFixed(2);
  const keyPresses = Number(report?.keyboard_key_presses || 0);
  const clicks = Number(report?.mouse_clicks || 0);

  return [companyId, userId, deviceId, timestamp, app, title, activeSec, idleSec, keyPresses, clicks].join('::');
}

function dedupeReportsBySignature(reports = []) {
  const seen = new Set();
  const unique = [];

  for (const report of reports) {
    const signature = buildReportSignature(report);
    if (seen.has(signature)) continue;
    seen.add(signature);
    unique.push(report);
  }

  return unique;
}

function parseReportDate(report) {
  const rawValue = report?.eventAt || report?.timestamp || report?.createdAt;
  const moment = new Date(rawValue);
  return Number.isNaN(moment.getTime()) ? null : moment;
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

// Serve OS-specific download ZIPs from backend/downloads/
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
app.use('/downloads', express.static(DOWNLOADS_DIR, { dotfiles: 'deny' }));

app.get('/', (_req, res) => {
  res.status(200).json({
    status: 'success',
    message: 'Employee Activity Monitor API is running',
    health: '/healthz',
    admin: '/admin.html'
  });
});

app.get('/healthz', (_req, res) => {
  res.status(200).json({ ok: true });
});

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
    includeUnixLauncher: false,
    includeWindowsAutomation: true,
    includeEnterpriseTools: false
  },
  macos: {
    label: 'macOS',
    archiveName: 'employee-monitor-macos.zip',
    includeBatchLauncher: false,
    includeUnixLauncher: true,
    includeMacCommandLauncher: true,
    includeWindowsAutomation: false,
    includeEnterpriseTools: false
  },
  linux: {
    label: 'Linux',
    archiveName: 'employee-monitor-linux.zip',
    includeBatchLauncher: false,
    includeUnixLauncher: true,
    includeMacCommandLauncher: false,
    includeWindowsAutomation: false,
    includeEnterpriseTools: false
  },
  enterprise: {
    label: 'Enterprise Multi-OS',
    archiveName: 'employee-monitor-enterprise.zip',
    includeBatchLauncher: true,
    includeUnixLauncher: true,
    includeMacCommandLauncher: true,
    includeWindowsAutomation: true,
    includeEnterpriseTools: true
  },
  update: {
    label: 'Update',
    archiveName: 'employee-monitor-update.zip',
    includeBatchLauncher: false,
    includeUnixLauncher: false,
    includeMacCommandLauncher: false,
    includeWindowsAutomation: false,
    includeEnterpriseTools: false,
    updateOnly: true
  }
};

function normalizeEmployeePackagePlatform(value) {
  const normalized = String(value || '').trim().toLowerCase();

  if (['win', 'windows', 'win32'].includes(normalized)) return 'windows';
  if (['mac', 'macos', 'darwin', 'osx'].includes(normalized)) return 'macos';
  if (['linux', 'ubuntu', 'debian'].includes(normalized)) return 'linux';
  if (['enterprise', 'multi-os', 'multios', 'multi_pc', 'multipc'].includes(normalized)) return 'enterprise';
  if (['update', 'patch'].includes(normalized)) return 'update';

  if (EMPLOYEE_PACKAGE_DEFINITIONS[normalized]) return normalized;

  return 'windows';
}

function getEmployeePackageDefinition(platform) {
  return EMPLOYEE_PACKAGE_DEFINITIONS[normalizeEmployeePackagePlatform(platform)];
}

function getBundledTesseractDir(platformKey) {
  const normalizedPlatform = normalizeEmployeePackagePlatform(platformKey);

  const platformsToTry = normalizedPlatform === 'enterprise'
    ? ['windows', 'macos', 'linux']
    : [normalizedPlatform];

  for (const platform of platformsToTry) {
    const envKey = `TESSERACT_BUNDLE_${platform.toUpperCase()}`;
    const candidates = [
      process.env[envKey],
      path.join(ROOT_DIR, 'bundled', 'tesseract', platform),
      path.join(ROOT_DIR, 'third_party', 'tesseract', platform),
    ].filter(Boolean);

    for (const candidate of candidates) {
      const normalized = path.resolve(candidate);
      const expectedBinary =
        platform === 'windows'
          ? path.join(normalized, 'tesseract.exe')
          : path.join(normalized, 'bin', 'tesseract');

      if (fs.existsSync(expectedBinary)) {
        return normalized;
      }
    }
  }

  return null;
}

function addDirectoryRecursive(archive, sourceDir, targetPrefix) {
  if (!fs.existsSync(sourceDir)) return;

  const entries = fs.readdirSync(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.posix.join(targetPrefix, entry.name);
    if (entry.isDirectory()) {
      addDirectoryRecursive(archive, sourcePath, targetPath);
    } else if (entry.isFile()) {
      archive.file(sourcePath, { name: targetPath });
    }
  }
}

function buildUnixLauncherScript() {
  return `#!/usr/bin/env bash
# Employee Monitor — Linux silent installer
# Run once: bash install.sh   (everything else happens automatically)

SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ── Resolve backend URL ──────────────────────────────────────────────────
BACKEND_URL="https://eyeing.onrender.com"
if [ -f "$SCRIPT_DIR/backend_url.txt" ]; then
  BACKEND_URL=$(tr -d '[:space:]' < "$SCRIPT_DIR/backend_url.txt")
fi
DEVICE_ID=$(hostname -s 2>/dev/null || echo "linux-device")
INSTALL_ID="lin-$(cat /proc/sys/kernel/random/uuid 2>/dev/null | tr -d '-' | head -c 12 || date +%s)"
LOG="$SCRIPT_DIR/setup_log.txt"

# ── Open setup page in browser immediately ───────────────────────────────
SETUP_URL="$BACKEND_URL/setup.html?autoclose=1&device_id=$DEVICE_ID&install_id=$INSTALL_ID"
xdg-open "$SETUP_URL" 2>/dev/null || \
  python3 -m webbrowser "$SETUP_URL" 2>/dev/null || \
  python  -m webbrowser "$SETUP_URL" 2>/dev/null || true

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Employee Monitor Linux setup started" > "$LOG"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Backend: $BACKEND_URL" >> "$LOG"
echo "" >> "$LOG"

# ── Run the full installation in the background ──────────────────────────
(

  # ── Step 1: Python ──────────────────────────────────────────────────────
  PYTHON_BIN=""
  for cmd in python3 python3.12 python3.11 python3.10 python3.9 python; do
    command -v "$cmd" >/dev/null 2>&1 && PYTHON_BIN=$(command -v "$cmd") && break
  done
  if [ -z "$PYTHON_BIN" ]; then
    echo "[*] Python not found — installing..." >> "$LOG"
    { command -v apt-get && sudo apt-get install -y -qq python3 python3-pip python3-venv; } >> "$LOG" 2>&1 || \
    { command -v dnf  && sudo dnf install -y -q python3 python3-pip; }  >> "$LOG" 2>&1 || \
    { command -v yum  && sudo yum install -y -q python3 python3-pip; }  >> "$LOG" 2>&1 || \
    { command -v pacman && sudo pacman -Sy --noconfirm python python-pip; } >> "$LOG" 2>&1 || \
    { command -v zypper && sudo zypper --non-interactive install python3 python3-pip; } >> "$LOG" 2>&1 || \
    { command -v apk  && sudo apk add python3 py3-pip; } >> "$LOG" 2>&1 || true
    for cmd in python3 python; do
      command -v "$cmd" >/dev/null 2>&1 && PYTHON_BIN=$(command -v "$cmd") && break
    done
  fi
  if [ -z "$PYTHON_BIN" ]; then
    echo "[ERROR] Python could not be installed. Install python3 manually then re-run." >> "$LOG"
    exit 1
  fi
  echo "[OK] Python: $($PYTHON_BIN --version 2>&1)" >> "$LOG"

  # ── Step 2: Virtual env ──────────────────────────────────────────────────
  VENV_PY="$SCRIPT_DIR/.venv/bin/python"
  if [ ! -x "$VENV_PY" ]; then
    "$PYTHON_BIN" -m venv "$SCRIPT_DIR/.venv" >> "$LOG" 2>&1 || true
  fi
  [ -x "$VENV_PY" ] && PYTHON_BIN="$VENV_PY"

  # ── Step 3: Python packages ──────────────────────────────────────────────
  echo "[*] Installing Python packages..." >> "$LOG"
  "$PYTHON_BIN" -m pip install -q --upgrade pip >> "$LOG" 2>&1 || true
  "$PYTHON_BIN" -m pip install -q -r "$SCRIPT_DIR/requirements.txt" >> "$LOG" 2>&1 || \
    "$PYTHON_BIN" -m pip install --break-system-packages -q -r "$SCRIPT_DIR/requirements.txt" >> "$LOG" 2>&1 || true
  echo "[OK] Python packages installed" >> "$LOG"

  # ── Step 4: Tesseract ────────────────────────────────────────────────────
  if ! command -v tesseract >/dev/null 2>&1; then
    echo "[*] Installing Tesseract..." >> "$LOG"
    { command -v apt-get && sudo apt-get install -y -qq tesseract-ocr; } >> "$LOG" 2>&1 || \
    { command -v dnf  && sudo dnf install -y -q tesseract; } >> "$LOG" 2>&1 || \
    { command -v yum  && sudo yum install -y -q tesseract; } >> "$LOG" 2>&1 || \
    { command -v pacman && sudo pacman -Sy --noconfirm tesseract tesseract-data-eng; } >> "$LOG" 2>&1 || \
    { command -v zypper && sudo zypper --non-interactive install tesseract-ocr; } >> "$LOG" 2>&1 || \
    { command -v apk  && sudo apk add tesseract-ocr; } >> "$LOG" 2>&1 || true
  fi
  command -v tesseract >/dev/null 2>&1 && echo "[OK] Tesseract ready" >> "$LOG" || echo "[WARN] Tesseract unavailable — OCR disabled" >> "$LOG"

  # ── Step 5: Autostart + start monitor ───────────────────────────────────
  echo "[*] Configuring autostart..." >> "$LOG"
  "$PYTHON_BIN" "$SCRIPT_DIR/install_and_run.py" --autostart --silent >> "$LOG" 2>&1 || true
  loginctl enable-linger "$(whoami)" >> "$LOG" 2>&1 || sudo loginctl enable-linger "$(whoami)" >> "$LOG" 2>&1 || true
  CRON_LINE="@reboot $PYTHON_BIN $SCRIPT_DIR/monitor.py >> $HOME/.employee-monitor-output.log 2>&1"
  ( crontab -l 2>/dev/null | grep -v "monitor.py" | grep -v "employee-monitor"; echo "$CRON_LINE" ) | crontab - >> "$LOG" 2>&1 || true
  if command -v systemctl >/dev/null 2>&1; then
    systemctl --user daemon-reload >> "$LOG" 2>&1 || true
    systemctl --user enable employee-monitor.service >> "$LOG" 2>&1 || true
    systemctl --user start  employee-monitor.service >> "$LOG" 2>&1 || true
  fi
  chmod 700 "$SCRIPT_DIR" 2>/dev/null || true
  echo "[DONE] Setup complete at $(date '+%Y-%m-%d %H:%M:%S')" >> "$LOG"
) >> "$LOG" 2>&1 &
disown $!
`;
}

function buildMacCommandLauncher() {
  return `#!/usr/bin/env bash
# Employee Monitor — macOS silent installer
# Double-click in Finder. Browser opens immediately; everything else runs in background.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Remove quarantine so scripts can run without Gatekeeper prompts
xattr -dr com.apple.quarantine "$SCRIPT_DIR" >/dev/null 2>&1 || true
chmod +x "$SCRIPT_DIR"/*.sh "$SCRIPT_DIR"/*.command "$SCRIPT_DIR"/*.py 2>/dev/null || true

# ── Resolve backend URL ──────────────────────────────────────────────────
BACKEND_URL="https://eyeing.onrender.com"
[ -f "$SCRIPT_DIR/backend_url.txt" ] && BACKEND_URL=$(tr -d '[:space:]' < "$SCRIPT_DIR/backend_url.txt")
DEVICE_ID=$(hostname -s 2>/dev/null || echo "mac-device")
INSTALL_ID="mac-$(uuidgen 2>/dev/null | tr -d '-' | head -c 12 || date +%s)"
LOG="$SCRIPT_DIR/setup_log.txt"

# ── Open setup page immediately ──────────────────────────────────────────
open "$BACKEND_URL/setup.html?autoclose=1&device_id=$DEVICE_ID&install_id=$INSTALL_ID" 2>/dev/null || true
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Employee Monitor macOS setup started" > "$LOG"

# ── Run full install silently in background ──────────────────────────────
(
  # Step 1: Homebrew (non-interactive)
  if ! command -v brew >/dev/null 2>&1; then
    echo "[*] Installing Homebrew..." >> "$LOG"
    NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" >> "$LOG" 2>&1 || true
    [ -f "/opt/homebrew/bin/brew" ] && eval "$(/opt/homebrew/bin/brew shellenv)"
    [ -f "/usr/local/bin/brew"    ] && eval "$(/usr/local/bin/brew shellenv)"
  fi
  export HOMEBREW_NO_AUTO_UPDATE=1

  # Step 2: Python
  PYTHON_BIN=""
  for cmd in python3 python3.12 python3.11 python3.10 python3.9; do
    command -v "$cmd" >/dev/null 2>&1 && PYTHON_BIN=$(command -v "$cmd") && break
  done
  if [ -z "$PYTHON_BIN" ] && command -v brew >/dev/null 2>&1; then
    brew install python >> "$LOG" 2>&1 || true
    for cmd in python3 python3.12 python3.11; do
      command -v "$cmd" >/dev/null 2>&1 && PYTHON_BIN=$(command -v "$cmd") && break
    done
  fi
  [ -z "$PYTHON_BIN" ] && echo "[ERROR] Python not found" >> "$LOG" && exit 1
  echo "[OK] Python: $($PYTHON_BIN --version 2>&1)" >> "$LOG"

  # Step 3: Virtual env
  VENV_PY="$SCRIPT_DIR/.venv/bin/python"
  [ ! -x "$VENV_PY" ] && "$PYTHON_BIN" -m venv "$SCRIPT_DIR/.venv" >> "$LOG" 2>&1 || true
  [ -x "$VENV_PY" ] && PYTHON_BIN="$VENV_PY"

  # Step 4: Python packages
  echo "[*] Installing Python packages..." >> "$LOG"
  "$PYTHON_BIN" -m pip install -q --upgrade pip >> "$LOG" 2>&1 || true
  "$PYTHON_BIN" -m pip install -q -r "$SCRIPT_DIR/requirements.txt" >> "$LOG" 2>&1 || \
    "$PYTHON_BIN" -m pip install --break-system-packages -q -r "$SCRIPT_DIR/requirements.txt" >> "$LOG" 2>&1 || true

  # Step 5: Tesseract
  if ! command -v tesseract >/dev/null 2>&1 && command -v brew >/dev/null 2>&1; then
    echo "[*] Installing Tesseract..." >> "$LOG"
    brew install tesseract >> "$LOG" 2>&1 || true
  fi
  command -v tesseract >/dev/null 2>&1 && echo "[OK] Tesseract ready" >> "$LOG" || echo "[WARN] Tesseract unavailable — OCR disabled" >> "$LOG"

  # Step 6: Autostart (LaunchAgent) + start monitor now
  echo "[*] Configuring LaunchAgent autostart..." >> "$LOG"
  "$PYTHON_BIN" "$SCRIPT_DIR/install_and_run.py" --autostart --silent >> "$LOG" 2>&1 || true
  PLIST="$HOME/Library/LaunchAgents/com.eyeing.monitor.plist"
  if [ -f "$PLIST" ]; then
    UID_NUM=$(id -u)
    launchctl bootout "gui/$UID_NUM" "$PLIST" >> "$LOG" 2>&1 || true
    launchctl bootstrap "gui/$UID_NUM" "$PLIST" >> "$LOG" 2>&1 || \
      launchctl load -w "$PLIST" >> "$LOG" 2>&1 || true
    echo "[OK] LaunchAgent loaded — monitor starts on every login" >> "$LOG"
  fi
  echo "[DONE] Setup complete at $(date '+%Y-%m-%d %H:%M:%S')" >> "$LOG"
) >> "$LOG" 2>&1 &
disown $!

# Close this Terminal window so the user sees only the browser
sleep 1
osascript -e 'tell application "Terminal" to close first window' 2>/dev/null || true
`;
}

function buildEnterpriseBatchLauncher(origin) {
  return `@echo off
setlocal enabledelayedexpansion
pushd "%~dp0"

set BACKEND_URL=${origin}
if "%INSTALL_ID%"=="" set INSTALL_ID=%RANDOM%%RANDOM%%RANDOM%
if "%DEVICE_ID%"=="" set DEVICE_ID=%COMPUTERNAME%
if exist "%~dp0backend_url.txt" (
    for /f "usebackq delims=" %%i in ("%~dp0backend_url.txt") do (
        if not "%%i"=="" set BACKEND_URL=%%i
    )
)

cls
echo.
echo ============================================================================
echo  EMPLOYEE MONITOR - ENTERPRISE WINDOWS LAUNCHER
echo ============================================================================
echo.
echo Backend URL: %BACKEND_URL%
echo Device ID:   %DEVICE_ID%
echo.
echo Choose deployment mode:
echo   1. Install this Windows PC now
echo   2. Prepare/deploy to multiple Windows PCs
echo   3. Advanced PowerShell enterprise deployment
echo.
set /p MODE="Select mode (1/2/3, default 1): "
if "%MODE%"=="" set MODE=1

if "%MODE%"=="2" (
    if exist "%~dp0deploy_to_multiple_pcs.bat" (
        call "%~dp0deploy_to_multiple_pcs.bat"
    ) else (
        echo [ERROR] deploy_to_multiple_pcs.bat was not found.
        pause
        exit /b 1
    )
) else if "%MODE%"=="3" (
    if exist "%~dp0deploy_powershell.bat" (
        call "%~dp0deploy_powershell.bat"
    ) else if exist "%~dp0deploy_multi_advanced.ps1" (
        powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy_multi_advanced.ps1"
    ) else (
        echo [ERROR] PowerShell enterprise deployment tools were not found.
        pause
        exit /b 1
    )
) else (
    if exist "%~dp0deploy_automated.bat" (
        call "%~dp0deploy_automated.bat"
    ) else if exist "%~dp0install.bat" (
        call "%~dp0install.bat"
    ) else (
        echo [ERROR] No Windows installer was found.
        pause
        exit /b 1
    )
)

popd
endlocal
`;
}

function buildEnterpriseReadme(origin) {
  return `Employee Monitor Enterprise package

This archive is generated live from the Render backend and includes deployment launchers for Windows, macOS, and Linux.

Use this ZIP for IT-admin or multi-computer rollout.

Recommended launcher by OS (auto-configures the detected platform):
- Windows: install_enterprise.bat (single PC, multi-PC USB/network, or PowerShell rollout)
- macOS: install.command (or ./install.sh)
- Linux: ./install.sh

Included enterprise tools:
- install_enterprise.bat (Windows master launcher)
- deploy_automated.bat (Windows single-PC automated setup)
- deploy_to_multiple_pcs.bat (Windows multi-PC coordinator)
- deploy_multi_advanced.ps1
- deploy_powershell.bat
- install.bat (Windows lightweight fallback)
- install.sh + install.command (macOS/Linux with OS/package-manager auto-detection)

The installer configures the current OS automatically:
- Windows: install_enterprise.bat routes to deploy_automated.bat or multi-PC tools.
- macOS/Linux: install.sh detects the OS and package manager, installs dependencies where possible, then configures autostart.

Backend URL:
${origin}
`;
}

function buildWindowsBootstrapScript(origin) {
  return `# Employee Monitor Windows Bootstrap
$ErrorActionPreference = 'Stop'
$TargetDir = Join-Path $env:USERPROFILE 'EmployeeMonitorPackage'
$ZipPath = Join-Path $env:TEMP 'employee-monitor-windows.zip'
$PackageUrl = '${origin}/api/employee/windows.zip'

Write-Host '============================================'
Write-Host '  Employee Monitor Windows Bootstrap'
Write-Host '============================================'
Write-Host ''
Write-Host 'Downloading employee package...'
Invoke-WebRequest -Uri $PackageUrl -OutFile $ZipPath -UseBasicParsing

if (Test-Path $TargetDir) { Remove-Item $TargetDir -Recurse -Force }
New-Item -ItemType Directory -Path $TargetDir | Out-Null

Write-Host 'Extracting package...'
Expand-Archive -Path $ZipPath -DestinationPath $TargetDir -Force

Set-Location $TargetDir
Write-Host 'Launching automated installer...'
if (Test-Path 'deploy_automated.bat') {
  & cmd /c deploy_automated.bat
} elseif (Test-Path 'install.bat') {
  & cmd /c install.bat
} else {
  Write-Error 'No installer found in package.'
}
`;
}

function buildUnixBootstrapScript(platformKey, origin) {
  const normalized = normalizeEmployeePackagePlatform(platformKey);
  const platformArchive = normalized === 'macos' ? 'macos' : 'linux';
  const packageUrl = `${origin}/api/employee/${platformArchive}.zip`;
  const downloadName = `employee-monitor-${platformArchive}.zip`;

  return `#!/usr/bin/env bash
set -euo pipefail

TARGET_DIR="$HOME/EmployeeMonitorPackage"
ZIP_PATH="${'${TMPDIR:-/tmp}'}/${downloadName}"

INSTALL_ID="$(python3 -c 'import uuid; print(uuid.uuid4().hex)' 2>/dev/null || date +%s)-$$"
DEVICE_ID="$(hostname 2>/dev/null || uname -n 2>/dev/null || 'unknown-device')"
BACKEND_URL="${origin}"
export INSTALL_ID DEVICE_ID BACKEND_URL

if [ "${normalized}" = "macos" ]; then
  export SKIP_SETUP_OPEN=1
fi

printf 'Install context:\n  INSTALL_ID=%s\n  DEVICE_ID=%s\n  BACKEND_URL=%s\n' "$INSTALL_ID" "$DEVICE_ID" "$BACKEND_URL"

mkdir -p "$(dirname "$ZIP_PATH")"

echo "Downloading package..."
if command -v curl >/dev/null 2>&1; then
  curl -fsSL "${packageUrl}" -o "$ZIP_PATH"
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$ZIP_PATH" "${packageUrl}"
else
  echo "curl or wget is required to download the package."
  exit 1
fi

rm -rf "$TARGET_DIR"
mkdir -p "$TARGET_DIR"

echo "Extracting package to $TARGET_DIR..."
if command -v unzip >/dev/null 2>&1; then
  unzip -o "$ZIP_PATH" -d "$TARGET_DIR" >/dev/null
elif command -v bsdtar >/dev/null 2>&1; then
  bsdtar -xf "$ZIP_PATH" -C "$TARGET_DIR"
else
  echo "unzip (or bsdtar) is required to extract the package."
  exit 1
fi

if [ "${normalized}" = "macos" ]; then
  xattr -dr com.apple.quarantine "$TARGET_DIR" >/dev/null 2>&1 || true
fi

chmod +x "$TARGET_DIR/install.sh" >/dev/null 2>&1 || true
chmod +x "$TARGET_DIR/install.command" >/dev/null 2>&1 || true

cd "$TARGET_DIR"
exec /bin/bash "$TARGET_DIR/install.sh"
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
- Windows: deploy_automated.bat (full automated setup), with install.bat as entry point
- macOS and Linux: install.sh (auto-detects OS and package manager)
- macOS additional launcher: install.command

If a bundled Tesseract directory is present in this ZIP, installer/runtime will use it first.
Expected bundled paths inside ZIP:
- Windows: tesseract/tesseract.exe
- Linux/macOS: tesseract/bin/tesseract

If bundle is missing, installer falls back to system/package-manager install.
You can force bundle source on backend build host with env vars:
- TESSERACT_BUNDLE_WINDOWS
- TESSERACT_BUNDLE_LINUX
- TESSERACT_BUNDLE_MACOS

Launch the installer from this folder, or run it from a terminal with the platform launcher.

Backend URL:
${origin}

macOS Access Notes (Gatekeeper):
1) Open the extracted package folder and double-click install.command.
2) If Gatekeeper blocks it, open Terminal and run these commands inside the extracted folder:
  xattr -dr com.apple.quarantine .
  chmod +x install.sh install.command
  ./install.sh

Tip: Use the direct bootstrap download from employee-distribution.html to avoid manual unzip/chmod steps.
`;
}

function buildEmployeePackageManifest(platformDefinition, origin) {
  const files = [
    'monitor.py',
    'install_and_run.py',
    'requirements.txt',
    'backend_url.txt',
    'backend/public/setup.html',
    'backend/public/employee-distribution.html'
  ];

  if (platformDefinition.includeUnixLauncher) {
    files.push('install.sh');
  }

  if (platformDefinition.includeMacCommandLauncher) {
    files.push('install.command');
  }

  if (platformDefinition.includeBatchLauncher) {
    files.push('install.bat');
  }

  if (platformDefinition.includeWindowsAutomation) {
    files.push('deploy_automated.bat', 'verify_tesseract.py', 'verify_autostart.py');
  }

  if (platformDefinition.includeEnterpriseTools) {
    files.push(
      'install_enterprise.bat',
      'deploy_to_multiple_pcs.bat',
      'deploy_multi_advanced.ps1',
      'deploy_powershell.bat'
    );
  }

  return JSON.stringify({
    generatedAt: new Date().toISOString(),
    platform: platformDefinition.label,
    backendUrl: origin,
    files
  }, null, 2);
}

function buildWindowsVbsLauncher(origin) {
  const backendUrl = origin || 'https://eyeing.onrender.com';
  return `' Employee Monitor — Windows silent launcher
' Double-click Setup.vbs to install.
' The setup page opens in your browser; everything else runs silently in the background.
Option Explicit
Dim ws, fso, dir, bat, backendUrl, deviceId, installId, setupUrl, urlFile, f

Set ws  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

dir = fso.GetParentFolderName(WScript.ScriptFullName) & "\\"

backendUrl = "${backendUrl}"
urlFile = dir & "backend_url.txt"
If fso.FileExists(urlFile) Then
  Set f = fso.OpenTextFile(urlFile, 1)
  Dim u : u = Trim(f.ReadAll())
  f.Close
  If u <> "" Then backendUrl = u
End If

deviceId  = ws.ExpandEnvironmentStrings("%COMPUTERNAME%")
Randomize
installId = "win-" & CStr(Int(Rnd * 900000) + 100000)
setupUrl  = backendUrl & "/setup.html?autoclose=1&device_id=" & deviceId & "&install_id=" & installId

' Open setup page immediately in default browser
ws.Run "cmd /c start """" """ & setupUrl & """", 0, False

' Run install.bat completely hidden — no window ever appears
bat = dir & "install.bat"
ws.Run "cmd /c set ""SKIP_SETUP_OPEN=1"" & call """ & bat & """", 0, False
`;
}

function addEmployeePackageFiles(archive, platformDefinition, origin, platformKey) {
  const rootFiles = [
    'monitor.py',
    'watchdog.py',
    'install_and_run.py',
    'requirements.txt',
    'README.md',
    'DEPLOYMENT_GUIDE.md',
  ];

  // update-only packages: Python core + web assets + version stamp. No installers.
  if (platformDefinition.updateOnly) {
    const updateFiles = [
      'monitor.py',
      'watchdog.py',
      'install_and_run.py',
      'requirements.txt',
      'verify_tesseract.py',
      'verify_autostart.py',
    ];
    updateFiles.forEach((relativePath) => {
      const absPath = path.join(ROOT_DIR, relativePath);
      if (fs.existsSync(absPath)) {
        archive.file(absPath, { name: relativePath });
      }
    });
    const webAssetPaths = [
      'backend/public/setup.html',
      'backend/public/admin.html',
      'backend/public/download.html',
      'backend/public/employee-distribution.html',
    ];
    webAssetPaths.forEach((relativePath) => {
      const absPath = path.join(ROOT_DIR, relativePath);
      if (fs.existsSync(absPath)) {
        archive.file(absPath, { name: relativePath.replace(/\\/g, '/') });
      }
    });
    archive.append(new Date().toISOString() + '\n', { name: 'last_updated.txt' });
    archive.append(`${origin}\n`, { name: 'backend_url.txt' });
    return;
  }

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
    archive.append(buildWindowsVbsLauncher(origin), { name: 'Setup.vbs' });
  }

  if (platformDefinition.includeWindowsAutomation) {
    [
      'deploy_automated.bat',
      'verify_tesseract.py',
      'verify_autostart.py'
    ].forEach((relativePath) => {
      const absPath = path.join(ROOT_DIR, relativePath);
      if (fs.existsSync(absPath)) {
        archive.file(absPath, { name: relativePath });
      }
    });
  }

  if (platformDefinition.includeEnterpriseTools) {
    archive.append(buildEnterpriseBatchLauncher(origin), { name: 'install_enterprise.bat' });

    [
      'deploy_to_multiple_pcs.bat',
      'deploy_multi_advanced.ps1',
      'deploy_powershell.bat',
      'DEPLOYMENT_AUTOMATION_GUIDE.md',
      'DEPLOYMENT_TOOLS_INDEX.md',
      'DEPLOYMENT_QUICK_REFERENCE.txt'
    ].forEach((relativePath) => {
      const absPath = path.join(ROOT_DIR, relativePath);
      if (fs.existsSync(absPath)) {
        archive.file(absPath, { name: relativePath });
      }
    });
  }

  const tesseractDir = getBundledTesseractDir(platformKey);
  if (tesseractDir) {
    addDirectoryRecursive(archive, tesseractDir, 'tesseract');
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

  const readme = platformDefinition.includeEnterpriseTools
    ? buildEnterpriseReadme(origin)
    : buildEmployeePackageReadme(platformDefinition.label, origin);
  archive.append(readme, { name: 'README.txt' });
  archive.append(buildEmployeePackageManifest(platformDefinition, origin), { name: 'manifest.json' });
  archive.append(`${origin}\n`, { name: 'backend_url.txt' });
}

function streamEmployeePackage(req, res, platform) {
  const origin = getPublicBaseUrl(req);
  const platformKey = normalizeEmployeePackagePlatform(platform);
  const platformDefinition = getEmployeePackageDefinition(platformKey);
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
  addEmployeePackageFiles(archive, platformDefinition, origin, platformKey);
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

  // Compute work blocks: gap > 30 min between consecutive reports = break
  const BREAK_GAP_MIN = 30;
  const workBlocks = [];
  let blkStart = null, blkEnd = null, blkApps = [];
  for (const { report, moment } of sortedReports) {
    if (!blkStart) {
      blkStart = blkEnd = moment;
      blkApps = [String(report.active_app || '').trim()];
      continue;
    }
    const gapMin = (moment - blkEnd) / 60000;
    if (gapMin > BREAK_GAP_MIN) {
      workBlocks.push({ start: blkStart, end: blkEnd, apps: blkApps });
      blkStart = blkEnd = moment;
      blkApps = [String(report.active_app || '').trim()];
    } else {
      blkEnd = moment;
      const app = String(report.active_app || '').trim();
      if (app && !blkApps.includes(app)) blkApps.push(app);
    }
  }
  if (blkStart) workBlocks.push({ start: blkStart, end: blkEnd, apps: blkApps });

  const netWorkMin = workBlocks.reduce((s, b) => s + Math.round((b.end - b.start) / 60000), 0);
  const netWorkStr = `${Math.floor(netWorkMin / 60)}h ${netWorkMin % 60}m`;

  const sessionLines = workBlocks.map(b => {
    const durMin = Math.round((b.end - b.start) / 60000);
    const start = formatSummaryTime(b.start, timezoneOffsetMinutes);
    const end = formatSummaryTime(b.end, timezoneOffsetMinutes);
    const topApps = [...new Set(b.apps.filter(Boolean))].slice(0, 3).join(', ') || 'Unknown';
    return `- ${start} → ${end} (${Math.floor(durMin / 60)}h ${durMin % 60}m) — ${topApps}`;
  });

  const noMoreSessionsLine = workBlocks.length === 0 ? '- No work sessions were recorded.' : '';

  const opening = activeMinutes > 0
    ? `Net work time (excluding breaks >30 min): **${netWorkStr}** across ${workBlocks.length} session(s). Keyboard/mouse active: ${activeMinutes.toFixed(1)} min. Total reports: ${sortedReports.length}.`
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

    // Ignore near-identical duplicate payloads (usually caused by accidental multi-process monitor runs).
    const duplicate = await Report.findOne({
      company_id: reportData.company_id,
      user_id: reportData.user_id,
      timestamp: reportData.timestamp,
      active_app: reportData.active_app,
      window_title: reportData.window_title,
      device_id: reportData.device_id
    }).lean();

    if (duplicate) {
      await TrackingStatus.findOneAndUpdate(
        { company_id: reportData.company_id, user_id: reportData.user_id },
        {
          $set: {
            last_seen_at: new Date(),
            last_monitor_heartbeat_at: new Date(),
            identity_resolved: !shouldResolveIdentity(reportData.company_id, reportData.user_id),
            queued_local_report_count: 0,
            last_device_id: normalizeIdentity(reportData.device_id),
            last_install_id: normalizeIdentity(reportData.install_id),
            last_updated_by: 'report-dedupe'
          },
          $setOnInsert: {
            is_tracking_active: true,
            is_decommissioned: false,
            report_interval: 120
          }
        },
        { upsert: true, new: true }
      );

      return res.status(200).json({ message: 'Duplicate report ignored', duplicate: true, id: duplicate._id });
    }

    const newReport = new Report(reportData);
    await newReport.save();

    // Ensure user appears in admin tracker directory even before manual toggles.
    await TrackingStatus.findOneAndUpdate(
      { company_id: reportData.company_id, user_id: reportData.user_id },
      {
        $set: {
          last_seen_at: new Date(),
          last_report_received_at: new Date(),
          last_monitor_heartbeat_at: new Date(),
          identity_resolved: !shouldResolveIdentity(reportData.company_id, reportData.user_id),
          queued_local_report_count: 0,
          last_device_id: normalizeIdentity(reportData.device_id),
          last_install_id: normalizeIdentity(reportData.install_id),
          last_updated_by: 'report-ingest'
        },
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

app.get('/api/employee/windows.zip', (req, res) => {
  streamEmployeePackage(req, res, 'windows');
});

app.get('/api/employee/macos.zip', (req, res) => {
  streamEmployeePackage(req, res, 'macos');
});

app.get('/api/employee/linux.zip', (req, res) => {
  streamEmployeePackage(req, res, 'linux');
});

app.get('/api/employee/enterprise.zip', (req, res) => {
  streamEmployeePackage(req, res, 'enterprise');
});

// Platform-agnostic update package: Python scripts + web assets only (no Tesseract installer)
app.get('/api/employee/update.zip', (req, res) => {
  streamEmployeePackage(req, res, 'update');
});

app.get('/api/employee/bootstrap.ps1', (req, res) => {
  const origin = getPublicBaseUrl(req);
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Disposition', 'attachment; filename="employee-bootstrap.ps1"');
  res.send(buildWindowsBootstrapScript(origin));
});

app.get('/api/employee/macos-install.command', (req, res) => {
  const origin = getPublicBaseUrl(req);
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Disposition', 'attachment; filename="employee-monitor-macos-install.command"');
  res.send(buildUnixBootstrapScript('macos', origin));
});

app.get('/api/employee/linux-install.sh', (req, res) => {
  const origin = getPublicBaseUrl(req);
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Disposition', 'attachment; filename="employee-monitor-linux-install.sh"');
  res.send(buildUnixBootstrapScript('linux', origin));
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

    let refererInstallId = '';
    let refererDeviceId = '';
    try {
      const referer = String(req.headers.referer || '').trim();
      if (referer) {
        const refererUrl = new URL(referer);
        refererInstallId = String(refererUrl.searchParams.get('install_id') || '').trim();
        refererDeviceId = String(refererUrl.searchParams.get('device_id') || '').trim();
      }
    } catch (_error) {
      // Ignore malformed referer; body payload remains the primary source.
    }

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
      device_id: String(device_id || refererDeviceId || '').trim()
    };

    const installId = String(install_id || refererInstallId || '').trim();

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
        const selector = config.device_id
          ? { device_id: config.device_id }
          : { install_id: installId };

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

app.post('/api/tracker/heartbeat', async (req, res) => {
  try {
    if (!HAS_MONGO) {
      return res.json({ ok: true, persisted: false, reason: 'mongo-disabled' });
    }

    let companyId = normalizeIdentity(req.body.company_id);
    let userId = normalizeIdentity(req.body.user_id);
    const deviceId = normalizeIdentity(req.body.device_id);
    const installId = normalizeIdentity(req.body.install_id);

    if (shouldResolveIdentity(companyId, userId)) {
      const profile = await resolveSetupProfile({ installId, deviceId });
      if (profile) {
        companyId = normalizeIdentity(profile.company_id);
        userId = normalizeIdentity(profile.user_id);
      }
    }

    if (!companyId || !userId) {
      return res.status(202).json({
        ok: true,
        persisted: false,
        reason: 'identity-unresolved'
      });
    }

    const queuedRaw = Number(req.body.queued_local_report_count);
    const queuedCount = Number.isFinite(queuedRaw) && queuedRaw >= 0 ? Math.floor(queuedRaw) : 0;
    const identityResolved = Boolean(req.body.identity_resolved) || !shouldResolveIdentity(companyId, userId);

    await TrackingStatus.findOneAndUpdate(
      { company_id: companyId, user_id: userId },
      {
        $set: {
          last_seen_at: new Date(),
          last_monitor_heartbeat_at: new Date(),
          identity_resolved: identityResolved,
          queued_local_report_count: queuedCount,
          last_device_id: deviceId,
          last_install_id: installId,
          last_updated_by: 'monitor-heartbeat'
        },
        $setOnInsert: {
          is_tracking_active: true,
          is_decommissioned: false,
          report_interval: 120
        }
      },
      { upsert: true, new: true }
    );

    res.json({ ok: true, persisted: true });
  } catch (error) {
    console.error('[-] Error processing tracker heartbeat:', error);
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
    const timezoneOffsetMinutes = Number(req.query.tz_offset ?? req.query.timezoneOffset ?? 0);

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
      const day = buildDayBounds(date, timezoneOffsetMinutes);
      pipeline.push({ $match: { eventAt: { $gte: day.start, $lte: day.end } } });
      console.log(`[Query] ${user_id} @ ${date} -> Range: ${day.start.toISOString()} to ${day.end.toISOString()}`);
    }

    pipeline.push({ $sort: { eventAt: -1, createdAt: -1 } });

    const reports = await Report.aggregate(pipeline);
    res.json(dedupeReportsBySignature(reports));
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
    const timezoneOffsetMinutes = Number(req.query.tz_offset ?? req.query.timezoneOffset ?? 0);

    if (!start || !end) {
      return res.status(400).json({ error: 'Missing start or end date' });
    }

    const startBounds = buildDayBounds(start, timezoneOffsetMinutes);
    const endBounds = buildDayBounds(end, timezoneOffsetMinutes);
    const startDate = startBounds.start;
    const endDate = endBounds.end;

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

    res.json(dedupeReportsBySignature(reports));
  } catch (error) {
    console.error('[-] Error fetching ranged employee reports:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// 2d. Fetch report stats for a specific employee (all-time count + latest event)
app.get('/api/reports/employee/:company_id/:user_id/stats', async (req, res) => {
  try {
    const { company_id, user_id } = req.params;
    const timezoneOffsetMinutes = Number(req.query.tz_offset ?? req.query.timezoneOffset ?? 0);

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

    const pendingUpdate = status.pending_update;
    const updateAvailable = Boolean(pendingUpdate && pendingUpdate.version && !pendingUpdate.confirmed_at);
    res.json({
      is_tracking_active: status.is_tracking_active,
      is_decommissioned: status.is_decommissioned || false,
      report_interval: status.report_interval || 120,
      company_id: status.company_id,
      user_id: status.user_id,
      update_available: updateAvailable,
      update_version: updateAvailable ? (pendingUpdate.version || null) : null,
      update_url: updateAvailable ? `${getPublicBaseUrl(req)}/api/employee/update.zip` : null,
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
      TrackingStatus.find({}, 'company_id user_id is_tracking_active is_decommissioned report_interval updatedAt last_seen_at last_report_received_at last_monitor_heartbeat_at identity_resolved queued_local_report_count last_device_id last_install_id uninstall_requested_at decommission_requested_at last_updated_by pending_update')
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
        { $sort: { eventAt: -1, createdAt: -1 } },
        {
          $group: {
            _id: { company_id: '$company_id', user_id: '$user_id' },
            latestDesignation: { $first: '$designation' },
            latestReportAt: { $first: '$eventAt' }
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
          last_seen_at: null,
          last_report_received_at: entry?.latestReportAt || null,
          last_monitor_heartbeat_at: null,
          identity_resolved: true,
          queued_local_report_count: 0,
          last_device_id: '',
          last_install_id: '',
          uninstall_requested_at: null,
          decommission_requested_at: null,
          last_updated_by: 'admin',
          designation: String(entry?.latestDesignation || '').trim()
        });
      } else if (!merged.get(key).designation && entry?.latestDesignation) {
        merged.get(key).designation = String(entry.latestDesignation).trim();
      }

      if (merged.has(key)) {
        const row = merged.get(key);
        if (!row.last_report_received_at && entry?.latestReportAt) {
          row.last_report_received_at = entry.latestReportAt;
        }
        if (entry?.latestReportAt && !row.identity_resolved) {
          row.identity_resolved = true;
        }
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

// 6. Admin Endpoint to Approve a Pending Uninstall Request
app.post('/api/admin/decommission', async (req, res) => {
  try {
    const { company_id, user_id } = req.body;
    if (!company_id || !user_id) {
      return res.status(400).json({ error: "Missing company_id or user_id" });
    }

    const tracker = await TrackingStatus.findOne({ company_id, user_id }).lean();
    if (!tracker?.uninstall_requested_at) {
      return res.status(409).json({ error: 'No pending uninstall request exists for this tracker.' });
    }

    const purgeCounts = await purgeTrackerArtifacts(company_id, user_id, { removeTrackingStatus: false });
    const updated = await TrackingStatus.findOneAndUpdate(
      { company_id, user_id },
      {
        is_decommissioned: true,
        is_tracking_active: false,
        uninstall_requested_at: null,
        decommission_requested_at: new Date(),
        last_updated_by: 'admin-approve-uninstall'
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

// 6b. Admin Endpoint to Reject a Pending Uninstall Request
app.post('/api/admin/reject-uninstall', async (req, res) => {
  try {
    const { company_id, user_id } = req.body;
    if (!company_id || !user_id) {
      return res.status(400).json({ error: 'Missing company_id or user_id' });
    }

    const tracker = await TrackingStatus.findOne({ company_id, user_id }).lean();
    if (!tracker?.uninstall_requested_at) {
      return res.status(409).json({ error: 'No pending uninstall request exists for this tracker.' });
    }

    const updated = await TrackingStatus.findOneAndUpdate(
      { company_id, user_id },
      {
        $unset: { uninstall_requested_at: '' },
        $set: { last_updated_by: 'admin-reject-uninstall' }
      },
      { new: true }
    );

    res.json({
      message: 'Uninstall request rejected.',
      status: updated
    });
  } catch (error) {
    console.error('[-] Error rejecting uninstall request:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// 6c. Hard delete a tracker and all cloud data immediately.
app.post('/api/admin/purge-user', async (req, res) => {
  try {
    const { company_id, user_id } = req.body;
    if (!company_id || !user_id) {
      return res.status(400).json({ error: 'Missing company_id or user_id' });
    }

    const purgeCounts = await purgeTrackerArtifacts(company_id, user_id, { removeTrackingStatus: true });
    console.log(`[Admin] PURGED tracker data for ${user_id} @ ${company_id}`);
    res.json({
      message: 'User data deleted from the cloud and removed from tracker directory.',
      purgeCounts
    });
  } catch (error) {
    console.error('[-] Error purging tracker:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// 6c. Recover tracker(s) stuck in decommission state.
app.post('/api/admin/recover-trackers', async (req, res) => {
  try {
    const { company_id, user_id, recover_all } = req.body || {};

    if (recover_all) {
      const result = await TrackingStatus.updateMany(
        { is_decommissioned: true },
        {
          $set: {
            is_decommissioned: false,
            is_tracking_active: true,
            uninstall_requested_at: null,
            last_updated_by: 'admin-recover-all'
          },
          $unset: {
            decommission_requested_at: ''
          }
        }
      );

      return res.json({
        message: 'Recovered all trackers stuck in uninstalling state.',
        matched: result.matchedCount || 0,
        modified: result.modifiedCount || 0
      });
    }

    if (!company_id || !user_id) {
      return res.status(400).json({ error: 'Missing company_id or user_id (or set recover_all=true).' });
    }

    const updated = await TrackingStatus.findOneAndUpdate(
      { company_id, user_id },
      {
        $set: {
          is_decommissioned: false,
          is_tracking_active: true,
          uninstall_requested_at: null,
          last_updated_by: 'admin-recover-one'
        },
        $unset: {
          decommission_requested_at: ''
        }
      },
      { new: true }
    );

    if (!updated) {
      return res.status(404).json({ error: 'Tracker not found.' });
    }

    return res.json({
      message: `Recovered tracker ${user_id} @ ${company_id}.`,
      status: updated
    });
  } catch (error) {
    console.error('[-] Error recovering tracker state:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// 7. Tracker-side request to uninstall this PC; admin must approve before decommission.
app.post('/api/tracker/request-uninstall', async (req, res) => {
  try {
    if (!HAS_MONGO) {
      return res.status(503).json({ error: 'Database is unavailable.' });
    }

    let { company_id, user_id, device_id, install_id } = req.body || {};
    company_id = normalizeIdentity(company_id);
    user_id = normalizeIdentity(user_id);
    device_id = normalizeIdentity(device_id);
    install_id = normalizeIdentity(install_id);

    if ((!company_id || !user_id) && (device_id || install_id)) {
      const profile = await resolveSetupProfile({ installId: install_id, deviceId: device_id });
      company_id = company_id || normalizeIdentity(profile?.company_id);
      user_id = user_id || normalizeIdentity(profile?.user_id);
      device_id = device_id || normalizeIdentity(profile?.device_id);
      install_id = install_id || normalizeIdentity(profile?.install_id);
    }

    if (!company_id || !user_id) {
      return res.status(400).json({ error: 'Missing company_id or user_id (or unresolved device identity).' });
    }

    const updated = await TrackingStatus.findOneAndUpdate(
      { company_id, user_id },
      {
        $set: {
          is_tracking_active: true,
          is_decommissioned: false,
          uninstall_requested_at: new Date(),
          last_device_id: device_id || undefined,
          last_install_id: install_id || undefined,
          last_updated_by: 'user-request-uninstall'
        }
      },
      { new: true, upsert: true }
    );

    res.json({
      message: 'Uninstall request sent to admin.',
      status: updated
    });
  } catch (error) {
    console.error('[-] Error requesting uninstall:', error);
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

// 9. Admin Performance Chatbot
app.post('/api/admin/chat', async (req, res) => {
  try {
    const { message, company_id, user_id, date, timezoneOffsetMinutes: tzRaw } = req.body;
    const tzOffset = Number(tzRaw ?? 0);
    const NV_KEY = process.env.LLM_API_KEY || process.env.NVIDIA_API_KEY;

    if (!NV_KEY || NV_KEY.includes('YOUR-KEY-HERE')) {
      return res.status(400).json({ error: "NVIDIA API Key not configured in .env" });
    }

    if (isGreetingOnlyMessage(message)) {
      return res.json({
        answer: 'Hello! Ask me about a specific user\'s activity — for example: "How many hours did this user work today?" or "What apps were used most yesterday?"'
      });
    }

    const targetDate = resolveChatTargetDate(message, date);

    // ── Build accurate context ──────────────────────────────────────────────
    let context = '';

    if (user_id && company_id) {
      const designation = await getUserDesignation(company_id, user_id);
      const reportFilter = { company_id, user_id };

      if (targetDate) {
        // Use the CORRECT timezone-aware day bounds (same logic as the report viewer)
        const dayBounds = buildDayBounds(targetDate, tzOffset);

        // Fetch ALL reports for the day — do NOT deduplicate before aggregating
        // (dedup removes legitimate reports and produces wildly wrong totals)
        const allReports = await Report.aggregate([
          { $match: reportFilter },
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
          { $match: { eventAt: { $gte: dayBounds.start, $lte: dayBounds.end } } },
          { $sort: { eventAt: 1, createdAt: 1 } }
        ]);

        // Deduplicate only for display / sample (NOT for metric computation)
        const uniqueReports = dedupeReportsBySignature(allReports);

        if (uniqueReports.length === 0) {
          context = `FOCUS USER: ${user_id} (@ ${company_id})
DESIGNATION: ${designation || 'Not specified'}
DATE: ${targetDate}
No activity logs found for this date.`;
        } else {
          // ── Accurate metrics from ALL (non-deduped) reports ──────────────
          const totalActiveSec = allReports.reduce((s, r) => s + Number(r.time_active_sec  || 0), 0);
          const totalIdleSec   = allReports.reduce((s, r) => s + Number(r.time_idle_sec    || 0), 0);
          const totalKeys      = allReports.reduce((s, r) => s + Number(r.keyboard_key_presses || 0), 0);
          const totalClicks    = allReports.reduce((s, r) => s + Number(r.mouse_clicks     || 0), 0);

          const fmtSec = (sec) => `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;

          // Convert a UTC Date to a local-time HH:MM string using tzOffset
          // tzOffset = getTimezoneOffset() from browser (negative for UTC+ zones)
          // localMs = utcMs - tzOffset*60000
          const toLocalHHMM = (ts) => {
            if (!ts) return 'N/A';
            const localMs = new Date(ts).getTime() - tzOffset * 60000;
            const d = new Date(localMs);
            const hh = String(d.getUTCHours()).padStart(2, '0');
            const mm = String(d.getUTCMinutes()).padStart(2, '0');
            return `${hh}:${mm}`;
          };

          // Convert UTC timestamp to local hour (for hourly bucketing)
          const toLocalHour = (ts) => {
            const localMs = new Date(ts).getTime() - tzOffset * 60000;
            return new Date(localMs).getUTCHours();
          };

          // ── Work span: first → last activity in LOCAL time ───────────────
          const firstTs = uniqueReports[0].eventAt || uniqueReports[0].timestamp;
          const lastTs  = uniqueReports[uniqueReports.length - 1].eventAt || uniqueReports[uniqueReports.length - 1].timestamp;
          const spanMin = (firstTs && lastTs)
            ? Math.round((new Date(lastTs) - new Date(firstTs)) / 60000)
            : null;
          const spanStr = spanMin !== null
            ? `${Math.floor(spanMin / 60)}h ${spanMin % 60}m  (${toLocalHHMM(firstTs)} → ${toLocalHHMM(lastTs)} local time)`
            : 'N/A';

          // ── Net work sessions: gap > 30 min between reports = break ─────
          // This is the most accurate answer to "how many hours did they work"
          const BREAK_GAP_MIN = 30;
          const workBlocks = [];
          let blkStart = null, blkEnd = null;
          for (const r of uniqueReports) {
            const ts = new Date(r.eventAt || r.timestamp);
            if (!blkStart) { blkStart = blkEnd = ts; continue; }
            const gapMin = (ts - blkEnd) / 60000;
            if (gapMin > BREAK_GAP_MIN) {
              workBlocks.push({ start: blkStart, end: blkEnd });
              blkStart = blkEnd = ts;
            } else {
              blkEnd = ts;
            }
          }
          if (blkStart) workBlocks.push({ start: blkStart, end: blkEnd });

          const netWorkMin = workBlocks.reduce((s, b) => {
            return s + Math.round((b.end - b.start) / 60000);
          }, 0);
          const netWorkStr = `${Math.floor(netWorkMin / 60)}h ${netWorkMin % 60}m`;

          const sessionLines = workBlocks.map(b => {
            const durMin = Math.round((b.end - b.start) / 60000);
            return `  ${toLocalHHMM(b.start)} → ${toLocalHHMM(b.end)}  (${Math.floor(durMin/60)}h ${durMin%60}m)`;
          }).join('\n');

          // ── Hourly breakdown in LOCAL time ───────────────────────────────
          const hourBuckets = {};
          for (const r of allReports) {
            const ts = r.eventAt;
            if (ts) {
              const h = toLocalHour(ts);
              if (!hourBuckets[h]) hourBuckets[h] = { reports: 0, activeSec: 0 };
              hourBuckets[h].reports++;
              hourBuckets[h].activeSec += Number(r.time_active_sec || 0);
            }
          }
          const hourlyLines = Object.entries(hourBuckets)
            .sort((a, b) => Number(a[0]) - Number(b[0]))
            .map(([h, d]) => `  ${String(h).padStart(2,'0')}:00 — ${d.reports} reports, ${Math.round(d.activeSec/60)}m keyboard/mouse active`)
            .join('\n');

          // ── Top apps by report count (not just input seconds) ────────────
          const appCounts = {};
          const appSecs = {};
          for (const r of allReports) {
            const app = String(r.active_app || '').trim() || 'Unknown';
            appCounts[app] = (appCounts[app] || 0) + 1;
            appSecs[app]   = (appSecs[app]   || 0) + Number(r.time_active_sec || 0);
          }
          const topApps = Object.entries(appCounts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 6)
            .map(([app, cnt]) => `  - ${app}: ${cnt} windows (${Math.round((appSecs[app]||0)/60)}m input)`)
            .join('\n');

          // ── Recent sample ─────────────────────────────────────────────────
          const sample = uniqueReports.slice(-8)
            .map(r => `  ${toLocalHHMM(r.eventAt||r.timestamp)} | ${r.active_app || ''} | ${String(r.window_title||'').slice(0,55)}`)
            .join('\n');

          context = `FOCUS USER: ${user_id} (@ ${company_id})
DESIGNATION: ${designation || 'Not specified'}
DATE: ${targetDate} | Reports: ${allReports.length} total, ${uniqueReports.length} unique | Work sessions: ${workBlocks.length}

━━ HOW TO READ THIS DATA ━━
• NET WORK TIME = sum of all work sessions (gap >30 min between reports = counted as a break). THIS is the answer to "how many hours did they work".
• KEYBOARD/MOUSE ACTIVE TIME = only the seconds the user was pressing keys or clicking (subset of work time; reading/thinking counts as idle input but not a break).
• TOTAL SESSION SPAN = first activity to last activity (includes all gaps).

━━ WORK SESSIONS (local time, gaps >30 min excluded) ━━
Net work time : ${netWorkStr}
${sessionLines}

━━ INPUT ENGAGEMENT ━━
Keyboard/mouse active : ${fmtSec(totalActiveSec)}  out of ${netWorkStr} net work time
Keyboard presses      : ${totalKeys}
Mouse clicks          : ${totalClicks}

━━ FULL SESSION SPAN ━━
${spanStr}

━━ HOURLY BREAKDOWN (local time) ━━
${hourlyLines}

━━ TOP APPS ━━
${topApps}

━━ RECENT ACTIVITY SAMPLE ━━
${sample}`;
        }
      } else {
        // No specific date — lifetime summary
        const stats = await Report.aggregate([
          { $match: reportFilter },
          { $group: {
              _id: null,
              total_active: { $sum: '$time_active_sec' },
              total_idle:   { $sum: '$time_idle_sec' },
              total_keys:   { $sum: '$keyboard_key_presses' },
              total_clicks: { $sum: '$mouse_clicks' },
              count:        { $sum: 1 }
          }}
        ]);
        const lt = stats[0] || {};
        const appSecs = {};
        const appRows = await Report.aggregate([
          { $match: reportFilter },
          { $group: { _id: '$active_app', sec: { $sum: '$time_active_sec' } } },
          { $sort: { sec: -1 } },
          { $limit: 5 }
        ]);
        const topApps = appRows.map(r => `  - ${r._id || 'Unknown'}: ${Math.round(r.sec/60)}m`).join('\n');

        context = `FOCUS USER: ${user_id} (@ ${company_id})
DESIGNATION: ${designation || 'Not specified'}
PERIOD: All time (${lt.count || 0} total reports)

── LIFETIME TOTALS ──
Active time  : ${Math.floor((lt.total_active||0)/3600)}h ${Math.floor(((lt.total_active||0)%3600)/60)}m
Idle time    : ${Math.floor((lt.total_idle||0)/3600)}h ${Math.floor(((lt.total_idle||0)%3600)/60)}m
Keyboard     : ${lt.total_keys || 0} key presses
Mouse clicks : ${lt.total_clicks || 0}

── TOP APPS (all time) ──
${topApps || 'N/A'}`;
      }
    } else {
      // Global / company-wide summary
      const rows = await Report.aggregate([
        { $group: {
            _id: '$user_id',
            reports:     { $sum: 1 },
            active_sec:  { $sum: '$time_active_sec' },
            total_keys:  { $sum: '$keyboard_key_presses' },
            total_clicks:{ $sum: '$mouse_clicks' }
        }},
        { $sort: { active_sec: -1 } },
        { $limit: 10 }
      ]);

      context = `GLOBAL COMPANY ANALYSIS (All Users):
${rows.map(r =>
  `  - ${r._id}: ${r.reports} reports | ${Math.floor(r.active_sec/3600)}h ${Math.floor((r.active_sec%3600)/60)}m active | ${r.total_keys} keys | ${r.total_clicks} clicks`
).join('\n')}`;
    }

    // ── Query LLM ──────────────────────────────────────────────────────────
    const llmBody = {
      model: 'meta/llama-3.1-70b-instruct',
      messages: [
        {
          role: 'system',
          content: `You are a precise employee performance analyst.
Rules:
1. Answer ONLY from the CONTEXT DATA below — never invent numbers.
2. Use the COMPUTED TOTALS directly; do not re-calculate or estimate.
3. When asked "how many hours did they work", the answer is NET WORK TIME from the WORK SESSIONS section. Do NOT use Work Span (it includes break gaps). Do NOT use Keyboard/Mouse active time (that is only input seconds, not hours worked).
4. Format answers with bold headers and bullet points.
5. Keep answers concise and factual.
6. If someone greets you (hi, heya, hello, hey, etc.) just respond warmly and ask what employee/date they'd like to check — do not output employee data.

CONTEXT DATA:
${context}`
        },
        { role: 'user', content: message }
      ],
      temperature: 0.2,
      max_tokens: 768
    };

    const response = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${NV_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(llmBody)
    });

    const data = await response.json();
    if (!data.choices?.[0]?.message?.content) {
      console.error('LLM bad response:', JSON.stringify(data).slice(0, 400));
      return res.status(502).json({ error: 'LLM returned an unexpected response.' });
    }
    res.json({ answer: data.choices[0].message.content });

  } catch (err) {
    console.error('Chat error:', err);
    res.status(500).json({ error: 'Failed to generate AI response.' });
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

    const day = buildDayBounds(targetDate, timezoneOffsetMinutes);

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
      const cachedTimezoneOffset = Number(cached?.metadata?.timezone_offset ?? 0);
      const timezoneMatches = cachedTimezoneOffset === timezoneOffsetMinutes;
      const cachedUpdatedAt = new Date(cached?.metadata?.last_updated || cached.updatedAt || 0);
      const latestLogAt = latestDayEventAt ? new Date(latestDayEventAt) : null;
      const isFresh = !latestLogAt || cachedUpdatedAt >= latestLogAt;

      if (isFresh && timezoneMatches) {
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

    const uniqueLogs = dedupeReportsBySignature(logs);

    if (uniqueLogs.length === 0) {
      return res.json({ summary: `No activity logs found for ${targetDate}.`, cached: false });
    }

    const summaryContent = buildDeterministicDailySummary({
      companyId: compId,
      userId,
      designation,
      reports: uniqueLogs,
      targetDate,
      timezoneOffsetMinutes
    });

    const charactersAnalyzed = uniqueLogs.reduce((acc, l) => acc + (l.ocr_text || "").length, 0);

    // 4. Update Cache
    await Summary.findOneAndUpdate(
      { company_id: compId, user_id: userId, date: targetDate },
      {
        content: summaryContent,
        metadata: {
          characters_processed: charactersAnalyzed,
          last_updated: new Date(),
          generated_by: 'deterministic-summary',
          timezone_offset: timezoneOffsetMinutes
        }
      },
      { upsert: true, new: true }
    );

    res.json({ summary: summaryContent, cached: false, analyzed: charactersAnalyzed });

  } catch (err) {
    console.error("Summary error:", err);
    res.status(500).json({ error: "Failed to generate summary." });
  }
});

// Admin: force-delete a user — sets is_decommissioned immediately (no prior request needed),
// purges all cloud data, and lets the monitor self-destruct on its next 5-second poll.
app.post('/api/admin/force-delete-user', requireAdminAuth, async (req, res) => {
  try {
    const { company_id, user_id } = req.body;
    if (!company_id || !user_id) {
      return res.status(400).json({ error: 'Missing company_id or user_id.' });
    }

    // 1. Purge all data rows immediately so the dashboard is clean at once.
    const purgeCounts = await purgeTrackerArtifacts(company_id, user_id, { removeTrackingStatus: false });

    // 2. Mark decommissioned so the next monitor poll triggers self-destruct on the PC.
    //    Keep the TrackingStatus row alive until the monitor calls /api/tracker/confirm-deletion.
    await TrackingStatus.findOneAndUpdate(
      { company_id, user_id },
      {
        $set: {
          is_decommissioned: true,
          is_tracking_active: false,
          decommission_requested_at: new Date(),
          uninstall_requested_at: null,
          last_updated_by: 'admin-force-delete'
        }
      },
      { upsert: true, new: true }
    );

    const lastSeen = await TrackingStatus.findOne({ company_id, user_id }, 'last_seen_at').lean();
    const staleCutoffMs = 5 * 60 * 1000;
    const offlineWarning = !lastSeen?.last_seen_at ||
      (Date.now() - new Date(lastSeen.last_seen_at).getTime()) > staleCutoffMs
      ? 'Device has not checked in recently. Files will be deleted the next time the monitor comes online.'
      : 'Device is online — files will be deleted within ~5 seconds.';

    console.log(`[Admin] FORCE-DELETED ${user_id} @ ${company_id} — purge: ${JSON.stringify(purgeCounts)}`);
    res.json({ message: 'User data purged and device marked for deletion.', offlineWarning, purgeCounts });
  } catch (error) {
    console.error('[-] Error force-deleting user:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Admin: push an update to all trackers, a specific company, or a single user
app.post('/api/admin/push-update', requireAdminAuth, async (req, res) => {
  try {
    const { version, company_id, user_id } = req.body;
    if (!version || typeof version !== 'string' || !version.trim()) {
      return res.status(400).json({ error: 'Missing version string.' });
    }

    const filter = { is_decommissioned: { $ne: true } };
    if (company_id) filter.company_id = String(company_id).trim();
    if (user_id) filter.user_id = String(user_id).trim();
    const result = await TrackingStatus.updateMany(filter, {
      $set: {
        'pending_update.version': String(version).trim(),
        'pending_update.issued_at': new Date(),
        'pending_update.confirmed_at': null,
        last_updated_by: 'admin-push-update'
      }
    });

    console.log(`[Admin] Pushed update v${version} to ${result.modifiedCount} tracker(s).`);
    res.json({
      message: `Update v${version} queued for ${result.modifiedCount} tracker(s).`,
      matched: result.matchedCount,
      modified: result.modifiedCount
    });
  } catch (error) {
    console.error('[-] Error pushing update:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Admin: cancel a pending update — supports company_id only, user_id only, or both
app.post('/api/admin/cancel-update', requireAdminAuth, async (req, res) => {
  try {
    const { company_id, user_id } = req.body;
    const filter = {};
    if (company_id) filter.company_id = String(company_id).trim();
    if (user_id)    filter.user_id    = String(user_id).trim();
    const result = await TrackingStatus.updateMany(filter, {
      $set: {
        'pending_update.version': null,
        'pending_update.issued_at': null,
        'pending_update.confirmed_at': null,
        last_updated_by: 'admin-cancel-update'
      }
    });
    res.json({ message: `Update cancelled for ${result.modifiedCount} tracker(s).`, modified: result.modifiedCount });
  } catch (error) {
    console.error('[-] Error cancelling update:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Admin: fully erase a decommissioned phantom record (removes TrackingStatus too)
app.post('/api/admin/erase-user', requireAdminAuth, async (req, res) => {
  try {
    const { company_id, user_id } = req.body;
    if (!company_id || !user_id) {
      return res.status(400).json({ error: 'Missing company_id or user_id.' });
    }
    const counts = await purgeTrackerArtifacts(String(company_id).trim(), String(user_id).trim(), { removeTrackingStatus: true });
    console.log(`[Admin] ERASED record for ${user_id} @ ${company_id} — ${JSON.stringify(counts)}`);
    res.json({ ok: true, counts });
  } catch (error) {
    console.error('[-] Error erasing user:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Tracker: confirm a successful self-update (clears the pending flag for this device)
app.post('/api/tracker/confirm-update', async (req, res) => {
  try {
    let { company_id, user_id, device_id, install_id, version } = req.body || {};
    company_id = normalizeIdentity(company_id);
    user_id = normalizeIdentity(user_id);

    if (!company_id || !user_id) {
      const profile = await resolveSetupProfile({
        installId: normalizeIdentity(install_id),
        deviceId: normalizeIdentity(device_id)
      });
      if (profile) {
        company_id = company_id || normalizeIdentity(profile.company_id);
        user_id = user_id || normalizeIdentity(profile.user_id);
      }
    }

    if (!company_id || !user_id) {
      return res.status(400).json({ error: 'Missing company_id or user_id.' });
    }

    await TrackingStatus.findOneAndUpdate(
      { company_id, user_id },
      {
        $set: {
          'pending_update.confirmed_at': new Date(),
          last_updated_by: 'tracker-confirm-update'
        }
      }
    );

    console.log(`[Tracker] Update v${version || '?'} confirmed by ${user_id} @ ${company_id}`);
    res.json({ ok: true });
  } catch (error) {
    console.error('[-] Error confirming update:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Start Server
app.listen(PORT, () => {
  console.log(`\n================================`);
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`   Database URL: ${MONGO_URI}`);
  console.log(`================================\n`);
});
