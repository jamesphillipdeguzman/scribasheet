"""Context-aware piano playability post-processor.

Shapes raw transcribed polyphonic note events into idiomatic, physically
playable two-hand piano voicings across three user-selectable smoothing levels:
  - ``original``: Pass through transcribed notes untouched.
  - ``standard``: Balanced playable RH/LH voicings, span limits, and clutter cleanup.
  - ``simplified``: Sight-readable melody + root/5th/shell LH accompaniment with smooth voice leading.

All transformations are strictly non-destructive: callers retain raw detected
notes separately so switching smoothing levels never requires re-running ML.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any, Literal

from app.notation.hand_assignment import assign_hands_contextual
from app.schemas.score import ScoreNote
from app.transcription.base import DetectedNote

PlayabilitySmoothingMode = Literal["original", "standard", "simplified"]

_NON_PIANO_MODES = {"melody", "lead_melody", "vocal_melody", "satb_pdf"}

_NOTE_NAME_TO_PC: dict[str, int] = {
    "C": 0,
    "B#": 0,
    "C#": 1,
    "DB": 1,
    "D": 2,
    "D#": 3,
    "EB": 3,
    "E": 4,
    "FB": 4,
    "F": 5,
    "E#": 5,
    "F#": 6,
    "GB": 6,
    "G": 7,
    "G#": 8,
    "AB": 8,
    "A": 9,
    "A#": 10,
    "BB": 10,
    "B": 11,
    "CB": 11,
}


@dataclass
class PlayabilityResult:
    notes: list[DetectedNote]
    stats: dict[str, Any] = field(default_factory=dict)


def normalize_playability_smoothing(smoothing: str | None) -> PlayabilitySmoothingMode:
    val = (smoothing or "standard").strip().lower()
    if val in ("original", "raw", "off", "none"):
        return "original"
    if val in ("simplified", "simple", "easy"):
        return "simplified"
    return "standard"


def _clone_note(n: DetectedNote) -> DetectedNote:
    return DetectedNote(
        pitch_midi=int(n.pitch_midi),
        onset_sec=float(n.onset_sec),
        offset_sec=float(n.offset_sec),
        velocity=int(n.velocity),
        confidence=n.confidence,
    )


def _chord_symbol_to_pcs(symbol: str) -> tuple[int | None, set[int]]:
    """Extract root pitch-class and chord pitch-classes from a readable chord symbol."""
    if not symbol:
        return None, set()
    main = symbol.split("/", 1)[0].strip()
    if not main:
        return None, set()

    if len(main) >= 2 and main[1] in ("#", "b"):
        root_str = main[:2].upper()
        qual = main[2:].lower()
    else:
        root_str = main[:1].upper()
        qual = main[1:].lower()
    root_pc = _NOTE_NAME_TO_PC.get(root_str)
    if root_pc is None:
        return None, set()

    pcs = {root_pc}
    if "sus4" in qual:
        pcs |= {(root_pc + 5) % 12, (root_pc + 7) % 12}
    elif "sus2" in qual:
        pcs |= {(root_pc + 2) % 12, (root_pc + 7) % 12}
    elif "dim7" in qual:
        pcs |= {(root_pc + 3) % 12, (root_pc + 6) % 12, (root_pc + 9) % 12}
    elif "m7b5" in qual:
        pcs |= {(root_pc + 3) % 12, (root_pc + 6) % 12, (root_pc + 10) % 12}
    elif "dim" in qual:
        pcs |= {(root_pc + 3) % 12, (root_pc + 6) % 12}
    elif "aug" in qual:
        pcs |= {(root_pc + 4) % 12, (root_pc + 8) % 12}
    elif qual.startswith("m") and not qual.startswith("maj"):
        pcs |= {(root_pc + 3) % 12, (root_pc + 7) % 12}
    else:
        pcs |= {(root_pc + 4) % 12, (root_pc + 7) % 12}

    if "maj7" in qual:
        pcs.add((root_pc + 11) % 12)
    elif "7" in qual and "dim7" not in qual:
        pcs.add((root_pc + 10) % 12)
    if "6" in qual:
        pcs.add((root_pc + 9) % 12)
    return root_pc, pcs


def _slice_span(slice_notes: Sequence[DetectedNote]) -> int:
    if len(slice_notes) <= 1:
        return 0
    return max(n.pitch_midi for n in slice_notes) - min(n.pitch_midi for n in slice_notes)


def apply_piano_playability(
    notes: Sequence[DetectedNote],
    *,
    chords: Sequence[Any] | None = None,
    tempo_bpm: float = 120.0,
    time_signature: str = "4/4",
    key_signature: str = "C",
    mode: str = "piano",
    instrument: str = "piano",
    smoothing: str | None = "standard",
) -> PlayabilityResult:
    """Post-process polyphonic notes into ergonomic, playable RH/LH piano voicings."""
    norm_smoothing = normalize_playability_smoothing(smoothing)
    norm_mode = (mode or "piano").strip().lower()
    is_piano_inst = "piano" in (instrument or "piano").strip().lower()
    cloned = [_clone_note(n) for n in notes]

    if not cloned or norm_smoothing == "original" or norm_mode in _NON_PIANO_MODES or not is_piano_inst:
        return PlayabilityResult(
            notes=cloned,
            stats={
                "smoothing": norm_smoothing,
                "applied": False,
                "input_count": len(cloned),
                "output_count": len(cloned),
                "rh_cluster_pruned": 0,
                "lh_voicing_cleaned": 0,
                "hand_span_violations_fixed": 0,
                "max_rh_span": 0,
                "max_lh_span": 0,
            },
        )

    sec_per_beat = 60.0 / max(30.0, float(tempo_bpm))
    # Parse active chords indexed by onset_sec for chord-aware voicing retention
    chord_timeline: list[tuple[float, int | None, set[int]]] = []
    for ch in sorted(list(chords or []), key=lambda c: float(getattr(c, "onset_sec", 0.0))):
        on_s = float(getattr(ch, "onset_sec", 0.0))
        sym = str(getattr(ch, "symbol", ""))
        r_pc, ch_pcs = _chord_symbol_to_pcs(sym)
        if ch_pcs:
            chord_timeline.append((on_s, r_pc, ch_pcs))

    def _active_chord(t_sec: float) -> tuple[int | None, set[int]]:
        active_r: int | None = None
        active_pcs: set[int] = set()
        for on_s, r_pc, pcs in chord_timeline:
            if on_s <= t_sec + 0.08:
                active_r, active_pcs = r_pc, pcs
            else:
                break
        return active_r, active_pcs

    # Build temporary ScoreNote proxies so DP hand assignment partitions musically (not fixed C4 split)
    ordered = sorted(cloned, key=lambda n: (n.onset_sec, n.pitch_midi))
    score_proxies: list[ScoreNote] = []
    proxy_to_det: dict[str, DetectedNote] = {}
    for idx, n in enumerate(ordered):
        nid = f"pp_{idx}"
        score_proxies.append(
            ScoreNote(
                id=nid,
                pitch_midi=n.pitch_midi,
                onset_sec=n.onset_sec,
                offset_sec=max(n.onset_sec + 0.02, n.offset_sec),
                velocity=max(1, min(127, n.velocity)),
                confidence=n.confidence,
            )
        )
        proxy_to_det[nid] = n

    _, lh_assigned = assign_hands_contextual(score_proxies)
    lh_ids = {n.id for n in lh_assigned}

    # Group into simultaneous onset clusters (~35ms)
    clusters: list[list[ScoreNote]] = []
    if score_proxies:
        clusters.append([score_proxies[0]])
        anchor = score_proxies[0].onset_sec
        for sp in score_proxies[1:]:
            if sp.onset_sec - anchor <= 0.035:
                clusters[-1].append(sp)
            else:
                clusters.append([sp])
                anchor = sp.onset_sec

    rh_cluster_pruned = 0
    lh_voicing_cleaned = 0
    hand_span_violations_fixed = 0
    max_rh_span = 0
    max_lh_span = 0
    prev_lh_center = 48.0

    output_notes: list[DetectedNote] = []
    max_rh_allowed_span = 12 if norm_smoothing == "standard" else 11
    max_lh_allowed_span = 12

    for cluster in clusters:
        cluster_t = cluster[0].onset_sec
        chord_root_pc, chord_pcs = _active_chord(cluster_t)

        # Deduplicate identical simultaneous pitches per hand first
        rh_map: dict[int, DetectedNote] = {}
        lh_map: dict[int, DetectedNote] = {}
        for sp in cluster:
            det = proxy_to_det[sp.id]
            target = lh_map if sp.id in lh_ids else rh_map
            if det.pitch_midi not in target or det.velocity > target[det.pitch_midi].velocity:
                target[det.pitch_midi] = det

        rh_notes = sorted(rh_map.values(), key=lambda n: -n.pitch_midi)  # highest (melody) first
        lh_notes = sorted(lh_map.values(), key=lambda n: n.pitch_midi)   # lowest (bass) first

        # --- RH Shaping ---
        if len(rh_notes) > 1:
            mel_top = rh_notes[0]
            kept_rh: list[DetectedNote] = [mel_top]
            for cand in rh_notes[1:]:
                diff_from_top = mel_top.pitch_midi - cand.pitch_midi
                # Suppress accidental weak RH octave duplication directly under strong melody
                if (
                    diff_from_top == 12
                    and len(rh_notes) >= 3
                    and cand.velocity <= mel_top.velocity - 14
                    and (mel_top.offset_sec - mel_top.onset_sec) >= (cand.offset_sec - cand.onset_sec) - 0.06
                ):
                    rh_cluster_pruned += 1
                    continue

                # Avoid muddy semitone/whole-tone seconds below mid-staff (unless top melody pair)
                is_muddy_second = any(
                    0 < abs(k.pitch_midi - cand.pitch_midi) <= 2 and cand.pitch_midi < 69
                    for k in kept_rh
                )
                if is_muddy_second:
                    cand_in_chord = (cand.pitch_midi % 12) in chord_pcs if chord_pcs else True
                    if not cand_in_chord or cand.velocity < mel_top.velocity - 8:
                        rh_cluster_pruned += 1
                        continue

                # In simplified mode, drop non-chord passing clutter in inner RH voices
                if norm_smoothing == "simplified" and chord_pcs:
                    if (cand.pitch_midi % 12) not in chord_pcs and cand.velocity < mel_top.velocity - 5:
                        rh_cluster_pruned += 1
                        continue

                kept_rh.append(cand)

            # Enforce physical RH span limit (dropping weakest bottom inner tone while preserving melody)
            while _slice_span(kept_rh) > max_rh_allowed_span and len(kept_rh) > 2:
                # Score inner notes (excluding top melody) by chord membership & velocity
                inner = kept_rh[1:]
                weakest = min(
                    inner,
                    key=lambda n: (
                        1 if ((n.pitch_midi % 12) in chord_pcs and n.pitch_midi >= 60) else 0,
                        n.velocity,
                        n.pitch_midi,
                    ),
                )
                kept_rh.remove(weakest)
                hand_span_violations_fixed += 1
                rh_cluster_pruned += 1

            # In simplified mode, keep melody + up to 2 strongest inner chord tones (playable triad/shell)
            if norm_smoothing == "simplified" and len(kept_rh) > 3:
                top_n = kept_rh[0]
                ranked_inner = sorted(
                    kept_rh[1:],
                    key=lambda n: (
                        1 if (chord_pcs and (n.pitch_midi % 12) in chord_pcs) else 0,
                        n.velocity,
                        n.pitch_midi,
                    ),
                    reverse=True,
                )
                rh_cluster_pruned += len(kept_rh) - 3
                kept_rh = [top_n, *ranked_inner[:2]]

            rh_notes = sorted(kept_rh, key=lambda n: n.pitch_midi)

        elif len(rh_notes) == 1 and norm_smoothing == "simplified":
            # In simplified mode, only drop ultra-weak fleeting micro-grace notes (< 0.08s, very quiet)
            n0 = rh_notes[0]
            if (n0.offset_sec - n0.onset_sec) < min(0.09, sec_per_beat * 0.16) and n0.velocity < 46:
                rh_notes = []
                rh_cluster_pruned += 1

        # --- LH Shaping ---
        if len(lh_notes) > 1:
            bass_anchor = lh_notes[0]  # lowest bass pitch preserved
            kept_lh: list[DetectedNote] = [bass_anchor]

            for cand in lh_notes[1:]:
                interval = cand.pitch_midi - bass_anchor.pitch_midi
                # Clean muddy sub-C3 clusters (2nds / minor 3rds stacked below MIDI 48)
                is_muddy_bass = any(
                    (abs(k.pitch_midi - cand.pitch_midi) <= 3 and cand.pitch_midi < 48)
                    or (abs(k.pitch_midi - cand.pitch_midi) <= 2 and cand.pitch_midi < 54)
                    for k in kept_lh
                )
                if is_muddy_bass:
                    lh_voicing_cleaned += 1
                    continue

                # In simplified mode, prefer clean root/5th/octave/3rd/7th chord tones
                if norm_smoothing == "simplified" and chord_pcs:
                    if (cand.pitch_midi % 12) not in chord_pcs and cand.velocity < 82:
                        lh_voicing_cleaned += 1
                        continue

                # Enforce comfortable LH span (<= 12 semitones from lowest bass note)
                if interval > max_lh_allowed_span:
                    # Try shifting inner chord tone down by an octave if it sits cleanly >= bass+5 and avoids mud
                    shifted_pitch = cand.pitch_midi - 12
                    if (
                        bass_anchor.pitch_midi + 5 <= shifted_pitch <= bass_anchor.pitch_midi + 12
                        and all(abs(k.pitch_midi - shifted_pitch) >= 3 for k in kept_lh)
                        and abs(shifted_pitch - prev_lh_center) <= 10.0
                    ):
                        kept_lh.append(
                            DetectedNote(
                                pitch_midi=shifted_pitch,
                                onset_sec=cand.onset_sec,
                                offset_sec=cand.offset_sec,
                                velocity=cand.velocity,
                                confidence=cand.confidence,
                            )
                        )
                        hand_span_violations_fixed += 1
                        lh_voicing_cleaned += 1
                    else:
                        hand_span_violations_fixed += 1
                        lh_voicing_cleaned += 1
                    continue

                kept_lh.append(cand)

            # Cap LH simultaneity in simplified mode to 2-3 clean voicing notes (bass + fifth/shell)
            # ordered smoothly near previous LH center
            max_lh_notes = 2 if norm_smoothing == "simplified" else 3
            if len(kept_lh) > max_lh_notes:
                bass_n = kept_lh[0]
                root_pc_eff = chord_root_pc if chord_root_pc is not None else (bass_n.pitch_midi % 12)
                fifth_pc = (root_pc_eff + 7) % 12
                ranked_upper = sorted(
                    kept_lh[1:],
                    key=lambda n: (
                        2 if (n.pitch_midi % 12) in (root_pc_eff, fifth_pc) else (1 if (n.pitch_midi % 12) in chord_pcs else 0),
                        -abs(n.pitch_midi - prev_lh_center) * 0.25,
                        n.velocity,
                    ),
                    reverse=True,
                )
                lh_voicing_cleaned += len(kept_lh) - max_lh_notes
                kept_lh = [bass_n, *ranked_upper[: max_lh_notes - 1]]

            lh_notes = sorted(kept_lh, key=lambda n: n.pitch_midi)

        if rh_notes:
            max_rh_span = max(max_rh_span, _slice_span(rh_notes))
        if lh_notes:
            max_lh_span = max(max_lh_span, _slice_span(lh_notes))
            lh_mean = sum(n.pitch_midi for n in lh_notes) / float(len(lh_notes))
            prev_lh_center = 0.65 * prev_lh_center + 0.35 * lh_mean

        output_notes.extend(lh_notes)
        output_notes.extend(rh_notes)

    output_notes.sort(key=lambda n: (n.onset_sec, n.pitch_midi))
    return PlayabilityResult(
        notes=output_notes,
        stats={
            "smoothing": norm_smoothing,
            "applied": True,
            "input_count": len(cloned),
            "output_count": len(output_notes),
            "rh_cluster_pruned": rh_cluster_pruned,
            "lh_voicing_cleaned": lh_voicing_cleaned,
            "hand_span_violations_fixed": hand_span_violations_fixed,
            "max_rh_span": max_rh_span,
            "max_lh_span": max_lh_span,
        },
    )
