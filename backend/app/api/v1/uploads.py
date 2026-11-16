import tempfile
from pathlib import Path
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile, status
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.audio.processor import (
    MediaValidationError,
    probe_media,
    validate_upload_extension_and_mime,
)
from app.core.config import get_settings
from app.core.security import verify_signed_download_token
from app.db.session import get_db
from app.models import MediaAsset, Project, User
from app.schemas.project import MediaAssetResponse
from app.storage.service import sanitize_filename, storage_service

router = APIRouter(prefix="/uploads", tags=["Uploads"])


class VideoUrlCheckRequest(BaseModel):
    url: str


class PresignUploadRequest(BaseModel):
    project_id: str
    filename: str
    content_type: str
    size_bytes: int


class ConfirmUploadRequest(BaseModel):
    project_id: str
    storage_key: str
    filename: str
    content_type: str
    size_bytes: int


@router.post("/presign")
def presign_upload(
    payload: PresignUploadRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    settings = get_settings()
    project = db.query(Project).filter(Project.id == payload.project_id).first()
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found.")
    if project.user_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied to this project.")

    if payload.size_bytes <= 0 or payload.size_bytes > settings.max_upload_bytes:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"File size must be between 1 byte and {settings.MAX_UPLOAD_SIZE_MB} MB.",
        )

    safe_name = sanitize_filename(payload.filename)
    try:
        validate_upload_extension_and_mime(safe_name, payload.content_type)
    except MediaValidationError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=exc.message)

    if storage_service.backend != "s3":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Direct presigned uploads require STORAGE_BACKEND=s3 (Cloudflare R2). Use multipart POST /api/v1/uploads for local storage.",
        )

    key = storage_service.build_key(current_user.id, project.id, "originals", safe_name)
    return storage_service.create_presigned_put_url(key, content_type=payload.content_type)


@router.post("/confirm", response_model=MediaAssetResponse, status_code=status.HTTP_201_CREATED)
def confirm_presigned_upload(
    payload: ConfirmUploadRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    settings = get_settings()
    project = db.query(Project).filter(Project.id == payload.project_id).first()
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found.")
    if project.user_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied to this project.")

    if payload.size_bytes <= 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="File size must be greater than 0 bytes.",
        )
    if payload.size_bytes > settings.max_upload_bytes:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"File exceeds maximum allowed size of {settings.MAX_UPLOAD_SIZE_MB} MB.",
        )

    expected_prefix = f"users/{current_user.id}/projects/{project.id}/originals/"
    if not payload.storage_key.startswith(expected_prefix) or ".." in payload.storage_key:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Invalid storage key for this project.")

    if not storage_service.exists(payload.storage_key):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Uploaded object not found in storage.")

    actual_size = storage_service.get_object_size(payload.storage_key)
    if actual_size is not None:
        if actual_size <= 0:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Uploaded object is empty.")
        if actual_size > settings.max_upload_bytes:
            raise HTTPException(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                detail=f"Uploaded object exceeds maximum allowed size of {settings.MAX_UPLOAD_SIZE_MB} MB.",
            )
        if actual_size != payload.size_bytes:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Uploaded object size does not match declared size.",
            )

    asset = MediaAsset(
        project_id=project.id,
        user_id=current_user.id,
        asset_type="original",
        storage_path=payload.storage_key,
        original_filename=sanitize_filename(payload.filename),
        mime_type=payload.content_type,
        size_bytes=actual_size if actual_size is not None else payload.size_bytes,
    )
    db.add(asset)
    db.commit()
    db.refresh(asset)
    return asset


@router.post("", response_model=MediaAssetResponse, status_code=status.HTTP_201_CREATED)
async def upload_media(
    project_id: str = Form(...),
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    settings = get_settings()
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found.")
    if project.user_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied to this project.")

    safe_name = sanitize_filename(file.filename or "recording.wav")
    try:
        validate_upload_extension_and_mime(safe_name, file.content_type)
    except MediaValidationError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=exc.message)

    # Stream to temp file with strict size limit enforcement
    total_bytes = 0
    suffix = Path(safe_name).suffix.lower()
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        tmp_path = Path(tmp.name)
        try:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                total_bytes += len(chunk)
                if total_bytes > settings.max_upload_bytes:
                    raise HTTPException(
                        status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                        detail=f"File exceeds maximum allowed size of {settings.MAX_UPLOAD_SIZE_MB} MB.",
                    )
                tmp.write(chunk)
        except HTTPException:
            tmp_path.unlink(missing_ok=True)
            raise

    try:
        meta = probe_media(tmp_path)
        if meta.duration_seconds > settings.MAX_AUDIO_DURATION_SECONDS:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Audio duration ({meta.duration_seconds:.1f}s) exceeds maximum allowed ({settings.MAX_AUDIO_DURATION_SECONDS}s).",
            )

        storage_key = storage_service.build_key(current_user.id, project.id, "originals", safe_name)
        with tmp_path.open("rb") as f:
            storage_service.save_stream(
                storage_key,
                f,
                content_type=file.content_type or "application/octet-stream",
            )
    except MediaValidationError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=exc.message)
    finally:
        tmp_path.unlink(missing_ok=True)

    asset = MediaAsset(
        project_id=project.id,
        user_id=current_user.id,
        asset_type="original",
        storage_path=storage_key,
        original_filename=safe_name,
        mime_type=file.content_type or "application/octet-stream",
        size_bytes=total_bytes,
        duration_seconds=meta.duration_seconds,
        sample_rate=meta.sample_rate,
        channels=meta.channels,
    )
    project.duration_seconds = meta.duration_seconds
    db.add(asset)
    db.commit()
    db.refresh(asset)
    return asset


@router.post("/url-check")
def check_external_video_url(
    payload: VideoUrlCheckRequest,
    current_user: User = Depends(get_current_user),
):
    """Honest evaluation of external media URLs without bypassing DRM or platform restrictions."""
    parsed = urlparse(payload.url.strip())
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Please enter a valid http/https URL.")

    host = parsed.netloc.lower()
    restricted_hosts = (
        "youtube.com",
        "youtu.be",
        "spotify.com",
        "music.apple.com",
        "soundcloud.com",
        "vimeo.com",
        "tiktok.com",
    )
    if any(h in host for h in restricted_hosts):
        return {
            "supported": False,
            "reason": (
                f"Direct ingestion from {host} is not supported because ScribaSheet respects platform "
                "terms of service, authentication, and DRM protections. Please export or record the audio "
                "locally and upload the MP3, WAV, FLAC, M4A, or MP4 file directly."
            ),
        }

    return {
        "supported": False,
        "reason": (
            "Remote URL fetching is disabled for security and copyright compliance. "
            "Please download your own authorized audio/video file and upload it directly."
        ),
    }


@router.get("/{upload_id}", response_model=MediaAssetResponse)
def get_upload(
    upload_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    asset = db.query(MediaAsset).filter(MediaAsset.id == upload_id).first()
    if not asset:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Media asset not found.")
    if asset.user_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied.")
    return asset


@router.get("/{upload_id}/stream")
def stream_upload(
    upload_id: str,
    sig: str | None = Query(default=None),
    exp: int | None = Query(default=None),
    db: Session = Depends(get_db),
    current_user: User | None = Depends(lambda: None),
):
    """Stream private media asset for authenticated owner or valid signed URL."""
    asset = db.query(MediaAsset).filter(MediaAsset.id == upload_id).first()
    if not asset:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Media asset not found.")

    if sig and exp is not None:
        if not verify_signed_download_token(asset.storage_path, asset.user_id, exp, sig):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Invalid or expired media signature.")
    else:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Signed media URL required.")

    local_path = storage_service.get_local_file_path(asset.storage_path)
    return FileResponse(path=str(local_path), media_type=asset.mime_type, filename=asset.original_filename)


@router.get("/{upload_id}/signed-url")
def get_signed_upload_url(
    upload_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    asset = db.query(MediaAsset).filter(MediaAsset.id == upload_id).first()
    if not asset:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Media asset not found.")
    if asset.user_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied.")

    params = storage_service.create_signed_download_params(asset.storage_path, current_user.id)
    if "url" in params:
        return params
    settings = get_settings()
    return {
        "url": f"{settings.API_V1_PREFIX}/uploads/{asset.id}/stream?sig={params['sig']}&exp={params['exp']}",
        "expires_in": settings.SIGNED_URL_TTL_SECONDS,
    }


@router.delete("/{upload_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_upload(
    upload_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    asset = db.query(MediaAsset).filter(MediaAsset.id == upload_id).first()
    if not asset:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Media asset not found.")
    if asset.user_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied.")
    storage_service.delete(asset.storage_path)
    db.delete(asset)
    db.commit()
    return None
