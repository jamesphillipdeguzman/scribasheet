import base64
import io
import xml.etree.ElementTree as ET

from pypdf import PdfReader

from app.core.config import get_settings
from app.models import MediaAsset, ProjectScore, TranscriptionJob
from app.notation.generator import (
    apply_scribasheet_musicxml_branding,
    render_score_pdf,
    resolve_project_score_title,
)
from app.schemas.score import ScoreData, ScoreNote, ScoreTrack
from app.storage.service import storage_service


def _register_and_auth(client, email: str) -> dict[str, str]:
    reg = client.post(
        "/api/v1/auth/register",
        json={"email": email, "password": "Password123!", "display_name": "James De Guzman"},
    )
    assert reg.status_code == 201
    token = reg.json()["access_token"]
    return {"Authorization": f"Bearer {token}"}


def test_resolve_project_score_title_rules():
    assert resolve_project_score_title("Na Para Bang on Youtube") == "Na Para Bang on Youtube"
    assert resolve_project_score_title("Go Tell It On The Mountain.Pdf") == "Go Tell It On The Mountain"
    assert resolve_project_score_title("") == "Untitled Score"
    assert resolve_project_score_title("   ") == "Untitled Score"
    assert resolve_project_score_title("Untitled Project") == "Untitled Score"
    assert resolve_project_score_title("New Transcription") == "Untitled Score"
    assert resolve_project_score_title("tab-audio-1795613137526-trimmed.wav") == "Untitled Score"
    assert resolve_project_score_title("mic-recording-1700000000.webm") == "Untitled Score"


def test_worker_claim_and_complete_enforce_project_title_over_media_filename(client, db_session, monkeypatch):
    monkeypatch.setenv("WORKER_API_TOKEN", "test-worker-token-title")
    get_settings.cache_clear()
    try:
        headers = _register_and_auth(client, "worker_title@example.com")
        proj = client.post(
            "/api/v1/projects",
            headers=headers,
            json={"title": "Na Para Bang on Youtube", "instrument": "piano", "transcription_mode": "melody"},
        ).json()
        project_id = proj["id"]
        user_id = proj["user_id"]

        media_key = storage_service.build_key(user_id, project_id, "originals", "tab-audio-1795613137526-trimmed.wav")
        storage_service.save_bytes(media_key, b"RIFF0000WAVEfmt ", content_type="audio/wav")
        asset = MediaAsset(
            project_id=project_id,
            user_id=user_id,
            asset_type="original",
            storage_path=media_key,
            original_filename="tab-audio-1795613137526-trimmed.wav",
            mime_type="audio/wav",
            size_bytes=16,
            duration_seconds=12.0,
        )
        db_session.add(asset)
        db_session.flush()

        job = TranscriptionJob(
            project_id=project_id,
            user_id=user_id,
            source_asset_id=asset.id,
            status="queued",
            settings_json={"mode": "melody", "instrument": "piano"},
        )
        db_session.add(job)
        db_session.commit()

        worker_headers = {"X-Worker-Token": "test-worker-token-title"}
        claim_res = client.post(
            "/api/v1/worker/jobs/claim",
            headers=worker_headers,
            json={"worker_id": "win-worker-1"},
        )
        assert claim_res.status_code == 200
        claimed_job = claim_res.json()["job"]
        assert claimed_job["project_title"] == "Na Para Bang on Youtube"
        assert claimed_job["source_filename"] == "tab-audio-1795613137526-trimmed.wav"

        stale_xml = """<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <work><work-title>Tab Audio 1795613137526 Trimmed</work-title></work>
  <movement-title>Tab Audio 1795613137526 Trimmed</movement-title>
  <identification><creator type="composer">Music21</creator><rights>Copyright (c) 2026</rights></identification>
  <part-list><score-part id="P1"><part-name>Lead Melody</part-name></score-part></part-list>
  <part id="P1"><measure number="1"><note><pitch><step>G</step><octave>4</octave></pitch><duration>4</duration><type>whole</type></note></measure></part>
</score-partwise>"""

        complete_res = client.post(
            f"/api/v1/worker/jobs/{claimed_job['id']}/complete",
            headers=worker_headers,
            json={
                "worker_id": "win-worker-1",
                "duration_seconds": 12.0,
                "score_json": {
                    "title": "Tab Audio 1795613137526 Trimmed",
                    "tempo_bpm": 91.0,
                    "tempo_estimated": False,
                    "time_signature": "4/4",
                    "time_signature_estimated": False,
                    "key_signature": "Bb major",
                    "key_signature_estimated": False,
                    "duration_seconds": 12.0,
                    "tracks": [{"index": 0, "name": "Lead Melody", "instrument": "piano", "clef": "treble", "program": 0, "muted": False}],
                    "notes": [{"id": "n1", "pitch_midi": 67, "onset_sec": 0.0, "offset_sec": 0.5, "velocity": 80, "track_index": 0}],
                    "chords": [],
                },
                "midi_base64": base64.b64encode(b"MThd\x00\x00\x00\x06\x00\x00\x00\x01\x00`").decode("ascii"),
                "musicxml_content": stale_xml,
            },
        )
        assert complete_res.status_code == 200

        # Score API must return project.title while media.original_filename stays separated & intact
        score_res = client.get(f"/api/v1/projects/{project_id}/score", headers=headers)
        assert score_res.status_code == 200
        score_body = score_res.json()
        assert score_body["score_json"]["title"] == "Na Para Bang on Youtube"
        xml_root = ET.fromstring(score_body["musicxml"])
        assert xml_root.findtext("./work/work-title") == "Na Para Bang on Youtube"
        assert xml_root.findtext("./movement-title") == "Na Para Bang on Youtube"
        assert xml_root.findtext("./identification/rights") == "Copyright (c) 2026"

        proj_res = client.get(f"/api/v1/projects/{project_id}", headers=headers)
        assert proj_res.status_code == 200
        orig_assets = [a for a in proj_res.json()["media_assets"] if a["asset_type"] == "original"]
        assert orig_assets[0]["original_filename"] == "tab-audio-1795613137526-trimmed.wav"
    finally:
        get_settings.cache_clear()


def test_rename_updates_score_musicxml_and_exports_without_retranscription(client, db_session, monkeypatch):
    monkeypatch.setenv("DISABLE_MUSESCORE_PDF", "1")
    headers = _register_and_auth(client, "rename_export@example.com")
    proj = client.post(
        "/api/v1/projects",
        headers=headers,
        json={"title": "Na Para Bang on Youtube", "instrument": "piano", "transcription_mode": "melody"},
    ).json()
    project_id = proj["id"]
    user_id = proj["user_id"]

    # Seed an existing legacy score whose stored XML & score_json mistakenly hold the media filename
    legacy_xml = """<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <work><work-title>tab-audio-1795613137526-trimmed.wav</work-title></work>
  <movement-title>tab-audio-1795613137526-trimmed.wav</movement-title>
  <identification>
    <creator type="composer">ScribaSheet</creator>
    <creator type="arranger">Test Arranger</creator>
    <rights>Copyright (c) 2026</rights>
  </identification>
  <part-list><score-part id="P1"><part-name>Lead Melody</part-name></score-part></part-list>
  <part id="P1"><measure number="1"><note><pitch><step>D</step><octave>4</octave></pitch><duration>4</duration><type>whole</type></note></measure></part>
</score-partwise>"""
    xml_key = storage_service.build_key(user_id, project_id, "musicxml", "score.musicxml")
    storage_service.save_bytes(xml_key, legacy_xml.encode("utf-8"), content_type="application/vnd.recordare.musicxml+xml")

    orig_key = storage_service.build_key(user_id, project_id, "originals", "tab-audio-1795613137526-trimmed.wav")
    storage_service.save_bytes(orig_key, b"RIFF0000WAVEfmt ", content_type="audio/wav")
    db_session.add(
        MediaAsset(
            project_id=project_id,
            user_id=user_id,
            asset_type="original",
            storage_path=orig_key,
            original_filename="tab-audio-1795613137526-trimmed.wav",
            mime_type="audio/wav",
            size_bytes=16,
        )
    )
    db_session.add(
        ProjectScore(
            project_id=project_id,
            version=1,
            score_json={
                "title": "Tab Audio 1795613137526 Trimmed",
                "tempo_bpm": 91.0,
                "time_signature": "4/4",
                "key_signature": "Bb major",
                "duration_seconds": 4.0,
                "tracks": [{"index": 0, "name": "Lead Melody", "instrument": "piano", "clef": "treble", "program": 0, "muted": False}],
                "notes": [{"id": "n1", "pitch_midi": 62, "onset_sec": 0.0, "offset_sec": 1.0, "velocity": 80, "track_index": 0}],
                "chords": [],
            },
            musicxml_path=xml_key,
        )
    )
    db_session.commit()

    # Reopening project displays authoritative project.title rather than timestamped media filename
    s1 = client.get(f"/api/v1/projects/{project_id}/score", headers=headers).json()
    assert s1["score_json"]["title"] == "Na Para Bang on Youtube"
    r1 = ET.fromstring(s1["musicxml"])
    assert r1.findtext("./work/work-title") == "Na Para Bang on Youtube"
    assert r1.findtext("./movement-title") == "Na Para Bang on Youtube"

    # Rename project without re-transcription
    patch_res = client.patch(
        f"/api/v1/projects/{project_id}",
        headers=headers,
        json={"title": "Na Para Bang Live"},
    )
    assert patch_res.status_code == 200
    assert patch_res.json()["title"] == "Na Para Bang Live"

    # Re-read persisted score + storage XML -> immediately updated, notes & metadata preserved
    s2 = client.get(f"/api/v1/projects/{project_id}/score", headers=headers).json()
    assert s2["version"] == 2
    assert s2["score_json"]["title"] == "Na Para Bang Live"
    assert s2["score_json"]["key_signature"] == "Bb major"
    assert s2["score_json"]["notes"][0]["pitch_midi"] == 62
    r2 = ET.fromstring(s2["musicxml"])
    assert r2.findtext("./work/work-title") == "Na Para Bang Live"
    assert r2.findtext("./movement-title") == "Na Para Bang Live"
    assert r2.findtext("./identification/creator[@type='arranger']") == "Test Arranger"
    assert r2.findtext("./identification/rights") == "Copyright (c) 2026"

    # Original media filename remains preserved
    assets = client.get(f"/api/v1/projects/{project_id}", headers=headers).json()["media_assets"]
    assert assets[0]["original_filename"] == "tab-audio-1795613137526-trimmed.wav"

    # Exports reflect updated project title and clean download filenames
    xml_exp = client.post(f"/api/v1/projects/{project_id}/exports", headers=headers, json={"format": "musicxml"}).json()
    xml_dl = client.get(xml_exp["download_url"], headers=headers)
    assert "Na_Para_Bang_Live.musicxml" in xml_dl.headers.get("content-disposition", "")
    exp_root = ET.fromstring(xml_dl.text)
    assert exp_root.findtext("./work/work-title") == "Na Para Bang Live"
    assert exp_root.findtext("./movement-title") == "Na Para Bang Live"

    pdf_exp = client.post(f"/api/v1/projects/{project_id}/exports", headers=headers, json={"format": "pdf"}).json()
    pdf_dl = client.get(pdf_exp["download_url"], headers=headers)
    assert "Na_Para_Bang_Live.pdf" in pdf_dl.headers.get("content-disposition", "")
    reader = PdfReader(io.BytesIO(pdf_dl.content))
    page1_txt = reader.pages[0].extract_text()
    assert "Na Para Bang Live" in page1_txt
    assert "Tab Audio" not in page1_txt


def test_generic_title_exports_as_untitled_score_without_duplicates(client, db_session, monkeypatch):
    monkeypatch.setenv("DISABLE_MUSESCORE_PDF", "1")
    headers = _register_and_auth(client, "generic_title@example.com")
    proj = client.post(
        "/api/v1/projects",
        headers=headers,
        json={"title": "Untitled Project", "instrument": "piano", "transcription_mode": "piano"},
    ).json()
    project_id = proj["id"]

    db_session.add(
        ProjectScore(
            project_id=project_id,
            version=1,
            score_json={
                "title": "tab-audio-123456.webm",
                "tempo_bpm": 100.0,
                "time_signature": "4/4",
                "key_signature": "C major",
                "duration_seconds": 2.0,
                "tracks": [{"index": 0, "name": "Piano", "instrument": "piano", "clef": "grand", "program": 0, "muted": False}],
                "notes": [{"id": "n1", "pitch_midi": 60, "onset_sec": 0.0, "offset_sec": 1.0, "velocity": 80, "track_index": 0}],
                "chords": [],
            },
        )
    )
    db_session.commit()

    xml_exp = client.post(f"/api/v1/projects/{project_id}/exports", headers=headers, json={"format": "musicxml"}).json()
    xml_dl = client.get(xml_exp["download_url"], headers=headers)
    exp_root = ET.fromstring(xml_dl.text)
    assert exp_root.findtext("./work/work-title") == "Untitled Score"
    assert exp_root.findtext("./movement-title") == "Untitled Score"

    pdf_exp = client.post(f"/api/v1/projects/{project_id}/exports", headers=headers, json={"format": "pdf"}).json()
    pdf_dl = client.get(pdf_exp["download_url"], headers=headers)
    page1_txt = PdfReader(io.BytesIO(pdf_dl.content)).pages[0].extract_text()
    assert "Untitled Score" in page1_txt
    assert "tab-audio" not in page1_txt.lower()

    # Duplicate subtitle credit is stripped by branding
    dup_xml = """<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <work><work-title>Custom Song</work-title></work>
  <movement-title>Custom Song</movement-title>
  <credit page="1"><credit-type>title</credit-type><credit-words>Old Title</credit-words></credit>
  <credit page="1"><credit-type>subtitle</credit-type><credit-words>Custom Song</credit-words></credit>
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1"><measure number="1"><note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><type>whole</type></note></measure></part>
</score-partwise>"""
    branded = apply_scribasheet_musicxml_branding(dup_xml, title="Custom Song", force_title=True)
    b_root = ET.fromstring(branded)
    subtitles = [
        c for c in b_root.findall("credit") if (c.findtext("credit-type") or "").strip().lower() == "subtitle"
    ]
    assert len(subtitles) == 0

    # ReportLab PDF title check renders title once in header (plus once in page footer)
    rl_pdf = render_score_pdf(
        ScoreData(
            title="Custom Song",
            tracks=[ScoreTrack()],
            notes=[ScoreNote(id="n1", pitch_midi=60, onset_sec=0.0, offset_sec=1.0)],
        )
    )
    rl_lines = [line.strip() for line in PdfReader(io.BytesIO(rl_pdf)).pages[0].extract_text().splitlines() if line.strip()]
    assert rl_lines[0] == "Custom Song"
    assert rl_lines[1].startswith("Tempo:")
    assert rl_lines.count("Custom Song") <= 2  # Header + optional page footer, never duplicated header/subtitle
