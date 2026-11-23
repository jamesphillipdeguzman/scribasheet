from fastapi import APIRouter, Depends, HTTPException, WebSocket, WebSocketDisconnect, status
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, get_owned_project, get_user_usage_metrics
from app.api.v1.worker import get_worker_availability
from app.core.security import decode_token
from app.db.session import SessionLocal, get_db
from app.models import MediaAsset, Project, ProjectScore, TranscriptionJob, TranscriptionResult, User
from app.schemas.transcription import TranscriptionCreateRequest, TranscriptionJobResponse
from app.workers.job_runner import enqueue_transcription_job
from app.workers.ws_manager import job_ws_manager

router = APIRouter(tags=["Transcriptions"])


def _serialize_job(job: TranscriptionJob, worker_online: bool) -> TranscriptionJobResponse:
    resp = TranscriptionJobResponse.model_validate(job)
    resp.worker_online = worker_online
    return resp


def _supersede_previous_project_results(db: Session, project_id: str, new_job_id: str) -> None:
    """Mark any in-flight jobs as superseded and deactivate previous active score/results without deleting history."""
    in_flight = (
        db.query(TranscriptionJob)
        .filter(
            TranscriptionJob.project_id == project_id,
            TranscriptionJob.id != new_job_id,
            TranscriptionJob.status.in_(("queued", "processing", "running")),
        )
        .all()
    )
    for old in in_flight:
        old.status = "cancelled"
        old.current_stage = "Superseded"

    prev_results = (
        db.query(TranscriptionResult)
        .join(TranscriptionJob, TranscriptionJob.id == TranscriptionResult.job_id)
        .filter(TranscriptionJob.project_id == project_id, TranscriptionJob.id != new_job_id)
        .all()
    )
    for res in prev_results:
        meta = dict(res.metadata_json or {})
        meta["is_active"] = False
        meta["superseded_by_job_id"] = new_job_id
        res.metadata_json = meta

    score_row = db.query(ProjectScore).filter(ProjectScore.project_id == project_id).first()
    if score_row:
        score_json = dict(score_row.score_json or {})
        analysis = dict(score_json.get("analysis") or {})
        analysis["is_active"] = False
        analysis["superseded_by_job_id"] = new_job_id
        score_json["analysis"] = analysis
        score_row.score_json = score_json


@router.post(
    "/projects/{project_id}/transcriptions",
    response_model=TranscriptionJobResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
def start_transcription(
    payload: TranscriptionCreateRequest,
    project: Project = Depends(get_owned_project),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    usage = get_user_usage_metrics(db, current_user)
    if not usage["is_unlimited"] and float(usage["monthly_minutes_used"]) >= float(usage["monthly_minutes_limit"]):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=(
                f"Monthly transcription allowance reached ({usage['monthly_minutes_limit']} min) "
                f"for your {current_user.plan_tier} plan."
            ),
        )

    asset = None
    if payload.source_asset_id:
        asset = (
            db.query(MediaAsset)
            .filter(MediaAsset.id == payload.source_asset_id, MediaAsset.project_id == project.id)
            .first()
        )
    else:
        asset = (
            db.query(MediaAsset)
            .filter(MediaAsset.project_id == project.id, MediaAsset.asset_type == "original")
            .order_by(MediaAsset.created_at.desc())
            .first()
        )
    if not asset:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Please upload or record an audio/video file before starting transcription.",
        )

    avail = get_worker_availability(db)
    worker_online = bool(avail["worker_online"])
    initial_stage = "Queued" if worker_online else "Waiting for Desktop Worker"

    job = TranscriptionJob(
        project_id=project.id,
        user_id=current_user.id,
        source_asset_id=asset.id,
        status="queued",
        progress=0,
        current_stage=initial_stage,
        engine="basic_pitch",
        settings_json=payload.settings.model_dump(),
    )
    project.status = "processing"
    project.transcription_mode = payload.settings.mode
    project.instrument = payload.settings.instrument
    db.add(job)
    db.flush()
    _supersede_previous_project_results(db, project.id, job.id)
    db.commit()
    db.refresh(job)

    task_id = enqueue_transcription_job(job.id)
    if task_id:
        job.celery_task_id = task_id
        db.commit()
        db.refresh(job)

    return _serialize_job(job, worker_online)


@router.get("/projects/{project_id}/transcriptions", response_model=list[TranscriptionJobResponse])
def list_project_transcriptions(
    project: Project = Depends(get_owned_project),
    db: Session = Depends(get_db),
):
    worker_online = bool(get_worker_availability(db)["worker_online"])
    jobs = (
        db.query(TranscriptionJob)
        .filter(TranscriptionJob.project_id == project.id)
        .order_by(TranscriptionJob.created_at.desc())
        .all()
    )
    return [_serialize_job(j, worker_online) for j in jobs]


@router.get("/transcriptions/{job_id}", response_model=TranscriptionJobResponse)
def get_transcription_job(
    job_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    job = db.query(TranscriptionJob).filter(TranscriptionJob.id == job_id).first()
    if not job:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Transcription job not found.")
    if job.user_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied.")
    worker_online = bool(get_worker_availability(db)["worker_online"])
    return _serialize_job(job, worker_online)


@router.post("/transcriptions/{job_id}/cancel", response_model=TranscriptionJobResponse)
def cancel_transcription_job(
    job_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    job = db.query(TranscriptionJob).filter(TranscriptionJob.id == job_id).first()
    if not job:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Transcription job not found.")
    if job.user_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied.")
    worker_online = bool(get_worker_availability(db)["worker_online"])
    if job.status in ("completed", "failed", "cancelled"):
        return _serialize_job(job, worker_online)

    job.status = "cancelled"
    job.current_stage = "Cancelled"
    db.commit()
    db.refresh(job)
    return _serialize_job(job, worker_online)


@router.post("/transcriptions/{job_id}/retry", response_model=TranscriptionJobResponse, status_code=status.HTTP_202_ACCEPTED)
def retry_transcription_job(
    job_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    old_job = db.query(TranscriptionJob).filter(TranscriptionJob.id == job_id).first()
    if not old_job:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Transcription job not found.")
    if old_job.user_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied.")

    worker_online = bool(get_worker_availability(db)["worker_online"])
    initial_stage = "Queued" if worker_online else "Waiting for Desktop Worker"

    new_job = TranscriptionJob(
        project_id=old_job.project_id,
        user_id=current_user.id,
        source_asset_id=old_job.source_asset_id,
        status="queued",
        progress=0,
        current_stage=initial_stage,
        engine=old_job.engine,
        settings_json=old_job.settings_json,
    )
    db.add(new_job)
    db.flush()
    if (old_job.settings_json or {}).get("mode") != "lyrics_only":
        _supersede_previous_project_results(db, old_job.project_id, new_job.id)
    db.commit()
    db.refresh(new_job)

    task_id = enqueue_transcription_job(new_job.id)
    if task_id:
        new_job.celery_task_id = task_id
        db.commit()
        db.refresh(new_job)
    return _serialize_job(new_job, worker_online)


@router.websocket("/ws/jobs/{job_id}")
async def job_updates_ws(websocket: WebSocket, job_id: str, token: str | None = None):
    if not token:
        await websocket.close(code=1008)
        return
    try:
        claims = decode_token(token)
        user_id = claims.get("sub")
    except Exception:
        await websocket.close(code=1008)
        return

    db = SessionLocal()
    try:
        job = db.query(TranscriptionJob).filter(TranscriptionJob.id == job_id).first()
        if not job or job.user_id != user_id:
            await websocket.close(code=1008)
            return
        initial_payload = {
            "job_id": job.id,
            "status": job.status,
            "progress": job.progress,
            "current_stage": job.current_stage,
            "error_message": job.error_message,
        }
    finally:
        db.close()

    await job_ws_manager.connect(job_id, websocket)
    try:
        await websocket.send_json(initial_payload)
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        job_ws_manager.disconnect(job_id, websocket)
