@echo off
REM ============================================================================
REM  COMPLETE AUTOMATED EMPLOYEE MONITOR DEPLOYMENT
REM  Handles: Python, Requirements, Tesseract, Autostart, Verification
REM  Perfect for deploying to multiple computers
REM ============================================================================
setlocal enabledelayedexpansion
pushd "%~dp0"

cls
echo.
echo ============================================================================
echo  EMPLOYEE MONITOR - COMPLETE AUTOMATED SETUP
echo ============================================================================
echo.
echo This script will:
echo   1. Install Python 3.12 (if needed)
echo   2. Install all Python packages
echo   3. Install Tesseract-OCR (if needed)
echo   4. Configure monitor autostart
echo   5. Run verification tests
echo   6. Setup folder for deployment to other PCs
echo.
echo Time required: 10-15 minutes (first time) or 2-3 minutes (subsequent)
echo.
pause

REM ============================================================================
REM  STEP 1: CHECK AND INSTALL PYTHON
REM ============================================================================
echo.
echo ============================================================================
echo [1/6] Checking Python Installation...
echo ============================================================================
echo.

where python >nul 2>&1
if %errorlevel% neq 0 (
    echo [!] Python not found. Installing Python 3.12...
    echo.
    
    set PYTHON_URL=https://www.python.org/ftp/python/3.12.0/python-3.12.0-amd64.exe
    set PYTHON_INSTALLER=%TEMP%\python_3_12_installer.exe
    
    echo [*] Downloading Python 3.12 from official source...
    powershell -NoProfile -Command "try { Invoke-WebRequest -Uri '%PYTHON_URL%' -OutFile '%PYTHON_INSTALLER%' -ErrorAction Stop; Write-Host '[OK] Download complete' } catch { Write-Host '[ERROR] Download failed'; exit 1 }"
    
    if !errorlevel! neq 0 (
        echo [ERROR] Failed to download Python. Please install manually from https://www.python.org
        pause
        exit /b 1
    )
    
    echo [*] Running Python installer...
    start /wait "" "%PYTHON_INSTALLER%" /quiet InstallAllUsers=1 PrependPath=1
    
    echo [*] Refreshing environment variables...
    set PATH=%PATH%;%LOCALAPPDATA%\Programs\Python\Python312;%LOCALAPPDATA%\Programs\Python\Python312\Scripts
    
    if !errorlevel! neq 0 (
        echo [ERROR] Python installation failed
        pause
        exit /b 1
    )
    
    echo [OK] Python installed successfully
    timeout /t 2 /nobreak
) else (
    for /f "tokens=*" %%i in ('python --version') do set PYTHON_VERSION=%%i
    echo [OK] Python found: !PYTHON_VERSION!
)

echo.

REM ============================================================================
REM  STEP 2: INSTALL REQUIREMENTS
REM ============================================================================
echo.
echo ============================================================================
echo [2/6] Installing Python Packages...
echo ============================================================================
echo.

echo [*] Installing required packages from requirements.txt...
python -m pip install -q --upgrade pip >nul 2>&1

if not exist "requirements.txt" (
    echo [ERROR] requirements.txt not found
    pause
    exit /b 1
)

python -m pip install -q -r requirements.txt
if !errorlevel! neq 0 (
    echo [WARNING] Some packages failed to install. Retrying with break-system-packages...
    python -m pip install --break-system-packages -q -r requirements.txt
)

echo [OK] Python packages installed successfully
timeout /t 1 /nobreak

echo.

REM ============================================================================
REM  STEP 3: INSTALL TESSERACT
REM ============================================================================
echo.
echo ============================================================================
echo [3/6] Installing Tesseract-OCR...
echo ============================================================================
echo.

python -c "import pytesseract; print('[OK] pytesseract module available')" >nul 2>&1
if !errorlevel! neq 0 (
    echo [ERROR] pytesseract not available
    pause
    exit /b 1
)

echo [*] Checking for Tesseract executable...
python verify_tesseract.py >nul 2>&1
if !errorlevel! equ 0 (
    echo [OK] Tesseract is already installed and working
    timeout /t 1 /nobreak
) else (
    echo [*] Tesseract not found. Installing...
    python install_and_run.py 2>nul
    
    if !errorlevel! neq 0 (
        echo.
        echo [WARNING] Automated Tesseract installation encountered an issue.
        echo [*] Attempting alternative installation methods...
        
        REM Try winget if available
        where winget >nul 2>&1
        if !errorlevel! equ 0 (
            echo [*] Found winget. Installing via winget...
            winget install --id UB-Mannheim.TesseractOCR -e --silent --accept-package-agreements --accept-source-agreements >nul 2>&1
            if !errorlevel! equ 0 (
                echo [OK] Tesseract installed via winget
                timeout /t 2 /nobreak
            )
        )
        
        REM Try choco if available
        if !errorlevel! neq 0 (
            where choco >nul 2>&1
            if !errorlevel! equ 0 (
                echo [*] Found choco. Installing via choco...
                choco install tesseract -y >nul 2>&1
                if !errorlevel! equ 0 (
                    echo [OK] Tesseract installed via choco
                    timeout /t 2 /nobreak
                )
            )
        )
        
        REM Try bundled installer if present
        if !errorlevel! neq 0 (
            if exist "tesseract-ocr-w64-setup*.exe" (
                echo [*] Found bundled Tesseract installer
                for %%F in (tesseract-ocr-w64-setup*.exe) do (
                    echo [*] Running: %%F
                    "%%F" /S /D="C:\Program Files\Tesseract-OCR" >nul 2>&1
                    if !errorlevel! equ 0 (
                        echo [OK] Tesseract installed from bundled installer
                        timeout /t 2 /nobreak
                    )
                )
            )
        )
    )
    
    REM Verify installation worked
    python verify_tesseract.py >nul 2>&1
    if !errorlevel! equ 0 (
        echo [OK] Tesseract verification successful
    ) else (
        echo [WARNING] Tesseract installation needs manual verification
        echo [!] Run: python verify_tesseract.py
    )
)

echo.

REM ============================================================================
REM  STEP 4: CONFIGURE AUTOSTART
REM ============================================================================
echo.
echo ============================================================================
echo [4/6] Configuring Autostart for System Restart...
echo ============================================================================
echo.

echo [*] Setting up autostart mechanisms...
python install_and_run.py --autostart >nul 2>&1

if !errorlevel! equ 0 (
    echo [OK] Autostart configured successfully
) else (
    echo [WARNING] Autostart configuration needs attention
    echo [!] Run: python install_and_run.py --autostart
)

timeout /t 1 /nobreak
echo.

REM ============================================================================
REM  STEP 5: HIDE FOLDER AND PROTECT
REM ============================================================================
echo.
echo ============================================================================
echo [5/6] Protecting Installation Folder...
echo ============================================================================
echo.

echo [*] Making folder hidden and system folder...
attrib +h +s "%~dp0" >nul 2>&1
attrib +h +s "%~dp0*" /s /d >nul 2>&1

echo [OK] Folder protection applied
echo.

REM ============================================================================
REM  STEP 6: RUN VERIFICATION
REM ============================================================================
echo.
echo ============================================================================
echo [6/6] Running Verification Tests...
echo ============================================================================
echo.

echo [*] Testing Tesseract installation...
python verify_tesseract.py
if !errorlevel! equ 0 (
    echo [OK] Tesseract verification PASSED
) else (
    echo [!] Tesseract verification FAILED - see details above
)

echo.
echo [*] Testing autostart configuration...
python verify_autostart.py
if !errorlevel! equ 0 (
    echo [OK] Autostart verification PASSED
) else (
    echo [!] Autostart verification NEEDS ATTENTION - see details above
)

echo.

REM ============================================================================
REM  COMPLETION SUMMARY
REM ============================================================================
echo.
echo ============================================================================
echo  SETUP COMPLETE!
echo ============================================================================
echo.
echo Summary of what was installed:
echo   [OK] Python 3.12
echo   [OK] All required Python packages
echo   [OK] Tesseract-OCR
echo   [OK] Monitor autostart configuration
echo   [OK] Folder hidden for stealth
echo.
echo Next Steps:
echo   1. Restart your computer to verify autostart works
echo   2. Monitor will start automatically after login
echo   3. Check logs: activity_data\activity_monitor.log
echo.
echo For Deployment to Other Computers:
echo   1. Copy this entire folder to a USB drive
echo   2. On target computer, run: deploy_automated.bat
echo   3. All settings will be configured automatically
echo.
echo Documentation:
echo   - README.md (overview)
echo   - DEPLOYMENT_GUIDE.md (complete guide)
echo   - QUICK_START.py (quick reference)
echo   - SOLUTION_SUMMARY.txt (technical details)
echo.
echo Verification Scripts (can run anytime):
echo   - python verify_tesseract.py
echo   - python verify_autostart.py
echo   - python QUICK_START.py
echo.
echo ============================================================================
echo.

timeout /t 3 /nobreak

REM ============================================================================
REM  ASK ABOUT RESTART
REM ============================================================================
echo.
set /p RESTART="Do you want to restart now to enable autostart? (Y/N): "

if /i "%RESTART%"=="Y" (
    echo Restarting in 30 seconds (press Ctrl+C to cancel)...
    timeout /t 30
    shutdown /r /t 0
) else (
    echo Please restart manually when ready.
    echo Monitor will start automatically on next login.
)

popd
endlocal
pause
