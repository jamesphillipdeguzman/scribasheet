import os
from datetime import UTC, datetime, timedelta
from unittest.mock import MagicMock, patch

import httpx

from app.core.config import get_settings
from app.models import MediaAsset, TranscriptionJob, TranscriptionResult
from app.storage.service import storage_service
from app.worker_agent import RemoteWorkerAgent


def _setup_project_and_job(client, db_session, *, worker_token: str = "test-worker-secret-token"):
    os.environ["JOB_EXECUTION_MODE"] = "remote_worker"
    os.environ["WORKER_API_TOKEN"] = worker_token
    get_settings.cache_clear()

    reg = client.post(
        "/api/v1/auth/register",
        json={
            "email": f"worker_test_{datetime.now(UTC).timestamp()}@example.com",
            "password": "StrongPassword123!",
            "display_name": "Worker Tester",
        },
    )
    assert reg.status_code == 201, reg.text
    headers = {"Authorization": f"Bearer {reg.json()['access_token']}"}

    proj = client.post(
        "/api/v1/projects",
        headers=headers,
        json={"title": "Remote Job Song", "instrument": "vocals", "transcription_mode": "vocal_melody"},
    )
    assert proj.status_code == 201
    project_id = proj.json()["id"]

    # Create a minimal valid WAV header in storage via /uploads
    import io

    import numpy as np
    import soundfile as sf

    buf = io.BytesIO()
    sf.write(buf, np.zeros(4410, dtype=np.float32), 22050, format="WAV", subtype="PCM_16")
    up = client.post(
        "/api/v1/uploads",
        headers=headers,
        data={"project_id": project_id},
        files={"file": ("sample.wav", buf.getvalue(), "audio/wav")},
    )
    assert up.status_code == 201, up.text
    asset_id = up.json()["id"]

    job_res = client.post(
        f"/api/v1/projects/{project_id}/transcriptions",
        headers=headers,
        json={"source_asset_id": asset_id},
    )
    assert job_res.status_code == 202, job_res.text
    return headers, project_id, job_res.json()["id"], {"X-Worker-Token": worker_token}


def test_unauthorized_worker_access(client, db_session):
    os.environ["WORKER_API_TOKEN"] = "real-secret-token"
    get_settings.cache_clear()

    assert client.post("/api/v1/worker/jobs/claim", json={"worker_id": "w1"}).status_code == 401
    assert (
        client.post(
            "/api/v1/worker/jobs/claim",
            json={"worker_id": "w1"},
            headers={"X-Worker-Token": "wrong-token"},
        ).status_code
        == 401
    )

    os.environ["WORKER_API_TOKEN"] = ""
    get_settings.cache_clear()
    assert (
        client.post(
            "/api/v1/worker/jobs/claim",
            json={"worker_id": "w1"},
            headers={"X-Worker-Token": "any"},
        ).status_code
        == 401
    )


def test_claim_concurrency_heartbeat_progress_and_complete(client, db_session):
    user_headers, project_id, job_id, w_headers = _setup_project_and_job(client, db_session)

    # Worker 1 claims the job
    c1 = client.post("/api/v1/worker/jobs/claim", json={"worker_id": "worker-1"}, headers=w_headers)
    assert c1.status_code == 200
    claimed = c1.json()["job"]
    assert claimed is not None
    assert claimed["id"] == job_id
    assert claimed["attempt_count"] == 1
    assert claimed["source_download_url"] is not None

    # Worker 2 attempts to claim at the same time -> gets None
    c2 = client.post("/api/v1/worker/jobs/claim", json={"worker_id": "worker-2"}, headers=w_headers)
    assert c2.status_code == 200
    assert c2.json()["job"] is None

    # Wrong worker cannot heartbeat or report progress
    assert (
        client.post(
            f"/api/v1/worker/jobs/{job_id}/heartbeat",
            json={"worker_id": "worker-2"},
            headers=w_headers,
        ).status_code
        == 403
    )

    # Worker 1 heartbeat succeeds
    hb = client.post(
        f"/api/v1/worker/jobs/{job_id}/heartbeat",
        json={"worker_id": "worker-1"},
        headers=w_headers,
    )
    assert hb.status_code == 200
    assert "lease_expires_at" in hb.json()

    # Worker 1 progress update succeeds
    prog = client.post(
        f"/api/v1/worker/jobs/{job_id}/progress",
        json={
            "worker_id": "worker-1",
            "status": "preprocessing",
            "progress": 35,
            "current_stage": "Preprocessing",
            "log_line": "Normalized WAV",
        },
        headers=w_headers,
    )
    assert prog.status_code == 200
    assert prog.json()["progress"] == 35

    # Worker 1 completes job with project-scoped artifact keys
    job_row = db_session.query(TranscriptionJob).filter(TranscriptionJob.id == job_id).first()
    midi_key = f"users/{job_row.user_id}/projects/{project_id}/midi/out.mid"
    xml_key = f"users/{job_row.user_id}/projects/{project_id}/musicxml/out.musicxml"

    # Rejects path traversal / arbitrary paths
    bad_comp = client.post(
        f"/api/v1/worker/jobs/{job_id}/complete",
        json={"worker_id": "worker-1", "midi_key": "../../etc/passwd"},
        headers=w_headers,
    )
    assert bad_comp.status_code == 400

    comp = client.post(
        f"/api/v1/worker/jobs/{job_id}/complete",
        json={
            "worker_id": "worker-1",
            "midi_key": midi_key,
            "musicxml_key": xml_key,
            "duration_seconds": 12.5,
            "score_json": {
                "title": "Remote Job Song",
                "tempo_bpm": 120,
                "time_signature": "4/4",
                "key_signature": "C",
                "duration_seconds": 12.5,
                "tracks": [{"index": 0, "name": "Piano", "instrument": "piano", "clef": "treble", "program": 0, "muted": False}],
                "notes": [{"id": "n1", "pitch_midi": 60, "onset_sec": 0.0, "offset_sec": 0.5, "velocity": 80, "track_index": 0}],
                "chords": [],
            },
            "metadata_json": {"note_count": 1},
        },
        headers=w_headers,
    )
    assert comp.status_code == 200
    assert comp.json()["status"] == "completed"
    assert comp.json()["idempotent"] is False

    # Duplicate completion is idempotent and does not create duplicate TranscriptionResult
    comp2 = client.post(
        f"/api/v1/worker/jobs/{job_id}/complete",
        json={"worker_id": "worker-1", "midi_key": midi_key},
        headers=w_headers,
    )
    assert comp2.status_code == 200
    assert comp2.json()["idempotent"] is True
    assert db_session.query(TranscriptionResult).filter(TranscriptionResult.job_id == job_id).count() == 1
    assert db_session.query(MediaAsset).filter(MediaAsset.project_id == project_id, MediaAsset.asset_type == "midi").count() == 1


def test_lease_expiration_recovery_and_failure_handling(client, db_session):
    _, _, job_id, w_headers = _setup_project_and_job(client, db_session)

    # Worker 1 claims job
    c1 = client.post("/api/v1/worker/jobs/claim", json={"worker_id": "worker-1"}, headers=w_headers)
    assert c1.json()["job"]["id"] == job_id

    # Simulate worker crash by expiring the lease in DB
    job_row = db_session.query(TranscriptionJob).filter(TranscriptionJob.id == job_id).first()
    job_row.lease_expires_at = datetime.now(UTC) - timedelta(seconds=30)
    db_session.commit()

    # Worker 2 recovers expired lease and claims the job
    c2 = client.post("/api/v1/worker/jobs/claim", json={"worker_id": "worker-2"}, headers=w_headers)
    assert c2.status_code == 200
    recovered = c2.json()["job"]
    assert recovered is not None
    assert recovered["id"] == job_id
    assert recovered["attempt_count"] == 2

    # Worker 2 reports failure
    fail = client.post(
        f"/api/v1/worker/jobs/{job_id}/fail",
        json={
            "worker_id": "worker-2",
            "error_code": "DECODE_ERROR",
            "error_message": "Audio stream corrupted",
        },
        headers=w_headers,
    )
    assert fail.status_code == 200
    assert fail.json()["status"] == "failed"

    db_session.expire_all()
    failed_row = db_session.query(TranscriptionJob).filter(TranscriptionJob.id == job_id).first()
    assert failed_row.error_code == "DECODE_ERROR"
    assert failed_row.error_message == "Audio stream corrupted"


def test_r2_presigned_url_generation_with_mocked_boto3(client, db_session):
    os.environ["STORAGE_BACKEND"] = "s3"
    os.environ["S3_ENDPOINT_URL"] = "https://example-account.r2.cloudflarestorage.com"
    os.environ["S3_BUCKET_NAME"] = "scribasheet-private"
    os.environ["S3_ACCESS_KEY_ID"] = "mock-key"
    os.environ["S3_SECRET_ACCESS_KEY"] = "mock-secret"
    os.environ["S3_REGION"] = "auto"
    get_settings.cache_clear()

    try:
        mock_s3 = MagicMock()
        mock_s3.generate_presigned_url.side_effect = lambda op, Params, ExpiresIn: (
            f"https://r2.mock/{op}/{Params['Key']}?exp={ExpiresIn}"
        )

        with patch.object(storage_service, "_s3_client", return_value=mock_s3):
            put_res = storage_service.create_presigned_put_url("users/u1/projects/p1/originals/test.wav", "audio/wav")
            assert "put_object" in str(put_res["url"])
            assert put_res["key"] == "users/u1/projects/p1/originals/test.wav"

            get_res = storage_service.create_presigned_get_url("users/u1/projects/p1/originals/test.wav")
            assert "get_object" in str(get_res["url"])

            # Also test /api/v1/uploads/presign endpoint
            reg = client.post(
                "/api/v1/auth/register",
                json={"email": "r2user@example.com", "password": "StrongPassword123!", "display_name": "R2 User"},
            )
            headers = {"Authorization": f"Bearer {reg.json()['access_token']}"}
            proj = client.post("/api/v1/projects", headers=headers, json={"title": "R2 Song"})
            project_id = proj.json()["id"]

            presign = client.post(
                "/api/v1/uploads/presign",
                headers=headers,
                json={
                    "project_id": project_id,
                    "filename": "vocals.wav",
                    "content_type": "audio/wav",
                    "size_bytes": 102400,
                },
            )
            assert presign.status_code == 200
            assert "put_object" in presign.json()["url"]
    finally:
        os.environ["STORAGE_BACKEND"] = "local"
        get_settings.cache_clear()


def test_worker_agent_run_once_end_to_end(client, db_session):
    _, _, job_id, _ = _setup_project_and_job(client, db_session, worker_token="agent-token-123")

    # Point RemoteWorkerAgent at the FastAPI TestClient transport
    agent_http = httpx.Client(transport=client._transport, base_url="http://testserver")
    agent = RemoteWorkerAgent(
        api_base_url="http://testserver/api/v1",
        worker_token="agent-token-123",
        worker_id="win11-test-pc",
        http_client=agent_http,
    )

    did_work = agent.run_once()
    assert did_work is True

    # Second poll finds no remaining queued jobs
    did_work_again = agent.run_once()
    assert did_work_again is False

    db_session.expire_all()
    job_row = db_session.query(TranscriptionJob).filter(TranscriptionJob.id == job_id).first()
    assert job_row.status == "completed"
    assert job_row.locked_by_worker == "win11-test-pc"


def test_strict_lease_expiration_blocks_heartbeat_progress_complete_and_fail(client, db_session):
    _, _, job_id, w_headers = _setup_project_and_job(client, db_session)

    c1 = client.post("/api/v1/worker/jobs/claim", json={"worker_id": "worker-1"}, headers=w_headers)
    assert c1.json()["job"]["id"] == job_id

    # Expire the lease without another worker reclaiming yet
    job_row = db_session.query(TranscriptionJob).filter(TranscriptionJob.id == job_id).first()
    job_row.lease_expires_at = datetime.now(UTC) - timedelta(seconds=5)
    db_session.commit()

    # Worker 1 must be rejected on heartbeat, progress, complete, and fail even before reclaim
    assert (
        client.post(
            f"/api/v1/worker/jobs/{job_id}/heartbeat",
            json={"worker_id": "worker-1"},
            headers=w_headers,
        ).status_code
        == 409
    )
    assert (
        client.post(
            f"/api/v1/worker/jobs/{job_id}/progress",
            json={"worker_id": "worker-1", "status": "preprocessing", "progress": 50, "current_stage": "Preprocessing"},
            headers=w_headers,
        ).status_code
        == 409
    )
    assert (
        client.post(
            f"/api/v1/worker/jobs/{job_id}/complete",
            json={"worker_id": "worker-1"},
            headers=w_headers,
        ).status_code
        == 409
    )
    assert (
        client.post(
            f"/api/v1/worker/jobs/{job_id}/fail",
            json={"worker_id": "worker-1", "error_code": "ERR", "error_message": "Late fail"},
            headers=w_headers,
        ).status_code
        == 409
    )


def test_stale_worker_rejected_after_reclaim_and_no_resurrection_after_fail_or_cancel(client, db_session):
    user_headers, _, job_id, w_headers = _setup_project_and_job(client, db_session)

    # Worker 1 claims, then lease expires, then Worker 2 reclaims
    client.post("/api/v1/worker/jobs/claim", json={"worker_id": "worker-1"}, headers=w_headers)
    job_row = db_session.query(TranscriptionJob).filter(TranscriptionJob.id == job_id).first()
    job_row.lease_expires_at = datetime.now(UTC) - timedelta(seconds=10)
    db_session.commit()

    c2 = client.post("/api/v1/worker/jobs/claim", json={"worker_id": "worker-2"}, headers=w_headers)
    assert c2.json()["job"]["id"] == job_id

    # Stale Worker 1 is rejected with 403 on all endpoints
    assert (
        client.post(f"/api/v1/worker/jobs/{job_id}/heartbeat", json={"worker_id": "worker-1"}, headers=w_headers).status_code
        == 403
    )
    assert (
        client.post(
            f"/api/v1/worker/jobs/{job_id}/progress",
            json={"worker_id": "worker-1", "status": "transcribing", "progress": 70, "current_stage": "Transcribing"},
            headers=w_headers,
        ).status_code
        == 403
    )
    assert (
        client.post(f"/api/v1/worker/jobs/{job_id}/complete", json={"worker_id": "worker-1"}, headers=w_headers).status_code
        == 403
    )

    # Worker 2 fails the job -> Worker 2 cannot later complete/resurrect it
    assert (
        client.post(
            f"/api/v1/worker/jobs/{job_id}/fail",
            json={"worker_id": "worker-2", "error_code": "BAD_AUDIO", "error_message": "Corrupt"},
            headers=w_headers,
        ).status_code
        == 200
    )
    assert (
        client.post(f"/api/v1/worker/jobs/{job_id}/complete", json={"worker_id": "worker-2"}, headers=w_headers).status_code
        == 409
    )

    # Cancelled job also cannot be completed or heartbeated
    user2_headers, _, job2_id, _ = _setup_project_and_job(client, db_session)
    client.post("/api/v1/worker/jobs/claim", json={"worker_id": "worker-2"}, headers=w_headers)
    assert client.post(f"/api/v1/transcriptions/{job2_id}/cancel", headers=user2_headers).status_code == 200
    assert (
        client.post(f"/api/v1/worker/jobs/{job2_id}/heartbeat", json={"worker_id": "worker-2"}, headers=w_headers).status_code
        == 409
    )
    assert (
        client.post(f"/api/v1/worker/jobs/{job2_id}/complete", json={"worker_id": "worker-2"}, headers=w_headers).status_code
        == 409
    )


def test_max_job_attempts_enforced_on_repeated_lease_expiration(client, db_session):
    os.environ["MAX_JOB_ATTEMPTS"] = "3"
    get_settings.cache_clear()
    _, _, job_id, w_headers = _setup_project_and_job(client, db_session)

    for expected_attempt in (1, 2, 3):
        c = client.post("/api/v1/worker/jobs/claim", json={"worker_id": f"worker-{expected_attempt}"}, headers=w_headers)
        assert c.json()["job"] is not None
        assert c.json()["job"]["attempt_count"] == expected_attempt
        # Expire lease
        row = db_session.query(TranscriptionJob).filter(TranscriptionJob.id == job_id).first()
        row.lease_expires_at = datetime.now(UTC) - timedelta(seconds=10)
        db_session.commit()

    # 4th claim should mark the abandoned job permanently failed and return None
    c4 = client.post("/api/v1/worker/jobs/claim", json={"worker_id": "worker-4"}, headers=w_headers)
    assert c4.status_code == 200
    assert c4.json()["job"] is None

    db_session.expire_all()
    final_row = db_session.query(TranscriptionJob).filter(TranscriptionJob.id == job_id).first()
    assert final_row.status == "failed"
    assert final_row.error_code == "MAX_ATTEMPTS_EXCEEDED"
    assert final_row.locked_by_worker is None


def test_concurrent_lease_recovery_and_claim(client, db_session):
    import concurrent.futures

    from fastapi.testclient import TestClient
    from sqlalchemy.orm import sessionmaker

    from app.db.session import get_db
    from app.main import app

    _, _, job_id, w_headers = _setup_project_and_job(client, db_session)
    client.post("/api/v1/worker/jobs/claim", json={"worker_id": "initial-worker"}, headers=w_headers)

    row = db_session.query(TranscriptionJob).filter(TranscriptionJob.id == job_id).first()
    row.lease_expires_at = datetime.now(UTC) - timedelta(seconds=10)
    db_session.commit()

    LocalSession = sessionmaker(autocommit=False, autoflush=False, bind=db_session.get_bind())

    def _per_request_db():
        db = LocalSession()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = _per_request_db
    with TestClient(app) as concurrent_client:
        def _attempt(wid: str):
            return concurrent_client.post("/api/v1/worker/jobs/claim", json={"worker_id": wid}, headers=w_headers).json()["job"]

        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            f1 = pool.submit(_attempt, "racer-1")
            f2 = pool.submit(_attempt, "racer-2")
            r1, r2 = f1.result(), f2.result()

    claimed = [r for r in (r1, r2) if r is not None]
    assert len(claimed) == 1
    assert claimed[0]["id"] == job_id


def test_worker_agent_cooperative_cancel_on_lease_loss_and_reconnect(client, db_session):
    from app.worker_agent import PhaseATestHandler

    _, _, job_id, w_headers = _setup_project_and_job(client, db_session, worker_token="coop-token")

    # Handler runs 1.5s, heartbeat runs every 0.25s; we expire & reclaim mid-flight to trigger 403 on heartbeat
    agent_http = httpx.Client(transport=client._transport, base_url="http://testserver")
    agent = RemoteWorkerAgent(
        api_base_url="http://testserver/api/v1",
        worker_token="coop-token",
        worker_id="coop-worker",
        heartbeat_interval_sec=0.2,
        handler=PhaseATestHandler(test_duration_sec=1.5),
        http_client=agent_http,
    )

    import threading
    import time

    def _steal_lease():
        time.sleep(0.35)
        row = db_session.query(TranscriptionJob).filter(TranscriptionJob.id == job_id).first()
        row.locked_by_worker = "other-worker"
        db_session.commit()

    t = threading.Thread(target=_steal_lease, daemon=True)
    t.start()
    agent.run_once()
    t.join(timeout=2.0)

    db_session.expire_all()
    row = db_session.query(TranscriptionJob).filter(TranscriptionJob.id == job_id).first()
    # Original worker must NOT have marked the stolen job completed or failed
    assert row.status != "completed"
    assert row.locked_by_worker == "other-worker"


def test_r2_confirm_missing_object_and_unauthorized_asset_access(client, db_session):
    os.environ["STORAGE_BACKEND"] = "s3"
    get_settings.cache_clear()
    try:
        reg1 = client.post(
            "/api/v1/auth/register",
            json={"email": "owner_r2@example.com", "password": "StrongPassword123!", "display_name": "Owner"},
        )
        h1 = {"Authorization": f"Bearer {reg1.json()['access_token']}"}
        reg2 = client.post(
            "/api/v1/auth/register",
            json={"email": "intruder_r2@example.com", "password": "StrongPassword123!", "display_name": "Intruder"},
        )
        h2 = {"Authorization": f"Bearer {reg2.json()['access_token']}"}

        proj = client.post("/api/v1/projects", headers=h1, json={"title": "Private R2"}).json()
        owner_id = reg1.json()["user"]["id"]
        missing_key = f"users/{owner_id}/projects/{proj['id']}/originals/missing.wav"

        with patch.object(storage_service, "exists", return_value=False):
            res = client.post(
                "/api/v1/uploads/confirm",
                headers=h1,
                json={
                    "project_id": proj["id"],
                    "storage_key": missing_key,
                    "filename": "missing.wav",
                    "content_type": "audio/wav",
                    "size_bytes": 1000,
                },
            )
            assert res.status_code == 400

        # Intruder cannot presign or confirm for owner's project
        assert (
            client.post(
                "/api/v1/uploads/presign",
                headers=h2,
                json={"project_id": proj["id"], "filename": "x.wav", "content_type": "audio/wav", "size_bytes": 1000},
            ).status_code
            == 403
        )
    finally:
        os.environ["STORAGE_BACKEND"] = "local"
        get_settings.cache_clear()


def test_active_non_expired_lease_cannot_be_recovered_prematurely(client, db_session):
    _, _, job_id, w_headers = _setup_project_and_job(client, db_session)

    c1 = client.post("/api/v1/worker/jobs/claim", json={"worker_id": "worker-1"}, headers=w_headers)
    assert c1.status_code == 200
    assert c1.json()["job"]["id"] == job_id

    # Ensure lease is explicitly in the future
    row = db_session.query(TranscriptionJob).filter(TranscriptionJob.id == job_id).first()
    row.lease_expires_at = datetime.now(UTC) + timedelta(seconds=90)
    db_session.commit()

    # Worker 2 must NOT recover or claim the active job
    c2 = client.post("/api/v1/worker/jobs/claim", json={"worker_id": "worker-2"}, headers=w_headers)
    assert c2.status_code == 200
    assert c2.json()["job"] is None

    db_session.expire_all()
    refreshed = db_session.query(TranscriptionJob).filter(TranscriptionJob.id == job_id).first()
    assert refreshed.locked_by_worker == "worker-1"
    assert refreshed.attempt_count == 1


def test_stale_worker_cannot_fail_reclaimed_job(client, db_session):
    _, _, job_id, w_headers = _setup_project_and_job(client, db_session)

    client.post("/api/v1/worker/jobs/claim", json={"worker_id": "worker-1"}, headers=w_headers)
    row = db_session.query(TranscriptionJob).filter(TranscriptionJob.id == job_id).first()
    row.lease_expires_at = datetime.now(UTC) - timedelta(seconds=10)
    db_session.commit()

    c2 = client.post("/api/v1/worker/jobs/claim", json={"worker_id": "worker-2"}, headers=w_headers)
    assert c2.json()["job"]["id"] == job_id

    # Stale worker 1 must be rejected with 403 when attempting /fail
    stale_fail = client.post(
        f"/api/v1/worker/jobs/{job_id}/fail",
        json={"worker_id": "worker-1", "error_code": "STALE", "error_message": "Stale failure"},
        headers=w_headers,
    )
    assert stale_fail.status_code == 403

    db_session.expire_all()
    refreshed = db_session.query(TranscriptionJob).filter(TranscriptionJob.id == job_id).first()
    assert refreshed.status == "validating"
    assert refreshed.locked_by_worker == "worker-2"


def test_interrupted_worker_does_not_complete_or_fail_and_recovers_on_lease_expiry(client, db_session):
    import threading

    from app.worker_agent import PhaseATestHandler

    _, _, job_id, w_headers = _setup_project_and_job(client, db_session, worker_token="interrupt-token")

    agent_http = httpx.Client(transport=client._transport, base_url="http://testserver")
    agent = RemoteWorkerAgent(
        api_base_url="http://testserver/api/v1",
        worker_token="interrupt-token",
        worker_id="interrupt-worker",
        heartbeat_interval_sec=5.0,
        handler=PhaseATestHandler(test_duration_sec=2.0),
        http_client=agent_http,
    )

    # Trigger graceful Ctrl+C / SIGTERM stop shortly after claim
    def _interrupt():
        import time

        time.sleep(0.25)
        agent.request_stop()

    t = threading.Thread(target=_interrupt, daemon=True)
    t.start()
    did_claim = agent.run_once()
    t.join(timeout=2.0)
    assert did_claim is True

    db_session.expire_all()
    row = db_session.query(TranscriptionJob).filter(TranscriptionJob.id == job_id).first()
    assert row.status not in ("completed", "failed")
    assert row.locked_by_worker == "interrupt-worker"

    # Once lease expires, another worker can recover and complete it
    row.lease_expires_at = datetime.now(UTC) - timedelta(seconds=5)
    db_session.commit()

    agent2 = RemoteWorkerAgent(
        api_base_url="http://testserver/api/v1",
        worker_token="interrupt-token",
        worker_id="recovery-worker",
        handler=PhaseATestHandler(test_duration_sec=0.1),
        http_client=agent_http,
    )
    assert agent2.run_once() is True

    db_session.expire_all()
    recovered = db_session.query(TranscriptionJob).filter(TranscriptionJob.id == job_id).first()
    assert recovered.status == "completed"
    assert recovered.locked_by_worker == "recovery-worker"
    assert recovered.attempt_count == 2


def test_r2_confirm_rejects_zero_negative_and_oversized_uploads(client, db_session):
    os.environ["STORAGE_BACKEND"] = "s3"
    get_settings.cache_clear()
    try:
        reg = client.post(
            "/api/v1/auth/register",
            json={"email": "size_r2@example.com", "password": "StrongPassword123!", "display_name": "Size Tester"},
        )
        headers = {"Authorization": f"Bearer {reg.json()['access_token']}"}
        proj = client.post("/api/v1/projects", headers=headers, json={"title": "Size Validation"}).json()
        owner_id = reg.json()["user"]["id"]
        valid_key = f"users/{owner_id}/projects/{proj['id']}/originals/test.wav"

        # Zero and negative size_bytes rejected with 400
        for bad_size in (0, -100):
            res = client.post(
                "/api/v1/uploads/confirm",
                headers=headers,
                json={
                    "project_id": proj["id"],
                    "storage_key": valid_key,
                    "filename": "test.wav",
                    "content_type": "audio/wav",
                    "size_bytes": bad_size,
                },
            )
            assert res.status_code == 400

        # Oversized declared size rejected with 413
        oversized = get_settings().max_upload_bytes + 1
        res_big = client.post(
            "/api/v1/uploads/confirm",
            headers=headers,
            json={
                "project_id": proj["id"],
                "storage_key": valid_key,
                "filename": "test.wav",
                "content_type": "audio/wav",
                "size_bytes": oversized,
            },
        )
        assert res_big.status_code == 413

        # Mismatched actual object size on R2 rejected with 400
        with (
            patch.object(storage_service, "exists", return_value=True),
            patch.object(storage_service, "get_object_size", return_value=2048),
        ):
            res_mismatch = client.post(
                "/api/v1/uploads/confirm",
                headers=headers,
                json={
                    "project_id": proj["id"],
                    "storage_key": valid_key,
                    "filename": "test.wav",
                    "content_type": "audio/wav",
                    "size_bytes": 1024,
                },
            )
            assert res_mismatch.status_code == 400

            # Matching actual object size succeeds with 201
            res_ok = client.post(
                "/api/v1/uploads/confirm",
                headers=headers,
                json={
                    "project_id": proj["id"],
                    "storage_key": valid_key,
                    "filename": "test.wav",
                    "content_type": "audio/wav",
                    "size_bytes": 2048,
                },
            )
            assert res_ok.status_code == 201
            assert res_ok.json()["size_bytes"] == 2048
    finally:
        os.environ["STORAGE_BACKEND"] = "local"
        get_settings.cache_clear()


def test_r2_config_validation_and_s3v4_client_setup():
    os.environ["STORAGE_BACKEND"] = "s3"
    os.environ["S3_ENDPOINT_URL"] = ""
    os.environ["S3_ACCESS_KEY_ID"] = ""
    os.environ["S3_SECRET_ACCESS_KEY"] = ""
    get_settings.cache_clear()
    try:
        import pytest

        with pytest.raises(ValueError, match="Missing required S3/R2 configuration"):
            storage_service._s3_client()

        os.environ["S3_ENDPOINT_URL"] = "https://acct123.r2.cloudflarestorage.com"
        os.environ["S3_BUCKET_NAME"] = "scribasheet-private"
        os.environ["S3_ACCESS_KEY_ID"] = "ak"
        os.environ["S3_SECRET_ACCESS_KEY"] = "sk"
        os.environ["S3_REGION"] = "auto"
        get_settings.cache_clear()

        with patch("boto3.client") as mock_boto_client:
            storage_service._s3_client()
            mock_boto_client.assert_called_once()
            _, kwargs = mock_boto_client.call_args
            assert kwargs["endpoint_url"] == "https://acct123.r2.cloudflarestorage.com"
            assert kwargs["region_name"] == "auto"
            assert kwargs["config"].signature_version == "s3v4"
    finally:
        os.environ["STORAGE_BACKEND"] = "local"
        get_settings.cache_clear()


def test_r2_presign_validation_cross_user_isolation_and_expired_signed_url(client, db_session):
    os.environ["STORAGE_BACKEND"] = "s3"
    os.environ["S3_ENDPOINT_URL"] = "https://acct123.r2.cloudflarestorage.com"
    os.environ["S3_BUCKET_NAME"] = "scribasheet-private"
    os.environ["S3_ACCESS_KEY_ID"] = "ak"
    os.environ["S3_SECRET_ACCESS_KEY"] = "sk"
    get_settings.cache_clear()
    try:
        reg1 = client.post(
            "/api/v1/auth/register",
            json={"email": "iso1@example.com", "password": "StrongPassword123!", "display_name": "User 1"},
        )
        h1 = {"Authorization": f"Bearer {reg1.json()['access_token']}"}
        u1_id = reg1.json()["user"]["id"]

        reg2 = client.post(
            "/api/v1/auth/register",
            json={"email": "iso2@example.com", "password": "StrongPassword123!", "display_name": "User 2"},
        )
        h2 = {"Authorization": f"Bearer {reg2.json()['access_token']}"}

        p1 = client.post("/api/v1/projects", headers=h1, json={"title": "User 1 Project"}).json()
        p2 = client.post("/api/v1/projects", headers=h2, json={"title": "User 2 Project"}).json()

        # Invalid content type / extension rejected on presign
        bad_mime = client.post(
            "/api/v1/uploads/presign",
            headers=h1,
            json={"project_id": p1["id"], "filename": "script.exe", "content_type": "application/x-msdownload", "size_bytes": 500},
        )
        assert bad_mime.status_code == 400

        # Oversized upload rejected on presign
        too_big = client.post(
            "/api/v1/uploads/presign",
            headers=h1,
            json={
                "project_id": p1["id"],
                "filename": "huge.wav",
                "content_type": "audio/wav",
                "size_bytes": get_settings().max_upload_bytes + 1,
            },
        )
        assert too_big.status_code == 413

        # Cross-user object key isolation on /uploads/confirm
        cross_key = f"users/{u1_id}/projects/{p1['id']}/originals/stolen.wav"
        res_cross = client.post(
            "/api/v1/uploads/confirm",
            headers=h2,
            json={
                "project_id": p2["id"],
                "storage_key": cross_key,
                "filename": "stolen.wav",
                "content_type": "audio/wav",
                "size_bytes": 1024,
            },
        )
        assert res_cross.status_code == 403

        # Confirm valid asset with mocked R2, then verify signed URL, unauthorized access, and expired stream sig
        valid_key = f"users/{u1_id}/projects/{p1['id']}/originals/valid.wav"
        mock_s3 = MagicMock()
        mock_s3.generate_presigned_url.side_effect = lambda op, Params, ExpiresIn: (
            f"https://r2.mock/{op}/{Params['Key']}?exp={ExpiresIn}"
        )
        with (
            patch.object(storage_service, "exists", return_value=True),
            patch.object(storage_service, "get_object_size", return_value=1024),
            patch.object(storage_service, "_s3_client", return_value=mock_s3),
        ):
            asset = client.post(
                "/api/v1/uploads/confirm",
                headers=h1,
                json={
                    "project_id": p1["id"],
                    "storage_key": valid_key,
                    "filename": "valid.wav",
                    "content_type": "audio/wav",
                    "size_bytes": 1024,
                },
            ).json()

            # Owner gets signed R2 GET URL; intruder gets 403
            signed = client.get(f"/api/v1/uploads/{asset['id']}/signed-url", headers=h1)
            assert signed.status_code == 200
            assert "get_object" in signed.json()["url"]
            assert client.get(f"/api/v1/uploads/{asset['id']}/signed-url", headers=h2).status_code == 403

            # Expired or invalid local stream signature rejected with 403
            assert client.get(f"/api/v1/uploads/{asset['id']}/stream?sig=bad&exp=1").status_code == 403
            assert client.get(f"/api/v1/uploads/{asset['id']}/stream").status_code == 401
    finally:
        os.environ["STORAGE_BACKEND"] = "local"
        get_settings.cache_clear()


def test_r2_worker_download_and_export_storage_compatibility(client, db_session):
    os.environ["STORAGE_BACKEND"] = "s3"
    os.environ["JOB_EXECUTION_MODE"] = "remote_worker"
    os.environ["WORKER_API_TOKEN"] = "r2-worker-token"
    os.environ["S3_ENDPOINT_URL"] = "https://acct123.r2.cloudflarestorage.com"
    os.environ["S3_BUCKET_NAME"] = "scribasheet-private"
    os.environ["S3_ACCESS_KEY_ID"] = "ak"
    os.environ["S3_SECRET_ACCESS_KEY"] = "sk"
    get_settings.cache_clear()
    try:
        reg = client.post(
            "/api/v1/auth/register",
            json={"email": "r2exp@example.com", "password": "StrongPassword123!", "display_name": "R2 Export"},
        )
        headers = {"Authorization": f"Bearer {reg.json()['access_token']}"}
        user_id = reg.json()["user"]["id"]
        proj = client.post("/api/v1/projects", headers=headers, json={"title": "R2 Export Song"}).json()

        r2_store: dict[str, bytes] = {}
        mock_s3 = MagicMock()
        mock_s3.generate_presigned_url.side_effect = lambda op, Params, ExpiresIn: (
            f"https://r2.mock/{op}/{Params['Key']}?exp={ExpiresIn}"
        )
        mock_s3.put_object.side_effect = lambda Bucket, Key, Body, ContentType: r2_store.__setitem__(Key, Body)
        mock_s3.get_object.side_effect = lambda Bucket, Key: {"Body": MagicMock(read=lambda: r2_store[Key])}
        mock_s3.head_object.side_effect = lambda Bucket, Key: {"ContentLength": len(r2_store[Key])}

        orig_key = f"users/{user_id}/projects/{proj['id']}/originals/song.wav"
        r2_store[orig_key] = b"RIFF0000WAVEfmt "

        with patch.object(storage_service, "_s3_client", return_value=mock_s3):
            asset = client.post(
                "/api/v1/uploads/confirm",
                headers=headers,
                json={
                    "project_id": proj["id"],
                    "storage_key": orig_key,
                    "filename": "song.wav",
                    "content_type": "audio/wav",
                    "size_bytes": len(r2_store[orig_key]),
                },
            ).json()

            job = client.post(
                f"/api/v1/projects/{proj['id']}/transcriptions",
                headers=headers,
                json={"source_asset_id": asset["id"]},
            ).json()

            claim = client.post(
                "/api/v1/worker/jobs/claim",
                json={"worker_id": "r2-win-worker"},
                headers={"X-Worker-Token": "r2-worker-token"},
            ).json()["job"]
            assert "get_object" in claim["source_download_url"]
            assert "put_object" in claim["artifact_upload_urls"]["midi"]["url"]
            assert "put_object" in claim["artifact_upload_urls"]["musicxml"]["url"]

            # Complete job with valid score_json, then generate & download MIDI export via mocked R2
            client.post(
                f"/api/v1/worker/jobs/{job['id']}/complete",
                json={
                    "worker_id": "r2-win-worker",
                    "midi_key": claim["artifact_upload_urls"]["midi"]["key"],
                    "musicxml_key": claim["artifact_upload_urls"]["musicxml"]["key"],
                    "duration_seconds": 4.0,
                    "score_json": {
                        "title": "R2 Export Song",
                        "tempo_bpm": 120.0,
                        "time_signature": "4/4",
                        "key_signature": "C",
                        "duration_seconds": 4.0,
                        "tracks": [{"index": 0, "name": "Piano", "instrument": "piano", "clef": "treble", "program": 0, "muted": False}],
                        "notes": [{"id": "n1", "pitch_midi": 60, "onset_sec": 0.0, "offset_sec": 0.5, "velocity": 85, "track_index": 0}],
                        "chords": [],
                    },
                },
                headers={"X-Worker-Token": "r2-worker-token"},
            )

            exp = client.post(
                f"/api/v1/projects/{proj['id']}/exports",
                headers=headers,
                json={"format": "midi"},
            )
            assert exp.status_code == 201
            dl = client.get(exp.json()["download_url"], headers=headers)
            assert dl.status_code == 200
            assert dl.content.startswith(b"MThd")
    finally:
        os.environ["STORAGE_BACKEND"] = "local"
        os.environ["JOB_EXECUTION_MODE"] = "local"
        get_settings.cache_clear()


def test_empty_or_invalid_score_cannot_mark_project_ready_and_simulated_stays_draft(client, db_session):
    from app.models import Project, ProjectScore

    user_headers, project_id, job_id, w_headers = _setup_project_and_job(client, db_session)
    client.post("/api/v1/worker/jobs/claim", json={"worker_id": "worker-1"}, headers=w_headers)

    # 1. Empty score_json for non-simulated job is rejected (422)
    r_empty = client.post(
        f"/api/v1/worker/jobs/{job_id}/complete",
        json={"worker_id": "worker-1", "score_json": {}},
        headers=w_headers,
    )
    assert r_empty.status_code == 422

    # 2. Zero-notes score_json for non-simulated job is rejected (422)
    r_zero = client.post(
        f"/api/v1/worker/jobs/{job_id}/complete",
        json={"worker_id": "worker-1", "score_json": {"title": "Empty", "notes": []}},
        headers=w_headers,
    )
    assert r_zero.status_code == 422

    # 3. Invalid score payload is rejected (422)
    r_bad = client.post(
        f"/api/v1/worker/jobs/{job_id}/complete",
        json={"worker_id": "worker-1", "score_json": {"tempo_bpm": "not-a-number"}},
        headers=w_headers,
    )
    assert r_bad.status_code == 422

    # Project must NOT be ready and no ProjectScore created; /score returns 404
    db_session.expire_all()
    proj = db_session.query(Project).filter(Project.id == project_id).first()
    assert proj.status != "ready"
    assert db_session.query(ProjectScore).filter(ProjectScore.project_id == project_id).count() == 0
    assert client.get(f"/api/v1/projects/{project_id}/score", headers=user_headers).status_code == 404

    # 4. Simulated PhaseATestHandler completion succeeds for job but leaves project in draft (not ready)
    r_sim = client.post(
        f"/api/v1/worker/jobs/{job_id}/complete",
        json={
            "worker_id": "worker-1",
            "is_simulated": True,
            "metadata_json": {"handler": "phase_a_test"},
        },
        headers=w_headers,
    )
    assert r_sim.status_code == 200
    assert r_sim.json()["status"] == "completed"

    db_session.expire_all()
    proj_after = db_session.query(Project).filter(Project.id == project_id).first()
    assert proj_after.status == "draft"
    assert db_session.query(ProjectScore).filter(ProjectScore.project_id == project_id).count() == 0
    assert client.get(f"/api/v1/projects/{project_id}/score", headers=user_headers).status_code == 404


def test_missing_physical_musicxml_handled_separately_from_missing_db_score(client, db_session):
    from app.models import ProjectScore

    user_headers, project_id, job_id, w_headers = _setup_project_and_job(client, db_session)
    client.post("/api/v1/worker/jobs/claim", json={"worker_id": "worker-1"}, headers=w_headers)

    # Save valid score + physical MusicXML
    job_row = db_session.query(TranscriptionJob).filter(TranscriptionJob.id == job_id).first()
    xml_key = f"users/{job_row.user_id}/projects/{project_id}/musicxml/score.musicxml"
    storage_service.save_bytes(xml_key, b"<score-partwise/>", content_type="application/vnd.recordare.musicxml+xml")

    comp = client.post(
        f"/api/v1/worker/jobs/{job_id}/complete",
        json={
            "worker_id": "worker-1",
            "musicxml_key": xml_key,
            "score_json": {
                "title": "Valid Score",
                "tempo_bpm": 120,
                "time_signature": "4/4",
                "key_signature": "C",
                "duration_seconds": 2.0,
                "tracks": [{"index": 0, "name": "Piano", "instrument": "piano", "clef": "treble", "program": 0, "muted": False}],
                "notes": [{"id": "n1", "pitch_midi": 64, "onset_sec": 0.0, "offset_sec": 0.5, "velocity": 90, "track_index": 0}],
                "chords": [],
            },
        },
        headers=w_headers,
    )
    assert comp.status_code == 200

    # Valid score returns 200 with musicxml content
    s1 = client.get(f"/api/v1/projects/{project_id}/score", headers=user_headers)
    assert s1.status_code == 200
    assert s1.json()["musicxml"] == "<score-partwise/>"

    # Delete physical MusicXML file while keeping ProjectScore DB row
    storage_service.delete(xml_key)
    assert db_session.query(ProjectScore).filter(ProjectScore.project_id == project_id).count() == 1

    s2 = client.get(f"/api/v1/projects/{project_id}/score", headers=user_headers)
    assert s2.status_code == 200
    assert s2.json()["musicxml"] is None
    assert len(s2.json()["score_json"]["notes"]) == 1


def test_persistent_local_storage_root_and_relative_key_resolution(tmp_path):
    from pathlib import Path

    from app.core.config import Settings

    # Custom LOCAL_STORAGE_ROOT is respected and relative keys resolve under it
    custom_root = tmp_path / "persistent_data" / "storage_data"
    s = Settings(ENVIRONMENT="production", LOCAL_STORAGE_ROOT=str(custom_root))
    assert s.storage_root_path == custom_root.resolve()
    assert s.storage_root_path.exists()

    # Relative storage keys remain compatible across simulated restarts
    old_env = os.environ.get("LOCAL_STORAGE_ROOT")
    try:
        os.environ["LOCAL_STORAGE_ROOT"] = str(custom_root)
        get_settings.cache_clear()
        key = storage_service.build_key("user-1", "proj-1", "originals", "melody.wav")
        assert key.startswith("users/user-1/projects/proj-1/originals/")
        storage_service.save_bytes(key, b"RIFFtest", content_type="audio/wav")

        # Simulate restart by clearing settings cache and reading via relative key
        get_settings.cache_clear()
        assert storage_service.exists(key)
        assert storage_service.read_bytes(key) == b"RIFFtest"
    finally:
        if old_env is not None:
            os.environ["LOCAL_STORAGE_ROOT"] = old_env
        get_settings.cache_clear()

    # Production default falls back to /data/storage_data when /data exists
    with patch.object(Path, "exists", return_value=True):
        s_prod = Settings(ENVIRONMENT="production", LOCAL_STORAGE_ROOT="./storage_data")
        assert str(s_prod.storage_root_path).replace("\\", "/").endswith("/data/storage_data")
