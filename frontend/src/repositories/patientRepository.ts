import { db } from "../database/db";
import type { LocalPatient, LocalPatientIdentifier } from "../database/types";
import {
  commitWrite,
  getOwned,
  listOwnedByIndex,
  normalizeForSearch,
  ownedBy,
  paginate,
  planWrite,
  readRecords,
  type Page,
} from "./localStore";
import { auditRepository } from "./auditRepository";
import {
  buildIndexRows,
  candidateIds,
  ensureIndexBuilt,
  replaceIndexRows,
} from "../offline/searchIndex";
import {
  encryptLocalValue,
  requireUnlockedIdentity,
} from "../security/localVault";

export type PatientInput = Omit<
  LocalPatient,
  "id" | "patientNumber" | "version" | "createdAt" | "updatedAt" | "deviceId" | "archivedAt"
>;
export type PatientChanges = Partial<PatientInput>;

export interface PatientListOptions {
  page?: number;
  pageSize?: number;
  includeArchived?: boolean;
}

function patientNumberFor(id: string): string {
  return `SCX-${id.replaceAll("-", "").slice(0, 10).toUpperCase()}`;
}

function matches(patient: LocalPatient, query: string): boolean {
  return [
    patient.fullName,
    patient.patientNumber,
    patient.village,
    patient.contactPhone,
    patient.emergencyContactName,
  ].some((value) => normalizeForSearch(value ?? "").includes(query));
}

export const patientRepository = {
  /** Writes the patient and its queue operation locally. No network access. */
  async createLocal(input: PatientInput): Promise<LocalPatient> {
    const identity = requireUnlockedIdentity("save patient records");
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const patient: LocalPatient = {
      ...input,
      id,
      patientNumber: patientNumberFor(id),
      version: 1,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    };
    const plan = await planWrite({
      entity: patient,
      entityType: "patient",
      operationType: "create",
      baseVersion: 0,
      identity,
    });
    const indexRows = await buildIndexRows(plan.entity, identity.userId);
    const saved = await commitWrite(db.patients, plan, indexRows);
    await auditRepository.record({
      action: "patient.create.local",
      entityType: "patient",
      entityId: saved.id,
      details: { version: saved.version },
    });
    return saved;
  },

  async getLocal(id: string): Promise<LocalPatient | null> {
    return getOwned<LocalPatient>(db.patients, id, "read patient records");
  },

  async listLocal(options: PatientListOptions = {}): Promise<Page<LocalPatient>> {
    const identity = requireUnlockedIdentity("read patient records");
    const records = (await db.patients.where("ownerId").equals(identity.userId).toArray())
      .filter(ownedBy(identity));
    const patients = (await readRecords<LocalPatient>(records))
      .filter((patient) => options.includeArchived || !patient.archivedAt)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return paginate(patients, options.page ?? 1, options.pageSize ?? 20);
  },

  /** Convenience accessor for screens that need every local patient. */
  async listAllLocal(options: PatientListOptions = {}): Promise<LocalPatient[]> {
    return (await this.listLocal({ ...options, page: 1, pageSize: 100_000 })).items;
  },

  async searchLocal(
    query: string,
    options: PatientListOptions = {},
  ): Promise<Page<LocalPatient>> {
    const identity = requireUnlockedIdentity("search patient records");
    const normalized = normalizeForSearch(query);
    if (!normalized) {
      const all = await this.listAllLocal(options);
      return paginate(all, options.page ?? 1, options.pageSize ?? 20);
    }

    await ensureIndexBuilt(identity.userId, () =>
      this.listAllLocal({ includeArchived: true }),
    );

    // The index narrows the records worth decrypting. It never drops a record
    // that would have matched, so the exact test below decides the result and
    // the answer is the same as a full scan.
    const candidates = await candidateIds(identity.userId, normalized);
    const pool =
      candidates === null
        ? await this.listAllLocal(options)
        : await this.decryptByIds([...candidates], options);

    const filtered = pool.filter((patient) => matches(patient, normalized));
    return paginate(filtered, options.page ?? 1, options.pageSize ?? 20);
  },

  /** Decrypts only the given records, honouring the archived filter. */
  async decryptByIds(
    ids: string[],
    options: PatientListOptions = {},
  ): Promise<LocalPatient[]> {
    const identity = requireUnlockedIdentity("read patient records");
    if (!ids.length) return [];
    const records = (await db.patients.bulkGet(ids)).filter(
      (record): record is NonNullable<typeof record> =>
        Boolean(record) && record!.ownerId === identity.userId,
    );
    const patients = await readRecords<LocalPatient>(records);
    return patients
      .filter((patient) => options.includeArchived || !patient.archivedAt)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  },

  async updateLocal(id: string, changes: PatientChanges): Promise<LocalPatient> {
    const identity = requireUnlockedIdentity("edit patient records");
    const existing = await db.patients.get(id);
    if (!existing || existing.ownerId !== identity.userId) {
      throw new Error("Patient record was not found on this device.");
    }
    const current = await getOwned<LocalPatient>(db.patients, id, "edit patient records");
    if (!current) throw new Error("Patient record was not found on this device.");
    const patient: LocalPatient = {
      ...current,
      ...changes,
      dateOfBirth:
        changes.dateOfBirth !== undefined
          ? changes.dateOfBirth
          : changes.estimatedAge !== undefined
            ? null
            : current.dateOfBirth,
      estimatedAge:
        changes.estimatedAge !== undefined
          ? changes.estimatedAge
          : changes.dateOfBirth !== undefined
            ? null
            : current.estimatedAge,
      version: current.version + 1,
      updatedAt: new Date().toISOString(),
    };
    const plan = await planWrite({
      entity: patient,
      entityType: "patient",
      operationType: "update",
      baseVersion: current.version,
      baseSnapshot: current,
      payload: { ...changes, expected_version: current.version },
      meta: { archivedAt: patient.archivedAt ?? null },
      identity,
    });
    plan.record.createdAt = current.createdAt;
    // Searchable fields may have changed, so the record's index rows are
    // replaced wholesale rather than amended, in the same transaction.
    const indexRows = await buildIndexRows(plan.entity, identity.userId);
    const saved = await commitWrite(db.patients, plan, indexRows);
    await auditRepository.record({
      action: "patient.update.local",
      entityType: "patient",
      entityId: saved.id,
      details: { version: saved.version, fields: Object.keys(changes).join(",") },
    });
    return saved;
  },

  /**
   * Marks a record archived. Clinical records are never hard-deleted locally,
   * and an archive is queued like any other change.
   */
  async archiveLocal(id: string, reason = ""): Promise<LocalPatient> {
    const identity = requireUnlockedIdentity("archive patient records");
    const current = await getOwned<LocalPatient>(db.patients, id, "archive patient records");
    if (!current) throw new Error("Patient record was not found on this device.");
    const now = new Date().toISOString();
    const patient: LocalPatient = {
      ...current,
      archivedAt: now,
      version: current.version + 1,
      updatedAt: now,
    };
    const plan = await planWrite({
      entity: patient,
      entityType: "patient",
      operationType: "archive",
      baseVersion: current.version,
      payload: { archived: true, reason, expected_version: current.version },
      meta: { archivedAt: now },
      identity,
    });
    plan.record.createdAt = current.createdAt;
    const saved = await commitWrite(db.patients, plan);
    await auditRepository.record({
      action: "patient.archive.local",
      entityType: "patient",
      entityId: saved.id,
      details: { version: saved.version },
    });
    return saved;
  },

  /**
   * Caches a server copy. A record with unsynchronized local work is never
   * overwritten; the queue keeps the local version authoritative until the
   * operation is acknowledged or a conflict is reviewed.
   */
  async cacheServerPatient(patient: LocalPatient): Promise<boolean> {
    const identity = requireUnlockedIdentity("cache patient records");
    const existing = await db.patients.get(patient.id);
    if (existing?.ownerId === identity.userId) {
      const pending = await db.syncOperations
        .where("entityId")
        .equals(patient.id)
        .filter(
          (operation) =>
            operation.status !== "acknowledged" &&
            operation.status !== "superseded",
        )
        .count();
      if (pending > 0) return false;
    }
    const encrypted = await encryptLocalValue(patient);
    const indexRows = await buildIndexRows(patient, identity.userId);
    await db.transaction("rw", db.patients, db.searchIndex, async () => {
      await db.patients.put({
        id: patient.id,
        ownerId: identity.userId,
        encrypted,
        createdAt: patient.createdAt,
        updatedAt: patient.updatedAt,
        version: patient.version,
        archivedAt: patient.archivedAt ?? null,
      });
      await replaceIndexRows(patient.id, indexRows);
    });
    return true;
  },

  async countLocal(): Promise<number> {
    const identity = requireUnlockedIdentity("read patient records");
    return db.patients.where("ownerId").equals(identity.userId).count();
  },
};

export type IdentifierInput = Pick<LocalPatientIdentifier, "patientId" | "system" | "value">;

export const patientIdentifierRepository = {
  async createLocal(input: IdentifierInput): Promise<LocalPatientIdentifier> {
    const identity = requireUnlockedIdentity("save patient identifiers");
    const now = new Date().toISOString();
    const identifier: LocalPatientIdentifier = {
      ...input,
      id: crypto.randomUUID(),
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    const plan = await planWrite({
      entity: identifier,
      entityType: "patientIdentifier",
      operationType: "create",
      baseVersion: 0,
      meta: { patientId: input.patientId },
      identity,
    });
    const saved = await commitWrite(db.patientIdentifiers, plan);
    await auditRepository.record({
      action: "patientIdentifier.create.local",
      entityType: "patientIdentifier",
      entityId: saved.id,
      details: { system: saved.system },
    });
    return saved;
  },

  async listByPatientLocal(patientId: string): Promise<LocalPatientIdentifier[]> {
    return listOwnedByIndex<LocalPatientIdentifier>(
      db.patientIdentifiers,
      "patientId",
      patientId,
      "read patient identifiers",
    );
  },

  async getLocal(id: string): Promise<LocalPatientIdentifier | null> {
    return getOwned<LocalPatientIdentifier>(
      db.patientIdentifiers,
      id,
      "read patient identifiers",
    );
  },
};
