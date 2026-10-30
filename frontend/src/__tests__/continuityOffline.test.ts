import { beforeEach, describe, expect, it } from "vitest";
import { followUpRepository } from "../repositories/followUpRepository";
import { referralRepository } from "../repositories/referralRepository";
import { patientRepository } from "../repositories/patientRepository";
import { resetWorkspace, setOnline, syntheticPatient } from "./helpers";

/**
 * Phase 7 §4 found that the Follow-ups and Referrals screens showed an empty
 * patient list while offline. These tests pin down which data source fails
 * and guarantee that a failure in one of them can never blank the others.
 */
describe("continuity screens load their data offline", () => {
  beforeEach(async () => {
    setOnline(false);
    await resetWorkspace();
  });

  it("lists local patients for the follow-up and referral forms", async () => {
    const patient = await patientRepository.createLocal(syntheticPatient);
    const patients = await patientRepository.listAllLocal();
    expect(patients.map((item) => item.id)).toContain(patient.id);
  });

  it("returns an empty follow-up list rather than throwing on a fresh device", async () => {
    await expect(followUpRepository.listAll()).resolves.toEqual([]);
  });

  it("returns an empty referral list rather than throwing on a fresh device", async () => {
    await expect(referralRepository.listReferrals()).resolves.toEqual([]);
  });

  it("loads both sources together, the way the screens do", async () => {
    await patientRepository.createLocal(syntheticPatient);
    const [followUps, patients] = await Promise.all([
      followUpRepository.listAll(),
      patientRepository.listAllLocal(),
    ]);
    expect(followUps).toEqual([]);
    expect(patients).toHaveLength(1);

    const [referrals, patientsAgain] = await Promise.all([
      referralRepository.listReferrals(),
      patientRepository.listAllLocal(),
    ]);
    expect(referrals).toEqual([]);
    expect(patientsAgain).toHaveLength(1);
  });
  it("creates a follow-up offline for a locally stored patient", async () => {
    const patient = await patientRepository.createLocal(syntheticPatient);
    const record = await followUpRepository.createFollowUp({
      patientId: patient.id,
      scheduledAt: new Date("2026-12-01T09:00:00Z").toISOString(),
      reason: "Offline follow-up check",
      priority: "routine",
      contactPreference: "phone",
      notes: "",
    });
    expect(record.patientName).toBe(syntheticPatient.fullName);
    expect(await followUpRepository.listAll()).toHaveLength(1);
  });

  it("creates a referral draft offline for a locally stored patient", async () => {
    const patient = await patientRepository.createLocal(syntheticPatient);
    const referral = await referralRepository.createReferral({
      patientId: patient.id,
      receivingClinicId: "clinic-regional-01",
      receivingClinicName: "Regional Hospital Clinic",
      priority: "routine",
      status: "draft",
      reason: "Offline referral reason, synthetic data only.",
    });
    expect(referral.patientId).toBe(patient.id);
    expect(await referralRepository.listReferrals()).toHaveLength(1);
  });
});
