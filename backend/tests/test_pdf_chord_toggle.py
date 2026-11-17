"""Regression tests for optional chord symbol visibility toggle on PDF/MusicXML export."""

from __future__ import annotations

import xml.etree.ElementTree as ET
from unittest.mock import patch

import music21
import pytest

from app.api.v1.exports import _resolve_pdf_export_bytes
from app.models import (
    MediaAsset,
    Project,
    ProjectScore,
    TranscriptionJob,
    TranscriptionResult,
    User,
)
from app.notation.generator import (
    _find_musescore_binary,
    count_pdf_pages,
    render_score_pdf,
    score_data_to_musicxml,
)
from app.schemas.score import ScoreChord, ScoreData, ScoreNote, ScoreTrack


def _sample_score_with_chords_and_8va() -> ScoreData:
    notes = [
        ScoreNote(
            id="n1",
            pitch_midi=48,
            pitch_name="C3",
            onset_sec=0.0,
            offset_sec=2.0,
            velocity=82,
            hand="LH",
            measure=1,
            beat=1.0,
        ),
        ScoreNote(
            id="n2",
            pitch_midi=88,
            pitch_name="E6",
            onset_sec=0.0,
            offset_sec=0.5,
            velocity=80,
            hand="RH",
            measure=1,
            beat=1.0,
        ),
        ScoreNote(
            id="n3",
            pitch_midi=91,
            pitch_name="G6",
            onset_sec=0.5,
            offset_sec=1.0,
            velocity=80,
            hand="RH",
            measure=1,
            beat=2.0,
        ),
        ScoreNote(
            id="n4",
            pitch_midi=96,
            pitch_name="C7",
            onset_sec=1.0,
            offset_sec=2.0,
            velocity=84,
            hand="RH",
            measure=1,
            beat=3.0,
        ),
    ]
    chords = [
        ScoreChord(
            id="c1",
            measure=1,
            beat=1.0,
            onset_sec=0.0,
            symbol="C",
            root="C",
            quality="major",
            confidence=0.92,
        ),
    ]
    return ScoreData(
        title="Chord Toggle Test",
        tempo_bpm=120.0,
        time_signature="4/4",
        key_signature="C major",
        duration_seconds=2.0,
        tracks=[ScoreTrack(index=0, name="Piano", instrument="piano", clef="grand")],
        notes=notes,
        chords=chords,
    )


def _extract_sounding_pitches(xml_str: str) -> list[int]:
    parsed = music21.converter.parseData(xml_str, format="musicxml")
    pitches: list[int] = []
    for el in parsed.recurse().notes:
        if isinstance(el, music21.harmony.ChordSymbol):
            continue
        if isinstance(el, music21.chord.Chord):
            pitches.extend(int(p.midi) for p in el.pitches)
        else:
            pitches.append(int(el.pitch.midi))
    return sorted(pitches)


def test_musicxml_include_chords_toggle_preserves_notes_8va_and_original_score() -> None:
    score = _sample_score_with_chords_and_8va()
    xml_on = score_data_to_musicxml(score, include_chords=True)
    xml_off = score_data_to_musicxml(score, include_chords=False)
    xml_on_again = score_data_to_musicxml(score, include_chords=True)

    root_on = ET.fromstring(xml_on)
    root_off = ET.fromstring(xml_off)
    root_on2 = ET.fromstring(xml_on_again)

    assert len(root_on.findall(".//harmony")) == 1
    assert len(root_off.findall(".//harmony")) == 0
    assert len(root_on2.findall(".//harmony")) == 1

    # Original score object remains untouched
    assert len(score.chords) == 1
    assert score.chords[0].symbol == "C"

    # Sounding pitches and 8va octave-shift notation are preserved identically
    assert _extract_sounding_pitches(xml_on) == _extract_sounding_pitches(xml_off)
    shifts_on = [(el.get("type"), el.get("size")) for el in root_on.findall(".//octave-shift")]
    shifts_off = [(el.get("type"), el.get("size")) for el in root_off.findall(".//octave-shift")]
    assert ("down", "8") in shifts_on
    assert shifts_on == shifts_off


def test_reportlab_fallback_respects_include_chords_toggle(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DISABLE_MUSESCORE_PDF", "1")
    score = _sample_score_with_chords_and_8va()

    pdf_on = render_score_pdf(score, include_chords=True)
    pdf_off = render_score_pdf(score, include_chords=False)

    assert pdf_on.startswith(b"%PDF-")
    assert pdf_off.startswith(b"%PDF-")
    assert count_pdf_pages(pdf_on) == count_pdf_pages(pdf_off) >= 1
    assert pdf_on != pdf_off


def test_musescore_pdf_respects_include_chords_toggle(monkeypatch: pytest.MonkeyPatch) -> None:
    if not _find_musescore_binary():
        pytest.skip("MuseScore 4 binary not installed")
    monkeypatch.delenv("DISABLE_MUSESCORE_PDF", raising=False)
    score = _sample_score_with_chords_and_8va()

    pdf_on = render_score_pdf(score, include_chords=True)
    pdf_off = render_score_pdf(score, include_chords=False)

    assert pdf_on.startswith(b"%PDF-")
    assert pdf_off.startswith(b"%PDF-")
    assert count_pdf_pages(pdf_on) >= 1
    assert count_pdf_pages(pdf_off) >= 1
    assert pdf_on != pdf_off


def test_pdf_cache_distinguishes_include_chords_and_defaults_true(
    db_session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("DISABLE_MUSESCORE_PDF", "1")
    score = _sample_score_with_chords_and_8va()

    user = User(email="toggle@example.com", password_hash="x", display_name="Toggle User")
    db_session.add(user)
    db_session.flush()
    project = Project(user_id=user.id, title="Toggle Project")
    db_session.add(project)
    db_session.flush()
    db_session.add(ProjectScore(project_id=project.id, score_json=score.model_dump(), version=1))
    asset = MediaAsset(
        project_id=project.id,
        user_id=user.id,
        asset_type="pdf",
        storage_path="cached/chords_on.pdf",
        original_filename="score.pdf",
        mime_type="application/pdf",
        size_bytes=600,
    )
    db_session.add(asset)
    db_session.flush()
    job = TranscriptionJob(project_id=project.id, user_id=user.id, status="completed")
    db_session.add(job)
    db_session.flush()
    db_session.add(
        TranscriptionResult(
            job_id=job.id,
            metadata_json={"pdf_asset_id": asset.id, "pdf_score_version": 1},
        )
    )
    db_session.commit()

    cached_pdf_bytes = b"%PDF-1.4\n%CachedMuseScoreChordsOn\n%%EOF\n" + b"0" * 600
    with (
        patch("app.api.v1.exports.storage_service.read_bytes", return_value=cached_pdf_bytes),
        patch("app.api.v1.exports.count_pdf_pages", return_value=1),
    ):
        # Default (include_chords=True) reuses the worker-cached chords-ON PDF
        res_default = _resolve_pdf_export_bytes(db_session, project.id, 1, score)
        assert res_default == cached_pdf_bytes

        # include_chords=False MUST NOT reuse the chords-ON cached PDF
        res_off = _resolve_pdf_export_bytes(db_session, project.id, 1, score, include_chords=False)
        assert res_off != cached_pdf_bytes
        assert res_off.startswith(b"%PDF-")
