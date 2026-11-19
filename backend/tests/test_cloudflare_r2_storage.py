"""Tests for Cloudflare R2 object storage integration, local fallback compatibility, and worker/export flows."""

from __future__ import annotations

import io
import os
from unittest.mock import MagicMock, patch

import pytest

from app.core.config import get_settings
from app.models import MediaAsset, TranscriptionJob
from app.storage.service import StorageError, storage_service


def _configure_r2_env() -> None:
    os.environ["STORAGE_BACKEND"] = "r2"
    os.environ["R2_BUCKET_NAME"] = "scribasheet-prod-bucket"
    os.environ["R2_ENDPOINT_URL"] = "https://mock-account.r2.cloudflarestorage.com"
    os.environ["R2_ACCESS_KEY_ID"] = "mock-r2-access-key"
    os.environ["R2_SECRET_ACCESS_KEY"] = "mock-r2-secret-key"
    get_settings.cache_clear()


def _reset_local_env() -> None:
    os.environ["STORAGE_BACKEND"] = "local"
    for var in ("R2_BUCKET_NAME", "R2_ENDPOINT_URL", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"):
        os.environ.pop(var, None)
    get_settings.cache_clear()


def test_r2_storage_service_crud_streaming_metadata_and_error_handling():
    _configure_r2_env()
    try:
        settings = get_settings()
        assert settings.STORAGE_BACKEND == "r2"
        assert settings.effective_s3_bucket == "scribasheet-prod-bucket"
        assert settings.effective_s3_endpoint == "https://mock-account.r2.cloudflarestorage.com"
        assert settings.effective_s3_region == "auto"
        assert storage_service.is_object_storage is True

        bucket_store: dict[str, tuple[bytes, str]] = {}
        mock_s3 = MagicMock()
        mock_s3.put_object.side_effect = lambda Bucket, Key, Body, ContentType: bucket_store.__setitem__(
            Key, (Body, ContentType)
        )

        def _upload_fileobj(fileobj, Bucket, Key, ExtraArgs=None):
            data = fileobj.read()
            ctype = (ExtraArgs or {}).get("ContentType", "application/octet-stream")
            bucket_store[Key] = (data, ctype)

        mock_s3.upload_fileobj.side_effect = _upload_fileobj
        mock_s3.get_object.side_effect = lambda Bucket, Key: {"Body": io.BytesIO(bucket_store[Key][0])}
        mock_s3.head_object.side_effect = lambda Bucket, Key: (
            {"ContentLength": len(bucket_store[Key][0]), "ContentType": bucket_store[Key][1], "ETag": '"abc123"'}
            if Key in bucket_store
            else (_ for _ in ()).throw(FileNotFoundError("NoSuchKey"))
        )
        mock_s3.delete_object.side_effect = lambda Bucket, Key: bucket_store.pop(Key, None)

        with patch.object(storage_service, "_s3_client", return_value=mock_s3):
            key = storage_service.build_key("u1", "p1", "originals", "song.wav")
            assert key.startswith("users/u1/projects/p1/originals/")

            job_key = storage_service.build_key("u1", "p1", "midi", "out.mid", job_id="j1")
            assert job_key.startswith("users/u1/projects/p1/jobs/j1/midi/")

            # Stream upload (does not buffer whole file in save_stream)
            saved_key, size = storage_service.save_stream(key, io.BytesIO(b"RIFFWAVE_DATA"), content_type="audio/wav")
            assert saved_key == key
            assert size == len(b"RIFFWAVE_DATA")
            assert storage_service.exists(key) is True

            meta = storage_service.get_object_metadata(key)
            assert meta == {"size_bytes": 13, "content_type": "audio/wav", "etag": "abc123"}
            assert storage_service.read_bytes(key) == b"RIFFWAVE_DATA"

            # Path traversal rejected
            with pytest.raises(ValueError, match="traversal"):
                storage_service.save_bytes("../escape.wav", b"bad")

            # Delete
            storage_service.delete(key)
            assert storage_service.exists(key) is False

            # R2 failure must raise StorageError (never silently fall back to local)
            mock_s3.put_object.side_effect = RuntimeError("R2 connection refused")
            with pytest.raises(StorageError, match="R2"):
                storage_service.save_bytes(job_key, b"MThd")
    finally:
        _reset_local_env()


def test_local_storage_compatibility_preserved():
    _reset_local_env()
    assert storage_service.backend == "local"
    assert storage_service.is_object_storage is False
    key = storage_service.build_key("u_local", "p_local", "originals", "local.wav")
    storage_service.save_bytes(key, b"LOCAL_WAV", content_type="audio/wav")
    assert storage_service.exists(key) is True
    assert storage_service.read_bytes(key) == b"LOCAL_WAV"
    storage_service.delete(key)
    assert storage_service.exists(key) is False


def test_r2_end_to_end_upload_worker_and_exports_with_mocked_s3(client, db_session):
    prev_job_mode = os.environ.get("JOB_EXECUTION_MODE")
    prev_worker_token = os.environ.get("WORKER_API_TOKEN")
    _configure_r2_env()
    os.environ["JOB_EXECUTION_MODE"] = "remote_worker"
    os.environ["WORKER_API_TOKEN"] = "r2-worker-token"
    get_settings.cache_clear()

    try:
        bucket_store: dict[str, tuple[bytes, str]] = {}
        mock_s3 = MagicMock()
        mock_s3.put_object.side_effect = lambda Bucket, Key, Body, ContentType: bucket_store.__setitem__(
            Key, (Body, ContentType)
        )
        mock_s3.upload_fileobj.side_effect = lambda f, Bucket, Key, ExtraArgs=None: bucket_store.__setitem__(
            Key, (f.read(), (ExtraArgs or {}).get("ContentType", "application/octet-stream"))
        )
        mock_s3.get_object.side_effect = lambda Bucket, Key: {"Body": io.BytesIO(bucket_store[Key][0])}
        mock_s3.head_object.side_effect = lambda Bucket, Key: (
            {"ContentLength": len(bucket_store[Key][0]), "ContentType": bucket_store[Key][1]}
            if Key in bucket_store
            else (_ for _ in ()).throw(FileNotFoundError("NoSuchKey"))
        )
        mock_s3.generate_presigned_url.side_effect = (
            lambda op, Params, ExpiresIn: f"https://r2.mock/{op}/{Params['Key']}?exp={ExpiresIn}"
        )

        with patch.object(storage_service, "_s3_client", return_value=mock_s3):
            reg1 = client.post(
                "/api/v1/auth/register",
                json={"email": "r2_owner@example.com", "password": "StrongPassword123!", "display_name": "Owner"},
            )
            h1 = {"Authorization": f"Bearer {reg1.json()['access_token']}"}
            reg2 = client.post(
                "/api/v1/auth/register",
                json={"email": "r2_other@example.com", "password": "StrongPassword123!", "display_name": "Other"},
            )
            h2 = {"Authorization": f"Bearer {reg2.json()['access_token']}"}

            proj = client.post("/api/v1/projects", headers=h1, json={"title": "R2 E2E Song"}).json()
            project_id = proj["id"]

            # 1. Presign & Confirm upload in R2
            presign = client.post(
                "/api/v1/uploads/presign",
                headers=h1,
                json={"project_id": project_id, "filename": "demo.wav", "content_type": "audio/wav", "size_bytes": 44},
            )
            assert presign.status_code == 200
            upload_key = presign.json()["key"]
            bucket_store[upload_key] = (b"RIFF" + b"\x00" * 40, "audio/wav")

            confirm = client.post(
                "/api/v1/uploads/confirm",
                headers=h1,
                json={
                    "project_id": project_id,
                    "storage_key": upload_key,
                    "filename": "demo.wav",
                    "content_type": "audio/wav",
                    "size_bytes": 44,
                },
            )
            assert confirm.status_code == 201
            asset_id = confirm.json()["id"]

            # Cross-user access denied
            assert client.get(f"/api/v1/uploads/{asset_id}/signed-url", headers=h2).status_code == 403
            signed = client.get(f"/api/v1/uploads/{asset_id}/signed-url", headers=h1)
            assert signed.status_code == 200
            assert "get_object" in signed.json()["url"]

            # 2. Enqueue & Claim job -> Worker receives R2 download & upload URLs
            job_res = client.post(
                f"/api/v1/projects/{project_id}/transcriptions",
                headers=h1,
                json={"source_asset_id": asset_id},
            )
            assert job_res.status_code == 202
            job_id = job_res.json()["id"]

            w_headers = {"X-Worker-Token": "r2-worker-token"}
            claim = client.post("/api/v1/worker/jobs/claim", headers=w_headers, json={"worker_id": "win-r2"})
            assert claim.status_code == 200
            claimed_job = claim.json()["job"]
            assert "get_object" in claimed_job["source_download_url"]
            midi_key = claimed_job["artifact_upload_urls"]["midi"]["key"]
            xml_key = claimed_job["artifact_upload_urls"]["musicxml"]["key"]

            # Simulate worker uploading MIDI & MusicXML to R2
            bucket_store[midi_key] = (b"MThd\x00\x00\x00\x06\x00\x01\x00\x01\x01\xe0", "audio/midi")
            bucket_store[xml_key] = (b"<?xml version='1.0'?><score-partwise/>", "application/vnd.recordare.musicxml+xml")

            complete = client.post(
                f"/api/v1/worker/jobs/{job_id}/complete",
                headers=w_headers,
                json={
                    "worker_id": "win-r2",
                    "duration_seconds": 4.0,
                    "midi_key": midi_key,
                    "musicxml_key": xml_key,
                    "score_json": {
                        "title": "R2 E2E Song",
                        "tempo_bpm": 120.0,
                        "time_signature": "4/4",
                        "key_signature": "C major",
                        "duration_seconds": 4.0,
                        "tracks": [{"index": 0, "name": "Piano", "instrument": "piano", "clef": "grand"}],
                        "notes": [{"id": "n1", "pitch_midi": 60, "onset_sec": 0.0, "offset_sec": 1.0, "velocity": 90, "track_index": 0}],
                        "chords": [],
                    },
                },
            )
            assert complete.status_code == 200
            job_row = db_session.query(TranscriptionJob).filter(TranscriptionJob.id == job_id).first()
            assert job_row.status == "completed"
            midi_asset = db_session.query(MediaAsset).filter(MediaAsset.storage_path == midi_key).first()
            assert midi_asset is not None and midi_asset.size_bytes == 14

            # 3. MusicXML, MIDI, and PDF exports via R2
            for fmt in ("musicxml", "midi", "pdf"):
                exp = client.post(f"/api/v1/projects/{project_id}/exports", headers=h1, json={"format": fmt})
                assert exp.status_code == 201, exp.text
                exp_id = exp.json()["id"]
                dl = client.get(f"/api/v1/exports/{exp_id}/download", headers=h1)
                assert dl.status_code == 200
                assert len(dl.content) > 0
    finally:
        if prev_job_mode is None:
            os.environ.pop("JOB_EXECUTION_MODE", None)
        else:
            os.environ["JOB_EXECUTION_MODE"] = prev_job_mode
        if prev_worker_token is None:
            os.environ.pop("WORKER_API_TOKEN", None)
        else:
            os.environ["WORKER_API_TOKEN"] = prev_worker_token
        _reset_local_env()
