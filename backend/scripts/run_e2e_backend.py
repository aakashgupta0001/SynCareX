"""
Starts an isolated API instance for the end-to-end offline tests.

It creates a throwaway SQLite database, seeds the synthetic clinician that
the Playwright specs sign in as, and serves the API. Nothing here touches a
developer's own database, and the seeded account uses synthetic data only.
"""

import os
import sys
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_ROOT))

E2E_DB = BACKEND_ROOT / "var" / "e2e" / "e2e.db"
E2E_EMAIL = "e2e.clinician@example.com"
E2E_PASSWORD = "synthetic-e2e-passphrase"
PORT = int(os.environ.get("E2E_API_PORT", "8001"))


def configure() -> None:
    E2E_DB.parent.mkdir(parents=True, exist_ok=True)
    if E2E_DB.exists():
        E2E_DB.unlink()
    os.environ["DATABASE_URL"] = f"sqlite:///{E2E_DB.as_posix()}"
    os.environ["FRONTEND_ORIGINS"] = (
        '["http://localhost:4173","http://127.0.0.1:4173","http://localhost:5173"]'
    )
    os.environ["JWT_SECRET"] = "end-to-end-test-secret-not-for-deployment"
    os.environ["COOKIE_SECURE"] = "false"
    os.environ["APP_ENV"] = "test"
    os.environ["DOCUMENT_STORAGE_DIR"] = str(E2E_DB.parent / "documents")


def seed() -> None:
    from app.database import engine
    from app.models.entities import Base
    from app.models import Clinic, Permission, Role, User
    from app.security.passwords import hash_password
    from sqlalchemy.orm import Session

    Base.metadata.create_all(engine)
    with Session(engine) as db:
        clinic = Clinic(name="SynCareX End-to-End Clinic")
        db.add(clinic)
        db.flush()
        permissions = [
            Permission(key="patients.read", description="Read patient data"),
            Permission(key="patients.write", description="Write patient data"),
            Permission(key="audit.read", description="Read audit log"),
        ]
        role = Role(name="Doctor", permissions=permissions)
        db.add_all([*permissions, role])
        db.add(
            User(
                clinic_id=clinic.id,
                email=E2E_EMAIL,
                full_name="Dr. End To End",
                password_hash=hash_password(E2E_PASSWORD),
                roles=[role],
            )
        )
        db.commit()
    print(f"Seeded {E2E_EMAIL} in {E2E_DB}", flush=True)


def main() -> None:
    configure()
    seed()
    import uvicorn

    uvicorn.run("app.main:app", host="127.0.0.1", port=PORT, log_level="warning")


if __name__ == "__main__":
    main()
