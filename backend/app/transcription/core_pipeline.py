"""Shared, side-effect-free audio transcription, timing, and notation core.

Reused by both the server/Celery pipeline (`app.workers.pipeline`) and the
desktop worker (`app.worker_agent`) so provider selection, Beat This! / TimingMap
alignment, note refinement, and arrangement processing stay in parity without
coupling either caller to the other's transport, polling, or DB lifecycle.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from app.audio.processor import AudioMetadata, preprocess_to_wav
from app.audio.separator import SeparationResult, detect_audio_source_route
from app.core.config import get_settings
from app.notation.analyzer import (
    estimate_key_signature,
    estimate_tempo_with_diagnostics,
    get_instrument_program_and_clef,
    select_chord_source_notes,
)
from app.notation.arrangement import simplify_arrangement
from app.notation.beat_tracker import track_beats_and_downbeats
from app.notation.generator import build_piano_vocal_score_data, build_score_data, clean_score_title
from app.notation.melody import (
    extract_lead_melody,
    is_lead_melody_mode,
    normalize_transcription_mode,
)
from app.notation.timing_map import TimingMap, build_timing_map
from app.schemas.score import ScoreData
from app.schemas.transcription import TranscriptionSettings
from app.transcription.base import DetectedNote, TranscriptionProvider
from app.transcription.basic_pitch_provider import TranscriptionInferenceError
from app.transcription.note_refiner import NoteRefinerConfig, refine_detected_notes
from app.transcription.provider_factory import (
    ProviderExecutionResult,
    transcribe_with_provider,
)

logger = logging.getLogger(__name__)


def resolve_preprocessing_profile(instrument: str) -> str:
    lower = (instrument or "").lower()
    if "piano" in lower:
        return "piano"
    if "vocal" in lower:
        return "vocal"
    return "general"


@dataclass
class CoreTranscriptionResult:
    exec_res: ProviderExecutionResult
    raw_notes: list[DetectedNote]
    refined_notes: list[DetectedNote]
    refiner_stats: dict[str, Any]
    vocal_refined_notes: list[DetectedNote] = field(default_factory=list)
    bass_refined_notes: list[DetectedNote] = field(default_factory=list)
    other_refined_notes: list[DetectedNote] = field(default_factory=list)
    is_vocal_melody_route: bool = False


def transcribe_and_refine_audio(
    processed_wav: Path,
    tmp_path: Path,
    *,
    settings: TranscriptionSettings,
    requested_engine: str,
    allow_fallback: bool,
    target_sr: int,
    prep_profile_name: str,
    sep_res: SeparationResult | None = None,
    source_route: dict[str, Any] | None = None,
    custom_provider: TranscriptionProvider | None = None,
    custom_provider_engine: str | None = None,
    refiner_cfg: NoteRefinerConfig | None = None,
) -> CoreTranscriptionResult:
    """Run provider-aware transcription + single-pass note refinement (direct or stem-routed)."""
    program, _ = get_instrument_program_and_clef(settings.instrument)
    cfg = refiner_cfg or NoteRefinerConfig()

    def _run_transcribe(audio_target: Path, min_pitch: int, max_pitch: int, midi_prog: int) -> ProviderExecutionResult:
        return transcribe_with_provider(
            audio_target,
            engine=requested_engine,
            allow_fallback=allow_fallback,
            provider=custom_provider if requested_engine == custom_provider_engine else None,
            onset_threshold=settings.onset_threshold,
            frame_threshold=settings.frame_threshold,
            min_note_length_ms=settings.min_note_length_ms,
            min_midi_pitch=min_pitch,
            max_midi_pitch=max_pitch,
            midi_program=midi_prog,
            transpose_semitones=settings.transpose_semitones,
            concert_pitch_hz=settings.concert_pitch_hz,
        )

    is_vocal_melody_route = bool(
        sep_res is not None
        and sep_res.available
        and source_route is not None
        and source_route.get("resolved_source_type") == "full_song"
        and "vocals" in sep_res.stems
    )

    vocal_refined_notes: list[DetectedNote] = []
    bass_refined_notes: list[DetectedNote] = []
    other_refined_notes: list[DetectedNote] = []

    if is_vocal_melody_route and sep_res is not None:
        vocal_wav = tmp_path / "stems_proc_vocals.wav"
        preprocess_to_wav(sep_res.stems["vocals"], vocal_wav, target_sr=target_sr, profile="vocals")
        exec_res = _run_transcribe(vocal_wav, settings.min_midi_pitch, settings.max_midi_pitch, 52)
        vocal_ref = refine_detected_notes(exec_res.output.notes, config=cfg)
        vocal_refined_notes = vocal_ref.notes or exec_res.output.notes

        stem_raw_count = len(exec_res.output.notes)
        stem_stats_list = [vocal_ref.stats]

        if "bass" in sep_res.stems:
            bass_wav = tmp_path / "stems_proc_bass.wav"
            preprocess_to_wav(sep_res.stems["bass"], bass_wav, target_sr=target_sr, profile="bass")
            bass_exec = _run_transcribe(
                bass_wav, max(24, settings.min_midi_pitch), min(64, settings.max_midi_pitch), 32
            )
            bass_ref = refine_detected_notes(bass_exec.output.notes, config=cfg)
            bass_refined_notes = bass_ref.notes or bass_exec.output.notes
            stem_raw_count += len(bass_exec.output.notes)
            stem_stats_list.append(bass_ref.stats)

        if "other" in sep_res.stems:
            other_wav = tmp_path / "stems_proc_other.wav"
            preprocess_to_wav(sep_res.stems["other"], other_wav, target_sr=target_sr, profile=prep_profile_name)
            other_exec = _run_transcribe(other_wav, settings.min_midi_pitch, settings.max_midi_pitch, program)
            other_ref = refine_detected_notes(other_exec.output.notes, config=cfg)
            other_refined_notes = other_ref.notes or other_exec.output.notes
            stem_raw_count += len(other_exec.output.notes)
            stem_stats_list.append(other_ref.stats)

        combined_stem_notes = sorted(
            [*vocal_refined_notes, *bass_refined_notes, *other_refined_notes],
            key=lambda n: (n.onset_sec, n.pitch_midi),
        )
        if not combined_stem_notes:
            exec_res = _run_transcribe(processed_wav, settings.min_midi_pitch, settings.max_midi_pitch, program)
            t_out = exec_res.output
            refinement = refine_detected_notes(t_out.notes, config=cfg)
            refined_notes = refinement.notes or t_out.notes
            raw_notes = t_out.notes
            refiner_stats = refinement.stats
        else:
            # Each stem was already refined once; aggregate stats without re-running refinement
            raw_notes = exec_res.output.notes
            refined_notes = combined_stem_notes
            refiner_stats = {
                "raw_count": stem_raw_count,
                "filtered_short_or_low_conf": sum(int(s.get("filtered_short_or_low_conf", 0)) for s in stem_stats_list),
                "reattack_merges": sum(int(s.get("reattack_merges", 0)) for s in stem_stats_list),
                "octave_ghosts_suppressed": sum(int(s.get("octave_ghosts_suppressed", 0)) for s in stem_stats_list),
                "refined_count": len(combined_stem_notes),
            }
    else:
        exec_res = _run_transcribe(processed_wav, settings.min_midi_pitch, settings.max_midi_pitch, program)
        t_out = exec_res.output
        if not t_out.notes:
            raise TranscriptionInferenceError(
                "NO_NOTES_DETECTED",
                "No valid musical notes were detected in the audio recording.",
            )
        refinement = refine_detected_notes(t_out.notes, config=cfg)
        refined_notes = refinement.notes or t_out.notes
        raw_notes = t_out.notes
        refiner_stats = refinement.stats

    if not refined_notes:
        raise TranscriptionInferenceError(
            "NO_NOTES_DETECTED",
            "No valid musical notes were detected in the audio recording.",
        )

    return CoreTranscriptionResult(
        exec_res=exec_res,
        raw_notes=raw_notes,
        refined_notes=refined_notes,
        refiner_stats=refiner_stats,
        vocal_refined_notes=vocal_refined_notes,
        bass_refined_notes=bass_refined_notes,
        other_refined_notes=other_refined_notes,
        is_vocal_melody_route=is_vocal_melody_route,
    )


def analyze_timing_and_build_score(
    *,
    title: str,
    processed_wav: Path,
    proc_meta: AudioMetadata,
    settings: TranscriptionSettings,
    core_res: CoreTranscriptionResult,
    sep_res: SeparationResult | None = None,
    source_route: dict[str, Any] | None = None,
    extra_analysis: dict[str, Any] | None = None,
) -> ScoreData:
    """Run Beat This!/TimingMap alignment, key estimation, arrangement processing, and ScoreData assembly."""
    refined_notes = core_res.refined_notes
    time_sig = "4/4" if settings.time_signature == "auto" else settings.time_signature
    time_est = settings.time_signature == "auto"
    beats_per_bar = max(1, int(time_sig.split("/")[0])) if "/" in time_sig else 4

    timing_map: TimingMap | None = None
    if settings.tempo_mode == "manual" and settings.manual_tempo_bpm is not None:
        tempo_bpm = round(float(settings.manual_tempo_bpm), 1)
        tempo_est = False
        tempo_diag: dict[str, Any] = {"tempo_bpm": tempo_bpm, "tempo_estimated": False, "candidates": []}
    else:
        note_durs = [max(0.05, n.offset_sec - n.onset_sec) for n in refined_notes]
        try:
            beat_res = track_beats_and_downbeats(
                processed_wav,
                beats_per_measure=beats_per_bar,
                note_durations_sec=note_durs,
            )
            timing_map = build_timing_map(
                beat_result=beat_res,
                notes=refined_notes,
                duration_seconds=proc_meta.duration_seconds,
                time_signature=time_sig,
            )
            tempo_bpm = timing_map.tempo_bpm
            tempo_est = True
            tempo_diag = timing_map.provenance
        except Exception as exc:
            logger.warning("Beat/TimingMap analysis failed (%s); falling back to Librosa tempo estimation.", exc)
            tempo_diag = estimate_tempo_with_diagnostics(
                processed_wav, settings.tempo_mode, settings.manual_tempo_bpm, notes=refined_notes
            )
            tempo_bpm = float(tempo_diag["tempo_bpm"])
            tempo_est = bool(tempo_diag["tempo_estimated"])
            tempo_diag["fallback_used"] = True
            tempo_diag["fallback_reason"] = str(exc)

    key_sig, key_est = estimate_key_signature(refined_notes, settings.key_signature)

    norm_mode = normalize_transcription_mode(settings.mode)
    lead_melody_active = is_lead_melody_mode(settings.mode)
    piano_vocal_active = norm_mode == "piano_vocal"
    melody_source_notes = core_res.vocal_refined_notes if core_res.vocal_refined_notes else refined_notes
    melody_result = None

    if lead_melody_active or piano_vocal_active:
        vocal_range = None
        if piano_vocal_active or core_res.is_vocal_melody_route or (settings.instrument or "").strip().lower() == "vocals":
            app_cfg = get_settings()
            vocal_range = (app_cfg.VOCAL_RANGE_MIN_MIDI, app_cfg.VOCAL_RANGE_MAX_MIDI)
        melody_result = extract_lead_melody(
            melody_source_notes,
            tempo_bpm=tempo_bpm,
            timing_map=timing_map,
            vocal_range=vocal_range,
            key_signature=key_sig,
        )
        arranged_notes = melody_result.notes or melody_source_notes
        arrangement_detail_value = settings.arrangement_detail
        arrangement_stats: dict[str, Any] = {
            "mode": norm_mode,
            "input_note_count": len(refined_notes),
            "output_note_count": len(arranged_notes),
        }
    else:
        arrangement = simplify_arrangement(
            refined_notes,
            tempo_bpm=tempo_bpm,
            arrangement_detail=settings.arrangement_detail,
        )
        arranged_notes = arrangement.notes or refined_notes
        arrangement_detail_value = arrangement.arrangement_detail
        arrangement_stats = arrangement.stats

    exec_res = core_res.exec_res
    t_out = exec_res.output
    score_analysis: dict[str, Any] = {
        "engine": t_out.engine,
        "requested_engine": exec_res.requested_engine,
        "actual_engine": exec_res.actual_engine,
        "fallback_used": exec_res.fallback_used,
        "fallback_reason": exec_res.fallback_reason,
        "model": t_out.metadata.get("model"),
        "raw_note_count": len(core_res.raw_notes),
        "note_count": len(arranged_notes),
        "refiner": core_res.refiner_stats,
        "arrangement_detail": arrangement_detail_value,
        "arrangement": arrangement_stats,
        "quantization": settings.quantization,
        "tempo_diagnostics": tempo_diag,
        "is_silent_audio": proc_meta.is_silent,
        "mode": norm_mode,
        "audio_source_type": settings.audio_source_type,
        "source_route": source_route or detect_audio_source_route(processed_wav, None, requested_source_type=settings.audio_source_type, mode=settings.mode),
        "enable_source_separation": bool(settings.enable_source_separation),
        "separation": {
            "enabled": bool(settings.enable_source_separation),
            "available": bool(sep_res and sep_res.available),
            "backend": sep_res.backend if sep_res else "none",
            "model_name": sep_res.model_name if sep_res else settings.demucs_model,
            "device": sep_res.device if sep_res else "cpu",
            "stems": sorted(sep_res.stems.keys()) if sep_res and sep_res.available else [],
            "message": sep_res.message if sep_res else "Source separation disabled.",
        },
        "concert_pitch_hz": settings.concert_pitch_hz,
    }
    if melody_result is not None:
        score_analysis["melody_extraction"] = melody_result.stats
        score_analysis["melody_uncertain_segments"] = melody_result.uncertain_segments
    if extra_analysis:
        score_analysis.update(extra_analysis)

    clean_title = clean_score_title(title)
    if piano_vocal_active:
        chord_source = select_chord_source_notes(
            core_res.other_refined_notes,
            core_res.bass_refined_notes,
            refined_notes,
        )
        return build_piano_vocal_score_data(
            title=clean_title,
            melody_notes=arranged_notes,
            chord_source_notes=chord_source,
            bass_notes=core_res.bass_refined_notes or None,
            other_notes=core_res.other_refined_notes or None,
            tempo_bpm=tempo_bpm,
            tempo_estimated=tempo_est,
            time_signature=time_sig,
            time_signature_estimated=time_est,
            key_signature=key_sig,
            key_signature_estimated=key_est,
            duration_seconds=proc_meta.duration_seconds,
            quantization=settings.quantization,
            arrangement_detail=settings.arrangement_detail,
            timing_map=timing_map,
            analysis=score_analysis,
        )

    return build_score_data(
        title=clean_title,
        detected_notes=arranged_notes,
        tempo_bpm=tempo_bpm,
        tempo_estimated=tempo_est,
        time_signature=time_sig,
        time_signature_estimated=time_est,
        key_signature=key_sig,
        key_signature_estimated=key_est,
        duration_seconds=proc_meta.duration_seconds,
        instrument=settings.instrument,
        quantization=settings.quantization,
        timing_map=timing_map,
        clef_override="treble" if lead_melody_active else None,
        track_name_override="Lead Melody" if lead_melody_active else None,
        chord_source_notes=(
            select_chord_source_notes(core_res.other_refined_notes, core_res.bass_refined_notes, refined_notes)
            if lead_melody_active
            else None
        ),
        monophonic=lead_melody_active,
        analysis=score_analysis,
    )
