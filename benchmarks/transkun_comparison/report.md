# ScribaSheet — Basic Pitch vs. Transkun Benchmark Comparison

**Date:** 2026-11-16  
**Source Audio:** `assets/test_audio/soft-easy-piano-calming-melody_75bpm_F_major.wav`  
**Verified SHA-256:** `908E18DF558BF4CC2BBDD2CBAA8E7D4DCE972B3CB24E45E59293CCD636DCF497`  
**Duration:** `13.2 s` | **Expected:** `75.0 BPM`, `F major`, `4/4`

---

## 1. Side-by-Side Comparison

| Metric | Basic Pitch (`basic_pitch`) | Transkun (`transkun`) |
| :--- | :---: | :---: |
| **Model / Checkpoint** | `nmp.onnx` (`CPUExecutionProvider`) | `transkun-2.0` (`2.0.pt`, `PyTorch (cpu)`) |
| **Checkpoint SHA-256** | `n/a` (bundled ONNX) | `50A80010EFFC2A59FFCD068A95CD2B29BD7F23A27A3515BC3CCD209C89A3D44C` |
| **Preprocessed Sample Rate** | `22,050 Hz` (`piano` profile) | `44,100 Hz` (`piano` profile) |
| **Inference Duration (CPU)** | `2.338 s` | `23.506 s` |
| **Raw Note Count** | `109` | `52` |
| **Refined Note Count** | `100` | `52` |
| **Reattack Merges / Retained** | `4` / `42` | `0` / `1` |
| **Octave Ghosts Suppressed** | `5` | `0` (only `3` suspected pairs in raw output) |
| **Rapid Same-Pitch Reattacks ($\le 60\text{ ms}$)** | `46` raw / `39` refined | `1` raw / `1` refined |
| **Note Duration (min / median / max)** | `0.070 s / 0.406 s / 3.101 s` | `0.076 s / 0.742 s / 4.165 s` |
| **Velocity Range (min / mean / max)** | `35 / 69.06 / 115` | `40 / 58.65 / 88` |
| **Confidence Scores** | `0.2944 – 0.7939` | `None` (not exposed by Transkun) |
| **Estimated Tempo** | `73.8 BPM` (`-1.2 BPM`) | `73.8 BPM` (`-1.2 BPM`) |
| **Estimated Key** | `F major` (`exact_match: true`) | `F major` (`exact_match: true`) |
| **Detected Chords** | `Fsus4, Bb, Dm7, Fmaj7, Fsus4, Bbmaj7, F, Fsus2` (`8`) | `Fsus4, Dm7, Fmaj7, Bbsus2, Bbmaj7, F` (`6`) |
| **MIDI / MusicXML Note Parity** | `100 == 100` (`ExactParity: True`) | `52 == 52` (`ExactParity: True`) |
| **MusicXML Measures / Integrity** | `[4, 4]`, `0` overflow, `0` underflow | `[5, 5]`, `0` overflow, `0` underflow |
| **PDF Size (MuseScore 4)** | `49,856 B` | `46,499 B` |

---

## 2. Observations & Honest Limitations

1. **Cleaner Raw Note Extraction:** On this solo piano recording, Transkun extracted `52` raw notes with only `3` suspected octave-duplicate pairs and `1` rapid same-pitch reattack, compared with Basic Pitch's `109` raw notes (`24` suspected octave pairs, `46` rapid reattacks).
2. **Sustain & Longer Decays:** Transkun's median note duration (`0.742 s`) and max duration (`4.165 s`) reflect longer sustained piano phrasing, which extends the final sustained chord slightly into measure 5 (`[5, 5]` measures in MusicXML).
3. **CPU Latency Trade-off:** Transkun on CPU (`Ryzen` / 4 threads) took `23.506 s` for `13.2 s` of audio (~`1.78x` real-time), roughly `10x` slower than Basic Pitch ONNX (`2.338 s`).
4. **No Ground-Truth MIDI:** Because no ground-truth MIDI exists for `soft-easy-piano-calming-melody_75bpm_F_major.wav`, note-level precision, recall, and F1 cannot yet be objectively established. Both engines should undergo listening comparison before changing the production default (`basic_pitch`).
