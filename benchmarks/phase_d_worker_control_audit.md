# ScribaSheet — Phase D: Local Worker Controller & UI Control Audit

## 1. Architecture & Security Design

### Local Worker Controller (`backend/app/worker_controller.py`)
- **Loopback-Only Binding**: Strictly binds to `127.0.0.1` (default port `47832`, configurable via `WORKER_CONTROLLER_PORT`); rejects non-loopback hosts such as `0.0.0.0` with `ValueError`.
- **No ML Imports / No Arbitrary Commands**: Uses Python stdlib `http.server.ThreadingHTTPServer` and `subprocess.Popen` to manage only the fixed command `backend\.venv\Scripts\python.exe -m app.worker_agent` from `backend\` with `PYTHONUNBUFFERED=1`.
- **Pairing Authentication**: Generates a random 32-byte URL-safe token (`secrets.token_urlsafe(32)`) stored locally at `logs/worker_controller.token`. No secrets are embedded in the frontend bundle. `GET /health` reports controller reachability, while `GET /status` and `POST /worker/start|stop|restart` require a valid `X-Controller-Token` header (`hmac.compare_digest`).
- **Strict Origin & CSRF Protection**:
  - Validates `Origin` against an allowlist (`http://localhost:5173`, `http://127.0.0.1:5173`, `http://localhost:4173`, `http://127.0.0.1:4173`, `https://scribasheet.vercel.app`, `https://scribasheet-*.vercel.app`, plus `CONTROLLER_ALLOWED_ORIGINS`).
  - Handles `OPTIONS` preflight with `Access-Control-Allow-Private-Network: true` for Chrome HTTPS-to-`127.0.0.1` requests.
  - Requires `X-Requested-With: ScribaSheet` and `application/json` on `POST` endpoints.
- **Single-Instance & Log Handling**: Probes `WorkerSingleInstanceLock` before spawning so it never starts a duplicate worker when a Scheduled Task or manual terminal worker is active, and rotates `logs/worker.log` at 5 MB (`worker.log.1`), redacting sensitive token patterns from `log_tail`.

### Windows Controller Installation (`scripts/`)
- `scripts/run_worker_controller.ps1`: Runs `backend\.venv\Scripts\python.exe -m app.worker_controller` and rotates/writes `logs/controller.log`.
- `scripts/install_worker_controller.ps1`: Registers `ScribaSheetWorkerController` at current user logon (`Interactive`, `Limited` run level) and starts it immediately. The transcription worker itself is **not** auto-started unless explicitly configured.
- `scripts/uninstall_worker_controller.ps1`: Stops and unregisters only `ScribaSheetWorkerController`, preserving logs, project data, and `backend\.venv`.

### Frontend Controls
- `frontend/src/services/workerController.ts`: Typed client for `http://127.0.0.1:47832` storing the user's pairing token in `localStorage` (`scribasheet_controller_token`).
- `frontend/src/components/WorkerControlPanel.tsx`: Rendered on `DashboardPage` and `ProjectStudioPage`:
  - **Desktop**: Shows **Start Worker** when stopped, **Stop Worker** + **Restart Worker** when running, local PID, Railway heartbeat status (`Online`/`Offline`, active/queued counts), current job label, and last error/notice.
  - **Pairing**: Prompts for `logs\worker_controller.token` on `401`.
  - **Unavailable**: Displays `"Local Controller Not Connected"` with Windows setup instructions instead of faking worker startup.
  - **Mobile**: Explains that a mobile browser cannot control a Windows PC worker through its own `127.0.0.1` address, while allowing job submission and Railway status monitoring.

## 2. Verification Results

- **Backend pytest (`.\backend\.venv\Scripts\python.exe -m pytest backend\tests -q`)**: `80 passed` (includes 3 new tests in `backend/tests/test_worker_controller.py` covering non-loopback rejection, Origin/Private-Network/CSRF/token enforcement, and start/status/restart/stop/409 single-instance lifecycle).
- **Backend lint (`.\backend\.venv\Scripts\ruff.exe check backend\app backend\tests scripts`)**: `All checks passed!`
- **Frontend build & tests (`cd frontend; npm.cmd run build; npm.cmd test -- --run`)**: `tsc -b && vite build` succeeded; `14 passed` in `frontend/src/test/App.test.tsx` (includes `WorkerControlPanel` unavailable, start/stop, and mobile tests).
- **PowerShell validation**: `run_worker_controller.ps1`, `install_worker_controller.ps1`, and `uninstall_worker_controller.ps1` passed `Parser::ParseFile` and isolated Scheduled Task install/uninstall (`ScribaSheetTestControllerVerify`).

## 3. Scope & Limitations

- Local controller HTTP, Origin/Private-Network preflight, CSRF, pairing, and process lifecycle were verified locally via `ThreadingHTTPServer` + `httpx` and Vitest (`jsdom`).
- Live Chrome verification against the deployed Vercel HTTPS frontend was not executed in this run because nothing was committed, pushed, or deployed.
