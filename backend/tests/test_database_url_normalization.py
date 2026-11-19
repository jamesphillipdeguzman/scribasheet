"""Tests for shared Psycopg 3 database URL normalization."""

from app.db.session import normalize_database_url


def test_normalize_database_url_converts_postgres_schemes_and_preserves_params():
    assert (
        normalize_database_url(
            "postgres://user:pass@ep-host-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require"
        )
        == "postgresql+psycopg://user:pass@ep-host-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require"
    )
    assert (
        normalize_database_url(
            "postgresql://user:pass@ep-host-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require"
        )
        == "postgresql+psycopg://user:pass@ep-host-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require"
    )
    already = "postgresql+psycopg://user:pass@ep-host-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require"
    assert normalize_database_url(already) == already


def test_normalize_database_url_preserves_sqlite():
    assert normalize_database_url("sqlite:///./scribasheet.db") == "sqlite:///./scribasheet.db"
    assert normalize_database_url("sqlite:////data/scribasheet.db") == "sqlite:////data/scribasheet.db"
