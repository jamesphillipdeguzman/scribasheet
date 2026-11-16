import uuid
from collections import defaultdict
from pathlib import Path

import librosa
import music21
import numpy as np

from app.schemas.score import ScoreChord, ScoreNote
from app.transcription.base import DetectedNote

STANDARD_GUITAR_TUNING = [64, 59, 55, 50, 45, 40]  # String 1 (E4) to String 6 (E2)

INSTRUMENT_PROGRAMS: dict[str, tuple[int, str]] = {
    "piano": (0, "grand"),
    "acoustic_guitar": (24, "treble"),
    "electric_guitar": (27, "treble"),
    "bass_guitar": (33, "bass"),
    "violin": (40, "treble"),
    "viola": (41, "treble"),
    "cello": (42, "bass"),
    "double_bass": (43, "bass"),
    "flute": (73, "treble"),
    "clarinet": (71, "treble"),
    "saxophone": (65, "treble"),
    "trumpet": (56, "treble"),
    "trombone": (57, "bass"),
    "drums": (0, "treble"),
    "vocals": (52, "treble"),
    "other": (0, "treble"),
}


def get_instrument_program_and_clef(instrument: str) -> tuple[int, str]:
    return INSTRUMENT_PROGRAMS.get(instrument.lower(), (0, "treble"))


def estimate_tempo(wav_path: Path, tempo_mode: str = "auto", manual_tempo_bpm: float | None = None) -> tuple[float, bool]:
    if tempo_mode == "manual" and manual_tempo_bpm is not None:
        return round(float(manual_tempo_bpm), 1), False

    try:
        y, sr = librosa.load(str(wav_path), sr=22050, mono=True, duration=120.0)
        tempo, _ = librosa.beat.beat_track(y=y, sr=sr)
        if isinstance(tempo, np.ndarray):
            tempo = float(tempo[0]) if len(tempo) > 0 else 120.0
        bpm = float(tempo)
        if 40.0 <= bpm <= 240.0:
            return round(bpm, 1), True
    except Exception:
        pass
    return 120.0, True


def estimate_key_signature(notes: list[DetectedNote], key_setting: str = "auto") -> tuple[str, bool]:
    if key_setting != "auto":
        return key_setting, False
    if len(notes) < 3:
        return "C", True

    try:
        s = music21.stream.Stream()
        for n in notes[:400]:
            m_note = music21.note.Note(n.pitch_midi)
            m_note.quarterLength = max(0.25, (n.offset_sec - n.onset_sec) * 2.0)
            s.append(m_note)
        key = s.analyze("key")
        tonic = key.tonic.name.replace("-", "b")
        mode_suffix = "m" if key.mode == "minor" else ""
        return f"{tonic}{mode_suffix}", True
    except Exception:
        return "C", True


def quantize_seconds(value_sec: float, tempo_bpm: float, quantization: str) -> float:
    if quantization == "none":
        return round(value_sec, 4)
    grid_map = {
        "eighth": 0.5,
        "sixteenth": 0.25,
        "thirtysecond": 0.125,
    }
    step_beats = grid_map.get(quantization, 0.25)
    sec_per_beat = 60.0 / max(20.0, tempo_bpm)
    step_sec = step_beats * sec_per_beat
    return round(round(value_sec / step_sec) * step_sec, 4)


def assign_guitar_tab(pitch_midi: int) -> tuple[int | None, int | None]:
    for string_idx, open_pitch in enumerate(STANDARD_GUITAR_TUNING, start=1):
        fret = pitch_midi - open_pitch
        if 0 <= fret <= 20:
            return string_idx, fret
    return None, None


def detect_chords(notes: list[ScoreNote], tempo_bpm: float, time_signature: str) -> list[ScoreChord]:
    if not notes:
        return []
    try:
        num = int(time_signature.split("/")[0])
    except Exception:
        num = 4
    sec_per_beat = 60.0 / max(20.0, tempo_bpm)
    sec_per_measure = sec_per_beat * num

    # Group notes by half-measure windows
    windows: dict[int, list[ScoreNote]] = defaultdict(list)
    window_sec = sec_per_beat * 2.0
    for n in notes:
        w_idx = int(n.onset_sec / window_sec)
        windows[w_idx].append(n)

    chords: list[ScoreChord] = []
    last_symbol = None
    for w_idx in sorted(windows.keys()):
        group = windows[w_idx]
        unique_pitches = sorted({n.pitch_midi % 12 for n in group})
        if len(unique_pitches) < 2:
            continue
        try:
            midi_pitches = sorted({n.pitch_midi for n in group})[:5]
            c = music21.chord.Chord(midi_pitches)
            root_name = c.root().name.replace("-", "b")
            quality = c.quality or "major"
            suffix = ""
            if quality == "minor":
                suffix = "m"
            elif quality == "diminished":
                suffix = "dim"
            elif quality == "augmented":
                suffix = "aug"
            elif c.isDominantSeventh():
                suffix = "7"
            symbol = f"{root_name}{suffix}"
            if symbol == last_symbol:
                continue
            last_symbol = symbol
            onset_sec = w_idx * window_sec
            measure = int(onset_sec / sec_per_measure) + 1
            beat = round(((onset_sec % sec_per_measure) / sec_per_beat) + 1.0, 2)
            chords.append(
                ScoreChord(
                    id=uuid.uuid4().hex[:10],
                    measure=max(1, measure),
                    beat=max(1.0, beat),
                    onset_sec=round(onset_sec, 3),
                    symbol=symbol,
                    root=root_name,
                    quality=quality,
                    confidence=None,
                )
            )
        except Exception:
            continue
    return chords
