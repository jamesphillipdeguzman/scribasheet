# ScribaSheet — Architecture Decision Log

## ADR-001: Monorepo Structure (`frontend/` + `backend/`)
- **Decision:** Organize the repository with separate `frontend/` (Vite + React + TypeScript) and `backend/` (FastAPI + Python 3.12) directories, unified by `docker-compose.yml` and `docs/`.
- **Rationale:** Keeps Python ML/audio dependencies isolated from Node.js frontend tooling, enables independent deployment (e.g., Vercel for frontend, Docker/Render/Railway for backend+worker), and follows standard SaaS monorepo conventions.

## ADR-002: Database Layer (SQLAlchemy 2.0 + Alembic, PostgreSQL & SQLite Support)
- **Decision:** Use SQLAlchemy 2.0 ORM with Alembic migrations, targeting PostgreSQL (including Supabase PostgreSQL) in production/Docker while supporting SQLite for zero-dependency local testing.
- **Rationale:** Ensures strict relational integrity, proper indexes, and reproducible schema migrations without blocking local CI/test runs when a Postgres server is not running.

## ADR-003: Authentication Strategy (Self-Contained JWT + Optional Supabase Auth)
- **Decision:** Implement first-class JWT authentication (`PyJWT` + `bcrypt`/`passlib`) with email verification, password reset tokens, and ownership enforcement in FastAPI, alongside optional Supabase JWT verification (`SUPABASE_JWT_SECRET`).
- **Rationale:** Guarantees complete working authentication out of the box without requiring external credentials, while remaining seamlessly compatible with Supabase Auth in production.

## ADR-004: Background Job Architecture (Celery + Redis with Local Async Thread Fallback)
- **Decision:** Use Celery + Redis as the primary distributed task queue for audio preprocessing and AI transcription, with a configurable `JOB_EXECUTION_MODE=celery|local` that runs jobs in a managed background thread pool when Redis is unavailable in local development.
- **Rationale:** Never blocks FastAPI HTTP workers, provides identical persistent `TranscriptionJob` state machine transitions (`uploaded` → `queued` → `validating` → `preprocessing` → `separating` → `transcribing` → `generating_notation` → `finalizing` → `completed`/`failed`/`cancelled`), and allows full E2E testing in environments without Docker/Redis.

## ADR-005: AI Transcription Engine Abstraction (`TranscriptionProvider`)
- **Decision:** Abstract audio-to-MIDI behind `TranscriptionProvider` with `BasicPitchProvider` (Spotify Basic Pitch) as the primary engine.
- **Rationale:** Allows future addition of specialized polyphonic or instrument-specific models without rewriting the API or job pipeline, and enables honest reporting of model capabilities and limitations.

## ADR-006: Canonical Score Representation (`score_json` + MusicXML + MIDI)
- **Decision:** Store an editable canonical `score_json` representation alongside generated MusicXML and MIDI assets in `ProjectScores`. Editing in the UI updates `score_json` and triggers server-side regeneration of MusicXML and MIDI via `music21` and `pretty_midi`.
- **Rationale:** Ensures exported MIDI and MusicXML files always reflect the exact latest saved editor state rather than diverging from visual-only edits.

## ADR-007: Browser Playback Engine (WaveSurfer.js + Web Audio Polyphonic Synthesizer)
- **Decision:** Use WaveSurfer.js for original audio playback/waveform visualization and a Web Audio API polyphonic synthesizer (triangle/sine/piano-like envelope with ADSR + optional metronome) for real-time MIDI playback without requiring external soundfont CDN fetches that could fail offline.
- **Rationale:** Guarantees reliable, low-latency, zero-external-dependency MIDI playback and A/B comparison with the original recording.
