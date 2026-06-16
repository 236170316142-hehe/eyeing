#!/usr/bin/env python3
"""
Watchdog — restarts monitor.py automatically if it is not running.

On Windows this is called every 5 minutes by a scheduled task
(registered by install_and_run.py).  On macOS / Linux the OS itself
handles restarts (LaunchAgent KeepAlive / systemd Restart=always), so
this script is only ever needed on Windows, but it is harmless to run
on any platform.

Safe to run repeatedly: does nothing if monitor.py is already running.
"""
import os
import sys
import subprocess
from pathlib import Path

BASE    = Path(__file__).parent.resolve()
MONITOR = BASE / 'monitor.py'
PYTHON  = sys.executable


def monitor_is_running() -> bool:
    """Return True if a monitor.py process is already running (excluding self)."""
    my_pid = str(os.getpid())
    try:
        if sys.platform == 'win32':
            # PowerShell is more reliable than WMIC (which can hang or miss pythonw processes)
            result = subprocess.run(
                ['powershell', '-NoProfile', '-Command',
                 'Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Csv -NoTypeInformation'],
                capture_output=True, text=True, timeout=20
            )
            for line in result.stdout.splitlines():
                if 'monitor.py' in line and my_pid not in line:
                    return True
            return False
        else:
            result = subprocess.run(
                ['pgrep', '-f', str(MONITOR)],
                capture_output=True, timeout=5
            )
            pids = [p.strip() for p in result.stdout.splitlines() if p.strip() != my_pid]
            return len(pids) > 0
    except Exception:
        return False


def start_monitor() -> None:
    if sys.platform == 'win32':
        DETACHED  = 0x00000008   # DETACHED_PROCESS
        NEW_GROUP = 0x00000200   # CREATE_NEW_PROCESS_GROUP
        subprocess.Popen(
            [PYTHON, str(MONITOR)],
            cwd=str(BASE),
            creationflags=DETACHED | NEW_GROUP,
            close_fds=True
        )
    else:
        subprocess.Popen(
            [PYTHON, str(MONITOR)],
            cwd=str(BASE),
            start_new_session=True
        )


if __name__ == '__main__':
    if not MONITOR.exists():
        sys.exit(0)
    if not monitor_is_running():
        start_monitor()
