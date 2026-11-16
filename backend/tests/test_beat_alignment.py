"""Regression tests for Phase C beat-synchronized TimingMap and tempo/downbeat alignment."""

from __future__ import annotations

import io
import xml.etree.ElementTree as ET
from pathlib import Path

import music21
import numpy as np
import pretty_midi
import soundfile as sf

from app.notation import beat_tracker
from app.notation.beat_tracker import (
    BeatTrackingResult,
    resolve_tempo_from_beats,
    track_beats_and_downbeats,
)
from app.notation.generator import (
    build_score_data,
    score_data_to_midi_bytes,
    score_data_to_musicxml,
)
from app.notation.timing_map import build_timing_map
from app.transcription.base import DetectedNote


def _write_wav(path: Path, samples: np.ndarray, sr: int = 22050) -> None:
    sf.write(str(path), samples.astype(np.float32), sr, subtype="PCM_16")


def test_resolve_86bpm_when_beats_are_172bpm_double_time() -> None:
    # Beats at 172 BPM (0.3488s), downbeats every 8 beats = 4/4 at 86 BPM (2.7907s)
    beat_times = [i * (60.0 / 172.0) for i in range(64)]
    downbeat_times = [beat_times[i] for i in range(0, 64, 8)]
    res = resolve_tempo_from_beats(
        beat_times=beat_times,
        downbeat_times=downbeat_times,
        beats_per_measure=4,
    )
    assert 82.0 <= res["selected_bpm"] <= 90.0
    assert res["selected_ratio"] < 0.6


def test_preserves_genuine_172bpm_without_halving() -> None:
    # Genuine 172 BPM: downbeats every 4 beats (1.395s per bar)
    beat_times = [i * (60.0 / 172.0) for i in range(64)]
    downbeat_times = [beat_times[i] for i in range(0, 64, 4)]
    res = resolve_tempo_from_beats(
        beat_times=beat_times,
        downbeat_times=downbeat_times,
        beats_per_measure=4,
    )
    assert 168.0 <= res["selected_bpm"] <= 176.0


def test_leading_silence_aligns_measure_1_to_first_downbeat() -> None:
    # 4.9s leading silence before Beat 1 of Measure 1 at 86 BPM
    spb = 60.0 / 86.0
    downbeats = [4.9 + i * 4 * spb for i in range(6)]
    beats = [4.9 + i * spb for i in range(20)]
    bt = BeatTrackingResult(
        beat_times_sec=beats,
        downbeat_times_sec=downbeats,
        raw_bpm=86.0,
        selected_bpm=86.0,
        candidates=[],
        selected_ratio=1.0,
        downbeat_confidence=0.95,
        resolution_reason="test",
        ambiguous=False,
        requested_provider="beat_this",
        actual_provider="beat_this",
        fallback_used=False,
    )
    notes = [
        DetectedNote(pitch_midi=60, onset_sec=4.92, offset_sec=5.55, velocity=80),
        DetectedNote(pitch_midi=64, onset_sec=4.9 + spb, offset_sec=4.9 + 2 * spb, velocity=80),
    ]
    tm = build_timing_map(beat_result=bt, notes=notes, duration_seconds=15.0, time_signature="4/4")
    assert tm.pickup_ql == 0.0
    assert abs(tm.seconds_to_ql(4.9) - 0.0) < 1e-4

    score = build_score_data(
        title="Leading Silence",
        detected_notes=notes,
        tempo_bpm=tm.tempo_bpm,
        tempo_estimated=True,
        time_signature="4/4",
        time_signature_estimated=True,
        key_signature="C major",
        key_signature_estimated=True,
        duration_seconds=15.0,
        instrument="piano",
        timing_map=tm,
    )
    assert score.notes[0].onset_sec == 0.0


def test_pickup_notes_before_first_downbeat_preserve_measure_structure() -> None:
    spb = 60.0 / 86.0
    first_db = 4.0
    downbeats = [first_db + i * 4 * spb for i in range(5)]
    beats = [first_db + i * spb for i in range(16)]
    bt = BeatTrackingResult(
        beat_times_sec=beats,
        downbeat_times_sec=downbeats,
        raw_bpm=86.0,
        selected_bpm=86.0,
        candidates=[],
        selected_ratio=1.0,
        downbeat_confidence=0.95,
        resolution_reason="test",
        ambiguous=False,
        requested_provider="beat_this",
        actual_provider="beat_this",
        fallback_used=False,
    )
    # Pickup note 1 beat before first downbeat + downbeat note
    notes = [
        DetectedNote(pitch_midi=67, onset_sec=first_db - spb, offset_sec=first_db, velocity=75),
        DetectedNote(pitch_midi=60, onset_sec=first_db, offset_sec=first_db + spb, velocity=85),
    ]
    tm = build_timing_map(beat_result=bt, notes=notes, duration_seconds=14.0, time_signature="4/4")
    assert tm.pickup_ql == 4.0
    assert abs(tm.seconds_to_ql(first_db) - 4.0) < 1e-4
    assert abs(tm.seconds_to_ql(first_db - spb) - 3.0) < 1e-4


def test_piecewise_tempo_drift_and_80_plus_measures_no_cumulative_drift() -> None:
    # 85 measures with gradual tempo drift from 80 BPM to 92 BPM
    n_bars = 85
    downbeats = [0.0]
    for m in range(n_bars):
        local_bpm = 80.0 + (12.0 * m / n_bars)
        downbeats.append(downbeats[-1] + 4.0 * (60.0 / local_bpm))
    beats = []
    for m in range(n_bars):
        b0, b1 = downbeats[m], downbeats[m + 1]
        for b in range(4):
            beats.append(b0 + (b / 4.0) * (b1 - b0))

    bt = BeatTrackingResult(
        beat_times_sec=beats,
        downbeat_times_sec=downbeats,
        raw_bpm=86.0,
        selected_bpm=86.0,
        candidates=[],
        selected_ratio=1.0,
        downbeat_confidence=0.9,
        resolution_reason="test",
        ambiguous=False,
        requested_provider="beat_this",
        actual_provider="beat_this",
        fallback_used=False,
    )
    notes = [
        DetectedNote(pitch_midi=60, onset_sec=downbeats[m] + 0.02, offset_sec=downbeats[m] + 0.5, velocity=80)
        for m in range(n_bars)
    ]
    tm = build_timing_map(beat_result=bt, notes=notes, duration_seconds=downbeats[-1], time_signature="4/4")
    # Every barline at measure m=0..84 maps cleanly to 4*m within 0.02 ql (zero cumulative drift!)
    for m in range(n_bars):
        assert abs(tm.seconds_to_ql(downbeats[m]) - 4.0 * m) < 0.02


def test_jitter_syncopation_measure_crossing_and_midi_musicxml_parity() -> None:
    spb = 60.0 / 86.0
    downbeats = [i * 4 * spb for i in range(4)]
    beats = [i * spb for i in range(12)]
    bt = BeatTrackingResult(
        beat_times_sec=beats,
        downbeat_times_sec=downbeats,
        raw_bpm=86.0,
        selected_bpm=86.0,
        candidates=[],
        selected_ratio=1.0,
        downbeat_confidence=0.95,
        resolution_reason="test",
        ambiguous=False,
        requested_provider="beat_this",
        actual_provider="beat_this",
        fallback_used=False,
    )
    notes = [
        # Beat 1 with +35ms jitter -> snaps to 0.0
        DetectedNote(pitch_midi=60, onset_sec=0.035, offset_sec=spb, velocity=80),
        # Intentional offbeat syncopation at 1.5 beats (-25ms jitter) -> preserved at 1.5 ql
        DetectedNote(pitch_midi=64, onset_sec=1.5 * spb - 0.025, offset_sec=2.5 * spb, velocity=82),
        # Measure-crossing note from beat 3.5 to beat 5.0
        DetectedNote(pitch_midi=67, onset_sec=3.5 * spb, offset_sec=5.0 * spb, velocity=84),
    ]
    tm = build_timing_map(beat_result=bt, notes=notes, duration_seconds=8.0, time_signature="4/4")
    score = build_score_data(
        title="Syncopation & Parity",
        detected_notes=notes,
        tempo_bpm=tm.tempo_bpm,
        tempo_estimated=True,
        time_signature="4/4",
        time_signature_estimated=True,
        key_signature="C major",
        key_signature_estimated=True,
        duration_seconds=8.0,
        instrument="piano",
        quantization="eighth",
        timing_map=tm,
    )
    assert abs(score.notes[0].onset_sec - 0.0) < 1e-4
    assert abs((score.notes[1].onset_sec / spb) - 1.5) < 0.05

    pm = pretty_midi.PrettyMIDI(io.BytesIO(score_data_to_midi_bytes(score)))
    midi_p = sorted(n.pitch for inst in pm.instruments for n in inst.notes)

    xml_str = score_data_to_musicxml(score)
    m21 = music21.converter.parseData(xml_str, format="musicxml")
    xml_p = []
    for part in m21.parts:
        for el in part.recurse().notes:
            if el.tie and el.tie.type in ("continue", "stop"):
                continue
            if isinstance(el, music21.note.Note):
                xml_p.append(el.pitch.midi)
            elif isinstance(el, music21.chord.Chord):
                xml_p.extend(p.midi for p in el.pitches)
    assert midi_p == sorted(xml_p)
    ET.fromstring(xml_str)


def test_fallback_to_librosa_when_beat_this_unavailable(tmp_path: Path, monkeypatch) -> None:
    sr = 22050
    t = np.arange(int(3.0 * sr), dtype=np.float32) / sr
    sig = np.zeros_like(t)
    for k in range(6):
        idx = int(k * 0.5 * sr)
        sig[idx : idx + 800] += 0.5 * np.sin(2.0 * np.pi * 440.0 * t[:800])
    wav = tmp_path / "pulse.wav"
    _write_wav(wav, sig, sr=sr)

    def fail_beat_this(*args, **kwargs):
        raise RuntimeError("Mocked Beat This! failure")

    monkeypatch.setattr(beat_tracker, "_run_beat_this", fail_beat_this)
    res = track_beats_and_downbeats(wav, beats_per_measure=4, provider_preference="auto")
    assert res.requested_provider == "auto"
    assert res.actual_provider == "librosa"
    assert res.fallback_used is True
    assert "Mocked Beat This! failure" in (res.fallback_reason or "")
