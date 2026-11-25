"""Beat and downbeat tracking with optional CPJKU Beat This! and librosa fallback."""

from __future__ import annotations

import logging
import os
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import librosa
import numpy as np
import soundfile as sf

logger = logging.getLogger(__name__)

_MODEL_LOCK = threading.Lock()
_CACHED_MODELS: dict[tuple[str, str], Any] = {}


@dataclass
class BeatTrackingResult:
    beat_times_sec: list[float]
    downbeat_times_sec: list[float]
    raw_bpm: float
    selected_bpm: float
    candidates: list[dict[str, Any]]
    selected_ratio: float
    downbeat_confidence: float
    resolution_reason: str
    ambiguous: bool
    requested_provider: str
    actual_provider: str
    fallback_used: bool
    fallback_reason: str | None = None
    model_version: str | None = None
    package_version: str | None = None
    inference_seconds: float = 0.0
    diagnostics: dict[str, Any] = field(default_factory=dict)


def _get_beat_this_model(checkpoint: str, device: str, num_threads: int) -> Any:
    key = (checkpoint, device)
    with _MODEL_LOCK:
        if key in _CACHED_MODELS:
            return _CACHED_MODELS[key]
        import torch
        from beat_this.inference import Audio2Beats

        torch.set_num_threads(max(1, num_threads))
        model = Audio2Beats(checkpoint_path=checkpoint, device=device, float16=False, dbn=False)
        _CACHED_MODELS[key] = model
        return model


def _run_beat_this(
    wav_path: Path,
    *,
    checkpoint: str = "final0",
    device: str = "cpu",
    num_threads: int = 4,
) -> tuple[list[float], list[float], float, dict[str, Any]]:
    import beat_this
    import torch

    t0 = time.perf_counter()
    audio, sr = sf.read(str(wav_path), dtype="float32")
    if audio.size == 0 or sr <= 0:
        raise ValueError(f"Empty or invalid audio file: {wav_path}")

    model = _get_beat_this_model(checkpoint, device, num_threads)
    beats, downbeats = model(audio, sr)
    dt = round(time.perf_counter() - t0, 3)

    beat_list = sorted(float(b) for b in beats if np.isfinite(b) and b >= 0.0)
    downbeat_list = sorted(float(d) for d in downbeats if np.isfinite(d) and d >= 0.0)
    meta = {
        "package_version": getattr(beat_this, "__version__", "unknown"),
        "torch_version": torch.__version__,
        "checkpoint": checkpoint,
        "device": device,
        "num_threads": num_threads,
    }
    return beat_list, downbeat_list, dt, meta


def _run_librosa_beats(
    wav_path: Path,
    beats_per_measure: int = 4,
) -> tuple[list[float], list[float], float, np.ndarray, int]:
    t0 = time.perf_counter()
    y, sr = librosa.load(str(wav_path), sr=22050, mono=True, duration=300.0)
    onset_env = librosa.onset.onset_strength(y=y, sr=sr)
    tempo, beat_frames = librosa.beat.beat_track(onset_envelope=onset_env, sr=sr, units="frames")
    if isinstance(tempo, np.ndarray):
        tempo = float(tempo[0]) if len(tempo) > 0 else 120.0

    beat_times = librosa.frames_to_time(beat_frames, sr=sr).tolist()
    beat_times = sorted(float(b) for b in beat_times if np.isfinite(b) and b >= 0.0)

    # Estimate downbeat phase from periodic accent strength across beat_frames
    downbeats: list[float] = []
    if beat_frames is not None and len(beat_frames) >= beats_per_measure:
        strengths = onset_env[np.clip(beat_frames, 0, len(onset_env) - 1)]
        phase_scores = [
            float(np.mean(strengths[ph::beats_per_measure]))
            for ph in range(beats_per_measure)
        ]
        best_phase = int(np.argmax(phase_scores))
        downbeats = [beat_times[i] for i in range(best_phase, len(beat_times), beats_per_measure)]
    elif beat_times:
        downbeats = [beat_times[0]]

    dt = round(time.perf_counter() - t0, 3)
    return beat_times, downbeats, dt, onset_env, sr


def resolve_tempo_from_beats(
    *,
    beat_times: list[float],
    downbeat_times: list[float],
    beats_per_measure: int = 4,
    onset_env: np.ndarray | None = None,
    sr: int = 22050,
    note_durations_sec: list[float] | None = None,
) -> dict[str, Any]:
    """Evaluate detected, half-time, and double-time tempo candidates using beat/downbeat evidence."""
    if len(beat_times) >= 2:
        ibis = np.diff(beat_times)
        valid_ibis = ibis[(ibis >= 0.20) & (ibis <= 2.0)]
        median_ibi = float(np.median(valid_ibis)) if len(valid_ibis) > 0 else 0.5
        raw_bpm = 60.0 / max(0.20, median_ibi)
    else:
        raw_bpm = 120.0

    downbeat_bpm: float | None = None
    downbeat_confidence = 0.0
    beats_per_bar_observed: float | None = None
    if len(downbeat_times) >= 2:
        dbis = np.diff(downbeat_times)
        valid_dbis = dbis[(dbis >= 0.8) & (dbis <= 8.0)]
        if len(valid_dbis) > 0:
            med_dbi = float(np.median(valid_dbis))
            downbeat_bpm = (60.0 * beats_per_measure) / med_dbi
            dbi_cv = float(np.std(valid_dbis) / max(1e-6, med_dbi))
            downbeat_confidence = round(max(0.0, min(1.0, 1.0 - dbi_cv)), 3)
            if len(beat_times) >= 2:
                med_ibi = float(np.median(np.diff(beat_times)))
                beats_per_bar_observed = round(med_dbi / max(0.15, med_ibi), 2)

    # Evaluate candidates: primary, half_time, double_time
    candidates: list[dict[str, Any]] = []
    for rel, cand_bpm in [
        ("primary", raw_bpm),
        ("half_time", raw_bpm / 2.0),
        ("double_time", raw_bpm * 2.0),
    ]:
        if not (42.0 <= cand_bpm <= 220.0):
            continue
        score = 0.50 if rel == "primary" else 0.35

        # Downbeat bar-duration evidence
        if downbeat_bpm is not None:
            ratio_db = cand_bpm / downbeat_bpm
            if abs(ratio_db - 1.0) <= 0.12:
                score += 0.38 * max(0.4, downbeat_confidence)
            elif abs(ratio_db - 2.0) <= 0.15:
                # Candidate is 2x the downbeat-implied quarter pulse (double-time)
                score -= 0.12

        # Note duration / IOI evidence (only when notes exist)
        if note_durations_sec and len(note_durations_sec) >= 6:
            med_dur = float(np.median(note_durations_sec))
            sec_per_beat_cand = 60.0 / cand_bpm
            # Typical musical notes span ~0.35x to ~1.5x of a quarter beat
            if 0.35 * sec_per_beat_cand <= med_dur <= 1.6 * sec_per_beat_cand:
                score += 0.12
            elif rel == "half_time" and med_dur < 0.25 * sec_per_beat_cand:
                # Very short notes fit the faster pulse, not half-time
                score -= 0.10

        # Tempogram energy support when onset_env is provided
        if onset_env is not None and len(onset_env) > 16:
            tempogram = librosa.feature.tempogram(onset_envelope=onset_env, sr=sr)
            freqs = librosa.tempo_frequencies(tempogram.shape[0], sr=sr)
            mean_prof = np.mean(tempogram, axis=1)
            mask = (freqs >= cand_bpm * 0.93) & (freqs <= cand_bpm * 1.07)
            e_cand = float(np.max(mean_prof[mask])) if np.any(mask) else 0.0
            e_max = float(np.max(mean_prof[np.isfinite(freqs) & (freqs >= 40) & (freqs <= 220)])) or 1.0
            score += 0.18 * (e_cand / e_max)

        # Gentle musical pulse prior centered around 70-135 BPM without hardcoding any value
        if 68.0 <= cand_bpm <= 135.0:
            score += 0.05

        candidates.append({"bpm": round(cand_bpm, 2), "relation": rel, "score": round(score, 4)})

    candidates.sort(key=lambda c: float(c["score"]), reverse=True)
    selected = candidates[0] if candidates else {"bpm": round(raw_bpm, 2), "relation": "primary", "score": 0.5}
    selected_bpm = float(selected["bpm"])
    selected_ratio = round(selected_bpm / max(1.0, raw_bpm), 3)
    second_score = float(candidates[1]["score"]) if len(candidates) > 1 else 0.0
    ambiguous = len(candidates) > 1 and (float(selected["score"]) - second_score) <= 0.08

    if selected["relation"] == "half_time":
        reason = f"Half-time selected ({selected_bpm:.1f} vs raw {raw_bpm:.1f} BPM) supported by downbeat/pulse evidence."
    elif selected["relation"] == "double_time":
        reason = f"Double-time selected ({selected_bpm:.1f} vs raw {raw_bpm:.1f} BPM) supported by pulse density."
    else:
        reason = f"Primary beat pulse selected ({selected_bpm:.1f} BPM)."

    return {
        "raw_bpm": round(raw_bpm, 2),
        "selected_bpm": round(selected_bpm, 1),
        "candidates": candidates,
        "selected_ratio": selected_ratio,
        "downbeat_bpm": round(downbeat_bpm, 2) if downbeat_bpm is not None else None,
        "downbeat_confidence": downbeat_confidence,
        "beats_per_bar_observed": beats_per_bar_observed,
        "resolution_reason": reason,
        "ambiguous": ambiguous,
    }


def track_beats_and_downbeats(
    wav_path: Path,
    *,
    beats_per_measure: int = 4,
    provider_preference: str | None = None,
    note_durations_sec: list[float] | None = None,
) -> BeatTrackingResult:
    """Detect beats and downbeats using Beat This! (optional) with librosa fallback."""
    requested = (
        provider_preference or os.environ.get("TIMING_PROVIDER", "auto")
    ).strip().lower()
    checkpoint = os.environ.get("BEAT_THIS_CHECKPOINT", "final0").strip() or "final0"
    device = os.environ.get("BEAT_THIS_DEVICE", "cpu").strip().lower() or "cpu"
    env_threads = os.environ.get("BEAT_THIS_NUM_THREADS")
    num_threads = (
        max(1, int(env_threads))
        if env_threads and env_threads.isdigit()
        else min(4, os.cpu_count() or 4)
    )

    beat_times: list[float] = []
    downbeat_times: list[float] = []
    actual_provider = "librosa"
    fallback_used = False
    fallback_reason: str | None = None
    model_version: str | None = None
    package_version: str | None = None
    inference_seconds = 0.0
    onset_env: np.ndarray | None = None
    sr = 22050

    if requested in ("auto", "beat_this"):
        try:
            beat_times, downbeat_times, inference_seconds, bt_meta = _run_beat_this(
                wav_path,
                checkpoint=checkpoint,
                device=device,
                num_threads=num_threads,
            )
            actual_provider = "beat_this"
            model_version = f"beat_this-{bt_meta['checkpoint']}"
            package_version = str(bt_meta["package_version"])
        except Exception as exc:
            fallback_used = True
            fallback_reason = f"beat_this unavailable/failed: {exc}"
            logger.warning("Timing provider '%s' failed (%s); falling back to librosa.", requested, exc)

    if actual_provider != "beat_this":
        beat_times, downbeat_times, inference_seconds, onset_env, sr = _run_librosa_beats(
            wav_path, beats_per_measure=beats_per_measure
        )
        package_version = librosa.__version__
        model_version = f"librosa-{librosa.__version__}"

    resolved = resolve_tempo_from_beats(
        beat_times=beat_times,
        downbeat_times=downbeat_times,
        beats_per_measure=beats_per_measure,
        onset_env=onset_env,
        sr=sr,
        note_durations_sec=note_durations_sec,
    )

    return BeatTrackingResult(
        beat_times_sec=beat_times,
        downbeat_times_sec=downbeat_times,
        raw_bpm=float(resolved["raw_bpm"]),
        selected_bpm=float(resolved["selected_bpm"]),
        candidates=list(resolved["candidates"]),
        selected_ratio=float(resolved["selected_ratio"]),
        downbeat_confidence=float(resolved["downbeat_confidence"]),
        resolution_reason=str(resolved["resolution_reason"]),
        ambiguous=bool(resolved["ambiguous"]),
        requested_provider=requested,
        actual_provider=actual_provider,
        fallback_used=fallback_used,
        fallback_reason=fallback_reason,
        model_version=model_version,
        package_version=package_version,
        inference_seconds=inference_seconds,
        diagnostics={
            "downbeat_bpm": resolved["downbeat_bpm"],
            "beats_per_bar_observed": resolved["beats_per_bar_observed"],
            "raw_beat_count": len(beat_times),
            "raw_downbeat_count": len(downbeat_times),
        },
    )


def _halfbar_metrical_evidence_prefers_4_4(
    downbeats: list[float],
    beat_times: list[float],
    bpm: float,
    selected_ratio: float,
    notes: Any,
) -> tuple[bool, int, dict[str, Any]]:
    """Evaluate bass/harmonic rhythm and accent alternation to separate 4/4 from genuine 2/4."""
    note_list = list(notes or [])
    if len(downbeats) < 4 or not note_list:
        return False, 0, {"evaluated": False}

    # Build per-half-bar pitch-class vectors, lowest bass pitch, and downbeat attack weight
    n_hb = len(downbeats) - 1
    hb_profiles: list[np.ndarray] = []
    hb_bass_pc: list[int | None] = []
    db_weights: list[float] = []

    for i in range(n_hb):
        db_t = downbeats[i]
        att_w = 0.0
        for n in note_list:
            if abs(float(n.onset_sec) - db_t) <= 0.14:
                vel = max(1.0, float(getattr(n, "velocity", 80)))
                bass_boost = 1.6 if int(n.pitch_midi) < 55 else 1.0
                att_w += vel * bass_boost
        db_weights.append(att_w)

    for i in range(n_hb):
        start_t = downbeats[i]
        end_t = downbeats[i + 1]
        vec = np.zeros(12, dtype=np.float64)
        low_midi: int | None = None
        for n in note_list:
            ov = min(float(n.offset_sec), end_t) - max(float(n.onset_sec), start_t)
            if ov <= 0.04:
                continue
            vel = max(1.0, float(getattr(n, "velocity", 80))) / 127.0
            bass_mult = 1.4 if int(n.pitch_midi) < 58 else 1.0
            vec[int(n.pitch_midi) % 12] += ov * vel * bass_mult
            if low_midi is None or int(n.pitch_midi) < low_midi:
                low_midi = int(n.pitch_midi)
        norm = float(np.linalg.norm(vec))
        if norm > 1e-8:
            vec = vec / norm
        hb_profiles.append(vec)
        hb_bass_pc.append((low_midi % 12) if low_midi is not None else None)

    phase0_changes: list[float] = []
    phase1_changes: list[float] = []
    same_bar_sims: list[float] = []
    across_bar_sims: list[float] = []

    for i in range(1, n_hb):
        p_prev = hb_profiles[i - 1]
        p_curr = hb_profiles[i]
        if float(np.linalg.norm(p_prev)) <= 1e-6 or float(np.linalg.norm(p_curr)) <= 1e-6:
            continue
        cos_sim = float(np.dot(p_prev, p_curr))
        harm_dist = max(0.0, 1.0 - cos_sim)
        bass_changed = (
            1.0
            if (
                hb_bass_pc[i] is not None
                and hb_bass_pc[i - 1] is not None
                and hb_bass_pc[i] != hb_bass_pc[i - 1]
            )
            else 0.0
        )
        change_score = 0.6 * harm_dist + 0.4 * bass_changed
        if i % 2 == 0:
            phase0_changes.append(change_score)
            across_bar_sims.append(cos_sim)
        else:
            phase1_changes.append(change_score)
            same_bar_sims.append(cos_sim)

    mean_c0 = float(np.mean(phase0_changes)) if phase0_changes else 0.0
    mean_c1 = float(np.mean(phase1_changes)) if phase1_changes else 0.0
    mean_w0 = float(np.mean(db_weights[0::2])) if db_weights[0::2] else 0.0
    mean_w1 = float(np.mean(db_weights[1::2])) if db_weights[1::2] else 0.0
    norm_w = max(1.0, mean_w0 + mean_w1)

    phase0_strength = mean_c0 + 0.35 * (mean_w0 / norm_w)
    phase1_strength = mean_c1 + 0.35 * (mean_w1 / norm_w)
    best_phase = 0 if phase0_strength >= phase1_strength else 1

    # In 4/4 paired from half-bars:
    # Either chords span ~4 beats (similarity inside best_phase pairs > 0.72), OR one phase
    # clearly dominates harmonic/bass changes & downbeat accents (>= 1.28x weaker phase).
    pair_sims = same_bar_sims if best_phase == 0 else across_bar_sims
    mean_pair_sim = float(np.mean(pair_sims)) if pair_sims else 0.0
    strong_c = max(mean_c0, mean_c1)
    weak_c = min(mean_c0, mean_c1)
    strong_w = mean_w0 if best_phase == 0 else mean_w1
    weak_w = mean_w1 if best_phase == 0 else mean_w0

    asymmetric_change = strong_c >= max(0.08, weak_c * 1.28)
    asymmetric_accent = strong_w >= max(1.0, weak_w * 1.25)
    sustained_4beat_harmony = mean_pair_sim >= 0.72 and weak_c < 0.48
    half_time_doubled = abs(float(selected_ratio) - 2.0) < 0.25

    prefers_4_4 = bool(
        (sustained_4beat_harmony or asymmetric_change or asymmetric_accent or half_time_doubled)
        and (55.0 <= float(bpm) <= 155.0 or half_time_doubled)
    )
    return prefers_4_4, best_phase, {
        "evaluated": True,
        "mean_change_phase0": round(mean_c0, 3),
        "mean_change_phase1": round(mean_c1, 3),
        "mean_weight_phase0": round(mean_w0, 1),
        "mean_weight_phase1": round(mean_w1, 1),
        "mean_within_bar_similarity": round(mean_pair_sim, 3),
        "half_time_doubled": half_time_doubled,
    }


def infer_time_signature_from_beats(
    beat_result: BeatTrackingResult,
    requested_time_signature: str = "auto",
    *,
    notes: Any = None,
) -> tuple[str, bool, dict[str, Any]]:
    """Infer musical meter (2/4, 3/4, 4/4, 6/8) from downbeat/beat intervals and metrical evidence when 'auto'.

    Returns (time_signature, was_estimated, diagnostics).
    Preserves explicit user-selected time signatures untouched.
    """
    req = (requested_time_signature or "auto").strip()
    if req.lower() != "auto":
        return req, False, {
            "requested_time_signature": req,
            "detected_time_signature": req,
            "confidence": 1.0,
            "reason": "explicit_user_selection",
        }

    downbeats = [float(t) for t in beat_result.downbeat_times_sec]
    beats = [float(t) for t in beat_result.beat_times_sec]
    conf = float(beat_result.downbeat_confidence)

    if len(downbeats) < 2 or len(beats) < 4:
        return "4/4", True, {
            "requested_time_signature": "auto",
            "detected_time_signature": "4/4",
            "confidence": round(conf, 3),
            "consistency": 0.0,
            "bar_count": max(0, len(downbeats) - 1),
            "reason": "insufficient_downbeats_fallback_4_4",
        }

    beat_diffs = np.diff(np.array(beats, dtype=np.float64))
    beat_diffs = beat_diffs[beat_diffs > 0.1]
    if len(beat_diffs) == 0:
        return "4/4", True, {
            "requested_time_signature": "auto",
            "detected_time_signature": "4/4",
            "confidence": round(conf, 3),
            "consistency": 0.0,
            "bar_count": len(downbeats) - 1,
            "reason": "invalid_beat_intervals_fallback_4_4",
        }

    median_beat = float(np.median(beat_diffs))
    bar_counts: dict[int, int] = {}
    valid_bars = 0
    for i in range(len(downbeats) - 1):
        bar_dur = downbeats[i + 1] - downbeats[i]
        if bar_dur <= 0.2:
            continue
        ratio = bar_dur / median_beat
        nearest = int(round(ratio))
        if abs(ratio - nearest) <= 0.28 and nearest in (2, 3, 4, 6):
            bar_counts[nearest] = bar_counts.get(nearest, 0) + 1
        valid_bars += 1

    if valid_bars == 0 or not bar_counts:
        return "4/4", True, {
            "requested_time_signature": "auto",
            "detected_time_signature": "4/4",
            "confidence": round(conf, 3),
            "consistency": 0.0,
            "bar_count": valid_bars,
            "reason": "no_consistent_bar_grouping_fallback_4_4",
        }

    best_n, best_count = max(bar_counts.items(), key=lambda kv: (kv[1], kv[0] == 4))
    consistency = best_count / valid_bars
    meter_map = {2: "2/4", 3: "3/4", 4: "4/4", 6: "6/8"}

    # When half-time beat grid was doubled (selected_ratio ~ 2.0) or beat_this emitted
    # half-bar downbeats (2 beats/bar) on a 4/4 pop/ballad song, check metrical/harmonic evidence.
    if consistency >= 0.65 and conf >= 0.45 and best_n == 2 and notes is not None:
        prefers_4_4, downbeat_phase, evidence = _halfbar_metrical_evidence_prefers_4_4(
            downbeats=downbeats,
            beat_times=beats,
            bpm=float(beat_result.selected_bpm),
            selected_ratio=float(beat_result.selected_ratio),
            notes=notes,
        )
        if prefers_4_4:
            return "4/4", True, {
                "requested_time_signature": "auto",
                "detected_time_signature": "4/4",
                "confidence": round(conf, 3),
                "consistency": round(consistency, 3),
                "beats_per_bar_observed": 4,
                "raw_beats_per_bar_observed": 2,
                "downbeat_phase": downbeat_phase,
                "bar_count": max(1, valid_bars // 2),
                "metrical_evidence": evidence,
                "reason": "metrical_accent_and_harmony_4_4",
            }
        return "2/4", True, {
            "requested_time_signature": "auto",
            "detected_time_signature": "2/4",
            "confidence": round(conf, 3),
            "consistency": round(consistency, 3),
            "beats_per_bar_observed": 2,
            "bar_count": valid_bars,
            "metrical_evidence": evidence,
            "reason": "confirmed_2_4_harmonic_rhythm",
        }

    if consistency >= 0.65 and conf >= 0.45 and best_n in meter_map:
        detected = meter_map[best_n]
        return detected, True, {
            "requested_time_signature": "auto",
            "detected_time_signature": detected,
            "confidence": round(conf, 3),
            "consistency": round(consistency, 3),
            "beats_per_bar_observed": best_n,
            "bar_count": valid_bars,
            "reason": "downbeat_interval_consensus",
        }

    return "4/4", True, {
        "requested_time_signature": "auto",
        "detected_time_signature": "4/4",
        "confidence": round(conf, 3),
        "consistency": round(consistency, 3),
        "beats_per_bar_observed": best_n,
        "bar_count": valid_bars,
        "reason": "low_confidence_fallback_4_4",
    }
