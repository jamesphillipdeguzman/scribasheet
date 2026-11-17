# ScribaSheet — Mobile Experience, Worker Availability & Cross-Device Synchronization Audit

**Date:** 2026-11-17  
**Branch:** `feature/transkun-piano-provider`

---

## 1. Root Causes Identified

1. **Frozen Mobile Queue Appearance:** No persistent worker-liveness state existed on the backend (`GET /api/v1/worker/status` did not exist). `TranscriptionConfigPanel` rendered a spinning `Loader2` for any non-terminal job—including unclaimed `queued` jobs when the Windows worker was offline.
2. **Cross-Device Synchronization:** Audit of `frontend/src/` confirmed `localStorage` is used **only** for JWT tokens (`scribasheet_access_token`, `scribasheet_refresh_token`); projects, assets, scores, and exports are already fetched from the authenticated FastAPI backend. No device-local project storage or `localhost` URLs were persisted.
3. **Mobile Horizontal Overflow Vectors:**
   - `AppShell` had no mobile navigation drawer for `< sm` screens.
   - `ProjectStudioPage` lacked `min-w-0` on CSS Grid `<aside>` and `<section>` columns, allowing wide WaveSurfer, OSMD, and Piano Roll canvases to expand grid tracks past `360px`.
   - `SheetMusicViewer`, `PianoRollEditor`, `WaveformPlayer`, and `ExportCenter` needed `min-w-0 w-full max-w-full` constraints and internal `overflow-x-auto` containers with `touch-pan-x touch-pan-y`.

---

## 2. Changes Implemented

### Backend (`backend/app/`)
- `models/entities.py`, `models/__init__.py`, `migrations/versions/e3a4c19f8b12_add_worker_nodes_table.py`: Added persistent `WorkerNode` table (`worker_id`, `status`, `last_seen_at`, `active_job_id`).
- `core/config.py`: Added `WORKER_HEARTBEAT_INTERVAL_SECONDS=20` and `WORKER_ONLINE_THRESHOLD_SECONDS=45`.
- `api/v1/worker.py`: Added `_record_worker_activity()` across `claim`, `heartbeat`, `progress`, `complete`, `fail`; added `POST /api/v1/worker/offline` and authenticated `GET /api/v1/worker/status`.
- `schemas/transcription.py` & `api/v1/transcriptions.py`: Added `worker_online` to `TranscriptionJobResponse`; `start_transcription` & `retry_transcription_job` set `current_stage="Waiting for Desktop Worker"` when worker is offline.
- `worker_agent.py`: Sends best-effort `POST /api/v1/worker/offline` on clean shutdown.

### Frontend (`frontend/src/`)
- `types/api.ts` & `services/api.ts`: Added `WorkerStatus` and `api.getWorkerStatus()`.
- `components/WorkerStatusBadge.tsx`: Compact responsive status pill (`Desktop Worker Online` / `Desktop Worker Offline`, last-seen age, queue depth).
- `components/AppShell.tsx`: Added `< sm` mobile menu toggle (`44×44` touch target) with Dashboard, Account, usage quota, and Sign Out.
- `features/dashboard/DashboardPage.tsx`: Added `WorkerStatusBadge`, single-column phone grid (`grid-cols-1 sm:grid-cols-2 lg:grid-cols-3`), `min-w-0` + `truncate` on project titles, and `44px` CTA buttons.
- `features/transcription/TranscriptionConfigPanel.tsx`: Replaced misleading spinner on unclaimed `queued` jobs with `Waiting for Desktop Worker` explanation, 30-second waiting prompt, `Cancel` button, and offline `Queue for Later` / `Cancel` confirmation.
- `features/projects/ProjectStudioPage.tsx`: Added `min-w-0` on grid columns, `WorkerStatusBadge`, horizontally scrollable workspace tabs (`flex-nowrap overflow-x-auto`), adaptive polling (`5000ms` when queued offline, `1500ms` when active), and offline waiting state in the Sheet Music panel.
- `features/editor/SheetMusicViewer.tsx`, `PianoRollEditor.tsx`, `WaveformPlayer.tsx`, `ExportCenter.tsx`: Added `w-full min-w-0 max-w-full` containment, internal `overflow-x-auto` with `touch-pan-x touch-pan-y`, and `44px` mobile export buttons.

---

## 3. Verification Status

- **Implemented & Tested Locally (Automated):**
  - `backend/tests/test_worker_availability_and_sync.py`: Worker heartbeat freshness, offline/online transitions, stale heartbeat detection, offline job queuing, cancellation preventing claim, and cross-device / cross-user isolation.
  - `frontend/src/test/App.test.tsx`: Worker status badge, offline queue choice (`Queue for Later` vs `Cancel`), and `Waiting for Desktop Worker` UI + cancellation.
- **Not Yet Verified in Live Browser / Physical Android Device:**
  - Live Chrome DevTools viewport inspection (`360×740`, `375×812`, `412×915`, `430×932`, `768×1024`, `1366×768`) and physical Android end-to-end testing against deployed Railway/Vercel were not executed in this local session.
