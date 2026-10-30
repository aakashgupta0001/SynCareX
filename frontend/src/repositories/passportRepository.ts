/**
 * SynCareX Emergency Patient Passport Repository.
 *
 * Implements:
 * 1. Offline & online emergency passport generation.
 * 2. Data minimization: includes only selected clinical sections.
 * 3. High-entropy token generation and SHA-256 token hash.
 * 4. Tamper detection via cryptographic checksum.
 * 5. Offline verification with clear revocation status warnings.
 * 6. Local certificate revocation cache (CRL).
 */

import { db } from "../database/db";
import type { EmergencyPassportRecord, VerificationBadge } from "../database/types";
import {
  decryptLocalValue,
  encryptLocalValue,
  requireUnlockedIdentity,
} from "../security/localVault";
import { patientRepository } from "./patientRepository";
import { buildOperation } from "./syncRepository";
import { getLocalDeviceId } from "../offline/device";

export interface EmergencySummaryPayload {
  passportId: string;
  patientNumber: string;
  patientFullName: string;
  gender?: string | null;
  age?: number | null;
  dateOfBirth?: string | null;
  emergencyContact?: { name?: string | null; phone?: string | null } | null;
  allergies?: Array<{ substance: string; reaction?: string | null; severity?: string }>;
  medications?: Array<{ name: string; dose?: string | null; frequency?: string | null }>;
  relevantHistory?: string | null;
  keyObservations?: Array<{ code: string; label: string; value: string; unit?: string | null }>;
  issuedAt: string;
  expiresAt: string;
  issuingClinicId: string;
  verificationBadge: VerificationBadge;
  checksum: string;
}

export interface PassportVerificationResult {
  isValid: boolean;
  status: "valid" | "expired" | "revoked" | "invalid";
  verificationBadge: VerificationBadge;
  payload?: EmergencySummaryPayload;
  offlineWarning?: string;
  message: string;
  expiresAt?: string;
  issuedAt?: string;
  revokedAt?: string | null;
  revocationReason?: string | null;
}

async function sha256Hex(data: string): Promise<string> {
  const bytes = new TextEncoder().encode(data);
  const hashBuffer = await crypto.subtle.digest("SHA-256", bytes);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const passportRepository = {
  /**
   * Generates an emergency patient passport from locally verified records.
   */
  async createPassport(options: {
    patientId: string;
    includedFields: string[];
    consentGiven: boolean;
    consentDetails?: string;
    validityHours?: number;
  }): Promise<{ record: EmergencyPassportRecord; token: string; payload: EmergencySummaryPayload }> {
    const identity = requireUnlockedIdentity();
    const patient = await patientRepository.getLocal(options.patientId);
    if (!patient) throw new Error("Patient not found in local vault");

    const passportId = crypto.randomUUID();
    const validityHours = options.validityHours || 72;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + validityHours * 3600 * 1000).toISOString();
    const issuedAt = now.toISOString();

    const summary: Partial<EmergencySummaryPayload> = {
      passportId,
      patientNumber: patient.patientNumber,
      patientFullName: patient.fullName,
      gender: patient.gender,
      age: patient.estimatedAge,
      dateOfBirth: patient.dateOfBirth,
      issuedAt,
      expiresAt,
      issuingClinicId: identity.userId,
      verificationBadge: "verified",
    };

    const inc = new Set(options.includedFields);

    if (inc.has("emergency_contact")) {
      summary.emergencyContact = {
        name: patient.emergencyContactName,
        phone: patient.emergencyContactPhone,
      };
    }

    if (inc.has("allergies")) {
      const allergyRows = await db.allergies
        .where("patientId")
        .equals(patient.id)
        .toArray();
      const allergies = await Promise.all(
        allergyRows.map((r) => decryptLocalValue<{ substance: string; reaction?: string; severity?: string }>(r.encrypted)),
      );
      summary.allergies = allergies;
    }

    if (inc.has("medications")) {
      const medRows = await db.medications
        .where("patientId")
        .equals(patient.id)
        .toArray();
      const meds = await Promise.all(
        medRows.map((r) => decryptLocalValue<{ name: string; dose?: string; frequency?: string }>(r.encrypted)),
      );
      summary.medications = meds;
    }

    if (inc.has("recent_history")) {
      summary.relevantHistory = patient.relevantHistory;
    }

    if (inc.has("observations")) {
      const obsRows = await db.observations
        .where("patientId")
        .equals(patient.id)
        .toArray();
      const obs = await Promise.all(
        obsRows.slice(0, 5).map((r) => decryptLocalValue<{ code: string; label: string; value: string; unit?: string }>(r.encrypted)),
      );
      summary.keyObservations = obs;
    }

    // Deterministic checksum for package tamper detection
    const canonicalJson = JSON.stringify(summary, Object.keys(summary).sort());
    const checksum = await sha256Hex(canonicalJson);
    const fullPayload: EmergencySummaryPayload = {
      ...(summary as EmergencySummaryPayload),
      checksum,
    };

    // Generate high-entropy opaque verification token
    const tokenBytes = crypto.getRandomValues(new Uint8Array(24));
    let binary = "";
    for (const b of tokenBytes) binary += String.fromCharCode(b);
    const token = `scx-pass-${btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
    const tokenHash = await sha256Hex(token);

    const encrypted = await encryptLocalValue(fullPayload);
    const deviceId = await getLocalDeviceId();

    const record: EmergencyPassportRecord = {
      id: passportId,
      ownerId: identity.userId,
      patientId: patient.id,
      patientName: patient.fullName,
      tokenHash,
      encrypted,
      summaryManifest: options.includedFields,
      consentGiven: options.consentGiven,
      consentDetails: options.consentDetails,
      isRevoked: false,
      expiresAt,
      createdAt: issuedAt,
      version: 1,
    };

    // Queue durable sync operation
    const operation = await buildOperation({
      ownerId: identity.userId,
      entityType: "passport",
      entityId: passportId,
      operationType: "create",
      payload: encrypted,
      baseVersion: 0,
      localVersion: 1,
      deviceId,
      actorId: identity.userId,
    });

    await db.transaction("rw", [db.passports, db.syncOperations], async () => {
      await db.passports.put(record);
      await db.syncOperations.put(operation);
    });

    return { record, token, payload: fullPayload };
  },

  /**
   * Verifies an emergency passport locally when offline.
   * Clearly reports offline warning that server CRL cannot be checked.
   */
  async verifyPassportOffline(token: string): Promise<PassportVerificationResult> {
    const tokenHash = await sha256Hex(token.trim());

    // 1. Check local revocation cache
    const revoked = await db.passportRevocations.get(tokenHash);
    if (revoked) {
      return {
        isValid: false,
        status: "revoked",
        verificationBadge: "unverified",
        revokedAt: revoked.revokedAt,
        revocationReason: revoked.reason,
        offlineWarning: "Offline verification: Verified against local revocation cache.",
        message: "This passport has been revoked according to local device records.",
      };
    }

    // 2. Check local passport records
    const record = await db.passports.where("tokenHash").equals(tokenHash).first();
    if (!record) {
      return {
        isValid: false,
        status: "invalid",
        verificationBadge: "unverified",
        offlineWarning: "Offline verification: Token not found in local device database.",
        message: "Emergency passport token could not be found locally.",
      };
    }

    if (record.isRevoked) {
      return {
        isValid: false,
        status: "revoked",
        verificationBadge: "unverified",
        revokedAt: record.revokedAt,
        revocationReason: record.revocationReason,
        offlineWarning: "Offline verification: Recorded as revoked locally.",
        message: "This emergency passport was revoked.",
      };
    }

    const now = new Date().toISOString();
    if (record.expiresAt < now) {
      return {
        isValid: false,
        status: "expired",
        verificationBadge: "expired",
        expiresAt: record.expiresAt,
        issuedAt: record.createdAt,
        offlineWarning: "Offline verification: Checked against local system clock.",
        message: "This emergency passport has expired.",
      };
    }

    try {
      const payload = await decryptLocalValue<EmergencySummaryPayload>(record.encrypted);

      // Verify checksum
      const { checksum, ...rest } = payload;
      const canonical = JSON.stringify(rest, Object.keys(rest).sort());
      const calculatedChecksum = await sha256Hex(canonical);

      if (checksum && checksum !== calculatedChecksum) {
        return {
          isValid: false,
          status: "invalid",
          verificationBadge: "unverified",
          offlineWarning: "Offline verification: Cryptographic checksum mismatch.",
          message: "Tamper detected: package checksum does not match contents.",
        };
      }

      return {
        isValid: true,
        status: "valid",
        verificationBadge: "verified",
        payload,
        expiresAt: record.expiresAt,
        issuedAt: record.createdAt,
        offlineWarning: "Offline verification: Revocation status cannot be verified against central server without connectivity.",
        message: "Verified authentic emergency passport (offline mode).",
      };
    } catch {
      return {
        isValid: false,
        status: "invalid",
        verificationBadge: "unverified",
        offlineWarning: "Offline verification: Decryption failed.",
        message: "Could not decrypt local emergency passport package.",
      };
    }
  },

  /**
   * Revokes a passport locally and caches revocation.
   */
  async revokePassport(passportId: string, reason: string): Promise<void> {
    const record = await db.passports.get(passportId);
    if (!record) throw new Error("Passport not found");

    const now = new Date().toISOString();
    record.isRevoked = true;
    record.revokedAt = now;
    record.revocationReason = reason;
    record.version += 1;

    await db.transaction("rw", [db.passports, db.passportRevocations], async () => {
      await db.passports.put(record);
      await db.passportRevocations.put({
        tokenHash: record.tokenHash,
        revokedAt: now,
        reason,
      });
    });
  },

  /**
   * Lists all local emergency passports.
   */
  async listPassports(patientId?: string): Promise<EmergencyPassportRecord[]> {
    if (patientId) {
      return db.passports.where("patientId").equals(patientId).reverse().sortBy("createdAt");
    }
    return db.passports.toCollection().reverse().sortBy("createdAt");
  },
};

