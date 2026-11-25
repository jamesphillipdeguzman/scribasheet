"""Post-inference note-event refinement for Basic Pitch ONNX transcriptions.

Raw Basic Pitch note events are preserved untouched; this module produces a
separate refined list with configurable thresholds and logged decisions.
"""

from __future__ import annotations

import logging
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any

from app.transcription.base import DetectedNote

logger = logging.getLogger(__name__)


@dataclass
class NoteRefinerConfig:
    min_duration_sec: float = 0.055
    high_conf_short_min_duration_sec: float = 0.035
    high_conf_short_threshold: float = 0.72
    min_confidence: float = 0.28
    reattack_gap_sec: float = 0.060
    min_distinct_reattack_onset_sec: float = 0.110
    reattack_tail_min_conf_ratio: float = 0.55
    reattack_tail_max_duration_sec: float = 0.120
    reattack_trim_margin_sec: float = 0.005
    min_trimmed_duration_sec: float = 0.030
    reattack_genuine_conf_boost: float = 1.15
    reattack_genuine_vel_boost: int = 12
    enable_octave_ghost_suppression: bool = True
    enable_fifth_harmonic_suppression: bool = True
    octave_onset_window_sec: float = 0.035
    octave_confidence_ratio: float = 0.58
    fifth_confidence_ratio: float = 0.52
    octave_strong_fundamental_min_conf: float = 0.55
    harmonic_max_candidate_confidence: float = 0.52
    harmonic_velocity_ratio: float = 0.85
    harmonic_max_duration_ratio: float = 0.85
    octave_melodic_window_sec: float = 0.35
    max_note_duration_sec: float = 6.0
    enable_velocity_rescaling: bool = True
    velocity_min: int = 35
    velocity_max: int = 115


@dataclass
class NoteRefinementResult:
    notes: list[DetectedNote]
    raw_notes: list[DetectedNote]
    stats: dict[str, Any] = field(default_factory=dict)
    decisions: list[dict[str, Any]] = field(default_factory=list)


def _note_conf(note: DetectedNote) -> float:
    return float(note.confidence) if note.confidence is not None else 0.5


def _has_melodic_neighbor(
    candidate: DetectedNote,
    fundamental: DetectedNote,
    all_notes: list[DetectedNote],
    window_sec: float = 0.35,
    max_semitone_step: int = 4,
) -> bool:
    for other in all_notes:
        if other is candidate or other is fundamental:
            continue
        if abs(other.onset_sec - candidate.onset_sec) <= window_sec:
            diff = abs(other.pitch_midi - candidate.pitch_midi)
            # Require a true stepwise/small-leap neighbor with reasonable confidence/velocity
            # that is not merely a harmonic of the fundamental.
            other_strength_ok = (
                (other.confidence is not None and float(other.confidence) >= 0.45)
                or (other.confidence is None and other.velocity >= 52)
            )
            if 1 <= diff <= max_semitone_step and other_strength_ok:
                if abs(other.pitch_midi - fundamental.pitch_midi) not in (12, 24, 19):
                    return True
    return False


def _has_parallel_octave_continuity(
    candidate: DetectedNote,
    fundamental: DetectedNote,
    all_notes: list[DetectedNote],
    window_sec: float = 0.90,
) -> bool:
    """Protect genuine parallel-octave melodic doublings (e.g. RH octaves or LH octaves)."""
    interval = candidate.pitch_midi - fundamental.pitch_midi
    if interval not in (12, 24):
        return False
    # If another octave pair in nearby time has strong upper velocity/confidence, likely intentional doubling
    for other in all_notes:
        if other is candidate or other is fundamental:
            continue
        if 0.08 <= abs(other.onset_sec - candidate.onset_sec) <= window_sec:
            if abs(other.pitch_midi - candidate.pitch_midi) in (1, 2, 3, 4, 5, 7):
                # Check if that nearby note also has a lower octave partner within 35ms
                partner_pitch = other.pitch_midi - interval
                for partner in all_notes:
                    if partner.pitch_midi == partner_pitch and abs(partner.onset_sec - other.onset_sec) <= 0.04:
                        other_strong = (
                            (other.confidence is not None and float(other.confidence) >= 0.62)
                            or (other.confidence is None and other.velocity >= 68)
                        )
                        if other_strong:
                            return True
    return False


def _has_upper_triad_context(
    candidate: DetectedNote,
    fundamental: DetectedNote,
    all_notes: list[DetectedNote],
) -> bool:
    """Protect fifth/twelfth notes that are part of an upper chord voicing or strong lead melody."""
    # Check if candidate has simultaneous harmony notes forming a triad/chord above fundamental
    slice_notes = [
        n
        for n in all_notes
        if abs(n.onset_sec - candidate.onset_sec) <= 0.045 or (n.onset_sec <= candidate.onset_sec <= n.offset_sec - 0.04)
    ]
    if not slice_notes:
        return False
    highest_pitch = max(n.pitch_midi for n in slice_notes)
    if candidate.pitch_midi == highest_pitch and candidate.velocity >= 72:
        return True
    for other in slice_notes:
        if other is candidate or other is fundamental:
            continue
        # Ignore octave harmonics of the same fundamental so +12 and +19 ghosts don't protect each other
        fund_diff = other.pitch_midi - fundamental.pitch_midi
        if fund_diff in (12, 24) and other.velocity <= fundamental.velocity - 12:
            continue
        if other.pitch_midi > fundamental.pitch_midi:
            step = abs(other.pitch_midi - candidate.pitch_midi) % 12
            if step in (3, 4, 5, 7, 8, 9):
                return True
    return False


def _is_stepwise_grace_or_ornament(
    note: DetectedNote,
    ordered_notes: list[DetectedNote],
    idx: int,
    dur: float,
) -> bool:
    """Detect short intentional grace notes / ornaments resolving stepwise."""
    if not (0.025 <= dur < 0.055) or note.velocity < 52:
        return False
    # Check immediate next note(s) within 70ms moving stepwise (1-3 semitones)
    for j in range(idx + 1, min(len(ordered_notes), idx + 6)):
        nxt = ordered_notes[j]
        gap = nxt.onset_sec - note.onset_sec
        if gap > 0.075:
            break
        if 1 <= abs(nxt.pitch_midi - note.pitch_midi) <= 3 and nxt.velocity >= 50:
            return True
    return False


def refine_detected_notes(
    raw_notes: list[DetectedNote],
    config: NoteRefinerConfig | None = None,
) -> NoteRefinementResult:
    """Refine raw note events into clean musical notes without mutating raw_notes."""
    cfg = config or NoteRefinerConfig()
    decisions: list[dict[str, Any]] = []

    if not raw_notes:
        return NoteRefinementResult(
            notes=[],
            raw_notes=list(raw_notes),
            stats={
                "raw_count": 0,
                "filtered_short_or_low_conf": 0,
                "short_ornaments_preserved": 0,
                "reattack_merges": 0,
                "bass_sustain_merges": 0,
                "octave_ghosts_suppressed": 0,
                "fifth_harmonics_suppressed": 0,
                "refined_count": 0,
            },
            decisions=[],
        )

    ordered_raw = sorted(raw_notes, key=lambda x: (x.onset_sec, x.pitch_midi))
    vel_values = sorted(int(n.velocity) for n in ordered_raw)
    median_vel = vel_values[len(vel_values) // 2] if vel_values else 75
    adaptive_vel_short_keep = max(68, int(round(median_vel * 0.88)))

    # Stage A: Adaptive minimum duration, grace-note/ornament preservation, & confidence filtering
    stage_a: list[DetectedNote] = []
    filtered_short_or_low_conf = 0
    short_ornaments_preserved = 0
    for idx, n in enumerate(ordered_raw):
        dur = max(0.0, float(n.offset_sec) - float(n.onset_sec))
        conf = _note_conf(n)
        if n.confidence is not None and conf < cfg.min_confidence:
            filtered_short_or_low_conf += 1
            decisions.append(
                {
                    "stage": "confidence_filter",
                    "action": "drop",
                    "pitch_midi": n.pitch_midi,
                    "onset_sec": round(n.onset_sec, 4),
                    "confidence": round(conf, 4),
                }
            )
            continue
        if dur < cfg.min_duration_sec:
            keep_high_conf_short = conf >= cfg.high_conf_short_threshold and dur >= cfg.high_conf_short_min_duration_sec
            keep_transkun_strong_short = (
                n.confidence is None
                and dur >= 0.032
                and int(n.velocity) >= adaptive_vel_short_keep
            )
            keep_ornament = (
                (n.confidence is None or conf >= 0.45)
                and _is_stepwise_grace_or_ornament(n, ordered_raw, idx, dur)
            )
            if keep_high_conf_short or keep_transkun_strong_short or keep_ornament:
                if keep_ornament or keep_transkun_strong_short:
                    short_ornaments_preserved += 1
            else:
                filtered_short_or_low_conf += 1
                decisions.append(
                    {
                        "stage": "min_duration_filter",
                        "action": "drop",
                        "pitch_midi": n.pitch_midi,
                        "onset_sec": round(n.onset_sec, 4),
                        "duration_sec": round(dur, 4),
                        "confidence": round(conf, 4),
                    }
                )
                continue
        stage_a.append(
            DetectedNote(
                pitch_midi=n.pitch_midi,
                onset_sec=float(n.onset_sec),
                offset_sec=min(float(n.offset_sec), float(n.onset_sec) + cfg.max_note_duration_sec),
                velocity=int(n.velocity),
                confidence=n.confidence,
            )
        )

    # Stage B: Same-pitch re-attack debouncing + sustained bass dropout stitching
    by_pitch: dict[int, list[DetectedNote]] = defaultdict(list)
    for n in stage_a:
        by_pitch[n.pitch_midi].append(n)

    stage_b: list[DetectedNote] = []
    reattack_merges = 0
    reattack_retained = 0
    reattack_trimmed = 0
    bass_sustain_merges = 0
    for pitch_midi in sorted(by_pitch.keys()):
        p_notes = sorted(by_pitch[pitch_midi], key=lambda x: x.onset_sec)
        merged: list[DetectedNote] = []
        for curr in p_notes:
            if not merged:
                merged.append(curr)
                continue
            prev = merged[-1]
            gap = curr.onset_sec - prev.offset_sec

            # Stitch sustained bass notes fragmented by brief dropouts (0 < gap <= 120ms)
            # without merging strong intentional repeated bass pulses.
            if (
                pitch_midi < 55
                and 0.0 < gap <= 0.120
                and (curr.offset_sec - prev.onset_sec) <= cfg.max_note_duration_sec
                and (
                    curr.velocity <= int(prev.velocity * 0.85)
                    or (curr.offset_sec - curr.onset_sec) < 0.18
                )
                and (curr.confidence is None or _note_conf(curr) <= _note_conf(prev) * 0.92)
            ):
                prev.offset_sec = max(prev.offset_sec, curr.offset_sec)
                prev.velocity = max(prev.velocity, curr.velocity)
                if prev.confidence is not None and curr.confidence is not None:
                    prev.confidence = max(prev.confidence, curr.confidence)
                bass_sustain_merges += 1
                decisions.append(
                    {
                        "stage": "bass_sustain_stitch",
                        "action": "merge",
                        "pitch_midi": pitch_midi,
                        "prev_onset_sec": round(prev.onset_sec, 4),
                        "merged_onset_sec": round(curr.onset_sec, 4),
                        "gap_sec": round(gap, 4),
                    }
                )
                continue

            if gap > cfg.reattack_gap_sec:
                merged.append(curr)
                continue

            onset_diff = curr.onset_sec - prev.onset_sec
            curr_dur = max(0.0, curr.offset_sec - curr.onset_sec)
            prev_conf = _note_conf(prev)
            curr_conf = _note_conf(curr)

            is_weak_decay_tail = (
                curr_conf < prev_conf * cfg.reattack_tail_min_conf_ratio
                and curr_dur <= cfg.reattack_tail_max_duration_sec
            ) or (
                curr.confidence is None
                and curr.velocity <= int(prev.velocity * 0.72)
                and curr_dur <= cfg.reattack_tail_max_duration_sec
            )
            has_distinct_onset_separation = (
                onset_diff >= cfg.min_distinct_reattack_onset_sec
                and curr_dur >= cfg.min_duration_sec
                and not is_weak_decay_tail
            )
            has_strong_rapid_reattack = (
                gap > 0.035
                and (
                    curr_conf >= prev_conf * cfg.reattack_genuine_conf_boost
                    or curr.velocity >= prev.velocity + cfg.reattack_genuine_vel_boost
                )
            )

            if has_distinct_onset_separation or has_strong_rapid_reattack:
                trimmed = False
                if prev.offset_sec > curr.onset_sec:
                    new_offset = max(
                        prev.onset_sec + cfg.min_trimmed_duration_sec,
                        curr.onset_sec - cfg.reattack_trim_margin_sec,
                    )
                    if new_offset < prev.offset_sec:
                        prev.offset_sec = new_offset
                        trimmed = True
                        reattack_trimmed += 1
                merged.append(curr)
                reattack_retained += 1
                decisions.append(
                    {
                        "stage": "reattack_debounce",
                        "action": "retain_and_trim_prev" if trimmed else "retain",
                        "pitch_midi": pitch_midi,
                        "prev_onset_sec": round(prev.onset_sec, 4),
                        "curr_onset_sec": round(curr.onset_sec, 4),
                        "onset_diff_sec": round(onset_diff, 4),
                        "gap_sec": round(gap, 4),
                    }
                )
            else:
                prev.offset_sec = max(prev.offset_sec, curr.offset_sec)
                prev.velocity = max(prev.velocity, curr.velocity)
                if prev.confidence is not None and curr.confidence is not None:
                    prev.confidence = max(prev.confidence, curr.confidence)
                reattack_merges += 1
                decisions.append(
                    {
                        "stage": "reattack_debounce",
                        "action": "merge",
                        "pitch_midi": pitch_midi,
                        "prev_onset_sec": round(prev.onset_sec, 4),
                        "merged_onset_sec": round(curr.onset_sec, 4),
                        "onset_diff_sec": round(onset_diff, 4),
                        "gap_sec": round(gap, 4),
                    }
                )
        stage_b.extend(merged)

    stage_b.sort(key=lambda x: (x.onset_sec, x.pitch_midi))

    # Stage C: Conservative harmonic overtone suppression (octaves 12/24 and fifths 19)
    # Supports BOTH confidence-bearing models (Basic Pitch) AND velocity-only models (Transkun V2).
    dropped_indices: set[int] = set()
    octave_ghosts_suppressed = 0
    fifth_harmonics_suppressed = 0
    allowed_intervals = {12, 24} if cfg.enable_octave_ghost_suppression else set()
    if cfg.enable_fifth_harmonic_suppression:
        allowed_intervals.add(19)

    if allowed_intervals and len(stage_b) > 1:
        for i in range(len(stage_b)):
            if i in dropped_indices:
                continue
            a = stage_b[i]
            for j in range(i + 1, len(stage_b)):
                if j in dropped_indices:
                    continue
                b = stage_b[j]
                if b.onset_sec - a.onset_sec > cfg.octave_onset_window_sec:
                    break
                semitone_diff = abs(b.pitch_midi - a.pitch_midi)
                if semitone_diff not in allowed_intervals:
                    continue
                if semitone_diff == 19 and abs(b.onset_sec - a.onset_sec) > min(cfg.octave_onset_window_sec, 0.028):
                    continue
                overlap = min(a.offset_sec, b.offset_sec) - max(a.onset_sec, b.onset_sec)
                if overlap <= 0.02:
                    continue

                low_idx, high_idx = (i, j) if a.pitch_midi < b.pitch_midi else (j, i)
                low = stage_b[low_idx]
                high = stage_b[high_idx]
                low_dur = max(0.01, low.offset_sec - low.onset_sec)
                high_dur = max(0.01, high.offset_sec - high.onset_sec)

                has_melodic_support = _has_melodic_neighbor(
                    high, low, stage_b, window_sec=cfg.octave_melodic_window_sec
                )
                if has_melodic_support:
                    continue
                if semitone_diff in (12, 24) and _has_parallel_octave_continuity(high, low, stage_b):
                    continue
                if semitone_diff == 19 and _has_upper_triad_context(high, low, stage_b):
                    continue

                both_have_conf = low.confidence is not None and high.confidence is not None
                if both_have_conf:
                    low_conf = float(low.confidence)  # type: ignore[arg-type]
                    high_conf = float(high.confidence)  # type: ignore[arg-type]
                    base_ratio = cfg.fifth_confidence_ratio if semitone_diff == 19 else cfg.octave_confidence_ratio
                    envelope_contained = (
                        high.offset_sec <= low.offset_sec + 0.06
                        and high_dur <= low_dur * cfg.harmonic_max_duration_ratio
                    )
                    substantially_weaker = (
                        low_conf >= cfg.octave_strong_fundamental_min_conf
                        and high_conf <= low_conf * base_ratio
                        and high_conf <= cfg.harmonic_max_candidate_confidence
                        and high.velocity <= int(low.velocity * cfg.harmonic_velocity_ratio)
                    )
                else:
                    # Velocity + envelope containment heuristic for velocity-only models (e.g. Transkun V2)
                    low_conf = low.velocity / 127.0
                    high_conf = high.velocity / 127.0
                    vel_diff = int(low.velocity) - int(high.velocity)
                    if semitone_diff == 19:
                        envelope_contained = (
                            high.offset_sec <= low.offset_sec + 0.06
                            and high_dur <= low_dur * 0.85
                        )
                        substantially_weaker = (
                            low.velocity >= 65
                            and vel_diff >= 22
                            and high.velocity < 72
                        )
                    else:
                        envelope_contained = (
                            high.offset_sec <= low.offset_sec + 0.08
                            and high_dur <= low_dur * 0.92
                        )
                        substantially_weaker = (
                            low.velocity >= 60
                            and vel_diff >= 16
                            and high.velocity < 78
                        )

                if substantially_weaker and envelope_contained:
                    dropped_indices.add(high_idx)
                    if semitone_diff == 19:
                        fifth_harmonics_suppressed += 1
                        action = "drop_fifth_harmonic"
                    else:
                        octave_ghosts_suppressed += 1
                        action = "drop_upper_harmonic"
                    decisions.append(
                        {
                            "stage": "harmonic_overtone_suppression",
                            "action": action,
                            "reason": (
                                f"semitone_diff={semitone_diff}, low_conf={low_conf:.3f}, "
                                f"high_conf={high_conf:.3f}, vel_ratio={high.velocity}/{low.velocity}, "
                                f"dur_ratio={high_dur:.3f}/{low_dur:.3f}, conf_mode={'model' if both_have_conf else 'velocity'}"
                            ),
                            "dropped_pitch_midi": high.pitch_midi,
                            "fundamental_pitch_midi": low.pitch_midi,
                            "semitone_diff": semitone_diff,
                            "onset_sec": round(high.onset_sec, 4),
                            "high_conf": round(high_conf, 4),
                            "low_conf": round(low_conf, 4),
                        }
                    )
                    continue

                # Sub-harmonic ghost check (octaves only): very weak lower octave with short duration
                if (
                    both_have_conf
                    and semitone_diff in (12, 24)
                    and low_conf < 0.36
                    and high_conf > low_conf * 1.65
                    and low_dur < high_dur * 0.55
                    and low.velocity <= int(high.velocity * cfg.harmonic_velocity_ratio)
                ):
                    dropped_indices.add(low_idx)
                    octave_ghosts_suppressed += 1
                    decisions.append(
                        {
                            "stage": "harmonic_overtone_suppression",
                            "action": "drop_subharmonic",
                            "reason": f"semitone_diff=-{semitone_diff}, low_conf={low_conf:.3f}, high_conf={high_conf:.3f}",
                            "dropped_pitch_midi": low.pitch_midi,
                            "anchor_pitch_midi": high.pitch_midi,
                            "semitone_diff": -semitone_diff,
                            "onset_sec": round(low.onset_sec, 4),
                            "low_conf": round(low_conf, 4),
                            "high_conf": round(high_conf, 4),
                        }
                    )

    refined = [n for idx, n in enumerate(stage_b) if idx not in dropped_indices]

    # Stage D: Dynamic velocity mapping (skip rescaling when model provides no confidence scores, e.g., Transkun)
    has_any_conf = any(n.confidence is not None for n in refined)
    if cfg.enable_velocity_rescaling and refined and has_any_conf:
        raw_scores = [
            0.65 * float(n.velocity) + 0.35 * (_note_conf(n) * 127.0)
            for n in refined
        ]
        s_min = min(raw_scores)
        s_max = max(raw_scores)
        span = s_max - s_min
        v_span = max(1, cfg.velocity_max - cfg.velocity_min)
        for n, score in zip(refined, raw_scores, strict=True):
            if span >= 8.0:
                norm = (score - s_min) / span
                n.velocity = int(round(cfg.velocity_min + norm * v_span))
            else:
                n.velocity = max(cfg.velocity_min, min(cfg.velocity_max, int(round(n.velocity))))

    stats = {
        "raw_count": len(raw_notes),
        "filtered_short_or_low_conf": filtered_short_or_low_conf,
        "short_ornaments_preserved": short_ornaments_preserved,
        "reattack_merges": reattack_merges,
        "reattack_retained": reattack_retained,
        "reattack_trimmed": reattack_trimmed,
        "bass_sustain_merges": bass_sustain_merges,
        "octave_ghosts_suppressed": octave_ghosts_suppressed,
        "fifth_harmonics_suppressed": fifth_harmonics_suppressed,
        "refined_count": len(refined),
    }
    return NoteRefinementResult(
        notes=refined,
        raw_notes=list(raw_notes),
        stats=stats,
        decisions=decisions,
    )
