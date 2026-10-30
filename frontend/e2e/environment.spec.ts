import { expect, test } from "@playwright/test";

/**
 * Measures what this browser can actually offer the offline engine and prints
 * it, so the numbers in PROJECT_STATUS.md are measured rather than assumed.
 * It also fails if a capability the engine depends on is missing.
 */
test("reports the browser's offline storage and PWA capabilities", async ({ page }) => {
  await page.goto("/login");
  // Measure after the service worker has registered, so the numbers are
  // stable rather than dependent on how fast registration happened.
  await page
    .waitForFunction(
      async () => Boolean(await navigator.serviceWorker?.getRegistration()),
      undefined,
      { timeout: 30_000 },
    )
    .catch(() => undefined);

  const report = await page.evaluate(async () => {
    const estimate = (await navigator.storage?.estimate?.()) ?? {};
    const persisted = (await navigator.storage?.persisted?.()) ?? false;
    const registration = await navigator.serviceWorker?.getRegistration();
    return {
      userAgent: navigator.userAgent,
      indexedDb: typeof indexedDB !== "undefined",
      webCrypto: typeof crypto?.subtle?.encrypt === "function",
      serviceWorker: "serviceWorker" in navigator,
      serviceWorkerRegistered: Boolean(registration),
      backgroundSync:
        typeof registration !== "undefined" && registration !== null
          ? "sync" in registration
          : false,
      storageApi: typeof navigator.storage?.estimate === "function",
      persistentStorageApi: typeof navigator.storage?.persist === "function",
      persisted,
      quotaBytes: estimate.quota ?? null,
      usageBytes: estimate.usage ?? null,
      deviceMemoryGb:
        (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? null,
      hardwareConcurrency: navigator.hardwareConcurrency ?? null,
      webGpu: "gpu" in navigator,
      wasm: typeof WebAssembly === "object",
    };
  });

  const gib = (value: number | null) =>
    value === null ? "unknown" : `${(value / 1024 ** 3).toFixed(2)} GiB`;

  console.log(
    [
      "SynCareX browser capability report",
      `  user agent             : ${report.userAgent}`,
      `  IndexedDB              : ${report.indexedDb}`,
      `  Web Crypto (AES-GCM)   : ${report.webCrypto}`,
      `  Service worker         : ${report.serviceWorker} (registered: ${report.serviceWorkerRegistered})`,
      `  Background Sync        : ${report.backgroundSync} (optional)`,
      `  Storage estimate API   : ${report.storageApi}`,
      `  Persistent storage API : ${report.persistentStorageApi} (granted: ${report.persisted})`,
      `  Storage quota          : ${gib(report.quotaBytes)}`,
      `  Storage in use         : ${gib(report.usageBytes)}`,
      `  Device memory          : ${report.deviceMemoryGb ?? "unknown"} GB`,
      `  Logical processors     : ${report.hardwareConcurrency ?? "unknown"}`,
      `  WebGPU / WebAssembly   : ${report.webGpu} / ${report.wasm}`,
    ].join("\n"),
  );

  // Everything the offline engine depends on must be present.
  expect(report.indexedDb).toBe(true);
  expect(report.webCrypto).toBe(true);
  expect(report.serviceWorker).toBe(true);
  expect(report.storageApi).toBe(true);
  // A browser with a tiny quota cannot hold a clinic's offline records.
  expect(report.quotaBytes ?? 0).toBeGreaterThan(50 * 1024 * 1024);
});
