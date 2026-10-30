"""phase 6 continuity models

Revision ID: e38c91a0b5df
Revises: 4f28c13a90de
Create Date: 2026-10-30
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "e38c91a0b5df"
down_revision: Union[str, Sequence[str], None] = "4f28c13a90de"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 1. Emergency Passports
    op.create_table(
        "emergency_passports",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("clinic_id", sa.Uuid(), nullable=False),
        sa.Column("patient_id", sa.Uuid(), nullable=False),
        sa.Column("issued_by", sa.Uuid(), nullable=False),
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column("verification_token", sa.String(length=128), nullable=False),
        sa.Column("encrypted_package", sa.JSON(), nullable=False),
        sa.Column("summary_manifest", sa.JSON(), nullable=False),
        sa.Column("consent_given", sa.Boolean(), server_default=sa.true(), nullable=False),
        sa.Column("consent_details", sa.String(length=255), nullable=True),
        sa.Column("is_revoked", sa.Boolean(), server_default=sa.false(), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoked_by", sa.Uuid(), nullable=True),
        sa.Column("revocation_reason", sa.String(length=255), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("version", sa.Integer(), server_default="1", nullable=False),
        sa.ForeignKeyConstraint(["clinic_id"], ["clinics.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["issued_by"], ["users.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["patient_id"], ["patients.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["revoked_by"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_passport_patient",
        "emergency_passports",
        ["clinic_id", "patient_id"],
    )
    op.create_index(
        "ix_passport_token_hash",
        "emergency_passports",
        ["token_hash"],
        unique=True,
    )

    # 2. Referrals
    op.create_table(
        "referrals",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("referring_clinic_id", sa.Uuid(), nullable=False),
        sa.Column("receiving_clinic_id", sa.Uuid(), nullable=False),
        sa.Column("patient_id", sa.Uuid(), nullable=False),
        sa.Column("referring_clinician_id", sa.Uuid(), nullable=False),
        sa.Column("reviewing_clinician_id", sa.Uuid(), nullable=True),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("clinical_summary", sa.Text(), nullable=True),
        sa.Column("priority", sa.String(length=20), server_default="routine", nullable=False),
        sa.Column("status", sa.String(length=32), server_default="draft", nullable=False),
        sa.Column("consent_policy", sa.String(length=255), nullable=True),
        sa.Column("included_data", sa.JSON(), nullable=False),
        sa.Column("source_references", sa.JSON(), nullable=True),
        sa.Column("sent_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("received_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("accepted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("version", sa.Integer(), server_default="1", nullable=False),
        sa.ForeignKeyConstraint(["patient_id"], ["patients.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["receiving_clinic_id"], ["clinics.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["referring_clinic_id"], ["clinics.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["referring_clinician_id"], ["users.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["reviewing_clinician_id"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_referral_referring_clinic",
        "referrals",
        ["referring_clinic_id", "status"],
    )
    op.create_index(
        "ix_referral_receiving_clinic",
        "referrals",
        ["receiving_clinic_id", "status"],
    )
    op.create_index("ix_referral_patient", "referrals", ["patient_id"])

    # 3. Patient Follow-ups
    op.create_table(
        "patient_followups",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("clinic_id", sa.Uuid(), nullable=False),
        sa.Column("patient_id", sa.Uuid(), nullable=False),
        sa.Column("consultation_id", sa.Uuid(), nullable=True),
        sa.Column("scheduled_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("reason", sa.String(length=255), nullable=False),
        sa.Column("priority", sa.String(length=20), server_default="routine", nullable=False),
        sa.Column("status", sa.String(length=32), server_default="scheduled", nullable=False),
        sa.Column("responsible_user_id", sa.Uuid(), nullable=True),
        sa.Column("contact_preference", sa.String(length=50), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("outcome", sa.Text(), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("completed_by", sa.Uuid(), nullable=True),
        sa.Column("reschedule_history", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("version", sa.Integer(), server_default="1", nullable=False),
        sa.ForeignKeyConstraint(["clinic_id"], ["clinics.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["completed_by"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["consultation_id"], ["consultations.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["patient_id"], ["patients.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["responsible_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_followup_clinic_date",
        "patient_followups",
        ["clinic_id", "scheduled_at"],
    )
    op.create_index(
        "ix_followup_clinic_status",
        "patient_followups",
        ["clinic_id", "status"],
    )
    op.create_index("ix_followup_patient", "patient_followups", ["patient_id"])

    # 4. Clinic Pairings
    op.create_table(
        "clinic_pairings",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("source_clinic_id", sa.Uuid(), nullable=False),
        sa.Column("target_clinic_id", sa.Uuid(), nullable=False),
        sa.Column("status", sa.String(length=24), server_default="active", nullable=False),
        sa.Column("pairing_code", sa.String(length=64), nullable=True),
        sa.Column("shared_secret_hash", sa.String(length=64), nullable=True),
        sa.Column("paired_by", sa.Uuid(), nullable=False),
        sa.Column("paired_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["paired_by"], ["users.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["source_clinic_id"], ["clinics.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["target_clinic_id"], ["clinics.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("source_clinic_id", "target_clinic_id", name="uq_clinic_pairing"),
    )

    # 5. Clinic Transfer Packages
    op.create_table(
        "clinic_transfer_packages",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("source_clinic_id", sa.Uuid(), nullable=False),
        sa.Column("target_clinic_id", sa.Uuid(), nullable=False),
        sa.Column("patient_id", sa.Uuid(), nullable=False),
        sa.Column("sender_user_id", sa.Uuid(), nullable=False),
        sa.Column("transfer_id", sa.String(length=64), nullable=False),
        sa.Column("package_schema_version", sa.String(length=32), server_default="syncarex-continuity-v1", nullable=False),
        sa.Column("status", sa.String(length=32), server_default="prepared", nullable=False),
        sa.Column("checksum", sa.String(length=64), nullable=False),
        sa.Column("byte_size", sa.Integer(), nullable=False),
        sa.Column("manifest", sa.JSON(), nullable=False),
        sa.Column("encrypted_payload", sa.Text(), nullable=False),
        sa.Column("consent_purpose", sa.String(length=255), nullable=False),
        sa.Column("source_provenance", sa.JSON(), nullable=False),
        sa.Column("imported_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("imported_by", sa.Uuid(), nullable=True),
        sa.Column("imported_patient_id", sa.Uuid(), nullable=True),
        sa.Column("collision_details", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["imported_by"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["sender_user_id"], ["users.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["source_clinic_id"], ["clinics.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["target_clinic_id"], ["clinics.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_transfer_source",
        "clinic_transfer_packages",
        ["source_clinic_id", "status"],
    )
    op.create_index(
        "ix_transfer_target",
        "clinic_transfer_packages",
        ["target_clinic_id", "status"],
    )
    op.create_index(
        "ix_transfer_uid",
        "clinic_transfer_packages",
        ["transfer_id"],
        unique=True,
    )


def downgrade() -> None:
    op.drop_index("ix_transfer_uid", table_name="clinic_transfer_packages")
    op.drop_index("ix_transfer_target", table_name="clinic_transfer_packages")
    op.drop_index("ix_transfer_source", table_name="clinic_transfer_packages")
    op.drop_table("clinic_transfer_packages")

    op.drop_table("clinic_pairings")

    op.drop_index("ix_followup_patient", table_name="patient_followups")
    op.drop_index("ix_followup_clinic_status", table_name="patient_followups")
    op.drop_index("ix_followup_clinic_date", table_name="patient_followups")
    op.drop_table("patient_followups")

    op.drop_index("ix_referral_patient", table_name="referrals")
    op.drop_index("ix_referral_receiving_clinic", table_name="referrals")
    op.drop_index("ix_referral_referring_clinic", table_name="referrals")
    op.drop_table("referrals")

    op.drop_index("ix_passport_token_hash", table_name="emergency_passports")
    op.drop_index("ix_passport_patient", table_name="emergency_passports")
    op.drop_table("emergency_passports")

