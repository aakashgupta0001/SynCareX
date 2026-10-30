import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

/**
 * Cache version. Bumping it retires the previous precache on the next
 * activation without touching IndexedDB, where clinical records live.
 */
const CACHE_VERSION = "v2";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      // The app asks before activating an update, so a clinician is never
      // interrupted mid-form by a reload.
      registerType: "prompt",
      injectRegister: null,
      includeAssets: [
        "pwa-icon.svg",
        "pwa-192.png",
        "pwa-512.png",
        "pwa-maskable-512.png",
        "apple-touch-icon.png",
        "offline.html",
        "robots.txt",
      ],
      manifest: {
        name: "SynCareX Clinical Workspace",
        short_name: "SynCareX",
        description: "Offline-first clinical documentation workspace",
        theme_color: "#0f766e",
        background_color: "#f5f8f7",
        display: "standalone",
        orientation: "any",
        scope: "/",
        start_url: "/",
        categories: ["medical", "productivity"],
        icons: [
          { src: "/pwa-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "/pwa-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          {
            src: "/pwa-maskable-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
          { src: "/pwa-icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
        ],
      },
      workbox: {
        // The application shell is precached so the installed app opens with
        // no network at all.
        navigateFallback: "/index.html",
        // API and health requests must never be answered from a cache.
        navigateFallbackDenylist: [/^\/api\//, /^\/health$/],
        cleanupOutdatedCaches: true,
        clientsClaim: false,
        skipWaiting: false,
        cacheId: `syncarex-${CACHE_VERSION}`,
        globPatterns: ["**/*.{html,js,css,svg,png,woff2,webmanifest}"],
        runtimeCaching: [
          {
            // Patient data and tokens are never stored as static assets.
            urlPattern: /\/api\/v1\//,
            handler: "NetworkOnly",
            method: "GET",
          },
          {
            urlPattern: /\/health$/,
            handler: "NetworkOnly",
            method: "GET",
          },
        ],
      },
      devOptions: {
        enabled: true,
        type: "module",
      },
    }),
  ],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/__tests__/setup.ts"],
    // The e2e directory belongs to Playwright, which runs a real browser.
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    exclude: ["node_modules", "dist", "e2e"],
  },
});
