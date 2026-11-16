"""Transkun automatic piano transcription provider (CPU-compatible PyTorch)."""

from __future__ import annotations

import hashlib
import importlib.resources
import io
import logging
import os
import time
from pathlib import Path
from typing import Any

import numpy as np
import pretty_midi
import soundfile as sf

from app.transcription.base import DetectedNote, TranscriptionOutput, TranscriptionProvider
from app.transcription.basic_pitch_provider import TranscriptionInferenceError

logger = logging.getLogger(__name__)


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest().upper()


def resolve_transkun_paths(
    weight_path: Path | None = None,
    conf_path: Path | None = None,
) -> tuple[Path, Path]:
    """Resolve Transkun checkpoint (.pt) and config (.conf) paths."""
    env_weight = os.environ.get("TRANSKUN_WEIGHT_PATH")
    env_conf = os.environ.get("TRANSKUN_CONF_PATH")

    if weight_path is not None:
        w_path = Path(weight_path)
    elif env_weight:
        w_path = Path(env_weight)
    else:
        try:
            ref = importlib.resources.files("transkun")
            w_path = Path(str(ref / "pretrained" / "2.0.pt"))
        except Exception as exc:
            raise TranscriptionInferenceError(
                "DEPENDENCY_MISSING",
                "Transkun package is not installed. Install with: pip install --no-deps transkun==2.0.1",
            ) from exc

    if conf_path is not None:
        c_path = Path(conf_path)
    elif env_conf:
        c_path = Path(env_conf)
    else:
        try:
            ref = importlib.resources.files("transkun")
            c_path = Path(str(ref / "pretrained" / "2.0.conf"))
        except Exception as exc:
            raise TranscriptionInferenceError(
                "DEPENDENCY_MISSING",
                "Transkun package is not installed. Install with: pip install --no-deps transkun==2.0.1",
            ) from exc

    if not w_path.exists() or not c_path.exists():
        raise TranscriptionInferenceError(
            "MODEL_NOT_FOUND",
            (
                f"Transkun checkpoint or config not found (weight={w_path}, conf={c_path}). "
                "Install transkun==2.0.1 or set TRANSKUN_WEIGHT_PATH and TRANSKUN_CONF_PATH."
            ),
        )
    return w_path, c_path


class TranskunProvider(TranscriptionProvider):
    """CPU-compatible Transkun piano transcription provider with lazy checkpoint loading."""

    name = "transkun"

    def __init__(
        self,
        *,
        weight_path: Path | None = None,
        conf_path: Path | None = None,
        device: str | None = None,
        num_threads: int | None = None,
        segment_hop_sec: float | None = None,
        segment_size_sec: float | None = None,
    ) -> None:
        self._weight_path = weight_path
        self._conf_path = conf_path
        self.device = (device or os.environ.get("TRANSKUN_DEVICE", "cpu")).strip().lower() or "cpu"
        if num_threads is not None:
            self.num_threads: int | None = max(1, int(num_threads))
        else:
            env_threads = os.environ.get("TRANSKUN_NUM_THREADS")
            self.num_threads = max(1, int(env_threads)) if env_threads and env_threads.isdigit() else min(4, os.cpu_count() or 4)
        self.segment_hop_sec = segment_hop_sec
        self.segment_size_sec = segment_size_sec

        self._model: Any = None
        self._resolved_weight: Path | None = None
        self._resolved_conf: Path | None = None
        self._checkpoint_sha256: str | None = None
        self._torch: Any = None

    def _ensure_loaded(self) -> None:
        if self._model is not None:
            return
        try:
            import moduleconf
            import torch
            import torchaudio  # noqa: F401
        except ImportError as exc:
            raise TranscriptionInferenceError(
                "DEPENDENCY_MISSING",
                (
                    f"Missing Transkun runtime dependency ({exc.name}). "
                    "Install CPU PyTorch, torchaudio, moduleconf, and transkun==2.0.1."
                ),
            ) from exc

        w_path, c_path = resolve_transkun_paths(self._weight_path, self._conf_path)
        if self.device != "cpu":
            if self.device.startswith("cuda") and not torch.cuda.is_available():
                logger.warning("TRANSKUN_DEVICE=%s requested but CUDA is unavailable; using cpu.", self.device)
                self.device = "cpu"

        if self.num_threads is not None:
            torch.set_num_threads(self.num_threads)

        try:
            conf_manager = moduleconf.parseFromFile(str(c_path))
            transkun_cls = conf_manager["Model"].module.TransKun
            conf = conf_manager["Model"].config
            checkpoint = torch.load(str(w_path), map_location=self.device, weights_only=False)
            model = transkun_cls(conf=conf).to(self.device)
            state = checkpoint.get("best_state_dict") or checkpoint.get("state_dict")
            if state is None:
                raise TranscriptionInferenceError(
                    "MODEL_NOT_FOUND",
                    f"Transkun checkpoint {w_path} does not contain 'best_state_dict' or 'state_dict'.",
                )
            model.load_state_dict(state, strict=False)
            model.eval()
        except TranscriptionInferenceError:
            raise
        except Exception as exc:
            raise TranscriptionInferenceError(
                "TRANSKUN_LOAD_FAILED",
                f"Failed to load Transkun model ({exc}).",
            ) from exc

        self._torch = torch
        self._model = model
        self._resolved_weight = w_path
        self._resolved_conf = c_path
        self._checkpoint_sha256 = _sha256_file(w_path)

    def transcribe(
        self,
        wav_path: Path,
        *,
        onset_threshold: float = 0.5,
        frame_threshold: float = 0.3,
        min_note_length_ms: float = 58.0,
        min_midi_pitch: int = 21,
        max_midi_pitch: int = 108,
        midi_program: int = 0,
        transpose_semitones: int = 0,
        concert_pitch_hz: float = 440.0,
    ) -> TranscriptionOutput:
        del onset_threshold, frame_threshold, concert_pitch_hz  # Transkun uses learned CRF thresholds

        if not Path(wav_path).exists():
            raise TranscriptionInferenceError("INVALID_AUDIO_INPUT", f"WAV file not found: {wav_path}")

        try:
            audio, sr = sf.read(str(wav_path), dtype="float32")
        except Exception as exc:
            raise TranscriptionInferenceError("INVALID_AUDIO_INPUT", f"Could not read WAV '{wav_path}': {exc}") from exc

        if audio.size == 0 or sr <= 0:
            raise TranscriptionInferenceError("INVALID_AUDIO_INPUT", f"WAV '{wav_path}' is empty or invalid.")

        if audio.ndim == 1:
            audio = audio[:, np.newaxis]

        self._ensure_loaded()
        model = self._model
        torch = self._torch
        target_sr = int(getattr(model, "fs", 44100))

        if sr != target_sr:
            try:
                import soxr

                audio = soxr.resample(audio, sr, target_sr).astype(np.float32)
            except Exception as exc:
                raise TranscriptionInferenceError(
                    "TRANSKUN_INFERENCE_FAILED",
                    f"Failed to resample audio from {sr} Hz to {target_sr} Hz: {exc}",
                ) from exc

        duration_sec = float(len(audio) / target_sr)
        t0 = time.perf_counter()
        try:
            x = torch.from_numpy(np.ascontiguousarray(audio, dtype=np.float32)).to(self.device)
            with torch.no_grad():
                raw_events = model.transcribe(
                    x,
                    stepInSecond=self.segment_hop_sec,
                    segmentSizeInSecond=self.segment_size_sec,
                    discardSecondHalf=False,
                )
        except Exception as exc:
            raise TranscriptionInferenceError(
                "TRANSKUN_INFERENCE_FAILED",
                f"Transkun CPU inference failed: {exc}",
            ) from exc
        inference_sec = round(time.perf_counter() - t0, 3)

        min_dur_sec = max(0.01, float(min_note_length_ms) / 1000.0)
        notes: list[DetectedNote] = []
        for ev in raw_events or []:
            start = float(getattr(ev, "start", 0.0))
            end = float(getattr(ev, "end", 0.0))
            if end <= start or (end - start) < min_dur_sec or start < 0.0:
                continue
            raw_pitch = int(round(float(getattr(ev, "pitch", 0)))) + int(transpose_semitones)
            if raw_pitch < min_midi_pitch or raw_pitch > max_midi_pitch:
                continue
            pitch = max(0, min(127, raw_pitch))
            vel = max(1, min(127, int(round(float(getattr(ev, "velocity", 80))))))
            # Transkun does not expose per-note probability; keep confidence=None honestly.
            notes.append(
                DetectedNote(
                    pitch_midi=pitch,
                    onset_sec=round(start, 4),
                    offset_sec=round(end, 4),
                    velocity=vel,
                    confidence=None,
                )
            )

        notes.sort(key=lambda n: (n.onset_sec, n.pitch_midi))

        pm = pretty_midi.PrettyMIDI()
        inst = pretty_midi.Instrument(program=max(0, min(127, midi_program)), name="Piano")
        for n in notes:
            inst.notes.append(
                pretty_midi.Note(
                    velocity=n.velocity,
                    pitch=n.pitch_midi,
                    start=n.onset_sec,
                    end=max(n.onset_sec + 0.02, n.offset_sec),
                )
            )
        pm.instruments.append(inst)
        buf = io.BytesIO()
        pm.write(buf)

        return TranscriptionOutput(
            engine=self.name,
            notes=notes,
            midi_bytes=buf.getvalue(),
            duration_seconds=round(duration_sec, 3),
            metadata={
                "model": "transkun-2.0",
                "checkpoint_path": str(self._resolved_weight) if self._resolved_weight else None,
                "checkpoint_sha256": self._checkpoint_sha256,
                "config_path": str(self._resolved_conf) if self._resolved_conf else None,
                "device": self.device,
                "provider": f"PyTorch ({self.device})",
                "num_threads": self.num_threads,
                "sample_rate": target_sr,
                "inference_seconds": inference_sec,
                "raw_event_count": len(raw_events or []),
            },
        )
