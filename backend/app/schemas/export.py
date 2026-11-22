from pydantic import BaseModel, Field

from app.schemas.common import UTCDatetime


class ExportCreateRequest(BaseModel):
    format: str = Field(pattern="^(midi|musicxml|pdf|wav|soprano_mp3|alto_mp3|tenor_mp3|bass_mp3)$")
    include_chords: bool = True


class ExportResponse(BaseModel):
    id: str
    project_id: str
    format: str
    status: str
    error_message: str | None = None
    download_url: str | None = None
    created_at: UTCDatetime
    completed_at: UTCDatetime | None = None

    model_config = {"from_attributes": True}
