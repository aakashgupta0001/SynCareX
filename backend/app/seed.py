from sqlalchemy import select

from app.core.config import get_settings
from app.database import SessionLocal
from app.models import Clinic, Permission, Role, User
from app.security.passwords import hash_password

ROLE_PERMISSIONS: dict[str, set[str]] = {
    "Administrator": {
        "patients.read",
        "patients.write",
        "audit.read",
        "users.manage",
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
    },
    "Doctor": {
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
    },
    "Nurse": {
        "patients.read",
        "patients.write",
        "passports.create",
        "passports.read",
        "referrals.create",
        "referrals.read",
        "followups.manage",
    },
    "ASHA Worker": {
        "patients.read",
        "patients.write",
        "passports.read",
        "followups.manage",
    },
    "Healthcare Supervisor": {
        "patients.read",
        "patients.write",
        "audit.read",
        "referrals.read",
        "referrals.approve",
        "followups.manage",
        "transfers.export",
        "transfers.import",
    },
}

PERMISSIONS = {
    "patients.read": "Read clinic patient records",
    "patients.write": "Create and update clinic patient records",
    "audit.read": "Read clinic audit history",
    "users.manage": "Manage clinic users",
    "passports.create": "Create emergency patient passports",
    "passports.read": "Read and verify emergency patient passports",
    "passports.revoke": "Revoke emergency patient passports",
    "referrals.create": "Create patient referrals",
    "referrals.read": "Read patient referrals",
    "referrals.approve": "Approve and authorize patient referrals",
    "referrals.send": "Send and transmit patient referrals",
    "followups.manage": "Create, update, and manage patient follow-ups",
    "transfers.export": "Export patient transfer packages",
    "transfers.import": "Import and review patient transfer packages",
}


def seed_development_data() -> None:
    settings = get_settings()
    password = settings.seed_admin_password
    if password is None or len(password.get_secret_value()) < 12:
        raise RuntimeError(
            "Set SEED_ADMIN_PASSWORD to a unique password of at least 12 characters"
        )

    with SessionLocal.begin() as db:
        clinic = db.scalar(
            select(Clinic).where(Clinic.name == "SynCareX Demonstration Clinic")
        )
        if clinic is None:
            clinic = Clinic(name="SynCareX Demonstration Clinic")
            db.add(clinic)
            db.flush()

        permissions: dict[str, Permission] = {}
        for key, description in PERMISSIONS.items():
            permission = db.scalar(select(Permission).where(Permission.key == key))
            if permission is None:
                permission = Permission(key=key, description=description)
                db.add(permission)
            permissions[key] = permission

        roles: dict[str, Role] = {}
        for role_name, grants in ROLE_PERMISSIONS.items():
            role = db.scalar(select(Role).where(Role.name == role_name))
            if role is None:
                role = Role(name=role_name)
                db.add(role)
            role.permissions = [permissions[key] for key in grants if key in permissions]
            roles[role_name] = role
        db.flush()

        admin = db.scalar(
            select(User).where(User.email == settings.seed_admin_email.lower())
        )
        if admin is None:
            db.add(
                User(
                    clinic_id=clinic.id,
                    email=settings.seed_admin_email.lower(),
                    full_name="SynCareX Development Administrator",
                    password_hash=hash_password(password.get_secret_value()),
                    roles=[roles["Administrator"]],
                )
            )
        elif not admin.roles:
            admin.roles = [roles["Administrator"]]


if __name__ == "__main__":
    seed_development_data()
    print("Synthetic SynCareX clinic and administrator are ready.")
