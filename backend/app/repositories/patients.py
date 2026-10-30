from uuid import UUID, uuid4

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.models import Patient, PatientSearchTerm
from app.schemas.patients import PatientCreate, PatientUpdate


class PatientRepository:
    def __init__(self, db: Session) -> None:
        self.db = db

    def get(self, clinic_id: UUID, patient_id: UUID) -> Patient | None:
        return self.db.scalar(
            select(Patient).where(
                Patient.id == patient_id,
                Patient.clinic_id == clinic_id,
            )
        )

    def get_for_update(self, clinic_id: UUID, patient_id: UUID) -> Patient | None:
        return self.db.scalar(
            select(Patient)
            .where(
                Patient.id == patient_id,
                Patient.clinic_id == clinic_id,
            )
            .with_for_update()
        )

    def list(
        self,
        clinic_id: UUID,
        search: str | None,
        page: int,
        page_size: int,
        search_terms: list[str] | None = None,
    ) -> tuple[list[Patient], int]:
        """
        Lists patients, optionally filtered.

        `search_terms` are keyed hashes of the query's trigrams, computed on
        the device with a key the server does not have. When they are
        supplied the server matches hash against hash and never sees the
        query, which is what lets search survive end-to-end encryption.

        `search` is the legacy plaintext path. It still works while
        dual-write is in effect and records may predate the index, and it is
        what must be removed once the plaintext columns go.
        """
        query = select(Patient).where(Patient.clinic_id == clinic_id)
        count_query = select(func.count()).select_from(Patient).where(
            Patient.clinic_id == clinic_id
        )
        if search_terms:
            # Every trigram of the query must be present on the record, so
            # the matching patient ids are the intersection.
            matching = (
                select(PatientSearchTerm.patient_id)
                .where(
                    PatientSearchTerm.clinic_id == clinic_id,
                    PatientSearchTerm.term.in_(search_terms),
                )
                .group_by(PatientSearchTerm.patient_id)
                .having(
                    func.count(func.distinct(PatientSearchTerm.term))
                    == len(set(search_terms))
                )
            )
            query = query.where(Patient.id.in_(matching))
            count_query = count_query.where(Patient.id.in_(matching))
        elif search:
            term = f"%{search.strip()}%"
            search_filter = or_(
                Patient.full_name.ilike(term),
                Patient.patient_number.ilike(term),
                Patient.village.ilike(term),
            )
            query = query.where(search_filter)
            count_query = count_query.where(search_filter)
        total = self.db.scalar(count_query) or 0
        patients = self.db.scalars(
            query.order_by(Patient.updated_at.desc(), Patient.id)
            .offset((page - 1) * page_size)
            .limit(page_size)
        ).all()
        return list(patients), total

    def create(
        self, clinic_id: UUID, actor_id: UUID, data: PatientCreate
    ) -> Patient:
        patient_id = data.id or uuid4()
        patient = Patient(
            id=patient_id,
            clinic_id=clinic_id,
            patient_number=f"SCX-{patient_id.hex[:10].upper()}",
            created_by=actor_id,
            **data.model_dump(exclude={"id"}),
        )
        self.db.add(patient)
        self.db.flush()
        return patient

    def update(self, patient: Patient, data: PatientUpdate) -> Patient:
        changes = data.model_dump(exclude_unset=True, exclude={"expected_version"})
        if "date_of_birth" in changes and changes["date_of_birth"] is not None:
            changes["estimated_age"] = None
        elif "estimated_age" in changes and changes["estimated_age"] is not None:
            changes["date_of_birth"] = None
        for field, value in changes.items():
            setattr(patient, field, value)
        if changes:
            patient.version += 1
        self.db.flush()
        return patient
