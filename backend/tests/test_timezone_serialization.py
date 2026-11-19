"""Tests for UTC database storage and explicit UTC ISO-8601 API serialization."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta, timezone

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.db.session import Base
from app.models.entities import Project, User, utcnow
from app.schemas.auth import UserResponse
from app.schemas.common import ensure_utc_datetime, serialize_utc_z
from app.schemas.export import ExportResponse
from app.schemas.project import ProjectResponse
from app.schemas.score import ProjectScoreResponse
from app.schemas.transcription import TranscriptionJobResponse


def test_serialize_utc_z_handles_naive_utc_and_offset_datetimes():
    naive = datetime(2026, 11, 17, 13, 11, 46)
    aware_utc = datetime(2026, 11, 17, 13, 11, 46, tzinfo=UTC)
    aware_manila = datetime(2026, 11, 17, 21, 11, 46, tzinfo=timezone(timedelta(hours=8)))
    aware_minus_five = datetime(2026, 11, 17, 8, 11, 46, tzinfo=timezone(timedelta(hours=-5)))

    assert serialize_utc_z(naive) == "2026-11-17T13:11:46Z"
    assert serialize_utc_z(aware_utc) == "2026-11-17T13:11:46Z"
    assert serialize_utc_z(aware_manila) == "2026-11-17T13:11:46Z"
    assert serialize_utc_z(aware_minus_five) == "2026-11-17T13:11:46Z"


def test_ensure_utc_datetime_returns_aware_utc():
    naive = datetime(2026, 11, 17, 18, 30, 0)
    normalized = ensure_utc_datetime(naive)
    assert normalized.tzinfo == UTC
    assert normalized.hour == 18


def test_utcnow_produces_timezone_aware_utc():
    now = utcnow()
    assert now.tzinfo == UTC


def test_response_schemas_serialize_all_datetimes_with_utc_z():
    naive_dt = datetime(2026, 11, 17, 16, 45, 0)
    manila_dt = datetime(2026, 11, 18, 0, 45, 0, tzinfo=timezone(timedelta(hours=8)))

    user_json = UserResponse(
        id="u-1",
        email="user@example.com",
        display_name="Test User",
        email_verified=True,
        plan_tier="free",
        created_at=naive_dt,
        updated_at=manila_dt,
    ).model_dump(mode="json")
    assert user_json["created_at"] == "2026-11-17T16:45:00Z"
    assert user_json["updated_at"] == "2026-11-17T16:45:00Z"

    project_json = ProjectResponse(
        id="p-1",
        user_id="u-1",
        title="Song",
        description="",
        status="ready",
        instrument="piano",
        transcription_mode="single_instrument",
        duration_seconds=12.0,
        created_at=naive_dt,
        updated_at=manila_dt,
    ).model_dump(mode="json")
    assert project_json["created_at"] == "2026-11-17T16:45:00Z"
    assert project_json["updated_at"] == "2026-11-17T16:45:00Z"

    job_json = TranscriptionJobResponse(
        id="j-1",
        project_id="p-1",
        status="completed",
        progress=100,
        current_stage="Completed",
        engine="basic_pitch",
        started_at=naive_dt,
        completed_at=manila_dt,
        created_at=naive_dt,
    ).model_dump(mode="json")
    assert job_json["started_at"] == "2026-11-17T16:45:00Z"
    assert job_json["completed_at"] == "2026-11-17T16:45:00Z"
    assert job_json["created_at"] == "2026-11-17T16:45:00Z"

    export_json = ExportResponse(
        id="e-1",
        project_id="p-1",
        format="pdf",
        status="completed",
        created_at=naive_dt,
        completed_at=manila_dt,
    ).model_dump(mode="json")
    assert export_json["created_at"] == "2026-11-17T16:45:00Z"
    assert export_json["completed_at"] == "2026-11-17T16:45:00Z"

    score_json = ProjectScoreResponse(
        id="s-1",
        project_id="p-1",
        version=1,
        score_json={},
        updated_at=naive_dt,
    ).model_dump(mode="json")
    assert score_json["updated_at"] == "2026-11-17T16:45:00Z"


def test_sqlite_naive_datetime_roundtrip_serializes_as_utc_z():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(bind=engine)

    with SessionLocal() as db:
        user = User(
            email="tz@example.com",
            password_hash="hashed",
            display_name="TZ User",
            created_at=datetime(2026, 11, 17, 18, 30, 0, tzinfo=UTC),
            updated_at=datetime(2026, 11, 17, 18, 30, 0, tzinfo=UTC),
        )
        db.add(user)
        db.flush()

        project = Project(
            user_id=user.id,
            title="Midnight Test",
            created_at=datetime(2026, 11, 17, 18, 30, 0, tzinfo=UTC),
            updated_at=datetime(2026, 11, 17, 18, 30, 0, tzinfo=UTC),
        )
        db.add(project)
        db.commit()
        db.refresh(user)
        db.refresh(project)

        # SQLite drops tzinfo on read; schemas must still emit explicit UTC Z.
        user_payload = UserResponse.model_validate(user).model_dump(mode="json")
        project_payload = ProjectResponse.model_validate(project).model_dump(mode="json")

        assert user_payload["created_at"] == "2026-11-17T18:30:00Z"
        assert project_payload["updated_at"] == "2026-11-17T18:30:00Z"
