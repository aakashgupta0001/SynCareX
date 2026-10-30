import json
from pathlib import Path
from types import SimpleNamespace

from fastapi.testclient import TestClient
import pytest

from ai_engine.app.catalog import MODEL_BY_ID
from ai_engine.app.config import Settings
from ai_engine.app.main import create_app
from ai_engine.app.models import SummaryResult
from ai_engine.app.providers import ProviderUnavailable
from ai_engine.app.summaries import (
    build_source_lines,
    summarize,
    summary_prompt,
    validate_summary,
    _summarize_with_llama_cli,
)


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    return Settings(
        model_dir=tmp_path / "models",
        api_token="test-local-token",
        whisper_binary=None,
        tesseract_binary=None,
        allowed_origins=("http://localhost:5173",),
    )


NEW_VISIT = "Fever since 3 days. BP 140/90 today.\nबुखार तीन दिन से है। खांसी भी है"
HISTORY = ["Recorded allergy: Penicillin; reaction: rash; severity: moderate"]


def test_source_lines_are_numbered_by_sentence_and_history() -> None:
    lines = build_source_lines(NEW_VISIT, HISTORY)
    assert [line.id for line in lines] == ["S1", "S2", "S3", "S4", "H1"]
    assert lines[1].text == "BP 140/90 today."
    # The Devanagari danda ends a sentence too.
    assert lines[2].text == "बुखार तीन दिन से है।"
    assert lines[4].text.startswith("Recorded allergy: Penicillin")


def test_source_limits_are_enforced() -> None:
    with pytest.raises(ValueError, match="6,000"):
        build_source_lines("x" * 6_001, [])
    with pytest.raises(ValueError, match="60 history"):
        build_source_lines("Fever.", ["line"] * 61)
    with pytest.raises(ValueError, match="new visit text"):
        build_source_lines("   ", [])


def test_prompt_lists_numbered_lines_and_forbids_diagnosis() -> None:
    prompt = summary_prompt(build_source_lines(NEW_VISIT, HISTORY))
    assert "[S1] Fever since 3 days." in prompt
    assert "[H1] Recorded allergy: Penicillin" in prompt
    assert "Do not diagnose" in prompt


def test_statements_without_a_real_citation_are_dropped() -> None:
    lines = build_source_lines(NEW_VISIT, HISTORY)
    content = json.dumps(
        {
            "items": [
                {"section": "presenting_complaint", "text": "Fever for 3 days", "sources": ["S1"]},
                {"section": "allergies", "text": "Penicillin allergy with rash", "sources": ["[h1]"]},
                {"section": "vitals", "text": "Pulse 120", "sources": ["S99"]},
                {"section": "diagnosis", "text": "Pneumonia", "sources": ["S1"]},
                {"section": "medications", "text": "Paracetamol", "sources": []},
            ]
        }
    )
    result = validate_summary(content, "qwen-0.5b-q4", lines)
    assert [item.text for item in result.items] == [
        "Fever for 3 days",
        "Penicillin allergy with rash",
    ]
    assert result.items[1].sources == ["H1"]
    assert result.dropped == 3
    assert result.requires_review is True


def test_numbers_and_words_missing_from_cited_lines_are_flagged() -> None:
    lines = build_source_lines(NEW_VISIT, HISTORY)
    content = json.dumps(
        {
            "items": [
                {"section": "vitals", "text": "BP 140/90", "sources": ["S2"]},
                {"section": "vitals", "text": "BP 150/100", "sources": ["S2"]},
                {"section": "presenting_complaint", "text": "Severe headache", "sources": ["S1"]},
            ]
        }
    )
    result = validate_summary(content, "qwen-0.5b-q4", lines)
    assert [item.support for item in result.items] == ["ok", "check", "check"]


def test_a_response_with_no_usable_statement_is_refused() -> None:
    lines = build_source_lines(NEW_VISIT, HISTORY)
    with pytest.raises(ProviderUnavailable, match="no statement"):
        validate_summary(json.dumps({"items": []}), "qwen-0.5b-q4", lines)
    with pytest.raises(ProviderUnavailable, match="invalid summary"):
        validate_summary("not json", "qwen-0.5b-q4", lines)


def test_llama_cli_summary_is_schema_constrained(
    settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    prompt = summary_prompt(build_source_lines(NEW_VISIT, HISTORY))

    def run(command, **kwargs):
        schema = json.loads(
            Path(command[command.index("--json-schema-file") + 1]).read_text(encoding="utf-8")
        )
        assert schema["required"] == ["items"]
        assert command[command.index("-c") + 1] == "8192"
        assert "[S1]" in command[command.index("-p") + 1]
        assert kwargs["timeout"] == 600
        return SimpleNamespace(stdout='loading...\n{"items":[]}\n', stderr="")

    monkeypatch.setattr("ai_engine.app.summaries.subprocess.run", run)
    content = _summarize_with_llama_cli("llama-cli.exe", settings.model_dir / "m.gguf", prompt)
    assert content == '{"items":[]}'


def test_summarize_dispatches_to_cli_and_validates(
    settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("ai_engine.app.summaries.importlib.util.find_spec", lambda _: None)
    monkeypatch.setattr(
        "ai_engine.app.summaries._require_model",
        lambda *_: (MODEL_BY_ID["qwen-0.5b-q4"], settings.model_dir / "model.gguf"),
    )
    monkeypatch.setattr(
        "ai_engine.app.summaries.runtime_paths", lambda _: {"llama": "llama-cli.exe"}
    )
    monkeypatch.setattr(
        "ai_engine.app.summaries._summarize_with_llama_cli",
        lambda *_: json.dumps(
            {"items": [{"section": "presenting_complaint", "text": "Fever for 3 days", "sources": ["S1"]}]}
        ),
    )
    result = summarize(settings, "qwen-0.5b-q4", NEW_VISIT, HISTORY)
    assert result.model_id == "qwen-0.5b-q4"
    assert result.items[0].support == "ok"
    assert [line.id for line in result.source_lines][-1] == "H1"


def test_summary_endpoint_requires_token_and_validates_input(
    settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    client = TestClient(create_app(settings))
    body = {"model_id": "qwen-0.5b-q4", "new_source": "Fever.", "history": []}
    assert client.post("/api/v1/summaries", json=body).status_code == 401

    headers = {"Authorization": "Bearer test-local-token"}
    too_long = {**body, "new_source": "x" * 6_001}
    assert client.post("/api/v1/summaries", json=too_long, headers=headers).status_code == 422

    canned = SummaryResult(
        items=[],
        source_lines=[],
        model_id="qwen-0.5b-q4",
    )
    monkeypatch.setattr("ai_engine.app.main.summarize", lambda *_: canned)
    ok = client.post("/api/v1/summaries", json=body, headers=headers)
    assert ok.status_code == 200
    assert ok.json()["requires_review"] is True
