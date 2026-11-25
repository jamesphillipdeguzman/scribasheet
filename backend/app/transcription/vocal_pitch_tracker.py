"""Monophonic F0 vocal pitch tracker using probabilistic YIN (pYIN).

Converts isolated singing vocals into continuous, phrasing-accurate
``DetectedNote`` events while preserving vibrato, legato transitions, rapid
16th-note syllabic passages, grace notes, rests, and true vocal register.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import librosa
import numpy as np
from scipy.signal import medfilt

from app.transcription.base import DetectedNote

logger = logging.getLogger(__name__)


@dataclass
class VocalPitchTrackerConfig:
    sample_rate: int = 22050
    hop_length: int = 256  # ~11.6 ms frames for crisp 16th-note resolution
    frame_length: int = 2048
    min_midi: int = 43  # G2 (~98 Hz)
    max_midi: int = 88  # E6 (~1318 Hz)
    voiced_prob_threshold: float = 0.28
    min_rms_db: float = -54.0
    relative_rms_floor_db: float = 36.0
    min_note_duration_sec: float = 0.045
    micro_gap_bridge_sec: float = 0.045
    min_syllable_gap_sec: float = 0.085
    concert_pitch_hz: float = 440.0
    transpose_semitones: int = 0


@dataclass
class VocalPitchResult:
    notes: list[DetectedNote]
    stats: dict[str, Any] = field(default_factory=dict)
    duration_seconds: float = 0.0


def _suppress_octave_spikes(
    midi_frames: np.ndarray,
    active_mask: np.ndarray,
) -> tuple[np.ndarray, int]:
    """Fold isolated short octave-error spikes (<= 6 frames) back to local melodic register."""
    out = midi_frames.copy()
    n = len(out)
    suppressed = 0

    i = 0
    while i < n:
        if not active_mask[i]:
            i += 1
            continue
        # Walk contiguous active region
        region_start = i
        while i < n and active_mask[i]:
            i += 1
        region_end = i
        if region_end - region_start < 6:
            continue

        # Slide over internal short runs (1..6 frames) jumping by ~±12 semitones
        j = region_start + 2
        while j < region_end - 2:
            anchor = float(np.median(out[max(region_start, j - 4) : j]))
            diff = out[j] - anchor
            if 10.5 <= abs(diff) <= 13.8:
                shift = -12.0 if diff > 0 else 12.0
                k = j
                while k < region_end and k < j + 7 and abs((out[k] + shift) - anchor) <= 3.5:
                    k += 1
                run_len = k - j
                # Only fold short spikes (<= 6 frames, ~70ms) when following context returns to anchor
                if 1 <= run_len <= 6 and k < region_end:
                    after_end = min(region_end, k + 4)
                    after_med = float(np.median(out[k:after_end]))
                    if abs(after_med - anchor) <= 3.5:
                        out[j:k] += shift
                        suppressed += 1
                        j = k
                        continue
            j += 1

    return out, suppressed


def _vibrato_safe_smooth(midi_frames: np.ndarray, active_mask: np.ndarray) -> np.ndarray:
    """Apply narrow median smoothing inside gentle vibrato passages while preserving fast melodic steps."""
    out = midi_frames.copy()
    n = len(out)
    i = 0
    while i < n:
        if not active_mask[i]:
            i += 1
            continue
        start = i
        while i < n and active_mask[i]:
            i += 1
        seg = out[start:i]
        if len(seg) < 5:
            continue
        smoothed = medfilt(seg, kernel_size=5)
        for idx in range(start, i):
            w0 = max(start, idx - 2)
            w1 = min(i, idx + 3)
            span = float(np.max(out[w0:w1]) - np.min(out[w0:w1]))
            # Apply median smoothing when local excursion resembles vibrato/jitter (<= 2.2 st)
            if span <= 2.2:
                out[idx] = smoothed[idx - start]
    return out


def transcribe_vocal_melody_f0(
    wav_path: Path,
    config: VocalPitchTrackerConfig | None = None,
) -> VocalPitchResult:
    """Extract monophonic vocal melody notes from an isolated singing-voice audio file."""
    cfg = config or VocalPitchTrackerConfig()
    y, sr = librosa.load(str(wav_path), sr=cfg.sample_rate, mono=True)
    duration_sec = float(len(y)) / float(max(1, sr))
    if y.size == 0 or float(np.max(np.abs(y))) < 1e-6:
        return VocalPitchResult(
            notes=[],
            stats={"engine": "vocal_pyin", "voiced_frames": 0, "note_count": 0},
            duration_seconds=duration_sec,
        )

    fmin_midi = max(28, int(cfg.min_midi))
    fmax_midi = min(96, max(fmin_midi + 12, int(cfg.max_midi)))
    fmin_hz = float(cfg.concert_pitch_hz * (2.0 ** ((fmin_midi - 69) / 12.0)))
    fmax_hz = float(cfg.concert_pitch_hz * (2.0 ** ((fmax_midi - 69) / 12.0)))

    f0_hz, voiced_flag, voiced_prob = librosa.pyin(
        y,
        fmin=fmin_hz,
        fmax=fmax_hz,
        sr=sr,
        frame_length=cfg.frame_length,
        hop_length=cfg.hop_length,
        fill_na=np.nan,
    )
    rms = librosa.feature.rms(y=y, frame_length=cfg.frame_length, hop_length=cfg.hop_length)[0]
    onset_env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=cfg.hop_length)

    n_frames = min(len(f0_hz), len(voiced_flag), len(voiced_prob), len(rms), len(onset_env))
    if n_frames == 0:
        return VocalPitchResult(
            notes=[],
            stats={"engine": "vocal_pyin", "voiced_frames": 0, "note_count": 0},
            duration_seconds=duration_sec,
        )

    f0_hz = f0_hz[:n_frames]
    voiced_flag = voiced_flag[:n_frames]
    voiced_prob = voiced_prob[:n_frames]
    rms = rms[:n_frames]
    onset_env = onset_env[:n_frames]

    rms_db = 20.0 * np.log10(np.maximum(rms, 1e-8))
    peak_db = float(np.percentile(rms_db, 98))
    adaptive_floor_db = max(cfg.min_rms_db, peak_db - cfg.relative_rms_floor_db)

    valid_f0 = np.isfinite(f0_hz) & (f0_hz > 20.0)
    active_mask = (
        valid_f0
        & (voiced_flag | (voiced_prob >= cfg.voiced_prob_threshold))
        & (rms_db >= adaptive_floor_db)
    )

    if not np.any(active_mask):
        return VocalPitchResult(
            notes=[],
            stats={"engine": "vocal_pyin", "voiced_frames": 0, "note_count": 0},
            duration_seconds=duration_sec,
        )

    frac_midi = np.zeros(n_frames, dtype=np.float64)
    frac_midi[active_mask] = (
        69.0
        + 12.0 * np.log2(f0_hz[active_mask] / max(200.0, float(cfg.concert_pitch_hz)))
        + float(cfg.transpose_semitones)
    )

    frac_midi, octave_spikes_suppressed = _suppress_octave_spikes(frac_midi, active_mask)
    frac_midi = _vibrato_safe_smooth(frac_midi, active_mask)

    int_midi = np.full(n_frames, -1, dtype=np.int32)
    int_midi[active_mask] = np.clip(np.round(frac_midi[active_mask]).astype(np.int32), 21, 108)

    # Filter isolated 1-frame transition frames flanked immediately by steady neighbor pitches
    cleaned_midi = int_midi.copy()
    for idx in range(1, n_frames - 1):
        if cleaned_midi[idx] >= 0 and cleaned_midi[idx - 1] >= 0 and cleaned_midi[idx + 1] >= 0:
            if cleaned_midi[idx] != cleaned_midi[idx - 1] and cleaned_midi[idx] != cleaned_midi[idx + 1]:
                if cleaned_midi[idx - 1] == cleaned_midi[idx + 1]:
                    cleaned_midi[idx] = cleaned_midi[idx - 1]
                else:
                    cleaned_midi[idx] = cleaned_midi[idx + 1]

    # Identify vocal re-articulation peaks (for repeated same-pitch syllables)
    active_onsets = onset_env[active_mask]
    onset_med = float(np.median(active_onsets)) if active_onsets.size else 0.0
    onset_std = float(np.std(active_onsets)) if active_onsets.size else 0.0
    onset_peak_floor = max(onset_med + 1.45 * onset_std, float(np.max(onset_env)) * 0.24, 0.35)
    min_syllable_frames = max(3, int(round((cfg.min_syllable_gap_sec * sr) / cfg.hop_length)))

    is_onset_split = np.zeros(n_frames, dtype=bool)
    last_split = -min_syllable_frames
    for idx in range(1, n_frames - 1):
        if not active_mask[idx]:
            continue
        if idx - last_split < min_syllable_frames:
            continue
        is_onset_peak = (
            onset_env[idx] >= onset_env[idx - 1]
            and onset_env[idx] > onset_env[idx + 1]
            and onset_env[idx] >= onset_peak_floor
        )
        # Also catch clear vowel re-articulation dips in RMS envelope (dip >= 4dB then recovery)
        pre_dip = float(np.min(rms_db[max(0, idx - 3) : idx + 1]))
        post_rise = float(np.max(rms_db[idx : min(n_frames, idx + 4)]))
        prev_peak = float(np.max(rms_db[max(0, idx - 6) : idx]))
        is_rms_rearticulation = (prev_peak - pre_dip) >= 4.0 and (post_rise - pre_dip) >= 3.2
        if is_onset_peak or is_rms_rearticulation:
            is_onset_split[idx] = True
            last_split = idx

    frame_dt = float(cfg.hop_length) / float(sr)
    # Build raw note segments from pitch runs + syllable re-articulation splits
    raw_segments: list[tuple[int, int, int, bool]] = []  # (pitch, start_frame, end_frame_excl, had_onset_split)
    cur_pitch = -1
    seg_start = 0
    seg_split = False
    for idx in range(n_frames):
        p = int(cleaned_midi[idx])
        if p < 0:
            if cur_pitch >= 0:
                raw_segments.append((cur_pitch, seg_start, idx, seg_split))
                cur_pitch = -1
            continue
        if cur_pitch < 0:
            cur_pitch = p
            seg_start = idx
            seg_split = bool(is_onset_split[idx])
            continue
        if p != cur_pitch:
            raw_segments.append((cur_pitch, seg_start, idx, seg_split))
            cur_pitch = p
            seg_start = idx
            seg_split = bool(is_onset_split[idx])
        elif is_onset_split[idx] and (idx - seg_start) >= min_syllable_frames:
            raw_segments.append((cur_pitch, seg_start, idx, seg_split))
            seg_start = idx
            seg_split = True

    if cur_pitch >= 0:
        raw_segments.append((cur_pitch, seg_start, n_frames, seg_split))

    # Drop sub-minimum micro-fragments before same-pitch consonant bridging
    min_frames = max(2, int(round(cfg.min_note_duration_sec / frame_dt)))
    filtered_segs: list[tuple[int, int, int, bool]] = []
    for seg in raw_segments:
        p, f0_i, f1_i, had_split = seg
        if f1_i - f0_i < min_frames:
            continue
        mean_conf = float(np.mean(voiced_prob[f0_i:f1_i]))
        dur_s = (f1_i - f0_i) * frame_dt
        if dur_s < 0.065 and mean_conf < 0.35:
            continue
        filtered_segs.append(seg)

    # Bridge only brief unvoiced-consonant dropouts (<= 45ms) on the SAME pitch without onset split
    bridged: list[tuple[int, int, int, bool]] = []
    micro_gap_bridges = 0
    for seg in filtered_segs:
        p, f0_i, f1_i, had_split = seg
        if bridged and bridged[-1][0] == p and not had_split:
            prev_p, pf0, pf1, prev_split = bridged[-1]
            gap_sec = (f0_i - pf1) * frame_dt
            if 0.0 <= gap_sec <= cfg.micro_gap_bridge_sec:
                bridged[-1] = (prev_p, pf0, f1_i, prev_split)
                micro_gap_bridges += 1
                continue
        bridged.append(seg)

    # Convert to DetectedNote list with expressive RMS-mapped velocity and voicing confidence
    notes: list[DetectedNote] = []
    vel_floor_db = max(cfg.min_rms_db, peak_db - 30.0)
    vel_span_db = max(12.0, peak_db - vel_floor_db)
    for p, f0_i, f1_i, _ in bridged:
        onset_sec = round(f0_i * frame_dt, 4)
        offset_sec = round(min(duration_sec, max(onset_sec + cfg.min_note_duration_sec, f1_i * frame_dt)), 4)
        if offset_sec <= onset_sec:
            continue
        seg_rms_db = float(np.percentile(rms_db[f0_i:f1_i], 80))
        norm_vel = max(0.0, min(1.0, (seg_rms_db - vel_floor_db) / vel_span_db))
        velocity = int(round(48 + norm_vel * 64))
        conf = float(np.mean(voiced_prob[f0_i:f1_i]))
        notes.append(
            DetectedNote(
                pitch_midi=int(p),
                onset_sec=onset_sec,
                offset_sec=offset_sec,
                velocity=max(1, min(127, velocity)),
                confidence=round(max(0.0, min(1.0, conf)), 3),
            )
        )

    pitches = [n.pitch_midi for n in notes]
    return VocalPitchResult(
        notes=notes,
        duration_seconds=duration_sec,
        stats={
            "engine": "vocal_pyin",
            "voiced_frames": int(np.sum(active_mask)),
            "total_frames": int(n_frames),
            "octave_spikes_suppressed": octave_spikes_suppressed,
            "micro_gap_bridges": micro_gap_bridges,
            "syllable_splits": int(np.sum(is_onset_split)),
            "note_count": len(notes),
            "pitch_range_midi": [min(pitches), max(pitches)] if pitches else None,
            "peak_rms_db": round(peak_db, 2),
        },
    )
