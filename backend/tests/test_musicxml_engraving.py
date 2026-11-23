"""Regression tests for MusicXML engraving quality: rhythm, voices, accidentals, and metadata."""

from __future__ import annotations

import xml.etree.ElementTree as ET
from collections import Counter

import music21

from app.notation.generator import (
    _normalize_duration_ql,
    _pack_notes_into_voices,
    _select_rhythmic_grid_ql,
    build_score_data,
    clean_score_title,
    render_score_pdf,
    score_data_to_musicxml,
)
from app.schemas.score import ScoreNote
from app.transcription.base import DetectedNote


def test_clean_score_title_preserves_project_title_and_cleans_filename() -> None:
    assert clean_score_title("My Piano Ballad") == "My Piano Ballad"
    assert (
        clean_score_title("soft-easy-piano-calming-melody_75bpm_F_major")
        == "Soft Easy Piano Calming Melody"
    )
    assert clean_score_title("nocturne_120bpm_C_minor.wav") == "Nocturne"


def test_rhythmic_grid_selection_and_duration_normalization() -> None:
    # Slow 75 BPM piece with eighth/quarter notes -> selects 0.5 ql (eighth) grid
    calm_notes = [
        ScoreNote(id="1", pitch_midi=65, onset_sec=0.0, offset_sec=0.40, velocity=70),
        ScoreNote(id="2", pitch_midi=69, onset_sec=0.40, offset_sec=0.80, velocity=72),
        ScoreNote(id="3", pitch_midi=72, onset_sec=0.80, offset_sec=1.60, velocity=75),
        ScoreNote(id="4", pitch_midi=70, onset_sec=1.60, offset_sec=2.40, velocity=70),
    ]
    assert _select_rhythmic_grid_ql(calm_notes, 75.0) == 0.5
    # No double-dotted durations (e.g. 1.75 or 3.5) produced
    assert _normalize_duration_ql(1.75, 0.25) in (1.5, 2.0)
    assert _normalize_duration_ql(3.5, 0.25) in (3.0, 4.0)


def test_voice_allocation_max_two_voices_and_chord_grouping() -> None:
    # Simultaneous chord tones with minor release differences + sustained bass note
    notes = [
        ScoreNote(id="b1", pitch_midi=41, onset_sec=0.0, offset_sec=1.6, velocity=70),
        ScoreNote(id="b2", pitch_midi=48, onset_sec=0.0, offset_sec=1.4, velocity=68),
        ScoreNote(id="m1", pitch_midi=53, onset_sec=0.8, offset_sec=1.6, velocity=72),
    ]
    voices = _pack_notes_into_voices(notes, beats_per_sec=75.0 / 60.0, grid_ql=0.5, measure_ql=4.0)
    assert len(voices) <= 2
    # All 3 pitches preserved
    assert sum(len(ev[2]) for v in voices for ev in v) == 3


def test_accidentals_f_major_no_redundant_naturals_and_preserves_cancellation() -> None:
    # Measure 1: diatonic F4, G4, A4, Bb4, C5, D5, E5 -> zero <accidental> tags!
    # Measure 2: Bb4 -> B4 natural (must display natural) -> Bb4 (must display flat)
    detected = [
        DetectedNote(pitch_midi=65, onset_sec=0.0, offset_sec=0.4, velocity=75),
        DetectedNote(pitch_midi=67, onset_sec=0.4, offset_sec=0.8, velocity=75),
        DetectedNote(pitch_midi=69, onset_sec=0.8, offset_sec=1.2, velocity=75),
        DetectedNote(pitch_midi=70, onset_sec=1.2, offset_sec=1.6, velocity=75),
        DetectedNote(pitch_midi=72, onset_sec=1.6, offset_sec=2.0, velocity=75),
        DetectedNote(pitch_midi=74, onset_sec=2.0, offset_sec=2.4, velocity=75),
        DetectedNote(pitch_midi=76, onset_sec=2.4, offset_sec=3.2, velocity=75),
        # Measure 2 (starts at 3.2s at 75 BPM)
        DetectedNote(pitch_midi=70, onset_sec=3.2, offset_sec=4.0, velocity=75),
        DetectedNote(pitch_midi=71, onset_sec=4.0, offset_sec=4.8, velocity=75),
        DetectedNote(pitch_midi=70, onset_sec=4.8, offset_sec=6.4, velocity=75),
    ]
    score = build_score_data(
        title="soft-easy-piano-calming-melody_75bpm_F_major",
        detected_notes=detected,
        tempo_bpm=75.0,
        tempo_estimated=True,
        time_signature="4/4",
        time_signature_estimated=True,
        key_signature="F major",
        key_signature_estimated=True,
        duration_seconds=6.4,
        instrument="piano",
    )
    xml_str = score_data_to_musicxml(score)
    music21.converter.parseData(xml_str, format="musicxml")
    root = ET.fromstring(xml_str)
    assert root.findtext(".//work-title") == "Soft Easy Piano Calming Melody"

    m1_accs = root.findall(".//measure[@number='1']//accidental")
    assert m1_accs == []

    m2_accs = Counter(el.text for el in root.findall(".//measure[@number='2']//accidental"))
    assert m2_accs["natural"] == 1
    assert m2_accs["flat"] == 1

    pdf_bytes = render_score_pdf(score)
    assert pdf_bytes.startswith(b"%PDF-")


def test_music21_chord_symbols_and_beaming_preserve_midi_parity() -> None:
    import io

    import pretty_midi

    from app.notation.analyzer import detect_chords
    from app.notation.generator import score_data_to_midi_bytes

    # F major chord (m1) + C7 chord (m2) + 8th-note passage for beaming
    detected = [
        DetectedNote(pitch_midi=53, onset_sec=0.0, offset_sec=1.0, velocity=80),
        DetectedNote(pitch_midi=57, onset_sec=0.0, offset_sec=1.0, velocity=80),
        DetectedNote(pitch_midi=60, onset_sec=0.0, offset_sec=1.0, velocity=80),
        DetectedNote(pitch_midi=65, onset_sec=1.0, offset_sec=1.25, velocity=82),
        DetectedNote(pitch_midi=69, onset_sec=1.25, offset_sec=1.5, velocity=82),
        DetectedNote(pitch_midi=72, onset_sec=1.5, offset_sec=1.75, velocity=82),
        DetectedNote(pitch_midi=70, onset_sec=1.75, offset_sec=2.0, velocity=82),
        DetectedNote(pitch_midi=48, onset_sec=2.0, offset_sec=3.0, velocity=78),
        DetectedNote(pitch_midi=52, onset_sec=2.0, offset_sec=3.0, velocity=78),
        DetectedNote(pitch_midi=55, onset_sec=2.0, offset_sec=3.0, velocity=78),
        DetectedNote(pitch_midi=58, onset_sec=2.0, offset_sec=3.0, velocity=78),
    ]
    score = build_score_data(
        title="Harmony & Beaming Test",
        detected_notes=detected,
        tempo_bpm=120.0,
        tempo_estimated=False,
        time_signature="4/4",
        time_signature_estimated=False,
        key_signature="F major",
        key_signature_estimated=False,
        duration_seconds=3.0,
        instrument="piano",
    )
    chords = detect_chords(score.notes, 120.0, "4/4", key_signature="F major")
    symbols = [c.symbol for c in chords]
    assert "F" in symbols
    assert "C7" in symbols

    xml_str = score_data_to_musicxml(score)
    root = ET.fromstring(xml_str)
    assert len(root.findall(".//beam")) >= 2

    # Verify strict MIDI/MusicXML sounding pitch parity
    midi_bytes = score_data_to_midi_bytes(score)
    pm = pretty_midi.PrettyMIDI(io.BytesIO(midi_bytes))
    midi_pitches = sorted({n.pitch for inst in pm.instruments for n in inst.notes})
    parsed = music21.converter.parseData(xml_str, format="musicxml")
    xml_pitches = sorted(
        {
            p.midi
            for n in parsed.recurse().notes
            if not isinstance(n, music21.harmony.ChordSymbol)
            for p in (n.pitches if hasattr(n, "pitches") else [n.pitch])
        }
    )
    assert midi_pitches == xml_pitches


def test_musicxml_engraving_rounds_decimal_tempo_markings() -> None:
    detected = [
        DetectedNote(pitch_midi=60, onset_sec=0.0, offset_sec=0.7, velocity=85),
        DetectedNote(pitch_midi=64, onset_sec=0.7, offset_sec=1.4, velocity=85),
    ]
    for raw_bpm, expected_str in ((85.7, "86"), (85.4, "85"), (120.0, "120")):
        score = build_score_data(
            title="Closer Piano Cover",
            detected_notes=detected,
            tempo_bpm=raw_bpm,
            tempo_estimated=True,
            time_signature="4/4",
            time_signature_estimated=False,
            key_signature="C major",
            key_signature_estimated=False,
            duration_seconds=2.0,
            instrument="piano",
        )
        assert score.tempo_bpm == raw_bpm
        xml_str = score_data_to_musicxml(score)
        root = ET.fromstring(xml_str)
        per_mins = [el.text for el in root.findall(".//per-minute")]
        sounds = [el.get("tempo") for el in root.findall(".//sound") if el.get("tempo")]
        assert expected_str in per_mins
        assert expected_str in sounds
        assert str(raw_bpm) not in per_mins
        assert str(raw_bpm) not in sounds
