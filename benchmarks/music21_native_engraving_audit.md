# ScribaSheet — Music21-Native Engraving Enhancement Audit

## 1. Audit of Custom Notation & Harmonic Logic vs. `music21`

| Area | Previous Custom Implementation | `music21` Capability | Decision & Rationale |
|---|---|---|---|
| **Chord Detection (`analyzer.py`)** | Hand-rolled `_PC_NAMES_FLAT` + `_CHORD_TEMPLATES` interval matching (ignored key signature spelling; emitted flat-only roots). | `Stream.chordify()`, `harmony.chordSymbolFromChord()`, `roman.romanNumeralFromChord()`. | **Replaced** custom template table with `music21` `chordify()` + `chordSymbolFromChord()` + `romanNumeralFromChord()` (with passing-tone filtering and safe fallback). |
| **Chord Symbols in MusicXML (`generator.py`)** | `ScoreData.chords` stored in JSON and rendered in the frontend overlay. | `music21.harmony.ChordSymbol` inside `Part`. | **Not inserted into `Part`**: `music21.harmony.ChordSymbol` subclasses `music21.chord.Chord`, so inserting `<harmony>` into `Part` causes `part.recurse().notes` / `isinstance(el, Chord)` parity checks to count chord-symbol pitches as played notes. |
| **Beaming & Ties (`generator.py`)** | Manual barline tie-splitting in `_populate_part_from_notes()`; no explicit `makeBeams()` pass. | `part.makeBeams(inPlace=True)` and `makeTies()`. | **Kept** barline tie-splitting (preserves quantized segments without altering durations) and **added** `part.makeBeams(inPlace=True)` for meter-aware beaming. |
| **Ottava Spanners (`generator.py`)** | None. | `music21.spanner.Ottava(type="8va" | "8vb")`. | **Not enabled**: `music21` `Ottava` shifts re-parsed MusicXML MIDI pitches by +/-12 semitones, breaking strict MIDI/MusicXML sounding-pitch parity. |
| **Grand-Staff RH/LH Splitting & Voice Packing** | `_split_rh_lh_notes()` (Middle-C hysteresis) and `_pack_notes_into_voices()` (`<= 2` voices). | `music21` has no raw-MIDI piano hand splitter (`voicesToParts` only separates existing `Voice` objects). | **Preserved** custom hand-splitting and voice-packing. |
| **Accidental Suppression (`_apply_key_signature_and_accidentals`)** | `part.makeAccidentals(inPlace=True)` + explicit in-measure cancellation tracking. | `part.makeAccidentals(inPlace=True)`. | **Preserved** to guarantee zero redundant diatonic naturals while keeping cancellations. |

---

## 2. Minimal Implementation Changes

- **`backend/app/notation/analyzer.py`**:
  - Replaced `_PC_NAMES_FLAT` / `_CHORD_TEMPLATES` in `detect_chords()` with `Stream.chordify()`, key-aware `music21.key.Key` spelling, `_safe_chord_symbol()` wrapping `harmony.chordSymbolFromChord()`, and `roman.romanNumeralFromChord()` diatonic confidence scoring.
  - Filters weak passing tones (`< 25%` of strongest pitch-class weight, keeping top 4), skips ambiguous/power dyads (`"Chord Symbol Cannot Be Identified"`, `"power"`), and emits chords only when harmony changes confidently.
- **`backend/app/notation/generator.py`**:
  - Passed `key_signature` from `build_score_data()` to `detect_chords()`.
  - Added `part.makeBeams(inPlace=True)` in `_populate_part_from_notes()`.
- **`backend/tests/test_musicxml_engraving.py`**:
  - Added `test_music21_chord_symbols_and_beaming_preserve_midi_parity` verifying `F` and `C7` chord detection, `<beam>` generation, and exact MIDI/MusicXML sounding pitch parity.

---

## 3. Before-and-After Comparison (Reference Audio)

Evaluated on `assets/test_audio/soft-easy-piano-calming-melody_75bpm_F_major.wav` (Basic Pitch ONNX CPU, `tempo: 73.8 BPM`, `key: F major`, `101` refined notes):

| Metric | Before | After |
|---|---|---|
| Chord progression (`ScoreData.chords`) | `Fsus4, Bb, Dm7, Fmaj7, Fsus4, Bbmaj7, F, Fsus2` (custom templates) | `Fsus, Bb, Dm7/A, F, FaddG` (`music21` `chordify` + `chordSymbolFromChord` + `romanNumeralFromChord`) |
| `<measure>` elements (grand staff) | `8` | `8` |
| `<beam>` elements | `39` | `39` |
| MuseScore 4 PDF export (`MuseScore4.exe`) | `45,235` bytes (`%PDF-`) | Validated (`%PDF-`) |
| MIDI / MusicXML sounding pitch parity | Preserved | Preserved (`86 passed`, including `test_midi_and_musicxml_preserve_identical_note_counts_under_polyphony`) |

---

## 4. Verification Results

- `cd backend; .\.venv\Scripts\python.exe -m pytest tests -q`: **`86 passed`**
- `cd backend; .\.venv\Scripts\ruff.exe check app tests`: **`All checks passed!`**
- MuseScore 4 (`C:\Program Files\MuseScore 4\bin\MuseScore4.exe`) rendered PDF output cleanly (`test_accidentals_f_major_no_redundant_naturals_and_preserves_cancellation` and reference WAV benchmark).
- All changes remain local (not committed, pushed, or deployed).
