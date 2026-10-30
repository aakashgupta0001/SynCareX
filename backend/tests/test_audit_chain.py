"""
Tamper-evident audit log: per-clinic SHA-256 hash chain.

Covers the chain end to end: appends link onto the clinic's tail, editing a
stored row breaks verification at exactly that row, each clinic's chain is
independent, and a row removed from the middle of a clinic's history (a gap
every later link used to point across) is detected. See
app/services/audit_chain.py and GET /api/v1/audit/verify.
"""

import base64
import secrets

from sqlalchemy import select

from app.models import AuditLog

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


def _publish_clinic_key(client, headers, user_id: str) -> None:
    response = client.post(
        "/api/v1/keys/clinic",
        json={"wraps": [synthetic_wrap(user_id)]},
        headers=headers,
    )
    assert response.status_code == 201, response.text


def _ordered_rows(session_factory, clinic_id=None) -> list:
    """Audit rows in chain order, from a session that is closed on return.

    The test engine is a StaticPool with a single connection, so the session
    must be closed before any API call needs that connection again.
    """
    session = session_factory()
    try:
        query = select(AuditLog).order_by(AuditLog.created_at, AuditLog.id)
        if clinic_id is not None:
            query = query.where(AuditLog.clinic_id == clinic_id)
        return session.scalars(query).all()
    finally:
        session.close()


def test_verify_reports_a_valid_chain_after_actions(api_client) -> None:
    client = api_client["client"]
    session = login(client)
    headers = {"Authorization": f"Bearer {session['access_token']}"}
    _publish_clinic_key(client, headers, session["user"]["id"])

    verify = client.get("/api/v1/audit/verify", headers=headers)
    assert verify.status_code == 200
    body = verify.json()
    # One row from the login, one from the key publish — both linked.
    assert body["checked"] == 2
    assert body["valid"] is True
    assert body["first_broken"] is None
    assert body["rows_without_hash"] == 0
    assert body["clinic_id"] == str(api_client["clinic_id"])

    rows = _ordered_rows(api_client["session_factory"], api_client["clinic_id"])
    assert [row.prev_hash for row in rows] == [None, rows[0].row_hash]
    assert all(row.row_hash for row in rows)


def test_editing_a_row_breaks_verification_at_that_row(api_client) -> None:
    client = api_client["client"]
    session = login(client)
    headers = {"Authorization": f"Bearer {session['access_token']}"}
    _publish_clinic_key(client, headers, session["user"]["id"])
    session_factory = api_client["session_factory"]

    victim = _ordered_rows(session_factory, api_client["clinic_id"])[-1]
    victim_id = victim.id
    tamper_session = session_factory()
    try:
        stored = tamper_session.get(AuditLog, victim_id)
        stored.details = {"tampered": "true"}
        tamper_session.commit()
    finally:
        tamper_session.close()

    body = client.get("/api/v1/audit/verify", headers=headers).json()
    assert body["valid"] is False
    assert body["first_broken"] == str(victim_id)
    assert body["checked"] == 2


def test_chains_are_independent_per_clinic(api_client) -> None:
    client = api_client["client"]
    other_headers = auth(client, "other@example.com")
    doctor = login(client)
    doctor_headers = {"Authorization": f"Bearer {doctor['access_token']}"}
    _publish_clinic_key(client, doctor_headers, doctor["user"]["id"])

    # Tamper a row in the first clinic only.
    victim = _ordered_rows(api_client["session_factory"], api_client["clinic_id"])[-1]
    victim_id = victim.id
    tamper_session = api_client["session_factory"]()
    try:
        stored = tamper_session.get(AuditLog, victim_id)
        stored.action = "auth.login.tampered"
        tamper_session.commit()
    finally:
        tamper_session.close()

    doctor_body = client.get("/api/v1/audit/verify", headers=doctor_headers).json()
    assert doctor_body["valid"] is False
    assert doctor_body["first_broken"] == str(victim_id)

    # The other clinic's chain — its own login row — is untouched and valid.
    other_body = client.get("/api/v1/audit/verify", headers=other_headers).json()
    assert other_body["valid"] is True
    assert other_body["checked"] == 1
    assert other_body["clinic_id"] == str(api_client["other_clinic_id"])


def test_a_gap_in_the_chain_is_detected(api_client) -> None:
    client = api_client["client"]
    session = login(client)
    headers = {"Authorization": f"Bearer {session['access_token']}"}
    _publish_clinic_key(client, headers, session["user"]["id"])
    session_factory = api_client["session_factory"]

    # Remove the first row: the next row still points at its hash, so the
    # chain no longer joins up — a deletion in the middle of a history.
    victim = _ordered_rows(session_factory, api_client["clinic_id"])[0]
    tamper_session = session_factory()
    try:
        tamper_session.delete(tamper_session.get(AuditLog, victim.id))
        tamper_session.commit()
    finally:
        tamper_session.close()

    # A row appended after the gap links onto the current tail, but the
    # chain stays broken where the deletion happened.
    assert login(client)["user"]["id"] == session["user"]["id"]

    body = client.get("/api/v1/audit/verify", headers=headers).json()
    remaining = _ordered_rows(session_factory, api_client["clinic_id"])
    assert body["valid"] is False
    assert body["first_broken"] == str(remaining[0].id)
    assert body["checked"] == len(remaining)
    assert remaining[0].prev_hash == victim.row_hash


def test_verify_requires_the_audit_read_permission(api_client) -> None:
    client = api_client["client"]
    nurse_headers = {"Authorization": f"Bearer {login(client, 'nurse@example.com')['access_token']}"}

    response = client.get("/api/v1/audit/verify", headers=nurse_headers)
    assert response.status_code == 403
