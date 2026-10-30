import hashlib
import math
import shutil
from datetime import UTC, datetime
from pathlib import Path
from uuid import UUID

from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile, status
from fastapi.responses import FileResponse
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.deps import require_permission
from app.core.config import get_settings
from app.database import get_db
from app.models import DocumentRecord, DocumentUploadSession, Patient, User
from app.schemas.clinical import (
    ChunkedPartRead,
    ChunkedUploadInit,
    ChunkedUploadInitRead,
    ChunkedUploadStatusRead,
    DocumentPage,
    DocumentRead,
)
from app.services.audit_chain import append_audit_entry

router = APIRouter(prefix="/documents", tags=["documents"])

CHUNK_PART_SUFFIX = ".part"


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


def _upload_session_or_404(
    db: Session, clinic_id: UUID, upload_id: UUID
) -> DocumentUploadSession:
    session = db.scalar(
        select(DocumentUploadSession).where(
            DocumentUploadSession.id == upload_id,
            DocumentUploadSession.clinic_id == clinic_id,
        )
    )
    if session is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="This upload session does not exist for your clinic.",
        )
    return session


def _total_chunks(byte_size: int, chunk_size: int) -> int:
    return max(1, math.ceil(byte_size / chunk_size))


def _parts_directory(upload_id: UUID) -> Path:
    return Path(get_settings().document_storage_dir) / "chunks" / str(upload_id)


def _present_indexes(upload_id: UUID, total_chunks: int) -> list[int]:
    directory = _parts_directory(upload_id)
    if not directory.is_dir():
        return []
    received: set[int] = set()
    for part in directory.glob(f"*{CHUNK_PART_SUFFIX}"):
        try:
            index = int(part.name[: -len(CHUNK_PART_SUFFIX)])
        except ValueError:
            continue
        if 0 <= index < total_chunks:
            received.add(index)
    return sorted(received)


def _missing_indexes(upload_id: UUID, total_chunks: int) -> list[int]:
    received = set(_present_indexes(upload_id, total_chunks))
    return [index for index in range(total_chunks) if index not in received]


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
    append_audit_entry(
        db,
        clinic_id=user.clinic_id,
        actor_id=user.id,
        action="document.content.stored",
        entity_type="document",
        entity_id=document.id,
        details={"byte_size": str(document.byte_size)},
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


@router.post("/chunks/init", response_model=ChunkedUploadInitRead)
def init_chunked_upload(
    payload: ChunkedUploadInit,
    user: User = Depends(require_permission("patients.write")),
    db: Session = Depends(get_db),
) -> ChunkedUploadInitRead:
    """
    Registers a chunked upload session for a large file. The same size and
    type limits as the single-shot endpoint are enforced up front, so the
    device learns about a rejection before spending bandwidth on parts.
    """
    settings = get_settings()
    if payload.content_type not in settings.allowed_document_types:
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail="This document type is not accepted.",
        )
    if payload.byte_size > settings.max_document_bytes:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"Documents must be {settings.max_document_bytes} bytes or smaller.",
        )
    if payload.chunk_size > settings.max_document_bytes:
        raise HTTPException(
            status_code=422,  # Unprocessable content
            detail="The chunk size cannot exceed the maximum document size.",
        )
    total_chunks = _total_chunks(payload.byte_size, payload.chunk_size)

    document: DocumentRecord | None = None
    if payload.document_id is not None:
        document = _document_or_404(db, user.clinic_id, payload.document_id)
        if document.storage_path and document.content_received_at:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="The file content for this document has already been stored.",
            )
        if (
            document.patient_id != payload.patient_id
            or document.byte_size != payload.byte_size
            or document.checksum != payload.total_checksum
            or document.mime_type != payload.content_type
        ):
            raise HTTPException(
                status_code=422,  # Unprocessable content
                detail="The upload does not match the registered document metadata.",
            )
    else:
        patient = db.scalar(
            select(Patient).where(
                Patient.id == payload.patient_id, Patient.clinic_id == user.clinic_id
            )
        )
        if patient is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="The patient for this upload has not been registered on the server.",
            )

    session = DocumentUploadSession(
        clinic_id=user.clinic_id,
        patient_id=payload.patient_id,
        document_id=payload.document_id,
        consultation_id=payload.consultation_id,
        uploaded_by=user.id,
        file_name=payload.file_name,
        mime_type=payload.content_type,
        byte_size=payload.byte_size,
        total_checksum=payload.total_checksum,
        chunk_size=payload.chunk_size,
        description=payload.description,
    )
    db.add(session)
    db.commit()
    db.refresh(session)
    return ChunkedUploadInitRead(
        upload_id=session.id,
        chunk_size=session.chunk_size,
        total_chunks=total_chunks,
    )


@router.put("/chunks/{upload_id}/{index}", response_model=ChunkedPartRead)
async def upload_document_chunk(
    upload_id: UUID,
    index: int,
    request: Request,
    user: User = Depends(require_permission("patients.write")),
    db: Session = Depends(get_db),
) -> ChunkedPartRead:
    """
    Stores one part of a chunked upload. The part's SHA-256 must match the
    ``X-Chunk-Checksum`` header, and re-sending an identical part is
    idempotent. The response reports which parts are still missing.
    """
    session = _upload_session_or_404(db, user.clinic_id, upload_id)

    if session.document_id is not None:
        document = db.get(DocumentRecord, session.document_id)
        if document and document.storage_path and document.content_received_at:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="This upload has already been completed.",
            )

    total_chunks = _total_chunks(session.byte_size, session.chunk_size)
    if index < 0 or index >= total_chunks:
        raise HTTPException(
            status_code=422,  # Unprocessable content
            detail=f"Chunk index must be between 0 and {total_chunks - 1}.",
        )
    expected_length = (
        session.chunk_size
        if index < total_chunks - 1
        else session.byte_size - session.chunk_size * (total_chunks - 1)
    )
    body = await request.body()
    if len(body) != expected_length:
        raise HTTPException(
            status_code=422,  # Unprocessable content
            detail=(
                f"Chunk {index} must be {expected_length} bytes; "
                f"{len(body)} bytes were received."
            ),
        )
    expected_checksum = request.headers.get("X-Chunk-Checksum")
    if not expected_checksum:
        raise HTTPException(
            status_code=422,  # Unprocessable content
            detail="The X-Chunk-Checksum header is required for every chunk.",
        )
    actual_checksum = hashlib.sha256(body).hexdigest()
    if actual_checksum != expected_checksum.lower():
        raise HTTPException(
            status_code=422,  # Unprocessable content
            detail="The chunk failed its checksum check and was not stored.",
        )

    directory = _parts_directory(upload_id)
    directory.mkdir(parents=True, exist_ok=True)
    part = directory / f"{index:010d}{CHUNK_PART_SUFFIX}"
    if not (
        part.is_file()
        and hashlib.sha256(part.read_bytes()).hexdigest() == actual_checksum
    ):
        # An identical part may already be on disk from a retried request.
        part.write_bytes(body)

    return ChunkedPartRead(
        index=index,
        received=True,
        missing_indexes=_missing_indexes(upload_id, total_chunks),
    )


@router.get("/chunks/{upload_id}", response_model=ChunkedUploadStatusRead)
def chunked_upload_status(
    upload_id: UUID,
    user: User = Depends(require_permission("patients.write")),
    db: Session = Depends(get_db),
) -> ChunkedUploadStatusRead:
    """
    Reports which parts of a chunked upload have arrived. Part presence is
    read from disk, so resume works after an application restart.
    """
    session = _upload_session_or_404(db, user.clinic_id, upload_id)
    total_chunks = _total_chunks(session.byte_size, session.chunk_size)
    return ChunkedUploadStatusRead(
        upload_id=session.id,
        chunk_size=session.chunk_size,
        byte_size=session.byte_size,
        total_chunks=total_chunks,
        received_indexes=_present_indexes(upload_id, total_chunks),
        missing_indexes=_missing_indexes(upload_id, total_chunks),
    )


@router.post("/chunks/{upload_id}/complete", response_model=DocumentRead)
def complete_chunked_upload(
    upload_id: UUID,
    user: User = Depends(require_permission("patients.write")),
    db: Session = Depends(get_db),
) -> DocumentRead:
    """
    Concatenates the stored parts, verifies the total checksum, and
    finalizes the same DocumentRecord the single-shot endpoint returns.
    """
    settings = get_settings()
    session = _upload_session_or_404(db, user.clinic_id, upload_id)

    document: DocumentRecord | None = None
    if session.document_id is not None:
        document = db.get(DocumentRecord, session.document_id)
        if document and document.storage_path and document.content_received_at:
            # A retried completion after success simply reports the document.
            return DocumentRead.model_validate(document)

    total_chunks = _total_chunks(session.byte_size, session.chunk_size)
    missing = _missing_indexes(upload_id, total_chunks)
    if missing:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "message": "The upload is incomplete; these chunks are missing.",
                "missing_indexes": missing,
            },
        )

    payload = b"".join(
        part.read_bytes()
        for part in sorted(_parts_directory(upload_id).glob(f"*{CHUNK_PART_SUFFIX}"))
    )
    if len(payload) != session.byte_size:
        raise HTTPException(
            status_code=422,  # Unprocessable content
            detail="The assembled document does not match its registered size.",
        )
    if hashlib.sha256(payload).hexdigest() != session.total_checksum:
        raise HTTPException(
            status_code=422,  # Unprocessable content
            detail="The assembled document failed its checksum check and was not stored.",
        )

    if document is None:
        document = DocumentRecord(
            clinic_id=user.clinic_id,
            patient_id=session.patient_id,
            consultation_id=session.consultation_id,
            file_name=session.file_name,
            mime_type=session.mime_type,
            byte_size=session.byte_size,
            checksum=session.total_checksum,
            description=session.description,
            uploaded_by=session.uploaded_by,
        )
        db.add(document)
        db.flush()

    directory = Path(settings.document_storage_dir) / str(user.clinic_id)
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / f"{document.id}.bin"
    target.write_bytes(payload)

    document.storage_path = str(target)
    document.content_received_at = datetime.now(UTC)
    session.document_id = document.id
    append_audit_entry(
        db,
        clinic_id=user.clinic_id,
        actor_id=user.id,
        action="document.content.stored",
        entity_type="document",
        entity_id=document.id,
        details={"byte_size": str(document.byte_size), "upload": "chunked"},
    )
    shutil.rmtree(_parts_directory(upload_id), ignore_errors=True)
    db.commit()
    db.refresh(document)
    return DocumentRead.model_validate(document)
