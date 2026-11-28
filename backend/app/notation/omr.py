"""Optical Music Recognition (OMR) and SATB voice identification for PDF scores.

Uses ``pypdf`` for PDF validation, ``pymupdf`` (``fitz``) for high-DPI page
rendering, ``homr`` (in ``backend/.venv_omr`` or PATH) for MusicXML recognition,
and ``music21`` for SATB staff/voice extraction.
"""

from __future__ import annotations

import io
import logging
import os
import re
import shutil
import subprocess
import uuid
import xml.etree.ElementTree as ET
import zipfile
from collections.abc import Callable
from copy import deepcopy
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING

from pypdf import PdfReader

from app.notation.image_preprocessing import (
    SheetImageValidationError,
    build_normalized_pdf_from_images,
    detect_score_input_kind,
    preprocess_sheet_image_for_omr,
    validate_sheet_image_bytes,
)
from app.schemas.score import ScoreData, ScoreNote, ScoreTrack

if TYPE_CHECKING:
    import music21

logger = logging.getLogger(__name__)

SATB_VOICES: tuple[str, ...] = ("Soprano", "Alto", "Tenor", "Bass")
SATB_VOICE_SET = set(SATB_VOICES)


class OMRError(Exception):
    """Raised when PDF validation, OMR dependency lookup, or recognition fails."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass
class SATBPartAssignment:
    part_index: int
    source_label: str
    clef: str
    voice_id: str | None
    assigned_voice: str  # Soprano | Alto | Tenor | Bass | Unassigned
    confidence: float
    uncertain: bool
    note_count: int
    mean_pitch: float | None = None


@dataclass
class OMRRecognitionResult:
    musicxml: str
    score_data: ScoreData
    page_count: int
    assignments: list[SATBPartAssignment] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    needs_review: bool = False


def validate_pdf_bytes(pdf_bytes: bytes) -> int:
    """Validate PDF payload (non-empty, %PDF-, uncorrupted, unencrypted) and return page count."""
    if not pdf_bytes or len(pdf_bytes) < 32:
        raise OMRError("EMPTY_PDF", "Uploaded PDF file is empty.")
    if not pdf_bytes.lstrip().startswith(b"%PDF-"):
        raise OMRError("INVALID_PDF", "File is not a valid PDF document.")
    try:
        reader = PdfReader(io.BytesIO(pdf_bytes))
    except Exception as exc:
        raise OMRError("CORRUPTED_PDF", f"PDF file could not be parsed: {exc}") from exc

    if reader.is_encrypted:
        raise OMRError(
            "ENCRYPTED_PDF",
            "Password-protected or encrypted PDFs are not supported. Please unlock the PDF and try again.",
        )
    try:
        page_count = len(reader.pages)
    except Exception as exc:
        raise OMRError("CORRUPTED_PDF", f"Unable to read PDF pages: {exc}") from exc

    if page_count <= 0:
        raise OMRError("EMPTY_PDF", "PDF contains zero pages.")
    return page_count


def validate_musicxml_bytes(data: bytes, filename: str) -> None:
    """Validate uncompressed .musicxml/.xml or compressed .mxl score payload."""
    if not data or len(data) < 16:
        raise OMRError("EMPTY_SCORE", "Uploaded score file is empty.")

    lower = (filename or "").strip().lower()
    if lower.endswith(".mxl"):
        try:
            with zipfile.ZipFile(io.BytesIO(data), "r") as zf:
                names = zf.namelist()
                has_xml = any(
                    n.lower().endswith((".xml", ".musicxml")) and "meta-inf" not in n.lower()
                    for n in names
                )
                if not has_xml:
                    raise OMRError("INVALID_MXL", "MXL archive does not contain a MusicXML score.")
        except OMRError:
            raise
        except Exception as exc:
            raise OMRError("INVALID_MXL", f"File is not a valid compressed MXL archive: {exc}") from exc
        return

    try:
        text = data.decode("utf-8-sig", errors="strict")
    except UnicodeDecodeError:
        text = data.decode("latin-1", errors="ignore")
    if "<score-partwise" not in text and "<score-timewise" not in text:
        raise OMRError(
            "INVALID_MUSICXML",
            "File does not appear to be a valid MusicXML score (<score-partwise> or <score-timewise>).",
        )


def render_pdf_pages_to_images(pdf_path: Path, out_dir: Path, *, dpi: int = 250) -> list[Path]:
    """Render all PDF pages to high-resolution grayscale/RGB PNGs via PyMuPDF."""
    try:
        import pymupdf
    except ImportError as exc:
        raise OMRError(
            "OMR_DEPENDENCY_MISSING",
            "PyMuPDF (pymupdf) is required for PDF page rendering.",
        ) from exc

    out_dir.mkdir(parents=True, exist_ok=True)
    image_paths: list[Path] = []
    doc = pymupdf.open(str(pdf_path))
    try:
        zoom = dpi / 72.0
        matrix = pymupdf.Matrix(zoom, zoom)
        for idx in range(len(doc)):
            page = doc[idx]
            pix = page.get_pixmap(matrix=matrix, alpha=False)
            img_path = out_dir / f"page_{idx + 1:03d}.png"
            pix.save(str(img_path))
            image_paths.append(img_path)
    finally:
        doc.close()

    if not image_paths:
        raise OMRError("EMPTY_PDF", "No pages could be rendered from the PDF.")
    return image_paths


def find_homr_executable() -> Path | None:
    """Locate the homr CLI executable in env, isolated .venv_omr, or PATH."""
    env_bin = os.environ.get("HOMR_EXECUTABLE", "").strip()
    if env_bin and Path(env_bin).exists():
        return Path(env_bin)

    repo_root = Path(__file__).resolve().parents[3]
    candidates = [
        repo_root / "backend" / ".venv_omr" / "Scripts" / "homr.exe",
        repo_root / "backend" / ".venv_omr" / "bin" / "homr",
        Path.cwd() / ".venv_omr" / "Scripts" / "homr.exe",
        Path.cwd() / "backend" / ".venv_omr" / "Scripts" / "homr.exe",
    ]
    for cand in candidates:
        if cand.exists():
            return cand

    which_bin = shutil.which("homr")
    return Path(which_bin) if which_bin else None


def find_audiveris_executable() -> Path | None:
    """Locate the Audiveris CLI executable if installed via env, PATH, or standard Windows path."""
    env_bin = os.environ.get("AUDIVERIS_EXECUTABLE", "").strip()
    if env_bin and Path(env_bin).exists():
        return Path(env_bin)

    which_bin = shutil.which("audiveris") or shutil.which("Audiveris")
    if which_bin:
        return Path(which_bin)

    win_default = Path(r"C:\Program Files\Audiveris\Audiveris.exe")
    return win_default if win_default.exists() else None


def run_audiveris_on_file(input_path: Path, out_dir: Path, *, timeout: int = 300) -> tuple[str, list[str]]:
    """Run Audiveris CLI batch OMR on a PDF or image file and return MusicXML string + warnings."""
    import music21

    aud_bin = find_audiveris_executable()
    if aud_bin is None:
        raise OMRError("OMR_DEPENDENCY_MISSING", "Audiveris CLI is not installed.")

    out_dir.mkdir(parents=True, exist_ok=True)
    cmd = [str(aud_bin), "-batch", "-export", "-output", str(out_dir), str(input_path)]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, check=False)
    except subprocess.TimeoutExpired as exc:
        raise OMRError("OMR_TIMEOUT", f"Audiveris timed out after {timeout}s.") from exc

    if proc.returncode != 0:
        err_tail = (proc.stderr or proc.stdout or "").strip()[-400:]
        raise OMRError("OMR_FAILED", f"Audiveris failed: {err_tail or 'non-zero exit'}")

    mxl_files = sorted(out_dir.rglob("*.mxl"))
    xml_files = sorted(out_dir.rglob("*.musicxml")) or sorted(out_dir.rglob("*.xml"))
    target = mxl_files[0] if mxl_files else (xml_files[0] if xml_files else None)
    if target is None:
        raise OMRError("OMR_EMPTY_OUTPUT", "Audiveris did not produce a MusicXML or MXL output file.")

    parsed = music21.converter.parse(str(target))
    xml_str = music21.musicxml.m21ToXml.GeneralObjectExporter(parsed).parse().decode("utf-8")
    return xml_str, []


def run_audiveris_on_pdf(pdf_path: Path, out_dir: Path, *, timeout: int = 300) -> tuple[str, list[str]]:
    """Run Audiveris CLI batch OMR on a PDF and return MusicXML string + warnings."""
    return run_audiveris_on_file(pdf_path, out_dir, timeout=timeout)


def _xml_sig(el: ET.Element | None) -> str:
    if el is None:
        return ""
    return re.sub(r"\s+", " ", ET.tostring(el, encoding="unicode")).strip()


def _parse_partwise_root(xml_str: str) -> ET.Element:
    """Parse MusicXML string to a <score-partwise> ElementTree root (converting timewise via music21 if needed)."""
    cleaned = xml_str.lstrip("\ufeff").strip()
    root = ET.fromstring(cleaned)
    if root.tag.endswith("score-partwise"):
        return root
    if root.tag.endswith("score-timewise"):
        import music21

        parsed = music21.converter.parseData(cleaned, format="musicxml")
        converted = music21.musicxml.m21ToXml.GeneralObjectExporter(parsed).parse().decode("utf-8")
        return ET.fromstring(converted.lstrip("\ufeff").strip())
    raise ValueError(f"Unexpected MusicXML root element '{root.tag}'.")


def _extract_part_musical_state(part_el: ET.Element, state: dict[str, object]) -> None:
    """Walk all measures in a <part> and update running divisions/staves/key/time/clefs state."""
    for m_el in part_el.findall("measure"):
        for attrs in m_el.findall("attributes"):
            div_txt = (attrs.findtext("divisions") or "").strip()
            if div_txt:
                state["divisions"] = div_txt
            staves_txt = (attrs.findtext("staves") or "").strip()
            if staves_txt:
                state["staves"] = staves_txt
            key_el = attrs.find("key")
            if key_el is not None:
                state["key"] = _xml_sig(key_el)
            time_el = attrs.find("time")
            if time_el is not None:
                state["time"] = _xml_sig(time_el)
            clefs = list(attrs.findall("clef"))
            if clefs:
                clef_map: dict[str, str] = dict(state.get("clefs") or {})  # type: ignore[arg-type]
                for c in clefs:
                    clef_map[c.attrib.get("number") or "1"] = _xml_sig(c)
                state["clefs"] = clef_map


def _build_rest_measure_matching_state(measure_num: int, state: dict[str, object]) -> ET.Element:
    """Create a whole-measure rest matching the part's running divisions and time signature."""
    divisions = int(float(str(state.get("divisions") or "1")))
    beats = 4
    beat_type = 4
    time_sig_xml = str(state.get("time") or "")
    if time_sig_xml:
        try:
            t_el = ET.fromstring(time_sig_xml)
            beats = max(1, int((t_el.findtext("beats") or "4").strip()))
            beat_type = max(1, int((t_el.findtext("beat-type") or "4").strip()))
        except Exception:
            pass
    dur = max(1, round(divisions * beats * (4.0 / beat_type)))
    m = ET.Element("measure", {"number": str(measure_num)})
    note = ET.SubElement(m, "note")
    ET.SubElement(note, "rest", {"measure": "yes"})
    dur_el = ET.SubElement(note, "duration")
    dur_el.text = str(dur)
    v_el = ET.SubElement(note, "voice")
    v_el.text = "1"
    return m


def assemble_multipage_musicxml(
    page_xml_strings: list[str],
    *,
    page_labels: list[str] | None = None,
) -> tuple[str, list[str]]:
    """Sequentially assemble recognized per-page MusicXML strings into one coherent score."""
    import music21

    if not page_xml_strings:
        raise OMRError("OMR_EMPTY_OUTPUT", "No recognized page MusicXML files were provided for assembly.")

    warnings: list[str] = []
    labels = page_labels or [f"Page {i}" for i in range(1, len(page_xml_strings) + 1)]

    if len(page_xml_strings) == 1:
        root = _parse_partwise_root(page_xml_strings[0])
        has_notes = len(root.findall(".//part/measure/note/pitch")) > 0
        if not has_notes:
            raise OMRError(
                "OMR_PAGE_FAILED",
                f"No musical notation (pitched notes) was recognized on Page 1 ({labels[0]}).",
            )
        xml_out = ET.tostring(root, encoding="unicode", xml_declaration=True)
        music21.converter.parseData(xml_out, format="musicxml")
        return xml_out, warnings

    base_root: ET.Element | None = None
    base_parts: list[ET.Element] = []
    part_states: list[dict[str, object]] = []
    last_measure_num = 0

    for idx, raw_xml in enumerate(page_xml_strings, start=1):
        label = labels[idx - 1] if idx - 1 < len(labels) else f"Page {idx}"
        try:
            page_root = _parse_partwise_root(raw_xml)
        except Exception as exc:
            raise OMRError(
                "OMR_PAGE_FAILED",
                f"Page {idx} ({label}) produced invalid MusicXML: {exc}",
            ) from exc

        page_parts = list(page_root.findall("part"))
        if not page_parts or not any(p.findall("./measure") for p in page_parts):
            raise OMRError(
                "OMR_PAGE_FAILED",
                f"Page {idx} ({label}) yielded no recognized staves or measures.",
            )

        if base_root is None:
            base_root = deepcopy(page_root)
            base_parts = list(base_root.findall("part"))
            for bp in base_parts:
                st: dict[str, object] = {"divisions": "1", "staves": "1", "key": "", "time": "", "clefs": {}}
                _extract_part_musical_state(bp, st)
                part_states.append(st)
            first_measures = base_parts[0].findall("measure")
            for m in first_measures:
                try:
                    num = int(m.attrib.get("number") or "0")
                except ValueError:
                    num = last_measure_num + 1
                last_measure_num = max(last_measure_num, num)
            if last_measure_num == 0:
                last_measure_num = len(first_measures)
            continue

        if len(page_parts) != len(base_parts):
            warnings.append(
                f"Page {idx} ({label}) has {len(page_parts)} staves (expected {len(base_parts)}); aligning parts cleanly."
            )

        page_measure_count = max(len(p.findall("measure")) for p in page_parts)
        for p_idx, base_part in enumerate(base_parts):
            st = part_states[p_idx]
            if p_idx >= len(page_parts):
                for m_offset in range(1, page_measure_count + 1):
                    base_part.append(_build_rest_measure_matching_state(last_measure_num + m_offset, st))
                continue

            src_measures = list(page_parts[p_idx].findall("measure"))
            for m_idx, src_m in enumerate(src_measures):
                m_copy = deepcopy(src_m)
                next_num = last_measure_num + m_idx + 1
                m_copy.set("number", str(next_num))
                m_copy.attrib.pop("implicit", None)

                # Inspect <attributes>: strip redundant repeated key/time/clef/divisions on page break
                # while keeping genuine mid-piece changes intact.
                for attrs in list(m_copy.findall("attributes")):
                    div_el = attrs.find("divisions")
                    if div_el is not None:
                        div_val = (div_el.text or "").strip()
                        if div_val and div_val == st.get("divisions") and m_idx == 0:
                            attrs.remove(div_el)
                        elif div_val:
                            st["divisions"] = div_val

                    staves_el = attrs.find("staves")
                    if staves_el is not None:
                        st_val = (staves_el.text or "").strip()
                        if st_val and st_val == st.get("staves") and m_idx == 0:
                            attrs.remove(staves_el)
                        elif st_val:
                            st["staves"] = st_val

                    key_el = attrs.find("key")
                    if key_el is not None:
                        k_sig = _xml_sig(key_el)
                        if m_idx == 0 and k_sig == st.get("key"):
                            attrs.remove(key_el)
                        else:
                            st["key"] = k_sig

                    time_el = attrs.find("time")
                    if time_el is not None:
                        t_sig = _xml_sig(time_el)
                        if m_idx == 0 and t_sig == st.get("time"):
                            attrs.remove(time_el)
                        else:
                            st["time"] = t_sig

                    clef_map: dict[str, str] = dict(st.get("clefs") or {})  # type: ignore[arg-type]
                    for clef_el in list(attrs.findall("clef")):
                        c_num = clef_el.attrib.get("number") or "1"
                        c_sig = _xml_sig(clef_el)
                        if m_idx == 0 and clef_map.get(c_num) == c_sig:
                            attrs.remove(clef_el)
                        else:
                            clef_map[c_num] = c_sig
                    st["clefs"] = clef_map

                    if len(attrs) == 0:
                        m_copy.remove(attrs)

                if m_idx == 0:
                    for old_print in list(m_copy.findall("print")):
                        m_copy.remove(old_print)
                    m_copy.insert(0, ET.Element("print", {"new-page": "yes"}))

                base_part.append(m_copy)

            # Pad trailing bar if one part on page had fewer measures
            for m_offset in range(len(src_measures), page_measure_count):
                base_part.append(_build_rest_measure_matching_state(last_measure_num + m_offset + 1, st))

        last_measure_num += page_measure_count

    assert base_root is not None
    xml_out = ET.tostring(base_root, encoding="unicode", xml_declaration=True)
    music21.converter.parseData(xml_out, format="musicxml")
    return xml_out, warnings


def _merge_multipage_scores(page_xml_paths: list[Path]) -> tuple[music21.stream.Score, list[str]]:
    """Merge recognized page MusicXML files sequentially using coherent MusicXML assembly."""
    import music21

    if len(page_xml_paths) == 1:
        return music21.converter.parse(str(page_xml_paths[0])), []

    page_strings = [p.read_text(encoding="utf-8-sig", errors="replace") for p in page_xml_paths]
    assembled_xml, warnings = assemble_multipage_musicxml(
        page_strings,
        page_labels=[p.name for p in page_xml_paths],
    )
    return music21.converter.parseData(assembled_xml, format="musicxml"), warnings


def run_homr_on_images(image_paths: list[Path], *, timeout_per_page: int = 180) -> tuple[str, list[str]]:
    """Run homr OMR on rendered page images and return merged MusicXML + warnings."""
    import music21

    homr_bin = find_homr_executable()
    if homr_bin is None:
        raise OMRError(
            "OMR_DEPENDENCY_MISSING",
            "OMR engine (homr) is not installed. Create backend/.venv_omr and install 'homr' + 'onnxruntime'.",
        )

    xml_outputs: list[Path] = []
    warnings: list[str] = []

    for idx, img_path in enumerate(image_paths, start=1):
        res = subprocess.run(
            [str(homr_bin), str(img_path)],
            capture_output=True,
            text=True,
            timeout=timeout_per_page,
            check=False,
        )
        expected_xml = img_path.with_suffix(".musicxml")
        if res.returncode != 0 or not expected_xml.exists():
            err_tail = (res.stderr or res.stdout or "").strip()[-400:]
            if len(image_paths) == 1:
                raise OMRError(
                    "OMR_PAGE_FAILED",
                    f"OMR could not recognize sheet music on Page {idx}: {err_tail or 'no output generated'}",
                )
            warnings.append(f"Page {idx} OMR failed (rc={res.returncode}): {err_tail}")
            continue
        xml_outputs.append(expected_xml)

    if not xml_outputs:
        raise OMRError(
            "OMR_RECOGNITION_FAILED",
            "OMR could not recognize musical notation from any page of the uploaded score.",
        )

    merged_score, merge_warnings = _merge_multipage_scores(xml_outputs)
    warnings.extend(merge_warnings)
    xml_str = music21.musicxml.m21ToXml.GeneralObjectExporter(merged_score).parse().decode("utf-8")
    return xml_str, warnings


_ACCOMP_KEYWORDS = ("piano", "accompaniment", "accomp", "keyboard", "organ", "pno", "harpsichord")

_FOOTER_METADATA_RE = re.compile(
    r"(?:©|\(c\)|copyright|all\s+rights\s+reserved|used\s+by\s+permission|"
    r"without\s+permission|personal\s+use|non[- ]?commercial|non[- ]?church|making\s+copies|"
    r"(?:may|not)\s+be\s+reproduced|"
    r"ccli\b|licen[cs]e|arr\.?\s+by|arranged\s+by|words\s*(?:&|and)\s*music|"
    r"(?:music|text|lyrics)\s+by\s+[A-Z][\w.-]+(?:\s+[A-Z][\w.-]+){0,3}|"
    r"published\s+by|engraved\s+by|typeset\s+by|printed\s+in|"
    r"hal\s+leonard|imslp|public\s+domain|musescore|"
    r"(?:https?://|www\.)\S+|\b\S+\.(?:com|org|net)\b|"
    r"^(?:page|p\.?)\s*\d+(?:\s*of\s*\d+)?$)",
    re.IGNORECASE,
)

_CREDIT_BY_NAME_RE = re.compile(
    r"\bby\s+[A-Z][a-z]{1,24}(?:\s+[A-Z]\.?)?\s+[A-Z][a-z]{1,24}\b"
)

_SECTION_LABEL_RE = re.compile(
    r"^(?:harmony|unison|chorus|refrain|verse(?:\s*\d+)?|solo|duet|tutti|men|women|soprano|alto|tenor|bass|coda|fine|d\.?\s*c\.?(?:\s+al\s+(?:fine|coda))?|d\.?\s*s\.?(?:\s+al\s+(?:fine|coda))?)$",
    re.IGNORECASE,
)


def _is_section_label_text(text: str) -> bool:
    """Return True only when text is a standalone section/editorial heading rather than lyric content."""
    cleaned = re.sub(r"\s+", " ", (text or "")).strip()
    if not cleaned:
        return False
    stripped = cleaned.strip(" \t\r\n:;,-!?()[]\"'")
    if not stripped:
        return False
    if _SECTION_LABEL_RE.match(stripped):
        return True
    # Also handle trailing period on non-D.C./D.S. words like "Harmony." or "Chorus."
    no_trail_dot = stripped.rstrip(".")
    return bool(no_trail_dot and _SECTION_LABEL_RE.match(no_trail_dot))


_VALID_CHORD_KIND_TEXT_RE = re.compile(
    r"^(?:N\.?C\.?|[A-Ga-g][#b]?(?:maj|min|dim|aug|sus|add|m|M)?[0-9#b+°øΔ-]*(?:\([^)]+\))?(?:/[A-Ga-g][#b]?)?|(?:maj|min|dim|aug|sus|add|m|M)?[0-9#b+°øΔ-]*(?:\([^)]+\))?)$"
)


def _is_malformed_harmony(harmony_el: ET.Element) -> bool:
    """Return True if a <harmony> element is malformed OMR noise (e.g., 'Csus4 c' or missing root)."""
    root_el = harmony_el.find("root")
    if root_el is None:
        return True
    step = (root_el.findtext("root-step") or "").strip().upper()
    if step not in {"A", "B", "C", "D", "E", "F", "G"}:
        return True
    kind_el = harmony_el.find("kind")
    if kind_el is not None:
        kind_text = re.sub(r"\s+", " ", (kind_el.attrib.get("text") or "")).strip()
        if kind_text and " " in kind_text:
            # Stray space-separated token like "Csus4 c" is OMR noise, not a valid chord suffix
            if not _VALID_CHORD_KIND_TEXT_RE.match(kind_text):
                return True
    return False


def _sanitize_satb_harmonies(root: ET.Element) -> int:
    """Keep valid chord symbols on Soprano/top-line only; strip lower-staff duplicates and malformed OMR noise."""
    parts = list(root.findall("part"))
    if not parts:
        return 0

    part_names: dict[str, str] = {}
    for sp in root.findall("./part-list/score-part"):
        pid = sp.attrib.get("id", "")
        part_names[pid] = (sp.findtext("part-name") or "").strip().lower()

    soprano_idx = 0
    for idx, p in enumerate(parts):
        pname = part_names.get(p.attrib.get("id", ""), "")
        if "soprano" in pname or pname == "sop":
            soprano_idx = idx
            break

    removed = 0
    for idx, part_el in enumerate(parts):
        is_soprano = idx == soprano_idx
        for m_el in part_el.findall("measure"):
            seen_sigs: set[tuple[float, str, str, str, str]] = set()
            offset_div = 0.0
            for child in list(m_el):
                tag = child.tag.lower() if isinstance(child.tag, str) else ""
                if tag == "backup":
                    try:
                        offset_div = max(0.0, offset_div - float(child.findtext("duration") or 0.0))
                    except ValueError:
                        pass
                elif tag == "forward":
                    try:
                        offset_div += float(child.findtext("duration") or 0.0)
                    except ValueError:
                        pass
                elif tag == "note":
                    if child.find("chord") is None and child.find("grace") is None:
                        try:
                            offset_div += float(child.findtext("duration") or 0.0)
                        except ValueError:
                            pass
                elif tag == "harmony":
                    if (len(parts) >= 2 and not is_soprano) or _is_malformed_harmony(child):
                        m_el.remove(child)
                        removed += 1
                        continue
                    r_el = child.find("root")
                    k_el = child.find("kind")
                    b_el = child.find("bass")
                    sig = (
                        round(offset_div, 3),
                        (r_el.findtext("root-step") or "").strip().upper() if r_el is not None else "",
                        (r_el.findtext("root-alter") or "").strip() if r_el is not None else "",
                        (k_el.text or "").strip() if k_el is not None else "",
                        (b_el.findtext("bass-step") or "").strip().upper() if b_el is not None else "",
                    )
                    if sig in seen_sigs:
                        m_el.remove(child)
                        removed += 1
                    else:
                        seen_sigs.add(sig)
    return removed

_FOOTER_CONTEXT_WORDS_RE = re.compile(
    r"\b(?:commercial|permission|reproduced)\b",
    re.IGNORECASE,
)

_UNISON_MARKER_RE = re.compile(r"\b(?:unis(?:on)?\.?|a\s*2|tutti)\b", re.IGNORECASE)


def _is_accompaniment_label(label: str) -> bool:
    low = (label or "").strip().lower()
    return any(kw in low for kw in _ACCOMP_KEYWORDS)


def _extract_pdf_footer_texts(pdf_path: Path | None) -> set[str]:
    """Extract normalized text fragments located in the bottom margin of PDF pages."""
    if pdf_path is None or not pdf_path.exists():
        return set()
    try:
        import pymupdf
    except ImportError:
        return set()

    footer_tokens: set[str] = set()
    doc = pymupdf.open(str(pdf_path))
    try:
        for page in doc:
            page_h = float(page.rect.height or 0.0)
            if page_h <= 0.0:
                continue
            footer_y_threshold = page_h * 0.87
            for block in page.get_text("blocks") or []:
                if len(block) < 5:
                    continue
                y0 = float(block[1])
                text = str(block[4] or "").strip()
                if y0 >= footer_y_threshold and text:
                    for line in text.splitlines():
                        cleaned = re.sub(r"\s+", " ", line).strip()
                        if len(cleaned) >= 4:
                            footer_tokens.add(cleaned.lower())
    except Exception:
        return set()
    finally:
        doc.close()
    return footer_tokens


def _is_footer_or_metadata_text(
    text: str,
    *,
    default_y: float | None = None,
    pdf_footer_texts: set[str] | None = None,
) -> bool:
    """Return True when text is geometric footer content or publication/copyright metadata."""
    cleaned = re.sub(r"\s+", " ", (text or "")).strip()
    if not cleaned:
        return False
    if default_y is not None and default_y < -150.0:
        return True
    if _FOOTER_METADATA_RE.search(cleaned):
        return True
    if _FOOTER_CONTEXT_WORDS_RE.search(cleaned) and (
        (default_y is not None and default_y < -115.0)
        or len(cleaned.split()) >= 3
    ):
        return True
    if pdf_footer_texts:
        low = cleaned.lower()
        for ft in pdf_footer_texts:
            if len(low) >= 4 and (low in ft or ft in low):
                return True
    return False


def _reconstruct_and_filter_part_lyrics(
    root: ET.Element,
    *,
    pdf_footer_texts: set[str] | None = None,
) -> int:
    """Reconstruct multi-note lyric phrases per part/verse and remove footer/credit phrases & sparse bottom-staff pseudo-lyrics."""
    removed = 0
    parts = list(root.findall("part"))
    num_parts = len(parts)

    # Pass 1: per-part, per-verse multi-note phrase reconstruction
    for p_idx, part_el in enumerate(parts):
        is_lower_part = num_parts >= 2 and p_idx >= max(1, num_parts - 2)
        measures = list(part_el.findall("measure"))
        # Group tokens by lyric number
        tokens_by_verse: dict[str, list[dict]] = {}
        for m_idx, m_el in enumerate(measures):
            for note_el in m_el.findall("note"):
                for lyr in note_el.findall("lyric"):
                    v_num = lyr.attrib.get("number") or "1"
                    txt = "".join(t.text or "" for t in lyr.findall("text")).strip()
                    syl = (lyr.findtext("syllabic") or "").strip().lower()
                    raw_y = lyr.attrib.get("default-y")
                    try:
                        dy = float(raw_y) if raw_y is not None else None
                    except ValueError:
                        dy = None
                    tokens_by_verse.setdefault(v_num, []).append(
                        {
                            "note_el": note_el,
                            "lyric_el": lyr,
                            "text": txt,
                            "syllabic": syl,
                            "measure_idx": m_idx,
                            "default_y": dy,
                        }
                    )

        for tok_list in tokens_by_verse.values():
            # Split into contiguous phrase chunks (break on > 2 empty measures)
            chunks: list[list[dict]] = []
            cur_chunk: list[dict] = []
            for tok in tok_list:
                if cur_chunk and tok["measure_idx"] - cur_chunk[-1]["measure_idx"] > 2:
                    chunks.append(cur_chunk)
                    cur_chunk = []
                cur_chunk.append(tok)
            if cur_chunk:
                chunks.append(cur_chunk)

            for chunk in chunks:
                phrase_parts: list[str] = []
                spans: list[tuple[int, int, dict]] = []
                cursor = 0
                prev_joined = False
                for idx, tok in enumerate(chunk):
                    t = tok["text"]
                    if not t:
                        continue
                    if idx > 0 and not prev_joined:
                        phrase_parts.append(" ")
                        cursor += 1
                    clean_tok = t[:-1] if (t.endswith("-") and len(t) > 1 and tok["syllabic"] in ("begin", "middle", "")) else t
                    start = cursor
                    phrase_parts.append(clean_tok)
                    cursor += len(clean_tok)
                    spans.append((start, cursor, tok))
                    prev_joined = tok["syllabic"] in ("begin", "middle") or t.endswith("-")

                phrase = "".join(phrase_parts).strip()
                if not phrase:
                    continue

                is_footer_phrase = _FOOTER_METADATA_RE.search(phrase) is not None
                if not is_footer_phrase and (is_lower_part or len(chunk) <= 6):
                    if _CREDIT_BY_NAME_RE.search(phrase):
                        is_footer_phrase = True
                if not is_footer_phrase and pdf_footer_texts:
                    low_p = re.sub(r"\s+", " ", phrase).lower()
                    for ft in pdf_footer_texts:
                        if len(low_p) >= 6 and (low_p in ft or ft in low_p):
                            is_footer_phrase = True
                            break

                if is_footer_phrase:
                    for _, _, tok in spans:
                        if tok["lyric_el"] in list(tok["note_el"]):
                            tok["note_el"].remove(tok["lyric_el"])
                            removed += 1

    # Pass 2: For multi-part hymnal scores, remove sparse/isolated bottom-staff pseudo-lyrics
    if num_parts >= 2:
        part_lyric_counts: list[int] = [len(p.findall(".//note/lyric")) for p in parts]
        top_count = part_lyric_counts[0]
        if top_count >= 12:
            for p_idx in range(1, num_parts):
                cnt = part_lyric_counts[p_idx]
                if 0 < cnt <= max(4, int(top_count * 0.18)):
                    # Check if confined to lower staff (Tenor/Bass) or final measures / low default-y
                    if p_idx >= 2 or num_parts == 2:
                        for note_el in parts[p_idx].findall(".//note"):
                            for lyr in list(note_el.findall("lyric")):
                                note_el.remove(lyr)
                                removed += 1
    return removed


def _collect_part_note_positions(
    part_el: ET.Element,
) -> list[tuple[int, float, float, ET.Element, bool]]:
    """Return [(measure_idx, onset_whole, end_whole, note_el, is_rest)] in musical order for a part."""
    items: list[tuple[int, float, float, ET.Element, bool]] = []
    divisions = 1.0
    for m_idx, m_el in enumerate(part_el.findall("measure")):
        offset_div = 0.0
        last_start_div = 0.0
        for child in list(m_el):
            tag = child.tag.lower()
            if tag == "attributes":
                div_txt = child.findtext("divisions")
                if div_txt:
                    try:
                        d = float(div_txt)
                        if d > 0:
                            divisions = d
                    except ValueError:
                        pass
            elif tag == "backup":
                dur_txt = child.findtext("duration")
                if dur_txt:
                    try:
                        offset_div = max(0.0, offset_div - float(dur_txt))
                    except ValueError:
                        pass
            elif tag == "forward":
                dur_txt = child.findtext("duration")
                if dur_txt:
                    try:
                        offset_div += float(dur_txt)
                    except ValueError:
                        pass
            elif tag == "note":
                is_chord = child.find("chord") is not None
                is_grace = child.find("grace") is not None
                is_rest = child.find("rest") is not None
                start_div = last_start_div if is_chord else offset_div
                dur_div = 0.0
                if not is_grace:
                    try:
                        dur_div = max(0.0, float(child.findtext("duration") or 0.0))
                    except ValueError:
                        dur_div = 0.0
                onset_whole = round(start_div / (divisions * 4.0), 4)
                end_whole = round((start_div + dur_div) / (divisions * 4.0), 4)
                if not is_chord:
                    items.append((m_idx, onset_whole, end_whole, child, is_rest))
                if not is_chord and not is_grace:
                    last_start_div = offset_div
                    if dur_div > 0:
                        offset_div += dur_div
    return items


def _consolidate_satb_lyrics_to_soprano(root: ET.Element) -> int:
    """Consolidate split/duplicated SATB lyrics onto Soprano while preserving genuine independent vocal texts."""
    parts = list(root.findall("part"))
    if len(parts) < 2:
        return 0

    part_names: dict[str, str] = {}
    for sp in root.findall("./part-list/score-part"):
        pid = sp.attrib.get("id", "")
        pname = (sp.findtext("part-name") or "").strip()
        part_names[pid] = pname

    vocal_part_indices: list[int] = []
    soprano_idx: int | None = None
    for idx, p in enumerate(parts):
        pname = part_names.get(p.attrib.get("id", ""), "").lower()
        if _is_accompaniment_label(pname):
            continue
        vocal_part_indices.append(idx)
        if soprano_idx is None and ("soprano" in pname or pname == "sop"):
            soprano_idx = idx
    if soprano_idx is None:
        if not vocal_part_indices:
            return 0
        soprano_idx = vocal_part_indices[0]

    other_indices = [i for i in vocal_part_indices if i != soprano_idx]
    if not other_indices:
        return 0

    sop_items = _collect_part_note_positions(parts[soprano_idx])
    sop_non_rest: list[tuple[int, float, float, ET.Element]] = []
    sop_notes_by_pos: dict[tuple[int, float], ET.Element] = {}
    sop_notes_by_measure: dict[int, list[tuple[float, float, ET.Element]]] = {}
    for m_idx, onset, end_w, n_el, is_rest in sop_items:
        if not is_rest:
            sop_non_rest.append((m_idx, onset, m_idx + onset, n_el))
            sop_notes_by_pos[(m_idx, onset)] = n_el
            sop_notes_by_measure.setdefault(m_idx, []).append((onset, end_w, n_el))

    if not sop_non_rest:
        return 0

    def _has_verse_on_note(note_el: ET.Element, v_num: str) -> bool:
        return any((sl.attrib.get("number") or "1") == v_num for sl in note_el.findall("lyric"))

    def _find_nearest_sop_note(m_idx: int, onset: float, v_num: str) -> tuple[ET.Element, bool]:
        if (m_idx, onset) in sop_notes_by_pos:
            return sop_notes_by_pos[(m_idx, onset)], True
        measure_notes = sop_notes_by_measure.get(m_idx, [])
        for s_onset, _, n_el in measure_notes:
            if abs(s_onset - onset) <= 0.025:
                return n_el, True
        # Immediately preceding Soprano note still sustaining through passing-tone onset with empty lyric slot
        sustaining = [
            (s_onset, n_el)
            for s_onset, s_end, n_el in measure_notes
            if s_onset < onset - 1e-4 and onset < s_end - 1e-4 and not _has_verse_on_note(n_el, v_num)
        ]
        if sustaining:
            sustaining.sort(key=lambda x: x[0], reverse=True)
            return sustaining[0][1], False
        # Nearest note in same measure without this verse
        free_in_measure = [
            (abs(s_onset - onset), n_el)
            for s_onset, _, n_el in measure_notes
            if not _has_verse_on_note(n_el, v_num)
        ]
        if free_in_measure:
            free_in_measure.sort(key=lambda x: x[0])
            return free_in_measure[0][1], False
        # Nearest Soprano note across adjacent measures without this verse
        target_global = m_idx + onset
        free_global = [
            (abs(g_pos - target_global), n_el)
            for _, _, g_pos, n_el in sop_non_rest
            if not _has_verse_on_note(n_el, v_num)
        ]
        if free_global:
            free_global.sort(key=lambda x: x[0])
            return free_global[0][1], False
        # Fallback: nearest Soprano note in same measure or globally
        if measure_notes:
            closest = min(measure_notes, key=lambda x: abs(x[0] - onset))
            return closest[2], False
        closest_global = min(sop_non_rest, key=lambda x: abs(x[2] - target_global))
        return closest_global[3], False

    # Gather all lyrics per part & verse
    sop_lyrics_by_verse: dict[str, dict[tuple[int, float], str]] = {}
    for m_idx, onset, _, n_el, _ in sop_items:
        for lyr in n_el.findall("lyric"):
            v_num = lyr.attrib.get("number") or "1"
            txt = "".join(t.text or "" for t in lyr.findall("text")).strip()
            sop_lyrics_by_verse.setdefault(v_num, {})[(m_idx, onset)] = txt

    consolidated_count = 0
    for other_idx in other_indices:
        other_items = _collect_part_note_positions(parts[other_idx])
        other_by_verse: dict[str, list[tuple[int, float, ET.Element, ET.Element, str]]] = {}
        for m_idx, onset, _, n_el, _ in other_items:
            for lyr in n_el.findall("lyric"):
                v_num = lyr.attrib.get("number") or "1"
                txt = "".join(t.text or "" for t in lyr.findall("text")).strip()
                other_by_verse.setdefault(v_num, []).append((m_idx, onset, n_el, lyr, txt))

        for v_num, entries in other_by_verse.items():
            sop_v = sop_lyrics_by_verse.get(v_num, {})
            overlap_same = 0
            overlap_diff = 0
            for m_idx, onset, _, _, txt in entries:
                # Check if Soprano has a lyric at same position
                sop_txt = sop_v.get((m_idx, onset))
                if sop_txt is None:
                    for (sm, so), st in sop_v.items():
                        if sm == m_idx and abs(so - onset) <= 0.025:
                            sop_txt = st
                            break
                if sop_txt is not None:
                    if sop_txt.lower() == txt.lower():
                        overlap_same += 1
                    else:
                        overlap_diff += 1

            total_overlap = overlap_same + overlap_diff
            # Preserve genuine independent polytextual 2-part vocal scores
            if len(vocal_part_indices) == 2 and total_overlap >= 4 and (overlap_diff / total_overlap) >= 0.4:
                continue

            for m_idx, onset, n_el, lyr, txt in entries:
                sop_note, _ = _find_nearest_sop_note(m_idx, onset, v_num)
                already_on_sop = _has_verse_on_note(sop_note, v_num)
                if not already_on_sop:
                    sop_note.append(deepcopy(lyr))
                    sop_lyrics_by_verse.setdefault(v_num, {})[(m_idx, onset)] = txt
                    consolidated_count += 1
                elif txt:
                    existing_lyr = next(
                        (sl for sl in sop_note.findall("lyric") if (sl.attrib.get("number") or "1") == v_num),
                        None,
                    )
                    existing_txt_el = existing_lyr.find("text") if existing_lyr is not None else None
                    existing_txt = (existing_txt_el.text or "").strip() if existing_txt_el is not None else ""
                    existing_words = existing_txt.lower().split()
                    if (
                        existing_txt_el is not None
                        and existing_txt
                        and existing_txt.lower() != txt.lower()
                        and txt.lower() not in existing_words
                    ):
                        existing_txt_el.text = f"{existing_txt} {txt}"
                n_el.remove(lyr)

    # Sort <lyric> elements by verse number on Soprano notes
    for _, _, _, n_el, _ in sop_items:
        lyrs = list(n_el.findall("lyric"))
        if len(lyrs) > 1:
            for lyr in lyrs:
                n_el.remove(lyr)
            lyrs.sort(key=lambda el: int(el.attrib.get("number") or "1") if (el.attrib.get("number") or "1").isdigit() else 99)
            for lyr in lyrs:
                n_el.append(lyr)

    return consolidated_count


def extract_lyrics_data_from_musicxml(xml_str: str, *, tempo_bpm: float = 100.0) -> dict | None:
    """Extract verse-ordered LyricsData dict from Soprano (default lyric carrier) in MusicXML."""
    if not xml_str or "<score-" not in xml_str:
        return None
    try:
        root = ET.fromstring(xml_str.lstrip("\ufeff").strip())
    except ET.ParseError:
        return None

    parts = list(root.findall("part"))
    if not parts:
        return None
    sop_part = parts[0]
    for sp in root.findall("./part-list/score-part"):
        pid = sp.attrib.get("id", "")
        pname = (sp.findtext("part-name") or "").lower()
        if "soprano" in pname or pname == "sop":
            match = next((p for p in parts if p.attrib.get("id", "") == pid), None)
            if match is not None:
                sop_part = match
                break

    by_verse: dict[str, list[tuple[str, str]]] = {}
    for lyr in sop_part.findall(".//note/lyric"):
        v_num = lyr.attrib.get("number") or "1"
        txt = "".join(t.text or "" for t in lyr.findall("text")).strip()
        syl = (lyr.findtext("syllabic") or "").strip().lower()
        if txt:
            by_verse.setdefault(v_num, []).append((txt, syl))

    if not by_verse:
        return None

    verse_lines: list[str] = []
    segments: list[dict] = []
    sec_cursor = 0.0
    for idx, v_num in enumerate(sorted(by_verse.keys(), key=lambda k: int(k) if k.isdigit() else 99)):
        tokens = by_verse[v_num]
        words: list[str] = []
        cur_word = ""
        for txt, syl in tokens:
            if syl in ("begin", "middle"):
                cur_word += txt[:-1] if txt.endswith("-") else txt
            elif syl == "end":
                cur_word += txt
                words.append(cur_word)
                cur_word = ""
            else:
                if cur_word:
                    words.append(cur_word)
                    cur_word = ""
                words.append(txt)
        if cur_word:
            words.append(cur_word)
        line = " ".join(words).strip()
        if line:
            verse_lines.append(line)
            dur = max(1.0, len(words) * (60.0 / max(20.0, tempo_bpm)))
            segments.append(
                {
                    "id": f"verse_{v_num}",
                    "text": line,
                    "start_sec": round(sec_cursor, 3),
                    "end_sec": round(sec_cursor + dur, 3),
                    "confidence": 1.0,
                    "needs_review": False,
                    "reviewed": True,
                    "edited": False,
                    "words": [],
                }
            )
            sec_cursor += dur

    if not verse_lines:
        return None
    return {
        "text": "\n".join(verse_lines),
        "segments": segments,
        "source_used": "manual",
        "has_word_timestamps": False,
    }


def _strip_artificial_pickup_padding(root: ET.Element) -> bool:
    """Remove artificial trailing rest padding from an incomplete opening pickup measure across all parts."""
    parts = root.findall("part")
    if not parts:
        return False

    def _duration_type_for_divs(divs_val: float, divisions: float) -> tuple[str, bool]:
        ql = divs_val / max(1.0, divisions)
        table = [
            (4.0, "whole", False),
            (3.0, "half", True),
            (2.0, "half", False),
            (1.5, "quarter", True),
            (1.0, "quarter", False),
            (0.75, "eighth", True),
            (0.5, "eighth", False),
            (0.375, "16th", True),
            (0.25, "16th", False),
        ]
        for target_ql, ntype, dotted in table:
            if abs(ql - target_ql) <= 0.02:
                return ntype, dotted
        return "quarter", False

    part_infos: list[dict] = []
    has_pickup_marker = False
    nominal_ql: float | None = None

    for part_el in parts:
        measures = part_el.findall("measure")
        if not measures:
            continue
        m0 = measures[0]
        m_num = (m0.attrib.get("number") or "").strip()
        m_imp = (m0.attrib.get("implicit") or "").strip().lower()
        if m_num == "0" or m_imp == "yes":
            has_pickup_marker = True

        divisions = 1.0
        beats = 4
        beat_type = 4
        attr_el = m0.find("attributes")
        if attr_el is not None:
            div_el = attr_el.find("divisions")
            if div_el is not None and div_el.text:
                try:
                    divisions = max(1.0, float(div_el.text.strip()))
                except ValueError:
                    pass
            time_el = attr_el.find("time")
            if time_el is not None:
                b_el = time_el.find("beats")
                bt_el = time_el.find("beat-type")
                try:
                    if b_el is not None and b_el.text:
                        beats = max(1, int(b_el.text.strip()))
                    if bt_el is not None and bt_el.text:
                        beat_type = max(1, int(bt_el.text.strip()))
                except ValueError:
                    pass

        part_nominal_ql = beats * (4.0 / beat_type)
        if nominal_ql is None:
            nominal_ql = part_nominal_ql

        cursor = 0.0
        last_note_start = 0.0
        last_pitched_end_divs = 0.0
        max_end_divs = 0.0
        padding_candidates: list[tuple[ET.Element, float, float, float, bool]] = []

        for child in list(m0):
            tag = child.tag.split("}")[-1]
            if tag == "note":
                if child.find("grace") is not None:
                    continue
                dur_el = child.find("duration")
                dur = 0.0
                if dur_el is not None and dur_el.text:
                    try:
                        dur = max(0.0, float(dur_el.text.strip()))
                    except ValueError:
                        dur = 0.0
                is_chord = child.find("chord") is not None
                if is_chord:
                    start = last_note_start
                    end = start + dur
                else:
                    start = cursor
                    end = start + dur
                    cursor = end
                    last_note_start = start
                max_end_divs = max(max_end_divs, end)
                if child.find("rest") is not None:
                    padding_candidates.append((child, start, end, dur, True))
                else:
                    last_pitched_end_divs = max(last_pitched_end_divs, end)
            elif tag == "backup":
                dur_el = child.find("duration")
                if dur_el is not None and dur_el.text:
                    try:
                        cursor = max(0.0, cursor - float(dur_el.text.strip()))
                    except ValueError:
                        pass
            elif tag == "forward":
                dur_el = child.find("duration")
                dur = 0.0
                if dur_el is not None and dur_el.text:
                    try:
                        dur = max(0.0, float(dur_el.text.strip()))
                    except ValueError:
                        dur = 0.0
                start = cursor
                end = start + dur
                cursor = end
                max_end_divs = max(max_end_divs, end)
                padding_candidates.append((child, start, end, dur, False))

        part_infos.append(
            {
                "m0": m0,
                "divisions": divisions,
                "last_pitched_end_ql": last_pitched_end_divs / divisions,
                "total_ql": max_end_divs / divisions,
                "candidates": padding_candidates,
            }
        )

    if not has_pickup_marker or not part_infos or nominal_ql is None:
        return False

    effective_pickup_ql = max(info["last_pitched_end_ql"] for info in part_infos)
    if effective_pickup_ql <= 1e-4 or effective_pickup_ql >= nominal_ql - 1e-4:
        return False

    has_trailing_padding = any(
        info["total_ql"] >= nominal_ql - 1e-4 and info["total_ql"] > effective_pickup_ql + 1e-4
        for info in part_infos
    )
    if not has_trailing_padding:
        return False

    changed = False
    for info in part_infos:
        m0: ET.Element = info["m0"]
        divisions: float = info["divisions"]
        cutoff_divs = effective_pickup_ql * divisions
        m0.set("implicit", "yes")

        for el, start, end, _dur, is_rest in info["candidates"]:
            if start >= cutoff_divs - 1e-4:
                m0.remove(el)
                changed = True
            elif end > cutoff_divs + 1e-4:
                new_dur = max(0.0, cutoff_divs - start)
                dur_el = el.find("duration")
                if dur_el is not None:
                    rounded = int(round(new_dur))
                    dur_el.text = str(rounded if abs(new_dur - rounded) < 1e-4 else round(new_dur, 4))
                if is_rest:
                    ntype, dotted = _duration_type_for_divs(new_dur, divisions)
                    type_el = el.find("type")
                    if type_el is None:
                        type_el = ET.SubElement(el, "type")
                    type_el.text = ntype
                    for d_el in list(el.findall("dot")):
                        el.remove(d_el)
                    if dotted:
                        ET.SubElement(el, "dot")
                changed = True

    return changed


_KEY_SIGNATURE_TO_FIFTHS: dict[str, int] = {
    "c major": 0, "c": 0, "a minor": 0, "am": 0,
    "g major": 1, "g": 1, "e minor": 1, "em": 1,
    "d major": 2, "d": 2, "b minor": 2, "bm": 2,
    "a major": 3, "a": 3, "f# minor": 3, "f#m": 3,
    "e major": 4, "e": 4, "c# minor": 4, "c#m": 4,
    "b major": 5, "b": 5, "g# minor": 5, "g#m": 5,
    "f# major": 6, "f#": 6, "d# minor": 6, "d#m": 6,
    "c# major": 7, "c#": 7, "a# minor": 7, "a#m": 7,
    "f major": -1, "f": -1, "d minor": -1, "dm": -1,
    "bb major": -2, "bb": -2, "g minor": -2, "gm": -2,
    "eb major": -3, "eb": -3, "c minor": -3, "cm": -3,
    "ab major": -4, "ab": -4, "f minor": -4, "fm": -4,
    "db major": -5, "db": -5, "bb minor": -5, "bbm": -5,
    "gb major": -6, "gb": -6, "eb minor": -6, "ebm": -6,
    "cb major": -7, "cb": -7, "ab minor": -7, "abm": -7,
}


def _key_signature_to_fifths(key_sig: str | None) -> int | None:
    if not key_sig:
        return None
    normalized = " ".join(key_sig.strip().lower().replace("♭", "b").replace("♯", "#").split())
    return _KEY_SIGNATURE_TO_FIFTHS.get(normalized)


def _ensure_key_and_measure1_attributes(
    root: ET.Element,
    *,
    fallback_key_signature: str | None = None,
) -> None:
    """Ensure measure 1 of every part has divisions, key/fifths, time, and clef without overwriting valid keys."""
    fallback_fifths = _key_signature_to_fifths(fallback_key_signature)
    for part in root.findall("part"):
        measures = part.findall("measure")
        if not measures:
            continue
        m1 = measures[0]
        attrs = m1.find("attributes")
        if attrs is None:
            attrs = ET.Element("attributes")
            m1.insert(0, attrs)

        if attrs.find("divisions") is None:
            div_el = ET.SubElement(attrs, "divisions")
            div_el.text = "4"

        key_el = attrs.find("key")
        if key_el is None:
            key_el = ET.SubElement(attrs, "key")
        fifths_el = key_el.find("fifths")
        if fifths_el is None or not (fifths_el.text or "").strip():
            if fifths_el is None:
                fifths_el = ET.SubElement(key_el, "fifths")
            fifths_el.text = str(fallback_fifths if fallback_fifths is not None else 0)

        if attrs.find("time") is None:
            time_el = ET.SubElement(attrs, "time")
            ET.SubElement(time_el, "beats").text = "4"
            ET.SubElement(time_el, "beat-type").text = "4"

        if attrs.find("clef") is None:
            clef_el = ET.SubElement(attrs, "clef")
            ET.SubElement(clef_el, "sign").text = "G"
            ET.SubElement(clef_el, "line").text = "2"


def sanitize_omr_musicxml(
    xml_str: str,
    *,
    pdf_path: Path | None = None,
    fallback_key_signature: str | None = None,
) -> tuple[str, list[str]]:
    """Remove footer/copyright pseudo-lyrics, normalize NFKC ligatures, preserve key/measure1 attrs, and flag cue notes."""
    import unicodedata

    warnings: list[str] = []
    if not xml_str or "<score-" not in xml_str:
        return xml_str, warnings

    pdf_footers = _extract_pdf_footer_texts(pdf_path)
    try:
        root = ET.fromstring(xml_str)
    except ET.ParseError:
        return xml_str, warnings

    removed_lyrics = 0
    cue_notes_tagged = 0

    for note_el in root.findall(".//note"):
        # Strip individual footer/copyright text mistakenly attached as <lyric>
        for lyr in list(note_el.findall("lyric")):
            for t in lyr.findall("text"):
                if t.text:
                    t.text = unicodedata.normalize("NFKC", t.text)
            txt = "".join(t.text or "" for t in lyr.findall("text")).strip()
            raw_y = lyr.attrib.get("default-y")
            try:
                dy = float(raw_y) if raw_y is not None else None
            except ValueError:
                dy = None
            has_extend = lyr.find("extend") is not None
            if _is_footer_or_metadata_text(txt, default_y=dy, pdf_footer_texts=pdf_footers) or _is_section_label_text(txt) or (not txt and not has_extend):
                note_el.remove(lyr)
                removed_lyrics += 1

        # Tag cue notes explicitly via editorial/notehead size or <cue/> so they do not distort main rhythm
        is_cue = note_el.find("cue") is not None
        type_el = note_el.find("type")
        nh_el = note_el.find("notehead")
        if (type_el is not None and type_el.attrib.get("size") == "cue") or (
            nh_el is not None and nh_el.attrib.get("size") == "cue"
        ):
            is_cue = True
        if is_cue:
            cue_notes_tagged += 1
            if note_el.find("cue") is None:
                ET.SubElement(note_el, "cue")
            if type_el is None:
                type_el = ET.SubElement(note_el, "type")
                type_el.text = "quarter"
            type_el.attrib["size"] = "cue"

    # Reconstruct multi-note lyric phrases & clean sparse bottom-staff pseudo-lyrics
    removed_lyrics += _reconstruct_and_filter_part_lyrics(root, pdf_footer_texts=pdf_footers)
    # Consolidate split/duplicated SATB lyrics onto Soprano
    _sanitize_satb_harmonies(root)
    _consolidate_satb_lyrics_to_soprano(root)
    _strip_artificial_pickup_padding(root)
    _ensure_key_and_measure1_attributes(root, fallback_key_signature=fallback_key_signature)

    # Strip footer <credit-words> / <words> far below the lowest staff if needed
    for dir_el in root.findall(".//direction"):
        words_el = dir_el.find(".//words")
        if words_el is not None and words_el.text:
            raw_y = words_el.attrib.get("default-y")
            try:
                dy = float(raw_y) if raw_y is not None else None
            except ValueError:
                dy = None
            if dy is not None and dy < -180.0 and _FOOTER_METADATA_RE.search(words_el.text):
                words_el.text = ""

    if removed_lyrics > 0:
        warnings.append(f"Filtered {removed_lyrics} footer/copyright pseudo-lyric element(s) from OMR output.")
    if cue_notes_tagged > 0:
        warnings.append(f"Preserved {cue_notes_tagged} cue note(s) without distorting main SATB rhythm.")

    return ET.tostring(root, encoding="unicode"), warnings


def _is_cue_or_grace(el: music21.Music21Object) -> bool:
    if getattr(el, "duration", None) is not None and getattr(el.duration, "isGrace", False):
        return True
    style = getattr(el, "style", None)
    if style is not None and getattr(style, "noteSize", None) == "cue":
        return True
    notehead_size = getattr(el, "noteheadSize", None)
    if notehead_size == "cue":
        return True
    editorial = getattr(el, "editorial", None)
    if editorial is not None and getattr(editorial, "misc", None) and editorial.misc.get("is_cue"):
        return True
    return False


def _clone_note_for_voice(
    el: music21.note.Note,
    *,
    offset: float,
    keep_lyrics: bool = True,
) -> music21.note.Note:
    import music21

    cloned = music21.note.Note(el.pitch, quarterLength=float(el.quarterLength))
    cloned.offset = offset
    if el.tie is not None:
        cloned.tie = music21.tie.Tie(el.tie.type)
    if keep_lyrics and el.lyrics:
        cloned.lyrics = [deepcopy(lyr) for lyr in el.lyrics]
    if el.expressions:
        cloned.expressions = [deepcopy(exp) for exp in el.expressions]
    if getattr(el, "duration", None) is not None and el.duration.isGrace:
        cloned = cloned.getGrace()
        cloned.offset = offset
    return cloned


def _mean_midi(elements: list[music21.Music21Object]) -> float | None:
    import music21

    pitches: list[int] = []
    for el in elements:
        if isinstance(el, music21.note.Note):
            pitches.append(int(el.pitch.midi))
        elif isinstance(el, music21.chord.Chord):
            pitches.extend(int(p.midi) for p in el.pitches)
    return (sum(pitches) / len(pitches)) if pitches else None


def _reconcile_measure_subvoices(
    m_voices: list[music21.stream.Voice],
    upper_center: float,
    lower_center: float,
) -> tuple[list[music21.Music21Object], list[music21.Music21Object]]:
    """Reconcile 2+ OMR sub-voices in a measure into clean upper and lower voice streams."""
    import music21

    # Extract (mean_pitch, items) for each non-empty sub-voice
    voice_items: list[tuple[float, list[music21.Music21Object]]] = []
    for v in m_voices:
        items = [el for el in v.notesAndRests if not _is_cue_or_grace(el)]
        if not items:
            continue
        mp = _mean_midi(items)
        voice_items.append((mp if mp is not None else (upper_center + lower_center) / 2.0, items))

    if not voice_items:
        return [], []
    if len(voice_items) == 1:
        return voice_items[0][1], []

    if len(voice_items) == 2:
        (mp0, items0), (mp1, items1) = voice_items
        # Order by simultaneous pitch comparison first, falling back to mean pitch
        sim_diffs: list[float] = []
        by_off1 = {round(float(el.offset), 3): el for el in items1 if not isinstance(el, music21.note.Rest)}
        for el0 in items0:
            if isinstance(el0, music21.note.Rest):
                continue
            el1 = by_off1.get(round(float(el0.offset), 3))
            if el1 is not None:
                p0 = max(int(p.midi) for p in (el0.pitches if isinstance(el0, music21.chord.Chord) else [el0.pitch]))
                p1 = min(int(p.midi) for p in (el1.pitches if isinstance(el1, music21.chord.Chord) else [el1.pitch]))
                sim_diffs.append(p0 - p1)
        if sim_diffs:
            return (items0, items1) if (sum(sim_diffs) >= 0) else (items1, items0)
        return (items0, items1) if mp0 >= mp1 else (items1, items0)

    # >2 OMR sub-voices: merge non-overlapping fragments into upper or lower by continuity
    voice_items.sort(key=lambda x: x[0], reverse=True)
    upper: list[music21.Music21Object] = []
    lower: list[music21.Music21Object] = []
    upper_spans: list[tuple[float, float]] = []
    lower_spans: list[tuple[float, float]] = []

    def _overlaps(spans: list[tuple[float, float]], s: float, e: float) -> bool:
        return any(max(s, a) < min(e, b) - 1e-3 for a, b in spans)

    for mp, items in voice_items:
        d_up = abs(mp - upper_center)
        d_lo = abs(mp - lower_center)
        prefer_upper = d_up <= d_lo
        for el in items:
            s = float(el.offset)
            e = s + max(0.0, float(el.quarterLength))
            if prefer_upper and not _overlaps(upper_spans, s, e):
                upper.append(el)
                if not isinstance(el, music21.note.Rest):
                    upper_spans.append((s, e))
            elif not _overlaps(lower_spans, s, e):
                lower.append(el)
                if not isinstance(el, music21.note.Rest):
                    lower_spans.append((s, e))
            elif not _overlaps(upper_spans, s, e):
                upper.append(el)
                if not isinstance(el, music21.note.Rest):
                    upper_spans.append((s, e))
    upper.sort(key=lambda x: float(x.offset))
    lower.sort(key=lambda x: float(x.offset))
    return upper, lower


def _has_rest_covering(items: list[music21.Music21Object], offset: float) -> bool:
    import music21

    for el in items:
        if isinstance(el, music21.note.Rest):
            s = float(el.offset)
            e = s + float(el.quarterLength)
            if s - 1e-3 <= offset < e - 1e-3:
                return True
    return False


def _has_note_covering(items: list[music21.Music21Object], offset: float) -> bool:
    import music21

    for el in items:
        if not isinstance(el, music21.note.Rest):
            s = float(el.offset)
            e = s + max(0.0625, float(el.quarterLength))
            if s - 1e-3 <= offset < e - 1e-3:
                return True
    return False


def _split_shared_staff_to_two_parts(
    part: music21.stream.Part,
    *,
    is_treble: bool,
) -> tuple[music21.stream.Part, music21.stream.Part] | None:
    """Separate a 2-voice choral staff (SA or TB) into upper & lower Parts with measure/tie/unison continuity."""
    import music21

    measures = list(part.getElementsByClass(music21.stream.Measure))
    if not measures:
        return None

    # Check whether this staff actually represents 2 voices (multi-voice measures or homophonic chords)
    multi_voice_measures = sum(1 for m in measures if len(list(m.voices)) >= 2)
    chord_notes = [
        el for el in part.recurse().notes
        if isinstance(el, music21.chord.Chord) and len(el.pitches) >= 2 and not _is_cue_or_grace(el)
    ]
    total_not_rest = [el for el in part.recurse().notes if not _is_cue_or_grace(el)]
    has_two_voice_evidence = multi_voice_measures >= 1 or (
        len(total_not_rest) > 0 and len(chord_notes) >= max(1, int(len(total_not_rest) * 0.12))
    )
    if not has_two_voice_evidence:
        return None

    p_upper = music21.stream.Part()
    p_lower = music21.stream.Part()

    upper_history: list[int] = []
    lower_history: list[int] = []
    default_u = 69.0 if is_treble else 57.0
    default_l = 62.0 if is_treble else 48.0

    for m_idx, m in enumerate(measures):
        u_center = (sum(upper_history[-6:]) / len(upper_history[-6:])) if upper_history else default_u
        l_center = (sum(lower_history[-6:]) / len(lower_history[-6:])) if lower_history else default_l

        m_u = music21.stream.Measure(number=m.number)
        m_l = music21.stream.Measure(number=m.number)

        # Copy measure-level attributes (clef, time sig, key sig, metronome, barlines, directions)
        has_unison_marker = False
        for el in m:
            if isinstance(el, (music21.clef.Clef, music21.meter.TimeSignature, music21.key.KeySignature, music21.tempo.MetronomeMark)):
                m_u.insert(float(el.offset), deepcopy(el))
                m_l.insert(float(el.offset), deepcopy(el))
            elif isinstance(el, music21.expressions.TextExpression):
                if _UNISON_MARKER_RE.search(el.content or ""):
                    has_unison_marker = True
                m_u.insert(float(el.offset), deepcopy(el))
                m_l.insert(float(el.offset), deepcopy(el))

        m_voices = list(m.voices)
        if len(m_voices) >= 2:
            raw_u, raw_l = _reconcile_measure_subvoices(m_voices, u_center, l_center)
            # Insert notes/rests and fill confirmed unison gaps where one voice dropped out without a rest
            for el in raw_u:
                off = float(el.offset)
                m_u.insert(off, deepcopy(el))
                if isinstance(el, music21.note.Note):
                    upper_history.append(int(el.pitch.midi))
                    if not _has_note_covering(raw_l, off) and not _has_rest_covering(raw_l, off):
                        # Confirmed unison if counterpart voice was active nearby and pitch is in shared range
                        if (has_unison_marker or (lower_history and abs(int(el.pitch.midi) - l_center) <= 14)):
                            m_l.insert(off, _clone_note_for_voice(el, offset=off, keep_lyrics=False))
                            lower_history.append(int(el.pitch.midi))
                elif isinstance(el, music21.chord.Chord) and el.pitches:
                    upper_history.append(max(int(p.midi) for p in el.pitches))

            for el in raw_l:
                off = float(el.offset)
                m_l.insert(off, deepcopy(el))
                if isinstance(el, music21.note.Note):
                    lower_history.append(int(el.pitch.midi))
                    if not _has_note_covering(raw_u, off) and not _has_rest_covering(raw_u, off):
                        if (has_unison_marker or (upper_history and abs(int(el.pitch.midi) - u_center) <= 14)):
                            m_u.insert(off, _clone_note_for_voice(el, offset=off, keep_lyrics=False))
                            upper_history.append(int(el.pitch.midi))
                elif isinstance(el, music21.chord.Chord) and el.pitches:
                    lower_history.append(min(int(p.midi) for p in el.pitches))
        else:
            # Single voice or unvoiced measure
            src_items = (
                list(m_voices[0].notesAndRests)
                if len(m_voices) == 1
                else list(m.notesAndRests)
            )
            # Determine if surrounding measures show active 2-voice continuity
            has_context_continuity = bool(upper_history and lower_history) or (m_idx < len(measures) - 1)
            for el in src_items:
                if _is_cue_or_grace(el):
                    continue
                off = float(el.offset)
                if isinstance(el, music21.note.Rest):
                    m_u.insert(off, deepcopy(el))
                    m_l.insert(off, deepcopy(el))
                elif isinstance(el, music21.chord.Chord) and len(el.pitches) >= 2:
                    sorted_p = sorted(el.pitches, key=lambda p: p.midi)
                    n_hi = music21.note.Note(sorted_p[-1], quarterLength=float(el.quarterLength))
                    n_lo = music21.note.Note(sorted_p[0], quarterLength=float(el.quarterLength))
                    if el.tie is not None:
                        n_hi.tie = music21.tie.Tie(el.tie.type)
                        n_lo.tie = music21.tie.Tie(el.tie.type)
                    if el.expressions:
                        n_hi.expressions = [deepcopy(exp) for exp in el.expressions]
                        n_lo.expressions = [deepcopy(exp) for exp in el.expressions]
                    if el.lyrics:
                        n_hi.lyrics = [deepcopy(lyr) for lyr in el.lyrics]
                    m_u.insert(off, n_hi)
                    # Preserve intermediate notes on 3+ pitch chords without discarding harmony
                    if len(sorted_p) >= 3:
                        mid_pitches = sorted_p[:-1]
                        c_lo = music21.chord.Chord(mid_pitches, quarterLength=float(el.quarterLength))
                        if el.tie is not None:
                            c_lo.tie = music21.tie.Tie(el.tie.type)
                        if el.expressions:
                            c_lo.expressions = [deepcopy(exp) for exp in el.expressions]
                        m_l.insert(off, c_lo)
                    else:
                        m_l.insert(off, n_lo)
                    upper_history.append(int(sorted_p[-1].midi))
                    lower_history.append(int(sorted_p[0].midi))
                elif isinstance(el, music21.note.Note):
                    pmidi = int(el.pitch.midi)
                    # Confirm unison when context continuity holds and pitch sits in shared choral range
                    in_shared_range = abs(pmidi - u_center) <= 15 and abs(pmidi - l_center) <= 15
                    if has_unison_marker or (has_context_continuity and in_shared_range):
                        m_u.insert(off, _clone_note_for_voice(el, offset=off, keep_lyrics=True))
                        m_l.insert(off, _clone_note_for_voice(el, offset=off, keep_lyrics=False))
                        upper_history.append(pmidi)
                        lower_history.append(pmidi)
                    elif abs(pmidi - u_center) <= abs(pmidi - l_center):
                        m_u.insert(off, _clone_note_for_voice(el, offset=off, keep_lyrics=True))
                        upper_history.append(pmidi)
                    else:
                        m_l.insert(off, _clone_note_for_voice(el, offset=off, keep_lyrics=True))
                        lower_history.append(pmidi)

        p_upper.append(m_u)
        p_lower.append(m_l)

    return p_upper, p_lower


def _extract_part_streams(
    m21_score: music21.stream.Score,
    *,
    satb_mode: str = "auto_satb",
) -> list[tuple[int, str, str, str | None, list[music21.note.NotRest], bool, music21.stream.Part | None]]:
    """Extract logical voice streams from 4-staff, 2-staff, or piano-accompanied choral MusicXML."""
    import music21

    extracted: list[tuple[int, str, str, str | None, list[music21.note.NotRest], bool, music21.stream.Part | None]] = []
    parts = list(m21_score.parts)
    vocal_part_count = sum(
        1 for p_i, p in enumerate(parts)
        if not _is_accompaniment_label((p.partName or p.id or f"Staff {p_i + 1}").strip())
    )

    for p_idx, part in enumerate(parts):
        label = (part.partName or part.id or f"Staff {p_idx + 1}").strip()
        clef_obj = next(iter(part.recurse().getElementsByClass(music21.clef.Clef)), None)
        clef_name = type(clef_obj).__name__ if clef_obj is not None else "Unknown"
        is_accomp = _is_accompaniment_label(label)

        if satb_mode == "keep_original" or is_accomp:
            all_notes = [el for el in part.recurse().notes if not _is_cue_or_grace(el)]
            extracted.append((p_idx, label, clef_name, None, all_notes, is_accomp, part))
            continue

        if vocal_part_count <= 2:
            is_treble = "Bass" not in clef_name
            split_res = _split_shared_staff_to_two_parts(part, is_treble=is_treble)
            if split_res is not None:
                p_upper, p_lower = split_res
                u_notes = [el for el in p_upper.recurse().notes if not _is_cue_or_grace(el)]
                l_notes = [el for el in p_lower.recurse().notes if not _is_cue_or_grace(el)]
                extracted.append((p_idx, label, clef_name, "1", u_notes, False, p_upper))
                extracted.append((p_idx, label, clef_name, "2", l_notes, False, p_lower))
                continue

        all_notes = [el for el in part.recurse().notes if not _is_cue_or_grace(el)]
        extracted.append((p_idx, label, clef_name, None, all_notes, False, part))

    return extracted


def identify_satb_parts(
    m21_score: music21.stream.Score,
    *,
    satb_mode: str = "auto_satb",
) -> tuple[list[SATBPartAssignment], list[str], bool]:
    """Identify Soprano, Alto, Tenor, Bass parts (and optional Piano Accompaniment) from MusicXML."""
    import music21

    raw_streams = _extract_part_streams(m21_score, satb_mode=satb_mode)
    warnings: list[str] = []
    assignments: list[SATBPartAssignment] = []
    used_voices: set[str] = set()

    if satb_mode == "keep_original":
        for stream_idx, (p_idx, label, clef_name, voice_id, notes, _, _) in enumerate(raw_streams):
            pitches = [
                int(p.midi)
                for el in notes
                for p in (el.pitches if isinstance(el, music21.chord.Chord) else [el.pitch])
            ]
            mean_pitch = round(sum(pitches) / len(pitches), 1) if pitches else None
            assignments.append(
                SATBPartAssignment(
                    part_index=stream_idx,
                    source_label=label,
                    clef=clef_name,
                    voice_id=voice_id,
                    assigned_voice=label or f"Staff {p_idx + 1}",
                    confidence=1.0,
                    uncertain=False,
                    note_count=len(notes),
                    mean_pitch=mean_pitch,
                )
            )
        return assignments, warnings, False

    label_map = {
        "soprano": "Soprano",
        "sop": "Soprano",
        "alto": "Alto",
        "tenor": "Tenor",
        "ten": "Tenor",
        "bass": "Bass",
    }

    vocal_streams = [s for s in raw_streams if not s[5]]

    for stream_idx, (p_idx, label, clef_name, voice_id, notes, is_accomp, _) in enumerate(raw_streams):
        pitches = [
            int(p.midi)
            for el in notes
            for p in (el.pitches if isinstance(el, music21.chord.Chord) else [el.pitch])
        ]
        mean_pitch = round(sum(pitches) / len(pitches), 1) if pitches else None

        if is_accomp:
            assignments.append(
                SATBPartAssignment(
                    part_index=stream_idx,
                    source_label=label,
                    clef=clef_name,
                    voice_id=voice_id,
                    assigned_voice="Piano Accompaniment",
                    confidence=0.95,
                    uncertain=False,
                    note_count=len(notes),
                    mean_pitch=mean_pitch,
                )
            )
            continue

        lbl_lower = label.lower()
        matched_voice: str | None = None
        conf = 0.5
        for kw, v_name in label_map.items():
            if kw in lbl_lower and v_name not in used_voices:
                matched_voice = v_name
                conf = 0.95
                break

        if matched_voice is None:
            vocal_pos = sum(1 for s in raw_streams[:stream_idx] if not s[5])
            if len(vocal_streams) == 4:
                ordered = SATB_VOICES[vocal_pos]
                clef_ok = (
                    (ordered in ("Soprano", "Alto") and "Treble" in clef_name)
                    or (ordered == "Tenor" and ("Bass" in clef_name or "Treble" in clef_name))
                    or (ordered == "Bass" and "Bass" in clef_name)
                )
                matched_voice = ordered
                conf = 0.85 if clef_ok else 0.60
            else:
                if "Bass" in clef_name:
                    cand = "Bass" if (mean_pitch is not None and mean_pitch < 55) else "Tenor"
                else:
                    cand = "Soprano" if (mean_pitch is not None and mean_pitch >= 65) else "Alto"
                if cand in used_voices:
                    cand = next((v for v in SATB_VOICES if v not in used_voices), "Soprano")
                    conf = 0.45
                else:
                    conf = 0.65
                matched_voice = cand

        used_voices.add(matched_voice)
        uncertain = conf < 0.75 or len(notes) == 0
        if uncertain:
            warnings.append(
                f"Part {p_idx + 1} ('{label}', clef={clef_name}) assigned to {matched_voice} with low confidence ({conf:.2f}); please review."
            )
        assignments.append(
            SATBPartAssignment(
                part_index=stream_idx,
                source_label=label,
                clef=clef_name,
                voice_id=voice_id,
                assigned_voice=matched_voice,
                confidence=round(conf, 2),
                uncertain=uncertain,
                note_count=len(notes),
                mean_pitch=mean_pitch,
            )
        )

    if len(vocal_streams) != 4:
        warnings.append(
            f"Detected {len(vocal_streams)} vocal stream(s) instead of 4 SATB parts; verify voice assignments before export."
        )
    needs_review = bool(warnings) or any(a.uncertain for a in assignments)
    return assignments, warnings, needs_review


def _build_separated_satb_musicxml(
    m21_score: music21.stream.Score,
    assignments: list[SATBPartAssignment],
    raw_streams: list[tuple[int, str, str, str | None, list[music21.note.NotRest], bool, music21.stream.Part | None]],
    *,
    title: str,
) -> str:
    """Export cleanly labeled SATB MusicXML preserving measures, rests, ties, fermatas, and lyrics."""
    import music21

    from app.notation.generator import apply_scribasheet_musicxml_branding, clean_score_title

    out_score = music21.stream.Score()
    out_score.metadata = music21.metadata.Metadata()
    clean_title = clean_score_title(title)
    out_score.metadata.title = clean_title
    out_score.metadata.movementName = clean_title
    src_meta = getattr(m21_score, "metadata", None)
    src_composer = getattr(src_meta, "composer", None) if src_meta else None
    if src_composer and str(src_composer).strip().lower() not in ("", "music21"):
        out_score.metadata.composer = str(src_composer).strip()
    else:
        out_score.metadata.composer = "ScribaSheet"
    if src_meta:
        for attr in ("lyricist", "arranger"):
            val = getattr(src_meta, attr, None)
            if val:
                setattr(out_score.metadata, attr, val)

    for a in assignments:
        _, _, _, _, _, _, part_obj = raw_streams[a.part_index]
        if part_obj is None:
            continue
        p_copy = deepcopy(part_obj)
        p_copy.partName = a.assigned_voice
        p_copy.id = a.assigned_voice
        out_score.insert(0, p_copy)

    xml_bytes = music21.musicxml.m21ToXml.GeneralObjectExporter(out_score).parse()
    return apply_scribasheet_musicxml_branding(xml_bytes.decode("utf-8"), title=clean_title)


def musicxml_to_satb_score_data(
    xml_str: str,
    *,
    title: str = "SATB Score",
    tempo_bpm: float | None = None,
    override_assignments: dict[int, str] | None = None,
    extra_warnings: list[str] | None = None,
    satb_mode: str = "auto_satb",
    pdf_path: Path | None = None,
) -> tuple[ScoreData, list[SATBPartAssignment], list[str], bool]:
    """Convert MusicXML into a multi-track SATB ScoreData (with Acoustic Grand Piano default)."""
    import music21

    cleaned_xml, clean_warnings = sanitize_omr_musicxml(xml_str, pdf_path=pdf_path)
    m21_score = music21.converter.parseData(cleaned_xml, format="musicxml")
    assignments, warnings, needs_review = identify_satb_parts(m21_score, satb_mode=satb_mode)
    warnings = [*clean_warnings, *(extra_warnings or []), *warnings]

    if override_assignments:
        for a in assignments:
            if a.part_index in override_assignments and override_assignments[a.part_index] in SATB_VOICE_SET:
                a.assigned_voice = override_assignments[a.part_index]
                a.uncertain = False
                a.confidence = 1.0

    # Extract tempo, time sig, key sig
    mm = next(iter(m21_score.recurse().getElementsByClass(music21.tempo.MetronomeMark)), None)
    resolved_bpm = float(tempo_bpm or (mm.number if mm and mm.number else 100.0))
    sec_per_ql = 60.0 / max(20.0, resolved_bpm)

    ts = next(iter(m21_score.recurse().getElementsByClass(music21.meter.TimeSignature)), None)
    time_sig = ts.ratioString if ts else "4/4"

    ks = next(iter(m21_score.recurse().getElementsByClass(music21.key.KeySignature)), None)
    try:
        key_obj = ks.asKey() if ks is not None else m21_score.analyze("key")
        key_sig = f"{key_obj.tonic.name.replace('-', 'b')} {key_obj.mode}"
    except Exception:
        key_sig = "C major"

    raw_streams = _extract_part_streams(m21_score, satb_mode=satb_mode)
    tracks: list[ScoreTrack] = []
    notes: list[ScoreNote] = []
    max_offset_sec = 0.0

    for a in assignments:
        is_accomp = _is_accompaniment_label(a.assigned_voice) or _is_accompaniment_label(a.source_label)
        clef_type = (
            "grand"
            if is_accomp
            else ("bass" if a.assigned_voice in ("Tenor", "Bass") and "Bass" in a.clef else "treble")
        )
        tracks.append(
            ScoreTrack(
                index=a.part_index,
                name=a.assigned_voice,
                instrument="piano",
                clef=clef_type,
                program=0,  # Acoustic Grand Piano default
            )
        )
        src_p_idx, _, _, _, part_notes, _, part_obj = raw_streams[a.part_index]
        part_ref = part_obj if part_obj is not None else m21_score.parts[min(src_p_idx, len(m21_score.parts) - 1)]

        # Merge tied note chains per pitch so playback sustains across barlines without re-striking
        active_ties: dict[int, ScoreNote] = {}
        for el in part_notes:
            try:
                abs_ql = float(el.getOffsetInHierarchy(part_ref))
            except Exception:
                abs_ql = float(el.offset)
            dur_ql = max(0.0625, float(el.quarterLength))
            onset_sec = round(max(0.0, abs_ql * sec_per_ql), 4)
            offset_sec = round(max(onset_sec + 0.05, (abs_ql + dur_ql) * sec_per_ql), 4)
            max_offset_sec = max(max_offset_sec, offset_sec)

            tie_type = el.tie.type if getattr(el, "tie", None) is not None else None
            pitches = (
                [int(p.midi) for p in el.pitches]
                if isinstance(el, music21.chord.Chord)
                else [int(el.pitch.midi)]
            )
            for p_midi in pitches:
                if tie_type in ("continue", "stop") and p_midi in active_ties:
                    prev_note = active_ties[p_midi]
                    prev_note.offset_sec = max(prev_note.offset_sec, offset_sec)
                    prev_note.raw_offset_sec = prev_note.offset_sec
                    if tie_type == "stop":
                        active_ties.pop(p_midi, None)
                    continue

                sn = ScoreNote(
                    id=uuid.uuid4().hex[:12],
                    pitch_midi=p_midi,
                    onset_sec=onset_sec,
                    offset_sec=offset_sec,
                    raw_onset_sec=onset_sec,
                    raw_offset_sec=offset_sec,
                    velocity=84,
                    confidence=a.confidence,
                    track_index=a.part_index,
                )
                notes.append(sn)
                if tie_type == "start":
                    active_ties[p_midi] = sn
                else:
                    active_ties.pop(p_midi, None)

    notes.sort(key=lambda n: (n.onset_sec, n.track_index, n.pitch_midi))
    analysis_dict: dict = {
        "mode": "satb_pdf",
        "satb": {
            "needs_review": needs_review,
            "warnings": warnings,
            "assignments": [
                {
                    "part_index": a.part_index,
                    "source_label": a.source_label,
                    "clef": a.clef,
                    "voice_id": a.voice_id,
                    "assigned_voice": a.assigned_voice,
                    "confidence": a.confidence,
                    "uncertain": a.uncertain,
                    "note_count": a.note_count,
                    "mean_pitch": a.mean_pitch,
                }
                for a in assignments
            ],
        },
    }
    extracted_lyrics = extract_lyrics_data_from_musicxml(cleaned_xml, tempo_bpm=resolved_bpm)
    if extracted_lyrics:
        analysis_dict["lyrics"] = extracted_lyrics

    score_data = ScoreData(
        title=title,
        tempo_bpm=round(resolved_bpm, 1),
        tempo_estimated=mm is None,
        time_signature=time_sig,
        time_signature_estimated=ts is None,
        key_signature=key_sig,
        key_signature_estimated=ks is None,
        duration_seconds=round(max_offset_sec, 3),
        tracks=tracks,
        notes=notes,
        chords=[],
        analysis=analysis_dict,
    )
    return score_data, assignments, warnings, needs_review


def process_satb_musicxml(
    score_path: Path,
    *,
    title: str = "SATB Score",
    satb_mode: str = "auto_satb",
) -> OMRRecognitionResult:
    """Direct MusicXML/MXL SATB parsing pipeline (skips OMR completely)."""
    import music21

    raw_bytes = score_path.read_bytes()
    validate_musicxml_bytes(raw_bytes, score_path.name)
    try:
        if score_path.name.lower().endswith(".mxl"):
            with zipfile.ZipFile(io.BytesIO(raw_bytes), "r") as zf:
                xml_name = next(
                    (
                        n for n in zf.namelist()
                        if n.lower().endswith((".xml", ".musicxml")) and "meta-inf" not in n.lower()
                    ),
                    None,
                )
                if xml_name is None:
                    raise OMRError("INVALID_MXL", "MXL archive does not contain a MusicXML score.")
                xml_str = zf.read(xml_name).decode("utf-8-sig", errors="replace")
        else:
            xml_str = raw_bytes.decode("utf-8-sig", errors="replace")
        # Verify it parses cleanly with music21
        music21.converter.parseData(xml_str, format="musicxml")
    except OMRError:
        raise
    except Exception as exc:
        raise OMRError("INVALID_MUSICXML", f"Failed to parse MusicXML/MXL score: {exc}") from exc

    score_data, assignments, warnings, needs_review = musicxml_to_satb_score_data(
        xml_str,
        title=title,
        satb_mode=satb_mode,
    )
    if satb_mode == "auto_satb" and len(score_data.tracks) > 0:
        cleaned_xml, _ = sanitize_omr_musicxml(xml_str)
        parsed_clean = music21.converter.parseData(cleaned_xml, format="musicxml")
        raw_streams = _extract_part_streams(parsed_clean, satb_mode=satb_mode)
        labeled_xml = _build_separated_satb_musicxml(parsed_clean, assignments, raw_streams, title=title)
    else:
        labeled_xml = xml_str

    return OMRRecognitionResult(
        musicxml=labeled_xml,
        score_data=score_data,
        page_count=1,
        assignments=assignments,
        warnings=warnings,
        needs_review=needs_review,
    )


def process_satb_pdf(
    pdf_path: Path,
    *,
    title: str = "SATB Score",
    work_dir: Path,
    dpi: int = 250,
    satb_mode: str = "auto_satb",
    omr_engine: str = "auto",
    job_id: str | None = None,
) -> OMRRecognitionResult:
    """Full OMR pipeline: validate PDF -> Audiveris CLI or render+homr -> SATB ScoreData."""
    import music21

    raw_bytes = pdf_path.read_bytes()
    input_kind, detected_fmt = detect_score_input_kind(raw_bytes, pdf_path.name)
    if input_kind == "image":
        logger.warning(
            "Image content (%s) reached process_satb_pdf (%s, job_id=%s); routing to image OMR pipeline.",
            detected_fmt,
            pdf_path.name,
            job_id or "-",
        )
        return process_satb_images(
            [pdf_path],
            title=title,
            work_dir=work_dir,
            satb_mode=satb_mode,
            omr_engine=omr_engine,
            page_filenames=[pdf_path.name],
            job_id=job_id,
        )
    if input_kind == "musicxml":
        return process_satb_musicxml(pdf_path, title=title, satb_mode=satb_mode)

    page_count = validate_pdf_bytes(raw_bytes)
    use_audiveris = omr_engine == "audiveris" or (
        omr_engine == "auto" and find_audiveris_executable() is not None
    )
    if use_audiveris:
        xml_str, omr_warnings = run_audiveris_on_pdf(pdf_path, work_dir / "audiveris")
    else:
        image_paths = render_pdf_pages_to_images(pdf_path, work_dir / "pages", dpi=dpi)
        xml_str, omr_warnings = run_homr_on_images(image_paths)

    score_data, assignments, warnings, needs_review = musicxml_to_satb_score_data(
        xml_str,
        title=title,
        extra_warnings=omr_warnings,
        satb_mode=satb_mode,
        pdf_path=pdf_path,
    )
    cleaned_xml, _ = sanitize_omr_musicxml(xml_str, pdf_path=pdf_path)
    if satb_mode == "auto_satb" and len(score_data.tracks) > 0:
        parsed_clean = music21.converter.parseData(cleaned_xml, format="musicxml")
        raw_streams = _extract_part_streams(parsed_clean, satb_mode=satb_mode)
        out_xml = _build_separated_satb_musicxml(parsed_clean, assignments, raw_streams, title=title)
    else:
        from app.notation.generator import apply_scribasheet_musicxml_branding

        out_xml = apply_scribasheet_musicxml_branding(cleaned_xml, title=title)

    from app.notation.omr_verification import evaluate_omr_structure

    omr_report = evaluate_omr_structure(out_xml, source_available=True)
    score_data.analysis["omr_verification"] = omr_report.model_dump()
    score_data.analysis["omr_source_kind"] = "pdf"

    return OMRRecognitionResult(
        musicxml=out_xml,
        score_data=score_data,
        page_count=page_count,
        assignments=assignments,
        warnings=warnings,
        needs_review=needs_review,
    )


def _finalize_omr_result(
    xml_str: str,
    *,
    title: str,
    page_count: int,
    omr_warnings: list[str],
    satb_mode: str = "auto_satb",
    pdf_path: Path | None = None,
    source_kind: str = "images",
) -> OMRRecognitionResult:
    """Run canonical ScribaSheet OMR cleanup, SATB/staff separation, ScoreData build, and branding."""
    import music21

    score_data, assignments, warnings, needs_review = musicxml_to_satb_score_data(
        xml_str,
        title=title,
        extra_warnings=omr_warnings,
        satb_mode=satb_mode,
        pdf_path=pdf_path,
    )
    cleaned_xml, _ = sanitize_omr_musicxml(xml_str, pdf_path=pdf_path)
    if satb_mode == "auto_satb" and len(score_data.tracks) > 0:
        parsed_clean = music21.converter.parseData(cleaned_xml, format="musicxml")
        raw_streams = _extract_part_streams(parsed_clean, satb_mode=satb_mode)
        out_xml = _build_separated_satb_musicxml(parsed_clean, assignments, raw_streams, title=title)
    else:
        from app.notation.generator import apply_scribasheet_musicxml_branding

        out_xml = apply_scribasheet_musicxml_branding(cleaned_xml, title=title)

    from app.notation.omr_verification import evaluate_omr_structure

    omr_report = evaluate_omr_structure(out_xml, source_available=True)
    score_data.analysis["omr_verification"] = omr_report.model_dump()
    score_data.analysis["omr_source_kind"] = source_kind

    return OMRRecognitionResult(
        musicxml=out_xml,
        score_data=score_data,
        page_count=page_count,
        assignments=assignments,
        warnings=warnings,
        needs_review=needs_review,
    )


def process_satb_images(
    image_paths: list[Path],
    *,
    title: str = "Sheet Music Score",
    work_dir: Path,
    satb_mode: str = "auto_satb",
    omr_engine: str = "auto",
    page_filenames: list[str] | None = None,
    progress_callback: Callable[[int, str, str], None] | None = None,
    cancel_check: Callable[[], None] | None = None,
    job_id: str | None = None,
) -> OMRRecognitionResult:
    """Validate, preprocess, normalize into a 300 DPI PDF, recognize via Audiveris/homr, and return ScoreData + MusicXML."""
    if not image_paths:
        raise OMRError("EMPTY_IMAGE", "No sheet music image files were provided.")

    total_pages = len(image_paths)
    labels = [
        (page_filenames[idx - 1] if page_filenames and idx - 1 < len(page_filenames) else p.name)
        for idx, p in enumerate(image_paths, start=1)
    ]

    use_audiveris = omr_engine == "audiveris" or (
        omr_engine == "auto" and find_audiveris_executable() is not None
    )
    homr_available = find_homr_executable() is not None
    if not use_audiveris and not homr_available:
        raise OMRError(
            "OMR_DEPENDENCY_MISSING",
            "No OMR engine is installed (Audiveris or homr). Configure Audiveris or backend/.venv_omr.",
        )

    prep_dir = work_dir / "preprocessed"
    prep_dir.mkdir(parents=True, exist_ok=True)

    prep_paths: list[Path] = []
    omr_warnings: list[str] = []

    for idx, (src_path, label) in enumerate(zip(image_paths, labels, strict=True), start=1):
        if cancel_check:
            cancel_check()

        # 1. Validate content strictly without mutating original image
        if not src_path.exists():
            raise OMRError(
                "INVALID_IMAGE",
                f"Page {idx} ({label}): downloaded image file is missing on worker.",
            )
        try:
            raw_bytes = src_path.read_bytes()
            validate_sheet_image_bytes(raw_bytes, label, strict_extension_match=False)
        except SheetImageValidationError as exc:
            logger.error(
                "Invalid image content on Page %s (%s, job_id=%s): %s",
                idx,
                label,
                job_id or "-",
                exc.message,
            )
            raise OMRError("INVALID_IMAGE", f"Page {idx} ({label}): {exc.message}") from exc

        if progress_callback:
            pct = 20 + int(12 * (idx - 1) / max(1, total_pages))
            progress_callback(
                pct,
                f"Preprocessing Page {idx}/{total_pages}",
                f"Checking and preparing sheet music image '{label}'.",
            )

        # 2. Conditional OMR preprocessing into work_dir (preserves original file untouched)
        prep_path = prep_dir / f"page_{idx:03d}.png"
        try:
            preprocess_sheet_image_for_omr(
                src_path,
                prep_path,
                job_id=job_id,
                page_index=idx,
            )
        except Exception as exc:
            logger.error(
                "Image preprocessing failed on Page %s (%s, job_id=%s): %s",
                idx,
                label,
                job_id or "-",
                exc,
            )
            raise OMRError(
                "IMAGE_PREPROCESS_FAILED",
                f"Failed to preprocess Page {idx} ({label}) for OMR: {exc}",
            ) from exc
        prep_paths.append(prep_path)

    if cancel_check:
        cancel_check()

    # 3. Normalize ordered preprocessed pages into one 300 DPI multi-page PDF for existing Audiveris pipeline
    if progress_callback:
        progress_callback(
            34,
            "Normalizing Sheet Music Pages",
            f"Building normalized 300 DPI PDF from {total_pages} page image(s).",
        )
    normalized_pdf = work_dir / "normalized_score.pdf"
    try:
        build_normalized_pdf_from_images(prep_paths, normalized_pdf, dpi=300, job_id=job_id)
    except SheetImageValidationError as exc:
        raise OMRError("IMAGE_TO_PDF_FAILED", exc.message) from exc

    if cancel_check:
        cancel_check()

    # 4. Run OMR on normalized PDF (Audiveris primary, per-page homr fallback/mode)
    if use_audiveris:
        if progress_callback:
            progress_callback(
                42,
                "Recognizing Sheet Music (Audiveris)",
                f"Running OMR recognition on {total_pages} normalized sheet music page(s).",
            )
        try:
            aud_xml, aud_warn = run_audiveris_on_pdf(normalized_pdf, work_dir / "audiveris")
            omr_warnings.extend(aud_warn)
            aud_root = _parse_partwise_root(aud_xml)
            if len(aud_root.findall(".//part/measure/note/pitch")) == 0:
                raise OMRError(
                    "AUDIVERIS_RECOGNITION_FAILED",
                    "Audiveris produced MusicXML without recognizable pitched notes from the normalized score.",
                )
            return _finalize_omr_result(
                aud_xml,
                title=title,
                page_count=total_pages,
                omr_warnings=omr_warnings,
                satb_mode=satb_mode,
                pdf_path=normalized_pdf,
            )
        except OMRError as exc:
            if omr_engine == "auto" and homr_available:
                logger.warning(
                    "Audiveris failed on normalized image PDF (job_id=%s): %s; falling back to per-page homr.",
                    job_id or "-",
                    exc.message,
                )
                omr_warnings.append(f"Used homr fallback after Audiveris error: {exc.message}")
            else:
                raise OMRError(
                    "AUDIVERIS_RECOGNITION_FAILED",
                    f"Audiveris could not recognize sheet music from normalized PDF: {exc.message}",
                ) from exc

    # Per-page homr recognition when Audiveris is absent or auto-fallback triggered
    page_xmls: list[str] = []
    for idx, (prep_path, label) in enumerate(zip(prep_paths, labels, strict=True), start=1):
        if cancel_check:
            cancel_check()
        if progress_callback:
            pct = 45 + int(25 * (idx - 1) / max(1, total_pages))
            progress_callback(
                pct,
                f"Recognizing Page {idx}/{total_pages}",
                f"Running OMR on Page {idx} of {total_pages} ({label}).",
            )
        try:
            page_xml, homr_warn = run_homr_on_images([prep_path])
            omr_warnings.extend(homr_warn)
        except OMRError as exc:
            raise OMRError(
                "OMR_PAGE_FAILED",
                f"Could not recognize sheet music on Page {idx} ({label}): {exc.message}",
            ) from exc

        try:
            page_root = _parse_partwise_root(page_xml)
        except Exception as exc:
            raise OMRError(
                "OMR_PAGE_FAILED",
                f"Page {idx} ({label}) produced invalid MusicXML: {exc}",
            ) from exc

        if len(page_root.findall(".//part/measure/note/pitch")) == 0:
            raise OMRError(
                "OMR_PAGE_FAILED",
                f"No musical notes could be recognized on Page {idx} ({label}). Please ensure the image is a clear, readable sheet music score.",
            )
        page_xmls.append(page_xml)

    if cancel_check:
        cancel_check()

    assembled_xml, asm_warnings = assemble_multipage_musicxml(page_xmls, page_labels=labels)
    omr_warnings.extend(asm_warnings)

    return _finalize_omr_result(
        assembled_xml,
        title=title,
        page_count=total_pages,
        omr_warnings=omr_warnings,
        satb_mode=satb_mode,
        pdf_path=normalized_pdf,
    )
