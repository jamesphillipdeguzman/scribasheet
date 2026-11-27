import hashlib
import io
import json
import math
import struct
import uuid
import wave
import zipfile
from pathlib import Path

from app.core.config import get_settings
from app.models import MediaAsset, Project
from app.storage.service import storage_service

COMPLEX_NOTATION_MUSICXML = """<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <work><work-title>Complex Nocturne</work-title></work>
  <part-list>
    <score-part id="P1"><part-name>Piano</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="0" implicit="yes">
      <attributes>
        <divisions>480</divisions>
        <key><fifths>-2</fifths><mode>major</mode></key>
        <time><beats>3</beats><beat-type>4</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef>
      </attributes>
      <note>
        <pitch><step>F</step><octave>4</octave></pitch>
        <duration>480</duration>
        <voice>1</voice>
        <type>quarter</type>
      </note>
    </measure>
    <measure number="1">
      <barline location="left">
        <bar-style>heavy-light</bar-style>
        <repeat direction="forward"/>
      </barline>
      <direction placement="above">
        <direction-type><segno/></direction-type>
      </direction>
      <harmony><root><root-step>B</root-step><root-alter>-1</root-alter></root><kind>major</kind></harmony>
      <note>
        <pitch><step>B</step><alter>-1</alter><octave>4</octave></pitch>
        <duration>720</duration>
        <tie type="start"/>
        <voice>1</voice>
        <type>quarter</type>
        <dot/>
        <notations><tied type="start"/></notations>
      </note>
      <note>
        <pitch><step>B</step><alter>-1</alter><octave>4</octave></pitch>
        <duration>160</duration>
        <tie type="stop"/>
        <voice>1</voice>
        <type>eighth</type>
        <time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification>
        <notations><tied type="stop"/></notations>
      </note>
      <note>
        <pitch><step>C</step><octave>5</octave></pitch>
        <duration>160</duration>
        <voice>1</voice>
        <type>eighth</type>
        <time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification>
      </note>
      <note>
        <pitch><step>D</step><octave>5</octave></pitch>
        <duration>160</duration>
        <voice>1</voice>
        <type>eighth</type>
        <time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification>
      </note>
      <barline location="right">
        <ending number="1" type="start"/>
        <bar-style>light-heavy</bar-style>
        <repeat direction="backward" times="2"/>
      </barline>
    </measure>
    <measure number="2">
      <attributes>
        <time><beats>4</beats><beat-type>4</beat-type></time>
      </attributes>
      <direction placement="above">
        <direction-type><words>D.S. al Fine</words></direction-type>
      </direction>
      <barline location="left">
        <ending number="2" type="start"/>
      </barline>
      <note>
        <pitch><step>E</step><alter>-1</alter><octave>5</octave></pitch>
        <duration>1920</duration>
        <voice>1</voice>
        <type>whole</type>
      </note>
      <barline location="right">
        <ending number="2" type="stop"/>
      </barline>
    </measure>
  </part>
</score-partwise>
"""


def _make_wav_bytes(duration_sec: float = 0.5, sample_rate: int = 22050) -> bytes:
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


def _register(client, email: str) -> tuple[dict[str, str], dict]:
    res = client.post(
        "/api/v1/auth/register",
        json={"email": email, "password": "StrongPassword123!", "display_name": "Archive Tester"},
    )
    assert res.status_code == 201, res.text
    data = res.json()
    return {"Authorization": f"Bearer {data['access_token']}"}, data


def _build_custom_zip(members: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for name, payload in members.items():
            zf.writestr(name, payload)
    return buf.getvalue()


def test_full_roundtrip_export_delete_reclaim_restore_and_edit_fidelity(client, db_session, tmp_path, monkeypatch):
    storage_dir = tmp_path / "archive_storage"
    storage_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("STORAGE_BACKEND", "local")
    monkeypatch.setenv("LOCAL_STORAGE_ROOT", str(storage_dir))
    get_settings.cache_clear()

    try:
        headers, _ = _register(client, f"arch_rt_{uuid.uuid4().hex[:8]}@example.com")
        other_headers, _ = _register(client, f"arch_other_{uuid.uuid4().hex[:8]}@example.com")

        # 1. Create a Playground project, upload original WAV audio, add lyrics + chords + complex notation edits
        pg = client.post(
            "/api/v1/projects/playground",
            headers=headers,
            json={
                "title": "Complex Nocturne Archive",
                "key_signature": "Bb Major",
                "time_signature": "3/4",
                "tempo_bpm": 96,
                "clef_mode": "grand",
                "measures": 4,
                "pickup_beats": 1,
            },
        )
        assert pg.status_code == 201, pg.text
        orig_project_id = pg.json()["id"]

        wav_payload = _make_wav_bytes(0.6)
        up = client.post(
            "/api/v1/uploads",
            headers=headers,
            data={"project_id": orig_project_id},
            files={"file": ("nocturne-take.wav", wav_payload, "audio/wav")},
        )
        assert up.status_code == 201, up.text
        orig_asset_id = up.json()["id"]

        # Update score with notes, chords, lyrics, and complex MusicXML
        orig_score_get = client.get(f"/api/v1/projects/{orig_project_id}/score", headers=headers)
        assert orig_score_get.status_code == 200
        s_row = orig_score_get.json()
        edited_score_json = dict(s_row["score_json"])
        edited_score_json["tempo_bpm"] = 96.0
        edited_score_json["tempo_estimated"] = False
        edited_score_json["time_signature"] = "3/4"
        edited_score_json["time_signature_estimated"] = False
        edited_score_json["key_signature"] = "Bb Major"
        edited_score_json["key_signature_estimated"] = False
        edited_score_json["duration_seconds"] = 4.0
        edited_score_json["notes"] = [
            {"id": "n1", "pitch_midi": 65, "onset_sec": 0.0, "offset_sec": 0.625, "velocity": 84, "track_index": 0},
            {"id": "n2", "pitch_midi": 70, "onset_sec": 0.625, "offset_sec": 1.8, "velocity": 90, "track_index": 0},
        ]
        edited_score_json["chords"] = [
            {
                "id": "c1",
                "measure": 1,
                "beat": 1.0,
                "onset_sec": 0.625,
                "symbol": "Bb",
                "root": "Bb",
                "quality": "major",
            }
        ]
        edited_analysis = dict(edited_score_json.get("analysis") or {})
        edited_analysis["pickup_beats"] = 1.0
        edited_analysis["lyrics"] = {
            "text": "Moonlight softly falls",
            "segments": [
                {
                    "id": "seg1",
                    "text": "Moonlight softly falls",
                    "start_sec": 0.0,
                    "end_sec": 2.0,
                    "words": [],
                }
            ],
            "language": "en",
            "source_used": "manual",
            "demucs_requested": False,
            "demucs_fallback_used": False,
            "model_name": "manual",
            "device": "cpu",
            "has_word_timestamps": False,
            "uncertain_segments": [],
            "manually_edited": True,
            "updated_at": None,
        }
        edited_score_json["analysis"] = edited_analysis

        save_res = client.put(
            f"/api/v1/projects/{orig_project_id}/score",
            headers=headers,
            json={
                "expected_version": s_row["version"],
                "score_json": edited_score_json,
                "musicxml": COMPLEX_NOTATION_MUSICXML,
            },
        )
        assert save_res.status_code == 200, save_res.text

        # Other user cannot inspect summary or export archive
        assert client.get(f"/api/v1/projects/{orig_project_id}/archive", headers=other_headers).status_code == 403

        # 2. Check archive summary (with & without audio)
        sum_with = client.get(f"/api/v1/projects/{orig_project_id}/archive/summary?include_audio=true", headers=headers)
        assert sum_with.status_code == 200
        assert sum_with.json()["included_media_count"] == 1
        assert sum_with.json()["included_media_bytes"] == len(wav_payload)

        sum_without = client.get(
            f"/api/v1/projects/{orig_project_id}/archive/summary?include_audio=false",
            headers=headers,
        )
        assert sum_without.status_code == 200
        assert sum_without.json()["included_media_count"] == 0

        usage_before_export = client.get("/api/v1/users/me/usage", headers=headers).json()

        # 3. Export FULL `.scribasheet` archive (with audio)
        exp_full = client.get(f"/api/v1/projects/{orig_project_id}/archive?include_audio=true", headers=headers)
        assert exp_full.status_code == 200
        archive_bytes = exp_full.content

        # Exporting an archive MUST NOT increase cloud storage usage or auto-delete the cloud project
        usage_after_export = client.get("/api/v1/users/me/usage", headers=headers).json()
        assert usage_after_export["storage_used_bytes"] == usage_before_export["storage_used_bytes"]
        assert client.get(f"/api/v1/projects/{orig_project_id}", headers=headers).status_code == 200

        # Verify ZIP layout, manifest, project.json (zero secrets), and SHA-256 checksums
        with zipfile.ZipFile(io.BytesIO(archive_bytes), "r") as zf:
            names = set(zf.namelist())
            assert {"manifest.json", "project.json", "score.musicxml", "score.mid", "checksums.json"}.issubset(names)
            media_entries = [n for n in names if n.startswith("media/")]
            assert len(media_entries) == 1
            assert zf.read(media_entries[0]) == wav_payload

            manifest = json.loads(zf.read("manifest.json").decode("utf-8"))
            assert manifest["schema_version"] == 1
            assert manifest["application"] == "ScribaSheet"
            assert manifest["included_media"] is True
            assert manifest["project_id"] == orig_project_id

            project_doc = json.loads(zf.read("project.json").decode("utf-8"))
            assert "password" not in json.dumps(project_doc).lower()
            assert project_doc["musical_metadata"]["key_fifths"] == -2
            assert project_doc["musical_metadata"]["pickup_beats"] == 1.0
            assert len(project_doc["musical_metadata"]["repeats"]) == 2
            assert len(project_doc["musical_metadata"]["endings"]) >= 2
            assert any("D.S." in m["marker"] for m in project_doc["musical_metadata"]["navigation_markers"])

            checksums = json.loads(zf.read("checksums.json").decode("utf-8"))
            for fname, digest in checksums["files"].items():
                assert hashlib.sha256(zf.read(fname)).hexdigest() == digest

        # Also test score-only archive (`include_audio=false`) omits audio & writes zero fake media files
        exp_score_only = client.get(f"/api/v1/projects/{orig_project_id}/archive?include_audio=false", headers=headers)
        assert exp_score_only.status_code == 200
        score_only_bytes = exp_score_only.content
        with zipfile.ZipFile(io.BytesIO(score_only_bytes), "r") as zf:
            assert not any(n.startswith("media/") for n in zf.namelist())
            pdoc = json.loads(zf.read("project.json").decode("utf-8"))
            assert pdoc["original_audio_omitted"] is True

        # 4. Delete original cloud project & confirm ALL files removed + storage reclaimed
        del_res = client.delete(f"/api/v1/projects/{orig_project_id}", headers=headers)
        assert del_res.status_code == 204
        assert db_session.query(Project).filter(Project.id == orig_project_id).first() is None
        assert [p for p in storage_dir.rglob("*") if p.is_file()] == []
        usage_after_delete = client.get("/api/v1/users/me/usage", headers=headers).json()
        assert usage_after_delete["storage_used_bytes"] == 0
        assert usage_after_delete["project_count"] == 0

        # 5. Validate & Restore FULL archive into a brand-new project ID
        val_res = client.post(
            "/api/v1/archives/validate",
            headers=headers,
            files={"file": ("backup.scribasheet", archive_bytes, "application/octet-stream")},
        )
        assert val_res.status_code == 200, val_res.text
        assert val_res.json()["checksums_verified"] is True
        assert val_res.json()["included_media"] is True
        assert val_res.json()["has_lyrics"] is True

        imp_res = client.post(
            "/api/v1/archives/import",
            headers=headers,
            files={"file": ("backup.scribasheet", archive_bytes, "application/octet-stream")},
        )
        assert imp_res.status_code == 201, imp_res.text
        restored = imp_res.json()
        restored_id = restored["id"]
        assert restored_id != orig_project_id
        assert restored["title"] == "Complex Nocturne Archive"
        assert restored["status"] == "ready"
        assert len(restored["media_assets"]) == 1
        assert restored["media_assets"][0]["id"] != orig_asset_id
        assert restored["media_assets"][0]["original_filename"] == "nocturne-take.wav"

        # Verify restored audio bytes, score, MusicXML, repeats/endings/pickup, lyrics, chords, and PDF/MIDI exports
        dl_audio = client.get(f"/api/v1/uploads/{restored['media_assets'][0]['id']}/download", headers=headers)
        assert dl_audio.status_code == 200
        assert dl_audio.content == wav_payload

        restored_score = client.get(f"/api/v1/projects/{restored_id}/score", headers=headers).json()
        assert len(restored_score["score_json"]["notes"]) == 2
        assert restored_score["score_json"]["chords"][0]["symbol"] == "Bb"
        assert restored_score["score_json"]["analysis"]["lyrics"]["text"] == "Moonlight softly falls"
        assert restored_score["score_json"]["analysis"]["restored_from_archive"]["original_project_id"] == orig_project_id
        assert '<ending number="1" type="start"' in restored_score["musicxml"]
        assert '<repeat direction="backward"' in restored_score["musicxml"]
        assert 'implicit="yes"' in restored_score["musicxml"]

        # Verify MIDI & PDF export work immediately on restored project
        for fmt in ("midi", "musicxml", "pdf"):
            e_res = client.post(f"/api/v1/projects/{restored_id}/exports", headers=headers, json={"format": fmt})
            assert e_res.status_code == 201, e_res.text

        # Usage accounting reflects restored audio + score files cleanly
        usage_after_restore = client.get("/api/v1/users/me/usage", headers=headers).json()
        assert usage_after_restore["project_count"] == 1
        assert usage_after_restore["storage_used_bytes"] > len(wav_payload)

        # 6. Import score-only archive -> zero MediaAssets created
        imp_score_only = client.post(
            "/api/v1/archives/import",
            headers=headers,
            files={"file": ("score_only.scribasheet", score_only_bytes, "application/octet-stream")},
        )
        assert imp_score_only.status_code == 201, imp_score_only.text
        assert imp_score_only.json()["media_assets"] == []
    finally:
        monkeypatch.delenv("STORAGE_BACKEND", raising=False)
        monkeypatch.delenv("LOCAL_STORAGE_ROOT", raising=False)
        get_settings.cache_clear()


def test_import_migrates_legacy_schema_v0_and_rejects_invalid_or_malicious_archives(
    client, db_session, tmp_path, monkeypatch
):
    storage_dir = tmp_path / "archive_sec_storage"
    storage_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("STORAGE_BACKEND", "local")
    monkeypatch.setenv("LOCAL_STORAGE_ROOT", str(storage_dir))
    get_settings.cache_clear()

    try:
        headers, _ = _register(client, f"arch_sec_{uuid.uuid4().hex[:8]}@example.com")

        # 1. Legacy schema_version: 0 archive should migrate cleanly into v1
        legacy_xml = (
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<score-partwise version="3.1"><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>'
            '<part id="P1"><measure number="1"><note><pitch><step>C</step><octave>4</octave></pitch>'
            '<duration>1920</duration><voice>1</voice><type>whole</type></note></measure></part></score-partwise>'
        ).encode("utf-8")
        legacy_manifest = json.dumps(
            {
                "schema_version": 0,
                "application": "ScribaSheet",
                "exported_at": "2025-01-01T00:00:00Z",
                "project_id": "legacy-id-0",
                "title": "Legacy V0 Song",
                "has_score": True,
            }
        ).encode("utf-8")
        legacy_proj = json.dumps(
            {
                "title": "Legacy V0 Song",
                "instrument": "piano",
                "tempo_bpm": 108,
                "time_signature": "4/4",
                "key_signature": "C Major",
                "score_json": {
                    "title": "Legacy V0 Song",
                    "tempo_bpm": 108,
                    "time_signature": "4/4",
                    "key_signature": "C Major",
                    "duration_seconds": 2.0,
                    "tracks": [{"index": 0, "name": "Piano", "instrument": "piano", "clef": "treble"}],
                    "notes": [{"id": "n1", "pitch_midi": 60, "onset_sec": 0.0, "offset_sec": 1.0, "velocity": 80, "track_index": 0}],
                    "chords": [],
                },
            }
        ).encode("utf-8")
        v0_members = {"manifest.json": legacy_manifest, "project.json": legacy_proj, "score.musicxml": legacy_xml}
        v0_members["checksums.json"] = json.dumps(
            {"algorithm": "sha256", "files": {k: hashlib.sha256(v).hexdigest() for k, v in v0_members.items()}}
        ).encode("utf-8")
        v0_zip = _build_custom_zip(v0_members)

        v0_val = client.post(
            "/api/v1/archives/validate",
            headers=headers,
            files={"file": ("legacy.scribasheet", v0_zip, "application/octet-stream")},
        )
        assert v0_val.status_code == 200, v0_val.text
        assert any("schema_version 0" in w for w in v0_val.json()["warnings"])

        v0_imp = client.post(
            "/api/v1/archives/import",
            headers=headers,
            files={"file": ("legacy.scribasheet", v0_zip, "application/octet-stream")},
        )
        assert v0_imp.status_code == 201, v0_imp.text
        assert v0_imp.json()["title"] == "Legacy V0 Song"

        # Record clean baseline counts before running rejection cases
        projects_before = db_session.query(Project).count()
        files_before = len([p for p in storage_dir.rglob("*") if p.is_file()])

        # 2. Corrupted ZIP rejected
        bad_zip = client.post(
            "/api/v1/archives/import",
            headers=headers,
            files={"file": ("bad.scribasheet", b"not-a-zip-file", "application/octet-stream")},
        )
        assert bad_zip.status_code == 400

        # 3. Unsupported future schema_version: 99 rejected
        future_manifest = json.loads(legacy_manifest.decode("utf-8"))
        future_manifest["schema_version"] = 99
        fut_members = {
            "manifest.json": json.dumps(future_manifest).encode("utf-8"),
            "project.json": legacy_proj,
            "score.musicxml": legacy_xml,
        }
        fut_members["checksums.json"] = json.dumps(
            {"algorithm": "sha256", "files": {k: hashlib.sha256(v).hexdigest() for k, v in fut_members.items()}}
        ).encode("utf-8")
        fut_res = client.post(
            "/api/v1/archives/import",
            headers=headers,
            files={"file": ("future.scribasheet", _build_custom_zip(fut_members), "application/octet-stream")},
        )
        assert fut_res.status_code == 400
        assert "schema_version 99" in fut_res.json()["detail"]

        # 4. Tampered SHA-256 checksum rejected
        tampered_members = dict(v0_members)
        tampered_members["score.musicxml"] = legacy_xml + b"<!-- tampered -->"
        tamp_res = client.post(
            "/api/v1/archives/import",
            headers=headers,
            files={"file": ("tampered.scribasheet", _build_custom_zip(tampered_members), "application/octet-stream")},
        )
        assert tamp_res.status_code == 400
        assert "checksum" in tamp_res.json()["detail"].lower()

        # 5. Path traversal member rejected
        trav_members = {**v0_members, "../evil.txt": b"pwn"}
        trav_res = client.post(
            "/api/v1/archives/import",
            headers=headers,
            files={"file": ("traversal.scribasheet", _build_custom_zip(trav_members), "application/octet-stream")},
        )
        assert trav_res.status_code == 400

        # 6. Malformed/XXE MusicXML rejected
        xxe_xml = b'<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><score-partwise/>'
        xxe_members = {"manifest.json": legacy_manifest, "project.json": legacy_proj, "score.musicxml": xxe_xml}
        xxe_members["checksums.json"] = json.dumps(
            {"algorithm": "sha256", "files": {k: hashlib.sha256(v).hexdigest() for k, v in xxe_members.items()}}
        ).encode("utf-8")
        xxe_res = client.post(
            "/api/v1/archives/import",
            headers=headers,
            files={"file": ("xxe.scribasheet", _build_custom_zip(xxe_members), "application/octet-stream")},
        )
        assert xxe_res.status_code == 400

        # Confirm ZERO incomplete DB projects or orphan storage files were left by failed imports
        assert db_session.query(Project).count() == projects_before
        assert len([p for p in storage_dir.rglob("*") if p.is_file()]) == files_before
    finally:
        monkeypatch.delenv("STORAGE_BACKEND", raising=False)
        monkeypatch.delenv("LOCAL_STORAGE_ROOT", raising=False)
        get_settings.cache_clear()


def test_deletion_failure_retains_project_and_preserves_shared_files(client, db_session, tmp_path, monkeypatch):
    storage_dir = tmp_path / "del_safety_storage"
    storage_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("STORAGE_BACKEND", "local")
    monkeypatch.setenv("LOCAL_STORAGE_ROOT", str(storage_dir))
    get_settings.cache_clear()

    try:
        headers, reg = _register(client, f"del_safe_{uuid.uuid4().hex[:8]}@example.com")
        user_id = reg["user"]["id"]

        p1 = client.post("/api/v1/projects/playground", headers=headers, json={"title": "P1"}).json()["id"]
        p2 = client.post("/api/v1/projects/playground", headers=headers, json={"title": "P2"}).json()["id"]

        # Create an asset in p1 and simulate a shared storage_path referenced by p2
        up1 = client.post(
            "/api/v1/uploads",
            headers=headers,
            data={"project_id": p1},
            files={"file": ("shared.wav", _make_wav_bytes(), "audio/wav")},
        )
        assert up1.status_code == 201
        shared_path = db_session.query(MediaAsset).filter(MediaAsset.id == up1.json()["id"]).first().storage_path
        db_session.add(
            MediaAsset(
                project_id=p2,
                user_id=user_id,
                asset_type="original",
                storage_path=shared_path,
                original_filename="shared.wav",
                mime_type="audio/wav",
                size_bytes=1234,
            )
        )
        db_session.commit()

        # Simulate storage delete failure on p1 -> must return 503 AND keep p1 in DB for retry
        orig_delete = storage_service.delete

        def fail_once(key: str):
            raise OSError("Simulated I/O failure")

        monkeypatch.setattr(storage_service, "delete", fail_once)
        failed_del = client.delete(f"/api/v1/projects/{p1}", headers=headers)
        assert failed_del.status_code == 503
        assert db_session.query(Project).filter(Project.id == p1).first() is not None

        # Restore delete -> p1 deletes cleanly, p1's unshared score files deleted, shared file kept for p2!
        monkeypatch.setattr(storage_service, "delete", orig_delete)
        ok_del = client.delete(f"/api/v1/projects/{p1}", headers=headers)
        assert ok_del.status_code == 204
        assert storage_service.exists(shared_path) is True
    finally:
        monkeypatch.delenv("STORAGE_BACKEND", raising=False)
        monkeypatch.delenv("LOCAL_STORAGE_ROOT", raising=False)
        get_settings.cache_clear()
