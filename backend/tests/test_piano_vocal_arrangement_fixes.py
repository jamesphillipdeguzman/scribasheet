"""Regression tests for Vocal/Piano arrangement, grand staff layout, bass register, and key spelling."""

from __future__ import annotations

import xml.etree.ElementTree as ET

import music21

from app.notation.accompaniment import generate_piano_accompaniment
from app.notation.generator import (
    _split_rh_lh_notes,
    build_piano_vocal_score_data,
    score_data_to_musicxml,
)
from app.notation.melody import DEFAULT_VOCAL_RANGE, extract_lead_melody
from app.schemas.score import ScoreChord, ScoreNote
from app.transcription.base import DetectedNote


def test_vocal_melody_removes_sub_bass_and_extreme_outliers_while_preserving_supported_high_notes():
    notes = [
        # Sub-bass artifacts: F1 (29) and F#2 (42)
        DetectedNote(pitch_midi=29, onset_sec=0.0, offset_sec=0.45, velocity=78, confidence=0.8),
        DetectedNote(pitch_midi=42, onset_sec=0.5, offset_sec=0.95, velocity=82, confidence=0.82),
        # Main vocal phrase in G3-G5
        DetectedNote(pitch_midi=64, onset_sec=1.0, offset_sec=1.45, velocity=94, confidence=0.92),  # E4
        DetectedNote(pitch_midi=68, onset_sec=1.5, offset_sec=1.95, velocity=95, confidence=0.93),  # G#4
        DetectedNote(pitch_midi=71, onset_sec=2.0, offset_sec=2.45, velocity=96, confidence=0.94),  # B4
        # Extreme isolated harmonic/outlier spikes: E6 (88) and G#6 (92)
        DetectedNote(pitch_midi=88, onset_sec=2.02, offset_sec=2.30, velocity=48, confidence=0.42),
        DetectedNote(pitch_midi=92, onset_sec=2.6, offset_sec=2.70, velocity=50, confidence=0.40),
        # Legitimate supported high vocal climax: G5 -> A5 -> C6 (79 -> 81 -> 84)
        DetectedNote(pitch_midi=79, onset_sec=3.0, offset_sec=3.45, velocity=95, confidence=0.94),
        DetectedNote(pitch_midi=81, onset_sec=3.5, offset_sec=3.95, velocity=96, confidence=0.95),
        DetectedNote(pitch_midi=84, onset_sec=4.0, offset_sec=4.80, velocity=98, confidence=0.95),
    ]

    result = extract_lead_melody(notes, tempo_bpm=120.0, vocal_range=DEFAULT_VOCAL_RANGE)
    pitches = [n.pitch_midi for n in result.notes]

    # Sub-bass artifacts and isolated E6/G#6 spikes are removed
    assert 29 not in pitches
    assert 42 not in pitches
    assert 88 not in pitches
    assert 92 not in pitches
    # Legitimate supported high notes (A5=81, C6=84) are preserved, not clamped to G5 (79)
    assert pitches == [64, 68, 71, 79, 81, 84]


def test_piano_vocal_three_staff_musicxml_layout_and_clefs():
    melody = [
        DetectedNote(pitch_midi=64, onset_sec=0.0, offset_sec=0.9, velocity=95, confidence=0.95),
        DetectedNote(pitch_midi=68, onset_sec=1.0, offset_sec=1.9, velocity=95, confidence=0.95),
        DetectedNote(pitch_midi=71, onset_sec=2.0, offset_sec=3.9, velocity=96, confidence=0.95),
    ]
    full_harmony = [
        *melody,
        DetectedNote(pitch_midi=40, onset_sec=0.0, offset_sec=1.9, velocity=85, confidence=0.9),
        DetectedNote(pitch_midi=52, onset_sec=0.0, offset_sec=1.9, velocity=78, confidence=0.88),
        DetectedNote(pitch_midi=56, onset_sec=0.0, offset_sec=1.9, velocity=78, confidence=0.88),
        DetectedNote(pitch_midi=59, onset_sec=0.0, offset_sec=1.9, velocity=78, confidence=0.88),
        DetectedNote(pitch_midi=47, onset_sec=2.0, offset_sec=3.9, velocity=85, confidence=0.9),
        DetectedNote(pitch_midi=51, onset_sec=2.0, offset_sec=3.9, velocity=78, confidence=0.88),
        DetectedNote(pitch_midi=54, onset_sec=2.0, offset_sec=3.9, velocity=78, confidence=0.88),
    ]

    score = build_piano_vocal_score_data(
        title="Three Staff E Major",
        melody_notes=melody,
        chord_source_notes=full_harmony,
        tempo_bpm=120.0,
        tempo_estimated=False,
        time_signature="4/4",
        time_signature_estimated=False,
        key_signature="E major",
        key_signature_estimated=False,
        duration_seconds=4.0,
        arrangement_detail="balanced",
    )

    assert len(score.tracks) == 2
    assert score.tracks[0].name == "Vocal Melody"
    assert score.tracks[0].clef == "treble"
    assert score.tracks[1].name == "Piano Accompaniment"
    assert score.tracks[1].clef == "grand"

    xml_str = score_data_to_musicxml(score, include_chords=True)
    root = ET.fromstring(xml_str)
    parts = root.findall("part")
    assert len(parts) == 3

    part_names = [el.text for el in root.findall("./part-list/score-part/part-name")]
    assert part_names == [
        "Vocal Melody",
        "Piano Accompaniment (RH)",
        "Piano Accompaniment (LH)",
    ]

    # Verify clefs in measure 1: Treble, Treble, Bass
    clefs = [
        (p.find("./measure[@number='1']/attributes/clef/sign").text, p.find("./measure[@number='1']/attributes/clef/line").text)
        for p in parts
    ]
    assert clefs == [("G", "2"), ("G", "2"), ("F", "4")]

    # Verify piano brace group exists
    group_symbols = [el.text for el in root.findall("./part-list/part-group/group-symbol")]
    assert "brace" in group_symbols

    # Verify music21 can re-parse the exported MusicXML cleanly
    reparsed = music21.converter.parseData(xml_str, format="musicxml")
    assert len(reparsed.parts) == 3


def test_rh_lh_split_respects_voicing_and_avoids_unnatural_c4_splits():
    # E2 bass (40) + compact upper triad E3-G#3-B3 (52, 56, 59):
    # Should place E2 in LH and keep E3-G#3-B3 together in RH rather than forcing a 19-semitone LH stretch
    notes = [
        ScoreNote(id="n1", pitch_midi=40, onset_sec=0.0, offset_sec=1.0, velocity=75, track_index=1),
        ScoreNote(id="n2", pitch_midi=52, onset_sec=0.0, offset_sec=1.0, velocity=65, track_index=1),
        ScoreNote(id="n3", pitch_midi=56, onset_sec=0.0, offset_sec=1.0, velocity=65, track_index=1),
        ScoreNote(id="n4", pitch_midi=59, onset_sec=0.0, offset_sec=1.0, velocity=65, track_index=1),
    ]
    rh, lh = _split_rh_lh_notes(notes)
    assert [n.pitch_midi for n in lh] == [40]
    assert [n.pitch_midi for n in rh] == [52, 56, 59]


def test_accompaniment_continuity_across_long_multi_measure_spans_and_e2_g3_bass_register():
    # Simulate a 40-measure song (80s at 120 BPM) with a long sustained chord spanning mm. 27-38 (24s+)
    chords = [
        ScoreChord(id="c1", measure=1, beat=1.0, onset_sec=0.0, symbol="E", root="E", quality="major", confidence=0.9),
        ScoreChord(id="c2", measure=13, beat=1.0, onset_sec=24.0, symbol="B", root="B", quality="major", confidence=0.9),
        ScoreChord(id="c3", measure=27, beat=1.0, onset_sec=52.0, symbol="C#m", root="C#", quality="minor", confidence=0.9),
    ]
    melody = [
        DetectedNote(pitch_midi=64, onset_sec=float(t), offset_sec=float(t) + 0.8, velocity=90, confidence=0.9)
        for t in range(0, 78, 2)
    ]

    accomp = generate_piano_accompaniment(
        chords=chords,
        melody_notes=melody,
        tempo_bpm=120.0,
        key_signature="E major",
        duration_seconds=80.0,
        arrangement_detail="balanced",
    )

    # Check mm. 27-38 (52.0s .. 76.0s): bass & accompaniment must NOT drop out after 2 bars (4s)
    mm27_38_notes = [n for n in accomp.notes if 52.0 <= n.onset_sec < 76.0]
    assert len(mm27_38_notes) >= 12
    # Verify bass notes exist in the second half of mm. 27-38 (60.0s .. 76.0s)
    assert any(n.pitch_midi <= 55 and 60.0 <= n.onset_sec < 76.0 for n in mm27_38_notes)

    # Default bass roots stay in E2-G3 (40-55) without muddy C2 (36) chord clusters
    bass_only = [n.pitch_midi for n in accomp.notes if n.pitch_midi < 48]
    assert all(p >= 40 for p in bass_only)


def test_key_signature_enharmonic_spelling_in_e_major_and_minor_keys():
    # In E major, MIDI 63 (D#4), 66 (F#4), 68 (G#4), 61 (C#4) must NOT be spelled as Eb, Gb, Ab, Db
    melody = [
        DetectedNote(pitch_midi=64, onset_sec=0.0, offset_sec=0.45, velocity=92, confidence=0.95),  # E4
        DetectedNote(pitch_midi=63, onset_sec=0.5, offset_sec=0.95, velocity=92, confidence=0.95),  # D#4 (was Eb4!)
        DetectedNote(pitch_midi=66, onset_sec=1.0, offset_sec=1.45, velocity=92, confidence=0.95),  # F#4
        DetectedNote(pitch_midi=68, onset_sec=1.5, offset_sec=1.95, velocity=92, confidence=0.95),  # G#4
        DetectedNote(pitch_midi=61, onset_sec=2.0, offset_sec=2.45, velocity=92, confidence=0.95),  # C#4
    ]
    score = build_piano_vocal_score_data(
        title="E Major Spelling",
        melody_notes=melody,
        chord_source_notes=melody,
        tempo_bpm=120.0,
        key_signature="E major",
        key_signature_estimated=False,
        duration_seconds=3.0,
    )
    xml_str = score_data_to_musicxml(score, include_chords=False)
    reparsed = music21.converter.parseData(xml_str, format="musicxml")
    vocal_pitches = [n.pitch.name for n in reparsed.parts[0].recurse().notes]
    assert vocal_pitches == ["E", "D#", "F#", "G#", "C#"]
    assert "E-" not in vocal_pitches
    assert "G-" not in vocal_pitches
