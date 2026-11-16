import asyncio
import logging
import shutil
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address
from sqlalchemy import text

from app.api.v1 import api_v1_router
from app.core.config import get_settings
from app.core.logging import configure_logging, request_id_ctx
from app.db.session import SessionLocal
from app.workers.ws_manager import job_ws_manager

configure_logging()
logger = logging.getLogger(__name__)
settings = get_settings()

limiter = Limiter(key_func=get_remote_address, default_limits=["120/minute"])


@asynccontextmanager
async def lifespan(app: FastAPI):
    job_ws_manager.set_loop(asyncio.get_running_loop())
    settings.storage_root_path.mkdir(parents=True, exist_ok=True)
    logger.info("ScribaSheet API starting (env=%s, job_mode=%s)", settings.ENVIRONMENT, settings.JOB_EXECUTION_MODE)
    yield
    logger.info("ScribaSheet API shutting down")


app = FastAPI(
    title="ScribaSheet API",
    description="AI-Powered Music Transcription Studio API — From Sound to Sheet Music.",
    version="1.0.0",
    docs_url="/docs",
    redoc_url="/redoc",
    openapi_url="/openapi.json",
    lifespan=lifespan,
)

app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.BACKEND_CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)


@app.middleware("http")
async def request_context_and_security_headers(request: Request, call_next):
    req_id = request.headers.get("X-Request-ID") or uuid.uuid4().hex
    token = request_id_ctx.set(req_id)
    try:
        response = await call_next(request)
        response.headers["X-Request-ID"] = req_id
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        return response
    finally:
        request_id_ctx.reset(token)


@app.get("/", tags=["Operations"])
def root():
    return {
        "name": "ScribaSheet API",
        "status": "running",
        "environment": settings.ENVIRONMENT,
        "docs": "/docs",
        "health": "/health",
    }


@app.get("/health", tags=["Operations"])
def health_check():
    return {"status": "ok", "service": "scribasheet-api", "version": "1.0.0"}


@app.get("/ready", tags=["Operations"])
def readiness_check():
    checks: dict[str, str] = {}
    healthy = True

    # Database check
    try:
        db = SessionLocal()
        db.execute(text("SELECT 1"))
        db.close()
        checks["database"] = "ok"
    except Exception as exc:
        checks["database"] = f"error: {exc}"
        healthy = False

    # FFmpeg check
    ffmpeg_found = shutil.which(settings.FFMPEG_BINARY) is not None
    checks["ffmpeg"] = "ok" if ffmpeg_found else "fallback_librosa"

    # Basic Pitch ONNX check
    try:
        import basic_pitch

        onnx_path = Path(basic_pitch.__file__).resolve().parent / "saved_models" / "icassp_2022" / "nmp.onnx"
        checks["basic_pitch_onnx"] = "ok" if onnx_path.exists() else "missing_model"
        if not onnx_path.exists():
            healthy = False
    except Exception as exc:
        checks["basic_pitch_onnx"] = f"error: {exc}"
        healthy = False

    # Storage check
    try:
        checks["storage"] = "ok" if settings.storage_root_path.exists() else "unavailable"
    except Exception as exc:
        checks["storage"] = f"error: {exc}"
        healthy = False

    status_code = 200 if healthy else 503
    return JSONResponse(
        status_code=status_code,
        content={"status": "ready" if healthy else "degraded", "checks": checks},
    )


app.include_router(api_v1_router, prefix=settings.API_V1_PREFIX)
