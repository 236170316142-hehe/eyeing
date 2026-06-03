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

def check_tesseract():
    """Check if Tesseract is installed and accessible."""
    import shutil
    
    # Check common paths
    candidates = [
        r'C:\Program Files\Tesseract-OCR\tesseract.exe',
        r'C:\Program Files (x86)\Tesseract-OCR\tesseract.exe',
        '/usr/local/bin/tesseract',
        '/usr/bin/tesseract',
        '/opt/homebrew/bin/tesseract',
    ]
    
    # Check environment variable
    if os.environ.get('TESSERACT_CMD') and os.path.exists(os.environ.get('TESSERACT_CMD')):
        print(f"[OK] Tesseract found at: {os.environ.get('TESSERACT_CMD')}")
        return True
    
    # Check PATH
    if shutil.which('tesseract'):
        print(f"[OK] Tesseract found on PATH: {shutil.which('tesseract')}")
        return True
    
    # Check common paths
    for path in candidates:
        if os.path.exists(path):
            print(f"[OK] Tesseract found at: {path}")
            return True
    
    print("[ERROR] Tesseract OCR is required but was not found!")
    print("INSTALLATION INSTRUCTIONS:")
    print("  Windows: Download from https://github.com/UB-Mannheim/tesseract/releases")
    print("  macOS: brew install tesseract")
    print("  Linux: sudo apt-get install tesseract-ocr")
    return False

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
    
    # Check Tesseract before proceeding
    if not check_tesseract():
        print("\n[CRITICAL] Tesseract OCR is mandatory for this application.")
        input("Please install Tesseract and re-run this script. Press Enter to exit...")
        sys.exit(1)
    
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
