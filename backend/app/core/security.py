import hashlib
import hmac
import secrets
from datetime import UTC, datetime, timedelta
from typing import Any

import bcrypt
import jwt

from app.core.config import get_settings


def hash_password(password: str) -> str:
    salt = bcrypt.gensalt(rounds=12)
    return bcrypt.hashpw(password.encode("utf-8"), salt).decode("utf-8")


def verify_password(plain_password: str, hashed_password: str) -> bool:
    try:
        return bcrypt.checkpw(plain_password.encode("utf-8"), hashed_password.encode("utf-8"))
    except ValueError:
        return False


def create_access_token(subject: str, extra_claims: dict[str, Any] | None = None) -> str:
    settings = get_settings()
    now = datetime.now(UTC)
    expire = now + timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)
    payload: dict[str, Any] = {
        "sub": subject,
        "type": "access",
        "iat": int(now.timestamp()),
        "exp": int(expire.timestamp()),
    }
    if extra_claims:
        payload.update(extra_claims)
    return jwt.encode(payload, settings.JWT_SECRET_KEY, algorithm=settings.JWT_ALGORITHM)


def create_refresh_token(subject: str) -> str:
    settings = get_settings()
    now = datetime.now(UTC)
    expire = now + timedelta(days=settings.REFRESH_TOKEN_EXPIRE_DAYS)
    payload: dict[str, Any] = {
        "sub": subject,
        "type": "refresh",
        "jti": secrets.token_hex(16),
        "iat": int(now.timestamp()),
        "exp": int(expire.timestamp()),
    }
    return jwt.encode(payload, settings.JWT_SECRET_KEY, algorithm=settings.JWT_ALGORITHM)


def decode_token(token: str) -> dict[str, Any]:
    settings = get_settings()
    try:
        return jwt.decode(
            token,
            settings.JWT_SECRET_KEY,
            algorithms=[settings.JWT_ALGORITHM],
        )
    except jwt.PyJWTError:
        if settings.SUPABASE_JWT_SECRET:
            return jwt.decode(
                token,
                settings.SUPABASE_JWT_SECRET,
                algorithms=["HS256"],
                options={"verify_aud": False},
            )
        raise


def create_signed_download_token(storage_path: str, owner_id: str, ttl_seconds: int | None = None) -> tuple[str, int]:
    settings = get_settings()
    ttl = ttl_seconds or settings.SIGNED_URL_TTL_SECONDS
    expires_at = int((datetime.now(UTC) + timedelta(seconds=ttl)).timestamp())
    message = f"{storage_path}:{owner_id}:{expires_at}".encode()
    signature = hmac.new(
        settings.SIGNED_URL_SECRET.encode("utf-8"),
        message,
        hashlib.sha256,
    ).hexdigest()
    return signature, expires_at


def verify_signed_download_token(storage_path: str, owner_id: str, expires_at: int, signature: str) -> bool:
    if int(datetime.now(UTC).timestamp()) > expires_at:
        return False
    settings = get_settings()
    message = f"{storage_path}:{owner_id}:{expires_at}".encode()
    expected = hmac.new(
        settings.SIGNED_URL_SECRET.encode("utf-8"),
        message,
        hashlib.sha256,
    ).hexdigest()
    return hmac.compare_digest(expected, signature)
