# Deployment guide

Date: 2026-10-30.

**Read this first.** SynCareX is a development and demonstration build. It has
not been penetration tested, clinically validated, or reviewed by a qualified
third party. Do not use it with real patient data. The section
"Before a pilot" lists what must be true before even a limited trial.

## 1. Requirements

| Component | Requirement |
|---|---|
| Node.js | 24 LTS with npm |
| Python | 3.12 or newer (verified on 3.14.6) |
| Database | PostgreSQL 16/17 for anything beyond local development; SQLite is the development default |
| Browser | A Chromium-based browser or Firefox with service worker and IndexedDB support |
| TLS | Required in front of the API for any deployment. The app refuses to start in production without `COOKIE_SECURE=true` |
| Local AI (optional) | whisper.cpp and/or Tesseract binaries plus downloaded models. PDF OCR additionally needs Poppler. Never required for clinical documentation |

## 2. Install

```bash
git clone <repository-url> syncarex
```

```bash
cd syncarex/backend && python -m venv ../.venv && ../.venv/Scripts/python.exe -m pip install -r requirements.txt
```

```bash
cd syncarex/frontend && npm ci
```

## 2b. Docker deployment (recommended for a clinic server)

The repository ships a complete container stack: PostgreSQL, the API server
(migrations run on container start) and an nginx image that serves the PWA
same-origin with the API. Same-origin matters: the session cookie is
`SameSite=Strict` and the service worker expects the API next door.

Prerequisites: Docker Engine + Compose v2 on the server. Docker is not
needed on clinician devices — they only need a browser, and the local AI
engine is installed per device (see §AI, below).

### Steps

1. Copy the repository to the server and configure it:

   ```
   cp .env.example .env
   ```

   Then set, at minimum: `APP_ENV=production`, a unique 32+-character
   `JWT_SECRET`, `COOKIE_SECURE=true`, `POSTGRES_*`, and `FRONTEND_PORT`
   (default 80). Leave `DATABASE_URL` as-is — the backend container builds
   its own PostgreSQL URL from `POSTGRES_*`.

2. Build and start everything:

   ```
   docker compose build
   docker compose up -d
   ```

3. Seed the first administrator (one-shot; only for a fresh database):

   ```
   docker compose --profile seed run --rm backend-seed
   ```

   The container runs with `APP_ENV=development` because production startup
   refuses seeded passwords. Sign in immediately and change the admin
   password, then delete `SEED_ADMIN_PASSWORD` from `.env`.

4. Verify: `curl http://<server>/health` returns `{"status":"ok"}`, and the
   app loads at `http://<server>/` from a clinic device.

### TLS

`COOKIE_SECURE=true` means browsers only send the session cookie over
HTTPS, so a production deployment must terminate TLS in front of nginx — a
reverse proxy (Caddy, Traefik, certbot-managed nginx) with a real
certificate for the server's hostname, or a self-signed certificate that
clinic devices trust explicitly. A LAN HTTP pilot cannot use secure
cookies: it must set `COOKIE_SECURE=false` and stay inside a trusted
network.

### Backups

The two volumes that hold irreplaceable data are `postgres-data` (the
database) and `documents-data` (uploaded clinical documents). Back up both;
§7 covers the procedure.

### Local AI engine is per-device by design

The AI engine is a loopback-only service on each clinician's device; it is
deliberately not part of the server stack. Server-side inference would move
voice notes and document images onto the network, which the threat model
avoids. Install whisper.cpp/llama.cpp/Tesseract on each device that needs
it, set its `SYNCAREX_AI_ALLOWED_ORIGINS` to the server's URL, and generate
that device's token with `ai_engine/run_local.ps1`.

## 2c. Render deployment (managed cloud)

`render.yaml` at the repository root is a Render Blueprint: it provisions a
managed PostgreSQL database, the API service (with a 1 GB documents disk),
the nginx frontend, and a one-time seed job. Deploy:

1. Push this repository to GitHub (Render deploys from a Git repository).
2. Render dashboard -> **New -> Blueprint** -> select the repository -> Apply.
   Render provisions `syncarex-postgres`, `syncarex-backend`,
   `syncarex-frontend` (served at `https://syncarex-frontend.onrender.com`)
   and the `syncarex-seed` job. HTTPS is automatic.
3. Set the secret environment variables when prompted or under each
   service's Environment tab: `JWT_SECRET` (32+ random characters),
   `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD` (12+ characters, seed job only).
4. Jobs tab -> **syncarex-seed** -> Trigger Run (once, on a fresh database).
   Sign in, change the admin password immediately.
5. Verify: `https://syncarex-frontend.onrender.com/health` returns
   `{"status":"ok"}` and the app loads same-origin.

Costs and limits: `starter` web services sleep after ~15 minutes idle (first
request after that takes ~50 seconds); the free PostgreSQL plan expires
after 30 days — move to a paid plan before real use. The documents disk
requires a paid plan. Update `FRONTEND_ORIGINS` on the backend if you attach
a custom domain. The local AI engine stays per-device (see §2b).

Why not Vercel/Firebase: the backend is a long-running FastAPI service with
PostgreSQL and on-disk clinical documents — not a serverless workload. The
frontend alone could live anywhere, but keeping it same-origin with the API
(on nginx) is what makes the session cookie and service worker work.

## 3. Configure

Copy `.env.example` to `.env` at the repository root and set every value.
`.env` is gitignored and must never be committed.

### Production is fail-safe by design

Startup **refuses** to continue in production if any of these is true:

| Condition | Why it is refused |
|---|---|
| `JWT_SECRET` is still the development default | The value is published in this repository; anyone could mint tokens |
| `JWT_SECRET` is shorter than 32 characters | Insufficient entropy for HS256 |
| `COOKIE_SECURE` is not true | The refresh cookie would travel over plaintext HTTP |
| `DATABASE_URL` is still the development SQLite file | A production deployment must name its database explicitly |
| `SEED_ADMIN_PASSWORD` is set | Seed accounts are a development convenience and must not exist in production |

Generate a secret with:

```bash
python -c "import secrets; print(secrets.token_urlsafe(48))"
```

Set `APP_ENV=production`, `FRONTEND_ORIGINS` to the exact origins that serve
the app (no wildcard — a wildcard is rejected), and a PostgreSQL
`DATABASE_URL` with a URL-encoded password.

In production the interactive API docs and the OpenAPI schema are not served.

## 4. Database and migrations

```bash
cd backend && ../.venv/Scripts/python.exe -m alembic upgrade head
```

Verify the schema matches the models:

```bash
cd backend && ../.venv/Scripts/python.exe -m alembic check
```

Migrations have been verified to apply to a clean database and to round-trip
`upgrade head` → `downgrade -1` → `upgrade head`. Always take a backup before
running migrations against a database with data; `downgrade` drops tables and
columns and will lose their contents.

## 5. Seed a development clinic

Development only. This fails in production by design.

```bash
cd backend && ../.venv/Scripts/python.exe -m app.seed
```

Set `SEED_ADMIN_PASSWORD` in the shell for that command only; do not persist
it in `.env`.

## 6. Run

API:

```bash
cd backend && ../.venv/Scripts/python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Frontend, development:

```bash
cd frontend && npm run dev
```

Frontend, production build:

```bash
cd frontend && npm run build
```

Serve the contents of `frontend/dist` from a static host over HTTPS. The
service worker requires a secure context (HTTPS, or `localhost`).

Local AI engine, optional, loopback only:

```bash
cd ai_engine && ./run_local.ps1
```

It generates a fresh bearer token per run, prints it once, binds `127.0.0.1`
only, and refuses to start without a token.

For optional OCR, install Tesseract with the language data you need. PDF
support additionally requires Poppler for Windows; set
`SYNCAREX_PDFTOPPM_BIN` and `SYNCAREX_PDFINFO_BIN` to its `pdftoppm.exe` and
`pdfinfo.exe` paths, or place them under
`%USERPROFILE%\.syncarex\bin\poppler\Library\bin` for automatic discovery.
The AI workspace also offers mobile camera capture. PDFs are limited to 10
pages per request. Printed text is best supported; handwriting recognition is
experimental and must be verified manually. No OCR inference has been
validated for clinical use.

## 7. Backup and recovery

### Server side

The server database holds every synchronized record. Back it up with the
standard tool for your engine, for example:

```bash
pg_dump --format=custom --file=syncarex-$(date +%F).dump "$DATABASE_URL"
```

Uploaded document bytes live on disk under `DOCUMENT_STORAGE_DIR` and are
**not** in the database dump. Back up that directory alongside it, or the
restored database will reference documents whose content is missing.

Restore into a disposable environment first and verify that
`alembic check` reports no drift before trusting a backup.

### Device side

Each device holds unsynchronized work that exists nowhere else. Settings →
**Export backup** writes a JSON file of encrypted envelopes, including the
pending operation queue. It can only be read with that vault's passphrase.
Document bytes are deliberately excluded, because they would make the file
too large for a browser download; they remain on the device.

**Recovering unsynchronized local data:** connect the device to the network
and synchronize. There is no supported path to import a device backup into
another device or into the server; the export exists so that an encrypted
copy survives loss of the device, not as a restore mechanism. This is a real
limitation and is listed as an open item below.

### Operations that can remove local data

- Clearing browser site data deletes the local database, including
  unsynchronized records. The browser can also evict the origin on its own
  when persistent storage has not been granted.
- "Sign out and forget device" ends the offline authorization. Encrypted
  records stay on the device but cannot be opened until the next online
  sign-in.

Nothing in the application deletes an unsynchronized record silently.
Archiving marks a record archived and queues the change; it never removes it
from the device.

## 8. Operational checks after deployment

```bash
curl -fsS https://<api-host>/health
```

Then confirm, in a browser:

1. Sign-in succeeds and sets an HTTP-only refresh cookie over HTTPS.
2. The service worker registers and the app opens with the network disabled.
3. The Sync Center reports "Connected" and a recent successful sync.
4. `https://<api-host>/api/v1/docs` returns 404 in production.

## 9. Before a pilot

These are not optional for any use with real data:

- [ ] Independent security review and penetration test
- [ ] Clinical safety review and sign-off by a qualified clinician
- [ ] Rate limiting and lockout on authentication (none implemented)
- [ ] Data retention and deletion policy (none implemented)
- [ ] Tamper-evident audit trail if audit history is to be relied on
      (today it is an operational log only)
- [ ] A tested device-to-server recovery path for unsynchronized data
- [ ] Monitoring, alerting and an on-call process
- [ ] Legal and regulatory assessment for the jurisdiction of use
- [ ] Browser support testing beyond Chrome
