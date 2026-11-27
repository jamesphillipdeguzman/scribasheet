"""Monophonic lead-melody extraction for ScribaSheet Lead Melody mode."""

from __future__ import annotations

from dataclasses import dataclass, field
from statistics import median
from typing import Any

from app.transcription.base import DetectedNote

LEAD_MELODY_MODE_ALIASES = frozenset({"lead_melody", "melody"})
VIOLIN_SOLO_MODE_ALIASES = frozenset({"violin_solo", "violin_monophonic"})
DEFAULT_VOCAL_RANGE: tuple[int, int] = (55, 79)  # G3 - G5
DEFAULT_VIOLIN_RANGE: tuple[int, int] = (55, 100)  # G3 - E7


def is_lead_melody_mode(mode: str | None) -> bool:
    """Return True when the transcription mode requests Lead Melody extraction."""
    if not mode:
        return False
    return mode.strip().lower() in LEAD_MELODY_MODE_ALIASES


def is_violin_solo_mode(mode: str | None) -> bool:
    """Return True when the transcription mode requests Violin Solo Monophonic tracking."""
    if not mode:
        return False
    return mode.strip().lower() in VIOLIN_SOLO_MODE_ALIASES


def normalize_transcription_mode(mode: str | None, default: str = "piano_arrangement") -> str:
    """Normalize mode aliases while preserving non-melody modes."""
    cleaned = (mode or "").strip().lower()
    if not cleaned:
        return default
    if cleaned in LEAD_MELODY_MODE_ALIASES:
        return "melody"
    if cleaned in VIOLIN_SOLO_MODE_ALIASES:
        return "violin_solo"
    return cleaned


@dataclass
class MelodyExtractionResult:
    """Result of monophonic lead-melody extraction."""

    notes: list[DetectedNote]
    stats: dict[str, Any] = field(default_factory=dict)
    uncertain_segments: list[dict[str, Any]] = field(default_factory=list)


def _cluster_by_onset(
    notes: list[DetectedNote],
    onset_tolerance_sec: float,
) -> list[list[DetectedNote]]:
    """Group nearly simultaneous note onsets into ordered clusters."""
    if not notes:
        return []
    ordered = sorted(notes, key=lambda n: (n.onset_sec, n.pitch_midi))
    clusters: list[list[DetectedNote]] = [[ordered[0]]]
    anchor_onset = ordered[0].onset_sec
    for note in ordered[1:]:
        if note.onset_sec - anchor_onset <= onset_tolerance_sec:
            clusters[-1].append(note)
        else:
            clusters.append([note])
            anchor_onset = note.onset_sec
    return clusters


def _estimate_melody_anchor_pitch(
    clusters: list[list[DetectedNote]],
    vocal_range: tuple[int, int] | None = None,
) -> float:
    """Estimate a soft melodic register center without imposing a hard pitch cutoff."""
    representative_pitches: list[int] = []
    for cluster in clusters:
        pool = cluster
        if vocal_range is not None:
            lo_v, hi_v = vocal_range
            in_range = [n for n in cluster if lo_v - 2 <= n.pitch_midi <= hi_v + 2]
            if in_range:
                pool = in_range
            else:
                # Skip isolated extreme outliers when estimating the vocal register center
                continue
        # Weight toward prominent/upper notes in polyphonic clusters, but include
        # solo notes as-is so low-register melodies keep their true register.
        if len(pool) == 1:
            representative_pitches.append(pool[0].pitch_midi)
        else:
            best = max(
                pool,
                key=lambda n: (
                    n.pitch_midi * 0.08
                    + (n.velocity / 127.0) * 1.2
                    + min(max(n.offset_sec - n.onset_sec, 0.02), 1.5) * 0.8
                ),
            )
            representative_pitches.append(best.pitch_midi)
    if not representative_pitches:
        if vocal_range is not None:
            return float((vocal_range[0] + vocal_range[1]) / 2.0)
        return 64.0
    est = float(median(representative_pitches))
    if vocal_range is not None:
        return max(float(vocal_range[0]), min(float(vocal_range[1]), est))
    return est


def _is_likely_harmonic_overtone(
    note: DetectedNote,
    cluster: list[DetectedNote],
    ringing_notes: list[DetectedNote] | None = None,
) -> bool:
    """Detect harmonic overtone blips (+12/+19/+24/+28/+31/+36) above a strong fundamental."""
    note_dur = max(0.0, note.offset_sec - note.onset_sec)
    candidates = [*cluster, *(ringing_notes or [])]
    for other in candidates:
        if other is note:
            continue
        interval = note.pitch_midi - other.pitch_midi
        if interval not in (12, 19, 24, 28, 31, 36):
            continue
        # Ringing fundamental must overlap the onset of the candidate overtone
        if other not in cluster and not (
            other.onset_sec <= note.onset_sec + 0.04 and other.offset_sec >= note.onset_sec + 0.08
        ):
            continue
        other_dur = max(0.0, other.offset_sec - other.onset_sec)
        stronger_vel = other.velocity >= note.velocity + 12
        stronger_conf = (other.confidence or 0.7) >= (note.confidence or 0.5) + 0.12
        # High compound overtones (+24/+28/+31/+36) above a sustained note are almost always partials
        high_partial = interval >= 24 and note.pitch_midi >= 84 and other.velocity >= note.velocity - 5
        if note.velocity >= 68 and (note.confidence or 0.0) >= 0.65 and not high_partial:
            continue
        if (stronger_vel or stronger_conf or high_partial) and other_dur >= note_dur * 0.75:
            return True
    return False


def _filter_vocal_outliers(
    valid_notes: list[DetectedNote],
    vocal_range: tuple[int, int],
) -> tuple[list[DetectedNote], int]:
    """Filter sub-bass artifacts and unsupported extreme upper-register outliers without clamping."""
    min_midi, max_midi = vocal_range
    ordered = sorted(valid_notes, key=lambda n: (n.onset_sec, n.pitch_midi))
    in_range_notes = [n for n in ordered if min_midi <= n.pitch_midi <= max_midi]

    # If there are no notes near the vocal range at all, only strip obvious sub-bass (< 36)
    if not in_range_notes:
        kept = [n for n in ordered if n.pitch_midi >= 36]
        return (kept or ordered), max(0, len(ordered) - len(kept or ordered))

    def _has_melodic_support(target: DetectedNote, max_semitones: int, max_gap_sec: float) -> bool:
        for other in ordered:
            if other is target:
                continue
            if other.pitch_midi < min_midi - 5 or other.pitch_midi > max_midi + 5:
                continue
            gap = min(
                abs(target.onset_sec - other.offset_sec),
                abs(other.onset_sec - target.offset_sec),
                abs(target.onset_sec - other.onset_sec),
            )
            if gap <= max_gap_sec and abs(target.pitch_midi - other.pitch_midi) <= max_semitones:
                return True
        return False

    filtered: list[DetectedNote] = []
    ringing: list[DetectedNote] = []
    for n in ordered:
        ringing = [r for r in ringing if r.offset_sec > n.onset_sec + 0.04]
        dur = max(0.0, n.offset_sec - n.onset_sec)

        # 1. Obvious sub-bass artifacts (e.g., F1=29, F#2=42 when vocal range starts at G3=55)
        if n.pitch_midi < min_midi - 7:
            ringing.append(n)
            continue

        # 2. Borderline low notes (e.g., C3-F#3): keep only if melodically connected to vocal line
        if n.pitch_midi < min_midi:
            if not _has_melodic_support(n, max_semitones=7, max_gap_sec=1.0) or dur < 0.08:
                ringing.append(n)
                continue

        # 3. Upper-register notes above max_midi: check harmonic overtones & extreme outliers
        if n.pitch_midi > max_midi:
            simultaneous = [
                r for r in ringing if abs(r.onset_sec - n.onset_sec) <= 0.06
            ]
            if _is_likely_harmonic_overtone(n, simultaneous, ringing):
                continue
            # Extreme upper outliers (e.g., E6=88, G#6=92 above G5=79):
            # preserve legitimate high vocal notes only when supported by transcription continuity & strength.
            if n.pitch_midi > max_midi + 4:
                supported = _has_melodic_support(n, max_semitones=9, max_gap_sec=1.2)
                strong = (
                    dur >= 0.12
                    and n.velocity >= 55
                    and (n.confidence is None or n.confidence >= 0.50)
                )
                if not (supported and strong):
                    continue

        filtered.append(n)
        ringing.append(n)

    if not filtered:
        return ordered, 0
    return filtered, len(ordered) - len(filtered)


def _key_diatonic_pcs(key_signature: str | None) -> frozenset[int] | None:
    """Return pitch classes of the detected key signature as a soft contextual reference."""
    if not key_signature or key_signature.strip().lower() == "auto":
        return None
    try:
        import music21

        clean = key_signature.strip()
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
        key_obj = music21.key.Key(tonic.replace("b", "-"), "minor" if is_minor else "major")
        return frozenset(int(p.pitchClass) for p in key_obj.pitches)
    except Exception:
        return None


def _smooth_vocal_vibrato_and_glitches(
    notes: list[DetectedNote],
    diatonic_pcs: frozenset[int] | None = None,
) -> tuple[list[DetectedNote], int, int]:
    """Smooth brief vibrato/semitone glitches and merge fragmented same-pitch vocal notes (<= 90ms gap)."""
    if len(notes) < 2:
        return list(notes), 0, 0

    working = [
        DetectedNote(
            pitch_midi=n.pitch_midi,
            onset_sec=n.onset_sec,
            offset_sec=n.offset_sec,
            velocity=n.velocity,
            confidence=n.confidence,
        )
        for n in notes
    ]

    # 1. Smooth brief 1-semitone vibrato excursions (A -> A±1 -> A) without snapping real chromaticism
    vibrato_smoothed = 0
    for idx in range(1, len(working) - 1):
        prev = working[idx - 1]
        cur = working[idx]
        nxt = working[idx + 1]
        cur_dur = max(0.0, cur.offset_sec - cur.onset_sec)
        if (
            prev.pitch_midi == nxt.pitch_midi
            and abs(cur.pitch_midi - prev.pitch_midi) == 1
            and cur_dur < 0.22
            and cur.onset_sec - prev.offset_sec <= 0.06
            and nxt.onset_sec - cur.offset_sec <= 0.06
        ):
            not_accented = cur.velocity < max(prev.velocity, nxt.velocity) + 10
            cur_conf = cur.confidence if cur.confidence is not None else 0.6
            adj_conf = max(
                prev.confidence if prev.confidence is not None else 0.6,
                nxt.confidence if nxt.confidence is not None else 0.6,
            )
            off_key_wobble = (
                diatonic_pcs is not None
                and (prev.pitch_midi % 12) in diatonic_pcs
                and (cur.pitch_midi % 12) not in diatonic_pcs
            )
            if not_accented and (cur_dur < 0.14 or off_key_wobble or cur_conf <= adj_conf + 0.05):
                cur.pitch_midi = prev.pitch_midi
                vibrato_smoothed += 1

    # 2. Merge consecutive same-pitch notes separated by <= 90ms unless supported by genuine re-attack evidence
    merged: list[DetectedNote] = [working[0]]
    same_pitch_merges = 0
    for cur in working[1:]:
        prev = merged[-1]
        gap = cur.onset_sec - prev.offset_sec
        if cur.pitch_midi == prev.pitch_midi and gap <= 0.090:
            prev_dur = max(0.0, prev.offset_sec - prev.onset_sec)
            cur_dur = max(0.0, cur.offset_sec - cur.onset_sec)
            prev_conf = prev.confidence if prev.confidence is not None else 0.65
            cur_conf = cur.confidence if cur.confidence is not None else 0.65

            strong_reattack = (
                cur.velocity >= prev.velocity + 12
                or (
                    cur.confidence is not None
                    and prev.confidence is not None
                    and cur_conf >= prev_conf * 1.18
                    and cur.velocity >= prev.velocity + 4
                )
            )
            clear_articulated_repeat = (
                gap >= 0.055
                and prev_dur >= 0.20
                and cur_dur >= 0.20
                and cur.velocity >= prev.velocity - 2
                and cur_conf >= 0.75
            )
            if not (strong_reattack or clear_articulated_repeat):
                prev.offset_sec = max(prev.offset_sec, cur.offset_sec)
                prev.velocity = max(prev.velocity, cur.velocity)
                if prev.confidence is not None and cur.confidence is not None:
                    prev.confidence = max(prev.confidence, cur.confidence)
                same_pitch_merges += 1
                continue
        merged.append(cur)

    return merged, vibrato_smoothed, same_pitch_merges


def _unary_score(
    note: DetectedNote,
    cluster: list[DetectedNote],
    anchor_pitch: float,
    vocal_range: tuple[int, int] | None = None,
    diatonic_pcs: frozenset[int] | None = None,
) -> float:
    """Score a candidate note's melodic salience within its onset cluster."""
    dur = max(0.0, note.offset_sec - note.onset_sec)
    vel_score = (max(1, min(127, note.velocity)) / 127.0) * 1.4
    conf_val = 0.72 if note.confidence is None else max(0.0, min(1.0, note.confidence))
    conf_score = conf_val * 1.0

    # Sustained notes are much more likely to carry a melody than tiny transients.
    dur_score = min(dur, 1.5) * 0.9
    if dur < 0.06:
        dur_score -= 0.9

    # Relative height within a simultaneous chord favors the top voice gently,
    # while single-note clusters incur zero pitch-height bias.
    rel_height_score = 0.0
    if len(cluster) > 1:
        pitches = [c.pitch_midi for c in cluster]
        lo, hi = min(pitches), max(pitches)
        if hi > lo:
            rel_height_score = ((note.pitch_midi - lo) / (hi - lo)) * 1.15

    # Soft pull toward the piece's melodic register center.
    register_penalty = 0.045 * abs(note.pitch_midi - anchor_pitch)
    if vocal_range is not None:
        lo_v, hi_v = vocal_range
        if note.pitch_midi < lo_v:
            register_penalty += 0.25 * (lo_v - note.pitch_midi)
        elif note.pitch_midi > hi_v:
            register_penalty += 0.18 * (note.pitch_midi - hi_v)

    # Reject weak harmonic overtones over a strong fundamental.
    overtone_penalty = 2.2 if _is_likely_harmonic_overtone(note, cluster) else 0.0

    # Gentle contextual key preference (never an absolute pitch constraint)
    key_bonus = 0.18 if (diatonic_pcs is not None and (note.pitch_midi % 12) in diatonic_pcs) else 0.0

    return vel_score + conf_score + dur_score + rel_height_score + key_bonus - register_penalty - overtone_penalty


def _transition_score(prev_note: DetectedNote, cur_note: DetectedNote) -> float:
    """Score melodic continuity between consecutive chosen notes."""
    interval = abs(cur_note.pitch_midi - prev_note.pitch_midi)
    gap_sec = max(0.0, cur_note.onset_sec - prev_note.offset_sec)
    # Phrase breaks (> 0.9s rest) allow wider register resets cleanly.
    leap_scale = 0.45 if gap_sec > 0.9 else 1.0

    if interval == 0:
        contour_score = 0.85
    elif interval <= 4:
        contour_score = 1.25
    elif interval <= 7:
        contour_score = 0.75
    elif interval <= 12:
        contour_score = -0.25 * leap_scale
    else:
        contour_score = (-0.25 - 0.22 * (interval - 12)) * leap_scale

    # Slight rhythmic continuity bonus when the next note enters near the end
    # of or shortly after the previous note.
    overlap = prev_note.offset_sec - cur_note.onset_sec
    timing_score = 0.2 if -0.35 <= overlap <= 0.08 else 0.0
    return contour_score + timing_score


def _enforce_monophony(
    notes: list[DetectedNote],
    min_gap_sec: float = 0.005,
    min_duration_sec: float = 0.025,
) -> tuple[list[DetectedNote], int]:
    """Ensure zero simultaneous or overlapping notes in the extracted melody."""
    if not notes:
        return [], 0

    ordered = sorted(notes, key=lambda n: (n.onset_sec, -n.velocity, -n.pitch_midi))
    monophonic: list[DetectedNote] = []
    trimmed_count = 0

    for cur in ordered:
        cur_copy = DetectedNote(
            pitch_midi=cur.pitch_midi,
            onset_sec=cur.onset_sec,
            offset_sec=max(cur.onset_sec + min_duration_sec, cur.offset_sec),
            velocity=cur.velocity,
            confidence=cur.confidence,
        )
        if not monophonic:
            monophonic.append(cur_copy)
            continue

        prev = monophonic[-1]
        if cur_copy.onset_sec - prev.onset_sec < 0.015:
            # Practically simultaneous onset: keep whichever note is stronger/higher.
            prev_rank = prev.velocity + (prev.pitch_midi * 0.5)
            cur_rank = cur_copy.velocity + (cur_copy.pitch_midi * 0.5)
            if cur_rank > prev_rank:
                monophonic[-1] = cur_copy
            trimmed_count += 1
            continue

        if prev.offset_sec > cur_copy.onset_sec - min_gap_sec:
            new_offset = cur_copy.onset_sec - min_gap_sec
            if new_offset - prev.onset_sec >= min_duration_sec:
                prev.offset_sec = new_offset
            else:
                prev.offset_sec = max(prev.onset_sec + 0.01, cur_copy.onset_sec - 0.001)
            trimmed_count += 1

        monophonic.append(cur_copy)

    return monophonic, trimmed_count


def _suppress_intro_percussion_and_transients(
    notes: list[DetectedNote],
    beat_sec: float,
) -> tuple[list[DetectedNote], int]:
    """Suppress isolated percussion/transient bleed before the first sustained vocal phrase.

    Preserves quiet but sustained vocal entrances and legitimate short pickup notes
    that connect directly into the opening phrase.
    """
    if len(notes) < 2:
        return list(notes), 0

    ordered = sorted(notes, key=lambda n: (n.onset_sec, n.pitch_midi))
    sustained_min_dur = max(0.18, beat_sec * 0.30)
    pickup_connect_gap = max(0.35, beat_sec * 0.65)
    isolated_gap = max(0.55, beat_sec * 0.90)

    # Locate the start of the first genuine vocal phrase:
    # either a sustained note (>= sustained_min_dur) or >= 3 connected notes with
    # melodic continuity (<= 7 semitones) and average duration >= 0.14s.
    first_phrase_idx: int | None = None
    for idx, n in enumerate(ordered):
        dur = max(0.0, n.offset_sec - n.onset_sec)
        conf = n.confidence if n.confidence is not None else 0.72
        if dur >= sustained_min_dur and (conf >= 0.38 or n.velocity >= 42):
            first_phrase_idx = idx
            break
        if idx + 2 < len(ordered):
            window = ordered[idx : idx + 3]
            gaps_ok = all(window[k + 1].onset_sec - window[k].offset_sec <= 0.25 for k in range(2))
            steps_ok = all(1 <= abs(window[k + 1].pitch_midi - window[k].pitch_midi) <= 7 for k in range(2))
            mean_dur = sum(max(0.0, w.offset_sec - w.onset_sec) for w in window) / 3.0
            if gaps_ok and steps_ok and mean_dur >= 0.13:
                first_phrase_idx = idx
                break

    if first_phrase_idx is None or first_phrase_idx == 0:
        return ordered, 0

    phrase_start_note = ordered[first_phrase_idx]
    kept: list[DetectedNote] = []
    removed = 0

    for idx, n in enumerate(ordered):
        if idx >= first_phrase_idx:
            kept.append(n)
            continue

        dur = max(0.0, n.offset_sec - n.onset_sec)
        conf = n.confidence if n.confidence is not None else 0.70
        gap_to_phrase = phrase_start_note.onset_sec - n.offset_sec

        # Preserve legitimate pickup notes immediately preceding the opening phrase
        if (
            gap_to_phrase <= pickup_connect_gap
            and abs(n.pitch_midi - phrase_start_note.pitch_midi) <= 9
            and (dur >= 0.10 or conf >= 0.58)
        ):
            kept.append(n)
            continue

        # Suppress short/weak/chromatic transient blips before a clear gap or before the phrase
        is_transient = dur < max(0.14, beat_sec * 0.28) and (
            gap_to_phrase >= isolated_gap or conf < 0.64 or n.velocity < 62
        )
        if is_transient:
            removed += 1
            continue

        kept.append(n)

    return (kept or ordered), (removed if kept else 0)


def _reject_octave_and_accompaniment_bleed(
    notes: list[DetectedNote],
    accompaniment_notes: list[DetectedNote] | None = None,
) -> tuple[list[DetectedNote], int]:
    """Reject isolated octave-jump / accompaniment-bleed notes using local phrase contour.

    Preserves legitimate octave jumps and low-register phrases (sustained >= 2 notes
    or strong sustained solo notes).
    """
    if len(notes) < 3:
        return list(notes), 0

    accomp = accompaniment_notes or []
    kept: list[DetectedNote] = []
    rejected = 0

    for idx, cur in enumerate(notes):
        # Build local context window from neighboring notes (excluding cur)
        lo_i = max(0, idx - 4)
        hi_i = min(len(notes), idx + 5)
        neighbors = [notes[j] for j in range(lo_i, hi_i) if j != idx and abs(notes[j].onset_sec - cur.onset_sec) <= 4.0]
        if len(neighbors) < 2:
            kept.append(cur)
            continue

        local_med = float(median(n.pitch_midi for n in neighbors))
        local_med_vel = float(median(n.velocity for n in neighbors))
        cur_dur = max(0.0, cur.offset_sec - cur.onset_sec)
        cur_conf = cur.confidence if cur.confidence is not None else 0.70
        diff_from_med = cur.pitch_midi - local_med

        # Check if cur is an isolated sudden octave/subharmonic dip (or extreme octave spike)
        is_octave_jump = 10.0 <= abs(diff_from_med) <= 24.0
        if not is_octave_jump:
            kept.append(cur)
            continue

        # If next note also stays in the new register, it's a legitimate register shift
        next_stays = (
            idx + 1 < len(notes)
            and abs(notes[idx + 1].pitch_midi - cur.pitch_midi) <= 5
            and notes[idx + 1].onset_sec - cur.offset_sec <= 0.6
        )
        prev_was_there = (
            idx - 1 >= 0
            and abs(notes[idx - 1].pitch_midi - cur.pitch_midi) <= 5
            and cur.onset_sec - notes[idx - 1].offset_sec <= 0.6
        )
        if next_stays or prev_was_there:
            kept.append(cur)
            continue

        # Check simultaneous accompaniment overlap (same pitch class / exact pitch in accompaniment)
        matches_accomp = any(
            abs(a.onset_sec - cur.onset_sec) <= 0.08
            and (a.pitch_midi == cur.pitch_midi or abs(a.pitch_midi - cur.pitch_midi) == 12)
            for a in accomp
        )

        weak_or_short = cur_dur < 0.32 or cur_conf < 0.68 or cur.velocity < local_med_vel - 8
        strong_sustained = cur_dur >= 0.45 and cur.velocity >= local_med_vel - 5 and cur_conf >= 0.72

        if (diff_from_med <= -10.0 and (weak_or_short or matches_accomp) and not strong_sustained) or (
            diff_from_med >= 11.0 and matches_accomp and weak_or_short
        ):
            rejected += 1
            continue

        kept.append(cur)

    return (kept or notes), (rejected if kept else 0)


def extract_lead_melody(
    notes: list[DetectedNote],
    tempo_bpm: float = 120.0,
    timing_map: Any = None,
    vocal_range: tuple[int, int] | None = None,
    key_signature: str | None = None,
    accompaniment_notes: list[DetectedNote] | None = None,
    from_monophonic_vocal_tracker: bool = False,
) -> MelodyExtractionResult:
    """Extract a single, coherent monophonic melody line from polyphonic or vocal-F0 notes.

    When ``from_monophonic_vocal_tracker=True`` (e.g., isolated ``vocals.wav`` via pYIN),
    preserves genuine short 16th-note syllables, grace notes, vibrato smoothing, and rests
    without running polyphonic clustering or piano minimum-duration/same-pitch pruning.
    """
    valid_notes = [n for n in notes if n.offset_sec > n.onset_sec]
    if not valid_notes:
        return MelodyExtractionResult(
            notes=[],
            stats={
                "input_note_count": len(notes),
                "output_note_count": 0,
                "cluster_count": 0,
                "average_pitch_midi": 0.0,
                "average_confidence": 0.0,
                "uncertain_segment_count": 0,
                "trimmed_overlaps": 0,
            },
            uncertain_segments=[],
        )

    if from_monophonic_vocal_tracker:
        ordered_vocal = sorted(valid_notes, key=lambda n: (n.onset_sec, n.pitch_midi))
        filtered_vocal, octave_bleed_rejected = (
            _reject_octave_and_accompaniment_bleed(ordered_vocal, accompaniment_notes=accompaniment_notes)
            if len(ordered_vocal) >= 3
            else (ordered_vocal, 0)
        )
        monophonic_notes, trimmed_overlaps = _enforce_monophony(
            filtered_vocal,
            min_gap_sec=0.004,
            min_duration_sec=0.030,
        )
        avg_pitch = (
            sum(n.pitch_midi for n in monophonic_notes) / len(monophonic_notes)
            if monophonic_notes
            else 0.0
        )
        confs = [n.confidence for n in monophonic_notes if n.confidence is not None]
        avg_conf = (sum(confs) / len(confs)) if confs else 0.0
        return MelodyExtractionResult(
            notes=monophonic_notes,
            stats={
                "input_note_count": len(notes),
                "output_note_count": len(monophonic_notes),
                "cluster_count": len(monophonic_notes),
                "anchor_pitch_midi": round(float(median(n.pitch_midi for n in monophonic_notes)), 2) if monophonic_notes else 0.0,
                "average_pitch_midi": round(avg_pitch, 2),
                "average_confidence": round(avg_conf, 3),
                "uncertain_segment_count": 0,
                "trimmed_overlaps": trimmed_overlaps,
                "filtered_outlier_count": 0,
                "intro_transients_suppressed": 0,
                "octave_bleed_rejected": octave_bleed_rejected,
                "vibrato_smoothed_count": 0,
                "same_pitch_merges": 0,
                "from_monophonic_vocal_tracker": True,
                "vocal_range": list(vocal_range) if vocal_range is not None else None,
            },
            uncertain_segments=[],
        )

    filtered_outlier_count = 0
    intro_transients_suppressed = 0
    octave_bleed_rejected = 0
    diatonic_pcs = _key_diatonic_pcs(key_signature)

    effective_bpm = float(getattr(timing_map, "tempo_bpm", None) or tempo_bpm or 120.0)
    beat_sec = 60.0 / max(30.0, effective_bpm)

    if vocal_range is not None:
        valid_notes, filtered_outlier_count = _filter_vocal_outliers(valid_notes, vocal_range)
        valid_notes, intro_transients_suppressed = _suppress_intro_percussion_and_transients(
            valid_notes, beat_sec=beat_sec
        )

    onset_tolerance_sec = max(0.025, min(0.055, beat_sec * 0.08))

    clusters = _cluster_by_onset(valid_notes, onset_tolerance_sec=onset_tolerance_sec)
    anchor_pitch = _estimate_melody_anchor_pitch(clusters, vocal_range=vocal_range)

    dp_scores: list[list[float]] = []
    backpointers: list[list[int]] = []
    uncertain_segments: list[dict[str, Any]] = []

    first_scores = [
        _unary_score(n, clusters[0], anchor_pitch, vocal_range=vocal_range, diatonic_pcs=diatonic_pcs)
        for n in clusters[0]
    ]
    dp_scores.append(first_scores)
    backpointers.append([-1] * len(clusters[0]))

    for idx in range(1, len(clusters)):
        prev_cluster = clusters[idx - 1]
        cur_cluster = clusters[idx]
        prev_dp = dp_scores[idx - 1]
        cur_dp: list[float] = []
        cur_bp: list[int] = []

        for cur_note in cur_cluster:
            unary = _unary_score(
                cur_note,
                cur_cluster,
                anchor_pitch,
                vocal_range=vocal_range,
                diatonic_pcs=diatonic_pcs,
            )
            best_total = float("-inf")
            best_prev = 0
            for prev_idx, prev_note in enumerate(prev_cluster):
                total = prev_dp[prev_idx] + _transition_score(prev_note, cur_note) + unary
                if total > best_total:
                    best_total = total
                    best_prev = prev_idx
            cur_dp.append(best_total)
            cur_bp.append(best_prev)

        dp_scores.append(cur_dp)
        backpointers.append(cur_bp)

        if len(cur_dp) > 1:
            sorted_scores = sorted(cur_dp, reverse=True)
            margin = sorted_scores[0] - sorted_scores[1]
            if margin < 0.35:
                uncertain_segments.append(
                    {
                        "onset_sec": round(cur_cluster[0].onset_sec, 3),
                        "candidate_pitches": [c.pitch_midi for c in cur_cluster],
                        "margin": round(margin, 3),
                        "reason": "close_melodic_candidates",
                    }
                )

    # Backtrack optimal path.
    chosen_indices = [0] * len(clusters)
    last_scores = dp_scores[-1]
    chosen_indices[-1] = max(range(len(last_scores)), key=lambda i: last_scores[i])
    for idx in range(len(clusters) - 1, 0, -1):
        chosen_indices[idx - 1] = backpointers[idx][chosen_indices[idx]]

    raw_selected = [clusters[idx][chosen_indices[idx]] for idx in range(len(clusters))]

    # Suppress quiet accompaniment taps that occur underneath a still-ringing
    # prominent melody note (e.g., an isolated bass/inner tap during a held melody).
    filtered_selected: list[DetectedNote] = []
    for note in raw_selected:
        if filtered_selected:
            prev = filtered_selected[-1]
            note_dur = note.offset_sec - note.onset_sec
            if (
                prev.offset_sec > note.onset_sec + 0.14
                and note.pitch_midi <= prev.pitch_midi - 10
                and note.velocity + 12 < prev.velocity
                and note_dur < 0.35
            ):
                continue
        filtered_selected.append(note)

    vibrato_smoothed = 0
    same_pitch_merges = 0
    if vocal_range is not None:
        filtered_selected, octave_bleed_rejected = _reject_octave_and_accompaniment_bleed(
            filtered_selected,
            accompaniment_notes=accompaniment_notes,
        )
        filtered_selected, vibrato_smoothed, same_pitch_merges = _smooth_vocal_vibrato_and_glitches(
            filtered_selected,
            diatonic_pcs=diatonic_pcs,
        )

    monophonic_notes, trimmed_overlaps = _enforce_monophony(filtered_selected)

    avg_pitch = (
        sum(n.pitch_midi for n in monophonic_notes) / len(monophonic_notes)
        if monophonic_notes
        else 0.0
    )
    confs = [n.confidence for n in monophonic_notes if n.confidence is not None]
    avg_conf = (sum(confs) / len(confs)) if confs else 0.0

    return MelodyExtractionResult(
        notes=monophonic_notes,
        stats={
            "input_note_count": len(notes),
            "output_note_count": len(monophonic_notes),
            "cluster_count": len(clusters),
            "anchor_pitch_midi": round(anchor_pitch, 2),
            "average_pitch_midi": round(avg_pitch, 2),
            "average_confidence": round(avg_conf, 3),
            "uncertain_segment_count": len(uncertain_segments),
            "trimmed_overlaps": trimmed_overlaps,
            "filtered_outlier_count": filtered_outlier_count,
            "intro_transients_suppressed": intro_transients_suppressed,
            "octave_bleed_rejected": octave_bleed_rejected,
            "vibrato_smoothed_count": vibrato_smoothed,
            "same_pitch_merges": same_pitch_merges,
            "vocal_range": list(vocal_range) if vocal_range is not None else None,
        },
        uncertain_segments=uncertain_segments,
    )
