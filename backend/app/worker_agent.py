"""
ScribaSheet Local Windows Worker Agent (Phase B — Real AI Audio Transcription).

Runs outbound HTTPS polling against the Railway-hosted FastAPI coordinator,
claims at most one job at a time, downloads source audio to a temporary
working directory, runs CPU-based Spotify Basic Pitch ONNX inference, generates
MIDI and MusicXML via PrettyMIDI and Music21, and reports progress/completion.

Usage (from backend/):
    python -m app.worker_agent
"""

from __future__ import annotations

import base64
import logging
import os
import random
import signal
import socket
import sys
import tempfile
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import urlencode, urlparse, urlsplit, urlunsplit

import httpx

from app.audio.processor import get_preprocessing_profile, preprocess_to_wav, probe_media
from app.audio.separator import (
    classify_audio_content,
    detect_audio_source_route,
    separate_audio_stems,
)
from app.core.config import get_settings
from app.notation.analyzer import (
    detect_chords,
    estimate_key_signature,
    select_chord_source_notes,
)
from app.notation.arrangement import simplify_arrangement
from app.notation.beat_tracker import infer_time_signature_from_beats, track_beats_and_downbeats
from app.notation.generator import (
    _render_pdf_from_musicxml_via_musescore,
    build_piano_vocal_score_data,
    build_score_data,
    resolve_project_score_title,
    score_data_to_midi_bytes,
    score_data_to_musicxml,
)
from app.notation.image_preprocessing import is_supported_sheet_image_filename
from app.notation.melody import (
    extract_lead_melody,
    is_lead_melody_mode,
    normalize_transcription_mode,
)
from app.notation.omr import (
    OMRError,
    process_satb_images,
    process_satb_musicxml,
    process_satb_pdf,
)
from app.notation.piano_playability import apply_piano_playability, normalize_playability_smoothing
from app.notation.timing_map import build_timing_map
from app.schemas.score import ScoreNote
from app.schemas.transcription import TranscriptionSettings
from app.storage.service import sanitize_filename
from app.transcription.basic_pitch_provider import (
    TranscriptionInferenceError,
    resolve_onnx_model_path,
    verify_onnx_cpu_runtime,
)
from app.transcription.core_pipeline import (
    resolve_preprocessing_profile,
    transcribe_and_refine_audio,
)
from app.transcription.lyrics import LyricsTranscriptionError, transcribe_lyrics
from app.transcription.note_refiner import NoteRefinerConfig
from app.transcription.provider_factory import (
    get_target_sample_rate_for_engine,
    get_transcription_provider,
    is_fallback_allowed,
    resolve_engine_for_instrument,
    resolve_requested_engine,
)
from app.transcription.versioning import build_transcription_provenance
from app.worker_lock import WorkerSingleInstanceLock

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("scribasheet.worker_agent")


API_V1_PREFIX = "/api/v1"


def normalize_api_base_url(raw_url: str, api_prefix: str = API_V1_PREFIX) -> str:
    """Normalize SCRIBASHEET_API_URL so it always ends cleanly with /api/v1."""
    cleaned = raw_url.strip().rstrip("/")
    parsed = urlsplit(cleaned)
    prefix = "/" + api_prefix.strip("/")
    path = parsed.path.rstrip("/")

    # Collapse accidental duplicate /api/v1 suffixes
    while path.endswith(f"{prefix}{prefix}"):
        path = path[: -len(prefix)]

    if path != prefix and not path.endswith(prefix):
        path = f"{path}{prefix}" if path else prefix

    return urlunsplit((parsed.scheme, parsed.netloc, path, "", ""))


def build_coordinator_url(
    api_base_url: str,
    endpoint_or_url: str,
    query: dict[str, Any] | None = None,
) -> str:
    """Build a coordinator endpoint URL, supporting origin-only or /api/v1 base URLs and preserving query params."""
    raw = endpoint_or_url.strip()
    if raw.startswith("http://") or raw.startswith("https://"):
        if not query:
            return raw
        parts = urlsplit(raw)
        extra = urlencode(query)
        merged_query = f"{parts.query}&{extra}" if parts.query else extra
        return urlunsplit((parts.scheme, parts.netloc, parts.path, merged_query, parts.fragment))

    normalized_base = normalize_api_base_url(api_base_url)
    base_parts = urlsplit(normalized_base)
    origin = f"{base_parts.scheme}://{base_parts.netloc}" if base_parts.scheme and base_parts.netloc else ""
    base_path = base_parts.path.rstrip("/")

    rel = urlsplit(raw)
    rel_path = "/" + rel.path.lstrip("/")
    if rel_path == API_V1_PREFIX or rel_path.startswith(f"{API_V1_PREFIX}/"):
        full_path = rel_path
    else:
        full_path = f"{base_path}{rel_path}"

    merged_query = rel.query
    if query:
        extra = urlencode(query)
        merged_query = f"{merged_query}&{extra}" if merged_query else extra

    return urlunsplit((base_parts.scheme, base_parts.netloc, full_path, merged_query, rel.fragment)) if origin else (
        f"{full_path}?{merged_query}" if merged_query else full_path
    )


class LeaseLostError(Exception):
    """Raised when the worker loses its lease or job ownership during execution."""


class WorkerInterruptedError(Exception):
    """Raised when the worker receives a shutdown signal during job execution."""


@dataclass
class JobCompletionResult:
    is_simulated: bool = False
    midi_key: str | None = None
    musicxml_key: str | None = None
    midi_base64: str | None = None
    musicxml_content: str | None = None
    pdf_base64: str | None = None
    score_json: dict[str, Any] = field(default_factory=dict)
    duration_seconds: float | None = None
    metadata_json: dict[str, Any] = field(default_factory=dict)


ProgressCallback = Callable[[str, int, str, str | None], None]


class JobHandler(Protocol):
    def handle(
        self,
        job: dict[str, Any],
        report_progress: ProgressCallback,
        cancel_event: threading.Event | None = None,
    ) -> JobCompletionResult:
        ...


class PhaseATestHandler:
    """Simulated lifecycle test handler for development and automated testing only."""

    def __init__(self, test_duration_sec: float | None = None) -> None:
        if test_duration_sec is not None:
            self.test_duration_sec = max(0.1, test_duration_sec)
        else:
            self.test_duration_sec = max(0.1, float(os.environ.get("PHASE_A_TEST_DURATION_SEC", "0.1")))

    def handle(
        self,
        job: dict[str, Any],
        report_progress: ProgressCallback,
        cancel_event: threading.Event | None = None,
    ) -> JobCompletionResult:
        job_id = job["id"]
        logger.info("Executing Phase A test handler for job %s (duration=%.1fs)", job_id, self.test_duration_sec)
        report_progress("validating", 20, "Validating (Local Worker)", "Phase A worker verified job claim.")

        remaining = self.test_duration_sec
        step = 0.2
        while remaining > 0:
            if cancel_event and cancel_event.wait(min(step, remaining)):
                raise LeaseLostError(f"Job {job_id} cancelled cooperatively.")
            if not cancel_event:
                time.sleep(min(step, remaining))
            remaining -= step

        report_progress("finalizing", 90, "Finalizing (Local Worker)", "Phase A test handler completed.")
        return JobCompletionResult(
            is_simulated=True,
            metadata_json={
                "handler": "phase_a_test",
                "worker_mode": "remote_worker",
                "simulated": True,
            },
        )


class RealTranscriptionHandler:
    """CPU-compatible real AI audio transcription pipeline using Basic Pitch ONNX."""

    def __init__(
        self,
        *,
        api_base_url: str,
        http_client: httpx.Client | None = None,
    ) -> None:
        self.api_base_url = normalize_api_base_url(api_base_url)
        parsed = urlparse(self.api_base_url)
        self._api_origin = f"{parsed.scheme}://{parsed.netloc}" if parsed.scheme and parsed.netloc else ""
        self._client = http_client or httpx.Client(timeout=120.0)
        self._owns_client = http_client is None
        self.requested_engine = resolve_requested_engine()
        self.allow_fallback = is_fallback_allowed()
        self._provider = get_transcription_provider(self.requested_engine)

        if self.requested_engine == "basic_pitch" or self.allow_fallback:
            model_path = resolve_onnx_model_path()
            verify_onnx_cpu_runtime(model_path)
            bp_info = model_path.name
        else:
            bp_info = "not-initialized"

        device = getattr(self._provider, "device", "cpu").upper()
        logger.info(
            "Initialized RealTranscriptionHandler (engine=%s, model=%s, device=%s, allow_fallback=%s)",
            self.requested_engine,
            "transkun-2.0" if self.requested_engine == "transkun" else bp_info,
            device,
            self.allow_fallback,
        )

    def _check_cancelled(self, job_id: str, cancel_event: threading.Event | None) -> None:
        if cancel_event and cancel_event.is_set():
            raise LeaseLostError(f"Job {job_id} cancelled due to lease loss or shutdown.")

    def _resolve_download_url(self, raw_url: str) -> str:
        return build_coordinator_url(self.api_base_url, raw_url)

    def handle(
        self,
        job: dict[str, Any],
        report_progress: ProgressCallback,
        cancel_event: threading.Event | None = None,
    ) -> JobCompletionResult:
        job_id = job["id"]
        source_url = job.get("source_download_url")
        if not source_url:
            raise TranscriptionInferenceError("MISSING_SOURCE_AUDIO", "Job has no source_download_url.")

        settings = TranscriptionSettings(**(job.get("settings") or {}))
        safe_name = sanitize_filename(job.get("source_filename") or "input_audio.wav")
        job_engine_raw = job.get("engine")
        job_engine_override = job_engine_raw if job_engine_raw in ("basic_pitch", "transkun") else None
        requested_engine, allow_fallback = resolve_engine_for_instrument(
            settings.instrument,
            engine_override=job_engine_override,
        )
        target_sr = get_target_sample_rate_for_engine(requested_engine)

        with tempfile.TemporaryDirectory(prefix=f"scriba_job_{job_id[:8]}_") as tmpdir:
            tmp_path = Path(tmpdir)
            local_source = tmp_path / safe_name
            processed_wav = tmp_path / f"normalized_{target_sr}_mono.wav"

            # 1. Download source audio (5%)
            self._check_cancelled(job_id, cancel_event)
            report_progress("validating", 5, "Downloading Source Audio", "Retrieving source media from storage.")
            full_url = self._resolve_download_url(source_url)
            with self._client.stream("GET", full_url) as dl_resp:
                dl_resp.raise_for_status()
                with local_source.open("wb") as f:
                    for chunk in dl_resp.iter_bytes(chunk_size=65536):
                        self._check_cancelled(job_id, cancel_event)
                        if chunk:
                            f.write(chunk)

            if not local_source.exists() or local_source.stat().st_size == 0:
                raise TranscriptionInferenceError("EMPTY_AUDIO_FILE", "Downloaded source file is empty.")

            # Reverse Transcription: Sheet Music (MXL/MusicXML, PDF, or JPG/PNG/WebP Images) -> ScoreData + MIDI
            lower_name = safe_name.lower()
            source_pages = job.get("source_pages") or []
            is_image_score = is_supported_sheet_image_filename(safe_name) or (
                bool(source_pages)
                and any(is_supported_sheet_image_filename(p.get("filename")) for p in source_pages)
            )
            is_score_import = (
                settings.mode == "satb_pdf"
                or lower_name.endswith((".pdf", ".mxl", ".musicxml"))
                or is_image_score
            )
            if is_score_import:
                self._check_cancelled(job_id, cancel_event)
                is_direct_xml = lower_name.endswith((".mxl", ".musicxml"))
                satb_mode = getattr(settings, "satb_mode", "auto_satb") or "auto_satb"
                report_progress(
                    "transcribing",
                    20,
                    "Parsing MusicXML Score"
                    if is_direct_xml
                    else ("Validating Sheet Music Images" if is_image_score else "Validating PDF Score"),
                    "Reading MusicXML/MXL score directly."
                    if is_direct_xml
                    else (
                        "Preparing uploaded sheet music images for OMR."
                        if is_image_score
                        else "Inspecting sheet music PDF pages."
                    ),
                )
                try:
                    score_title = resolve_project_score_title(job.get("project_title"))
                    if is_direct_xml:
                        omr_res = process_satb_musicxml(
                            local_source,
                            title=score_title,
                            satb_mode=satb_mode,
                        )
                    elif is_image_score:
                        image_inputs: list[Path] = []
                        image_labels: list[str] = []
                        if source_pages:
                            pages_in_dir = tmp_path / "pages_in"
                            pages_in_dir.mkdir(parents=True, exist_ok=True)
                            for p_idx, p_meta in enumerate(source_pages, start=1):
                                self._check_cancelled(job_id, cancel_event)
                                raw_p_name = sanitize_filename(p_meta.get("filename") or f"page_{p_idx:03d}.png")
                                p_ext = Path(raw_p_name).suffix.lower() or ".png"
                                p_local = pages_in_dir / f"page_{p_idx:03d}{p_ext}"
                                p_url = p_meta.get("download_url")
                                if p_idx == 1 and (not p_url or p_url == source_url):
                                    p_local.write_bytes(local_source.read_bytes())
                                elif p_url:
                                    dl_page_url = self._resolve_download_url(str(p_url))
                                    with self._client.stream("GET", dl_page_url) as p_resp:
                                        p_resp.raise_for_status()
                                        with p_local.open("wb") as pf:
                                            for chunk in p_resp.iter_bytes(chunk_size=65536):
                                                self._check_cancelled(job_id, cancel_event)
                                                if chunk:
                                                    pf.write(chunk)
                                image_inputs.append(p_local)
                                image_labels.append(raw_p_name)
                        else:
                            image_inputs = [local_source]
                            image_labels = [safe_name]

                        omr_res = process_satb_images(
                            image_inputs,
                            title=score_title,
                            work_dir=tmp_path / "omr",
                            satb_mode=satb_mode,
                            page_filenames=image_labels,
                            progress_callback=lambda pct, stg, msg: report_progress("transcribing", pct, stg, msg),
                            cancel_check=lambda: self._check_cancelled(job_id, cancel_event),
                        )
                    else:
                        omr_res = process_satb_pdf(
                            local_source,
                            title=score_title,
                            work_dir=tmp_path / "omr",
                            satb_mode=satb_mode,
                        )
                except OMRError as exc:
                    raise TranscriptionInferenceError(exc.code, exc.message) from exc

                self._check_cancelled(job_id, cancel_event)
                report_progress("generating_notation", 75, "Building SATB Score", "Extracting SATB voices and MIDI.")
                score_data = omr_res.score_data
                musicxml_str = omr_res.musicxml
                midi_bytes = score_data_to_midi_bytes(score_data)
                pdf_b64: str | None = None
                try:
                    musescore_pdf = _render_pdf_from_musicxml_via_musescore(musicxml_str, title=score_data.title)
                    if musescore_pdf is not None:
                        pdf_b64 = base64.b64encode(musescore_pdf).decode("ascii")
                except Exception as pdf_exc:
                    logger.warning("MuseScore PDF export skipped for SATB job %s: %s", job_id, pdf_exc)

                artifact_urls = job.get("artifact_upload_urls") or {}
                midi_key: str | None = None
                xml_key: str | None = None
                midi_b64: str | None = None
                xml_inline: str | None = None
                if "midi" in artifact_urls and "musicxml" in artifact_urls:
                    m_target = artifact_urls["midi"]
                    x_target = artifact_urls["musicxml"]
                    self._client.put(m_target["url"], content=midi_bytes, headers={"Content-Type": "audio/midi"}).raise_for_status()
                    self._client.put(
                        x_target["url"],
                        content=musicxml_str.encode("utf-8"),
                        headers={"Content-Type": "application/vnd.recordare.musicxml+xml"},
                    ).raise_for_status()
                    midi_key = m_target["key"]
                    xml_key = x_target["key"]
                else:
                    midi_b64 = base64.b64encode(midi_bytes).decode("ascii")
                    xml_inline = musicxml_str

                return JobCompletionResult(
                    is_simulated=False,
                    midi_key=midi_key,
                    musicxml_key=xml_key,
                    midi_base64=midi_b64,
                    musicxml_content=xml_inline,
                    pdf_base64=pdf_b64,
                    score_json=score_data.model_dump(),
                    duration_seconds=score_data.duration_seconds,
                    metadata_json={
                        "handler": "real_omr_homr",
                        "engine": "homr",
                        "requested_engine": "homr",
                        "actual_engine": "homr",
                        "page_count": omr_res.page_count,
                        "needs_review": omr_res.needs_review,
                        "warnings": omr_res.warnings,
                        "note_count": len(score_data.notes),
                        "tempo_bpm": score_data.tempo_bpm,
                        "key_signature": score_data.key_signature,
                        "time_signature": score_data.time_signature,
                        "branding_version": "scribasheet_v2",
                    },
                )

            # 2. Validate audio (15%)
            self._check_cancelled(job_id, cancel_event)
            report_progress("validating", 15, "Validating Audio", "Inspecting audio stream metadata.")
            probe_meta = probe_media(local_source)

            if settings.mode == "lyrics_transcription":
                self._check_cancelled(job_id, cancel_event)
                report_progress(
                    "preprocessing",
                    25,
                    "Preparing Audio for Lyrics",
                    "Normalizing audio to 16 kHz mono WAV for lyrics recognition.",
                )
                lyrics_wav = tmp_path / "lyrics_input.wav"
                proc_lyrics = preprocess_to_wav(local_source, lyrics_wav, target_sr=16000, profile="vocals")
                target_audio = lyrics_wav
                source_used: str = "original_audio"
                demucs_fallback_used = False

                if settings.enable_source_separation:
                    self._check_cancelled(job_id, cancel_event)
                    report_progress(
                        "separating",
                        40,
                        "Separating Vocal Stem",
                        "Isolating vocals with Demucs for cleaner lyrics recognition.",
                    )
                    sep_res = separate_audio_stems(
                        local_source,
                        tmp_path / "lyrics_stems",
                        enabled=True,
                        model_name=settings.demucs_model,
                        segment_sec=settings.demucs_segment_sec,
                        overlap=settings.demucs_overlap,
                    )
                    if sep_res.available and "vocals" in sep_res.stems:
                        vocals_16k = tmp_path / "lyrics_vocals_16k.wav"
                        preprocess_to_wav(sep_res.stems["vocals"], vocals_16k, target_sr=16000, profile="vocals")
                        target_audio = vocals_16k
                        source_used = "vocals_stem"
                    elif allow_fallback:
                        demucs_fallback_used = True
                        source_used = "original_audio"
                    else:
                        raise TranscriptionInferenceError(
                            sep_res.error_code or "STEM_SEPARATION_FAILED",
                            sep_res.message,
                        )

                self._check_cancelled(job_id, cancel_event)
                report_progress(
                    "transcribing",
                    70,
                    "Recognizing Sung Lyrics",
                    f"Running Whisper ({settings.whisper_model}) lyrics recognition.",
                )
                try:
                    lyrics_data = transcribe_lyrics(
                        target_audio,
                        model_name=settings.whisper_model,
                        language=settings.language,
                        source_used=source_used,  # type: ignore[arg-type]
                        demucs_requested=bool(settings.enable_source_separation),
                        demucs_fallback_used=demucs_fallback_used,
                        condition_on_previous_text=bool(
                            job.get("settings_json", {}).get("condition_on_previous_text", False)
                        ),
                    )
                except LyricsTranscriptionError as exc:
                    raise TranscriptionInferenceError(exc.code, exc.message) from exc

                return JobCompletionResult(
                    is_simulated=False,
                    duration_seconds=proc_lyrics.duration_seconds or probe_meta.duration_seconds,
                    metadata_json={
                        "handler": "lyrics_whisper",
                        "engine": "faster_whisper",
                        "lyrics": lyrics_data.model_dump(),
                    },
                )

            # 3. Preprocess to target mono WAV (25%)
            self._check_cancelled(job_id, cancel_event)
            prep_profile_name = resolve_preprocessing_profile(settings.instrument)
            report_progress(
                "preprocessing",
                25,
                "Preprocessing Audio",
                f"Normalizing audio ({prep_profile_name} profile, {target_sr} Hz) to mono WAV.",
            )
            proc_meta = preprocess_to_wav(
                local_source, processed_wav, target_sr=target_sr, profile=prep_profile_name
            )

            # 3b. Optional Demucs stem separation (30%)
            sep_res = None
            norm_mode_pre = normalize_transcription_mode(settings.mode)
            req_source_pre = (settings.audio_source_type or "auto").strip().lower()
            force_vocal_sep = is_lead_melody_mode(settings.mode) and req_source_pre != "solo_piano"
            pre_content_class = (
                classify_audio_content(processed_wav)
                if (settings.enable_source_separation and not force_vocal_sep)
                else None
            )
            skip_for_clean_solo = bool(
                not force_vocal_sep
                and settings.enable_source_separation
                and req_source_pre == "auto"
                and norm_mode_pre in ("piano", "single_instrument")
                and pre_content_class is not None
                and pre_content_class.get("content_type") == "solo_piano"
                and float(pre_content_class.get("solo_confidence", 0.0)) >= 0.80
            )
            if force_vocal_sep or (settings.enable_source_separation and not skip_for_clean_solo):
                self._check_cancelled(job_id, cancel_event)
                report_progress(
                    "separating",
                    30,
                    "Isolating Vocals Stem for Lead Melody" if force_vocal_sep else "Separating Stems",
                    (
                        f"Isolating vocals stem using Demucs ({settings.demucs_model}) for Lead Melody transcription."
                        if force_vocal_sep
                        else f"Separating vocals, bass, drums, and other instruments using Demucs ({settings.demucs_model})."
                    ),
                )
                sep_res = separate_audio_stems(
                    local_source,
                    tmp_path / "stems",
                    enabled=True,
                    model_name=settings.demucs_model,
                    segment_sec=settings.demucs_segment_sec,
                    overlap=settings.demucs_overlap,
                )
                if force_vocal_sep and (not sep_res.available or "vocals" not in sep_res.stems):
                    raise TranscriptionInferenceError(
                        "VOCAL_STEM_UNAVAILABLE",
                        sep_res.message or "Lead Melody requires an isolated vocals stem (vocals.wav), which is unavailable.",
                    )
                if not sep_res.available:
                    raise TranscriptionInferenceError(
                        sep_res.error_code or "STEM_SEPARATION_FAILED",
                        sep_res.message,
                    )
            elif skip_for_clean_solo:
                logger.info(
                    "Job %s skipped Demucs separation: clean solo piano detected (confidence=%.2f).",
                    job_id,
                    float(pre_content_class.get("solo_confidence", 0.0)),
                )

            source_route = detect_audio_source_route(
                processed_wav,
                sep_res.stems if sep_res and sep_res.available else None,
                requested_source_type=settings.audio_source_type,
                mode=settings.mode,
            )

            # 4. Load AI model & run transcription inference (35% -> 60%)
            self._check_cancelled(job_id, cancel_event)
            report_progress(
                "transcribing",
                35,
                "Initializing Transcription Model",
                f"Initializing {requested_engine} CPU runtime.",
            )
            if requested_engine == "basic_pitch":
                verify_onnx_cpu_runtime(resolve_onnx_model_path())

            self._check_cancelled(job_id, cancel_event)
            is_vocal_melody_route = bool(
                sep_res is not None
                and sep_res.available
                and "vocals" in sep_res.stems
                and (settings.audio_source_type or "auto").strip().lower() != "solo_piano"
                and (source_route.get("resolved_source_type") == "full_song" or is_lead_melody_mode(settings.mode))
            )
            report_progress(
                "transcribing",
                60,
                "Transcribing Melody" if is_vocal_melody_route else "Running AI Transcription",
                (
                    "Transcribing separated vocals, bass, and accompaniment stems (drums excluded)."
                    if is_vocal_melody_route
                    else f"Detecting musical notes on CPU using {requested_engine}."
                ),
            )
            refiner_cfg = NoteRefinerConfig()
            core_res = transcribe_and_refine_audio(
                processed_wav,
                tmp_path,
                settings=settings,
                requested_engine=requested_engine,
                allow_fallback=allow_fallback,
                target_sr=target_sr,
                prep_profile_name=prep_profile_name,
                sep_res=sep_res,
                source_route=source_route,
                custom_provider=self._provider,
                custom_provider_engine=self.requested_engine,
                refiner_cfg=refiner_cfg,
            )
            exec_res = core_res.exec_res
            t_out = exec_res.output
            refined_notes = core_res.refined_notes
            vocal_refined_notes = core_res.vocal_refined_notes
            bass_refined_notes = core_res.bass_refined_notes
            other_refined_notes = core_res.other_refined_notes
            refinement_stats = core_res.refiner_stats

            # 5. Extract musical notes, tempo, key, and timing (70%)
            self._check_cancelled(job_id, cancel_event)
            report_progress(
                "generating_notation",
                70,
                "Analyzing Harmony",
                f"Detected {len(refined_notes)} refined note events; analyzing tempo, key, and harmony.",
            )
            time_sig = "4/4" if settings.time_signature == "auto" else settings.time_signature
            time_est = settings.time_signature == "auto"
            beats_per_bar = max(1, int(time_sig.split("/")[0])) if "/" in time_sig else 4

            timing_map = None
            if settings.tempo_mode == "manual" and settings.manual_tempo_bpm is not None:
                tempo_bpm = round(float(settings.manual_tempo_bpm), 1)
                tempo_est = False
                tempo_diag = {"tempo_bpm": tempo_bpm, "tempo_estimated": False, "candidates": []}
            else:
                note_durs = [max(0.05, n.offset_sec - n.onset_sec) for n in refined_notes]
                beat_res = track_beats_and_downbeats(
                    processed_wav,
                    beats_per_measure=beats_per_bar,
                    note_durations_sec=note_durs,
                )
                time_sig, time_est, meter_diag = infer_time_signature_from_beats(
                    beat_res,
                    settings.time_signature,
                    notes=refined_notes,
                )
                timing_map = build_timing_map(
                    beat_result=beat_res,
                    notes=refined_notes,
                    duration_seconds=proc_meta.duration_seconds,
                    time_signature=time_sig,
                    meter_diag=meter_diag,
                )
                tempo_bpm = timing_map.tempo_bpm
                tempo_est = True
                tempo_diag = {**timing_map.provenance, "meter_detection": meter_diag}
            accomp_for_ctx = [*other_refined_notes, *bass_refined_notes] or None
            key_sig, key_est = estimate_key_signature(
                refined_notes,
                settings.key_signature,
                audio_path=processed_wav,
                accompaniment_notes=accomp_for_ctx,
            )

            def _serialize_note_list(note_list: list[Any]) -> list[dict[str, Any]]:
                return [
                    {
                        "pitch_midi": int(n.pitch_midi),
                        "onset_sec": round(float(n.onset_sec), 4),
                        "offset_sec": round(float(n.offset_sec), 4),
                        "velocity": int(n.velocity),
                        "confidence": float(n.confidence) if n.confidence is not None else None,
                    }
                    for n in note_list
                ]

            norm_mode = normalize_transcription_mode(settings.mode)
            lead_melody_active = is_lead_melody_mode(settings.mode)
            piano_vocal_active = norm_mode == "piano_vocal"
            sep_stems = sep_res.stems if (sep_res is not None and sep_res.available) else {}
            bass_stem_path = sep_stems.get("bass") if ("bass" in sep_stems and Path(sep_stems["bass"]).exists()) else None
            harmonic_stem_path = None
            for cand_stem in ("piano", "other"):
                if cand_stem in sep_stems and Path(sep_stems[cand_stem]).exists():
                    harmonic_stem_path = sep_stems[cand_stem]
                    break
            chord_audio_path = (
                None
                if ((lead_melody_active or piano_vocal_active) and (harmonic_stem_path is not None or bass_stem_path is not None))
                else processed_wav
            )
            melody_source_notes = vocal_refined_notes if vocal_refined_notes else refined_notes
            melody_result = None
            playability_stats: dict[str, Any] | None = None
            eff_smoothing = normalize_playability_smoothing(getattr(settings, "playability_smoothing", "standard"))

            if lead_melody_active or piano_vocal_active:
                vocal_range = None
                if piano_vocal_active or core_res.is_vocal_melody_route or (settings.instrument or "").strip().lower() == "vocals":
                    app_cfg = get_settings()
                    vocal_range = (app_cfg.VOCAL_RANGE_MIN_MIDI, app_cfg.VOCAL_RANGE_MAX_MIDI)
                melody_result = extract_lead_melody(
                    melody_source_notes,
                    tempo_bpm=tempo_bpm,
                    timing_map=timing_map,
                    vocal_range=vocal_range,
                    key_signature=key_sig,
                    accompaniment_notes=accomp_for_ctx,
                    from_monophonic_vocal_tracker=core_res.vocal_from_monophonic_tracker,
                )
                arranged_notes = melody_result.notes or melody_source_notes
                arrangement_detail_value = settings.arrangement_detail
                arrangement_stats: dict[str, Any] = {
                    "mode": norm_mode,
                    "input_note_count": len(refined_notes),
                    "output_note_count": len(arranged_notes),
                }
            else:
                arrangement = simplify_arrangement(
                    refined_notes,
                    tempo_bpm=tempo_bpm,
                    arrangement_detail=settings.arrangement_detail,
                )
                arranged_notes = arrangement.notes or refined_notes
                arrangement_detail_value = arrangement.arrangement_detail
                arrangement_stats = arrangement.stats
                if "piano" in (settings.instrument or "").lower() and eff_smoothing != "original":
                    chord_proxies = [
                        ScoreNote(
                            id=f"wcp_{idx}",
                            pitch_midi=n.pitch_midi,
                            onset_sec=max(0.0, n.onset_sec),
                            offset_sec=max(n.onset_sec + 0.02, n.offset_sec),
                            velocity=max(1, min(127, n.velocity)),
                            confidence=n.confidence,
                        )
                        for idx, n in enumerate(arranged_notes)
                    ]
                    prelim_chords = detect_chords(
                        chord_proxies,
                        tempo_bpm,
                        time_sig,
                        key_signature=key_sig,
                        timing_map=timing_map,
                        audio_path=chord_audio_path,
                        bass_stem_path=bass_stem_path,
                        harmonic_stem_path=harmonic_stem_path,
                        bass_notes=bass_refined_notes or None,
                    )
                    play_res = apply_piano_playability(
                        arranged_notes,
                        chords=prelim_chords,
                        tempo_bpm=tempo_bpm,
                        time_signature=time_sig,
                        key_signature=key_sig,
                        mode=norm_mode,
                        instrument=settings.instrument,
                        smoothing=eff_smoothing,
                    )
                    if play_res.notes:
                        arranged_notes = play_res.notes
                    playability_stats = play_res.stats

            raw_detected_snapshot = _serialize_note_list(
                vocal_refined_notes
                if (core_res.is_vocal_melody_route and vocal_refined_notes)
                else (refined_notes if core_res.is_vocal_melody_route else t_out.notes)
            )

            provenance = build_transcription_provenance(
                source_audio_path=local_source,
                preprocessing_config=get_preprocessing_profile(prep_profile_name),
                refiner_config=refiner_cfg,
                run_id=job_id,
            )

            score_analysis: dict[str, Any] = {
                "engine": t_out.engine,
                "requested_engine": exec_res.requested_engine,
                "actual_engine": exec_res.actual_engine,
                "fallback_used": exec_res.fallback_used,
                "fallback_reason": exec_res.fallback_reason,
                "model": t_out.metadata.get("model"),
                "raw_note_count": len(core_res.raw_notes),
                "note_count": len(arranged_notes),
                "refiner": refinement_stats,
                "arrangement_detail": arrangement_detail_value,
                "arrangement": arrangement_stats,
                "playability_smoothing": eff_smoothing,
                "playability": playability_stats,
                "quantization": settings.quantization,
                "raw_detected_notes": raw_detected_snapshot,
                "tempo_diagnostics": tempo_diag,
                "provenance": provenance,
                "preprocessing_profile": prep_profile_name,
                "is_silent_audio": proc_meta.is_silent,
                "mode": norm_mode,
                "audio_source_type": settings.audio_source_type,
                "source_route": source_route,
                "source_selection": core_res.source_selection,
                "enable_source_separation": bool(settings.enable_source_separation),
                "separation": {
                    "enabled": bool(settings.enable_source_separation),
                    "available": bool(sep_res and sep_res.available),
                    "backend": sep_res.backend if sep_res else "none",
                    "model_name": sep_res.model_name if sep_res else settings.demucs_model,
                    "device": sep_res.device if sep_res else "cpu",
                    "stems": sorted(sep_res.stems.keys()) if sep_res and sep_res.available else [],
                    "message": sep_res.message if sep_res else "Source separation disabled.",
                },
                "concert_pitch_hz": settings.concert_pitch_hz,
            }
            if core_res.vocal_tracking:
                score_analysis["vocal_tracking"] = core_res.vocal_tracking
            if vocal_refined_notes:
                score_analysis["vocal_detected_notes"] = _serialize_note_list(vocal_refined_notes)
            if bass_refined_notes:
                score_analysis["bass_detected_notes"] = _serialize_note_list(bass_refined_notes)
            if other_refined_notes:
                score_analysis["other_detected_notes"] = _serialize_note_list(other_refined_notes)
            if melody_result is not None:
                score_analysis["melody_extraction"] = melody_result.stats
                score_analysis["melody_uncertain_segments"] = melody_result.uncertain_segments

            if piano_vocal_active:
                self._check_cancelled(job_id, cancel_event)
                report_progress(
                    "generating_notation",
                    76,
                    "Generating Accompaniment",
                    "Generating playable piano accompaniment coordinated with melody and harmony.",
                )
                chord_source = select_chord_source_notes(
                    other_refined_notes,
                    bass_refined_notes,
                    refined_notes,
                )
                score_data = build_piano_vocal_score_data(
                    title=resolve_project_score_title(job.get("project_title")),
                    melody_notes=arranged_notes,
                    chord_source_notes=chord_source,
                    bass_notes=bass_refined_notes or None,
                    other_notes=other_refined_notes or None,
                    audio_path=chord_audio_path,
                    bass_stem_path=bass_stem_path,
                    harmonic_stem_path=harmonic_stem_path,
                    tempo_bpm=tempo_bpm,
                    tempo_estimated=tempo_est,
                    time_signature=time_sig,
                    time_signature_estimated=time_est,
                    key_signature=key_sig,
                    key_signature_estimated=key_est,
                    duration_seconds=proc_meta.duration_seconds,
                    quantization=settings.quantization,
                    arrangement_detail=settings.arrangement_detail,
                    timing_map=timing_map,
                    analysis=score_analysis,
                )
            else:
                score_data = build_score_data(
                    title=resolve_project_score_title(job.get("project_title")),
                    detected_notes=arranged_notes,
                    tempo_bpm=tempo_bpm,
                    tempo_estimated=tempo_est,
                    time_signature=time_sig,
                    time_signature_estimated=time_est,
                    key_signature=key_sig,
                    key_signature_estimated=key_est,
                    duration_seconds=proc_meta.duration_seconds,
                    instrument=settings.instrument,
                    quantization=settings.quantization,
                    timing_map=timing_map,
                    clef_override="treble" if lead_melody_active else None,
                    track_name_override="Lead Melody" if lead_melody_active else None,
                    chord_source_notes=(
                        select_chord_source_notes(other_refined_notes, bass_refined_notes, refined_notes)
                        if lead_melody_active
                        else None
                    ),
                    audio_path=chord_audio_path,
                    bass_stem_path=bass_stem_path,
                    harmonic_stem_path=harmonic_stem_path,
                    bass_notes=bass_refined_notes or None,
                    monophonic=lead_melody_active,
                    analysis=score_analysis,
                )

            # 6. Generate & validate MIDI (80%)
            self._check_cancelled(job_id, cancel_event)
            report_progress("generating_notation", 80, "Generating MIDI", "Building standard MIDI output.")
            midi_bytes = score_data_to_midi_bytes(score_data)
            if not midi_bytes or not midi_bytes.startswith(b"MThd"):
                raise TranscriptionInferenceError("MIDI_GENERATION_FAILED", "Generated MIDI output is invalid.")
            try:
                import io as _io

                import pretty_midi as _pm

                parsed_midi = _pm.PrettyMIDI(_io.BytesIO(midi_bytes))
                if sum(len(inst.notes) for inst in parsed_midi.instruments) == 0:
                    raise TranscriptionInferenceError("MIDI_GENERATION_FAILED", "Generated MIDI contains zero notes.")
            except TranscriptionInferenceError:
                raise
            except Exception as exc:
                raise TranscriptionInferenceError("MIDI_GENERATION_FAILED", f"Generated MIDI failed validation: {exc}")

            # 7. Generate & validate MusicXML (90%)
            self._check_cancelled(job_id, cancel_event)
            report_progress("generating_notation", 90, "Generating MusicXML", "Engraving MusicXML notation.")
            musicxml_str = score_data_to_musicxml(score_data)
            if "<score-partwise" not in musicxml_str:
                raise TranscriptionInferenceError("MUSICXML_GENERATION_FAILED", "Generated MusicXML is invalid.")
            try:
                import music21 as _m21

                _m21.converter.parseData(musicxml_str, format="musicxml")
            except Exception as exc:
                raise TranscriptionInferenceError("MUSICXML_GENERATION_FAILED", f"Generated MusicXML failed parsing: {exc}")

            # 8. Persist artifacts (95%)
            self._check_cancelled(job_id, cancel_event)
            report_progress("finalizing", 95, "Persisting Score", "Saving MIDI, MusicXML, and score.")

            musescore_pdf = _render_pdf_from_musicxml_via_musescore(musicxml_str, title=score_data.title)
            pdf_b64 = base64.b64encode(musescore_pdf).decode("ascii") if musescore_pdf else None

            artifact_urls = job.get("artifact_upload_urls") or {}
            midi_key: str | None = None
            xml_key: str | None = None
            midi_b64: str | None = None
            xml_inline: str | None = None

            if "midi" in artifact_urls and "musicxml" in artifact_urls:
                m_target = artifact_urls["midi"]
                x_target = artifact_urls["musicxml"]
                self._client.put(m_target["url"], content=midi_bytes, headers={"Content-Type": "audio/midi"}).raise_for_status()
                self._client.put(
                    x_target["url"],
                    content=musicxml_str.encode("utf-8"),
                    headers={"Content-Type": "application/vnd.recordare.musicxml+xml"},
                ).raise_for_status()
                midi_key = m_target["key"]
                xml_key = x_target["key"]
            else:
                midi_b64 = base64.b64encode(midi_bytes).decode("ascii")
                xml_inline = musicxml_str

            return JobCompletionResult(
                is_simulated=False,
                midi_key=midi_key,
                musicxml_key=xml_key,
                midi_base64=midi_b64,
                musicxml_content=xml_inline,
                pdf_base64=pdf_b64,
                score_json=score_data.model_dump(),
                duration_seconds=proc_meta.duration_seconds,
                metadata_json={
                    "handler": f"real_{exec_res.actual_engine}",
                    "engine": t_out.engine,
                    "requested_engine": exec_res.requested_engine,
                    "actual_engine": exec_res.actual_engine,
                    "fallback_used": exec_res.fallback_used,
                    "fallback_reason": exec_res.fallback_reason,
                    "model": t_out.metadata.get("model"),
                    "note_count": len(score_data.notes),
                    "chord_count": len(score_data.chords),
                    "arrangement_detail": arrangement_detail_value,
                    "quantization": settings.quantization,
                    "tempo_bpm": int(round(float(tempo_bpm or 120.0))),
                    "detected_tempo_bpm": round(float(tempo_bpm or 120.0), 1),
                    "key_signature": key_sig,
                    "time_signature": time_sig,
                },
            )


class TransientBackendError(RuntimeError):
    """Raised when a backend endpoint still returns a transient 5xx after bounded retries."""


class RemoteWorkerAgent:
    def __init__(
        self,
        *,
        api_base_url: str,
        worker_token: str,
        worker_id: str | None = None,
        poll_interval_sec: float = 4.0,
        heartbeat_interval_sec: float = 10.0,
        handler: JobHandler | None = None,
        http_client: httpx.Client | None = None,
    ) -> None:
        self.api_base_url = normalize_api_base_url(api_base_url)
        self.worker_token = worker_token
        self.worker_id = worker_id or f"win-{socket.gethostname()}"
        self.poll_interval_sec = max(0.2, poll_interval_sec)
        self.heartbeat_interval_sec = max(0.05, heartbeat_interval_sec)
        self._stop_event = threading.Event()
        self._heartbeat_wake = threading.Event()
        self._state_lock = threading.Lock()
        self._worker_status: str = "online"
        self._active_job_id: str | None = None
        self._active_lease_lost: threading.Event | None = None
        self._active_cancel_event: threading.Event | None = None
        self._heartbeat_thread: threading.Thread | None = None
        self._in_run_forever: bool = False
        self._client = http_client or httpx.Client(timeout=60.0)
        self._hb_client = http_client or httpx.Client(timeout=10.0)
        self._owns_client = http_client is None
        if handler is not None:
            self.handler = handler
        else:
            mode = os.environ.get("WORKER_HANDLER", "real").lower()
            if mode == "phase_a_test":
                self.handler = PhaseATestHandler()
            else:
                self.handler = RealTranscriptionHandler(
                    api_base_url=self.api_base_url,
                    http_client=self._client,
                )

    def _headers(self) -> dict[str, str]:
        return {"X-Worker-Token": self.worker_token}

    def _url(self, endpoint: str, query: dict[str, Any] | None = None) -> str:
        return build_coordinator_url(self.api_base_url, endpoint, query=query)

    @staticmethod
    def _compute_backoff(current_backoff: float, *, max_backoff: float = 45.0) -> tuple[float, float]:
        """Return (jittered_wait_seconds, next_base_backoff) bounded by max_backoff."""
        jitter = random.uniform(0.8, 1.2)
        wait_sec = min(max_backoff, max(0.2, current_backoff * jitter))
        next_backoff = min(max_backoff, max(0.2, current_backoff * 1.5))
        return wait_sec, next_backoff

    def _post_with_retry(
        self,
        url: str,
        *,
        json_payload: dict[str, Any],
        max_attempts: int = 4,
        retry_statuses: tuple[int, ...] = (429, 502, 503, 504),
        initial_backoff_sec: float = 1.0,
        job_id: str | None = None,
        client: httpx.Client | None = None,
    ) -> httpx.Response:
        """POST with bounded retry (1s/2s/4s exponential backoff) for transient Railway/network errors."""
        http_cli = client or self._client
        total_attempts = max(1, max_attempts)
        for attempt in range(1, total_attempts + 1):
            try:
                resp = http_cli.post(url, json=json_payload, headers=self._headers())
                if resp.status_code in retry_statuses:
                    if attempt < total_attempts:
                        wait_sec = initial_backoff_sec * (2 ** (attempt - 1))
                        logger.warning(
                            "Transient HTTP %s from %s (job_id=%s, attempt %d/%d); retrying in %.1fs",
                            resp.status_code,
                            url,
                            job_id,
                            attempt,
                            total_attempts,
                            wait_sec,
                        )
                        if self._stop_event.wait(wait_sec):
                            raise WorkerInterruptedError("Worker stopping during retry wait.")
                        continue
                    logger.error(
                        "HTTP %s from %s exhausted retries (job_id=%s, attempts=%d)",
                        resp.status_code,
                        url,
                        job_id,
                        total_attempts,
                    )
                return resp
            except httpx.RequestError as exc:
                if attempt >= total_attempts:
                    logger.error(
                        "Network error (%s) calling %s exhausted retries (job_id=%s, attempts=%d): %s",
                        type(exc).__name__,
                        url,
                        job_id,
                        total_attempts,
                        exc,
                    )
                    raise
                wait_sec = initial_backoff_sec * (2 ** (attempt - 1))
                logger.warning(
                    "Transient network error (%s) calling %s (job_id=%s, attempt %d/%d); retrying in %.1fs",
                    type(exc).__name__,
                    url,
                    job_id,
                    attempt,
                    total_attempts,
                    wait_sec,
                )
                if self._stop_event.wait(wait_sec):
                    raise WorkerInterruptedError("Worker stopping during retry wait.")
        raise RuntimeError("Unreachable retry state")

    def request_stop(self) -> None:
        self._stop_event.set()
        self._heartbeat_wake.set()
        with self._state_lock:
            cancel_ev = self._active_cancel_event
        if cancel_ev is not None:
            cancel_ev.set()

    def _ensure_heartbeat_thread_started(self) -> bool:
        with self._state_lock:
            if self._heartbeat_thread is not None and self._heartbeat_thread.is_alive():
                return False
            self._heartbeat_wake.clear()
            hb_thread = threading.Thread(
                target=self._background_heartbeat_loop,
                name="scriba-worker-heartbeat",
                daemon=True,
            )
            self._heartbeat_thread = hb_thread
            hb_thread.start()
            return True

    def _stop_heartbeat_thread(self, timeout: float = 3.0) -> None:
        with self._state_lock:
            hb_thread = self._heartbeat_thread
        if hb_thread is None:
            return
        self._heartbeat_wake.set()
        if hb_thread.is_alive() and hb_thread is not threading.current_thread():
            hb_thread.join(timeout=timeout)
        with self._state_lock:
            if self._heartbeat_thread is hb_thread and not hb_thread.is_alive():
                self._heartbeat_thread = None

    def _background_heartbeat_loop(self) -> None:
        while not self._stop_event.is_set():
            if self._heartbeat_wake.wait(self.heartbeat_interval_sec):
                self._heartbeat_wake.clear()
            if self._stop_event.is_set():
                return
            with self._state_lock:
                job_id = self._active_job_id
                status_val = self._worker_status
                lease_lost = self._active_lease_lost
                cancel_event = self._active_cancel_event
            if not job_id or (lease_lost is not None and lease_lost.is_set()):
                continue
            hb_url = self._url(f"/worker/jobs/{job_id}/heartbeat")
            try:
                resp = self._post_with_retry(
                    hb_url,
                    json_payload={
                        "worker_id": self.worker_id,
                        "status": status_val,
                        "active_job_id": job_id,
                    },
                    max_attempts=2,
                    initial_backoff_sec=0.5,
                    job_id=job_id,
                    client=self._hb_client,
                )
                if resp.status_code in (403, 409):
                    logger.warning(
                        "Heartbeat rejected for job %s (worker_id=%s, status=%s); signalling lease loss.",
                        job_id,
                        self.worker_id,
                        resp.status_code,
                    )
                    if lease_lost is not None:
                        lease_lost.set()
                    if cancel_event is not None:
                        cancel_event.set()
                    continue
                resp.raise_for_status()
                data = resp.json()
                logger.info(
                    "Heartbeat renewed for job %s (worker_id=%s, status=%s, lease_expires=%s)",
                    job_id,
                    self.worker_id,
                    status_val,
                    data.get("lease_expires_at"),
                )
            except WorkerInterruptedError:
                return
            except httpx.HTTPStatusError as exc:
                logger.warning(
                    "Heartbeat HTTP error for job %s at %s (status=%s)",
                    job_id,
                    hb_url,
                    exc.response.status_code,
                )
            except Exception as exc:
                logger.warning(
                    "Heartbeat transient error for job %s at %s: %s (%s)",
                    job_id,
                    hb_url,
                    type(exc).__name__,
                    exc,
                )

    def run_once(self) -> bool:
        """Poll for and process at most one job. Returns True if a job was claimed."""
        resp = self._client.post(
            self._url("/worker/jobs/claim"),
            json={"worker_id": self.worker_id},
            headers=self._headers(),
        )
        resp.raise_for_status()
        job = resp.json().get("job")
        if not job:
            return False

        job_id = job["id"]
        project_id = job.get("project_id")
        attempt = job.get("attempt_count", 1)
        logger.info(
            "Claimed job %s (project=%s, worker_id=%s, attempt=%s, lease_expires=%s)",
            job_id,
            project_id,
            self.worker_id,
            attempt,
            job.get("lease_expires_at"),
        )

        lease_lost = threading.Event()
        cancel_event = threading.Event()
        if self._stop_event.is_set():
            cancel_event.set()
        with self._state_lock:
            self._worker_status = "busy"
            self._active_job_id = job_id
            self._active_lease_lost = lease_lost
            self._active_cancel_event = cancel_event
        started_local_hb = self._ensure_heartbeat_thread_started()

        def report_progress(status_str: str, progress: int, stage: str, log_line: str | None = None) -> None:
            if self._stop_event.is_set():
                raise WorkerInterruptedError(f"Worker stopping; aborting progress for job {job_id}.")
            if lease_lost.is_set():
                raise LeaseLostError(f"Aborting progress report for job {job_id}: lease lost.")
            progress_url = self._url(f"/worker/jobs/{job_id}/progress")
            try:
                p_resp = self._post_with_retry(
                    progress_url,
                    json_payload={
                        "worker_id": self.worker_id,
                        "status": status_str,
                        "progress": progress,
                        "current_stage": stage,
                        "log_line": log_line,
                    },
                    job_id=job_id,
                )
            except httpx.RequestError as exc:
                logger.warning(
                    "Progress update failed after retries for job %s at %s (%s: %s); continuing transcription.",
                    job_id,
                    progress_url,
                    type(exc).__name__,
                    exc,
                )
                return

            if p_resp.status_code in (403, 409):
                lease_lost.set()
                cancel_event.set()
                raise LeaseLostError(f"Progress rejected (HTTP {p_resp.status_code}) for job {job_id}.")
            if p_resp.status_code >= 400:
                logger.warning(
                    "Progress update returned HTTP %s for job %s at %s; continuing transcription.",
                    p_resp.status_code,
                    job_id,
                    progress_url,
                )

        try:
            result = self.handler.handle(job, report_progress, cancel_event)
            if self._stop_event.is_set():
                raise WorkerInterruptedError(f"Worker interrupted before completing job {job_id}.")
            if lease_lost.is_set():
                raise LeaseLostError(f"Lease lost before completion of job {job_id}.")

            complete_url = self._url(f"/worker/jobs/{job_id}/complete")
            c_resp = self._post_with_retry(
                complete_url,
                json_payload={
                    "worker_id": self.worker_id,
                    "is_simulated": result.is_simulated,
                    "midi_key": result.midi_key,
                    "musicxml_key": result.musicxml_key,
                    "midi_base64": result.midi_base64,
                    "musicxml_content": result.musicxml_content,
                    "pdf_base64": result.pdf_base64,
                    "score_json": result.score_json,
                    "duration_seconds": result.duration_seconds,
                    "metadata_json": result.metadata_json,
                },
                job_id=job_id,
            )
            if c_resp.status_code in (403, 409):
                lease_lost.set()
                cancel_event.set()
                raise LeaseLostError(f"Completion rejected (HTTP {c_resp.status_code}) for job {job_id}.")
            if c_resp.status_code in (429, 502, 503, 504):
                raise TransientBackendError(
                    f"Completion failed after retries (HTTP {c_resp.status_code}) for job {job_id} at {complete_url}."
                )
            c_resp.raise_for_status()
            logger.info("Completed job %s (project=%s, worker_id=%s)", job_id, project_id, self.worker_id)
        except (LeaseLostError, WorkerInterruptedError) as exc:
            logger.warning("Stopped job %s without completing or failing: %s", job_id, exc)
        except (httpx.RequestError, TransientBackendError) as exc:
            logger.warning(
                "Transient backend error during job %s (%s: %s); leaving job for lease recovery.",
                job_id,
                type(exc).__name__,
                exc,
            )
            raise
        except Exception as exc:
            err_code = exc.code if isinstance(exc, TranscriptionInferenceError) else "WORKER_EXECUTION_ERROR"
            logger.error("Job %s failed (worker_id=%s, code=%s): %s", job_id, self.worker_id, err_code, exc)
            if not lease_lost.is_set() and not self._stop_event.is_set():
                try:
                    self._client.post(
                        self._url(f"/worker/jobs/{job_id}/fail"),
                        json={
                            "worker_id": self.worker_id,
                            "error_code": err_code,
                            "error_message": str(exc)[:1000],
                        },
                        headers=self._headers(),
                    )
                except Exception as fail_exc:
                    logger.error("Failed to report failure for job %s: %s", job_id, type(fail_exc).__name__)
        finally:
            with self._state_lock:
                self._worker_status = "online"
                self._active_job_id = None
                self._active_lease_lost = None
                self._active_cancel_event = None
            if started_local_hb and not self._in_run_forever:
                self._stop_heartbeat_thread(timeout=2.0)

        return True

    def run_forever(self) -> None:
        backoff = self.poll_interval_sec
        had_connection_error = False
        handler_name = type(self.handler).__name__
        self._in_run_forever = True
        self._ensure_heartbeat_thread_started()
        logger.info(
            "Starting ScribaSheet local worker agent (worker_id=%s, api=%s, handler=%s, poll=%.1fs, heartbeat=%.1fs)",
            self.worker_id,
            self.api_base_url,
            handler_name,
            self.poll_interval_sec,
            self.heartbeat_interval_sec,
        )
        try:
            while not self._stop_event.is_set():
                try:
                    claimed = self.run_once()
                    if had_connection_error:
                        logger.info("Coordinator connection recovered (worker_id=%s).", self.worker_id)
                        had_connection_error = False
                    backoff = self.poll_interval_sec
                    if not claimed:
                        self._stop_event.wait(self.poll_interval_sec)
                except httpx.HTTPStatusError as exc:
                    had_connection_error = True
                    code = exc.response.status_code
                    wait_sec, backoff = self._compute_backoff(backoff)
                    if code in (401, 403):
                        logger.error("Worker authentication rejected (HTTP %s). Verify WORKER_API_TOKEN.", code)
                    else:
                        logger.warning("Coordinator HTTP %s error; retrying in %.1fs", code, wait_sec)
                    self._stop_event.wait(wait_sec)
                except httpx.RequestError as exc:
                    had_connection_error = True
                    wait_sec, backoff = self._compute_backoff(backoff)
                    logger.warning("Coordinator network error (%s); retrying in %.1fs", type(exc).__name__, wait_sec)
                    self._stop_event.wait(wait_sec)
                except Exception as exc:
                    had_connection_error = True
                    wait_sec, backoff = self._compute_backoff(backoff)
                    logger.exception("Unexpected worker loop error: %s", exc)
                    self._stop_event.wait(wait_sec)
        finally:
            with self._state_lock:
                self._worker_status = "offline"
                self._active_job_id = None
                self._active_lease_lost = None
                self._active_cancel_event = None
            self._stop_heartbeat_thread(timeout=3.0)
            self._in_run_forever = False
            try:
                self._client.post(
                    self._url("/worker/offline"),
                    json={"worker_id": self.worker_id},
                    headers=self._headers(),
                    timeout=5.0,
                )
            except Exception:
                pass
            if self._owns_client:
                self._hb_client.close()
                self._client.close()
            logger.info("Worker agent stopped cleanly (worker_id=%s).", self.worker_id)


def main() -> int:
    api_url = os.environ.get("SCRIBASHEET_API_URL") or os.environ.get("RAILWAY_API_URL")
    token = os.environ.get("WORKER_API_TOKEN", "")
    if not api_url or not token:
        logger.error("SCRIBASHEET_API_URL (or RAILWAY_API_URL) and WORKER_API_TOKEN must be set.")
        return 1

    lock_name = os.environ.get("WORKER_LOCK_NAME", "Local\\ScribaSheetTranscriptionWorker")
    lock = WorkerSingleInstanceLock(lock_name=lock_name)
    if not lock.acquire():
        logger.info("Another ScribaSheet worker instance already owns lock '%s'; exiting.", lock_name)
        return 0

    try:
        agent = RemoteWorkerAgent(
            api_base_url=api_url,
            worker_token=token,
            worker_id=os.environ.get("WORKER_ID"),
            poll_interval_sec=float(os.environ.get("WORKER_POLL_INTERVAL_SEC", "4.0")),
            heartbeat_interval_sec=float(os.environ.get("WORKER_HEARTBEAT_INTERVAL_SEC", "10.0")),
        )

        def _handle_signal(signum, frame):
            logger.info("Received shutdown signal (%s), stopping cooperatively...", signum)
            agent.request_stop()

        signal.signal(signal.SIGINT, _handle_signal)
        signal.signal(signal.SIGTERM, _handle_signal)
        agent.run_forever()
        return 0
    finally:
        lock.release()


if __name__ == "__main__":
    sys.exit(main())
