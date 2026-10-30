import type { Table } from "dexie";
import { db } from "../database/db";
import type {
  EncryptedRecord,
  EntityType,
  SyncConflict,
} from "../database/types";
import type { SyncChangeResponse } from "../services/api";
import { encryptLocalValue, requireUnlockedIdentity } from "../security/localVault";
import { auditRepository } from "./auditRepository";

const tableNames: Record<EntityType, string> = {
  patient: "patients",
  patientIdentifier: "patientIdentifiers",
  consultation: "consultations",
  clinicalNote: "clinicalNotes",
  observation: "observations",
  allergy: "allergies",
  medication: "medications",
  document: "documents",
  referral: "referrals",
  followup: "followUps",
  passport: "passports",
  transfer: "transfers",
};

function camelCase(value: string): string {
  return value.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

function mapSnapshot(
  type: EntityType,
  change: SyncChangeResponse,
): Record<string, unknown> {
  const source = change.payload;
  const snapshot = Object.fromEntries(
    Object.entries(source).map(([key, value]) => [camelCase(key), value]),
  );
  snapshot.id = change.entity_id;
  snapshot.version = change.entity_version;
  snapshot.createdAt = snapshot.createdAt ?? change.created_at;
  snapshot.updatedAt = snapshot.updatedAt ?? change.created_at;

  if (type === "patient") {
    snapshot.gender = snapshot.gender ?? "";
    snapshot.contactPhone = snapshot.contactPhone ?? "";
    snapshot.address = snapshot.address ?? "";
    snapshot.village = snapshot.village ?? "";
    snapshot.emergencyContactName = snapshot.emergencyContactName ?? "";
    snapshot.emergencyContactPhone = snapshot.emergencyContactPhone ?? "";
    snapshot.relevantHistory = snapshot.relevantHistory ?? "";
    snapshot.allergies = snapshot.allergies ?? [];
    snapshot.archivedAt = snapshot.archivedAt ?? (change.tombstone ? change.created_at : null);
  } else if (type === "document") {
    snapshot.description = snapshot.description ?? "";
    snapshot.uploadStatus = snapshot.contentReceivedAt ? "uploaded" : "local_only";
    snapshot.uploadError = null;
    snapshot.uploadedAt = snapshot.contentReceivedAt ?? null;
  } else if (type === "consultation") {
    snapshot.reason = snapshot.reason ?? "";
    snapshot.notes = snapshot.notes ?? "";
  } else if (type === "clinicalNote") {
    snapshot.authorId = snapshot.authorId ?? null;
  } else if (type === "observation") {
    snapshot.unit = snapshot.unit ?? "";
    snapshot.enteredInErrorAt = snapshot.enteredInErrorAt ?? null;
    snapshot.enteredInErrorBy = snapshot.enteredInErrorBy ?? null;
    snapshot.enteredInErrorReason = snapshot.enteredInErrorReason ?? null;
  } else if (type === "allergy") {
    snapshot.reaction = snapshot.reaction ?? "";
    snapshot.enteredInErrorAt = snapshot.enteredInErrorAt ?? null;
    snapshot.enteredInErrorBy = snapshot.enteredInErrorBy ?? null;
    snapshot.enteredInErrorReason = snapshot.enteredInErrorReason ?? null;
  } else if (type === "medication") {
    snapshot.dose = snapshot.dose ?? "";
    snapshot.frequency = snapshot.frequency ?? "";
    snapshot.stoppedAt = snapshot.stoppedAt ?? null;
    snapshot.recordedBy = snapshot.recordedBy ?? null;
    snapshot.enteredInErrorAt = snapshot.enteredInErrorAt ?? null;
    snapshot.enteredInErrorBy = snapshot.enteredInErrorBy ?? null;
    snapshot.enteredInErrorReason = snapshot.enteredInErrorReason ?? null;
  }
  return snapshot;
}

export async function applyResolvedServerSnapshot(
  ownerId: string,
  entityType: EntityType,
  entityId: string,
  serverPayload: Record<string, unknown>,
): Promise<void> {
  const identity = requireUnlockedIdentity("apply a clinician-reviewed server snapshot");
  if (identity.userId !== ownerId) {
    throw new Error("The conflict belongs to a different local user.");
  }
  const timestamp = new Date().toISOString();
  const change: SyncChangeResponse = {
    cursor: 0,
    operation_id: null,
    entity_type: entityType,
    entity_id: entityId,
    operation_type: "update",
    entity_version: Number(serverPayload.version ?? 1),
    payload: serverPayload,
    tombstone: Boolean(serverPayload.archived_at ?? serverPayload.archivedAt),
    created_at: String(serverPayload.created_at ?? serverPayload.createdAt ?? timestamp),
  };
  const snapshot = mapSnapshot(entityType, change);
  const encrypted = await encryptLocalValue(snapshot);
  const table = db.table(tableNames[entityType]) as Table<EncryptedRecord, string>;
  await db.transaction("rw", table, async () => {
    await table.put({
      id: entityId,
      ownerId,
      patientId:
        typeof snapshot.patientId === "string" ? snapshot.patientId : undefined,
      consultationId:
        typeof snapshot.consultationId === "string"
          ? snapshot.consultationId
          : undefined,
      encrypted,
      createdAt: String(snapshot.createdAt),
      updatedAt: String(snapshot.updatedAt),
      version: change.entity_version,
      archivedAt:
        typeof snapshot.archivedAt === "string" ? snapshot.archivedAt : null,
    });
  });
}

export const syncPullRepository = {
  checkpointKey(ownerId: string): string {
    return `sync-pull-cursor:${ownerId}`;
  },

  async getCursor(ownerId: string): Promise<number> {
    const saved = await db.localSettings.get(this.checkpointKey(ownerId));
    if (!saved) return 0;
    const cursor = Number(saved.value);
    if (!Number.isSafeInteger(cursor) || cursor < 0) {
      throw new Error("The saved synchronization cursor is invalid.");
    }
    return cursor;
  },

  /**
   * Encrypts snapshots before opening the write transaction, then applies each
   * page and its checkpoint atomically. Local unacknowledged edits are kept
   * intact and converted into reviewable conflicts.
   */
  async applyPage(
    ownerId: string,
    changes: SyncChangeResponse[],
    nextCursor: number,
  ): Promise<{ applied: number; conflicts: number }> {
    const identity = requireUnlockedIdentity("apply synchronization changes");
    if (identity.userId !== ownerId) {
      throw new Error("The active local user changed before synchronization could be applied.");
    }
    if (!Number.isSafeInteger(nextCursor) || nextCursor < 0) {
      throw new Error("The server returned an invalid synchronization cursor.");
    }

    const prepared = await Promise.all(
      changes.map(async (change) => ({
        change,
        snapshot: mapSnapshot(change.entity_type as EntityType, change),
        encrypted: await encryptLocalValue(
          mapSnapshot(change.entity_type as EntityType, change),
        ),
      })),
    );
    const conflictIds: string[] = [];
    let applied = 0;
    let conflicts = 0;
    const settingsKey = this.checkpointKey(ownerId);
    const timestamp = new Date().toISOString();

    await db.transaction(
      "rw",
      [
        db.patients,
      db.patientIdentifiers,
      db.consultations,
      db.clinicalNotes,
      db.observations,
      db.allergies,
      db.medications,
      db.documents,
      db.syncOperations,
      db.syncConflicts,
      db.localSettings,
      ],
      async () => {
        const savedCursor = await db.localSettings.get(settingsKey);
        const currentCursor = Number(savedCursor?.value ?? 0);
        if (nextCursor < currentCursor) {
          throw new Error("The server attempted to move the synchronization cursor backward.");
        }
        for (const item of prepared) {
          const type = item.change.entity_type as EntityType;
          if (!(type in tableNames)) {
            throw new Error(`Unsupported synchronized entity type: ${item.change.entity_type}`);
          }
          const table = db.table(tableNames[type]) as Table<EncryptedRecord, string>;
          const pending = await db.syncOperations
            .where("entityId")
            .equals(item.change.entity_id)
            .filter(
              (operation) =>
                operation.ownerId === ownerId &&
                operation.status !== "acknowledged" &&
                operation.status !== "superseded" &&
                operation.operationId !== item.change.operation_id,
            )
            .first();
          if (pending) {
            const existingConflict = await db.syncConflicts
              .where("entityId")
              .equals(item.change.entity_id)
              .filter(
                (conflict) =>
                  conflict.ownerId === ownerId &&
                  conflict.operationId === pending.operationId &&
                  conflict.status === "open",
              )
              .first();
            if (!existingConflict) {
              const conflictId = crypto.randomUUID();
              const conflict: SyncConflict = {
                id: conflictId,
                ownerId,
                operationId: pending.operationId,
                entityType: pending.entityType,
                entityId: pending.entityId,
                baseVersion: pending.baseVersion,
                localVersion: pending.localVersion,
                serverVersion: item.change.entity_version,
                localPayload: pending.payload,
                serverPayload: item.encrypted,
                detectedAt: timestamp,
                status: "open",
                resolution: null,
                resolvedAt: null,
                message: "A newer server change arrived while this device had an unsynchronized edit.",
              };
              await db.syncConflicts.add(conflict);
              await db.syncOperations.update(pending.operationId, {
                status: "conflict",
                lastError: conflict.message,
                updatedAt: timestamp,
              });
              conflictIds.push(conflictId);
              conflicts += 1;
            }
            continue;
          }

          if (item.change.operation_id) {
            const matchingOperation = await db.syncOperations.get(
              item.change.operation_id,
            );
            if (matchingOperation?.ownerId === ownerId) {
              await db.syncOperations.update(matchingOperation.operationId, {
                status: "acknowledged",
                acknowledgedAt: timestamp,
                lastError: null,
                updatedAt: timestamp,
              });
            }
          }

          const record: EncryptedRecord = {
            id: item.change.entity_id,
            ownerId,
            patientId:
              typeof item.snapshot.patientId === "string"
                ? item.snapshot.patientId
                : undefined,
            consultationId:
              typeof item.snapshot.consultationId === "string"
                ? item.snapshot.consultationId
                : undefined,
            encrypted: item.encrypted,
            createdAt: String(item.snapshot.createdAt),
            updatedAt: String(item.snapshot.updatedAt),
            version: item.change.entity_version,
            archivedAt:
              typeof item.snapshot.archivedAt === "string"
                ? item.snapshot.archivedAt
                : null,
          };
          await table.put(record);
          applied += 1;
        }
        await db.localSettings.put({
          key: settingsKey,
          value: String(nextCursor),
          updatedAt: timestamp,
        });
      },
    );

    for (const conflictId of conflictIds) {
      const conflict = await db.syncConflicts.get(conflictId);
      if (!conflict) continue;
      await auditRepository.record({
        action: "sync.conflict.detected",
        entityType: conflict.entityType,
        entityId: conflict.entityId,
        details: {
          localVersion: conflict.localVersion,
          serverVersion: conflict.serverVersion,
          source: "pull",
        },
      });
    }
    return { applied, conflicts };
  },
};
