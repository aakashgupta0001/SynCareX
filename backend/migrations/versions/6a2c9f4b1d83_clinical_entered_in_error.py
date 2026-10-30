"""add entered-in-error state to clinical records

Revision ID: 6a2c9f4b1d83
Revises: bd89476e9537
Create Date: 2026-10-30
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "6a2c9f4b1d83"
down_revision: Union[str, Sequence[str], None] = "bd89476e9537"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    sqlite = bind.dialect.name == "sqlite"
    for table in ("observations", "allergy_records", "medication_records"):
        columns = {column["name"] for column in inspector.get_columns(table)}
        foreign_keys = inspector.get_foreign_keys(table)
        actor_fk_exists = any(
            foreign_key.get("referred_table") == "users"
            and foreign_key.get("constrained_columns") == ["entered_in_error_by"]
            for foreign_key in foreign_keys
        )
        with op.batch_alter_table(
            table, recreate="always" if sqlite else "auto"
        ) as batch:
            if "entered_in_error_at" not in columns:
                batch.add_column(
                    sa.Column(
                        "entered_in_error_at",
                        sa.DateTime(timezone=True),
                        nullable=True,
                    )
                )
            if "entered_in_error_by" not in columns:
                batch.add_column(
                    sa.Column("entered_in_error_by", sa.Uuid(), nullable=True)
                )
            if not actor_fk_exists:
                batch.create_foreign_key(
                    f"fk_{table}_entered_in_error_by_users",
                    "users",
                    ["entered_in_error_by"],
                    ["id"],
                    ondelete="RESTRICT",
                )
            if "entered_in_error_reason" not in columns:
                batch.add_column(
                    sa.Column(
                        "entered_in_error_reason",
                        sa.String(length=500),
                        nullable=True,
                    )
                )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    sqlite = bind.dialect.name == "sqlite"
    for table in ("medication_records", "allergy_records", "observations"):
        columns = {column["name"] for column in inspector.get_columns(table)}
        actor_fk = next(
            (
                foreign_key
                for foreign_key in inspector.get_foreign_keys(table)
                if foreign_key.get("referred_table") == "users"
                and foreign_key.get("constrained_columns") == ["entered_in_error_by"]
            ),
            None,
        )
        with op.batch_alter_table(
            table, recreate="always" if sqlite else "auto"
        ) as batch:
            if actor_fk and actor_fk.get("name"):
                batch.drop_constraint(actor_fk["name"], type_="foreignkey")
            for column in (
                "entered_in_error_reason",
                "entered_in_error_by",
                "entered_in_error_at",
            ):
                if column in columns:
                    batch.drop_column(column)
