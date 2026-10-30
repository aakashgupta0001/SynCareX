"""
Server side of the offline synchronization protocol.

Three invariants drive this module:

1. An operation is only ever reported as acknowledged once it is committed.
2. The same operation replayed by a device never creates a second clinical
   record: the stored result for its idempotency key is returned instead.
3. A concurrent change is reported as a conflict for clinician review. The
   server never merges or overwrites conflicting clinical information.
"""

import hashlib
import json
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models import (
    PatientSearchTerm,
    AISummary,
    AllergyRecord,
    ClinicalNote,
    Clinic,
    Consultation,
    DocumentRecord,
    EntitySealedContent,
    MedicationRecord,
    Observation,
    Patient,
    PatientIdentifier,
    SyncOperationRecord,
    SyncChangeRecord,
    User,
    Referral,
    PatientFollowUp,
)
from app.repositories.patients import PatientRepository
from app.services.audit_chain import append_audit_entry
from app.schemas.clinical import (
    AISummaryCreate,
    AISummaryRead,
    AISummaryUpdate,
    AllergyCreate,
    AllergyRead,
    AllergyUpdate,
    ClinicalNoteCreate,
    ClinicalNoteRead,
    ClinicalNoteUpdate,
    ConsultationCreate,
    ConsultationRead,
    ConsultationUpdate,
    DocumentRead,
    DocumentRegister,
    MedicationCreate,
    MedicationRead,
    MedicationUpdate,
    ObservationCreate,
    ObservationRead,
    ObservationUpdate,
    EnteredInError,
    PatientIdentifierCreate,
    PatientIdentifierRead,
)
from app.schemas.patients import PatientCreate, PatientRead, PatientUpdate
from app.schemas.continuity import ReferralRead, FollowUpRead
from app.schemas.sync import SyncOperationIn, SyncOperationResult


class OperationRejected(Exception):
    """The operation cannot be applied as sent."""

    def __init__(self, message: str, *, retryable: bool) -> None:
        super().__init__(message)
        self.message = message
        self.retryable = retryable


class OperationConflict(Exception):
    """A concurrent change means a clinician must review both versions."""

    def __init__(self, message: str, *, server_version: int, entity: dict[str, Any]) -> None:
        super().__init__(message)
        self.message = message
        self.server_version = server_version
        self.entity = entity


def _dump(model: Any) -> dict[str, Any]:
    return model.model_dump(mode="json")


class SyncService:
    def __init__(self, db: Session, user: User, device_uid: str) -> None:
        self.db = db
        self.user = user
        self.device_uid = device_uid
        self.clinic_id = user.clinic_id

    # ------------------------------------------------------------------ batch

    def apply_batch(self, operations: list[SyncOperationIn]) -> list[SyncOperationResult]:
        """
        Applies operations in the order the device queued them. Each operation
        is committed on its own so a later failure cannot roll back earlier,
        already acknowledged work: partial batch success is the normal case.
        """
        results: list[SyncOperationResult] = []
        for operation in operations:
            results.append(self.apply_one(operation))
        return results

    def apply_one(self, operation: SyncOperationIn) -> SyncOperationResult:
        stored = self.db.get(SyncOperationRecord, operation.idempotency_key)
        if stored is not None:
            if (
                stored.operation_id != operation.operation_id
                or stored.actor_id != self.user.id
                or stored.device_uid != self.device_uid
                or stored.entity_type != operation.entity_type
                or stored.entity_id != operation.entity_id
                or stored.operation_type != operation.operation_type
                or (
                stored.request_hash is not None
                and stored.request_hash != self._request_hash(operation)
                )
            ):
                return self._identity_rejection(operation)
            if stored.request_hash is None:
                return SyncOperationResult(
                    operation_id=operation.operation_id,
                    idempotency_key=operation.idempotency_key,
                    entity_type=stored.entity_type,
                    entity_id=stored.entity_id,
                    status="acknowledged",
                    duplicate=True,
                    server_version=stored.entity_version,
                    message="This operation was applied before durable request fingerprints were introduced.",
                    entity=stored.response,
                )
            return self._stored_result(stored, duplicate=True)

        same_operation = self.db.scalar(
            select(SyncOperationRecord).where(
                SyncOperationRecord.operation_id == operation.operation_id
            )
        )
        if same_operation is not None:
            return self._identity_rejection(operation)

        if operation.schema_version != 1:
            return self._store_terminal_result(
                operation,
                SyncOperationResult(
                    operation_id=operation.operation_id,
                    idempotency_key=operation.idempotency_key,
                    entity_type=operation.entity_type,
                    entity_id=operation.entity_id,
                    status="rejected",
                    retryable=False,
                    message=f"Unsupported synchronization schema version: {operation.schema_version}.",
                ),
            )

        try:
            self.db.scalar(
                select(Clinic.id)
                .where(Clinic.id == self.clinic_id)
                .with_for_update()
            )
            self.db.info["sync_change_operation_id"] = operation.operation_id
            entity, version = self._dispatch(operation)
        except OperationConflict as conflict:
            self.db.rollback()
            self.db.info.pop("sync_change_operation_id", None)
            return self._store_terminal_result(
                operation,
                SyncOperationResult(
                    operation_id=operation.operation_id,
                    idempotency_key=operation.idempotency_key,
                    entity_type=operation.entity_type,
                    entity_id=operation.entity_id,
                    status="conflict",
                    retryable=False,
                    server_version=conflict.server_version,
                    message=conflict.message,
                    entity=conflict.entity,
                ),
            )
        except OperationRejected as rejected:
            self.db.rollback()
            self.db.info.pop("sync_change_operation_id", None)
            result = SyncOperationResult(
                operation_id=operation.operation_id,
                idempotency_key=operation.idempotency_key,
                entity_type=operation.entity_type,
                entity_id=operation.entity_id,
                status="rejected",
                retryable=rejected.retryable,
                message=rejected.message,
            )
            if rejected.retryable:
                return result
            return self._store_terminal_result(operation, result)
        except ValidationError as error:
            self.db.rollback()
            self.db.info.pop("sync_change_operation_id", None)
            return self._store_terminal_result(
                operation,
                SyncOperationResult(
                    operation_id=operation.operation_id,
                    idempotency_key=operation.idempotency_key,
                    entity_type=operation.entity_type,
                    entity_id=operation.entity_id,
                    status="rejected",
                    retryable=False,
                    message=f"The operation payload failed validation: {error.error_count()} problem(s).",
                ),
            )

        result = SyncOperationResult(
            operation_id=operation.operation_id,
            idempotency_key=operation.idempotency_key,
            entity_type=operation.entity_type,
            entity_id=operation.entity_id,
            status="acknowledged",
            server_version=version,
            entity=entity,
        )
        self.db.add(
            SyncOperationRecord(
                idempotency_key=operation.idempotency_key,
                clinic_id=self.clinic_id,
                actor_id=self.user.id,
                operation_id=operation.operation_id,
                device_uid=self.device_uid,
                request_hash=self._request_hash(operation),
                schema_version=operation.schema_version,
                entity_type=operation.entity_type,
                entity_id=operation.entity_id,
                operation_type=operation.operation_type,
                status="acknowledged",
                retryable=False,
                entity_version=version,
                response=result.model_dump(mode="json"),
            )
        )
        self.db.add(
            SyncChangeRecord(
                clinic_id=self.clinic_id,
                actor_id=self.user.id,
                device_uid=self.device_uid,
                operation_id=operation.operation_id,
                entity_type=operation.entity_type,
                entity_id=operation.entity_id,
                operation_type=operation.operation_type,
                entity_version=version,
                payload=entity,
                tombstone=(
                    operation.entity_type == "patient"
                    and operation.operation_type == "archive"
                ),
            )
        )
        append_audit_entry(
            self.db,
            clinic_id=self.clinic_id,
            actor_id=self.user.id,
            action=f"sync.{operation.entity_type}.{operation.operation_type}",
            entity_type=operation.entity_type,
            entity_id=operation.entity_id,
            details={"device": self.device_uid, "version": str(version)},
        )
        self._store_generic_sealed_content(operation, version)
        try:
            self.db.commit()
        except IntegrityError:
            self.db.rollback()
            stored = self.db.get(SyncOperationRecord, operation.idempotency_key)
            if stored is None or stored.operation_id != operation.operation_id or stored.request_hash != self._request_hash(operation):
                return self._identity_rejection(operation)
            return self._stored_result(stored, duplicate=True)
        finally:
            self.db.info.pop("sync_change_operation_id", None)
        return result

    @staticmethod
    def _request_hash(operation: SyncOperationIn) -> str:
        canonical = json.dumps(
            operation.model_dump(mode="json"), sort_keys=True, separators=(",", ":")
        )
        return hashlib.sha256(canonical.encode()).hexdigest()

    @staticmethod
    def _identity_rejection(operation: SyncOperationIn) -> SyncOperationResult:
        return SyncOperationResult(
            operation_id=operation.operation_id,
            idempotency_key=operation.idempotency_key,
            entity_type=operation.entity_type,
            entity_id=operation.entity_id,
            status="rejected",
            retryable=False,
            message="The operation ID or idempotency key is already bound to different content.",
        )

    @staticmethod
    def _stored_result(
        stored: SyncOperationRecord, *, duplicate: bool
    ) -> SyncOperationResult:
        payload = dict(stored.response or {})
        payload["duplicate"] = duplicate
        return SyncOperationResult.model_validate(payload)

    def _store_terminal_result(
        self, operation: SyncOperationIn, result: SyncOperationResult
    ) -> SyncOperationResult:
        self.db.add(
            SyncOperationRecord(
                idempotency_key=operation.idempotency_key,
                clinic_id=self.clinic_id,
                actor_id=self.user.id,
                operation_id=operation.operation_id,
                device_uid=self.device_uid,
                request_hash=self._request_hash(operation),
                schema_version=operation.schema_version,
                entity_type=operation.entity_type,
                entity_id=operation.entity_id,
                operation_type=operation.operation_type,
                status=result.status,
                retryable=False,
                entity_version=result.server_version,
                response=result.model_dump(mode="json"),
            )
        )
        try:
            self.db.commit()
        except IntegrityError:
            self.db.rollback()
            stored = self.db.get(SyncOperationRecord, operation.idempotency_key)
            if stored is not None and stored.operation_id == operation.operation_id and stored.request_hash == self._request_hash(operation):
                return self._stored_result(stored, duplicate=True)
            return self._identity_rejection(operation)
        return result

    # --------------------------------------------------------------- dispatch

    def _dispatch(self, operation: SyncOperationIn) -> tuple[dict[str, Any], int]:
        key = (operation.entity_type, operation.operation_type)
        handlers = {
            ("patient", "create"): self._patient_create,
            ("patient", "update"): self._patient_update,
            ("patient", "archive"): self._patient_archive,
            ("patientIdentifier", "create"): self._identifier_create,
            ("consultation", "create"): self._consultation_create,
            ("consultation", "update"): self._consultation_update,
            ("clinicalNote", "create"): self._note_create,
            ("clinicalNote", "update"): self._note_update,
            ("observation", "create"): self._observation_create,
            ("observation", "update"): self._observation_update,
            ("observation", "archive"): self._observation_archive,
            ("allergy", "create"): self._allergy_create,
            ("allergy", "update"): self._allergy_update,
            ("allergy", "archive"): self._allergy_archive,
            ("medication", "create"): self._medication_create,
            ("medication", "update"): self._medication_update,
            ("medication", "archive"): self._medication_archive,
            ("document", "upload"): self._document_register,
            ("referral", "create"): self._referral_create,
            ("referral", "update"): self._referral_update,
            ("followup", "create"): self._followup_create,
            ("followup", "update"): self._followup_update,
            ("aiSummary", "create"): self._ai_summary_create,
            ("aiSummary", "update"): self._ai_summary_update,
        }
        handler = handlers.get(key)
        if handler is None:
            raise OperationRejected(
                f"The server does not support {operation.operation_type} on {operation.entity_type}.",
                retryable=False,
            )
        return handler(operation)

    # ---------------------------------------------------------------- helpers

    def _require_patient(self, patient_id: UUID) -> Patient:
        patient = self.db.scalar(
            select(Patient).where(
                Patient.id == patient_id, Patient.clinic_id == self.clinic_id
            ).with_for_update()
        )
        if patient is None:
            raise OperationRejected(
                "The patient this record belongs to has not reached the server yet. "
                "The operation stays queued and will be retried after the patient syncs.",
                retryable=True,
            )
        return patient

    def _require_consultation(self, consultation_id: UUID) -> Consultation:
        consultation = self.db.scalar(
            select(Consultation).where(
                Consultation.id == consultation_id,
                Consultation.clinic_id == self.clinic_id,
            ).with_for_update()
        )
        if consultation is None:
            raise OperationRejected(
                "The consultation this record belongs to has not reached the server yet. "
                "The operation stays queued and will be retried.",
                retryable=True,
            )
        return consultation

    @staticmethod
    def _check_version(current: int, expected: int | None, entity: dict[str, Any]) -> None:
        if expected is not None and expected != current:
            raise OperationConflict(
                "The server holds a newer version of this record. A clinician must "
                "review both versions; nothing was overwritten.",
                server_version=current,
                entity=entity,
            )


    # ------------------------------------------------- dual-write (E2E step 2)

    def _store_sealed_content(self, patient: Patient, operation: SyncOperationIn) -> None:
        """
        Records the clinic-key-encrypted copy of this patient, and the keyed
        search-term hashes that let the server match searches without reading
        the terms.

        Both are optional: a device with no clinic key sends neither and
        synchronizes exactly as before. While dual-write is in effect the
        plaintext columns remain authoritative, so nothing here changes what
        a reader sees.
        """
        if operation.sealed_content is not None:
            patient.content_ciphertext = operation.sealed_content.ciphertext
            patient.content_iv = operation.sealed_content.iv
            patient.content_key_epoch = operation.sealed_content.key_epoch

        if operation.search_terms:
            # The device sends the full set for the record, so replacing is
            # correct: a term removed by an edit must stop matching.
            self.db.query(PatientSearchTerm).filter(
                PatientSearchTerm.patient_id == patient.id
            ).delete(synchronize_session=False)
            seen: set[str] = set()
            for term in operation.search_terms:
                if term in seen:
                    continue
                seen.add(term)
                self.db.add(
                    PatientSearchTerm(
                        clinic_id=self.clinic_id,
                        patient_id=patient.id,
                        term=term,
                    )
                )

    # --------------------------------------------------------------- patients

    def _store_generic_sealed_content(
        self, operation: SyncOperationIn, version: int
    ) -> None:
        """Keeps the clinic-key envelope for any non-patient entity.

        Patients carry their sealed columns inline; everything else lands here,
        verbatim, in the same transaction as the acknowledged result. The
        server cannot read these blobs — they are the copy that becomes
        authoritative when the plaintext columns are dropped.
        """
        if operation.sealed_content is None or operation.entity_type == "patient":
            return
        existing = self.db.scalar(
            select(EntitySealedContent).where(
                EntitySealedContent.clinic_id == self.clinic_id,
                EntitySealedContent.entity_type == operation.entity_type,
                EntitySealedContent.entity_id == operation.entity_id,
            )
        )
        if existing is not None:
            existing.ciphertext = operation.sealed_content.ciphertext
            existing.iv = operation.sealed_content.iv
            existing.key_epoch = operation.sealed_content.key_epoch
            existing.entity_version = version
            return
        self.db.add(
            EntitySealedContent(
                clinic_id=self.clinic_id,
                entity_type=operation.entity_type,
                entity_id=operation.entity_id,
                ciphertext=operation.sealed_content.ciphertext,
                iv=operation.sealed_content.iv,
                key_epoch=operation.sealed_content.key_epoch,
                entity_version=version,
            )
        )

    def _patient_create(self, operation: SyncOperationIn) -> tuple[dict[str, Any], int]:
        existing = self.db.scalar(
            select(Patient).where(
                Patient.id == operation.entity_id, Patient.clinic_id == self.clinic_id
            )
        )
        if existing is not None:
            # The record is already present (an earlier attempt landed), so the
            # device's create is satisfied without a second row.
            return _dump(PatientRead.model_validate(existing)), existing.version

        payload = dict(operation.payload)
        payload["id"] = str(operation.entity_id)
        data = PatientCreate.model_validate(payload)
        patient = PatientRepository(self.db).create(self.clinic_id, self.user.id, data)
        self.db.flush()
        self._store_sealed_content(patient, operation)
        self.db.flush()
        return _dump(PatientRead.model_validate(patient)), patient.version

    def _patient_update(self, operation: SyncOperationIn) -> tuple[dict[str, Any], int]:
        patient = self._require_patient(operation.entity_id)
        snapshot = _dump(PatientRead.model_validate(patient))
        payload = dict(operation.payload)
        expected = payload.pop("expected_version", operation.base_version)
        self._check_version(patient.version, expected, snapshot)
        data = PatientUpdate.model_validate(payload)
        PatientRepository(self.db).update(patient, data)
        self.db.flush()
        self._store_sealed_content(patient, operation)
        self.db.flush()
        return _dump(PatientRead.model_validate(patient)), patient.version

    def _patient_archive(self, operation: SyncOperationIn) -> tuple[dict[str, Any], int]:
        patient = self._require_patient(operation.entity_id)
        snapshot = _dump(PatientRead.model_validate(patient))
        expected = operation.payload.get("expected_version", operation.base_version)
        self._check_version(patient.version, expected, snapshot)
        if patient.archived_at is None:
            patient.archived_at = datetime.now(UTC)
            patient.version += 1
        self.db.flush()
        return _dump(PatientRead.model_validate(patient)), patient.version

    def _identifier_create(self, operation: SyncOperationIn) -> tuple[dict[str, Any], int]:
        payload = dict(operation.payload)
        payload.setdefault("patient_id", payload.get("patientId"))
        data = PatientIdentifierCreate.model_validate(
            {
                "id": str(operation.entity_id),
                "patient_id": payload.get("patient_id"),
                "system": payload.get("system"),
                "value": payload.get("value"),
            }
        )
        self._require_patient(data.patient_id)
        existing = self.db.get(PatientIdentifier, operation.entity_id)
        if existing is not None:
            return _dump(PatientIdentifierRead.model_validate(existing)), 1
        duplicate = self.db.scalar(
            select(PatientIdentifier).where(
                PatientIdentifier.clinic_id == self.clinic_id,
                PatientIdentifier.system == data.system,
                PatientIdentifier.value == data.value,
            )
        )
        if duplicate is not None:
            raise OperationRejected(
                "Another patient in this clinic already holds that identifier. "
                "Review the identifier before retrying.",
                retryable=False,
            )
        identifier = PatientIdentifier(
            id=operation.entity_id,
            patient_id=data.patient_id,
            clinic_id=self.clinic_id,
            system=data.system,
            value=data.value,
        )
        self.db.add(identifier)
        self.db.flush()
        return _dump(PatientIdentifierRead.model_validate(identifier)), 1

    # ---------------------------------------------------------- consultations

    def _consultation_create(self, operation: SyncOperationIn) -> tuple[dict[str, Any], int]:
        existing = self.db.scalar(
            select(Consultation).where(
                Consultation.id == operation.entity_id,
                Consultation.clinic_id == self.clinic_id,
            )
        )
        if existing is not None:
            return _dump(ConsultationRead.model_validate(existing)), existing.version
        payload = dict(operation.payload)
        data = ConsultationCreate.model_validate(
            {
                "id": str(operation.entity_id),
                "patient_id": payload.get("patient_id") or payload.get("patientId"),
                "reason": payload.get("reason"),
                "notes": payload.get("notes"),
                "occurred_at": payload.get("occurred_at") or payload.get("occurredAt"),
                "status": payload.get("status", "draft"),
            }
        )
        self._require_patient(data.patient_id)
        consultation = Consultation(
            id=operation.entity_id,
            clinic_id=self.clinic_id,
            patient_id=data.patient_id,
            clinician_id=self.user.id,
            status=data.status,
            reason=data.reason,
            notes=data.notes,
            version=1,
            occurred_at=data.occurred_at or datetime.now(UTC),
        )
        self.db.add(consultation)
        self.db.flush()
        return _dump(ConsultationRead.model_validate(consultation)), consultation.version

    def _consultation_update(self, operation: SyncOperationIn) -> tuple[dict[str, Any], int]:
        consultation = self._require_consultation(operation.entity_id)
        snapshot = _dump(ConsultationRead.model_validate(consultation))
        payload = dict(operation.payload)
        expected = payload.pop("expected_version", operation.base_version)
        self._check_version(consultation.version, expected, snapshot)
        data = ConsultationUpdate.model_validate(payload)
        changes = data.model_dump(exclude_unset=True, exclude={"expected_version"})
        for field, value in changes.items():
            setattr(consultation, field, value)
        if changes:
            consultation.version += 1
        self.db.flush()
        return _dump(ConsultationRead.model_validate(consultation)), consultation.version

    def _note_create(self, operation: SyncOperationIn) -> tuple[dict[str, Any], int]:
        existing = self.db.get(ClinicalNote, operation.entity_id)
        if existing is not None and existing.clinic_id == self.clinic_id:
            return _dump(ClinicalNoteRead.model_validate(existing)), existing.version
        payload = dict(operation.payload)
        data = ClinicalNoteCreate.model_validate(
            {
                "id": str(operation.entity_id),
                "patient_id": payload.get("patient_id") or payload.get("patientId"),
                "consultation_id": payload.get("consultation_id")
                or payload.get("consultationId"),
                "body": payload.get("body"),
                "note_type": payload.get("note_type") or payload.get("noteType", "general"),
            }
        )
        self._require_patient(data.patient_id)
        self._require_consultation(data.consultation_id)
        note = ClinicalNote(
            id=operation.entity_id,
            clinic_id=self.clinic_id,
            patient_id=data.patient_id,
            consultation_id=data.consultation_id,
            author_id=self.user.id,
            note_type=data.note_type,
            body=data.body,
            version=1,
        )
        self.db.add(note)
        self.db.flush()
        return _dump(ClinicalNoteRead.model_validate(note)), note.version

    def _note_update(self, operation: SyncOperationIn) -> tuple[dict[str, Any], int]:
        note = self.db.get(ClinicalNote, operation.entity_id)
        if note is None or note.clinic_id != self.clinic_id:
            raise OperationRejected(
                "The clinical note this edit belongs to has not reached the server yet.",
                retryable=True,
            )
        snapshot = _dump(ClinicalNoteRead.model_validate(note))
        payload = dict(operation.payload)
        expected = payload.pop("expected_version", operation.base_version)
        self._check_version(note.version, expected, snapshot)
        data = ClinicalNoteUpdate.model_validate(payload)
        note.body = data.body
        note.version += 1
        self.db.flush()
        return _dump(ClinicalNoteRead.model_validate(note)), note.version

    # ------------------------------------------------------- AI summaries

    def _ai_summary_create(self, operation: SyncOperationIn) -> tuple[dict[str, Any], int]:
        existing = self.db.get(AISummary, operation.entity_id)
        if existing is not None and existing.clinic_id == self.clinic_id:
            return _dump(AISummaryRead.model_validate(existing)), existing.version
        payload = dict(operation.payload)
        data = AISummaryCreate.model_validate(
            {
                "id": str(operation.entity_id),
                "patient_id": payload.get("patient_id") or payload.get("patientId"),
                "text": payload.get("text"),
                "source_artifact_id": payload.get("source_artifact_id")
                or payload.get("sourceArtifactId"),
                "sections": payload.get("sections") or [],
            }
        )
        self._require_patient(data.patient_id)
        summary = AISummary(
            id=operation.entity_id,
            clinic_id=self.clinic_id,
            patient_id=data.patient_id,
            author_id=self.user.id,
            source_artifact_id=data.source_artifact_id,
            sections=data.sections,
            clinician_edited=True,
            text=data.text,
            version=1,
        )
        self.db.add(summary)
        self.db.flush()
        return _dump(AISummaryRead.model_validate(summary)), summary.version

    def _ai_summary_update(self, operation: SyncOperationIn) -> tuple[dict[str, Any], int]:
        summary = self.db.get(AISummary, operation.entity_id)
        if summary is None or summary.clinic_id != self.clinic_id:
            raise OperationRejected(
                "The AI summary this edit belongs to has not reached the server yet.",
                retryable=True,
            )
        snapshot = _dump(AISummaryRead.model_validate(summary))
        payload = dict(operation.payload)
        expected = payload.pop("expected_version", operation.base_version)
        self._check_version(summary.version, expected, snapshot)
        data = AISummaryUpdate.model_validate(payload)
        summary.text = data.text
        summary.version += 1
        self.db.flush()
        return _dump(AISummaryRead.model_validate(summary)), summary.version

    # ------------------------------------------------- observations and more

    def _observation_create(self, operation: SyncOperationIn) -> tuple[dict[str, Any], int]:
        existing = self.db.get(Observation, operation.entity_id)
        if existing is not None and existing.clinic_id == self.clinic_id:
            return _dump(ObservationRead.model_validate(existing)), existing.version
        payload = dict(operation.payload)
        data = ObservationCreate.model_validate(
            {
                "id": str(operation.entity_id),
                "patient_id": payload.get("patient_id") or payload.get("patientId"),
                "consultation_id": payload.get("consultation_id")
                or payload.get("consultationId"),
                "code": payload.get("code"),
                "label": payload.get("label"),
                "value": payload.get("value"),
                "unit": payload.get("unit") or None,
                "recorded_at": payload.get("recorded_at") or payload.get("recordedAt"),
            }
        )
        self._require_patient(data.patient_id)
        if data.consultation_id is not None:
            self._require_consultation(data.consultation_id)
        observation = Observation(
            id=operation.entity_id,
            clinic_id=self.clinic_id,
            patient_id=data.patient_id,
            consultation_id=data.consultation_id,
            code=data.code,
            label=data.label,
            value=data.value,
            unit=data.unit,
            recorded_at=data.recorded_at or datetime.now(UTC),
            recorded_by=self.user.id,
            version=1,
        )
        self.db.add(observation)
        self.db.flush()
        return _dump(ObservationRead.model_validate(observation)), observation.version

    def _observation_update(self, operation: SyncOperationIn) -> tuple[dict[str, Any], int]:
        record = self.db.scalar(
            select(Observation).where(
                Observation.id == operation.entity_id,
                Observation.clinic_id == self.clinic_id,
            ).with_for_update()
        )
        if record is None:
            raise OperationRejected("Observation not found", retryable=True)
        snapshot = _dump(ObservationRead.model_validate(record))
        payload = dict(operation.payload)
        expected = payload.pop("expected_version", operation.base_version)
        self._check_version(record.version, expected, snapshot)
        if record.entered_in_error_at is not None:
            raise OperationRejected("An entered-in-error observation cannot be edited.", retryable=False)
        data = ObservationUpdate.model_validate(payload)
        changes = data.model_dump(exclude_unset=True)
        changes.pop("expected_version", None)
        if not changes:
            raise OperationRejected("An observation update must change at least one field.", retryable=False)
        for field in ("code", "label", "value", "unit", "recorded_at"):
            if field in changes:
                if field in {"code", "label", "value", "recorded_at"} and changes[field] is None:
                    raise OperationRejected(f"Observation {field} cannot be empty.", retryable=False)
                setattr(record, field, changes[field])
        record.version += 1
        self.db.flush()
        return _dump(ObservationRead.model_validate(record)), record.version

    def _observation_archive(self, operation: SyncOperationIn) -> tuple[dict[str, Any], int]:
        record = self.db.scalar(
            select(Observation).where(
                Observation.id == operation.entity_id,
                Observation.clinic_id == self.clinic_id,
            ).with_for_update()
        )
        if record is None:
            raise OperationRejected("Observation not found", retryable=True)
        snapshot = _dump(ObservationRead.model_validate(record))
        data = EnteredInError.model_validate(operation.payload)
        self._check_version(record.version, data.expected_version or operation.base_version, snapshot)
        if record.entered_in_error_at is not None:
            raise OperationRejected("Observation is already entered in error.", retryable=False)
        record.entered_in_error_at = datetime.now(UTC)
        record.entered_in_error_by = self.user.id
        record.entered_in_error_reason = data.reason
        record.version += 1
        self.db.flush()
        return _dump(ObservationRead.model_validate(record)), record.version

    def _allergy_create(self, operation: SyncOperationIn) -> tuple[dict[str, Any], int]:
        existing = self.db.get(AllergyRecord, operation.entity_id)
        if existing is not None and existing.clinic_id == self.clinic_id:
            return _dump(AllergyRead.model_validate(existing)), existing.version
        payload = dict(operation.payload)
        data = AllergyCreate.model_validate(
            {
                "id": str(operation.entity_id),
                "patient_id": payload.get("patient_id") or payload.get("patientId"),
                "substance": payload.get("substance"),
                "reaction": payload.get("reaction") or None,
                "severity": payload.get("severity", "unknown"),
            }
        )
        self._require_patient(data.patient_id)
        allergy = AllergyRecord(
            id=operation.entity_id,
            clinic_id=self.clinic_id,
            patient_id=data.patient_id,
            substance=data.substance,
            reaction=data.reaction,
            severity=data.severity,
            recorded_by=self.user.id,
            version=1,
        )
        self.db.add(allergy)
        self.db.flush()
        return _dump(AllergyRead.model_validate(allergy)), allergy.version

    def _allergy_update(self, operation: SyncOperationIn) -> tuple[dict[str, Any], int]:
        record = self.db.scalar(
            select(AllergyRecord).where(
                AllergyRecord.id == operation.entity_id,
                AllergyRecord.clinic_id == self.clinic_id,
            ).with_for_update()
        )
        if record is None:
            raise OperationRejected("Allergy not found", retryable=True)
        snapshot = _dump(AllergyRead.model_validate(record))
        payload = dict(operation.payload)
        expected = payload.pop("expected_version", operation.base_version)
        self._check_version(record.version, expected, snapshot)
        if record.entered_in_error_at is not None:
            raise OperationRejected("An entered-in-error allergy cannot be edited.", retryable=False)
        data = AllergyUpdate.model_validate(payload)
        changes = data.model_dump(exclude_unset=True)
        changes.pop("expected_version", None)
        if not changes:
            raise OperationRejected("An allergy update must change at least one field.", retryable=False)
        for field in ("substance", "reaction", "severity"):
            if field in changes:
                if field in {"substance", "severity"} and changes[field] is None:
                    raise OperationRejected(f"Allergy {field} cannot be empty.", retryable=False)
                setattr(record, field, changes[field])
        record.version += 1
        self.db.flush()
        return _dump(AllergyRead.model_validate(record)), record.version

    def _allergy_archive(self, operation: SyncOperationIn) -> tuple[dict[str, Any], int]:
        record = self.db.scalar(
            select(AllergyRecord).where(
                AllergyRecord.id == operation.entity_id,
                AllergyRecord.clinic_id == self.clinic_id,
            ).with_for_update()
        )
        if record is None:
            raise OperationRejected("Allergy not found", retryable=True)
        snapshot = _dump(AllergyRead.model_validate(record))
        data = EnteredInError.model_validate(operation.payload)
        self._check_version(record.version, data.expected_version or operation.base_version, snapshot)
        if record.entered_in_error_at is not None:
            raise OperationRejected("Allergy is already entered in error.", retryable=False)
        record.entered_in_error_at = datetime.now(UTC)
        record.entered_in_error_by = self.user.id
        record.entered_in_error_reason = data.reason
        record.version += 1
        self.db.flush()
        return _dump(AllergyRead.model_validate(record)), record.version

    def _medication_create(self, operation: SyncOperationIn) -> tuple[dict[str, Any], int]:
        existing = self.db.get(MedicationRecord, operation.entity_id)
        if existing is not None and existing.clinic_id == self.clinic_id:
            return _dump(MedicationRead.model_validate(existing)), existing.version
        payload = dict(operation.payload)
        data = MedicationCreate.model_validate(
            {
                "id": str(operation.entity_id),
                "patient_id": payload.get("patient_id") or payload.get("patientId"),
                "consultation_id": payload.get("consultation_id")
                or payload.get("consultationId"),
                "name": payload.get("name"),
                "dose": payload.get("dose") or None,
                "frequency": payload.get("frequency") or None,
                "started_at": payload.get("started_at") or payload.get("startedAt"),
            }
        )
        self._require_patient(data.patient_id)
        if data.consultation_id is not None:
            self._require_consultation(data.consultation_id)
        medication = MedicationRecord(
            id=operation.entity_id,
            clinic_id=self.clinic_id,
            patient_id=data.patient_id,
            consultation_id=data.consultation_id,
            name=data.name,
            dose=data.dose,
            frequency=data.frequency,
            started_at=data.started_at,
            recorded_by=self.user.id,
            version=1,
        )
        self.db.add(medication)
        self.db.flush()
        return _dump(MedicationRead.model_validate(medication)), medication.version

    def _medication_update(self, operation: SyncOperationIn) -> tuple[dict[str, Any], int]:
        record = self.db.scalar(
            select(MedicationRecord).where(
                MedicationRecord.id == operation.entity_id,
                MedicationRecord.clinic_id == self.clinic_id,
            ).with_for_update()
        )
        if record is None:
            raise OperationRejected("Medication not found", retryable=True)
        snapshot = _dump(MedicationRead.model_validate(record))
        payload = dict(operation.payload)
        expected = payload.pop("expected_version", operation.base_version)
        self._check_version(record.version, expected, snapshot)
        if record.entered_in_error_at is not None:
            raise OperationRejected("An entered-in-error medication cannot be edited.", retryable=False)
        data = MedicationUpdate.model_validate(payload)
        changes = data.model_dump(exclude_unset=True)
        changes.pop("expected_version", None)
        if not changes:
            raise OperationRejected("A medication update must change at least one field.", retryable=False)
        for field in ("name", "dose", "frequency", "started_at", "stopped_at"):
            if field in changes:
                if field == "name" and changes[field] is None:
                    raise OperationRejected("Medication name cannot be empty.", retryable=False)
                setattr(record, field, changes[field])
        record.version += 1
        self.db.flush()
        return _dump(MedicationRead.model_validate(record)), record.version

    def _medication_archive(self, operation: SyncOperationIn) -> tuple[dict[str, Any], int]:
        record = self.db.scalar(
            select(MedicationRecord).where(
                MedicationRecord.id == operation.entity_id,
                MedicationRecord.clinic_id == self.clinic_id,
            ).with_for_update()
        )
        if record is None:
            raise OperationRejected("Medication not found", retryable=True)
        snapshot = _dump(MedicationRead.model_validate(record))
        data = EnteredInError.model_validate(operation.payload)
        self._check_version(record.version, data.expected_version or operation.base_version, snapshot)
        if record.entered_in_error_at is not None:
            raise OperationRejected("Medication is already entered in error.", retryable=False)
        record.entered_in_error_at = datetime.now(UTC)
        record.entered_in_error_by = self.user.id
        record.entered_in_error_reason = data.reason
        record.version += 1
        self.db.flush()
        return _dump(MedicationRead.model_validate(record)), record.version

    # -------------------------------------------------------------- documents

    def _document_register(self, operation: SyncOperationIn) -> tuple[dict[str, Any], int]:
        """
        Registers document metadata. The bytes arrive through the separate
        upload endpoint, so acknowledging this operation means "metadata
        accepted", never "file stored".
        """
        existing = self.db.get(DocumentRecord, operation.entity_id)
        if existing is not None and existing.clinic_id == self.clinic_id:
            return _dump(DocumentRead.model_validate(existing)), existing.version
        payload = dict(operation.payload)
        data = DocumentRegister.model_validate(
            {
                "id": str(operation.entity_id),
                "patient_id": payload.get("patient_id") or payload.get("patientId"),
                "consultation_id": payload.get("consultation_id")
                or payload.get("consultationId"),
                "file_name": payload.get("file_name") or payload.get("fileName"),
                "mime_type": payload.get("mime_type") or payload.get("mimeType"),
                "byte_size": payload.get("byte_size") or payload.get("byteSize"),
                "checksum": payload.get("checksum"),
                "description": payload.get("description") or None,
            }
        )
        self._require_patient(data.patient_id)
        if data.consultation_id is not None:
            self._require_consultation(data.consultation_id)
        document = DocumentRecord(
            id=operation.entity_id,
            clinic_id=self.clinic_id,
            patient_id=data.patient_id,
            consultation_id=data.consultation_id,
            file_name=data.file_name,
            mime_type=data.mime_type,
            byte_size=data.byte_size,
            checksum=data.checksum,
            description=data.description,
            uploaded_by=self.user.id,
            version=1,
        )
        self.db.add(document)
        self.db.flush()
        return _dump(DocumentRead.model_validate(document)), document.version

    # ----------------------------------------------------------------- continuity

    def _referral_create(self, operation: SyncOperationIn) -> tuple[dict[str, Any], int]:
        existing = self.db.scalar(
            select(Referral).where(
                Referral.id == operation.entity_id,
                Referral.referring_clinic_id == self.clinic_id,
            )
        )
        if existing is not None:
            return _dump(ReferralRead.model_validate(existing)), existing.version

        payload = dict(operation.payload)
        patient_id = payload.get("patient_id") or payload.get("patientId")
        receiving_clinic_id = payload.get("receiving_clinic_id") or payload.get("receivingClinicId")
        self._require_patient(UUID(str(patient_id)))

        referral = Referral(
            id=operation.entity_id,
            referring_clinic_id=self.clinic_id,
            receiving_clinic_id=UUID(str(receiving_clinic_id)),
            patient_id=UUID(str(patient_id)),
            referring_clinician_id=self.user.id,
            reason=payload.get("reason", "Referral"),
            clinical_summary=payload.get("clinical_summary"),
            priority=payload.get("priority", "routine"),
            status=payload.get("status", "draft"),
            consent_policy=payload.get("consent_policy"),
            included_data=payload.get("included_data", {}),
            source_references=payload.get("source_references"),
            version=1,
        )
        self.db.add(referral)
        self.db.flush()
        return _dump(ReferralRead.model_validate(referral)), referral.version

    def _referral_update(self, operation: SyncOperationIn) -> tuple[dict[str, Any], int]:
        referral = self.db.scalar(
            select(Referral).where(
                Referral.id == operation.entity_id,
                Referral.referring_clinic_id == self.clinic_id,
            )
        )
        if referral is None:
            raise OperationRejected("Referral not found", retryable=True)

        snapshot = _dump(ReferralRead.model_validate(referral))
        payload = dict(operation.payload)
        expected = payload.pop("expected_version", operation.base_version)
        self._check_version(referral.version, expected, snapshot)

        if "reason" in payload:
            referral.reason = payload["reason"]
        if "clinical_summary" in payload:
            referral.clinical_summary = payload["clinical_summary"]
        if "status" in payload:
            referral.status = payload["status"]
        if "priority" in payload:
            referral.priority = payload["priority"]
        referral.version += 1
        self.db.flush()
        return _dump(ReferralRead.model_validate(referral)), referral.version

    def _followup_create(self, operation: SyncOperationIn) -> tuple[dict[str, Any], int]:
        existing = self.db.scalar(
            select(PatientFollowUp).where(
                PatientFollowUp.id == operation.entity_id,
                PatientFollowUp.clinic_id == self.clinic_id,
            )
        )
        if existing is not None:
            return _dump(FollowUpRead.model_validate(existing)), existing.version

        payload = dict(operation.payload)
        patient_id = payload.get("patient_id") or payload.get("patientId")
        self._require_patient(UUID(str(patient_id)))

        scheduled_at_raw = payload.get("scheduled_at") or payload.get("scheduledAt")
        scheduled_at = datetime.fromisoformat(str(scheduled_at_raw)) if scheduled_at_raw else datetime.now(UTC)

        followup = PatientFollowUp(
            id=operation.entity_id,
            clinic_id=self.clinic_id,
            patient_id=UUID(str(patient_id)),
            consultation_id=UUID(str(payload["consultation_id"])) if payload.get("consultation_id") else None,
            scheduled_at=scheduled_at,
            reason=payload.get("reason", "Follow-up"),
            priority=payload.get("priority", "routine"),
            status=payload.get("status", "scheduled"),
            responsible_user_id=self.user.id,
            contact_preference=payload.get("contact_preference", "phone"),
            notes=payload.get("notes"),
            reschedule_history=[],
            version=1,
        )
        self.db.add(followup)
        self.db.flush()
        return _dump(FollowUpRead.model_validate(followup)), followup.version

    def _followup_update(self, operation: SyncOperationIn) -> tuple[dict[str, Any], int]:
        followup = self.db.scalar(
            select(PatientFollowUp).where(
                PatientFollowUp.id == operation.entity_id,
                PatientFollowUp.clinic_id == self.clinic_id,
            )
        )
        if followup is None:
            raise OperationRejected("Follow-up not found", retryable=True)

        snapshot = _dump(FollowUpRead.model_validate(followup))
        payload = dict(operation.payload)
        expected = payload.pop("expected_version", operation.base_version)
        self._check_version(followup.version, expected, snapshot)

        if "status" in payload:
            followup.status = payload["status"]
            if payload["status"] == "completed":
                followup.completed_at = datetime.now(UTC)
                followup.completed_by = self.user.id
        if "notes" in payload:
            followup.notes = payload["notes"]
        if "outcome" in payload:
            followup.outcome = payload["outcome"]
        followup.version += 1
        self.db.flush()
        return _dump(FollowUpRead.model_validate(followup)), followup.version
