from fastapi import APIRouter, Body, Depends, HTTPException, Query, status
from sqlalchemy import asc, desc
from sqlalchemy.orm import Session, joinedload

from app.api.deps import PLAN_LIMITS, get_current_user, get_owned_project, is_user_unlimited
from app.api.v1.worker import ACTIVE_WORKER_STATUSES
from app.audio.extraction_service import ensure_extracted_audio_asset
from app.core.config import get_settings
from app.db.session import get_db
from app.models import MediaAsset, Project, ProjectScore, TranscriptionJob, User
from app.notation.generator import apply_scribasheet_musicxml_branding, resolve_project_score_title
from app.schemas.project import (
    ExtractAudioRequest,
    ExtractAudioResponse,
    ExtractedAudioItem,
    MediaAssetResponse,
    ProjectCreateRequest,
    ProjectListResponse,
    ProjectResponse,
    ProjectUpdateRequest,
)
from app.storage.service import sanitize_download_title, storage_service

router = APIRouter(prefix="/projects", tags=["Projects"])


@router.get("", response_model=ProjectListResponse)
def list_projects(
    search: str | None = Query(default=None, max_length=200),
    status_filter: str | None = Query(default=None, alias="status"),
    sort_by: str = Query(default="updated_at", pattern="^(updated_at|created_at|title)$"),
    sort_dir: str = Query(default="desc", pattern="^(asc|desc)$"),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    query = (
        db.query(Project)
        .options(joinedload(Project.media_assets))
        .filter(Project.user_id == current_user.id)
    )
    if search:
        term = f"%{search.strip()}%"
        query = query.filter(Project.title.ilike(term))
    if status_filter and status_filter != "all":
        query = query.filter(Project.status == status_filter)

    total = query.count()
    sort_col = getattr(Project, sort_by)
    order_fn = asc if sort_dir == "asc" else desc
    items = (
        query.order_by(order_fn(sort_col))
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    return ProjectListResponse(items=items, total=total, page=page, page_size=page_size)


@router.post("", response_model=ProjectResponse, status_code=status.HTTP_201_CREATED)
def create_project(
    payload: ProjectCreateRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if not is_user_unlimited(current_user):
        limits = PLAN_LIMITS.get(current_user.plan_tier, PLAN_LIMITS["free"])
        current_count = db.query(Project).filter(Project.user_id == current_user.id).count()
        if current_count >= int(limits["projects"]):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Project limit reached ({limits['projects']}) for your {current_user.plan_tier} plan.",
            )

    project = Project(
        user_id=current_user.id,
        title=payload.title.strip(),
        description=payload.description.strip(),
        instrument=payload.instrument,
        transcription_mode=payload.transcription_mode,
        status="draft",
    )
    db.add(project)
    db.commit()
    db.refresh(project)
    return project


@router.get("/{project_id}", response_model=ProjectResponse)
def get_project(
    project: Project = Depends(get_owned_project),
):
    return project


@router.patch("/{project_id}", response_model=ProjectResponse)
def update_project(
    payload: ProjectUpdateRequest,
    project: Project = Depends(get_owned_project),
    db: Session = Depends(get_db),
):
    if payload.title is not None:
        new_title = payload.title.strip()
        if new_title != project.title:
            project.title = new_title
            if project.score is not None:
                resolved_title = resolve_project_score_title(new_title)
                updated_score = dict(project.score.score_json or {})
                updated_score["title"] = resolved_title
                project.score.score_json = updated_score
                project.score.version = int(project.score.version or 1) + 1
                if project.score.musicxml_path and not project.score.musicxml_path.lower().endswith(".mxl"):
                    try:
                        if storage_service.exists(project.score.musicxml_path):
                            raw_xml = storage_service.read_bytes(project.score.musicxml_path).decode(
                                "utf-8-sig",
                                errors="replace",
                            )
                            branded_xml = apply_scribasheet_musicxml_branding(
                                raw_xml,
                                title=resolved_title,
                                force_title=True,
                            )
                            storage_service.save_bytes(
                                project.score.musicxml_path,
                                branded_xml.encode("utf-8"),
                                content_type="application/vnd.recordare.musicxml+xml",
                            )
                    except Exception:
                        pass
    if payload.description is not None:
        project.description = payload.description.strip()
    if payload.instrument is not None:
        project.instrument = payload.instrument
    if payload.transcription_mode is not None:
        project.transcription_mode = payload.transcription_mode
    db.commit()
    db.refresh(project)
    return project


@router.post("/{project_id}/duplicate", response_model=ProjectResponse, status_code=status.HTTP_201_CREATED)
def duplicate_project(
    project: Project = Depends(get_owned_project),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    copy = Project(
        user_id=current_user.id,
        title=f"{project.title} (Copy)"[:200],
        description=project.description,
        instrument=project.instrument,
        transcription_mode=project.transcription_mode,
        duration_seconds=project.duration_seconds,
        status="ready" if project.score else "draft",
    )
    db.add(copy)
    db.flush()

    if project.score:
        db.add(
            ProjectScore(
                project_id=copy.id,
                version=1,
                score_json=project.score.score_json,
                musicxml_path=project.score.musicxml_path,
                midi_path=project.score.midi_path,
            )
        )

    db.commit()
    db.refresh(copy)
    return copy


@router.delete("/{project_id}/media/{asset_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_project_media_asset(
    asset_id: str,
    project: Project = Depends(get_owned_project),
    db: Session = Depends(get_db),
):
    """Delete an uploaded original media asset from a project while preserving any existing score."""
    asset = (
        db.query(MediaAsset)
        .filter(MediaAsset.id == asset_id, MediaAsset.project_id == project.id)
        .first()
    )
    if not asset:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Media asset not found.")
    if asset.asset_type != "original":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Only original uploaded media assets can be removed.",
        )

    active_statuses = ("queued", *ACTIVE_WORKER_STATUSES)
    active_job = (
        db.query(TranscriptionJob.id)
        .filter(
            TranscriptionJob.project_id == project.id,
            TranscriptionJob.status.in_(active_statuses),
        )
        .first()
    )
    if active_job:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Cannot remove audio while a transcription job is queued or actively processing.",
        )

    try:
        storage_service.delete(asset.storage_path)
    except FileNotFoundError:
        pass

    linked_extracted = (
        db.query(MediaAsset)
        .filter(
            MediaAsset.project_id == project.id,
            MediaAsset.asset_type == "extracted_audio",
            MediaAsset.storage_path.contains(f"/extracted/{asset.id}/"),
        )
        .all()
    )
    linked_ids = [item.id for item in linked_extracted]
    for item in linked_extracted:
        try:
            storage_service.delete(item.storage_path)
        except FileNotFoundError:
            pass

    affected_asset_ids = [asset.id, *linked_ids]
    (
        db.query(TranscriptionJob)
        .filter(TranscriptionJob.source_asset_id.in_(affected_asset_ids))
        .update({TranscriptionJob.source_asset_id: None}, synchronize_session=False)
    )
    for item in linked_extracted:
        db.delete(item)
    db.delete(asset)
    db.flush()

    remaining_original = (
        db.query(MediaAsset)
        .filter(MediaAsset.project_id == project.id, MediaAsset.asset_type == "original")
        .order_by(MediaAsset.created_at.desc())
        .first()
    )
    if remaining_original:
        project.duration_seconds = remaining_original.duration_seconds
    elif project.score is None:
        project.duration_seconds = None
        project.status = "draft"
    else:
        project.duration_seconds = None
        if project.status != "ready":
            project.status = "ready"

    db.commit()
    return None


@router.post("/{project_id}/media/{asset_id}/extract-audio", response_model=ExtractAudioResponse)
def extract_video_audio(
    asset_id: str,
    payload: ExtractAudioRequest = Body(default_factory=ExtractAudioRequest),
    project: Project = Depends(get_owned_project),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Extract downloadable MP3 and/or 16-bit PCM WAV audio from an uploaded video without altering the video."""
    asset = (
        db.query(MediaAsset)
        .filter(MediaAsset.id == asset_id, MediaAsset.project_id == project.id)
        .first()
    )
    if not asset:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Media asset not found.")
    if asset.asset_type != "original":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Audio extraction can only be run on an uploaded source video.",
        )

    settings = get_settings()
    requested_formats = list(dict.fromkeys(payload.formats))
    title_base = sanitize_download_title(project.title)
    extracted_assets: list[MediaAsset] = []
    mp3_item: ExtractedAudioItem | None = None
    wav_item: ExtractedAudioItem | None = None

    for fmt in requested_formats:
        extracted = ensure_extracted_audio_asset(
            db,
            project=project,
            user=current_user,
            source_asset=asset,
            fmt=fmt,
            force=payload.force,
        )
        extracted_assets.append(extracted)
        item = ExtractedAudioItem(
            id=extracted.id,
            format=fmt,
            filename=f"{title_base}.{fmt}",
            mime_type=extracted.mime_type,
            size_bytes=extracted.size_bytes,
            duration_seconds=extracted.duration_seconds,
            sample_rate=extracted.sample_rate,
            channels=extracted.channels,
            download_url=f"{settings.API_V1_PREFIX}/uploads/{extracted.id}/download",
        )
        if fmt == "mp3":
            mp3_item = item
        else:
            wav_item = item

    return ExtractAudioResponse(
        source_asset_id=asset.id,
        mp3=mp3_item,
        wav=wav_item,
        assets=[MediaAssetResponse.model_validate(a) for a in extracted_assets],
    )


@router.delete("/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_project(
    project: Project = Depends(get_owned_project),
    db: Session = Depends(get_db),
):
    for asset in project.media_assets:
        try:
            storage_service.delete(asset.storage_path)
        except Exception:
            pass
    db.delete(project)
    db.commit()
    return None
