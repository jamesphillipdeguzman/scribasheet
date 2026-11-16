# ScribaSheet — AI Transcription Pipeline

## Pipeline Stages
1. **Validating (`validating`)**: Verifies source `MediaAsset` exists and probes audio streams via `ffprobe` / `soundfile`.
2. **Preprocessing (`preprocessing`)**: Extracts audio from video (if applicable), resamples to 22,050 Hz mono PCM WAV via FFmpeg (with Librosa fallback), checks duration limits, detects silence, and peak-normalizes amplitude.
3. **Optional Source Separation (`separating`)**: Only runs when `enable_source_separation` is requested AND `ENABLE_SOURCE_SEPARATION=true` with a configured backend (e.g., `demucs`). Otherwise proceeds honestly with direct transcription.
4. **Audio-to-MIDI (`transcribing`)**: Runs Spotify **Basic Pitch** (`nmp.onnx` via ONNX Runtime) with configurable `onset_threshold`, `frame_threshold`, `min_note_length_ms`, pitch range, and transposition. Produces genuine detected note events with onset, offset, pitch, velocity, and confidence.
5. **Musical Analysis & Notation (`generating_notation`)**:
   - Estimates tempo via `librosa.beat.beat_track` (unless manual BPM is specified).
   - Estimates key signature via `music21` Krumhansl-Schmuckler analysis.
   - Quantizes note timing to selected rhythmic grid (`none`, `eighth`, `sixteenth`, `thirtysecond`).
   - Detects harmonic chord candidates per measure window.
   - Generates valid MusicXML via `music21` (supporting treble, bass, and piano grand staff split at C4/MIDI 60) and `.mid` via `pretty_midi`.
6. **Finalizing (`finalizing` → `completed`)**: Saves MIDI, MusicXML, `ProjectScore`, `TranscriptionResult`, and `UsageRecord`.

## Known Model Limitations
- Spotify Basic Pitch is strongest on **solo instruments and vocals**. Full-band multi-instrument mixes may have overlapping or merged note events.
- Automatic tempo and key detection are estimates and are labeled `(est.)` in the Studio.
- Standard MIDI does not contain guitar fingering; guitar tablature string/fret values are calculated for standard tuning (E2–E4) and are editable.
