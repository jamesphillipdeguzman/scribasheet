# ScribaSheet — Production Railway API, CORS Preflight & Login Audit

## 1. Exact Root Cause of the Production Failure

Probing the live Railway service (`https://scribasheet-production.up.railway.app`) returned `502 Bad Gateway` (`Server: railway-hikari`, `x-railway-fallback: true`, `{"status":"error","code":502,"message":"Application failed to respond"}`) on **every** endpoint:

| Probe | Status | `Access-Control-Allow-Origin` | Responder |
|---|---|---|---|
| `GET /health` | `502 Bad Gateway` | Absent | `railway-hikari` edge proxy |
| `GET /api/v1/health` | `502 Bad Gateway` | Absent | `railway-hikari` edge proxy |
| `OPTIONS /api/v1/auth/login` (`Origin: https://scribasheet.vercel.app`) | `502 Bad Gateway` | Absent | `railway-hikari` edge proxy |
| `GET /api/v1/worker/status` (`Origin: https://scribasheet.vercel.app`) | `502 Bad Gateway` | Absent | `railway-hikari` edge proxy |

### Why the Container Failed to Respond After Commit `6cdf00d`
1. Before `6cdf00d`, Railway was running and returning FastAPI responses with CORS headers (`200 OK` on `OPTIONS /api/v1/worker/status`, `401 Unauthorized` on unauthenticated `GET /api/v1/worker/status`).
2. Commit `6cdf00d` updated `backend/Dockerfile` to `CMD ["sh", "-c", "alembic upgrade head && uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]`.
3. When Railway's persistent SQLite database was originally initialized without an `alembic_version` table (or without stamping `9a2f8e3e2cac`), running `alembic upgrade head` attempted to execute `9a2f8e3e2cac_initial_schema.py` (`CREATE TABLE users ...`) against an already-populated database, causing `alembic` to fail before `uvicorn` could ever start.
4. Because the container never listened on `$PORT`, Railway's edge proxy (`railway-hikari`) returned `502 Bad Gateway` without CORS headers—which Chrome surfaced in DevTools as a CORS preflight failure on `OPTIONS /api/v1/auth/login`.
5. Additionally, in `backend/app/main.py`, `CORSMiddleware` was previously registered *before* `@app.middleware("http")` (`BaseHTTPMiddleware`), meaning `BaseHTTPMiddleware` wrapped outside `CORSMiddleware` instead of `CORSMiddleware` being outermost.

*Note on Railway logs*: The `railway` CLI is not installed in this local environment, so raw Railway container stdout/stderr logs could not be fetched directly; the `502` + `x-railway-fallback: true` edge responses and `git show --stat 6cdf00d` confirm the container failed to respond on `$PORT` after `6cdf00d`.

---

## 2. Files Changed & Explanation of the Fix

- **`backend/app/db/migrate.py`** *(created)*: Added `run_startup_migrations()`, an idempotent Alembic startup runner that inspects the database:
  - If `alembic_version` is missing/empty **and** `users` already exists, it detects the highest schema revision already present (`e3a4c19f8b12`, `d29c258b766e`, or `9a2f8e3e2cac`), stamps it, and then runs `alembic upgrade head`.
  - Properly escapes `%` in SQLAlchemy URLs (`%%`) and passes the active connection via `cfg.attributes["connection"]`.
  - Still fails loudly on genuine migration errors.
- **`backend/migrations/env.py`** *(modified)*: Updated `run_migrations_online()` to honor `config.attributes.get("connection")` when invoked programmatically.
- **`backend/Dockerfile`** *(modified)*: Updated startup command to `CMD ["sh", "-c", "python -m app.db.migrate && exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]`.
- **`backend/app/main.py`** *(modified)*: Registered `CORSMiddleware` **after** `@app.middleware("http")` so `CORSMiddleware` is outermost, with explicit origins (`https://scribasheet.vercel.app`, `http://localhost:5173`, `http://127.0.0.1:5173`, plus `settings.BACKEND_CORS_ORIGINS`), `allow_credentials=True`, `allow_methods=["*"]`, and `allow_headers=["*"]`.
- **`backend/tests/test_production_cors_and_auth.py`** *(created)*: Added regression tests for `OPTIONS /api/v1/auth/login` preflight, unapproved origin rejection, login success/401/422 with CORS headers preserved, `/health`, clean DB migration, and legacy unstamped DB upgrade.

*(Authentication logic in `backend/app/api/v1/auth.py` and `backend/app/schemas/auth.py` matched the frontend payload and required no changes.)*

---

## 3. Verification Status

### Locally Verified
- **Backend pytest** (`cd backend; .\.venv\Scripts\python.exe -m pytest tests -q`): `84 passed`.
- **Backend lint** (`cd backend; .\.venv\Scripts\ruff.exe check app tests`): `All checks passed!`.
- **Alembic**: `alembic heads` -> `e3a4c19f8b12 (head)`; `alembic upgrade head` succeeded on a clean temporary SQLite DB, and `run_startup_migrations()` succeeded on both clean and unstamped legacy SQLite DBs.
- **Frontend build & tests** (`cd frontend; npm.cmd run build; npm.cmd test -- --run`): `tsc -b && vite build` succeeded; `14 passed`.

### Not Yet Executed (Kept Local Per Constraint)
- **Committed & pushed**: Not executed (`git` changes remain local for review).
- **Railway deployment**: Not yet deployed; live Railway currently still returns `502` from `6cdf00d`.
- **Production HTTP & browser login**: Must be verified after pushing and Railway redeploy completes.

---

## 4. Recommended Commit, Push & Post-Deploy Verification

```powershell
git add backend/app/db/migrate.py backend/migrations/env.py backend/Dockerfile backend/app/main.py backend/tests/test_production_cors_and_auth.py benchmarks/production_login_cors_audit.md
git commit -m "fix(api): make startup migrations idempotent and put CORSMiddleware outermost"
git push
```

Once Railway finishes deploying:
```powershell
curl.exe -i https://scribasheet-production.up.railway.app/health
curl.exe -i -X OPTIONS https://scribasheet-production.up.railway.app/api/v1/auth/login -H "Origin: https://scribasheet.vercel.app" -H "Access-Control-Request-Method: POST" -H "Access-Control-Request-Headers: content-type,authorization"
```
Then verify normal user login at `https://scribasheet.vercel.app`.
