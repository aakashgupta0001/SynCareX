from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

ReferralPriority = Literal["routine", "urgent", "emergency"]
ReferralStatus = Literal[
    "draft",
    "awaiting_review",
    "approved",
    "ready_to_send",
    "pending_synchronization",
    "sent",
    "received",
    "accepted",
    "in_progress",
    "completed",
    "cancelled",
]
FollowUpPriority = Literal["routine", "high", "urgent"]
FollowUpStatus = Literal[
    "scheduled",
    "due",
    "completed",
    "rescheduled",
    "cancelled",
    "unable_to_contact",
]
VerificationBadge = Literal[
    "verified",
    "imported",
    "ai_draft",
    "outdated",
    "expired",
    "unverified",
]


# ------------------------------------------------ Emergency Passport Schemas


class EmergencyPassportCreate(BaseModel):
    patient_id: UUID
    included_fields: list[str] = Field(
        default=["emergency_contact", "allergies", "medications", "recent_history"],
        description="Data minimization field selections",
    )
    consent_given: bool = True
    consent_details: str | None = Field(default="Patient verbal emergency disclosure consent", max_length=255)
    validity_hours: int = Field(default=72, ge=1, le=720)


class EmergencyPassportRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    clinic_id: UUID
    patient_id: UUID
    issued_by: UUID
    verification_token: str
    token_hash: str
    encrypted_package: dict[str, Any]
    summary_manifest: list[str]
    consent_given: bool
    consent_details: str | None
    is_revoked: bool
    revoked_at: datetime | None
    revocation_reason: str | None
    expires_at: datetime
    created_at: datetime
    version: int


class EmergencyPassportVerifyRequest(BaseModel):
    token: str = Field(min_length=16, max_length=256)


class EmergencyPassportVerifyResponse(BaseModel):
    status: Literal["valid", "expired", "revoked", "invalid"]
    verification_badge: VerificationBadge
    is_valid: bool
    expires_at: datetime | None = None
    issued_at: datetime | None = None
    issuing_clinic_id: UUID | None = None
    issuing_clinic_name: str | None = None
    patient_reference: str | None = None
    summary_manifest: list[str] = Field(default_factory=list)
    payload: dict[str, Any] | None = None
    revoked_at: datetime | None = None
    revocation_reason: str | None = None
    message: str


class EmergencyPassportRevokeRequest(BaseModel):
    reason: str = Field(min_length=3, max_length=255)


# ------------------------------------------------ Referral Schemas


class ReferralCreate(BaseModel):
    receiving_clinic_id: UUID
    patient_id: UUID
    reason: str = Field(min_length=3, max_length=2000)
    clinical_summary: str | None = None
    priority: ReferralPriority = "routine"
    status: ReferralStatus = "draft"
    consent_policy: str | None = Field(default="Patient referral disclosure consent", max_length=255)
    included_data: dict[str, Any] = Field(default_factory=dict)
    source_references: dict[str, Any] | None = None


class ReferralUpdate(BaseModel):
    reason: str | None = None
    clinical_summary: str | None = None
    priority: ReferralPriority | None = None
    included_data: dict[str, Any] | None = None
    expected_version: int | None = None


class ReferralStatusUpdate(BaseModel):
    status: ReferralStatus
    note: str | None = None
    expected_version: int | None = None


class ReferralRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    referring_clinic_id: UUID
    receiving_clinic_id: UUID
    patient_id: UUID
    referring_clinician_id: UUID
    reviewing_clinician_id: UUID | None
    reason: str
    clinical_summary: str | None
    priority: ReferralPriority
    status: ReferralStatus
    consent_policy: str | None
    included_data: dict[str, Any]
    source_references: dict[str, Any] | None
    sent_at: datetime | None
    received_at: datetime | None
    accepted_at: datetime | None
    created_at: datetime
    updated_at: datetime
    version: int


# ------------------------------------------------ Follow-up Schemas


class FollowUpCreate(BaseModel):
    patient_id: UUID
    consultation_id: UUID | None = None
    scheduled_at: datetime
    reason: str = Field(min_length=3, max_length=255)
    priority: FollowUpPriority = "routine"
    status: FollowUpStatus = "scheduled"
    responsible_user_id: UUID | None = None
    contact_preference: str | None = Field(default="phone", max_length=50)
    notes: str | None = None


class FollowUpUpdate(BaseModel):
    reason: str | None = None
    priority: FollowUpPriority | None = None
    status: FollowUpStatus | None = None
    notes: str | None = None
    outcome: str | None = None
    responsible_user_id: UUID | None = None
    expected_version: int | None = None


class FollowUpReschedule(BaseModel):
    new_scheduled_at: datetime
    reason: str = Field(min_length=3, max_length=255)
    expected_version: int | None = None


class FollowUpRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    clinic_id: UUID
    patient_id: UUID
    consultation_id: UUID | None
    scheduled_at: datetime
    reason: str
    priority: FollowUpPriority
    status: FollowUpStatus
    responsible_user_id: UUID | None
    contact_preference: str | None
    notes: str | None
    outcome: str | None
    completed_at: datetime | None
    completed_by: UUID | None
    reschedule_history: list[dict[str, Any]]
    created_at: datetime
    updated_at: datetime
    version: int


# ------------------------------------------------ Clinic Pairing & Transfers


class ClinicPairingCreate(BaseModel):
    target_clinic_id: UUID
    pairing_code: str = Field(min_length=6, max_length=64)


class ClinicPairingRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    source_clinic_id: UUID
    target_clinic_id: UUID
    status: str
    paired_by: UUID
    paired_at: datetime
    created_at: datetime


class TransferPackageCreate(BaseModel):
    target_clinic_id: UUID
    patient_id: UUID
    consent_purpose: str = Field(min_length=3, max_length=255)
    included_records: list[str] = Field(
        default=["patient", "allergies", "medications", "consultations", "notes"],
        description="Records to pack into transfer",
    )


class TransferPackageRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    source_clinic_id: UUID
    target_clinic_id: UUID
    patient_id: UUID
    sender_user_id: UUID
    transfer_id: str
    package_schema_version: str
    status: str
    checksum: str
    byte_size: int
    manifest: dict[str, Any]
    consent_purpose: str
    source_provenance: dict[str, Any]
    imported_at: datetime | None
    imported_by: UUID | None
    imported_patient_id: UUID | None
    collision_details: dict[str, Any] | None
    created_at: datetime
    updated_at: datetime


class TransferImportRequest(BaseModel):
    transfer_id: str
    force_new_patient: bool = False
    merge_patient_id: UUID | None = None


class TransferImportResponse(BaseModel):
    transfer_id: str
    status: Literal["imported", "collision_detected"]
    imported_patient_id: UUID | None = None
    imported_records_count: int = 0
    collision_message: str | None = None
    collision_candidate: dict[str, Any] | None = None


# ------------------------------------------------ FHIR Validation Schemas


class FHIRValidationResult(BaseModel):
    resource_type: str
    is_valid: bool
    conforms_to_fhir_r4: bool
    resource_id: str
    issues: list[str] = Field(default_factory=list)

