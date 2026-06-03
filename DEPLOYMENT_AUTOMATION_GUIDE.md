# 🚀 AUTOMATED DEPLOYMENT GUIDE - Multiple Computers

This guide explains how to deploy the Employee Monitor to multiple computers efficiently using the new automated deployment tools.

---

## 📋 Quick Overview

| Script | Purpose | Use Case |
|--------|---------|----------|
| **deploy_automated.bat** | Complete single-computer setup | First-time installation |
| **deploy_to_multiple_pcs.bat** | Multi-PC deployment coordinator | Deploying to 2+ computers |
| **deploy_powershell.bat** | Advanced remote deployment | Enterprise deployment |

---

## 🎯 Single Computer Deployment (Simplest)

### For one computer (first installation):

```batch
deploy_automated.bat
```

**What it does:**
1. ✓ Installs Python 3.12 (if needed)
2. ✓ Installs all Python packages
3. ✓ Installs/verifies Tesseract-OCR
4. ✓ Configures autostart
5. ✓ Runs verification tests
6. ✓ Asks about restart
7. ✓ Shows deployment summary

**Time required:** 10-15 minutes (first time), 2-3 minutes (if Python/packages already installed)

**Output:**
- Shows color-coded progress: [1/6], [2/6], etc.
- Lists what was installed
- Shows verification results
- Prompts for restart

---

## 🔄 Multiple Computer Deployment (Better)

### For deploying to 2-10 computers:

```batch
deploy_to_multiple_pcs.bat
```

**Menu Options:**

#### Option 1: USB Deployment (Most Reliable)
```
Select method: 1
Enter USB drive letter: E
```

This will:
1. Create `E:\EmployeeMonitor` folder
2. Copy all files (excluding logs, cache, etc.)
3. Create setup instructions

**Then on each target computer:**
```batch
E:\EmployeeMonitor\deploy_automated.bat
```

**Advantages:**
- ✓ Works without network
- ✓ Same setup every computer
- ✓ Can deploy offline
- ✓ Portable and reusable

---

#### Option 2: Network Deployment (Fast)
```
Select method: 2
Enter network share path: \\SERVER\Share
```

This will:
1. Copy to `\\SERVER\Share\EmployeeMonitor_ComputerName_Date`
2. Show UNC path

**Then on each target computer:**
```batch
net use Z: \\SERVER\Share
Z:\EmployeeMonitor_YourPC_2024-06-03\deploy_automated.bat
```

**Advantages:**
- ✓ Fastest for many computers
- ✓ Central repository
- ✓ Good for LANs

---

#### Option 3: Manual Instructions (DIY)
```
Select method: 3
```

Displays step-by-step instructions for manual setup.

**Advantages:**
- ✓ Complete control
- ✓ No special tools needed
- ✓ Troubleshooting-friendly

---

## 🏢 Enterprise Deployment (Advanced)

### For deploying to 10+ computers or remote networks:

```batch
deploy_powershell.bat
```

**Features:**
- Remote deployment via PowerShell Remoting
- Batch processing of multiple computers
- Automatic validation after deployment
- Detailed logging
- Network credentials support
- Deployment reports

**Menu:**
```
1. Deploy to current computer (localhost)
2. Deploy to multiple computers (remote)
3. Validate existing installation
4. Test Tesseract on computer
5. Test Autostart on computer
6. Generate deployment report
7. Exit
```

**Example: Deploy to 5 remote computers**

```
Select option: 2

Enter computer names to deploy to:
Computer name or IP: PC-001
Computer name or IP: PC-002
Computer name or IP: PC-003
Computer name or IP: 192.168.1.100
Computer name or IP: LAPTOP-JOHN
Computer name or IP: [press Enter]

Username: admin
Password: ****

[Deploys to all 5 automatically]
```

---

## 📊 Deployment Comparison

| Scenario | Tool | Time | Complexity |
|----------|------|------|-----------|
| 1 computer | `deploy_automated.bat` | 15 min | ⭐ Easy |
| 2-5 computers | `deploy_to_multiple_pcs.bat` | 5 min prep + 10 min/PC | ⭐⭐ Medium |
| 10+ computers | `deploy_powershell.bat` | 30 min setup + 5-10 min/PC | ⭐⭐⭐ Advanced |
| Network deployment | Any | Varies | Depends |

---

## 🔧 Step-by-Step Examples

### Example 1: Deploy to 3 computers via USB

**On Source Computer:**
```batch
# Prepare USB
deploy_to_multiple_pcs.bat
# Select: 1 (USB)
# USB drive letter: E
```

**Wait for completion, then:**
- Copy USB stick to first target computer

**On Target Computer 1:**
```batch
E:\EmployeeMonitor\deploy_automated.bat
```

**Repeat for Computers 2 and 3**

**Total time:** ~1 hour for 3 computers

---

### Example 2: Deploy to 5 networked computers

**On Source Computer:**
```batch
# Share folder on network
# Network path: \\WORKSTATION\DeployShare

deploy_to_multiple_pcs.bat
# Select: 2 (Network)
# Enter: \\WORKSTATION\DeployShare
```

**On each Target Computer:**
```batch
net use Z: \\WORKSTATION\DeployShare
Z:\EmployeeMonitor_WORKSTATION_2024-06-03\deploy_automated.bat
```

**Total time:** ~15 min prep + 10 min per computer = 65 min for 5 computers

---

### Example 3: Remote deployment via PowerShell

**On Admin Computer:**
```batch
deploy_powershell.bat
```

**Select:** 2 (Deploy to multiple computers)

**Enter computers:** PC-101, PC-102, PC-103, etc.

**Enter credentials:** Domain admin account

**Automated deployment** to all computers with validation

**Total time:** ~30 min setup + 8-10 min per computer

---

## ✅ Deployment Checklist

### Before Deployment
- [ ] All files in source folder
- [ ] Tesseract installer in folder (optional, but recommended)
- [ ] At least 1GB free space on target computers
- [ ] Python will be installed if needed
- [ ] Network connectivity (for network/remote deployment)

### During Deployment
- [ ] Run deployment script
- [ ] Follow on-screen prompts
- [ ] Allow time for each step to complete
- [ ] Don't close window until completion

### After Deployment
- [ ] Verify Tesseract: `python verify_tesseract.py`
- [ ] Verify Autostart: `python verify_autostart.py`
- [ ] Restart computer to test autostart
- [ ] Check logs: `activity_data\activity_monitor.log`

---

## 🐛 Troubleshooting

### Deploy script won't start
**Problem:** "Access Denied" or permission error

**Solution:**
1. Run Command Prompt as Administrator
2. Navigate to folder
3. Run: `deploy_automated.bat`

---

### Python installation fails
**Problem:** Script says Python not found after installation

**Solution:**
1. Run installer manually from:
   https://www.python.org/ftp/python/3.12.0/python-3.12.0-amd64.exe
2. Install with "Add to PATH" checked
3. Restart terminal
4. Re-run `deploy_automated.bat`

---

### Tesseract installation fails
**Problem:** Tesseract still not found after setup

**Solution:**
1. Check bundled installer exists in folder
2. Run manually: `tesseract-ocr-w64-setup-*.exe /S /D="C:\Program Files\Tesseract-OCR"`
3. Verify: `python verify_tesseract.py`

---

### Autostart not working
**Problem:** Monitor doesn't start after restart

**Solution:**
1. Run: `python verify_autostart.py`
2. If FAIL: Run `deploy_automated.bat` again with admin privileges
3. Check antivirus isn't blocking Python startup
4. Restart computer

---

### Network deployment fails
**Problem:** "Cannot access network path"

**Solution:**
1. Verify network path is accessible: `net view \\SERVER`
2. Check credentials: `net use \\SERVER\Share /user:admin`
3. For remote deployment: Verify PowerShell Remoting enabled
   ```powershell
   Enable-PSRemoting -Force  # On all target computers
   ```

---

## 📁 File Structure After Deployment

```
C:\EmployeeMonitor\  (or your chosen path)
├── deploy_automated.bat          ← Main deployment script
├── deploy_to_multiple_pcs.bat    ← Multi-PC coordinator
├── deploy_powershell.bat         ← Advanced deployment
├── deploy_multi_advanced.ps1     ← PowerShell script
├── verify_tesseract.py           ← Verification tool
├── verify_autostart.py           ← Autostart verification
├── install_and_run.py            ← Installation script
├── monitor.py                    ← Main monitoring script
├── bootstrap_all.py              ← Bootstrap script
├── requirements.txt              ← Python packages
├── activity_data/                ← Data directory (created on first run)
│   ├── config.json               ← Employee configuration
│   ├── activity_monitor.log      ← Monitor log file
│   ├── screenshots/              ← Screenshot storage
│   └── ocr_text/                 ← OCR results
└── README.md, DEPLOYMENT_GUIDE.md, etc.
```

---

## 🎓 Tips for Successful Deployment

### Tip 1: Test on One Computer First
Always run `deploy_automated.bat` on one test computer before deploying to many.

```bash
# Test deployment
C:\TestComputer\deploy_automated.bat

# Verify
python verify_tesseract.py
python verify_autostart.py

# Restart to test
shutdown /r /t 0
```

### Tip 2: Create Deployment Package
Prepare a complete package on USB or network share:

```bash
# Prepare once, use many times
mkdir \\SERVER\EmployeeMonitorPackage
copy *.bat \\SERVER\EmployeeMonitorPackage\
copy *.py \\SERVER\EmployeeMonitorPackage\
copy requirements.txt \\SERVER\EmployeeMonitorPackage\
copy tesseract-ocr-*.exe \\SERVER\EmployeeMonitorPackage\
```

### Tip 3: Document Installation
Keep notes of each deployment:

```
Computer: PC-101
Date: 2024-06-03
Time: 14:30
Result: SUCCESS
Tesseract: PASS
Autostart: PASS
Notes: Required admin elevation
```

### Tip 4: Batch Deployment Schedule
For many computers, schedule deployments:

```
Monday:   Deploy to 5 computers
Tuesday:  Deploy to 5 computers
Wednesday: Deploy to remaining computers
```

This avoids network congestion and allows troubleshooting.

---

## 📞 Support Resources

- **Quick Reference:** `python QUICK_START.py`
- **Full Guide:** See `DEPLOYMENT_GUIDE.md`
- **Troubleshooting:** See `DEPLOYMENT_GUIDE.md` - Troubleshooting section
- **Logs:** Check `activity_data/activity_monitor.log` on target PC
- **Verification:** Always run after deployment:
  - `python verify_tesseract.py`
  - `python verify_autostart.py`

---

## 🎉 Success Indicators

After deployment on a target computer, you should see:

✓ `deploy_automated.bat` completes without errors
✓ `python verify_tesseract.py` shows all tests PASS
✓ `python verify_autostart.py` shows ≥2/3 methods active
✓ After restart, `activity_monitor.log` shows monitor running
✓ Monitor starts automatically on every restart

If you see these, deployment was **SUCCESSFUL** ✅

---

**Last Updated:** June 2024
**Version:** 1.0
