# Final audit report

Phase 7: security audit, testing and hackathon readiness.
Date: 2026-10-30. Branch: `master`, uncommitted working tree.

Companion documents: [SECURITY_REVIEW.md](./SECURITY_REVIEW.md),
[OFFLINE_TEST_REPORT.md](./OFFLINE_TEST_REPORT.md),
[DEPLOYMENT_GUIDE.md](./DEPLOYMENT_GUIDE.md),
[HACKATHON_DEMO.md](./HACKATHON_DEMO.md).

## 1. Verdict

**Suitable for a hackathon demonstration. Not suitable for a pilot with real
patients, and not production ready.**

The offline-first engine is real and verifiable: records, documents, drafts
and the operation queue survive a genuine browser restart, two devices
converge, and concurrent edits are preserved for human review rather than
overwritten. That is the claim the project makes, and it holds up under test.

It is not pilot-ready because the local AI pipeline is unverified on real
models, the audit trail is not tamper-evident, there is no rate limiting or
retention policy, no third-party security review has taken place, and no
clinician has signed off on clinical safety.

## 2. Actual implementation status, Phases 1–6

Assessed by reading the code and running it, not from prior claims.

| Phase | Status | Basis |
|---|---|---|
| 1 — UI foundation | **Implemented and tested** | 18 pages, routed and reachable; navigation, forms, loading, empty and error states exercised by unit and end-to-end tests |
| 2 — Database and backend | **Implemented and tested** | Auth, RBAC, clinic-scoped CRUD, version-checked observation/allergy/medication correction, clinical tables, documents, audit. 145 backend tests pass. The entered-in-error migration is the single Alembic head; PostgreSQL SQL was generated but not applied to a live database in this verification |
| 3 — Offline engine | **Implemented and tested** | Dexie v2+ encrypted stores, durable queue with backoff and idempotency, PWA shell, connectivity probing. Verified end to end on a persistent browser profile |
| 4 — AI engine | **Implemented but NOT verified** | A complete local service exists: model catalog with pinned SHA-256 digests, verified atomic download, readiness detection, bearer-token auth, subprocess providers for whisper and Tesseract. **No model or runtime was available on the audit machine, so no inference of any kind was executed.** 19 infrastructure tests pass; none exercises a real model |
| 5 — Synchronization | **Implemented and tested** | Push with server-side idempotency ledger, per-operation results, partial batches, conflict reporting, and a cursor-paged pull change feed. **The pull half was broken until this audit** (see §3) |
| 6 — Continuity and integrity | **Implemented, partially tested** | Referrals, follow-ups, emergency passport, clinic transfer, FHIR bundle export, integrity guardian. 6 backend and 14 frontend tests cover them. The passport code image is not a scannable QR code (relabelled). Several UI defects found and fixed |

## 3. Security findings by severity

Full detail in [SECURITY_REVIEW.md](./SECURITY_REVIEW.md).

| ID | Severity | Finding | Status |
|---|---|---|---|
| — | **P0** | None found | — |
| P1-1 | **P1** | Production accepted the shipped development JWT secret, because the only check was a length check and the published default is 41 characters | **Fixed** + 5 tests |
| P1-2 | **P1** | Server-to-device pull always returned 422: the route defaulted `limit=200` but validated against the push limit of 50. No device could ever receive another device's records | **Fixed** + 2 tests |
| P1-3 | **P1** | The production build did not compile — 35 TypeScript errors in Phase 6 code | **Fixed** |
| P2-1 | **P2** | Passport verification token persisted in clear next to its own hash | **Fixed** |
| P2-2 | **P2** | Six modal dialogs had no Escape handler and their overlay blocked all other interaction | **Fixed** |
| P2-3 | **P2** | Error objects logged to the browser console; those screens also failed silently | **Fixed** |
| P2-4 | **P2** | Phase 6 form controls lacked programmatic labels | **Fixed** + regression test |
| P3-1 | **P3** | The emergency passport "QR code" is a decorative pattern, not scannable | **Fixed** (relabelled honestly) |
| P3-2 | **P3** | One-off developer edit scripts committed to the repository | **Fixed** (7 scripts removed) |
| P3-3 | **P3** | Six dev-dependency advisories; **production dependencies report 0** | **Documented** |
| P3-4 | **P3** | Intermittent ~35px horizontal page scroll at small widths | **Open**, covered by an expected-to-fail test |

Authorization held up under direct attack: all 39 protected routes reject
anonymous and forged-token requests, cross-clinic access returns 404,
client-supplied `clinic_id`/`created_by`/`version` are ignored, SQL injection
payloads return zero rows, and logout invalidates an unexpired access token.

## 4. Bugs fixed in this phase

1. **Build restored** — `DecryptedPatient` replaced with `LocalPatient`,
   paginated `listLocal()` results replaced with `listAllLocal()`, the
   non-existent `patientRepository.saveLocal` replaced with `createLocal`,
   `session.user.permissions` corrected to `session.permissions`,
   `useConnectivity().isOnline` corrected to `useConnectivityState().apiUsable`,
   unused imports removed.
2. **Production startup hardened** — refuses the default secret, the
   development database URL, insecure cookies, and a seed password; API docs
   are not served in production.
3. **Pull synchronization fixed** — pull page size separated from push batch
   size; a pull failure can no longer misreport a push that succeeded.
4. **Passport token no longer persisted in clear.**
5. **Modal dialogs dismissible with Escape**, with background scroll locked.
6. **Transfer export target clinic ID** was state with no input bound to it,
   so every export silently used a hardcoded clinic; it now has a required
   field.
7. **A blocking `alert()`** in the passport flow replaced with the page's own
   message banner.
8. **QR component relabelled** to state that it is a visual badge, not a
   scannable code.
9. **Console logging of error objects removed**; those screens now show a
   recoverable error instead of failing silently.
10. **Tablet layout fixed** — the sidebar collapsed only below 760px, so a
    768px tablet kept a fixed sidebar and a 553px content column. The
    breakpoint is now 900px, which also cut the horizontal overflow from
    260px to 35px.
11. **Phase 6 form labels and repository hygiene fixed** — interactive
    controls in the AI workspace, follow-up, passport, referral and transfer
    pages now have accessible names; the passport checkbox group uses a
    `fieldset`/`legend`, and the FHIR patient selector has a screen-reader
    label. The seven one-off source-edit scripts were removed.

## 5. Tests executed and actual outcomes

| Suite | Command | Result |
|---|---|---|
| Frontend unit and component | `npm test` | **72 passed** (9 files) |
| Backend | `python -m pytest` | **145 passed** |
| AI engine | `python -m pytest ai_engine/tests` | **19 passed** |
| Typecheck | `tsc -b` | clean |
| Production build | `npm run build` | passed, 20 precache entries (767.00 KiB) |
| Migrations | `alembic heads`; PostgreSQL `alembic upgrade --sql head` | one head; entered-in-error DDL generated, not applied to a live database |
| Offline acceptance (browser) | `npx playwright test e2e/offline-acceptance.spec.ts` | **19 PASS, 6 BLOCKED, 0 FAIL** |
| Two-device sync (browser) | `npx playwright test e2e/two-device-sync.spec.ts` | **8 PASS, 0 FAIL** |
| Phase 2 offline e2e | `npx playwright test e2e/offline.spec.ts` | 2 passed |
| Browser capability report | `npx playwright test e2e/environment.spec.ts` | 1 passed |
| Interface quality (browser) | `npx playwright test e2e/ui-quality.spec.ts` | **5 passed** (4 assertions plus 1 expected failure for P3-4) |
| Dependency audit | `npm audit --omit=dev` | **0 vulnerabilities** |

**Tests added during this phase:** 16 backend security tests (including two
parametrised sweeps over every route), 2 pull regression tests, 6 frontend
continuity-offline tests, a Phase 6 accessible-name regression test, and 2
browser suites (offline acceptance, two-device sync).

**OCR follow-up tests:** 5 engine tests cover image preprocessing and
thresholding, PDF conversion/page markers, the PDF page cap, and missing
Poppler; the frontend test checks PDF selection and camera capture settings.

Nothing was skipped, weakened or marked passing to obtain a green result.
Where a capability could not be exercised, it is recorded as **blocked** with
the reason.

## 6. Offline acceptance results

19 of 20 workflow steps pass; 6 steps are blocked, all of them AI steps. Data
survived a real browser process restart: patients=1, consultations=1,
documents=1, queued operations=6, unchanged. Full step-by-step table in
[OFFLINE_TEST_REPORT.md](./OFFLINE_TEST_REPORT.md).

The important secondary result: with the AI engine entirely absent, every
non-AI clinical workflow continued to work. Documentation is not gated on AI.

## 7. Two-device synchronization results

8 of 8 checks pass, using two independent persistent Chrome profiles:
independent provisioning, push, pull of a record the second device never
created, concurrent offline edits to the same field, first-writer acceptance,
second-writer conflict rather than overwrite, both versions preserved side by
side, and no duplicate after repeated synchronization.

## 8. Performance and resource usage

Measured, not estimated. Single-machine figures from the runs above.

| Measure | Observed |
|---|---|
| Production build | ~7.4 s; main bundle 706.16 KB raw / 197.77 KB gzipped |
| Service worker precache | 20 entries, 767.00 KiB |
| Cold start to interactive, offline | Under 2 s on the test machine |
| Offline sign-in (PBKDF2, 310,000 iterations) | ~0.3–0.5 s, deliberate cost |
| Full offline acceptance run (2 browser launches, 20 steps) | ~10 s of interaction |
| Two-device suite (2 persistent profiles, sync cycles) | ~7 minutes wall clock, dominated by sync waits |
| Backend suite | 145 tests in ~49 s |
| Frontend unit suite | 72 tests in ~9 s |
| AI engine suite | 19 tests in ~5 s |
| Browser storage quota | 10.00 GiB; persistent storage not granted by default |

Pagination is bounded everywhere it matters: patient lists page at 10–20,
`page_size` is capped at 100 server-side, sync pushes cap at 50 operations
per batch, and the pull feed is cursor-paged at 200. The largest dataset
exercised was small; **no load testing was performed**, and local search
decrypts the records it filters, so it is linear in the number of patients on
the device.

## 9. Hardware and model limitations

| Item | Finding |
|---|---|
| Audit machine | 16 GB RAM, 12 logical processors, WebGPU and WebAssembly available |
| whisper.cpp | **Not installed.** No transcription was executed |
| Tesseract / Poppler | **Not installed.** Image/PDF OCR was not executed |
| Local LLM | **No model downloaded.** No extraction was executed |
| Model download | Blocked in this environment; HuggingFace URLs in the catalog were unreachable |
| Consequence | Phase 4 cannot be called verified. The service's infrastructure — pinned digests, verified atomic install, readiness detection, token auth, graceful unavailability — is tested; inference is not |

The audit machine is a developer laptop and is **not** representative of a
field device. No conclusion about on-device model performance can be drawn
from it.

## 10. Remaining blockers

**Before a pilot with real data:**

1. Verify the AI pipeline on real models, on representative hardware.
2. Make the audit trail tamper-evident, or stop relying on it for
   accountability.
3. Add authentication rate limiting and lockout.
4. Define and implement a retention and deletion policy.
5. Provide a tested recovery path for unsynchronized device data; the export
   is a safety copy, not a restore mechanism.
6. Independent security review and penetration test.
7. Clinical safety review and clinician sign-off.
8. Close P3-4 (horizontal scroll).
9. Test on browsers other than Chrome, and on a low-end device.

**Not blockers for a demonstration:** all of the above are acceptable for a
hackathon provided the limitations are stated, which
[HACKATHON_DEMO.md](./HACKATHON_DEMO.md) does explicitly.

## 11. Commands

```bash
cd backend && ../.venv/Scripts/python.exe -m alembic upgrade head
```

```bash
cd backend && ../.venv/Scripts/python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

```bash
cd frontend && npm ci && npm run dev
```

Tests:

```bash
cd frontend && npm test && npm run build && npx playwright test
```

```bash
cd backend && ../.venv/Scripts/python.exe -m pytest
```

Optional local AI engine, loopback only, fresh token per run:

```bash
cd ai_engine && ./run_local.ps1
```

## 12. Method and its limits

This audit read the repository, ran every suite, drove the application in a
real browser with the network genuinely disabled, and attacked the API
directly for authorization, injection and token forgery. Findings were fixed
smallest-change-first, with regression tests, and every suite was re-run
afterwards.

It did **not** include: a penetration test by a qualified third party,
clinical validation, formal threat modelling, load or soak testing, testing
on browsers other than Chrome 131, or any execution of the local AI models.

A passing build is not evidence of security, clinical correctness, or
production readiness, and nothing in this document should be read as such.
## 13. PS04 gap closure

Three components named in the original problem statement were missing or
substantially weaker than described. They are now implemented.

### Local search indexing — implemented and tested

Patient search previously decrypted every record on the device and ran a
substring test, so cost grew linearly with the size of the vault. There is
now a **blind trigram index** (`src/offline/searchIndex.ts`):

- Only keyed HMAC-SHA-256 hashes of trigrams are written to IndexedDB, under
  a key derived from the passphrase but domain-separated from the record key,
  so the index cannot decrypt records and a copied browser profile still
  reveals no patient text.
- Trigrams mean arbitrary substring queries are supported with **no false
  negatives**; candidates then go through the same exact match test as
  before, so results are identical to a full scan. Queries shorter than three
  characters fall back to scanning.
- Records written before the index exists are indexed once, lazily.

Seven tests cover it, including identical-results-to-full-scan across ten
query shapes (one of them an infix a prefix index would miss), a reduced
decryption count, absence of plaintext in the stored rows, index freshness
after an edit, backfill, short-query fallback, and that the index is unusable
while the vault is locked.

### Speech translation — implemented, not verified

whisper.cpp translates speech to English with the same model, so translation
is exposed as a `task` on the transcription endpoint rather than as a second
model dependency. The result records which task ran and that the target is
English, so a caller cannot mistake a translation for a transcription. The
workspace offers "Transcribe in the spoken language" or "Translate to
English", and labels a translation as machine output requiring review.

Two tests cover task validation and the result contract. **No translation has
been executed**: there is still no whisper runtime or model on this machine.

### Retrieval ranking for the extraction pipeline — implemented and tested

The history retrieval that feeds the local model previously filtered lines by
substring and then truncated at 15,000 characters, so which context survived
depended on record order. It now scores lines by term overlap with inverse
document frequency, saturating term frequency and length normalization,
selects the highest-scoring lines that fit the budget, and returns them in
chronological order so the model still sees history in sequence. The
interface reports how many matches fitted and whether any were excluded.

Seven tests cover tokenization, budget-constrained selection, chronological
output ordering, exclusion of non-matching lines, the no-query path, the
truncation report, and preference for a precise line over a verbose one.

**This is lexical ranking, not semantic retrieval.** There are no embeddings
and no vector store, so it does not know that "BP" and "blood pressure" are
related. Calling the pipeline "RAG" is only accurate in the loose sense of
retrieve-then-generate.

### Still not implemented

| PS04 item | Status | Why |
|---|---|---|
| End-to-end encryption | **Step 1 of 5 implemented** | Clinic data keys wrapped per user are implemented and tested; the server stores opaque blobs and never holds an unwrapped key. **No clinical record is encrypted with them yet.** The remaining four steps, and the five server-side readers of plaintext that must move first, are specified in [E2E_ENCRYPTION_DESIGN.md](./security/E2E_ENCRYPTION_DESIGN.md) |
| Mobile alternative with SQLite | **Not implemented** | PWA only. Adding a native shell is a new platform target and cannot be built or tested in this environment |
| PostgreSQL as the central database | **Configured, never exercised** | Docker is not installed on this machine; every test to date has run on SQLite |
