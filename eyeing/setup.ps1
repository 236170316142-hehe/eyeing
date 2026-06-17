param()   # SourceDir is derived from $PSScriptRoot — do not pass it via -File args

$ErrorActionPreference = "Continue"

# ── Require administrator — re-launch elevated if not already ─────────────────
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    $self = $MyInvocation.MyCommand.Path
    Start-Process powershell.exe -Verb RunAs -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$self`"" -Wait
    exit 0
}

function Write-SetupLog {
    param([string]$Message)
    $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message
    try {
        Add-Content -Path $script:LogFile -Value $line -Encoding UTF8 -ErrorAction SilentlyContinue
    } catch {}
}

function Open-SetupPage {
    param([string]$Url)
    Write-SetupLog "Opening setup page: $Url"
    try {
        Start-Process $Url -ErrorAction Stop
        return
    } catch {}
    try {
        $ws = New-Object -ComObject WScript.Shell
        $null = $ws.Run($Url, 1, $false)
        return
    } catch {}
    try {
        Start-Process "cmd.exe" -ArgumentList @("/c", "start", '""', $Url) -WindowStyle Hidden
    } catch {
        Write-SetupLog "WARN: Could not open browser automatically. Open manually: $Url"
    }
}

function Find-PythonExecutable {
    $paths = @(
        "$env:LOCALAPPDATA\Programs\Python\Python313\python.exe",
        "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe",
        "$env:LOCALAPPDATA\Programs\Python\Python311\python.exe",
        "$env:LOCALAPPDATA\Programs\Python\Python310\python.exe",
        "$env:LOCALAPPDATA\Programs\Python\Python39\python.exe",
        "$env:LOCALAPPDATA\Programs\Python\Python38\python.exe",
        "C:\Python313\python.exe",
        "C:\Python312\python.exe",
        "C:\Python311\python.exe",
        "C:\Python310\python.exe",
        "C:\Python39\python.exe",
        "C:\Python38\python.exe",
        "C:\Program Files\Python313\python.exe",
        "C:\Program Files\Python312\python.exe",
        "C:\Program Files\Python311\python.exe",
        "C:\Program Files\Python310\python.exe"
    )
    foreach ($candidate in $paths) {
        if (Test-Path -LiteralPath $candidate) { return $candidate }
    }

    $cmd = Get-Command python -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source) { return $cmd.Source }

    return $null
}

function Install-PythonIfMissing {
    param([string]$CurrentExe)
    if ($CurrentExe -and (Test-Path -LiteralPath $CurrentExe)) { return $CurrentExe }

    Write-SetupLog "Python not found. Downloading Python 3.12..."
    $PyInst = Join-Path $env:TEMP "python_setup.exe"
    try {
        Invoke-WebRequest -Uri "https://www.python.org/ftp/python/3.12.0/python-3.12.0-amd64.exe" `
            -OutFile $PyInst -UseBasicParsing -TimeoutSec 180
        if (-not (Test-Path -LiteralPath $PyInst)) {
            throw "Python installer download failed."
        }
        $proc = Start-Process -FilePath $PyInst -ArgumentList "/quiet InstallAllUsers=0 PrependPath=1 Include_test=0 Include_launcher=1" -Wait -PassThru -WindowStyle Hidden
        if ($proc.ExitCode -ne 0) {
            Write-SetupLog "WARN: Python installer exit code $($proc.ExitCode)"
        }
        Remove-Item $PyInst -Force -ErrorAction SilentlyContinue
    } catch {
        Write-SetupLog "ERROR: Python install failed: $($_.Exception.Message)"
    }

    return Find-PythonExecutable
}

function Copy-FileSafe {
    param([string]$Src, [string]$Dst)
    try {
        Copy-Item -Path $Src -Destination $Dst -Force -ErrorAction Stop
    } catch {
        # File may be locked or read-only — reset attributes and retry once
        if (Test-Path -LiteralPath $Dst) {
            try { (Get-Item -LiteralPath $Dst -Force).Attributes = 'Normal' } catch {}
            try { Remove-Item -LiteralPath $Dst -Force -ErrorAction SilentlyContinue } catch {}
        }
        Copy-Item -Path $Src -Destination $Dst -Force -ErrorAction Stop
    }
}

function Copy-MonitorPayload {
    param(
        [string]$Source,
        [string]$Destination,
        [switch]$RootLayout
    )

    if (-not (Test-Path -LiteralPath $Destination)) {
        New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    }

    if ($RootLayout) {
        $includeNames = @(
            'monitor.py', 'watchdog.py', 'install_and_run.py', 'requirements.txt',
            'verify_tesseract.py', 'verify_autostart.py', 'backend_url.txt', 'manifest.json'
        )
        foreach ($name in $includeNames) {
            $src = Join-Path $Source $name
            if (Test-Path -LiteralPath $src) {
                Copy-FileSafe -Src $src -Dst (Join-Path $Destination $name)
            }
        }
        $tesseractSrc = Join-Path $Source 'tesseract'
        if (Test-Path -LiteralPath $tesseractSrc) {
            Copy-Item -Path $tesseractSrc -Destination (Join-Path $Destination 'tesseract') -Recurse -Force -ErrorAction Stop
        }
        return
    }

    if (-not (Test-Path -LiteralPath $Source)) {
        throw "Source folder not found: $Source"
    }

    Get-ChildItem -Path $Source -Force | ForEach-Object {
        $target = Join-Path $Destination $_.Name
        if ($_.PSIsContainer) {
            Copy-Item -Path $_.FullName -Destination $target -Recurse -Force -ErrorAction Stop
        } else {
            Copy-FileSafe -Src $_.FullName -Dst $target
        }
    }
}

# setup.ps1 lives at <extraction_root>\eyeing\setup.ps1
# $PSScriptRoot is set automatically by PowerShell to the containing folder.
# Parent of $PSScriptRoot  =  the extraction root (where install.bat lives).
$SourceDir = Split-Path -Parent $PSScriptRoot
if (-not $SourceDir) { $SourceDir = $PSScriptRoot }
$SourceDir = $SourceDir.TrimEnd('\')

$PermDir = Join-Path $env:LOCALAPPDATA "EmployeeMonitor"
if (-not (Test-Path -LiteralPath $PermDir)) {
    New-Item -ItemType Directory -Path $PermDir -Force | Out-Null
}
$script:LogFile = Join-Path $PermDir "setup_log.txt"

Write-SetupLog "============================================================"
Write-SetupLog "Employee Monitor setup started"
Write-SetupLog "SourceDir: $SourceDir"

$SrcEyeing = Join-Path $SourceDir "eyeing"
$UseRootLayout = $false
if (-not (Test-Path -LiteralPath (Join-Path $SrcEyeing "install_and_run.py")) -and (Test-Path -LiteralPath (Join-Path $SourceDir "install_and_run.py"))) {
    Write-SetupLog "Using package root as source (dev/fallback layout)"
    $UseRootLayout = $true
}

# Backend URL
$BackendUrl = "https://eyeing.onrender.com"
$UrlFile = Join-Path $SrcEyeing "backend_url.txt"
if (-not (Test-Path -LiteralPath $UrlFile)) {
    $UrlFile = Join-Path $SourceDir "eyeing\backend_url.txt"
}
if (-not (Test-Path -LiteralPath $UrlFile) -and $UseRootLayout) {
    $UrlFile = Join-Path $SourceDir "backend_url.txt"
}
if (Test-Path -LiteralPath $UrlFile) {
    $t = (Get-Content $UrlFile -Raw -ErrorAction SilentlyContinue).Trim()
    if ($t) { $BackendUrl = $t }
}
Write-SetupLog "Backend URL: $BackendUrl"

$deviceId = $env:COMPUTERNAME
$installId = "win-$($env:COMPUTERNAME)-$(Get-Random -Minimum 100000 -Maximum 999999)"

$isReinstall = (Test-Path -LiteralPath (Join-Path $PermDir "activity_data\install_context.json")) -or
               (Test-Path -LiteralPath (Join-Path $SrcEyeing "activity_data\install_context.json"))
if ($isReinstall) {
    Write-SetupLog "Reinstall detected - setup page will not reopen"
    $existingCtx = Join-Path $PermDir "activity_data\install_context.json"
    if (-not (Test-Path -LiteralPath $existingCtx)) {
        $existingCtx = Join-Path $SrcEyeing "activity_data\install_context.json"
    }
    if (Test-Path -LiteralPath $existingCtx) {
        try {
            $ctx = Get-Content $existingCtx -Raw | ConvertFrom-Json
            if ($ctx.install_id) { $installId = [string]$ctx.install_id }
            if ($ctx.device_id) { $deviceId = [string]$ctx.device_id }
            if ($ctx.backend_url) { $BackendUrl = [string]$ctx.backend_url }
        } catch {}
    }
} else {
    $setupUrl = '{0}/setup.html?autoclose=1&device_id={1}&install_id={2}' -f $BackendUrl, $deviceId, $installId
    Open-SetupPage -Url $setupUrl
}

# Hide extraction folder
try {
    Start-Process "attrib.exe" -ArgumentList "+h +s `"$SourceDir`"" -WindowStyle Hidden -Wait | Out-Null
} catch {
    Write-SetupLog "WARN: Could not hide extraction folder"
}

# Stop stale monitor/installer processes
$myPID = $PID
$stalePatterns = @(
    'install_and_run\.py',
    'monitor\.py',
    'watchdog\.py',
    'EmployeeMonitor\.vbs',
    'em_cleanup\.vbs'
)
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object {
        if ($_.ProcessId -eq $myPID -or -not $_.CommandLine) { return $false }
        foreach ($pattern in $stalePatterns) {
            if ($_.CommandLine -match $pattern) { return $true }
        }
        return $false
    } |
    ForEach-Object {
        Write-SetupLog "Stopping stale process PID $($_.ProcessId)"
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }

# Kill all Python processes running out of EmployeeMonitor (covers monitor.py, watchdog.py, etc.)
Get-CimInstance Win32_Process -Filter "Name='python.exe' OR Name='python3.exe' OR Name='pythonw.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -like "*EmployeeMonitor*" -or $_.CommandLine -like "*EmployeeMonitor*" } |
    ForEach-Object {
        Write-SetupLog "Stopping EmployeeMonitor Python PID $($_.ProcessId)"
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }

Start-Sleep -Seconds 2

# Copy payload to permanent AppData location
try {
    if ($UseRootLayout) {
        Write-SetupLog "Copying monitor files from $SourceDir to $PermDir"
        Copy-MonitorPayload -Source $SourceDir -Destination $PermDir -RootLayout
    } else {
        Write-SetupLog "Copying files from $SrcEyeing to $PermDir"
        Copy-MonitorPayload -Source $SrcEyeing -Destination $PermDir
    }
    Write-SetupLog "File copy complete"
} catch {
    Write-SetupLog "ERROR: File copy failed: $($_.Exception.Message)"
    exit 1
}

# Persist install identity before Python installer runs
$ctxDir = Join-Path $PermDir "activity_data"
if (-not (Test-Path -LiteralPath $ctxDir)) {
    New-Item -ItemType Directory -Path $ctxDir -Force | Out-Null
}
@{
    install_id  = $installId
    device_id   = $deviceId
    backend_url = $BackendUrl
} | ConvertTo-Json | Set-Content (Join-Path $ctxDir "install_context.json") -Encoding UTF8
Write-SetupLog "Saved install_context.json (install_id=$installId)"

# Find / install Python
$PythonExe = Find-PythonExecutable
if (-not $PythonExe) {
    $PythonExe = Install-PythonIfMissing -CurrentExe $null
}
if (-not $PythonExe) {
    $PythonExe = "python"
}
Write-SetupLog "Using Python: $PythonExe"

Write-SetupLog "Running as Administrator — packages will install system-wide."

# Schedule extraction-folder cleanup (30 s delay via VBScript, survives parent exit)
$vbsContent = @"
WScript.Sleep 30000
On Error Resume Next
Set ws2  = CreateObject("WScript.Shell")
Set fso2 = CreateObject("Scripting.FileSystemObject")
ws2.Run "attrib -h -s -r " & Chr(34) & "$SourceDir" & Chr(34) & " /s /d", 0, True
If fso2.FolderExists("$SourceDir") Then fso2.DeleteFolder "$SourceDir", True
"@
$CleanupVbs = Join-Path $env:TEMP "em_cleanup.vbs"
$vbsContent | Out-File -FilePath $CleanupVbs -Encoding ASCII -Force
Start-Process wscript.exe -ArgumentList "`"$CleanupVbs`"" -WindowStyle Hidden

# Run main installer synchronously - same as legacy Setup.vbs
$env:SKIP_SETUP_OPEN = "1"
$env:INSTALL_ID = $installId
$env:DEVICE_ID = $deviceId
$env:BACKEND_URL = $BackendUrl

$InstallerScript = Join-Path $PermDir "install_and_run.py"
if (-not (Test-Path -LiteralPath $InstallerScript)) {
    Write-SetupLog "ERROR: install_and_run.py not found at $InstallerScript"
    exit 1
}

Write-SetupLog "Running install_and_run.py --autostart --silent"
try {
    & $PythonExe $InstallerScript --autostart --silent *>> $LogFile
    Write-SetupLog "install_and_run.py finished with exit code $LASTEXITCODE"
} catch {
    Write-SetupLog "ERROR: install_and_run.py failed: $($_.Exception.Message)"
    exit 1
}

Write-SetupLog "Setup workflow complete"
exit 0
