# ScribaSheet — Phase D: Local Worker Controller & Railway Worker Status Audit

## 1. Root Cause Diagnosis

### Issue 1 — Local Worker Controller Connection Refused (`127.0.0.1:47832`)
- **Symptom**: Windows Scheduled Task `ScribaSheetWorkerController` exited immediately with `LastTaskResult: 1`, and `logs/controller.log` stopped right after `[INFO] Starting ScribaSheet local worker controller on 127.0.0.1`.
- **Root Cause**: `scripts/run_worker_controller.ps1` (and `scripts/run_worker_background.ps1`) set `$ErrorActionPreference = "Stop"` and piped `& $PythonExe -m app.worker_controller 2>&1`. Python's `logging.basicConfig()` writes `INFO` logs to `stderr`, which PowerShell wraps as `ErrorRecord` objects; under `$ErrorActionPreference = "Stop"`, the very first `INFO` log line triggered a terminating `NativeCommandError`, exiting the script with code `1` before the HTTP server could stay running.
- **Fix**: Wrapped the Python invocation in `$ErrorActionPreference = "Continue"` (and `$PSNativeCommandUseErrorActionPreference = $false` when present) in both `scripts/run_worker_controller.ps1` and `scripts/run_worker_background.ps1`, logging `ErrorRecord.Exception.Message` cleanly and restoring `$ErrorActionPreference` afterward. Updated `scripts/install_worker_controller.ps1` to validate `import app.worker_controller`, start the task, and poll `http://127.0.0.1:47832/health` until `HTTP 200 OK` is confirmed.

### Issue 2 — Railway `GET /api/v1/worker/status` HTTP 500 + CORS Error
- **Symptom**: Authenticated `GET https://scribasheet-production.up.railway.app/api/v1/worker/status` returned `HTTP 500` without CORS headers in browser console, while unauthenticated `OPTIONS` returned `200` and unauthenticated `GET` returned `401` with `access-control-allow-origin: https://scribasheet.vercel.app`.
- **Root Cause**:
  1. `backend/Dockerfile` ran `CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]` without running `alembic upgrade head`. On Railway, if `e3a4c19f8b12_add_worker_nodes_table.py` has not been applied to the persistent SQLite database, querying `WorkerNode` raises `OperationalError: no such table: worker_nodes`.
  2. Because `worker_status` did not catch `SQLAlchemyError` and raise `HTTPException(500, ...)`, Starlette's outer `ServerErrorMiddleware` handled the unhandled exception *outside* `CORSMiddleware`, stripping `Access-Control-Allow-Origin` from the 500 response.
- **Fix**:
  1. `backend/app/api/v1/worker.py`: Wrapped `get_worker_availability(db)` in `worker_status()` to log `SQLAlchemyError` / unexpected exceptions via `logger.exception(...)` and raise `HTTPException(500, ...)` so FastAPI's `ExceptionMiddleware` (inside `CORSMiddleware`) preserves CORS headers on 500 responses instead of masking DB errors or stripping CORS.
  2. `backend/app/core/config.py` & `backend/app/main.py`: Ensured `https://scribasheet.vercel.app`, `http://localhost:5173`, and `http://127.0.0.1:5173` are always included in `CORSMiddleware` `allow_origins` without wildcards.
  3. `backend/Dockerfile`: Updated `CMD` to run `alembic upgrade head && uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}` on startup.

---

## 2. Files Changed

- `scripts/run_worker_controller.ps1` — Fixed `$ErrorActionPreference` around Python `stderr` logging.
- `scripts/run_worker_background.ps1` — Fixed `$ErrorActionPreference` around Python `stderr` logging.
- `scripts/install_worker_controller.ps1` — Added `import app.worker_controller` check and mandatory `http://127.0.0.1:47832/health` HTTP 200 verification.
- `backend/app/api/v1/worker.py` — Logged DB/unexpected errors in `worker_status` and raised `HTTPException(500)` so CORS headers are preserved.
- `backend/app/core/config.py` — Added `https://scribasheet.vercel.app` to `BACKEND_CORS_ORIGINS` default.
- `backend/app/main.py` — Merged `settings.BACKEND_CORS_ORIGINS` with `http://localhost:5173`, `http://127.0.0.1:5173`, and `https://scribasheet.vercel.app` in `CORSMiddleware`.
- `backend/Dockerfile` — Added `alembic upgrade head` before `uvicorn` startup.
- `backend/tests/test_worker_automation.py` — Added `test_worker_status_empty_naive_tz_cors_and_db_error` covering empty DB, naive timestamps, production `Origin` `OPTIONS`/`GET`, and DB error 500 + CORS headers.
- Plus earlier Phase D controller implementation files: `backend/app/worker_controller.py`, `backend/tests/test_worker_controller.py`, `scripts/uninstall_worker_controller.ps1`, `frontend/src/services/workerController.ts`, `frontend/src/components/WorkerControlPanel.tsx`, `frontend/src/features/dashboard/DashboardPage.tsx`, `frontend/src/features/projects/ProjectStudioPage.tsx`, `frontend/src/test/App.test.tsx`.

---

## 3. Verification Results

### Local Controller & Scheduled Task
- `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install_worker_controller.ps1`:
  - Registered and started `ScribaSheetWorkerController` (`State: Running`).
  - Verified `http://127.0.0.1:47832/health` -> `HTTP 200 OK`.
  - Verified `GET http://127.0.0.1:47832/status` with `Origin: https://scribasheet.vercel.app` and `X-Controller-Token` -> `worker_running: false`.
  - Verified `POST /worker/start` (`worker_running=True, pid=14120`), `POST /worker/restart` (`worker_running=True, pid=26156`), and `POST /worker/stop` (`worker_running=False`).

### Backend, Migrations & Frontend
- **Alembic migration chain** (`alembic upgrade head` on clean SQLite): `9a2f8e3e2cac -> d29c258b766e -> e3a4c19f8b12 (head)`.
- **Backend pytest** (`.\backend\.venv\Scripts\python.exe -m pytest backend\tests -q`): `81 passed`.
- **Ruff lint** (`.\backend\.venv\Scripts\ruff.exe check backend\app backend\tests scripts`): `All checks passed!`.
- **Frontend build & tests** (`cd frontend; npm.cmd run build; npm.cmd test -- --run`): `tsc -b && vite build` succeeded; `14 passed`.

### Production (Railway / Vercel)
- **Verified read-only on live Railway**: `OPTIONS /api/v1/worker/status` (`Origin: https://scribasheet.vercel.app`) returned `200 OK` with `access-control-allow-origin: https://scribasheet.vercel.app`; unauthenticated `GET` returned `401` with CORS headers.
- **Production Deployment Required**: Changes are local only (not committed, pushed, or deployed). Once reviewed and deployed to Railway, `alembic upgrade head` (now in `backend/Dockerfile`) will apply `e3a4c19f8b12` to Railway's SQLite volume and resolve the authenticated `500` on `GET /api/v1/worker/status`.
