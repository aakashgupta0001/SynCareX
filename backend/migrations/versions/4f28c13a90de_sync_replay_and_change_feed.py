"""durable sync replay identity and pull change feed

Revision ID: 4f28c13a90de
Revises: a78703b1387b
Create Date: 2026-10-30
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "4f28c13a90de"
down_revision: Union[str, Sequence[str], None] = "a78703b1387b"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "sync_operations",
        sa.Column("request_hash", sa.String(length=64), nullable=True),
    )
    op.add_column(
        "sync_operations",
        sa.Column("schema_version", sa.Integer(), server_default="1", nullable=False),
    )
    op.add_column(
        "sync_operations",
        sa.Column("retryable", sa.Boolean(), server_default=sa.false(), nullable=False),
    )
    op.create_index(
        "uq_sync_operation_id",
        "sync_operations",
        ["operation_id"],
        unique=True,
    )
    op.create_table(
        "sync_changes",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("clinic_id", sa.Uuid(), nullable=False),
        sa.Column("actor_id", sa.Uuid(), nullable=False),
        sa.Column("device_uid", sa.String(length=64), nullable=False),
        sa.Column("operation_id", sa.Uuid(), nullable=True),
        sa.Column("entity_type", sa.String(length=40), nullable=False),
        sa.Column("entity_id", sa.Uuid(), nullable=False),
        sa.Column("operation_type", sa.String(length=24), nullable=False),
        sa.Column("entity_version", sa.Integer(), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.Column("tombstone", sa.Boolean(), server_default=sa.false(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["actor_id"], ["users.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["clinic_id"], ["clinics.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("operation_id", name="uq_sync_change_operation"),
    )
    op.create_index(
        "ix_sync_change_clinic_cursor",
        "sync_changes",
        ["clinic_id", "id"],
    )
    op.create_index(
        "ix_sync_change_clinic_entity",
        "sync_changes",
        ["clinic_id", "entity_type", "entity_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_sync_change_clinic_entity", table_name="sync_changes")
    op.drop_index("ix_sync_change_clinic_cursor", table_name="sync_changes")
    op.drop_table("sync_changes")
    op.drop_index("uq_sync_operation_id", table_name="sync_operations")
    op.drop_column("sync_operations", "retryable")
    op.drop_column("sync_operations", "schema_version")
    op.drop_column("sync_operations", "request_hash")
