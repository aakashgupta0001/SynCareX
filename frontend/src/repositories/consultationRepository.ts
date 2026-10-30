import { db } from "../database/db";
import type {
  LocalAllergy,
  LocalClinicalNote,
  LocalConsultation,
  LocalMedication,
  LocalObservation,
} from "../database/types";
import {
  commitWrite,
  getOwned,
  listOwnedByIndex,
  ownedBy,
  paginate,
  planWrite,
  readRecords,
  type Page,
} from "./localStore";
import { auditRepository } from "./auditRepository";
import { requireUnlockedIdentity } from "../security/localVault";

export interface ConsultationInput {
  patientId: string;
  reason?: string;
  notes?: string;
  occurredAt?: string;
}

export const consultationRepository = {
  async createLocal(input: ConsultationInput): Promise<LocalConsultation> {
    const identity = requireUnlockedIdentity("create a consultation");
    if (!input.patientId) throw new Error("Select a patient for this consultation.");
    const now = new Date().toISOString();
    const consultation: LocalConsultation = {
      id: crypto.randomUUID(),
      patientId: input.patientId,
      occurredAt: input.occurredAt ?? now,
      reason: input.reason ?? "",
      notes: input.notes ?? "",
      status: "draft",
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    const plan = await planWrite({
      entity: consultation,
      entityType: "consultation",
      operationType: "create",
      baseVersion: 0,
      meta: { patientId: input.patientId },
      identity,
    });
    const saved = await commitWrite(db.consultations, plan);
    await auditRepository.record({
      action: "consultation.create.local",
      entityType: "consultation",
      entityId: saved.id,
      details: { patientId: saved.patientId },
    });
    return saved;
  },

  async getLocal(id: string): Promise<LocalConsultation | null> {
    return getOwned<LocalConsultation>(db.consultations, id, "read consultations");
  },

  async listByPatientLocal(patientId: string): Promise<LocalConsultation[]> {
    return listOwnedByIndex<LocalConsultation>(
      db.consultations,
      "patientId",
      patientId,
      "read consultations",
    );
  },

  async listLocal(page = 1, pageSize = 20): Promise<Page<LocalConsultation>> {
    const identity = requireUnlockedIdentity("read consultations");
    const records = (
      await db.consultations.where("ownerId").equals(identity.userId).toArray()
    ).filter(ownedBy(identity));
    const consultations = (await readRecords<LocalConsultation>(records)).sort(
      (left, right) => right.occurredAt.localeCompare(left.occurredAt),
    );
    return paginate(consultations, page, pageSize);
  },

  async updateLocal(
    id: string,
    changes: Partial<Pick<LocalConsultation, "notes" | "reason" | "status" | "occurredAt">>,
  ): Promise<LocalConsultation> {
    const identity = requireUnlockedIdentity("edit consultations");
    const current = await getOwned<LocalConsultation>(
      db.consultations,
      id,
      "edit consultations",
    );
    if (!current) throw new Error("Consultation was not found on this device.");
    const updated: LocalConsultation = {
      ...current,
      ...changes,
      version: current.version + 1,
      updatedAt: new Date().toISOString(),
    };
    const plan = await planWrite({
      entity: updated,
      entityType: "consultation",
      operationType: "update",
      baseVersion: current.version,
      baseSnapshot: current,
      payload: { ...changes, expected_version: current.version },
      meta: { patientId: updated.patientId },
      identity,
    });
    plan.record.createdAt = current.createdAt;
    const saved = await commitWrite(db.consultations, plan);
    await auditRepository.record({
      action: "consultation.update.local",
      entityType: "consultation",
      entityId: saved.id,
      details: { version: saved.version },
    });
    return saved;
  },
};

export interface ClinicalNoteInput {
  consultationId: string;
  patientId: string;
  body: string;
  noteType?: LocalClinicalNote["noteType"];
}

export const clinicalNoteRepository = {
  async createLocal(input: ClinicalNoteInput): Promise<LocalClinicalNote> {
    const identity = requireUnlockedIdentity("save clinical notes");
    const now = new Date().toISOString();
    const note: LocalClinicalNote = {
      id: crypto.randomUUID(),
      consultationId: input.consultationId,
      patientId: input.patientId,
      authorId: identity.userId,
      body: input.body,
      noteType: input.noteType ?? "general",
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    const plan = await planWrite({
      entity: note,
      entityType: "clinicalNote",
      operationType: "create",
      baseVersion: 0,
      meta: { patientId: input.patientId, consultationId: input.consultationId },
      identity,
    });
    const saved = await commitWrite(db.clinicalNotes, plan);
    await auditRepository.record({
      action: "clinicalNote.create.local",
      entityType: "clinicalNote",
      entityId: saved.id,
      details: { consultationId: saved.consultationId },
    });
    return saved;
  },

  async updateLocal(id: string, body: string): Promise<LocalClinicalNote> {
    const identity = requireUnlockedIdentity("edit clinical notes");
    const current = await getOwned<LocalClinicalNote>(
      db.clinicalNotes,
      id,
      "edit clinical notes",
    );
    if (!current) throw new Error("Clinical note was not found on this device.");
    const note: LocalClinicalNote = {
      ...current,
      body,
      version: current.version + 1,
      updatedAt: new Date().toISOString(),
    };
    const plan = await planWrite({
      entity: note,
      entityType: "clinicalNote",
      operationType: "update",
      baseVersion: current.version,
      baseSnapshot: current,
      payload: { body, expected_version: current.version },
      meta: { patientId: note.patientId, consultationId: note.consultationId },
      identity,
    });
    plan.record.createdAt = current.createdAt;
    const saved = await commitWrite(db.clinicalNotes, plan);
    await auditRepository.record({
      action: "clinicalNote.update.local",
      entityType: "clinicalNote",
      entityId: saved.id,
      details: { version: saved.version },
    });
    return saved;
  },

  async getLocal(id: string): Promise<LocalClinicalNote | null> {
    return getOwned<LocalClinicalNote>(db.clinicalNotes, id, "read clinical notes");
  },

  async listByConsultationLocal(consultationId: string): Promise<LocalClinicalNote[]> {
    const notes = await listOwnedByIndex<LocalClinicalNote>(
      db.clinicalNotes,
      "consultationId",
      consultationId,
      "read clinical notes",
    );
    return notes.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  },

  async listByPatientLocal(patientId: string): Promise<LocalClinicalNote[]> {
    return listOwnedByIndex<LocalClinicalNote>(
      db.clinicalNotes,
      "patientId",
      patientId,
      "read clinical notes",
    );
  },
};

export interface ObservationInput {
  patientId: string;
  consultationId?: string | null;
  code: string;
  label: string;
  value: string;
  unit?: string;
  recordedAt?: string;
}

export const observationRepository = {
  async createLocal(input: ObservationInput): Promise<LocalObservation> {
    const identity = requireUnlockedIdentity("save observations");
    const now = new Date().toISOString();
    const observation: LocalObservation = {
      id: crypto.randomUUID(),
      patientId: input.patientId,
      consultationId: input.consultationId ?? null,
      code: input.code,
      label: input.label,
      value: input.value,
      unit: input.unit ?? "",
      recordedAt: input.recordedAt ?? now,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    const plan = await planWrite({
      entity: observation,
      entityType: "observation",
      operationType: "create",
      baseVersion: 0,
      meta: {
        patientId: input.patientId,
        consultationId: input.consultationId ?? undefined,
      },
      identity,
    });
    const saved = await commitWrite(db.observations, plan);
    await auditRepository.record({
      action: "observation.create.local",
      entityType: "observation",
      entityId: saved.id,
      details: { code: saved.code },
    });
    return saved;
  },

  async listByPatientLocal(patientId: string): Promise<LocalObservation[]> {
    return listOwnedByIndex<LocalObservation>(
      db.observations,
      "patientId",
      patientId,
      "read observations",
    );
  },
};

export interface AllergyInput {
  patientId: string;
  substance: string;
  reaction?: string;
  severity?: LocalAllergy["severity"];
}

export const allergyRepository = {
  async createLocal(input: AllergyInput): Promise<LocalAllergy> {
    const identity = requireUnlockedIdentity("save allergies");
    const now = new Date().toISOString();
    const allergy: LocalAllergy = {
      id: crypto.randomUUID(),
      patientId: input.patientId,
      substance: input.substance,
      reaction: input.reaction ?? "",
      severity: input.severity ?? "unknown",
      recordedAt: now,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    const plan = await planWrite({
      entity: allergy,
      entityType: "allergy",
      operationType: "create",
      baseVersion: 0,
      meta: { patientId: input.patientId },
      identity,
    });
    const saved = await commitWrite(db.allergies, plan);
    await auditRepository.record({
      action: "allergy.create.local",
      entityType: "allergy",
      entityId: saved.id,
    });
    return saved;
  },

  async listByPatientLocal(patientId: string): Promise<LocalAllergy[]> {
    return listOwnedByIndex<LocalAllergy>(
      db.allergies,
      "patientId",
      patientId,
      "read allergies",
    );
  },
};

export interface MedicationInput {
  patientId: string;
  consultationId?: string | null;
  name: string;
  dose?: string;
  frequency?: string;
  startedAt?: string | null;
}

export const medicationRepository = {
  /**
   * Records a medication a clinician has documented. SynCareX does not
   * suggest, generate or alter prescriptions.
   */
  async createLocal(input: MedicationInput): Promise<LocalMedication> {
    const identity = requireUnlockedIdentity("save medications");
    const now = new Date().toISOString();
    const medication: LocalMedication = {
      id: crypto.randomUUID(),
      patientId: input.patientId,
      consultationId: input.consultationId ?? null,
      name: input.name,
      dose: input.dose ?? "",
      frequency: input.frequency ?? "",
      startedAt: input.startedAt ?? null,
      stoppedAt: null,
      recordedBy: identity.userId,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    const plan = await planWrite({
      entity: medication,
      entityType: "medication",
      operationType: "create",
      baseVersion: 0,
      meta: {
        patientId: input.patientId,
        consultationId: input.consultationId ?? undefined,
      },
      identity,
    });
    const saved = await commitWrite(db.medications, plan);
    await auditRepository.record({
      action: "medication.create.local",
      entityType: "medication",
      entityId: saved.id,
    });
    return saved;
  },

  async listByPatientLocal(patientId: string): Promise<LocalMedication[]> {
    return listOwnedByIndex<LocalMedication>(
      db.medications,
      "patientId",
      patientId,
      "read medications",
    );
  },
};
