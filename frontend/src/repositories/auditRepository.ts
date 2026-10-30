import { db } from "../database/db";
import type { AuditEvent } from "../database/types";
import { getLocalDeviceId } from "../offline/device";
import {
  decryptLocalValue,
  encryptLocalValue,
  getUnlockedIdentity,
} from "../security/localVault";

export interface AuditInput {
  action: string;
  entityType: string;
  entityId: string | null;
  /** Encrypted before storage; never written to the console or a URL. */
  details?: Record<string, string | number | null>;
}

export const auditRepository = {
  /**
   * Records a local audit event for a clinically relevant change. Failures
   * are swallowed on purpose: audit logging must never block a clinical save
   * that has already been committed.
   */
  async record(input: AuditInput): Promise<void> {
    const identity = getUnlockedIdentity();
    if (!identity) return;
    try {
      const [deviceId, details] = await Promise.all([
        getLocalDeviceId(),
        input.details ? encryptLocalValue(input.details) : Promise.resolve(null),
      ]);
      await db.auditEvents.add({
        id: crypto.randomUUID(),
        ownerId: identity.userId,
        actorId: identity.userId,
        deviceId,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        details,
        createdAt: new Date().toISOString(),
        synced: 0,
      });
    } catch {
      // Intentionally ignored; see above.
    }
  },

  async list(ownerId: string, limit = 200): Promise<AuditEvent[]> {
    const events = await db.auditEvents.where("ownerId").equals(ownerId).toArray();
    return events
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit);
  },

  async readDetails(event: AuditEvent): Promise<Record<string, unknown> | null> {
    if (!event.details) return null;
    try {
      return await decryptLocalValue<Record<string, unknown>>(event.details);
    } catch {
      return null;
    }
  },

  async count(ownerId: string): Promise<number> {
    return db.auditEvents.where("ownerId").equals(ownerId).count();
  },
};
