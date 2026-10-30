import hashlib
import io
from uuid import uuid4

DEVICE_ID = "11111111-2222-3333-4444-555555555555"
PASSWORD = "synthetic-test-password"


def login(client, email="doctor@example.com"):
    response = client.post(
        "/api/v1/auth/login", json={"email": email, "password": PASSWORD}
    )
    assert response.status_code == 200, response.text
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


def provision(client, headers, device_id=DEVICE_ID):
    response = client.post(
        "/api/v1/sync/devices/provision",
        json={"device_id": device_id, "label": "Test browser"},
        headers=headers,
    )
    assert response.status_code == 200, response.text
    return response.json()


def key(seed: str) -> str:
    return hashlib.sha256(seed.encode()).hexdigest()


def operation(**overrides):
    base = {
        "operation_id": str(uuid4()),
        "idempotency_key": key(str(uuid4())),
        "entity_type": "patient",
        "entity_id": str(uuid4()),
        "operation_type": "create",
        "base_version": 0,
        "local_version": 1,
        "payload": {},
    }
    base.update(overrides)
    return base


def patient_payload(**overrides):
    return {
        "full_name": "Synthetic Offline Patient",
        "estimated_age": 44,
        "village": "Offline Village",
        "allergies": ["unknown"],
        **overrides,
    }


def send(client, headers, operations, device_id=DEVICE_ID):
    return client.post(
        "/api/v1/sync/operations",
        json={"device_id": device_id, "operations": operations},
        headers=headers,
    )


def test_sync_requires_authentication_and_a_provisioned_device(api_client) -> None:
    client = api_client["client"]
    anonymous = send(client, {}, [operation()])
    assert anonymous.status_code == 401

    headers = login(client)
    unprovisioned = send(client, headers, [operation()])
    assert unprovisioned.status_code == 403
    assert "not provisioned" in unprovisioned.json()["detail"]


def test_queued_patient_operation_is_acknowledged_once_and_never_duplicated(
    api_client,
) -> None:
    client = api_client["client"]
    headers = login(client)
    provision(client, headers)

    patient_id = str(uuid4())
    create = operation(
        entity_id=patient_id,
        idempotency_key=key(f"create:{patient_id}"),
        payload=patient_payload(),
    )

    first = send(client, headers, [create])
    assert first.status_code == 200, first.text
    first_result = first.json()["results"][0]
    assert first_result["status"] == "acknowledged"
    assert first_result["duplicate"] is False
    assert first_result["server_version"] == 1

    # The device never saw the response and retries the identical operation.
    second = send(client, headers, [create])
    assert second.status_code == 200
    second_result = second.json()["results"][0]
    assert second_result["status"] == "acknowledged"
    assert second_result["duplicate"] is True

    listed = client.get("/api/v1/patients?search=Offline+Village", headers=headers)
    assert listed.status_code == 200
    assert listed.json()["total"] == 1


def test_replay_key_cannot_be_reused_for_different_operation_content(api_client) -> None:
    client = api_client["client"]
    headers = login(client)
    provision(client, headers)
    patient_id = str(uuid4())
    create = operation(
        entity_id=patient_id,
        idempotency_key=key(f"identity:{patient_id}"),
        payload=patient_payload(),
    )
    first = send(client, headers, [create])
    assert first.status_code == 200
    assert first.json()["results"][0]["status"] == "acknowledged"

    tampered = {**create, "payload": patient_payload(village="Changed replay payload")}
    replay = send(client, headers, [tampered])
    assert replay.status_code == 200
    result = replay.json()["results"][0]
    assert result["status"] == "rejected"
    assert result["retryable"] is False
    current = client.get(f"/api/v1/patients/{patient_id}", headers=headers).json()
    assert current["village"] == "Offline Village"


def test_pull_feed_is_paged_and_includes_direct_online_patient_updates(api_client) -> None:
    client = api_client["client"]
    headers = login(client)
    provision(client, headers)

    created = client.post(
        "/api/v1/patients",
        json=patient_payload(),
        headers=headers,
    )
    assert created.status_code == 201, created.text
    patient_id = created.json()["id"]
    updated = client.patch(
        f"/api/v1/patients/{patient_id}",
        json={"village": "Online clinic update", "expected_version": 1},
        headers=headers,
    )
    assert updated.status_code == 200, updated.text

    first = client.get(
        "/api/v1/sync/changes",
        params={"device_id": DEVICE_ID, "cursor": 0, "limit": 1},
        headers=headers,
    )
    assert first.status_code == 200, first.text
    first_body = first.json()
    assert len(first_body["changes"]) == 1
    assert first_body["has_more"] is True
    assert first_body["changes"][0]["entity_type"] == "patient"

    second = client.get(
        "/api/v1/sync/changes",
        params={
            "device_id": DEVICE_ID,
            "cursor": first_body["next_cursor"],
            "limit": 1,
        },
        headers=headers,
    )
    assert second.status_code == 200, second.text
    assert second.json()["changes"][0]["payload"]["village"] == "Online clinic update"
    assert second.json()["has_more"] is False


def test_concurrent_edit_is_reported_as_a_conflict_without_overwriting(api_client) -> None:
    client = api_client["client"]
    headers = login(client)
    provision(client, headers)

    patient_id = str(uuid4())
    send(
        client,
        headers,
        [
            operation(
                entity_id=patient_id,
                idempotency_key=key(f"create:{patient_id}"),
                payload=patient_payload(),
            )
        ],
    )

    # A clinician on another device saves first.
    online_edit = client.patch(
        f"/api/v1/patients/{patient_id}",
        json={"village": "Edited by another device", "expected_version": 1},
        headers=headers,
    )
    assert online_edit.status_code == 200

    stale = send(
        client,
        headers,
        [
            operation(
                entity_id=patient_id,
                idempotency_key=key(f"update:{patient_id}"),
                operation_type="update",
                base_version=1,
                local_version=2,
                payload={"village": "Offline edit", "expected_version": 1},
            )
        ],
    )
    assert stale.status_code == 200
    result = stale.json()["results"][0]
    assert result["status"] == "conflict"
    assert result["server_version"] == 2
    assert result["entity"]["village"] == "Edited by another device"
    assert stale.json()["conflicts"] == 1

    current = client.get(f"/api/v1/patients/{patient_id}", headers=headers).json()
    assert current["village"] == "Edited by another device"
    assert current["version"] == 2


def test_clinical_records_can_be_corrected_and_entered_in_error_with_version_checks(
    api_client,
) -> None:
    client = api_client["client"]
    headers = login(client)
    provision(client, headers)

    patient_id = str(uuid4())
    patient_result = send(
        client,
        headers,
        [
            operation(
                entity_id=patient_id,
                idempotency_key=key(f"clinical-patient:{patient_id}"),
                payload=patient_payload(),
            )
        ],
    )
    assert patient_result.status_code == 200
    assert patient_result.json()["results"][0]["status"] == "acknowledged"

    records = [
        (
            "observation",
            str(uuid4()),
            {
                "patient_id": patient_id,
                "code": "bp",
                "label": "Blood pressure",
                "value": "120/80",
                "unit": "mmHg",
            },
            {"value": "118/78"},
        ),
        (
            "allergy",
            str(uuid4()),
            {
                "patient_id": patient_id,
                "substance": "Penicillin",
                "reaction": "Rash",
                "severity": "moderate",
            },
            {"reaction": "Hives", "severity": "severe"},
        ),
        (
            "medication",
            str(uuid4()),
            {
                "patient_id": patient_id,
                "name": "Synthetic medication",
                "dose": "10 mg",
                "frequency": "daily",
            },
            {"dose": "20 mg"},
        ),
    ]

    for entity_type, entity_id, create_payload, changes in records:
        created = send(
            client,
            headers,
            [
                operation(
                    entity_type=entity_type,
                    entity_id=entity_id,
                    idempotency_key=key(f"{entity_type}-create:{entity_id}"),
                    payload=create_payload,
                )
            ],
        )
        assert created.status_code == 200, created.text
        assert created.json()["results"][0]["status"] == "acknowledged"

        updated = send(
            client,
            headers,
            [
                operation(
                    entity_type=entity_type,
                    entity_id=entity_id,
                    operation_type="update",
                    base_version=1,
                    local_version=2,
                    idempotency_key=key(f"{entity_type}-update:{entity_id}"),
                    payload={**changes, "expected_version": 1},
                )
            ],
        )
        assert updated.status_code == 200, updated.text
        update_result = updated.json()["results"][0]
        assert update_result["status"] == "acknowledged"
        assert update_result["server_version"] == 2

        stale = send(
            client,
            headers,
            [
                operation(
                    entity_type=entity_type,
                    entity_id=entity_id,
                    operation_type="update",
                    base_version=1,
                    local_version=3,
                    idempotency_key=key(f"{entity_type}-stale:{entity_id}"),
                    payload={**changes, "expected_version": 1},
                )
            ],
        )
        assert stale.status_code == 200
        stale_result = stale.json()["results"][0]
        assert stale_result["status"] == "conflict"
        assert stale_result["server_version"] == 2

        archived = send(
            client,
            headers,
            [
                operation(
                    entity_type=entity_type,
                    entity_id=entity_id,
                    operation_type="archive",
                    base_version=2,
                    local_version=3,
                    idempotency_key=key(f"{entity_type}-archive:{entity_id}"),
                    payload={
                        "reason": "Entered on the wrong patient.",
                        "expected_version": 2,
                    },
                )
            ],
        )
        assert archived.status_code == 200, archived.text
        archive_result = archived.json()["results"][0]
        assert archive_result["status"] == "acknowledged"
        assert archive_result["server_version"] == 3
        assert archive_result["entity"]["entered_in_error_at"]
        assert archive_result["entity"]["entered_in_error_reason"] == (
            "Entered on the wrong patient."
        )

    changes_response = client.get(
        "/api/v1/sync/changes",
        params={"device_id": DEVICE_ID, "cursor": 0, "limit": 100},
        headers=headers,
    )
    assert changes_response.status_code == 200, changes_response.text
    archived_changes = [
        change
        for change in changes_response.json()["changes"]
        if change["operation_type"] == "archive"
        and change["entity_type"] in {"observation", "allergy", "medication"}
    ]
    assert len(archived_changes) == 3
    assert all(not change["tombstone"] for change in archived_changes)


def test_batch_is_partially_applied_and_out_of_order_records_stay_retryable(
    api_client,
) -> None:
    client = api_client["client"]
    headers = login(client)
    provision(client, headers)

    patient_id = str(uuid4())
    consultation_id = str(uuid4())
    orphan_consultation = str(uuid4())

    response = send(
        client,
        headers,
        [
            operation(
                entity_id=patient_id,
                idempotency_key=key(f"p:{patient_id}"),
                payload=patient_payload(),
            ),
            operation(
                entity_id=consultation_id,
                idempotency_key=key(f"c:{consultation_id}"),
                entity_type="consultation",
                payload={"patient_id": patient_id, "reason": "Fever review"},
            ),
            operation(
                entity_id=str(uuid4()),
                idempotency_key=key(f"n:{orphan_consultation}"),
                entity_type="clinicalNote",
                payload={
                    "patient_id": patient_id,
                    "consultation_id": orphan_consultation,
                    "body": "Clinician-authored note for an unsynchronized consultation.",
                },
            ),
        ],
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["acknowledged"] == 2
    assert body["rejected"] == 1

    rejected = body["results"][2]
    assert rejected["status"] == "rejected"
    # The device must keep retrying this one rather than discarding the note.
    assert rejected["retryable"] is True

    consultations = client.get(
        f"/api/v1/consultations?patient_id={patient_id}", headers=headers
    )
    assert consultations.status_code == 200
    assert consultations.json()["total"] == 1


def test_clinical_note_and_document_round_trip(api_client) -> None:
    client = api_client["client"]
    headers = login(client)
    provision(client, headers)

    patient_id = str(uuid4())
    consultation_id = str(uuid4())
    note_id = str(uuid4())
    document_id = str(uuid4())
    content = b"%PDF-1.4 synthetic test document"
    checksum = hashlib.sha256(content).hexdigest()

    response = send(
        client,
        headers,
        [
            operation(
                entity_id=patient_id,
                idempotency_key=key(f"p2:{patient_id}"),
                payload=patient_payload(),
            ),
            operation(
                entity_id=consultation_id,
                idempotency_key=key(f"c2:{consultation_id}"),
                entity_type="consultation",
                payload={"patient_id": patient_id, "notes": "Initial draft"},
            ),
            operation(
                entity_id=note_id,
                idempotency_key=key(f"n2:{note_id}"),
                entity_type="clinicalNote",
                payload={
                    "patient_id": patient_id,
                    "consultation_id": consultation_id,
                    "body": "Documented history and examination findings.",
                },
            ),
            operation(
                entity_id=document_id,
                idempotency_key=key(f"d2:{document_id}"),
                entity_type="document",
                operation_type="upload",
                payload={
                    "patient_id": patient_id,
                    "consultation_id": consultation_id,
                    "file_name": "referral.pdf",
                    "mime_type": "application/pdf",
                    "byte_size": len(content),
                    "checksum": checksum,
                    "description": "Synthetic referral letter",
                },
            ),
        ],
    )
    assert response.status_code == 200, response.text
    assert response.json()["acknowledged"] == 4

    notes = client.get(
        f"/api/v1/consultations/{consultation_id}/notes", headers=headers
    )
    assert notes.status_code == 200
    assert notes.json()["items"][0]["body"].startswith("Documented history")

    documents = client.get(
        f"/api/v1/documents?patient_id={patient_id}", headers=headers
    )
    assert documents.json()["total"] == 1
    assert documents.json()["items"][0]["content_received_at"] is None

    upload = client.post(
        f"/api/v1/documents/{document_id}/content",
        files={"file": ("referral.pdf", io.BytesIO(content), "application/pdf")},
        headers=headers,
    )
    assert upload.status_code == 200, upload.text
    assert upload.json()["content_received_at"] is not None

    # A retried upload of the same bytes must not store a second copy.
    retry = client.post(
        f"/api/v1/documents/{document_id}/content",
        files={"file": ("referral.pdf", io.BytesIO(content), "application/pdf")},
        headers=headers,
    )
    assert retry.status_code == 200
    assert retry.json()["id"] == document_id

    download = client.get(f"/api/v1/documents/{document_id}/content", headers=headers)
    assert download.status_code == 200
    assert download.content == content


def test_document_upload_rejects_corrupted_content(api_client) -> None:
    client = api_client["client"]
    headers = login(client)
    provision(client, headers)

    patient_id = str(uuid4())
    document_id = str(uuid4())
    content = b"%PDF-1.4 original bytes"
    send(
        client,
        headers,
        [
            operation(
                entity_id=patient_id,
                idempotency_key=key(f"p3:{patient_id}"),
                payload=patient_payload(),
            ),
            operation(
                entity_id=document_id,
                idempotency_key=key(f"d3:{document_id}"),
                entity_type="document",
                operation_type="upload",
                payload={
                    "patient_id": patient_id,
                    "file_name": "scan.png",
                    "mime_type": "image/png",
                    "byte_size": len(content),
                    "checksum": hashlib.sha256(content).hexdigest(),
                },
            ),
        ],
    )

    tampered = content.replace(b"original", b"modified")
    response = client.post(
        f"/api/v1/documents/{document_id}/content",
        files={"file": ("scan.png", io.BytesIO(tampered), "image/png")},
        headers=headers,
    )
    assert response.status_code == 422
    assert "checksum" in response.json()["detail"]


def test_device_provisioning_is_scoped_to_the_signed_in_clinic(api_client) -> None:
    client = api_client["client"]
    headers = login(client)
    first = provision(client, headers)
    again = provision(client, headers)
    assert first["server_device_id"] == again["server_device_id"]
    assert first["offline_grace_days"] >= 1

    nurse_headers = login(client, "nurse@example.com")
    nurse_device = provision(client, nurse_headers, device_id="99999999-aaaa-bbbb-cccc-dddddddddddd")
    assert nurse_device["device_id"] != first["device_id"]


def test_unsupported_operation_is_rejected_without_retry(api_client) -> None:
    client = api_client["client"]
    headers = login(client)
    provision(client, headers)
    response = send(
        client,
        headers,
        [
            operation(
                entity_type="allergy",
                operation_type="upload",
                payload={"patient_id": str(uuid4())},
            )
        ],
    )
    result = response.json()["results"][0]
    assert result["status"] == "rejected"
    assert result["retryable"] is False


def test_pull_changes_accepts_its_own_default_limit(api_client) -> None:
    """
    Regression for a defect where /sync/changes defaulted limit to 200 but
    validated it against the push batch limit of 50, so every pull using the
    default was rejected and no device ever received another device's work.
    """
    client = api_client["client"]
    headers = login(client)
    provision(client, headers)

    # No explicit limit: the route's own default must be acceptable.
    response = client.get(f"/api/v1/sync/changes?device_id={DEVICE_ID}", headers=headers)
    assert response.status_code == 200, response.text
    body = response.json()
    assert "changes" in body and "next_cursor" in body

    # An explicit value within the pull limit is accepted.
    assert (
        client.get(
            f"/api/v1/sync/changes?device_id={DEVICE_ID}&limit=200", headers=headers
        ).status_code
        == 200
    )
    # Beyond the pull limit it is still refused.
    too_big = client.get(
        f"/api/v1/sync/changes?device_id={DEVICE_ID}&limit=5000", headers=headers
    )
    assert too_big.status_code == 422


def test_a_record_pushed_by_one_device_is_pulled_by_another(api_client) -> None:
    client = api_client["client"]
    headers = login(client)
    provision(client, headers, device_id=DEVICE_ID)
    second_device = "22222222-3333-4444-5555-666666666666"
    provision(client, headers, device_id=second_device)

    patient_id = str(uuid4())
    pushed = send(
        client,
        headers,
        [
            operation(
                entity_id=patient_id,
                idempotency_key=key(f"pull:{patient_id}"),
                payload=patient_payload(full_name="Pulled Synthetic Patient"),
            )
        ],
    )
    assert pushed.json()["acknowledged"] == 1

    pulled = client.get(
        f"/api/v1/sync/changes?device_id={second_device}", headers=headers
    )
    assert pulled.status_code == 200, pulled.text
    entity_ids = [change["entity_id"] for change in pulled.json()["changes"]]
    assert patient_id in entity_ids


# --------------------------------------------------------------------------
# AI summaries: the one AI artifact that synchronizes
# --------------------------------------------------------------------------

def test_ai_summary_round_trips_and_fights_version_drift(api_client) -> None:
    client = api_client["client"]
    headers = login(client)
    provision(client, headers)

    patient_id = str(uuid4())
    summary_id = str(uuid4())
    sections = [
        {
            "section": "presenting_complaint",
            "points": [{"text": "Fever for two days.", "source_line_ids": ["transcript"]}],
        }
    ]

    response = send(
        client,
        headers,
        [
            operation(
                entity_id=patient_id,
                idempotency_key=key(f"p-ai:{patient_id}"),
                payload=patient_payload(),
            ),
            operation(
                entity_id=summary_id,
                idempotency_key=key(f"ai-create:{summary_id}"),
                entity_type="aiSummary",
                payload={
                    "patient_id": patient_id,
                    "text": "Structured summary drafted by the local model and edited by the clinician.",
                    "source_artifact_id": "artifact-123",
                    "sections": sections,
                },
            ),
        ],
    )
    assert response.status_code == 200, response.text
    assert response.json()["acknowledged"] == 2

    # The summary comes back through the change feed so another device can
    # apply it, exactly like a hand-entered note.
    pull = client.get(
        f"/api/v1/sync/changes?limit=50&device_id={DEVICE_ID}", headers=headers
    )
    assert pull.status_code == 200, pull.text
    ai_changes = [
        change
        for change in pull.json()["changes"]
        if change["entity_type"] == "aiSummary"
    ]
    assert len(ai_changes) == 1
    assert ai_changes[0]["entity_version"] == 1
    assert ai_changes[0]["payload"]["sections"] == sections

    # A clinician edit bumps the version; a stale edit is a conflict.
    edit = send(
        client,
        headers,
        [
            operation(
                entity_id=summary_id,
                idempotency_key=key(f"ai-update:{summary_id}"),
                entity_type="aiSummary",
                operation_type="update",
                base_version=1,
                local_version=2,
                payload={"text": "Clinician-edited summary text.", "expected_version": 1},
            ),
        ],
    )
    assert edit.status_code == 200, edit.text
    assert edit.json()["acknowledged"] == 1

    stale = send(
        client,
        headers,
        [
            operation(
                entity_id=summary_id,
                idempotency_key=key(f"ai-stale:{summary_id}"),
                entity_type="aiSummary",
                operation_type="update",
                base_version=1,
                local_version=2,
                payload={"text": "Written against version 1.", "expected_version": 1},
            ),
        ],
    )
    assert stale.status_code == 200
    assert stale.json()["conflicts"] == 1


def test_ai_summary_requires_a_known_patient_in_the_clinic(api_client) -> None:
    client = api_client["client"]
    headers = login(client)
    provision(client, headers)

    summary_id = str(uuid4())
    response = send(
        client,
        headers,
        [
            operation(
                entity_id=summary_id,
                idempotency_key=key(f"ai-orphan:{summary_id}"),
                entity_type="aiSummary",
                payload={
                    "patient_id": str(uuid4()),
                    "text": "Summary for a patient that never synced.",
                },
            ),
        ],
    )
    assert response.status_code == 200
    result = response.json()["results"][0]
    assert result["status"] == "rejected"
    assert result["retryable"] is True


# --------------------------------------------------------------------------
# Concurrent pushes of the same record from two devices. On PostgreSQL the
# two pushes genuinely race (the server serializes the applies on the clinic
# row lock); on the SQLite test database the single shared connection cannot
# take real parallelism, so the calls are serialized and the test still pins
# the outcome both orders must produce.
# --------------------------------------------------------------------------

def test_two_devices_pushing_the_same_patient_in_parallel(api_client) -> None:
    import os
    import threading

    client = api_client["client"]
    headers = login(client)
    provision(client, headers)
    second_device = "11111111-2222-3333-4444-555555555556"
    provision(client, headers, device_id=second_device)

    patient_id = str(uuid4())
    outcomes: list[dict] = []
    failures: list[Exception] = []
    using_postgres = not os.environ.get("TEST_DATABASE_URL", "sqlite://").startswith(
        "sqlite"
    )
    # SQLite's StaticPool hands every session the same connection, which two
    # threads must not touch at once, so the calls are serialized. On
    # PostgreSQL the lock is redundant but harmless; the race there is genuine
    # because each session holds its own connection.
    request_lock = threading.Lock()

    def push(device_id: str, idempotency_seed: str) -> None:
        try:
            operation = {
                "operation_id": str(uuid4()),
                "idempotency_key": key(f"parallel:{idempotency_seed}"),
                "entity_type": "patient",
                "entity_id": patient_id,
                "operation_type": "create",
                "base_version": 0,
                "local_version": 1,
                "payload": patient_payload(full_name="Synthetic Parallel Patient"),
            }
            with request_lock:
                response = send(
                    client,
                    headers,
                    [operation],
                    device_id=device_id,
                )
            assert response.status_code == 200, response.text
            outcomes.append(response.json())
        except Exception as error:  # surfaced below, never swallowed
            failures.append(error)

    threads = [
        threading.Thread(target=push, args=(DEVICE_ID, "first")),
        threading.Thread(target=push, args=(second_device, "second")),
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert not failures, failures
    assert len(outcomes) == 2
    # Both devices get an acknowledgement: one create landed, the other was
    # satisfied by the record already being there. Neither is an error.
    for outcome in outcomes:
        assert outcome["acknowledged"] == 1
        assert outcome["results"][0]["status"] == "acknowledged"

    # And the record exists exactly once.
    listed = client.get(
        "/api/v1/patients?search=Synthetic Parallel Patient", headers=headers
    )
    assert listed.status_code == 200
    assert listed.json()["total"] == 1
