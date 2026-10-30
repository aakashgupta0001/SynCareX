import Dexie, { type EntityTable, type Table, type Transaction } from "dexie";
import type {
  AuditEvent,
  DocumentBlob,
  EncryptedRecord,
  IntegrityFinding,
  ClinicTransferRecord,
  EmergencyPassportRecord,
  FollowUpRecord,
  PairedClinicRecord,
  PassportRevocationRecord,
  ReferralRecord,
  LegacySyncOperationV1,
  LocalAIBlob,
  LocalAIArtifact,
  LocalDevice,
  LocalSetting,
  LocalUser,
  OperationStatus,
  SyncConflict,
  SyncOperation,
  SearchIndexRow,
} from "./types";

export const DATABASE_NAME = "syncarex-local";
export const DATABASE_VERSION = 6;

/**
 * Local clinical store.
 *
 * Schema history:
 *  - v1 (Phase 1): patients, consultations, operations, settings, vaults.
 *  - v2 (Phase 2): the full offline clinical model. `operations`, `settings`
 *    and `vaults` are copied forward into `syncOperations`, `localSettings`
 *    and `localUsers`. The v1 stores are deliberately left in place so an
 *    interrupted upgrade can never strand unsynchronized clinical work.
 *  - v3 (Phase 3): encrypted local AI artifacts and source blobs.
 *  - v4 (Phase 4): durable sync retry attempt timestamps.
 *  - v5 (Phase 5): encrypted local integrity findings and review metadata.
 */
class SynCareXDatabase extends Dexie {
  patients!: EntityTable<EncryptedRecord, "id">;
  patientIdentifiers!: EntityTable<EncryptedRecord, "id">;
  consultations!: EntityTable<EncryptedRecord, "id">;
  clinicalNotes!: EntityTable<EncryptedRecord, "id">;
  observations!: EntityTable<EncryptedRecord, "id">;
  allergies!: EntityTable<EncryptedRecord, "id">;
  medications!: EntityTable<EncryptedRecord, "id">;
  documents!: EntityTable<EncryptedRecord, "id">;
  documentBlobs!: EntityTable<DocumentBlob, "id">;
  localUsers!: EntityTable<LocalUser, "id">;
  devices!: EntityTable<LocalDevice, "id">;
  syncOperations!: EntityTable<SyncOperation, "operationId">;
  syncConflicts!: EntityTable<SyncConflict, "id">;
  auditEvents!: EntityTable<AuditEvent, "id">;
  localSettings!: EntityTable<LocalSetting, "key">;
  aiArtifacts!: EntityTable<LocalAIArtifact, "id">;
  aiBlobs!: EntityTable<LocalAIBlob, "id">;
  /** Blind trigram index for patient search; keyed hashes only. */
  searchIndex!: Table<SearchIndexRow, number>;
  integrityFindings!: EntityTable<IntegrityFinding, "id">;
  passports!: EntityTable<EmergencyPassportRecord, "id">;
  referrals!: EntityTable<ReferralRecord, "id">;
  followUps!: EntityTable<FollowUpRecord, "id">;
  transfers!: EntityTable<ClinicTransferRecord, "id">;
  pairedClinics!: EntityTable<PairedClinicRecord, "id">;
  passportRevocations!: EntityTable<PassportRevocationRecord, "tokenHash">;

  /** Retained v1 stores. Read during migration; not used by new code. */
  operations!: EntityTable<LegacySyncOperationV1, "id">;
  settings!: EntityTable<LocalSetting, "key">;
  vaults!: EntityTable<LocalUser, "id">;

  constructor(name: string = DATABASE_NAME) {
    super(name);

    this.version(1).stores({
      patients: "&id, ownerId, updatedAt",
      consultations: "&id, ownerId, patientId, updatedAt",
      operations: "&id, ownerId, status, entityId, createdAt",
      settings: "&key",
      vaults: "&id, email",
    });

    this.version(2)
      .stores({
        patients: "&id, ownerId, updatedAt, archivedAt, [ownerId+updatedAt]",
        patientIdentifiers: "&id, ownerId, patientId, [patientId+ownerId]",
        consultations: "&id, ownerId, patientId, updatedAt, [patientId+ownerId]",
        clinicalNotes:
          "&id, ownerId, patientId, consultationId, updatedAt, [consultationId+ownerId]",
        observations: "&id, ownerId, patientId, consultationId, updatedAt",
        allergies: "&id, ownerId, patientId, updatedAt",
        medications: "&id, ownerId, patientId, updatedAt",
        documents: "&id, ownerId, patientId, consultationId, createdAt",
        documentBlobs: "&id, ownerId, patientId",
        localUsers: "&id, email, userId",
        devices: "&id, &deviceId",
        syncOperations:
          "&operationId, &idempotencyKey, &dedupeKey, ownerId, status, entityId, entityType, createdAt, nextAttemptAt, [ownerId+status]",
        syncConflicts: "&id, ownerId, entityId, status, detectedAt",
        auditEvents: "&id, ownerId, entityId, createdAt, synced",
        localSettings: "&key",
      })
      .upgrade(migrateToVersion2);

    this.version(3).stores({
      patients: "&id, ownerId, updatedAt, archivedAt, [ownerId+updatedAt]",
      patientIdentifiers: "&id, ownerId, patientId, [patientId+ownerId]",
      consultations: "&id, ownerId, patientId, updatedAt, [patientId+ownerId]",
      clinicalNotes:
        "&id, ownerId, patientId, consultationId, updatedAt, [consultationId+ownerId]",
      observations: "&id, ownerId, patientId, consultationId, updatedAt",
      allergies: "&id, ownerId, patientId, updatedAt",
      medications: "&id, ownerId, patientId, updatedAt",
      documents: "&id, ownerId, patientId, consultationId, createdAt",
      documentBlobs: "&id, ownerId, patientId",
      localUsers: "&id, email, userId",
      devices: "&id, &deviceId",
      syncOperations:
        "&operationId, &idempotencyKey, &dedupeKey, ownerId, status, entityId, entityType, createdAt, nextAttemptAt, [ownerId+status]",
      syncConflicts: "&id, ownerId, entityId, status, detectedAt",
      auditEvents: "&id, ownerId, entityId, createdAt, synced",
      localSettings: "&key",
      aiArtifacts: "&id, ownerId, kind, status, createdAt, [ownerId+kind]",
      aiBlobs: "&id, ownerId, createdAt",
    });

    this.version(4)
      .stores({
        patients: "&id, ownerId, updatedAt, archivedAt, [ownerId+updatedAt]",
        patientIdentifiers: "&id, ownerId, patientId, [patientId+ownerId]",
        consultations: "&id, ownerId, patientId, updatedAt, [patientId+ownerId]",
        clinicalNotes:
          "&id, ownerId, patientId, consultationId, updatedAt, [consultationId+ownerId]",
        observations: "&id, ownerId, patientId, consultationId, updatedAt",
        allergies: "&id, ownerId, patientId, updatedAt",
        medications: "&id, ownerId, patientId, updatedAt",
        documents: "&id, ownerId, patientId, consultationId, createdAt",
        documentBlobs: "&id, ownerId, patientId",
        localUsers: "&id, email, userId",
        devices: "&id, &deviceId",
        syncOperations:
          "&operationId, &idempotencyKey, &dedupeKey, ownerId, status, entityId, entityType, createdAt, nextAttemptAt, [ownerId+status]",
        syncConflicts: "&id, ownerId, entityId, status, detectedAt",
        auditEvents: "&id, ownerId, entityId, createdAt, synced",
        localSettings: "&key",
        aiArtifacts: "&id, ownerId, kind, status, createdAt, [ownerId+kind]",
        aiBlobs: "&id, ownerId, createdAt",
      })
      .upgrade(async (tx) => {
        const operations = await tx
          .table<SyncOperation, string>("syncOperations")
          .toArray();
        await tx.table<SyncOperation, string>("syncOperations")        .bulkPut(
        operations.map((operation) => ({
          ...operation,
          lastAttemptAt: operation.lastAttemptAt ?? null,
        })),
        );
      });

    this.version(5).stores({
      patients: "&id, ownerId, updatedAt, archivedAt, [ownerId+updatedAt]",
      patientIdentifiers: "&id, ownerId, patientId, [patientId+ownerId]",
      consultations: "&id, ownerId, patientId, updatedAt, [patientId+ownerId]",
      clinicalNotes:
        "&id, ownerId, patientId, consultationId, updatedAt, [consultationId+ownerId]",
      observations: "&id, ownerId, patientId, consultationId, updatedAt",
      allergies: "&id, ownerId, patientId, updatedAt",
      medications: "&id, ownerId, patientId, updatedAt",
      documents: "&id, ownerId, patientId, consultationId, createdAt",
      documentBlobs: "&id, ownerId, patientId",
      localUsers: "&id, email, userId",
      devices: "&id, &deviceId",
      syncOperations:
        "&operationId, &idempotencyKey, &dedupeKey, ownerId, status, entityId, entityType, createdAt, nextAttemptAt, [ownerId+status]",
      syncConflicts: "&id, ownerId, entityId, status, detectedAt",
      auditEvents: "&id, ownerId, entityId, createdAt, synced",
      localSettings: "&key",
      aiArtifacts: "&id, ownerId, kind, status, createdAt, [ownerId+kind]",
      aiBlobs: "&id, ownerId, createdAt",
      integrityFindings:
        "&id, ownerId, ruleId, category, severity, entityId, status, detectedAt, [ownerId+status]",
    });

    this.version(6).stores({
      patients: "&id, ownerId, updatedAt, archivedAt, [ownerId+updatedAt]",
      patientIdentifiers: "&id, ownerId, patientId, [patientId+ownerId]",
      consultations: "&id, ownerId, patientId, updatedAt, [patientId+ownerId]",
      clinicalNotes:
        "&id, ownerId, patientId, consultationId, updatedAt, [consultationId+ownerId]",
      observations: "&id, ownerId, patientId, consultationId, updatedAt",
      allergies: "&id, ownerId, patientId, updatedAt",
      medications: "&id, ownerId, patientId, updatedAt",
      documents: "&id, ownerId, patientId, consultationId, createdAt",
      documentBlobs: "&id, ownerId, patientId",
      localUsers: "&id, email, userId",
      devices: "&id, &deviceId",
      syncOperations:
        "&operationId, &idempotencyKey, &dedupeKey, ownerId, status, entityId, entityType, createdAt, nextAttemptAt, [ownerId+status]",
      syncConflicts: "&id, ownerId, entityId, status, detectedAt",
      auditEvents: "&id, ownerId, entityId, createdAt, synced",
      localSettings: "&key",
      aiArtifacts: "&id, ownerId, kind, status, createdAt, [ownerId+kind]",
      aiBlobs: "&id, ownerId, createdAt",
      integrityFindings:
        "&id, ownerId, ruleId, category, severity, entityId, status, detectedAt, [ownerId+status]",
      passports: "&id, ownerId, patientId, tokenHash, expiresAt, createdAt",
      referrals:
        "&id, ownerId, patientId, status, priority, receivingClinicId, createdAt, updatedAt",
      followUps:
        "&id, ownerId, patientId, status, priority, scheduledAt, [ownerId+status]",
      transfers:
        "&id, ownerId, transferId, sourceClinicId, targetClinicId, status, createdAt",
      pairedClinics: "&id, clinicId, status",
      passportRevocations: "&tokenHash, revokedAt",
    });

    this.version(7).stores({
      patients: "&id, ownerId, updatedAt, archivedAt, [ownerId+updatedAt]",
      patientIdentifiers: "&id, ownerId, patientId, [patientId+ownerId]",
      consultations: "&id, ownerId, patientId, updatedAt, [patientId+ownerId]",
      clinicalNotes:
        "&id, ownerId, patientId, consultationId, updatedAt, [consultationId+ownerId]",
      observations: "&id, ownerId, patientId, consultationId, updatedAt",
      allergies: "&id, ownerId, patientId, updatedAt",
      medications: "&id, ownerId, patientId, updatedAt",
      documents: "&id, ownerId, patientId, consultationId, createdAt",
      documentBlobs: "&id, ownerId, patientId",
      localUsers: "&id, email, userId",
      devices: "&id, &deviceId",
      syncOperations:
        "&operationId, &idempotencyKey, &dedupeKey, ownerId, status, entityId, entityType, createdAt, nextAttemptAt, [ownerId+status]",
      syncConflicts: "&id, ownerId, entityId, status, detectedAt",
      auditEvents: "&id, ownerId, entityId, createdAt, synced",
      localSettings: "&key",
      aiArtifacts: "&id, ownerId, kind, status, createdAt, [ownerId+kind]",
      aiBlobs: "&id, ownerId, createdAt",
      integrityFindings:
        "&id, ownerId, ruleId, category, severity, entityId, status, detectedAt, [ownerId+status]",
      passports: "&id, ownerId, patientId, tokenHash, expiresAt, createdAt",
      referrals:
        "&id, ownerId, patientId, status, priority, receivingClinicId, createdAt, updatedAt",
      followUps:
        "&id, ownerId, patientId, status, priority, scheduledAt, [ownerId+status]",
      transfers:
        "&id, ownerId, transferId, sourceClinicId, targetClinicId, status, createdAt",
      pairedClinics: "&id, clinicId, status",
      passportRevocations: "&tokenHash, revokedAt",
      // ++id because one patient has many trigram rows. Lookups go
      // through [ownerId+term]; patientId supports replacing a
      // record's rows on every write.
      searchIndex: "++id, patientId, ownerId, [ownerId+term]",
    });
  }
}

async function migrateToVersion2(tx: Transaction): Promise<void> {
  const legacyOperations = await tx
    .table<LegacySyncOperationV1, string>("operations")
    .toArray();
  const migrated: SyncOperation[] = legacyOperations.map((operation) => ({
    operationId: operation.id,
    idempotencyKey: operation.id,
    dedupeKey: `${operation.entityType}:${operation.entityId}:${operation.operationType}:${operation.localVersion}`,
    ownerId: operation.ownerId,
    entityType: operation.entityType as SyncOperation["entityType"],
    entityId: operation.entityId,
    operationType: operation.operationType as SyncOperation["operationType"],
    payload: operation.payload,
    baseVersion: operation.baseVersion,
    localVersion: operation.localVersion,
    deviceId: operation.deviceId,
    actorId: operation.actorId,
    createdAt: operation.createdAt,
    updatedAt: operation.createdAt,
    retryCount: operation.retryCount,
    status: operation.status as OperationStatus,
    lastError: operation.errorDetails,
    nextAttemptAt: operation.createdAt,
    lastAttemptAt: null,
    acknowledgedAt: operation.status === "acknowledged" ? operation.createdAt : null,
  }));
  if (migrated.length) {
    await tx.table<SyncOperation, string>("syncOperations").bulkPut(migrated);
  }

  const legacySettings = await tx.table<LocalSetting, string>("settings").toArray();
  if (legacySettings.length) {
    await tx.table<LocalSetting, string>("localSettings").bulkPut(legacySettings);
  }

  const legacyVaults = await tx.table<Record<string, unknown>, string>("vaults").toArray();
  if (legacyVaults.length) {
    const now = new Date().toISOString();
    await tx.table<LocalUser, string>("localUsers").bulkPut(
      legacyVaults.map((vault) => ({
        id: String(vault.id),
        email: String(vault.email),
        userId: String(vault.userId),
        fullName: String(vault.fullName),
        roles: (vault.roles as string[]) ?? [],
        permissions: (vault.permissions as string[]) ?? [],
        salt: String(vault.salt),
        iv: String(vault.iv),
        verifier: String(vault.verifier),
        iterations: Number(vault.iterations ?? 310_000),
        deviceAuthorizedAt: null,
        offlineSessionExpiresAt: null,
        lastOnlineAuthAt: null,
        createdAt: now,
        updatedAt: now,
      })),
    );
  }
}

export const db = new SynCareXDatabase();

/** Tables that hold clinical records, in the order a transaction should lock them. */
export const clinicalTables = [
  "patients",
  "patientIdentifiers",
  "consultations",
  "clinicalNotes",
  "observations",
  "allergies",
  "medications",
  "documents",
  "documentBlobs",
] as const;

export function createTestDatabase(name: string): SynCareXDatabase {
  return new SynCareXDatabase(name);
}

export type { SynCareXDatabase };
