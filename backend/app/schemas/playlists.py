import re
from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator

YOUTUBE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")
ALLOWED_PLAYBACK_RATES = {0.5, 0.75, 0.85, 1.0, 1.25}


def _validate_safe_http_url(url: str | None) -> str | None:
    if url is None:
        return None
    cleaned = url.strip()
    if not cleaned:
        return None
    if cleaned.lower().startswith("data:") or not cleaned.lower().startswith(("http://", "https://")):
        raise ValueError("URLs must use http:// or https:// and must not contain embedded data URIs.")
    return cleaned


class TrackLoopMarkersSchema(BaseModel):
    aSec: float | None = Field(default=None, ge=0.0, le=86400.0)
    bSec: float | None = Field(default=None, ge=0.0, le=86400.0)

    @model_validator(mode="after")
    def _validate_range(self) -> "TrackLoopMarkersSchema":
        if self.aSec is not None and self.bSec is not None and self.bSec <= self.aSec:
            raise ValueError("Loop end time (B) must be greater than loop start time (A).")
        return self


class PlaylistCategorySchema(BaseModel):
    id: str = Field(min_length=1, max_length=80)
    name: str = Field(min_length=1, max_length=60)
    isDefault: bool = False

    @field_validator("id", "name")
    @classmethod
    def _strip_non_empty(cls, value: str) -> str:
        trimmed = value.strip()
        if not trimmed:
            raise ValueError("Field cannot be empty.")
        return trimmed


class PlaylistTrackSchema(BaseModel):
    id: str = Field(min_length=1, max_length=80)
    sourceType: Literal["youtube", "project_audio"]
    title: str = Field(min_length=1, max_length=200)
    artist: str = Field(default="", max_length=160)
    categoryId: str = Field(default="cat-practice-reference", min_length=1, max_length=80)
    thumbnailUrl: str | None = Field(default=None, max_length=512)
    practiceNotes: str = Field(default="", max_length=2000)
    loop: TrackLoopMarkersSchema = Field(default_factory=TrackLoopMarkersSchema)
    youtubeVideoId: str | None = Field(default=None, max_length=32)
    youtubeUrl: str | None = Field(default=None, max_length=512)
    projectId: str | None = Field(default=None, max_length=64)
    mediaAssetId: str | None = Field(default=None, max_length=64)
    projectTitle: str | None = Field(default=None, max_length=200)
    mediaFilename: str | None = Field(default=None, max_length=255)
    mediaMimeType: str | None = Field(default=None, max_length=128)
    durationSec: float | None = Field(default=None, ge=0.0, le=86400.0)
    addedAt: str = Field(min_length=1, max_length=64)
    updatedAt: str = Field(min_length=1, max_length=64)

    @field_validator("title")
    @classmethod
    def _clean_title(cls, value: str) -> str:
        trimmed = value.strip()
        if not trimmed:
            raise ValueError("Track title cannot be empty.")
        return trimmed

    @field_validator("thumbnailUrl", "youtubeUrl")
    @classmethod
    def _validate_urls(cls, value: str | None) -> str | None:
        return _validate_safe_http_url(value)

    @model_validator(mode="after")
    def _validate_source_fields(self) -> "PlaylistTrackSchema":
        if self.sourceType == "youtube":
            if not self.youtubeVideoId or not YOUTUBE_ID_RE.match(self.youtubeVideoId.strip()):
                raise ValueError("YouTube tracks require a valid 11-character youtubeVideoId.")
            self.youtubeVideoId = self.youtubeVideoId.strip()
        elif self.sourceType == "project_audio":
            if not self.projectId or not self.projectId.strip():
                raise ValueError("Project audio tracks require a valid projectId.")
            self.projectId = self.projectId.strip()
        return self


class PlayerPreferencesSchema(BaseModel):
    shuffle: bool = False
    autoAdvance: bool = True
    playbackRate: float = 1.0
    miniPlayerEnabled: bool = False

    @field_validator("playbackRate")
    @classmethod
    def _validate_rate(cls, value: float) -> float:
        if float(value) not in ALLOWED_PLAYBACK_RATES:
            raise ValueError("Playback rate must be one of 0.5, 0.75, 0.85, 1.0, or 1.25.")
        return float(value)


class PlaylistItemSchema(BaseModel):
    id: str = Field(min_length=1, max_length=80)
    serverId: str | None = Field(default=None, max_length=36)
    title: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=2000)
    categoryId: str = Field(default="cat-practice-reference", min_length=1, max_length=80)
    tracks: list[PlaylistTrackSchema] = Field(default_factory=list, max_length=300)
    isShared: bool = False
    shareToken: str | None = Field(default=None, max_length=96)
    sharedAt: str | None = Field(default=None, max_length=64)
    createdAt: str = Field(min_length=1, max_length=64)
    updatedAt: str = Field(min_length=1, max_length=64)

    @field_validator("title")
    @classmethod
    def _clean_playlist_title(cls, value: str) -> str:
        trimmed = value.strip()
        if not trimmed:
            raise ValueError("Playlist title cannot be empty.")
        return trimmed


class PlaylistCreateRequest(BaseModel):
    id: str | None = Field(default=None, max_length=80)
    title: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=2000)
    categoryId: str = Field(default="cat-practice-reference", min_length=1, max_length=80)
    tracks: list[PlaylistTrackSchema] = Field(default_factory=list, max_length=300)

    @field_validator("title")
    @classmethod
    def _clean_create_title(cls, value: str) -> str:
        trimmed = value.strip()
        if not trimmed:
            raise ValueError("Playlist title cannot be empty.")
        return trimmed


class PlaylistUpdateRequest(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=2000)
    categoryId: str | None = Field(default=None, min_length=1, max_length=80)
    position: int | None = Field(default=None, ge=0, le=1000)
    tracks: list[PlaylistTrackSchema] | None = Field(default=None, max_length=300)

    @field_validator("title")
    @classmethod
    def _clean_update_title(cls, value: str | None) -> str | None:
        if value is None:
            return None
        trimmed = value.strip()
        if not trimmed:
            raise ValueError("Playlist title cannot be empty.")
        return trimmed


class PlaylistShareStatusResponse(BaseModel):
    playlistId: str
    serverId: str
    isShared: bool
    shareToken: str | None = None
    sharedAt: str | None = None


class PublicSharedTrackSchema(BaseModel):
    position: int
    title: str
    artist: str = ""
    sourceType: Literal["youtube", "project_audio"]
    thumbnailUrl: str | None = None
    practiceNotes: str = ""
    loop: TrackLoopMarkersSchema = Field(default_factory=TrackLoopMarkersSchema)
    youtubeVideoId: str | None = None
    youtubeUrl: str | None = None
    playablePublicly: bool = False
    unavailableReason: str | None = None


class PublicSharedPlaylistResponse(BaseModel):
    title: str
    description: str = ""
    categoryName: str = "Practice / Reference"
    sharedAt: str | None = None
    updatedAt: str
    tracks: list[PublicSharedTrackSchema] = Field(default_factory=list)


class PlaylistLibrarySyncRequest(BaseModel):
    schemaVersion: int = Field(default=1, ge=1, le=10)
    categories: list[PlaylistCategorySchema] = Field(default_factory=list, max_length=50)
    playlists: list[PlaylistItemSchema] = Field(default_factory=list, max_length=100)
    preferences: PlayerPreferencesSchema = Field(default_factory=PlayerPreferencesSchema)


class PlaylistLibraryResponse(BaseModel):
    schemaVersion: int = 1
    updatedAt: str
    categories: list[PlaylistCategorySchema]
    playlists: list[PlaylistItemSchema]
    preferences: PlayerPreferencesSchema
