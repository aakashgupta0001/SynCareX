"""Per-account login throttling: consecutive failures trigger a lockout.

Without this, the login endpoint is an unlimited online guessing oracle for
account passwords. The counter is keyed by email (see `LoginAttemptCounter`)
so an unknown address is throttled exactly like a real one, and the lockout
response is the same for both.

Lockout policy: the fifth consecutive failure arms a 15-second lock that
doubles with every further failure, up to 15 minutes. A successful sign-in
resets the counter, so a clinician who fumbles their passphrase twice is
never punished for it later.
"""

from datetime import UTC, datetime, timedelta

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models import LoginAttemptCounter

FAILURES_BEFORE_LOCK = 5
BASE_LOCK = timedelta(seconds=15)
MAX_LOCK = timedelta(minutes=15)


def _lock_duration(failures: int) -> timedelta:
    return min(BASE_LOCK * 2 ** (failures - FAILURES_BEFORE_LOCK), MAX_LOCK)


def _as_utc(moment: datetime) -> datetime:
    return moment.replace(tzinfo=UTC) if moment.tzinfo is None else moment


def _counter(db: Session, email: str) -> LoginAttemptCounter | None:
    return db.scalar(
        select(LoginAttemptCounter)
        .where(LoginAttemptCounter.email == email)
        .with_for_update()
    )


def ensure_not_locked(db: Session, email: str) -> None:
    """Refuses the attempt while a lock is active. Reads only."""
    counter = _counter(db, email)
    if counter is None or counter.locked_until is None:
        return
    remaining = _as_utc(counter.locked_until) - datetime.now(UTC)
    if remaining <= timedelta(0):
        return
    seconds = int(remaining.total_seconds()) + 1
    raise HTTPException(
        status_code=status.HTTP_423_LOCKED,
        detail=f"Too many failed sign-in attempts. Try again in {seconds} seconds.",
        headers={"Retry-After": str(seconds)},
    )


def record_failure(db: Session, email: str) -> None:
    """Counts the failure and (re)arms the lock. Commits its own transaction,
    because the caller raises immediately afterwards."""
    for _ in range(2):
        counter = _counter(db, email)
        if counter is None:
            counter = LoginAttemptCounter(email=email, failed_attempts=0)
            db.add(counter)
        counter.failed_attempts += 1
        if counter.failed_attempts >= FAILURES_BEFORE_LOCK:
            counter.locked_until = datetime.now(UTC) + _lock_duration(
                counter.failed_attempts
            )
        try:
            db.commit()
            return
        except IntegrityError:
            # Two first-ever failures raced to insert the same row; retry on
            # the row the winner created.
            db.rollback()


def record_success(db: Session, email: str) -> None:
    """Clears the counter. Deliberately uncommitted: it rides the login's own
    commit, so a failed commit cannot leave a half-forgiven counter behind."""
    counter = _counter(db, email)
    if counter is not None:
        db.delete(counter)
