import json
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, require_permission
from app.database import get_db
from app.models import ClinicKeyWrap, IdentityPublicKey, User
from app.schemas.keys import (
    ClinicKeyPublishRequest,
    ClinicKeyStatus,
    ClinicKeyWrapRead,
    ClinicMemberRead,
    IdentityKeyPublish,
    IdentityKeyRead,
)
from app.services.audit_chain import append_audit_entry

router = APIRouter(prefix="/keys", tags=["encryption keys"])


def _validated_ec_p256_jwk(public_key: str) -> None:
    """Refuses anything that is not an ECDH P-256 public JWK.

    The server never uses the key; it parses it only this far, so a typo or a
    hostile blob cannot sit in the table pretending to be one.
    """
    try:
        jwk = json.loads(public_key)
    except json.JSONDecodeError as error:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="The public key must be a JSON Web Key.",
        ) from error
    if not isinstance(jwk, dict) or jwk.get("kty") != "EC" or jwk.get("crv") != "P-256":
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="The identity key must be an ECDH P-256 point (kty EC, crv P-256).",
        )
    if not isinstance(jwk.get("x"), str) or not isinstance(jwk.get("y"), str):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="The identity key is missing its public point coordinates.",
        )


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
                wrap_type=wrap.wrap_type,
                kdf_salt=wrap.kdf_salt,
                kdf_iterations=wrap.kdf_iterations,
                ephemeral_public_key=wrap.ephemeral_public_key,
                created_by=user.id,
            )
        )

    append_audit_entry(
        db,
        clinic_id=user.clinic_id,
        actor_id=user.id,
        action="encryption.clinic_key.published",
        entity_type="clinic_key",
        entity_id=user.clinic_id,
        # Key material is never recorded in the audit trail.
        details={"wraps": str(len(body.wraps))},
    )
    db.commit()
    return clinic_key_status(user=user, db=db)


@router.put("/identity", status_code=status.HTTP_201_CREATED)
def publish_identity_key(
    body: IdentityKeyPublish,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> IdentityKeyRead:
    """
    Publishes (or replaces) the caller's identity public key.

    The private half never leaves the user's device. A replacement is legal —
    a clinician may re-provision a device — but every previously published
    wrap for this user becomes unreadable the moment the key changes, so the
    act is audited.
    """
    _validated_ec_p256_jwk(body.public_key)
    existing = db.get(IdentityPublicKey, user.id)
    replaced = existing is not None
    if existing is None:
        existing = IdentityPublicKey(user_id=user.id, clinic_id=user.clinic_id)
        db.add(existing)
    existing.public_key = body.public_key
    existing.clinic_id = user.clinic_id
    append_audit_entry(
        db,
        clinic_id=user.clinic_id,
        actor_id=user.id,
        action="encryption.identity_key.replaced"
        if replaced
        else "encryption.identity_key.published",
        entity_type="identity_key",
        entity_id=user.id,
    )
    db.commit()
    db.refresh(existing)
    return IdentityKeyRead.model_validate(existing)


@router.get("/identity/{user_id}", response_model=IdentityKeyRead)
def get_identity_key(
    user_id: UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> IdentityKeyRead:
    """A clinic-mate's published public key. Opaque to the server anyway."""
    identity = db.scalar(
        select(IdentityPublicKey).where(
            IdentityPublicKey.user_id == user_id,
            IdentityPublicKey.clinic_id == user.clinic_id,
        )
    )
    if identity is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=(
                "This user has not published an identity key yet, or is not in "
                "your clinic. They must sign in once with the new version."
            ),
        )
    return IdentityKeyRead.model_validate(identity)


@router.get("/clinic/members", response_model=list[ClinicMemberRead])
def list_clinic_members(
    user: User = Depends(require_permission("users.manage")),
    db: Session = Depends(get_db),
) -> list[ClinicMemberRead]:
    """
    The clinic's members with the two flags the share-the-key UI needs:
    who already holds the clinic key, and who has an identity key a holder
    can wrap to. No key material, published or otherwise.
    """
    members = db.scalars(
        select(User).where(User.clinic_id == user.clinic_id).order_by(User.email)
    ).all()
    wrap_holders = set(
        db.scalars(
            select(ClinicKeyWrap.user_id).where(
                ClinicKeyWrap.clinic_id == user.clinic_id
            )
        ).all()
    )
    identity_holders = set(
        db.scalars(
            select(IdentityPublicKey.user_id).where(
                IdentityPublicKey.clinic_id == user.clinic_id
            )
        ).all()
    )
    return [
        ClinicMemberRead(
            id=member.id,
            email=member.email,
            full_name=member.full_name,
            holds_clinic_key=member.id in wrap_holders,
            has_identity_key=member.id in identity_holders,
        )
        for member in members
    ]
