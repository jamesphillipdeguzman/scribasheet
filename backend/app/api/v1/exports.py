from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, get_owned_project
from app.core.config import get_settings
from app.db.session import get_db
from app.models import Export, Project, ProjectScore, User
from app.notation.generator import (
    render_score_pdf,
    render_score_wav,
    score_data_to_midi_bytes,
    score_data_to_musicxml,
)
from app.schemas.export import ExportCreateRequest, ExportResponse
from app.schemas.score import ScoreData
from app.storage.service import sanitize_filename, storage_service

router = APIRouter(tags=["Exports"])

EXPORT_MIME_TYPES = {
    "midi": ("audio/midi", "mid"),
    "musicxml": ("application/vnd.recordare.musicxml+xml", "musicxml"),
    "pdf": ("application/pdf", "pdf"),
    "wav": ("audio/wav", "wav"),
}


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
        mime_type, ext = EXPORT_MIME_TYPES[payload.format]

        if payload.format == "midi":
            content = score_data_to_midi_bytes(score)
        elif payload.format == "musicxml":
            content = score_data_to_musicxml(score).encode("utf-8")
        elif payload.format == "pdf":
            content = render_score_pdf(score)
        elif payload.format == "wav":
            content = render_score_wav(score)
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
    base_name = sanitize_filename(project.title if project else "scribasheet_score")
    mime_type, ext = EXPORT_MIME_TYPES.get(export.format, ("application/octet-stream", "bin"))
    data = storage_service.read_bytes(export.storage_path)

    return Response(
        content=data,
        media_type=mime_type,
        headers={"Content-Disposition": f'attachment; filename="{base_name}.{ext}"'},
    )
