"""Tests for Arrangement Detail presets, phrase breathing, triplet quantization,
half-time tempo interpretation, and non-ML arrangement regeneration.
"""

from __future__ import annotations

import xml.etree.ElementTree as ET

import music21

from app.models import ProjectScore
from app.notation.arrangement import simplify_arrangement
from app.notation.beat_tracker import resolve_tempo_from_beats
from app.notation.generator import build_score_data, score_data_to_musicxml
from app.schemas.score import ScoreData, ScoreNote, ScoreTrack
from app.transcription.base import DetectedNote


def _auth_headers(client, email: str, password: str = "Password123!") -> dict[str, str]:
    client.post(
        "/api/v1/auth/register",
        json={"email": email, "password": password, "display_name": "Arranger"},
    )
    res = client.post("/api/v1/auth/login", json={"email": email, "password": password})
    assert res.status_code == 200
    return {"Authorization": f"Bearer {res.json()['access_token']}"}


def test_arrangement_presets_preserve_raw_notes_and_differentiate_density() -> None:
    raw = [
        # LH cluster: bass C3 + G3 + weak octave C4 + isolated transient F2
        DetectedNote(pitch_midi=48, onset_sec=0.0, offset_sec=2.0, velocity=92, confidence=0.90),
        DetectedNote(pitch_midi=55, onset_sec=0.01, offset_sec=1.8, velocity=78, confidence=0.80),
        DetectedNote(pitch_midi=59, onset_sec=0.01, offset_sec=0.9, velocity=62, confidence=0.50),
        DetectedNote(pitch_midi=41, onset_sec=1.00, offset_sec=1.05, velocity=35, confidence=0.25),
        # RH cluster: melody G5 + chord tones E5, C5 + weak inner D5
        DetectedNote(pitch_midi=79, onset_sec=0.0, offset_sec=1.0, velocity=90, confidence=0.92),
        DetectedNote(pitch_midi=76, onset_sec=0.01, offset_sec=1.0, velocity=76, confidence=0.82),
        DetectedNote(pitch_midi=72, onset_sec=0.01, offset_sec=0.4, velocity=64, confidence=0.60),
        DetectedNote(pitch_midi=74, onset_sec=0.02, offset_sec=0.12, velocity=40, confidence=0.30),
    ]
    snapshot = [(n.pitch_midi, n.onset_sec, n.offset_sec) for n in raw]

    res_simple = simplify_arrangement(raw, tempo_bpm=120.0, arrangement_detail="simple")
    res_balanced = simplify_arrangement(raw, tempo_bpm=120.0, arrangement_detail="balanced")
    res_detailed = simplify_arrangement(raw, tempo_bpm=120.0, arrangement_detail="detailed")

    # Original raw list is never mutated
    assert [(n.pitch_midi, n.onset_sec, n.offset_sec) for n in raw] == snapshot
    assert len(res_detailed.notes) == len(raw)
    assert len(res_simple.notes) < len(res_balanced.notes) <= len(res_detailed.notes)

    # Melody lead G5 and bass fundamental C3 preserved in all presets
    for res in (res_simple, res_balanced, res_detailed):
        pitches = {n.pitch_midi for n in res.notes}
        assert 48 in pitches
        assert 79 in pitches


def test_phrase_breathing_fills_fragment_gaps_but_preserves_rests_and_reattacks() -> None:
    # 120 BPM => 1 beat = 0.5s
    notes = [
        # C5 -> D5 separated by 0.12s (0.24 beat) fragment gap -> fill in simple & balanced
        DetectedNote(pitch_midi=72, onset_sec=0.00, offset_sec=0.38, velocity=82, confidence=0.85),
        DetectedNote(pitch_midi=74, onset_sec=0.50, offset_sec=0.90, velocity=82, confidence=0.85),
        # Repeated D5 reattack with 0.10s gap -> MUST preserve gap
        DetectedNote(pitch_midi=74, onset_sec=1.00, offset_sec=1.40, velocity=85, confidence=0.88),
        # Long E5 (1.5 beats = 0.75s) followed by 0.40s (0.80 beats) intentional rest -> MUST preserve rest
        DetectedNote(pitch_midi=76, onset_sec=1.50, offset_sec=2.25, velocity=84, confidence=0.86),
        DetectedNote(pitch_midi=79, onset_sec=2.65, offset_sec=3.15, velocity=84, confidence=0.86),
    ]
    res_simple = simplify_arrangement(notes, tempo_bpm=120.0, arrangement_detail="simple")
    by_onset = sorted(res_simple.notes, key=lambda n: n.onset_sec)

    # Fragment gap filled without overlapping next note
    assert by_onset[0].offset_sec > 0.38
    assert by_onset[0].offset_sec < by_onset[1].onset_sec

    # Repeated-note reattack gap preserved
    assert abs(by_onset[1].offset_sec - 0.90) < 0.01

    # Intentional rest after E5 preserved
    assert abs(by_onset[3].offset_sec - 2.25) < 0.01


def test_triplet_quantization_preserves_triplet_subdivisions_in_musicxml() -> None:
    # 120 BPM (0.5s/beat): 3 eighth-note triplets in beat 1 (0.0, 0.1667, 0.3333)
    notes = [
        DetectedNote(pitch_midi=60, onset_sec=0.000, offset_sec=0.165, velocity=80),
        DetectedNote(pitch_midi=62, onset_sec=0.167, offset_sec=0.332, velocity=80),
        DetectedNote(pitch_midi=64, onset_sec=0.334, offset_sec=0.500, velocity=80),
    ]
    score = build_score_data(
        title="Triplet Test",
        detected_notes=notes,
        tempo_bpm=120.0,
        tempo_estimated=False,
        time_signature="4/4",
        time_signature_estimated=False,
        key_signature="C major",
        key_signature_estimated=False,
        duration_seconds=1.0,
        instrument="piano",
        quantization="eighth_triplet",
        analysis={"quantization": "eighth_triplet"},
    )
    xml_str = score_data_to_musicxml(score)
    parsed = music21.converter.parseData(xml_str, format="musicxml")
    q_lengths = [round(float(n.quarterLength), 3) for n in parsed.recurse().notes]
    assert any(abs(ql - 0.333) < 0.02 for ql in q_lengths)


def test_halftime_tempo_accepted_with_evidence_and_rejected_for_fast_notes() -> None:
    # Case 1: 150 BPM raw beats, but downbeats every 4 beats at 75 BPM and long note durations (0.75s) -> half_time
    beats_150 = [i * 0.4 for i in range(24)]
    downbeats_75 = [i * 3.2 for i in range(3)]  # 4 beats at 75 BPM = 3.2s per bar
    long_durs = [0.75] * 12
    accepted = resolve_tempo_from_beats(
        beat_times=beats_150,
        downbeat_times=downbeats_75,
        beats_per_measure=4,
        note_durations_sec=long_durs,
    )
    assert accepted["selected_bpm"] < 100.0
    assert "Half-time" in accepted["resolution_reason"]

    # Case 2: 140 BPM raw beats with matching 140 BPM downbeats (1.714s per bar) and short 0.18s notes -> primary kept
    beats_140 = [i * (60.0 / 140.0) for i in range(24)]
    downbeats_140 = [i * (4.0 * 60.0 / 140.0) for i in range(6)]
    short_durs = [0.18] * 12
    rejected = resolve_tempo_from_beats(
        beat_times=beats_140,
        downbeat_times=downbeats_140,
        beats_per_measure=4,
        note_durations_sec=short_durs,
    )
    assert rejected["selected_bpm"] > 120.0


def test_regenerate_arrangement_endpoint_updates_score_without_ml_inference(client, db_session) -> None:
    headers = _auth_headers(client, "regen_arr@example.com")
    proj_res = client.post(
        "/api/v1/projects",
        headers=headers,
        json={"title": "Regenerate Arrangement", "instrument": "piano"},
    )
    assert proj_res.status_code == 201
    project_id = proj_res.json()["id"]

    raw_detected = [
        {"pitch_midi": 48, "onset_sec": 0.0, "offset_sec": 2.0, "velocity": 90, "confidence": 0.90},
        {"pitch_midi": 55, "onset_sec": 0.01, "offset_sec": 1.8, "velocity": 75, "confidence": 0.80},
        {"pitch_midi": 64, "onset_sec": 0.01, "offset_sec": 1.5, "velocity": 72, "confidence": 0.78},
        {"pitch_midi": 67, "onset_sec": 0.02, "offset_sec": 1.5, "velocity": 70, "confidence": 0.75},
        {"pitch_midi": 72, "onset_sec": 0.02, "offset_sec": 1.5, "velocity": 88, "confidence": 0.92},
        {"pitch_midi": 74, "onset_sec": 0.02, "offset_sec": 0.12, "velocity": 38, "confidence": 0.29},
    ]
    initial_score = ScoreData(
        title="Regenerate Arrangement",
        tempo_bpm=120.0,
        time_signature="4/4",
        key_signature="C major",
        duration_seconds=2.0,
        tracks=[ScoreTrack(index=0, name="Piano", instrument="piano", clef="grand")],
        notes=[
            ScoreNote(id=f"n{i}", pitch_midi=n["pitch_midi"], onset_sec=n["onset_sec"], offset_sec=n["offset_sec"])
            for i, n in enumerate(raw_detected)
        ],
        chords=[],
        analysis={"arrangement_detail": "detailed", "quantization": "sixteenth", "raw_detected_notes": raw_detected},
    )
    db_session.add(ProjectScore(project_id=project_id, score_json=initial_score.model_dump(), version=1))
    db_session.commit()

    # Regenerate to simple/eighth without any ML transcription job
    r_simple = client.post(
        f"/api/v1/projects/{project_id}/score/regenerate",
        headers=headers,
        json={"arrangement_detail": "simple", "quantization": "eighth"},
    )
    assert r_simple.status_code == 200, r_simple.text
    simple_body = r_simple.json()
    assert simple_body["version"] == 2
    assert simple_body["score_json"]["analysis"]["arrangement_detail"] == "simple"
    assert len(simple_body["score_json"]["analysis"]["raw_detected_notes"]) == len(raw_detected)
    ET.fromstring(simple_body["musicxml"])

    # Regenerate back to detailed -> restores full polyphony from stored raw_detected_notes
    r_det = client.post(
        f"/api/v1/projects/{project_id}/score/regenerate",
        headers=headers,
        json={"arrangement_detail": "detailed", "quantization": "sixteenth"},
    )
    assert r_det.status_code == 200
    det_body = r_det.json()
    assert det_body["version"] == 3
    assert len(det_body["score_json"]["notes"]) >= len(simple_body["score_json"]["notes"])
