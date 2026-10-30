from datetime import UTC, date, datetime
from uuid import UUID, uuid4

from sqlalchemy import (
    JSON,
    Boolean,
    Column,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Table,
    Text,
    UniqueConstraint,
    Uuid,
    select,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship
from sqlalchemy import event
from sqlalchemy.orm import Session as OrmSession


def utc_now() -> datetime:
    return datetime.now(UTC)


class Base(DeclarativeBase):
    pass


user_roles = Table(
    "user_roles",
    Base.metadata,
    Column(
        "user_id", Uuid(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    ),
    Column(
        "role_id", Uuid(as_uuid=True), ForeignKey("roles.id", ondelete="CASCADE"), primary_key=True
    ),
)

role_permissions = Table(
    "role_permissions",
    Base.metadata,
    Column(
        "role_id", Uuid(as_uuid=True), ForeignKey("roles.id", ondelete="CASCADE"), primary_key=True
    ),
    Column(
        "permission_id",
        Uuid(as_uuid=True),
        ForeignKey("permissions.id", ondelete="CASCADE"),
        primary_key=True,
    ),
)


class Clinic(Base):
    __tablename__ = "clinics"

    id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid4)
    name: Mapped[str] = mapped_column(String(160), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)

    users: Mapped[list["User"]] = relationship(back_populates="clinic")
    patients: Mapped[list["Patient"]] = relationship(back_populates="clinic")
    devices: Mapped[list["Device"]] = relationship(back_populates="clinic")


class Role(Base):
    __tablename__ = "roles"

    id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid4)
    name: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    permissions: Mapped[list["Permission"]] = relationship(
        secondary=role_permissions, back_populates="roles"
    )
    users: Mapped[list["User"]] = relationship(secondary=user_roles, back_populates="roles")


class Permission(Base):
    __tablename__ = "permissions"

    id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid4)
    key: Mapped[str] = mapped_column(String(100), unique=True, nullable=False)
    description: Mapped[str] = mapped_column(String(240), nullable=False)
    roles: Mapped[list[Role]] = relationship(
        secondary=role_permissions, back_populates="permissions"
    )


class User(Base):
    __tablename__ = "users"

    id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid4)
    clinic_id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("clinics.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    email: Mapped[str] = mapped_column(String(320), unique=True, nullable=False, index=True)
    full_name: Mapped[str] = mapped_column(String(160), nullable=False)
    password_hash: Mapped[str] = mapped_column(String(512), nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)

    clinic: Mapped[Clinic] = relationship(back_populates="users")
    roles: Mapped[list[Role]] = relationship(secondary=user_roles, back_populates="users")
    refresh_sessions: Mapped[list["RefreshSession"]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )


class Device(Base):
    __tablename__ = "devices"

    id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid4)
    clinic_id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("clinics.id", ondelete="CASCADE"), nullable=False, index=True
    )
    device_uid: Mapped[str] = mapped_column(String(64), unique=True, nullable=False, index=True)
    label: Mapped[str] = mapped_column(String(120), nullable=False)
    status: Mapped[str] = mapped_column(String(24), default="active", nullable=False)
    provisioned_by: Mapped[UUID | None] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    offline_grace_days: Mapped[int] = mapped_column(Integer, default=7, nullable=False)
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)

    clinic: Mapped[Clinic] = relationship(back_populates="devices")


class Patient(Base):
    __tablename__ = "patients"
    __table_args__ = (
        UniqueConstraint("clinic_id", "patient_number", name="uq_patient_clinic_number"),
        Index("ix_patient_clinic_name", "clinic_id", "full_name"),
    )

    id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid4)
    clinic_id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("clinics.id", ondelete="RESTRICT"), nullable=False
    )
    patient_number: Mapped[str] = mapped_column(String(24), nullable=False)
    full_name: Mapped[str] = mapped_column(String(160), nullable=False)
    date_of_birth: Mapped[date | None] = mapped_column(Date, nullable=True)
    estimated_age: Mapped[int | None] = mapped_column(Integer, nullable=True)
    gender: Mapped[str | None] = mapped_column(String(40), nullable=True)
    contact_phone: Mapped[str | None] = mapped_column(String(32), nullable=True)
    address: Mapped[str | None] = mapped_column(Text, nullable=True)
    village: Mapped[str | None] = mapped_column(String(120), nullable=True)
    emergency_contact_name: Mapped[str | None] = mapped_column(String(160), nullable=True)
    emergency_contact_phone: Mapped[str | None] = mapped_column(String(32), nullable=True)
    relevant_history: Mapped[str | None] = mapped_column(Text, nullable=True)
    allergies: Mapped[list[str]] = mapped_column(JSON, default=list, nullable=False)
    version: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # Dual-write (E2E step 2): the same content encrypted with the clinic
    # key. Nullable while plaintext remains authoritative; a device with
    # no clinic key simply writes nothing here.
    content_ciphertext: Mapped[str | None] = mapped_column(Text, nullable=True)
    content_iv: Mapped[str | None] = mapped_column(String(64), nullable=True)
    content_key_epoch: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_by: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now, onupdate=utc_now, nullable=False
    )

    clinic: Mapped[Clinic] = relationship(back_populates="patients")
    identifiers: Mapped[list["PatientIdentifier"]] = relationship(
        back_populates="patient", cascade="all, delete-orphan"
    )
    consultations: Mapped[list["Consultation"]] = relationship(
        back_populates="patient", cascade="all, delete-orphan"
    )


class PatientIdentifier(Base):
    __tablename__ = "patient_identifiers"
    __table_args__ = (
        UniqueConstraint("clinic_id", "system", "value", name="uq_patient_identifier_clinic_system"),
    )

    id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid4)
    patient_id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("patients.id", ondelete="CASCADE"), nullable=False, index=True
    )
    clinic_id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("clinics.id", ondelete="CASCADE"), nullable=False
    )
    system: Mapped[str] = mapped_column(String(120), nullable=False)
    value: Mapped[str] = mapped_column(String(160), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)

    patient: Mapped[Patient] = relationship(back_populates="identifiers")


class Consultation(Base):
    __tablename__ = "consultations"

    id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid4)
    clinic_id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("clinics.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    patient_id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("patients.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    clinician_id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    status: Mapped[str] = mapped_column(String(24), default="draft", nullable=False)
    reason: Mapped[str | None] = mapped_column(String(240), nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    version: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now, onupdate=utc_now, nullable=False
    )

    patient: Mapped[Patient] = relationship(back_populates="consultations")
    clinical_notes: Mapped[list["ClinicalNote"]] = relationship(
        back_populates="consultation", cascade="all, delete-orphan"
    )


class AuditLog(Base):
    __tablename__ = "audit_logs"
    __table_args__ = (Index("ix_audit_clinic_time", "clinic_id", "created_at"),)

    id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid4)
    clinic_id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("clinics.id", ondelete="RESTRICT"), nullable=False
    )
    actor_id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    action: Mapped[str] = mapped_column(String(100), nullable=False)
    entity_type: Mapped[str] = mapped_column(String(64), nullable=False)
    entity_id: Mapped[UUID | None] = mapped_column(Uuid(as_uuid=True), nullable=True)
    outcome: Mapped[str] = mapped_column(String(24), default="success", nullable=False)
    details: Mapped[dict[str, str] | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)


class RefreshSession(Base):
    __tablename__ = "refresh_sessions"

    id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid4)
    user_id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    replaced_by_id: Mapped[UUID | None] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("refresh_sessions.id"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)

    user: Mapped[User] = relationship(back_populates="refresh_sessions")
class ClinicalNote(Base):
    """Clinician-authored documentation attached to a consultation."""

    __tablename__ = "clinical_notes"
    __table_args__ = (Index("ix_clinical_note_patient", "clinic_id", "patient_id"),)

    id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid4)
    clinic_id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("clinics.id", ondelete="RESTRICT"), nullable=False
    )
    patient_id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("patients.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    consultation_id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("consultations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    author_id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    note_type: Mapped[str] = mapped_column(String(24), default="general", nullable=False)
    body: Mapped[str] = mapped_column(Text, nullable=False)
    version: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now, onupdate=utc_now, nullable=False
    )

    consultation: Mapped[Consultation] = relationship(back_populates="clinical_notes")


class Observation(Base):
    """A measurement a clinician recorded. Never machine-inferred."""

    __tablename__ = "observations"

    id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid4)
    clinic_id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("clinics.id", ondelete="RESTRICT"), nullable=False
    )
    patient_id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("patients.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    consultation_id: Mapped[UUID | None] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("consultations.id", ondelete="SET NULL"), nullable=True
    )
    code: Mapped[str] = mapped_column(String(64), nullable=False)
    label: Mapped[str] = mapped_column(String(160), nullable=False)
    value: Mapped[str] = mapped_column(String(160), nullable=False)
    unit: Mapped[str | None] = mapped_column(String(32), nullable=True)
    recorded_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)
    recorded_by: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    entered_in_error_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    entered_in_error_by: Mapped[UUID | None] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT"), nullable=True
    )
    entered_in_error_reason: Mapped[str | None] = mapped_column(String(500), nullable=True)
    version: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now, onupdate=utc_now, nullable=False
    )


class AllergyRecord(Base):
    __tablename__ = "allergy_records"

    id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid4)
    clinic_id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("clinics.id", ondelete="RESTRICT"), nullable=False
    )
    patient_id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("patients.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    substance: Mapped[str] = mapped_column(String(160), nullable=False)
    reaction: Mapped[str | None] = mapped_column(String(240), nullable=True)
    severity: Mapped[str] = mapped_column(String(16), default="unknown", nullable=False)
    recorded_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)
    recorded_by: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    entered_in_error_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    entered_in_error_by: Mapped[UUID | None] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT"), nullable=True
    )
    entered_in_error_reason: Mapped[str | None] = mapped_column(String(500), nullable=True)
    version: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now, onupdate=utc_now, nullable=False
    )


class MedicationRecord(Base):
    """
    Documentation of a medication a clinician recorded. SynCareX does not
    generate, suggest or alter prescriptions.
    """

    __tablename__ = "medication_records"

    id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid4)
    clinic_id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("clinics.id", ondelete="RESTRICT"), nullable=False
    )
    patient_id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("patients.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    consultation_id: Mapped[UUID | None] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("consultations.id", ondelete="SET NULL"), nullable=True
    )
    name: Mapped[str] = mapped_column(String(160), nullable=False)
    dose: Mapped[str | None] = mapped_column(String(120), nullable=True)
    frequency: Mapped[str | None] = mapped_column(String(120), nullable=True)
    started_at: Mapped[date | None] = mapped_column(Date, nullable=True)
    stopped_at: Mapped[date | None] = mapped_column(Date, nullable=True)
    recorded_by: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    entered_in_error_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    entered_in_error_by: Mapped[UUID | None] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT"), nullable=True
    )
    entered_in_error_reason: Mapped[str | None] = mapped_column(String(500), nullable=True)
    version: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now, onupdate=utc_now, nullable=False
    )


class DocumentRecord(Base):
    """
    Metadata for a clinical document. Metadata is registered through the sync
    queue first; the file bytes are uploaded separately, and the device keeps
    its local original until this row reports stored content.
    """

    __tablename__ = "documents"

    id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid4)
    clinic_id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("clinics.id", ondelete="RESTRICT"), nullable=False
    )
    patient_id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("patients.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    consultation_id: Mapped[UUID | None] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("consultations.id", ondelete="SET NULL"), nullable=True
    )
    file_name: Mapped[str] = mapped_column(String(255), nullable=False)
    mime_type: Mapped[str] = mapped_column(String(100), nullable=False)
    byte_size: Mapped[int] = mapped_column(Integer, nullable=False)
    checksum: Mapped[str] = mapped_column(String(64), nullable=False)
    description: Mapped[str | None] = mapped_column(String(500), nullable=True)
    storage_path: Mapped[str | None] = mapped_column(String(512), nullable=True)
    content_received_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    uploaded_by: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    version: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now, onupdate=utc_now, nullable=False
    )


class SyncOperationRecord(Base):
    """
    Server-side record of every accepted synchronization operation, keyed by
    the device's idempotency key. A replayed operation returns the stored
    outcome instead of creating a second clinical record.
    """

    __tablename__ = "sync_operations"
    __table_args__ = (
        Index("ix_sync_operation_clinic_entity", "clinic_id", "entity_type", "entity_id"),
        Index("uq_sync_operation_id", "operation_id", unique=True),
    )

    idempotency_key: Mapped[str] = mapped_column(String(64), primary_key=True)
    clinic_id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("clinics.id", ondelete="RESTRICT"), nullable=False
    )
    actor_id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    operation_id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), nullable=False)
    device_uid: Mapped[str] = mapped_column(String(64), nullable=False)
    request_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    schema_version: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    entity_type: Mapped[str] = mapped_column(String(40), nullable=False)
    entity_id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), nullable=False)
    operation_type: Mapped[str] = mapped_column(String(24), nullable=False)
    status: Mapped[str] = mapped_column(String(24), nullable=False)
    retryable: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    entity_version: Mapped[int | None] = mapped_column(Integer, nullable=True)
    response: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)


class EmergencyPassport(Base):
    """
    Verified portable emergency clinical package. High-entropy token or compact
    authenticated payload with strict cryptographic integrity and revocation audit.
    """

    __tablename__ = "emergency_passports"
    __table_args__ = (
        Index("ix_passport_patient", "clinic_id", "patient_id"),
        Index("ix_passport_token_hash", "token_hash", unique=True),
    )

    id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid4)
    clinic_id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("clinics.id", ondelete="RESTRICT"), nullable=False
    )
    patient_id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("patients.id", ondelete="RESTRICT"), nullable=False
    )
    issued_by: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    token_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    verification_token: Mapped[str] = mapped_column(String(128), nullable=False)
    encrypted_package: Mapped[dict] = mapped_column(JSON, nullable=False)
    summary_manifest: Mapped[list[str]] = mapped_column(JSON, default=list, nullable=False)
    consent_given: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    consent_details: Mapped[str | None] = mapped_column(String(255), nullable=True)
    is_revoked: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    revoked_by: Mapped[UUID | None] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    revocation_reason: Mapped[str | None] = mapped_column(String(255), nullable=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)
    version: Mapped[int] = mapped_column(Integer, default=1, nullable=False)


class Referral(Base):
    """
    Smart referral entity tracking transitions from draft to approval, sending,
    reception, acceptance, and completion.
    """

    __tablename__ = "referrals"
    __table_args__ = (
        Index("ix_referral_referring_clinic", "referring_clinic_id", "status"),
        Index("ix_referral_receiving_clinic", "receiving_clinic_id", "status"),
        Index("ix_referral_patient", "patient_id"),
    )

    id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid4)
    referring_clinic_id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("clinics.id", ondelete="RESTRICT"), nullable=False
    )
    receiving_clinic_id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("clinics.id", ondelete="RESTRICT"), nullable=False
    )
    patient_id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("patients.id", ondelete="RESTRICT"), nullable=False
    )
    referring_clinician_id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    reviewing_clinician_id: Mapped[UUID | None] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    reason: Mapped[str] = mapped_column(Text, nullable=False)
    clinical_summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    priority: Mapped[str] = mapped_column(String(20), default="routine", nullable=False)
    status: Mapped[str] = mapped_column(String(32), default="draft", nullable=False)
    consent_policy: Mapped[str | None] = mapped_column(String(255), nullable=True)
    included_data: Mapped[dict] = mapped_column(JSON, default=dict, nullable=False)
    source_references: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    received_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    accepted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now, onupdate=utc_now, nullable=False
    )
    version: Mapped[int] = mapped_column(Integer, default=1, nullable=False)


class PatientFollowUp(Base):
    """
    Offline-capable patient follow-up tracking with rescheduling history and outcomes.
    """

    __tablename__ = "patient_followups"
    __table_args__ = (
        Index("ix_followup_clinic_date", "clinic_id", "scheduled_at"),
        Index("ix_followup_clinic_status", "clinic_id", "status"),
        Index("ix_followup_patient", "patient_id"),
    )

    id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid4)
    clinic_id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("clinics.id", ondelete="RESTRICT"), nullable=False
    )
    patient_id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("patients.id", ondelete="RESTRICT"), nullable=False
    )
    consultation_id: Mapped[UUID | None] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("consultations.id", ondelete="SET NULL"), nullable=True
    )
    scheduled_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    reason: Mapped[str] = mapped_column(String(255), nullable=False)
    priority: Mapped[str] = mapped_column(String(20), default="routine", nullable=False)
    status: Mapped[str] = mapped_column(String(32), default="scheduled", nullable=False)
    responsible_user_id: Mapped[UUID | None] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    contact_preference: Mapped[str | None] = mapped_column(String(50), nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    outcome: Mapped[str | None] = mapped_column(Text, nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_by: Mapped[UUID | None] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    reschedule_history: Mapped[list[dict]] = mapped_column(JSON, default=list, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now, onupdate=utc_now, nullable=False
    )
    version: Mapped[int] = mapped_column(Integer, default=1, nullable=False)


class ClinicPairing(Base):
    """Authorized pairing link between two clinics for direct, encrypted exchange."""

    __tablename__ = "clinic_pairings"
    __table_args__ = (
        UniqueConstraint("source_clinic_id", "target_clinic_id", name="uq_clinic_pairing"),
    )

    id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid4)
    source_clinic_id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("clinics.id", ondelete="CASCADE"), nullable=False
    )
    target_clinic_id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("clinics.id", ondelete="CASCADE"), nullable=False
    )
    status: Mapped[str] = mapped_column(String(24), default="active", nullable=False)
    pairing_code: Mapped[str | None] = mapped_column(String(64), nullable=True)
    shared_secret_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    paired_by: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    paired_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)


class ClinicTransferPackage(Base):
    """
    Secure clinic-to-clinic transfer package with checksum verification,
    manifest, encrypted payload, and identity collision detection.
    """

    __tablename__ = "clinic_transfer_packages"
    __table_args__ = (
        Index("ix_transfer_source", "source_clinic_id", "status"),
        Index("ix_transfer_target", "target_clinic_id", "status"),
        Index("ix_transfer_uid", "transfer_id", unique=True),
    )

    id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid4)
    source_clinic_id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("clinics.id", ondelete="RESTRICT"), nullable=False
    )
    target_clinic_id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("clinics.id", ondelete="RESTRICT"), nullable=False
    )
    patient_id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), nullable=False)
    sender_user_id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    transfer_id: Mapped[str] = mapped_column(String(64), nullable=False)
    package_schema_version: Mapped[str] = mapped_column(String(32), default="syncarex-continuity-v1", nullable=False)
    status: Mapped[str] = mapped_column(String(32), default="prepared", nullable=False)
    checksum: Mapped[str] = mapped_column(String(64), nullable=False)
    byte_size: Mapped[int] = mapped_column(Integer, nullable=False)
    manifest: Mapped[dict] = mapped_column(JSON, nullable=False)
    encrypted_payload: Mapped[str] = mapped_column(Text, nullable=False)
    consent_purpose: Mapped[str] = mapped_column(String(255), nullable=False)
    source_provenance: Mapped[dict] = mapped_column(JSON, nullable=False)
    imported_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    imported_by: Mapped[UUID | None] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    imported_patient_id: Mapped[UUID | None] = mapped_column(Uuid(as_uuid=True), nullable=True)
    collision_details: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now, onupdate=utc_now, nullable=False
    )


class SyncChangeRecord(Base):
    """Append-only clinic change feed addressed by a monotonic integer cursor."""

    __tablename__ = "sync_changes"
    __table_args__ = (
        Index("ix_sync_change_clinic_cursor", "clinic_id", "id"),
        Index("ix_sync_change_clinic_entity", "clinic_id", "entity_type", "entity_id"),
        UniqueConstraint("operation_id", name="uq_sync_change_operation"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    clinic_id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("clinics.id", ondelete="RESTRICT"), nullable=False
    )
    actor_id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    device_uid: Mapped[str] = mapped_column(String(64), nullable=False)
    operation_id: Mapped[UUID | None] = mapped_column(Uuid(as_uuid=True), nullable=True)
    entity_type: Mapped[str] = mapped_column(String(40), nullable=False)
    entity_id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), nullable=False)
    operation_type: Mapped[str] = mapped_column(String(24), nullable=False)
    entity_version: Mapped[int] = mapped_column(Integer, nullable=False)
    payload: Mapped[dict] = mapped_column(JSON, nullable=False)
    tombstone: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)


@event.listens_for(OrmSession, "before_flush")
def capture_clinical_mutations(session: OrmSession, _flush_context, _instances) -> None:
    if session.info.get("sync_change_operation_id"):
        return
    changes = session.info.setdefault("clinical_changes_to_capture", [])
    for entity in session.new.union(session.dirty):
        if isinstance(
            entity,
            (
                Patient,
                PatientIdentifier,
                Consultation,
                ClinicalNote,
                Observation,
                AllergyRecord,
                MedicationRecord,
                DocumentRecord,
            ),
        ) and (entity in session.new or session.is_modified(entity, include_collections=False)):
            changes.append(entity)
    if changes:
        clinic_ids = sorted({entity.clinic_id for entity in changes}, key=str)
        session.connection().execute(
            select(Clinic.id)
            .where(Clinic.id.in_(clinic_ids))
            .order_by(Clinic.id)
            .with_for_update()
        )


@event.listens_for(OrmSession, "after_flush_postexec")
def append_clinical_change_feed(session: OrmSession, _flush_context) -> None:
    candidates = session.info.pop("clinical_changes_to_capture", [])
    actor_id = session.info.get("sync_actor_id")
    if not candidates or actor_id is None:
        return

    from app.schemas.clinical import (
        AllergyRead,
        ClinicalNoteRead,
        ConsultationRead,
        DocumentRead,
        MedicationRead,
        ObservationRead,
        PatientIdentifierRead,
    )
    from app.schemas.patients import PatientRead

    schema_by_type = {
        Patient: ("patient", PatientRead),
        PatientIdentifier: ("patientIdentifier", PatientIdentifierRead),
        Consultation: ("consultation", ConsultationRead),
        ClinicalNote: ("clinicalNote", ClinicalNoteRead),
        Observation: ("observation", ObservationRead),
        AllergyRecord: ("allergy", AllergyRead),
        MedicationRecord: ("medication", MedicationRead),
        DocumentRecord: ("document", DocumentRead),
    }
    for entity in dict.fromkeys(candidates):
        entity_type, schema = schema_by_type[type(entity)]
        snapshot = schema.model_validate(entity).model_dump(mode="json")
        version = int(getattr(entity, "version", 1))
        session.add(
            SyncChangeRecord(
                clinic_id=entity.clinic_id,
                actor_id=actor_id,
                device_uid="online",
                operation_id=None,
                entity_type=entity_type,
                entity_id=entity.id,
                operation_type="archive"
                if (
                    isinstance(entity, Patient) and entity.archived_at is not None
                )
                or (
                    isinstance(entity, (Observation, AllergyRecord, MedicationRecord))
                    and entity.entered_in_error_at is not None
                )
                else "update",
                entity_version=version,
                payload=snapshot,
                tombstone=isinstance(entity, Patient) and entity.archived_at is not None,
            )
        )
class ClinicKeyWrap(Base):
    """
    One clinic data key, wrapped for one user.

    The clinic data key itself never reaches the server: a device generates
    it, wraps it with a key derived from the user's passphrase, and uploads
    only the wrapped blob. The server can hand a user their own wrap and
    nothing else, so it can help a clinician reach their records without
    being able to read them.

    See docs/security/E2E_ENCRYPTION_DESIGN.md. Storing these does not by
    itself encrypt any clinical record; that is a later migration step.
    """

    __tablename__ = "clinic_key_wraps"
    __table_args__ = (
        UniqueConstraint("clinic_id", "user_id", "key_epoch", name="uq_clinic_key_wrap"),
    )

    id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid4)
    clinic_id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("clinics.id", ondelete="CASCADE"), nullable=False, index=True
    )
    user_id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # Which generation of the clinic key this wrap carries, so a rotation can
    # proceed record by record rather than all at once.
    key_epoch: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    # Opaque to the server: AES-GCM ciphertext of the clinic key.
    wrapped_key: Mapped[str] = mapped_column(String(512), nullable=False)
    wrap_iv: Mapped[str] = mapped_column(String(64), nullable=False)
    # Key-derivation parameters the device needs to rebuild the wrapping key.
    kdf_salt: Mapped[str] = mapped_column(String(64), nullable=False)
    kdf_iterations: Mapped[int] = mapped_column(Integer, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)
    created_by: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
class PatientSearchTerm(Base):
    """
    One keyed hash of one searchable trigram for one patient.

    This is how the server keeps patient search working once it can no longer
    read names: devices send hashes computed with a key derived from the
    clinic key, and the server matches hash against hash without ever holding
    the term. See docs/security/E2E_ENCRYPTION_DESIGN.md.

    The index leaks equality and frequency: the operator can see that two
    patients share a term, and can count how often a term occurs.
    """

    __tablename__ = "patient_search_terms"
    __table_args__ = (
        Index("ix_patient_search_clinic_term", "clinic_id", "term"),
        UniqueConstraint("patient_id", "term", name="uq_patient_search_term"),
    )

    id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid4)
    clinic_id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("clinics.id", ondelete="CASCADE"), nullable=False
    )
    patient_id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("patients.id", ondelete="CASCADE"), nullable=False, index=True
    )
    term: Mapped[str] = mapped_column(String(32), nullable=False)
