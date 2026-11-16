import json
import logging
import subprocess
from dataclasses import dataclass
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf
from scipy import signal

from app.core.config import get_settings

logger = logging.getLogger(__name__)

ALLOWED_AUDIO_EXTENSIONS = {".mp3", ".wav", ".flac", ".m4a", ".aac", ".ogg"}
ALLOWED_VIDEO_EXTENSIONS = {".mp4", ".mov", ".webm"}
ALLOWED_EXTENSIONS = ALLOWED_AUDIO_EXTENSIONS | ALLOWED_VIDEO_EXTENSIONS

ALLOWED_MIME_PREFIXES = (
    "audio/",
    "video/",
    "application/ogg",
    "application/octet-stream",  # validated further by extension + ffprobe/soundfile
)


@dataclass
class PreprocessingProfile:
    name: str
    highpass_hz: float
    target_peak_dbfs: float
    remove_dc: bool = True


PREPROCESSING_PROFILES: dict[str, PreprocessingProfile] = {
    "general": PreprocessingProfile(name="general", highpass_hz=25.0, target_peak_dbfs=-1.0),
    "piano": PreprocessingProfile(name="piano", highpass_hz=24.0, target_peak_dbfs=-1.0),
    "vocal": PreprocessingProfile(name="vocal", highpass_hz=70.0, target_peak_dbfs=-1.0),
    "mixed": PreprocessingProfile(name="mixed", highpass_hz=25.0, target_peak_dbfs=-1.5),
}


def get_preprocessing_profile(profile: str = "general") -> PreprocessingProfile:
    return PREPROCESSING_PROFILES.get((profile or "general").lower(), PREPROCESSING_PROFILES["general"])


@dataclass
class AudioMetadata:
    duration_seconds: float
    sample_rate: int
    channels: int
    has_audio_stream: bool
    is_silent: bool = False
    profile: str = "general"
    clipping_ratio: float = 0.0


class MediaValidationError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def validate_upload_extension_and_mime(filename: str, mime_type: str | None) -> str:
    ext = Path(filename).suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise MediaValidationError(
            "UNSUPPORTED_FORMAT",
            f"Unsupported file extension '{ext}'. Supported audio: MP3, WAV, FLAC, M4A, AAC. Video: MP4, MOV, WEBM.",
        )
    if mime_type and not any(mime_type.lower().startswith(p) for p in ALLOWED_MIME_PREFIXES):
        raise MediaValidationError(
            "UNSUPPORTED_MIME",
            f"Unsupported MIME type '{mime_type}'.",
        )
    return ext


def probe_media(file_path: Path) -> AudioMetadata:
    settings = get_settings()
    ffprobe_bin = settings.FFMPEG_BINARY.replace("ffmpeg", "ffprobe") if "ffmpeg" in settings.FFMPEG_BINARY else "ffprobe"
    try:
        cmd = [
            ffprobe_bin,
            "-v",
            "quiet",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            str(file_path),
        ]
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=30, check=False)
        if res.returncode == 0 and res.stdout.strip():
            data = json.loads(res.stdout)
            streams = data.get("streams", [])
            audio_stream = next((s for s in streams if s.get("codec_type") == "audio"), None)
            if audio_stream is None:
                raise MediaValidationError("NO_AUDIO_STREAM", "The uploaded media file contains no audio stream.")
            fmt = data.get("format", {})
            duration = float(fmt.get("duration") or audio_stream.get("duration") or 0.0)
            sample_rate = int(audio_stream.get("sample_rate") or 44100)
            channels = int(audio_stream.get("channels") or 1)
            return AudioMetadata(
                duration_seconds=duration,
                sample_rate=sample_rate,
                channels=channels,
                has_audio_stream=True,
            )
    except FileNotFoundError:
        logger.warning("ffprobe binary not found; falling back to soundfile metadata inspection")
    except MediaValidationError:
        raise
    except Exception as exc:
        logger.warning("ffprobe inspection failed (%s); falling back to soundfile", exc)

    # Fallback via soundfile for WAV/FLAC/OGG
    try:
        info = sf.info(str(file_path))
        return AudioMetadata(
            duration_seconds=float(info.duration),
            sample_rate=int(info.samplerate),
            channels=int(info.channels),
            has_audio_stream=True,
        )
    except Exception as exc:
        raise MediaValidationError(
            "INVALID_MEDIA_FILE",
            f"Could not decode media file. Ensure it is a valid audio or video recording ({exc}).",
        ) from exc


def preprocess_to_wav(
    input_path: Path,
    output_wav_path: Path,
    target_sr: int = 22050,
    profile: str = "general",
) -> AudioMetadata:
    """Extract/convert audio to normalized mono WAV at target_sr using FFmpeg (or librosa fallback)."""
    settings = get_settings()
    prof = get_preprocessing_profile(profile)
    output_wav_path.parent.mkdir(parents=True, exist_ok=True)

    meta = probe_media(input_path)
    if meta.duration_seconds <= 0.1:
        raise MediaValidationError("AUDIO_TOO_SHORT", "Audio recording is too short (minimum 0.2 seconds).")
    if meta.duration_seconds > settings.MAX_AUDIO_DURATION_SECONDS:
        raise MediaValidationError(
            "AUDIO_TOO_LONG",
            f"Audio duration ({meta.duration_seconds:.1f}s) exceeds maximum allowed ({settings.MAX_AUDIO_DURATION_SECONDS}s).",
        )

    ffmpeg_succeeded = False
    try:
        cmd = [
            settings.FFMPEG_BINARY,
            "-y",
            "-i",
            str(input_path),
            "-vn",
            "-ac",
            "1",
            "-ar",
            str(target_sr),
            "-sample_fmt",
            "s16",
            str(output_wav_path),
        ]
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=180, check=False)
        if res.returncode == 0 and output_wav_path.exists() and output_wav_path.stat().st_size > 44:
            ffmpeg_succeeded = True
    except FileNotFoundError:
        logger.warning("ffmpeg binary not found; using librosa/soundfile fallback")

    if not ffmpeg_succeeded:
        y, _ = librosa.load(str(input_path), sr=target_sr, mono=True)
        sf.write(str(output_wav_path), y, target_sr, subtype="PCM_16")

    y, sr = sf.read(str(output_wav_path), dtype="float32")
    if y.ndim > 1:
        y = np.mean(y, axis=1)

    if prof.remove_dc and len(y) > 0:
        y = (y - float(np.mean(y))).astype(np.float32)

    clipping_ratio = float(np.mean(np.abs(y) >= 0.999)) if len(y) > 0 else 0.0
    rms = float(np.sqrt(np.mean(np.square(y)))) if len(y) > 0 else 0.0
    is_silent = rms < 1e-4

    # Gentle zero-phase high-pass filter per profile (e.g. 24 Hz for piano preserves A0=27.5 Hz)
    if not is_silent and prof.highpass_hz > 0 and sr > 100 and len(y) > 24:
        sos = signal.butter(2, prof.highpass_hz, btype="highpass", fs=sr, output="sos")
        y = signal.sosfiltfilt(sos, y).astype(np.float32)

    # Peak normalize to profile target dBFS (preserves dynamic range without clipping)
    target_peak = float(10.0 ** (prof.target_peak_dbfs / 20.0))
    peak = float(np.max(np.abs(y))) if len(y) > 0 else 0.0
    if peak > 1e-4:
        y = ((y / peak) * target_peak).astype(np.float32)
        sf.write(str(output_wav_path), y, sr, subtype="PCM_16")

    duration = float(len(y) / sr) if sr > 0 else meta.duration_seconds
    return AudioMetadata(
        duration_seconds=duration,
        sample_rate=sr,
        channels=1,
        has_audio_stream=True,
        is_silent=is_silent,
        profile=prof.name,
        clipping_ratio=round(clipping_ratio, 6),
    )
