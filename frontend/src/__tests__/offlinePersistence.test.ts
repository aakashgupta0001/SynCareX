import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../database/db";
import { aiRepository } from "../repositories/aiRepository";
import {
  clinicalNoteRepository,
  consultationRepository,
} from "../repositories/consultationRepository";
import { documentRepository } from "../repositories/documentRepository";
import {
  patientIdentifierRepository,
  patientRepository,
} from "../repositories/patientRepository";
import { syncRepository } from "../repositories/syncRepository";
import {
  makeFile,
  restartBrowser,
  resetWorkspace,
  setOnline,
  syntheticPatient,
  testUser,
} from "./helpers";

describe("A. offline patient persistence", () => {
  beforeEach(async () => {
    setOnline(false);
    await resetWorkspace();
  });

  it("creates a patient with no network and keeps it across a browser restart", async () => {
    const created = await patientRepository.createLocal(syntheticPatient);
    expect(created.patientNumber).toMatch(/^SCX-/);
    expect(created.version).toBe(1);

    // Simulated refresh: the page is reloaded but the database is the same.
    await restartBrowser();
    const afterRefresh = await patientRepository.getLocal(created.id);
    expect(afterRefresh?.fullName).toBe(syntheticPatient.fullName);

    // Simulated close and reopen of the browser.
    await restartBrowser();
    const afterRestart = await patientRepository.getLocal(created.id);
    expect(afterRestart?.fullName).toBe(syntheticPatient.fullName);
    expect(afterRestart?.village).toBe("Demo Village");
  });

  it("stores clinical content encrypted rather than as readable rows", async () => {
    const created = await patientRepository.createLocal(syntheticPatient);
    const rows = JSON.stringify(await db.patients.toArray());
    expect(rows).not.toContain(syntheticPatient.fullName);
    expect(rows).toContain(created.id);

    const queued = JSON.stringify(await db.syncOperations.toArray());
    expect(queued).not.toContain(syntheticPatient.fullName);
  });

  it("searches, paginates and edits local records without a network", async () => {
    await patientRepository.createLocal(syntheticPatient);
    await patientRepository.createLocal({
      ...syntheticPatient,
      fullName: "Second Synthetic Patient",
      village: "Other Village",
    });
    await patientRepository.createLocal({
      ...syntheticPatient,
      fullName: "Third Synthetic Patient",
      village: "Other Village",
    });

    const matches = await patientRepository.searchLocal("other village");
    expect(matches.total).toBe(2);

    const firstPage = await patientRepository.listLocal({ page: 1, pageSize: 2 });
    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.pages).toBe(2);
    expect(firstPage.total).toBe(3);

    const target = matches.items[0];
    const edited = await patientRepository.updateLocal(target.id, {
      village: "Edited Village",
    });
    expect(edited.version).toBe(2);

    await restartBrowser();
    const reloaded = await patientRepository.getLocal(target.id);
    expect(reloaded?.village).toBe("Edited Village");
    expect(reloaded?.version).toBe(2);
  });

  it("archives instead of deleting, and keeps the archived record on the device", async () => {
    const created = await patientRepository.createLocal(syntheticPatient);
    await patientRepository.archiveLocal(created.id, "duplicate record");

    const visible = await patientRepository.listLocal();
    expect(visible.total).toBe(0);

    const includingArchived = await patientRepository.listLocal({
      includeArchived: true,
    });
    expect(includingArchived.total).toBe(1);
    expect(includingArchived.items[0].archivedAt).toBeTruthy();
  });
});

describe("B. offline consultation, notes and documents", () => {
  beforeEach(async () => {
    setOnline(false);
    await resetWorkspace();
  });

  it("keeps a consultation, its note and its document after a restart", async () => {
    const patient = await patientRepository.createLocal(syntheticPatient);
    await patientIdentifierRepository.createLocal({
      patientId: patient.id,
      system: "clinic card",
      value: "CARD-0001",
    });
    const consultation = await consultationRepository.createLocal({
      patientId: patient.id,
      reason: "Fever review",
      notes: "Initial draft",
    });
    const note = await clinicalNoteRepository.createLocal({
      consultationId: consultation.id,
      patientId: patient.id,
      body: "Documented history and examination findings.",
      noteType: "subjective",
    });
    const document = await documentRepository.saveLocal({
      patientId: patient.id,
      consultationId: consultation.id,
      file: makeFile(),
      description: "Synthetic referral letter",
    });

    await consultationRepository.updateLocal(consultation.id, {
      notes: "Edited after examination",
    });

    await restartBrowser();

    const reloadedConsultation = await consultationRepository.getLocal(consultation.id);
    expect(reloadedConsultation?.notes).toBe("Edited after examination");
    expect(reloadedConsultation?.version).toBe(2);

    const notes = await clinicalNoteRepository.listByConsultationLocal(consultation.id);
    expect(notes).toHaveLength(1);
    expect(notes[0].body).toContain("Documented history");
    expect(notes[0].id).toBe(note.id);

    const identifiers = await patientIdentifierRepository.listByPatientLocal(patient.id);
    expect(identifiers[0].value).toBe("CARD-0001");

    const documents = await documentRepository.listByPatientLocal(patient.id);
    expect(documents).toHaveLength(1);
    expect(documents[0].id).toBe(document.id);

    // The file bytes themselves survive and still pass their integrity check.
    const blob = await documentRepository.openLocal(document.id);
    expect(blob).not.toBeNull();
    expect(await blob!.text()).toContain("synthetic test document");
  });

  it("validates document size and format before storing anything", async () => {
    const patient = await patientRepository.createLocal(syntheticPatient);
    await expect(
      documentRepository.saveLocal({
        patientId: patient.id,
        file: makeFile("notes.txt", "text/plain", "plain text"),
      }),
    ).rejects.toThrow(/Supported formats/);

    const oversized = new File(
      [new Uint8Array(11 * 1024 * 1024)],
      "large.png",
      { type: "image/png" },
    );
    await expect(
      documentRepository.saveLocal({ patientId: patient.id, file: oversized }),
    ).rejects.toThrow(/or smaller/);

    expect(await documentRepository.countLocal()).toBe(0);
  });
});

describe("C. queue durability", () => {
  beforeEach(async () => {
    setOnline(false);
    await resetWorkspace();
  });

  it("keeps every queued operation after the application restarts", async () => {
    const patient = await patientRepository.createLocal(syntheticPatient);
    await patientRepository.updateLocal(patient.id, { village: "Updated Village" });
    const consultation = await consultationRepository.createLocal({
      patientId: patient.id,
      notes: "Draft",
    });
    await clinicalNoteRepository.createLocal({
      consultationId: consultation.id,
      patientId: patient.id,
      body: "A note.",
    });
    await documentRepository.saveLocal({
      patientId: patient.id,
      file: makeFile(),
    });

    const before = await syncRepository.getPending(testUser.id);
    expect(before).toHaveLength(5);
    expect(before.every((operation) => operation.status === "pending")).toBe(true);

    await restartBrowser();

    const after = await syncRepository.getPending(testUser.id);
    expect(after).toHaveLength(5);
    expect(after.map((operation) => operation.entityType).sort()).toEqual([
      "clinicalNote",
      "consultation",
      "document",
      "patient",
      "patient",
    ]);
    expect(
      after.every((operation) => operation.idempotencyKey.length === 64),
    ).toBe(true);
  });

  it("refuses to queue the same logical operation twice", async () => {
    const patient = await patientRepository.createLocal(syntheticPatient);
    const operations = await syncRepository.listForEntity(patient.id);
    expect(operations).toHaveLength(1);

    // Re-enqueueing an identical change must not create a second operation.
    const duplicate = await syncRepository.enqueue({
      ownerId: testUser.id,
      entityType: "patient",
      entityId: patient.id,
      operationType: "create",
      payload: operations[0].payload,
      baseVersion: 0,
      localVersion: 1,
      deviceId: operations[0].deviceId,
      actorId: testUser.id,
    });

    expect(duplicate.operationId).toBe(operations[0].operationId);
    expect(await syncRepository.listForEntity(patient.id)).toHaveLength(1);
  });

  it("derives record state from the queue and never reports an unsent record as synced", async () => {
    const patient = await patientRepository.createLocal(syntheticPatient);
    expect(await syncRepository.entityState(patient.id)).toBe("waiting_to_sync");

    const [operation] = await syncRepository.listForEntity(patient.id);
    await syncRepository.markFailed(operation.operationId, "Server unavailable");
    expect(await syncRepository.entityState(patient.id)).toBe("sync_failed");

    await syncRepository.markAcknowledged(operation.operationId);
    expect(await syncRepository.entityState(patient.id)).toBe("synced");
  });
});

describe("D. offline AI artifact persistence", () => {
  beforeEach(async () => {
    setOnline(false);
    await resetWorkspace();
  });

  it("encrypts audio and AI output locally and keeps both across a browser restart", async () => {
    const sourceFile = new File(["synthetic audio bytes"], "synthetic-visit.wav", {
      type: "audio/wav",
    });
    const source = await aiRepository.saveSource("audio_source", sourceFile);
    const transcript = await aiRepository.saveArtifact("transcript", {
      text: "Synthetic source-grounded transcript.",
      language: "en",
      source_id: source.id,
    });

    expect(JSON.stringify(await db.aiArtifacts.toArray())).not.toContain(
      "Synthetic source-grounded transcript.",
    );
    expect(JSON.stringify(await db.aiArtifacts.toArray())).not.toContain(
      "synthetic-visit.wav",
    );
    expect(await db.aiBlobs.count()).toBe(1);

    await restartBrowser();
    const reopenedSource = await aiRepository.openSource(source.id);
    expect(reopenedSource?.fileName).toBe("synthetic-visit.wav");
    expect(await reopenedSource?.blob.text()).toBe("synthetic audio bytes");
    expect((await aiRepository.getLocal(transcript.id))?.payload.text).toBe(
      "Synthetic source-grounded transcript.",
    );
  });
});
