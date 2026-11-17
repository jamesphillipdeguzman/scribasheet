import io
import math
import struct
import uuid
import wave

from app.models import Export, MediaAsset, Project, ProjectScore, TranscriptionJob
from app.storage.service import storage_service


def _register_and_auth(client, email_prefix: str = "media_user") -> dict[str, str]:
    email = f"{email_prefix}_{uuid.uuid4().hex[:8]}@example.com"
    res = client.post(
        "/api/v1/auth/register",
        json={"email": email, "password": "StrongPassword123!", "display_name": "Media Tester"},
    )
    assert res.status_code in (200, 201), res.text
    token = res.json()["access_token"]
    return {"Authorization": f"Bearer {token}"}


def _create_project(client, headers: dict[str, str], title: str = "Removal Test Project") -> str:
    res = client.post(
        "/api/v1/projects",
        headers=headers,
        json={"title": title, "instrument": "piano", "transcription_mode": "polyphonic"},
    )
    assert res.status_code == 201, res.text
    return res.json()["id"]


def _make_wav_bytes(duration_sec: float = 0.5, sample_rate: int = 22050) -> bytes:
    buf = io.BytesIO()
    n_frames = int(duration_sec * sample_rate)
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        frames = bytearray()
        for i in range(n_frames):
            sample = int(12000 * math.sin(2 * math.pi * 440.0 * i / sample_rate))
            frames.extend(struct.pack("<h", sample))
        wf.writeframes(bytes(frames))
    return buf.getvalue()


def _get_storage_path(db_session, asset_id: str) -> str:
    db_asset = db_session.query(MediaAsset).filter(MediaAsset.id == asset_id).first()
    assert db_asset is not None
    return db_asset.storage_path


def test_delete_original_media_without_score_resets_project_to_draft(client, db_session):
    headers = _register_and_auth(client)
    project_id = _create_project(client, headers)

    wav_bytes = _make_wav_bytes()
    upload_res = client.post(
        "/api/v1/uploads",
        headers=headers,
        data={"project_id": project_id},
        files={"file": ("take1.wav", wav_bytes, "audio/wav")},
    )
    assert upload_res.status_code == 201, upload_res.text
    asset = upload_res.json()
    storage_path = _get_storage_path(db_session, asset["id"])
    assert storage_service.exists(storage_path)

    del_res = client.delete(f"/api/v1/projects/{project_id}/media/{asset['id']}", headers=headers)
    assert del_res.status_code == 204, del_res.text
    assert not storage_service.exists(storage_path)

    db_session.expire_all()
    assert db_session.query(MediaAsset).filter(MediaAsset.id == asset["id"]).first() is None
    project = db_session.query(Project).filter(Project.id == project_id).first()
    assert project is not None
    assert project.duration_seconds is None
    assert project.status == "draft"


def test_delete_original_media_preserves_existing_score_and_exports(client, db_session):
    headers = _register_and_auth(client)
    project_id = _create_project(client, headers)

    wav_bytes = _make_wav_bytes()
    upload_res = client.post(
        "/api/v1/uploads",
        headers=headers,
        data={"project_id": project_id},
        files={"file": ("piece.wav", wav_bytes, "audio/wav")},
    )
    assert upload_res.status_code == 201, upload_res.text
    asset = upload_res.json()

    project = db_session.query(Project).filter(Project.id == project_id).first()
    assert project is not None
    project.status = "ready"
    score = ProjectScore(
        project_id=project_id,
        version=2,
        score_json={"title": "Saved Piece", "tempo_bpm": 100, "measures": []},
        musicxml_path=f"users/{project.user_id}/projects/{project_id}/scores/score.musicxml",
        midi_path=f"users/{project.user_id}/projects/{project_id}/scores/score.mid",
    )
    export = Export(
        project_id=project_id,
        user_id=project.user_id,
        format="pdf",
        status="completed",
        storage_path=f"users/{project.user_id}/projects/{project_id}/exports/score.pdf",
    )
    db_session.add(score)
    db_session.add(export)
    db_session.commit()

    storage_path = _get_storage_path(db_session, asset["id"])
    del_res = client.delete(f"/api/v1/projects/{project_id}/media/{asset['id']}", headers=headers)
    assert del_res.status_code == 204, del_res.text
    assert not storage_service.exists(storage_path)

    db_session.expire_all()
    assert db_session.query(MediaAsset).filter(MediaAsset.id == asset["id"]).first() is None
    refreshed_project = db_session.query(Project).filter(Project.id == project_id).first()
    assert refreshed_project is not None
    assert refreshed_project.status == "ready"
    refreshed_score = db_session.query(ProjectScore).filter(ProjectScore.project_id == project_id).first()
    assert refreshed_score is not None
    assert refreshed_score.version == 2
    assert refreshed_score.musicxml_path is not None
    assert refreshed_score.midi_path is not None
    assert db_session.query(Export).filter(Export.project_id == project_id).count() == 1


def test_delete_media_returns_409_when_transcription_job_is_active(client, db_session):
    headers = _register_and_auth(client)
    project_id = _create_project(client, headers)

    upload_res = client.post(
        "/api/v1/uploads",
        headers=headers,
        data={"project_id": project_id},
        files={"file": ("active.wav", _make_wav_bytes(), "audio/wav")},
    )
    assert upload_res.status_code == 201, upload_res.text
    asset = upload_res.json()

    project = db_session.query(Project).filter(Project.id == project_id).first()
    job = TranscriptionJob(
        project_id=project_id,
        user_id=project.user_id,
        source_asset_id=asset["id"],
        status="transcribing",
        progress=45,
        current_stage="Transcribing",
        engine="basic_pitch",
    )
    db_session.add(job)
    db_session.commit()

    storage_path = _get_storage_path(db_session, asset["id"])
    del_res = client.delete(f"/api/v1/projects/{project_id}/media/{asset['id']}", headers=headers)
    assert del_res.status_code == 409, del_res.text
    assert storage_service.exists(storage_path)
    assert db_session.query(MediaAsset).filter(MediaAsset.id == asset["id"]).first() is not None

    job.status = "cancelled"
    db_session.commit()


def test_delete_media_rejects_other_users_project(client, db_session):
    owner_headers = _register_and_auth(client, "owner")
    other_headers = _register_and_auth(client, "other")
    project_id = _create_project(client, owner_headers)

    upload_res = client.post(
        "/api/v1/uploads",
        headers=owner_headers,
        data={"project_id": project_id},
        files={"file": ("private.wav", _make_wav_bytes(), "audio/wav")},
    )
    assert upload_res.status_code == 201, upload_res.text
    asset = upload_res.json()
    storage_path = _get_storage_path(db_session, asset["id"])

    del_res = client.delete(f"/api/v1/projects/{project_id}/media/{asset['id']}", headers=other_headers)
    assert del_res.status_code in (403, 404), del_res.text
    assert storage_service.exists(storage_path)


def test_delete_media_returns_404_for_missing_or_wrong_project_asset(client, db_session):
    headers = _register_and_auth(client)
    project_a = _create_project(client, headers, "Project A")
    project_b = _create_project(client, headers, "Project B")

    upload_res = client.post(
        "/api/v1/uploads",
        headers=headers,
        data={"project_id": project_a},
        files={"file": ("a.wav", _make_wav_bytes(), "audio/wav")},
    )
    assert upload_res.status_code == 201, upload_res.text
    asset_a = upload_res.json()
    storage_path = _get_storage_path(db_session, asset_a["id"])

    missing_res = client.delete(f"/api/v1/projects/{project_a}/media/{uuid.uuid4()}", headers=headers)
    assert missing_res.status_code == 404

    wrong_project_res = client.delete(f"/api/v1/projects/{project_b}/media/{asset_a['id']}", headers=headers)
    assert wrong_project_res.status_code == 404
    assert storage_service.exists(storage_path)


def test_delete_media_requires_authentication(client):
    headers = _register_and_auth(client)
    project_id = _create_project(client, headers)

    upload_res = client.post(
        "/api/v1/uploads",
        headers=headers,
        data={"project_id": project_id},
        files={"file": ("auth.wav", _make_wav_bytes(), "audio/wav")},
    )
    assert upload_res.status_code == 201, upload_res.text
    asset = upload_res.json()

    unauth_res = client.delete(f"/api/v1/projects/{project_id}/media/{asset['id']}")
    assert unauth_res.status_code == 401


def test_delete_media_rejects_non_original_asset(client, db_session):
    headers = _register_and_auth(client)
    project_id = _create_project(client, headers)
    project = db_session.query(Project).filter(Project.id == project_id).first()

    key = storage_service.build_key(project.user_id, project_id, "scores", "out.mid")
    storage_service.save_bytes(key, b"MThd\x00\x00\x00\x06\x00\x01\x00\x01\x01\xe0")
    midi_asset = MediaAsset(
        project_id=project_id,
        user_id=project.user_id,
        asset_type="midi",
        storage_path=key,
        original_filename="out.mid",
        mime_type="audio/midi",
        size_bytes=14,
    )
    db_session.add(midi_asset)
    db_session.commit()
    db_session.refresh(midi_asset)

    del_res = client.delete(f"/api/v1/projects/{project_id}/media/{midi_asset.id}", headers=headers)
    assert del_res.status_code == 400
    assert db_session.query(MediaAsset).filter(MediaAsset.id == midi_asset.id).first() is not None


def test_delete_media_handles_missing_physical_file_safely(client, db_session):
    headers = _register_and_auth(client)
    project_id = _create_project(client, headers)

    upload_res = client.post(
        "/api/v1/uploads",
        headers=headers,
        data={"project_id": project_id},
        files={"file": ("missing_disk.wav", _make_wav_bytes(), "audio/wav")},
    )
    assert upload_res.status_code == 201, upload_res.text
    asset = upload_res.json()

    # Remove physical file before calling API
    storage_path = _get_storage_path(db_session, asset["id"])
    storage_service.delete(storage_path)
    assert not storage_service.exists(storage_path)

    del_res = client.delete(f"/api/v1/projects/{project_id}/media/{asset['id']}", headers=headers)
    assert del_res.status_code == 204
    db_session.expire_all()
    assert db_session.query(MediaAsset).filter(MediaAsset.id == asset["id"]).first() is None


def test_upload_replacement_after_removal_updates_project_and_transcription_source(client, db_session, monkeypatch):
    headers = _register_and_auth(client)
    project_id = _create_project(client, headers)

    first_res = client.post(
        "/api/v1/uploads",
        headers=headers,
        data={"project_id": project_id},
        files={"file": ("first.wav", _make_wav_bytes(0.4), "audio/wav")},
    )
    assert first_res.status_code == 201, first_res.text
    first_asset = first_res.json()

    del_res = client.delete(f"/api/v1/projects/{project_id}/media/{first_asset['id']}", headers=headers)
    assert del_res.status_code == 204

    second_res = client.post(
        "/api/v1/uploads",
        headers=headers,
        data={"project_id": project_id},
        files={"file": ("second.wav", _make_wav_bytes(1.2), "audio/wav")},
    )
    assert second_res.status_code == 201, second_res.text
    second_asset = second_res.json()
    assert second_asset["id"] != first_asset["id"]

    db_session.expire_all()
    project = db_session.query(Project).filter(Project.id == project_id).first()
    assert project is not None
    assert project.duration_seconds is not None and project.duration_seconds > 1.0

    # Avoid spawning background thread during test
    monkeypatch.setattr("app.api.v1.transcriptions.enqueue_transcription_job", lambda job_id: "test-task")
    job_res = client.post(
        f"/api/v1/projects/{project_id}/transcriptions",
        headers=headers,
        json={"settings": {"instrument": "piano", "transcription_mode": "polyphonic"}},
    )
    assert job_res.status_code == 202, job_res.text
    job_data = job_res.json()
    assert job_data["source_asset_id"] == second_asset["id"]

    # Clean up queued job so subsequent worker tests in the shared session DB are unaffected
    created_job = db_session.query(TranscriptionJob).filter(TranscriptionJob.id == job_data["id"]).first()
    if created_job:
        created_job.status = "cancelled"
        db_session.commit()
