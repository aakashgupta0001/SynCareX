def test_login_issues_short_lived_access_and_http_only_refresh_cookie(api_client) -> None:
    client = api_client["client"]
    response = client.post(
        "/api/v1/auth/login",
        json={"email": "DOCTOR@example.com", "password": "synthetic-test-password"},
    )

    assert response.status_code == 200, response.text
    assert response.json()["token_type"] == "bearer"
    assert response.json()["user"]["email"] == "doctor@example.com"
    assert response.json()["user"]["roles"][0]["name"] == "Doctor"
    cookie = response.headers["set-cookie"].lower()
    assert "httponly" in cookie
    assert "samesite=strict" in cookie
    assert "syncarex_refresh" in client.cookies


def test_invalid_login_does_not_disclose_account_state(api_client) -> None:
    response = api_client["client"].post(
        "/api/v1/auth/login",
        json={"email": "doctor@example.com", "password": "wrong-password"},
    )

    assert response.status_code == 401
    assert response.json()["detail"] == "Invalid email or password"


def test_refresh_rotates_session_and_logout_revokes_access(api_client) -> None:
    client = api_client["client"]
    login_response = client.post(
        "/api/v1/auth/login",
        json={"email": "doctor@example.com", "password": "synthetic-test-password"},
    )
    old_token = login_response.json()["access_token"]

    refresh_response = client.post("/api/v1/auth/refresh")
    assert refresh_response.status_code == 200
    new_token = refresh_response.json()["access_token"]
    assert new_token != old_token
    assert client.get(
        "/api/v1/auth/me", headers={"Authorization": f"Bearer {old_token}"}
    ).status_code == 401
    assert client.get(
        "/api/v1/auth/me", headers={"Authorization": f"Bearer {new_token}"}
    ).status_code == 200

    assert client.post("/api/v1/auth/logout").status_code == 204
    assert client.get(
        "/api/v1/auth/me", headers={"Authorization": f"Bearer {new_token}"}
    ).status_code == 401
