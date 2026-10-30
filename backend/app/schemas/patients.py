from datetime import date, datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class PatientBase(BaseModel):
    full_name: str = Field(min_length=1, max_length=160)
    date_of_birth: date | None = None
    estimated_age: int | None = Field(default=None, ge=0, le=130)
    gender: str | None = Field(default=None, max_length=40)
    contact_phone: str | None = Field(default=None, max_length=32)
    address: str | None = Field(default=None, max_length=2000)
    village: str | None = Field(default=None, max_length=120)
    emergency_contact_name: str | None = Field(default=None, max_length=160)
    emergency_contact_phone: str | None = Field(default=None, max_length=32)
    relevant_history: str | None = Field(default=None, max_length=10000)
    allergies: list[str] = Field(default_factory=list, max_length=50)

    @field_validator("date_of_birth")
    @classmethod
    def reject_future_birth_date(cls, value: date | None) -> date | None:
        if value is not None and value > date.today():
            raise ValueError("Date of birth cannot be in the future")
        return value

    @model_validator(mode="after")
    def require_age_or_birth_date(self) -> "PatientBase":
        if self.date_of_birth is None and self.estimated_age is None:
            raise ValueError("Provide a date of birth or an estimated age")
        if self.date_of_birth is not None and self.estimated_age is not None:
            raise ValueError("Provide either a date of birth or an estimated age, not both")
        return self


class PatientCreate(PatientBase):
    id: UUID | None = None


class PatientUpdate(BaseModel):
    expected_version: int | None = Field(default=None, ge=1)
    full_name: str | None = Field(default=None, min_length=1, max_length=160)
    date_of_birth: date | None = None
    estimated_age: int | None = Field(default=None, ge=0, le=130)
    gender: str | None = Field(default=None, max_length=40)
    contact_phone: str | None = Field(default=None, max_length=32)
    address: str | None = Field(default=None, max_length=2000)
    village: str | None = Field(default=None, max_length=120)
    emergency_contact_name: str | None = Field(default=None, max_length=160)
    emergency_contact_phone: str | None = Field(default=None, max_length=32)
    relevant_history: str | None = Field(default=None, max_length=10000)
    allergies: list[str] | None = Field(default=None, max_length=50)

    @model_validator(mode="after")
    def validate_age_fields(self) -> "PatientUpdate":
        if (
            "date_of_birth" in self.model_fields_set
            and self.date_of_birth is not None
            and self.estimated_age is not None
        ):
            raise ValueError("Provide either a date of birth or an estimated age, not both")
        return self


class PatientRead(PatientBase):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    clinic_id: UUID
    patient_number: str
    version: int
    archived_at: datetime | None
    created_at: datetime
    updated_at: datetime


class PatientPage(BaseModel):
    items: list[PatientRead]
    page: int
    page_size: int
    total: int
    pages: int
