# ScribaSheet — Deployment Guide

## Recommended Production Topology
- **Frontend:** Vercel / Cloudflare Pages / Static CDN (`cd frontend && npm run build`, serve `dist/`)
- **Backend API & Celery Worker:** Docker containers on Render, Railway, Fly.io, or AWS ECS (do **not** deploy audio transcription workers to short-timeout serverless functions)
- **Database:** Supabase PostgreSQL or managed PostgreSQL 16
- **Broker / Cache:** Managed Redis 7
- **Object Storage:** S3-compatible bucket (AWS S3, Cloudflare R2, or Supabase Storage) with private access

## Railway + Cloudflare R2 + Local Windows Worker (Zero-Redis Setup)

### 1. Railway Persistent Volume for SQLite
1. In your Railway backend service, attach a **Volume** mounted at `/data`.
2. Set `DATABASE_URL=sqlite:////data/scribasheet.db` (SQLite WAL mode is enabled automatically by `backend/app/db/session.py`).
3. Set `JOB_EXECUTION_MODE=remote_worker` and a strong `WORKER_API_TOKEN`.
4. Run `alembic upgrade head` in the start command before launching `uvicorn`.

### 2. Cloudflare R2 Private Bucket
1. Create a private R2 bucket (e.g., `scribasheet-private`) and an R2 API Token with Object Read & Write permissions.
2. Configure CORS on the R2 bucket to allow `PUT` and `GET` from your Vercel frontend origin.
3. Set in Railway backend environment:
   - `STORAGE_BACKEND=s3`
   - `S3_ENDPOINT_URL=https://<ACCOUNT_ID>.r2.cloudflarestorage.com`
   - `S3_BUCKET_NAME=scribasheet-private`
   - `S3_ACCESS_KEY_ID=<r2-access-key-id>`
   - `S3_SECRET_ACCESS_KEY=<r2-secret-access-key>`
   - `S3_REGION=auto`

### 3. Local Windows 11 Worker Startup (PowerShell)
```powershell
cd backend
.venv\Scripts\Activate.ps1
$env:SCRIBASHEET_API_URL = "https://<your-railway-app>.up.railway.app/api/v1"
$env:WORKER_API_TOKEN = "<same-token-as-railway>"
$env:WORKER_ID = "win11-ryzen-home"
python -m app.worker_agent
```

## Local Docker Compose
1. Copy `.env.example` to `.env` and set strong `JWT_SECRET_KEY` and `SIGNED_URL_SECRET`.
2. Start all services (`postgres`, `redis`, `backend`, `worker`, `frontend`):
   ```bash
   docker compose up --build
   ```
3. Verify health and readiness:
   - `http://localhost:8000/health`
   - `http://localhost:8000/ready`
   - `http://localhost:5173`

## Production Checklist
- Set `ENVIRONMENT=production` and `DEBUG=false`.
- Configure `DATABASE_URL=postgresql+psycopg://...`.
- Run `alembic upgrade head` on release.
- Set `JOB_EXECUTION_MODE=celery` with `REDIS_URL`, `CELERY_BROKER_URL`, and `CELERY_RESULT_BACKEND`.
- Set `STORAGE_BACKEND=s3` and configure `S3_BUCKET_NAME`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`.
- Set `BACKEND_CORS_ORIGINS` strictly to your production frontend origin.
