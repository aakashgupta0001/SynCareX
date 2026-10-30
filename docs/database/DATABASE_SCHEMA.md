# Database schema

## Implemented relational model

The SQLAlchemy model and initial Alembic migration use UUID primary keys and include:

| Table | Implemented purpose |
|---|---|
| `clinics` | Tenant/clinic record |
| `users` | Clinic-scoped account, Argon2id password hash, and active state |
| `roles`, `permissions`, `user_roles`, `role_permissions` | Role and permission assignments |
| `devices` | Clinic-associated device metadata; full enrollment lifecycle is not implemented |
| `patients` | Clinic-scoped demographic and clinical-context fields, creator, version and timestamps |
| `patient_identifiers` | Patient-linked namespaced identifiers with clinic-scoped uniqueness |
| `consultations` | Patient-linked draft consultation metadata and notes |
| `clinical_notes`, `observations`, `allergy_records`, `medication_records`, `documents` | Versioned clinical records and document metadata/content references |
| `audit_logs` | Actor/clinic/action/entity/outcome/time metadata |
| `refresh_sessions` | Hashed refresh-token sessions, expiry, revocation and rotation link |
| `sync_operations` | Idempotency key, operation identity/request hash, and durable terminal outcome |
| `sync_changes` | Clinic-scoped append-only snapshots ordered by a monotonic integer cursor |

Foreign keys, unique constraints, indexes, and clinic checks are defined in the models and migration. Patient API queries derive clinic scope from the authenticated user. Patient updates require an expected version; a stale version is rejected rather than overwritten.

The backend defaults to SQLite for local development. Set `DATABASE_URL` to a PostgreSQL connection string to use PostgreSQL. The included Compose service uses PostgreSQL 17 and binds only to loopback. PostgreSQL startup and migration have not yet been verified in this environment.

## Client-side IndexedDB

Dexie maintains a separate versioned local database (currently v5). Clinical values, outbox payloads, integrity evidence and review rationale are AES-GCM encrypted before storage; only indexing/scheduling metadata remains outside the ciphertext. Current stores include:

- encrypted patients, identifiers, consultations, clinical notes, observations, allergies, medication records and documents;
- separately encrypted document blobs;
- separately encrypted audio/image source blobs and AI text/review artifacts. These are local-only, are not synchronized, and are not written into clinical notes automatically;
- local users/devices/settings and encrypted audit details;
- durable sync operations and conflict records; and
- encrypted pre-edit and local entity snapshots for new update operations,
  retained to support a three-way conflict review without changing the
  server's optimistic concurrency checks;
- `integrityFindings`, a local-only, versioned store for deterministic findings.
  Findings retain a stable rule/entity identity, severity, review status, actor
  and time metadata; the evidence and any review rationale are encrypted.
- per-user pull cursor checkpoints stored with local settings;
- retained v1 stores used by the upgrade path so legacy queued work can be copied forward.

The local account/profile metadata is not fully concealed yet. Integrity
findings are not sent to the server and therefore are not shared across
devices. See [security design](../security/SECURITY_DESIGN.md).

## Remaining gaps

There is no server-side per-device cursor acknowledgement or change-feed
retention/compaction policy. Direct SQL/out-of-band changes do not enter the
change feed. There is no append-only tamper-evident audit chain, server-side
integrity finding/provenance workflow, supervisor escalation, reversible
patient merge history, follow-up, emergency package, or inter-clinic exchange
schema. AI extraction/review artifacts and integrity findings remain encrypted
on the source device.
PostgreSQL concurrency and deployment migrations remain unverified here.

## Migration and test commands

Run from `backend/`:

```powershell
python -m alembic upgrade head
python -m alembic check
```

The complete migration chain through `4f28c13a90de` upgraded successfully on
SQLite, and `alembic check` reported no model drift. Current backend API tests
use SQLite; PostgreSQL has not been validated. Use synthetic fixtures only.
Do not run destructive migrations against data that must be retained.
