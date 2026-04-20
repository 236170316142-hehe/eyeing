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

1.  **Preferred: Run Bootstrap Script**
    *   PowerShell command:
      ```powershell
      powershell -ExecutionPolicy Bypass -Command "iwr -UseBasicParsing https://<your-render-url>/api/employee/bootstrap.ps1 -OutFile $env:TEMP\employee-bootstrap.ps1; & $env:TEMP\employee-bootstrap.ps1"
      ```
    *   This will:
      - Download and extract the employee package
      - Run `install.bat` twice
      - Open setup page with auto-close + auto-start hooks

2.  **Manual fallback:**
    *   Extract the zip in a dedicated folder (e.g., `C:\Users\Public\Monitor`).
    *   Double-click **`install.bat`**.

3.  **Run Installer:**
    *   Double-click **`install.bat`**.
    *   **What happens automatically:**
        *   Installs Python (if missing).
        *   Installs all Python libraries.
        *   Downloads and installs Tesseract OCR.
        *   Triggers the **Onboarding Popup**.
4.  **Onboarding:**
    *   The employee fills in their `Employee ID`, `Company ID`, `Org Name`, and `User ID`.
    *   Once they click "Complete Setup," the monitor starts instantly.
5.  **Stealth Mode:**
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
-   **No Popup?** Ensure `activity_data/config.json` was deleted before moving files to the new PC.
-   **Data not reaching DB?** Ensure your hosted backend is reachable and `backend_url.txt` in the package points to the live host.
-   **OCR issues?** The script installs Tesseract to `C:\Program Files\Tesseract-OCR`. Ensure this wasn't blocked by antivirus.
