"""Tests for standalone MIDI Playground creation, non-destructive copying, and .mxl/.mp3/score exports."""

from __future__ import annotations

import io
import xml.etree.ElementTree as ET
import zipfile

import pytest

from app.models import ProjectScore
from app.schemas.score import ScoreData, ScoreNote, ScoreTrack
from app.storage.service import storage_service


def _auth_headers(client, email: str, password: str = "Password123!") -> dict[str, str]:
    client.post(
        "/api/v1/auth/register",
        json={"email": email, "password": password, "display_name": "Playground Tester"},
    )
    res = client.post("/api/v1/auth/login", json={"email": email, "password": password})
    assert res.status_code == 200, res.text
    token = res.json()["access_token"]
    return {"Authorization": f"Bearer {token}"}


def test_create_blank_midi_playground_project_no_upload_required(client) -> None:
    headers = _auth_headers(client, "playground_blank@example.com")

    create_res = client.post(
        "/api/v1/projects/playground",
        headers=headers,
        json={
            "title": "My Sketchpad Idea",
            "key_signature": "G Major",
            "time_signature": "3/4",
            "tempo_bpm": 108,
            "clef_mode": "grand",
            "measures": 6,
        },
    )
    assert create_res.status_code == 201, create_res.text
    proj = create_res.json()
    assert proj["title"] == "My Sketchpad Idea"
    assert proj["transcription_mode"] == "midi_playground"
    assert proj["status"] == "ready"
    assert proj["media_assets"] == []

    score_res = client.get(f"/api/v1/projects/{proj['id']}/score", headers=headers)
    assert score_res.status_code == 200, score_res.text
    body = score_res.json()
    assert body["score_json"]["title"] == "My Sketchpad Idea"
    assert body["score_json"]["key_signature"] == "G Major"
    assert body["score_json"]["time_signature"] == "3/4"
    assert body["score_json"]["tempo_bpm"] == 108.0
    assert body["score_json"]["analysis"]["source_type"] == "midi_playground"
    assert len(body["score_json"]["tracks"]) == 2

    root = ET.fromstring(body["musicxml"])
    assert root.findtext("./work/work-title") == "My Sketchpad Idea"
    assert root.findtext(".//attributes/key/fifths") == "1"
    assert root.findtext(".//attributes/time/beats") == "3"
    assert root.findtext(".//attributes/time/beat-type") == "4"
    assert root.findtext(".//attributes/staves") == "2"
    assert len(root.findall(".//part/measure")) == 6


def test_playground_copy_is_completely_non_destructive_to_original_project(client, db_session) -> None:
    headers = _auth_headers(client, "playground_copy@example.com")

    orig_res = client.post(
        "/api/v1/projects",
        headers=headers,
        json={"title": "River Flows in You", "instrument": "piano", "transcription_mode": "piano_solo"},
    )
    assert orig_res.status_code == 201
    orig_id = orig_res.json()["id"]

    orig_xml = """<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <work><work-title>River Flows in You</work-title></work>
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>4</divisions><key><fifths>3</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
      <note><pitch><step>A</step><octave>4</octave></pitch><duration>4</duration><type>quarter</type></note>
    </measure>
  </part>
</score-partwise>"""
    orig_xml_key = f"tests/{orig_id}/musicxml/score.musicxml"
    storage_service.save_bytes(orig_xml_key, orig_xml.encode("utf-8"), content_type="application/vnd.recordare.musicxml+xml")

    orig_score = ScoreData(
        title="River Flows in You",
        tempo_bpm=120.0,
        time_signature="4/4",
        key_signature="A Major",
        duration_seconds=2.0,
        tracks=[ScoreTrack(index=0, name="Piano", instrument="piano", clef="treble")],
        notes=[ScoreNote(id="n1", pitch_midi=69, onset_sec=0.0, offset_sec=0.5, velocity=85, track_index=0)],
        analysis={"mode": "piano_solo"},
    )
    db_session.add(
        ProjectScore(
            project_id=orig_id,
            version=1,
            score_json=orig_score.model_dump(),
            musicxml_path=orig_xml_key,
        )
    )
    db_session.commit()

    copy_res = client.post(
        f"/api/v1/projects/{orig_id}/playground-copy",
        headers=headers,
        json={},
    )
    assert copy_res.status_code == 201, copy_res.text
    copy_proj = copy_res.json()
    copy_id = copy_proj["id"]
    assert copy_id != orig_id
    assert copy_proj["title"] == "River Flows in You (Playground Copy)"
    assert copy_proj["transcription_mode"] == "midi_playground"

    # Mutate & rename the Playground Copy extensively
    rename_res = client.patch(
        f"/api/v1/projects/{copy_id}",
        headers=headers,
        json={"title": "Edited Playground Remix"},
    )
    assert rename_res.status_code == 200

    edited_score = orig_score.model_copy(
        update={
            "title": "Edited Playground Remix",
            "notes": [ScoreNote(id="n_new", pitch_midi=72, onset_sec=0.0, offset_sec=1.0, velocity=90, track_index=0)],
        }
    )
    edited_xml = orig_xml.replace("River Flows in You", "Edited Playground Remix").replace("<step>A</step>", "<step>C</step>")
    put_res = client.put(
        f"/api/v1/projects/{copy_id}/score",
        headers=headers,
        json={"expected_version": 2, "score_json": edited_score.model_dump(), "musicxml": edited_xml},
    )
    assert put_res.status_code == 200, put_res.text

    # Verify original project & files are completely untouched
    check_orig = client.get(f"/api/v1/projects/{orig_id}", headers=headers).json()
    assert check_orig["title"] == "River Flows in You"
    assert check_orig["transcription_mode"] == "piano_solo"

    check_orig_score = client.get(f"/api/v1/projects/{orig_id}/score", headers=headers).json()
    assert check_orig_score["score_json"]["title"] == "River Flows in You"
    assert len(check_orig_score["score_json"]["notes"]) == 1
    assert check_orig_score["score_json"]["notes"][0]["pitch_midi"] == 69
    assert storage_service.read_bytes(orig_xml_key).decode("utf-8").count("<step>A</step>") == 1


def test_mxl_musicxml_midi_wav_and_mp3_exports_reflect_edits(
    client,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("DISABLE_SOUNDFONT_RENDER", "1")
    headers = _auth_headers(client, "playground_exports@example.com")

    create_res = client.post(
        "/api/v1/projects/playground",
        headers=headers,
        json={"title": "Export Etude", "clef_mode": "grand", "measures": 2},
    )
    assert create_res.status_code == 201
    proj_id = create_res.json()["id"]

    # Edit score via PUT /score
    cur_score_res = client.get(f"/api/v1/projects/{proj_id}/score", headers=headers).json()
    import re

    updated_xml = re.sub(
        r'<note><rest measure="yes"\s*/><duration>192</duration><voice>1</voice><type>whole</type><staff>1</staff></note>',
        "<note><pitch><step>E</step><octave>4</octave></pitch><duration>48</duration><voice>1</voice><type>quarter</type><staff>1</staff></note>"
        "<note><rest/><duration>144</duration><voice>1</voice><type>half</type><dot/><staff>1</staff></note>",
        cur_score_res["musicxml"],
        count=1,
    )
    updated_score = dict(cur_score_res["score_json"])
    updated_score["notes"] = [
        {"id": "ed1", "pitch_midi": 64, "onset_sec": 0.0, "offset_sec": 0.5, "velocity": 90, "track_index": 0}
    ]
    put_res = client.put(
        f"/api/v1/projects/{proj_id}/score",
        headers=headers,
        json={"expected_version": cur_score_res["version"], "score_json": updated_score, "musicxml": updated_xml},
    )
    assert put_res.status_code == 200

    # Compressed .mxl export contains META-INF/container.xml and edited score.musicxml
    mxl_res = client.post(f"/api/v1/projects/{proj_id}/exports", headers=headers, json={"format": "mxl"})
    assert mxl_res.status_code == 201, mxl_res.text
    mxl_dl = client.get(mxl_res.json()["download_url"], headers=headers)
    assert mxl_dl.status_code == 200
    assert mxl_dl.content[:2] == b"PK"
    with zipfile.ZipFile(io.BytesIO(mxl_dl.content), "r") as zf:
        assert "META-INF/container.xml" in zf.namelist()
        assert "score.musicxml" in zf.namelist()
        inner_xml = zf.read("score.musicxml").decode("utf-8")
        assert "<step>E</step>" in inner_xml
        assert "<work-title>Export Etude</work-title>" in inner_xml

    # MIDI & WAV exports succeed
    midi_res = client.post(f"/api/v1/projects/{proj_id}/exports", headers=headers, json={"format": "midi"})
    assert midi_res.status_code == 201
    assert client.get(midi_res.json()["download_url"], headers=headers).content.startswith(b"MThd")

    wav_res = client.post(f"/api/v1/projects/{proj_id}/exports", headers=headers, json={"format": "wav"})
    assert wav_res.status_code == 201
    assert client.get(wav_res.json()["download_url"], headers=headers).content.startswith(b"RIFF")

    # MP3 export: mock _encode_wav_to_mp3 to verify success path AND missing-ffmpeg 503 error reporting
    monkeypatch.setattr("app.notation.satb_audio._encode_wav_to_mp3", lambda _wav: b"ID3-MOCK-MP3-DATA")
    mp3_res = client.post(f"/api/v1/projects/{proj_id}/exports", headers=headers, json={"format": "mp3"})
    assert mp3_res.status_code == 201
    assert client.get(mp3_res.json()["download_url"], headers=headers).content == b"ID3-MOCK-MP3-DATA"

    def _raise_missing_ffmpeg(_wav: bytes) -> bytes:
        raise RuntimeError("ffmpeg is required to export MP3 audio.")

    monkeypatch.setattr("app.notation.satb_audio._encode_wav_to_mp3", _raise_missing_ffmpeg)
    mp3_err = client.post(f"/api/v1/projects/{proj_id}/exports", headers=headers, json={"format": "mp3"})
    assert mp3_err.status_code == 503
    assert "MP3 export unavailable" in mp3_err.json()["detail"]
