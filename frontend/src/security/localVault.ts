import type { CipherEnvelope, LocalUser } from "../database/types";
import { db } from "../database/db";

const ITERATIONS = 310_000;
const VERIFIER = "SynCareX encrypted local vault v1";

/**
 * How long a device may be used without reaching the server again. Offline
 * work is a continuation of a server-authenticated session, not a bypass.
 */
export const DEFAULT_OFFLINE_GRACE_DAYS = 7;

export interface VaultIdentity {
  userId: string;
  email: string;
  fullName: string;
  roles: string[];
  permissions: string[];
  offlineSessionExpiresAt: string | null;
  lastOnlineAuthAt: string | null;
}

export class OfflineSessionExpiredError extends Error {
  constructor(readonly expiredAt: string) {
    super(
      "This device's offline session has expired. Reconnect and sign in to the server to continue. Records already saved on this device are preserved.",
    );
    this.name = "OfflineSessionExpiredError";
  }
}

let unlockedKey: CryptoKey | null = null;
let unlockedIndexKey: CryptoKey | null = null;
let unlockedIdentity: VaultIdentity | null = null;
const lockListeners = new Set<() => void>();

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

/** Separates the index key from the record key under the same password. */
const INDEX_KEY_DOMAIN = new TextEncoder().encode("syncarex/search-index/v1");

async function passwordMaterial(password: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey", "deriveBits"],
  );
}

async function deriveKey(
  password: string,
  salt: Uint8Array,
  iterations = ITERATIONS,
): Promise<CryptoKey> {
  const material = await passwordMaterial(password);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as unknown as BufferSource, iterations, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * HMAC key for the blind search index. It uses the stored salt with a domain
 * suffix appended, so it is a different key from the record key even though
 * both come from the same passphrase, and it can only sign, never decrypt.
 */
async function deriveIndexKey(
  password: string,
  salt: Uint8Array,
  iterations = ITERATIONS,
): Promise<CryptoKey> {
  const indexSalt = new Uint8Array(salt.length + INDEX_KEY_DOMAIN.length);
  indexSalt.set(salt, 0);
  indexSalt.set(INDEX_KEY_DOMAIN, salt.length);
  const material = await passwordMaterial(password);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: indexSalt as unknown as BufferSource, iterations, hash: "SHA-256" },
    material,
    256,
  );
  return crypto.subtle.importKey("raw", bits, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
}

async function encryptWithKey(key: CryptoKey, value: unknown): Promise<CipherEnvelope> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return {
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  };
}

async function decryptWithKey<T>(key: CryptoKey, envelope: CipherEnvelope): Promise<T> {
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(envelope.iv) as unknown as BufferSource },
    key,
    base64ToBytes(envelope.ciphertext) as unknown as BufferSource,
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}

function identityFromUser(user: LocalUser): VaultIdentity {
  return {
    userId: user.userId,
    email: user.email,
    fullName: user.fullName,
    roles: user.roles,
    permissions: user.permissions,
    offlineSessionExpiresAt: user.offlineSessionExpiresAt,
    lastOnlineAuthAt: user.lastOnlineAuthAt,
  };
}

function addDays(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Called after a successful server sign-in. Provisions the local vault the
 * first time and refreshes the offline session window afterwards.
 */
export async function initializeOrUnlockVault(
  user: {
    id: string;
    email: string;
    fullName: string;
    roles: string[];
    permissions?: string[];
  },
  password: string,
  options: { offlineGraceDays?: number } = {},
): Promise<VaultIdentity> {
  const graceDays = options.offlineGraceDays ?? DEFAULT_OFFLINE_GRACE_DAYS;
  const email = user.email.trim().toLowerCase();
  const id = `user:${email}`;
  const now = new Date().toISOString();
  const existing = await db.localUsers.get(id);

  if (existing) {
    const salt = base64ToBytes(existing.salt);
    const key = await deriveKey(password, salt, existing.iterations);
    const indexKey = await deriveIndexKey(password, salt, existing.iterations);
    try {
      const marker = await decryptWithKey<string>(key, {
        iv: existing.iv,
        ciphertext: existing.verifier,
      });
      if (marker !== VERIFIER) throw new Error("Vault verification failed");
    } catch {
      throw new Error(
        "The local vault could not be unlocked with these credentials. Existing offline records were preserved.",
      );
    }
    const refreshed: LocalUser = {
      ...existing,
      userId: user.id,
      fullName: user.fullName,
      roles: user.roles,
      permissions: user.permissions ?? existing.permissions,
      deviceAuthorizedAt: existing.deviceAuthorizedAt ?? now,
      lastOnlineAuthAt: now,
      offlineSessionExpiresAt: addDays(graceDays),
      updatedAt: now,
    };
    await db.localUsers.put(refreshed);
    unlockedKey = key;
    unlockedIndexKey = indexKey;
    unlockedIdentity = identityFromUser(refreshed);
    return unlockedIdentity;
  }

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(password, salt);
  const indexKey = await deriveIndexKey(password, salt);
  const verifier = await encryptWithKey(key, VERIFIER);
  const localUser: LocalUser = {
    id,
    email,
    userId: user.id,
    fullName: user.fullName,
    roles: user.roles,
    permissions: user.permissions ?? [],
    salt: bytesToBase64(salt),
    iv: verifier.iv,
    verifier: verifier.ciphertext,
    iterations: ITERATIONS,
    deviceAuthorizedAt: now,
    lastOnlineAuthAt: now,
    offlineSessionExpiresAt: addDays(graceDays),
    createdAt: now,
    updatedAt: now,
  };
  await db.localUsers.put(localUser);
  unlockedKey = key;
  unlockedIndexKey = indexKey;
  unlockedIdentity = identityFromUser(localUser);
  return unlockedIdentity;
}

/**
 * Offline unlock for a device that has already been provisioned online. The
 * offline session window is enforced here; it is never extended offline.
 */
export async function unlockLocalVault(
  emailInput: string,
  password: string,
): Promise<VaultIdentity> {
  const email = emailInput.trim().toLowerCase();
  const localUser = await db.localUsers.where("email").equals(email).first();
  if (!localUser) {
    throw new Error(
      "No local account is provisioned for this device. Connect to the network and sign in once to authorize offline access.",
    );
  }
  if (
    localUser.offlineSessionExpiresAt &&
    Date.parse(localUser.offlineSessionExpiresAt) <= Date.now()
  ) {
    throw new OfflineSessionExpiredError(localUser.offlineSessionExpiresAt);
  }
  const unlockSalt = base64ToBytes(localUser.salt);
  const key = await deriveKey(password, unlockSalt, localUser.iterations);
  const unlockIndexKey = await deriveIndexKey(password, unlockSalt, localUser.iterations);
  try {
    const marker = await decryptWithKey<string>(key, {
      iv: localUser.iv,
      ciphertext: localUser.verifier,
    });
    if (marker !== VERIFIER) throw new Error("Vault verification failed");
  } catch {
    throw new Error("Unable to unlock the local vault. Check the email and password.");
  }
  unlockedKey = key;
  unlockedIndexKey = unlockIndexKey;
  unlockedIdentity = identityFromUser(localUser);
  return unlockedIdentity;
}

export function getUnlockedIdentity(): VaultIdentity | null {
  return unlockedIdentity;
}

export function requireUnlockedIdentity(action = "work with offline records"): VaultIdentity {
  if (!unlockedIdentity || !unlockedKey) {
    throw new Error(`Unlock the local vault before attempting to ${action}.`);
  }
  return unlockedIdentity;
}

export function isVaultUnlocked(): boolean {
  return unlockedKey !== null;
}

/** Drops the in-memory key. Stored records stay encrypted and untouched. */
export function lockLocalVault(): void {
  unlockedKey = null;
  unlockedIndexKey = null;
  unlockedIdentity = null;
  for (const listener of lockListeners) listener();
}

export function onVaultLocked(listener: () => void): () => void {
  lockListeners.add(listener);
  return () => lockListeners.delete(listener);
}

/** Forgets this device's provisioning for one account, after explicit logout. */
export async function invalidateLocalSession(email: string): Promise<void> {
  const normalized = email.trim().toLowerCase();
  const localUser = await db.localUsers.where("email").equals(normalized).first();
  if (localUser) {
    await db.localUsers.update(localUser.id, {
      offlineSessionExpiresAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }
  lockLocalVault();
}

export async function getProvisionedUser(email: string): Promise<LocalUser | undefined> {
  return db.localUsers.where("email").equals(email.trim().toLowerCase()).first();
}

export async function encryptLocalValue(value: unknown): Promise<CipherEnvelope> {
  if (!unlockedKey) {
    throw new Error("Unlock the local vault before accessing offline records.");
  }
  return encryptWithKey(unlockedKey, value);
}

export async function decryptLocalValue<T>(envelope: CipherEnvelope): Promise<T> {
  if (!unlockedKey) {
    throw new Error("Unlock the local vault before accessing offline records.");
  }
  return decryptWithKey<T>(unlockedKey, envelope);
}

/** Encrypts raw file bytes for the document store. */
export async function encryptLocalBytes(
  bytes: ArrayBuffer,
): Promise<{ iv: string; ciphertext: ArrayBuffer }> {
  if (!unlockedKey) {
    throw new Error("Unlock the local vault before storing documents.");
  }
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    unlockedKey,
    bytes,
  );
  return { iv: bytesToBase64(iv), ciphertext };
}

export async function decryptLocalBytes(
  iv: string,
  ciphertext: ArrayBuffer,
): Promise<ArrayBuffer> {
  if (!unlockedKey) {
    throw new Error("Unlock the local vault before opening documents.");
  }
  return crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(iv) as unknown as BufferSource },
    unlockedKey,
    ciphertext,
  );
}

export { bytesToBase64, base64ToBytes };

/**
 * Keyed hash of one search term for the blind index.
 *
 * Truncated to 96 bits: a collision only adds a candidate that the exact
 * match check then discards, so it costs a little work and never changes a
 * result. Without the key these hashes cannot be computed or reversed, so the
 * stored index reveals no patient text.
 */
export async function blindIndexTerm(term: string): Promise<string> {
  if (!unlockedIndexKey) {
    throw new Error("Unlock the local vault before using the search index.");
  }
  const signature = await crypto.subtle.sign(
    "HMAC",
    unlockedIndexKey,
    new TextEncoder().encode(term),
  );
  return bytesToBase64(new Uint8Array(signature).slice(0, 12));
}

export async function blindIndexTerms(terms: Iterable<string>): Promise<string[]> {
  return Promise.all([...terms].map((term) => blindIndexTerm(term)));
}

