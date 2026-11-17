from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import asc, desc
from sqlalchemy.orm import Session, joinedload

from app.api.deps import PLAN_LIMITS, get_current_user, get_owned_project, is_user_unlimited
from app.api.v1.worker import ACTIVE_WORKER_STATUSES
from app.db.session import get_db
from app.models import MediaAsset, Project, ProjectScore, TranscriptionJob, User
from app.schemas.project import (
    ProjectCreateRequest,
    ProjectListResponse,
    ProjectResponse,
    ProjectUpdateRequest,
)
from app.storage.service import storage_service

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
        project.title = payload.title.strip()
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

    (
        db.query(TranscriptionJob)
        .filter(TranscriptionJob.source_asset_id == asset.id)
        .update({TranscriptionJob.source_asset_id: None}, synchronize_session=False)
    )
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
