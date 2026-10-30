from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.deps import require_permission
from app.database import get_db
from app.models import ClinicalNote, Consultation, Patient, User
from app.schemas.clinical import (
    ClinicalNotePage,
    ClinicalNoteRead,
    ConsultationPage,
    ConsultationRead,
)

router = APIRouter(tags=["clinical"])


def _require_patient(db: Session, clinic_id: UUID, patient_id: UUID) -> Patient:
    patient = db.scalar(
        select(Patient).where(Patient.id == patient_id, Patient.clinic_id == clinic_id)
    )
    if patient is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Patient not found"
        )
    return patient


@router.get("/consultations", response_model=ConsultationPage)
def list_consultations(
    patient_id: UUID,
    user: User = Depends(require_permission("patients.read")),
    db: Session = Depends(get_db),
) -> ConsultationPage:
    _require_patient(db, user.clinic_id, patient_id)
    scope = (
        Consultation.clinic_id == user.clinic_id,
        Consultation.patient_id == patient_id,
    )
    total = db.scalar(select(func.count()).select_from(Consultation).where(*scope)) or 0
    items = db.scalars(
        select(Consultation).where(*scope).order_by(Consultation.occurred_at.desc())
    ).all()
    return ConsultationPage(
        items=[ConsultationRead.model_validate(item) for item in items], total=total
    )


@router.get("/consultations/{consultation_id}/notes", response_model=ClinicalNotePage)
def list_clinical_notes(
    consultation_id: UUID,
    user: User = Depends(require_permission("patients.read")),
    db: Session = Depends(get_db),
) -> ClinicalNotePage:
    consultation = db.scalar(
        select(Consultation).where(
            Consultation.id == consultation_id,
            Consultation.clinic_id == user.clinic_id,
        )
    )
    if consultation is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Consultation not found"
        )
    scope = (
        ClinicalNote.clinic_id == user.clinic_id,
        ClinicalNote.consultation_id == consultation_id,
    )
    total = db.scalar(select(func.count()).select_from(ClinicalNote).where(*scope)) or 0
    items = db.scalars(
        select(ClinicalNote).where(*scope).order_by(ClinicalNote.created_at)
    ).all()
    return ClinicalNotePage(
        items=[ClinicalNoteRead.model_validate(item) for item in items], total=total
    )
