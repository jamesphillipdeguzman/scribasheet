"""Tests for inline project renaming validation, authorization, and MusicXML/PDF title sync."""

from __future__ import annotations

import xml.etree.ElementTree as ET

import pytest

from app.models import ProjectScore
from app.schemas.score import ScoreChord, ScoreData, ScoreNote, ScoreTrack


def _auth_headers(client, email: str, password: str = "Password123!") -> dict[str, str]:
    client.post(
        "/api/v1/auth/register",
        json={"email": email, "password": password, "display_name": "Tester"},
    )
    res = client.post("/api/v1/auth/login", json={"email": email, "password": password})
    assert res.status_code == 200, res.text
    token = res.json()["access_token"]
    return {"Authorization": f"Bearer {token}"}


def test_patch_project_title_validation_trimming_and_ownership(client) -> None:
    owner_headers = _auth_headers(client, "rename_owner@example.com")
    other_headers = _auth_headers(client, "rename_other@example.com")

    create_res = client.post(
        "/api/v1/projects",
        headers=owner_headers,
        json={"title": "Original Song", "instrument": "piano"},
    )
    assert create_res.status_code == 201
    project_id = create_res.json()["id"]

    # Whitespace is trimmed
    res_trim = client.patch(
        f"/api/v1/projects/{project_id}",
        headers=owner_headers,
        json={"title": "  Christmas Medley - O Come All Ye Faithful  "},
    )
    assert res_trim.status_code == 200
    assert res_trim.json()["title"] == "Christmas Medley - O Come All Ye Faithful"

    # Empty / whitespace-only title rejected
    res_empty = client.patch(
        f"/api/v1/projects/{project_id}",
        headers=owner_headers,
        json={"title": "   "},
    )
    assert res_empty.status_code == 422

    # Over 120 characters rejected
    res_long = client.patch(
        f"/api/v1/projects/{project_id}",
        headers=owner_headers,
        json={"title": "A" * 121},
    )
    assert res_long.status_code == 422

    # Exactly 120 characters accepted
    res_120 = client.patch(
        f"/api/v1/projects/{project_id}",
        headers=owner_headers,
        json={"title": "B" * 120},
    )
    assert res_120.status_code == 200
    assert len(res_120.json()["title"]) == 120

    # Unauthorized / non-owner rejected
    res_unauth = client.patch(
        f"/api/v1/projects/{project_id}",
        json={"title": "Hacked"},
    )
    assert res_unauth.status_code == 401

    res_other = client.patch(
        f"/api/v1/projects/{project_id}",
        headers=other_headers,
        json={"title": "Stolen"},
    )
    assert res_other.status_code in (403, 404)


def test_renamed_project_title_updates_musicxml_and_pdf_exports_without_retranscription(
    client,
    db_session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("DISABLE_MUSESCORE_PDF", "1")
    headers = _auth_headers(client, "rename_export@example.com")

    create_res = client.post(
        "/api/v1/projects",
        headers=headers,
        json={"title": "Old Project Name", "instrument": "piano"},
    )
    assert create_res.status_code == 201
    project_id = create_res.json()["id"]

    score = ScoreData(
        title="Old Project Name",
        tempo_bpm=120.0,
        time_signature="4/4",
        key_signature="C major",
        duration_seconds=2.0,
        tracks=[ScoreTrack(index=0, name="Piano", instrument="piano", clef="grand")],
        notes=[
            ScoreNote(
                id="n1",
                pitch_midi=60,
                pitch_name="C4",
                onset_sec=0.0,
                offset_sec=1.0,
                velocity=80,
                hand="RH",
                measure=1,
                beat=1.0,
            )
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
                confidence=0.9,
            )
        ],
    )
    db_session.add(ProjectScore(project_id=project_id, score_json=score.model_dump(), version=1))
    db_session.commit()

    new_title = "Christmas Medley - O Come All Ye Faithful"
    patch_res = client.patch(
        f"/api/v1/projects/{project_id}",
        headers=headers,
        json={"title": new_title},
    )
    assert patch_res.status_code == 200
    assert patch_res.json()["title"] == new_title

    # MusicXML export reflects new title in work-title / movement-title and preserves notes/chords
    xml_exp = client.post(
        f"/api/v1/projects/{project_id}/exports",
        headers=headers,
        json={"format": "musicxml"},
    )
    assert xml_exp.status_code == 201
    xml_dl = client.get(xml_exp.json()["download_url"], headers=headers)
    assert xml_dl.status_code == 200
    root = ET.fromstring(xml_dl.text)
    work_title = root.findtext(".//work/work-title") or ""
    movement_title = root.findtext(".//movement-title") or ""
    assert new_title in (work_title, movement_title)
    assert len(root.findall(".//harmony")) == 1

    # PDF export succeeds with updated title
    pdf_exp = client.post(
        f"/api/v1/projects/{project_id}/exports",
        headers=headers,
        json={"format": "pdf"},
    )
    assert pdf_exp.status_code == 201
    pdf_dl = client.get(pdf_exp.json()["download_url"], headers=headers)
    assert pdf_dl.status_code == 200
    assert pdf_dl.content.startswith(b"%PDF-")
