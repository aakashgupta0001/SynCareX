from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, require_permission
from app.database import get_db
from app.models import AuditLog, ClinicKeyWrap, User
from app.schemas.keys import (
    ClinicKeyPublishRequest,
    ClinicKeyStatus,
    ClinicKeyWrapRead,
)

router = APIRouter(prefix="/keys", tags=["encryption keys"])


@router.get("/clinic", response_model=ClinicKeyWrapRead)
def get_my_clinic_key_wrap(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> ClinicKeyWrapRead:
    """
    Returns the caller's own wrapped clinic key.

    A user may only ever fetch their own wrap, and only for their own clinic.
    The response is opaque ciphertext; the server cannot open it.
    """
    wrap = db.scalar(
        select(ClinicKeyWrap)
        .where(
            ClinicKeyWrap.clinic_id == user.clinic_id,
            ClinicKeyWrap.user_id == user.id,
        )
        .order_by(ClinicKeyWrap.key_epoch.desc())
    )
    if wrap is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=(
                "No clinic key is wrapped for this account. A device that already "
                "holds the clinic key must publish a wrap for you."
            ),
        )
    return ClinicKeyWrapRead.model_validate(wrap)


@router.get("/clinic/status", response_model=ClinicKeyStatus)
def clinic_key_status(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> ClinicKeyStatus:
    epoch = db.scalar(
        select(func.max(ClinicKeyWrap.key_epoch)).where(
            ClinicKeyWrap.clinic_id == user.clinic_id
        )
    )
    mine = db.scalar(
        select(func.count())
        .select_from(ClinicKeyWrap)
        .where(
            ClinicKeyWrap.clinic_id == user.clinic_id,
            ClinicKeyWrap.user_id == user.id,
        )
    )
    holders = db.scalar(
        select(func.count(func.distinct(ClinicKeyWrap.user_id))).where(
            ClinicKeyWrap.clinic_id == user.clinic_id
        )
    )
    return ClinicKeyStatus(
        clinic_id=user.clinic_id,
        key_epoch=epoch,
        wrapped_for_this_user=bool(mine),
        user_count_with_access=holders or 0,
        # Deliberately hardcoded: the key exists, but no clinical record is
        # encrypted with it yet. See docs/security/E2E_ENCRYPTION_DESIGN.md.
        records_encrypted=False,
    )


@router.post("/clinic", response_model=ClinicKeyStatus, status_code=status.HTTP_201_CREATED)
def publish_clinic_key_wraps(
    body: ClinicKeyPublishRequest,
    user: User = Depends(require_permission("users.manage")),
    db: Session = Depends(get_db),
) -> ClinicKeyStatus:
    """
    Publishes wrapped copies of a clinic key, one per user.

    The caller's device generated the key and wrapped it; the server only
    stores the blobs. Wraps may only be published for users in the caller's
    own clinic, and an existing epoch is never silently replaced — rotating
    the key means publishing a higher epoch.
    """
    target_ids: set[UUID] = {wrap.user_id for wrap in body.wraps}
    members = db.scalars(
        select(User.id).where(User.clinic_id == user.clinic_id, User.id.in_(target_ids))
    ).all()
    outside = target_ids - set(members)
    if outside:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="A clinic key may only be wrapped for users in your own clinic.",
        )

    # Only a holder of the clinic key can publish wraps once the clinic has
    # one. A caller without a wrap cannot know the existing key, so anything
    # it publishes would be a second, different key at the same epoch: one
    # clinic would end up with records and search hashes split across keys.
    caller_holds_key = db.scalar(
        select(func.count())
        .select_from(ClinicKeyWrap)
        .where(
            ClinicKeyWrap.clinic_id == user.clinic_id,
            ClinicKeyWrap.user_id == user.id,
        )
    )
    clinic_has_key = db.scalar(
        select(func.count())
        .select_from(ClinicKeyWrap)
        .where(ClinicKeyWrap.clinic_id == user.clinic_id)
    )
    if clinic_has_key and not caller_holds_key:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                "This clinic already has an encryption key. A user who holds it "
                "must share it with you; creating a new one would split the clinic's data."
            ),
        )

    for wrap in body.wraps:
        existing = db.scalar(
            select(ClinicKeyWrap).where(
                ClinicKeyWrap.clinic_id == user.clinic_id,
                ClinicKeyWrap.user_id == wrap.user_id,
                ClinicKeyWrap.key_epoch == wrap.key_epoch,
            )
        )
        if existing is not None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=(
                    "A wrap already exists for that user at this key epoch. "
                    "Publish a higher epoch to rotate the clinic key."
                ),
            )
        db.add(
            ClinicKeyWrap(
                clinic_id=user.clinic_id,
                user_id=wrap.user_id,
                key_epoch=wrap.key_epoch,
                wrapped_key=wrap.wrapped_key,
                wrap_iv=wrap.wrap_iv,
                kdf_salt=wrap.kdf_salt,
                kdf_iterations=wrap.kdf_iterations,
                created_by=user.id,
            )
        )

    db.add(
        AuditLog(
            clinic_id=user.clinic_id,
            actor_id=user.id,
            action="encryption.clinic_key.published",
            entity_type="clinic_key",
            entity_id=user.clinic_id,
            # Key material is never recorded in the audit trail.
            details={"wraps": str(len(body.wraps))},
        )
    )
    db.commit()
    return clinic_key_status(user=user, db=db)
