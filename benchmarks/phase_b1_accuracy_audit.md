# ScribaSheet — Phase B.1: Transcription Accuracy Audit & Benchmark Validation

**Commit Audited:** `c6e4f9e3bc57c49a8a6396cde6807b3e319a2296` (pre-fix reference: `d9afd2a5d9807019608c4c65b319b163f7a70d46`)  
**Audit Date:** 2026-11-16  
**Scope:** Non-destructive local investigation and validation (no transcription algorithm changes).

---

## 1. Executive Summary

The contradiction between earlier benchmark reports is **fully explained**: in commit `c6e4f9e`, `benchmarks/baseline_f_major.json` (and `benchmarks/baseline_f_major_artifacts/`) was **overwritten** by re-running `scripts/evaluate_transcription.py` against the **already-modified post-fix code** using `assets/test_audio/soft-easy-piano-calming-melody_75bpm_F_major.wav` and `--expected-key "F major"`.

Reproducible measurements on the current `c6e4f9e` pipeline confirm **real structural improvements** in tempo octave resolution (`73.8 BPM` vs `75.0 BPM` expected) and MusicXML per-voice measure integrity (`0` overflowing/underflowing measures across `4` measures per part). However, the audit also uncovered a **high-severity defect** in `note_refiner.py` (`reattack_debounce` merged `39` notes spaced `> 250 ms` apart, up to `2.416 s`, because `gap <= 0.035 s` is unconditionally merged when sustain overlap occurs) and a **1-note MIDI-to-MusicXML discrepancy** (`63` MIDI notes vs `62` MusicXML noteheads).

---

## 2. Benchmark History and Discrepancies (Verified Facts)

- `benchmarks/baseline_f_major.json` and `benchmarks/after_fixes_f_major.json` in commit `c6e4f9e` both report:
  - `tempo.estimated_bpm`: `73.8`
  - `raw_notes_summary.count`: `109`
  - `refined_notes_summary.count`: `63`
  - `refiner_stats.enabled`: `true`, `reattack_merges`: `46`, `octave_ghosts_suppressed`: `0`
  - `musicxml_integrity.structural_integrity_ok`: `true`, `xml_measures_per_part`: `[4, 4]`
- The only differences between the two JSON files in `c6e4f9e` are `--audio` path (`assets/test_audio/...` vs external `documentation/scribasheet/...`) and `--expected-key` (`"F major"` -> `exact_match: false` vs `"F"` -> `exact_match: true`).
- Their artifact directories (`baseline_f_major_artifacts/` and `after_fixes_f_major_artifacts/`) contain byte-identical file sizes (`raw_notes.json`: `17,771 B`, `score.mid`: `445 B`, `score.musicxml`: `42,357 B`, `score.pdf`: `6,905 B`).
- The earlier pre-fix numbers (`143.6 BPM`, `111` raw notes, `refiner.enabled: false`, `8` measures, `16` overflow measures) came from commit `d9afd2a` prior to the `processor.py` (`27.5 Hz` HPF + `-1 dBFS` peak norm), `note_refiner.py`, `analyzer.py`, and `generator.py` changes committed in `c6e4f9e`. The pre-fix baseline JSON is no longer present in `benchmarks/`, though `d9afd2a` remains in Git history.

---

## 3. Audio Identity Verification (Verified Fact)

Both WAV files share the exact same SHA-256 hash:
- `assets\test_audio\soft-easy-piano-calming-melody_75bpm_F_major.wav`: `908E18DF558BF4CC2BBDD2CBAA8E7D4DCE972B3CB24E45E59293CCD636DCF497`
- `C:\Users\PC\Documents\.WEBSITES\documentation\scribasheet\soft-easy-piano-calming-melody_75bpm_F_major.wav`: `908E18DF558BF4CC2BBDD2CBAA8E7D4DCE972B3CB24E45E59293CCD636DCF497`

---

## 4. Production vs. Evaluator Pipeline Comparison

| Stage | Production (`RealTranscriptionHandler` / `pipeline.py`) | Evaluator (`scripts/evaluate_transcription.py`) | Parity |
| :--- | :--- | :--- | :--- |
| Media Probe | `probe_media()` | `probe_media()` | Identical |
| Preprocessing | `preprocess_to_wav()` | `preprocess_to_wav()` | Identical |
| ONNX Verification | `verify_onnx_cpu_runtime(resolve_onnx_model_path())` | `verify_onnx_cpu_runtime(resolve_onnx_model_path())` | Identical |
| Inference | `BasicPitchProvider().transcribe()` | `BasicPitchProvider().transcribe()` | Identical |
| Note Refinement | `refine_detected_notes(t_out.notes)` | `refine_detected_notes(raw_notes)` | Identical |
| Tempo Estimation | `estimate_tempo(..., notes=refined_notes)` | `estimate_tempo(...)` (**omits `notes`**) | **Minor divergence** |
| Key Estimation | `estimate_key_signature(refined_notes, ...)` | `estimate_key_signature(refined_notes, ...)` | Identical |
| Score & Chords | `build_score_data(..., detected_notes=refined_notes)` | `build_score_data(..., detected_notes=refined_notes)` | Identical |
| MIDI / MusicXML | `score_data_to_midi_bytes()` / `score_data_to_musicxml()` | `score_data_to_midi_bytes()` / `score_data_to_musicxml()` | Identical |
| PDF Rendering | On-demand via API (`render_score_pdf()`) | Run inline (`render_score_pdf()`) | Same function |

---

## 5. Note-Refinement Audit (`backend/app/transcription/note_refiner.py`)

1. **Same-pitch re-attack merging (Confirmed High-Severity Defect):**
   - On the reference WAV, `46` merges occurred: **`39` had `gap_sec <= 0.0`** (overlapping/zero-gap) and **`39` had `merged_onset_sec - prev_onset_sec > 0.25 s`** (up to `2.4161 s`).
   - Example: MIDI `46` (`Bb2`) at `6.8305 s` merged four subsequent events at `7.1788 s`, `7.5968 s`, `7.9928 s`, and `8.8287 s`.
   - Root cause: `is_genuine_reattack` requires `gap > 0.035`. When a piano sustain pedal or long decay causes `prev.offset_sec >= curr.onset_sec` (`gap <= 0`), genuine repeated notes are unconditionally merged.
2. **Octave/harmonic suppression:**
   - `octave_ghosts_suppressed == 0` on the reference WAV; `4` octave pairs remain in `refined_notes`: `(70, 82)` at `~2.00 s`, `(57, 81)` at `~3.99 s`, `(53, 65)` at `4.786 s`, `(65, 77)` at `8.829 s`. The reduction from `24` raw suspected octave duplicates to `4` was a side effect of re-attack merging changing onset/offset pairings, not active harmonic suppression.
3. **Note filtering & raw preservation:**
   - `0` notes dropped by duration/confidence filters on the reference WAV (`min_duration_sec=0.055`, `min_confidence=0.28`).
   - `raw_notes` is preserved in `NoteRefinementResult.raw_notes`, and `raw_onset_sec`/`raw_offset_sec` are preserved on surviving `ScoreNote`s, though dropped/merged raw notes are not stored in `ScoreData`.

---

## 6. Tempo & Key Detection Audit (`backend/app/notation/analyzer.py`)

- **Tempo:** Reproducibly outputs `73.8 BPM` (`1.2 BPM` below `75.0 BPM`). `librosa.beat.beat_track` raw estimate is `152.0 BPM`, and `_resolve_tempo_octave()` halves it without using `expected_bpm` (which is only used in `evaluate_transcription.py` reporting).
- **Key:** `music21` `s.analyze('key')` returns `tonic = F`, `mode = major` (`correlationCoefficient = 0.7475`, next best `Bb major` at `0.7292`), formatted as `"F"`. Thus `F major` was genuinely detected, though the string `"F"` caused `exact_match: false` when compared against `"F major"`.

---

## 7. MusicXML & MIDI Consistency Audit

- **MusicXML Structural Integrity (Verified):** `music21.converter.parseData` succeeds (`2` parts: RH Treble, LH Bass; `4` measures per part). Independent per-voice XML tick validation shows **`0` overflow** and **`0` underflow** measures (`40,320` ticks per `4/4` measure at `divisions=10080`).
- **MIDI vs. MusicXML Parity (Confirmed Defect):** `score.mid` contains **`63` notes**, whereas `score.musicxml` contains **`62` noteheads** (excluding tied continuations). One `A4` (`MIDI 69`) is dropped when two same-pitch notes quantize to identical `(start_ql, end_ql)` in `_pack_notes_into_voices()`.

---

## 8. PDF Engraving Inspection (`benchmarks/after_fixes_f_major_artifacts/score.pdf`)

Decoded the ReportLab vector stream (`1` page, `633` drawing commands, `14` text ops):
- **Verified clean:** Grand-staff brace, aligned 4-measure barlines across treble (`y=660..684`) and bass (`y=606..630`), separated measure label (`m. 1` at `y=708`) and chord lane (`y=696`), ledger lines, no clipping.
- **Remaining limitations:** Proportional-time placement with solid black circles only (no rhythmic noteheads/beams/rests/accidentals/key signatures), `"G"`/`"F"` text labels instead of clef glyphs, and footer bullet `•` encoded as `\177` in WinAnsi.

---

## 9. Reproducibility, Confirmed Defects, and Next Steps

- Re-running `scripts/evaluate_transcription.py` on `c6e4f9e` produced **identical** `73.8 BPM`, `109` raw notes, and `63` refined notes.
- **Recommended Next Phase (Phase B.2):**
  1. Fix `reattack_debounce` in `note_refiner.py` so overlapping/pedaled same-pitch notes with large onset separation (e.g., `curr.onset_sec - prev.onset_sec > 0.12 s` and strong onset confidence/velocity) are split/preserved rather than merged, and trim `prev.offset_sec` cleanly.
  2. Fix the 1-note drop in `generator.py` (`_pack_notes_into_voices`) when two same-pitch notes quantize to the same `(start_ql, end_ql)`.
  3. Pass `notes=refined_notes` in `evaluate_transcription.py`'s `estimate_tempo()` call, record `wav_sha256` + `git_commit_sha`, and archive a clean `d9afd2a` pre-fix baseline separately without overwriting `after_fixes_f_major.json`.
