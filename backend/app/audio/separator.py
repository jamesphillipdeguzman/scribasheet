"""Optional Demucs audio stem separation and source-routing utilities.

All heavy ML imports (``torch``, ``demucs``) are strictly lazy-loaded inside
worker separation functions so the Railway API never imports them at startup.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
import soundfile as sf

from app.core.config import get_settings

logger = logging.getLogger(__name__)

STANDARD_STEM_NAMES = ("vocals", "drums", "bass", "other")


@dataclass
class SeparationResult:
    available: bool
    backend: str
    stems: dict[str, Path] = field(default_factory=dict)
    message: str = ""
    model_name: str = "htdemucs"
    device: str = "cpu"
    error_code: str | None = None
    cache_dir: str | None = None


def resolve_demucs_cache_dir(cache_dir: Path | None = None) -> Path:
    """Resolve and ensure a persistent Demucs/Torch Hub model cache directory."""
    if cache_dir is not None:
        resolved = Path(cache_dir)
    elif os.environ.get("DEMUCS_CACHE_DIR"):
        resolved = Path(os.environ["DEMUCS_CACHE_DIR"])
    elif os.environ.get("TORCH_HOME"):
        resolved = Path(os.environ["TORCH_HOME"])
    else:
        resolved = Path.home() / ".cache" / "scribasheet" / "demucs"
    resolved.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("TORCH_HOME", str(resolved))
    return resolved


def detect_demucs_device(requested_device: str | None = None) -> str:
    """Select CUDA if available and not overridden, otherwise CPU."""
    if requested_device and requested_device.strip().lower() in ("cpu", "cuda"):
        req = requested_device.strip().lower()
        if req == "cpu":
            return "cpu"
    try:
        import torch  # type: ignore

        if torch.cuda.is_available():
            return "cuda"
    except Exception:
        pass
    return "cpu"


def _write_stem_wav(path: Path, tensor_or_array: Any, samplerate: int) -> None:
    """Write a [channels, samples] or [samples, channels] audio tensor to WAV."""
    arr = tensor_or_array.detach().cpu().numpy() if hasattr(tensor_or_array, "detach") else np.asarray(tensor_or_array)
    if arr.ndim == 2 and arr.shape[0] <= 8 and arr.shape[0] < arr.shape[1]:
        arr = arr.T
    arr = np.clip(arr, -1.0, 1.0).astype(np.float32)
    path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(path), arr, int(samplerate), subtype="PCM_16")


def _find_isolated_demucs_python() -> Path | None:
    """Locate an isolated Demucs Python interpreter (e.g. backend/.venv_demucs)."""
    env_py = os.environ.get("DEMUCS_PYTHON")
    if env_py:
        p = Path(env_py)
        if p.exists():
            return p
    backend_dir = Path(__file__).resolve().parents[2]
    for rel in (
        Path(".venv_demucs/Scripts/python.exe"),
        Path(".venv_demucs/bin/python"),
    ):
        cand = backend_dir / rel
        if cand.exists():
            return cand
    return None


def _run_demucs_subprocess(
    python_exe: Path,
    wav_path: Path,
    stem_out_dir: Path,
    *,
    model_name: str,
    device: str,
    overlap: float,
    segment_sec: float | None,
    cache_dir: Path,
) -> SeparationResult:
    """Run Demucs inside an isolated Python environment via subprocess."""
    script = (
        "import json, sys, pathlib, numpy as np, soundfile as sf, demucs.api\n"
        "cfg = json.loads(sys.argv[1])\n"
        "kw = {'model': cfg['model'], 'device': cfg['device'], 'overlap': cfg['overlap']}\n"
        "if cfg['segment'] is not None: kw['segment'] = cfg['segment']\n"
        "sep = demucs.api.Separator(**kw)\n"
        "_, stems = sep.separate_audio_file(cfg['wav'])\n"
        "out = pathlib.Path(cfg['out_dir']); out.mkdir(parents=True, exist_ok=True)\n"
        "sr = int(getattr(sep, 'samplerate', 44100))\n"
        "paths = {}\n"
        "for k, t in stems.items():\n"
        "    arr = t.detach().cpu().numpy()\n"
        "    if arr.ndim == 2 and arr.shape[0] <= 8 and arr.shape[0] < arr.shape[1]: arr = arr.T\n"
        "    p = out / f'{k}.wav'\n"
        "    sf.write(str(p), np.clip(arr, -1.0, 1.0).astype(np.float32), sr, subtype='PCM_16')\n"
        "    paths[str(k)] = str(p)\n"
        "print(json.dumps(paths))\n"
    )
    payload = json.dumps(
        {
            "wav": str(wav_path),
            "out_dir": str(stem_out_dir),
            "model": model_name,
            "device": device,
            "overlap": float(overlap),
            "segment": float(segment_sec) if segment_sec is not None else None,
        }
    )
    env = os.environ.copy()
    env.setdefault("TORCH_HOME", str(cache_dir))
    proc = subprocess.run(
        [str(python_exe), "-c", script, payload],
        capture_output=True,
        text=True,
        env=env,
        timeout=900,
        check=False,
    )
    if proc.returncode != 0:
        err = (proc.stderr or proc.stdout or "Unknown subprocess error").strip()
        return SeparationResult(
            available=False,
            backend="demucs",
            stems={},
            message=f"Demucs stem separation failed: {err[-400:]}",
            model_name=model_name,
            device=device,
            error_code="DEMUCS_SEPARATION_FAILED",
            cache_dir=str(cache_dir),
        )
    try:
        last_line = [ln for ln in (proc.stdout or "").splitlines() if ln.strip()][-1]
        raw_map = json.loads(last_line)
        stems = {str(k): Path(v) for k, v in raw_map.items() if Path(v).exists()}
    except Exception as exc:
        return SeparationResult(
            available=False,
            backend="demucs",
            stems={},
            message=f"Demucs completed with unreadable stem output: {exc}",
            model_name=model_name,
            device=device,
            error_code="DEMUCS_NO_STEMS",
            cache_dir=str(cache_dir),
        )
    if not stems:
        return SeparationResult(
            available=False,
            backend="demucs",
            stems={},
            message="Demucs completed without producing stem files.",
            model_name=model_name,
            device=device,
            error_code="DEMUCS_NO_STEMS",
            cache_dir=str(cache_dir),
        )
    return SeparationResult(
        available=True,
        backend="demucs",
        stems=stems,
        message=f"Generated {len(stems)} separated stems via Demucs ({model_name}, {device}).",
        model_name=model_name,
        device=device,
        cache_dir=str(cache_dir),
    )


def _audio_file_fingerprint(file_path: Path) -> str | None:
    """Compute a compact SHA-256 fingerprint for Demucs stem cache reuse."""
    try:
        h = hashlib.sha256()
        with Path(file_path).open("rb") as f:
            while True:
                chunk = f.read(1024 * 1024)
                if not chunk:
                    break
                h.update(chunk)
        return h.hexdigest()[:20]
    except Exception:
        return None


def _load_cached_stems(cache_stem_dir: Path) -> dict[str, Path]:
    if not cache_stem_dir.exists():
        return {}
    found: dict[str, Path] = {}
    for p in cache_stem_dir.glob("*.wav"):
        try:
            if p.stat().st_size > 44:
                found[p.stem] = p
        except OSError:
            continue
    return found if "vocals" in found else {}


def _save_stems_to_cache(stems: dict[str, Path], cache_stem_dir: Path) -> None:
    try:
        cache_stem_dir.mkdir(parents=True, exist_ok=True)
        for name, src_path in stems.items():
            if src_path.exists():
                shutil.copy2(src_path, cache_stem_dir / f"{name}.wav")
    except Exception as exc:
        logger.debug("Skipping stem cache write (%s)", exc)


def separate_audio_stems(
    wav_path: Path,
    output_dir: Path,
    *,
    enabled: bool | None = None,
    model_name: str = "htdemucs",
    segment_sec: float | None = None,
    overlap: float = 0.25,
    two_stems: str | None = None,
    device: str | None = None,
    cache_dir: Path | None = None,
    use_stem_cache: bool = True,
) -> SeparationResult:
    """Separate input audio into Demucs stems (vocals, drums, bass, other).

    Reuses valid cached stems for the exact input file hash and model when available.
    Honestly reports availability and errors; never fabricates separated stems.
    """
    settings = get_settings()
    should_run = enabled if enabled is not None else bool(settings.ENABLE_SOURCE_SEPARATION)
    if not should_run:
        return SeparationResult(
            available=False,
            backend="none",
            stems={},
            message="Source separation is disabled; proceeding with direct transcription.",
            model_name=model_name,
        )

    backend = settings.SOURCE_SEPARATION_BACKEND
    if enabled is True and backend == "none":
        backend = "demucs"
    if backend != "demucs":
        return SeparationResult(
            available=False,
            backend=backend,
            stems={},
            message="Configured source separation backend is unavailable; proceeding with direct transcription.",
            model_name=model_name,
            error_code="SEPARATION_BACKEND_UNAVAILABLE",
        )

    resolved_cache = resolve_demucs_cache_dir(cache_dir)
    selected_device = detect_demucs_device(device)
    stem_cache_dir: Path | None = None
    if use_stem_cache:
        fp = _audio_file_fingerprint(wav_path)
        if fp:
            stem_cache_dir = resolved_cache / "stems_cache" / f"{fp}_{model_name}"
            cached_stems = _load_cached_stems(stem_cache_dir)
            if cached_stems:
                output_dir.mkdir(parents=True, exist_ok=True)
                copied: dict[str, Path] = {}
                target_dir = output_dir / model_name / wav_path.stem
                target_dir.mkdir(parents=True, exist_ok=True)
                for stem_name, src_p in cached_stems.items():
                    dst_p = target_dir / f"{stem_name}.wav"
                    shutil.copy2(src_p, dst_p)
                    copied[stem_name] = dst_p
                return SeparationResult(
                    available=True,
                    backend="demucs",
                    stems=copied,
                    message=f"Reused {len(copied)} cached Demucs stems ({model_name}).",
                    model_name=model_name,
                    device=selected_device,
                    cache_dir=str(resolved_cache),
                )

    try:
        import demucs.separate  # type: ignore  # noqa: F401
    except ImportError:
        iso_python = _find_isolated_demucs_python()
        if iso_python is not None:
            output_dir.mkdir(parents=True, exist_ok=True)
            stem_out_dir = output_dir / model_name / wav_path.stem
            sub_res = _run_demucs_subprocess(
                iso_python,
                wav_path,
                stem_out_dir,
                model_name=model_name,
                device=selected_device,
                overlap=overlap,
                segment_sec=segment_sec,
                cache_dir=resolved_cache,
            )
            if sub_res.available and stem_cache_dir is not None:
                _save_stems_to_cache(sub_res.stems, stem_cache_dir)
            return sub_res
        logger.info("Demucs package not installed; cannot separate stems.")
        return SeparationResult(
            available=False,
            backend="demucs",
            stems={},
            message=(
                "Demucs is not installed in this local worker environment. "
                "Install it in backend/.venv_demucs or backend/.venv with `pip install demucs`."
            ),
            model_name=model_name,
            device=selected_device,
            error_code="DEMUCS_NOT_INSTALLED",
            cache_dir=str(resolved_cache),
        )

    output_dir.mkdir(parents=True, exist_ok=True)
    stem_out_dir = output_dir / model_name / wav_path.stem
    stem_out_dir.mkdir(parents=True, exist_ok=True)

    # Prefer demucs.api.Separator (clean Python API, caches model across calls)
    try:
        import demucs.api  # type: ignore

        sep_kwargs: dict[str, Any] = {
            "model": model_name,
            "device": selected_device,
            "overlap": float(overlap),
        }
        if segment_sec is not None:
            sep_kwargs["segment"] = float(segment_sec)

        separator = demucs.api.Separator(**sep_kwargs)
        _, separated = separator.separate_audio_file(str(wav_path))
        stems: dict[str, Path] = {}
        for stem_name, stem_tensor in separated.items():
            out_wav = stem_out_dir / f"{stem_name}.wav"
            _write_stem_wav(out_wav, stem_tensor, int(getattr(separator, "samplerate", 44100)))
            stems[str(stem_name)] = out_wav

        if not stems:
            return SeparationResult(
                available=False,
                backend="demucs",
                stems={},
                message="Demucs completed without producing stem files.",
                model_name=model_name,
                device=selected_device,
                error_code="DEMUCS_NO_STEMS",
                cache_dir=str(resolved_cache),
            )
        if stem_cache_dir is not None:
            _save_stems_to_cache(stems, stem_cache_dir)
        return SeparationResult(
            available=True,
            backend="demucs",
            stems=stems,
            message=f"Generated {len(stems)} separated stems via Demucs ({model_name}, {selected_device}).",
            model_name=model_name,
            device=selected_device,
            cache_dir=str(resolved_cache),
        )
    except AttributeError:
        pass
    except Exception as exc:
        logger.warning("Demucs API separation failed: %s", exc)
        return SeparationResult(
            available=False,
            backend="demucs",
            stems={},
            message=f"Demucs stem separation failed: {exc}",
            model_name=model_name,
            device=selected_device,
            error_code="DEMUCS_SEPARATION_FAILED",
            cache_dir=str(resolved_cache),
        )

    # Fallback to CLI entrypoint when demucs.api.Separator is unavailable
    try:
        cli_args = ["-n", model_name, "-d", selected_device, "-o", str(output_dir)]
        if segment_sec is not None:
            cli_args.extend(["--segment", str(int(segment_sec))])
        if two_stems:
            cli_args.extend(["--two-stems", two_stems])
        cli_args.append(str(wav_path))

        demucs.separate.main(cli_args)
        stems = {}
        for stem_file in output_dir.rglob("*.wav"):
            stems[stem_file.stem] = stem_file
        if not stems:
            return SeparationResult(
                available=False,
                backend="demucs",
                stems={},
                message="Demucs completed without producing stem files.",
                model_name=model_name,
                device=selected_device,
                error_code="DEMUCS_NO_STEMS",
                cache_dir=str(resolved_cache),
            )
        return SeparationResult(
            available=True,
            backend="demucs",
            stems=stems,
            message=f"Generated {len(stems)} separated stems via Demucs ({model_name}, {selected_device}).",
            model_name=model_name,
            device=selected_device,
            cache_dir=str(resolved_cache),
        )
    except Exception as exc:
        logger.warning("Demucs CLI separation failed: %s", exc)
        return SeparationResult(
            available=False,
            backend="demucs",
            stems={},
            message=f"Demucs stem separation failed: {exc}",
            model_name=model_name,
            device=selected_device,
            error_code="DEMUCS_SEPARATION_FAILED",
            cache_dir=str(resolved_cache),
        )


def _wav_rms(path: Path) -> float:
    """Compute root-mean-square energy of a WAV file safely."""
    try:
        data, _ = sf.read(str(path), dtype="float32", always_2d=False)
        if data.size == 0:
            return 0.0
        return float(np.sqrt(np.mean(np.square(data))))
    except Exception:
        return 0.0


def mix_wav_stems(
    stem_paths: list[Path],
    out_path: Path,
    target_sr: int = 22050,
    weights: list[float] | None = None,
) -> Path | None:
    """Mix one or more separated WAV stems cleanly to mono WAV without clipping."""
    valid_entries = [
        (Path(p), float(weights[idx]) if weights and idx < len(weights) else 1.0)
        for idx, p in enumerate(stem_paths)
        if p and Path(p).exists()
    ]
    if not valid_entries:
        return None

    mixed: np.ndarray | None = None
    src_sr = target_sr
    for path, weight in valid_entries:
        data, sr = sf.read(str(path), dtype="float32", always_2d=False)
        if data.size == 0:
            continue
        if data.ndim == 2:
            data = np.mean(data, axis=1)
        if sr != src_sr and mixed is not None:
            old_idx = np.linspace(0.0, 1.0, len(data), endpoint=False)
            new_len = max(1, int(round(len(data) * (src_sr / float(sr)))))
            new_idx = np.linspace(0.0, 1.0, new_len, endpoint=False)
            data = np.interp(new_idx, old_idx, data).astype(np.float32)
        elif mixed is None:
            src_sr = int(sr)

        scaled = data.astype(np.float32) * weight
        if mixed is None:
            mixed = scaled
        else:
            if len(scaled) > len(mixed):
                mixed = np.pad(mixed, (0, len(scaled) - len(mixed)))
            elif len(scaled) < len(mixed):
                scaled = np.pad(scaled, (0, len(mixed) - len(scaled)))
            mixed = mixed + scaled

    if mixed is None or mixed.size == 0:
        return None

    if src_sr != target_sr:
        old_idx = np.linspace(0.0, 1.0, len(mixed), endpoint=False)
        new_len = max(1, int(round(len(mixed) * (target_sr / float(src_sr)))))
        new_idx = np.linspace(0.0, 1.0, new_len, endpoint=False)
        mixed = np.interp(new_idx, old_idx, mixed).astype(np.float32)
        src_sr = target_sr

    peak = float(np.max(np.abs(mixed)))
    if peak > 0.891:
        mixed = mixed * (0.891 / peak)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(out_path), np.clip(mixed, -1.0, 1.0).astype(np.float32), src_sr, subtype="PCM_16")
    return out_path


def classify_audio_content(
    wav_path: Path | None = None,
    stems: dict[str, Path] | None = None,
) -> dict[str, Any]:
    """Inspect audio waveform and optional Demucs stems to classify instrument texture.

    Returns one of: 'solo_piano', 'piano_with_vocals',
    'piano_with_bass_or_other', or 'multi_instrument'.
    """
    if stems:
        vocal_rms = _wav_rms(stems["vocals"]) if "vocals" in stems else 0.0
        drum_rms = _wav_rms(stems["drums"]) if "drums" in stems else 0.0
        bass_rms = _wav_rms(stems["bass"]) if "bass" in stems else 0.0
        other_rms = _wav_rms(stems["other"]) if "other" in stems else 0.0
        piano_rms = _wav_rms(stems["piano"]) if "piano" in stems else 0.0
        guitar_rms = _wav_rms(stems["guitar"]) if "guitar" in stems else 0.0

        harm_rms = piano_rms + other_rms + guitar_rms
        total_rms = max(1e-6, vocal_rms + drum_rms + bass_rms + harm_rms)
        vocal_ratio = vocal_rms / total_rms
        drum_ratio = drum_rms / total_rms
        bass_ratio = bass_rms / total_rms
        piano_ratio = (piano_rms if piano_rms > 0 else other_rms) / total_rms

        if vocal_rms >= 0.008 and vocal_ratio >= 0.16 and drum_rms >= 0.008 and drum_ratio >= 0.12:
            content_type = "multi_instrument"
        elif drum_rms >= 0.009 and drum_ratio >= 0.15:
            content_type = "multi_instrument"
        elif vocal_rms >= 0.008 and vocal_ratio >= 0.16:
            content_type = "piano_with_vocals"
        elif bass_rms >= 0.008 and bass_ratio >= 0.18:
            content_type = "piano_with_bass_or_other"
        else:
            content_type = "solo_piano"

        non_piano_pressure = vocal_ratio + drum_ratio + (0.4 * bass_ratio if content_type != "solo_piano" else 0.0)
        solo_confidence = round(max(0.0, min(1.0, 1.0 - non_piano_pressure * 1.4)), 3)
        return {
            "content_type": content_type,
            "solo_confidence": solo_confidence,
            "source": "demucs_stems",
            "vocal_energy_ratio": round(vocal_ratio, 4),
            "drum_energy_ratio": round(drum_ratio, 4),
            "bass_energy_ratio": round(bass_ratio, 4),
            "piano_energy_ratio": round(piano_ratio, 4),
        }

    if wav_path is None or not Path(wav_path).exists():
        return {
            "content_type": "solo_piano",
            "solo_confidence": 0.5,
            "source": "unavailable",
        }

    try:
        y, sr = sf.read(str(wav_path), dtype="float32", always_2d=False)
        if y.ndim == 2:
            y = np.mean(y, axis=1)
        if y.size < 2048:
            return {"content_type": "solo_piano", "solo_confidence": 0.6, "source": "short_audio"}
        # Analyze up to 35s slice from active section for speed
        max_len = int(sr * 35)
        if len(y) > max_len:
            mid = len(y) // 2
            y_slice = y[max(0, mid - max_len // 2) : min(len(y), mid + max_len // 2)]
        else:
            y_slice = y

        frame_len = 2048
        hop = 512
        n_frames = max(1, 1 + (len(y_slice) - frame_len) // hop)
        if n_frames < 4:
            return {"content_type": "solo_piano", "solo_confidence": 0.6, "source": "short_frames"}

        win = np.hanning(frame_len).astype(np.float32)
        frames = np.lib.stride_tricks.sliding_window_view(y_slice, frame_len)[::hop]
        mag = np.abs(np.fft.rfft(frames * win, axis=1))
        freqs = np.fft.rfftfreq(frame_len, d=1.0 / sr)

        # High-frequency broadband burst ratio (drums/percussion indicator above 5 kHz)
        total_spec = np.sum(mag, axis=1) + 1e-8
        hf_energy = np.sum(mag[:, freqs >= 5000.0], axis=1) / total_spec
        low_energy = np.sum(mag[:, (freqs >= 35.0) & (freqs <= 160.0)], axis=1) / total_spec
        mid_energy = np.sum(mag[:, (freqs >= 300.0) & (freqs <= 3200.0)], axis=1) / total_spec

        # Spectral flux across consecutive frames: sharp transient spikes indicate percussion
        flux = np.sqrt(np.mean(np.square(np.maximum(0.0, np.diff(mag, axis=0))), axis=1))
        flux_p95 = float(np.percentile(flux, 95))
        flux_med = float(np.median(flux)) + 1e-8
        percussive_spike_ratio = flux_p95 / flux_med
        hf_burst_ratio = float(np.percentile(hf_energy, 90))
        sub_bass_ratio = float(np.mean(low_energy))
        spectral_flatness = float(
            np.mean(np.exp(np.mean(np.log(mag + 1e-7), axis=1)) / (np.mean(mag, axis=1) + 1e-7))
        )

        # Solo piano tends to have low broadband flatness, low >=5kHz bursts, moderate sub-bass
        is_percussive = hf_burst_ratio >= 0.14 or (spectral_flatness >= 0.12 and percussive_spike_ratio >= 7.5)
        has_heavy_bass = sub_bass_ratio >= 0.36
        vocal_modulation = float(np.std(mid_energy)) >= 0.14 and spectral_flatness >= 0.065

        if is_percussive and (has_heavy_bass or vocal_modulation):
            content_type = "multi_instrument"
            solo_conf = 0.25
        elif vocal_modulation and not is_percussive:
            content_type = "piano_with_vocals"
            solo_conf = 0.45
        elif is_percussive or has_heavy_bass:
            content_type = "piano_with_bass_or_other"
            solo_conf = 0.55
        else:
            content_type = "solo_piano"
            solo_conf = round(max(0.72, min(0.96, 1.0 - spectral_flatness * 2.5 - hf_burst_ratio * 1.2)), 3)

        return {
            "content_type": content_type,
            "solo_confidence": solo_conf,
            "source": "waveform_spectrum",
            "percussive_spike_ratio": round(percussive_spike_ratio, 3),
            "hf_burst_ratio": round(hf_burst_ratio, 4),
            "sub_bass_ratio": round(sub_bass_ratio, 4),
            "spectral_flatness": round(spectral_flatness, 4),
        }
    except Exception as exc:
        logger.debug("Audio content classification fallback (%s)", exc)
        return {
            "content_type": "solo_piano",
            "solo_confidence": 0.5,
            "source": "fallback",
        }


def detect_audio_source_route(
    wav_path: Path | None = None,
    stems: dict[str, Path] | None = None,
    *,
    requested_source_type: str = "auto",
    mode: str = "single_instrument",
) -> dict[str, Any]:
    """Determine whether audio should route as full_song or solo_piano transparently."""
    req = (requested_source_type or "auto").strip().lower()
    content_info = classify_audio_content(wav_path, stems)
    if req in ("full_song", "solo_piano"):
        return {
            "requested_source_type": req,
            "resolved_source_type": req,
            "auto_detected": False,
            "reason": "explicit_user_selection",
            "content_classification": content_info,
        }

    norm_mode = (mode or "").strip().lower()
    is_vocal_priority_mode = norm_mode in ("melody", "lead_melody", "vocal_melody", "piano_vocal")

    if stems and "vocals" in stems:
        vocal_rms = _wav_rms(stems["vocals"])
        accomp_rms = sum(_wav_rms(stems[k]) for k in ("other", "bass", "piano") if k in stems)
        ratio = vocal_rms / max(accomp_rms, 1e-6)
        non_vocal_rms = sum(_wav_rms(stems[k]) for k in ("other", "bass", "piano", "drums") if k in stems)
        drum_rms = _wav_rms(stems["drums"]) if "drums" in stems else 0.0
        if is_vocal_priority_mode and vocal_rms >= 0.004:
            return {
                "requested_source_type": "auto",
                "resolved_source_type": "full_song",
                "auto_detected": True,
                "vocal_rms": round(vocal_rms, 5),
                "accompaniment_rms": round(accomp_rms, 5),
                "vocal_to_accompaniment_ratio": round(ratio, 3),
                "vocal_energy_ratio": round(vocal_rms / max(vocal_rms + non_vocal_rms, 1e-6), 4),
                "non_vocal_energy_ratio": round(non_vocal_rms / max(vocal_rms + non_vocal_rms, 1e-6), 4),
                "reason": "lead_melody_vocal_stem_routed",
                "content_classification": content_info,
            }
        if vocal_rms >= 0.008 and ratio >= 0.16:
            return {
                "requested_source_type": "auto",
                "resolved_source_type": "full_song",
                "auto_detected": True,
                "vocal_rms": round(vocal_rms, 5),
                "accompaniment_rms": round(accomp_rms, 5),
                "vocal_to_accompaniment_ratio": round(ratio, 3),
                "vocal_energy_ratio": round(vocal_rms / max(vocal_rms + non_vocal_rms, 1e-6), 4),
                "non_vocal_energy_ratio": round(non_vocal_rms / max(vocal_rms + non_vocal_rms, 1e-6), 4),
                "reason": "vocal_stem_energy_detected",
                "content_classification": content_info,
            }
        if drum_rms >= 0.009:
            return {
                "requested_source_type": "auto",
                "resolved_source_type": "full_song",
                "auto_detected": True,
                "vocal_rms": round(vocal_rms, 5),
                "accompaniment_rms": round(accomp_rms, 5),
                "vocal_to_accompaniment_ratio": round(ratio, 3),
                "vocal_energy_ratio": round(vocal_rms / max(vocal_rms + non_vocal_rms, 1e-6), 4),
                "non_vocal_energy_ratio": round(non_vocal_rms / max(vocal_rms + non_vocal_rms, 1e-6), 4),
                "reason": "multi_instrument_accompaniment_detected",
                "content_classification": content_info,
            }
        return {
            "requested_source_type": "auto",
            "resolved_source_type": "solo_piano",
            "auto_detected": True,
            "vocal_rms": round(vocal_rms, 5),
            "accompaniment_rms": round(accomp_rms, 5),
            "vocal_to_accompaniment_ratio": round(ratio, 3),
            "vocal_energy_ratio": round(vocal_rms / max(vocal_rms + non_vocal_rms, 1e-6), 4),
            "non_vocal_energy_ratio": round(non_vocal_rms / max(vocal_rms + non_vocal_rms, 1e-6), 4),
            "reason": "minimal_vocal_stem_energy",
            "content_classification": content_info,
        }

    if norm_mode in ("melody", "lead_melody", "piano_vocal", "vocal_melody", "multi_instrument"):
        return {
            "requested_source_type": "auto",
            "resolved_source_type": "full_song",
            "auto_detected": True,
            "reason": f"mode_heuristic:{norm_mode}",
            "content_classification": content_info,
        }
    if content_info.get("content_type") in ("multi_instrument", "piano_with_vocals"):
        return {
            "requested_source_type": "auto",
            "resolved_source_type": "full_song",
            "auto_detected": True,
            "reason": f"waveform_heuristic:{content_info.get('content_type')}",
            "content_classification": content_info,
        }
    return {
        "requested_source_type": "auto",
        "resolved_source_type": "solo_piano",
        "auto_detected": True,
        "reason": f"mode_heuristic:{norm_mode or 'default'}",
        "content_classification": content_info,
    }
