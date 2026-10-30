import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../database/db";
import { patientRepository } from "../repositories/patientRepository";
import { documentRepository } from "../repositories/documentRepository";
import { syncRepository } from "../repositories/syncRepository";
import {
  OfflineSessionExpiredError,
  getProvisionedUser,
  initializeOrUnlockVault,
  invalidateLocalSession,
  isVaultUnlocked,
  lockLocalVault,
  unlockLocalVault,
} from "../security/localVault";
import {
  makeFile,
  resetWorkspace,
  setOnline,
  syntheticPatient,
  testPassword,
  testUser,
} from "./helpers";

describe("F. offline security", () => {
  beforeEach(async () => {
    setOnline(false);
    await resetWorkspace();
  });

  it("refuses every clinical read and write while the vault is locked", async () => {
    const patient = await patientRepository.createLocal(syntheticPatient);
    lockLocalVault();
    expect(isVaultUnlocked()).toBe(false);

    await expect(patientRepository.getLocal(patient.id)).rejects.toThrow(
      /Unlock the local vault/,
    );
    await expect(patientRepository.listLocal()).rejects.toThrow(
      /Unlock the local vault/,
    );
    await expect(patientRepository.createLocal(syntheticPatient)).rejects.toThrow(
      /Unlock the local vault/,
    );
    await expect(
      documentRepository.saveLocal({ patientId: patient.id, file: makeFile() }),
    ).rejects.toThrow(/Unlock the local vault/);

    // The stored rows are still there, and still unreadable.
    expect(await db.patients.count()).toBe(1);
    expect(JSON.stringify(await db.patients.toArray())).not.toContain(
      syntheticPatient.fullName,
    );
  });

  it("rejects a wrong passphrase without touching stored records", async () => {
    await patientRepository.createLocal(syntheticPatient);
    lockLocalVault();

    await expect(
      unlockLocalVault(testUser.email, "not-the-right-passphrase"),
    ).rejects.toThrow(/Unable to unlock/);
    expect(isVaultUnlocked()).toBe(false);
    expect(await db.patients.count()).toBe(1);

    await unlockLocalVault(testUser.email, testPassword);
    expect((await patientRepository.listLocal()).total).toBe(1);
  });

  it("refuses offline unlock for a device that was never provisioned", async () => {
    lockLocalVault();
    await expect(
      unlockLocalVault("stranger@example.test", testPassword),
    ).rejects.toThrow(/No local account is provisioned/);
  });

  it("ends an expired offline session and keeps the records intact", async () => {
    await patientRepository.createLocal(syntheticPatient);
    const localUser = await getProvisionedUser(testUser.email);
    expect(localUser).toBeDefined();

    // Move the offline session expiry into the past.
    await db.localUsers.update(localUser!.id, {
      offlineSessionExpiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    lockLocalVault();

    await expect(unlockLocalVault(testUser.email, testPassword)).rejects.toThrow(
      OfflineSessionExpiredError,
    );
    expect(isVaultUnlocked()).toBe(false);
    expect(await db.patients.count()).toBe(1);
    expect(await db.syncOperations.count()).toBe(1);

    // A fresh online sign-in restores access without losing queued work.
    await initializeOrUnlockVault(testUser, testPassword, { offlineGraceDays: 7 });
    expect((await patientRepository.listLocal()).total).toBe(1);
    expect(await syncRepository.getPending(testUser.id)).toHaveLength(1);
  });

  it("invalidating the local session locks the vault immediately", async () => {
    await patientRepository.createLocal(syntheticPatient);
    await invalidateLocalSession(testUser.email);

    expect(isVaultUnlocked()).toBe(false);
    await expect(unlockLocalVault(testUser.email, testPassword)).rejects.toThrow(
      OfflineSessionExpiredError,
    );
    // Nothing was deleted.
    expect(await db.patients.count()).toBe(1);
  });

  it("scopes records to the account that created them", async () => {
    await patientRepository.createLocal(syntheticPatient);
    lockLocalVault();

    const otherUser = {
      id: "99999999-9999-4999-8999-999999999999",
      email: "other@example.test",
      fullName: "Other Clinician",
      roles: ["Nurse"],
      permissions: ["patients.read"],
    };
    await initializeOrUnlockVault(otherUser, "another-test-passphrase");

    // The other account sees none of the first account's records.
    expect((await patientRepository.listLocal()).total).toBe(0);
    expect(await syncRepository.getPending(otherUser.id)).toHaveLength(0);
    // ...while the rows themselves are untouched on the device.
    expect(await db.patients.count()).toBe(1);
  });
});
