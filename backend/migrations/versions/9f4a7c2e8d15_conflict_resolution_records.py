"""conflict resolution records

Revision ID: 9f4a7c2e8d15
Revises: d1a2b3c4e5f6
Create Date: 2026-10-31

Stores the server-side receipt of a clinician's conflict decision: who
resolved what, when, and which version won.
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "9f4a7c2e8d15"
down_revision: Union[str, Sequence[str], None] = "d1a2b3c4e5f6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if "conflict_resolutions" in inspector.get_table_names():
        return
    op.create_table(
        "conflict_resolutions",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "clinic_id",
            sa.Uuid(),
            sa.ForeignKey("clinics.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column("entity_type", sa.String(length=40), nullable=False),
        sa.Column("entity_id", sa.Uuid(), nullable=False),
        sa.Column("base_version", sa.Integer(), nullable=False),
        sa.Column("winning_version", sa.Integer(), nullable=False),
        sa.Column("winner_source", sa.String(length=16), nullable=False),
        sa.Column(
            "resolved_by",
            sa.Uuid(),
            sa.ForeignKey("users.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column("field_decisions", sa.JSON(), nullable=True),
        sa.Column(
            "resolved_at", sa.DateTime(timezone=True), nullable=False
        ),
    )
    op.create_index(
        "ix_conflict_resolution_clinic_resolved",
        "conflict_resolutions",
        ["clinic_id", "resolved_at"],
    )
    op.create_index(
        "ix_conflict_resolution_clinic_entity",
        "conflict_resolutions",
        ["clinic_id", "entity_type", "entity_id"],
    )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if "conflict_resolutions" not in inspector.get_table_names():
        return
    op.drop_index(
        "ix_conflict_resolution_clinic_entity", table_name="conflict_resolutions"
    )
    op.drop_index(
        "ix_conflict_resolution_clinic_resolved", table_name="conflict_resolutions"
    )
    op.drop_table("conflict_resolutions")
