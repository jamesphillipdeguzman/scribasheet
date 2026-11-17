import secrets
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.api.deps import (
    get_current_user,
    get_user_plan_label,
    get_user_usage_metrics,
    is_user_unlimited,
)
from app.core.security import (
    create_access_token,
    create_refresh_token,
    decode_token,
    hash_password,
    verify_password,
)
from app.db.session import get_db
from app.models import MediaAsset, User
from app.schemas.auth import (
    ForgotPasswordRequest,
    LoginRequest,
    RefreshRequest,
    RegisterRequest,
    ResetPasswordRequest,
    TokenResponse,
    UsageSummaryResponse,
    UserResponse,
    UserUpdateRequest,
    VerifyEmailRequest,
)
from app.storage.service import storage_service

router = APIRouter(tags=["Authentication & Users"])


def _serialize_user(user: User) -> UserResponse:
    resp = UserResponse.model_validate(user)
    resp.is_unlimited = is_user_unlimited(user)
    resp.plan_label = get_user_plan_label(user)
    return resp


@router.post("/auth/register", response_model=TokenResponse, status_code=status.HTTP_201_CREATED)
def register(payload: RegisterRequest, db: Session = Depends(get_db)):
    email_norm = payload.email.strip().lower()
    existing = db.query(User).filter(User.email == email_norm).first()
    if existing:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="An account with this email already exists.",
        )

    user = User(
        email=email_norm,
        password_hash=hash_password(payload.password),
        display_name=payload.display_name.strip(),
        email_verified=False,
        verification_token=secrets.token_urlsafe(32),
        plan_tier="free",
    )
    db.add(user)
    db.commit()
    db.refresh(user)

    return TokenResponse(
        access_token=create_access_token(user.id, {"email": user.email}),
        refresh_token=create_refresh_token(user.id),
        user=_serialize_user(user),
    )


@router.post("/auth/login", response_model=TokenResponse)
def login(payload: LoginRequest, db: Session = Depends(get_db)):
    email_norm = payload.email.strip().lower()
    user = db.query(User).filter(User.email == email_norm).first()
    if not user or not verify_password(payload.password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password.",
        )

    return TokenResponse(
        access_token=create_access_token(user.id, {"email": user.email}),
        refresh_token=create_refresh_token(user.id),
        user=_serialize_user(user),
    )


@router.post("/auth/refresh", response_model=TokenResponse)
def refresh_token(payload: RefreshRequest, db: Session = Depends(get_db)):
    try:
        claims = decode_token(payload.refresh_token)
    except Exception:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired refresh token.")

    if claims.get("type") != "refresh":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid refresh token type.")

    user = db.query(User).filter(User.id == claims.get("sub")).first()
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found.")

    return TokenResponse(
        access_token=create_access_token(user.id, {"email": user.email}),
        refresh_token=create_refresh_token(user.id),
        user=_serialize_user(user),
    )


@router.post("/auth/logout")
def logout():
    return {"message": "Signed out successfully."}


@router.post("/auth/verify-email")
def verify_email(payload: VerifyEmailRequest, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.verification_token == payload.token).first()
    if not user:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid verification token.")
    user.email_verified = True
    user.verification_token = None
    db.commit()
    return {"message": "Email verified successfully."}


@router.post("/auth/forgot-password")
def forgot_password(payload: ForgotPasswordRequest, db: Session = Depends(get_db)):
    email_norm = payload.email.strip().lower()
    user = db.query(User).filter(User.email == email_norm).first()
    if user:
        user.reset_token = secrets.token_urlsafe(32)
        user.reset_token_expires_at = datetime.now(UTC) + timedelta(hours=1)
        db.commit()
    # Always return generic 200 to prevent account enumeration
    return {"message": "If an account with that email exists, password reset instructions have been prepared."}


@router.post("/auth/reset-password")
def reset_password(payload: ResetPasswordRequest, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.reset_token == payload.token).first()
    if not user or not user.reset_token_expires_at:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid or expired reset token.")
    expires_at = user.reset_token_expires_at
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=UTC)
    if datetime.now(UTC) > expires_at:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Reset token has expired.")

    user.password_hash = hash_password(payload.new_password)
    user.reset_token = None
    user.reset_token_expires_at = None
    db.commit()
    return {"message": "Password updated successfully."}


@router.get("/users/me", response_model=UserResponse)
def get_me(current_user: User = Depends(get_current_user)):
    return _serialize_user(current_user)


@router.patch("/users/me", response_model=UserResponse)
def update_me(
    payload: UserUpdateRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if payload.display_name is not None:
        current_user.display_name = payload.display_name.strip()
    db.commit()
    db.refresh(current_user)
    return _serialize_user(current_user)


@router.get("/users/me/usage", response_model=UsageSummaryResponse)
def get_my_usage(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    return UsageSummaryResponse(**get_user_usage_metrics(db, current_user))


@router.delete("/users/me", status_code=status.HTTP_204_NO_CONTENT)
def delete_my_account(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    assets = db.query(MediaAsset).filter(MediaAsset.user_id == current_user.id).all()
    for asset in assets:
        try:
            storage_service.delete(asset.storage_path)
        except Exception:
            pass
    db.delete(current_user)
    db.commit()
    return None
