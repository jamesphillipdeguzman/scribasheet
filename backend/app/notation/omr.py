"""Optical Music Recognition (OMR) and SATB voice identification for PDF scores.

Uses ``pypdf`` for PDF validation, ``pymupdf`` (``fitz``) for high-DPI page
rendering, ``homr`` (in ``backend/.venv_omr`` or PATH) for MusicXML recognition,
and ``music21`` for SATB staff/voice extraction.
"""

from __future__ import annotations

import io
import logging
import os
import shutil
import subprocess
import uuid
from dataclasses import dataclass, field
from pathlib import Path

import music21
from pypdf import PdfReader

from app.schemas.score import ScoreData, ScoreNote, ScoreTrack

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


def _merge_multipage_scores(page_xml_paths: list[Path]) -> tuple[music21.stream.Score, list[str]]:
    """Merge recognized page MusicXML files sequentially by part index."""
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


def _extract_part_streams(m21_score: music21.stream.Score) -> list[tuple[int, str, str, str | None, list[music21.note.NotRest]]]:
    """Extract logical voice streams from 4-staff or shared-staff SATB MusicXML."""
    extracted: list[tuple[int, str, str, str | None, list[music21.note.NotRest]]] = []
    parts = list(m21_score.parts)

    for p_idx, part in enumerate(parts):
        label = (part.partName or part.id or f"Staff {p_idx + 1}").strip()
        clef_obj = next(iter(part.recurse().getElementsByClass(music21.clef.Clef)), None)
        clef_name = type(clef_obj).__name__ if clef_obj is not None else "Unknown"

        # Check if this staff contains multiple distinct Voice objects
        voice_buckets: dict[str, list[music21.note.NotRest]] = {}
        flat_notes: list[music21.note.NotRest] = []
        for m in part.getElementsByClass(music21.stream.Measure):
            m_voices = list(m.voices)
            if len(m_voices) > 1:
                for v_i, v in enumerate(m_voices):
                    vid = str(v.id or v_i + 1)
                    voice_buckets.setdefault(vid, []).extend(list(v.recurse().notes))
            else:
                flat_notes.extend(list(m.recurse().notes))

        if len(voice_buckets) >= 2 and len(parts) <= 2:
            for vid, v_notes in sorted(voice_buckets.items()):
                extracted.append((p_idx, label, clef_name, vid, v_notes))
        else:
            all_notes = flat_notes or list(part.recurse().notes)
            extracted.append((p_idx, label, clef_name, None, all_notes))

    return extracted


def identify_satb_parts(m21_score: music21.stream.Score) -> tuple[list[SATBPartAssignment], list[str], bool]:
    """Identify Soprano, Alto, Tenor, Bass parts using labels, staff order, clefs, and pitch range."""
    raw_streams = _extract_part_streams(m21_score)
    warnings: list[str] = []
    assignments: list[SATBPartAssignment] = []
    used_voices: set[str] = set()

    # Label keyword matching first
    label_map = {
        "soprano": "Soprano",
        "sop": "Soprano",
        "alto": "Alto",
        "tenor": "Tenor",
        "ten": "Tenor",
        "bass": "Bass",
    }

    for stream_idx, (p_idx, label, clef_name, voice_id, notes) in enumerate(raw_streams):
        pitches = [
            int(p.midi)
            for el in notes
            for p in (el.pitches if isinstance(el, music21.chord.Chord) else [el.pitch])
        ]
        mean_pitch = round(sum(pitches) / len(pitches), 1) if pitches else None
        lbl_lower = label.lower()

        matched_voice: str | None = None
        conf = 0.5
        for kw, v_name in label_map.items():
            if kw in lbl_lower and v_name not in used_voices:
                matched_voice = v_name
                conf = 0.95
                break

        if matched_voice is None:
            # Use staff ordering + clef + pitch range as supporting evidence
            if len(raw_streams) == 4:
                ordered = SATB_VOICES[stream_idx]
                clef_ok = (
                    (ordered in ("Soprano", "Alto") and "Treble" in clef_name)
                    or (ordered == "Tenor" and ("Bass" in clef_name or "Treble" in clef_name))
                    or (ordered == "Bass" and "Bass" in clef_name)
                )
                matched_voice = ordered
                conf = 0.85 if clef_ok else 0.60
            else:
                # Fallback by clef & pitch range
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

    if len(raw_streams) != 4:
        warnings.append(
            f"Detected {len(raw_streams)} voice stream(s) instead of 4 SATB parts; verify voice assignments before export."
        )
    needs_review = bool(warnings) or any(a.uncertain for a in assignments)
    return assignments, warnings, needs_review


def musicxml_to_satb_score_data(
    xml_str: str,
    *,
    title: str = "SATB Score",
    tempo_bpm: float | None = None,
    override_assignments: dict[int, str] | None = None,
    extra_warnings: list[str] | None = None,
) -> tuple[ScoreData, list[SATBPartAssignment], list[str], bool]:
    """Convert MusicXML into a multi-track SATB ScoreData."""
    m21_score = music21.converter.parseData(xml_str, format="musicxml")
    assignments, warnings, needs_review = identify_satb_parts(m21_score)
    if extra_warnings:
        warnings = [*extra_warnings, *warnings]

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

    raw_streams = _extract_part_streams(m21_score)
    tracks: list[ScoreTrack] = []
    notes: list[ScoreNote] = []
    max_offset_sec = 0.0

    for a in assignments:
        clef_type = "bass" if a.assigned_voice in ("Tenor", "Bass") and "Bass" in a.clef else "treble"
        tracks.append(
            ScoreTrack(
                index=a.part_index,
                name=a.assigned_voice,
                instrument="choir_aahs",
                clef=clef_type,
                program=52,  # GM Choir Aahs (piano fallback handled in audio renderer)
            )
        )
        _, _, _, _, part_notes = raw_streams[a.part_index]
        # Compute absolute quarterLength offsets relative to the containing Part
        for el in part_notes:
            try:
                part_ref = m21_score.parts[min(a.part_index, len(m21_score.parts) - 1)]
                abs_ql = float(el.getOffsetInHierarchy(part_ref))
            except Exception:
                abs_ql = float(el.offset)
            dur_ql = max(0.125, float(el.quarterLength))
            onset_sec = round(max(0.0, abs_ql * sec_per_ql), 4)
            offset_sec = round(max(onset_sec + 0.05, (abs_ql + dur_ql) * sec_per_ql), 4)
            max_offset_sec = max(max_offset_sec, offset_sec)

            pitches = (
                [int(p.midi) for p in el.pitches]
                if isinstance(el, music21.chord.Chord)
                else [int(el.pitch.midi)]
            )
            for p_midi in pitches:
                notes.append(
                    ScoreNote(
                        id=uuid.uuid4().hex[:12],
                        pitch_midi=p_midi,
                        onset_sec=onset_sec,
                        offset_sec=offset_sec,
                        raw_onset_sec=onset_sec,
                        raw_offset_sec=offset_sec,
                        velocity=82,
                        confidence=a.confidence,
                        track_index=a.part_index,
                    )
                )

    notes.sort(key=lambda n: (n.onset_sec, n.track_index, n.pitch_midi))
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
        analysis={
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
        },
    )
    return score_data, assignments, warnings, needs_review


def process_satb_pdf(
    pdf_path: Path,
    *,
    title: str = "SATB Score",
    work_dir: Path,
    dpi: int = 250,
) -> OMRRecognitionResult:
    """Full Phase 1-3 OMR pipeline: validate PDF -> render pages -> homr -> SATB ScoreData."""
    page_count = validate_pdf_bytes(pdf_path.read_bytes())
    image_paths = render_pdf_pages_to_images(pdf_path, work_dir / "pages", dpi=dpi)
    xml_str, omr_warnings = run_homr_on_images(image_paths)
    score_data, assignments, warnings, needs_review = musicxml_to_satb_score_data(
        xml_str,
        title=title,
        extra_warnings=omr_warnings,
    )
    return OMRRecognitionResult(
        musicxml=xml_str,
        score_data=score_data,
        page_count=page_count,
        assignments=assignments,
        warnings=warnings,
        needs_review=needs_review,
    )
