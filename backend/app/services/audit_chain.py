"""Tamper-evident audit log: per-clinic SHA-256 hash chain.

Every audit row carries ``prev_hash`` (the previous row's hash for the same
clinic) and ``row_hash`` (a digest over the row's own contents plus that
previous hash). Altering any persisted field of a row — or removing a row
that has a successor — breaks every hash after it, which the
``GET /audit/verify`` endpoint detects by walking the chain.

The chain is per clinic so one clinic's actors learn nothing about another's
activity, and a compromise of one clinic's tail cannot be used to re-anchor
another's.

Concurrency note: the previous row is selected ``with_for_update()`` so
concurrent appends on databases with real row locks (PostgreSQL) serialize
on the tail. SQLite ignores the lock; two simultaneous appends there could
pick the same ``prev_hash`` and leave the chain forked until verify flags
it. Appends also happen inside the caller's transaction, so a rollback
never leaves a half-written link.
"""

import hashlib
import json
from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import AuditLog
from app.models.entities import utc_now


def _format_timestamp(created_at: datetime) -> str:
    """ISO-8601 UTC, stable across database round-trips.

    SQLite stores datetimes without timezone information, so a naive value
    is interpreted as UTC here — the same instant the writer hashed.
    """
    if created_at.tzinfo is None:
        created_at = created_at.replace(tzinfo=UTC)
    return created_at.astimezone(UTC).isoformat()


def compute_row_hash(
    *,
    prev_hash: str | None,
    clinic_id: UUID,
    actor_id: UUID | None,
    action: str,
    entity_type: str,
    entity_id: UUID | None,
    outcome: str,
    details: dict[str, str] | None,
    created_at: datetime,
) -> str:
    """SHA-256 hex digest of a row's canonical representation.

    The canonical string joins, with "|" separators and in this exact
    order: prev_hash (empty when None), clinic_id, actor_id, action,
    entity_type, entity_id (empty when None), outcome, JSON-serialized
    details (sorted keys, compact separators, empty when None), and
    created_at as ISO-8601 UTC. The backfill migration reuses this function
    so stored hashes and recomputed hashes can never drift apart.
    """
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
            _format_timestamp(created_at),
        ]
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def append_audit_entry(
    db: Session,
    *,
    clinic_id: UUID,
    actor_id: UUID | None,
    action: str,
    entity_type: str,
    entity_id: UUID | None = None,
    outcome: str = "success",
    details: dict[str, str] | None = None,
) -> AuditLog:
    """Create the next audit row in the clinic's hash chain.

    The row is only added to the session; the caller commits, exactly as it
    did when it built the ``AuditLog`` itself, so the audit entry shares the
    caller transaction's fate.
    """
    entry = AuditLog(
        clinic_id=clinic_id,
        actor_id=actor_id,
        action=action,
        entity_type=entity_type,
        entity_id=entity_id,
        outcome=outcome,
        details=details,
    )
    # Stamp created_at before hashing so the digest covers the exact value
    # that will be stored rather than whatever the column default computes.
    entry.created_at = utc_now()

    # The clinic's tail: most recent row wins, id breaks ties deterministically.
    # with_for_update() serializes concurrent appends where the dialect
    # supports row locks (it is ignored on SQLite).
    tail = db.scalar(
        select(AuditLog)
        .where(AuditLog.clinic_id == clinic_id)
        .order_by(AuditLog.created_at.desc(), AuditLog.id.desc())
        .limit(1)
        .with_for_update()
    )
    entry.prev_hash = tail.row_hash if tail is not None else None
    entry.row_hash = compute_row_hash(
        prev_hash=entry.prev_hash,
        clinic_id=clinic_id,
        actor_id=actor_id,
        action=action,
        entity_type=entity_type,
        entity_id=entity_id,
        outcome=outcome,
        details=details,
        created_at=entry.created_at,
    )
    db.add(entry)
    return entry
