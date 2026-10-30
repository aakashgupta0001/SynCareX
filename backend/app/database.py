from collections.abc import Generator

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import get_settings

database_url = get_settings().database_url
connect_args = {"check_same_thread": False} if database_url.startswith("sqlite") else {}
engine_kwargs = {"connect_args": connect_args} if connect_args else {}
engine = create_engine(
    database_url,
    pool_pre_ping=True,
    **engine_kwargs,
)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
