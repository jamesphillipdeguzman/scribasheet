import xml.etree.ElementTree as ET

from app.notation.omr import musicxml_to_satb_score_data, sanitize_omr_musicxml


def _build_away_in_a_manger_with_phantom_pickup_rest() -> str:
    parts = [
        ("P1", "Soprano", "G", "2", "C", "5"),
        ("P2", "Alto", "G", "2", "A", "4"),
        ("P3", "Tenor", "F", "4", "F", "4"),
        ("P4", "Bass", "F", "4", "F", "3"),
    ]
    part_list = "".join(
        f'<score-part id="{pid}"><part-name>{name}</part-name></score-part>'
        for pid, name, *_ in parts
    )
    part_bodies = []
    for pid, _name, sign, line, step, octave in parts:
        part_bodies.append(
            f"""
            <part id="{pid}">
              <measure number="0" implicit="yes">
                <attributes>
                  <divisions>2</divisions>
                  <key><fifths>-1</fifths></key>
                  <time><beats>3</beats><beat-type>4</beat-type></time>
                  <clef><sign>{sign}</sign><line>{line}</line></clef>
                </attributes>
                <direction placement="above">
                  <direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>68</per-minute></metronome></direction-type>
                  <sound tempo="68"/>
                </direction>
                <note>
                  <pitch><step>{step}</step><octave>{octave}</octave></pitch>
                  <duration>1</duration>
                  <type>eighth</type>
                </note>
                <note>
                  <pitch><step>{step}</step><octave>{octave}</octave></pitch>
                  <duration>1</duration>
                  <type>eighth</type>
                </note>
                <note>
                  <rest/>
                  <duration>4</duration>
                  <type>half</type>
                </note>
              </measure>
              <measure number="1">
                <note>
                  <pitch><step>{step}</step><octave>{octave}</octave></pitch>
                  <duration>4</duration>
                  <type>half</type>
                </note>
                <note>
                  <pitch><step>{step}</step><octave>{octave}</octave></pitch>
                  <duration>2</duration>
                  <type>quarter</type>
                </note>
              </measure>
              <measure number="2">
                <note>
                  <pitch><step>{step}</step><octave>{octave}</octave></pitch>
                  <duration>4</duration>
                  <type>half</type>
                </note>
                <note>
                  <rest/>
                  <duration>2</duration>
                  <type>quarter</type>
                </note>
              </measure>
            </part>
            """
        )
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<score-partwise version="3.1">'
        f"<part-list>{part_list}</part-list>"
        f"{''.join(part_bodies)}"
        "</score-partwise>"
    )


def _build_four_four_no_pickup_with_legit_rest() -> str:
    return """<?xml version="1.0" encoding="UTF-8"?>
    <score-partwise version="3.1">
      <part-list>
        <score-part id="P1"><part-name>Soprano</part-name></score-part>
      </part-list>
      <part id="P1">
        <measure number="1">
          <attributes>
            <divisions>1</divisions>
            <time><beats>4</beats><beat-type>4</beat-type></time>
            <clef><sign>G</sign><line>2</line></clef>
          </attributes>
          <note><pitch><step>C</step><octave>5</octave></pitch><duration>2</duration><type>half</type></note>
          <note><rest/><duration>2</duration><type>half</type></note>
        </measure>
        <measure number="2">
          <note><pitch><step>D</step><octave>5</octave></pitch><duration>4</duration><type>whole</type></note>
        </measure>
      </part>
    </score-partwise>"""


def test_away_in_a_manger_strips_phantom_pickup_rest_and_aligns_measure_1_to_0882s() -> None:
    raw_xml = _build_away_in_a_manger_with_phantom_pickup_rest()
    cleaned_xml, _ = sanitize_omr_musicxml(raw_xml)

    root = ET.fromstring(cleaned_xml)
    parts = root.findall("part")
    assert len(parts) == 4

    for part in parts:
        measures = part.findall("measure")
        m0, m1, m2 = measures[0], measures[1], measures[2]
        assert m0.attrib.get("implicit") == "yes"
        # Measure 0 should have only the 2 eighth pickup notes (no artificial half rest)
        assert [n.find("rest") is not None for n in m0.findall("note")] == [False, False]
        # Measure 2's legitimate trailing quarter rest must remain intact
        assert [n.find("rest") is not None for n in m2.findall("note")] == [False, True]
        assert m1.attrib.get("number") == "1"

    score_data, _assignments, _warnings, _needs_review = musicxml_to_satb_score_data(
        raw_xml,
        tempo_bpm=68.0,
        satb_mode="auto_satb",
    )
    # 2 pickup notes + 2 m1 notes + 1 m2 note = 5 notes per SATB track (20 total)
    assert len(score_data.notes) == 20
    # At 68 BPM, 1 quarter-note pickup = 60 / 68 ~= 0.8824s
    expected_m1_onset = 60.0 / 68.0
    for track_idx in range(4):
        track_notes = [n for n in score_data.notes if n.track_index == track_idx]
        assert len(track_notes) == 5
        assert track_notes[0].onset_sec == 0.0
        assert abs(track_notes[2].onset_sec - expected_m1_onset) < 0.01


def test_non_pickup_score_legitimate_trailing_rest_is_preserved() -> None:
    raw_xml = _build_four_four_no_pickup_with_legit_rest()
    cleaned_xml, _ = sanitize_omr_musicxml(raw_xml)
    root = ET.fromstring(cleaned_xml)
    m1 = root.find("part/measure")
    assert m1 is not None
    assert [n.find("rest") is not None for n in m1.findall("note")] == [False, True]
