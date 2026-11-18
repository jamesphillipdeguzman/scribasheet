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
from app.notation.analyzer import (
    estimate_key_signature,
    get_instrument_program_and_clef,
)
from app.notation.arrangement import simplify_arrangement
from app.notation.beat_tracker import track_beats_and_downbeats
from app.notation.generator import (
    _render_pdf_from_musicxml_via_musescore,
    build_score_data,
    clean_score_title,
    score_data_to_midi_bytes,
    score_data_to_musicxml,
)
from app.notation.melody import (
    extract_lead_melody,
    is_lead_melody_mode,
    normalize_transcription_mode,
)
from app.notation.omr import OMRError, process_satb_pdf
from app.notation.timing_map import build_timing_map
from app.schemas.transcription import TranscriptionSettings
from app.storage.service import sanitize_filename
from app.transcription.basic_pitch_provider import (
    TranscriptionInferenceError,
    resolve_onnx_model_path,
    verify_onnx_cpu_runtime,
)
from app.transcription.note_refiner import NoteRefinerConfig, refine_detected_notes
from app.transcription.provider_factory import (
    get_target_sample_rate_for_engine,
    get_transcription_provider,
    is_fallback_allowed,
    resolve_engine_for_instrument,
    resolve_requested_engine,
    transcribe_with_provider,
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

            # Reverse Transcription: SATB Sheet Music PDF -> OMR -> MusicXML + MIDI
            if settings.mode == "satb_pdf" or safe_name.lower().endswith(".pdf"):
                self._check_cancelled(job_id, cancel_event)
                report_progress("transcribing", 25, "Validating PDF Score", "Inspecting sheet music PDF pages.")
                try:
                    omr_res = process_satb_pdf(
                        local_source,
                        title=clean_score_title(job.get("project_title") or safe_name),
                        work_dir=tmp_path / "omr",
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
                    musescore_pdf = _render_pdf_from_musicxml_via_musescore(musicxml_str)
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
                    },
                )

            # 2. Validate audio (15%)
            self._check_cancelled(job_id, cancel_event)
            report_progress("validating", 15, "Validating Audio", "Inspecting audio stream metadata.")
            probe_media(local_source)

            # 3. Preprocess to target mono WAV (25%)
            self._check_cancelled(job_id, cancel_event)
            prep_profile_name = (
                "piano"
                if "piano" in settings.instrument.lower()
                else ("vocal" if "vocal" in settings.instrument.lower() else "general")
            )
            report_progress(
                "preprocessing",
                25,
                "Preprocessing Audio",
                f"Normalizing audio ({prep_profile_name} profile, {target_sr} Hz) to mono WAV.",
            )
            proc_meta = preprocess_to_wav(
                local_source, processed_wav, target_sr=target_sr, profile=prep_profile_name
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
            report_progress(
                "transcribing",
                60,
                "Running AI Transcription",
                f"Detecting musical notes on CPU using {requested_engine}.",
            )
            program, _ = get_instrument_program_and_clef(settings.instrument)
            exec_res = transcribe_with_provider(
                processed_wav,
                engine=requested_engine,
                allow_fallback=allow_fallback,
                provider=self._provider if requested_engine == self.requested_engine else None,
                onset_threshold=settings.onset_threshold,
                frame_threshold=settings.frame_threshold,
                min_note_length_ms=settings.min_note_length_ms,
                min_midi_pitch=settings.min_midi_pitch,
                max_midi_pitch=settings.max_midi_pitch,
                midi_program=program,
                transpose_semitones=settings.transpose_semitones,
                concert_pitch_hz=settings.concert_pitch_hz,
            )
            t_out = exec_res.output

            if not t_out.notes:
                raise TranscriptionInferenceError(
                    "NO_NOTES_DETECTED",
                    "No valid musical notes were detected in the audio recording.",
                )

            refiner_cfg = NoteRefinerConfig()
            refinement = refine_detected_notes(t_out.notes, config=refiner_cfg)
            refined_notes = refinement.notes or t_out.notes

            # 5. Extract musical notes, tempo, key, and timing (70%)
            self._check_cancelled(job_id, cancel_event)
            report_progress(
                "generating_notation",
                70,
                "Extracting Musical Notes",
                f"Detected {len(t_out.notes)} raw note events ({len(refined_notes)} refined); analyzing tempo, key, and harmony.",
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
                timing_map = build_timing_map(
                    beat_result=beat_res,
                    notes=refined_notes,
                    duration_seconds=proc_meta.duration_seconds,
                    time_signature=time_sig,
                )
                tempo_bpm = timing_map.tempo_bpm
                tempo_est = True
                tempo_diag = timing_map.provenance
            key_sig, key_est = estimate_key_signature(refined_notes, settings.key_signature)

            lead_melody_active = is_lead_melody_mode(settings.mode)
            melody_result = None
            if lead_melody_active:
                melody_result = extract_lead_melody(
                    refined_notes,
                    tempo_bpm=tempo_bpm,
                    timing_map=timing_map,
                )
                arranged_notes = melody_result.notes or refined_notes
                arrangement_detail_value = settings.arrangement_detail
                arrangement_stats: dict[str, Any] = {
                    "mode": "lead_melody",
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
            raw_detected_snapshot = [
                {
                    "pitch_midi": int(n.pitch_midi),
                    "onset_sec": round(float(n.onset_sec), 4),
                    "offset_sec": round(float(n.offset_sec), 4),
                    "velocity": int(n.velocity),
                    "confidence": float(n.confidence) if n.confidence is not None else None,
                }
                for n in t_out.notes
            ]

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
                "raw_note_count": len(t_out.notes),
                "note_count": len(arranged_notes),
                "refiner": refinement.stats,
                "arrangement_detail": arrangement_detail_value,
                "arrangement": arrangement_stats,
                "quantization": settings.quantization,
                "raw_detected_notes": raw_detected_snapshot,
                "tempo_diagnostics": tempo_diag,
                "provenance": provenance,
                "preprocessing_profile": prep_profile_name,
                "is_silent_audio": proc_meta.is_silent,
                "mode": normalize_transcription_mode(settings.mode),
                "concert_pitch_hz": settings.concert_pitch_hz,
            }
            if melody_result is not None:
                score_analysis["melody_extraction"] = melody_result.stats
                score_analysis["melody_uncertain_segments"] = melody_result.uncertain_segments

            score_data = build_score_data(
                title=clean_score_title(job.get("project_title") or safe_name),
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
                chord_source_notes=refined_notes if lead_melody_active else None,
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

            musescore_pdf = _render_pdf_from_musicxml_via_musescore(musicxml_str)
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
                    "arrangement_detail": arrangement.arrangement_detail,
                    "quantization": settings.quantization,
                    "tempo_bpm": tempo_bpm,
                    "key_signature": key_sig,
                    "time_signature": time_sig,
                },
            )


class RemoteWorkerAgent:
    def __init__(
        self,
        *,
        api_base_url: str,
        worker_token: str,
        worker_id: str | None = None,
        poll_interval_sec: float = 4.0,
        heartbeat_interval_sec: float = 20.0,
        handler: JobHandler | None = None,
        http_client: httpx.Client | None = None,
    ) -> None:
        self.api_base_url = normalize_api_base_url(api_base_url)
        self.worker_token = worker_token
        self.worker_id = worker_id or f"win-{socket.gethostname()}"
        self.poll_interval_sec = max(0.2, poll_interval_sec)
        self.heartbeat_interval_sec = max(0.2, heartbeat_interval_sec)
        self._stop_event = threading.Event()
        self._active_cancel_event: threading.Event | None = None
        self._client = http_client or httpx.Client(timeout=60.0)
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
        max_attempts: int = 3,
        retry_statuses: tuple[int, ...] = (429, 502, 503, 504),
    ) -> httpx.Response:
        """POST with bounded retry for transient Railway cold-start or network errors."""
        backoff = 1.0
        for attempt in range(1, max(1, max_attempts) + 1):
            try:
                resp = self._client.post(url, json=json_payload, headers=self._headers())
                if resp.status_code in retry_statuses and attempt < max_attempts:
                    wait_sec, backoff = self._compute_backoff(backoff, max_backoff=10.0)
                    logger.warning(
                        "Transient HTTP %s from %s (attempt %d/%d); retrying in %.1fs",
                        resp.status_code,
                        url,
                        attempt,
                        max_attempts,
                        wait_sec,
                    )
                    if self._stop_event.wait(wait_sec):
                        raise WorkerInterruptedError("Worker stopping during retry wait.")
                    continue
                return resp
            except httpx.RequestError as exc:
                if attempt >= max_attempts:
                    raise
                wait_sec, backoff = self._compute_backoff(backoff, max_backoff=10.0)
                logger.warning(
                    "Transient network error (%s) calling %s (attempt %d/%d); retrying in %.1fs",
                    type(exc).__name__,
                    url,
                    attempt,
                    max_attempts,
                    wait_sec,
                )
                if self._stop_event.wait(wait_sec):
                    raise WorkerInterruptedError("Worker stopping during retry wait.")
        raise RuntimeError("Unreachable retry state")

    def request_stop(self) -> None:
        self._stop_event.set()
        if self._active_cancel_event is not None:
            self._active_cancel_event.set()

    def _heartbeat_loop(
        self,
        job_id: str,
        job_done: threading.Event,
        lease_lost: threading.Event,
        cancel_event: threading.Event,
    ) -> None:
        while not job_done.wait(self.heartbeat_interval_sec) and not self._stop_event.is_set():
            try:
                resp = self._client.post(
                    self._url(f"/worker/jobs/{job_id}/heartbeat"),
                    json={"worker_id": self.worker_id},
                    headers=self._headers(),
                )
                if resp.status_code in (403, 409):
                    logger.warning(
                        "Heartbeat rejected for job %s (worker_id=%s, status=%s); signalling lease loss.",
                        job_id,
                        self.worker_id,
                        resp.status_code,
                    )
                    lease_lost.set()
                    cancel_event.set()
                    return
                resp.raise_for_status()
                data = resp.json()
                logger.info(
                    "Heartbeat renewed for job %s (worker_id=%s, lease_expires=%s)",
                    job_id,
                    self.worker_id,
                    data.get("lease_expires_at"),
                )
            except httpx.HTTPStatusError as exc:
                logger.warning(
                    "Heartbeat HTTP error for job %s (status=%s)",
                    job_id,
                    exc.response.status_code,
                )
            except Exception as exc:
                logger.warning("Heartbeat transient error for job %s: %s", job_id, type(exc).__name__)

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

        job_done = threading.Event()
        lease_lost = threading.Event()
        cancel_event = threading.Event()
        if self._stop_event.is_set():
            cancel_event.set()
        self._active_cancel_event = cancel_event

        hb_thread = threading.Thread(
            target=self._heartbeat_loop,
            args=(job_id, job_done, lease_lost, cancel_event),
            daemon=True,
        )
        hb_thread.start()

        def report_progress(status_str: str, progress: int, stage: str, log_line: str | None = None) -> None:
            if self._stop_event.is_set():
                raise WorkerInterruptedError(f"Worker stopping; aborting progress for job {job_id}.")
            if lease_lost.is_set():
                raise LeaseLostError(f"Aborting progress report for job {job_id}: lease lost.")
            p_resp = self._client.post(
                self._url(f"/worker/jobs/{job_id}/progress"),
                json={
                    "worker_id": self.worker_id,
                    "status": status_str,
                    "progress": progress,
                    "current_stage": stage,
                    "log_line": log_line,
                },
                headers=self._headers(),
            )
            if p_resp.status_code in (403, 409):
                lease_lost.set()
                cancel_event.set()
                raise LeaseLostError(f"Progress rejected (HTTP {p_resp.status_code}) for job {job_id}.")
            p_resp.raise_for_status()

        try:
            result = self.handler.handle(job, report_progress, cancel_event)
            if self._stop_event.is_set():
                raise WorkerInterruptedError(f"Worker interrupted before completing job {job_id}.")
            if lease_lost.is_set():
                raise LeaseLostError(f"Lease lost before completion of job {job_id}.")

            c_resp = self._post_with_retry(
                self._url(f"/worker/jobs/{job_id}/complete"),
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
            )
            if c_resp.status_code in (403, 409):
                lease_lost.set()
                cancel_event.set()
                raise LeaseLostError(f"Completion rejected (HTTP {c_resp.status_code}) for job {job_id}.")
            c_resp.raise_for_status()
            logger.info("Completed job %s (project=%s, worker_id=%s)", job_id, project_id, self.worker_id)
        except (LeaseLostError, WorkerInterruptedError) as exc:
            logger.warning("Stopped job %s without completing or failing: %s", job_id, exc)
        except httpx.RequestError as exc:
            logger.warning(
                "Transient network error during job %s (%s); leaving job for lease recovery.",
                job_id,
                type(exc).__name__,
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
            job_done.set()
            self._active_cancel_event = None
            hb_thread.join(timeout=2.0)

        return True

    def run_forever(self) -> None:
        backoff = self.poll_interval_sec
        had_connection_error = False
        handler_name = type(self.handler).__name__
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
            heartbeat_interval_sec=float(os.environ.get("WORKER_HEARTBEAT_INTERVAL_SEC", "20.0")),
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
