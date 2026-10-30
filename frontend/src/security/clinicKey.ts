import { db } from "../database/db";
import { api, ApiError } from "../services/api";
import { base64ToBytes, bytesToBase64 } from "./localVault";

/**
 * Client side of the clinic data key.
 *
 * The clinic key encrypts clinical content for the server, which stores
 * ciphertext it cannot read. It is wrapped with a key derived from the
 * clinician's passphrase, so the passphrase is the only thing that opens it,
 * and the server only ever holds the wrapped blob.
 *
 * This is deliberately separate from the vault key in `localVault.ts`. The
 * vault key protects records *on this device*; the clinic key protects
 * records *on the server* and is shared across a clinic's devices. Keeping
 * them apart means a device compromise and a server compromise stay distinct
 * problems.
 *
 * See docs/security/E2E_ENCRYPTION_DESIGN.md. While dual-write is in effect
 * the server still stores plaintext too, so this does not yet make records
 * unreadable to the operator.
 */

const WRAP_ITERATIONS = 310_000;
const CACHE_ID = "current";

let clinicKey: CryptoKey | null = null;
let clinicKeyEpoch: number | null = null;

export interface CachedClinicKey {
  id: string;
  clinicId: string;
  keyEpoch: number;
  wrappedKey: string;
  wrapIv: string;
  kdfSalt: string;
  kdfIterations: number;
  cachedAt: string;
}

async function wrappingKey(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as unknown as BufferSource, iterations, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Unwraps a cached blob into an in-memory key. */
async function unwrap(cached: CachedClinicKey, password: string): Promise<CryptoKey> {
  const kek = await wrappingKey(
    password,
    base64ToBytes(cached.kdfSalt),
    cached.kdfIterations,
  );
  const raw = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(cached.wrapIv) as unknown as BufferSource },
    kek,
    base64ToBytes(cached.wrappedKey) as unknown as BufferSource,
  );
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
}

async function cache(entry: CachedClinicKey): Promise<void> {
  await db.clinicKeys.put(entry);
}

export async function getCachedClinicKey(): Promise<CachedClinicKey | undefined> {
  return db.clinicKeys.get(CACHE_ID);
}

/**
 * Makes the clinic key available for this session.
 *
 * Online: fetches this user's wrap, caches it, and unwraps it. If the clinic
 * has no key and the account may publish one, a key is generated here and
 * published wrapped for this user.
 *
 * Offline: unwraps the blob cached on the device, so synchronization still
 * works after an offline unlock.
 *
 * A failure is never fatal to signing in. Dual-write means plaintext remains
 * authoritative, so a clinician without the key keeps working.
 */
export async function unlockClinicKey(
  password: string,
  options: { online: boolean; clinicId: string; userId: string },
): Promise<{ available: boolean; reason: string | null }> {
  if (options.online) {
    try {
      const remote = await api.getClinicKeyWrap();
      await cache({
        id: CACHE_ID,
        clinicId: remote.clinic_id,
        keyEpoch: remote.key_epoch,
        wrappedKey: remote.wrapped_key,
        wrapIv: remote.wrap_iv,
        kdfSalt: remote.kdf_salt,
        kdfIterations: remote.kdf_iterations,
        cachedAt: new Date().toISOString(),
      });
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        const created = await publishNewClinicKey(password, options.userId);
        if (!created.published) return { available: false, reason: created.reason };
      } else if (error instanceof ApiError && error.status === 0) {
        // Unreachable server: fall through to whatever is cached.
      } else {
        return {
          available: false,
          reason:
            error instanceof Error ? error.message : "The clinic key could not be fetched.",
        };
      }
    }
  }

  const cached = await getCachedClinicKey();
  if (!cached) {
    return {
      available: false,
      reason:
        "No clinic key is available on this device yet. Records are still synchronized; server-side encryption is not active for this account.",
    };
  }
  try {
    clinicKey = await unwrap(cached, password);
    clinicKeyEpoch = cached.keyEpoch;
    return { available: true, reason: null };
  } catch {
    clinicKey = null;
    clinicKeyEpoch = null;
    return {
      available: false,
      reason:
        "The clinic key on this device could not be opened with this passphrase.",
    };
  }
}

/** Generates a clinic key and publishes it wrapped for the current user. */
async function publishNewClinicKey(
  password: string,
  userId: string,
): Promise<{ published: boolean; reason: string | null }> {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const kek = await wrappingKey(password, salt, WRAP_ITERATIONS);
  const wrapped = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    kek,
    raw as unknown as BufferSource,
  );

  try {
    const status = await api.publishClinicKeyWraps([
      {
        user_id: userId,
        key_epoch: 1,
        wrapped_key: bytesToBase64(new Uint8Array(wrapped)),
        wrap_iv: bytesToBase64(iv),
        kdf_salt: bytesToBase64(salt),
        kdf_iterations: WRAP_ITERATIONS,
      },
    ]);
    await cache({
      id: CACHE_ID,
      clinicId: status.clinic_id,
      keyEpoch: status.key_epoch ?? 1,
      wrappedKey: bytesToBase64(new Uint8Array(wrapped)),
      wrapIv: bytesToBase64(iv),
      kdfSalt: bytesToBase64(salt),
      kdfIterations: WRAP_ITERATIONS,
      cachedAt: new Date().toISOString(),
    });
    return { published: true, reason: null };
  } catch (error) {
    // A clinician without permission to publish is a normal situation, not a
    // failure: an administrator's device creates the key.
    const reason =
      error instanceof ApiError && error.status === 403
        ? "This clinic has no encryption key yet, and this account may not create one. An administrator must sign in once."
        : error instanceof Error
          ? error.message
          : "The clinic key could not be published.";
    return { published: false, reason };
  }
}

export function isClinicKeyAvailable(): boolean {
  return clinicKey !== null;
}

export function currentKeyEpoch(): number | null {
  return clinicKeyEpoch;
}

export function lockClinicKey(): void {
  clinicKey = null;
  clinicKeyEpoch = null;
}

export interface SealedContent {
  ciphertext: string;
  iv: string;
  keyEpoch: number;
}

/** Encrypts content for the server. Returns null when no key is available. */
export async function sealForServer(value: unknown): Promise<SealedContent | null> {
  if (!clinicKey || clinicKeyEpoch === null) return null;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    clinicKey,
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return {
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
    iv: bytesToBase64(iv),
    keyEpoch: clinicKeyEpoch,
  };
}

export async function openFromServer<T>(sealed: SealedContent): Promise<T | null> {
  if (!clinicKey) return null;
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64ToBytes(sealed.iv) as unknown as BufferSource },
      clinicKey,
      base64ToBytes(sealed.ciphertext) as unknown as BufferSource,
    );
    return JSON.parse(new TextDecoder().decode(plaintext)) as T;
  } catch {
    return null;
  }
}

/**
 * HMAC key for the **server-side** blind index, derived from the clinic key
 * so every device in the clinic produces the same hashes. It is separate
 * from the device-local index key, which is derived from the passphrase and
 * is private to one account.
 */
export async function serverIndexKey(): Promise<CryptoKey | null> {
  if (!clinicKey) return null;
  const raw = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: new Uint8Array(12) as unknown as BufferSource },
    clinicKey,
    new TextEncoder().encode("syncarex/server-search-index/v1"),
  );
  return crypto.subtle.importKey(
    "raw",
    raw.slice(0, 32),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

export async function serverIndexTerms(terms: Iterable<string>): Promise<string[]> {
  const key = await serverIndexKey();
  if (!key) return [];
  const hashes: string[] = [];
  for (const term of terms) {
    const signature = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(term),
    );
    // base64url: these hashes travel in a query string, where "+" would be
    // decoded as a space and silently break the match.
    hashes.push(
      bytesToBase64(new Uint8Array(signature).slice(0, 12))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, ""),
    );
  }
  return hashes;
}

/** Test helper: clears the cached blob as a device wipe would. */
export async function forgetClinicKey(): Promise<void> {
  lockClinicKey();
  await db.clinicKeys.clear();
}
