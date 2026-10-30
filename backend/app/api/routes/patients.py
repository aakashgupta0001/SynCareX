import math
from uuid import UUID

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.orm import Session

from app.api.deps import require_permission
from app.database import get_db
from app.models import User
from app.repositories.patients import PatientRepository
from app.schemas.patients import PatientCreate, PatientPage, PatientRead, PatientUpdate
from app.services.patients import PatientService

router = APIRouter(prefix="/patients", tags=["patients"])


@router.get("", response_model=PatientPage)
def list_patients(
    search: str | None = Query(default=None, max_length=120),
    # Keyed hashes of the query's trigrams, computed on the device. Supplying
    # these lets the server answer a search without receiving the query.
    search_terms: list[str] | None = Query(default=None, max_length=64),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
    user: User = Depends(require_permission("patients.read")),
    db: Session = Depends(get_db),
) -> PatientPage:
    items, total = PatientRepository(db).list(
        user.clinic_id, search, page, page_size, search_terms
    )
    return PatientPage(
        items=items,
        page=page,
        page_size=page_size,
        total=total,
        pages=math.ceil(total / page_size),
    )


@router.post("", response_model=PatientRead, status_code=status.HTTP_201_CREATED)
def create_patient(
    data: PatientCreate,
    user: User = Depends(require_permission("patients.write")),
    db: Session = Depends(get_db),
) -> PatientRead:
    return PatientRead.model_validate(
        PatientService(db).create(user.clinic_id, user.id, data)
    )


@router.get("/{patient_id}", response_model=PatientRead)
def get_patient(
    patient_id: UUID,
    user: User = Depends(require_permission("patients.read")),
    db: Session = Depends(get_db),
) -> PatientRead:
    return PatientRead.model_validate(PatientService(db).get(user.clinic_id, patient_id))


@router.patch("/{patient_id}", response_model=PatientRead)
def update_patient(
    patient_id: UUID,
    data: PatientUpdate,
    user: User = Depends(require_permission("patients.write")),
    db: Session = Depends(get_db),
) -> PatientRead:
    return PatientRead.model_validate(
        PatientService(db).update(user.clinic_id, user.id, patient_id, data)
    )
