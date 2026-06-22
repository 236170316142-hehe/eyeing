@echo off

:: Self-elevate to admin if not already running as admin
net session >nul 2>&1
if %errorLevel% neq 0 (
    powershell -Command "Start-Process '%~f0' -Verb RunAs"
    exit /b
)

:: Run the cleanup PowerShell script
powershell -ExecutionPolicy Bypass -File "%~dp0cleanup.ps1"

:: Self-delete this bat file after PS1 runs
start /b "" cmd /c timeout /t 2 /nobreak >nul & del /f /q "%~f0"
