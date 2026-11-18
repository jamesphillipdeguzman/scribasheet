"""Lyrics transcription, editing, and export API endpoints."""

from __future__ import annotations

from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, get_owned_project
from app.api.v1.worker import get_worker_availability
from app.db.session import get_db
from app.models import (
    MediaAsset,
    Project,
    ProjectScore,
    TranscriptionJob,
    TranscriptionResult,
    User,
)
from app.notation.generator import score_data_to_musicxml
from app.schemas.lyrics import LyricsData, LyricsTranscribeRequest, LyricsUpdateRequest
from app.schemas.score import ScoreData
from app.schemas.transcription import TranscriptionJobResponse
from app.storage.service import sanitize_filename, storage_service
from app.transcription.lyrics import format_lyrics_export
from app.workers.job_runner import enqueue_transcription_job

router = APIRouter(tags=["Lyrics"])


def _load_project_lyrics(db: Session, project_id: str) -> LyricsData:
    score_row = db.query(ProjectScore).filter(ProjectScore.project_id == project_id).first()
    if score_row and isinstance(score_row.score_json, dict):
        analysis = score_row.score_json.get("analysis") or {}
        if isinstance(analysis, dict) and isinstance(analysis.get("lyrics"), dict):
            return LyricsData(**analysis["lyrics"])

    results = (
        db.query(TranscriptionResult)
        .join(TranscriptionJob, TranscriptionJob.id == TranscriptionResult.job_id)
        .filter(TranscriptionJob.project_id == project_id)
        .order_by(TranscriptionResult.created_at.desc())
        .all()
    )
    for res in results:
        meta = res.metadata_json or {}
        if isinstance(meta.get("lyrics"), dict):
            return LyricsData(**meta["lyrics"])

    return LyricsData()


@router.get("/projects/{project_id}/lyrics", response_model=LyricsData)
def get_project_lyrics(
    project: Project = Depends(get_owned_project),
    db: Session = Depends(get_db),
):
    return _load_project_lyrics(db, project.id)


@router.put("/projects/{project_id}/lyrics", response_model=LyricsData)
def update_project_lyrics(
    payload: LyricsUpdateRequest,
    project: Project = Depends(get_owned_project),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    current = _load_project_lyrics(db, project.id)
    updated_segments = payload.segments if payload.segments is not None else current.segments
    if payload.segments is None and payload.text.strip() != current.text.strip() and current.segments:
        # Keep segment timestamps aligned line-by-line where possible when text is edited
        new_lines = [ln.strip() for ln in payload.text.splitlines() if ln.strip()]
        if len(new_lines) == len(current.segments):
            updated_segments = [
                seg.model_copy(update={"text": new_lines[i], "needs_review": False})
                for i, seg in enumerate(current.segments)
            ]

    updated = current.model_copy(
        update={
            "text": payload.text,
            "segments": updated_segments,
            "language": payload.language if payload.language is not None else current.language,
            "manually_edited": True,
            "updated_at": datetime.now(UTC).isoformat(),
        }
    )

    score_row = db.query(ProjectScore).filter(ProjectScore.project_id == project.id).first()
    if score_row:
        score_dict = dict(score_row.score_json or {})
        analysis = dict(score_dict.get("analysis") or {})
        analysis["lyrics"] = updated.model_dump()
        score_dict["analysis"] = analysis
        score_row.score_json = score_dict
        score_row.version += 1

        if score_dict.get("notes"):
            try:
                validated = ScoreData(**score_dict)
                xml_str = score_data_to_musicxml(validated)
                xml_key = storage_service.build_key(current_user.id, project.id, "musicxml", "score.musicxml")
                storage_service.save_bytes(
                    xml_key,
                    xml_str.encode("utf-8"),
                    content_type="application/vnd.recordare.musicxml+xml",
                )
                score_row.musicxml_path = xml_key
            except Exception:
                pass
    else:
        minimal_score = ScoreData(
            title=project.title,
            tracks=[],
            notes=[],
            chords=[],
            analysis={"lyrics": updated.model_dump()},
        )
        db.add(
            ProjectScore(
                project_id=project.id,
                version=1,
                score_json=minimal_score.model_dump(),
                musicxml_path=None,
                midi_path=None,
            )
        )

    db.commit()
    return updated


@router.post(
    "/projects/{project_id}/lyrics/transcribe",
    response_model=TranscriptionJobResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
def start_lyrics_transcription(
    payload: LyricsTranscribeRequest,
    project: Project = Depends(get_owned_project),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    asset = (
        db.query(MediaAsset)
        .filter(MediaAsset.project_id == project.id, MediaAsset.asset_type == "original")
        .order_by(MediaAsset.created_at.desc())
        .first()
    )
    if not asset:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Please upload an audio or video file before transcribing lyrics.",
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
        engine="faster_whisper",
        settings_json={
            "mode": "lyrics_transcription",
            "instrument": project.instrument or "vocals",
            "enable_source_separation": bool(payload.enable_source_separation),
            "whisper_model": payload.whisper_model or "small",
            "language": payload.language,
            "force_overwrite": bool(payload.force_overwrite),
        },
    )
    db.add(job)
    db.commit()
    db.refresh(job)

    task_id = enqueue_transcription_job(job.id)
    if task_id:
        job.celery_task_id = task_id
        db.commit()
        db.refresh(job)

    return TranscriptionJobResponse(
        id=job.id,
        project_id=job.project_id,
        user_id=job.user_id,
        source_asset_id=job.source_asset_id,
        status=job.status,
        progress=job.progress,
        current_stage=job.current_stage,
        engine=job.engine,
        settings_json=job.settings_json,
        error_code=job.error_code,
        error_message=job.error_message,
        started_at=job.started_at,
        completed_at=job.completed_at,
        created_at=job.created_at,
        worker_online=worker_online,
    )


@router.get("/projects/{project_id}/lyrics/export")
def export_project_lyrics(
    format: str = Query(default="txt", pattern="^(txt|timestamped_txt|srt)$"),
    project: Project = Depends(get_owned_project),
    db: Session = Depends(get_db),
):
    lyrics = _load_project_lyrics(db, project.id)
    if not lyrics.text.strip() and not lyrics.segments:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No recognized lyrics are available to export for this project.",
        )
    content, mime_type, ext = format_lyrics_export(lyrics, format)
    safe_base = sanitize_filename(project.title or "lyrics")
    return Response(
        content=content.encode("utf-8"),
        media_type=mime_type,
        headers={"Content-Disposition": f'attachment; filename="{safe_base}_lyrics.{ext}"'},
    )
