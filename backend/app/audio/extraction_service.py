"""Shared video-to-audio extraction service used by project media and Export Center endpoints."""

from __future__ import annotations

import tempfile
import threading
from pathlib import Path
from typing import Literal

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.api.v1.uploads import _enforce_storage_quota
from app.audio.processor import (
    MediaValidationError,
    extract_audio_from_video,
    is_supported_video_file,
)
from app.models import MediaAsset, Project, User
from app.storage.service import sanitize_download_title, storage_service

EXTRACTED_AUDIO_MIME_TYPES: dict[Literal["mp3", "wav"], str] = {
    "mp3": "audio/mpeg",
    "wav": "audio/wav",
}

_locks_guard = threading.Lock()
_extraction_locks: dict[tuple[str, str], threading.Lock] = {}


def _get_extraction_lock(project_id: str, source_asset_id: str) -> threading.Lock:
    key = (project_id, source_asset_id)
    with _locks_guard:
        lock = _extraction_locks.get(key)
        if lock is None:
            lock = threading.Lock()
            _extraction_locks[key] = lock
        return lock


def find_extracted_asset(
    db: Session,
    project_id: str,
    source_asset_id: str,
    fmt: Literal["mp3", "wav"],
) -> MediaAsset | None:
    """Find an existing non-deleted extracted audio asset for the given video source."""
    expected_mime = EXTRACTED_AUDIO_MIME_TYPES[fmt]
    prefix_token = f"/extracted/{source_asset_id}/"
    candidates = (
        db.query(MediaAsset)
        .filter(
            MediaAsset.project_id == project_id,
            MediaAsset.asset_type == "extracted_audio",
            MediaAsset.mime_type == expected_mime,
            MediaAsset.storage_path.contains(prefix_token),
        )
        .order_by(MediaAsset.created_at.desc())
        .all()
    )
    for row in candidates:
        if storage_service.exists(row.storage_path):
            return row
    return None


def ensure_extracted_audio_asset(
    db: Session,
    *,
    project: Project,
    user: User,
    source_asset: MediaAsset,
    fmt: Literal["mp3", "wav"],
    force: bool = False,
) -> MediaAsset:
    """Extract MP3 or WAV from an uploaded video MediaAsset, preserving the original video."""
    if not is_supported_video_file(source_asset.original_filename, source_asset.mime_type):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Audio extraction is only available for uploaded video files (MP4, MOV, WEBM, MKV).",
        )

    lock = _get_extraction_lock(project.id, source_asset.id)
    with lock:
        existing = find_extracted_asset(db, project.id, source_asset.id, fmt)
        if existing is not None and not force:
            return existing

        try:
            local_video_path = storage_service.get_local_file_path(source_asset.storage_path)
        except FileNotFoundError as exc:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Source video file was not found in storage.",
            ) from exc

        mime_type = EXTRACTED_AUDIO_MIME_TYPES[fmt]
        with tempfile.TemporaryDirectory(prefix="scriba_extract_") as tmpdir:
            out_path = Path(tmpdir) / f"extracted.{fmt}"
            try:
                out_meta = extract_audio_from_video(local_video_path, out_path, fmt)
            except MediaValidationError as exc:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=exc.message,
                ) from exc

            out_size = out_path.stat().st_size
            _enforce_storage_quota(db, user, out_size)

            storage_key = storage_service.build_key(
                user.id,
                project.id,
                f"extracted/{source_asset.id}",
                f"audio.{fmt}",
            )
            with out_path.open("rb") as f:
                storage_service.save_stream(storage_key, f, content_type=mime_type)

        download_name = f"{sanitize_download_title(project.title)}.{fmt}"
        if existing is not None and force:
            old_key = existing.storage_path
            existing.storage_path = storage_key
            existing.original_filename = download_name
            existing.mime_type = mime_type
            existing.size_bytes = out_size
            existing.duration_seconds = out_meta.duration_seconds
            existing.sample_rate = out_meta.sample_rate
            existing.channels = out_meta.channels
            db.commit()
            db.refresh(existing)
            if old_key != storage_key:
                try:
                    storage_service.delete(old_key)
                except Exception:
                    pass
            return existing

        extracted = MediaAsset(
            project_id=project.id,
            user_id=user.id,
            asset_type="extracted_audio",
            storage_path=storage_key,
            original_filename=download_name,
            mime_type=mime_type,
            size_bytes=out_size,
            duration_seconds=out_meta.duration_seconds,
            sample_rate=out_meta.sample_rate,
            channels=out_meta.channels,
        )
        db.add(extracted)
        db.commit()
        db.refresh(extracted)
        return extracted
