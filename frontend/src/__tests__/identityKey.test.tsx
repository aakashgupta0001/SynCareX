import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import App from "../App";
import { db } from "../database/db";
import { api, type ClinicKeyWrapResponse, type ClinicMemberResponse } from "../services/api";
import { AuthProvider } from "../services/auth";
import {
  ensureIdentityKey,
  generateIdentityKeyPair,
  resetIdentityKeyCacheForTests,
  unwrapIdentityWrap,
  unwrapIdentityWrapRaw,
  wrapForRecipient,
  wrapRawKeyForRecipient,
} from "../security/identityKey";
import {
  forgetClinicKey,
  isClinicKeyAvailable,
  lockClinicKey,
  openFromServer,
  sealForServer,
  unlockClinicKey,
} from "../security/clinicKey";
import { lockLocalVault } from "../security/localVault";
import {
  restartBrowser,
  resetWorkspace,
  setOnline,
  testPassword,
  testUser,
} from "./helpers";

const PASSPHRASE = "identity-key-test-passphrase";

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function exportPublicJwk(pair: CryptoKeyPair): Promise<string> {
  return JSON.stringify(await crypto.subtle.exportKey("jwk", pair.publicKey));
}

async function exportPrivateJwk(pair: CryptoKeyPair): Promise<string> {
  return JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey));
}

/** Builds the server-shaped identity wrap a holder would have published. */
async function makeIdentityWrapResponse(
  raw: Uint8Array,
  recipientPublicKeyJwk: string,
): Promise<ClinicKeyWrapResponse> {
  const wrap = await wrapRawKeyForRecipient(raw, recipientPublicKeyJwk);
  return {
    clinic_id: "clinic-1",
    user_id: testUser.id,
    key_epoch: 1,
    wrapped_key: wrap.wrapped_key,
    wrap_iv: wrap.wrap_iv,
    kdf_salt: "",
    kdf_iterations: 0,
    wrap_type: "identity",
    ephemeral_public_key: wrap.ephemeral_public_key,
    created_at: new Date().toISOString(),
  };
}

/**
 * Seeds a passphrase-sealed clinic key so the share flow has a key to give
 * (the clinic key itself is still distributed the old way to the first
 * holder).
 */
async function seedPassphraseCachedKey(
  raw: Uint8Array,
  passphrase = PASSPHRASE,
): Promise<void> {
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
  const wrapped = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    kek,
    raw as unknown as BufferSource,
  );
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
}

describe("identity keypairs and clinic key sharing", () => {
  beforeEach(async () => {
    setOnline(false);
    resetIdentityKeyCacheForTests();
    await resetWorkspace();
    await forgetClinicKey();
  });

  afterEach(() => {
    cleanup();
    lockClinicKey();
    lockLocalVault();
    vi.restoreAllMocks();
  });

  it("round-trips raw bytes between two identity keypairs", async () => {
    vi.spyOn(api, "publishIdentityKey").mockResolvedValue(undefined);
    const { publicKeyJwk } = await ensureIdentityKey();
    expect(publicKeyJwk).toContain("P-256");

    const recipient = await generateIdentityKeyPair();
    const recipientPublicJwk = await exportPublicJwk(recipient);
    const clinicRaw = crypto.getRandomValues(new Uint8Array(32));

    // No clinic key is unlocked yet, so the production entry point declines.
    expect(await wrapForRecipient(recipientPublicJwk)).toBeNull();

    const wrap = await wrapRawKeyForRecipient(clinicRaw, recipientPublicJwk);
    expect(wrap.ephemeral_public_key).toContain("P-256");
    expect(JSON.parse(wrap.ephemeral_public_key).kty).toBe("EC");

    const openedRaw = await unwrapIdentityWrapRaw(
      wrap,
      await exportPrivateJwk(recipient),
    );
    expect(Array.from(openedRaw!)).toEqual(Array.from(clinicRaw));

    // A wrap for a different key opens to nothing.
    const stranger = await generateIdentityKeyPair();
    expect(
      await unwrapIdentityWrapRaw(wrap, await exportPrivateJwk(stranger)),
    ).toBeNull();

    // The convenience import yields a working AES-GCM key.
    const key = await unwrapIdentityWrap(wrap, await exportPrivateJwk(recipient));
    expect(key).not.toBeNull();
    const probeIv = crypto.getRandomValues(new Uint8Array(12));
    const probeKey = await crypto.subtle.importKey(
      "raw",
      clinicRaw,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt"],
    );
    const probe = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: probeIv },
      probeKey,
      new TextEncoder().encode("probe"),
    );
    const opened = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: probeIv },
      key!,
      probe,
    );
    expect(new TextDecoder().decode(opened)).toBe("probe");
  });

  it("stores the private JWK encrypted and reuses it without republishing", async () => {
    const publish = vi.spyOn(api, "publishIdentityKey").mockResolvedValue(undefined);
    const first = await ensureIdentityKey();

    // The stored setting is an encrypted envelope, not the raw JWK.
    const row = await db.localSettings.get(`identity-private-key:${testUser.id}`);
    expect(row).toBeDefined();
    expect(row!.value).not.toContain('"d"');
    expect(row!.value).not.toContain(first.publicKeyJwk);

    await restartBrowser();
    resetIdentityKeyCacheForTests();
    const second = await ensureIdentityKey();
    expect(second.publicKeyJwk).toBe(first.publicKeyJwk);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("unlocks an identity wrap online and again offline from the cache", async () => {
    vi.spyOn(api, "publishIdentityKey").mockResolvedValue(undefined);
    const { publicKeyJwk } = await ensureIdentityKey();

    const raw = crypto.getRandomValues(new Uint8Array(32));
    vi.spyOn(api, "getClinicKeyWrap").mockResolvedValue(
      await makeIdentityWrapResponse(raw, publicKeyJwk),
    );

    const result = await unlockClinicKey(PASSPHRASE, {
      online: true,
      clinicId: "clinic-1",
      userId: testUser.id,
    });
    expect(result.available).toBe(true);
    expect(result.reason).toBeNull();
    expect(isClinicKeyAvailable()).toBe(true);

    const sealed = await sealForServer({ note: "identity sealed" });
    expect(sealed).not.toBeNull();
    expect(await openFromServer(sealed!)).toEqual({ note: "identity sealed" });

    // The cached row keeps the identity wrap metadata so the offline path
    // never needs the server.
    const row = await db.clinicKeys.get("current");
    expect(row?.wrapType).toBe("identity");
    expect(row?.ephemeralPublicKey).toContain("P-256");

    await restartBrowser();
    const offline = await unlockClinicKey(PASSPHRASE, {
      online: false,
      clinicId: "clinic-1",
      userId: testUser.id,
    });
    expect(offline.available).toBe(true);
    expect(await openFromServer(sealed!)).toEqual({ note: "identity sealed" });
  });

  it("fails cleanly without caching when no identity key is stored", async () => {
    const stranger = await generateIdentityKeyPair();
    const raw = crypto.getRandomValues(new Uint8Array(32));
    vi.spyOn(api, "getClinicKeyWrap").mockResolvedValue(
      await makeIdentityWrapResponse(raw, await exportPublicJwk(stranger)),
    );

    const result = await unlockClinicKey(PASSPHRASE, {
      online: true,
      clinicId: "clinic-1",
      userId: testUser.id,
    });
    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/identity key/i);
    expect(await db.clinicKeys.count()).toBe(0);
    expect(isClinicKeyAvailable()).toBe(false);
    expect(await sealForServer({ any: "thing" })).toBeNull();
  });

  it("fails cleanly without caching when the wrap does not match the stored identity key", async () => {
    vi.spyOn(api, "publishIdentityKey").mockResolvedValue(undefined);
    await ensureIdentityKey();

    const other = await generateIdentityKeyPair();
    const raw = crypto.getRandomValues(new Uint8Array(32));
    vi.spyOn(api, "getClinicKeyWrap").mockResolvedValue(
      await makeIdentityWrapResponse(raw, await exportPublicJwk(other)),
    );

    const result = await unlockClinicKey(PASSPHRASE, {
      online: true,
      clinicId: "clinic-1",
      userId: testUser.id,
    });
    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/identity key/i);
    expect(await db.clinicKeys.count()).toBe(0);
  });

  it("shares the clinic key from Settings as an identity wrap", async () => {
    await resetWorkspace();
    // Give the offline identity the users.manage permission.
    const localUser = await db.localUsers.get(`user:${testUser.email}`);
    await db.localUsers.update(localUser!.id, {
      permissions: [...testUser.permissions, "users.manage"],
    });
    lockLocalVault();

    // This device holds and has unlocked the clinic key. The cached wrap is
    // sealed with the vault passphrase, because that is what the App's
    // offline sign-in flow uses to unlock the clinic key.
    const raw = crypto.getRandomValues(new Uint8Array(32));
    await seedPassphraseCachedKey(raw, testPassword);
    const unlocked = await unlockClinicKey(testPassword, {
      online: false,
      clinicId: "clinic-1",
      userId: testUser.id,
    });
    expect(unlocked.available).toBe(true);

    const recipient = await generateIdentityKeyPair();
    const members: ClinicMemberResponse[] = [
      {
        id: "member-1",
        email: "nurse@example.test",
        full_name: "Nurse Recipient",
        holds_clinic_key: false,
        has_identity_key: true,
      },
      {
        id: "member-2",
        email: "senior@example.test",
        full_name: "Senior Holder",
        holds_clinic_key: true,
        has_identity_key: true,
      },
      {
        id: "member-3",
        email: "new@example.test",
        full_name: "New Recruit",
        holds_clinic_key: false,
        has_identity_key: false,
      },
    ];
    vi.spyOn(api, "getClinicMembers").mockResolvedValue(members);
    vi.spyOn(api, "getIdentityKey").mockResolvedValue({
      user_id: "member-1",
      public_key: await exportPublicJwk(recipient),
      created_at: new Date().toISOString(),
    });
    const publish = vi
      .spyOn(api, "publishClinicKeyWraps")
      .mockResolvedValue({
        clinic_id: "clinic-1",
        key_epoch: 1,
        wrapped_for_this_user: true,
        user_count_with_access: 2,
        records_encrypted: false,
      });

    render(
      <MemoryRouter initialEntries={["/login"]}>
        <AuthProvider>
          <App />
        </AuthProvider>
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByLabelText("Work email"), {
      target: { value: testUser.email },
    });
    fireEvent.change(screen.getByLabelText("Password / local vault passphrase"), {
      target: { value: testPassword },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /unlock local workspace/i }),
    );
    await screen.findByRole("heading", { name: "Good day" });

    fireEvent.click(screen.getByRole("link", { name: "Settings" }));
    await screen.findByRole("heading", { name: "Share clinic key" });

    // All members are listed with their status badges.
    expect(screen.getByText("Nurse Recipient")).toBeTruthy();
    expect(screen.getByText("Senior Holder")).toBeTruthy();
    expect(screen.getByText("New Recruit")).toBeTruthy();
    // Only a member with an identity key and no clinic key gets the button.
    const shareButtons = screen.getAllByRole("button", { name: /share key/i });
    expect(shareButtons).toHaveLength(1);

    fireEvent.click(shareButtons[0]);
    await screen.findByText(/Shared the clinic key with Nurse Recipient/i);

    expect(publish).toHaveBeenCalledTimes(1);
    const [wraps] = publish.mock.calls[0];
    expect(wraps).toHaveLength(1);
    expect(wraps[0]).toMatchObject({
      user_id: "member-1",
      key_epoch: 1,
      wrap_type: "identity",
    });
    expect(wraps[0].ephemeral_public_key).toContain("P-256");

    // The published wrap really opens, for the recipient, to the clinic key.
    const openedRaw = await unwrapIdentityWrapRaw(
      {
        wrapped_key: wraps[0].wrapped_key,
        wrap_iv: wraps[0].wrap_iv,
        ephemeral_public_key: wraps[0].ephemeral_public_key!,
      },
      await exportPrivateJwk(recipient),
    );
    expect(Array.from(openedRaw!)).toEqual(Array.from(raw));

    // Sharing again with the clinic key locked explains itself instead of
    // publishing nonsense.
    lockClinicKey();
    fireEvent.click(screen.getByRole("button", { name: /share key/i }));
    await screen.findByText(/clinic key is not unlocked/i);
    expect(publish).toHaveBeenCalledTimes(1);
  });
});
