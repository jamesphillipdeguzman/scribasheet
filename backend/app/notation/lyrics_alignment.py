"""Non-destructive lyric-to-melody alignment for MusicXML engraving."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from app.schemas.lyrics import LyricsData
from app.schemas.score import ScoreNote

_VOWEL_GROUP_RE = re.compile(
    r"(?:ng|[^aeiouyAEIOUY])*[aeiouyAEIOUY]+(?:(?:ng|[^aeiouyAEIOUY])+(?=$|[^aeiouyAEIOUY]))?"
)
_TAGALOG_VOWEL_RE = re.compile(
    r"(?:ng|[^aeiouAEIOU])*[aeiouAEIOU](?:(?:ng|[^aeiouAEIOU])+(?=$|[^aeiouAEIOU]))?"
)


@dataclass
class LyricAlignmentItem:
    text: str
    syllabic: str  # single | begin | middle | end
    extend: bool = False


@dataclass
class LyricAlignmentResult:
    note_lyrics: dict[str, LyricAlignmentItem] = field(default_factory=dict)
    by_onset_sec: list[tuple[float, LyricAlignmentItem]] = field(default_factory=list)
    uncertain_segments: list[dict[str, Any]] = field(default_factory=list)
    matched_count: int = 0
    total_syllables: int = 0


def split_word_into_syllables(word: str, *, language: str | None = None) -> list[str]:
    """Split a word into syllables, respecting explicit hyphens and English/Tagalog rules."""
    cleaned = word.strip()
    if not cleaned:
        return []

    prefix_match = re.match(r"^([^\w]+)", cleaned)
    suffix_match = re.search(r"([^\w]+)$", cleaned)
    prefix = prefix_match.group(1) if prefix_match else ""
    suffix = suffix_match.group(1) if suffix_match else ""
    core = re.sub(r"^[^\w]+|[^\w]+$", "", cleaned)
    if not core:
        return [cleaned]

    # 1. Respect explicit user-provided syllable breaks / hyphens (e.g., "na-pa-ra", "beau-ti-ful")
    if "-" in core:
        parts = [p for p in core.split("-") if p]
        if parts:
            parts[0] = prefix + parts[0]
            parts[-1] = parts[-1] + suffix
            return parts

    # Preserve non-Latin scripts (e.g. CJK) and very short words intact
    if len(core) <= 2 or not all(ord(ch) < 256 for ch in core):
        return [cleaned]
    if not re.search(r"[aeiouyAEIOUY]", core):
        return [cleaned]

    lang_norm = (language or "").strip().lower()
    is_tagalog = lang_norm in ("tl", "fil", "tagalog", "filipino")

    if is_tagalog:
        # Tagalog/Filipino: each vowel typically forms its own syllable nucleus (e.g., pa-ra-an, ka-i-bi-gan)
        parts = [m.group(0) for m in _TAGALOG_VOWEL_RE.finditer(core) if m.group(0)]
    else:
        # English / general Latin: handle silent trailing -e (e.g., love, grace, time)
        working_core = core
        silent_e = (
            len(core) >= 4
            and core.lower().endswith("e")
            and not core.lower().endswith(("le", "ye"))
            and re.search(r"[aeiouy][^aeiouy]e$", core.lower()) is not None
        )
        if silent_e:
            working_core = core[:-1]
        parts = [m.group(0) for m in _VOWEL_GROUP_RE.finditer(working_core) if m.group(0)]
        if silent_e and parts:
            parts[-1] = parts[-1] + core[-1]

    if len(parts) <= 1:
        return [cleaned]
    if prefix:
        parts[0] = prefix + parts[0]
    if suffix:
        parts[-1] = parts[-1] + suffix
    return parts


def align_lyrics_to_notes(
    lyrics: LyricsData,
    melody_notes: list[ScoreNote],
    *,
    max_match_distance_sec: float = 0.42,
) -> LyricAlignmentResult:
    """Align lyric words/syllables to melody note onsets without altering note timing or pitches."""
    ordered_notes = sorted(melody_notes, key=lambda n: (n.onset_sec, n.pitch_midi))
    if not ordered_notes:
        return LyricAlignmentResult()

    # Build timed syllable tokens: (target_start_sec, target_end_sec, item)
    timed_tokens: list[tuple[float, float, LyricAlignmentItem]] = []
    lang = lyrics.language
    for seg in lyrics.segments:
        if seg.words:
            for w in seg.words:
                if w.confidence is not None and w.confidence < 0.15:
                    continue
                sylls = split_word_into_syllables(w.text, language=lang)
                if not sylls:
                    continue
                span = max(0.05, w.end_sec - w.start_sec)
                step = span / len(sylls)
                for i, syl in enumerate(sylls):
                    syllabic = (
                        "single"
                        if len(sylls) == 1
                        else ("begin" if i == 0 else ("end" if i == len(sylls) - 1 else "middle"))
                    )
                    syl_start = w.start_sec + i * step
                    syl_end = syl_start + step
                    timed_tokens.append((syl_start, syl_end, LyricAlignmentItem(text=syl, syllabic=syllabic)))
        else:
            if seg.end_sec <= seg.start_sec:
                continue
            words = [w for w in seg.text.split() if w.strip()]
            if not words:
                continue
            syll_tokens: list[LyricAlignmentItem] = []
            for w in words:
                sylls = split_word_into_syllables(w, language=lang)
                for i, syl in enumerate(sylls):
                    syllabic = (
                        "single"
                        if len(sylls) == 1
                        else ("begin" if i == 0 else ("end" if i == len(sylls) - 1 else "middle"))
                    )
                    syll_tokens.append(LyricAlignmentItem(text=syl, syllabic=syllabic))
            if not syll_tokens:
                continue
            span = max(0.1, seg.end_sec - seg.start_sec)
            step = span / len(syll_tokens)
            for i, item in enumerate(syll_tokens):
                syl_start = seg.start_sec + i * step
                syl_end = syl_start + step
                timed_tokens.append((syl_start, syl_end, item))

    if not timed_tokens:
        return LyricAlignmentResult(
            uncertain_segments=[
                {"text": lyrics.text.strip(), "target_sec": 0.0, "reason": "missing_timestamps"}
            ]
            if lyrics.text.strip()
            else [],
            total_syllables=0,
        )

    note_lyrics: dict[str, LyricAlignmentItem] = {}
    by_onset_sec: list[tuple[float, LyricAlignmentItem]] = []
    uncertain: list[dict[str, Any]] = []
    used_note_indices: set[int] = set()
    search_start = 0

    for tok_idx, (target_sec, target_end_sec, item) in enumerate(timed_tokens):
        next_target_sec = timed_tokens[tok_idx + 1][0] if tok_idx + 1 < len(timed_tokens) else float("inf")
        best_idx: int | None = None
        best_dist = float("inf")
        for idx in range(search_start, len(ordered_notes)):
            if idx in used_note_indices:
                continue
            dist = abs(ordered_notes[idx].onset_sec - target_sec)
            if dist < best_dist:
                best_dist = dist
                best_idx = idx
            if ordered_notes[idx].onset_sec - target_sec > max_match_distance_sec:
                break

        if best_idx is not None and best_dist <= max_match_distance_sec:
            matched_note = ordered_notes[best_idx]
            # Avoid stealing a note that clearly belongs to the next syllable's onset
            if (
                next_target_sec < float("inf")
                and best_dist > 0.20
                and abs(matched_note.onset_sec - next_target_sec) + 0.12 < best_dist
            ):
                uncertain.append(
                    {
                        "text": item.text,
                        "target_sec": round(target_sec, 3),
                        "reason": "no_nearby_melody_onset",
                    }
                )
                continue
            # Detect melisma: syllable spans additional melody notes before the next syllable's onset
            melisma_last_idx = best_idx
            for m_idx in range(best_idx + 1, len(ordered_notes)):
                cand = ordered_notes[m_idx]
                if cand.onset_sec <= target_end_sec - 0.04 and cand.onset_sec < next_target_sec - 0.08:
                    melisma_last_idx = m_idx
                    used_note_indices.add(m_idx)
                else:
                    break
            if melisma_last_idx > best_idx and item.syllabic in ("single", "end"):
                item = LyricAlignmentItem(text=item.text, syllabic=item.syllabic, extend=True)

            note_lyrics[matched_note.id] = item
            by_onset_sec.append((matched_note.onset_sec, item))
            used_note_indices.add(best_idx)
            search_start = melisma_last_idx + 1
        else:
            uncertain.append(
                {
                    "text": item.text,
                    "target_sec": round(target_sec, 3),
                    "reason": "no_nearby_melody_onset",
                }
            )

    return LyricAlignmentResult(
        note_lyrics=note_lyrics,
        by_onset_sec=by_onset_sec,
        uncertain_segments=uncertain,
        matched_count=len(note_lyrics),
        total_syllables=len(timed_tokens),
    )
