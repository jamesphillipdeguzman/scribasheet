from pydantic import BaseModel, EmailStr, Field

from app.schemas.common import UTCDatetime


class RegisterRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)
    display_name: str = Field(min_length=1, max_length=120)


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class RefreshRequest(BaseModel):
    refresh_token: str


class ForgotPasswordRequest(BaseModel):
    email: EmailStr


class ResetPasswordRequest(BaseModel):
    token: str
    new_password: str = Field(min_length=8, max_length=128)


class VerifyEmailRequest(BaseModel):
    token: str


class UserResponse(BaseModel):
    id: str
    email: str
    display_name: str
    email_verified: bool
    plan_tier: str
    is_unlimited: bool = False
    plan_label: str = "FREE"
    created_at: UTCDatetime
    updated_at: UTCDatetime

    model_config = {"from_attributes": True}


class UserUpdateRequest(BaseModel):
    display_name: str | None = Field(default=None, min_length=1, max_length=120)


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    user: UserResponse


class UsageSummaryResponse(BaseModel):
    plan_tier: str
    plan_label: str = "FREE"
    is_unlimited: bool = False
    monthly_minutes_used: float
    monthly_minutes_limit: float
    project_count: int
    project_limit: int | None = None
    file_count: int = 0
    storage_used_bytes: int = 0
    storage_used_mb: float
    storage_limit_mb: float | None = None
    storage_quota_enforced: bool = False
    storage_backend: str = "local"
    storage_status: str = "available"
    storage_volume_free_mb: float | None = None
    storage_volume_total_mb: float | None = None
