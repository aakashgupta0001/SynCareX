import hashlib
import secrets
from datetime import UTC, datetime, timedelta
from uuid import UUID

import jwt

from app.core.config import get_settings

ALGORITHM = "HS256"


def issue_access_token(user_id: UUID, session_id: UUID) -> str:
    settings = get_settings()
    now = datetime.now(UTC)
    return jwt.encode(
        {
            "sub": str(user_id),
            "sid": str(session_id),
            "iat": now,
            "exp": now + timedelta(minutes=settings.access_token_minutes),
            "type": "access",
        },
        settings.jwt_secret.get_secret_value(),
        algorithm=ALGORITHM,
    )


def issue_refresh_token() -> str:
    return secrets.token_urlsafe(48)


def hash_refresh_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def decode_access_token(token: str) -> dict[str, str]:
    payload = jwt.decode(
        token,
        get_settings().jwt_secret.get_secret_value(),
        algorithms=[ALGORITHM],
        options={"require": ["exp", "sub", "sid", "type"]},
    )
    if payload.get("type") != "access":
        raise jwt.InvalidTokenError("Not an access token")
    return payload
