/**
 * SynCareX Secure Clinic-to-Clinic Transfer Repository.
 *
 * Implements:
 * 1. Export package preparation with checksums and manifest.
 * 2. Identity collision detection before patient record merge or creation.
 * 3. Preservation of source clinic and clinician provenance.
 * 4. LAN / file package import & export.
 * 5. Clinic pairing management.
 */

import { db } from "../database/db";
import type {
  ClinicTransferRecord,
  PairedClinicRecord,
} from "../database/types";
import {
  decryptLocalValue,
  encryptLocalValue,
  requireUnlockedIdentity,
} from "../security/localVault";
import { patientRepository } from "./patientRepository";

export interface TransferPackagePayload {
  schemaVersion: "syncarex-continuity-v1";
  sourceProvenance: {
    sourceClinicId: string;
    sourceClinicName: string;
    exportedById: string;
    exportedByName: string;
    exportedAt: string;
    consentPurpose: string;
    verificationBadge: "imported";
  };
  patient: {
    id: string;
    patientNumber: string;
    fullName: string;
    dateOfBirth?: string | null;
    estimatedAge?: number | null;
    gender?: string | null;
    contactPhone?: string | null;
    address?: string | null;
    village?: string | null;
    relevantHistory?: string | null;
    allergies?: string[];
  };
  allergies?: Array<{ substance: string; reaction?: string; severity?: string }>;
  medications?: Array<{ name: string; dose?: string; frequency?: string }>;
  consultations?: Array<{ reason?: string; notes?: string; occurredAt?: string }>;
}

async function sha256Hex(data: string): Promise<string> {
  const bytes = new TextEncoder().encode(data);
  const hashBuffer = await crypto.subtle.digest("SHA-256", bytes);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const transferRepository = {
  /**
   * Prepares an export transfer package for a patient.
   */
  async prepareExportPackage(options: {
    patientId: string;
    targetClinicId: string;
    targetClinicName?: string;
    consentPurpose: string;
    includedRecords?: string[];
  }): Promise<{ record: ClinicTransferRecord; packageJson: string }> {
    const identity = requireUnlockedIdentity();
    const patient = await patientRepository.getLocal(options.patientId);
    if (!patient) throw new Error("Patient not found in local vault");

    const now = new Date().toISOString();
    const transferId = `trf-${crypto.randomUUID().slice(0, 16)}`;

    const inc = new Set(options.includedRecords || ["patient", "allergies", "medications", "consultations"]);

    const payload: TransferPackagePayload = {
      schemaVersion: "syncarex-continuity-v1",
      sourceProvenance: {
        sourceClinicId: identity.userId,
        sourceClinicName: "SynCareX Local Clinic",
        exportedById: identity.userId,
        exportedByName: identity.fullName,
        exportedAt: now,
        consentPurpose: options.consentPurpose,
        verificationBadge: "imported",
      },
      patient: {
        id: patient.id,
        patientNumber: patient.patientNumber,
        fullName: patient.fullName,
        dateOfBirth: patient.dateOfBirth,
        estimatedAge: patient.estimatedAge,
        gender: patient.gender,
        contactPhone: patient.contactPhone,
        address: patient.address,
        village: patient.village,
        relevantHistory: patient.relevantHistory,
        allergies: patient.allergies,
      },
    };

    if (inc.has("allergies")) {
      const allergyRows = await db.allergies.where("patientId").equals(patient.id).toArray();
      payload.allergies = await Promise.all(
        allergyRows.map((r) => decryptLocalValue<{ substance: string; reaction?: string; severity?: string }>(r.encrypted)),
      );
    }

    if (inc.has("medications")) {
      const medRows = await db.medications.where("patientId").equals(patient.id).toArray();
      payload.medications = await Promise.all(
        medRows.map((r) => decryptLocalValue<{ name: string; dose?: string; frequency?: string }>(r.encrypted)),
      );
    }

    if (inc.has("consultations")) {
      const consultRows = await db.consultations.where("patientId").equals(patient.id).toArray();
      payload.consultations = await Promise.all(
        consultRows.map((r) => decryptLocalValue<{ reason?: string; notes?: string; occurredAt?: string }>(r.encrypted)),
      );
    }

    const canonical = JSON.stringify(payload);
    const checksum = await sha256Hex(canonical);
    const byteSize = new TextEncoder().encode(canonical).length;

    const record: ClinicTransferRecord = {
      id: crypto.randomUUID(),
      ownerId: identity.userId,
      transferId,
      sourceClinicId: identity.userId,
      sourceClinicName: "SynCareX Local Clinic",
      targetClinicId: options.targetClinicId,
      targetClinicName: options.targetClinicName || "Target Clinic",
      patientId: patient.id,
      patientName: patient.fullName,
      status: "prepared",
      checksum,
      byteSize,
      manifest: { records: Array.from(inc) },
      consentPurpose: options.consentPurpose,
      encryptedPayload: canonical,
      sourceProvenance: payload.sourceProvenance,
      createdAt: now,
    };

    await db.transfers.put(record);
    return { record, packageJson: canonical };
  },

  /**
   * Imports a transfer package. Detects identity collisions with local records.
   */
  async importPackage(
    packageJson: string,
    options?: { forceNewPatient?: boolean; mergePatientId?: string },
  ): Promise<{
    status: "imported" | "collision_detected";
    importedPatientId?: string;
    collisionCandidate?: { id: string; fullName: string; patientNumber: string };
    message: string;
  }> {
    const identity = requireUnlockedIdentity();
    let data: TransferPackagePayload;
    try {
      data = JSON.parse(packageJson);
    } catch {
      throw new Error("Invalid transfer package JSON");
    }

    if (data.schemaVersion !== "syncarex-continuity-v1") {
      throw new Error(`Unsupported transfer schema version: ${data.schemaVersion}`);
    }

    const incoming = data.patient;
    if (!incoming || !incoming.fullName) {
      throw new Error("Transfer package missing patient details");
    }

    // Identity collision check against local patients
    if (!options?.forceNewPatient && !options?.mergePatientId) {
      const localPatients = await patientRepository.listAllLocal();
      const collision = localPatients.find(
        (p) =>
          p.fullName.toLowerCase() === incoming.fullName.toLowerCase() &&
          ((p.dateOfBirth && p.dateOfBirth === incoming.dateOfBirth) ||
            (p.contactPhone && p.contactPhone === incoming.contactPhone)),
      );

      if (collision) {
        return {
          status: "collision_detected",
          collisionCandidate: {
            id: collision.id,
            fullName: collision.fullName,
            patientNumber: collision.patientNumber,
          },
          message: `Potential patient match detected with existing local patient ${collision.fullName} (${collision.patientNumber}). Choose to merge or create new.`,
        };
      }
    }

    let targetPatientId = options?.mergePatientId;

    if (!targetPatientId) {
      // Create imported patient in local vault
      const newPatient = await patientRepository.createLocal({
        fullName: incoming.fullName,
        dateOfBirth: incoming.dateOfBirth ?? null,
        estimatedAge: incoming.estimatedAge ?? null,
        gender: incoming.gender ?? "",
        contactPhone: incoming.contactPhone ?? "",
        address: incoming.address ?? "",
        village: incoming.village ?? "",
        // The transfer package format carries no emergency contact,
        // so it is left blank rather than guessed.
        emergencyContactName: "",
        emergencyContactPhone: "",
        relevantHistory: `[Imported from ${data.sourceProvenance.sourceClinicName}] ${incoming.relevantHistory || ""}`.trim(),
        allergies: incoming.allergies || [],
      });
      targetPatientId = newPatient.id;
    }
    // Narrowed for the rest of the import: either the caller chose a merge
    // target or one was just created above.
    const patientId: string = targetPatientId;

    // Import allergies
    if (data.allergies?.length) {
      for (const a of data.allergies) {
        const id = crypto.randomUUID();
        const encrypted = await encryptLocalValue({
          id,
          patientId: patientId,
          substance: a.substance,
          reaction: `[Imported] ${a.reaction || ""}`.trim(),
          severity: a.severity || "unknown",
          version: 1,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        await db.allergies.put({
          id,
          ownerId: identity.userId,
          patientId: patientId,
          encrypted,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          version: 1,
        });
      }
    }

    // Record transfer record in local store
    const transferId = `imp-${crypto.randomUUID().slice(0, 16)}`;
    const checksum = await sha256Hex(packageJson);
    await db.transfers.put({
      id: crypto.randomUUID(),
      ownerId: identity.userId,
      transferId,
      sourceClinicId: data.sourceProvenance.sourceClinicId,
      sourceClinicName: data.sourceProvenance.sourceClinicName,
      targetClinicId: identity.userId,
      patientId: patientId,
      patientName: incoming.fullName,
      status: "imported",
      checksum,
      byteSize: new TextEncoder().encode(packageJson).length,
      manifest: { records: ["patient", "allergies", "medications"] },
      consentPurpose: data.sourceProvenance.consentPurpose,
      encryptedPayload: packageJson,
      sourceProvenance: data.sourceProvenance,
      importedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    });

    return {
      status: "imported",
      importedPatientId: patientId,
      message: `Patient records successfully imported with source provenance attributed to ${data.sourceProvenance.sourceClinicName}.`,
    };
  },

  async listTransfers(): Promise<ClinicTransferRecord[]> {
    return db.transfers.toCollection().reverse().sortBy("createdAt");
  },

  async pairClinic(clinicId: string, clinicName: string, pairingCode: string): Promise<PairedClinicRecord> {
    const record: PairedClinicRecord = {
      id: crypto.randomUUID(),
      clinicId,
      clinicName,
      status: "active",
      pairingCode,
      pairedAt: new Date().toISOString(),
    };
    await db.pairedClinics.put(record);
    return record;
  },

  async listPairedClinics(): Promise<PairedClinicRecord[]> {
    return db.pairedClinics.where("status").equals("active").toArray();
  },
};

