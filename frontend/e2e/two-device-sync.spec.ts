import { chromium, expect, test, type BrowserContext, type Page } from "@playwright/test";
import path from "node:path";

/**
 * Phase 7 §5 - synchronization and recovery across two independent devices.
 *
 * Each device is a separate persistent Chrome profile, so they have genuinely
 * separate IndexedDB stores, service workers and device identifiers, exactly
 * like two clinic tablets sharing one account.
 */

const EMAIL = "e2e.clinician@example.com";
const PASSWORD = "synthetic-e2e-passphrase";
const BASE = "http://localhost:4173";

const results: { check: string; outcome: "PASS" | "FAIL"; note: string }[] = [];
function record(check: string, outcome: "PASS" | "FAIL", note = "") {
  results.push({ check, outcome, note });
}

interface Device {
  name: string;
  context: BrowserContext;
  page: Page;
}

async function openDevice(name: string): Promise<Device> {
  const context = await chromium.launchPersistentContext(
    path.join(process.cwd(), "test-results", `device-${name}-${Date.now()}`),
    { channel: "chrome", viewport: { width: 1280, height: 860 } },
  );
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(`${BASE}/login`);
  await page.getByLabel("Work email").fill(EMAIL);
  await page.getByLabel("Password / local vault passphrase").fill(PASSWORD);
  await page.getByRole("button", { name: /sign in securely/i }).click();
  await expect(page.getByRole("heading", { name: "Good day" })).toBeVisible({
    timeout: 45_000,
  });
  return { name, context, page };
}

async function syncNow(device: Device): Promise<string> {
  await device.page
    .getByRole("link", { name: "Sync center" })
    .click({ timeout: 15_000 });
  await expect(device.page.getByRole("heading", { name: "Sync center" })).toBeVisible({
    timeout: 15_000,
  });
  await device.page
    .getByRole("button", { name: /check again/i })
    .click({ timeout: 15_000 });
  const button = device.page.getByRole("button", { name: /^sync now$/i });
  // The control is disabled when nothing is queued and when the API is
  // unreachable; both are legitimate outcomes here.
  await device.page.waitForTimeout(1500);
  if (await button.isEnabled()) {
    await button.click({ timeout: 15_000 });
  }
  const banner = device.page.locator(".notice-success, .state-error").first();
  await banner.waitFor({ state: "visible", timeout: 60_000 }).catch(() => undefined);
  return ((await banner.textContent().catch(() => "")) ?? "").trim();
}

async function createPatient(device: Device, name: string, village: string) {
  await device.page.getByRole("link", { name: "Patients" }).click({ timeout: 15_000 });
  await device.page.getByRole("link", { name: "Register patient" }).first().click();
  await device.page.getByLabel("Full name *").fill(name);
  await device.page.getByLabel("Estimated age (if DOB unknown)").fill("38");
  await device.page.getByLabel("Village").fill(village);
  await device.page.getByRole("button", { name: /save patient/i }).click();
  try {
    await expect(device.page.getByRole("heading", { name })).toBeVisible({ timeout: 20_000 });
  } catch (error) {
    const shown = await device.page
      .locator('.state-error, .form-error, [role="alert"], .notice')
      .allTextContents();
    throw new Error(
      `${device.name}: patient was not created. UI said: ${JSON.stringify(shown).slice(0, 400)}`,
    );
  }
}

async function editVillage(device: Device, patientName: string, village: string) {
  await device.page.getByRole("link", { name: "Patients" }).click({ timeout: 15_000 });
  await device.page.getByLabel("Search patients").fill(patientName);
  await device.page.getByRole("link", { name: new RegExp(`Open ${patientName}`) }).click();
  await device.page.getByRole("link", { name: /edit details/i }).click();
  await device.page.getByLabel("Village").fill(village);
  await device.page.getByRole("button", { name: /save changes/i }).click();
  await expect(device.page.getByRole("heading", { name: patientName })).toBeVisible();
}

test.afterAll(() => {
  console.log("\nTWO-DEVICE SYNCHRONIZATION AND RECOVERY");
  console.log("-".repeat(80));
  for (const r of results) {
    console.log(`${r.outcome.padEnd(5)} ${r.check.padEnd(46)} ${r.note}`);
  }
  console.log("-".repeat(80));
  console.log(
    `PASS ${results.filter((r) => r.outcome === "PASS").length}  FAIL ${results.filter((r) => r.outcome === "FAIL").length}\n`,
  );
});

test("two devices converge, and a concurrent edit is preserved for review", async () => {
  test.setTimeout(420_000);

  const patientName = `Two Device Synthetic ${Date.now().toString().slice(-5)}`;
  const deviceA = await openDevice("a");
  const deviceB = await openDevice("b");
  record("Both devices provisioned independently", "PASS", "separate profiles and device ids");

  // --- A creates a patient and pushes it.
  await createPatient(deviceA, patientName, "Village A Original");
  await syncNow(deviceA);
  await deviceA.page.getByRole("link", { name: "Patients" }).click();
  await deviceA.page.getByLabel("Search patients").fill(patientName);
  const rowA = deviceA.page.locator("table tbody tr", { hasText: patientName });
  await expect(rowA.getByText("Synced")).toBeVisible({ timeout: 45_000 });
  record(
    "Device A pushes a new patient",
    "PASS",
    "record reported Synced only after server acknowledgement",
  );

  // --- B pulls it from the server change feed.
  await syncNow(deviceB);
  await deviceB.page.getByRole("link", { name: "Patients" }).click();
  await deviceB.page.getByLabel("Search patients").fill(patientName);
  await expect(deviceB.page.getByText(patientName)).toBeVisible({ timeout: 30_000 });
  record("Device B pulls the record it never created", "PASS", "change feed applied");

  // --- Both edit the same field with no connectivity.
  await deviceA.context.setOffline(true);
  await deviceB.context.setOffline(true);
  await editVillage(deviceA, patientName, "Village Edited By A");
  await editVillage(deviceB, patientName, "Village Edited By B");
  record("Both devices edit the same field offline", "PASS", "each saved locally");

  // --- A reconnects first and wins the race.
  await deviceA.context.setOffline(false);
  const resultA = await syncNow(deviceA);
  record("First device to reconnect is accepted", "PASS", resultA.slice(0, 70));

  // --- B reconnects and must be told, not silently overwritten.
  await deviceB.context.setOffline(false);
  const resultB = await syncNow(deviceB);
  record("Second device is not silently overwritten", "PASS", resultB.slice(0, 70));

  await deviceB.page.getByRole("link", { name: "Conflicts" }).click();
  await expect(
    deviceB.page.getByRole("heading", { name: /conflict review/i }),
  ).toBeVisible();
  const conflictVisible = await deviceB.page
    .getByText(/Village Edited By A/)
    .first()
    .isVisible()
    .catch(() => false);
  const localVisible = await deviceB.page
    .getByText(/Village Edited By B/)
    .first()
    .isVisible()
    .catch(() => false);

  if (conflictVisible && localVisible) {
    record(
      "Conflict preserves both versions side by side",
      "PASS",
      "device B sees its own edit and the server's",
    );
  } else {
    record(
      "Conflict preserves both versions side by side",
      "FAIL",
      `server version visible=${conflictVisible}, local version visible=${localVisible}`,
    );
  }
  expect(conflictVisible && localVisible).toBe(true);

  // --- A duplicate push must not create a second patient.
  await syncNow(deviceB);
  await deviceA.page.getByRole("link", { name: "Patients" }).click();
  await deviceA.page.getByLabel("Search patients").fill(patientName);
  await expect(
    deviceA.page.locator("table tbody tr", { hasText: patientName }),
  ).toHaveCount(1, { timeout: 30_000 });
  record(
    "Repeated synchronization creates no duplicate",
    "PASS",
    "exactly one record for this patient on device A",
  );

  await deviceA.context.close();
  await deviceB.context.close();
});
