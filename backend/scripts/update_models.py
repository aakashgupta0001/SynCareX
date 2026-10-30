"""Update entities.py and __init__.py with Phase 6 models."""
import os

entities_path = os.path.join(os.path.dirname(__file__), "..", "app", "models", "entities.py")
with open(entities_path, "r", encoding="utf-8") as f:
    content = f.read()

models_code = '''

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
'''

target = "class SyncChangeRecord(Base):"
if target in content and "class EmergencyPassport" not in content:
    content = content.replace(target, models_code.strip() + "\n\n\n" + target)
    with open(entities_path, "w", encoding="utf-8") as f:
        f.write(content)
    print("Entities updated successfully")
else:
    print("Entities already had models or target not found")

init_path = os.path.join(os.path.dirname(__file__), "..", "app", "models", "__init__.py")
with open(init_path, "r", encoding="utf-8") as f:
    init_content = f.read()

new_imports = """
    ClinicPairing,
    ClinicTransferPackage,
    EmergencyPassport,
    PatientFollowUp,
    Referral,
"""

if "EmergencyPassport" not in init_content:
    init_content = init_content.replace("    AllergyRecord,\n", "    AllergyRecord,\n" + new_imports.lstrip())
    init_content = init_content.replace('    "AllergyRecord",\n', '    "AllergyRecord",\n    "ClinicPairing",\n    "ClinicTransferPackage",\n    "EmergencyPassport",\n    "PatientFollowUp",\n    "Referral",\n')
    with open(init_path, "w", encoding="utf-8") as f:
        f.write(init_content)
    print("__init__.py updated successfully")

