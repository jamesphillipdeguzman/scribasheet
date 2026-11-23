"""Phase 5 tests: automatic meter detection, incomplete pickup measures, and sparse/dyad chord recognition."""

from __future__ import annotations

import xml.etree.ElementTree as ET

from app.notation.analyzer import ChordDetectionConfig, detect_chords
from app.notation.beat_tracker import BeatTrackingResult, infer_time_signature_from_beats
from app.notation.generator import build_score_data, score_data_to_musicxml
from app.notation.timing_map import build_timing_map
from app.transcription.base import DetectedNote


def _make_beat_result(
    *,
    beats_per_bar: int,
    bpm: float = 100.0,
    num_bars: int = 6,
    confidence: float = 0.85,
) -> BeatTrackingResult:
    spb = 60.0 / bpm
    beats: list[float] = []
    downbeats: list[float] = []
    t = 0.5
    for bar in range(num_bars):
        downbeats.append(t)
        for _ in range(beats_per_bar):
            beats.append(t)
            t += spb
    downbeats.append(t)
    return BeatTrackingResult(
        beat_times_sec=beats,
        downbeat_times_sec=downbeats,
        raw_bpm=bpm,
        selected_bpm=bpm,
        candidates=[],
        selected_ratio=1.0,
        downbeat_confidence=confidence,
        resolution_reason="test",
        ambiguous=False,
        requested_provider="beat_this",
        actual_provider="beat_this",
        fallback_used=False,
    )


def test_infer_time_signature_detects_2_4_3_4_4_4_and_6_8() -> None:
    for beats_per_bar, expected in [(2, "2/4"), (3, "3/4"), (4, "4/4"), (6, "6/8")]:
        bt = _make_beat_result(beats_per_bar=beats_per_bar, confidence=0.88)
        ts, estimated, diag = infer_time_signature_from_beats(bt, "auto")
        assert ts == expected
        assert estimated is True
        assert diag["reason"] == "downbeat_interval_consensus"


def test_infer_time_signature_preserves_explicit_and_falls_back_on_low_confidence() -> None:
    bt_3_4 = _make_beat_result(beats_per_bar=3, confidence=0.90)
    ts_exp, est_exp, diag_exp = infer_time_signature_from_beats(bt_3_4, "4/4")
    assert ts_exp == "4/4"
    assert est_exp is False
    assert diag_exp["reason"] == "explicit_user_selection"

    bt_low = _make_beat_result(beats_per_bar=3, confidence=0.25)
    ts_low, est_low, diag_low = infer_time_signature_from_beats(bt_low, "auto")
    assert ts_low == "4/4"
    assert est_low is True
    assert diag_low["reason"] == "low_confidence_fallback_4_4"


def test_incomplete_pickup_measure_in_3_4_musicxml_and_raw_timing_preserved() -> None:
    # 3/4 at 120 BPM (spb = 0.5s), first downbeat at 1.0s, pickup note at 0.5s (1 beat pickup)
    bt = _make_beat_result(beats_per_bar=3, bpm=120.0, num_bars=4, confidence=0.9)
    # Shift beat_result downbeats so first downbeat is at 1.0s
    spb = 0.5
    bt.downbeat_times_sec = [1.0 + i * 3 * spb for i in range(5)]
    bt.beat_times_sec = [1.0 + i * spb for i in range(12)]

    notes = [
        DetectedNote(pitch_midi=67, onset_sec=0.52, offset_sec=0.98, velocity=78),  # pickup (1 beat)
        DetectedNote(pitch_midi=60, onset_sec=1.01, offset_sec=2.45, velocity=86),  # bar 1 downbeat
        DetectedNote(pitch_midi=64, onset_sec=2.50, offset_sec=3.95, velocity=82),  # bar 2 downbeat
    ]
    tm = build_timing_map(beat_result=bt, notes=notes, duration_seconds=7.0, time_signature="3/4")
    assert tm.pickup_ql == 1.0

    score = build_score_data(
        title="Pickup Test",
        detected_notes=notes,
        tempo_bpm=tm.tempo_bpm,
        tempo_estimated=True,
        time_signature="3/4",
        time_signature_estimated=False,
        key_signature="C major",
        key_signature_estimated=False,
        duration_seconds=7.0,
        instrument="piano",
        analysis={"timing_provenance": tm.provenance},
        timing_map=tm,
    )
    # Raw performance timing stays preserved
    assert abs(score.notes[0].raw_onset_sec - 0.52) < 1e-4
    assert abs(score.notes[1].raw_onset_sec - 1.01) < 1e-4

    xml_str = score_data_to_musicxml(score)
    root = ET.fromstring(xml_str)
    measures = root.findall(".//part/measure")
    assert len(measures) >= 2
    assert measures[0].attrib.get("number") == "0"
    assert measures[0].attrib.get("implicit") == "yes"
    assert measures[1].attrib.get("number") == "1"


def test_dyad_chord_recognition_infers_implied_triads_and_ignores_single_notes() -> None:
    # C major dyad (C4 + E4), A minor dyad (A3 + C4), and single passing note (D4)
    notes = [
        DetectedNote(pitch_midi=60, onset_sec=0.0, offset_sec=1.9, velocity=85),
        DetectedNote(pitch_midi=64, onset_sec=0.0, offset_sec=1.9, velocity=80),
        DetectedNote(pitch_midi=57, onset_sec=2.0, offset_sec=3.9, velocity=84),
        DetectedNote(pitch_midi=60, onset_sec=2.0, offset_sec=3.9, velocity=80),
        DetectedNote(pitch_midi=62, onset_sec=4.0, offset_sec=5.8, velocity=70),
    ]
    chords = detect_chords(
        notes,
        tempo_bpm=120.0,
        time_signature="4/4",
        key_signature="C major",
        config=ChordDetectionConfig(min_distinct_pcs=3),
    )
    labels = [c.symbol for c in chords]
    assert "C" in labels
    assert "Am" in labels
    # Single pitch class window at beat 8..12 (4.0..5.8s) must not produce a bogus chord
    assert not any(c.onset_sec >= 4.0 for c in chords)
