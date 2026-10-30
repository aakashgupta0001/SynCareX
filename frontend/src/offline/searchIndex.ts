import { db } from "../database/db";
import type { LocalPatient } from "../database/types";
import { blindIndexTerms, requireUnlockedIdentity } from "../security/localVault";
import { getLocalSetting, setLocalSetting } from "./device";

/**
 * Blind trigram index for offline patient search.
 *
 * Before this existed, every search decrypted every patient record and ran a
 * substring test, so search cost grew linearly with the size of the device's
 * vault. The index narrows that to the records that can possibly match.
 *
 * Two properties make it safe to rely on:
 *
 * 1. **No plaintext on disk.** Only keyed HMAC hashes of trigrams are stored.
 *    Without the vault's index key they cannot be computed or reversed.
 * 2. **No false negatives.** Every substring of length >= 3 in a field
 *    contributes all of its trigrams, so a record that would match the
 *    substring test always appears among the candidates. Candidates are then
 *    put through the *same* exact match test as before, which removes false
 *    positives. Search results are therefore identical to a full scan; only
 *    the amount of work changes.
 *
 * Shorter queries cannot be served by a trigram index, so they fall back to
 * the full scan and still return the same answer.
 */

export const TRIGRAM_SIZE = 3;
const INDEX_VERSION = "1";
const BUILT_KEY_PREFIX = "search_index_built:";

/** The fields the patient search matches on. Keep in step with the matcher. */
export function searchableValues(patient: LocalPatient): string[] {
  return [
    patient.fullName,
    patient.patientNumber,
    patient.village,
    patient.contactPhone,
    patient.emergencyContactName,
  ].filter((value): value is string => Boolean(value));
}

export function normalizeForIndex(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().trim();
}

/** Sliding window of trigrams, spaces included so multi-word queries work. */
export function trigrams(value: string): Set<string> {
  const normalized = normalizeForIndex(value);
  const grams = new Set<string>();
  for (let i = 0; i + TRIGRAM_SIZE <= normalized.length; i += 1) {
    grams.add(normalized.slice(i, i + TRIGRAM_SIZE));
  }
  return grams;
}

export function patientTrigrams(patient: LocalPatient): Set<string> {
  const grams = new Set<string>();
  for (const value of searchableValues(patient)) {
    for (const gram of trigrams(value)) grams.add(gram);
  }
  return grams;
}

export interface IndexRow {
  ownerId: string;
  patientId: string;
  term: string;
}

/**
 * Hashes a patient's trigrams. Call this *before* opening a Dexie
 * transaction: Web Crypto is async and a transaction cannot survive the wait.
 */
export async function buildIndexRows(
  patient: LocalPatient,
  ownerId: string,
): Promise<IndexRow[]> {
  const hashes = await blindIndexTerms(patientTrigrams(patient));
  return hashes.map((term) => ({ ownerId, patientId: patient.id, term }));
}

/** Replaces one patient's index rows. Must run inside a write transaction. */
export async function replaceIndexRows(
  patientId: string,
  rows: IndexRow[],
): Promise<void> {
  await db.searchIndex.where("patientId").equals(patientId).delete();
  if (rows.length) await db.searchIndex.bulkAdd(rows);
}

/**
 * Candidate patient ids for a query, or null when the index cannot answer it
 * and the caller must fall back to scanning everything.
 */
export async function candidateIds(
  ownerId: string,
  query: string,
): Promise<Set<string> | null> {
  const grams = [...trigrams(query)];
  if (!grams.length) return null;

  const hashes = await blindIndexTerms(grams);
  let candidates: Set<string> | null = null;

  for (const term of hashes) {
    const rows = await db.searchIndex
      .where("[ownerId+term]")
      .equals([ownerId, term])
      .toArray();
    const ids = new Set(rows.map((row) => row.patientId));
    if (candidates === null) {
      candidates = ids;
    } else {
      // Every trigram of the query must be present in a matching record.
      for (const id of candidates) if (!ids.has(id)) candidates.delete(id);
    }
    if (candidates.size === 0) return candidates;
  }
  return candidates;
}

function builtKey(ownerId: string): string {
  return `${BUILT_KEY_PREFIX}${ownerId}`;
}

export async function isIndexBuilt(ownerId: string): Promise<boolean> {
  return (await getLocalSetting(builtKey(ownerId))) === INDEX_VERSION;
}

/**
 * Builds the index for records that predate it, or after the index format
 * changes. This is the one operation that still decrypts every record; it
 * runs once per device rather than once per search.
 */
export async function ensureIndexBuilt(
  ownerId: string,
  loadAll: () => Promise<LocalPatient[]>,
): Promise<void> {
  if (await isIndexBuilt(ownerId)) return;

  const patients = await loadAll();
  const rows: IndexRow[] = [];
  for (const patient of patients) {
    rows.push(...(await buildIndexRows(patient, ownerId)));
  }

  await db.transaction("rw", db.searchIndex, async () => {
    await db.searchIndex.where("ownerId").equals(ownerId).delete();
    if (rows.length) await db.searchIndex.bulkAdd(rows);
  });
  await setLocalSetting(builtKey(ownerId), INDEX_VERSION);
}

/** Drops the index so the next search rebuilds it. Used by tests and resets. */
export async function invalidateIndex(ownerId: string): Promise<void> {
  requireUnlockedIdentity("rebuild the search index");
  await db.searchIndex.where("ownerId").equals(ownerId).delete();
  await setLocalSetting(builtKey(ownerId), "");
}
