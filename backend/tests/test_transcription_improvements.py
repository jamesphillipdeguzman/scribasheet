"""Regression tests for audio preprocessing, note refinement, tempo, chords, MusicXML, and PDF."""

from __future__ import annotations

import io
import xml.etree.ElementTree as ET
from collections import defaultdict
from pathlib import Path

import music21
import numpy as np
import pretty_midi
import soundfile as sf

from app.audio.processor import preprocess_to_wav
from app.notation.analyzer import detect_chords, estimate_tempo, quantize_seconds
from app.notation.generator import (
    build_score_data,
    render_score_pdf,
    score_data_to_midi_bytes,
    score_data_to_musicxml,
)
from app.schemas.score import ScoreNote
from app.transcription.base import DetectedNote
from app.transcription.note_refiner import NoteRefinerConfig, refine_detected_notes


def _write_wav(path: Path, samples: np.ndarray, sr: int = 44100) -> None:
    sf.write(str(path), samples.astype(np.float32), sr, subtype="PCM_16")


def _check_musicxml_per_voice_ticks(xml_str: str) -> tuple[int, int]:
    root = ET.fromstring(xml_str)
    overflows = 0
    underflows = 0
    for part in root.findall("part"):
        divisions = 1
        beats = 4
        beat_type = 4
        for m in part.findall("measure"):
            attrs = m.find("attributes")
            if attrs is not None:
                div_el = attrs.find("divisions")
                if div_el is not None and div_el.text:
                    divisions = int(div_el.text)
                time_el = attrs.find("time")
                if time_el is not None:
                    b_el = time_el.find("beats")
                    bt_el = time_el.find("beat-type")
                    if b_el is not None and b_el.text:
                        beats = int(b_el.text)
                    if bt_el is not None and bt_el.text:
                        beat_type = int(bt_el.text)
            expected_ticks = int(round(divisions * beats * (4.0 / beat_type)))
            voice_ticks: dict[str, int] = defaultdict(int)
            for child in m:
                if child.tag == "note" and child.find("chord") is None and child.find("grace") is None:
                    dur_el = child.find("duration")
                    dur = int(dur_el.text) if dur_el is not None and dur_el.text else 0
                    v_el = child.find("voice")
                    v_id = v_el.text.strip() if v_el is not None and v_el.text else "1"
                    voice_ticks[v_id] += dur
            for total in voice_ticks.values():
                if total > expected_ticks:
                    overflows += 1
                elif total < expected_ticks:
                    underflows += 1
    return overflows, underflows


def test_preprocess_to_wav_highpass_and_peak_norm(tmp_path: Path) -> None:
    sr = 44100
    t = np.arange(int(2.0 * sr), dtype=np.float32) / sr
    # Mix 10 Hz sub-bass rumble (0.5) + 440 Hz musical tone (0.2)
    sig = 0.5 * np.sin(2.0 * np.pi * 10.0 * t) + 0.2 * np.sin(2.0 * np.pi * 440.0 * t)
    src = tmp_path / "input.wav"
    out = tmp_path / "out.wav"
    _write_wav(src, sig, sr=sr)

    meta = preprocess_to_wav(src, out, target_sr=22050)
    assert meta.sample_rate == 22050
    assert meta.channels == 1
    assert abs(meta.duration_seconds - 2.0) < 0.02

    y, out_sr = sf.read(str(out), dtype="float32")
    assert out_sr == 22050
    peak = float(np.max(np.abs(y)))
    # -1 dBFS target ~ 0.891
    assert 0.85 <= peak <= 0.92


def test_note_refiner_preserves_raw_and_cleans_artifacts() -> None:
    raw = [
        # Fundamental F3 + octave harmonic ghost F4 (weaker, no melodic neighbors)
        DetectedNote(pitch_midi=53, onset_sec=0.50, offset_sec=1.30, velocity=85, confidence=0.82),
        DetectedNote(pitch_midi=65, onset_sec=0.51, offset_sec=1.10, velocity=55, confidence=0.42),
        # Rapid same-pitch re-attack sustain tail (gap 20ms, short weak tail) -> should merge
        DetectedNote(pitch_midi=60, onset_sec=1.50, offset_sec=1.90, velocity=78, confidence=0.75),
        DetectedNote(pitch_midi=60, onset_sec=1.92, offset_sec=2.01, velocity=48, confidence=0.35),
        # Ultra-short low-confidence blip -> should drop
        DetectedNote(pitch_midi=72, onset_sec=2.50, offset_sec=2.53, velocity=50, confidence=0.30),
        # High-confidence short staccato note -> should keep
        DetectedNote(pitch_midi=69, onset_sec=3.00, offset_sec=3.045, velocity=92, confidence=0.85),
    ]
    res = refine_detected_notes(raw, NoteRefinerConfig())
    assert len(res.raw_notes) == 6
    assert res.stats["octave_ghosts_suppressed"] == 1
    assert res.stats["reattack_merges"] == 1
    assert res.stats["filtered_short_or_low_conf"] == 1
    pitches = [n.pitch_midi for n in res.notes]
    assert pitches == [53, 60, 69]
    # Merged C4 should extend to 2.01s
    c4 = next(n for n in res.notes if n.pitch_midi == 60)
    assert abs(c4.offset_sec - 2.01) < 1e-4


def test_tempo_estimation_resolves_calm_75bpm_vs_fast_150bpm(tmp_path: Path) -> None:
    sr = 22050
    dur = 8.0
    n_samples = int(dur * sr)
    # 75 BPM = 0.8s per beat; strong downbeat every 0.8s, weaker 8th-note subdivision at +0.4s
    y_75 = np.zeros(n_samples, dtype=np.float32)
    t_click = np.arange(int(0.18 * sr), dtype=np.float32) / sr
    env = np.exp(-t_click * 18.0)
    tone = np.sin(2.0 * np.pi * 349.23 * t_click) * env
    for idx in range(int(dur / 0.4)):
        start = int(idx * 0.4 * sr)
        amp = 0.85 if idx % 2 == 0 else 0.30
        end = min(n_samples, start + len(tone))
        y_75[start:end] += amp * tone[: end - start]

    wav_75 = tmp_path / "pulse_75.wav"
    _write_wav(wav_75, y_75, sr=sr)
    bpm_75, est = estimate_tempo(wav_75)
    assert est is True
    assert 68.0 <= bpm_75 <= 82.0, f"Expected ~75 BPM, got {bpm_75}"


def test_detect_chords_weighted_and_valid_beats() -> None:
    # 4/4 at 120 BPM (0.5s/beat, 2.0s/measure): F major in m1, C major in m2
    notes = [
        ScoreNote(id="1", pitch_midi=53, onset_sec=0.0, offset_sec=1.8, velocity=90),
        ScoreNote(id="2", pitch_midi=65, onset_sec=0.0, offset_sec=1.8, velocity=85),
        ScoreNote(id="3", pitch_midi=69, onset_sec=0.0, offset_sec=1.8, velocity=85),
        ScoreNote(id="4", pitch_midi=72, onset_sec=0.0, offset_sec=1.8, velocity=80),
        # Short passing glitch
        ScoreNote(id="5", pitch_midi=66, onset_sec=0.5, offset_sec=0.54, velocity=40),
        ScoreNote(id="6", pitch_midi=48, onset_sec=2.0, offset_sec=3.8, velocity=90),
        ScoreNote(id="7", pitch_midi=64, onset_sec=2.0, offset_sec=3.8, velocity=85),
        ScoreNote(id="8", pitch_midi=67, onset_sec=2.0, offset_sec=3.8, velocity=85),
    ]
    chords = detect_chords(notes, tempo_bpm=120.0, time_signature="4/4")
    assert len(chords) >= 2
    assert chords[0].symbol == "F"
    assert chords[1].symbol == "C"
    for ch in chords:
        assert 1.0 <= ch.beat <= 4.0


def test_musicxml_polyphonic_per_voice_integrity_and_pdf() -> None:
    # Overlapping notes across measure boundary in both hands (75 BPM, 4/4 -> 3.2s/measure)
    detected = [
        DetectedNote(pitch_midi=41, onset_sec=0.0, offset_sec=3.6, velocity=80, confidence=0.9),
        DetectedNote(pitch_midi=53, onset_sec=1.6, offset_sec=3.2, velocity=70, confidence=0.85),
        DetectedNote(pitch_midi=69, onset_sec=0.0, offset_sec=1.6, velocity=90, confidence=0.9),
        DetectedNote(pitch_midi=72, onset_sec=0.8, offset_sec=2.4, velocity=88, confidence=0.88),
        DetectedNote(pitch_midi=86, onset_sec=3.2, offset_sec=4.8, velocity=95, confidence=0.92),
    ]
    score = build_score_data(
        title="Polyphony Test",
        detected_notes=detected,
        tempo_bpm=75.0,
        tempo_estimated=True,
        time_signature="4/4",
        time_signature_estimated=True,
        key_signature="F",
        key_signature_estimated=True,
        duration_seconds=5.0,
        instrument="piano",
        quantization="sixteenth",
    )

    xml_str = score_data_to_musicxml(score)
    parsed = music21.converter.parseData(xml_str, format="musicxml")
    assert len(list(parsed.parts)) == 2
    overflows, underflows = _check_musicxml_per_voice_ticks(xml_str)
    assert overflows == 0
    assert underflows == 0

    midi_bytes = score_data_to_midi_bytes(score)
    pm = pretty_midi.PrettyMIDI(io.BytesIO(midi_bytes))
    assert sum(len(inst.notes) for inst in pm.instruments) == len(detected)

    pdf_bytes = render_score_pdf(score)
    assert pdf_bytes.startswith(b"%PDF-")
    assert len(pdf_bytes) > 1000


def test_quantize_seconds_supports_triplet_and_strength() -> None:
    # 60 BPM -> 1 beat = 1.0s
    assert quantize_seconds(0.31, 60.0, "eighth_triplet", strength=1.0) == round(1.0 / 3.0, 4)
    assert quantize_seconds(0.31, 60.0, "quarter", strength=0.0) == 0.31


def test_reattack_preserves_pedaled_repeated_notes_and_merges_jitter() -> None:
    raw = [
        # Legato/pedaled repeated Bb2 eighth/quarter notes (gap=0.0, onset_diff=0.40s) -> must stay separate
        DetectedNote(pitch_midi=46, onset_sec=0.50, offset_sec=0.92, velocity=82, confidence=0.75),
        DetectedNote(pitch_midi=46, onset_sec=0.90, offset_sec=1.30, velocity=78, confidence=0.68),
        DetectedNote(pitch_midi=46, onset_sec=1.30, offset_sec=1.75, velocity=80, confidence=0.70),
        # Rapid onset jitter (<110ms) -> should merge
        DetectedNote(pitch_midi=60, onset_sec=2.00, offset_sec=2.08, velocity=74, confidence=0.65),
        DetectedNote(pitch_midi=60, onset_sec=2.08, offset_sec=2.60, velocity=70, confidence=0.60),
    ]
    res = refine_detected_notes(raw, NoteRefinerConfig())
    assert len(res.raw_notes) == 5
    bb2_notes = [n for n in res.notes if n.pitch_midi == 46]
    c4_notes = [n for n in res.notes if n.pitch_midi == 60]
    assert len(bb2_notes) == 3
    assert len(c4_notes) == 1
    # Overlapping first Bb2 trimmed cleanly before second onset without becoming invalid
    assert bb2_notes[0].offset_sec > bb2_notes[0].onset_sec
    assert bb2_notes[0].offset_sec <= bb2_notes[1].onset_sec
    assert res.stats["reattack_retained"] == 2
    assert res.stats["reattack_merges"] == 1


def test_midi_and_musicxml_preserve_identical_note_counts_under_polyphony() -> None:
    # 5 overlapping notes in RH (including duplicate pitch+quantized interval)
    detected = [
        DetectedNote(pitch_midi=65, onset_sec=0.0, offset_sec=1.6, velocity=80, confidence=0.9),
        DetectedNote(pitch_midi=69, onset_sec=0.0, offset_sec=0.8, velocity=85, confidence=0.9),
        DetectedNote(pitch_midi=69, onset_sec=0.01, offset_sec=0.81, velocity=82, confidence=0.85),
        DetectedNote(pitch_midi=72, onset_sec=0.0, offset_sec=1.2, velocity=84, confidence=0.88),
        DetectedNote(pitch_midi=77, onset_sec=0.0, offset_sec=0.4, velocity=90, confidence=0.92),
        DetectedNote(pitch_midi=53, onset_sec=0.0, offset_sec=1.6, velocity=80, confidence=0.9),
    ]
    score = build_score_data(
        title="Parity Test",
        detected_notes=detected,
        tempo_bpm=75.0,
        tempo_estimated=True,
        time_signature="4/4",
        time_signature_estimated=True,
        key_signature="F",
        key_signature_estimated=True,
        duration_seconds=2.0,
        instrument="piano",
        quantization="sixteenth",
    )
    midi_bytes = score_data_to_midi_bytes(score)
    pm = pretty_midi.PrettyMIDI(io.BytesIO(midi_bytes))
    midi_pitches = sorted(n.pitch for inst in pm.instruments for n in inst.notes)

    xml_str = score_data_to_musicxml(score)
    parsed = music21.converter.parseData(xml_str, format="musicxml")
    xml_pitches: list[int] = []
    for part in parsed.parts:
        for el in part.recurse().notes:
            if el.tie and el.tie.type in ("continue", "stop"):
                continue
            if isinstance(el, music21.note.Note):
                xml_pitches.append(el.pitch.midi)
            elif isinstance(el, music21.chord.Chord):
                xml_pitches.extend(p.midi for p in el.pitches)
    xml_pitches.sort()

    assert midi_pitches == xml_pitches
    overflows, underflows = _check_musicxml_per_voice_ticks(xml_str)
    assert overflows == 0
    assert underflows == 0


def test_evaluator_tempo_parity_and_provenance(tmp_path: Path, monkeypatch) -> None:
    import importlib.util

    eval_path = Path(__file__).resolve().parents[2] / "scripts" / "evaluate_transcription.py"
    spec = importlib.util.spec_from_file_location("evaluate_transcription", eval_path)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    sr = 22050
    t = np.arange(int(1.5 * sr), dtype=np.float32) / sr
    sig = 0.4 * np.sin(2.0 * np.pi * 440.0 * t)
    wav_path = tmp_path / "sample.wav"
    _write_wav(wav_path, sig, sr=sr)
    out_json = tmp_path / "report.json"

    captured_kwargs: dict = {}

    def fake_estimate_tempo(path, tempo_mode="auto", manual_tempo_bpm=None, notes=None):
        captured_kwargs["tempo_mode"] = tempo_mode
        captured_kwargs["manual_tempo_bpm"] = manual_tempo_bpm
        captured_kwargs["notes"] = notes
        return 90.0, True

    from app.transcription.basic_pitch_provider import BasicPitchProvider

    monkeypatch.setattr(mod, "estimate_tempo", fake_estimate_tempo)
    monkeypatch.setattr(
        BasicPitchProvider,
        "transcribe",
        lambda self, *a, **kw: type(
            "Tx",
            (),
            {
                "engine": "basic_pitch",
                "notes": [DetectedNote(pitch_midi=69, onset_sec=0.1, offset_sec=0.6, velocity=80, confidence=0.8)],
                "metadata": {"provider": "CPUExecutionProvider"},
            },
        )(),
    )
    monkeypatch.setattr(
        "sys.argv",
        [
            "evaluate_transcription.py",
            "--audio",
            str(wav_path),
            "--expected-bpm",
            "123",
            "--expected-key",
            "A",
            "--output",
            str(out_json),
        ],
    )
    rc = mod.main()
    assert rc == 0
    assert captured_kwargs["notes"] is not None and len(captured_kwargs["notes"]) == 1
    assert captured_kwargs["manual_tempo_bpm"] is None

    import json as _json

    report = _json.loads(out_json.read_text(encoding="utf-8"))
    prov = report["provenance"]
    for key in (
        "wav_sha256",
        "git_commit_sha",
        "expected_bpm",
        "expected_key",
        "expected_time_signature",
        "transcription_engine",
        "inference_provider",
        "refiner_config",
        "tempo_analysis_config",
        "source_duration_sec",
        "evaluation_timestamp",
    ):
        assert key in prov
    assert prov["tempo_analysis_config"]["uses_refined_notes"] is True
    assert report["tempo"]["estimated_bpm"] == 90.0


def test_preprocessing_profiles_and_dc_removal(tmp_path: Path) -> None:
    sr = 44100
    t = np.arange(int(1.5 * sr), dtype=np.float32) / sr
    # 55 Hz low piano/bass tone + 0.15 DC offset
    sig = 0.15 + 0.3 * np.sin(2.0 * np.pi * 55.0 * t)
    src = tmp_path / "dc_low.wav"
    out_piano = tmp_path / "piano.wav"
    out_vocal = tmp_path / "vocal.wav"
    _write_wav(src, sig, sr=sr)

    meta_p = preprocess_to_wav(src, out_piano, target_sr=22050, profile="piano")
    meta_v = preprocess_to_wav(src, out_vocal, target_sr=22050, profile="vocal")
    assert meta_p.profile == "piano"
    assert meta_v.profile == "vocal"
    y_p, _ = sf.read(str(out_piano), dtype="float32")
    assert abs(float(np.mean(y_p))) < 0.01


def test_octave_suppression_preserves_legitimate_octave_doubling() -> None:
    raw = [
        # Legitimate octave doubling (comparable confidence and duration) -> MUST keep both
        DetectedNote(pitch_midi=57, onset_sec=0.50, offset_sec=1.00, velocity=82, confidence=0.58),
        DetectedNote(pitch_midi=69, onset_sec=0.50, offset_sec=1.00, velocity=80, confidence=0.56),
        # Harmonic ghost (strong fundamental 0.72, weak overtone 0.31, shorter) -> MUST suppress upper
        DetectedNote(pitch_midi=53, onset_sec=1.50, offset_sec=2.00, velocity=90, confidence=0.72),
        DetectedNote(pitch_midi=77, onset_sec=1.51, offset_sec=1.75, velocity=50, confidence=0.31),
    ]
    res = refine_detected_notes(raw, NoteRefinerConfig())
    pitches = [n.pitch_midi for n in res.notes]
    assert 57 in pitches and 69 in pitches
    assert 53 in pitches and 77 not in pitches
    assert res.stats["octave_ghosts_suppressed"] == 1


def test_key_formatting_tempo_diagnostics_and_versioning(tmp_path: Path) -> None:
    from app.notation.analyzer import estimate_key_signature, estimate_tempo_with_diagnostics
    from app.notation.generator import _parse_key_to_music21
    from app.transcription.versioning import (
        PIPELINE_VERSION,
        build_transcription_provenance,
        compute_config_hash,
    )

    f_major_notes = [
        DetectedNote(pitch_midi=53, onset_sec=0.0, offset_sec=1.0, velocity=80, confidence=0.8),
        DetectedNote(pitch_midi=57, onset_sec=0.0, offset_sec=1.0, velocity=80, confidence=0.8),
        DetectedNote(pitch_midi=60, onset_sec=0.0, offset_sec=1.0, velocity=80, confidence=0.8),
        DetectedNote(pitch_midi=65, onset_sec=1.0, offset_sec=2.0, velocity=80, confidence=0.8),
    ]
    key_str, est = estimate_key_signature(f_major_notes)
    assert est is True
    assert key_str.endswith(" major") or key_str.endswith(" minor")
    m21_k = _parse_key_to_music21("F major")
    assert m21_k.tonic.name == "F" and m21_k.mode == "major"

    wav = tmp_path / "t.wav"
    _write_wav(wav, np.zeros(22050, dtype=np.float32), sr=22050)
    diag = estimate_tempo_with_diagnostics(wav, tempo_mode="manual", manual_tempo_bpm=75.0)
    assert diag["tempo_bpm"] == 75.0
    assert diag["ambiguous"] is False
    assert len(diag["candidates"]) == 1

    cfg1 = NoteRefinerConfig()
    cfg2 = NoteRefinerConfig(min_duration_sec=0.08)
    assert compute_config_hash(cfg1) != compute_config_hash(cfg2)
    prov = build_transcription_provenance(
        source_audio_path=wav, preprocessing_config={"profile": "piano"}, refiner_config=cfg1
    )
    assert prov["pipeline_version"] == PIPELINE_VERSION
    assert len(prov["source_audio_sha256"]) == 64
