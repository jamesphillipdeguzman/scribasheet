from datetime import UTC, datetime

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.security import decode_token
from app.db.session import get_db
from app.models import MediaAsset, Project, UsageRecord, User

bearer_scheme = HTTPBearer(auto_error=False)

PLAN_LIMITS: dict[str, dict[str, float | int]] = {
    "free": {
        "monthly_minutes": 30.0,
        "projects": 15,
        "storage_mb": 250.0,
    },
    "pro": {
        "monthly_minutes": 300.0,
        "projects": 200,
        "storage_mb": 5120.0,
    },
    "studio": {
        "monthly_minutes": 1500.0,
        "projects": 2000,
        "storage_mb": 25600.0,
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


def get_user_usage_metrics(db: Session, user: User) -> dict[str, float | int | str]:
    limits = PLAN_LIMITS.get(user.plan_tier, PLAN_LIMITS["free"])
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
    storage_bytes = (
        db.query(func.coalesce(func.sum(MediaAsset.size_bytes), 0))
        .filter(MediaAsset.user_id == user.id)
        .scalar()
        or 0
    )
    return {
        "plan_tier": user.plan_tier,
        "monthly_minutes_used": round(float(minutes_used), 2),
        "monthly_minutes_limit": float(limits["monthly_minutes"]),
        "project_count": int(project_count),
        "project_limit": int(limits["projects"]),
        "storage_used_mb": round(float(storage_bytes) / (1024 * 1024), 2),
        "storage_limit_mb": float(limits["storage_mb"]),
    }
