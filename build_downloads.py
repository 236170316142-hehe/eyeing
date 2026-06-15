#!/usr/bin/env python3
"""
Build the three OS-specific download ZIPs for the download page.

Usage:
    python build_downloads.py

Output (placed in backend/downloads/):
    eyeing-windows.zip  — full app + tesseract-ocr-w64-setup-5.5.0.20241111.exe
    eyeing-mac.zip      — full app (Tesseract installed via Homebrew at runtime)
    eyeing-linux.zip    — full app (Tesseract installed via apt/dnf at runtime)

Run this script from the repo root whenever you update the app.
"""

import os
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
OUT_DIR = ROOT / 'backend' / 'downloads'
OUT_DIR.mkdir(parents=True, exist_ok=True)

# Files/folders to include in ALL platforms
COMMON_INCLUDES = [
    'monitor.py',
    'install_and_run.py',
    'requirements.txt',
    'setup.py',
    'verify_tesseract.py',
    'verify_autostart.py',
    'DEPLOYMENT_GUIDE.md',
    'README.md',
    'linux',        # folder: setup_systemd.sh + service template
]

# Windows-only extras
WINDOWS_EXTRAS = [
    'install.bat',
    'deploy_automated.bat',
    'bootstrap_all.bat',
    'bootstrap_all.py',
    'tesseract-ocr-w64-setup-5.5.0.20241111.exe',
]

# macOS-only extras  (none needed; Homebrew handles Tesseract)
MAC_EXTRAS = []

# Linux-only extras  (none needed; apt/dnf handles Tesseract)
LINUX_EXTRAS = []


def add_path(zf: zipfile.ZipFile, src: Path, arcname_prefix: str = ''):
    """Recursively add a file or directory to the zip."""
    if not src.exists():
        print(f'  [SKIP] not found: {src}')
        return
    if src.is_file():
        arc = f'{arcname_prefix}{src.name}' if arcname_prefix else src.name
        zf.write(src, arc)
        print(f'  + {arc}')
    else:
        for child in sorted(src.rglob('*')):
            if child.is_file():
                rel = child.relative_to(ROOT)
                zf.write(child, str(rel))
                print(f'  + {rel}')


def build_zip(out_name: str, extras: list):
    out_path = OUT_DIR / out_name
    print(f'\nBuilding {out_path.name} ...')
    with zipfile.ZipFile(out_path, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        for name in COMMON_INCLUDES:
            add_path(zf, ROOT / name)
        for name in extras:
            add_path(zf, ROOT / name)
    size_mb = out_path.stat().st_size / 1_048_576
    print(f'  => {out_path}  ({size_mb:.1f} MB)')


def main():
    print('=== Building OS download ZIPs ===')
    build_zip('eyeing-windows.zip', WINDOWS_EXTRAS)
    build_zip('eyeing-mac.zip',     MAC_EXTRAS)
    build_zip('eyeing-linux.zip',   LINUX_EXTRAS)
    print('\nDone. Place backend/downloads/ on the server and the download page is ready.')


if __name__ == '__main__':
    main()
