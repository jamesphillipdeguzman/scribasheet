"""Blank MIDI Playground score and MusicXML generators."""

from __future__ import annotations

import xml.etree.ElementTree as ET
from xml.sax.saxutils import escape

from app.notation.generator import apply_scribasheet_musicxml_branding, resolve_project_score_title
from app.schemas.score import ScoreData, ScoreTrack

KEY_FIFTHS_MAP: dict[str, tuple[int, str]] = {
    "c major": (0, "major"),
    "c": (0, "major"),
    "a minor": (0, "minor"),
    "am": (0, "minor"),
    "g major": (1, "major"),
    "g": (1, "major"),
    "e minor": (1, "minor"),
    "em": (1, "minor"),
    "d major": (2, "major"),
    "d": (2, "major"),
    "b minor": (2, "minor"),
    "bm": (2, "minor"),
    "a major": (3, "major"),
    "a": (3, "major"),
    "f# minor": (3, "minor"),
    "f#m": (3, "minor"),
    "e major": (4, "major"),
    "e": (4, "major"),
    "c# minor": (4, "minor"),
    "c#m": (4, "minor"),
    "b major": (5, "major"),
    "b": (5, "major"),
    "g# minor": (5, "minor"),
    "g#m": (5, "minor"),
    "f# major": (6, "major"),
    "f#": (6, "major"),
    "d# minor": (6, "minor"),
    "d#m": (6, "minor"),
    "c# major": (7, "major"),
    "c#": (7, "major"),
    "a# minor": (7, "minor"),
    "a#m": (7, "minor"),
    "f major": (-1, "major"),
    "f": (-1, "major"),
    "d minor": (-1, "minor"),
    "dm": (-1, "minor"),
    "bb major": (-2, "major"),
    "bb": (-2, "major"),
    "g minor": (-2, "minor"),
    "gm": (-2, "minor"),
    "eb major": (-3, "major"),
    "eb": (-3, "major"),
    "c minor": (-3, "minor"),
    "cm": (-3, "minor"),
    "ab major": (-4, "major"),
    "ab": (-4, "major"),
    "f minor": (-4, "minor"),
    "fm": (-4, "minor"),
    "db major": (-5, "major"),
    "db": (-5, "major"),
    "bb minor": (-5, "minor"),
    "bbm": (-5, "minor"),
    "gb major": (-6, "major"),
    "gb": (-6, "major"),
    "eb minor": (-6, "minor"),
    "ebm": (-6, "minor"),
    "cb major": (-7, "major"),
    "cb": (-7, "major"),
    "ab minor": (-7, "minor"),
    "abm": (-7, "minor"),
}


def resolve_key_signature_fifths(key_signature: str) -> tuple[int, str, str]:
    """Return (fifths, mode, normalized_label) for a user-supplied key signature."""
    raw = " ".join((key_signature or "C Major").strip().replace("♭", "b").replace("♯", "#").split())
    lookup = raw.lower()
    if lookup in KEY_FIFTHS_MAP:
        fifths, mode = KEY_FIFTHS_MAP[lookup]
        return fifths, mode, raw
    return 0, "major", "C Major"


def parse_time_signature(time_signature: str) -> tuple[int, int, str]:
    """Parse numerator/denominator string like '3/4' or '6/8' with safe 4/4 fallback."""
    cleaned = (time_signature or "4/4").strip()
    if "/" in cleaned:
        left, right = cleaned.split("/", 1)
        try:
            beats = max(1, min(16, int(left.strip())))
            beat_type = int(right.strip())
            if beat_type in (1, 2, 4, 8, 16):
                return beats, beat_type, f"{beats}/{beat_type}"
        except ValueError:
            pass
    return 4, 4, "4/4"


def _whole_measure_rest_type(beats: int, beat_type: int) -> tuple[str, bool]:
    quarter_len = beats * (4.0 / beat_type)
    if abs(quarter_len - 4.0) < 1e-4:
        return "whole", False
    if abs(quarter_len - 3.0) < 1e-4:
        return "half", True
    if abs(quarter_len - 2.0) < 1e-4:
        return "half", False
    if abs(quarter_len - 1.5) < 1e-4:
        return "quarter", True
    if abs(quarter_len - 1.0) < 1e-4:
        return "quarter", False
    return "whole", False


def build_blank_playground_score(
    *,
    title: str = "Untitled Playground",
    key_signature: str = "C Major",
    time_signature: str = "4/4",
    tempo_bpm: float = 120.0,
    clef_mode: str = "grand",
    measures: int = 4,
) -> tuple[ScoreData, str]:
    """Create a blank ScoreData and valid grand-staff/treble/bass MusicXML document."""
    safe_clef_mode = clef_mode if clef_mode in ("grand", "treble", "bass") else "grand"
    safe_tempo = float(max(30.0, min(240.0, tempo_bpm or 120.0)))
    safe_measures = max(1, min(64, int(measures or 4)))
    fifths, mode, norm_key = resolve_key_signature_fifths(key_signature)
    beats, beat_type, norm_time = parse_time_signature(time_signature)

    divisions = 48
    measure_divs = max(1, int(round(divisions * beats * (4.0 / beat_type))))
    rest_type, rest_dotted = _whole_measure_rest_type(beats, beat_type)
    rest_dot_xml = "<dot/>" if rest_dotted else ""
    safe_title = resolve_project_score_title(title)

    quarter_beats_total = safe_measures * beats * (4.0 / beat_type)
    duration_seconds = round(quarter_beats_total * (60.0 / safe_tempo), 3)

    lines: list[str] = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<score-partwise version="3.1">',
        "  <work>",
        f"    <work-title>{escape(safe_title)}</work-title>",
        "  </work>",
        f"  <movement-title>{escape(safe_title)}</movement-title>",
        "  <identification>",
        '    <creator type="software">ScribaSheet</creator>',
        "    <encoding>",
        "      <software>ScribaSheet</software>",
        "    </encoding>",
        "  </identification>",
        "  <part-list>",
        '    <score-part id="P1">',
        "      <part-name>Piano</part-name>",
        "    </score-part>",
        "  </part-list>",
        '  <part id="P1">',
    ]

    for m_num in range(1, safe_measures + 1):
        lines.append(f'    <measure number="{m_num}">')
        if m_num == 1:
            lines.extend(
                [
                    "      <attributes>",
                    f"        <divisions>{divisions}</divisions>",
                    "        <key>",
                    f"          <fifths>{fifths}</fifths>",
                    f"          <mode>{mode}</mode>",
                    "        </key>",
                    "        <time>",
                    f"          <beats>{beats}</beats>",
                    f"          <beat-type>{beat_type}</beat-type>",
                    "        </time>",
                ]
            )
            if safe_clef_mode == "grand":
                lines.extend(
                    [
                        "        <staves>2</staves>",
                        '        <clef number="1"><sign>G</sign><line>2</line></clef>',
                        '        <clef number="2"><sign>F</sign><line>4</line></clef>',
                    ]
                )
            elif safe_clef_mode == "treble":
                lines.append("        <clef><sign>G</sign><line>2</line></clef>")
            else:
                lines.append("        <clef><sign>F</sign><line>4</line></clef>")
            lines.extend(
                [
                    "      </attributes>",
                    '      <direction placement="above">',
                    "        <direction-type>",
                    '          <metronome parentheses="no">',
                    "            <beat-unit>quarter</beat-unit>",
                    f"            <per-minute>{int(round(safe_tempo))}</per-minute>",
                    "          </metronome>",
                    "        </direction-type>",
                    f'        <sound tempo="{int(round(safe_tempo))}"/>',
                    "      </direction>",
                ]
            )

        if safe_clef_mode == "grand":
            lines.extend(
                [
                    '      <note><rest measure="yes"/>'
                    f"<duration>{measure_divs}</duration><voice>1</voice>"
                    f"<type>{rest_type}</type>{rest_dot_xml}<staff>1</staff></note>",
                    f"      <backup><duration>{measure_divs}</duration></backup>",
                    '      <note><rest measure="yes"/>'
                    f"<duration>{measure_divs}</duration><voice>2</voice>"
                    f"<type>{rest_type}</type>{rest_dot_xml}<staff>2</staff></note>",
                ]
            )
        else:
            lines.append(
                '      <note><rest measure="yes"/>'
                f"<duration>{measure_divs}</duration><voice>1</voice>"
                f"<type>{rest_type}</type>{rest_dot_xml}</note>"
            )

        if m_num == safe_measures:
            lines.append('      <barline location="right"><bar-style>light-heavy</bar-style></barline>')
        lines.append("    </measure>")

    lines.extend(["  </part>", "</score-partwise>"])
    raw_xml = "\n".join(lines)
    # Validate XML well-formedness eagerly before branding
    ET.fromstring(raw_xml)
    branded_xml = apply_scribasheet_musicxml_branding(raw_xml, title=safe_title, force_title=True)

    if safe_clef_mode == "grand":
        tracks = [
            ScoreTrack(index=0, name="Piano RH", instrument="piano", clef="treble", program=0),
            ScoreTrack(index=1, name="Piano LH", instrument="piano", clef="bass", program=0),
        ]
    elif safe_clef_mode == "treble":
        tracks = [ScoreTrack(index=0, name="Piano Treble", instrument="piano", clef="treble", program=0)]
    else:
        tracks = [ScoreTrack(index=0, name="Piano Bass", instrument="piano", clef="bass", program=0)]

    score_data = ScoreData(
        title=safe_title,
        tempo_bpm=safe_tempo,
        tempo_estimated=False,
        time_signature=norm_time,
        time_signature_estimated=False,
        key_signature=norm_key,
        key_signature_estimated=False,
        duration_seconds=duration_seconds,
        tracks=tracks,
        notes=[],
        chords=[],
        analysis={
            "source_type": "midi_playground",
            "mode": "midi_playground",
            "playground_config": {
                "clef_mode": safe_clef_mode,
                "measures": safe_measures,
            },
        },
    )
    return score_data, branded_xml
