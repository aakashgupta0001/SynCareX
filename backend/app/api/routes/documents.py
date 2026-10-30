import hashlib
from datetime import UTC, datetime
from pathlib import Path
from uuid import UUID

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from fastapi.responses import FileResponse
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.deps import require_permission
from app.core.config import get_settings
from app.database import get_db
from app.models import AuditLog, DocumentRecord, User
from app.schemas.clinical import DocumentPage, DocumentRead

router = APIRouter(prefix="/documents", tags=["documents"])


def _document_or_404(db: Session, clinic_id: UUID, document_id: UUID) -> DocumentRecord:
    document = db.scalar(
        select(DocumentRecord).where(
            DocumentRecord.id == document_id, DocumentRecord.clinic_id == clinic_id
        )
    )
    if document is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Document metadata has not been registered on the server.",
        )
    return document


@router.get("", response_model=DocumentPage)
def list_documents(
    patient_id: UUID,
    user: User = Depends(require_permission("patients.read")),
    db: Session = Depends(get_db),
) -> DocumentPage:
    scope = (
        DocumentRecord.clinic_id == user.clinic_id,
        DocumentRecord.patient_id == patient_id,
    )
    total = db.scalar(select(func.count()).select_from(DocumentRecord).where(*scope)) or 0
    items = db.scalars(
        select(DocumentRecord).where(*scope).order_by(DocumentRecord.created_at.desc())
    ).all()
    return DocumentPage(
        items=[DocumentRead.model_validate(item) for item in items], total=total
    )


@router.post("/{document_id}/content", response_model=DocumentRead)
async def upload_document_content(
    document_id: UUID,
    file: UploadFile = File(...),
    user: User = Depends(require_permission("patients.write")),
    db: Session = Depends(get_db),
) -> DocumentRead:
    """
    Accepts the file bytes for already-registered metadata. The upload is
    idempotent: re-sending identical bytes returns the stored document rather
    than writing a second copy, so a device may safely retry.
    """
    settings = get_settings()
    document = _document_or_404(db, user.clinic_id, document_id)

    body = await file.read(settings.max_document_bytes + 1)
    if len(body) > settings.max_document_bytes:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"Documents must be {settings.max_document_bytes} bytes or smaller.",
        )
    if not body:
        raise HTTPException(
            status_code=422,  # Unprocessable content
            detail="The uploaded file was empty.",
        )
    if document.mime_type not in settings.allowed_document_types:
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail="This document type is not accepted.",
        )
    if len(body) != document.byte_size:
        raise HTTPException(
            status_code=422,  # Unprocessable content
            detail="The uploaded size does not match the registered metadata.",
        )
    checksum = hashlib.sha256(body).hexdigest()
    if checksum != document.checksum:
        raise HTTPException(
            status_code=422,  # Unprocessable content
            detail="The uploaded content failed its checksum check and was not stored.",
        )

    if document.storage_path and document.content_received_at:
        stored = Path(document.storage_path)
        if stored.is_file():
            # Already stored; the device simply retried.
            return DocumentRead.model_validate(document)

    directory = Path(settings.document_storage_dir) / str(user.clinic_id)
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / f"{document.id}.bin"
    target.write_bytes(body)

    document.storage_path = str(target)
    document.content_received_at = datetime.now(UTC)
    db.add(
        AuditLog(
            clinic_id=user.clinic_id,
            actor_id=user.id,
            action="document.content.stored",
            entity_type="document",
            entity_id=document.id,
            details={"byte_size": str(document.byte_size)},
        )
    )
    db.commit()
    db.refresh(document)
    return DocumentRead.model_validate(document)


@router.get("/{document_id}/content")
def download_document_content(
    document_id: UUID,
    user: User = Depends(require_permission("patients.read")),
    db: Session = Depends(get_db),
) -> FileResponse:
    document = _document_or_404(db, user.clinic_id, document_id)
    if not document.storage_path or not Path(document.storage_path).is_file():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="The file content for this document has not been uploaded yet.",
        )
    return FileResponse(
        document.storage_path,
        media_type=document.mime_type,
        filename=document.file_name,
    )
