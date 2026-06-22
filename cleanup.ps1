# EmployeeMonitor full cleanup - kills process, removes tasks, deletes folder, then self-deletes

Write-Host "Step 1: Killing running monitor process..."
Get-Process pythonw -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 500

Write-Host "Step 2: Removing scheduled tasks..."
Unregister-ScheduledTask -TaskName "EmployeeMonitorWatchdog"  -Confirm:$false -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName "EmployeeMonitorAutoStart" -Confirm:$false -ErrorAction SilentlyContinue

Write-Host "Step 3: Clearing hidden/system/read-only flags..."
attrib -r -s -h "$env:LOCALAPPDATA\EmployeeMonitor" /s /d

Write-Host "Step 4: Deleting EmployeeMonitor folder..."
Remove-Item "$env:LOCALAPPDATA\EmployeeMonitor" -Recurse -Force -ErrorAction SilentlyContinue

Write-Host "Step 5: Verifying removal..."
if (Test-Path "$env:LOCALAPPDATA\EmployeeMonitor") {
    Write-Host "WARNING: Folder still exists - may need elevated permissions." -ForegroundColor Yellow
} else {
    Write-Host "Folder deleted successfully." -ForegroundColor Green
}

$tasks = Get-ScheduledTask -TaskName "*EmployeeMonitor*" -ErrorAction SilentlyContinue
if ($tasks) {
    Write-Host "WARNING: Scheduled tasks still present." -ForegroundColor Yellow
} else {
    Write-Host "Scheduled tasks removed successfully." -ForegroundColor Green
}

$proc = Get-Process pythonw -ErrorAction SilentlyContinue
if ($proc) {
    Write-Host "WARNING: pythonw still running." -ForegroundColor Yellow
} else {
    Write-Host "No monitor process running." -ForegroundColor Green
}

# Self-delete via a temp batch file to avoid the & operator issue in ArgumentList
$self = $MyInvocation.MyCommand.Path
if ($self) {
    Write-Host "Self-deleting script..."
    $tempBat = [System.IO.Path]::GetTempFileName() + ".bat"
    $lines = "@echo off", "timeout /t 2 /nobreak >nul", "del /f /q `"$self`"", "del /f /q `"%~f0`""
    [System.IO.File]::WriteAllLines($tempBat, $lines, [System.Text.Encoding]::ASCII)
    Start-Process "cmd.exe" -ArgumentList "/c `"$tempBat`"" -WindowStyle Hidden
}

Write-Host "Done."
