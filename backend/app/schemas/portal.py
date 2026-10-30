from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, EmailStr, Field


class PortalAccountCreate(BaseModel):
    """Staff request to open the portal for one patient."""

    email: EmailStr


class PortalAccountRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    patient_id: UUID
    email: EmailStr
    enrolled: bool
    is_active: bool
    created_at: datetime


class PortalAccountCreated(BaseModel):
    """The one-time enrollment code, shown to staff exactly once."""

    patient_id: UUID
    email: EmailStr
    enrollment_code: str
    enrollment_code_expires_at: datetime


class PortalEnrollRequest(BaseModel):
    email: EmailStr
    enrollment_code: str = Field(min_length=4, max_length=12)
    new_password: str = Field(min_length=8, max_length=128)


class PortalPasswordChange(BaseModel):
    current_password: str = Field(min_length=1, max_length=128)
    new_password: str = Field(min_length=8, max_length=128)


class PortalLoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=128)


class PortalPatientIdentity(BaseModel):
    id: UUID
    full_name: str
    patient_number: str
    clinic_name: str


class PortalLoginResponse(BaseModel):
    access_token: str
    token_type: Literal["bearer"] = "bearer"
    patient: PortalPatientIdentity


class PortalObservationRead(BaseModel):
    label: str
    value: str
    unit: str
    recorded_at: datetime


class PortalMedicationRead(BaseModel):
    name: str
    dose: str
    frequency: str


class PortalAllergyRead(BaseModel):
    substance: str
    reaction: str
    severity: str


class PortalConsultationRead(BaseModel):
    occurred_at: datetime | None
    reason: str
    status: str


class PortalSummary(BaseModel):
    """Everything the portal shows: a read-only slice of one patient.

    Deliberately excludes documents, identifiers, staff notes bodies and
    audit data — the portal is a summary for the patient, not the case file.
    """

    patient: PortalPatientIdentity
    date_of_birth: str | None
    estimated_age: int | None
    gender: str | None
    allergies: list[PortalAllergyRead]
    medications: list[PortalMedicationRead]
    observations: list[PortalObservationRead]
    consultations: list[PortalConsultationRead]
