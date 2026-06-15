# AI-Driven Recruitment Hub

Node.js dashboard + FastAPI AI backend scaffold based on your PRD.

## ⚡ AUTOMATED DEPLOYMENT (NEW!)

**Deploy to multiple computers effortlessly:**

### Single Computer (First Time)
```bash
deploy_automated.bat
```
- ✓ Installs Python, packages, Tesseract
- ✓ Configures autostart for system restart
- ✓ Runs verification tests
- ✓ 10-15 minutes (first time)

### Multiple Computers (2-10 PCs)
```bash
deploy_to_multiple_pcs.bat
```
Choose deployment method:
1. **USB** - Copy to USB, deploy offline
2. **Network Share** - Deploy via LAN
3. **Manual** - Step-by-step instructions

### Enterprise Deployment (10+ PCs)
```bash
deploy_powershell.bat
```
- Advanced remote deployment via PowerShell
- Batch processing multiple computers
- Automatic validation and reporting
- Network credentials support

📖 **Complete Guide:** See [DEPLOYMENT_AUTOMATION_GUIDE.md](DEPLOYMENT_AUTOMATION_GUIDE.md)

---

## ⚠️ CRITICAL REQUIREMENT: Tesseract-OCR

**Tesseract-OCR is MANDATORY** for this application to function. It is required for screenshot analysis and cannot be bypassed.

### Verification & Installation

**Verify Tesseract Installation:**
```bash
python verify_tesseract.py
```

This will check if Tesseract is properly installed and working with a comprehensive test report.

### Installation

**Windows:**
- The installer (`deploy_automated.bat` / `install_and_run.py`) automatically downloads and installs Tesseract
- Manual install: https://github.com/UB-Mannheim/tesseract/releases/download/v5.4.0/tesseract-ocr-w64-setup-v5.4.0.exe
- **Bundled**: If `tesseract-ocr-w64-setup-*.exe` exists in the folder, the installer will use it

**macOS:**
```bash
brew install tesseract
```

**Linux (Ubuntu/Debian):**
```bash
sudo apt-get install tesseract-ocr
```

**Linux (Fedora/RHEL):**
```bash
sudo dnf install tesseract
```

## 🔄 Autostart Configuration

The monitor is configured to automatically start when the computer boots or user logs in.

**Verify Autostart Setup (Windows):**
```bash
python verify_autostart.py
```

This will check if autostart is properly configured across all methods:
- Task Scheduler (most reliable)
- Registry entries (user & system-wide)
- VBS startup script (legacy)

---

## Project Structure

- `frontend-node`: Node.js + Express + EJS dashboard
- `backend-fastapi`: Python FastAPI API for upload, parsing, scoring, and ranking
- `docs`: architecture and workflow notes

## Quick Start

### 1) Backend

```bash
cd backend-fastapi
python -m venv .venv
.venv\\Scripts\\activate
pip install -r requirements.txt
copy .env.example .env
uvicorn app.main:app --reload --port 8000
```

### 2) Frontend

```bash
cd frontend-node
npm install
copy .env.example .env
npm run dev
```

Open `http://localhost:3000`.

## Core Workflow

1. Upload JD from the dashboard
2. Upload resumes (manual source now)
3. Run judge batch
4. Open ranked dashboard table
5. Click candidate action to open exact original resume

## Current Notes

- Ranking is implemented with weighted scoring:
  - JD relevance: 40%
  - Skills match: 35%
  - Experience match: 25%
- Confidence buckets:
  - HIGH: >= 80
  - MEDIUM: 60-79
  - LOW: < 60
- Gmail fetch worker is planned next and can post files into `/upload-resumes` with `source=gmail`.
