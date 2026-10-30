from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.deps import require_permission
from app.database import get_db
from app.models import AuditLog, User
from app.schemas.audit import AuditLogPage

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
