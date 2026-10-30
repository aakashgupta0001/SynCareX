import { db } from "../database/db";
import { requireUnlockedIdentity } from "../security/localVault";
import { getLocalDeviceId } from "../offline/device";

export interface BackupResult {
  fileName: string;
  recordCount: number;
  byteSize: number;
}

/**
 * Exports every local clinical record as the encrypted envelopes they are
 * stored as. The export is readable only with this vault's passphrase, so it
 * can be copied to another medium without exposing patient information.
 *
 * Document bytes are deliberately excluded: they would make the export large
 * enough to be impractical in a browser, and they remain on the device.
 */
export async function exportLocalBackup(): Promise<BackupResult> {
  const identity = requireUnlockedIdentity("export a backup");
  const deviceId = await getLocalDeviceId();
  const mine = <T extends { ownerId: string }>(rows: T[]) =>
    rows.filter((row) => row.ownerId === identity.userId);

  const [
    patients,
    patientIdentifiers,
    consultations,
    clinicalNotes,
    observations,
    allergies,
    medications,
    documents,
    syncOperations,
    syncConflicts,
    auditEvents,
  ] = await Promise.all([
    db.patients.toArray().then(mine),
    db.patientIdentifiers.toArray().then(mine),
    db.consultations.toArray().then(mine),
    db.clinicalNotes.toArray().then(mine),
    db.observations.toArray().then(mine),
    db.allergies.toArray().then(mine),
    db.medications.toArray().then(mine),
    db.documents.toArray().then(mine),
    db.syncOperations.toArray().then(mine),
    db.syncConflicts.toArray().then(mine),
    db.auditEvents.toArray().then(mine),
  ]);

  const payload = {
    format: "syncarex-encrypted-backup",
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    deviceId,
    ownerId: identity.userId,
    note:
      "Every record below is an AES-GCM envelope. Restoring requires the same vault passphrase. Document file bytes are not included.",
    records: {
      patients,
      patientIdentifiers,
      consultations,
      clinicalNotes,
      observations,
      allergies,
      medications,
      documents,
      syncOperations,
      syncConflicts,
      auditEvents,
    },
  };

  const recordCount = Object.values(payload.records).reduce(
    (total, rows) => total + rows.length,
    0,
  );
  const json = JSON.stringify(payload, null, 2);
  const fileName = `syncarex-backup-${new Date().toISOString().slice(0, 10)}.json`;
  const blob = new Blob([json], { type: "application/json" });

  if (typeof document !== "undefined") {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return { fileName, recordCount, byteSize: blob.size };
}
