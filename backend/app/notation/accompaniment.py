"""Intelligent piano accompaniment generation from harmonic & stem analysis."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

import music21

from app.schemas.score import ScoreChord
from app.transcription.base import DetectedNote

ArrangementDetail = Literal["simple", "balanced", "detailed"]

_PITCH_CLASS_MAP = {
    "C": 0,
    "B#": 0,
    "C#": 1,
    "DB": 1,
    "D": 2,
    "D#": 3,
    "EB": 3,
    "E": 4,
    "FB": 4,
    "E#": 5,
    "F": 5,
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
class AccompanimentResult:
    """Generated lower-staff piano accompaniment notes and diagnostics."""

    notes: list[DetectedNote]
    arrangement_detail: ArrangementDetail
    stats: dict[str, Any] = field(default_factory=dict)


def _parse_chord_pitches(chord: ScoreChord) -> tuple[int, list[int]]:
    """Return (bass_pc, chord_pcs) for a ScoreChord using music21 with safe fallback."""
    symbol = (chord.symbol or "").strip()
    if symbol:
        try:
            cs = music21.harmony.ChordSymbol(symbol)
            pcs = [int(p.pitchClass) for p in cs.pitches]
            bass_pc = int(cs.bass().pitchClass) if cs.bass() is not None else pcs[0]
            if pcs:
                return bass_pc, list(dict.fromkeys(pcs))
        except Exception:
            pass

    root_name = (chord.root or "C").strip().upper().replace("♭", "B").replace("♯", "#")
    root_pc = _PITCH_CLASS_MAP.get(root_name, 0)
    quality = (chord.quality or "major").lower()
    if "min" in quality or quality == "m":
        intervals = [0, 3, 7]
    elif "dim" in quality:
        intervals = [0, 3, 6]
    elif "aug" in quality:
        intervals = [0, 4, 8]
    elif "sus4" in quality:
        intervals = [0, 5, 7]
    elif "sus2" in quality:
        intervals = [0, 2, 7]
    elif "7" in quality:
        intervals = [0, 4, 7, 10]
    else:
        intervals = [0, 4, 7]
    return root_pc, [(root_pc + iv) % 12 for iv in intervals]


def _choose_bass_midi(
    bass_pc: int,
    preferred_low: int = 40,
    preferred_high: int = 55,
    reference_bass_notes: list[DetectedNote] | None = None,
    span_start: float = 0.0,
    span_end: float = 0.0,
) -> int:
    """Place a bass pitch class comfortably in E2-G3 (40-55), preserving legitimate original bass."""
    if reference_bass_notes and span_end > span_start:
        matching_orig = [
            n.pitch_midi
            for n in reference_bass_notes
            if n.pitch_midi % 12 == bass_pc
            and 33 <= n.pitch_midi <= 55
            and n.offset_sec > span_start + 0.02
            and n.onset_sec < span_end - 0.02
        ]
        if matching_orig:
            return min(matching_orig)

    candidates = [p for p in range(preferred_low, preferred_high + 1) if p % 12 == bass_pc]
    if candidates:
        return min(candidates, key=lambda p: abs(p - 47))
    return 40 + ((bass_pc - 4) % 12)


def _voice_lead_chord(
    chord_pcs: list[int],
    prev_center: float,
    max_upper_midi: int = 67,
    min_lower_midi: int = 48,
) -> list[int]:
    """Select a compact, voice-led chord voicing within a playable hand span (<= 12 semitones)."""
    pcs = chord_pcs[:4] if len(chord_pcs) > 4 else chord_pcs
    if not pcs:
        return [52, 55, 60]

    best_voicing: list[int] | None = None
    best_cost = float("inf")

    for base_oct in (3, 4):
        root_guess = (base_oct + 1) * 12 + pcs[0]
        # Build triad/tetrad around each inversion
        for inv_idx in range(len(pcs)):
            rotated = pcs[inv_idx:] + pcs[:inv_idx]
            voicing = [root_guess - (root_guess % 12) + rotated[0]]
            for pc in rotated[1:]:
                p = voicing[-1] + ((pc - voicing[-1]) % 12)
                if p == voicing[-1]:
                    p += 12
                voicing.append(p)
            # Try octave shifts to fit [min_lower_midi, max_upper_midi]
            for shift in (-12, 0, 12):
                shifted = [p + shift for p in voicing]
                if shifted[0] < min_lower_midi or shifted[-1] > max_upper_midi:
                    continue
                if shifted[-1] - shifted[0] > 12:
                    continue
                center = sum(shifted) / len(shifted)
                cost = abs(center - prev_center)
                if cost < best_cost:
                    best_cost = cost
                    best_voicing = shifted

    if best_voicing is not None:
        return best_voicing

    # Safe fallback triad above muddy C2 register
    base = 48 + pcs[0]
    fallback = [base]
    for pc in pcs[1:3]:
        p = fallback[-1] + ((pc - fallback[-1]) % 12)
        if p == fallback[-1]:
            p += 12
        fallback.append(p)
    while fallback[-1] > max_upper_midi and fallback[0] - 12 >= 43:
        fallback = [p - 12 for p in fallback]
    return fallback


def _melody_ceiling_at(
    melody_notes: list[DetectedNote],
    start_sec: float,
    end_sec: float,
) -> int:
    """Find a balanced upper bound for Piano RH accompaniment in a 3-staff Piano + Vocal score."""
    overlapping = [
        n.pitch_midi
        for n in melody_notes
        if n.offset_sec > start_sec + 0.02 and n.onset_sec < end_sec - 0.02
    ]
    if not overlapping:
        return 69
    lowest_melody = min(overlapping)
    # Keep Piano RH in a natural treble accompaniment register (D4-B4) without squashing it into LH
    return max(62, min(71, lowest_melody - 2 if lowest_melody >= 64 else 67))


def _deduplicate_overlaps(notes: list[DetectedNote]) -> list[DetectedNote]:
    """Prevent same-pitch overlapping notes in generated accompaniment."""
    ordered = sorted(notes, key=lambda n: (n.onset_sec, n.pitch_midi))
    last_by_pitch: dict[int, DetectedNote] = {}
    cleaned: list[DetectedNote] = []
    for n in ordered:
        if n.offset_sec <= n.onset_sec + 0.03:
            continue
        prev = last_by_pitch.get(n.pitch_midi)
        if prev is not None and prev.offset_sec > n.onset_sec - 0.01:
            if n.onset_sec - prev.onset_sec < 0.03:
                continue
            prev.offset_sec = max(prev.onset_sec + 0.04, n.onset_sec - 0.01)
        last_by_pitch[n.pitch_midi] = n
        cleaned.append(n)
    return cleaned


def generate_piano_accompaniment(
    *,
    chords: list[ScoreChord],
    melody_notes: list[DetectedNote],
    bass_notes: list[DetectedNote] | None = None,
    other_notes: list[DetectedNote] | None = None,
    tempo_bpm: float = 120.0,
    time_signature: str = "4/4",
    key_signature: str = "C major",
    duration_seconds: float = 0.0,
    arrangement_detail: ArrangementDetail = "balanced",
) -> AccompanimentResult:
    """Generate playable lower-staff piano accompaniment coordinated with chords and melody."""
    detail: ArrangementDetail = (
        arrangement_detail if arrangement_detail in ("simple", "balanced", "detailed") else "balanced"
    )
    beat_sec = 60.0 / max(30.0, float(tempo_bpm or 120.0))
    total_dur = max(
        float(duration_seconds or 0.0),
        max((n.offset_sec for n in melody_notes), default=0.0),
    )

    if not chords:
        # Do not fabricate harmonic progressions without harmonic evidence.
        if bass_notes and len(bass_notes) >= 2:
            sparse_bass = [
                DetectedNote(
                    pitch_midi=max(33, min(55, n.pitch_midi)),
                    onset_sec=n.onset_sec,
                    offset_sec=n.offset_sec,
                    velocity=max(52, min(78, n.velocity)),
                    confidence=n.confidence,
                )
                for n in bass_notes[:64]
            ]
            cleaned = _deduplicate_overlaps(sparse_bass)
            return AccompanimentResult(
                notes=cleaned,
                arrangement_detail=detail,
                stats={
                    "chord_count": 0,
                    "generated_note_count": len(cleaned),
                    "mode": "sparse_bass_fallback",
                },
            )
        return AccompanimentResult(
            notes=[],
            arrangement_detail=detail,
            stats={
                "chord_count": 0,
                "generated_note_count": 0,
                "skipped_reason": "insufficient_harmonic_confidence",
            },
        )

    ordered_chords = sorted(chords, key=lambda c: c.onset_sec)
    generated: list[DetectedNote] = []
    prev_center = 60.0

    # Expand long held-chord spans into <= 8-beat phrasing chunks so bass & accompaniment
    # continue smoothly across multi-measure sections instead of dropping out after 2 bars.
    chord_spans: list[tuple[ScoreChord, float, float]] = []
    max_chunk_sec = beat_sec * 8.0
    for idx, chord in enumerate(ordered_chords):
        full_start = max(0.0, float(chord.onset_sec))
        next_onset = float(ordered_chords[idx + 1].onset_sec) if idx + 1 < len(ordered_chords) else total_dur
        full_end = max(full_start + beat_sec * 0.5, next_onset)
        cursor = full_start
        while cursor < full_end - beat_sec * 0.35:
            chunk_end = min(full_end, cursor + max_chunk_sec)
            if full_end - chunk_end < beat_sec * 0.5:
                chunk_end = full_end
            chord_spans.append((chord, cursor, chunk_end))
            cursor = chunk_end

    for chord, span_start, span_end in chord_spans:
        span_dur = span_end - span_start
        if span_dur < beat_sec * 0.35:
            continue

        bass_pc, chord_pcs = _parse_chord_pitches(chord)
        bass_midi = _choose_bass_midi(
            bass_pc,
            reference_bass_notes=bass_notes,
            span_start=span_start,
            span_end=span_end,
        )
        ceiling = _melody_ceiling_at(melody_notes, span_start, span_end)
        voicing = _voice_lead_chord(chord_pcs, prev_center, max_upper_midi=ceiling, min_lower_midi=53)
        if voicing:
            prev_center = sum(voicing) / len(voicing)

        if detail == "simple":
            # Root bass + sustained block chord (2-3 notes max)
            simple_voicing = voicing[:2] if len(voicing) > 2 else voicing
            hold_end = max(span_start + 0.15, span_end - 0.03)
            generated.append(
                DetectedNote(
                    pitch_midi=bass_midi,
                    onset_sec=round(span_start, 4),
                    offset_sec=round(hold_end, 4),
                    velocity=68,
                    confidence=chord.confidence,
                )
            )
            for p in simple_voicing:
                if p == bass_midi:
                    continue
                generated.append(
                    DetectedNote(
                        pitch_midi=p,
                        onset_sec=round(span_start, 4),
                        offset_sec=round(hold_end, 4),
                        velocity=60,
                        confidence=chord.confidence,
                    )
                )
        elif detail == "balanced":
            # Pop accompaniment: bass on beat 1, gentle chord pulse on beat subdivisions
            generated.append(
                DetectedNote(
                    pitch_midi=bass_midi,
                    onset_sec=round(span_start, 4),
                    offset_sec=round(max(span_start + 0.15, span_end - 0.03), 4),
                    velocity=72,
                    confidence=chord.confidence,
                )
            )
            step = beat_sec
            t = span_start
            pulse_idx = 0
            while t + 0.12 < span_end - 0.02:
                pulse_end = min(span_end - 0.02, t + step * 0.88)
                if pulse_idx % 2 == 0:
                    for p in voicing[:3]:
                        if abs(p - bass_midi) >= 3:
                            generated.append(
                                DetectedNote(
                                    pitch_midi=p,
                                    onset_sec=round(t, 4),
                                    offset_sec=round(pulse_end, 4),
                                    velocity=62,
                                    confidence=chord.confidence,
                                )
                            )
                else:
                    # Broken upper tone for gentle forward motion
                    p = voicing[-1]
                    if abs(p - bass_midi) >= 3:
                        generated.append(
                            DetectedNote(
                                pitch_midi=p,
                                onset_sec=round(t, 4),
                                offset_sec=round(pulse_end, 4),
                                velocity=56,
                                confidence=chord.confidence,
                            )
                        )
                t += step
                pulse_idx += 1
        else:
            # Detailed: sustained bass foundation + flowing eighth-note arpeggio & chord color
            generated.append(
                DetectedNote(
                    pitch_midi=bass_midi,
                    onset_sec=round(span_start, 4),
                    offset_sec=round(max(span_start + 0.15, span_end - 0.03), 4),
                    velocity=74,
                    confidence=chord.confidence,
                )
            )
            arp_seq = [p for p in voicing if p != bass_midi] or [bass_midi + 7]
            if len(arp_seq) >= 3:
                arp_seq = arp_seq + list(reversed(arp_seq[:-1]))
            step = beat_sec * 0.5
            t = span_start
            step_idx = 0
            while t + 0.08 < span_end - 0.015:
                note_end = min(span_end - 0.015, t + step * 0.92)
                p = arp_seq[step_idx % len(arp_seq)]
                vel = 68 if step_idx % 2 == 0 else 58
                generated.append(
                    DetectedNote(
                        pitch_midi=p,
                        onset_sec=round(t, 4),
                        offset_sec=round(note_end, 4),
                        velocity=vel,
                        confidence=chord.confidence,
                    )
                )
                if step_idx % 4 == 0:
                    for extra_p in voicing[:2]:
                        if extra_p not in (p, bass_midi):
                            generated.append(
                                DetectedNote(
                                    pitch_midi=extra_p,
                                    onset_sec=round(t, 4),
                                    offset_sec=round(min(span_end - 0.015, t + beat_sec * 0.9), 4),
                                    velocity=57,
                                    confidence=chord.confidence,
                                )
                            )
                t += step
                step_idx += 1

    cleaned = _deduplicate_overlaps(generated)
    return AccompanimentResult(
        notes=cleaned,
        arrangement_detail=detail,
        stats={
            "chord_count": len(ordered_chords),
            "generated_note_count": len(cleaned),
            "arrangement_detail": detail,
            "time_signature": time_signature,
            "key_signature": key_signature,
        },
    )
