import logging
from dataclasses import dataclass
from pathlib import Path

from app.core.config import get_settings

logger = logging.getLogger(__name__)


@dataclass
class SeparationResult:
    available: bool
    backend: str
    stems: dict[str, Path]
    message: str


def separate_audio_stems(wav_path: Path, output_dir: Path) -> SeparationResult:
    """
    Optional source separation layer.
    Honestly reports availability; never fabricates separated stems.
    """
    settings = get_settings()
    if not settings.ENABLE_SOURCE_SEPARATION or settings.SOURCE_SEPARATION_BACKEND == "none":
        return SeparationResult(
            available=False,
            backend="none",
            stems={},
            message="Source separation is disabled or not configured; proceeding with direct transcription.",
        )

    if settings.SOURCE_SEPARATION_BACKEND == "demucs":
        try:
            import demucs.separate  # type: ignore  # noqa: F401
        except ImportError:
            logger.info("Demucs package not installed; falling back to direct transcription.")
            return SeparationResult(
                available=False,
                backend="demucs",
                stems={},
                message="Demucs is not installed in this worker environment; proceeding with direct transcription.",
            )

        output_dir.mkdir(parents=True, exist_ok=True)
        try:
            demucs.separate.main(["--two-stems", "vocals", "-o", str(output_dir), str(wav_path)])
            stems: dict[str, Path] = {}
            for stem_file in output_dir.rglob("*.wav"):
                stems[stem_file.stem] = stem_file
            if not stems:
                return SeparationResult(
                    available=False,
                    backend="demucs",
                    stems={},
                    message="Demucs completed without producing stem files; proceeding with direct transcription.",
                )
            return SeparationResult(
                available=True,
                backend="demucs",
                stems=stems,
                message=f"Generated {len(stems)} separated stems via Demucs.",
            )
        except Exception as exc:
            logger.warning("Demucs separation failed: %s", exc)
            return SeparationResult(
                available=False,
                backend="demucs",
                stems={},
                message=f"Source separation failed ({exc}); proceeding with direct transcription.",
            )

    return SeparationResult(
        available=False,
        backend=settings.SOURCE_SEPARATION_BACKEND,
        stems={},
        message="Configured source separation backend is unavailable; proceeding with direct transcription.",
    )
