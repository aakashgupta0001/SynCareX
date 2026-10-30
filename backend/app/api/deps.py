from collections.abc import Callable
from uuid import UUID
from datetime import UTC, datetime

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.database import get_db
from app.models import RefreshSession, Role, User
from app.security.tokens import decode_access_token

bearer_scheme = HTTPBearer(auto_error=False)


def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
    db: Session = Depends(get_db),
) -> User:
    unauthorized = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Authentication required",
        headers={"WWW-Authenticate": "Bearer"},
    )
    if credentials is None:
        raise unauthorized
    try:
        payload = decode_access_token(credentials.credentials)
        user_id = UUID(payload["sub"])
        session_id = UUID(payload["sid"])
    except (jwt.InvalidTokenError, KeyError, ValueError):
        raise unauthorized from None

    session = db.get(RefreshSession, session_id)
    if (
        session is None
        or session.user_id != user_id
        or session.revoked_at is not None
        or (
            session.expires_at.replace(tzinfo=UTC)
            if session.expires_at.tzinfo is None
            else session.expires_at
        )
        <= datetime.now(UTC)
    ):
        raise unauthorized
    user = db.scalar(
        select(User)
        .options(selectinload(User.roles).selectinload(Role.permissions))
        .where(User.id == user_id, User.is_active.is_(True))
    )
    if user is None:
        raise unauthorized
    db.info["sync_actor_id"] = user.id
    return user


def require_permission(permission: str) -> Callable:
    def dependency(user: User = Depends(get_current_user)) -> User:
        permissions = {
            grant.key for role in user.roles for grant in role.permissions
        }
        if permission not in permissions:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="You are not authorized to perform this action",
            )
        return user

    return dependency
