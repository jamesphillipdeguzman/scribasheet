"""Tests for safe legacy local-to-R2 migration and one-click MusicXML recovery."""

from __future__ import annotations

import io
import logging
import os
import threading
import time
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import MagicMock, patch
from uuid import uuid4

import pytest
from botocore.exceptions import ClientError

from app.core.config import get_settings
from app.models import ProjectScore
from app.storage.service import StorageError, storage_service


class _MockR2Bucket:
    """Thread-safe in-memory S3/R2 bucket mock supporting boto3 ClientError 404 semantics."""

    def __init__(self, *, fail_put: bool = False, corrupt_read: bool = False) -> None:
        self._lock = threading.Lock()
        self.objects: dict[str, tuple[bytes, str]] = {}
        self.put_calls: list[str] = []
        self.fail_put = fail_put
        self.corrupt_read = corrupt_read

    def make_client(self) -> MagicMock:
        mock_s3 = MagicMock()

        def _head_object(Bucket: str, Key: str):
            with self._lock:
                if Key not in self.objects:
                    raise ClientError(
                        {"Error": {"Code": "404", "Message": "Not Found"}, "ResponseMetadata": {"HTTPStatusCode": 404}},
                        "HeadObject",
                    )
                body, ctype = self.objects[Key]
                return {"ContentLength": len(body), "ContentType": ctype, "ETag": '"etag-test"'}

        def _get_object(Bucket: str, Key: str):
            with self._lock:
                if Key not in self.objects:
                    raise ClientError(
                        {"Error": {"Code": "NoSuchKey", "Message": "NoSuchKey"}, "ResponseMetadata": {"HTTPStatusCode": 404}},
                        "GetObject",
                    )
                body, _ = self.objects[Key]
                if self.corrupt_read and Key.endswith(".musicxml"):
                    return {"Body": io.BytesIO(b"")}
                return {"Body": io.BytesIO(body)}

        def _put_object(Bucket: str, Key: str, Body: bytes, ContentType: str = "application/octet-stream"):
            if self.fail_put:
                raise RuntimeError("Simulated R2 put_object failure")
            # Tiny sleep widens race window in concurrency tests without slowing normal tests noticeably
            time.sleep(0.005)
            with self._lock:
                self.put_calls.append(Key)
                self.objects[Key] = (bytes(Body), ContentType)

        def _delete_object(Bucket: str, Key: str):
            with self._lock:
                self.objects.pop(Key, None)

        mock_s3.head_object.side_effect = _head_object
        mock_s3.get_object.side_effect = _get_object
        mock_s3.put_object.side_effect = _put_object
        mock_s3.delete_object.side_effect = _delete_object
        return mock_s3


SAMPLE_LEGACY_XML = """<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <work><work-title>Legacy Nocturne</work-title></work>
  <part-list>
    <score-part id="P1"><part-name>Piano</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>4</divisions>
        <key><fifths>-1</fifths><mode>major</mode></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef>
      </attributes>
      <note><pitch><step>F</step><octave>4</octave></pitch><duration>16</duration><type>whole</type></note>
    </measure>
  </part>
</score-partwise>
"""


def _configure_s3_with_legacy_root(legacy_root: Path):
    prev = {
        k: os.environ.get(k)
        for k in (
            "STORAGE_BACKEND",
            "LOCAL_STORAGE_ROOT",
            "S3_ENDPOINT_URL",
            "S3_BUCKET_NAME",
            "S3_ACCESS_KEY_ID",
            "S3_SECRET_ACCESS_KEY",
            "S3_REGION",
        )
    }
    os.environ["STORAGE_BACKEND"] = "s3"
    os.environ["LOCAL_STORAGE_ROOT"] = str(legacy_root)
    os.environ["S3_ENDPOINT_URL"] = "https://mock-r2-secret.example.com"
    os.environ["S3_BUCKET_NAME"] = "scribasheet-private-test"
    os.environ["S3_ACCESS_KEY_ID"] = "secret-access-key-id"
    os.environ["S3_SECRET_ACCESS_KEY"] = "secret-access-key-value"
    os.environ["S3_REGION"] = "auto"
    get_settings.cache_clear()
    return prev


def _restore_env(prev: dict[str, str | None]) -> None:
    for k, val in prev.items():
        if val is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = val
    get_settings.cache_clear()


def _create_user_and_project(client, title: str = "Recovery Test Project") -> tuple[dict[str, str], str, str]:
    reg = client.post(
        "/api/v1/auth/register",
        json={
            "email": f"recover_{uuid4().hex[:8]}@example.com",
            "password": "StrongPassword123!",
            "display_name": "Recovery Tester",
        },
    )
    assert reg.status_code == 201, reg.text
    token = reg.json()["access_token"]
    headers = {"Authorization": f"Bearer {token}"}

    me = client.get("/api/v1/users/me", headers=headers)
    user_id = me.json()["id"]

    proj = client.post(
        "/api/v1/projects",
        headers=headers,
        json={"title": title, "instrument": "piano", "transcription_mode": "single_instrument"},
    )
    assert proj.status_code == 201, proj.text
    return headers, user_id, proj.json()["id"]


def test_scenario_1_and_7_legacy_migration_without_overwriting_existing_r2(tmp_path, client, db_session, caplog):
    """Scenario 1 & 7: Auto-migrate missing R2 object from legacy local root, preserve local file, never overwrite R2."""
    legacy_root = tmp_path / "legacy_storage"
    legacy_root.mkdir(parents=True, exist_ok=True)
    prev_env = _configure_s3_with_legacy_root(legacy_root)
    bucket = _MockR2Bucket()

    try:
        headers, user_id, project_id = _create_user_and_project(client, title="Legacy Nocturne")

        xml_key = f"users/{user_id}/projects/{project_id}/musicxml/legacy_score.musicxml"
        midi_key = f"users/{user_id}/projects/{project_id}/midi/legacy_score.mid"
        legacy_xml_file = legacy_root / xml_key
        legacy_xml_file.parent.mkdir(parents=True, exist_ok=True)
        legacy_xml_file.write_bytes(SAMPLE_LEGACY_XML.encode("utf-8"))

        legacy_midi_file = legacy_root / midi_key
        legacy_midi_file.parent.mkdir(parents=True, exist_ok=True)
        legacy_midi_file.write_bytes(b"MThd\x00\x00\x00\x06\x00\x01\x00\x01\x01\xe0")

        score_row = ProjectScore(
            project_id=project_id,
            version=4,
            score_json={
                "title": "Legacy Nocturne",
                "tempo_bpm": 100.0,
                "tempo_estimated": False,
                "time_signature": "4/4",
                "time_signature_estimated": False,
                "key_signature": "F major",
                "key_signature_estimated": False,
                "duration_seconds": 2.4,
                "tracks": [{"index": 0, "name": "Piano", "instrument": "piano", "clef": "treble", "program": 0, "muted": False}],
                "notes": [{"id": "n1", "pitch_midi": 65, "onset_sec": 0.0, "offset_sec": 2.4, "velocity": 80, "track_index": 0}],
                "chords": [],
                "analysis": {},
            },
            musicxml_path=xml_key,
            midi_path=midi_key,
        )
        db_session.add(score_row)
        db_session.commit()

        with caplog.at_level(logging.INFO, logger="app.storage.service"):
            with patch.object(storage_service, "_s3_client", return_value=bucket.make_client()):
                # Scenario 1: Not in R2 yet -> GET /score triggers safe migration & serves original MusicXML
                res = client.get(f"/api/v1/projects/{project_id}/score", headers=headers)
                assert res.status_code == 200
                body = res.json()
                assert body["musicxml"] is not None
                assert "<step>F</step>" in body["musicxml"]
                assert xml_key in bucket.objects
                assert bucket.objects[xml_key][1] == "application/vnd.recordare.musicxml+xml"
                # Original DB reference & version preserved
                db_session.refresh(score_row)
                assert score_row.musicxml_path == xml_key
                assert score_row.version == 4
                # Legacy local file intentionally preserved (not deleted)
                assert legacy_xml_file.exists()

                # Logs must not leak local filesystem paths or R2 endpoint/secrets
                log_text = "\n".join(r.getMessage() for r in caplog.records)
                assert str(legacy_root) not in log_text
                assert "mock-r2-secret.example.com" not in log_text
                assert "secret-access-key" not in log_text

                # Scenario 7: When a different valid MusicXML already exists in R2, do NOT overwrite it with legacy copy
                r2_existing_xml = SAMPLE_LEGACY_XML.replace("<step>F</step>", "<step>A</step>").encode("utf-8")
                bucket.objects[xml_key] = (r2_existing_xml, "application/vnd.recordare.musicxml+xml")
                put_count_before = len(bucket.put_calls)

                res_r2 = client.get(f"/api/v1/projects/{project_id}/score", headers=headers)
                assert res_r2.status_code == 200
                assert "<step>A</step>" in res_r2.json()["musicxml"]
                assert len(bucket.put_calls) == put_count_before

                rec_existing = client.post(
                    f"/api/v1/projects/{project_id}/score/recover",
                    headers=headers,
                    json={"create_blank_if_empty": False},
                )
                assert rec_existing.status_code == 200
                assert rec_existing.json()["status"] == "already_available"
                assert "<step>A</step>" in rec_existing.json()["score"]["musicxml"]
                assert len(bucket.put_calls) == put_count_before
                db_session.refresh(score_row)
                assert score_row.version == 4
    finally:
        _restore_env(prev_env)


def test_scenario_2_and_3_missing_everywhere_then_rebuild_from_notes(tmp_path, client, db_session):
    """Scenario 2 & 3: Missing from R2 + local shows missing state; rebuild reconstructs rich MusicXML & saves to R2."""
    legacy_root = tmp_path / "empty_legacy"
    legacy_root.mkdir(parents=True, exist_ok=True)
    prev_env = _configure_s3_with_legacy_root(legacy_root)
    bucket = _MockR2Bucket()

    try:
        headers, user_id, project_id = _create_user_and_project(client, title="Rebuilt Waltz")
        missing_key = f"users/{user_id}/projects/{project_id}/musicxml/gone.musicxml"

        # 3/4 at 108 BPM => 1 measure = 3 * (60/108) = 1.6667 sec
        # Include notes with rests (onset gap), chord/multi-pitch, octave variation, and tie across measure 1->2 barline
        stored_notes = [
            {"id": "n1", "pitch_midi": 67, "onset_sec": 0.0, "offset_sec": 0.5556, "velocity": 88, "track_index": 0},
            {"id": "n2", "pitch_midi": 71, "onset_sec": 1.1111, "offset_sec": 2.2222, "velocity": 84, "track_index": 0},
            {"id": "n3", "pitch_midi": 55, "onset_sec": 2.2222, "offset_sec": 3.3333, "velocity": 78, "track_index": 0},
        ]
        score_row = ProjectScore(
            project_id=project_id,
            version=2,
            score_json={
                "title": "Rebuilt Waltz",
                "tempo_bpm": 108.0,
                "tempo_estimated": False,
                "time_signature": "3/4",
                "time_signature_estimated": False,
                "key_signature": "G major",
                "key_signature_estimated": False,
                "duration_seconds": 3.5,
                "tracks": [{"index": 0, "name": "Piano", "instrument": "piano", "clef": "grand", "program": 0, "muted": False}],
                "notes": stored_notes,
                "chords": [],
                "analysis": {"quantization": "eighth"},
            },
            musicxml_path=missing_key,
            midi_path=None,
        )
        db_session.add(score_row)
        db_session.commit()

        with patch.object(storage_service, "_s3_client", return_value=bucket.make_client()):
            # Scenario 2: Missing from both R2 and legacy storage
            get_res = client.get(f"/api/v1/projects/{project_id}/score", headers=headers)
            assert get_res.status_code == 200
            assert get_res.json()["musicxml"] is None
            assert len(get_res.json()["score_json"]["notes"]) == 3

            # Scenario 3: Rebuild & save to storage from DB note events
            rec_res = client.post(
                f"/api/v1/projects/{project_id}/score/recover",
                headers=headers,
                json={"create_blank_if_empty": False, "expected_version": 2},
            )
            assert rec_res.status_code == 200, rec_res.text
            rec_body = rec_res.json()
            assert rec_body["status"] == "rebuilt_from_notes"
            assert rec_body["note_count"] == 3
            rebuilt_xml = rec_body["score"]["musicxml"]
            assert rebuilt_xml is not None

            root = ET.fromstring(rebuilt_xml.lstrip("\ufeff").strip())
            assert root.findtext(".//time/beats") == "3"
            assert root.findtext(".//time/beat-type") == "4"
            assert root.findtext(".//key/fifths") == "1"
            sound_el = root.find(".//sound[@tempo]")
            assert sound_el is not None and sound_el.get("tempo") == "108"
            # Verify rest, multiple octaves, pitches, measures, and tie across barline are preserved
            assert root.find(".//note/rest") is not None
            assert len(root.findall(".//part/measure")) >= 2
            assert len(root.findall(".//note/tie")) >= 2
            pitches = {(n.findtext("pitch/step"), n.findtext("pitch/octave")) for n in root.findall(".//note") if n.find("pitch") is not None}
            assert ("G", "4") in pitches
            assert ("B", "4") in pitches
            assert ("G", "3") in pitches

            # Verify no duplicate score rows were created and original notes remain intact
            assert db_session.query(ProjectScore).filter(ProjectScore.project_id == project_id).count() == 1
            db_session.refresh(score_row)
            assert score_row.version == 3
            assert score_row.musicxml_path != missing_key
            assert score_row.musicxml_path in bucket.objects
            assert len(score_row.score_json["notes"]) == 3

            # Subsequent GET /score loads the rebuilt MusicXML directly from R2
            reloaded = client.get(f"/api/v1/projects/{project_id}/score", headers=headers)
            assert reloaded.status_code == 200
            assert reloaded.json()["musicxml"] is not None
            assert reloaded.json()["version"] == 3
    finally:
        _restore_env(prev_env)


def test_scenario_4_empty_notes_requires_explicit_blank_score_confirmation(tmp_path, client, db_session):
    """Scenario 4: Never silently overwrite with blank template; require explicit create_blank_if_empty."""
    legacy_root = tmp_path / "empty_notes_legacy"
    legacy_root.mkdir(parents=True, exist_ok=True)
    prev_env = _configure_s3_with_legacy_root(legacy_root)
    bucket = _MockR2Bucket()

    try:
        headers, user_id, project_id = _create_user_and_project(client, title="Empty Legacy Score")
        missing_key = f"users/{user_id}/projects/{project_id}/musicxml/empty_missing.musicxml"

        score_row = ProjectScore(
            project_id=project_id,
            version=1,
            score_json={
                "title": "Empty Legacy Score",
                "tempo_bpm": 92.0,
                "tempo_estimated": False,
                "time_signature": "6/8",
                "time_signature_estimated": False,
                "key_signature": "D major",
                "key_signature_estimated": False,
                "duration_seconds": 0.0,
                "tracks": [{"index": 0, "name": "Piano", "instrument": "piano", "clef": "grand", "program": 0, "muted": False}],
                "notes": [],
                "chords": [],
                "analysis": {"playground_config": {"clef_mode": "grand", "measures": 4}},
            },
            musicxml_path=missing_key,
            midi_path=None,
        )
        db_session.add(score_row)
        db_session.commit()

        with patch.object(storage_service, "_s3_client", return_value=bucket.make_client()):
            res1 = client.post(
                f"/api/v1/projects/{project_id}/score/recover",
                headers=headers,
                json={"create_blank_if_empty": False},
            )
            assert res1.status_code == 200
            body1 = res1.json()
            assert body1["status"] == "no_recoverable_notes"
            assert body1["score"] is None
            assert len(bucket.objects) == 0
            db_session.refresh(score_row)
            assert score_row.version == 1
            assert score_row.musicxml_path == missing_key

            res2 = client.post(
                f"/api/v1/projects/{project_id}/score/recover",
                headers=headers,
                json={"create_blank_if_empty": True},
            )
            assert res2.status_code == 200
            body2 = res2.json()
            assert body2["status"] == "created_blank"
            blank_xml = body2["score"]["musicxml"]
            root = ET.fromstring(blank_xml.lstrip("\ufeff").strip())
            assert root.findtext(".//time/beats") == "6"
            assert root.findtext(".//time/beat-type") == "8"
            assert root.findtext(".//key/fifths") == "2"
            assert root.find(".//sound[@tempo]").get("tempo") == "92"
            db_session.refresh(score_row)
            assert score_row.version == 2
            assert score_row.musicxml_path in bucket.objects
    finally:
        _restore_env(prev_env)


def test_scenario_5_and_6_r2_upload_or_verification_failure_preserves_db(tmp_path, client, db_session):
    """Scenario 5 & 6: R2 upload failure or readback verification failure preserves original DB records."""
    legacy_root = tmp_path / "fail_legacy"
    legacy_root.mkdir(parents=True, exist_ok=True)
    prev_env = _configure_s3_with_legacy_root(legacy_root)

    try:
        headers, user_id, project_id = _create_user_and_project(client, title="Upload Failure Preservation")
        orig_key = f"users/{user_id}/projects/{project_id}/musicxml/orig.musicxml"

        score_row = ProjectScore(
            project_id=project_id,
            version=5,
            score_json={
                "title": "Upload Failure Preservation",
                "tempo_bpm": 120.0,
                "tempo_estimated": False,
                "time_signature": "4/4",
                "time_signature_estimated": False,
                "key_signature": "C major",
                "key_signature_estimated": False,
                "duration_seconds": 1.0,
                "tracks": [{"index": 0, "name": "Piano", "instrument": "piano", "clef": "treble", "program": 0, "muted": False}],
                "notes": [{"id": "n1", "pitch_midi": 60, "onset_sec": 0.0, "offset_sec": 0.5, "velocity": 80, "track_index": 0}],
                "chords": [],
                "analysis": {},
            },
            musicxml_path=orig_key,
            midi_path=None,
        )
        db_session.add(score_row)
        db_session.commit()

        # Scenario 5: R2 put_object fails
        failing_bucket = _MockR2Bucket(fail_put=True)
        with patch.object(storage_service, "_s3_client", return_value=failing_bucket.make_client()):
            res_fail = client.post(
                f"/api/v1/projects/{project_id}/score/recover",
                headers=headers,
                json={"create_blank_if_empty": False},
            )
            assert res_fail.status_code == 503
            db_session.refresh(score_row)
            assert score_row.version == 5
            assert score_row.musicxml_path == orig_key
            assert len(score_row.score_json["notes"]) == 1

        # Scenario 6: R2 put_object succeeds, but verification readback returns empty/corrupt data
        corrupt_bucket = _MockR2Bucket(corrupt_read=True)
        with patch.object(storage_service, "_s3_client", return_value=corrupt_bucket.make_client()):
            res_corrupt = client.post(
                f"/api/v1/projects/{project_id}/score/recover",
                headers=headers,
                json={"create_blank_if_empty": False},
            )
            assert res_corrupt.status_code == 503
            db_session.refresh(score_row)
            assert score_row.version == 5
            assert score_row.musicxml_path == orig_key
            # Failed verification cleans up newly uploaded corrupt XML object
            assert all(not k.endswith("score.musicxml") for k in corrupt_bucket.objects)
    finally:
        _restore_env(prev_env)


def test_scenario_8_concurrent_legacy_migration_and_recovery_requests(tmp_path, client, db_session):
    """Scenario 8: Concurrent migration & concurrent recovery requests do not duplicate or conflict."""
    legacy_root = tmp_path / "concurrent_legacy"
    legacy_root.mkdir(parents=True, exist_ok=True)
    prev_env = _configure_s3_with_legacy_root(legacy_root)
    bucket = _MockR2Bucket()

    try:
        # 8a. Concurrent try_migrate_legacy_object calls on same key -> single put_object
        key = "users/u1/projects/p1/musicxml/concurrent.musicxml"
        legacy_file = legacy_root / key
        legacy_file.parent.mkdir(parents=True, exist_ok=True)
        legacy_file.write_bytes(SAMPLE_LEGACY_XML.encode("utf-8"))

        shared_client = bucket.make_client()
        with patch.object(storage_service, "_s3_client", return_value=shared_client):
            with ThreadPoolExecutor(max_workers=6) as pool:
                results = list(pool.map(lambda _: storage_service.try_migrate_legacy_object(key), range(6)))
            assert all(results)
            assert bucket.put_calls.count(key) == 1

        # 8b. Concurrent HTTP /score/recover calls for same project -> only 1 rebuild write, all succeed or report already_available
        from sqlalchemy.orm import sessionmaker

        from app.db.session import get_db
        from app.main import app

        ThreadSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=db_session.get_bind())

        headers, user_id, project_id = _create_user_and_project(client, title="Concurrent Rebuild")
        missing_key = f"users/{user_id}/projects/{project_id}/musicxml/gone_concurrent.musicxml"
        score_row = ProjectScore(
            project_id=project_id,
            version=1,
            score_json={
                "title": "Concurrent Rebuild",
                "tempo_bpm": 120.0,
                "tempo_estimated": False,
                "time_signature": "4/4",
                "time_signature_estimated": False,
                "key_signature": "C major",
                "key_signature_estimated": False,
                "duration_seconds": 1.0,
                "tracks": [{"index": 0, "name": "Piano", "instrument": "piano", "clef": "treble", "program": 0, "muted": False}],
                "notes": [{"id": "n1", "pitch_midi": 64, "onset_sec": 0.0, "offset_sec": 0.5, "velocity": 80, "track_index": 0}],
                "chords": [],
                "analysis": {},
            },
            musicxml_path=missing_key,
            midi_path=None,
        )
        db_session.add(score_row)
        db_session.commit()

        def thread_safe_get_db():
            s = ThreadSessionLocal()
            try:
                yield s
            finally:
                s.close()

        prev_override = app.dependency_overrides.get(get_db)
        app.dependency_overrides[get_db] = thread_safe_get_db
        try:
            with patch.object(storage_service, "_s3_client", return_value=shared_client):
                def _call_recover(_idx: int):
                    return client.post(
                        f"/api/v1/projects/{project_id}/score/recover",
                        headers=headers,
                        json={"create_blank_if_empty": False},
                    )

                with ThreadPoolExecutor(max_workers=4) as pool:
                    responses = list(pool.map(_call_recover, range(4)))
        finally:
            if prev_override is not None:
                app.dependency_overrides[get_db] = prev_override
            else:
                app.dependency_overrides.pop(get_db, None)

        assert all(r.status_code == 200 for r in responses), [r.text for r in responses]
        statuses = [r.json()["status"] for r in responses]
        assert statuses.count("rebuilt_from_notes") == 1
        assert statuses.count("already_available") == 3
        db_session.expire_all()
        final_row = db_session.query(ProjectScore).filter(ProjectScore.project_id == project_id).first()
        assert final_row is not None and final_row.version == 2
    finally:
        _restore_env(prev_env)


def test_scenario_9_and_path_traversal_security(tmp_path, client):
    """Scenario 9 & Security: Normal save/reload + playground work under R2; traversal & symlink escape blocked."""
    legacy_root = tmp_path / "sec_legacy"
    legacy_root.mkdir(parents=True, exist_ok=True)
    outside_secret = tmp_path / "secret_outside.musicxml"
    outside_secret.write_text("<secret/>", encoding="utf-8")

    prev_env = _configure_s3_with_legacy_root(legacy_root)
    bucket = _MockR2Bucket()

    try:
        with patch.object(storage_service, "_s3_client", return_value=bucket.make_client()):
            # Traversal rejection
            with pytest.raises(ValueError, match="traversal"):
                storage_service.try_migrate_legacy_object("../secret_outside.musicxml")
            with pytest.raises(ValueError, match="traversal"):
                storage_service.try_migrate_legacy_object("users/u1/../../secret_outside.musicxml")

            # Normal playground creation, PUT /score save, and GET /score reload
            reg = client.post(
                "/api/v1/auth/register",
                json={
                    "email": f"normal_r2_{uuid4().hex[:8]}@example.com",
                    "password": "StrongPassword123!",
                    "display_name": "Normal R2 User",
                },
            )
            headers = {"Authorization": f"Bearer {reg.json()['access_token']}"}
            pg = client.post(
                "/api/v1/projects/playground",
                headers=headers,
                json={"title": "R2 Normal Playground", "tempo_bpm": 120, "time_signature": "4/4", "key_signature": "C Major", "measures": 2},
            )
            assert pg.status_code == 201, pg.text
            proj_id = pg.json()["id"]

            loaded = client.get(f"/api/v1/projects/{proj_id}/score", headers=headers)
            assert loaded.status_code == 200
            assert loaded.json()["musicxml"] is not None

            score_payload = loaded.json()["score_json"]
            score_payload["notes"] = [
                {"id": "n1", "pitch_midi": 60, "onset_sec": 0.0, "offset_sec": 0.5, "velocity": 85, "track_index": 0}
            ]
            saved = client.put(
                f"/api/v1/projects/{proj_id}/score",
                headers=headers,
                json={"expected_version": loaded.json()["version"], "score_json": score_payload},
            )
            assert saved.status_code == 200
            assert "<step>C</step>" in saved.json()["musicxml"]

            reloaded = client.get(f"/api/v1/projects/{proj_id}/score", headers=headers)
            assert reloaded.status_code == 200
            assert "<step>C</step>" in reloaded.json()["musicxml"]
    finally:
        _restore_env(prev_env)
