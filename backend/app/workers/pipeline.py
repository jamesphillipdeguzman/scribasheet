import logging
import tempfile
from datetime import UTC, datetime
from pathlib import Path

from sqlalchemy.orm import Session

from app.audio.processor import MediaValidationError, preprocess_to_wav, probe_media
from app.audio.separator import separate_audio_stems
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
from app.notation.analyzer import (
    estimate_key_signature,
    estimate_tempo,
    get_instrument_program_and_clef,
)
from app.notation.generator import (
    build_score_data,
    score_data_to_midi_bytes,
    score_data_to_musicxml,
)
from app.notation.melody import (
    extract_lead_melody,
    is_lead_melody_mode,
    normalize_transcription_mode,
)
from app.schemas.transcription import TranscriptionSettings
from app.storage.service import storage_service
from app.transcription.basic_pitch_provider import BasicPitchProvider
from app.transcription.note_refiner import refine_detected_notes
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

            # Stage 2: Preprocessing
            _update_job(
                db,
                job,
                status="preprocessing",
                progress=25,
                stage="Preprocessing",
                log_line="Normalizing audio to 22.05kHz mono WAV via FFmpeg/Librosa.",
            )
            proc_meta = preprocess_to_wav(local_source_path, processed_wav, target_sr=22050)
            asset.duration_seconds = proc_meta.duration_seconds
            asset.sample_rate = proc_meta.sample_rate
            asset.channels = meta.channels
            project.duration_seconds = proc_meta.duration_seconds
            db.commit()

            transcription_target_wav = processed_wav
            separation_note = "Direct transcription (source separation not requested)."

            # Stage 3: Optional Source Separation
            if settings.enable_source_separation:
                _update_job(
                    db,
                    job,
                    status="separating",
                    progress=40,
                    stage="Separating",
                    log_line="Checking source separation backend availability.",
                )
                sep_res = separate_audio_stems(processed_wav, tmp_path / "stems")
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
                    if settings.mode == "vocal_melody" and "vocals" in sep_res.stems:
                        transcription_target_wav = sep_res.stems["vocals"]
                else:
                    _update_job(
                        db,
                        job,
                        status="separating",
                        progress=42,
                        stage="Separating",
                        log_line=sep_res.message,
                    )

            # Stage 4: AI Audio-to-MIDI Transcription
            _update_job(
                db,
                job,
                status="transcribing",
                progress=58,
                stage="Transcribing",
                log_line="Running Spotify Basic Pitch neural network transcription.",
            )
            program, _ = get_instrument_program_and_clef(settings.instrument)
            provider = BasicPitchProvider()
            t_out = provider.transcribe(
                transcription_target_wav,
                onset_threshold=settings.onset_threshold,
                frame_threshold=settings.frame_threshold,
                min_note_length_ms=settings.min_note_length_ms,
                min_midi_pitch=settings.min_midi_pitch,
                max_midi_pitch=settings.max_midi_pitch,
                midi_program=program,
                transpose_semitones=settings.transpose_semitones,
            )

            refinement = refine_detected_notes(t_out.notes)
            refined_notes = refinement.notes or t_out.notes

            # Stage 5: Musical Analysis & MusicXML Notation Generation
            _update_job(
                db,
                job,
                status="generating_notation",
                progress=80,
                stage="Generating Notation",
                log_line=f"Detected {len(t_out.notes)} raw note events ({len(refined_notes)} refined). Analyzing tempo, key, chords, and building MusicXML.",
            )
            tempo_bpm, tempo_est = estimate_tempo(
                processed_wav, settings.tempo_mode, settings.manual_tempo_bpm, notes=refined_notes
            )
            key_sig, key_est = estimate_key_signature(refined_notes, settings.key_signature)
            time_sig = "4/4" if settings.time_signature == "auto" else settings.time_signature
            time_est = settings.time_signature == "auto"

            lead_melody_active = is_lead_melody_mode(settings.mode)
            melody_result = None
            final_notes = refined_notes
            if lead_melody_active:
                melody_result = extract_lead_melody(refined_notes, tempo_bpm=tempo_bpm)
                final_notes = melody_result.notes or refined_notes

            pipeline_analysis = {
                "engine": t_out.engine,
                "raw_note_count": len(t_out.notes),
                "note_count": len(final_notes),
                "refiner": refinement.stats,
                "is_silent_audio": proc_meta.is_silent,
                "separation": separation_note,
                "mode": normalize_transcription_mode(settings.mode),
            }
            if melody_result is not None:
                pipeline_analysis["melody_extraction"] = melody_result.stats
                pipeline_analysis["melody_uncertain_segments"] = melody_result.uncertain_segments

            score_data = build_score_data(
                title=project.title,
                detected_notes=final_notes,
                tempo_bpm=tempo_bpm,
                tempo_estimated=tempo_est,
                time_signature=time_sig,
                time_signature_estimated=time_est,
                key_signature=key_sig,
                key_signature_estimated=key_est,
                duration_seconds=proc_meta.duration_seconds,
                instrument=settings.instrument,
                quantization=settings.quantization,
                clef_override="treble" if lead_melody_active else None,
                track_name_override="Lead Melody" if lead_melody_active else None,
                chord_source_notes=refined_notes if lead_melody_active else None,
                analysis=pipeline_analysis,
            )

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
