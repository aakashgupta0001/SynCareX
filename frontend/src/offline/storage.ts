export interface StorageReport {
  /** Whether IndexedDB, the Storage API and service workers are available. */
  indexedDbSupported: boolean;
  storageApiSupported: boolean;
  serviceWorkerSupported: boolean;
  persistentStorageSupported: boolean;
  persisted: boolean;
  quotaBytes: number | null;
  usageBytes: number | null;
  /** Rough document headroom, after reserving space for app code and records. */
  documentHeadroomBytes: number | null;
  installable: boolean;
  standalone: boolean;
}

export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
export const SUPPORTED_DOCUMENT_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "application/pdf",
] as const;

/**
 * Asks the browser to keep this origin's data out of automatic eviction.
 * Chromium grants it silently for installed apps; Firefox prompts; Safari
 * ignores it. A refusal is reported, never treated as success.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  if (typeof navigator === "undefined" || !navigator.storage?.persist) return false;
  try {
    if (await navigator.storage.persisted?.()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

export async function inspectStorage(): Promise<StorageReport> {
  const storageApiSupported =
    typeof navigator !== "undefined" && typeof navigator.storage?.estimate === "function";
  let quotaBytes: number | null = null;
  let usageBytes: number | null = null;
  let persisted = false;

  if (storageApiSupported) {
    try {
      const estimate = await navigator.storage.estimate();
      quotaBytes = estimate.quota ?? null;
      usageBytes = estimate.usage ?? null;
    } catch {
      quotaBytes = null;
      usageBytes = null;
    }
  }
  if (typeof navigator !== "undefined" && navigator.storage?.persisted) {
    try {
      persisted = await navigator.storage.persisted();
    } catch {
      persisted = false;
    }
  }

  const headroom =
    quotaBytes !== null && usageBytes !== null
      ? Math.max(0, Math.floor((quotaBytes - usageBytes) * 0.8))
      : null;

  return {
    indexedDbSupported: typeof indexedDB !== "undefined",
    storageApiSupported,
    serviceWorkerSupported:
      typeof navigator !== "undefined" && "serviceWorker" in navigator,
    persistentStorageSupported:
      typeof navigator !== "undefined" && typeof navigator.storage?.persist === "function",
    persisted,
    quotaBytes,
    usageBytes,
    documentHeadroomBytes: headroom,
    installable:
      typeof window !== "undefined" &&
      "serviceWorker" in navigator &&
      typeof indexedDB !== "undefined",
    standalone:
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(display-mode: standalone)").matches,
  };
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return "Unknown";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function validateDocument(file: {
  name: string;
  size: number;
  type: string;
}): string | null {
  if (file.size === 0) return "The selected file is empty.";
  if (file.size > MAX_DOCUMENT_BYTES) {
    return `Documents must be ${formatBytes(MAX_DOCUMENT_BYTES)} or smaller. This file is ${formatBytes(file.size)}.`;
  }
  if (!SUPPORTED_DOCUMENT_TYPES.includes(file.type as (typeof SUPPORTED_DOCUMENT_TYPES)[number])) {
    return "Supported formats are PNG, JPEG, WebP and PDF.";
  }
  return null;
}
