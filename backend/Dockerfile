# SynCareX full stack: FastAPI API + built PWA served same-origin by the API
# itself (SYNCAREX_SERVE_FRONTEND_DIR). One container, one URL, no reverse
# proxy hop. Build context must be the repository root.
FROM node:24-alpine AS frontend
WORKDIR /web
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ .
RUN npm run build

FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY backend/requirements.txt ./
RUN python -m pip install --no-cache-dir -r requirements.txt

COPY backend/alembic.ini ./
COPY backend/migrations ./migrations
COPY backend/app ./app
COPY --from=frontend /web/dist /app/frontend-dist

# Uploaded clinical documents live on a mounted volume, never in the image.
RUN adduser --disabled-password --gecos "" syncarex \
    && mkdir -p /var/syncarex/documents \
    && chown -R syncarex:syncarex /var/syncarex /app
USER syncarex

EXPOSE 8000

ENV SYNCAREX_SERVE_FRONTEND_DIR=/app/frontend-dist

# Migrations run before the server binds, so a fresh database is always at
# the schema the running code expects. Keep this single-instance: two
# containers racing `alembic upgrade` can deadlock on the same lock.
CMD ["sh", "-c", "alembic upgrade head && uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
