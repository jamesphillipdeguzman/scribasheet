"""Beat-synchronized TimingMap for piecewise linear seconds <-> quarterLength mapping."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import numpy as np

from app.notation.beat_tracker import BeatTrackingResult
from app.transcription.base import DetectedNote


@dataclass
class TimingMap:
    beat_times_sec: list[float]
    downbeat_times_sec: list[float]
    beat_quarter_lengths: list[float]
    tempo_bpm: float
    time_signature: str
    beats_per_measure: int
    first_downbeat_sec: float
    pickup_ql: float
    leading_silence_sec: float
    provider: str
    fallback_used: bool
    fallback_reason: str | None = None
    confidence: float = 0.0
    provenance: dict[str, Any] = field(default_factory=dict)

    @property
    def sec_per_beat(self) -> float:
        return 60.0 / max(20.0, self.tempo_bpm)

    def seconds_to_ql(self, t_sec: float) -> float:
        if not self.beat_times_sec or len(self.beat_times_sec) < 2:
            return (t_sec - self.first_downbeat_sec) / self.sec_per_beat + self.pickup_ql

        t0 = self.beat_times_sec[0]
        t_end = self.beat_times_sec[-1]
        q0 = self.beat_quarter_lengths[0]
        q_end = self.beat_quarter_lengths[-1]

        if t_sec < t0:
            edge_spb = max(0.20, self.beat_times_sec[1] - self.beat_times_sec[0])
            return q0 + (t_sec - t0) / edge_spb
        if t_sec > t_end:
            edge_spb = max(0.20, self.beat_times_sec[-1] - self.beat_times_sec[-2])
            return q_end + (t_sec - t_end) / edge_spb
        return float(np.interp(t_sec, self.beat_times_sec, self.beat_quarter_lengths))

    def ql_to_seconds(self, ql: float) -> float:
        if not self.beat_times_sec or len(self.beat_times_sec) < 2:
            return self.first_downbeat_sec + (ql - self.pickup_ql) * self.sec_per_beat

        q0 = self.beat_quarter_lengths[0]
        q_end = self.beat_quarter_lengths[-1]
        if ql < q0:
            edge_spb = max(0.20, self.beat_times_sec[1] - self.beat_times_sec[0])
            return self.beat_times_sec[0] + (ql - q0) * edge_spb
        if ql > q_end:
            edge_spb = max(0.20, self.beat_times_sec[-1] - self.beat_times_sec[-2])
            return self.beat_times_sec[-1] + (ql - q_end) * edge_spb
        return float(np.interp(ql, self.beat_quarter_lengths, self.beat_times_sec))


def _regularize_downbeats(
    downbeats: list[float],
    beats: list[float],
    expected_bar_sec: float,
    total_duration_sec: float,
) -> list[float]:
    """Fill missing bars and repair 2x gaps in detected downbeat anchors."""
    anchors = sorted(float(d) for d in downbeats if np.isfinite(d) and d >= 0.0)
    if not anchors and beats:
        anchors = [beats[0]]
    if not anchors:
        anchors = [0.0]

    # Fill interior gaps that are >= 1.65x expected_bar_sec
    filled: list[float] = [anchors[0]]
    for nxt in anchors[1:]:
        prev = filled[-1]
        gap = nxt - prev
        if gap < 0.45 * expected_bar_sec:
            continue
        if gap >= 1.65 * expected_bar_sec:
            n_bars = max(2, int(round(gap / expected_bar_sec)))
            step = gap / n_bars
            for k in range(1, n_bars):
                filled.append(prev + k * step)
        filled.append(nxt)

    # Extrapolate tail up to total_duration_sec + expected_bar_sec
    if len(filled) >= 2:
        tail_bar = max(0.6 * expected_bar_sec, min(1.5 * expected_bar_sec, filled[-1] - filled[-2]))
    else:
        tail_bar = expected_bar_sec
    while filled[-1] + tail_bar <= total_duration_sec + 0.5 * tail_bar:
        filled.append(filled[-1] + tail_bar)

    return filled


def build_timing_map(
    *,
    beat_result: BeatTrackingResult,
    notes: list[DetectedNote],
    duration_seconds: float,
    time_signature: str = "4/4",
) -> TimingMap:
    """Construct a beat-synchronized TimingMap anchored on detected downbeats and beats."""
    try:
        beats_per_measure = max(1, int(time_signature.split("/")[0]))
    except Exception:
        beats_per_measure = 4

    tempo_bpm = max(30.0, float(beat_result.selected_bpm))
    sec_per_beat = 60.0 / tempo_bpm
    expected_bar_sec = sec_per_beat * beats_per_measure

    reg_downbeats = _regularize_downbeats(
        beat_result.downbeat_times_sec,
        beat_result.beat_times_sec,
        expected_bar_sec,
        max(duration_seconds, max((n.offset_sec for n in notes), default=1.0)),
    )
    first_db = reg_downbeats[0]

    # Build exact beats_per_measure beat anchors per bar so barlines never drift over 80+ measures
    beat_times: list[float] = []
    beat_qls: list[float] = []

    # Check for genuine pickup notes before first_downbeat_sec
    pre_notes = [n for n in notes if n.onset_sec < first_db - 0.16]
    pickup_ql = 0.0
    if pre_notes:
        earliest_pre = min(n.onset_sec for n in pre_notes)
        pre_span_beats = (first_db - earliest_pre) / sec_per_beat
        if pre_span_beats >= 0.4:
            # Size the incomplete pickup bar to the actual pickup span (snapped to 0.5 ql)
            # instead of reserving a full measure, so first_db lands on Measure 1 beat 1.
            snapped_pickup = round(pre_span_beats * 2.0) / 2.0
            pickup_ql = float(min(float(beats_per_measure), max(0.5, snapped_pickup)))
            pickup_start_sec = first_db - pickup_ql * sec_per_beat
            beat_times.append(pickup_start_sec)
            beat_qls.append(0.0)
            b_ql = 1.0
            while b_ql < pickup_ql - 1e-6:
                beat_times.append(first_db - (pickup_ql - b_ql) * sec_per_beat)
                beat_qls.append(float(b_ql))
                b_ql += 1.0

    raw_beats = np.array(beat_result.beat_times_sec, dtype=np.float64)
    for bar_idx in range(len(reg_downbeats) - 1):
        bar_start = reg_downbeats[bar_idx]
        bar_end = reg_downbeats[bar_idx + 1]
        bar_dur = max(0.4 * expected_bar_sec, bar_end - bar_start)
        bar_ql_base = pickup_ql + bar_idx * beats_per_measure
        for b in range(beats_per_measure):
            interp_t = bar_start + (b / float(beats_per_measure)) * bar_dur
            # Snap beat anchor to nearby Beat This! beat only if within 80ms and monotonic
            if b > 0 and len(raw_beats) > 0:
                nearest_idx = int(np.argmin(np.abs(raw_beats - interp_t)))
                cand_t = float(raw_beats[nearest_idx])
                if abs(cand_t - interp_t) <= 0.08 and (not beat_times or cand_t > beat_times[-1] + 0.15):
                    interp_t = cand_t
            if not beat_times or interp_t > beat_times[-1] + 0.05:
                beat_times.append(interp_t)
                beat_qls.append(bar_ql_base + float(b))

    leading_silence = max(0.0, min(n.onset_sec for n in notes)) if notes else first_db

    return TimingMap(
        beat_times_sec=beat_times,
        downbeat_times_sec=reg_downbeats,
        beat_quarter_lengths=beat_qls,
        tempo_bpm=tempo_bpm,
        time_signature=time_signature,
        beats_per_measure=beats_per_measure,
        first_downbeat_sec=round(first_db, 4),
        pickup_ql=pickup_ql,
        leading_silence_sec=round(leading_silence, 4),
        provider=beat_result.actual_provider,
        fallback_used=beat_result.fallback_used,
        fallback_reason=beat_result.fallback_reason,
        confidence=beat_result.downbeat_confidence,
        provenance={
            "requested_provider": beat_result.requested_provider,
            "actual_provider": beat_result.actual_provider,
            "fallback_used": beat_result.fallback_used,
            "fallback_reason": beat_result.fallback_reason,
            "model_version": beat_result.model_version,
            "package_version": beat_result.package_version,
            "raw_bpm": beat_result.raw_bpm,
            "selected_bpm": beat_result.selected_bpm,
            "selected_ratio": beat_result.selected_ratio,
            "candidates": beat_result.candidates,
            "downbeat_confidence": beat_result.downbeat_confidence,
            "resolution_reason": beat_result.resolution_reason,
            "ambiguous": beat_result.ambiguous,
            "inference_seconds": beat_result.inference_seconds,
            "regularized_beat_count": len(beat_times),
            "regularized_downbeat_count": len(reg_downbeats),
            "pickup_ql": round(pickup_ql, 3),
            **beat_result.diagnostics,
        },
    )
