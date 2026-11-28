"""Tests for OMR structural scoring, Gemini Vision verification, safe MusicXML patching, and recovery."""

from __future__ import annotations

import json
import xml.etree.ElementTree as ET
from pathlib import Path

from PIL import Image

from app.core.config import Settings
from app.models import MediaAsset, Project, ProjectScore, TranscriptionJob, User
from app.notation.omr_verification import (
    OmrProposedFix,
    apply_omr_proposed_fixes,
    evaluate_omr_structure,
    verify_omr_with_gemini_vision,
)


def _sample_musicxml(measures_xml: str) -> str:
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list>
    <score-part id="P1"><part-name>Piano</part-name></score-part>
  </part-list>
  <part id="P1">
    {measures_xml}
  </part>
</score-partwise>"""


def test_structural_validation_handles_pickups_tuplets_ties_dots_and_midscore_changes():
    xml = _sample_musicxml(
        """
    <measure number="0" implicit="yes">
      <attributes>
        <divisions>12</divisions>
        <key><fifths>0</fifths></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef>
      </attributes>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>12</duration><type>quarter</type><tie type="start"/></note>
    </measure>
    <measure number="1">
      <!-- dotted quarter (18) + eighth (6) + triplet eighths (4+4+4=12) + quarter (12) = 48 divisions = 4/4 -->
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>18</duration><type>quarter</type><dot/><tie type="stop"/></note>
      <note><pitch><step>A</step><octave>4</octave></pitch><duration>6</duration><type>eighth</type></note>
      <note><pitch><step>B</step><octave>4</octave></pitch><duration>4</duration><type>eighth</type><time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification></note>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration><type>eighth</type><time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification></note>
      <note><pitch><step>D</step><octave>5</octave></pitch><duration>4</duration><type>eighth</type><time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification></note>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>12</duration><type>quarter</type></note>
    </measure>
    <measure number="2">
      <!-- Legitimate mid-score key & clef change + incomplete final bar (3 beats instead of 4) -->
      <attributes>
        <key><fifths>2</fifths></key>
        <clef><sign>F</sign><line>4</line></clef>
      </attributes>
      <note><pitch><step>D</step><octave>3</octave></pitch><duration>36</duration><type>half</type><dot/></note>
    </measure>
    """
    )

    report = evaluate_omr_structure(xml, source_available=False)
    assert report.rhythm_validity_score == 100.0
    assert report.structural_consistency_score == 100.0
    assert report.flagged_measures == []
    # Safeguard: never claims 100% OMR match from structural checks alone
    assert report.score_status == "preliminary"
    assert report.ai_verified is False
    assert report.ai_confidence is None
    assert report.omr_match_score == 92


def test_structural_validation_flags_rhythm_overflow_and_underflow():
    xml = _sample_musicxml(
        """
    <measure number="1">
      <attributes>
        <divisions>4</divisions>
        <key><fifths>0</fifths></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef>
      </attributes>
      <!-- Overflow: 5 beats = 20 divisions in 4/4 -->
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>20</duration><type>whole</type></note>
    </measure>
    <measure number="2">
      <!-- Mid-score underflow: 2 beats = 8 divisions in 4/4 -->
      <note><pitch><step>D</step><octave>4</octave></pitch><duration>8</duration><type>half</type></note>
    </measure>
    <measure number="3">
      <note><pitch><step>E</step><octave>4</octave></pitch><duration>16</duration><type>whole</type></note>
    </measure>
    """
    )

    report = evaluate_omr_structure(xml)
    assert 1 in report.flagged_measures
    assert 2 in report.flagged_measures
    assert 3 not in report.flagged_measures
    categories = {f.category for f in report.findings}
    assert "rhythm_overflow" in categories
    assert "rhythm_underflow" in categories
    assert report.rhythm_validity_score < 50.0


def test_gemini_vision_unavailable_and_failed_responses_never_fabricate_confidence(tmp_path: Path):
    img_path = tmp_path / "page1.png"
    Image.new("RGB", (400, 600), color="white").save(img_path, format="PNG")
    xml = _sample_musicxml(
        """
    <measure number="1">
      <attributes>
        <divisions>4</divisions><time><beats>4</beats><beat-type>4</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef>
      </attributes>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>16</duration><type>whole</type></note>
    </measure>
    """
    )

    no_key_report = verify_omr_with_gemini_vision(
        xml,
        source_files=[(img_path, "image/png")],
        settings=Settings(GEMINI_API_KEY=""),
    )
    assert no_key_report.score_status == "ai_unavailable"
    assert no_key_report.ai_verified is False
    assert no_key_report.ai_confidence is None

    class _RateLimitResponse:
        status_code = 429

        def json(self):
            return {}

    class _RateLimitClient:
        def __init__(self, **_kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def post(self, *_args, **_kwargs):
            return _RateLimitResponse()

    rate_limited_report = verify_omr_with_gemini_vision(
        xml,
        source_files=[(img_path, "image/png")],
        settings=Settings(GEMINI_API_KEY="fake-server-key"),
        http_client_factory=_RateLimitClient,
    )
    assert rate_limited_report.score_status == "ai_failed"
    assert rate_limited_report.ai_verified is False
    assert rate_limited_report.ai_confidence is None
    assert "429" in (rate_limited_report.ai_error or "")


def test_gemini_vision_processes_multipage_pdf_and_validates_findings(tmp_path: Path):
    import pymupdf

    pdf_path = tmp_path / "multipage.pdf"
    doc = pymupdf.open()
    doc.new_page(width=400, height=550)
    doc.new_page(width=400, height=550)
    doc.save(pdf_path)
    doc.close()

    xml = _sample_musicxml(
        """
    <measure number="1">
      <attributes>
        <divisions>4</divisions><time><beats>4</beats><beat-type>4</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef>
      </attributes>
      <note><pitch><step>F</step><octave>4</octave></pitch><duration>16</duration><type>whole</type></note>
    </measure>
    <measure number="2">
      <print new-page="yes"/>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>16</duration><type>whole</type></note>
    </measure>
    """
    )

    seen_prompts: list[str] = []

    class _OkResponse:
        status_code = 200

        def __init__(self, page_num: int):
            self.page_num = page_num

        def json(self):
            payload = {
                "page_confidence": 96 if self.page_num == 1 else 94,
                "findings": (
                    [
                        {
                            "measure": 1,
                            "part_id": "P1",
                            "category": "accidental",
                            "severity": "medium",
                            "description": "Measure 1 F4 should be F#4.",
                            "confidence": 95,
                            "proposed_fix": {
                                "action": "set_accidental",
                                "part_id": "P1",
                                "measure": 1,
                                "note_index": 0,
                                "alter": 1,
                            },
                        }
                    ]
                    if self.page_num == 1
                    else []
                ),
            }
            return {"candidates": [{"content": {"parts": [{"text": json.dumps(payload)}]}}]}

    class _MockGeminiClient:
        def __init__(self, **_kwargs):
            self.calls = 0

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def post(self, url, headers=None, json=None):
            assert headers and headers.get("x-goog-api-key") == "test-key"
            assert "generativelanguage.googleapis.com" in url
            prompt_text = json["contents"][0]["parts"][0]["text"]
            seen_prompts.append(prompt_text)
            self.calls += 1
            return _OkResponse(self.calls)

    report = verify_omr_with_gemini_vision(
        xml,
        source_files=[(pdf_path, "application/pdf")],
        settings=Settings(GEMINI_API_KEY="test-key", GEMINI_VISION_MODEL="gemini-2.5-flash"),
        http_client_factory=_MockGeminiClient,
    )

    assert len(seen_prompts) == 2
    assert "page 1 of 2" in seen_prompts[0]
    assert "page 2 of 2" in seen_prompts[1]
    assert report.ai_verified is True
    assert report.score_status == "verified"
    assert report.ai_confidence == 95.0
    assert report.flagged_measures == [1]
    assert len(report.findings) == 1
    assert report.findings[0].proposed_fix is not None
    assert report.omr_match_score >= 90


def test_apply_fixes_revert_and_ownership_endpoints(client, db_session, tmp_path: Path):
    from app.core.security import create_access_token, hash_password
    from app.storage.service import storage_service

    owner = User(
        id="omr-owner-1",
        email="omr-owner@example.com",
        password_hash=hash_password("secret123"),
        display_name="Owner",
    )
    other = User(
        id="omr-other-2",
        email="omr-other@example.com",
        password_hash=hash_password("secret123"),
        display_name="Other",
    )
    db_session.add_all([owner, other])
    db_session.flush()

    xml = _sample_musicxml(
        """
    <measure number="1">
      <attributes>
        <divisions>4</divisions><key><fifths>0</fifths></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef>
      </attributes>
      <note><pitch><step>F</step><octave>4</octave></pitch><duration>8</duration><type>half</type></note>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>8</duration><type>half</type></note>
    </measure>
    """
    )

    # Pure unit test of safe patcher + invalid fix rejection
    patched, applied, skipped = apply_omr_proposed_fixes(
        xml,
        [
            (
                "fix-good",
                OmrProposedFix(action="set_accidental", part_id="P1", measure=1, note_index=0, alter=1),
            ),
            (
                "fix-bad-idx",
                OmrProposedFix(action="set_accidental", part_id="P1", measure=1, note_index=99, alter=1),
            ),
        ],
    )
    assert applied == ["fix-good"]
    assert skipped == ["fix-bad-idx"]
    patched_root = ET.fromstring(patched)
    assert patched_root.findtext(".//part/measure/note[1]/pitch/alter") == "1"

    # Full API lifecycle with stored XML & verification report
    project = Project(
        id="proj-omr-verify",
        user_id=owner.id,
        title="OMR Fix Test",
        instrument="piano",
        transcription_mode="satb_pdf",
        status="ready",
    )
    db_session.add(project)
    db_session.flush()

    xml_key = storage_service.build_key(owner.id, project.id, "musicxml", "score.musicxml")
    storage_service.save_bytes(xml_key, xml.encode("utf-8"), content_type="application/vnd.recordare.musicxml+xml")
    midi_key = storage_service.build_key(owner.id, project.id, "midi", "score.mid")
    storage_service.save_bytes(midi_key, b"MThd\x00\x00\x00\x06\x00\x01\x00\x01\x01\xe0", content_type="audio/midi")

    report = evaluate_omr_structure(xml, source_available=False).model_dump()
    report["findings"].append(
        {
            "id": "ai-fix-1",
            "source": "ai_vision",
            "page": 1,
            "measure": 1,
            "part_id": "P1",
            "category": "accidental",
            "severity": "medium",
            "description": "Add sharp to F4",
            "confidence": 94.0,
            "proposed_fix": {
                "action": "set_accidental",
                "part_id": "P1",
                "measure": 1,
                "note_index": 0,
                "alter": 1,
            },
        }
    )

    score_row = ProjectScore(
        project_id=project.id,
        version=1,
        score_json={
            "title": "OMR Fix Test",
            "tempo_bpm": 120.0,
            "tempo_estimated": False,
            "time_signature": "4/4",
            "time_signature_estimated": False,
            "key_signature": "C major",
            "key_signature_estimated": False,
            "duration_seconds": 2.0,
            "tracks": [{"index": 0, "name": "Piano", "instrument": "piano", "clef": "treble", "program": 0, "muted": False}],
            "notes": [
                {"id": "n1", "pitch_midi": 65, "onset_sec": 0.0, "offset_sec": 1.0, "velocity": 84, "track_index": 0},
                {"id": "n2", "pitch_midi": 67, "onset_sec": 1.0, "offset_sec": 2.0, "velocity": 84, "track_index": 0},
            ],
            "chords": [],
            "analysis": {"mode": "satb_pdf", "is_active": True, "omr_verification": report},
        },
        musicxml_path=xml_key,
        midi_path=midi_key,
    )
    db_session.add(score_row)
    db_session.add(
        MediaAsset(
            project_id=project.id,
            user_id=owner.id,
            asset_type="original",
            storage_path="",
            original_filename="missing.pdf",
            mime_type="application/pdf",
            size_bytes=1234,
        )
    )
    db_session.add(
        TranscriptionJob(
            project_id=project.id,
            user_id=owner.id,
            status="completed",
            progress=100,
            current_stage="Completed",
            engine="omr",
            settings_json={"mode": "satb_pdf"},
        )
    )
    db_session.commit()

    owner_headers = {"Authorization": f"Bearer {create_access_token(owner.id)}"}
    other_headers = {"Authorization": f"Bearer {create_access_token(other.id)}"}

    # Unauthorized user blocked
    forbid_resp = client.get(f"/api/v1/projects/{project.id}/score/omr-verification", headers=other_headers)
    assert forbid_resp.status_code in (403, 404)

    # Owner gets structural report noting missing source file
    get_resp = client.get(f"/api/v1/projects/{project.id}/score/omr-verification", headers=owner_headers)
    assert get_resp.status_code == 200
    assert get_resp.json()["source_available"] is False

    # Applying selected fix updates MusicXML, ScoreData pitches (65 -> 66 F#4), version, and enables revert
    apply_resp = client.post(
        f"/api/v1/projects/{project.id}/score/omr-apply-fixes",
        json={"finding_ids": ["ai-fix-1"]},
        headers=owner_headers,
    )
    assert apply_resp.status_code == 200, apply_resp.text
    apply_data = apply_resp.json()
    assert apply_data["applied_ids"] == ["ai-fix-1"]
    assert apply_data["score"]["version"] == 2
    assert apply_data["score"]["score_json"]["notes"][0]["pitch_midi"] == 66
    assert "<alter>1</alter>" in apply_data["score"]["musicxml"]

    # Reverting restores F4 (MIDI 65) and original MusicXML cleanly
    revert_resp = client.post(
        f"/api/v1/projects/{project.id}/score/omr-revert",
        headers=owner_headers,
    )
    assert revert_resp.status_code == 200, revert_resp.text
    revert_data = revert_resp.json()
    assert revert_data["version"] == 3
    assert revert_data["score_json"]["notes"][0]["pitch_midi"] == 65
