import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end offline tests.
 *
 * They run against a production build served by `vite preview`, because the
 * service worker and the installed-app behaviour only exist in a build. The
 * API runs on its own throwaway database seeded with synthetic data.
 *
 * Playwright's bundled browsers are not downloaded in every environment, so
 * the suite uses the locally installed Chrome channel.
 */
const API_PORT = 8001;
const PREVIEW_PORT = 4173;
const API_BASE = `http://localhost:${API_PORT}/api/v1`;

export default defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PREVIEW_PORT}`,
    // Without these, a single action can wait forever and a failure
    // surfaces only as an unexplained test timeout.
    actionTimeout: 20_000,
    navigationTimeout: 30_000,
    trace: "retain-on-failure",
    channel: "chrome",
  },
  projects: [
    {
      name: "chrome",
      use: { ...devices["Desktop Chrome"], channel: "chrome" },
    },
  ],
  webServer: [
    {
      command: `"../.venv/Scripts/python.exe" scripts/run_e2e_backend.py`,
      cwd: "../backend",
      port: API_PORT,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      command: `npm run build && npm run preview -- --port ${PREVIEW_PORT} --strictPort`,
      port: PREVIEW_PORT,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      env: { VITE_API_BASE_URL: "/api/v1", VITE_API_PROXY_TARGET: `http://localhost:${API_PORT}` },
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});
