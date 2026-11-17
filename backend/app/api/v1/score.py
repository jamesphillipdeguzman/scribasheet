from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, get_owned_project
from app.db.session import get_db
from app.models import Project, ProjectScore, User
from app.notation.arrangement import simplify_arrangement
from app.notation.generator import (
    build_score_data,
    score_data_to_midi_bytes,
    score_data_to_musicxml,
)
from app.schemas.score import (
    ArrangementRegenerateRequest,
    ProjectScoreResponse,
    ProjectScoreUpdateRequest,
    ScoreData,
)
from app.storage.service import storage_service
from app.transcription.base import DetectedNote
from app.transcription.note_refiner import NoteRefinerConfig, refine_detected_notes

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


@router.post("/projects/{project_id}/score/regenerate", response_model=ProjectScoreResponse)
def regenerate_project_arrangement(
    payload: ArrangementRegenerateRequest,
    project: Project = Depends(get_owned_project),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Regenerate arrangement, chords, MusicXML, and MIDI from stored transcription notes without ML inference."""
    score_row = db.query(ProjectScore).filter(ProjectScore.project_id == project.id).first()
    if not score_row:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No transcription score exists yet for this project.",
        )

    existing = ScoreData(**score_row.score_json)
    analysis = dict(existing.analysis or {})
    raw_stored = analysis.get("raw_detected_notes")

    if isinstance(raw_stored, list) and raw_stored:
        raw_notes = [
            DetectedNote(
                pitch_midi=int(n["pitch_midi"]),
                onset_sec=float(n["onset_sec"]),
                offset_sec=float(n["offset_sec"]),
                velocity=int(n.get("velocity", 80)),
                confidence=n.get("confidence"),
            )
            for n in raw_stored
        ]
    else:
        raw_notes = [
            DetectedNote(
                pitch_midi=int(n.pitch_midi),
                onset_sec=float(n.raw_onset_sec if n.raw_onset_sec is not None else n.onset_sec),
                offset_sec=float(n.raw_offset_sec if n.raw_offset_sec is not None else n.offset_sec),
                velocity=int(n.velocity),
                confidence=n.confidence,
            )
            for n in existing.notes
        ]

    refinement = refine_detected_notes(raw_notes, config=NoteRefinerConfig())
    refined_notes = refinement.notes or raw_notes
    arrangement = simplify_arrangement(
        refined_notes,
        tempo_bpm=existing.tempo_bpm,
        arrangement_detail=payload.arrangement_detail,
    )
    arranged_notes = arrangement.notes or refined_notes
    quant = payload.quantization or str(analysis.get("quantization") or "sixteenth")

    analysis["arrangement_detail"] = arrangement.arrangement_detail
    analysis["arrangement"] = arrangement.stats
    analysis["quantization"] = quant
    analysis["refiner"] = refinement.stats
    analysis["note_count"] = len(arranged_notes)
    if "raw_detected_notes" not in analysis:
        analysis["raw_detected_notes"] = [
            {
                "pitch_midi": n.pitch_midi,
                "onset_sec": round(n.onset_sec, 4),
                "offset_sec": round(n.offset_sec, 4),
                "velocity": n.velocity,
                "confidence": n.confidence,
            }
            for n in raw_notes
        ]

    new_score = build_score_data(
        title=project.title,
        detected_notes=arranged_notes,
        tempo_bpm=existing.tempo_bpm,
        tempo_estimated=existing.tempo_estimated,
        time_signature=existing.time_signature,
        time_signature_estimated=existing.time_signature_estimated,
        key_signature=existing.key_signature,
        key_signature_estimated=existing.key_signature_estimated,
        duration_seconds=existing.duration_seconds,
        instrument=project.instrument or "piano",
        quantization=quant,
        analysis=analysis,
    )

    musicxml_str = score_data_to_musicxml(new_score)
    midi_bytes = score_data_to_midi_bytes(new_score)

    xml_key = storage_service.build_key(current_user.id, project.id, "musicxml", "score.musicxml")
    storage_service.save_bytes(
        xml_key,
        musicxml_str.encode("utf-8"),
        content_type="application/vnd.recordare.musicxml+xml",
    )
    midi_key = storage_service.build_key(current_user.id, project.id, "midi", "score.mid")
    storage_service.save_bytes(midi_key, midi_bytes, content_type="audio/midi")

    score_row.version = int(score_row.version or 1) + 1
    score_row.score_json = new_score.model_dump()
    score_row.musicxml_path = xml_key
    score_row.midi_path = midi_key
    db.commit()
    db.refresh(score_row)

    return ProjectScoreResponse(
        id=score_row.id,
        project_id=score_row.project_id,
        version=score_row.version,
        score_json=score_row.score_json,
        musicxml=musicxml_str,
        updated_at=score_row.updated_at,
    )
