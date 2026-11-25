"""Regression tests for background worker heartbeats, stale detection, and trimmed WAV sample-rate preservation."""

from __future__ import annotations

import io
import os
import threading
import time
import uuid
import wave
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import numpy as np
import soundfile as sf
from fastapi.testclient import TestClient
from sqlalchemy.orm import sessionmaker

from app.api.v1.worker import get_worker_availability
from app.core.config import get_settings
from app.core.security import create_access_token
from app.db.session import get_db
from app.main import app
from app.models import MediaAsset, TranscriptionJob, TranscriptionResult, WorkerNode
from app.worker_agent import JobCompletionResult, RemoteWorkerAgent


def _make_wav_bytes(sample_rate: int, channels: int, duration_sec: float = 0.5, freq: float = 440.0) -> bytes:
    frames = max(1, int(round(sample_rate * duration_sec)))
    t = np.arange(frames, dtype=np.float32) / float(sample_rate)
    mono = 0.35 * np.sin(2.0 * np.pi * freq * t)
    if channels == 1:
        audio = mono
    else:
        audio = np.stack([mono, 0.8 * mono], axis=1)
    buf = io.BytesIO()
    sf.write(buf, audio, sample_rate, format="WAV", subtype="PCM_16")
    return buf.getvalue()


def _create_threadsafe_project_and_job(
    session_factory: sessionmaker,
    worker_token: str = "hb-test-token",
) -> tuple[dict[str, str], str, str, dict[str, str]]:
    os.environ["JOB_EXECUTION_MODE"] = "remote_worker"
    os.environ["WORKER_API_TOKEN"] = worker_token
    get_settings.cache_clear()

    def _override_db():
        db = session_factory()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = _override_db
    c = TestClient(app)
    reg = c.post(
        "/api/v1/auth/register",
        json={
            "email": f"hb_{uuid.uuid4().hex[:10]}@example.com",
            "password": "StrongPassword123!",
            "display_name": "HB Tester",
        },
    )
    assert reg.status_code == 201, reg.text
    user_headers = {"Authorization": f"Bearer {reg.json()['access_token']}"}

    proj = c.post(
        "/api/v1/projects",
        headers=user_headers,
        json={"title": "Heartbeat Stress Test", "instrument": "piano", "transcription_mode": "melody"},
    )
    assert proj.status_code == 201, proj.text
    project_id = proj.json()["id"]

    wav_bytes = _make_wav_bytes(44100, 2, duration_sec=0.4)
    up = c.post(
        "/api/v1/uploads",
        headers=user_headers,
        data={"project_id": project_id},
        files={"file": ("song-44k.wav", wav_bytes, "audio/wav")},
    )
    assert up.status_code == 201, up.text
    asset_id = up.json()["id"]

    job_res = c.post(
        f"/api/v1/projects/{project_id}/transcriptions",
        headers=user_headers,
        json={"source_asset_id": asset_id},
    )
    assert job_res.status_code == 202, job_res.text
    return user_headers, project_id, job_res.json()["id"], {"X-Worker-Token": worker_token}


def test_background_heartbeat_continues_during_heavy_cpu_inference(db_session):
    session_factory = sessionmaker(autocommit=False, autoflush=False, bind=db_session.get_bind())
    try:
        user_headers, project_id, job_id, _ = _create_threadsafe_project_and_job(
            session_factory, "hb-cpu-token"
        )
        c = TestClient(app)

        heartbeat_snapshots: list[dict[str, Any]] = []
        handler_done = threading.Event()

        class HeavyCpuHandler:
            def handle(self, job: dict[str, Any], report_progress, cancel_event=None) -> JobCompletionResult:
                report_progress("transcribing", 60, "Transcribing Melody", "Running heavy CPU inference")
                # Perform real CPU-bound matrix/FFT work across ~1.0s while daemon heartbeats fire
                deadline = time.monotonic() + 0.95
                rng = np.random.default_rng(7)
                acc = 0.0
                while time.monotonic() < deadline:
                    if cancel_event and cancel_event.is_set():
                        raise RuntimeError("Cancelled unexpectedly")
                    mat = rng.standard_normal((128, 128))
                    acc += float(np.abs(np.fft.rfft(mat, axis=1)).sum())
                    # Observe live worker status via coordinator API during CPU work
                    if len(heartbeat_snapshots) < 5:
                        st = c.get("/api/v1/worker/status", headers=user_headers).json()
                        heartbeat_snapshots.append(st)
                    time.sleep(0.05)
                assert acc > 0
                handler_done.set()
                return JobCompletionResult(
                    is_simulated=True,
                    duration_seconds=0.4,
                    metadata_json={"handler": "phase_a_test", "cpu_work": True},
                )

        # Wrap TestClient to spy on heartbeat POSTs
        hb_payloads: list[dict[str, Any]] = []
        orig_post = c.post

        def _spy_post(url: str, *args, **kwargs):
            if "/heartbeat" in str(url):
                hb_payloads.append(dict(kwargs.get("json") or {}))
            return orig_post(url, *args, **kwargs)

        c.post = _spy_post  # type: ignore[method-assign]

        agent = RemoteWorkerAgent(
            api_base_url="http://testserver/api/v1",
            worker_token="hb-cpu-token",
            worker_id="win-heavy-cpu",
            poll_interval_sec=0.2,
            heartbeat_interval_sec=0.15,
            handler=HeavyCpuHandler(),
            http_client=c,  # type: ignore[arg-type]
        )
        claimed = agent.run_once()
        assert claimed is True
        assert handler_done.is_set()
        assert len(hb_payloads) >= 3, f"Expected >=3 background heartbeats during heavy CPU work, got {len(hb_payloads)}"
        assert all(p.get("worker_id") == "win-heavy-cpu" for p in hb_payloads)
        assert all(p.get("status") == "busy" for p in hb_payloads)
        assert all(p.get("active_job_id") == job_id for p in hb_payloads)

        assert any(s["status"] == "busy" and s["worker_online"] is True for s in heartbeat_snapshots)

        # Verify job completed once and worker returned to online (idle) state
        db = session_factory()
        try:
            job = db.query(TranscriptionJob).filter(TranscriptionJob.id == job_id).first()
            assert job is not None and job.status == "completed"
            assert db.query(TranscriptionResult).filter(TranscriptionResult.job_id == job_id).count() == 1
            node = db.query(WorkerNode).filter(WorkerNode.worker_id == "win-heavy-cpu").first()
            assert node is not None and node.status == "online"
            assert node.active_job_id is None
        finally:
            db.close()
    finally:
        app.dependency_overrides.clear()


def test_heartbeat_transient_network_errors_do_not_abort_or_duplicate_job():
    hb_attempts = 0
    complete_calls = 0
    fail_calls = 0
    claim_calls = 0

    def _transport(request: httpx.Request) -> httpx.Response:
        nonlocal hb_attempts, complete_calls, fail_calls, claim_calls
        path = request.url.path
        if path.endswith("/worker/jobs/claim"):
            claim_calls += 1
            if claim_calls == 1:
                return httpx.Response(
                    200,
                    json={
                        "job": {
                            "id": "job-net-resilient",
                            "project_id": "proj-net",
                            "attempt_count": 1,
                            "settings": {"instrument": "piano", "mode": "melody"},
                        }
                    },
                )
            return httpx.Response(200, json={"job": None})
        if path.endswith("/worker/jobs/job-net-resilient/heartbeat"):
            hb_attempts += 1
            if hb_attempts == 1:
                raise httpx.ReadTimeout("Simulated Railway timeout", request=request)
            if hb_attempts == 2:
                return httpx.Response(503, json={"detail": "Temporary gateway hiccup"})
            return httpx.Response(200, json={"job_id": "job-net-resilient", "lease_expires_at": "2026-11-26T00:00:00Z"})
        if path.endswith("/worker/jobs/job-net-resilient/progress"):
            return httpx.Response(200, json={"job_id": "job-net-resilient", "status": "transcribing", "progress": 50})
        if path.endswith("/worker/jobs/job-net-resilient/complete"):
            complete_calls += 1
            return httpx.Response(200, json={"job_id": "job-net-resilient", "status": "completed"})
        if path.endswith("/worker/jobs/job-net-resilient/fail"):
            fail_calls += 1
            return httpx.Response(200, json={"job_id": "job-net-resilient", "status": "failed"})
        if path.endswith("/worker/offline"):
            return httpx.Response(200, json={"status": "offline"})
        return httpx.Response(404)

    class SteadyHandler:
        def handle(self, job: dict[str, Any], report_progress, cancel_event=None) -> JobCompletionResult:
            report_progress("transcribing", 50, "Transcribing", None)
            time.sleep(1.3)
            assert cancel_event is not None and not cancel_event.is_set()
            return JobCompletionResult(is_simulated=True, metadata_json={"handler": "phase_a_test"})

    client = httpx.Client(transport=httpx.MockTransport(_transport))
    try:
        agent = RemoteWorkerAgent(
            api_base_url="https://api.example.com/api/v1",
            worker_token="tok",
            worker_id="win-net-test",
            poll_interval_sec=0.2,
            heartbeat_interval_sec=0.12,
            handler=SteadyHandler(),
            http_client=client,
        )
        assert agent.run_once() is True
        assert hb_attempts >= 3
        assert complete_calls == 1
        assert fail_calls == 0
    finally:
        client.close()


def test_worker_shutdown_cleans_up_heartbeat_thread_and_marks_offline():
    offline_calls = 0

    def _transport(request: httpx.Request) -> httpx.Response:
        nonlocal offline_calls
        path = request.url.path
        if path.endswith("/worker/jobs/claim"):
            return httpx.Response(200, json={"job": None})
        if path.endswith("/worker/offline"):
            offline_calls += 1
            return httpx.Response(200, json={"worker_id": "win-stop-test", "status": "offline"})
        return httpx.Response(404)

    client = httpx.Client(transport=httpx.MockTransport(_transport))
    try:
        agent = RemoteWorkerAgent(
            api_base_url="https://api.example.com/api/v1",
            worker_token="tok",
            worker_id="win-stop-test",
            poll_interval_sec=0.2,
            heartbeat_interval_sec=0.1,
            handler=lambda *a, **k: JobCompletionResult(is_simulated=True),  # type: ignore[arg-type]
            http_client=client,
        )
        t = threading.Thread(target=agent.run_forever, daemon=True)
        t.start()
        time.sleep(0.25)
        assert agent._heartbeat_thread is not None and agent._heartbeat_thread.is_alive()

        agent.request_stop()
        t.join(timeout=3.0)
        assert not t.is_alive()
        assert agent._heartbeat_thread is None
        assert offline_calls == 1
    finally:
        client.close()


def test_stale_worker_detection_busy_stale_offline_and_no_job_table_spoofing(db_session):
    db_session.query(TranscriptionJob).delete()
    db_session.query(WorkerNode).delete()
    db_session.commit()

    now = datetime.now(UTC)
    user_tok_proj_id = f"proj-{uuid.uuid4().hex[:8]}"

    # Seed an active processing job with non-expired lease to prove it NEVER forces offline worker online
    active_job = TranscriptionJob(
        id=f"job-{uuid.uuid4().hex[:8]}",
        project_id=user_tok_proj_id,
        user_id="00000000-0000-0000-0000-000000000001",
        status="transcribing",
        progress=60,
        current_stage="Transcribing Melody",
        locked_by_worker="win-stale-check",
        lease_expires_at=now + timedelta(seconds=100),
    )

    # Create dummy project owner? Not enforced by SQLite FK unless enabled, so test WorkerNode availability directly
    node = WorkerNode(
        worker_id="win-stale-check",
        status="online",
        last_seen_at=now - timedelta(seconds=12),
        active_job_id=None,
        metadata_json={},
        updated_at=now,
    )
    db_session.add(node)
    db_session.commit()

    # 1. Idle online (12s <= 45s)
    avail = get_worker_availability(db_session)
    assert avail["worker_online"] is True
    assert avail["status"] == "online"
    assert avail["freshness_threshold_seconds"] == 45
    assert avail["busy_stale_threshold_seconds"] == 90

    # 2. Idle > 45s -> offline
    node.last_seen_at = now - timedelta(seconds=50)
    db_session.commit()
    avail_idle_off = get_worker_availability(db_session)
    assert avail_idle_off["worker_online"] is False
    assert avail_idle_off["status"] == "offline"
    assert avail_idle_off["last_seen_seconds"] >= 49.0

    # 3. Busy <= 45s -> busy
    node.status = "busy"
    node.active_job_id = active_job.id
    node.last_seen_at = now - timedelta(seconds=18)
    db_session.commit()
    avail_busy = get_worker_availability(db_session)
    assert avail_busy["worker_online"] is True
    assert avail_busy["status"] == "busy"
    assert avail_busy["active_job_id"] == active_job.id

    # 4. Busy delayed 60s (> 45s, <= 90s) -> stale (still tracked/online during active inference tolerance)
    node.last_seen_at = now - timedelta(seconds=60)
    db_session.commit()
    avail_stale = get_worker_availability(db_session)
    assert avail_stale["worker_online"] is True
    assert avail_stale["status"] == "stale"
    assert avail_stale["last_seen_seconds"] >= 59.0

    # 5. Busy disconnected > 90s -> offline (NOT spoofed online even though active job row exists!)
    db_session.execute(
        TranscriptionJob.__table__.insert().values(
            id=active_job.id,
            project_id=active_job.project_id,
            user_id=active_job.user_id,
            status="transcribing",
            progress=60,
            current_stage="Transcribing Melody",
            settings_json={},
            logs_text="",
            locked_by_worker="win-stale-check",
            lease_expires_at=now + timedelta(seconds=120),
            attempt_count=1,
            created_at=now,
        )
    )
    node.last_seen_at = now - timedelta(seconds=110)
    db_session.commit()
    avail_dead = get_worker_availability(db_session)
    assert avail_dead["worker_online"] is False
    assert avail_dead["status"] == "offline"
    assert avail_dead["last_seen_seconds"] >= 109.0


def test_trimmed_wav_upload_metadata_and_worker_download_preserve_sample_rates(client, db_session):
    os.environ["WORKER_API_TOKEN"] = "trim-sr-token"
    get_settings.cache_clear()

    reg = client.post(
        "/api/v1/auth/register",
        json={
            "email": f"trim_sr_{uuid.uuid4().hex[:8]}@example.com",
            "password": "StrongPassword123!",
            "display_name": "Trim SR Tester",
        },
    )
    assert reg.status_code == 201
    user_id = reg.json()["user"]["id"]
    headers = {"Authorization": f"Bearer {create_access_token(user_id)}"}

    proj = client.post(
        "/api/v1/projects",
        headers=headers,
        json={"title": "Sample Rate Preservation", "instrument": "piano", "transcription_mode": "melody"},
    )
    assert proj.status_code == 201
    pid = proj.json()["id"]

    for target_sr, target_ch, fname in [
        (44100, 2, "trimmed-44k.wav"),
        (48000, 2, "trimmed-48k.wav"),
        (8000, 1, "genuine-8k.wav"),
    ]:
        wav_bytes = _make_wav_bytes(target_sr, target_ch, duration_sec=0.35)
        up = client.post(
            "/api/v1/uploads",
            headers=headers,
            data={"project_id": pid},
            files={"file": (fname, wav_bytes, "audio/wav")},
        )
        assert up.status_code == 201, up.text
        asset_meta = up.json()
        assert asset_meta["sample_rate"] == target_sr
        assert asset_meta["channels"] == target_ch

        db_asset = db_session.query(MediaAsset).filter(MediaAsset.id == asset_meta["id"]).first()
        assert db_asset is not None
        assert db_asset.sample_rate == target_sr

        # Verify worker receives identical unmodified sample-rate bytes when claiming a job for this asset
        job_res = client.post(
            f"/api/v1/projects/{pid}/transcriptions",
            headers=headers,
            json={"source_asset_id": asset_meta["id"]},
        )
        assert job_res.status_code == 202
        claim = client.post(
            "/api/v1/worker/jobs/claim",
            json={"worker_id": "win-sr-checker"},
            headers={"X-Worker-Token": "trim-sr-token"},
        )
        assert claim.status_code == 200
        claimed = claim.json()["job"]
        assert claimed is not None
        dl_resp = client.get(claimed["source_download_url"])
        assert dl_resp.status_code == 200
        with wave.open(io.BytesIO(dl_resp.content), "rb") as wf:
            assert wf.getframerate() == target_sr
            assert wf.getnchannels() == target_ch
            assert wf.getsampwidth() == 2

        # Fail/close claimed job before next iteration
        client.post(
            f"/api/v1/worker/jobs/{claimed['id']}/fail",
            json={"worker_id": "win-sr-checker", "error_code": "TEST_DONE", "error_message": "done"},
            headers={"X-Worker-Token": "trim-sr-token"},
        )
