"""
ScribaSheet Local Windows Worker Agent (Phase A).

Runs outbound HTTPS polling against the Railway-hosted FastAPI coordinator,
claims at most one job at a time, sends periodic heartbeats, and executes
a pluggable JobHandler.

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


@dataclass
class JobCompletionResult:
    midi_key: str | None = None
    musicxml_key: str | None = None
    score_json: dict[str, Any] = field(default_factory=dict)
    duration_seconds: float | None = None
    metadata_json: dict[str, Any] = field(default_factory=dict)


ProgressCallback = Callable[[str, int, str, str | None], None]


class JobHandler(Protocol):
    def handle(self, job: dict[str, Any], report_progress: ProgressCallback) -> JobCompletionResult:
        ...


class PhaseATestHandler:
    """Safe Phase A handler that verifies job lifecycle without AI model execution."""

    def handle(self, job: dict[str, Any], report_progress: ProgressCallback) -> JobCompletionResult:
        job_id = job["id"]
        logger.info("Executing Phase A test handler for job %s", job_id)
        report_progress("validating", 20, "Validating (Local Worker)", "Phase A worker verified job claim.")
        time.sleep(0.1)
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
        self.poll_interval_sec = max(1.0, poll_interval_sec)
        self.heartbeat_interval_sec = max(5.0, heartbeat_interval_sec)
        self.handler = handler or PhaseATestHandler()
        self._stop_event = threading.Event()
        self._client = http_client or httpx.Client(timeout=30.0)
        self._owns_client = http_client is None

    def _headers(self) -> dict[str, str]:
        return {"X-Worker-Token": self.worker_token}

    def request_stop(self) -> None:
        self._stop_event.set()

    def _heartbeat_loop(self, job_id: str, job_done: threading.Event) -> None:
        while not job_done.wait(self.heartbeat_interval_sec) and not self._stop_event.is_set():
            try:
                self._client.post(
                    f"{self.api_base_url}/worker/jobs/{job_id}/heartbeat",
                    json={"worker_id": self.worker_id},
                    headers=self._headers(),
                )
            except Exception as exc:
                logger.warning("Heartbeat failed for job %s: %s", job_id, type(exc).__name__)

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
        logger.info("Claimed job %s (project=%s)", job_id, job.get("project_id"))

        job_done = threading.Event()
        hb_thread = threading.Thread(
            target=self._heartbeat_loop,
            args=(job_id, job_done),
            daemon=True,
        )
        hb_thread.start()

        def report_progress(status_str: str, progress: int, stage: str, log_line: str | None = None) -> None:
            self._client.post(
                f"{self.api_base_url}/worker/jobs/{job_id}/progress",
                json={
                    "worker_id": self.worker_id,
                    "status": status_str,
                    "progress": progress,
                    "current_stage": stage,
                    "log_line": log_line,
                },
                headers=self._headers(),
            ).raise_for_status()

        try:
            result = self.handler.handle(job, report_progress)
            self._client.post(
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
            ).raise_for_status()
            logger.info("Completed job %s", job_id)
        except Exception as exc:
            logger.error("Job %s failed: %s", job_id, exc)
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
            hb_thread.join(timeout=2.0)

        return True

    def run_forever(self) -> None:
        backoff = self.poll_interval_sec
        logger.info(
            "Starting ScribaSheet local worker agent (worker_id=%s, api=%s)",
            self.worker_id,
            self.api_base_url,
        )
        try:
            while not self._stop_event.is_set():
                try:
                    claimed = self.run_once()
                    backoff = self.poll_interval_sec
                    if not claimed:
                        self._stop_event.wait(self.poll_interval_sec)
                except httpx.HTTPError as exc:
                    logger.warning("Coordinator connection error (%s); retrying in %.1fs", type(exc).__name__, backoff)
                    self._stop_event.wait(backoff)
                    backoff = min(30.0, backoff * 1.5)
                except Exception as exc:
                    logger.exception("Unexpected worker loop error: %s", exc)
                    self._stop_event.wait(backoff)
        finally:
            if self._owns_client:
                self._client.close()
            logger.info("Worker agent stopped cleanly.")


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
        logger.info("Received shutdown signal (%s), stopping after current operation...", signum)
        agent.request_stop()

    signal.signal(signal.SIGINT, _handle_signal)
    signal.signal(signal.SIGTERM, _handle_signal)
    agent.run_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
