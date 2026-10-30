from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, require_permission
from app.core.config import get_settings
from app.database import get_db
from app.models import Device, User
from app.schemas.sync import (
    DeviceProvisionRequest,
    DeviceProvisionResponse,
    SyncBatchRequest,
    SyncBatchResponse,
    SyncChangeRead,
    SyncPullResponse,
)
from app.models import SyncChangeRecord
from app.services.sync import SyncService

router = APIRouter(prefix="/sync", tags=["synchronization"])


@router.post("/operations", response_model=SyncBatchResponse)
def apply_operations(
    body: SyncBatchRequest,
    user: User = Depends(require_permission("patients.write")),
    db: Session = Depends(get_db),
) -> SyncBatchResponse:
    """
    Applies a batch of queued device operations. Every operation is reported
    individually, so a batch can be partially successful; the device keeps any
    operation that was not acknowledged.
    """
    settings = get_settings()
    if len(body.operations) > settings.sync_batch_limit:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"Send at most {settings.sync_batch_limit} operations per request.",
        )

    device = db.scalar(
        select(Device).where(
            Device.device_uid == body.device_id, Device.clinic_id == user.clinic_id
        )
    )
    if device is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=(
                "This device is not provisioned for synchronization. Provision the "
                "device before synchronizing; queued records stay on the device."
            ),
        )
    if device.status != "active":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This device's authorization has been revoked.",
        )

    for operation in body.operations:
        if operation.actor_id is not None and operation.actor_id != user.id:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Operation actor does not match the authenticated user.",
            )
        if operation.device_id is not None and operation.device_id != body.device_id:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Operation device does not match the batch device.",
            )

    device.last_seen_at = datetime.now(UTC)
    db.commit()

    results = SyncService(db, user, body.device_id).apply_batch(body.operations)
    return SyncBatchResponse(
        results=results,
        server_time=datetime.now(UTC),
        acknowledged=sum(1 for result in results if result.status == "acknowledged"),
        conflicts=sum(1 for result in results if result.status == "conflict"),
        rejected=sum(1 for result in results if result.status == "rejected"),
    )


@router.get("/changes", response_model=SyncPullResponse)
def pull_changes(
    device_id: str = Query(..., min_length=8, max_length=64),
    cursor: int = 0,
    limit: int = 200,
    user: User = Depends(require_permission("patients.read")),
    db: Session = Depends(get_db),
) -> SyncPullResponse:
    """Return a bounded, clinic-scoped page from the durable change feed."""
    settings = get_settings()
    if cursor < 0 or cursor > 9_007_199_254_740_991:
        raise HTTPException(
            status_code=422,
            detail="Cursor must be a non-negative safe integer.",
        )
    if limit < 1 or limit > settings.sync_pull_limit:
        raise HTTPException(
            status_code=422,
            detail=f"Limit must be between 1 and {settings.sync_pull_limit}.",
        )

    device = db.scalar(
        select(Device).where(
            Device.device_uid == device_id, Device.clinic_id == user.clinic_id
        )
    )
    if device is None or device.status != "active":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This device is not authorized to pull synchronization changes.",
        )

    page = list(
        db.scalars(
            select(SyncChangeRecord)
            .where(
                SyncChangeRecord.clinic_id == user.clinic_id,
                SyncChangeRecord.id > cursor,
            )
            .order_by(SyncChangeRecord.id)
            .limit(limit + 1)
        )
    )
    has_more = len(page) > limit
    page = page[:limit]
    changes = [
        SyncChangeRead(
            cursor=record.id,
            operation_id=record.operation_id,
            entity_type=record.entity_type,
            entity_id=record.entity_id,
            operation_type=record.operation_type,
            entity_version=record.entity_version,
            payload=record.payload,
            tombstone=record.tombstone,
            created_at=record.created_at,
        )
        for record in page
    ]
    return SyncPullResponse(
        changes=changes,
        next_cursor=changes[-1].cursor if changes else cursor,
        has_more=has_more,
    )


@router.post("/devices/provision", response_model=DeviceProvisionResponse)
def provision_device(
    body: DeviceProvisionRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> DeviceProvisionResponse:
    """
    Authorizes the calling browser for offline clinical work. This requires a
    server-authenticated session; offline access is a continuation of it, not
    a way around it.
    """
    settings = get_settings()
    device = db.scalar(
        select(Device).where(
            Device.device_uid == body.device_id, Device.clinic_id == user.clinic_id
        )
    )
    if device is None:
        device = Device(
            clinic_id=user.clinic_id,
            device_uid=body.device_id,
            label=body.label,
            status="active",
            provisioned_by=user.id,
            offline_grace_days=settings.offline_grace_days,
            last_seen_at=datetime.now(UTC),
        )
        db.add(device)
    else:
        if device.status != "active":
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="This device's authorization has been revoked by an administrator.",
            )
        device.label = body.label
        device.last_seen_at = datetime.now(UTC)
        device.offline_grace_days = settings.offline_grace_days
    db.commit()
    db.refresh(device)
    return DeviceProvisionResponse(
        device_id=device.device_uid,
        server_device_id=device.id,
        status=device.status,
        offline_grace_days=device.offline_grace_days,
        provisioned_at=device.created_at,
    )
