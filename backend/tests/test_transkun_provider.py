"""Unit tests for TranskunProvider, provider_factory, fallback policy, and downstream parity."""

from __future__ import annotations

import builtins
import io
from pathlib import Path
from types import SimpleNamespace

import music21
import numpy as np
import pretty_midi
import pytest
import soundfile as sf

from app.notation.generator import (
    build_score_data,
    score_data_to_midi_bytes,
    score_data_to_musicxml,
)
from app.transcription.base import DetectedNote, TranscriptionOutput, TranscriptionProvider
from app.transcription.basic_pitch_provider import TranscriptionInferenceError
from app.transcription.note_refiner import refine_detected_notes
from app.transcription.provider_factory import (
    DEFAULT_ENGINE,
    get_transcription_provider,
    resolve_requested_engine,
    transcribe_with_provider,
)
from app.transcription.transkun_provider import TranskunProvider, resolve_transkun_paths


def _write_wav(path: Path, samples: np.ndarray, sr: int = 44100) -> None:
    sf.write(str(path), samples.astype(np.float32), sr, subtype="PCM_16")


def _attach_mock_transkun(provider: TranskunProvider, events: list[SimpleNamespace], fs: int = 44100) -> None:
    class _FakeTorch:
        @staticmethod
        def from_numpy(arr):
            class _T:
                def to(self, _dev):
                    return arr

            return _T()

        @staticmethod
        def no_grad():
            class _Ctx:
                def __enter__(self):
                    return None

                def __exit__(self, *args):
                    return False

            return _Ctx()

    class _FakeModel:
        def __init__(self) -> None:
            self.fs = fs

        def transcribe(self, x, **kwargs):
            return list(events)

    provider._torch = _FakeTorch()
    provider._model = _FakeModel()
    provider._resolved_weight = Path("mock_2.0.pt")
    provider._resolved_conf = Path("mock_2.0.conf")
    provider._checkpoint_sha256 = "MOCKSHA256"


def test_transkun_provider_init_and_default_engine(monkeypatch) -> None:
    monkeypatch.delenv("TRANSCRIPTION_ENGINE", raising=False)
    assert DEFAULT_ENGINE == "basic_pitch"
    assert resolve_requested_engine() == "basic_pitch"
    assert resolve_requested_engine("transkun") == "transkun"

    p = TranskunProvider(device="cpu", num_threads=2)
    assert p.name == "transkun"
    assert p.device == "cpu"
    assert p.num_threads == 2
    assert p._model is None  # lazy loading: not loaded on init


def test_missing_model_checkpoint_raises_model_not_found(tmp_path: Path) -> None:
    with pytest.raises(TranscriptionInferenceError) as exc_info:
        resolve_transkun_paths(
            weight_path=tmp_path / "missing.pt",
            conf_path=tmp_path / "missing.conf",
        )
    assert exc_info.value.code == "MODEL_NOT_FOUND"


def test_missing_dependency_raises_clear_error(monkeypatch) -> None:
    p = TranskunProvider()
    real_import = builtins.__import__

    def fake_import(name, *args, **kwargs):
        if name == "moduleconf":
            raise ImportError("No module named 'moduleconf'", name="moduleconf")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", fake_import)
    with pytest.raises(TranscriptionInferenceError) as exc_info:
        p._ensure_loaded()
    assert exc_info.value.code == "DEPENDENCY_MISSING"


def test_cpu_only_config_and_invalid_wav_validation(tmp_path: Path) -> None:
    p = TranskunProvider(device="cpu", num_threads=4)
    assert p.device == "cpu"
    with pytest.raises(TranscriptionInferenceError) as exc_info:
        p.transcribe(tmp_path / "does_not_exist.wav")
    assert exc_info.value.code == "INVALID_AUDIO_INPUT"


def test_valid_note_conversion_midi_and_metadata(tmp_path: Path) -> None:
    wav = tmp_path / "piano.wav"
    _write_wav(wav, np.zeros(44100 * 2, dtype=np.float32), sr=44100)

    p = TranskunProvider(device="cpu")
    _attach_mock_transkun(
        p,
        [
            SimpleNamespace(start=0.10, end=0.80, pitch=53, velocity=72),
            SimpleNamespace(start=0.12, end=0.82, pitch=69, velocity=84),
            SimpleNamespace(start=0.90, end=1.40, pitch=72, velocity=78),
        ],
    )
    out = p.transcribe(wav, min_note_length_ms=50.0, min_midi_pitch=21, max_midi_pitch=108)
    assert out.engine == "transkun"
    assert len(out.notes) == 3
    assert all(n.confidence is None for n in out.notes)
    assert out.metadata["model"] == "transkun-2.0"
    assert out.metadata["device"] == "cpu"
    assert out.metadata["checkpoint_sha256"] == "MOCKSHA256"

    pm = pretty_midi.PrettyMIDI(io.BytesIO(out.midi_bytes))
    midi_pitches = sorted(n.pitch for inst in pm.instruments for n in inst.notes)
    assert midi_pitches == [53, 69, 72]


def test_empty_inference_and_invalid_intervals_filtered(tmp_path: Path) -> None:
    wav = tmp_path / "empty.wav"
    _write_wav(wav, np.zeros(44100, dtype=np.float32), sr=44100)

    p = TranskunProvider(device="cpu")
    _attach_mock_transkun(
        p,
        [
            SimpleNamespace(start=0.50, end=0.40, pitch=60, velocity=80),  # negative dur
            SimpleNamespace(start=0.60, end=0.62, pitch=62, velocity=80),  # < min_note_length_ms
            SimpleNamespace(start=-0.10, end=0.20, pitch=64, velocity=80),  # negative start
        ],
    )
    out = p.transcribe(wav, min_note_length_ms=58.0)
    assert out.notes == []

    _attach_mock_transkun(p, [])
    out_empty = p.transcribe(wav)
    assert out_empty.notes == []


def test_inference_failure_raises_error_and_respects_fallback_policy(tmp_path: Path) -> None:
    wav = tmp_path / "test.wav"
    _write_wav(wav, np.zeros(22050, dtype=np.float32), sr=22050)

    class _FailingTranskun(TranscriptionProvider):
        name = "transkun"

        def transcribe(self, wav_path: Path, **kwargs) -> TranscriptionOutput:
            raise TranscriptionInferenceError("MODEL_NOT_FOUND", "Checkpoint missing")

    class _FakeBasicPitch(TranscriptionProvider):
        name = "basic_pitch"

        def transcribe(self, wav_path: Path, **kwargs) -> TranscriptionOutput:
            return TranscriptionOutput(
                engine="basic_pitch",
                notes=[DetectedNote(pitch_midi=60, onset_sec=0.1, offset_sec=0.6, velocity=80, confidence=0.8)],
                midi_bytes=b"MThd",
                duration_seconds=1.0,
                metadata={"model": "nmp.onnx"},
            )

    # Fallback disabled -> must fail cleanly, never silently fall back
    with pytest.raises(TranscriptionInferenceError) as exc_info:
        transcribe_with_provider(
            wav,
            engine="transkun",
            allow_fallback=False,
            provider=_FailingTranskun(),
            fallback_provider=_FakeBasicPitch(),
        )
    assert exc_info.value.code == "MODEL_NOT_FOUND"

    # Fallback explicitly enabled -> runs Basic Pitch and records fallback metadata
    res = transcribe_with_provider(
        wav,
        engine="transkun",
        allow_fallback=True,
        provider=_FailingTranskun(),
        fallback_provider=_FakeBasicPitch(),
    )
    assert res.requested_engine == "transkun"
    assert res.actual_engine == "basic_pitch"
    assert res.fallback_used is True
    assert res.primary_error_code == "MODEL_NOT_FOUND"
    assert "MODEL_NOT_FOUND" in (res.fallback_reason or "")


def test_transkun_refiner_compatibility_and_midi_musicxml_parity() -> None:
    # Transkun notes have confidence=None and expressive velocities
    raw_transkun_notes = [
        DetectedNote(pitch_midi=41, onset_sec=0.00, offset_sec=1.60, velocity=55, confidence=None),
        DetectedNote(pitch_midi=53, onset_sec=0.40, offset_sec=1.20, velocity=62, confidence=None),
        DetectedNote(pitch_midi=69, onset_sec=0.00, offset_sec=0.80, velocity=74, confidence=None),
        DetectedNote(pitch_midi=69, onset_sec=0.80, offset_sec=1.60, velocity=70, confidence=None),
    ]
    ref = refine_detected_notes(raw_transkun_notes)
    assert len(ref.notes) == 4
    # Expressive velocities preserved (sorted by onset_sec, pitch_midi) when confidence=None
    assert [n.velocity for n in ref.notes] == [55, 74, 62, 70]

    score = build_score_data(
        title="Transkun Parity",
        detected_notes=ref.notes,
        tempo_bpm=75.0,
        tempo_estimated=True,
        time_signature="4/4",
        time_signature_estimated=True,
        key_signature="F major",
        key_signature_estimated=True,
        duration_seconds=2.0,
        instrument="piano",
        quantization="sixteenth",
    )
    pm = pretty_midi.PrettyMIDI(io.BytesIO(score_data_to_midi_bytes(score)))
    midi_pitches = sorted(n.pitch for inst in pm.instruments for n in inst.notes)

    xml_str = score_data_to_musicxml(score)
    m21 = music21.converter.parseData(xml_str, format="musicxml")
    xml_pitches = []
    for part in m21.parts:
        for el in part.recurse().notes:
            if el.tie and el.tie.type in ("continue", "stop"):
                continue
            if isinstance(el, music21.note.Note):
                xml_pitches.append(el.pitch.midi)
            elif isinstance(el, music21.chord.Chord) and not isinstance(el, music21.harmony.ChordSymbol):
                xml_pitches.extend(p.midi for p in el.pitches)
    xml_pitches.sort()
    assert midi_pitches == xml_pitches


def test_provider_factory_returns_expected_classes() -> None:
    assert get_transcription_provider("basic_pitch").name == "basic_pitch"
    assert get_transcription_provider("transkun").name == "transkun"
    with pytest.raises(TranscriptionInferenceError) as exc_info:
        get_transcription_provider("unknown_engine")
    assert exc_info.value.code == "UNSUPPORTED_ENGINE"


def test_transkun_velocity_duration_and_note_off_survive_midi_and_wav_export() -> None:
    import mido

    from app.notation.generator import render_score_wav

    detected = [
        DetectedNote(pitch_midi=53, onset_sec=0.00, offset_sec=0.80, velocity=42, confidence=None),
        DetectedNote(pitch_midi=53, onset_sec=0.80, offset_sec=1.60, velocity=78, confidence=None),
        DetectedNote(pitch_midi=69, onset_sec=0.00, offset_sec=1.20, velocity=64, confidence=None),
        DetectedNote(pitch_midi=72, onset_sec=1.20, offset_sec=2.40, velocity=88, confidence=None),
    ]
    refined = refine_detected_notes(detected).notes
    assert len(refined) == 4
    assert [n.velocity for n in refined] == [42, 64, 78, 88]

    score = build_score_data(
        title="Velocity & Duration Preservation",
        detected_notes=refined,
        tempo_bpm=75.0,
        tempo_estimated=True,
        time_signature="4/4",
        time_signature_estimated=True,
        key_signature="F major",
        key_signature_estimated=True,
        duration_seconds=2.5,
        instrument="piano",
        quantization="sixteenth",
    )
    midi_bytes = score_data_to_midi_bytes(score)
    pm = pretty_midi.PrettyMIDI(io.BytesIO(midi_bytes))
    pm_notes = sorted(
        (n.pitch, round(n.start, 3), round(n.end - n.start, 3), n.velocity)
        for inst in pm.instruments
        for n in inst.notes
    )
    assert len(pm_notes) == 4
    assert sorted(n[3] for n in pm_notes) == [42, 64, 78, 88]
    # Repeated F3 (53) notes remain two separate note_on / note_off pairs
    f3_notes = [n for n in pm_notes if n[0] == 53]
    assert len(f3_notes) == 2
    assert f3_notes[0][2] >= 0.75
    assert f3_notes[1][2] >= 0.75

    mf = mido.MidiFile(file=io.BytesIO(midi_bytes))
    on_msgs = [m for tr in mf.tracks for m in tr if m.type == "note_on" and m.velocity > 0]
    off_msgs = [m for tr in mf.tracks for m in tr if m.type == "note_off" or (m.type == "note_on" and m.velocity == 0)]
    assert len(on_msgs) == 4
    assert len(off_msgs) == 4

    wav_bytes = render_score_wav(score)
    assert wav_bytes[:4] == b"RIFF"
    audio, sr = sf.read(io.BytesIO(wav_bytes), dtype="float32")
    assert sr == 22050
    assert float(np.max(np.abs(audio))) > 0.05
