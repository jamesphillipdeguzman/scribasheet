"""Tests for UTC 'Z' timestamp serialization and MusicXML/PDF include_chords API behavior."""

from __future__ import annotations

import json
import xml.etree.ElementTree as ET
from datetime import UTC, datetime, timedelta, timezone

from app.models import ProjectScore
from app.schemas.export import ExportResponse
from app.schemas.score import ScoreChord, ScoreData, ScoreNote, ScoreTrack


def _auth_headers(client, email: str, password: str = "Password123!") -> dict[str, str]:
    client.post(
        "/api/v1/auth/register",
        json={"email": email, "password": password, "display_name": "Tester"},
    )
    res = client.post("/api/v1/auth/login", json={"email": email, "password": password})
    assert res.status_code == 200
    return {"Authorization": f"Bearer {res.json()['access_token']}"}


def test_utc_datetime_serialization_handles_naive_and_aware_timestamps() -> None:
    naive = datetime(2026, 11, 17, 13, 11, 46)
    aware_utc = datetime(2026, 11, 17, 13, 11, 46, tzinfo=UTC)
    aware_ph = datetime(2026, 11, 17, 21, 11, 46, tzinfo=timezone(timedelta(hours=8)))

    for dt in (naive, aware_utc, aware_ph):
        resp = ExportResponse(
            id="exp-1",
            project_id="proj-1",
            format="pdf",
            status="completed",
            created_at=dt,
            completed_at=dt,
        )
        payload = json.loads(resp.model_dump_json())
        assert payload["created_at"] == "2026-11-17T13:11:46Z"
        assert payload["completed_at"] == "2026-11-17T13:11:46Z"


def test_musicxml_export_endpoint_respects_include_chords_without_mutating_score(
    client,
    db_session,
) -> None:
    headers = _auth_headers(client, "xml_chords@example.com")
    proj_res = client.post(
        "/api/v1/projects",
        headers=headers,
        json={"title": "Chord Sync Test", "instrument": "piano"},
    )
    assert proj_res.status_code == 201
    project_id = proj_res.json()["id"]

    score = ScoreData(
        title="Chord Sync Test",
        tempo_bpm=120.0,
        time_signature="4/4",
        key_signature="C major",
        duration_seconds=2.0,
        tracks=[ScoreTrack(index=0, name="Piano", instrument="piano", clef="grand")],
        notes=[
            ScoreNote(id="n1", pitch_midi=60, onset_sec=0.0, offset_sec=1.0, velocity=80),
            ScoreNote(id="n2", pitch_midi=64, onset_sec=0.0, offset_sec=1.0, velocity=80),
            ScoreNote(id="n3", pitch_midi=67, onset_sec=0.0, offset_sec=1.0, velocity=80),
        ],
        chords=[
            ScoreChord(
                id="c1",
                measure=1,
                beat=1.0,
                onset_sec=0.0,
                symbol="C",
                root="C",
                quality="major",
                confidence=0.92,
            )
        ],
    )
    db_session.add(ProjectScore(project_id=project_id, score_json=score.model_dump(), version=1))
    db_session.commit()

    # Export MusicXML with chords OFF
    exp_off = client.post(
        f"/api/v1/projects/{project_id}/exports",
        headers=headers,
        json={"format": "musicxml", "include_chords": False},
    )
    assert exp_off.status_code == 201
    assert exp_off.json()["created_at"].endswith("Z")
    dl_off = client.get(exp_off.json()["download_url"], headers=headers)
    root_off = ET.fromstring(dl_off.text)
    assert len(root_off.findall(".//harmony")) == 0
    assert len(root_off.findall(".//note")) >= 3

    # Export MusicXML with chords ON -> original chords are intact
    exp_on = client.post(
        f"/api/v1/projects/{project_id}/exports",
        headers=headers,
        json={"format": "musicxml", "include_chords": True},
    )
    assert exp_on.status_code == 201
    dl_on = client.get(exp_on.json()["download_url"], headers=headers)
    root_on = ET.fromstring(dl_on.text)
    assert len(root_on.findall(".//harmony")) == 1
