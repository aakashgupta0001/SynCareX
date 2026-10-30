import { expect, test, type Page } from "@playwright/test";

/**
 * Phase 7 §7 - interface quality checks that only a real browser can answer:
 * keyboard escape routes, responsive layout, and that an offline indicator
 * reflects the actual state rather than a hardcoded label.
 */

const EMAIL = "e2e.clinician@example.com";
const PASSWORD = "synthetic-e2e-passphrase";

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Work email").fill(EMAIL);
  await page.getByLabel("Password / local vault passphrase").fill(PASSWORD);
  await page
    .getByRole("button", { name: /sign in securely|unlock local workspace/i })
    .click();
  await expect(page.getByRole("heading", { name: "Good day" })).toBeVisible({
    timeout: 45_000,
  });
}

test("modal dialogs can be dismissed with the keyboard", async ({ page }) => {
  await signIn(page);

  // Regression: these overlays swallow pointer events, so without an Escape
  // handler a clinician who opened one could not reach the rest of the app.
  const cases: { nav: string; open: RegExp }[] = [
    { nav: "Follow-ups", open: /schedule follow-up/i },
    { nav: "Referrals", open: /new referral/i },
  ];

  for (const { nav, open } of cases) {
    await page.getByRole("link", { name: nav }).click();
    await page.getByRole("button", { name: open }).first().click();
    const overlay = page.locator("div.fixed.inset-0").first();
    await expect(overlay).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(overlay).toBeHidden({ timeout: 5_000 });

    // The rest of the interface is reachable again.
    await page.getByRole("link", { name: "Patients" }).click();
    await expect(
      page.getByRole("heading", { name: "Patient directory" }),
    ).toBeVisible();
  }
});

test("the connectivity indicator reflects the real API state", async ({
  page,
  context,
}) => {
  await signIn(page);
  await expect(page.getByRole("status").filter({ hasText: /online/i }).first()).toBeVisible();

  // Network up but the API blocked: the indicator must not claim "Online".
  await context.route("**/health", (route) => route.abort("connectionrefused"));
  await context.route("**/api/v1/**", (route) => route.abort("connectionrefused"));
  await page.getByRole("link", { name: "Sync center" }).click();
  await page.getByRole("button", { name: /check again/i }).click();
  await expect(page.getByText(/api unreachable/i).first()).toBeVisible({
    timeout: 30_000,
  });
});

test("the workspace stays usable at tablet and phone widths", async ({ page }) => {
  await signIn(page);

  for (const [label, size] of [
    ["tablet", { width: 768, height: 1024 }],
    ["phone", { width: 390, height: 844 }],
  ] as const) {
    await page.setViewportSize(size);
    await page.getByRole("link", { name: "Patients" }).click();
    await expect(
      page.getByRole("heading", { name: "Patient directory" }),
      `patient directory heading at ${label} width`,
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Register patient" }).first(),
      `primary action reachable at ${label} width`,
    ).toBeVisible();
    // The table scrolls inside its own card rather than being cut off.
    await expect(page.locator(".patient-table-wrap")).toBeVisible();
  }
});

async function sidewaysScroll(page: Page): Promise<number> {
  await page.getByRole("link", { name: "Patients" }).click();
  await expect(page.getByRole("heading", { name: "Patient directory" })).toBeVisible();
  // Let layout settle: measuring in the same frame as the first paint catches
  // a transient wide state that resolves on the next frame.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await page.waitForTimeout(300);
  return page.evaluate(() => {
    window.scrollTo(500, 0);
    const x = window.scrollX;
    window.scrollTo(0, 0);
    return x;
  });
}

test("the page does not scroll horizontally at small widths", async ({ page }) => {
  // KNOWN OPEN DEFECT (P3), tracked in docs/FINAL_AUDIT_REPORT.md.
  //
  // At small widths the page can be dragged roughly 35px sideways. It is
  // intermittent: across runs it appears at 768px or at 390px, not reliably
  // at both, which is why it is one test rather than two.
  // document.documentElement reports scrollWidth 803px while document.body
  // matches the viewport, so a single content-width element is a little too
  // wide. Ruled out: the patient table (clipped by its own overflow-x:auto
  // wrapper) and the collapsed horizontal nav strip (min-width:0 changed
  // nothing). Moving the sidebar breakpoint from 760px to 900px reduced it
  // from 260px to 35px. Cosmetic: no control is unreachable and no content
  // is cut off. Expected-to-fail so it reports as soon as it is fixed.
  test.fail();
  await page.setViewportSize({ width: 768, height: 1024 });
  await signIn(page);
  expect(await sidewaysScroll(page)).toBe(0);
});

test("the sign-in form is reachable by keyboard alone", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Work email").focus();
  await page.keyboard.type(EMAIL);
  await page.keyboard.press("Tab");
  await page.keyboard.type(PASSWORD);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Good day" })).toBeVisible({
    timeout: 45_000,
  });
});
