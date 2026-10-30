import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../database/db";
import { aiSummaryRepository } from "../repositories/aiSummaryRepository";
import { syncRepository } from "../repositories/syncRepository";
import { resetWorkspace, testUser } from "./helpers";

describe("AI summary synchronization", () => {
  beforeEach(async () => {
    await resetWorkspace();
  });

  it("queues a reviewed summary for sync, with the patient attached", async () => {
    const summary = await aiSummaryRepository.createLocal({
      patientId: "patient-1",
      text: "Structured summary edited by the clinician.",
      sourceArtifactId: "artifact-1",
      sections: [
        {
          section: "presenting_complaint",
          points: [{ text: "Fever.", source_line_ids: ["transcript"] }],
        },
      ],
    });

    const operations = await syncRepository.list(testUser.id);
    const queued = operations.find((operation) => operation.entityId === summary.id);
    expect(queued).toBeDefined();
    expect(queued!.entityType).toBe("aiSummary");
    expect(queued!.operationType).toBe("create");
    expect(queued!.baseVersion).toBe(0);
    expect(queued!.localVersion).toBe(1);
  });

  it("bumps the version and queues an update when a summary is edited", async () => {
    const summary = await aiSummaryRepository.createLocal({
      patientId: "patient-1",
      text: "First draft.",
    });
    const edited = await aiSummaryRepository.updateLocal(summary.id, "Clinician edit.");

    expect(edited.version).toBe(2);
    const operations = await syncRepository.list(testUser.id);
    const update = operations.find(
      (operation) =>
        operation.entityId === summary.id && operation.operationType === "update",
    );
    expect(update).toBeDefined();
    expect(update!.baseVersion).toBe(1);
    expect(update!.localVersion).toBe(2);
  });

  it("applies an incoming server change into the encrypted store", async () => {
    const { syncPullRepository } = await import("../repositories/syncPullRepository");

    const summaryId = crypto.randomUUID();
    await syncPullRepository.applyPage(
      testUser.id,
      [
        {
          cursor: 1,
          operation_id: null,
          entity_type: "aiSummary",
          entity_id: summaryId,
          operation_type: "create",
          entity_version: 1,
          payload: {
            patient_id: "patient-9",
            text: "Summary from the clinician's other device.",
            sections: [],
            clinician_edited: true,
          },
          tombstone: false,
          created_at: new Date().toISOString(),
        },
      ],
      1,
    );

    const record = await db.aiSummaries.get(summaryId);
    expect(record).toBeDefined();
    expect(record!.patientId).toBe("patient-9");
    expect(record!.version).toBe(1);
  });
});
