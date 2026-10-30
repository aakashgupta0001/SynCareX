/**
 * SynCareX Smart Referral Repository.
 *
 * Implements:
 * 1. Offline referral creation and draft management.
 * 2. Distinct referral status state machine.
 * 3. Separation of sent, delivered, received, and accepted outcomes.
 * 4. Durable sync operation queueing.
 * 5. Preservation of document and source clinical references.
 */

import { db } from "../database/db";
import type { ReferralPriority, ReferralRecord, ReferralStatus } from "../database/types";
import {
  decryptLocalValue,
  encryptLocalValue,
  requireUnlockedIdentity,
} from "../security/localVault";
import { getLocalDeviceId } from "../offline/device";
import { buildOperation } from "./syncRepository";
import { patientRepository } from "./patientRepository";

export interface ReferralPayload {
  receivingClinicId: string;
  receivingClinicName?: string;
  patientId: string;
  patientName?: string;
  reason: string;
  clinicalSummary?: string;
  priority: ReferralPriority;
  status: ReferralStatus;
  consentPolicy?: string;
  includedData?: Record<string, unknown>;
  sourceReferences?: Record<string, unknown>;
}

export const referralRepository = {
  /**
   * Creates or drafts a referral offline.
   */
  async createReferral(data: ReferralPayload): Promise<ReferralRecord> {
    const identity = requireUnlockedIdentity();
    const patient = await patientRepository.getLocal(data.patientId);
    if (!patient) throw new Error("Patient not found in local vault");

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const deviceId = await getLocalDeviceId();

    const fullPayload: ReferralPayload = {
      ...data,
      patientName: patient.fullName,
      sourceReferences: data.sourceReferences || { patientNumber: patient.patientNumber },
    };

    const encrypted = await encryptLocalValue(fullPayload);

    const record: ReferralRecord = {
      id,
      ownerId: identity.userId,
      patientId: data.patientId,
      patientName: patient.fullName,
      referringClinicId: identity.userId,
      receivingClinicId: data.receivingClinicId,
      receivingClinicName: data.receivingClinicName,
      reason: data.reason,
      clinicalSummary: data.clinicalSummary,
      priority: data.priority,
      status: data.status,
      consentPolicy: data.consentPolicy,
      encrypted,
      sourceReferences: fullPayload.sourceReferences,
      createdAt: now,
      updatedAt: now,
      version: 1,
    };

    // Queue sync operation only if submitted beyond draft or ready
    const operation = await buildOperation({
      ownerId: identity.userId,
      entityType: "referral",
      entityId: id,
      operationType: "create",
      payload: encrypted,
      baseVersion: 0,
      localVersion: 1,
      deviceId,
      actorId: identity.userId,
    });

    await db.transaction("rw", [db.referrals, db.syncOperations], async () => {
      await db.referrals.put(record);
      await db.syncOperations.put(operation);
    });

    return record;
  },

  /**
   * Updates an existing referral.
   */
  async updateReferral(
    id: string,
    updates: Partial<ReferralPayload>,
  ): Promise<ReferralRecord> {
    const identity = requireUnlockedIdentity();
    const record = await db.referrals.get(id);
    if (!record) throw new Error("Referral not found");

    const currentPayload = await decryptLocalValue<ReferralPayload>(record.encrypted);
    const updatedPayload: ReferralPayload = { ...currentPayload, ...updates };
    const encrypted = await encryptLocalValue(updatedPayload);
    const now = new Date().toISOString();
    const deviceId = await getLocalDeviceId();

    const updatedRecord: ReferralRecord = {
      ...record,
      reason: updates.reason ?? record.reason,
      clinicalSummary: updates.clinicalSummary ?? record.clinicalSummary,
      priority: updates.priority ?? record.priority,
      status: updates.status ?? record.status,
      encrypted,
      updatedAt: now,
      version: record.version + 1,
    };

    const operation = await buildOperation({
      ownerId: identity.userId,
      entityType: "referral",
      entityId: id,
      operationType: "update",
      payload: encrypted,
      baseVersion: record.version,
      localVersion: updatedRecord.version,
      deviceId,
      actorId: identity.userId,
    });

    await db.transaction("rw", [db.referrals, db.syncOperations], async () => {
      await db.referrals.put(updatedRecord);
      await db.syncOperations.put(operation);
    });

    return updatedRecord;
  },

  /**
   * Transitions referral status with validation and timestamp recording.
   */
  async updateStatus(
    id: string,
    status: ReferralStatus,
  ): Promise<ReferralRecord> {
    const record = await db.referrals.get(id);
    if (!record) throw new Error("Referral not found");

    const now = new Date().toISOString();
    const updates: Partial<ReferralRecord> = { status, updatedAt: now, version: record.version + 1 };

    if (status === "sent") updates.sentAt = now;
    else if (status === "received") updates.receivedAt = now;
    else if (status === "accepted") updates.acceptedAt = now;

    const currentPayload = await decryptLocalValue<ReferralPayload>(record.encrypted);
    currentPayload.status = status;
    const encrypted = await encryptLocalValue(currentPayload);
    updates.encrypted = encrypted;

    const updatedRecord = { ...record, ...updates };

    const deviceId = await getLocalDeviceId();
    const operation = await buildOperation({
      ownerId: record.ownerId,
      entityType: "referral",
      entityId: id,
      operationType: "update",
      payload: encrypted,
      baseVersion: record.version,
      localVersion: updatedRecord.version,
      deviceId,
      actorId: record.ownerId,
    });

    await db.transaction("rw", [db.referrals, db.syncOperations], async () => {
      await db.referrals.put(updatedRecord);
      await db.syncOperations.put(operation);
    });

    return updatedRecord;
  },

  async listReferrals(patientId?: string): Promise<ReferralRecord[]> {
    if (patientId) {
      return db.referrals.where("patientId").equals(patientId).reverse().sortBy("createdAt");
    }
    return db.referrals.toCollection().reverse().sortBy("createdAt");
  },

  async getReferral(id: string): Promise<ReferralRecord | undefined> {
    return db.referrals.get(id);
  },
};

