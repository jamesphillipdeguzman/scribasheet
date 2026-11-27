import io
import math
import struct
import uuid
import wave

from app.core.config import get_settings
from app.models import MediaAsset, TranscriptionJob, UsageRecord, User


def _make_wav_bytes(duration_sec: float = 0.3, sample_rate: int = 22050) -> bytes:
    buf = io.BytesIO()
    n_frames = int(duration_sec * sample_rate)
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        frames = bytearray()
        for i in range(n_frames):
            sample = int(8000 * math.sin(2 * math.pi * 440.0 * i / sample_rate))
            frames.extend(struct.pack("<h", sample))
        wf.writeframes(bytes(frames))
    return buf.getvalue()


def _register(client, email: str, extra: dict | None = None) -> tuple[dict[str, str], dict]:
    payload = {"email": email, "password": "StrongPassword123!", "display_name": "Quota Tester"}
    if extra:
        payload.update(extra)
    res = client.post("/api/v1/auth/register", json=payload)
    assert res.status_code == 201, res.text
    data = res.json()
    return {"Authorization": f"Bearer {data['access_token']}"}, data


def test_admin_emails_parsing_case_insensitive_and_multiple_admins(client, monkeypatch):
    monkeypatch.setenv("ADMIN_EMAILS", " first.admin@example.com , Second.Admin@Example.COM ")
    get_settings.cache_clear()
    try:
        h1, d1 = _register(client, "First.Admin@example.com")
        assert d1["user"]["is_unlimited"] is True
        assert d1["user"]["plan_label"] == "UNLIMITED"

        h2, d2 = _register(client, "second.admin@example.com")
        assert d2["user"]["is_unlimited"] is True
        assert d2["user"]["plan_label"] == "UNLIMITED"

        me = client.get("/api/v1/users/me", headers=h1)
        assert me.status_code == 200
        assert me.json()["is_unlimited"] is True
        assert me.json()["plan_label"] == "UNLIMITED"

        usage = client.get("/api/v1/users/me/usage", headers=h2)
        assert usage.status_code == 200
        assert usage.json()["is_unlimited"] is True
        assert usage.json()["plan_label"] == "UNLIMITED"
    finally:
        monkeypatch.delenv("ADMIN_EMAILS", raising=False)
        get_settings.cache_clear()


def test_admin_bypasses_minutes_projects_storage_while_recording_usage_and_enforcing_safety(client, db_session, monkeypatch):
    admin_email = f"owner_{uuid.uuid4().hex[:8]}@example.com"
    monkeypatch.setenv("ADMIN_EMAILS", admin_email)
    get_settings.cache_clear()
    monkeypatch.setattr("app.api.v1.transcriptions.enqueue_transcription_job", lambda _job_id: "test-task")
    try:
        headers, reg = _register(client, admin_email)
        user_id = reg["user"]["id"]

        # Exceed FREE monthly minutes (30) and FREE storage (250 MB) in DB records
        db_session.add(UsageRecord(user_id=user_id, operation="transcription_minutes", quantity=45.5))
        db_session.commit()

        # Exceed FREE project limit (15) -> create 16 projects
        last_project_id = ""
        for idx in range(16):
            p_res = client.post(
                "/api/v1/projects",
                headers=headers,
                json={"title": f"Admin Project {idx}", "instrument": "piano", "transcription_mode": "polyphonic"},
            )
            assert p_res.status_code == 201, p_res.text
            last_project_id = p_res.json()["id"]

        # Seed 260 MB of existing MediaAsset storage (> 250 MB FREE limit)
        db_session.add(
            MediaAsset(
                project_id=last_project_id,
                user_id=user_id,
                asset_type="original",
                storage_path=f"users/{user_id}/projects/{last_project_id}/originals/seed.wav",
                original_filename="seed.wav",
                mime_type="audio/wav",
                size_bytes=260 * 1024 * 1024,
            )
        )
        db_session.commit()

        # Admin can still upload valid audio and start a transcription job
        up_res = client.post(
            "/api/v1/uploads",
            headers=headers,
            data={"project_id": last_project_id},
            files={"file": ("extra.wav", _make_wav_bytes(), "audio/wav")},
        )
        assert up_res.status_code == 201, up_res.text

        job_res = client.post(
            f"/api/v1/projects/{last_project_id}/transcriptions",
            headers=headers,
            json={"settings": {"instrument": "piano", "transcription_mode": "polyphonic"}},
        )
        assert job_res.status_code == 202, job_res.text
        created_job = db_session.query(TranscriptionJob).filter(TranscriptionJob.id == job_res.json()["id"]).first()
        if created_job:
            created_job.status = "cancelled"
            db_session.commit()

        # Actual usage is still recorded and reported accurately
        usage_res = client.get("/api/v1/users/me/usage", headers=headers)
        assert usage_res.status_code == 200
        u_body = usage_res.json()
        assert u_body["is_unlimited"] is True
        assert u_body["plan_label"] == "UNLIMITED"
        assert u_body["monthly_minutes_used"] == 45.5
        assert u_body["project_count"] == 16
        assert u_body["storage_used_mb"] >= 260.0

        # Non-subscription safety validations still apply to admins
        bad_ext = client.post(
            "/api/v1/uploads",
            headers=headers,
            data={"project_id": last_project_id},
            files={"file": ("malware.exe", b"MZ...", "application/octet-stream")},
        )
        assert bad_ext.status_code == 400
        assert client.get("/api/v1/users/me/usage").status_code == 401
    finally:
        monkeypatch.delenv("ADMIN_EMAILS", raising=False)
        get_settings.cache_clear()


def test_free_and_pro_limits_and_client_spoof_rejection(client, db_session, monkeypatch):
    monkeypatch.setenv("ADMIN_EMAILS", "")
    get_settings.cache_clear()

    # Frontend-supplied unlimited/admin fields must be ignored on registration & PATCH
    free_email = f"free_{uuid.uuid4().hex[:8]}@example.com"
    free_headers, free_reg = _register(
        client,
        free_email,
        extra={"is_unlimited": True, "is_admin": True, "plan_tier": "unlimited"},
    )
    assert free_reg["user"]["is_unlimited"] is False
    assert free_reg["user"]["plan_tier"] == "free"
    assert free_reg["user"]["plan_label"] == "FREE"

    patch_res = client.patch(
        "/api/v1/users/me",
        headers=free_headers,
        json={"display_name": "Updated", "is_unlimited": True, "plan_tier": "unlimited"},
    )
    assert patch_res.status_code == 200
    assert patch_res.json()["is_unlimited"] is False
    assert patch_res.json()["plan_label"] == "FREE"

    free_user_id = free_reg["user"]["id"]
    # Hit 30-min FREE transcription limit
    db_session.add(UsageRecord(user_id=free_user_id, operation="transcription_minutes", quantity=30.0))
    db_session.commit()

    # Create 16 FREE projects -> allowed (uncapped at application level)
    p_ids: list[str] = []
    for i in range(16):
        pr = client.post("/api/v1/projects", headers=free_headers, json={"title": f"Free {i}"})
        assert pr.status_code == 201, pr.text
        p_ids.append(pr.json()["id"])

    # Uploads beyond 250 MB are allowed (no arbitrary 250 MB private storage ceiling)
    db_session.add(
        MediaAsset(
            project_id=p_ids[0],
            user_id=free_user_id,
            asset_type="original",
            storage_path=f"users/{free_user_id}/projects/{p_ids[0]}/originals/big.wav",
            original_filename="big.wav",
            mime_type="audio/wav",
            size_bytes=260 * 1024 * 1024,
        )
    )
    db_session.commit()
    over_storage = client.post(
        "/api/v1/uploads",
        headers=free_headers,
        data={"project_id": p_ids[0]},
        files={"file": ("over.wav", _make_wav_bytes(), "audio/wav")},
    )
    assert over_storage.status_code == 201, over_storage.text

    usage_res = client.get("/api/v1/users/me/usage", headers=free_headers)
    assert usage_res.status_code == 200
    assert usage_res.json()["project_count"] == 16
    assert usage_res.json()["project_limit"] is None
    assert usage_res.json()["storage_limit_mb"] is None
    assert usage_res.json()["storage_quota_enforced"] is False
    assert usage_res.json()["storage_used_mb"] >= 260.0

    # Monthly minute limit enforced on transcription start
    over_min = client.post(
        f"/api/v1/projects/{p_ids[0]}/transcriptions",
        headers=free_headers,
        json={"settings": {"instrument": "piano", "transcription_mode": "polyphonic"}},
    )
    assert over_min.status_code == 403

    # PRO user retains PRO entitlements (300 min, is_unlimited=False, plan_label="PRO")
    pro_email = f"pro_{uuid.uuid4().hex[:8]}@example.com"
    pro_headers, pro_reg = _register(client, pro_email)
    pro_user = db_session.query(User).filter(User.id == pro_reg["user"]["id"]).first()
    assert pro_user is not None
    pro_user.plan_tier = "pro"
    db_session.commit()

    pro_usage = client.get("/api/v1/users/me/usage", headers=pro_headers)
    assert pro_usage.status_code == 200
    assert pro_usage.json()["is_unlimited"] is False
    assert pro_usage.json()["plan_label"] == "PRO"
    assert pro_usage.json()["monthly_minutes_limit"] == 300.0
