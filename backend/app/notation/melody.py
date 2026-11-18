"""Monophonic lead-melody extraction for ScribaSheet Lead Melody mode."""

from __future__ import annotations

from dataclasses import dataclass, field
from statistics import median
from typing import Any

from app.transcription.base import DetectedNote

LEAD_MELODY_MODE_ALIASES = frozenset({"lead_melody", "melody"})


def is_lead_melody_mode(mode: str | None) -> bool:
    """Return True when the transcription mode requests Lead Melody extraction."""
    if not mode:
        return False
    return mode.strip().lower() in LEAD_MELODY_MODE_ALIASES


def normalize_transcription_mode(mode: str | None, default: str = "piano_arrangement") -> str:
    """Normalize mode aliases while preserving non-melody modes."""
    cleaned = (mode or "").strip().lower()
    if not cleaned:
        return default
    if cleaned in LEAD_MELODY_MODE_ALIASES:
        return "melody"
    return cleaned


@dataclass
class MelodyExtractionResult:
    """Result of monophonic lead-melody extraction."""

    notes: list[DetectedNote]
    stats: dict[str, Any] = field(default_factory=dict)
    uncertain_segments: list[dict[str, Any]] = field(default_factory=list)


def _cluster_by_onset(
    notes: list[DetectedNote],
    onset_tolerance_sec: float,
) -> list[list[DetectedNote]]:
    """Group nearly simultaneous note onsets into ordered clusters."""
    if not notes:
        return []
    ordered = sorted(notes, key=lambda n: (n.onset_sec, n.pitch_midi))
    clusters: list[list[DetectedNote]] = [[ordered[0]]]
    anchor_onset = ordered[0].onset_sec
    for note in ordered[1:]:
        if note.onset_sec - anchor_onset <= onset_tolerance_sec:
            clusters[-1].append(note)
        else:
            clusters.append([note])
            anchor_onset = note.onset_sec
    return clusters


def _estimate_melody_anchor_pitch(clusters: list[list[DetectedNote]]) -> float:
    """Estimate a soft melodic register center without imposing a hard pitch cutoff."""
    representative_pitches: list[int] = []
    for cluster in clusters:
        # Weight toward prominent/upper notes in polyphonic clusters, but include
        # solo notes as-is so low-register melodies keep their true register.
        if len(cluster) == 1:
            representative_pitches.append(cluster[0].pitch_midi)
        else:
            best = max(
                cluster,
                key=lambda n: (
                    n.pitch_midi * 0.08
                    + (n.velocity / 127.0) * 1.2
                    + min(max(n.offset_sec - n.onset_sec, 0.02), 1.5) * 0.8
                ),
            )
            representative_pitches.append(best.pitch_midi)
    if not representative_pitches:
        return 64.0
    return float(median(representative_pitches))


def _is_likely_harmonic_overtone(note: DetectedNote, cluster: list[DetectedNote]) -> bool:
    """Detect weak +12/+19/+24 harmonic overtone blips above a strong fundamental."""
    if note.velocity >= 62 and (note.confidence is None or note.confidence >= 0.55):
        return False
    note_dur = max(0.0, note.offset_sec - note.onset_sec)
    for other in cluster:
        if other is note:
            continue
        interval = note.pitch_midi - other.pitch_midi
        if interval not in (12, 19, 24):
            continue
        other_dur = max(0.0, other.offset_sec - other.onset_sec)
        stronger_vel = other.velocity >= note.velocity + 15
        stronger_conf = (other.confidence or 0.7) >= (note.confidence or 0.5) + 0.12
        if (stronger_vel or stronger_conf) and other_dur >= note_dur * 0.85:
            return True
    return False


def _unary_score(
    note: DetectedNote,
    cluster: list[DetectedNote],
    anchor_pitch: float,
) -> float:
    """Score a candidate note's melodic salience within its onset cluster."""
    dur = max(0.0, note.offset_sec - note.onset_sec)
    vel_score = (max(1, min(127, note.velocity)) / 127.0) * 1.4
    conf_val = 0.72 if note.confidence is None else max(0.0, min(1.0, note.confidence))
    conf_score = conf_val * 1.0

    # Sustained notes are much more likely to carry a melody than tiny transients.
    dur_score = min(dur, 1.5) * 0.9
    if dur < 0.06:
        dur_score -= 0.9

    # Relative height within a simultaneous chord favors the top voice gently,
    # while single-note clusters incur zero pitch-height bias.
    rel_height_score = 0.0
    if len(cluster) > 1:
        pitches = [c.pitch_midi for c in cluster]
        lo, hi = min(pitches), max(pitches)
        if hi > lo:
            rel_height_score = ((note.pitch_midi - lo) / (hi - lo)) * 1.15

    # Soft pull toward the piece's melodic register center.
    register_penalty = 0.045 * abs(note.pitch_midi - anchor_pitch)

    # Reject weak harmonic overtones over a strong fundamental.
    overtone_penalty = 2.2 if _is_likely_harmonic_overtone(note, cluster) else 0.0

    return vel_score + conf_score + dur_score + rel_height_score - register_penalty - overtone_penalty


def _transition_score(prev_note: DetectedNote, cur_note: DetectedNote) -> float:
    """Score melodic continuity between consecutive chosen notes."""
    interval = abs(cur_note.pitch_midi - prev_note.pitch_midi)
    gap_sec = max(0.0, cur_note.onset_sec - prev_note.offset_sec)
    # Phrase breaks (> 0.9s rest) allow wider register resets cleanly.
    leap_scale = 0.45 if gap_sec > 0.9 else 1.0

    if interval == 0:
        contour_score = 0.85
    elif interval <= 4:
        contour_score = 1.25
    elif interval <= 7:
        contour_score = 0.75
    elif interval <= 12:
        contour_score = -0.25 * leap_scale
    else:
        contour_score = (-0.25 - 0.22 * (interval - 12)) * leap_scale

    # Slight rhythmic continuity bonus when the next note enters near the end
    # of or shortly after the previous note.
    overlap = prev_note.offset_sec - cur_note.onset_sec
    timing_score = 0.2 if -0.35 <= overlap <= 0.08 else 0.0
    return contour_score + timing_score


def _enforce_monophony(
    notes: list[DetectedNote],
    min_gap_sec: float = 0.005,
    min_duration_sec: float = 0.025,
) -> tuple[list[DetectedNote], int]:
    """Ensure zero simultaneous or overlapping notes in the extracted melody."""
    if not notes:
        return [], 0

    ordered = sorted(notes, key=lambda n: (n.onset_sec, -n.velocity, -n.pitch_midi))
    monophonic: list[DetectedNote] = []
    trimmed_count = 0

    for cur in ordered:
        cur_copy = DetectedNote(
            pitch_midi=cur.pitch_midi,
            onset_sec=cur.onset_sec,
            offset_sec=max(cur.onset_sec + min_duration_sec, cur.offset_sec),
            velocity=cur.velocity,
            confidence=cur.confidence,
        )
        if not monophonic:
            monophonic.append(cur_copy)
            continue

        prev = monophonic[-1]
        if cur_copy.onset_sec - prev.onset_sec < 0.015:
            # Practically simultaneous onset: keep whichever note is stronger/higher.
            prev_rank = prev.velocity + (prev.pitch_midi * 0.5)
            cur_rank = cur_copy.velocity + (cur_copy.pitch_midi * 0.5)
            if cur_rank > prev_rank:
                monophonic[-1] = cur_copy
            trimmed_count += 1
            continue

        if prev.offset_sec > cur_copy.onset_sec - min_gap_sec:
            new_offset = cur_copy.onset_sec - min_gap_sec
            if new_offset - prev.onset_sec >= min_duration_sec:
                prev.offset_sec = new_offset
            else:
                prev.offset_sec = max(prev.onset_sec + 0.01, cur_copy.onset_sec - 0.001)
            trimmed_count += 1

        monophonic.append(cur_copy)

    return monophonic, trimmed_count


def extract_lead_melody(
    notes: list[DetectedNote],
    tempo_bpm: float = 120.0,
    timing_map: Any = None,
) -> MelodyExtractionResult:
    """Extract a single, coherent monophonic melody line from polyphonic notes.

    Uses dynamic programming over onset clusters to balance melodic contour
    continuity, sustained prominence, velocity/confidence, and harmonic-overtone
    rejection without hard low-pitch cutoffs.
    """
    valid_notes = [n for n in notes if n.offset_sec > n.onset_sec]
    if not valid_notes:
        return MelodyExtractionResult(
            notes=[],
            stats={
                "input_note_count": len(notes),
                "output_note_count": 0,
                "cluster_count": 0,
                "average_pitch_midi": 0.0,
                "average_confidence": 0.0,
                "uncertain_segment_count": 0,
                "trimmed_overlaps": 0,
            },
            uncertain_segments=[],
        )

    effective_bpm = float(getattr(timing_map, "tempo_bpm", None) or tempo_bpm or 120.0)
    beat_sec = 60.0 / max(30.0, effective_bpm)
    onset_tolerance_sec = max(0.025, min(0.055, beat_sec * 0.08))

    clusters = _cluster_by_onset(valid_notes, onset_tolerance_sec=onset_tolerance_sec)
    anchor_pitch = _estimate_melody_anchor_pitch(clusters)

    dp_scores: list[list[float]] = []
    backpointers: list[list[int]] = []
    uncertain_segments: list[dict[str, Any]] = []

    first_scores = [_unary_score(n, clusters[0], anchor_pitch) for n in clusters[0]]
    dp_scores.append(first_scores)
    backpointers.append([-1] * len(clusters[0]))

    for idx in range(1, len(clusters)):
        prev_cluster = clusters[idx - 1]
        cur_cluster = clusters[idx]
        prev_dp = dp_scores[idx - 1]
        cur_dp: list[float] = []
        cur_bp: list[int] = []

        for cur_note in cur_cluster:
            unary = _unary_score(cur_note, cur_cluster, anchor_pitch)
            best_total = float("-inf")
            best_prev = 0
            for prev_idx, prev_note in enumerate(prev_cluster):
                total = prev_dp[prev_idx] + _transition_score(prev_note, cur_note) + unary
                if total > best_total:
                    best_total = total
                    best_prev = prev_idx
            cur_dp.append(best_total)
            cur_bp.append(best_prev)

        dp_scores.append(cur_dp)
        backpointers.append(cur_bp)

        if len(cur_dp) > 1:
            sorted_scores = sorted(cur_dp, reverse=True)
            margin = sorted_scores[0] - sorted_scores[1]
            if margin < 0.35:
                uncertain_segments.append(
                    {
                        "onset_sec": round(cur_cluster[0].onset_sec, 3),
                        "candidate_pitches": [c.pitch_midi for c in cur_cluster],
                        "margin": round(margin, 3),
                        "reason": "close_melodic_candidates",
                    }
                )

    # Backtrack optimal path.
    chosen_indices = [0] * len(clusters)
    last_scores = dp_scores[-1]
    chosen_indices[-1] = max(range(len(last_scores)), key=lambda i: last_scores[i])
    for idx in range(len(clusters) - 1, 0, -1):
        chosen_indices[idx - 1] = backpointers[idx][chosen_indices[idx]]

    raw_selected = [clusters[idx][chosen_indices[idx]] for idx in range(len(clusters))]

    # Suppress quiet accompaniment taps that occur underneath a still-ringing
    # prominent melody note (e.g., an isolated bass/inner tap during a held melody).
    filtered_selected: list[DetectedNote] = []
    for note in raw_selected:
        if filtered_selected:
            prev = filtered_selected[-1]
            note_dur = note.offset_sec - note.onset_sec
            if (
                prev.offset_sec > note.onset_sec + 0.14
                and note.pitch_midi <= prev.pitch_midi - 10
                and note.velocity + 12 < prev.velocity
                and note_dur < 0.35
            ):
                continue
        filtered_selected.append(note)

    monophonic_notes, trimmed_overlaps = _enforce_monophony(filtered_selected)

    avg_pitch = (
        sum(n.pitch_midi for n in monophonic_notes) / len(monophonic_notes)
        if monophonic_notes
        else 0.0
    )
    confs = [n.confidence for n in monophonic_notes if n.confidence is not None]
    avg_conf = (sum(confs) / len(confs)) if confs else 0.0

    return MelodyExtractionResult(
        notes=monophonic_notes,
        stats={
            "input_note_count": len(notes),
            "output_note_count": len(monophonic_notes),
            "cluster_count": len(clusters),
            "anchor_pitch_midi": round(anchor_pitch, 2),
            "average_pitch_midi": round(avg_pitch, 2),
            "average_confidence": round(avg_conf, 3),
            "uncertain_segment_count": len(uncertain_segments),
            "trimmed_overlaps": trimmed_overlaps,
        },
        uncertain_segments=uncertain_segments,
    )
