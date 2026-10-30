import { expect, test, type Page } from "@playwright/test";

const EMAIL = "e2e.clinician@example.com";
const PASSWORD = "synthetic-e2e-passphrase";

// Playwright reuses an already-running e2e server, and that server keeps
// its database between runs. Scoping names to the run avoids collisions.
const RUN = Date.now().toString().slice(-6);
const PATIENT = `Chunked Synthetic ${RUN}`;
const FILE_NAME = `chunked-scan-${RUN}.pdf`;

/** 600 KB: above the 512 KB threshold, so the upload goes out in parts. */
const FILE_BYTES = 600 * 1024;

async function signIn(page: Page) {
  await page.goto("/login");
  // After a reload while online the server session may restore itself and
  // bounce straight back to the workspace; only sign in when the form shows.
  try {
    await page
      .getByRole("heading", { name: "Good day" })
      .waitFor({ state: "visible", timeout: 8_000 });
    return;
  } catch {
    // The login form is showing; sign in explicitly.
  }
  await page.getByLabel("Work email").fill(EMAIL);
  await page.getByLabel("Password / local vault passphrase").fill(PASSWORD);
  await page
    .getByRole("button", { name: /sign in securely|unlock local workspace/i })
    .click();
  await expect(page.getByRole("heading", { name: "Good day" })).toBeVisible();
}

async function registerPatient(page: Page) {
  await page.getByRole("link", { name: "Register patient" }).first().click();
  await expect(
    page.getByRole("heading", { name: "Register a patient" }),
  ).toBeVisible();
  await page.getByLabel("Full name *").fill(PATIENT);
  await page.getByLabel("Estimated age (if DOB unknown)").fill("41");
  await page.getByLabel("Village").fill("Cut Village");
  await page.getByRole("button", { name: /save patient/i }).click();
  await expect(page.getByRole("heading", { name: PATIENT })).toBeVisible();
}

interface ChunkRequest {
  url: string;
  method: string;
  status: number | null;
  failed: boolean;
}

test.describe("chunked document upload", () => {
  test("resumes a large upload after the connection is cut mid-transfer", async ({
    page,
    context,
  }) => {
    test.setTimeout(180_000);

    const chunkRequests: ChunkRequest[] = [];
    let cutConnection = true;

    // While the connection is "cut", every part except the first is refused,
    // exactly like a 2G link dying after one part made it through. Once the
    // cut is lifted the requests pass through untouched.
    await context.route("**/api/v1/documents/chunks/**", async (route) => {
      const request = route.request();
      const url = request.url();
      const match = /\/chunks\/[0-9a-f-]+\/(\d+)$/.exec(url);
      const index = match ? Number(match[1]) : -1;
      if (cutConnection && request.method() === "PUT" && index >= 1) {
        chunkRequests.push({ url, method: "PUT", status: null, failed: true });
        await route.abort("connectionfailed");
        return;
      }
      // The handler sees each logical request once (the service worker's
      // outbound call); the outcome is filled in from the fetched response.
      const record: ChunkRequest = {
        url,
        method: request.method(),
        status: null,
        failed: false,
      };
      chunkRequests.push(record);
      const response = await route.fetch();
      record.status = response.status();
      await route.fulfill({ response });
    });

    await signIn(page);
    await registerPatient(page);

    // Attach a file large enough to force the chunked path.
    await page.getByRole("link", { name: "Documents", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Attach a document" }),
    ).toBeVisible();
    const optionValue = await page
      .locator("select option", { hasText: PATIENT })
      .getAttribute("value");
    expect(optionValue).toBeTruthy();
    await page.locator("select").selectOption(optionValue!);
    await page.getByLabel("Document file").setInputFiles({
      name: FILE_NAME,
      mimeType: "application/pdf",
      buffer: Buffer.concat([
        Buffer.from("%PDF-1.4 simulated clinic scan"),
        Buffer.alloc(FILE_BYTES, 7),
      ]).subarray(0, FILE_BYTES),
    });
    await page.getByRole("button", { name: /save on this device/i }).click();
    await expect(
      page.getByText(/saved securely on this device/i).first(),
    ).toBeVisible();

    // First synchronization: the metadata is acknowledged and the byte
    // upload starts, but the connection dies after the first part. The
    // completion notice only appears once the upload attempt has finished.
    await page.getByRole("link", { name: "Sync center" }).click();
    await page.getByRole("button", { name: /sync now/i }).click();
    await expect(
      page.getByText(/operation\(s\) confirmed by the server/i),
    ).toBeVisible({ timeout: 60_000 });

    // The failed transfer keeps the device retrying while the connection is
    // cut; the network record below is the deterministic evidence.
    const sentParts = (index: number) =>
      chunkRequests.filter(
        (request) =>
          request.method === "PUT" &&
          new RegExp(`/chunks/[0-9a-f-]+/${index}$`).test(request.url),
      );
    expect(sentParts(0).filter((request) => !request.failed)).toHaveLength(1);
    const laterParts = [
      ...sentParts(1),
      ...sentParts(2),
    ];
    expect(laterParts.length).toBeGreaterThan(0);
    expect(laterParts.every((request) => request.failed)).toBe(true);
    expect(
      chunkRequests.filter(
        (request) =>
          request.method === "POST" && request.url.endsWith("/complete"),
      ),
    ).toHaveLength(0);

    // The connection returns. Synchronization retries the failed upload and
    // resumes the same session: part 0 is never re-sent, only the missing
    // parts travel, and the server confirms the assembled file.
    cutConnection = false;
    await page.reload();
    await signIn(page);

    await expect
      .poll(
        () =>
          chunkRequests.filter(
            (request) =>
              request.method === "POST" &&
              request.url.endsWith("/complete") &&
              request.status === 200,
          ).length,
        { timeout: 120_000 },
      )
      .toBeGreaterThanOrEqual(1);

    // The device asked the server which parts were missing before sending
    // them — that status round trip is the resume.
    expect(
      chunkRequests.filter(
        (request) =>
          request.method === "GET" && /\/chunks\/[0-9a-f-]+$/.test(request.url),
      ).length,
    ).toBeGreaterThanOrEqual(2);
    expect(sentParts(0).filter((request) => !request.failed)).toHaveLength(1);
    expect(sentParts(0).filter((request) => request.failed)).toHaveLength(0);
    expect(sentParts(1).filter((request) => !request.failed)).toHaveLength(1);
    expect(sentParts(2).filter((request) => !request.failed)).toHaveLength(1);

    // The workspace shows the document as stored and confirmed.
    await page.getByRole("link", { name: "Documents", exact: true }).click();
    await expect(page.getByText(FILE_NAME)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Synced").first()).toBeVisible();
  });
});
