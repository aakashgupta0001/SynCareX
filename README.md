# SynCareX

Accurate Records. Intelligent Care. Connected Everywhere.

SynCareX is a development foundation for offline-first clinical documentation. It stores and organizes clinician-authored information; it does not diagnose, prescribe, or recommend treatment. Use synthetic data only. This is not a production or clinically validated system.

## Implemented foundation

- **Frontend:** React, TypeScript, Vite, Tailwind CSS, React Router, Lucide icons, Vitest and Testing Library.
- **Backend:** FastAPI, Pydantic, SQLAlchemy, Alembic, Argon2id password hashing and JWT access tokens.
- **Database:** SQLite for local development by default; PostgreSQL is configurable and has a loopback-only Compose service.
- **Offline storage:** Versioned Dexie/IndexedDB stores. Patient and consultation records, clinical notes, observations, allergies, medication records, document metadata/blobs, local AI source files/results, audit details and queued payloads are encrypted with AES-GCM. The local key is derived with PBKDF2-SHA-256 and is held in memory only while unlocked.
- **PWA:** Vite PWA/Workbox manifest, service-worker generation and application-shell precaching. The production build precaches local assets and does not rely on a CDN.
- **User interface:** Login, dashboard, patient directory/create/profile/edit, consultation drafts, documents, optional AI workspace, sync center, conflict review, local integrity guardian, audit history and settings.
- **Backend API:** Login/refresh/logout/session profile, clinic-scoped patient CRUD/search/pagination, audit listing, health and OpenAPI documentation. Access control is enforced on the API.
- **Optional AI engine:** A separate loopback-only local service provides device readiness, verified model downloads, speech-to-text, image/PDF OCR, evidence-linked structured extraction, clinician review, local history retrieval and editable source-linked summaries. OCR supports camera capture, adaptive thresholding, and PDFs up to 10 pages with Poppler. Printed text is best supported; handwriting recognition is experimental. Inference is available only when the corresponding runtime and model are installed; none are bundled or downloaded automatically.

The operation queue is durable across restarts and covers patients, identifiers, consultations, clinical notes, observations, allergies, medications and documents. Push uses durable idempotency and reports per-operation outcomes; a clinic-scoped pull feed applies encrypted pages with a local checkpoint. Concurrent changes are preserved for clinician review rather than automatically merged. Document bytes are checksum-verified but transfer is whole-file, not resumable. Two-device acceptance is now verified in a real browser: two independent persistent profiles converge, and concurrent edits to the same field are preserved for clinician review (8/8 checks, `frontend/e2e/two-device-sync.spec.ts`). A PostgreSQL 16 GitHub Actions workflow applies the migrations and runs the backend suite; its first run failed before tests started because of how pytest was invoked, which is now fixed. Treat PostgreSQL as verified only once that workflow is green. Local tests still use SQLite. See [PROJECT_STATUS.md](./PROJECT_STATUS.md), the [offline engine](./docs/offline/OFFLINE_ENGINE.md) and the [synchronization design](./docs/synchronization/SYNC_ENGINE_DESIGN.md) for precise limitations.

The local integrity guardian performs explicit on-device scans for conservative
duplicate patient candidates (normalized names, limited Devanagari
transliteration, one-character variants with matching date of birth, and exact
namespaced identifiers), demographic/relationship consistency, conflicting
same-time measurements, AI source/evidence provenance, local document checksums,
and stalled sync work. Findings and review notes are encrypted in Dexie v5 and
local review actions are written to the existing best-effort audit log. Findings do not synchronize; duplicate
candidates are never merged or deleted automatically, and no server-side
supervisor escalation or merge-history workflow is implemented.

## Repository layout

```text
backend/                 FastAPI app, models, API, tests and Alembic migrations
frontend/                React PWA, tests, Dexie database and local repositories
ai_engine/               Optional loopback-only AI service, adapters and tests
docs/                    Architecture, data model, sync and security documentation
docker-compose.yml       Local PostgreSQL 17 service bound to 127.0.0.1
```

## Requirements

- Node.js 24 LTS and npm.
- Python 3.12+ (the current backend suite was run with Python 3.14.6).
- PostgreSQL 16/17 for PostgreSQL development, or use the default local SQLite database.
- Docker Desktop only if using the included PostgreSQL Compose service.

No external fonts, scripts, or model assets are required to load the frontend shell.

## Local development

### 1. Configure the backend

From the repository root, copy `.env.example` to `.env`. Keep `.env` private and replace the development JWT secret. SQLite is the default:

```text
DATABASE_URL=sqlite:///./syncarex.db
```

To use PostgreSQL, set a private password in `.env`, use a URL-encoded password in `DATABASE_URL`, and start the database from the repository root:

```powershell
docker compose up -d postgres
```

Example URL shape:

```text
DATABASE_URL=postgresql+psycopg://syncarex:<url-encoded-password>@localhost:5432/syncarex
```

Create a Python environment, install dependencies, and apply migrations from `backend/`:

```powershell
py -3.14 -m venv ..\.venv
..\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python -m alembic upgrade head
```

The initial migration has been applied and checked against the local SQLite development database. PostgreSQL startup and migration are exercised by the GitHub Actions workflow at [backend-postgres-tests.yml](./.github/workflows/backend-postgres-tests.yml); they have not yet been run locally on this machine.

Seed synthetic clinic roles and the development administrator. Set `SEED_ADMIN_PASSWORD` in the current shell to a unique password of at least 12 characters; do not put a real or reused password in source control:

```powershell
$securePassword = Read-Host "Synthetic development admin password" -AsSecureString
$passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
try {
  $env:SEED_ADMIN_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)
  python -m app.seed
} finally {
  Remove-Item Env:SEED_ADMIN_PASSWORD -ErrorAction SilentlyContinue
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
}
```

Start the API from `backend/`:

```powershell
python -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

API health: `http://127.0.0.1:8000/health`
OpenAPI UI: `http://127.0.0.1:8000/api/v1/docs`

### 2. Start the frontend

From `frontend/`:

```powershell
npm ci
npm run dev
```

The Vite development server is available at `http://localhost:5173`; the production preview uses `http://localhost:4173`. Configure `VITE_API_BASE_URL` only when the API is hosted at a different address; it defaults to `http://127.0.0.1:8000/api/v1` to match the backend's loopback bind address.

The frontend keeps access tokens in module memory and uses an HttpOnly, SameSite=Strict refresh cookie. A provisioned local vault can be unlocked offline until its configured offline session expires. Never rely on frontend role checks as authorization.

### 3. Optional local AI engine

The AI workspace works without an AI service; local patient and clinical workflows remain available. To start the optional engine, run from the repository root in PowerShell:

```powershell
.\ai_engine\run_local.ps1
```

The script generates a temporary bearer token and binds the service to
`127.0.0.1:8765`. Paste the displayed token into the AI workspace; the browser
keeps it in memory only. Model downloads require an explicit user action and
are size-limited and SHA-256 verified. Install Whisper.cpp, Tesseract, or the
optional `llama-cpp-python` runtime separately to enable their capabilities.
On Windows, `.\ai_engine\setup_local_ai.ps1` installs pinned CPU builds of
Whisper.cpp and llama.cpp plus Tesseract and FFmpeg; it does not download model
weights. PDF OCR also needs Poppler (`pdftoppm` and `pdfinfo`), configured with
`SYNCAREX_PDFTOPPM_BIN` and `SYNCAREX_PDFINFO_BIN`. The transcription flow
supports both saved audio and in-browser recordings, including Whisper's
English translation task. The PWA is responsive
and installable on mobile; its offline database is encrypted IndexedDB rather
than native SQLite. Check the device readiness panel before any model download
or inference.
Check the device readiness panel before any model download or inference. See
[local AI setup and limitations](./ai_engine/README.md).

## Database and migrations

Models use UUID primary keys and include clinics, users, roles, permissions, devices, patients, patient identifiers, consultations, audit logs and refresh sessions. Migrations live in `backend/migrations/versions/`.

```powershell
python -m alembic upgrade head
python -m alembic check
```

Use the PostgreSQL URL from `.env` before running these commands to migrate PostgreSQL. Do not run destructive migration commands against a database with valuable data.

## Tests and checks

From `frontend/`:

```powershell
npm test
npm run typecheck
npm run build
npm audit --omit=dev
```

End-to-end offline tests drive a production build in a real browser. They start their own API on port 8001 with a throwaway database, so no separate server is needed:

```powershell
npm run test:e2e
```

They use the locally installed Chrome channel, because Playwright's bundled browser download is not available in every environment. If Chrome is not installed, run `npx playwright install chromium` and remove the `channel` option in `playwright.config.ts`.

From `backend/`:

```powershell
python -m pytest
python -m alembic check
```

The frontend unit tests cover offline persistence across restarts, local search and pagination, archiving, consultation/note/document/AI-artifact workflows, queue durability and de-duplication, exponential backoff, backend-unavailable handling and recovery, conflict capture and resolution, document upload sequencing, local integrity scanning/review and persistence, vault locking, wrong passphrases, expired offline sessions and account scoping. The end-to-end suite installs the PWA, works with the network disabled, restarts the browser and synchronizes on reconnection, and measures this browser's storage and PWA capabilities. Backend tests cover health, authentication/refresh/logout, role and clinic authorization, patient CRUD/search/pagination, validation, version conflicts, synchronization idempotency, partial batches, document upload integrity and device provisioning. AI-engine tests cover catalog/readiness, token protection, upload validation, verified downloads and checksum failures; they do not simulate model inference. All tests use synthetic fixtures.

## Security and clinical-use limits

- Do not enter real patient information. This workspace has not undergone production threat modeling, penetration testing, privacy review, or clinical validation.
- The default development JWT secret and insecure development cookie settings must not be used in deployment. Production configuration requires a strong secret and secure cookies, but that alone does not make deployment production-ready.
- Local patient content and outbox payloads are encrypted. The local account index/profile metadata is not yet fully concealed from browser storage inspection.
- IndexedDB is not encrypted by the browser. SynCareX encrypts each record itself; index fields such as record identifiers and timestamps stay readable to anything with access to the browser profile. See the [offline engine threat model](./docs/offline/OFFLINE_ENGINE.md).
- No device revocation console, resumable document transfer, FHIR/ABDM integration, tamper-evident audit chain or retention process is implemented. Actual AI inference remains unavailable until its optional runtime and model prerequisites are installed and validated on the target device.
- Audit history is an operational log, not an immutable or cryptographically verifiable record.
- No compliance certification is claimed.

See [offline engine](./docs/offline/OFFLINE_ENGINE.md), [architecture](./docs/architecture/ARCHITECTURE.md), [database schema](./docs/database/DATABASE_SCHEMA.md), [sync design](./docs/synchronization/SYNC_ENGINE_DESIGN.md), [security design](./docs/security/SECURITY_DESIGN.md), and [project status](./PROJECT_STATUS.md).
