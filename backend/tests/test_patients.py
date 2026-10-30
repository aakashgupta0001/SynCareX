from uuid import uuid4


def login(client, email="doctor@example.com"):
    response = client.post(
        "/api/v1/auth/login",
        json={"email": email, "password": "synthetic-test-password"},
    )
    assert response.status_code == 200, response.text
    return response.json()["access_token"]


def patient_payload(**overrides):
    return {
        "full_name": "Synthetic Patient",
        "estimated_age": 34,
        "gender": "Prefer not to disclose",
        "contact_phone": "+91-00000-00000",
        "village": "Demonstration Village",
        "allergies": ["unknown"],
        **overrides,
    }


def test_patient_crud_search_pagination_and_audit(api_client) -> None:
    client = api_client["client"]
    token = login(client)
    headers = {"Authorization": f"Bearer {token}"}

    created = client.post(
        "/api/v1/patients", json=patient_payload(), headers=headers
    )
    assert created.status_code == 201
    patient = created.json()
    assert patient["patient_number"].startswith("SCX-")
    assert patient["version"] == 1

    listed = client.get("/api/v1/patients?search=Demonstration&page=1&page_size=1", headers=headers)
    assert listed.status_code == 200
    assert listed.json()["total"] == 1
    assert listed.json()["items"][0]["id"] == patient["id"]
    assert listed.json()["pages"] == 1

    fetched = client.get(f"/api/v1/patients/{patient['id']}", headers=headers)
    assert fetched.status_code == 200
    assert fetched.json()["allergies"] == ["unknown"]

    updated = client.patch(
        f"/api/v1/patients/{patient['id']}",
        json={"village": "Updated Demonstration Village", "expected_version": 1},
        headers=headers,
    )
    assert updated.status_code == 200
    assert updated.json()["version"] == 2
    assert updated.json()["village"] == "Updated Demonstration Village"

    audit = client.get("/api/v1/audit", headers=headers)
    assert audit.status_code == 200
    assert {event["action"] for event in audit.json()["items"]} >= {
        "auth.login",
        "patient.create",
        "patient.update",
    }


def test_patient_update_rejects_stale_version_without_overwriting(api_client) -> None:
    client = api_client["client"]
    token = login(client)
    headers = {"Authorization": f"Bearer {token}"}
    created = client.post("/api/v1/patients", json=patient_payload(), headers=headers)
    patient_id = created.json()["id"]

    first = client.patch(
        f"/api/v1/patients/{patient_id}",
        json={"village": "First edit", "expected_version": 1},
        headers=headers,
    )
    stale = client.patch(
        f"/api/v1/patients/{patient_id}",
        json={"village": "Conflicting edit", "expected_version": 1},
        headers=headers,
    )

    assert first.status_code == 200
    assert stale.status_code == 409
    current = client.get(f"/api/v1/patients/{patient_id}", headers=headers).json()
    assert current["village"] == "First edit"
    assert current["version"] == 2


def test_patient_create_and_update_retries_are_idempotent(api_client) -> None:
    client = api_client["client"]
    headers = {"Authorization": f"Bearer {login(client)}"}
    patient_id = str(uuid4())
    payload = patient_payload(id=patient_id)
    first = client.post("/api/v1/patients", json=payload, headers=headers)
    replay = client.post("/api/v1/patients", json=payload, headers=headers)
    assert first.status_code == 201
    assert replay.status_code == 201
    assert replay.json()["id"] == patient_id

    update = {"village": "Offline edit", "expected_version": 1}
    first_update = client.patch(
        f"/api/v1/patients/{patient_id}", json=update, headers=headers
    )
    replay_update = client.patch(
        f"/api/v1/patients/{patient_id}", json=update, headers=headers
    )
    assert first_update.status_code == 200
    assert replay_update.status_code == 200
    assert replay_update.json()["version"] == 2


def test_server_enforces_auth_rbac_and_clinic_isolation(api_client) -> None:
    client = api_client["client"]
    assert client.get("/api/v1/patients").status_code == 401
    nurse_token = login(client, "nurse@example.com")
    nurse_headers = {"Authorization": f"Bearer {nurse_token}"}
    assert client.get("/api/v1/patients", headers=nurse_headers).status_code == 200
    assert client.get("/api/v1/audit", headers=nurse_headers).status_code == 403

    doctor_token = login(client)
    doctor_headers = {"Authorization": f"Bearer {doctor_token}"}
    response = client.get(
        f"/api/v1/patients/{api_client['other_patient_id']}",
        headers=doctor_headers,
    )
    assert response.status_code == 404


def test_patient_validation_and_pagination_bounds(api_client) -> None:
    client = api_client["client"]
    headers = {"Authorization": f"Bearer {login(client)}"}
    missing_age = client.post(
        "/api/v1/patients",
        json={"full_name": "Synthetic Patient"},
        headers=headers,
    )
    excessive_age = client.post(
        "/api/v1/patients",
        json=patient_payload(estimated_age=131),
        headers=headers,
    )
    future_dob = client.post(
        "/api/v1/patients",
        json=patient_payload(date_of_birth="2999-01-01", estimated_age=None),
        headers=headers,
    )
    invalid_page = client.get("/api/v1/patients?page=0", headers=headers)

    assert missing_age.status_code == 422
    assert excessive_age.status_code == 422
    assert future_dob.status_code == 422
    assert invalid_page.status_code == 422
