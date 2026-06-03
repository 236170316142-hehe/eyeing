#!/usr/bin/env python3
"""
Quick Reference Guide for Installation & Verification
Run: python QUICK_START.py
"""

import sys
import subprocess
from pathlib import Path

def print_section(title):
    print(f"\n{'='*70}")
    print(f"  {title}")
    print('='*70)

def print_subsection(title):
    print(f"\n{title}")
    print("-" * len(title))

def main():
    print_section("EMPLOYEE MONITOR - INSTALLATION & VERIFICATION GUIDE")
    
    print_subsection("1. INITIAL INSTALLATION")
    print("""
On a fresh Windows PC, run:
  1. Double-click: install.bat
  2. Or run: python install_and_run.py --autostart
  
This will automatically:
  ✓ Install Python (if needed)
  ✓ Install all required Python packages
  ✓ Download and install Tesseract-OCR
  ✓ Configure autostart for system restart
  ✓ Open the employee onboarding page
""")
    
    print_subsection("2. VERIFY TESSERACT INSTALLATION")
    print("""
After installation, verify Tesseract is working:
  
  python verify_tesseract.py
  
This comprehensive test will check:
  ✓ Tesseract executable location
  ✓ Tesseract --version (basic functionality)
  ✓ pytesseract Python module
  ✓ OCR with a test image
  
If you see failures, follow the displayed instructions.
""")
    
    print_subsection("3. VERIFY AUTOSTART CONFIGURATION")
    print("""
Verify the monitor will start automatically on system restart:
  
  python verify_autostart.py
  
This will check:
  ✓ Monitor script exists
  ✓ Python is available
  ✓ VBS startup script configured
  ✓ Task Scheduler task configured
  ✓ Windows Registry entries configured
  
Multiple backup methods ensure reliability if one fails.
""")
    
    print_subsection("4. TEST AUTOSTART AFTER INSTALLATION")
    print("""
To verify autostart actually works:
  
  1. Restart your computer
  2. After login, check the task manager for python.exe processes
  3. Or check the log file: activity_data/activity_monitor.log
  
The monitor should be running automatically.
""")
    
    print_subsection("5. DEPLOYING TO OTHER PCs")
    print("""
To deploy the same configuration to another PC:
  
  1. Bundle everything in a zip file:
     - Copy entire folder with all Python files
     - Include verify_tesseract.py and verify_autostart.py
     - If you have tesseract installer, include it
  
  2. On the new PC:
     - Extract the zip file
     - Run: install.bat
     - Run: python verify_tesseract.py
     - Run: python verify_autostart.py
     - Restart computer
     - Verify autostart works
  
  3. Troubleshooting:
     - If Tesseract fails: Download from GitHub or use bundled installer
     - If autostart fails: Re-run install.bat with admin privileges
     - Check logs: activity_data/activity_monitor.log
""")
    
    print_subsection("6. TROUBLESHOOTING")
    print("""
Tesseract Not Found:
  ✗ Run: python verify_tesseract.py
  → Follow displayed installation instructions
  → Windows: May need admin to install to C:\\Program Files
  
Monitor Not Starting on Restart:
  ✗ Run: python verify_autostart.py
  → Re-run install.bat with admin privileges
  → Check antivirus settings (may block startup)
  → Try manual setup: Press Win+R, type "shell:startup"
  
Python or Module Errors:
  ✗ Re-run: python install_and_run.py
  → This reinstalls all packages
  
For detailed help, see:
  - README.md (overview)
  - DEPLOYMENT_GUIDE.md (comprehensive guide)
  - LOGS: activity_data/activity_monitor.log
""")
    
    print_section("QUICK COMMAND REFERENCE")
    print("""
Install from scratch:
  install.bat
  
Reinstall/fix issues:
  python install_and_run.py --autostart
  
Verify Tesseract:
  python verify_tesseract.py
  
Verify Autostart:
  python verify_autostart.py
  
Check monitor logs:
  type activity_data/activity_monitor.log
  
Set up autostart again:
  python install_and_run.py --autostart
  
View system logs (needs admin):
  powershell -Command "Get-EventLog -LogName Application -Source Python"
""")
    
    print("\n" + "="*70)
    print("  For questions or issues, check the DEPLOYMENT_GUIDE.md")
    print("="*70 + "\n")

if __name__ == '__main__':
    main()
