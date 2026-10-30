"""Update frontend types.ts with Phase 6 models."""
import os

types_path = os.path.join(os.path.dirname(__file__), "src", "database", "types.ts")
with open(types_path, "r", encoding="utf-8") as f:
    content = f.read()

# Update EntityType
old_entity_type = """export type EntityType =
  | "patient"
  | "patientIdentifier"
  | "consultation"
  | "clinicalNote"
  | "observation"
  | "allergy"
  | "medication"
  | "document";"""

new_entity_type = """export type EntityType =
  | "patient"
  | "patientIdentifier"
  | "consultation"
  | "clinicalNote"
  | "observation"
  | "allergy"
  | "medication"
  | "document"
  | "referral"
  | "followup"
  | "passport"
  | "transfer";"""

if old_entity_type in content:
    content = content.replace(old_entity_type, new_entity_type)

phase6_types = '''

// ------------------------------------------------ Phase 6 Continuity Types

export type VerificationBadge =
  | "verified"
  | "imported"
  | "ai_draft"
  | "outdated"
  | "expired"
  | "unverified";

export interface EmergencyPassportRecord {
  id: string;
  ownerId: string;
  patientId: string;
  patientName?: string;
  tokenHash: string;
  verificationToken: string;
  encrypted: CipherEnvelope;
  summaryManifest: string[];
  consentGiven: boolean;
  consentDetails?: string;
  isRevoked: boolean;
  revokedAt?: string | null;
  revocationReason?: string | null;
  expiresAt: string;
  createdAt: string;
  version: number;
}

export type ReferralPriority = "routine" | "urgent" | "emergency";
export type ReferralStatus =
  | "draft"
  | "awaiting_review"
  | "approved"
  | "ready_to_send"
  | "pending_synchronization"
  | "sent"
  | "received"
  | "accepted"
  | "in_progress"
  | "completed"
  | "cancelled";

export interface ReferralRecord {
  id: string;
  ownerId: string;
  patientId: string;
  patientName?: string;
  referringClinicId: string;
  receivingClinicId: string;
  receivingClinicName?: string;
  reason: string;
  clinicalSummary?: string;
  priority: ReferralPriority;
  status: ReferralStatus;
  consentPolicy?: string;
  encrypted: CipherEnvelope;
  sourceReferences?: Record<string, unknown>;
  sentAt?: string | null;
  receivedAt?: string | null;
  acceptedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export type FollowUpPriority = "routine" | "high" | "urgent";
export type FollowUpStatus =
  | "scheduled"
  | "due"
  | "completed"
  | "rescheduled"
  | "cancelled"
  | "unable_to_contact";

export interface FollowUpRecord {
  id: string;
  ownerId: string;
  patientId: string;
  patientName?: string;
  consultationId?: string | null;
  scheduledAt: string;
  reason: string;
  priority: FollowUpPriority;
  status: FollowUpStatus;
  contactPreference?: string;
  notes?: string;
  outcome?: string;
  rescheduleHistory: Array<{
    previousScheduledAt: string;
    rescheduledTo: string;
    reason: string;
    rescheduledAt: string;
  }>;
  createdAt: string;
  updatedAt: string;
  completedAt?: string | null;
  version: number;
}

export interface ClinicTransferRecord {
  id: string;
  ownerId: string;
  transferId: string;
  sourceClinicId: string;
  sourceClinicName: string;
  targetClinicId: string;
  targetClinicName?: string;
  patientId: string;
  patientName?: string;
  status: "prepared" | "sent" | "received" | "imported" | "collision_detected" | "cancelled";
  checksum: string;
  byteSize: number;
  manifest: Record<string, unknown>;
  consentPurpose: string;
  encryptedPayload: string;
  sourceProvenance: Record<string, unknown>;
  importedAt?: string | null;
  createdAt: string;
}

export interface PairedClinicRecord {
  id: string;
  clinicId: string;
  clinicName: string;
  status: "active" | "revoked";
  pairingCode?: string;
  pairedAt: string;
}

export interface PassportRevocationRecord {
  tokenHash: string;
  revokedAt: string;
  reason?: string;
}
'''

if "EmergencyPassportRecord" not in content:
    content += phase6_types
    with open(types_path, "w", encoding="utf-8") as f:
        f.write(content)
    print("types.ts updated with Phase 6 types")
else:
    print("EmergencyPassportRecord already exists in types.ts")

