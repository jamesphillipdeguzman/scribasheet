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
from app.audio.separator import (
    SeparationResult,
    _wav_rms,
    classify_audio_content,
    detect_audio_source_route,
    mix_wav_stems,
)
from app.core.config import get_settings
from app.notation.analyzer import (
    detect_chords,
    estimate_key_signature,
    estimate_tempo_with_diagnostics,
    get_instrument_program_and_clef,
    select_chord_source_notes,
)
from app.notation.arrangement import simplify_arrangement
from app.notation.beat_tracker import infer_time_signature_from_beats, track_beats_and_downbeats
from app.notation.generator import build_piano_vocal_score_data, build_score_data, clean_score_title
from app.notation.melody import (
    extract_lead_melody,
    is_lead_melody_mode,
    normalize_transcription_mode,
)
from app.notation.piano_playability import apply_piano_playability, normalize_playability_smoothing
from app.notation.timing_map import TimingMap, build_timing_map
from app.schemas.score import ScoreData, ScoreNote
from app.schemas.transcription import TranscriptionSettings
from app.transcription.base import DetectedNote, TranscriptionOutput, TranscriptionProvider
from app.transcription.basic_pitch_provider import TranscriptionInferenceError
from app.transcription.note_refiner import NoteRefinerConfig, refine_detected_notes
from app.transcription.provider_factory import (
    ProviderExecutionResult,
    transcribe_with_provider,
)
from app.transcription.vocal_pitch_tracker import (
    VocalPitchTrackerConfig,
    transcribe_vocal_melody_f0,
)

logger = logging.getLogger(__name__)


def resolve_preprocessing_profile(instrument: str) -> str:
    lower = (instrument or "").lower()
    if "piano" in lower:
        return "piano"
    if "vocal" in lower:
        return "vocal"
    return "general"


_MAJOR_INTERVALS = (0, 2, 4, 5, 7, 9, 11)
_MINOR_INTERVALS = (0, 2, 3, 5, 7, 8, 10)
_NOTE_NAME_PC = {
    "C": 0, "C#": 1, "DB": 1, "D": 2, "D#": 3, "EB": 3, "E": 4,
    "F": 5, "F#": 6, "GB": 6, "G": 7, "G#": 8, "AB": 8, "A": 9,
    "A#": 10, "BB": 10, "B": 11,
}


def _diatonic_pcs_for_key(key_signature: str | None) -> set[int]:
    clean = (key_signature or "C").strip()
    is_minor = clean.lower().endswith("minor") or (clean.endswith("m") and len(clean) > 1 and not clean.lower().endswith("major"))
    root_tok = clean.split()[0].rstrip("m")
    root_pc = _NOTE_NAME_PC.get(root_tok.upper(), 0)
    intervals = _MINOR_INTERVALS if is_minor else _MAJOR_INTERVALS
    return {(root_pc + iv) % 12 for iv in intervals}


def score_transcription_quality(
    notes: list[DetectedNote],
    key_signature: str | None = None,
) -> dict[str, Any]:
    """Compute objective quality diagnostics for comparing original vs separated piano transcriptions."""
    if not notes:
        return {
            "note_count": 0,
            "in_key_ratio": 0.0,
            "octave_harmonic_ratio": 1.0,
            "micro_blip_ratio": 1.0,
            "bass_coverage": 0.0,
            "dense_cluster_ratio": 1.0,
            "composite_score": 0.0,
        }

    eff_key = key_signature
    if not eff_key:
        eff_key, _ = estimate_key_signature(notes, "auto")
    key_pcs = _diatonic_pcs_for_key(eff_key)

    ordered = sorted(notes, key=lambda n: (n.onset_sec, n.pitch_midi))
    n_total = len(ordered)
    in_key_count = sum(1 for n in ordered if (n.pitch_midi % 12) in key_pcs)
    in_key_ratio = in_key_count / float(n_total)

    micro_blips = sum(
        1 for n in ordered if (n.offset_sec - n.onset_sec) < 0.06 and n.velocity < 60
    )
    micro_blip_ratio = micro_blips / float(n_total)

    bass_notes = [n for n in ordered if n.pitch_midi < 55 and (n.offset_sec - n.onset_sec) >= 0.14]
    bass_coverage = min(1.0, len(bass_notes) / max(1.0, n_total * 0.12))

    # Count simultaneous pairs looking like weak +12/+24/+19 harmonic artifacts
    harmonic_suspects = 0
    dense_clusters = 0
    cluster_count = 0
    i = 0
    while i < n_total:
        j = i + 1
        while j < n_total and ordered[j].onset_sec - ordered[i].onset_sec <= 0.035:
            j += 1
        cluster = ordered[i:j]
        cluster_count += 1
        if len(cluster) >= 7:
            dense_clusters += 1
        for a_idx in range(len(cluster)):
            low = cluster[a_idx]
            for b_idx in range(a_idx + 1, len(cluster)):
                high = cluster[b_idx]
                diff = high.pitch_midi - low.pitch_midi
                if diff in (12, 24, 19) and high.velocity <= low.velocity - 16 and high.velocity < 78:
                    harmonic_suspects += 1
                    break
        i = j

    octave_harmonic_ratio = harmonic_suspects / float(n_total)
    dense_cluster_ratio = dense_clusters / max(1.0, float(cluster_count))

    composite = (
        0.38 * in_key_ratio
        + 0.20 * bass_coverage
        + 0.18 * (1.0 - min(1.0, micro_blip_ratio * 2.5))
        + 0.14 * (1.0 - min(1.0, octave_harmonic_ratio * 3.0))
        + 0.10 * (1.0 - min(1.0, dense_cluster_ratio * 2.0))
    )
    return {
        "note_count": n_total,
        "key_used": eff_key,
        "in_key_ratio": round(in_key_ratio, 4),
        "octave_harmonic_ratio": round(octave_harmonic_ratio, 4),
        "micro_blip_ratio": round(micro_blip_ratio, 4),
        "bass_coverage": round(bass_coverage, 4),
        "dense_cluster_ratio": round(dense_cluster_ratio, 4),
        "composite_score": round(composite, 4),
    }


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
    source_selection: dict[str, Any] = field(default_factory=dict)
    vocal_tracking: dict[str, Any] = field(default_factory=dict)
    vocal_from_monophonic_tracker: bool = False


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
    """Run provider-aware transcription + note refinement (vocal-stem F0 or polyphonic pipeline)."""
    program, _ = get_instrument_program_and_clef(settings.instrument)
    cfg = refiner_cfg or NoteRefinerConfig()
    norm_mode = normalize_transcription_mode(settings.mode)
    lead_melody_active = is_lead_melody_mode(settings.mode)
    piano_vocal_active = norm_mode == "piano_vocal"
    vocal_mode_active = lead_melody_active or piano_vocal_active or norm_mode == "vocal_melody"
    req_source_type = (settings.audio_source_type or "auto").strip().lower()
    explicit_solo = req_source_type == "solo_piano"
    is_piano_target = (
        norm_mode in ("piano", "single_instrument", "multi_instrument")
        and "piano" in (settings.instrument or "").lower()
    )

    # Safeguard: Lead Melody with Automatic / Full Song source must receive an actual isolated vocals stem.
    # Never silently substitute bass.wav, other.wav, or the full mix when vocal isolation fails or is missing.
    if lead_melody_active and not explicit_solo:
        vocals_path = sep_res.stems.get("vocals") if (sep_res is not None and sep_res.available) else None
        if sep_res is None or not sep_res.available or vocals_path is None or not Path(vocals_path).exists():
            raise TranscriptionInferenceError(
                "VOCAL_STEM_UNAVAILABLE",
                (
                    sep_res.message
                    if (sep_res is not None and sep_res.message and not sep_res.available)
                    else "Lead Melody requires an isolated vocals stem (vocals.wav), which is unavailable. "
                    "Enable Demucs separation or switch Audio Source to Solo Piano / Instrumental."
                ),
            )

    def _run_transcribe(
        audio_target: Path,
        min_pitch: int,
        max_pitch: int,
        midi_prog: int,
        engine_override: str | None = None,
    ) -> ProviderExecutionResult:
        eff_engine = engine_override or requested_engine
        return transcribe_with_provider(
            audio_target,
            engine=eff_engine,
            allow_fallback=allow_fallback,
            provider=custom_provider if eff_engine == custom_provider_engine else None,
            onset_threshold=settings.onset_threshold,
            frame_threshold=settings.frame_threshold,
            min_note_length_ms=settings.min_note_length_ms,
            min_midi_pitch=min_pitch,
            max_midi_pitch=max_pitch,
            midi_program=midi_prog,
            transpose_semitones=settings.transpose_semitones,
            concert_pitch_hz=settings.concert_pitch_hz,
        )

    def _run_monophonic_vocal_tracker(audio_target: Path, stem_label: str) -> tuple[ProviderExecutionResult, list[DetectedNote], dict[str, Any]]:
        v_cfg = VocalPitchTrackerConfig(
            min_midi=max(36, int(settings.min_midi_pitch)),
            max_midi=min(96, int(settings.max_midi_pitch)),
            concert_pitch_hz=float(settings.concert_pitch_hz),
            transpose_semitones=int(settings.transpose_semitones),
        )
        v_res = transcribe_vocal_melody_f0(audio_target, config=v_cfg)
        v_exec = ProviderExecutionResult(
            output=TranscriptionOutput(
                engine="vocal_pyin",
                notes=v_res.notes,
                midi_bytes=b"",
                duration_seconds=v_res.duration_seconds,
                metadata={"model": "librosa_pyin", "source_stem": stem_label, "source_path": str(audio_target)},
            ),
            requested_engine="vocal_pyin",
            actual_engine="vocal_pyin",
            fallback_used=False,
        )
        tracking_info = {
            "engine": "vocal_pyin",
            "source_stem": stem_label,
            "source_path": str(audio_target),
            **v_res.stats,
        }
        return v_exec, v_res.notes, tracking_info

    content_class = (source_route or {}).get("content_classification") or classify_audio_content(
        processed_wav, sep_res.stems if sep_res and sep_res.available else None
    )
    content_type = str(content_class.get("content_type") or "solo_piano")

    is_vocal_melody_route = bool(
        sep_res is not None
        and sep_res.available
        and "vocals" in sep_res.stems
        and not explicit_solo
        and (
            vocal_mode_active
            or (
                source_route is not None
                and source_route.get("resolved_source_type") == "full_song"
                and not is_piano_target
            )
        )
    )

    vocal_refined_notes: list[DetectedNote] = []
    bass_refined_notes: list[DetectedNote] = []
    other_refined_notes: list[DetectedNote] = []
    vocal_tracking: dict[str, Any] = {}
    vocal_from_monophonic_tracker = False
    source_selection: dict[str, Any] = {
        "selected": "original",
        "content_type": content_type,
        "reason": "direct_transcription",
    }

    if is_vocal_melody_route and sep_res is not None:
        raw_vocals_stem = sep_res.stems["vocals"]
        vocal_wav = tmp_path / "stems_proc_vocals.wav"
        preprocess_to_wav(raw_vocals_stem, vocal_wav, target_sr=22050, profile="vocal")
        exec_res, vocal_refined_notes, vocal_tracking = _run_monophonic_vocal_tracker(vocal_wav, "vocals")
        vocal_tracking["original_stem_path"] = str(raw_vocals_stem)
        vocal_from_monophonic_tracker = True

        # Accompaniment stems use Basic Pitch (not Transkun acoustic piano) when transcribing chords/context
        accomp_engine = "basic_pitch" if requested_engine == "transkun" else requested_engine
        accomp_sr = 22050 if accomp_engine == "basic_pitch" else target_sr

        if "bass" in sep_res.stems:
            bass_wav = tmp_path / "stems_proc_bass.wav"
            preprocess_to_wav(sep_res.stems["bass"], bass_wav, target_sr=accomp_sr, profile="general")
            try:
                bass_exec = _run_transcribe(
                    bass_wav, max(24, settings.min_midi_pitch), min(64, settings.max_midi_pitch), 32, engine_override=accomp_engine
                )
                bass_ref = refine_detected_notes(bass_exec.output.notes, config=cfg)
                bass_refined_notes = bass_ref.notes or bass_exec.output.notes
            except TranscriptionInferenceError:
                bass_refined_notes = []

        if "other" in sep_res.stems:
            other_wav = tmp_path / "stems_proc_other.wav"
            preprocess_to_wav(sep_res.stems["other"], other_wav, target_sr=accomp_sr, profile="general")
            try:
                other_exec = _run_transcribe(
                    other_wav, settings.min_midi_pitch, settings.max_midi_pitch, program, engine_override=accomp_engine
                )
                other_ref = refine_detected_notes(other_exec.output.notes, config=cfg)
                other_refined_notes = other_ref.notes or other_exec.output.notes
            except TranscriptionInferenceError:
                other_refined_notes = []

        if not vocal_refined_notes:
            if lead_melody_active:
                raise TranscriptionInferenceError(
                    "NO_VOCAL_MELODY_DETECTED",
                    "No singable vocal melody was detected in the isolated vocals stem.",
                )
            # For piano+vocal only, allow accompaniment fallback when no vocal line exists
            combined_accomp = sorted(
                [*bass_refined_notes, *other_refined_notes],
                key=lambda n: (n.onset_sec, n.pitch_midi),
            )
            if not combined_accomp:
                raise TranscriptionInferenceError(
                    "NO_NOTES_DETECTED",
                    "No valid musical notes were detected in the audio recording.",
                )
            refined_notes = combined_accomp
            raw_notes = list(combined_accomp)
            refiner_stats = {"raw_count": len(raw_notes), "refined_count": len(refined_notes)}
            source_selection = {
                "selected": "separated_accompaniment_fallback",
                "content_type": content_type,
                "reason": "vocals_stem_empty_piano_vocal_fallback",
            }
        else:
            raw_notes = list(vocal_refined_notes)
            # In Lead Melody mode, keep refined_notes strictly isolated to the vocal melody
            # (never merge bass/other accompaniment notes into the melody note list!).
            if lead_melody_active or norm_mode == "vocal_melody":
                refined_notes = list(vocal_refined_notes)
            else:
                refined_notes = sorted(
                    [*vocal_refined_notes, *bass_refined_notes, *other_refined_notes],
                    key=lambda n: (n.onset_sec, n.pitch_midi),
                )
            refiner_stats = {
                "raw_count": len(vocal_refined_notes),
                "filtered_short_or_low_conf": 0,
                "reattack_merges": vocal_tracking.get("micro_gap_bridges", 0),
                "octave_ghosts_suppressed": vocal_tracking.get("octave_spikes_suppressed", 0),
                "fifth_harmonics_suppressed": 0,
                "refined_count": len(vocal_refined_notes),
            }
            source_selection = {
                "selected": "separated_vocals",
                "vocal_stem_used": str(raw_vocals_stem),
                "content_type": content_type,
                "reason": "isolated_vocals_f0_tracking",
            }

    elif explicit_solo and (norm_mode == "vocal_melody" or (settings.instrument or "").strip().lower() == "vocals"):
        exec_res, vocal_refined_notes, vocal_tracking = _run_monophonic_vocal_tracker(processed_wav, "original_solo_vocal")
        if not vocal_refined_notes:
            raise TranscriptionInferenceError(
                "NO_VOCAL_MELODY_DETECTED",
                "No singable vocal melody was detected in the solo vocal recording.",
            )
        vocal_from_monophonic_tracker = True
        raw_notes = list(vocal_refined_notes)
        refined_notes = list(vocal_refined_notes)
        refiner_stats = {
            "raw_count": len(raw_notes),
            "filtered_short_or_low_conf": 0,
            "reattack_merges": vocal_tracking.get("micro_gap_bridges", 0),
            "octave_ghosts_suppressed": vocal_tracking.get("octave_spikes_suppressed", 0),
            "fifth_harmonics_suppressed": 0,
            "refined_count": len(refined_notes),
        }
        source_selection = {
            "selected": "original",
            "content_type": content_type,
            "reason": "explicit_solo_vocal_f0_tracking",
        }

    elif is_piano_target and sep_res is not None and sep_res.available and not (
        content_type == "solo_piano" and (settings.audio_source_type or "auto").strip().lower() != "full_song"
    ):
        # Build vocal-free, drum-free separated piano candidate (prefer 6-stem piano, else other [+ bass])
        candidate_stems: list[Path] = []
        candidate_weights: list[float] = []
        stem_label = "none"
        if "piano" in sep_res.stems:
            candidate_stems.append(sep_res.stems["piano"])
            candidate_weights.append(1.0)
            stem_label = "piano"
        elif "other" in sep_res.stems:
            candidate_stems.append(sep_res.stems["other"])
            candidate_weights.append(1.0)
            stem_label = "other"

        if "bass" in sep_res.stems and _wav_rms(sep_res.stems["bass"]) >= 0.008:
            candidate_stems.append(sep_res.stems["bass"])
            candidate_weights.append(0.80)
            stem_label = f"{stem_label}+bass" if stem_label != "none" else "bass"

        # Transcribe original processed WAV as baseline/fallback
        orig_exec = _run_transcribe(processed_wav, settings.min_midi_pitch, settings.max_midi_pitch, program)
        orig_raw = orig_exec.output.notes
        orig_ref = refine_detected_notes(orig_raw, config=cfg) if orig_raw else None
        orig_refined = (orig_ref.notes or orig_raw) if orig_ref else []
        orig_quality = score_transcription_quality(
            orig_refined,
            None if settings.key_signature == "auto" else settings.key_signature,
        )

        sep_exec: ProviderExecutionResult | None = None
        sep_raw: list[DetectedNote] = []
        sep_ref = None
        sep_refined: list[DetectedNote] = []
        sep_quality: dict[str, Any] = {"composite_score": 0.0, "note_count": 0}

        if candidate_stems:
            sep_piano_raw_wav = tmp_path / "stems_piano_target_raw.wav"
            sep_piano_wav = tmp_path / "stems_piano_target_proc.wav"
            mixed_path = mix_wav_stems(candidate_stems, sep_piano_raw_wav, target_sr=target_sr, weights=candidate_weights)
            if mixed_path is not None:
                preprocess_to_wav(mixed_path, sep_piano_wav, target_sr=target_sr, profile=prep_profile_name)
                sep_exec = _run_transcribe(sep_piano_wav, settings.min_midi_pitch, settings.max_midi_pitch, program)
                sep_raw = sep_exec.output.notes
                if sep_raw:
                    sep_ref = refine_detected_notes(sep_raw, config=cfg)
                    sep_refined = sep_ref.notes or sep_raw
                    sep_quality = score_transcription_quality(
                        sep_refined,
                        None if settings.key_signature == "auto" else settings.key_signature,
                    )
                    other_refined_notes = list(sep_refined)

        sep_has_enough_notes = len(sep_refined) >= max(4, int(round(0.35 * max(1, len(orig_refined)))))
        use_separated = bool(
            sep_exec is not None
            and sep_refined
            and (
                not orig_refined
                or (sep_has_enough_notes and sep_quality["composite_score"] >= orig_quality["composite_score"] - 0.02)
            )
        )

        if use_separated and sep_exec is not None and sep_ref is not None:
            exec_res = sep_exec
            raw_notes = sep_raw
            refined_notes = sep_refined
            refiner_stats = sep_ref.stats
            source_selection = {
                "selected": "separated",
                "separated_stem_used": stem_label,
                "content_type": content_type,
                "reason": "separated_stem_outscored_or_matched_original",
                "original_score": orig_quality,
                "separated_score": sep_quality,
            }
        else:
            exec_res = orig_exec
            raw_notes = orig_raw
            refined_notes = orig_refined
            refiner_stats = orig_ref.stats if orig_ref else {"raw_count": 0, "refined_count": 0}
            source_selection = {
                "selected": "original",
                "separated_stem_used": stem_label,
                "content_type": content_type,
                "reason": "original_preserved_higher_quality_or_completeness",
                "original_score": orig_quality,
                "separated_score": sep_quality,
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
        source_selection = {
            "selected": "original",
            "content_type": content_type,
            "reason": (
                "clean_solo_piano_detected"
                if (sep_res is not None and sep_res.available and content_type == "solo_piano")
                else "direct_transcription"
            ),
        }

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
        source_selection=source_selection,
        vocal_tracking=vocal_tracking,
        vocal_from_monophonic_tracker=vocal_from_monophonic_tracker,
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
    """Run Beat This!/TimingMap alignment, key estimation, arrangement & playability processing, and ScoreData assembly."""
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
            time_sig, time_est, meter_diag = infer_time_signature_from_beats(
                beat_res,
                settings.time_signature,
                notes=refined_notes,
            )
            timing_map = build_timing_map(
                beat_result=beat_res,
                notes=refined_notes,
                duration_seconds=proc_meta.duration_seconds,
                time_signature=time_sig,
                meter_diag=meter_diag,
            )
            tempo_bpm = timing_map.tempo_bpm
            tempo_est = True
            tempo_diag = {**timing_map.provenance, "meter_detection": meter_diag}
        except Exception as exc:
            logger.warning("Beat/TimingMap analysis failed (%s); falling back to Librosa tempo estimation.", exc)
            tempo_diag = estimate_tempo_with_diagnostics(
                processed_wav, settings.tempo_mode, settings.manual_tempo_bpm, notes=refined_notes
            )
            tempo_bpm = float(tempo_diag["tempo_bpm"])
            tempo_est = bool(tempo_diag["tempo_estimated"])
            tempo_diag["fallback_used"] = True
            tempo_diag["fallback_reason"] = str(exc)

    accomp_notes_for_ctx = [*core_res.other_refined_notes, *core_res.bass_refined_notes] or None
    key_sig, key_est = estimate_key_signature(
        refined_notes,
        settings.key_signature,
        audio_path=processed_wav,
        accompaniment_notes=accomp_notes_for_ctx,
    )

    norm_mode = normalize_transcription_mode(settings.mode)
    lead_melody_active = is_lead_melody_mode(settings.mode)
    piano_vocal_active = norm_mode == "piano_vocal"
    melody_source_notes = core_res.vocal_refined_notes if core_res.vocal_refined_notes else refined_notes
    melody_result = None
    playability_stats: dict[str, Any] | None = None
    eff_smoothing = normalize_playability_smoothing(getattr(settings, "playability_smoothing", "standard"))

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
            accompaniment_notes=accomp_notes_for_ctx,
            from_monophonic_vocal_tracker=core_res.vocal_from_monophonic_tracker,
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

        if "piano" in (settings.instrument or "").lower() and eff_smoothing != "original":
            chord_proxies = [
                ScoreNote(
                    id=f"cp_{idx}",
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
                tempo_bpm,
                time_sig,
                key_signature=key_sig,
                timing_map=timing_map,
            )
            play_res = apply_piano_playability(
                arranged_notes,
                chords=prelim_chords,
                tempo_bpm=tempo_bpm,
                time_signature=time_sig,
                key_signature=key_sig,
                mode=norm_mode,
                instrument=settings.instrument,
                smoothing=eff_smoothing,
            )
            if play_res.notes:
                arranged_notes = play_res.notes
            playability_stats = play_res.stats

    raw_detected_snapshot = [
        {
            "pitch_midi": int(n.pitch_midi),
            "onset_sec": round(float(n.onset_sec), 4),
            "offset_sec": round(float(n.offset_sec), 4),
            "velocity": int(n.velocity),
            "confidence": float(n.confidence) if n.confidence is not None else None,
        }
        for n in (
            core_res.vocal_refined_notes
            if (core_res.is_vocal_melody_route and core_res.vocal_refined_notes)
            else (refined_notes if core_res.is_vocal_melody_route else core_res.raw_notes)
        )
    ]

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
        "playability_smoothing": eff_smoothing,
        "playability": playability_stats,
        "quantization": settings.quantization,
        "raw_detected_notes": raw_detected_snapshot,
        "tempo_diagnostics": tempo_diag,
        "is_silent_audio": proc_meta.is_silent,
        "mode": norm_mode,
        "audio_source_type": settings.audio_source_type,
        "source_route": source_route or detect_audio_source_route(processed_wav, None, requested_source_type=settings.audio_source_type, mode=settings.mode),
        "source_selection": core_res.source_selection,
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
    if core_res.vocal_tracking:
        score_analysis["vocal_tracking"] = core_res.vocal_tracking
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
