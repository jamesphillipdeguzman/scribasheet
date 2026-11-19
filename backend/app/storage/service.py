import logging
import os
import re
import uuid
from pathlib import Path
from typing import Any, BinaryIO

from app.core.config import get_settings
from app.core.security import create_signed_download_token

logger = logging.getLogger(__name__)
SAFE_FILENAME_RE = re.compile(r"[^A-Za-z0-9._-]+")


class StorageError(RuntimeError):
    """Raised when an object storage operation fails without falling back silently."""


class _CountingStream:
    """Wrap a binary stream to count bytes read during streaming upload."""

    def __init__(self, stream: BinaryIO) -> None:
        self._stream = stream
        self.bytes_read = 0

    def read(self, size: int = -1) -> bytes:
        chunk = self._stream.read(size)
        if chunk:
            self.bytes_read += len(chunk)
        return chunk


def sanitize_filename(filename: str) -> str:
    base = os.path.basename(filename or "upload.bin")
    cleaned = SAFE_FILENAME_RE.sub("_", base).strip("._")
    return cleaned[:120] or "upload.bin"


def _validate_storage_key(key: str) -> str:
    cleaned = (key or "").strip().lstrip("\\")
    if not cleaned or cleaned.startswith("/") or ".." in cleaned.split("/") or "\\" in cleaned:
        raise ValueError("Invalid storage key path traversal attempt")
    return cleaned


class StorageService:
    """Private object storage abstraction supporting local disk and Cloudflare R2 / S3-compatible buckets."""

    def __init__(self) -> None:
        self._client_cache_key: tuple[str, str, str, str] | None = None
        self._cached_client: Any = None

    @property
    def backend(self) -> str:
        return get_settings().STORAGE_BACKEND

    @property
    def is_object_storage(self) -> bool:
        return self.backend in ("r2", "s3")

    def build_key(
        self,
        user_id: str,
        project_id: str,
        category: str,
        filename: str,
        *,
        job_id: str | None = None,
    ) -> str:
        safe_name = sanitize_filename(filename)
        unique = uuid.uuid4().hex[:12]
        if job_id:
            return f"users/{user_id}/projects/{project_id}/jobs/{job_id}/{category}/{unique}_{safe_name}"
        return f"users/{user_id}/projects/{project_id}/{category}/{unique}_{safe_name}"

    def _local_path(self, key: str) -> Path:
        _validate_storage_key(key)
        root = get_settings().storage_root_path
        resolved = (root / key).resolve()
        if not str(resolved).startswith(str(root)):
            raise ValueError("Invalid storage key path traversal attempt")
        return resolved

    def save_bytes(self, key: str, data: bytes, content_type: str = "application/octet-stream") -> str:
        _validate_storage_key(key)
        if self.is_object_storage:
            settings = get_settings()
            try:
                client = self._s3_client()
                client.put_object(
                    Bucket=settings.effective_s3_bucket,
                    Key=key,
                    Body=data,
                    ContentType=content_type,
                )
            except Exception as exc:
                logger.error("R2/S3 put_object failed for key '%s': %s", key, type(exc).__name__)
                raise StorageError(f"Failed to store object '{key}' in {self.backend.upper()}.") from exc
            return key

        dest = self._local_path(key)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(data)
        return key

    def save_stream(
        self,
        key: str,
        stream: BinaryIO,
        content_type: str = "application/octet-stream",
    ) -> tuple[str, int]:
        _validate_storage_key(key)
        if self.is_object_storage:
            settings = get_settings()
            counting = _CountingStream(stream)
            try:
                client = self._s3_client()
                client.upload_fileobj(
                    counting,
                    settings.effective_s3_bucket,
                    key,
                    ExtraArgs={"ContentType": content_type},
                )
            except Exception as exc:
                logger.error("R2/S3 upload_fileobj failed for key '%s': %s", key, type(exc).__name__)
                raise StorageError(f"Failed to stream object '{key}' to {self.backend.upper()}.") from exc
            return key, counting.bytes_read

        dest = self._local_path(key)
        dest.parent.mkdir(parents=True, exist_ok=True)
        total = 0
        with dest.open("wb") as f:
            while True:
                chunk = stream.read(1024 * 1024)
                if not chunk:
                    break
                f.write(chunk)
                total += len(chunk)
        return key, total

    def read_bytes(self, key: str) -> bytes:
        _validate_storage_key(key)
        if self.is_object_storage:
            settings = get_settings()
            try:
                client = self._s3_client()
                obj = client.get_object(Bucket=settings.effective_s3_bucket, Key=key)
                return obj["Body"].read()
            except Exception as exc:
                logger.error("R2/S3 get_object failed for key '%s': %s", key, type(exc).__name__)
                raise StorageError(f"Failed to read object '{key}' from {self.backend.upper()}.") from exc
        return self._local_path(key).read_bytes()

    def get_local_file_path(self, key: str) -> Path:
        """Return a local filesystem path for audio processing (downloads from R2/S3 if needed)."""
        _validate_storage_key(key)
        if self.is_object_storage:
            cache_path = self._local_path(f"_cache/{key}")
            if not cache_path.exists():
                cache_path.parent.mkdir(parents=True, exist_ok=True)
                cache_path.write_bytes(self.read_bytes(key))
            return cache_path
        path = self._local_path(key)
        if not path.exists():
            raise FileNotFoundError(f"Stored object not found: {key}")
        return path

    def exists(self, key: str) -> bool:
        _validate_storage_key(key)
        if self.is_object_storage:
            client = self._s3_client()
            try:
                client.head_object(Bucket=get_settings().effective_s3_bucket, Key=key)
                return True
            except Exception:
                return False
        return self._local_path(key).exists()

    def get_object_metadata(self, key: str) -> dict[str, Any] | None:
        """Return object metadata (size_bytes, content_type, etag) from R2/S3 or local file stat."""
        _validate_storage_key(key)
        if self.is_object_storage:
            client = self._s3_client()
            try:
                head = client.head_object(Bucket=get_settings().effective_s3_bucket, Key=key)
                length = head.get("ContentLength")
                return {
                    "size_bytes": int(length) if length is not None else None,
                    "content_type": head.get("ContentType"),
                    "etag": (head.get("ETag") or "").strip('"') or None,
                }
            except Exception:
                return None
        path = self._local_path(key)
        if not path.exists():
            return None
        return {"size_bytes": path.stat().st_size, "content_type": None, "etag": None}

    def get_object_size(self, key: str) -> int | None:
        """Return object byte size from R2/S3 head_object or local file stat, if available."""
        meta = self.get_object_metadata(key)
        return meta["size_bytes"] if meta else None

    def delete(self, key: str) -> None:
        _validate_storage_key(key)
        if self.is_object_storage:
            settings = get_settings()
            try:
                client = self._s3_client()
                client.delete_object(Bucket=settings.effective_s3_bucket, Key=key)
            except Exception as exc:
                logger.error("R2/S3 delete_object failed for key '%s': %s", key, type(exc).__name__)
                raise StorageError(f"Failed to delete object '{key}' from {self.backend.upper()}.") from exc
            return
        path = self._local_path(key)
        if path.exists():
            path.unlink()

    def create_signed_download_params(
        self,
        key: str,
        owner_id: str,
        expires_in: int | None = None,
    ) -> dict[str, str | int]:
        _validate_storage_key(key)
        settings = get_settings()
        ttl = expires_in or settings.SIGNED_URL_TTL_SECONDS
        if self.is_object_storage:
            return self.create_presigned_get_url(key, expires_in=ttl)
        sig, exp = create_signed_download_token(key, owner_id, ttl_seconds=ttl)
        return {"sig": sig, "exp": exp}

    def create_presigned_get_url(self, key: str, expires_in: int | None = None) -> dict[str, str | int]:
        _validate_storage_key(key)
        settings = get_settings()
        ttl = expires_in or settings.SIGNED_URL_TTL_SECONDS
        client = self._s3_client()
        url = client.generate_presigned_url(
            "get_object",
            Params={"Bucket": settings.effective_s3_bucket, "Key": key},
            ExpiresIn=ttl,
        )
        return {"url": url, "expires_in": ttl}

    def create_presigned_put_url(
        self,
        key: str,
        content_type: str = "application/octet-stream",
        expires_in: int | None = None,
    ) -> dict[str, str | int]:
        _validate_storage_key(key)
        settings = get_settings()
        ttl = expires_in or settings.S3_PRESIGNED_PUT_TTL_SECONDS
        client = self._s3_client()
        url = client.generate_presigned_url(
            "put_object",
            Params={
                "Bucket": settings.effective_s3_bucket,
                "Key": key,
                "ContentType": content_type,
            },
            ExpiresIn=ttl,
        )
        return {"url": url, "key": key, "expires_in": ttl}

    def _s3_client(self):
        import boto3
        from botocore.config import Config

        settings = get_settings()
        endpoint = settings.effective_s3_endpoint
        bucket = settings.effective_s3_bucket
        access_key = settings.effective_s3_access_key_id
        secret_key = settings.effective_s3_secret_access_key
        region = settings.effective_s3_region

        missing = [
            name
            for name, val in (
                ("R2_ENDPOINT_URL / S3_ENDPOINT_URL", endpoint),
                ("R2_BUCKET_NAME / S3_BUCKET_NAME", bucket),
                ("R2_ACCESS_KEY_ID / S3_ACCESS_KEY_ID", access_key),
                ("R2_SECRET_ACCESS_KEY / S3_SECRET_ACCESS_KEY", secret_key),
            )
            if not val
        ]
        if missing:
            raise ValueError(f"Missing required S3/R2 configuration: {', '.join(missing)}")

        cache_key = (endpoint, access_key, secret_key, region)
        if self._cached_client is not None and self._client_cache_key == cache_key:
            return self._cached_client

        client = boto3.client(
            "s3",
            endpoint_url=endpoint,
            aws_access_key_id=access_key,
            aws_secret_access_key=secret_key,
            region_name=region,
            config=Config(signature_version="s3v4"),
        )
        self._client_cache_key = cache_key
        self._cached_client = client
        return client


storage_service = StorageService()
