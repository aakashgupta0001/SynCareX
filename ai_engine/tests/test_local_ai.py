from dataclasses import replace
import hashlib
import io
import json
from pathlib import Path
from types import SimpleNamespace

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


def test_llama_cli_produces_schema_constrained_extraction(
    settings: Settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from ai_engine.app.providers import _extract_with_llama_cli

    def run(command, **kwargs):
        assert command[command.index("--json-schema-file") + 1].endswith("schema.json")
        schema = json.loads(
            Path(command[command.index("--json-schema-file") + 1]).read_text(
                encoding="utf-8"
            )
        )
        assert schema["required"] == ["facts"]
        assert command[command.index("--no-display-prompt"):] == [
            "--no-display-prompt",
            "--single-turn",
            "--simple-io",
            "--color",
            "off",
        ]
        assert "source text" in command[command.index("-p") + 1]
        assert kwargs["timeout"] == 600
        return SimpleNamespace(
            stdout='{"facts":[]}',
            stderr="",
        )

    monkeypatch.setattr("ai_engine.app.providers.subprocess.run", run)
    content = _extract_with_llama_cli(
        "llama-cli.exe",
        settings.model_dir / "model.gguf",
        "Synthetic source text",
    )
    assert content == '{"facts":[]}'


def test_llama_cli_output_parser_skips_runtime_diagnostics() -> None:
    from ai_engine.app.providers import _json_object_from_output

    assert _json_object_from_output(
        "loading model...\nassistant:\n{\"facts\":[]}\n"
    ) == '{"facts":[]}'


def test_llama_cli_is_detected_when_python_bindings_are_unavailable(
    settings: Settings,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from ai_engine.app.readiness import runtime_paths

    binary = tmp_path / "llama-cli.exe"
    binary.touch()
    monkeypatch.setattr("ai_engine.app.readiness.importlib.util.find_spec", lambda _: None)
    configured = replace(settings, llama_binary=str(binary))

    assert runtime_paths(configured)["llama"] == str(binary)


def test_extraction_dispatches_to_cli_and_validates_evidence(
    settings: Settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from ai_engine.app.catalog import MODEL_BY_ID
    from ai_engine.app.providers import extract_facts

    source = "Synthetic note: patient reports headache."
    expected = json.dumps(
        {
            "facts": [
                {
                    "category": "symptom",
                    "value": "headache",
                    "evidence": "reports headache",
                    "confidence": 0.9,
                }
            ]
        }
    )
    monkeypatch.setattr(
        "ai_engine.app.providers.importlib.util.find_spec", lambda _: None
    )
    monkeypatch.setattr(
        "ai_engine.app.providers._require_model",
        lambda *_: (MODEL_BY_ID["qwen-0.5b-q4"], settings.model_dir / "model.gguf"),
    )
    monkeypatch.setattr(
        "ai_engine.app.providers.runtime_paths",
        lambda _: {"llama": "llama-cli.exe"},
    )
    monkeypatch.setattr(
        "ai_engine.app.providers._extract_with_llama_cli",
        lambda *_: expected,
    )

    result = extract_facts(settings, "qwen-0.5b-q4", source)

    assert result.requires_review is True
    assert result.model_id == "qwen-0.5b-q4"
    assert result.facts[0].evidence == "reports headache"


def test_webm_transcription_converts_audio_before_whisper(
    settings: Settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from ai_engine.app.catalog import MODEL_BY_ID
    from ai_engine.app.providers import transcribe

    whisper_model = MODEL_BY_ID["whisper-tiny"]
    model_path = settings.model_dir / whisper_model.filename
    monkeypatch.setattr(
        "ai_engine.app.providers._require_model",
        lambda *_: (whisper_model, model_path),
    )
    monkeypatch.setattr(
        "ai_engine.app.providers.runtime_paths",
        lambda _: {
            "whisper": "whisper-cli.exe",
            "ffmpeg": "ffmpeg.exe",
            "llama": None,
            "tesseract": None,
        },
    )
    commands: list[list[str]] = []

    def run(command, **_kwargs):
        commands.append(command)
        if command[0] == "ffmpeg.exe":
            Path(command[-1]).write_bytes(b"synthetic wav")
        elif command[0] == "whisper-cli.exe":
            output_prefix = Path(command[command.index("-of") + 1])
            output_prefix.with_suffix(".json").write_text(
                json.dumps(
                    {
                        "transcription": [{"text": "synthetic spoken text"}],
                        "result": {"language": "en"},
                    }
                ),
                encoding="utf-8",
            )
        return SimpleNamespace(stdout="", stderr="")

    monkeypatch.setattr("ai_engine.app.providers.subprocess.run", run)
    result = transcribe(
        settings,
        "whisper-tiny",
        "auto",
        "recording.webm",
        b"synthetic webm",
        task="translate",
    )

    assert result.text == "synthetic spoken text"
    assert result.translated_to == "en"
    assert commands[0][0] == "ffmpeg.exe"
    assert commands[0][commands[0].index("-ar") + 1] == "16000"
    assert commands[1][commands[1].index("-f") + 1].endswith("converted.wav")
    assert "-tr" in commands[1]
