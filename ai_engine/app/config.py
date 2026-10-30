from dataclasses import dataclass
import os
from pathlib import Path


@dataclass(frozen=True)
class Settings:
    model_dir: Path
    api_token: str
    whisper_binary: str | None
    tesseract_binary: str | None
    allowed_origins: tuple[str, ...]
    max_upload_bytes: int = 25 * 1024 * 1024


def get_settings() -> Settings:
    model_dir = Path(
        os.environ.get(
            "SYNCAREX_AI_MODEL_DIR",
            str(Path.home() / ".syncarex" / "models"),
        )
    ).expanduser()
    origins = tuple(
        origin.strip()
        for origin in os.environ.get(
            "SYNCAREX_AI_ALLOWED_ORIGINS",
            "http://localhost:5173,http://127.0.0.1:5173",
        ).split(",")
        if origin.strip()
    )
    return Settings(
        model_dir=model_dir,
        api_token=os.environ.get("SYNCAREX_AI_TOKEN", ""),
        whisper_binary=os.environ.get("SYNCAREX_WHISPER_BIN"),
        tesseract_binary=os.environ.get("SYNCAREX_TESSERACT_BIN"),
        allowed_origins=origins,
    )
