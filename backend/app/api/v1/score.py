from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, get_owned_project
from app.db.session import get_db
from app.models import Project, ProjectScore, User
from app.notation.generator import score_data_to_midi_bytes, score_data_to_musicxml
from app.schemas.score import ProjectScoreResponse, ProjectScoreUpdateRequest
from app.storage.service import storage_service

router = APIRouter(tags=["Editor & Score"])


@router.get("/projects/{project_id}/score", response_model=ProjectScoreResponse)
def get_project_score(
    project: Project = Depends(get_owned_project),
    db: Session = Depends(get_db),
):
    score = db.query(ProjectScore).filter(ProjectScore.project_id == project.id).first()
    if not score:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No transcription score exists yet for this project.",
        )

    musicxml_str = None
    if score.musicxml_path and storage_service.exists(score.musicxml_path):
        musicxml_str = storage_service.read_bytes(score.musicxml_path).decode("utf-8")

    return ProjectScoreResponse(
        id=score.id,
        project_id=score.project_id,
        version=score.version,
        score_json=score.score_json,
        musicxml=musicxml_str,
        updated_at=score.updated_at,
    )


@router.put("/projects/{project_id}/score", response_model=ProjectScoreResponse)
def update_project_score(
    payload: ProjectScoreUpdateRequest,
    project: Project = Depends(get_owned_project),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    score = db.query(ProjectScore).filter(ProjectScore.project_id == project.id).first()
    if not score:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project score not found.")

    if payload.expected_version is not None and payload.expected_version != score.version:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Score version conflict: expected {payload.expected_version}, current is {score.version}.",
        )

    # Regenerate genuine MusicXML and MIDI from the updated score_json
    musicxml_str = score_data_to_musicxml(payload.score_json)
    midi_bytes = score_data_to_midi_bytes(payload.score_json)

    xml_key = storage_service.build_key(current_user.id, project.id, "musicxml", "score.musicxml")
    storage_service.save_bytes(xml_key, musicxml_str.encode("utf-8"), content_type="application/vnd.recordare.musicxml+xml")

    midi_key = storage_service.build_key(current_user.id, project.id, "midi", "score.mid")
    storage_service.save_bytes(midi_key, midi_bytes, content_type="audio/midi")

    score.version += 1
    score.score_json = payload.score_json.model_dump()
    score.musicxml_path = xml_key
    score.midi_path = midi_key
    db.commit()
    db.refresh(score)

    return ProjectScoreResponse(
        id=score.id,
        project_id=score.project_id,
        version=score.version,
        score_json=score.score_json,
        musicxml=musicxml_str,
        updated_at=score.updated_at,
    )


@router.get("/projects/{project_id}/midi")
def get_project_midi(
    project: Project = Depends(get_owned_project),
    db: Session = Depends(get_db),
):
    score = db.query(ProjectScore).filter(ProjectScore.project_id == project.id).first()
    if not score or not score.midi_path or not storage_service.exists(score.midi_path):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="MIDI file not found for this project.")

    data = storage_service.read_bytes(score.midi_path)
    return Response(
        content=data,
        media_type="audio/midi",
        headers={"Content-Disposition": f'inline; filename="{project.title}.mid"'},
    )
