# 🚀 Employee Activity Monitor - Deployment Guide

This guide ensures you can deploy the complete monitoring system (Tracker + Admin Dashboard) to any new set of machines.

---

## 🏗 Part 1: Setting up the Backend (Admin Control Center)
*The backend should be hosted on a central server or a PC that is always on and accessible by the trackers.*

### Option A (Recommended): Deploy on Render

1. Push this repository to GitHub.
2. In Render, create a new **Web Service** from that GitHub repo.
3. Use these settings:
    - Root Directory: `backend`
    - Build Command: `npm install`
    - Start Command: `npm start`
4. Add environment variables in Render:
    - `MONGO_URI` (required)
    - `ADMIN_USERNAME` (required for admin access lock)
    - `ADMIN_PASSWORD` (required for admin access lock)
    - `GOOGLE_CLIENT_ID` (optional)
    - `NVIDIA_API_KEY` or `LLM_API_KEY` (optional)
5. Deploy and note your public URL, for example:
    - `https://your-app-name.onrender.com`

> This repo now includes `render.yaml` for blueprint-based deployment as well.

1.  **Install Node.js:** Ensure [Node.js](https://nodejs.org/) (v18+) is installed.
2.  **Environment Setup:**
    *   Navigate to the `backend/` folder.
    *   Create a file named `.env`.
    *   Paste your MongoDB Atlas URI and Google OAuth client ID (optional, only required if you want Google login on `setup.html`):
        ```env
        MONGO_URI=mongodb+srv://user:pass@cluster.mongodb.net/activity_monitor
        PORT=3000
        GOOGLE_CLIENT_ID=your_google_oauth_web_client_id.apps.googleusercontent.com
        ```
    *   In Google Cloud Console, add `http://localhost:3000` to **Authorized JavaScript origins** for that OAuth web client.
3.  **Install Dependencies:**
    ```bash
    npm install
    ```
4.  **Start the Server:**
    ```bash
    npm start
    ```
5.  **Access Admin Dashboard:**
    Open your browser to `http://<server-ip>:3000/admin.html`.
    You will be prompted for `ADMIN_USERNAME` and `ADMIN_PASSWORD`.

---

## 🕵️ Part 2: Preparing the Tracker (for Employee PCs)
*Perform these steps on your development PC before sending the files to employees.*

1.  **IMPORTANT: Clear Local Config:**
    *   Delete the folder `activity_data/` or at least the file `activity_data/config.json`.
    *   *If you don't do this, the new PC will "think" it is you and won't show the onboarding popup.*
2.  **Use Employee Distribution Page (NEW):**
    *   Open `/employee-distribution.html` on your hosted backend.
    *   Download either:
       - `employee-monitor-package.zip` (manual), or
       - `employee-bootstrap.ps1` (automated flow).
    *   The generated package now includes a `backend_url.txt` seed so monitors point to your live backend automatically.

---

## 💻 Part 3: Installing on a New PC
*Perform these steps on the target employee/tester's machine.*

1.  **Preferred (Windows): Run Bootstrap Script**
    *   PowerShell command:
      ```powershell
      powershell -ExecutionPolicy Bypass -Command "iwr -UseBasicParsing https://<your-render-url>/api/employee/bootstrap.ps1 -OutFile $env:TEMP\employee-bootstrap.ps1; & $env:TEMP\employee-bootstrap.ps1"
      ```
    *   This will:
      - Download and extract the employee package
      - Run `install.bat` twice
      - Open setup page with auto-close + auto-start hooks

2.  **Preferred (macOS): Direct Installer Download**
    *   Download `https://<your-render-url>/api/employee/macos-install.command`.
    *   Open Terminal and run:
      ```bash
      cd ~/Downloads
      chmod +x employee-monitor-macos-install.command
      ./employee-monitor-macos-install.command
      ```
    *   If Gatekeeper blocks execution, run:
      ```bash
      xattr -dr com.apple.quarantine ~/EmployeeMonitorPackage
      cd ~/EmployeeMonitorPackage
      ./install.sh
      ```

3.  **Preferred (Linux): Direct Installer Download**
    *   Download `https://<your-render-url>/api/employee/linux-install.sh`.
    *   Run:
      ```bash
      cd ~/Downloads
      chmod +x employee-monitor-linux-install.sh
      ./employee-monitor-linux-install.sh
      ```

4.  **Manual ZIP fallback (all platforms):**
    *   Extract the zip in a dedicated folder (e.g., `C:\Users\Public\Monitor`).
    *   Windows: run **`install.bat`**.
    *   macOS: run **`install.command`** (or `./install.sh` from Terminal).
    *   Linux: run **`./install.sh`** from Terminal.

5.  **Run Installer:**
    *   Run the platform installer from inside the extracted package folder.
    *   **What happens automatically:**
        *   Installs Python (if missing).
        *   Installs all Python libraries.
        *   Installs/validates Tesseract OCR.
        *   Configures auto-start for system restart.
        *   Triggers the **Onboarding Popup**.
6.  **Verify Installation (Windows only):**
    *   After installation, verify Tesseract is working:
        ```powershell
        python verify_tesseract.py
        ```
    *   Verify autostart will work on system restart:
        ```powershell
        python verify_autostart.py
        ```
    *   Both scripts will show detailed reports with status checks.
7.  **Onboarding:**
    *   The employee fills in their `Employee ID`, `Company ID`, `Org Name`, and `User ID`.
    *   Once they click "Complete Setup," the monitor starts instantly.
8.  **Test Autostart:**
    *   **Windows:** Restart the computer and verify the monitor starts automatically
    *   **macOS:** Log out and log back in, or restart the computer
    *   **Linux:** Log out and log back in, or restart the computer
9.  **Stealth Mode:**
    *   The folder will automatically become **Hidden** and marked as a **System File**.
    *   **Deletion Protection** is applied (Windows will block any attempt to delete the folder).
    *   A startup trigger is added to hiddenly launch the monitor every time the PC boots.

---

## 🎮 Part 4: Remote Management
*Manage everything from your Admin Dashboard.*

-   **To Pause/Resume:** Toggle the switch in `admin.html`. The PC will stop/start tracking within 30 seconds.
-   **To Uninstall Remotely:** Click the red **Decommission** button.
    *   The remote PC will remove its startup trigger.
    *   It will unlock the folder and delete itself permanently.
    *   The backend will wipe all reports and history for that user from the cloud database.
    *   If the employee device is offline, uninstall completes on its next check-in.

---

## 🛠 Troubleshooting

### ✅ Verification Tools
Use these scripts to diagnose issues:

**Check Tesseract Installation:**
```powershell
python verify_tesseract.py
```
- Verifies Tesseract executable is found
- Tests Tesseract functionality
- Tests pytesseract module
- Tests OCR with a sample image
- Provides detailed installation instructions if issues found

**Check Autostart Configuration (Windows):**
```powershell
python verify_autostart.py
```
- Verifies monitor.py exists
- Checks Python availability
- Verifies VBS startup script
- Checks Task Scheduler configuration
- Checks Registry entries (HKCU and HKLM)
- Reports on which autostart methods are active

---

### ⚠️ CRITICAL: Tesseract-OCR Issues
Tesseract OCR is **essential** - the application will not work without it for screenshot analysis and processing.

**If you see errors about Tesseract:**
1. **Run the verification script first:**
   ```powershell
   python verify_tesseract.py
   ```

2. **Windows Installation Issues:**
   - The installer should auto-download and install from GitHub to `C:\Program Files\Tesseract-OCR`
   - If it fails or uses bundled installer:
     ```powershell
     python tesseract-ocr-w64-setup-5.5.0.20241111.exe /S /D="C:\Program Files\Tesseract-OCR"
     ```
   - Manually download: https://github.com/UB-Mannheim/tesseract/releases/download/v5.4.0/tesseract-ocr-w64-setup-v5.4.0.exe
   - Run installer with default settings to `C:\Program Files\Tesseract-OCR`
   - If antivirus blocked the installation, whitelist Tesseract-OCR and retry
   - After manual installation, re-run installer:
     ```powershell
     python install_and_run.py --autostart
     ```

3. **macOS & Linux:** 
   - macOS: `brew install tesseract` then re-run installer
   - Linux (Ubuntu/Debian): `sudo apt-get install tesseract-ocr`
   - Linux (Fedora/RHEL): `sudo dnf install tesseract`
   - Then re-run the installer

4. **Environment variable fallback:**
   If Tesseract is installed in a non-standard location:
   ```batch
   REM Windows
   set TESSERACT_CMD=C:\Custom\Path\tesseract.exe
   python install_and_run.py
   ```
   ```bash
   # Linux/macOS
   export TESSERACT_CMD=/custom/path/tesseract
   python install_and_run.py
   ```

---

### 🔄 Autostart Not Working (Monitor Doesn't Start on Restart)

**Windows:**
1. Verify autostart configuration:
   ```powershell
   python verify_autostart.py
   ```

2. If it reports failures, re-run installation with admin privileges:
   ```powershell
   python install_and_run.py --autostart
   ```

3. Check for antivirus interference:
   - Whitelist Tesseract-OCR and Python in your antivirus
   - Check antivirus policy for startup script blocking

4. Manual autostart setup (if all else fails):
   - Press `Win+R`, type `shell:startup`
   - Create a shortcut to: `pythonw.exe "path\to\monitor.py"`

5. Test autostart:
   - Save your work
   - Restart the computer
   - Check if monitor is running (check `activity_data/activity_monitor.log`)

**macOS:**
- Verify LaunchAgent exists: `ls -la ~/Library/LaunchAgents/com.eyeing.monitor.plist`
- Check logs: `log stream --predicate 'eventMessage contains "employee-monitor"'`
- Reload: `launchctl load ~/Library/LaunchAgents/com.eyeing.monitor.plist`

**Linux:**
- Check systemd service: `systemctl --user status employee-monitor.service`
- Check logs: `journalctl --user-unit employee-monitor.service -n 50`
- Manually reload: `systemctl --user daemon-reload && systemctl --user restart employee-monitor.service`

---

### Other Issues
-   **No Popup?** Ensure `activity_data/config.json` was deleted before moving files to the new PC.
-   **Data not reaching DB?** Ensure your hosted backend is reachable and `backend_url.txt` in the package points to the live host.
-   **Folder not hidden (Windows)?** Installer now applies `attrib +h +s` to the package folder and all child files/folders recursively.
-   **Still not showing in admin?** Check local crash log at `activity_data/monitor_startup_crash.log` and `activity_monitor.log` in the installed package folder.
