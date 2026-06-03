@echo off
setlocal EnableExtensions
pushd "%~dp0"

echo ====================================
echo Employee Monitor Automated Bootstrap
echo ====================================
echo.

set "PACKAGE_ROOT=%~dp0"
set "BACKEND_URL=https://eyeing.onrender.com"

if exist "%PACKAGE_ROOT%backend_url.txt" (
    for /f "usebackq delims=" %%i in ("%PACKAGE_ROOT%backend_url.txt") do (
        if not "%%i"=="" set "BACKEND_URL=%%i"
    )
)

if "%INSTALL_ID%"=="" set "INSTALL_ID=%RANDOM%%RANDOM%%RANDOM%"
if "%DEVICE_ID%"=="" set "DEVICE_ID=%COMPUTERNAME%"

echo [BOOT] Using backend: %BACKEND_URL%
echo [BOOT] Starting local installer...
echo.

if not exist "%PACKAGE_ROOT%install.bat" (
    echo [ERROR] install.bat not found in this folder.
    popd
    endlocal
    exit /b 1
)

call "%PACKAGE_ROOT%install.bat"
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
    echo.
    echo [ERROR] Automated bootstrap failed with exit code %EXIT_CODE%.
    popd
    endlocal
    exit /b %EXIT_CODE%
)

popd
endlocal
exit /b 0