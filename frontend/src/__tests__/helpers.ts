import { db } from "../database/db";
import {
  initializeOrUnlockVault,
  lockLocalVault,
  unlockLocalVault,
} from "../security/localVault";
import { resetConnectivityForTests } from "../services/connectivity";

export const testUser = {
  id: "c074a7c7-ea9a-47d2-b9e7-35921305ac81",
  email: "doctor@example.test",
  fullName: "Dr. Test Clinician",
  roles: ["Doctor"],
  permissions: ["patients.read", "patients.write"],
};

export const testPassword = "test-only-local-vault-passphrase";

export const syntheticPatient = {
  fullName: "Synthetic Test Patient",
  dateOfBirth: null,
  estimatedAge: 34,
  gender: "Prefer not to disclose",
  contactPhone: "+00-000-0000",
  address: "12 Example Road",
  village: "Demo Village",
  emergencyContactName: "Synthetic Contact",
  emergencyContactPhone: "+00-000-0001",
  relevantHistory: "No relevant history recorded.",
  allergies: ["unknown"],
};

/** Fresh database and a provisioned, unlocked vault. */
export async function resetWorkspace(): Promise<void> {
  lockLocalVault();
  resetConnectivityForTests();
  db.close();
  await db.delete();
  await db.open();
  await initializeOrUnlockVault(testUser, testPassword);
}

/**
 * Simulates closing and reopening the browser: the in-memory vault key is
 * lost and the database is reopened from storage.
 */
export async function restartBrowser(): Promise<void> {
  lockLocalVault();
  db.close();
  await db.open();
  await unlockLocalVault(testUser.email, testPassword);
}

export function setOnline(online: boolean): void {
  Object.defineProperty(navigator, "onLine", {
    configurable: true,
    value: online,
  });
}

export function makeFile(
  name = "referral.pdf",
  type = "application/pdf",
  contents = "%PDF-1.4 synthetic test document",
): File {
  return new File([contents], name, { type });
}
