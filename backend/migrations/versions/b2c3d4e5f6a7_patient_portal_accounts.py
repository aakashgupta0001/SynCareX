"""patient portal accounts and nullable audit actor

Revision ID: b2c3d4e5f6a7
Revises: a1b2c3d4e5f6
Create Date: 2026-10-31
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "b2c3d4e5f6a7"
down_revision: Union[str, Sequence[str], None] = "a1b2c3d4e5f6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    sqlite = bind.dialect.name == "sqlite"

    if not inspector.has_table("patient_portal_accounts"):
        op.create_table(
            "patient_portal_accounts",
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
                sa.ForeignKey("patients.id", ondelete="CASCADE"),
                nullable=False,
                unique=True,
            ),
            sa.Column("email", sa.String(length=320), nullable=False, unique=True),
            sa.Column("password_hash", sa.String(length=256), nullable=True),
            sa.Column("enrollment_code_hash", sa.String(length=64), nullable=True),
            sa.Column(
                "enrollment_code_expires_at", sa.DateTime(timezone=True), nullable=True
            ),
            sa.Column("enrolled_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column(
                "is_active", sa.Boolean(), nullable=False, server_default=sa.true()
            ),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        )
        op.create_index(
            "ix_patient_portal_accounts_clinic_id",
            "patient_portal_accounts",
            ["clinic_id"],
        )
        op.create_index(
            "ix_patient_portal_accounts_email",
            "patient_portal_accounts",
            ["email"],
        )

    # Portal events are performed by patients, who are not staff Users, so
    # the audit chain now supports actor-less rows.
    audit_columns = {
        column["name"]: column for column in inspector.get_columns("audit_logs")
    }
    if audit_columns.get("actor_id", {}).get("nullable") is not True:
        with op.batch_alter_table(
            "audit_logs", recreate="always" if sqlite else "auto"
        ) as batch:
            batch.alter_column(
                "actor_id",
                existing_type=sa.Uuid(),
                nullable=True,
            )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if inspector.has_table("patient_portal_accounts"):
        op.drop_table("patient_portal_accounts")
    # actor_id is not narrowed back: existing portal-era audit rows may be
    # actor-less and restoring NOT NULL would strand them.
