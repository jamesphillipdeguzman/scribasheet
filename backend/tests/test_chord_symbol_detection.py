"""Phase E.1 regression tests for confidence-aware chord-symbol detection and MusicXML placement."""

from __future__ import annotations

import io
import xml.etree.ElementTree as ET

import music21
import pretty_midi

from app.notation.analyzer import ChordDetectionConfig, detect_chords
from app.notation.generator import (
    _find_musescore_binary,
    _render_pdf_via_musescore,
    build_score_data,
    count_pdf_pages,
    score_data_to_midi_bytes,
    score_data_to_musicxml,
)
from app.schemas.score import ScoreNote
from app.transcription.base import DetectedNote


def _note(pitch: int, onset_beat: float, dur_beats: float = 1.0, bpm: float = 120.0, vel: int = 80) -> ScoreNote:
    spb = 60.0 / bpm
    return ScoreNote(
        id=f"n_{pitch}_{onset_beat}",
        pitch_midi=pitch,
        onset_sec=onset_beat * spb,
        offset_sec=(onset_beat + dur_beats) * spb,
        velocity=vel,
        confidence=0.9,
    )


def _chord_notes(pitches: list[int], onset_beat: float, dur_beats: float = 2.0, bpm: float = 120.0) -> list[ScoreNote]:
    return [_note(p, onset_beat, dur_beats, bpm) for p in pitches]


def test_triads_sevenths_diminished_and_inversions():
    # C -> Am -> G7 -> Bdim -> G/B
    notes = [
        *_chord_notes([48, 60, 64, 67], 0.0, 2.0),       # C
        *_chord_notes([45, 57, 60, 64], 2.0, 2.0),       # Am
        *_chord_notes([43, 55, 59, 62, 65], 4.0, 2.0),   # G7
        *_chord_notes([47, 59, 62, 65], 6.0, 2.0),       # Bdim
        *_chord_notes([47, 55, 59, 62], 8.0, 2.0),       # G/B
    ]
    chords = detect_chords(notes, 120.0, "4/4", key_signature="C major")
    symbols = [(c.measure, c.beat, c.symbol) for c in chords]
    assert (1, 1.0, "C") in symbols
    assert (1, 3.0, "Am") in symbols
    assert (2, 1.0, "G7") in symbols
    assert any(sym in ("Bdim", "B°") for _, _, sym in symbols)
    assert (3, 1.0, "G/B") in symbols


def test_arpeggio_and_passing_notes_do_not_create_false_chord_changes():
    # Sustained C major LH + RH arpeggio with passing F4/D5 eighth notes
    notes = [
        _note(48, 0.0, 4.0, vel=85),   # C3 sustained whole measure
        _note(55, 0.0, 4.0, vel=82),   # G3 sustained whole measure
        _note(64, 0.0, 1.0, vel=80),   # E4
        _note(65, 1.0, 0.5, vel=65),   # F4 passing note
        _note(67, 1.5, 1.5, vel=82),   # G4
        _note(62, 3.0, 0.5, vel=62),   # D4 passing note
        _note(64, 3.5, 0.5, vel=78),   # E4
    ]
    chords = detect_chords(notes, 60.0, "4/4", key_signature="C major")
    assert len(chords) == 1
    assert chords[0].symbol == "C"


def test_repeated_harmony_across_barline_is_deduplicated_and_within_measure_changes_retained():
    # Measure 1: C (beats 1-4), Measure 2: C (beats 1-2) then F (beats 3-4)
    notes = [
        *_chord_notes([48, 60, 64, 67], 0.0, 4.0),
        *_chord_notes([48, 60, 64, 67], 4.0, 2.0),
        *_chord_notes([41, 53, 57, 60], 6.0, 2.0),
    ]
    chords = detect_chords(notes, 120.0, "4/4", key_signature="C major")
    assert [(c.measure, c.beat, c.symbol) for c in chords] == [
        (1, 1.0, "C"),
        (2, 3.0, "F"),
    ]


def test_ambiguous_dyads_and_cluster_omit_misleading_labels():
    # Isolated 2-note dyad or dense semitone cluster should not invent complex labels
    dyads = [_note(60, 0.0, 2.0), _note(61, 0.0, 2.0)]
    assert detect_chords(dyads, 120.0, "4/4", config=ChordDetectionConfig()) == []


def test_musicxml_harmony_placement_above_staff_and_musescore_rendering_and_parity():
    # 4-chord progression (C -> Am -> F -> G7) + inversions
    detected = [
        DetectedNote(pitch_midi=p, onset_sec=on, offset_sec=on + 1.0, velocity=80)
        for on, pitches in [
            (0.0, [48, 60, 64, 67]),   # C
            (1.0, [45, 57, 60, 64]),   # Am
            (2.0, [41, 53, 57, 60]),   # F
            (3.0, [43, 55, 59, 62, 65]),  # G7
            (4.0, [47, 55, 59, 62]),   # G/B
        ]
        for p in pitches
    ]
    score = build_score_data(
        title="Phase E1 Chord Engraving",
        detected_notes=detected,
        tempo_bpm=120.0,
        tempo_estimated=False,
        time_signature="4/4",
        time_signature_estimated=False,
        key_signature="C major",
        key_signature_estimated=False,
        duration_seconds=5.0,
        instrument="piano",
    )
    xml_str = score_data_to_musicxml(score)
    root = ET.fromstring(xml_str)
    harmonies = root.findall(".//harmony")
    assert len(harmonies) == 5
    for h in harmonies:
        assert h.get("placement") == "above"

    # MIDI / MusicXML sounding-pitch parity
    midi_bytes = score_data_to_midi_bytes(score)
    pm = pretty_midi.PrettyMIDI(io.BytesIO(midi_bytes))
    midi_pitches = sorted(n.pitch for inst in pm.instruments for n in inst.notes)
    parsed = music21.converter.parseData(xml_str, format="musicxml")
    xml_pitches = []
    for part in parsed.parts:
        for el in part.recurse().notes:
            if el.tie and el.tie.type in ("continue", "stop"):
                continue
            if isinstance(el, music21.note.Note):
                xml_pitches.append(el.pitch.midi)
            elif isinstance(el, music21.chord.Chord) and not isinstance(el, music21.harmony.ChordSymbol):
                xml_pitches.extend(p.midi for p in el.pitches)
    assert midi_pitches == sorted(xml_pitches)

    if _find_musescore_binary():
        pdf_bytes = _render_pdf_via_musescore(score)
        assert pdf_bytes is not None and pdf_bytes.startswith(b"%PDF-")
        assert count_pdf_pages(pdf_bytes) >= 1
