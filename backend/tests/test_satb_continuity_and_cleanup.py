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
