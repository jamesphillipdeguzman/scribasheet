from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from pydantic import BaseModel

from app.api.deps import PLAN_LIMITS, get_current_user
from app.core.config import get_settings
from app.models import User

router = APIRouter(prefix="/billing", tags=["Billing & Plans"])


class CheckoutRequest(BaseModel):
    plan_tier: str


@router.get("/plans")
def list_plans():
    settings = get_settings()
    billing_configured = bool(settings.STRIPE_SECRET_KEY)
    return {
        "billing_active": billing_configured,
        "plans": [
            {
                "id": "free",
                "name": "Free",
                "description": "For students and hobbyists getting started with AI music transcription.",
                "limits": PLAN_LIMITS["free"],
                "features": [
                    "30 monthly transcription minutes",
                    "Single-instrument, piano, melody, and vocal workflows",
                    "Interactive sheet music & piano-roll editor",
                    "MIDI and MusicXML exports",
                ],
            },
            {
                "id": "pro",
                "name": "Pro",
                "description": "For active musicians, educators, and arrangers.",
                "limits": PLAN_LIMITS["pro"],
                "features": [
                    "300 monthly transcription minutes",
                    "PDF sheet music & WAV audio rendering exports",
                    "Chord analysis & guitar tablature tools",
                    "Priority background processing queue",
                ],
            },
            {
                "id": "studio",
                "name": "Studio",
                "description": "For composers, transcription studios, and multi-instrument workflows.",
                "limits": PLAN_LIMITS["studio"],
                "features": [
                    "1,500 monthly transcription minutes",
                    "Uncapped private project & media storage (infrastructure capacity applies)",
                    "Multi-instrument & stem separation workflows",
                    "Dedicated priority worker capacity",
                ],
            },
        ],
    }


@router.post("/checkout")
def create_checkout_session(
    payload: CheckoutRequest,
    current_user: User = Depends(get_current_user),
):
    settings = get_settings()
    if not settings.STRIPE_SECRET_KEY:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Billing is not yet active on this instance (STRIPE_SECRET_KEY is not configured).",
        )
    return {
        "status": "ready",
        "message": "Stripe checkout integration point ready.",
        "plan_tier": payload.plan_tier,
        "user_id": current_user.id,
    }


@router.post("/webhook")
async def stripe_webhook(
    request: Request,
    stripe_signature: str | None = Header(default=None, alias="Stripe-Signature"),
):
    settings = get_settings()
    if not settings.STRIPE_WEBHOOK_SECRET:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Stripe webhook secret is not configured.",
        )
    if not stripe_signature:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Missing Stripe-Signature header.")
    _ = await request.body()
    return {"received": True}
