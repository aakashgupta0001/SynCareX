"""audit log hash chain (prev_hash, row_hash) with backfill

Revision ID: d1a2b3c4e5f6
Revises: b7f2e6c91a4d
Create Date: 2026-10-31

Adds the per-clinic SHA-256 chain columns to audit_logs and backfills every
existing row in place. Because each row keeps its original created_at, the
recomputed hashes are deterministic: the same canonical string that
app/services/audit_chain.py uses at write time is rebuilt here, oldest row
per clinic first.
"""

from typing import Sequence, Union
from uuid import UUID

from alembic import op
import sqlalchemy as sa
from sqlalchemy import select
from sqlalchemy.orm import Session as OrmSession

try:  # The alembic env puts the backend package on sys.path.
    from app.services.audit_chain import compute_row_hash
except ImportError:  # pragma: no cover - fallback for exotic invocation paths
    # MUST mirror app/services/audit_chain.py::compute_row_hash exactly, or
    # backfilled rows will fail GET /audit/verify forever.
    import hashlib
    import json

    from datetime import UTC, datetime

    def compute_row_hash(
        *,
        prev_hash,
        clinic_id,
        actor_id,
        action,
        entity_type,
        entity_id,
        outcome,
        details,
        created_at,
    ) -> str:
        if isinstance(created_at, str):
            created_at = datetime.fromisoformat(created_at)
        if created_at.tzinfo is None:
            created_at = created_at.replace(tzinfo=UTC)
        details_json = (
            json.dumps(details, sort_keys=True, separators=(",", ":"), default=str)
            if details is not None
            else ""
        )
        canonical = "|".join(
            [
                prev_hash or "",
                str(clinic_id),
                str(actor_id),
                action,
                entity_type,
                str(entity_id) if entity_id is not None else "",
                outcome,
                details_json,
                created_at.astimezone(UTC).isoformat(),
            ]
        )
        return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


revision: str = "d1a2b3c4e5f6"
down_revision: Union[str, Sequence[str], None] = "b7f2e6c91a4d"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    sqlite = bind.dialect.name == "sqlite"
    columns = {column["name"] for column in inspector.get_columns("audit_logs")}
    with op.batch_alter_table(
        "audit_logs", recreate="always" if sqlite else "auto"
    ) as batch:
        if "prev_hash" not in columns:
            batch.add_column(sa.Column("prev_hash", sa.String(length=64), nullable=True))
        if "row_hash" not in columns:
            batch.add_column(sa.Column("row_hash", sa.String(length=64), nullable=True))

    _backfill_chain(bind)


def _backfill_chain(bind) -> None:
    """Rebuild prev_hash/row_hash for every existing row, clinic by clinic.

    Rows are walked oldest-first (created_at asc, id as the deterministic
    tie-break — the same ordering /audit/verify uses), so each row's
    prev_hash is the hash of the row before it in that order.
    """
    from app.models import AuditLog

    session = OrmSession(bind=bind)
    try:
        rows = session.scalars(
            select(AuditLog).order_by(
                AuditLog.clinic_id, AuditLog.created_at, AuditLog.id
            )
        ).all()
        prev_by_clinic: dict[UUID, str | None] = {}
        for row in rows:
            prev = prev_by_clinic.get(row.clinic_id)
            row.prev_hash = prev
            row.row_hash = compute_row_hash(
                prev_hash=prev,
                clinic_id=row.clinic_id,
                actor_id=row.actor_id,
                action=row.action,
                entity_type=row.entity_type,
                entity_id=row.entity_id,
                outcome=row.outcome,
                details=row.details,
                created_at=row.created_at,
            )
            prev_by_clinic[row.clinic_id] = row.row_hash
        session.commit()
    finally:
        session.close()


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    sqlite = bind.dialect.name == "sqlite"
    columns = {column["name"] for column in inspector.get_columns("audit_logs")}
    with op.batch_alter_table(
        "audit_logs", recreate="always" if sqlite else "auto"
    ) as batch:
        for column in ("row_hash", "prev_hash"):
            if column in columns:
                batch.drop_column(column)
