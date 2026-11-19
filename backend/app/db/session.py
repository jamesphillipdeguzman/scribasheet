from collections.abc import Generator

from sqlalchemy import create_engine, event
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.core.config import get_settings


class Base(DeclarativeBase):
    pass


def normalize_database_url(url: str) -> str:
    """Normalize PostgreSQL URLs to use the Psycopg 3 dialect while preserving query params and SQLite."""
    cleaned = (url or "").strip()
    if cleaned.startswith("postgres://"):
        return "postgresql+psycopg://" + cleaned[len("postgres://") :]
    if cleaned.startswith("postgresql://"):
        return "postgresql+psycopg://" + cleaned[len("postgresql://") :]
    return cleaned


def _create_engine():
    settings = get_settings()
    db_url = normalize_database_url(settings.DATABASE_URL)
    connect_args = {}
    is_sqlite = db_url.startswith("sqlite")
    if is_sqlite:
        connect_args = {"check_same_thread": False}
    eng = create_engine(
        db_url,
        connect_args=connect_args,
        pool_pre_ping=True,
        future=True,
    )
    if is_sqlite:
        @event.listens_for(eng, "connect")
        def _set_sqlite_pragmas(dbapi_connection, connection_record):
            cursor = dbapi_connection.cursor()
            cursor.execute("PRAGMA journal_mode=WAL;")
            cursor.execute("PRAGMA synchronous=NORMAL;")
            cursor.execute("PRAGMA foreign_keys=ON;")
            cursor.close()
    return eng


engine = _create_engine()
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine, class_=Session)


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
