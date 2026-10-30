"""Login throttling: consecutive failures lock the account out.

The lockout is the difference between a login page and an unlimited online
guessing oracle. These tests pin the behaviors that matter under attack and
that must not punish a legitimate clinician.
"""

from tests.conftest import TEST_PASSWORD

PASSWORD = TEST_PASSWORD
VICTIM = "doctor@example.com"
ATTACKER_TARGET = "nurse@example.com"

LOCKED = 423


def test_consecutive_failures_lock_the_account_out(api_client) -> None:
    client = api_client["client"]
    for _ in range(5):
        failed = client.post(
            "/api/v1/auth/login", json={"email": VICTIM, "password": "not-the-password"}
        )
        assert failed.status_code == 401

    # The correct password is refused too: the lock, not the credential,
    # decides now.
    locked = client.post("/api/v1/auth/login", json={"email": VICTIM, "password": PASSWORD})
    assert locked.status_code == LOCKED
    assert "Try again" in locked.json()["detail"]
    assert "Retry-After" in locked.headers

    # An unknown address gets the same refusal with the same shape, so the
    # lockout cannot be used to tell which emails exist.
    ghost = client.post(
        "/api/v1/auth/login", json={"email": "ghost@example.com", "password": PASSWORD}
    )
    assert ghost.status_code == 401


def test_a_lock_on_one_address_does_not_touch_another(api_client) -> None:
    client = api_client["client"]
    for _ in range(5):
        client.post("/api/v1/auth/login", json={"email": VICTIM, "password": "wrong"})

    # A different account (or an address with no failures) is unaffected.
    ok = client.post(
        "/api/v1/auth/login", json={"email": ATTACKER_TARGET, "password": PASSWORD}
    )
    assert ok.status_code == 200


def test_success_resets_the_failure_count(api_client) -> None:
    client = api_client["client"]
    for _ in range(4):
        client.post("/api/v1/auth/login", json={"email": VICTIM, "password": "wrong"})

    # One short of the lockout, a real sign-in wipes the slate: a clinician
    # who fumbles the passphrase a few times is never locked out for it.
    assert (
        client.post("/api/v1/auth/login", json={"email": VICTIM, "password": PASSWORD}).status_code
        == 200
    )
    for _ in range(4):
        assert (
            client.post("/api/v1/auth/login", json={"email": VICTIM, "password": "wrong"}).status_code
            == 401
        )
    assert (
        client.post("/api/v1/auth/login", json={"email": VICTIM, "password": PASSWORD}).status_code
        == 200
    )


def test_unknown_addresses_are_throttled_like_real_ones(api_client) -> None:
    client = api_client["client"]
    absent = "no-such-account@example.com"
    for _ in range(5):
        assert (
            client.post("/api/v1/auth/login", json={"email": absent, "password": "x"}).status_code
            == 401
        )
    locked = client.post("/api/v1/auth/login", json={"email": absent, "password": "x"})
    assert locked.status_code == LOCKED
