"""Add worker_nodes table for persistent worker availability tracking.

Revision ID: e3a4c19f8b12
Revises: d29c258b766e
Create Date: 2026-11-17 15:25:00.000000
"""

from alembic import op
import sqlalchemy as sa

revision = "e3a4c19f8b12"
down_revision = "d29c258b766e"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "worker_nodes",
        sa.Column("worker_id", sa.String(length=128), primary_key=True, nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False, server_default="online"),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("active_job_id", sa.String(length=36), nullable=True),
        sa.Column("metadata_json", sa.JSON(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_worker_nodes_last_seen_at", "worker_nodes", ["last_seen_at"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_worker_nodes_last_seen_at", table_name="worker_nodes")
    op.drop_table("worker_nodes")
