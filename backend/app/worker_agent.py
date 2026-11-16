"""
ScribaSheet Local Windows Worker Agent (Phase A.2).

Runs outbound HTTPS polling against the Railway-hosted FastAPI coordinator,
claims at most one job at a time, sends periodic heartbeats with lease-loss
detection, handles transient network interruptions without false failures,
and supports cooperative shutdown on Ctrl+C / SIGTERM.

Usage (from backend/):
    python -m app.worker_agent
"""

from __future__ import annotations

import logging
import os
import signal
import socket
import sys
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Protocol

import httpx

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
    midi_key: str | None = None
    musicxml_key: str | None = None
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
    """Safe Phase A handler that verifies job lifecycle without AI model execution."""

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
            metadata_json={
                "handler": "phase_a_test",
                "worker_mode": "remote_worker",
            }
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
        self.handler = handler or PhaseATestHandler()
        self._stop_event = threading.Event()
        self._active_cancel_event: threading.Event | None = None
        self._client = http_client or httpx.Client(timeout=30.0)
        self._owns_client = http_client is None

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
                    "midi_key": result.midi_key,
                    "musicxml_key": result.musicxml_key,
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
            logger.error("Job %s failed (worker_id=%s): %s", job_id, self.worker_id, exc)
            if not lease_lost.is_set() and not self._stop_event.is_set():
                try:
                    self._client.post(
                        f"{self.api_base_url}/worker/jobs/{job_id}/fail",
                        json={
                            "worker_id": self.worker_id,
                            "error_code": "WORKER_EXECUTION_ERROR",
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
