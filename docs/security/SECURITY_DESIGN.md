# Security and privacy design

## Status and safe-use boundary

The current implementation is a development foundation, not a production or clinically validated service. Use synthetic data only. It has not undergone independent penetration testing, threat assessment, privacy/legal review, or compliance certification.

## Implemented controls

- **Passwords:** Backend passwords are hashed with Argon2id; plaintext passwords are not stored.
- **Sessions:** Short-lived JWT access tokens are held in frontend module memory. Refresh tokens are random, stored server-side only as hashes, rotated on refresh, revocable on logout, and transported in an HttpOnly, SameSite=Strict cookie.
- **Authorization:** API dependencies enforce active-user, role/permission, and authenticated clinic scope. Patient queries are scoped server-side. UI controls are not trusted as authorization.
- **Local records:** Clinical record values, operation payloads, local audit details, and stored document bytes use AES-GCM envelopes. A PBKDF2-SHA-256-derived key (310,000 iterations) is held in memory while the vault is unlocked. Locking clears the in-memory key.
- **Offline expiry:** A provisioned local account has a bounded offline-session window (7 days by default). Unlocking offline does not extend that window.
- **Persistence and retries:** A clinical write and outbox operation are committed together in IndexedDB. Acknowledged status is assigned only after a successful API response; failures remain queued with retry state and error details.
- **Transport/configuration:** The API binds to loopback by default, CORS requires explicit configured origins, and production configuration requires a strong JWT secret plus secure cookies.
- **Audit:** Server audit rows record actor, clinic, action, entity, outcome and time, without duplicating clinical note text. Local audit details are encrypted.

## Known gaps and residual risk

- The local account/profile index currently stores email, server user ID, name, roles and permissions outside the encrypted clinical envelopes. Do not treat browser profile storage as concealed.
- Device authorization is not yet a complete server-side enrollment, revocation, or cryptographic device-binding lifecycle.
- Patient sync does not yet have a general server operation ledger, transactional push/pull checkpoints, or server conflict-resolution history. Consultation and other clinical queues are not synchronized.
- Conflict responses are retained for review; there is no clinician resolution UI/API and no automatic merge.
- Audit events are not protected by an append-only database role or cryptographic hash chain.
- Server-side document upload, malware scanning, OCR, transcription, and extraction are not enabled. The optional loopback AI engine has local OCR adapters; local document bytes are encrypted, but file-processing protections for the server remain to be designed.
- No production secret manager, refresh-token theft detection, rate limiting, MFA, key rotation/recovery, encrypted backup/restore, retention/deletion workflow, or formal session/device policy is complete.
- The default development JWT secret and `COOKIE_SECURE=false` are for loopback development only. Production mode rejects those settings, but further deployment hardening is still required.

## Production gate

Before any real clinical use, complete a documented threat model, independent security review, authorization testing, device enrollment/revocation, local identity concealment, key lifecycle/recovery, server sync idempotency and conflict handling, TLS deployment, strict secret management, logging review, file scanning, encrypted backups and restore drills, retention/export/deletion processes, monitoring/incident response, and applicable legal/regulatory assessment. No compliance certification is claimed.

See [architecture](../architecture/ARCHITECTURE.md) and [project status](../../PROJECT_STATUS.md).
