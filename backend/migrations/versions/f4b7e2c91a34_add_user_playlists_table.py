"""Add user_playlists table for optional Neon playlist library sync.

Revision ID: f4b7e2c91a34
Revises: e3a4c19f8b12
Create Date: 2026-11-28 20:52:00.000000
"""

from alembic import op
import sqlalchemy as sa

revision = "f4b7e2c91a34"
down_revision = "e3a4c19f8b12"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "user_playlists",
        sa.Column("id", sa.String(length=36), primary_key=True, nullable=False),
        sa.Column(
            "user_id",
            sa.String(length=36),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("record_type", sa.String(length=24), nullable=False, server_default="playlist"),
        sa.Column("client_id", sa.String(length=80), nullable=False),
        sa.Column("title", sa.String(length=200), nullable=False, server_default=""),
        sa.Column("description", sa.Text(), nullable=False, server_default=""),
        sa.Column("category_id", sa.String(length=80), nullable=False, server_default="cat-practice-reference"),
        sa.Column("position", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("tracks_json", sa.JSON(), nullable=False),
        sa.Column("metadata_json", sa.JSON(), nullable=False),
        sa.Column("is_shared", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("share_token", sa.String(length=96), nullable=True),
        sa.Column("shared_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("user_id", "record_type", "client_id", name="uq_user_playlists_user_type_client"),
    )
    op.create_index("ix_user_playlists_user_id", "user_playlists", ["user_id"], unique=False)
    op.create_index("ix_user_playlists_user_pos", "user_playlists", ["user_id", "record_type", "position"], unique=False)
    op.create_index("ix_user_playlists_is_shared", "user_playlists", ["is_shared"], unique=False)
    op.create_index("ix_user_playlists_share_token", "user_playlists", ["share_token"], unique=True)


def downgrade() -> None:
    op.drop_index("ix_user_playlists_share_token", table_name="user_playlists")
    op.drop_index("ix_user_playlists_is_shared", table_name="user_playlists")
    op.drop_index("ix_user_playlists_user_pos", table_name="user_playlists")
    op.drop_index("ix_user_playlists_user_id", table_name="user_playlists")
    op.drop_table("user_playlists")
