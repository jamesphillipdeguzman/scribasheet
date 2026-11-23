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
from copy import deepcopy
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING

from pypdf import PdfReader

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


def run_audiveris_on_pdf(pdf_path: Path, out_dir: Path, *, timeout: int = 300) -> tuple[str, list[str]]:
    """Run Audiveris CLI batch OMR on a PDF and return MusicXML string + warnings."""
    import music21

    aud_bin = find_audiveris_executable()
    if aud_bin is None:
        raise OMRError("OMR_DEPENDENCY_MISSING", "Audiveris CLI is not installed.")

    out_dir.mkdir(parents=True, exist_ok=True)
    cmd = [str(aud_bin), "-batch", "-export", "-output", str(out_dir), str(pdf_path)]
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


def _merge_multipage_scores(page_xml_paths: list[Path]) -> tuple[music21.stream.Score, list[str]]:
    """Merge recognized page MusicXML files sequentially by part index."""
    import music21

    warnings: list[str] = []
    if len(page_xml_paths) == 1:
        return music21.converter.parse(str(page_xml_paths[0])), warnings

    merged = music21.stream.Score()
    part_streams: list[music21.stream.Part] = []

    for page_idx, xml_path in enumerate(page_xml_paths, start=1):
        try:
            page_score = music21.converter.parse(str(xml_path))
        except Exception as exc:
            warnings.append(f"Page {page_idx} MusicXML parse failed: {exc}")
            continue
        if not page_score.parts:
            warnings.append(f"Page {page_idx} yielded no recognized staves.")
            continue
        if not part_streams:
            for p in page_score.parts:
                new_p = music21.stream.Part()
                new_p.partName = p.partName
                for m in p.getElementsByClass(music21.stream.Measure):
                    new_p.append(m)
                part_streams.append(new_p)
        else:
            if len(page_score.parts) != len(part_streams):
                warnings.append(
                    f"Page {page_idx} has {len(page_score.parts)} staves (expected {len(part_streams)})."
                )
            for p_idx, target_p in enumerate(part_streams):
                if p_idx >= len(page_score.parts):
                    break
                base_num = len(list(target_p.getElementsByClass(music21.stream.Measure)))
                for m_offset, m in enumerate(page_score.parts[p_idx].getElementsByClass(music21.stream.Measure), start=1):
                    m.number = base_num + m_offset
                    target_p.append(m)

    for p in part_streams:
        merged.insert(0, p)
    return merged, warnings


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
            warnings.append(f"Page {idx} OMR failed (rc={res.returncode}): {err_tail}")
            continue
        xml_outputs.append(expected_xml)

    if not xml_outputs:
        raise OMRError(
            "OMR_RECOGNITION_FAILED",
            "OMR could not recognize musical notation from any page of the uploaded PDF.",
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
) -> list[tuple[int, float, ET.Element, bool]]:
    """Return [(measure_idx, onset_whole, note_el, is_rest)] in musical order for a part."""
    items: list[tuple[int, float, ET.Element, bool]] = []
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
                onset_whole = round(start_div / (divisions * 4.0), 4)
                if not is_chord:
                    items.append((m_idx, onset_whole, child, is_rest))
                if not is_chord and not is_grace:
                    dur_txt = child.findtext("duration")
                    try:
                        dur_div = float(dur_txt or 0.0)
                    except ValueError:
                        dur_div = 0.0
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
    sop_notes_by_measure: dict[int, list[tuple[float, ET.Element]]] = {}
    for m_idx, onset, n_el, is_rest in sop_items:
        if not is_rest:
            sop_non_rest.append((m_idx, onset, m_idx + onset, n_el))
            sop_notes_by_pos[(m_idx, onset)] = n_el
            sop_notes_by_measure.setdefault(m_idx, []).append((onset, n_el))

    if not sop_non_rest:
        return 0

    def _has_verse_on_note(note_el: ET.Element, v_num: str) -> bool:
        return any((sl.attrib.get("number") or "1") == v_num for sl in note_el.findall("lyric"))

    def _find_nearest_sop_note(m_idx: int, onset: float, v_num: str) -> tuple[ET.Element, bool]:
        if (m_idx, onset) in sop_notes_by_pos:
            return sop_notes_by_pos[(m_idx, onset)], True
        measure_notes = sop_notes_by_measure.get(m_idx, [])
        for s_onset, n_el in measure_notes:
            if abs(s_onset - onset) <= 0.025:
                return n_el, True
        # Nearest note in same measure without this verse (handles passing-tone offsets)
        free_in_measure = [
            (abs(s_onset - onset), n_el)
            for s_onset, n_el in measure_notes
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
            return closest[1], False
        closest_global = min(sop_non_rest, key=lambda x: abs(x[2] - target_global))
        return closest_global[3], False

    # Gather all lyrics per part & verse
    sop_lyrics_by_verse: dict[str, dict[tuple[int, float], str]] = {}
    for m_idx, onset, n_el, _ in sop_items:
        for lyr in n_el.findall("lyric"):
            v_num = lyr.attrib.get("number") or "1"
            txt = "".join(t.text or "" for t in lyr.findall("text")).strip()
            sop_lyrics_by_verse.setdefault(v_num, {})[(m_idx, onset)] = txt

    consolidated_count = 0
    for other_idx in other_indices:
        other_items = _collect_part_note_positions(parts[other_idx])
        other_by_verse: dict[str, list[tuple[int, float, ET.Element, ET.Element, str]]] = {}
        for m_idx, onset, n_el, _ in other_items:
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
    for _, _, n_el, _ in sop_items:
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


def sanitize_omr_musicxml(
    xml_str: str,
    *,
    pdf_path: Path | None = None,
) -> tuple[str, list[str]]:
    """Remove footer/copyright pseudo-lyrics and flag cue/grace notes safely in OMR MusicXML."""
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
            txt = "".join(t.text or "" for t in lyr.findall("text")).strip()
            raw_y = lyr.attrib.get("default-y")
            try:
                dy = float(raw_y) if raw_y is not None else None
            except ValueError:
                dy = None
            if _is_footer_or_metadata_text(txt, default_y=dy, pdf_footer_texts=pdf_footers) or _is_section_label_text(txt) or not txt:
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
) -> OMRRecognitionResult:
    """Full OMR pipeline: validate PDF -> Audiveris CLI or render+homr -> SATB ScoreData."""
    import music21

    page_count = validate_pdf_bytes(pdf_path.read_bytes())
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

    return OMRRecognitionResult(
        musicxml=out_xml,
        score_data=score_data,
        page_count=page_count,
        assignments=assignments,
        warnings=warnings,
        needs_review=needs_review,
    )
