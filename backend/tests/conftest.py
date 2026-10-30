import asyncio
from typing import Any

import httpx
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.config import get_settings
from app.database import get_db
from app.main import app
from app.models import Clinic, Permission, Role, User
from app.models.entities import Base
from app.security.passwords import hash_password

TEST_EMAIL = "doctor@example.com"
TEST_PASSWORD = "synthetic-test-password"


class APIClient:
    def __init__(self) -> None:
        self.cookies = httpx.Cookies()

    def request(self, method: str, url: str, **kwargs: Any) -> httpx.Response:
        async def send() -> httpx.Response:
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app),
                base_url="http://testserver",
                cookies=self.cookies,
            ) as client:
                response = await client.request(method, url, **kwargs)
                self.cookies.update(client.cookies)
                return response

        return asyncio.run(send())

    def get(self, url: str, **kwargs: Any) -> httpx.Response:
        return self.request("GET", url, **kwargs)

    def post(self, url: str, **kwargs: Any) -> httpx.Response:
        return self.request("POST", url, **kwargs)

    def patch(self, url: str, **kwargs: Any) -> httpx.Response:
        return self.request("PATCH", url, **kwargs)


@pytest.fixture
def api_client(tmp_path) -> Any:
    # Documents are written under the test's own directory, never the
    # developer's working tree.
    settings = get_settings()
    original_storage = settings.document_storage_dir
    settings.document_storage_dir = tmp_path / "documents"
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    test_sessions = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)

    def override_get_db():
        db = test_sessions()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_get_db
    with test_sessions.begin() as db:
        clinic = Clinic(name="Synthetic Test Clinic")
        db.add(clinic)
        db.flush()

        permission_keys = [
            ("patients.read", "Read patient data"),
            ("patients.write", "Write patient data"),
            ("audit.read", "Read audit log"),
            ("passports.create", "Create emergency patient passports"),
            ("passports.read", "Read emergency patient passports"),
            ("passports.revoke", "Revoke emergency patient passports"),
            ("referrals.create", "Create patient referrals"),
            ("referrals.read", "Read patient referrals"),
            ("referrals.approve", "Approve patient referrals"),
            ("referrals.send", "Send patient referrals"),
            ("followups.manage", "Manage patient follow-ups"),
            ("transfers.export", "Export transfer packages"),
            ("transfers.import", "Import transfer packages"),
            ("users.manage", "Manage clinic users and encryption keys"),
        ]
        created_permissions = [
            Permission(key=k, description=d) for k, d in permission_keys
        ]
        db.add_all(created_permissions)
        db.flush()

        doctor = Role(name="Doctor", permissions=created_permissions)
        nurse = Role(
            name="Nurse",
            permissions=[p for p in created_permissions if p.key in ("patients.read", "patients.write", "referrals.create", "referrals.read", "followups.manage")],
        )
        user = User(
            clinic_id=clinic.id,
            email=TEST_EMAIL,
            full_name="Dr. Synthetic Test",
            password_hash=hash_password(TEST_PASSWORD),
            roles=[doctor],
        )
        nurse_user = User(
            clinic_id=clinic.id,
            email="nurse@example.com",
            full_name="Synthetic Test Nurse",
            password_hash=hash_password(TEST_PASSWORD),
            roles=[nurse],
        )
        other_clinic = Clinic(name="Separate Synthetic Clinic")
        db.add_all([doctor, nurse, user, nurse_user, other_clinic])
        db.flush()
        other_patient = User(
            clinic_id=other_clinic.id,
            email="other@example.com",
            full_name="Other Clinic User",
            password_hash=hash_password(TEST_PASSWORD),
            roles=[doctor],
        )
        db.add(other_patient)
        db.flush()
        from app.models import Patient

        patient = Patient(
            clinic_id=other_clinic.id,
            patient_number="SCX-OTHER001",
            full_name="Synthetic Other Patient",
            estimated_age=42,
            allergies=[],
            created_by=other_patient.id,
        )
        db.add(patient)
        db.flush()
        other_patient_id = patient.id
        clinic_id = clinic.id
        other_clinic_id = other_clinic.id
        user_id = user.id

    yield {
        "client": APIClient(),
        "clinic_id": clinic_id,
        "other_clinic_id": other_clinic_id,
        "user_id": user_id,
        "other_patient_id": other_patient_id,
    }
    app.dependency_overrides.clear()
    settings.document_storage_dir = original_storage
    Base.metadata.drop_all(engine)
    engine.dispose()
