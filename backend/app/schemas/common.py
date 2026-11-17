"""Shared Pydantic types for consistent UTC datetime serialization."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated

from pydantic import AfterValidator, PlainSerializer


def ensure_utc_datetime(dt: datetime) -> datetime:
    """Attach UTC tzinfo to naive datetimes or normalize aware datetimes to UTC."""
    if dt.tzinfo is None:
        return dt.replace(tzinfo=UTC)
    return dt.astimezone(UTC)


def serialize_utc_z(dt: datetime) -> str:
    """Serialize a datetime as an ISO-8601 UTC string with an explicit 'Z' suffix."""
    return ensure_utc_datetime(dt).isoformat().replace("+00:00", "Z")


UTCDatetime = Annotated[
    datetime,
    AfterValidator(ensure_utc_datetime),
    PlainSerializer(serialize_utc_z, return_type=str, when_used="json"),
]
