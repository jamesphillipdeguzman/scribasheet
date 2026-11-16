# ScribaSheet — MusicXML Engraving Quality Audit (Pre-Fix)

**Date:** 2026-11-16  
**Inspected Artifacts:** `benchmarks/runs/transkun_vs_basic_pitch_20261116_2013/{basic_pitch,transkun}/score.musicxml`  
**Inspected Code:** `backend/app/notation/generator.py`, `backend/app/worker_agent.py`, `scripts/evaluate_transcription.py`, `frontend/src/features/editor/SheetMusicViewer.tsx`

---

## Root Causes of the Four Engraving Defects

### 1. Redundant Natural Accidentals (`29` in Transkun, `35` in Basic Pitch)
- **Observation:** Diatonic notes in F major (`D4`, `F5`, `A3`, `C4`, `E5`, `G5`) are exported with `<alter>0</alter><accidental>natural</accidental>`.
- **Root Cause:** `score_data_to_musicxml()` creates `music21.note.Note(midi)` / `Chord(pitches)` and shares a single `key_obj` instance across `p_treble` and `p_bass` without running per-part `makeAccidentals(inPlace=True)` or suppressing redundant `natural` `displayStatus` against the active key signature and measure accidental state.

### 2. Fragmented Multi-Voice Clutter (`5–6` voices per staff in Transkun, `3–4` in Basic Pitch)
- **Observation:** `score.musicxml` contains voices `1..5` (RH) and `1..6` (LH) in Transkun, and `1..4` (RH) / `1..3` (LH) in Basic Pitch.
- **Root Cause:** `_pack_notes_into_voices()` only groups notes into a chord when **both** `start_ql` and `end_ql` are identical, and creates a brand-new `Voice` whenever any sustained note overlaps the next onset—even by a single sixteenth (`0.25 ql`).

### 3. Rhythmic Jitter, Double-Dotted Durations (`14` in Transkun, `6` in Basic Pitch), and Excessive Ties (`21` pairs)
- **Observation:** `14` notes in Transkun (`6` in Basic Pitch) have double-dotted durations (`<dot/><dot/>`, e.g., `1.75 ql` or `3.5 ql`+`0.25`), and `21` tie `start`/`stop` pairs cross beats/barlines.
- **Root Cause:** `_pack_notes_into_voices()` hardcodes a `16th`-note (`0.25 ql`) grid regardless of tempo/subdivision density, and never normalizes durations to standard values (`4.0, 3.0, 2.0, 1.5, 1.0, 0.75, 0.5, 0.25`) or trims slight sustain overlaps within a voice.

### 4. Raw Filename Score Metadata
- **Observation:** `<work-title>` and `<movement-title>` are set to `soft-easy-piano-calming-melody_75bpm_F_major`.
- **Root Cause:** `worker_agent.py` and `evaluate_transcription.py` pass `Path(safe_name).stem` / `audio_path.stem` directly as `title` without cleaning underscores, BPM suffixes, or key tags when no user project title is supplied.
