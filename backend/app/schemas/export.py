from datetime import datetime

from pydantic import BaseModel, Field


class ExportCreateRequest(BaseModel):
    format: str = Field(pattern="^(midi|musicxml|pdf|wav)$")
    include_chords: bool = True


class ExportResponse(BaseModel):
    id: str
    project_id: str
    format: str
    status: str
    error_message: str | None = None
    download_url: str | None = None
    created_at: datetime
    completed_at: datetime | None = None

    model_config = {"from_attributes": True}
