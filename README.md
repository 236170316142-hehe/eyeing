# AI-Driven Recruitment Hub

Node.js dashboard + FastAPI AI backend scaffold based on your PRD.

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
