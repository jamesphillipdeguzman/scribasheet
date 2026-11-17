# ScribaSheet — Media Asset Removal & Replacement Audit

## 1. Summary of Changes

Implemented authenticated removal and replacement of uploaded `original` audio/video assets in ScribaSheet without altering transcription inference, beat/timing alignment, engraving, worker heartbeat/queueing, or cross-device sync.

### Backend (`backend/app/api/v1/projects.py`)
- Added `DELETE /api/v1/projects/{project_id}/media/{asset_id}` (`204 No Content`):
  - Enforces authentication and project ownership via `get_owned_project` (`404` if project missing, `403` if owned by another user).
  - Verifies the `MediaAsset` exists and belongs to `project.id` (`404` otherwise).
  - Restricts deletion to `asset_type == "original"` (`400 Bad Request` for generated assets such as `midi` or `musicxml`).
  - Blocks deletion with `409 Conflict` when any `TranscriptionJob` on the project is in `("queued", *ACTIVE_WORKER_STATUSES)` (`validating`, `preprocessing`, `separating`, `transcribing`, `generating_notation`, `finalizing`), leaving both DB records and stored media untouched.
  - Deletes the underlying object via `storage_service.delete(asset.storage_path)` (supporting both local disk and S3/R2), safely ignoring missing physical files (`FileNotFoundError`).
  - Clears `TranscriptionJob.source_asset_id` references to the deleted asset, removes the `MediaAsset` row, and updates `project.duration_seconds` / `project.status`:
    - When another `original` asset remains, retains its `duration_seconds`.
    - When no `original` asset remains and `project.score` is absent, resets `project.duration_seconds = None` and `project.status = "draft"`.
    - When `project.score` exists, preserves `ProjectScore`, MIDI, MusicXML, PDF, and `Export` records and preserves `project.status == "ready"`.

### Frontend
- `frontend/src/services/api.ts`: Added `api.deleteMediaAsset(projectId, assetId)`.
- `frontend/src/features/uploads/MediaUploader.tsx`:
  - Added an accessible Remove (`X`) button (`aria-label="Remove uploaded media"`, `title="Remove file"`, `min-h-[40px] min-w-[40px]` touch target, subtle destructive hover/focus styling) beside the green checkmark (`CheckCircle2`) on each uploaded media card.
  - Disabled the Remove button during active transcription (`isProcessing`), active upload (`uploadProgress !== null`), or in-flight deletion (`deletingAssetId !== null`), showing a spinner while deleting.
  - Added an inline confirmation dialog (`role="alertdialog"`) when `hasScore` is true: *"Remove this audio file? Your existing sheet music and transcription results will remain available."* Removes immediately when no score exists.
  - Clears the file input value on selection/removal so re-uploading the same filename works cleanly, and retains the asset while displaying errors (`409 Conflict`, auth, network) in the `role="alert"` banner.
- `frontend/src/features/projects/ProjectStudioPage.tsx`:
  - Wired `hasScore={Boolean(scoreData)}`, `isProcessing`, and `onMediaRemoved` (invalidating `["project", projectId]`) to `MediaUploader`.
- `frontend/src/features/editor/WaveformPlayer.tsx`:
  - When `mediaAssetId` becomes `null`, clears `signedAudioUrl`, pauses/destroys any active `WaveSurfer` instance, resets `isPlaying` to `false`, and resets playhead to `0`.

## 2. Verification Results

All checks were run locally after the final edit:

- **Backend pytest (`.\backend\.venv\Scripts\python.exe -m pytest backend\tests -q`)**: `71 passed` (includes 9 new regression tests in `backend/tests/test_media_asset_removal.py` covering draft reset, score/export preservation, `409 Conflict` on active jobs, cross-user rejection, `404` on missing/wrong-project assets, `401` unauthenticated, `400` on non-`original` assets, missing physical file handling, and replacement upload + new transcription job linkage).
- **Backend lint (`.\backend\.venv\Scripts\ruff.exe check backend\app backend\tests scripts`)**: `All checks passed!`
- **Frontend build (`cd frontend; npm.cmd run build`)**: `tsc -b && vite build` succeeded.
- **Frontend tests (`cd frontend; npm.cmd test -- --run`)**: `12 passed` in `frontend/src/test/App.test.tsx` (includes 5 new tests covering Remove button rendering & disabled state during processing, confirmation dialog when `hasScore=true`, clearing media card & uploading replacement, `409 Conflict` error retention, and `WaveformPlayer` reset when `mediaAssetId` becomes `null`).

## 3. Scope & Limitations

- Automated backend tests used FastAPI `TestClient` with an isolated SQLite database and local `StorageService` root; S3/R2 deletion branches were not executed against a live R2 bucket in this run.
- Frontend tests ran in Vitest (`jsdom`); live browser verification against a running Railway/Vercel deployment was not performed, and nothing was committed, pushed, or deployed.
