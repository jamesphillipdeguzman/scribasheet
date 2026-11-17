# ScribaSheet — Login Cancellation Regression Audit

## 1. Exact Root Cause of `(canceled)` Requests

In the previous cold-start/retry implementation (`frontend/src/services/api.ts`), `fetchWithTimeout()` created an `AbortController` with:
- `WAKEUP_TIMEOUT = 8_000 ms` on `wakeUpBackend()` (`GET /health`)
- `DEFAULT_REQUEST_TIMEOUT_MS = 15_000 ms` on `request()` (`POST /auth/login` and all API calls)

When Railway was cold-starting (taking longer than 8s for `/health` or 15s for `/auth/login`), `fetchWithTimeout` called `controller.abort()`, causing Chrome DevTools to report `health (canceled)` and `login (canceled)`. `request()` then treated `AbortError` as a transient network error and retried 3 more times (each timing out and aborting at 15s -> 4 total `login (canceled)` requests) before throwing `"Backend is waking up or temporarily unreachable. Please try again in a moment."`.

## 2. Relevant Files & Fixes

- **`frontend/src/services/api.ts`**:
  - Increased `DEFAULT_REQUEST_TIMEOUT_MS` and `WAKEUP_TIMEOUT_MS` to `30_000 ms` (30s) to accommodate Railway cold-start and startup migration delays without premature `AbortController` cancellation.
  - Increased `BASE_RETRY_DELAY_MS` to `800 ms` and `MAX_TOTAL_RETRY_WAIT_MS` to `8_000 ms` (up to `3` retries on `502`/`503`/`504` and transient network errors; never retrying `4xx` or caller-aborted requests).
  - Separated caller-initiated `AbortError` (rethrown immediately without retry or outage message) from internal timeout `AbortError` (`ApiError(504, "The server took too long to respond. Please try again.", true)`).
  - Kept `wakeUpBackend()` completely independent of `login()` (no shared `AbortController` or `AbortSignal`).
- **`frontend/src/features/auth/AuthContext.tsx`**:
  - Made `api.getUsage()` inside `login()` non-fatal so a transient usage fetch failure after a successful `api.login()` does not block login or redirect.
- **`frontend/src/features/auth/AuthPages.tsx`**:
  - Added `loginInFlightRef` in `LoginPage.onSubmit` to prevent overlapping login submissions from rapid clicks or StrictMode double-renders, and ignored caller `AbortError` rather than showing a false outage banner.
- **`frontend/src/test/App.test.tsx`**:
  - Added `completes LoginPage flow in StrictMode even when health warm-up fails, and recovers after 401` covering StrictMode, failed `/health`, `401` non-retry, subsequent valid login, JWT persistence in `localStorage`, and redirect to `/dashboard`.

## 3. Verification Results

- `cd frontend; npm.cmd run build`: `tsc -b && vite build` succeeded.
- `cd frontend; npm.cmd test -- --run`: `16 passed` in `frontend/src/test/App.test.tsx` (Vitest `jsdom`).
- **Remaining Production Verification**: Changes are kept local (not committed, pushed, or deployed). Live verification against `https://scribasheet.vercel.app/login` requires deploying both the Railway startup migration fix (`app.db.migrate`) and this Vercel frontend update.
