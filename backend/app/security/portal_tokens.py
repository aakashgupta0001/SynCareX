"""Tokens for the patient portal: a separate type from staff access tokens.

The two token kinds share the signing secret but nothing else. A portal
token carries ``type: "portal"`` and the patient id as ``sub``; it has no
session id, so the staff ``decode_access_token`` (which requires ``sid``)
rejects it outright, and ``decode_portal_token`` here requires the portal
type, so a staff token can never open a portal route either.
"""

import uuid
from datetime import UTC, datetime, timedelta

import jwt

from app.core.config import get_settings

ALGORITHM = "HS256"
PORTAL_TOKEN_HOURS = 12


def issue_portal_token(patient_id: uuid.UUID) -> str:
    settings = get_settings()
    now = datetime.now(UTC)
    return jwt.encode(
        {
            "sub": str(patient_id),
            "scope": "patient_portal",
            "iat": now,
            "exp": now + timedelta(hours=PORTAL_TOKEN_HOURS),
            "type": "portal",
        },
        settings.jwt_secret.get_secret_value(),
        algorithm=ALGORITHM,
    )


def decode_portal_token(token: str) -> uuid.UUID:
    payload = jwt.decode(
        token,
        get_settings().jwt_secret.get_secret_value(),
        algorithms=[ALGORITHM],
        options={"require": ["exp", "sub", "type", "scope"]},
    )
    if payload.get("type") != "portal" or payload.get("scope") != "patient_portal":
        raise jwt.InvalidTokenError("Not a patient portal token")
    return uuid.UUID(payload["sub"])
