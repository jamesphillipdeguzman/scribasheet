# ScribaSheet — Security & Privacy

## Authentication & Authorization
- Passwords hashed with `bcrypt` (cost factor 12).
- Short-lived JWT access tokens + refresh tokens (`PyJWT`), with optional Supabase Auth JWT verification.
- Every project, upload, transcription job, score, and export endpoint enforces backend ownership (`resource.user_id == current_user.id`), returning `403 Forbidden` for unauthorized access.

## Private Media Storage
- Uploaded audio/video files and generated MIDI/MusicXML/export artifacts are stored in private storage (`STORAGE_BACKEND=local` or private S3 bucket).
- Filenames are sanitized via `sanitize_filename()` and stored under UUID-prefixed keys with path-traversal checks.
- Media streaming uses HMAC-SHA256 signed URLs (`create_signed_download_token`) with configurable expiration (`SIGNED_URL_TTL_SECONDS`).

## Input & Upload Validation
- Strict extension & MIME type allowlist (`MP3, WAV, FLAC, M4A, AAC, OGG, MP4, MOV, WEBM`).
- Streaming upload size enforcement (`MAX_UPLOAD_SIZE_MB`).
- Server-side `ffprobe` / `soundfile` media stream inspection and duration limits (`MAX_AUDIO_DURATION_SECONDS`).

## HTTP & API Hardening
- Rate limiting via `slowapi` (`120/minute` default).
- Security headers (`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`).
- Structured logging with `X-Request-ID` without logging secrets or raw passwords.
- Account deletion (`DELETE /api/v1/users/me`) cascades database records and deletes stored media files.
