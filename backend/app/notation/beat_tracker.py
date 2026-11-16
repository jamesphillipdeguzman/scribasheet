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
