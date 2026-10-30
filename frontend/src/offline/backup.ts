import { db } from "../database/db";
import type { CipherEnvelope } from "../database/types";
import {
  decryptWithKey,
  deriveRecordKeyWithPassphrase,
  requireUnlockedIdentity,
} from "../security/localVault";
import { getLocalDeviceId } from "../offline/device";

export interface BackupResult {
  fileName: string;
  recordCount: number;
  byteSize: number;
}

export const BACKUP_FORMAT = "syncarex-encrypted-backup";
export const BACKUP_FORMAT_VERSION = 1;

export type BackupTableName =
  | "patients"
  | "patientIdentifiers"
  | "consultations"
  | "clinicalNotes"
  | "observations"
  | "allergies"
  | "medications"
  | "documents"
  | "syncOperations"
  | "syncConflicts"
  | "auditEvents";

export type BackupRecords = Record<BackupTableName, BackupRow[]>;

/**
 * One exported row: an encrypted envelope plus its plaintext index fields.
 * Shape details are validated per table by validateBackupPayload before use.
 */
export type BackupRow = Record<string, unknown>;

export interface RestoreTableSummary {
  imported: number;
  skipped: number;
}

export interface RestoreResult {
  imported: number;
  skipped: number;
  tables: Record<BackupTableName, RestoreTableSummary>;
  restoredAt: string;
}

/**
 * Exports every local clinical record as the encrypted envelopes they are
 * stored as. The export is readable only with this vault's passphrase, so it
 * can be copied to another medium without exposing patient information.
 *
 * Document bytes are deliberately excluded: they would make the export large
 * enough to be impractical in a browser, and they remain on the device.
 */
export async function exportLocalBackup(): Promise<BackupResult> {
  const identity = requireUnlockedIdentity("export a backup");
  const deviceId = await getLocalDeviceId();
  const mine = <T extends { ownerId: string }>(rows: T[]) =>
    rows.filter((row) => row.ownerId === identity.userId);

  const [
    patients,
    patientIdentifiers,
    consultations,
    clinicalNotes,
    observations,
    allergies,
    medications,
    documents,
    syncOperations,
    syncConflicts,
    auditEvents,
  ] = await Promise.all([
    db.patients.toArray().then(mine),
    db.patientIdentifiers.toArray().then(mine),
    db.consultations.toArray().then(mine),
    db.clinicalNotes.toArray().then(mine),
    db.observations.toArray().then(mine),
    db.allergies.toArray().then(mine),
    db.medications.toArray().then(mine),
    db.documents.toArray().then(mine),
    db.syncOperations.toArray().then(mine),
    db.syncConflicts.toArray().then(mine),
    db.auditEvents.toArray().then(mine),
  ]);

  const payload = {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    deviceId,
    ownerId: identity.userId,
    note:
      "Every record below is an AES-GCM envelope. Restoring requires the same vault passphrase. Document file bytes are not included.",
    records: {
      patients,
      patientIdentifiers,
      consultations,
      clinicalNotes,
      observations,
      allergies,
      medications,
      documents,
      syncOperations,
      syncConflicts,
      auditEvents,
    },
  };

  const recordCount = Object.values(payload.records).reduce(
    (total, rows) => total + rows.length,
    0,
  );
  const json = JSON.stringify(payload, null, 2);
  const fileName = `syncarex-backup-${new Date().toISOString().slice(0, 10)}.json`;
  const blob = new Blob([json], { type: "application/json" });

  if (typeof document !== "undefined") {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return { fileName, recordCount, byteSize: blob.size };
}

/**
 * Per-table merge configuration. Versioned tables compare the numeric version
 * the sync engine maintains; the two bookkeeping tables that carry no version
 * fall back to an ISO-8601 timestamp, which orders correctly as a string.
 * syncOperations is keyed by operationId, every other table by id.
 */
const BACKUP_TABLE_CONFIG: Array<{
  name: BackupTableName;
  keyField: "id" | "operationId";
  versionField: "version" | "localVersion" | null;
  timestampField: "updatedAt" | "detectedAt" | "createdAt" | null;
}> = [
  { name: "patients", keyField: "id", versionField: "version", timestampField: "updatedAt" },
  {
    name: "patientIdentifiers",
    keyField: "id",
    versionField: "version",
    timestampField: "updatedAt",
  },
  {
    name: "consultations",
    keyField: "id",
    versionField: "version",
    timestampField: "updatedAt",
  },
  {
    name: "clinicalNotes",
    keyField: "id",
    versionField: "version",
    timestampField: "updatedAt",
  },
  {
    name: "observations",
    keyField: "id",
    versionField: "version",
    timestampField: "updatedAt",
  },
  { name: "allergies", keyField: "id", versionField: "version", timestampField: "updatedAt" },
  { name: "medications", keyField: "id", versionField: "version", timestampField: "updatedAt" },
  { name: "documents", keyField: "id", versionField: "version", timestampField: "updatedAt" },
  {
    name: "syncOperations",
    keyField: "operationId",
    versionField: "localVersion",
    timestampField: "updatedAt",
  },
  {
    name: "syncConflicts",
    keyField: "id",
    versionField: null,
    timestampField: "detectedAt",
  },
  { name: "auditEvents", keyField: "id", versionField: null, timestampField: "createdAt" },
];

/** Which fields of each exported row hold encrypted envelopes. */
const ENVELOPE_FIELDS: Record<BackupTableName, string[]> = {
  patients: ["encrypted"],
  patientIdentifiers: ["encrypted"],
  consultations: ["encrypted"],
  clinicalNotes: ["encrypted"],
  observations: ["encrypted"],
  allergies: ["encrypted"],
  medications: ["encrypted"],
  documents: ["encrypted"],
  syncOperations: ["payload", "baseSnapshot", "localSnapshot"],
  syncConflicts: ["localPayload", "serverPayload", "basePayload"],
  auditEvents: ["details"],
};

/**
 * Validates the payload's shape and version marker before anything is read
 * from or written to the database. Any problem here rejects the whole backup:
 * restore is all-or-nothing, never a partial import.
 */
function validateBackupPayload(payload: unknown): { ownerId: string; records: BackupRecords } {
  const notABackup = new Error(
    "This file is not a SynCareX encrypted backup. Nothing was imported.",
  );
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw notABackup;
  }
  const candidate = payload as Record<string, unknown>;
  if (candidate.format !== BACKUP_FORMAT) throw notABackup;
  if (
    typeof candidate.formatVersion !== "number" ||
    !Number.isInteger(candidate.formatVersion)
  ) {
    throw notABackup;
  }
  if (candidate.formatVersion !== BACKUP_FORMAT_VERSION) {
    throw new Error(
      `This backup uses format version ${candidate.formatVersion}, which this version of SynCareX cannot restore (supported: version ${BACKUP_FORMAT_VERSION}). Nothing was imported.`,
    );
  }
  if (typeof candidate.ownerId !== "string" || candidate.ownerId.length === 0) {
    throw new Error("The backup file is missing its vault owner. Nothing was imported.");
  }
  const ownerId = candidate.ownerId;
  if (typeof candidate.records !== "object" || candidate.records === null) {
    throw new Error("The backup file has no records section. Nothing was imported.");
  }
  const rawRecords = candidate.records as Record<string, unknown>;

  const records = {} as BackupRecords;
  for (const config of BACKUP_TABLE_CONFIG) {
    const rows = rawRecords[config.name];
    if (!Array.isArray(rows)) {
      throw new Error(
        `The backup section "${config.name}" is missing or damaged. Nothing was imported.`,
      );
    }
    records[config.name] = rows.map((row, index): BackupRow => {
      if (typeof row !== "object" || row === null || Array.isArray(row)) {
        throw new Error(
          `The backup section "${config.name}" contains a damaged record at position ${index}. Nothing was imported.`,
        );
      }
      const record = row as Record<string, unknown>;
      if (typeof record[config.keyField] !== "string" || record[config.keyField] === "") {
        throw new Error(
          `The backup section "${config.name}" contains a record without an id. Nothing was imported.`,
        );
      }
      if (record.ownerId !== ownerId) {
        throw new Error(
          `The backup section "${config.name}" contains a record from a different account. Nothing was imported.`,
        );
      }
      if (config.versionField && typeof record[config.versionField] !== "number") {
        throw new Error(
          `The backup section "${config.name}" contains a record without a version. Nothing was imported.`,
        );
      }
      return record as BackupRow;
    });
  }
  return { ownerId, records };
}

function numericVersion(row: Record<string, unknown>, field: string | null): number | undefined {
  if (!field) return undefined;
  const value = row[field];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function recordTimestamp(row: Record<string, unknown>, field: string | null): string {
  if (!field) return "";
  const value = row[field];
  return typeof value === "string" ? value : "";
}

/**
 * The merge rule mirrors server synchronization: an incoming row wins only
 * when it is strictly newer than the stored one. An equal version keeps the
 * stored row, because the server has already seen it, and a stored row with a
 * numeric version is never displaced by one without.
 */
function incomingWins(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
  config: (typeof BACKUP_TABLE_CONFIG)[number],
): boolean {
  const existingVersion = numericVersion(existing, config.versionField);
  const incomingVersion = numericVersion(incoming, config.versionField);
  if (existingVersion !== undefined || incomingVersion !== undefined) {
    if (incomingVersion === undefined) return false;
    if (existingVersion === undefined) return true;
    return incomingVersion > existingVersion;
  }
  return (
    recordTimestamp(incoming, config.timestampField) >
    recordTimestamp(existing, config.timestampField)
  );
}

/**
 * Decrypts every envelope in the backup with the freshly derived vault key
 * before any write. AES-GCM authentication makes this the proof that the
 * passphrase is right and the file was not corrupted or tampered with; a
 * failure here aborts the restore with the database untouched.
 */
async function verifyBackupReadable(key: CryptoKey, records: BackupRecords): Promise<void> {
  for (const config of BACKUP_TABLE_CONFIG) {
    for (const row of records[config.name]) {
      for (const field of ENVELOPE_FIELDS[config.name]) {
        const envelope = row[field] as CipherEnvelope | null | undefined;
        if (envelope === null || envelope === undefined) continue;
        if (
          typeof envelope !== "object" ||
          typeof envelope.iv !== "string" ||
          typeof envelope.ciphertext !== "string"
        ) {
          throw new Error(
            `The backup section "${config.name}" contains a damaged encrypted record. Restore aborted; no records were changed.`,
          );
        }
        try {
          await decryptWithKey(key, envelope);
        } catch {
          throw new Error(
            `The backup could not be decrypted with this passphrase (section "${config.name}"). Restore aborted; no records were changed.`,
          );
        }
      }
    }
  }
}

/**
 * Restores an encrypted backup produced by exportLocalBackup: validates the
 * format, proves the passphrase against this vault, decrypts every envelope
 * to confirm the file is intact, then merges the tables into Dexie inside a
 * single transaction.
 *
 * The merge is last-writer-wins by version, matching the sync engine: an
 * incoming record replaces a stored one only when its version (or, for the
 * tables without versions, its timestamp) is strictly newer. Equal or older
 * records keep the stored row, because the server has already seen it.
 *
 * Document file bytes are not part of the backup format and are never
 * written by a restore; documentBlobs is deliberately not touched.
 */
export async function importLocalBackup(
  payload: unknown,
  passphrase: string,
): Promise<RestoreResult> {
  // Shape and version are checked before the database is touched at all.
  const { ownerId, records } = validateBackupPayload(payload);
  const identity = requireUnlockedIdentity("restore a backup");
  if (ownerId !== identity.userId) {
    throw new Error(
      "This backup belongs to a different account. Sign in with the account that created it before restoring. Nothing was imported.",
    );
  }
  if (typeof passphrase !== "string" || passphrase.length === 0) {
    throw new Error("Enter the vault passphrase the backup was encrypted with.");
  }
  const key = await deriveRecordKeyWithPassphrase(identity.userId, passphrase);
  await verifyBackupReadable(key, records);

  const tables = {} as Record<BackupTableName, RestoreTableSummary>;
  let imported = 0;
  let skipped = 0;

  await db.transaction(
    "rw",
    BACKUP_TABLE_CONFIG.map((config) => db.table(config.name)),
    async () => {
      for (const config of BACKUP_TABLE_CONFIG) {
        const summary: RestoreTableSummary = { imported: 0, skipped: 0 };
        const table = db.table<BackupRow, string>(config.name);
        for (const row of records[config.name]) {
          const key = row[config.keyField] as string;
          const existing = await table.get(key);
          if (existing && !incomingWins(existing, row, config)) {
            summary.skipped += 1;
            continue;
          }
          await table.put(row);
          summary.imported += 1;
        }
        tables[config.name] = summary;
        imported += summary.imported;
        skipped += summary.skipped;
      }
    },
  );

  return { imported, skipped, tables, restoredAt: new Date().toISOString() };
}
