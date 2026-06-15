#!/usr/bin/env python3
"""
Verify that autostart is properly configured for system restart.
Run this to check if the monitor will start automatically after reboot.
"""

import os
import sys
import subprocess
from pathlib import Path
import winreg

def is_windows():
    return os.name == 'nt'

def check_vbs_startup():
    """Check if VBS startup script exists."""
    startup_folder = os.path.join(os.environ.get('APPDATA', str(Path.home())), 
                                   'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')
    vbs_path = os.path.join(startup_folder, 'EmployeeMonitor.vbs')
    
    if os.path.exists(vbs_path):
        return True, f"VBS startup script found: {vbs_path}"
    return False, "VBS startup script not found"

def check_scheduled_task():
    """Check if Task Scheduler task exists."""
    try:
        result = subprocess.run(
            ['schtasks', '/Query', '/TN', 'EmployeeMonitorAutoStart', '/FO', 'TABLE', '/NH'],
            capture_output=True,
            text=True,
            check=False
        )
        
        if result.returncode == 0 and 'EmployeeMonitorAutoStart' in result.stdout:
            return True, "Task Scheduler task found: EmployeeMonitorAutoStart"
        return False, "Task Scheduler task not found"
    except Exception as e:
        return False, f"Error checking Task Scheduler: {e}"

def check_registry_hkcu():
    """Check if HKCU Registry Run entry exists."""
    try:
        key_path = r'Software\Microsoft\Windows\CurrentVersion\Run'
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key_path) as key:
            value, reg_type = winreg.QueryValueEx(key, 'EmployeeMonitor')
            if value:
                return True, f"HKCU Registry entry found: {value[:80]}..."
            return False, "HKCU Registry entry not found"
    except FileNotFoundError:
        return False, "HKCU Registry entry not found"
    except Exception as e:
        return False, f"Error checking HKCU Registry: {e}"

def check_registry_hklm():
    """Check if HKLM Registry Run entry exists (system-wide)."""
    try:
        key_path = r'Software\Microsoft\Windows\CurrentVersion\Run'
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, key_path) as key:
            value, reg_type = winreg.QueryValueEx(key, 'EmployeeMonitor')
            if value:
                return True, f"HKLM Registry entry found: {value[:80]}..."
            return False, "HKLM Registry entry not found (requires admin)"
    except PermissionError:
        return False, "HKLM Registry entry check requires administrator privileges"
    except FileNotFoundError:
        return False, "HKLM Registry entry not found"
    except Exception as e:
        return False, f"Error checking HKLM Registry: {e}"

def check_monitor_script():
    """Check if monitor.py exists and is accessible."""
    monitor_path = Path(__file__).parent / 'monitor.py'
    if monitor_path.exists():
        return True, f"Monitor script found: {monitor_path}"
    return False, "Monitor script not found"

def check_python():
    """Verify Python is available."""
    try:
        result = subprocess.run(['python', '--version'], capture_output=True, text=True)
        if result.returncode == 0:
            version = result.stdout.strip()
            return True, f"Python available: {version}"
        return False, "Python not accessible"
    except Exception as e:
        return False, f"Python check failed: {e}"

def print_report(title, status, message):
    """Print formatted status report."""
    symbol = "✓" if status else "✗"
    status_str = "PASS" if status else "FAIL"
    print(f"  [{symbol}] {title:<40} {message}")
    return status

def main():
    if not is_windows():
        print("This verification script is for Windows only.")
        print("macOS and Linux autostart are configured in LaunchAgents/systemd.")
        return 0
    
    print("=" * 90)
    print("  AUTOSTART CONFIGURATION VERIFICATION")
    print("=" * 90)
    print()
    
    checks = [
        ("Monitor Script", check_monitor_script()),
        ("Python Availability", check_python()),
        ("VBS Startup Script", check_vbs_startup()),
        ("Task Scheduler Task", check_scheduled_task()),
        ("HKCU Registry Entry", check_registry_hkcu()),
        ("HKLM Registry Entry", check_registry_hklm()),
    ]
    
    all_passed = True
    critical_passed = 0
    
    for title, (status, message) in checks:
        print_report(title, status, message)
        
        if title in ["Monitor Script", "Python Availability"]:
            all_passed &= status
        
        if title in ["VBS Startup Script", "Task Scheduler Task", "HKCU Registry Entry"]:
            if status:
                critical_passed += 1
    
    print()
    print("=" * 90)
    
    if critical_passed >= 2:
        print("✓ AUTOSTART IS PROPERLY CONFIGURED")
        print()
        print("The monitor will automatically start when you:")
        print("  • Log in to Windows")
        print("  • Restart the computer")
        print("  • Turn on the computer (if auto-login is configured)")
        print()
        print("Multiple startup methods are configured for maximum reliability:")
        print(f"  • {critical_passed} out of 3 backup methods are active")
        print()
        return 0
    else:
        print("✗ AUTOSTART MAY NOT BE WORKING")
        print()
        print("Possible solutions:")
        print("  1. Run 'install_and_run.py --autostart' again with administrator privileges")
        print("  2. Check if antivirus is blocking startup entries")
        print("  3. Verify that Python is properly installed")
        print("  4. Re-run this verification after making changes")
        print()
        return 1

if __name__ == '__main__':
    sys.exit(main())
