"""
Clinic key wrapping: step 1 of the end-to-end encryption plan.

These tests pin the property that makes the scheme worth anything — the
server stores and returns opaque blobs and can never reach the key — and the
access control around them. See docs/security/E2E_ENCRYPTION_DESIGN.md.
"""

import base64
import secrets
from uuid import uuid4

PASSWORD = "synthetic-test-password"


def login(client, email="doctor@example.com"):
    response = client.post(
        "/api/v1/auth/login", json={"email": email, "password": PASSWORD}
    )
    assert response.status_code == 200, response.text
    return response.json()


def auth(client, email="doctor@example.com"):
    return {"Authorization": f"Bearer {login(client, email)['access_token']}"}


def synthetic_wrap(user_id: str, epoch: int = 1) -> dict:
    """A wrap shaped like a real one. The bytes are random, as they would be."""
    return {
        "user_id": user_id,
        "key_epoch": epoch,
        "wrapped_key": base64.b64encode(secrets.token_bytes(48)).decode(),
        "wrap_iv": base64.b64encode(secrets.token_bytes(12)).decode(),
        "kdf_salt": base64.b64encode(secrets.token_bytes(16)).decode(),
        "kdf_iterations": 310_000,
    }


def test_a_clinic_starts_with_no_key_and_says_so(api_client) -> None:
    client = api_client["client"]
    headers = auth(client)

    status = client.get("/api/v1/keys/clinic/status", headers=headers)
    assert status.status_code == 200
    body = status.json()
    assert body["key_epoch"] is None
    assert body["wrapped_for_this_user"] is False
    assert body["user_count_with_access"] == 0
    # The whole point: a key existing would still not mean records are
    # encrypted, and the API must not imply that it does.
    assert body["records_encrypted"] is False

    missing = client.get("/api/v1/keys/clinic", headers=headers)
    assert missing.status_code == 404


def test_published_wraps_round_trip_byte_for_byte(api_client) -> None:
    client = api_client["client"]
    session = login(client)
    headers = {"Authorization": f"Bearer {session['access_token']}"}
    me = session["user"]["id"]

    wrap = synthetic_wrap(me)
    published = client.post(
        "/api/v1/keys/clinic", json={"wraps": [wrap]}, headers=headers
    )
    assert published.status_code == 201, published.text
    assert published.json()["key_epoch"] == 1
    assert published.json()["wrapped_for_this_user"] is True
    assert published.json()["records_encrypted"] is False

    mine = client.get("/api/v1/keys/clinic", headers=headers)
    assert mine.status_code == 200
    returned = mine.json()
    # The server is a store, not a participant: what comes back is exactly
    # what the device sent.
    assert returned["wrapped_key"] == wrap["wrapped_key"]
    assert returned["wrap_iv"] == wrap["wrap_iv"]
    assert returned["kdf_salt"] == wrap["kdf_salt"]
    assert returned["kdf_iterations"] == wrap["kdf_iterations"]


def test_a_user_only_ever_receives_their_own_wrap(api_client) -> None:
    client = api_client["client"]
    doctor = login(client)
    doctor_headers = {"Authorization": f"Bearer {doctor['access_token']}"}
    doctor_id = doctor["user"]["id"]

    nurse = login(client, "nurse@example.com")
    nurse_id = nurse["user"]["id"]
    nurse_headers = {"Authorization": f"Bearer {nurse['access_token']}"}

    doctor_wrap = synthetic_wrap(doctor_id)
    nurse_wrap = synthetic_wrap(nurse_id)
    assert (
        client.post(
            "/api/v1/keys/clinic",
            json={"wraps": [doctor_wrap, nurse_wrap]},
            headers=doctor_headers,
        ).status_code
        == 201
    )

    assert client.get("/api/v1/keys/clinic", headers=doctor_headers).json()[
        "wrapped_key"
    ] == doctor_wrap["wrapped_key"]
    assert client.get("/api/v1/keys/clinic", headers=nurse_headers).json()[
        "wrapped_key"
    ] == nurse_wrap["wrapped_key"]
    # There is no endpoint that returns someone else's wrap, and the one that
    # exists is scoped to the caller.
    assert client.get("/api/v1/keys/clinic", headers=nurse_headers).json()[
        "user_id"
    ] == nurse_id


def test_publishing_requires_the_user_management_permission(api_client) -> None:
    client = api_client["client"]
    nurse = login(client, "nurse@example.com")
    nurse_headers = {"Authorization": f"Bearer {nurse['access_token']}"}

    refused = client.post(
        "/api/v1/keys/clinic",
        json={"wraps": [synthetic_wrap(nurse["user"]["id"])]},
        headers=nurse_headers,
    )
    assert refused.status_code == 403


def test_a_key_cannot_be_wrapped_for_another_clinics_user(api_client) -> None:
    client = api_client["client"]
    headers = auth(client)
    outsider = login(client, "other@example.com")["user"]["id"]

    refused = client.post(
        "/api/v1/keys/clinic",
        json={"wraps": [synthetic_wrap(outsider)]},
        headers=headers,
    )
    assert refused.status_code == 403
    assert "your own clinic" in refused.json()["detail"]

    # A user id that does not exist at all is refused the same way.
    unknown = client.post(
        "/api/v1/keys/clinic",
        json={"wraps": [synthetic_wrap(str(uuid4()))]},
        headers=headers,
    )
    assert unknown.status_code == 403


def test_an_existing_epoch_is_never_silently_replaced(api_client) -> None:
    client = api_client["client"]
    session = login(client)
    headers = {"Authorization": f"Bearer {session['access_token']}"}
    me = session["user"]["id"]

    first = synthetic_wrap(me, epoch=1)
    assert (
        client.post("/api/v1/keys/clinic", json={"wraps": [first]}, headers=headers).status_code
        == 201
    )

    replacement = synthetic_wrap(me, epoch=1)
    clash = client.post(
        "/api/v1/keys/clinic", json={"wraps": [replacement]}, headers=headers
    )
    assert clash.status_code == 409
    # The original is intact: a bad publish cannot destroy access to records.
    assert client.get("/api/v1/keys/clinic", headers=headers).json()[
        "wrapped_key"
    ] == first["wrapped_key"]

    # Rotation means a higher epoch, and the newest one is served.
    rotated = synthetic_wrap(me, epoch=2)
    assert (
        client.post("/api/v1/keys/clinic", json={"wraps": [rotated]}, headers=headers).status_code
        == 201
    )
    current = client.get("/api/v1/keys/clinic", headers=headers).json()
    assert current["key_epoch"] == 2
    assert current["wrapped_key"] == rotated["wrapped_key"]


def test_weak_key_derivation_parameters_are_refused(api_client) -> None:
    client = api_client["client"]
    session = login(client)
    headers = {"Authorization": f"Bearer {session['access_token']}"}

    weak = synthetic_wrap(session["user"]["id"])
    weak["kdf_iterations"] = 1000
    response = client.post("/api/v1/keys/clinic", json={"wraps": [weak]}, headers=headers)
    assert response.status_code == 422


def test_key_material_never_reaches_the_audit_trail(api_client) -> None:
    client = api_client["client"]
    session = login(client)
    headers = {"Authorization": f"Bearer {session['access_token']}"}
    wrap = synthetic_wrap(session["user"]["id"])
    client.post("/api/v1/keys/clinic", json={"wraps": [wrap]}, headers=headers)

    audit = client.get("/api/v1/audit", headers=headers)
    assert audit.status_code == 200
    body = audit.text
    assert "encryption.clinic_key.published" in body
    assert wrap["wrapped_key"] not in body
    assert wrap["kdf_salt"] not in body
