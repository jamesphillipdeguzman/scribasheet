import logging
from concurrent.futures import ThreadPoolExecutor

from app.core.config import get_settings
from app.workers.pipeline import run_transcription_pipeline

logger = logging.getLogger(__name__)

_settings = get_settings()
_local_executor = ThreadPoolExecutor(
    max_workers=max(1, _settings.MAX_CONCURRENT_TRANSCRIPTIONS),
    thread_name_prefix="scriba-worker",
)


def enqueue_transcription_job(job_id: str) -> str | None:
    settings = get_settings()
    if settings.JOB_EXECUTION_MODE == "remote_worker":
        logger.info("Job %s queued for remote local worker claim.", job_id)
        return f"remote-{job_id[:8]}"

    if settings.JOB_EXECUTION_MODE == "celery":
        try:
            from app.workers.celery_app import transcribe_audio_task

            async_res = transcribe_audio_task.delay(job_id)
            return async_res.id
        except Exception as exc:
            logger.warning("Celery dispatch failed (%s); falling back to local background thread.", exc)

    _local_executor.submit(run_transcription_pipeline, job_id)
    return f"local-{job_id[:8]}"
