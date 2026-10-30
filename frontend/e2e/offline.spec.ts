import { expect, test, type Page } from "@playwright/test";

const EMAIL = "e2e.clinician@example.com";
const PASSWORD = "synthetic-e2e-passphrase";

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Work email").fill(EMAIL);
  await page.getByLabel("Password / local vault passphrase").fill(PASSWORD);
  await page.getByRole("button", { name: /sign in securely|unlock local workspace/i }).click();
  await expect(page.getByRole("heading", { name: "Good day" })).toBeVisible();
}

async function registerPatient(page: Page, name: string, village: string) {
  await page.getByRole("link", { name: "Register patient" }).first().click();
  await expect(page.getByRole("heading", { name: "Register a patient" })).toBeVisible();
  await page.getByLabel("Full name *").fill(name);
  await page.getByLabel("Estimated age (if DOB unknown)").fill("41");
  await page.getByLabel("Village").fill(village);
  await page.getByRole("button", { name: /save patient/i }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
}

/**
 * Waits until the service worker is installed and active. The app registers
 * with `clientsClaim` disabled so an update never takes over a page a
 * clinician is working in, which means the first load is not controlled; the
 * next navigation is.
 */
async function waitForServiceWorker(page: Page) {
  await page.waitForFunction(
    async () => {
      const registration = await navigator.serviceWorker?.getRegistration();
      return Boolean(registration?.active);
    },
    undefined,
    { timeout: 60_000 },
  );
}

test.describe("offline-first clinical workflow", () => {
  test("installs, works offline, survives a restart and synchronizes on reconnection", async ({
    page,
    context,
  }) => {
    await signIn(page);
    await waitForServiceWorker(page);

    // 1. A patient created while online reaches the server.
    await registerPatient(page, "Online Synthetic Patient", "Connected Village");
    await page.getByRole("link", { name: "Sync center" }).click();
    await expect(page.getByRole("heading", { name: "Sync center" })).toBeVisible();
    await expect(page.getByText("acknowledged", { exact: false }).first()).toBeVisible();

    // 2. Go offline. The application shell must still load from the cache.
    await context.setOffline(true);
    await page.reload();
    await expect(page.getByRole("heading", { name: /welcome back/i })).toBeVisible();

    // 3. Offline sign-in uses the vault provisioned during the online login.
    await page.getByLabel("Work email").fill(EMAIL);
    await page.getByLabel("Password / local vault passphrase").fill(PASSWORD);
    await page.getByRole("button", { name: /unlock local workspace/i }).click();
    await expect(page.getByRole("heading", { name: "Good day" })).toBeVisible();

    // 4. A patient created with no connectivity is saved locally.
    await registerPatient(page, "Offline Synthetic Patient", "Remote Village");
    await expect(
      page.getByText(/Saved securely on this device/i).first(),
    ).toBeVisible();

    // 5. Local search finds the offline record.
    await page.getByRole("link", { name: "Patients" }).click();
    await page.getByLabel("Search patients").fill("Remote Village");
    await expect(page.getByText("Offline Synthetic Patient")).toBeVisible();
    await expect(page.getByText("Waiting to sync").first()).toBeVisible();

    // 6. The queue and the records survive a full page restart while offline.
    await page.reload();
    await page.getByLabel("Work email").fill(EMAIL);
    await page.getByLabel("Password / local vault passphrase").fill(PASSWORD);
    await page.getByRole("button", { name: /unlock local workspace/i }).click();
    await expect(page.getByRole("heading", { name: "Good day" })).toBeVisible();
    await page.getByRole("link", { name: "Patients" }).click();
    await expect(page.getByText("Offline Synthetic Patient")).toBeVisible();

    await page.getByRole("link", { name: "Sync center" }).click();
    await expect(page.getByText("Waiting to sync").first()).toBeVisible();
    await expect(page.getByRole("button", { name: /sync now/i })).toBeDisabled();

    // 7. Reconnecting drains the queue. Automatic synchronization may win the
    // race with the manual control, so either path is accepted; what matters
    // is that the record ends up confirmed by the server.
    await context.setOffline(false);
    await page.getByRole("button", { name: /check again/i }).click();
    const syncNow = page.getByRole("button", { name: /sync now/i });
    if (await syncNow.isEnabled()) await syncNow.click();

    await expect(async () => {
      await page.getByRole("link", { name: "Patients" }).click();
      await page.getByLabel("Search patients").fill("Remote Village");
      await expect(page.getByText("Synced").first()).toBeVisible({ timeout: 5_000 });
    }).toPass({ timeout: 90_000 });
  });

  test("keeps saving locally while the API is unreachable", async ({ page, context }) => {
    await signIn(page);
    await waitForServiceWorker(page);

    // Only the API is blocked; the browser still reports a network.
    await context.route("**/api/v1/**", (route) => route.abort("connectionrefused"));
    await context.route("**/health", (route) => route.abort("connectionrefused"));

    await page.getByRole("link", { name: "Patients" }).click();
    await registerPatient(page, "Backend Down Patient", "Fallback Village");
    await expect(
      page.getByText(/Saved securely on this device/i).first(),
    ).toBeVisible();

    await page.getByRole("link", { name: "Sync center" }).click();
    await expect(page.getByText("Waiting to sync").first()).toBeVisible();
    await expect(page.getByText(/API unreachable/i).first()).toBeVisible();
  });
});
