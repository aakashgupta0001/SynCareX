# Synchronization engine

## Implemented protocol

Local clinical writes remain local-first: the encrypted record and its durable
outbox operation are committed in the same IndexedDB transaction before any
network request. Push is authenticated, permission-checked, clinic-scoped, and
requires an active provisioned device. Operations carry UUID operation IDs,
stable idempotency keys, actor/device IDs, schema version, entity/version
metadata, a timestamp, and the payload. Payloads are decrypted only in memory
immediately before transmission.

The server stores terminal outcomes in `sync_operations`. For new operations,
it binds each idempotency key and operation ID to a canonical request hash and
the authenticated actor/device/entity identity. A replay with changed content
is rejected; an identical replay returns its stored acknowledgement, conflict,
or permanent rejection. Transient missing-parent outcomes are not recorded as
terminal, so they can be retried after dependencies arrive. Entity mutation,
the accepted operation ledger row, the pull-feed event, and the audit event
commit together. Each operation in a batch commits independently.

The clinic-scoped `sync_changes` feed has a monotonic integer cursor and
bounded `GET /api/v1/sync/changes` pages. A clinic-row lock serializes clinical
feed writes so a later cursor cannot commit ahead of an earlier cursor.
Changes created through the sync service and ORM-backed clinical API writes
are recorded, including patient archival as a tombstone. Pull checks the same
active device authorization as push.

The client saves the pull cursor in IndexedDB and applies each encrypted page
and its checkpoint in one transaction. If a local operation for an incoming
entity remains unacknowledged, the local record is preserved and a conflict is
created instead of overwriting it. Conflict review keeps both encrypted
snapshots. “Keep server” applies the server snapshot; “keep local” creates a
new operation ID and idempotency key rebased to the server version. The
rejected operation is marked `superseded`, not falsely acknowledged.
For updates created by clients with the current local schema, encrypted base
and full local entity snapshots are retained with the operation; conflict
records also retain the server snapshot and actor/device/time metadata. The
review UI displays all three snapshots. Older queued operations and conflicts
may lack a base snapshot and show it as unavailable.

The queue has `pending`, `processing`, `retry_wait`, `failed`, `acknowledged`,
`conflict`, and `superseded` states. Processing entries older than two minutes
are recovered after an interrupted request. Retryable errors use exponential
backoff with jitter and stop automatic retrying after ten attempts; failed
operations remain available for clinician-initiated retry. Parent create and
earlier same-entity operations are ordered before dependent operations.

Document metadata and bytes synchronize separately. The client retains local
encrypted originals, retries acknowledged metadata uploads, and verifies both
byte size and SHA-256 before caching downloaded bytes. Upload/download is
whole-file, not chunked or resumable.

## Boundaries and compatibility

- Historical ledger rows created before request fingerprints were introduced
  have no stored payload hash. Their replay check can verify the operation ID
  and actor/device/entity/type identity, but cannot prove that the historical
  payload is identical.
- Pull cursors are local per-user checkpoints; the server does not keep a
  per-device acknowledgement cursor or provide retention/compaction controls.
- The client conflict action is local review followed by a new push; there is
  no separate server conflict-resolution endpoint or automatic field merge.
- The pull feed records ORM-backed clinical writes only. Direct SQL or
  out-of-band database changes do not generate feed rows.
- Integrity findings and review decisions are currently device-local. The
  guardian can report stalled operations and unresolved conflicts from its
  local cache, but does not synchronize those findings or provide a
  server-authorized supervisor escalation/merge workflow.
- Document transfer has integrity validation but no resumable/chunked transfer.
- PostgreSQL concurrency behavior and a real multi-device/browser offline
  acceptance run still require verification. Current automated API tests use
  SQLite.
- Optional AI artifacts are not part of the clinical synchronization queue.

## Verification

The backend tests cover push idempotency, changed-payload replay rejection,
partial batches, retryable dependencies, conflict preservation, device
provisioning, file checksum rejection, and paginated pull of direct online
patient changes. The Alembic chain is verified on SQLite. Client test cases
cover queue persistence, retry/recovery, dependency ordering, pull snapshots
and checkpoint persistence, conflict handling, and document integrity; those
client tests have not been executed in the current environment. See
`PROJECT_STATUS.md` for the latest commands and results; frontend tests and
production build are not claimed when the Node.js runtime is unavailable.
