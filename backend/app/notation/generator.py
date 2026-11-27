import io
import logging
import os
import re
import shutil
import subprocess
import tempfile
import uuid
from collections.abc import Iterable
from fractions import Fraction
from pathlib import Path
from typing import Literal

import music21
import numpy as np
import pretty_midi
import soundfile as sf
from pypdf import PdfReader, PdfWriter
from reportlab.lib.pagesizes import letter
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfgen import canvas

from app.notation.analyzer import (
    assign_guitar_tab,
    detect_chords,
    get_instrument_program_and_clef,
    quantize_seconds,
)
from app.notation.timing_map import TimingMap
from app.schemas.score import ScoreData, ScoreNote, ScoreTrack
from app.transcription.base import DetectedNote

logger = logging.getLogger(__name__)


def build_score_data(
    *,
    title: str,
    detected_notes: list[DetectedNote],
    tempo_bpm: float,
    tempo_estimated: bool,
    time_signature: str,
    time_signature_estimated: bool,
    key_signature: str,
    key_signature_estimated: bool,
    duration_seconds: float,
    instrument: str,
    quantization: str = "sixteenth",
    analysis: dict | None = None,
    timing_map: TimingMap | None = None,
    clef_override: str | None = None,
    track_name_override: str | None = None,
    chord_source_notes: list[DetectedNote] | None = None,
    audio_path: Path | None = None,
    bass_stem_path: Path | None = None,
    harmonic_stem_path: Path | None = None,
    bass_notes: list[DetectedNote] | None = None,
    monophonic: bool = False,
) -> ScoreData:
    program, default_clef = get_instrument_program_and_clef(instrument)
    clef = clef_override or default_clef
    is_guitar = "guitar" in instrument.lower() and clef != "treble"
    effective_bpm = timing_map.tempo_bpm if timing_map is not None else tempo_bpm
    sec_per_beat = 60.0 / max(20.0, effective_bpm)
    min_dur = max(0.05, sec_per_beat * 0.125)

    grid_map_ql = {
        "quarter": 1.0,
        "dotted_eighth": 0.75,
        "eighth": 0.5,
        "eighth_triplet": 1.0 / 3.0,
        "triplet": 1.0 / 3.0,
        "sixteenth": 0.25,
        "sixteenth_triplet": 1.0 / 6.0,
        "thirtysecond": 0.125,
    }
    grid_ql = grid_map_ql.get(quantization, 0.25)

    def _quantize_notes(raw_notes: list[DetectedNote]) -> list[ScoreNote]:
        if not raw_notes:
            return []
        ordered = sorted(raw_notes, key=lambda n: (n.onset_sec, n.pitch_midi))

        # Cluster near-simultaneous chord strikes (<= 35ms) so chord tones snap to a
        # unified rhythmic onset slot instead of splitting across adjacent grid positions.
        cluster_anchor_onset: dict[int, float] = {}
        if quantization != "none":
            idx = 0
            while idx < len(ordered):
                end = idx + 1
                anchor_t = float(ordered[idx].onset_sec)
                while end < len(ordered) and float(ordered[end].onset_sec) - anchor_t <= 0.035:
                    end += 1
                if end - idx > 1:
                    # Velocity-weighted mean onset aligns slightly flam'd chord attacks cleanly
                    weights = [max(1.0, float(ordered[k].velocity)) for k in range(idx, end)]
                    shared_onset = sum(float(ordered[k].onset_sec) * w for k, w in zip(range(idx, end), weights, strict=True)) / sum(weights)
                    for k in range(idx, end):
                        cluster_anchor_onset[k] = shared_onset
                idx = end

        quantized: list[ScoreNote] = []
        for idx, n in enumerate(ordered):
            eff_onset_sec = cluster_anchor_onset.get(idx, float(n.onset_sec))
            if timing_map is not None and quantization != "none":
                raw_onset_ql = max(0.0, timing_map.seconds_to_ql(eff_onset_sec))
                raw_offset_ql = max(raw_onset_ql + grid_ql, timing_map.seconds_to_ql(n.offset_sec))
                q_onset_ql = max(0.0, round(raw_onset_ql / grid_ql) * grid_ql)
                raw_dur_ql = max(grid_ql, raw_offset_ql - raw_onset_ql)
                q_dur_ql = max(grid_ql, round(raw_dur_ql / grid_ql) * grid_ql)
                onset = round(q_onset_ql * sec_per_beat, 4)
                offset = round((q_onset_ql + q_dur_ql) * sec_per_beat, 4)
            else:
                onset = quantize_seconds(eff_onset_sec, effective_bpm, quantization)
                offset = quantize_seconds(n.offset_sec, effective_bpm, quantization)
            if offset <= onset:
                offset = round(onset + min_dur, 4)
            str_num, fret_num = assign_guitar_tab(n.pitch_midi) if is_guitar else (None, None)
            raw_onset = round(max(0.0, float(n.onset_sec)), 4)
            raw_offset = round(max(raw_onset + 0.01, float(n.offset_sec)), 4)
            quantized.append(
                ScoreNote(
                    id=uuid.uuid4().hex[:12],
                    pitch_midi=n.pitch_midi,
                    onset_sec=onset,
                    offset_sec=offset,
                    raw_onset_sec=raw_onset,
                    raw_offset_sec=raw_offset,
                    velocity=n.velocity,
                    confidence=n.confidence,
                    track_index=0,
                    string_num=str_num,
                    fret_num=fret_num,
                )
            )
        quantized.sort(key=lambda x: (x.onset_sec, x.pitch_midi))
        return quantized

    score_notes = _quantize_notes(detected_notes)
    if monophonic and len(score_notes) > 1:
        mono_quantized: list[ScoreNote] = [score_notes[0]]
        for cur in score_notes[1:]:
            prev = mono_quantized[-1]
            if cur.onset_sec <= prev.onset_sec + 1e-4:
                prev_rank = prev.velocity + (prev.pitch_midi * 0.25)
                cur_rank = cur.velocity + (cur.pitch_midi * 0.25)
                if cur_rank > prev_rank:
                    mono_quantized[-1] = cur
                continue
            if prev.offset_sec > cur.onset_sec:
                prev.offset_sec = round(cur.onset_sec, 4)
            elif (
                quantization != "none"
                and cur.pitch_midi != prev.pitch_midi
                and 0.0 < (cur.onset_sec - prev.offset_sec) <= min(0.16, grid_ql * sec_per_beat * 1.05)
            ):
                # Bridge tiny notation micro-rests between syllables in monophonic vocal phrases
                # without touching raw_onset_sec / raw_offset_sec or merging repeated pitches.
                raw_gap = (
                    (cur.raw_onset_sec - prev.raw_offset_sec)
                    if (cur.raw_onset_sec is not None and prev.raw_offset_sec is not None)
                    else (cur.onset_sec - prev.offset_sec)
                )
                if raw_gap <= 0.14 and (prev.offset_sec - prev.onset_sec) >= min_dur * 1.5:
                    prev.offset_sec = cur.onset_sec
            mono_quantized.append(cur)
        score_notes = mono_quantized

    chord_notes = _quantize_notes(chord_source_notes) if chord_source_notes is not None else score_notes
    harmony_diag: dict = {}
    chords = detect_chords(
        chord_notes,
        effective_bpm,
        time_signature,
        key_signature=key_signature,
        timing_map=timing_map,
        audio_path=audio_path,
        bass_stem_path=bass_stem_path,
        harmonic_stem_path=harmonic_stem_path,
        bass_notes=bass_notes,
        diagnostics_out=harmony_diag,
    )

    track = ScoreTrack(
        index=0,
        name=track_name_override or instrument.replace("_", " ").title(),
        instrument=instrument,
        clef=clef,
        program=program,
        muted=False,
    )

    merged_analysis = dict(analysis or {})
    if harmony_diag:
        merged_analysis["harmony_diagnostics"] = harmony_diag
    if timing_map is not None:
        merged_analysis["timing_map"] = timing_map.provenance
        effective_duration = max(
            duration_seconds,
            max((n.offset_sec for n in score_notes), default=0.0),
        )
    else:
        effective_duration = duration_seconds

    return ScoreData(
        title=title,
        tempo_bpm=effective_bpm,
        tempo_estimated=tempo_estimated,
        time_signature=time_signature,
        time_signature_estimated=time_signature_estimated,
        key_signature=key_signature,
        key_signature_estimated=key_signature_estimated,
        duration_seconds=round(effective_duration, 3),
        tracks=[track],
        notes=score_notes,
        chords=chords,
        analysis=merged_analysis,
    )


def build_piano_vocal_score_data(
    *,
    title: str,
    melody_notes: list[DetectedNote],
    chord_source_notes: list[DetectedNote],
    bass_notes: list[DetectedNote] | None = None,
    other_notes: list[DetectedNote] | None = None,
    audio_path: Path | None = None,
    bass_stem_path: Path | None = None,
    harmonic_stem_path: Path | None = None,
    tempo_bpm: float = 120.0,
    tempo_estimated: bool = True,
    time_signature: str = "4/4",
    time_signature_estimated: bool = True,
    key_signature: str = "C major",
    key_signature_estimated: bool = True,
    duration_seconds: float = 0.0,
    quantization: str = "sixteenth",
    arrangement_detail: str = "balanced",
    analysis: dict | None = None,
    timing_map: TimingMap | None = None,
) -> ScoreData:
    """Build a synchronized 3-staff Piano + Vocal ScoreData (Track 0 = Vocal Melody, Track 1 = Piano Grand Staff)."""
    from app.notation.accompaniment import generate_piano_accompaniment

    melody_score = build_score_data(
        title=title,
        detected_notes=melody_notes,
        tempo_bpm=tempo_bpm,
        tempo_estimated=tempo_estimated,
        time_signature=time_signature,
        time_signature_estimated=time_signature_estimated,
        key_signature=key_signature,
        key_signature_estimated=key_signature_estimated,
        duration_seconds=duration_seconds,
        instrument="vocals",
        quantization=quantization,
        timing_map=timing_map,
        clef_override="treble",
        track_name_override="Vocal Melody",
        chord_source_notes=chord_source_notes,
        audio_path=audio_path,
        bass_stem_path=bass_stem_path,
        harmonic_stem_path=harmonic_stem_path,
        bass_notes=bass_notes,
        monophonic=True,
        analysis=analysis,
    )

    effective_bpm = melody_score.tempo_bpm
    accomp_result = generate_piano_accompaniment(
        chords=melody_score.chords,
        melody_notes=melody_notes,
        bass_notes=bass_notes,
        other_notes=other_notes,
        tempo_bpm=effective_bpm,
        time_signature=time_signature,
        key_signature=key_signature,
        duration_seconds=melody_score.duration_seconds,
        arrangement_detail=arrangement_detail,  # type: ignore[arg-type]
    )

    accomp_score = build_score_data(
        title=title,
        detected_notes=accomp_result.notes,
        tempo_bpm=effective_bpm,
        tempo_estimated=tempo_estimated,
        time_signature=time_signature,
        time_signature_estimated=time_signature_estimated,
        key_signature=key_signature,
        key_signature_estimated=key_signature_estimated,
        duration_seconds=melody_score.duration_seconds,
        instrument="piano",
        quantization=quantization,
        timing_map=timing_map,
        clef_override="grand",
        track_name_override="Piano Accompaniment",
    )

    melody_track = ScoreTrack(
        index=0,
        name="Vocal Melody",
        instrument="vocals",
        clef="treble",
        program=0,
        muted=False,
    )
    accomp_track = ScoreTrack(
        index=1,
        name="Piano Accompaniment",
        instrument="piano",
        clef="grand",
        program=0,
        muted=False,
    )
    accomp_notes = [n.model_copy(update={"track_index": 1}) for n in accomp_score.notes]
    combined_notes = sorted([*melody_score.notes, *accomp_notes], key=lambda x: (x.onset_sec, x.track_index, x.pitch_midi))

    merged_analysis = dict(melody_score.analysis or {})
    merged_analysis["accompaniment"] = accomp_result.stats
    merged_analysis["arrangement_detail"] = accomp_result.arrangement_detail
    merged_analysis["note_count"] = len(combined_notes)

    return ScoreData(
        title=title,
        tempo_bpm=effective_bpm,
        tempo_estimated=tempo_estimated,
        time_signature=time_signature,
        time_signature_estimated=time_signature_estimated,
        key_signature=key_signature,
        key_signature_estimated=key_signature_estimated,
        duration_seconds=melody_score.duration_seconds,
        tracks=[melody_track, accomp_track],
        notes=combined_notes,
        chords=melody_score.chords,
        analysis=merged_analysis,
    )


_FILENAME_NOISE_RE = re.compile(
    r"(?:[_-]?\d{2,3}\s*bpm|[_-]?(?:[A-G](?:#|b)?)[_-]?(?:maj(?:or)?|min(?:or)?|m)|[_-]?(?:preprocessed|normalized|22050|44100|mono|stereo))+$",
    re.IGNORECASE,
)


_GENERIC_SCORE_TITLES = {
    "",
    "untitled",
    "untitled project",
    "untitled score",
    "new transcription",
    "scribasheet",
    "scribasheet transcription",
    "score",
}

_MEDIA_FILENAME_TITLE_RE = re.compile(
    r"^(?:tab[-_\s]?audio|mic[-_\s]?recording|recording)[-_\s]*\d+(?:[-_\s]*trimmed)?$",
    re.IGNORECASE,
)


def clean_score_title(raw_title: str | None) -> str:
    """Clean raw filenames into readable titles while preserving real project titles."""
    text = (raw_title or "").strip()
    if not text:
        return "Untitled Score"
    # Strip known media/score file extensions (case-insensitive)
    if "." in text and text.rsplit(".", 1)[-1].lower() in {
        "wav",
        "mp3",
        "flac",
        "m4a",
        "aac",
        "ogg",
        "webm",
        "mid",
        "midi",
        "musicxml",
        "xml",
        "pdf",
        "mxl",
    }:
        text = text.rsplit(".", 1)[0].strip()
    looks_like_filename = ("_" in text or "-" in text) and " " not in text
    if looks_like_filename:
        prev = None
        while prev != text:
            prev = text
            text = _FILENAME_NOISE_RE.sub("", text).strip("_- ")
        text = re.sub(r"[_-]+", " ", text)
        text = re.sub(r"\s+", " ", text).strip()
        return text.title() if text else "Untitled Score"
    return text or "Untitled Score"


def is_generic_or_media_title(raw_title: str | None) -> bool:
    """Return True if title is blank, a generic project placeholder, or a timestamped recording name."""
    cleaned = clean_score_title(raw_title) if (raw_title and raw_title.strip()) else ""
    if not cleaned:
        return True
    if cleaned.strip().lower() in _GENERIC_SCORE_TITLES:
        return True
    return bool(_MEDIA_FILENAME_TITLE_RE.match(cleaned.strip()))


def resolve_project_score_title(project_title: str | None) -> str:
    """Resolve the authoritative score/export title from project.title."""
    if not project_title or not project_title.strip():
        return "Untitled Score"
    cleaned = clean_score_title(project_title)
    if cleaned.strip().lower() in _GENERIC_SCORE_TITLES or _MEDIA_FILENAME_TITLE_RE.match(cleaned.strip()):
        return "Untitled Score"
    return cleaned


def upsert_arranger_credit_in_xml(root: "ET.Element", transcribed_by: str | None) -> None:
    """Upsert XML-aware <creator type='arranger'> and Page 1 'Transcribed by:' credit without duplicates."""
    import xml.etree.ElementTree as ET

    cleaned = (transcribed_by or "").strip()
    ident = root.find("identification")
    if ident is None:
        ident = ET.SubElement(root, "identification")

    for existing_arr in [c for c in ident.findall("creator") if (c.attrib.get("type") or "").strip().lower() == "arranger"]:
        ident.remove(existing_arr)

    for existing_credit in list(root.findall("credit")):
        ctype = (existing_credit.findtext("credit-type") or "").strip().lower()
        cwords = " ".join((cw.text or "") for cw in existing_credit.findall("credit-words")).strip()
        if ctype == "arranger" or cwords.lower().startswith("transcribed by:"):
            root.remove(existing_credit)

    if not cleaned:
        return

    arr_el = ET.SubElement(ident, "creator", {"type": "arranger"})
    arr_el.text = cleaned

    # Determine Page 1 placement from MusicXML page-layout if available
    default_x = "120"
    default_y = "1445"
    page_layout = root.find("./defaults/page-layout")
    if page_layout is not None:
        left_margin = page_layout.findtext("./page-margins/left-margin")
        page_height = page_layout.findtext("page-height")
        top_margin = page_layout.findtext("./page-margins/top-margin")
        try:
            if left_margin:
                default_x = str(int(round(float(left_margin))))
            if page_height and top_margin:
                default_y = str(int(round(float(page_height) - float(top_margin) - 70)))
        except ValueError:
            pass

    credit_el = ET.Element("credit", {"page": "1"})
    ct_el = ET.SubElement(credit_el, "credit-type")
    ct_el.text = "arranger"
    cw_el = ET.SubElement(
        credit_el,
        "credit-words",
        {
            "default-x": default_x,
            "default-y": default_y,
            "justify": "left",
            "valign": "top",
            "font-size": "10",
        },
    )
    cw_el.text = f"Transcribed by: {cleaned}"

    # Insert before the first <part> so MusicXML element ordering stays valid
    children = list(root)
    insert_idx = next((i for i, ch in enumerate(children) if ch.tag == "part"), len(children))
    root.insert(insert_idx, credit_el)


def apply_scribasheet_musicxml_branding(
    xml_str: str,
    *,
    title: str | None = None,
    transcribed_by: str | None = None,
    force_title: bool = False,
) -> str:
    """Replace default Music21 attribution with ScribaSheet, strip title extensions, and preserve XML declaration."""
    import xml.etree.ElementTree as ET

    if not xml_str:
        return xml_str
    cleaned_input = xml_str.lstrip("\ufeff").strip()
    if "<score-partwise" not in cleaned_input and "<score-timewise" not in cleaned_input:
        return xml_str
    try:
        root = ET.fromstring(cleaned_input)
    except ET.ParseError:
        return xml_str

    generic_titles = _GENERIC_SCORE_TITLES | {"music21"}

    work_el = root.find("work")
    work_title_el = work_el.find("work-title") if work_el is not None else None
    mov_title_el = root.find("./movement-title")

    existing_wt = clean_score_title((work_title_el.text or "").strip()) if (work_title_el is not None and work_title_el.text) else ""
    existing_mt = clean_score_title((mov_title_el.text or "").strip()) if (mov_title_el is not None and mov_title_el.text) else ""
    existing_valid = next(
        (
            t
            for t in (existing_wt, existing_mt)
            if t and t.lower() not in generic_titles and not _MEDIA_FILENAME_TITLE_RE.match(t)
        ),
        "",
    )

    if force_title:
        final_title = resolve_project_score_title(title)
    else:
        cleaned_title = clean_score_title(title) if (title and title.strip()) else None
        provided_valid = bool(
            cleaned_title
            and cleaned_title.lower() not in generic_titles
            and not _MEDIA_FILENAME_TITLE_RE.match(cleaned_title)
        )
        if provided_valid and cleaned_title:
            final_title = cleaned_title
        elif existing_valid:
            final_title = existing_valid
        else:
            final_title = "Untitled Score"

    if final_title:
        if work_el is None:
            work_el = ET.Element("work")
            root.insert(0, work_el)
        if work_title_el is None:
            work_title_el = ET.SubElement(work_el, "work-title")
        work_title_el.text = final_title

        if mov_title_el is None:
            mov_title_el = ET.Element("movement-title")
            children = list(root)
            work_idx = next((i for i, ch in enumerate(children) if ch.tag == "work"), -1)
            root.insert(work_idx + 1, mov_title_el)
        mov_title_el.text = final_title

        for credit_el in list(root.findall("credit")):
            ctype = (credit_el.findtext("credit-type") or "").strip().lower()
            cwords = " ".join((cw.text or "") for cw in credit_el.findall("credit-words")).strip()
            if ctype == "title":
                for cw in credit_el.findall("credit-words"):
                    cw.text = final_title
            elif ctype == "subtitle" and cwords.lower() == final_title.lower():
                root.remove(credit_el)

    ident = root.find("identification")
    if ident is None:
        ident = ET.SubElement(root, "identification")

    has_composer = False
    for creator in ident.findall("creator"):
        c_type = (creator.attrib.get("type") or "").strip().lower()
        c_text = (creator.text or "").strip()
        if c_type == "composer":
            has_composer = True
        if c_text.lower().startswith("music21"):
            creator.text = "ScribaSheet"

    if not has_composer:
        comp_el = ET.SubElement(ident, "creator", {"type": "composer"})
        comp_el.text = "ScribaSheet"

    encoding = ident.find("encoding")
    if encoding is not None:
        for sw in encoding.findall("software"):
            if (sw.text or "").strip().lower().startswith("music21"):
                sw.text = "ScribaSheet"

    for cw in root.findall("./credit/credit-words"):
        if (cw.text or "").strip().lower() == "music21":
            cw.text = "ScribaSheet"

    for pm_el in root.iter("per-minute"):
        raw = (pm_el.text or "").strip()
        if raw:
            try:
                val = float(raw)
                if val > 0:
                    pm_el.text = str(int(round(val)))
            except ValueError:
                pass

    for sound_el in root.iter("sound"):
        raw_tempo = sound_el.get("tempo")
        if raw_tempo:
            try:
                val = float(raw_tempo.strip())
                if val > 0:
                    sound_el.set("tempo", str(int(round(val))))
            except ValueError:
                pass

    for words_el in root.iter("words"):
        if words_el.text:
            updated = re.sub(
                r"(=\s*)(\d+\.\d+)",
                lambda m: f"{m.group(1)}{int(round(float(m.group(2))))}",
                words_el.text,
            )
            updated = re.sub(
                r"(\b)(\d+\.\d+)(\s*bpm\b)",
                lambda m: f"{m.group(1)}{int(round(float(m.group(2))))}{m.group(3)}",
                updated,
                flags=re.IGNORECASE,
            )
            if updated != words_el.text:
                words_el.text = updated

    if transcribed_by is not None:
        upsert_arranger_credit_in_xml(root, transcribed_by)

    body = ET.tostring(root, encoding="unicode")
    if not body.lstrip().startswith("<?xml"):
        return f'<?xml version="1.0" encoding="UTF-8"?>\n{body}'
    return body


def _parse_key_to_music21(key_str: str) -> music21.key.Key:
    clean = (key_str or "C major").strip()
    lower = clean.lower()
    if lower.endswith(" major"):
        is_minor = False
        tonic = clean[:-6].strip()
    elif lower.endswith(" minor"):
        is_minor = True
        tonic = clean[:-6].strip()
    else:
        is_minor = clean.endswith("m") and len(clean) > 1
        tonic = clean[:-1] if is_minor else clean
    tonic = tonic.replace("b", "-")
    try:
        return music21.key.Key(tonic, "minor" if is_minor else "major")
    except Exception:
        return music21.key.Key("C", "major")


def _split_rh_lh_notes(notes: list[ScoreNote]) -> tuple[list[ScoreNote], list[ScoreNote]]:
    """Assign piano notes to RH (treble) and LH (bass) using contextual sequence optimization."""
    from app.notation.hand_assignment import assign_hands_contextual

    return assign_hands_contextual(notes)


_STANDARD_DURS_EIGHTH = (0.5, 1.0, 1.5, 2.0, 3.0, 4.0)
_STANDARD_DURS_SIXTEENTH = (0.25, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0, 4.0)


_STANDARD_DURS_TRIPLET = (1.0 / 3.0, 0.5, 2.0 / 3.0, 1.0, 4.0 / 3.0, 1.5, 2.0, 3.0, 4.0)


def _select_rhythmic_grid_ql(
    notes: list[ScoreNote],
    tempo_bpm: float,
    quantization: str | None = None,
) -> float:
    """Choose rhythmic grid (quarterLength), honoring explicit triplet/eighth/quarter settings."""
    if quantization == "eighth_triplet" or quantization == "triplet":
        return 1.0 / 3.0
    if quantization == "quarter":
        return 1.0
    if quantization == "eighth":
        return 0.5
    if not notes:
        return 0.5
    beats_per_sec = max(20.0, tempo_bpm) / 60.0
    onsets_ql = sorted({round(n.onset_sec * beats_per_sec * 4.0) / 4.0 for n in notes})
    odd_16th = sum(1 for q in onsets_ql if abs((q * 2.0) - round(q * 2.0)) > 0.1)
    short_durs = sum(
        1 for n in notes if 0.12 <= ((n.offset_sec - n.onset_sec) * beats_per_sec) < 0.38
    )
    if tempo_bpm >= 105.0 or (len(onsets_ql) >= 6 and (odd_16th / len(onsets_ql)) >= 0.22) or (
        len(notes) >= 6 and (short_durs / len(notes)) >= 0.25
    ):
        return 0.25
    return 0.5


def _normalize_duration_ql(raw_dur_ql: float, grid_ql: float) -> float:
    """Snap duration to standard musical values (no double dots or tiny fragments)."""
    if abs(grid_ql - (1.0 / 3.0)) < 0.02:
        allowed: tuple[float, ...] = _STANDARD_DURS_TRIPLET
    elif grid_ql <= 0.25:
        allowed = _STANDARD_DURS_SIXTEENTH
    else:
        allowed = _STANDARD_DURS_EIGHTH
    clamped = max(allowed[0], min(allowed[-1], raw_dur_ql))
    return min(allowed, key=lambda val: (abs(val - clamped), val))


def _pack_notes_into_voices(
    notes: Iterable[ScoreNote],
    beats_per_sec: float,
    *,
    grid_ql: float = 0.5,
    measure_ql: float = 4.0,
) -> list[list[tuple[float, float, list[int], int]]]:
    """Pack quantized notes into <=2 non-overlapping voices per staff when possible."""
    sorted_notes = sorted(notes, key=lambda n: (n.onset_sec, n.pitch_midi))
    if not sorted_notes:
        return [[]]

    step = 1.0 / grid_ql
    raw_events: list[tuple[float, float, int, int]] = []
    for n in sorted_notes:
        start_ql = max(0.0, round(n.onset_sec * beats_per_sec * step) / step)
        raw_dur_ql = max(grid_ql, (n.offset_sec - n.onset_sec) * beats_per_sec)
        dur_ql = _normalize_duration_ql(raw_dur_ql, grid_ql)
        end_ql = start_ql + dur_ql

        # Trim tiny barline overshoot (<= 0.5 ql) if the note already has >= 1.0 ql before the barline
        if measure_ql > 0:
            next_bar = (int(start_ql // measure_ql) + 1) * measure_ql
            overshoot = end_ql - next_bar
            if 0.0 < overshoot <= 0.5 and (next_bar - start_ql) >= 1.0:
                end_ql = next_bar
        raw_events.append((start_ql, end_ql, n.pitch_midi, n.velocity))

    # Group simultaneous notes at the same quantized onset into chords (even with minor release diff)
    raw_events.sort(key=lambda x: (x[0], -x[1], x[2]))
    chord_groups: list[tuple[float, float, list[int], int]] = []
    for start_ql, end_ql, pitch, vel in raw_events:
        placed_in_chord = False
        for idx in range(len(chord_groups) - 1, -1, -1):
            g_s, g_e, g_pitches, _ = chord_groups[idx]
            if abs(g_s - start_ql) > 1e-6:
                break
            if pitch not in g_pitches and abs(g_e - end_ql) <= max(grid_ql, 0.5):
                g_pitches.append(pitch)
                placed_in_chord = True
                break
        if not placed_in_chord:
            chord_groups.append((start_ql, end_ql, [pitch], vel))

    voices: list[list[tuple[float, float, list[int], int]]] = []
    voice_ends: list[float] = []
    preferred_max_voices = 2

    for start_ql, end_ql, pitches, vel in chord_groups:
        sorted_p = sorted(pitches)
        placed = False
        # 1. Try placing without overlap in existing voices (preferring Voice 1, then Voice 2)
        for v_idx, v_end in enumerate(voice_ends):
            if start_ql >= v_end - 1e-6:
                voices[v_idx].append((start_ql, end_ql, sorted_p, vel))
                voice_ends[v_idx] = end_ql
                placed = True
                break

        # 2. If voices < 2, allocate Voice 2
        if not placed and len(voices) < preferred_max_voices:
            voices.append([(start_ql, end_ql, sorted_p, vel)])
            voice_ends.append(end_ql)
            placed = True

        # 3. If both voices are occupied, trim a trailing sustain tail if onset advanced >= grid_ql
        if not placed:
            for v_idx in range(len(voices)):
                prev_s, _prev_e, prev_p, prev_vel = voices[v_idx][-1]
                if start_ql >= prev_s + grid_ql - 1e-6:
                    trimmed_dur = _normalize_duration_ql(start_ql - prev_s, grid_ql)
                    new_prev_e = min(start_ql, prev_s + trimmed_dur)
                    if new_prev_e > prev_s + 1e-6:
                        voices[v_idx][-1] = (prev_s, new_prev_e, prev_p, prev_vel)
                        voices[v_idx].append((start_ql, end_ql, sorted_p, vel))
                        voice_ends[v_idx] = end_ql
                        placed = True
                        break

        # 4. Genuine 3+ simultaneous distinct-duration voices: preserve notes and log warning
        if not placed:
            logger.warning(
                "Passage at %.2f ql requires >2 simultaneous voices; allocating overflow voice %d to preserve notes.",
                start_ql,
                len(voices) + 1,
            )
            voices.append([(start_ql, end_ql, sorted_p, vel)])
            voice_ends.append(end_ql)

    return voices or [[]]


def _to_music21_ql(dur_ql: float) -> float | Fraction:
    """Preserve exact Fraction(n, 3) for triplet durations so music21 exports valid MusicXML."""
    nearest_third = round(dur_ql * 3.0)
    if nearest_third > 0 and abs(dur_ql - (nearest_third / 3.0)) < 0.015 and nearest_third % 3 != 0:
        return Fraction(nearest_third, 3)
    return round(dur_ql, 4)


_SHARP_PC_SPELLING: dict[int, tuple[str, float]] = {
    0: ("C", 0.0),
    1: ("C", 1.0),
    2: ("D", 0.0),
    3: ("D", 1.0),
    4: ("E", 0.0),
    5: ("F", 0.0),
    6: ("F", 1.0),
    7: ("G", 0.0),
    8: ("G", 1.0),
    9: ("A", 0.0),
    10: ("A", 1.0),
    11: ("B", 0.0),
}

_FLAT_PC_SPELLING: dict[int, tuple[str, float]] = {
    0: ("C", 0.0),
    1: ("D", -1.0),
    2: ("D", 0.0),
    3: ("E", -1.0),
    4: ("E", 0.0),
    5: ("F", 0.0),
    6: ("G", -1.0),
    7: ("G", 0.0),
    8: ("A", -1.0),
    9: ("A", 0.0),
    10: ("B", -1.0),
    11: ("B", 0.0),
}


def _build_key_spelling_map(key_obj: music21.key.Key) -> dict[int, tuple[str, float]]:
    """Build a pitch-class -> (step, alter) map respecting diatonic key signature & minor leading tones."""
    pc_map: dict[int, tuple[str, float]] = {}
    for p in key_obj.pitches:
        alter = float(p.accidental.alter) if p.accidental is not None else 0.0
        pc_map.setdefault(int(p.pitchClass), (p.step, alter))

    # In minor keys, prefer the raised harmonic-minor leading tone (degree 7 raised by 1 semitone)
    if key_obj.mode == "minor" and len(key_obj.pitches) >= 7:
        seventh = key_obj.pitches[6]
        raised_alter = (float(seventh.accidental.alter) if seventh.accidental is not None else 0.0) + 1.0
        if -1.0 <= raised_alter <= 2.0:
            raised_pc = (int(seventh.pitchClass) + 1) % 12
            pc_map.setdefault(raised_pc, (seventh.step, raised_alter))

    return pc_map


def _spell_pitch_for_key(
    midi_pitch: int,
    key_obj: music21.key.Key | None,
    key_pc_map: dict[int, tuple[str, float]] | None = None,
) -> music21.pitch.Pitch:
    """Create a music21 Pitch with exact MIDI value spelled appropriately for the active key."""
    if key_obj is None:
        return music21.pitch.Pitch(midi=midi_pitch)

    pc_map = key_pc_map if key_pc_map is not None else _build_key_spelling_map(key_obj)
    pc = midi_pitch % 12
    spec = pc_map.get(pc)
    if spec is None:
        if key_obj.sharps > 0:
            spec = _SHARP_PC_SPELLING[pc]
        elif key_obj.sharps < 0:
            spec = _FLAT_PC_SPELLING[pc]
        else:
            return music21.pitch.Pitch(midi=midi_pitch)

    step, alter = spec
    octave = (midi_pitch - int(round(alter))) // 12 - 1
    candidate = music21.pitch.Pitch(step=step, octave=octave)
    if abs(alter) > 1e-6:
        candidate.accidental = music21.pitch.Accidental(alter)
    if candidate.midi == midi_pitch:
        return candidate
    return music21.pitch.Pitch(midi=midi_pitch)


def _build_m21_element(
    pitches: list[int],
    dur_ql: float,
    velocity: int,
    tie_type: str | None,
    stem_direction: str | None = None,
    key_obj: music21.key.Key | None = None,
    key_pc_map: dict[int, tuple[str, float]] | None = None,
) -> music21.note.NotRest:
    spelled = [_spell_pitch_for_key(p, key_obj, key_pc_map) for p in pitches]
    if len(spelled) == 1:
        elem: music21.note.NotRest = music21.note.Note(spelled[0])
    else:
        elem = music21.chord.Chord(spelled)
    elem.quarterLength = _to_music21_ql(dur_ql)
    elem.volume.velocity = max(1, min(127, velocity))
    if tie_type:
        elem.tie = music21.tie.Tie(tie_type)
    if stem_direction:
        elem.stemDirection = stem_direction
    return elem


def _attach_chord_symbols(part: music21.stream.Part, chords: list) -> None:
    """Attach semantic music21 ChordSymbol annotations above the staff at measure/beat offsets."""
    from app.notation.harmonic_engine import normalize_chord_symbol

    if not chords:
        return
    measures = {m.number: m for m in part.getElementsByClass(music21.stream.Measure)}
    seen_positions: set[tuple[int, float]] = set()
    for ch in chords:
        m = measures.get(ch.measure) or measures.get(1)
        if m is None:
            continue
        target_m = m.number
        beat_offset = round(max(0.0, float(ch.beat) - 1.0), 2)
        pos_key = (target_m, beat_offset)
        if pos_key in seen_positions:
            continue
        seen_positions.add(pos_key)
        try:
            symbol_m21 = normalize_chord_symbol(ch.symbol) or ch.symbol
            if len(symbol_m21) > 1 and symbol_m21[1] == "b":
                symbol_m21 = symbol_m21[0] + "-" + symbol_m21[2:]
            if "/" in symbol_m21:
                head, bass = symbol_m21.split("/", 1)
                if len(bass) > 1 and bass[1] == "b":
                    bass = bass[0] + "-" + bass[2:]
                symbol_m21 = f"{head}/{bass}"
            cs = music21.harmony.ChordSymbol(symbol_m21)
            cs.placement = "above"
            m.insert(beat_offset, cs)
        except Exception:
            continue


def _normalize_musicxml_harmonies(root, chords: list) -> None:
    """Normalize MusicXML <harmony> tags to valid kind/text/bass/degree lead-sheet notation."""
    import xml.etree.ElementTree as ET

    from app.notation.harmonic_engine import chord_symbol_to_musicxml_spec

    harmonies = root.findall(".//part/measure/harmony")
    if not harmonies:
        return

    for idx, harm_el in enumerate(harmonies):
        ch = chords[idx] if idx < len(chords) else None
        if ch is None:
            continue
        spec = chord_symbol_to_musicxml_spec(
            ch.symbol,
            fallback_root=getattr(ch, "root", None),
            fallback_quality=getattr(ch, "quality", None),
        )
        if spec is None:
            continue
        root_step, root_alter, kind_val, kind_text, bass_step, bass_alter, degrees = spec

        for child in list(harm_el):
            if child.tag in ("root", "kind", "bass", "degree", "inversion"):
                harm_el.remove(child)

        root_el = ET.Element("root")
        rs_el = ET.SubElement(root_el, "root-step")
        rs_el.text = root_step
        if root_alter != 0:
            ra_el = ET.SubElement(root_el, "root-alter")
            ra_el.text = str(root_alter)
        harm_el.insert(0, root_el)

        kind_el = ET.Element("kind", {"text": kind_text})
        kind_el.text = kind_val
        harm_el.insert(1, kind_el)

        insert_pos = 2
        if bass_step:
            bass_el = ET.Element("bass")
            bs_el = ET.SubElement(bass_el, "bass-step")
            bs_el.text = bass_step
            if bass_alter and bass_alter != 0:
                ba_el = ET.SubElement(bass_el, "bass-alter")
                ba_el.text = str(bass_alter)
            harm_el.insert(insert_pos, bass_el)
            insert_pos += 1

        for deg_val, deg_alt, deg_type in degrees:
            deg_el = ET.Element("degree")
            dv_el = ET.SubElement(deg_el, "degree-value")
            dv_el.text = str(deg_val)
            da_el = ET.SubElement(deg_el, "degree-alter")
            da_el.text = str(deg_alt)
            dt_el = ET.SubElement(deg_el, "degree-type")
            dt_el.text = deg_type
            harm_el.insert(insert_pos, deg_el)
            insert_pos += 1


def _apply_key_signature_and_accidentals(part: music21.stream.Part, key_str: str) -> None:
    """Suppress redundant diatonic naturals while preserving genuine in-measure cancellations."""
    key_obj = _parse_key_to_music21(key_str)
    part.makeAccidentals(inPlace=True)
    key_alters: dict[str, float] = {}
    for step in ("A", "B", "C", "D", "E", "F", "G"):
        acc = key_obj.accidentalByStep(step)
        key_alters[step] = float(acc.alter) if acc is not None else 0.0

    for m in part.getElementsByClass(music21.stream.Measure):
        measure_state: dict[tuple[str, int], float] = {}
        for el in m.recurse().notes:
            pitches = [el.pitch] if isinstance(el, music21.note.Note) else list(el.pitches)
            for p in pitches:
                expected = key_alters.get(p.step, 0.0)
                active = measure_state.get((p.step, p.octave), expected)
                actual = float(p.accidental.alter) if p.accidental is not None else 0.0
                if abs(actual - active) < 1e-6:
                    if p.accidental is not None:
                        p.accidental.displayStatus = False
                else:
                    if p.accidental is None:
                        p.accidental = music21.pitch.Accidental(actual)
                    p.accidental.displayStatus = True
                    measure_state[(p.step, p.octave)] = actual


def _populate_part_from_notes(
    part: music21.stream.Part,
    notes: Iterable[ScoreNote],
    tempo_bpm: float,
    time_sig: str,
    key_str: str,
    clef_obj: music21.clef.Clef,
    min_measures: int = 1,
    grid_ql: float = 0.5,
    pickup_ql: float = 0.0,
) -> None:
    beats_per_sec = max(20.0, tempo_bpm) / 60.0
    ts_obj = music21.meter.TimeSignature(time_sig)
    measure_ql = float(ts_obj.barDuration.quarterLength)
    key_obj = _parse_key_to_music21(key_str)
    key_pc_map = _build_key_spelling_map(key_obj)

    voices = _pack_notes_into_voices(notes, beats_per_sec, grid_ql=grid_ql, measure_ql=measure_ql)
    max_end_ql = max((ev[1] for v in voices for ev in v), default=measure_ql)
    has_pickup = 0.0 < pickup_ql < measure_ql - 1e-6
    if has_pickup:
        total_measures = max(min_measures, 1 + int(np.ceil(max(0.0, max_end_ql - pickup_ql) / measure_ql)))
    else:
        total_measures = max(min_measures, int(np.ceil(max_end_ql / measure_ql)))

    for m_idx in range(total_measures):
        if has_pickup and m_idx == 0:
            m_start = 0.0
            m_end = pickup_ql
            m = music21.stream.Measure(number=0)
            m.paddingLeft = measure_ql - pickup_ql
        elif has_pickup:
            m_start = pickup_ql + (m_idx - 1) * measure_ql
            m_end = m_start + measure_ql
            m = music21.stream.Measure(number=m_idx)
        else:
            m_start = m_idx * measure_ql
            m_end = (m_idx + 1) * measure_ql
            m = music21.stream.Measure(number=m_idx + 1)
        if m_idx == 0:
            m.append(clef_obj)
            m.append(music21.meter.TimeSignature(time_sig))
            m.append(key_obj)
            m.append(music21.tempo.MetronomeMark(number=int(round(float(tempo_bpm or 120.0)))))
        elif (m_idx - (1 if has_pickup else 0)) % 4 == 0:
            m.insert(0, music21.layout.SystemLayout(isNew=True))

        active_voices: list[tuple[int, list[tuple[float, float, list[int], int]]]] = []
        for v_idx, v_events in enumerate(voices):
            sliced = [
                (ev_s, ev_e, pitches, vel)
                for ev_s, ev_e, pitches, vel in v_events
                if ev_e > m_start + 1e-6 and ev_s < m_end - 1e-6
            ]
            if sliced or v_idx == 0:
                active_voices.append((v_idx + 1, sliced))

        use_voice_containers = len(active_voices) > 1
        for voice_num, v_events in active_voices:
            target_stream: music21.stream.Stream = (
                music21.stream.Voice(id=str(voice_num)) if use_voice_containers else m
            )
            stem_dir = ("up" if voice_num == 1 else "down") if use_voice_containers else None
            is_secondary_voice = use_voice_containers and voice_num > 1
            cursor = m_start
            for ev_s, ev_e, pitches, vel in v_events:
                seg_s = max(m_start, ev_s)
                seg_e = min(m_end, ev_e)
                if seg_s > cursor + 1e-6:
                    rest = music21.note.Rest(quarterLength=_to_music21_ql(seg_s - cursor))
                    if is_secondary_voice:
                        rest.style.hideObjectOnPrint = True
                    target_stream.append(rest)
                continues_before = ev_s < m_start - 1e-6
                continues_after = ev_e > m_end + 1e-6
                tie_type: str | None = None
                if continues_before and continues_after:
                    tie_type = "continue"
                elif continues_before:
                    tie_type = "stop"
                elif continues_after:
                    tie_type = "start"

                seg_dur = round(seg_e - seg_s, 4)
                if seg_dur > 1e-6:
                    target_stream.append(
                        _build_m21_element(
                            pitches,
                            seg_dur,
                            vel,
                            tie_type,
                            stem_dir,
                            key_obj=key_obj,
                            key_pc_map=key_pc_map,
                        )
                    )
                    cursor = seg_e
            if cursor < m_end - 1e-6:
                rest = music21.note.Rest(quarterLength=_to_music21_ql(m_end - cursor))
                if is_secondary_voice:
                    rest.style.hideObjectOnPrint = True
                target_stream.append(rest)

            if use_voice_containers:
                m.insert(0, target_stream)

        part.append(m)

    try:
        part.makeBeams(inPlace=True)
    except Exception:
        pass
    _apply_key_signature_and_accidentals(part, key_str)


def _attach_ottava_spanners(
    part: music21.stream.Part,
    *,
    min_high_midi: int = 84,
    min_low_midi: int = 72,
    min_notes: int = 3,
    min_total_ql: float = 1.0,
) -> int:
    """Attach non-overlapping 8va Ottava spanners to sustained high-register treble passages.

    Uses ``transposing=False`` so MusicXML emits semantic ``<octave-shift>``
    elements without altering sounding MIDI pitches.
    """
    elements = [
        el
        for el in part.recurse().notes
        if not isinstance(el, music21.harmony.ChordSymbol)
    ]
    if len(elements) < min_notes:
        return 0

    runs: list[list[music21.note.NotRest]] = []
    current_run: list[music21.note.NotRest] = []

    for el in elements:
        pitches = [int(p.midi) for p in el.pitches] if isinstance(el, music21.chord.Chord) else [int(el.pitch.midi)]
        if not pitches:
            continue
        if max(pitches) >= min_high_midi and min(pitches) >= min_low_midi:
            current_run.append(el)
        else:
            if len(current_run) >= min_notes and sum(float(n.quarterLength) for n in current_run) >= min_total_ql:
                runs.append(current_run)
            current_run = []

    if len(current_run) >= min_notes and sum(float(n.quarterLength) for n in current_run) >= min_total_ql:
        runs.append(current_run)

    spanned_ids: set[int] = set()
    attached = 0
    for run in runs:
        if any(id(el) in spanned_ids for el in run):
            continue
        ott = music21.spanner.Ottava(run, type="8va", transposing=False)
        part.insert(0, ott)
        for el in run:
            spanned_ids.add(id(el))
        attached += 1
    return attached


def _attach_lyrics_to_part(
    part: music21.stream.Part,
    lyrics_dict: dict,
    track_notes: list[ScoreNote],
    tempo_bpm: float,
) -> set[int]:
    """Attach aligned MusicXML <lyric> elements to melody notes and return ordinal indices needing <extend/>."""
    if not lyrics_dict or not track_notes:
        return set()
    try:
        from app.notation.lyrics_alignment import align_lyrics_to_notes
        from app.schemas.lyrics import LyricsData

        lyrics_obj = LyricsData(**lyrics_dict)
    except Exception:
        return set()

    alignment = align_lyrics_to_notes(lyrics_obj, track_notes)
    if not alignment.by_onset_sec:
        return set()

    beats_per_sec = max(20.0, float(tempo_bpm or 120.0)) / 60.0
    # Flatten notes with their offset in quarterLengths relative to part start
    m21_notes: list[tuple[float, music21.note.Note]] = []
    for el in part.recurse().notes:
        if isinstance(el, music21.note.Note):
            offset_ql = float(el.getOffsetInHierarchy(part))
            m21_notes.append((offset_ql / beats_per_sec, el))
    m21_notes.sort(key=lambda pair: pair[0])

    extend_ordinals: set[int] = set()
    lyric_ordinal = 0
    used_idx: set[int] = set()
    search_start = 0
    for target_sec, item in alignment.by_onset_sec:
        best_i: int | None = None
        best_d = float("inf")
        for i in range(search_start, len(m21_notes)):
            if i in used_idx:
                continue
            d = abs(m21_notes[i][0] - target_sec)
            if d < best_d:
                best_d = d
                best_i = i
            if m21_notes[i][0] - target_sec > 0.35:
                break
        if best_i is not None and best_d <= 0.35:
            note_el = m21_notes[best_i][1]
            lyr = music21.note.Lyric(text=item.text, syllabic=item.syllabic)
            note_el.lyrics.append(lyr)
            if item.extend:
                extend_ordinals.add(lyric_ordinal)
            lyric_ordinal += 1
            used_idx.add(best_i)
            search_start = best_i + 1
    return extend_ordinals


def score_data_to_musicxml(
    score: ScoreData,
    *,
    include_chords: bool = True,
    include_lyrics: bool = True,
) -> str:
    m21_score = music21.stream.Score()
    m21_score.metadata = music21.metadata.Metadata()
    clean_title = resolve_project_score_title(score.title)
    m21_score.metadata.title = clean_title
    m21_score.metadata.movementName = clean_title
    m21_score.metadata.composer = "ScribaSheet"

    key_str = score.key_signature or "C major"
    time_sig = score.time_signature or "4/4"
    ts_obj = music21.meter.TimeSignature(time_sig)
    measure_ql = float(ts_obj.barDuration.quarterLength)
    beats_per_sec = max(20.0, score.tempo_bpm) / 60.0
    req_quant = (score.analysis or {}).get("quantization") if isinstance(score.analysis, dict) else None
    timing_prov = (
        (
            (score.analysis or {}).get("timing_map")
            or (score.analysis or {}).get("timing_provenance")
            or (score.analysis or {}).get("tempo_diagnostics")
        )
        if isinstance(score.analysis, dict)
        else None
    )
    pickup_ql = float((timing_prov or {}).get("pickup_ql") or 0.0) if isinstance(timing_prov, dict) else 0.0
    grid_ql = _select_rhythmic_grid_ql(score.notes, score.tempo_bpm, quantization=req_quant)
    max_note_ql = max((n.offset_sec * beats_per_sec for n in score.notes), default=measure_ql)
    if 0.0 < pickup_ql < measure_ql - 1e-6:
        min_measures = max(1, 1 + int(np.ceil(max(0.0, max_note_ql - pickup_ql) / measure_ql)))
    else:
        min_measures = max(1, int(np.ceil(max_note_ql / measure_ql)))
    tracks = score.tracks or [ScoreTrack()]

    extend_ordinals: set[int] = set()
    for track in tracks:
        track_notes = [n for n in score.notes if n.track_index == track.index]
        if track.clef == "grand":
            treble_notes, bass_notes = _split_rh_lh_notes(track_notes)

            p_treble = music21.stream.Part()
            p_treble.partName = f"{track.name} (RH)"
            _populate_part_from_notes(
                p_treble,
                treble_notes,
                score.tempo_bpm,
                time_sig,
                key_str,
                music21.clef.TrebleClef(),
                min_measures=min_measures,
                grid_ql=grid_ql,
                pickup_ql=pickup_ql,
            )
            _attach_ottava_spanners(p_treble)
            if include_chords and (len(tracks) == 1 or track.index == 0):
                _attach_chord_symbols(p_treble, score.chords)
            m21_score.insert(0, p_treble)

            p_bass = music21.stream.Part()
            p_bass.partName = f"{track.name} (LH)"
            _populate_part_from_notes(
                p_bass,
                bass_notes,
                score.tempo_bpm,
                time_sig,
                key_str,
                music21.clef.BassClef(),
                min_measures=min_measures,
                grid_ql=grid_ql,
                pickup_ql=pickup_ql,
            )
            m21_score.insert(0, p_bass)

            staff_group = music21.layout.StaffGroup([p_treble, p_bass], symbol="brace")
            m21_score.insert(0, staff_group)
        else:
            clef_obj = music21.clef.BassClef() if track.clef == "bass" else music21.clef.TrebleClef()
            p = music21.stream.Part()
            p.partName = track.name
            _populate_part_from_notes(
                p,
                track_notes,
                score.tempo_bpm,
                time_sig,
                key_str,
                clef_obj,
                min_measures=min_measures,
                grid_ql=grid_ql,
                pickup_ql=pickup_ql,
            )
            if track.clef == "treble":
                _attach_ottava_spanners(p)
            if include_chords and (len(tracks) == 1 or track.index == 0):
                _attach_chord_symbols(p, score.chords)
            if include_lyrics and track.index == 0 and isinstance(score.analysis, dict) and score.analysis.get("lyrics"):
                extend_ordinals = _attach_lyrics_to_part(p, score.analysis["lyrics"], track_notes, score.tempo_bpm)
            m21_score.insert(0, p)

    exporter = music21.musicxml.m21ToXml.GeneralObjectExporter(m21_score)
    xml_bytes = exporter.parse()
    xml_str = xml_bytes.decode("utf-8")
    has_pickup = 0.0 < pickup_ql < measure_ql - 1e-6
    has_chords_xml = bool(include_chords and score.chords)
    if extend_ordinals or has_pickup or has_chords_xml:
        import xml.etree.ElementTree as ET

        root = ET.fromstring(xml_str)
        if has_pickup:
            for part_el in root.findall("part"):
                part_measures = part_el.findall("measure")
                for m_idx, m_el in enumerate(part_measures):
                    if m_idx == 0:
                        m_el.set("number", "0")
                        m_el.set("implicit", "yes")
                    else:
                        m_el.set("number", str(m_idx))
        if extend_ordinals:
            first_part = root.find("part")
            if first_part is not None:
                for ord_idx, lyr_el in enumerate(first_part.findall(".//note/lyric")):
                    if ord_idx in extend_ordinals and lyr_el.find("extend") is None:
                        ET.SubElement(lyr_el, "extend")
        if has_chords_xml:
            _normalize_musicxml_harmonies(root, score.chords)
        xml_str = ET.tostring(root, encoding="unicode")
    return apply_scribasheet_musicxml_branding(xml_str, title=clean_title)


def get_note_performance_timing(note: ScoreNote) -> tuple[float, float]:
    """Return expressive performance (onset_sec, offset_sec), falling back safely for legacy notes."""
    start = float(note.raw_onset_sec) if note.raw_onset_sec is not None else float(note.onset_sec)
    end = float(note.raw_offset_sec) if note.raw_offset_sec is not None else float(note.offset_sec)
    start = max(0.0, start)
    return start, max(start + 0.03, end)


def get_note_notation_timing(note: ScoreNote) -> tuple[float, float]:
    """Return quantized notation (onset_sec, offset_sec) for sheet music and grid rendering."""
    start = max(0.0, float(note.onset_sec))
    return start, max(start + 0.03, float(note.offset_sec))


def score_data_to_midi_bytes(
    score: ScoreData,
    *,
    timing_mode: Literal["performance", "notation"] = "performance",
) -> bytes:
    """Serialize ScoreData to Standard MIDI bytes.

    Uses original detected performance timing (``raw_onset_sec`` / ``raw_offset_sec``)
    by default so exported MIDI preserves expressive timing, while supporting explicit
    ``timing_mode="notation"`` when quantized grid timing is requested.
    """
    pm = pretty_midi.PrettyMIDI(initial_tempo=max(20.0, float(score.tempo_bpm)))
    tracks = score.tracks or [ScoreTrack()]
    track_map = {t.index: t for t in tracks}

    instruments: dict[int, pretty_midi.Instrument] = {}
    for t in tracks:
        inst = pretty_midi.Instrument(program=max(0, min(127, t.program)), name=t.name)
        instruments[t.index] = inst

    for n in score.notes:
        t_idx = n.track_index if n.track_index in instruments else 0
        if t_idx not in instruments:
            t_meta = track_map.get(t_idx, ScoreTrack())
            instruments[t_idx] = pretty_midi.Instrument(program=t_meta.program, name=t_meta.name)
        start_sec, end_sec = (
            get_note_notation_timing(n)
            if timing_mode == "notation"
            else get_note_performance_timing(n)
        )
        instruments[t_idx].notes.append(
            pretty_midi.Note(
                velocity=max(1, min(127, n.velocity)),
                pitch=max(0, min(127, n.pitch_midi)),
                start=start_sec,
                end=end_sec,
            )
        )

    for inst in instruments.values():
        pm.instruments.append(inst)

    buf = io.BytesIO()
    pm.write(buf)
    return buf.getvalue()


_PC_TO_DIATONIC = [0, 0, 1, 1, 2, 3, 3, 4, 4, 5, 5, 6]


def _midi_to_diatonic_step(midi_pitch: int) -> int:
    octave = (midi_pitch // 12) - 1
    return octave * 7 + _PC_TO_DIATONIC[midi_pitch % 12]


def _find_musescore_binary() -> str | None:
    env_bin = os.environ.get("MUSESCORE_BINARY")
    if env_bin and Path(env_bin).exists():
        return env_bin
    for name in ("MuseScore4", "mscore4", "mscore", "musescore"):
        found = shutil.which(name)
        if found:
            return found
    win_default = Path(r"C:\Program Files\MuseScore 4\bin\MuseScore4.exe")
    if win_default.exists():
        return str(win_default)
    return None


def count_pdf_pages(pdf_bytes: bytes) -> int:
    """Count individual PDF /Page objects (excluding the parent /Pages catalog)."""
    if not pdf_bytes or not pdf_bytes.startswith(b"%PDF-"):
        return 0
    return len(re.findall(rb"/Type\s*/Page\b(?!s)", pdf_bytes))


def _extract_title_from_musicxml(xml_str: str) -> str | None:
    """Extract non-empty movement-title or work-title from MusicXML."""
    if not xml_str:
        return None
    try:
        import xml.etree.ElementTree as ET

        root = ET.fromstring(xml_str)
        for tag in ("movement-title", "work/work-title"):
            el = root.find(tag)
            if el is not None and el.text and el.text.strip():
                return el.text.strip()
    except Exception:
        return None
    return None


def _truncate_text_to_width(text: str, font_name: str, font_size: float, max_width: float) -> str:
    """Truncate text with an ellipsis so it fits within max_width points."""
    if not text or max_width <= 0:
        return ""
    if pdfmetrics.stringWidth(text, font_name, font_size) <= max_width:
        return text
    ellipsis = "..."
    ell_w = pdfmetrics.stringWidth(ellipsis, font_name, font_size)
    if ell_w >= max_width:
        return ""
    lo, hi = 0, len(text)
    while lo < hi:
        mid = (lo + hi + 1) // 2
        cand = text[:mid].rstrip() + ellipsis
        if pdfmetrics.stringWidth(cand, font_name, font_size) <= max_width:
            lo = mid
        else:
            hi = mid - 1
    return (text[:lo].rstrip() + ellipsis) if lo > 0 else ellipsis


def add_pdf_footer(pdf_bytes: bytes, title: str | None = None) -> bytes:
    """Stamp a consistent footer (song title on left, 'Page X of Y' on right) onto every PDF page."""
    if not pdf_bytes or not pdf_bytes.startswith(b"%PDF-"):
        return pdf_bytes

    reader = PdfReader(io.BytesIO(pdf_bytes))
    meta = reader.metadata or {}
    if meta.get("/ScribaSheetFooter") == "v1":
        return pdf_bytes

    total_pages = len(reader.pages)
    if total_pages == 0:
        return pdf_bytes

    raw_title = (title or "").strip()
    display_title = resolve_project_score_title(raw_title) if raw_title else ""

    writer = PdfWriter()
    font_name = "Helvetica"
    font_size = 8.5

    for page_idx, page in enumerate(reader.pages, start=1):
        box = page.mediabox
        left_x = float(box.left)
        bottom_y = float(box.bottom)
        page_w = float(box.width)
        page_h = float(box.height)

        margin_x = max(36.0, min(48.0, page_w * 0.06))
        footer_y = bottom_y + 18.0
        page_label = f"Page {page_idx} of {total_pages}"
        right_w = pdfmetrics.stringWidth(page_label, font_name, font_size)
        max_title_w = max(40.0, page_w - (2.0 * margin_x) - right_w - 18.0)

        overlay_buf = io.BytesIO()
        ov = canvas.Canvas(overlay_buf, pagesize=(page_w, page_h))
        ov.setFont(font_name, font_size)
        ov.setFillColorRGB(0.28, 0.33, 0.41)

        if display_title:
            trimmed = _truncate_text_to_width(display_title, font_name, font_size, max_title_w)
            if trimmed:
                ov.drawString(left_x + margin_x, footer_y, trimmed)

        ov.drawRightString(left_x + page_w - margin_x, footer_y, page_label)
        ov.save()

        overlay_reader = PdfReader(io.BytesIO(overlay_buf.getvalue()))
        attached_page = writer.add_page(page)
        attached_page.merge_page(overlay_reader.pages[0])

    out_meta: dict[str, str] = {}
    for k, v in meta.items():
        if isinstance(k, str) and isinstance(v, str):
            out_meta[k] = v
    out_meta["/ScribaSheetFooter"] = "v1"
    writer.add_metadata(out_meta)

    out_buf = io.BytesIO()
    writer.write(out_buf)
    return out_buf.getvalue()


def add_pdf_arranger_credit_page1(pdf_bytes: bytes, transcribed_by: str | None) -> bytes:
    """Ensure Page 1 visibly displays 'Transcribed by: <name>' flush-left beneath the title if not already present."""
    cleaned = (transcribed_by or "").strip()
    if not cleaned or not pdf_bytes or not pdf_bytes.startswith(b"%PDF-"):
        return pdf_bytes

    reader = PdfReader(io.BytesIO(pdf_bytes))
    if not reader.pages:
        return pdf_bytes

    page1_text = reader.pages[0].extract_text() or ""
    if "transcribed by:" in page1_text.lower():
        return pdf_bytes

    writer = PdfWriter()
    meta = dict(reader.metadata or {})
    credit_label = f"Transcribed by: {cleaned}"

    for page_idx, page in enumerate(reader.pages, start=1):
        if page_idx == 1:
            box = page.mediabox
            left_x = float(box.left)
            bottom_y = float(box.bottom)
            page_w = float(box.width)
            page_h = float(box.height)
            margin_x = max(36.0, min(48.0, page_w * 0.06))
            credit_y = bottom_y + page_h - 80.0

            overlay_buf = io.BytesIO()
            ov = canvas.Canvas(overlay_buf, pagesize=(page_w, page_h))
            ov.setFont("Helvetica", 9.5)
            ov.setFillColorRGB(0.22, 0.25, 0.32)
            ov.drawString(left_x + margin_x, credit_y, credit_label)
            ov.save()

            overlay_reader = PdfReader(io.BytesIO(overlay_buf.getvalue()))
            attached = writer.add_page(page)
            attached.merge_page(overlay_reader.pages[0])
        else:
            writer.add_page(page)

    out_meta = {k: v for k, v in meta.items() if isinstance(k, str) and isinstance(v, str)}
    writer.add_metadata(out_meta)
    out_buf = io.BytesIO()
    writer.write(out_buf)
    return out_buf.getvalue()


def _render_pdf_from_musicxml_via_musescore(
    xml_str: str,
    *,
    title: str | None = None,
    transcribed_by: str | None = None,
) -> bytes | None:
    if os.environ.get("DISABLE_MUSESCORE_PDF", "").lower() in ("1", "true", "yes"):
        return None
    mscore_bin = _find_musescore_binary()
    if not mscore_bin or not xml_str:
        return None
    xml_str = apply_scribasheet_musicxml_branding(xml_str, title=title, transcribed_by=transcribed_by)
    try:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            xml_path = tmp / "score.musicxml"
            pdf_path = tmp / "score.pdf"
            xml_path.write_text(xml_str, encoding="utf-8")
            res = subprocess.run(
                [mscore_bin, "-o", str(pdf_path), str(xml_path)],
                capture_output=True,
                text=True,
                timeout=45,
                check=False,
            )
            if res.returncode == 0 and pdf_path.exists():
                pdf_bytes = pdf_path.read_bytes()
                if pdf_bytes.startswith(b"%PDF-") and len(pdf_bytes) > 500 and count_pdf_pages(pdf_bytes) >= 1:
                    resolved_title = title if (title and title.strip()) else _extract_title_from_musicxml(xml_str)
                    with_footer = add_pdf_footer(pdf_bytes, title=resolved_title)
                    return add_pdf_arranger_credit_page1(with_footer, transcribed_by)
    except Exception:
        return None
    return None


def _render_pdf_via_musescore(
    score: ScoreData,
    *,
    include_chords: bool = True,
    transcribed_by: str | None = None,
) -> bytes | None:
    if os.environ.get("DISABLE_MUSESCORE_PDF", "").lower() in ("1", "true", "yes"):
        return None
    if not _find_musescore_binary():
        return None
    try:
        xml_str = score_data_to_musicxml(score, include_chords=include_chords)
        return _render_pdf_from_musicxml_via_musescore(
            xml_str,
            title=score.title,
            transcribed_by=transcribed_by,
        )
    except Exception:
        return None


def render_score_pdf(
    score: ScoreData,
    *,
    include_chords: bool = True,
    transcribed_by: str | None = None,
) -> bytes:
    """Render a clean, printable multi-page PDF sheet music document.

    Uses MuseScore CLI engraving from MusicXML when available locally,
    falling back to the ReportLab grand-staff renderer in headless environments.
    """
    musescore_pdf = _render_pdf_via_musescore(
        score,
        include_chords=include_chords,
        transcribed_by=transcribed_by,
    )
    if musescore_pdf is not None:
        return musescore_pdf

    cleaned_arranger = (transcribed_by or "").strip()

    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=letter)
    width, height = letter

    left_margin = 48.0
    right_margin = width - 48.0
    clef_gutter = 26.0
    note_area_left = left_margin + clef_gutter
    usable_w = right_margin - note_area_left - 8.0

    line_gap = 6.0  # 24pt staff height (5 lines)
    step_pt = line_gap / 2.0  # 3.0pt per diatonic step
    staff_height = 4 * line_gap

    aligned_note_lyrics: dict[str, object] = {}
    if isinstance(score.analysis, dict) and score.analysis.get("lyrics"):
        try:
            from app.notation.lyrics_alignment import align_lyrics_to_notes
            from app.schemas.lyrics import LyricsData

            vocal_notes = [n for n in score.notes if n.track_index == 0]
            lyrics_obj = LyricsData(**score.analysis["lyrics"])
            aligned_note_lyrics = align_lyrics_to_notes(lyrics_obj, vocal_notes).note_lyrics
        except Exception:
            aligned_note_lyrics = {}

    bass_offset = 66.0 if aligned_note_lyrics else 54.0  # room for lyrics beneath treble staff

    # Treble bottom line = E4 (midi 64, diatonic step 30); Bass bottom line = G2 (midi 43, diatonic step 18)
    treble_e4_step = _midi_to_diatonic_step(64)
    bass_g2_step = _midi_to_diatonic_step(43)

    is_grand = any(t.clef == "grand" for t in (score.tracks or [])) or any(
        n.pitch_midi < 57 for n in score.notes
    )

    def draw_header(page_num: int) -> float:
        display_header_title = resolve_project_score_title(score.title)
        if page_num == 1:
            c.setFont("Helvetica-Bold", 17)
            c.drawCentredString(width / 2, height - 46, display_header_title)
        else:
            c.setFont("Helvetica-Bold", 12)
            c.drawCentredString(width / 2, height - 46, display_header_title)
        c.setFont("Helvetica", 9.5)
        meta = (
            f"Tempo: {score.tempo_bpm:.0f} BPM  |  Time: {score.time_signature}  |  "
            f"Key: {score.key_signature}  |  Notes: {len(score.notes)}"
        )
        c.drawCentredString(width / 2, height - 64, meta)
        if page_num == 1 and cleaned_arranger:
            c.setFont("Helvetica", 9.5)
            c.drawString(left_margin, height - 80, f"Transcribed by: {cleaned_arranger}")
            return height - 116
        return height - 108

    def draw_staff_system(y_treble_top: float, measures_in_sys: int) -> None:
        c.setLineWidth(0.6)
        # Treble 5 lines
        for i in range(5):
            y = y_treble_top - i * line_gap
            c.line(left_margin, y, right_margin, y)
        c.setFont("Helvetica-Bold", 9)
        c.drawString(left_margin + 5, y_treble_top - 17, "G")

        y_bottom_bar = y_treble_top - staff_height
        if is_grand:
            y_bass_top = y_treble_top - bass_offset
            for i in range(5):
                y = y_bass_top - i * line_gap
                c.line(left_margin, y, right_margin, y)
            c.setFont("Helvetica-Bold", 9)
            c.drawString(left_margin + 5, y_bass_top - 15, "F")
            y_bottom_bar = y_bass_top - staff_height
            # Grand-staff left brace bar
            c.setLineWidth(1.4)
            c.line(left_margin - 4, y_treble_top, left_margin - 4, y_bottom_bar)
            c.setLineWidth(0.6)

        # System barlines (aligned across treble & bass)
        c.line(left_margin, y_treble_top, left_margin, y_bottom_bar)
        c.line(right_margin, y_treble_top, right_margin, y_bottom_bar)
        for m in range(1, measures_in_sys):
            bx = note_area_left + (usable_w * (m / float(measures_in_sys)))
            c.line(bx, y_treble_top, bx, y_bottom_bar)

    page_num = 1
    y_cursor = draw_header(page_num)

    sec_per_beat = 60.0 / max(20.0, score.tempo_bpm)
    try:
        beats_per_measure = max(1, int(score.time_signature.split("/")[0]))
    except Exception:
        beats_per_measure = 4
    sec_per_measure = sec_per_beat * beats_per_measure
    total_measures = max(
        4,
        int(np.ceil((max((n.offset_sec for n in score.notes), default=4.0)) / sec_per_measure)),
    )

    measures_per_sys = 4
    system_advance = (126.0 if aligned_note_lyrics else 114.0) if is_grand else (90.0 if aligned_note_lyrics else 78.0)
    min_y_cursor = 125.0 if is_grand else 95.0

    treble_notes, bass_notes = _split_rh_lh_notes(score.notes) if is_grand else (score.notes, [])
    treble_ids = {n.id for n in treble_notes}

    for sys_start_m in range(0, total_measures, measures_per_sys):
        if y_cursor < min_y_cursor:
            c.showPage()
            page_num += 1
            y_cursor = draw_header(page_num)

        draw_staff_system(y_cursor, measures_per_sys)
        # Measure number placed cleanly in top-left gutter above chord lane
        c.setFont("Helvetica", 7)
        c.drawString(left_margin, y_cursor + 24, f"m. {sys_start_m + 1}")

        sys_start_sec = sys_start_m * sec_per_measure
        sys_dur_sec = measures_per_sys * sec_per_measure
        sys_end_sec = sys_start_sec + sys_dur_sec

        # Draw chords in dedicated lane above treble staff (no collision with measure numbers)
        if include_chords:
            last_chord_x = -100.0
            for ch in score.chords:
                if sys_start_sec <= ch.onset_sec < sys_end_sec:
                    x = note_area_left + ((ch.onset_sec - sys_start_sec) / sys_dur_sec) * usable_w
                    if x - last_chord_x < 24.0:
                        x = last_chord_x + 24.0
                    c.setFont("Helvetica-Bold", 8.5)
                    c.drawString(x, y_cursor + 12, ch.symbol)
                    last_chord_x = x

        y_treble_bottom = y_cursor - staff_height
        y_bass_bottom = (y_cursor - bass_offset) - staff_height

        for n in score.notes:
            if not (sys_start_sec <= n.onset_sec < sys_end_sec):
                continue
            x = note_area_left + ((n.onset_sec - sys_start_sec) / sys_dur_sec) * usable_w
            use_treble = (not is_grand) or (n.id in treble_ids)
            if use_treble:
                steps_above = _midi_to_diatonic_step(n.pitch_midi) - treble_e4_step
                ny = y_treble_bottom + steps_above * step_pt
                staff_bot = y_treble_bottom
                staff_top = y_cursor
            else:
                steps_above = _midi_to_diatonic_step(n.pitch_midi) - bass_g2_step
                ny = y_bass_bottom + steps_above * step_pt
                staff_bot = y_bass_bottom
                staff_top = y_cursor - bass_offset

            # Draw ledger lines when outside 5-line staff
            c.setLineWidth(0.5)
            if ny > staff_top + 1.0:
                ly = staff_top + line_gap
                while ly <= ny + 1.0:
                    c.line(x - 4.5, ly, x + 4.5, ly)
                    ly += line_gap
            elif ny < staff_bot - 1.0:
                ly = staff_bot - line_gap
                while ly >= ny - 1.0:
                    c.line(x - 4.5, ly, x + 4.5, ly)
                    ly -= line_gap

            c.circle(x, ny, 2.4, stroke=1, fill=1)
            if steps_above >= 4:
                c.line(x - 2.4, ny, x - 2.4, ny - 13)
            else:
                c.line(x + 2.4, ny, x + 2.4, ny + 13)

            if n.id in aligned_note_lyrics:
                lyr_item = aligned_note_lyrics[n.id]
                syl_label = lyr_item.text + ("-" if lyr_item.syllabic in ("begin", "middle") else "")
                if lyr_item.extend:
                    syl_label += "_"
                c.setFont("Helvetica", 7.5)
                c.drawCentredString(x, y_treble_bottom - 14, syl_label)

        y_cursor -= system_advance

    c.save()
    return add_pdf_footer(buf.getvalue(), title=score.title)


def render_score_wav(score: ScoreData, sample_rate: int = 22050) -> bytes:
    """Synthesize polyphonic audio from the score's notes using GM SoundFont (Acoustic Grand Piano) or harmonic fallback."""
    from app.notation.satb_audio import _render_pm_via_soundfont

    total_dur = max(
        1.0,
        max((n.offset_sec for n in score.notes), default=1.0) + 0.5,
    )
    num_samples = int(total_dur * sample_rate)

    if score.notes:
        pm = pretty_midi.PrettyMIDI(initial_tempo=max(20.0, float(score.tempo_bpm or 120.0)))
        tracks = score.tracks or [ScoreTrack()]
        track_progs = {t.index: max(0, min(127, t.program)) for t in tracks}
        by_prog: dict[int, pretty_midi.Instrument] = {}
        for n in score.notes:
            prog = track_progs.get(n.track_index, 0)
            if prog not in by_prog:
                by_prog[prog] = pretty_midi.Instrument(program=prog)
            by_prog[prog].notes.append(
                pretty_midi.Note(
                    velocity=max(1, min(127, n.velocity)),
                    pitch=max(0, min(127, n.pitch_midi)),
                    start=max(0.0, float(n.onset_sec)),
                    end=max(float(n.onset_sec) + 0.04, float(n.offset_sec)),
                )
            )
        for inst in by_prog.values():
            pm.instruments.append(inst)

        sf_audio = _render_pm_via_soundfont(pm, sample_rate)
        if sf_audio is not None and sf_audio.size > 0:
            mix = np.zeros(num_samples, dtype=np.float32)
            copy_len = min(num_samples, len(sf_audio))
            mix[:copy_len] = sf_audio[:copy_len]
            peak = float(np.max(np.abs(mix))) if len(mix) > 0 else 0.0
            if peak > 0.95:
                mix = (mix / peak) * 0.95
            buf = io.BytesIO()
            sf.write(buf, mix, sample_rate, format="WAV", subtype="PCM_16")
            return buf.getvalue()

    mix = np.zeros(num_samples, dtype=np.float32)

    for n in score.notes:
        start_idx = max(0, int(n.onset_sec * sample_rate))
        note_off_idx = min(num_samples, int(n.offset_sec * sample_rate))
        hold_len = note_off_idx - start_idx
        if hold_len <= 10:
            continue
        release_samples = int(0.15 * sample_rate)
        end_idx = min(num_samples, note_off_idx + release_samples)
        length = end_idx - start_idx
        t = np.arange(length, dtype=np.float32) / sample_rate
        freq = 440.0 * (2.0 ** ((n.pitch_midi - 69) / 12.0))
        # Warm piano-like harmonic synthesis with attack, gentle string decay, and damper release
        wave = (
            0.65 * np.sin(2.0 * np.pi * freq * t)
            + 0.25 * np.sin(2.0 * np.pi * 2.0 * freq * t)
            + 0.10 * np.sin(2.0 * np.pi * 3.0 * freq * t)
        )
        attack = min(int(0.008 * sample_rate), hold_len // 3)
        env = np.exp(-t * 0.45).astype(np.float32)
        if attack > 0:
            env[:attack] *= np.linspace(0.0, 1.0, attack, dtype=np.float32)
        tail_len = end_idx - note_off_idx
        if tail_len > 0:
            env[hold_len:] *= np.linspace(1.0, 0.0, tail_len, dtype=np.float32)
        amp = (max(1, n.velocity) / 127.0) * 0.24
        mix[start_idx:end_idx] += wave * env * amp

    peak = float(np.max(np.abs(mix))) if len(mix) > 0 else 0.0
    if peak > 0.95:
        mix = (mix / peak) * 0.95

    buf = io.BytesIO()
    sf.write(buf, mix, sample_rate, format="WAV", subtype="PCM_16")
    return buf.getvalue()
