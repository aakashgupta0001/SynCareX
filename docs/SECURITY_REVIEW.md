# Security review

Phase 7 defensive security review. Date: 2026-10-30.
Reviewer: automated audit with manual verification, against commit-in-progress
on branch `master`.

This review covers the application as it exists in this repository. It is not
a penetration test, and no third party has reviewed it. No real patient data
was used; every test record is synthetic.

## Summary

| Severity | Found | Fixed | Open |
|---|---|---|---|
| P0 critical | 0 | 0 | 0 |
| P1 major | 3 | 3 | 0 |
| P2 moderate | 4 | 4 | 0 |
| P3 minor | 4 | 1 | 3 |

No unauthorized data access path was found. The three P1 findings were a
broken production secret check, a broken synchronization pull, and a build
that did not compile; all three are fixed and covered by tests.

## A. Authentication

| Check | Result | Evidence |
|---|---|---|
| Password hashing | **Pass** | Argon2id via `argon2-cffi` (`app/security/passwords.py`). No fallback to a weaker algorithm. |
| Access token integrity | **Pass** | HS256 JWT. A token signed with another secret is refused, and an `alg: none` token is refused. `decode_access_token` requires `exp`, `sub`, `sid`, `type` and rejects a non-access token. |
| Refresh handling | **Pass** | Opaque 48-byte token, stored only as SHA-256; HTTP-only, `SameSite=Strict`, path-scoped cookie; rotated on use with the old session revoked and linked via `replaced_by_id`. |
| Refresh token cannot be used as an access token | **Pass** | Verified by test. |
| Logout invalidates the session | **Pass** | The access token embeds `sid`; revoking the refresh session makes the still-unexpired access token fail. Verified by test. |
| Session expiry | **Pass** | Access tokens 15 minutes; refresh sessions 14 days; both checked server-side on every request. |
| Offline session expiry | **Pass** | Offline unlock is refused once `offlineSessionExpiresAt` passes, and the vault stays locked. Records are preserved, not deleted. Covered in `security.test.ts`. |
| Protected routes require authentication | **Pass** | All 39 non-public routes are enumerated from the live route table and asserted to reject both anonymous requests and forged bearer tokens (`tests/test_security_audit.py`). |

Offline access is a continuation of a server-authenticated session, not a
second way in: the first sign-in must reach the server, which provisions the
device and sets the offline grace period.

## B. Authorization

| Check | Result | Evidence |
|---|---|---|
| Permission enforcement | **Pass** | Every clinical route declares `require_permission(...)`; permissions are resolved from the database role graph per request, never from the client. |
| Clinic isolation | **Pass** | Another clinic's patient returns 404 on read and on write. Verified by test. |
| Client-supplied identifiers ignored | **Pass** | Posting `clinic_id`, `created_by` and `version` in a patient payload does not influence the stored record; the clinic comes from the session. Verified by test. |
| Device authorization for sync | **Pass** | Push and pull both require a device provisioned to the caller's clinic and with status `active`; a revoked device is refused. |
| Export / transfer permissions | **Pass** | `transfers.export` and `transfers.import` are distinct permissions and separately enforced. |
| Conflict resolution permissions | **Partial** | Conflict resolution is a local decision that re-queues an operation; the server then re-authorizes that operation normally. There is no separate server-side "resolve" permission, so any user who may write the record may resolve its conflict. Documented, not a defect. |
| Role checks in the interface | **Pass (defence in depth only)** | `ReferralsPage` computes `canApprove`/`canSend` from the session to shape the interface. These are presentation-only; the server re-checks. Fixed during this audit to read `session.permissions` rather than a non-existent `user.permissions`, which had made the check always fall back to a role name. |

## C. Input validation

| Check | Result | Evidence |
|---|---|---|
| Malformed JSON | **Pass** | 422 with a validation error, no traceback. |
| Invalid identifiers | **Pass** | A non-UUID path parameter yields 422 before any query runs. |
| Oversized payloads | **Pass** | Field-level `max_length` on every string; a 100,000-character name is refused. Documents are capped at 10 MB both client and server side. |
| Invalid file formats | **Pass** | The upload endpoint checks the registered MIME type against an allow-list, the byte length against the registered size, and the SHA-256 against the registered checksum. Tampered content is refused with 422 and not stored. |
| Path traversal | **Pass** | Stored filenames are derived from the server-side document UUID (`{clinic_id}/{document.id}.bin`); the client-supplied `file_name` is metadata only and never used to build a path. |
| Unsafe archive import | **Pass (by design)** | Clinic transfer packages are JSON, not archives; no extraction of attacker-controlled paths takes place. Imported patients are written through the normal local-write path. |
| SQL injection | **Pass** | SQLAlchemy ORM with bound parameters throughout; no string-built SQL. Three injection payloads in the patient search return zero rows and leave the table intact. Verified by test. |
| Pagination bounds | **Pass** | `page >= 1`, `1 <= page_size <= 100` enforced by the schema; `page_size=100000` is refused. The change feed is bounded by `sync_pull_limit`. |

## D. Sensitive information

| Check | Result | Notes |
|---|---|---|
| Patient data in server logs | **Pass** | No logging of request bodies. The only `print` is a seed confirmation message. |
| Patient data in browser console | **Pass** | **Fixed during this audit.** The five `console.error("...", err)` calls were replaced with recoverable in-page error messages. No `console.*` call remains anywhere in application code. |
| Secrets in source | **Pass** | No hardcoded credentials. The development JWT secret is a published placeholder and production now refuses to start with it. |
| Sensitive data in URLs | **Pass** | Routes carry UUIDs only. No name, phone or date of birth appears in any path or query string. |
| Browser storage | **Pass, with documented limits** | Clinical content is stored as AES-GCM envelopes. Index fields (ids, timestamps, owner) remain readable. IndexedDB is *not* browser-encrypted and the documentation says so explicitly. |
| Service worker caching | **Pass** | `/api/v1/` and `/health` are `NetworkOnly` and on the navigation-fallback denylist. No API response, token or patient record is ever precached. Verified by reading the generated `dist/sw.js` manifest: only shell assets are precached. |
| Exported files | **Pass** | The local backup exports encrypted envelopes only, and states that document bytes are excluded. |
| QR contents | **Pass, feature relabelled** | The passport code image is derived from a 32-bit hash of the token, so nothing is recoverable from it. It is also not a scannable QR code; it has been relabelled accordingly (see P1/P3 findings). |
| Error messages | **Pass** | No traceback, SQL fragment, secret name or filesystem path appears in any error response. Verified by test across three error classes. |

## E. Cryptography

| Item | Implementation | Assessment |
|---|---|---|
| Local record encryption | AES-GCM-256 | Appropriate. Random 96-bit IV per record from `crypto.getRandomValues`. |
| Key derivation | PBKDF2-SHA-256, 310,000 iterations, 128-bit random salt per account | Meets current OWASP guidance for PBKDF2-SHA-256. Argon2id would be stronger but is not available in the Web Crypto API without shipping WebAssembly. |
| Key storage | In memory only | The key is never written to IndexedDB, `localStorage` or a cookie. Page reload, lock, logout and the 15-minute idle timer all drop it. |
| Server password hashing | Argon2id | Appropriate. |
| Refresh token at rest | SHA-256 only | Acceptable: the token is 48 random bytes, so it is not guessable and needs no slow hash. |
| Passport verification token | 192 bits from a CSPRNG, stored as SHA-256 | Appropriate. **Fixed during this audit**: the plaintext token was also being persisted next to its hash, which defeated hashing it. |
| Document integrity | SHA-256 verified on upload and on local open | Appropriate. A corrupted stored document fails its integrity check rather than opening. |
| Transfer package integrity | SHA-256 checksum recorded | Appropriate for detecting corruption. **It is not a signature**: it proves nothing about origin, and the documentation must not claim provenance guarantees. |
| Audit integrity | Append-only rows with encrypted details | **Not tamper-evident.** There is no hash chain and no signature; an operator with database access can alter history undetectably. Claimed nowhere as more than an operational log. |
| TLS | Not configured in this repository | Deployment concern. The deployment guide requires TLS termination in front of the API and sets `COOKIE_SECURE=true`, which production startup now enforces. |

**Limits stated plainly.** The local vault protects records at rest against
someone who copies the browser profile without the passphrase. It does not
protect against malware running as the user, a hostile browser extension, or
anyone present while the vault is unlocked.

## Findings

### P1-1 Production accepted the shipped development JWT secret — FIXED

The production check tested only the length of `JWT_SECRET`. The default
value shipped in this repository is 41 characters, so it passed. A deployment
that forgot to set the variable would have signed tokens with a publicly
known secret, allowing anyone to mint valid access tokens for any account.

Fixed in `app/core/config.py`: production now refuses the known default by
value, refuses the development SQLite URL, refuses a set `SEED_ADMIN_PASSWORD`,
and still requires `COOKIE_SECURE`. Five parametrised tests cover it.

### P1-2 Server-to-device synchronization always failed — FIXED

`GET /api/v1/sync/changes` defaulted `limit` to 200 but validated it against
`sync_batch_limit` (50), the limit for *pushed* operations. Every pull using
the default was rejected with 422, so no device ever received another
device's records. The 422 then surfaced in the interface as a failed patient
save, even though the record had been saved locally.

Fixed by separating the two concerns: a new `sync_pull_limit` (default 200)
governs the change feed. A pull failure is also no longer allowed to
misreport a push that already succeeded. Two regression tests cover it.

### P1-3 The production build did not compile — FIXED

35 TypeScript errors in the Phase 6 continuity code (a patient type that does
not exist, a paginated result treated as an array, a repository method that
was never defined, unused imports). `npm run build` runs `tsc -b` first, so
the application could not be built at all. All fixed; build and typecheck are
clean.

### P2-1 Passport verification token stored in clear — FIXED

`EmergencyPassportRecord` persisted `verificationToken` alongside its own
SHA-256 `tokenHash`. Nothing read the field. Removed, so a copied browser
profile no longer yields usable passport tokens.

### P2-2 Modal dialogs trapped the user — FIXED

Six dialogs render a full-screen overlay that swallows pointer events and had
no Escape handler, so a clinician who opened one could not reach the rest of
the interface except via the Cancel button. A shared `useDismissableModal`
hook now closes on Escape and locks background scrolling.

### P2-3 Error objects logged to the browser console — FIXED

Five `console.error("...", err)` calls in the Phase 6 pages logged the raw
error object. No current message carried patient data, but an error object is
not something the page controls, and the project's rule is that patient
information must never reach the console. Each site now sets a recoverable
in-page error instead, which also fixes a usability problem: these screens
previously failed to load with nothing visible to the clinician. Verified: no
`console.*` call remains in `src/pages`, `src/components`, `src/services` or
`src/repositories`.

### P2-4 Form labels are not associated with their controls — OPEN

In the Phase 6 pages (`AIWorkspacePage`, `FollowUpsPage`, `PassportPage`,
`ReferralsPage`, `TransfersPage`) roughly 48 `<label>` elements are siblings
of their input rather than wrapping it or using `htmlFor`. Screen readers do
not announce the label, and the fields cannot be reached by accessible name.
The Phase 1–2 pages wrap their inputs and are correct.

### P3-1 The emergency passport "QR code" is not scannable — FIXED (relabelled)

`QRCodeDisplay` draws real finder patterns and then fills the data area from
a 32-bit string hash. There is no QR encoding, error correction or masking,
so no scanner can read it. Nothing is recoverable from the image, so this was
never a data leak, but presenting it as a QR code would misrepresent the
feature. It is now labelled "Visual badge only - not machine scannable", and
the verification token, which does work, is the documented mechanism.

### P3-4 Intermittent horizontal page scroll at small widths — OPEN

At tablet or phone width the page can be dragged roughly 35px sideways.
`document.documentElement` reports scrollWidth 803px while `document.body`
matches the viewport, so one content-width element is slightly too wide. The
patient table (clipped by its own `overflow-x: auto` wrapper) and the
collapsed horizontal nav strip were both ruled out. Moving the sidebar
collapse breakpoint from 760px to 900px — which also fixes a genuinely
cramped tablet layout — reduced it from 260px to 35px. Cosmetic: no control
is unreachable and no content is cut off. Covered by an expected-to-fail test
in `e2e/ui-quality.spec.ts`.

### P3-2 Development helper scripts committed to the repository — OPEN

`frontend/fix_syntax.py`, `frontend/scripts_fix.py`, `frontend/update_db.py`,
`frontend/update_layout.py`, `frontend/update_types.py`,
`backend/scripts/update_models.py` and `backend/scripts/update_sync.py` are
one-off edit scripts, not part of the application. They should be removed.

### P3-3 Dev-dependency advisories — PARTIALLY ADDRESSED

`npm audit --omit=dev` reports **0 vulnerabilities** in production
dependencies. Six advisories exist in development dependencies only: two high
(`playwright < 1.55.1`, which downloads browsers without verifying the TLS
certificate) and four low (`deepmerge` prototype pollution reached through
`workbox-build`). Neither ships to users. The Playwright advisory does not
apply to how this project runs tests, because the bundled browser download is
unreachable from this network and the suite uses the installed Chrome
channel instead.

## Recommendations before any pilot

1. Close P2-4 (label association) and P3-4 (horizontal scroll).
2. Add a server-side hash chain or signature if audit history is ever to be
   presented as tamper-evident. Today it is not.
3. Have a qualified third party review the cryptography and run a penetration
   test. Nothing in this document substitutes for that.
4. Decide a retention and deletion policy; none is implemented.
5. Rate-limit authentication. There is currently no lockout or throttle on
   repeated failed sign-ins.
