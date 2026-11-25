"""Regression tests for local video audio extraction and browser tab-audio WebM ingestion."""

from __future__ import annotations

import io
import json
import math
import shutil
import struct
import subprocess
import uuid
import wave
from pathlib import Path

import pytest

from app.audio.processor import MediaValidationError, preprocess_to_wav, probe_media
from app.models import MediaAsset, TranscriptionJob
from app.storage.service import storage_service

FFMPEG_AVAILABLE = shutil.which("ffmpeg") is not None


def _auth_headers(client, prefix: str = "vid_user") -> dict[str, str]:
    email = f"{prefix}_{uuid.uuid4().hex[:8]}@example.com"
    res = client.post(
        "/api/v1/auth/register",
        json={"email": email, "password": "StrongPassword123!", "display_name": "Video Tester"},
    )
    assert res.status_code in (200, 201), res.text
    return {"Authorization": f"Bearer {res.json()['access_token']}"}


def _create_project(client, headers: dict[str, str], title: str = "My Song") -> str:
    res = client.post(
        "/api/v1/projects",
        headers=headers,
        json={"title": title, "instrument": "piano", "transcription_mode": "single_instrument"},
    )
    assert res.status_code == 201, res.text
    return res.json()["id"]


def _make_wav_bytes(duration_sec: float = 0.5, sample_rate: int = 22050) -> bytes:
    buf = io.BytesIO()
    n_frames = int(duration_sec * sample_rate)
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        frames = bytearray()
        for i in range(n_frames):
            sample = int(12000 * math.sin(2 * math.pi * 440.0 * i / sample_rate))
            frames.extend(struct.pack("<h", sample))
        wf.writeframes(bytes(frames))
    return buf.getvalue()


def _generate_video_file(tmp_path: Path, ext: str, *, with_audio: bool = True, stereo: bool = True) -> Path:
    out_path = tmp_path / f"sample{ext}"
    cmd = [
        "ffmpeg",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=160x120:d=0.6:r=15",
    ]
    if with_audio:
        channels = "stereo" if stereo else "mono"
        cmd.extend(["-f", "lavfi", "-i", "sine=frequency=440:duration=0.6:sample_rate=44100", "-ac", "2" if stereo else "1"])
        if channels == "stereo":
            cmd.extend(["-af", "pan=stereo|c0=c0|c1=c0"])

    if ext in (".mp4", ".mov", ".mkv"):
        cmd.extend(["-c:v", "libx264", "-pix_fmt", "yuv420p", "-shortest"])
        if with_audio:
            cmd.extend(["-c:a", "aac"])
    elif ext == ".webm":
        cmd.extend(["-c:v", "libvpx", "-shortest"])
        if with_audio:
            cmd.extend(["-c:a", "libopus"])
    else:
        raise ValueError(f"Unsupported test fixture extension: {ext}")

    cmd.append(str(out_path))
    res = subprocess.run(cmd, capture_output=True, text=True, timeout=60, check=False)
    assert res.returncode == 0, f"ffmpeg fixture generation failed for {ext}: {res.stderr}"
    return out_path


def _generate_audio_webm_opus(tmp_path: Path, *, streamed: bool = False) -> Path:
    out_path = tmp_path / "tab-audio-1700000000.webm"
    if streamed:
        # Piping WebM to stdout omits the SeekHead/Duration header, mimicking MediaRecorder output
        res = subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:duration=0.7:sample_rate=48000",
                "-c:a",
                "libopus",
                "-f",
                "webm",
                "pipe:1",
            ],
            capture_output=True,
            timeout=60,
            check=False,
        )
        assert res.returncode == 0 and len(res.stdout) > 0
        out_path.write_bytes(res.stdout)
        return out_path

    res = subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=0.7:sample_rate=48000",
            "-c:a",
            "libopus",
            str(out_path),
        ],
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    assert res.returncode == 0, res.stderr
    return out_path


def _ffprobe_audio_stream(audio_bytes: bytes, suffix: str, tmp_path: Path) -> dict:
    probe_file = tmp_path / f"check_{uuid.uuid4().hex[:6]}{suffix}"
    probe_file.write_bytes(audio_bytes)
    res = subprocess.run(
        [
            "ffprobe",
            "-v",
            "quiet",
            "-print_format",
            "json",
            "-show_streams",
            str(probe_file),
        ],
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    assert res.returncode == 0, res.stderr
    data = json.loads(res.stdout)
    streams = [s for s in data.get("streams", []) if s.get("codec_type") == "audio"]
    assert len(streams) == 1
    return streams[0]


@pytest.mark.skipif(not FFMPEG_AVAILABLE, reason="FFmpeg binary not available")
@pytest.mark.parametrize(
    ("ext", "mime"),
    [
        (".mp4", "video/mp4"),
        (".mov", "video/quicktime"),
        (".webm", "video/webm"),
        (".mkv", "video/x-matroska"),
    ],
)
def test_extract_audio_from_supported_videos_produces_valid_mp3_and_wav(
    client, db_session, tmp_path: Path, ext: str, mime: str
):
    headers = _auth_headers(client, f"vid_{ext.strip('.')}")
    project_id = _create_project(client, headers, title="My Song")
    video_path = _generate_video_file(tmp_path, ext, with_audio=True, stereo=True)
    video_bytes = video_path.read_bytes()

    up_res = client.post(
        "/api/v1/uploads",
        headers=headers,
        data={"project_id": project_id},
        files={"file": (f"recording{ext}", video_bytes, mime)},
    )
    assert up_res.status_code == 201, up_res.text
    video_asset = up_res.json()

    ext_res = client.post(
        f"/api/v1/projects/{project_id}/media/{video_asset['id']}/extract-audio",
        headers=headers,
        json={"formats": ["mp3", "wav"]},
    )
    assert ext_res.status_code == 200, ext_res.text
    payload = ext_res.json()
    assert payload["source_asset_id"] == video_asset["id"]
    assert payload["mp3"]["filename"] == "My Song.mp3"
    assert payload["wav"]["filename"] == "My Song.wav"
    assert payload["mp3"]["sample_rate"] == 44100
    assert payload["wav"]["sample_rate"] == 44100
    assert payload["mp3"]["channels"] == 2
    assert payload["wav"]["channels"] == 2

    # Download MP3 & verify genuine MP3 codec + headers
    mp3_dl = client.get(payload["mp3"]["download_url"], headers=headers)
    assert mp3_dl.status_code == 200
    assert 'filename="My Song.mp3"' in mp3_dl.headers.get("content-disposition", "")
    assert mp3_dl.content.startswith(b"ID3") or (mp3_dl.content[0] == 0xFF and (mp3_dl.content[1] & 0xE0) == 0xE0)
    mp3_stream = _ffprobe_audio_stream(mp3_dl.content, ".mp3", tmp_path)
    assert mp3_stream["codec_name"] == "mp3"
    assert int(mp3_stream["sample_rate"]) == 44100
    assert int(mp3_stream["channels"]) == 2

    # Download WAV & verify 16-bit PCM RIFF/WAVE
    wav_dl = client.get(payload["wav"]["download_url"], headers=headers)
    assert wav_dl.status_code == 200
    assert 'filename="My Song.wav"' in wav_dl.headers.get("content-disposition", "")
    assert wav_dl.content[:4] == b"RIFF" and wav_dl.content[8:12] == b"WAVE"
    with wave.open(io.BytesIO(wav_dl.content), "rb") as wf:
        assert wf.getnchannels() == 2
        assert wf.getsampwidth() == 2
        assert wf.getframerate() == 44100
        assert wf.getnframes() > 0

    # Original video asset and stored bytes remain untouched
    db_session.expire_all()
    orig_row = db_session.query(MediaAsset).filter(MediaAsset.id == video_asset["id"]).first()
    assert orig_row is not None
    assert orig_row.size_bytes == len(video_bytes)
    assert storage_service.read_bytes(orig_row.storage_path) == video_bytes


@pytest.mark.skipif(not FFMPEG_AVAILABLE, reason="FFmpeg binary not available")
def test_sanitized_project_title_duplicate_guard_and_transcription_reuse(
    client, db_session, tmp_path: Path, monkeypatch
):
    headers = _auth_headers(client, "sanitize_vid")
    project_id = _create_project(client, headers, title="My Song: Live / Take 2?")
    video_path = _generate_video_file(tmp_path, ".mp4", with_audio=True, stereo=True)

    up_res = client.post(
        "/api/v1/uploads",
        headers=headers,
        data={"project_id": project_id},
        files={"file": ("clip.mp4", video_path.read_bytes(), "video/mp4")},
    )
    assert up_res.status_code == 201
    video_id = up_res.json()["id"]

    first = client.post(f"/api/v1/projects/{project_id}/media/{video_id}/extract-audio", headers=headers)
    assert first.status_code == 200, first.text
    second = client.post(f"/api/v1/projects/{project_id}/media/{video_id}/extract-audio", headers=headers)
    assert second.status_code == 200, second.text

    # No duplicate MediaAssets created
    assert first.json()["mp3"]["id"] == second.json()["mp3"]["id"]
    assert first.json()["wav"]["id"] == second.json()["wav"]["id"]
    assert first.json()["mp3"]["filename"] == "My Song Live Take 2.mp3"
    assert first.json()["wav"]["filename"] == "My Song Live Take 2.wav"

    extracted_rows = (
        db_session.query(MediaAsset)
        .filter(MediaAsset.project_id == project_id, MediaAsset.asset_type == "extracted_audio")
        .all()
    )
    assert len(extracted_rows) == 2

    # Extracted WAV & MP3 work with transcription preprocessing
    for row in extracted_rows:
        local_src = storage_service.get_local_file_path(row.storage_path)
        norm_out = tmp_path / f"norm_{row.id}.wav"
        meta = preprocess_to_wav(local_src, norm_out, target_sr=22050)
        assert meta.duration_seconds > 0.3

    # Start transcription using extracted WAV without re-uploading
    monkeypatch.setattr("app.api.v1.transcriptions.enqueue_transcription_job", lambda job_id: "test-task")
    wav_id = first.json()["wav"]["id"]
    job_res = client.post(
        f"/api/v1/projects/{project_id}/transcriptions",
        headers=headers,
        json={"source_asset_id": wav_id, "settings": {"instrument": "piano", "mode": "single_instrument"}},
    )
    assert job_res.status_code == 202, job_res.text
    assert job_res.json()["source_asset_id"] == wav_id

    # Clean up queued job
    job = db_session.query(TranscriptionJob).filter(TranscriptionJob.id == job_res.json()["id"]).first()
    if job:
        job.status = "cancelled"
        db_session.commit()


@pytest.mark.skipif(not FFMPEG_AVAILABLE, reason="FFmpeg binary not available")
def test_export_center_extracted_mp3_and_wav_without_score(client, tmp_path: Path):
    headers = _auth_headers(client, "export_vid")
    project_id = _create_project(client, headers, title="My Song")
    video_path = _generate_video_file(tmp_path, ".mp4", with_audio=True, stereo=True)

    up_res = client.post(
        "/api/v1/uploads",
        headers=headers,
        data={"project_id": project_id},
        files={"file": ("concert.mp4", video_path.read_bytes(), "video/mp4")},
    )
    assert up_res.status_code == 201

    for fmt, expected_name in (("extracted_mp3", "My Song.mp3"), ("extracted_wav", "My Song.wav")):
        exp_res = client.post(
            f"/api/v1/projects/{project_id}/exports",
            headers=headers,
            json={"format": fmt},
        )
        assert exp_res.status_code == 201, exp_res.text
        dl_res = client.get(exp_res.json()["download_url"], headers=headers)
        assert dl_res.status_code == 200
        assert f'filename="{expected_name}"' in dl_res.headers.get("content-disposition", "")
        assert len(dl_res.content) > 128


@pytest.mark.skipif(not FFMPEG_AVAILABLE, reason="FFmpeg binary not available")
def test_video_without_audio_corrupt_video_and_non_video_errors(client, db_session, tmp_path: Path):
    headers = _auth_headers(client, "err_vid")
    project_id = _create_project(client, headers, title="Error Cases")
    user_id = db_session.query(MediaAsset).count()  # unused, fetch project owner below
    _ = user_id

    # 1. Video without audio stream rejected on upload
    silent_mp4 = _generate_video_file(tmp_path, ".mp4", with_audio=False)
    up_silent = client.post(
        "/api/v1/uploads",
        headers=headers,
        data={"project_id": project_id},
        files={"file": ("silent.mp4", silent_mp4.read_bytes(), "video/mp4")},
    )
    assert up_silent.status_code == 400
    assert "no audio stream" in up_silent.json()["detail"].lower()

    # 2. Unsupported extension rejected on upload
    up_unsupported = client.post(
        "/api/v1/uploads",
        headers=headers,
        data={"project_id": project_id},
        files={"file": ("legacy.avi", b"RIFF0000AVI ", "video/x-msvideo")},
    )
    assert up_unsupported.status_code == 400

    # 3. Corrupt video rejected on upload
    up_corrupt = client.post(
        "/api/v1/uploads",
        headers=headers,
        data={"project_id": project_id},
        files={"file": ("broken.mp4", b"not-a-real-mp4-container", "video/mp4")},
    )
    assert up_corrupt.status_code == 400

    # 4. Ordinary audio file cannot run video extraction
    up_wav = client.post(
        "/api/v1/uploads",
        headers=headers,
        data={"project_id": project_id},
        files={"file": ("audio.wav", _make_wav_bytes(), "audio/wav")},
    )
    assert up_wav.status_code == 201
    wav_id = up_wav.json()["id"]
    non_vid_ext = client.post(f"/api/v1/projects/{project_id}/media/{wav_id}/extract-audio", headers=headers)
    assert non_vid_ext.status_code == 400

    # 5. Export Center extracted_mp3 fails cleanly for audio-only upload
    exp_non_vid = client.post(
        f"/api/v1/projects/{project_id}/exports",
        headers=headers,
        json={"format": "extracted_mp3"},
    )
    assert exp_non_vid.status_code == 400

    # 6. Direct extraction on stored silent-video or corrupt-video asset fails gracefully
    from app.models import Project

    proj = db_session.query(Project).filter(Project.id == project_id).first()
    silent_key = storage_service.build_key(proj.user_id, project_id, "originals", "silent_stored.mp4")
    storage_service.save_bytes(silent_key, silent_mp4.read_bytes(), content_type="video/mp4")
    silent_asset = MediaAsset(
        project_id=project_id,
        user_id=proj.user_id,
        asset_type="original",
        storage_path=silent_key,
        original_filename="silent_stored.mp4",
        mime_type="video/mp4",
        size_bytes=silent_mp4.stat().st_size,
    )
    corrupt_key = storage_service.build_key(proj.user_id, project_id, "originals", "corrupt_stored.mp4")
    storage_service.save_bytes(corrupt_key, b"corrupt-mp4-bytes", content_type="video/mp4")
    corrupt_asset = MediaAsset(
        project_id=project_id,
        user_id=proj.user_id,
        asset_type="original",
        storage_path=corrupt_key,
        original_filename="corrupt_stored.mp4",
        mime_type="video/mp4",
        size_bytes=17,
    )
    db_session.add_all([silent_asset, corrupt_asset])
    db_session.commit()

    silent_ext_res = client.post(
        f"/api/v1/projects/{project_id}/media/{silent_asset.id}/extract-audio",
        headers=headers,
    )
    assert silent_ext_res.status_code == 400
    assert "no audio stream" in silent_ext_res.json()["detail"].lower()

    corrupt_ext_res = client.post(
        f"/api/v1/projects/{project_id}/media/{corrupt_asset.id}/extract-audio",
        headers=headers,
    )
    assert corrupt_ext_res.status_code == 400


@pytest.mark.skipif(not FFMPEG_AVAILABLE, reason="FFmpeg binary not available")
def test_streamed_tab_audio_webm_opus_duration_probe_upload_and_transcription(
    client, db_session, tmp_path: Path, monkeypatch
):
    webm_path = _generate_audio_webm_opus(tmp_path, streamed=True)
    meta = probe_media(webm_path)
    assert meta.has_audio_stream is True
    assert meta.duration_seconds > 0.3

    # Also ensure probe_media raises NO_AUDIO_STREAM when no audio stream exists
    silent_mp4 = _generate_video_file(tmp_path, ".mp4", with_audio=False)
    with pytest.raises(MediaValidationError) as exc_info:
        probe_media(silent_mp4)
    assert exc_info.value.code == "NO_AUDIO_STREAM"

    headers = _auth_headers(client, "tab_webm")
    project_id = _create_project(client, headers, title="Tab Capture Song")
    up_res = client.post(
        "/api/v1/uploads",
        headers=headers,
        data={"project_id": project_id},
        files={"file": ("tab-audio-1700000000.webm", webm_path.read_bytes(), "audio/webm;codecs=opus")},
    )
    assert up_res.status_code == 201, up_res.text
    asset = up_res.json()
    assert asset["duration_seconds"] is not None and asset["duration_seconds"] > 0.3

    # Cannot run video extraction on tab-audio .webm
    ext_res = client.post(f"/api/v1/projects/{project_id}/media/{asset['id']}/extract-audio", headers=headers)
    assert ext_res.status_code == 400

    # Transcribe workflow succeeds with tab recording
    monkeypatch.setattr("app.api.v1.transcriptions.enqueue_transcription_job", lambda job_id: "test-task")
    job_res = client.post(
        f"/api/v1/projects/{project_id}/transcriptions",
        headers=headers,
        json={"source_asset_id": asset["id"], "settings": {"instrument": "piano", "mode": "single_instrument"}},
    )
    assert job_res.status_code == 202, job_res.text
    assert job_res.json()["source_asset_id"] == asset["id"]

    job = db_session.query(TranscriptionJob).filter(TranscriptionJob.id == job_res.json()["id"]).first()
    if job:
        job.status = "cancelled"
        db_session.commit()


@pytest.mark.skipif(not FFMPEG_AVAILABLE, reason="FFmpeg binary not available")
def test_delete_original_video_also_cleans_up_extracted_audio(client, db_session, tmp_path: Path):
    headers = _auth_headers(client, "cleanup_vid")
    project_id = _create_project(client, headers, title="Cleanup Song")
    video_path = _generate_video_file(tmp_path, ".mp4", with_audio=True)

    up_res = client.post(
        "/api/v1/uploads",
        headers=headers,
        data={"project_id": project_id},
        files={"file": ("video.mp4", video_path.read_bytes(), "video/mp4")},
    )
    assert up_res.status_code == 201
    video_id = up_res.json()["id"]

    ext_res = client.post(f"/api/v1/projects/{project_id}/media/{video_id}/extract-audio", headers=headers)
    assert ext_res.status_code == 200
    mp3_id = ext_res.json()["mp3"]["id"]
    wav_id = ext_res.json()["wav"]["id"]

    mp3_key = db_session.query(MediaAsset).filter(MediaAsset.id == mp3_id).first().storage_path
    wav_key = db_session.query(MediaAsset).filter(MediaAsset.id == wav_id).first().storage_path
    assert storage_service.exists(mp3_key)
    assert storage_service.exists(wav_key)

    del_res = client.delete(f"/api/v1/projects/{project_id}/media/{video_id}", headers=headers)
    assert del_res.status_code == 204
    assert not storage_service.exists(mp3_key)
    assert not storage_service.exists(wav_key)

    db_session.expire_all()
    assert db_session.query(MediaAsset).filter(MediaAsset.project_id == project_id).count() == 0
