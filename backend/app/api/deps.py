from datetime import UTC, datetime

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.security import decode_token
from app.db.session import get_db
from app.models import Export, MediaAsset, Project, ProjectScore, UsageRecord, User
from app.storage.service import storage_service

bearer_scheme = HTTPBearer(auto_error=False)

# Note: Storage capacity and project count are uncapped at the application level;
# only monthly AI transcription compute minutes vary by plan tier.
PLAN_LIMITS: dict[str, dict[str, float]] = {
    "free": {
        "monthly_minutes": 30.0,
    },
    "pro": {
        "monthly_minutes": 300.0,
    },
    "studio": {
        "monthly_minutes": 1500.0,
    },
}


def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
    db: Session = Depends(get_db),
) -> User:
    if not credentials or not credentials.credentials:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    try:
        payload = decode_token(credentials.credentials)
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired authentication token.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    if payload.get("type") not in (None, "access"):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token type.")

    user_id = payload.get("sub")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token subject.")

    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User account not found.")
    return user


def get_owned_project(
    project_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Project:
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found.")
    if project.user_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="You do not have access to this project.")
    return project


def is_user_unlimited(user: User) -> bool:
    """Resolve unlimited entitlement exclusively on the backend from ADMIN_EMAILS or plan_tier."""
    email_norm = (user.email or "").strip().lower()
    if email_norm and email_norm in get_settings().admin_email_set:
        return True
    return (user.plan_tier or "").strip().lower() == "unlimited"


def get_user_plan_label(user: User) -> str:
    if is_user_unlimited(user):
        return "UNLIMITED"
    return (user.plan_tier or "free").strip().upper()


def delete_unreferenced_storage_keys(db: Session, keys: list[str | None]) -> None:
    """Delete replaced score/export storage keys only if no MediaAsset row still references them."""
    unique_keys = [k for k in dict.fromkeys(keys) if k]
    if not unique_keys:
        return
    referenced = {
        row[0]
        for row in db.query(MediaAsset.storage_path).filter(MediaAsset.storage_path.in_(unique_keys)).all()
    }
    for key in unique_keys:
        if key not in referenced:
            try:
                storage_service.delete(key)
            except Exception:
                pass


def get_user_usage_metrics(db: Session, user: User) -> dict[str, float | int | str | bool | None]:
    limits = PLAN_LIMITS.get(user.plan_tier, PLAN_LIMITS["free"])
    unlimited = is_user_unlimited(user)
    month_start = datetime.now(UTC).replace(day=1, hour=0, minute=0, second=0, microsecond=0)

    minutes_used = (
        db.query(func.coalesce(func.sum(UsageRecord.quantity), 0.0))
        .filter(
            UsageRecord.user_id == user.id,
            UsageRecord.operation == "transcription_minutes",
            UsageRecord.created_at >= month_start,
        )
        .scalar()
        or 0.0
    )
    project_count = db.query(func.count(Project.id)).filter(Project.user_id == user.id).scalar() or 0

    seen_paths: set[str] = set()
    total_bytes = 0
    is_obj_storage = storage_service.is_object_storage

    media_rows = (
        db.query(MediaAsset.storage_path, MediaAsset.size_bytes)
        .filter(MediaAsset.user_id == user.id)
        .all()
    )
    for storage_path, size_bytes in media_rows:
        if not storage_path or storage_path in seen_paths:
            continue
        seen_paths.add(storage_path)
        actual_size = storage_service.get_object_size(storage_path) if not is_obj_storage else None
        total_bytes += int(actual_size if actual_size is not None else (size_bytes or 0))

    score_rows = (
        db.query(ProjectScore.musicxml_path, ProjectScore.midi_path)
        .join(Project, Project.id == ProjectScore.project_id)
        .filter(Project.user_id == user.id)
        .all()
    )
    for xml_path, midi_path in score_rows:
        for path in (xml_path, midi_path):
            if not path or path in seen_paths:
                continue
            seen_paths.add(path)
            if not is_obj_storage:
                actual_size = storage_service.get_object_size(path)
                if actual_size is not None:
                    total_bytes += int(actual_size)

    export_rows = (
        db.query(Export.storage_path)
        .filter(Export.user_id == user.id, Export.status == "completed")
        .all()
    )
    for (export_path,) in export_rows:
        if not export_path or export_path in seen_paths:
            continue
        seen_paths.add(export_path)
        if not is_obj_storage:
            actual_size = storage_service.get_object_size(export_path)
            if actual_size is not None:
                total_bytes += int(actual_size)

    health = storage_service.get_storage_health()
    vol_free = health.get("volume_free_bytes")
    vol_total = health.get("volume_total_bytes")

    return {
        "plan_tier": user.plan_tier,
        "plan_label": get_user_plan_label(user),
        "is_unlimited": unlimited,
        "monthly_minutes_used": round(float(minutes_used), 2),
        "monthly_minutes_limit": float(limits["monthly_minutes"]),
        "project_count": int(project_count),
        "project_limit": None,
        "file_count": len(seen_paths),
        "storage_used_bytes": int(total_bytes),
        "storage_used_mb": round(float(total_bytes) / (1024 * 1024), 2),
        "storage_limit_mb": None,
        "storage_quota_enforced": False,
        "storage_backend": str(health.get("backend") or "local"),
        "storage_status": str(health.get("status") or "available"),
        "storage_volume_free_mb": round(float(vol_free) / (1024 * 1024), 2) if vol_free is not None else None,
        "storage_volume_total_mb": round(float(vol_total) / (1024 * 1024), 2) if vol_total is not None else None,
    }
