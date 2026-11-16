from celery import Celery

from app.core.config import get_settings

settings = get_settings()

celery_app = Celery(
    "scribasheet",
    broker=settings.CELERY_BROKER_URL,
    backend=settings.CELERY_RESULT_BACKEND,
)

celery_app.conf.update(
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    timezone="UTC",
    enable_utc=True,
    task_track_started=True,
    task_time_limit=settings.TRANSCRIPTION_TASK_TIMEOUT_SECONDS,
    worker_prefetch_multiplier=1,
)


@celery_app.task(name="scribasheet.transcribe", bind=True, max_retries=2)
def transcribe_audio_task(self, job_id: str) -> dict:
    from app.workers.pipeline import run_transcription_pipeline

    run_transcription_pipeline(job_id)
    return {"job_id": job_id, "status": "done"}
