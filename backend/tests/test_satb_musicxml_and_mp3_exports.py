"""Tests for PDF/MXL/MusicXML import, SATB separation modes, and R2-backed SATB MP3 exports."""

from __future__ import annotations

import io
import os
import zipfile
from pathlib import Path
from unittest.mock import MagicMock, patch

import music21

from app.core.config import get_settings
from app.notation.omr import (
    musicxml_to_satb_score_data,
    process_satb_musicxml,
    process_satb_pdf,
    validate_musicxml_bytes,
)
from app.storage.service import storage_service


def _auth_headers(client, email: str) -> dict[str, str]:
    reg = client.post(
        "/api/v1/auth/register",
        json={"email": email, "password": "StrongPassword123!", "display_name": "Choir Director"},
    )
    assert reg.status_code == 201
    return {"Authorization": f"Bearer {reg.json()['access_token']}"}


def _build_two_staff_chordal_choral_musicxml(*, include_piano: bool = False) -> str:
    s = music21.stream.Score()
    p_upper = music21.stream.Part()
    p_upper.partName = "Choir Upper"
    m_u = music21.stream.Measure(number=1)
    m_u.append(music21.clef.TrebleClef())
    m_u.append(music21.meter.TimeSignature("4/4"))
    m_u.append(music21.chord.Chord(["E4", "C5"], quarterLength=2.0))
    m_u.append(music21.chord.Chord(["F4", "D5"], quarterLength=2.0))
    p_upper.append(m_u)

    p_lower = music21.stream.Part()
    p_lower.partName = "Choir Lower"
    m_l = music21.stream.Measure(number=1)
    m_l.append(music21.clef.BassClef())
    m_l.append(music21.meter.TimeSignature("4/4"))
    m_l.append(music21.chord.Chord(["C3", "G3"], quarterLength=2.0))
    m_l.append(music21.chord.Chord(["G2", "B3"], quarterLength=2.0))
    p_lower.append(m_l)

    s.insert(0, p_upper)
    s.insert(0, p_lower)

    if include_piano:
        p_piano = music21.stream.Part()
        p_piano.partName = "Piano Accompaniment"
        m_p = music21.stream.Measure(number=1)
        m_p.append(music21.clef.BassClef())
        m_p.append(music21.chord.Chord(["C2", "G2", "C3"], quarterLength=4.0))
        p_piano.append(m_p)
        s.insert(0, p_piano)

    return music21.musicxml.m21ToXml.GeneralObjectExporter(s).parse().decode("utf-8")


def test_direct_musicxml_and_mxl_satb_separation_with_piano_and_keep_original(tmp_path: Path):
    xml_str = _build_two_staff_chordal_choral_musicxml(include_piano=True)
    xml_path = tmp_path / "choral.musicxml"
    xml_path.write_text(xml_str, encoding="utf-8")
    validate_musicxml_bytes(xml_path.read_bytes(), "choral.musicxml")

    # Also package as compressed .mxl and validate
    mxl_path = tmp_path / "choral.mxl"
    with zipfile.ZipFile(mxl_path, "w") as zf:
        zf.writestr("META-INF/container.xml", '<?xml version="1.0"?><container><rootfiles><rootfile full-path="score.musicxml"/></rootfiles></container>')
        zf.writestr("score.musicxml", xml_str)
    validate_musicxml_bytes(mxl_path.read_bytes(), "choral.mxl")

    # Auto-Detect SATB separates Soprano, Alto, Tenor, Bass AND preserves Piano Accompaniment separately
    auto_res = process_satb_musicxml(mxl_path, title="Hymn", satb_mode="auto_satb")
    track_names = [t.name for t in auto_res.score_data.tracks]
    assert track_names == ["Soprano", "Alto", "Tenor", "Bass", "Piano Accompaniment"]
    assert auto_res.score_data.tracks[4].instrument == "piano"

    # Keep Original Staves preserves original part names without forcing SATB separation
    keep_res = process_satb_musicxml(xml_path, title="Hymn", satb_mode="keep_original")
    assert [t.name for t in keep_res.score_data.tracks] == ["Choir Upper", "Choir Lower", "Piano Accompaniment"]
    assert keep_res.needs_review is False


def test_ambiguous_single_staff_flags_needs_review():
    s = music21.stream.Score()
    p = music21.stream.Part()
    p.partName = "Unknown Part"
    m = music21.stream.Measure(number=1)
    m.append(music21.clef.TrebleClef())
    m.append(music21.note.Note("C4", quarterLength=4.0))
    p.append(m)
    s.insert(0, p)
    xml_str = music21.musicxml.m21ToXml.GeneralObjectExporter(s).parse().decode("utf-8")

    _, assignments, warnings, needs_review = musicxml_to_satb_score_data(xml_str, satb_mode="auto_satb")
    assert needs_review is True
    assert assignments[0].uncertain is True
    assert len(warnings) >= 1


def test_pdf_to_musicxml_conversion_with_mocked_omr(tmp_path: Path):
    from pypdf import PdfWriter

    pdf_path = tmp_path / "choir.pdf"
    writer = PdfWriter()
    writer.add_blank_page(width=612, height=792)
    with pdf_path.open("wb") as f:
        writer.write(f)

    sample_xml = _build_two_staff_chordal_choral_musicxml(include_piano=False)
    with patch("app.notation.omr.find_audiveris_executable", return_value=None), patch(
        "app.notation.omr.render_pdf_pages_to_images", return_value=[tmp_path / "p1.png"]
    ), patch("app.notation.omr.run_homr_on_images", return_value=(sample_xml, [])):
        res = process_satb_pdf(pdf_path, title="PDF Choir", work_dir=tmp_path / "work", satb_mode="auto_satb")
        assert res.page_count == 1
        assert [t.name for t in res.score_data.tracks] == ["Soprano", "Alto", "Tenor", "Bass"]


def test_musicxml_upload_and_individual_satb_mp3_exports_saved_via_r2(client, db_session, tmp_path: Path):
    headers = _auth_headers(client, "satb_mp3_r2@example.com")
    other_headers = _auth_headers(client, "satb_mp3_other@example.com")

    proj = client.post(
        "/api/v1/projects",
        headers=headers,
        json={"title": "Choir Rehearsal", "instrument": "vocals", "transcription_mode": "satb_pdf"},
    ).json()
    project_id = proj["id"]

    xml_str = _build_two_staff_chordal_choral_musicxml(include_piano=False)
    up = client.post(
        "/api/v1/uploads",
        headers=headers,
        data={"project_id": project_id},
        files={"file": ("choir.musicxml", xml_str.encode("utf-8"), "application/vnd.recordare.musicxml+xml")},
    )
    assert up.status_code == 201, up.text

    # Populate score via musicxml_to_satb_score_data
    from app.models import ProjectScore

    score_data, _, _, _ = musicxml_to_satb_score_data(xml_str, title="Choir Rehearsal", satb_mode="auto_satb")
    db_session.add(
        ProjectScore(
            project_id=project_id,
            version=1,
            score_json=score_data.model_dump(),
            musicxml_path=None,
            midi_path=None,
        )
    )
    db_session.commit()

    # Mock R2 storage & MP3 rendering, then export all 4 individual SATB MP3s + MIDI + MusicXML
    os.environ["STORAGE_BACKEND"] = "r2"
    os.environ["R2_BUCKET_NAME"] = "satb-bucket"
    os.environ["R2_ENDPOINT_URL"] = "https://mock.r2.cloudflarestorage.com"
    os.environ["R2_ACCESS_KEY_ID"] = "mock-key"
    os.environ["R2_SECRET_ACCESS_KEY"] = "mock-secret"
    get_settings.cache_clear()

    bucket_store: dict[str, bytes] = {}
    mock_s3 = MagicMock()
    mock_s3.put_object.side_effect = lambda Bucket, Key, Body, ContentType: bucket_store.__setitem__(Key, Body)
    mock_s3.get_object.side_effect = lambda Bucket, Key: {"Body": io.BytesIO(bucket_store[Key])}

    try:
        with patch.object(storage_service, "_s3_client", return_value=mock_s3), patch(
            "app.notation.satb_audio._encode_wav_to_mp3", side_effect=lambda wav: b"ID3MOCKMP3" + wav[:16]
        ):
            for voice in ("soprano", "alto", "tenor", "bass"):
                exp = client.post(
                    f"/api/v1/projects/{project_id}/exports",
                    headers=headers,
                    json={"format": f"{voice}_mp3"},
                )
                assert exp.status_code == 201, exp.text
                exp_id = exp.json()["id"]

                # Cross-user access denied
                assert client.get(f"/api/v1/exports/{exp_id}/download", headers=other_headers).status_code == 403

                dl = client.get(f"/api/v1/exports/{exp_id}/download", headers=headers)
                assert dl.status_code == 200
                assert dl.content.startswith(b"ID3MOCKMP3")
                assert f'filename="{voice.capitalize()}.mp3"' in dl.headers.get("content-disposition", "")

            for fmt in ("midi", "musicxml"):
                exp = client.post(
                    f"/api/v1/projects/{project_id}/exports",
                    headers=headers,
                    json={"format": fmt},
                )
                assert exp.status_code == 201, exp.text
                dl = client.get(f"/api/v1/exports/{exp.json()['id']}/download", headers=headers)
                assert dl.status_code == 200 and len(dl.content) > 0
    finally:
        os.environ["STORAGE_BACKEND"] = "local"
        get_settings.cache_clear()
