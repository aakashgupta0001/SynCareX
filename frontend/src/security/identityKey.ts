import type { CipherEnvelope } from "../database/types";
import { db } from "../database/db";
import { api } from "../services/api";
import {
  base64ToBytes,
  bytesToBase64,
  decryptLocalValue,
  encryptLocalValue,
  getUnlockedIdentity,
  requireUnlockedIdentity,
} from "./localVault";
import { currentRawClinicKey } from "./clinicKey";

/**
 * Per-user identity keypair (client half).
 *
 * Every account owns a long-lived ECDH P-256 keypair. The private key never
 * leaves the device: it is stored in the local vault, encrypted under the
 * same key that protects offline records. The public key is published to the
 * server, which lets a clinic-key holder wrap the clinic key *for* another
 * user without ever learning that user's passphrase — closing the gap where
 * sharing required knowing (or resetting) the recipient's secret.
 *
 * See docs/security/E2E_ENCRYPTION_DESIGN.md and clinicKey.ts, which consumes
 * these wraps for the "identity" wrap type.
 */

/** A clinic key sealed to one recipient's identity key. */
export interface IdentityWrap {
  /** base64 AES-GCM ciphertext of the raw clinic key bytes. */
  wrapped_key: string;
  /** base64 12-byte IV for `wrapped_key`. */
  wrap_iv: string;
  /** JSON serialization of the ephemeral ECDH P-256 public JWK. */
  ephemeral_public_key: string;
}

const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;

// In-memory cache of the unlocked identity key. It is validated against the
// stored envelope on every load, so wiping the local database (a device
// reset, or a test's fresh workspace) is always respected.
let cachedPrivateKey: CryptoKey | null = null;
let cachedPublicKeyJwk: string | null = null;

function settingKeyFor(userId: string): string {
  return `identity-private-key:${userId}`;
}

/** Test-visible: generates a fresh extractable ECDH P-256 keypair. */
export function generateIdentityKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(ECDH, true, ["deriveKey", "deriveBits"]);
}

/** The public half of a private JWK: drop the private scalar fields. */
function publicJwkFromPrivate(privateJwk: JsonWebKey): JsonWebKey {
  return {
    kty: privateJwk.kty,
    crv: privateJwk.crv,
    x: privateJwk.x,
    y: privateJwk.y,
  };
}

async function importPrivateJwk(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey("jwk", jwk, ECDH, true, ["deriveKey"]);
}

async function importPublicJwk(jwkString: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "jwk",
    JSON.parse(jwkString) as JsonWebKey,
    ECDH,
    true,
    [],
  );
}

async function readStoredEnvelope(userId: string): Promise<CipherEnvelope | null> {
  const row = await db.localSettings.get(settingKeyFor(userId));
  if (!row) return null;
  try {
    return JSON.parse(row.value) as CipherEnvelope;
  } catch {
    return null;
  }
}

/**
 * Loads the stored identity key for the unlocked account, if one exists.
 * Returns null when the vault is locked, no key is stored, or the stored
 * envelope cannot be opened — callers treat that as "no identity key".
 */
async function loadIdentityKey(): Promise<{
  privateKey: CryptoKey;
  publicKeyJwk: string;
} | null> {
  const identity = getUnlockedIdentity();
  if (!identity) return null;
  const envelope = await readStoredEnvelope(identity.userId);
  if (!envelope) {
    cachedPrivateKey = null;
    cachedPublicKeyJwk = null;
    return null;
  }
  if (cachedPrivateKey && cachedPublicKeyJwk) {
    return { privateKey: cachedPrivateKey, publicKeyJwk: cachedPublicKeyJwk };
  }
  try {
    const privateJwk = await decryptLocalValue<JsonWebKey>(envelope);
    cachedPrivateKey = await importPrivateJwk(privateJwk);
    cachedPublicKeyJwk = JSON.stringify(publicJwkFromPrivate(privateJwk));
    return { privateKey: cachedPrivateKey, publicKeyJwk: cachedPublicKeyJwk };
  } catch {
    cachedPrivateKey = null;
    cachedPublicKeyJwk = null;
    return null;
  }
}

/**
 * Guarantees this account has an identity keypair: reuses the stored one, or
 * generates a new pair, stores the private JWK encrypted in the local vault,
 * and publishes the public JWK to the server.
 */
export async function ensureIdentityKey(): Promise<{ publicKeyJwk: string }> {
  const identity = requireUnlockedIdentity("publish an identity key");
  const existing = await loadIdentityKey();
  if (existing) return { publicKeyJwk: existing.publicKeyJwk };

  const pair = await generateIdentityKeyPair();
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const envelope = await encryptLocalValue(privateJwk);
  await db.localSettings.put({
    key: settingKeyFor(identity.userId),
    value: JSON.stringify(envelope),
    updatedAt: new Date().toISOString(),
  });
  // Project the public JWK the same way the stored-private-key path does, so
  // the published string is stable across generations of the same keypair.
  const publicJwk = JSON.stringify(publicJwkFromPrivate(privateJwk));
  await api.publishIdentityKey(publicJwk);
  cachedPrivateKey = pair.privateKey;
  cachedPublicKeyJwk = publicJwk;
  return { publicKeyJwk: cachedPublicKeyJwk };
}

/** Test helper: drops the in-memory identity key cache. */
export function resetIdentityKeyCacheForTests(): void {
  cachedPrivateKey = null;
  cachedPublicKeyJwk = null;
}

/**
 * Seals raw key bytes to a recipient's identity key with an ephemeral ECDH
 * pair. Exposed with explicit bytes so the round trip can be tested without
 * a clinic key unlocked; `wrapForRecipient` is the production entry point.
 */
export async function wrapRawKeyForRecipient(
  raw: Uint8Array,
  recipientPublicKeyJwk: string,
): Promise<IdentityWrap> {
  const recipientKey = await importPublicJwk(recipientPublicKeyJwk);
  const ephemeral = await generateIdentityKeyPair();
  const sealingKey = await crypto.subtle.deriveKey(
    { name: "ECDH", public: recipientKey },
    ephemeral.privateKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    sealingKey,
    raw as unknown as BufferSource,
  );
  const ephemeralJwk = await crypto.subtle.exportKey("jwk", ephemeral.publicKey);
  return {
    wrapped_key: bytesToBase64(new Uint8Array(ciphertext)),
    wrap_iv: bytesToBase64(iv),
    ephemeral_public_key: JSON.stringify(ephemeralJwk),
  };
}

/**
 * Wraps the CURRENT clinic key for a recipient. Returns null when no clinic
 * key is unlocked on this device.
 */
export async function wrapForRecipient(
  recipientPublicKeyJwk: string,
): Promise<IdentityWrap | null> {
  const raw = await currentRawClinicKey();
  if (!raw) return null;
  return wrapRawKeyForRecipient(raw, recipientPublicKeyJwk);
}

/**
 * Opens an identity wrap back to the raw key bytes. When `privateJwkOverride`
 * is given it is used instead of the stored identity key (test hook, and the
 * shape the recipient-side flow relies on); otherwise the unwrapping uses
 * this account's stored private key. Returns null on any failure.
 */
export async function unwrapIdentityWrapRaw(
  wrap: IdentityWrap,
  privateJwkOverride?: JsonWebKey | string,
): Promise<Uint8Array | null> {
  let privateKey: CryptoKey | null;
  if (privateJwkOverride !== undefined) {
    try {
      const jwk =
        typeof privateJwkOverride === "string"
          ? (JSON.parse(privateJwkOverride) as JsonWebKey)
          : privateJwkOverride;
      privateKey = await importPrivateJwk(jwk);
    } catch {
      return null;
    }
  } else {
    privateKey = (await loadIdentityKey())?.privateKey ?? null;
  }
  if (!privateKey) return null;
  try {
    const ephemeralPublic = await importPublicJwk(wrap.ephemeral_public_key);
    const sealingKey = await crypto.subtle.deriveKey(
      { name: "ECDH", public: ephemeralPublic },
      privateKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["decrypt"],
    );
    const raw = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64ToBytes(wrap.wrap_iv) as unknown as BufferSource },
      sealingKey,
      base64ToBytes(wrap.wrapped_key) as unknown as BufferSource,
    );
    return new Uint8Array(raw);
  } catch {
    return null;
  }
}

/**
 * Opens an identity wrap into a usable AES-GCM clinic key, exactly like the
 * passphrase path's `importKey("raw", ...)` step. Returns null on failure.
 */
export async function unwrapIdentityWrap(
  wrap: IdentityWrap,
  privateJwkOverride?: JsonWebKey | string,
): Promise<CryptoKey | null> {
  const raw = await unwrapIdentityWrapRaw(wrap, privateJwkOverride);
  if (!raw) return null;
  try {
    return await crypto.subtle.importKey(
      "raw",
      raw,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  } catch {
    return null;
  }
}
