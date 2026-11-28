import tempfile
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.api.deps import delete_unreferenced_storage_keys, get_current_user, get_owned_project
from app.core.config import get_settings
from app.db.session import get_db
from app.models import MediaAsset, Project, ProjectScore, TranscriptionJob, User
from app.notation.analyzer import detect_chords, select_chord_source_notes
from app.notation.arrangement import simplify_arrangement
from app.notation.generator import (
    apply_scribasheet_musicxml_branding,
    build_piano_vocal_score_data,
    build_score_data,
    resolve_project_score_title,
    score_data_to_midi_bytes,
    score_data_to_musicxml,
)
from app.notation.melody import (
    extract_lead_melody,
    is_lead_melody_mode,
    normalize_transcription_mode,
)
from app.notation.omr import musicxml_to_satb_score_data, sanitize_omr_musicxml
from app.notation.omr_verification import (
    OmrProposedFix,
    OmrVerificationReport,
    apply_omr_proposed_fixes,
    compute_musicxml_hash,
    evaluate_omr_structure,
    verify_omr_with_gemini_vision,
)
from app.notation.piano_playability import apply_piano_playability, normalize_playability_smoothing
from app.schemas.score import (
    ArrangementRegenerateRequest,
    ProjectScoreResponse,
    ProjectScoreUpdateRequest,
    ScoreData,
    ScoreNote,
)
from app.storage.service import sanitize_download_title, storage_service
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
    analysis = (score.score_json or {}).get("analysis") if isinstance(score.score_json, dict) else None
    if isinstance(analysis, dict) and analysis.get("is_active") is False:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Score processing is in progress or previous score was superseded.",
        )

    resolved_title = resolve_project_score_title(project.title)
    musicxml_str = None
    if score.musicxml_path and storage_service.exists(score.musicxml_path):
        raw_bytes = storage_service.read_bytes(score.musicxml_path)
        if score.musicxml_path.lower().endswith(".mxl") or raw_bytes[:2] == b"PK":
            import io
            import zipfile

            try:
                with zipfile.ZipFile(io.BytesIO(raw_bytes), "r") as zf:
                    xml_name = next(
                        (
                            n for n in zf.namelist()
                            if n.lower().endswith((".xml", ".musicxml")) and "meta-inf" not in n.lower()
                        ),
                        None,
                    )
                    if xml_name:
                        raw_xml = zf.read(xml_name).decode("utf-8-sig", errors="replace")
                        cleaned_xml, _ = sanitize_omr_musicxml(raw_xml)
                        musicxml_str = apply_scribasheet_musicxml_branding(
                            cleaned_xml,
                            title=resolved_title,
                            force_title=True,
                        )
            except Exception:
                musicxml_str = None
        else:
            raw_xml = raw_bytes.decode("utf-8-sig", errors="replace")
            cleaned_xml, _ = sanitize_omr_musicxml(raw_xml)
            musicxml_str = apply_scribasheet_musicxml_branding(
                cleaned_xml,
                title=resolved_title,
                force_title=True,
            )

    score_json_out = dict(score.score_json or {})
    score_json_out["title"] = resolved_title

    return ProjectScoreResponse(
        id=score.id,
        project_id=score.project_id,
        version=score.version,
        score_json=score_json_out,
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

    resolved_title = resolve_project_score_title(project.title)
    score_payload = payload.score_json.model_copy(update={"title": resolved_title})

    # Persist direct MusicXML edits when provided (branded & validated), otherwise regenerate from score_json
    if payload.musicxml and ("<score-partwise" in payload.musicxml or "<score-timewise" in payload.musicxml):
        musicxml_str = apply_scribasheet_musicxml_branding(
            payload.musicxml,
            title=resolved_title,
            force_title=True,
        )
    else:
        musicxml_str = score_data_to_musicxml(score_payload)
    midi_bytes = score_data_to_midi_bytes(score_payload)

    old_xml_key = score.musicxml_path
    old_midi_key = score.midi_path
    xml_key = storage_service.build_key(current_user.id, project.id, "musicxml", "score.musicxml")
    storage_service.save_bytes(xml_key, musicxml_str.encode("utf-8"), content_type="application/vnd.recordare.musicxml+xml")

    midi_key: str | None = None
    try:
        midi_key = storage_service.build_key(current_user.id, project.id, "midi", "score.mid")
        storage_service.save_bytes(midi_key, midi_bytes, content_type="audio/midi")

        score.version += 1
        score.score_json = score_payload.model_dump()
        score.musicxml_path = xml_key
        score.midi_path = midi_key
        db.commit()
    except Exception:
        db.rollback()
        for new_key in (xml_key, midi_key):
            if new_key:
                try:
                    storage_service.delete(new_key)
                except Exception:
                    pass
        raise
    db.refresh(score)
    delete_unreferenced_storage_keys(
        db,
        [
            old_xml_key if old_xml_key != xml_key else None,
            old_midi_key if old_midi_key != midi_key else None,
        ],
    )

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
    midi_filename = sanitize_download_title(resolve_project_score_title(project.title), "Untitled Score")
    return Response(
        content=data,
        media_type="audio/midi",
        headers={"Content-Disposition": f'inline; filename="{midi_filename}.mid"'},
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
    effective_mode = payload.mode or analysis.get("mode") or project.transcription_mode
    norm_mode = normalize_transcription_mode(str(effective_mode))
    lead_melody_active = is_lead_melody_mode(effective_mode)
    piano_vocal_active = norm_mode == "piano_vocal"

    def _hydrate_notes(key: str) -> list[DetectedNote]:
        stored = analysis.get(key)
        if not isinstance(stored, list):
            return []
        return [
            DetectedNote(
                pitch_midi=int(n["pitch_midi"]),
                onset_sec=float(n["onset_sec"]),
                offset_sec=float(n["offset_sec"]),
                velocity=int(n.get("velocity", 80)),
                confidence=n.get("confidence"),
            )
            for n in stored
        ]

    vocal_notes = _hydrate_notes("vocal_detected_notes")
    bass_notes = _hydrate_notes("bass_detected_notes")
    other_notes = _hydrate_notes("other_detected_notes")
    eff_smoothing = normalize_playability_smoothing(
        payload.playability_smoothing or str(analysis.get("playability_smoothing") or "standard")
    )

    if lead_melody_active or piano_vocal_active:
        melody_source = vocal_notes if vocal_notes else refined_notes
        vocal_range = None
        if piano_vocal_active or (project.instrument or "").strip().lower() == "vocals" or bool(vocal_notes):
            app_cfg = get_settings()
            vocal_range = (app_cfg.VOCAL_RANGE_MIN_MIDI, app_cfg.VOCAL_RANGE_MAX_MIDI)
        melody_result = extract_lead_melody(
            melody_source,
            tempo_bpm=existing.tempo_bpm,
            vocal_range=vocal_range,
            key_signature=existing.key_signature,
        )
        arranged_notes = melody_result.notes or melody_source
        analysis["arrangement_detail"] = payload.arrangement_detail
        analysis["arrangement"] = {
            "mode": norm_mode,
            "input_note_count": len(refined_notes),
            "output_note_count": len(arranged_notes),
        }
        analysis["melody_extraction"] = melody_result.stats
        analysis["melody_uncertain_segments"] = melody_result.uncertain_segments
    else:
        arrangement = simplify_arrangement(
            refined_notes,
            tempo_bpm=existing.tempo_bpm,
            arrangement_detail=payload.arrangement_detail,
        )
        arranged_notes = arrangement.notes or refined_notes
        analysis["arrangement_detail"] = arrangement.arrangement_detail
        analysis["arrangement"] = arrangement.stats
        if "piano" in (project.instrument or "piano").lower():
            chord_proxies = [
                ScoreNote(
                    id=f"rcp_{idx}",
                    pitch_midi=n.pitch_midi,
                    onset_sec=max(0.0, n.onset_sec),
                    offset_sec=max(n.onset_sec + 0.02, n.offset_sec),
                    velocity=max(1, min(127, n.velocity)),
                    confidence=n.confidence,
                )
                for idx, n in enumerate(arranged_notes)
            ]
            prelim_chords = detect_chords(
                chord_proxies,
                existing.tempo_bpm,
                existing.time_signature,
                key_signature=existing.key_signature,
                bass_notes=bass_notes or None,
            )
            play_res = apply_piano_playability(
                arranged_notes,
                chords=prelim_chords,
                tempo_bpm=existing.tempo_bpm,
                time_signature=existing.time_signature,
                key_signature=existing.key_signature,
                mode=norm_mode,
                instrument=project.instrument or "piano",
                smoothing=eff_smoothing,
            )
            if play_res.notes:
                arranged_notes = play_res.notes
            analysis["playability"] = play_res.stats
        analysis.pop("melody_extraction", None)
        analysis.pop("melody_uncertain_segments", None)

    analysis["playability_smoothing"] = eff_smoothing

    quant = payload.quantization or str(analysis.get("quantization") or "sixteenth")
    if effective_mode:
        analysis["mode"] = norm_mode

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

    chord_source = select_chord_source_notes(other_notes, bass_notes, refined_notes)
    resolved_title = resolve_project_score_title(project.title)
    if piano_vocal_active:
        new_score = build_piano_vocal_score_data(
            title=resolved_title,
            melody_notes=arranged_notes,
            chord_source_notes=chord_source,
            bass_notes=bass_notes or None,
            other_notes=other_notes or None,
            tempo_bpm=existing.tempo_bpm,
            tempo_estimated=existing.tempo_estimated,
            time_signature=existing.time_signature,
            time_signature_estimated=existing.time_signature_estimated,
            key_signature=existing.key_signature,
            key_signature_estimated=existing.key_signature_estimated,
            duration_seconds=existing.duration_seconds,
            quantization=quant,
            arrangement_detail=payload.arrangement_detail,
            analysis=analysis,
        )
    else:
        new_score = build_score_data(
            title=resolved_title,
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
            clef_override="treble" if lead_melody_active else None,
            track_name_override="Lead Melody" if lead_melody_active else None,
            chord_source_notes=chord_source if lead_melody_active else None,
            bass_notes=bass_notes or None,
            monophonic=lead_melody_active,
            analysis=analysis,
        )

    musicxml_str = score_data_to_musicxml(new_score)
    midi_bytes = score_data_to_midi_bytes(new_score)

    old_xml_key = score_row.musicxml_path
    old_midi_key = score_row.midi_path
    xml_key = storage_service.build_key(current_user.id, project.id, "musicxml", "score.musicxml")
    storage_service.save_bytes(
        xml_key,
        musicxml_str.encode("utf-8"),
        content_type="application/vnd.recordare.musicxml+xml",
    )
    midi_key: str | None = None
    try:
        midi_key = storage_service.build_key(current_user.id, project.id, "midi", "score.mid")
        storage_service.save_bytes(midi_key, midi_bytes, content_type="audio/midi")

        score_row.version = int(score_row.version or 1) + 1
        score_row.score_json = new_score.model_dump()
        score_row.musicxml_path = xml_key
        score_row.midi_path = midi_key
        db.commit()
    except Exception:
        db.rollback()
        for new_key in (xml_key, midi_key):
            if new_key:
                try:
                    storage_service.delete(new_key)
                except Exception:
                    pass
        raise
    db.refresh(score_row)
    delete_unreferenced_storage_keys(
        db,
        [
            old_xml_key if old_xml_key != xml_key else None,
            old_midi_key if old_midi_key != midi_key else None,
        ],
    )

    return ProjectScoreResponse(
        id=score_row.id,
        project_id=score_row.project_id,
        version=score_row.version,
        score_json=score_row.score_json,
        musicxml=musicxml_str,
        updated_at=score_row.updated_at,
    )


class SATBAssignmentsUpdateRequest(BaseModel):
    assignments: dict[int, str]
    instruments: dict[int, int] | None = None


@router.put("/projects/{project_id}/score/satb-assignments", response_model=ProjectScoreResponse)
def update_satb_assignments(
    payload: SATBAssignmentsUpdateRequest,
    project: Project = Depends(get_owned_project),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Update SATB voice assignments and part instruments without rerunning OMR."""
    score_row = db.query(ProjectScore).filter(ProjectScore.project_id == project.id).first()
    if not score_row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project score not found.")

    score = ScoreData(**score_row.score_json)
    valid_voices = {"Soprano", "Alto", "Tenor", "Bass"}
    for t in score.tracks:
        assigned = payload.assignments.get(t.index)
        if assigned in valid_voices:
            t.name = assigned
            t.clef = "bass" if assigned == "Bass" else "treble"
        if payload.instruments and t.index in payload.instruments:
            prog = max(0, min(127, int(payload.instruments[t.index])))
            t.program = prog
            t.instrument = "choir_aahs" if prog == 52 else "piano"

    analysis = dict(score.analysis or {})
    satb_meta = dict(analysis.get("satb") or {})
    satb_meta["needs_review"] = False
    if isinstance(satb_meta.get("assignments"), list):
        for entry in satb_meta["assignments"]:
            p_idx = entry.get("part_index")
            if p_idx in payload.assignments and payload.assignments[p_idx] in valid_voices:
                entry["assigned_voice"] = payload.assignments[p_idx]
                entry["uncertain"] = False
                entry["confidence"] = 1.0
    analysis["satb"] = satb_meta
    score.analysis = analysis

    old_midi_key = score_row.midi_path
    midi_bytes = score_data_to_midi_bytes(score)
    midi_key = storage_service.build_key(current_user.id, project.id, "midi", "score.mid")
    storage_service.save_bytes(midi_key, midi_bytes, content_type="audio/midi")

    musicxml_str = None
    if score_row.musicxml_path and storage_service.exists(score_row.musicxml_path):
        musicxml_str = storage_service.read_bytes(score_row.musicxml_path).decode("utf-8")

    try:
        score_row.version = int(score_row.version or 1) + 1
        score_row.score_json = score.model_dump()
        score_row.midi_path = midi_key
        db.commit()
    except Exception:
        db.rollback()
        try:
            storage_service.delete(midi_key)
        except Exception:
            pass
        raise
    db.refresh(score_row)
    delete_unreferenced_storage_keys(db, [old_midi_key if old_midi_key != midi_key else None])

    return ProjectScoreResponse(
        id=score_row.id,
        project_id=score_row.project_id,
        version=score_row.version,
        score_json=score_row.score_json,
        musicxml=musicxml_str,
        updated_at=score_row.updated_at,
    )


class OmrVerifyRequest(BaseModel):
    force: bool = False


class OmrApplyFixesRequest(BaseModel):
    finding_ids: list[str] = Field(default_factory=list, min_length=1, max_length=100)


class OmrVerificationStatusResponse(BaseModel):
    verification: OmrVerificationReport
    gemini_configured: bool
    source_available: bool
    source_message: str | None = None
    can_revert: bool = False
    can_restore_previous: bool = False


class OmrApplyFixesResponse(BaseModel):
    score: ProjectScoreResponse
    verification: OmrVerificationReport
    applied_ids: list[str] = Field(default_factory=list)
    skipped_ids: list[str] = Field(default_factory=list)


def _read_score_musicxml_text(score_row: ProjectScore, resolved_title: str) -> str | None:
    if not score_row.musicxml_path or not storage_service.exists(score_row.musicxml_path):
        return None
    raw_bytes = storage_service.read_bytes(score_row.musicxml_path)
    if score_row.musicxml_path.lower().endswith(".mxl") or raw_bytes[:2] == b"PK":
        import io
        import zipfile

        try:
            with zipfile.ZipFile(io.BytesIO(raw_bytes), "r") as zf:
                xml_name = next(
                    (
                        n
                        for n in zf.namelist()
                        if n.lower().endswith((".xml", ".musicxml")) and "meta-inf" not in n.lower()
                    ),
                    None,
                )
                if not xml_name:
                    return None
                raw_xml = zf.read(xml_name).decode("utf-8-sig", errors="replace")
        except Exception:
            return None
    else:
        raw_xml = raw_bytes.decode("utf-8-sig", errors="replace")
    cleaned_xml, _ = sanitize_omr_musicxml(raw_xml)
    return apply_scribasheet_musicxml_branding(cleaned_xml, title=resolved_title, force_title=True)


def _resolve_omr_source_assets(db: Session, project: Project) -> tuple[list[MediaAsset], str | None]:
    """Locate original PDF or sheet image assets still present in storage for this project."""
    latest_job = (
        db.query(TranscriptionJob)
        .filter(TranscriptionJob.project_id == project.id)
        .order_by(TranscriptionJob.created_at.desc())
        .first()
    )
    candidate_assets: list[MediaAsset] = []
    ordered_ids = (
        (latest_job.settings_json or {}).get("source_asset_ids")
        if latest_job and isinstance(latest_job.settings_json, dict)
        else None
    )
    if isinstance(ordered_ids, list) and ordered_ids:
        rows = db.query(MediaAsset).filter(MediaAsset.id.in_(ordered_ids), MediaAsset.project_id == project.id).all()
        by_id = {r.id: r for r in rows}
        candidate_assets = [by_id[aid] for aid in ordered_ids if aid in by_id]
    elif latest_job and latest_job.source_asset_id:
        row = db.query(MediaAsset).filter(MediaAsset.id == latest_job.source_asset_id).first()
        if row:
            candidate_assets = [row]

    if not candidate_assets:
        candidate_assets = (
            db.query(MediaAsset)
            .filter(MediaAsset.project_id == project.id, MediaAsset.asset_type == "original")
            .order_by(MediaAsset.created_at.desc())
            .all()
        )

    score_assets = [
        a
        for a in candidate_assets
        if (
            "pdf" in (a.mime_type or "").lower()
            or "image/" in (a.mime_type or "").lower()
            or (a.original_filename or "").lower().endswith((".pdf", ".jpg", ".jpeg", ".png", ".webp"))
        )
    ]
    if not score_assets:
        return [], "No original PDF or sheet music image source file is attached to this project."

    existing = [a for a in score_assets if a.storage_path and storage_service.exists(a.storage_path)]
    if not existing:
        return [], "Original uploaded PDF/image files are no longer available in storage. Re-upload the original score to run AI Vision verification."
    if len(existing) < len(score_assets):
        return existing, f"Only {len(existing)} of {len(score_assets)} original source pages remain in storage."
    return existing, None


def _build_omr_verification_status(
    db: Session,
    project: Project,
    score_row: ProjectScore,
) -> OmrVerificationStatusResponse:
    cfg = get_settings()
    resolved_title = resolve_project_score_title(project.title)
    musicxml_str = _read_score_musicxml_text(score_row, resolved_title) or ""
    score_json = dict(score_row.score_json or {})
    analysis = dict(score_json.get("analysis") or {})
    source_assets, source_msg = _resolve_omr_source_assets(db, project)
    source_available = len(source_assets) > 0
    backup_key = analysis.get("omr_original_musicxml_path")
    can_revert = bool(isinstance(backup_key, str) and backup_key and storage_service.exists(backup_key))
    can_restore_previous = isinstance(analysis.get("previous_active_snapshot"), dict)

    stored_raw = analysis.get("omr_verification")
    current_hash = compute_musicxml_hash(musicxml_str)
    report: OmrVerificationReport | None = None
    if isinstance(stored_raw, dict):
        try:
            candidate = OmrVerificationReport.model_validate(stored_raw)
            if not current_hash or candidate.content_hash == current_hash:
                report = candidate.model_copy(
                    update={
                        "source_available": source_available,
                        "source_message": source_msg,
                        "can_revert": can_revert,
                    }
                )
        except Exception:
            report = None

    if report is None:
        report = evaluate_omr_structure(
            musicxml_str,
            source_available=source_available,
            source_message=source_msg,
            can_revert=can_revert,
            applied_finding_ids=list(analysis.get("omr_applied_finding_ids") or []),
        )

    return OmrVerificationStatusResponse(
        verification=report,
        gemini_configured=bool((cfg.GEMINI_API_KEY or "").strip()),
        source_available=source_available,
        source_message=source_msg,
        can_revert=can_revert,
        can_restore_previous=can_restore_previous,
    )


@router.get("/projects/{project_id}/score/omr-verification", response_model=OmrVerificationStatusResponse)
def get_omr_verification_status(
    project: Project = Depends(get_owned_project),
    db: Session = Depends(get_db),
):
    score_row = db.query(ProjectScore).filter(ProjectScore.project_id == project.id).first()
    if not score_row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project score not found.")
    return _build_omr_verification_status(db, project, score_row)


@router.post("/projects/{project_id}/score/omr-verify", response_model=OmrVerificationStatusResponse)
def run_omr_vision_verification(
    payload: OmrVerifyRequest,
    project: Project = Depends(get_owned_project),
    db: Session = Depends(get_db),
):
    """Run Gemini Vision verification against original source sheet music pages."""
    score_row = db.query(ProjectScore).filter(ProjectScore.project_id == project.id).first()
    if not score_row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project score not found.")

    resolved_title = resolve_project_score_title(project.title)
    musicxml_str = _read_score_musicxml_text(score_row, resolved_title)
    if not musicxml_str:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="MusicXML score file is missing from storage.")

    score_json = dict(score_row.score_json or {})
    analysis = dict(score_json.get("analysis") or {})
    current_hash = compute_musicxml_hash(musicxml_str)
    source_assets, source_msg = _resolve_omr_source_assets(db, project)
    backup_key = analysis.get("omr_original_musicxml_path")
    can_revert = bool(isinstance(backup_key, str) and backup_key and storage_service.exists(backup_key))
    can_restore_previous = isinstance(analysis.get("previous_active_snapshot"), dict)
    cfg = get_settings()

    # Reuse cached AI Vision report if MusicXML unchanged and not forcing re-verify
    stored_raw = analysis.get("omr_verification")
    if not payload.force and isinstance(stored_raw, dict):
        try:
            cached = OmrVerificationReport.model_validate(stored_raw)
            if cached.ai_verified and cached.content_hash == current_hash:
                refreshed = cached.model_copy(
                    update={
                        "source_available": len(source_assets) > 0,
                        "source_message": source_msg,
                        "can_revert": can_revert,
                    }
                )
                return OmrVerificationStatusResponse(
                    verification=refreshed,
                    gemini_configured=bool((cfg.GEMINI_API_KEY or "").strip()),
                    source_available=len(source_assets) > 0,
                    source_message=source_msg,
                    can_revert=can_revert,
                    can_restore_previous=can_restore_previous,
                )
        except Exception:
            pass

    if not source_assets:
        report = evaluate_omr_structure(
            musicxml_str,
            source_available=False,
            source_message=source_msg,
            can_revert=can_revert,
            applied_finding_ids=list(analysis.get("omr_applied_finding_ids") or []),
        ).model_copy(update={"ai_error": source_msg})
        analysis["omr_verification"] = report.model_dump()
        score_json["analysis"] = analysis
        score_row.score_json = score_json
        db.commit()
        return OmrVerificationStatusResponse(
            verification=report,
            gemini_configured=bool((cfg.GEMINI_API_KEY or "").strip()),
            source_available=False,
            source_message=source_msg,
            can_revert=can_revert,
            can_restore_previous=can_restore_previous,
        )

    with tempfile.TemporaryDirectory(prefix="scriba_omr_src_") as tmpdir:
        tmp_root = Path(tmpdir)
        local_sources: list[tuple[Path, str]] = []
        for idx, asset in enumerate(source_assets, start=1):
            raw_bytes = storage_service.read_bytes(asset.storage_path)
            ext = Path(asset.original_filename or "page").suffix or (
                ".pdf" if "pdf" in (asset.mime_type or "").lower() else ".png"
            )
            dst = tmp_root / f"source_{idx:03d}{ext}"
            dst.write_bytes(raw_bytes)
            local_sources.append((dst, asset.mime_type or ""))

        report = verify_omr_with_gemini_vision(
            musicxml_str,
            source_files=local_sources,
            settings=cfg,
            can_revert=can_revert,
            applied_finding_ids=list(analysis.get("omr_applied_finding_ids") or []),
        )

    analysis["omr_verification"] = report.model_dump()
    score_json["analysis"] = analysis
    score_row.score_json = score_json
    db.commit()

    return OmrVerificationStatusResponse(
        verification=report,
        gemini_configured=bool((cfg.GEMINI_API_KEY or "").strip()),
        source_available=report.source_available,
        source_message=report.source_message or source_msg,
        can_revert=can_revert,
        can_restore_previous=can_restore_previous,
    )


@router.post("/projects/{project_id}/score/omr-apply-fixes", response_model=OmrApplyFixesResponse)
def apply_omr_verification_fixes(
    payload: OmrApplyFixesRequest,
    project: Project = Depends(get_owned_project),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Apply user-reviewed AI OMR corrections safely, preserving original snapshot for revert."""
    score_row = db.query(ProjectScore).filter(ProjectScore.project_id == project.id).first()
    if not score_row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project score not found.")

    resolved_title = resolve_project_score_title(project.title)
    musicxml_str = _read_score_musicxml_text(score_row, resolved_title)
    if not musicxml_str:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="MusicXML score file is missing from storage.")

    score_json = dict(score_row.score_json or {})
    analysis = dict(score_json.get("analysis") or {})
    stored_raw = analysis.get("omr_verification")
    if not isinstance(stored_raw, dict):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No OMR verification report exists yet for this score.",
        )

    report = OmrVerificationReport.model_validate(stored_raw)
    findings_by_id = {f.id: f for f in report.findings if f.proposed_fix is not None}
    selected_fixes: list[tuple[str, OmrProposedFix]] = []
    for fid in payload.finding_ids:
        f_obj = findings_by_id.get(fid)
        if f_obj and f_obj.proposed_fix is not None:
            selected_fixes.append((fid, f_obj.proposed_fix))

    if not selected_fixes:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="None of the selected findings include an applicable MusicXML correction.",
        )

    backup_key = analysis.get("omr_original_musicxml_path")
    if not isinstance(backup_key, str) or not backup_key or not storage_service.exists(backup_key):
        backup_key = storage_service.build_key(current_user.id, project.id, "omr_backup", "original.musicxml")
        storage_service.save_bytes(
            backup_key,
            musicxml_str.encode("utf-8"),
            content_type="application/vnd.recordare.musicxml+xml",
        )

    patched_xml, applied_ids, skipped_ids = apply_omr_proposed_fixes(musicxml_str, selected_fixes)
    if not applied_ids:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="No selected corrections could be safely applied to the current MusicXML structure.",
        )

    branded_xml = apply_scribasheet_musicxml_branding(patched_xml, title=resolved_title, force_title=True)
    satb_mode_val = "keep_original" if str(analysis.get("mode") or "") == "satb_pdf" and len(score_json.get("tracks") or []) == 1 else "auto_satb"
    rebuilt_score, _, _, _ = musicxml_to_satb_score_data(
        branded_xml,
        title=resolved_title,
        satb_mode=satb_mode_val,
    )

    merged_analysis = dict(analysis)
    merged_analysis["omr_original_musicxml_path"] = backup_key
    prev_applied = list(merged_analysis.get("omr_applied_finding_ids") or [])
    all_applied = [*prev_applied, *[fid for fid in applied_ids if fid not in prev_applied]]
    merged_analysis["omr_applied_finding_ids"] = all_applied

    source_assets, source_msg = _resolve_omr_source_assets(db, project)
    refreshed_report = evaluate_omr_structure(
        branded_xml,
        source_available=len(source_assets) > 0,
        source_message=source_msg,
        can_revert=True,
        applied_finding_ids=all_applied,
    )
    merged_analysis["omr_verification"] = refreshed_report.model_dump()
    rebuilt_score.analysis = {**(rebuilt_score.analysis or {}), **merged_analysis}

    midi_bytes = score_data_to_midi_bytes(rebuilt_score)
    old_xml_key = score_row.musicxml_path
    old_midi_key = score_row.midi_path
    xml_key = storage_service.build_key(current_user.id, project.id, "musicxml", "score.musicxml")
    midi_key = storage_service.build_key(current_user.id, project.id, "midi", "score.mid")
    storage_service.save_bytes(xml_key, branded_xml.encode("utf-8"), content_type="application/vnd.recordare.musicxml+xml")
    storage_service.save_bytes(midi_key, midi_bytes, content_type="audio/midi")

    score_row.version = int(score_row.version or 1) + 1
    score_row.score_json = rebuilt_score.model_dump()
    score_row.musicxml_path = xml_key
    score_row.midi_path = midi_key
    db.commit()
    db.refresh(score_row)
    delete_unreferenced_storage_keys(
        db,
        [
            old_xml_key if old_xml_key not in (xml_key, backup_key) else None,
            old_midi_key if old_midi_key != midi_key else None,
        ],
    )

    return OmrApplyFixesResponse(
        score=ProjectScoreResponse(
            id=score_row.id,
            project_id=score_row.project_id,
            version=score_row.version,
            score_json=score_row.score_json,
            musicxml=branded_xml,
            updated_at=score_row.updated_at,
        ),
        verification=refreshed_report,
        applied_ids=applied_ids,
        skipped_ids=skipped_ids,
    )


@router.post("/projects/{project_id}/score/omr-revert", response_model=ProjectScoreResponse)
def revert_omr_to_original(
    project: Project = Depends(get_owned_project),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Revert AI OMR corrections back to the preserved original OMR MusicXML snapshot."""
    score_row = db.query(ProjectScore).filter(ProjectScore.project_id == project.id).first()
    if not score_row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project score not found.")

    score_json = dict(score_row.score_json or {})
    analysis = dict(score_json.get("analysis") or {})
    backup_key = analysis.get("omr_original_musicxml_path")
    if not isinstance(backup_key, str) or not backup_key or not storage_service.exists(backup_key):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Original pre-correction OMR snapshot is not available.",
        )

    resolved_title = resolve_project_score_title(project.title)
    orig_xml = storage_service.read_bytes(backup_key).decode("utf-8-sig", errors="replace")
    branded_xml = apply_scribasheet_musicxml_branding(orig_xml, title=resolved_title, force_title=True)
    rebuilt_score, _, _, _ = musicxml_to_satb_score_data(branded_xml, title=resolved_title)

    merged_analysis = dict(analysis)
    merged_analysis["omr_applied_finding_ids"] = []
    source_assets, source_msg = _resolve_omr_source_assets(db, project)
    refreshed_report = evaluate_omr_structure(
        branded_xml,
        source_available=len(source_assets) > 0,
        source_message=source_msg,
        can_revert=True,
        applied_finding_ids=[],
    )
    merged_analysis["omr_verification"] = refreshed_report.model_dump()
    rebuilt_score.analysis = {**(rebuilt_score.analysis or {}), **merged_analysis}

    midi_bytes = score_data_to_midi_bytes(rebuilt_score)
    old_xml_key = score_row.musicxml_path
    old_midi_key = score_row.midi_path
    xml_key = storage_service.build_key(current_user.id, project.id, "musicxml", "score.musicxml")
    midi_key = storage_service.build_key(current_user.id, project.id, "midi", "score.mid")
    storage_service.save_bytes(xml_key, branded_xml.encode("utf-8"), content_type="application/vnd.recordare.musicxml+xml")
    storage_service.save_bytes(midi_key, midi_bytes, content_type="audio/midi")

    score_row.version = int(score_row.version or 1) + 1
    score_row.score_json = rebuilt_score.model_dump()
    score_row.musicxml_path = xml_key
    score_row.midi_path = midi_key
    db.commit()
    db.refresh(score_row)
    delete_unreferenced_storage_keys(
        db,
        [
            old_xml_key if old_xml_key not in (xml_key, backup_key) else None,
            old_midi_key if old_midi_key != midi_key else None,
        ],
    )

    return ProjectScoreResponse(
        id=score_row.id,
        project_id=score_row.project_id,
        version=score_row.version,
        score_json=score_row.score_json,
        musicxml=branded_xml,
        updated_at=score_row.updated_at,
    )


@router.post("/projects/{project_id}/score/restore-previous", response_model=ProjectScoreResponse)
def restore_previous_project_score(
    project: Project = Depends(get_owned_project),
    db: Session = Depends(get_db),
):
    """Restore the pre-reprocess score snapshot when a Re-Transcribe job fails or is cancelled."""
    score_row = db.query(ProjectScore).filter(ProjectScore.project_id == project.id).first()
    if not score_row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project score not found.")

    score_json = dict(score_row.score_json or {})
    analysis = dict(score_json.get("analysis") or {})
    snapshot = analysis.get("previous_active_snapshot")
    if not isinstance(snapshot, dict) or not isinstance(snapshot.get("score_json"), dict):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No previous score snapshot is available to restore.",
        )

    restored_json = dict(snapshot["score_json"])
    restored_analysis = dict(restored_json.get("analysis") or {})
    restored_analysis["is_active"] = True
    restored_analysis.pop("superseded_by_job_id", None)
    restored_json["analysis"] = restored_analysis

    if snapshot.get("musicxml_path"):
        score_row.musicxml_path = snapshot["musicxml_path"]
    if snapshot.get("midi_path"):
        score_row.midi_path = snapshot["midi_path"]
    score_row.score_json = restored_json
    score_row.version = int(score_row.version or 1) + 1
    project.status = "ready"
    db.commit()
    db.refresh(score_row)

    resolved_title = resolve_project_score_title(project.title)
    musicxml_str = _read_score_musicxml_text(score_row, resolved_title)

    return ProjectScoreResponse(
        id=score_row.id,
        project_id=score_row.project_id,
        version=score_row.version,
        score_json=score_row.score_json,
        musicxml=musicxml_str,
        updated_at=score_row.updated_at,
    )
