#!/usr/bin/env python3
"""
Watchdog - restarts monitor.py automatically if it is not running.
Called every 1 minute by a scheduled task registered by install_and_run.py.
"""
import os
import sys
import time
import subprocess
from pathlib import Path

BASE    = Path(__file__).parent.resolve()
MONITOR = BASE / 'monitor.py'
PYTHON  = sys.executable

# Crash-stamp file: written when watchdog restarts the monitor.
# If the monitor dies again within CRASH_WINDOW_SECONDS it is considered
# a crash loop and we back off rather than spinning.
STAMP_FILE          = BASE / 'activity_data' / '.watchdog_restart_stamp'
CRASH_WINDOW_SECONDS = 60   # if monitor dies again within 60 s → crash loop
MAX_BACKOFF_SECONDS  = 300  # max delay between restart attempts in crash loop


def monitor_is_running() -> bool:
    my_pid = str(os.getpid())
    try:
        if sys.platform == 'win32':
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


def _read_stamp() -> float:
    try:
        return float(STAMP_FILE.read_text(encoding='utf-8').strip())
    except Exception:
        return 0.0


def _write_stamp() -> None:
    try:
        STAMP_FILE.parent.mkdir(parents=True, exist_ok=True)
        STAMP_FILE.write_text(str(time.time()), encoding='utf-8')
    except Exception:
        pass


def start_monitor() -> None:
    pythonw = Path(PYTHON)
    if sys.platform == 'win32':
        pw = pythonw.with_name('pythonw.exe')
        if pw.exists():
            pythonw = pw
        DETACHED  = 0x00000008
        NEW_GROUP = 0x00000200
        subprocess.Popen(
            [str(pythonw), str(MONITOR)],
            cwd=str(BASE),
            creationflags=DETACHED | NEW_GROUP,
            close_fds=True
        )
    else:
        subprocess.Popen(
            [str(pythonw), str(MONITOR)],
            cwd=str(BASE),
            start_new_session=True
        )


if __name__ == '__main__':
    if not MONITOR.exists():
        sys.exit(0)

    if monitor_is_running():
        sys.exit(0)

    # Check for crash loop: if the monitor died within CRASH_WINDOW_SECONDS of
    # the last watchdog restart, back off before trying again so we don't spin.
    last_restart = _read_stamp()
    if last_restart > 0:
        time_since_restart = time.time() - last_restart
        if time_since_restart < CRASH_WINDOW_SECONDS:
            # Looks like a crash loop — wait a bit before retrying
            backoff = min(CRASH_WINDOW_SECONDS - time_since_restart + 10, MAX_BACKOFF_SECONDS)
            time.sleep(backoff)
            # Re-check after backoff; maybe another process already started it
            if monitor_is_running():
                sys.exit(0)

    _write_stamp()
    start_monitor()
