# ScribaSheet — Phase D: Worker Automation & Operational Reliability Audit

## 1. Root Cause Diagnosis: `Worker status unavailable`

### Confirmed Findings
1. **Local & Deployed Endpoint Presence**:
   - Local backend (`backend/app/api/v1/worker.py`) exposes `GET /api/v1/worker/status` under `get_current_user` Bearer JWT authentication.
   - Live Railway probe (`curl.exe -i -s https://scribasheet-production.up.railway.app/api/v1/worker/status`) returned `HTTP/1.1 401 Unauthorized` with `{"detail":"Authentication required."}`, confirming the route is deployed on Railway (not 404).
2. **Frontend Error Collapse (`frontend/src/components/WorkerStatusBadge.tsx`)**:
   - Previously, `if (isError || !data)` rendered `"Worker status unavailable"` identically for **every** failure mode (`401 Unauthorized`, `404 Not Found`, `500 Internal Server Error`, network/CORS failure, or non-JSON/unexpected response shapes) with no diagnostic context.
   - `frontend/src/types/api.ts` (`WorkerStatus`) and `backend/app/api/v1/worker.py` (`get_worker_availability`) already used matching field names (`worker_online`, `status`, `last_seen_seconds`, `worker_id`, `active_job_count`, `queue_depth`, `freshness_threshold_seconds`).
   - Local migrations include `backend/migrations/versions/e3a4c19f8b12_add_worker_nodes_table.py`.
3. **Why it can appear in production**:
   - If the user session lacks a valid Bearer token (`401`), if `VITE_API_BASE_URL` on Vercel is unset/misconfigured (causing `/api/v1/worker/status` to hit Vercel's static origin and return `404` or `index.html` HTML), or if Railway experiences a cold-start/DB error (`500`/`502`), `WorkerStatusBadge` previously collapsed all of those into `"Worker status unavailable"` without distinguishing the cause.
   - *Unverified assumption*: Whether Railway's production SQLite volume has `e3a4c19f8b12_add_worker_nodes_table.py` applied or whether Vercel's `VITE_API_BASE_URL` is set to `https://scribasheet-production.up.railway.app/api/v1` cannot be directly confirmed without an authenticated production user token or Vercel/Railway dashboard access.

---

## 2. Files Modified & Created

### Backend
- **Created** `backend/app/worker_lock.py` — `WorkerSingleInstanceLock` using Windows named kernel mutex (`CreateMutexW` / `WaitForSingleObject` / `ReleaseMutex` / `CloseHandle`, default `Local\ScribaSheetTranscriptionWorker`) with `fcntl.flock` fallback on POSIX.
- **Modified** `backend/app/worker_agent.py`:
  - Acquired `WorkerSingleInstanceLock` in `main()` before starting `RemoteWorkerAgent`, exiting gracefully with code `0` if another instance already owns the lock, and releasing cleanly in `finally:`.
  - Added bounded exponential backoff with jitter (`_compute_backoff`, capped at `45.0s`) in `run_forever()`, resetting backoff on successful coordinator communication.
  - Added `_post_with_retry()` for job completion submissions on transient `httpx.RequestError` or `429`/`502`/`503`/`504` responses while preserving lease-loss rejection (`403`/`409`) and cooperative shutdown.
- **Created** `backend/tests/test_worker_automation.py` — 6 tests covering multi-process single-instance mutex locking, graceful release, stale lock recovery after `SIGKILL`/forced termination, `worker_agent.main()` duplicate exit, `_post_with_retry()` + `run_forever()` network recovery, and `/api/v1/worker/status` online/offline/401/counts.

### Frontend
- **Modified** `frontend/src/components/WorkerStatusBadge.tsx`:
  - Validated response shape (`isValidWorkerStatus`) and distinguished **Worker Online** (`data-status="online"`), **Desktop Worker Offline** (`data-status="offline"`), and **Worker Status Unavailable** (`data-status="unavailable"` with diagnostic `title` and `aria-label` for `401`/`403`, `404`, `500+`, unexpected payload, or network failure).
  - Configured `useQuery` with `refetchInterval: 12000`, `refetchOnWindowFocus: false`, `retry: 1`.
- **Modified** `frontend/src/test/App.test.tsx` — Added `WorkerStatusBadge` test covering loading, online, offline, `401`/`404`/`500` unavailable states, and refresh behavior.

### PowerShell Automation Scripts
- **Created** `scripts/run_worker_background.ps1` — Resolves repo root dynamically, runs `backend\.venv\Scripts\python.exe -m app.worker_agent` from `backend\` with `PYTHONUNBUFFERED=1`, loads `backend\.env` / `backend\worker.env` without logging secrets, creates `logs\` if missing, rotates `logs\worker.log` at 5 MB (`worker.log.1`), and preserves worker exit code.
- **Created** `scripts/install_worker_autostart.ps1` — Registers `ScribaSheetTranscriptionWorker` in Windows Task Scheduler under current user (`Interactive`, `Limited` run level, no Admin elevation), triggered `AtLogOn`, using `powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass`, with `MultipleInstances IgnoreNew`, `RestartCount 3` (1-minute interval), and infinite execution time limit.
- **Created** `scripts/uninstall_worker_autostart.ps1` — Stops (if running) and unregisters only `ScribaSheetTranscriptionWorker` while preserving logs, project data, and `backend\.venv`.
- **Created** `scripts/worker_status.ps1` — Reports Scheduled Task state/last run/result, active `app.worker_agent` process PID, `logs\worker.log` path/size, and notes that Railway's heartbeat is authoritative for production availability.
- **Created** `scripts/dev.ps1` — Unified local dev launcher for FastAPI (`uvicorn`), Vite (`npm.cmd run dev`), and `run_worker_background.ps1` (skipping worker launch if already running).

---

## 3. Install & Uninstall Commands

Install and start the auto-start Scheduled Task (no Administrator elevation required):
```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install_worker_autostart.ps1
```

Check local task, process, and log status:
```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\worker_status.ps1
```

Stop and unregister the Scheduled Task:
```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\uninstall_worker_autostart.ps1
```

---

## 4. Verification Results

- **Backend pytest (`.\backend\.venv\Scripts\python.exe -m pytest backend\tests -q`)**: `77 passed` (includes 6 new tests in `backend/tests/test_worker_automation.py`).
- **Backend lint (`.\backend\.venv\Scripts\ruff.exe check backend\app backend\tests scripts`)**: `All checks passed!`
- **Frontend build & tests (`cd frontend; npm.cmd run build; npm.cmd test -- --run`)**: `tsc -b && vite build` succeeded; `13 passed` in `frontend/src/test/App.test.tsx`.
- **PowerShell validation**:
  - All 5 `.ps1` scripts parsed cleanly via `System.Management.Automation.Language.Parser::ParseFile` (`SYNTAX OK`).
  - `run_worker_background.ps1 -RotateOnly` rotated a >5 MB `logs\worker.log` to `logs\worker.log.1` (`LOG ROTATION OK`).
  - `install_worker_autostart.ps1 -TaskName ScribaSheetTestWorkerVerify -NoStart`, `worker_status.ps1`, and `uninstall_worker_autostart.ps1` registered, inspected, and cleanly removed an isolated test task (`TASK SCHEDULER LIFECYCLE OK`).

## 5. Local vs. Production Verification & Limitations

- **Verified locally**: Single-instance kernel mutex across real subprocesses, stale lock recovery after `SIGKILL`, retry/backoff recovery with `httpx.MockTransport`, `/api/v1/worker/status` via FastAPI `TestClient`, `WorkerStatusBadge` states in Vitest (`jsdom`), PowerShell syntax/log rotation, and Scheduled Task registration/removal.
- **Verified against live Railway (read-only)**: Confirmed `GET https://scribasheet-production.up.railway.app/api/v1/worker/status` is deployed and returns `401 Unauthorized` when unauthenticated.
- **Not verified in this run**: Live Windows reboot/logon trigger execution, live Railway/Vercel authenticated end-to-end badge rendering, and actual deployment (changes kept local per constraint; nothing committed, pushed, or deployed).
