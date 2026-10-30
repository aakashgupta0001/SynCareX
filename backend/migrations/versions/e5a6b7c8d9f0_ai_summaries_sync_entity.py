"""ai summaries sync entity

Revision ID: e5a6b7c8d9f0
Revises: c8d4e7f2a1b3
Create Date: 2026-10-31
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "e5a6b7c8d9f0"
down_revision: Union[str, Sequence[str], None] = "c8d4e7f2a1b3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if inspector.has_table("ai_summaries"):
        return
    op.create_table(
        "ai_summaries",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "clinic_id",
            sa.Uuid(),
            sa.ForeignKey("clinics.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column(
            "patient_id",
            sa.Uuid(),
            sa.ForeignKey("patients.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column(
            "author_id",
            sa.Uuid(),
            sa.ForeignKey("users.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column("source_artifact_id", sa.String(length=100), nullable=True),
        sa.Column("sections", sa.JSON(), nullable=True),
        sa.Column(
            "clinician_edited", sa.Boolean(), nullable=False, server_default=sa.true()
        ),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index(
        "ix_ai_summary_patient", "ai_summaries", ["clinic_id", "patient_id"]
    )
    op.create_index("ix_ai_summaries_patient_id", "ai_summaries", ["patient_id"])


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if inspector.has_table("ai_summaries"):
        op.drop_table("ai_summaries")
