"""Phase 6 tests for the reproducible audio-to-MIDI benchmark runner."""

from __future__ import annotations

import json
from pathlib import Path

from benchmarks.run_benchmark import (
    compute_extended_metrics,
    evaluate_benchmark_entry,
    run_benchmark,
)
from app.transcription.base import DetectedNote


def test_compute_extended_metrics_one_to_one_matching_and_octave_errors() -> None:
    ref_notes = [
        DetectedNote(pitch_midi=60, onset_sec=0.0, offset_sec=0.5, velocity=85),
        DetectedNote(pitch_midi=64, onset_sec=0.5, offset_sec=1.0, velocity=85),
        DetectedNote(pitch_midi=67, onset_sec=1.0, offset_sec=1.5, velocity=85),
    ]
    # Two predicted notes at t=0.01s for C4 -> 1-to-1 matching allows only 1 TP;
    # 76 at t=0.51s is an octave error (+12 st vs E4=64); G4 missing.
    gen_notes = [
        DetectedNote(pitch_midi=60, onset_sec=0.01, offset_sec=0.52, velocity=85),
        DetectedNote(pitch_midi=60, onset_sec=0.02, offset_sec=0.49, velocity=80),
        DetectedNote(pitch_midi=76, onset_sec=0.51, offset_sec=1.01, velocity=80),
    ]
    metrics = compute_extended_metrics(
        ref_notes,
        gen_notes,
        timing_mode="performance",
        onset_tolerance_sec=0.08,
    )
    assert metrics.true_positives == 1
    assert metrics.false_positives == 2
    assert metrics.false_negatives == 2
    assert metrics.octave_errors == 1
    assert metrics.hand_assignment_accuracy is None
    assert metrics.vocal_melody_accuracy is None


def test_benchmark_reports_missing_assets_without_fabricating_scores(tmp_path: Path) -> None:
    manifest_path = tmp_path / "manifest.json"
    manifest_path.write_text(
        json.dumps(
            {
                "onset_tolerance_sec": 0.08,
                "entries": [
                    {
                        "id": "closer",
                        "name": "Closer",
                        "project_id": "53763f5e-3321-43fe-8952-ec66cd75ca6a",
                        "audio_path": None,
                        "reference_midi_path": "assets/midi/Closer Gehlee.mid",
                    },
                    {
                        "id": "away",
                        "name": "Away in a Manger",
                        "audio_path": None,
                        "reference_midi_path": None,
                    },
                ],
            }
        ),
        encoding="utf-8",
    )
    repo_root = Path(__file__).resolve().parents[2]
    out_dir = tmp_path / "results"
    report = run_benchmark(manifest_path=manifest_path, output_dir=out_dir, repo_root=repo_root)

    assert (out_dir / "benchmark_report.json").exists()
    assert (out_dir / "benchmark_report.md").exists()

    closer = report["results"][0]
    assert closer["status"] == "incomplete_missing_audio"
    assert closer["reference_midi"]["note_count"] == 1253
    assert closer["performance_metrics"] is None
    assert closer["notation_metrics"] is None

    away = report["results"][1]
    assert away["status"] == "incomplete_missing_assets"
    assert away["performance_metrics"] is None
