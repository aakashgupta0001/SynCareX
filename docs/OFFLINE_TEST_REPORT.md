# Offline acceptance test report

Phase 7 §4 and §5. Date: 2026-10-30.

All records used are synthetic. No real patient information was entered at
any point.

## Test environment

| Item | Value |
|---|---|
| Host | Windows 11 Home Single Language 10.0.26300, AMD Ryzen AI 5 340, 16 GB RAM, 12 logical processors |
| Browser | Google Chrome 131.0.6778.33 (installed channel) |
| Application | Production build served by `vite preview` on port 4173 |
| API | FastAPI on port 8001 against a throwaway SQLite database, seeded with one synthetic clinician |
| Browser storage quota | 10.00 GiB for the origin; persistent storage **not** granted by default |
| Local AI runtimes | whisper.cpp **absent**, Tesseract **absent**, no models downloaded |

Playwright's bundled browser download is unreachable from this network, so
the suite runs against the installed Chrome channel.

## How "restart the browser" was tested

The acceptance suite uses `chromium.launchPersistentContext` with a real
user-data directory, so closing the context genuinely closes the browser and
reopening it attaches to the same IndexedDB. This is stronger evidence than a
page reload, which would not prove that data survives process exit.

Reproduce with:

```bash
cd frontend && npx playwright test e2e/offline-acceptance.spec.ts
```

## Results: complete offline workflow

**19 PASS, 6 BLOCKED, 0 FAIL.**

| # | Step | Outcome | Evidence |
|---|---|---|---|
| 0 | Provision device online | PASS | Server sign-in succeeded; device provisioned |
| 0 | Install the PWA service worker | PASS | Registration reached `active` |
| 0 | Confirm local storage | PASS | 10.00 GiB quota; `persisted=false` |
| 0 | Local AI model readiness | **BLOCKED** | AI engine not running; no models installed |
| 1 | Restart the browser | PASS | Persistent profile closed and reopened |
| 2 | Open SynCareX with no network | PASS | Shell served entirely by the service worker |
| 3 | Authenticate with the provisioned offline session | PASS | Vault unlocked offline |
| 4 | Create a synthetic patient | PASS | Saved locally and queued |
| 5 | Add patient identifiers | PASS | Identifier stored and queued |
| 6 | Create a consultation | PASS | Saved locally and queued |
| 7 | Record or load test audio | **BLOCKED** | No local AI engine running, so no capture target |
| 8 | Run local speech transcription | **BLOCKED** | whisper runtime and model absent |
| 8.1 | AI unavailability stated in the interface | PASS | Explicit "unavailable" state, no crash |
| 9 | Scan or load a test medical document | PASS | Encrypted locally and queued |
| 10 | Run local OCR | **BLOCKED** | Tesseract not installed; PDF OCR additionally needs Poppler |
| 11 | Run structured extraction | **BLOCKED** | Local LLM model not downloaded |
| 12 | Review and edit extracted fields | **BLOCKED** | Depends on step 11 |
| 13 | Save the consultation | PASS | Edit versioned and queued |
| 14 | Search the patient's history offline | PASS | Local search returned the record |
| 15 | Create a follow-up | PASS | Scheduled and stored locally |
| 16 | Prepare a referral | PASS | Referral drafted offline |
| 17 | Open the Sync Center | PASS | |
| 18 | Unsynchronized operations remain queued | PASS | 6 operations queued; sync control disabled offline |
| 19 | Close and reopen the browser | PASS | Persistent profile closed |
| 20 | Records, documents, drafts and queue persist | PASS | patients=1, consultations=1, documents=1, queued=6 — unchanged across the restart |

### What BLOCKED means here

Steps 7, 8, 10, 11 and 12 require a local speech model, Tesseract, or a local
LLM. None is installed on this machine and none could be downloaded in this
environment. These steps were **not** exercised and are **not** claimed to
work.

What was verified instead is the behaviour the brief asks for when the AI
engine is unavailable: the AI workspace states plainly that the engine is
unavailable, and **every clinical workflow in steps 4, 5, 6, 9, 13, 14, 15,
16 continued to work with the AI engine absent**. Essential documentation is
not gated on the AI engine.

## Results: two-device synchronization and recovery

**8 PASS, 0 FAIL.** Two independent persistent Chrome profiles, so genuinely
separate IndexedDB stores, service workers and device identifiers.

```bash
cd frontend && npx playwright test e2e/two-device-sync.spec.ts
```

| Check | Outcome | Evidence |
|---|---|---|
| Both devices provisioned independently | PASS | Separate profiles and device ids |
| Device A pushes a new patient | PASS | The record reported "Synced" only after server acknowledgement |
| Device B pulls a record it never created | PASS | Server change feed applied on B |
| Both devices edit the same field offline | PASS | Each saved locally |
| First device to reconnect is accepted | PASS | A's edit applied, version incremented |
| Second device is not silently overwritten | PASS | B's push answered with a conflict, not an overwrite |
| Conflict preserves both versions side by side | PASS | B's conflict review shows its own edit and the server's |
| Repeated synchronization creates no duplicate | PASS | Exactly one record for the patient on device A |

### Scenarios covered at the API level

The following are covered by `backend/tests/test_sync.py` rather than through
the browser, because they are server-side guarantees:

| Scenario | Outcome |
|---|---|
| Duplicate operation submission (same idempotency key) | PASS — reported `duplicate: true`, one record created |
| Partial batch failure | PASS — 2 acknowledged, 1 rejected as retryable, in one batch |
| Out-of-order records (note before its consultation) | PASS — rejected as **retryable**, so the device keeps it queued |
| Invalid operation payload | PASS — rejected as non-retryable with a clear reason |
| Unsupported operation type | PASS — rejected, `retryable: false` |
| Unprovisioned device attempting sync | PASS — 403, queue untouched |
| Revoked device attempting sync | PASS — 403 on both push and pull |
| Pull with the endpoint's own default limit | PASS — regression test for the defect described below |
| Record pushed by one device appears in another device's pull | PASS |
| Document upload integrity | PASS — tampered content refused with 422 and not stored |
| Document upload retry | PASS — idempotent, no second copy |

### Scenarios not yet covered

| Scenario | Status |
|---|---|
| Interrupted document upload mid-transfer | Not tested. The design keeps the local original until acknowledgement, and the retry path is tested, but an interruption part-way through the HTTP body was not simulated. |
| Application restart *during* an in-flight sync | Not tested in the browser. Queue durability across restart is proven; the specific mid-flight case is not. |
| Backend restart during synchronization | Not tested. The API-unreachable path is tested, which covers the same client behaviour. |

## Defect found by this testing

**Server-to-device pull was broken for every caller using the default page
size.** `GET /api/v1/sync/changes` defaulted `limit` to 200 but validated it
against the *push* batch limit of 50, returning 422. The error surfaced in
the interface as a failed patient save, even though the record had been
saved locally.

Before the fix, device B could never receive device A's records. After
separating the pull page size from the push batch size, the two-device test
above passes end to end. Two regression tests were added, including one that
calls the endpoint with no `limit` parameter at all.

## Storage limits observed

- Measured quota for this origin: **10.00 GiB**, a browser-managed share of
  free disk that shrinks as the device fills.
- **Persistent storage was not granted by default.** Without it the browser
  may evict this origin under storage pressure. The Settings screen requests
  persistence and reports the actual answer rather than assuming success.
- At the 10 MB per-document cap, documents dominate usage. A conservative
  working figure is a few hundred documents per device between
  synchronizations.
- iOS Safari grants far less and may evict data from web apps left unused.
  Treat a device as a cache, not an archive.

## Honest limitations of this report

- One browser (Chrome 131) on one machine. No Firefox, Safari, Android or
  iOS testing was performed.
- No low-end device was tested. The host has 16 GB of RAM and is not
  representative of a field tablet.
- The local AI pipeline is untested end to end, as recorded above.
- No sustained-load or long-duration testing was performed; the largest local
  dataset exercised was a handful of records.
