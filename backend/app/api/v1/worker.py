import base64
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
from app.schemas.score import ScoreData
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

TERMINAL_JOB_STATUSES = ("completed", "failed", "cancelled")


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


def _ensure_utc(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=UTC)
    return dt


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
    is_simulated: bool = False
    midi_key: str | None = None
    musicxml_key: str | None = None
    midi_base64: str | None = None
    musicxml_content: str | None = None
    score_json: dict[str, Any] = Field(default_factory=dict)
    duration_seconds: float | None = Field(default=None, ge=0.0)
    metadata_json: dict[str, Any] = Field(default_factory=dict)


class WorkerFailRequest(BaseModel):
    worker_id: str = Field(min_length=1, max_length=128)
    error_code: str = Field(default="WORKER_FAILED", max_length=64)
    error_message: str = Field(default="Worker reported a processing failure.", max_length=4000)


def _get_active_claimed_job(db: Session, job_id: str, worker_id: str, now: datetime) -> TranscriptionJob:
    """Validate job existence, terminal state, worker ownership, and active non-expired lease."""
    job = db.query(TranscriptionJob).filter(TranscriptionJob.id == job_id).first()
    if not job:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Transcription job not found.")
    if job.status in TERMINAL_JOB_STATUSES:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=f"Job is already {job.status}.")
    if job.locked_by_worker != worker_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Job is not currently claimed by this worker.",
        )
    lease_exp = _ensure_utc(job.lease_expires_at)
    if lease_exp is None or lease_exp < now:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Worker lease has expired.",
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
    max_attempts = max(1, settings.MAX_JOB_ATTEMPTS)

    # 1. Atomically recover expired leases (and enforce max_attempts on abandoned jobs)
    expired_jobs = (
        db.query(TranscriptionJob.id, TranscriptionJob.project_id, TranscriptionJob.attempt_count)
        .filter(
            TranscriptionJob.status.in_(ACTIVE_WORKER_STATUSES),
            TranscriptionJob.lease_expires_at.is_not(None),
            TranscriptionJob.lease_expires_at < now,
        )
        .all()
    )
    for exp_id, exp_project_id, attempts in expired_jobs:
        if attempts >= max_attempts:
            res = db.execute(
                update(TranscriptionJob)
                .where(
                    TranscriptionJob.id == exp_id,
                    TranscriptionJob.status.in_(ACTIVE_WORKER_STATUSES),
                    TranscriptionJob.lease_expires_at < now,
                )
                .values(
                    status="failed",
                    current_stage="Failed",
                    error_code="MAX_ATTEMPTS_EXCEEDED",
                    error_message=f"Job exceeded maximum worker attempts ({max_attempts}) after lease expiration.",
                    locked_by_worker=None,
                    lease_expires_at=None,
                    completed_at=now,
                )
            )
            if res.rowcount == 1:
                db.execute(
                    update(Project)
                    .where(Project.id == exp_project_id)
                    .values(status="failed")
                )
        else:
            db.execute(
                update(TranscriptionJob)
                .where(
                    TranscriptionJob.id == exp_id,
                    TranscriptionJob.status.in_(ACTIVE_WORKER_STATUSES),
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
    now = _utcnow()
    job = _get_active_claimed_job(db, job_id, payload.worker_id, now)

    settings = get_settings()
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
    now = _utcnow()
    job = _get_active_claimed_job(db, job_id, payload.worker_id, now)

    if payload.status not in ACTIVE_WORKER_STATUSES:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid active job status.")

    settings = get_settings()
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

    if job.status in ("failed", "cancelled"):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Cannot complete job in terminal status '{job.status}'.",
        )

    # Idempotent completion guard for already-completed jobs
    if job.status == "completed":
        if job.locked_by_worker and job.locked_by_worker != payload.worker_id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Job was completed by another worker.",
            )
        return {"job_id": job.id, "status": "completed", "idempotent": True}

    now = _utcnow()
    job = _get_active_claimed_job(db, job_id, payload.worker_id, now)

    midi_key = _validate_project_key(payload.midi_key, job.user_id, job.project_id)
    xml_key = _validate_project_key(payload.musicxml_key, job.user_id, job.project_id)

    is_simulated = payload.is_simulated or payload.metadata_json.get("handler") == "phase_a_test"
    validated_score: ScoreData | None = None

    if not is_simulated:
        if not payload.score_json:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="Cannot complete non-simulated transcription without a valid score payload.",
            )
        try:
            validated_score = ScoreData.model_validate(payload.score_json)
        except Exception as exc:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail=f"Invalid score payload: {exc}",
            )
        if len(validated_score.notes) == 0:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="Cannot mark project ready: transcription produced zero notes.",
            )

    project = db.query(Project).filter(Project.id == job.project_id).first()

    # Persist inline MIDI / MusicXML payloads when STORAGE_BACKEND=local (no direct R2 PUT)
    midi_size_bytes = 0
    if not midi_key and payload.midi_base64 and not is_simulated:
        try:
            midi_bytes = base64.b64decode(payload.midi_base64, validate=True)
        except Exception:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid midi_base64 payload.")
        midi_key = storage_service.build_key(job.user_id, job.project_id, "midi", "transcription.mid")
        storage_service.save_bytes(midi_key, midi_bytes, content_type="audio/midi")
        midi_size_bytes = len(midi_bytes)

    xml_size_bytes = 0
    if not xml_key and payload.musicxml_content and not is_simulated:
        xml_bytes = payload.musicxml_content.encode("utf-8")
        xml_key = storage_service.build_key(job.user_id, job.project_id, "musicxml", "score.musicxml")
        storage_service.save_bytes(xml_key, xml_bytes, content_type="application/vnd.recordare.musicxml+xml")
        xml_size_bytes = len(xml_bytes)

    midi_asset_id: str | None = None
    if midi_key:
        midi_asset = MediaAsset(
            project_id=job.project_id,
            user_id=job.user_id,
            asset_type="midi",
            storage_path=midi_key,
            original_filename=f"{project.title if project else 'transcription'}.mid",
            mime_type="audio/midi",
            size_bytes=midi_size_bytes,
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
            size_bytes=xml_size_bytes,
            duration_seconds=payload.duration_seconds,
        )
        db.add(xml_asset)
        db.flush()
        xml_asset_id = xml_asset.id

    if not is_simulated and validated_score is not None:
        score_dict = validated_score.model_dump()
        existing_score = db.query(ProjectScore).filter(ProjectScore.project_id == job.project_id).first()
        if existing_score:
            existing_score.version += 1
            existing_score.score_json = score_dict
            if xml_key:
                existing_score.musicxml_path = xml_key
            if midi_key:
                existing_score.midi_path = midi_key
        else:
            db.add(
                ProjectScore(
                    project_id=job.project_id,
                    version=1,
                    score_json=score_dict,
                    musicxml_path=xml_key,
                    midi_path=midi_key,
                )
            )

    existing_result = db.query(TranscriptionResult).filter(TranscriptionResult.job_id == job.id).first()
    if not existing_result:
        meta = dict(payload.metadata_json or {})
        if is_simulated:
            meta["simulated"] = True
        db.add(
            TranscriptionResult(
                job_id=job.id,
                midi_asset_id=midi_asset_id,
                musicxml_asset_id=xml_asset_id,
                metadata_json=meta,
            )
        )

    if not is_simulated and payload.duration_seconds and payload.duration_seconds > 0:
        db.add(
            UsageRecord(
                user_id=job.user_id,
                operation="transcription_minutes",
                quantity=max(0.1, round(payload.duration_seconds / 60.0, 2)),
            )
        )

    if project:
        # Only mark project "ready" when an actual transcription score was persisted
        if not is_simulated and validated_score is not None:
            project.status = "ready"
        elif project.status == "processing":
            project.status = "draft"
        if payload.duration_seconds is not None:
            project.duration_seconds = payload.duration_seconds

    job.status = "completed"
    job.progress = 100
    job.current_stage = "Completed (Simulated Test)" if is_simulated else "Completed"
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

    if job.status in ("completed", "cancelled"):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Cannot fail job in terminal status '{job.status}'.",
        )

    if job.status == "failed":
        if job.locked_by_worker and job.locked_by_worker != payload.worker_id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Job was failed by another worker.",
            )
        return {"job_id": job.id, "status": "failed", "idempotent": True}

    now = _utcnow()
    job = _get_active_claimed_job(db, job_id, payload.worker_id, now)

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
