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
    tempo_bpm: float | None = None,
    start_measure: int | None = None,
    end_measure: int | None = None,
    output_format: str = "mp3",
    sample_rate: int = DEFAULT_SAMPLE_RATE,
) -> dict[str, bytes]:
    """Render synchronized individual S/A/T/B tracks and combined SATB mix."""
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
    track_names = {t.index: (t.name or f"Part {t.index + 1}").strip() for t in tracks}
    track_notes: dict[str, list[tuple[int, float, float, int]]] = {}

    for t in tracks:
        t_name = track_names[t.index]
        track_notes.setdefault(t_name, [])

    for n in score.notes:
        t_name = track_names.get(n.track_index, "Soprano")
        s = n.onset_sec * time_scale
        e = n.offset_sec * time_scale
        if e <= win_start or s >= win_end:
            continue
        rel_s = max(0.0, s - win_start)
        rel_e = min(total_dur, e - win_start)
        if rel_e > rel_s + 0.02:
            track_notes.setdefault(t_name, []).append((n.pitch_midi, rel_s, rel_e, n.velocity))

    waveforms: dict[str, np.ndarray] = {}
    outputs: dict[str, bytes] = {}
    combined = np.zeros(max(1, int(np.ceil(total_dur * sample_rate))), dtype=np.float32)

    for t_name, evs in track_notes.items():
        key = t_name.lower()
        vol = vols.get(key, 1.0)
        prog = insts.get(key, 52)  # 52 = Choir Aahs, 0 = Acoustic Grand Piano fallback
        wf = _render_notes_to_waveform(
            evs,
            total_duration_sec=total_dur,
            sample_rate=sample_rate,
            program=prog,
        ) * float(vol)
        waveforms[key] = wf
        outputs[key] = _waveform_to_bytes(wf, sample_rate, output_format)
        combined += wf

    # Mix all 4 parts simultaneously with gentle scaling to avoid clipping
    if waveforms:
        combined = combined / max(1.0, len(waveforms) ** 0.5)
    outputs["combined"] = _waveform_to_bytes(combined, sample_rate, output_format)
    return outputs
