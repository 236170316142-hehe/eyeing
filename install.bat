@echo off
echo ====================================
echo Employee Monitor Bootstrap Installer
echo ====================================
echo.

where python >nul 2>&1
if %errorlevel% neq 0 (
    echo Python not found! Downloading and installing Python...
    echo (This may take a few minutes)
    echo.
    
    set PYTHON_URL=https://www.python.org/ftp/python/3.12.0/python-3.12.0-amd64.exe
    set PYTHON_INSTALLER=%TEMP%\python_installer.exe
    
    powershell -Command "Invoke-WebRequest -Uri '%PYTHON_URL%' -OutFile '%PYTHON_INSTALLER%'"
    
    start /wait "" "%PYTHON_INSTALLER%" /quiet InstallAllUsers=1 PrependPath=1
    
    echo Python installed! Refreshing environment...
    set PATH=%PATH%;%LOCALAPPDATA%\Programs\Python\Python312;%LOCALAPPDATA%\Programs\Python\Python312\Scripts
    echo.
)

echo Launching main installer...
set BACKEND_URL=http://localhost:3000
if exist backend_url.txt (
    for /f "usebackq delims=" %%i in ("backend_url.txt") do (
        if not "%%i"=="" set BACKEND_URL=%%i
    )
)

echo Opening web onboarding page...
start "" "%BACKEND_URL%/setup.html?autoclose=1^&runMonitor=1"

python install_and_run.py --autostart

pause
