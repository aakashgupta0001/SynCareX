import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../database/db";
import { api, ApiError, type ClinicKeyStatusResponse } from "../services/api";
import {
  forgetClinicKey,
  isClinicKeyAvailable,
  lockClinicKey,
  openFromServer,
  sealForServer,
  serverIndexTerms,
  unlockClinicKey,
} from "../security/clinicKey";
import { resetWorkspace, setOnline, testUser } from "./helpers";

const PASSPHRASE = "clinic-key-test-passphrase";

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Builds the wrapped blob a device would have cached, so the offline unlock
 * path can be exercised without a server.
 */
async function seedCachedKey(passphrase = PASSPHRASE) {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  const kek = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 310_000, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  const wrapped = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, kek, raw);
  await db.clinicKeys.put({
    id: "current",
    clinicId: "clinic-1",
    keyEpoch: 1,
    wrappedKey: toBase64(new Uint8Array(wrapped)),
    wrapIv: toBase64(iv),
    kdfSalt: toBase64(salt),
    kdfIterations: 310_000,
    cachedAt: new Date().toISOString(),
  });
  return raw;
}

async function unlockOffline(passphrase = PASSPHRASE) {
  return unlockClinicKey(passphrase, {
    online: false,
    clinicId: "clinic-1",
    userId: testUser.id,
  });
}

describe("clinic data key", () => {
  beforeEach(async () => {
    setOnline(false);
    await resetWorkspace();
    await forgetClinicKey();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockNoWrapForThisUser() {
    vi.spyOn(api, "getClinicKeyWrap").mockRejectedValue(
      new ApiError("No clinic key is wrapped for this account.", 404),
    );
  }

  function mockClinicStatus(overrides: Partial<ClinicKeyStatusResponse> = {}) {
    return vi.spyOn(api, "getClinicKeyStatus").mockResolvedValue({
      clinic_id: "clinic-1",
      key_epoch: null,
      wrapped_for_this_user: false,
      user_count_with_access: 0,
      records_encrypted: false,
      ...overrides,
    });
  }

  async function unlockOnline() {
    return unlockClinicKey(PASSPHRASE, {
      online: true,
      clinicId: "clinic-1",
      userId: testUser.id,
    });
  }

  it("waits instead of minting a second key when the clinic already has one", async () => {
    mockNoWrapForThisUser();
    mockClinicStatus({
      key_epoch: 1,
      wrapped_for_this_user: false,
      user_count_with_access: 1,
    });
    const publish = vi.spyOn(api, "publishClinicKeyWraps");

    const result = await unlockOnline();

    // A second key would fork the clinic's records and search hashes across
    // two keys, so nothing is published and nothing is cached.
    expect(publish).not.toHaveBeenCalled();
    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/has not been shared with this account/i);
    expect(await db.clinicKeys.count()).toBe(0);
    expect(isClinicKeyAvailable()).toBe(false);
  });

  it("creates the key when the clinic has none", async () => {
    mockNoWrapForThisUser();
    mockClinicStatus();
    const publish = vi.spyOn(api, "publishClinicKeyWraps").mockResolvedValue({
      clinic_id: "clinic-1",
      key_epoch: 1,
      wrapped_for_this_user: true,
      user_count_with_access: 1,
      records_encrypted: false,
    });

    const result = await unlockOnline();

    expect(result.available).toBe(true);
    expect(result.reason).toBeNull();
    expect(publish).toHaveBeenCalledTimes(1);
    const [wraps] = publish.mock.calls[0];
    expect(wraps).toHaveLength(1);
    expect(wraps[0]).toMatchObject({
      user_id: testUser.id,
      key_epoch: 1,
      kdf_iterations: 310_000,
    });
    expect(isClinicKeyAvailable()).toBe(true);
  });

  it("treats a publish rejected by the server guard as waiting, and caches nothing", async () => {
    mockNoWrapForThisUser();
    // Status unreadable, so the decision falls to the server's guard, which
    // rejects the publish because the clinic already has a key.
    vi.spyOn(api, "getClinicKeyStatus").mockRejectedValue(
      new ApiError("Request failed (500)", 500),
    );
    vi.spyOn(api, "publishClinicKeyWraps").mockRejectedValue(
      new ApiError(
        "This clinic already has an encryption key. A user who holds it must share it with you.",
        409,
      ),
    );

    const result = await unlockOnline();

    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/has not been shared with this account/i);
    // The rejected key must not linger on the device as if it were real.
    expect(await db.clinicKeys.count()).toBe(0);
    expect(isClinicKeyAvailable()).toBe(false);
  });

  it("does nothing when no key is available, so dual-write stays optional", async () => {
    expect(isClinicKeyAvailable()).toBe(false);
    // A device with no clinic key must still synchronize: sealing is a no-op
    // rather than an error.
    expect(await sealForServer({ fullName: "Synthetic Patient" })).toBeNull();
    expect(await serverIndexTerms(["abc"])).toEqual([]);

    const result = await unlockOffline();
    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/No clinic key is available/i);
  });

  it("unwraps a cached key and round-trips content", async () => {
    await seedCachedKey();
    const unlocked = await unlockOffline();
    expect(unlocked.available).toBe(true);
    expect(isClinicKeyAvailable()).toBe(true);

    const sealed = await sealForServer({ fullName: "Amara Synthetic", age: 32 });
    expect(sealed).not.toBeNull();
    expect(sealed!.keyEpoch).toBe(1);
    // The envelope must not contain the content.
    expect(JSON.stringify(sealed)).not.toContain("Amara");

    const opened = await openFromServer<{ fullName: string; age: number }>(sealed!);
    expect(opened).toEqual({ fullName: "Amara Synthetic", age: 32 });
  });

  it("refuses to unwrap with the wrong passphrase", async () => {
    await seedCachedKey();
    const wrong = await unlockOffline("not-the-right-passphrase");
    expect(wrong.available).toBe(false);
    expect(wrong.reason).toMatch(/could not be opened/i);
    expect(isClinicKeyAvailable()).toBe(false);
    // The cached blob survives; only the attempt failed.
    expect(await db.clinicKeys.count()).toBe(1);
  });

  it("stores the key wrapped, so the cached row is useless on its own", async () => {
    const raw = await seedCachedKey();
    const row = await db.clinicKeys.get("current");
    expect(row).toBeDefined();
    expect(row!.wrappedKey).not.toBe(toBase64(raw));
    expect(row!.kdfIterations).toBeGreaterThanOrEqual(310_000);
  });

  it("produces url-safe index hashes", async () => {
    await seedCachedKey();
    await unlockOffline();
    const terms = await serverIndexTerms(["riverbend", "amara", "hilltop", "a b c"]);
    expect(terms).toHaveLength(4);
    for (const term of terms) {
      // A "+" from standard base64 is decoded as a space in a query string.
      expect(term).toMatch(/^[A-Za-z0-9_-]+$/);
    }
    // Deterministic for the same key, which is what lets the server match.
    expect(await serverIndexTerms(["riverbend"])).toEqual([terms[0]]);
  });

  it("gives different clinics different hashes for the same term", async () => {
    await seedCachedKey();
    await unlockOffline();
    const first = await serverIndexTerms(["riverbend"]);

    await forgetClinicKey();
    await seedCachedKey();
    await unlockOffline();
    const second = await serverIndexTerms(["riverbend"]);

    // Different key, different hash: one clinic's index cannot be used to
    // probe another's.
    expect(first[0]).not.toBe(second[0]);
  });

  it("locking clears the key from memory", async () => {
    await seedCachedKey();
    await unlockOffline();
    expect(isClinicKeyAvailable()).toBe(true);

    lockClinicKey();
    expect(isClinicKeyAvailable()).toBe(false);
    expect(await sealForServer({ any: "thing" })).toBeNull();
    // The wrapped copy stays, so the next unlock does not need the server.
    expect(await db.clinicKeys.count()).toBe(1);
  });
});
