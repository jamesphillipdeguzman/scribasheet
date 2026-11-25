import json
import logging
import math
import re
import shutil
import subprocess
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any, Literal

import librosa
import numpy as np
import soundfile as sf
from scipy import signal

from app.core.config import get_settings

logger = logging.getLogger(__name__)

ALLOWED_AUDIO_EXTENSIONS = {".mp3", ".wav", ".flac", ".m4a", ".aac", ".ogg"}
ALLOWED_VIDEO_EXTENSIONS = {".mp4", ".mov", ".webm", ".mkv"}
ALLOWED_EXTENSIONS = ALLOWED_AUDIO_EXTENSIONS | ALLOWED_VIDEO_EXTENSIONS

ALLOWED_MIME_PREFIXES = (
    "audio/",
    "video/",
    "application/ogg",
    "application/octet-stream",  # validated further by extension + ffprobe/soundfile
)

_FFMPEG_TIME_RE = re.compile(r"time=(\d+):(\d+):(\d+(?:\.\d+)?)")


def _resolve_ffmpeg_binary(ffmpeg_bin: str | None = None) -> str:
    binary = (ffmpeg_bin or get_settings().FFMPEG_BINARY or "ffmpeg").strip()
    return binary or "ffmpeg"


def _resolve_ffprobe_binary(ffmpeg_bin: str | None = None) -> str:
    binary = _resolve_ffmpeg_binary(ffmpeg_bin)
    if "ffmpeg" in Path(binary).name.lower():
        return str(Path(binary).with_name(Path(binary).name.replace("ffmpeg", "ffprobe")))
    return "ffprobe"


@lru_cache(maxsize=4)
def detect_ffmpeg_capabilities(ffmpeg_bin: str | None = None) -> dict[str, Any]:
    """Inspect the configured FFmpeg binary for available audio encoders and container formats."""
    binary = _resolve_ffmpeg_binary(ffmpeg_bin)
    resolved = shutil.which(binary)
    if not resolved and Path(binary).exists():
        resolved = str(Path(binary))
    if not resolved:
        return {
            "ffmpeg_available": False,
            "encoders": frozenset(),
            "formats": frozenset(),
            "supports_mp3_lame": False,
            "supports_wav_pcm16": False,
            "supports_mkv": False,
        }

    encoders: set[str] = set()
    formats: set[str] = set()
    try:
        enc_res = subprocess.run(
            [resolved, "-hide_banner", "-encoders"],
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
        if enc_res.returncode == 0:
            for line in enc_res.stdout.splitlines():
                parts = line.strip().split()
                if len(parts) >= 2 and len(parts[0]) == 6 and parts[0][0] in ("A", "V", "S"):
                    encoders.add(parts[1].lower())
    except Exception as exc:
        logger.warning("Failed to inspect FFmpeg encoders: %s", exc)

    try:
        fmt_res = subprocess.run(
            [resolved, "-hide_banner", "-formats"],
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
        if fmt_res.returncode == 0:
            for line in fmt_res.stdout.splitlines():
                stripped = line.strip()
                if not stripped or stripped.startswith("--") or stripped.startswith("File formats"):
                    continue
                parts = stripped.split()
                if len(parts) >= 2 and any(ch in parts[0] for ch in ("D", "E")):
                    for name in parts[1].split(","):
                        if name.strip():
                            formats.add(name.strip().lower())
    except Exception as exc:
        logger.warning("Failed to inspect FFmpeg formats: %s", exc)

    frozen_encoders = frozenset(encoders)
    frozen_formats = frozenset(formats)
    return {
        "ffmpeg_available": True,
        "encoders": frozen_encoders,
        "formats": frozen_formats,
        "supports_mp3_lame": "libmp3lame" in frozen_encoders,
        "supports_wav_pcm16": "pcm_s16le" in frozen_encoders,
        "supports_mkv": "matroska" in frozen_formats,
    }


def is_supported_video_file(filename: str, mime_type: str | None = None) -> bool:
    """Return True only when the uploaded file represents a supported video container."""
    ext = Path(filename or "").suffix.lower()
    base = Path(filename or "").name.lower()
    mime = (mime_type or "").lower()
    if ext in (".mp4", ".mov", ".mkv"):
        return True
    if ext == ".webm":
        if mime.startswith("audio/") or base.startswith(("mic-recording-", "tab-audio-")):
            return False
        return True
    if mime.startswith("video/"):
        return True
    return False


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
    has_video_stream: bool = False


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
            f"Unsupported file extension '{ext}'. Supported audio: MP3, WAV, FLAC, M4A, AAC, OGG. Video: MP4, MOV, WEBM, MKV.",
        )
    if ext == ".mkv" and not detect_ffmpeg_capabilities().get("supports_mkv", False):
        raise MediaValidationError(
            "UNSUPPORTED_FORMAT",
            "MKV is not supported by the installed FFmpeg build.",
        )
    if mime_type and not any(mime_type.lower().startswith(p) for p in ALLOWED_MIME_PREFIXES):
        raise MediaValidationError(
            "UNSUPPORTED_MIME",
            f"Unsupported MIME type '{mime_type}'.",
        )
    return ext


def _parse_optional_float(value: Any) -> float | None:
    if value is None:
        return None
    if isinstance(value, str):
        cleaned = value.strip()
        if not cleaned or cleaned.upper() == "N/A":
            return None
        value = cleaned
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(parsed) or parsed <= 0:
        return None
    return parsed


def _probe_duration_via_ffmpeg_null(file_path: Path, ffmpeg_bin: str) -> float | None:
    """Decode audio to null sink to measure duration for streaming WebM recordings lacking headers."""
    try:
        res = subprocess.run(
            [ffmpeg_bin, "-v", "info", "-i", str(file_path), "-vn", "-f", "null", "-"],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
        matches = _FFMPEG_TIME_RE.findall(res.stderr or "")
        if not matches:
            return None
        hh, mm, ss = matches[-1]
        total = int(hh) * 3600 + int(mm) * 60 + float(ss)
        return total if math.isfinite(total) and total > 0 else None
    except Exception:
        return None


def probe_media(file_path: Path) -> AudioMetadata:
    settings = get_settings()
    ffmpeg_bin = _resolve_ffmpeg_binary(settings.FFMPEG_BINARY)
    ffprobe_bin = _resolve_ffprobe_binary(ffmpeg_bin)
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
            has_video = any(s.get("codec_type") == "video" for s in streams)
            if audio_stream is None:
                raise MediaValidationError("NO_AUDIO_STREAM", "The uploaded media file contains no audio stream.")
            fmt = data.get("format", {})
            duration = _parse_optional_float(fmt.get("duration")) or _parse_optional_float(
                audio_stream.get("duration")
            )
            if duration is None:
                duration = _probe_duration_via_ffmpeg_null(file_path, ffmpeg_bin)
            sample_rate = int(float(audio_stream.get("sample_rate") or 44100))
            channels = int(audio_stream.get("channels") or 1)
            return AudioMetadata(
                duration_seconds=duration or 0.0,
                sample_rate=sample_rate,
                channels=channels,
                has_audio_stream=True,
                has_video_stream=has_video,
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


def extract_audio_from_video(
    input_path: Path,
    output_path: Path,
    output_format: Literal["mp3", "wav"],
) -> AudioMetadata:
    """Extract the original audio stream from a local video file to MP3 (libmp3lame) or 16-bit PCM WAV."""
    if output_format not in ("mp3", "wav"):
        raise MediaValidationError("UNSUPPORTED_OUTPUT_FORMAT", f"Unsupported extraction format '{output_format}'.")
    if not input_path.exists() or input_path.stat().st_size == 0:
        raise MediaValidationError("EMPTY_MEDIA_FILE", "The source video file is missing or empty.")

    settings = get_settings()
    ffmpeg_bin = _resolve_ffmpeg_binary(settings.FFMPEG_BINARY)
    caps = detect_ffmpeg_capabilities(ffmpeg_bin)
    if not caps["ffmpeg_available"]:
        raise MediaValidationError(
            "FFMPEG_UNAVAILABLE",
            "FFmpeg is not installed or unavailable on this server.",
        )
    if output_format == "mp3" and not caps["supports_mp3_lame"]:
        raise MediaValidationError(
            "MP3_ENCODER_UNAVAILABLE",
            "MP3 encoding requires libmp3lame, which is unavailable in the installed FFmpeg build.",
        )

    try:
        meta = probe_media(input_path)
    except MediaValidationError as exc:
        if exc.code == "NO_AUDIO_STREAM":
            raise MediaValidationError("NO_AUDIO_STREAM", "This video file contains no audio stream to extract.") from exc
        raise

    if not meta.has_audio_stream:
        raise MediaValidationError("NO_AUDIO_STREAM", "This video file contains no audio stream to extract.")

    target_channels = 2 if meta.channels >= 2 else 1
    output_path.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        ffmpeg_bin,
        "-y",
        "-i",
        str(input_path),
        "-vn",
        "-map",
        "0:a:0",
        "-ar",
        "44100",
        "-ac",
        str(target_channels),
    ]
    if output_format == "mp3":
        cmd.extend(["-c:a", "libmp3lame", "-b:a", "192k", str(output_path)])
    else:
        cmd.extend(["-c:a", "pcm_s16le", str(output_path)])

    try:
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=300, check=False)
    except FileNotFoundError as exc:
        raise MediaValidationError("FFMPEG_UNAVAILABLE", "FFmpeg binary could not be executed.") from exc
    except subprocess.TimeoutExpired as exc:
        raise MediaValidationError("EXTRACTION_TIMEOUT", "Audio extraction timed out for this video file.") from exc

    if res.returncode != 0 or not output_path.exists() or output_path.stat().st_size == 0:
        stderr_lower = (res.stderr or "").lower()
        if "matches no streams" in stderr_lower or "does not contain any stream" in stderr_lower:
            raise MediaValidationError("NO_AUDIO_STREAM", "This video file contains no audio stream to extract.")
        if "decoder" in stderr_lower or "unsupported codec" in stderr_lower or "unknown decoder" in stderr_lower:
            raise MediaValidationError(
                "UNSUPPORTED_CODEC",
                "This video uses an unsupported audio codec that could not be decoded.",
            )
        if any(tok in stderr_lower for tok in ("invalid data", "moov atom not found", "ebml header parsing failed", "error reading header")):
            raise MediaValidationError(
                "CORRUPT_MEDIA_FILE",
                "This video file appears corrupt or incomplete and could not be decoded.",
            )
        raise MediaValidationError(
            "EXTRACTION_FAILED",
            "FFmpeg failed to extract audio from this video file. Ensure the file is valid and contains a supported audio codec.",
        )

    size = output_path.stat().st_size
    with output_path.open("rb") as f:
        header = f.read(12)
    if output_format == "wav":
        if size <= 44 or len(header) < 12 or header[:4] != b"RIFF" or header[8:12] != b"WAVE":
            raise MediaValidationError("EXTRACTION_FAILED", "Extracted WAV file failed header integrity verification.")
    else:
        has_id3 = header[:3] == b"ID3"
        has_mpeg_sync = len(header) >= 2 and header[0] == 0xFF and (header[1] & 0xE0) == 0xE0
        if size <= 128 or not (has_id3 or has_mpeg_sync):
            raise MediaValidationError("EXTRACTION_FAILED", "Extracted MP3 file failed header integrity verification.")

    return probe_media(output_path)


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
