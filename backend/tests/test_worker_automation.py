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
