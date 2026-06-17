@echo off
setlocal
pushd "%~dp0"

if not exist "%~dp0eyeing\setup.ps1" (
    echo [ERROR] Missing installer script: eyeing\setup.ps1
    echo Please re-download the Employee Monitor package and try again.
    pause
    exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0eyeing\setup.ps1" -SourceDir "%~dp0"
set EXITCODE=%ERRORLEVEL%

if not "%EXITCODE%"=="0" (
    echo.
    echo [ERROR] Setup failed. Check setup_log.txt in:
    echo   %LOCALAPPDATA%\EmployeeMonitor\setup_log.txt
    pause
    exit /b %EXITCODE%
)

popd
endlocal
