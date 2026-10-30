"""Update sync.py with Phase 6 sync handlers."""
import os

sync_path = os.path.join(os.path.dirname(__file__), "..", "app", "services", "sync.py")
with open(sync_path, "r", encoding="utf-8") as f:
    content = f.read()

# 1. Imports
if "Referral" not in content:
    content = content.replace("    User,", "    User,\n    Referral,\n    PatientFollowUp,")
if "ReferralRead" not in content:
    content = content.replace(
        "from app.schemas.patients import PatientCreate, PatientRead, PatientUpdate",
        "from app.schemas.patients import PatientCreate, PatientRead, PatientUpdate\nfrom app.schemas.continuity import ReferralRead, FollowUpRead",
    )

# 2. Dispatch table
old_dispatch = '("document", "upload"): self._document_register,'
new_dispatch = '''("document", "upload"): self._document_register,
            ("referral", "create"): self._referral_create,
            ("referral", "update"): self._referral_update,
            ("followup", "create"): self._followup_create,
            ("followup", "update"): self._followup_update,'''

if old_dispatch in content and '("referral", "create")' not in content:
    content = content.replace(old_dispatch, new_dispatch)

# 3. Handlers
handlers_code = '''
    # ----------------------------------------------------------------- continuity

    def _referral_create(self, operation: SyncOperationIn) -> tuple[dict[str, Any], int]:
        existing = self.db.scalar(
            select(Referral).where(
                Referral.id == operation.entity_id,
                Referral.referring_clinic_id == self.clinic_id,
            )
        )
        if existing is not None:
            return _dump(ReferralRead.model_validate(existing)), existing.version

        payload = dict(operation.payload)
        patient_id = payload.get("patient_id") or payload.get("patientId")
        receiving_clinic_id = payload.get("receiving_clinic_id") or payload.get("receivingClinicId")
        self._require_patient(UUID(str(patient_id)))

        referral = Referral(
            id=operation.entity_id,
            referring_clinic_id=self.clinic_id,
            receiving_clinic_id=UUID(str(receiving_clinic_id)),
            patient_id=UUID(str(patient_id)),
            referring_clinician_id=self.user.id,
            reason=payload.get("reason", "Referral"),
            clinical_summary=payload.get("clinical_summary"),
            priority=payload.get("priority", "routine"),
            status=payload.get("status", "draft"),
            consent_policy=payload.get("consent_policy"),
            included_data=payload.get("included_data", {}),
            source_references=payload.get("source_references"),
            version=1,
        )
        self.db.add(referral)
        self.db.flush()
        return _dump(ReferralRead.model_validate(referral)), referral.version

    def _referral_update(self, operation: SyncOperationIn) -> tuple[dict[str, Any], int]:
        referral = self.db.scalar(
            select(Referral).where(
                Referral.id == operation.entity_id,
                Referral.referring_clinic_id == self.clinic_id,
            )
        )
        if referral is None:
            raise OperationRejected("Referral not found", retryable=True)

        snapshot = _dump(ReferralRead.model_validate(referral))
        payload = dict(operation.payload)
        expected = payload.pop("expected_version", operation.base_version)
        self._check_version(referral.version, expected, snapshot)

        if "reason" in payload:
            referral.reason = payload["reason"]
        if "clinical_summary" in payload:
            referral.clinical_summary = payload["clinical_summary"]
        if "status" in payload:
            referral.status = payload["status"]
        if "priority" in payload:
            referral.priority = payload["priority"]
        referral.version += 1
        self.db.flush()
        return _dump(ReferralRead.model_validate(referral)), referral.version

    def _followup_create(self, operation: SyncOperationIn) -> tuple[dict[str, Any], int]:
        existing = self.db.scalar(
            select(PatientFollowUp).where(
                PatientFollowUp.id == operation.entity_id,
                PatientFollowUp.clinic_id == self.clinic_id,
            )
        )
        if existing is not None:
            return _dump(FollowUpRead.model_validate(existing)), existing.version

        payload = dict(operation.payload)
        patient_id = payload.get("patient_id") or payload.get("patientId")
        self._require_patient(UUID(str(patient_id)))

        scheduled_at_raw = payload.get("scheduled_at") or payload.get("scheduledAt")
        scheduled_at = datetime.fromisoformat(str(scheduled_at_raw)) if scheduled_at_raw else datetime.now(UTC)

        followup = PatientFollowUp(
            id=operation.entity_id,
            clinic_id=self.clinic_id,
            patient_id=UUID(str(patient_id)),
            consultation_id=UUID(str(payload["consultation_id"])) if payload.get("consultation_id") else None,
            scheduled_at=scheduled_at,
            reason=payload.get("reason", "Follow-up"),
            priority=payload.get("priority", "routine"),
            status=payload.get("status", "scheduled"),
            responsible_user_id=self.user.id,
            contact_preference=payload.get("contact_preference", "phone"),
            notes=payload.get("notes"),
            reschedule_history=[],
            version=1,
        )
        self.db.add(followup)
        self.db.flush()
        return _dump(FollowUpRead.model_validate(followup)), followup.version

    def _followup_update(self, operation: SyncOperationIn) -> tuple[dict[str, Any], int]:
        followup = self.db.scalar(
            select(PatientFollowUp).where(
                PatientFollowUp.id == operation.entity_id,
                PatientFollowUp.clinic_id == self.clinic_id,
            )
        )
        if followup is None:
            raise OperationRejected("Follow-up not found", retryable=True)

        snapshot = _dump(FollowUpRead.model_validate(followup))
        payload = dict(operation.payload)
        expected = payload.pop("expected_version", operation.base_version)
        self._check_version(followup.version, expected, snapshot)

        if "status" in payload:
            followup.status = payload["status"]
            if payload["status"] == "completed":
                followup.completed_at = datetime.now(UTC)
                followup.completed_by = self.user.id
        if "notes" in payload:
            followup.notes = payload["notes"]
        if "outcome" in payload:
            followup.outcome = payload["outcome"]
        followup.version += 1
        self.db.flush()
        return _dump(FollowUpRead.model_validate(followup)), followup.version
'''

if "def _referral_create" not in content:
    content += handlers_code
    with open(sync_path, "w", encoding="utf-8") as f:
        f.write(content)
    print("sync.py updated with handlers")
else:
    print("def _referral_create already exists in sync.py")
