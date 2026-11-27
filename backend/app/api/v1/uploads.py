import tempfile
from pathlib import Path
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile, status
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.api.v1.worker import ACTIVE_WORKER_STATUSES
from app.audio.processor import (
    MediaValidationError,
    probe_media,
    validate_upload_extension_and_mime,
)
from app.core.config import get_settings
from app.core.security import verify_signed_download_token
from app.db.session import get_db
from app.models import MediaAsset, Project, TranscriptionJob, User
from app.notation.image_preprocessing import (
    SUPPORTED_SHEET_IMAGE_MIMES,
    SheetImageValidationError,
    is_supported_sheet_image_filename,
    is_supported_sheet_image_mime,
    validate_sheet_image_bytes,
)
from app.notation.omr import OMRError, validate_pdf_bytes
from app.schemas.project import MediaAssetResponse
from app.storage.service import (
    sanitize_download_title,
    sanitize_filename,
    storage_service,
    translate_os_storage_error,
)

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


def _is_video_asset(asset: MediaAsset) -> bool:
    name = (asset.original_filename or "").strip().lower()
    mime = (asset.mime_type or "").strip().lower()
    if name.startswith(("mic-recording-", "tab-audio-")):
        return False
    if name.endswith((".mp4", ".mov", ".mkv")):
        return True
    if name.endswith(".webm"):
        return not mime.startswith("audio/")
    return mime.startswith("video/")


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

    if payload.size_bytes <= 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="File size must be greater than 0 bytes.",
        )
    if payload.size_bytes > settings.max_upload_bytes:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"File size must not exceed {settings.MAX_UPLOAD_SIZE_MB} MB.",
        )

    safe_name = sanitize_filename(payload.filename)
    lower_name = safe_name.lower()
    is_pdf = lower_name.endswith(".pdf")
    is_musicxml = lower_name.endswith((".mxl", ".musicxml"))
    is_sheet_image = is_supported_sheet_image_filename(safe_name)
    if is_pdf:
        if payload.content_type and "pdf" not in payload.content_type.lower():
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Unsupported MIME type '{payload.content_type}' for PDF upload.",
            )
    elif is_musicxml:
        pass
    elif is_sheet_image:
        clean_mime = (payload.content_type or "").split(";", 1)[0].strip().lower()
        if clean_mime and clean_mime not in SUPPORTED_SHEET_IMAGE_MIMES | {
            "application/octet-stream",
            "binary/octet-stream",
        }:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Unsupported MIME type '{payload.content_type}' for sheet music image upload.",
            )
    else:
        try:
            validate_upload_extension_and_mime(safe_name, payload.content_type)
        except MediaValidationError as exc:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=exc.message)

    if not storage_service.is_object_storage:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Direct presigned uploads require STORAGE_BACKEND=r2 (or s3). Use multipart POST /api/v1/uploads for local storage.",
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

    asset_bytes = actual_size if actual_size is not None else payload.size_bytes
    safe_confirm_name = sanitize_filename(payload.filename)
    resolved_mime = payload.content_type
    if is_supported_sheet_image_filename(safe_confirm_name):
        try:
            obj_bytes = storage_service.read_bytes(payload.storage_key)
            img_info = validate_sheet_image_bytes(obj_bytes, safe_confirm_name, payload.content_type)
            resolved_mime = img_info.mime_type
        except SheetImageValidationError as exc:
            try:
                storage_service.delete(payload.storage_key)
            except Exception:
                pass
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=exc.message)
        except Exception:
            pass

    asset = MediaAsset(
        project_id=project.id,
        user_id=current_user.id,
        asset_type="original",
        storage_path=payload.storage_key,
        original_filename=safe_confirm_name,
        mime_type=resolved_mime,
        size_bytes=asset_bytes,
    )
    db.add(asset)
    db.commit()
    db.refresh(asset)
    return asset


@router.post("", response_model=MediaAssetResponse, status_code=status.HTTP_201_CREATED)
async def upload_media(
    project_id: str = Form(...),
    file: UploadFile = File(...),
    replace_asset_id: str | None = Form(default=None),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    settings = get_settings()
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found.")
    if project.user_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied to this project.")

    replace_target: MediaAsset | None = None
    will_delete_replaced = False
    if replace_asset_id:
        active_job = (
            db.query(TranscriptionJob.id)
            .filter(
                TranscriptionJob.project_id == project.id,
                TranscriptionJob.status.in_(("queued", *ACTIVE_WORKER_STATUSES)),
            )
            .first()
        )
        if active_job:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Cannot replace audio while a transcription job is queued or actively processing.",
            )
        replace_target = (
            db.query(MediaAsset)
            .filter(
                MediaAsset.id == replace_asset_id,
                MediaAsset.project_id == project.id,
                MediaAsset.user_id == current_user.id,
            )
            .first()
        )
        if replace_target is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Media asset to replace was not found.")
        will_delete_replaced = bool(
            replace_target.asset_type == "original" and not _is_video_asset(replace_target)
        )

    safe_name = sanitize_filename(file.filename or "recording.wav")
    lower_name = safe_name.lower()
    is_pdf = lower_name.endswith(".pdf")
    is_musicxml = lower_name.endswith((".mxl", ".musicxml"))
    is_sheet_image = is_supported_sheet_image_filename(safe_name)
    if is_pdf:
        if file.content_type and "pdf" not in file.content_type.lower():
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Unsupported MIME type '{file.content_type}' for PDF upload.",
            )
    elif is_musicxml:
        pass
    elif is_sheet_image:
        clean_mime = (file.content_type or "").split(";", 1)[0].strip().lower()
        if clean_mime and not is_supported_sheet_image_mime(clean_mime) and clean_mime not in {
            "application/octet-stream",
            "binary/octet-stream",
        }:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Unsupported MIME type '{file.content_type}' for sheet music image upload.",
            )
    else:
        try:
            validate_upload_extension_and_mime(safe_name, file.content_type)
        except MediaValidationError as exc:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=exc.message)

    # Stream to temp file with per-file payload safeguard
    total_bytes = 0
    suffix = Path(safe_name).suffix.lower()
    tmp_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            tmp_path = Path(tmp.name)
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
        if tmp_path is not None:
            tmp_path.unlink(missing_ok=True)
        raise
    except OSError as exc:
        if tmp_path is not None:
            tmp_path.unlink(missing_ok=True)
        raise translate_os_storage_error(exc, "upload buffering", safe_name) from exc
    except Exception:
        if tmp_path is not None:
            tmp_path.unlink(missing_ok=True)
        raise

    storage_key: str | None = None
    stored_mime = file.content_type or ("application/pdf" if is_pdf else "application/octet-stream")
    try:
        if is_pdf:
            validate_pdf_bytes(tmp_path.read_bytes())
            duration_sec = None
            sample_rate = None
            channels = None
        elif is_musicxml:
            from app.notation.omr import validate_musicxml_bytes

            try:
                validate_musicxml_bytes(tmp_path.read_bytes(), safe_name)
            except OMRError as exc:
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=exc.message) from exc
            duration_sec = None
            sample_rate = None
            channels = None
        elif is_sheet_image:
            img_info = validate_sheet_image_bytes(tmp_path.read_bytes(), safe_name, file.content_type)
            stored_mime = img_info.mime_type
            duration_sec = None
            sample_rate = None
            channels = None
        else:
            meta = probe_media(tmp_path)
            if meta.duration_seconds > settings.MAX_AUDIO_DURATION_SECONDS:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"Audio duration ({meta.duration_seconds:.1f}s) exceeds maximum allowed ({settings.MAX_AUDIO_DURATION_SECONDS}s).",
                )
            duration_sec = meta.duration_seconds
            sample_rate = meta.sample_rate
            channels = meta.channels

        storage_key = storage_service.build_key(current_user.id, project.id, "originals", safe_name)
        with tmp_path.open("rb") as f:
            storage_service.save_stream(
                storage_key,
                f,
                content_type=stored_mime,
            )
    except (MediaValidationError, OMRError, SheetImageValidationError) as exc:
        detail_msg = exc.message if hasattr(exc, "message") else str(exc)
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=detail_msg)
    finally:
        if tmp_path is not None:
            tmp_path.unlink(missing_ok=True)

    asset = MediaAsset(
        project_id=project.id,
        user_id=current_user.id,
        asset_type="original",
        storage_path=storage_key,
        original_filename=safe_name,
        mime_type=stored_mime,
        size_bytes=total_bytes,
        duration_seconds=duration_sec,
        sample_rate=sample_rate,
        channels=channels,
    )
    if duration_sec is not None:
        project.duration_seconds = duration_sec
    db.add(asset)
    try:
        db.commit()
    except Exception:
        db.rollback()
        if storage_key:
            try:
                storage_service.delete(storage_key)
            except Exception:
                pass
        raise
    db.refresh(asset)

    # Remove replaced non-video original ONLY after new trimmed asset is committed safely
    if will_delete_replaced and replace_target is not None:
        old_path = replace_target.storage_path
        (
            db.query(TranscriptionJob)
            .filter(TranscriptionJob.source_asset_id == replace_target.id)
            .update({TranscriptionJob.source_asset_id: None}, synchronize_session=False)
        )
        db.delete(replace_target)
        db.commit()
        if old_path and old_path != storage_key:
            try:
                storage_service.delete(old_path)
            except Exception:
                pass

    return asset


@router.post("/url-check")
def check_external_video_url(
    payload: VideoUrlCheckRequest,
    current_user: User = Depends(get_current_user),
):
    """Evaluate external media URLs and fetch public YouTube oEmbed metadata without bypassing DRM."""
    raw_url = payload.url.strip()
    parsed = urlparse(raw_url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Please enter a valid http/https URL.")

    host = parsed.netloc.lower()
    if "youtube.com" in host or "youtu.be" in host:
        from urllib.parse import parse_qs

        import httpx

        video_id: str | None = None
        if "youtu.be" in host:
            video_id = parsed.path.strip("/").split("/")[0] or None
        elif parsed.path.startswith("/shorts/"):
            video_id = parsed.path.split("/shorts/", 1)[1].split("/")[0] or None
        else:
            video_id = parse_qs(parsed.query).get("v", [None])[0]

        if not video_id or len(video_id) < 6:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Please enter a valid YouTube video URL (youtube.com/watch?v=... or youtu.be/...).",
            )

        title: str | None = None
        author_name: str | None = None
        try:
            oembed_resp = httpx.get(
                "https://www.youtube.com/oembed",
                params={"url": f"https://www.youtube.com/watch?v={video_id}", "format": "json"},
                timeout=3.0,
            )
            if oembed_resp.status_code == 200:
                meta = oembed_resp.json()
                title = meta.get("title")
                author_name = meta.get("author_name")
        except Exception:
            pass

        return {
            "supported": False,
            "is_youtube": True,
            "video_id": video_id,
            "title": title,
            "author_name": author_name,
            "reason": (
                "Direct audio extraction from YouTube is disabled because ScribaSheet respects platform "
                "terms of service and DRM protections. Please upload an authorized local audio/video file "
                "(MP3, WAV, FLAC, M4A, or MP4) directly."
            ),
        }

    restricted_hosts = (
        "spotify.com",
        "music.apple.com",
        "soundcloud.com",
        "vimeo.com",
        "tiktok.com",
    )
    if any(h in host for h in restricted_hosts):
        return {
            "supported": False,
            "is_youtube": False,
            "reason": (
                f"Direct ingestion from {host} is not supported because ScribaSheet respects platform "
                "terms of service, authentication, and DRM protections. Please export or record the audio "
                "locally and upload the MP3, WAV, FLAC, M4A, or MP4 file directly."
            ),
        }

    return {
        "supported": False,
        "is_youtube": False,
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

    try:
        local_path = storage_service.get_local_file_path(asset.storage_path)
    except FileNotFoundError:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Stored media file not found.")
    return FileResponse(path=str(local_path), media_type=asset.mime_type, filename=asset.original_filename)


@router.get("/{upload_id}/download")
def download_upload(
    upload_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Download an authenticated owner's uploaded or extracted media asset."""
    asset = db.query(MediaAsset).filter(MediaAsset.id == upload_id).first()
    if not asset:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Media asset not found.")
    if asset.user_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied.")

    try:
        data = storage_service.read_bytes(asset.storage_path)
    except FileNotFoundError:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Stored media file not found.")

    if asset.asset_type == "extracted_audio":
        project = db.query(Project).filter(Project.id == asset.project_id).first()
        ext = "mp3" if "mpeg" in (asset.mime_type or "").lower() or asset.original_filename.lower().endswith(".mp3") else "wav"
        download_name = f"{sanitize_download_title(project.title if project else None)}.{ext}"
    else:
        suffix = Path(asset.original_filename).suffix
        stem = Path(asset.original_filename).stem
        download_name = f"{sanitize_download_title(stem, fallback='media')}{suffix}"

    return Response(
        content=data,
        media_type=asset.mime_type,
        headers={"Content-Disposition": f'attachment; filename="{download_name}"'},
    )


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
