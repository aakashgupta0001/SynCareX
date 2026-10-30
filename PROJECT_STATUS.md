# Project status

Last updated: 2026-10-30 (Phase 7 — final audit, testing and hackathon readiness)

Status vocabulary: **Implemented and tested** · **Implemented but partially
tested** · **In progress** · **Blocked** · **Not implemented**

> **Overall verdict: suitable for a hackathon demonstration. Not suitable for
> a pilot with real patients, and not production ready.** See
> [docs/FINAL_AUDIT_REPORT.md](./docs/FINAL_AUDIT_REPORT.md).

## Feature status

### Offline engine

| Feature | Status | Evidence |
|---|---|---|
| Encrypted local database (Dexie/IndexedDB) | Implemented and tested | 15 stores; AES-GCM envelopes; schema versioning with forward migration |
| Local repositories and CRUD | Implemented and tested | `offlinePersistence.test.ts`, 10 tests |
| Durable operation queue | Implemented and tested | Idempotency keys, dedupe keys, exponential backoff; survives restart |
| Offline search and pagination | Implemented and tested | Verified offline in a real browser |
| Local search indexing | Implemented and tested | Blind trigram index (keyed HMAC only); identical results to a full scan with fewer decryptions |
| Local document storage | Implemented and tested | Encrypted bytes, SHA-256 verified on open and upload |
| PWA shell and offline fallback | Implemented and tested | App opens with the network disabled |
| Connectivity service | Implemented and tested | Distinguishes offline from "online but API unreachable" |
| Data survives browser restart | Implemented and tested | Verified with a persistent browser profile, not a page reload |
| Encrypted local backup export | Implemented but partially tested | Export works; **no import/restore path exists** |

### Authentication and authorization

| Feature | Status | Evidence |
|---|---|---|
| Password hashing (Argon2id) | Implemented and tested | |
| Access and refresh tokens | Implemented and tested | Rotation, revocation, logout invalidation |
| Offline session with expiry | Implemented and tested | Expiry refuses unlock and preserves records |
| Automatic session locking | Implemented and tested | 15-minute idle timer drops the in-memory key |
| Device provisioning and revocation | Implemented and tested | Push and pull both require an active provisioned device |
| Role-based authorization | Implemented and tested | All 39 protected routes verified against anonymous and forged tokens |
| Clinic data isolation | Implemented and tested | Cross-clinic read and write return 404 |
| Authentication rate limiting | **Not implemented** | No lockout or throttle on repeated failures |

### Synchronization

| Feature | Status | Evidence |
|---|---|---|
| Push with server-side idempotency ledger | Implemented and tested | Replay returns the stored outcome; no duplicate record |
| Partial batch success | Implemented and tested | Per-operation results; retryable vs permanent rejection |
| Pull change feed (server to device) | Implemented and tested | **Was broken until this phase**; fixed and regression-tested |
| Conflict detection and preservation | Implemented and tested | Both versions kept; clinician resolves; no silent merge |
| Two-device convergence | Implemented and tested | 8/8 browser checks on two independent profiles |
| Retry with exponential backoff | Implemented and tested | |
| Interrupted upload mid-transfer | **Partially tested** | Retry path tested; a mid-body interruption was not simulated |

### Clinical features

| Feature | Status | Evidence |
|---|---|---|
| Patients, identifiers, consultations, notes | Implemented and tested | |
| Observations, allergies, medications | Implemented but partially tested | Local write paths tested; limited UI coverage |
| Documents | Implemented and tested | |
| Referrals | Implemented but partially tested | Offline draft and status flow tested |
| Follow-ups | Implemented but partially tested | Offline scheduling tested |
| Emergency passport | Implemented but partially tested | Token issue/verify/revoke tested. **The code image is a visual badge, not a scannable QR code** |
| Clinic transfer and FHIR export | Implemented but partially tested | Export/import and collision detection tested |
| Integrity guardian | Implemented and tested | 8 tests: duplicate candidates, name variants, checksum drift, contradictory measurements, review permission |
| Audit history | Implemented but partially tested | Operational log only — **not tamper-evident** |

### AI engine

| Feature | Status | Evidence |
|---|---|---|
| Local AI service (loopback, token-authenticated) | Implemented and tested | Constant-time token compare; fails closed; refuses to start without a token |
| Model catalog with pinned SHA-256 digests | Implemented and tested | |
| Verified atomic model download | Implemented and tested | A failed digest leaves nothing installed |
| Readiness and RAM detection | Implemented and tested | |
| Graceful unavailability | Implemented and tested | Interface states it plainly; all clinical workflows keep working |
| Speech transcription | **Blocked** | whisper.cpp not installed; no inference executed |
| Speech translation to English | Implemented but **unverified** | Exposed as a task on the transcription endpoint; contract tested, no inference executed |
| OCR | **Blocked** | Tesseract not installed; no inference executed |
| Structured extraction | **Blocked** | No local LLM model downloaded |
| History retrieval ranking | Implemented and tested | Lexical relevance ranking before the context budget; **not** semantic retrieval, no embeddings |
| Clinician review enforcement | Implemented and tested | Unsupported evidence leaves an extraction unreviewed |
| Cloud AI dependency | **None, by design** | No offline workflow requires any cloud service |

## Verification completed (2026-10-30)

All figures produced by running the commands.

- Frontend unit and component tests: **59 passed** (8 files)
- Backend tests: **138 passed**
- AI engine tests: **9 passed**
- Offline acceptance in a real browser: **19 PASS, 6 BLOCKED, 0 FAIL**
- Two-device synchronization: **8 PASS, 0 FAIL**
- Typecheck and production build: clean, 20 precache entries (734 KiB)
- Alembic: clean upgrade on an empty database; `alembic check` reports no drift
- `npm audit --omit=dev`: **0 vulnerabilities** in production dependencies

## Known security limitations

- **IndexedDB is not encrypted by the browser.** SynCareX encrypts each
  record itself; index fields, record structure and timestamps stay readable
  to anyone with the browser profile.
- A compromised device, hostile extension, or anyone present while the vault
  is unlocked can read everything the clinician can read.
- The audit trail is an operational log with no hash chain or signature.
- Transfer package checksums detect corruption; they are **not** signatures
  and prove nothing about origin.
- No authentication rate limiting, no retention policy, no deletion workflow.
- No third-party security review or penetration test has been performed.
- Two moderate findings remain open: error objects logged to the browser
  console, and ~48 unassociated form labels in the Phase 6 pages.

## Known AI limitations

- No model or runtime was available during this audit, so transcription, OCR
  and extraction are **unverified**. They are not claimed to work.
- The audit machine is a developer laptop and says nothing about performance
  on a field device.
- Model downloads require internet and were unreachable in this environment.
- Any AI-produced content requires explicit clinician review before it
  enters a record. The system does not diagnose or prescribe.

## Documentation

- [Final audit report](./docs/FINAL_AUDIT_REPORT.md)
- [Security review](./docs/SECURITY_REVIEW.md)
- [Offline test report](./docs/OFFLINE_TEST_REPORT.md)
- [Deployment guide](./docs/DEPLOYMENT_GUIDE.md)
- [Hackathon demonstration](./docs/HACKATHON_DEMO.md)
- [Offline engine design](./docs/offline/OFFLINE_ENGINE.md)
- [Architecture](./docs/architecture/ARCHITECTURE.md) ·
  [Database schema](./docs/database/DATABASE_SCHEMA.md) ·
  [Sync design](./docs/synchronization/SYNC_ENGINE_DESIGN.md) ·
  [Security design](./docs/security/SECURITY_DESIGN.md)

## Safety statement

This repository is a development and demonstration build. It must not be used
to store or process real patient data. It stores and organizes
clinician-authored documentation; it does not diagnose, prescribe or
recommend treatment. No compliance certification is claimed.
## Original problem statement (PS04) coverage

| PS04 component | Status |
|---|---|
| PWA, service workers, IndexedDB | Implemented and tested |
| Local DB of records, histories and pending changes | Implemented and tested |
| Voice capture | Implemented and tested |
| Whisper.cpp speech recognition | Implemented, **unverified** (no model) |
| OCR document scanning | Implemented, **unverified** (no runtime) |
| Quantized LLM extraction | Implemented, **unverified** (no model) |
| Language translation | Implemented, **unverified** (no model) |
| Local search indexing | Implemented and tested |
| RAG pipeline | Lexical retrieve-then-generate, ranked and tested. **No embeddings or vector store** |
| FastAPI authenticated sync APIs | Implemented and tested |
| PostgreSQL centralized database | Configured, **never exercised** (SQLite only) |
| End-to-end encryption | **In progress — steps 1-3 of 5.** Clinic keys wrapped per user; patients dual-written as ciphertext alongside plaintext; patient search moved onto keyed hashes so the server never receives the query. **Plaintext remains authoritative and four server-side readers still read it, so records are not yet unreadable to the operator.** See [E2E_ENCRYPTION_DESIGN.md](./docs/security/E2E_ENCRYPTION_DESIGN.md) |
| Audit logs | Implemented, not tamper-evident |
| Conflict resolution with version tracking and retry-safe operations | Implemented and tested — the strongest part of the system |
| Mobile alternative with SQLite | **Not implemented** (PWA only) |
