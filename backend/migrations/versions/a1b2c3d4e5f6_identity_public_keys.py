"""identity public keys and wrap types

Revision ID: a1b2c3d4e5f6
Revises: f0a1b2c3d4e5
Create Date: 2026-10-31
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "a1b2c3d4e5f6"
down_revision: Union[str, Sequence[str], None] = "f0a1b2c3d4e5"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    sqlite = bind.dialect.name == "sqlite"

    if not inspector.has_table("identity_public_keys"):
        op.create_table(
            "identity_public_keys",
            sa.Column(
                "user_id",
                sa.Uuid(),
                sa.ForeignKey("users.id", ondelete="CASCADE"),
                primary_key=True,
            ),
            sa.Column(
                "clinic_id",
                sa.Uuid(),
                sa.ForeignKey("clinics.id", ondelete="RESTRICT"),
                nullable=False,
            ),
            sa.Column("public_key", sa.Text(), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        )
        op.create_index(
            "ix_identity_public_keys_clinic_id",
            "identity_public_keys",
            ["clinic_id"],
        )

    wrap_columns = {column["name"] for column in inspector.get_columns("clinic_key_wraps")}
    with op.batch_alter_table(
        "clinic_key_wraps", recreate="always" if sqlite else "auto"
    ) as batch:
        if "wrap_type" not in wrap_columns:
            batch.add_column(
                sa.Column(
                    "wrap_type",
                    sa.String(length=24),
                    nullable=False,
                    server_default="passphrase",
                )
            )
        if "ephemeral_public_key" not in wrap_columns:
            batch.add_column(sa.Column("ephemeral_public_key", sa.Text(), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    sqlite = bind.dialect.name == "sqlite"
    if inspector.has_table("identity_public_keys"):
        op.drop_table("identity_public_keys")
    wrap_columns = {column["name"] for column in inspector.get_columns("clinic_key_wraps")}
    with op.batch_alter_table(
        "clinic_key_wraps", recreate="always" if sqlite else "auto"
    ) as batch:
        if "ephemeral_public_key" in wrap_columns:
            batch.drop_column("ephemeral_public_key")
        if "wrap_type" in wrap_columns:
            batch.drop_column("wrap_type")
