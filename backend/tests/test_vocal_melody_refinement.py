import io

import pretty_midi

from app.notation.generator import (
    build_piano_vocal_score_data,
    build_score_data,
    score_data_to_midi_bytes,
    score_data_to_musicxml,
)
from app.notation.melody import DEFAULT_VOCAL_RANGE, extract_lead_melody
from app.transcription.base import DetectedNote


def test_suppresses_intro_percussion_transients_while_preserving_quiet_and_pickup_entrances() -> None:
    # Measure 1 (~0.0-1.2s): rapid chromatic percussion-like blips before a 1.0s gap
    # Measure 2 (~2.2s+): pickup note into a quiet sustained vocal phrase
    notes = [
        DetectedNote(pitch_midi=61, onset_sec=0.05, offset_sec=0.12, velocity=48, confidence=0.45),
        DetectedNote(pitch_midi=66, onset_sec=0.18, offset_sec=0.25, velocity=44, confidence=0.42),
        DetectedNote(pitch_midi=60, onset_sec=0.31, offset_sec=0.38, velocity=50, confidence=0.48),
        # Legitimate short pickup note connecting into the opening phrase
        DetectedNote(pitch_midi=64, onset_sec=1.95, offset_sec=2.12, velocity=58, confidence=0.68),
        # Quiet but sustained vocal entrance
        DetectedNote(pitch_midi=67, onset_sec=2.15, offset_sec=2.85, velocity=46, confidence=0.72),
        DetectedNote(pitch_midi=69, onset_sec=2.90, offset_sec=3.50, velocity=64, confidence=0.84),
    ]

    res = extract_lead_melody(notes, tempo_bpm=100.0, vocal_range=DEFAULT_VOCAL_RANGE)
    pitches = [n.pitch_midi for n in res.notes]
    assert res.stats["intro_transients_suppressed"] == 3
    assert pitches == [64, 67, 69]


def test_rejects_isolated_octave_down_accompaniment_bleed_but_keeps_legit_octave_jumps() -> None:
    # Vocal phrase around E4-G4 (64-67) with one isolated -12 accompaniment bleed note at G3 (55, inside G3..G5),
    # followed later by a legitimate sustained octave jump up to E5 (76)
    vocal_candidates = [
        DetectedNote(pitch_midi=64, onset_sec=0.00, offset_sec=0.45, velocity=82, confidence=0.88),
        DetectedNote(pitch_midi=67, onset_sec=0.50, offset_sec=0.95, velocity=84, confidence=0.90),
        # Isolated octave-down bleed matching simultaneous accompaniment
        DetectedNote(pitch_midi=55, onset_sec=1.00, offset_sec=1.20, velocity=60, confidence=0.60),
        DetectedNote(pitch_midi=67, onset_sec=1.30, offset_sec=1.80, velocity=85, confidence=0.91),
        DetectedNote(pitch_midi=64, onset_sec=1.85, offset_sec=2.30, velocity=80, confidence=0.87),
        # Legitimate sustained octave leap (2 consecutive notes in new register)
        DetectedNote(pitch_midi=76, onset_sec=2.40, offset_sec=2.95, velocity=88, confidence=0.92),
        DetectedNote(pitch_midi=74, onset_sec=3.00, offset_sec=3.50, velocity=84, confidence=0.89),
    ]
    accomp_notes = [
        DetectedNote(pitch_midi=55, onset_sec=1.00, offset_sec=1.45, velocity=78, confidence=0.85),
    ]

    res = extract_lead_melody(
        vocal_candidates,
        tempo_bpm=100.0,
        vocal_range=DEFAULT_VOCAL_RANGE,
        accompaniment_notes=accomp_notes,
    )
    pitches = [n.pitch_midi for n in res.notes]
    assert 55 not in pitches
    assert 76 in pitches and 74 in pitches
    assert res.stats["octave_bleed_rejected"] >= 1


def test_preserves_repeated_notes_and_bridges_micro_rests_in_notation_only() -> None:
    # Notes 1 -> 2: different pitch with tiny 60ms detection gap -> notation bridges micro-rest
    # Notes 2 -> 3: same pitch (repeated note reattack) with 80ms gap -> must NOT merge
    # Notes 3 -> 4: different pitch with 500ms genuine rest -> must NOT bridge
    detected = [
        DetectedNote(pitch_midi=64, onset_sec=0.00, offset_sec=0.44, velocity=82, confidence=0.90),
        DetectedNote(pitch_midi=67, onset_sec=0.50, offset_sec=0.95, velocity=84, confidence=0.92),
        DetectedNote(pitch_midi=67, onset_sec=1.03, offset_sec=1.45, velocity=88, confidence=0.91),
        DetectedNote(pitch_midi=69, onset_sec=2.00, offset_sec=2.50, velocity=85, confidence=0.93),
    ]

    score = build_score_data(
        title="Vocal Micro-Rest Test",
        detected_notes=detected,
        tempo_bpm=96.8,
        tempo_estimated=True,
        time_signature="4/4",
        time_signature_estimated=True,
        key_signature="C major",
        key_signature_estimated=True,
        duration_seconds=2.6,
        instrument="vocals",
        quantization="sixteenth",
        monophonic=True,
    )

    assert len(score.notes) == 4
    # Notation bridged tiny micro-rest between note 0 (E4) and note 1 (G4)
    assert score.notes[0].offset_sec == score.notes[1].onset_sec
    # Raw performance timing remained untouched!
    assert score.notes[0].raw_offset_sec == 0.44
    # Repeated note (G4 -> G4) remained separate
    assert score.notes[1].pitch_midi == 67 and score.notes[2].pitch_midi == 67
    # Genuine rest before note 3 remained intact
    assert score.notes[3].onset_sec - score.notes[2].offset_sec > 0.30
    # Decimal acoustic tempo preserved
    assert score.tempo_bpm == 96.8

    # Performance MIDI preserves original 0.44s offset
    pm = pretty_midi.PrettyMIDI(io.BytesIO(score_data_to_midi_bytes(score)))
    assert abs(pm.instruments[0].notes[0].end - 0.44) < 0.005


def test_piano_accompaniment_remains_polyphonic_with_chord_tones_and_bass_intact() -> None:
    melody_notes = [
        DetectedNote(pitch_midi=67, onset_sec=0.0, offset_sec=0.5, velocity=84, confidence=0.9),
        DetectedNote(pitch_midi=69, onset_sec=0.5, offset_sec=1.0, velocity=86, confidence=0.9),
    ]
    bass_notes = [
        DetectedNote(pitch_midi=41, onset_sec=0.0, offset_sec=1.0, velocity=82, confidence=0.9),
    ]
    other_notes = [
        DetectedNote(pitch_midi=53, onset_sec=0.0, offset_sec=1.0, velocity=76, confidence=0.88),
        DetectedNote(pitch_midi=57, onset_sec=0.0, offset_sec=1.0, velocity=78, confidence=0.88),
        DetectedNote(pitch_midi=60, onset_sec=0.0, offset_sec=1.0, velocity=80, confidence=0.88),
    ]

    score = build_piano_vocal_score_data(
        title="Piano Protection",
        melody_notes=melody_notes,
        chord_source_notes=[*other_notes, *bass_notes],
        bass_notes=bass_notes,
        other_notes=other_notes,
        tempo_bpm=95.0,
        time_signature="4/4",
        key_signature="F major",
        duration_seconds=1.2,
    )
    piano_notes = [n for n in score.notes if n.track_index == 1]
    assert any(n.pitch_midi == 41 for n in piano_notes)
    assert len({n.pitch_midi for n in piano_notes}) >= 3
    xml_str = score_data_to_musicxml(score)
    assert "<score-partwise" in xml_str
