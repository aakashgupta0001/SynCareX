"""Seeds the three SynCareX roles and the requested admin account.

Idempotent: run it any number of times. Run from the backend directory with
the normal environment (it uses the configured DATABASE_URL, which defaults
to the local syncarex.db).

    python scripts/seed_admin.py

Roles map to the product's three personas:

- **Admin**  -> the "Administrator" staff role: everything, including
  users.manage (sharing the clinic key, creating accounts).
- **Doctor** -> the "Doctor" staff role: full clinical access, no user
  management.
- **Patient** -> deliberately NOT a staff role. Patients log in through the
  patient portal (``patient_portal_accounts`` + ``/portal`` routes), which
  has no roles table involvement at all: a portal token can never open a
  staff route and a staff token can never open the portal. Creating a
  "Patient" row in the staff roles table would invite putting patients into
  the staff login, which the portal design exists to avoid.

The admin credentials below are for the local pilot database. The password is
weak by explicit request; change it before any real deployment (the login
throttle will slow guessing, not stop a leak).
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.security.passwords import hash_password  # noqa: E402

ADMIN_EMAIL = "aakashgupta76342@gmail.com"
ADMIN_NAME = "Aakash Gupta"
ADMIN_PASSWORD = "123456"

CLINIC_NAME = "SynCareX Demonstration Clinic"

ROLE_PERMISSIONS = {
    "Administrator": [
        "patients.read",
        "patients.write",
        "audit.read",
        "passports.create",
        "passports.read",
        "passports.revoke",
        "referrals.create",
        "referrals.read",
        "referrals.approve",
        "referrals.send",
        "followups.manage",
        "transfers.export",
        "transfers.import",
        "users.manage",
    ],
    "Doctor": [
        "patients.read",
        "patients.write",
        "audit.read",
        "passports.create",
        "passports.read",
        "referrals.create",
        "referrals.read",
        "followups.manage",
    ],
}


def main() -> None:
    from app.database import engine
    from app.models import Clinic, Permission, Role, User
    from app.models.entities import Base
    from sqlalchemy.orm import Session

    Base.metadata.create_all(engine)
    with Session(engine) as db:
        clinic = db.query(Clinic).filter_by(name=CLINIC_NAME).one_or_none()
        if clinic is None:
            clinic = Clinic(name=CLINIC_NAME)
            db.add(clinic)
            db.flush()

        permissions = {}
        for key in sorted({k for keys in ROLE_PERMISSIONS.values() for k in keys}):
            permission = db.query(Permission).filter_by(key=key).one_or_none()
            if permission is None:
                permission = Permission(key=key, description=key)
                db.add(permission)
                db.flush()
            permissions[key] = permission

        for role_name, keys in ROLE_PERMISSIONS.items():
            role = db.query(Role).filter_by(name=role_name).one_or_none()
            if role is None:
                role = Role(name=role_name)
                db.add(role)
                db.flush()
            role.permissions = [permissions[key] for key in keys]

        admin_role = db.query(Role).filter_by(name="Administrator").one()
        user = db.query(User).filter(User.email == ADMIN_EMAIL).one_or_none()
        if user is None:
            user = User(
                clinic_id=clinic.id,
                email=ADMIN_EMAIL,
                full_name=ADMIN_NAME,
                roles=[admin_role],
            )
            db.add(user)
            print(f"created user {ADMIN_EMAIL}")
        else:
            user.roles = [admin_role]
            print(f"user {ADMIN_EMAIL} already existed; role set to Administrator")
        user.full_name = ADMIN_NAME
        user.is_active = True
        user.password_hash = hash_password(ADMIN_PASSWORD)
        db.commit()
        print(f"password set to the requested value (weak — change before production)")
        print(f"clinic: {CLINIC_NAME}")


if __name__ == "__main__":
    main()
