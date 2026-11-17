"""Transcription provider factory and explicit fallback policy."""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from pathlib import Path

from app.transcription.base import TranscriptionOutput, TranscriptionProvider
from app.transcription.basic_pitch_provider import (
    BasicPitchProvider,
    TranscriptionInferenceError,
)
from app.transcription.transkun_provider import TranskunProvider, resolve_transkun_paths

logger = logging.getLogger(__name__)

SUPPORTED_ENGINES = ("basic_pitch", "transkun")
DEFAULT_ENGINE = "basic_pitch"


def is_transkun_available() -> bool:
    """Return True when Transkun runtime dependencies and checkpoint files are available."""
    try:
        import moduleconf  # noqa: F401
        import torch  # noqa: F401
        import torchaudio  # noqa: F401

        resolve_transkun_paths()
        return True
    except Exception:
        return False


def resolve_engine_for_instrument(
    instrument: str = "piano",
    *,
    engine_override: str | None = None,
) -> tuple[str, bool]:
    """Resolve (requested_engine, allow_fallback) for a transcription job.

    - Explicit ``engine_override`` or ``TRANSCRIPTION_ENGINE`` env var is always respected.
    - When unset and the instrument is piano, prefer Transkun if available and allow
      fallback to Basic Pitch.
    - Other instruments preserve the existing default engine configuration.
    """
    if engine_override is not None and engine_override.strip():
        return resolve_requested_engine(engine_override), is_fallback_allowed()

    env_engine = os.environ.get("TRANSCRIPTION_ENGINE", "").strip()
    if env_engine:
        return resolve_requested_engine(env_engine), is_fallback_allowed()

    if "piano" in (instrument or "").lower() and is_transkun_available():
        env_fb = os.environ.get("TRANSCRIPTION_ALLOW_FALLBACK")
        allow_fb = True if env_fb is None else is_fallback_allowed()
        return "transkun", allow_fb

    return DEFAULT_ENGINE, is_fallback_allowed()


@dataclass
class ProviderExecutionResult:
    output: TranscriptionOutput
    requested_engine: str
    actual_engine: str
    fallback_used: bool
    fallback_reason: str | None = None
    primary_error_code: str | None = None
    primary_error_message: str | None = None


def resolve_requested_engine(engine_override: str | None = None) -> str:
    raw = (engine_override or os.environ.get("TRANSCRIPTION_ENGINE") or DEFAULT_ENGINE).strip().lower()
    if raw not in SUPPORTED_ENGINES:
        raise TranscriptionInferenceError(
            "UNSUPPORTED_ENGINE",
            f"Unsupported transcription engine '{raw}'. Supported engines: {', '.join(SUPPORTED_ENGINES)}.",
        )
    return raw


def is_fallback_allowed(allow_fallback: bool | None = None) -> bool:
    if allow_fallback is not None:
        return bool(allow_fallback)
    return os.environ.get("TRANSCRIPTION_ALLOW_FALLBACK", "false").strip().lower() in (
        "1",
        "true",
        "yes",
        "on",
    )


def get_transcription_provider(engine: str) -> TranscriptionProvider:
    normalized = resolve_requested_engine(engine)
    if normalized == "transkun":
        return TranskunProvider()
    return BasicPitchProvider()


def get_target_sample_rate_for_engine(engine: str) -> int:
    normalized = resolve_requested_engine(engine)
    return 44100 if normalized == "transkun" else 22050


def transcribe_with_provider(
    wav_path: Path,
    *,
    engine: str | None = None,
    allow_fallback: bool | None = None,
    provider: TranscriptionProvider | None = None,
    fallback_provider: TranscriptionProvider | None = None,
    onset_threshold: float = 0.5,
    frame_threshold: float = 0.3,
    min_note_length_ms: float = 58.0,
    min_midi_pitch: int = 21,
    max_midi_pitch: int = 108,
    midi_program: int = 0,
    transpose_semitones: int = 0,
    concert_pitch_hz: float = 440.0,
) -> ProviderExecutionResult:
    requested = resolve_requested_engine(engine)
    fallback_enabled = is_fallback_allowed(allow_fallback)
    primary = provider or get_transcription_provider(requested)

    call_kwargs = {
        "onset_threshold": onset_threshold,
        "frame_threshold": frame_threshold,
        "min_note_length_ms": min_note_length_ms,
        "min_midi_pitch": min_midi_pitch,
        "max_midi_pitch": max_midi_pitch,
        "midi_program": midi_program,
        "transpose_semitones": transpose_semitones,
    }
    if isinstance(primary, (BasicPitchProvider, TranskunProvider)):
        call_kwargs["concert_pitch_hz"] = concert_pitch_hz

    try:
        out = primary.transcribe(wav_path, **call_kwargs)
        return ProviderExecutionResult(
            output=out,
            requested_engine=requested,
            actual_engine=out.engine,
            fallback_used=False,
        )
    except TranscriptionInferenceError as exc:
        if not fallback_enabled or requested == "basic_pitch":
            raise
        logger.warning(
            "Primary engine '%s' failed (%s: %s); falling back to 'basic_pitch' because TRANSCRIPTION_ALLOW_FALLBACK=true.",
            requested,
            exc.code,
            exc.message,
        )
        fb = fallback_provider or BasicPitchProvider()
        fb_kwargs = {
            "onset_threshold": onset_threshold,
            "frame_threshold": frame_threshold,
            "min_note_length_ms": min_note_length_ms,
            "min_midi_pitch": min_midi_pitch,
            "max_midi_pitch": max_midi_pitch,
            "midi_program": midi_program,
            "transpose_semitones": transpose_semitones,
        }
        if isinstance(fb, BasicPitchProvider):
            fb_kwargs["concert_pitch_hz"] = concert_pitch_hz
        fb_out = fb.transcribe(wav_path, **fb_kwargs)
        return ProviderExecutionResult(
            output=fb_out,
            requested_engine=requested,
            actual_engine=fb_out.engine,
            fallback_used=True,
            fallback_reason=f"{exc.code}: {exc.message}",
            primary_error_code=exc.code,
            primary_error_message=exc.message,
        )
