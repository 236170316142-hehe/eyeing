# Employee Activity Monitor
# Run this script to set up auto-start and monitoring

import subprocess
import sys
import os
import shutil
import urllib.request

def install_python_if_needed():
    # Non-interactive bootstrap: ensure Python >= 3.8 is present, else fail without prompting
    if sys.version_info < (3, 8):
        print("Python 3.8+ required. Please install from python.org")
        sys.exit(1)
    print(f"Python {sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro} detected")

def install_packages():
    required = ['psutil', 'Pillow', 'pytesseract', 'pywin32', 'pypiwin32', 'sentence-transformers', 'pyautogui', 'pyperclip', 'pynput']
    for package in required:
        try:
            __import__(package.replace('-', '_'))
        except ImportError:
            print(f"Installing {package}...")
            subprocess.check_call([sys.executable, '-m', 'pip', 'install', package, '-q'])

def setup_autostart():
    if os.name != 'nt':
        print("Auto-start is Windows-only.")
        return False
    # Create a Startup shortcut via WScript.Shell (robust across PyWin32 versions)
    script_path = os.path.abspath('monitor.py')
    startup_folder = os.path.join(os.environ['APPDATA'], 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')
    shortcut_path = os.path.join(startup_folder, 'EmployeeMonitor.lnk')
    try:
        import win32com.client
        shell = win32com.client.Dispatch("WScript.Shell")
        shortcut = shell.CreateShortCut(shortcut_path)
        shortcut.TargetPath = sys.executable
        shortcut.Arguments = f'"{script_path}" --background'
        shortcut.WorkingDirectory = os.path.dirname(script_path)
        shortcut.Save()
        print(f"[OK] Auto-start shortcut created: {shortcut_path}")
        return True
    except Exception as e:
        print(f"[WARN] Could not create shortcut: {e}")
        return False

def main():
    print("=" * 50)
    print("Employee Activity Monitor Setup")
    print("=" * 50)
    
    install_python_if_needed()
    install_packages()
    
    # Non-interactive: autostart can be enabled via environment variable or CLI flag
    import argparse
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--autostart", action="store_true")
    parser.add_argument("--no-run", action="store_true")
    parser.add_argument("--silent", action="store_true")
    args, _ = parser.parse_known_args()
    if getattr(args, "autostart", False):
        setup_autostart()
    
    if not getattr(args, "no_run", False):
        print("\nStarting monitor...")
        from monitor import ActivityMonitor
        monitor = ActivityMonitor()
        monitor.run()

if __name__ == '__main__':
    main()
