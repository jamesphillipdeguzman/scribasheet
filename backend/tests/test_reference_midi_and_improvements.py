"""Regression tests for Phase E.2: reference MIDI evaluation, engine selection,
conservative harmonic suppression, chord refinement, and 8va engraving.
"""

from __future__ import annotations

import xml.etree.ElementTree as ET
from pathlib import Path

import music21
import pytest

from app.notation.analyzer import detect_chords
from app.notation.evaluation import (
    evaluate_notes_against_reference,
    load_reference_midi,
)
from app.notation.generator import build_score_data, score_data_to_musicxml
from app.schemas.score import ScoreNote
from app.transcription.base import DetectedNote
from app.transcription.note_refiner import NoteRefinerConfig, refine_detected_notes
from app.transcription.provider_factory import resolve_engine_for_instrument

REPO_ROOT = Path(__file__).resolve().parents[2]
CLOSER_MIDI = REPO_ROOT / "assets" / "midi" / "Closer Gehlee.mid"


def test_piano_engine_selection_prefers_transkun_with_fallback(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("TRANSCRIPTION_ENGINE", raising=False)
    monkeypatch.delenv("TRANSCRIPTION_ALLOW_FALLBACK", raising=False)

    monkeypatch.setattr("app.transcription.provider_factory.is_transkun_available", lambda: True)
    eng, fb = resolve_engine_for_instrument("piano")
    assert eng == "transkun"
    assert fb is True

    # Non-piano instruments preserve default configuration
    g_eng, g_fb = resolve_engine_for_instrument("guitar")
    assert g_eng == "basic_pitch"
    assert g_fb is False

    # Falls back to basic_pitch if Transkun is unavailable
    monkeypatch.setattr("app.transcription.provider_factory.is_transkun_available", lambda: False)
    eng2, _ = resolve_engine_for_instrument("piano")
    assert eng2 == "basic_pitch"


def test_conservative_harmonic_suppression_preserves_genuine_octaves_and_fifths() -> None:
    notes = [
        # Genuine octave (strong confidence, long independent duration, melodic neighbor) -> MUST KEEP
        DetectedNote(pitch_midi=48, onset_sec=0.00, offset_sec=1.00, velocity=90, confidence=0.88),
        DetectedNote(pitch_midi=60, onset_sec=0.01, offset_sec=1.10, velocity=82, confidence=0.78),
        DetectedNote(pitch_midi=62, onset_sec=0.25, offset_sec=0.50, velocity=76, confidence=0.72),
        # Genuine fifth (+19 st) with strong confidence -> MUST KEEP
        DetectedNote(pitch_midi=53, onset_sec=2.00, offset_sec=3.00, velocity=85, confidence=0.85),
        DetectedNote(pitch_midi=72, onset_sec=2.02, offset_sec=3.05, velocity=78, confidence=0.74),
        # Octave ghost (+12 st): weak conf, weak vel, shorter contained duration, no neighbor -> SUPPRESS
        DetectedNote(pitch_midi=45, onset_sec=4.00, offset_sec=5.00, velocity=95, confidence=0.90),
        DetectedNote(pitch_midi=57, onset_sec=4.01, offset_sec=4.45, velocity=48, confidence=0.35),
        # Fifth harmonic ghost (+19 st): weak conf, weak vel, shorter contained duration, no neighbor -> SUPPRESS
        DetectedNote(pitch_midi=43, onset_sec=6.00, offset_sec=7.00, velocity=92, confidence=0.88),
        DetectedNote(pitch_midi=62, onset_sec=6.01, offset_sec=6.40, velocity=45, confidence=0.32),
    ]
    res = refine_detected_notes(notes, NoteRefinerConfig())
    kept_pitches = [n.pitch_midi for n in res.notes]
    assert 48 in kept_pitches
    assert 60 in kept_pitches
    assert 53 in kept_pitches
    assert 72 in kept_pitches
    assert 57 not in kept_pitches
    assert 62 not in [n.pitch_midi for n in res.notes if abs(n.onset_sec - 6.01) < 0.05]
    assert res.stats["octave_ghosts_suppressed"] == 1
    assert res.stats["fifth_harmonics_suppressed"] == 1
    assert any(d.get("semitone_diff") == 19 and "reason" in d for d in res.decisions)


def test_8va_ottava_spanner_emits_octave_shift_without_altering_sounding_pitches() -> None:
    # Sustained high-register melody (E6 -> F#6 -> G#6 -> B6) followed by mid-register C4
    notes = [
        DetectedNote(pitch_midi=88, onset_sec=0.0, offset_sec=0.5, velocity=82),
        DetectedNote(pitch_midi=90, onset_sec=0.5, offset_sec=1.0, velocity=82),
        DetectedNote(pitch_midi=92, onset_sec=1.0, offset_sec=1.5, velocity=84),
        DetectedNote(pitch_midi=95, onset_sec=1.5, offset_sec=2.0, velocity=86),
        DetectedNote(pitch_midi=60, onset_sec=2.0, offset_sec=3.0, velocity=80),
    ]
    score = build_score_data(
        title="8va Test",
        detected_notes=notes,
        tempo_bpm=120.0,
        tempo_estimated=False,
        time_signature="4/4",
        time_signature_estimated=False,
        key_signature="E major",
        key_signature_estimated=False,
        duration_seconds=3.0,
        instrument="piano",
    )
    xml_str = score_data_to_musicxml(score)
    root = ET.fromstring(xml_str)
    shifts = [(el.get("type"), el.get("size")) for el in root.findall(".//octave-shift")]
    assert ("down", "8") in shifts
    assert ("stop", "8") in shifts

    parsed = music21.converter.parseData(xml_str, format="musicxml")
    sounding_pitches: list[int] = []
    for el in parsed.recurse().notes:
        if isinstance(el, music21.harmony.ChordSymbol):
            continue
        if isinstance(el, music21.chord.Chord):
            sounding_pitches.extend(int(p.midi) for p in el.pitches)
        else:
            sounding_pitches.append(int(el.pitch.midi))
    for expected in (88, 90, 92, 95, 60):
        assert expected in sounding_pitches


def test_reference_midi_closer_gehlee_evaluation_and_chord_and_8va() -> None:
    assert CLOSER_MIDI.exists(), f"Missing reference MIDI: {CLOSER_MIDI}"
    ref = load_reference_midi(CLOSER_MIDI)
    assert ref.track_count == 1
    assert len(ref.notes) == 1253
    assert 84.0 <= ref.tempo_bpm <= 87.0
    assert ref.time_signature == "4/4"

    # Self-comparison with +0.5s simulated initial silence must align to 100% F1
    shifted = [
        DetectedNote(
            pitch_midi=n.pitch_midi,
            onset_sec=n.onset_sec + 0.5,
            offset_sec=n.offset_sec + 0.5,
            velocity=n.velocity,
            confidence=1.0,
        )
        for n in ref.notes
    ]
    eval_res = evaluate_notes_against_reference(ref.notes, shifted)
    assert eval_res.precision == 1.0
    assert eval_res.recall == 1.0
    assert abs(eval_res.onset_offset_sec - 0.5) < 0.03

    # Chord detection on reference notes produces clean, deduplicated E-major harmony
    spb = 60.0 / ref.tempo_bpm
    spm = spb * 4.0
    score_notes = [
        ScoreNote(
            id=f"r_{i}",
            pitch_midi=n.pitch_midi,
            pitch_name="C4",
            onset_sec=n.onset_sec,
            offset_sec=n.offset_sec,
            velocity=n.velocity,
            hand="LH" if n.pitch_midi < 60 else "RH",
            measure=int(n.onset_sec // spm) + 1,
            beat=float((n.onset_sec % spm) / spb + 1.0),
        )
        for i, n in enumerate(ref.notes)
    ]
    chords = detect_chords(score_notes, tempo_bpm=ref.tempo_bpm, time_signature="4/4", key_signature="E major")
    assert 20 <= len(chords) <= 65
    for idx in range(1, len(chords)):
        assert chords[idx].symbol != chords[idx - 1].symbol

    # MusicXML generation emits both <harmony placement="above"> and <octave-shift>
    score = build_score_data(
        title="Closer Gehlee",
        detected_notes=ref.notes,
        tempo_bpm=ref.tempo_bpm,
        tempo_estimated=False,
        time_signature=ref.time_signature,
        time_signature_estimated=False,
        key_signature="E major",
        key_signature_estimated=True,
        duration_seconds=ref.duration_sec,
        instrument="piano",
    )
    xml_str = score_data_to_musicxml(score)
    root = ET.fromstring(xml_str)
    assert len(root.findall(".//harmony")) == len(score.chords)
    assert any(el.get("type") == "down" and el.get("size") == "8" for el in root.findall(".//octave-shift"))
