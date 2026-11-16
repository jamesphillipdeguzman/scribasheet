import hmac
import logging
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import update
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.db.session import get_db
from app.models import (
    MediaAsset,
    Project,
    ProjectScore,
    TranscriptionJob,
    TranscriptionResult,
    UsageRecord,
)
from app.storage.service import storage_service
from app.workers.ws_manager import job_ws_manager

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/worker", tags=["Remote Worker"])

ACTIVE_WORKER_STATUSES = (
    "validating",
    "preprocessing",
    "separating",
    "transcribing",
    "generating_notation",
    "finalizing",
)


def require_worker_token(
    authorization: str | None = Header(default=None),
    x_worker_token: str | None = Header(default=None, alias="X-Worker-Token"),
) -> str:
    settings = get_settings()
    expected = settings.WORKER_API_TOKEN
    if not expected:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Worker authentication is not configured on the server.",
        )

    token = x_worker_token
    if not token and authorization and authorization.lower().startswith("bearer "):
        token = authorization[7:].strip()

    if not token or not hmac.compare_digest(token, expected):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid worker authentication token.",
        )
    return token


def _utcnow() -> datetime:
    return datetime.now(UTC)


def _validate_project_key(key: str | None, user_id: str, project_id: str) -> str | None:
    if not key:
        return None
    expected_prefix = f"users/{user_id}/projects/{project_id}/"
    if not key.startswith(expected_prefix) or ".." in key:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Artifact storage key does not belong to the claimed job's project.",
        )
    return key


class WorkerClaimRequest(BaseModel):
    worker_id: str = Field(min_length=1, max_length=128)


class WorkerHeartbeatRequest(BaseModel):
    worker_id: str = Field(min_length=1, max_length=128)


class WorkerProgressRequest(BaseModel):
    worker_id: str = Field(min_length=1, max_length=128)
    status: str = Field(min_length=1, max_length=32)
    progress: int = Field(ge=0, le=100)
    current_stage: str = Field(min_length=1, max_length=64)
    log_line: str | None = Field(default=None, max_length=1000)


class WorkerCompleteRequest(BaseModel):
    worker_id: str = Field(min_length=1, max_length=128)
    midi_key: str | None = None
    musicxml_key: str | None = None
    score_json: dict[str, Any] = Field(default_factory=dict)
    duration_seconds: float | None = Field(default=None, ge=0.0)
    metadata_json: dict[str, Any] = Field(default_factory=dict)


class WorkerFailRequest(BaseModel):
    worker_id: str = Field(min_length=1, max_length=128)
    error_code: str = Field(default="WORKER_FAILED", max_length=64)
    error_message: str = Field(default="Worker reported a processing failure.", max_length=4000)


def _get_claimed_job(db: Session, job_id: str, worker_id: str) -> TranscriptionJob:
    job = db.query(TranscriptionJob).filter(TranscriptionJob.id == job_id).first()
    if not job:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Transcription job not found.")
    if job.locked_by_worker != worker_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Job is not currently claimed by this worker.",
        )
    return job


@router.post("/jobs/claim")
def claim_next_job(
    payload: WorkerClaimRequest,
    _: str = Depends(require_worker_token),
    db: Session = Depends(get_db),
):
    settings = get_settings()
    now = _utcnow()
    lease_expires = now + timedelta(seconds=settings.WORKER_LEASE_SECONDS)

    # 1. Recover expired leases atomically before selecting the next queued job
    db.execute(
        update(TranscriptionJob)
        .where(
            TranscriptionJob.status.in_(ACTIVE_WORKER_STATUSES),
            TranscriptionJob.lease_expires_at.is_not(None),
            TranscriptionJob.lease_expires_at < now,
        )
        .values(
            status="queued",
            current_stage="Queued (lease recovered)",
            locked_by_worker=None,
            lease_expires_at=None,
        )
    )
    db.commit()

    # 2. Attempt atomic conditional claim of the oldest queued job
    candidates = (
        db.query(TranscriptionJob.id)
        .filter(TranscriptionJob.status == "queued")
        .order_by(TranscriptionJob.created_at.asc())
        .limit(5)
        .all()
    )

    claimed_job_id: str | None = None
    for (candidate_id,) in candidates:
        res = db.execute(
            update(TranscriptionJob)
            .where(
                TranscriptionJob.id == candidate_id,
                TranscriptionJob.status == "queued",
            )
            .values(
                status="validating",
                progress=5,
                current_stage="Claimed by local worker",
                locked_by_worker=payload.worker_id,
                lease_expires_at=lease_expires,
                last_heartbeat_at=now,
                started_at=now,
                attempt_count=TranscriptionJob.attempt_count + 1,
            )
        )
        db.commit()
        if res.rowcount == 1:
            claimed_job_id = candidate_id
            break

    if not claimed_job_id:
        return {"job": None}

    job = db.query(TranscriptionJob).filter(TranscriptionJob.id == claimed_job_id).first()
    project = db.query(Project).filter(Project.id == job.project_id).first()
    if project:
        project.status = "processing"
        db.commit()

    source_asset = None
    if job.source_asset_id:
        source_asset = db.query(MediaAsset).filter(MediaAsset.id == job.source_asset_id).first()

    source_download_url: str | None = None
    if source_asset:
        params = storage_service.create_signed_download_params(source_asset.storage_path, job.user_id)
        if "url" in params:
            source_download_url = str(params["url"])
        else:
            source_download_url = (
                f"{settings.API_V1_PREFIX}/uploads/{source_asset.id}/stream"
                f"?sig={params['sig']}&exp={params['exp']}"
            )

    artifact_targets: dict[str, dict[str, str | int]] = {}
    if storage_service.backend == "s3":
        midi_key = storage_service.build_key(job.user_id, job.project_id, "midi", "transcription.mid")
        xml_key = storage_service.build_key(job.user_id, job.project_id, "musicxml", "score.musicxml")
        artifact_targets["midi"] = storage_service.create_presigned_put_url(midi_key, "audio/midi")
        artifact_targets["musicxml"] = storage_service.create_presigned_put_url(
            xml_key, "application/vnd.recordare.musicxml+xml"
        )

    return {
        "job": {
            "id": job.id,
            "project_id": job.project_id,
            "engine": job.engine,
            "settings": job.settings_json,
            "attempt_count": job.attempt_count,
            "lease_expires_at": job.lease_expires_at.isoformat() if job.lease_expires_at else None,
            "source_download_url": source_download_url,
            "source_filename": source_asset.original_filename if source_asset else None,
            "artifact_upload_urls": artifact_targets,
        }
    }


@router.post("/jobs/{job_id}/heartbeat")
def heartbeat_job(
    job_id: str,
    payload: WorkerHeartbeatRequest,
    _: str = Depends(require_worker_token),
    db: Session = Depends(get_db),
):
    job = _get_claimed_job(db, job_id, payload.worker_id)
    if job.status in ("completed", "failed", "cancelled"):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=f"Job is already {job.status}.")

    settings = get_settings()
    now = _utcnow()
    job.last_heartbeat_at = now
    job.lease_expires_at = now + timedelta(seconds=settings.WORKER_LEASE_SECONDS)
    db.commit()
    return {
        "job_id": job.id,
        "status": job.status,
        "lease_expires_at": job.lease_expires_at.isoformat(),
    }


@router.post("/jobs/{job_id}/progress")
def report_job_progress(
    job_id: str,
    payload: WorkerProgressRequest,
    _: str = Depends(require_worker_token),
    db: Session = Depends(get_db),
):
    job = _get_claimed_job(db, job_id, payload.worker_id)
    if job.status in ("completed", "failed", "cancelled"):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=f"Job is already {job.status}.")

    if payload.status not in ACTIVE_WORKER_STATUSES:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid active job status.")

    settings = get_settings()
    now = _utcnow()
    job.status = payload.status
    job.progress = payload.progress
    job.current_stage = payload.current_stage
    job.last_heartbeat_at = now
    job.lease_expires_at = now + timedelta(seconds=settings.WORKER_LEASE_SECONDS)
    if payload.log_line:
        ts = now.strftime("%H:%M:%S")
        job.logs_text = f"{job.logs_text}[{ts}] {payload.log_line}\n"
    db.commit()

    job_ws_manager.publish_from_thread(
        job.id,
        {
            "job_id": job.id,
            "status": job.status,
            "progress": job.progress,
            "current_stage": job.current_stage,
            "error_message": job.error_message,
        },
    )
    return {"job_id": job.id, "status": job.status, "progress": job.progress}


@router.post("/jobs/{job_id}/complete")
def complete_job(
    job_id: str,
    payload: WorkerCompleteRequest,
    _: str = Depends(require_worker_token),
    db: Session = Depends(get_db),
):
    job = db.query(TranscriptionJob).filter(TranscriptionJob.id == job_id).first()
    if not job:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Transcription job not found.")

    # Idempotent completion guard
    if job.status == "completed":
        return {"job_id": job.id, "status": "completed", "idempotent": True}

    if job.locked_by_worker != payload.worker_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Job is not currently claimed by this worker.",
        )

    midi_key = _validate_project_key(payload.midi_key, job.user_id, job.project_id)
    xml_key = _validate_project_key(payload.musicxml_key, job.user_id, job.project_id)

    project = db.query(Project).filter(Project.id == job.project_id).first()
    now = _utcnow()

    midi_asset_id: str | None = None
    if midi_key:
        midi_asset = MediaAsset(
            project_id=job.project_id,
            user_id=job.user_id,
            asset_type="midi",
            storage_path=midi_key,
            original_filename=f"{project.title if project else 'transcription'}.mid",
            mime_type="audio/midi",
            size_bytes=0,
            duration_seconds=payload.duration_seconds,
        )
        db.add(midi_asset)
        db.flush()
        midi_asset_id = midi_asset.id

    xml_asset_id: str | None = None
    if xml_key:
        xml_asset = MediaAsset(
            project_id=job.project_id,
            user_id=job.user_id,
            asset_type="musicxml",
            storage_path=xml_key,
            original_filename=f"{project.title if project else 'score'}.musicxml",
            mime_type="application/vnd.recordare.musicxml+xml",
            size_bytes=0,
            duration_seconds=payload.duration_seconds,
        )
        db.add(xml_asset)
        db.flush()
        xml_asset_id = xml_asset.id

    if payload.score_json:
        existing_score = db.query(ProjectScore).filter(ProjectScore.project_id == job.project_id).first()
        if existing_score:
            existing_score.version += 1
            existing_score.score_json = payload.score_json
            if xml_key:
                existing_score.musicxml_path = xml_key
            if midi_key:
                existing_score.midi_path = midi_key
        else:
            db.add(
                ProjectScore(
                    project_id=job.project_id,
                    version=1,
                    score_json=payload.score_json,
                    musicxml_path=xml_key,
                    midi_path=midi_key,
                )
            )

    existing_result = db.query(TranscriptionResult).filter(TranscriptionResult.job_id == job.id).first()
    if not existing_result:
        db.add(
            TranscriptionResult(
                job_id=job.id,
                midi_asset_id=midi_asset_id,
                musicxml_asset_id=xml_asset_id,
                metadata_json=payload.metadata_json,
            )
        )

    if payload.duration_seconds and payload.duration_seconds > 0:
        db.add(
            UsageRecord(
                user_id=job.user_id,
                operation="transcription_minutes",
                quantity=max(0.1, round(payload.duration_seconds / 60.0, 2)),
            )
        )

    if project:
        project.status = "ready"
        if payload.duration_seconds is not None:
            project.duration_seconds = payload.duration_seconds

    job.status = "completed"
    job.progress = 100
    job.current_stage = "Completed"
    job.completed_at = now
    job.lease_expires_at = None
    db.commit()

    job_ws_manager.publish_from_thread(
        job.id,
        {
            "job_id": job.id,
            "status": "completed",
            "progress": 100,
            "current_stage": "Completed",
            "error_message": None,
        },
    )
    return {"job_id": job.id, "status": "completed", "idempotent": False}


@router.post("/jobs/{job_id}/fail")
def fail_job(
    job_id: str,
    payload: WorkerFailRequest,
    _: str = Depends(require_worker_token),
    db: Session = Depends(get_db),
):
    job = db.query(TranscriptionJob).filter(TranscriptionJob.id == job_id).first()
    if not job:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Transcription job not found.")

    if job.status == "failed":
        return {"job_id": job.id, "status": "failed", "idempotent": True}

    if job.locked_by_worker != payload.worker_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Job is not currently claimed by this worker.",
        )

    now = _utcnow()
    job.status = "failed"
    job.current_stage = "Failed"
    job.error_code = payload.error_code
    job.error_message = payload.error_message
    job.completed_at = now
    job.lease_expires_at = None

    project = db.query(Project).filter(Project.id == job.project_id).first()
    if project:
        project.status = "failed"

    db.commit()

    job_ws_manager.publish_from_thread(
        job.id,
        {
            "job_id": job.id,
            "status": "failed",
            "progress": job.progress,
            "current_stage": "Failed",
            "error_message": payload.error_message,
        },
    )
    return {"job_id": job.id, "status": "failed", "idempotent": False}
