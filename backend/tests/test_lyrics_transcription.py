"""Tests for automatic song lyrics recognition, alignment, exports, and YouTube URL validation."""

from __future__ import annotations

import builtins
import sys
import types
import xml.etree.ElementTree as ET
from pathlib import Path
from types import SimpleNamespace

import httpx

from app.models import MediaAsset, Project, ProjectScore, TranscriptionJob
from app.notation.generator import build_score_data, score_data_to_musicxml
from app.notation.lyrics_alignment import align_lyrics_to_notes
from app.schemas.lyrics import LyricsData, LyricSegment, LyricWord
from app.transcription.base import DetectedNote
from app.transcription.lyrics import (
    LyricsTranscriptionError,
    format_lyrics_export,
    transcribe_lyrics,
)


def _auth_headers(client, email: str) -> tuple[dict[str, str], str]:
    reg = client.post(
        "/api/v1/auth/register",
        json={"email": email, "password": "Password123!", "display_name": "Lyrics Tester"},
    )
    if reg.status_code == 201:
        data = reg.json()
    else:
        login = client.post("/api/v1/auth/login", json={"email": email, "password": "Password123!"})
        assert login.status_code == 200
        data = login.json()
    return {"Authorization": f"Bearer {data['access_token']}"}, data["user"]["id"]


def test_transcribe_lyrics_mocked_whisper_word_timestamps_and_unicode(tmp_path: Path, monkeypatch):
    audio = tmp_path / "vocals.wav"
    audio.write_bytes(b"RIFF\x00\x00\x00\x00WAVEfmt ")

    class _FakeWhisperModel:
        def __init__(self, model_size, device="cpu", compute_type="int8", download_root=None):
            self.model_size = model_size

        def transcribe(self, path, **kwargs):
            segs = [
                SimpleNamespace(
                    text="Mahal kita corazón",
                    start=0.5,
                    end=2.1,
                    avg_logprob=-0.25,
                    no_speech_prob=0.05,
                    words=[
                        SimpleNamespace(word="Mahal", start=0.5, end=0.95, probability=0.92),
                        SimpleNamespace(word="kita", start=1.0, end=1.45, probability=0.90),
                        SimpleNamespace(word="corazón", start=1.5, end=2.1, probability=0.88),
                    ],
                ),
                SimpleNamespace(
                    text="La la la",
                    start=2.5,
                    end=4.0,
                    avg_logprob=-1.4,
                    no_speech_prob=0.1,
                    words=[],
                ),
            ]
            info = SimpleNamespace(language="tl", language_probability=0.87)
            return iter(segs), info

    fake_fw = types.ModuleType("faster_whisper")
    fake_fw.WhisperModel = _FakeWhisperModel  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "faster_whisper", fake_fw)

    res = transcribe_lyrics(
        audio,
        model_name="small",
        source_used="vocals_stem",
        demucs_requested=True,
        cache_dir=tmp_path / "whisper_cache",
        device="cpu",
    )
    assert res.language == "tl"
    assert res.language_probability == 0.87
    assert res.source_used == "vocals_stem"
    assert res.has_word_timestamps is True
    assert "corazón" in res.text
    assert len(res.segments) == 2
    assert res.segments[0].needs_review is False
    assert res.segments[1].needs_review is True
    assert len(res.uncertain_segments) == 1


def test_transcribe_lyrics_without_word_timestamps_does_not_fabricate(tmp_path: Path, monkeypatch):
    audio = tmp_path / "song.wav"
    audio.write_bytes(b"RIFF\x00\x00\x00\x00WAVEfmt ")

    class _SegOnlyModel:
        def __init__(self, *args, **kwargs):
            pass

        def transcribe(self, path, **kwargs):
            segs = [
                SimpleNamespace(text="First chorus line", start=1.0, end=3.0, avg_logprob=-0.3, no_speech_prob=0.0, words=[]),
                SimpleNamespace(text="First chorus line", start=5.0, end=7.0, avg_logprob=-0.3, no_speech_prob=0.0, words=[]),
            ]
            return iter(segs), SimpleNamespace(language="en", language_probability=0.95)

    fake_fw = types.ModuleType("faster_whisper")
    fake_fw.WhisperModel = _SegOnlyModel  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "faster_whisper", fake_fw)

    res = transcribe_lyrics(audio, cache_dir=tmp_path / "cache", device="cpu")
    assert res.has_word_timestamps is False
    assert len(res.segments) == 2
    assert res.segments[0].words == []
    assert res.segments[0].start_sec == 1.0


def test_transcribe_lyrics_missing_whisper_raises_actionable_error(tmp_path: Path, monkeypatch):
    audio = tmp_path / "song.wav"
    audio.write_bytes(b"RIFF\x00\x00\x00\x00WAVEfmt ")

    real_import = builtins.__import__

    def _fake_import(name, *args, **kwargs):
        if name.startswith("faster_whisper"):
            raise ImportError("No module named 'faster_whisper'")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", _fake_import)
    monkeypatch.setattr("app.transcription.lyrics._find_isolated_whisper_python", lambda: None)

    try:
        transcribe_lyrics(audio, cache_dir=tmp_path / "cache", device="cpu")
        raise AssertionError("Expected LyricsTranscriptionError")
    except LyricsTranscriptionError as exc:
        assert exc.code == "WHISPER_NOT_INSTALLED"


def test_lyrics_alignment_and_musicxml_embedding_independent_of_chords():
    notes = [
        DetectedNote(pitch_midi=64, onset_sec=0.0, offset_sec=0.45, velocity=92, confidence=0.95),
        DetectedNote(pitch_midi=65, onset_sec=0.5, offset_sec=0.95, velocity=92, confidence=0.95),
        DetectedNote(pitch_midi=67, onset_sec=1.0, offset_sec=1.45, velocity=92, confidence=0.95),
        DetectedNote(pitch_midi=69, onset_sec=1.5, offset_sec=1.95, velocity=92, confidence=0.95),
    ]
    lyrics = LyricsData(
        text="Amazing grace",
        segments=[
            LyricSegment(
                id="seg_1",
                text="Amazing grace",
                start_sec=0.0,
                end_sec=1.9,
                words=[
                    LyricWord(text="Amazing", start_sec=0.0, end_sec=1.4, confidence=0.9),
                    LyricWord(text="grace", start_sec=1.5, end_sec=1.9, confidence=0.9),
                ],
            )
        ],
        has_word_timestamps=True,
    )

    score = build_score_data(
        title="Lyrics Sync Test",
        detected_notes=notes,
        tempo_bpm=120.0,
        tempo_estimated=False,
        time_signature="4/4",
        time_signature_estimated=False,
        key_signature="C",
        key_signature_estimated=False,
        duration_seconds=2.0,
        instrument="vocals",
        clef_override="treble",
        track_name_override="Vocal Melody",
        monophonic=True,
        analysis={"mode": "melody", "lyrics": lyrics.model_dump()},
    )
    alignment = align_lyrics_to_notes(lyrics, score.notes)
    assert alignment.matched_count >= 3

    xml_str = score_data_to_musicxml(score, include_chords=False, include_lyrics=True)
    root = ET.fromstring(xml_str)
    lyric_elems = root.findall(".//note/lyric")
    assert len(lyric_elems) >= 3
    assert root.findall(".//harmony") == []


def test_format_lyrics_export_formats():
    lyrics = LyricsData(
        text="Hello world\nSecond line",
        segments=[
            LyricSegment(id="s1", text="Hello world", start_sec=1.25, end_sec=3.5),
            LyricSegment(id="s2", text="Second line", start_sec=4.0, end_sec=6.75),
        ],
    )
    txt, _, ext1 = format_lyrics_export(lyrics, "txt")
    assert ext1 == "txt"
    assert "Hello world" in txt

    ts_txt, _, ext2 = format_lyrics_export(lyrics, "timestamped_txt")
    assert ext2 == "txt"
    assert "[00:01.25 -> 00:03.50] Hello world" in ts_txt

    srt, _, ext3 = format_lyrics_export(lyrics, "srt")
    assert ext3 == "srt"
    assert "00:00:01,250 --> 00:00:03,500" in srt


def test_lyrics_api_persistence_manual_edit_protection_and_export(client, db_session, monkeypatch):
    headers, user_id = _auth_headers(client, "lyrics_api@scribasheet.dev")
    project = Project(
        user_id=user_id,
        title="Lyrics API Song",
        instrument="vocals",
        transcription_mode="piano_vocal",
        status="ready",
    )
    db_session.add(project)
    db_session.commit()
    db_session.refresh(project)

    asset = MediaAsset(
        project_id=project.id,
        user_id=user_id,
        asset_type="original",
        storage_path="unused/song.wav",
        original_filename="song.wav",
        mime_type="audio/wav",
        size_bytes=1024,
        duration_seconds=4.0,
    )
    db_session.add(asset)
    db_session.commit()

    # Save manual lyric edit
    put_res = client.put(
        f"/api/v1/projects/{project.id}/lyrics",
        headers=headers,
        json={"text": "Custom corrected lyric", "language": "en"},
    )
    assert put_res.status_code == 200
    assert put_res.json()["manually_edited"] is True

    # Export .srt
    exp_res = client.get(f"/api/v1/projects/{project.id}/lyrics/export?format=srt", headers=headers)
    assert exp_res.status_code == 200
    assert "Custom corrected lyric" in exp_res.text

    # Queue lyrics transcription job in remote_worker mode
    monkeypatch.setenv("JOB_EXECUTION_MODE", "remote_worker")
    monkeypatch.setenv("WORKER_API_TOKEN", "lyrics-worker-token")
    from app.core.config import get_settings

    get_settings.cache_clear()
    q_res = client.post(
        f"/api/v1/projects/{project.id}/lyrics/transcribe",
        headers=headers,
        json={"enable_source_separation": False, "force_overwrite": False},
    )
    assert q_res.status_code == 202
    job_id = q_res.json()["id"]

    # Simulate worker completion without force_overwrite -> manual edits must NOT be overwritten
    claim_res = client.post(
        "/api/v1/worker/jobs/claim",
        headers={"X-Worker-Token": "lyrics-worker-token"},
        json={"worker_id": "win-lyrics-test"},
    )
    assert claim_res.status_code == 200

    comp_res = client.post(
        f"/api/v1/worker/jobs/{job_id}/complete",
        headers={"X-Worker-Token": "lyrics-worker-token"},
        json={
            "worker_id": "win-lyrics-test",
            "is_simulated": False,
            "duration_seconds": 4.0,
            "metadata_json": {
                "handler": "lyrics_whisper",
                "lyrics": LyricsData(text="Auto overwrite attempt", language="en").model_dump(),
            },
        },
    )
    assert comp_res.status_code == 200

    get_res = client.get(f"/api/v1/projects/{project.id}/lyrics", headers=headers)
    assert get_res.status_code == 200
    assert get_res.json()["text"] == "Custom corrected lyric"

    # Clean up job row
    db_session.query(TranscriptionJob).filter(TranscriptionJob.id == job_id).delete()
    db_session.query(ProjectScore).filter(ProjectScore.project_id == project.id).delete()
    db_session.commit()


def test_youtube_url_check_metadata_and_validation(client, monkeypatch):
    headers, _ = _auth_headers(client, "yt_check@scribasheet.dev")

    def _fake_oembed_get(url, params=None, timeout=3.0):
        return httpx.Response(200, json={"title": "Demo Pop Song", "author_name": "Demo Artist"})

    monkeypatch.setattr(httpx, "get", _fake_oembed_get)
    res = client.post(
        "/api/v1/uploads/url-check",
        headers=headers,
        json={"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["supported"] is False
    assert body["is_youtube"] is True
    assert body["video_id"] == "dQw4w9WgXcQ"
    assert body["title"] == "Demo Pop Song"

    bad = client.post(
        "/api/v1/uploads/url-check",
        headers=headers,
        json={"url": "https://www.youtube.com/watch"},
    )
    assert bad.status_code == 400
