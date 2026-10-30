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
        files={"document": ("notes.docx", b"synthetic document", "application/octet-stream")},
        data={"language": "eng"},
    )
    assert response.status_code == 422
    assert "accepts PNG, JPEG, TIFF, WebP, or PDF" in response.json()["detail"]


def test_pdf_ocr_requires_poppler(settings: Settings) -> None:
    client = TestClient(create_app(settings))
    response = client.post(
        "/api/v1/ocr",
        headers={"Authorization": f"Bearer {settings.api_token}"},
        files={"document": ("notes.pdf", b"%PDF-1.4 synthetic", "application/pdf")},
        data={"language": "eng"},
    )
    assert response.status_code == 503
    assert "pdftoppm and pdfinfo" in response.json()["detail"]


def _mock_tesseract_language_status(monkeypatch) -> None:
    monkeypatch.setattr(
        "ai_engine.app.providers.build_status",
        lambda _: SimpleNamespace(
            runtimes={
                "tesseract": SimpleNamespace(languages=["eng"]),
            }
        ),
    )


def test_image_ocr_uses_tesseract_adaptive_thresholding(
    settings: Settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from ai_engine.app.providers import ocr

    _mock_tesseract_language_status(monkeypatch)
    monkeypatch.setattr(
        "ai_engine.app.providers._preprocess_image",
        lambda _source, _destination: None,
    )
    monkeypatch.setattr(
        "ai_engine.app.providers.runtime_paths",
        lambda _: {
            "tesseract": "tesseract.exe",
            "pdftoppm": None,
            "pdfinfo": None,
        },
    )
    commands: list[list[str]] = []

    def run(command, **_kwargs):
        commands.append(command)
        return SimpleNamespace(stdout="Printed text", stderr="")

    monkeypatch.setattr("ai_engine.app.providers.subprocess.run", run)

    result = ocr(settings, "scan.jpg", "eng", b"synthetic image")

    assert result.text == "Printed text"
    assert commands[0][-2:] == ["-c", "thresholding_method=2"]


def test_pdf_ocr_renders_each_page_and_returns_page_markers(
    settings: Settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from ai_engine.app.providers import ocr

    _mock_tesseract_language_status(monkeypatch)
    monkeypatch.setattr(
        "ai_engine.app.providers._preprocess_image",
        lambda _source, _destination: None,
    )
    monkeypatch.setattr(
        "ai_engine.app.providers.runtime_paths",
        lambda _: {
            "tesseract": "tesseract.exe",
            "pdftoppm": "pdftoppm.exe",
            "pdfinfo": "pdfinfo.exe",
        },
    )
    commands: list[list[str]] = []

    def run(command, **_kwargs):
        commands.append(command)
        if command[0] == "pdfinfo.exe":
            return SimpleNamespace(stdout="Pages:          2\n", stderr="")
        if command[0] == "pdftoppm.exe":
            Path(command[-1] + ".png").write_bytes(b"synthetic png")
            return SimpleNamespace(stdout="", stderr="")
        page_name = Path(command[1]).stem
        return SimpleNamespace(stdout=f"Recognized {page_name}", stderr="")

    monkeypatch.setattr("ai_engine.app.providers.subprocess.run", run)

    result = ocr(settings, "report.pdf", "eng", b"%PDF-1.4 synthetic")

    assert "--- Page 1 ---\nRecognized processed-1" in result.text
    assert "--- Page 2 ---\nRecognized processed-2" in result.text
    renders = [command for command in commands if command[0] == "pdftoppm.exe"]
    assert len(renders) == 2
    assert all(command[command.index("-scale-to") + 1] == "2500" for command in renders)
    assert all(command[-3] == "-png" for command in renders)


def test_pdf_ocr_rejects_documents_over_page_limit(
    settings: Settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from ai_engine.app.providers import ocr

    _mock_tesseract_language_status(monkeypatch)
    monkeypatch.setattr(
        "ai_engine.app.providers.runtime_paths",
        lambda _: {
            "tesseract": "tesseract.exe",
            "pdftoppm": "pdftoppm.exe",
            "pdfinfo": "pdfinfo.exe",
        },
    )
    commands: list[list[str]] = []

    def run(command, **_kwargs):
        commands.append(command)
        return SimpleNamespace(stdout="Pages:          11\n", stderr="")

    monkeypatch.setattr("ai_engine.app.providers.subprocess.run", run)

    with pytest.raises(ValueError, match="up to 10 pages"):
        ocr(settings, "long-report.pdf", "eng", b"%PDF-1.4 synthetic")
    assert len(commands) == 1
    assert commands[0][0] == "pdfinfo.exe"


def test_image_preprocessing_corrects_skew_and_writes_normalized_png(
    tmp_path: Path,
) -> None:
    from PIL import Image, ImageDraw

    from ai_engine.app.providers import _estimate_skew_angle, _preprocess_image

    image = Image.new("L", (900, 280), color=255)
    draw = ImageDraw.Draw(image)
    for y in range(45, 240, 32):
        draw.rectangle((60, y, 820, y + 4), fill=0)
        for x in range(90, 800, 28):
            draw.rectangle((x, y - 9, x + 3, y + 9), fill=0)
    skewed = image.rotate(3, expand=False, fillcolor=255)
    source = tmp_path / "skewed.png"
    destination = tmp_path / "processed.png"
    skewed.save(source)

    estimate = _estimate_skew_angle(skewed)
    _preprocess_image(source, destination)

    assert estimate == pytest.approx(-3, abs=1)
    with Image.open(destination) as processed:
        assert processed.mode == "L"
        assert processed.size != skewed.size


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


def test_llama_server_request_carries_the_json_schema(
    settings: Settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The grammar travels in the request body: the server applies the chat
    template itself and constrains only the generated text, which is the
    combination the CLI can no longer do safely."""
    import urllib.error

    from ai_engine.app.providers import _llama_server_completion

    requests: list[dict] = []

    class FakeResponse:
        def __init__(self, body: bytes, status: int = 200) -> None:
            self.body = body
            self.status = status

        def read(self) -> bytes:
            return self.body

        def __enter__(self):
            return self

        def __exit__(self, *args) -> None:
            return None

    def fake_urlopen(request, timeout=None):
        url = request if isinstance(request, str) else request.full_url
        if url.endswith("/health"):
            return FakeResponse(b'{"status":"ok"}')
        if url.endswith("/v1/chat/completions"):
            requests.append(json.loads(request.data.decode("utf-8")))
            return FakeResponse(
                json.dumps(
                    {
                        "choices": [
                            {"message": {"content": '{"facts": []}'}}
                        ]
                    }
                ).encode("utf-8")
            )
        raise urllib.error.URLError(url)

    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)

    class FakeProcess:
        def poll(self):
            return None  # still running

        def terminate(self):
            return None

        def wait(self, timeout=None):
            return 0

        def kill(self):
            return None

    monkeypatch.setattr(
        "ai_engine.app.providers._llama_server_binary",
        lambda cli: Path("llama-server.exe"),
    )
    monkeypatch.setattr(
        "ai_engine.app.providers.subprocess.Popen", lambda *a, **k: FakeProcess()
    )
    monkeypatch.setattr(
        "ai_engine.app.providers._LLAMA_SERVER_STARTUP_SECONDS", 1
    )

    content = _llama_server_completion(
        "llama-cli.exe",
        Path("model.gguf"),
        "system prompt",
        "user prompt",
        {"type": "object"},
    )

    assert content == '{"facts": []}'
    body = requests[0]
    assert body["messages"][0] == {"role": "system", "content": "system prompt"}
    assert body["messages"][1] == {"role": "user", "content": "user prompt"}
    assert body["temperature"] == 0
    assert body["response_format"]["type"] == "json_schema"
    assert body["response_format"]["json_schema"]["strict"] is True
    assert body["response_format"]["json_schema"]["schema"] == {"type": "object"}


def test_llama_server_missing_binary_is_a_clear_error(settings: Settings) -> None:
    from ai_engine.app.providers import ProviderUnavailable, _llama_server_binary

    with pytest.raises(ProviderUnavailable) as error:
        _llama_server_binary("nowhere/llama-cli.exe")
    assert "llama-server" in str(error.value)


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
        "ai_engine.app.providers._extract_via_llama_server",
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


# --------------------------------------------------------------------------
# Structured clinical summary (/api/v1/summaries)
# --------------------------------------------------------------------------

def _summary_cli_output() -> str:
    return json.dumps(
        {
            "presenting_complaint": [
                {"text": "Fever for two days.", "source_line_ids": ["transcript"]}
            ],
            "relevant_history": [
                {"text": "Known asthma.", "source_line_ids": ["note:abc", "note:ghost"]}
            ],
            "medications": [],
            "allergies": [
                {"text": "Penicillin rash.", "source_line_ids": ["allergy:xyz"]}
            ],
            "vitals": [],
            "open_questions": [],
        }
    )


def _mock_summary_cli(monkeypatch: pytest.MonkeyPatch, output: str) -> None:
    from ai_engine.app.catalog import MODEL_BY_ID

    monkeypatch.setattr(
        "ai_engine.app.providers.importlib.util.find_spec", lambda _: None
    )
    monkeypatch.setattr(
        "ai_engine.app.providers._require_model",
        lambda *_: (MODEL_BY_ID["qwen-0.5b-q4"], Path("model.gguf")),
    )
    monkeypatch.setattr(
        "ai_engine.app.providers.runtime_paths",
        lambda _: {"llama": "llama-cli.exe"},
    )
    monkeypatch.setattr(
        "ai_engine.app.providers._summarize_via_llama_server", lambda *_: output
    )


def test_summary_dispatches_to_cli_and_keeps_only_grounded_citations(
    settings: Settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from ai_engine.app.models import SummarySourceLine
    from ai_engine.app.providers import summarize

    _mock_summary_cli(monkeypatch, _summary_cli_output())

    result = summarize(
        settings,
        "qwen-0.5b-q4",
        "Patient reports fever for two days.",
        [
            SummarySourceLine(id="note:abc", text="Asthma since childhood."),
            SummarySourceLine(id="allergy:xyz", text="Penicillin rash."),
        ],
    )

    # A citation to a history line that was never sent ("note:ghost") is a
    # fabrication. The point survives on its grounded citation alone.
    assert result.requires_review is True
    assert result.model_id == "qwen-0.5b-q4"
    assert result.presenting_complaint[0].source_line_ids == ["transcript"]
    assert result.relevant_history[0].source_line_ids == ["note:abc"]
    assert result.allergies[0].text == "Penicillin rash."
    assert result.medications == []
    assert result.vitals == []
    assert result.open_questions == []


def test_summary_drops_points_with_no_grounded_citation(
    settings: Settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from ai_engine.app.models import SummarySourceLine
    from ai_engine.app.providers import summarize

    fabricated = json.dumps(
        {
            "presenting_complaint": [
                {"text": "Invented diagnosis.", "source_line_ids": ["transcript"]},
                {"text": "Pure fabrication.", "source_line_ids": ["hallucinated:id"]},
            ]
        }
    )
    _mock_summary_cli(monkeypatch, fabricated)

    result = summarize(
        settings,
        "qwen-0.5b-q4",
        "Patient reports fever.",
        [SummarySourceLine(id="note:abc", text="Asthma.")],
    )

    assert [point.text for point in result.presenting_complaint] == [
        "Invented diagnosis."
    ]


def test_summary_rejects_invalid_model_output(
    settings: Settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from ai_engine.app.models import SummarySourceLine
    from ai_engine.app.providers import ProviderUnavailable, summarize

    _mock_summary_cli(monkeypatch, "not json at all")

    with pytest.raises(ProviderUnavailable):
        summarize(
            settings,
            "qwen-0.5b-q4",
            "Patient reports fever.",
            [SummarySourceLine(id="note:abc", text="Asthma.")],
        )


def test_summary_refuses_an_empty_transcript(settings: Settings) -> None:
    from ai_engine.app.providers import summarize

    with pytest.raises(ValueError):
        summarize(settings, "qwen-0.5b-q4", "   ", [])


def test_summaries_endpoint_requires_and_accepts_the_local_token(
    settings: Settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from ai_engine.app.main import create_app

    seen: dict = {}

    def fake_summarize(_settings, model_id, transcript, history):
        seen["model_id"] = model_id
        seen["transcript"] = transcript
        seen["history"] = history
        return json.loads('{"presenting_complaint": [], "relevant_history": [], "medications": [], "allergies": [], "vitals": [], "open_questions": [], "model_id": "qwen-0.5b-q4", "requires_review": true}')

    monkeypatch.setattr("ai_engine.app.main.summarize", fake_summarize)
    client = TestClient(create_app(settings))

    refused = client.post(
        "/api/v1/summaries",
        json={"model_id": "qwen-0.5b-q4", "transcript": "Fever.", "history": []},
    )
    assert refused.status_code == 401

    ok = client.post(
        "/api/v1/summaries",
        json={
            "model_id": "qwen-0.5b-q4",
            "transcript": "Fever for two days.",
            "history": [{"id": "note:abc", "text": "Asthma."}],
        },
        headers={"Authorization": "Bearer test-local-token"},
    )
    assert ok.status_code == 200, ok.text
    body = ok.json()
    for section in (
        "presenting_complaint",
        "relevant_history",
        "medications",
        "allergies",
        "vitals",
        "open_questions",
    ):
        assert section in body
    assert body["requires_review"] is True
    assert seen["transcript"] == "Fever for two days."
    assert seen["history"][0].id == "note:abc"


def test_summaries_endpoint_rejects_an_empty_transcript(
    settings: Settings,
) -> None:
    from ai_engine.app.main import create_app

    client = TestClient(create_app(settings))
    refused = client.post(
        "/api/v1/summaries",
        json={"model_id": "qwen-0.5b-q4", "transcript": "   ", "history": []},
        headers={"Authorization": "Bearer test-local-token"},
    )
    assert refused.status_code == 422
