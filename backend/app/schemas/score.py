from typing import Any, Literal

from pydantic import BaseModel, Field

from app.schemas.common import UTCDatetime


class ScoreNote(BaseModel):
    id: str
    pitch_midi: int = Field(ge=0, le=127)
    onset_sec: float = Field(ge=0.0)
    offset_sec: float = Field(gt=0.0)
    raw_onset_sec: float | None = Field(default=None, ge=0.0)
    raw_offset_sec: float | None = Field(default=None, gt=0.0)
    velocity: int = Field(default=80, ge=1, le=127)
    confidence: float | None = Field(default=None, ge=0.0, le=1.0)
    track_index: int = Field(default=0, ge=0)
    string_num: int | None = Field(default=None, ge=1, le=6)
    fret_num: int | None = Field(default=None, ge=0, le=24)


class ScoreChord(BaseModel):
    id: str
    measure: int = Field(ge=1)
    beat: float = Field(ge=1.0)
    onset_sec: float = Field(ge=0.0)
    symbol: str
    root: str
    quality: str
    confidence: float | None = None


class ScoreTrack(BaseModel):
    index: int = 0
    name: str = "Piano"
    instrument: str = "piano"
    clef: str = "treble"  # treble | bass | grand
    program: int = 0
    muted: bool = False


class ScoreData(BaseModel):
    title: str = "Untitled Score"
    tempo_bpm: float = Field(default=120.0, ge=20.0, le=320.0)
    tempo_estimated: bool = True
    time_signature: str = "4/4"
    time_signature_estimated: bool = True
    key_signature: str = "C"
    key_signature_estimated: bool = True
    duration_seconds: float = Field(default=0.0, ge=0.0)
    tracks: list[ScoreTrack] = Field(default_factory=list)
    notes: list[ScoreNote] = Field(default_factory=list)
    chords: list[ScoreChord] = Field(default_factory=list)
    analysis: dict[str, Any] = Field(default_factory=dict)


class ProjectScoreResponse(BaseModel):
    id: str
    project_id: str
    version: int
    score_json: dict[str, Any]
    musicxml: str | None = None
    updated_at: UTCDatetime


class ProjectScoreUpdateRequest(BaseModel):
    expected_version: int | None = None
    score_json: ScoreData


class ArrangementRegenerateRequest(BaseModel):
    arrangement_detail: Literal["simple", "balanced", "detailed"] = "balanced"
    quantization: str | None = None
    mode: str | None = None
