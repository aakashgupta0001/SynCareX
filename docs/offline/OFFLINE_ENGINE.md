# Offline engine

Phase 2 design and limitations. Last updated: 2026-10-30.

SynCareX is offline-first: a clinical record is written to this device and is
durable before any network request is attempted. Connectivity only decides
*when* a record reaches the server, never whether the clinician can record it.

## 1. Local database

Dexie.js over IndexedDB, database `syncarex-local`.

| Store | Holds | Plaintext index fields |
|---|---|---|
| `patients` | Patient records | id, ownerId, updatedAt, archivedAt |
| `patientIdentifiers` | Programme / card identifiers | id, ownerId, patientId |
| `consultations` | Consultations | id, ownerId, patientId, updatedAt |
| `clinicalNotes` | Clinician-authored notes | id, ownerId, patientId, consultationId |
| `observations` | Recorded measurements | id, ownerId, patientId, consultationId |
| `allergies` | Allergy records | id, ownerId, patientId |
| `medications` | Documented medications | id, ownerId, patientId |
| `documents` | Document metadata | id, ownerId, patientId, consultationId |
| `documentBlobs` | Encrypted file bytes | id, ownerId, patientId |
| `localUsers` | Provisioned accounts, KDF parameters | id, email, userId |
| `devices` | This browser's provisioning state | id, deviceId |
| `syncOperations` | The durable operation queue | operationId, idempotencyKey, dedupeKey, status |
| `syncConflicts` | Conflicting versions awaiting review | id, ownerId, entityId, status |
| `auditEvents` | Local audit trail | id, ownerId, entityId, createdAt |
| `localSettings` | Device ID, last successful sync | key |

Every clinical record is stored as an `EncryptedRecord`: an AES-GCM envelope
plus the minimum plaintext needed to index, scope and synchronize it. Record
identifiers are UUIDs generated on the device, and every record carries
`createdAt`, `updatedAt`, `version` and `deviceId`.

### Versioning and migration

`db.ts` declares schema version 1 (Phase 1) and version 2 (Phase 2). The v2
upgrade copies `operations`, `settings` and `vaults` forward into
`syncOperations`, `localSettings` and `localUsers`. The v1 stores are left in
place rather than dropped, so an interrupted upgrade can never strand
unsynchronized clinical work. Future versions add a new `version(n).stores()`
block with an `upgrade()` function; they must never drop a store that may
still hold unacknowledged records.

### Transactions

A clinical write and its queue entry are committed in one Dexie transaction
(`commitWrite` in `repositories/localStore.ts`). Either the record and its
pending operation both exist, or neither does. All cryptography happens
*before* the transaction opens, because an IndexedDB transaction cannot
survive an `await` on Web Crypto.

## 2. Durable operation queue

Each operation carries `operationId`, `idempotencyKey`, `dedupeKey`,
`entityType`, `entityId`, `operationType`, `payload`, `baseVersion`,
`localVersion`, `deviceId`, `actorId`, `createdAt`, `retryCount`, `status`,
`lastError` and `nextAttemptAt`. Statuses are `pending`, `processing`,
`failed`, `acknowledged` and `conflict`.

- **Idempotency key**: `SHA-256(deviceId | entityType:entityId:operationType:localVersion)`.
  It is deterministic, so a retry after an unknown outcome carries the same
  key and the server recognises the replay.
- **Local de-duplication**: `dedupeKey` is a unique index, so the same
  logical change cannot be queued twice.
- **Backoff**: 5s base, doubling, capped at 15 minutes, with jitter.
  `getDue()` skips an operation until `nextAttemptAt`; `getPending()` still
  counts it, so nothing silently disappears from the Sync Center.
- **Acknowledgement**: an operation becomes `acknowledged` only when the
  server's response names it. An operation the server did not answer is set
  back to `failed` and stays queued.
- **Partial batches**: operations are sent in batches of 25 and each result
  is applied independently.

## 3. Conflicts

A server that holds a newer version answers `conflict` with its own version.
The device stores both versions in `syncConflicts` and marks the operation
`conflict`; nothing is merged or overwritten. In Conflict review a clinician
either keeps the local version (the operation is rebased onto the server
version and re-queued) or keeps the server version (the local attempt is
retained in the conflict history). Resolution is always an explicit human
decision.

## 4. Security and the device threat model

### What is protected

- Clinical content is encrypted with **AES-GCM-256** before it is written.
- The key is derived with **PBKDF2-SHA-256, 310,000 iterations**, from the
  clinician's sign-in secret and a per-account random salt.
- The key exists **only in memory**. It is never written to IndexedDB,
  `localStorage` or a cookie. Locking the workspace, signing out, closing the
  tab or reloading the page drops it, and the records become unreadable until
  the passphrase is entered again.
- The workspace **locks itself after 15 minutes** of inactivity.
- Records are scoped by `ownerId`: another account signing in on the same
  device cannot read them.
- Audit event details are encrypted the same way. No patient information is
  written to the console, a URL, a QR code or a log file.
- Access tokens live in memory; the refresh session is an HTTP-only cookie.

### What is **not** protected

- **IndexedDB is not encrypted by the browser.** Any claim that it is would
  be false. SynCareX encrypts each record itself; the surrounding store,
  including the plaintext index fields listed above, is readable by anything
  with access to the browser profile.
- The plaintext index fields leak *structure*: how many patients exist, when
  records were touched, and which records belong to the same patient.
- A compromised device — malware with the user's profile, a hostile browser
  extension, or an attacker present while the vault is unlocked — can read
  everything the clinician can read. Browser storage cannot defend against
  code running in the same origin.
- The key is only as strong as the passphrase. PBKDF2 raises the cost of a
  guessing attack against an exported database; it does not make a weak
  passphrase safe.
- A browser profile copied while locked still yields the encrypted records,
  which can be attacked offline at the KDF's cost.
- Deleting browser site data deletes the local records, including
  unsynchronized ones. Synchronize or export a backup before clearing data.

### Offline authentication

Offline access is a **continuation of a server-authenticated session**, not a
way around one.

1. The first sign-in must reach the server. It authenticates the account
   (Argon2 password hashing server side), provisions this browser as a device
   and records the clinic's offline grace period (default 7 days).
2. The vault is created or unlocked with the same passphrase.
3. While offline, unlocking the vault restores the session for records that
   are already on the device, until the offline session expires.
4. An expired offline session is refused with a clear message, and the
   encrypted records are preserved for the next online sign-in.
5. Signing out locks the vault. "Sign out and forget device" also ends the
   offline authorization.

Unlocking the vault cannot grant a permission the server has not already
issued to the account, and the server re-checks authorization on every
synchronized operation.

## 5. Service worker and updates

- Precaches the application shell and static assets (no external CDN).
- `navigateFallback: /index.html` so the installed app opens offline;
  `/api/` and `/health` are on the fallback denylist and are `NetworkOnly`.
- **No API response, access token or patient record is ever cached by the
  service worker.** Clinical data lives only in the encrypted IndexedDB
  stores.
- `offline.html` is precached as a fallback page for addresses outside the
  application shell.
- Cache ID is versioned (`syncarex-v2`) and outdated caches are cleaned up on
  activation. Cache cleanup never touches IndexedDB, so an application update
  cannot destroy clinical records.
- `skipWaiting` and `clientsClaim` are disabled: an update is offered in the
  interface and applied only when the clinician accepts, so a reload never
  interrupts a form in progress.

## 6. Connectivity

`services/connectivity.ts` is the single source of truth. `navigator.onLine`
alone does not prove the backend is reachable, so the service also probes
`GET /health` with a 5-second timeout and distinguishes:

- offline (no network),
- online but API unreachable,
- online and API reachable.

Only the last state enables synchronization. It re-probes every 30 seconds,
on `online`/`offline` events and when the app returns to the foreground.
Foreground synchronization is the reliable baseline; Background Sync is
registered where available but is never required.

## 7. Documents

Files are validated (10 MB maximum; PNG, JPEG, WebP, PDF), hashed with
SHA-256, encrypted and written to `documentBlobs` before anything is sent.
Metadata is registered through the sync queue first; the bytes are uploaded
afterwards and the server verifies size and checksum. **The local original is
never deleted** — upload success only changes `uploadStatus`.

## 8. Measured browser capabilities

Measured by `frontend/e2e/environment.spec.ts` on the development machine
(Chrome 131, Windows 11, 16 GB RAM, 12 logical processors):

| Capability | Result |
|---|---|
| IndexedDB | Available |
| Web Crypto (AES-GCM, PBKDF2) | Available |
| Service worker | Available and registering |
| Background Sync | Available (treated as optional) |
| Storage quota | ~10 GiB for this origin |
| Storage in use | < 0.01 GiB |
| Persistent storage API | Available; **not granted by default** |
| WebGPU / WebAssembly | Available |

### Storage limits that matter in practice

- The quota is a browser-managed share of free disk, not a reservation. It
  shrinks when the device fills up.
- Without persistent storage the browser may evict this origin under storage
  pressure. The Settings screen requests persistence and reports the answer
  honestly rather than assuming it was granted.
- At 10 MB per document, the practical ceiling is dominated by documents, not
  records. A conservative working figure is a few hundred documents per
  device between synchronizations; the Settings screen shows the measured
  headroom for this browser.
- iOS Safari applies a much smaller quota and may evict data from web apps
  that go unused for weeks. Treat a device as a cache, not an archive:
  synchronize regularly and use the encrypted export for a durable copy.

### Implications for local AI in later phases

The development machine reports WebGPU and WebAssembly, 16 GB RAM and 12
logical processors, which is enough for small quantized models — but this is
a developer laptop, not a representative field device. Phase 2 introduces **no
AI dependency of any kind**, and no cloud service is required for any offline
workflow. Any later local-inference work must:

- detect capability at runtime and degrade to "unavailable" rather than fail,
- keep model weights out of the service worker precache (they would make the
  shell unusable on low-storage devices),
- never become a prerequisite for documenting care, and
- keep every generated suggestion subject to clinician review.

## 9. Known limitations

- Local search decrypts the records it filters. That is correct for privacy
  and fine at clinic scale, but it is linear in the number of patients on the
  device; a blind index would be needed for very large local datasets.
- The encrypted backup excludes document bytes, which would make it too large
  for a browser download.
- Reloading the page always requires the passphrase again, by design: the key
  is not persisted anywhere.
- Conflict detection is record-level, not field-level. Both versions are
  shown side by side and the clinician chooses; the engine never merges.
- Background Sync is registered where supported but is not relied upon.
