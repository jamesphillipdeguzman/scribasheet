# Transkun Piano Transcription Integration

## Overview

[Transkun](https://github.com/Yujia-Yan/Transkun) (`transkun==2.0.1`) is an event-based automatic piano transcription (APT) model using a non-hierarchical Transformer backbone and a Neural Semi-CRF decoder. It is integrated into ScribaSheet behind the `TranscriptionProvider` interface as an **optional** piano transcription engine alongside the default `basic_pitch` ONNX provider.

---

## Licensing

- **Code & Pretrained Weights (`2.0.pt`, `2.0.conf`):** MIT License (`Copyright (c) 2021 Yujia Yan`).
- **Permitted uses:** Personal use, commercial use, modification, redistribution, and bundling pretrained weights, provided the MIT copyright and permission notice are preserved.

---

## Supported Hardware & Requirements

- **Target CPU environment:** Windows 11, x86_64 CPU (e.g. Ryzen 3 3100, 4 cores / 8 threads, 16 GB RAM). No CUDA GPU is required.
- **Native sample rate:** `44,100 Hz` (mono or stereo; `TranskunProvider` automatically resamples with `soxr` if given another sample rate).
- **Confidence scores:** Transkun does not expose per-note probability/confidence values; `DetectedNote.confidence` is set to `None`.

---

## Windows Installation (CPU-Only)

Install CPU-only PyTorch, `torchaudio`, `moduleconf`, and `transkun==2.0.1` (`--no-deps` avoids `ncls` C++ build tools and unnecessary training/plotting packages like `seaborn`, `tensorboard`, and `sox`) inside the existing backend virtual environment:

```powershell
.\backend\.venv\Scripts\python.exe -m pip install --index-url https://download.pytorch.org/whl/cpu torch torchaudio
.\backend\.venv\Scripts\python.exe -m pip install moduleconf setuptools
.\backend\.venv\Scripts\python.exe -m pip install --no-deps transkun==2.0.1
```

### Checkpoint Placement & Verification

`transkun==2.0.1` bundles `pretrained/2.0.pt` and `pretrained/2.0.conf` inside the installed package. To use custom checkpoint files, set:

```powershell
$env:TRANSKUN_WEIGHT_PATH = "C:\path\to\2.0.pt"
$env:TRANSKUN_CONF_PATH = "C:\path\to\2.0.conf"
```

---

## Configuration & Provider Selection

| Environment Variable | Default | Description |
| :--- | :--- | :--- |
| `TRANSCRIPTION_ENGINE` | `basic_pitch` | Selects `basic_pitch` (default) or `transkun`. |
| `TRANSCRIPTION_ALLOW_FALLBACK` | `false` | If `true`, falls back to `basic_pitch` on Transkun failure and records `fallback_used=true` + `fallback_reason`. |
| `TRANSKUN_DEVICE` | `cpu` | Inference device (`cpu` recommended). |
| `TRANSKUN_NUM_THREADS` | `min(4, cpu_count)` | PyTorch CPU thread count (`torch.set_num_threads`). |

To return to Basic Pitch at any time:

```powershell
$env:TRANSCRIPTION_ENGINE = "basic_pitch"
```

---

## Running the Side-by-Side Benchmark

```powershell
.\backend\.venv\Scripts\python.exe scripts\evaluate_transcription.py `
  --audio "assets\test_audio\soft-easy-piano-calming-melody_75bpm_F_major.wav" `
  --engine transkun `
  --expected-bpm 75 `
  --expected-key "F major" `
  --expected-time-signature "4/4" `
  --output "benchmarks\transkun_comparison\transkun\metadata.json" `
  --artifacts-dir "benchmarks\transkun_comparison\transkun"
```

---

## Known Limitations

- **Piano-specialized:** Transkun is trained specifically for solo piano; non-piano instruments or full mixes should use `basic_pitch`.
- **CPU latency:** ~`1.8x` real-time on a 4-core CPU (`~23.5 s` for `13.2 s` of audio vs `~2.3 s` for Basic Pitch ONNX).
- **No ground-truth MIDI evaluation yet:** Objective precision/recall/F1 requires a ground-truth MIDI reference or listening test.
