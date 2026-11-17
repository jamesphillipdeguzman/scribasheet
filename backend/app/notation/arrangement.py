"""Non-destructive arrangement simplification and phrase-breathing post-processing.

Operates on refined ``DetectedNote`` events without mutating the original
transcription output, supporting ``simple``, ``balanced``, and ``detailed``
arrangement presets.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Literal

from app.transcription.base import DetectedNote

logger = logging.getLogger(__name__)

ArrangementDetail = Literal["simple", "balanced", "detailed"]
VALID_ARRANGEMENT_DETAILS: tuple[str, ...] = ("simple", "balanced", "detailed")


@dataclass
class ArrangementConfig:
    """Configurable beat-relative thresholds for arrangement simplification."""

    onset_cluster_sec: float = 0.045
    # Transient / background bleed filtering (duration in beats + low confidence/velocity)
    simple_transient_max_beats: float = 0.18
    balanced_transient_max_beats: float = 0.12
    transient_low_conf: float = 0.40
    transient_low_vel: int = 50
    # LH bass simplification
    simple_lh_max_cluster: int = 2
    balanced_lh_max_cluster: int = 3
    # RH melody / chord prioritization
    simple_rh_max_cluster: int = 2
    balanced_rh_max_cluster: int = 4
    # Phrase breathing (conservative legato gap filling in beats)
    simple_legato_max_gap_beats: float = 0.45
    simple_legato_min_note_beats: float = 0.28
    simple_phrase_pause_beats: float = 0.35
    balanced_legato_max_gap_beats: float = 0.22
    balanced_legato_min_note_beats: float = 0.30
    legato_min_gap_sec: float = 0.010
    legato_trim_margin_sec: float = 0.005


@dataclass
class ArrangementResult:
    notes: list[DetectedNote]
    raw_notes: list[DetectedNote]
    arrangement_detail: ArrangementDetail
    stats: dict[str, Any] = field(default_factory=dict)
    decisions: list[dict[str, Any]] = field(default_factory=list)


def normalize_arrangement_detail(value: str | None) -> ArrangementDetail:
    norm = (value or "balanced").strip().lower()
    if norm in ("simple", "balanced", "detailed"):
        return norm  # type: ignore[return-value]
    return "balanced"


def _clone_note(n: DetectedNote) -> DetectedNote:
    return DetectedNote(
        pitch_midi=int(n.pitch_midi),
        onset_sec=float(n.onset_sec),
        offset_sec=float(n.offset_sec),
        velocity=int(n.velocity),
        confidence=n.confidence,
    )


def _note_strength(n: DetectedNote, dur_beats: float) -> float:
    conf = float(n.confidence) if n.confidence is not None else 0.65
    vel = max(1, min(127, int(n.velocity))) / 127.0
    dur_score = min(1.5, max(0.2, dur_beats))
    return conf * 0.50 + vel * 0.30 + (dur_score / 1.5) * 0.20


def _cluster_by_onset(notes: list[DetectedNote], window_sec: float) -> list[list[DetectedNote]]:
    if not notes:
        return []
    ordered = sorted(notes, key=lambda n: (n.onset_sec, n.pitch_midi))
    clusters: list[list[DetectedNote]] = [[ordered[0]]]
    for n in ordered[1:]:
        if n.onset_sec - clusters[-1][0].onset_sec <= window_sec:
            clusters[-1].append(n)
        else:
            clusters.append([n])
    return clusters


def _is_suspicious_transient(
    n: DetectedNote,
    dur_beats: float,
    max_beats: float,
    cfg: ArrangementConfig,
) -> bool:
    if dur_beats >= max_beats:
        return False
    if n.confidence is not None:
        return float(n.confidence) < cfg.transient_low_conf and n.velocity <= cfg.transient_low_vel + 10
    return n.velocity < cfg.transient_low_vel


def _simplify_lh_clusters(
    lh_notes: list[DetectedNote],
    *,
    detail: ArrangementDetail,
    sec_per_beat: float,
    cfg: ArrangementConfig,
    decisions: list[dict[str, Any]],
) -> tuple[list[DetectedNote], int]:
    kept: list[DetectedNote] = []
    dropped = 0
    max_cluster = cfg.simple_lh_max_cluster if detail == "simple" else cfg.balanced_lh_max_cluster
    transient_beats = cfg.simple_transient_max_beats if detail == "simple" else cfg.balanced_transient_max_beats

    for cluster in _cluster_by_onset(lh_notes, cfg.onset_cluster_sec):
        # 1. Filter isolated suspicious percussive transients
        filtered: list[DetectedNote] = []
        for n in cluster:
            dur_beats = max(0.0, n.offset_sec - n.onset_sec) / sec_per_beat
            if len(cluster) == 1 and _is_suspicious_transient(n, dur_beats, transient_beats, cfg):
                dropped += 1
                decisions.append(
                    {
                        "stage": "lh_transient_filter",
                        "action": "drop",
                        "pitch_midi": n.pitch_midi,
                        "onset_sec": round(n.onset_sec, 4),
                        "dur_beats": round(dur_beats, 3),
                        "reason": "isolated_short_low_energy_lh",
                    }
                )
                continue
            filtered.append(n)

        if not filtered:
            continue

        # 2. Remove redundant octave doubling in LH when lower bass anchor is strong
        if len(filtered) > 1:
            by_pitch = sorted(filtered, key=lambda x: x.pitch_midi)
            dedup_oct: list[DetectedNote] = [by_pitch[0]]
            bass = by_pitch[0]
            bass_dur = (bass.offset_sec - bass.onset_sec) / sec_per_beat
            for cand in by_pitch[1:]:
                cand_dur = (cand.offset_sec - cand.onset_sec) / sec_per_beat
                is_octave = (cand.pitch_midi - bass.pitch_midi) in (12, 24)
                weak_double = (
                    (cand.confidence is not None and float(cand.confidence) < 0.55)
                    or cand.velocity <= bass.velocity - 10
                    or cand_dur < bass_dur * 0.65
                )
                if detail == "simple" and is_octave and weak_double:
                    dropped += 1
                    decisions.append(
                        {
                            "stage": "lh_octave_simplification",
                            "action": "drop",
                            "pitch_midi": cand.pitch_midi,
                            "anchor_pitch": bass.pitch_midi,
                            "onset_sec": round(cand.onset_sec, 4),
                            "reason": "redundant_lh_octave_doubling",
                        }
                    )
                    continue
                dedup_oct.append(cand)
            filtered = dedup_oct

        # 3. Cap excessive simultaneous LH cluster while always keeping lowest bass anchor
        if len(filtered) > max_cluster:
            by_pitch = sorted(filtered, key=lambda x: x.pitch_midi)
            bass_anchor = by_pitch[0]
            others = sorted(
                by_pitch[1:],
                key=lambda x: _note_strength(x, (x.offset_sec - x.onset_sec) / sec_per_beat),
                reverse=True,
            )
            chosen = [bass_anchor, *others[: max_cluster - 1]]
            chosen_ids = {id(x) for x in chosen}
            for n in filtered:
                if id(n) not in chosen_ids:
                    dropped += 1
                    decisions.append(
                        {
                            "stage": "lh_density_reduction",
                            "action": "drop",
                            "pitch_midi": n.pitch_midi,
                            "onset_sec": round(n.onset_sec, 4),
                            "reason": f"excessive_lh_cluster_{detail}",
                        }
                    )
            kept.extend(chosen)
        else:
            kept.extend(filtered)

    return kept, dropped


def _simplify_rh_clusters(
    rh_notes: list[DetectedNote],
    *,
    detail: ArrangementDetail,
    sec_per_beat: float,
    cfg: ArrangementConfig,
    decisions: list[dict[str, Any]],
) -> tuple[list[DetectedNote], int]:
    kept: list[DetectedNote] = []
    dropped = 0
    max_cluster = cfg.simple_rh_max_cluster if detail == "simple" else cfg.balanced_rh_max_cluster
    transient_beats = cfg.simple_transient_max_beats if detail == "simple" else cfg.balanced_transient_max_beats

    for cluster in _cluster_by_onset(rh_notes, cfg.onset_cluster_sec):
        filtered: list[DetectedNote] = []
        for n in cluster:
            dur_beats = max(0.0, n.offset_sec - n.onset_sec) / sec_per_beat
            if len(cluster) > 1 and _is_suspicious_transient(n, dur_beats, transient_beats, cfg):
                dropped += 1
                decisions.append(
                    {
                        "stage": "rh_transient_filter",
                        "action": "drop",
                        "pitch_midi": n.pitch_midi,
                        "onset_sec": round(n.onset_sec, 4),
                        "dur_beats": round(dur_beats, 3),
                        "reason": "weak_competing_rh_transient",
                    }
                )
                continue
            filtered.append(n)

        if not filtered:
            filtered = [
                max(
                    cluster,
                    key=lambda x: _note_strength(x, (x.offset_sec - x.onset_sec) / sec_per_beat),
                )
            ]

        if len(filtered) > max_cluster:
            # Always preserve the highest melodic lead note, then strongest harmonic dyad/chord tones
            by_pitch_desc = sorted(filtered, key=lambda x: -x.pitch_midi)
            melody_lead = by_pitch_desc[0]
            remaining = sorted(
                by_pitch_desc[1:],
                key=lambda x: _note_strength(x, (x.offset_sec - x.onset_sec) / sec_per_beat),
                reverse=True,
            )
            chosen = [melody_lead]
            for cand in remaining:
                if len(chosen) >= max_cluster:
                    break
                cand_dur_beats = (cand.offset_sec - cand.onset_sec) / sec_per_beat
                if detail == "simple" and cand_dur_beats < 0.35 and (
                    cand.confidence is None or float(cand.confidence) < 0.65
                ):
                    continue
                chosen.append(cand)

            chosen_ids = {id(x) for x in chosen}
            for n in filtered:
                if id(n) not in chosen_ids:
                    dropped += 1
                    decisions.append(
                        {
                            "stage": "rh_melody_prioritization",
                            "action": "drop",
                            "pitch_midi": n.pitch_midi,
                            "onset_sec": round(n.onset_sec, 4),
                            "reason": f"rh_density_reduction_{detail}",
                        }
                    )
            kept.extend(chosen)
        else:
            kept.extend(filtered)

    return kept, dropped


def _apply_phrase_breathing(
    rh_notes: list[DetectedNote],
    *,
    detail: ArrangementDetail,
    sec_per_beat: float,
    cfg: ArrangementConfig,
    decisions: list[dict[str, Any]],
) -> int:
    """Conservatively fill transcription-fragment gaps in the top melodic line."""
    if detail == "detailed" or len(rh_notes) < 2:
        return 0

    max_gap_beats = (
        cfg.simple_legato_max_gap_beats if detail == "simple" else cfg.balanced_legato_max_gap_beats
    )
    min_note_beats = (
        cfg.simple_legato_min_note_beats if detail == "simple" else cfg.balanced_legato_min_note_beats
    )

    # Identify top melodic voice per onset cluster
    clusters = _cluster_by_onset(rh_notes, cfg.onset_cluster_sec)
    melody_line = [max(c, key=lambda n: n.pitch_midi) for c in clusters]
    gaps_filled = 0

    for idx in range(len(melody_line) - 1):
        curr = melody_line[idx]
        nxt = melody_line[idx + 1]
        # Preserve repeated-note rearticulations
        if curr.pitch_midi == nxt.pitch_midi:
            continue
        # Only bridge within a plausible single-phrase melodic interval (<= 1 octave)
        if abs(nxt.pitch_midi - curr.pitch_midi) > 12:
            continue

        gap_sec = nxt.onset_sec - curr.offset_sec
        if gap_sec <= cfg.legato_min_gap_sec:
            continue

        dur_beats = (curr.offset_sec - curr.onset_sec) / sec_per_beat
        gap_beats = gap_sec / sec_per_beat

        # Preserve genuine staccato articulation (very short note followed by intentional rest)
        if dur_beats < min_note_beats:
            continue
        # Preserve phrase-boundary breath pauses after long sustained notes
        if detail == "simple" and dur_beats >= 1.5 and gap_beats >= cfg.simple_phrase_pause_beats:
            continue
        if gap_beats > max_gap_beats:
            continue

        new_offset = max(curr.offset_sec, nxt.onset_sec - cfg.legato_trim_margin_sec)
        if new_offset > curr.offset_sec + 0.002:
            old_offset = curr.offset_sec
            curr.offset_sec = round(new_offset, 4)
            gaps_filled += 1
            decisions.append(
                {
                    "stage": "phrase_breathing",
                    "action": "fill_legato_gap",
                    "pitch_midi": curr.pitch_midi,
                    "old_offset_sec": round(old_offset, 4),
                    "new_offset_sec": curr.offset_sec,
                    "gap_beats": round(gap_beats, 3),
                }
            )

    return gaps_filled


def simplify_arrangement(
    refined_notes: list[DetectedNote],
    *,
    tempo_bpm: float = 120.0,
    arrangement_detail: str = "balanced",
    config: ArrangementConfig | None = None,
) -> ArrangementResult:
    """Produce a non-destructive arrangement from refined transcription notes."""
    detail = normalize_arrangement_detail(arrangement_detail)
    cfg = config or ArrangementConfig()
    raw_copy = [_clone_note(n) for n in refined_notes]
    working = [_clone_note(n) for n in refined_notes]

    if not working or detail == "detailed":
        return ArrangementResult(
            notes=sorted(working, key=lambda n: (n.onset_sec, n.pitch_midi)),
            raw_notes=raw_copy,
            arrangement_detail=detail,
            stats={
                "arrangement_detail": detail,
                "input_count": len(raw_copy),
                "output_count": len(working),
                "lh_dropped": 0,
                "rh_dropped": 0,
                "phrase_gaps_filled": 0,
            },
            decisions=[],
        )

    sec_per_beat = 60.0 / max(20.0, float(tempo_bpm))
    decisions: list[dict[str, Any]] = []

    lh_notes = [n for n in working if n.pitch_midi < 60]
    rh_notes = [n for n in working if n.pitch_midi >= 60]

    kept_lh, lh_dropped = _simplify_lh_clusters(
        lh_notes,
        detail=detail,
        sec_per_beat=sec_per_beat,
        cfg=cfg,
        decisions=decisions,
    )
    kept_rh, rh_dropped = _simplify_rh_clusters(
        rh_notes,
        detail=detail,
        sec_per_beat=sec_per_beat,
        cfg=cfg,
        decisions=decisions,
    )
    gaps_filled = _apply_phrase_breathing(
        kept_rh,
        detail=detail,
        sec_per_beat=sec_per_beat,
        cfg=cfg,
        decisions=decisions,
    )

    combined = sorted([*kept_lh, *kept_rh], key=lambda n: (n.onset_sec, n.pitch_midi))
    stats = {
        "arrangement_detail": detail,
        "input_count": len(raw_copy),
        "output_count": len(combined),
        "lh_dropped": lh_dropped,
        "rh_dropped": rh_dropped,
        "phrase_gaps_filled": gaps_filled,
    }
    logger.debug("Arrangement simplification (%s): %s", detail, stats)
    return ArrangementResult(
        notes=combined,
        raw_notes=raw_copy,
        arrangement_detail=detail,
        stats=stats,
        decisions=decisions,
    )
