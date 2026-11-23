"""Reproducible audio-to-MIDI benchmark runner for ScribaSheet.

Evaluates the actual production transcription pipeline (preprocess_to_wav ->
run_core_transcription -> analyze_timing_and_build_score ->
score_data_to_midi_bytes) against independent ground-truth MIDI files without
requiring a production database or modifying project records.

Usage (from backend/):
    .\\.venv\\Scripts\\python.exe -m benchmarks.run_benchmark
"""

from __future__ import annotations

import argparse
import io
import json
import tempfile
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
import pretty_midi

from app.audio.processor import preprocess_to_wav
from app.notation.evaluation import (
    NoteEvaluationReport,
    estimate_global_onset_offset,
    evaluate_notes_against_reference,
    load_reference_midi,
)
from app.notation.generator import score_data_to_midi_bytes
from app.schemas.score import ScoreData
from app.schemas.transcription import TranscriptionSettings
from app.transcription.base import DetectedNote
from app.transcription.core_pipeline import (
    analyze_timing_and_build_score,
    transcribe_and_refine_audio,
)
from app.transcription.provider_factory import resolve_engine_for_instrument

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_MANIFEST = Path(__file__).resolve().parent / "manifest.json"
DEFAULT_OUTPUT_DIR = Path(__file__).resolve().parent / "results"


@dataclass
class ExtendedAccuracyMetrics:
    timing_mode: str
    onset_tolerance_sec: float
    onset_offset_sec: float
    true_positives: int
    false_positives: int
    false_negatives: int
    precision: float
    recall: float
    f1: float
    pitch_accuracy_pct: float
    pitch_errors: int
    octave_errors: int
    mean_onset_diff_ms: float
    median_onset_diff_ms: float
    mean_offset_diff_ms: float
    median_offset_diff_ms: float
    mean_duration_diff_ms: float
    median_duration_diff_ms: float
    note_count_diff: int
    hand_assignment_accuracy: float | None
    hand_assignment_note: str
    vocal_melody_accuracy: float | None
    vocal_melody_note: str
    per_track: list[dict[str, Any]]


def _extract_notes_from_midi_bytes(midi_bytes: bytes) -> list[DetectedNote]:
    pm = pretty_midi.PrettyMIDI(io.BytesIO(midi_bytes))
    notes: list[DetectedNote] = []
    for inst in pm.instruments:
        if inst.is_drum:
            continue
        for n in inst.notes:
            notes.append(
                DetectedNote(
                    pitch_midi=int(n.pitch),
                    onset_sec=float(n.start),
                    offset_sec=float(n.end),
                    velocity=int(n.velocity),
                    confidence=1.0,
                )
            )
    notes.sort(key=lambda x: (x.onset_sec, x.pitch_midi))
    return notes


def compute_extended_metrics(
    ref_notes: list[DetectedNote],
    gen_notes: list[DetectedNote],
    *,
    timing_mode: str,
    onset_tolerance_sec: float = 0.080,
    per_track_refs: dict[str, list[DetectedNote]] | None = None,
) -> ExtendedAccuracyMetrics:
    """Compute note-detection, pitch, octave, and timing metrics using 1-to-1 greedy matching."""
    report: NoteEvaluationReport = evaluate_notes_against_reference(
        ref_notes,
        gen_notes,
        onset_tolerance_sec=onset_tolerance_sec,
        align_onset_offset=True,
    )

    # Recompute matched offset deviations using the same alignment shift and 1-to-1 greedy pairs
    shift = estimate_global_onset_offset(ref_notes, gen_notes)
    aligned_gen = [
        DetectedNote(
            pitch_midi=n.pitch_midi,
            onset_sec=n.onset_sec - shift,
            offset_sec=n.offset_sec - shift,
            velocity=n.velocity,
            confidence=n.confidence,
        )
        for n in gen_notes
    ]
    ref_by_pitch: dict[int, list[int]] = {}
    for ri, rn in enumerate(ref_notes):
        ref_by_pitch.setdefault(rn.pitch_midi, []).append(ri)
    candidates: list[tuple[float, int, int]] = []
    for gi, gn in enumerate(aligned_gen):
        for ri in ref_by_pitch.get(gn.pitch_midi, ()):
            dt = abs(gn.onset_sec - ref_notes[ri].onset_sec)
            if dt <= onset_tolerance_sec:
                candidates.append((dt, ri, gi))
    candidates.sort(key=lambda x: x[0])

    ref_used: set[int] = set()
    gen_used: set[int] = set()
    offset_diffs_ms: list[float] = []
    for _, ri, gi in candidates:
        if ri in ref_used or gi in gen_used:
            continue
        ref_used.add(ri)
        gen_used.add(gi)
        offset_diffs_ms.append((aligned_gen[gi].offset_sec - ref_notes[ri].offset_sec) * 1000.0)

    pitch_accuracy_pct = round((report.matched_count / report.gen_count) * 100.0, 2) if report.gen_count else 0.0

    per_track_results: list[dict[str, Any]] = []
    if per_track_refs and len(per_track_refs) > 1:
        for track_label, track_ref_notes in per_track_refs.items():
            tr = evaluate_notes_against_reference(
                track_ref_notes,
                gen_notes,
                onset_tolerance_sec=onset_tolerance_sec,
                align_onset_offset=True,
            )
            per_track_results.append(
                {
                    "track": track_label,
                    "ref_count": tr.ref_count,
                    "matched_count": tr.matched_count,
                    "recall": tr.recall,
                    "mean_onset_diff_ms": tr.mean_onset_diff_ms,
                }
            )

    return ExtendedAccuracyMetrics(
        timing_mode=timing_mode,
        onset_tolerance_sec=onset_tolerance_sec,
        onset_offset_sec=report.onset_offset_sec,
        true_positives=report.matched_count,
        false_positives=report.extra_notes,
        false_negatives=report.missing_notes,
        precision=report.precision,
        recall=report.recall,
        f1=report.f1,
        pitch_accuracy_pct=pitch_accuracy_pct,
        pitch_errors=report.extra_notes,
        octave_errors=report.octave_errors,
        mean_onset_diff_ms=report.mean_onset_diff_ms,
        median_onset_diff_ms=report.median_onset_diff_ms,
        mean_offset_diff_ms=round(float(np.mean(offset_diffs_ms)), 2) if offset_diffs_ms else 0.0,
        median_offset_diff_ms=round(float(np.median(offset_diffs_ms)), 2) if offset_diffs_ms else 0.0,
        mean_duration_diff_ms=report.mean_duration_diff_ms,
        median_duration_diff_ms=report.median_duration_diff_ms,
        note_count_diff=report.gen_count - report.ref_count,
        hand_assignment_accuracy=None,
        hand_assignment_note="Unavailable: ground-truth MIDI does not carry explicit RH/LH labels.",
        vocal_melody_accuracy=None,
        vocal_melody_note="Unavailable: no separate ground-truth vocal melody track.",
        per_track=per_track_results,
    )


def run_production_pipeline_on_audio(
    audio_path: Path,
    *,
    title: str,
    instrument: str = "piano",
    mode: str = "single_instrument",
) -> tuple[ScoreData, list[DetectedNote], list[DetectedNote], dict[str, Any]]:
    """Execute the actual ScribaSheet transcription pipeline and return dual-timing MIDI notes."""
    settings = TranscriptionSettings(
        instrument=instrument,
        mode=mode,
        tempo_mode="auto",
        time_signature="auto",
        key_signature="auto",
    )
    requested_engine, allow_fallback = resolve_engine_for_instrument(instrument)
    with tempfile.TemporaryDirectory(prefix="scribasheet_bench_") as tmp_dir:
        tmp_path = Path(tmp_dir)
        processed_wav = tmp_path / "processed.wav"
        proc_meta = preprocess_to_wav(audio_path, processed_wav)
        core_res = transcribe_and_refine_audio(
            processed_wav,
            tmp_path,
            settings=settings,
            requested_engine=requested_engine,
            allow_fallback=allow_fallback,
            target_sr=proc_meta.sample_rate,
            prep_profile_name="default",
        )
        score = analyze_timing_and_build_score(
            title=title,
            processed_wav=processed_wav,
            proc_meta=proc_meta,
            settings=settings,
            core_res=core_res,
        )

    perf_midi_bytes = score_data_to_midi_bytes(score, timing_mode="performance")
    not_midi_bytes = score_data_to_midi_bytes(score, timing_mode="notation")
    perf_notes = _extract_notes_from_midi_bytes(perf_midi_bytes)
    not_notes = _extract_notes_from_midi_bytes(not_midi_bytes)

    pipeline_meta = {
        "duration_seconds": round(float(proc_meta.duration_seconds), 3),
        "sample_rate": proc_meta.sample_rate,
        "channels": proc_meta.channels,
        "tempo_bpm": score.tempo_bpm,
        "time_signature": score.time_signature,
        "key_signature": score.key_signature,
        "engine": (score.analysis or {}).get("actual_engine") or (score.analysis or {}).get("engine"),
        "score_note_count": len(score.notes),
        "performance_midi_note_count": len(perf_notes),
        "notation_midi_note_count": len(not_notes),
    }
    return score, perf_notes, not_notes, pipeline_meta


def evaluate_benchmark_entry(
    entry: dict[str, Any],
    *,
    repo_root: Path = REPO_ROOT,
    onset_tolerance_sec: float = 0.080,
) -> dict[str, Any]:
    """Run and evaluate a single manifest entry, clearly reporting missing assets."""
    audio_rel = entry.get("audio_path")
    ref_rel = entry.get("reference_midi_path")
    audio_path = (repo_root / audio_rel) if audio_rel else None
    ref_path = (repo_root / ref_rel) if ref_rel else None

    audio_exists = bool(audio_path and audio_path.exists())
    ref_exists = bool(ref_path and ref_path.exists())

    ref_info_dict: dict[str, Any] | None = None
    if ref_exists and ref_path is not None:
        ref_info = load_reference_midi(ref_path)
        ref_info_dict = {
            "path": str(ref_rel),
            "duration_sec": round(ref_info.duration_sec, 3),
            "tempo_bpm": round(ref_info.tempo_bpm, 2),
            "time_signature": ref_info.time_signature,
            "track_count": ref_info.track_count,
            "piano_track_indices": ref_info.piano_track_indices,
            "note_count": len(ref_info.notes),
        }

    missing_assets: list[str] = []
    if not audio_exists:
        missing_assets.append("audio_file")
    if not ref_exists:
        missing_assets.append("reference_midi_file")

    pipeline_meta: dict[str, Any] | None = None
    performance_metrics: dict[str, Any] | None = None
    notation_metrics: dict[str, Any] | None = None

    if audio_exists and audio_path is not None:
        _, perf_notes, not_notes, pipeline_meta = run_production_pipeline_on_audio(
            audio_path,
            title=entry["name"],
            instrument=entry.get("instrument", "piano"),
            mode=entry.get("transcription_mode", "single_instrument"),
        )
        if ref_exists and ref_path is not None:
            ref_info = load_reference_midi(ref_path)
            perf_eval = compute_extended_metrics(
                ref_info.notes,
                perf_notes,
                timing_mode="performance",
                onset_tolerance_sec=onset_tolerance_sec,
            )
            not_eval = compute_extended_metrics(
                ref_info.notes,
                not_notes,
                timing_mode="notation",
                onset_tolerance_sec=onset_tolerance_sec,
            )
            performance_metrics = asdict(perf_eval)
            notation_metrics = asdict(not_eval)

    if audio_exists and ref_exists:
        status = "complete"
    elif not audio_exists and not ref_exists:
        status = "incomplete_missing_assets"
    elif not audio_exists:
        status = "incomplete_missing_audio"
    else:
        status = "incomplete_missing_reference_midi"

    return {
        "id": entry["id"],
        "name": entry["name"],
        "project_id": entry.get("project_id"),
        "status": status,
        "missing_assets": missing_assets,
        "audio_path": audio_rel,
        "reference_midi": ref_info_dict,
        "pipeline_output": pipeline_meta,
        "performance_metrics": performance_metrics,
        "notation_metrics": notation_metrics,
        "notes": entry.get("notes"),
    }


def render_markdown_report(report: dict[str, Any]) -> str:
    lines = [
        "# ScribaSheet Audio-to-MIDI Benchmark Report",
        "",
        f"- **Generated (UTC):** `{report['generated_at_utc']}`",
        f"- **Manifest:** `{report['manifest_path']}`",
        f"- **Onset Tolerance:** `{report['onset_tolerance_sec']}s`",
        "",
        "## Summary",
        "",
        "| Reference | Status | Audio | Reference MIDI | Ref Notes | Gen Notes | Precision | Recall | F1 | Mean Onset Diff (ms) |",
        "|---|---|---|---|---:|---:|---:|---:|---:|---:|",
    ]
    for item in report["results"]:
        ref_notes = item["reference_midi"]["note_count"] if item.get("reference_midi") else "—"
        gen_notes = item["pipeline_output"]["performance_midi_note_count"] if item.get("pipeline_output") else "—"
        pm = item.get("performance_metrics")
        prec = f"{pm['precision']:.4f}" if pm else "—"
        rec = f"{pm['recall']:.4f}" if pm else "—"
        f1 = f"{pm['f1']:.4f}" if pm else "—"
        onset_ms = f"{pm['mean_onset_diff_ms']:.2f}" if pm else "—"
        lines.append(
            f"| {item['name']} | `{item['status']}` | `{item.get('audio_path') or 'missing'}` | "
            f"`{(item.get('reference_midi') or {}).get('path') or 'missing'}` | {ref_notes} | {gen_notes} | "
            f"{prec} | {rec} | {f1} | {onset_ms} |"
        )

    lines.extend(["", "## Missing Assets & Limitations", ""])
    for item in report["results"]:
        if item["missing_assets"]:
            lines.append(
                f"- **{item['name']}** (`{item['status']}`): missing {', '.join(item['missing_assets'])}. {item.get('notes') or ''}"
            )
    return "\n".join(lines) + "\n"


def run_benchmark(
    manifest_path: Path = DEFAULT_MANIFEST,
    output_dir: Path = DEFAULT_OUTPUT_DIR,
    repo_root: Path = REPO_ROOT,
) -> dict[str, Any]:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    onset_tol = float(manifest.get("onset_tolerance_sec", 0.080))
    results = [
        evaluate_benchmark_entry(entry, repo_root=repo_root, onset_tolerance_sec=onset_tol)
        for entry in manifest.get("entries", [])
    ]
    report = {
        "schema_version": "1.0",
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "manifest_path": str(manifest_path),
        "onset_tolerance_sec": onset_tol,
        "results": results,
    }
    output_dir.mkdir(parents=True, exist_ok=True)
    json_path = output_dir / "benchmark_report.json"
    md_path = output_dir / "benchmark_report.md"
    json_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    md_path.write_text(render_markdown_report(report), encoding="utf-8")
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description="Run ScribaSheet audio-to-MIDI benchmark.")
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT_DIR)
    args = parser.parse_args()
    report = run_benchmark(manifest_path=args.manifest, output_dir=args.output_dir)
    print(f"Benchmark completed: {len(report['results'])} entries -> {args.output_dir}")


if __name__ == "__main__":
    main()
