"""Tests for worker availability monitoring, offline queue handling, and cross-device sync."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from fastapi.testclient import TestClient

from app.core.config import get_settings
from app.core.security import create_access_token, hash_password
from app.db.session import SessionLocal
from app.main import app
from app.models import MediaAsset, Project, ProjectScore, User, WorkerNode
from app.schemas.score import ScoreData, ScoreNote, ScoreTrack


def _auth_headers(user_id: str) -> dict[str, str]:
    token = create_access_token(user_id)
    return {"Authorization": f"Bearer {token}"}


def _worker_headers() -> dict[str, str]:
    return {"X-Worker-Token": get_settings().WORKER_API_TOKEN}


def _create_user_and_project(email: str, title: str = "Sync Song") -> tuple[str, str, str]:
    db = SessionLocal()
    try:
        user = User(
            email=email,
            password_hash=hash_password("TestPass123!"),
            display_name="Tester",
            email_verified=True,
        )
        db.add(user)
        db.commit()
        db.refresh(user)

        proj = Project(
            user_id=user.id,
            title=title,
            instrument="piano",
            transcription_mode="single_instrument",
            status="draft",
        )
        db.add(proj)
        db.commit()
        db.refresh(proj)

        asset = MediaAsset(
            project_id=proj.id,
            user_id=user.id,
            asset_type="original",
            storage_path=f"users/{user.id}/projects/{proj.id}/orig.wav",
            original_filename="orig.wav",
            mime_type="audio/wav",
            size_bytes=1024,
            duration_seconds=5.0,
        )
        db.add(asset)
        db.commit()
        db.refresh(asset)
        return user.id, proj.id, asset.id
    finally:
        db.close()


def test_worker_status_freshness_offline_and_queue_flow() -> None:
    uid, pid, _ = _create_user_and_project("worker_sync@example.com")
    client = TestClient(app)

    # Clear any worker nodes from earlier tests
    db = SessionLocal()
    try:
        db.query(WorkerNode).delete()
        db.commit()
    finally:
        db.close()

    # 1. No worker yet -> offline
    r0 = client.get("/api/v1/worker/status", headers=_auth_headers(uid))
    assert r0.status_code == 200
    assert r0.json()["worker_online"] is False
    assert r0.json()["status"] == "offline"

    # 2. Submit job while worker offline -> queued with Waiting for Desktop Worker
    rj = client.post(
        f"/api/v1/projects/{pid}/transcriptions",
        json={"settings": {"instrument": "piano"}},
        headers=_auth_headers(uid),
    )
    assert rj.status_code == 202
    job_data = rj.json()
    assert job_data["status"] == "queued"
    assert job_data["worker_online"] is False
    assert job_data["current_stage"] == "Waiting for Desktop Worker"

    # 3. Worker polls/claims -> online and claims the queued job
    rc = client.post(
        "/api/v1/worker/jobs/claim",
        json={"worker_id": "win-test-1"},
        headers=_worker_headers(),
    )
    assert rc.status_code == 200
    assert rc.json()["job"]["id"] == job_data["id"]

    r1 = client.get("/api/v1/worker/status", headers=_auth_headers(uid))
    assert r1.status_code == 200
    assert r1.json()["worker_online"] is True
    assert r1.json()["worker_id"] == "win-test-1"

    # 4. Graceful worker offline -> immediately offline
    ro = client.post(
        "/api/v1/worker/offline",
        json={"worker_id": "win-test-1"},
        headers=_worker_headers(),
    )
    assert ro.status_code == 200
    r2 = client.get("/api/v1/worker/status", headers=_auth_headers(uid))
    assert r2.json()["worker_online"] is False

    # 5. Stale heartbeat -> offline even if status="online"
    db = SessionLocal()
    try:
        node = db.query(WorkerNode).filter(WorkerNode.worker_id == "win-test-1").first()
        assert node is not None
        node.status = "online"
        node.last_seen_at = datetime.now(UTC) - timedelta(seconds=300)
        db.commit()
    finally:
        db.close()

    r3 = client.get("/api/v1/worker/status", headers=_auth_headers(uid))
    assert r3.json()["worker_online"] is False


def test_cancelled_queued_job_cannot_be_claimed_and_cross_device_sync() -> None:
    uid_a, pid_a, _ = _create_user_and_project("user_a_sync@example.com", title="Desktop Song")
    uid_b, _, _ = _create_user_and_project("user_b_sync@example.com", title="Other Song")
    client = TestClient(app)

    # Queue a job and cancel it before worker claims it
    rj = client.post(
        f"/api/v1/projects/{pid_a}/transcriptions",
        json={"settings": {"instrument": "piano"}},
        headers=_auth_headers(uid_a),
    )
    assert rj.status_code == 202
    jid = rj.json()["id"]

    rcan = client.post(f"/api/v1/transcriptions/{jid}/cancel", headers=_auth_headers(uid_a))
    assert rcan.status_code == 200
    assert rcan.json()["status"] == "cancelled"

    rclaim = client.post(
        "/api/v1/worker/jobs/claim",
        json={"worker_id": "win-test-2"},
        headers=_worker_headers(),
    )
    assert rclaim.status_code == 200
    assert rclaim.json()["job"] is None

    # Persist a score on backend and verify fresh session (second device) retrieves it & User B is isolated
    score = ScoreData(
        title="Desktop Song",
        tempo_bpm=75.0,
        time_signature="4/4",
        key_signature="F major",
        duration_seconds=2.0,
        tracks=[ScoreTrack(index=0, name="Piano", instrument="piano", clef="grand", program=0)],
        notes=[ScoreNote(id="n1", pitch_midi=65, onset_sec=0.0, offset_sec=1.0, velocity=80)],
        chords=[],
    )
    db = SessionLocal()
    try:
        db.add(
            ProjectScore(
                project_id=pid_a,
                version=1,
                score_json=score.model_dump(),
                musicxml_path=None,
                midi_path=None,
            )
        )
        proj = db.query(Project).filter(Project.id == pid_a).first()
        if proj:
            proj.status = "ready"
        db.commit()
    finally:
        db.close()

    # Second device login session for User A sees project & score
    fresh_headers_a = _auth_headers(uid_a)
    plist = client.get("/api/v1/projects", headers=fresh_headers_a)
    assert plist.status_code == 200
    assert any(item["id"] == pid_a for item in plist.json()["items"])

    pscore = client.get(f"/api/v1/projects/{pid_a}/score", headers=fresh_headers_a)
    assert pscore.status_code == 200
    assert pscore.json()["score_json"]["title"] == "Desktop Song"

    # Cross-user isolation: User B cannot access User A's project or score
    assert client.get(f"/api/v1/projects/{pid_a}", headers=_auth_headers(uid_b)).status_code in (403, 404)
    assert client.get(f"/api/v1/projects/{pid_a}/score", headers=_auth_headers(uid_b)).status_code in (403, 404)
