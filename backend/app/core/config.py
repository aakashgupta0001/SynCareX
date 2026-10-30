from functools import lru_cache
from pathlib import Path

from pydantic import Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# Published in this repository, so it is only ever usable in development.
# Production startup refuses it by value, not by length.
DEVELOPMENT_JWT_SECRET = "development-only-change-before-deployment"
DEVELOPMENT_DATABASE_URL = "sqlite:///./syncarex.db"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=Path(__file__).resolve().parents[3] / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    app_env: str = "development"
    api_host: str = "127.0.0.1"
    api_port: int = 8000
    frontend_origins: list[str] = Field(
        default_factory=lambda: [
            "http://localhost:5173",
            "http://127.0.0.1:5173",
            "http://localhost:4173",
            "http://127.0.0.1:4173",
        ]
    )
    database_url: str = "sqlite:///./syncarex.db"
    jwt_secret: SecretStr = SecretStr(DEVELOPMENT_JWT_SECRET)
    access_token_minutes: int = Field(default=15, ge=1, le=60)
    refresh_token_days: int = Field(default=14, ge=1, le=90)
    cookie_secure: bool = False
    seed_admin_email: str = "admin@syncarex.example.com"
    seed_admin_password: SecretStr | None = None

    # Offline engine
    offline_grace_days: int = Field(default=7, ge=1, le=90)
    document_storage_dir: Path = Path(__file__).resolve().parents[2] / "var" / "documents"
    max_document_bytes: int = Field(default=10 * 1024 * 1024, ge=1024, le=100 * 1024 * 1024)
    allowed_document_types: list[str] = Field(
        default_factory=lambda: [
            "image/png",
            "image/jpeg",
            "image/webp",
            "application/pdf",
        ]
    )
    # Maximum operations a device may push in one request.
    sync_batch_limit: int = Field(default=50, ge=1, le=500)
    # Maximum change-feed entries a device may pull in one page. This is
    # deliberately separate from the push limit: pulling is a read of the
    # server's own feed and is paged by cursor.
    sync_pull_limit: int = Field(default=200, ge=1, le=1000)

    @field_validator("frontend_origins")
    @classmethod
    def reject_wildcard_origins(cls, origins: list[str]) -> list[str]:
        if not origins or "*" in origins:
            raise ValueError("Configure one or more explicit frontend origins")
        return origins

    @property
    def is_production(self) -> bool:
        return self.app_env.lower() == "production"

    @model_validator(mode="after")
    def validate_production_secrets(self) -> "Settings":
        """
        Production must fail to start rather than run on development
        defaults. Each check below corresponds to a credential that would
        otherwise be publicly known.
        """
        if not self.is_production:
            return self

        secret = self.jwt_secret.get_secret_value()
        if secret == DEVELOPMENT_JWT_SECRET:
            raise ValueError(
                "JWT_SECRET is still the development default. Generate a unique "
                "secret before starting in production."
            )
        if len(secret) < 32:
            raise ValueError("JWT_SECRET must be at least 32 characters in production")
        if not self.cookie_secure:
            raise ValueError("COOKIE_SECURE must be enabled in production")
        if self.database_url == DEVELOPMENT_DATABASE_URL:
            raise ValueError(
                "DATABASE_URL is still the development SQLite default. Configure "
                "the production database explicitly."
            )
        if self.seed_admin_password is not None:
            raise ValueError(
                "SEED_ADMIN_PASSWORD must not be set in production; seed accounts "
                "are a development convenience."
            )
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
