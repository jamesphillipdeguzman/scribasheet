# ScribaSheet — Phase C: Beat-Synchronized Timing & Downbeat Alignment Audit

**Date:** 2026-11-16  
**Benchmark Run:** `benchmarks/runs/20261116_beat_alignment_closer/`  
**Source Audio:** `Closer – Piano Cover GEHLEE (Piano Sheet).wav` (`182.293 s`, `48,000 Hz`, SHA-256 `9C44A525131ACDAF475843E8CAE5F42B1782AE52382DA20A08F04C6DA941B0CB`)

---

## 1. Pre-Fix Timing Defects Identified (Section 1 Audit)

1. **Double-time tempo selection (`172.3 BPM`):** `Closer.musicxml` locked onto `172.3 BPM` instead of the `~86 BPM` groove.
2. **Assumed `t = 0.0` downbeat:** The old pipeline mapped `t = 0.0` directly to Measure 1 Beat 1, ignoring `4.90 s` of intro/leading silence before the first real musical downbeat.
3. **Constant global BPM grid:** Quantizing all `182.3 s` against a rigid `60 / tempo_bpm` grid caused cumulative barline drift (`150` 16th-note rests in Part 0, `607` tied note elements, `397` 16th-note fragments across `130` measures).

---

## 2. Beat This! Integration & Fallback Architecture

- **Package:** `beat-this==1.1.0` (`einops`, `rotary-embedding-torch`, CPU PyTorch `2.15.0+cpu`, MIT license), using `Audio2Beats(checkpoint_path="final0", device="cpu")` with lazy cached loading in `backend/app/notation/beat_tracker.py`.
- **Fallback:** `librosa.beat.beat_track` + periodic accent phase estimation (`TIMING_PROVIDER=auto|beat_this|librosa`), explicitly recording `requested_provider`, `actual_provider`, `fallback_used`, and `fallback_reason`.
- **Beat-Domain `TimingMap` (`backend/app/notation/timing_map.py`):** Regularizes downbeats, subdivides into exact `beats_per_measure` anchors per bar (preventing cumulative drift over 80–130+ measures), handles leading silence (`first_downbeat_sec = 4.90 s`) vs. pickup measures, and maps `onset_sec`/`offset_sec` via piecewise linear interpolation (`seconds_to_ql`).

---

## 3. Before / After Benchmark Comparison (`Closer`)

| Metric | Old `Closer.musicxml` | Beat-Aligned (`20261116_beat_alignment_closer`) |
| :--- | :---: | :---: |
| **Tempo** | `172.3 BPM` | **`85.7 BPM`** (`raw: 85.71`, `conf: 0.834`, `ambiguous: false`) |
| **First Downbeat / Pickup** | Assumed `0.0 s` | **`4.90 s`** (`pickup_ql: 0.0`) |
| **Measures per Part** | `[130, 130]` | **`[67, 67]`** (`0` overflow / `0` underflow) |
| **Part 0 16th-Note Rests** | `150` (`54` in m.41–77) | **`0`** |
| **Tied Note Elements** | `607` | **`80`** |
| **16th-Note Fragments** | `397` | **`0`** |
| **MIDI / MusicXML Parity** | `—` | **`1252 == 1252`** (`ExactParity: True`) |
| **PDF Output (MuseScore 4)** | `—` | `100,312 B` (`%PDF-`) |

---

## 4. Verified vs. Unverified & Limitations

- **Verified Improvements:** `85.7 BPM` tempo accuracy (`0.3 BPM` from `86.0 BPM`), `4.90 s` downbeat phase alignment, elimination of all `150` 16th-note rests and `397` 16th-note fragments, `87%` reduction in tied notes (`607 -> 80`), `0` measure overflows/underflows, and `1252 == 1252` MIDI/MusicXML parity.
- **Unverified Musical Assumptions:** No ground-truth MIDI exists for `Closer`, so per-note onset/pitch F1 and subjective listening fidelity remain unmeasured.
- **Remaining Limitations:** `Beat This!` CPU inference on a 3-minute audio file adds ~`1.5–2 min` on 4-core CPU; `Audio2Beats` is cached in-process on the worker so model weights are loaded once.
