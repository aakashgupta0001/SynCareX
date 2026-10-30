/**
 * SynCareX Patient Follow-Up Manager Repository.
 *
 * Implements:
 * 1. Offline creation and rescheduling of patient follow-ups.
 * 2. Immutable rescheduling history log.
 * 3. Filtered queries for Today and Overdue follow-ups.
 * 4. Completion outcomes and cancellation audits.
 * 5. Durable queue operations for automatic background sync.
 */

import { db } from "../database/db";
import type { FollowUpPriority, FollowUpRecord, FollowUpStatus } from "../database/types";
import {
  encryptLocalValue,
  requireUnlockedIdentity,
} from "../security/localVault";
import { getLocalDeviceId } from "../offline/device";
import { buildOperation } from "./syncRepository";
import { patientRepository } from "./patientRepository";

export interface FollowUpInput {
  patientId: string;
  consultationId?: string | null;
  scheduledAt: string;
  reason: string;
  priority?: FollowUpPriority;
  status?: FollowUpStatus;
  contactPreference?: string;
  notes?: string;
}

export const followUpRepository = {
  /**
   * Creates a patient follow-up offline.
   */
  async createFollowUp(input: FollowUpInput): Promise<FollowUpRecord> {
    const identity = requireUnlockedIdentity();
    const patient = await patientRepository.getLocal(input.patientId);
    if (!patient) throw new Error("Patient not found in local vault");

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const deviceId = await getLocalDeviceId();

    const record: FollowUpRecord = {
      id,
      ownerId: identity.userId,
      patientId: input.patientId,
      patientName: patient.fullName,
      consultationId: input.consultationId,
      scheduledAt: input.scheduledAt,
      reason: input.reason,
      priority: input.priority || "routine",
      status: input.status || "scheduled",
      contactPreference: input.contactPreference || "phone",
      notes: input.notes,
      rescheduleHistory: [],
      createdAt: now,
      updatedAt: now,
      version: 1,
    };

    const encrypted = await encryptLocalValue(record);

    const operation = await buildOperation({
      ownerId: identity.userId,
      entityType: "followup",
      entityId: id,
      operationType: "create",
      payload: encrypted,
      baseVersion: 0,
      localVersion: 1,
      deviceId,
      actorId: identity.userId,
    });

    await db.transaction("rw", [db.followUps, db.syncOperations], async () => {
      await db.followUps.put(record);
      await db.syncOperations.put(operation);
    });

    return record;
  },

  /**
   * Reschedules an existing follow-up, keeping durable history of all reschedules.
   */
  async reschedule(
    id: string,
    newScheduledAt: string,
    reason: string,
  ): Promise<FollowUpRecord> {
    const identity = requireUnlockedIdentity();
    const record = await db.followUps.get(id);
    if (!record) throw new Error("Follow-up not found");

    const now = new Date().toISOString();
    const historyEntry = {
      previousScheduledAt: record.scheduledAt,
      rescheduledTo: newScheduledAt,
      reason,
      rescheduledAt: now,
    };

    const updatedRecord: FollowUpRecord = {
      ...record,
      scheduledAt: newScheduledAt,
      status: "rescheduled",
      rescheduleHistory: [...record.rescheduleHistory, historyEntry],
      updatedAt: now,
      version: record.version + 1,
    };

    const deviceId = await getLocalDeviceId();
    const encrypted = await encryptLocalValue(updatedRecord);
    const operation = await buildOperation({
      ownerId: identity.userId,
      entityType: "followup",
      entityId: id,
      operationType: "update",
      payload: encrypted,
      baseVersion: record.version,
      localVersion: updatedRecord.version,
      deviceId,
      actorId: identity.userId,
    });

    await db.transaction("rw", [db.followUps, db.syncOperations], async () => {
      await db.followUps.put(updatedRecord);
      await db.syncOperations.put(operation);
    });

    return updatedRecord;
  },

  /**
   * Completes a follow-up with recorded outcome.
   */
  async markCompleted(id: string, outcome: string): Promise<FollowUpRecord> {
    const identity = requireUnlockedIdentity();
    const record = await db.followUps.get(id);
    if (!record) throw new Error("Follow-up not found");

    const now = new Date().toISOString();
    const updatedRecord: FollowUpRecord = {
      ...record,
      status: "completed",
      outcome,
      completedAt: now,
      updatedAt: now,
      version: record.version + 1,
    };

    const deviceId = await getLocalDeviceId();
    const encrypted = await encryptLocalValue(updatedRecord);
    const operation = await buildOperation({
      ownerId: identity.userId,
      entityType: "followup",
      entityId: id,
      operationType: "update",
      payload: encrypted,
      baseVersion: record.version,
      localVersion: updatedRecord.version,
      deviceId,
      actorId: identity.userId,
    });

    await db.transaction("rw", [db.followUps, db.syncOperations], async () => {
      await db.followUps.put(updatedRecord);
      await db.syncOperations.put(operation);
    });

    return updatedRecord;
  },

  /**
   * Cancels a follow-up with recorded reason.
   */
  async cancel(id: string, reason: string): Promise<FollowUpRecord> {
    const identity = requireUnlockedIdentity();
    const record = await db.followUps.get(id);
    if (!record) throw new Error("Follow-up not found");

    const now = new Date().toISOString();
    const updatedRecord: FollowUpRecord = {
      ...record,
      status: "cancelled",
      outcome: `Cancelled: ${reason}`,
      updatedAt: now,
      version: record.version + 1,
    };

    const deviceId = await getLocalDeviceId();
    const encrypted = await encryptLocalValue(updatedRecord);
    const operation = await buildOperation({
      ownerId: identity.userId,
      entityType: "followup",
      entityId: id,
      operationType: "update",
      payload: encrypted,
      baseVersion: record.version,
      localVersion: updatedRecord.version,
      deviceId,
      actorId: identity.userId,
    });

    await db.transaction("rw", [db.followUps, db.syncOperations], async () => {
      await db.followUps.put(updatedRecord);
      await db.syncOperations.put(operation);
    });

    return updatedRecord;
  },

  async listAll(): Promise<FollowUpRecord[]> {
    return db.followUps.toCollection().sortBy("scheduledAt");
  },

  async listToday(): Promise<FollowUpRecord[]> {
    const today = new Date().toISOString().slice(0, 10);
    const all = await this.listAll();
    return all.filter((f) => f.scheduledAt.startsWith(today) && f.status !== "completed" && f.status !== "cancelled");
  },

  async listOverdue(): Promise<FollowUpRecord[]> {
    const now = new Date().toISOString();
    const all = await this.listAll();
    return all.filter(
      (f) => f.scheduledAt < now && ["scheduled", "due", "rescheduled"].includes(f.status),
    );
  },

  async listByPatient(patientId: string): Promise<FollowUpRecord[]> {
    return db.followUps.where("patientId").equals(patientId).reverse().sortBy("scheduledAt");
  },
};

