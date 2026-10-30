import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../database/db";
import { patientRepository } from "../repositories/patientRepository";
import { invalidateIndex, trigrams } from "../offline/searchIndex";
import * as localVault from "../security/localVault";
import {
  resetWorkspace,
  setOnline,
  syntheticPatient,
  testUser,
} from "./helpers";

const people = [
  { fullName: "Amara Okafor", village: "Riverbend", contactPhone: "+00-111-2222" },
  { fullName: "Bashir Rahman", village: "Riverbend", contactPhone: "+00-333-4444" },
  { fullName: "Chen Wei", village: "Hilltop", contactPhone: "+00-555-6666" },
  { fullName: "Daniela Rossi", village: "Hilltop", contactPhone: "+00-777-8888" },
  { fullName: "Esi Mensah", village: "Lakeside", contactPhone: "+00-999-0000" },
];

async function seed() {
  for (const person of people) {
    await patientRepository.createLocal({ ...syntheticPatient, ...person });
  }
}

/** Runs a search with a full scan, bypassing the index entirely. */
async function scanSearch(query: string) {
  const all = await patientRepository.listAllLocal();
  const normalized = query.normalize("NFKC").toLocaleLowerCase().trim();
  return all
    .filter((patient) =>
      [
        patient.fullName,
        patient.patientNumber,
        patient.village,
        patient.contactPhone,
        patient.emergencyContactName,
      ].some((value) =>
        (value ?? "").normalize("NFKC").toLocaleLowerCase().includes(normalized),
      ),
    )
    .map((patient) => patient.id)
    .sort();
}

describe("blind trigram search index", () => {
  beforeEach(async () => {
    setOnline(false);
    await resetWorkspace();
  });

  it("returns exactly the same results as a full scan", async () => {
    await seed();
    const queries = [
      "riverbend",
      "Riverbend",
      "hill",
      "illtop", // an infix, which a prefix-only index would miss
      "chen wei",
      "999",
      "SCX-",
      "nobody here",
      "amara okafor",
      "  lakeside  ",
    ];

    for (const query of queries) {
      const viaIndex = (await patientRepository.searchLocal(query, { pageSize: 100 })).items
        .map((patient) => patient.id)
        .sort();
      expect(viaIndex, `query ${query}`).toEqual(await scanSearch(query));
    }
  });

  it("decrypts only the candidate records, not the whole vault", async () => {
    await seed();
    // Warm the index so the build pass is not counted.
    await patientRepository.searchLocal("riverbend");

    const decrypt = vi.spyOn(localVault, "decryptLocalValue");
    decrypt.mockClear();
    const result = await patientRepository.searchLocal("lakeside");
    const decryptions = decrypt.mock.calls.length;
    decrypt.mockRestore();

    expect(result.items).toHaveLength(1);
    // One matching patient: far fewer decryptions than the five on the device.
    expect(decryptions).toBeLessThan(people.length);
  });

  it("stores only keyed hashes, never patient text", async () => {
    await seed();
    await patientRepository.searchLocal("riverbend");

    const rows = await db.searchIndex.toArray();
    expect(rows.length).toBeGreaterThan(0);

    const dumped = JSON.stringify(rows);
    for (const term of ["amara", "okafor", "riverbend", "hilltop", "lakeside"]) {
      expect(dumped.toLowerCase()).not.toContain(term);
    }
    // A raw trigram must not appear either.
    for (const gram of trigrams("riverbend")) {
      expect(rows.some((row) => row.term === gram)).toBe(false);
    }
  });

  it("keeps the index current when a record is edited", async () => {
    const patient = await patientRepository.createLocal({
      ...syntheticPatient,
      fullName: "Original Name",
      village: "Oldtown",
    });
    expect((await patientRepository.searchLocal("oldtown")).total).toBe(1);

    await patientRepository.updateLocal(patient.id, { village: "Newtown" });

    expect((await patientRepository.searchLocal("oldtown")).total).toBe(0);
    expect((await patientRepository.searchLocal("newtown")).total).toBe(1);
  });

  it("builds the index for records that predate it", async () => {
    await seed();
    // Simulate a device whose records were written before the index existed.
    await invalidateIndex(testUser.id);
    expect(await db.searchIndex.count()).toBe(0);

    const result = await patientRepository.searchLocal("hilltop");
    expect(result.total).toBe(2);
    expect(await db.searchIndex.count()).toBeGreaterThan(0);
  });

  it("falls back to a full scan for queries shorter than a trigram", async () => {
    await seed();
    // "we" is two characters, so the trigram index cannot answer it; the
    // result must still be correct.
    const viaSearch = (await patientRepository.searchLocal("we", { pageSize: 100 })).items
      .map((patient) => patient.id)
      .sort();
    expect(viaSearch).toEqual(await scanSearch("we"));
  });

  it("the index is unreadable once the vault is locked", async () => {
    await seed();
    await patientRepository.searchLocal("riverbend");
    localVault.lockLocalVault();

    await expect(patientRepository.searchLocal("riverbend")).rejects.toThrow(
      /Unlock the local vault/,
    );
    // The rows survive; they are simply meaningless without the key.
    expect(await db.searchIndex.count()).toBeGreaterThan(0);
  });
  it("indexes a record in the same write, so it is searchable at once", async () => {
    // The index rows and the record are committed in one transaction. If they
    // were not, a record could exist while being invisible to search until
    // the whole index was rebuilt, which for a patient is a safety problem.
    const patient = await patientRepository.createLocal({
      ...syntheticPatient,
      fullName: "Immediately Searchable",
      village: "Freshwater",
    });

    const rows = await db.searchIndex
      .where("patientId")
      .equals(patient.id)
      .count();
    expect(rows).toBeGreaterThan(0);

    const found = await patientRepository.searchLocal("freshwater");
    expect(found.items.map((item) => item.id)).toEqual([patient.id]);
  });

  it("indexes a record pulled from the server so it can be found locally", async () => {
    const serverPatient = {
      ...syntheticPatient,
      id: crypto.randomUUID(),
      patientNumber: "SCX-PULLED001",
      fullName: "Pulled From Server",
      village: "Remotebrook",
      version: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      archivedAt: null,
    };
    expect(await patientRepository.cacheServerPatient(serverPatient)).toBe(true);

    const found = await patientRepository.searchLocal("remotebrook");
    expect(found.items.map((item) => item.id)).toEqual([serverPatient.id]);
  });
});
