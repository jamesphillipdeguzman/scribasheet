"""Idempotent Alembic migration runner for container startup.

Safely handles existing databases that were originally initialized via
Base.metadata.create_all() without an alembic_version table, while still
failing loudly on genuine migration errors.
"""

from __future__ import annotations

import logging
from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import inspect, text

from app.db.session import engine

logger = logging.getLogger("scribasheet.migrate")

REV_INITIAL = "9a2f8e3e2cac"
REV_WORKER_LEASES = "d29c258b766e"
REV_WORKER_NODES = "e3a4c19f8b12"


def _alembic_config() -> Config:
    backend_dir = Path(__file__).resolve().parents[2]
    ini_path = backend_dir / "alembic.ini"
    cfg = Config(str(ini_path))
    cfg.set_main_option("script_location", str(backend_dir / "migrations"))
    return cfg


def _detect_unstamped_revision(tables: set[str], inspector) -> str:
    if "worker_nodes" in tables:
        return REV_WORKER_NODES
    if "transcription_jobs" in tables:
        cols = {col["name"] for col in inspector.get_columns("transcription_jobs")}
        if "locked_by_worker" in cols:
            return REV_WORKER_LEASES
    return REV_INITIAL


def run_startup_migrations(target_engine=engine) -> None:
    cfg = _alembic_config()
    safe_url = target_engine.url.render_as_string(hide_password=False).replace("%", "%%")
    cfg.set_main_option("sqlalchemy.url", safe_url)

    inspector = inspect(target_engine)
    tables = set(inspector.get_table_names())

    has_alembic_row = False
    if "alembic_version" in tables:
        with target_engine.connect() as conn:
            row = conn.execute(text("SELECT version_num FROM alembic_version LIMIT 1")).fetchone()
            has_alembic_row = row is not None

    with target_engine.begin() as conn:
        cfg.attributes["connection"] = conn
        if not has_alembic_row and "users" in tables:
            detected_rev = _detect_unstamped_revision(tables, inspector)
            logger.warning(
                "Existing database has tables without alembic_version; stamping revision %s before upgrading to head.",
                detected_rev,
            )
            command.stamp(cfg, detected_rev)

        logger.info("Running Alembic upgrade to head...")
        command.upgrade(cfg, "head")
    logger.info("Alembic migrations are up to date (head).")


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
    run_startup_migrations()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
