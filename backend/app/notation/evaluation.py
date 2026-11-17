"""Repeatable reference-MIDI evaluation utilities for ScribaSheet.

Used for offline diagnostics, engine benchmarking (Basic Pitch vs Transkun),
and regression tests against ground-truth MIDI files such as
``assets/midi/Closer Gehlee.mid``.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
import pretty_midi

from app.transcription.base import DetectedNote


@dataclass
class ReferenceMidiInfo:
    path: Path
    duration_sec: float
    tempo_bpm: float
    time_signature: str
    track_count: int
    piano_track_indices: list[int]
    notes: list[DetectedNote]


@dataclass
class NoteEvaluationReport:
    ref_count: int
    gen_count: int
    matched_count: int
    precision: float
    recall: float
    f1: float
    octave_errors: int
    extra_notes: int
    missing_notes: int
    onset_offset_sec: float
    mean_onset_diff_ms: float
    median_onset_diff_ms: float
    mean_duration_diff_ms: float
    median_duration_diff_ms: float
    polyphonic_frame_accuracy: float
    lh_precision: float
    lh_recall: float
    rh_precision: float
    rh_recall: float
    sample_octave_errors: list[dict[str, Any]] = field(default_factory=list)
    sample_extra_notes: list[dict[str, Any]] = field(default_factory=list)
    sample_missing_notes: list[dict[str, Any]] = field(default_factory=list)


def load_reference_midi(midi_path: str | Path) -> ReferenceMidiInfo:
    """Load piano tracks from a reference MIDI without assuming all tracks are piano."""
    path = Path(midi_path)
    pm = pretty_midi.PrettyMIDI(str(path))
    _, tempi = pm.get_tempo_changes()
    tempo_bpm = float(tempi[0]) if len(tempi) else 120.0
    if pm.time_signature_changes:
        ts = pm.time_signature_changes[0]
        time_signature = f"{ts.numerator}/{ts.denominator}"
    else:
        time_signature = "4/4"

    piano_indices: list[int] = []
    for idx, inst in enumerate(pm.instruments):
        if inst.is_drum or not inst.notes:
            continue
        name_l = (inst.name or "").lower()
        # General MIDI Acoustic/Electric Pianos are programs 0..7; also accept explicit piano track names
        if 0 <= inst.program <= 7 or "piano" in name_l or "keys" in name_l:
            piano_indices.append(idx)

    if not piano_indices:
        piano_indices = [
            idx for idx, inst in enumerate(pm.instruments) if not inst.is_drum and inst.notes
        ]

    notes: list[DetectedNote] = []
    for idx in piano_indices:
        for n in pm.instruments[idx].notes:
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

    return ReferenceMidiInfo(
        path=path,
        duration_sec=float(pm.get_end_time()),
        tempo_bpm=tempo_bpm,
        time_signature=time_signature,
        track_count=len(pm.instruments),
        piano_track_indices=piano_indices,
        notes=notes,
    )


def estimate_global_onset_offset(
    ref_notes: list[DetectedNote],
    gen_notes: list[DetectedNote],
    max_shift_sec: float = 2.0,
) -> float:
    """Estimate constant alignment shift (gen - ref) using onset-pair histogram."""
    if not ref_notes or not gen_notes:
        return 0.0
    ref_by_pitch: dict[int, list[float]] = {}
    for n in ref_notes:
        ref_by_pitch.setdefault(n.pitch_midi, []).append(n.onset_sec)

    diffs: list[float] = []
    for g in gen_notes[:600]:
        r_onsets = ref_by_pitch.get(g.pitch_midi)
        if not r_onsets:
            continue
        for r_on in r_onsets:
            d = g.onset_sec - r_on
            if abs(d) <= max_shift_sec:
                diffs.append(d)
    if not diffs:
        return 0.0
    # 20ms histogram bin peak
    bins = np.arange(-max_shift_sec, max_shift_sec + 0.02, 0.02)
    hist, edges = np.histogram(diffs, bins=bins)
    peak_idx = int(np.argmax(hist))
    if hist[peak_idx] < 3:
        return 0.0
    center = 0.5 * (edges[peak_idx] + edges[peak_idx + 1])
    inliers = [d for d in diffs if abs(d - center) <= 0.04]
    return float(np.median(inliers)) if inliers else float(center)


def evaluate_notes_against_reference(
    ref_notes: list[DetectedNote],
    gen_notes: list[DetectedNote],
    *,
    onset_tolerance_sec: float = 0.080,
    align_onset_offset: bool = True,
) -> NoteEvaluationReport:
    """Evaluate generated notes against reference notes with onset alignment."""
    shift = estimate_global_onset_offset(ref_notes, gen_notes) if align_onset_offset else 0.0
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

    ref_used: set[int] = set()
    gen_used: set[int] = set()
    onset_diffs_ms: list[float] = []
    dur_diffs_ms: list[float] = []

    # 1. Exact pitch matching (closest onset within tolerance)
    candidates: list[tuple[float, int, int]] = []
    ref_by_pitch: dict[int, list[int]] = {}
    for ri, rn in enumerate(ref_notes):
        ref_by_pitch.setdefault(rn.pitch_midi, []).append(ri)

    for gi, gn in enumerate(aligned_gen):
        for ri in ref_by_pitch.get(gn.pitch_midi, ()):
            dt = abs(gn.onset_sec - ref_notes[ri].onset_sec)
            if dt <= onset_tolerance_sec:
                candidates.append((dt, ri, gi))
    candidates.sort(key=lambda x: x[0])

    for _, ri, gi in candidates:
        if ri in ref_used or gi in gen_used:
            continue
        ref_used.add(ri)
        gen_used.add(gi)
        rn = ref_notes[ri]
        gn = aligned_gen[gi]
        onset_diffs_ms.append((gn.onset_sec - rn.onset_sec) * 1000.0)
        dur_diffs_ms.append(((gn.offset_sec - gn.onset_sec) - (rn.offset_sec - rn.onset_sec)) * 1000.0)

    # 2. Octave error analysis on unmatched generated notes
    octave_errors = 0
    sample_octave_errors: list[dict[str, Any]] = []
    for gi, gn in enumerate(aligned_gen):
        if gi in gen_used:
            continue
        for semi in (-24, -12, 12, 24):
            target_pitch = gn.pitch_midi - semi
            found = False
            for ri in ref_by_pitch.get(target_pitch, ()):
                if abs(gn.onset_sec - ref_notes[ri].onset_sec) <= onset_tolerance_sec:
                    octave_errors += 1
                    if len(sample_octave_errors) < 15:
                        sample_octave_errors.append(
                            {
                                "gen_pitch": gn.pitch_midi,
                                "ref_pitch": target_pitch,
                                "semitone_diff": semi,
                                "onset_sec": round(gn.onset_sec, 3),
                            }
                        )
                    found = True
                    break
            if found:
                break

    matched = len(ref_used)
    ref_count = len(ref_notes)
    gen_count = len(aligned_gen)
    precision = matched / gen_count if gen_count else 0.0
    recall = matched / ref_count if ref_count else 0.0
    f1 = (2 * precision * recall / (precision + recall)) if (precision + recall) else 0.0

    # LH (<60) and RH (>=60) breakdown
    ref_lh = sum(1 for n in ref_notes if n.pitch_midi < 60)
    ref_rh = ref_count - ref_lh
    gen_lh = sum(1 for n in aligned_gen if n.pitch_midi < 60)
    gen_rh = gen_count - gen_lh
    matched_lh = sum(1 for ri in ref_used if ref_notes[ri].pitch_midi < 60)
    matched_rh = matched - matched_lh

    # Polyphonic cluster accuracy (reference clusters >= 2 simultaneous notes within 40ms)
    poly_total = 0
    poly_matched = 0
    i = 0
    while i < ref_count:
        j = i + 1
        while j < ref_count and ref_notes[j].onset_sec - ref_notes[i].onset_sec <= 0.04:
            j += 1
        if j - i >= 2:
            poly_total += j - i
            poly_matched += sum(1 for k in range(i, j) if k in ref_used)
        i = j

    sample_extra = [
        {
            "pitch_midi": aligned_gen[gi].pitch_midi,
            "onset_sec": round(aligned_gen[gi].onset_sec, 3),
            "duration_sec": round(aligned_gen[gi].offset_sec - aligned_gen[gi].onset_sec, 3),
        }
        for gi in range(gen_count)
        if gi not in gen_used
    ][:15]
    sample_missing = [
        {
            "pitch_midi": ref_notes[ri].pitch_midi,
            "onset_sec": round(ref_notes[ri].onset_sec, 3),
            "duration_sec": round(ref_notes[ri].offset_sec - ref_notes[ri].onset_sec, 3),
        }
        for ri in range(ref_count)
        if ri not in ref_used
    ][:15]

    return NoteEvaluationReport(
        ref_count=ref_count,
        gen_count=gen_count,
        matched_count=matched,
        precision=round(precision, 4),
        recall=round(recall, 4),
        f1=round(f1, 4),
        octave_errors=octave_errors,
        extra_notes=gen_count - matched,
        missing_notes=ref_count - matched,
        onset_offset_sec=round(shift, 4),
        mean_onset_diff_ms=round(float(np.mean(onset_diffs_ms)), 2) if onset_diffs_ms else 0.0,
        median_onset_diff_ms=round(float(np.median(onset_diffs_ms)), 2) if onset_diffs_ms else 0.0,
        mean_duration_diff_ms=round(float(np.mean(dur_diffs_ms)), 2) if dur_diffs_ms else 0.0,
        median_duration_diff_ms=round(float(np.median(dur_diffs_ms)), 2) if dur_diffs_ms else 0.0,
        polyphonic_frame_accuracy=round(poly_matched / poly_total, 4) if poly_total else 0.0,
        lh_precision=round(matched_lh / gen_lh, 4) if gen_lh else 0.0,
        lh_recall=round(matched_lh / ref_lh, 4) if ref_lh else 0.0,
        rh_precision=round(matched_rh / gen_rh, 4) if gen_rh else 0.0,
        rh_recall=round(matched_rh / ref_rh, 4) if ref_rh else 0.0,
        sample_octave_errors=sample_octave_errors,
        sample_extra_notes=sample_extra,
        sample_missing_notes=sample_missing,
    )
