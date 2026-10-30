def test_health_check(api_client) -> None:
    response = api_client["client"].get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_preview_origin_is_allowed_for_login_preflight(api_client) -> None:
    response = api_client["client"].request(
        "OPTIONS",
        "/api/v1/auth/login",
        headers={
            "Origin": "http://127.0.0.1:4173",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
        },
    )

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "http://127.0.0.1:4173"
