# ScribaSheet — Production-Grade Music Transcription Quality Report

**Date:** 2026-11-16  
**Pipeline Version:** `2.1.0` (`basic-pitch-0.4.0-nmp-onnx`, `CPUExecutionProvider`)  
**Reference Audio:** `assets/test_audio/soft-easy-piano-calming-melody_75bpm_F_major.wav`  
**Verified SHA-256:** `908E18DF558BF4CC2BBDD2CBAA8E7D4DCE972B3CB24E45E59293CCD636DCF497`

---

## 1. Before / After Benchmark Comparison

| Metric | Pre-Fix (`d9afd2a`) | Phase B.2 | Overhaul (`20261116_overhaul_f_major`) |
| :--- | :---: | :---: | :---: |
| **Tempo (Expected 75.0 BPM)** | `143.6 BPM` (`+68.6`) | `73.8 BPM` (`1.2`) | `73.8 BPM` (`1.2`, conf `0.897`, ambiguous `true`) |
| **Key (Expected `F major`)** | `"F"` (`exact_match: false`) | `"F"` (`exact_match: false`) | **`"F major"`** (`exact_match: true`) |
| **Preprocessing Profile** | none (22.05 kHz mono) | 27.5 Hz HPF, -1 dBFS | **`piano`** (`24.0 Hz` HPF, DC removal, `-1 dBFS`) |
| **Raw / Refined Notes** | `111` / `111` | `109` / `104` | `109` / `100` |
| **Reattack Merges / Retained** | `0` / `—` | `4` / `42` | `4` / `42` |
| **Octave Ghosts Suppressed** | `0` | `1` | **`5`** (legitimate doublings preserved) |
| **Measures per Part** | `[8, 8]` | `[4, 4]` | `[4, 4]` |
| **MusicXML Overflows / Underflows** | `16` / `0` | `0` / `0` | **`0` / `0`** |
| **MIDI / MusicXML Note Parity** | Mismatched | `104 == 104` | **`100 == 100`** |
| **PDF Engraving** | ReportLab 1-staff (`9,810 B`) | ReportLab grand (`9,513 B`) | **MuseScore 4** (`49,856 B`, ReportLab fallback) |

---

## 2. Implemented Changes by Module

1. **Pipeline Audit ([transcription_pipeline_audit.md](file:///C:/Users/PC/Documents/.WEBSITES/scribasheet/benchmarks/transcription_pipeline_audit.md)):** Documented all 12 stages across `RealTranscriptionHandler`, `run_transcription_pipeline`, and `scripts/evaluate_transcription.py`.
2. **Versioning & Cache Provenance ([versioning.py](file:///C:/Users/PC/Documents/.WEBSITES/scribasheet/backend/app/transcription/versioning.py)):** Added `PIPELINE_VERSION`, `MODEL_VERSION`, `compute_config_hash()`, `compute_file_sha256()`, and `build_transcription_provenance()` wired into `RealTranscriptionHandler` and `scripts/evaluate_transcription.py`.
3. **Audio Preprocessing Profiles ([processor.py](file:///C:/Users/PC/Documents/.WEBSITES/scribasheet/backend/app/audio/processor.py)):** Added `PreprocessingProfile` (`general`, `piano` at 24 Hz HPF to preserve `A0=27.5 Hz`, `vocal` at 70 Hz HPF, `mixed`), DC offset removal, and clipping ratio tracking.
4. **Note Extraction & Refinement ([note_refiner.py](file:///C:/Users/PC/Documents/.WEBSITES/scribasheet/backend/app/transcription/note_refiner.py)):** Upgraded octave-harmonic suppression to compare fundamental strength (`octave_strong_fundamental_min_conf=0.48`, `octave_confidence_ratio=0.72`) and tight stepwise melodic continuity (`±0.35 s`, non-octave neighbor `conf >= 0.45`), suppressing 5 harmonic ghosts while preserving legitimate octave doublings and all 42 pedaled repeated attacks.
5. **Tempo, Key & Chords ([analyzer.py](file:///C:/Users/PC/Documents/.WEBSITES/scribasheet/backend/app/notation/analyzer.py)):** Added `estimate_tempo_with_diagnostics()` exposing half-time/double-time candidates, confidence, and ambiguity; updated `estimate_key_signature()` to return `"F major"` / `"D minor"` format; weighted chord detection by duration, velocity, and note confidence.
6. **Professional PDF Engraving ([generator.py](file:///C:/Users/PC/Documents/.WEBSITES/scribasheet/backend/app/notation/generator.py)):** Added `_render_pdf_via_musescore()` using local `MuseScore4.exe` directly from MusicXML for publication-grade notation, with automatic ReportLab grand-staff fallback for headless environments.

---

## 3. Capabilities, Honest Limitations & Phase 9 Roadmap

- **Implemented & Benchmark Verified:** Solo piano & monophonic/polyphonic CPU ONNX transcription, pedaled repeated-note preservation, conservative octave ghost suppression, half-time/double-time tempo disambiguation, `F major` key formatting, 100% MIDI/MusicXML note parity, MuseScore 4 PDF engraving, and fresh uncached run provenance under `benchmarks/runs/20261116_overhaul_f_major/`.
- **Not Yet Verified by Listening / Ground Truth:** No ground-truth MIDI exists for the reference WAV, so note-level precision/recall/F1 and subjective musical fidelity remain unmeasured.
- **Polyphonic / Multi-Instrument Limitation:** Basic Pitch ONNX is a general polyphonic pitch tracker, not a full multi-instrument source separator; dense full mixes require dedicated stem separation (e.g., Demucs) before per-stem transcription.
- **Phase 9 (Vocal Lyrics Roadmap — Separate Milestone):** Basic Pitch does not extract words. Production lyric transcription requires a staged pipeline: (1) vocal stem isolation, (2) ASR transcript + word timestamps (e.g., Whisper), (3) phoneme/syllable forced alignment, (4) F0/note pitch tracking, and (5) melisma-aware 1-syllable-to-many-notes mapping in MusicXML `<lyric>` tags.
