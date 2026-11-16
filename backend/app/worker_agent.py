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
from urllib.parse import urlparse

import httpx

from app.audio.processor import preprocess_to_wav, probe_media
from app.notation.analyzer import (
    estimate_key_signature,
    estimate_tempo,
    get_instrument_program_and_clef,
)
from app.notation.generator import (
    build_score_data,
    score_data_to_midi_bytes,
    score_data_to_musicxml,
)
from app.schemas.transcription import TranscriptionSettings
from app.storage.service import sanitize_filename
from app.transcription.basic_pitch_provider import (
    BasicPitchProvider,
    TranscriptionInferenceError,
    resolve_onnx_model_path,
    verify_onnx_cpu_runtime,
)

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("scribasheet.worker_agent")


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
        self.api_base_url = api_base_url.rstrip("/")
        parsed = urlparse(self.api_base_url)
        self._api_origin = f"{parsed.scheme}://{parsed.netloc}" if parsed.scheme and parsed.netloc else ""
        self._client = http_client or httpx.Client(timeout=120.0)
        self._owns_client = http_client is None
        self._provider = BasicPitchProvider()

        # Fail fast if ONNX model or CPUExecutionProvider is missing
        model_path = resolve_onnx_model_path()
        verify_onnx_cpu_runtime(model_path)
        logger.info("Initialized RealTranscriptionHandler (model=%s, device=CPU)", model_path.name)

    def _check_cancelled(self, job_id: str, cancel_event: threading.Event | None) -> None:
        if cancel_event and cancel_event.is_set():
            raise LeaseLostError(f"Job {job_id} cancelled due to lease loss or shutdown.")

    def _resolve_download_url(self, raw_url: str) -> str:
        if raw_url.startswith("http://") or raw_url.startswith("https://"):
            return raw_url
        return f"{self._api_origin}{raw_url}"

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

        with tempfile.TemporaryDirectory(prefix=f"scriba_job_{job_id[:8]}_") as tmpdir:
            tmp_path = Path(tmpdir)
            local_source = tmp_path / safe_name
            processed_wav = tmp_path / "normalized_22050_mono.wav"

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
                raise TranscriptionInferenceError("EMPTY_AUDIO_FILE", "Downloaded audio file is empty.")

            # 2. Validate audio (15%)
            self._check_cancelled(job_id, cancel_event)
            report_progress("validating", 15, "Validating Audio", "Inspecting audio stream metadata.")
            probe_media(local_source)

            # 3. Preprocess to 22.05 kHz mono WAV (25%)
            self._check_cancelled(job_id, cancel_event)
            report_progress("preprocessing", 25, "Preprocessing Audio", "Normalizing audio to 22.05 kHz mono WAV.")
            proc_meta = preprocess_to_wav(local_source, processed_wav, target_sr=22050)

            # 4. Load AI model & run Basic Pitch ONNX inference (35% -> 60%)
            self._check_cancelled(job_id, cancel_event)
            report_progress("transcribing", 35, "Initializing Transcription Model", "Initializing Basic Pitch ONNX CPU runtime.")
            model_path = resolve_onnx_model_path()
            verify_onnx_cpu_runtime(model_path)

            self._check_cancelled(job_id, cancel_event)
            report_progress("transcribing", 60, "Running Basic Pitch Inference", "Detecting musical notes on CPU.")
            program, _ = get_instrument_program_and_clef(settings.instrument)
            t_out = self._provider.transcribe(
                processed_wav,
                onset_threshold=settings.onset_threshold,
                frame_threshold=settings.frame_threshold,
                min_note_length_ms=settings.min_note_length_ms,
                min_midi_pitch=settings.min_midi_pitch,
                max_midi_pitch=settings.max_midi_pitch,
                midi_program=program,
                transpose_semitones=settings.transpose_semitones,
                concert_pitch_hz=settings.concert_pitch_hz,
            )

            if not t_out.notes:
                raise TranscriptionInferenceError(
                    "NO_NOTES_DETECTED",
                    "No valid musical notes were detected in the audio recording.",
                )

            # 5. Extract musical notes, tempo, key, and timing (70%)
            self._check_cancelled(job_id, cancel_event)
            report_progress(
                "generating_notation",
                70,
                "Extracting Musical Notes",
                f"Detected {len(t_out.notes)} note events; analyzing tempo, key, and harmony.",
            )
            tempo_bpm, tempo_est = estimate_tempo(
                processed_wav, settings.tempo_mode, settings.manual_tempo_bpm
            )
            key_sig, key_est = estimate_key_signature(t_out.notes, settings.key_signature)
            time_sig = "4/4" if settings.time_signature == "auto" else settings.time_signature
            time_est = settings.time_signature == "auto"

            score_data = build_score_data(
                title=Path(safe_name).stem or "ScribaSheet Transcription",
                detected_notes=t_out.notes,
                tempo_bpm=tempo_bpm,
                tempo_estimated=tempo_est,
                time_signature=time_sig,
                time_signature_estimated=time_est,
                key_signature=key_sig,
                key_signature_estimated=key_est,
                duration_seconds=proc_meta.duration_seconds,
                instrument=settings.instrument,
                quantization=settings.quantization,
                analysis={
                    "engine": t_out.engine,
                    "model": t_out.metadata.get("model"),
                    "note_count": len(t_out.notes),
                    "is_silent_audio": proc_meta.is_silent,
                    "mode": settings.mode,
                    "concert_pitch_hz": settings.concert_pitch_hz,
                },
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
                score_json=score_data.model_dump(),
                duration_seconds=proc_meta.duration_seconds,
                metadata_json={
                    "handler": "real_basic_pitch_onnx",
                    "engine": t_out.engine,
                    "note_count": len(score_data.notes),
                    "chord_count": len(score_data.chords),
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
        self.api_base_url = api_base_url.rstrip("/")
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
                    f"{self.api_base_url}/worker/jobs/{job_id}/heartbeat",
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
            f"{self.api_base_url}/worker/jobs/claim",
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
                f"{self.api_base_url}/worker/jobs/{job_id}/progress",
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

            c_resp = self._client.post(
                f"{self.api_base_url}/worker/jobs/{job_id}/complete",
                json={
                    "worker_id": self.worker_id,
                    "is_simulated": result.is_simulated,
                    "midi_key": result.midi_key,
                    "musicxml_key": result.musicxml_key,
                    "midi_base64": result.midi_base64,
                    "musicxml_content": result.musicxml_content,
                    "score_json": result.score_json,
                    "duration_seconds": result.duration_seconds,
                    "metadata_json": result.metadata_json,
                },
                headers=self._headers(),
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
                        f"{self.api_base_url}/worker/jobs/{job_id}/fail",
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
                    if code in (401, 403):
                        logger.error("Worker authentication rejected (HTTP %s). Verify WORKER_API_TOKEN.", code)
                    else:
                        logger.warning("Coordinator HTTP %s error; retrying in %.1fs", code, backoff)
                    self._stop_event.wait(backoff)
                    backoff = min(30.0, backoff * 1.5)
                except httpx.RequestError as exc:
                    had_connection_error = True
                    logger.warning("Coordinator network error (%s); retrying in %.1fs", type(exc).__name__, backoff)
                    self._stop_event.wait(backoff)
                    backoff = min(30.0, backoff * 1.5)
                except Exception as exc:
                    had_connection_error = True
                    logger.exception("Unexpected worker loop error: %s", exc)
                    self._stop_event.wait(backoff)
                    backoff = min(30.0, backoff * 1.5)
        finally:
            if self._owns_client:
                self._client.close()
            logger.info("Worker agent stopped cleanly (worker_id=%s).", self.worker_id)


def main() -> int:
    api_url = os.environ.get("SCRIBASHEET_API_URL") or os.environ.get("RAILWAY_API_URL")
    token = os.environ.get("WORKER_API_TOKEN", "")
    if not api_url or not token:
        logger.error("SCRIBASHEET_API_URL (or RAILWAY_API_URL) and WORKER_API_TOKEN must be set.")
        return 1

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


if __name__ == "__main__":
    sys.exit(main())
