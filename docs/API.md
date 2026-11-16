# ScribaSheet — API Reference (`/api/v1`)

Interactive OpenAPI documentation is served at `/docs` (Swagger UI), `/redoc`, and `/openapi.json`.

## Operations
- `GET /health` — Liveness check.
- `GET /ready` — Readiness check verifying Database, FFmpeg, Basic Pitch ONNX model, and Storage.

## Authentication & Users
- `POST /api/v1/auth/register` — Create user account and return access/refresh tokens.
- `POST /api/v1/auth/login` — Authenticate with email and password.
- `POST /api/v1/auth/refresh` — Exchange refresh token for new token pair.
- `POST /api/v1/auth/logout` — Sign out.
- `POST /api/v1/auth/verify-email` — Verify email token.
- `POST /api/v1/auth/forgot-password` — Request password reset token.
- `POST /api/v1/auth/reset-password` — Apply new password using reset token.
- `GET /api/v1/users/me` — Fetch current user profile.
- `PATCH /api/v1/users/me` — Update display name.
- `GET /api/v1/users/me/usage` — Fetch monthly transcription minutes, project count, and storage usage.
- `DELETE /api/v1/users/me` — Permanently delete account and all owned media/projects.

## Projects
- `GET /api/v1/projects` — List owned projects (`search`, `status`, `sort_by`, `sort_dir`, `page`, `page_size`).
- `POST /api/v1/projects` — Create a new project.
- `GET /api/v1/projects/{project_id}` — Get project details and media assets.
- `PATCH /api/v1/projects/{project_id}` — Update title, description, instrument, or mode.
- `POST /api/v1/projects/{project_id}/duplicate` — Duplicate project and its latest score.
- `DELETE /api/v1/projects/{project_id}` — Delete project and associated storage objects.

## Uploads
- `POST /api/v1/uploads` — Multipart upload (`project_id`, `file`). Enforces size, extension, MIME, and `ffprobe` audio stream validation.
- `POST /api/v1/uploads/url-check` — Evaluates external URLs without bypassing DRM or platform restrictions.
- `GET /api/v1/uploads/{upload_id}` — Fetch asset metadata.
- `GET /api/v1/uploads/{upload_id}/signed-url` — Generate time-limited signed stream URL.
- `GET /api/v1/uploads/{upload_id}/stream` — Stream private media via signed URL.
- `DELETE /api/v1/uploads/{upload_id}` — Delete media asset.

## Transcriptions
- `POST /api/v1/projects/{project_id}/transcriptions` — Enqueue AI transcription job (`202 Accepted`).
- `GET /api/v1/projects/{project_id}/transcriptions` — List jobs for project.
- `GET /api/v1/transcriptions/{job_id}` — Poll job status, progress, and stage.
- `POST /api/v1/transcriptions/{job_id}/cancel` — Cancel an active job.
- `POST /api/v1/transcriptions/{job_id}/retry` — Re-queue a failed/cancelled job.
- `WS /api/v1/ws/jobs/{job_id}?token=<jwt>` — Real-time job progress stream.

## Editor & Score
- `GET /api/v1/projects/{project_id}/score` — Fetch `score_json`, `musicxml`, and `version`.
- `PUT /api/v1/projects/{project_id}/score` — Save edited `score_json` (with optional `expected_version` optimistic lock) and regenerate MusicXML + MIDI.
- `GET /api/v1/projects/{project_id}/midi` — Stream latest `.mid` file.

## Exports & Billing
- `GET /api/v1/projects/{project_id}/exports` — List export history.
- `POST /api/v1/projects/{project_id}/exports` — Generate `midi`, `musicxml`, `pdf`, or `wav` export from latest saved score.
- `GET /api/v1/exports/{export_id}/download` — Download generated export file.
- `GET /api/v1/billing/plans` — List Free, Pro, and Studio plan tiers.
- `POST /api/v1/billing/checkout` — Stripe checkout readiness endpoint.
- `POST /api/v1/billing/webhook` — Signed Stripe webhook endpoint.
