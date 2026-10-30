import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../database/db";
import {
  allergyRepository,
  consultationRepository,
  clinicalNoteRepository,
  medicationRepository,
  observationRepository,
} from "../repositories/consultationRepository";
import { patientRepository } from "../repositories/patientRepository";
import { syncRepository } from "../repositories/syncRepository";
import { conflictRepository } from "../repositories/conflictRepository";
import { documentRepository } from "../repositories/documentRepository";
import { syncNow } from "../services/syncEngine";
import { resetConnectivityForTests } from "../services/connectivity";
import {
  forgetClinicKey,
  unlockClinicKey,
} from "../security/clinicKey";
import {
  makeFile,
  resetWorkspace,
  restartBrowser,
  setOnline,
  syntheticPatient,
  testUser,
} from "./helpers";

/**
 * A minimal stand-in for the SynCareX API. It records what the device sent so
 * the tests can assert that a replayed operation is recognised as a duplicate
 * exactly the way the real server does.
 */
class FakeServer {
  available = true;
  readonly seenKeys = new Map<string, Record<string, unknown>>();
  readonly patients = new Map<string, Record<string, unknown>>();
  readonly uploads: string[] = [];
  readonly changes: Record<string, unknown>[] = [];
  readonly receivedOperations: {
    entity_type: string;
    operation_type: string;
    payload: Record<string, unknown>;
    sealed_content?: { ciphertext: string; iv: string; key_epoch: number };
    search_terms?: string[];
  }[] = [];
  /** Forces a conflict for this entity, as if another device had edited it. */
  conflictFor: string | null = null;
  requestCount = 0;

  handle = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    this.requestCount += 1;
    if (!this.available) throw new TypeError("Failed to fetch");

    if (url.endsWith("/health")) {
      return this.json({ status: "ok" });
    }
    if (url.endsWith("/sync/devices/provision")) {
      return this.json({
        device_id: "device",
        server_device_id: "11111111-1111-1111-1111-111111111111",
        status: "active",
        offline_grace_days: 7,
        provisioned_at: new Date().toISOString(),
      });
    }
    if (url.includes("/sync/changes?")) {
      const requestUrl = new URL(url, "http://localhost");
      const cursor = Number(requestUrl.searchParams.get("cursor") ?? 0);
      const limit = Number(requestUrl.searchParams.get("limit") ?? 200);
      const changes = this.changes.filter(
        (change) => Number(change.cursor) > cursor,
      );
      const page = changes.slice(0, limit);
      return this.json({
        changes: page,
        next_cursor: page.length ? page[page.length - 1].cursor : cursor,
        has_more: changes.length > limit,
      });
    }
    if (url.endsWith("/sync/operations")) {
      const body = JSON.parse(String(init?.body)) as {
        operations: {
          operation_id: string;
          idempotency_key: string;
          entity_type: string;
          entity_id: string;
          operation_type: string;
          payload: Record<string, unknown>;
          sealed_content?: { ciphertext: string; iv: string; key_epoch: number };
          search_terms?: string[];
        }[];
      };
      this.receivedOperations.push(
        ...body.operations.map(({ entity_type, operation_type, payload, sealed_content, search_terms }) => ({
          entity_type,
          operation_type,
          payload,
          sealed_content,
          search_terms,
        })),
      );
      const results = body.operations.map((operation) => {
        const stored = this.seenKeys.get(operation.idempotency_key);
        if (stored) {
          return {
            operation_id: operation.operation_id,
            idempotency_key: operation.idempotency_key,
            entity_type: operation.entity_type,
            entity_id: operation.entity_id,
            status: "acknowledged",
            duplicate: true,
            retryable: false,
            server_version: 1,
            message: "This operation was already applied by the server.",
            entity: stored,
          };
        }
        if (this.conflictFor === operation.entity_id) {
          return {
            operation_id: operation.operation_id,
            idempotency_key: operation.idempotency_key,
            entity_type: operation.entity_type,
            entity_id: operation.entity_id,
            status: "conflict",
            duplicate: false,
            retryable: false,
            server_version: 9,
            message: "The server holds a newer version of this record.",
            entity: {
              ...(this.patients.get(operation.entity_id) ?? {}),
              village: "Edited by another device",
              version: 9,
            },
          };
        }
        const entity = this.entityFor(operation);
        this.seenKeys.set(operation.idempotency_key, entity);
        if (operation.entity_type === "patient") {
          this.patients.set(operation.entity_id, entity);
        }
        return {
          operation_id: operation.operation_id,
          idempotency_key: operation.idempotency_key,
          entity_type: operation.entity_type,
          entity_id: operation.entity_id,
          status: "acknowledged",
          duplicate: false,
          retryable: false,
          server_version: 1,
          message: null,
          entity,
        };
      });
      return this.json({
        results,
        server_time: new Date().toISOString(),
        acknowledged: results.filter((item) => item.status === "acknowledged").length,
        conflicts: results.filter((item) => item.status === "conflict").length,
        rejected: 0,
      });
    }
    if (url.includes("/documents/") && url.endsWith("/content")) {
      const documentId = url.split("/documents/")[1].replace("/content", "");
      this.uploads.push(documentId);
      return this.json({ id: documentId, content_received_at: new Date().toISOString() });
    }
    return this.json({ detail: "Not found" }, 404);
  };

  private entityFor(operation: {
    entity_type: string;
    entity_id: string;
    payload: Record<string, unknown>;
  }): Record<string, unknown> {
    if (operation.entity_type !== "patient") {
      return { id: operation.entity_id, ...operation.payload };
    }
    return {
      id: operation.entity_id,
      clinic_id: "clinic",
      patient_number: "SCX-SERVER001",
      full_name: operation.payload.full_name ?? "Synthetic Test Patient",
      date_of_birth: null,
      estimated_age: 34,
      gender: null,
      contact_phone: null,
      address: null,
      village: operation.payload.village ?? "Demo Village",
      emergency_contact_name: null,
      emergency_contact_phone: null,
      relevant_history: null,
      allergies: [],
      version: 1,
      archived_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
  }

  private json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }
}

let server: FakeServer;

beforeEach(async () => {
  setOnline(true);
  server = new FakeServer();
  vi.stubGlobal("fetch", server.handle);
  await resetWorkspace();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetConnectivityForTests();
});

describe("D. failure handling", () => {
  it("saves locally and keeps operations queued while the backend is unavailable", async () => {
    server.available = false;
    setOnline(true);

    const patient = await patientRepository.createLocal(syntheticPatient);
    expect(patient.id).toBeTruthy();

    const outcome = await syncNow(testUser.id);
    expect(outcome.skipped).toBe(true);
    expect(outcome.message).toContain("not reachable");

    const pending = await syncRepository.getPending(testUser.id);
    expect(pending).toHaveLength(1);
    expect(pending[0].status).toBe("pending");

    // The local record is unaffected by the failed attempt.
    expect((await patientRepository.getLocal(patient.id))?.fullName).toBe(
      syntheticPatient.fullName,
    );
  });
});

describe("E. pull synchronization", () => {
    it("applies a server snapshot and persists its cursor across browser restart", async () => {
      const now = new Date().toISOString();
      const patientId = crypto.randomUUID();
      server.changes.push({
        cursor: 1,
        operation_id: null,
        entity_type: "patient",
        entity_id: patientId,
        operation_type: "update",
        entity_version: 3,
        payload: {
          id: patientId,
          clinic_id: "synthetic-clinic",
          patient_number: "SCX-PULL001",
          full_name: "Synthetic Pulled Patient",
          date_of_birth: null,
          estimated_age: 38,
          gender: null,
          contact_phone: null,
          address: null,
          village: "Remote Village",
          emergency_contact_name: null,
          emergency_contact_phone: null,
          relevant_history: null,
          allergies: [],
          version: 3,
          archived_at: null,
          created_at: now,
          updated_at: now,
        },
        tombstone: false,
        created_at: now,
      });

      const outcome = await syncNow(testUser.id);
      expect(outcome.skipped).toBe(false);
      expect(outcome.message).toContain("Applied 1 server change");
      const patient = await patientRepository.getLocal(patientId);
      expect(patient?.village).toBe("Remote Village");
      expect(patient?.version).toBe(3);

      await restartBrowser();
      expect((await patientRepository.getLocal(patientId))?.fullName).toBe(
        "Synthetic Pulled Patient",
      );
      expect(await db.localSettings.get(`sync-pull-cursor:${testUser.id}`)).toMatchObject({
        value: "1",
      });
    });
});

describe("clinical correction synchronization", () => {
  it("serializes edit and entered-in-error operations with their base versions", async () => {
    const patient = await patientRepository.createLocal(syntheticPatient);
    const observation = await observationRepository.createLocal({
      patientId: patient.id,
      code: "temperature",
      label: "Temperature",
      value: "37.2",
      unit: "C",
    });
    const allergy = await allergyRepository.createLocal({
      patientId: patient.id,
      substance: "Synthetic allergen",
      reaction: "Rash",
      severity: "mild",
    });
    const medication = await medicationRepository.createLocal({
      patientId: patient.id,
      name: "Synthetic medication",
      dose: "10 mg",
      frequency: "daily",
    });

    await observationRepository.updateLocal(observation.id, { value: "37.5" });
    await allergyRepository.updateLocal(allergy.id, { severity: "moderate" });
    await medicationRepository.updateLocal(medication.id, { dose: "20 mg" });
    await observationRepository.archiveLocal(observation.id, "Wrong measurement.");
    await allergyRepository.archiveLocal(allergy.id, "Wrong patient.");
    await medicationRepository.archiveLocal(medication.id, "Duplicate entry.");

    const outcome = await syncNow(testUser.id);
    expect(outcome.failed).toBe(0);

    for (const [entityType, expectedReason] of [
      ["observation", "Wrong measurement."],
      ["allergy", "Wrong patient."],
      ["medication", "Duplicate entry."],
    ]) {
      const sent = server.receivedOperations.filter(
        (operation) => operation.entity_type === entityType,
      );
      const update = sent.find((operation) => operation.operation_type === "update");
      const archive = sent.find((operation) => operation.operation_type === "archive");
      expect(update?.payload.expected_version).toBe(1);
      expect(archive?.payload.expected_version).toBe(2);
      expect(archive?.payload.reason).toBe(expectedReason);
    }

    expect(
      server.receivedOperations.find(
        (operation) =>
          operation.entity_type === "observation" &&
          operation.operation_type === "update",
      )?.payload.value,
    ).toBe("37.5");
    expect(
      server.receivedOperations.find(
        (operation) =>
          operation.entity_type === "allergy" &&
          operation.operation_type === "update",
      )?.payload.severity,
    ).toBe("moderate");
    expect(
      server.receivedOperations.find(
        (operation) =>
          operation.entity_type === "medication" &&
          operation.operation_type === "update",
      )?.payload.dose,
    ).toBe("20 mg");
  });
});

describe("D. retry behavior", () => {
  it("retries successfully once the backend comes back", async () => {
    server.available = false;
    const patient = await patientRepository.createLocal(syntheticPatient);
    await syncNow(testUser.id);
    expect((await syncRepository.getPending(testUser.id))).toHaveLength(1);

    server.available = true;
    resetConnectivityForTests();
    const outcome = await syncNow(testUser.id);

    expect(outcome.skipped).toBe(false);
    expect(outcome.acknowledged).toBe(1);
    expect(await syncRepository.getPending(testUser.id)).toHaveLength(0);
    expect(await syncRepository.entityState(patient.id)).toBe("synced");
  });

  it("applies exponential backoff to a failed operation and allows a manual retry", async () => {
    await patientRepository.createLocal(syntheticPatient);
    const [operation] = await syncRepository.getPending(testUser.id);

    await syncRepository.markRetryWait(operation.operationId, "Server error");
    const afterFirst = await syncRepository.get(operation.operationId);
    expect(afterFirst?.retryCount).toBe(1);
    expect(Date.parse(afterFirst!.nextAttemptAt)).toBeGreaterThan(Date.now());

    await syncRepository.markRetryWait(operation.operationId, "Server error");
    const afterSecond = await syncRepository.get(operation.operationId);
    expect(afterSecond?.retryCount).toBe(2);
    // The second wait is longer than the first.
    expect(Date.parse(afterSecond!.nextAttemptAt)).toBeGreaterThan(
      Date.parse(afterFirst!.nextAttemptAt),
    );
    // A backed-off operation is not due yet, but is still pending.
    expect(await syncRepository.getDue(testUser.id)).toHaveLength(0);
    expect(await syncRepository.getPending(testUser.id)).toHaveLength(1);

    await syncRepository.retryNow(operation.operationId);
    expect(await syncRepository.getDue(testUser.id)).toHaveLength(1);
  });

  it("orders updates after their local create operation", async () => {
    const patient = await patientRepository.createLocal(syntheticPatient);
    await patientRepository.updateLocal(patient.id, { village: "Updated offline" });

    const due = await syncRepository.getDue(testUser.id);
    expect(due.map((operation) => operation.operationType)).toEqual([
      "create",
      "update",
    ]);
  });

  it("never marks an operation acknowledged without a server answer", async () => {
    await patientRepository.createLocal(syntheticPatient);
    // The server answers the request but omits this operation's result.
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/sync/operations")) {
        return new Response(
          JSON.stringify({
            results: [],
            server_time: new Date().toISOString(),
            acknowledged: 0,
            conflicts: 0,
            rejected: 0,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return server.handle(input, init);
    });

    const outcome = await syncNow(testUser.id);
    expect(outcome.acknowledged).toBe(0);
    expect(outcome.failed).toBe(1);

    const pending = await syncRepository.getPending(testUser.id);
    expect(pending).toHaveLength(1);
    expect(pending[0].lastError).toContain("did not report an outcome");
  });
});

describe("E. duplicate prevention", () => {
  it("recognises a replayed operation as a duplicate instead of creating a second record", async () => {
    const patient = await patientRepository.createLocal(syntheticPatient);
    const [operation] = await syncRepository.getPending(testUser.id);
    const firstKey = operation.idempotencyKey;

    await syncNow(testUser.id);
    expect(server.patients.size).toBe(1);

    // The device never saw the answer, so it queues the same change again.
    await syncRepository.enqueue({
      ownerId: testUser.id,
      entityType: "patient",
      entityId: patient.id,
      operationType: "create",
      payload: operation.payload,
      baseVersion: 0,
      localVersion: 1,
      deviceId: operation.deviceId,
      actorId: testUser.id,
    });
    await db.syncOperations.update(operation.operationId, {
      status: "pending",
      nextAttemptAt: new Date().toISOString(),
    });

    const second = await syncNow(testUser.id);
    expect(second.acknowledged).toBe(1);
    // Same idempotency key, and still only one patient on the server.
    expect(firstKey).toBe(operation.idempotencyKey);
    expect(server.patients.size).toBe(1);
    expect(server.seenKeys.size).toBe(1);
  });

  it("uses a stable idempotency key that survives a restart", async () => {
    const patient = await patientRepository.createLocal(syntheticPatient);
    const before = (await syncRepository.listForEntity(patient.id))[0];
    await restartBrowser();
    const after = (await syncRepository.listForEntity(patient.id))[0];
    expect(after.idempotencyKey).toBe(before.idempotencyKey);
    expect(after.dedupeKey).toBe(before.dedupeKey);
  });
});

describe("conflicts and documents", () => {
  it("records a conflict for review and never overwrites the local record", async () => {
    const patient = await patientRepository.createLocal(syntheticPatient);
    await syncNow(testUser.id);
    await patientRepository.updateLocal(patient.id, { village: "Offline edit" });
    server.conflictFor = patient.id;

    const outcome = await syncNow(testUser.id);
    expect(outcome.conflicts).toBe(1);

    const conflicts = await conflictRepository.listOpen(testUser.id);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].serverVersion).toBe(9);
    expect(await syncRepository.entityState(patient.id)).toBe("conflict");

    // The clinician's local version is intact and still readable.
    expect((await patientRepository.getLocal(patient.id))?.village).toBe("Offline edit");

    const payloads = await conflictRepository.readPayloads(conflicts[0]);
    expect(payloads.base?.village).toBe(syntheticPatient.village);
    expect(payloads.local?.village).toBe("Offline edit");
    expect(payloads.server?.village).toBe("Edited by another device");

    await conflictRepository.resolveKeepLocal(conflicts[0].id);
    expect(await conflictRepository.listOpen(testUser.id)).toHaveLength(0);
    const requeued = await syncRepository.getDue(testUser.id);
    expect(requeued).toHaveLength(1);
    expect(requeued[0].baseVersion).toBe(9);
    expect(requeued[0].operationId).not.toBe(conflicts[0].operationId);
    expect(
      (await syncRepository.get(conflicts[0].operationId))?.status,
    ).toBe("superseded");
  });

  it("applies the server snapshot when a clinician resolves a conflict in its favor", async () => {
    const patient = await patientRepository.createLocal(syntheticPatient);
    await syncNow(testUser.id);
    await patientRepository.updateLocal(patient.id, { village: "Offline edit" });
    server.conflictFor = patient.id;

    await syncNow(testUser.id);
    const [conflict] = await conflictRepository.listOpen(testUser.id);
    await conflictRepository.resolveKeepServer(conflict.id);

    expect((await patientRepository.getLocal(patient.id))?.village).toBe(
      "Edited by another device",
    );
    expect(await syncRepository.entityState(patient.id)).toBe("synced");
    expect((await syncRepository.get(conflict.operationId))?.status).toBe(
      "superseded",
    );
  });

  it("uploads document bytes only after the metadata is acknowledged, keeping the local copy", async () => {
    const patient = await patientRepository.createLocal(syntheticPatient);
    const document = await documentRepository.saveLocal({
      patientId: patient.id,
      file: makeFile(),
    });

    const outcome = await syncNow(testUser.id);
    expect(outcome.documentsUploaded).toBe(1);
    expect(server.uploads).toEqual([document.id]);

    const stored = await documentRepository.getLocal(document.id);
    expect(stored?.uploadStatus).toBe("uploaded");
    // The original bytes are still on the device after the upload.
    const blob = await documentRepository.openLocal(document.id);
    expect(await blob!.text()).toContain("synthetic test document");
  });
});

/**
 * Seeds a wrapped clinic key on this device and unlocks it, the way a device
 * that already holds the clinic key looks after sign-in.
 */
async function unlockSeededClinicKey(): Promise<void> {
  const passphrase = "sync-engine-test-passphrase";
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  const kek = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 310_000, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  const wrapped = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, kek, raw);
  await db.clinicKeys.put({
    id: "current",
    clinicId: "clinic-1",
    keyEpoch: 1,
    wrappedKey: btoa(String.fromCharCode(...new Uint8Array(wrapped))),
    wrapIv: btoa(String.fromCharCode(...iv)),
    kdfSalt: btoa(String.fromCharCode(...salt)),
    kdfIterations: 310_000,
    cachedAt: new Date().toISOString(),
  });
  const unlocked = await unlockClinicKey(passphrase, {
    online: false,
    clinicId: "clinic-1",
    userId: testUser.id,
  });
  expect(unlocked.available).toBe(true);
}

describe("dual-write sealing for clinical entities", () => {
  it("sends a clinic-key envelope alongside clinical free-text when the key is loaded", async () => {
    await unlockSeededClinicKey();
    const patient = await patientRepository.createLocal(syntheticPatient);
    const consultation = await consultationRepository.createLocal({
      patientId: patient.id,
      reason: "Persistent cough",
    });
    await clinicalNoteRepository.createLocal({
      patientId: patient.id,
      consultationId: consultation.id,
      body: "Confidential note body",
    });

    const outcome = await syncNow(testUser.id);
    expect(outcome.failed).toBe(0);

    const note = server.receivedOperations.find(
      (operation) => operation.entity_type === "clinicalNote",
    );
    // The sealed copy rides along...
    expect(note?.sealed_content).toMatchObject({ key_epoch: 1 });
    expect(note?.sealed_content?.ciphertext).toBeTruthy();
    // ...while dual-write keeps the plaintext flowing too: dropping either
    // half would break the rollback path or the current readers.
    expect(note?.payload.body).toBe("Confidential note body");
    const sentConsultation = server.receivedOperations.find(
      (operation) => operation.entity_type === "consultation",
    );
    expect(sentConsultation?.sealed_content).toBeDefined();
    const sentPatient = server.receivedOperations.find(
      (operation) => operation.entity_type === "patient",
    );
    expect(sentPatient?.sealed_content).toBeDefined();
  });

  it("still synchronizes without a sealed copy when no clinic key is loaded", async () => {
    await forgetClinicKey();
    const patient = await patientRepository.createLocal(syntheticPatient);
    const consultation = await consultationRepository.createLocal({
      patientId: patient.id,
      reason: "Persistent cough",
    });
    await clinicalNoteRepository.createLocal({
      patientId: patient.id,
      consultationId: consultation.id,
      body: "Plaintext-only note",
    });

    const outcome = await syncNow(testUser.id);
    expect(outcome.failed).toBe(0);

    for (const entityType of ["patient", "consultation", "clinicalNote"]) {
      const sent = server.receivedOperations.find(
        (operation) => operation.entity_type === entityType,
      );
      expect(sent?.sealed_content).toBeUndefined();
    }
  });

  it("backfills keyed search terms for a patient created before the key arrived", async () => {
    // The patient is created while the device holds no clinic key, the way a
    // non-admin device (or a pre-key record) has no index rows on the server.
    await patientRepository.createLocal({
      ...syntheticPatient,
      fullName: "Prekey Backfill Patient",
    });
    await syncNow(testUser.id);
    expect(
      server.receivedOperations.find(
        (operation) =>
          operation.entity_type === "patient" &&
          operation.operation_type === "create",
      )?.search_terms,
    ).toBeFalsy();

    // The key arrives; the backfill queues one content-identical update.
    await unlockSeededClinicKey();
    expect(await patientRepository.enqueueSearchTermBackfill()).toBe(1);
    const outcome = await syncNow(testUser.id);
    expect(outcome.failed).toBe(0);

    const backfill = server.receivedOperations.find(
      (operation) =>
        operation.entity_type === "patient" &&
        operation.operation_type === "update",
    );
    expect(backfill).toBeDefined();
    // The full keyed term set rides along with the sealed copy, so server
    // search can now match this record without the plaintext query.
    expect(backfill?.search_terms?.length).toBeGreaterThan(0);
    expect(backfill?.sealed_content).toMatchObject({ key_epoch: 1 });
    expect(backfill?.payload.full_name).toBe("Prekey Backfill Patient");

    // Running it again is a no-op: one backfill per account, ever.
    expect(await patientRepository.enqueueSearchTermBackfill()).toBe(0);
  });
});
