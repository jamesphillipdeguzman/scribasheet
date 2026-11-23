from datetime import UTC, datetime
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, get_owned_project
from app.core.config import get_settings
from app.db.session import get_db
from app.models import (
    Export,
    MediaAsset,
    Project,
    ProjectScore,
    TranscriptionJob,
    TranscriptionResult,
    User,
)
from app.notation.generator import (
    _render_pdf_from_musicxml_via_musescore,
    _render_pdf_via_musescore,
    add_pdf_footer,
    apply_scribasheet_musicxml_branding,
    clean_score_title,
    count_pdf_pages,
    render_score_pdf,
    render_score_wav,
    score_data_to_midi_bytes,
    score_data_to_musicxml,
)
from app.notation.omr import sanitize_omr_musicxml
from app.schemas.export import ExportCreateRequest, ExportResponse
from app.schemas.score import ScoreData
from app.storage.service import sanitize_filename, storage_service

router = APIRouter(tags=["Exports"])

EXPORT_MIME_TYPES = {
    "midi": ("audio/midi", "mid"),
    "musicxml": ("application/vnd.recordare.musicxml+xml", "musicxml"),
    "pdf": ("application/pdf", "pdf"),
    "wav": ("audio/wav", "wav"),
    "soprano_mp3": ("audio/mpeg", "mp3"),
    "alto_mp3": ("audio/mpeg", "mp3"),
    "tenor_mp3": ("audio/mpeg", "mp3"),
    "bass_mp3": ("audio/mpeg", "mp3"),
}


def _resolve_pdf_export_bytes(
    db: Session,
    project_id: str,
    score_version: int,
    score: ScoreData,
    *,
    include_chords: bool = True,
    musicxml_path: str | None = None,
    transcribed_by: str | None = None,
) -> bytes:
    """Prefer MuseScore 4 PDF (from saved MusicXML when available, or ScoreData) over ReportLab fallback."""
    if musicxml_path:
        try:
            saved_xml = storage_service.read_bytes(musicxml_path).decode("utf-8-sig", errors="replace")
            if "<score-" in saved_xml:
                cleaned_xml, _ = sanitize_omr_musicxml(
                    saved_xml,
                    fallback_key_signature=score.key_signature,
                )
                musescore_from_xml = _render_pdf_from_musicxml_via_musescore(
                    cleaned_xml,
                    title=score.title,
                    transcribed_by=transcribed_by,
                )
                if musescore_from_xml is not None:
                    return musescore_from_xml
        except FileNotFoundError:
            pass

    musescore_local = _render_pdf_via_musescore(
        score,
        include_chords=include_chords,
        transcribed_by=transcribed_by,
    )
    if musescore_local is not None:
        return musescore_local

    # Look for a worker-generated MuseScore PDF matching this score version & chord visibility
    results = (
        db.query(TranscriptionResult)
        .join(TranscriptionJob, TranscriptionJob.id == TranscriptionResult.job_id)
        .filter(TranscriptionJob.project_id == project_id)
        .order_by(TranscriptionResult.created_at.desc())
        .all()
    )
    for res in results:
        meta = res.metadata_json or {}
        pdf_asset_id = meta.get("pdf_asset_id")
        pdf_ver = meta.get("pdf_score_version")
        pdf_include_chords = meta.get("pdf_include_chords", True)
        is_stale_satb_pdf = meta.get("handler") == "real_omr_homr" and meta.get("branding_version") != "scribasheet_v2"
        if (
            pdf_asset_id
            and pdf_ver == score_version
            and bool(pdf_include_chords) == bool(include_chords)
            and not is_stale_satb_pdf
        ):
            asset = db.query(MediaAsset).filter(MediaAsset.id == pdf_asset_id).first()
            if asset:
                try:
                    data = storage_service.read_bytes(asset.storage_path)
                    if data.startswith(b"%PDF-") and count_pdf_pages(data) >= 1:
                        return add_pdf_footer(data, title=score.title)
                except FileNotFoundError:
                    pass

    return render_score_pdf(score, include_chords=include_chords)


@router.get("/projects/{project_id}/exports", response_model=list[ExportResponse])
def list_project_exports(
    project: Project = Depends(get_owned_project),
    db: Session = Depends(get_db),
):
    settings = get_settings()
    rows = (
        db.query(Export)
        .filter(Export.project_id == project.id)
        .order_by(Export.created_at.desc())
        .all()
    )
    return [
        ExportResponse(
            id=r.id,
            project_id=r.project_id,
            format=r.format,
            status=r.status,
            error_message=r.error_message,
            download_url=f"{settings.API_V1_PREFIX}/exports/{r.id}/download" if r.status == "completed" else None,
            created_at=r.created_at,
            completed_at=r.completed_at,
        )
        for r in rows
    ]


@router.post(
    "/projects/{project_id}/exports",
    response_model=ExportResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_export(
    payload: ExportCreateRequest,
    project: Project = Depends(get_owned_project),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    score_row = db.query(ProjectScore).filter(ProjectScore.project_id == project.id).first()
    if not score_row:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cannot export before a transcription score exists.",
        )

    export = Export(
        project_id=project.id,
        user_id=current_user.id,
        format=payload.format,
        status="processing",
    )
    db.add(export)
    db.commit()
    db.refresh(export)

    try:
        score = ScoreData(**score_row.score_json)
        score.title = clean_score_title(project.title)
        mime_type, ext = EXPORT_MIME_TYPES[payload.format]

        raw_credit = payload.transcribed_by if payload.transcribed_by is not None else current_user.display_name
        effective_transcribed_by = (
            (raw_credit or "").strip() if payload.include_transcribed_by else ""
        ) or None

        if payload.format == "midi":
            content = score_data_to_midi_bytes(score)
        elif payload.format == "musicxml":
            xml_out = score_data_to_musicxml(score, include_chords=payload.include_chords)
            if effective_transcribed_by:
                xml_out = apply_scribasheet_musicxml_branding(
                    xml_out,
                    title=score.title,
                    transcribed_by=effective_transcribed_by,
                )
            content = xml_out.encode("utf-8")
        elif payload.format == "pdf":
            content = _resolve_pdf_export_bytes(
                db,
                project.id,
                score_row.version,
                score,
                include_chords=payload.include_chords,
                musicxml_path=score_row.musicxml_path,
                transcribed_by=effective_transcribed_by,
            )
        elif payload.format == "wav":
            content = render_score_wav(score)
        elif payload.format in ("soprano_mp3", "alto_mp3", "tenor_mp3", "bass_mp3"):
            from app.notation.satb_audio import (
                infer_satb_voice_assignments,
                render_satb_audio_tracks,
            )

            voice_name = payload.format.split("_", 1)[0]
            resolved = infer_satb_voice_assignments(score)
            if voice_name not in {v for v in resolved.values() if v}:
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                    detail=f"SATB voice '{voice_name}' is not assigned to any part in this score.",
                )
            rendered = render_satb_audio_tracks(score, output_format="mp3")
            if voice_name not in rendered:
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                    detail=f"SATB voice '{voice_name}' could not be rendered.",
                )
            content = rendered[voice_name]
        else:
            raise ValueError(f"Unsupported export format: {payload.format}")

        key = storage_service.build_key(current_user.id, project.id, "exports", f"export.{ext}")
        storage_service.save_bytes(key, content, content_type=mime_type)

        export.status = "completed"
        export.storage_path = key
        export.completed_at = datetime.now(UTC)
        db.commit()
        db.refresh(export)
    except Exception as exc:
        export.status = "failed"
        export.error_message = str(exc)
        export.completed_at = datetime.now(UTC)
        db.commit()
        db.refresh(export)
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=f"Export failed: {exc}")

    settings = get_settings()
    return ExportResponse(
        id=export.id,
        project_id=export.project_id,
        format=export.format,
        status=export.status,
        error_message=export.error_message,
        download_url=f"{settings.API_V1_PREFIX}/exports/{export.id}/download",
        created_at=export.created_at,
        completed_at=export.completed_at,
    )


@router.get("/exports/{export_id}", response_model=ExportResponse)
def get_export(
    export_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    export = db.query(Export).filter(Export.id == export_id).first()
    if not export:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Export not found.")
    if export.user_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied.")

    settings = get_settings()
    return ExportResponse(
        id=export.id,
        project_id=export.project_id,
        format=export.format,
        status=export.status,
        error_message=export.error_message,
        download_url=f"{settings.API_V1_PREFIX}/exports/{export.id}/download" if export.status == "completed" else None,
        created_at=export.created_at,
        completed_at=export.completed_at,
    )


@router.get("/exports/{export_id}/download")
def download_export(
    export_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    export = db.query(Export).filter(Export.id == export_id).first()
    if not export:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Export not found.")
    if export.user_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied.")
    if export.status != "completed" or not export.storage_path:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Export is not ready for download.")

    project = db.query(Project).filter(Project.id == export.project_id).first()
    base_name = sanitize_filename(clean_score_title(project.title if project else "scribasheet_score"))
    mime_type, ext = EXPORT_MIME_TYPES.get(export.format, ("application/octet-stream", "bin"))
    if export.format in ("soprano_mp3", "alto_mp3", "tenor_mp3", "bass_mp3"):
        voice_label = export.format.split("_", 1)[0].capitalize()
        download_filename = f"{voice_label}.mp3"
    else:
        download_filename = f"{base_name}.{ext}"
    try:
        data = storage_service.read_bytes(export.storage_path)
    except FileNotFoundError:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Exported file not found in storage.")

    return Response(
        content=data,
        media_type=mime_type,
        headers={"Content-Disposition": f'attachment; filename="{download_filename}"'},
    )


class SATBExportRequest(BaseModel):
    part: Literal["soprano", "alto", "tenor", "bass", "combined"] = "combined"
    format: Literal["mp3", "wav"] = "mp3"
    volumes: dict[str, float] | None = None
    instruments: dict[str, int] | None = None
    voice_assignments: dict[int | str, str] | None = None
    tempo_bpm: float | None = None
    start_measure: int | None = None
    end_measure: int | None = None


@router.post("/projects/{project_id}/exports/satb")
def export_satb_audio(
    payload: SATBExportRequest,
    project: Project = Depends(get_owned_project),
    db: Session = Depends(get_db),
):
    """Render and download individual or combined SATB MP3/WAV practice tracks."""
    score_row = db.query(ProjectScore).filter(ProjectScore.project_id == project.id).first()
    if not score_row:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cannot export SATB audio before a score exists.",
        )

    score = ScoreData(**score_row.score_json)
    score.title = clean_score_title(project.title)
    from app.notation.satb_audio import infer_satb_voice_assignments, render_satb_audio_tracks

    if payload.part != "combined":
        resolved = infer_satb_voice_assignments(score, override_assignments=payload.voice_assignments)
        assigned_voices = {v for v in resolved.values() if v}
        if payload.part not in assigned_voices:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail=f"SATB voice '{payload.part}' is not assigned to any part in this score.",
            )

    rendered = render_satb_audio_tracks(
        score,
        part_volumes=payload.volumes,
        part_instruments=payload.instruments,
        voice_assignments=payload.voice_assignments,
        tempo_bpm=payload.tempo_bpm,
        start_measure=payload.start_measure,
        end_measure=payload.end_measure,
        output_format=payload.format,
    )
    if payload.part not in rendered:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=f"SATB voice '{payload.part}' is not assigned to any part in this score.",
        )

    safe_title = sanitize_filename(project.title).rsplit(".", 1)[0].replace(" ", "_") or "Song_Title"
    part_label = "SATB_Combined" if payload.part == "combined" else payload.part.capitalize()
    filename = f"{safe_title}_{part_label}.{payload.format}"
    mime_type = "audio/mpeg" if payload.format == "mp3" else "audio/wav"
    return Response(
        content=rendered[payload.part],
        media_type=mime_type,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
