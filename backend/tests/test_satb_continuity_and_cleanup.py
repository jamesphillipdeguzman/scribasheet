"""Regression tests for SATB voice continuity, OMR footer/cue cleanup, and Acoustic Grand Piano rendering."""

from __future__ import annotations

import xml.etree.ElementTree as ET
from pathlib import Path

import music21
import pymupdf
import soundfile as sf

from app.notation.omr import (
    identify_satb_parts,
    musicxml_to_satb_score_data,
    process_satb_musicxml,
    sanitize_omr_musicxml,
)
from app.notation.satb_audio import render_satb_audio_tracks


def _build_two_staff_go_tell_it_xml() -> str:
    """Build a 2-staff SATB MusicXML modeling unison, solo+rest, ties across measures, footer pseudo-lyrics, and final-measure cue/fermata."""
    return """<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.1 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="3.1">
  <part-list>
    <score-part id="P1"><part-name>SA</part-name></score-part>
    <score-part id="P2"><part-name>TB</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>2</divisions>
        <key><fifths>-1</fifths></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef>
      </attributes>
      <note>
        <pitch><step>C</step><octave>5</octave></pitch>
        <duration>4</duration><voice>1</voice><type>half</type>
        <lyric number="1"><text>Go</text></lyric>
      </note>
      <note>
        <pitch><step>A</step><octave>4</octave></pitch>
        <duration>4</duration><voice>1</voice><type>half</type>
        <lyric number="1"><text>tell</text></lyric>
      </note>
      <backup><duration>8</duration></backup>
      <note>
        <pitch><step>F</step><octave>4</octave></pitch>
        <duration>4</duration><voice>2</voice><type>half</type>
      </note>
      <note>
        <pitch><step>F</step><octave>4</octave></pitch>
        <duration>4</duration><voice>2</voice><type>half</type>
      </note>
    </measure>
    <measure number="2">
      <!-- Confirmed unison passage (single notehead, no rests in voice 2) + tie into m3 -->
      <note>
        <pitch><step>G</step><octave>4</octave></pitch>
        <duration>4</duration><voice>1</voice><type>half</type>
        <lyric number="1"><text>it</text></lyric>
      </note>
      <note>
        <pitch><step>A</step><octave>4</octave></pitch>
        <duration>4</duration><voice>1</voice><type>half</type>
        <tie type="start"/>
        <notations><tied type="start"/></notations>
        <lyric number="1"><text>on</text></lyric>
      </note>
    </measure>
    <measure number="3">
      <!-- Tied note continues in Soprano while Alto has explicit rest during solo -->
      <note>
        <pitch><step>A</step><octave>4</octave></pitch>
        <duration>4</duration><voice>1</voice><type>half</type>
        <tie type="stop"/>
        <notations><tied type="stop"/></notations>
      </note>
      <note>
        <pitch><step>B</step><alter>-1</alter><octave>4</octave></pitch>
        <duration>4</duration><voice>1</voice><type>half</type>
        <lyric number="1"><text>the</text></lyric>
      </note>
      <backup><duration>8</duration></backup>
      <note>
        <pitch><step>A</step><octave>4</octave></pitch>
        <duration>4</duration><voice>2</voice><type>half</type>
        <tie type="stop"/>
        <notations><tied type="stop"/></notations>
      </note>
      <note>
        <rest/><duration>4</duration><voice>2</voice><type>half</type>
      </note>
    </measure>
    <measure number="4">
      <!-- Final measure with fermata, transition direction "to Refrain", and cue note -->
      <direction placement="above">
        <direction-type><words>to Refrain</words></direction-type>
      </direction>
      <note>
        <pitch><step>C</step><octave>5</octave></pitch>
        <duration>4</duration><voice>1</voice><type>half</type>
        <notations><fermata type="upright"/></notations>
        <lyric number="1"><text>moun-</text></lyric>
      </note>
      <note>
        <pitch><step>A</step><octave>4</octave></pitch>
        <duration>4</duration><voice>1</voice><type>half</type>
        <lyric number="1"><text>tain</text></lyric>
      </note>
      <backup><duration>8</duration></backup>
      <note>
        <pitch><step>F</step><octave>4</octave></pitch>
        <duration>8</duration><voice>2</voice><type>whole</type>
        <notations><fermata type="upright"/></notations>
      </note>
      <note>
        <cue/>
        <pitch><step>D</step><octave>5</octave></pitch>
        <duration>2</duration><voice>3</voice><type>quarter</type>
      </note>
    </measure>
  </part>
  <part id="P2">
    <measure number="1">
      <attributes>
        <divisions>2</divisions>
        <key><fifths>-1</fifths></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <clef><sign>F</sign><line>4</line></clef>
      </attributes>
      <note>
        <pitch><step>C</step><octave>4</octave></pitch>
        <duration>4</duration><voice>1</voice><type>half</type>
      </note>
      <note>
        <pitch><step>C</step><octave>4</octave></pitch>
        <duration>4</duration><voice>1</voice><type>half</type>
      </note>
      <backup><duration>8</duration></backup>
      <note>
        <pitch><step>F</step><octave>3</octave></pitch>
        <duration>4</duration><voice>2</voice><type>half</type>
        <lyric number="1" default-y="-80"><text>Go</text></lyric>
      </note>
      <note>
        <pitch><step>F</step><octave>3</octave></pitch>
        <duration>4</duration><voice>2</voice><type>half</type>
        <lyric number="1" default-y="-80"><text>tell</text></lyric>
      </note>
    </measure>
    <measure number="2">
      <!-- 3-pitch chord in TB + footer metadata pseudo-lyric -->
      <note>
        <pitch><step>G</step><octave>3</octave></pitch>
        <duration>8</duration><voice>1</voice><type>whole</type>
        <lyric number="1" default-y="-190"><text>Copyright 2024 Choral Press</text></lyric>
      </note>
      <note>
        <chord/>
        <pitch><step>C</step><octave>4</octave></pitch>
        <duration>8</duration><voice>1</voice><type>whole</type>
      </note>
      <note>
        <chord/>
        <pitch><step>E</step><octave>4</octave></pitch>
        <duration>8</duration><voice>1</voice><type>whole</type>
      </note>
    </measure>
    <measure number="3">
      <note>
        <pitch><step>C</step><octave>4</octave></pitch>
        <duration>8</duration><voice>1</voice><type>whole</type>
      </note>
      <backup><duration>8</duration></backup>
      <note>
        <pitch><step>F</step><octave>3</octave></pitch>
        <duration>8</duration><voice>2</voice><type>whole</type>
        <lyric number="1" default-y="-85"><text>Arr. by J. Smith</text></lyric>
      </note>
    </measure>
    <measure number="4">
      <note>
        <pitch><step>A</step><octave>3</octave></pitch>
        <duration>8</duration><voice>1</voice><type>whole</type>
        <notations><fermata type="upright"/></notations>
      </note>
      <backup><duration>8</duration></backup>
      <note>
        <pitch><step>F</step><octave>3</octave></pitch>
        <duration>8</duration><voice>2</voice><type>whole</type>
        <notations><fermata type="upright"/></notations>
        <lyric number="1" default-y="-80"><text>mountain</text></lyric>
      </note>
    </measure>
  </part>
</score-partwise>"""


def test_satb_continuity_unison_ties_and_chords(tmp_path: Path) -> None:
    xml_path = tmp_path / "go_tell_it.musicxml"
    xml_path.write_text(_build_two_staff_go_tell_it_xml(), encoding="utf-8")

    res = process_satb_musicxml(xml_path, title="Go Tell It on the Mountain", satb_mode="auto_satb")
    assert [a.assigned_voice for a in res.assignments] == ["Soprano", "Alto", "Tenor", "Bass"]

    # Default instrument is Acoustic Grand Piano (program 0)
    assert all(t.program == 0 for t in res.score_data.tracks)
    assert all(t.instrument == "piano" for t in res.score_data.tracks)

    # Check Soprano (track 0) and Alto (track 1)
    sop_notes = [n for n in res.score_data.notes if n.track_index == 0]
    alt_notes = [n for n in res.score_data.notes if n.track_index == 1]

    # Measure 2 unison G4 (midi 67) & A4 (midi 69) present in BOTH Soprano and Alto
    assert any(n.pitch_midi == 67 for n in sop_notes)
    assert any(n.pitch_midi == 67 for n in alt_notes)

    # Tied A4 from m2 -> m3 merged into single continuous ScoreNote (duration 4 + 4 = 8 ql at 100bpm = 4.8s, not 2 separate notes)
    sop_a4_m2 = [n for n in sop_notes if n.pitch_midi == 69 and abs(n.onset_sec - 3.6) < 0.05]
    assert len(sop_a4_m2) == 1
    assert sop_a4_m2[0].offset_sec - sop_a4_m2[0].onset_sec > 2.3

    # Measure 3 Bb4 (midi 70) is Soprano solo while Alto has explicit rest -> NOT duplicated to Alto
    assert any(n.pitch_midi == 70 for n in sop_notes)
    assert not any(n.pitch_midi == 70 for n in alt_notes)

    # Measure 4 cue note D5 (midi 74) did not corrupt Soprano/Alto main notes (C5=72, A4=69)
    assert any(n.pitch_midi == 72 for n in sop_notes)
    assert not any(n.pitch_midi == 74 for n in sop_notes)

    # Separated MusicXML preserves part names, fermatas, and ties
    parsed_out = music21.converter.parseData(res.musicxml, format="musicxml")
    assert [p.partName for p in parsed_out.parts] == ["Soprano", "Alto", "Tenor", "Bass"]
    fermatas = [
        exp
        for el in parsed_out.recurse().notes
        for exp in el.expressions
        if isinstance(exp, music21.expressions.Fermata)
    ]
    assert len(fermatas) >= 2


def test_omr_footer_coordinate_and_metadata_filtering(tmp_path: Path) -> None:
    pdf_path = tmp_path / "footer_test.pdf"
    doc = pymupdf.open()
    page = doc.new_page(width=612, height=792)
    page.insert_text((72, 740), "Public Domain Gospel Hymn • Special Footer Line", fontsize=9)
    doc.save(str(pdf_path))
    doc.close()

    cleaned_xml, warnings = sanitize_omr_musicxml(_build_two_staff_go_tell_it_xml(), pdf_path=pdf_path)
    root = ET.fromstring(cleaned_xml)
    remaining_lyrics = [
        "".join(t.text or "" for t in lyr.findall("text")).strip()
        for lyr in root.findall(".//lyric")
    ]
    assert "Go" in remaining_lyrics
    assert "tell" in remaining_lyrics
    assert "mountain" in remaining_lyrics
    assert "Copyright 2024 Choral Press" not in remaining_lyrics
    assert "Arr. by J. Smith" not in remaining_lyrics
    assert any("Filtered" in w for w in warnings)


def test_satb_audio_defaults_to_acoustic_grand_piano(monkeypatch) -> None:
    monkeypatch.setenv("DISABLE_SOUNDFONT_RENDER", "1")
    score, _, _, _ = musicxml_to_satb_score_data(_build_two_staff_go_tell_it_xml(), title="Go Tell It")
    outputs = render_satb_audio_tracks(score, output_format="wav")
    assert set(outputs.keys()) == {"soprano", "alto", "tenor", "bass", "combined"}
    for key, wav_bytes in outputs.items():
        assert wav_bytes[:4] == b"RIFF", f"{key} did not render valid WAV"


def test_scribasheet_attribution_and_clean_titles(tmp_path: Path) -> None:
    from app.notation.generator import apply_scribasheet_musicxml_branding, clean_score_title, score_data_to_musicxml
    from app.schemas.score import ScoreData, ScoreNote, ScoreTrack

    assert clean_score_title("go_tell_it_on_the_mountain.pdf") == "Go Tell It On The Mountain"
    assert clean_score_title("Choir Hymn.Pdf") == "Choir Hymn"
    assert clean_score_title("Hymn_Arrangement.mxl") == "Hymn Arrangement"
    assert clean_score_title("Psalm 23.musicxml") == "Psalm 23"

    # Replaces Music21 composer/software attribution while preserving real composer & unrelated text
    raw_music21_xml = """<?xml version="1.0" encoding="utf-8"?>
<score-partwise version="3.1">
  <work><work-title>My Song.Pdf</work-title></work>
  <movement-title>My Song.mxl</movement-title>
  <identification>
    <creator type="composer">Music21</creator>
    <creator type="lyricist">Traditional</creator>
    <encoding><software>Music21 v.10.5.2</software></encoding>
  </identification>
  <credit><credit-words>Music21</credit-words></credit>
  <credit><credit-words>Sung in harmony</credit-words></credit>
  <part-list><score-part id="P1"><part-name>Soprano</part-name></score-part></part-list>
  <part id="P1"><measure number="1"><note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration><type>whole</type></note></measure></part>
</score-partwise>"""
    branded = apply_scribasheet_musicxml_branding(raw_music21_xml)
    root = ET.fromstring(branded)
    assert root.findtext("./work/work-title") == "My Song"
    assert root.findtext("./movement-title") == "My Song"
    creators = {el.attrib.get("type"): el.text for el in root.findall("./identification/creator")}
    assert creators["composer"] == "ScribaSheet"
    assert creators["lyricist"] == "Traditional"
    assert root.findtext("./identification/encoding/software") == "ScribaSheet"
    credit_texts = [el.text for el in root.findall("./credit/credit-words")]
    assert "ScribaSheet" in credit_texts
    assert "Sung in harmony" in credit_texts
    assert "Music21" not in credit_texts

    # score_data_to_musicxml sets ScribaSheet attribution
    score = ScoreData(
        title="Amazing Grace.pdf",
        tempo_bpm=100,
        time_signature="4/4",
        key_signature="C major",
        duration_seconds=1.0,
        tracks=[ScoreTrack(index=0, name="Soprano", instrument="piano", clef="treble", program=0)],
        notes=[ScoreNote(id="n1", pitch_midi=72, onset_sec=0.0, offset_sec=0.6, velocity=80, track_index=0)],
    )
    gen_xml = score_data_to_musicxml(score, include_chords=False, include_lyrics=False)
    gen_root = ET.fromstring(gen_xml)
    assert gen_root.findtext("./work/work-title") == "Amazing Grace"
    assert gen_root.findtext("./identification/creator[@type='composer']") == "ScribaSheet"

    # Cached score title extensions (.mid, .midi, .mp3, .wav, .Pdf) are stripped
    assert clean_score_title("Go Tell It On The Mountain.Pdf") == "Go Tell It On The Mountain"
    assert clean_score_title("Track_01.mid") == "Track 01"
    assert clean_score_title("Choir.mp3") == "Choir"
    assert clean_score_title("Audio.wav") == "Audio"


def test_cached_musicxml_and_stale_satb_pdf_are_rebranded_on_read_and_export(client, db_session, monkeypatch) -> None:
    from app.models import MediaAsset, Project, ProjectScore, TranscriptionJob, TranscriptionResult
    from app.storage.service import storage_service

    monkeypatch.setenv("DISABLE_MUSESCORE_PDF", "1")
    client.post(
        "/api/v1/auth/register",
        json={"email": "cached_brand@example.com", "password": "Password123!", "display_name": "Tester"},
    )
    login = client.post("/api/v1/auth/login", json={"email": "cached_brand@example.com", "password": "Password123!"})
    headers = {"Authorization": f"Bearer {login.json()['access_token']}"}

    proj = client.post(
        "/api/v1/projects",
        headers=headers,
        json={"title": "Go Tell It On The Mountain.Pdf", "instrument": "vocals", "transcription_mode": "satb_pdf"},
    ).json()
    project_id = proj["id"]
    user_id = proj["user_id"]

    stale_xml = """<?xml version="1.0" encoding="utf-8"?>
<score-partwise version="3.1">
  <work><work-title>Go Tell It On The Mountain.Pdf</work-title></work>
  <identification><creator type="composer">Music21</creator></identification>
  <part-list><score-part id="P1"><part-name>Soprano</part-name></score-part></part-list>
  <part id="P1"><measure number="1"><note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration><type>whole</type></note></measure></part>
</score-partwise>"""
    xml_key = storage_service.build_key(user_id, project_id, "musicxml", "cached.musicxml")
    storage_service.save_bytes(xml_key, stale_xml.encode("utf-8"), content_type="application/vnd.recordare.musicxml+xml")

    stale_pdf_key = storage_service.build_key(user_id, project_id, "exports", "stale_worker.pdf")
    storage_service.save_bytes(stale_pdf_key, b"%PDF-1.4\n%STALE_MUSIC21_PDF\n%%EOF", content_type="application/pdf")

    db_session.add(
        ProjectScore(
            project_id=project_id,
            version=1,
            score_json={
                "title": "Go Tell It On The Mountain.Pdf",
                "tempo_bpm": 100,
                "time_signature": "4/4",
                "key_signature": "C major",
                "duration_seconds": 2.0,
                "tracks": [{"index": 0, "name": "Soprano", "instrument": "piano", "clef": "treble", "program": 0, "muted": False}],
                "notes": [{"id": "n1", "pitch_midi": 72, "onset_sec": 0.0, "offset_sec": 1.0, "velocity": 80, "track_index": 0}],
                "chords": [],
                "analysis": {"mode": "satb_pdf"},
            },
            musicxml_path=xml_key,
        )
    )
    job = TranscriptionJob(project_id=project_id, user_id=user_id, status="completed")
    db_session.add(job)
    db_session.flush()
    stale_asset = MediaAsset(
        project_id=project_id,
        user_id=user_id,
        asset_type="export_pdf",
        original_filename="stale.pdf",
        storage_path=stale_pdf_key,
        mime_type="application/pdf",
        size_bytes=32,
    )
    db_session.add(stale_asset)
    db_session.flush()
    db_session.add(
        TranscriptionResult(
            job_id=job.id,
            metadata_json={"handler": "real_omr_homr", "pdf_asset_id": stale_asset.id, "pdf_score_version": 1},
        )
    )
    db_session.commit()

    # GET /score returns sanitized MusicXML starting with <?xml declaration & clean title
    score_res = client.get(f"/api/v1/projects/{project_id}/score", headers=headers)
    assert score_res.status_code == 200
    body = score_res.json()
    assert body["score_json"]["title"] == "Go Tell It On The Mountain"
    assert body["musicxml"].lstrip().startswith("<?xml")
    out_root = ET.fromstring(body["musicxml"])
    assert out_root.findtext("./work/work-title") == "Go Tell It On The Mountain"
    assert out_root.findtext("./identification/creator[@type='composer']") == "ScribaSheet"

    # PDF export skips stale worker PDF without branding_version and regenerates cleanly
    pdf_exp = client.post(f"/api/v1/projects/{project_id}/exports", headers=headers, json={"format": "pdf"})
    assert pdf_exp.status_code == 201
    pdf_dl = client.get(pdf_exp.json()["download_url"], headers=headers)
    assert pdf_dl.status_code == 200
    assert b"STALE_MUSIC21_PDF" not in pdf_dl.content
    assert pdf_dl.content.startswith(b"%PDF-")


def test_omr_copyright_permission_filtering_preserves_legitimate_lyrics() -> None:
    from app.notation.omr import _is_footer_or_metadata_text

    # Copyright & permission footer phrases are filtered
    assert _is_footer_or_metadata_text("For non-commercial personal use only") is True
    assert _is_footer_or_metadata_text("All rights reserved. Making copies prohibited.") is True
    assert _is_footer_or_metadata_text("May not be reproduced without permission") is True
    assert _is_footer_or_metadata_text("commercial", default_y=-130.0) is True

    # Legitimate single-word lyric in normal staff lyric zone is preserved
    assert _is_footer_or_metadata_text("permission", default_y=-75.0) is False
    assert _is_footer_or_metadata_text("mountain", default_y=-80.0) is False


def test_multinote_copyright_and_credit_phrase_filtering_and_genuine_tb_preservation() -> None:
    from app.notation.omr import sanitize_omr_musicxml

    # 1. Split multi-note phrases ("by An-drew Moore" & "Ma-king co-pies non - church, and per-son-al use") in Bass
    split_xml = """<?xml version="1.0" encoding="utf-8"?>
<score-partwise version="3.1">
  <part-list>
    <score-part id="P1"><part-name>Soprano</part-name></score-part>
    <score-part id="P2"><part-name>Bass</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="1">
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>1</duration><lyric number="1"><text>Go</text></lyric></note>
      <note><pitch><step>D</step><octave>5</octave></pitch><duration>1</duration><lyric number="1"><text>tell</text></lyric></note>
      <note><pitch><step>E</step><octave>5</octave></pitch><duration>1</duration><lyric number="1"><text>it</text></lyric></note>
      <note><pitch><step>F</step><octave>5</octave></pitch><duration>1</duration><lyric number="1"><text>on</text></lyric></note>
    </measure>
  </part>
  <part id="P2">
    <measure number="1">
      <note><pitch><step>C</step><octave>3</octave></pitch><duration>1</duration><lyric number="1"><text>by</text></lyric></note>
      <note><pitch><step>D</step><octave>3</octave></pitch><duration>1</duration><lyric number="1"><syllabic>begin</syllabic><text>An-</text></lyric></note>
      <note><pitch><step>E</step><octave>3</octave></pitch><duration>1</duration><lyric number="1"><syllabic>end</syllabic><text>drew</text></lyric></note>
      <note><pitch><step>F</step><octave>3</octave></pitch><duration>1</duration><lyric number="1"><text>Moore</text></lyric></note>
    </measure>
    <measure number="2">
      <note><pitch><step>G</step><octave>2</octave></pitch><duration>1</duration><lyric number="1"><syllabic>begin</syllabic><text>Ma-</text></lyric></note>
      <note><pitch><step>G</step><octave>2</octave></pitch><duration>1</duration><lyric number="1"><syllabic>end</syllabic><text>king</text></lyric></note>
      <note><pitch><step>G</step><octave>2</octave></pitch><duration>1</duration><lyric number="1"><syllabic>begin</syllabic><text>co-</text></lyric></note>
      <note><pitch><step>G</step><octave>2</octave></pitch><duration>1</duration><lyric number="1"><syllabic>end</syllabic><text>pies</text></lyric></note>
      <note><pitch><step>G</step><octave>2</octave></pitch><duration>1</duration><lyric number="1"><text>non</text></lyric></note>
      <note><pitch><step>G</step><octave>2</octave></pitch><duration>1</duration><lyric number="1"><text>-</text></lyric></note>
      <note><pitch><step>G</step><octave>2</octave></pitch><duration>1</duration><lyric number="1"><text>church,</text></lyric></note>
      <note><pitch><step>G</step><octave>2</octave></pitch><duration>1</duration><lyric number="1"><text>and</text></lyric></note>
      <note><pitch><step>G</step><octave>2</octave></pitch><duration>1</duration><lyric number="1"><syllabic>begin</syllabic><text>per-</text></lyric></note>
      <note><pitch><step>G</step><octave>2</octave></pitch><duration>1</duration><lyric number="1"><syllabic>middle</syllabic><text>son-</text></lyric></note>
      <note><pitch><step>G</step><octave>2</octave></pitch><duration>1</duration><lyric number="1"><syllabic>end</syllabic><text>al</text></lyric></note>
      <note><pitch><step>G</step><octave>2</octave></pitch><duration>1</duration><lyric number="1"><text>use</text></lyric></note>
    </measure>
  </part>
</score-partwise>"""
    cleaned, _ = sanitize_omr_musicxml(split_xml)
    root = ET.fromstring(cleaned)
    parts = root.findall("part")
    sop_lyrics = [t.text for t in parts[0].findall(".//lyric/text")]
    bass_lyrics = [t.text for t in parts[1].findall(".//lyric/text")]
    assert sop_lyrics == ["Go", "tell", "it", "on"]
    assert bass_lyrics == []

    # 2. Genuine 4-part choral lyrics in Bass are preserved
    genuine_tb_xml = """<?xml version="1.0" encoding="utf-8"?>
<score-partwise version="3.1">
  <part-list>
    <score-part id="P1"><part-name>Soprano</part-name></score-part>
    <score-part id="P2"><part-name>Bass</part-name></score-part>
  </part-list>
  <part id="P1"><measure number="1">""" + "".join(
        f'<note><pitch><step>C</step><octave>5</octave></pitch><duration>1</duration><lyric number="1"><text>la{i}</text></lyric></note>'
        for i in range(12)
    ) + """</measure></part>
  <part id="P2"><measure number="1">""" + "".join(
        f'<note><pitch><step>C</step><octave>3</octave></pitch><duration>1</duration><lyric number="1"><text>dum{i}</text></lyric></note>'
        for i in range(10)
    ) + """</measure></part>
</score-partwise>"""
    cleaned_tb, _ = sanitize_omr_musicxml(genuine_tb_xml)
    tb_root = ET.fromstring(cleaned_tb)
    assert len(tb_root.findall("part")[1].findall(".//lyric/text")) == 10


def test_satb_lyrics_consolidate_to_soprano_with_verses_and_hyphenation():
    from app.notation.omr import extract_lyrics_data_from_musicxml

    satb_split_xml = """<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list>
    <score-part id="P1"><part-name>Soprano</part-name></score-part>
    <score-part id="P2"><part-name>Alto</part-name></score-part>
    <score-part id="P3"><part-name>Tenor</part-name></score-part>
    <score-part id="P4"><part-name>Bass</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
      <note>
        <pitch><step>C</step><octave>5</octave></pitch><duration>1</duration><type>quarter</type>
        <lyric number="1"><syllabic>begin</syllabic><text>A</text></lyric>
        <lyric number="2"><syllabic>single</syllabic><text>Praise</text></lyric>
      </note>
      <note>
        <pitch><step>D</step><octave>5</octave></pitch><duration>1</duration><type>quarter</type>
      </note>
      <note>
        <pitch><step>E</step><octave>5</octave></pitch><duration>1</duration><type>quarter</type>
        <lyric number="1"><syllabic>single</syllabic><text>grace,</text></lyric>
      </note>
      <note>
        <pitch><step>F</step><octave>5</octave></pitch><duration>1</duration><type>quarter</type>
      </note>
    </measure>
  </part>
  <part id="P2">
    <measure number="1">
      <attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>1</duration><type>quarter</type></note>
      <note>
        <pitch><step>A</step><octave>4</octave></pitch><duration>1</duration><type>quarter</type>
        <lyric number="1"><syllabic>end</syllabic><text>mazing</text></lyric>
        <lyric number="2"><syllabic>single</syllabic><text>be</text></lyric>
      </note>
      <note><pitch><step>B</step><octave>4</octave></pitch><duration>1</duration><type>quarter</type></note>
      <note>
        <pitch><step>C</step><octave>5</octave></pitch><duration>1</duration><type>quarter</type>
        <lyric number="1"><syllabic>single</syllabic><text>how</text></lyric>
        <lyric number="2"><syllabic>single</syllabic><text>to</text></lyric>
      </note>
    </measure>
  </part>
  <part id="P3">
    <measure number="1">
      <attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
      <note>
        <pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><type>quarter</type>
        <lyric number="1"><syllabic>begin</syllabic><text>A</text></lyric>
      </note>
      <note><pitch><step>D</step><octave>4</octave></pitch><duration>1</duration><type>quarter</type></note>
      <note>
        <pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><type>quarter</type>
        <lyric number="1"><syllabic>single</syllabic><text>grace,</text></lyric>
      </note>
      <note><pitch><step>F</step><octave>4</octave></pitch><duration>1</duration><type>quarter</type></note>
    </measure>
  </part>
  <part id="P4">
    <measure number="1">
      <attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
      <note><pitch><step>C</step><octave>3</octave></pitch><duration>4</duration><type>whole</type></note>
    </measure>
  </part>
</score-partwise>"""
    cleaned, _ = sanitize_omr_musicxml(satb_split_xml)
    root = ET.fromstring(cleaned)
    parts = root.findall("part")
    soprano_v1 = [
        (ly.findtext("syllabic"), ly.findtext("text"))
        for ly in parts[0].findall(".//lyric[@number='1']")
    ]
    soprano_v2 = [
        (ly.findtext("syllabic"), ly.findtext("text"))
        for ly in parts[0].findall(".//lyric[@number='2']")
    ]
    assert soprano_v1 == [
        ("begin", "A"),
        ("end", "mazing"),
        ("single", "grace,"),
        ("single", "how"),
    ]
    assert soprano_v2 == [
        ("single", "Praise"),
        ("single", "be"),
        ("single", "to"),
    ]
    assert len(parts[1].findall(".//lyric")) == 0
    assert len(parts[2].findall(".//lyric")) == 0
    assert len(parts[3].findall(".//lyric")) == 0


def test_satb_strips_section_labels_and_malformed_duplicate_harmonies_while_preserving_verse_order():
    mountain_xml = """<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list>
    <score-part id="P1"><part-name>Soprano</part-name></score-part>
    <score-part id="P2"><part-name>Alto</part-name></score-part>
    <score-part id="P3"><part-name>Tenor</part-name></score-part>
    <score-part id="P4"><part-name>Bass</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="9">
      <attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
      <harmony><root><root-step>C</root-step></root><kind text="sus4">suspended-fourth</kind></harmony>
      <harmony><root><root-step>C</root-step></root><kind text="sus4">suspended-fourth</kind></harmony>
      <harmony><root><root-step>C</root-step></root><kind text="Csus4 c">other</kind></harmony>
      <note>
        <pitch><step>E</step><octave>5</octave></pitch><duration>1</duration><type>quarter</type>
        <lyric number="1"><syllabic>single</syllabic><text>Harmony</text></lyric>
      </note>
      <note>
        <pitch><step>G</step><octave>5</octave></pitch><duration>1</duration><type>quarter</type>
        <lyric number="1"><syllabic>single</syllabic><text>While</text></lyric>
        <lyric number="2"><syllabic>single</syllabic><text>The</text></lyric>
      </note>
      <note>
        <pitch><step>G</step><octave>5</octave></pitch><duration>1</duration><type>quarter</type>
        <lyric number="1"><syllabic>begin</syllabic><text>shep</text></lyric>
        <lyric number="2"><syllabic>begin</syllabic><text>shep</text></lyric>
      </note>
      <note>
        <pitch><step>E</step><octave>5</octave></pitch><duration>1</duration><type>quarter</type>
      </note>
    </measure>
    <measure number="10">
      <note>
        <pitch><step>D</step><octave>5</octave></pitch><duration>4</duration><type>whole</type>
        <lyric number="1"><syllabic>single</syllabic><text>harmonious</text></lyric>
      </note>
    </measure>
  </part>
  <part id="P2">
    <measure number="9">
      <attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
      <harmony><root><root-step>C</root-step></root><kind text="sus4">suspended-fourth</kind></harmony>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>1</duration><type>quarter</type></note>
      <note><pitch><step>E</step><octave>5</octave></pitch><duration>1</duration><type>quarter</type></note>
      <note><pitch><step>E</step><octave>5</octave></pitch><duration>1</duration><type>quarter</type></note>
      <note>
        <pitch><step>C</step><octave>5</octave></pitch><duration>1</duration><type>quarter</type>
        <lyric number="1"><syllabic>end</syllabic><text>herds</text></lyric>
        <lyric number="2"><syllabic>end</syllabic><text>herds</text></lyric>
      </note>
    </measure>
    <measure number="10">
      <note><pitch><step>B</step><octave>4</octave></pitch><duration>4</duration><type>whole</type></note>
    </measure>
  </part>
  <part id="P3">
    <measure number="9">
      <attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>4</duration><type>whole</type><lyric number="1"><text>Chorus:</text></lyric></note>
    </measure>
    <measure number="10">
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>4</duration><type>whole</type></note>
    </measure>
  </part>
  <part id="P4">
    <measure number="9">
      <attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><type>whole</type><lyric number="1"><text>D.C.</text></lyric></note>
    </measure>
    <measure number="10">
      <note><pitch><step>G</step><octave>3</octave></pitch><duration>4</duration><type>whole</type></note>
    </measure>
  </part>
</score-partwise>"""
    cleaned, _ = sanitize_omr_musicxml(mountain_xml)
    root = ET.fromstring(cleaned)
    parts = root.findall("part")
    sop_v1 = [(ly.attrib.get("number"), ly.findtext("text")) for ly in parts[0].findall(".//lyric[@number='1']")]
    sop_v2 = [(ly.attrib.get("number"), ly.findtext("text")) for ly in parts[0].findall(".//lyric[@number='2']")]
    # Section label 'Harmony' removed on Measure 9 beat 1, while Verse 1 & Verse 2 stay cleanly aligned
    assert sop_v1 == [("1", "While"), ("1", "shep"), ("1", "herds"), ("1", "harmonious")]
    assert sop_v2 == [("2", "The"), ("2", "shep"), ("2", "herds")]
    # Lower staves have zero lyrics and zero harmonies
    for lower in parts[1:]:
        assert len(lower.findall(".//lyric")) == 0
        assert len(lower.findall(".//harmony")) == 0
    # Only the single valid Csus4 harmony remains on Soprano (duplicate & malformed 'Csus4 c' removed)
    sop_harmonies = parts[0].findall(".//harmony")
    assert len(sop_harmonies) == 1
    assert sop_harmonies[0].find("kind").attrib.get("text") == "sus4"


def test_satb_places_passing_tone_lyric_on_preceding_sustaining_soprano_note():
    # Preceding Soprano half note sustains through beat 2 where Alto has passing-tone 'bright';
    # later Soprano note at beat 3 already has 'looked' and must NOT be merged with 'bright'.
    xml = """<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list>
    <score-part id="P1"><part-name>Soprano</part-name></score-part>
    <score-part id="P2"><part-name>Alto</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="10">
      <attributes><divisions>2</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration><type>half</type></note>
      <note><pitch><step>D</step><octave>5</octave></pitch><duration>4</duration><type>half</type><lyric number="1"><text>looked</text></lyric></note>
    </measure>
  </part>
  <part id="P2">
    <measure number="10">
      <attributes><divisions>2</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>3</duration><type>quarter</type><dot/></note>
      <note><pitch><step>A</step><octave>4</octave></pitch><duration>1</duration><type>eighth</type><lyric number="1"><text>bright</text></lyric></note>
      <note><pitch><step>B</step><octave>4</octave></pitch><duration>4</duration><type>half</type><lyric number="1"><text>looked</text></lyric></note>
    </measure>
  </part>
</score-partwise>"""
    cleaned, _ = sanitize_omr_musicxml(xml)
    root = ET.fromstring(cleaned)
    parts = root.findall("part")
    sop_texts = [t.text for t in parts[0].findall(".//lyric/text")]
    assert sop_texts == ["bright", "looked"]
    assert len(parts[1].findall(".//lyric")) == 0


def test_start_transcription_supersedes_previous_score_and_preserves_history(monkeypatch):
    from fastapi.testclient import TestClient
    from app.api.deps import get_current_user, get_owned_project
    from app.db.session import Base, get_db
    from app.main import app
    from app.models import MediaAsset, Project, ProjectScore, TranscriptionJob, TranscriptionResult, User

    # Build a minimal sqlite in-memory session for transcription superseding
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool

    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    db = Session()

    user = User(id="u1", email="u1@example.com", password_hash="x", display_name="User One", plan_tier="pro")
    proj = Project(id="p1", user_id="u1", title="Hymn", status="completed", instrument="piano", transcription_mode="satb_pdf")
    asset = MediaAsset(id="a1", project_id="p1", user_id="u1", asset_type="original", storage_path="p1/orig.pdf", original_filename="hymn.pdf", mime_type="application/pdf", size_bytes=100)
    old_job = TranscriptionJob(id="j1", project_id="p1", user_id="u1", source_asset_id="a1", status="completed", progress=100, current_stage="Completed", settings_json={"mode": "satb_pdf"})
    old_res = TranscriptionResult(id="r1", job_id="j1", metadata_json={"is_active": True, "job_id": "j1"})
    old_score = ProjectScore(
        id="s1",
        project_id="p1",
        version=1,
        score_json={"title": "Hymn", "tracks": [{"index": 0, "name": "Soprano"}], "notes": [], "chords": [], "analysis": {"is_active": True, "job_id": "j1"}},
    )
    db.add_all([user, proj, asset, old_job, old_res, old_score])
    db.commit()

    monkeypatch.setattr("app.api.v1.transcriptions.enqueue_transcription_job", lambda _jid: "celery-1")

    def override_db():
        yield db

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[get_owned_project] = lambda: proj
    try:
        client = TestClient(app)
        resp = client.post(
            "/api/v1/projects/p1/transcriptions",
            json={"source_asset_id": "a1", "settings": {"mode": "melody_only", "instrument": "piano"}},
        )
        assert resp.status_code == 202
        new_job_id = resp.json()["id"]

        # Previous score is superseded -> GET /score returns 404 while processing
        score_resp = client.get("/api/v1/projects/p1/score")
        assert score_resp.status_code == 404

        # Historical TranscriptionResult row is preserved and marked inactive
        db.refresh(old_res)
        assert old_res.metadata_json["is_active"] is False
        assert old_res.metadata_json["superseded_by_job_id"] == new_job_id
    finally:
        app.dependency_overrides.clear()
        db.close()

    lyrics_data = extract_lyrics_data_from_musicxml(cleaned, tempo_bpm=120.0)
    assert lyrics_data is not None
    assert "Amazing grace, how" in lyrics_data["text"]
    assert "Praise be to" in lyrics_data["text"]


def test_satb_preserves_genuine_polytextual_vocal_lyrics():
    polytextual_xml = """<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list>
    <score-part id="P1"><part-name>Soprano</part-name></score-part>
    <score-part id="P2"><part-name>Alto</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>1</duration><type>quarter</type><lyric number="1"><text>Sing</text></lyric></note>
      <note><pitch><step>D</step><octave>5</octave></pitch><duration>1</duration><type>quarter</type><lyric number="1"><text>joyful</text></lyric></note>
      <note><pitch><step>E</step><octave>5</octave></pitch><duration>1</duration><type>quarter</type><lyric number="1"><text>songs</text></lyric></note>
      <note><pitch><step>F</step><octave>5</octave></pitch><duration>1</duration><type>quarter</type><lyric number="1"><text>today</text></lyric></note>
    </measure>
  </part>
  <part id="P2">
    <measure number="1">
      <attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>1</duration><type>quarter</type><lyric number="1"><text>Kyrie</text></lyric></note>
      <note><pitch><step>A</step><octave>4</octave></pitch><duration>1</duration><type>quarter</type><lyric number="1"><text>eleison</text></lyric></note>
      <note><pitch><step>B</step><octave>4</octave></pitch><duration>1</duration><type>quarter</type><lyric number="1"><text>Christe</text></lyric></note>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>1</duration><type>quarter</type><lyric number="1"><text>amen</text></lyric></note>
    </measure>
  </part>
</score-partwise>"""
    cleaned, _ = sanitize_omr_musicxml(polytextual_xml)
    root = ET.fromstring(cleaned)
    parts = root.findall("part")
    assert [t.text for t in parts[0].findall(".//lyric/text")] == ["Sing", "joyful", "songs", "today"]
    assert [t.text for t in parts[1].findall(".//lyric/text")] == ["Kyrie", "eleison", "Christe", "amen"]


def test_satb_transfers_orphaned_passing_tone_lyrics_and_clears_all_lower_staves():
    passing_tone_xml = """<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list>
    <score-part id="P1"><part-name>Soprano</part-name></score-part>
    <score-part id="P2"><part-name>Alto</part-name></score-part>
    <score-part id="P3"><part-name>Tenor</part-name></score-part>
    <score-part id="P4"><part-name>Bass</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>2</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration><type>half</type><lyric number="1"><text>All</text></lyric></note>
      <note><pitch><step>D</step><octave>5</octave></pitch><duration>4</duration><type>half</type></note>
    </measure>
  </part>
  <part id="P2">
    <measure number="1">
      <attributes><divisions>2</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>2</duration><type>quarter</type><lyric number="1"><text>All</text></lyric></note>
      <note><pitch><step>A</step><octave>4</octave></pitch><duration>2</duration><type>quarter</type><lyric number="1"><text>bright</text></lyric></note>
      <note><pitch><step>B</step><octave>4</octave></pitch><duration>4</duration><type>half</type></note>
    </measure>
  </part>
  <part id="P3">
    <measure number="1">
      <attributes><divisions>2</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
      <note><pitch><step>E</step><octave>4</octave></pitch><duration>4</duration><type>half</type></note>
      <note><pitch><step>F</step><octave>4</octave></pitch><duration>2</duration><type>quarter</type><lyric number="1"><syllabic>begin</syllabic><text>Je</text></lyric></note>
      <note><pitch><step>E</step><octave>4</octave></pitch><duration>2</duration><type>quarter</type></note>
    </measure>
  </part>
  <part id="P4">
    <measure number="1">
      <attributes><divisions>2</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
      <note><pitch><step>C</step><octave>3</octave></pitch><duration>8</duration><type>whole</type><lyric number="1"><text>All</text></lyric></note>
    </measure>
  </part>
</score-partwise>"""
    cleaned, _ = sanitize_omr_musicxml(passing_tone_xml)
    root = ET.fromstring(cleaned)
    parts = root.findall("part")
    assert [t.text for t in parts[0].findall(".//lyric/text")] == ["All", "bright Je"]
    assert len(parts[1].findall(".//lyric")) == 0
    assert len(parts[2].findall(".//lyric")) == 0
    assert len(parts[3].findall(".//lyric")) == 0


def test_satb_strips_section_labels_and_malformed_duplicate_harmonies_while_preserving_verse_order():
    mountain_xml = """<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list>
    <score-part id="P1"><part-name>Soprano</part-name></score-part>
    <score-part id="P2"><part-name>Alto</part-name></score-part>
    <score-part id="P3"><part-name>Tenor</part-name></score-part>
    <score-part id="P4"><part-name>Bass</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="9">
      <attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
      <harmony><root><root-step>C</root-step></root><kind text="sus4">suspended-fourth</kind></harmony>
      <harmony><root><root-step>C</root-step></root><kind text="sus4">suspended-fourth</kind></harmony>
      <harmony><root><root-step>C</root-step></root><kind text="Csus4 c">other</kind></harmony>
      <note>
        <pitch><step>E</step><octave>5</octave></pitch><duration>1</duration><type>quarter</type>
        <lyric number="1"><syllabic>single</syllabic><text>Harmony</text></lyric>
      </note>
      <note>
        <pitch><step>G</step><octave>5</octave></pitch><duration>1</duration><type>quarter</type>
        <lyric number="1"><syllabic>single</syllabic><text>While</text></lyric>
        <lyric number="2"><syllabic>single</syllabic><text>The</text></lyric>
      </note>
      <note>
        <pitch><step>G</step><octave>5</octave></pitch><duration>1</duration><type>quarter</type>
        <lyric number="1"><syllabic>begin</syllabic><text>shep</text></lyric>
        <lyric number="2"><syllabic>begin</syllabic><text>shep</text></lyric>
      </note>
      <note>
        <pitch><step>E</step><octave>5</octave></pitch><duration>1</duration><type>quarter</type>
      </note>
    </measure>
    <measure number="10">
      <note>
        <pitch><step>D</step><octave>5</octave></pitch><duration>4</duration><type>whole</type>
        <lyric number="1"><syllabic>single</syllabic><text>harmonious</text></lyric>
      </note>
    </measure>
  </part>
  <part id="P2">
    <measure number="9">
      <attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
      <harmony><root><root-step>C</root-step></root><kind text="sus4">suspended-fourth</kind></harmony>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>1</duration><type>quarter</type></note>
      <note><pitch><step>E</step><octave>5</octave></pitch><duration>1</duration><type>quarter</type></note>
      <note><pitch><step>E</step><octave>5</octave></pitch><duration>1</duration><type>quarter</type></note>
      <note>
        <pitch><step>C</step><octave>5</octave></pitch><duration>1</duration><type>quarter</type>
        <lyric number="1"><syllabic>end</syllabic><text>herds</text></lyric>
        <lyric number="2"><syllabic>end</syllabic><text>herds</text></lyric>
      </note>
    </measure>
    <measure number="10">
      <note><pitch><step>B</step><octave>4</octave></pitch><duration>4</duration><type>whole</type></note>
    </measure>
  </part>
  <part id="P3">
    <measure number="9">
      <attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>4</duration><type>whole</type><lyric number="1"><text>Chorus:</text></lyric></note>
    </measure>
    <measure number="10">
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>4</duration><type>whole</type></note>
    </measure>
  </part>
  <part id="P4">
    <measure number="9">
      <attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><type>whole</type><lyric number="1"><text>D.C.</text></lyric></note>
    </measure>
    <measure number="10">
      <note><pitch><step>G</step><octave>3</octave></pitch><duration>4</duration><type>whole</type></note>
    </measure>
  </part>
</score-partwise>"""
    cleaned, _ = sanitize_omr_musicxml(mountain_xml)
    root = ET.fromstring(cleaned)
    parts = root.findall("part")
    sop_v1 = [(ly.attrib.get("number"), ly.findtext("text")) for ly in parts[0].findall(".//lyric[@number='1']")]
    sop_v2 = [(ly.attrib.get("number"), ly.findtext("text")) for ly in parts[0].findall(".//lyric[@number='2']")]
    # Section label 'Harmony' removed on Measure 9 beat 1, while Verse 1 & Verse 2 stay cleanly aligned
    assert sop_v1 == [("1", "While"), ("1", "shep"), ("1", "herds"), ("1", "harmonious")]
    assert sop_v2 == [("2", "The"), ("2", "shep"), ("2", "herds")]
    # Lower staves have zero lyrics and zero harmonies
    for lower in parts[1:]:
        assert len(lower.findall(".//lyric")) == 0
        assert len(lower.findall(".//harmony")) == 0
    # Only the single valid Csus4 harmony remains on Soprano (duplicate & malformed 'Csus4 c' removed)
    sop_harmonies = parts[0].findall(".//harmony")
    assert len(sop_harmonies) == 1
    assert sop_harmonies[0].find("kind").attrib.get("text") == "sus4"


def test_satb_places_passing_tone_lyric_on_preceding_sustaining_soprano_note():
    # Preceding Soprano half note sustains through beat 2 where Alto has passing-tone 'bright';
    # later Soprano note at beat 3 already has 'looked' and must NOT be merged with 'bright'.
    xml = """<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list>
    <score-part id="P1"><part-name>Soprano</part-name></score-part>
    <score-part id="P2"><part-name>Alto</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="10">
      <attributes><divisions>2</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration><type>half</type></note>
      <note><pitch><step>D</step><octave>5</octave></pitch><duration>4</duration><type>half</type><lyric number="1"><text>looked</text></lyric></note>
    </measure>
  </part>
  <part id="P2">
    <measure number="10">
      <attributes><divisions>2</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>3</duration><type>quarter</type><dot/></note>
      <note><pitch><step>A</step><octave>4</octave></pitch><duration>1</duration><type>eighth</type><lyric number="1"><text>bright</text></lyric></note>
      <note><pitch><step>B</step><octave>4</octave></pitch><duration>4</duration><type>half</type><lyric number="1"><text>looked</text></lyric></note>
    </measure>
  </part>
</score-partwise>"""
    cleaned, _ = sanitize_omr_musicxml(xml)
    root = ET.fromstring(cleaned)
    parts = root.findall("part")
    sop_texts = [t.text for t in parts[0].findall(".//lyric/text")]
    assert sop_texts == ["bright", "looked"]
    assert len(parts[1].findall(".//lyric")) == 0


def test_start_transcription_supersedes_previous_score_and_preserves_history(monkeypatch):
    from fastapi.testclient import TestClient
    from app.api.deps import get_current_user, get_owned_project
    from app.db.session import Base, get_db
    from app.main import app
    from app.models import MediaAsset, Project, ProjectScore, TranscriptionJob, TranscriptionResult, User

    # Build a minimal sqlite in-memory session for transcription superseding
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool

    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    db = Session()

    user = User(id="u1", email="u1@example.com", password_hash="x", display_name="User One", plan_tier="pro")
    proj = Project(id="p1", user_id="u1", title="Hymn", status="completed", instrument="piano", transcription_mode="satb_pdf")
    asset = MediaAsset(id="a1", project_id="p1", user_id="u1", asset_type="original", storage_path="p1/orig.pdf", original_filename="hymn.pdf", mime_type="application/pdf", size_bytes=100)
    old_job = TranscriptionJob(id="j1", project_id="p1", user_id="u1", source_asset_id="a1", status="completed", progress=100, current_stage="Completed", settings_json={"mode": "satb_pdf"})
    old_res = TranscriptionResult(id="r1", job_id="j1", metadata_json={"is_active": True, "job_id": "j1"})
    old_score = ProjectScore(
        id="s1",
        project_id="p1",
        version=1,
        score_json={"title": "Hymn", "tracks": [{"index": 0, "name": "Soprano"}], "notes": [], "chords": [], "analysis": {"is_active": True, "job_id": "j1"}},
    )
    db.add_all([user, proj, asset, old_job, old_res, old_score])
    db.commit()

    monkeypatch.setattr("app.api.v1.transcriptions.enqueue_transcription_job", lambda _jid: "celery-1")

    def override_db():
        yield db

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[get_owned_project] = lambda: proj
    try:
        client = TestClient(app)
        resp = client.post(
            "/api/v1/projects/p1/transcriptions",
            json={"source_asset_id": "a1", "settings": {"mode": "melody_only", "instrument": "piano"}},
        )
        assert resp.status_code == 202
        new_job_id = resp.json()["id"]

        # Previous score is superseded -> GET /score returns 404 while processing
        score_resp = client.get("/api/v1/projects/p1/score")
        assert score_resp.status_code == 404

        # Historical TranscriptionResult row is preserved and marked inactive
        db.refresh(old_res)
        assert old_res.metadata_json["is_active"] is False
        assert old_res.metadata_json["superseded_by_job_id"] == new_job_id
    finally:
        app.dependency_overrides.clear()
        db.close()


def test_put_score_persists_direct_musicxml_edits(client, db_session) -> None:
    reg = client.post(
        "/api/v1/auth/register",
        json={"email": "xml_edit@example.com", "password": "Password123!", "display_name": "Editor"},
    )
    assert reg.status_code == 201
    headers = {"Authorization": f"Bearer {reg.json()['access_token']}"}
    proj = client.post(
        "/api/v1/projects",
        headers=headers,
        json={"title": "Edited Hymn.Pdf", "instrument": "vocals", "transcription_mode": "satb_pdf"},
    ).json()
    project_id = proj["id"]

    from app.models import ProjectScore

    base_score = {
        "title": "Edited Hymn",
        "tempo_bpm": 100.0,
        "time_signature": "4/4",
        "key_signature": "C major",
        "duration_seconds": 2.0,
        "tracks": [{"index": 0, "name": "Soprano", "instrument": "piano", "clef": "treble", "program": 0, "muted": False}],
        "notes": [{"id": "n1", "pitch_midi": 72, "onset_sec": 0.0, "offset_sec": 1.0, "velocity": 80, "track_index": 0}],
        "chords": [],
        "analysis": {"mode": "satb_pdf"},
    }
    db_session.add(ProjectScore(project_id=project_id, version=1, score_json=base_score))
    db_session.commit()

    edited_xml = """<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <work><work-title>Edited Hymn.Pdf</work-title></work>
  <identification><creator type="composer">Music21</creator></identification>
  <part-list><score-part id="P1"><part-name>Soprano</part-name></score-part></part-list>
  <part id="P1"><measure number="1"><note><pitch><step>D</step><octave>5</octave></pitch><duration>4</duration><type>whole</type><lyric><text>Amen</text></lyric></note></measure></part>
</score-partwise>"""

    put_res = client.put(
        f"/api/v1/projects/{project_id}/score",
        headers=headers,
        json={"expected_version": 1, "score_json": base_score, "musicxml": edited_xml},
    )
    assert put_res.status_code == 200
    data = put_res.json()
    assert data["version"] == 2
    assert "<text>Amen</text>" in data["musicxml"]
    assert "<work-title>Edited Hymn</work-title>" in data["musicxml"]
    assert '<creator type="composer">ScribaSheet</creator>' in data["musicxml"]


def test_sanitize_omr_preserves_lyric_melisma_extend_elements():
    melisma_xml = """<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Soprano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
      <note>
        <pitch><step>C</step><octave>5</octave></pitch><duration>1</duration><type>quarter</type>
        <lyric number="1"><syllabic>single</syllabic><text>Grace</text><extend type="start"/></lyric>
      </note>
      <note>
        <pitch><step>D</step><octave>5</octave></pitch><duration>1</duration><type>quarter</type>
        <lyric number="1"><extend type="continue"/></lyric>
      </note>
      <note>
        <pitch><step>E</step><octave>5</octave></pitch><duration>2</duration><type>half</type>
        <lyric number="1"><extend type="stop"/></lyric>
      </note>
    </measure>
  </part>
</score-partwise>"""
    cleaned, _ = sanitize_omr_musicxml(melisma_xml)
    assert '<extend type="start"' in cleaned
    assert '<extend type="continue"' in cleaned
    assert '<extend type="stop"' in cleaned
