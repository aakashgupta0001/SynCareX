# SynCareX architecture

## Product boundary

SynCareX is a documentation and information-management foundation. It does not diagnose, prescribe, or make authoritative treatment decisions. Clinical content remains human-authored and requires authorized review. The current build is for synthetic development data only.

## Implemented system

```text
React + TypeScript PWA
  ├─ Dexie / IndexedDB repositories
  │    ├─ AES-GCM encrypted clinical entities and operation payloads
  │    ├─ v3 encrypted AI source blobs, transcripts and review artifacts
  │    ├─ v4 sync attempt recovery and local pull checkpoints
  │    ├─ v5 encrypted local integrity findings and review rationale
  │    ├─ Local audit metadata and device settings
  │    └─ Durable sync outbox with retry state
  ├─ Vite PWA / Workbox application-shell precache
  └─ API client: in-memory access token, HttpOnly refresh cookie
                    │ authenticated HTTP; restrictive configured CORS
FastAPI
  ├─ Auth, refresh rotation, RBAC and clinic scoping
  ├─ Patient/clinical APIs, sync push/pull and audit listing
  ├─ Durable operation replay ledger and clinic-scoped change feed
  └─ SQLAlchemy → SQLite for development or configured PostgreSQL
       └─ Alembic migrations

Optional local AI workspace ── bearer-authenticated HTTP ──> 127.0.0.1:8765
  ├─ Readiness and fixed model catalog with verified explicit downloads
  ├─ Whisper.cpp / Tesseract / llama-cpp-python optional adapters
  └─ Audio, images and AI outputs are persisted encrypted in browser IndexedDB
```

The browser is authoritative for local unsynchronized work; the API is authoritative for accepted server records. Local writes are encrypted and committed with a durable outbox operation before the UI attempts network synchronization. Failed and conflicting operations remain stored; a transport response alone does not clear an operation.

## Frontend boundaries

- `frontend/src/pages` contains route-level screens.
- `frontend/src/components` and `frontend/src/layouts` contain reusable UI and application shell.
- `frontend/src/database` owns Dexie tables, types, and schema upgrades. The v3 schema adds AI artifacts, v4 adds sync attempt recovery, and v5 adds encrypted local integrity findings without rewriting clinical records.
- `frontend/src/repositories` owns local data access, encryption envelopes, audit entries, and durable operation state; pages do not access IndexedDB directly.
- `frontend/src/security` owns key derivation, vault lock/unlock, and encrypted value/file helpers.
- `frontend/src/services` contains API/auth, connectivity, push/pull orchestration, and queue recovery.
- `frontend/src/repositories/syncPullRepository.ts` applies encrypted, clinic-scoped pull pages and the corresponding cursor in one IndexedDB transaction. Unsynchronized local work is preserved as a conflict.
- `frontend/src/services/localAI.ts` communicates only with the fixed loopback address. The bearer token is kept in page memory; source data is committed to encrypted IndexedDB before an engine request.
- `frontend/src/repositories/aiRepository.ts` stores AI text/metadata and source bytes encrypted under the unlocked local vault. AI artifacts are device-local and intentionally do not enter the clinical sync queue or clinical notes automatically.
- `frontend/src/repositories/integrityRepository.ts` runs deterministic, read-only checks over the locally available clinical records, AI artifacts, documents, conflicts, and sync queue. It persists encrypted findings and review rationale in Dexie v5 and writes local audit events; findings are not synced or used to change clinical records. Local review actions require the provisioned `patients.write` permission in both the page and repository, as a client-side gate rather than a server security boundary.
- `frontend/src/pages/IntegrityPage.tsx` provides duplicate-candidate review and integrity findings. Matching is a conservative suggestion only; there is no automatic merge, deletion, or clinical-value selection.
- `frontend/vite.config.ts` configures the PWA manifest, Workbox precache and Vitest.

IndexedDB stores only the metadata required for ownership, relation lookup, versioning, and queue scheduling in plaintext. Clinical entities, audit details, and outbox payloads are encrypted. Current local account/profile metadata is not fully concealed; see [security design](../security/SECURITY_DESIGN.md).

## Backend boundaries

- `backend/app/api` exposes versioned auth, clinical, sync, patient, and audit endpoints.
- `backend/app/core` owns configuration and security dependencies.
- `backend/app/models` contains SQLAlchemy entities.
- `backend/app/repositories` isolates database access; `backend/app/services` coordinates patient/auth use cases.
- `backend/migrations` contains Alembic history.

The API derives clinic scope from the authenticated user. Frontend navigation or cached role metadata is never an authorization boundary. Patient writes use an expected-version check; stale edits return a conflict instead of silently overwriting the server version.

## Local AI boundary

`ai_engine` is a separate optional FastAPI process. Its supported runner binds
to loopback, uses a process-scoped bearer token, permits only configured
frontend origins, and never accepts arbitrary model URLs. The catalog pins
model filenames, byte sizes and SHA-256 digests. Downloads require a user
action, write to a temporary file, verify size and digest, and are atomically
installed. Startup does not download weights.

Readiness reports installed runtimes, currently available RAM and model-disk
space. Inference rechecks model integrity and free RAM. Whisper.cpp handles
transcription, Tesseract handles image OCR, and `llama-cpp-python` optionally
extracts schema-validated statements. Extracted evidence must be a verbatim
quote from the submitted text; a clinician still reviews each item. Summaries
are assembled only from facts the clinician selects and preserve their source
quotes. This engine does not diagnose, prescribe, or automatically modify a
clinical note. No model or runtime is bundled, and actual inference has not
been verified in the current environment.

## Synchronization boundary

The client outbox covers supported clinical entities and uses durable
`pending`, `processing`, `retry_wait`, `failed`, `acknowledged`, `conflict`, and
`superseded` states. Server push persists terminal outcomes with a request
fingerprint and actor/device/entity identity. The clinic-scoped pull feed has
monotonic cursors and includes sync operations and ORM-backed clinical API
writes. Conflict review never automatically merges: keeping local creates a
new operation identity, while keeping server applies the retained server
snapshot. Documents are whole-file transfers with size/checksum validation,
not resumable transfers. PostgreSQL concurrency and real multi-device
acceptance remain unverified; see the [sync design](../synchronization/SYNC_ENGINE_DESIGN.md).

The local integrity guardian is separate from the server sync protocol. It
checks only the current device's decrypted cache and stores findings locally;
it does not share findings across devices, verify server-side AI provenance,
or provide a server-authorized merge/escalation workflow.

## PWA and offline boundary

Workbox precaches the built HTML, JavaScript, CSS, icons, and manifest. Clinical API responses are not placed in the service-worker cache. Dexie is the durable clinical offline store; PWA shell caching does not replace IndexedDB persistence. A production build is verified, but installation, browser restart/offline reload, and quota/eviction behavior have not been independently tested in a browser.

## Planned components

PDF OCR, resumable document transfer, model removal, server-side AI provenance,
automatic AI-artifact synchronization, per-device cursor acknowledgement and
retention, append-only clinical history, FHIR mapping, and exchange/emergency
modules remain planned. No AI runtime or model binary is bundled.

See [database schema](../database/DATABASE_SCHEMA.md), [sync design](../synchronization/SYNC_ENGINE_DESIGN.md), and [project status](../../PROJECT_STATUS.md).
