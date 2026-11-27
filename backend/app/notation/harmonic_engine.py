"""Music-theory-aware beat-aligned harmonic analysis and Viterbi chord decoding.

Combines symbolic note weights, dedicated Demucs bass-stem pitch tracking (with
low-frequency mix fallback), harmonic chroma cues, metrical hierarchy, local/global
Krumhansl-Schmuckler tonal context, Circle-of-Fifths functional transitions,
secondary dominants, borrowed chords, and bass voice-leading into normalized
lead-sheet chord symbols.
"""

from __future__ import annotations

import logging
import re
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import librosa
import music21
import numpy as np
import soundfile as sf

from app.schemas.score import ScoreChord, ScoreNote

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Pitch-class helpers & Krumhansl-Schmuckler tonal profiles
# ---------------------------------------------------------------------------

_NOTE_PC_MAP: dict[str, int] = {
    "C": 0, "B#": 0,
    "C#": 1, "DB": 1, "D-": 1,
    "D": 2,
    "D#": 3, "EB": 3, "E-": 3,
    "E": 4, "FB": 4,
    "F": 5, "E#": 5,
    "F#": 6, "GB": 6, "G-": 6,
    "G": 7,
    "G#": 8, "AB": 8, "A-": 8,
    "A": 9,
    "A#": 10, "BB": 10, "B-": 10,
    "B": 11, "CB": 11,
}

_FLAT_PC_NAMES = ("C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B")
_SHARP_PC_NAMES = ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")
_NEUTRAL_PC_NAMES = ("C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B")

_SHARP_STEP_SPELLING: tuple[tuple[str, int], ...] = (
    ("C", 0), ("C", 1), ("D", 0), ("D", 1), ("E", 0), ("F", 0),
    ("F", 1), ("G", 0), ("G", 1), ("A", 0), ("A", 1), ("B", 0),
)
_FLAT_STEP_SPELLING: tuple[tuple[str, int], ...] = (
    ("C", 0), ("D", -1), ("D", 0), ("E", -1), ("E", 0), ("F", 0),
    ("G", -1), ("G", 0), ("A", -1), ("A", 0), ("B", -1), ("B", 0),
)

_KK_MAJOR_PROFILE = np.array(
    [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88],
    dtype=np.float64,
)
_KK_MINOR_PROFILE = np.array(
    [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17],
    dtype=np.float64,
)

# (suffix, quality_name, required_intervals, optional_intervals, template_prior)
CHORD_TEMPLATES: tuple[tuple[str, str, tuple[int, ...], tuple[int, ...], float], ...] = (
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
    ("7sus4", "suspended-fourth", (5, 7, 10), (), 0.015),
    ("add9", "major-add9", (4, 7, 2), (), 0.012),
    ("madd9", "minor-add9", (3, 7, 2), (), 0.012),
    ("6", "major-sixth", (4, 7, 9), (), 0.008),
    ("m6", "minor-sixth", (3, 7, 9), (), 0.008),
)


@dataclass
class ChordCandidate:
    symbol: str
    root_name: str
    quality: str
    confidence: float
    root_pc: int
    bass_pc: int
    chord_pcs: frozenset[int]
    coverage: float
    is_slash: bool = False
    is_sus: bool = False


@dataclass
class BeatAudioFeature:
    chroma: np.ndarray | None = None
    first_half_chroma: np.ndarray | None = None
    second_half_chroma: np.ndarray | None = None
    bass_pc: int | None = None
    bass_confidence: float = 0.0
    bass_is_passing: bool = False
    bass_onset_attack: bool = False
    bass_source: str = "none"
    harmonic_energy: float = 0.0


# ---------------------------------------------------------------------------
# Vocabulary normalization & MusicXML harmony specification
# ---------------------------------------------------------------------------

_ROOT_RE = re.compile(r"^([A-Ga-g])([#b\-\u266f\u266d]?)(.*)$")

_QUALITY_NORM_REPLACEMENTS: tuple[tuple[str, str], ...] = (
    ("suspended-fourth-seventh", "7sus4"),
    ("dominant-seventh", "7"),
    ("major-seventh", "maj7"),
    ("minor-seventh", "m7"),
    ("diminished-seventh", "dim7"),
    ("half-diminished", "m7b5"),
    ("suspended-fourth", "sus4"),
    ("suspended-second", "sus2"),
    ("major-sixth", "6"),
    ("minor-sixth", "m6"),
    ("major-ninth", "add9"),
    ("minor-ninth", "madd9"),
    ("major-add9", "add9"),
    ("minor-add9", "madd9"),
    ("augmented", "aug"),
    ("diminished", "dim"),
    ("minor", "m"),
    ("major", ""),
)


def _normalize_note_token(token: str) -> str:
    m = _ROOT_RE.match((token or "").strip())
    if not m:
        return (token or "").strip()
    step = m.group(1).upper()
    acc = m.group(2).replace("-", "b").replace("\u266d", "b").replace("\u266f", "#")
    return f"{step}{acc}"


def normalize_chord_symbol(symbol: str) -> str:
    """Normalize chord strings (flats, diminished, sus7, inversions) to lead-sheet form."""
    raw = (symbol or "").strip()
    if not raw:
        return ""

    head, sep, bass = raw.partition("/")
    m = _ROOT_RE.match(head.strip())
    if not m:
        return raw.replace("-", "b")

    step = m.group(1).upper()
    acc = m.group(2).replace("-", "b").replace("\u266d", "b").replace("\u266f", "#")
    qual = m.group(3).strip()

    # Standardize unicode / music21 quality tokens
    qual = qual.replace("\u00f87", "m7b5").replace("\u00f8", "m7b5")
    qual = qual.replace("\u00b07", "dim7").replace("\u00b0", "dim")
    qual = qual.replace("o7", "dim7")
    if qual == "o":
        qual = "dim"
    elif qual.startswith("o/"):
        qual = "dim" + qual[1:]

    # Remove verbose bracketed alterations/no-3rd decorations if present
    qual = re.sub(r"\[[^\]]+\]", "", qual).strip()
    for long_tok, short_tok in _QUALITY_NORM_REPLACEMENTS:
        if qual.lower() == long_tok:
            qual = short_tok
            break

    if qual in ("M7", "maj7", "\u03947", "\u0394"):
        qual = "maj7"
    elif qual in ("-7", "min7"):
        qual = "m7"
    elif qual in ("-", "min"):
        qual = "m"
    elif qual.lower() in ("sus", "sus4"):
        qual = "sus4"
    elif qual.lower() == "7sus":
        qual = "7sus4"
    elif qual == "add2":
        qual = "add9"
    elif qual in ("madd2", "minadd2", "minadd9"):
        qual = "madd9"

    norm_head = f"{step}{acc}{qual}"
    if sep and bass.strip():
        return f"{norm_head}/{_normalize_note_token(bass)}"
    return norm_head


def chord_symbol_to_musicxml_spec(
    symbol: str,
    fallback_root: str | None = None,
    fallback_quality: str | None = None,
) -> tuple[str, int, str, str, str | None, int | None, list[tuple[int, int, str]]] | None:
    """Parse a lead-sheet chord symbol into MusicXML `<harmony>` components.

    Returns ``(root_step, root_alter, kind, kind_text, bass_step, bass_alter, degrees)``
    using strictly valid MusicXML `<kind>` values (never `suspended-fourth-seventh`).
    """
    norm = normalize_chord_symbol(symbol)
    if not norm and fallback_root:
        norm = normalize_chord_symbol(f"{fallback_root}{fallback_quality or ''}")
    if not norm:
        return None

    head, _, bass = norm.partition("/")
    m = _ROOT_RE.match(head.strip())
    if not m:
        return None

    root_step = m.group(1).upper()
    acc = m.group(2).replace("-", "b").replace("\u266d", "b").replace("\u266f", "#")
    root_alter = 1 if acc == "#" else (-1 if acc == "b" else 0)
    rest = m.group(3).strip()

    bass_step: str | None = None
    bass_alter: int | None = None
    if bass.strip():
        bm = _ROOT_RE.match(bass.strip())
        if bm:
            bass_step = bm.group(1).upper()
            b_acc = bm.group(2).replace("-", "b").replace("\u266d", "b").replace("\u266f", "#")
            bass_alter = 1 if b_acc == "#" else (-1 if b_acc == "b" else 0)

    # Map normalized suffix -> valid MusicXML 3.1/4.0 <kind>, display text, and <degree> list
    rl = rest.lower()
    degrees: list[tuple[int, int, str]] = []
    if rest == "":
        kind, kind_text = "major", ""
    elif rl == "m":
        kind, kind_text = "minor", "m"
    elif rl == "maj7":
        kind, kind_text = "major-seventh", "maj7"
    elif rl == "m7":
        kind, kind_text = "minor-seventh", "m7"
    elif rl == "7":
        kind, kind_text = "dominant", "7"
    elif rl == "m7b5":
        kind, kind_text = "half-diminished", "m7b5"
    elif rl == "dim7":
        kind, kind_text = "diminished-seventh", "dim7"
    elif rl == "dim":
        kind, kind_text = "diminished", "dim"
    elif rl == "aug":
        kind, kind_text = "augmented", "aug"
    elif rl == "sus4":
        kind, kind_text = "suspended-fourth", "sus4"
    elif rl == "sus2":
        kind, kind_text = "suspended-second", "sus2"
    elif rl == "7sus4":
        kind, kind_text = "suspended-fourth", "7sus4"
        degrees.append((7, -1, "add"))
    elif rl == "add9":
        kind, kind_text = "major", "add9"
        degrees.append((9, 0, "add"))
    elif rl == "madd9":
        kind, kind_text = "minor", "madd9"
        degrees.append((9, 0, "add"))
    elif rl == "6":
        kind, kind_text = "major-sixth", "6"
    elif rl == "m6":
        kind, kind_text = "minor-sixth", "m6"
    elif rl == "9":
        kind, kind_text = "dominant-ninth", "9"
    elif rl == "maj9":
        kind, kind_text = "major-ninth", "maj9"
    elif rl == "m9":
        kind, kind_text = "minor-ninth", "m9"
    else:
        kind, kind_text = "major", rest

    return root_step, root_alter, kind, kind_text, bass_step, bass_alter, degrees


def parse_chord_pcs(symbol: str, fallback_root: str | None = None, fallback_quality: str | None = None) -> tuple[int, int | None, set[int]]:
    """Return ``(root_pc, bass_pc_or_none, chord_pcs)`` for normalized symbols."""
    spec = chord_symbol_to_musicxml_spec(symbol, fallback_root=fallback_root, fallback_quality=fallback_quality)
    if spec is None:
        return 0, None, {0, 4, 7}
    r_step, r_alt, _, kind_text, b_step, b_alt, _ = spec
    r_tok = f"{r_step}{'#' if r_alt > 0 else ('b' if r_alt < 0 else '')}"
    root_pc = _NOTE_PC_MAP.get(r_tok, 0)

    bass_pc: int | None = None
    if b_step:
        b_tok = f"{b_step}{'#' if (b_alt or 0) > 0 else ('b' if (b_alt or 0) < 0 else '')}"
        bass_pc = _NOTE_PC_MAP.get(b_tok)

    kt = kind_text.lower()
    if kt == "7sus4":
        ivs = (0, 5, 7, 10)
    elif kt == "add9":
        ivs = (0, 4, 7, 2)
    elif kt == "madd9":
        ivs = (0, 3, 7, 2)
    elif kt == "sus4":
        ivs = (0, 5, 7)
    elif kt == "sus2":
        ivs = (0, 2, 7)
    elif kt == "dim7":
        ivs = (0, 3, 6, 9)
    elif kt == "m7b5":
        ivs = (0, 3, 6, 10)
    elif kt == "dim":
        ivs = (0, 3, 6)
    elif kt == "aug":
        ivs = (0, 4, 8)
    elif kt == "m7":
        ivs = (0, 3, 7, 10)
    elif kt == "maj7":
        ivs = (0, 4, 7, 11)
    elif kt == "7":
        ivs = (0, 4, 7, 10)
    elif kt == "6":
        ivs = (0, 4, 7, 9)
    elif kt == "m6":
        ivs = (0, 3, 7, 9)
    elif kt == "m9":
        ivs = (0, 3, 7, 10, 2)
    elif kt == "maj9":
        ivs = (0, 4, 7, 11, 2)
    elif kt == "9":
        ivs = (0, 4, 7, 10, 2)
    elif kt == "m":
        ivs = (0, 3, 7)
    else:
        ivs = (0, 4, 7)

    pcs = {(root_pc + iv) % 12 for iv in ivs}
    if bass_pc is not None:
        pcs.add(bass_pc)
    return root_pc, bass_pc, pcs


# ---------------------------------------------------------------------------
# Key signature & local key estimation
# ---------------------------------------------------------------------------

def parse_key_signature(key_signature: str) -> music21.key.Key:
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


def _pc_name(pc: int, key_obj: music21.key.Key) -> str:
    idx = int(pc) % 12
    if key_obj.sharps < 0:
        return _FLAT_PC_NAMES[idx]
    if key_obj.sharps > 0:
        return _SHARP_PC_NAMES[idx]
    return _NEUTRAL_PC_NAMES[idx]


def _pearson_corr(vec: np.ndarray, tpl: np.ndarray) -> float:
    va = vec - np.mean(vec)
    tb = tpl - np.mean(tpl)
    denom = float(np.linalg.norm(va) * np.linalg.norm(tb))
    return float(np.dot(va, tb) / denom) if denom > 1e-9 else 0.0


def _diatonic_pcs(tonic_pc: int, is_minor: bool) -> set[int]:
    if is_minor:
        # Natural minor + raised 7th (harmonic minor dominant V / V7 support)
        return {(tonic_pc + iv) % 12 for iv in (0, 2, 3, 5, 7, 8, 10, 11)}
    return {(tonic_pc + iv) % 12 for iv in (0, 2, 4, 5, 7, 9, 11)}


def _estimate_local_keys(
    window_pc_vecs: list[np.ndarray],
    window_bass_pcs: list[int | None],
    global_tonic_pc: int,
    global_is_minor: bool,
    window_radius: int = 8,
) -> list[tuple[int, bool]]:
    """Estimate local tonal center `(tonic_pc, is_minor)` over sliding ~4-bar windows."""
    n_win = len(window_pc_vecs)
    if n_win == 0:
        return []
    global_key = (global_tonic_pc, global_is_minor)
    if n_win < 8:
        return [global_key] * n_win

    result: list[tuple[int, bool]] = []
    for idx in range(n_win):
        lo = max(0, idx - window_radius)
        hi = min(n_win, idx + window_radius + 1)
        agg = np.sum(window_pc_vecs[lo:hi], axis=0)
        for j in range(lo, hi):
            b_pc = window_bass_pcs[j]
            if b_pc is not None:
                agg[b_pc] += 0.25 * float(np.max(window_pc_vecs[j]) if np.any(window_pc_vecs[j]) else 0.0)
        total = float(np.sum(agg))
        if total <= 1e-6:
            result.append(global_key)
            continue
        vec = agg / total
        global_score = _pearson_corr(
            vec,
            np.roll(_KK_MINOR_PROFILE if global_is_minor else _KK_MAJOR_PROFILE, global_tonic_pc),
        )
        best_key = global_key
        best_score = global_score + 0.09  # hysteresis: require clear local evidence to modulate
        for t_pc in range(12):
            maj_s = _pearson_corr(vec, np.roll(_KK_MAJOR_PROFILE, t_pc))
            if maj_s > best_score:
                best_score = maj_s
                best_key = (t_pc, False)
            min_s = _pearson_corr(vec, np.roll(_KK_MINOR_PROFILE, t_pc))
            if min_s > best_score:
                best_score = min_s
                best_key = (t_pc, True)
        result.append(best_key)
    return result


# ---------------------------------------------------------------------------
# Beat-aligned audio chroma & bass stem extraction
# ---------------------------------------------------------------------------

def _safe_slice_mean(mat: np.ndarray, f0: int, f1: int) -> np.ndarray | None:
    if mat.shape[1] == 0:
        return None
    i0 = max(0, min(mat.shape[1] - 1, f0))
    i1 = max(i0 + 1, min(mat.shape[1], f1))
    vec = np.mean(mat[:, i0:i1], axis=1).astype(np.float64)
    s = float(np.sum(vec))
    return (vec / s) if s > 1e-8 else None


def extract_beat_audio_features(
    window_spans_sec: list[tuple[float, float]],
    *,
    audio_path: Path | None = None,
    bass_stem_path: Path | None = None,
    harmonic_stem_path: Path | None = None,
) -> list[BeatAudioFeature]:
    """Extract beat-aligned chroma & Demucs-bass (or low-freq fallback) features."""
    n_win = len(window_spans_sec)
    if n_win == 0:
        return []
    feats = [BeatAudioFeature() for _ in range(n_win)]
    if audio_path is None and bass_stem_path is None and harmonic_stem_path is None:
        return feats

    max_sec = max(t1 for _, t1 in window_spans_sec)
    load_dur = min(360.0, max(2.0, max_sec + 1.0))

    # 1. Harmonic chroma source (prefer harmonic/piano stem so vocal vibrato never pollutes chords)
    harm_target = None
    if harmonic_stem_path is not None and Path(harmonic_stem_path).exists():
        harm_target = Path(harmonic_stem_path)
    elif audio_path is not None and Path(audio_path).exists():
        harm_target = Path(audio_path)

    chroma_sr = 22050
    chroma_hop = 1024
    chroma_mat: np.ndarray | None = None
    harm_mix_y: np.ndarray | None = None
    if harm_target is not None:
        try:
            y_h, sr_h = librosa.load(str(harm_target), sr=chroma_sr, mono=True, duration=load_dur)
            if y_h.size >= 1024 and float(np.max(np.abs(y_h))) >= 1e-4:
                harm_mix_y = librosa.effects.harmonic(y_h, margin=1.5)
                chroma_mat = librosa.feature.chroma_cqt(
                    y=harm_mix_y,
                    sr=sr_h,
                    hop_length=chroma_hop,
                    n_chroma=12,
                    bins_per_octave=24,
                )
        except Exception as exc:
            logger.debug("Harmonic chroma extraction skipped (%s)", exc)
            chroma_mat = None

    # 2. Dedicated Demucs bass stem (preferred) or low-frequency mix fallback
    bass_sr = 11025
    bass_hop = 512
    bass_pc_mat: np.ndarray | None = None
    bass_rms_frames: np.ndarray | None = None
    bass_med_rms = 0.0
    bass_source = "none"
    bass_conf_cap = 1.0

    def _compute_low_freq_bass(y_in: np.ndarray, sr_in: int, n_bins: int) -> tuple[np.ndarray | None, np.ndarray | None, float]:
        if y_in.size < 1024 or float(np.max(np.abs(y_in))) < 1e-4:
            return None, None, 0.0
        cqt = np.abs(
            librosa.cqt(
                y=y_in,
                sr=sr_in,
                hop_length=bass_hop,
                fmin=float(librosa.note_to_hz("C1")),
                n_bins=n_bins,
                bins_per_octave=12,
            )
        )
        # Favor lower octave fundamentals (C1..B2 > C3..B3 > C4..B4) over 2nd/3rd harmonics
        bin_weights = np.ones((n_bins, 1), dtype=np.float64)
        for b in range(n_bins):
            if b < 24:
                bin_weights[b, 0] = 1.40
            elif b < 36:
                bin_weights[b, 0] = 0.95
            else:
                bin_weights[b, 0] = 0.50
        weighted = (cqt ** 1.35) * bin_weights
        pc_mat = np.zeros((12, weighted.shape[1]), dtype=np.float64)
        for b in range(n_bins):
            pc_mat[b % 12] += weighted[b]
        rms = np.sqrt(np.mean(cqt[:min(30, n_bins)] ** 2, axis=0) + 1e-12)
        active_rms = rms[rms > 1e-5]
        med_rms = float(np.median(active_rms)) if active_rms.size > 0 else 0.0
        return pc_mat, rms, med_rms

    if bass_stem_path is not None and Path(bass_stem_path).exists():
        try:
            y_b, sr_b = librosa.load(str(bass_stem_path), sr=bass_sr, mono=True, duration=load_dur)
            bass_pc_mat, bass_rms_frames, bass_med_rms = _compute_low_freq_bass(y_b, sr_b, 48)
            if bass_pc_mat is not None and bass_med_rms > 1e-4:
                bass_source = "demucs_bass"
                bass_conf_cap = 1.0
        except Exception as exc:
            logger.debug("Demucs bass stem extraction skipped (%s)", exc)

    if bass_source == "none" and audio_path is not None and Path(audio_path).exists():
        try:
            if harm_mix_y is not None:
                y_low = librosa.resample(harm_mix_y, orig_sr=chroma_sr, target_sr=bass_sr)
            else:
                y_raw, _ = librosa.load(str(audio_path), sr=bass_sr, mono=True, duration=load_dur)
                y_low = y_raw
            bass_pc_mat, bass_rms_frames, bass_med_rms = _compute_low_freq_bass(y_low, bass_sr, 28)
            if bass_pc_mat is not None and bass_med_rms > 1e-4:
                bass_source = "low_freq_mix_fallback"
                bass_conf_cap = 0.70
        except Exception as exc:
            logger.debug("Low-freq fallback bass extraction skipped (%s)", exc)

    # 3. Slice features per beat window
    prev_tail_rms = 0.0
    for idx, (t0, t1) in enumerate(window_spans_sec):
        if t1 <= t0 + 1e-4:
            continue
        t_mid = 0.5 * (t0 + t1)

        if chroma_mat is not None:
            f0 = int(round(t0 * chroma_sr / chroma_hop))
            fm = int(round(t_mid * chroma_sr / chroma_hop))
            f1 = int(round(t1 * chroma_sr / chroma_hop))
            feats[idx].chroma = _safe_slice_mean(chroma_mat, f0, f1)
            feats[idx].first_half_chroma = _safe_slice_mean(chroma_mat, f0, fm)
            feats[idx].second_half_chroma = _safe_slice_mean(chroma_mat, fm, f1)

        if bass_pc_mat is not None and bass_rms_frames is not None and bass_med_rms > 1e-5:
            bf0 = max(0, min(bass_pc_mat.shape[1] - 1, int(round(t0 * bass_sr / bass_hop))))
            bfm = max(bf0 + 1, min(bass_pc_mat.shape[1], int(round(t_mid * bass_sr / bass_hop))))
            bf1 = max(bfm + 1, min(bass_pc_mat.shape[1], int(round(t1 * bass_sr / bass_hop))))
            b_vec = _safe_slice_mean(bass_pc_mat, bf0, bf1)
            b_first = _safe_slice_mean(bass_pc_mat, bf0, bfm)
            b_second = _safe_slice_mean(bass_pc_mat, bfm, bf1)
            win_rms = float(np.mean(bass_rms_frames[bf0:bf1])) if bf1 > bf0 else 0.0
            first_rms = float(np.mean(bass_rms_frames[bf0:bfm])) if bfm > bf0 else 0.0

            if b_vec is not None and win_rms >= 0.25 * bass_med_rms:
                b_sorted = np.sort(b_vec)[::-1]
                top_pc = int(np.argmax(b_vec))
                clarity = float((b_sorted[0] - b_sorted[1]) / max(1e-6, b_sorted[0])) if len(b_sorted) > 1 else 1.0
                rms_ratio = min(1.0, win_rms / max(1e-5, bass_med_rms))
                raw_conf = (0.45 + 0.55 * clarity) * (0.40 + 0.60 * rms_ratio)
                # Check if bass shifts briefly within a single beat (passing bass)
                is_passing = False
                if b_first is not None and b_second is not None:
                    p1 = int(np.argmax(b_first))
                    p2 = int(np.argmax(b_second))
                    if p1 != p2 and b_first[p1] > 0.22 and b_second[p2] > 0.22:
                        is_passing = True
                        raw_conf *= 0.72
                feats[idx].bass_pc = top_pc
                feats[idx].bass_confidence = round(min(bass_conf_cap, max(0.0, raw_conf)), 4)
                feats[idx].bass_is_passing = is_passing
                feats[idx].bass_onset_attack = bool(
                    win_rms >= 0.45 * bass_med_rms and (idx == 0 or first_rms > prev_tail_rms * 1.12 or first_rms >= 0.7 * bass_med_rms)
                )
                feats[idx].bass_source = bass_source
            prev_tail_rms = float(np.mean(bass_rms_frames[bfm:bf1])) if bf1 > bfm else win_rms

    return feats


# ---------------------------------------------------------------------------
# Metrical weights & Circle-of-Fifths Viterbi transition model
# ---------------------------------------------------------------------------

def beat_strength_in_meter(beat_in_bar: int, beats_per_bar: int, time_signature: str) -> float:
    """Return metrical harmonic weight in `[0.30, 1.0]` for 0-indexed beat in bar."""
    if beat_in_bar == 0:
        return 1.0
    if beats_per_bar == 4 or time_signature.strip() == "4/4":
        return 0.78 if beat_in_bar == 2 else 0.36
    if beats_per_bar == 6 or time_signature.strip() == "6/8":
        return 0.78 if beat_in_bar == 3 else 0.34
    if beats_per_bar == 3:
        return 0.42 if beat_in_bar == 1 else 0.36
    return 0.42


def _theory_transition_bonus(
    prev_c: ChordCandidate,
    cur_c: ChordCandidate,
    *,
    local_tonic_pc: int,
    local_is_minor: bool,
    diatonic_pcs: set[int],
) -> float:
    """Reward Circle-of-Fifths motion, secondary dominants, borrowed chords & bass voice-leading."""
    bonus = 0.0
    pr = prev_c.root_pc
    cr = cur_c.root_pc
    diff = (cr - pr) % 12  # interval upward in semitones

    # 1. Circle of Fifths root motion (down a 5th = +5 mod 12; up a 5th = +7 mod 12)
    if diff == 5:
        bonus += 0.075
        if prev_c.quality in ("dominant-seventh", "major"):
            # True V -> I / V7 -> i / V/X -> X resolution
            bonus += 0.030
            if {cr} <= diatonic_pcs:
                # Secondary dominant (e.g. D7 -> G in C, E7 -> Am in C) earns extra plausibility
                bonus += 0.035
    elif diff == 7:
        bonus += 0.040
    elif diff in (2, 10):  # Stepwise chord motion (IV -> V, V -> IV, bVI -> bVII -> I)
        bonus += 0.040
    elif diff in (3, 9, 4, 8):  # Mediant / relative major-minor (I <-> vi, IV <-> ii, V -> vi)
        bonus += 0.030
    elif diff == 11:  # Leading/chromatic step down (e.g. Imaj7 -> viim7 or IV -> iii)
        bonus += 0.020

    # 2. Stepwise bass voice-leading (e.g. C -> G/B -> Am, or A -> E/G# -> F#m)
    bass_step = min((cur_c.bass_pc - prev_c.bass_pc) % 12, (prev_c.bass_pc - cur_c.bass_pc) % 12)
    if cur_c.bass_pc != prev_c.bass_pc and bass_step in (1, 2):
        bonus += 0.050
        if cur_c.is_slash or prev_c.is_slash:
            bonus += 0.035

    # 3. Tonic cadence arrival bonus (V -> I / iv -> I / bVII -> I)
    if cr == local_tonic_pc and cur_c.quality in ("major", "minor", "major-seventh", "minor-seventh", "major-add9"):
        p_deg = (pr - local_tonic_pc) % 12
        if p_deg == 7:  # Dominant -> Tonic
            bonus += 0.045
        elif p_deg in (5, 10):  # Plagal (IV/iv -> I) or bVII -> I backdoor/modal cadence
            bonus += 0.030

    # 4. Discourage abrupt distant tritone root jumps unless audio evidence overwhelmingly demands it
    if diff == 6 and not (cur_c.bass_pc != prev_c.bass_pc and bass_step in (1, 2)):
        bonus -= 0.035

    return bonus


def _candidate_theory_prior(
    cand: ChordCandidate,
    *,
    local_tonic_pc: int,
    local_is_minor: bool,
    diatonic_pcs: set[int],
) -> float:
    """Gentle tonal context bias (secondary dominants & modal interchange are NOT suppressed)."""
    deg = (cand.root_pc - local_tonic_pc) % 12
    triad_pcs = {cand.root_pc, (cand.root_pc + (3 if cand.quality.startswith("minor") or "dim" in cand.quality else 4)) % 12, (cand.root_pc + 7) % 12}
    in_key_ratio = len(cand.chord_pcs & diatonic_pcs) / float(max(1, len(cand.chord_pcs)))

    prior = 0.0
    if in_key_ratio >= 0.99:
        prior += 0.055
        if cand.root_pc == local_tonic_pc:
            prior += 0.015
    else:
        # Check secondary dominants in major/minor (V/ii, V/iii, V/IV, V/V, V/vi)
        resolved_target = (cand.root_pc + 5) % 12
        if cand.quality in ("major", "dominant-seventh") and resolved_target in diatonic_pcs:
            prior += 0.025
        # Check common borrowed chords (iv, bVI, bVII, bIII, ii° in major; IV, bII in minor)
        elif (not local_is_minor and deg in (5, 8, 10, 3, 2)) or (local_is_minor and deg in (5, 1, 7)):
            prior += 0.020
        elif triad_pcs & diatonic_pcs:
            prior -= 0.010
        else:
            prior -= 0.030

    # Critical safeguard: strong audio/note match must never be overridden by tonal priors
    if cand.coverage >= 0.85:
        prior = max(0.0, prior)
    return prior


# ---------------------------------------------------------------------------
# Beat-window candidate generation & progression decoding
# ---------------------------------------------------------------------------

def _score_window_candidates(
    *,
    pc_weights: dict[int, float],
    sym_bass_pc: int | None,
    sym_lowest_midi: int | None,
    sym_bass_sustained: bool,
    audio_feat: BeatAudioFeature | None,
    key_obj: music21.key.Key,
    cfg: Any,
    infer_dyad_fn: Any,
) -> tuple[list[ChordCandidate], bool]:
    """Combine symbolic note evidence, audio chroma, and Demucs/fallback bass evidence."""
    sym_total = sum(pc_weights.values())
    has_sym = sym_total >= cfg.min_window_total_weight * 0.5
    has_audio = audio_feat is not None and audio_feat.chroma is not None

    if not has_sym and not has_audio:
        return [], False

    # Fuse normalized pitch-class evidence vector
    merged_pc: dict[int, float] = {}
    if has_sym and has_audio and audio_feat is not None and audio_feat.chroma is not None:
        sym_norm = {pc: w / sym_total for pc, w in pc_weights.items()}
        alpha = 0.65 if sym_total >= cfg.min_window_total_weight else 0.35
        for pc in range(12):
            val = alpha * sym_norm.get(pc, 0.0) + (1.0 - alpha) * float(audio_feat.chroma[pc])
            if val > 0.005:
                merged_pc[pc] = val * max(sym_total, 1.0)
    elif has_sym:
        merged_pc = dict(pc_weights)
    elif has_audio and audio_feat is not None and audio_feat.chroma is not None:
        for pc in range(12):
            if float(audio_feat.chroma[pc]) > 0.01:
                merged_pc[pc] = float(audio_feat.chroma[pc]) * 2.0

    total_w = sum(merged_pc.values())
    if total_w <= 1e-6:
        return [], False

    # Resolve authoritative bass evidence: Demucs bass stem (if confident & non-passing) blends cleanly with symbolic bass
    eff_bass_pc: int | None = sym_bass_pc
    eff_bass_conf = 0.85 if (sym_bass_pc is not None and sym_bass_sustained) else (0.55 if sym_bass_pc is not None else 0.0)
    bass_is_passing = False

    if audio_feat is not None and audio_feat.bass_pc is not None and audio_feat.bass_confidence > 0.0:
        if audio_feat.bass_source == "demucs_bass" and not audio_feat.bass_is_passing and audio_feat.bass_confidence >= 0.52:
            eff_bass_pc = audio_feat.bass_pc
            eff_bass_conf = audio_feat.bass_confidence
            sym_bass_sustained = sym_bass_sustained or (audio_feat.bass_confidence >= 0.62)
        elif sym_bass_pc is None:
            eff_bass_pc = audio_feat.bass_pc
            eff_bass_conf = audio_feat.bass_confidence
            sym_bass_sustained = sym_bass_sustained or (audio_feat.bass_confidence >= 0.60 and not audio_feat.bass_is_passing)
        elif audio_feat.bass_pc == sym_bass_pc:
            eff_bass_conf = min(1.0, max(eff_bass_conf, audio_feat.bass_confidence) + 0.12)
        bass_is_passing = audio_feat.bass_is_passing

    max_w = max(merged_pc.values())
    active_pcs = [pc for pc, w in merged_pc.items() if w >= cfg.min_pc_weight_ratio * max_w]
    if len(active_pcs) < 2:
        return [], False

    key_pcs = {int(p.pitchClass) for p in key_obj.pitches}
    ranked_pcs = sorted(((pc, merged_pc[pc]) for pc in active_pcs), key=lambda x: -x[1])

    # Single-stem / sparse 2-PC dyad path (keeps passing melody fragments suppressed)
    if len(active_pcs) < cfg.min_distinct_pcs and not has_audio:
        dyad = infer_dyad_fn(
            ranked_pcs=ranked_pcs[:2],
            pc_weights=merged_pc,
            bass_pc=eff_bass_pc,
            bass_is_sustained=sym_bass_sustained,
            key_pcs=key_pcs,
            key_obj=key_obj,
            cfg=cfg,
        )
        if dyad is None:
            return [], False
        sym, r_name, q_name, conf = dyad
        r_pc = eff_bass_pc if eff_bass_pc is not None else ranked_pcs[0][0]
        _, parsed_bass, chord_pcs = parse_chord_pcs(sym, r_name, q_name)
        return [
            ChordCandidate(
                symbol=normalize_chord_symbol(sym),
                root_name=r_name,
                quality=q_name,
                confidence=conf,
                root_pc=r_pc,
                bass_pc=parsed_bass if parsed_bass is not None else r_pc,
                chord_pcs=frozenset(chord_pcs),
                coverage=min(1.0, conf),
                is_slash="/" in sym,
                is_sus="sus" in sym.lower(),
            )
        ], False

    allow_bass_slash = bool(
        cfg.allow_slash_chords
        and eff_bass_pc is not None
        and not bass_is_passing
        and eff_bass_conf >= 0.50
        and (
            (sym_lowest_midi is not None and (sym_lowest_midi < 60 or sym_bass_sustained))
            or (audio_feat is not None and audio_feat.bass_confidence >= 0.55)
        )
        and (
            merged_pc.get(eff_bass_pc, 0.0) >= cfg.min_bass_weight_ratio * total_w
            or (audio_feat is not None and audio_feat.bass_source == "demucs_bass" and audio_feat.bass_confidence >= 0.58)
        )
    )

    candidates: list[ChordCandidate] = []
    for root_pc in range(12):
        root_w = merged_pc.get(root_pc, 0.0)
        if root_w < 0.08 * total_w and eff_bass_pc != root_pc:
            continue

        for suffix, quality_name, req_ints, opt_ints, prior in CHORD_TEMPLATES:
            req_pcs = {root_pc} | {(root_pc + iv) % 12 for iv in req_ints}
            opt_pcs = {(root_pc + iv) % 12 for iv in opt_ints}
            all_template_pcs = req_pcs | opt_pcs

            if not all(merged_pc.get(pc, 0.0) >= 0.08 * total_w for pc in req_pcs):
                continue

            # Add9/madd9 require meaningful 9th presence so accidental passing 2nds don't trigger add9
            if suffix in ("add9", "madd9") and merged_pc.get((root_pc + 2) % 12, 0.0) < 0.14 * total_w:
                continue

            matched_w = sum(merged_pc.get(pc, 0.0) for pc in all_template_pcs)
            extra_w = max(0.0, total_w - matched_w)
            coverage = matched_w / total_w
            if coverage < 0.66:
                continue

            # Bass weighting: reward root match, support true inversions / slash chords, penalize conflicting bass
            bass_bonus = 0.0
            slash_suffix = ""
            eff_cand_bass = root_pc
            if eff_bass_pc is not None and eff_bass_conf > 0.0:
                if eff_bass_pc == root_pc:
                    bass_bonus = 0.15 * eff_bass_conf
                else:
                    bass_iv = (eff_bass_pc - root_pc) % 12
                    if bass_iv in req_ints or bass_iv in opt_ints:
                        # Valid inversion (3rd, 5th, 7th in bass):
                        # Only emit slash chord if bass weight / stem evidence genuinely supports an inversion
                        if allow_bass_slash and bass_iv in (3, 4, 7, 10, 11):
                            bass_bonus = 0.085 * eff_bass_conf
                            slash_suffix = f"/{_pc_name(eff_bass_pc, key_obj)}"
                            eff_cand_bass = eff_bass_pc
                        else:
                            bass_bonus = 0.03 * eff_bass_conf
                    else:
                        bass_bonus = -0.14 * eff_bass_conf

            if key_pcs:
                diatonic_frac = len(req_pcs & key_pcs) / float(len(req_pcs))
                diatonic_bonus = 0.06 * diatonic_frac if diatonic_frac >= 0.99 else 0.015 * diatonic_frac
            else:
                diatonic_bonus = 0.0

            omitted_opt_penalty = (
                0.02
                if (opt_pcs and not any(merged_pc.get(pc, 0.0) >= 0.08 * total_w for pc in opt_pcs))
                else 0.0
            )
            four_note_bonus = (
                0.055
                if (
                    len(all_template_pcs) >= 4
                    and len(req_pcs) + len([p for p in opt_pcs if merged_pc.get(p, 0.0) >= 0.10 * total_w]) >= 4
                )
                else 0.0
            )

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
            symbol = normalize_chord_symbol(f"{root_name}{suffix}{slash_suffix}")
            candidates.append(
                ChordCandidate(
                    symbol=symbol,
                    root_name=root_name,
                    quality=quality_name,
                    confidence=conf,
                    root_pc=root_pc,
                    bass_pc=eff_cand_bass,
                    chord_pcs=frozenset(all_template_pcs | ({eff_cand_bass} if slash_suffix else set())),
                    coverage=round(coverage, 4),
                    is_slash=bool(slash_suffix),
                    is_sus="sus" in quality_name or "sus" in suffix,
                )
            )

    best_by_sym: dict[str, ChordCandidate] = {}
    for cand in candidates:
        prev = best_by_sym.get(cand.symbol)
        if prev is None or cand.confidence > prev.confidence:
            best_by_sym[cand.symbol] = cand
    ordered = sorted(best_by_sym.values(), key=lambda c: (-c.confidence, c.is_slash, len(c.symbol)))
    return ordered[:8], bass_is_passing


def detect_chords_music_theory(
    notes: list[ScoreNote],
    tempo_bpm: float,
    time_signature: str,
    key_signature: str = "C major",
    timing_map: Any = None,
    config: Any = None,
    *,
    audio_path: Path | None = None,
    bass_stem_path: Path | None = None,
    harmonic_stem_path: Path | None = None,
    bass_notes: list[Any] | None = None,
    diagnostics_out: dict[str, Any] | None = None,
) -> list[ScoreChord]:
    """Identify rhythm-locked, bass-aware, Circle-of-Fifths chord progressions."""
    from app.notation.analyzer import ChordDetectionConfig, _analyze_window_chord, _infer_dyad_chord

    if not notes and audio_path is None and bass_stem_path is None and harmonic_stem_path is None:
        return []

    cfg = config or ChordDetectionConfig()
    try:
        num = max(1, int(time_signature.split("/")[0]))
    except Exception:
        num = 4

    sec_per_beat = 60.0 / max(20.0, tempo_bpm)
    key_obj = parse_key_signature(key_signature)
    global_tonic_pc = int(key_obj.tonic.pitchClass)
    global_is_minor = key_obj.mode == "minor"
    key_diatonic_pcs = _diatonic_pcs(global_tonic_pc, global_is_minor)
    pickup_ql = float(getattr(timing_map, "pickup_ql", 0.0) or 0.0) if timing_map is not None else 0.0

    def _to_ql_raw(sec: float) -> float:
        if timing_map is not None:
            return max(0.0, float(timing_map.seconds_to_ql(sec)))
        return max(0.0, sec / sec_per_beat)

    def _to_audio_sec(ql: float) -> float:
        if timing_map is not None:
            return max(0.0, float(timing_map.ql_to_seconds(ql)))
        return max(0.0, ql * sec_per_beat)

    def _note_ql_span(n: ScoreNote) -> tuple[float, float, bool]:
        raw_on = getattr(n, "raw_onset_sec", None)
        raw_off = getattr(n, "raw_offset_sec", None)
        if raw_on is not None and raw_off is not None:
            on_ql = _to_ql_raw(float(raw_on))
            off_ql = max(on_ql + 0.125, _to_ql_raw(float(raw_off)))
            is_sub = (float(raw_off) - float(raw_on)) >= cfg.min_note_duration_sec
            return on_ql, off_ql, is_sub
        on_ql = _to_ql_raw(float(n.onset_sec))
        off_ql = max(on_ql + 0.125, _to_ql_raw(float(n.offset_sec)))
        is_sub = (float(n.offset_sec) - float(n.onset_sec)) >= cfg.min_note_duration_sec
        return on_ql, off_ql, is_sub

    note_qls = [(n, *_note_ql_span(n)) for n in notes]
    bass_note_qls = [
        (
            n,
            _to_ql_raw(float(getattr(n, "raw_onset_sec", None) if getattr(n, "raw_onset_sec", None) is not None else n.onset_sec)),
            max(
                _to_ql_raw(float(getattr(n, "raw_onset_sec", None) if getattr(n, "raw_onset_sec", None) is not None else n.onset_sec)) + 0.125,
                _to_ql_raw(float(getattr(n, "raw_offset_sec", None) if getattr(n, "raw_offset_sec", None) is not None else n.offset_sec)),
            ),
        )
        for n in (bass_notes or [])
        if (n.offset_sec - n.onset_sec) >= cfg.min_note_duration_sec * 0.75
    ]

    audio_duration_ql = 0.0
    for stem_cand in (harmonic_stem_path, audio_path, bass_stem_path):
        if stem_cand is not None and Path(stem_cand).exists():
            try:
                dur_s = float(sf.info(str(stem_cand)).duration)
                audio_duration_ql = max(audio_duration_ql, _to_ql_raw(dur_s))
            except Exception:
                pass

    span_ends = [
        *(off_ql for _, _, off_ql, _ in note_qls),
        *(off_ql for _, _, off_ql in bass_note_qls),
    ]
    if audio_duration_ql > 0.0:
        span_ends.append(audio_duration_ql)
    max_ql = max(span_ends, default=float(num))
    if max_ql <= pickup_ql + 0.5:
        total_measure_beats = max(1, int(np.ceil(max_ql)))
        win_starts_ql = [float(b) for b in range(total_measure_beats)]
        win_ends_ql = [float(b + 1) for b in range(total_measure_beats)]
        grid_origin_ql = 0.0
    else:
        total_post_pickup = max(1, int(np.ceil(max_ql - pickup_ql)))
        win_starts_ql = []
        win_ends_ql = []
        if pickup_ql >= 0.75:
            win_starts_ql.append(0.0)
            win_ends_ql.append(pickup_ql)
        for b in range(total_post_pickup):
            win_starts_ql.append(pickup_ql + float(b))
            win_ends_ql.append(pickup_ql + float(b + 1))
        grid_origin_ql = pickup_ql

    def _collect_weights(
        w_start_ql: float,
        w_end_ql: float,
        *,
        local_tonic_pcs: set[int] | None = None,
    ) -> tuple[dict[int, float], int | None, bool, bool]:
        eff_key_pcs = local_tonic_pcs or key_diatonic_pcs
        active = [
            (n, min(off_ql, w_end_ql) - max(on_ql, w_start_ql), on_ql, is_sub)
            for n, on_ql, off_ql, is_sub in note_qls
            if min(off_ql, w_end_ql) - max(on_ql, w_start_ql) > 0.05
        ]
        # Supplement with dedicated bass_notes if provided separately (e.g. Lead Melody / Piano+Vocal)
        extra_bass = [
            (n, min(off_ql, w_end_ql) - max(on_ql, w_start_ql), on_ql, True)
            for n, on_ql, off_ql in bass_note_qls
            if min(off_ql, w_end_ql) - max(on_ql, w_start_ql) > 0.05
        ]
        combined_active = active + extra_bass
        if not combined_active:
            return {}, None, False, False

        substantive = [(n, ov, on_ql) for n, ov, on_ql, is_sub in combined_active if is_sub]
        chosen = substantive if substantive else [(n, ov, on_ql) for n, ov, on_ql, _ in combined_active]
        pc_weights: dict[int, float] = {}
        lowest_midi: int | None = None
        lowest_ov = 0.0
        has_new_bass_attack = False

        for n, ov, on_ql in chosen:
            conf_factor = float(n.confidence) if n.confidence is not None else 0.75
            bass_factor = 1.40 if n.pitch_midi < 60 else 1.0
            sustain_factor = 1.15 if ov >= 0.70 else 1.0
            # Penalize short weak-subdivision passing/neighbor tones (8th/16th runs)
            sub_frac = on_ql - np.floor(on_ql)
            is_passing_short = ov < 0.42 and (0.12 <= sub_frac <= 0.88)
            passing_factor = 0.55 if is_passing_short else 1.0
            pc = int(n.pitch_midi) % 12
            key_factor = cfg.key_diatonic_weight_boost if pc in eff_key_pcs else 1.0
            w = (
                ov
                * (max(1, int(getattr(n, "velocity", 80))) / 127.0)
                * max(0.25, conf_factor)
                * bass_factor
                * sustain_factor
                * passing_factor
                * key_factor
            )
            pc_weights[pc] = pc_weights.get(pc, 0.0) + w
            # Only treat sustained or strong-attack low notes as authoritative chord bass candidates
            if (ov >= 0.35 or not is_passing_short) and (lowest_midi is None or n.pitch_midi < lowest_midi):
                lowest_midi = int(n.pitch_midi)
                lowest_ov = ov
            elif lowest_midi is None:
                lowest_midi = int(n.pitch_midi)
                lowest_ov = ov

            if int(n.pitch_midi) < 58 and (w_start_ql - 0.12) <= on_ql <= (w_start_ql + 0.35):
                has_new_bass_attack = True

        if sum(pc_weights.values()) < cfg.min_window_total_weight:
            return {}, None, False, has_new_bass_attack
        return pc_weights, lowest_midi, lowest_ov >= 0.42, has_new_bass_attack

    # 1. Audio features aligned strictly to rhythmic beat spans
    win_spans_sec = [(_to_audio_sec(s), _to_audio_sec(e)) for s, e in zip(win_starts_ql, win_ends_ql, strict=True)]
    audio_feats = extract_beat_audio_features(
        win_spans_sec,
        audio_path=audio_path,
        bass_stem_path=bass_stem_path,
        harmonic_stem_path=harmonic_stem_path,
    )

    # 2. First pass window weights -> local key profile estimation
    raw_win_data: list[tuple[dict[int, float], int | None, bool, bool]] = [
        _collect_weights(s_ql, e_ql)
        for s_ql, e_ql in zip(win_starts_ql, win_ends_ql, strict=True)
    ]
    local_vecs: list[np.ndarray] = []
    local_bass_pcs: list[int | None] = []
    for idx, (pc_w, low_m, _, _) in enumerate(raw_win_data):
        v = np.zeros(12, dtype=np.float64)
        for pc, w in pc_w.items():
            v[pc] = w
        if audio_feats[idx].chroma is not None:
            v = v + 0.5 * audio_feats[idx].chroma
        s_v = float(np.sum(v))
        if s_v > 1e-8:
            v = v / s_v
        local_vecs.append(v)
        b_pc = audio_feats[idx].bass_pc if (audio_feats[idx].bass_pc is not None and audio_feats[idx].bass_confidence >= 0.52) else ((low_m % 12) if low_m is not None else None)
        local_bass_pcs.append(b_pc)

    local_keys = _estimate_local_keys(
        local_vecs,
        local_bass_pcs,
        global_tonic_pc,
        global_is_minor,
    )

    # 3. Generate beat-level candidates using fused symbolic + audio + bass + 2-beat metrical smoothing
    beat_cands: list[list[ChordCandidate]] = []
    beat_has_bass_attack: list[bool] = []
    for w_idx, (s_ql, _e_ql) in enumerate(zip(win_starts_ql, win_ends_ql, strict=True)):
        pc_w, low_m, low_sust, bass_att = raw_win_data[w_idx]
        af = audio_feats[w_idx]
        sym_bass_pc = (low_m % 12) if low_m is not None else None
        cands, bass_passing = _score_window_candidates(
            pc_weights=pc_w,
            sym_bass_pc=sym_bass_pc,
            sym_lowest_midi=low_m,
            sym_bass_sustained=low_sust,
            audio_feat=af,
            key_obj=key_obj,
            cfg=cfg,
            infer_dyad_fn=_infer_dyad_chord,
        )
        if not cands and pc_w:
            fb = _analyze_window_chord(pc_w, low_m, low_sust, key_obj, cfg)
            if fb is not None:
                norm_sym = normalize_chord_symbol(fb[0])
                r_pc, b_pc, c_pcs = parse_chord_pcs(norm_sym, fb[1], fb[2])
                cands = [
                    ChordCandidate(
                        symbol=norm_sym,
                        root_name=fb[1],
                        quality=fb[2],
                        confidence=fb[3],
                        root_pc=r_pc,
                        bass_pc=b_pc if b_pc is not None else r_pc,
                        chord_pcs=frozenset(c_pcs),
                        coverage=fb[3],
                        is_slash="/" in norm_sym,
                        is_sus="sus" in norm_sym.lower(),
                    )
                ]

        # On strong half-bar boundaries (strictly within the same measure), try 2-beat window when 1-beat window is sparse/ambiguous
        beat_in_bar = int(round(s_ql - grid_origin_ql)) % num if s_ql >= grid_origin_ql - 1e-6 else 0
        if (
            (not cands or cands[0].confidence < 0.70)
            and beat_in_bar % 2 == 0
            and beat_in_bar + 1 < num
            and w_idx + 1 < len(win_starts_ql)
        ):
            pc_w2, low_m2, low_sust2, bass_att2 = _collect_weights(s_ql, win_ends_ql[w_idx + 1])
            af2 = audio_feats[w_idx + 1]
            merged_af: BeatAudioFeature | None = None
            if af.chroma is not None or af2.chroma is not None:
                c1 = af.chroma if af.chroma is not None else np.zeros(12, dtype=np.float64)
                c2 = af2.chroma if af2.chroma is not None else np.zeros(12, dtype=np.float64)
                c_sum = c1 + c2
                cs = float(np.sum(c_sum))
                merged_af = BeatAudioFeature(
                    chroma=(c_sum / cs) if cs > 1e-8 else None,
                    bass_pc=af.bass_pc if af.bass_confidence >= af2.bass_confidence else af2.bass_pc,
                    bass_confidence=max(af.bass_confidence, af2.bass_confidence),
                    bass_is_passing=af.bass_is_passing and af2.bass_is_passing,
                    bass_onset_attack=af.bass_onset_attack or af2.bass_onset_attack,
                    bass_source=af.bass_source if af.bass_source != "none" else af2.bass_source,
                )
            cands2, _ = _score_window_candidates(
                pc_weights=pc_w2,
                sym_bass_pc=(low_m2 % 12) if low_m2 is not None else None,
                sym_lowest_midi=low_m2,
                sym_bass_sustained=low_sust2,
                audio_feat=merged_af,
                key_obj=key_obj,
                cfg=cfg,
                infer_dyad_fn=_infer_dyad_chord,
            )
            if cands2 and (not cands or cands2[0].confidence > cands[0].confidence + 0.03):
                cands = cands2
                bass_att = bass_att or bass_att2

        beat_cands.append(cands)
        beat_has_bass_attack.append(bass_att or af.bass_onset_attack)

    active_windows = [w for w, c in enumerate(beat_cands) if c]
    if not active_windows:
        return []

    # 4. Viterbi HMM sequence decoding with metrical strength + Circle of Fifths + local key context
    first_w = active_windows[0]
    first_cands = beat_cands[first_w]
    lk0_tonic, lk0_minor = local_keys[first_w] if first_w < len(local_keys) else (global_tonic_pc, global_is_minor)
    lk0_pcs = _diatonic_pcs(lk0_tonic, lk0_minor)

    dp: dict[int, tuple[float, int | None, int]] = {
        i: (
            c.confidence + _candidate_theory_prior(c, local_tonic_pc=lk0_tonic, local_is_minor=lk0_minor, diatonic_pcs=lk0_pcs),
            None,
            1,
        )
        for i, c in enumerate(first_cands)
    }
    backpointers: list[dict[int, int]] = [{i: -1 for i in range(len(first_cands))}]
    paths: list[tuple[int, list[ChordCandidate]]] = [(first_w, first_cands)]

    for w_idx in active_windows[1:]:
        cur_cands = beat_cands[w_idx]
        prev_w, prev_cands = paths[-1]
        s_ql = win_starts_ql[w_idx]
        beat_in_bar = (
            max(0, int(round(s_ql - grid_origin_ql))) % num
            if s_ql >= grid_origin_ql - 1e-6
            else 0
        )
        strength = beat_strength_in_meter(beat_in_bar, num, time_signature)
        gap_beats = max(1.0, win_starts_ql[w_idx] - win_starts_ql[prev_w])
        new_bass = beat_has_bass_attack[w_idx]
        is_strong_beat = strength >= 0.70

        lk_tonic, lk_minor = local_keys[w_idx] if w_idx < len(local_keys) else (global_tonic_pc, global_is_minor)
        lk_pcs = _diatonic_pcs(lk_tonic, lk_minor)

        if gap_beats > 1.5:
            base_change_pen = 0.04
        elif beat_in_bar == 0:
            base_change_pen = 0.045
        elif is_strong_beat:
            base_change_pen = 0.07 if new_bass else 0.115
        else:
            # Weak beats resist harmonic changes unless bass & harmony cleanly move together
            base_change_pen = 0.14 if new_bass else 0.25

        new_dp: dict[int, tuple[float, int | None, int]] = {}
        bp: dict[int, int] = {}
        for j, cur_c in enumerate(cur_cands):
            cur_emission = cur_c.confidence + _candidate_theory_prior(
                cur_c,
                local_tonic_pc=lk_tonic,
                local_is_minor=lk_minor,
                diatonic_pcs=lk_pcs,
            )
            best_score = -1e9
            best_prev = 0
            best_run = 1
            for i, prev_c in enumerate(prev_cands):
                prev_score, _, prev_run = dp[i]
                if cur_c.symbol == prev_c.symbol:
                    pen = -0.025  # hold sustained chord cleanly
                    run_len = prev_run + 1
                elif cur_c.root_pc == prev_c.root_pc and cur_c.is_sus and not prev_c.is_sus:
                    pen = base_change_pen + 0.13
                    run_len = 1
                else:
                    theory_bonus = _theory_transition_bonus(
                        prev_c,
                        cur_c,
                        local_tonic_pc=lk_tonic,
                        local_is_minor=lk_minor,
                        diatonic_pcs=lk_pcs,
                    )
                    short_chatter_pen = 0.09 if (prev_run == 1 and not is_strong_beat and gap_beats <= 1.2) else 0.0
                    # Stronger protection when previous chord hasn't completed 2 beats and no bass change occurred
                    no_bass_weak_pen = 0.05 if (not is_strong_beat and not new_bass) else 0.0
                    pen = base_change_pen + short_chatter_pen + no_bass_weak_pen - theory_bonus
                    run_len = 1
                cand_score = prev_score + cur_emission - pen
                if cand_score > best_score:
                    best_score = cand_score
                    best_prev = i
                    best_run = run_len
            new_dp[j] = (best_score, best_prev, best_run)
            bp[j] = best_prev
        dp = new_dp
        backpointers.append(bp)
        paths.append((w_idx, cur_cands))

    # Backtrack optimal progression
    last_idx = max(dp.keys(), key=lambda idx: dp[idx][0])
    chosen_indices = [0] * len(paths)
    cur_idx = last_idx
    for k in range(len(paths) - 1, -1, -1):
        chosen_indices[k] = cur_idx
        cur_idx = backpointers[k][cur_idx] if k > 0 else -1

    chosen_seq: list[tuple[int, ChordCandidate]] = [
        (w_idx, cands[idx])
        for (w_idx, cands), idx in zip(paths, chosen_indices, strict=True)
    ]

    # 5. Post-decode suppression of 1-beat A -> B -> A passing blips and sus embellishments
    filtered: list[tuple[int, ChordCandidate]] = []
    for idx, (w_idx, cand) in enumerate(chosen_seq):
        prev_cand = chosen_seq[idx - 1][1] if idx > 0 else None
        next_cand = chosen_seq[idx + 1][1] if idx + 1 < len(chosen_seq) else None
        if prev_cand and next_cand and prev_cand.symbol == next_cand.symbol and cand.symbol != prev_cand.symbol:
            if cand.confidence < cfg.strong_short_change_confidence or (
                cand.root_pc == prev_cand.root_pc and cand.is_sus
            ):
                continue
        if prev_cand and cand.root_pc == prev_cand.root_pc and cand.is_sus and not prev_cand.is_sus:
            if next_cand is None or (next_cand.root_pc == cand.root_pc and not next_cand.is_sus):
                continue
        filtered.append((w_idx, cand))

    # 6. Collapse repeats & detect genuine syncopated anticipations (off-beat harmonic changes)
    collapsed: list[tuple[float, ChordCandidate]] = []
    last_sym: str | None = None
    last_ql: float | None = None
    syncopated_count = 0

    for w_idx, cand in filtered:
        onset_ql = win_starts_ql[w_idx]
        if cand.symbol == last_sym:
            continue
        if last_ql is not None and (onset_ql - last_ql) < cfg.min_label_spacing_beats:
            continue

        # Check whether the change genuinely occurs on an off-beat half-beat:
        # Case A: second half of current beat [onset_ql + 0.5, onset_ql + 1.0) starts new chord cleanly
        # Case B: anticipated into second half of previous beat [onset_ql - 0.5, onset_ql)
        if collapsed and (win_ends_ql[w_idx] - onset_ql) >= 0.9:
            prev_cand = collapsed[-1][1]
            shifted = False

            cur_mid_ql = onset_ql + 0.5
            cur_first_w, _, _, _ = _collect_weights(onset_ql, cur_mid_ql)
            cur_sec_w, _, _, cur_sec_att = _collect_weights(cur_mid_ql, win_ends_ql[w_idx])
            cf_tot = sum(cur_first_w.values())
            cs_tot = sum(cur_sec_w.values())
            if cf_tot >= cfg.min_window_total_weight * 0.35 and cs_tot >= cfg.min_window_total_weight * 0.40:
                prev_cov_1 = sum(cur_first_w.get(pc, 0.0) for pc in prev_cand.chord_pcs) / max(1e-6, cf_tot)
                next_cov_1 = sum(cur_first_w.get(pc, 0.0) for pc in cand.chord_pcs) / max(1e-6, cf_tot)
                next_cov_2 = sum(cur_sec_w.get(pc, 0.0) for pc in cand.chord_pcs) / max(1e-6, cs_tot)
                prev_cov_2 = sum(cur_sec_w.get(pc, 0.0) for pc in prev_cand.chord_pcs) / max(1e-6, cs_tot)
                if prev_cov_1 >= 0.72 and next_cov_1 <= 0.58 and next_cov_2 >= 0.78 and prev_cov_2 <= 0.55 and (cur_sec_att or next_cov_2 >= 0.84):
                    onset_ql = cur_mid_ql
                    syncopated_count += 1
                    shifted = True

            if not shifted and w_idx > 0 and onset_ql - win_starts_ql[w_idx - 1] >= 0.9 and onset_ql > grid_origin_ql + 0.5:
                half_mid_ql = 0.5 * (win_starts_ql[w_idx - 1] + onset_ql)
                first_half_w, _, _, _ = _collect_weights(win_starts_ql[w_idx - 1], half_mid_ql)
                sec_half_w, _, _, sec_att = _collect_weights(half_mid_ql, onset_ql)

                af_prev = audio_feats[w_idx - 1]
                sec_total = sum(sec_half_w.values())
                first_total = sum(first_half_w.values())
                if sec_total >= cfg.min_window_total_weight * 0.45 and first_total >= cfg.min_window_total_weight * 0.40:
                    next_cov_sec = sum(sec_half_w.get(pc, 0.0) for pc in cand.chord_pcs) / max(1e-6, sec_total)
                    prev_cov_sec = sum(sec_half_w.get(pc, 0.0) for pc in prev_cand.chord_pcs) / max(1e-6, sec_total)
                    prev_cov_first = sum(first_half_w.get(pc, 0.0) for pc in prev_cand.chord_pcs) / max(1e-6, first_total)
                    if (
                        (sec_att or next_cov_sec >= 0.85)
                        and next_cov_sec >= 0.78
                        and prev_cov_sec <= 0.55
                        and prev_cov_first >= 0.70
                        and (half_mid_ql - collapsed[-1][0]) >= max(0.5, cfg.min_label_spacing_beats * 0.5)
                    ):
                        onset_ql = half_mid_ql
                        syncopated_count += 1
                elif af_prev.first_half_chroma is not None and af_prev.second_half_chroma is not None:
                    next_a2 = sum(float(af_prev.second_half_chroma[pc]) for pc in cand.chord_pcs)
                    prev_a2 = sum(float(af_prev.second_half_chroma[pc]) for pc in prev_cand.chord_pcs)
                    prev_a1 = sum(float(af_prev.first_half_chroma[pc]) for pc in prev_cand.chord_pcs)
                    if next_a2 >= 0.74 and prev_a2 <= 0.52 and prev_a1 >= 0.65:
                        onset_ql = half_mid_ql
                        syncopated_count += 1

        last_sym = cand.symbol
        last_ql = onset_ql
        collapsed.append((onset_ql, cand))

    # 7. Map decoded onset_ql to measure / beat (respecting pickup_ql!)
    chords: list[ScoreChord] = []
    for onset_ql, cand in collapsed:
        if onset_ql < grid_origin_ql - 1e-4:
            measure = 1
            beat = 1.0
        else:
            rel_ql = max(0.0, onset_ql - grid_origin_ql)
            measure = int(rel_ql // num) + 1
            beat = round((rel_ql % num) + 1.0, 2)
        score_onset_sec = onset_ql * sec_per_beat if timing_map is not None else _to_audio_sec(onset_ql)
        chords.append(
            ScoreChord(
                id=uuid.uuid4().hex[:10],
                measure=max(1, measure),
                beat=max(1.0, beat),
                onset_sec=round(score_onset_sec, 3),
                symbol=cand.symbol,
                root=cand.root_name,
                quality=cand.quality,
                confidence=round(float(cand.confidence), 3),
            )
        )

    if diagnostics_out is not None:
        bass_sources = {af.bass_source for af in audio_feats if af.bass_source != "none"}
        diagnostics_out.update(
            {
                "engine": "harmonic_engine_v2",
                "chord_count": len(chords),
                "slash_chords": sum(1 for c in chords if "/" in c.symbol),
                "syncopated_changes": syncopated_count,
                "audio_chroma_used": any(af.chroma is not None for af in audio_feats),
                "bass_sources": sorted(bass_sources) if bass_sources else ["symbolic_only"],
                "local_key_count": len(set(local_keys)),
            }
        )
    return chords
