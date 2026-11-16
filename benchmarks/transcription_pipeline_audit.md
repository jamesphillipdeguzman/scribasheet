# ScribaSheet — Production Transcription Pipeline Audit (Phase 1)

**Date:** 2026-11-16  
**Scope:** End-to-end audit from uploaded audio to persisted score, MIDI, MusicXML, and PDF.

---

## 1. Complete 12-Stage Execution Sequence

| Stage | Production (`RealTranscriptionHandler` / `worker.py` / `exports.py`) | Local Pipeline (`workers/pipeline.py`) | Offline Evaluator (`scripts/evaluate_transcription.py`) | Caching / Bypass Risk |
| :--- | :--- | :--- | :--- | :--- |
| **1. Original Audio Retrieval** | `POST /worker/jobs/claim` issues presigned/signed download URL; `RealTranscriptionHandler.handle()` downloads via `httpx.Client.get()` into `TemporaryDirectory`. | `storage_service.read_bytes(asset.storage_key)` | Reads `--audio` `Path` directly; computes `wav_sha256`. | None (fresh read per job/run). |
| **2. Audio Validation** | `probe_media(input_path)` (`ffprobe` / `soundfile` fallback) -> `AudioMetadata`. | `probe_media(input_path)` | `probe_media(audio_path)` | None. |
| **3. Audio Preprocessing** | `preprocess_to_wav(input_path, processed_wav)` -> 22,050 Hz mono `PCM_16`, 27.5 Hz HPF, `-1 dBFS` peak norm. | `preprocess_to_wav(input_path, processed_wav)` (+ optional `separate_audio_stems`). | `preprocess_to_wav(audio_path, wav_path)` | **Gap:** No preprocessing profile selection (`general`/`piano`/`vocal`/`mixed`) or config hash persisted. |
| **4. Basic Pitch ONNX Inference** | `verify_onnx_cpu_runtime(resolve_onnx_model_path())`; `BasicPitchProvider().transcribe(processed_wav, ...)` (`nmp.onnx`, `CPUExecutionProvider`). | `BasicPitchProvider().transcribe(...)` | `verify_onnx_cpu_runtime(...)`; `BasicPitchProvider().transcribe(wav_path)` | **Gap:** `RemoteWorkerAgent` allows `WORKER_HANDLER=phase_a_test` env var to silently select `PhaseATestHandler` if misconfigured. |
| **5. Raw Note-Event Extraction** | `TranscriptionOutput.notes: list[DetectedNote]` | `TranscriptionOutput.notes` | `TranscriptionOutput.notes` (saved to `raw_notes.json`). | **Gap:** `ScoreData` only keeps `raw_onset_sec`/`raw_offset_sec` on surviving notes; dropped raw notes are not persisted in `ProjectScore`. |
| **6. Note-Event Refinement** | `refine_detected_notes(t_out.notes)` -> `NoteRefinementResult` | `refine_detected_notes(t_out.notes)` | `refine_detected_notes(raw_notes, config=cfg)` (saved to `refined_notes.json`). | **Gap:** Refiner config hash & pipeline version not persisted in `ScoreData.analysis` or `ProjectScore`. |
| **7. Tempo Estimation** | `estimate_tempo(processed_wav, settings.tempo_mode, settings.manual_tempo_bpm, notes=refined_notes)` | `estimate_tempo(..., notes=refined_notes)` | `estimate_tempo(wav_path, ..., notes=refined_notes)` (via `inspect.signature`). | None. |
| **8. Key & Chord Analysis** | `estimate_key_signature(refined_notes, ...)` + `detect_chords(score_notes, ...)` inside `build_score_data()`. | Same. | Same. | **Defect:** `estimate_key_signature` returns `"F"` instead of `"F major"`. |
| **9. MIDI Generation** | `score_data_to_midi_bytes(score_data)` -> validated with `pretty_midi`. | `score_data_to_midi_bytes(score_data)` | `score_data_to_midi_bytes(score_data)` | None. |
| **10. MusicXML Generation** | `score_data_to_musicxml(score_data)` -> validated with `music21.converter.parseData`. | `score_data_to_musicxml(score_data)` | `score_data_to_musicxml(score_data)` + XML per-voice tick validation. | None. |
| **11. PDF Rendering** | Rendered on demand in `POST /projects/{id}/exports` via `render_score_pdf(score)`. | Not run during transcription; rendered on demand in `exports.py`. | Rendered inline via `render_score_pdf(score_data)`. | **Gap:** `exports.py` renders from `ProjectScore.score_json`; old `ProjectScore` rows from earlier pipeline versions are NOT invalidated unless re-transcribed. |
| **12. Score & Artifact Persistence** | `POST /worker/jobs/{id}/complete` updates `ProjectScore` (increments `version` in-place) + `TranscriptionResult` + `Project.status="ready"`. | Updates `ProjectScore` + `TranscriptionResult`. | Writes JSON + artifacts to `--output` / `--artifacts-dir`. | **Gap:** `ProjectScore` overwrites `score_json` in-place (incrementing `version`) without storing `pipeline_version`, `model_version`, `preprocessing_config_hash`, `refiner_config_hash`, or `source_audio_sha256` to detect stale scores. |

---

## 2. Key Audit Findings & Required Corrections

1. **Silent `PhaseATestHandler` Risk:** `RemoteWorkerAgent.__init__` defaults `WORKER_HANDLER` to `"real"`, but if `WORKER_HANDLER=phase_a_test` is set in `.env`, it silently substitutes `PhaseATestHandler`. While `complete_job` rejects empty simulated scores, the worker should log an explicit warning/error or refuse `phase_a_test` unless explicitly permitted.
2. **Stale Score / Cache Invalidation Gap:** `ProjectScore` updates `version += 1` on re-transcription, and `exports.py` exports directly from `ProjectScore.score_json`. There is no `pipeline_version`, `model_version`, `preprocessing_config_hash`, `refiner_config_hash`, `source_audio_sha256`, or `run_id` recorded in `ScoreData.analysis` / `TranscriptionResult.metadata_json` to distinguish scores produced by outdated pipeline versions.
3. **Upstream Transcription Quality:**
   - Preprocessing needs explicit profile support (`general`, `piano`, `vocal`, `mixed`), DC offset removal, and clipping protection without attenuating low piano fundamentals (`A0 = 27.5 Hz`).
   - Note refinement (`note_refiner.py`) still leaves `21` suspected octave-duplicate pairs on the reference piano recording (`octave_ghosts_suppressed == 1`) and needs harmonic/octave evidence + sustain-tail offset refinement.
   - Tempo estimation (`analyzer.py`) should expose candidate tempos, confidence scores, and ambiguity flags rather than silently picking a single scalar.
   - Key & chord analysis (`analyzer.py`) returns `"F"` instead of `"F major"` and can be fooled by passing tones/suspensions.
   - PDF engraving (`generator.py`) currently uses proportional-time solid circles in ReportLab; locally, **MuseScore 4** (`C:\Program Files\MuseScore 4\bin\MuseScore4.exe`) is installed and can engrave `score.musicxml` into publication-grade sheet music when available, with ReportLab as the headless fallback.
