import io
import os
from datetime import UTC, datetime
from unittest.mock import patch

import httpx
import numpy as np
import pytest
import soundfile as sf

from app.core.config import get_settings
from app.models import Project, ProjectScore, TranscriptionJob, UsageRecord
from app.transcription.basic_pitch_provider import TranscriptionInferenceError
from app.worker_agent import RealTranscriptionHandler, RemoteWorkerAgent


@pytest.fixture(autouse=True)
def _restore_env():
    prev_mode = os.environ.get("JOB_EXECUTION_MODE", "local")
    yield
    os.environ["JOB_EXECUTION_MODE"] = prev_mode
    get_settings.cache_clear()


def _synthesize_piano_arpeggio_wav() -> bytes:
    """Generate a genuine 2.5s C-major arpeggio (C4, E4, G4, C5) WAV audio recording."""
    sr = 22050
    notes_hz = [261.63, 329.63, 392.00, 523.25]
    segments = []
    for freq in notes_hz:
        t = np.linspace(0, 0.55, int(sr * 0.55), endpoint=False)
        env = np.minimum(1.0, t / 0.02) * np.exp(-3.0 * t)
        wave = (
            0.7 * np.sin(2 * np.pi * freq * t)
            + 0.2 * np.sin(2 * np.pi * 2 * freq * t)
            + 0.1 * np.sin(2 * np.pi * 3 * freq * t)
        ) * env * 0.6
        segments.append(wave.astype(np.float32))
        segments.append(np.zeros(int(sr * 0.05), dtype=np.float32))
    audio = np.concatenate(segments)
    buf = io.BytesIO()
    sf.write(buf, audio, sr, format="WAV", subtype="PCM_16")
    return buf.getvalue()


def _create_remote_job(client, wav_bytes: bytes, *, worker_token: str = "phase-b-token"):
    os.environ["JOB_EXECUTION_MODE"] = "remote_worker"
    os.environ["WORKER_API_TOKEN"] = worker_token
    get_settings.cache_clear()

    reg = client.post(
        "/api/v1/auth/register",
        json={
            "email": f"phaseb_{datetime.now(UTC).timestamp()}@example.com",
            "password": "StrongPassword123!",
            "display_name": "Phase B Pianist",
        },
    )
    assert reg.status_code == 201
    headers = {"Authorization": f"Bearer {reg.json()['access_token']}"}

    proj = client.post(
        "/api/v1/projects",
        headers=headers,
        json={"title": "Real Piano Arpeggio", "instrument": "piano", "transcription_mode": "piano"},
    )
    assert proj.status_code == 201
    project_id = proj.json()["id"]

    up = client.post(
        "/api/v1/uploads",
        headers=headers,
        data={"project_id": project_id},
        files={"file": ("arpeggio.wav", wav_bytes, "audio/wav")},
    )
    assert up.status_code == 201, up.text
    asset_id = up.json()["id"]

    job = client.post(
        f"/api/v1/projects/{project_id}/transcriptions",
        headers=headers,
        json={
            "source_asset_id": asset_id,
            "settings": {
                "mode": "piano",
                "instrument": "piano",
                "tempo_mode": "manual",
                "manual_tempo_bpm": 120,
                "quantization": "sixteenth",
            },
        },
    )
    assert job.status_code == 202
    return headers, project_id, job.json()["id"]


def test_real_transcription_handler_end_to_end_cpu_onnx(client, db_session):
    """Real end-to-end test using actual Basic Pitch ONNX CPU inference (no mocks)."""
    user_headers, project_id, job_id = _create_remote_job(
        client, _synthesize_piano_arpeggio_wav(), worker_token="phase-b-real-token"
    )

    agent_http = httpx.Client(transport=client._transport, base_url="http://testserver")
    agent = RemoteWorkerAgent(
        api_base_url="http://testserver/api/v1",
        worker_token="phase-b-real-token",
        worker_id="win11-phase-b-cpu",
        http_client=agent_http,
    )
    assert isinstance(agent.handler, RealTranscriptionHandler)

    did_claim = agent.run_once()
    assert did_claim is True

    db_session.expire_all()
    job = db_session.query(TranscriptionJob).filter(TranscriptionJob.id == job_id).first()
    project = db_session.query(Project).filter(Project.id == project_id).first()
    score_row = db_session.query(ProjectScore).filter(ProjectScore.project_id == project_id).first()

    assert job.status == "completed"
    assert job.progress == 100
    assert project.status == "ready"
    assert score_row is not None
    assert score_row.musicxml_path is not None
    assert score_row.midi_path is not None

    # Verify /score returns genuine detected notes + raw timings + MusicXML
    score_resp = client.get(f"/api/v1/projects/{project_id}/score", headers=user_headers)
    assert score_resp.status_code == 200
    data = score_resp.json()
    notes = data["score_json"]["notes"]
    assert len(notes) >= 3
    assert notes[0]["raw_onset_sec"] is not None
    assert "<score-partwise" in data["musicxml"]

    # Verify exports work against persisted score & artifacts
    for fmt, magic in (("midi", b"MThd"), ("musicxml", b"<score-partwise"), ("pdf", b"%PDF"), ("wav", b"RIFF")):
        exp = client.post(f"/api/v1/projects/{project_id}/exports", headers=user_headers, json={"format": fmt})
        assert exp.status_code == 201
        dl = client.get(exp.json()["download_url"], headers=user_headers)
        assert dl.status_code == 200
        assert magic in dl.content[:512]


def test_real_transcription_handler_fails_honestly_on_silent_audio(client, db_session):
    """Silent audio produces zero notes -> job fails with NO_NOTES_DETECTED, project stays failed, no ProjectScore."""
    buf = io.BytesIO()
    sf.write(buf, np.zeros(22050, dtype=np.float32), 22050, format="WAV", subtype="PCM_16")
    user_headers, project_id, job_id = _create_remote_job(
        client, buf.getvalue(), worker_token="phase-b-silent-token"
    )

    agent_http = httpx.Client(transport=client._transport, base_url="http://testserver")
    agent = RemoteWorkerAgent(
        api_base_url="http://testserver/api/v1",
        worker_token="phase-b-silent-token",
        worker_id="win11-phase-b-cpu",
        http_client=agent_http,
    )
    assert agent.run_once() is True

    db_session.expire_all()
    job = db_session.query(TranscriptionJob).filter(TranscriptionJob.id == job_id).first()
    project = db_session.query(Project).filter(Project.id == project_id).first()
    assert job.status == "failed"
    assert job.error_code == "NO_NOTES_DETECTED"
    assert project.status == "failed"
    assert db_session.query(ProjectScore).filter(ProjectScore.project_id == project_id).count() == 0
    assert db_session.query(UsageRecord).filter(UsageRecord.user_id == job.user_id).count() == 0
    assert client.get(f"/api/v1/projects/{project_id}/score", headers=user_headers).status_code == 404


def test_real_transcription_handler_fails_fast_when_onnx_model_missing():
    """Missing ONNX model raises TranscriptionInferenceError rather than falling back to PhaseATestHandler."""
    with patch("app.worker_agent.resolve_onnx_model_path", side_effect=TranscriptionInferenceError("MODEL_NOT_FOUND", "Missing model")):
        with pytest.raises(TranscriptionInferenceError, match="Missing model"):
            RealTranscriptionHandler(api_base_url="http://testserver/api/v1")
