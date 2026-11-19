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


@dataclass
class LyricAlignmentItem:
    text: str
    syllabic: str  # single | begin | middle | end


@dataclass
class LyricAlignmentResult:
    note_lyrics: dict[str, LyricAlignmentItem] = field(default_factory=dict)
    by_onset_sec: list[tuple[float, LyricAlignmentItem]] = field(default_factory=list)
    uncertain_segments: list[dict[str, Any]] = field(default_factory=list)
    matched_count: int = 0
    total_syllables: int = 0


def split_word_into_syllables(word: str) -> list[str]:
    """Split an ASCII/Latin word into rough phonetic syllables while preserving Unicode/CJK intact."""
    cleaned = word.strip()
    if not cleaned:
        return []
    # Preserve non-Latin scripts (e.g. CJK) intact; split Latin/Tagalog words >= 3 chars
    if len(cleaned) <= 2 or not all(ord(ch) < 256 for ch in cleaned):
        return [cleaned]
    core = re.sub(r"^[^\w]+|[^\w]+$", "", cleaned)
    if not core or not re.search(r"[aeiouyAEIOUY]", core):
        return [cleaned]
    parts = [m.group(0) for m in _VOWEL_GROUP_RE.finditer(core) if m.group(0)]
    if len(parts) <= 1:
        return [cleaned]
    # Re-attach leading/trailing punctuation
    prefix_match = re.match(r"^([^\w]+)", cleaned)
    suffix_match = re.search(r"([^\w]+)$", cleaned)
    if prefix_match:
        parts[0] = prefix_match.group(1) + parts[0]
    if suffix_match:
        parts[-1] = parts[-1] + suffix_match.group(1)
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

    # Build timed syllable tokens from word-level or segment-level timestamps
    timed_tokens: list[tuple[float, LyricAlignmentItem]] = []
    for seg in lyrics.segments:
        if seg.words:
            for w in seg.words:
                sylls = split_word_into_syllables(w.text)
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
                    timed_tokens.append((w.start_sec + i * step, LyricAlignmentItem(text=syl, syllabic=syllabic)))
        else:
            words = [w for w in seg.text.split() if w.strip()]
            if not words:
                continue
            syll_tokens: list[LyricAlignmentItem] = []
            for w in words:
                sylls = split_word_into_syllables(w)
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
                timed_tokens.append((seg.start_sec + i * step, item))

    if not timed_tokens and lyrics.text.strip():
        words = [w for w in lyrics.text.split() if w.strip()]
        total_span = max(1.0, ordered_notes[-1].offset_sec)
        step = total_span / max(1, len(words))
        for i, w in enumerate(words):
            timed_tokens.append((i * step, LyricAlignmentItem(text=w, syllabic="single")))

    note_lyrics: dict[str, LyricAlignmentItem] = {}
    by_onset_sec: list[tuple[float, LyricAlignmentItem]] = []
    uncertain: list[dict[str, Any]] = []
    used_note_indices: set[int] = set()
    search_start = 0

    for target_sec, item in timed_tokens:
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
            note_lyrics[matched_note.id] = item
            by_onset_sec.append((matched_note.onset_sec, item))
            used_note_indices.add(best_idx)
            search_start = best_idx + 1
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
