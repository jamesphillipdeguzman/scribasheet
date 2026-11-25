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
        default_factory=lambda: [
            "http://localhost:5173",
            "http://127.0.0.1:5173",
            "https://scribasheet.vercel.app",
        ]
    )

    # Security & Authentication
    JWT_SECRET_KEY: str = "dev-only-insecure-secret-change-in-production-9f8e7d6c5b4a"
    JWT_ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60
    REFRESH_TOKEN_EXPIRE_DAYS: int = 7
    ADMIN_EMAILS: str = ""

    @property
    def admin_email_set(self) -> set[str]:
        return {
            email.strip().lower()
            for email in (self.ADMIN_EMAILS or "").split(",")
            if email.strip()
        }

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
    WORKER_HEARTBEAT_INTERVAL_SECONDS: int = 10
    WORKER_ONLINE_THRESHOLD_SECONDS: int = 45
    WORKER_BUSY_STALE_THRESHOLD_SECONDS: int = 90
    MAX_JOB_ATTEMPTS: int = 3
    REDIS_URL: str = "redis://localhost:6379/0"
    CELERY_BROKER_URL: str = "redis://localhost:6379/0"
    CELERY_RESULT_BACKEND: str = "redis://localhost:6379/1"
    TRANSCRIPTION_TASK_TIMEOUT_SECONDS: int = 600
    MAX_CONCURRENT_TRANSCRIPTIONS: int = 2

    # Storage
    STORAGE_BACKEND: Literal["local", "r2", "s3", "supabase"] = "local"
    LOCAL_STORAGE_ROOT: str = "./storage_data"
    SIGNED_URL_SECRET: str = "dev-only-signed-url-secret-change-in-production"
    SIGNED_URL_TTL_SECONDS: int = 900
    S3_PRESIGNED_PUT_TTL_SECONDS: int = 900

    # Cloudflare R2 (preferred) / S3-compatible fallback
    R2_BUCKET_NAME: str = ""
    R2_ENDPOINT_URL: str = ""
    R2_ACCESS_KEY_ID: str = ""
    R2_SECRET_ACCESS_KEY: str = ""

    S3_ENDPOINT_URL: str = ""
    S3_BUCKET_NAME: str = "scribasheet-private"
    S3_ACCESS_KEY_ID: str = ""
    S3_SECRET_ACCESS_KEY: str = ""
    S3_REGION: str = "us-east-1"

    @property
    def effective_s3_bucket(self) -> str:
        return (self.R2_BUCKET_NAME or self.S3_BUCKET_NAME).strip()

    @property
    def effective_s3_endpoint(self) -> str:
        return (self.R2_ENDPOINT_URL or self.S3_ENDPOINT_URL).strip()

    @property
    def effective_s3_access_key_id(self) -> str:
        return (self.R2_ACCESS_KEY_ID or self.S3_ACCESS_KEY_ID).strip()

    @property
    def effective_s3_secret_access_key(self) -> str:
        return (self.R2_SECRET_ACCESS_KEY or self.S3_SECRET_ACCESS_KEY).strip()

    @property
    def effective_s3_region(self) -> str:
        if self.STORAGE_BACKEND == "r2" and self.S3_REGION == "us-east-1":
            return "auto"
        return (self.S3_REGION or "auto").strip()

    # Media & AI
    MAX_UPLOAD_SIZE_MB: int = 100
    MAX_AUDIO_DURATION_SECONDS: int = 900
    FFMPEG_BINARY: str = "ffmpeg"
    ENABLE_SOURCE_SEPARATION: bool = False
    WHISPER_MODEL_SIZE: str = "auto"
    SOURCE_SEPARATION_BACKEND: str = "none"

    # Billing (Stripe)
    STRIPE_SECRET_KEY: str = ""
    STRIPE_WEBHOOK_SECRET: str = ""
    STRIPE_PRO_PRICE_ID: str = ""
    STRIPE_STUDIO_PRICE_ID: str = ""

    # Arrangement & Vocal Register Defaults (G3 = 55, G5 = 79)
    VOCAL_RANGE_MIN_MIDI: int = 55
    VOCAL_RANGE_MAX_MIDI: int = 79

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
