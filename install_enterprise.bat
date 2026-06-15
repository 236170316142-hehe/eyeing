@echo off
REM ============================================================================
REM  ENTERPRISE INSTALLER - Auto-detects Windows and configures the system
REM  Includes single-PC and multi-PC deployment options
REM ============================================================================
setlocal enabledelayedexpansion
pushd "%~dp0"

cls
echo.
echo ============================================================================
echo  EMPLOYEE MONITOR - ENTERPRISE INSTALLER
echo ============================================================================
echo.
echo Detected OS: Windows
echo.
echo This package supports Windows, macOS, and Linux.
echo On this Windows PC, choose how to proceed:
echo.
echo   1. Install on THIS computer (automated setup)
echo   2. Deploy to multiple Windows PCs (USB / network / manual)
echo   3. Advanced PowerShell multi-PC deployment
echo.
set /p CHOICE="Select option (1/2/3) [default 1]: "

if "%CHOICE%"=="" set CHOICE=1

if "%CHOICE%"=="1" (
    if exist "%~dp0deploy_automated.bat" (
        call "%~dp0deploy_automated.bat"
    ) else if exist "%~dp0install.bat" (
        call "%~dp0install.bat"
    ) else (
        echo [ERROR] No installer found in this folder.
        pause
        exit /b 1
    )
) else if "%CHOICE%"=="2" (
    if exist "%~dp0deploy_to_multiple_pcs.bat" (
        call "%~dp0deploy_to_multiple_pcs.bat"
    ) else (
        echo [ERROR] deploy_to_multiple_pcs.bat not found.
        pause
        exit /b 1
    )
) else if "%CHOICE%"=="3" (
    if exist "%~dp0deploy_powershell.bat" (
        call "%~dp0deploy_powershell.bat"
    ) else (
        echo [ERROR] deploy_powershell.bat not found.
        pause
        exit /b 1
    )
) else (
    echo Invalid selection.
    pause
    exit /b 1
)

popd
endlocal
