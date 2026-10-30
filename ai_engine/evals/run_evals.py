"""Runs the golden evaluation set against the local AI engine.

This is the harness behind the accuracy table the pilot review needs:

    python -m ai_engine.evals.run_evals --task all

- Speech rows are transcribed and scored with WER.
- Document rows are OCR'd and scored with CER.
- Extraction rows are run through fact extraction and scored with
  precision/recall against the expected facts.

Everything degrades honestly: a missing whisper.cpp, Tesseract, Poppler or
model produces a "skipped" row with the reason, never a fabricated number.
Rows marked "record-manually" in the manifest are skipped by design until
someone records them. The table goes to stdout; paste it into the review doc.
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

from .metrics import cer, fact_precision_recall, wer

EVALS_DIR = Path(__file__).resolve().parent
GOLDEN_DIR = EVALS_DIR / "golden"


def _load_manifest(path: Path) -> list[dict]:
    if not path.exists():
        return []
    with path.open(encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


def _settings():
    from ai_engine.app.config import get_settings

    return get_settings()


def _transcription_model(settings) -> str | None:
    """The first installed transcription model, or None."""
    from ai_engine.app.catalog import MODELS
    from ai_engine.app.readiness import model_status

    for spec in MODELS:
        if spec.task != "transcription":
            continue
        try:
            if model_status(spec, settings, build_status(settings)).installed:
                return spec.model_id
        except OSError:
            continue
    return None


def _extraction_model(settings) -> str | None:
    from ai_engine.app.catalog import MODEL_BY_ID
    from ai_engine.app.providers import _require_model

    spec = MODEL_BY_ID.get("qwen-0.5b-q4")
    if spec is None:
        return None
    try:
        _require_model(settings, spec.model_id, "structured-extraction")
        return spec.model_id
    except Exception:
        return None


def evaluate_speech() -> list[dict]:
    from ai_engine.app.providers import ProviderUnavailable, transcribe

    settings = _settings()
    model_id = _transcription_model(settings)
    rows: list[dict] = []
    for entry in _load_manifest(GOLDEN_DIR / "speech" / "manifest.jsonl"):
        row = {
            "task": "speech",
            "id": entry["id"],
            "language": entry.get("language", "en"),
        }
        if entry.get("status") not in (None, "ok"):
            row["result"] = f"skipped: {entry['status']}"
            rows.append(row)
            continue
        wav = GOLDEN_DIR / "speech" / entry["file"]
        if not wav.exists():
            row["result"] = "skipped: audio file missing"
            rows.append(row)
            continue
        if model_id is None:
            row["result"] = "skipped: no transcription model installed"
            rows.append(row)
            continue
        try:
            started = time.perf_counter()
            result = transcribe(
                settings,
                model_id,
                entry.get("language", "en") if entry.get("language") == "en" else "auto",
                entry["file"],
                wav.read_bytes(),
                "transcribe",
            )
            elapsed = time.perf_counter() - started
            row["wer"] = round(wer(entry["reference_transcript"], result.text), 4)
            row["seconds"] = round(elapsed, 2)
            row["result"] = result.text[:80]
        except ProviderUnavailable as error:
            row["result"] = f"skipped: {error}"
        rows.append(row)
    return rows


def evaluate_documents() -> list[dict]:
    from ai_engine.app.providers import ProviderUnavailable, ocr

    settings = _settings()
    rows: list[dict] = []
    for entry in _load_manifest(GOLDEN_DIR / "documents" / "manifest.jsonl"):
        row = {"task": "documents", "id": entry["id"], "language": entry.get("language", "en")}
        image = GOLDEN_DIR / "documents" / entry["file"]
        if not image.exists():
            row["result"] = "skipped: image missing"
            rows.append(row)
            continue
        try:
            started = time.perf_counter()
            result = ocr(settings, entry["file"], "eng+hin", image.read_bytes())
            elapsed = time.perf_counter() - started
            row["cer"] = round(cer(entry["reference_text"], result.text), 4)
            row["seconds"] = round(elapsed, 2)
            row["result"] = result.text[:80].replace("\n", " / ")
        except ProviderUnavailable as error:
            row["result"] = f"skipped: {error}"
        rows.append(row)
    return rows


def evaluate_extraction() -> list[dict]:
    from ai_engine.app.providers import ProviderUnavailable, extract_facts

    settings = _settings()
    model_id = _extraction_model(settings)
    # The reference text a fact row points at: the document's expected text
    # or the speech manifest's transcript.
    speech = {row["id"]: row for row in _load_manifest(GOLDEN_DIR / "speech" / "manifest.jsonl")}
    documents = {
        row["id"]: row for row in _load_manifest(GOLDEN_DIR / "documents" / "manifest.jsonl")
    }
    rows: list[dict] = []
    for entry in _load_manifest(GOLDEN_DIR / "extraction" / "manifest.jsonl"):
        row = {"task": "extraction", "id": entry["id"], "language": entry.get("language", "en")}
        if entry.get("status") not in (None, "ok"):
            row["result"] = f"skipped: {entry['status']}"
            rows.append(row)
            continue
        if model_id is None:
            row["result"] = "skipped: extraction model not installed"
            rows.append(row)
            continue
        source_row = speech.get(entry["source_id"]) or documents.get(entry["source_id"])
        if source_row is None:
            row["result"] = "skipped: source not in manifests"
            rows.append(row)
            continue
        text = source_row.get("reference_text") or source_row.get("reference_transcript") or ""
        if not text:
            row["result"] = "skipped: source has no reference text yet"
            rows.append(row)
            continue
        try:
            started = time.perf_counter()
            result = extract_facts(settings, model_id, text)
            elapsed = time.perf_counter() - started
            scores = fact_precision_recall(entry["expected_facts"], result.facts)
            row["precision"] = round(scores.precision, 3)
            row["recall"] = round(scores.recall, 3)
            row["seconds"] = round(elapsed, 2)
            row["result"] = f"{len(result.facts)} fact(s)"
        except ProviderUnavailable as error:
            row["result"] = f"skipped: {error}"
        rows.append(row)
    return rows


def _markdown_table(rows: list[dict], metric: str) -> str:
    if not rows:
        return f"_{metric}: golden set not generated yet. Run generate_golden first._\n"
    lines = [
        f"| id | language | {metric} | seconds | result |",
        "|---|---|---|---|---|",
    ]
    scored: list[float] = []
    for row in rows:
        value = row.get(metric)
        value_cell = f"{value}" if value is not None else "—"
        if value is not None:
            scored.append(value)
        lines.append(
            f"| {row['id']} | {row.get('language', 'en')} | {value_cell} "
            f"| {row.get('seconds', '—')} | {row.get('result', '—')} |"
        )
    average = sum(scored) / len(scored) if scored else None
    lines.append(f"\n**{metric} average (scored rows only): {average if average is not None else '—'}** "
                 f"({len(scored)}/{len(rows)} rows scored)")
    return "\n".join(lines) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--task",
        choices=["speech", "documents", "extraction", "all"],
        default="all",
    )
    args = parser.parse_args()

    if args.task in ("speech", "all"):
        print("\n## Speech-to-text (WER, lower is better)\n")
        print(_markdown_table(evaluate_speech(), "wer"))
    if args.task in ("documents", "all"):
        print("\n## OCR (CER, lower is better)\n")
        print(_markdown_table(evaluate_documents(), "cer"))
    if args.task in ("extraction", "all"):
        rows = evaluate_extraction()
        print("\n## Fact extraction (precision / recall, higher is better)\n")
        if not rows:
            print("_Extraction golden set not generated yet._\n")
        else:
            lines = ["| id | language | precision | recall | seconds | result |", "|---|---|---|---|---|---|"]
            precisions = [row["precision"] for row in rows if "precision" in row]
            recalls = [row["recall"] for row in rows if "recall" in row]
            for row in rows:
                lines.append(
                    f"| {row['id']} | {row.get('language', 'en')} "
                    f"| {row.get('precision', '—')} | {row.get('recall', '—')} "
                    f"| {row.get('seconds', '—')} | {row.get('result', '—')} |"
                )
            lines.append(
                f"\n**Precision average: {sum(precisions) / len(precisions) if precisions else '—'} "
                f"· Recall average: {sum(recalls) / len(recalls) if recalls else '—'} "
                f"({len(precisions)}/{len(rows)} rows scored)**"
            )
            print("\n".join(lines) + "\n")


if __name__ == "__main__":
    main()
