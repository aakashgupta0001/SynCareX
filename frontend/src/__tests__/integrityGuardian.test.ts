import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../database/db";
import { aiRepository } from "../repositories/aiRepository";
import { consultationRepository, observationRepository } from "../repositories/consultationRepository";
import { documentRepository } from "../repositories/documentRepository";
import { integrityRepository } from "../repositories/integrityRepository";
import {
  patientIdentifierRepository,
  patientRepository,
} from "../repositories/patientRepository";
import {
  restartBrowser,
  resetWorkspace,
  makeFile,
  setOnline,
  syntheticPatient,
  testPassword,
  testUser,
} from "./helpers";
import {
  encryptLocalBytes,
  initializeOrUnlockVault,
  lockLocalVault,
} from "../security/localVault";

describe("local integrity guardian", () => {
  beforeEach(async () => {
    setOnline(false);
    await resetWorkspace();
  });

  it("finds likely duplicate candidates without matching a shared phone or conflicting birth dates", async () => {
    const first = await patientRepository.createLocal({
      ...syntheticPatient,
      fullName: "Asha Devi",
      dateOfBirth: "1990-01-02",
      estimatedAge: null,
      contactPhone: "+91 98765 43210",
    });
    const likely = await patientRepository.createLocal({
      ...syntheticPatient,
      fullName: "  asha   devi ",
      dateOfBirth: "1990-01-02",
      estimatedAge: null,
      contactPhone: "+91 90000 00000",
    });
    await patientRepository.createLocal({
      ...syntheticPatient,
      fullName: "Another Person",
      dateOfBirth: "1980-04-03",
      estimatedAge: null,
      contactPhone: "+91 98765 43210",
    });
    await patientRepository.createLocal({
      ...syntheticPatient,
      fullName: "Asha Devi",
      dateOfBirth: "1991-01-02",
      estimatedAge: null,
      contactPhone: "+91 80000 00000",
    });

    const findings = await integrityRepository.scanLocal();
    const duplicates = findings.filter(
      (finding) => finding.ruleId === "duplicate_patient_candidate",
    );
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0].evidenceValue.patientIds).toEqual(
      [first.id, likely.id].sort(),
    );
    expect(duplicates[0].severity).toBe("high");
    await integrityRepository.review(
      duplicates[0].id,
      "dismissed",
      "Checked the synthetic source records; these are distinct people.",
    );
    await patientRepository.updateLocal(likely.id, {
      address: "Updated synthetic address",
    });
    const rescanned = await integrityRepository.scanLocal();
    expect(rescanned.find((item) => item.id === duplicates[0].id)?.status).toBe(
      "open",
    );
  });

  it("stores findings encrypted and keeps review rationale across a browser restart", async () => {
    await patientRepository.createLocal({
      ...syntheticPatient,
      fullName: "Sensitive Synthetic Name",
      dateOfBirth: "2030-01-01",
      estimatedAge: null,
    });

    const [finding] = await integrityRepository.scanLocal();
    expect(finding.ruleId).toBe("patient_future_date_of_birth");
    const raw = JSON.stringify(await db.integrityFindings.toArray());
    expect(raw).not.toContain("Sensitive Synthetic Name");

    await integrityRepository.review(
      finding.id,
      "resolved",
      "Verified and corrected using synthetic source data.",
    );
    await restartBrowser();
    const reloaded = await integrityRepository.listLocal();
    expect(reloaded.find((item) => item.id === finding.id)?.status).toBe("resolved");
    expect(reloaded.find((item) => item.id === finding.id)?.rationale).toContain(
      "synthetic source data",
    );
  });

  it("uses conservative name normalization and exact namespaced identifiers", async () => {
    const english = await patientRepository.createLocal({
      ...syntheticPatient,
      fullName: "Asha Devi",
      dateOfBirth: "1990-01-02",
      estimatedAge: null,
    });

    const transliterated = await patientRepository.createLocal({
      ...syntheticPatient,
      fullName: "आशा देवी",
      dateOfBirth: "1990-01-02",
      estimatedAge: null,
    });
    const identified = await patientRepository.createLocal({
      ...syntheticPatient,
      fullName: "Different Synthetic Name",
      dateOfBirth: "1980-01-02",
      estimatedAge: null,
    });
    const sameIdentifier = await patientRepository.createLocal({
      ...syntheticPatient,
      fullName: "Another Synthetic Name",
      dateOfBirth: "1985-01-02",
      estimatedAge: null,
    });
    await patientIdentifierRepository.createLocal({
      patientId: identified.id,
      system: "synthetic registry",
      value: "SYN-001",
    });
    await patientIdentifierRepository.createLocal({
      patientId: sameIdentifier.id,
      system: "synthetic registry",
      value: "SYN-001",
    });

    const findings = await integrityRepository.scanLocal();
    const candidates = findings.filter(
      (finding) => finding.ruleId === "duplicate_patient_candidate",
    );
    expect(candidates).toHaveLength(2);
    expect(candidates.some((finding) =>
      JSON.stringify(finding.evidenceValue.patientIds) ===
      JSON.stringify([english.id, transliterated.id].sort()),
    )).toBe(true);
    expect(candidates.some((finding) =>
      JSON.stringify(finding.evidenceValue.patientIds) ===
      JSON.stringify([identified.id, sameIdentifier.id].sort()),
    )).toBe(true);
  });

  it("only treats a one-character name variant as a candidate when birth dates also match", async () => {
    const first = await patientRepository.createLocal({
      ...syntheticPatient,
      fullName: "Mohan Lal",
      dateOfBirth: "1981-05-06",
      estimatedAge: null,
    });
    const second = await patientRepository.createLocal({
      ...syntheticPatient,
      fullName: "Mohan Lall",
      dateOfBirth: "1981-05-06",
      estimatedAge: null,
    });

    const findings = await integrityRepository.scanLocal();
    const candidate = findings.find(
      (finding) => finding.ruleId === "duplicate_patient_candidate",
    );
    expect(candidate?.evidenceValue.patientIds).toEqual([first.id, second.id].sort());
    expect(candidate?.evidenceValue.matchReason).toContain("one character");
    expect(candidate?.severity).toBe("medium");
  });

  it("flags unsupported AI evidence and leaves the extraction unreviewed", async () => {
    const source = await aiRepository.saveArtifact("transcript", {
      text: "Patient reports a mild headache.",
    });

    const extraction = await aiRepository.saveArtifact(
      "extraction",
      {
        source_id: source.id,
        model_id: "synthetic-model",
        facts: [
          {
            category: "symptom",
            value: "severe headache",
            evidence: "severe headache not in source",
            confidence: 0.9,
          },
        ],
      },
      "review_required",
    );

    const findings = await integrityRepository.scanLocal();
    expect(
      findings.some(
        (finding) =>
          finding.ruleId === "ai_extraction_evidence_invalid" &&
          finding.entityId === extraction.id,
      ),
    ).toBe(true);
    expect(
      findings.some(
        (finding) =>
          finding.ruleId === "ai_extraction_pending_review" &&
          finding.entityId === extraction.id,
      ),
    ).toBe(true);
    expect((await aiRepository.getLocal(extraction.id))?.status).toBe("review_required");
  });

  it("detects document bytes that no longer match their saved checksum", async () => {
    const patient = await patientRepository.createLocal(syntheticPatient);
    const document = await documentRepository.saveLocal({
      patientId: patient.id,
      file: makeFile(),
    });
    const changed = await encryptLocalBytes(
      new TextEncoder().encode("%PDF-1.4 changed synthetic content").buffer,
    );
    await db.documentBlobs.update(document.id, changed);

    const findings = await integrityRepository.scanLocal();
    expect(findings.some(
      (finding) =>
        finding.ruleId === "document_checksum_mismatch" &&
        finding.entityId === document.id,
    )).toBe(true);
  });

  it("requires the provisioned write permission to record a review decision", async () => {
    await patientRepository.createLocal({
      ...syntheticPatient,
      dateOfBirth: "2030-01-01",
      estimatedAge: null,
    });
    const [finding] = await integrityRepository.scanLocal();
    lockLocalVault();
    await initializeOrUnlockVault(
      { ...testUser, permissions: ["patients.read"] },
      testPassword,
    );

    await expect(
      integrityRepository.review(finding.id, "resolved", "Verified synthetic source."),
    ).rejects.toThrow("does not permit integrity review actions");
  });

  it("detects contradictory same-time measurements, incomplete completed visits, and failed sync work", async () => {
    const patient = await patientRepository.createLocal(syntheticPatient);
    const consultation = await consultationRepository.createLocal({
      patientId: patient.id,
    });
    await consultationRepository.updateLocal(consultation.id, { status: "completed" });
    const recordedAt = "2026-10-30T10:00:00.000Z";
    await observationRepository.createLocal({
      patientId: patient.id,
      code: "temperature",
      label: "Temperature",
      value: "37.0",
      unit: "C",
      recordedAt,
    });
    await observationRepository.createLocal({
      patientId: patient.id,
      code: "temperature",
      label: "Temperature",
      value: "38.0",
      unit: "C",
      recordedAt,
    });
    const failedOperation = await db.syncOperations
      .where("entityId")
      .equals(patient.id)
      .first();
    expect(failedOperation).toBeTruthy();
    await db.syncOperations.update(failedOperation!.operationId, {
      status: "failed",
      lastError: "Synthetic transport failure",
    });

    const findings = await integrityRepository.scanLocal();
    expect(findings.map((item) => item.ruleId)).toContain(
      "observation_same_time_disagreement",
    );
    expect(findings.map((item) => item.ruleId)).toContain(
      "completed_consultation_without_documentation",
    );
    expect(findings.map((item) => item.ruleId)).toContain(
      "sync_operation_requires_attention",
    );
  });
});
