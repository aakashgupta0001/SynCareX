from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from app.api.deps import get_current_user
from app.core.config import get_settings
from app.database import get_db
from app.models import AuditLog, RefreshSession, Role, User
from app.schemas.auth import AuthResponse, LoginRequest, UserRead
from app.security.passwords import verify_password
from app.security.tokens import hash_refresh_token, issue_access_token, issue_refresh_token

router = APIRouter(prefix="/auth", tags=["authentication"])
REFRESH_COOKIE = "syncarex_refresh"


def _set_refresh_cookie(response: Response, token: str) -> None:
    settings = get_settings()
    response.set_cookie(
        key=REFRESH_COOKIE,
        value=token,
        max_age=settings.refresh_token_days * 24 * 60 * 60,
        httponly=True,
        secure=settings.cookie_secure,
        samesite="strict",
        path="/api/v1/auth",
    )


def _user_read(user: User) -> UserRead:
    return UserRead(
        id=user.id,
        clinic_id=user.clinic_id,
        email=user.email,
        full_name=user.full_name,
        roles=[
            {
                "name": role.name,
                "permissions": [permission.key for permission in role.permissions],
            }
            for role in user.roles
        ],
    )


def _create_refresh_session(db: Session, user: User) -> tuple[RefreshSession, str]:
    settings = get_settings()
    token = issue_refresh_token()
    session = RefreshSession(
        user_id=user.id,
        token_hash=hash_refresh_token(token),
        expires_at=datetime.now(UTC) + timedelta(days=settings.refresh_token_days),
    )
    db.add(session)
    db.flush()
    return session, token


@router.post("/login", response_model=AuthResponse)
def login(
    body: LoginRequest,
    response: Response,
    db: Session = Depends(get_db),
) -> AuthResponse:
    user = db.scalar(
        select(User)
        .options(selectinload(User.roles).selectinload(Role.permissions))
        .where(func.lower(User.email) == body.email.lower())
    )
    if user is None or not user.is_active or not verify_password(
        body.password, user.password_hash
    ):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password",
        )

    session, refresh_token = _create_refresh_session(db, user)
    db.add(
        AuditLog(
            clinic_id=user.clinic_id,
            actor_id=user.id,
            action="auth.login",
            entity_type="session",
            entity_id=session.id,
            details={"client": "browser"},
        )
    )
    db.commit()
    _set_refresh_cookie(response, refresh_token)
    return AuthResponse(
        access_token=issue_access_token(user.id, session.id),
        user=_user_read(user),
    )


@router.post("/refresh", response_model=AuthResponse)
def refresh(
    response: Response,
    request: Request,
    db: Session = Depends(get_db),
) -> AuthResponse:
    token = request.cookies.get(REFRESH_COOKIE)
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Refresh session missing")
    session = db.scalar(
        select(RefreshSession)
        .where(RefreshSession.token_hash == hash_refresh_token(token))
        .with_for_update()
    )
    now = datetime.now(UTC)
    if (
        session is None
        or session.revoked_at is not None
        or (
            session.expires_at.replace(tzinfo=UTC)
            if session.expires_at.tzinfo is None
            else session.expires_at
        )
        <= now
    ):
        response.delete_cookie(REFRESH_COOKIE, path="/api/v1/auth", httponly=True, samesite="strict")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Refresh session expired")
    user = db.get(User, session.user_id)
    if user is None or not user.is_active:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Account is unavailable")

    next_session, next_token = _create_refresh_session(db, user)
    session.revoked_at = now
    session.replaced_by_id = next_session.id
    db.commit()
    _set_refresh_cookie(response, next_token)
    return AuthResponse(
        access_token=issue_access_token(user.id, next_session.id),
        user=_user_read(user),
    )


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(
    response: Response,
    request: Request,
    db: Session = Depends(get_db),
) -> Response:
    token = request.cookies.get(REFRESH_COOKIE)
    if token:
        session = db.scalar(
            select(RefreshSession).where(
                RefreshSession.token_hash == hash_refresh_token(token)
            )
        )
        if session is not None and session.revoked_at is None:
            session.revoked_at = datetime.now(UTC)
            db.commit()
    response.delete_cookie(
        REFRESH_COOKIE,
        path="/api/v1/auth",
        httponly=True,
        secure=get_settings().cookie_secure,
        samesite="strict",
    )
    response.status_code = status.HTTP_204_NO_CONTENT
    return response


@router.get("/me", response_model=UserRead)
def me(user: User = Depends(get_current_user)) -> UserRead:
    return _user_read(user)
