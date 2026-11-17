from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field


class TranscriptionSettings(BaseModel):
    mode: str = Field(default="single_instrument")
    instrument: str = Field(default="piano")
    arrangement_detail: Literal["simple", "balanced", "detailed"] = Field(default="balanced")
    tempo_mode: str = Field(default="auto")  # auto | manual
    manual_tempo_bpm: float | None = Field(default=None, ge=30, le=300)
    time_signature: str = Field(default="auto")  # auto | 4/4 | 3/4 | 6/8 | 2/4
    key_signature: str = Field(default="auto")  # auto | C | G | D | ...
    concert_pitch_hz: float = Field(default=440.0, ge=415.0, le=466.0)
    transpose_semitones: int = Field(default=0, ge=-24, le=24)
    quantization: str = Field(default="sixteenth")  # none | quarter | eighth | eighth_triplet | sixteenth | thirtysecond
    onset_threshold: float = Field(default=0.5, ge=0.1, le=0.95)
    frame_threshold: float = Field(default=0.3, ge=0.1, le=0.95)
    min_note_length_ms: float = Field(default=58.0, ge=20.0, le=500.0)
    min_midi_pitch: int = Field(default=21, ge=0, le=127)
    max_midi_pitch: int = Field(default=108, ge=0, le=127)
    enable_source_separation: bool = Field(default=False)


class TranscriptionCreateRequest(BaseModel):
    source_asset_id: str | None = None
    settings: TranscriptionSettings = Field(default_factory=TranscriptionSettings)


class TranscriptionJobResponse(BaseModel):
    id: str
    project_id: str
    user_id: str
    source_asset_id: str | None = None
    status: str
    progress: int
    current_stage: str
    engine: str
    settings_json: dict[str, Any]
    error_code: str | None = None
    error_message: str | None = None
    started_at: datetime | None = None
    completed_at: datetime | None = None
    created_at: datetime
    worker_online: bool | None = None

    model_config = {"from_attributes": True}
