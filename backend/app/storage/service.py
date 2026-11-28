import contextlib
import errno
import logging
import mimetypes
import os
import re
import shutil
import tempfile
import threading
import uuid
from pathlib import Path
from typing import Any, BinaryIO

from app.core.config import get_settings
from app.core.security import create_signed_download_token

logger = logging.getLogger(__name__)
SAFE_FILENAME_RE = re.compile(r"[^A-Za-z0-9._-]+")
_UNSAFE_DOWNLOAD_CHARS_RE = re.compile(r'[<>:"/\\|?*;\x00-\x1f\x7f]+')
_LOW_DISK_THRESHOLD_BYTES = 256 * 1024 * 1024
_FULL_DISK_THRESHOLD_BYTES = 16 * 1024 * 1024


class StorageError(RuntimeError):
    """Raised when an object storage operation fails without falling back silently."""


class StorageCapacityError(StorageError):
    """Raised when underlying persistent storage capacity (e.g. ENOSPC) is exhausted."""


class StoragePermissionError(StorageError):
    """Raised when persistent storage cannot be written due to OS/filesystem permissions."""


def translate_os_storage_error(exc: OSError, operation: str, key: str = "") -> StorageError:
    """Translate OS/filesystem errors into structured infrastructure storage errors."""
    win_err = getattr(exc, "winerror", None)
    if exc.errno in (errno.ENOSPC, errno.EDQUOT) or win_err in (39, 112):
        logger.error("Storage volume full during %s for key '%s': %s", operation, key, exc)
        return StorageCapacityError(
            "Server storage capacity has been reached. Unable to save file because the underlying storage volume is full."
        )
    if isinstance(exc, PermissionError) or exc.errno in (errno.EACCES, errno.EPERM, errno.EROFS):
        logger.error("Storage permission error during %s for key '%s': %s", operation, key, exc)
        return StoragePermissionError("Storage permission error while writing to persistent storage.")
    logger.error("Persistent storage %s failed for key '%s': %s", operation, key, exc)
    return StorageError(f"Persistent storage {operation} failed: {exc.strerror or type(exc).__name__}")


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


def sanitize_download_title(title: str | None, fallback: str = "Extracted Audio") -> str:
    """Sanitize a human-readable project title for Content-Disposition download filenames."""
    cleaned = _UNSAFE_DOWNLOAD_CHARS_RE.sub(" ", title or "")
    while ".." in cleaned:
        cleaned = cleaned.replace("..", " ")
    cleaned = re.sub(r"\s+", " ", cleaned).strip(" .")
    return cleaned[:100].rstrip(" .") or fallback


def _validate_storage_key(key: str) -> str:
    cleaned = (key or "").strip().lstrip("\\")
    if not cleaned or cleaned.startswith("/") or ".." in cleaned.split("/") or "\\" in cleaned:
        raise ValueError("Invalid storage key path traversal attempt")
    return cleaned


_EXPLICIT_CONTENT_TYPES: dict[str, str] = {
    ".musicxml": "application/vnd.recordare.musicxml+xml",
    ".xml": "application/vnd.recordare.musicxml+xml",
    ".mxl": "application/vnd.recordare.musicxml",
    ".mid": "audio/midi",
    ".midi": "audio/midi",
    ".pdf": "application/pdf",
    ".wav": "audio/wav",
    ".mp3": "audio/mpeg",
    ".flac": "audio/flac",
    ".m4a": "audio/mp4",
    ".ogg": "audio/ogg",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
}


def _infer_content_type(key: str) -> str:
    ext = Path(key).suffix.lower()
    if ext in _EXPLICIT_CONTENT_TYPES:
        return _EXPLICIT_CONTENT_TYPES[ext]
    guessed, _ = mimetypes.guess_type(key)
    return guessed or "application/octet-stream"


def _is_s3_not_found(exc: Exception) -> bool:
    if isinstance(exc, FileNotFoundError):
        return True
    response = getattr(exc, "response", None)
    if isinstance(response, dict):
        err = response.get("Error") or {}
        code = str(err.get("Code") or "")
        if code in {"404", "NoSuchKey", "NotFound"}:
            return True
        meta = response.get("ResponseMetadata") or {}
        if meta.get("HTTPStatusCode") == 404:
            return True
    return False


class StorageService:
    """Private object storage abstraction supporting local disk and Cloudflare R2 / S3-compatible buckets."""

    def __init__(self) -> None:
        self._client_cache_key: tuple[str, str, str, str] | None = None
        self._cached_client: Any = None
        self._migration_locks_guard = threading.Lock()
        self._migration_locks: dict[str, tuple[threading.Lock, int]] = {}

    @contextlib.contextmanager
    def _key_migration_lock(self, key: str):
        with self._migration_locks_guard:
            lock, ref_count = self._migration_locks.get(key, (threading.Lock(), 0))
            self._migration_locks[key] = (lock, ref_count + 1)
        try:
            with lock:
                yield
        finally:
            with self._migration_locks_guard:
                cur_lock, cur_count = self._migration_locks.get(key, (lock, 1))
                if cur_count <= 1:
                    self._migration_locks.pop(key, None)
                else:
                    self._migration_locks[key] = (cur_lock, cur_count - 1)

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
        try:
            resolved.relative_to(root)
        except ValueError as exc:
            raise ValueError("Invalid storage key path traversal attempt") from exc
        return resolved

    def _atomic_write_local(self, dest: Path, key: str, write_fn: Any) -> int:
        try:
            dest.parent.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            raise translate_os_storage_error(exc, "directory creation", key) from exc

        tmp_path: Path | None = None
        written = 0
        try:
            fd_handle = tempfile.NamedTemporaryFile(
                dir=dest.parent,
                prefix=f".{dest.name}.",
                suffix=".tmp",
                delete=False,
            )
            tmp_path = Path(fd_handle.name)
            with fd_handle as f:
                written = int(write_fn(f))
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp_path, dest)
            return written
        except StorageError:
            if tmp_path is not None:
                tmp_path.unlink(missing_ok=True)
            raise
        except OSError as exc:
            if tmp_path is not None:
                tmp_path.unlink(missing_ok=True)
            raise translate_os_storage_error(exc, "write", key) from exc
        except Exception:
            if tmp_path is not None:
                tmp_path.unlink(missing_ok=True)
            raise

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

        def _write(f: Any) -> int:
            f.write(data)
            return len(data)

        self._atomic_write_local(dest, key, _write)
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

        def _write_stream(f: Any) -> int:
            total = 0
            while True:
                chunk = stream.read(1024 * 1024)
                if not chunk:
                    break
                f.write(chunk)
                total += len(chunk)
            return total

        total = self._atomic_write_local(dest, key, _write_stream)
        return key, total

    def _legacy_local_root(self) -> Path | None:
        settings = get_settings()
        if (
            settings.ENVIRONMENT == "production"
            and settings.LOCAL_STORAGE_ROOT == "./storage_data"
            and Path("/data").exists()
        ):
            root = Path("/data/storage_data").resolve()
        else:
            root = Path(settings.LOCAL_STORAGE_ROOT).resolve()
        if root.exists() and root.is_dir():
            return root
        return None

    def _resolve_legacy_local_path(self, key: str) -> Path | None:
        cleaned = _validate_storage_key(key)
        if cleaned.startswith("_cache/"):
            return None
        root = self._legacy_local_root()
        if root is None:
            return None
        resolved = (root / cleaned).resolve()
        try:
            resolved.relative_to(root)
        except ValueError as exc:
            raise ValueError("Invalid storage key path traversal attempt") from exc
        if resolved.is_file():
            return resolved
        return None

    def exists_in_primary(self, key: str) -> bool:
        """Check whether object exists directly in the configured primary backend without triggering legacy migration."""
        _validate_storage_key(key)
        if self.is_object_storage:
            client = self._s3_client()
            try:
                client.head_object(Bucket=get_settings().effective_s3_bucket, Key=key)
                return True
            except Exception:
                return False
        return self._local_path(key).exists()

    def try_migrate_legacy_object(self, key: str, *, raise_on_upload_error: bool = False) -> bool:
        """Migrate an object from legacy local storage to R2/S3 safely if absent from the bucket."""
        _validate_storage_key(key)
        if not self.is_object_storage:
            return False

        settings = get_settings()
        bucket = settings.effective_s3_bucket
        with self._key_migration_lock(key):
            client = self._s3_client()
            try:
                client.head_object(Bucket=bucket, Key=key)
                return True
            except Exception as exc:
                if not _is_s3_not_found(exc):
                    logger.error(
                        "Legacy migration head_object failed for key '%s' in %s: %s",
                        key,
                        self.backend.upper(),
                        type(exc).__name__,
                    )
                    if raise_on_upload_error:
                        raise StorageError(
                            f"Failed to verify object '{key}' in {self.backend.upper()}."
                        ) from exc
                    return False

            local_path = self._resolve_legacy_local_path(key)
            if local_path is None:
                return False

            try:
                legacy_bytes = local_path.read_bytes()
            except OSError as exc:
                logger.error(
                    "Unable to read legacy local object for key '%s': %s",
                    key,
                    type(exc).__name__,
                )
                return False

            if not legacy_bytes:
                logger.warning("Skipping empty legacy local object for key '%s'.", key)
                return False

            content_type = _infer_content_type(key)
            try:
                client.put_object(
                    Bucket=bucket,
                    Key=key,
                    Body=legacy_bytes,
                    ContentType=content_type,
                )
                verified = client.head_object(Bucket=bucket, Key=key)
                verified_len = verified.get("ContentLength") if isinstance(verified, dict) else None
                if verified_len is not None and int(verified_len) != len(legacy_bytes):
                    raise StorageError(
                        f"Uploaded size mismatch during legacy migration for key '{key}'."
                    )
            except Exception as exc:
                logger.error(
                    "Legacy object migration to %s failed for key '%s': %s",
                    self.backend.upper(),
                    key,
                    type(exc).__name__,
                )
                if raise_on_upload_error:
                    if isinstance(exc, StorageError):
                        raise
                    raise StorageError(
                        f"Failed to migrate legacy object '{key}' to {self.backend.upper()}."
                    ) from exc
                return False

            logger.info(
                "Migrated legacy object to %s: key='%s', size_bytes=%d",
                self.backend.upper(),
                key,
                len(legacy_bytes),
            )
            return True

    def read_bytes(self, key: str) -> bytes:
        _validate_storage_key(key)
        if self.is_object_storage:
            settings = get_settings()
            bucket = settings.effective_s3_bucket
            try:
                client = self._s3_client()
                obj = client.get_object(Bucket=bucket, Key=key)
                return obj["Body"].read()
            except Exception as exc:
                if _is_s3_not_found(exc) and self.try_migrate_legacy_object(
                    key, raise_on_upload_error=True
                ):
                    try:
                        client = self._s3_client()
                        obj = client.get_object(Bucket=bucket, Key=key)
                        return obj["Body"].read()
                    except Exception as retry_exc:
                        logger.error(
                            "R2/S3 get_object after migration failed for key '%s': %s",
                            key,
                            type(retry_exc).__name__,
                        )
                        raise StorageError(
                            f"Failed to read object '{key}' from {self.backend.upper()}."
                        ) from retry_exc
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
            except Exception as exc:
                if _is_s3_not_found(exc):
                    return self.try_migrate_legacy_object(key, raise_on_upload_error=False)
                return False
        return self._local_path(key).exists()

    def get_object_metadata(self, key: str) -> dict[str, Any] | None:
        """Return object metadata (size_bytes, content_type, etag) from R2/S3 or local file stat."""
        _validate_storage_key(key)
        if self.is_object_storage:
            bucket = get_settings().effective_s3_bucket
            client = self._s3_client()
            try:
                head = client.head_object(Bucket=bucket, Key=key)
            except Exception as exc:
                if _is_s3_not_found(exc) and self.try_migrate_legacy_object(
                    key, raise_on_upload_error=False
                ):
                    try:
                        head = client.head_object(Bucket=bucket, Key=key)
                    except Exception:
                        return None
                else:
                    return None
            length = head.get("ContentLength")
            return {
                "size_bytes": int(length) if length is not None else None,
                "content_type": head.get("ContentType"),
                "etag": (head.get("ETag") or "").strip('"') or None,
            }
        path = self._local_path(key)
        if not path.exists():
            return None
        return {"size_bytes": path.stat().st_size, "content_type": None, "etag": None}

    def get_object_size(self, key: str) -> int | None:
        """Return object byte size from R2/S3 head_object or local file stat, if available."""
        meta = self.get_object_metadata(key)
        return meta["size_bytes"] if meta else None

    def get_storage_health(self) -> dict[str, Any]:
        """Inspect actual storage backend health and infrastructure capacity where available."""
        if self.is_object_storage:
            return {
                "backend": self.backend,
                "writable": True,
                "status": "available",
                "volume_total_bytes": None,
                "volume_free_bytes": None,
                "volume_used_bytes": None,
            }
        try:
            root = get_settings().storage_root_path
            usage = shutil.disk_usage(root)
            writable = os.access(root, os.W_OK)
            if not writable:
                status_val = "unavailable"
            elif usage.free < _FULL_DISK_THRESHOLD_BYTES:
                status_val = "full"
            elif usage.free < _LOW_DISK_THRESHOLD_BYTES or (usage.total > 0 and usage.free / usage.total < 0.05):
                status_val = "low_space"
            else:
                status_val = "available"
            return {
                "backend": self.backend,
                "writable": writable,
                "status": status_val,
                "volume_total_bytes": int(usage.total),
                "volume_free_bytes": int(usage.free),
                "volume_used_bytes": int(usage.used),
            }
        except OSError as exc:
            logger.warning("Unable to inspect local storage disk usage: %s", exc)
            return {
                "backend": self.backend,
                "writable": False,
                "status": "unavailable",
                "volume_total_bytes": None,
                "volume_free_bytes": None,
                "volume_used_bytes": None,
            }

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
