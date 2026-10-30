from uuid import UUID

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models import Clinic, Patient
from app.repositories.patients import PatientRepository
from app.schemas.patients import PatientCreate, PatientUpdate
from app.services.audit_chain import append_audit_entry


class PatientService:
    def __init__(self, db: Session) -> None:
        self.db = db
        self.repository = PatientRepository(db)

    def get(self, clinic_id: UUID, patient_id: UUID) -> Patient:
        patient = self.repository.get(clinic_id, patient_id)
        if patient is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Patient not found")
        return patient

    def create(self, clinic_id: UUID, actor_id: UUID, data: PatientCreate) -> Patient:
        if data.id is not None:
            existing = self.repository.get(clinic_id, data.id)
            if existing is not None:
                self._verify_create_replay(existing, actor_id, data)
                return existing

        patient = self.repository.create(clinic_id, actor_id, data)
        append_audit_entry(
            self.db,
            clinic_id=clinic_id,
            actor_id=actor_id,
            action="patient.create",
            entity_type="patient",
            entity_id=patient.id,
        )
        try:
            self.db.commit()
        except IntegrityError:
            self.db.rollback()
            if data.id is not None:
                existing = self.repository.get(clinic_id, data.id)
                if existing is not None:
                    self._verify_create_replay(existing, actor_id, data)
                    return existing
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Patient identifier already exists in this clinic.",
            ) from None
        self.db.refresh(patient)
        return patient

    @staticmethod
    def _verify_create_replay(
        existing: Patient, actor_id: UUID, data: PatientCreate
    ) -> None:
        replay_matches = existing.created_by == actor_id and all(
            getattr(existing, field) == value
            for field, value in data.model_dump(exclude={"id"}).items()
        )
        if not replay_matches:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Patient ID already exists with different content.",
            )

    def update(
        self, clinic_id: UUID, actor_id: UUID, patient_id: UUID, data: PatientUpdate
    ) -> Patient:
        self.db.scalar(
            select(Clinic.id).where(Clinic.id == clinic_id).with_for_update()
        )
        patient = self.repository.get_for_update(clinic_id, patient_id)
        if patient is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="Patient not found"
            )
        if data.expected_version is not None and data.expected_version != patient.version:
            requested_changes = data.model_dump(
                exclude_unset=True, exclude={"expected_version"}
            )
            replay_matches = (
                patient.version == data.expected_version + 1
                and bool(requested_changes)
                and all(getattr(patient, key) == value for key, value in requested_changes.items())
            )
            if replay_matches:
                return patient
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={
                    "message": "Patient version changed; review both versions before retrying.",
                    "current_version": patient.version,
                },
            )
        updated = self.repository.update(patient, data)
        changed_fields = data.model_fields_set - {"expected_version"}
        if changed_fields:
            append_audit_entry(
                self.db,
                clinic_id=clinic_id,
                actor_id=actor_id,
                action="patient.update",
                entity_type="patient",
                entity_id=patient.id,
                details={"changed_fields": ",".join(sorted(changed_fields))},
            )
        self.db.commit()
        self.db.refresh(updated)
        return updated
