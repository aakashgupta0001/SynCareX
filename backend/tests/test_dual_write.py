"""
End-to-end encryption, steps 2 and 3.

Step 2 is dual-write: a device may send a clinic-key-encrypted copy of a
patient alongside the plaintext, and the server stores both. Step 3 moves the
first reader — patient search — onto keyed hashes, so the server can answer a
search without receiving the query.

See docs/security/E2E_ENCRYPTION_DESIGN.md.
"""

import base64
import hashlib
import hmac
import secrets
from uuid import UUID, uuid4

DEVICE_ID = "11111111-2222-3333-4444-555555555555"
PASSWORD = "synthetic-test-password"

# Stands in for the clinic key. The server never receives it, which is the
# whole point, so the tests hold it the way a device would.
CLINIC_KEY = secrets.token_bytes(32)


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


def trigrams(value: str) -> set[str]:
    """Matches the client tokenizer in src/offline/searchIndex.ts."""
    normalized = value.casefold().strip()
    return {normalized[i : i + 3] for i in range(len(normalized) - 2)}


def hashed(term: str) -> str:
    """
    The keyed hash a device computes. The server cannot reproduce it.

    base64url, matching the client: these travel in a query string, where a
    "+" from standard base64 would be decoded as a space.
    """
    digest = hmac.new(CLINIC_KEY, term.encode(), hashlib.sha256).digest()
    return base64.urlsafe_b64encode(digest[:12]).decode().rstrip("=")


def patient_terms(*values: str) -> list[str]:
    terms: set[str] = set()
    for value in values:
        terms |= trigrams(value)
    return [hashed(term) for term in terms]


def sealed(content: str) -> dict:
    """Shaped like AES-GCM output; opaque to the server either way."""
    return {
        "ciphertext": base64.b64encode(content.encode() + secrets.token_bytes(16)).decode(),
        "iv": base64.b64encode(secrets.token_bytes(12)).decode(),
        "key_epoch": 1,
    }


def operation(**overrides):
    base = {
        "operation_id": str(uuid4()),
        "idempotency_key": hashlib.sha256(str(uuid4()).encode()).hexdigest(),
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
        "full_name": "Synthetic Sealed Patient",
        "estimated_age": 41,
        "village": "Cipherton",
        "allergies": [],
        **overrides,
    }


def send(client, headers, operations):
    return client.post(
        "/api/v1/sync/operations",
        json={"device_id": DEVICE_ID, "operations": operations},
        headers=headers,
    )


def test_a_device_without_a_clinic_key_synchronizes_exactly_as_before(api_client) -> None:
    """Dual-write must be additive: no key, no change in behaviour."""
    client = api_client["client"]
    headers = login(client)
    provision(client, headers)

    response = send(client, headers, [operation(payload=patient_payload())])
    assert response.status_code == 200, response.text
    assert response.json()["acknowledged"] == 1
    # The plaintext path still answers.
    listed = client.get("/api/v1/patients?search=Cipherton", headers=headers)
    assert listed.json()["total"] == 1


def test_sealed_content_is_stored_and_never_interpreted(api_client) -> None:
    client = api_client["client"]
    headers = login(client)
    provision(client, headers)

    patient_id = str(uuid4())
    envelope = sealed("Synthetic Sealed Patient")
    response = send(
        client,
        headers,
        [
            operation(
                entity_id=patient_id,
                payload=patient_payload(),
                sealed_content=envelope,
                search_terms=patient_terms("Synthetic Sealed Patient", "Cipherton"),
            )
        ],
    )
    assert response.status_code == 200, response.text
    assert response.json()["acknowledged"] == 1

    from app.models import Patient

    db = api_client["session_factory"]()
    try:
        stored = db.get(Patient, UUID(patient_id))
        assert stored is not None
        # Stored byte for byte, with no attempt to parse it.
        assert stored.content_ciphertext == envelope["ciphertext"]
        assert stored.content_iv == envelope["iv"]
        assert stored.content_key_epoch == 1
    finally:
        db.close()


def test_search_by_keyed_hashes_never_receives_the_query(api_client) -> None:
    client = api_client["client"]
    headers = login(client)
    provision(client, headers)

    wanted = str(uuid4())
    other = str(uuid4())
    send(
        client,
        headers,
        [
            operation(
                entity_id=wanted,
                payload=patient_payload(full_name="Amara Cipher", village="Riverbend"),
                sealed_content=sealed("Amara Cipher"),
                search_terms=patient_terms("Amara Cipher", "Riverbend"),
            ),
            operation(
                entity_id=other,
                payload=patient_payload(full_name="Bashir Other", village="Hilltop"),
                sealed_content=sealed("Bashir Other"),
                search_terms=patient_terms("Bashir Other", "Hilltop"),
            ),
        ],
    )

    params = "&".join(f"search_terms={term}" for term in [hashed(t) for t in trigrams("riverbend")])
    found = client.get(f"/api/v1/patients?{params}", headers=headers)
    assert found.status_code == 200, found.text
    body = found.json()
    assert body["total"] == 1
    assert body["items"][0]["id"] == wanted


def test_hashed_search_requires_every_trigram_to_match(api_client) -> None:
    client = api_client["client"]
    headers = login(client)
    provision(client, headers)

    send(
        client,
        headers,
        [
            operation(
                payload=patient_payload(full_name="Amara Cipher", village="Riverbend"),
                search_terms=patient_terms("Amara Cipher", "Riverbend"),
            )
        ],
    )

    # A term the record does not carry must exclude it, even though the rest
    # of the query matches.
    terms = [hashed(t) for t in trigrams("riverbend")] + [hashed("zzz")]
    params = "&".join(f"search_terms={term}" for term in terms)
    assert client.get(f"/api/v1/patients?{params}", headers=headers).json()["total"] == 0


def test_editing_a_patient_replaces_its_search_terms(api_client) -> None:
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
                payload=patient_payload(village="Oldtown"),
                search_terms=patient_terms("Oldtown"),
            )
        ],
    )
    old_params = "&".join(f"search_terms={t}" for t in [hashed(x) for x in trigrams("oldtown")])
    assert client.get(f"/api/v1/patients?{old_params}", headers=headers).json()["total"] == 1

    send(
        client,
        headers,
        [
            operation(
                entity_id=patient_id,
                operation_type="update",
                base_version=1,
                local_version=2,
                payload={"village": "Newtown", "expected_version": 1},
                search_terms=patient_terms("Newtown"),
            )
        ],
    )

    # The stale term must stop matching, or a renamed record would stay
    # findable under its old name.
    assert client.get(f"/api/v1/patients?{old_params}", headers=headers).json()["total"] == 0
    new_params = "&".join(f"search_terms={t}" for t in [hashed(x) for x in trigrams("newtown")])
    assert client.get(f"/api/v1/patients?{new_params}", headers=headers).json()["total"] == 1


def test_search_terms_are_scoped_to_the_callers_clinic(api_client) -> None:
    client = api_client["client"]
    headers = login(client)
    provision(client, headers)
    send(
        client,
        headers,
        [
            operation(
                payload=patient_payload(village="Riverbend"),
                search_terms=patient_terms("Riverbend"),
            )
        ],
    )

    # The other clinic's user holds no key, but even a lucky hash collision
    # must not cross the clinic boundary.
    other_headers = login(client, "other@example.com")
    params = "&".join(f"search_terms={t}" for t in [hashed(x) for x in trigrams("riverbend")])
    assert client.get(f"/api/v1/patients?{params}", headers=other_headers).json()["total"] == 0


def test_patients_without_hashed_terms_are_still_found_during_dual_write(api_client) -> None:
    client = api_client["client"]
    headers = login(client)
    provision(client, headers)

    indexed = str(uuid4())
    legacy = str(uuid4())
    send(
        client,
        headers,
        [
            operation(
                entity_id=indexed,
                payload=patient_payload(full_name="Amara Cipher", village="Riverbend"),
                sealed_content=sealed("Amara Cipher"),
                search_terms=patient_terms("Amara Cipher", "Riverbend"),
            ),
            # Synced by a device without the clinic key: no hash rows.
            operation(
                entity_id=legacy,
                payload=patient_payload(full_name="Chandni Legacy", village="Riverbend"),
            ),
        ],
    )

    hashed_params = "&".join(
        f"search_terms={term}" for term in [hashed(t) for t in trigrams("riverbend")]
    )

    # Hashes alone match only the indexed record, as before.
    hashed_only = client.get(f"/api/v1/patients?{hashed_params}", headers=headers)
    assert hashed_only.status_code == 200, hashed_only.text
    assert {item["id"] for item in hashed_only.json()["items"]} == {indexed}

    # With the plaintext query alongside, the unindexed record is found too,
    # and the indexed one is not duplicated.
    both = client.get(
        f"/api/v1/patients?{hashed_params}&search=Riverbend", headers=headers
    )
    assert both.status_code == 200, both.text
    assert both.json()["total"] == 2
    assert {item["id"] for item in both.json()["items"]} == {indexed, legacy}
