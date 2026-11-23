import io
from pathlib import Path

import music21
import pretty_midi

from app.notation.evaluation import load_reference_midi
from app.notation.generator import (
    build_score_data,
    get_note_notation_timing,
    get_note_performance_timing,
    score_data_to_midi_bytes,
    score_data_to_musicxml,
)
from app.notation.omr import musicxml_to_satb_score_data
from app.schemas.score import ScoreData, ScoreNote, ScoreTrack
from app.transcription.base import DetectedNote


def test_dual_timing_preserves_expressive_midi_while_quantizing_musicxml() -> None:
    # Deliberately off-grid expressive performance timings at 120 BPM (0.5s per quarter, 0.125s per sixteenth)
    raw_notes = [
        DetectedNote(pitch_midi=60, onset_sec=0.037, offset_sec=0.462, velocity=78, confidence=0.91),
        DetectedNote(pitch_midi=64, onset_sec=0.519, offset_sec=0.988, velocity=86, confidence=0.93),
        DetectedNote(pitch_midi=67, onset_sec=1.041, offset_sec=1.473, velocity=92, confidence=0.95),
        DetectedNote(pitch_midi=72, onset_sec=1.482, offset_sec=1.964, velocity=96, confidence=0.97),
    ]

    score = build_score_data(
        title="Expressive Dual Timing",
        detected_notes=raw_notes,
        tempo_bpm=120.0,
        tempo_estimated=False,
        time_signature="4/4",
        time_signature_estimated=False,
        key_signature="C major",
        key_signature_estimated=False,
        duration_seconds=2.1,
        instrument="piano",
        quantization="quarter",
    )

    assert len(score.notes) == 4
    # Notation timing is quantized to quarter-note grid (0.0, 0.5, 1.0, 1.5)
    assert [round(n.onset_sec, 4) for n in score.notes] == [0.0, 0.5, 1.0, 1.5]
    # Performance timing remains untouched
    assert [n.raw_onset_sec for n in score.notes] == [0.037, 0.519, 1.041, 1.482]
    assert [n.raw_offset_sec for n in score.notes] == [0.462, 0.988, 1.473, 1.964]

    # Default performance MIDI export preserves expressive off-grid timings
    perf_pm = pretty_midi.PrettyMIDI(io.BytesIO(score_data_to_midi_bytes(score)))
    perf_notes = sorted(perf_pm.instruments[0].notes, key=lambda n: (n.start, n.pitch))
    assert len(perf_notes) == 4
    for raw, exported in zip(raw_notes, perf_notes):
        assert abs(exported.start - raw.onset_sec) < 0.005
        assert abs(exported.end - raw.offset_sec) < 0.005
        assert exported.velocity == raw.velocity

    # Explicit notation MIDI export uses quantized grid positions
    not_pm = pretty_midi.PrettyMIDI(io.BytesIO(score_data_to_midi_bytes(score, timing_mode="notation")))
    not_notes = sorted(not_pm.instruments[0].notes, key=lambda n: (n.start, n.pitch))
    assert [round(n.start, 2) for n in not_notes] == [0.0, 0.5, 1.0, 1.5]

    # MusicXML continues using quantized notation positions cleanly
    xml_str = score_data_to_musicxml(score)
    m21 = music21.converter.parseData(xml_str, format="musicxml")
    assert len(list(m21.recurse().notes)) >= 4


def test_legacy_score_data_without_raw_timing_fields_works_safely() -> None:
    legacy = ScoreData(
        title="Legacy Score",
        tempo_bpm=100.0,
        tracks=[ScoreTrack(index=0, name="Piano", instrument="piano", clef="grand", program=0)],
        notes=[
            ScoreNote(id="l1", pitch_midi=60, onset_sec=0.0, offset_sec=0.6, velocity=80),
            ScoreNote(id="l2", pitch_midi=64, onset_sec=0.6, offset_sec=1.2, velocity=85),
        ],
    )
    assert get_note_performance_timing(legacy.notes[0]) == (0.0, 0.6)
    assert get_note_notation_timing(legacy.notes[0]) == (0.0, 0.6)

    pm = pretty_midi.PrettyMIDI(io.BytesIO(score_data_to_midi_bytes(legacy)))
    assert len(pm.instruments[0].notes) == 2
    assert abs(pm.instruments[0].notes[1].start - 0.6) < 0.005


def test_away_in_a_manger_and_closer_reference_dual_timing() -> None:
    # 1. Away in a Manger SATB baseline (3/4, 68 BPM, 1-beat pickup)
    away_xml = """<?xml version="1.0" encoding="UTF-8"?>
    <score-partwise version="3.1">
      <part-list>
        <score-part id="P1"><part-name>Soprano</part-name></score-part>
        <score-part id="P2"><part-name>Bass</part-name></score-part>
      </part-list>
      <part id="P1">
        <measure number="0" implicit="yes">
          <attributes><divisions>1</divisions><time><beats>3</beats><beat-type>4</beat-type></time></attributes>
          <direction><sound tempo="68"/></direction>
          <note><pitch><step>C</step><octave>5</octave></pitch><duration>1</duration><type>quarter</type></note>
        </measure>
        <measure number="1">
          <note><pitch><step>F</step><octave>5</octave></pitch><duration>3</duration><type>half</type><dot/></note>
        </measure>
      </part>
      <part id="P2">
        <measure number="0" implicit="yes">
          <attributes><divisions>1</divisions><time><beats>3</beats><beat-type>4</beat-type></time></attributes>
          <note><pitch><step>F</step><octave>3</octave></pitch><duration>1</duration><type>quarter</type></note>
        </measure>
        <measure number="1">
          <note><pitch><step>F</step><octave>3</octave></pitch><duration>3</duration><type>half</type><dot/></note>
        </measure>
      </part>
    </score-partwise>"""
    away_score, *_ = musicxml_to_satb_score_data(away_xml, tempo_bpm=68.0)
    assert all(n.raw_onset_sec == n.onset_sec for n in away_score.notes)
    away_pm = pretty_midi.PrettyMIDI(io.BytesIO(score_data_to_midi_bytes(away_score)))
    assert sum(len(inst.notes) for inst in away_pm.instruments) == len(away_score.notes)

    # 2. Closer reference MIDI expressive timing survives into performance MIDI export
    closer_midi = Path(__file__).resolve().parents[2] / "assets" / "midi" / "Closer Gehlee.mid"
    if closer_midi.exists():
        ref = load_reference_midi(closer_midi)
        closer_score = build_score_data(
            title="Closer Gehlee",
            detected_notes=ref.notes[:120],
            tempo_bpm=ref.tempo_bpm,
            tempo_estimated=False,
            time_signature=ref.time_signature,
            time_signature_estimated=False,
            key_signature="E major",
            key_signature_estimated=False,
            duration_seconds=ref.duration_sec,
            instrument="piano",
            quantization="sixteenth",
        )
        exported_pm = pretty_midi.PrettyMIDI(io.BytesIO(score_data_to_midi_bytes(closer_score)))
        exp_notes = sorted(exported_pm.instruments[0].notes, key=lambda n: (n.start, n.pitch))
        assert len(exp_notes) == 120
        # Performance MIDI matches raw_onset_sec closely
        max_err = max(abs(e.start - (n.raw_onset_sec or 0.0)) for e, n in zip(exp_notes, closer_score.notes))
        assert max_err < 0.01
