"""Patient portal: the patient's own read-only login.

Two routers live here. ``portal_router`` (``/portal``) is what the patient's
device calls with no staff session; ``account_router`` (``/patients``) is the
staff side that opens an account and hands over the one-time enrollment code.

Security shape:
- Portal tokens (type "portal") carry the patient id and are accepted only
  by the dependencies here; staff tokens are rejected, and portal tokens are
  rejected on staff routes because they carry no session id.
- Login is throttled per email with the same lockout machinery as staff
  login, keyed ``portal:<email>`` so it can never interact with a staff
  counter.
- The summary endpoint exposes a fixed, small slice of the record and
  filters out entered-in-error entries, matching what a clinician would
  want the patient to act on.
"""

import hashlib
import hmac
import secrets
from datetime import UTC, datetime, timedelta
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Header, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.deps import get_db, require_permission
from app.models import (
    AllergyRecord,
    Clinic,
    Consultation,
    MedicationRecord,
    Observation,
    Patient,
    PatientPortalAccount,
    User,
)
from app.schemas.portal import (
    PortalAccountCreate,
    PortalAccountCreated,
    PortalAccountRead,
    PortalEnrollRequest,
    PortalLoginRequest,
    PortalLoginResponse,
    PortalPasswordChange,
    PortalPatientIdentity,
    PortalSummary,
)
from app.security.login_throttle import ensure_not_locked, record_failure, record_success
from app.security.passwords import hash_password, verify_password
from app.security.portal_tokens import decode_portal_token, issue_portal_token
from app.services.audit_chain import append_audit_entry

portal_router = APIRouter(prefix="/portal", tags=["patient portal"])
account_router = APIRouter(prefix="/patients", tags=["patient portal"])

ENROLLMENT_CODE_TTL_DAYS = 7
PORTAL_LOCKOUT_PREFIX = "portal:"


def _hash_code(code: str) -> str:
    return hashlib.sha256(code.encode("utf-8")).hexdigest()


def _generate_code() -> str:
    return f"{secrets.randbelow(1_000_000):06d}"


def _account_by_email(db: Session, email: str) -> PatientPortalAccount | None:
    return db.scalar(
        select(PatientPortalAccount).where(
            func.lower(PatientPortalAccount.email) == email.lower()
        )
    )


def _require_portal_account(
    db: Session, patient_id: UUID
) -> tuple[PatientPortalAccount, Patient]:
    # patient_id is a foreign key, not the primary key: select by column.
    account = db.scalar(
        select(PatientPortalAccount).where(
            PatientPortalAccount.patient_id == patient_id
        )
    )
    patient = db.get(Patient, patient_id)
    if (
        account is None
        or patient is None
        or not account.is_active
        or account.enrolled_at is None
    ):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Portal access is not available for this account.",
        )
    return account, patient


def get_portal_patient(
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> Patient:
    """Dependency for portal routes: Bearer must be a portal token."""
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Portal sign-in required."
        )
    try:
        patient_id = decode_portal_token(authorization.removeprefix("Bearer ").strip())
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Portal session expired. Sign in again.",
        ) from None
    _, patient = _require_portal_account(db, patient_id)
    return patient


# ------------------------------------------------------------------ patient side


@portal_router.post("/enroll")
def enroll(body: PortalEnrollRequest, db: Session = Depends(get_db)) -> PortalPatientIdentity:
    email_key = f"{PORTAL_LOCKOUT_PREFIX}{body.email.lower()}"
    ensure_not_locked(db, email_key)
    account = _account_by_email(db, body.email)
    now = datetime.now(UTC)
    invalid = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Email, code and password combination is not valid.",
    )
    if (
        account is None
        or not account.is_active
        or account.enrolled_at is not None
        or account.enrollment_code_hash is None
        or account.enrollment_code_expires_at is None
        or (account.enrollment_code_expires_at.replace(tzinfo=UTC) if account.enrollment_code_expires_at.tzinfo is None else account.enrollment_code_expires_at) <= now
    ):
        record_failure(db, email_key)
        raise invalid
    if not hmac.compare_digest(
        account.enrollment_code_hash, _hash_code(body.enrollment_code.strip())
    ):
        record_failure(db, email_key)
        raise invalid

    account.password_hash = hash_password(body.new_password)
    account.enrolled_at = now
    account.enrollment_code_hash = None
    account.enrollment_code_expires_at = None
    patient = db.get(Patient, account.patient_id)
    if patient is None:  # pragma: no cover - patient is ON DELETE CASCADE
        record_failure(db, email_key)
        raise invalid
    clinic = db.get(Clinic, account.clinic_id)
    append_audit_entry(
        db,
        clinic_id=account.clinic_id,
        actor_id=None,
        action="portal.account.enrolled",
        entity_type="patient_portal",
        entity_id=account.patient_id,
        details={"patient_id": str(account.patient_id)},
    )
    db.commit()
    return PortalPatientIdentity(
        id=patient.id,
        full_name=patient.full_name,
        patient_number=patient.patient_number,
        clinic_name=clinic.name if clinic else "",
    )


@portal_router.post("/login", response_model=PortalLoginResponse)
def portal_login(body: PortalLoginRequest, db: Session = Depends(get_db)) -> PortalLoginResponse:
    email_key = f"{PORTAL_LOCKOUT_PREFIX}{body.email.lower()}"
    ensure_not_locked(db, email_key)
    account = _account_by_email(db, body.email)
    patient = db.get(Patient, account.patient_id) if account else None
    if (
        account is None
        or patient is None
        or not account.is_active
        or account.enrolled_at is None
        or account.password_hash is None
        or not verify_password(body.password, account.password_hash)
    ):
        record_failure(db, email_key)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Email or password is incorrect.",
        )
    record_success(db, email_key)
    clinic = db.get(Clinic, account.clinic_id)
    append_audit_entry(
        db,
        clinic_id=account.clinic_id,
        actor_id=None,
        action="portal.login",
        entity_type="patient_portal",
        entity_id=account.patient_id,
        details={"patient_id": str(account.patient_id)},
    )
    db.commit()
    return PortalLoginResponse(
        access_token=issue_portal_token(patient.id),
        patient=PortalPatientIdentity(
            id=patient.id,
            full_name=patient.full_name,
            patient_number=patient.patient_number,
            clinic_name=clinic.name if clinic else "",
        ),
    )


@portal_router.get("/me", response_model=PortalSummary)
def portal_summary(
    patient: Patient = Depends(get_portal_patient),
    db: Session = Depends(get_db),
) -> PortalSummary:
    """The patient's read-only slice. Entered-in-error rows are excluded."""
    allergies = db.scalars(
        select(AllergyRecord).where(
            AllergyRecord.patient_id == patient.id,
            AllergyRecord.entered_in_error_at.is_(None),
        )
    ).all()
    medications = db.scalars(
        select(MedicationRecord).where(
            MedicationRecord.patient_id == patient.id,
            MedicationRecord.stopped_at.is_(None),
            MedicationRecord.entered_in_error_at.is_(None),
        )
    ).all()
    observations = db.scalars(
        select(Observation)
        .where(
            Observation.patient_id == patient.id,
            Observation.entered_in_error_at.is_(None),
        )
        .order_by(Observation.recorded_at.desc())
        .limit(10)
    ).all()
    consultations = db.scalars(
        select(Consultation)
        .where(Consultation.patient_id == patient.id)
        .order_by(Consultation.occurred_at.desc())
        .limit(10)
    ).all()
    clinic = db.get(Clinic, patient.clinic_id)
    return PortalSummary(
        patient=PortalPatientIdentity(
            id=patient.id,
            full_name=patient.full_name,
            patient_number=patient.patient_number,
            clinic_name=clinic.name if clinic else "",
        ),
        date_of_birth=patient.date_of_birth.isoformat() if patient.date_of_birth else None,
        estimated_age=patient.estimated_age,
        gender=patient.gender,
        allergies=[
            PortalAllergyRead(
                substance=item.substance,
                reaction=item.reaction or "",
                severity=item.severity,
            )
            for item in allergies
        ],
        medications=[
            PortalMedicationRead(
                name=item.name, dose=item.dose or "", frequency=item.frequency or ""
            )
            for item in medications
        ],
        observations=[
            PortalObservationRead(
                label=item.label, value=item.value, unit=item.unit or "", recorded_at=item.recorded_at
            )
            for item in observations
        ],
        consultations=[
            PortalConsultationRead(
                occurred_at=item.occurred_at, reason=item.reason or "", status=item.status
            )
            for item in consultations
        ],
    )


@portal_router.post("/password", status_code=status.HTTP_204_NO_CONTENT)
def change_password(
    body: PortalPasswordChange,
    patient: Patient = Depends(get_portal_patient),
    db: Session = Depends(get_db),
) -> None:
    account = db.scalar(
        select(PatientPortalAccount).where(
            PatientPortalAccount.patient_id == patient.id
        )
    )
    if account is None or account.password_hash is None or not verify_password(
        body.current_password, account.password_hash
    ):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Current password is incorrect.",
        )
    account.password_hash = hash_password(body.new_password)
    append_audit_entry(
        db,
        clinic_id=account.clinic_id,
        actor_id=None,
        action="portal.password.changed",
        entity_type="patient_portal",
        entity_id=account.patient_id,
    )
    db.commit()


# --------------------------------------------------------------------- staff side


@account_router.post(
    "/{patient_id}/portal-account",
    response_model=PortalAccountCreated,
    status_code=status.HTTP_201_CREATED,
)
def create_portal_account(
    patient_id: UUID,
    body: PortalAccountCreate,
    user: User = Depends(require_permission("patients.write")),
    db: Session = Depends(get_db),
) -> PortalAccountCreated:
    patient = db.scalar(
        select(Patient).where(
            Patient.id == patient_id, Patient.clinic_id == user.clinic_id
        )
    )
    if patient is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Patient not found in your clinic.",
        )
    existing = _account_by_email(db, body.email)
    same_patient = db.scalar(
        select(PatientPortalAccount).where(PatientPortalAccount.patient_id == patient_id)
    )
    if same_patient is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This patient already has a portal account.",
        )
    if existing is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Another portal account already uses this email.",
        )

    code = _generate_code()
    account = PatientPortalAccount(
        clinic_id=user.clinic_id,
        patient_id=patient_id,
        email=body.email.lower(),
        enrollment_code_hash=_hash_code(code),
        enrollment_code_expires_at=datetime.now(UTC)
        + timedelta(days=ENROLLMENT_CODE_TTL_DAYS),
    )
    db.add(account)
    append_audit_entry(
        db,
        clinic_id=user.clinic_id,
        actor_id=user.id,
        action="portal.account.created",
        entity_type="patient_portal",
        entity_id=patient_id,
        details={"email": body.email.lower()},
    )
    db.commit()
    return PortalAccountCreated(
        patient_id=patient_id,
        email=body.email.lower(),
        enrollment_code=code,
        enrollment_code_expires_at=account.enrollment_code_expires_at,
    )


@account_router.get("/{patient_id}/portal-account", response_model=PortalAccountRead)
def get_portal_account(
    patient_id: UUID,
    user: User = Depends(require_permission("patients.read")),
    db: Session = Depends(get_db),
) -> PortalAccountRead:
    patient = db.scalar(
        select(Patient).where(
            Patient.id == patient_id, Patient.clinic_id == user.clinic_id
        )
    )
    if patient is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Patient not found in your clinic.",
        )
    account = db.scalar(
        select(PatientPortalAccount).where(PatientPortalAccount.patient_id == patient_id)
    )
    if account is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="This patient has no portal account yet.",
        )
    return PortalAccountRead(
        patient_id=patient_id,
        email=account.email,
        enrolled=account.enrolled_at is not None,
        is_active=account.is_active,
        created_at=account.created_at,
    )


@account_router.post(
    "/{patient_id}/portal-account/reissue-code",
    response_model=PortalAccountCreated,
    status_code=status.HTTP_201_CREATED,
)
def reissue_enrollment_code(
    patient_id: UUID,
    user: User = Depends(require_permission("patients.write")),
    db: Session = Depends(get_db),
) -> PortalAccountCreated:
    """A fresh one-time code when the patient lost the first one.

    Only an account that has not enrolled yet can reissue: once enrolled,
    the password belongs to the patient and resets must prove identity
    differently.
    """
    account = db.scalar(
        select(PatientPortalAccount).where(
            PatientPortalAccount.patient_id == patient_id,
            PatientPortalAccount.clinic_id == user.clinic_id,
        )
    )
    patient = db.get(Patient, patient_id)
    if patient is None or patient.clinic_id != user.clinic_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Patient not found in your clinic.",
        )
    if account is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="This patient has no portal account yet.",
        )
    if account.enrolled_at is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This account is already enrolled; the patient signs in with their password.",
        )

    code = _generate_code()
    account.enrollment_code_hash = _hash_code(code)
    account.enrollment_code_expires_at = datetime.now(UTC) + timedelta(
        days=ENROLLMENT_CODE_TTL_DAYS
    )
    # The old code dies the moment a new one is issued.
    append_audit_entry(
        db,
        clinic_id=user.clinic_id,
        actor_id=user.id,
        action="portal.account.code_reissued",
        entity_type="patient_portal",
        entity_id=patient_id,
    )
    db.commit()
    return PortalAccountCreated(
        patient_id=patient_id,
        email=account.email,
        enrollment_code=code,
        enrollment_code_expires_at=account.enrollment_code_expires_at,
    )
