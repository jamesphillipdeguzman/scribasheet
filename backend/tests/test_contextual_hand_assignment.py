from pathlib import Path

from app.notation.evaluation import load_reference_midi
from app.notation.generator import build_score_data, score_data_to_midi_bytes, score_data_to_musicxml
from app.notation.hand_assignment import assign_hands_contextual
from app.schemas.score import ScoreNote


def _note(nid: str, pitch: int, onset: float, offset: float | None = None) -> ScoreNote:
    return ScoreNote(
        id=nid,
        pitch_midi=pitch,
        onset_sec=onset,
        offset_sec=offset if offset is not None else onset + 0.25,
        raw_onset_sec=onset,
        raw_offset_sec=offset if offset is not None else onset + 0.25,
        velocity=80,
    )


def test_overlapping_registers_keep_lh_arpeggio_and_low_rh_melody_coherent() -> None:
    # 1. LH ascending Alberti/arpeggio starting at C3 (48) -> G3 (55) -> C4 (60) -> E4 (64)
    # Previously, notes >= 57 (A3) would jump to RH mid-arpeggio.
    lh_arp = [
        _note("a1", 48, 0.00),
        _note("a2", 55, 0.20),
        _note("a3", 60, 0.40),
        _note("a4", 64, 0.60),
        _note("a5", 60, 0.80),
        _note("a6", 55, 1.00),
    ]
    rh, lh = assign_hands_contextual(lh_arp)
    assert [n.id for n in lh] == ["a1", "a2", "a3", "a4", "a5", "a6"]
    assert rh == []

    # 2. RH descending melody starting at C5 (72) -> G4 (67) -> E4 (64) -> C4 (60) -> G3 (55) -> E3 (52)
    # Previously, <= 52 (E3) would jump to LH mid-phrase.
    rh_desc = [
        _note("r1", 72, 0.00),
        _note("r2", 67, 0.25),
        _note("r3", 64, 0.50),
        _note("r4", 60, 0.75),
        _note("r5", 55, 1.00),
        _note("r6", 52, 1.25),
    ]
    rh2, lh2 = assign_hands_contextual(rh_desc)
    assert [n.id for n in rh2] == ["r1", "r2", "r3", "r4", "r5", "r6"]
    assert lh2 == []


def test_hand_crossing_preserves_trajectories_without_flipping_identities() -> None:
    # RH plays a steady lower-middle melody (E4 -> D4 -> C4 -> D4 -> E4) while
    # LH alternates bass and crossed-over treble notes, then returns to bass C3 (48)
    notes = [
        _note("lh0", 48, 0.00, 0.35),
        _note("rh0", 64, 0.00, 0.35),
        _note("lh1", 52, 0.40, 0.70),
        _note("rh1", 62, 0.40, 0.70),
        # Crossing: RH steps down to C4 (60) while LH plays bass-range -> crossed-over note
        _note("rh2", 55, 0.75, 1.05),
        _note("lh2", 72, 0.75, 1.05),
        # Return
        _note("lh3", 48, 1.10, 1.50),
        _note("rh3", 64, 1.10, 1.50),
    ]
    rh, lh = assign_hands_contextual(notes)
    assert len(rh) + len(lh) == len(notes)
    # Deterministic
    rh_again, lh_again = assign_hands_contextual(notes)
    assert [n.id for n in rh] == [n.id for n in rh_again]
    assert [n.id for n in lh] == [n.id for n in lh_again]
    # Bass anchor notes remain in LH and melody return stays in RH
    lh_ids = {n.id for n in lh}
    rh_ids = {n.id for n in rh}
    assert "lh0" in lh_ids and "lh3" in lh_ids
    assert "rh0" in rh_ids and "rh3" in rh_ids


def test_chord_grouping_and_bass_preservation() -> None:
    # Simultaneous F2 (41) bass + F4-A4-C5 (65, 69, 72) RH triad
    notes = [
        _note("b1", 41, 0.0, 1.0),
        _note("t1", 65, 0.0, 1.0),
        _note("t2", 69, 0.0, 1.0),
        _note("t3", 72, 0.0, 1.0),
    ]
    rh, lh = assign_hands_contextual(notes)
    assert [n.id for n in lh] == ["b1"]
    assert [n.id for n in rh] == ["t1", "t2", "t3"]


def test_closer_reference_midi_grand_staff_musicxml_and_midi_parity() -> None:
    closer_midi = Path(__file__).resolve().parents[2] / "assets" / "midi" / "Closer Gehlee.mid"
    if not closer_midi.exists():
        return
    ref = load_reference_midi(closer_midi)
    score = build_score_data(
        title="Closer Contextual Hands",
        detected_notes=ref.notes[:180],
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
    rh, lh = assign_hands_contextual(score.notes)
    assert len(rh) > 0 and len(lh) > 0
    assert len(rh) + len(lh) == len(score.notes)
    # Original note pitches & raw performance timing untouched
    xml_str = score_data_to_musicxml(score)
    assert "<score-partwise" in xml_str
    midi_bytes = score_data_to_midi_bytes(score)
    assert midi_bytes.startswith(b"MThd")
