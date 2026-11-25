"""End-to-end regression tests for Lead Melody vocal stem routing, F0 pitch tracking, and full-context key detection."""

from __future__ import annotations

import io
import wave
import xml.etree.ElementTree as ET
from pathlib import Path
from unittest.mock import patch

import numpy as np
import pretty_midi
import pytest

from app.audio.processor import AudioMetadata, get_preprocessing_profile
from app.audio.separator import SeparationResult, detect_audio_source_route, separate_audio_stems
from app.notation.analyzer import estimate_key_signature
from app.notation.generator import score_data_to_midi_bytes, score_data_to_musicxml
from app.schemas.transcription import TranscriptionSettings
from app.transcription.base import DetectedNote, TranscriptionOutput, TranscriptionProvider
from app.transcription.basic_pitch_provider import TranscriptionInferenceError
from app.transcription.core_pipeline import (
    analyze_timing_and_build_score,
    transcribe_and_refine_audio,
)
from app.transcription.vocal_pitch_tracker import (
    VocalPitchTrackerConfig,
    _suppress_octave_spikes,
    transcribe_vocal_melody_f0,
)


def _write_wav(path: Path, samples: np.ndarray, sr: int = 22050) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    peak = float(np.max(np.abs(samples))) if len(samples) else 0.0
    if peak > 0.99:
        samples = samples * (0.95 / peak)
    pcm = np.clip(samples * 32767.0, -32768, 32767).astype(np.int16)
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(pcm.tobytes())
    return path


def _midi_to_hz(midi: int) -> float:
    return 440.0 * (2.0 ** ((midi - 69) / 12.0))


def _synth_vocal_events(
    events: list[tuple[int, float, float, float]],
    total_sec: float,
    sr: int = 22050,
) -> np.ndarray:
    """Synthesize a clean harmonic singing voice with formant-like harmonics and optional vibrato."""
    n = int(round(total_sec * sr))
    audio = np.zeros(n, dtype=np.float64)
    for midi, start_s, end_s, vibrato_cents in events:
        i0 = max(0, int(round(start_s * sr)))
        i1 = min(n, int(round(end_s * sr)))
        if i1 <= i0 + 8:
            continue
        t = np.arange(i1 - i0, dtype=np.float64) / sr
        f0 = _midi_to_hz(midi)
        if vibrato_cents > 0.0:
            cents_mod = vibrato_cents * np.sin(2.0 * np.pi * 5.5 * t)
            inst_freq = f0 * (2.0 ** (cents_mod / 1200.0))
            phase = 2.0 * np.pi * np.cumsum(inst_freq) / sr
        else:
            phase = 2.0 * np.pi * f0 * t
        tone = 0.68 * np.sin(phase) + 0.24 * np.sin(2.0 * phase) + 0.10 * np.sin(3.0 * phase)
        fade = min(int(0.012 * sr), max(1, (i1 - i0) // 6))
        env = np.ones(i1 - i0, dtype=np.float64)
        env[:fade] = np.linspace(0.0, 1.0, fade)
        env[-fade:] = np.linspace(1.0, 0.0, fade)
        audio[i0:i1] += 0.55 * tone * env
    return audio


def _synth_chord_bed(chords: list[tuple[list[int], float, float]], total_sec: float, sr: int = 22050) -> np.ndarray:
    n = int(round(total_sec * sr))
    audio = np.zeros(n, dtype=np.float64)
    for pitches, start_s, end_s in chords:
        i0 = max(0, int(round(start_s * sr)))
        i1 = min(n, int(round(end_s * sr)))
        if i1 <= i0 + 8:
            continue
        t = np.arange(i1 - i0, dtype=np.float64) / sr
        seg = np.zeros_like(t)
        for p in pitches:
            f = _midi_to_hz(p)
            seg += 0.25 * np.sin(2.0 * np.pi * f * t) + 0.08 * np.sin(4.0 * np.pi * f * t)
        fade = min(int(0.025 * sr), max(1, (i1 - i0) // 6))
        env = np.ones(i1 - i0, dtype=np.float64)
        env[:fade] = np.linspace(0.0, 1.0, fade)
        env[-fade:] = np.linspace(1.0, 0.0, fade)
        audio[i0:i1] += seg * env
    return audio


class _StubTrackingProvider(TranscriptionProvider):
    """Records which audio file was passed into polyphonic transcription and returns stub notes."""

    def __init__(self, notes_by_stem: dict[str, list[DetectedNote]] | None = None):
        self.calls: list[Path] = []
        self.notes_by_stem = notes_by_stem or {}

    def transcribe(
        self,
        audio_path: Path,
        *,
        onset_threshold: float = 0.5,
        frame_threshold: float = 0.3,
        min_note_length_ms: int = 58,
        min_midi_pitch: int = 21,
        max_midi_pitch: int = 108,
        midi_program: int = 0,
        transpose_semitones: int = 0,
        concert_pitch_hz: float = 440.0,
    ) -> TranscriptionOutput:
        self.calls.append(Path(audio_path))
        stem_name = Path(audio_path).stem
        notes = list(
            self.notes_by_stem.get(
                stem_name,
                [
                    DetectedNote(pitch_midi=65, onset_sec=0.5, offset_sec=1.0, velocity=85, confidence=0.9),
                    DetectedNote(pitch_midi=69, onset_sec=1.0, offset_sec=1.5, velocity=85, confidence=0.9),
                ],
            )
        )
        return TranscriptionOutput(
            engine="basic_pitch",
            notes=notes,
            midi_bytes=b"",
            duration_seconds=4.0,
            metadata={"model": "stub"},
        )


def test_vocal_preprocessing_profile_maps_vocals_key():
    prof = get_preprocessing_profile("vocals")
    assert prof.name == "vocal"
    assert prof.highpass_hz >= 70.0


def test_suppress_octave_spikes_folds_short_octave_glitches():
    # Stable A4 (69) contour with a 4-frame +12 spike (81) and 3-frame -12 dip (57)
    midi = np.full(30, 69.0, dtype=np.float64)
    active = np.ones(30, dtype=bool)
    midi[8:12] = 81.0
    midi[20:23] = 57.0

    fixed, count = _suppress_octave_spikes(midi, active)
    assert count == 2
    assert np.allclose(fixed, 69.0)


def test_vocal_pitch_tracker_preserves_register_vibrato_and_rapid_sixteenth_syllables(tmp_path: Path):
    # 91 BPM: quarter = 0.6593s, eighth = 0.3297s, 16th = 0.1648s
    q = 60.0 / 91.0
    s16 = q / 4.0
    # Rest for 2 beats (pickup), rapid repeated F4/G4/A4/C5 16th syllables, then F5 with vibrato, then rest + D4
    events: list[tuple[int, float, float, float]] = [
        # Bar 1 beat 3: four distinct 16th-note syllables (C5, C5, D5, C5) with small articulation gaps
        (72, 2 * q, 2 * q + 0.80 * s16, 0.0),
        (72, 2 * q + 1.0 * s16, 2 * q + 1.80 * s16, 0.0),
        (74, 2 * q + 2.0 * s16, 2 * q + 2.80 * s16, 0.0),
        (72, 2 * q + 3.0 * s16, 2 * q + 3.80 * s16, 0.0),
        # Bar 1 beat 4 -> Bar 2 beat 2: A4 then sustained F5 with +-45 cents vibrato
        (69, 3 * q, 3.9 * q, 0.0),
        (77, 4 * q, 6 * q, 45.0),
        # Genuine 1-beat rest on beat 3 (6q..7q), then D4->F4 closing cadence
        (62, 7 * q, 7.8 * q, 0.0),
        (65, 8 * q, 9.2 * q, 0.0),
    ]
    total_sec = 10.0 * q
    wav_path = _write_wav(tmp_path / "vocals.wav", _synth_vocal_events(events, total_sec))

    res = transcribe_vocal_melody_f0(wav_path, VocalPitchTrackerConfig())
    assert len(res.notes) >= 6

    pitches = [n.pitch_midi for n in res.notes]
    # Must stay strictly in authentic vocal register (D4=62 .. F5=77), zero low-register errors
    assert min(pitches) >= 60
    assert max(pitches) <= 79
    assert any(abs(p - 77) <= 1 for p in pitches), f"Expected F5 (77) vibrato peak in {pitches}"
    assert any(abs(p - 62) <= 1 for p in pitches), f"Expected D4 (62) phrase note in {pitches}"

    # Repeated C5 16th syllables (MIDI ~72) must not be collapsed into a single note,
    # and the sustained F5 vibrato (~1.3s) must remain mostly continuous rather than shattered into tiny notes
    c5_notes = [n for n in res.notes if abs(n.pitch_midi - 72) <= 1 and n.onset_sec < 2.2]
    assert len(c5_notes) >= 2, f"Expected repeated C5 syllables preserved, got {c5_notes}"
    f5_notes = [n for n in res.notes if abs(n.pitch_midi - 77) <= 1]
    assert max(n.offset_sec - n.onset_sec for n in f5_notes) >= 0.75

    # Rest gap around 6q..7q (~3.95s..4.61s) must be preserved
    assert any(
        b.onset_sec - a.offset_sec >= 0.45
        for a, b in zip(res.notes, res.notes[1:], strict=False)
    )


def test_lead_melody_missing_or_empty_vocal_stem_fails_loudly_without_silent_fallback(tmp_path: Path):
    silent_vocals = _write_wav(tmp_path / "vocals.wav", np.zeros(22050 * 2, dtype=np.float64))
    bass_wav = _write_wav(
        tmp_path / "bass.wav",
        _synth_chord_bed([([41, 46], 0.0, 2.0)], 2.0),  # F2-Bb2 accompaniment
    )
    other_wav = _write_wav(
        tmp_path / "other.wav",
        _synth_chord_bed([([53, 58, 62], 0.0, 2.0)], 2.0),  # F3-Bb3-D4 chords
    )
    mix_wav = _write_wav(tmp_path / "mix.wav", _synth_chord_bed([([41, 53, 58], 0.0, 2.0)], 2.0))

    settings = TranscriptionSettings(
        mode="melody",
        instrument="piano",
        audio_source_type="auto",
        enable_source_separation=True,
    )

    # 1. Missing vocal stem -> must raise VOCAL_STEM_UNAVAILABLE, never transcribe mix/other/bass
    stub = _StubTrackingProvider()
    with pytest.raises(TranscriptionInferenceError) as exc_missing:
        transcribe_and_refine_audio(
            mix_wav,
            tmp_path,
            settings=settings,
            requested_engine="basic_pitch",
            allow_fallback=True,
            target_sr=22050,
            prep_profile_name="vocal",
            sep_res=SeparationResult(
                available=True,
                backend="demucs",
                stems={"bass": bass_wav, "other": other_wav},  # intentionally missing vocals
                message="missing vocals stem",
            ),
            custom_provider=stub,
            custom_provider_engine="basic_pitch",
        )
    assert exc_missing.value.code == "VOCAL_STEM_UNAVAILABLE"
    assert stub.calls == []

    # 2. Silent vocals stem in Lead Melody -> raises NO_VOCAL_MELODY_DETECTED, never substitutes bass/other
    with pytest.raises(TranscriptionInferenceError) as exc_empty:
        transcribe_and_refine_audio(
            mix_wav,
            tmp_path,
            settings=settings,
            requested_engine="basic_pitch",
            allow_fallback=True,
            target_sr=22050,
            prep_profile_name="vocal",
            sep_res=SeparationResult(
                available=True,
                backend="demucs",
                stems={"vocals": silent_vocals, "bass": bass_wav, "other": other_wav},
                message="ok",
            ),
            custom_provider=stub,
            custom_provider_engine="basic_pitch",
        )
    assert exc_empty.value.code == "NO_VOCAL_MELODY_DETECTED"


def test_lead_melody_respects_explicit_solo_piano_override(tmp_path: Path):
    solo_wav = _write_wav(
        tmp_path / "solo.wav",
        _synth_chord_bed([([64, 67], 0.0, 1.5)], 1.6),
    )
    stub = _StubTrackingProvider()
    settings = TranscriptionSettings(
        mode="melody",
        instrument="piano",
        audio_source_type="solo_piano",
        enable_source_separation=False,
    )

    res = transcribe_and_refine_audio(
        solo_wav,
        tmp_path,
        settings=settings,
        requested_engine="basic_pitch",
        allow_fallback=True,
        target_sr=22050,
        prep_profile_name="piano",
        sep_res=None,
        custom_provider=stub,
        custom_provider_engine="basic_pitch",
    )
    assert res.is_vocal_melody_route is False
    assert solo_wav in stub.calls
    assert len(res.refined_notes) >= 1


def test_demucs_stem_cache_reuses_stems_without_duplicate_separation(tmp_path: Path):
    mix_wav = _write_wav(tmp_path / "song.wav", _synth_vocal_events([(69, 0.1, 1.0, 0.0)], 1.2))
    cache_dir = tmp_path / "demucs_cache"
    call_count = 0

    def _fake_subprocess(_iso_py, _wav, stem_out_dir: Path, **_kwargs) -> SeparationResult:
        nonlocal call_count
        call_count += 1
        stem_out_dir.mkdir(parents=True, exist_ok=True)
        stems = {}
        for name in ("vocals", "bass", "drums", "other"):
            p = stem_out_dir / f"{name}.wav"
            _write_wav(p, _synth_vocal_events([(69, 0.1, 1.0, 0.0)], 1.2) if name == "vocals" else np.zeros(22050))
            stems[name] = p
        return SeparationResult(available=True, backend="demucs", stems=stems, message="ok")

    with (
        patch.dict("sys.modules", {"demucs": None, "demucs.separate": None}),
        patch("app.audio.separator._find_isolated_demucs_python", return_value=Path("python")),
        patch("app.audio.separator._run_demucs_subprocess", side_effect=_fake_subprocess),
    ):
        first = separate_audio_stems(mix_wav, tmp_path / "run1", enabled=True, cache_dir=cache_dir)
        second = separate_audio_stems(mix_wav, tmp_path / "run2", enabled=True, cache_dir=cache_dir)

    assert call_count == 1
    assert first.available and "vocals" in first.stems
    assert second.available and "vocals" in second.stems
    assert "Reused" in second.message


def test_end_to_end_lead_melody_na_para_bang_style_f_major_score_musicxml_and_midi(tmp_path: Path):
    # Synthesize 4 bars in F major at 91 BPM with isolated D4-F5 singing line + rich F/Bb/C/Dm piano accompaniment
    q = 60.0 / 91.0
    s16 = q / 4.0
    total_sec = 16.0 * q
    vocal_events = [
        # Bar 1: pickup rest beat 1, then A4-Bb4-C5-C5-D5-C5-A4-G4-F4
        (69, 1.0 * q, 1.45 * q, 0.0),
        (70, 1.5 * q, 1.95 * q, 0.0),
        (72, 2.0 * q, 2.0 * q + 0.8 * s16, 0.0),
        (72, 2.0 * q + s16, 2.0 * q + 1.8 * s16, 0.0),
        (74, 2.0 * q + 2 * s16, 2.0 * q + 2.8 * s16, 0.0),
        (72, 2.0 * q + 3 * s16, 2.0 * q + 3.8 * s16, 0.0),
        (69, 3.0 * q, 3.45 * q, 0.0),
        (67, 3.5 * q, 3.95 * q, 0.0),
        # Bar 2: F4 sustained + D4->F4->A4
        (65, 4.0 * q, 5.4 * q, 30.0),
        (62, 5.5 * q, 5.95 * q, 0.0),
        (65, 6.0 * q, 6.95 * q, 0.0),
        (69, 7.0 * q, 7.95 * q, 0.0),
        # Bar 3: Bb4->C5->D5->F5 vibrato
        (70, 8.0 * q, 8.9 * q, 0.0),
        (72, 9.0 * q, 9.9 * q, 0.0),
        (74, 10.0 * q, 10.9 * q, 0.0),
        (77, 11.0 * q, 12.4 * q, 40.0),
        # Bar 4: E5->C5->A4->F4 resolution
        (76, 12.5 * q, 12.95 * q, 0.0),
        (72, 13.0 * q, 13.9 * q, 0.0),
        (69, 14.0 * q, 14.9 * q, 0.0),
        (65, 15.0 * q, 15.9 * q, 0.0),
    ]
    chords = [
        ([53, 57, 60], 0.0, 4.0 * q),      # F major
        ([50, 53, 57], 4.0 * q, 8.0 * q),  # Dm
        ([58, 62, 65], 8.0 * q, 12.0 * q), # Bb major
        ([48, 55, 60, 64], 12.0 * q, 16.0 * q),  # C7/C major
    ]
    bass_chords = [
        ([41], 0.0, 4.0 * q),
        ([38], 4.0 * q, 8.0 * q),
        ([46], 8.0 * q, 12.0 * q),
        ([36], 12.0 * q, 16.0 * q),
    ]

    vocal_samples = _synth_vocal_events(vocal_events, total_sec)
    other_samples = _synth_chord_bed(chords, total_sec)
    bass_samples = _synth_chord_bed(bass_chords, total_sec)

    vocals_wav = _write_wav(tmp_path / "stems" / "vocals.wav", vocal_samples)
    other_wav = _write_wav(tmp_path / "stems" / "other.wav", other_samples)
    bass_wav = _write_wav(tmp_path / "stems" / "bass.wav", bass_samples)
    full_mix_wav = _write_wav(
        tmp_path / "mix.wav",
        0.55 * vocal_samples + 0.55 * other_samples + 0.45 * bass_samples,
    )

    sep_res = SeparationResult(
        available=True,
        backend="demucs",
        stems={"vocals": vocals_wav, "other": other_wav, "bass": bass_wav},
        message="Separated stems",
    )
    route = detect_audio_source_route(
        full_mix_wav, sep_res.stems, requested_source_type="auto", mode="melody"
    )
    assert route["resolved_source_type"] == "full_song"

    # Provide realistic F-major accompaniment detections for bass & other stems
    stub = _StubTrackingProvider(
        notes_by_stem={
            "stems_proc_other": [
                DetectedNote(pitch_midi=53, onset_sec=0.0, offset_sec=4.0 * q, velocity=80, confidence=0.9),
                DetectedNote(pitch_midi=57, onset_sec=0.0, offset_sec=4.0 * q, velocity=78, confidence=0.9),
                DetectedNote(pitch_midi=60, onset_sec=0.0, offset_sec=4.0 * q, velocity=78, confidence=0.9),
                DetectedNote(pitch_midi=58, onset_sec=8.0 * q, offset_sec=12.0 * q, velocity=80, confidence=0.9),
                DetectedNote(pitch_midi=48, onset_sec=12.0 * q, offset_sec=16.0 * q, velocity=80, confidence=0.9),
                DetectedNote(pitch_midi=64, onset_sec=12.0 * q, offset_sec=16.0 * q, velocity=78, confidence=0.9),
            ],
            "stems_proc_bass": [
                DetectedNote(pitch_midi=41, onset_sec=0.0, offset_sec=4.0 * q, velocity=85, confidence=0.9),
                DetectedNote(pitch_midi=38, onset_sec=4.0 * q, offset_sec=8.0 * q, velocity=85, confidence=0.9),
                DetectedNote(pitch_midi=46, onset_sec=8.0 * q, offset_sec=12.0 * q, velocity=85, confidence=0.9),
                DetectedNote(pitch_midi=36, onset_sec=12.0 * q, offset_sec=16.0 * q, velocity=85, confidence=0.9),
            ],
        }
    )

    # Even with Instrument = piano and requested_engine = transkun, Lead Melody must use vocal_pyin on vocals.wav
    # and Basic Pitch (never Transkun piano) for accompaniment context.
    settings = TranscriptionSettings(
        mode="melody",
        instrument="piano",
        audio_source_type="auto",
        enable_source_separation=True,
        tempo_mode="manual",
        manual_tempo_bpm=91.0,
        quantization="sixteenth",
    )

    core_res = transcribe_and_refine_audio(
        full_mix_wav,
        tmp_path,
        settings=settings,
        requested_engine="transkun",
        allow_fallback=True,
        target_sr=22050,
        prep_profile_name="vocal",
        sep_res=sep_res,
        source_route=route,
        custom_provider=stub,
        custom_provider_engine="basic_pitch",
    )

    assert core_res.is_vocal_melody_route is True
    assert core_res.vocal_from_monophonic_tracker is True
    assert core_res.exec_res.actual_engine == "vocal_pyin"
    assert core_res.vocal_tracking.get("source_stem") == "vocals"
    # Polyphonic provider must NEVER be called with the raw mix or vocals.wav
    assert all(p.stem != "mix" and "vocals" not in p.stem for p in stub.calls)

    # Build final ScoreData, MusicXML, and MIDI
    score = analyze_timing_and_build_score(
        title="Na Para Bang Test",
        processed_wav=full_mix_wav,
        proc_meta=AudioMetadata(
            duration_seconds=total_sec,
            sample_rate=22050,
            channels=1,
            has_audio_stream=True,
            is_silent=False,
        ),
        settings=settings,
        core_res=core_res,
        sep_res=sep_res,
        source_route=route,
    )

    assert len(score.tracks) == 1
    assert score.tracks[0].clef == "treble"
    assert score.tracks[0].name == "Lead Melody"
    assert score.key_signature == "F major", f"Expected F major key signature, got {score.key_signature}"
    assert score.analysis.get("vocal_tracking", {}).get("engine") == "vocal_pyin"

    score_notes = [n for n in score.notes if n.track_index == 0]
    assert len(score_notes) >= 12
    # Must reflect the vocal D4-F5 melody without dropping into low F3/Bb3 accompaniment
    assert min(n.pitch_midi for n in score_notes) >= 60
    assert max(n.pitch_midi for n in score_notes) >= 75

    # Verify MusicXML key signature matches (fifths = -1 for F major) and single treble part
    xml_str = score_data_to_musicxml(score)
    root = ET.fromstring(xml_str)
    parts = root.findall("part")
    assert len(parts) == 1
    fifths_el = root.find(".//key/fifths")
    assert fifths_el is not None and fifths_el.text == "-1"

    # Verify MIDI export contains single melodic pitch set matching score_notes
    midi_bytes = score_data_to_midi_bytes(score)
    pm = pretty_midi.PrettyMIDI(io.BytesIO(midi_bytes))
    melody_inst = next((inst for inst in pm.instruments if not inst.is_drum and len(inst.notes) > 0), None)
    assert melody_inst is not None
    assert len(melody_inst.notes) >= 12
    assert min(n.pitch for n in melody_inst.notes) >= 60


def test_estimate_key_signature_uses_full_harmonic_context_over_sparse_melody(tmp_path: Path):
    # Sparse fragment emphasizing D4-G4-Bb4 alone could look ambiguous; full F-major chord bed + C leading tone -> F
    q = 60.0 / 91.0
    total_sec = 8.0 * q
    melody_notes = [
        DetectedNote(pitch_midi=69, onset_sec=0.2, offset_sec=0.8, velocity=90, confidence=0.9),   # A4
        DetectedNote(pitch_midi=70, onset_sec=1.0, offset_sec=1.5, velocity=90, confidence=0.9),   # Bb4
        DetectedNote(pitch_midi=72, onset_sec=1.6, offset_sec=2.1, velocity=90, confidence=0.9),   # C5
        DetectedNote(pitch_midi=76, onset_sec=2.2, offset_sec=2.8, velocity=90, confidence=0.9),   # E5 (leading tone to F)
        DetectedNote(pitch_midi=65, onset_sec=3.0, offset_sec=4.0, velocity=95, confidence=0.95),  # F4 final tonic
    ]
    mix_wav = _write_wav(
        tmp_path / "f_major_context.wav",
        _synth_chord_bed(
            [
                ([53, 57, 60, 65], 0.0, 2.0 * q),   # F
                ([58, 62, 65], 2.0 * q, 4.0 * q),   # Bb
                ([48, 55, 60, 64], 4.0 * q, 6.0 * q), # C7
                ([53, 57, 60, 65], 6.0 * q, 8.0 * q), # F
            ],
            total_sec,
        ),
    )
    key_sig, estimated = estimate_key_signature(
        melody_notes,
        "auto",
        audio_path=mix_wav,
    )
    assert estimated is True
    assert key_sig == "F major"


def test_piano_arrangement_mode_remains_isolated_from_vocal_tracker(tmp_path: Path):
    piano_wav = _write_wav(
        tmp_path / "piano_solo.wav",
        _synth_chord_bed([([48, 52, 55, 64], 0.0, 1.5)], 1.6),
    )
    stub = _StubTrackingProvider(
        notes_by_stem={
            "piano_solo": [
                DetectedNote(pitch_midi=48, onset_sec=0.0, offset_sec=1.0, velocity=85, confidence=0.9),
                DetectedNote(pitch_midi=52, onset_sec=0.0, offset_sec=1.0, velocity=78, confidence=0.88),
                DetectedNote(pitch_midi=55, onset_sec=0.0, offset_sec=1.0, velocity=78, confidence=0.88),
                DetectedNote(pitch_midi=64, onset_sec=0.0, offset_sec=1.0, velocity=92, confidence=0.92),
            ]
        }
    )
    settings = TranscriptionSettings(
        mode="piano",
        instrument="piano",
        audio_source_type="auto",
        enable_source_separation=False,
    )
    res = transcribe_and_refine_audio(
        piano_wav,
        tmp_path,
        settings=settings,
        requested_engine="basic_pitch",
        allow_fallback=True,
        target_sr=22050,
        prep_profile_name="piano",
        custom_provider=stub,
        custom_provider_engine="basic_pitch",
    )
    assert res.is_vocal_melody_route is False
    assert res.vocal_from_monophonic_tracker is False
    assert res.exec_res.actual_engine == "basic_pitch"
    assert len(res.refined_notes) == 4
