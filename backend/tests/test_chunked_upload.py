"""Chunked, resumable document uploads.

Covers the /documents/chunks round trip: init registers a session, parts are
stored and verified individually, completion concatenates and verifies the
total checksum, and an interrupted upload resumes from the parts that
already arrived instead of restarting from byte zero.
"""

import hashlib
from uuid import uuid4

import pytest

PASSWORD = "synthetic-test-password"
CHUNK_SIZE = 4
CONTENT = b"%PDF-1.4 synthetic chunked upload"


def login(client, email="doctor@example.com"):
    response = client.post(
        "/api/v1/auth/login", json={"email": email, "password": PASSWORD}
    )
    assert response.status_code == 200, response.text
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


@pytest.fixture
def headers(api_client):
    return login(api_client["client"])


@pytest.fixture
def patient_id(api_client):
    """A patient in the signed-in clinic, created directly in the database."""
    from app.models import Patient

    session_factory = api_client["session_factory"]
    with session_factory.begin() as db:
        patient = Patient(
            clinic_id=api_client["clinic_id"],
            patient_number=f"SCX-{uuid4().hex[:8].upper()}",
            full_name="Chunked Upload Patient",
            estimated_age=30,
            allergies=[],
            created_by=api_client["user_id"],
        )
        db.add(patient)
        db.flush()
        return patient.id


def _register_document(api_client, patient_id: str, content: bytes) -> str:
    """Registers document metadata directly, the way the sync path does."""
    from app.models import DocumentRecord

    session_factory = api_client["session_factory"]
    with session_factory.begin() as db:
        document = DocumentRecord(
            clinic_id=api_client["clinic_id"],
            patient_id=patient_id,
            file_name="scan.pdf",
            mime_type="application/pdf",
            byte_size=len(content),
            checksum=hashlib.sha256(content).hexdigest(),
            uploaded_by=api_client["user_id"],
        )
        db.add(document)
        db.flush()
        return str(document.id)


def _init(client, headers, patient_id, content, chunk_size=CHUNK_SIZE, **overrides):
    payload = {
        "patient_id": str(patient_id),
        "file_name": "scan.pdf",
        "content_type": "application/pdf",
        "byte_size": len(content),
        "total_checksum": hashlib.sha256(content).hexdigest(),
        "chunk_size": chunk_size,
        "description": "Chunked test scan",
    }
    payload.update(overrides)
    return client.post("/api/v1/documents/chunks/init", json=payload, headers=headers)


def _part_headers(content: bytes, index: int, chunk_size: int) -> dict[str, str]:
    start = index * chunk_size
    part = content[start : start + chunk_size]
    return {
        "X-Chunk-Checksum": hashlib.sha256(part).hexdigest(),
        "Content-Type": "application/octet-stream",
    }


def _upload_part(client, headers, upload_id, index, content, chunk_size=CHUNK_SIZE):
    start = index * chunk_size
    part = content[start : start + chunk_size]
    return client.put(
        f"/api/v1/documents/chunks/{upload_id}/{index}",
        content=part,
        headers={**headers, **_part_headers(content, index, chunk_size)},
    )


def _stored_chunks(content: bytes, chunk_size: int) -> int:
    return -(-len(content) // chunk_size)


def test_chunked_round_trip_matches_single_shot(api_client, headers, patient_id) -> None:
    client = api_client["client"]
    content = CONTENT

    # The single-shot reference: same bytes through the existing endpoint.
    reference_id = _register_document(api_client, patient_id, content)
    reference = client.post(
        f"/api/v1/documents/{reference_id}/content",
        files={"file": ("scan.pdf", content, "application/pdf")},
        headers=headers,
    )
    assert reference.status_code == 200, reference.text

    document_id = _register_document(api_client, patient_id, content)
    init = _init(client, headers, patient_id, content, document_id=document_id)
    assert init.status_code == 200, init.text
    body = init.json()
    upload_id = body["upload_id"]
    assert body["chunk_size"] == CHUNK_SIZE
    assert body["total_chunks"] == _stored_chunks(content, CHUNK_SIZE)

    total = body["total_chunks"]
    for index in range(total):
        part = _upload_part(client, headers, upload_id, index, content)
        assert part.status_code == 200, part.text
        missing = part.json()["missing_indexes"]
        assert missing == list(range(index + 1, total))

    completed = client.post(
        f"/api/v1/documents/chunks/{upload_id}/complete", headers=headers
    )
    assert completed.status_code == 200, completed.text
    finalized = completed.json()
    assert finalized["id"] == document_id
    assert finalized["checksum"] == hashlib.sha256(content).hexdigest()
    assert finalized["content_received_at"] is not None

    download = client.get(
        f"/api/v1/documents/{document_id}/content", headers=headers
    )
    assert download.status_code == 200
    assert download.content == content

    # The on-disk result is byte-identical to the single-shot path.
    single_shot_bytes = client.get(
        f"/api/v1/documents/{reference_id}/content", headers=headers
    ).content
    assert hashlib.sha256(single_shot_bytes).hexdigest() == hashlib.sha256(
        download.content
    ).hexdigest()

    listing = client.get(
        f"/api/v1/documents?patient_id={patient_id}", headers=headers
    )
    assert listing.status_code == 200
    assert listing.json()["total"] == 2


def test_upload_without_registered_metadata_creates_the_document(
    api_client, headers, patient_id
) -> None:
    client = api_client["client"]
    content = b"ABCD" * 3  # 12 bytes, chunk size 4 -> 3 parts

    init = _init(client, headers, patient_id, content)
    assert init.status_code == 200, init.text
    upload_id = init.json()["upload_id"]

    total = init.json()["total_chunks"]
    for index in range(total):
        assert _upload_part(client, headers, upload_id, index, content).status_code == 200

    completed = client.post(
        f"/api/v1/documents/chunks/{upload_id}/complete", headers=headers
    )
    assert completed.status_code == 200, completed.text
    finalized = completed.json()
    assert finalized["id"] != upload_id
    assert finalized["file_name"] == "scan.pdf"
    assert finalized["byte_size"] == len(content)

    download = client.get(
        f"/api/v1/documents/{finalized['id']}/content", headers=headers
    )
    assert download.content == content


def test_corrupted_part_is_rejected_and_reported_missing(
    api_client, headers, patient_id
) -> None:
    client = api_client["client"]
    content = CONTENT
    init = _init(client, headers, patient_id, content)
    upload_id = init.json()["upload_id"]

    # Right length, wrong bytes: the per-chunk checksum must catch it.
    tampered = b"XXXX"
    response = client.put(
        f"/api/v1/documents/chunks/{upload_id}/0",
        content=tampered,
        headers={
            **headers,
            "X-Chunk-Checksum": hashlib.sha256(content[:CHUNK_SIZE]).hexdigest(),
            "Content-Type": "application/octet-stream",
        },
    )
    assert response.status_code == 422
    assert "checksum" in response.json()["detail"].lower()

    status = client.get(f"/api/v1/documents/chunks/{upload_id}", headers=headers)
    assert status.status_code == 200
    assert status.json()["received_indexes"] == []
    assert status.json()["missing_indexes"] == list(
        range(_stored_chunks(content, CHUNK_SIZE))
    )


def test_complete_with_missing_part_is_refused(api_client, headers, patient_id) -> None:
    client = api_client["client"]
    content = CONTENT
    init = _init(client, headers, patient_id, content)
    upload_id = init.json()["upload_id"]
    total = _stored_chunks(content, CHUNK_SIZE)

    assert _upload_part(client, headers, upload_id, 0, content).status_code == 200

    response = client.post(
        f"/api/v1/documents/chunks/{upload_id}/complete", headers=headers
    )
    assert response.status_code == 409
    detail = response.json()["detail"]
    assert detail["missing_indexes"] == list(range(1, total))


def test_interrupted_upload_resumes_without_restarting(
    api_client, headers, patient_id
) -> None:
    client = api_client["client"]
    content = CONTENT
    total = _stored_chunks(content, CHUNK_SIZE)
    init = _init(client, headers, patient_id, content)
    upload_id = init.json()["upload_id"]

    # Parts 0 and 2 arrive; the connection drops before part 1.
    assert _upload_part(client, headers, upload_id, 0, content).status_code == 200
    assert _upload_part(client, headers, upload_id, 2, content).status_code == 200

    status = client.get(f"/api/v1/documents/chunks/{upload_id}", headers=headers)
    assert status.status_code == 200
    assert status.json()["received_indexes"] == [0, 2]
    assert status.json()["missing_indexes"] == [1, *range(3, total)]

    resumed = _upload_part(client, headers, upload_id, 1, content)
    assert resumed.status_code == 200

    # The remaining parts from the original attempt are still missing; the
    # resume only sent part 1, never 0 or 2 again.
    still_missing = client.get(
        f"/api/v1/documents/chunks/{upload_id}", headers=headers
    ).json()["missing_indexes"]
    assert still_missing == list(range(3, total))
    for index in still_missing:
        assert _upload_part(client, headers, upload_id, index, content).status_code == 200

    completed = client.post(
        f"/api/v1/documents/chunks/{upload_id}/complete", headers=headers
    )
    assert completed.status_code == 200, completed.text
    download = client.get(
        f"/api/v1/documents/{completed.json()['id']}/content", headers=headers
    )
    assert download.content == content


def test_reput_of_a_correct_part_is_idempotent(api_client, headers, patient_id) -> None:
    client = api_client["client"]
    content = CONTENT
    init = _init(client, headers, patient_id, content)
    upload_id = init.json()["upload_id"]

    first = _upload_part(client, headers, upload_id, 1, content)
    assert first.status_code == 200
    second = _upload_part(client, headers, upload_id, 1, content)
    assert second.status_code == 200
    assert second.json()["index"] == 1
    assert second.json()["received"] is True

    status = client.get(f"/api/v1/documents/chunks/{upload_id}", headers=headers)
    assert status.json()["received_indexes"] == [1]


def test_wrong_length_part_is_rejected(api_client, headers, patient_id) -> None:
    client = api_client["client"]
    content = CONTENT
    init = _init(client, headers, patient_id, content)
    upload_id = init.json()["upload_id"]

    part = content[: CHUNK_SIZE - 1]
    response = client.put(
        f"/api/v1/documents/chunks/{upload_id}/0",
        content=part,
        headers={
            **headers,
            "X-Chunk-Checksum": hashlib.sha256(part).hexdigest(),
            "Content-Type": "application/octet-stream",
        },
    )
    assert response.status_code == 422
    assert "bytes" in response.json()["detail"]


def test_complete_verifies_the_total_checksum(api_client, headers, patient_id) -> None:
    from app.core.config import get_settings

    client = api_client["client"]
    content = CONTENT
    init = _init(client, headers, patient_id, content)
    upload_id = init.json()["upload_id"]
    total = _stored_chunks(content, CHUNK_SIZE)
    for index in range(total):
        assert _upload_part(client, headers, upload_id, index, content).status_code == 200

    # Corrupt a stored part behind the API's back, as a flipped bit on disk
    # would: every part is present, so only the total checksum catches it.
    parts_dir = (
        get_settings().document_storage_dir / "chunks" / str(upload_id)
    )
    part_files = sorted(parts_dir.glob("*.part"))
    assert len(part_files) == total
    part_files[1].write_bytes(b"XXXX")

    response = client.post(
        f"/api/v1/documents/chunks/{upload_id}/complete", headers=headers
    )
    assert response.status_code == 422
    assert "checksum" in response.json()["detail"].lower()


def test_upload_id_is_scoped_to_the_callers_clinic(
    api_client, headers, patient_id
) -> None:
    client = api_client["client"]
    content = b"ABCD"
    init = _init(client, headers, patient_id, content)
    assert init.status_code == 200, init.text
    upload_id = init.json()["upload_id"]

    other_headers = login(client, "other@example.com")
    assert (
        client.get(
            f"/api/v1/documents/chunks/{upload_id}", headers=other_headers
        ).status_code
        == 404
    )
    assert (
        client.put(
            f"/api/v1/documents/chunks/{upload_id}/0",
            content=content,
            headers={
                **other_headers,
                "X-Chunk-Checksum": hashlib.sha256(content).hexdigest(),
                "Content-Type": "application/octet-stream",
            },
        ).status_code
        == 404
    )
    assert (
        client.post(
            f"/api/v1/documents/chunks/{upload_id}/complete", headers=other_headers
        ).status_code
        == 404
    )


def test_init_enforces_the_max_document_size(api_client, headers, patient_id) -> None:
    from app.core.config import get_settings

    client = api_client["client"]
    too_big = get_settings().max_document_bytes + 1
    response = _init(
        client,
        headers,
        patient_id,
        b"x" * 16,
        byte_size=too_big,
        total_checksum="a" * 64,
    )
    assert response.status_code == 413


def test_init_rejects_unsupported_document_types(
    api_client, headers, patient_id
) -> None:
    client = api_client["client"]
    response = _init(
        client,
        headers,
        patient_id,
        b"ABCD",
        content_type="application/x-msdownload",
    )
    assert response.status_code == 415


def test_init_rejects_mismatched_registered_metadata(
    api_client, headers, patient_id
) -> None:
    client = api_client["client"]
    content = CONTENT
    document_id = _register_document(api_client, patient_id, content)

    other = b"different bytes entirely"
    response = _init(
        client, headers, patient_id, other, chunk_size=8, document_id=document_id
    )
    assert response.status_code == 422


def test_completed_upload_rejects_new_parts_and_is_idempotent(
    api_client, headers, patient_id
) -> None:
    client = api_client["client"]
    content = CONTENT
    document_id = _register_document(api_client, patient_id, content)
    init = _init(client, headers, patient_id, content, document_id=document_id)
    upload_id = init.json()["upload_id"]
    total = _stored_chunks(content, CHUNK_SIZE)
    for index in range(total):
        assert _upload_part(client, headers, upload_id, index, content).status_code == 200

    first = client.post(
        f"/api/v1/documents/chunks/{upload_id}/complete", headers=headers
    )
    assert first.status_code == 200
    second = client.post(
        f"/api/v1/documents/chunks/{upload_id}/complete", headers=headers
    )
    assert second.status_code == 200
    assert second.json()["id"] == document_id

    late_part = _upload_part(client, headers, upload_id, 0, content)
    assert late_part.status_code == 409
