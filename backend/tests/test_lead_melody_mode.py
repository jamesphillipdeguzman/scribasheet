"""Regression tests for Lead Melody monophonic extraction and single-staff lead-sheet generation."""

from __future__ import annotations

import xml.etree.ElementTree as ET

from app.models import Project, ProjectScore
from app.notation.generator import build_score_data, score_data_to_musicxml
from app.notation.melody import extract_lead_melody, is_lead_melody_mode
from app.transcription.base import DetectedNote


def test_is_lead_melody_mode_aliases():
    assert is_lead_melody_mode("melody") is True
    assert is_lead_melody_mode("lead_melody") is True
    assert is_lead_melody_mode("LEAD_MELODY") is True
    assert is_lead_melody_mode("piano_arrangement") is False
    assert is_lead_melody_mode("single_instrument") is False
    assert is_lead_melody_mode(None) is False


def test_extract_lead_melody_selects_monophonic_line_and_rejects_accompaniment():
    # Measure 1-2: C major / G major polyphonic piano texture:
    # Bass (C3=48, G2=43) + inner chord (E3=52, G3=55, D3=50, B3=59) + melody (E4=64, F4=65, G4=67, G4=67, F4=65, E4=64, D4=62)
    notes = [
        # Beat 1: C3 + E3 + G3 + E4 (melody)
        DetectedNote(pitch_midi=48, onset_sec=0.0, offset_sec=1.9, velocity=85, confidence=0.85),
        DetectedNote(pitch_midi=52, onset_sec=0.0, offset_sec=0.95, velocity=70, confidence=0.80),
        DetectedNote(pitch_midi=55, onset_sec=0.0, offset_sec=0.95, velocity=72, confidence=0.80),
        DetectedNote(pitch_midi=64, onset_sec=0.0, offset_sec=0.48, velocity=96, confidence=0.92),
        # Beat 2: F4 (melody) + quiet inner G3 tap
        DetectedNote(pitch_midi=55, onset_sec=0.5, offset_sec=0.95, velocity=62, confidence=0.72),
        DetectedNote(pitch_midi=65, onset_sec=0.5, offset_sec=0.98, velocity=95, confidence=0.91),
        # Beat 3: G4 (melody) + C3 bass
        DetectedNote(pitch_midi=48, onset_sec=1.0, offset_sec=1.95, velocity=80, confidence=0.85),
        DetectedNote(pitch_midi=67, onset_sec=1.0, offset_sec=1.48, velocity=98, confidence=0.94),
        # Beat 4: repeated G4 (melody) + weak +12 harmonic overtone G5
        DetectedNote(pitch_midi=67, onset_sec=1.5, offset_sec=1.98, velocity=97, confidence=0.93),
        DetectedNote(pitch_midi=79, onset_sec=1.5, offset_sec=1.95, velocity=38, confidence=0.35),
        # Bar 2 Beat 1: G2 bass + B3 inner + F4 melody
        DetectedNote(pitch_midi=43, onset_sec=2.0, offset_sec=3.9, velocity=84, confidence=0.86),
        DetectedNote(pitch_midi=59, onset_sec=2.0, offset_sec=2.95, velocity=68, confidence=0.78),
        DetectedNote(pitch_midi=65, onset_sec=2.0, offset_sec=2.48, velocity=94, confidence=0.91),
        # Bar 2 Beat 2: E4 melody
        DetectedNote(pitch_midi=64, onset_sec=2.5, offset_sec=2.98, velocity=92, confidence=0.90),
        # Bar 2 Beat 3: D4 melody (with genuine rest after)
        DetectedNote(pitch_midi=62, onset_sec=3.0, offset_sec=3.45, velocity=90, confidence=0.89),
    ]

    result = extract_lead_melody(notes, tempo_bpm=120.0)
    extracted_pitches = [n.pitch_midi for n in result.notes]
    assert extracted_pitches == [64, 65, 67, 67, 65, 64, 62]

    # Strict monophony: no two notes overlap or share onset
    for prev, cur in zip(result.notes, result.notes[1:], strict=False):
        assert prev.offset_sec <= cur.onset_sec
        assert cur.onset_sec - prev.onset_sec >= 0.015


def test_extract_lead_melody_preserves_low_register_melody():
    # Solo cello/baritone melody in G2-D3 (below C4) must NOT be discarded
    low_melody = [
        DetectedNote(pitch_midi=43, onset_sec=0.0, offset_sec=0.45, velocity=90, confidence=0.9),
        DetectedNote(pitch_midi=45, onset_sec=0.5, offset_sec=0.95, velocity=90, confidence=0.9),
        DetectedNote(pitch_midi=47, onset_sec=1.0, offset_sec=1.45, velocity=90, confidence=0.9),
        DetectedNote(pitch_midi=48, onset_sec=1.5, offset_sec=1.95, velocity=90, confidence=0.9),
        DetectedNote(pitch_midi=50, onset_sec=2.0, offset_sec=2.9, velocity=92, confidence=0.92),
    ]
    result = extract_lead_melody(low_melody, tempo_bpm=120.0)
    assert [n.pitch_midi for n in result.notes] == [43, 45, 47, 48, 50]


def test_lead_melody_score_and_musicxml_are_single_staff_with_polyphonic_chords():
    polyphonic_notes = [
        # Bar 1: C major triad + melody E4->F4->G4->E4
        DetectedNote(pitch_midi=48, onset_sec=0.0, offset_sec=1.9, velocity=85, confidence=0.9),
        DetectedNote(pitch_midi=52, onset_sec=0.0, offset_sec=1.9, velocity=75, confidence=0.85),
        DetectedNote(pitch_midi=55, onset_sec=0.0, offset_sec=1.9, velocity=75, confidence=0.85),
        DetectedNote(pitch_midi=64, onset_sec=0.0, offset_sec=0.48, velocity=96, confidence=0.95),
        DetectedNote(pitch_midi=65, onset_sec=0.5, offset_sec=0.98, velocity=96, confidence=0.95),
        DetectedNote(pitch_midi=67, onset_sec=1.0, offset_sec=1.48, velocity=96, confidence=0.95),
        DetectedNote(pitch_midi=64, onset_sec=1.5, offset_sec=1.98, velocity=96, confidence=0.95),
        # Bar 2: G major triad + melody D4->B3->G4
        DetectedNote(pitch_midi=43, onset_sec=2.0, offset_sec=3.9, velocity=85, confidence=0.9),
        DetectedNote(pitch_midi=47, onset_sec=2.0, offset_sec=3.9, velocity=75, confidence=0.85),
        DetectedNote(pitch_midi=50, onset_sec=2.0, offset_sec=3.9, velocity=75, confidence=0.85),
        DetectedNote(pitch_midi=62, onset_sec=2.0, offset_sec=2.48, velocity=96, confidence=0.95),
        DetectedNote(pitch_midi=59, onset_sec=2.5, offset_sec=2.98, velocity=94, confidence=0.94),
        DetectedNote(pitch_midi=67, onset_sec=3.0, offset_sec=3.9, velocity=96, confidence=0.95),
    ]

    melody_res = extract_lead_melody(polyphonic_notes, tempo_bpm=120.0)
    score = build_score_data(
        title="Lead Sheet Test",
        detected_notes=melody_res.notes,
        tempo_bpm=120.0,
        tempo_estimated=False,
        time_signature="4/4",
        time_signature_estimated=False,
        key_signature="C",
        key_signature_estimated=False,
        duration_seconds=4.0,
        instrument="piano",
        quantization="sixteenth",
        clef_override="treble",
        track_name_override="Lead Melody",
        chord_source_notes=polyphonic_notes,
        monophonic=True,
        analysis={"mode": "melody"},
    )

    assert len(score.tracks) == 1
    assert score.tracks[0].clef == "treble"
    assert score.tracks[0].name == "Lead Melody"
    assert len(score.chords) >= 1

    xml_str = score_data_to_musicxml(score)
    root = ET.fromstring(xml_str)
    parts = root.findall("part")
    assert len(parts) == 1

    # Single-staff treble clef, no multi-staff grand layout
    staves_elems = root.findall(".//staves")
    assert all(int(el.text or "1") == 1 for el in staves_elems)

    # Zero simultaneous chord-stacked notes and single voice
    assert root.findall(".//note/chord") == []
    voices = {v.text for v in root.findall(".//note/voice") if v.text}
    assert voices <= {"1"}
    assert len(root.findall(".//note/pitch")) >= 5

    # Harmonic chord symbols preserved above melody staff
    assert len(root.findall(".//harmony")) >= 1


def test_piano_arrangement_mode_still_builds_grand_staff():
    notes = [
        DetectedNote(pitch_midi=48, onset_sec=0.0, offset_sec=0.9, velocity=85, confidence=0.9),
        DetectedNote(pitch_midi=64, onset_sec=0.0, offset_sec=0.9, velocity=95, confidence=0.95),
    ]
    score = build_score_data(
        title="Grand Staff Test",
        detected_notes=notes,
        tempo_bpm=120.0,
        tempo_estimated=False,
        time_signature="4/4",
        time_signature_estimated=False,
        key_signature="C",
        key_signature_estimated=False,
        duration_seconds=1.0,
        instrument="piano",
        quantization="sixteenth",
    )
    assert score.tracks[0].clef == "grand"


def test_regenerate_arrangement_preserves_lead_melody_monophony(client, db_session):
    reg = client.post(
        "/api/v1/auth/register",
        json={
            "email": "lead_melody_test@scribasheet.dev",
            "password": "Password123!",
            "display_name": "Lead Melody Tester",
        },
    )
    if reg.status_code == 201:
        token = reg.json()["access_token"]
        user_id = reg.json()["user"]["id"]
    else:
        login = client.post(
            "/api/v1/auth/login",
            json={"email": "lead_melody_test@scribasheet.dev", "password": "Password123!"},
        )
        assert login.status_code == 200
        token = login.json()["access_token"]
        user_id = login.json()["user"]["id"]
    auth_headers = {"Authorization": f"Bearer {token}"}

    project = Project(
        user_id=user_id,
        title="Lead Melody Regeneration",
        instrument="piano",
        transcription_mode="melody",
        status="completed",
    )
    db_session.add(project)
    db_session.commit()
    db_session.refresh(project)

    raw_polyphonic = [
        {"pitch_midi": 48, "onset_sec": 0.0, "offset_sec": 1.0, "velocity": 80, "confidence": 0.85},
        {"pitch_midi": 55, "onset_sec": 0.0, "offset_sec": 1.0, "velocity": 75, "confidence": 0.82},
        {"pitch_midi": 64, "onset_sec": 0.0, "offset_sec": 0.48, "velocity": 95, "confidence": 0.94},
        {"pitch_midi": 48, "onset_sec": 0.5, "offset_sec": 1.0, "velocity": 78, "confidence": 0.84},
        {"pitch_midi": 67, "onset_sec": 0.5, "offset_sec": 0.98, "velocity": 96, "confidence": 0.95},
    ]

    initial_score = build_score_data(
        title=project.title,
        detected_notes=[
            DetectedNote(pitch_midi=64, onset_sec=0.0, offset_sec=0.48, velocity=95, confidence=0.94),
            DetectedNote(pitch_midi=67, onset_sec=0.5, offset_sec=0.98, velocity=96, confidence=0.95),
        ],
        tempo_bpm=120.0,
        tempo_estimated=False,
        time_signature="4/4",
        time_signature_estimated=False,
        key_signature="C",
        key_signature_estimated=False,
        duration_seconds=1.0,
        instrument="piano",
        quantization="sixteenth",
        clef_override="treble",
        track_name_override="Lead Melody",
        analysis={
            "mode": "melody",
            "raw_detected_notes": raw_polyphonic,
        },
    )

    score_row = ProjectScore(
        project_id=project.id,
        version=1,
        score_json=initial_score.model_dump(),
        musicxml_path="unused/score.musicxml",
        midi_path="unused/score.mid",
    )
    db_session.add(score_row)
    db_session.commit()

    resp = client.post(
        f"/api/v1/projects/{project.id}/score/regenerate",
        headers=auth_headers,
        json={"arrangement_detail": "detailed", "quantization": "sixteenth"},
    )
    assert resp.status_code == 200
    body = resp.json()
    score_json = body["score_json"]

    # Must stay single-staff treble Lead Melody and never restore bass/inner accompaniment
    assert len(score_json["tracks"]) == 1
    assert score_json["tracks"][0]["clef"] == "treble"
    assert score_json["tracks"][0]["name"] == "Lead Melody"
    pitches = [n["pitch_midi"] for n in score_json["notes"]]
    assert pitches == [64, 67]
    # Original polyphonic raw_detected_notes must remain intact
    assert len(score_json["analysis"]["raw_detected_notes"]) == len(raw_polyphonic)
