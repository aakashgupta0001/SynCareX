import { db } from "../database/db";
import type { LocalAISummary } from "../database/types";
import { decryptLocalValue, requireUnlockedIdentity } from "../security/localVault";
import { planWrite, commitWrite } from "./localStore";
import { auditRepository } from "./auditRepository";

/**
 * Server-side home for clinician-reviewed AI summaries.
 *
 * This is deliberately the *only* AI artifact with a sync pipeline: the raw
 * audio stays on the device (bandwidth and privacy), and transcripts, OCR
 * text and extractions enter the clinical record through the reviewed case
 * file instead. The summary itself is clinical content a colleague may need,
 * so it synchronizes like any hand-entered record.
 */
export const aiSummaryRepository = {
  async createLocal(input: {
    patientId: string;
    text: string;
    sourceArtifactId?: string | null;
    sections?: Array<Record<string, unknown>> | null;
  }): Promise<LocalAISummary> {
    const identity = requireUnlockedIdentity("save AI summaries");
    const now = new Date().toISOString();
    const summary: LocalAISummary = {
      id: crypto.randomUUID(),
      patientId: input.patientId,
      authorId: identity.userId,
      text: input.text,
      sourceArtifactId: input.sourceArtifactId ?? null,
      sections: input.sections ?? null,
      clinicianEdited: true,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    const plan = await planWrite({
      entity: summary,
      entityType: "aiSummary",
      operationType: "create",
      baseVersion: 0,
      payload: {
        patient_id: summary.patientId,
        text: summary.text,
        source_artifact_id: summary.sourceArtifactId,
        sections: summary.sections ?? [],
      },
      meta: { patientId: input.patientId },
      identity,
    });
    await commitWrite(db.aiSummaries, plan);
    await auditRepository.record({
      action: "aiSummary.create.local",
      entityType: "aiSummary",
      entityId: summary.id,
      details: { patientId: input.patientId },
    });
    return summary;
  },

  async updateLocal(id: string, text: string): Promise<LocalAISummary> {
    const identity = requireUnlockedIdentity("edit AI summaries");
    const record = await db.aiSummaries.get(id);
    if (!record || record.ownerId !== identity.userId) {
      throw new Error("AI summary was not found on this device.");
    }
    const current = await decryptLocalValue<LocalAISummary>(record.encrypted);
    const summary: LocalAISummary = {
      ...current,
      text,
      clinicianEdited: true,
      version: current.version + 1,
      updatedAt: new Date().toISOString(),
    };
    const plan = await planWrite({
      entity: summary,
      entityType: "aiSummary",
      operationType: "update",
      baseVersion: current.version,
      baseSnapshot: current,
      payload: { text, expected_version: current.version },
      meta: { patientId: summary.patientId },
      identity,
    });
    plan.record.createdAt = current.createdAt;
    await commitWrite(db.aiSummaries, plan);
    await auditRepository.record({
      action: "aiSummary.update.local",
      entityType: "aiSummary",
      entityId: summary.id,
      details: { version: summary.version },
    });
    return summary;
  },

  async listByPatientLocal(patientId: string): Promise<LocalAISummary[]> {
    const identity = requireUnlockedIdentity("read AI summaries");
    const records = await db.aiSummaries
      .where("patientId")
      .equals(patientId)
      .toArray();
    const owned = records.filter((record) => record.ownerId === identity.userId);
    const summaries = await Promise.all(
      owned.map(async (record) => decryptLocalValue<LocalAISummary>(record.encrypted)),
    );
    return summaries.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  },
};
