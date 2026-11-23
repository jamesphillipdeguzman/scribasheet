import logging
import tempfile
from datetime import UTC, datetime
from pathlib import Path

from sqlalchemy.orm import Session

from app.audio.processor import MediaValidationError, preprocess_to_wav, probe_media
from app.audio.separator import detect_audio_source_route, separate_audio_stems
from app.core.logging import job_id_ctx
from app.db.session import SessionLocal
from app.models import (
    MediaAsset,
    Project,
    ProjectScore,
    TranscriptionJob,
    TranscriptionResult,
    UsageRecord,
)
from app.notation.generator import (
    score_data_to_midi_bytes,
    score_data_to_musicxml,
)
from app.schemas.transcription import TranscriptionSettings
from app.storage.service import storage_service
from app.transcription.core_pipeline import (
    analyze_timing_and_build_score,
    resolve_preprocessing_profile,
    transcribe_and_refine_audio,
)
from app.transcription.provider_factory import (
    get_target_sample_rate_for_engine,
    resolve_engine_for_instrument,
)
from app.workers.ws_manager import job_ws_manager

logger = logging.getLogger(__name__)


class JobCancelledError(Exception):
    pass


def _update_job(
    db: Session,
    job: TranscriptionJob,
    *,
    status: str,
    progress: int,
    stage: str,
    log_line: str | None = None,
) -> None:
    db.refresh(job)
    if job.status == "cancelled":
        raise JobCancelledError("Job was cancelled by user.")
    job.status = status
    job.progress = progress
    job.current_stage = stage
    if log_line:
        ts = datetime.now(UTC).strftime("%H:%M:%S")
        job.logs_text = f"{job.logs_text}[{ts}] {log_line}\n"
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


def run_transcription_pipeline(job_id: str) -> None:
    token = job_id_ctx.set(job_id)
    db = SessionLocal()
    try:
        job = db.query(TranscriptionJob).filter(TranscriptionJob.id == job_id).first()
        if not job:
            logger.error("TranscriptionJob %s not found", job_id)
            return

        project = db.query(Project).filter(Project.id == job.project_id).first()
        if not project:
            job.status = "failed"
            job.error_code = "PROJECT_NOT_FOUND"
            job.error_message = "Associated project no longer exists."
            db.commit()
            return

        if job.status == "cancelled":
            return

        job.started_at = datetime.now(UTC)
        project.status = "processing"
        db.commit()

        settings = TranscriptionSettings(**(job.settings_json or {}))

        # Stage 1: Validating
        _update_job(
            db,
            job,
            status="validating",
            progress=10,
            stage="Validating",
            log_line="Validating source media asset.",
        )

        asset = None
        if job.source_asset_id:
            asset = db.query(MediaAsset).filter(MediaAsset.id == job.source_asset_id).first()
        if not asset:
            asset = (
                db.query(MediaAsset)
                .filter(MediaAsset.project_id == project.id, MediaAsset.asset_type == "original")
                .order_by(MediaAsset.created_at.desc())
                .first()
            )
        if not asset:
            raise MediaValidationError("NO_SOURCE_MEDIA", "No uploaded audio or video file found for this project.")

        local_source_path = storage_service.get_local_file_path(asset.storage_path)
        meta = probe_media(local_source_path)

        with tempfile.TemporaryDirectory(prefix="scriba_") as tmpdir:
            tmp_path = Path(tmpdir)
            processed_wav = tmp_path / "normalized.wav"

            requested_engine, allow_fallback = resolve_engine_for_instrument(settings.instrument)
            target_sr = get_target_sample_rate_for_engine(requested_engine)
            prep_profile_name = resolve_preprocessing_profile(settings.instrument)

            # Stage 2: Preprocessing
            _update_job(
                db,
                job,
                status="preprocessing",
                progress=25,
                stage="Preprocessing",
                log_line=f"Normalizing audio ({prep_profile_name} profile, {target_sr} Hz) to mono WAV.",
            )
            proc_meta = preprocess_to_wav(
                local_source_path, processed_wav, target_sr=target_sr, profile=prep_profile_name
            )
            asset.duration_seconds = proc_meta.duration_seconds
            asset.sample_rate = proc_meta.sample_rate
            asset.channels = meta.channels
            project.duration_seconds = proc_meta.duration_seconds
            db.commit()

            sep_res = None
            separation_note = "Direct transcription (source separation not requested)."

            # Stage 3: Optional Source Separation
            if settings.enable_source_separation:
                _update_job(
                    db,
                    job,
                    status="separating",
                    progress=40,
                    stage="Separating",
                    log_line=f"Separating stems with Demucs ({settings.demucs_model}) when available.",
                )
                sep_res = separate_audio_stems(
                    local_source_path,
                    tmp_path / "stems",
                    enabled=True,
                    model_name=settings.demucs_model,
                    segment_sec=settings.demucs_segment_sec,
                    overlap=settings.demucs_overlap,
                )
                separation_note = sep_res.message
                if sep_res.available and sep_res.stems:
                    # Save generated stems as MediaAssets
                    for stem_name, stem_path in sep_res.stems.items():
                        stem_key = storage_service.build_key(
                            job.user_id, project.id, "stems", f"{stem_name}.wav"
                        )
                        stem_bytes = stem_path.read_bytes()
                        storage_service.save_bytes(stem_key, stem_bytes, content_type="audio/wav")
                        db.add(
                            MediaAsset(
                                project_id=project.id,
                                user_id=job.user_id,
                                asset_type="stem",
                                storage_path=stem_key,
                                original_filename=f"{stem_name}.wav",
                                mime_type="audio/wav",
                                size_bytes=len(stem_bytes),
                                duration_seconds=proc_meta.duration_seconds,
                            )
                        )
                    db.commit()
                else:
                    _update_job(
                        db,
                        job,
                        status="separating",
                        progress=42,
                        stage="Separating",
                        log_line=sep_res.message,
                    )

            source_route = detect_audio_source_route(
                local_source_path,
                sep_res.stems if sep_res and sep_res.available else None,
                requested_source_type=settings.audio_source_type,
                mode=settings.mode,
            )

            # Stage 4: AI Audio-to-MIDI Transcription via Provider Factory
            _update_job(
                db,
                job,
                status="transcribing",
                progress=58,
                stage="Transcribing",
                log_line=f"Running AI transcription (requested_engine={requested_engine}, allow_fallback={allow_fallback}).",
            )
            core_res = transcribe_and_refine_audio(
                processed_wav,
                tmp_path,
                settings=settings,
                requested_engine=requested_engine,
                allow_fallback=allow_fallback,
                target_sr=target_sr,
                prep_profile_name=prep_profile_name,
                sep_res=sep_res,
                source_route=source_route,
            )
            if core_res.exec_res.fallback_used:
                logger.warning(
                    "Job %s fell back from %s to %s: %s",
                    job_id,
                    core_res.exec_res.requested_engine,
                    core_res.exec_res.actual_engine,
                    core_res.exec_res.fallback_reason,
                )

            # Stage 5: Beat Tracking, TimingMap, Arrangement & MusicXML Notation Generation
            _update_job(
                db,
                job,
                status="generating_notation",
                progress=80,
                stage="Generating Notation",
                log_line=(
                    f"Detected {len(core_res.raw_notes)} raw note events ({len(core_res.refined_notes)} refined) "
                    f"with engine={core_res.exec_res.actual_engine}. Analyzing beats, TimingMap, key, arrangement, and MusicXML."
                ),
            )
            score_data = analyze_timing_and_build_score(
                title=project.title,
                processed_wav=processed_wav,
                proc_meta=proc_meta,
                settings=settings,
                core_res=core_res,
                sep_res=sep_res,
                source_route=source_route,
                extra_analysis={"separation_note": separation_note},
            )
            tempo_bpm = score_data.tempo_bpm
            key_sig = score_data.key_signature
            time_sig = score_data.time_signature

            musicxml_str = score_data_to_musicxml(score_data)
            midi_bytes = score_data_to_midi_bytes(score_data)

            # Stage 6: Finalizing & Persisting Artifacts
            _update_job(
                db,
                job,
                status="finalizing",
                progress=92,
                stage="Finalizing",
                log_line="Saving MIDI, MusicXML, and canonical project score.",
            )

            midi_key = storage_service.build_key(job.user_id, project.id, "midi", "transcription.mid")
            storage_service.save_bytes(midi_key, midi_bytes, content_type="audio/midi")
            midi_asset = MediaAsset(
                project_id=project.id,
                user_id=job.user_id,
                asset_type="midi",
                storage_path=midi_key,
                original_filename=f"{project.title}.mid",
                mime_type="audio/midi",
                size_bytes=len(midi_bytes),
                duration_seconds=proc_meta.duration_seconds,
            )
            db.add(midi_asset)

            xml_bytes = musicxml_str.encode("utf-8")
            xml_key = storage_service.build_key(job.user_id, project.id, "musicxml", "score.musicxml")
            storage_service.save_bytes(xml_key, xml_bytes, content_type="application/vnd.recordare.musicxml+xml")
            xml_asset = MediaAsset(
                project_id=project.id,
                user_id=job.user_id,
                asset_type="musicxml",
                storage_path=xml_key,
                original_filename=f"{project.title}.musicxml",
                mime_type="application/vnd.recordare.musicxml+xml",
                size_bytes=len(xml_bytes),
                duration_seconds=proc_meta.duration_seconds,
            )
            db.add(xml_asset)
            db.flush()

            score_payload = score_data.model_dump()
            score_analysis = dict(score_payload.get("analysis") or {})
            score_analysis["is_active"] = True
            score_analysis["job_id"] = job.id
            score_analysis.pop("superseded_by_job_id", None)
            score_payload["analysis"] = score_analysis

            existing_score = db.query(ProjectScore).filter(ProjectScore.project_id == project.id).first()
            if existing_score:
                existing_score.version += 1
                existing_score.score_json = score_payload
                existing_score.musicxml_path = xml_key
                existing_score.midi_path = midi_key
            else:
                db.add(
                    ProjectScore(
                        project_id=project.id,
                        version=1,
                        score_json=score_payload,
                        musicxml_path=xml_key,
                        midi_path=midi_key,
                    )
                )

            db.add(
                TranscriptionResult(
                    job_id=job.id,
                    midi_asset_id=midi_asset.id,
                    musicxml_asset_id=xml_asset.id,
                    metadata_json={
                        "is_active": True,
                        "job_id": job.id,
                        "note_count": len(score_data.notes),
                        "chord_count": len(score_data.chords),
                        "tempo_bpm": tempo_bpm,
                        "key_signature": key_sig,
                        "time_signature": time_sig,
                        "duration_seconds": proc_meta.duration_seconds,
                    },
                )
            )

            db.add(
                UsageRecord(
                    user_id=job.user_id,
                    operation="transcription_minutes",
                    quantity=max(0.1, round(proc_meta.duration_seconds / 60.0, 2)),
                )
            )

            project.status = "ready"
            project.instrument = settings.instrument
            project.transcription_mode = settings.mode
            job.completed_at = datetime.now(UTC)
            _update_job(
                db,
                job,
                status="completed",
                progress=100,
                stage="Completed",
                log_line="Transcription completed successfully.",
            )

    except JobCancelledError:
        logger.info("Transcription job %s cancelled.", job_id)
        if db.is_active:
            db.rollback()
        job = db.query(TranscriptionJob).filter(TranscriptionJob.id == job_id).first()
        if job:
            job.status = "cancelled"
            job.current_stage = "Cancelled"
            job.completed_at = datetime.now(UTC)
            project = db.query(Project).filter(Project.id == job.project_id).first()
            if project and project.status == "processing":
                project.status = "draft"
            db.commit()
    except MediaValidationError as exc:
        logger.warning("Media validation failed for job %s: %s", job_id, exc.message)
        _mark_failed(db, job_id, exc.code, exc.message)
    except Exception as exc:
        logger.exception("Transcription job %s failed unexpectedly", job_id)
        _mark_failed(db, job_id, "TRANSCRIPTION_FAILED", f"Transcription failed: {exc}")
    finally:
        db.close()
        job_id_ctx.reset(token)


def _mark_failed(db: Session, job_id: str, code: str, message: str) -> None:
    db.rollback()
    job = db.query(TranscriptionJob).filter(TranscriptionJob.id == job_id).first()
    if job:
        job.status = "failed"
        job.current_stage = "Failed"
        job.error_code = code
        job.error_message = message
        job.completed_at = datetime.now(UTC)
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
                "error_message": message,
            },
        )
