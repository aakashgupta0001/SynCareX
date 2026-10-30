# SynCareX API server. Runs migrations on every start, then serves the API.
# The container reads its configuration from environment variables supplied
# by docker-compose (which reads the repository-root .env file).
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY requirements.txt ./
RUN python -m pip install --no-cache-dir -r requirements.txt

COPY alembic.ini ./
COPY migrations ./migrations
COPY app ./app

# Uploaded clinical documents live on a mounted volume, never in the image.
RUN adduser --disabled-password --gecos "" syncarex \
    && mkdir -p /var/syncarex/documents \
    && chown -R syncarex:syncarex /var/syncarex /app
USER syncarex

EXPOSE 8000

# Migrations run before the server binds, so a fresh database is always at
# the schema the running code expects. Keep this single-instance: two
# containers racing `alembic upgrade` can deadlock on the same lock.
# Render (and most hosts) set PORT for Docker services; default to 8000 for
# plain docker-compose runs.
CMD ["sh", "-c", "alembic upgrade head && uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
