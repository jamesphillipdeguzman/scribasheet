"""Tests for song title & 'Page X of Y' footers on generated sheet music PDFs."""

from __future__ import annotations

import io
import pytest
from pypdf import PdfReader
from reportlab.lib.pagesizes import A4, landscape, letter
from reportlab.pdfgen import canvas

from app.notation.generator import add_pdf_footer, render_score_pdf
from app.schemas.score import ScoreData, ScoreNote, ScoreTrack


def _make_score(title: str, measure_count: int = 4) -> ScoreData:
    notes = [
        ScoreNote(
            id=f"n_{i}",
            pitch_midi=60 + (i % 12),
            onset_sec=i * 0.5,
            offset_sec=i * 0.5 + 0.45,
            velocity=85,
            track_index=0,
        )
        for i in range(measure_count * 4)
    ]
    return ScoreData(
        title=title,
        tempo_bpm=120.0,
        time_signature="4/4",
        key_signature="C major",
        duration_seconds=measure_count * 2.0,
        tracks=[ScoreTrack(index=0, name="Piano", instrument="piano", clef="grand")],
        notes=notes,
        chords=[],
    )


def test_single_page_pdf_footer_shows_title_and_page_1_of_1(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DISABLE_MUSESCORE_PDF", "1")
    pdf_bytes = render_score_pdf(_make_score("Amazing Grace", measure_count=4))
    reader = PdfReader(io.BytesIO(pdf_bytes))
    assert len(reader.pages) == 1
    text = reader.pages[0].extract_text() or ""
    assert "Amazing Grace" in text
    assert "Page 1 of 1" in text


def test_multi_page_pdf_footer_numbers_all_pages_consistently(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DISABLE_MUSESCORE_PDF", "1")
    # 60 measures in grand staff -> multiple pages
    pdf_bytes = render_score_pdf(_make_score("Closer", measure_count=60))
    reader = PdfReader(io.BytesIO(pdf_bytes))
    total = len(reader.pages)
    assert total >= 2
    for idx, page in enumerate(reader.pages, start=1):
        text = page.extract_text() or ""
        assert "Closer" in text
        assert f"Page {idx} of {total}" in text


def test_long_title_truncates_with_ellipsis_and_missing_title_omits_title(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DISABLE_MUSESCORE_PDF", "1")
    long_title = (
        "An Extraordinarily Long Symphony Title With Many Movements And Orchestral Annotations "
        "That Would Otherwise Collide With The Right-Aligned Page Number Footer In The Bottom Margin"
    )
    pdf_long = render_score_pdf(_make_score(long_title, measure_count=4))
    text_long = PdfReader(io.BytesIO(pdf_long)).pages[0].extract_text() or ""
    assert "..." in text_long
    assert "Page 1 of 1" in text_long

    pdf_missing = render_score_pdf(_make_score("", measure_count=4))
    text_missing = PdfReader(io.BytesIO(pdf_missing)).pages[0].extract_text() or ""
    assert "Page 1 of 1" in text_missing
    assert "Untitled" not in text_missing


def test_add_pdf_footer_supports_a4_landscape_and_is_idempotent() -> None:
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=landscape(A4))
    c.drawString(100, 300, "Page one content")
    c.showPage()
    c.drawString(100, 300, "Page two content")
    c.save()

    stamped = add_pdf_footer(buf.getvalue(), title="Away in a Manger")
    stamped_again = add_pdf_footer(stamped, title="Away in a Manger")
    assert stamped == stamped_again

    reader = PdfReader(io.BytesIO(stamped))
    assert len(reader.pages) == 2
    assert "Away in a Manger" in (reader.pages[0].extract_text() or "")
    assert "Page 1 of 2" in (reader.pages[0].extract_text() or "")
    assert "Page 2 of 2" in (reader.pages[1].extract_text() or "")
