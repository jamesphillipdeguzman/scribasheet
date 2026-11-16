from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

_BACKEND_DIR = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(str(_BACKEND_DIR / ".env"), ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    APP_NAME: str = "ScribaSheet"
    ENVIRONMENT: Literal["development", "testing", "production"] = "development"
    DEBUG: bool = True
    API_V1_PREFIX: str = "/api/v1"
    FRONTEND_URL: str = "http://localhost:5173"
    BACKEND_CORS_ORIGINS: list[str] = Field(
        default_factory=lambda: ["http://localhost:5173", "http://127.0.0.1:5173"]
    )

    # Security & Authentication
    JWT_SECRET_KEY: str = "dev-only-insecure-secret-change-in-production-9f8e7d6c5b4a"
    JWT_ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60
    REFRESH_TOKEN_EXPIRE_DAYS: int = 7

    # Optional Supabase Auth
    SUPABASE_URL: str = ""
    SUPABASE_ANON_KEY: str = ""
    SUPABASE_SERVICE_ROLE_KEY: str = ""
    SUPABASE_JWT_SECRET: str = ""

    # Database
    DATABASE_URL: str = "sqlite:///./scribasheet.db"

    # Background Jobs
    JOB_EXECUTION_MODE: Literal["local", "celery", "remote_worker"] = "local"
    WORKER_API_TOKEN: str = ""
    WORKER_LEASE_SECONDS: int = 120
    MAX_JOB_ATTEMPTS: int = 3
    REDIS_URL: str = "redis://localhost:6379/0"
    CELERY_BROKER_URL: str = "redis://localhost:6379/0"
    CELERY_RESULT_BACKEND: str = "redis://localhost:6379/1"
    TRANSCRIPTION_TASK_TIMEOUT_SECONDS: int = 600
    MAX_CONCURRENT_TRANSCRIPTIONS: int = 2

    # Storage
    STORAGE_BACKEND: Literal["local", "s3", "supabase"] = "local"
    LOCAL_STORAGE_ROOT: str = "./storage_data"
    SIGNED_URL_SECRET: str = "dev-only-signed-url-secret-change-in-production"
    SIGNED_URL_TTL_SECONDS: int = 900
    S3_PRESIGNED_PUT_TTL_SECONDS: int = 900

    S3_ENDPOINT_URL: str = ""
    S3_BUCKET_NAME: str = "scribasheet-private"
    S3_ACCESS_KEY_ID: str = ""
    S3_SECRET_ACCESS_KEY: str = ""
    S3_REGION: str = "us-east-1"

    # Media & AI
    MAX_UPLOAD_SIZE_MB: int = 100
    MAX_AUDIO_DURATION_SECONDS: int = 900
    FFMPEG_BINARY: str = "ffmpeg"
    ENABLE_SOURCE_SEPARATION: bool = False
    SOURCE_SEPARATION_BACKEND: str = "none"

    # Billing (Stripe)
    STRIPE_SECRET_KEY: str = ""
    STRIPE_WEBHOOK_SECRET: str = ""
    STRIPE_PRO_PRICE_ID: str = ""
    STRIPE_STUDIO_PRICE_ID: str = ""

    @property
    def storage_root_path(self) -> Path:
        # In production on Railway, prefer /data/storage_data if /data volume is mounted
        # and LOCAL_STORAGE_ROOT was not overridden to a custom path.
        if (
            self.ENVIRONMENT == "production"
            and self.LOCAL_STORAGE_ROOT == "./storage_data"
            and Path("/data").exists()
        ):
            path = Path("/data/storage_data").resolve()
        else:
            path = Path(self.LOCAL_STORAGE_ROOT).resolve()
        path.mkdir(parents=True, exist_ok=True)
        return path

    @property
    def max_upload_bytes(self) -> int:
        return self.MAX_UPLOAD_SIZE_MB * 1024 * 1024


@lru_cache
def get_settings() -> Settings:
    return Settings()
