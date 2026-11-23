import os
import subprocess
import sys
import time
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx

from app.models import TranscriptionJob, WorkerNode
from app.worker_agent import (
    PhaseATestHandler,
    RemoteWorkerAgent,
    build_coordinator_url,
    normalize_api_base_url,
)
from app.worker_lock import WorkerSingleInstanceLock

BACKEND_DIR = str(Path(__file__).resolve().parents[1])


def _spawn_lock_holder(lock_name: str) -> subprocess.Popen[str]:
    code = (
        "import sys, time\n"
        "from app.worker_lock import WorkerSingleInstanceLock\n"
        f"lock = WorkerSingleInstanceLock({lock_name!r})\n"
        "ok = lock.acquire()\n"
        "print('ACQUIRED' if ok else 'FAILED', flush=True)\n"
        "if not ok: sys.exit(2)\n"
        "time.sleep(30)\n"
    )
    env = dict(os.environ)
    return subprocess.Popen(
        [sys.executable, "-c", code],
        cwd=BACKEND_DIR,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=env,
    )


def test_single_instance_lock_blocks_duplicate_process_and_releases_on_exit():
    lock_name = f"Local\\ScribaSheetTestLock_{uuid.uuid4().hex}"
    holder = _spawn_lock_holder(lock_name)
    try:
        line = holder.stdout.readline().strip() if holder.stdout else ""
        assert line == "ACQUIRED"

        # Second process / lock instance must fail to acquire while holder is alive
        competing = WorkerSingleInstanceLock(lock_name=lock_name)
        assert competing.acquire() is False
    finally:
        holder.terminate()
        holder.wait(timeout=5)

    # After holder exits, lock must be acquirable and releasable
    recovered = WorkerSingleInstanceLock(lock_name=lock_name)
    assert recovered.acquire() is True
    recovered.release()
    assert recovered.is_acquired is False


def test_stale_lock_recovery_after_forced_kill():
    lock_name = f"Local\\ScribaSheetStaleLock_{uuid.uuid4().hex}"
    holder = _spawn_lock_holder(lock_name)
    try:
        line = holder.stdout.readline().strip() if holder.stdout else ""
        assert line == "ACQUIRED"
        holder.kill()
        holder.wait(timeout=5)

        recovered = WorkerSingleInstanceLock(lock_name=lock_name)
        assert recovered.acquire() is True
        recovered.release()
    finally:
        if holder.poll() is None:
            holder.kill()


def test_worker_agent_main_exits_gracefully_when_lock_held(monkeypatch):
    lock_name = f"Local\\ScribaSheetMainLock_{uuid.uuid4().hex}"
    holder = _spawn_lock_holder(lock_name)
    try:
        line = holder.stdout.readline().strip() if holder.stdout else ""
        assert line == "ACQUIRED"

        monkeypatch.setenv("SCRIBASHEET_API_URL", "http://127.0.0.1:9999/api/v1")
        monkeypatch.setenv("WORKER_API_TOKEN", "test-token")
        monkeypatch.setenv("WORKER_LOCK_NAME", lock_name)

        from app import worker_agent

        exit_code = worker_agent.main()
        assert exit_code == 0
    finally:
        holder.terminate()
        holder.wait(timeout=5)


def test_worker_post_with_retry_recovers_from_transient_network_and_503():
    attempts = {"count": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        attempts["count"] += 1
        if attempts["count"] == 1:
            raise httpx.ConnectError("Temporary network drop", request=request)
        if attempts["count"] == 2:
            return httpx.Response(503, json={"detail": "Cold start"})
        return httpx.Response(200, json={"status": "completed", "idempotent": False})

    client = httpx.Client(transport=httpx.MockTransport(handler))
    agent = RemoteWorkerAgent(
        api_base_url="http://testserver/api/v1",
        worker_token="tok",
        worker_id="retry-worker",
        poll_interval_sec=0.2,
        heartbeat_interval_sec=0.2,
        handler=PhaseATestHandler(0.1),
        http_client=client,
    )
    resp = agent._post_with_retry(
        "http://testserver/api/v1/worker/jobs/j1/complete",
        json_payload={"worker_id": "retry-worker"},
        max_attempts=3,
    )
    assert resp.status_code == 200
    assert attempts["count"] == 3


def test_worker_run_forever_recovers_after_temporary_network_outage():
    calls = {"claim": 0, "offline": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/worker/jobs/claim"):
            calls["claim"] += 1
            if calls["claim"] == 1:
                raise httpx.ConnectError("Temporary outage", request=request)
            agent.request_stop()
            return httpx.Response(200, json={"job": None})
        if request.url.path.endswith("/worker/offline"):
            calls["offline"] += 1
            return httpx.Response(200, json={"status": "offline"})
        return httpx.Response(404)

    client = httpx.Client(transport=httpx.MockTransport(handler))
    agent = RemoteWorkerAgent(
        api_base_url="http://testserver/api/v1",
        worker_token="tok",
        worker_id="resilient-worker",
        poll_interval_sec=0.2,
        heartbeat_interval_sec=0.2,
        handler=PhaseATestHandler(0.1),
        http_client=client,
    )
    start = time.monotonic()
    agent.run_forever()
    elapsed = time.monotonic() - start
    assert calls["claim"] == 2
    assert calls["offline"] == 1
    assert elapsed < 5.0


def test_worker_status_endpoint_reports_online_offline_and_counts(client, db_session):
    reg = client.post(
        "/api/v1/auth/register",
        json={
            "email": f"status_{uuid.uuid4().hex[:8]}@example.com",
            "password": "StrongPassword123!",
            "display_name": "Status Tester",
        },
    )
    assert reg.status_code == 201
    headers = {"Authorization": f"Bearer {reg.json()['access_token']}"}

    # Unauthenticated request must return 401
    assert client.get("/api/v1/worker/status").status_code == 401

    db_session.query(WorkerNode).delete()
    now = datetime.now(UTC)
    node = WorkerNode(
        worker_id="win-status-test",
        status="online",
        last_seen_at=now - timedelta(seconds=10),
        metadata_json={},
        updated_at=now,
    )
    db_session.add(node)
    db_session.commit()

    res_online = client.get("/api/v1/worker/status", headers=headers)
    assert res_online.status_code == 200
    body = res_online.json()
    assert body["worker_online"] is True
    assert body["status"] == "online"
    assert body["worker_id"] == "win-status-test"
    assert body["freshness_threshold_seconds"] == 45
    assert "active_job_count" in body
    assert "queue_depth" in body

    # Stale heartbeat -> offline
    node.last_seen_at = now - timedelta(seconds=120)
    db_session.commit()

    res_offline = client.get("/api/v1/worker/status", headers=headers)
    assert res_offline.status_code == 200
    body_off = res_offline.json()
    assert body_off["worker_online"] is False
    assert body_off["status"] == "offline"
    assert body_off["last_seen_seconds"] >= 119.0
    assert db_session.query(TranscriptionJob).filter(TranscriptionJob.status == "queued").count() == body_off["queue_depth"]


def test_worker_status_empty_naive_tz_cors_and_db_error(client, db_session, monkeypatch):
    reg = client.post(
        "/api/v1/auth/register",
        json={
            "email": f"cors_status_{uuid.uuid4().hex[:8]}@example.com",
            "password": "StrongPassword123!",
            "display_name": "CORS Tester",
        },
    )
    assert reg.status_code == 201
    headers = {
        "Authorization": f"Bearer {reg.json()['access_token']}",
        "Origin": "https://scribasheet.vercel.app",
    }

    # 1. OPTIONS preflight with production Origin
    opt_res = client.options(
        "/api/v1/worker/status",
        headers={
            "Origin": "https://scribasheet.vercel.app",
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "Authorization",
        },
    )
    assert opt_res.status_code == 200
    assert opt_res.headers.get("access-control-allow-origin") == "https://scribasheet.vercel.app"

    # 2. Empty database with no heartbeat
    db_session.query(WorkerNode).delete()
    db_session.commit()
    empty_res = client.get("/api/v1/worker/status", headers=headers)
    assert empty_res.status_code == 200
    assert empty_res.headers.get("access-control-allow-origin") == "https://scribasheet.vercel.app"
    empty_body = empty_res.json()
    assert empty_body["worker_online"] is False
    assert empty_body["last_seen_seconds"] is None

    # 3. Timezone-naive datetime stored in SQLite
    naive_now = datetime.now(UTC).replace(tzinfo=None)
    db_session.add(
        WorkerNode(
            worker_id="win-naive-tz",
            status="online",
            last_seen_at=naive_now - timedelta(seconds=8),
            metadata_json={},
            updated_at=naive_now,
        )
    )
    db_session.commit()
    naive_res = client.get("/api/v1/worker/status", headers=headers)
    assert naive_res.status_code == 200
    assert naive_res.json()["worker_online"] is True

    # 4. Database error returns HTTP 500 with CORS headers (not silently converted to offline)
    from sqlalchemy.exc import OperationalError

    def _raise_db_err(_db):
        raise OperationalError("SELECT 1", {}, Exception("no such table: worker_nodes"))

    monkeypatch.setattr("app.api.v1.worker.get_worker_availability", _raise_db_err)
    err_res = client.get("/api/v1/worker/status", headers=headers)
    assert err_res.status_code == 500
    assert err_res.headers.get("access-control-allow-origin") == "https://scribasheet.vercel.app"


def test_worker_coordinator_url_builder_supports_origin_and_api_v1_bases():
    from app.main import app

    base_variants = [
        "https://scribasheet-production.up.railway.app",
        "https://scribasheet-production.up.railway.app/",
        "https://scribasheet-production.up.railway.app/api/v1",
        "https://scribasheet-production.up.railway.app/api/v1/",
        "https://scribasheet-production.up.railway.app/api/v1/api/v1",
    ]
    for raw in base_variants:
        assert normalize_api_base_url(raw) == "https://scribasheet-production.up.railway.app/api/v1"

    endpoints = {
        "/worker/jobs/claim": "https://scribasheet-production.up.railway.app/api/v1/worker/jobs/claim",
        "/worker/jobs/job-123/heartbeat": "https://scribasheet-production.up.railway.app/api/v1/worker/jobs/job-123/heartbeat",
        "/worker/jobs/job-123/progress": "https://scribasheet-production.up.railway.app/api/v1/worker/jobs/job-123/progress",
        "/worker/jobs/job-123/complete": "https://scribasheet-production.up.railway.app/api/v1/worker/jobs/job-123/complete",
        "/worker/jobs/job-123/fail": "https://scribasheet-production.up.railway.app/api/v1/worker/jobs/job-123/fail",
        "/worker/offline": "https://scribasheet-production.up.railway.app/api/v1/worker/offline",
        "/api/v1/uploads/up-1/stream?sig=abc&exp=999": "https://scribasheet-production.up.railway.app/api/v1/uploads/up-1/stream?sig=abc&exp=999",
    }
    for base in base_variants:
        for path, expected in endpoints.items():
            built = build_coordinator_url(base, path)
            assert built == expected
            assert "/api/v1/api/v1" not in built

    # Presigned absolute URL is preserved untouched
    r2_url = "https://bucket.r2.cloudflarestorage.com/obj.wav?X-Amz-Signature=deadbeef"
    assert build_coordinator_url(base_variants[0], r2_url) == r2_url

    # Verify generated paths match actual FastAPI registered routes
    registered_paths = set(app.openapi()["paths"].keys())
    assert "/api/v1/worker/jobs/claim" in registered_paths
    assert "/api/v1/worker/jobs/{job_id}/heartbeat" in registered_paths
    assert "/api/v1/worker/jobs/{job_id}/progress" in registered_paths
    assert "/api/v1/worker/jobs/{job_id}/complete" in registered_paths
    assert "/api/v1/worker/jobs/{job_id}/fail" in registered_paths
    assert "/api/v1/worker/offline" in registered_paths
    assert "/api/v1/uploads/{upload_id}/stream" in registered_paths


def test_worker_http_retries_502_503_504_timeouts_backoff_and_no_4xx_retry(monkeypatch):
    wait_calls: list[float] = []

    def make_agent(handler):
        client = httpx.Client(transport=httpx.MockTransport(handler))
        agent = RemoteWorkerAgent(
            api_base_url="http://testserver/api/v1",
            worker_token="tok",
            worker_id="retry-worker",
            poll_interval_sec=0.2,
            heartbeat_interval_sec=0.2,
            handler=PhaseATestHandler(0.05),
            http_client=client,
        )
        monkeypatch.setattr(agent._stop_event, "wait", lambda sec: wait_calls.append(sec) or False)
        return agent

    # 1) 502 -> 503 -> 504 -> 200 (3 retries = 4 attempts total, backoff 1s, 2s, 4s)
    attempts = {"count": 0}

    def transient_statuses(request: httpx.Request) -> httpx.Response:
        attempts["count"] += 1
        if attempts["count"] == 1:
            return httpx.Response(502, json={"detail": "Bad Gateway"})
        if attempts["count"] == 2:
            return httpx.Response(503, json={"detail": "Service Unavailable"})
        if attempts["count"] == 3:
            return httpx.Response(504, json={"detail": "Gateway Timeout"})
        return httpx.Response(200, json={"ok": True})

    agent = make_agent(transient_statuses)
    resp = agent._post_with_retry(
        "http://testserver/api/v1/worker/jobs/j1/progress",
        json_payload={"worker_id": "retry-worker"},
        job_id="j1",
    )
    assert resp.status_code == 200
    assert attempts["count"] == 4
    assert wait_calls == [1.0, 2.0, 4.0]

    # 2) ReadTimeout -> ConnectError -> 200
    wait_calls.clear()
    net_attempts = {"count": 0}

    def transient_network(request: httpx.Request) -> httpx.Response:
        net_attempts["count"] += 1
        if net_attempts["count"] == 1:
            raise httpx.ReadTimeout("Timed out", request=request)
        if net_attempts["count"] == 2:
            raise httpx.ConnectError("Connection reset", request=request)
        return httpx.Response(200, json={"ok": True})

    agent2 = make_agent(transient_network)
    resp2 = agent2._post_with_retry(
        "http://testserver/api/v1/worker/jobs/j1/heartbeat",
        json_payload={"worker_id": "retry-worker"},
        job_id="j1",
    )
    assert resp2.status_code == 200
    assert net_attempts["count"] == 3
    assert wait_calls == [1.0, 2.0]

    # 3) Permanent 4xx errors (400, 401, 403, 404) are never retried
    for code in (400, 401, 403, 404):
        wait_calls.clear()
        client_attempts = {"count": 0}

        def client_err(request: httpx.Request, status_code=code) -> httpx.Response:
            client_attempts["count"] += 1
            return httpx.Response(status_code, json={"detail": "Client error"})

        agent3 = make_agent(client_err)
        err_resp = agent3._post_with_retry(
            "http://testserver/api/v1/worker/jobs/j1/progress",
            json_payload={"worker_id": "retry-worker"},
            job_id="j1",
        )
        assert err_resp.status_code == code
        assert client_attempts["count"] == 1
        assert wait_calls == []


def test_worker_progress_502_does_not_abort_transcription_and_complete_retries_idempotently(
    client, db_session, monkeypatch
):
    from tests.test_remote_worker_and_r2 import _setup_project_and_job

    _user_headers, _project_id, job_id, _w_headers = _setup_project_and_job(client, db_session)
    progress_calls = {"count": 0}
    complete_calls = {"count": 0}
    fail_calls = {"count": 0}

    def proxy_handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path.endswith("/progress"):
            progress_calls["count"] += 1
            # Simulate persistent 502 on progress reporting
            return httpx.Response(502, json={"detail": "Bad Gateway"})
        if path.endswith("/complete"):
            complete_calls["count"] += 1
            if complete_calls["count"] == 1:
                # First complete hits backend, then proxy returns 502; second complete hits idempotent guard
                res = client.post(path, content=request.content, headers=dict(request.headers))
                assert res.status_code == 200
                return httpx.Response(502, json={"detail": "Proxy 502 after upstream commit"})
            res = client.post(path, content=request.content, headers=dict(request.headers))
            return httpx.Response(res.status_code, content=res.content, headers=dict(res.headers))
        if path.endswith("/fail"):
            fail_calls["count"] += 1
        res = client.post(path, content=request.content, headers=dict(request.headers))
        return httpx.Response(res.status_code, content=res.content, headers=dict(res.headers))

    mock_client = httpx.Client(transport=httpx.MockTransport(proxy_handler))
    agent = RemoteWorkerAgent(
        api_base_url="http://testserver/api/v1",
        worker_token=_w_headers["X-Worker-Token"],
        worker_id="resilient-worker",
        poll_interval_sec=0.2,
        heartbeat_interval_sec=10.0,
        handler=PhaseATestHandler(0.05),
        http_client=mock_client,
    )
    monkeypatch.setattr(agent._stop_event, "wait", lambda _sec: False)

    assert agent.run_once() is True
    assert progress_calls["count"] >= 4
    assert complete_calls["count"] == 2
    assert fail_calls["count"] == 0

    job_row = db_session.query(TranscriptionJob).filter(TranscriptionJob.id == job_id).first()
    db_session.refresh(job_row)
    assert job_row.status == "completed"


def test_retry_job_recovers_source_download_url_and_rejects_missing_media(client, db_session):
    from tests.test_remote_worker_and_r2 import _setup_project_and_job

    user_headers, project_id, job_id, w_headers = _setup_project_and_job(client, db_session)

    # Simulate a legacy/failed job whose source_asset_id was lost
    job_row = db_session.query(TranscriptionJob).filter(TranscriptionJob.id == job_id).first()
    job_row.status = "failed"
    job_row.error_message = "Job has no source_download_url."
    job_row.source_asset_id = None
    db_session.commit()

    retry_res = client.post(f"/api/v1/transcriptions/{job_id}/retry", headers=user_headers)
    assert retry_res.status_code == 202
    retried_job_id = retry_res.json()["id"]

    db_session.query(TranscriptionJob).filter(
        TranscriptionJob.id != retried_job_id,
        TranscriptionJob.status == "queued",
    ).update({"status": "cancelled"})
    db_session.commit()

    claim_res = client.post("/api/v1/worker/jobs/claim", json={"worker_id": "worker-retry"}, headers=w_headers)
    assert claim_res.status_code == 200
    claimed = claim_res.json()["job"]
    assert claimed["id"] == retried_job_id
    assert claimed["source_download_url"]
    assert claimed["settings"]["instrument"] == "piano"

    # Project with no uploaded media must return HTTP 400 and not queue a job
    empty_proj = client.post("/api/v1/projects", json={"title": "Empty Project"}, headers=user_headers).json()
    orphan_job = TranscriptionJob(
        project_id=empty_proj["id"],
        user_id=job_row.user_id,
        source_asset_id=None,
        status="failed",
        progress=0,
        current_stage="Failed",
        engine="basic_pitch",
        settings_json={"instrument": "piano", "mode": "single_instrument"},
    )
    db_session.add(orphan_job)
    db_session.commit()

    bad_retry = client.post(f"/api/v1/transcriptions/{orphan_job.id}/retry", headers=user_headers)
    assert bad_retry.status_code == 400
    assert bad_retry.json()["detail"] == "No uploaded media found for this project. Please upload an audio file first."
