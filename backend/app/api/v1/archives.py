"""API endpoints for portable `.scribasheet` project archive export, validation, and restore."""

from __future__ import annotations

import shutil
import tempfile
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile, status
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session
from starlette.background import BackgroundTask

from app.api.deps import get_current_user, get_owned_project
from app.db.session import get_db
from app.models import Project, User
from app.schemas.project import ProjectResponse
from app.storage.archive_service import (
    MAX_ARCHIVE_UPLOAD_BYTES,
    ArchiveExportError,
    ArchiveValidationError,
    build_project_archive,
    get_project_archive_summary,
    restore_project_from_archive,
    validate_archive_file,
)
from app.storage.service import translate_os_storage_error

router = APIRouter(tags=["Project Archives"])


async def _stream_archive_to_temp(file: UploadFile) -> Path:
    filename = (file.filename or "archive.scribasheet").strip()
    if not filename.lower().endswith((".scribasheet", ".zip")):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Please select a valid .scribasheet project archive file.",
        )
    total = 0
    tmp_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=".scribasheet") as tmp:
            tmp_path = Path(tmp.name)
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_ARCHIVE_UPLOAD_BYTES:
                    raise HTTPException(
                        status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                        detail=f"Archive exceeds maximum upload safeguard ({MAX_ARCHIVE_UPLOAD_BYTES // (1024 * 1024)} MB).",
                    )
                tmp.write(chunk)
        return tmp_path
    except HTTPException:
        if tmp_path is not None:
            tmp_path.unlink(missing_ok=True)
        raise
    except OSError as exc:
        if tmp_path is not None:
            tmp_path.unlink(missing_ok=True)
        raise translate_os_storage_error(exc, "archive buffering", filename) from exc
    except Exception:
        if tmp_path is not None:
            tmp_path.unlink(missing_ok=True)
        raise


@router.get("/projects/{project_id}/archive/summary")
def archive_summary(
    include_audio: bool = Query(default=True),
    project: Project = Depends(get_owned_project),
    db: Session = Depends(get_db),
):
    return get_project_archive_summary(db, project, include_audio=include_audio)


@router.get("/projects/{project_id}/archive")
def export_project_archive(
    include_audio: bool = Query(default=True),
    project: Project = Depends(get_owned_project),
    db: Session = Depends(get_db),
):
    try:
        tmp_dir, archive_path, download_name, manifest = build_project_archive(
            db,
            project,
            include_audio=include_audio,
        )
    except ArchiveExportError as exc:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(exc)) from exc

    return FileResponse(
        path=str(archive_path),
        media_type="application/vnd.scribasheet.archive+zip",
        filename=download_name,
        headers={
            "X-Archive-Included-Media": "true" if manifest.get("included_media") else "false",
            "X-Archive-File-Count": str(len(manifest.get("included_files") or [])),
        },
        background=BackgroundTask(shutil.rmtree, str(tmp_dir), True),
    )


@router.post("/archives/validate")
async def validate_uploaded_archive(
    file: UploadFile = File(...),
    _current_user: User = Depends(get_current_user),
):
    tmp_path = await _stream_archive_to_temp(file)
    try:
        bundle = validate_archive_file(tmp_path)
        return bundle["preview"]
    except ArchiveValidationError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    finally:
        tmp_path.unlink(missing_ok=True)


@router.post("/archives/import", response_model=ProjectResponse, status_code=status.HTTP_201_CREATED)
async def import_uploaded_archive(
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    tmp_path = await _stream_archive_to_temp(file)
    try:
        return restore_project_from_archive(db, current_user, tmp_path)
    except ArchiveValidationError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    finally:
        tmp_path.unlink(missing_ok=True)
