from copy import deepcopy

from fastapi import APIRouter, Body, Depends, HTTPException, Query, status
from sqlalchemy import asc, desc
from sqlalchemy.orm import Session, joinedload

from app.api.deps import get_current_user, get_owned_project
from app.api.v1.worker import ACTIVE_WORKER_STATUSES
from app.audio.extraction_service import ensure_extracted_audio_asset
from app.core.config import get_settings
from app.db.session import get_db
from app.models import MediaAsset, Project, ProjectScore, TranscriptionJob, User
from app.notation.generator import (
    apply_scribasheet_musicxml_branding,
    resolve_project_score_title,
    score_data_to_midi_bytes,
    score_data_to_musicxml,
)
from app.notation.playground import build_blank_playground_score
from app.schemas.project import (
    ExtractAudioRequest,
    ExtractAudioResponse,
    ExtractedAudioItem,
    MediaAssetResponse,
    PlaygroundCopyRequest,
    PlaygroundProjectCreateRequest,
    ProjectCreateRequest,
    ProjectListResponse,
    ProjectResponse,
    ProjectUpdateRequest,
)
from app.schemas.score import ScoreData
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


def _clone_score_for_copy(
    source_score: ProjectScore,
    *,
    owner_id: str,
    target_project_id: str,
    target_title: str,
    mark_playground: bool = False,
    copied_from_project_id: str | None = None,
) -> ProjectScore:
    """Create a completely isolated ProjectScore copy with independent MusicXML/MIDI files."""
    resolved_title = resolve_project_score_title(target_title)
    score_json_copy = deepcopy(source_score.score_json or {})
    if isinstance(score_json_copy, dict):
        score_json_copy["title"] = resolved_title
        if mark_playground:
            analysis = dict(score_json_copy.get("analysis") or {})
            analysis["source_type"] = "midi_playground"
            analysis["mode"] = "midi_playground"
            if copied_from_project_id:
                analysis["copied_from_project_id"] = copied_from_project_id
            score_json_copy["analysis"] = analysis

    new_xml_key: str | None = None
    if source_score.musicxml_path and storage_service.exists(source_score.musicxml_path):
        raw_bytes = storage_service.read_bytes(source_score.musicxml_path)
        if not source_score.musicxml_path.lower().endswith(".mxl") and raw_bytes[:2] != b"PK":
            raw_xml = raw_bytes.decode("utf-8-sig", errors="replace")
            branded_xml = apply_scribasheet_musicxml_branding(
                raw_xml,
                title=resolved_title,
                force_title=True,
            )
            new_xml_key = storage_service.build_key(owner_id, target_project_id, "musicxml", "score.musicxml")
            storage_service.save_bytes(
                new_xml_key,
                branded_xml.encode("utf-8"),
                content_type="application/vnd.recordare.musicxml+xml",
            )
        else:
            new_xml_key = storage_service.build_key(owner_id, target_project_id, "musicxml", "score.mxl")
            storage_service.save_bytes(
                new_xml_key,
                raw_bytes,
                content_type="application/vnd.recordare.musicxml",
            )
    elif isinstance(score_json_copy, dict) and score_json_copy:
        fallback_score = ScoreData(**score_json_copy)
        fallback_xml = apply_scribasheet_musicxml_branding(
            score_data_to_musicxml(fallback_score),
            title=resolved_title,
            force_title=True,
        )
        new_xml_key = storage_service.build_key(owner_id, target_project_id, "musicxml", "score.musicxml")
        storage_service.save_bytes(
            new_xml_key,
            fallback_xml.encode("utf-8"),
            content_type="application/vnd.recordare.musicxml+xml",
        )

    new_midi_key: str | None = None
    if source_score.midi_path and storage_service.exists(source_score.midi_path):
        midi_bytes = storage_service.read_bytes(source_score.midi_path)
        new_midi_key = storage_service.build_key(owner_id, target_project_id, "midi", "score.mid")
        storage_service.save_bytes(new_midi_key, midi_bytes, content_type="audio/midi")
    elif isinstance(score_json_copy, dict) and score_json_copy:
        midi_bytes = score_data_to_midi_bytes(ScoreData(**score_json_copy))
        new_midi_key = storage_service.build_key(owner_id, target_project_id, "midi", "score.mid")
        storage_service.save_bytes(new_midi_key, midi_bytes, content_type="audio/midi")

    return ProjectScore(
        project_id=target_project_id,
        version=1,
        score_json=score_json_copy,
        musicxml_path=new_xml_key,
        midi_path=new_midi_key,
    )


@router.post("", response_model=ProjectResponse, status_code=status.HTTP_201_CREATED)
def create_project(
    payload: ProjectCreateRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
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


@router.post("/playground", response_model=ProjectResponse, status_code=status.HTTP_201_CREATED)
def create_playground_project(
    payload: PlaygroundProjectCreateRequest = Body(default_factory=PlaygroundProjectCreateRequest),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Create a standalone blank MIDI Playground project with an initialized grand/treble/bass MusicXML score."""
    title = payload.title.strip() or "Untitled Playground"
    score_data, musicxml_str = build_blank_playground_score(
        title=title,
        key_signature=payload.key_signature,
        time_signature=payload.time_signature,
        tempo_bpm=payload.tempo_bpm,
        clef_mode=payload.clef_mode,
        measures=payload.measures,
        pickup_beats=payload.pickup_beats,
    )

    project = Project(
        user_id=current_user.id,
        title=title[:200],
        description=payload.description.strip(),
        instrument="piano",
        transcription_mode="midi_playground",
        duration_seconds=score_data.duration_seconds,
        status="ready",
    )
    db.add(project)
    db.flush()

    written_keys: list[str] = []
    try:
        xml_key = storage_service.build_key(current_user.id, project.id, "musicxml", "score.musicxml")
        storage_service.save_bytes(
            xml_key,
            musicxml_str.encode("utf-8"),
            content_type="application/vnd.recordare.musicxml+xml",
        )
        written_keys.append(xml_key)
        midi_bytes = score_data_to_midi_bytes(score_data)
        midi_key = storage_service.build_key(current_user.id, project.id, "midi", "score.mid")
        storage_service.save_bytes(midi_key, midi_bytes, content_type="audio/midi")
        written_keys.append(midi_key)

        db.add(
            ProjectScore(
                project_id=project.id,
                version=1,
                score_json=score_data.model_dump(),
                musicxml_path=xml_key,
                midi_path=midi_key,
            )
        )
        db.commit()
    except Exception:
        db.rollback()
        for key in written_keys:
            try:
                storage_service.delete(key)
            except Exception:
                pass
        raise
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
    copy_title = f"{project.title} (Copy)"[:120]
    copy = Project(
        user_id=current_user.id,
        title=copy_title,
        description=project.description,
        instrument=project.instrument,
        transcription_mode=project.transcription_mode,
        duration_seconds=project.duration_seconds,
        status="ready" if project.score else "draft",
    )
    db.add(copy)
    db.flush()

    cloned_score: ProjectScore | None = None
    try:
        if project.score:
            cloned_score = _clone_score_for_copy(
                project.score,
                owner_id=current_user.id,
                target_project_id=copy.id,
                target_title=copy_title,
            )
            db.add(cloned_score)
        db.commit()
    except Exception:
        db.rollback()
        if cloned_score:
            for key in (cloned_score.musicxml_path, cloned_score.midi_path):
                if key:
                    try:
                        storage_service.delete(key)
                    except Exception:
                        pass
        raise
    db.refresh(copy)
    return copy


@router.post("/{project_id}/playground-copy", response_model=ProjectResponse, status_code=status.HTTP_201_CREATED)
def create_playground_copy(
    payload: PlaygroundCopyRequest = Body(default_factory=PlaygroundCopyRequest),
    project: Project = Depends(get_owned_project),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Clone an existing project's score into an isolated MIDI Playground project without altering the original."""
    if not project.score:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Project does not have a score to open in the MIDI Playground yet.",
        )

    copy_title = (payload.title.strip() if payload.title else f"{project.title} (Playground Copy)")[:120]
    copy = Project(
        user_id=current_user.id,
        title=copy_title,
        description=project.description,
        instrument=project.instrument,
        transcription_mode="midi_playground",
        duration_seconds=project.duration_seconds,
        status="ready",
    )
    db.add(copy)
    db.flush()

    cloned_score: ProjectScore | None = None
    try:
        cloned_score = _clone_score_for_copy(
            project.score,
            owner_id=current_user.id,
            target_project_id=copy.id,
            target_title=copy_title,
            mark_playground=True,
            copied_from_project_id=project.id,
        )
        db.add(cloned_score)
        db.commit()
    except Exception:
        db.rollback()
        if cloned_score:
            for key in (cloned_score.musicxml_path, cloned_score.midi_path):
                if key:
                    try:
                        storage_service.delete(key)
                    except Exception:
                        pass
        raise
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
    keys_to_delete: list[str] = []
    for asset in project.media_assets:
        if asset.storage_path:
            keys_to_delete.append(asset.storage_path)
    for export_row in project.exports:
        if export_row.storage_path:
            keys_to_delete.append(export_row.storage_path)
    if project.score:
        if project.score.musicxml_path:
            keys_to_delete.append(project.score.musicxml_path)
        if project.score.midi_path:
            keys_to_delete.append(project.score.midi_path)

    db.delete(project)
    db.commit()

    for key in dict.fromkeys(keys_to_delete):
        try:
            storage_service.delete(key)
        except Exception:
            pass
    return None
