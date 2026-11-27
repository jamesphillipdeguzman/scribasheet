import base64
import hmac
import logging
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import update
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.core.config import get_settings
from app.db.session import get_db
from app.models import (
    MediaAsset,
    Project,
    ProjectScore,
    TranscriptionJob,
    TranscriptionResult,
    UsageRecord,
    User,
    WorkerNode,
)
from app.notation.generator import apply_scribasheet_musicxml_branding, resolve_project_score_title
from app.schemas.common import serialize_utc_z
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
    status: str | None = Field(default=None, max_length=32)
    active_job_id: str | None = Field(default=None, max_length=64)


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
    pdf_base64: str | None = None
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


def _record_worker_activity(
    db: Session,
    *,
    worker_id: str,
    status_val: str = "online",
    active_job_id: str | None = None,
) -> None:
    now = _utcnow()
    node = db.query(WorkerNode).filter(WorkerNode.worker_id == worker_id).first()
    if node is None:
        node = WorkerNode(
            worker_id=worker_id,
            status=status_val,
            last_seen_at=now,
            active_job_id=active_job_id,
            metadata_json={},
            updated_at=now,
        )
        db.add(node)
    else:
        node.status = status_val
        node.last_seen_at = now
        node.active_job_id = active_job_id
        node.updated_at = now


def get_worker_availability(db: Session) -> dict[str, Any]:
    settings = get_settings()
    now = _utcnow()
    threshold = max(10, int(settings.WORKER_ONLINE_THRESHOLD_SECONDS))
    busy_threshold = max(threshold, int(settings.WORKER_BUSY_STALE_THRESHOLD_SECONDS))
    nodes = db.query(WorkerNode).order_by(WorkerNode.last_seen_at.desc()).all()

    reachable: list[tuple[WorkerNode, str, float]] = []
    latest_node: WorkerNode | None = nodes[0] if nodes else None
    latest_age: float | None = None
    for n in nodes:
        seen = _ensure_utc(n.last_seen_at)
        age = max(0.0, (now - seen).total_seconds()) if seen else float(busy_threshold + 1)
        if latest_age is None:
            latest_age = age
        is_busy = n.status == "busy" or bool(n.active_job_id)
        eff_threshold = busy_threshold if is_busy else threshold
        if n.status in ("online", "busy") and age <= eff_threshold:
            node_state = "stale" if (is_busy and age > threshold) else ("busy" if is_busy else "online")
            reachable.append((n, node_state, age))

    state_priority = {"busy": 0, "online": 1, "stale": 2}
    best = min(reachable, key=lambda item: (state_priority.get(item[1], 3), item[2])) if reachable else None
    worker_online = best is not None
    selected_node = best[0] if best is not None else latest_node
    selected_state = best[1] if best is not None else "offline"
    selected_age = best[2] if best is not None else latest_age

    active_job_count = (
        db.query(TranscriptionJob)
        .filter(
            TranscriptionJob.status.in_(ACTIVE_WORKER_STATUSES),
            TranscriptionJob.lease_expires_at.is_not(None),
            TranscriptionJob.lease_expires_at >= now,
        )
        .count()
    )
    queue_depth = (
        db.query(TranscriptionJob)
        .filter(TranscriptionJob.status == "queued")
        .count()
    )
    return {
        "worker_online": worker_online,
        "status": selected_state,
        "last_seen_seconds": round(selected_age, 1) if selected_age is not None else None,
        "worker_id": selected_node.worker_id if selected_node else None,
        "active_job_id": selected_node.active_job_id if (best is not None and selected_node) else None,
        "active_job_count": active_job_count,
        "queue_depth": queue_depth,
        "freshness_threshold_seconds": threshold,
        "busy_stale_threshold_seconds": busy_threshold,
    }


@router.get("/status")
def worker_status(
    _: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    try:
        return get_worker_availability(db)
    except SQLAlchemyError as exc:
        logger.exception("Database error while querying worker status: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Database error while checking worker availability.",
        ) from exc
    except Exception as exc:
        logger.exception("Unexpected error while querying worker status: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Unexpected error while checking worker availability.",
        ) from exc


@router.post("/offline")
def mark_worker_offline(
    payload: WorkerClaimRequest,
    _: str = Depends(require_worker_token),
    db: Session = Depends(get_db),
):
    _record_worker_activity(db, worker_id=payload.worker_id, status_val="offline", active_job_id=None)
    db.commit()
    return {"worker_id": payload.worker_id, "status": "offline"}


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
        _record_worker_activity(db, worker_id=payload.worker_id, status_val="online", active_job_id=None)
        db.commit()
        return {"job": None}

    _record_worker_activity(db, worker_id=payload.worker_id, status_val="busy", active_job_id=claimed_job_id)
    job = db.query(TranscriptionJob).filter(TranscriptionJob.id == claimed_job_id).first()
    project = db.query(Project).filter(Project.id == job.project_id).first()
    if project:
        project.status = "processing"
        db.commit()

    job_settings = job.settings_json or {}
    source_asset = None
    if job.source_asset_id:
        source_asset = db.query(MediaAsset).filter(MediaAsset.id == job.source_asset_id).first()
    if not source_asset and job_settings.get("source_media_id"):
        source_asset = (
            db.query(MediaAsset)
            .filter(MediaAsset.id == job_settings["source_media_id"], MediaAsset.project_id == job.project_id)
            .first()
        )
    if not source_asset:
        source_asset = (
            db.query(MediaAsset)
            .filter(MediaAsset.project_id == job.project_id, MediaAsset.asset_type == "original")
            .order_by(MediaAsset.created_at.desc())
            .first()
        )

    def _signed_url_for_asset(a: MediaAsset) -> str:
        params = storage_service.create_signed_download_params(a.storage_path, job.user_id)
        if "url" in params:
            return str(params["url"])
        return (
            f"{settings.API_V1_PREFIX}/uploads/{a.id}/stream"
            f"?sig={params['sig']}&exp={params['exp']}"
        )

    source_pages: list[dict[str, Any]] = []
    raw_page_ids = job_settings.get("source_asset_ids")
    if isinstance(raw_page_ids, list) and len(raw_page_ids) > 0:
        page_rows = (
            db.query(MediaAsset)
            .filter(
                MediaAsset.id.in_(raw_page_ids),
                MediaAsset.project_id == job.project_id,
                MediaAsset.user_id == job.user_id,
            )
            .all()
        )
        rows_by_id = {r.id: r for r in page_rows}
        ordered_rows = [rows_by_id[aid] for aid in raw_page_ids if aid in rows_by_id]
        if ordered_rows:
            source_asset = ordered_rows[0]
            source_pages = [
                {
                    "asset_id": r.id,
                    "page_index": idx,
                    "filename": r.original_filename,
                    "mime_type": r.mime_type,
                    "download_url": _signed_url_for_asset(r),
                }
                for idx, r in enumerate(ordered_rows, start=1)
            ]

    source_download_url: str | None = None
    if source_asset:
        source_download_url = _signed_url_for_asset(source_asset)
    elif job_settings.get("source_storage_key"):
        params = storage_service.create_signed_download_params(str(job_settings["source_storage_key"]), job.user_id)
        if "url" in params:
            source_download_url = str(params["url"])
    elif job_settings.get("external_media_url"):
        source_download_url = str(job_settings["external_media_url"])

    artifact_targets: dict[str, dict[str, str | int]] = {}
    if storage_service.is_object_storage:
        midi_key = storage_service.build_key(job.user_id, job.project_id, "midi", "transcription.mid", job_id=job.id)
        xml_key = storage_service.build_key(job.user_id, job.project_id, "musicxml", "score.musicxml", job_id=job.id)
        artifact_targets["midi"] = storage_service.create_presigned_put_url(midi_key, "audio/midi")
        artifact_targets["musicxml"] = storage_service.create_presigned_put_url(
            xml_key, "application/vnd.recordare.musicxml+xml"
        )

    return {
        "job": {
            "id": job.id,
            "project_id": job.project_id,
            "project_title": project.title if project else None,
            "engine": job.engine,
            "settings": job.settings_json,
            "attempt_count": job.attempt_count,
            "lease_expires_at": serialize_utc_z(job.lease_expires_at) if job.lease_expires_at else None,
            "source_download_url": source_download_url,
            "source_filename": source_asset.original_filename if source_asset else None,
            "source_pages": source_pages,
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
    hb_status = payload.status if payload.status in ("online", "busy") else "busy"
    _record_worker_activity(db, worker_id=payload.worker_id, status_val=hb_status, active_job_id=job.id)
    db.commit()
    return {
        "job_id": job.id,
        "status": job.status,
        "lease_expires_at": serialize_utc_z(job.lease_expires_at) if job.lease_expires_at else None,
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
    _record_worker_activity(db, worker_id=payload.worker_id, status_val="busy", active_job_id=job.id)
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
    is_lyrics_only = (job.settings_json or {}).get("mode") == "lyrics_transcription"
    validated_score: ScoreData | None = None

    if not is_simulated and not is_lyrics_only:
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
    resolved_score_title = resolve_project_score_title(project.title if project else None)

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
        branded_xml = apply_scribasheet_musicxml_branding(
            payload.musicxml_content,
            title=resolved_score_title,
            force_title=True,
        )
        xml_bytes = branded_xml.encode("utf-8")
        xml_key = storage_service.build_key(job.user_id, job.project_id, "musicxml", "score.musicxml")
        storage_service.save_bytes(xml_key, xml_bytes, content_type="application/vnd.recordare.musicxml+xml")
        xml_size_bytes = len(xml_bytes)
    elif xml_key and not is_simulated:
        try:
            raw_xml = storage_service.read_bytes(xml_key).decode("utf-8-sig", errors="replace")
            branded_xml = apply_scribasheet_musicxml_branding(
                raw_xml,
                title=resolved_score_title,
                force_title=True,
            )
            if branded_xml != raw_xml:
                xml_bytes = branded_xml.encode("utf-8")
                storage_service.save_bytes(xml_key, xml_bytes, content_type="application/vnd.recordare.musicxml+xml")
                xml_size_bytes = len(xml_bytes)
        except FileNotFoundError:
            pass

    midi_asset_id: str | None = None
    if midi_key:
        if midi_size_bytes == 0:
            midi_size_bytes = storage_service.get_object_size(midi_key) or 0
        midi_asset = MediaAsset(
            project_id=job.project_id,
            user_id=job.user_id,
            asset_type="midi",
            storage_path=midi_key,
            original_filename=f"{resolved_score_title}.mid",
            mime_type="audio/midi",
            size_bytes=midi_size_bytes,
            duration_seconds=payload.duration_seconds,
        )
        db.add(midi_asset)
        db.flush()
        midi_asset_id = midi_asset.id

    xml_asset_id: str | None = None
    if xml_key:
        if xml_size_bytes == 0:
            xml_size_bytes = storage_service.get_object_size(xml_key) or 0
        xml_asset = MediaAsset(
            project_id=job.project_id,
            user_id=job.user_id,
            asset_type="musicxml",
            storage_path=xml_key,
            original_filename=f"{resolved_score_title}.musicxml",
            mime_type="application/vnd.recordare.musicxml+xml",
            size_bytes=xml_size_bytes,
            duration_seconds=payload.duration_seconds,
        )
        db.add(xml_asset)
        db.flush()
        xml_asset_id = xml_asset.id

    if is_lyrics_only:
        raw_lyrics = (payload.metadata_json or {}).get("lyrics")
        existing_score = db.query(ProjectScore).filter(ProjectScore.project_id == job.project_id).first()
        force_overwrite = bool((job.settings_json or {}).get("force_overwrite", False))
        if isinstance(raw_lyrics, dict):
            if existing_score:
                score_dict = dict(existing_score.score_json or {})
                analysis = dict(score_dict.get("analysis") or {})
                prior_lyrics = analysis.get("lyrics") if isinstance(analysis.get("lyrics"), dict) else None
                if not (prior_lyrics and prior_lyrics.get("manually_edited") and not force_overwrite):
                    analysis["lyrics"] = raw_lyrics
                    score_dict["analysis"] = analysis
                    existing_score.score_json = score_dict
                    existing_score.version += 1
                    if score_dict.get("notes"):
                        try:
                            from app.notation.generator import score_data_to_musicxml

                            xml_str = score_data_to_musicxml(ScoreData(**score_dict))
                            new_xml_key = storage_service.build_key(job.user_id, job.project_id, "musicxml", "score.musicxml")
                            storage_service.save_bytes(
                                new_xml_key,
                                xml_str.encode("utf-8"),
                                content_type="application/vnd.recordare.musicxml+xml",
                            )
                            existing_score.musicxml_path = new_xml_key
                        except Exception:
                            pass
                persisted_score_version = existing_score.version
            else:
                minimal_score = ScoreData(
                    title=project.title if project else "Lyrics Transcription",
                    tracks=[],
                    notes=[],
                    chords=[],
                    analysis={"lyrics": raw_lyrics},
                )
                db.add(
                    ProjectScore(
                        project_id=job.project_id,
                        version=1,
                        score_json=minimal_score.model_dump(),
                        musicxml_path=None,
                        midi_path=None,
                    )
                )
                persisted_score_version = 1
        else:
            persisted_score_version = existing_score.version if existing_score else None
    elif not is_simulated and validated_score is not None:
        score_dict = validated_score.model_dump()
        score_dict["title"] = resolved_score_title
        new_analysis = dict(score_dict.get("analysis") or {})
        new_analysis["is_active"] = True
        new_analysis["job_id"] = job.id
        new_analysis.pop("superseded_by_job_id", None)
        existing_score = db.query(ProjectScore).filter(ProjectScore.project_id == job.project_id).first()
        if existing_score:
            # Preserve existing recognized/edited lyrics across music re-transcription
            old_analysis = (existing_score.score_json or {}).get("analysis") or {}
            if isinstance(old_analysis, dict) and isinstance(old_analysis.get("lyrics"), dict):
                new_analysis.setdefault("lyrics", old_analysis["lyrics"])
            score_dict["analysis"] = new_analysis
            existing_score.version += 1
            existing_score.score_json = score_dict
            if xml_key:
                existing_score.musicxml_path = xml_key
            if midi_key:
                existing_score.midi_path = midi_key
            persisted_score_version = existing_score.version
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
            persisted_score_version = 1
    else:
        persisted_score_version = None

    pdf_asset_id: str | None = None
    if payload.pdf_base64 and not is_simulated:
        try:
            pdf_bytes = base64.b64decode(payload.pdf_base64, validate=True)
        except Exception:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid pdf_base64 payload.")
        if pdf_bytes.startswith(b"%PDF-") and len(pdf_bytes) > 500:
            pdf_key = storage_service.build_key(job.user_id, job.project_id, "scores", "score.pdf")
            storage_service.save_bytes(pdf_key, pdf_bytes, content_type="application/pdf")
            pdf_asset = MediaAsset(
                project_id=job.project_id,
                user_id=job.user_id,
                asset_type="pdf",
                storage_path=pdf_key,
                original_filename=f"{resolved_score_title}.pdf",
                mime_type="application/pdf",
                size_bytes=len(pdf_bytes),
                duration_seconds=payload.duration_seconds,
            )
            db.add(pdf_asset)
            db.flush()
            pdf_asset_id = pdf_asset.id

    existing_result = db.query(TranscriptionResult).filter(TranscriptionResult.job_id == job.id).first()
    if not existing_result:
        meta = dict(payload.metadata_json or {})
        if is_simulated:
            meta["simulated"] = True
        if pdf_asset_id and persisted_score_version is not None:
            meta["pdf_asset_id"] = pdf_asset_id
            meta["pdf_score_version"] = persisted_score_version
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
    _record_worker_activity(db, worker_id=payload.worker_id, status_val="online", active_job_id=None)
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

    _record_worker_activity(db, worker_id=payload.worker_id, status_val="online", active_job_id=None)
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
