"""Optional Demucs audio stem separation and source-routing utilities.

All heavy ML imports (``torch``, ``demucs``) are strictly lazy-loaded inside
worker separation functions so the Railway API never imports them at startup.
"""

from __future__ import annotations

import json
import logging
import os
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
) -> SeparationResult:
    """Separate input audio into Demucs stems (vocals, drums, bass, other).

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

    try:
        import demucs.separate  # type: ignore  # noqa: F401
    except ImportError:
        iso_python = _find_isolated_demucs_python()
        if iso_python is not None:
            output_dir.mkdir(parents=True, exist_ok=True)
            stem_out_dir = output_dir / model_name / wav_path.stem
            return _run_demucs_subprocess(
                iso_python,
                wav_path,
                stem_out_dir,
                model_name=model_name,
                device=selected_device,
                overlap=overlap,
                segment_sec=segment_sec,
                cache_dir=resolved_cache,
            )
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


def detect_audio_source_route(
    wav_path: Path | None = None,
    stems: dict[str, Path] | None = None,
    *,
    requested_source_type: str = "auto",
    mode: str = "single_instrument",
) -> dict[str, Any]:
    """Determine whether audio should route as full_song or solo_piano transparently."""
    req = (requested_source_type or "auto").strip().lower()
    if req in ("full_song", "solo_piano"):
        return {
            "requested_source_type": req,
            "resolved_source_type": req,
            "auto_detected": False,
            "reason": "explicit_user_selection",
        }

    if stems and "vocals" in stems:
        vocal_rms = _wav_rms(stems["vocals"])
        accomp_rms = sum(_wav_rms(stems[k]) for k in ("other", "bass") if k in stems)
        ratio = vocal_rms / max(accomp_rms, 1e-6)
        if vocal_rms >= 0.008 and ratio >= 0.16:
            return {
                "requested_source_type": "auto",
                "resolved_source_type": "full_song",
                "auto_detected": True,
                "vocal_rms": round(vocal_rms, 5),
                "accompaniment_rms": round(accomp_rms, 5),
                "vocal_to_accompaniment_ratio": round(ratio, 3),
                "reason": "vocal_stem_energy_detected",
            }
        return {
            "requested_source_type": "auto",
            "resolved_source_type": "solo_piano",
            "auto_detected": True,
            "vocal_rms": round(vocal_rms, 5),
            "accompaniment_rms": round(accomp_rms, 5),
            "vocal_to_accompaniment_ratio": round(ratio, 3),
            "reason": "minimal_vocal_stem_energy",
        }

    norm_mode = (mode or "").strip().lower()
    if norm_mode in ("piano_vocal", "vocal_melody", "multi_instrument"):
        return {
            "requested_source_type": "auto",
            "resolved_source_type": "full_song",
            "auto_detected": True,
            "reason": f"mode_heuristic:{norm_mode}",
        }
    return {
        "requested_source_type": "auto",
        "resolved_source_type": "solo_piano",
        "auto_detected": True,
        "reason": f"mode_heuristic:{norm_mode or 'default'}",
    }
