"""Comprehensive tests for JPG/PNG/WebP sheet music image upload, preprocessing, OMR, and multi-page assembly."""

from __future__ import annotations

import hashlib
import io
import shutil
import subprocess
import tempfile
import uuid
import xml.etree.ElementTree as ET
from pathlib import Path
from unittest.mock import patch

import music21
import numpy as np
import pymupdf
import pytest
from PIL import Image
from pypdf import PdfWriter

from app.core.config import get_settings
from app.models import MediaAsset, Project, ProjectScore, TranscriptionJob
from app.notation.generator import render_score_pdf, score_data_to_musicxml
from app.notation.image_preprocessing import (
    SheetImageValidationError,
    build_normalized_pdf_from_images,
    detect_score_input_kind,
    preprocess_sheet_image_for_omr,
    validate_sheet_image_bytes,
)
from app.notation.omr import (
    OMRError,
    assemble_multipage_musicxml,
    find_audiveris_executable,
    find_homr_executable,
    process_satb_images,
    process_satb_pdf,
)
from app.schemas.score import ScoreData, ScoreNote, ScoreTrack
from app.worker_agent import RealTranscriptionHandler


def _auth_headers(client, email: str, *, unlimited: bool = False) -> tuple[dict[str, str], dict]:
    res = client.post(
        "/api/v1/auth/register",
        json={"email": email, "password": "StrongPassword123!", "display_name": "Score Tester"},
    )
    assert res.status_code == 201, res.text
    data = res.json()
    headers = {"Authorization": f"Bearer {data['access_token']}"}
    if unlimited:
        # Promote via test DB if needed by caller
        pass
    return headers, data


def _build_real_musicxml_score(*, measure_count: int = 4, key_fifths: int = 0, time_sig: str = "4/4") -> str:
    beats_num = int(time_sig.split("/")[0])
    beats_per_bar = beats_num if time_sig.endswith("/4") else beats_num * 0.5
    pitches = [60, 62, 64, 65, 67, 69, 71, 72]
    notes: list[ScoreNote] = []
    t = 0.0
    for idx in range(int(measure_count * beats_per_bar)):
        p = pitches[idx % len(pitches)]
        notes.append(
            ScoreNote(
                id=f"n_{idx}",
                pitch_midi=p,
                onset_sec=round(t, 3),
                offset_sec=round(t + 0.5, 3),
                velocity=84,
                track_index=0,
            )
        )
        t += 0.5
    score = ScoreData(
        title="Etude in C",
        tempo_bpm=120.0,
        tempo_estimated=False,
        time_signature=time_sig,
        time_signature_estimated=False,
        key_signature="C major" if key_fifths == 0 else "G major",
        key_signature_estimated=False,
        duration_seconds=round(t, 3),
        tracks=[
            ScoreTrack(
                index=0,
                name="Soprano",
                instrument="piano",
                clef="treble",
                program=0,
            )
        ],
        notes=notes,
        chords=[],
        analysis={"mode": "single_instrument"},
    )
    return score_data_to_musicxml(score, include_chords=False, include_lyrics=False)


def _render_musicxml_to_page_pngs(xml_str: str, out_dir: Path, *, dpi: int = 240) -> list[Path]:
    """Render genuine sheet music notation into high-res PNG page images via MuseScore 4 or ReportLab."""
    out_dir.mkdir(parents=True, exist_ok=True)
    pdf_path = out_dir / "rendered_score.pdf"

    ms4 = Path(r"C:\Program Files\MuseScore 4\bin\MuseScore4.exe")
    musescore_bin = shutil.which("MuseScore4") or shutil.which("mscore") or (str(ms4) if ms4.exists() else None)
    used_musescore = False
    if musescore_bin:
        xml_in = out_dir / "input.musicxml"
        xml_in.write_text(xml_str, encoding="utf-8")
        proc = subprocess.run(
            [musescore_bin, "-o", str(pdf_path), str(xml_in)],
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )
        if proc.returncode == 0 and pdf_path.exists() and pdf_path.stat().st_size > 100:
            used_musescore = True

    if not used_musescore:
        # Clean ReportLab notation fallback
        notes = [
            ScoreNote(
                id=f"fb_{i}",
                pitch_midi=60 + (i % 8),
                onset_sec=i * 0.5,
                offset_sec=(i + 1) * 0.5,
                velocity=84,
                track_index=0,
            )
            for i in range(16)
        ]
        fb_score = ScoreData(
            title="Etude in C",
            tempo_bpm=120.0,
            time_signature="4/4",
            key_signature="C major",
            duration_seconds=8.0,
            tracks=[ScoreTrack(index=0, name="Piano", instrument="piano", clef="treble", program=0)],
            notes=notes,
        )
        pdf_path.write_bytes(render_score_pdf(fb_score, musicxml=xml_str))

    doc = pymupdf.open(str(pdf_path))
    pages: list[Path] = []
    try:
        zoom = dpi / 72.0
        mat = pymupdf.Matrix(zoom, zoom)
        for idx in range(len(doc)):
            pix = doc[idx].get_pixmap(matrix=mat, alpha=False)
            p_path = out_dir / f"sheet_page_{idx + 1}.png"
            pix.save(str(p_path))
            pages.append(p_path)
    finally:
        doc.close()
    return pages


def _make_blank_pdf_bytes() -> bytes:
    w = PdfWriter()
    w.add_blank_page(width=612, height=792)
    buf = io.BytesIO()
    w.write(buf)
    return buf.getvalue()


def test_sheet_image_validation_and_security_and_unlimited_plan(client, db_session, tmp_path) -> None:
    headers, reg = _auth_headers(client, f"img_up_{uuid.uuid4().hex[:8]}@example.com")
    # Promote user to unlimited and confirm usage/quota checks still work cleanly
    from app.models import User

    user = db_session.query(User).filter(User.id == reg["user"]["id"]).first()
    user.plan_tier = "unlimited"
    db_session.commit()

    other_headers, _ = _auth_headers(client, f"img_other_{uuid.uuid4().hex[:8]}@example.com")

    proj = client.post(
        "/api/v1/projects",
        headers=headers,
        json={"title": "Photo Score Test", "instrument": "piano", "transcription_mode": "satb_pdf"},
    )
    assert proj.status_code == 201, proj.text
    proj_id = proj.json()["id"]

    page_pngs = _render_musicxml_to_page_pngs(_build_real_musicxml_score(measure_count=2), tmp_path / "render")
    clean_img = Image.open(page_pngs[0])

    # 1. Valid PNG, JPG, JPEG, WebP uploads succeed and keep exact untouched original bytes
    fmt_cases = [
        ("score_p1.png", "PNG", "image/png", "image/png"),
        ("score_p2.jpg", "JPEG", "image/jpeg", "image/jpeg"),
        ("score_p3.jpeg", "JPEG", "image/jpg", "image/jpeg"),
        ("score_p4.webp", "WEBP", "image/webp", "image/webp"),
    ]
    for fname, pil_fmt, upload_mime, expected_mime in fmt_cases:
        buf = io.BytesIO()
        clean_img.convert("RGB").save(buf, format=pil_fmt)
        raw_bytes = buf.getvalue()
        up = client.post(
            "/api/v1/uploads",
            headers=headers,
            data={"project_id": proj_id},
            files={"file": (fname, raw_bytes, upload_mime)},
        )
        assert up.status_code == 201, up.text
        asset = up.json()
        assert asset["original_filename"] == fname
        assert asset["mime_type"] == expected_mime
        assert asset["duration_seconds"] is None

        dl = client.get(f"/api/v1/uploads/{asset['id']}/download", headers=headers)
        assert dl.status_code == 200
        assert dl.content == raw_bytes

    # 2. Existing PDF upload remains fully functional
    pdf_up = client.post(
        "/api/v1/uploads",
        headers=headers,
        data={"project_id": proj_id},
        files={"file": ("score.pdf", _make_blank_pdf_bytes(), "application/pdf")},
    )
    assert pdf_up.status_code == 201, pdf_up.text

    # 3. Spoofed / corrupted / mismatched / unsupported / unauthorized uploads are rejected
    bad_gif = io.BytesIO()
    clean_img.convert("P").save(bad_gif, format="GIF")
    assert (
        client.post(
            "/api/v1/uploads",
            headers=headers,
            data={"project_id": proj_id},
            files={"file": ("anim.gif", bad_gif.getvalue(), "image/gif")},
        ).status_code
        == 400
    )

    # Spoofed text file renamed to .jpg
    assert (
        client.post(
            "/api/v1/uploads",
            headers=headers,
            data={"project_id": proj_id},
            files={"file": ("fake.jpg", b"<html>not an image</html>" * 4, "image/jpeg")},
        ).status_code
        == 400
    )

    # PNG bytes renamed to .jpg (extension vs content mismatch)
    png_buf = io.BytesIO()
    clean_img.save(png_buf, format="PNG")
    assert (
        client.post(
            "/api/v1/uploads",
            headers=headers,
            data={"project_id": proj_id},
            files={"file": ("mismatched.jpg", png_buf.getvalue(), "image/jpeg")},
        ).status_code
        == 400
    )

    # Disallowed MIME on presign
    assert (
        client.post(
            "/api/v1/uploads/presign",
            headers=headers,
            json={"project_id": proj_id, "filename": "page.jpg", "content_type": "text/plain", "size_bytes": 1024},
        ).status_code
        == 400
    )

    # Cross-user upload rejected with 403
    assert (
        client.post(
            "/api/v1/uploads",
            headers=other_headers,
            data={"project_id": proj_id},
            files={"file": ("intrude.png", png_buf.getvalue(), "image/png")},
        ).status_code
        == 403
    )

    # Truncated JPEG bytes fail deep content validation directly
    jpg_buf = io.BytesIO()
    clean_img.convert("RGB").save(jpg_buf, format="JPEG")
    truncated = jpg_buf.getvalue()[: len(jpg_buf.getvalue()) // 3]
    with pytest.raises(SheetImageValidationError):
        validate_sheet_image_bytes(truncated, "truncated.jpg", "image/jpeg")

    # UNLIMITED plan can start a job without minute limits
    usage_res = client.get("/api/v1/users/me", headers=headers)
    assert usage_res.status_code == 200
    assert usage_res.json()["plan_tier"] == "unlimited"


def test_conditional_preprocessing_clean_scan_vs_rotated_uneven_photo_vs_small(tmp_path) -> None:
    page_pngs = _render_musicxml_to_page_pngs(_build_real_musicxml_score(measure_count=4), tmp_path / "src", dpi=240)
    clean_path = page_pngs[0]
    clean_hash_before = hashlib.sha256(clean_path.read_bytes()).hexdigest()

    # 1. Clean high-res scan: should be detected clean, NOT cropped, NOT deskewed, NOT lighting-altered, NOT upscaled
    clean_out = tmp_path / "clean_out.png"
    clean_report = preprocess_sheet_image_for_omr(clean_path, clean_out)
    assert clean_hash_before == hashlib.sha256(clean_path.read_bytes()).hexdigest()
    assert clean_report.was_clean_scan is True
    assert clean_report.cropped is False
    assert clean_report.deskewed is False
    assert clean_report.lighting_normalized is False
    assert clean_report.resized is False
    assert clean_out.exists()

    # 2. Rotated + unevenly lit + dark-table-bordered smartphone photograph of real sheet music
    clean_arr = np.asarray(Image.open(clean_path).convert("L"), dtype=np.float32)
    # Place rotated sheet page onto a dark desk border with directional shadow lighting
    rot_page = Image.fromarray(clean_arr.astype(np.uint8)).rotate(-3.2, resample=Image.Resampling.BICUBIC, expand=True, fillcolor=245)
    rw, rh = rot_page.size
    canvas_w, canvas_h = rw + 360, rh + 360
    desk = np.full((canvas_h, canvas_w), 55.0, dtype=np.float32)  # Dark table surround
    desk[180 : 180 + rh, 180 : 180 + rw] = np.asarray(rot_page, dtype=np.float32)
    # Apply uneven left-to-right & top-to-bottom illumination falloff
    yy, xx = np.mgrid[0:canvas_h, 0:canvas_w]
    shadow = 1.0 - 0.35 * (xx / max(1, canvas_w)) - 0.15 * (yy / max(1, canvas_h))
    photo_arr = np.clip(desk * shadow, 0, 255).astype(np.uint8)
    photo_jpg = tmp_path / "photo_sheet.jpg"
    Image.fromarray(photo_arr, mode="L").save(photo_jpg, format="JPEG", quality=92)
    photo_hash = hashlib.sha256(photo_jpg.read_bytes()).hexdigest()

    photo_out = tmp_path / "photo_out.png"
    photo_report = preprocess_sheet_image_for_omr(photo_jpg, photo_out)
    assert photo_hash == hashlib.sha256(photo_jpg.read_bytes()).hexdigest()
    assert photo_report.was_clean_scan is False
    assert photo_report.cropped is True
    assert photo_report.deskewed is True
    assert abs(photo_report.skew_angle_deg) >= 2.0
    assert photo_report.lighting_normalized is True

    # Output has even bright white background while preserving dark ink notation
    out_arr = np.asarray(Image.open(photo_out).convert("L"), dtype=np.uint8)
    assert float(np.percentile(out_arr, 85)) >= 240.0
    assert int(np.min(out_arr)) < 60

    # 3. Low-resolution scan gets conditionally normalized upward
    with Image.open(clean_path) as im:
        small_w = 720
        small_h = max(120, int(round(im.height * (720.0 / im.width))))
        small_im = im.resize((small_w, small_h), Image.Resampling.LANCZOS)
        small_path = tmp_path / "small_sheet.webp"
        small_im.convert("RGB").save(small_path, format="WEBP")
    small_out = tmp_path / "small_out.png"
    small_report = preprocess_sheet_image_for_omr(small_path, small_out)
    assert small_report.resized is True
    assert small_report.output_size[0] >= 1500


def test_multipage_musicxml_assembly_continuity_and_meter_change() -> None:
    p1_xml = """<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Soprano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>4</divisions>
        <key><fifths>1</fifths></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef>
      </attributes>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>16</duration><voice>1</voice><type>whole</type></note>
    </measure>
    <measure number="2">
      <note><pitch><step>A</step><octave>4</octave></pitch><duration>16</duration><voice>1</voice><type>whole</type></note>
    </measure>
  </part>
</score-partwise>"""

    # Page 2 repeats identical key/time/clef on its m.1 (redundant) and then has a real meter change to 3/4 on its m.2
    p2_xml = """<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Soprano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>4</divisions>
        <key><fifths>1</fifths></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef>
      </attributes>
      <note><pitch><step>B</step><octave>4</octave></pitch><duration>16</duration><voice>1</voice><type>whole</type></note>
    </measure>
    <measure number="2">
      <attributes><time><beats>3</beats><beat-type>4</beat-type></time></attributes>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>12</duration><voice>1</voice><type>half</type><dot/></note>
    </measure>
  </part>
</score-partwise>"""

    assembled_xml, warnings = assemble_multipage_musicxml([p1_xml, p2_xml], page_labels=["p1.jpg", "p2.jpg"])
    assert warnings == []
    music21.converter.parseData(assembled_xml, format="musicxml")
    root = ET.fromstring(assembled_xml)
    measures = root.findall("./part/measure")
    assert [m.attrib.get("number") for m in measures] == ["1", "2", "3", "4"]
    # Page break inserted on m.3 without duplicate time signature
    assert measures[2].find("print") is not None and measures[2].find("print").attrib.get("new-page") == "yes"
    assert measures[2].find("attributes") is None
    # Real mid-piece meter change on m.4 IS preserved
    assert measures[3].findtext("./attributes/time/beats") == "3"
    # All 4 pitched notes kept sequentially
    steps = [m.findtext("./note/pitch/step") for m in measures]
    assert steps == ["G", "A", "B", "C"]


def test_multipage_job_claim_order_persistence_export_and_failure_cleanup(client, db_session, tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("JOB_EXECUTION_MODE", "remote_worker")
    monkeypatch.setenv("WORKER_API_TOKEN", "test-image-omr-worker-token")
    get_settings.cache_clear()
    try:
        headers, _ = _auth_headers(client, f"multi_{uuid.uuid4().hex[:8]}@example.com")
        settings = get_settings()
        worker_headers = {"X-Worker-Token": settings.WORKER_API_TOKEN}

        proj_res = client.post(
            "/api/v1/projects",
            headers=headers,
            json={"title": "Multi Page Hymn", "instrument": "vocals", "transcription_mode": "satb_pdf"},
        )
        assert proj_res.status_code == 201
        proj_id = proj_res.json()["id"]

        page_pngs = _render_musicxml_to_page_pngs(_build_real_musicxml_score(measure_count=2), tmp_path / "sheet")
        with Image.open(page_pngs[0]) as im:
            b1 = io.BytesIO()
            im.convert("RGB").save(b1, format="JPEG")
            b2 = io.BytesIO()
            im.save(b2, format="PNG")
            b3 = io.BytesIO()
            im.convert("RGB").save(b3, format="WEBP")

        up1 = client.post("/api/v1/uploads", headers=headers, data={"project_id": proj_id}, files={"file": ("page_a.jpg", b1.getvalue(), "image/jpeg")}).json()
        client.post("/api/v1/uploads", headers=headers, data={"project_id": proj_id}, files={"file": ("page_b.png", b2.getvalue(), "image/png")}).json()
        up3 = client.post("/api/v1/uploads", headers=headers, data={"project_id": proj_id}, files={"file": ("page_c.webp", b3.getvalue(), "image/webp")}).json()

        # User reorders pages to [page_c, page_a] (and removed page_b from selection)
        reordered_ids = [up3["id"], up1["id"]]
        job_res = client.post(
            f"/api/v1/projects/{proj_id}/transcriptions",
            headers=headers,
            json={
                "source_asset_id": reordered_ids[0],
                "source_asset_ids": reordered_ids,
                "settings": {"mode": "satb_pdf", "instrument": "vocals", "satb_mode": "keep_original"},
            },
        )
        assert job_res.status_code == 202, job_res.text
        job_id = job_res.json()["id"]

        claim_res = client.post("/api/v1/worker/jobs/claim", headers=worker_headers, json={"worker_id": "test-omr-worker"})
        assert claim_res.status_code == 200
        claimed = claim_res.json()["job"]
        assert claimed is not None
        assert claimed["id"] == job_id
        assert [p["asset_id"] for p in claimed["source_pages"]] == reordered_ids
        assert [p["filename"] for p in claimed["source_pages"]] == ["page_c.webp", "page_a.jpg"]
        assert [p["page_index"] for p in claimed["source_pages"]] == [1, 2]

        # Run RealTranscriptionHandler using mocked homr/audiveris returning valid per-page XML and verify temp cleanup
        p1_xml = _build_real_musicxml_score(measure_count=2)
        p2_xml = _build_real_musicxml_score(measure_count=2)

        class _StreamResp:
            def __init__(self, data: bytes) -> None:
                self._data = data

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def raise_for_status(self):
                return None

            def iter_bytes(self, chunk_size: int = 65536):
                yield self._data

        class _FakeClient:
            def stream(self, _method: str, url: str):
                asset_id = url.split("/uploads/")[1].split("/")[0]
                return _StreamResp(b3.getvalue() if asset_id == up3["id"] else b1.getvalue())

        created_temp_dirs: list[Path] = []
        orig_tempdir = tempfile.TemporaryDirectory

        class _TrackingTempDir(orig_tempdir):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, **kwargs)
                created_temp_dirs.append(Path(self.name))

        handler = RealTranscriptionHandler(api_base_url="http://testserver/api/v1", http_client=_FakeClient())  # type: ignore[arg-type]
        with (
            patch("app.worker_agent.tempfile.TemporaryDirectory", _TrackingTempDir),
            patch("app.notation.omr.find_audiveris_executable", return_value=None),
            patch("app.notation.omr.find_homr_executable", return_value=Path("homr.exe")),
            patch("app.notation.omr.run_homr_on_images", side_effect=[(p1_xml, []), (p2_xml, [])]) as homr_mock,
        ):
            result = handler.handle(claimed, lambda *_args: None)

        assert homr_mock.call_count == 2
        assert any(d.name.startswith("scriba_job_") for d in created_temp_dirs)
        assert all(not d.exists() for d in created_temp_dirs)
        assert len(result.score_json["notes"]) == 16  # 2 pages * 8 notes per page

        # Complete job on coordinator and verify project creation, reopening, playback score, and exports!
        comp = client.post(
            f"/api/v1/worker/jobs/{job_id}/complete",
            headers=worker_headers,
            json={
                "worker_id": "test-omr-worker",
                "midi_base64": result.midi_base64,
                "musicxml_content": result.musicxml_content,
                "score_json": result.score_json,
                "duration_seconds": result.duration_seconds,
                "metadata_json": result.metadata_json,
            },
        )
        assert comp.status_code == 200, comp.text

        proj_after = client.get(f"/api/v1/projects/{proj_id}", headers=headers)
        assert proj_after.status_code == 200 and proj_after.json()["status"] == "ready"

        reloaded_score = client.get(f"/api/v1/projects/{proj_id}/score", headers=headers)
        assert reloaded_score.status_code == 200
        assert len(reloaded_score.json()["score_json"]["notes"]) == 16
        assert "<score-partwise" in reloaded_score.json()["musicxml"]

        # MusicXML, MXL, MIDI, and WAV exports work through unified ScribaSheet workflow
        for fmt in ("musicxml", "mxl", "midi", "wav"):
            exp_res = client.post(f"/api/v1/projects/{proj_id}/exports", headers=headers, json={"format": fmt})
            assert exp_res.status_code == 201, f"{fmt}: {exp_res.text}"
            dl_res = client.get(exp_res.json()["download_url"], headers=headers)
            assert dl_res.status_code == 200 and len(dl_res.content) > 32

        # Failure on Page 2 returns useful error identifying Page 2 and cleans up temp dir
        fail_temp_dirs: list[Path] = []

        class _FailTrackingTempDir(orig_tempdir):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, **kwargs)
                fail_temp_dirs.append(Path(self.name))

        from app.transcription.basic_pitch_provider import TranscriptionInferenceError

        with (
            patch("app.worker_agent.tempfile.TemporaryDirectory", _FailTrackingTempDir),
            patch("app.notation.omr.find_audiveris_executable", return_value=None),
            patch("app.notation.omr.find_homr_executable", return_value=Path("homr.exe")),
            patch(
                "app.notation.omr.run_homr_on_images",
                side_effect=[(p1_xml, []), OMRError("OMR_FAILED", "Corrupted staves")],
            ),
        ):
            with pytest.raises(TranscriptionInferenceError) as exc_info:
                handler.handle(claimed, lambda *_args: None)

        assert "Page 2" in exc_info.value.message
        assert "page_a.jpg" in exc_info.value.message
        assert any(d.name.startswith("scriba_job_") for d in fail_temp_dirs)
        assert all(not d.exists() for d in fail_temp_dirs)
    finally:
        monkeypatch.undo()
        get_settings.cache_clear()


def test_content_signature_detection_pdf_guard_and_normalized_pdf(tmp_path) -> None:
    page_pngs = _render_musicxml_to_page_pngs(_build_real_musicxml_score(measure_count=2), tmp_path / "sig_src", dpi=240)
    src_png = page_pngs[0]
    with Image.open(src_png) as im:
        jpg_buf = io.BytesIO()
        im.convert("RGB").save(jpg_buf, format="JPEG")
        webp_buf = io.BytesIO()
        im.convert("RGB").save(webp_buf, format="WEBP")

    png_bytes = src_png.read_bytes()
    jpg_bytes = jpg_buf.getvalue()
    webp_bytes = webp_buf.getvalue()
    pdf_bytes = _make_blank_pdf_bytes()

    assert detect_score_input_kind(pdf_bytes, "wrong.jpg", "image/jpeg") == ("pdf", "pdf")
    assert detect_score_input_kind(jpg_bytes, "misleading.pdf", "application/pdf") == ("image", "jpeg")
    assert detect_score_input_kind(png_bytes, "no_ext", None) == ("image", "png")
    assert detect_score_input_kind(webp_bytes, "page.webp", "image/webp") == ("image", "webp")
    assert detect_score_input_kind(b"not valid music bytes", "bad.jpg", "image/jpeg") == ("unsupported", "unknown")

    # Misnamed JPEG saved with .pdf extension never hits validate_pdf_bytes ("File is not a valid PDF document.")
    misnamed_pdf = tmp_path / "go-tell-it-on-a-mountain.pdf"
    misnamed_pdf.write_bytes(jpg_bytes)
    sample_xml = _build_real_musicxml_score(measure_count=2)

    seen_audiveris_inputs: list[tuple[Path, int, bytes]] = []

    def _fake_audiveris(pdf_in: Path, out_dir: Path, *, timeout: int = 300):
        raw = pdf_in.read_bytes()
        doc = pymupdf.open(str(pdf_in))
        try:
            seen_audiveris_inputs.append((pdf_in, len(doc), raw[:5]))
        finally:
            doc.close()
        return sample_xml, []

    with (
        patch("app.notation.omr.find_audiveris_executable", return_value=Path("Audiveris.exe")),
        patch("app.notation.omr.run_audiveris_on_pdf", side_effect=_fake_audiveris),
    ):
        res = process_satb_pdf(misnamed_pdf, title="Guarded Score", work_dir=tmp_path / "guard_work")

    assert res.page_count == 1
    assert len(res.score_data.notes) == 8
    assert len(seen_audiveris_inputs) == 1
    assert seen_audiveris_inputs[0][0].name == "normalized_score.pdf"
    assert seen_audiveris_inputs[0][1] == 1
    assert seen_audiveris_inputs[0][2] == b"%PDF-"

    # Multi-page image-to-PDF normalization preserves exact page count, order, and ~300 DPI sizing
    norm_pdf = tmp_path / "multi_norm.pdf"
    p2_jpg = tmp_path / "p2.jpg"
    p2_jpg.write_bytes(jpg_bytes)
    build_normalized_pdf_from_images([src_png, p2_jpg], norm_pdf, dpi=300, job_id="job-norm-1")
    doc_check = pymupdf.open(str(norm_pdf))
    try:
        assert len(doc_check) == 2
        with Image.open(src_png) as im0:
            expected_w = im0.width * 72.0 / 300.0
            assert abs(doc_check[0].rect.width - expected_w) < 1.0
    finally:
        doc_check.close()


def test_worker_page_image_urls_media_files_and_error_stages(tmp_path) -> None:
    from app.transcription.basic_pitch_provider import TranscriptionInferenceError

    page_pngs = _render_musicxml_to_page_pngs(_build_real_musicxml_score(measure_count=2), tmp_path / "w_src", dpi=240)
    with Image.open(page_pngs[0]) as im:
        jpg_buf = io.BytesIO()
        im.convert("RGB").save(jpg_buf, format="JPEG")
        webp_buf = io.BytesIO()
        im.convert("RGB").save(webp_buf, format="WEBP")

    url_map: dict[str, bytes] = {
        "http://mock-r2/p1": jpg_buf.getvalue(),
        "http://mock-r2/p2": webp_buf.getvalue(),
        "http://mock-r2/bad_text.jpg": b"<html>not an image</html>",
        "http://mock-r2/corrupt.png": b"\x89PNG\r\n\x1a\n" + b"\x00" * 32,
    }

    class _StreamResp:
        def __init__(self, url: str) -> None:
            self._url = url

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def raise_for_status(self):
            if self._url not in url_map:
                raise RuntimeError("404 Missing Page")

        def iter_bytes(self, chunk_size: int = 65536):
            yield url_map[self._url]

    class _FakeClient:
        def stream(self, _method: str, url: str):
            return _StreamResp(url)

    sample_xml = _build_real_musicxml_score(measure_count=2)
    seen_pdf_pages: list[int] = []

    def _fake_audiveris(pdf_in: Path, out_dir: Path, *, timeout: int = 300):
        doc = pymupdf.open(str(pdf_in))
        try:
            seen_pdf_pages.append(len(doc))
        finally:
            doc.close()
        return sample_xml, []

    handler = RealTranscriptionHandler(api_base_url="http://testserver/api/v1", http_client=_FakeClient())  # type: ignore[arg-type]

    # 1. Images supplied via page_image_urls (even without filename extensions on URLs)
    job_urls = {
        "id": "job-page-urls-1",
        "project_id": "proj-1",
        "project_title": "Go Tell It URLs",
        "engine": "basic_pitch",
        "settings": {"mode": "satb_pdf", "instrument": "vocals", "satb_mode": "keep_original"},
        "page_image_urls": ["http://mock-r2/p1", "http://mock-r2/p2"],
        "source_filename": None,
        "artifact_upload_urls": {},
    }
    with (
        patch("app.notation.omr.find_audiveris_executable", return_value=Path("Audiveris.exe")),
        patch("app.notation.omr.run_audiveris_on_pdf", side_effect=_fake_audiveris),
    ):
        res_urls = handler.handle(job_urls, lambda *_args: None)
    assert res_urls.metadata_json["input_type"] == "images"
    assert res_urls.metadata_json["page_count"] == 2
    assert seen_pdf_pages[-1] == 2

    # 2. Images supplied via media_files
    job_media = {
        "id": "job-media-files-1",
        "project_id": "proj-1",
        "project_title": "Go Tell It MediaFiles",
        "engine": "basic_pitch",
        "settings": {"mode": "satb_pdf", "instrument": "vocals", "satb_mode": "keep_original"},
        "media_files": [
            {"download_url": "http://mock-r2/p1", "filename": "page_1.jpeg", "mime_type": "image/jpeg"},
            {"download_url": "http://mock-r2/p2", "filename": "page_2.webp", "mime_type": "image/webp"},
        ],
        "artifact_upload_urls": {},
    }
    with (
        patch("app.notation.omr.find_audiveris_executable", return_value=Path("Audiveris.exe")),
        patch("app.notation.omr.run_audiveris_on_pdf", side_effect=_fake_audiveris),
    ):
        res_media = handler.handle(job_media, lambda *_args: None)
    assert res_media.metadata_json["input_type"] == "images"
    assert res_media.metadata_json["page_count"] == 2

    # 3. Missing page image download raises stage-specific IMAGE_DOWNLOAD_FAILED
    bad_dl_job = {
        **job_urls,
        "id": "job-missing-page",
        "page_image_urls": ["http://mock-r2/p1", "http://mock-r2/missing_page"],
    }
    with pytest.raises(TranscriptionInferenceError) as exc_dl:
        handler.handle(bad_dl_job, lambda *_args: None)
    assert exc_dl.value.code == "IMAGE_DOWNLOAD_FAILED"
    assert "Page 2" in exc_dl.value.message

    # 4. Text file with misleading .jpg extension raises INVALID_IMAGE (never INVALID_PDF)
    bad_ext_job = {
        "id": "job-fake-jpg",
        "project_id": "proj-1",
        "settings": {"mode": "satb_pdf", "instrument": "vocals"},
        "source_download_url": "http://mock-r2/bad_text.jpg",
        "source_filename": "fake.jpg",
        "source_mime_type": "image/jpeg",
        "artifact_upload_urls": {},
    }
    with pytest.raises(TranscriptionInferenceError) as exc_fake:
        handler.handle(bad_ext_job, lambda *_args: None)
    assert exc_fake.value.code == "INVALID_IMAGE"

    # 5. Corrupted PNG page raises INVALID_IMAGE (identifying Page 2)
    corrupt_page_job = {
        **job_urls,
        "id": "job-corrupt-page",
        "media_files": [
            {"download_url": "http://mock-r2/p1", "filename": "ok.jpg", "mime_type": "image/jpeg"},
            {"download_url": "http://mock-r2/corrupt.png", "filename": "corrupt.png", "mime_type": "image/png"},
        ],
        "page_image_urls": [],
    }
    with pytest.raises(TranscriptionInferenceError) as exc_corrupt:
        handler.handle(corrupt_page_job, lambda *_args: None)
    assert exc_corrupt.value.code == "INVALID_IMAGE"
    assert "Page 2" in exc_corrupt.value.message


def test_retry_failed_jpg_job_succeeds_and_avoids_duplicate_project_or_attachments(
    client, db_session, tmp_path, monkeypatch
) -> None:
    """Reproduce failed 'Go tell it on a mountain from jpg' job, retry via Desktop Worker, and prevent duplicates."""
    monkeypatch.setenv("JOB_EXECUTION_MODE", "remote_worker")
    monkeypatch.setenv("WORKER_API_TOKEN", "test-retry-jpg-worker-token")
    get_settings.cache_clear()
    try:
        headers, reg = _auth_headers(client, f"retry_jpg_{uuid.uuid4().hex[:8]}@example.com")
        user_id = reg["user"]["id"]
        settings = get_settings()
        worker_headers = {"X-Worker-Token": settings.WORKER_API_TOKEN}

        proj_res = client.post(
            "/api/v1/projects",
            headers=headers,
            json={
                "title": "Go tell it on a mountain from jpg",
                "instrument": "vocals",
                "transcription_mode": "satb_pdf",
            },
        )
        assert proj_res.status_code == 201, proj_res.text
        proj_id = proj_res.json()["id"]

        page_pngs = _render_musicxml_to_page_pngs(_build_real_musicxml_score(measure_count=2), tmp_path / "mountain")
        jpg_buf = io.BytesIO()
        with Image.open(page_pngs[0]) as im:
            im.convert("RGB").save(jpg_buf, format="JPEG", quality=94)
        raw_jpg_bytes = jpg_buf.getvalue()

        up_res = client.post(
            "/api/v1/uploads",
            headers=headers,
            data={"project_id": proj_id},
            files={"file": ("go-tell-it-on-a-mountain.jpg", raw_jpg_bytes, "image/jpeg")},
        )
        assert up_res.status_code == 201, up_res.text
        orig_asset_id = up_res.json()["id"]

        # Simulate the historical failed JPG job recorded before the worker fix (no source_asset_ids in settings)
        failed_job = TranscriptionJob(
            project_id=proj_id,
            user_id=user_id,
            source_asset_id=orig_asset_id,
            status="failed",
            progress=20,
            current_stage="Failed",
            engine="basic_pitch",
            error_code="INVALID_PDF",
            error_message="File is not a valid PDF document.",
            settings_json={
                "mode": "satb_pdf",
                "instrument": "vocals",
                "satb_mode": "keep_original",
            },
        )
        db_session.add(failed_job)
        db_session.commit()
        db_session.refresh(failed_job)

        class _ApiStreamResp:
            def __init__(self, content: bytes) -> None:
                self._content = content

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def raise_for_status(self):
                return None

            def iter_bytes(self, chunk_size: int = 65536):
                yield self._content

        class _TestClientBridge:
            def stream(self, _method: str, url: str):
                path = url if url.startswith("/") else "/" + url.split("://", 1)[1].split("/", 1)[1]
                r = client.get(path)
                assert r.status_code == 200, f"Download failed ({r.status_code}): {path}"
                return _ApiStreamResp(r.content)

        omr_xml = _build_real_musicxml_score(measure_count=2)

        def _run_retry_round(target_job_id: str) -> None:
            retry_res = client.post(f"/api/v1/transcriptions/{target_job_id}/retry", headers=headers)
            assert retry_res.status_code == 202, retry_res.text
            retry_job = retry_res.json()
            assert retry_job["project_id"] == proj_id
            assert retry_job["settings_json"]["source_asset_ids"] == [orig_asset_id]

            claim_res = client.post(
                "/api/v1/worker/jobs/claim",
                headers=worker_headers,
                json={"worker_id": "win-test-retry"},
            )
            assert claim_res.status_code == 200
            claimed = claim_res.json()["job"]
            assert claimed is not None and claimed["id"] == retry_job["id"]
            assert claimed["source_filename"] == "go-tell-it-on-a-mountain.jpg"
            assert claimed["source_mime_type"] == "image/jpeg"
            assert len(claimed["source_pages"]) == 1
            assert len(claimed["page_image_urls"]) == 1
            assert len(claimed["media_files"]) == 1

            handler = RealTranscriptionHandler(
                api_base_url="http://testserver/api/v1",
                http_client=_TestClientBridge(),  # type: ignore[arg-type]
            )
            with (
                patch("app.notation.omr.find_audiveris_executable", return_value=Path("Audiveris.exe")),
                patch("app.notation.omr.run_audiveris_on_pdf", return_value=(omr_xml, [])),
            ):
                result = handler.handle(claimed, lambda *_args: None)

            assert result.metadata_json["input_type"] == "images"
            comp_res = client.post(
                f"/api/v1/worker/jobs/{retry_job['id']}/complete",
                headers=worker_headers,
                json={
                    "worker_id": "win-test-retry",
                    "midi_base64": result.midi_base64,
                    "musicxml_content": result.musicxml_content,
                    "score_json": result.score_json,
                    "duration_seconds": result.duration_seconds,
                    "metadata_json": result.metadata_json,
                },
            )
            assert comp_res.status_code == 200, comp_res.text
            return retry_job["id"]

        first_retry_id = _run_retry_round(failed_job.id)
        second_retry_id = _run_retry_round(failed_job.id)
        assert second_retry_id != first_retry_id

        # Project, score, WAV audio export, and untouched original JPG verified without duplicates
        proj_after = client.get(f"/api/v1/projects/{proj_id}", headers=headers)
        assert proj_after.status_code == 200
        assert proj_after.json()["status"] == "ready"

        score_after = client.get(f"/api/v1/projects/{proj_id}/score", headers=headers)
        assert score_after.status_code == 200
        assert "<score-partwise" in score_after.json()["musicxml"]
        assert len(score_after.json()["score_json"]["notes"]) == 8

        wav_exp = client.post(f"/api/v1/projects/{proj_id}/exports", headers=headers, json={"format": "wav"})
        assert wav_exp.status_code == 201, wav_exp.text
        wav_dl = client.get(wav_exp.json()["download_url"], headers=headers)
        assert wav_dl.status_code == 200 and wav_dl.content[:4] == b"RIFF"

        orig_dl = client.get(f"/api/v1/uploads/{orig_asset_id}/download", headers=headers)
        assert orig_dl.status_code == 200 and orig_dl.content == raw_jpg_bytes

        assert db_session.query(Project).filter(Project.user_id == user_id).count() == 1
        assert db_session.query(ProjectScore).filter(ProjectScore.project_id == proj_id).count() == 1
        assert (
            db_session.query(MediaAsset)
            .filter(MediaAsset.project_id == proj_id, MediaAsset.asset_type == "original")
            .count()
            == 1
        )
        assert (
            db_session.query(MediaAsset)
            .filter(MediaAsset.project_id == proj_id, MediaAsset.asset_type == "musicxml")
            .count()
            == 1
        )
        assert (
            db_session.query(MediaAsset)
            .filter(MediaAsset.project_id == proj_id, MediaAsset.asset_type == "midi")
            .count()
            == 1
        )
    finally:
        monkeypatch.undo()
        get_settings.cache_clear()


def test_real_omr_recognizes_actual_sheet_music_images_jpg_png_webp_and_multipage(tmp_path) -> None:
    """Real OMR integration test using installed Audiveris / homr on actual engraved MuseScore sheet music."""
    if find_audiveris_executable() is None and find_homr_executable() is None:
        pytest.skip("Neither Audiveris nor homr is installed in this environment.")

    # Prefer homr if Audiveris fails on single image, or test default 'auto' flow on real engraved notation
    one_page_xml = _build_real_musicxml_score(measure_count=4, key_fifths=0, time_sig="4/4")
    p1_pngs = _render_musicxml_to_page_pngs(one_page_xml, tmp_path / "real_1p", dpi=250)
    src_png = p1_pngs[0]

    # Convert same engraved sheet music to JPG, JPEG, WebP, and rotated/shadowed JPG photo
    src_jpg = tmp_path / "real_p1.jpg"
    src_jpeg = tmp_path / "real_p1.jpeg"
    src_webp = tmp_path / "real_p1.webp"
    src_photo_jpg = tmp_path / "real_photo_skew.jpg"
    with Image.open(src_png) as im:
        rgb = im.convert("RGB")
        rgb.save(src_jpg, format="JPEG", quality=95)
        rgb.save(src_jpeg, format="JPEG", quality=95)
        rgb.save(src_webp, format="WEBP", quality=95)

        gray = np.asarray(im.convert("L"), dtype=np.float32)
        rot = Image.fromarray(gray.astype(np.uint8)).rotate(-2.2, resample=Image.Resampling.BICUBIC, expand=True, fillcolor=242)
        rot_arr = np.asarray(rot, dtype=np.float32)
        h, w = rot_arr.shape
        yy, xx = np.mgrid[0:h, 0:w]
        lit = np.clip(rot_arr * (1.0 - 0.25 * (xx / max(1, w))), 0, 255).astype(np.uint8)
        Image.fromarray(lit, mode="L").save(src_photo_jpg, format="JPEG", quality=92)

    # Single-page JPG, JPEG, PNG, & WebP through full process_satb_images pipeline (with 300 DPI PDF normalization)
    for label, img_file in [
        ("clean_jpg", src_jpg),
        ("clean_jpeg", src_jpeg),
        ("clean_png", src_png),
        ("clean_webp", src_webp),
        ("skew_photo_jpg", src_photo_jpg),
    ]:
        work_sub = tmp_path / f"work_{label}"
        omr_res = process_satb_images(
            [img_file],
            title=f"Real OMR {label}",
            work_dir=work_sub,
            satb_mode="keep_original",
            omr_engine="auto",
        )
        assert (work_sub / "normalized_score.pdf").exists()
        assert omr_res.page_count == 1
        assert len(omr_res.score_data.notes) >= 4, f"{label} recognized too few notes: {len(omr_res.score_data.notes)}"
        assert "<score-partwise" in omr_res.musicxml
        music21.converter.parseData(omr_res.musicxml, format="musicxml")

    # Multi-page (2 PNG pages) sequentially assembled into one unified MusicXML score
    two_page_xml = _build_real_musicxml_score(measure_count=4, key_fifths=0, time_sig="4/4")
    p2_pngs = _render_musicxml_to_page_pngs(two_page_xml, tmp_path / "real_p2", dpi=250)
    work_2p = tmp_path / "work_2p"
    multi_res = process_satb_images(
        [src_png, p2_pngs[0]],
        title="Real Two Page Score",
        work_dir=work_2p,
        satb_mode="keep_original",
        omr_engine="auto",
    )
    doc_2p = pymupdf.open(str(work_2p / "normalized_score.pdf"))
    try:
        assert len(doc_2p) == 2
    finally:
        doc_2p.close()
    assert multi_res.page_count == 2
    assert len(multi_res.score_data.notes) >= 8
    root_multi = ET.fromstring(multi_res.musicxml)
    assert len(root_multi.findall("./part/measure")) >= 2
