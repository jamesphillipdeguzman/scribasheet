# ScribaSheet — System Architecture

## Overview
ScribaSheet is a full-stack AI music transcription studio with cleanly separated frontend, backend API, background worker, database, and private object storage layers.

```
[React + Vite Frontend]
   ├── WaveSurfer.js (Original Audio Playback)
   ├── Web Audio MidiSynthesizer (Transcribed MIDI Playback)
   ├── OpenSheetMusicDisplay (MusicXML Notation)
   └── Interactive Piano Roll, Chords & Guitar Tab Editor
          │ HTTPS REST (/api/v1) + WebSocket (/api/v1/ws/jobs/{id})
          ▼
[FastAPI Backend API]
   ├── Auth & User Quotas (JWT / Optional Supabase Auth)
   ├── Project & Score Persistence (Optimistic Versioning)
   ├── Media Upload & Validation (MIME, Size, FFprobe)
   └── Export Engine (MIDI, MusicXML, PDF, WAV)
          │ Enqueue Job (Celery/Redis or Local Thread Pool)
          ▼
[Background Transcription Worker]
   ├── FFmpeg + Librosa (22.05 kHz Mono WAV Normalization)
   ├── Optional Source Separation (Demucs-compatible interface)
   ├── Spotify Basic Pitch ONNX (Audio-to-MIDI Note Detection)
   └── Music21 + PrettyMIDI (Tempo, Key, Chords, MusicXML, MIDI)
          │
          ▼
[PostgreSQL / SQLite]  +  [Private Object Storage (Local / S3 / Supabase)]
```

## Key Design Principles
1. **Asynchronous Processing:** Heavy audio preprocessing and AI transcription never block FastAPI HTTP request handlers.
2. **Canonical Score Model:** `ProjectScores` stores `score_json` alongside regenerated `.musicxml` and `.mid` artifacts so that editor changes are always reflected in exports.
3. **Private-by-Default Storage:** User uploads and generated artifacts are stored outside public web roots and accessed via authenticated endpoints or HMAC-signed URLs.
4. **Honest Status Reporting:** Job stages (`queued`, `validating`, `preprocessing`, `separating`, `transcribing`, `generating_notation`, `finalizing`, `completed`, `failed`, `cancelled`) reflect actual executed backend operations.
