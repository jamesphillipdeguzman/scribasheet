"""Pydantic schemas for automatic song lyrics transcription and editing."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


class LyricWord(BaseModel):
    text: str
    start_sec: float = Field(ge=0.0)
    end_sec: float = Field(ge=0.0)
    confidence: float | None = Field(default=None, ge=0.0, le=1.0)
    needs_review: bool = False


class LyricSegment(BaseModel):
    id: str
    text: str
    start_sec: float = Field(ge=0.0)
    end_sec: float = Field(ge=0.0)
    confidence: float | None = Field(default=None, ge=0.0, le=1.0)
    needs_review: bool = False
    words: list[LyricWord] = Field(default_factory=list)


class LyricsData(BaseModel):
    text: str = ""
    segments: list[LyricSegment] = Field(default_factory=list)
    language: str | None = None
    language_probability: float | None = Field(default=None, ge=0.0, le=1.0)
    source_used: Literal["vocals_stem", "original_audio", "manual"] = "original_audio"
    demucs_requested: bool = False
    demucs_fallback_used: bool = False
    model_name: str = "small"
    device: str = "cpu"
    has_word_timestamps: bool = False
    uncertain_segments: list[dict[str, Any]] = Field(default_factory=list)
    manually_edited: bool = False
    updated_at: str | None = None


class LyricsUpdateRequest(BaseModel):
    text: str
    segments: list[LyricSegment] | None = None
    language: str | None = None


class LyricsTranscribeRequest(BaseModel):
    enable_source_separation: bool = False
    whisper_model: str = Field(default="small")
    language: str | None = None
    force_overwrite: bool = False
