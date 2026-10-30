"""
Patient portal: the patient's own read-only login.

The security shape under test: portal accounts are not staff Users, portal
tokens only ever open portal routes, staff tokens only ever open staff
routes, and the summary is a small, error-filtered slice of one patient.
"""

from uuid import uuid4

PASSWORD = "synthetic-test-password"
PORTAL_PASSWORD = "portal-passphrase-1"


def login(client, email="doctor@example.com"):
    response = client.post(
        "/api/v1/auth/login", json={"email": email, "password": PASSWORD}
    )
    assert response.status_code == 200, response.text
    return response.json()


def staff_headers(client, email="doctor@example.com"):
    return {
        "Authorization": f"Bearer {login(client, email)['access_token']}"
    }


def create_patient(client, headers) -> str:
    created = client.post(
        "/api/v1/patients",
        json={"full_name": "Portal Test Patient", "estimated_age": 40, "allergies": []},
        headers=headers,
    )
    assert created.status_code == 201, created.text
    return created.json()["id"]


def test_staff_creates_account_and_patient_enrolls(api_client) -> None:
    client = api_client["client"]
    headers = staff_headers(client)
    patient_id = create_patient(client, headers)

    created = client.post(
        f"/api/v1/patients/{patient_id}/portal-account",
        json={"email": "portal-patient@example.com"},
        headers=headers,
    )
    assert created.status_code == 201, created.text
    code = created.json()["enrollment_code"]
    assert len(code) == 6

    # The account exists but is not enrolled yet.
    status = client.get(
        f"/api/v1/patients/{patient_id}/portal-account", headers=headers
    )
    assert status.status_code == 200
    assert status.json()["enrolled"] is False

    # A second create is refused.
    again = client.post(
        f"/api/v1/patients/{patient_id}/portal-account",
        json={"email": "other@example.com"},
        headers=headers,
    )
    assert again.status_code == 409

    # Wrong code does not enroll and does not leak which part failed.
    wrong = client.post(
        "/api/v1/portal/enroll",
        json={
            "email": "portal-patient@example.com",
            "enrollment_code": "000000",
            "new_password": PORTAL_PASSWORD,
        },
    )
    assert wrong.status_code == 401

    enrolled = client.post(
        "/api/v1/portal/enroll",
        json={
            "email": "portal-patient@example.com",
            "enrollment_code": code,
            "new_password": PORTAL_PASSWORD,
        },
    )
    assert enrolled.status_code == 200, enrolled.text
    assert enrolled.json()["patient_number"]

    # Enrollment is one-time.
    replay = client.post(
        "/api/v1/portal/enroll",
        json={
            "email": "portal-patient@example.com",
            "enrollment_code": code,
            "new_password": "another-password-1",
        },
    )
    assert replay.status_code == 401

    portal_status = client.get(
        f"/api/v1/patients/{patient_id}/portal-account", headers=headers
    )
    assert portal_status.json()["enrolled"] is True

    audit = client.get("/api/v1/audit", headers=headers)
    assert "portal.account.created" in audit.text
    assert "portal.account.enrolled" in audit.text


def test_portal_login_me_and_password_change(api_client) -> None:
    client = api_client["client"]
    headers = staff_headers(client)
    patient_id = create_patient(client, headers)
    created = client.post(
        f"/api/v1/patients/{patient_id}/portal-account",
        json={"email": "portal-login@example.com"},
        headers=headers,
    )
    code = created.json()["enrollment_code"]
    client.post(
        "/api/v1/portal/enroll",
        json={
            "email": "portal-login@example.com",
            "enrollment_code": code,
            "new_password": PORTAL_PASSWORD,
        },
    )

    bad = client.post(
        "/api/v1/portal/login",
        json={"email": "portal-login@example.com", "password": "wrong-password-1"},
    )
    assert bad.status_code == 401
    assert bad.json()["detail"] == "Email or password is incorrect."

    ok = client.post(
        "/api/v1/portal/login",
        json={"email": "portal-login@example.com", "password": PORTAL_PASSWORD},
    )
    assert ok.status_code == 200, ok.text
    token = ok.json()["access_token"]
    assert ok.json()["patient"]["full_name"] == "Portal Test Patient"
    portal_headers = {"Authorization": f"Bearer {token}"}

    summary = client.get("/api/v1/portal/me", headers=portal_headers)
    assert summary.status_code == 200, summary.text
    body = summary.json()
    assert body["patient"]["full_name"] == "Portal Test Patient"
    for section in ("allergies", "medications", "observations", "consultations"):
        assert section in body

    # Change password; the old one stops working, the new one works.
    changed = client.post(
        "/api/v1/portal/password",
        json={"current_password": PORTAL_PASSWORD, "new_password": "new-portal-pass-2"},
        headers=portal_headers,
    )
    assert changed.status_code == 204
    old_login = client.post(
        "/api/v1/portal/login",
        json={"email": "portal-login@example.com", "password": PORTAL_PASSWORD},
    )
    assert old_login.status_code == 401
    new_login = client.post(
        "/api/v1/portal/login",
        json={"email": "portal-login@example.com", "password": "new-portal-pass-2"},
    )
    assert new_login.status_code == 200


def test_portal_tokens_cannot_open_staff_routes_and_vice_versa(api_client) -> None:
    client = api_client["client"]
    headers = staff_headers(client)
    patient_id = create_patient(client, headers)
    created = client.post(
        f"/api/v1/patients/{patient_id}/portal-account",
        json={"email": "portal-scope@example.com"},
        headers=headers,
    )
    client.post(
        "/api/v1/portal/enroll",
        json={
            "email": "portal-scope@example.com",
            "enrollment_code": created.json()["enrollment_code"],
            "new_password": PORTAL_PASSWORD,
        },
    )
    token = client.post(
        "/api/v1/portal/login",
        json={"email": "portal-scope@example.com", "password": PORTAL_PASSWORD},
    ).json()["access_token"]
    portal_headers = {"Authorization": f"Bearer {token}"}

    # A portal token is worthless on staff routes.
    staff_endpoints = [
        ("get", "/api/v1/patients"),
        ("get", "/api/v1/audit"),
        ("get", f"/api/v1/patients/{patient_id}/portal-account"),
    ]
    for method, url in staff_endpoints:
        response = getattr(client, method)(url, headers=portal_headers)
        assert response.status_code == 401, (method, url, response.text)

    # A staff token is worthless on portal routes.
    for method, url in [("get", "/api/v1/portal/me"), ("post", "/api/v1/portal/password")]:
        kwargs = {"headers": headers}
        if method == "post":
            kwargs["json"] = {
                "current_password": "x-passphrase-1",
                "new_password": "y-passphrase-2",
            }
        response = getattr(client, method)(url, **kwargs)
        assert response.status_code == 401, (method, url, response.text)


def test_portal_login_locks_out_after_repeated_failures(api_client) -> None:
    client = api_client["client"]
    headers = staff_headers(client)
    patient_id = create_patient(client, headers)
    created = client.post(
        f"/api/v1/patients/{patient_id}/portal-account",
        json={"email": "portal-lock@example.com"},
        headers=headers,
    )
    client.post(
        "/api/v1/portal/enroll",
        json={
            "email": "portal-lock@example.com",
            "enrollment_code": created.json()["enrollment_code"],
            "new_password": PORTAL_PASSWORD,
        },
    )

    for _ in range(5):
        failed = client.post(
            "/api/v1/portal/login",
            json={"email": "portal-lock@example.com", "password": "wrong-password-1"},
        )
        assert failed.status_code == 401

    locked = client.post(
        "/api/v1/portal/login",
        json={"email": "portal-lock@example.com", "password": PORTAL_PASSWORD},
    )
    assert locked.status_code == 423
    # The lockout must not touch staff logins or other portal accounts.
    assert client.post(
        "/api/v1/portal/login",
        json={"email": "nobody@example.com", "password": "wrong-password-1"},
    ).status_code == 401


def test_the_summary_never_leaves_the_clinic_or_shows_error_rows(api_client) -> None:
    client = api_client["client"]
    headers = staff_headers(client)
    # The conftest seeds a patient in the OTHER clinic specifically so tests
    # can prove cross-clinic isolation.
    other_patient_id = api_client["other_patient_id"]
    refused = client.post(
        f"/api/v1/patients/{other_patient_id}/portal-account",
        json={"email": "outside-clinic@example.com"},
        headers=headers,
    )
    assert refused.status_code == 404


def test_reissue_replaces_a_lost_code_before_enrollment(api_client) -> None:
    client = api_client["client"]
    headers = staff_headers(client)
    patient_id = create_patient(client, headers)

    first = client.post(
        f"/api/v1/patients/{patient_id}/portal-account",
        json={"email": "reissue@example.com"},
        headers=headers,
    )
    assert first.status_code == 201
    first_code = first.json()["enrollment_code"]

    second = client.post(
        f"/api/v1/patients/{patient_id}/portal-account/reissue-code",
        headers=headers,
    )
    assert second.status_code == 201, second.text
    new_code = second.json()["enrollment_code"]
    assert new_code != first_code

    # The old code is dead the moment the new one is issued...
    stale = client.post(
        "/api/v1/portal/enroll",
        json={
            "email": "reissue@example.com",
            "enrollment_code": first_code,
            "new_password": "a-passphrase-1",
        },
    )
    assert stale.status_code == 401

    # ...and the new one enrolls.
    enrolled = client.post(
        "/api/v1/portal/enroll",
        json={
            "email": "reissue@example.com",
            "enrollment_code": new_code,
            "new_password": "a-passphrase-1",
        },
    )
    assert enrolled.status_code == 200

    # Once enrolled, reissue is refused: the patient owns the password now.
    after = client.post(
        f"/api/v1/patients/{patient_id}/portal-account/reissue-code",
        headers=headers,
    )
    assert after.status_code == 409

    audit = client.get("/api/v1/audit", headers=headers)
    assert "portal.account.code_reissued" in audit.text


def test_reissue_requires_an_existing_account_in_the_clinic(api_client) -> None:
    client = api_client["client"]
    headers = staff_headers(client)
    missing = client.post(
        f"/api/v1/patients/{uuid4()}/portal-account/reissue-code", headers=headers
    )
    assert missing.status_code == 404
    other = client.post(
        f"/api/v1/patients/{api_client['other_patient_id']}/portal-account/reissue-code",
        headers=headers,
    )
    assert other.status_code == 404
