"""Structural OMR validation, Gemini Vision verification, and safe MusicXML correction."""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import math
import re
import tempfile
import uuid
import xml.etree.ElementTree as ET
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

import httpx
from PIL import Image
from pydantic import BaseModel, Field, ValidationError

from app.core.config import Settings, get_settings

logger = logging.getLogger(__name__)

VALID_STEPS = frozenset({"A", "B", "C", "D", "E", "F", "G"})
VALID_CLEFS = frozenset({"G", "F", "C", "percussion", "TAB", "jianpu", "none"})
ALTER_TO_ACCIDENTAL = {
    -2: "flat-flat",
    -1: "flat",
    0: "natural",
    1: "sharp",
    2: "double-sharp",
}
SCORING_FORMULA_NOTE = (
    "Preliminary OMR Match = min(92, round(0.65 * RhythmValidity + 0.35 * StructuralConsistency)) "
    "until AI Vision verification succeeds. Verified OMR Match = round(0.40 * StructuralScore + "
    "0.60 * AiVisionConfidence), reduced by unresolved high/medium visual discrepancy penalties."
)


class OmrProposedFix(BaseModel):
    action: Literal["set_accidental", "set_pitch", "add_tie", "add_fingering", "add_pedal"]
    part_id: str | None = None
    measure: int = Field(ge=0, le=9999)
    staff: int | None = Field(default=None, ge=1, le=16)
    voice: str | None = None
    note_index: int | None = Field(default=None, ge=0, le=500)
    step: str | None = None
    alter: int | None = Field(default=None, ge=-2, le=2)
    octave: int | None = Field(default=None, ge=0, le=9)
    fingering: str | None = None
    pedal_type: Literal["start", "stop"] | None = None


class OmrFinding(BaseModel):
    id: str
    source: Literal["structural", "ai_vision"]
    page: int | None = None
    measure: int = Field(ge=0)
    part_id: str | None = None
    staff: int | None = None
    voice: str | None = None
    category: str
    severity: Literal["high", "medium", "low"] = "medium"
    description: str
    confidence: float | None = Field(default=None, ge=0.0, le=100.0)
    proposed_fix: OmrProposedFix | None = None


class OmrVerificationReport(BaseModel):
    omr_match_score: int = Field(ge=0, le=100)
    score_status: Literal["preliminary", "verified", "ai_unavailable", "ai_failed"]
    structural_score: float = Field(ge=0.0, le=100.0)
    rhythm_validity_score: float = Field(ge=0.0, le=100.0)
    structural_consistency_score: float = Field(ge=0.0, le=100.0)
    ai_verified: bool = False
    ai_confidence: float | None = Field(default=None, ge=0.0, le=100.0)
    source_available: bool = False
    source_message: str | None = None
    formula_note: str = SCORING_FORMULA_NOTE
    total_measures: int = 0
    valid_rhythm_measures: int = 0
    flagged_measures: list[int] = Field(default_factory=list)
    findings: list[OmrFinding] = Field(default_factory=list)
    content_hash: str = ""
    verified_at: str | None = None
    model_used: str | None = None
    ai_error: str | None = None
    applied_finding_ids: list[str] = Field(default_factory=list)
    can_revert: bool = False


def compute_musicxml_hash(musicxml: str) -> str:
    return hashlib.sha256((musicxml or "").encode("utf-8", errors="ignore")).hexdigest()[:24]


def _parse_int_text(el: ET.Element | None, default: int | None = None) -> int | None:
    if el is None or not el.text:
        return default
    try:
        return int(float(el.text.strip()))
    except (ValueError, TypeError):
        return default


def _parse_measure_number(raw: str | None, fallback_idx: int) -> int:
    if not raw:
        return fallback_idx + 1
    m = re.match(r"^(-?\d+)", raw.strip())
    if m:
        return int(m.group(1))
    return fallback_idx + 1


def evaluate_omr_structure(
    musicxml: str,
    *,
    source_available: bool = False,
    source_message: str | None = None,
    can_revert: bool = False,
    applied_finding_ids: list[str] | None = None,
) -> OmrVerificationReport:
    """Validate measure rhythms, pickup/final bars, tuplets, ties, clefs, keys, and part consistency."""
    content_hash = compute_musicxml_hash(musicxml)
    if not musicxml or not musicxml.strip():
        return OmrVerificationReport(
            omr_match_score=0,
            score_status="preliminary",
            structural_score=0.0,
            rhythm_validity_score=0.0,
            structural_consistency_score=0.0,
            ai_verified=False,
            ai_confidence=None,
            source_available=source_available,
            source_message=source_message,
            total_measures=0,
            valid_rhythm_measures=0,
            flagged_measures=[],
            findings=[
                OmrFinding(
                    id="struct-empty",
                    source="structural",
                    measure=1,
                    category="missing_notation",
                    severity="high",
                    description="Score contains no MusicXML content.",
                )
            ],
            content_hash=content_hash,
            can_revert=can_revert,
            applied_finding_ids=list(applied_finding_ids or []),
        )

    try:
        root = ET.fromstring(musicxml)
    except ET.ParseError as exc:
        return OmrVerificationReport(
            omr_match_score=0,
            score_status="preliminary",
            structural_score=0.0,
            rhythm_validity_score=0.0,
            structural_consistency_score=0.0,
            ai_verified=False,
            ai_confidence=None,
            source_available=source_available,
            source_message=source_message,
            total_measures=0,
            valid_rhythm_measures=0,
            flagged_measures=[1],
            findings=[
                OmrFinding(
                    id="struct-xml-error",
                    source="structural",
                    measure=1,
                    category="malformed_xml",
                    severity="high",
                    description=f"Malformed MusicXML structure: {exc}",
                )
            ],
            content_hash=content_hash,
            can_revert=can_revert,
            applied_finding_ids=list(applied_finding_ids or []),
        )

    part_list_ids = [
        sp.get("id")
        for sp in root.findall("./part-list/score-part")
        if sp.get("id")
    ]
    parts = root.findall("./part")
    findings: list[OmrFinding] = []
    consistency_penalties = 0.0

    if not parts:
        return OmrVerificationReport(
            omr_match_score=0,
            score_status="preliminary",
            structural_score=0.0,
            rhythm_validity_score=0.0,
            structural_consistency_score=0.0,
            ai_verified=False,
            ai_confidence=None,
            source_available=source_available,
            source_message=source_message,
            total_measures=0,
            valid_rhythm_measures=0,
            flagged_measures=[1],
            findings=[
                OmrFinding(
                    id="struct-no-parts",
                    source="structural",
                    measure=1,
                    category="missing_parts",
                    severity="high",
                    description="MusicXML does not define any <part> elements.",
                )
            ],
            content_hash=content_hash,
            can_revert=can_revert,
            applied_finding_ids=list(applied_finding_ids or []),
        )

    part_ids = [p.get("id") for p in parts]
    if part_list_ids and set(part_list_ids) != {pid for pid in part_ids if pid}:
        consistency_penalties += 8.0
        findings.append(
            OmrFinding(
                id="struct-part-list-mismatch",
                source="structural",
                measure=1,
                category="structural_mismatch",
                severity="medium",
                description="Score <part-list> identifiers do not match all <part> blocks.",
            )
        )

    part_measure_counts: list[int] = []
    total_measure_checks = 0
    valid_measure_checks = 0
    pitched_note_count = 0
    flagged_set: set[int] = set()

    for part_idx, part_el in enumerate(parts):
        part_id = part_el.get("id") or f"P{part_idx + 1}"
        measures = part_el.findall("./measure")
        part_measure_counts.append(len(measures))
        if not measures:
            consistency_penalties += 15.0
            findings.append(
                OmrFinding(
                    id=f"struct-empty-part-{part_id}",
                    source="structural",
                    part_id=part_id,
                    measure=1,
                    category="missing_measures",
                    severity="high",
                    description=f"Part {part_id} contains zero measures.",
                )
            )
            continue

        divisions = 1
        beats = 4
        beat_type = 4
        has_clef = False

        for m_idx, measure_el in enumerate(measures):
            m_num = _parse_measure_number(measure_el.get("number"), m_idx)
            is_implicit_pickup = (measure_el.get("implicit") or "").strip().lower() == "yes" or m_num == 0

            # Parse attributes (respecting legitimate mid-score key/time/clef changes)
            for attr_el in measure_el.findall("./attributes"):
                div_val = _parse_int_text(attr_el.find("divisions"))
                if div_val is not None:
                    if div_val <= 0:
                        consistency_penalties += 6.0
                        flagged_set.add(m_num)
                        findings.append(
                            OmrFinding(
                                id=f"struct-div-{part_id}-m{m_num}",
                                source="structural",
                                part_id=part_id,
                                measure=m_num,
                                category="invalid_attributes",
                                severity="high",
                                description=f"Measure {m_num} ({part_id}) defines non-positive divisions ({div_val}).",
                            )
                        )
                    else:
                        divisions = div_val

                key_el = attr_el.find("key")
                if key_el is not None:
                    fifths_val = _parse_int_text(key_el.find("fifths"))
                    if fifths_val is not None and (fifths_val < -7 or fifths_val > 7):
                        consistency_penalties += 4.0
                        flagged_set.add(m_num)
                        findings.append(
                            OmrFinding(
                                id=f"struct-key-{part_id}-m{m_num}",
                                source="structural",
                                part_id=part_id,
                                measure=m_num,
                                category="invalid_key_signature",
                                severity="medium",
                                description=f"Measure {m_num} ({part_id}) has out-of-range key fifths ({fifths_val}).",
                            )
                        )

                time_el = attr_el.find("time")
                if time_el is not None:
                    b_val = _parse_int_text(time_el.find("beats"))
                    bt_val = _parse_int_text(time_el.find("beat-type"))
                    if b_val is None or bt_val is None or b_val <= 0 or bt_val not in (1, 2, 4, 8, 16, 32):
                        consistency_penalties += 6.0
                        flagged_set.add(m_num)
                        findings.append(
                            OmrFinding(
                                id=f"struct-time-{part_id}-m{m_num}",
                                source="structural",
                                part_id=part_id,
                                measure=m_num,
                                category="invalid_time_signature",
                                severity="high",
                                description=f"Measure {m_num} ({part_id}) defines an invalid time signature.",
                            )
                        )
                    else:
                        beats = b_val
                        beat_type = bt_val

                for clef_el in attr_el.findall("clef"):
                    sign = (clef_el.findtext("sign") or "").strip()
                    if sign and sign in VALID_CLEFS:
                        has_clef = True
                    elif sign:
                        consistency_penalties += 4.0
                        flagged_set.add(m_num)
                        findings.append(
                            OmrFinding(
                                id=f"struct-clef-{part_id}-m{m_num}",
                                source="structural",
                                part_id=part_id,
                                measure=m_num,
                                category="invalid_clef",
                                severity="medium",
                                description=f"Measure {m_num} ({part_id}) uses unrecognized clef sign '{sign}'.",
                            )
                        )

            expected_ticks = float(divisions) * float(beats) * (4.0 / float(max(1, beat_type)))
            tol = max(1.0, float(divisions) * 0.025)

            pos = 0
            last_nonchord_start = 0
            max_span = 0
            note_elements = 0

            for child in measure_el:
                tag = child.tag.split("}")[-1]
                if tag == "note":
                    note_elements += 1
                    is_grace = child.find("grace") is not None
                    is_chord = child.find("chord") is not None
                    is_rest = child.find("rest") is not None

                    pitch_el = child.find("pitch")
                    if pitch_el is not None:
                        pitched_note_count += 1
                        step_txt = (pitch_el.findtext("step") or "").strip().upper()
                        oct_val = _parse_int_text(pitch_el.find("octave"))
                        if step_txt not in VALID_STEPS or oct_val is None or oct_val < 0 or oct_val > 9:
                            consistency_penalties += 3.0
                            flagged_set.add(m_num)
                            findings.append(
                                OmrFinding(
                                    id=f"struct-pitch-{part_id}-m{m_num}-{note_elements}",
                                    source="structural",
                                    part_id=part_id,
                                    measure=m_num,
                                    category="malformed_pitch",
                                    severity="medium",
                                    description=f"Measure {m_num} ({part_id}) has an invalid pitch ({step_txt}{oct_val}).",
                                )
                            )
                    elif not is_rest and child.find("unpitched") is None:
                        consistency_penalties += 2.0

                    if not is_grace:
                        dur_val = _parse_int_text(child.find("duration"))
                        if dur_val is None or dur_val <= 0:
                            consistency_penalties += 4.0
                            flagged_set.add(m_num)
                            findings.append(
                                OmrFinding(
                                    id=f"struct-dur-{part_id}-m{m_num}-{note_elements}",
                                    source="structural",
                                    part_id=part_id,
                                    measure=m_num,
                                    category="missing_duration",
                                    severity="high",
                                    description=f"Measure {m_num} ({part_id}) contains a note/rest missing a positive <duration>.",
                                )
                            )
                        else:
                            if is_chord:
                                max_span = max(max_span, last_nonchord_start + dur_val)
                            else:
                                last_nonchord_start = pos
                                pos += dur_val
                                max_span = max(max_span, pos)
                elif tag == "backup":
                    dur_val = _parse_int_text(child.find("duration"), 0) or 0
                    pos = max(0, pos - max(0, dur_val))
                elif tag == "forward":
                    dur_val = _parse_int_text(child.find("duration"), 0) or 0
                    pos += max(0, dur_val)
                    max_span = max(max_span, pos)

            total_measure_checks += 1
            if note_elements == 0:
                flagged_set.add(m_num)
                findings.append(
                    OmrFinding(
                        id=f"struct-empty-m{m_num}-{part_id}",
                        source="structural",
                        part_id=part_id,
                        measure=m_num,
                        category="empty_measure",
                        severity="medium",
                        description=f"Measure {m_num} ({part_id}) contains no notes or rests.",
                    )
                )
                continue

            is_first_pickup_allowed = m_idx == 0 and (is_implicit_pickup or (0 < max_span <= expected_ticks + tol))
            is_final_incomplete_allowed = (m_idx == len(measures) - 1) and (0 < max_span <= expected_ticks + tol)

            if max_span > expected_ticks + tol:
                flagged_set.add(m_num)
                findings.append(
                    OmrFinding(
                        id=f"struct-overflow-m{m_num}-{part_id}",
                        source="structural",
                        part_id=part_id,
                        measure=m_num,
                        category="rhythm_overflow",
                        severity="high",
                        description=(
                            f"Measure {m_num} ({part_id}) exceeds {beats}/{beat_type} capacity "
                            f"({max_span / max(1, divisions):.2f} vs {beats * (4.0 / max(1, beat_type)):.2f} quarter beats)."
                        ),
                    )
                )
            elif max_span < expected_ticks - tol and not (is_first_pickup_allowed or is_final_incomplete_allowed):
                flagged_set.add(m_num)
                findings.append(
                    OmrFinding(
                        id=f"struct-underflow-m{m_num}-{part_id}",
                        source="structural",
                        part_id=part_id,
                        measure=m_num,
                        category="rhythm_underflow",
                        severity="medium",
                        description=(
                            f"Measure {m_num} ({part_id}) is incomplete for {beats}/{beat_type} "
                            f"({max_span / max(1, divisions):.2f} vs {beats * (4.0 / max(1, beat_type)):.2f} quarter beats)."
                        ),
                    )
                )
            else:
                valid_measure_checks += 1

        if not has_clef:
            consistency_penalties += 8.0
            findings.append(
                OmrFinding(
                    id=f"struct-missing-clef-{part_id}",
                    source="structural",
                    part_id=part_id,
                    measure=1,
                    category="missing_clef",
                    severity="medium",
                    description=f"Part {part_id} does not declare a clef.",
                )
            )

    if len(set(part_measure_counts)) > 1:
        consistency_penalties += 14.0
        findings.append(
            OmrFinding(
                id="struct-part-measure-count-mismatch",
                source="structural",
                measure=1,
                category="measure_count_mismatch",
                severity="high",
                description=f"Parts have inconsistent measure counts: {part_measure_counts}.",
            )
        )

    if pitched_note_count == 0:
        consistency_penalties += 35.0
        findings.append(
            OmrFinding(
                id="struct-no-pitched-notes",
                source="structural",
                measure=1,
                category="missing_pitches",
                severity="high",
                description="Extracted MusicXML contains zero pitched notes.",
            )
        )

    total_measures_display = max(part_measure_counts) if part_measure_counts else 0
    rhythm_validity_score = (
        round(100.0 * (float(valid_measure_checks) / float(total_measure_checks)), 1)
        if total_measure_checks > 0
        else 0.0
    )
    structural_consistency_score = round(max(0.0, min(100.0, 100.0 - consistency_penalties)), 1)
    structural_score = round(0.65 * rhythm_validity_score + 0.35 * structural_consistency_score, 1)

    # Safeguard: never report 100% OMR Match solely from structural MusicXML validity.
    preliminary_match = min(92, max(0, int(round(structural_score))))

    return OmrVerificationReport(
        omr_match_score=preliminary_match,
        score_status="preliminary",
        structural_score=structural_score,
        rhythm_validity_score=rhythm_validity_score,
        structural_consistency_score=structural_consistency_score,
        ai_verified=False,
        ai_confidence=None,
        source_available=source_available,
        source_message=source_message,
        total_measures=total_measures_display,
        valid_rhythm_measures=sum(
            1
            for m_idx in range(total_measures_display)
            if _parse_measure_number(parts[0].findall("./measure")[m_idx].get("number"), m_idx) not in flagged_set
        )
        if parts and len(parts[0].findall("./measure")) == total_measures_display
        else min(total_measures_display, valid_measure_checks),
        flagged_measures=sorted(flagged_set),
        findings=findings,
        content_hash=content_hash,
        applied_finding_ids=list(applied_finding_ids or []),
        can_revert=can_revert,
    )


def _format_pitch_label(pitch_el: ET.Element) -> str:
    step = (pitch_el.findtext("step") or "?").strip()
    alter = _parse_int_text(pitch_el.find("alter"), 0) or 0
    octave = (pitch_el.findtext("octave") or "").strip()
    acc = "#" if alter == 1 else ("x" if alter == 2 else ("b" if alter == -1 else ("bb" if alter == -2 else "")))
    return f"{step}{acc}{octave}"


def _build_page_measure_summaries(musicxml: str, page_count: int) -> list[tuple[int, int, int, str]]:
    """Build concise per-page MusicXML measure summaries matched in page order."""
    try:
        root = ET.fromstring(musicxml)
    except ET.ParseError:
        return [(1, 1, 1, "Unparseable MusicXML")]

    parts = root.findall("./part")
    if not parts:
        return [(1, 1, 1, "No parts present")]

    first_measures = parts[0].findall("./measure")
    total_measures = len(first_measures)
    if total_measures == 0:
        return [(1, 1, 1, "No measures present")]

    # Detect explicit new-page markers if present on first part
    page_breaks: list[int] = [0]
    for idx, m_el in enumerate(first_measures):
        if idx == 0:
            continue
        pr = m_el.find("./print")
        if pr is not None and (pr.get("new-page") or "").lower() == "yes":
            page_breaks.append(idx)

    ranges: list[tuple[int, int]] = []
    safe_pages = max(1, page_count)
    if len(page_breaks) == safe_pages:
        for i, start_idx in enumerate(page_breaks):
            end_idx = page_breaks[i + 1] if i + 1 < len(page_breaks) else total_measures
            ranges.append((start_idx, end_idx))
    else:
        step = max(1, math.ceil(total_measures / safe_pages))
        for p_idx in range(safe_pages):
            s_idx = min(total_measures, p_idx * step)
            e_idx = total_measures if p_idx == safe_pages - 1 else min(total_measures, (p_idx + 1) * step)
            if s_idx < e_idx:
                ranges.append((s_idx, e_idx))

    summaries: list[tuple[int, int, int, str]] = []
    for p_num, (start_idx, end_idx) in enumerate(ranges, start=1):
        lines: list[str] = []
        first_m_num = _parse_measure_number(first_measures[start_idx].get("number"), start_idx)
        last_m_num = _parse_measure_number(first_measures[end_idx - 1].get("number"), end_idx - 1)
        for m_idx in range(start_idx, end_idx):
            part_chunks: list[str] = []
            m_label_num = _parse_measure_number(first_measures[m_idx].get("number"), m_idx)
            for p_el in parts:
                pid = p_el.get("id") or "P1"
                p_measures = p_el.findall("./measure")
                if m_idx >= len(p_measures):
                    continue
                m_el = p_measures[m_idx]
                note_tokens: list[str] = []
                n_counter = 0
                for n_el in m_el.findall("./note"):
                    staff_txt = n_el.findtext("staff") or "1"
                    voice_txt = n_el.findtext("voice") or "1"
                    typ_txt = (n_el.findtext("type") or "?").strip()[:2]
                    dot_txt = "." if n_el.find("dot") is not None else ""
                    chord_txt = "+" if n_el.find("chord") is not None else ""
                    ties = [t.get("type") for t in n_el.findall("tie") if t.get("type")]
                    tie_txt = f"~{'/'.join(ties)}" if ties else ""
                    tuplet_txt = "(tup)" if n_el.find("time-modification") is not None else ""
                    fing = n_el.findtext("./notations/technical/fingering")
                    fing_txt = f"[f{fing.strip()}]" if fing else ""
                    if n_el.find("rest") is not None:
                        note_tokens.append(f"#{n_counter}[s{staff_txt}v{voice_txt}]:R({typ_txt}{dot_txt})")
                    else:
                        p_node = n_el.find("pitch")
                        lbl = _format_pitch_label(p_node) if p_node is not None else "?"
                        note_tokens.append(
                            f"#{n_counter}[s{staff_txt}v{voice_txt}]:{chord_txt}{lbl}({typ_txt}{dot_txt}{tuplet_txt}){tie_txt}{fing_txt}"
                        )
                    n_counter += 1
                part_chunks.append(f"{pid}:{' '.join(note_tokens) if note_tokens else 'empty'}")
            lines.append(f"m.{m_label_num}: " + " | ".join(part_chunks))
        summaries.append((p_num, first_m_num, last_m_num, "\n".join(lines)))

    return summaries


def _prepare_source_page_images(
    source_files: list[tuple[Path, str]],
    work_dir: Path,
) -> list[tuple[int, Path]]:
    """Render PDFs / normalize source images into ordered PNG page files inside ``work_dir``."""
    from app.notation.omr import render_pdf_pages_to_images

    ordered_pages: list[tuple[int, Path]] = []
    page_cursor = 1
    for src_path, mime_hint in source_files:
        if not src_path.exists():
            continue
        raw = src_path.read_bytes()
        is_pdf = (
            "pdf" in (mime_hint or "").lower()
            or src_path.suffix.lower() == ".pdf"
            or raw.lstrip().startswith(b"%PDF-")
        )
        if is_pdf:
            pdf_dir = work_dir / f"pdf_pages_{page_cursor}"
            rendered = render_pdf_pages_to_images(src_path, pdf_dir, dpi=150)
            for p_img in rendered:
                ordered_pages.append((page_cursor, p_img))
                page_cursor += 1
        else:
            out_img = work_dir / f"page_{page_cursor:03d}.png"
            with Image.open(src_path) as im:
                rgb = im.convert("RGB")
                max_side = 1800
                if max(rgb.size) > max_side:
                    scale = max_side / float(max(rgb.size))
                    rgb = rgb.resize(
                        (max(1, int(round(rgb.width * scale))), max(1, int(round(rgb.height * scale)))),
                        Image.Resampling.LANCZOS,
                    )
                rgb.save(out_img, format="PNG", optimize=True)
            ordered_pages.append((page_cursor, out_img))
            page_cursor += 1
    return ordered_pages


def _extract_gemini_json_payload(response_data: dict[str, Any]) -> dict[str, Any]:
    candidates = response_data.get("candidates")
    if not isinstance(candidates, list) or not candidates:
        raise ValueError("Gemini returned no candidates.")
    parts = ((candidates[0] or {}).get("content") or {}).get("parts")
    if not isinstance(parts, list) or not parts:
        raise ValueError("Gemini candidate contained no content parts.")
    text_chunks = [str(p.get("text")) for p in parts if isinstance(p, dict) and p.get("text")]
    raw_text = "\n".join(text_chunks).strip()
    if raw_text.startswith("```"):
        raw_text = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw_text, flags=re.IGNORECASE).strip()
    parsed = json.loads(raw_text)
    if not isinstance(parsed, dict):
        raise ValueError("Gemini JSON root must be an object.")
    return parsed


def verify_omr_with_gemini_vision(
    musicxml: str,
    *,
    source_files: list[tuple[Path, str]],
    settings: Settings | None = None,
    can_revert: bool = False,
    applied_finding_ids: list[str] | None = None,
    http_client_factory: Any = None,
) -> OmrVerificationReport:
    """Run structural validation + Gemini Vision OMR verification over ordered source sheet pages."""
    cfg = settings or get_settings()
    has_existing_sources = bool(source_files and any(p.exists() for p, _ in source_files))
    structural_report = evaluate_omr_structure(
        musicxml,
        source_available=has_existing_sources,
        source_message=None if has_existing_sources else "Original sheet music source files are unavailable for AI visual verification.",
        can_revert=can_revert,
        applied_finding_ids=applied_finding_ids,
    )

    if not has_existing_sources:
        return structural_report.model_copy(
            update={
                "ai_error": "Original PDF/image source files could not be found in storage. Re-upload the original score to run AI Vision verification.",
            }
        )

    api_key = (cfg.GEMINI_API_KEY or "").strip()
    if not api_key:
        return structural_report.model_copy(
            update={
                "score_status": "ai_unavailable",
                "ai_verified": False,
                "ai_confidence": None,
                "ai_error": "Gemini Vision verification is not configured on this server (GEMINI_API_KEY missing).",
            }
        )

    model_name = (cfg.GEMINI_VISION_MODEL or "gemini-2.5-flash").strip()
    timeout_sec = float(cfg.GEMINI_API_TIMEOUT_SECONDS or 45.0)
    client_cls = http_client_factory or httpx.Client

    ai_findings: list[OmrFinding] = []
    page_confidences: list[float] = []
    page_errors: list[str] = []

    with tempfile.TemporaryDirectory(prefix="scriba_omr_vis_") as tmpdir:
        tmp_path = Path(tmpdir)
        try:
            page_images = _prepare_source_page_images(source_files, tmp_path)
        except Exception as exc:
            return structural_report.model_copy(
                update={
                    "score_status": "ai_failed",
                    "ai_verified": False,
                    "ai_confidence": None,
                    "ai_error": f"Failed preparing sheet music page images for AI verification: {exc}",
                }
            )

        if not page_images:
            return structural_report.model_copy(
                update={
                    "source_available": False,
                    "score_status": "ai_failed",
                    "ai_verified": False,
                    "ai_confidence": None,
                    "ai_error": "No readable sheet music pages could be extracted from the source file.",
                }
            )

        summaries = _build_page_measure_summaries(musicxml, len(page_images))
        summary_by_page = {p_num: (m_start, m_end, txt) for p_num, m_start, m_end, txt in summaries}

        endpoint = f"https://generativelanguage.googleapis.com/v1beta/models/{model_name}:generateContent"
        try:
            with client_cls(timeout=timeout_sec) as client:
                for page_num, img_path in page_images:
                    m_start, m_end, measure_summary = summary_by_page.get(
                        page_num, summaries[-1][1:] if summaries else (1, 1, "")
                    )
                    img_b64 = base64.b64encode(img_path.read_bytes()).decode("ascii")
                    prompt_text = (
                        "You are an Optical Music Recognition (OMR) proofreader verifying extracted MusicXML "
                        f"against original sheet music page {page_num} of {len(page_images)} "
                        f"(extracted measures {m_start}-{m_end}).\n"
                        "Inspect ONLY visible discrepancies between the sheet image and extracted MusicXML summary: "
                        "missed/wrong accidentals, wrong pitches, missed ties/slurs, tuplets, rhythm durations, "
                        "chords, fingerings (1-5), and pedal markings.\n"
                        "CRITICAL RULES:\n"
                        "1. Do NOT invent notes or markings when the image is unclear or ambiguous.\n"
                        "2. Return strict JSON: "
                        '{"page_confidence": <0-100 number>, "findings": [{'
                        '"measure": <int>, "part_id": <str|null>, "staff": <int|null>, "voice": <str|null>, '
                        '"category": "accidental|pitch|duration|tie_slur|tuplet|chord|fingering|pedal|rest|other", '
                        '"severity": "high|medium|low", "description": <concise str>, '
                        '"confidence": <0-100 number>, '
                        '"proposed_fix": <null or {"action":"set_accidental|set_pitch|add_tie|add_fingering|add_pedal",'
                        '"part_id":<str|null>,"measure":<int>,"staff":<int|null>,"voice":<str|null>,'
                        '"note_index":<0-based #idx from summary>,"step":"C"|"D"|...,"alter":<-2..2>,'
                        '"octave":<0..9>,"fingering":"1".."5","pedal_type":"start"|"stop"}>}]}.\n'
                        f"Extracted MusicXML summary for Page {page_num}:\n{measure_summary}"
                    )
                    body = {
                        "contents": [
                            {
                                "role": "user",
                                "parts": [
                                    {"text": prompt_text},
                                    {"inlineData": {"mimeType": "image/png", "data": img_b64}},
                                ],
                            }
                        ],
                        "generationConfig": {
                            "temperature": 0.1,
                            "responseMimeType": "application/json",
                        },
                    }
                    try:
                        resp = client.post(
                            endpoint,
                            headers={"x-goog-api-key": api_key, "Content-Type": "application/json"},
                            json=body,
                        )
                        if resp.status_code == 429:
                            page_errors.append(f"Page {page_num}: Gemini rate limit exceeded (429).")
                            continue
                        if resp.status_code >= 400:
                            page_errors.append(f"Page {page_num}: Gemini API HTTP {resp.status_code}.")
                            continue
                        parsed = _extract_gemini_json_payload(resp.json())
                        raw_conf = parsed.get("page_confidence")
                        if not isinstance(raw_conf, (int, float)) or not math.isfinite(float(raw_conf)):
                            page_errors.append(f"Page {page_num}: missing numeric page_confidence.")
                            continue
                        page_conf = max(0.0, min(100.0, float(raw_conf)))
                        page_confidences.append(page_conf)

                        raw_findings = parsed.get("findings")
                        if isinstance(raw_findings, list):
                            for item in raw_findings[:40]:
                                if not isinstance(item, dict):
                                    continue
                                raw_fix = item.get("proposed_fix")
                                validated_fix: OmrProposedFix | None = None
                                if isinstance(raw_fix, dict):
                                    try:
                                        validated_fix = OmrProposedFix.model_validate(raw_fix)
                                    except ValidationError:
                                        validated_fix = None
                                try:
                                    f_conf = item.get("confidence")
                                    finding = OmrFinding(
                                        id=f"ai-p{page_num}-{uuid.uuid4().hex[:8]}",
                                        source="ai_vision",
                                        page=page_num,
                                        measure=max(0, int(item.get("measure", m_start))),
                                        part_id=(
                                            str(item["part_id"]) if item.get("part_id") is not None else None
                                        ),
                                        staff=int(item["staff"]) if item.get("staff") is not None else None,
                                        voice=str(item["voice"]) if item.get("voice") is not None else None,
                                        category=str(item.get("category") or "other")[:40],
                                        severity=(
                                            str(item.get("severity"))
                                            if item.get("severity") in ("high", "medium", "low")
                                            else "medium"
                                        ),
                                        description=str(item.get("description") or "").strip()[:400],
                                        confidence=(
                                            max(0.0, min(100.0, float(f_conf)))
                                            if isinstance(f_conf, (int, float))
                                            else page_conf
                                        ),
                                        proposed_fix=validated_fix,
                                    )
                                    if finding.description:
                                        ai_findings.append(finding)
                                except Exception:
                                    continue
                    except (httpx.TimeoutException, httpx.HTTPError, ValueError, json.JSONDecodeError) as exc:
                        page_errors.append(f"Page {page_num}: {exc}")
        except Exception as exc:
            return structural_report.model_copy(
                update={
                    "score_status": "ai_failed",
                    "ai_verified": False,
                    "ai_confidence": None,
                    "model_used": model_name,
                    "ai_error": f"Gemini Vision request failed: {exc}",
                }
            )

    if not page_confidences:
        return structural_report.model_copy(
            update={
                "score_status": "ai_failed",
                "ai_verified": False,
                "ai_confidence": None,
                "model_used": model_name,
                "ai_error": "; ".join(page_errors) if page_errors else "AI Vision verification failed.",
            }
        )

    ai_conf = round(sum(page_confidences) / float(len(page_confidences)), 1)
    combined_raw = 0.40 * structural_report.structural_score + 0.60 * ai_conf
    high_count = sum(1 for f in ai_findings if f.severity == "high")
    med_count = sum(1 for f in ai_findings if f.severity == "medium")
    discrepancy_penalty = min(22.0, high_count * 4.0 + med_count * 1.5)
    final_match = max(0, min(100, int(round(combined_raw - discrepancy_penalty))))

    all_findings = [*structural_report.findings, *ai_findings]
    all_flagged = sorted({*structural_report.flagged_measures, *(f.measure for f in ai_findings if f.measure > 0)})

    return OmrVerificationReport(
        omr_match_score=final_match,
        score_status="verified",
        structural_score=structural_report.structural_score,
        rhythm_validity_score=structural_report.rhythm_validity_score,
        structural_consistency_score=structural_report.structural_consistency_score,
        ai_verified=True,
        ai_confidence=ai_conf,
        source_available=True,
        source_message=None,
        total_measures=structural_report.total_measures,
        valid_rhythm_measures=structural_report.valid_rhythm_measures,
        flagged_measures=all_flagged,
        findings=all_findings,
        content_hash=structural_report.content_hash,
        verified_at=datetime.now(UTC).isoformat(),
        model_used=model_name,
        ai_error="; ".join(page_errors) if page_errors else None,
        applied_finding_ids=list(applied_finding_ids or []),
        can_revert=can_revert,
    )


def apply_omr_proposed_fixes(
    musicxml: str,
    fixes: list[tuple[str, OmrProposedFix]],
) -> tuple[str, list[str], list[str]]:
    """Safely apply validated OMR corrections onto MusicXML without corrupting score structure."""
    if not fixes:
        return musicxml, [], []

    try:
        root = ET.fromstring(musicxml)
    except ET.ParseError:
        return musicxml, [], [fid for fid, _ in fixes]

    parts = root.findall("./part")
    if not parts:
        return musicxml, [], [fid for fid, _ in fixes]

    applied_ids: list[str] = []
    skipped_ids: list[str] = []

    for finding_id, fix in fixes:
        part_el = next((p for p in parts if fix.part_id and p.get("id") == fix.part_id), None)
        if part_el is None:
            part_el = parts[0] if len(parts) == 1 or not fix.part_id else None
        if part_el is None:
            skipped_ids.append(finding_id)
            continue

        target_measure: ET.Element | None = None
        for idx, m_el in enumerate(part_el.findall("./measure")):
            if _parse_measure_number(m_el.get("number"), idx) == fix.measure:
                target_measure = m_el
                break
        if target_measure is None:
            skipped_ids.append(finding_id)
            continue

        all_notes = target_measure.findall("./note")
        scoped_notes = [
            n_el
            for n_el in all_notes
            if (fix.staff is None or _parse_int_text(n_el.find("staff"), 1) == fix.staff)
            and (fix.voice is None or (n_el.findtext("voice") or "1").strip() == str(fix.voice).strip())
        ]
        if fix.note_index is None:
            skipped_ids.append(finding_id)
            continue

        target_note: ET.Element | None = None
        if 0 <= fix.note_index < len(all_notes) and fix.staff is None and fix.voice is None:
            target_note = all_notes[fix.note_index]
        elif 0 <= fix.note_index < len(scoped_notes):
            target_note = scoped_notes[fix.note_index]
        elif 0 <= fix.note_index < len(all_notes):
            # Also match absolute #idx from prompt summary when both staff/voice filters aren't exact
            cand = all_notes[fix.note_index]
            if (fix.staff is None or _parse_int_text(cand.find("staff"), 1) == fix.staff) and (
                fix.voice is None or (cand.findtext("voice") or "1").strip() == str(fix.voice).strip()
            ):
                target_note = cand

        if target_note is None:
            skipped_ids.append(finding_id)
            continue

        did_apply = False
        if fix.action == "set_accidental" and fix.alter is not None:
            pitch_el = target_note.find("pitch")
            if pitch_el is not None:
                alter_val = int(fix.alter)
                alter_el = pitch_el.find("alter")
                if alter_el is None:
                    alter_el = ET.SubElement(pitch_el, "alter")
                alter_el.text = str(alter_val)
                acc_el = target_note.find("accidental")
                if acc_el is None:
                    acc_el = ET.SubElement(target_note, "accidental")
                acc_el.text = ALTER_TO_ACCIDENTAL.get(alter_val, "natural")
                did_apply = True
        elif fix.action == "set_pitch" and fix.step and fix.step.upper() in VALID_STEPS and fix.octave is not None:
            if target_note.find("rest") is None:
                pitch_el = target_note.find("pitch")
                if pitch_el is None:
                    pitch_el = ET.SubElement(target_note, "pitch")
                step_el = pitch_el.find("step") or ET.SubElement(pitch_el, "step")
                step_el.text = fix.step.upper()
                oct_el = pitch_el.find("octave") or ET.SubElement(pitch_el, "octave")
                oct_el.text = str(int(fix.octave))
                if fix.alter is not None:
                    alter_el = pitch_el.find("alter") or ET.SubElement(pitch_el, "alter")
                    alter_el.text = str(int(fix.alter))
                    acc_el = target_note.find("accidental") or ET.SubElement(target_note, "accidental")
                    acc_el.text = ALTER_TO_ACCIDENTAL.get(int(fix.alter), "natural")
                did_apply = True
        elif fix.action == "add_tie":
            if target_note.find("pitch") is not None:
                has_start = any(t.get("type") == "start" for t in target_note.findall("tie"))
                if not has_start:
                    tie_el = ET.SubElement(target_note, "tie")
                    tie_el.set("type", "start")
                notations = target_note.find("notations") or ET.SubElement(target_note, "notations")
                if not any(t.get("type") == "start" for t in notations.findall("tied")):
                    tied_el = ET.SubElement(notations, "tied")
                    tied_el.set("type", "start")
                did_apply = True
        elif fix.action == "add_fingering" and fix.fingering and fix.fingering.strip() in {"1", "2", "3", "4", "5"}:
            if target_note.find("pitch") is not None:
                notations = target_note.find("notations") or ET.SubElement(target_note, "notations")
                tech = notations.find("technical") or ET.SubElement(notations, "technical")
                fing = tech.find("fingering") or ET.SubElement(tech, "fingering")
                fing.text = fix.fingering.strip()
                did_apply = True
        elif fix.action == "add_pedal" and fix.pedal_type in ("start", "stop"):
            children = list(target_measure)
            note_pos = children.index(target_note)
            dir_el = ET.Element("direction")
            dir_el.set("placement", "below")
            dt_el = ET.SubElement(dir_el, "direction-type")
            ped_el = ET.SubElement(dt_el, "pedal")
            ped_el.set("type", fix.pedal_type)
            if fix.staff is not None:
                st_el = ET.SubElement(dir_el, "staff")
                st_el.text = str(fix.staff)
            target_measure.insert(note_pos, dir_el)
            did_apply = True

        if did_apply:
            applied_ids.append(finding_id)
        else:
            skipped_ids.append(finding_id)

    if not applied_ids:
        return musicxml, [], skipped_ids

    out_xml = ET.tostring(root, encoding="unicode")
    # Re-validate patched XML before returning
    post_report = evaluate_omr_structure(out_xml)
    if post_report.total_measures == 0 and evaluate_omr_structure(musicxml).total_measures > 0:
        return musicxml, [], [fid for fid, _ in fixes]

    return out_xml, applied_ids, skipped_ids
