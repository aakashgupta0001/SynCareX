import { db } from "../database/db";
import type { LocalDevice } from "../database/types";

const DEVICE_ID_KEY = "device_id";

/** Stable per-browser identifier. Not a credential and not an authorization. */
export async function getLocalDeviceId(): Promise<string> {
  const existing = await db.localSettings.get(DEVICE_ID_KEY);
  if (existing) return existing.value;
  const value = crypto.randomUUID();
  await db.localSettings.put({
    key: DEVICE_ID_KEY,
    value,
    updatedAt: new Date().toISOString(),
  });
  return value;
}

export async function getLocalSetting(key: string): Promise<string | null> {
  return (await db.localSettings.get(key))?.value ?? null;
}

export async function setLocalSetting(key: string, value: string): Promise<void> {
  await db.localSettings.put({ key, value, updatedAt: new Date().toISOString() });
}

export async function getDeviceRecord(): Promise<LocalDevice> {
  const deviceId = await getLocalDeviceId();
  const existing = await db.devices.where("deviceId").equals(deviceId).first();
  if (existing) return existing;
  const now = new Date().toISOString();
  const record: LocalDevice = {
    id: crypto.randomUUID(),
    deviceId,
    label: deviceLabel(),
    provisionedAt: null,
    provisionedBy: null,
    serverDeviceId: null,
    status: "unprovisioned",
    offlineGraceDays: 7,
    lastServerContactAt: null,
    createdAt: now,
    updatedAt: now,
  };
  await db.devices.put(record);
  return record;
}

/**
 * Records that the server has authorized this browser for offline clinical
 * work, together with the offline grace period it granted.
 */
export async function markDeviceAuthorized(options: {
  serverDeviceId: string | null;
  actorId: string;
  offlineGraceDays: number;
}): Promise<LocalDevice> {
  const record = await getDeviceRecord();
  const now = new Date().toISOString();
  const updated: LocalDevice = {
    ...record,
    provisionedAt: record.provisionedAt ?? now,
    provisionedBy: options.actorId,
    serverDeviceId: options.serverDeviceId,
    status: "authorized",
    offlineGraceDays: options.offlineGraceDays,
    lastServerContactAt: now,
    updatedAt: now,
  };
  await db.devices.put(updated);
  return updated;
}

export async function recordServerContact(): Promise<void> {
  const record = await getDeviceRecord();
  const now = new Date().toISOString();
  await db.devices.update(record.id, { lastServerContactAt: now, updatedAt: now });
}

function deviceLabel(): string {
  if (typeof navigator === "undefined") return "Unknown device";
  const agent = navigator.userAgent;
  if (/Android/i.test(agent)) return "Android browser";
  if (/iPhone|iPad/i.test(agent)) return "iOS browser";
  if (/Windows/i.test(agent)) return "Windows browser";
  if (/Mac OS X/i.test(agent)) return "macOS browser";
  if (/Linux/i.test(agent)) return "Linux browser";
  return "Browser";
}
