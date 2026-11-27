from typing import Literal

from pydantic import BaseModel, Field, field_validator

from app.schemas.common import UTCDatetime


class ProjectCreateRequest(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=2000)
    instrument: str = Field(default="piano", max_length=64)
    transcription_mode: str = Field(default="single_instrument", max_length=64)


class PlaygroundProjectCreateRequest(BaseModel):
    title: str = Field(default="Untitled Playground", min_length=1, max_length=120)
    description: str = Field(default="", max_length=2000)
    key_signature: str = Field(default="C Major", max_length=32)
    time_signature: str = Field(default="4/4", max_length=16)
    tempo_bpm: float = Field(default=120.0, ge=30.0, le=240.0)
    clef_mode: Literal["grand", "treble", "bass"] = "grand"
    measures: int = Field(default=4, ge=1, le=64)
    pickup_beats: float | None = Field(default=None, ge=0.0, le=12.0)

    @field_validator("title")
    @classmethod
    def _validate_playground_title(cls, value: str) -> str:
        trimmed = value.strip()
        if not trimmed:
            raise ValueError("Project title cannot be empty.")
        return trimmed


class PlaygroundCopyRequest(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=120)

    @field_validator("title")
    @classmethod
    def _validate_copy_title(cls, value: str | None) -> str | None:
        if value is None:
            return None
        trimmed = value.strip()
        if not trimmed:
            raise ValueError("Project title cannot be empty.")
        return trimmed


class ProjectUpdateRequest(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=2000)
    instrument: str | None = Field(default=None, max_length=64)
    transcription_mode: str | None = Field(default=None, max_length=64)

    @field_validator("title")
    @classmethod
    def _validate_title(cls, value: str | None) -> str | None:
        if value is None:
            return None
        trimmed = value.strip()
        if not trimmed:
            raise ValueError("Project title cannot be empty.")
        if len(trimmed) > 120:
            raise ValueError("Project title must be 120 characters or fewer.")
        return trimmed


class MediaAssetResponse(BaseModel):
    id: str
    project_id: str
    asset_type: str
    original_filename: str
    mime_type: str
    size_bytes: int
    duration_seconds: float | None = None
    sample_rate: int | None = None
    channels: int | None = None
    created_at: UTCDatetime

    model_config = {"from_attributes": True}


class ProjectResponse(BaseModel):
    id: str
    user_id: str
    title: str
    description: str
    status: str
    instrument: str
    transcription_mode: str
    duration_seconds: float | None = None
    created_at: UTCDatetime
    updated_at: UTCDatetime
    media_assets: list[MediaAssetResponse] = Field(default_factory=list)

    model_config = {"from_attributes": True}


class ProjectListResponse(BaseModel):
    items: list[ProjectResponse]
    total: int
    page: int
    page_size: int


class ExtractAudioRequest(BaseModel):
    formats: list[Literal["mp3", "wav"]] = Field(default_factory=lambda: ["mp3", "wav"], min_length=1, max_length=2)
    force: bool = False


class ExtractedAudioItem(BaseModel):
    id: str
    format: Literal["mp3", "wav"]
    filename: str
    mime_type: str
    size_bytes: int
    duration_seconds: float | None = None
    sample_rate: int | None = None
    channels: int | None = None
    download_url: str


class ExtractAudioResponse(BaseModel):
    source_asset_id: str
    mp3: ExtractedAudioItem | None = None
    wav: ExtractedAudioItem | None = None
    assets: list[MediaAssetResponse] = Field(default_factory=list)
