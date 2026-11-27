import errno
import io
import math
import struct
import uuid
import wave
from pathlib import Path

from app.core.config import Settings, get_settings
from app.models import MediaAsset, Project
from app.notation.generator import render_score_pdf
from app.schemas.score import ScoreData, ScoreNote, ScoreTrack
from app.storage.service import storage_service

SAMPLE_MUSICXML = """<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list>
    <score-part id="P1"><part-name>Piano</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>480</divisions>
        <key><fifths>0</fifths></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef>
      </attributes>
      <note>
        <pitch><step>C</step><octave>4</octave></pitch>
        <duration>1920</duration>
        <voice>1</voice>
        <type>whole</type>
      </note>
    </measure>
  </part>
</score-partwise>
"""


def _make_wav_bytes(duration_sec: float = 0.4, sample_rate: int = 22050) -> bytes:
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


def _make_pdf_bytes(title: str = "Storage Lifecycle Score") -> bytes:
    score = ScoreData(
        title=title,
        tempo_bpm=120.0,
        time_signature="4/4",
        key_signature="C",
        duration_seconds=2.0,
        tracks=[ScoreTrack(index=0, name="Piano", instrument="piano", clef="treble")],
        notes=[ScoreNote(id="n1", pitch_midi=60, onset_sec=0.0, offset_sec=1.0, velocity=80, track_index=0)],
        chords=[],
    )
    return render_score_pdf(score)


def _register(client, email: str) -> tuple[dict[str, str], dict]:
    res = client.post(
        "/api/v1/auth/register",
        json={"email": email, "password": "StrongPassword123!", "display_name": "Storage Tester"},
    )
    assert res.status_code == 201, res.text
    data = res.json()
    return {"Authorization": f"Bearer {data['access_token']}"}, data


def test_production_storage_root_prefers_data_volume():
    orig_exists = Path.exists
    orig_mkdir = Path.mkdir

    def fake_exists(self: Path) -> bool:
        if str(self).replace("\\", "/") == "/data":
            return True
        return orig_exists(self)

    def fake_mkdir(self: Path, *args, **kwargs) -> None:
        if "data" in self.parts and self.name == "storage_data":
            return None
        return orig_mkdir(self, *args, **kwargs)

    # Verify Railway production rule: when ENVIRONMENT=production & /data exists, resolves to /data/storage_data
    import unittest.mock as um

    with um.patch.object(Path, "exists", fake_exists), um.patch.object(Path, "mkdir", fake_mkdir):
        cfg = Settings(ENVIRONMENT="production", LOCAL_STORAGE_ROOT="./storage_data")
        resolved = cfg.storage_root_path
        assert resolved.name == "storage_data"
        assert resolved.parent.name == "data"


def test_uncapped_projects_and_uploads_past_legacy_250mb_for_standard_user(client, db_session, monkeypatch):
    monkeypatch.setenv("ADMIN_EMAILS", "")
    get_settings.cache_clear()
    try:
        headers, reg = _register(client, f"uncapped_{uuid.uuid4().hex[:8]}@example.com")
        user_id = reg["user"]["id"]

        # Create 20 projects (exceeds old 15-project cap) across standard, playground, and duplicate flows
        first_project_id = ""
        for i in range(18):
            res = client.post("/api/v1/projects", headers=headers, json={"title": f"Score {i}"})
            assert res.status_code == 201, res.text
            if not first_project_id:
                first_project_id = res.json()["id"]

        pg = client.post("/api/v1/projects/playground", headers=headers, json={"title": "Playground Extra"})
        assert pg.status_code == 201, pg.text

        dup = client.post(f"/api/v1/projects/{pg.json()['id']}/duplicate", headers=headers)
        assert dup.status_code == 201, dup.text

        # Seed 350 MB of existing MediaAsset records (> legacy 250 MB limit)
        db_session.add(
            MediaAsset(
                project_id=first_project_id,
                user_id=user_id,
                asset_type="original",
                storage_path=f"users/{user_id}/projects/{first_project_id}/originals/huge_recording.wav",
                original_filename="huge_recording.wav",
                mime_type="audio/wav",
                size_bytes=350 * 1024 * 1024,
            )
        )
        db_session.commit()

        # Upload WAV, PDF, and MusicXML even with >350 MB recorded usage
        wav_up = client.post(
            "/api/v1/uploads",
            headers=headers,
            data={"project_id": first_project_id},
            files={"file": ("recording.wav", _make_wav_bytes(), "audio/wav")},
        )
        assert wav_up.status_code == 201, wav_up.text

        pdf_up = client.post(
            "/api/v1/uploads",
            headers=headers,
            data={"project_id": first_project_id},
            files={"file": ("sheet.pdf", _make_pdf_bytes(), "application/pdf")},
        )
        assert pdf_up.status_code == 201, pdf_up.text

        xml_up = client.post(
            "/api/v1/uploads",
            headers=headers,
            data={"project_id": first_project_id},
            files={"file": ("score.musicxml", SAMPLE_MUSICXML.encode("utf-8"), "application/xml")},
        )
        assert xml_up.status_code == 201, xml_up.text

        usage = client.get("/api/v1/users/me/usage", headers=headers)
        assert usage.status_code == 200
        body = usage.json()
        assert body["project_count"] == 20
        assert body["project_limit"] is None
        assert body["storage_limit_mb"] is None
        assert body["storage_quota_enforced"] is False
        assert body["storage_used_mb"] >= 350.0
        assert body["file_count"] >= 4
    finally:
        monkeypatch.delenv("ADMIN_EMAILS", raising=False)
        get_settings.cache_clear()


def test_complete_lifecycle_accounting_ownership_and_deletion_cleanup(client, db_session, tmp_path, monkeypatch):
    storage_dir = tmp_path / "storage_root"
    storage_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("STORAGE_BACKEND", "local")
    monkeypatch.setenv("LOCAL_STORAGE_ROOT", str(storage_dir))
    get_settings.cache_clear()

    try:
        email = f"owner_{uuid.uuid4().hex[:8]}@example.com"
        headers, _ = _register(client, email)
        other_headers, _ = _register(client, f"other_{uuid.uuid4().hex[:8]}@example.com")

        # 1. Create playground project (writes initial MusicXML & MIDI)
        pg = client.post("/api/v1/projects/playground", headers=headers, json={"title": "Persistence Test"})
        assert pg.status_code == 201, pg.text
        project_id = pg.json()["id"]

        # 2. Upload WAV recording & replace it once -> verify old file deleted & no double accounting
        up1 = client.post(
            "/api/v1/uploads",
            headers=headers,
            data={"project_id": project_id},
            files={"file": ("take1.wav", _make_wav_bytes(0.3), "audio/wav")},
        )
        assert up1.status_code == 201, up1.text
        asset1_id = up1.json()["id"]

        up2 = client.post(
            "/api/v1/uploads",
            headers=headers,
            data={"project_id": project_id, "replace_asset_id": asset1_id},
            files={"file": ("take2.wav", _make_wav_bytes(0.5), "audio/wav")},
        )
        assert up2.status_code == 201, up2.text
        asset2_id = up2.json()["id"]

        # Failed invalid upload must not leave stray files or inflate file_count
        usage_before_bad = client.get("/api/v1/users/me/usage", headers=headers).json()
        bad_up = client.post(
            "/api/v1/uploads",
            headers=headers,
            data={"project_id": project_id},
            files={"file": ("corrupt.pdf", b"not-a-pdf", "application/pdf")},
        )
        assert bad_up.status_code == 400
        usage_after_bad = client.get("/api/v1/users/me/usage", headers=headers).json()
        assert usage_after_bad["file_count"] == usage_before_bad["file_count"]

        # 3. Save notation edit -> replaces score MusicXML & MIDI without leaving unreferenced old files
        got_score = client.get(f"/api/v1/projects/{project_id}/score", headers=headers)
        assert got_score.status_code == 200
        score_payload = got_score.json()
        old_xml_files = list(storage_dir.rglob("*.musicxml"))
        assert len(old_xml_files) == 1

        save_res = client.put(
            f"/api/v1/projects/{project_id}/score",
            headers=headers,
            json={
                "expected_version": score_payload["version"],
                "score_json": score_payload["score_json"],
                "musicxml": SAMPLE_MUSICXML,
            },
        )
        assert save_res.status_code == 200, save_res.text
        current_xml_files = list(storage_dir.rglob("*.musicxml"))
        assert len(current_xml_files) == 1

        # 4. Generate exports (MIDI, MusicXML, PDF, WAV)
        for fmt in ("midi", "musicxml", "pdf", "wav"):
            exp_res = client.post(
                f"/api/v1/projects/{project_id}/exports",
                headers=headers,
                json={"format": fmt},
            )
            assert exp_res.status_code == 201, f"{fmt}: {exp_res.text}"
            dl_res = client.get(f"/api/v1/exports/{exp_res.json()['id']}/download", headers=headers)
            assert dl_res.status_code == 200
            assert len(dl_res.content) > 0

        # 5. Another login session ("new device") accesses same private project; other user receives 403
        login2 = client.post(
            "/api/v1/auth/login",
            json={"email": email, "password": "StrongPassword123!"},
        )
        assert login2.status_code == 200
        device2_headers = {"Authorization": f"Bearer {login2.json()['access_token']}"}
        assert client.get(f"/api/v1/projects/{project_id}", headers=device2_headers).status_code == 200
        assert client.get(f"/api/v1/uploads/{asset2_id}/download", headers=device2_headers).status_code == 200

        # Private access isolation
        assert client.get(f"/api/v1/projects/{project_id}", headers=other_headers).status_code == 403
        assert client.get(f"/api/v1/uploads/{asset2_id}/download", headers=other_headers).status_code == 403

        # Path traversal protection still enforced
        try:
            storage_service.read_bytes("../../etc/passwd")
            assert False, "Expected ValueError on traversal key"
        except ValueError:
            pass

        # 6. Delete project -> deletes MediaAssets, ProjectScore files, AND Export files from disk
        assert len(list(storage_dir.rglob("*.*"))) >= 5
        del_res = client.delete(f"/api/v1/projects/{project_id}", headers=headers)
        assert del_res.status_code == 204
        assert db_session.query(Project).filter(Project.id == project_id).first() is None
        remaining_files = [p for p in storage_dir.rglob("*") if p.is_file()]
        assert remaining_files == []

        usage_after_del = client.get("/api/v1/users/me/usage", headers=headers).json()
        assert usage_after_del["project_count"] == 0
        assert usage_after_del["file_count"] == 0
        assert usage_after_del["storage_used_bytes"] == 0
    finally:
        monkeypatch.delenv("STORAGE_BACKEND", raising=False)
        monkeypatch.delenv("LOCAL_STORAGE_ROOT", raising=False)
        get_settings.cache_clear()


def test_simulated_disk_full_and_permission_errors_preserve_existing_files(client, tmp_path, monkeypatch):
    storage_dir = tmp_path / "storage_enospc"
    storage_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("STORAGE_BACKEND", "local")
    monkeypatch.setenv("LOCAL_STORAGE_ROOT", str(storage_dir))
    get_settings.cache_clear()

    try:
        headers, _ = _register(client, f"infra_{uuid.uuid4().hex[:8]}@example.com")
        pg = client.post("/api/v1/projects/playground", headers=headers, json={"title": "Infra Resilience"})
        assert pg.status_code == 201
        project_id = pg.json()["id"]

        initial_files = sorted(str(p) for p in storage_dir.rglob("*") if p.is_file())
        assert len(initial_files) == 2

        # Simulate ENOSPC inside atomic local write -> must clean up .tmp file and raise 507
        def raise_enospc(*_args, **_kwargs):
            raise OSError(errno.ENOSPC, "No space left on device")

        monkeypatch.setattr("app.storage.service.os.replace", raise_enospc)

        enospc_upload = client.post(
            "/api/v1/uploads",
            headers=headers,
            data={"project_id": project_id},
            files={"file": ("full_disk.wav", _make_wav_bytes(), "audio/wav")},
        )
        assert enospc_upload.status_code == 507, enospc_upload.text
        assert enospc_upload.json()["error_code"] == "STORAGE_CAPACITY_EXCEEDED"
        assert "volume is full" in enospc_upload.json()["detail"].lower()
        assert "quota" not in enospc_upload.json()["detail"].lower()

        enospc_export = client.post(
            f"/api/v1/projects/{project_id}/exports",
            headers=headers,
            json={"format": "midi"},
        )
        assert enospc_export.status_code == 507, enospc_export.text
        assert enospc_export.json()["error_code"] == "STORAGE_CAPACITY_EXCEEDED"

        # Existing project files & score remain intact without partial .tmp artifacts
        after_files = sorted(str(p) for p in storage_dir.rglob("*") if p.is_file())
        assert after_files == initial_files
        assert client.get(f"/api/v1/projects/{project_id}/score", headers=headers).status_code == 200

        # Simulate PermissionError during atomic write -> HTTP 503 structured error
        def raise_perm(*_args, **_kwargs):
            raise PermissionError(errno.EACCES, "Permission denied")

        monkeypatch.setattr("app.storage.service.os.replace", raise_perm)
        perm_upload = client.post(
            "/api/v1/uploads",
            headers=headers,
            data={"project_id": project_id},
            files={"file": ("perm.wav", _make_wav_bytes(), "audio/wav")},
        )
        assert perm_upload.status_code == 503
        assert perm_upload.json()["error_code"] == "STORAGE_PERMISSION_ERROR"
        assert sorted(str(p) for p in storage_dir.rglob("*") if p.is_file()) == initial_files
    finally:
        monkeypatch.delenv("STORAGE_BACKEND", raising=False)
        monkeypatch.delenv("LOCAL_STORAGE_ROOT", raising=False)
        get_settings.cache_clear()
