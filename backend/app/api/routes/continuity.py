from datetime import UTC, datetime, time
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, require_permission
from app.database import get_db
from app.models import (
    Clinic,
    ClinicPairing,
    ClinicTransferPackage,
    EmergencyPassport,
    PatientFollowUp,
    Referral,
    User,
)
from app.schemas.continuity import (
    ClinicPairingCreate,
    ClinicPairingRead,
    EmergencyPassportCreate,
    EmergencyPassportRead,
    EmergencyPassportRevokeRequest,
    EmergencyPassportVerifyRequest,
    EmergencyPassportVerifyResponse,
    FHIRValidationResult,
    FollowUpCreate,
    FollowUpRead,
    FollowUpReschedule,
    FollowUpStatus,
    FollowUpUpdate,
    ReferralCreate,
    ReferralRead,
    ReferralStatus,
    ReferralStatusUpdate,
    ReferralUpdate,
    TransferImportRequest,
    TransferImportResponse,
    TransferPackageCreate,
    TransferPackageRead,
)
from app.services.continuity import ContinuityService

router = APIRouter(prefix="/continuity", tags=["healthcare-continuity"])


# =============================================================================
# 1. EMERGENCY PATIENT PASSPORTS
# =============================================================================


@router.post(
    "/passports",
    response_model=EmergencyPassportRead,
    status_code=status.HTTP_201_CREATED,
)
def issue_emergency_passport(
    body: EmergencyPassportCreate,
    user: User = Depends(require_permission("passports.create")),
    db: Session = Depends(get_db),
) -> EmergencyPassportRead:
    try:
        passport = ContinuityService(db, user).issue_passport(body)
        return EmergencyPassportRead.model_validate(passport)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))


@router.get("/passports/{passport_id}", response_model=EmergencyPassportRead)
def get_emergency_passport(
    passport_id: UUID,
    user: User = Depends(require_permission("passports.read")),
    db: Session = Depends(get_db),
) -> EmergencyPassportRead:
    passport = db.scalar(
        select(EmergencyPassport).where(
            EmergencyPassport.id == passport_id,
            EmergencyPassport.clinic_id == user.clinic_id,
        )
    )
    if passport is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Passport not found"
        )
    return EmergencyPassportRead.model_validate(passport)


@router.post("/passports/verify", response_model=EmergencyPassportVerifyResponse)
def verify_emergency_passport(
    body: EmergencyPassportVerifyRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> EmergencyPassportVerifyResponse:
    """
    Verifies an emergency passport token online. Enforces signature, expiry,
    and revocation checks.
    """
    return ContinuityService(db, user).verify_passport(body.token)


@router.post("/passports/{passport_id}/revoke", response_model=EmergencyPassportRead)
def revoke_emergency_passport(
    passport_id: UUID,
    body: EmergencyPassportRevokeRequest,
    user: User = Depends(require_permission("passports.revoke")),
    db: Session = Depends(get_db),
) -> EmergencyPassportRead:
    try:
        passport = ContinuityService(db, user).revoke_passport(passport_id, body.reason)
        return EmergencyPassportRead.model_validate(passport)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(e))


@router.get("/passports/revocations/list")
def get_passport_revocations(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[dict[str, Any]]:
    """Returns Certificate Revocation List for offline synchronization and caching."""
    return ContinuityService(db, user).get_revocation_list()


# =============================================================================
# 2. SMART REFERRAL CONTINUITY
# =============================================================================


@router.post(
    "/referrals",
    response_model=ReferralRead,
    status_code=status.HTTP_201_CREATED,
)
def create_referral(
    body: ReferralCreate,
    user: User = Depends(require_permission("referrals.create")),
    db: Session = Depends(get_db),
) -> ReferralRead:
    try:
        referral = ContinuityService(db, user).create_referral(body)
        return ReferralRead.model_validate(referral)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))


@router.get("/referrals", response_model=list[ReferralRead])
def list_referrals(
    direction: str = Query("all", pattern="^(inbound|outbound|all)$"),
    status_filter: ReferralStatus | None = Query(None, alias="status"),
    patient_id: UUID | None = None,
    user: User = Depends(require_permission("referrals.read")),
    db: Session = Depends(get_db),
) -> list[ReferralRead]:
    query = select(Referral)
    if direction == "outbound":
        query = query.where(Referral.referring_clinic_id == user.clinic_id)
    elif direction == "inbound":
        query = query.where(Referral.receiving_clinic_id == user.clinic_id)
    else:
        query = query.where(
            or_(
                Referral.referring_clinic_id == user.clinic_id,
                Referral.receiving_clinic_id == user.clinic_id,
            )
        )

    if status_filter:
        query = query.where(Referral.status == status_filter)
    if patient_id:
        query = query.where(Referral.patient_id == patient_id)

    query = query.order_by(Referral.created_at.desc())
    referrals = db.scalars(query).all()
    return [ReferralRead.model_validate(r) for r in referrals]


@router.get("/referrals/{referral_id}", response_model=ReferralRead)
def get_referral(
    referral_id: UUID,
    user: User = Depends(require_permission("referrals.read")),
    db: Session = Depends(get_db),
) -> ReferralRead:
    referral = db.scalar(
        select(Referral).where(
            Referral.id == referral_id,
            or_(
                Referral.referring_clinic_id == user.clinic_id,
                Referral.receiving_clinic_id == user.clinic_id,
            ),
        )
    )
    if referral is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Referral not found"
        )
    return ReferralRead.model_validate(referral)


@router.patch("/referrals/{referral_id}", response_model=ReferralRead)
def update_referral(
    referral_id: UUID,
    body: ReferralUpdate,
    user: User = Depends(require_permission("referrals.create")),
    db: Session = Depends(get_db),
) -> ReferralRead:
    try:
        referral = ContinuityService(db, user).update_referral(referral_id, body)
        return ReferralRead.model_validate(referral)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))


@router.post("/referrals/{referral_id}/status", response_model=ReferralRead)
def update_referral_status(
    referral_id: UUID,
    body: ReferralStatusUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> ReferralRead:
    permissions = {grant.key for role in user.roles for grant in role.permissions}
    if body.status == "approved" and "referrals.approve" not in permissions:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Authorization required: Only authorized clinicians can approve referrals",
        )
    if body.status == "sent" and "referrals.send" not in permissions:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Authorization required: Only authorized clinicians can send referrals",
        )

    try:
        referral = ContinuityService(db, user).transition_referral_status(
            referral_id, body.status, body.note
        )
        return ReferralRead.model_validate(referral)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))


# =============================================================================
# 3. PATIENT FOLLOW-UP MANAGER
# =============================================================================


@router.post(
    "/followups",
    response_model=FollowUpRead,
    status_code=status.HTTP_201_CREATED,
)
def create_followup(
    body: FollowUpCreate,
    user: User = Depends(require_permission("followups.manage")),
    db: Session = Depends(get_db),
) -> FollowUpRead:
    try:
        followup = ContinuityService(db, user).create_followup(body)
        return FollowUpRead.model_validate(followup)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))


@router.get("/followups", response_model=list[FollowUpRead])
def list_followups(
    filter_mode: str = Query("all", pattern="^(all|today|overdue)$"),
    status_filter: FollowUpStatus | None = Query(None, alias="status"),
    patient_id: UUID | None = None,
    user: User = Depends(require_permission("patients.read")),
    db: Session = Depends(get_db),
) -> list[FollowUpRead]:
    query = select(PatientFollowUp).where(PatientFollowUp.clinic_id == user.clinic_id)
    now = datetime.now(UTC)

    if filter_mode == "today":
        today_start = datetime.combine(now.date(), time.min).replace(tzinfo=UTC)
        today_end = datetime.combine(now.date(), time.max).replace(tzinfo=UTC)
        query = query.where(
            PatientFollowUp.scheduled_at >= today_start,
            PatientFollowUp.scheduled_at <= today_end,
        )
    elif filter_mode == "overdue":
        query = query.where(
            PatientFollowUp.scheduled_at < now,
            PatientFollowUp.status.in_(["scheduled", "due", "rescheduled"]),
        )

    if status_filter:
        query = query.where(PatientFollowUp.status == status_filter)
    if patient_id:
        query = query.where(PatientFollowUp.patient_id == patient_id)

    query = query.order_by(PatientFollowUp.scheduled_at.asc())
    followups = db.scalars(query).all()
    return [FollowUpRead.model_validate(f) for f in followups]


@router.get("/followups/{followup_id}", response_model=FollowUpRead)
def get_followup(
    followup_id: UUID,
    user: User = Depends(require_permission("patients.read")),
    db: Session = Depends(get_db),
) -> FollowUpRead:
    followup = db.scalar(
        select(PatientFollowUp).where(
            PatientFollowUp.id == followup_id,
            PatientFollowUp.clinic_id == user.clinic_id,
        )
    )
    if followup is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Follow-up not found"
        )
    return FollowUpRead.model_validate(followup)


@router.patch("/followups/{followup_id}", response_model=FollowUpRead)
def update_followup(
    followup_id: UUID,
    body: FollowUpUpdate,
    user: User = Depends(require_permission("followups.manage")),
    db: Session = Depends(get_db),
) -> FollowUpRead:
    try:
        followup = ContinuityService(db, user).update_followup(followup_id, body)
        return FollowUpRead.model_validate(followup)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))


@router.post("/followups/{followup_id}/reschedule", response_model=FollowUpRead)
def reschedule_followup(
    followup_id: UUID,
    body: FollowUpReschedule,
    user: User = Depends(require_permission("followups.manage")),
    db: Session = Depends(get_db),
) -> FollowUpRead:
    try:
        followup = ContinuityService(db, user).reschedule_followup(followup_id, body)
        return FollowUpRead.model_validate(followup)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))


# =============================================================================
# 4. CLINIC PAIRING & SECURE TRANSFERS
# =============================================================================


@router.get("/clinics", response_model=list[dict[str, Any]])
def list_clinics(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[dict[str, Any]]:
    clinics = db.scalars(select(Clinic).order_by(Clinic.name)).all()
    pairings = db.scalars(
        select(ClinicPairing).where(
            ClinicPairing.source_clinic_id == user.clinic_id,
            ClinicPairing.status == "active",
        )
    ).all()
    paired_ids = {p.target_clinic_id for p in pairings}

    return [
        {
            "id": str(c.id),
            "name": c.name,
            "is_current": c.id == user.clinic_id,
            "is_paired": c.id in paired_ids,
        }
        for c in clinics
    ]


@router.post("/clinics/pair", response_model=ClinicPairingRead)
def pair_clinic(
    body: ClinicPairingCreate,
    user: User = Depends(require_permission("transfers.export")),
    db: Session = Depends(get_db),
) -> ClinicPairingRead:
    try:
        pairing = ContinuityService(db, user).pair_clinic(
            body.target_clinic_id, body.pairing_code
        )
        return ClinicPairingRead.model_validate(pairing)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))


@router.get("/clinics/pairings", response_model=list[ClinicPairingRead])
def list_pairings(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[ClinicPairingRead]:
    pairings = db.scalars(
        select(ClinicPairing).where(ClinicPairing.source_clinic_id == user.clinic_id)
    ).all()
    return [ClinicPairingRead.model_validate(p) for p in pairings]


@router.post(
    "/transfers/export",
    response_model=TransferPackageRead,
    status_code=status.HTTP_201_CREATED,
)
def export_transfer_package(
    body: TransferPackageCreate,
    user: User = Depends(require_permission("transfers.export")),
    db: Session = Depends(get_db),
) -> TransferPackageRead:
    try:
        pkg = ContinuityService(db, user).export_transfer_package(body)
        return TransferPackageRead.model_validate(pkg)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))


@router.get("/transfers/inbound", response_model=list[TransferPackageRead])
def list_inbound_transfers(
    user: User = Depends(require_permission("transfers.import")),
    db: Session = Depends(get_db),
) -> list[TransferPackageRead]:
    packages = db.scalars(
        select(ClinicTransferPackage)
        .where(ClinicTransferPackage.target_clinic_id == user.clinic_id)
        .order_by(ClinicTransferPackage.created_at.desc())
    ).all()
    return [TransferPackageRead.model_validate(p) for p in packages]


@router.get("/transfers/outbound", response_model=list[TransferPackageRead])
def list_outbound_transfers(
    user: User = Depends(require_permission("transfers.export")),
    db: Session = Depends(get_db),
) -> list[TransferPackageRead]:
    packages = db.scalars(
        select(ClinicTransferPackage)
        .where(ClinicTransferPackage.source_clinic_id == user.clinic_id)
        .order_by(ClinicTransferPackage.created_at.desc())
    ).all()
    return [TransferPackageRead.model_validate(p) for p in packages]


@router.post("/transfers/import", response_model=TransferImportResponse)
def import_transfer_package(
    body: TransferImportRequest,
    user: User = Depends(require_permission("transfers.import")),
    db: Session = Depends(get_db),
) -> TransferImportResponse:
    try:
        return ContinuityService(db, user).import_transfer_package(
            transfer_id=body.transfer_id,
            force_new_patient=body.force_new_patient,
            merge_patient_id=body.merge_patient_id,
        )
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))


# =============================================================================
# 5. FHIR R4 SERIALIZATION & VALIDATION
# =============================================================================


@router.get("/fhir/patients/{patient_id}")
def export_patient_fhir(
    patient_id: UUID,
    user: User = Depends(require_permission("patients.read")),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    try:
        return ContinuityService(db, user).serialize_patient_to_fhir(patient_id)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(e))


@router.get("/fhir/referrals/{referral_id}")
def export_referral_fhir(
    referral_id: UUID,
    user: User = Depends(require_permission("referrals.read")),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    try:
        return ContinuityService(db, user).serialize_referral_to_fhir(referral_id)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(e))


@router.post("/fhir/validate", response_model=FHIRValidationResult)
def validate_fhir_resource(
    body: dict[str, Any],
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> FHIRValidationResult:
    return ContinuityService(db, user).validate_fhir_bundle(body)
