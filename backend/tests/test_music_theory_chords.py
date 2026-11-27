"""Comprehensive tests for music-theory-aware chord recognition, bass fusion, and MusicXML/PDF sync."""

from __future__ import annotations

import io
import os
import xml.etree.ElementTree as ET
from pathlib import Path

import numpy as np
import soundfile as sf
from pypdf import PdfReader

from app.notation.accompaniment import generate_piano_accompaniment
from app.notation.analyzer import detect_chords, normalize_chord_symbol
from app.notation.beat_tracker import BeatTrackingResult
from app.notation.generator import (
    build_piano_vocal_score_data,
    build_score_data,
    render_score_pdf,
    score_data_to_musicxml,
)
from app.notation.piano_playability import apply_piano_playability
from app.notation.timing_map import build_timing_map
from app.schemas.score import ScoreChord, ScoreNote
from app.transcription.base import DetectedNote


def _sn(pitch: int, onset: float, offset: float, vel: int = 85, conf: float = 0.92, idx: int = 0) -> ScoreNote:
    return ScoreNote(
        id=f"n_{idx}_{pitch}",
        pitch_midi=pitch,
        onset_sec=onset,
        offset_sec=offset,
        velocity=vel,
        confidence=conf,
    )


def _add_chord_tone_block(
    notes: list[ScoreNote],
    pitches: list[int],
    onset: float,
    offset: float,
    *,
    vel: int = 86,
) -> None:
    for p in pitches:
        notes.append(_sn(p, onset, offset, vel=vel, idx=len(notes)))


def _synth_tones(freqs_amps: list[tuple[float, float]], dur_sec: float, sr: int = 22050) -> np.ndarray:
    t = np.arange(int(round(dur_sec * sr)), dtype=np.float32) / sr
    sig = np.zeros_like(t)
    for freq, amp in freqs_amps:
        sig += amp * np.sin(2.0 * np.pi * freq * t)
        sig += (amp * 0.25) * np.sin(2.0 * np.pi * 2.0 * freq * t)
    fade = min(int(0.015 * sr), len(sig) // 4)
    if fade > 0:
        env = np.ones_like(sig)
        env[:fade] = np.linspace(0.0, 1.0, fade, dtype=np.float32)
        env[-fade:] = np.linspace(1.0, 0.0, fade, dtype=np.float32)
        sig *= env
    return sig


def _midi_hz(m: int) -> float:
    return float(440.0 * (2.0 ** ((m - 69) / 12.0)))


def test_sustained_chords_and_passing_melody_notes_do_not_chatter() -> None:
    # 120 BPM (0.5s/beat, 2.0s/bar): Bar 1 C sustained; rapid passing 16th/8th melody F#4/D5 shouldn't trigger chords
    notes: list[ScoreNote] = []
    _add_chord_tone_block(notes, [48, 60, 64, 67], 0.0, 1.92, vel=88)
    # Rapid passing melody tones inside bar 1 (beats 2, 3, 4)
    notes.append(_sn(62, 0.75, 0.90, vel=72, idx=101))  # D4 16th passing
    notes.append(_sn(66, 1.25, 1.40, vel=70, idx=102))  # F#4 16th chromatic neighbor
    notes.append(_sn(74, 1.75, 1.92, vel=74, idx=103))  # D5 passing

    # Bar 2 (2.0..3.9s): Am sustained for 4 beats, then Bar 3 (4.0..5.9s): F sustained for 4 beats
    _add_chord_tone_block(notes, [45, 57, 60, 64], 2.0, 3.92, vel=88)
    _add_chord_tone_block(notes, [41, 53, 57, 60], 4.0, 5.92, vel=88)

    chords = detect_chords(notes, tempo_bpm=120.0, time_signature="4/4", key_signature="C major")
    assert [c.symbol for c in chords] == ["C", "Am", "F"]
    assert chords[0].measure == 1 and chords[0].beat == 1.0
    assert chords[1].measure == 2 and chords[1].beat == 1.0
    assert chords[2].measure == 3 and chords[2].beat == 1.0


def test_genuine_syncopated_anticipated_chord_change_retained() -> None:
    # 120 BPM (0.5s/beat): Bar 1 C major beats 1..2.5 (0.0 -> 1.24s), F major anticipates beat 3 at 1.25s (beat 3 & = 2.5 ql)
    notes: list[ScoreNote] = []
    _add_chord_tone_block(notes, [48, 60, 64, 67], 0.0, 1.22, vel=86)
    _add_chord_tone_block(notes, [41, 53, 57, 60], 1.25, 3.95, vel=90)

    chords = detect_chords(notes, tempo_bpm=120.0, time_signature="4/4", key_signature="C major")
    assert [c.symbol for c in chords] == ["C", "F"]
    # Second chord shifts earlier to anticipated half-beat (< 1.5 ql? beat 3 = 1.0s; beat 2.5 = 0.75s..1.25s!)
    assert abs(chords[1].onset_sec - 1.25) < 0.08


def test_bass_stem_identifies_cmaj7_g_over_b_and_e_over_g_sharp(tmp_path: Path) -> None:
    sr = 22050
    # 120 BPM => 0.5s/beat, 2 bars of 4/4:
    # Beat 0-3 (0..2s): Cmaj7 (bass C2=36, upper C4-E4-G4-B4)
    # Beat 4-7 (2..4s): A -> E/G# -> F#m progression (1 bar each across 6s):
    # Wait: test Cmaj7 + G/B + Am cleanly using real WAV Demucs bass + other stems!
    # Span: 0..2s Cmaj7, 2..4s G/B, 4..6s Am
    bass_sig = np.concatenate(
        [
            _synth_tones([(_midi_hz(36), 0.7)], 2.0, sr),  # C2
            _synth_tones([(_midi_hz(47), 0.7)], 2.0, sr),  # B2
            _synth_tones([(_midi_hz(45), 0.7)], 2.0, sr),  # A2
        ]
    )
    other_sig = np.concatenate(
        [
            _synth_tones([(_midi_hz(60), 0.3), (_midi_hz(64), 0.3), (_midi_hz(67), 0.3), (_midi_hz(71), 0.3)], 2.0, sr),  # C-E-G-B
            _synth_tones([(_midi_hz(67), 0.35), (_midi_hz(71), 0.35), (_midi_hz(74), 0.35)], 2.0, sr),  # G-B-D
            _synth_tones([(_midi_hz(69), 0.35), (_midi_hz(72), 0.35), (_midi_hz(76), 0.35)], 2.0, sr),  # A-C-E
        ]
    )
    bass_wav = tmp_path / "bass.wav"
    other_wav = tmp_path / "other.wav"
    sf.write(str(bass_wav), bass_sig.astype(np.float32), sr, subtype="PCM_16")
    sf.write(str(other_wav), other_sig.astype(np.float32), sr, subtype="PCM_16")

    diag: dict = {}
    chords = detect_chords(
        [],
        tempo_bpm=120.0,
        time_signature="4/4",
        key_signature="C major",
        audio_path=other_wav,
        bass_stem_path=bass_wav,
        harmonic_stem_path=other_wav,
        diagnostics_out=diag,
    )
    assert diag["bass_sources"] == ["demucs_bass"]
    assert diag["audio_chroma_used"] is True
    assert [c.symbol for c in chords] == ["Cmaj7", "G/B", "Am"]

    # Symbolic A -> E/G# -> F#m bass-walk progression preserves E/G# slash chord
    walk_notes: list[ScoreNote] = []
    _add_chord_tone_block(walk_notes, [45, 69, 73, 76], 0.0, 1.9, vel=88)     # A
    _add_chord_tone_block(walk_notes, [44, 64, 68, 71], 2.0, 3.9, vel=88)     # E/G#
    _add_chord_tone_block(walk_notes, [42, 66, 69, 73], 4.0, 5.9, vel=88)     # F#m
    walk_chords = detect_chords(walk_notes, tempo_bpm=120.0, time_signature="4/4", key_signature="A major")
    assert [c.symbol for c in walk_chords] == ["A", "E/G#", "F#m"]


def test_low_freq_mix_fallback_when_bass_stem_missing(tmp_path: Path) -> None:
    sr = 22050
    mix_sig = np.concatenate(
        [
            _synth_tones([(_midi_hz(36), 0.55), (_midi_hz(60), 0.28), (_midi_hz(64), 0.28), (_midi_hz(67), 0.28)], 2.0, sr),
            _synth_tones([(_midi_hz(43), 0.55), (_midi_hz(67), 0.28), (_midi_hz(71), 0.28), (_midi_hz(74), 0.28)], 2.0, sr),
        ]
    )
    mix_wav = tmp_path / "mix.wav"
    sf.write(str(mix_wav), mix_sig.astype(np.float32), sr, subtype="PCM_16")

    diag: dict = {}
    chords = detect_chords(
        [],
        tempo_bpm=120.0,
        time_signature="4/4",
        key_signature="C major",
        audio_path=mix_wav,
        diagnostics_out=diag,
    )
    assert diag["bass_sources"] == ["low_freq_mix_fallback"]
    assert [c.symbol for c in chords] == ["C", "G"]


def test_circle_of_fifths_secondary_dominant_borrowed_and_modulation() -> None:
    # 1) Circle of Fifths vi -> ii -> V7 -> I in F major: Dm -> Gm7 -> C7 -> F
    cof_notes: list[ScoreNote] = []
    _add_chord_tone_block(cof_notes, [50, 62, 65, 69], 0.0, 1.9, vel=88)   # Dm
    _add_chord_tone_block(cof_notes, [43, 55, 58, 62, 65], 2.0, 3.9, vel=88)  # Gm7
    _add_chord_tone_block(cof_notes, [48, 60, 64, 67, 70], 4.0, 5.9, vel=88)  # C7
    _add_chord_tone_block(cof_notes, [41, 53, 57, 60], 6.0, 7.9, vel=88)   # F
    cof_chords = detect_chords(cof_notes, tempo_bpm=120.0, time_signature="4/4", key_signature="F major")
    assert [c.symbol for c in cof_chords] == ["Dm", "Gm7", "C7", "F"]

    # 2) Secondary dominant D7 (V/V) -> G -> C and borrowed chord Fm (iv) -> C in C major
    sec_notes: list[ScoreNote] = []
    _add_chord_tone_block(sec_notes, [48, 60, 64, 67], 0.0, 1.9, vel=88)       # C
    _add_chord_tone_block(sec_notes, [50, 62, 66, 69, 72], 2.0, 3.9, vel=88)   # D7 (chromatic F#)
    _add_chord_tone_block(sec_notes, [43, 55, 59, 62], 4.0, 5.9, vel=88)       # G
    _add_chord_tone_block(sec_notes, [41, 53, 56, 60], 6.0, 7.9, vel=88)       # Fm (borrowed iv, Ab)
    _add_chord_tone_block(sec_notes, [48, 60, 64, 67], 8.0, 9.9, vel=88)       # C
    sec_chords = detect_chords(sec_notes, tempo_bpm=120.0, time_signature="4/4", key_signature="C major")
    assert [c.symbol for c in sec_chords] == ["C", "D7", "G", "Fm", "C"]

    # 3) Modulation from C major to Eb major is never suppressed by key signature
    mod_notes: list[ScoreNote] = []
    for bar_i in range(4):
        t0 = bar_i * 2.0
        _add_chord_tone_block(mod_notes, [48, 60, 64, 67], t0, t0 + 1.9, vel=88)
    for bar_i in range(4, 8):
        t0 = bar_i * 2.0
        _add_chord_tone_block(mod_notes, [39, 51, 55, 58], t0, t0 + 1.9, vel=88)  # Eb (Eb-G-Bb)
    mod_chords = detect_chords(mod_notes, tempo_bpm=120.0, time_signature="4/4", key_signature="C major")
    assert [c.symbol for c in mod_chords] == ["C", "Eb"]


def test_chord_vocabulary_normalization_and_valid_musicxml_pdf() -> None:
    assert normalize_chord_symbol("B-maj7") == "Bbmaj7"
    assert normalize_chord_symbol("Gsuspended-fourth-seventh") == "G7sus4"
    assert normalize_chord_symbol("C#o7") == "C#dim7"
    assert normalize_chord_symbol("E-/G") == "Eb/G"

    # Multi-meter (3/4 with 1-beat pickup) + G7sus4 + Cadd9 + Bm7b5 + G/B in MusicXML & PDF
    bt = BeatTrackingResult(
        beat_times_sec=[1.0 + i * 0.5 for i in range(15)],
        downbeat_times_sec=[1.0 + i * 1.5 for i in range(6)],
        raw_bpm=120.0,
        selected_bpm=120.0,
        candidates=[],
        selected_ratio=1.0,
        downbeat_confidence=0.92,
        resolution_reason="test",
        ambiguous=False,
        requested_provider="beat_this",
        actual_provider="beat_this",
        fallback_used=False,
    )
    notes = [
        DetectedNote(67, 0.50, 0.95, 76),  # pickup G4
        # Measure 1 (1.0 -> 2.5s): Cadd9 (C-E-G-D)
        DetectedNote(48, 1.00, 2.40, 88),
        DetectedNote(60, 1.00, 2.40, 84),
        DetectedNote(64, 1.00, 2.40, 84),
        DetectedNote(67, 1.00, 2.40, 82),
        DetectedNote(62, 1.00, 2.40, 82),
        # Measure 2 (2.5 -> 4.0s): G7sus4 (G-C-D-F)
        DetectedNote(43, 2.50, 3.90, 88),
        DetectedNote(60, 2.50, 3.90, 84),
        DetectedNote(62, 2.50, 3.90, 84),
        DetectedNote(65, 2.50, 3.90, 84),
        # Measure 3 (4.0 -> 5.5s): G/B (B2 bass + G-B-D)
        DetectedNote(47, 4.00, 5.40, 88),
        DetectedNote(67, 4.00, 5.40, 84),
        DetectedNote(71, 4.00, 5.40, 84),
        DetectedNote(74, 4.00, 5.40, 84),
    ]
    tm = build_timing_map(beat_result=bt, notes=notes, duration_seconds=6.5, time_signature="3/4")
    assert tm.pickup_ql == 1.0

    score = build_score_data(
        title="Theory Sync Test",
        detected_notes=notes,
        tempo_bpm=120.0,
        tempo_estimated=True,
        time_signature="3/4",
        time_signature_estimated=False,
        key_signature="C major",
        key_signature_estimated=False,
        duration_seconds=6.5,
        instrument="piano",
        timing_map=tm,
        analysis={"timing_map": tm.provenance},
    )
    assert [c.symbol for c in score.chords] == ["Cadd9", "G7sus4", "G/B"]
    assert score.chords[0].measure == 1 and score.chords[0].beat == 1.0
    assert score.chords[1].measure == 2 and score.chords[1].beat == 1.0

    xml_str = score_data_to_musicxml(score)
    assert "suspended-fourth-seventh" not in xml_str
    root = ET.fromstring(xml_str)
    harmonies = root.findall(".//part[1]/measure/harmony")
    assert len(harmonies) == 3
    kinds = [(h.findtext("kind"), h.find("kind").attrib.get("text")) for h in harmonies]
    assert kinds[0] == ("major", "add9")
    assert kinds[1] == ("suspended-fourth", "7sus4")
    assert harmonies[2].findtext("bass/bass-step") == "B"

    # ReportLab PDF agrees on normalized chord labels without MuseScore dependency
    prev_env = os.environ.get("DISABLE_MUSESCORE_PDF")
    os.environ["DISABLE_MUSESCORE_PDF"] = "1"
    try:
        pdf_bytes = render_score_pdf(score, include_chords=True)
    finally:
        if prev_env is None:
            os.environ.pop("DISABLE_MUSESCORE_PDF", None)
        else:
            os.environ["DISABLE_MUSESCORE_PDF"] = prev_env
    text = "\n".join((page.extract_text() or "") for page in PdfReader(io.BytesIO(pdf_bytes)).pages)
    for expected_sym in ("Cadd9", "G7sus4", "G/B"):
        assert expected_sym in text


def test_ambiguous_single_tones_abstain_and_lead_melody_isolates_vibrato(tmp_path: Path) -> None:
    # Single unison notes must abstain rather than fabricate a chord
    chords = detect_chords([_sn(60, 0.0, 1.5, vel=70)], tempo_bpm=120.0, time_signature="4/4", key_signature="C major")
    assert chords == []

    # Piano+Vocal & Accompaniment preserve E/G# bass movement without altering transcribed notes
    melody = [DetectedNote(76, 0.0, 1.9, 90, 0.9), DetectedNote(76, 2.0, 3.9, 90, 0.9)]
    # Other & bass represent A -> E/G# while vocal holds E5 + passing F#5/D#5 vibrato
    other = [
        DetectedNote(69, 0.0, 1.9, 84, 0.9), DetectedNote(73, 0.0, 1.9, 82, 0.9), DetectedNote(76, 0.0, 1.9, 82, 0.9),
        DetectedNote(64, 2.0, 3.9, 84, 0.9), DetectedNote(68, 2.0, 3.9, 82, 0.9), DetectedNote(71, 2.0, 3.9, 82, 0.9),
    ]
    bass = [
        DetectedNote(45, 0.0, 1.9, 90, 0.9),
        DetectedNote(44, 2.0, 3.9, 90, 0.9),
    ]
    pv = build_piano_vocal_score_data(
        title="Vocal Isolation Test",
        melody_notes=[*melody, DetectedNote(75, 2.1, 2.25, 65, 0.8), DetectedNote(77, 2.3, 2.45, 65, 0.8)],
        chord_source_notes=[*other, *bass],
        bass_notes=bass,
        other_notes=other,
        tempo_bpm=120.0,
        key_signature="A major",
        duration_seconds=4.0,
        arrangement_detail="balanced",
    )
    assert [c.symbol for c in pv.chords] == ["A", "E/G#"]

    # Playability standard mode preserves the E/G# slash bass note (G#2 = 44) untouched
    raw_piano = [
        DetectedNote(44, 0.0, 1.9, 88, 0.92),
        DetectedNote(64, 0.0, 1.9, 82, 0.90),
        DetectedNote(68, 0.0, 1.9, 82, 0.90),
        DetectedNote(71, 0.0, 1.9, 82, 0.90),
    ]
    play_res = apply_piano_playability(
        raw_piano,
        chords=[ScoreChord(id="c1", measure=1, beat=1.0, onset_sec=0.0, symbol="E/G#", root="E", quality="major", confidence=0.9)],
        tempo_bpm=120.0,
        time_signature="4/4",
        key_signature="A major",
        smoothing="standard",
    )
    assert 44 in [n.pitch_midi for n in play_res.notes]

    accomp = generate_piano_accompaniment(
        chords=pv.chords,
        melody_notes=melody,
        bass_notes=bass,
        other_notes=other,
        tempo_bpm=120.0,
        time_signature="4/4",
        key_signature="A major",
        duration_seconds=4.0,
        arrangement_detail="simple",
    )
    assert any(n.pitch_midi == 44 for n in accomp.notes)
