# ScribaSheet — Deployment Guide

## Recommended Production Topology
- **Frontend:** Vercel / Cloudflare Pages / Static CDN (`cd frontend && npm run build`, serve `dist/`)
- **Backend API & Celery Worker:** Docker containers on Render, Railway, Fly.io, or AWS ECS (do **not** deploy audio transcription workers to short-timeout serverless functions)
- **Database:** Supabase PostgreSQL or managed PostgreSQL 16
- **Broker / Cache:** Managed Redis 7
- **Object Storage:** S3-compatible bucket (AWS S3, Cloudflare R2, or Supabase Storage) with private access

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
