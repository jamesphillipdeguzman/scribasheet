import uuid
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


def _tempogram_energy_at_bpm(tempogram: np.ndarray, freqs: np.ndarray, bpm: float) -> float:
    if len(freqs) == 0 or tempogram.size == 0:
        return 0.0
    mean_profile = np.mean(tempogram, axis=1)
    mask = (freqs >= bpm * 0.94) & (freqs <= bpm * 1.06)
    if not np.any(mask):
        idx = int(np.argmin(np.abs(freqs - bpm)))
        return float(mean_profile[idx])
    return float(np.max(mean_profile[mask]))


def _resolve_tempo_octave(
    bpm_raw: float,
    onset_env: np.ndarray,
    sr: int,
    notes: list[DetectedNote] | None = None,
) -> float:
    """Resolve 2x / 0.5x double-time / half-time tempo ambiguity using tempogram + accent periodicity."""
    if bpm_raw <= 0:
        return 120.0

    tempogram = librosa.feature.tempogram(onset_envelope=onset_env, sr=sr)
    freqs = librosa.tempo_frequencies(tempogram.shape[0], sr=sr)
    # Exclude inf/0
    valid = np.isfinite(freqs) & (freqs >= 35.0) & (freqs <= 240.0)
    if not np.any(valid):
        return bpm_raw

    e_raw = _tempogram_energy_at_bpm(tempogram, freqs, bpm_raw)
    half_bpm = bpm_raw / 2.0
    double_bpm = bpm_raw * 2.0

    best_bpm = bpm_raw

    # Check if bpm_raw is double-time of a stronger or strongly-accented half-time pulse
    if half_bpm >= 45.0:
        e_half = _tempogram_energy_at_bpm(tempogram, freqs, half_bpm)
        # Re-track beats around half_bpm to inspect beat-level accent alternation
        _, beat_frames_raw = librosa.beat.beat_track(
            onset_envelope=onset_env, sr=sr, start_bpm=bpm_raw, tightness=100
        )
        accent_alternation = 0.0
        if len(beat_frames_raw) >= 4:
            beat_strengths = onset_env[np.clip(beat_frames_raw, 0, len(onset_env) - 1)]
            even_mean = float(np.mean(beat_strengths[0::2]))
            odd_mean = float(np.mean(beat_strengths[1::2]))
            hi, lo = max(even_mean, odd_mean), min(even_mean, odd_mean)
            if hi > 1e-6:
                accent_alternation = (hi - lo) / hi

        # Check note IOI / duration evidence if notes are available
        note_prefers_half = False
        if notes and len(notes) >= 4:
            durs = [max(0.05, n.offset_sec - n.onset_sec) for n in notes]
            median_dur = float(np.median(durs))
            # If median note duration is closer to a beat at half_bpm than at bpm_raw
            if median_dur >= (60.0 / bpm_raw) * 0.85 and bpm_raw >= 120.0:
                note_prefers_half = True

        if (e_half >= e_raw * 0.85 and bpm_raw >= 118.0) or (
            e_half >= e_raw * 0.55 and (accent_alternation >= 0.12 or note_prefers_half) and bpm_raw >= 115.0
        ):
            refined_bpm, _ = librosa.beat.beat_track(
                onset_envelope=onset_env, sr=sr, start_bpm=half_bpm, tightness=120
            )
            if isinstance(refined_bpm, np.ndarray):
                refined_bpm = float(refined_bpm[0]) if len(refined_bpm) > 0 else half_bpm
            best_bpm = float(refined_bpm) if 45.0 <= float(refined_bpm) <= 220.0 else half_bpm

    # Check if bpm_raw is half-time of a clear fast pulse
    elif double_bpm <= 200.0 and bpm_raw < 62.0:
        e_double = _tempogram_energy_at_bpm(tempogram, freqs, double_bpm)
        if e_double > e_raw * 1.15:
            best_bpm = double_bpm

    return best_bpm


def estimate_tempo(
    wav_path: Path,
    tempo_mode: str = "auto",
    manual_tempo_bpm: float | None = None,
    notes: list[DetectedNote] | None = None,
) -> tuple[float, bool]:
    if tempo_mode == "manual" and manual_tempo_bpm is not None:
        return round(float(manual_tempo_bpm), 1), False

    try:
        y, sr = librosa.load(str(wav_path), sr=22050, mono=True, duration=120.0)
        onset_env = librosa.onset.onset_strength(y=y, sr=sr)
        tempo, _ = librosa.beat.beat_track(onset_envelope=onset_env, sr=sr)
        if isinstance(tempo, np.ndarray):
            tempo = float(tempo[0]) if len(tempo) > 0 else 120.0
        bpm = _resolve_tempo_octave(float(tempo), onset_env, sr, notes=notes)
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


def quantize_seconds(
    value_sec: float,
    tempo_bpm: float,
    quantization: str,
    strength: float = 1.0,
) -> float:
    if quantization == "none" or strength <= 0.0:
        return round(value_sec, 4)
    grid_map = {
        "quarter": 1.0,
        "dotted_eighth": 0.75,
        "eighth": 0.5,
        "eighth_triplet": 1.0 / 3.0,
        "triplet": 1.0 / 3.0,
        "sixteenth": 0.25,
        "sixteenth_triplet": 1.0 / 6.0,
        "thirtysecond": 0.125,
    }
    step_beats = grid_map.get(quantization, 0.25)
    sec_per_beat = 60.0 / max(20.0, tempo_bpm)
    step_sec = step_beats * sec_per_beat
    snapped = round(value_sec / step_sec) * step_sec
    alpha = max(0.0, min(1.0, float(strength)))
    blended = value_sec + alpha * (snapped - value_sec)
    return round(max(0.0, blended), 4)


def assign_guitar_tab(pitch_midi: int) -> tuple[int | None, int | None]:
    for string_idx, open_pitch in enumerate(STANDARD_GUITAR_TUNING, start=1):
        fret = pitch_midi - open_pitch
        if 0 <= fret <= 20:
            return string_idx, fret
    return None, None


_PC_NAMES_FLAT = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"]
_CHORD_TEMPLATES: list[tuple[str, str, tuple[int, ...]]] = [
    ("", "major", (0, 4, 7)),
    ("m", "minor", (0, 3, 7)),
    ("7", "dominant-seventh", (0, 4, 7, 10)),
    ("maj7", "major-seventh", (0, 4, 7, 11)),
    ("m7", "minor-seventh", (0, 3, 7, 10)),
    ("dim", "diminished", (0, 3, 6)),
    ("aug", "augmented", (0, 4, 8)),
    ("sus4", "suspended-fourth", (0, 5, 7)),
    ("sus2", "suspended-second", (0, 2, 7)),
]


def detect_chords(notes: list[ScoreNote], tempo_bpm: float, time_signature: str) -> list[ScoreChord]:
    if not notes:
        return []
    try:
        num = max(1, int(time_signature.split("/")[0]))
    except Exception:
        num = 4
    sec_per_beat = 60.0 / max(20.0, tempo_bpm)
    window_beats = 2.0 if num >= 4 else float(num)
    window_sec = sec_per_beat * window_beats

    max_offset = max(n.offset_sec for n in notes)
    num_windows = max(1, int(np.ceil(max_offset / window_sec)))

    chords: list[ScoreChord] = []
    last_symbol: str | None = None

    for w_idx in range(num_windows):
        w_start = w_idx * window_sec
        w_end = (w_idx + 1) * window_sec

        overlapping: list[tuple[ScoreNote, float]] = []
        for n in notes:
            overlap = min(n.offset_sec, w_end) - max(n.onset_sec, w_start)
            if overlap > 0.02:
                overlapping.append((n, overlap))
        if not overlapping:
            continue

        # Filter out ultra-short transients if substantive notes are present
        substantive = [(n, ov) for n, ov in overlapping if (n.offset_sec - n.onset_sec) >= 0.08]
        active = substantive if substantive else overlapping

        pc_weights = np.zeros(12, dtype=np.float64)
        lowest_pitch = 128
        lowest_pc = 0
        for n, ov in active:
            w = ov * (max(1, n.velocity) / 127.0)
            pc = n.pitch_midi % 12
            pc_weights[pc] += w
            if n.pitch_midi < lowest_pitch:
                lowest_pitch = n.pitch_midi
                lowest_pc = pc

        total_weight = float(np.sum(pc_weights))
        if total_weight <= 1e-6:
            continue

        significant_pcs = [i for i in range(12) if pc_weights[i] >= 0.15 * float(np.max(pc_weights))]
        if len(significant_pcs) < 2:
            continue

        best_score = -1e9
        best_match: tuple[int, str, str, float] | None = None
        for root_pc in range(12):
            for suffix, quality, intervals in _CHORD_TEMPLATES:
                chord_pcs = {(root_pc + iv) % 12 for iv in intervals}
                matched_w = sum(pc_weights[pc] for pc in chord_pcs)
                unmatched_w = total_weight - matched_w
                present_tones = sum(1 for pc in chord_pcs if pc_weights[pc] > 0.15 * float(np.max(pc_weights)))
                missing_ratio = 1.0 - (present_tones / len(chord_pcs))
                bass_bonus = 0.10 if root_pc == lowest_pc else 0.0
                triad_bonus = 0.03 if len(intervals) == 3 else 0.0
                score = (matched_w - 0.6 * unmatched_w) / total_weight - 0.18 * missing_ratio + bass_bonus + triad_bonus
                if score > best_score:
                    best_score = score
                    best_match = (root_pc, suffix, quality, score)

        if best_match is None or best_match[3] < 0.52:
            continue

        root_pc, suffix, quality, conf = best_match
        root_name = _PC_NAMES_FLAT[root_pc]
        symbol = f"{root_name}{suffix}"
        if symbol == last_symbol:
            continue
        last_symbol = symbol

        w_start_beats = w_idx * window_beats
        measure = int(w_start_beats // num) + 1
        beat = round((w_start_beats % num) + 1.0, 2)
        chords.append(
            ScoreChord(
                id=uuid.uuid4().hex[:10],
                measure=max(1, measure),
                beat=max(1.0, beat),
                onset_sec=round(w_start, 3),
                symbol=symbol,
                root=root_name,
                quality=quality,
                confidence=round(float(max(0.0, min(1.0, conf))), 3),
            )
        )
    return chords
