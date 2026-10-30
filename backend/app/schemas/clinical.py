from datetime import date, datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class PatientIdentifierCreate(BaseModel):
    id: UUID | None = None
    patient_id: UUID
    system: str = Field(min_length=1, max_length=120)
    value: str = Field(min_length=1, max_length=160)


class PatientIdentifierRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    patient_id: UUID
    system: str
    value: str
    created_at: datetime


class ConsultationCreate(BaseModel):
    id: UUID | None = None
    patient_id: UUID
    reason: str | None = Field(default=None, max_length=240)
    notes: str | None = Field(default=None, max_length=20000)
    occurred_at: datetime | None = None
    status: Literal["draft", "completed"] = "draft"


class ConsultationUpdate(BaseModel):
    expected_version: int | None = Field(default=None, ge=1)
    reason: str | None = Field(default=None, max_length=240)
    notes: str | None = Field(default=None, max_length=20000)
    occurred_at: datetime | None = None
    status: Literal["draft", "completed"] | None = None


class ConsultationRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    patient_id: UUID
    clinician_id: UUID
    status: str
    reason: str | None
    notes: str | None
    version: int
    occurred_at: datetime
    created_at: datetime
    updated_at: datetime


class ClinicalNoteCreate(BaseModel):
    id: UUID | None = None
    patient_id: UUID
    consultation_id: UUID
    body: str = Field(min_length=1, max_length=20000)
    note_type: Literal["subjective", "objective", "assessment", "plan", "general"] = (
        "general"
    )


class ClinicalNoteUpdate(BaseModel):
    expected_version: int | None = Field(default=None, ge=1)
    body: str = Field(min_length=1, max_length=20000)


class ClinicalNoteRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    patient_id: UUID
    consultation_id: UUID
    author_id: UUID
    note_type: str
    body: str
    version: int
    created_at: datetime
    updated_at: datetime


class ObservationCreate(BaseModel):
    id: UUID | None = None
    patient_id: UUID
    consultation_id: UUID | None = None
    code: str = Field(min_length=1, max_length=64)
    label: str = Field(min_length=1, max_length=160)
    value: str = Field(min_length=1, max_length=160)
    unit: str | None = Field(default=None, max_length=32)
    recorded_at: datetime | None = None


class ObservationRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    patient_id: UUID
    consultation_id: UUID | None
    code: str
    label: str
    value: str
    unit: str | None
    recorded_at: datetime
    version: int


class AllergyCreate(BaseModel):
    id: UUID | None = None
    patient_id: UUID
    substance: str = Field(min_length=1, max_length=160)
    reaction: str | None = Field(default=None, max_length=240)
    severity: Literal["unknown", "mild", "moderate", "severe"] = "unknown"


class AllergyRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    patient_id: UUID
    substance: str
    reaction: str | None
    severity: str
    recorded_at: datetime
    version: int


class MedicationCreate(BaseModel):
    """
    Records a medication a clinician documented. The API never generates or
    recommends a prescription.
    """

    id: UUID | None = None
    patient_id: UUID
    consultation_id: UUID | None = None
    name: str = Field(min_length=1, max_length=160)
    dose: str | None = Field(default=None, max_length=120)
    frequency: str | None = Field(default=None, max_length=120)
    started_at: date | None = None


class MedicationRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    patient_id: UUID
    consultation_id: UUID | None
    name: str
    dose: str | None
    frequency: str | None
    started_at: date | None
    stopped_at: date | None
    version: int


class DocumentRegister(BaseModel):
    id: UUID | None = None
    patient_id: UUID
    consultation_id: UUID | None = None
    file_name: str = Field(min_length=1, max_length=255)
    mime_type: str = Field(min_length=1, max_length=100)
    byte_size: int = Field(gt=0)
    checksum: str = Field(min_length=64, max_length=64, pattern=r"^[0-9a-f]{64}$")
    description: str | None = Field(default=None, max_length=500)


class DocumentRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    patient_id: UUID
    consultation_id: UUID | None
    file_name: str
    mime_type: str
    byte_size: int
    checksum: str
    description: str | None
    content_received_at: datetime | None
    created_at: datetime


class ConsultationPage(BaseModel):
    items: list[ConsultationRead]
    total: int


class ClinicalNotePage(BaseModel):
    items: list[ClinicalNoteRead]
    total: int


class DocumentPage(BaseModel):
    items: list[DocumentRead]
    total: int
