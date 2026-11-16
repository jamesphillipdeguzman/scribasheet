import os
import tempfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

# Configure isolated test environment before importing app
_test_dir = Path(tempfile.mkdtemp(prefix="scriba_test_"))
os.environ["ENVIRONMENT"] = "testing"
os.environ["DATABASE_URL"] = f"sqlite:///{_test_dir / 'test.db'}"
os.environ["LOCAL_STORAGE_ROOT"] = str(_test_dir / "storage")
os.environ["JOB_EXECUTION_MODE"] = "local"
os.environ["JWT_SECRET_KEY"] = "test-secret-key-for-pytest-only-1234567890"

from app.core.config import get_settings  # noqa: E402

get_settings.cache_clear()

from app.db.session import Base, get_db  # noqa: E402
from app.main import app  # noqa: E402

engine = create_engine(
    os.environ["DATABASE_URL"],
    connect_args={"check_same_thread": False},
    future=True,
)
TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


@pytest.fixture(scope="session", autouse=True)
def setup_database():
    Base.metadata.create_all(bind=engine)
    yield
    Base.metadata.drop_all(bind=engine)


@pytest.fixture()
def db_session():
    db = TestingSessionLocal()
    try:
        yield db
    finally:
        db.close()


@pytest.fixture()
def client(db_session):
    def override_get_db():
        try:
            yield db_session
        finally:
            pass

    app.dependency_overrides[get_db] = override_get_db
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()
