import { db } from "../database/db";
import type {
  CipherEnvelope,
  EntityType,
  OperationStatus,
  OperationType,
  SyncOperation,
} from "../database/types";
import { decryptLocalValue } from "../security/localVault";

/** Backoff schedule for failed operations. */
export const RETRY_BASE_MS = 5_000;
export const RETRY_MAX_MS = 15 * 60 * 1000;
export const MAX_AUTOMATIC_RETRIES = 10;
export const PROCESSING_RECOVERY_MS = 2 * 60 * 1000;

export interface EnqueueInput {
  ownerId: string;
  entityType: EntityType;
  entityId: string;
  operationType: OperationType;
  payload: CipherEnvelope;
  baseVersion: number;
  localVersion: number;
  deviceId: string;
  actorId: string | null;
}

export function buildDedupeKey(input: {
  entityType: EntityType;
  entityId: string;
  operationType: OperationType;
  localVersion: number;
}): string {
  return `${input.entityType}:${input.entityId}:${input.operationType}:${input.localVersion}`;
}

/**
 * Deterministic idempotency key. The same logical operation always produces
 * the same key, so a retry after an unknown outcome cannot create a second
 * server-side record.
 */
export async function buildIdempotencyKey(
  dedupeKey: string,
  deviceId: string,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${deviceId}|${dedupeKey}`),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function backoffDelayMs(retryCount: number): number {
  const exponential = RETRY_BASE_MS * 2 ** Math.max(0, retryCount);
  const capped = Math.min(exponential, RETRY_MAX_MS);
  // Jitter spreads retries from several devices reconnecting together.
  return Math.round(capped * (0.75 + Math.random() * 0.5));
}

export async function buildOperation(input: EnqueueInput): Promise<SyncOperation> {
  const dedupeKey = buildDedupeKey(input);
  const now = new Date().toISOString();
  return {
    operationId: crypto.randomUUID(),
    idempotencyKey: await buildIdempotencyKey(dedupeKey, input.deviceId),
    dedupeKey,
    ownerId: input.ownerId,
    entityType: input.entityType,
    entityId: input.entityId,
    operationType: input.operationType,
    payload: input.payload,
    baseVersion: input.baseVersion,
    localVersion: input.localVersion,
    deviceId: input.deviceId,
    actorId: input.actorId,
    createdAt: now,
    updatedAt: now,
    retryCount: 0,
    status: "pending",
    lastError: null,
    nextAttemptAt: now,
    lastAttemptAt: null,
    acknowledgedAt: null,
  };
}

export const syncRepository = {
  buildOperation,

  /**
   * Adds an operation to the durable queue. A duplicate dedupe key is
   * ignored rather than queued twice.
   */
  async enqueue(input: EnqueueInput): Promise<SyncOperation> {
    const operation = await buildOperation(input);
    const existing = await db.syncOperations
      .where("dedupeKey")
      .equals(operation.dedupeKey)
      .first();
    if (existing) return existing;
    await db.syncOperations.add(operation);
    return operation;
  },

  async list(ownerId: string): Promise<SyncOperation[]> {
    return db.syncOperations.where("ownerId").equals(ownerId).sortBy("createdAt");
  },

  async listForEntity(entityId: string): Promise<SyncOperation[]> {
    return db.syncOperations.where("entityId").equals(entityId).sortBy("createdAt");
  },

  async get(operationId: string): Promise<SyncOperation | undefined> {
    return db.syncOperations.get(operationId);
  },

  /** Unfinished operations, oldest first, regardless of backoff gate. */
  async getPending(ownerId: string): Promise<SyncOperation[]> {
    const operations = await this.list(ownerId);
    return operations.filter(
      (operation) =>
        operation.status === "pending" ||
        operation.status === "retry_wait" ||
        operation.status === "processing",
    );
  },

  /** Operations whose backoff window has elapsed and are ready to send. */
  async getDue(ownerId: string, now = Date.now()): Promise<SyncOperation[]> {
    const allOperations = await this.list(ownerId);
    const pending = allOperations.filter(
      (operation) =>
        // Passports are device-only. Older builds queued them, and the server
        // rejects them permanently, so leftover operations are never sent.
        operation.entityType !== "passport" &&
        (operation.status === "pending" ||
          operation.status === "retry_wait" ||
          operation.status === "processing"),
    );
    const staleBefore = now - PROCESSING_RECOVERY_MS;
    for (const operation of pending) {
      if (
        operation.status === "processing" &&
        Date.parse(operation.lastAttemptAt ?? operation.updatedAt) <= staleBefore
      ) {
        await db.syncOperations.update(operation.operationId, {
          status: "retry_wait",
          lastError: "Recovered an interrupted synchronization attempt.",
          nextAttemptAt: new Date(now).toISOString(),
          updatedAt: new Date(now).toISOString(),
        });
        operation.status = "retry_wait";
      }
    }
    const due = pending
      .filter(
        (operation) =>
          operation.status !== "processing" &&
          operation.retryCount < MAX_AUTOMATIC_RETRIES &&
          Date.parse(operation.nextAttemptAt) <= now,
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const dueIds = new Set(due.map((operation) => operation.operationId));
    const pendingCreates = new Map(
      allOperations
        .filter(
          (operation) =>
            operation.operationType === "create" &&
            operation.status !== "acknowledged" &&
            operation.status !== "superseded",
        )
        .map((operation) => [operation.entityId, operation]),
    );
    const dependencies = new Map<string, string[]>();
    for (const operation of due) {
      let payload: Record<string, unknown>;
      try {
        payload = await decryptLocalValue<Record<string, unknown>>(
          operation.payload,
        );
      } catch (error) {
        await this.markFailed(
          operation.operationId,
          error instanceof Error
            ? `The operation payload could not be decrypted for dependency ordering: ${error.message}`
            : "The operation payload could not be decrypted for dependency ordering.",
        );
        dueIds.delete(operation.operationId);
        continue;
      }
      const relatedIds = relatedEntityIds(operation, payload);
      const requiredOperations = relatedIds
        .map((entityId) => pendingCreates.get(entityId)?.operationId)
        .filter((operationId): operationId is string => operationId !== undefined);
      const previousVersion = allOperations
        .filter(
          (candidate) =>
            candidate.entityId === operation.entityId &&
            candidate.operationId !== operation.operationId &&
            candidate.localVersion < operation.localVersion &&
            candidate.status !== "acknowledged" &&
            candidate.status !== "superseded",
        )
        .sort((left, right) => left.localVersion - right.localVersion)
        .at(-1);
      if (previousVersion) requiredOperations.push(previousVersion.operationId);
      dependencies.set(operation.operationId, [...new Set(requiredOperations)]);
      if (
        requiredOperations.some((operationId) => !dueIds.has(operationId))
      ) {
        dueIds.delete(operation.operationId);
      }
    }

    const remaining = due.filter((operation) => dueIds.has(operation.operationId));
    const ordered: SyncOperation[] = [];
    while (remaining.length) {
      const readyIndex = remaining.findIndex((operation) =>
        (dependencies.get(operation.operationId) ?? []).every(
          (operationId) =>
            !dueIds.has(operationId) ||
            ordered.some((completed) => completed.operationId === operationId),
        ),
      );
      if (readyIndex < 0) {
        throw new Error("The local synchronization queue contains a dependency cycle.");
      }
      const [next] = remaining.splice(readyIndex, 1);
      ordered.push(next);
    }
    return ordered;
  },

  async countByStatus(ownerId: string): Promise<Record<OperationStatus, number>> {
    const operations = await this.list(ownerId);
    const counts: Record<OperationStatus, number> = {
      pending: 0,
      processing: 0,
      retry_wait: 0,
      failed: 0,
      acknowledged: 0,
      conflict: 0,
      superseded: 0,
    };

    for (const operation of operations) counts[operation.status] += 1;
    return counts;
  },

  async markProcessing(operationId: string): Promise<void> {
    const now = new Date().toISOString();
    await db.syncOperations.update(operationId, {
      status: "processing",
      lastAttemptAt: now,
      updatedAt: now,
    });
  },

  /** Keeps retryable work durable and schedules bounded automatic retries. */
  async markRetryWait(operationId: string, message: string): Promise<void> {
    const operation = await db.syncOperations.get(operationId);
    if (!operation) return;
    const retryCount = operation.retryCount + 1;
    await db.syncOperations.update(operationId, {
      status: retryCount >= MAX_AUTOMATIC_RETRIES ? "failed" : "retry_wait",
      retryCount,
      lastError: message,
      nextAttemptAt: new Date(Date.now() + backoffDelayMs(retryCount)).toISOString(),
      updatedAt: new Date().toISOString(),
    });
  },

  /** A permanent server rejection stays visible until clinician action. */
  async markFailed(operationId: string, message: string): Promise<void> {
    await db.syncOperations.update(operationId, {
      status: "failed",
      lastError: message,
      updatedAt: new Date().toISOString(),
    });
  },

  /** Only ever called with an explicit server acknowledgement in hand. */
  async markAcknowledged(operationId: string): Promise<void> {
    const now = new Date().toISOString();
    await db.syncOperations.update(operationId, {
      status: "acknowledged",
      lastError: null,
      acknowledgedAt: now,
      updatedAt: now,
    });
  },

  async markConflict(operationId: string, message: string): Promise<void> {
    await db.syncOperations.update(operationId, {
      status: "conflict",
      lastError: message,
      updatedAt: new Date().toISOString(),
    });
  },

  /** Clinician-driven retry: clears the backoff gate for review-blocked work. */
  async retryNow(operationId: string): Promise<void> {
    const operation = await db.syncOperations.get(operationId);
    if (
      !operation ||
      operation.status === "acknowledged" ||
      operation.status === "superseded"
    ) return;
    await db.syncOperations.update(operationId, {
      status: "pending",
      retryCount: 0,
      lastError: null,
      nextAttemptAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  },

  /** Starts a new idempotent operation after a clinician rebases a conflict. */
  async rebase(
    operationId: string,
    baseVersion: number,
    conflictId: string,
  ): Promise<SyncOperation> {
    const operation = await db.syncOperations.get(operationId);
    if (!operation || operation.status !== "conflict") {
      throw new Error("The conflicted operation is no longer available for rebasing.");
    }
    const sourceConflict = await db.syncConflicts.get(conflictId);
    if (!sourceConflict || sourceConflict.status !== "open") {
      throw new Error("The conflict is no longer open for resolution.");
    }
    const now = new Date().toISOString();
    const dedupeKey = `${operation.dedupeKey}:rebase:${baseVersion}:${crypto.randomUUID()}`;
    const successor: SyncOperation = {
      ...operation,
      baseSnapshot: sourceConflict.serverPayload ?? operation.baseSnapshot ?? null,
      operationId: crypto.randomUUID(),
      idempotencyKey: await buildIdempotencyKey(dedupeKey, operation.deviceId),
      dedupeKey,
      baseVersion,
      status: "pending",
      retryCount: 0,
      lastError: null,
      nextAttemptAt: now,
      lastAttemptAt: null,
      acknowledgedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    await db.transaction(
      "rw",
      db.syncOperations,
      db.syncConflicts,
      async () => {
        const conflict = await db.syncConflicts.get(conflictId);
        if (!conflict || conflict.status !== "open") {
          throw new Error("The conflict is no longer open for resolution.");
        }
        await db.syncOperations.update(operationId, {
          status: "superseded",
          lastError: "Rebased as a new idempotent operation after clinician review.",
          updatedAt: now,
        });
        await db.syncOperations.add(successor);
        await db.syncConflicts.update(conflictId, {
          status: "resolved",
          resolution: "keep_local",
          resolvedAt: now,
        });
      },
    );
    return successor;
  },

  async retryAllFailed(ownerId: string): Promise<number> {
    const operations = (await this.list(ownerId)).filter(
      (operation) => operation.status === "failed",
    );
    for (const operation of operations) await this.retryNow(operation.operationId);
    return operations.length;
  },

  /**
   * Sync state of a single record, derived from the queue so the interface
   * can never show "synced" for a record that is only stored locally.
   */
  async entityState(entityId: string): Promise<RecordSyncState> {
    return deriveState(await this.listForEntity(entityId));
  },

  async entityStates(entityIds: string[]): Promise<Map<string, RecordSyncState>> {
    const states = new Map<string, RecordSyncState>();
    if (!entityIds.length) return states;
    const wanted = new Set(entityIds);
    const operations = await db.syncOperations
      .where("entityId")
      .anyOf(entityIds)
      .toArray();
    const grouped = new Map<string, typeof operations>();
    for (const operation of operations) {
      const bucket = grouped.get(operation.entityId) ?? [];
      bucket.push(operation);
      grouped.set(operation.entityId, bucket);
    }
    for (const entityId of wanted) {
      states.set(entityId, deriveState(grouped.get(entityId) ?? []));
    }
    return states;
  },
};

function relatedEntityIds(
  operation: SyncOperation,
  payload: Record<string, unknown>,
): string[] {
  const patientId =
    typeof payload.patientId === "string"
      ? payload.patientId
      : typeof payload.patient_id === "string"
        ? payload.patient_id
        : null;
  const consultationId =
    typeof payload.consultationId === "string"
      ? payload.consultationId
      : typeof payload.consultation_id === "string"
        ? payload.consultation_id
        : null;
  const relations: string[] = [];
  if (operation.entityType !== "patient" && patientId) relations.push(patientId);
  if (
    (operation.entityType === "clinicalNote" ||
      operation.entityType === "observation" ||
      operation.entityType === "medication" ||
      operation.entityType === "document") &&
    consultationId
  ) {
    relations.push(consultationId);
  }
  return relations;
}

export type RecordSyncState =
  | "saved_locally"
  | "waiting_to_sync"
  | "syncing"
  | "synced"
  | "sync_failed"
  | "conflict";

function deriveState(operations: SyncOperation[]): RecordSyncState {
  if (!operations.length) return "saved_locally";
  if (operations.some((operation) => operation.status === "conflict")) return "conflict";
  if (operations.some((operation) => operation.status === "processing")) return "syncing";
  if (operations.some((operation) => operation.status === "failed")) return "sync_failed";
  if (
    operations.some(
      (operation) =>
        operation.status === "pending" || operation.status === "retry_wait",
    )
  ) {
    return "waiting_to_sync";
  }
  return "synced";
}

export const recordStateCopy: Record<
  RecordSyncState,
  { label: string; detail: string }
> = {
  saved_locally: {
    label: "Saved on this device",
    detail: "Saved securely on this device. It has not been sent to the server.",
  },
  waiting_to_sync: {
    label: "Waiting to sync",
    detail:
      "Saved securely on this device. Waiting for internet connection to synchronize.",
  },
  syncing: {
    label: "Syncing",
    detail: "Sending this record to the server. The local copy is kept until it is confirmed.",
  },
  synced: {
    label: "Synced",
    detail: "The server has confirmed every queued change for this record.",
  },
  sync_failed: {
    label: "Sync failed",
    detail:
      "Saved on this device. The last synchronization attempt failed and will be retried.",
  },
  conflict: {
    label: "Conflict requires review",
    detail:
      "The server holds a newer version. A clinician must review both versions; nothing was overwritten.",
  },
};
