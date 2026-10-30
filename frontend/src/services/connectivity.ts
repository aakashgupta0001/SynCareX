import { checkApiHealth } from "./api";
import { getLocalSetting, setLocalSetting } from "../offline/device";

const LAST_SYNC_KEY = "last_successful_sync_at";
const HEALTH_INTERVAL_MS = 30_000;
const OFFLINE_RECHECK_MS = 10_000;

export interface ConnectivityState {
  /** navigator.onLine. True only means a network interface exists. */
  browserOnline: boolean;
  /** Result of the last /health probe; null until one has completed. */
  apiReachable: boolean | null;
  checking: boolean;
  lastHealthCheckAt: string | null;
  lastHealthError: string | null;
  lastSuccessfulSyncAt: string | null;
}

export type ConnectivityListener = (state: ConnectivityState) => void;

let state: ConnectivityState = {
  browserOnline: typeof navigator === "undefined" ? true : navigator.onLine,
  apiReachable: null,
  checking: false,
  lastHealthCheckAt: null,
  lastHealthError: null,
  lastSuccessfulSyncAt: null,
};

const listeners = new Set<ConnectivityListener>();
let timer: ReturnType<typeof setTimeout> | null = null;
let started = false;
const reconnectHandlers = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener(state);
}

function patch(changes: Partial<ConnectivityState>): void {
  const previouslyUsable = isApiUsable(state);
  state = { ...state, ...changes };
  emit();
  if (!previouslyUsable && isApiUsable(state)) {
    for (const handler of reconnectHandlers) handler();
  }
}

export function isApiUsable(current: ConnectivityState = state): boolean {
  return current.browserOnline && current.apiReachable === true;
}

export function getConnectivityState(): ConnectivityState {
  return state;
}

export function subscribeConnectivity(listener: ConnectivityListener): () => void {
  listeners.add(listener);
  listener(state);
  return () => listeners.delete(listener);
}

/** Runs when the API becomes reachable again after being unavailable. */
export function onApiReconnected(handler: () => void): () => void {
  reconnectHandlers.add(handler);
  return () => reconnectHandlers.delete(handler);
}

/**
 * Probes the API. navigator.onLine alone does not prove the backend is
 * reachable, so every sync decision is gated on this result.
 */
export async function probeApi(): Promise<boolean> {
  if (typeof navigator !== "undefined" && !navigator.onLine) {
    patch({
      browserOnline: false,
      apiReachable: false,
      checking: false,
      lastHealthCheckAt: new Date().toISOString(),
      lastHealthError: "The device reports no network connection.",
    });
    return false;
  }
  patch({ checking: true });
  const result = await checkApiHealth();
  patch({
    browserOnline: typeof navigator === "undefined" ? true : navigator.onLine,
    apiReachable: result.ok,
    checking: false,
    lastHealthCheckAt: new Date().toISOString(),
    lastHealthError: result.ok ? null : result.error,
  });
  return result.ok;
}

export async function recordSuccessfulSync(): Promise<void> {
  const now = new Date().toISOString();
  await setLocalSetting(LAST_SYNC_KEY, now);
  patch({ lastSuccessfulSyncAt: now });
}

export async function loadLastSuccessfulSync(): Promise<string | null> {
  const stored = await getLocalSetting(LAST_SYNC_KEY);
  if (stored !== state.lastSuccessfulSyncAt) patch({ lastSuccessfulSyncAt: stored });
  return stored;
}

function schedule(): void {
  if (timer) clearTimeout(timer);
  const delay = state.browserOnline ? HEALTH_INTERVAL_MS : OFFLINE_RECHECK_MS;
  timer = setTimeout(() => {
    void probeApi().finally(schedule);
  }, delay);
}

/** Starts connectivity monitoring. Safe to call more than once. */
export function startConnectivityMonitor(): () => void {
  if (typeof window === "undefined") return () => undefined;
  if (started) return stopConnectivityMonitor;
  started = true;

  const handleOnline = () => {
    patch({ browserOnline: true });
    // "Connected to WiFi" does not mean the internet works yet — routers
    // often need a few seconds, and a probe fired too early fails and then
    // waits for the next 30-second health tick, leaving freshly queued work
    // showing as waiting long after the link is usable. A short burst of
    // re-probes makes the reconnect sync fire the moment it is.
    void probeApi().finally(schedule);
    for (const delay of [3_000, 8_000, 15_000]) {
      window.setTimeout(() => {
        if (!isApiUsable(state)) void probeApi().finally(schedule);
      }, delay);
    }
  };
  const handleOffline = () => {
    patch({
      browserOnline: false,
      apiReachable: false,
      lastHealthError: "The device reports no network connection.",
    });
    schedule();
  };
  const handleResume = () => {
    if (document.visibilityState === "visible") {
      void probeApi().finally(schedule);
    }
  };

  window.addEventListener("online", handleOnline);
  window.addEventListener("offline", handleOffline);
  document.addEventListener("visibilitychange", handleResume);

  void loadLastSuccessfulSync();
  void probeApi().finally(schedule);

  stopConnectivityMonitor = () => {
    window.removeEventListener("online", handleOnline);
    window.removeEventListener("offline", handleOffline);
    document.removeEventListener("visibilitychange", handleResume);
    if (timer) clearTimeout(timer);
    timer = null;
    started = false;
  };
  return stopConnectivityMonitor;
}

export let stopConnectivityMonitor: () => void = () => undefined;

/** Test helper: resets the module between test cases. */
export function resetConnectivityForTests(): void {
  stopConnectivityMonitor();
  listeners.clear();
  reconnectHandlers.clear();
  state = {
    browserOnline: typeof navigator === "undefined" ? true : navigator.onLine,
    apiReachable: null,
    checking: false,
    lastHealthCheckAt: null,
    lastHealthError: null,
    lastSuccessfulSyncAt: null,
  };
}
