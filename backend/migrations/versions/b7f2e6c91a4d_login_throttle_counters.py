"""login throttle counters

Revision ID: b7f2e6c91a4d
Revises: 6a2c9f4b1d83
Create Date: 2026-10-31
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "b7f2e6c91a4d"
down_revision: Union[str, Sequence[str], None] = "6a2c9f4b1d83"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if inspector.has_table("login_attempt_counters"):
        return
    op.create_table(
        "login_attempt_counters",
        sa.Column("email", sa.String(length=320), primary_key=True),
        sa.Column(
            "failed_attempts", sa.Integer(), nullable=False, server_default="0"
        ),
        sa.Column("locked_until", sa.DateTime(timezone=True), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if inspector.has_table("login_attempt_counters"):
        op.drop_table("login_attempt_counters")
