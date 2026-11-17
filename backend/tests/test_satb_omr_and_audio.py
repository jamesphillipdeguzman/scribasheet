"""Tests for Reverse Transcription (SATB PDF OMR, voice identification, and synchronized MP3/WAV export)."""

from __future__ import annotations

import io
from unittest.mock import patch

import music21
import pytest
import soundfile as sf
from pypdf import PdfWriter

from app.models import ProjectScore
from app.notation.omr import (
    OMRError,
    identify_satb_parts,
    musicxml_to_satb_score_data,
    run_homr_on_images,
    validate_pdf_bytes,
)
from app.notation.satb_audio import render_satb_audio_tracks
from app.schemas.score import ScoreData, ScoreNote, ScoreTrack


def _auth_headers(client, email: str, password: str = "Password123!") -> dict[str, str]:
    client.post(
        "/api/v1/auth/register",
        json={"email": email, "password": password, "display_name": "Choir Director"},
    )
    res = client.post("/api/v1/auth/login", json={"email": email, "password": password})
    assert res.status_code == 200
    return {"Authorization": f"Bearer {res.json()['access_token']}"}


def _make_blank_pdf_bytes(*, encrypt: bool = False) -> bytes:
    writer = PdfWriter()
    writer.add_blank_page(width=612, height=792)
    if encrypt:
        writer.encrypt("secret")
    buf = io.BytesIO()
    writer.write(buf)
    return buf.getvalue()


def test_pdf_validation_rejects_empty_corrupted_and_encrypted_pdfs() -> None:
    with pytest.raises(OMRError) as exc_empty:
        validate_pdf_bytes(b"")
    assert exc_empty.value.code == "EMPTY_PDF"

    with pytest.raises(OMRError) as exc_invalid:
        validate_pdf_bytes(b"NOT A PDF" * 10)
    assert exc_invalid.value.code == "INVALID_PDF"

    with pytest.raises(OMRError) as exc_corrupt:
        validate_pdf_bytes(b"%PDF-1.4\ncorrupted_bytes_here_1234567890")
    assert exc_corrupt.value.code == "CORRUPTED_PDF"

    with pytest.raises(OMRError) as exc_enc:
        validate_pdf_bytes(_make_blank_pdf_bytes(encrypt=True))
    assert exc_enc.value.code == "ENCRYPTED_PDF"

    assert validate_pdf_bytes(_make_blank_pdf_bytes()) == 1


def test_omr_dependency_missing_raises_clear_error(tmp_path) -> None:
    img = tmp_path / "page_001.png"
    img.write_bytes(b"fake")
    with patch("app.notation.omr.find_homr_executable", return_value=None):
        with pytest.raises(OMRError) as exc:
            run_homr_on_images([img])
    assert exc.value.code == "OMR_DEPENDENCY_MISSING"


def test_shared_staff_voice_extraction_and_satb_identification() -> None:
    # Build a 2-staff grand-choir score (SA shared treble staff + TB shared bass staff)
    s = music21.stream.Score()
    p_sa = music21.stream.Part(id="SA")
    p_sa.partName = "SA"
    m_sa = music21.stream.Measure(number=1)
    m_sa.append(music21.clef.TrebleClef())
    v1 = music21.stream.Voice(id="1")
    v1.append(music21.note.Note("G5", quarterLength=2.0))
    v2 = music21.stream.Voice(id="2")
    v2.append(music21.note.Note("E4", quarterLength=2.0))
    m_sa.insert(0, v1)
    m_sa.insert(0, v2)
    p_sa.append(m_sa)

    p_tb = music21.stream.Part(id="TB")
    p_tb.partName = "TB"
    m_tb = music21.stream.Measure(number=1)
    m_tb.append(music21.clef.BassClef())
    v3 = music21.stream.Voice(id="1")
    v3.append(music21.note.Note("C4", quarterLength=2.0))
    v4 = music21.stream.Voice(id="2")
    v4.append(music21.note.Note("C3", quarterLength=2.0))
    m_tb.insert(0, v3)
    m_tb.insert(0, v4)
    p_tb.append(m_tb)

    s.insert(0, p_sa)
    s.insert(0, p_tb)

    assignments, _, _ = identify_satb_parts(s)
    assert len(assignments) == 4
    assert {a.assigned_voice for a in assignments} == {"Soprano", "Alto", "Tenor", "Bass"}

    # Uncertain 2-voice score flags needs_review=True
    s_two = music21.stream.Score()
    p_only = music21.stream.Part(id="Unknown")
    m_only = music21.stream.Measure(number=1)
    m_only.append(music21.note.Note("C5", quarterLength=1.0))
    p_only.append(m_only)
    s_two.insert(0, p_only)
    _, warnings, needs_review = identify_satb_parts(s_two)
    assert needs_review is True
    assert len(warnings) >= 1


def test_satb_synchronized_audio_rendering_individual_and_combined() -> None:
    score = ScoreData(
        title="O Come All Ye Faithful",
        tempo_bpm=120.0,
        time_signature="4/4",
        key_signature="G major",
        duration_seconds=2.0,
        tracks=[
            ScoreTrack(index=0, name="Soprano", instrument="choir_aahs", clef="treble", program=52),
            ScoreTrack(index=1, name="Alto", instrument="choir_aahs", clef="treble", program=52),
            ScoreTrack(index=2, name="Tenor", instrument="choir_aahs", clef="treble", program=52),
            ScoreTrack(index=3, name="Bass", instrument="choir_aahs", clef="bass", program=52),
        ],
        notes=[
            ScoreNote(id="s1", pitch_midi=74, onset_sec=0.0, offset_sec=1.5, velocity=85, track_index=0),
            ScoreNote(id="a1", pitch_midi=67, onset_sec=0.0, offset_sec=1.5, velocity=80, track_index=1),
            ScoreNote(id="t1", pitch_midi=62, onset_sec=0.0, offset_sec=1.5, velocity=80, track_index=2),
            ScoreNote(id="b1", pitch_midi=55, onset_sec=0.0, offset_sec=1.5, velocity=85, track_index=3),
        ],
    )

    wavs = render_satb_audio_tracks(score, output_format="wav")
    assert set(wavs.keys()) == {"soprano", "alto", "tenor", "bass", "combined"}
    # Combined duration matches individual tracks (simultaneous, not sequential)
    durs = []
    for _k, data in wavs.items():
        wf, sr = sf.read(io.BytesIO(data))
        durs.append(len(wf) / sr)
    assert max(durs) - min(durs) < 0.05

    mp3s = render_satb_audio_tracks(score, output_format="mp3", part_instruments={"soprano": 0})
    assert len(mp3s["combined"]) > 500
    assert len(mp3s["soprano"]) > 500


def test_satb_pdf_upload_assignment_update_and_mp3_export_api(client, db_session) -> None:
    headers = _auth_headers(client, "satb_api@example.com")
    proj_res = client.post(
        "/api/v1/projects",
        headers=headers,
        json={"title": "Amazing Grace SATB", "instrument": "piano", "transcription_mode": "satb_pdf"},
    )
    assert proj_res.status_code == 201
    project_id = proj_res.json()["id"]

    # Valid PDF upload succeeds
    pdf_bytes = _make_blank_pdf_bytes()
    up_ok = client.post(
        "/api/v1/uploads",
        headers=headers,
        data={"project_id": project_id},
        files={"file": ("amazing_grace.pdf", pdf_bytes, "application/pdf")},
    )
    assert up_ok.status_code == 201, up_ok.text

    # Corrupted PDF upload is rejected
    up_bad = client.post(
        "/api/v1/uploads",
        headers=headers,
        data={"project_id": project_id},
        files={"file": ("broken.pdf", b"%PDF-1.4\nbroken_payload_1234567890", "application/pdf")},
    )
    assert up_bad.status_code == 400

    # Persist a 4-part MusicXML score and test assignment updates + SATB MP3 export
    gt_xml = music21.corpus.parse("bach/bwv66.6").write("musicxml")
    xml_str = open(gt_xml, encoding="utf-8").read()
    score_data, _, _, _ = musicxml_to_satb_score_data(xml_str, title="Amazing Grace SATB")
    db_session.add(ProjectScore(project_id=project_id, score_json=score_data.model_dump(), version=1))
    db_session.commit()

    assign_res = client.put(
        f"/api/v1/projects/{project_id}/score/satb-assignments",
        headers=headers,
        json={"assignments": {"0": "Soprano", "1": "Alto", "2": "Tenor", "3": "Bass"}, "instruments": {"0": 0}},
    )
    assert assign_res.status_code == 200
    assert assign_res.json()["version"] == 2

    exp_sop = client.post(
        f"/api/v1/projects/{project_id}/exports/satb",
        headers=headers,
        json={"part": "soprano", "format": "mp3"},
    )
    assert exp_sop.status_code == 200
    assert "Amazing_Grace_SATB_Soprano.mp3" in exp_sop.headers.get("content-disposition", "")
    assert len(exp_sop.content) > 500

    exp_comb = client.post(
        f"/api/v1/projects/{project_id}/exports/satb",
        headers=headers,
        json={"part": "combined", "format": "mp3"},
    )
    assert exp_comb.status_code == 200
    assert "Amazing_Grace_SATB_SATB_Combined.mp3" in exp_comb.headers.get("content-disposition", "")
