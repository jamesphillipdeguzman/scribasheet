import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

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


def estimate_tempo_with_diagnostics(
    wav_path: Path,
    tempo_mode: str = "auto",
    manual_tempo_bpm: float | None = None,
    notes: list[DetectedNote] | None = None,
) -> dict[str, object]:
    """Estimate tempo and expose half-time/double-time candidates and ambiguity."""
    if tempo_mode == "manual" and manual_tempo_bpm is not None:
        bpm = round(float(manual_tempo_bpm), 1)
        return {
            "tempo_bpm": bpm,
            "tempo_estimated": False,
            "candidates": [{"bpm": bpm, "relation": "manual", "score": 1.0}],
            "confidence": 1.0,
            "ambiguous": False,
        }

    try:
        y, sr = librosa.load(str(wav_path), sr=22050, mono=True, duration=120.0)
        onset_env = librosa.onset.onset_strength(y=y, sr=sr)
        tempo, _ = librosa.beat.beat_track(onset_envelope=onset_env, sr=sr)
        if isinstance(tempo, np.ndarray):
            tempo = float(tempo[0]) if len(tempo) > 0 else 120.0
        raw_bpm = float(tempo)
        resolved_bpm = _resolve_tempo_octave(raw_bpm, onset_env, sr, notes=notes)

        tempogram = librosa.feature.tempogram(onset_envelope=onset_env, sr=sr)
        freqs = librosa.tempo_frequencies(tempogram.shape[0], sr=sr)
        candidates: list[dict[str, object]] = []
        raw_e = _tempogram_energy_at_bpm(tempogram, freqs, raw_bpm)
        candidates.append({"bpm": round(raw_bpm, 1), "relation": "primary", "energy": round(raw_e, 4)})
        if raw_bpm / 2.0 >= 45.0:
            half_e = _tempogram_energy_at_bpm(tempogram, freqs, raw_bpm / 2.0)
            candidates.append(
                {
                    "bpm": round(resolved_bpm if abs(resolved_bpm - raw_bpm / 2.0) < 12.0 else raw_bpm / 2.0, 1),
                    "relation": "half_time",
                    "energy": round(half_e, 4),
                }
            )
        if raw_bpm * 2.0 <= 220.0:
            dbl_e = _tempogram_energy_at_bpm(tempogram, freqs, raw_bpm * 2.0)
            candidates.append({"bpm": round(raw_bpm * 2.0, 1), "relation": "double_time", "energy": round(dbl_e, 4)})

        max_e = max((float(c["energy"]) for c in candidates), default=1.0) or 1.0
        for c in candidates:
            c["score"] = round(float(c["energy"]) / max_e, 3)
        sorted_c = sorted(candidates, key=lambda c: float(c["score"]), reverse=True)
        top_score = float(sorted_c[0]["score"])
        second_score = float(sorted_c[1]["score"]) if len(sorted_c) > 1 else 0.0
        ambiguous = len(sorted_c) > 1 and (top_score - second_score) <= 0.12

        final_bpm = round(resolved_bpm, 1) if 40.0 <= resolved_bpm <= 240.0 else 120.0
        return {
            "tempo_bpm": final_bpm,
            "tempo_estimated": True,
            "candidates": sorted_c,
            "confidence": round(max(0.0, min(1.0, top_score - 0.5 * second_score + 0.35)), 3),
            "ambiguous": ambiguous,
        }
    except Exception:
        return {
            "tempo_bpm": 120.0,
            "tempo_estimated": True,
            "candidates": [],
            "confidence": 0.0,
            "ambiguous": True,
        }


def estimate_tempo(
    wav_path: Path,
    tempo_mode: str = "auto",
    manual_tempo_bpm: float | None = None,
    notes: list[DetectedNote] | None = None,
) -> tuple[float, bool]:
    diag = estimate_tempo_with_diagnostics(
        wav_path, tempo_mode=tempo_mode, manual_tempo_bpm=manual_tempo_bpm, notes=notes
    )
    return float(diag["tempo_bpm"]), bool(diag["tempo_estimated"])


def estimate_key_signature(notes: list[DetectedNote], key_setting: str = "auto") -> tuple[str, bool]:
    if key_setting != "auto":
        return key_setting, False
    if len(notes) < 3:
        return "C major", True

    try:
        s = music21.stream.Stream()
        for n in notes[:400]:
            m_note = music21.note.Note(n.pitch_midi)
            m_note.quarterLength = max(0.25, (n.offset_sec - n.onset_sec) * 2.0)
            s.append(m_note)
        key = s.analyze("key")
        tonic = key.tonic.name.replace("-", "b")
        mode = "minor" if key.mode == "minor" else "major"
        return f"{tonic} {mode}", True
    except Exception:
        return "C major", True


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


@dataclass
class ChordDetectionConfig:
    """Configurable thresholds for confidence-aware harmonic analysis."""

    min_note_duration_sec: float = 0.08
    min_pc_weight_ratio: float = 0.24
    min_distinct_pcs: int = 3
    min_confidence: float = 0.58
    strong_short_change_confidence: float = 0.90
    min_bass_weight_ratio: float = 0.24
    min_extension_weight_ratio: float = 0.30
    min_label_spacing_beats: float = 1.0
    min_window_total_weight: float = 0.40
    key_diatonic_weight_boost: float = 1.12
    allow_slash_chords: bool = True


def select_chord_source_notes(
    other_notes: list[Any] | None,
    bass_notes: list[Any] | None,
    fallback_notes: list[Any],
) -> list[Any]:
    """Prefer isolated accompaniment stems (other + bass) for chord detection when harmonically rich."""
    other_list = list(other_notes or [])
    bass_list = list(bass_notes or [])
    other_pcs = {int(n.pitch_midi) % 12 for n in other_list}
    if len(other_list) >= 4 and len(other_pcs) >= 2:
        combined = sorted([*other_list, *bass_list], key=lambda n: (n.onset_sec, n.pitch_midi))
        return combined

    accomp = sorted([*other_list, *bass_list], key=lambda n: (n.onset_sec, n.pitch_midi))
    accomp_pcs = {int(n.pitch_midi) % 12 for n in accomp}
    if len(accomp) >= 4 and len(accomp_pcs) >= 3:
        return accomp

    return list(fallback_notes)


def _safe_chord_symbol(chord_obj: music21.chord.Chord) -> music21.harmony.ChordSymbol | None:
    try:
        cs = music21.harmony.chordSymbolFromChord(chord_obj)
    except Exception:
        return None
    figure = (cs.figure or "").strip()
    if (
        not figure
        or figure == "Chord Symbol Cannot Be Identified"
        or cs.chordKind in ("power", "", "none")
        or "add" in figure
        or "no" in figure
        or "alter" in figure
    ):
        return None
    return cs


def _parse_key_signature_for_analysis(key_signature: str) -> music21.key.Key:
    clean = (key_signature or "C major").strip()
    lower = clean.lower()
    if lower.endswith(" major"):
        is_minor = False
        tonic = clean[:-6].strip()
    elif lower.endswith(" minor"):
        is_minor = True
        tonic = clean[:-6].strip()
    else:
        is_minor = clean.endswith("m") and len(clean) > 1
        tonic = clean[:-1] if is_minor else clean
    try:
        return music21.key.Key(tonic.replace("b", "-"), "minor" if is_minor else "major")
    except Exception:
        return music21.key.Key("C", "major")


def _spell_pitch_for_key(p: music21.pitch.Pitch, key_obj: music21.key.Key) -> music21.pitch.Pitch:
    if key_obj.sharps < 0 and p.accidental is not None and p.accidental.alter > 0:
        return p.getEnharmonic()
    if key_obj.sharps > 0 and p.accidental is not None and p.accidental.alter < 0:
        return p.getEnharmonic()
    return p


def _format_readable_symbol(cs: music21.harmony.ChordSymbol) -> tuple[str, str, str]:
    figure = cs.figure.strip().replace("-", "b")
    # Standardize diminished triad symbol if music21 emits 'o'
    figure = figure.replace("o7", "dim7").replace("o", "dim")
    root_name = cs.root().name.replace("-", "b")
    quality = cs.chordKind or "major"
    return figure, root_name, quality


def _build_chord_from_pcs(
    pcs: list[int],
    lowest_midi: int | None,
    include_bass: bool,
    key_obj: music21.key.Key,
) -> music21.chord.Chord | None:
    bass_pc = (lowest_midi % 12) if lowest_midi is not None else None
    slice_pitches: list[music21.pitch.Pitch] = []
    if include_bass and bass_pc is not None and bass_pc in pcs and lowest_midi is not None:
        slice_pitches.append(_spell_pitch_for_key(music21.pitch.Pitch(lowest_midi), key_obj))
    for pc in pcs:
        if include_bass and pc == bass_pc:
            continue
        slice_pitches.append(_spell_pitch_for_key(music21.pitch.Pitch(60 + pc), key_obj))
    if not slice_pitches:
        return None
    tmp_stream = music21.stream.Part()
    tmp_stream.insert(0.0, music21.chord.Chord(slice_pitches, quarterLength=1.0))
    chordified = tmp_stream.chordify()
    return next(iter(chordified.recurse().getElementsByClass(music21.chord.Chord)), None)


def _infer_dyad_chord(
    *,
    ranked_pcs: list[tuple[int, float]],
    pc_weights: dict[int, float],
    bass_pc: int | None,
    bass_is_sustained: bool,
    key_pcs: set[int],
    key_obj: music21.key.Key,
    cfg: ChordDetectionConfig,
) -> tuple[str, str, str, float] | None:
    """Infer an implied triad from a strong 2-pitch-class dyad (e.g. root+3rd or root+5th)."""
    if not bass_is_sustained or len(ranked_pcs) < 2:
        return None
    (pc_a, w_a), (pc_b, w_b) = ranked_pcs[0], ranked_pcs[1]
    if w_a <= 0 or w_b < 0.45 * w_a:
        return None
    total_w = sum(pc_weights.values())
    if total_w < max(cfg.min_window_total_weight, 0.90):
        return None

    interval = (pc_b - pc_a) % 12
    # Determine candidate (root_pc, suffix, quality_name) from harmonic interval
    candidates: list[tuple[int, str, str]] = []
    if interval == 4:  # Major 3rd: pc_a -> pc_b
        candidates.append((pc_a, "", "major"))
    elif interval == 8:  # Minor 6th: pc_b -> pc_a is Major 3rd
        candidates.append((pc_b, "", "major"))
    elif interval in (3, 9):  # Minor 3rd (pc_a -> pc_b) or Major 6th (pc_b -> pc_a)
        root_pc = pc_a if interval == 3 else pc_b
        candidates.append((root_pc, "m", "minor"))
    else:
        return None

    if not candidates:
        return None

    best_result: tuple[str, str, str, float] | None = None
    best_score = -1.0
    for root_pc, suffix, quality_name in candidates:
        if bass_pc is None or bass_pc != root_pc:
            continue
        if key_pcs and not ({pc_a, pc_b} <= key_pcs or root_pc in key_pcs):
            continue
        coverage = (w_a + w_b) / total_w
        diatonic_ratio = (len({pc_a, pc_b} & key_pcs) / 2.0) if key_pcs else 0.7
        bass_bonus = 0.14
        # Penalty vs full 3-note triads so brief 2-note melodic fragments stay suppressed
        score = min(1.0, max(0.0, 0.62 * coverage + 0.24 * diatonic_ratio + bass_bonus - 0.12))
        if score > best_score:
            best_score = score
            spelled = _spell_pitch_for_key(music21.pitch.Pitch(60 + root_pc), key_obj)
            root_name = spelled.name.replace("-", "b")
            best_result = (f"{root_name}{suffix}", root_name, quality_name, score)

    if best_result is None or best_score < max(cfg.min_confidence, 0.78):
        return None
    return best_result


def _is_complex_extension(cs: music21.harmony.ChordSymbol) -> bool:
    fig = cs.figure or ""
    kind = cs.chordKind or ""
    return any(tok in fig for tok in ("9", "11", "13")) or kind in (
        "major-ninth",
        "minor-ninth",
        "dominant-ninth",
        "eleventh",
        "thirteenth",
    )


_FLAT_PC_NAMES = ("C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B")
_SHARP_PC_NAMES = ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")
_NEUTRAL_PC_NAMES = ("C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B")


# (suffix, quality_name, required_intervals, optional_intervals, template_prior)
# Required intervals exclude 0 (root). Shell 7ths omit the 5th (7) safely.
_CHORD_TEMPLATES: tuple[tuple[str, str, tuple[int, ...], tuple[int, ...], float], ...] = (
    ("", "major", (4, 7), (), 0.06),
    ("m", "minor", (3, 7), (), 0.06),
    ("dim", "diminished", (3, 6), (), 0.01),
    ("aug", "augmented", (4, 8), (), 0.00),
    ("sus4", "suspended-fourth", (5, 7), (), 0.01),
    ("sus2", "suspended-second", (2, 7), (), 0.00),
    ("7", "dominant-seventh", (4, 10), (7,), 0.04),
    ("maj7", "major-seventh", (4, 11), (7,), 0.04),
    ("m7", "minor-seventh", (3, 10), (7,), 0.04),
    ("dim7", "diminished-seventh", (3, 6, 9), (), 0.01),
    ("m7b5", "half-diminished", (3, 6, 10), (), 0.01),
    ("7sus4", "dominant-seventh", (5, 7, 10), (), 0.02),
    ("6", "major-sixth", (4, 7, 9), (), 0.01),
    ("m6", "minor-sixth", (3, 7, 9), (), 0.01),
)


def _pc_name(pc: int, key_obj: music21.key.Key) -> str:
    idx = int(pc) % 12
    if key_obj.sharps < 0:
        return _FLAT_PC_NAMES[idx]
    if key_obj.sharps > 0:
        return _SHARP_PC_NAMES[idx]
    return _NEUTRAL_PC_NAMES[idx]


def _score_chord_templates(
    pc_weights: dict[int, float],
    lowest_midi: int | None,
    bass_is_sustained: bool,
    key_obj: music21.key.Key,
    cfg: ChordDetectionConfig,
) -> list[tuple[str, str, str, float, int]]:
    """Score pitch-class templates + slash inversions + shell voicings.

    Returns candidates sorted best-first as:
    ``(symbol, root_name, quality_name, confidence, root_pc)``.
    """
    if not pc_weights:
        return []
    total_w = sum(pc_weights.values())
    if total_w <= 1e-6:
        return []

    max_w = max(pc_weights.values())
    active_pcs = [pc for pc, w in pc_weights.items() if w >= cfg.min_pc_weight_ratio * max_w]
    if len(active_pcs) < 2:
        return []

    bass_pc = (lowest_midi % 12) if lowest_midi is not None else None
    key_pcs = {int(p.pitchClass) for p in key_obj.pitches}

    # Handle 2-PC dyads via existing conservative dyad inference
    ranked_pcs = sorted(((pc, pc_weights[pc]) for pc in active_pcs), key=lambda x: -x[1])
    if len(active_pcs) < cfg.min_distinct_pcs:
        dyad = _infer_dyad_chord(
            ranked_pcs=ranked_pcs[:2],
            pc_weights=pc_weights,
            bass_pc=bass_pc,
            bass_is_sustained=bass_is_sustained,
            key_pcs=key_pcs,
            key_obj=key_obj,
            cfg=cfg,
        )
        if dyad is None:
            return []
        sym, r_name, q_name, conf = dyad
        # Derive root_pc cleanly
        r_pc = bass_pc if bass_pc is not None else ranked_pcs[0][0]
        return [(sym, r_name, q_name, conf, r_pc)]

    allow_bass_slash = bool(
        cfg.allow_slash_chords
        and lowest_midi is not None
        and (lowest_midi < 60 or bass_is_sustained)
        and bass_pc is not None
        and pc_weights.get(bass_pc, 0.0) >= cfg.min_bass_weight_ratio * total_w
    )

    candidates: list[tuple[str, str, str, float, int]] = []
    for root_pc in range(12):
        root_w = pc_weights.get(root_pc, 0.0)
        if root_w < 0.08 * total_w:
            continue

        for suffix, quality_name, req_ints, opt_ints, prior in _CHORD_TEMPLATES:
            req_pcs = {root_pc} | {(root_pc + iv) % 12 for iv in req_ints}
            opt_pcs = {(root_pc + iv) % 12 for iv in opt_ints}
            all_template_pcs = req_pcs | opt_pcs

            # Every required pitch class must have meaningful presence
            if not all(pc_weights.get(pc, 0.0) >= 0.08 * total_w for pc in req_pcs):
                continue

            matched_w = sum(pc_weights.get(pc, 0.0) for pc in all_template_pcs)
            extra_w = total_w - matched_w
            coverage = matched_w / total_w

            # Reject if significant weight falls outside chord tones
            if coverage < 0.68:
                continue

            # Bass compatibility & inversion detection
            bass_bonus = 0.0
            slash_suffix = ""
            if bass_pc is not None:
                if bass_pc == root_pc:
                    bass_bonus = 0.14
                else:
                    bass_iv = (bass_pc - root_pc) % 12
                    if bass_iv in req_ints or bass_iv in opt_ints:
                        # Valid chord inversion (3rd, 5th, or 7th in bass)
                        bass_bonus = 0.04
                        if allow_bass_slash and bass_iv in (3, 4, 7, 10, 11):
                            slash_suffix = f"/{_pc_name(bass_pc, key_obj)}"
                    else:
                        # Unrelated bass weakens this root interpretation
                        bass_bonus = -0.14

            # Diatonic alignment with key
            if key_pcs:
                diatonic_frac = len(req_pcs & key_pcs) / float(len(req_pcs))
                diatonic_bonus = 0.07 * diatonic_frac if diatonic_frac >= 0.99 else (0.02 * diatonic_frac)
            else:
                diatonic_bonus = 0.0

            # Gentle complexity penalty for unnecessary 4-note fits when optional 5th omitted vs complete triad
            omitted_opt_penalty = 0.02 if (opt_pcs and not any(pc_weights.get(pc, 0.0) >= 0.08 * total_w for pc in opt_pcs)) else 0.0
            # Slight reward for explaining 4th note (true 7ths/6ths) when strongly present
            four_note_bonus = 0.05 if (len(all_template_pcs) >= 4 and len(req_pcs) + len([p for p in opt_pcs if pc_weights.get(p, 0.0) >= 0.10 * total_w]) >= 4) else 0.0

            raw_score = (
                0.76 * coverage
                - 0.24 * (extra_w / total_w)
                + bass_bonus
                + diatonic_bonus
                + prior
                + four_note_bonus
                - omitted_opt_penalty
            )
            conf = round(min(1.0, max(0.0, raw_score)), 4)
            if conf < cfg.min_confidence:
                continue

            root_name = _pc_name(root_pc, key_obj)
            symbol = f"{root_name}{suffix}{slash_suffix}"
            candidates.append((symbol, root_name, quality_name, conf, root_pc))

    # Keep highest confidence entry per unique symbol
    best_by_sym: dict[str, tuple[str, str, str, float, int]] = {}
    for cand in candidates:
        sym = cand[0]
        if sym not in best_by_sym or cand[3] > best_by_sym[sym][3]:
            best_by_sym[sym] = cand
    ordered = sorted(best_by_sym.values(), key=lambda c: (-c[3], len(c[0])))
    return ordered[:6]


def _analyze_window_chord(
    pc_weights: dict[int, float],
    lowest_midi: int | None,
    bass_is_sustained: bool,
    key_obj: music21.key.Key,
    cfg: ChordDetectionConfig,
) -> tuple[str, str, str, float] | None:
    cands = _score_chord_templates(pc_weights, lowest_midi, bass_is_sustained, key_obj, cfg)
    if cands:
        sym, root_n, qual, conf, _ = cands[0]
        return sym, root_n, qual, conf

    # Fallback to music21 for rare valid chords not covered above
    if not pc_weights:
        return None
    total_w = sum(pc_weights.values())
    if total_w <= 1e-6:
        return None
    max_w = max(pc_weights.values())
    ranked_pcs = sorted(
        ((pc, w) for pc, w in pc_weights.items() if w >= cfg.min_pc_weight_ratio * max_w),
        key=lambda item: -item[1],
    )
    filtered_pcs = [pc for pc, _ in ranked_pcs[:4]]
    bass_pc = (lowest_midi % 12) if lowest_midi is not None else None
    if len(filtered_pcs) < cfg.min_distinct_pcs:
        return None

    include_bass = (
        cfg.allow_slash_chords
        and lowest_midi is not None
        and (lowest_midi < 60 or bass_is_sustained)
        and bass_pc is not None
        and bass_pc in filtered_pcs
        and pc_weights.get(bass_pc, 0.0) >= cfg.min_bass_weight_ratio * total_w
    )
    core_chord = _build_chord_from_pcs([pc for pc, _ in ranked_pcs[:3]], lowest_midi, include_bass, key_obj)
    core_cs = _safe_chord_symbol(core_chord) if core_chord is not None else None
    if core_cs is None or core_chord is None or _is_complex_extension(core_cs):
        return None
    symbol, root_name, quality = _format_readable_symbol(core_cs)
    chord_pcs = {p.pitchClass for p in core_chord.pitches}
    coverage = sum(pc_weights.get(pc, 0.0) for pc in chord_pcs) / max(1e-6, total_w)
    conf = min(1.0, max(0.0, coverage * 0.88))
    if conf < cfg.min_confidence:
        return None
    return symbol, root_name, quality, conf


def detect_chords(
    notes: list[ScoreNote],
    tempo_bpm: float,
    time_signature: str,
    key_signature: str = "C major",
    timing_map=None,
    config: ChordDetectionConfig | None = None,
) -> list[ScoreChord]:
    """Identify confidence-aware, key-consistent chord symbols with Viterbi contextual smoothing."""
    if not notes:
        return []
    cfg = config or ChordDetectionConfig()
    try:
        num = max(1, int(time_signature.split("/")[0]))
    except Exception:
        num = 4

    sec_per_beat = 60.0 / max(20.0, tempo_bpm)
    key_obj = _parse_key_signature_for_analysis(key_signature)
    key_diatonic_pcs = {int(p.pitchClass) for p in key_obj.pitches}

    def _to_ql(sec: float) -> float:
        if timing_map is not None:
            return max(0.0, float(timing_map.seconds_to_ql(sec)))
        return max(0.0, sec / sec_per_beat)

    def _to_sec(ql: float) -> float:
        if timing_map is not None:
            return max(0.0, float(timing_map.ql_to_seconds(ql)))
        return max(0.0, ql * sec_per_beat)

    note_qls = [
        (
            n,
            _to_ql(n.onset_sec),
            max(_to_ql(n.onset_sec) + 0.125, _to_ql(n.offset_sec)),
            (n.offset_sec - n.onset_sec) >= cfg.min_note_duration_sec,
        )
        for n in notes
    ]
    max_ql = max(off_ql for _, _, off_ql, _ in note_qls)
    total_beats = max(1, int(np.ceil(max_ql)))

    def _collect_weights(w_start_ql: float, w_end_ql: float) -> tuple[dict[int, float], int | None, bool, bool]:
        active = [
            (n, min(off_ql, w_end_ql) - max(on_ql, w_start_ql), on_ql, is_sub)
            for n, on_ql, off_ql, is_sub in note_qls
            if min(off_ql, w_end_ql) - max(on_ql, w_start_ql) > 0.05
        ]
        if not active:
            return {}, None, False, False
        substantive = [(n, ov, on_ql) for n, ov, on_ql, is_sub in active if is_sub]
        chosen = substantive if substantive else [(n, ov, on_ql) for n, ov, on_ql, _ in active]
        pc_weights: dict[int, float] = {}
        lowest_midi: int | None = None
        lowest_ov: float = 0.0
        has_new_bass_attack = False
        for n, ov, on_ql in chosen:
            conf_factor = float(n.confidence) if n.confidence is not None else 0.75
            bass_factor = 1.40 if n.pitch_midi < 60 else 1.0
            sustain_factor = 1.15 if ov >= 0.75 else 1.0
            # Down-weight brief off-beat passing tones
            passing_factor = 0.65 if (ov < 0.35 and (on_ql % 1.0) > 0.15) else 1.0
            pc = n.pitch_midi % 12
            key_factor = cfg.key_diatonic_weight_boost if pc in key_diatonic_pcs else 1.0
            w = (
                ov
                * (max(1, n.velocity) / 127.0)
                * max(0.25, conf_factor)
                * bass_factor
                * sustain_factor
                * passing_factor
                * key_factor
            )
            pc_weights[pc] = pc_weights.get(pc, 0.0) + w
            if lowest_midi is None or n.pitch_midi < lowest_midi:
                lowest_midi = n.pitch_midi
                lowest_ov = ov
            if n.pitch_midi < 58 and (w_start_ql - 0.12) <= on_ql <= (w_start_ql + 0.35):
                has_new_bass_attack = True
        if sum(pc_weights.values()) < cfg.min_window_total_weight:
            return {}, None, False, False
        return pc_weights, lowest_midi, lowest_ov >= 0.45, has_new_bass_attack

    # Collect per-beat top-K chord candidates using 1-beat + half-measure smoothing fallback
    beat_cands: list[list[tuple[str, str, str, float, int]]] = []
    beat_has_bass_attack: list[bool] = []
    for b_idx in range(total_beats):
        pc_w, low_midi, low_sustained, bass_att = _collect_weights(float(b_idx), float(b_idx + 1))
        cands = _score_chord_templates(pc_w, low_midi, low_sustained, key_obj, cfg)
        if not cands:
            fb = _analyze_window_chord(pc_w, low_midi, low_sustained, key_obj, cfg)
            if fb is not None:
                cands = [(fb[0], fb[1], fb[2], fb[3], 0)]
        # Try 2-beat window on strong metrical subdivisions when 1-beat window is sparse/ambiguous
        if (not cands or cands[0][3] < 0.68) and b_idx % 2 == 0 and b_idx + 1 < total_beats:
            pc_w2, low_midi2, low_sustained2, bass_att2 = _collect_weights(
                float(b_idx), float(min(total_beats, b_idx + 2))
            )
            cands2 = _score_chord_templates(pc_w2, low_midi2, low_sustained2, key_obj, cfg)
            if cands2 and (not cands or cands2[0][3] > cands[0][3] + 0.03):
                cands = cands2
                bass_att = bass_att or bass_att2
        beat_cands.append(cands)
        beat_has_bass_attack.append(bass_att)

    active_beats = [b for b, c in enumerate(beat_cands) if c]
    if not active_beats:
        return []

    # Viterbi smoothing across beats with metrical transition priors
    strong_beats = {0} | ({2} if num == 4 else ({3} if num == 6 else set()))
    dp: dict[int, tuple[float, int | None, int]] = {}  # cand_idx -> (score, prev_idx, run_len)
    backpointers: list[dict[int, int]] = []

    prev_b = active_beats[0]
    first_cands = beat_cands[prev_b]
    dp = {i: (c[3], None, 1) for i, c in enumerate(first_cands)}
    backpointers.append({i: -1 for i in range(len(first_cands))})

    chosen_seq: list[tuple[int, tuple[str, str, str, float, int]]] = []
    paths: list[tuple[int, list[tuple[str, str, str, float, int]]]] = [(prev_b, first_cands)]
    for b_idx in active_beats[1:]:
        cur_cands = beat_cands[b_idx]
        prev_cands = paths[-1][1]
        is_strong_beat = (b_idx % num) in strong_beats
        gap_beats = b_idx - paths[-1][0]
        new_bass = beat_has_bass_attack[b_idx]

        # Metric transition penalty: barlines & beat-3 are natural change points;
        # off-beats require stronger harmonic/bass evidence to switch chords.
        if gap_beats > 1:
            base_change_pen = 0.04
        elif (b_idx % num) == 0:
            base_change_pen = 0.05
        elif is_strong_beat:
            base_change_pen = 0.11 if not new_bass else 0.06
        else:
            base_change_pen = 0.24 if not new_bass else 0.14

        new_dp: dict[int, tuple[float, int | None, int]] = {}
        bp: dict[int, int] = {}
        for j, cur_c in enumerate(cur_cands):
            best_score = -1e9
            best_prev = 0
            best_run = 1
            for i, prev_c in enumerate(prev_cands):
                prev_score, _, prev_run = dp[i]
                same_sym = cur_c[0] == prev_c[0]
                same_root = cur_c[1] == prev_c[1]
                if same_sym:
                    pen = -0.02  # small continuity bonus for staying in same harmony
                    run_len = prev_run + 1
                elif same_root and "suspended" in cur_c[2] and prev_c[2] in ("major", "minor"):
                    # Discourage transient same-root sus embellishment over clean triad
                    pen = base_change_pen + 0.12
                    run_len = 1
                else:
                    # Slight extra smoothing if previous chord only lasted 1 beat
                    short_chatter_pen = 0.08 if (prev_run == 1 and not is_strong_beat and gap_beats == 1) else 0.0
                    pen = base_change_pen + short_chatter_pen
                    run_len = 1
                cand_score = prev_score + cur_c[3] - pen
                if cand_score > best_score:
                    best_score = cand_score
                    best_prev = i
                    best_run = run_len
            new_dp[j] = (best_score, best_prev, best_run)
            bp[j] = best_prev
        dp = new_dp
        backpointers.append(bp)
        paths.append((b_idx, cur_cands))

    # Backtrack optimal chord sequence
    last_idx = max(dp.keys(), key=lambda idx: dp[idx][0])
    chosen_indices = [0] * len(paths)
    cur_idx = last_idx
    for k in range(len(paths) - 1, -1, -1):
        chosen_indices[k] = cur_idx
        cur_idx = backpointers[k][cur_idx] if k > 0 else -1

    for (b_idx, cands), idx in zip(paths, chosen_indices, strict=True):
        chosen_seq.append((b_idx, cands[idx]))

    # Final lightweight passing-blip check for any remaining A -> B -> A where B wasn't high confidence
    raw_snapshots = [(b_idx, c[0], c[1], c[2], c[3]) for b_idx, c in chosen_seq]
    filtered: list[tuple[int, str, str, str, float]] = []
    for idx, snap in enumerate(raw_snapshots):
        b_idx, sym, root_n, qual, conf = snap
        prev_snap = raw_snapshots[idx - 1] if idx > 0 else None
        next_snap = raw_snapshots[idx + 1] if idx + 1 < len(raw_snapshots) else None
        if prev_snap and next_snap and prev_snap[1] == next_snap[1] and sym != prev_snap[1]:
            if conf < cfg.strong_short_change_confidence or (
                root_n == prev_snap[2] and qual in ("suspended-second", "suspended-fourth")
            ):
                continue
        if prev_snap and root_n == prev_snap[2] and qual in ("suspended-second", "suspended-fourth"):
            if prev_snap[3] in ("major", "minor") or (
                next_snap and next_snap[2] == root_n and "suspended" not in next_snap[3]
            ):
                continue
        filtered.append(snap)

    # Deduplicate consecutive identical chord symbols and enforce minimum label spacing
    chords: list[ScoreChord] = []
    last_symbol: str | None = None
    last_b_idx: int | None = None
    for b_idx, symbol, root_name, quality, conf in filtered:
        if symbol == last_symbol:
            continue
        if last_b_idx is not None and (b_idx - last_b_idx) < cfg.min_label_spacing_beats:
            continue
        last_symbol = symbol
        last_b_idx = b_idx
        measure = (b_idx // num) + 1
        beat = float((b_idx % num) + 1)
        chords.append(
            ScoreChord(
                id=uuid.uuid4().hex[:10],
                measure=max(1, measure),
                beat=max(1.0, beat),
                onset_sec=round(_to_sec(float(b_idx)), 3),
                symbol=symbol,
                root=root_name,
                quality=quality,
                confidence=round(float(conf), 3),
            )
        )
    return chords
