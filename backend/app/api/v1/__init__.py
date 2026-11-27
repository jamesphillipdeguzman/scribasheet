from fastapi import APIRouter

from app.api.v1 import (
    archives,
    auth,
    billing,
    exports,
    lyrics,
    projects,
    score,
    transcriptions,
    uploads,
    worker,
)

api_v1_router = APIRouter()
api_v1_router.include_router(auth.router)
api_v1_router.include_router(projects.router)
api_v1_router.include_router(archives.router)
api_v1_router.include_router(uploads.router)
api_v1_router.include_router(transcriptions.router)
api_v1_router.include_router(score.router)
api_v1_router.include_router(lyrics.router)
api_v1_router.include_router(exports.router)
api_v1_router.include_router(billing.router)
api_v1_router.include_router(worker.router)
