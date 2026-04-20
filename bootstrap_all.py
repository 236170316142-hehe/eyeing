#!/usr/bin/env python3
import os
import sys
import json
import subprocess
from pathlib import Path

DATA_DIR = Path("activity_data")
CONFIG_FILE = DATA_DIR / "config.json"

def ensure_dirs():
    DATA_DIR.mkdir(parents=True, exist_ok=True)

def ensure_dependencies():
    try:
        import psutil  # noqa: F401
        import pyautogui  # noqa: F401
        import pytesseract  # noqa: F401
        import pyperclip  # noqa: F401
    except Exception:
        print("Installing dependencies...")
        subprocess.check_call([sys.executable, "-m", "pip", "install", "-r", "requirements.txt"])

def read_config():
    if CONFIG_FILE.exists():
        try:
            with open(CONFIG_FILE, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception:
            return None
    return None

def onboarding():
    cfg = read_config()
    if cfg and cfg.get("employee_id") and cfg.get("employee_id") != "UNKNOWN":
        print("Config already exists. Skipping onboarding.")
        return
    ensure_dirs()
    # interactive only if a TTY is available
    if not sys.stdin.isatty():
        emp = os.environ.get("USER", "UNKNOWN")
        comp = os.environ.get("COMPNAME", "UNKNOWN")
    else:
        emp = input("Enter employee_id: ").strip() or "UNKNOWN"
        comp = input("Enter company_id: ").strip() or "UNKNOWN"
    try:
        import socket
        device_id = socket.gethostname()
    except Exception:
        device_id = "UNKNOWN"
    cfg = {"employee_id": emp, "company_id": comp, "device_id": device_id}
    with open(CONFIG_FILE, 'w', encoding='utf-8') as f:
        json.dump(cfg, f, indent=2)
    print("Onboarding complete. Configuration saved.")

def main():
    ensure_dirs()
    ensure_dependencies()
    onboarding()
    # Start monitor in headless mode by default
    cmd = [sys.executable, os.path.abspath("monitor.py")]
    print("Starting monitor...")
    os.execv(sys.executable, cmd)

if __name__ == '__main__':
    main()
