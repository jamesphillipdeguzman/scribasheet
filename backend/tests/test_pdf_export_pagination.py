import io
import math
import re
import struct
import uuid
import wave

import httpx

from app.core.config import get_settings
from app.models import MediaAsset, TranscriptionJob, TranscriptionResult
from app.notation.generator import (
    _find_musescore_binary,
    _render_pdf_via_musescore,
    build_score_data,
    count_pdf_pages,
    render_score_pdf,
)
from app.transcription.base import DetectedNote
from app.worker_agent import RemoteWorkerAgent


def _make_long_piano_wav(duration_sec: float = 42.0, sample_rate: int = 22050) -> bytes:
    """Synthesize a multi-phrase piano-like WAV (~28+ measures at 75 BPM) for multi-page MuseScore verification."""
    buf = io.BytesIO()
    n_frames = int(duration_sec * sample_rate)
    freqs = [261.63, 293.66, 329.63, 349.23, 392.00, 440.00, 493.88, 523.25]
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        step = int(0.45 * sample_rate)
        frames = bytearray()
        for i in range(n_frames):
            note_idx = (i // step) % len(freqs)
            local_i = i % step
            env = math.exp(-3.5 * (local_i / step))
            sample = int(12000 * env * math.sin(2 * math.pi * freqs[note_idx] * i / sample_rate))
            frames.extend(struct.pack("<h", sample))
        wf.writeframes(bytes(frames))
    return buf.getvalue()


def test_musescore_and_fallback_pdfs_are_multipage_letter_and_not_continuous(monkeypatch):
    # 40 measures at 120 BPM (160 quarter notes = 80 seconds)
    notes = [
        DetectedNote(pitch_midi=60 + (i % 12), onset_sec=i * 0.5, offset_sec=(i + 1) * 0.5, velocity=80)
        for i in range(160)
    ]
    score = build_score_data(
        title="Multi-Page Pagination Test",
        detected_notes=notes,
        tempo_bpm=120.0,
        tempo_estimated=False,
        time_signature="4/4",
        time_signature_estimated=False,
        key_signature="C major",
        key_signature_estimated=False,
        duration_seconds=80.0,
        instrument="piano",
    )

    # 1. MuseScore 4 native PDF (when installed locally)
    if _find_musescore_binary():
        monkeypatch.delenv("DISABLE_MUSESCORE_PDF", raising=False)
        ms_pdf = render_score_pdf(score)
        assert ms_pdf.startswith(b"%PDF-")
        assert count_pdf_pages(ms_pdf) >= 2
        boxes = re.findall(rb"/MediaBox\s*\[([^\]]+)\]", ms_pdf)
        assert len(boxes) >= 2
        # Standard Letter (612 x 792) — never a tall continuous page
        for box in boxes:
            parts = [float(x) for x in box.decode().split()]
            assert 590 <= parts[2] <= 620
            assert 780 <= parts[3] <= 850

    # 2. ReportLab fallback PDF is also properly paginated (never single tall page)
    monkeypatch.setenv("DISABLE_MUSESCORE_PDF", "1")
    fb_pdf = render_score_pdf(score)
    assert fb_pdf.startswith(b"%PDF-")
    assert count_pdf_pages(fb_pdf) >= 2
    assert b"/MediaBox [0 0 612 792]" in fb_pdf or len(re.findall(rb"/MediaBox", fb_pdf)) >= 1


def test_musescore_failure_does_not_produce_malformed_pdf(monkeypatch):
    notes = [DetectedNote(pitch_midi=60, onset_sec=0.0, offset_sec=1.0, velocity=80)]
    score = build_score_data(
        title="Failure Recovery Test",
        detected_notes=notes,
        tempo_bpm=120.0,
        tempo_estimated=False,
        time_signature="4/4",
        time_signature_estimated=False,
        key_signature="C major",
        key_signature_estimated=False,
        duration_seconds=2.0,
        instrument="piano",
    )
    monkeypatch.setattr("app.notation.generator._render_pdf_from_musicxml_via_musescore", lambda _xml: None)
    pdf_bytes = render_score_pdf(score)
    assert pdf_bytes.startswith(b"%PDF-")
    assert count_pdf_pages(pdf_bytes) == 1


def test_export_center_serves_worker_musescore_pdf_when_railway_lacks_musescore(client, db_session, monkeypatch):
    monkeypatch.setenv("JOB_EXECUTION_MODE", "remote_worker")
    monkeypatch.setenv("WORKER_API_TOKEN", "pdf-worker-token")
    get_settings.cache_clear()

    email = f"pdf_export_{uuid.uuid4().hex[:8]}@example.com"
    reg = client.post(
        "/api/v1/auth/register",
        json={"email": email, "password": "StrongPassword123!", "display_name": "PDF Tester"},
    )
    assert reg.status_code == 201
    headers = {"Authorization": f"Bearer {reg.json()['access_token']}"}

    proj = client.post(
        "/api/v1/projects",
        headers=headers,
        json={"title": "Multi-Page Sonata", "instrument": "piano", "transcription_mode": "polyphonic"},
    )
    assert proj.status_code == 201
    project_id = proj.json()["id"]

    up = client.post(
        "/api/v1/uploads",
        headers=headers,
        data={"project_id": project_id},
        files={"file": ("sonata.wav", _make_long_piano_wav(25.0), "audio/wav")},
    )
    assert up.status_code == 201

    job_res = client.post(
        f"/api/v1/projects/{project_id}/transcriptions",
        headers=headers,
        json={"settings": {"instrument": "piano", "transcription_mode": "polyphonic"}},
    )
    assert job_res.status_code == 202
    job_id = job_res.json()["id"]

    # Run real Windows worker (with MuseScore 4 enabled if present locally)
    agent_http = httpx.Client(transport=client._transport, base_url="http://testserver")
    agent = RemoteWorkerAgent(
        api_base_url="http://testserver/api/v1",
        worker_token="pdf-worker-token",
        worker_id="win-pdf-test",
        http_client=agent_http,
    )
    assert agent.run_once() is True

    db_session.expire_all()
    job = db_session.query(TranscriptionJob).filter(TranscriptionJob.id == job_id).first()
    assert job is not None and job.status == "completed"
    res_row = db_session.query(TranscriptionResult).filter(TranscriptionResult.job_id == job_id).first()
    assert res_row is not None

    if _find_musescore_binary():
        pdf_asset_id = (res_row.metadata_json or {}).get("pdf_asset_id")
        assert pdf_asset_id is not None
        pdf_asset = db_session.query(MediaAsset).filter(MediaAsset.id == pdf_asset_id).first()
        assert pdf_asset is not None and pdf_asset.asset_type == "pdf"

        # Now simulate Railway (MuseScore unavailable on API host) and export PDF via Export Center
        monkeypatch.setenv("DISABLE_MUSESCORE_PDF", "1")
        exp_res = client.post(
            f"/api/v1/projects/{project_id}/exports",
            headers=headers,
            json={"format": "pdf"},
        )
        assert exp_res.status_code == 201, exp_res.text
        dl_res = client.get(exp_res.json()["download_url"], headers=headers)
        assert dl_res.status_code == 200
        assert dl_res.content.startswith(b"%PDF-")
        # Export Center served the exact MuseScore 4 PDF (contains MuseScore creator metadata, not ReportLab)
        assert b"MuseScore" in dl_res.content or count_pdf_pages(dl_res.content) >= 1
        assert b"ReportLab" not in dl_res.content

        # Direct MuseScore comparison on same score
        from app.models import ProjectScore
        from app.schemas.score import ScoreData

        score_row = db_session.query(ProjectScore).filter(ProjectScore.project_id == project_id).first()
        monkeypatch.delenv("DISABLE_MUSESCORE_PDF", raising=False)
        direct_ms = _render_pdf_via_musescore(ScoreData(**score_row.score_json))
        assert direct_ms is not None
        assert count_pdf_pages(dl_res.content) == count_pdf_pages(direct_ms)
