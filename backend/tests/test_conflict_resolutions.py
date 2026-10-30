"""Conflict resolution receipts: the server's record of a clinician's
decision about a synchronization conflict."""

from uuid import UUID

from sqlalchemy import select

from app.models import AuditLog, ConflictResolution

PASSWORD = "synthetic-test-password"


def login(client, email="doctor@example.com"):
    response = client.post(
        "/api/v1/auth/login", json={"email": email, "password": PASSWORD}
    )
    assert response.status_code == 200, response.text
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


def resolution_payload(**overrides):
    base = {
        "entity_type": "patient",
        "entity_id": "22222222-3333-4444-5555-666666666666",
        "base_version": 3,
        "winning_version": 5,
        "winner_source": "merged",
        "field_decisions": [
            {
                "field": "full_name",
                "choice": "local",
                "local_value": "Kept Local Name",
                "server_value": "Server Name",
            },
            {
                "field": "village",
                "choice": "server",
                "local_value": "Local Village",
                "server_value": "Kept Server Village",
            },
        ],
    }
    base.update(overrides)
    return base


def test_conflict_resolution_requires_authentication(api_client) -> None:
    client = api_client["client"]
    anonymous = client.post("/api/v1/sync/conflict-resolutions", json=resolution_payload())
    assert anonymous.status_code == 401


def test_publish_conflict_resolution_stores_record_and_audit_entry(api_client) -> None:
    client = api_client["client"]
    headers = login(client)
    response = client.post(
        "/api/v1/sync/conflict-resolutions", json=resolution_payload(), headers=headers
    )
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["entity_type"] == "patient"
    assert body["winner_source"] == "merged"
    assert body["resolved_by"] == str(api_client["user_id"])
    assert body["clinic_id"] == str(api_client["clinic_id"])
    assert len(body["field_decisions"]) == 2
    assert body["field_decisions"][0]["choice"] == "local"

    # The stored row keeps the full per-field decisions.
    with api_client["session_factory"]() as db:
        stored = db.scalar(
            select(ConflictResolution).where(
                ConflictResolution.entity_id == UUID(body["entity_id"])
            )
        )
        assert stored is not None
        assert stored.winner_source == "merged"
        assert stored.field_decisions is not None
        assert stored.field_decisions[1]["field"] == "village"
        assert stored.field_decisions[1]["choice"] == "server"

        # The audit chain received the resolution.
        entry = db.scalar(
            select(AuditLog).where(
                AuditLog.clinic_id == api_client["clinic_id"],
                AuditLog.action == "sync.conflict.resolved",
                AuditLog.entity_id == stored.entity_id,
            )
        )
        assert entry is not None
        assert entry.details["winner_source"] == "merged"
        assert "full_name" in entry.details["decided_fields"]
        # The chained digest is present for the new entry.
        assert entry.row_hash


def test_conflict_resolution_rejects_unknown_entity_type(api_client) -> None:
    client = api_client["client"]
    headers = login(client)
    response = client.post(
        "/api/v1/sync/conflict-resolutions",
        json=resolution_payload(entity_type="ledger"),
        headers=headers,
    )
    assert response.status_code == 422


def test_conflict_resolution_is_clinic_scoped(api_client) -> None:
    client = api_client["client"]
    headers = login(client)
    created = client.post(
        "/api/v1/sync/conflict-resolutions", json=resolution_payload(), headers=headers
    )
    assert created.status_code == 201, created.text

    # A different clinic's user sees none of this clinic's resolutions.
    other_headers = login(client, email="other@example.com")
    foreign_list = client.get(
        "/api/v1/sync/conflict-resolutions", headers=other_headers
    )
    assert foreign_list.status_code == 200
    assert foreign_list.json() == []

    # A different clinic's user cannot publish into this clinic: the record
    # is always scoped to the caller's own clinic.
    foreign_create = client.post(
        "/api/v1/sync/conflict-resolutions", json=resolution_payload(), headers=other_headers
    )
    assert foreign_create.status_code == 201
    assert foreign_create.json()["clinic_id"] == str(api_client["other_clinic_id"])

    own_list = client.get("/api/v1/sync/conflict-resolutions", headers=headers)
    assert own_list.status_code == 200
    assert len(own_list.json()) == 1
    assert own_list.json()[0]["id"] == created.json()["id"]


def test_conflict_resolution_listing_supports_limit_and_offset(api_client) -> None:
    client = api_client["client"]
    headers = login(client)
    for index in range(3):
        created = client.post(
            "/api/v1/sync/conflict-resolutions",
            json=resolution_payload(
                entity_id=f"33333333-3333-4444-5555-66666666666{index}",
                winner_source="server",
                field_decisions=[],
            ),
            headers=headers,
        )
        assert created.status_code == 201, created.text

    page = client.get(
        "/api/v1/sync/conflict-resolutions?limit=2&offset=0", headers=headers
    )
    assert page.status_code == 200
    first_page = page.json()
    assert len(first_page) == 2
    assert all(row["winner_source"] == "server" for row in first_page)

    second_page = client.get(
        "/api/v1/sync/conflict-resolutions?limit=2&offset=2", headers=headers
    )
    assert second_page.status_code == 200
    assert len(second_page.json()) == 1

    listed_ids = {row["id"] for row in first_page + second_page.json()}
    assert len(listed_ids) == 3
