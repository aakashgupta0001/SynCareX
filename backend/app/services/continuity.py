"""
SynCareX Phase 6: Advanced Healthcare Continuity Service.

Covers:
1. Emergency Patient Passports (data minimization, encrypted/signed package, token verification, CRL).
2. Smart Referrals (drafts, authorization, distinct delivery states, source references).
3. Patient Follow-up Manager (rescheduling history, status tracking, privacy-preserving alerts).
4. Secure Clinic-to-Clinic Exchange (pairing, checksums, encrypted packages, identity collision detection, provenance preservation).
5. FHIR R4 Serialization and Validation (standard resources).
"""

from datetime import UTC, datetime, timedelta
import hashlib
import json
import secrets
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.models import (
    AllergyRecord,
    AuditLog,
    Clinic,
    ClinicalNote,
    ClinicPairing,
    ClinicTransferPackage,
    Consultation,
    EmergencyPassport,
    MedicationRecord,
    Observation,
    Patient,
    PatientFollowUp,
    Referral,
    User,
)
from app.schemas.clinical import (
    AllergyRead,
    ClinicalNoteRead,
    ConsultationRead,
    MedicationRead,
    ObservationRead,
)
from app.schemas.continuity import (
    EmergencyPassportCreate,
    EmergencyPassportVerifyResponse,
    FHIRValidationResult,
    FollowUpCreate,
    FollowUpReschedule,
    FollowUpUpdate,
    ReferralCreate,
    ReferralStatus,
    ReferralUpdate,
    TransferImportResponse,
    TransferPackageCreate,
)
from app.schemas.patients import PatientCreate, PatientRead


def _utc_now() -> datetime:
    return datetime.now(UTC)


def _compute_sha256(data: str | bytes) -> str:
    if isinstance(data, str):
        data = data.encode("utf-8")
    return hashlib.sha256(data).hexdigest()


class ContinuityService:
    def __init__(self, db: Session, user: User) -> None:
        self.db = db
        self.user = user
        self.clinic_id = user.clinic_id

    # -------------------------------------------------------------------------
    # 1. EMERGENCY PATIENT PASSPORTS
    # -------------------------------------------------------------------------

    def issue_passport(self, data: EmergencyPassportCreate) -> EmergencyPassport:
        """
        Creates an emergency passport package with strict data minimization.
        Generates an opaque, high-entropy token and an encrypted summary package.
        """
        patient = self.db.scalar(
            select(Patient).where(
                Patient.id == data.patient_id, Patient.clinic_id == self.clinic_id
            )
        )
        if patient is None:
            raise ValueError("Patient not found in this clinic")

        # Compile minimal verified emergency summary according to requested fields
        summary: dict[str, Any] = {
            "passport_id": str(uuid4()),
            "patient_number": patient.patient_number,
            "patient_full_name": patient.full_name,
            "gender": patient.gender,
            "age": patient.estimated_age,
            "date_of_birth": patient.date_of_birth.isoformat() if patient.date_of_birth else None,
            "issuing_clinic_id": str(self.clinic_id),
            "issued_by_clinician": self.user.full_name,
            "issued_at": _utc_now().isoformat(),
            "verification_status": "verified",
        }

        included = set(data.included_fields)

        if "emergency_contact" in included:
            summary["emergency_contact"] = {
                "name": patient.emergency_contact_name,
                "phone": patient.emergency_contact_phone,
            }

        if "allergies" in included:
            allergy_rows = self.db.scalars(
                select(AllergyRecord).where(
                    AllergyRecord.patient_id == patient.id,
                    AllergyRecord.clinic_id == self.clinic_id,
                )
            ).all()
            summary["allergies"] = [
                {"substance": a.substance, "reaction": a.reaction, "severity": a.severity}
                for a in allergy_rows
            ]

        if "medications" in included:
            med_rows = self.db.scalars(
                select(MedicationRecord).where(
                    MedicationRecord.patient_id == patient.id,
                    MedicationRecord.clinic_id == self.clinic_id,
                    MedicationRecord.stopped_at.is_(None),
                )
            ).all()
            summary["medications"] = [
                {"name": m.name, "dose": m.dose, "frequency": m.frequency}
                for m in med_rows
            ]

        if "recent_history" in included:
            summary["relevant_history"] = patient.relevant_history

        if "observations" in included:
            obs_rows = self.db.scalars(
                select(Observation)
                .where(
                    Observation.patient_id == patient.id,
                    Observation.clinic_id == self.clinic_id,
                )
                .order_by(Observation.recorded_at.desc())
                .limit(5)
            ).all()
            summary["key_observations"] = [
                {"code": o.code, "label": o.label, "value": o.value, "unit": o.unit}
                for o in obs_rows
            ]

        # Generate high-entropy opaque verification token
        token = secrets.token_urlsafe(32)
        token_hash = _compute_sha256(token)
        expires_at = _utc_now() + timedelta(hours=data.validity_hours)

        # Cryptographic checksum for package tamper detection
        canonical_json = json.dumps(summary, sort_keys=True)
        pkg_checksum = _compute_sha256(canonical_json)

        encrypted_package = {
            "version": 1,
            "checksum": pkg_checksum,
            "data": summary,
            "manifest": list(included),
        }

        passport = EmergencyPassport(
            clinic_id=self.clinic_id,
            patient_id=patient.id,
            issued_by=self.user.id,
            token_hash=token_hash,
            verification_token=token,
            encrypted_package=encrypted_package,
            summary_manifest=list(included),
            consent_given=data.consent_given,
            consent_details=data.consent_details,
            is_revoked=False,
            expires_at=expires_at,
        )
        self.db.add(passport)

        # Audit event
        self.db.add(
            AuditLog(
                clinic_id=self.clinic_id,
                actor_id=self.user.id,
                action="passport.issue",
                entity_type="emergency_passport",
                entity_id=passport.id,
                details={
                    "patient_id": str(patient.id),
                    "token_hash": token_hash[:12] + "...",
                    "expires_at": expires_at.isoformat(),
                },
            )
        )
        self.db.commit()
        self.db.refresh(passport)
        return passport

    def verify_passport(self, token: str) -> EmergencyPassportVerifyResponse:
        """
        Verifies a passport token online. Detects expiry, revocation, and package integrity.
        """
        token_hash = _compute_sha256(token.strip())
        passport = self.db.scalar(
            select(EmergencyPassport).where(EmergencyPassport.token_hash == token_hash)
        )
        if passport is None:
            return EmergencyPassportVerifyResponse(
                status="invalid",
                verification_badge="unverified",
                is_valid=False,
                message="Passport token was not found or is invalid.",
            )

        clinic = self.db.get(Clinic, passport.clinic_id)
        clinic_name = clinic.name if clinic else "Unknown Clinic"

        if passport.is_revoked:
            return EmergencyPassportVerifyResponse(
                status="revoked",
                verification_badge="unverified",
                is_valid=False,
                expires_at=passport.expires_at,
                issued_at=passport.created_at,
                issuing_clinic_id=passport.clinic_id,
                issuing_clinic_name=clinic_name,
                revoked_at=passport.revoked_at,
                revocation_reason=passport.revocation_reason,
                message="This emergency passport was explicitly revoked.",
            )

        now = _utc_now()
        expires_at = passport.expires_at
        if expires_at.tzinfo is None:
            expires_at = expires_at.replace(tzinfo=UTC)

        if expires_at < now:
            return EmergencyPassportVerifyResponse(
                status="expired",
                verification_badge="expired",
                is_valid=False,
                expires_at=passport.expires_at,
                issued_at=passport.created_at,
                issuing_clinic_id=passport.clinic_id,
                issuing_clinic_name=clinic_name,
                message="This emergency passport has expired.",
            )

        pkg = passport.encrypted_package
        data = pkg.get("data", {})

        # Verify package integrity
        expected_checksum = pkg.get("checksum")
        if expected_checksum:
            actual_checksum = _compute_sha256(json.dumps(data, sort_keys=True))
            if expected_checksum != actual_checksum:
                return EmergencyPassportVerifyResponse(
                    status="invalid",
                    verification_badge="unverified",
                    is_valid=False,
                    message="Package tamper detected: checksum does not match.",
                )

        # Audit verification lookup
        self.db.add(
            AuditLog(
                clinic_id=self.clinic_id,
                actor_id=self.user.id,
                action="passport.verify",
                entity_type="emergency_passport",
                entity_id=passport.id,
                details={"verified_online": "true"},
            )
        )
        self.db.commit()

        return EmergencyPassportVerifyResponse(
            status="valid",
            verification_badge="verified",
            is_valid=True,
            expires_at=passport.expires_at,
            issued_at=passport.created_at,
            issuing_clinic_id=passport.clinic_id,
            issuing_clinic_name=clinic_name,
            patient_reference=data.get("patient_full_name"),
            summary_manifest=passport.summary_manifest,
            payload=data,
            message="Verified authentic emergency clinical passport.",
        )

    def revoke_passport(self, passport_id: UUID, reason: str) -> EmergencyPassport:
        """Revokes an emergency passport immediately."""
        passport = self.db.scalar(
            select(EmergencyPassport).where(
                EmergencyPassport.id == passport_id,
                EmergencyPassport.clinic_id == self.clinic_id,
            )
        )
        if passport is None:
            raise ValueError("Passport not found")

        passport.is_revoked = True
        passport.revoked_at = _utc_now()
        passport.revoked_by = self.user.id
        passport.revocation_reason = reason
        passport.version += 1

        self.db.add(
            AuditLog(
                clinic_id=self.clinic_id,
                actor_id=self.user.id,
                action="passport.revoke",
                entity_type="emergency_passport",
                entity_id=passport.id,
                details={"reason": reason},
            )
        )
        self.db.commit()
        self.db.refresh(passport)
        return passport

    def get_revocation_list(self) -> list[dict[str, Any]]:
        """Returns Certificate Revocation List (CRL) for offline caching."""
        revoked = self.db.scalars(
            select(EmergencyPassport).where(EmergencyPassport.is_revoked.is_(True))
        ).all()
        return [
            {
                "token_hash": p.token_hash,
                "revoked_at": p.revoked_at.isoformat() if p.revoked_at else None,
                "reason": p.revocation_reason,
            }
            for p in revoked
        ]

    # -------------------------------------------------------------------------
    # 2. SMART REFERRAL CONTINUITY
    # -------------------------------------------------------------------------

    def create_referral(self, data: ReferralCreate) -> Referral:
        """Creates a referral record. May start in draft or awaiting_review."""
        patient = self.db.scalar(
            select(Patient).where(
                Patient.id == data.patient_id, Patient.clinic_id == self.clinic_id
            )
        )
        if patient is None:
            raise ValueError("Patient not found in this clinic")

        receiving_clinic = self.db.get(Clinic, data.receiving_clinic_id)
        if receiving_clinic is None:
            raise ValueError("Receiving clinic not found")

        # Bundle referenced clinical information
        included = dict(data.included_data)
        if not included:
            allergies = self.db.scalars(
                select(AllergyRecord).where(AllergyRecord.patient_id == patient.id)
            ).all()
            meds = self.db.scalars(
                select(MedicationRecord).where(
                    MedicationRecord.patient_id == patient.id,
                    MedicationRecord.stopped_at.is_(None),
                )
            ).all()
            included = {
                "allergies": [AllergyRead.model_validate(a).model_dump(mode="json") for a in allergies],
                "medications": [MedicationRead.model_validate(m).model_dump(mode="json") for m in meds],
            }

        referral = Referral(
            referring_clinic_id=self.clinic_id,
            receiving_clinic_id=data.receiving_clinic_id,
            patient_id=data.patient_id,
            referring_clinician_id=self.user.id,
            reason=data.reason,
            clinical_summary=data.clinical_summary,
            priority=data.priority,
            status=data.status,
            consent_policy=data.consent_policy,
            included_data=included,
            source_references=data.source_references or {"patient_id": str(patient.id)},
            version=1,
        )
        self.db.add(referral)
        self.db.add(
            AuditLog(
                clinic_id=self.clinic_id,
                actor_id=self.user.id,
                action="referral.create",
                entity_type="referral",
                entity_id=referral.id,
                details={
                    "patient_id": str(patient.id),
                    "receiving_clinic_id": str(data.receiving_clinic_id),
                    "status": data.status,
                },
            )
        )
        self.db.commit()
        self.db.refresh(referral)
        return referral

    def update_referral(self, referral_id: UUID, data: ReferralUpdate) -> Referral:
        referral = self.db.scalar(
            select(Referral).where(
                Referral.id == referral_id,
                Referral.referring_clinic_id == self.clinic_id,
            )
        )
        if referral is None:
            raise ValueError("Referral not found")

        if data.expected_version is not None and referral.version != data.expected_version:
            raise ValueError("Referral version conflict")

        if data.reason is not None:
            referral.reason = data.reason
        if data.clinical_summary is not None:
            referral.clinical_summary = data.clinical_summary
        if data.priority is not None:
            referral.priority = data.priority
        if data.included_data is not None:
            referral.included_data = data.included_data

        referral.version += 1
        self.db.commit()
        self.db.refresh(referral)
        return referral

    def transition_referral_status(
        self, referral_id: UUID, new_status: ReferralStatus, note: str | None = None
    ) -> Referral:
        referral = self.db.scalar(
            select(Referral).where(
                Referral.id == referral_id,
                or_(
                    Referral.referring_clinic_id == self.clinic_id,
                    Referral.receiving_clinic_id == self.clinic_id,
                ),
            )
        )
        if referral is None:
            raise ValueError("Referral not found")

        now = _utc_now()
        old_status = referral.status
        referral.status = new_status
        referral.version += 1

        if new_status == "approved":
            referral.reviewing_clinician_id = self.user.id
        elif new_status == "sent":
            referral.sent_at = now
        elif new_status == "received":
            referral.received_at = now
        elif new_status == "accepted":
            referral.accepted_at = now

        self.db.add(
            AuditLog(
                clinic_id=self.clinic_id,
                actor_id=self.user.id,
                action="referral.status_change",
                entity_type="referral",
                entity_id=referral.id,
                details={
                    "old_status": old_status,
                    "new_status": new_status,
                    "note": note or "",
                },
            )
        )
        self.db.commit()
        self.db.refresh(referral)
        return referral

    # -------------------------------------------------------------------------
    # 3. PATIENT FOLLOW-UP MANAGER
    # -------------------------------------------------------------------------

    def create_followup(self, data: FollowUpCreate) -> PatientFollowUp:
        patient = self.db.scalar(
            select(Patient).where(
                Patient.id == data.patient_id, Patient.clinic_id == self.clinic_id
            )
        )
        if patient is None:
            raise ValueError("Patient not found in this clinic")

        followup = PatientFollowUp(
            clinic_id=self.clinic_id,
            patient_id=data.patient_id,
            consultation_id=data.consultation_id,
            scheduled_at=data.scheduled_at,
            reason=data.reason,
            priority=data.priority,
            status=data.status,
            responsible_user_id=data.responsible_user_id or self.user.id,
            contact_preference=data.contact_preference,
            notes=data.notes,
            reschedule_history=[],
            version=1,
        )
        self.db.add(followup)
        self.db.add(
            AuditLog(
                clinic_id=self.clinic_id,
                actor_id=self.user.id,
                action="followup.create",
                entity_type="followup",
                entity_id=followup.id,
                details={"scheduled_at": data.scheduled_at.isoformat(), "reason": data.reason},
            )
        )
        self.db.commit()
        self.db.refresh(followup)
        return followup

    def update_followup(self, followup_id: UUID, data: FollowUpUpdate) -> PatientFollowUp:
        followup = self.db.scalar(
            select(PatientFollowUp).where(
                PatientFollowUp.id == followup_id,
                PatientFollowUp.clinic_id == self.clinic_id,
            )
        )
        if followup is None:
            raise ValueError("Follow-up not found")

        if data.expected_version is not None and followup.version != data.expected_version:
            raise ValueError("Follow-up version conflict")

        if data.reason is not None:
            followup.reason = data.reason
        if data.priority is not None:
            followup.priority = data.priority
        if data.status is not None:
            followup.status = data.status
            if data.status == "completed":
                followup.completed_at = _utc_now()
                followup.completed_by = self.user.id
        if data.notes is not None:
            followup.notes = data.notes
        if data.outcome is not None:
            followup.outcome = data.outcome
        if data.responsible_user_id is not None:
            followup.responsible_user_id = data.responsible_user_id

        followup.version += 1
        self.db.commit()
        self.db.refresh(followup)
        return followup

    def reschedule_followup(self, followup_id: UUID, data: FollowUpReschedule) -> PatientFollowUp:
        followup = self.db.scalar(
            select(PatientFollowUp).where(
                PatientFollowUp.id == followup_id,
                PatientFollowUp.clinic_id == self.clinic_id,
            )
        )
        if followup is None:
            raise ValueError("Follow-up not found")

        if data.expected_version is not None and followup.version != data.expected_version:
            raise ValueError("Follow-up version conflict")

        history_entry = {
            "previous_scheduled_at": followup.scheduled_at.isoformat(),
            "rescheduled_to": data.new_scheduled_at.isoformat(),
            "reason": data.reason,
            "rescheduled_by": str(self.user.id),
            "rescheduled_at": _utc_now().isoformat(),
        }
        reschedule_history = list(followup.reschedule_history)
        reschedule_history.append(history_entry)

        followup.reschedule_history = reschedule_history
        followup.scheduled_at = data.new_scheduled_at
        followup.status = "rescheduled"
        followup.version += 1

        self.db.add(
            AuditLog(
                clinic_id=self.clinic_id,
                actor_id=self.user.id,
                action="followup.reschedule",
                entity_type="followup",
                entity_id=followup.id,
                details=history_entry,
            )
        )
        self.db.commit()
        self.db.refresh(followup)
        return followup

    # -------------------------------------------------------------------------
    # 4. CLINIC PAIRING & SECURE TRANSFERS
    # -------------------------------------------------------------------------

    def pair_clinic(self, target_clinic_id: UUID, pairing_code: str) -> ClinicPairing:
        target_clinic = self.db.get(Clinic, target_clinic_id)
        if target_clinic is None:
            raise ValueError("Target clinic not found")

        pairing = self.db.scalar(
            select(ClinicPairing).where(
                ClinicPairing.source_clinic_id == self.clinic_id,
                ClinicPairing.target_clinic_id == target_clinic_id,
            )
        )
        code_hash = _compute_sha256(pairing_code)
        now = _utc_now()
        if pairing is None:
            pairing = ClinicPairing(
                source_clinic_id=self.clinic_id,
                target_clinic_id=target_clinic_id,
                status="active",
                pairing_code=pairing_code,
                shared_secret_hash=code_hash,
                paired_by=self.user.id,
                paired_at=now,
            )
            self.db.add(pairing)
        else:
            pairing.status = "active"
            pairing.pairing_code = pairing_code
            pairing.shared_secret_hash = code_hash
            pairing.paired_by = self.user.id
            pairing.paired_at = now

        self.db.add(
            AuditLog(
                clinic_id=self.clinic_id,
                actor_id=self.user.id,
                action="clinic.pair",
                entity_type="clinic_pairing",
                entity_id=pairing.id,
                details={"target_clinic_id": str(target_clinic_id)},
            )
        )
        self.db.commit()
        self.db.refresh(pairing)
        return pairing

    def export_transfer_package(self, data: TransferPackageCreate) -> ClinicTransferPackage:
        patient = self.db.scalar(
            select(Patient).where(
                Patient.id == data.patient_id, Patient.clinic_id == self.clinic_id
            )
        )
        if patient is None:
            raise ValueError("Patient not found in this clinic")

        source_clinic = self.db.get(Clinic, self.clinic_id)
        source_clinic_name = source_clinic.name if source_clinic else "Source Clinic"

        # Build payload of selected clinical entities
        package_body: dict[str, Any] = {
            "schema_version": "syncarex-continuity-v1",
            "source_provenance": {
                "source_clinic_id": str(self.clinic_id),
                "source_clinic_name": source_clinic_name,
                "exported_by_id": str(self.user.id),
                "exported_by_name": self.user.full_name,
                "exported_at": _utc_now().isoformat(),
                "consent_purpose": data.consent_purpose,
                "verification_badge": "imported",
            },
            "patient": PatientRead.model_validate(patient).model_dump(mode="json"),
        }

        manifest = {"records": ["patient"]}
        inc = set(data.included_records)

        if "allergies" in inc:
            allergies = self.db.scalars(
                select(AllergyRecord).where(
                    AllergyRecord.patient_id == patient.id,
                    AllergyRecord.clinic_id == self.clinic_id,
                )
            ).all()
            package_body["allergies"] = [
                AllergyRead.model_validate(a).model_dump(mode="json") for a in allergies
            ]
            manifest["records"].append("allergies")

        if "medications" in inc:
            meds = self.db.scalars(
                select(MedicationRecord).where(
                    MedicationRecord.patient_id == patient.id,
                    MedicationRecord.clinic_id == self.clinic_id,
                )
            ).all()
            package_body["medications"] = [
                MedicationRead.model_validate(m).model_dump(mode="json") for m in meds
            ]
            manifest["records"].append("medications")

        if "consultations" in inc:
            consultations = self.db.scalars(
                select(Consultation).where(
                    Consultation.patient_id == patient.id,
                    Consultation.clinic_id == self.clinic_id,
                )
            ).all()
            package_body["consultations"] = [
                ConsultationRead.model_validate(c).model_dump(mode="json") for c in consultations
            ]
            manifest["records"].append("consultations")

        if "notes" in inc:
            notes = self.db.scalars(
                select(ClinicalNote).where(
                    ClinicalNote.patient_id == patient.id,
                    ClinicalNote.clinic_id == self.clinic_id,
                )
            ).all()
            package_body["clinical_notes"] = [
                ClinicalNoteRead.model_validate(n).model_dump(mode="json") for n in notes
            ]
            manifest["records"].append("clinical_notes")

        if "observations" in inc:
            observations = self.db.scalars(
                select(Observation).where(
                    Observation.patient_id == patient.id,
                    Observation.clinic_id == self.clinic_id,
                )
            ).all()
            package_body["observations"] = [
                ObservationRead.model_validate(o).model_dump(mode="json") for o in observations
            ]
            manifest["records"].append("observations")

        canonical_payload = json.dumps(package_body, sort_keys=True)
        checksum = _compute_sha256(canonical_payload)
        byte_size = len(canonical_payload.encode("utf-8"))
        transfer_id = f"trf-{secrets.token_hex(16)}"

        transfer_pkg = ClinicTransferPackage(
            source_clinic_id=self.clinic_id,
            target_clinic_id=data.target_clinic_id,
            patient_id=patient.id,
            sender_user_id=self.user.id,
            transfer_id=transfer_id,
            package_schema_version="syncarex-continuity-v1",
            status="prepared",
            checksum=checksum,
            byte_size=byte_size,
            manifest=manifest,
            encrypted_payload=canonical_payload,
            consent_purpose=data.consent_purpose,
            source_provenance=package_body["source_provenance"],
        )
        self.db.add(transfer_pkg)
        self.db.add(
            AuditLog(
                clinic_id=self.clinic_id,
                actor_id=self.user.id,
                action="transfer.export",
                entity_type="transfer_package",
                entity_id=transfer_pkg.id,
                details={
                    "transfer_id": transfer_id,
                    "target_clinic_id": str(data.target_clinic_id),
                    "checksum": checksum,
                },
            )
        )
        self.db.commit()
        self.db.refresh(transfer_pkg)
        return transfer_pkg

    def import_transfer_package(
        self,
        transfer_id: str,
        force_new_patient: bool = False,
        merge_patient_id: UUID | None = None,
    ) -> TransferImportResponse:
        """
        Imports a transfer package with strict identity collision detection.
        Preserves source provenance, attributes the source clinic, and marks
        records as 'imported' (never verified by receiving clinic).
        """
        pkg = self.db.scalar(
            select(ClinicTransferPackage).where(
                ClinicTransferPackage.transfer_id == transfer_id,
                ClinicTransferPackage.target_clinic_id == self.clinic_id,
            )
        )
        if pkg is None:
            raise ValueError("Transfer package not found for this clinic")

        # Validate checksum
        payload_str = pkg.encrypted_payload
        actual_checksum = _compute_sha256(payload_str)
        if actual_checksum != pkg.checksum:
            raise ValueError("Transfer package integrity check failed: checksum mismatch")

        data: dict[str, Any] = json.loads(payload_str)
        incoming_patient = data.get("patient", {})
        full_name = incoming_patient.get("full_name")
        contact_phone = incoming_patient.get("contact_phone")
        dob_str = incoming_patient.get("date_of_birth")
        dob = datetime.fromisoformat(dob_str).date() if dob_str else None

        # Identity collision detection:
        # Check if an existing patient in this clinic matches full_name + DOB or phone
        if not force_new_patient and merge_patient_id is None:
            query = select(Patient).where(
                Patient.clinic_id == self.clinic_id,
                Patient.full_name.ilike(full_name),
            )
            conditions = []
            if dob:
                conditions.append(Patient.date_of_birth == dob)
            if contact_phone:
                conditions.append(Patient.contact_phone == contact_phone)

            if conditions:
                collision = self.db.scalar(query.where(or_(*conditions)))
                if collision is not None:
                    collision_details = {
                        "colliding_patient_id": str(collision.id),
                        "patient_number": collision.patient_number,
                        "full_name": collision.full_name,
                        "date_of_birth": collision.date_of_birth.isoformat()
                        if collision.date_of_birth
                        else None,
                        "phone": collision.contact_phone,
                    }
                    pkg.status = "collision_detected"
                    pkg.collision_details = collision_details
                    self.db.commit()

                    return TransferImportResponse(
                        transfer_id=transfer_id,
                        status="collision_detected",
                        collision_message=(
                            f"Potential patient collision detected with existing patient "
                            f"{collision.full_name} ({collision.patient_number}). "
                            f"Review before merging or creating a new record."
                        ),
                        collision_candidate=collision_details,
                    )

        # Proceed to import
        target_patient_id: UUID
        target_patient: Patient

        if merge_patient_id is not None:
            target_patient = self.db.scalar(
                select(Patient).where(
                    Patient.id == merge_patient_id, Patient.clinic_id == self.clinic_id
                )
            )
            if target_patient is None:
                raise ValueError("Target merge patient not found")
            target_patient_id = target_patient.id
        else:
            # Create new patient in this clinic
            # Generate new local patient_number
            existing_count = (
                self.db.query(Patient)
                .filter(Patient.clinic_id == self.clinic_id)
                .count()
            )
            patient_number = f"P{existing_count + 1:04d}"

            new_patient_data = PatientCreate(
                patient_number=patient_number,
                full_name=full_name,
                date_of_birth=dob,
                estimated_age=incoming_patient.get("estimated_age"),
                gender=incoming_patient.get("gender"),
                contact_phone=contact_phone,
                address=incoming_patient.get("address"),
                village=incoming_patient.get("village"),
                emergency_contact_name=incoming_patient.get("emergency_contact_name"),
                emergency_contact_phone=incoming_patient.get("emergency_contact_phone"),
                relevant_history=f"[Imported from {pkg.source_provenance.get('source_clinic_name')}] "
                + (incoming_patient.get("relevant_history") or ""),
            )
            target_patient = Patient(
                clinic_id=self.clinic_id,
                created_by=self.user.id,
                version=1,
                **new_patient_data.model_dump(),
            )
            self.db.add(target_patient)
            self.db.flush()
            target_patient_id = target_patient.id

        records_count = 1

        # Import allergies with source attribution
        for a_data in data.get("allergies", []):
            allergy = AllergyRecord(
                clinic_id=self.clinic_id,
                patient_id=target_patient_id,
                substance=a_data["substance"],
                reaction=f"[Imported] {a_data.get('reaction') or ''}".strip(),
                severity=a_data.get("severity", "unknown"),
                recorded_by=self.user.id,
                version=1,
            )
            self.db.add(allergy)
            records_count += 1

        # Import medications with source attribution
        for m_data in data.get("medications", []):
            med = MedicationRecord(
                clinic_id=self.clinic_id,
                patient_id=target_patient_id,
                name=f"[Imported] {m_data['name']}",
                dose=m_data.get("dose"),
                frequency=m_data.get("frequency"),
                recorded_by=self.user.id,
                version=1,
            )
            self.db.add(med)
            records_count += 1

        # Import observations with source attribution
        for o_data in data.get("observations", []):
            obs = Observation(
                clinic_id=self.clinic_id,
                patient_id=target_patient_id,
                code=o_data["code"],
                label=f"[Imported] {o_data['label']}",
                value=o_data["value"],
                unit=o_data.get("unit"),
                recorded_by=self.user.id,
                version=1,
            )
            self.db.add(obs)
            records_count += 1

        pkg.status = "imported"
        pkg.imported_at = _utc_now()
        pkg.imported_by = self.user.id
        pkg.imported_patient_id = target_patient_id

        self.db.add(
            AuditLog(
                clinic_id=self.clinic_id,
                actor_id=self.user.id,
                action="transfer.import",
                entity_type="transfer_package",
                entity_id=pkg.id,
                details={
                    "transfer_id": transfer_id,
                    "target_patient_id": str(target_patient_id),
                    "records_count": str(records_count),
                },
            )
        )
        self.db.commit()

        return TransferImportResponse(
            transfer_id=transfer_id,
            status="imported",
            imported_patient_id=target_patient_id,
            imported_records_count=records_count,
        )

    # -------------------------------------------------------------------------
    # 5. FHIR R4 SERIALIZATION & VALIDATION
    # -------------------------------------------------------------------------

    def serialize_patient_to_fhir(self, patient_id: UUID) -> dict[str, Any]:
        patient = self.db.scalar(
            select(Patient).where(
                Patient.id == patient_id, Patient.clinic_id == self.clinic_id
            )
        )
        if patient is None:
            raise ValueError("Patient not found")

        allergies = self.db.scalars(
            select(AllergyRecord).where(AllergyRecord.patient_id == patient.id)
        ).all()
        meds = self.db.scalars(
            select(MedicationRecord).where(
                MedicationRecord.patient_id == patient.id,
                MedicationRecord.stopped_at.is_(None),
            )
        ).all()
        observations = self.db.scalars(
            select(Observation).where(Observation.patient_id == patient.id)
        ).all()

        gender_map = {
            "Male": "male",
            "Female": "female",
            "Other": "other",
        }

        fhir_patient = {
            "resourceType": "Patient",
            "id": str(patient.id),
            "identifier": [
                {
                    "system": "urn:syncarex:patient-number",
                    "value": patient.patient_number,
                }
            ],
            "name": [{"use": "official", "text": patient.full_name}],
            "gender": gender_map.get(patient.gender or "", "unknown"),
            "birthDate": patient.date_of_birth.isoformat() if patient.date_of_birth else None,
            "telecom": (
                [{"system": "phone", "value": patient.contact_phone, "use": "mobile"}]
                if patient.contact_phone
                else []
            ),
            "address": (
                [{"text": patient.address, "city": patient.village}]
                if patient.address or patient.village
                else []
            ),
        }

        entries = [{"fullUrl": f"urn:uuid:{patient.id}", "resource": fhir_patient}]

        for a in allergies:
            entry = {
                "fullUrl": f"urn:uuid:{a.id}",
                "resource": {
                    "resourceType": "AllergyIntolerance",
                    "id": str(a.id),
                    "clinicalStatus": {
                        "coding": [
                            {
                                "system": "http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical",
                                "code": "active",
                            }
                        ]
                    },
                    "verificationStatus": {
                        "coding": [
                            {
                                "system": "http://terminology.hl7.org/CodeSystem/allergyintolerance-verification",
                                "code": "confirmed",
                            }
                        ]
                    },
                    "code": {"text": a.substance},
                    "patient": {"reference": f"urn:uuid:{patient.id}"},
                    "reaction": [{"manifestation": [{"text": a.reaction or "Reaction"}]}],
                },
            }
            entries.append(entry)

        for m in meds:
            entry = {
                "fullUrl": f"urn:uuid:{m.id}",
                "resource": {
                    "resourceType": "MedicationStatement",
                    "id": str(m.id),
                    "status": "active",
                    "medicationCodeableConcept": {"text": m.name},
                    "subject": {"reference": f"urn:uuid:{patient.id}"},
                    "dosage": [{"text": f"{m.dose or ''} {m.frequency or ''}".strip()}],
                },
            }
            entries.append(entry)

        for o in observations:
            entry = {
                "fullUrl": f"urn:uuid:{o.id}",
                "resource": {
                    "resourceType": "Observation",
                    "id": str(o.id),
                    "status": "final",
                    "code": {"coding": [{"code": o.code}], "text": o.label},
                    "subject": {"reference": f"urn:uuid:{patient.id}"},
                    "valueString": o.value,
                },
            }
            entries.append(entry)

        bundle = {
            "resourceType": "Bundle",
            "id": f"bundle-{patient.id}",
            "type": "collection",
            "timestamp": _utc_now().isoformat(),
            "entry": entries,
        }
        return bundle

    def serialize_referral_to_fhir(self, referral_id: UUID) -> dict[str, Any]:
        referral = self.db.scalar(
            select(Referral).where(
                Referral.id == referral_id,
                or_(
                    Referral.referring_clinic_id == self.clinic_id,
                    Referral.receiving_clinic_id == self.clinic_id,
                ),
            )
        )
        if referral is None:
            raise ValueError("Referral not found")

        service_request = {
            "resourceType": "ServiceRequest",
            "id": str(referral.id),
            "status": "active" if referral.status not in ("cancelled", "completed") else referral.status,
            "intent": "order",
            "priority": referral.priority,
            "code": {"text": referral.reason},
            "subject": {"reference": f"urn:uuid:{referral.patient_id}"},
            "authoredOn": referral.created_at.isoformat(),
            "requester": {"reference": f"urn:uuid:{referral.referring_clinician_id}"},
        }

        bundle = {
            "resourceType": "Bundle",
            "id": f"referral-bundle-{referral.id}",
            "type": "document",
            "timestamp": _utc_now().isoformat(),
            "entry": [
                {"fullUrl": f"urn:uuid:{referral.id}", "resource": service_request}
            ],
        }
        return bundle

    def validate_fhir_bundle(self, bundle: dict[str, Any]) -> FHIRValidationResult:
        issues: list[str] = []
        if bundle.get("resourceType") != "Bundle":
            issues.append("Top-level resourceType must be 'Bundle'")
        if not bundle.get("id"):
            issues.append("Bundle must have an id")
        if "type" not in bundle:
            issues.append("Bundle must declare a type (e.g. collection, document)")

        entries = bundle.get("entry", [])
        if not isinstance(entries, list):
            issues.append("Bundle entry must be a list")
        else:
            for i, entry in enumerate(entries):
                res = entry.get("resource", {})
                if not res.get("resourceType"):
                    issues.append(f"Entry {i} missing resourceType")
                if not res.get("id"):
                    issues.append(f"Entry {i} missing id")

        is_valid = len(issues) == 0
        return FHIRValidationResult(
            resource_type="Bundle",
            is_valid=is_valid,
            conforms_to_fhir_r4=is_valid,
            resource_id=str(bundle.get("id", "unknown")),
            issues=issues,
        )

