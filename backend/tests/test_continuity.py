from datetime import UTC, datetime, timedelta
import json
import uuid

import pytest
from app.models import Clinic, Patient
from app.models.entities import Base
from app.security.passwords import hash_password
from tests.conftest import TEST_EMAIL, TEST_PASSWORD


def authenticate_client(api_client):
    client = api_client["client"]
    login_res = client.post(
        "/api/v1/auth/login",
        json={"email": TEST_EMAIL, "password": TEST_PASSWORD},
    )
    assert login_res.status_code == 200
    token = login_res.json()["access_token"]
    return client, {"Authorization": f"Bearer {token}"}


def create_test_patient(client, headers):
    res = client.post(
        "/api/v1/patients",
        json={
            "patient_number": f"P-{uuid.uuid4().hex[:6]}",
            "full_name": "Synthetic Patient Alpha",
            "estimated_age": 35,
            "gender": "Female",
            "contact_phone": "+91-9876543210",
            "relevant_history": "Asthma diagnosed 2021",
            "allergies": ["Penicillin"],
        },
        headers=headers,
    )
    assert res.status_code == 201
    return res.json()


# -----------------------------------------------------------------------------
# 1. Emergency Patient Passports Tests
# -----------------------------------------------------------------------------


def test_emergency_passport_issue_and_verify(api_client):
    client, headers = authenticate_client(api_client)
    patient = create_test_patient(client, headers)
    patient_id = patient["id"]

    # Issue passport with data minimization
    issue_res = client.post(
        "/api/v1/continuity/passports",
        json={
            "patient_id": patient_id,
            "included_fields": ["emergency_contact", "allergies", "recent_history"],
            "consent_given": True,
            "validity_hours": 48,
        },
        headers=headers,
    )
    assert issue_res.status_code == 201
    passport_data = issue_res.json()
    assert passport_data["verification_token"]
    assert passport_data["is_revoked"] is False
    assert "allergies" in passport_data["summary_manifest"]

    token = passport_data["verification_token"]

    # Verify online with token
    verify_res = client.post(
        "/api/v1/continuity/passports/verify",
        json={"token": token},
        headers=headers,
    )
    assert verify_res.status_code == 200
    ver_data = verify_res.json()
    assert ver_data["is_valid"] is True
    assert ver_data["status"] == "valid"
    assert ver_data["verification_badge"] == "verified"
    assert ver_data["patient_reference"] == "Synthetic Patient Alpha"
    assert ver_data["payload"]["relevant_history"] == "Asthma diagnosed 2021"


def test_emergency_passport_invalid_and_revocation(api_client):
    client, headers = authenticate_client(api_client)
    patient = create_test_patient(client, headers)
    patient_id = patient["id"]

    # Invalid token check
    invalid_res = client.post(
        "/api/v1/continuity/passports/verify",
        json={"token": "completely-fake-token-that-does-not-exist"},
        headers=headers,
    )
    assert invalid_res.status_code == 200
    assert invalid_res.json()["is_valid"] is False
    assert invalid_res.json()["status"] == "invalid"

    # Issue and revoke
    issue_res = client.post(
        "/api/v1/continuity/passports",
        json={"patient_id": patient_id, "validity_hours": 24},
        headers=headers,
    )
    passport = issue_res.json()
    passport_id = passport["id"]
    token = passport["verification_token"]

    revoke_res = client.post(
        f"/api/v1/continuity/passports/{passport_id}/revoke",
        json={"reason": "Patient requested revocation of emergency credentials"},
        headers=headers,
    )
    assert revoke_res.status_code == 200
    assert revoke_res.json()["is_revoked"] is True

    # Verifying now must report revoked
    verify_res = client.post(
        "/api/v1/continuity/passports/verify",
        json={"token": token},
        headers=headers,
    )
    assert verify_res.status_code == 200
    assert verify_res.json()["is_valid"] is False
    assert verify_res.json()["status"] == "revoked"

    # CRL list check
    crl_res = client.get("/api/v1/continuity/passports/revocations/list", headers=headers)
    assert crl_res.status_code == 200
    crl = crl_res.json()
    assert any(entry["token_hash"] == passport["token_hash"] for entry in crl)


# -----------------------------------------------------------------------------
# 2. Smart Referrals Tests
# -----------------------------------------------------------------------------


def test_referral_lifecycle_and_authorization(api_client):
    client, headers = authenticate_client(api_client)
    patient = create_test_patient(client, headers)
    patient_id = patient["id"]
    other_clinic_id = api_client["other_clinic_id"]

    # 1. Create referral draft
    create_res = client.post(
        "/api/v1/continuity/referrals",
        json={
            "receiving_clinic_id": str(other_clinic_id),
            "patient_id": patient_id,
            "reason": "Specialist pulmonary consultation for persistent wheezing",
            "clinical_summary": "Inhaler therapy insufficient. Spirometry needed.",
            "priority": "urgent",
            "status": "draft",
        },
        headers=headers,
    )
    assert create_res.status_code == 201
    referral = create_res.json()
    ref_id = referral["id"]
    assert referral["status"] == "draft"

    # 2. Transition draft -> awaiting_review
    step1 = client.post(
        f"/api/v1/continuity/referrals/{ref_id}/status",
        json={"status": "awaiting_review", "note": "Submitted for senior review"},
        headers=headers,
    )
    assert step1.status_code == 200
    assert step1.json()["status"] == "awaiting_review"

    # 3. Transition awaiting_review -> approved (Doctor has referrals.approve)
    step2 = client.post(
        f"/api/v1/continuity/referrals/{ref_id}/status",
        json={"status": "approved", "note": "Approved by senior doctor"},
        headers=headers,
    )
    assert step2.status_code == 200
    assert step2.json()["status"] == "approved"

    # 4. Transition approved -> sent
    step3 = client.post(
        f"/api/v1/continuity/referrals/{ref_id}/status",
        json={"status": "sent", "note": "Transmitted securely"},
        headers=headers,
    )
    assert step3.status_code == 200
    assert step3.json()["status"] == "sent"
    assert step3.json()["sent_at"] is not None

    # 5. Transition sent -> received -> accepted
    step4 = client.post(
        f"/api/v1/continuity/referrals/{ref_id}/status",
        json={"status": "received"},
        headers=headers,
    )
    assert step4.status_code == 200
    assert step4.json()["status"] == "received"

    step5 = client.post(
        f"/api/v1/continuity/referrals/{ref_id}/status",
        json={"status": "accepted"},
        headers=headers,
    )
    assert step5.status_code == 200
    assert step5.json()["status"] == "accepted"
    assert step5.json()["accepted_at"] is not None


# -----------------------------------------------------------------------------
# 3. Patient Follow-up Tests
# -----------------------------------------------------------------------------


def test_followup_creation_reschedule_and_completion(api_client):
    client, headers = authenticate_client(api_client)
    patient = create_test_patient(client, headers)
    patient_id = patient["id"]

    now = datetime.now(UTC)
    scheduled_time = now + timedelta(days=3)

    # Create follow-up
    create_res = client.post(
        "/api/v1/continuity/followups",
        json={
            "patient_id": patient_id,
            "scheduled_at": scheduled_time.isoformat(),
            "reason": "Blood pressure check and medication titration",
            "priority": "routine",
            "status": "scheduled",
        },
        headers=headers,
    )
    assert create_res.status_code == 201
    followup = create_res.json()
    followup_id = followup["id"]
    assert followup["status"] == "scheduled"
    assert followup["reschedule_history"] == []

    # Reschedule follow-up
    reschedule_time = scheduled_time + timedelta(days=7)
    resched_res = client.post(
        f"/api/v1/continuity/followups/{followup_id}/reschedule",
        json={
            "new_scheduled_at": reschedule_time.isoformat(),
            "reason": "Patient requested appointment postponement",
        },
        headers=headers,
    )
    assert resched_res.status_code == 200
    updated = resched_res.json()
    assert updated["status"] == "rescheduled"
    assert len(updated["reschedule_history"]) == 1
    assert updated["reschedule_history"][0]["reason"] == "Patient requested appointment postponement"

    # Mark completed
    comp_res = client.patch(
        f"/api/v1/continuity/followups/{followup_id}",
        json={
            "status": "completed",
            "outcome": "BP stabilized at 120/80 mmHg. Continued current regimen.",
        },
        headers=headers,
    )
    assert comp_res.status_code == 200
    assert comp_res.json()["status"] == "completed"
    assert comp_res.json()["outcome"] == "BP stabilized at 120/80 mmHg. Continued current regimen."


# -----------------------------------------------------------------------------
# 4. Secure Clinic-to-Clinic Exchange Tests
# -----------------------------------------------------------------------------


def test_clinic_pairing_and_transfer_package(api_client):
    client, headers = authenticate_client(api_client)
    patient = create_test_patient(client, headers)
    patient_id = patient["id"]
    other_clinic_id = api_client["other_clinic_id"]

    # 1. Pair clinics
    pair_res = client.post(
        "/api/v1/continuity/clinics/pair",
        json={
            "target_clinic_id": str(other_clinic_id),
            "pairing_code": "CLINIC-SECURE-PAIR-9988",
        },
        headers=headers,
    )
    assert pair_res.status_code == 200
    assert pair_res.json()["status"] == "active"

    # 2. Export transfer package
    export_res = client.post(
        "/api/v1/continuity/transfers/export",
        json={
            "target_clinic_id": str(other_clinic_id),
            "patient_id": patient_id,
            "consent_purpose": "Cross-clinic continuum of maternal care",
            "included_records": ["patient", "allergies", "medications"],
        },
        headers=headers,
    )
    assert export_res.status_code == 201
    pkg = export_res.json()
    assert pkg["transfer_id"].startswith("trf-")
    assert pkg["checksum"]
    assert pkg["byte_size"] > 0
    assert pkg["status"] == "prepared"


# -----------------------------------------------------------------------------
# 5. FHIR R4 Serialization & Validation Tests
# -----------------------------------------------------------------------------


def test_fhir_r4_serialization_and_validation(api_client):
    client, headers = authenticate_client(api_client)
    patient = create_test_patient(client, headers)
    patient_id = patient["id"]

    # Export patient to FHIR R4 Bundle
    fhir_res = client.get(
        f"/api/v1/continuity/fhir/patients/{patient_id}",
        headers=headers,
    )
    assert fhir_res.status_code == 200
    bundle = fhir_res.json()
    assert bundle["resourceType"] == "Bundle"
    assert bundle["type"] == "collection"
    assert len(bundle["entry"]) >= 1

    first_resource = bundle["entry"][0]["resource"]
    assert first_resource["resourceType"] == "Patient"
    assert first_resource["name"][0]["text"] == "Synthetic Patient Alpha"

    # Validate bundle
    val_res = client.post(
        "/api/v1/continuity/fhir/validate",
        json=bundle,
        headers=headers,
    )
    assert val_res.status_code == 200
    val_data = val_res.json()
    assert val_data["is_valid"] is True
    assert val_data["conforms_to_fhir_r4"] is True
    assert val_data["issues"] == []

