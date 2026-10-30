export interface CipherEnvelope {
  iv: string;
  ciphertext: string;
}

/**
 * Every clinical record is kept as an encrypted envelope. Only the fields
 * required to index, scope and synchronize a record stay in plaintext; the
 * clinical content itself lives inside `encrypted`.
 */
export interface EncryptedRecord {
  id: string;
  ownerId: string;
  patientId?: string;
  consultationId?: string;
  encrypted: CipherEnvelope;
  createdAt: string;
  updatedAt: string;
  version: number;
  deviceId?: string;
  archivedAt?: string | null;
}

export type OperationStatus =
  | "pending"
  | "processing"
  | "retry_wait"
  | "failed"
  | "acknowledged"
  | "conflict"
  | "superseded";

export type EntityType =
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
  | "transfer";

export type OperationType = "create" | "update" | "archive" | "upload";

export interface SyncOperation {
  operationId: string;
  /** Stable key the server uses to reject a replayed operation. */
  idempotencyKey: string;
  /** Local uniqueness guard: one operation per entity version and type. */
  dedupeKey: string;
  ownerId: string;
  entityType: EntityType;
  entityId: string;
  operationType: OperationType;
  payload: CipherEnvelope;
  baseVersion: number;
  localVersion: number;
  deviceId: string;
  actorId: string | null;
  createdAt: string;
  updatedAt: string;
  retryCount: number;
  status: OperationStatus;
  lastError: string | null;
  /** Exponential backoff gate; the engine skips the operation until then. */
  nextAttemptAt: string;
  lastAttemptAt: string | null;
  acknowledgedAt: string | null;
  /** Encrypted full entity snapshots retained for future three-way review. */
  baseSnapshot?: CipherEnvelope | null;
  localSnapshot?: CipherEnvelope | null;
}

export interface SyncConflict {
  id: string;
  ownerId: string;
  operationId: string;
  entityType: EntityType;
  entityId: string;
  /** Version the device based its edit on. */
  baseVersion: number;
  localVersion: number;
  serverVersion: number | null;
  /** Encrypted copy of the local attempt so nothing is silently discarded. */
  localPayload: CipherEnvelope;
  serverPayload: CipherEnvelope | null;
  detectedAt: string;
  status: "open" | "resolved";
  resolution: "keep_local" | "keep_server" | null;
  resolvedAt: string | null;
  message: string;
  actorId?: string | null;
  deviceId?: string;
  operationCreatedAt?: string;
  basePayload?: CipherEnvelope | null;
}

export interface AuditEvent {
  id: string;
  ownerId: string;
  actorId: string | null;
  deviceId: string;
  action: string;
  entityType: string;
  entityId: string | null;
  /** Encrypted detail payload; audit rows never hold plaintext clinical data. */
  details: CipherEnvelope | null;
  createdAt: string;
  synced: 0 | 1;
}

export type IntegrityFindingStatus =
  | "open"
  | "acknowledged"
  | "resolved"
  | "dismissed";

export type IntegritySeverity = "info" | "low" | "medium" | "high";

export interface IntegrityFinding {
  id: string;
  ownerId: string;
  ruleId: string;
  category: "duplicate" | "validation" | "provenance" | "sync" | "relationship";
  severity: IntegritySeverity;
  entityType: string;
  entityId: string;
  status: IntegrityFindingStatus;
  title: string;
  summary: string;
  /** Evidence may contain patient data and is encrypted at rest. */
  evidence: CipherEnvelope;
  detectedAt: string;
  updatedAt: string;
  reviewedAt: string | null;
  reviewedBy: string | null;
  reviewRationale: CipherEnvelope | null;
}

export interface LocalSetting {
  key: string;
  value: string;
  updatedAt?: string;
}

/** Legacy v1 alias kept so existing stored rows stay readable. */
export type DeviceSetting = LocalSetting;

export interface LocalDevice {
  id: string;
  deviceId: string;
  label: string;
  /** Set once the server has authorized this device for offline work. */
  provisionedAt: string | null;
  provisionedBy: string | null;
  serverDeviceId: string | null;
  status: "unprovisioned" | "authorized" | "revoked";
  offlineGraceDays: number;
  lastServerContactAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LocalUser {
  id: string;
  email: string;
  userId: string;
  fullName: string;
  roles: string[];
  permissions: string[];
  salt: string;
  iv: string;
  verifier: string;
  /** Key-derivation iterations recorded per user so they can be raised later. */
  iterations: number;
  deviceAuthorizedAt: string | null;
  /** Offline sessions stop being accepted after this instant. */
  offlineSessionExpiresAt: string | null;
  lastOnlineAuthAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Legacy v1 alias. */
export type LocalVault = LocalUser;

export interface LocalPatient {
  id: string;
  patientNumber: string;
  fullName: string;
  dateOfBirth: string | null;
  estimatedAge: number | null;
  gender: string;
  contactPhone: string;
  address: string;
  village: string;
  emergencyContactName: string;
  emergencyContactPhone: string;
  relevantHistory: string;
  allergies: string[];
  version: number;
  createdAt: string;
  updatedAt: string;
  deviceId?: string;
  archivedAt?: string | null;
}

export interface LocalPatientIdentifier {
  id: string;
  patientId: string;
  system: string;
  value: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  deviceId?: string;
}

export interface LocalConsultation {
  id: string;
  patientId: string;
  occurredAt: string;
  reason: string;
  notes: string;
  status: "draft" | "completed";
  version: number;
  createdAt: string;
  updatedAt: string;
  deviceId?: string;
}

export interface LocalClinicalNote {
  id: string;
  consultationId: string;
  patientId: string;
  authorId: string | null;
  /** Free-text clinician documentation. Never machine-generated advice. */
  body: string;
  noteType: "subjective" | "objective" | "assessment" | "plan" | "general";
  version: number;
  createdAt: string;
  updatedAt: string;
  deviceId?: string;
}

export interface LocalObservation {
  id: string;
  patientId: string;
  consultationId: string | null;
  code: string;
  label: string;
  value: string;
  unit: string;
  recordedAt: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  deviceId?: string;
}

export interface LocalAllergy {
  id: string;
  patientId: string;
  substance: string;
  reaction: string;
  severity: "unknown" | "mild" | "moderate" | "severe";
  recordedAt: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  deviceId?: string;
}

export interface LocalMedication {
  id: string;
  patientId: string;
  consultationId: string | null;
  /**
   * Documentation of a medication a clinician has recorded. SynCareX never
   * generates or suggests a prescription.
   */
  name: string;
  dose: string;
  frequency: string;
  startedAt: string | null;
  stoppedAt: string | null;
  recordedBy: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  deviceId?: string;
}

export type DocumentUploadStatus =
  | "local_only"
  | "queued"
  | "uploading"
  | "uploaded"
  | "failed";

export interface LocalDocument {
  id: string;
  patientId: string;
  consultationId: string | null;
  fileName: string;
  mimeType: string;
  byteSize: number;
  /** SHA-256 of the plaintext bytes; used for de-duplication and integrity. */
  checksum: string;
  description: string;
  uploadStatus: DocumentUploadStatus;
  uploadError: string | null;
  uploadedAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  deviceId?: string;
}

/**
 * Encrypted document bytes, stored apart from the metadata so listing
 * documents never has to read file contents into memory.
 */
export interface DocumentBlob {
  id: string;
  ownerId: string;
  patientId: string;
  iv: string;
  ciphertext: ArrayBuffer;
  byteSize: number;
  createdAt: string;
}

export type AIArtifactKind =
  | "audio_source"
  | "transcript"
  | "document_source"
  | "ocr_text"
  | "extraction"
  | "summary";

export type AIArtifactStatus =
  | "saved"
  | "processing"
  | "failed"
  | "review_required"
  | "reviewed";

/** AI outputs and source metadata are encrypted with the unlocked local vault. */
export interface LocalAIArtifact {
  id: string;
  ownerId: string;
  actorId: string;
  deviceId: string;
  kind: AIArtifactKind;
  status: AIArtifactStatus;
  encrypted: CipherEnvelope;
  createdAt: string;
  updatedAt: string;
}

/** Source audio and images are encrypted before they enter IndexedDB. */
export interface LocalAIBlob {
  id: string;
  ownerId: string;
  iv: string;
  ciphertext: ArrayBuffer;
  byteSize: number;
  createdAt: string;
}

export interface LegacySyncOperationV1 {
  id: string;
  ownerId: string;
  entityType: string;
  entityId: string;
  deviceId: string;
  actorId: string | null;
  operationType: string;
  baseVersion: number;
  localVersion: number;
  payload: CipherEnvelope;
  createdAt: string;
  status: string;
  retryCount: number;
  errorDetails: string | null;
}


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
  // Only the hash is kept. The token itself is shown once at issuance
  // and never persisted, so a copied browser profile does not yield
  // usable passport tokens.
  tokenHash: string;
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
/**
 * One trigram of one patient's searchable text, stored as a keyed HMAC.
 * The plaintext trigram is never written to disk.
 */
export interface SearchIndexRow {
  id?: number;
  ownerId: string;
  patientId: string;
  term: string;
}
