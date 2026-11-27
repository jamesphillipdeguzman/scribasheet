"""Tests for Violin (Solo Monophonic) pitch tracking and end-to-end score generation."""

from __future__ import annotations

import wave
import xml.etree.ElementTree as ET
from pathlib import Path

import numpy as np

from app.audio.processor import AudioMetadata
from app.notation.generator import score_data_to_midi_bytes, score_data_to_musicxml
from app.notation.melody import is_violin_solo_mode, normalize_transcription_mode
from app.schemas.transcription import TranscriptionSettings
from app.transcription.core_pipeline import (
    analyze_timing_and_build_score,
    transcribe_and_refine_audio,
)
from app.transcription.vocal_pitch_tracker import transcribe_violin_melody_f0


def _midi_to_hz(midi: float) -> float:
    return 440.0 * (2.0 ** ((midi - 69.0) / 12.0))


def _synthesize_violin_wav(
    wav_path: Path,
    events: list[tuple[float, float, float, float]],  # (midi_or_0_rest, dur_sec, amp, vib_cents)
    sr: int = 44100,
) -> None:
    """Write a bowed-envelope harmonic violin audio WAV to ``wav_path``."""
    segments: list[np.ndarray] = []
    for midi_val, dur_sec, amp, vib_cents in events:
        n = max(1, int(round(dur_sec * sr)))
        t = np.arange(n, dtype=np.float64) / float(sr)
        if midi_val <= 0 or amp <= 0:
            segments.append(np.zeros(n, dtype=np.float64))
            continue

        base_hz = _midi_to_hz(midi_val)
        if vib_cents > 0:
            vib_ratio = 2.0 ** ((vib_cents * np.sin(2.0 * np.pi * 6.0 * t)) / 1200.0)
            inst_hz = base_hz * vib_ratio
        else:
            inst_hz = np.full(n, base_hz, dtype=np.float64)

        phase = 2.0 * np.pi * np.cumsum(inst_hz) / float(sr)
        wave_seg = amp * (
            1.0 * np.sin(phase)
            + 0.45 * np.sin(2.0 * phase)
            + 0.22 * np.sin(3.0 * phase)
            + 0.08 * np.sin(4.0 * phase)
        )
        # Smooth bow attack and release ramps (15ms each)
        ramp = min(n // 4, int(0.015 * sr))
        if ramp > 0:
            wave_seg[:ramp] *= np.linspace(0.0, 1.0, ramp)
            wave_seg[-ramp:] *= np.linspace(1.0, 0.0, ramp)
        segments.append(wave_seg)

    audio = np.concatenate(segments) if segments else np.zeros(sr // 2, dtype=np.float64)
    peak = float(np.max(np.abs(audio))) if audio.size else 1.0
    if peak > 0.9:
        audio = audio * (0.85 / peak)
    pcm = np.clip(np.round(audio * 32767.0), -32767, 32767).astype(np.int16)

    with wave.open(str(wav_path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(pcm.tobytes())


def test_violin_solo_mode_helpers():
    assert is_violin_solo_mode("violin_solo") is True
    assert is_violin_solo_mode("violin_monophonic") is True
    assert is_violin_solo_mode("melody") is False
    assert normalize_transcription_mode("violin_monophonic") == "violin_solo"
    assert normalize_transcription_mode("violin_solo") == "violin_solo"


def test_violin_pyin_tracks_full_violin_range_including_open_strings_and_e7(tmp_path: Path):
    wav_path = tmp_path / "violin_range.wav"
    target_midis = [55, 62, 69, 76, 93, 100]  # G3, D4, A4, E5, A6, E7
    events: list[tuple[float, float, float, float]] = [(0, 0.1, 0.0, 0.0)]
    for m in target_midis:
        events.append((float(m), 0.42, 0.55, 0.0))
        events.append((0, 0.10, 0.0, 0.0))

    _synthesize_violin_wav(wav_path, events)
    res = transcribe_violin_melody_f0(wav_path)

    detected_pitches = [n.pitch_midi for n in res.notes]
    assert len(detected_pitches) == len(target_midis)
    for got, want in zip(detected_pitches, target_midis, strict=True):
        assert abs(got - want) <= 1, f"Expected ~{want}, got {got}"
    assert res.stats["engine"] == "violin_pyin"


def test_violin_pyin_vibrato_remains_single_coherent_note(tmp_path: Path):
    wav_path = tmp_path / "violin_vibrato.wav"
    _synthesize_violin_wav(
        wav_path,
        [
            (0, 0.1, 0.0, 0.0),
            (69.0, 1.35, 0.60, 38.0),  # Sustained A4 with 6 Hz ±38¢ vibrato
            (0, 0.1, 0.0, 0.0),
        ],
    )
    res = transcribe_violin_melody_f0(wav_path)

    assert len(res.notes) == 1
    assert res.notes[0].pitch_midi == 69
    assert (res.notes[0].offset_sec - res.notes[0].onset_sec) >= 1.1


def test_violin_pyin_preserves_grace_note_and_filters_out_of_range_noise(tmp_path: Path):
    wav_path = tmp_path / "violin_grace_and_filter.wav"
    _synthesize_violin_wav(
        wav_path,
        [
            (40.0, 0.40, 0.40, 0.0),  # Out-of-range low rumble (E2 < G3)
            (0, 0.08, 0.0, 0.0),
            (66.0, 0.09, 0.55, 0.0),  # Short ~90ms grace/articulation F#4
            (67.0, 0.50, 0.55, 0.0),  # Sustained G4
            (69.0, 0.45, 0.55, 0.0),  # Genuine melodic step to A4
            (0, 0.10, 0.0, 0.0),
        ],
    )
    res = transcribe_violin_melody_f0(wav_path)

    pitches = [n.pitch_midi for n in res.notes]
    assert all(55 <= p <= 100 for p in pitches)
    assert 40 not in pitches
    assert [66, 67, 69] == pitches or (67 in pitches and 69 in pitches and len(pitches) >= 3)


def test_violin_solo_preset_end_to_end_pipeline_produces_treble_violin_score_xml_and_midi(tmp_path: Path):
    wav_path = tmp_path / "violin_melody.wav"
    _synthesize_violin_wav(
        wav_path,
        [
            (0, 0.08, 0.0, 0.0),
            (67.0, 0.48, 0.55, 25.0),  # G4
            (69.0, 0.48, 0.55, 25.0),  # A4
            (71.0, 0.48, 0.55, 25.0),  # B4
            (72.0, 0.65, 0.55, 25.0),  # C5
            (0, 0.12, 0.0, 0.0),
        ],
    )

    # Deliberately set enable_source_separation=True to verify backend forces bypass for violin_solo
    settings = TranscriptionSettings(
        mode="violin_solo",
        instrument="violin",
        tempo_mode="manual",
        manual_tempo_bpm=120.0,
        key_signature="G",
        enable_source_separation=True,
        quantization="sixteenth",
        min_midi_pitch=55,
        max_midi_pitch=100,
    )

    core_res = transcribe_and_refine_audio(
        processed_wav=wav_path,
        tmp_path=tmp_path,
        settings=settings,
        requested_engine="basic_pitch",
        allow_fallback=True,
        target_sr=44100,
        prep_profile_name="general",
        sep_res=None,
    )
    assert core_res.exec_res.actual_engine == "violin_pyin"
    assert [n.pitch_midi for n in core_res.refined_notes] == [67, 69, 71, 72]

    score = analyze_timing_and_build_score(
        title="Violin Etude",
        processed_wav=wav_path,
        proc_meta=AudioMetadata(
            duration_seconds=2.3,
            sample_rate=44100,
            channels=1,
            has_audio_stream=True,
            is_silent=False,
        ),
        settings=settings,
        core_res=core_res,
        sep_res=None,
    )

    assert score.analysis.get("engine") == "violin_pyin"
    assert score.analysis.get("preset") == "violin_solo"
    assert score.analysis.get("separation", {}).get("enabled") is False
    assert len(score.tracks) == 1
    assert score.tracks[0].instrument == "violin"
    assert score.tracks[0].program == 40
    assert score.tracks[0].clef == "treble"

    # Strictly monophonic non-overlapping output
    ordered_notes = sorted(score.notes, key=lambda n: n.onset_sec)
    assert len(ordered_notes) == 4
    for prev, curr in zip(ordered_notes, ordered_notes[1:], strict=False):
        assert prev.offset_sec <= curr.onset_sec + 1e-4

    xml_str = score_data_to_musicxml(score)
    root = ET.fromstring(xml_str)
    clef_sign = root.findtext(".//clef/sign")
    clef_line = root.findtext(".//clef/line")
    assert clef_sign == "G"
    assert clef_line == "2"
    assert root.find(".//staves") is None or root.findtext(".//staves") == "1"

    midi_bytes = score_data_to_midi_bytes(score)
    assert midi_bytes.startswith(b"MThd")
    assert len(midi_bytes) > 64
