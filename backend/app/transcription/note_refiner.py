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
    octave_onset_window_sec: float = 0.035
    octave_confidence_ratio: float = 0.72
    octave_strong_fundamental_min_conf: float = 0.48
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
            # Require a true stepwise/small-leap neighbor with reasonable confidence
            # that is not merely a harmonic of the fundamental.
            if 1 <= diff <= max_semitone_step and _note_conf(other) >= 0.45:
                if abs(other.pitch_midi - fundamental.pitch_midi) not in (12, 24):
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
                "reattack_merges": 0,
                "octave_ghosts_suppressed": 0,
                "refined_count": 0,
            },
            decisions=[],
        )

    # Stage A: Minimum duration & confidence filtering
    stage_a: list[DetectedNote] = []
    filtered_short_or_low_conf = 0
    for n in sorted(raw_notes, key=lambda x: (x.onset_sec, x.pitch_midi)):
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
            if not (conf >= cfg.high_conf_short_threshold and dur >= cfg.high_conf_short_min_duration_sec):
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

    # Stage B: Same-pitch re-attack debouncing
    by_pitch: dict[int, list[DetectedNote]] = defaultdict(list)
    for n in stage_a:
        by_pitch[n.pitch_midi].append(n)

    stage_b: list[DetectedNote] = []
    reattack_merges = 0
    reattack_retained = 0
    reattack_trimmed = 0
    for pitch_midi in sorted(by_pitch.keys()):
        p_notes = sorted(by_pitch[pitch_midi], key=lambda x: x.onset_sec)
        merged: list[DetectedNote] = []
        for curr in p_notes:
            if not merged:
                merged.append(curr)
                continue
            prev = merged[-1]
            gap = curr.onset_sec - prev.offset_sec
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

    # Stage C: Harmonic / octave ghost suppression
    dropped_indices: set[int] = set()
    octave_ghosts_suppressed = 0
    if cfg.enable_octave_ghost_suppression and len(stage_b) > 1:
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
                if semitone_diff not in (12, 24):
                    continue
                overlap = min(a.offset_sec, b.offset_sec) - max(a.onset_sec, b.onset_sec)
                if overlap <= 0.02:
                    continue

                low_idx, high_idx = (i, j) if a.pitch_midi < b.pitch_midi else (j, i)
                low = stage_b[low_idx]
                high = stage_b[high_idx]
                low_conf = _note_conf(low)
                high_conf = _note_conf(high)
                low_dur = max(0.01, low.offset_sec - low.onset_sec)
                high_dur = max(0.01, high.offset_sec - high.onset_sec)

                # Upper harmonic ghost check: fundamental is noticeably stronger than upper octave
                has_melodic_support = _has_melodic_neighbor(
                    high, low, stage_b, window_sec=cfg.octave_melodic_window_sec
                )
                ratio_limit = (
                    cfg.octave_confidence_ratio * 0.83
                    if has_melodic_support
                    else cfg.octave_confidence_ratio
                )
                strong_ratio_drop = (
                    low_conf >= cfg.octave_strong_fundamental_min_conf
                    and high_conf <= low_conf * ratio_limit
                )
                weak_short_overtone = (
                    not has_melodic_support
                    and high_conf < 0.42
                    and high_dur <= low_dur * 0.65
                    and high.velocity <= low.velocity
                )
                if strong_ratio_drop or weak_short_overtone:
                    dropped_indices.add(high_idx)
                    octave_ghosts_suppressed += 1
                    decisions.append(
                        {
                            "stage": "octave_ghost_suppression",
                            "action": "drop_upper_harmonic",
                            "dropped_pitch_midi": high.pitch_midi,
                            "fundamental_pitch_midi": low.pitch_midi,
                            "onset_sec": round(high.onset_sec, 4),
                            "high_conf": round(high_conf, 4),
                            "low_conf": round(low_conf, 4),
                        }
                    )
                    logger.debug(
                        "Suppressed octave ghost MIDI %s (conf=%.3f) above fundamental %s (conf=%.3f) at %.3fs",
                        high.pitch_midi,
                        high_conf,
                        low.pitch_midi,
                        low_conf,
                        high.onset_sec,
                    )
                    continue

                # Sub-harmonic ghost check: very weak lower octave with short duration
                if low_conf < 0.38 and high_conf > low_conf * 1.5 and low_dur < high_dur * 0.6:
                    dropped_indices.add(low_idx)
                    octave_ghosts_suppressed += 1
                    decisions.append(
                        {
                            "stage": "octave_ghost_suppression",
                            "action": "drop_subharmonic",
                            "dropped_pitch_midi": low.pitch_midi,
                            "anchor_pitch_midi": high.pitch_midi,
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
        "reattack_merges": reattack_merges,
        "reattack_retained": reattack_retained,
        "reattack_trimmed": reattack_trimmed,
        "octave_ghosts_suppressed": octave_ghosts_suppressed,
        "refined_count": len(refined),
    }
    return NoteRefinementResult(
        notes=refined,
        raw_notes=list(raw_notes),
        stats=stats,
        decisions=decisions,
    )
