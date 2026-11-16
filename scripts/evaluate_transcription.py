"""Local evaluation harness for ScribaSheet audio-to-score transcription."""

from __future__ import annotations

import argparse
import dataclasses
import hashlib
import inspect
import itertools
import json
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
from collections import defaultdict
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import music21
import numpy as np

REPO_ROOT = Path(__file__).resolve().parent.parent
BACKEND_DIR = REPO_ROOT / "backend"
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.audio.processor import preprocess_to_wav, probe_media
from app.notation.analyzer import (
    estimate_key_signature,
    estimate_tempo,
)
from app.notation.generator import (
    build_score_data,
    render_score_pdf,
    score_data_to_midi_bytes,
    score_data_to_musicxml,
)
from app.transcription.base import DetectedNote
from app.transcription.basic_pitch_provider import (
    BasicPitchProvider,
    resolve_onnx_model_path,
    verify_onnx_cpu_runtime,
)


def _count_suspected_octave_duplicates(notes: list[DetectedNote], max_onset_diff_sec: float = 0.04) -> int:
    sorted_notes = sorted(notes, key=lambda n: (n.onset_sec, n.pitch_midi))
    count = 0
    for i, a in enumerate(sorted_notes):
        for j in range(i + 1, len(sorted_notes)):
            b = sorted_notes[j]
            if b.onset_sec - a.onset_sec > max_onset_diff_sec:
                break
            diff = abs(b.pitch_midi - a.pitch_midi)
            if diff in (12, 24):
                overlap = min(a.offset_sec, b.offset_sec) - max(a.onset_sec, b.onset_sec)
                if overlap > 0.02:
                    count += 1
    return count


def _count_rapid_reattacks(notes: list[DetectedNote], max_gap_sec: float = 0.06) -> int:
    by_pitch: dict[int, list[DetectedNote]] = defaultdict(list)
    for n in notes:
        by_pitch[n.pitch_midi].append(n)
    count = 0
    for pitch_notes in by_pitch.values():
        pitch_notes.sort(key=lambda n: n.onset_sec)
        for prev, curr in itertools.pairwise(pitch_notes):
            gap = curr.onset_sec - prev.offset_sec
            if gap <= max_gap_sec:
                count += 1
    return count


def _summarize_notes(notes: list[DetectedNote]) -> dict[str, Any]:
    if not notes:
        return {
            "count": 0,
            "min_pitch": None,
            "max_pitch": None,
            "durations_sec": {},
            "velocities": {},
            "confidences": {},
            "short_notes_lt_55ms": 0,
            "suspected_octave_duplicates": 0,
            "rapid_same_pitch_reattacks_le_60ms": 0,
        }
    pitches = [n.pitch_midi for n in notes]
    durs = [max(0.0, n.offset_sec - n.onset_sec) for n in notes]
    vels = [n.velocity for n in notes]
    confs = [n.confidence for n in notes if n.confidence is not None]
    return {
        "count": len(notes),
        "min_pitch": min(pitches),
        "max_pitch": max(pitches),
        "pitch_span_semitones": max(pitches) - min(pitches),
        "durations_sec": {
            "min": round(float(min(durs)), 4),
            "median": round(float(np.median(durs)), 4),
            "mean": round(float(np.mean(durs)), 4),
            "max": round(float(max(durs)), 4),
        },
        "velocities": {
            "min": int(min(vels)),
            "mean": round(float(np.mean(vels)), 2),
            "max": int(max(vels)),
        },
        "confidences": {
            "min": round(float(min(confs)), 4) if confs else None,
            "mean": round(float(np.mean(confs)), 4) if confs else None,
            "max": round(float(max(confs)), 4) if confs else None,
        },
        "short_notes_lt_55ms": sum(1 for d in durs if d < 0.055),
        "suspected_octave_duplicates": _count_suspected_octave_duplicates(notes),
        "rapid_same_pitch_reattacks_le_60ms": _count_rapid_reattacks(notes),
    }


def validate_musicxml_integrity(musicxml_str: str) -> dict[str, Any]:
    """Validate MusicXML parseability and per-voice measure tick totals."""
    parse_ok = False
    parse_error: str | None = None
    m21_parts = 0
    m21_measures_per_part: list[int] = []
    try:
        parsed = music21.converter.parseData(musicxml_str, format="musicxml")
        parse_ok = True
        parts = list(parsed.parts) if hasattr(parsed, "parts") else []
        m21_parts = len(parts)
        m21_measures_per_part = [len(p.getElementsByClass(music21.stream.Measure)) for p in parts]
    except (OSError, ValueError, music21.exceptions21.Music21Exception) as exc:
        parse_error = str(exc)

    overflow_measures: list[dict[str, Any]] = []
    underflow_measures: list[dict[str, Any]] = []
    xml_parts = 0
    xml_measures_per_part: list[int] = []

    try:
        root = ET.fromstring(musicxml_str)
        parts = root.findall("part")
        xml_parts = len(parts)
        for p_idx, part in enumerate(parts):
            measures = part.findall("measure")
            xml_measures_per_part.append(len(measures))
            divisions = 1
            beats = 4
            beat_type = 4
            for m in measures:
                m_num = m.attrib.get("number", "?")
                attrs = m.find("attributes")
                if attrs is not None:
                    div_el = attrs.find("divisions")
                    if div_el is not None and div_el.text:
                        divisions = int(div_el.text)
                    time_el = attrs.find("time")
                    if time_el is not None:
                        b_el = time_el.find("beats")
                        bt_el = time_el.find("beat-type")
                        if b_el is not None and b_el.text:
                            beats = int(b_el.text)
                        if bt_el is not None and bt_el.text:
                            beat_type = int(bt_el.text)
                expected_ticks = round(divisions * beats * (4.0 / beat_type))

                voice_ticks: dict[str, int] = defaultdict(int)
                for child in m:
                    if child.tag == "note":
                        if child.find("chord") is not None:
                            continue
                        if child.find("grace") is not None:
                            continue
                        dur_el = child.find("duration")
                        dur = int(dur_el.text) if dur_el is not None and dur_el.text else 0
                        v_el = child.find("voice")
                        voice_id = v_el.text.strip() if v_el is not None and v_el.text else "1"
                        voice_ticks[voice_id] += dur

                for voice_id, total_ticks in sorted(voice_ticks.items()):
                    if total_ticks > expected_ticks:
                        overflow_measures.append(
                            {
                                "part_index": p_idx,
                                "measure": m_num,
                                "voice": voice_id,
                                "actual_ticks": total_ticks,
                                "expected_ticks": expected_ticks,
                            }
                        )
                    elif total_ticks < expected_ticks:
                        underflow_measures.append(
                            {
                                "part_index": p_idx,
                                "measure": m_num,
                                "voice": voice_id,
                                "actual_ticks": total_ticks,
                                "expected_ticks": expected_ticks,
                            }
                        )
    except (ET.ParseError, ValueError) as exc:
        parse_ok = False
        parse_error = parse_error or str(exc)

    return {
        "music21_parse_ok": parse_ok,
        "music21_parse_error": parse_error,
        "music21_parts": m21_parts,
        "music21_measures_per_part": m21_measures_per_part,
        "xml_parts": xml_parts,
        "xml_measures_per_part": xml_measures_per_part,
        "overflow_measure_count": len(overflow_measures),
        "underflow_measure_count": len(underflow_measures),
        "overflow_measures_sample": overflow_measures[:10],
        "underflow_measures_sample": underflow_measures[:10],
        "structural_integrity_ok": parse_ok and len(overflow_measures) == 0 and len(underflow_measures) == 0,
    }


def _evaluate_against_ground_truth(
    predicted: list[DetectedNote],
    gt_path: Path,
    onset_tolerance_sec: float = 0.05,
) -> dict[str, Any]:
    gt_notes: list[tuple[int, float]] = []
    if gt_path.suffix.lower() in (".mid", ".midi"):
        import pretty_midi

        pm = pretty_midi.PrettyMIDI(str(gt_path))
        for inst in pm.instruments:
            if inst.is_drum:
                continue
            for n in inst.notes:
                gt_notes.append((n.pitch, float(n.start)))
    else:
        parsed = music21.converter.parse(str(gt_path))
        for el in parsed.recurse().notes:
            offset_sec = float(el.offset) * 0.5  # fallback if no tempo
            if isinstance(el, music21.note.Note):
                gt_notes.append((el.pitch.midi, offset_sec))
            elif isinstance(el, music21.chord.Chord):
                for p in el.pitches:
                    gt_notes.append((p.midi, offset_sec))

    matched_gt: set[int] = set()
    tp = 0
    for pred in predicted:
        for idx, (gt_pitch, gt_onset) in enumerate(gt_notes):
            if idx in matched_gt:
                continue
            if pred.pitch_midi == gt_pitch and abs(pred.onset_sec - gt_onset) <= onset_tolerance_sec:
                matched_gt.add(idx)
                tp += 1
                break
    precision = tp / len(predicted) if predicted else 0.0
    recall = tp / len(gt_notes) if gt_notes else 0.0
    f1 = (2 * precision * recall / (precision + recall)) if (precision + recall) > 0 else 0.0
    return {
        "ground_truth_file": str(gt_path),
        "gt_note_count": len(gt_notes),
        "predicted_note_count": len(predicted),
        "true_positives": tp,
        "precision": round(precision, 4),
        "recall": round(recall, 4),
        "f1": round(f1, 4),
    }


def _compute_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest().upper()


def _get_git_provenance(repo_root: Path) -> dict[str, Any]:
    commit_sha: str | None = None
    dirty: bool | None = None
    try:
        res = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=str(repo_root),
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
        if res.returncode == 0 and res.stdout.strip():
            commit_sha = res.stdout.strip()
        st = subprocess.run(
            ["git", "status", "--porcelain"],
            cwd=str(repo_root),
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
        if st.returncode == 0:
            dirty = bool(st.stdout.strip())
    except (OSError, subprocess.SubprocessError):
        commit_sha = commit_sha or None
    return {"git_commit_sha": commit_sha, "git_dirty": dirty}


def main() -> int:
    parser = argparse.ArgumentParser(description="Evaluate ScribaSheet transcription pipeline.")
    parser.add_argument("--audio", required=True, type=Path, help="Input audio/video file path")
    parser.add_argument("--expected-bpm", type=float, default=None)
    parser.add_argument("--expected-key", type=str, default=None)
    parser.add_argument("--expected-time-signature", type=str, default="4/4")
    parser.add_argument("--instrument", type=str, default="piano")
    parser.add_argument("--title", type=str, default=None)
    parser.add_argument("--output", required=True, type=Path, help="Output JSON report path")
    parser.add_argument("--artifacts-dir", type=Path, default=None, help="Directory to save MIDI/MusicXML/PDF/raw JSON")
    parser.add_argument("--ground-truth-midi", type=Path, default=None)
    parser.add_argument("--ground-truth-musicxml", type=Path, default=None)
    args = parser.parse_args()

    audio_path = args.audio.resolve()
    if not audio_path.exists():
        print(f"ERROR: Audio file not found: {audio_path}", file=sys.stderr)
        return 1

    output_path = args.output.resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    artifacts_dir = (args.artifacts_dir or (output_path.parent / f"{output_path.stem}_artifacts")).resolve()
    artifacts_dir.mkdir(parents=True, exist_ok=True)

    verify_onnx_cpu_runtime(resolve_onnx_model_path())
    raw_meta = probe_media(audio_path)

    with tempfile.TemporaryDirectory() as tmpdir:
        wav_path = Path(tmpdir) / "preprocessed.wav"
        wav_meta = preprocess_to_wav(audio_path, wav_path)

        provider = BasicPitchProvider()
        tx_out = provider.transcribe(wav_path)
        raw_notes = tx_out.notes

        # Use note refiner if available in codebase
        refined_notes = raw_notes
        refiner_stats: dict[str, Any] = {"enabled": False}
        refiner_config_dict: dict[str, Any] | None = None
        try:
            from app.transcription.note_refiner import (  # type: ignore
                NoteRefinerConfig,
                refine_detected_notes,
            )

            cfg = NoteRefinerConfig()
            refiner_config_dict = dataclasses.asdict(cfg)
            refined_result = refine_detected_notes(raw_notes, config=cfg)
            refined_notes = refined_result.notes
            refiner_stats = {"enabled": True, **refined_result.stats}
        except ImportError:
            pass

        tempo_kwargs: dict[str, Any] = {"tempo_mode": "auto", "manual_tempo_bpm": None}
        uses_refined_notes_for_tempo = "notes" in inspect.signature(estimate_tempo).parameters
        if uses_refined_notes_for_tempo:
            tempo_kwargs["notes"] = refined_notes
        tempo_bpm, tempo_estimated = estimate_tempo(wav_path, **tempo_kwargs)
        key_sig, key_estimated = estimate_key_signature(refined_notes, key_setting="auto")

        title = args.title or audio_path.stem
        score_data = build_score_data(
            title=title,
            detected_notes=refined_notes,
            tempo_bpm=tempo_bpm,
            tempo_estimated=tempo_estimated,
            time_signature=args.expected_time_signature,
            time_signature_estimated=True,
            key_signature=key_sig,
            key_signature_estimated=key_estimated,
            duration_seconds=wav_meta.duration_seconds,
            instrument=args.instrument,
            quantization="sixteenth",
            analysis={"refiner": refiner_stats},
        )

        midi_bytes = score_data_to_midi_bytes(score_data)
        musicxml_str = score_data_to_musicxml(score_data)
        pdf_bytes = render_score_pdf(score_data)

    # Write artifacts
    def _serialize_notes(items: list[DetectedNote]) -> list[dict[str, Any]]:
        return [
            {
                "pitch_midi": n.pitch_midi,
                "onset_sec": round(n.onset_sec, 4),
                "offset_sec": round(n.offset_sec, 4),
                "duration_sec": round(max(0.0, n.offset_sec - n.onset_sec), 4),
                "velocity": n.velocity,
                "confidence": round(n.confidence, 4) if n.confidence is not None else None,
            }
            for n in items
        ]

    (artifacts_dir / "raw_notes.json").write_text(
        json.dumps(_serialize_notes(raw_notes), indent=2), encoding="utf-8"
    )
    (artifacts_dir / "refined_notes.json").write_text(
        json.dumps(_serialize_notes(refined_notes), indent=2), encoding="utf-8"
    )
    (artifacts_dir / "score.mid").write_bytes(midi_bytes)
    (artifacts_dir / "score.musicxml").write_text(musicxml_str, encoding="utf-8")
    (artifacts_dir / "score.pdf").write_bytes(pdf_bytes)

    musicxml_integrity = validate_musicxml_integrity(musicxml_str)

    tempo_eval: dict[str, Any] = {
        "estimated_bpm": tempo_bpm,
        "expected_bpm": args.expected_bpm,
    }
    if args.expected_bpm:
        tempo_eval["abs_error_bpm"] = round(abs(tempo_bpm - args.expected_bpm), 2)
        tempo_eval["ratio_to_expected"] = round(tempo_bpm / args.expected_bpm, 3)

    key_eval: dict[str, Any] = {
        "estimated_key": key_sig,
        "expected_key": args.expected_key,
    }
    if args.expected_key:
        key_eval["exact_match"] = key_sig.lower() == args.expected_key.lower()

    gt_eval: dict[str, Any] | None = None
    if args.ground_truth_midi:
        gt_eval = _evaluate_against_ground_truth(refined_notes, args.ground_truth_midi)
    elif args.ground_truth_musicxml:
        gt_eval = _evaluate_against_ground_truth(refined_notes, args.ground_truth_musicxml)

    git_prov = _get_git_provenance(REPO_ROOT)
    wav_sha256 = _compute_sha256(audio_path)
    eval_ts = datetime.now(UTC).isoformat()

    report: dict[str, Any] = {
        "provenance": {
            "wav_sha256": wav_sha256,
            "git_commit_sha": git_prov["git_commit_sha"],
            "git_dirty": git_prov["git_dirty"],
            "expected_bpm": args.expected_bpm,
            "expected_key": args.expected_key,
            "expected_time_signature": args.expected_time_signature,
            "transcription_engine": tx_out.engine,
            "inference_provider": tx_out.metadata.get("provider", "CPUExecutionProvider"),
            "refiner_config": refiner_config_dict,
            "tempo_analysis_config": {
                "tempo_mode": "auto",
                "manual_tempo_bpm": None,
                "uses_refined_notes": uses_refined_notes_for_tempo,
            },
            "source_duration_sec": round(raw_meta.duration_seconds, 3),
            "evaluation_timestamp": eval_ts,
        },
        "audio_file": str(audio_path),
        "audio_metadata": {
            "source_duration_sec": round(raw_meta.duration_seconds, 3),
            "source_sample_rate": raw_meta.sample_rate,
            "source_channels": raw_meta.channels,
            "preprocessed_duration_sec": round(wav_meta.duration_seconds, 3),
            "preprocessed_sample_rate": wav_meta.sample_rate,
            "is_silent": wav_meta.is_silent,
        },
        "tempo": tempo_eval,
        "key": key_eval,
        "time_signature": args.expected_time_signature,
        "raw_notes_summary": _summarize_notes(raw_notes),
        "refined_notes_summary": _summarize_notes(refined_notes),
        "refiner_stats": refiner_stats,
        "score_summary": {
            "score_note_count": len(score_data.notes),
            "chord_count": len(score_data.chords),
            "chord_symbols": [c.symbol for c in score_data.chords],
            "chords": [
                {"measure": c.measure, "beat": c.beat, "onset_sec": c.onset_sec, "symbol": c.symbol}
                for c in score_data.chords
            ],
        },
        "musicxml_integrity": musicxml_integrity,
        "pdf_summary": {
            "bytes": len(pdf_bytes),
            "valid_pdf_header": pdf_bytes.startswith(b"%PDF-"),
        },
        "midi_summary": {
            "bytes": len(midi_bytes),
        },
        "ground_truth_eval": gt_eval,
        "artifacts_dir": str(artifacts_dir),
    }

    output_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
