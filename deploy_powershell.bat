@echo off
REM ============================================================================
REM  AUTOMATED DEPLOYMENT VIA POWERSHELL (ADVANCED)
REM  Handles: Batch deployment, logging, error handling, validation
REM ============================================================================
setlocal enabledelayedexpansion

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
    "& { ^
    $scriptPath = '%~dp0deploy_multi_advanced.ps1'; ^
    if (Test-Path $scriptPath) { ^
        & $scriptPath ^
    } else { ^
        Write-Host 'PowerShell script not found'; ^
        exit 1 ^
    } ^
    }"

endlocal
pause
