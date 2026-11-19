"""Tests for optional Demucs separation, source routing, and Piano + Vocal accompaniment."""

from __future__ import annotations

import builtins
import sys
import types
import xml.etree.ElementTree as ET
from pathlib import Path

import numpy as np
import soundfile as sf

from app.audio.separator import detect_audio_source_route, separate_audio_stems
from app.models import Project, ProjectScore
from app.notation.accompaniment import generate_piano_accompaniment
from app.notation.generator import (
    build_piano_vocal_score_data,
    score_data_to_midi_bytes,
    score_data_to_musicxml,
)
from app.schemas.score import ScoreChord
from app.transcription.base import DetectedNote


def _write_test_wav(path: Path, freq_hz: float = 440.0, amp: float = 0.25, dur_sec: float = 0.5, sr: int = 16000) -> None:
    t = np.linspace(0.0, dur_sec, int(sr * dur_sec), endpoint=False, dtype=np.float32)
    wave = (amp * np.sin(2.0 * np.pi * freq_hz * t)).astype(np.float32)
    path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(path), wave, sr)


def test_fastapi_startup_does_not_import_demucs_or_torch(monkeypatch):
    # Ensure importing app.main does not pull demucs into sys.modules
    monkeypatch.delitem(sys.modules, "demucs", raising=False)
    monkeypatch.delitem(sys.modules, "demucs.api", raising=False)
    monkeypatch.delitem(sys.modules, "demucs.separate", raising=False)
    import app.main  # noqa: F401

    assert "demucs" not in sys.modules
    assert "demucs.api" not in sys.modules


def test_separate_audio_stems_disabled_leaves_original_intact(tmp_path: Path):
    src = tmp_path / "song.wav"
    _write_test_wav(src)
    res = separate_audio_stems(src, tmp_path / "out", enabled=False)
    assert res.available is False
    assert res.backend == "none"
    assert res.stems == {}
    assert src.exists()


def test_separate_audio_stems_missing_demucs_returns_actionable_error(tmp_path: Path, monkeypatch):
    src = tmp_path / "song.wav"
    _write_test_wav(src)

    real_import = builtins.__import__

    def _fake_import(name, *args, **kwargs):
        if name.startswith("demucs"):
            raise ImportError("No module named 'demucs'")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", _fake_import)
    monkeypatch.setattr("app.audio.separator._find_isolated_demucs_python", lambda: None)
    res = separate_audio_stems(src, tmp_path / "out", enabled=True, cache_dir=tmp_path / "cache")
    assert res.available is False
    assert res.error_code == "DEMUCS_NOT_INSTALLED"
    assert "pip install demucs" in res.message


def test_separate_audio_stems_mocked_demucs_api_and_cache(tmp_path: Path, monkeypatch):
    src = tmp_path / "pop_song.wav"
    _write_test_wav(src)
    cache_dir = tmp_path / "demucs_cache"

    class _FakeSeparator:
        def __init__(self, model="htdemucs", device="cpu", overlap=0.25, segment=None):
            self.model = model
            self.device = device
            self.samplerate = 16000

        def separate_audio_file(self, path: str):
            samples = np.ones((2, 1600), dtype=np.float32) * 0.1
            return None, {
                "vocals": samples,
                "drums": samples * 0.2,
                "bass": samples * 0.5,
                "other": samples * 0.4,
            }

    fake_demucs = types.ModuleType("demucs")
    fake_sep_mod = types.ModuleType("demucs.separate")
    fake_api_mod = types.ModuleType("demucs.api")
    fake_api_mod.Separator = _FakeSeparator  # type: ignore[attr-defined]
    fake_demucs.separate = fake_sep_mod  # type: ignore[attr-defined]
    fake_demucs.api = fake_api_mod  # type: ignore[attr-defined]

    monkeypatch.setitem(sys.modules, "demucs", fake_demucs)
    monkeypatch.setitem(sys.modules, "demucs.separate", fake_sep_mod)
    monkeypatch.setitem(sys.modules, "demucs.api", fake_api_mod)

    res = separate_audio_stems(
        src,
        tmp_path / "stems",
        enabled=True,
        model_name="htdemucs",
        device="cpu",
        cache_dir=cache_dir,
    )
    assert res.available is True
    assert res.backend == "demucs"
    assert set(res.stems.keys()) == {"vocals", "drums", "bass", "other"}
    assert all(p.exists() for p in res.stems.values())
    assert res.cache_dir == str(cache_dir)


def test_separate_audio_stems_failure_never_fakes_success(tmp_path: Path, monkeypatch):
    src = tmp_path / "broken.wav"
    _write_test_wav(src)

    class _BrokenSeparator:
        def __init__(self, **kwargs):
            raise RuntimeError("corrupt model checkpoint")

    fake_demucs = types.ModuleType("demucs")
    fake_sep_mod = types.ModuleType("demucs.separate")
    fake_api_mod = types.ModuleType("demucs.api")
    fake_api_mod.Separator = _BrokenSeparator  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "demucs", fake_demucs)
    monkeypatch.setitem(sys.modules, "demucs.separate", fake_sep_mod)
    monkeypatch.setitem(sys.modules, "demucs.api", fake_api_mod)

    res = separate_audio_stems(src, tmp_path / "stems", enabled=True, device="cpu", cache_dir=tmp_path / "cache")
    assert res.available is False
    assert res.error_code == "DEMUCS_SEPARATION_FAILED"
    assert res.stems == {}


def test_detect_audio_source_route_auto_vocals_vs_solo(tmp_path: Path):
    vocals = tmp_path / "vocals.wav"
    other = tmp_path / "other.wav"
    bass = tmp_path / "bass.wav"

    _write_test_wav(vocals, amp=0.25)
    _write_test_wav(other, amp=0.20)
    _write_test_wav(bass, amp=0.15)
    route_full = detect_audio_source_route(
        stems={"vocals": vocals, "other": other, "bass": bass},
        requested_source_type="auto",
    )
    assert route_full["resolved_source_type"] == "full_song"

    # Silent vocals stem -> solo_piano
    _write_test_wav(vocals, amp=0.001)
    route_solo = detect_audio_source_route(
        stems={"vocals": vocals, "other": other, "bass": bass},
        requested_source_type="auto",
    )
    assert route_solo["resolved_source_type"] == "solo_piano"


def test_accompaniment_complexity_presets_and_low_confidence_guard():
    chords = [
        ScoreChord(id="c1", measure=1, beat=1.0, onset_sec=0.0, symbol="C", root="C", quality="major", confidence=0.9),
        ScoreChord(id="c2", measure=2, beat=1.0, onset_sec=2.0, symbol="G", root="G", quality="major", confidence=0.9),
    ]
    melody = [
        DetectedNote(pitch_midi=64, onset_sec=0.0, offset_sec=0.9, velocity=92, confidence=0.9),
        DetectedNote(pitch_midi=67, onset_sec=1.0, offset_sec=1.9, velocity=92, confidence=0.9),
        DetectedNote(pitch_midi=62, onset_sec=2.0, offset_sec=3.8, velocity=92, confidence=0.9),
    ]

    simple = generate_piano_accompaniment(
        chords=chords,
        melody_notes=melody,
        tempo_bpm=120.0,
        duration_seconds=4.0,
        arrangement_detail="simple",
    )
    balanced = generate_piano_accompaniment(
        chords=chords,
        melody_notes=melody,
        tempo_bpm=120.0,
        duration_seconds=4.0,
        arrangement_detail="balanced",
    )
    detailed = generate_piano_accompaniment(
        chords=chords,
        melody_notes=melody,
        tempo_bpm=120.0,
        duration_seconds=4.0,
        arrangement_detail="detailed",
    )
    assert len(simple.notes) > 0
    assert len(simple.notes) <= len(balanced.notes) <= len(detailed.notes)

    # Low harmonic confidence (no chords & no bass) -> do not fabricate accompaniment
    empty_res = generate_piano_accompaniment(
        chords=[],
        melody_notes=melody,
        tempo_bpm=120.0,
        duration_seconds=4.0,
        arrangement_detail="balanced",
    )
    assert empty_res.notes == []
    assert empty_res.stats["skipped_reason"] == "insufficient_harmonic_confidence"


def test_piano_vocal_score_musicxml_and_midi_sync():
    melody = [
        DetectedNote(pitch_midi=64, onset_sec=0.0, offset_sec=0.95, velocity=96, confidence=0.95),
        DetectedNote(pitch_midi=65, onset_sec=1.0, offset_sec=1.95, velocity=95, confidence=0.94),
        DetectedNote(pitch_midi=67, onset_sec=2.0, offset_sec=3.9, velocity=97, confidence=0.96),
    ]
    full_harmony = [
        *melody,
        DetectedNote(pitch_midi=48, onset_sec=0.0, offset_sec=1.95, velocity=85, confidence=0.9),
        DetectedNote(pitch_midi=52, onset_sec=0.0, offset_sec=1.95, velocity=78, confidence=0.88),
        DetectedNote(pitch_midi=55, onset_sec=0.0, offset_sec=1.95, velocity=78, confidence=0.88),
        DetectedNote(pitch_midi=43, onset_sec=2.0, offset_sec=3.9, velocity=85, confidence=0.9),
        DetectedNote(pitch_midi=47, onset_sec=2.0, offset_sec=3.9, velocity=78, confidence=0.88),
        DetectedNote(pitch_midi=50, onset_sec=2.0, offset_sec=3.9, velocity=78, confidence=0.88),
    ]

    score = build_piano_vocal_score_data(
        title="Piano + Vocal E2E",
        melody_notes=melody,
        chord_source_notes=full_harmony,
        tempo_bpm=120.0,
        tempo_estimated=False,
        time_signature="4/4",
        time_signature_estimated=False,
        key_signature="C",
        key_signature_estimated=False,
        duration_seconds=4.0,
        quantization="sixteenth",
        arrangement_detail="balanced",
        analysis={"mode": "piano_vocal"},
    )

    assert len(score.tracks) == 2
    assert score.tracks[0].name == "Vocal Melody"
    assert score.tracks[0].clef == "treble"
    assert score.tracks[1].name == "Piano Accompaniment"
    assert score.tracks[1].clef == "grand"
    assert any(n.track_index == 0 for n in score.notes)
    assert any(n.track_index == 1 for n in score.notes)

    xml_str = score_data_to_musicxml(score, include_chords=True)
    root = ET.fromstring(xml_str)
    parts = root.findall("part")
    assert len(parts) == 3
    # Chord symbols only attached to top melody staff (part 0), not duplicated on piano staves
    assert len(parts[0].findall(".//harmony")) >= 1
    assert len(parts[1].findall(".//harmony")) == 0
    assert len(parts[2].findall(".//harmony")) == 0
    # Upper staff melody has zero chord-stacked notes
    assert parts[0].findall(".//note/chord") == []

    # Synchronized MIDI contains both tracks
    midi_bytes = score_data_to_midi_bytes(score)
    assert midi_bytes.startswith(b"MThd")


def test_regenerate_arrangement_preserves_piano_vocal_two_staff_mode(client, db_session):
    reg = client.post(
        "/api/v1/auth/register",
        json={
            "email": "piano_vocal_regen@scribasheet.dev",
            "password": "Password123!",
            "display_name": "Piano Vocal Tester",
        },
    )
    if reg.status_code == 201:
        token = reg.json()["access_token"]
        user_id = reg.json()["user"]["id"]
    else:
        login = client.post(
            "/api/v1/auth/login",
            json={"email": "piano_vocal_regen@scribasheet.dev", "password": "Password123!"},
        )
        assert login.status_code == 200
        token = login.json()["access_token"]
        user_id = login.json()["user"]["id"]
    auth_headers = {"Authorization": f"Bearer {token}"}

    project = Project(
        user_id=user_id,
        title="Piano Vocal Regeneration",
        instrument="piano",
        transcription_mode="piano_vocal",
        status="completed",
    )
    db_session.add(project)
    db_session.commit()
    db_session.refresh(project)

    raw_poly = [
        {"pitch_midi": 48, "onset_sec": 0.0, "offset_sec": 1.9, "velocity": 82, "confidence": 0.9},
        {"pitch_midi": 52, "onset_sec": 0.0, "offset_sec": 1.9, "velocity": 78, "confidence": 0.88},
        {"pitch_midi": 55, "onset_sec": 0.0, "offset_sec": 1.9, "velocity": 78, "confidence": 0.88},
        {"pitch_midi": 64, "onset_sec": 0.0, "offset_sec": 0.9, "velocity": 95, "confidence": 0.95},
        {"pitch_midi": 67, "onset_sec": 1.0, "offset_sec": 1.9, "velocity": 96, "confidence": 0.95},
    ]
    initial = build_piano_vocal_score_data(
        title=project.title,
        melody_notes=[
            DetectedNote(pitch_midi=64, onset_sec=0.0, offset_sec=0.9, velocity=95, confidence=0.95),
            DetectedNote(pitch_midi=67, onset_sec=1.0, offset_sec=1.9, velocity=96, confidence=0.95),
        ],
        chord_source_notes=[DetectedNote(**n) for n in raw_poly],
        tempo_bpm=120.0,
        tempo_estimated=False,
        time_signature="4/4",
        time_signature_estimated=False,
        key_signature="C",
        key_signature_estimated=False,
        duration_seconds=2.0,
        arrangement_detail="simple",
        analysis={"mode": "piano_vocal", "raw_detected_notes": raw_poly},
    )

    score_row = ProjectScore(
        project_id=project.id,
        version=1,
        score_json=initial.model_dump(),
        musicxml_path="unused/pv.musicxml",
        midi_path="unused/pv.mid",
    )
    db_session.add(score_row)
    db_session.commit()

    resp = client.post(
        f"/api/v1/projects/{project.id}/score/regenerate",
        headers=auth_headers,
        json={"arrangement_detail": "detailed", "quantization": "sixteenth"},
    )
    assert resp.status_code == 200
    body = resp.json()["score_json"]
    assert len(body["tracks"]) == 2
    assert body["tracks"][0]["name"] == "Vocal Melody"
    assert body["tracks"][1]["name"] == "Piano Accompaniment"
    assert body["analysis"]["arrangement_detail"] == "detailed"
    assert len(body["analysis"]["raw_detected_notes"]) == len(raw_poly)
