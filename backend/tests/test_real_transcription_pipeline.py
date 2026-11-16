import io
import time

import numpy as np
import soundfile as sf


def _synthesize_piano_arpeggio_wav() -> bytes:
    """Generate a genuine 2.5s C-major arpeggio (C4, E4, G4, C5) WAV audio recording."""
    sr = 22050
    notes_hz = [261.63, 329.63, 392.00, 523.25]  # C4, E4, G4, C5
    note_dur = 0.55
    gap = 0.05
    segments = []
    for freq in notes_hz:
        t = np.linspace(0, note_dur, int(sr * note_dur), endpoint=False)
        env = np.minimum(1.0, t / 0.02) * np.exp(-3.0 * t)
        wave = (
            0.7 * np.sin(2 * np.pi * freq * t)
            + 0.2 * np.sin(2 * np.pi * 2 * freq * t)
            + 0.1 * np.sin(2 * np.pi * 3 * freq * t)
        ) * env * 0.6
        segments.append(wave.astype(np.float32))
        segments.append(np.zeros(int(sr * gap), dtype=np.float32))
    audio = np.concatenate(segments)
    buf = io.BytesIO()
    sf.write(buf, audio, sr, format="WAV", subtype="PCM_16")
    return buf.getvalue()


def test_real_ai_transcription_edit_and_exports(client):
    reg = client.post(
        "/api/v1/auth/register",
        json={"email": "composer@example.com", "password": "Password123!", "display_name": "Composer"},
    )
    assert reg.status_code == 201
    headers = {"Authorization": f"Bearer {reg.json()['access_token']}"}

    # 1. Create project
    p_res = client.post(
        "/api/v1/projects",
        headers=headers,
        json={"title": "C Major Arpeggio", "instrument": "piano", "transcription_mode": "single_instrument"},
    )
    assert p_res.status_code == 201
    project_id = p_res.json()["id"]

    # 2. Upload real synthesized WAV
    wav_bytes = _synthesize_piano_arpeggio_wav()
    up_res = client.post(
        "/api/v1/uploads",
        headers=headers,
        data={"project_id": project_id},
        files={"file": ("arpeggio.wav", wav_bytes, "audio/wav")},
    )
    assert up_res.status_code == 201, up_res.text
    asset_id = up_res.json()["id"]
    assert up_res.json()["duration_seconds"] > 2.0

    # 3. Start genuine AI transcription
    job_res = client.post(
        f"/api/v1/projects/{project_id}/transcriptions",
        headers=headers,
        json={
            "source_asset_id": asset_id,
            "settings": {
                "mode": "single_instrument",
                "instrument": "piano",
                "tempo_mode": "manual",
                "manual_tempo_bpm": 120,
                "quantization": "sixteenth",
            },
        },
    )
    assert job_res.status_code == 202, job_res.text
    job_id = job_res.json()["id"]

    # 4. Poll until completed (real Basic Pitch inference)
    final_job = None
    for _ in range(60):
        poll = client.get(f"/api/v1/transcriptions/{job_id}", headers=headers)
        assert poll.status_code == 200
        final_job = poll.json()
        if final_job["status"] in ("completed", "failed", "cancelled"):
            break
        time.sleep(0.5)

    assert final_job is not None
    assert final_job["status"] == "completed", f"Job failed: {final_job}"
    assert final_job["progress"] == 100

    # 5. Fetch generated score & MusicXML
    score_res = client.get(f"/api/v1/projects/{project_id}/score", headers=headers)
    assert score_res.status_code == 200
    score_payload = score_res.json()
    notes = score_payload["score_json"]["notes"]
    assert len(notes) >= 3, f"Expected >=3 detected notes from Basic Pitch, got {notes}"
    assert "<score-partwise" in score_payload["musicxml"]

    # Verify detected pitches include C4(60), E4(64), G4(67), or C5(72)
    detected_pitches = {n["pitch_midi"] for n in notes}
    assert len(detected_pitches & {60, 64, 67, 72}) >= 2, f"Unexpected pitches: {detected_pitches}"

    # 6. Edit a note and persist score
    edited_score = score_payload["score_json"]
    edited_score["notes"][0]["pitch_midi"] = 62  # D4
    save_res = client.put(
        f"/api/v1/projects/{project_id}/score",
        headers=headers,
        json={"expected_version": score_payload["version"], "score_json": edited_score},
    )
    assert save_res.status_code == 200
    assert save_res.json()["version"] == score_payload["version"] + 1

    # 7. Export MIDI, MusicXML, PDF, WAV
    expected_headers = {
        "midi": b"MThd",
        "musicxml": b"<score-partwise",
        "pdf": b"%PDF",
        "wav": b"RIFF",
    }
    for fmt in ("midi", "musicxml", "pdf", "wav"):
        exp_res = client.post(
            f"/api/v1/projects/{project_id}/exports",
            headers=headers,
            json={"format": fmt},
        )
        assert exp_res.status_code == 201, f"Export {fmt} failed: {exp_res.text}"
        exp_data = exp_res.json()
        assert exp_data["status"] == "completed"
        dl = client.get(exp_data["download_url"], headers=headers)
        assert dl.status_code == 200
        assert len(dl.content) > 30
        assert expected_headers[fmt] in dl.content[:512]
