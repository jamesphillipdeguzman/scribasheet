"""Backend persistence, copy, MusicXML sanitization, and PDF export tests for pickups, meters, repeats, and endings."""

from __future__ import annotations

import os
import xml.etree.ElementTree as ET

from app.api.v1.exports import _prepare_export_musicxml
from app.notation.generator import render_score_pdf
from app.notation.playground import build_blank_playground_score
from app.schemas.score import ScoreData, ScoreNote, ScoreTrack
from app.storage.service import storage_service


def _auth_headers(client, email: str, password: str = "Password123!") -> dict[str, str]:
    client.post(
        "/api/v1/auth/register",
        json={"email": email, "password": password, "display_name": "Structure Tester"},
    )
    res = client.post("/api/v1/auth/login", json={"email": email, "password": password})
    assert res.status_code == 200, res.text
    return {"Authorization": f"Bearer {res.json()['access_token']}"}


REPRESENTATIVE_COMPLEX_XML = """<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <work><work-title>Pickup Repeat Etude</work-title></work>
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="0" implicit="yes">
      <attributes>
        <divisions>48</divisions>
        <key><fifths>-1</fifths><mode>major</mode></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef>
      </attributes>
      <direction placement="above">
        <direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>120</per-minute></metronome></direction-type>
        <sound tempo="120"/>
      </direction>
      <note><rest/><duration>48</duration><voice>1</voice><type>quarter</type></note>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>48</duration><voice>1</voice><type>quarter</type></note>
    </measure>
    <measure number="1">
      <barline location="left"><bar-style>heavy-light</bar-style><repeat direction="forward"/></barline>
      <direction placement="above"><direction-type><segno/></direction-type><sound segno="segno"/></direction>
      <note><pitch><step>F</step><octave>4</octave></pitch><duration>192</duration><voice>1</voice><type>whole</type></note>
    </measure>
    <measure number="2">
      <attributes><time><beats>2</beats><beat-type>4</beat-type></time></attributes>
      <barline location="left"><ending number="1" type="start">1.</ending></barline>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>96</duration><voice>1</voice><type>half</type></note>
      <barline location="right"><bar-style>light-heavy</bar-style><repeat direction="backward"/><ending number="1" type="stop"/></barline>
    </measure>
    <measure number="3">
      <attributes><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
      <barline location="left"><ending number="2" type="start">2.</ending></barline>
      <direction placement="above"><direction-type><words font-weight="bold">To Coda</words></direction-type><sound tocoda="coda"/></direction>
      <direction placement="above"><direction-type><words font-weight="bold">D.S. al Coda</words></direction-type><sound dalsegno="segno"/></direction>
      <note><pitch><step>A</step><octave>4</octave></pitch><duration>192</duration><voice>1</voice><type>whole</type></note>
      <barline location="right"><ending number="2" type="discontinue"/></barline>
    </measure>
    <measure number="4">
      <direction placement="above"><direction-type><coda/></direction-type><sound coda="coda"/></direction>
      <note><pitch><step>F</step><octave>4</octave></pitch><duration>192</duration><voice>1</voice><type>whole</type></note>
      <barline location="right"><bar-style>light-heavy</bar-style></barline>
    </measure>
  </part>
</score-partwise>"""


def test_playground_creation_with_pickup_and_save_reload_copy(client, db_session) -> None:
    headers = _auth_headers(client, "pickup_flow@example.com")

    create_res = client.post(
        "/api/v1/projects/playground",
        headers=headers,
        json={
            "title": "Pickup Sketch",
            "key_signature": "F Major",
            "time_signature": "4/4",
            "tempo_bpm": 120,
            "clef_mode": "treble",
            "measures": 4,
            "pickup_beats": 2,
        },
    )
    assert create_res.status_code == 201, create_res.text
    proj_id = create_res.json()["id"]

    score_res = client.get(f"/api/v1/projects/{proj_id}/score", headers=headers)
    assert score_res.status_code == 200
    body = score_res.json()
    root = ET.fromstring(body["musicxml"])
    measures = root.findall(".//part/measure")
    assert len(measures) == 5
    assert measures[0].attrib.get("number") == "0"
    assert measures[0].attrib.get("implicit") == "yes"
    assert measures[1].attrib.get("number") == "1"
    assert measures[0].findtext("attributes/time/beats") == "4"
    assert measures[0].findtext("note/duration") == "96"
    assert body["score_json"]["analysis"]["structure"]["hasPickup"] is True

    # Save updated MusicXML with repeats, local 2/4, endings, and D.S. al Coda -> reload -> copy
    updated_score = dict(body["score_json"])
    updated_score["analysis"] = {
        **(updated_score.get("analysis") or {}),
        "structure": {
            "hasPickup": True,
            "measures": [
                {"measureNumber": 0, "isPickup": True, "actualQuarters": 2.0, "timeBeats": 4, "timeBeatType": 4},
                {"measureNumber": 1, "isPickup": False, "actualQuarters": 4.0, "timeBeats": 4, "timeBeatType": 4, "forwardRepeat": True, "navigationMarkers": ["segno"]},
                {"measureNumber": 2, "isPickup": False, "actualQuarters": 2.0, "hasExplicitTimeChange": True, "timeBeats": 2, "timeBeatType": 4, "endingStart": [1], "endingStop": [1], "backwardRepeat": True, "repeatCount": 2},
                {"measureNumber": 3, "isPickup": False, "actualQuarters": 4.0, "hasExplicitTimeChange": True, "timeBeats": 4, "timeBeatType": 4, "endingStart": [2], "endingDiscontinue": [2], "navigationMarkers": ["to_coda", "ds_al_coda"]},
                {"measureNumber": 4, "isPickup": False, "actualQuarters": 4.0, "timeBeats": 4, "timeBeatType": 4, "navigationMarkers": ["coda"]},
            ],
        },
    }
    put_res = client.put(
        f"/api/v1/projects/{proj_id}/score",
        headers=headers,
        json={"expected_version": body["version"], "score_json": updated_score, "musicxml": REPRESENTATIVE_COMPLEX_XML},
    )
    assert put_res.status_code == 200, put_res.text

    copy_res = client.post(f"/api/v1/projects/{proj_id}/playground-copy", headers=headers, json={})
    assert copy_res.status_code == 201, copy_res.text
    copy_score = client.get(f"/api/v1/projects/{copy_res.json()['id']}/score", headers=headers).json()
    copy_root = ET.fromstring(copy_score["musicxml"])
    assert copy_root.find(".//measure[@number='0']") is not None
    assert copy_root.find(".//measure[@number='2']//ending[@number='1'][@type='start']") is not None
    assert copy_root.find(".//measure[@number='3']//sound[@dalsegno='segno']") is not None


def test_export_musicxml_and_pdf_preserve_pickup_meter_repeats_and_endings() -> None:
    storage_key = "tests/pickup_export_check/score.musicxml"
    storage_service.save_bytes(
        storage_key,
        REPRESENTATIVE_COMPLEX_XML.encode("utf-8"),
        content_type="application/vnd.recordare.musicxml+xml",
    )

    _, blank_xml = build_blank_playground_score(title="Helper", pickup_beats=1.5)
    assert ET.fromstring(blank_xml).find(".//measure[@number='0']") is not None

    score = ScoreData(
        title="Pickup Repeat Etude",
        tempo_bpm=120.0,
        tempo_estimated=False,
        time_signature="4/4",
        time_signature_estimated=False,
        key_signature="F Major",
        key_signature_estimated=False,
        duration_seconds=8.0,
        tracks=[ScoreTrack(index=0, name="Piano", instrument="piano", clef="treble", program=0)],
        notes=[
            ScoreNote(id="n0", pitch_midi=60, onset_sec=0.5, offset_sec=1.0, velocity=84, track_index=0),
            ScoreNote(id="n1", pitch_midi=65, onset_sec=1.0, offset_sec=2.0, velocity=84, track_index=0),
            ScoreNote(id="n2", pitch_midi=67, onset_sec=3.0, offset_sec=4.0, velocity=84, track_index=0),
        ],
        chords=[],
        analysis={
            "structure": {
                "hasPickup": True,
                "measures": [
                    {"measureNumber": 0, "isPickup": True, "actualQuarters": 2.0, "timeBeats": 4, "timeBeatType": 4},
                    {"measureNumber": 1, "isPickup": False, "actualQuarters": 4.0, "timeBeats": 4, "timeBeatType": 4, "forwardRepeat": True, "navigationMarkers": ["segno"]},
                    {"measureNumber": 2, "isPickup": False, "actualQuarters": 2.0, "hasExplicitTimeChange": True, "timeBeats": 2, "timeBeatType": 4, "endingStart": [1], "endingStop": [1], "backwardRepeat": True, "repeatCount": 2},
                    {"measureNumber": 3, "isPickup": False, "actualQuarters": 4.0, "hasExplicitTimeChange": True, "timeBeats": 4, "timeBeatType": 4, "endingStart": [2], "endingDiscontinue": [2], "navigationMarkers": ["to_coda", "ds_al_coda"]},
                    {"measureNumber": 4, "isPickup": False, "actualQuarters": 4.0, "timeBeats": 4, "timeBeatType": 4, "navigationMarkers": ["coda"]},
                ],
            }
        },
    )

    exported_xml = _prepare_export_musicxml(score, include_chords=True, musicxml_path=storage_key)
    exported_root = ET.fromstring(exported_xml)
    assert exported_root is not None
    assert exported_root.find(".//measure[@number='0'][@implicit='yes']") is not None
    assert exported_root.find(".//measure[@number='2']//ending[@number='1'][@type='start']") is not None
    assert exported_root.find(".//measure[@number='3']//sound[@dalsegno='segno']") is not None

    # Validate fallback ReportLab PDF renderer emits valid multi-system PDF with all structural annotations
    prev_disable = os.environ.get("DISABLE_MUSESCORE_PDF")
    os.environ["DISABLE_MUSESCORE_PDF"] = "1"
    try:
        pdf_bytes = render_score_pdf(score, include_chords=True)
    finally:
        if prev_disable is None:
            os.environ.pop("DISABLE_MUSESCORE_PDF", None)
        else:
            os.environ["DISABLE_MUSESCORE_PDF"] = prev_disable

    assert pdf_bytes.startswith(b"%PDF-")
    assert len(pdf_bytes) > 1000
