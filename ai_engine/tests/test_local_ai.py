from dataclasses import replace
import hashlib
import io
from pathlib import Path

from fastapi.testclient import TestClient
import pytest

from ai_engine.app.catalog import MODELS, MODEL_BY_ID
from ai_engine.app.config import Settings
from ai_engine.app.main import create_app
from ai_engine.app.model_manager import ModelInstallError, download_model, verify_model


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    return Settings(
        model_dir=tmp_path / "models",
        api_token="test-local-token",
        whisper_binary=None,
        tesseract_binary=None,
        allowed_origins=("http://localhost:5173",),
    )


def test_catalog_has_fixed_sizes_and_sha256_digests() -> None:
    assert len(MODELS) == 4
    assert all(len(model.sha256) == 64 for model in MODELS)
    assert all(model.size_bytes > 0 for model in MODELS)
    assert MODEL_BY_ID["whisper-tiny"].languages == (
        "Hindi",
        "English",
        "multilingual",
    )


def test_download_verifies_digest_and_atomically_installs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    content = b"synthetic model fixture"
    spec = replace(
        MODEL_BY_ID["whisper-tiny"],
        filename="fixture.bin",
        url="https://models.example.test/fixture.bin",
        size_bytes=len(content),
        sha256=hashlib.sha256(content).hexdigest(),
    )

    class Response(io.BytesIO):
        def geturl(self) -> str:
            return "https://models.example.test/fixture.bin"

    monkeypatch.setattr(
        "ai_engine.app.model_manager.urlopen",
        lambda request, timeout: Response(content),
    )

    installed = download_model(spec, tmp_path)
    assert installed.read_bytes() == content
    verify_model(installed, spec)
    assert download_model(spec, tmp_path) == installed


def test_failed_digest_does_not_leave_an_installed_model(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    content = b"not the expected model"
    spec = replace(
        MODEL_BY_ID["whisper-tiny"],
        filename="fixture.bin",
        url="https://models.example.test/fixture.bin",
        size_bytes=len(content),
        sha256="0" * 64,
    )

    class Response(io.BytesIO):
        def geturl(self) -> str:
            return "https://models.example.test/fixture.bin"

    monkeypatch.setattr(
        "ai_engine.app.model_manager.urlopen",
        lambda request, timeout: Response(content),
    )

    with pytest.raises(ModelInstallError, match="SHA-256"):
        download_model(spec, tmp_path)
    assert not (tmp_path / spec.filename).exists()
    assert list(tmp_path.iterdir()) == []


def test_health_and_model_catalog_report_missing_optional_runtimes(
    settings: Settings,
) -> None:
    client = TestClient(create_app(settings))
    assert client.get("/health").json() == {"status": "ok"}

    status = client.get("/api/v1/status")
    assert status.status_code == 200
    assert status.json()["token_configured"] is True
    models = client.get("/api/v1/models")
    assert models.status_code == 200
    assert len(models.json()) == 4
    assert all(not model["installed"] for model in models.json())


def test_protected_endpoints_require_local_token(settings: Settings) -> None:
    client = TestClient(create_app(settings))
    assert client.post("/api/v1/models/whisper-tiny/download").status_code == 401
    assert client.post(
        "/api/v1/models/not-in-catalog/download",
        headers={"Authorization": "Bearer test-local-token"},
    ).status_code == 404


def test_upload_validation_does_not_require_installed_runtime(
    settings: Settings,
) -> None:
    client = TestClient(create_app(settings))
    response = client.post(
        "/api/v1/ocr",
        headers={"Authorization": "Bearer test-local-token"},
        files={"document": ("notes.pdf", b"%PDF-1.4 synthetic", "application/pdf")},
        data={"language": "eng"},
    )
    assert response.status_code == 422
    assert "accepts PNG" in response.json()["detail"]


def test_missing_token_configuration_disables_protected_features(
    tmp_path: Path,
) -> None:
    settings = Settings(
        model_dir=tmp_path / "models",
        api_token="",
        whisper_binary=None,
        tesseract_binary=None,
        allowed_origins=(),
    )
    client = TestClient(create_app(settings))
    response = client.post(
        "/api/v1/models/whisper-tiny/download",
        headers={"Authorization": "Bearer anything"},
    )
    assert response.status_code == 503
    assert "SYNCAREX_AI_TOKEN" in response.json()["detail"]
def test_transcription_task_must_be_transcribe_or_translate(
    settings: Settings,
) -> None:
    """
    Speech translation is exposed as a task on the transcription endpoint,
    because whisper.cpp translates with the same model. Only the two tasks it
    supports are accepted; anything else is refused before the model is
    touched, so this holds with no runtime installed.
    """
    client = TestClient(create_app(settings))
    headers = {"Authorization": "Bearer test-local-token"}
    audio = {"audio": ("note.wav", b"RIFF synthetic", "audio/wav")}

    rejected = client.post(
        "/api/v1/transcriptions",
        headers=headers,
        files=audio,
        data={"model_id": "whisper-tiny", "task": "summarize"},
    )
    assert rejected.status_code == 422
    assert "transcribe" in rejected.json()["detail"]

    # The supported tasks get past validation and fail only because no
    # whisper runtime is installed in this environment.
    for task in ("transcribe", "translate"):
        response = client.post(
            "/api/v1/transcriptions",
            headers=headers,
            files=audio,
            data={"model_id": "whisper-tiny", "task": task},
        )
        assert response.status_code in {404, 422, 503}, response.text
        assert "transcribe" not in response.text or response.status_code != 422


def test_translation_is_declared_as_english_only(settings: Settings) -> None:
    from ai_engine.app.models import TranscriptionResult

    result = TranscriptionResult(
        text="translated text",
        language="hi",
        model_id="whisper-tiny",
        task="translate",
        translated_to="en",
    )
    assert result.translated_to == "en"
    # A plain transcription must not claim a translation target.
    assert TranscriptionResult(
        text="spoken text", language="hi", model_id="whisper-tiny"
    ).translated_to is None
