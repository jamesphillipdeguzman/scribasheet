"""Backend integration tests for replacing project audio with trimmed WAV uploads."""

from __future__ import annotations

import io
import math
import struct
import uuid
import wave

from app.models import MediaAsset, Project, TranscriptionJob
from app.storage.service import storage_service


def _register_and_auth(client, email_prefix: str = "trim_user") -> dict[str, str]:
    email = f"{email_prefix}_{uuid.uuid4().hex[:8]}@example.com"
    res = client.post(
        "/api/v1/auth/register",
        json={"email": email, "password": "StrongPassword123!", "display_name": "Trim Tester"},
    )
    assert res.status_code in (200, 201), res.text
    token = res.json()["access_token"]
    return {"Authorization": f"Bearer {token}"}


def _create_project(client, headers: dict[str, str], title: str = "Trim Project") -> str:
    res = client.post(
        "/api/v1/projects",
        headers=headers,
        json={"title": title, "instrument": "piano", "transcription_mode": "piano"},
    )
    assert res.status_code == 201, res.text
    return res.json()["id"]


def _make_wav_bytes(duration_sec: float = 1.2, sample_rate: int = 22050, channels: int = 1) -> bytes:
    buf = io.BytesIO()
    n_frames = int(duration_sec * sample_rate)
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(channels)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        frames = bytearray()
        for i in range(n_frames):
            val = int(10000 * math.sin(2 * math.pi * 440.0 * i / sample_rate))
            for _ in range(channels):
                frames.extend(struct.pack("<h", val))
        wf.writeframes(bytes(frames))
    return buf.getvalue()


def test_replace_original_audio_with_trimmed_wav_updates_project_and_allows_transcription(client, db_session):
    headers = _register_and_auth(client)
    project_id = _create_project(client, headers)

    orig_bytes = _make_wav_bytes(duration_sec=2.0, sample_rate=44100, channels=2)
    orig_res = client.post(
        "/api/v1/uploads",
        headers=headers,
        data={"project_id": project_id},
        files={"file": ("tab-audio-take1.webm", orig_bytes, "audio/wav")},
    )
    assert orig_res.status_code == 201, orig_res.text
    orig_asset = orig_res.json()
    orig_db = db_session.query(MediaAsset).filter(MediaAsset.id == orig_asset["id"]).first()
    assert orig_db is not None
    orig_storage = orig_db.storage_path
    assert storage_service.exists(orig_storage)

    # Create a historical completed job referencing the original asset (ensure FK stays intact on replacement)
    hist_job = TranscriptionJob(
        project_id=project_id,
        user_id=orig_db.user_id,
        source_asset_id=orig_asset["id"],
        status="completed",
        progress=100,
        current_stage="Completed",
        engine="basic_pitch",
        settings_json={"mode": "piano", "instrument": "piano"},
    )
    db_session.add(hist_job)
    db_session.commit()
    db_session.refresh(hist_job)

    trimmed_bytes = _make_wav_bytes(duration_sec=0.8, sample_rate=44100, channels=2)
    trim_res = client.post(
        "/api/v1/uploads",
        headers=headers,
        data={"project_id": project_id, "replace_asset_id": orig_asset["id"]},
        files={"file": ("tab-audio-take1-trimmed.wav", trimmed_bytes, "audio/wav")},
    )
    assert trim_res.status_code == 201, trim_res.text
    trimmed_asset = trim_res.json()
    assert trimmed_asset["id"] != orig_asset["id"]
    assert abs(trimmed_asset["duration_seconds"] - 0.8) < 0.08
    assert trimmed_asset["sample_rate"] == 44100
    assert trimmed_asset["channels"] == 2

    db_session.expire_all()
    assert db_session.query(MediaAsset).filter(MediaAsset.id == orig_asset["id"]).first() is None
    assert not storage_service.exists(orig_storage)
    project = db_session.query(Project).filter(Project.id == project_id).first()
    assert project is not None
    assert abs((project.duration_seconds or 0.0) - 0.8) < 0.08

    # Can start transcription immediately with trimmed asset
    job_res = client.post(
        f"/api/v1/projects/{project_id}/transcriptions",
        headers=headers,
        json={"source_asset_id": trimmed_asset["id"], "settings": {"mode": "piano", "instrument": "piano"}},
    )
    assert job_res.status_code == 202, job_res.text
    assert job_res.json()["source_asset_id"] == trimmed_asset["id"]


def test_failed_or_blocked_trim_upload_preserves_original_asset_and_bytes(client, db_session):
    headers = _register_and_auth(client)
    project_id = _create_project(client, headers)

    orig_bytes = _make_wav_bytes(duration_sec=1.5)
    orig_res = client.post(
        "/api/v1/uploads",
        headers=headers,
        data={"project_id": project_id},
        files={"file": ("original.wav", orig_bytes, "audio/wav")},
    )
    assert orig_res.status_code == 201
    orig_id = orig_res.json()["id"]
    orig_db = db_session.query(MediaAsset).filter(MediaAsset.id == orig_id).first()
    assert orig_db is not None

    # 1. Corrupt WAV payload rejected -> original kept intact
    bad_res = client.post(
        "/api/v1/uploads",
        headers=headers,
        data={"project_id": project_id, "replace_asset_id": orig_id},
        files={"file": ("broken-trimmed.wav", b"not-a-valid-wav-file", "audio/wav")},
    )
    assert bad_res.status_code == 400
    db_session.expire_all()
    assert db_session.query(MediaAsset).filter(MediaAsset.id == orig_id).first() is not None
    assert storage_service.exists(orig_db.storage_path)

    # 2. Replacing while transcription is queued/running is rejected with 409 -> original kept intact
    active_job = TranscriptionJob(
        project_id=project_id,
        user_id=orig_db.user_id,
        source_asset_id=orig_id,
        status="transcribing",
        progress=50,
        current_stage="Transcribing",
        engine="basic_pitch",
        settings_json={},
    )
    db_session.add(active_job)
    db_session.commit()

    blocked_res = client.post(
        "/api/v1/uploads",
        headers=headers,
        data={"project_id": project_id, "replace_asset_id": orig_id},
        files={"file": ("trimmed.wav", _make_wav_bytes(0.7), "audio/wav")},
    )
    assert blocked_res.status_code == 409
    assert db_session.query(MediaAsset).filter(MediaAsset.id == orig_id).first() is not None
    assert storage_service.exists(orig_db.storage_path)


def test_replacing_extracted_video_audio_keeps_uploaded_video_intact(client, db_session):
    headers = _register_and_auth(client)
    project_id = _create_project(client, headers)

    orig_video = MediaAsset(
        project_id=project_id,
        user_id=db_session.query(Project).filter(Project.id == project_id).first().user_id,
        asset_type="original",
        storage_path="test/video.mp4",
        original_filename="recital.mp4",
        mime_type="video/mp4",
        size_bytes=2048,
        duration_seconds=3.0,
    )
    extracted_wav = MediaAsset(
        project_id=project_id,
        user_id=orig_video.user_id,
        asset_type="extracted_audio",
        storage_path="test/extracted.wav",
        original_filename="recital.wav",
        mime_type="audio/wav",
        size_bytes=1024,
        duration_seconds=3.0,
    )
    db_session.add(orig_video)
    db_session.add(extracted_wav)
    db_session.commit()
    db_session.refresh(extracted_wav)

    trimmed_bytes = _make_wav_bytes(duration_sec=1.1, sample_rate=44100, channels=1)
    res = client.post(
        "/api/v1/uploads",
        headers=headers,
        data={"project_id": project_id, "replace_asset_id": extracted_wav.id},
        files={"file": ("recital-trimmed.wav", trimmed_bytes, "audio/wav")},
    )
    assert res.status_code == 201, res.text
    db_session.expire_all()
    assert db_session.query(MediaAsset).filter(MediaAsset.id == orig_video.id).first() is not None
