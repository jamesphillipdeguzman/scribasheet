"""Automatic song lyrics recognition via faster-whisper (worker-only, lazy-loaded)."""

from __future__ import annotations

import json
import logging
import math
import os
import subprocess
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

from app.schemas.lyrics import LyricsData, LyricSegment, LyricWord

logger = logging.getLogger(__name__)


class LyricsTranscriptionError(RuntimeError):
    """Actionable lyrics recognition error."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def resolve_whisper_cache_dir(cache_dir: Path | None = None) -> Path:
    """Resolve and ensure a persistent local cache directory for Whisper models."""
    if cache_dir is not None:
        resolved = Path(cache_dir)
    elif os.environ.get("WHISPER_CACHE_DIR"):
        resolved = Path(os.environ["WHISPER_CACHE_DIR"])
    else:
        resolved = Path.home() / ".cache" / "scribasheet" / "whisper"
    resolved.mkdir(parents=True, exist_ok=True)
    return resolved


def detect_whisper_device(requested_device: str | None = None) -> tuple[str, str]:
    """Return (device, compute_type) for faster-whisper."""
    if requested_device and requested_device.strip().lower() == "cpu":
        return "cpu", "int8"
    try:
        import torch  # type: ignore

        if torch.cuda.is_available():
            return "cuda", "float16"
    except Exception:
        pass
    return "cpu", "int8"


def _find_isolated_whisper_python() -> Path | None:
    """Locate an isolated Python interpreter with faster-whisper installed."""
    env_py = os.environ.get("WHISPER_PYTHON")
    if env_py:
        p = Path(env_py)
        if p.exists():
            return p
    backend_dir = Path(__file__).resolve().parents[2]
    for rel in (
        Path(".venv_whisper/Scripts/python.exe"),
        Path(".venv_whisper/bin/python"),
        Path(".venv_demucs/Scripts/python.exe"),
        Path(".venv_demucs/bin/python"),
    ):
        cand = backend_dir / rel
        if cand.exists():
            return cand
    return None


def _logprob_to_confidence(avg_logprob: float | None) -> float | None:
    if avg_logprob is None:
        return None
    try:
        val = math.exp(float(avg_logprob))
        return round(max(0.0, min(1.0, val)), 3)
    except Exception:
        return None


def _build_lyrics_data_from_raw(
    raw_segments: list[dict[str, Any]],
    *,
    language: str | None,
    language_probability: float | None,
    model_name: str,
    device: str,
    source_used: Literal["vocals_stem", "original_audio", "manual"],
    demucs_requested: bool,
    demucs_fallback_used: bool,
) -> LyricsData:
    segments: list[LyricSegment] = []
    uncertain: list[dict[str, Any]] = []
    has_word_ts = False
    lines: list[str] = []

    for idx, seg in enumerate(raw_segments):
        text = str(seg.get("text") or "").strip()
        if not text:
            continue
        start_sec = max(0.0, float(seg.get("start_sec", 0.0)))
        end_sec = max(start_sec, float(seg.get("end_sec", start_sec)))
        seg_conf = seg.get("confidence")
        if seg_conf is None and seg.get("avg_logprob") is not None:
            seg_conf = _logprob_to_confidence(seg.get("avg_logprob"))
        no_speech = float(seg.get("no_speech_prob") or 0.0)
        needs_review = bool((seg_conf is not None and seg_conf < 0.45) or no_speech > 0.65)

        words: list[LyricWord] = []
        raw_words = seg.get("words") or []
        if isinstance(raw_words, list) and raw_words:
            has_word_ts = True
            for w in raw_words:
                w_text = str(w.get("text") or "").strip()
                if not w_text:
                    continue
                w_start = max(0.0, float(w.get("start_sec", start_sec)))
                w_end = max(w_start, float(w.get("end_sec", w_start)))
                w_conf = w.get("confidence")
                w_review = bool(w_conf is not None and float(w_conf) < 0.45)
                if w_review:
                    needs_review = True
                words.append(
                    LyricWord(
                        text=w_text,
                        start_sec=round(w_start, 3),
                        end_sec=round(w_end, 3),
                        confidence=round(float(w_conf), 3) if w_conf is not None else None,
                        needs_review=w_review,
                    )
                )

        seg_id = f"seg_{idx + 1}"
        if needs_review:
            uncertain.append(
                {
                    "segment_id": seg_id,
                    "start_sec": round(start_sec, 3),
                    "end_sec": round(end_sec, 3),
                    "confidence": seg_conf,
                    "reason": "low_confidence_or_background_interference",
                }
            )
        segments.append(
            LyricSegment(
                id=seg_id,
                text=text,
                start_sec=round(start_sec, 3),
                end_sec=round(end_sec, 3),
                confidence=round(float(seg_conf), 3) if seg_conf is not None else None,
                needs_review=needs_review,
                words=words,
            )
        )
        lines.append(text)

    return LyricsData(
        text="\n".join(lines),
        segments=segments,
        language=language,
        language_probability=round(float(language_probability), 3) if language_probability is not None else None,
        source_used=source_used,
        demucs_requested=demucs_requested,
        demucs_fallback_used=demucs_fallback_used,
        model_name=model_name,
        device=device,
        has_word_timestamps=has_word_ts,
        uncertain_segments=uncertain,
        manually_edited=False,
        updated_at=datetime.now(UTC).isoformat(),
    )


def _run_whisper_subprocess(
    python_exe: Path,
    audio_path: Path,
    *,
    model_name: str,
    language: str | None,
    device: str,
    compute_type: str,
    cache_dir: Path,
) -> dict[str, Any]:
    script = (
        "import json, math, sys\n"
        "from faster_whisper import WhisperModel\n"
        "cfg = json.loads(sys.argv[1])\n"
        "model = WhisperModel(cfg['model'], device=cfg['device'], compute_type=cfg['compute_type'], download_root=cfg['cache_dir'])\n"
        "segs_iter, info = model.transcribe(\n"
        "    cfg['audio'],\n"
        "    language=cfg['language'],\n"
        "    vad_filter=False,\n"
        "    word_timestamps=True,\n"
        "    condition_on_previous_text=True,\n"
        "    beam_size=5,\n"
        ")\n"
        "out_segs = []\n"
        "for s in segs_iter:\n"
        "    words = []\n"
        "    for w in (getattr(s, 'words', None) or []):\n"
        "        words.append({'text': getattr(w, 'word', ''), 'start_sec': float(w.start), 'end_sec': float(w.end), 'confidence': getattr(w, 'probability', None)})\n"
        "    out_segs.append({\n"
        "        'text': s.text,\n"
        "        'start_sec': float(s.start),\n"
        "        'end_sec': float(s.end),\n"
        "        'avg_logprob': getattr(s, 'avg_logprob', None),\n"
        "        'no_speech_prob': getattr(s, 'no_speech_prob', 0.0),\n"
        "        'words': words,\n"
        "    })\n"
        "print(json.dumps({'language': getattr(info, 'language', None), 'language_probability': getattr(info, 'language_probability', None), 'segments': out_segs}, ensure_ascii=False))\n"
    )
    payload = json.dumps(
        {
            "audio": str(audio_path),
            "model": model_name,
            "language": language,
            "device": device,
            "compute_type": compute_type,
            "cache_dir": str(cache_dir),
        }
    )
    proc = subprocess.run(
        [str(python_exe), "-c", script, payload],
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=900,
        check=False,
    )
    if proc.returncode != 0:
        err = (proc.stderr or proc.stdout or "Unknown Whisper subprocess error").strip()
        raise LyricsTranscriptionError("LYRICS_RECOGNITION_FAILED", f"Whisper recognition failed: {err[-400:]}")
    try:
        lines = [ln for ln in (proc.stdout or "").splitlines() if ln.strip()]
        return json.loads(lines[-1])
    except Exception as exc:
        raise LyricsTranscriptionError("LYRICS_RECOGNITION_FAILED", f"Whisper output was unreadable: {exc}") from exc


def transcribe_lyrics(
    audio_path: Path,
    *,
    model_name: str = "small",
    language: str | None = None,
    source_used: Literal["vocals_stem", "original_audio", "manual"] = "original_audio",
    demucs_requested: bool = False,
    demucs_fallback_used: bool = False,
    cache_dir: Path | None = None,
    device: str | None = None,
) -> LyricsData:
    """Recognize sung lyrics from an audio file or vocal stem using faster-whisper."""
    if not audio_path.exists():
        raise LyricsTranscriptionError("AUDIO_NOT_FOUND", f"Audio file not found for lyrics recognition: {audio_path}")

    resolved_cache = resolve_whisper_cache_dir(cache_dir)
    selected_device, compute_type = detect_whisper_device(device)
    cleaned_lang = language.strip() if isinstance(language, str) and language.strip() else None

    try:
        from faster_whisper import WhisperModel  # type: ignore

        model = WhisperModel(
            model_name,
            device=selected_device,
            compute_type=compute_type,
            download_root=str(resolved_cache),
        )
        segs_iter, info = model.transcribe(
            str(audio_path),
            language=cleaned_lang,
            vad_filter=False,
            word_timestamps=True,
            condition_on_previous_text=True,
            beam_size=5,
        )
        raw_segments: list[dict[str, Any]] = []
        for s in segs_iter:
            raw_words = []
            for w in getattr(s, "words", None) or []:
                raw_words.append(
                    {
                        "text": getattr(w, "word", ""),
                        "start_sec": float(w.start),
                        "end_sec": float(w.end),
                        "confidence": getattr(w, "probability", None),
                    }
                )
            raw_segments.append(
                {
                    "text": s.text,
                    "start_sec": float(s.start),
                    "end_sec": float(s.end),
                    "avg_logprob": getattr(s, "avg_logprob", None),
                    "no_speech_prob": getattr(s, "no_speech_prob", 0.0),
                    "words": raw_words,
                }
            )
        detected_lang = getattr(info, "language", cleaned_lang)
        lang_prob = getattr(info, "language_probability", None)
    except ImportError:
        iso_python = _find_isolated_whisper_python()
        if iso_python is None:
            raise LyricsTranscriptionError(
                "WHISPER_NOT_INSTALLED",
                "faster-whisper is not installed on this local worker. Install it in backend/.venv_demucs or backend/.venv_whisper with `pip install faster-whisper`.",
            )
        sub_res = _run_whisper_subprocess(
            iso_python,
            audio_path,
            model_name=model_name,
            language=cleaned_lang,
            device=selected_device,
            compute_type=compute_type,
            cache_dir=resolved_cache,
        )
        raw_segments = sub_res.get("segments") or []
        detected_lang = sub_res.get("language") or cleaned_lang
        lang_prob = sub_res.get("language_probability")
    except LyricsTranscriptionError:
        raise
    except Exception as exc:
        raise LyricsTranscriptionError("LYRICS_RECOGNITION_FAILED", f"Lyrics recognition failed: {exc}") from exc

    return _build_lyrics_data_from_raw(
        raw_segments,
        language=detected_lang,
        language_probability=lang_prob,
        model_name=model_name,
        device=selected_device,
        source_used=source_used,
        demucs_requested=demucs_requested,
        demucs_fallback_used=demucs_fallback_used,
    )


def _format_mmss(sec: float) -> str:
    sec = max(0.0, float(sec))
    mins = int(sec // 60)
    rem = sec - mins * 60
    return f"{mins:02d}:{rem:05.2f}"


def _format_srt_ts(sec: float) -> str:
    sec = max(0.0, float(sec))
    hrs = int(sec // 3600)
    mins = int((sec % 3600) // 60)
    secs = int(sec % 60)
    ms = int(round((sec - int(sec)) * 1000)) % 1000
    return f"{hrs:02d}:{mins:02d}:{secs:02d},{ms:03d}"


def format_lyrics_export(lyrics: LyricsData, fmt: str) -> tuple[str, str, str]:
    """Format LyricsData as plain text (.txt), timestamped text, or SubRip (.srt)."""
    norm_fmt = (fmt or "txt").strip().lower()
    if norm_fmt == "txt":
        content = lyrics.text or "\n".join(s.text for s in lyrics.segments)
        return content, "text/plain; charset=utf-8", "txt"

    if norm_fmt == "timestamped_txt":
        if lyrics.segments:
            lines = [
                f"[{_format_mmss(s.start_sec)} -> {_format_mmss(s.end_sec)}] {s.text}"
                for s in lyrics.segments
            ]
            content = "\n".join(lines)
        else:
            content = lyrics.text
        return content, "text/plain; charset=utf-8", "txt"

    if norm_fmt == "srt":
        blocks: list[str] = []
        if lyrics.segments:
            for idx, seg in enumerate(lyrics.segments, start=1):
                end_s = max(seg.start_sec + 0.1, seg.end_sec)
                blocks.append(f"{idx}\n{_format_srt_ts(seg.start_sec)} --> {_format_srt_ts(end_s)}\n{seg.text}")
        elif lyrics.text.strip():
            blocks.append(f"1\n00:00:00,000 --> 00:00:05,000\n{lyrics.text.strip()}")
        return "\n\n".join(blocks), "application/x-subrip; charset=utf-8", "srt"

    raise ValueError(f"Unsupported lyrics export format: {fmt}")
