@echo off
REM ============================================================================
REM  BATCH DEPLOYMENT TO MULTIPLE COMPUTERS
REM  Copies the configured folder and runs setup on remote machines
REM ============================================================================
setlocal enabledelayedexpansion
pushd "%~dp0"

cls
echo.
echo ============================================================================
echo  DEPLOY TO MULTIPLE COMPUTERS
echo ============================================================================
echo.
echo This script helps deploy to multiple computers using one of these methods:
echo   1. Copy to USB drive (manual transfer to each PC)
echo   2. Network share deployment (if on same network)
echo   3. Print instructions for manual setup
echo.
set /p METHOD="Select method (1/2/3): "

if "%METHOD%"=="1" (
    call :deploy_usb
) else if "%METHOD%"=="2" (
    call :deploy_network
) else if "%METHOD%"=="3" (
    call :deploy_manual
) else (
    echo Invalid selection
    pause
    exit /b 1
)

popd
endlocal
pause
exit /b 0

REM ============================================================================
REM  METHOD 1: USB DEPLOYMENT PREPARATION
REM ============================================================================
:deploy_usb
echo.
echo ============================================================================
echo PREPARING FOR USB DEPLOYMENT
echo ============================================================================
echo.
echo This will create a zip file ready for USB transfer.
echo.

set /p USBDRIVE="Enter USB drive letter (e.g., E): "
set USBPATH=%USBDRIVE%:\EmployeeMonitor

echo [*] Checking USB drive %USBDRIVE%:
if not exist "%USBDRIVE%:\" (
    echo [ERROR] USB drive %USBDRIVE%: not found
    exit /b 1
)

echo [*] Creating deployment folder...
if exist "%USBPATH%" rmdir /s /q "%USBPATH%" 2>nul
mkdir "%USBPATH%"

echo [*] Copying files...
robocopy "%~dp0" "%USBPATH%" /E /XD .git __pycache__ activity_data .vscode ^
    /XF ".git*" "*.log" ".env" ".pyc" "*.tmp" >nul 2>&1

echo [*] Creating README for USB...
(
    echo EMPLOYEE MONITOR - QUICK SETUP
    echo ===============================
    echo.
    echo 1. Copy entire EmployeeMonitor folder to target computer
    echo    (e.g., C:\EmployeeMonitor or C:\Users\Public\Monitor)
    echo.
    echo 2. On target computer, run:
    echo    deploy_automated.bat
    echo.
    echo 3. Follow on-screen instructions
    echo    (Takes 10-15 minutes on first installation)
    echo.
    echo 4. Restart computer when prompted
    echo.
    echo 5. Monitor will start automatically on login
    echo.
    echo For help, see:
    echo  - README.md
    echo  - DEPLOYMENT_GUIDE.md
    echo.
) > "%USBPATH%\USB_SETUP_INSTRUCTIONS.txt"

echo [OK] USB deployment package ready at: %USBPATH%
echo [*] Copy this folder to other computers
echo [*] On target computer, run: deploy_automated.bat
goto :eof

REM ============================================================================
REM  METHOD 2: NETWORK DEPLOYMENT
REM ============================================================================
:deploy_network
echo.
echo ============================================================================
echo NETWORK DEPLOYMENT
echo ============================================================================
echo.

set /p NETWORKPATH="Enter network share path (e.g., \\SERVER\Share): "

echo [*] Checking network path %NETWORKPATH%...
if not exist "%NETWORKPATH%" (
    echo [ERROR] Network path not accessible
    exit /b 1
)

set NETDEPLOY=%NETWORKPATH%\EmployeeMonitor_%COMPUTERNAME%_%DATE%

echo [*] Creating network deployment folder...
mkdir "%NETDEPLOY%" 2>nul

echo [*] Copying files to network...
robocopy "%~dp0" "%NETDEPLOY%" /E /XD .git __pycache__ activity_data .vscode ^
    /XF ".git*" "*.log" ".env" ".pyc" "*.tmp" >nul 2>&1

echo [OK] Files copied to: %NETDEPLOY%
echo.
echo On target computers, run:
echo   net use Z: %NETWORKPATH%
echo   Z:\EmployeeMonitor_%COMPUTERNAME%_%DATE%\deploy_automated.bat
echo.
goto :eof

REM ============================================================================
REM  METHOD 3: MANUAL INSTRUCTIONS
REM ============================================================================
:deploy_manual
echo.
echo ============================================================================
echo MANUAL DEPLOYMENT INSTRUCTIONS
echo ============================================================================
echo.
echo For each target computer:
echo.
echo STEP 1: PREPARE
echo   1. Create folder: C:\EmployeeMonitor
echo   2. Copy all files from source computer to C:\EmployeeMonitor
echo      (Or extract provided zip file)
echo   3. Delete activity_data\ folder (if it exists)
echo.
echo STEP 2: INSTALL
echo   1. On target computer, open Command Prompt as Administrator
echo   2. Navigate to C:\EmployeeMonitor
echo   3. Run: deploy_automated.bat
echo   4. Wait for completion (10-15 minutes first time)
echo.
echo STEP 3: VERIFY
echo   1. Run: python verify_tesseract.py
echo   2. Run: python verify_autostart.py
echo   3. Both should show mostly PASS results
echo.
echo STEP 4: TEST AUTOSTART
echo   1. Restart the computer
echo   2. After login, wait 10 seconds
echo   3. Check if monitor is running (should see python.exe in Task Manager)
echo   4. Check logs: C:\EmployeeMonitor\activity_data\activity_monitor.log
echo.
echo STEP 5: ONBOARDING (if needed)
echo   1. Monitor will show onboarding screen on first run
echo   2. Fill in employee information
echo   3. Monitor starts tracking automatically
echo.
echo For troubleshooting, see:
echo   - DEPLOYMENT_GUIDE.md
echo   - QUICK_START.py
echo.
goto :eof
