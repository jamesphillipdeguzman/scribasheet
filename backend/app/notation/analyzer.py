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


def _analyze_window_chord(
    pc_weights: dict[int, float],
    lowest_midi: int | None,
    bass_is_sustained: bool,
    key_obj: music21.key.Key,
    cfg: ChordDetectionConfig,
) -> tuple[str, str, str, float] | None:
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
    if len(filtered_pcs) < cfg.min_distinct_pcs:
        return None

    bass_pc = (lowest_midi % 12) if lowest_midi is not None else None
    include_bass = (
        cfg.allow_slash_chords
        and lowest_midi is not None
        and (lowest_midi < 60 or bass_is_sustained)
        and bass_pc is not None
        and bass_pc in filtered_pcs
        and pc_weights.get(bass_pc, 0.0) >= cfg.min_bass_weight_ratio * total_w
    )

    core_pcs = [pc for pc, _ in ranked_pcs[:3]]
    core_chord = _build_chord_from_pcs(core_pcs, lowest_midi, include_bass, key_obj)
    core_cs = _safe_chord_symbol(core_chord) if core_chord is not None else None

    # Only attempt 4-note chord (7ths) when the 4th pitch class has meaningful weight
    use_four = (
        len(ranked_pcs) >= 4
        and ranked_pcs[3][1] >= cfg.min_extension_weight_ratio * max_w
    )
    ext_chord = _build_chord_from_pcs(filtered_pcs, lowest_midi, include_bass, key_obj) if use_four else None
    ext_cs = _safe_chord_symbol(ext_chord) if ext_chord is not None else None

    # Prefer simpler 3-note label if 4-note label is an awkward 9th/11th/13th extension
    if ext_cs is not None and not _is_complex_extension(ext_cs):
        cs, used_chord = ext_cs, ext_chord
    elif core_cs is not None:
        cs, used_chord = core_cs, core_chord
    elif ext_cs is not None and not _is_complex_extension(ext_cs):
        cs, used_chord = ext_cs, ext_chord
    else:
        return None

    # Avoid spurious slash chords when the bass note is not even a triad/7th tone (e.g. E/F#, E/A)
    if "/" in (cs.figure or "") and bass_pc is not None:
        chord_pcs_no_bass = {p.pitchClass for p in cs.pitches if p.pitchClass != cs.bass().pitchClass}
        if cs.bass().pitchClass == cs.root().pitchClass or len(chord_pcs_no_bass) < 2:
            pass
        else:
            # Verify bass interval from root is a standard inversion (3rd=3/4, 5th=7, 7th=10/11)
            root_pc = cs.root().pitchClass
            bass_interval = (cs.bass().pitchClass - root_pc) % 12
            if bass_interval not in (3, 4, 7, 10, 11):
                root_pos_chord = _build_chord_from_pcs(
                    [p.pitchClass for p in used_chord.pitches], None, False, key_obj
                )
                root_pos_cs = _safe_chord_symbol(root_pos_chord) if root_pos_chord is not None else None
                if root_pos_cs is not None:
                    cs, used_chord = root_pos_cs, root_pos_chord

    symbol, root_name, quality = _format_readable_symbol(cs)
    chord_pcs = {p.pitchClass for p in used_chord.pitches}
    matched_w = sum(pc_weights.get(pc, 0.0) for pc in chord_pcs)
    coverage = matched_w / max(1e-6, total_w)

    diatonic_bonus = 0.0
    try:
        rn = music21.roman.romanNumeralFromChord(used_chord, key_obj)
        if not rn.containsAccidentals():
            diatonic_bonus = 0.08
    except Exception:
        pass

    conf = min(1.0, max(0.0, coverage * 0.88 + diatonic_bonus))
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
    """Identify confidence-aware, key-consistent chord symbols using music21."""
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

    def _collect_weights(w_start_ql: float, w_end_ql: float) -> tuple[dict[int, float], int | None, bool]:
        active = [
            (n, min(off_ql, w_end_ql) - max(on_ql, w_start_ql), is_sub)
            for n, on_ql, off_ql, is_sub in note_qls
            if min(off_ql, w_end_ql) - max(on_ql, w_start_ql) > 0.05
        ]
        if not active:
            return {}, None, False
        substantive = [(n, ov) for n, ov, is_sub in active if is_sub]
        chosen = substantive if substantive else [(n, ov) for n, ov, _ in active]
        pc_weights: dict[int, float] = {}
        lowest_midi: int | None = None
        lowest_ov: float = 0.0
        for n, ov in chosen:
            conf_factor = float(n.confidence) if n.confidence is not None else 0.75
            bass_factor = 1.35 if n.pitch_midi < 60 else 1.0
            sustain_factor = 1.15 if ov >= 0.75 else 1.0
            pc = n.pitch_midi % 12
            key_factor = cfg.key_diatonic_weight_boost if pc in key_diatonic_pcs else 1.0
            w = ov * (max(1, n.velocity) / 127.0) * max(0.25, conf_factor) * bass_factor * sustain_factor * key_factor
            pc_weights[pc] = pc_weights.get(pc, 0.0) + w
            if lowest_midi is None or n.pitch_midi < lowest_midi:
                lowest_midi = n.pitch_midi
                lowest_ov = ov
        if sum(pc_weights.values()) < cfg.min_window_total_weight:
            return {}, None, False
        return pc_weights, lowest_midi, lowest_ov >= 0.45

    # Analyze beat-by-beat, using 2-beat harmonic aggregation when a 1-beat window is ambiguous
    raw_snapshots: list[tuple[int, str, str, str, float]] = []
    for b_idx in range(total_beats):
        pc_w, low_midi, low_sustained = _collect_weights(float(b_idx), float(b_idx + 1))
        match = _analyze_window_chord(pc_w, low_midi, low_sustained, key_obj, cfg)
        if (match is None or match[3] < 0.62) and b_idx % 2 == 0:
            pc_w2, low_midi2, low_sustained2 = _collect_weights(float(b_idx), float(min(total_beats, b_idx + 2)))
            match2 = _analyze_window_chord(pc_w2, low_midi2, low_sustained2, key_obj, cfg)
            if match2 is not None and (match is None or match2[3] > match[3] + 0.03):
                match = match2
        if match is not None:
            raw_snapshots.append((b_idx, *match))

    if not raw_snapshots:
        return []

    # Filter isolated 1-beat passing blips sandwiched between identical chords (A -> B -> A)
    # or brief same-root sus embellishments (e.g. E -> Esus2 -> E)
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
