import type { EntityTable } from "dexie";
import { db } from "../database/db";
import type {
  CipherEnvelope,
  EncryptedRecord,
  EntityType,
  OperationType,
} from "../database/types";
import { getLocalDeviceId } from "../offline/device";
import {
  decryptLocalValue,
  encryptLocalValue,
  requireUnlockedIdentity,
  type VaultIdentity,
} from "../security/localVault";
import { buildOperation } from "./syncRepository";
import type { SearchIndexRow, SyncOperation } from "../database/types";

export interface VersionedEntity {
  id: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  deviceId?: string;
}

export interface RecordMeta {
  patientId?: string;
  consultationId?: string;
  archivedAt?: string | null;
}

export interface WritePlan<T extends VersionedEntity> {
  entity: T;
  record: EncryptedRecord;
  operation: SyncOperation;
}

/**
 * Prepares an encrypted record plus its queue operation. All cryptography
 * happens here, before any IndexedDB transaction is opened, because a Dexie
 * transaction cannot survive an await on Web Crypto.
 */
export async function planWrite<T extends VersionedEntity>(options: {
  entity: T;
  entityType: EntityType;
  operationType: OperationType;
  baseVersion: number;
  /** Payload sent to the server; defaults to the whole entity. */
  payload?: unknown;
  /** Previous entity state retained for an encrypted three-way conflict view. */
  baseSnapshot?: unknown;
  meta?: RecordMeta;
  identity: VaultIdentity;
}): Promise<WritePlan<T>> {
  const deviceId = await getLocalDeviceId();
  const entity = { ...options.entity, deviceId };
  const [encrypted, payload] = await Promise.all([
    encryptLocalValue(entity),
    encryptLocalValue(options.payload ?? entity),
  ]);
  const operation = await buildOperation({
    ownerId: options.identity.userId,
    entityType: options.entityType,
    entityId: entity.id,
    operationType: options.operationType,
    payload,
    baseVersion: options.baseVersion,
    localVersion: entity.version,
    deviceId,
    actorId: options.identity.userId,
  });
  operation.localSnapshot = encrypted;
  operation.baseSnapshot = options.baseSnapshot
    ? await encryptLocalValue(options.baseSnapshot)
    : null;
  return {
    entity,
    record: {
      id: entity.id,
      ownerId: options.identity.userId,
      patientId: options.meta?.patientId,
      consultationId: options.meta?.consultationId,
      encrypted,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
      version: entity.version,
      deviceId,
      archivedAt: options.meta?.archivedAt ?? null,
    },
    operation,
  };
}

/**
 * Commits the record and its queue entry in one transaction. Either the
 * clinical record and its pending operation both exist, or neither does.
 */
export async function commitWrite<T extends VersionedEntity>(
  table: EntityTable<EncryptedRecord, "id">,
  plan: WritePlan<T>,
  /**
   * Search index rows for this record, already hashed. They are written in
   * the same transaction: a record that exists but is missing from the index
   * would be invisible to search, which for a patient record is a safety
   * problem, not a performance one.
   */
  indexRows?: SearchIndexRow[],
): Promise<T> {
  await db.transaction(
    "rw",
    table,
    db.syncOperations,
    db.searchIndex,
    async () => {
      await table.put(plan.record);
      const duplicate = await db.syncOperations
        .where("dedupeKey")
        .equals(plan.operation.dedupeKey)
        .first();
      if (!duplicate) await db.syncOperations.add(plan.operation);
      if (indexRows) {
        await db.searchIndex.where("patientId").equals(plan.entity.id).delete();
        if (indexRows.length) await db.searchIndex.bulkAdd(indexRows);
      }
    },
  );
  return plan.entity;
}

export async function readRecord<T>(record: EncryptedRecord): Promise<T> {
  return decryptLocalValue<T>(record.encrypted);
}

export async function readRecords<T>(records: EncryptedRecord[]): Promise<T[]> {
  return Promise.all(records.map((record) => readRecord<T>(record)));
}

export function ownedBy(identity: VaultIdentity) {
  return (record: EncryptedRecord) => record.ownerId === identity.userId;
}

export async function getOwned<T>(
  table: EntityTable<EncryptedRecord, "id">,
  id: string,
  action: string,
): Promise<T | null> {
  const identity = requireUnlockedIdentity(action);
  const record = await table.get(id);
  if (!record || record.ownerId !== identity.userId) return null;
  return readRecord<T>(record);
}

export async function listOwnedByIndex<T>(
  table: EntityTable<EncryptedRecord, "id">,
  index: "patientId" | "consultationId" | "ownerId",
  value: string,
  action: string,
): Promise<T[]> {
  const identity = requireUnlockedIdentity(action);
  const records = (await table.where(index).equals(value).toArray()).filter(
    ownedBy(identity),
  );
  const entities = await readRecords<T & { updatedAt: string }>(records);
  return entities.sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  ) as T[];
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  pages: number;
}

export function paginate<T>(items: T[], page: number, pageSize: number): Page<T> {
  const safePageSize = Math.max(1, pageSize);
  const pages = Math.max(1, Math.ceil(items.length / safePageSize));
  const safePage = Math.min(Math.max(1, page), pages);
  return {
    items: items.slice((safePage - 1) * safePageSize, safePage * safePageSize),
    total: items.length,
    page: safePage,
    pageSize: safePageSize,
    pages,
  };
}

export function normalizeForSearch(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().trim();
}

export type { CipherEnvelope };
