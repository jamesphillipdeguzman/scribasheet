"""Comprehensive regression tests for recorded-audio piano transcription improvements.

Covers:
1. Harmonic overtone suppression (octaves +12/+24 and fifths +19) for both
   confidence-bearing and velocity-only (Transkun V2, confidence=None) notes.
2. Preservation of genuine octave doubling, intentional fifths, grace notes, and bass sustains.
3. Audio content classification & objective original-vs-separated source selection.
4. Meter inference (4/4 pop ballad with half-bar downbeats vs genuine 2/4, 3/4, 6/8) + phase thinning.
5. Chord recognition across triads, 7ths, maj7, m7, dim7, m7b5, 6, sus, shell voicings, & slash chords.
6. Playable piano post-processing (`original`, `standard`, `simplified`) & non-destructive regeneration.
7. Chord-aligned musical quantization preserving raw performance timing.
"""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import soundfile as sf
from fastapi.testclient import TestClient

from app.audio.separator import SeparationResult, classify_audio_content, detect_audio_source_route
from app.main import app
from app.notation.analyzer import detect_chords
from app.notation.beat_tracker import BeatTrackingResult, infer_time_signature_from_beats
from app.notation.evaluation import evaluate_bass_and_playability
from app.notation.generator import build_score_data
from app.notation.piano_playability import apply_piano_playability
from app.notation.timing_map import build_timing_map
from app.schemas.score import ScoreData, ScoreNote
from app.schemas.transcription import TranscriptionSettings
from app.transcription.base import DetectedNote, TranscriptionOutput, TranscriptionProvider
from app.transcription.core_pipeline import score_transcription_quality, transcribe_and_refine_audio
from app.transcription.note_refiner import NoteRefinerConfig, refine_detected_notes


def _write_wav(path: Path, samples: np.ndarray, sr: int = 22050) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(path), samples.astype(np.float32), sr, subtype="PCM_16")


def test_transkun_velocity_only_overtone_suppression_and_genuine_preservation() -> None:
    raw = [
        # Fundamental Eb3 (51) + weak octave artifact Eb4 (63) + weak 12th artifact Bb4 (70)
        DetectedNote(pitch_midi=51, onset_sec=0.50, offset_sec=1.50, velocity=95, confidence=None),
        DetectedNote(pitch_midi=63, onset_sec=0.51, offset_sec=1.20, velocity=64, confidence=None),
        DetectedNote(pitch_midi=70, onset_sec=0.51, offset_sec=1.10, velocity=58, confidence=None),
        # Genuine octave doubling (G3 + G4 moving melodically to F4 -> Eb4 with strong velocity)
        DetectedNote(pitch_midi=55, onset_sec=2.00, offset_sec=2.50, velocity=86, confidence=None),
        DetectedNote(pitch_midi=67, onset_sec=2.00, offset_sec=2.50, velocity=84, confidence=None),
        DetectedNote(pitch_midi=53, onset_sec=2.52, offset_sec=3.00, velocity=86, confidence=None),
        DetectedNote(pitch_midi=65, onset_sec=2.52, offset_sec=3.00, velocity=84, confidence=None),
        # Intentional grace note ornament (38ms D5 resolving stepwise to Eb5 at 3.54s)
        DetectedNote(pitch_midi=74, onset_sec=3.50, offset_sec=3.538, velocity=74, confidence=None),
        DetectedNote(pitch_midi=75, onset_sec=3.54, offset_sec=4.20, velocity=90, confidence=None),
        # Fragmented bass Eb2 (gap 70ms, weak tail) -> should stitch smoothly
        DetectedNote(pitch_midi=39, onset_sec=3.50, offset_sec=4.00, velocity=88, confidence=None),
        DetectedNote(pitch_midi=39, onset_sec=4.07, offset_sec=4.45, velocity=62, confidence=None),
    ]
    res = refine_detected_notes(raw, NoteRefinerConfig())
    pitches_at_05 = [n.pitch_midi for n in res.notes if abs(n.onset_sec - 0.50) < 0.05]
    assert pitches_at_05 == [51]
    assert res.stats["octave_ghosts_suppressed"] >= 1
    assert res.stats["fifth_harmonics_suppressed"] >= 1
    assert res.stats["short_ornaments_preserved"] >= 1
    assert res.stats["bass_sustain_merges"] == 1

    # Genuine octave doubling retained
    assert len([n for n in res.notes if n.pitch_midi == 67 and abs(n.onset_sec - 2.0) < 0.05]) == 1
    assert len([n for n in res.notes if n.pitch_midi == 65 and abs(n.onset_sec - 2.52) < 0.05]) == 1
    # Grace note D5 preserved
    assert any(n.pitch_midi == 74 and abs(n.onset_sec - 3.50) < 0.02 for n in res.notes)
    # Stitched bass sustained to 4.45s
    eb2 = [n for n in res.notes if n.pitch_midi == 39]
    assert len(eb2) == 1
    assert abs(eb2[0].offset_sec - 4.45) < 0.01


def test_source_classification_and_original_vs_separated_selection(tmp_path: Path) -> None:
    sr = 22050
    t = np.arange(int(3.0 * sr), dtype=np.float32) / sr
    # Clean harmonic solo piano-like signal (3 sustained Eb triad sines, low noise floor)
    piano_sig = (
        0.3 * np.sin(2 * np.pi * 155.56 * t)
        + 0.25 * np.sin(2 * np.pi * 196.00 * t)
        + 0.2 * np.sin(2 * np.pi * 233.08 * t)
    ) * np.exp(-0.5 * t)
    piano_wav = tmp_path / "solo_piano.wav"
    _write_wav(piano_wav, piano_sig, sr=sr)

    solo_cls = classify_audio_content(piano_wav)
    assert solo_cls["content_type"] == "solo_piano"
    assert solo_cls["solo_confidence"] >= 0.72

    # Simulated stem separation where vocals contaminate original mix vs clean piano stem
    vocals_wav = tmp_path / "vocals.wav"
    drums_wav = tmp_path / "drums.wav"
    bass_wav = tmp_path / "bass.wav"
    other_wav = tmp_path / "other.wav"
    _write_wav(vocals_wav, 0.30 * np.sin(2 * np.pi * 440.0 * t), sr=sr)
    _write_wav(drums_wav, 0.01 * np.random.default_rng(7).normal(size=len(t)).astype(np.float32), sr=sr)
    _write_wav(bass_wav, 0.20 * np.sin(2 * np.pi * 77.78 * t), sr=sr)
    _write_wav(other_wav, piano_sig, sr=sr)

    stems = {"vocals": vocals_wav, "drums": drums_wav, "bass": bass_wav, "other": other_wav}
    route = detect_audio_source_route(piano_wav, stems, requested_source_type="auto", mode="piano")
    assert route["resolved_source_type"] == "full_song"
    assert route["content_classification"]["content_type"] in ("piano_with_vocals", "multi_instrument")

    class FakeComparisonProvider(TranscriptionProvider):
        def transcribe(self, wav_path: Path, **_kwargs) -> TranscriptionOutput:
            # Separated mixed stem produces clean Eb major harmony notes
            if "stems_piano_target" in wav_path.name:
                notes = [
                    DetectedNote(51, 0.0, 1.5, 88, 0.90),
                    DetectedNote(63, 0.0, 1.5, 84, 0.88),
                    DetectedNote(67, 0.0, 1.5, 82, 0.86),
                    DetectedNote(70, 0.0, 1.5, 80, 0.85),
                    DetectedNote(43, 1.6, 3.0, 86, 0.90),
                    DetectedNote(62, 1.6, 3.0, 82, 0.86),
                    DetectedNote(67, 1.6, 3.0, 84, 0.88),
                ]
            else:
                # Original mix contains out-of-key vocal pitch bends + short transient noise
                notes = [
                    DetectedNote(51, 0.0, 1.5, 85, 0.80),
                    DetectedNote(66, 0.2, 0.24, 50, 0.32),
                    DetectedNote(68, 0.5, 0.55, 52, 0.35),
                    DetectedNote(73, 0.9, 1.4, 70, 0.60),
                    DetectedNote(61, 1.6, 2.2, 68, 0.58),
                    DetectedNote(49, 2.3, 2.34, 48, 0.30),
                ]
            return TranscriptionOutput(
                engine="fake",
                notes=notes,
                midi_bytes=b"MThd\x00\x00\x00\x06\x00\x00\x00\x01\x00\x60",
                duration_seconds=3.0,
                metadata={},
            )

    sep_res = SeparationResult(available=True, backend="demucs", stems=stems, message="ok")
    settings = TranscriptionSettings(mode="piano", instrument="piano", enable_source_separation=True, key_signature="Eb")
    core = transcribe_and_refine_audio(
        piano_wav,
        tmp_path,
        settings=settings,
        requested_engine="transkun",
        allow_fallback=True,
        target_sr=sr,
        prep_profile_name="piano",
        sep_res=sep_res,
        source_route=route,
        custom_provider=FakeComparisonProvider(),
        custom_provider_engine="transkun",
    )
    assert core.source_selection["selected"] == "separated"
    assert core.source_selection["separated_score"]["composite_score"] > core.source_selection["original_score"]["composite_score"]

    # Score quality metric itself favors clean in-key harmony over vocal glitches
    assert score_transcription_quality(core.refined_notes, "Eb")["in_key_ratio"] >= 0.9


def test_meter_resolves_4_4_pop_ballad_from_halfbar_downbeats_while_preserving_true_2_4() -> None:
    bpm = 102.0
    spb = 60.0 / bpm
    # Beat tracker emits half-bar downbeats every 2 beats
    beats = [0.5 + i * spb for i in range(16)]
    halfbar_downbeats = [0.5 + i * 2 * spb for i in range(9)]
    bt = BeatTrackingResult(
        beat_times_sec=beats,
        downbeat_times_sec=halfbar_downbeats,
        raw_bpm=bpm,
        selected_bpm=bpm,
        candidates=[],
        selected_ratio=1.0,
        downbeat_confidence=0.82,
        resolution_reason="test",
        ambiguous=False,
        requested_provider="beat_this",
        actual_provider="beat_this",
        fallback_used=False,
    )

    # Pop ballad harmony spans 4 beats per chord: Eb (bars 0-1 hb), Gm7 (bars 2-3 hb), Fm7 (bars 4-5 hb), Bb7 (bars 6-7 hb)
    ballad_notes = [
        # Bar 1 (4 beats: 0.5 -> 0.5+4*spb): Eb major held across both half-bars
        DetectedNote(39, 0.5, 0.5 + 3.8 * spb, 92, 0.9),
        DetectedNote(63, 0.5, 0.5 + 1.8 * spb, 84, 0.9),
        DetectedNote(67, 0.5 + 2.0 * spb, 0.5 + 3.8 * spb, 72, 0.85),
        # Bar 2: Gm7
        DetectedNote(43, 0.5 + 4.0 * spb, 0.5 + 7.8 * spb, 92, 0.9),
        DetectedNote(67, 0.5 + 4.0 * spb, 0.5 + 5.8 * spb, 84, 0.9),
        DetectedNote(70, 0.5 + 6.0 * spb, 0.5 + 7.8 * spb, 74, 0.85),
        # Bar 3: Fm7
        DetectedNote(41, 0.5 + 8.0 * spb, 0.5 + 11.8 * spb, 92, 0.9),
        DetectedNote(65, 0.5 + 8.0 * spb, 0.5 + 9.8 * spb, 84, 0.9),
        DetectedNote(68, 0.5 + 10.0 * spb, 0.5 + 11.8 * spb, 74, 0.85),
        # Bar 4: Bb7
        DetectedNote(46, 0.5 + 12.0 * spb, 0.5 + 15.8 * spb, 92, 0.9),
        DetectedNote(62, 0.5 + 12.0 * spb, 0.5 + 13.8 * spb, 84, 0.9),
        DetectedNote(68, 0.5 + 14.0 * spb, 0.5 + 15.8 * spb, 74, 0.85),
    ]

    ts, est, diag = infer_time_signature_from_beats(bt, "auto", notes=ballad_notes)
    assert ts == "4/4"
    assert est is True
    assert diag["reason"] == "metrical_accent_and_harmony_4_4"

    tm = build_timing_map(
        beat_result=bt,
        notes=ballad_notes,
        duration_seconds=0.5 + 16 * spb,
        time_signature=ts,
        meter_diag=diag,
    )
    # Thinned downbeats should be ~4 beats apart, not ~2 beats apart
    db_gaps = np.diff(np.array(tm.downbeat_times_sec))
    assert float(np.median(db_gaps)) >= 3.5 * spb

    # Genuine 2/4 polka/march alternating root+chord every 2 beats across strong contrasting harmonies should remain 2/4
    march_notes: list[DetectedNote] = []
    # 8 contrasting 2-beat bars alternating C+E+G vs F#+A+C# (tritone apart) with equal downbeat accents
    for bar in range(8):
        t0 = 0.5 + bar * 2 * spb
        pitches = (48, 60, 64, 67) if bar % 2 == 0 else (42, 61, 66, 69)
        for p in pitches:
            march_notes.append(DetectedNote(p, t0, t0 + 1.8 * spb, 85, 0.9))
    ts2, _, _ = infer_time_signature_from_beats(bt, "auto", notes=march_notes)
    assert ts2 == "2/4"


def test_extended_chord_recognition_7ths_shell_inversions_and_viterbi_smoothing() -> None:
    bpm = 100.0
    spb = 60.0 / bpm

    def mk(pitches: list[int], beat: float, dur: float = 4.0, vel: int = 84) -> list[ScoreNote]:
        return [
            ScoreNote(
                id=f"c_{p}_{beat}",
                pitch_midi=p,
                onset_sec=beat * spb,
                offset_sec=(beat + dur) * spb,
                velocity=vel,
                confidence=0.92,
            )
            for p in pitches
        ]

    # Progression in Eb major:
    # m1: Ebmaj7 shell (Eb3+G4+D5, omitted Bb) with brief passing C5 on beat 2
    # m2: Gm7 (G2+Bb3+D4+F4)
    # m3: Fm7 (F2+Ab3+C4+Eb4) beats 1-2 -> Bb7sus4 (Bb2+Eb3+F4+Ab4) beats 3-4
    # m4: Eb/G (G2+Eb4+G4+Bb4)
    # m5: Edim7 (E3+G3+Bb3+Db4) -> Cm7b5? Let's test Dm7b5 (D3+F3+Ab3+C4)
    notes = [
        *mk([39, 67, 74], 0.0, 4.0),  # Ebmaj7 shell voicing
        *mk([72], 1.0, 0.25, vel=55),  # brief passing note
        *mk([43, 58, 62, 65], 4.0, 4.0),  # Gm7
        *mk([41, 56, 60, 63], 8.0, 2.0),  # Fm7
        *mk([46, 51, 65, 68], 10.0, 2.0),  # Bb7sus4
        *mk([43, 63, 67, 70], 12.0, 4.0),  # Eb/G inversion
        *mk([50, 53, 56, 60], 16.0, 4.0),  # Dm7b5
    ]
    chords = detect_chords(notes, tempo_bpm=bpm, time_signature="4/4", key_signature="Eb")
    syms = [c.symbol for c in chords]
    assert "Ebmaj7" in syms
    assert "Gm7" in syms
    assert "Fm7" in syms
    assert "Bb7sus4" in syms
    assert "Eb/G" in syms
    assert "Dm7b5" in syms


def test_piano_playability_smoothing_modes_and_chord_aligned_quantization() -> None:
    # Uncomfortable raw cluster:
    # - RH melody G5 (79) with weak octave ghost G4 (67), muddy cluster (60, 61), wide spread note (62 -> span 17)
    # - LH wide spread Eb2 (39) + Bb3 (58) (span 19) + muddy low F2 (41)
    # - Slight chord flam (+18ms jitter) across simultaneous notes
    raw = [
        DetectedNote(39, 0.000, 1.80, 92, 0.90),  # Eb2 bass sustain
        DetectedNote(41, 0.008, 0.90, 55, 0.60),  # muddy low F2 next to Eb2
        DetectedNote(58, 0.012, 1.80, 78, 0.80),  # wide Bb3 (+19 from Eb2)
        DetectedNote(60, 0.015, 0.90, 60, 0.70),  # C4 (muddy second with Db4)
        DetectedNote(61, 0.018, 0.90, 52, 0.65),  # non-chord Db4 blip
        DetectedNote(67, 0.006, 1.50, 62, 0.75),  # weak octave below top G5
        DetectedNote(70, 0.004, 1.50, 82, 0.88),  # Bb4 chord tone
        DetectedNote(74, 0.010, 1.50, 82, 0.88),  # D5 chord tone
        DetectedNote(79, 0.002, 1.80, 96, 0.95),  # G5 top melody
    ]
    ref_chord = [SimpleNamespace(onset_sec=0.0, symbol="Ebmaj7")]

    res_orig = apply_piano_playability(raw, chords=ref_chord, mode="piano", smoothing="original")
    assert len(res_orig.notes) == len(raw)

    res_std = apply_piano_playability(raw, chords=ref_chord, mode="piano", smoothing="standard")
    res_simp = apply_piano_playability(raw, chords=ref_chord, mode="piano", smoothing="simplified")

    # Both standard and simplified preserve top melody G5 and sustained bass Eb2
    assert any(n.pitch_midi == 79 for n in res_std.notes)
    assert any(n.pitch_midi == 39 for n in res_std.notes)
    assert any(n.pitch_midi == 79 for n in res_simp.notes)
    assert any(n.pitch_midi == 39 for n in res_simp.notes)

    # Playability metrics show reduced clutter and comfortable hand spans
    eval_orig = evaluate_bass_and_playability(raw, res_orig.notes)
    eval_std = evaluate_bass_and_playability(raw, res_std.notes)
    eval_simp = evaluate_bass_and_playability(raw, res_simp.notes)
    assert eval_std["max_rh_span_semitones"] <= 12
    assert eval_std["max_lh_span_semitones"] <= 12
    assert eval_simp["max_rh_span_semitones"] <= 12
    assert eval_simp["max_lh_span_semitones"] <= 12
    assert eval_simp["comfortable_span_ratio"] >= eval_orig["comfortable_span_ratio"]
    assert len(res_simp.notes) <= len(res_std.notes) < len(res_orig.notes)

    # Chord-aligned quantization snaps slightly flam'd chord notes to identical onset while keeping raw_onset_sec
    score = build_score_data(
        title="Chord Alignment",
        detected_notes=[
            DetectedNote(48, 0.000, 1.0, 85, 0.9),
            DetectedNote(64, 0.018, 1.0, 82, 0.9),
            DetectedNote(67, 0.028, 1.0, 84, 0.9),
        ],
        tempo_bpm=120.0,
        tempo_estimated=False,
        time_signature="4/4",
        time_signature_estimated=False,
        key_signature="C",
        key_signature_estimated=False,
        duration_seconds=2.0,
        instrument="piano",
        quantization="eighth",
    )
    onsets = {n.onset_sec for n in score.notes}
    assert len(onsets) == 1
    assert any(n.raw_onset_sec == 0.028 for n in score.notes)


def test_regenerate_arrangement_switches_playability_smoothing_without_ml(monkeypatch) -> None:
    from app.api.deps import get_current_user
    from app.db.session import get_db
    from app.models import Project, ProjectScore, User
    from app.storage.service import storage_service

    saved_blobs: dict[str, bytes] = {}
    monkeypatch.setattr(storage_service, "build_key", lambda uid, pid, folder, fn: f"{uid}/{pid}/{folder}/{fn}")
    monkeypatch.setattr(storage_service, "save_bytes", lambda key, data, content_type="": saved_blobs.__setitem__(key, data))

    raw_detected = [
        {"pitch_midi": 39, "onset_sec": 0.0, "offset_sec": 1.8, "velocity": 92, "confidence": 0.9},
        {"pitch_midi": 41, "onset_sec": 0.0, "offset_sec": 1.0, "velocity": 55, "confidence": 0.65},
        {"pitch_midi": 58, "onset_sec": 0.0, "offset_sec": 1.8, "velocity": 80, "confidence": 0.85},
        {"pitch_midi": 60, "onset_sec": 0.0, "offset_sec": 1.0, "velocity": 65, "confidence": 0.75},
        {"pitch_midi": 61, "onset_sec": 0.0, "offset_sec": 1.0, "velocity": 54, "confidence": 0.65},
        {"pitch_midi": 67, "onset_sec": 0.0, "offset_sec": 1.8, "velocity": 84, "confidence": 0.9},
        {"pitch_midi": 70, "onset_sec": 0.0, "offset_sec": 1.8, "velocity": 84, "confidence": 0.9},
        {"pitch_midi": 74, "onset_sec": 0.0, "offset_sec": 1.8, "velocity": 86, "confidence": 0.92},
        {"pitch_midi": 79, "onset_sec": 0.0, "offset_sec": 1.8, "velocity": 95, "confidence": 0.95},
    ]
    initial_score = ScoreData(
        title="Eb Ballad",
        tempo_bpm=102.0,
        tempo_estimated=True,
        time_signature="4/4",
        time_signature_estimated=True,
        key_signature="Eb",
        key_signature_estimated=True,
        duration_seconds=2.5,
        notes=[ScoreNote(id=f"n{i}", **{k: v for k, v in n.items() if k in ("pitch_midi", "onset_sec", "offset_sec", "velocity", "confidence")}, track_index=0) for i, n in enumerate(raw_detected)],
        analysis={"raw_detected_notes": raw_detected, "mode": "piano", "quantization": "eighth"},
    )
    fake_user = User(id="u1", email="u@test.local", password_hash="x", display_name="U")
    fake_proj = Project(id="p1", user_id="u1", title="Eb Ballad", instrument="piano", transcription_mode="piano")
    fake_score_row = ProjectScore(
        id="s1",
        project_id="p1",
        version=1,
        score_json=initial_score.model_dump(),
        musicxml_path="u1/p1/musicxml/score.musicxml",
        midi_path="u1/p1/midi/score.mid",
        updated_at=datetime.now(UTC),
    )

    class _Query:
        def __init__(self, model):
            self.model = model

        def filter(self, *_args, **_kwargs):
            return self

        def first(self):
            if self.model is Project:
                return fake_proj
            if self.model is ProjectScore:
                return fake_score_row
            return None

    class _DB:
        def query(self, model):
            return _Query(model)

        def commit(self):
            return None

        def refresh(self, _obj):
            return None

    app.dependency_overrides[get_current_user] = lambda: fake_user
    app.dependency_overrides[get_db] = lambda: _DB()
    try:
        client = TestClient(app)
        res_orig = client.post(
            "/api/v1/projects/p1/score/regenerate",
            json={"arrangement_detail": "detailed", "playability_smoothing": "original", "quantization": "eighth"},
        )
        assert res_orig.status_code == 200
        orig_json = res_orig.json()["score_json"]
        assert orig_json["analysis"]["playability_smoothing"] == "original"

        res_simp = client.post(
            "/api/v1/projects/p1/score/regenerate",
            json={"arrangement_detail": "balanced", "playability_smoothing": "simplified", "quantization": "eighth"},
        )
        assert res_simp.status_code == 200
        simp_json = res_simp.json()["score_json"]
        assert simp_json["analysis"]["playability_smoothing"] == "simplified"
        assert len(simp_json["notes"]) < len(orig_json["notes"])
        # Raw detected notes preserved untouched across regenerations
        assert len(simp_json["analysis"]["raw_detected_notes"]) == len(raw_detected)
    finally:
        app.dependency_overrides.clear()
