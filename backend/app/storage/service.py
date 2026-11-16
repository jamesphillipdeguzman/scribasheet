import os
import re
import uuid
from pathlib import Path
from typing import BinaryIO

from app.core.config import get_settings
from app.core.security import create_signed_download_token

SAFE_FILENAME_RE = re.compile(r"[^A-Za-z0-9._-]+")


def sanitize_filename(filename: str) -> str:
    base = os.path.basename(filename or "upload.bin")
    cleaned = SAFE_FILENAME_RE.sub("_", base).strip("._")
    return cleaned[:120] or "upload.bin"


class StorageService:
    """Private object storage abstraction supporting local disk and S3-compatible buckets."""

    @property
    def backend(self) -> str:
        return get_settings().STORAGE_BACKEND

    def build_key(self, user_id: str, project_id: str, category: str, filename: str) -> str:
        safe_name = sanitize_filename(filename)
        unique = uuid.uuid4().hex[:12]
        return f"users/{user_id}/projects/{project_id}/{category}/{unique}_{safe_name}"

    def _local_path(self, key: str) -> Path:
        root = get_settings().storage_root_path
        resolved = (root / key).resolve()
        if not str(resolved).startswith(str(root)):
            raise ValueError("Invalid storage key path traversal attempt")
        return resolved

    def save_bytes(self, key: str, data: bytes, content_type: str = "application/octet-stream") -> str:
        if self.backend == "s3":
            client = self._s3_client()
            client.put_object(
                Bucket=get_settings().S3_BUCKET_NAME,
                Key=key,
                Body=data,
                ContentType=content_type,
            )
            return key

        dest = self._local_path(key)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(data)
        return key

    def save_stream(self, key: str, stream: BinaryIO, content_type: str = "application/octet-stream") -> tuple[str, int]:
        if self.backend == "s3":
            data = stream.read()
            self.save_bytes(key, data, content_type=content_type)
            return key, len(data)

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
        if self.backend == "s3":
            client = self._s3_client()
            obj = client.get_object(Bucket=get_settings().S3_BUCKET_NAME, Key=key)
            return obj["Body"].read()
        return self._local_path(key).read_bytes()

    def get_local_file_path(self, key: str) -> Path:
        """Return a local filesystem path for audio processing (downloads from S3 if needed)."""
        if self.backend == "s3":
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
        if self.backend == "s3":
            client = self._s3_client()
            try:
                client.head_object(Bucket=get_settings().S3_BUCKET_NAME, Key=key)
                return True
            except Exception:
                return False
        return self._local_path(key).exists()

    def delete(self, key: str) -> None:
        if self.backend == "s3":
            client = self._s3_client()
            client.delete_object(Bucket=get_settings().S3_BUCKET_NAME, Key=key)
            return
        path = self._local_path(key)
        if path.exists():
            path.unlink()

    def create_signed_download_params(self, key: str, owner_id: str, expires_in: int | None = None) -> dict[str, str | int]:
        settings = get_settings()
        ttl = expires_in or settings.SIGNED_URL_TTL_SECONDS
        if self.backend == "s3":
            return self.create_presigned_get_url(key, expires_in=ttl)
        sig, exp = create_signed_download_token(key, owner_id, ttl_seconds=ttl)
        return {"sig": sig, "exp": exp}

    def create_presigned_get_url(self, key: str, expires_in: int | None = None) -> dict[str, str | int]:
        settings = get_settings()
        ttl = expires_in or settings.SIGNED_URL_TTL_SECONDS
        client = self._s3_client()
        url = client.generate_presigned_url(
            "get_object",
            Params={"Bucket": settings.S3_BUCKET_NAME, "Key": key},
            ExpiresIn=ttl,
        )
        return {"url": url, "expires_in": ttl}

    def create_presigned_put_url(
        self,
        key: str,
        content_type: str = "application/octet-stream",
        expires_in: int | None = None,
    ) -> dict[str, str | int]:
        settings = get_settings()
        ttl = expires_in or settings.S3_PRESIGNED_PUT_TTL_SECONDS
        client = self._s3_client()
        url = client.generate_presigned_url(
            "put_object",
            Params={
                "Bucket": settings.S3_BUCKET_NAME,
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
        return boto3.client(
            "s3",
            endpoint_url=settings.S3_ENDPOINT_URL or None,
            aws_access_key_id=settings.S3_ACCESS_KEY_ID,
            aws_secret_access_key=settings.S3_SECRET_ACCESS_KEY,
            region_name=settings.S3_REGION or "auto",
            config=Config(signature_version="s3v4"),
        )


storage_service = StorageService()
