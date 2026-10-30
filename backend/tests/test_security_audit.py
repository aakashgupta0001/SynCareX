"""
Security regression tests derived from the Phase 7 audit.

These enumerate the live route table rather than a hand-written list, so a
route added later is covered automatically.
"""

from uuid import uuid4

import pytest

from app.main import app

PASSWORD = "synthetic-test-password"

# Endpoints that are unauthenticated by design.
PUBLIC_PATHS = {
    "/health",
    "/api/v1/openapi.json",
    "/api/v1/docs",
    "/redoc",
    "/docs/oauth2-redirect",
    "/api/v1/auth/login",
    "/api/v1/auth/refresh",
    "/api/v1/auth/logout",
}


def protected_routes() -> list[tuple[str, str]]:
    routes: list[tuple[str, str]] = []
    for path, operations in app.openapi()["paths"].items():
        if path in PUBLIC_PATHS:
            continue
        for method in operations:
            if method.upper() in {"GET", "POST", "PATCH", "PUT", "DELETE"}:
                routes.append((method.upper(), path))
    return sorted(routes)


def concrete(path: str) -> str:
    """Fills path parameters with a syntactically valid but absent id."""
    out = path
    while "{" in out:
        start = out.index("{")
        end = out.index("}", start)
        out = out[:start] + str(uuid4()) + out[end + 1 :]
    return out


def login(client, email="doctor@example.com"):
    response = client.post(
        "/api/v1/auth/login", json={"email": email, "password": PASSWORD}
    )
    assert response.status_code == 200, response.text
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


def test_the_route_table_is_not_empty(api_client) -> None:
    # Guards against a refactor that silently empties the enumeration and
    # makes the test below pass for the wrong reason.
    assert len(protected_routes()) >= 20


@pytest.mark.parametrize("method,path", protected_routes())
def test_every_protected_route_rejects_an_anonymous_request(
    api_client, method: str, path: str
) -> None:
    client = api_client["client"]
    response = client.request(method, concrete(path), json={})
    # 401/403 is the point. 422 is acceptable only because request validation
    # may run first; what must never happen is a 2xx without credentials.
    assert not 200 <= response.status_code < 300, (
        f"{method} {path} answered {response.status_code} without credentials"
    )
    assert response.status_code in {401, 403, 422}


@pytest.mark.parametrize("method,path", protected_routes())
def test_every_protected_route_rejects_a_forged_bearer_token(
    api_client, method: str, path: str
) -> None:
    client = api_client["client"]
    response = client.request(
        method,
        concrete(path),
        json={},
        headers={"Authorization": "Bearer not-a-real-token"},
    )
    assert not 200 <= response.status_code < 300, (
        f"{method} {path} accepted a forged token with {response.status_code}"
    )
    assert response.status_code in {401, 403, 422}


def test_an_access_token_signed_with_the_wrong_secret_is_refused(api_client) -> None:
    import jwt

    forged = jwt.encode(
        {
            "sub": str(uuid4()),
            "sid": str(uuid4()),
            "type": "access",
            "exp": 9999999999,
        },
        "an-attacker-chosen-secret",
        algorithm="HS256",
    )
    response = api_client["client"].get(
        "/api/v1/patients", headers={"Authorization": f"Bearer {forged}"}
    )
    assert response.status_code == 401


def test_an_unsigned_none_algorithm_token_is_refused(api_client) -> None:
    import base64
    import json

    def segment(data: dict) -> str:
        return base64.urlsafe_b64encode(json.dumps(data).encode()).rstrip(b"=").decode()

    token = (
        f"{segment({'alg': 'none', 'typ': 'JWT'})}."
        f"{segment({'sub': str(uuid4()), 'sid': str(uuid4()), 'type': 'access', 'exp': 9999999999})}."
    )
    response = api_client["client"].get(
        "/api/v1/patients", headers={"Authorization": f"Bearer {token}"}
    )
    assert response.status_code == 401


def test_a_refresh_token_cannot_be_used_as_an_access_token(api_client) -> None:
    client = api_client["client"]
    login(client)
    refresh_cookie = client.cookies.get("syncarex_refresh")
    assert refresh_cookie, "the refresh cookie should have been set by login"
    response = client.get(
        "/api/v1/patients", headers={"Authorization": f"Bearer {refresh_cookie}"}
    )
    assert response.status_code == 401


def test_logout_invalidates_the_access_token_it_was_issued_with(api_client) -> None:
    client = api_client["client"]
    headers = login(client)
    assert client.get("/api/v1/patients", headers=headers).status_code == 200

    assert client.post("/api/v1/auth/logout").status_code == 204
    # The access token embeds the session id, so revoking the session must
    # stop the token working even before it expires.
    assert client.get("/api/v1/patients", headers=headers).status_code == 401


def test_a_client_supplied_clinic_or_actor_identifier_is_ignored(api_client) -> None:
    client = api_client["client"]
    headers = login(client)
    other_clinic = str(uuid4())
    created = client.post(
        "/api/v1/patients",
        json={
            "full_name": "Synthetic Injection Patient",
            "estimated_age": 30,
            "allergies": [],
            # These must not influence where the record lands.
            "clinic_id": other_clinic,
            "created_by": str(uuid4()),
            "version": 99,
        },
        headers=headers,
    )
    assert created.status_code == 201, created.text
    body = created.json()
    assert body["clinic_id"] != other_clinic
    assert body["clinic_id"] == str(api_client["clinic_id"])
    assert body["version"] == 1


def test_another_clinics_patient_is_not_readable_or_writable(api_client) -> None:
    client = api_client["client"]
    headers = login(client)
    foreign = api_client["other_patient_id"]

    assert client.get(f"/api/v1/patients/{foreign}", headers=headers).status_code == 404
    patched = client.patch(
        f"/api/v1/patients/{foreign}",
        json={"village": "Cross-clinic write attempt"},
        headers=headers,
    )
    assert patched.status_code == 404


def test_sql_injection_in_the_search_parameter_is_parameterized(api_client) -> None:
    client = api_client["client"]
    headers = login(client)
    client.post(
        "/api/v1/patients",
        json={
            "full_name": "Synthetic Injection Target",
            "estimated_age": 44,
            "allergies": [],
        },
        headers=headers,
    )
    for payload in [
        "'; DROP TABLE patients; --",
        "' OR '1'='1",
        "%' UNION SELECT password_hash FROM users --",
    ]:
        response = client.get("/api/v1/patients", params={"search": payload}, headers=headers)
        assert response.status_code == 200, response.text
        # A working injection would return rows; a parameterized query cannot.
        assert response.json()["total"] == 0

    # The table is still there afterwards.
    assert client.get("/api/v1/patients", headers=headers).json()["total"] == 1


def test_pagination_is_bounded(api_client) -> None:
    client = api_client["client"]
    headers = login(client)
    assert client.get("/api/v1/patients?page_size=100000", headers=headers).status_code == 422
    assert client.get("/api/v1/patients?page=0", headers=headers).status_code == 422
    assert client.get("/api/v1/patients?page=-1", headers=headers).status_code == 422


def test_malformed_and_oversized_payloads_are_rejected_cleanly(api_client) -> None:
    client = api_client["client"]
    headers = login(client)

    malformed = client.post(
        "/api/v1/patients",
        content=b"{not json at all",
        headers={**headers, "Content-Type": "application/json"},
    )
    assert malformed.status_code == 422

    oversized = client.post(
        "/api/v1/patients",
        json={"full_name": "A" * 100_000, "estimated_age": 30, "allergies": []},
        headers=headers,
    )
    assert oversized.status_code == 422

    bad_identifier = client.get("/api/v1/patients/not-a-uuid", headers=headers)
    assert bad_identifier.status_code == 422


def test_error_responses_do_not_leak_internals(api_client) -> None:
    client = api_client["client"]
    headers = login(client)
    responses = [
        client.get("/api/v1/patients/not-a-uuid", headers=headers),
        client.get(f"/api/v1/patients/{uuid4()}", headers=headers),
        client.post("/api/v1/auth/login", json={"email": "nobody@example.com", "password": "x"}),
    ]
    for response in responses:
        body = response.text.lower()
        for leak in ["traceback", "sqlalchemy", "select ", "password_hash", "jwt_secret", "c:\\\\users"]:
            assert leak not in body, f"{leak!r} appeared in an error response"


def production_settings(**overrides):
    from app.core.config import Settings

    base = {
        "app_env": "production",
        "cookie_secure": True,
        "jwt_secret": "a-unique-production-secret-value-long-enough",
        "database_url": "postgresql+psycopg://user:pass@db.internal/syncarex",
    }
    base.update(overrides)
    return Settings(**base)


def test_a_correctly_configured_production_environment_starts() -> None:
    assert production_settings().is_production is True


@pytest.mark.parametrize(
    "overrides,reason",
    [
        ({"jwt_secret": "development-only-change-before-deployment"}, "shipped default secret"),
        ({"jwt_secret": "too-short"}, "short secret"),
        ({"cookie_secure": False}, "insecure cookies"),
        ({"database_url": "sqlite:///./syncarex.db"}, "development database"),
        ({"seed_admin_password": "seed-password-1"}, "seed account password"),
    ],
)
def test_production_refuses_to_start_on_development_defaults(overrides, reason) -> None:
    with pytest.raises(Exception):
        production_settings(**overrides)


def test_the_interactive_docs_are_not_served_in_production() -> None:
    # The app object is built from settings at import time, so this asserts
    # the wiring rather than rebuilding the application.
    import inspect

    import app.main as main_module

    source = inspect.getsource(main_module)
    assert "is_production else \"/api/v1/docs\"" in source
    assert "is_production else \"/api/v1/openapi.json\"" in source
