import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../database/db";
import type { SyncConflict, SyncOperation } from "../database/types";
import { api, ApiError, type ConflictResolutionRequest } from "../services/api";
import {
  conflictRepository,
  normalizeToApiFields,
} from "../repositories/conflictRepository";
import { decryptLocalValue, encryptLocalValue } from "../security/localVault";
import { resetWorkspace, testUser } from "./helpers";

const PATIENT_ID = "p1111111-2222-3333-4444-555555555556";
const NOW = "2026-10-31T10:00:00.000Z";

/**
 * The shapes the sync engine stores on a conflict: the local payload is the
 * device's full snapshot (camelCase), the server payload the full server
 * entity (snake_case). Two fields diverge (fullName, contactPhone), the
 * rest agree.
 */
const localPatient = {
  id: PATIENT_ID,
  patientNumber: "SCX-SERVER001",
  fullName: "Kept Local Name",
  contactPhone: "+00-111-LOCAL",
  village: "Demo Village",
  version: 4,
};
const basePatient = {
  id: PATIENT_ID,
  patientNumber: "SCX-SERVER001",
  fullName: "Original Name",
  contactPhone: "+00-000-0000",
  village: "Demo Village",
  version: 3,
};
const serverPatient = {
  id: PATIENT_ID,
  patient_number: "SCX-SERVER001",
  full_name: "Server Name",
  contact_phone: "+00-222-SERVER",
  village: "Demo Village",
  version: 7,
  created_at: NOW,
  updated_at: NOW,
};

async function seedConflict(): Promise<SyncConflict> {
  const operation: SyncOperation = {
    operationId: crypto.randomUUID(),
    idempotencyKey: `key-${crypto.randomUUID()}`,
    dedupeKey: `patient:${PATIENT_ID}:update:4:${crypto.randomUUID()}`,
    ownerId: testUser.id,
    entityType: "patient",
    entityId: PATIENT_ID,
    operationType: "update",
    payload: await encryptLocalValue({
      fullName: localPatient.fullName,
      contactPhone: localPatient.contactPhone,
      expected_version: 3,
    }),
    baseVersion: 3,
    localVersion: 4,
    deviceId: "test-device-123456",
    actorId: testUser.id,
    createdAt: NOW,
    updatedAt: NOW,
    retryCount: 0,
    status: "conflict",
    lastError: "The server holds a newer version of this record.",
    nextAttemptAt: NOW,
    lastAttemptAt: null,
    acknowledgedAt: null,
    baseSnapshot: await encryptLocalValue(basePatient),
    localSnapshot: await encryptLocalValue(localPatient),
  };
  const conflict: SyncConflict = {
    id: crypto.randomUUID(),
    ownerId: testUser.id,
    operationId: operation.operationId,
    entityType: "patient",
    entityId: PATIENT_ID,
    baseVersion: 3,
    localVersion: 4,
    serverVersion: 7,
    localPayload: operation.localSnapshot!,
    serverPayload: await encryptLocalValue(serverPatient),
    detectedAt: NOW,
    status: "open",
    resolution: null,
    resolvedAt: null,
    message: "The server holds a newer version of this record.",
    basePayload: operation.baseSnapshot,
  };
  await db.syncOperations.add(operation);
  await db.syncConflicts.add(conflict);
  return conflict;
}

describe("field-level conflict resolution", () => {
  let publish: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    await resetWorkspace();
    publish = vi
      .spyOn(api, "publishConflictResolution")
      .mockResolvedValue({
        id: crypto.randomUUID(),
        clinic_id: "clinic",
        entity_type: "patient",
        entity_id: PATIENT_ID,
        base_version: 3,
        winning_version: 7,
        winner_source: "merged",
        resolved_by: testUser.id,
        field_decisions: null,
        resolved_at: NOW,
      });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("diffs the conflict per field and flags only the diverging ones", async () => {
    const conflict = await seedConflict();
    const diffs = await conflictRepository.diffConflict(conflict);

    const byField = new Map(diffs.map((row) => [row.field, row]));
    // Fields are compared on the server's names: the local change set's
    // fullName lands on full_name.
    expect(byField.get("full_name")).toEqual({
      field: "full_name",
      localValue: "Kept Local Name",
      serverValue: "Server Name",
      differs: true,
    });
    expect(byField.get("contact_phone")?.differs).toBe(true);
    expect(byField.get("village")).toEqual({
      field: "village",
      localValue: "Demo Village",
      serverValue: "Demo Village",
      differs: false,
    });
    // Bookkeeping fields never take part in a decision.
    expect(byField.has("expected_version")).toBe(false);
    expect(byField.has("version")).toBe(false);
    expect(byField.has("id")).toBe(false);
  });

  it("normalizes either side's snapshot onto the server's field names", () => {
    const normalized = normalizeToApiFields("patient", basePatient);
    expect(normalized).toEqual({
      patient_number: "SCX-SERVER001",
      full_name: "Original Name",
      contact_phone: "+00-000-0000",
      village: "Demo Village",
    });
  });

  it("builds the merged payload from per-field picks and re-queues only the locally-kept fields", async () => {
    const conflict = await seedConflict();
    await conflictRepository.resolveConflictFields(conflict.id, {
      full_name: "local",
      contact_phone: "server",
    });

    // The original operation is superseded by a fresh, rebased update.
    const original = await db.syncOperations.get(conflict.operationId);
    expect(original?.status).toBe("superseded");
    const successor = (await db.syncOperations.where("entityId").equals(PATIENT_ID).toArray())
      .find((operation) => operation.operationId !== conflict.operationId);
    expect(successor?.status).toBe("pending");
    expect(successor?.baseVersion).toBe(7);

    // Only the locally-kept field is re-queued, against the server version.
    const payload = await decryptLocalValue<Record<string, unknown>>(
      successor!.payload,
    );
    expect(payload).toEqual({
      fullName: "Kept Local Name",
      expected_version: 7,
    });

    // The local record holds the merge: the local name, the server phone.
    const record = await db.patients.get(PATIENT_ID);
    expect(record).toBeTruthy();
    const merged = await decryptLocalValue<Record<string, unknown>>(
      record!.encrypted,
    );
    expect(merged.fullName).toBe("Kept Local Name");
    expect(merged.contactPhone).toBe("+00-222-SERVER");
    expect(merged.village).toBe("Demo Village");
    expect(record!.version).toBe(7);

    // The conflict is closed and the decision audited with its field map.
    const resolved = await db.syncConflicts.get(conflict.id);
    expect(resolved?.status).toBe("resolved");
    expect(resolved?.resolution).toBe("merged");
    const events = await db.auditEvents.toArray();
    const audit = events.find((event) => event.action === "sync.conflict.resolved");
    expect(audit).toBeTruthy();
    const details = await decryptLocalValue<Record<string, unknown>>(
      audit!.details!,
    );
    expect(details.resolution).toBe("merged");
    expect(String(details.fields)).toContain("full_name");

    // The server receipt names the winner and the per-field decisions.
    expect(publish).toHaveBeenCalledTimes(1);
    const receipt = publish.mock.calls[0][0] as ConflictResolutionRequest;
    expect(receipt.entity_type).toBe("patient");
    expect(receipt.entity_id).toBe(PATIENT_ID);
    expect(receipt.winner_source).toBe("merged");
    expect(receipt.field_decisions).toEqual([
      {
        field: "full_name",
        choice: "local",
        local_value: "Kept Local Name",
        server_value: "Server Name",
      },
      {
        field: "contact_phone",
        choice: "server",
        local_value: "+00-111-LOCAL",
        server_value: "+00-222-SERVER",
      },
    ]);
    expect(await db.pendingConflictResolutions.count()).toBe(0);
  });

  it("queues the resolution receipt when offline instead of dropping it", async () => {
    const conflict = await seedConflict();
    publish.mockRejectedValue(
      new ApiError("The SynCareX API is unreachable.", 0),
    );

    await conflictRepository.resolveConflictFields(conflict.id, {
      full_name: "local",
    });

    // The resolution itself completed locally...
    expect((await db.syncConflicts.get(conflict.id))?.status).toBe("resolved");
    // ...and the receipt is durably queued, encrypted, for the next sync.
    const queued = await db.pendingConflictResolutions.toArray();
    expect(queued).toHaveLength(1);
    const receipt = await decryptLocalValue<ConflictResolutionRequest>(
      queued[0].payload,
    );
    expect(receipt.winner_source).toBe("merged");
    expect(receipt.field_decisions[0].field).toBe("full_name");

    // Back online, the sync engine drains the queue and clears it.
    publish.mockResolvedValue({
      id: crypto.randomUUID(),
      clinic_id: "clinic",
      entity_type: "patient",
      entity_id: PATIENT_ID,
      base_version: 3,
      winning_version: 7,
      winner_source: "merged",
      resolved_by: testUser.id,
      field_decisions: null,
      resolved_at: NOW,
    });
    const published = await conflictRepository.drainPendingResolutions();
    expect(published).toBe(1);
    expect(await db.pendingConflictResolutions.count()).toBe(0);
  });

  it("publishes record-level keep-local and keep-server decisions too", async () => {
    const conflict = await seedConflict();
    await conflictRepository.resolveKeepServer(conflict.id);
    expect(publish).toHaveBeenCalledTimes(1);
    const receipt = publish.mock.calls[0][0] as ConflictResolutionRequest;
    expect(receipt.winner_source).toBe("server");
    expect(receipt.winning_version).toBe(7);

    const second = await seedConflict();
    await conflictRepository.resolveKeepLocal(second.id);
    const localReceipt = publish.mock.calls[1][0] as ConflictResolutionRequest;
    expect(localReceipt.winner_source).toBe("local");
  });
});
