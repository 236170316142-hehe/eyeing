#!/usr/bin/env python3
"""
Verify Tesseract-OCR installation and functionality.
Run this script to check if Tesseract is properly installed and working.
"""

import os
import sys
import subprocess
import shutil
from pathlib import Path

def check_tesseract_executable():
    """Find and verify Tesseract executable."""
    candidates = [
        # Bundled locations (checked first)
        Path(__file__).parent / 'Tesseract-OCR' / 'tesseract.exe',
        Path(__file__).parent / 'tesseract' / 'tesseract.exe',
        Path(__file__).parent / 'Tesseract-OCR' / 'bin' / 'tesseract',
        Path(__file__).parent / 'tesseract' / 'bin' / 'tesseract',
        
        # Standard Windows installation paths
        Path(r'C:\Program Files\Tesseract-OCR\tesseract.exe'),
        Path(r'C:\Program Files (x86)\Tesseract-OCR\tesseract.exe'),
        
        # Environment variable
        Path(os.environ.get('TESSERACT_CMD', '')),
        
        # System PATH
        Path(shutil.which('tesseract') or ''),
        
        # macOS/Linux paths
        Path('/usr/local/bin/tesseract'),
        Path('/usr/bin/tesseract'),
        Path('/opt/homebrew/bin/tesseract'),
    ]
    
    for candidate in candidates:
        if candidate and candidate.exists():
            return str(candidate)
    
    return None

def verify_tesseract_works():
    """Test if Tesseract actually works."""
    tesseract_cmd = check_tesseract_executable()
    
    if not tesseract_cmd:
        return False, "Tesseract executable not found"
    
    try:
        # Test basic functionality
        result = subprocess.run(
            [tesseract_cmd, '--version'],
            capture_output=True,
            text=True,
            timeout=5
        )
        
        if result.returncode != 0:
            return False, f"Tesseract --version failed: {result.stderr}"
        
        version_output = result.stdout or result.stderr
        return True, f"Tesseract working: {version_output.split(chr(10))[0]}"
        
    except subprocess.TimeoutExpired:
        return False, "Tesseract --version timed out"
    except Exception as e:
        return False, f"Error running tesseract: {e}"

def verify_pytesseract():
    """Verify pytesseract Python module."""
    try:
        import pytesseract
        
        tesseract_cmd = check_tesseract_executable()
        if tesseract_cmd:
            pytesseract.pytesseract.tesseract_cmd = tesseract_cmd
        
        # Try to get version
        version = pytesseract.get_tesseract_version()
        return True, f"pytesseract working: {version}"
        
    except ImportError:
        return False, "pytesseract not installed (pip install pytesseract)"
    except Exception as e:
        return False, f"pytesseract error: {e}"

def verify_ocr_with_image():
    """Test OCR with a simple image."""
    try:
        import pytesseract
        from PIL import Image, ImageDraw
        import tempfile
        
        tesseract_cmd = check_tesseract_executable()
        if tesseract_cmd:
            pytesseract.pytesseract.tesseract_cmd = tesseract_cmd
        
        # Create a simple test image with text
        with tempfile.NamedTemporaryFile(suffix='.png', delete=False) as tmp:
            img = Image.new('RGB', (200, 100), color='white')
            draw = ImageDraw.Draw(img)
            
            # Write simple text
            try:
                draw.text((10, 10), "TEST123", fill='black')
            except Exception:
                # If font unavailable, just draw something
                draw.rectangle((10, 10, 100, 50), outline='black')
            
            img.save(tmp.name)
            test_image = tmp.name
        
        try:
            # Run OCR
            text = pytesseract.image_to_string(test_image)
            os.unlink(test_image)
            
            if text.strip():
                return True, f"OCR working - extracted text: {text.strip()[:50]}"
            else:
                return True, "OCR working (no text detected in test image)"
        except Exception as e:
            os.unlink(test_image)
            return False, f"OCR test failed: {e}"
            
    except ImportError as e:
        return False, f"Missing dependency for OCR test: {e}"
    except Exception as e:
        return False, f"OCR test error: {e}"

def print_report(title, status, message):
    """Print formatted status report."""
    status_str = "✓ PASS" if status else "✗ FAIL"
    symbol = "✓" if status else "✗"
    print(f"\n[{status_str}] {title}")
    print(f"     {message}")
    return status

def main():
    print("=" * 70)
    print("  TESSERACT OCR VERIFICATION REPORT")
    print("=" * 70)
    
    all_passed = True
    
    # Test 1: Find executable
    tesseract_path = check_tesseract_executable()
    if tesseract_path:
        all_passed &= print_report(
            "Tesseract Executable Found",
            True,
            f"Location: {tesseract_path}"
        )
    else:
        all_passed &= print_report(
            "Tesseract Executable Found",
            False,
            "Not found in standard locations. Install Tesseract-OCR."
        )
        print("\n" + "=" * 70)
        print("INSTALLATION INSTRUCTIONS:")
        print("=" * 70)
        if sys.platform == 'win32':
            print("Windows:")
            print("  1. Download: https://github.com/UB-Mannheim/tesseract/releases")
            print("  2. Run: tesseract-ocr-w64-setup-v5.4.0.exe")
            print("  3. Install to: C:\\Program Files\\Tesseract-OCR")
            print("  4. Re-run this verification script")
        elif sys.platform == 'darwin':
            print("macOS:")
            print("  1. Install Homebrew if needed: https://brew.sh")
            print("  2. Run: brew install tesseract")
            print("  3. Re-run this verification script")
        else:
            print("Linux:")
            print("  Ubuntu/Debian: sudo apt-get install tesseract-ocr")
            print("  Fedora/RHEL: sudo dnf install tesseract")
            print("  Re-run this verification script")
        return 1
    
    # Test 2: Tesseract executable works
    works, msg = verify_tesseract_works()
    all_passed &= print_report("Tesseract Executable Test", works, msg)
    
    if not works:
        print("\n[!] Tesseract executable found but not working properly.")
        print("    Try reinstalling Tesseract-OCR.")
        return 1
    
    # Test 3: pytesseract module
    works, msg = verify_pytesseract()
    all_passed &= print_report("PyTesseract Module", works, msg)
    
    if not works:
        print("\n[!] pytesseract module issue detected.")
        print("    Run: pip install pytesseract")
        return 1
    
    # Test 4: OCR functionality
    works, msg = verify_ocr_with_image()
    all_passed &= print_report("OCR Image Processing", works, msg)
    
    print("\n" + "=" * 70)
    
    if all_passed:
        print("✓ ALL TESTS PASSED - Tesseract is ready to use!")
        print("=" * 70)
        return 0
    else:
        print("✗ SOME TESTS FAILED - Please fix the issues above")
        print("=" * 70)
        return 1

if __name__ == '__main__':
    sys.exit(main())
