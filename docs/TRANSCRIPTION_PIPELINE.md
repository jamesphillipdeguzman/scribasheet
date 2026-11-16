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

## Local Windows CPU Worker Execution (Phase B)
- **Model:** Spotify Basic Pitch (`basic-pitch==0.4.0`, Apache-2.0 License) using the bundled ONNX model (`basic_pitch/saved_models/icassp_2022/nmp.onnx`) on `onnxruntime` `CPUExecutionProvider`.
- **Target Hardware:** Runs sequentially (1 job at a time) on CPU (e.g., AMD Ryzen 3 3100, 16 GB RAM; no CUDA/GPU required).
- **Running Real Transcription Worker:**
  ```powershell
  cd backend
  .\.venv\Scripts\Activate.ps1
  $env:SCRIBASHEET_API_URL = "https://scribasheet-production.up.railway.app/api/v1"
  $env:WORKER_API_TOKEN = "<your-worker-api-token>"
  $env:WORKER_ID = "win11-ryzen-home"
  python -m app.worker_agent
  ```
- **Simulated vs. Real Jobs:** `RealTranscriptionHandler` is the default. `PhaseATestHandler` is only used when `WORKER_HANDLER=phase_a_test` is explicitly set for lifecycle testing, and marks completions `is_simulated=True` so they never mark a project `ready` or create a `ProjectScore`.

## Known Model Limitations
- Spotify Basic Pitch is strongest on **solo instruments and vocals**. Full-band multi-instrument mixes may have overlapping or merged note events.
- Automatic tempo and key detection are estimates and are labeled `(est.)` in the Studio.
- Standard MIDI does not contain guitar fingering; guitar tablature string/fret values are calculated for standard tuning (E2–E4) and are editable.
