import { db } from "../database/db";
import type {
  EntityType,
  PendingConflictResolution,
  SyncConflict,
  SyncOperation,
} from "../database/types";
import { api, mapPatientChangesToApi } from "../services/api";
import {
  decryptLocalValue,
  encryptLocalValue,
  getUnlockedIdentity,
  requireUnlockedIdentity,
} from "../security/localVault";
import { auditRepository } from "./auditRepository";
import { buildIdempotencyKey, syncRepository } from "./syncRepository";
import { applyResolvedServerSnapshot } from "./syncPullRepository";
import type { ConflictResolutionRequest } from "../services/api";

export type ConflictFieldChoice = "local" | "server";

export interface ConflictFieldDiff {
  field: string;
  localValue: unknown;
  serverValue: unknown;
  differs: boolean;
}

export interface ConflictFieldDecision {
  field: string;
  choice: ConflictFieldChoice;
  localValue: unknown;
  serverValue: unknown;
}

/** Bookkeeping fields never take part in a field-level decision. */
const BOOKKEEPING_FIELDS = new Set([
  "expected_version",
  "version",
  "id",
  "created_at",
  "updated_at",
]);

function camelToSnake(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

/**
 * The server's field name for a local payload key. Patients go through the
 * shared patient field map (services/api.ts); every other entity type is a
 * plain camelCase→snake_case conversion, matching the pull path.
 */
function toApiField(entityType: EntityType, key: string): string {
  if (entityType === "patient") {
    const mapped = mapPatientChangesToApi({ [key]: true });
    const name = Object.keys(mapped)[0];
    if (name) return name;
  }
  return camelToSnake(key);
}

function valuesDiffer(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) !== JSON.stringify(right ?? null);
}

/**
 * Rewrites a record's keys onto the server's field names, so snapshots from
 * either side can be displayed next to a field diff.
 */
export function normalizeToApiFields(
  entityType: EntityType,
  record: Record<string, unknown> | null,
): Record<string, unknown> {
  if (!record) return {};
  return Object.fromEntries(
    Object.entries(record)
      .map(([key, value]): [string, unknown] => [toApiField(entityType, key), value])
      .filter(([field]) => !BOOKKEEPING_FIELDS.has(field)),
  );
}

/**
 * Per-field diff between the device's version and the server's.
 *
 * Both payloads arrive encrypted; the local one may be the device's full
 * snapshot (push-path conflicts) or its change set (pull-path conflicts),
 * while the server payload is the full server entity. Everything is
 * normalized onto the server's field names first. A field can only be
 * conflicting if the device actually changed it: with a base snapshot that
 * means its value moved away from the base, without one it means the field
 * is part of the device's change set. Server-only fields are shown for
 * context but need no decision.
 */
function buildFieldDiff(
  entityType: EntityType,
  local: Record<string, unknown> | null,
  server: Record<string, unknown> | null,
  base: Record<string, unknown> | null,
): ConflictFieldDiff[] {
  const localFields = normalizeToApiFields(entityType, local);
  const serverFields = normalizeToApiFields(entityType, server);
  const baseFields = normalizeToApiFields(entityType, base);
  const fields = new Set<string>([
    ...Object.keys(localFields),
    ...Object.keys(serverFields),
  ]);
  const rows: ConflictFieldDiff[] = [];
  for (const field of fields) {
    const localValue = Object.hasOwn(localFields, field)
      ? localFields[field]
      : undefined;
    const serverValue = Object.hasOwn(serverFields, field)
      ? serverFields[field]
      : undefined;
    const changedLocally = Object.hasOwn(baseFields, field)
      ? valuesDiffer(baseFields[field], localValue)
      : Object.hasOwn(localFields, field);
    rows.push({
      field,
      localValue,
      serverValue,
      differs: changedLocally && valuesDiffer(localValue, serverValue),
    });
  }
  return rows;
}

export const conflictRepository = {
  /**
   * Records a rejected operation for clinician review. Neither the local nor
   * the server version is changed here.
   */
  async record(options: {
    operation: SyncOperation;
    serverVersion: number | null;
    serverPayload: unknown;
    message: string;
  }): Promise<SyncConflict> {
    const existing = await db.syncConflicts
      .where("entityId")
      .equals(options.operation.entityId)
      .filter(
        (conflict) =>
          conflict.status === "open" &&
          conflict.operationId === options.operation.operationId,
      )
      .first();
    if (existing) return existing;

    const serverPayload =
      options.serverPayload === undefined || options.serverPayload === null
        ? null
        : await encryptLocalValue(options.serverPayload);
    const conflict: SyncConflict = {
      id: crypto.randomUUID(),
      ownerId: options.operation.ownerId,
      operationId: options.operation.operationId,
      entityType: options.operation.entityType,
      entityId: options.operation.entityId,
      baseVersion: options.operation.baseVersion,
      localVersion: options.operation.localVersion,
      serverVersion: options.serverVersion,
      localPayload: options.operation.localSnapshot ?? options.operation.payload,
      serverPayload,
      detectedAt: new Date().toISOString(),
      status: "open",
      resolution: null,
      resolvedAt: null,
      message: options.message,
      actorId: options.operation.actorId,
      deviceId: options.operation.deviceId,
      operationCreatedAt: options.operation.createdAt,
      basePayload: options.operation.baseSnapshot ?? null,
    };
    await db.syncConflicts.add(conflict);
    await auditRepository.record({
      action: "sync.conflict.detected",
      entityType: options.operation.entityType,
      entityId: options.operation.entityId,
      details: {
        localVersion: options.operation.localVersion,
        serverVersion: options.serverVersion,
      },
    });
    return conflict;
  },

  async listOpen(ownerId: string): Promise<SyncConflict[]> {
    const conflicts = await db.syncConflicts.where("ownerId").equals(ownerId).toArray();
    return conflicts
      .filter((conflict) => conflict.status === "open")
      .sort((left, right) => right.detectedAt.localeCompare(left.detectedAt));
  },

  async countOpen(ownerId: string): Promise<number> {
    return (await this.listOpen(ownerId)).length;
  },

  async readPayloads(conflict: SyncConflict): Promise<{
    base: Record<string, unknown> | null;
    local: Record<string, unknown> | null;
    server: Record<string, unknown> | null;
  }> {
    requireUnlockedIdentity("review conflicts");
    const base = conflict.basePayload
      ? await decryptLocalValue<Record<string, unknown>>(conflict.basePayload).catch(
          () => null,
        )
      : null;
    const local = await decryptLocalValue<Record<string, unknown>>(
      conflict.localPayload,
    ).catch(() => null);
    const server = conflict.serverPayload
      ? await decryptLocalValue<Record<string, unknown>>(conflict.serverPayload).catch(
          () => null,
        )
      : null;
    return { base, local, server };
  },

  /**
   * Clinician chose to keep the local edit. The queued operation is rebased
   * onto the server version and retried; the server copy is not discarded
   * until the server accepts the new operation.
   */
  async resolveKeepLocal(conflictId: string): Promise<void> {
    const conflict = await db.syncConflicts.get(conflictId);
    if (!conflict || conflict.status !== "open") return;
    if (requireUnlockedIdentity("resolve synchronization conflicts").userId !== conflict.ownerId) {
      throw new Error("The conflict belongs to a different local user.");
    }
    const operation = await db.syncOperations.get(conflict.operationId);
    const now = new Date().toISOString();
    if (operation && conflict.serverVersion !== null) {
      await syncRepository.rebase(
        operation.operationId,
        conflict.serverVersion,
        conflictId,
      );
    } else if (operation) {
      throw new Error(
        "The server version is unavailable, so this edit cannot be safely rebased.",
      );
    }
    await db.syncConflicts.update(conflictId, {
      status: "resolved",
      resolution: "keep_local",
      resolvedAt: now,
    });
    await auditRepository.record({
      action: "sync.conflict.resolved",
      entityType: conflict.entityType,
      entityId: conflict.entityId,
      details: { resolution: "keep_local" },
    });
    // The server learns who resolved what, when, and which version won.
    await recordResolutionOnServer(conflict.ownerId, {
      entity_type: conflict.entityType,
      entity_id: conflict.entityId,
      base_version: conflict.baseVersion,
      winning_version: conflict.serverVersion ?? conflict.localVersion,
      winner_source: "local",
      field_decisions: [],
    });
  },

  /**
   * Clinician chose the server version. The local operation stops being
   * retried, but the conflict row keeps the local attempt for the record.
   */
  async resolveKeepServer(conflictId: string): Promise<void> {
    const conflict = await db.syncConflicts.get(conflictId);
    if (!conflict || conflict.status !== "open") return;
    if (requireUnlockedIdentity("resolve synchronization conflicts").userId !== conflict.ownerId) {
      throw new Error("The conflict belongs to a different local user.");
    }
    const now = new Date().toISOString();
    const operation = await db.syncOperations.get(conflict.operationId);
    if (operation) {
      if (!conflict.serverPayload) {
        throw new Error("The server snapshot is unavailable and cannot replace this record.");
      }
      const serverPayload = await decryptLocalValue<Record<string, unknown>>(
        conflict.serverPayload,
      );
      await applyResolvedServerSnapshot(
        conflict.ownerId,
        conflict.entityType,
        conflict.entityId,
        serverPayload,
      );
      await db.syncOperations.update(operation.operationId, {
        status: "superseded",
        lastError: "Superseded by the server version after clinician review.",
        updatedAt: now,
      });
    }
    await db.syncConflicts.update(conflictId, {
      status: "resolved",
      resolution: "keep_server",
      resolvedAt: now,
    });
    await auditRepository.record({
      action: "sync.conflict.resolved",
      entityType: conflict.entityType,
      entityId: conflict.entityId,
      details: { resolution: "keep_server" },
    });
    await recordResolutionOnServer(conflict.ownerId, {
      entity_type: conflict.entityType,
      entity_id: conflict.entityId,
      base_version: conflict.baseVersion,
      winning_version: conflict.serverVersion ?? conflict.localVersion,
      winner_source: "server",
      field_decisions: [],
    });
  },

  /**
   * Per-field diff between this device's version and the server's. Fields
   * are normalized onto the server's names, so a locally-edited `fullName`
   * and a server `full_name` are compared as one field.
   */
  async diffConflict(conflict: SyncConflict): Promise<ConflictFieldDiff[]> {
    const { base, local, server } = await this.readPayloads(conflict);
    return buildFieldDiff(conflict.entityType, local, server, base);
  },

  /**
   * Field-level resolution: the clinician picks local or server per
   * differing field. The merged record is written locally through the
   * existing server-snapshot path, the locally-kept fields are re-queued as
   * a normal update operation against the server version (the existing
   * update path), and the decision is published to the server — inline when
   * online, otherwise queued durably in Dexie for the sync engine to drain.
   */
  async resolveConflictFields(
    conflictId: string,
    picks: Record<string, ConflictFieldChoice>,
  ): Promise<void> {
    const conflict = await db.syncConflicts.get(conflictId);
    if (!conflict || conflict.status !== "open") return;
    if (
      requireUnlockedIdentity("resolve synchronization conflicts").userId !==
      conflict.ownerId
    ) {
      throw new Error("The conflict belongs to a different local user.");
    }
    if (conflict.serverVersion === null) {
      throw new Error(
        "The server version is unavailable, so this conflict cannot be merged safely.",
      );
    }
    const { base, local, server } = await this.readPayloads(conflict);
    if (!server) {
      throw new Error("The server snapshot is unavailable and cannot be merged.");
    }

    const diffs = buildFieldDiff(conflict.entityType, local, server, base);
    const decisions: ConflictFieldDecision[] = diffs
      .filter((row) => row.differs)
      .map((row) => ({
        field: row.field,
        // An undecided differing field keeps the server value: the safe side.
        choice: picks[row.field] ?? "server",
        localValue: row.localValue,
        serverValue: row.serverValue,
      }));
    const winnerSource: "local" | "server" | "merged" =
      decisions.length && decisions.every((decision) => decision.choice === "local")
        ? "local"
        : decisions.every((decision) => decision.choice === "server")
          ? "server"
          : "merged";
    const now = new Date().toISOString();

    // Locally-kept fields, in the local payload's own (camelCase) keys, so
    // the queued update flows through the normal serialization path.
    const localChanges: Record<string, unknown> = {};
    const mergedSnapshot: Record<string, unknown> = { ...server };
    for (const decision of decisions) {
      if (decision.choice !== "local") continue;
      const entry = Object.entries(local ?? {}).find(
        ([key]) => toApiField(conflict.entityType, key) === decision.field,
      );
      if (!entry || entry[1] === undefined) continue;
      localChanges[entry[0]] = entry[1];
      mergedSnapshot[decision.field] = entry[1];
    }

    // The local record becomes the merged version: server snapshot with the
    // locally-kept fields re-applied. Same encrypted write path as
    // keep-server, so no clinical content bypasses the vault.
    await applyResolvedServerSnapshot(
      conflict.ownerId,
      conflict.entityType,
      conflict.entityId,
      mergedSnapshot,
    );

    const operation = await db.syncOperations.get(conflict.operationId);
    if (operation) {
      if (Object.keys(localChanges).length) {
        // Re-queue only the locally-kept changes, rebased onto the server
        // version — the same shape as the keep-local rebase, minus the
        // fields the clinician gave to the server.
        const dedupeKey = `${operation.dedupeKey}:merge:${conflict.serverVersion}:${crypto.randomUUID()}`;
        const successor: SyncOperation = {
          ...operation,
          payload: await encryptLocalValue({
            ...localChanges,
            expected_version: conflict.serverVersion,
          }),
          baseSnapshot: conflict.serverPayload,
          operationId: crypto.randomUUID(),
          idempotencyKey: await buildIdempotencyKey(dedupeKey, operation.deviceId),
          dedupeKey,
          baseVersion: conflict.serverVersion,
          status: "pending",
          retryCount: 0,
          lastError: null,
          nextAttemptAt: now,
          lastAttemptAt: null,
          acknowledgedAt: null,
          createdAt: now,
          updatedAt: now,
        };
        await db.syncOperations.update(operation.operationId, {
          status: "superseded",
          lastError: "Superseded by the clinician's field-level merge.",
          updatedAt: now,
        });
        await db.syncOperations.add(successor);
      } else {
        await db.syncOperations.update(operation.operationId, {
          status: "superseded",
          lastError: "Superseded by the server version after clinician review.",
          updatedAt: now,
        });
      }
    }

    await db.syncConflicts.update(conflictId, {
      status: "resolved",
      resolution: winnerSource === "local" ? "keep_local" : winnerSource === "server" ? "keep_server" : "merged",
      resolvedAt: now,
    });
    await auditRepository.record({
      action: "sync.conflict.resolved",
      entityType: conflict.entityType,
      entityId: conflict.entityId,
      details: {
        resolution: winnerSource,
        winningVersion: conflict.serverVersion ?? conflict.localVersion,
        fields: decisions.map((decision) => decision.field).join(","),
        fieldDecisions: JSON.stringify(
          decisions.map(({ field, choice, localValue, serverValue }) => ({
            field,
            choice,
            local_value: localValue,
            server_value: serverValue,
          })),
        ),
      },
    });
    await recordResolutionOnServer(conflict.ownerId, {
      entity_type: conflict.entityType,
      entity_id: conflict.entityId,
      base_version: conflict.baseVersion,
      winning_version: conflict.serverVersion ?? conflict.localVersion,
      winner_source: winnerSource,
      field_decisions: decisions.map(
        ({ field, choice, localValue, serverValue }) => ({
          field,
          choice,
          local_value: localValue,
          server_value: serverValue,
        }),
      ),
    });
  },

  /**
   * Publishes queued conflict resolutions once the API is reachable. Each
   * receipt is deleted only after the server acknowledged it; failures stay
   * queued with the error recorded.
   */
  async drainPendingResolutions(): Promise<number> {
    const pending = await db.pendingConflictResolutions.toArray();
    let published = 0;
    for (const item of pending) {
      try {
        const resolution = await decryptLocalValue<ConflictResolutionRequest>(
          item.payload,
        );
        await api.publishConflictResolution(resolution);
        await db.pendingConflictResolutions.delete(item.id);
        published += 1;
      } catch (error) {
        await db.pendingConflictResolutions.update(item.id, {
          lastError:
            error instanceof Error
              ? error.message
              : "The conflict resolution could not be published.",
        });
      }
    }
    return published;
  },
};

/**
 * Sends the resolution receipt to the server. When the request cannot be
 * completed (offline, session expired, server error) the receipt is queued
 * durably in Dexie — encrypted, like all clinical content — and the sync
 * engine drains it on the next successful contact. A failed receipt never
 * blocks or undoes the resolution itself.
 */
async function recordResolutionOnServer(
  ownerId: string,
  resolution: ConflictResolutionRequest,
): Promise<void> {
  try {
    await api.publishConflictResolution(resolution);
  } catch (error) {
    const identity = getUnlockedIdentity();
    if (!identity || identity.userId !== ownerId) return;
    const pending: PendingConflictResolution = {
      id: crypto.randomUUID(),
      ownerId,
      payload: await encryptLocalValue(resolution),
      lastError: error instanceof Error ? error.message : null,
      createdAt: new Date().toISOString(),
    };
    await db.pendingConflictResolutions.put(pending);
  }
}
