"""Regression tests ensuring MusicXML <beam>, <tie>, <tied>, and <slur> survive branding, parse, save, reload, and export."""

from __future__ import annotations

import io
import uuid
import xml.etree.ElementTree as ET
import zipfile

import music21

from app.notation.generator import apply_scribasheet_musicxml_branding

BEAMED_TIED_SLURRED_XML = """<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <work><work-title>Legato Beamed Study</work-title></work>
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>48</divisions>
        <key><fifths>-1</fifths><mode>major</mode></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef>
      </attributes>
      <note>
        <pitch><step>F</step><octave>4</octave></pitch>
        <duration>24</duration>
        <voice>1</voice>
        <type>eighth</type>
        <beam number="1">begin</beam>
        <notations><slur type="start" number="1"/></notations>
      </note>
      <note>
        <pitch><step>G</step><octave>4</octave></pitch>
        <duration>24</duration>
        <voice>1</voice>
        <type>eighth</type>
        <beam number="1">end</beam>
      </note>
      <note>
        <pitch><step>A</step><octave>4</octave></pitch>
        <duration>12</duration>
        <voice>1</voice>
        <type>16th</type>
        <beam number="1">begin</beam>
        <beam number="2">begin</beam>
      </note>
      <note>
        <pitch><step>B</step><alter>-1</alter><octave>4</octave></pitch>
        <duration>12</duration>
        <voice>1</voice>
        <type>16th</type>
        <beam number="1">continue</beam>
        <beam number="2">continue</beam>
      </note>
      <note>
        <pitch><step>C</step><octave>5</octave></pitch>
        <duration>24</duration>
        <voice>1</voice>
        <type>eighth</type>
        <beam number="1">end</beam>
        <notations><slur type="stop" number="1"/></notations>
      </note>
      <note>
        <pitch><step>D</step><octave>5</octave></pitch>
        <duration>96</duration>
        <tie type="start"/>
        <voice>1</voice>
        <type>half</type>
        <notations><tied type="start"/></notations>
      </note>
    </measure>
    <measure number="2">
      <note>
        <pitch><step>D</step><octave>5</octave></pitch>
        <duration>96</duration>
        <tie type="stop"/>
        <voice>1</voice>
        <type>half</type>
        <notations><tied type="stop"/></notations>
      </note>
      <note>
        <rest/>
        <duration>96</duration>
        <voice>1</voice>
        <type>half</type>
      </note>
    </measure>
  </part>
</score-partwise>
"""


def test_branding_and_music21_preserve_beams_ties_and_slurs() -> None:
    parsed = music21.converter.parseData(BEAMED_TIED_SLURRED_XML, format="musicxml")
    assert parsed is not None

    branded = apply_scribasheet_musicxml_branding(
        BEAMED_TIED_SLURRED_XML,
        title="Legato Beamed Study",
    )
    root = ET.fromstring(branded)
    beams = root.findall(".//note/beam")
    ties = root.findall(".//note/tie")
    tieds = root.findall(".//notations/tied")
    slurs = root.findall(".//notations/slur")

    assert [b.text for b in beams] == ["begin", "end", "begin", "begin", "continue", "continue", "end"]
    assert [t.get("type") for t in ties] == ["start", "stop"]
    assert [t.get("type") for t in tieds] == ["start", "stop"]
    assert [s.get("type") for s in slurs] == ["start", "stop"]


def test_score_save_reload_and_mxl_export_preserve_beams_ties_and_slurs(client) -> None:
    email = f"beams_ties_{uuid.uuid4().hex[:8]}@example.com"
    client.post(
        "/api/v1/auth/register",
        json={"email": email, "password": "StrongPassword123!", "display_name": "Beam Tester"},
    )
    login_res = client.post(
        "/api/v1/auth/login",
        json={"email": email, "password": "StrongPassword123!"},
    )
    assert login_res.status_code == 200
    headers = {"Authorization": f"Bearer {login_res.json()['access_token']}"}

    create_res = client.post(
        "/api/v1/projects/playground",
        headers=headers,
        json={
            "title": "Legato Beamed Study",
            "key_signature": "F Major",
            "time_signature": "4/4",
            "tempo_bpm": 120,
            "clef_mode": "treble",
            "measures": 2,
        },
    )
    assert create_res.status_code == 201, create_res.text
    proj_id = create_res.json()["id"]

    score_get = client.get(f"/api/v1/projects/{proj_id}/score", headers=headers)
    assert score_get.status_code == 200
    row = score_get.json()

    put_res = client.put(
        f"/api/v1/projects/{proj_id}/score",
        headers=headers,
        json={
            "expected_version": row["version"],
            "score_json": row["score_json"],
            "musicxml": BEAMED_TIED_SLURRED_XML,
        },
    )
    assert put_res.status_code == 200, put_res.text

    reloaded = client.get(f"/api/v1/projects/{proj_id}/score", headers=headers)
    assert reloaded.status_code == 200
    reloaded_root = ET.fromstring(reloaded.json()["musicxml"])
    assert len(reloaded_root.findall(".//note/beam")) == 7
    assert len(reloaded_root.findall(".//note/tie")) == 2
    assert len(reloaded_root.findall(".//notations/tied")) == 2
    assert len(reloaded_root.findall(".//notations/slur")) == 2

    mxl_res = client.post(f"/api/v1/projects/{proj_id}/exports", headers=headers, json={"format": "mxl"})
    assert mxl_res.status_code == 201, mxl_res.text
    mxl_dl = client.get(mxl_res.json()["download_url"], headers=headers)
    assert mxl_dl.status_code == 200
    with zipfile.ZipFile(io.BytesIO(mxl_dl.content), "r") as zf:
        exported_xml = zf.read("score.musicxml").decode("utf-8")
    exported_root = ET.fromstring(exported_xml)
    assert len(exported_root.findall(".//note/beam")) == 7
    assert len(exported_root.findall(".//note/tie")) == 2
    assert len(exported_root.findall(".//notations/tied")) == 2
    assert len(exported_root.findall(".//notations/slur")) == 2
