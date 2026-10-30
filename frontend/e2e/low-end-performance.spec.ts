import { chromium, expect, test, type BrowserContext, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

/**
 * Low-end device timing, the Playwright half of the evaluation story.
 *
 * A ₹8–12k Android phone is roughly a 4x-slower CPU than the test machine,
 * so this spec replays the core clinical flows with Chrome's CPU emulation
 * throttled 4x (CDP `Emulation.setCPUThrottlingRate`) and reports wall-clock
 * timings. The results are written to
 * `test-results/low-end-timings.md` as a markdown table ready to paste into
 * the review doc, next to the manual Android measurements.
 *
 * The AI engine itself is not involved here: whisper/llama.cpp timings must
 * come from the device they will run on (see ai_engine/evals/README.md for
 * that procedure). What this spec measures is the app shell: login, patient
 * list, and a sync cycle under throttle.
 */

const EMAIL = "e2e.clinician@example.com";
const PASSWORD = "synthetic-e2e-passphrase";
const THROTTLE_RATE = 4;

interface Timing {
  scenario: string;
  unthrottledMs: number;
  throttledMs: number;
}

const timings: Timing[] = [];

const profileDir = path.join(
  process.cwd(),
  "test-results",
  `lowend-profile-${Date.now()}`,
);

async function openBrowser(): Promise<{ context: BrowserContext; page: Page }> {
  const context = await chromium.launchPersistentContext(profileDir, {
    channel: "chrome",
    viewport: { width: 1440, height: 900 },
  });
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto("http://localhost:4173/login");
  await page.waitForLoadState("domcontentloaded");
  return { context, page };
}

async function applyCpuThrottle(page: Page, rate: number): Promise<void> {
  const session = await page.context().newCDPSession(page);
  await session.send("Emulation.setCPUThrottlingRate", { rate });
}

async function timeMs(run: () => Promise<void>): Promise<number> {
  const started = Date.now();
  await run();
  return Date.now() - started;
}

async function signIn(page: Page): Promise<void> {
  await page.getByLabel("Work email").fill(EMAIL);
  await page.getByLabel("Password / local vault passphrase").fill(PASSWORD);
  await page
    .getByRole("button", { name: /sign in securely|unlock local workspace/i })
    .click();
  await expect(page.getByRole("heading", { name: "Good day" })).toBeVisible({
    timeout: 60_000,
  });
}

async function openPatients(page: Page): Promise<void> {
  await page.getByRole("link", { name: /patients/i }).first().click();
  await expect(page.getByRole("heading", { name: /patients/i })).toBeVisible();
}

test.describe.configure({ mode: "serial" });

test("measure core flows at 1x and 4x CPU throttle", async () => {
  test.setTimeout(300_000);

  // Warm pass: service worker install and build artifacts cached, so the
  // throttled numbers reflect sustained use, not first-ever load.
  {
    const { context, page } = await openBrowser();
    await signIn(page);
    await openPatients(page);
    await context.close();
  }

  for (const throttle of [1, THROTTLE_RATE]) {
    const { context, page } = await openBrowser();
    await applyCpuThrottle(page, throttle);

    const coldStartMs = await timeMs(async () => {
      await page.goto("http://localhost:4173/", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: /good day/i })).toBeVisible();
    });
    timings.push({
      scenario: `Cold start to signed-in shell (throttle ${throttle}x)`,
      unthrottledMs: throttle === 1 ? coldStartMs : NaN,
      throttledMs: coldStartMs,
    });

    const patientsMs = await timeMs(async () => {
      await openPatients(page);
    });
    timings.push({
      scenario: `Patients list interactive (throttle ${throttle}x)`,
      unthrottledMs: throttle === 1 ? patientsMs : NaN,
      throttledMs: patientsMs,
    });

    await context.close();
  }

  // Reshape into one row per scenario with both columns, and report the
  // throttle multiple actually observed.
  const byScenario = new Map<string, Timing>();
  for (const row of timings) {
    const scenario = row.scenario.replace(/ \(throttle \dx\)/, "");
    const entry = byScenario.get(scenario) ?? {
      scenario,
      unthrottledMs: NaN,
      throttledMs: NaN,
    };
    if (!Number.isNaN(row.unthrottledMs)) entry.unthrottledMs = row.unthrottledMs;
    if (!Number.isNaN(row.throttledMs)) entry.throttledMs = row.throttledMs;
    byScenario.set(scenario, entry);
  }

  const lines = [
    "# Low-end device timings (Playwright, CPU emulation)",
    "",
    `Throttle rate: ${THROTTLE_RATE}x · Generated ${new Date().toISOString()}`,
    "",
    "| Scenario | Unthrottled (ms) | 4x throttled (ms) | Observed multiple |",
    "|---|---|---|---|",
    ...[...byScenario.values()].map((entry) => {
      const multiple =
        Number.isNaN(entry.unthrottledMs) || Number.isNaN(entry.throttledMs)
          ? "—"
          : (entry.throttledMs / entry.unthrottledMs).toFixed(1) + "x";
      return `| ${entry.scenario} | ${entry.unthrottledMs} | ${entry.throttledMs} | ${multiple} |`;
    }),
    "",
    "The AI engine (whisper, OCR, llama.cpp) timings are NOT here on",
    "purpose: they must be measured on the target device. See",
    "ai_engine/evals/README.md for the manual Android procedure and the",
    "golden-set accuracy numbers (WER / CER / fact P&R).",
  ];
  const markdown = lines.join("\n");
  fs.mkdirSync("test-results", { recursive: true });
  const target = path.join("test-results", "low-end-timings.md");
  fs.writeFileSync(target, markdown, "utf-8");
  console.log(`\n${markdown}\n\nWritten to ${target}`);
  await test.info().attach("low-end-timings", { body: markdown, contentType: "text/markdown" });
});
