# ScribaSheet Audio-to-MIDI Benchmark Report

- **Generated (UTC):** `2026-11-23T07:03:27.884865+00:00`
- **Manifest:** `C:\Users\PC\Documents\.WEBSITES\scribasheet\backend\benchmarks\manifest.json`
- **Onset Tolerance:** `0.08s`

## Summary

| Reference | Status | Audio | Reference MIDI | Ref Notes | Gen Notes | Precision | Recall | F1 | Mean Onset Diff (ms) |
|---|---|---|---|---:|---:|---:|---:|---:|---:|
| Closer | `incomplete_missing_audio` | `missing` | `assets/midi/Closer Gehlee.mid` | 1253 | — | — | — | — | — |
| Away in a Manger | `incomplete_missing_assets` | `missing` | `missing` | — | — | — | — | — | — |
| Soft Easy Piano Calming Melody (75 BPM F Major) | `incomplete_missing_reference_midi` | `assets/test_audio/soft-easy-piano-calming-melody_75bpm_F_major.wav` | `missing` | — | 52 | — | — | — | — |

## Missing Assets & Limitations

- **Closer** (`incomplete_missing_audio`): missing audio_file. Reference MIDI exists locally; original audio resides on remote Railway persistent volume and is not in the local workspace.
- **Away in a Manger** (`incomplete_missing_assets`): missing audio_file, reference_midi_file. Neither original audio nor ground-truth MIDI is present in the local workspace.
- **Soft Easy Piano Calming Melody (75 BPM F Major)** (`incomplete_missing_reference_midi`): missing reference_midi_file. Local test audio exists and runs through the full production pipeline, but has no independent ground-truth MIDI.
