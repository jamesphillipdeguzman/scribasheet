# ScribaSheet — Testing & Quality Assurance

## Backend Tests (`pytest`)
Tests cover authentication, ownership isolation, upload validation, real Spotify Basic Pitch AI transcription of synthesized audio, MusicXML generation, score editing/persistence, and MIDI/MusicXML/PDF/WAV exports.
```bash
cd backend
.venv\Scripts\pytest.exe -v
```

## Frontend Tests (`vitest`) & Production Build
```bash
cd frontend
npm run build
npm test
npm run lint
```

## End-to-End Verification
Backend integration tests exercise the full real AI transcription pipeline without mocking `BasicPitchProvider` or `music21`.
