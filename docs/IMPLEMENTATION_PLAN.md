# ScribaSheet — Implementation Plan & Checklist

**Product:** ScribaSheet — AI-Powered Music Transcription Studio  
**Tagline:** From Sound to Sheet Music.

---

## Phase 1 — Repository and Foundation
- [x] Inspect existing repository (`README.md`, Git status, available runtimes)
- [ ] Create `docs/IMPLEMENTATION_PLAN.md` and `docs/ARCHITECTURE_DECISIONS.md`
- [ ] Configure `.gitignore`, `.env.example`, and `docker-compose.yml`
- [ ] Set up `backend/` (FastAPI, Pydantic, SQLAlchemy, Alembic, structured logging, health/readiness endpoints)
- [ ] Set up `frontend/` (React, TypeScript, Vite, Tailwind CSS, shadcn/ui conventions, React Router, TanStack Query)
- [ ] Verify both frontend and backend start and pass baseline checks

## Phase 2 — Branding and User Interface
- [ ] Implement ScribaSheet dark studio design system (`#09090F`, `#11111B`, `#181825`, `#A78BFA`, `#8B5CF6`)
- [ ] Create distinctive ScribaSheet SVG brand mark and app icon
- [ ] Build responsive public landing page (Header, Hero with real studio preview, How It Works, Supported Instruments, Transcription Features, Interactive Editor overview, Export Formats, Example Workflow, Pricing, FAQ, Footer)
- [ ] Build authentication screens (Sign In, Register, Forgot Password, Reset Password, Verify Email)
- [ ] Build application shell and responsive user dashboard

## Phase 3 — Authentication and Database
- [ ] Implement relational models (`Users`, `Projects`, `MediaAssets`, `TranscriptionJobs`, `TranscriptionResults`, `ProjectScores`, `Exports`, `UsageRecords`)
- [ ] Configure Alembic migrations and verify migration execution
- [ ] Implement JWT authentication + password hashing + optional Supabase Auth JWT verification
- [ ] Implement user profile, settings, and account deletion
- [ ] Implement Project CRUD with strict backend ownership enforcement, search, sort, filter, rename, duplicate, delete

## Phase 4 — Upload and Audio Processing Foundation
- [ ] Implement private storage abstraction (Local private storage + S3/Supabase-compatible signed URLs)
- [ ] Implement upload validation (MIME + magic bytes/extension, size limits, path traversal protection)
- [ ] Implement audio/video upload UI (drag-and-drop, progress, cancellation, retry, microphone recording, waveform preview, honest video URL handling)
- [ ] Integrate FFmpeg & Librosa for metadata extraction, audio extraction from video, normalization, silence detection, and segmentation
- [ ] Implement background job runner (Celery + Redis + local async worker fallback) and WebSocket/polling status updates

## Phase 5 — Real AI Transcription
- [ ] Create `TranscriptionProvider` abstraction
- [ ] Integrate Spotify `basic-pitch` for genuine audio-to-MIDI note detection
- [ ] Extract note onset, offset, pitch, velocity, and confidence
- [ ] Generate genuine `.mid` files via `pretty_midi`
- [ ] Implement musical analysis (tempo, time signature, key signature, pitch distribution, chord candidates)
- [ ] Test against real synthesized and recorded audio

## Phase 6 — Music Notation
- [ ] Integrate `music21` to convert transcribed MIDI + musical analysis into valid MusicXML
- [ ] Support clefs (treble, bass, grand staff), key signatures, time signatures, tempo markings, measures, rests, ties, chords
- [ ] Integrate `OpenSheetMusicDisplay` (OSMD) in the frontend to render actual MusicXML
- [ ] Handle zoom, page navigation, and responsive rendering

## Phase 7 — Interactive Editor
- [ ] Build multi-panel Studio Workspace (Toolbar, Notation Canvas, Piano Roll, Audio Waveform, Chord View, Guitar Tablature, Track/Instrument Panel)
- [ ] Implement note editing (select, move, pitch, duration, add, delete, onset/offset, accidentals, octave, undo/redo)
- [ ] Synchronize score JSON model with backend `PUT /api/v1/projects/{id}/score` (regenerating MusicXML and MIDI on save)
- [ ] Implement debounced autosave, save status, conflict handling, and unsaved changes warning

## Phase 8 — Playback and Exports
- [ ] Implement WaveSurfer.js original audio waveform playback with seek, zoom, speed, loop
- [ ] Implement Web Audio / Soundfont polyphonic MIDI playback synchronized with score cursor
- [ ] Implement A/B comparison between Original Audio and Transcribed MIDI
- [ ] Implement Export Center: MIDI (`.mid`), MusicXML (`.musicxml`), PDF sheet music, WAV audio rendering, and Export History

## Phase 9 — Advanced Capabilities
- [ ] Implement optional source separation layer (Demucs-compatible abstraction with honest availability reporting)
- [ ] Implement instrument-specific transcription configuration (modes, instruments, range, quantization, sensitivity, transposing instruments)
- [ ] Implement Chord Analysis view with user correction
- [ ] Implement Guitar Tablature view & string/fret calculation/editing

## Phase 10 — SaaS and Production Readiness
- [ ] Implement usage tracking (`UsageRecords`), configurable plan quotas (Free, Pro, Studio), and Stripe webhook/checkout readiness
- [ ] Harden security (CORS, rate limiting, security headers, error sanitization, ownership tests)
- [ ] Complete all documentation (`docs/*.md`, `README.md`)
- [ ] Run full QA: Backend Pytest, Frontend Vitest, TypeScript check, Lint, Production Build, Playwright E2E with real AI transcription
