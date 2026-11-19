"""Synchronized SATB individual and combined MP3/WAV audio rendering."""

from __future__ import annotations

import io
import shutil
import subprocess
import tempfile
from pathlib import Path

import numpy as np
import pretty_midi
import soundfile as sf

from app.schemas.score import ScoreData

DEFAULT_SAMPLE_RATE = 22050
VALID_SATB_VOICES = ("soprano", "alto", "tenor", "bass")


def _normalize_voice_label(label: str | None) -> str | None:
    cleaned = (label or "").strip().lower()
    if cleaned in VALID_SATB_VOICES:
        return cleaned
    if cleaned in ("", "unassigned", "none"):
        return None
    return None


def infer_satb_voice_assignments(
    score: ScoreData,
    override_assignments: dict[int | str, str] | None = None,
) -> dict[int, str | None]:
    """Infer or resolve track_index -> SATB voice ('soprano'|'alto'|'tenor'|'bass'|None).

    Never treats piano accompaniment or instrumental tracks as vocal SATB parts,
    and never guesses Soprano for every part when ambiguous.
    """
    tracks = score.tracks or []
    result: dict[int, str | None] = {}
    used_voices: set[str] = set()

    overrides_by_idx: dict[int, str | None] = {}
    has_override: set[int] = set()
    if override_assignments:
        for k, v in override_assignments.items():
            try:
                idx = int(k)
            except (TypeError, ValueError):
                continue
            has_override.add(idx)
            overrides_by_idx[idx] = _normalize_voice_label(v)

    satb_meta = (score.analysis or {}).get("satb") if isinstance(score.analysis, dict) else None
    meta_by_idx: dict[int, str | None] = {}
    if isinstance(satb_meta, dict) and isinstance(satb_meta.get("assignments"), list):
        for item in satb_meta["assignments"]:
            if isinstance(item, dict) and "part_index" in item:
                try:
                    meta_by_idx[int(item["part_index"])] = _normalize_voice_label(str(item.get("assigned_voice") or ""))
                except (TypeError, ValueError):
                    pass

    # Pass 1: explicit overrides, exact SATB track names, or metadata assignments
    for t in tracks:
        if t.index in has_override:
            v = overrides_by_idx[t.index]
            result[t.index] = v
            if v:
                used_voices.add(v)
            continue

        exact = _normalize_voice_label(t.name)
        if exact:
            result[t.index] = exact
            used_voices.add(exact)
            continue

        if t.index in meta_by_idx and meta_by_idx[t.index]:
            result[t.index] = meta_by_idx[t.index]
            used_voices.add(meta_by_idx[t.index])  # type: ignore[arg-type]

    # Pass 2: conservative semantic inference for remaining unassigned tracks
    is_genuine_satb = bool(
        isinstance(score.analysis, dict)
        and (score.analysis.get("mode") == "satb_pdf" or score.analysis.get("satb"))
    )

    for t in tracks:
        if t.index in result:
            continue
        label_lower = f"{t.name or ''} {t.instrument or ''}".lower()

        # Never treat piano accompaniment / instrumental parts as vocal SATB parts
        if any(tok in label_lower for tok in ("accompaniment", "piano", "keyboard", "guitar", "drums")):
            result[t.index] = None
            continue

        # Vocal Melody / Lead Melody -> Soprano if still free
        if "vocal" in label_lower or "melody" in label_lower:
            if "soprano" not in used_voices:
                result[t.index] = "soprano"
                used_voices.add("soprano")
            else:
                result[t.index] = None
            continue

        inferred: str | None = None
        if "soprano" in label_lower or "sop" in label_lower:
            inferred = "soprano"
        elif "alto" in label_lower:
            inferred = "alto"
        elif "tenor" in label_lower:
            inferred = "tenor"
        elif "bass" in label_lower:
            inferred = "bass"
        elif is_genuine_satb and len(tracks) == 4:
            # Genuine 4-part SATB fallback by standard score order + clef
            fallback_order = ("soprano", "alto", "tenor", "bass")
            cand = fallback_order[t.index] if 0 <= t.index < 4 else None
            if cand and cand not in used_voices:
                inferred = cand

        result[t.index] = inferred
        if inferred:
            used_voices.add(inferred)

    return result


def _encode_wav_to_mp3(wav_bytes: bytes) -> bytes:
    """Encode WAV bytes to MP3 using ffmpeg (falling back to WAV only if ffmpeg missing)."""
    ffmpeg_bin = shutil.which("ffmpeg")
    if not ffmpeg_bin:
        raise RuntimeError("ffmpeg is required to export MP3 audio.")
    with tempfile.TemporaryDirectory(prefix="scriba_mp3_") as tmpdir:
        tmp = Path(tmpdir)
        wav_path = tmp / "input.wav"
        mp3_path = tmp / "output.mp3"
        wav_path.write_bytes(wav_bytes)
        res = subprocess.run(
            [ffmpeg_bin, "-y", "-i", str(wav_path), "-codec:a", "libmp3lame", "-qscale:a", "3", str(mp3_path)],
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )
        if res.returncode != 0 or not mp3_path.exists():
            raise RuntimeError(f"ffmpeg MP3 encoding failed: {res.stderr.strip()[-300:]}")
        return mp3_path.read_bytes()


def _render_notes_to_waveform(
    notes_list: list[tuple[int, float, float, int]],
    *,
    total_duration_sec: float,
    sample_rate: int,
    program: int = 52,
) -> np.ndarray:
    """Render synchronized MIDI note events into a fixed-length float32 waveform."""
    n_samples = max(1, int(np.ceil(total_duration_sec * sample_rate)))
    if not notes_list:
        return np.zeros(n_samples, dtype=np.float32)

    pm = pretty_midi.PrettyMIDI(initial_tempo=120.0)
    # Use requested GM program (e.g. 52 Choir Aahs, 0 Piano); pretty_midi harmonic synth handles all programs
    inst = pretty_midi.Instrument(program=max(0, min(127, program)))
    for pitch, start, end, vel in notes_list:
        inst.notes.append(
            pretty_midi.Note(
                velocity=max(1, min(127, vel)),
                pitch=max(0, min(127, pitch)),
                start=max(0.0, start),
                end=max(start + 0.04, end),
            )
        )
    pm.instruments.append(inst)
    audio = pm.synthesize(fs=sample_rate).astype(np.float32)

    # Pad or trim so all 4 parts share exact synchronized length
    out = np.zeros(n_samples, dtype=np.float32)
    copy_len = min(n_samples, len(audio))
    out[:copy_len] = audio[:copy_len]
    return out


def _waveform_to_bytes(waveform: np.ndarray, sample_rate: int, output_format: str) -> bytes:
    peak = float(np.max(np.abs(waveform))) if waveform.size else 0.0
    if peak > 0.92:
        waveform = (waveform / peak) * 0.90
    buf = io.BytesIO()
    sf.write(buf, waveform, sample_rate, format="WAV", subtype="PCM_16")
    wav_bytes = buf.getvalue()
    if output_format.lower() == "mp3":
        return _encode_wav_to_mp3(wav_bytes)
    return wav_bytes


def render_satb_audio_tracks(
    score: ScoreData,
    *,
    part_volumes: dict[str, float] | None = None,
    part_instruments: dict[str, int] | None = None,
    voice_assignments: dict[int | str, str] | None = None,
    tempo_bpm: float | None = None,
    start_measure: int | None = None,
    end_measure: int | None = None,
    output_format: str = "mp3",
    sample_rate: int = DEFAULT_SAMPLE_RATE,
) -> dict[str, bytes]:
    """Render synchronized individual assigned S/A/T/B tracks and combined mix."""
    vols = {k.lower(): max(0.0, min(2.0, float(v))) for k, v in (part_volumes or {}).items()}
    insts = {k.lower(): int(v) for k, v in (part_instruments or {}).items()}

    base_bpm = max(20.0, float(score.tempo_bpm or 100.0))
    target_bpm = max(20.0, float(tempo_bpm or base_bpm))
    time_scale = base_bpm / target_bpm

    try:
        beats_per_measure = max(1, int((score.time_signature or "4/4").split("/")[0]))
    except Exception:
        beats_per_measure = 4
    sec_per_measure_scaled = (60.0 / target_bpm) * beats_per_measure

    win_start = ((start_measure - 1) * sec_per_measure_scaled) if start_measure and start_measure >= 1 else 0.0
    win_end = (
        (end_measure * sec_per_measure_scaled)
        if end_measure and end_measure >= (start_measure or 1)
        else max(0.5, float(score.duration_seconds) * time_scale)
    )
    total_dur = max(0.5, win_end - win_start)

    tracks = score.tracks or []
    resolved_voices = infer_satb_voice_assignments(score, override_assignments=voice_assignments)
    track_meta = {t.index: t for t in tracks}

    voice_notes: dict[str, list[tuple[int, float, float, int]]] = {}
    for t in tracks:
        v = resolved_voices.get(t.index)
        if v in VALID_SATB_VOICES:
            voice_notes.setdefault(v, [])

    unassigned_notes: list[tuple[int, float, float, int]] = []

    for n in score.notes:
        s = n.onset_sec * time_scale
        e = n.offset_sec * time_scale
        if e <= win_start or s >= win_end:
            continue
        rel_s = max(0.0, s - win_start)
        rel_e = min(total_dur, e - win_start)
        if rel_e <= rel_s + 0.02:
            continue
        ev = (n.pitch_midi, rel_s, rel_e, n.velocity)
        v = resolved_voices.get(n.track_index)
        if v in VALID_SATB_VOICES:
            voice_notes.setdefault(v, []).append(ev)
        else:
            unassigned_notes.append(ev)

    waveforms: dict[str, np.ndarray] = {}
    outputs: dict[str, bytes] = {}
    combined = np.zeros(max(1, int(np.ceil(total_dur * sample_rate))), dtype=np.float32)

    for voice_key, evs in voice_notes.items():
        vol = vols.get(voice_key, 1.0)
        prog = insts.get(voice_key, 52)  # 52 = Choir Aahs, 0 = Acoustic Grand Piano fallback
        wf = _render_notes_to_waveform(
            evs,
            total_duration_sec=total_dur,
            sample_rate=sample_rate,
            program=prog,
        ) * float(vol)
        waveforms[voice_key] = wf
        outputs[voice_key] = _waveform_to_bytes(wf, sample_rate, output_format)
        combined += wf

    if unassigned_notes:
        # Include unassigned accompaniment tracks in the combined mix (using track program, e.g. 0 Piano)
        unassigned_prog = next(
            (track_meta[t.index].program for t in tracks if resolved_voices.get(t.index) is None),
            0,
        )
        wf_extra = _render_notes_to_waveform(
            unassigned_notes,
            total_duration_sec=total_dur,
            sample_rate=sample_rate,
            program=unassigned_prog,
        )
        waveforms["_unassigned"] = wf_extra
        combined += wf_extra

    # Mix all parts simultaneously with gentle scaling to avoid clipping
    if waveforms:
        combined = combined / max(1.0, len(waveforms) ** 0.5)
    outputs["combined"] = _waveform_to_bytes(combined, sample_rate, output_format)
    return outputs
