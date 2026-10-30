import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../database/db";
import {
  BACKUP_FORMAT_VERSION,
  exportLocalBackup,
  importLocalBackup,
} from "../offline/backup";
import { patientRepository } from "../repositories/patientRepository";
import { resetWorkspace, setOnline, syntheticPatient, testPassword } from "./helpers";

/**
 * exportLocalBackup hands its blob to URL.createObjectURL for the download.
 * The stub captures the blob so the tests can read the exact payload a real
 * export produces, download included.
 */
let capturedBlob: Blob | null = null;

const backupTables = [
  "patients",
  "patientIdentifiers",
  "consultations",
  "clinicalNotes",
  "observations",
  "allergies",
  "medications",
  "documents",
  "syncOperations",
  "syncConflicts",
  "auditEvents",
] as const;

async function exportBackupJson(): Promise<Record<string, unknown>> {
  const result = await exportLocalBackup();
  expect(result.recordCount).toBeGreaterThan(0);
  if (!capturedBlob) throw new Error("The export did not produce a download blob");
  return JSON.parse(await capturedBlob.text()) as Record<string, unknown>;
}

async function clearBackupTables(): Promise<void> {
  await Promise.all(backupTables.map((name) => db.table(name).clear()));
}

async function tableCounts(): Promise<Record<string, number>> {
  const entries = await Promise.all(
    backupTables.map(async (name) => [name, await db.table(name).count()] as const),
  );
  return Object.fromEntries(entries);
}

describe("encrypted backup restore", () => {
  beforeEach(async () => {
    capturedBlob = null;
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: (blob: Blob) => {
        capturedBlob = blob;
        return "blob:backup-test";
      },
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: () => {},
    });
    setOnline(false);
    await resetWorkspace();
  });

  it("round-trips an export into a wiped workspace", async () => {
    const first = await patientRepository.createLocal(syntheticPatient);
    const second = await patientRepository.createLocal({
      ...syntheticPatient,
      fullName: "Second Synthetic Patient",
      village: "Other Village",
    });
    const payload = await exportBackupJson();

    // Simulate the loss the restore exists for: every backed-up table is empty.
    await clearBackupTables();
    expect(await db.patients.count()).toBe(0);

    const summary = await importLocalBackup(payload, testPassword);
    expect(summary.imported).toBeGreaterThan(0);
    expect(summary.tables.patients).toEqual({ imported: 2, skipped: 0 });

    const restoredFirst = await patientRepository.getLocal(first.id);
    const restoredSecond = await patientRepository.getLocal(second.id);
    expect(restoredFirst?.fullName).toBe(syntheticPatient.fullName);
    expect(restoredFirst?.village).toBe(syntheticPatient.village);
    expect(restoredFirst?.version).toBe(1);
    expect(restoredFirst?.patientNumber).toBe(first.patientNumber);
    expect(restoredSecond?.fullName).toBe("Second Synthetic Patient");
    expect(restoredSecond?.village).toBe("Other Village");
  });

  it("keeps newer local edits and only restores what is missing or older", async () => {
    const kept = await patientRepository.createLocal(syntheticPatient);
    const lost = await patientRepository.createLocal({
      ...syntheticPatient,
      fullName: "Lost Synthetic Patient",
    });
    const payload = await exportBackupJson();

    // The local copy of one record moves ahead of the backup; the other is lost.
    const edited = await patientRepository.updateLocal(kept.id, { village: "Edited Village" });
    expect(edited.version).toBe(2);
    await db.patients.delete(lost.id);

    const summary = await importLocalBackup(payload, testPassword);

    // The older backup row for `kept` is skipped; `lost` comes back.
    expect(summary.tables.patients).toEqual({ imported: 1, skipped: 1 });
    expect(summary.imported).toBe(1);
    expect(summary.skipped).toBeGreaterThan(0);

    const afterMerge = await patientRepository.getLocal(kept.id);
    expect(afterMerge?.version).toBe(2);
    expect(afterMerge?.village).toBe("Edited Village");

    const restored = await patientRepository.getLocal(lost.id);
    expect(restored?.fullName).toBe("Lost Synthetic Patient");
    expect(restored?.version).toBe(1);
  });

  it("rejects a wrong passphrase without writing anything", async () => {
    const created = await patientRepository.createLocal(syntheticPatient);
    const payload = await exportBackupJson();
    const before = await tableCounts();

    await expect(
      importLocalBackup(payload, "not-the-vault-passphrase"),
    ).rejects.toThrow(/passphrase/i);

    expect(await tableCounts()).toEqual(before);
    const unchanged = await patientRepository.getLocal(created.id);
    expect(unchanged?.fullName).toBe(syntheticPatient.fullName);
  });

  it("rejects an unsupported backup version before any write", async () => {
    await patientRepository.createLocal(syntheticPatient);
    const payload = await exportBackupJson();
    const before = await tableCounts();

    const future = { ...payload, formatVersion: BACKUP_FORMAT_VERSION + 1 };
    await expect(importLocalBackup(future, testPassword)).rejects.toThrow(
      /format version/i,
    );
    expect(await tableCounts()).toEqual(before);
  });

  it("rejects a file that is not a SynCareX backup", async () => {
    await expect(importLocalBackup({ hello: "world" }, testPassword)).rejects.toThrow(
      /not a SynCareX/i,
    );
  });

  it("rejects a tampered envelope before any write", async () => {
    await patientRepository.createLocal(syntheticPatient);
    const payload = await exportBackupJson();
    const before = await tableCounts();

    const records = payload.records as {
      patients: Array<{ encrypted: { iv: string; ciphertext: string } }>;
    };
    const ciphertext = records.patients[0].encrypted.ciphertext;
    records.patients[0].encrypted.ciphertext =
      ciphertext.slice(0, -4) + (ciphertext.endsWith("AAAA") ? "BBBB" : "AAAA");

    await expect(importLocalBackup(payload, testPassword)).rejects.toThrow(
      /decrypted|damaged/i,
    );
    expect(await tableCounts()).toEqual(before);
  });
});
