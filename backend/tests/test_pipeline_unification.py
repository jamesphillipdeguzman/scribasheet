import io
import math
import struct
import wave
from pathlib import Path
from unittest.mock import patch

import pretty_midi
import pytest

from app.core.config import get_settings
from app.db.session import SessionLocal
from app.models import MediaAsset, Project, ProjectScore, TranscriptionJob, TranscriptionResult, User
from app.notation.beat_tracker import BeatTrackingResult
from app.schemas.transcription import TranscriptionSettings
from app.storage.service import storage_service
from app.transcription.base import DetectedNote, TranscriptionOutput
from app.transcription.basic_pitch_provider import TranscriptionInferenceError
from app.transcription.core_pipeline import (
    analyze_timing_and_build_score,
    resolve_preprocessing_profile,
    transcribe_and_refine_audio,
)
from app.transcription.provider_factory import get_target_sample_rate_for_engine, resolve_engine_for_instrument
from app.workers.celery_app import transcribe_audio_task
from app.workers.job_runner import enqueue_transcription_job
from app.workers.pipeline import run_transcription_pipeline


def _write_test_wav(path: Path, *, duration_sec: float = 2.0, sr: int = 22050, freq_hz: float = 261.63) -> None:
    n_samples = int(duration_sec * sr)
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        frames = bytearray()
        for i in range(n_samples):
            val = int(0.4 * 32767 * math.sin(2.0 * math.pi * freq_hz * (i / sr)))
            frames.extend(struct.pack("<h", val))
        wf.writeframes(bytes(frames))


def _seed_project_and_job(
    *,
    user_id: str,
    project_id: str,
    job_id: str,
    wav_bytes: bytes,
    settings_dict: dict,
) -> None:
    db = SessionLocal()
    try:
        user = User(
            id=user_id,
            email=f"{user_id}@example.com",
            password_hash="hash",
            display_name="Tester",
            email_verified=True,
        )
        db.add(user)
        db.flush()

        project = Project(
            id=project_id,
            user_id=user.id,
            title="Unification Test Score",
            instrument=settings_dict.get("instrument", "piano"),
            transcription_mode=settings_dict.get("mode", "single_instrument"),
            status="queued",
        )
        db.add(project)
        db.flush()

        key = storage_service.build_key(user.id, project.id, "original", "test.wav")
        storage_service.save_bytes(key, wav_bytes, content_type="audio/wav")

        asset = MediaAsset(
            project_id=project.id,
            user_id=user.id,
            asset_type="original",
            storage_path=key,
            original_filename="test.wav",
            mime_type="audio/wav",
            size_bytes=len(wav_bytes),
        )
        db.add(asset)
        db.flush()

        job = TranscriptionJob(
            id=job_id,
            project_id=project.id,
            user_id=user.id,
            source_asset_id=asset.id,
            status="queued",
            progress=0,
            current_stage="Queued",
            engine="auto",
            settings_json=settings_dict,
        )
        db.add(job)
        db.commit()
    finally:
        db.close()


def _sample_notes() -> list[DetectedNote]:
    return [
        DetectedNote(pitch_midi=60, onset_sec=0.0, offset_sec=0.5, velocity=84, confidence=0.92),
        DetectedNote(pitch_midi=64, onset_sec=0.5, offset_sec=1.0, velocity=82, confidence=0.90),
        DetectedNote(pitch_midi=67, onset_sec=1.0, offset_sec=1.5, velocity=86, confidence=0.94),
        DetectedNote(pitch_midi=72, onset_sec=1.5, offset_sec=2.0, velocity=88, confidence=0.95),
    ]


def test_server_pipeline_selects_transkun_for_piano_with_beat_this_and_arrangement(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    wav_path = tmp_path / "piano.wav"
    _write_test_wav(wav_path)
    wav_bytes = wav_path.read_bytes()

    _seed_project_and_job(
        user_id="u-transkun-1",
        project_id="p-transkun-1",
        job_id="j-transkun-1",
        wav_bytes=wav_bytes,
        settings_dict={"instrument": "piano", "arrangement_detail": "simple", "quantization": "eighth"},
    )

    notes = _sample_notes()

    class FakeTranskunProvider:
        name = "transkun"

        def transcribe(self, *_args, **_kwargs) -> TranscriptionOutput:
            pm = pretty_midi.PrettyMIDI()
            buf = io.BytesIO()
            pm.write(buf)
            return TranscriptionOutput(
                notes=list(notes),
                midi_bytes=buf.getvalue(),
                duration_seconds=2.0,
                engine="transkun",
                metadata={"model": "transkun-2.0.pt"},
            )

    fake_beat_res = BeatTrackingResult(
        beat_times_sec=[0.0, 0.5, 1.0, 1.5, 2.0],
        downbeat_times_sec=[0.0, 2.0],
        raw_bpm=120.0,
        selected_bpm=120.0,
        candidates=[{"bpm": 120.0, "relation": "primary", "score": 1.0}],
        selected_ratio=1.0,
        downbeat_confidence=0.91,
        resolution_reason="beat_this_primary",
        ambiguous=False,
        requested_provider="auto",
        actual_provider="beat_this",
        fallback_used=False,
        provenance_unused=None,
    ) if False else BeatTrackingResult(
        beat_times_sec=[0.0, 0.5, 1.0, 1.5, 2.0],
        downbeat_times_sec=[0.0, 2.0],
        raw_bpm=120.0,
        selected_bpm=120.0,
        candidates=[{"bpm": 120.0, "relation": "primary", "score": 1.0}],
        selected_ratio=1.0,
        downbeat_confidence=0.91,
        resolution_reason="beat_this_primary",
        ambiguous=False,
        requested_provider="auto",
        actual_provider="beat_this",
        fallback_used=False,
    )

    monkeypatch.setattr("app.transcription.provider_factory.is_transkun_available", lambda: True)
    monkeypatch.setattr(
        "app.transcription.provider_factory.get_transcription_provider",
        lambda eng: FakeTranskunProvider() if eng == "transkun" else pytest.fail(f"Unexpected engine {eng}"),
    )
    monkeypatch.setattr("app.transcription.core_pipeline.track_beats_and_downbeats", lambda *_a, **_kw: fake_beat_res)

    run_transcription_pipeline("j-transkun-1")

    db = SessionLocal()
    try:
        job = db.query(TranscriptionJob).filter(TranscriptionJob.id == "j-transkun-1").first()
        score = db.query(ProjectScore).filter(ProjectScore.project_id == "p-transkun-1").first()
        res = db.query(TranscriptionResult).filter(TranscriptionResult.job_id == "j-transkun-1").first()
        assert job is not None and job.status == "completed"
        assert score is not None
        assert res is not None
        analysis = score.score_json["analysis"]
        assert analysis["requested_engine"] == "transkun"
        assert analysis["actual_engine"] == "transkun"
        assert analysis["engine"] == "transkun"
        assert analysis["fallback_used"] is False
        assert analysis["arrangement_detail"] == "simple"
        assert analysis["timing_map"]["actual_provider"] == "beat_this"
        assert len(score.score_json["notes"]) == 4
    finally:
        db.close()


def test_server_pipeline_falls_back_to_basic_pitch_and_librosa_when_optional_ml_missing(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    wav_path = tmp_path / "fallback.wav"
    _write_test_wav(wav_path)

    _seed_project_and_job(
        user_id="u-fb-1",
        project_id="p-fb-1",
        job_id="j-fb-1",
        wav_bytes=wav_path.read_bytes(),
        settings_dict={"instrument": "piano", "tempo_mode": "auto"},
    )

    class FailingTranskun:
        name = "transkun"

        def transcribe(self, *_args, **_kwargs):
            raise TranscriptionInferenceError("DEPENDENCY_MISSING", "torch missing")

    class FakeBasicPitch:
        name = "basic_pitch"

        def transcribe(self, *_args, **_kwargs) -> TranscriptionOutput:
            pm = pretty_midi.PrettyMIDI()
            buf = io.BytesIO()
            pm.write(buf)
            return TranscriptionOutput(
                notes=_sample_notes(),
                midi_bytes=buf.getvalue(),
                duration_seconds=2.0,
                engine="basic_pitch",
                metadata={"model": "nmp.onnx"},
            )

    monkeypatch.setenv("TRANSCRIPTION_ALLOW_FALLBACK", "true")
    monkeypatch.setattr("app.transcription.provider_factory.is_transkun_available", lambda: True)
    monkeypatch.setattr(
        "app.transcription.provider_factory.get_transcription_provider",
        lambda eng: FailingTranskun() if eng == "transkun" else FakeBasicPitch(),
    )
    monkeypatch.setattr(
        "app.transcription.provider_factory.BasicPitchProvider",
        FakeBasicPitch,
    )
    # Simulate Beat This! raising -> Librosa fallback
    monkeypatch.setattr(
        "app.notation.beat_tracker._run_beat_this",
        lambda *_a, **_kw: (_ for _ in ()).throw(RuntimeError("beat_this missing")),
    )

    run_transcription_pipeline("j-fb-1")

    db = SessionLocal()
    try:
        job = db.query(TranscriptionJob).filter(TranscriptionJob.id == "j-fb-1").first()
        score = db.query(ProjectScore).filter(ProjectScore.project_id == "p-fb-1").first()
        assert job is not None and job.status == "completed"
        assert score is not None
        analysis = score.score_json["analysis"]
        assert analysis["requested_engine"] == "transkun"
        assert analysis["actual_engine"] == "basic_pitch"
        assert analysis["engine"] == "basic_pitch"
        assert analysis["fallback_used"] is True
        assert "DEPENDENCY_MISSING" in (analysis["fallback_reason"] or "")
        assert analysis["timing_map"]["actual_provider"] == "librosa"
        assert analysis["timing_map"]["fallback_used"] is True
    finally:
        db.close()


def test_non_piano_routing_and_no_double_refinement_on_stems(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    req_eng, _ = resolve_engine_for_instrument("acoustic_guitar")
    assert req_eng == "basic_pitch"

    wav_path = tmp_path / "vocals.wav"
    _write_test_wav(wav_path)
    bass_path = tmp_path / "bass.wav"
    _write_test_wav(bass_path, freq_hz=110.0)

    from app.audio.separator import SeparationResult

    sep_res = SeparationResult(
        available=True,
        backend="demucs",
        stems={"vocals": wav_path, "bass": bass_path},
    )

    refine_calls = []

    def spy_refine(notes, config=None):
        refine_calls.append(len(notes))
        from app.transcription.note_refiner import refine_detected_notes as real_refine

        return real_refine(notes, config=config)

    class FakeBP:
        name = "basic_pitch"

        def transcribe(self, *_args, **_kwargs) -> TranscriptionOutput:
            return TranscriptionOutput(
                notes=_sample_notes(),
                midi_bytes=b"MThd",
                duration_seconds=2.0,
                engine="basic_pitch",
            )

    monkeypatch.setattr("app.transcription.core_pipeline.refine_detected_notes", spy_refine)
    monkeypatch.setattr("app.transcription.provider_factory.get_transcription_provider", lambda _e: FakeBP())

    settings = TranscriptionSettings(instrument="vocals", mode="vocal_melody", enable_source_separation=True)
    res = transcribe_and_refine_audio(
        wav_path,
        tmp_path,
        settings=settings,
        requested_engine="basic_pitch",
        allow_fallback=False,
        target_sr=22050,
        prep_profile_name="vocal",
        sep_res=sep_res,
        source_route={"resolved_source_type": "full_song"},
    )
    # 2 stems (vocals + bass) -> refined once per stem (2 calls total), NOT a 3rd time on combined notes
    assert len(refine_calls) == 2
    assert len(res.refined_notes) == 8


def test_celery_and_job_runner_invoke_unified_pipeline(monkeypatch: pytest.MonkeyPatch) -> None:
    called: list[str] = []
    monkeypatch.setattr("app.workers.pipeline.run_transcription_pipeline", lambda jid: called.append(jid))

    res = transcribe_audio_task("job-celery-1")
    assert res == {"job_id": "job-celery-1", "status": "done"}
    assert called == ["job-celery-1"]

    with patch("app.workers.job_runner._local_executor.submit") as mock_submit:
        monkeypatch.setattr(get_settings(), "JOB_EXECUTION_MODE", "local")
        tag = enqueue_transcription_job("job-local-1")
        assert tag == "local-job-loca"
        mock_submit.assert_called_once()


def test_controlled_comparison_server_vs_core_pipeline(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    wav_path = tmp_path / "compare.wav"
    _write_test_wav(wav_path)
    wav_bytes = wav_path.read_bytes()

    settings = TranscriptionSettings(
        instrument="piano",
        arrangement_detail="balanced",
        quantization="sixteenth",
        tempo_mode="manual",
        manual_tempo_bpm=100.0,
    )

    class DeterministicProvider:
        name = "transkun"

        def transcribe(self, *_args, **_kwargs) -> TranscriptionOutput:
            return TranscriptionOutput(
                notes=_sample_notes(),
                midi_bytes=b"MThd",
                duration_seconds=2.0,
                engine="transkun",
            )

    monkeypatch.setattr("app.transcription.provider_factory.is_transkun_available", lambda: True)
    monkeypatch.setattr(
        "app.transcription.provider_factory.get_transcription_provider",
        lambda _e: DeterministicProvider(),
    )

    # 1. Server pipeline execution
    _seed_project_and_job(
        user_id="u-cmp-1",
        project_id="p-cmp-1",
        job_id="j-cmp-1",
        wav_bytes=wav_bytes,
        settings_dict=settings.model_dump(),
    )
    run_transcription_pipeline("j-cmp-1")

    # 2. Direct core_pipeline (as used by worker_agent.py)
    req_eng, allow_fb = resolve_engine_for_instrument(settings.instrument)
    sr = get_target_sample_rate_for_engine(req_eng)
    prep = resolve_preprocessing_profile(settings.instrument)
    from app.audio.processor import preprocess_to_wav

    direct_wav = tmp_path / "direct.wav"
    proc_meta = preprocess_to_wav(wav_path, direct_wav, target_sr=sr, profile=prep)
    core_res = transcribe_and_refine_audio(
        direct_wav,
        tmp_path,
        settings=settings,
        requested_engine=req_eng,
        allow_fallback=allow_fb,
        target_sr=sr,
        prep_profile_name=prep,
    )
    direct_score = analyze_timing_and_build_score(
        title="Unification Test Score",
        processed_wav=direct_wav,
        proc_meta=proc_meta,
        settings=settings,
        core_res=core_res,
    )

    db = SessionLocal()
    try:
        server_score = db.query(ProjectScore).filter(ProjectScore.project_id == "p-cmp-1").first()
        assert server_score is not None
        sj = server_score.score_json
        assert sj["analysis"]["actual_engine"] == direct_score.analysis["actual_engine"] == "transkun"
        assert len(sj["notes"]) == len(direct_score.notes)
        assert [n["pitch_midi"] for n in sj["notes"]] == [n.pitch_midi for n in direct_score.notes]
        assert [n["onset_sec"] for n in sj["notes"]] == [n.onset_sec for n in direct_score.notes]
        assert [n["offset_sec"] for n in sj["notes"]] == [n.offset_sec for n in direct_score.notes]
        assert sj["tempo_bpm"] == direct_score.tempo_bpm == 100.0
    finally:
        db.close()
