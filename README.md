# ScribaSheet – AI Music Transcription Studio

**From Sound to Sheet Music.**

ScribaSheet is a full-stack AI-powered music transcription studio that transforms audio and video recordings into editable sheet music, MIDI, and MusicXML.

## Features

- **Authentication & Workspace Dashboard**: JWT authentication, user profiles, server-enforced usage quotas, project search/filter/sort, rename, duplicate, and delete.
- **Media Ingestion**: Drag-and-drop upload for MP3, WAV, FLAC, M4A, AAC, MP4, MOV, and WEBM, browser microphone recording, upload progress/cancellation, and server-side FFprobe/Librosa validation.
- **Genuine AI Transcription Pipeline**: FFmpeg/Librosa normalization + Spotify Basic Pitch (ONNX Runtime) audio-to-MIDI note detection + Music21 tempo, key, chord, and MusicXML generation.
- **Interactive Studio Workspace**:
  - **Sheet Music Viewer**: OpenSheetMusicDisplay rendering actual MusicXML with zoom controls.
  - **Piano Roll Editor**: Add, select, move, resize, delete notes, adjust velocity, grid snapping, and Undo/Redo with debounced autosave.
  - **A/B Playback Engine**: WaveSurfer.js original audio waveform + Web Audio polyphonic MIDI synthesizer + metronome + loop + playback speed.
  - **Chords & Guitar Tab**: Editable chord progression analysis and standard-tuning guitar string/fret mapping.
- **Multi-Format Export Center**: Export `.mid`, `.musicxml`, printable `.pdf` sheet music, and synthesized `.wav` audio from the latest saved score.

## Technology Stack

- **Frontend:** React 18, TypeScript, Vite, Tailwind CSS, React Router, TanStack Query, React Hook Form, Zod, WaveSurfer.js, OpenSheetMusicDisplay, Lucide React
- **Backend:** Python 3.12, FastAPI, Pydantic v2, SQLAlchemy 2.0, Alembic, FFmpeg, Librosa, Spotify Basic Pitch (ONNX Runtime), PrettyMIDI, Music21, ReportLab, Celery, Redis
- **Infrastructure:** PostgreSQL / SQLite, Redis, Docker Compose, Private Local / S3-Compatible Storage

## Local Development

### 1. Environment Setup
ScribaSheet keeps backend secrets strictly isolated from the frontend:

- **Backend (`backend/.env`)**: Copy `backend/.env.example` to `backend/.env` and configure secrets (`JWT_SECRET_KEY`, `SIGNED_URL_SECRET`, `DATABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, etc.).
- **Frontend (`frontend/.env`)**: Copy `frontend/.env.example` to `frontend/.env`. Only public `VITE_*` variables (`VITE_API_BASE_URL`, `VITE_WS_BASE_URL`) are permitted here; Vite is configured with `envDir: "."` and `envPrefix: "VITE_"`.
- Both `backend/.env` and `frontend/.env` are ignored by `.gitignore`.

### 2. Backend
```bash
cd backend
python -m venv .venv
.venv\Scripts\activate  # or source .venv/bin/activate
pip install -r requirements.txt
pip install --no-deps basic-pitch==0.4.0
alembic upgrade head
uvicorn app.main:app --reload --port 8000
```

### 3. Frontend
```bash
cd frontend
npm install
npm run dev
```
Open `http://localhost:5173`. API docs are at `http://localhost:8000/docs`.

### 4. Docker Compose
```bash
docker compose up --build
```

## Testing
```bash
# Backend
cd backend && pytest -v

# Frontend
cd frontend && npm run build && npm test && npm run lint
```

## Documentation
- [Implementation Plan](docs/IMPLEMENTATION_PLAN.md)
- [Architecture Decisions](docs/ARCHITECTURE_DECISIONS.md)
- [System Architecture](docs/ARCHITECTURE.md)
- [API Reference](docs/API.md)
- [Database Schema](docs/DATABASE.md)
- [Transcription Pipeline](docs/TRANSCRIPTION_PIPELINE.md)
- [Deployment Guide](docs/DEPLOYMENT.md)
- [Security & Privacy](docs/SECURITY.md)
- [Testing Guide](docs/TESTING.md)
- [User Guide](docs/USER_GUIDE.md)

## Known Limitations
- Spotify Basic Pitch is strongest on solo instruments and vocals; full-band multi-instrument mixes may require manual cleanup in the Piano Roll.
- Source separation (Demucs) is optional and disabled by default (`ENABLE_SOURCE_SEPARATION=false`).
- Stripe billing endpoints (`POST /api/v1/billing/checkout`, `POST /api/v1/billing/webhook`) require `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` to activate live payments.
