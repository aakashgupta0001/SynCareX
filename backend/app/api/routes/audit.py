from uuid import UUID

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.deps import require_permission
from app.database import get_db
from app.models import AuditLog, User
from app.schemas.audit import AuditLogPage, AuditVerifyResponse
from app.services.audit_chain import compute_row_hash

router = APIRouter(prefix="/audit", tags=["audit"])


@router.get("", response_model=AuditLogPage)
def list_audit_events(
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=100),
    user: User = Depends(require_permission("audit.read")),
    db: Session = Depends(get_db),
) -> AuditLogPage:
    scope = AuditLog.clinic_id == user.clinic_id
    total = db.scalar(select(func.count()).select_from(AuditLog).where(scope)) or 0
    items = db.scalars(
        select(AuditLog)
        .where(scope)
        .order_by(AuditLog.created_at.desc(), AuditLog.id)
        .offset((page - 1) * page_size)
        .limit(page_size)
    ).all()
    return AuditLogPage(items=items, page=page, page_size=page_size, total=total)


@router.get("/verify", response_model=AuditVerifyResponse)
def verify_audit_chain(
    user: User = Depends(require_permission("audit.read")),
    db: Session = Depends(get_db),
) -> AuditVerifyResponse:
    """Recompute the clinic's hash chain row by row and report breaks.

    The same canonical string that produced each stored row_hash is rebuilt
    from the row's persisted fields, so any edit to a hashed field — or a
    missing row between two links — shows up here.
    """
    rows = db.scalars(
        select(AuditLog)
        .where(AuditLog.clinic_id == user.clinic_id)
        .order_by(AuditLog.created_at.asc(), AuditLog.id.asc())
    ).all()

    # A chain "starts" at its first hashed row; before that, legacy rows
    # without hashes are expected and not, by themselves, tampering.
    chain_started = any(row.row_hash for row in rows)
    first_broken: UUID | None = None
    rows_without_hash = 0
    prev_hash: str | None = None

    for row in rows:
        if row.row_hash is None:
            rows_without_hash += 1
            if chain_started and first_broken is None:
                first_broken = row.id
            prev_hash = None
            continue
        expected = compute_row_hash(
            prev_hash=prev_hash,
            clinic_id=row.clinic_id,
            actor_id=row.actor_id,
            action=row.action,
            entity_type=row.entity_type,
            entity_id=row.entity_id,
            outcome=row.outcome,
            details=row.details,
            created_at=row.created_at,
        )
        if first_broken is None and (row.prev_hash != prev_hash or expected != row.row_hash):
            first_broken = row.id
        prev_hash = row.row_hash

    valid = first_broken is None and (rows_without_hash == 0 or not chain_started)
    return AuditVerifyResponse(
        clinic_id=user.clinic_id,
        checked=len(rows),
        valid=valid,
        first_broken=first_broken,
        rows_without_hash=rows_without_hash,
    )
