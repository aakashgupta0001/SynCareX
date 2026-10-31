from fastapi import FastAPI
import os
from pathlib import Path
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import audit, auth, clinical, continuity, documents, keys, patients, portal, sync
from app.core.config import get_settings

settings = get_settings()
app = FastAPI(
    title="SynCareX API",
    description=(
        "Clinical documentation API. AI-assisted content requires authorized "
        "human review; the service does not diagnose or prescribe."
    ),
    version="0.4.0",
    # The schema browser enumerates every endpoint and schema; it is a
    # development aid and is not served in production.
    openapi_url=None if settings.is_production else "/api/v1/openapi.json",
    docs_url=None if settings.is_production else "/api/v1/docs",
    redoc_url=None if settings.is_production else "/redoc",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.frontend_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)

app.include_router(auth.router, prefix="/api/v1")
app.include_router(patients.router, prefix="/api/v1")
app.include_router(audit.router, prefix="/api/v1")
app.include_router(clinical.router, prefix="/api/v1")
app.include_router(documents.router, prefix="/api/v1")
app.include_router(sync.router, prefix="/api/v1")
app.include_router(keys.router, prefix="/api/v1")
app.include_router(continuity.router, prefix="/api/v1")
app.include_router(portal.portal_router, prefix="/api/v1")
app.include_router(portal.account_router, prefix="/api/v1")


@app.get("/health", tags=["health"])
def health_check() -> dict[str, str]:
    return {"status": "ok"}


# Single-service deployments: when SYNCAREX_SERVE_FRONTEND_DIR points at a
# built PWA (frontend/dist), the API serves it same-origin. Mounted after
# every API router, so /api and /health always win over the file system.
_frontend_dir = os.environ.get("SYNCAREX_SERVE_FRONTEND_DIR", "")
if _frontend_dir and Path(_frontend_dir).is_dir():
    from fastapi.staticfiles import StaticFiles

    app.mount("/", StaticFiles(directory=_frontend_dir, html=True), name="frontend")
