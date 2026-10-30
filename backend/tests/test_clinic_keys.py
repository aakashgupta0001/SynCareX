"""
Clinic key wrapping: step 1 of the end-to-end encryption plan.

These tests pin the property that makes the scheme worth anything — the
server stores and returns opaque blobs and can never reach the key — and the
access control around them. See docs/security/E2E_ENCRYPTION_DESIGN.md.
"""

import base64
import hashlib
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


def test_a_user_without_the_key_cannot_create_a_second_clinic_key(api_client) -> None:
    client = api_client["client"]
    doctor = login(client)
    doctor_headers = {"Authorization": f"Bearer {doctor['access_token']}"}
    doctor_id = doctor["user"]["id"]
    nurse_id = login(client, "nurse@example.com")["user"]["id"]

    # The clinic gets its key through a wrap for the nurse only, so the
    # doctor does not hold it.
    assert (
        client.post(
            "/api/v1/keys/clinic",
            json={"wraps": [synthetic_wrap(nurse_id)]},
            headers=doctor_headers,
        ).status_code
        == 201
    )

    # Anything the doctor publishes for themselves now would be a different
    # key at the same epoch, which would split the clinic's data.
    second = client.post(
        "/api/v1/keys/clinic",
        json={"wraps": [synthetic_wrap(doctor_id)]},
        headers=doctor_headers,
    )
    assert second.status_code == 409
    status_now = client.get("/api/v1/keys/clinic/status", headers=doctor_headers).json()
    assert status_now["user_count_with_access"] == 1
    assert status_now["wrapped_for_this_user"] is False


# --------------------------------------------------------------------------
# Identity keypairs: the fix for the design's "known gap". A holder of the
# clinic key can now wrap it for a colleague by sealing it to their published
# ECDH public key — no passphrase sharing, no second clinic key.
# --------------------------------------------------------------------------

def _identity_jwk(seed: str) -> str:
    """A syntactically valid P-256 JWK. The bytes are fake but the shape is
    exactly what the client publishes."""
    import json as _json

    return _json.dumps(
        {
            "kty": "EC",
            "crv": "P-256",
            "x": base64.urlsafe_b64encode(hashlib.sha256(f"x:{seed}".encode()).digest())
            .decode()
            .rstrip("="),
            "y": base64.urlsafe_b64encode(hashlib.sha256(f"y:{seed}".encode()).digest())
            .decode()
            .rstrip("="),
        }
    )


def test_identity_key_publish_fetch_and_replacement(api_client) -> None:
    client = api_client["client"]
    headers = auth(client)
    me = login(client)["user"]["id"]

    published = client.put(
        "/api/v1/keys/identity",
        json={"public_key": _identity_jwk("first")},
        headers=headers,
    )
    assert published.status_code == 201, published.text
    assert published.json()["user_id"] == me

    fetched = client.get(f"/api/v1/keys/identity/{me}", headers=headers)
    assert fetched.status_code == 200
    assert fetched.json()["public_key"] == _identity_jwk("first")

    # Re-provisioning a device is legal, but it changes the key colleagues
    # wrap to, so it is audited as its own action.
    replaced = client.put(
        "/api/v1/keys/identity",
        json={"public_key": _identity_jwk("second")},
        headers=headers,
    )
    assert replaced.status_code == 201
    audit = client.get("/api/v1/audit", headers=headers)
    assert "encryption.identity_key.published" in audit.text
    assert "encryption.identity_key.replaced" in audit.text


def test_identity_key_rejects_non_p256_material(api_client) -> None:
    client = api_client["client"]
    headers = auth(client)

    for bad in [
        "not json at all",
        '{"kty": "RSA", "n": "x", "e": "AQAB"}',
        '{"kty": "EC", "crv": "P-384", "x": "a", "y": "b"}',
        '{"kty": "EC", "crv": "P-256", "x": "a"}',
    ]:
        refused = client.put(
            "/api/v1/keys/identity", json={"public_key": bad}, headers=headers
        )
        assert refused.status_code == 422, bad


def test_identity_keys_never_cross_the_clinic_boundary(api_client) -> None:
    client = api_client["client"]
    headers = auth(client)
    outsider_id = login(client, "other@example.com")["user"]["id"]

    # An outsider's key is invisible even when it exists...
    outside_publish = client.post(
        "/api/v1/auth/login",
        json={"email": "other@example.com", "password": PASSWORD},
    )
    assert outside_publish.status_code == 200
    outsider_headers = {
        "Authorization": f"Bearer {outside_publish.json()['access_token']}"
    }
    assert (
        client.put(
            "/api/v1/keys/identity",
            json={"public_key": _identity_jwk("outsider")},
            headers=outsider_headers,
        ).status_code
        == 201
    )

    missing = client.get(f"/api/v1/keys/identity/{outsider_id}", headers=headers)
    assert missing.status_code == 404

    # ...and an insider who never published one is a 404 too, not an error.
    nurse_id = login(client, "nurse@example.com")["user"]["id"]
    none_yet = client.get(f"/api/v1/keys/identity/{nurse_id}", headers=headers)
    assert none_yet.status_code == 404


def test_the_key_holder_can_wrap_for_an_identity_key(api_client) -> None:
    client = api_client["client"]
    doctor_session = login(client)
    doctor_headers = {"Authorization": f"Bearer {doctor_session['access_token']}"}
    doctor_id = doctor_session["user"]["id"]
    nurse_id = login(client, "nurse@example.com")["user"]["id"]

    # The nurse publishes her identity key from her own device.
    assert (
        client.post(
            "/api/v1/auth/login",
            json={"email": "nurse@example.com", "password": PASSWORD},
        ).status_code
        == 200
    )
    nurse_headers = {"Authorization": f"Bearer {login(client, 'nurse@example.com')['access_token']}"}
    assert (
        client.put(
            "/api/v1/keys/identity",
            json={"public_key": _identity_jwk("nurse")},
            headers=nurse_headers,
        ).status_code
        == 201
    )

    # The doctor creates the clinic key and wraps it for the nurse by sealing
    # it to her public key: no passphrase ever changed hands.
    identity = client.get(f"/api/v1/keys/identity/{nurse_id}", headers=doctor_headers)
    assert identity.status_code == 200
    wrap = synthetic_wrap(nurse_id)
    wrap["wrap_type"] = "identity"
    wrap["ephemeral_public_key"] = _identity_jwk("ephemeral")
    wrap["kdf_salt"] = ""
    published = client.post(
        "/api/v1/keys/clinic", json={"wraps": [wrap]}, headers=doctor_headers
    )
    assert published.status_code == 201, published.text
    assert published.json()["user_count_with_access"] == 1

    members = client.get("/api/v1/keys/clinic/members", headers=doctor_headers)
    assert members.status_code == 200
    by_id = {member["id"]: member for member in members.json()}
    assert by_id[nurse_id]["holds_clinic_key"] is True
    assert by_id[nurse_id]["has_identity_key"] is True
    assert by_id[doctor_id]["holds_clinic_key"] is False

    # The nurse's own wrap comes back with the identity fields intact.
    mine = client.get("/api/v1/keys/clinic", headers=nurse_headers)
    assert mine.status_code == 200
    body = mine.json()
    assert body["wrap_type"] == "identity"
    assert body["ephemeral_public_key"] == _identity_jwk("ephemeral")


def test_an_identity_wrap_without_an_ephemeral_key_is_refused(api_client) -> None:
    client = api_client["client"]
    headers = auth(client)

    wrap = synthetic_wrap(login(client)["user"]["id"])
    wrap["wrap_type"] = "identity"
    wrap["kdf_salt"] = ""
    refused = client.post("/api/v1/keys/clinic", json={"wraps": [wrap]}, headers=headers)
    assert refused.status_code == 422
