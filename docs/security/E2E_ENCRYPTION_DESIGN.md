# End-to-end encryption: design

Status: **design accepted, implementation partial.** Date: 2026-10-30.

PS04 lists "End-to-End Encryption" in the security stack. SynCareX does not
have it today and this document does not pretend otherwise. What exists is
device-side encryption at rest plus TLS in transit; the server stores
clinical fields in readable columns. This is the plan to change that, what it
breaks, and what has been built so far.

## 1. What is true today

| Layer | Protection |
|---|---|
| Device (IndexedDB) | AES-GCM-256 per record, key derived with PBKDF2-SHA-256 from the clinician's passphrase, held in memory only |
| In transit | TLS only. The client **decrypts** before sending, so the sync payload is plaintext JSON |
| Server (PostgreSQL/SQLite) | Plaintext columns: `full_name`, `contact_phone`, `relevant_history`, `village`, note bodies, and so on |

Anyone with database access — an administrator, a backup, a compromised host,
a subpoena served on the operator — reads every record. That is the gap.

## 2. Goal

The server stores clinical content it cannot read. Keys live only on
provisioned devices. The operator can still run the service: route
operations, detect conflicts, enforce authorization, and serve a change feed,
all on metadata and ciphertext.

Explicitly **not** a goal: hiding metadata. Record ids, clinic ids,
timestamps, versions and the shape of the operation graph stay readable. That
is what makes conflict detection and sync possible at all, and pretending
otherwise would be dishonest.

## 3. Key architecture

A per-clinic **Clinic Data Key** (CDK), a random 256-bit AES-GCM key that the
server never sees in the clear.

```
CDK  (random, 256-bit, generated on the first device)
 └── wrapped once per user with that user's Key Encryption Key
      KEK_user = PBKDF2-SHA-256(passphrase, per-user salt, 310k)
```

The server stores only `wrapped_cdk` blobs, one per user, and hands them out
to authenticated users. A user unwraps with their passphrase, so the CDK is
available on any device they sign in to, which keeps multi-device working.

Why a shared clinic key rather than per-user keys: clinicians in a clinic
must read each other's records. Per-record keys wrapped to every user would
mean re-wrapping on every membership change and would not improve the threat
model meaningfully, because any member can read everything anyway.

### Rotation and revocation

- **Passphrase change**: re-wrap the CDK with the new KEK. No record touched.
- **Removing a user**: delete their wrap. They keep whatever they already
  cached on their device, so removal must be paired with device wipe or
  accepted as a limitation — this is inherent to client-side crypto.
- **Suspected CDK compromise**: generate CDK′, re-encrypt every record on a
  trusted device, upload, retire CDK. Expensive and must be a deliberate,
  supervised operation.

## 4. What this breaks, precisely

Enumerated from the code, not guessed. Each is a server-side read of
clinical plaintext that stops working the moment records are ciphertext.

| # | Site | Use | Mitigation |
|---|---|---|---|
| 1 | `repositories/patients.py` (`ilike` on `full_name`, `patient_number`, `village`) | Server-side patient search | **Server-side blind index.** Devices compute HMAC trigrams with a key derived from the CDK and upload them; the server matches hashes. The client-side trigram index already implemented in `src/offline/searchIndex.ts` is the same scheme and can be reused directly |
| 2 | `services/continuity.py` (~l.98–142) | Emergency passport summary built server-side from name, emergency contact and history | **Move generation to the device.** The device has the plaintext; it builds the summary, encrypts it, and uploads the ciphertext plus the token hash. The server becomes a store and a revocation list |
| 3 | `services/continuity.py` (~l.295) | Referral carries `patient_full_name` as a reference | Store an encrypted reference. The server only needs `patient_id` for routing |
| 4 | `services/continuity.py` (~l.674) | Transfer export embeds the exporting clinician's name | Clinician identity is account data rather than patient data; it may stay plaintext, or move into the encrypted envelope with the rest of the package |
| 5 | `services/continuity.py` (~l.812–827) | Transfer import collision detection matches `full_name` + DOB/phone server-side | **Move to the device**, or compare blind-index hashes of `(normalized name, dob)` so the server can flag a possible collision without reading either value |

Also affected, more mechanically:

- **Sync change feed** payloads become ciphertext. Devices already decrypt
  what they receive, so this is largely a type change.
- **FHIR export** must move to the device for the same reason as the
  passport.
- **Server-side audit details** keep metadata only. Local audit details are
  already encrypted.
- **Conflict detection** is unaffected: it compares `version` integers, not
  content. This is why the conflict engine survives the change intact.

## 5. Storage shape

Each clinical table keeps its routing and ordering metadata in the clear and
moves content into one envelope:

```
patients(
  id, clinic_id, version, created_at, updated_at, archived_at,   -- metadata
  ciphertext BYTEA, iv BYTEA, key_epoch INT                      -- content
)
patient_search_terms(clinic_id, patient_id, term)                -- blind index
```

`key_epoch` records which CDK generation encrypted the row, so a rotation can
proceed record by record instead of in one transaction.

## 6. Migration path

The change cannot land in one commit without a flag day. Staged:

1. **Add the key material** — `clinic_keys` table, wrapped-CDK endpoints,
   client key management. Additive; nothing else changes. *(Implemented — see
   below.)*
2. **Dual-write** — devices send both plaintext and ciphertext; the server
   stores both. Readers still use plaintext. Reversible at any point.
3. **Move the five server-side readers** to the mitigations in §4, one at a
   time, each with its own tests.
4. **Flip readers to ciphertext**, keeping plaintext columns populated but
   unused, so a rollback is still possible.
5. **Backfill and drop the plaintext columns.** One-way.

A deployment must not skip to step 5: without step 3 the passport, transfer
import and search features would break silently.

## 7. Implementation status

**Step 1 is implemented.** `clinic_keys` stores one wrapped CDK per user; the
API lets an authenticated user fetch their wrap and lets the first device in
a clinic publish the initial wraps. The server never receives an unwrapped
CDK, and a user cannot read another clinic's wrap.

**Steps 2 to 5 are not implemented.** No clinical record is end-to-end
encrypted yet. The key material exists and is tested, and nothing in the
application depends on it, so it currently protects nothing. That is stated
here deliberately so a reader does not mistake the presence of the table for
the property.

## 8. Honest limitations of the end state

Even fully implemented:

- **Metadata is not hidden.** Patient counts, record timestamps, edit
  frequency and clinic membership remain visible to the operator.
- **The blind index leaks equality and frequency.** An operator can see that
  two patients share a search term and can observe term distribution, which
  supports statistical inference even without the key.
- **A compromised device loses everything** that device can read. Client-side
  encryption moves the trust boundary; it does not remove it.
- **The operator still controls the code.** A malicious update to the
  JavaScript could exfiltrate keys. Defending that needs reproducible builds
  and client attestation, which are out of scope.
- **Key loss means data loss.** If every wrap for a clinic becomes
  unrecoverable, the server's copy is unreadable permanently. Recovery
  requires a deliberate escrow decision, which has its own risks.
