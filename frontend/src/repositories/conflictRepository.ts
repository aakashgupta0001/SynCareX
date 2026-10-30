import { db } from "../database/db";
import type { SyncConflict, SyncOperation } from "../database/types";
import {
  decryptLocalValue,
  encryptLocalValue,
  requireUnlockedIdentity,
} from "../security/localVault";
import { auditRepository } from "./auditRepository";
import { syncRepository } from "./syncRepository";
import { applyResolvedServerSnapshot } from "./syncPullRepository";

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
  },
};
