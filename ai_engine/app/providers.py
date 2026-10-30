import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
from threading import Lock

from .catalog import MODEL_BY_ID
from .config import Settings
from .model_manager import verify_model
from .models import EngineStatus, ExtractionResult, OCRResult, TranscriptionResult
from .readiness import build_status, model_status, runtime_paths


_INFERENCE_LOCK = Lock()
_AUDIO_SUFFIXES = {".wav", ".mp3", ".m4a", ".ogg", ".webm", ".flac"}
_IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".tif", ".tiff", ".webp"}


class ProviderUnavailable(Exception):
    pass


def _require_model(settings: Settings, model_id: str, task: str):
    spec = MODEL_BY_ID.get(model_id)
    if spec is None or spec.task != task:
        raise ValueError(f"Unknown {task} model: {model_id}")
    status = build_status(settings)
    model = model_status(spec, settings, status)
    if not model.installed:
        raise ProviderUnavailable(model.availability_reason or "Model is not installed.")
    if not model.compatible_now:
        raise ProviderUnavailable(model.availability_reason or "Model is not ready.")
    model_path = settings.model_dir / spec.filename
    verify_model(model_path, spec)
    return spec, model_path


def transcribe(
    settings: Settings,
    model_id: str,
    language: str,
    file_name: str,
    content: bytes,
    task: str = "transcribe",
) -> TranscriptionResult:
    if len(content) > settings.max_upload_bytes:
        raise ValueError("Audio exceeds the 25 MiB local processing limit.")
    suffix = Path(file_name).suffix.lower()
    if suffix not in _AUDIO_SUFFIXES:
        raise ValueError("Choose WAV, MP3, M4A, OGG, WebM, or FLAC audio.")
    if language not in {"auto", "en", "hi"}:
        raise ValueError("Language must be auto, en, or hi.")
    spec, model_path = _require_model(settings, model_id, "transcription")
    binary = runtime_paths(settings)["whisper"]
    if not binary:
        raise ProviderUnavailable("Install whisper.cpp and configure SYNCAREX_WHISPER_BIN.")

    with tempfile.TemporaryDirectory(prefix="syncarex-audio-") as directory:
        source = Path(directory) / f"source{suffix}"
        output_prefix = Path(directory) / "transcript"
        source.write_bytes(content)
        command = [
            binary,
            "-m",
            str(model_path),
            "-f",
            str(source),
            "-oj",
            "-of",
            str(output_prefix),
            "-np",
        ]
        if language != "auto":
            command.extend(["-l", language])
        if task == "translate":
            # whisper.cpp translates to English only; there is no target
            # language option to pass.
            command.append("-tr")
        try:
            with _INFERENCE_LOCK:
                subprocess.run(
                    command,
                    capture_output=True,
                    text=True,
                    timeout=900,
                    check=True,
                )
        except subprocess.TimeoutExpired as error:
            raise ProviderUnavailable("Transcription exceeded the 15-minute limit.") from error
        except subprocess.CalledProcessError as error:
            details = (error.stderr or error.stdout or "whisper.cpp failed").strip()[-1000:]
            raise ProviderUnavailable(f"Transcription failed: {details}") from error

        result_path = output_prefix.with_suffix(".json")
        if not result_path.is_file():
            raise ProviderUnavailable("whisper.cpp did not produce its expected JSON result.")
        try:
            result = json.loads(result_path.read_text(encoding="utf-8"))
            segments = result.get("transcription")
            text = " ".join(
                str(segment.get("text", "")).strip()
                for segment in segments
                if isinstance(segment, dict)
            ).strip()
        except (json.JSONDecodeError, AttributeError, TypeError) as error:
            raise ProviderUnavailable("whisper.cpp returned an invalid transcript.") from error
        if not text:
            raise ProviderUnavailable("No speech was recognized in the selected audio.")
        detected_language = str(result.get("result", {}).get("language", language))
        return TranscriptionResult(
            text=text,
            language=detected_language,
            model_id=spec.model_id,
            task=task,
            # whisper.cpp only translates into English.
            translated_to="en" if task == "translate" else None,
        )


def ocr(
    settings: Settings,
    file_name: str,
    language: str,
    content: bytes,
) -> OCRResult:
    if len(content) > settings.max_upload_bytes:
        raise ValueError("Document exceeds the 25 MiB local processing limit.")
    suffix = Path(file_name).suffix.lower()
    if suffix not in _IMAGE_SUFFIXES:
        raise ValueError("OCR currently accepts PNG, JPEG, TIFF, or WebP images.")
    if not re.fullmatch(r"[a-z]{3}(?:\+[a-z]{3}){0,3}", language):
        raise ValueError("Use installed three-letter Tesseract language codes.")
    binary = runtime_paths(settings)["tesseract"]
    if not binary:
        raise ProviderUnavailable("Install Tesseract OCR and configure SYNCAREX_TESSERACT_BIN.")
    available = set(build_status(settings).runtimes["tesseract"].languages)
    requested = set(language.split("+"))
    if not requested.issubset(available):
        missing = ", ".join(sorted(requested - available))
        raise ProviderUnavailable(f"Tesseract language data is not installed: {missing}.")

    with tempfile.TemporaryDirectory(prefix="syncarex-ocr-") as directory:
        source = Path(directory) / f"source{suffix}"
        source.write_bytes(content)
        try:
            with _INFERENCE_LOCK:
                result = subprocess.run(
                    [binary, str(source), "stdout", "-l", language, "--psm", "3"],
                    capture_output=True,
                    text=True,
                    timeout=120,
                    check=True,
                )
        except subprocess.TimeoutExpired as error:
            raise ProviderUnavailable("OCR exceeded the two-minute limit.") from error
        except subprocess.CalledProcessError as error:
            details = (error.stderr or "Tesseract failed").strip()[-1000:]
            raise ProviderUnavailable(f"OCR failed: {details}") from error
    text = result.stdout.strip()
    if not text:
        raise ProviderUnavailable("No text was recognized in the selected image.")
    return OCRResult(text=text, language=language)


def extract_facts(settings: Settings, model_id: str, text: str) -> ExtractionResult:
    if not text.strip():
        raise ValueError("Provide transcript or OCR text to extract.")
    if len(text) > 15_000:
        raise ValueError("Extraction input must be 15,000 characters or fewer.")
    spec, model_path = _require_model(settings, model_id, "structured-extraction")
    if importlib.util.find_spec("llama_cpp") is None:
        raise ProviderUnavailable("Install the optional llama-cpp-python runtime to extract facts.")
    from llama_cpp import Llama

    prompt = (
        "Extract only explicitly stated clinical facts from the source text. "
        "Do not infer, diagnose, recommend treatment, or add facts. "
        "Return a JSON object with a 'facts' array. Each item must have "
        "'category' (symptom, allergy, medication, history, measurement, or other), "
        "'value', 'evidence' (an exact verbatim source quote), and 'confidence' "
        "(0 to 1). Return an empty array when no explicit fact is present.\n"
        f"SOURCE TEXT:\n{text}"
    )
    try:
        with _INFERENCE_LOCK:
            llm = Llama(
                model_path=str(model_path),
                n_ctx=4096,
                n_threads=max(1, min(os.cpu_count() or 1, 4)),
                n_gpu_layers=0,
                verbose=False,
            )
            response = llm.create_chat_completion(
                messages=[
                    {
                        "role": "system",
                        "content": "You extract source-grounded facts for clinician review.",
                    },
                    {"role": "user", "content": prompt},
                ],
                response_format={"type": "json_object"},
                temperature=0,
                max_tokens=1024,
            )
            content = response["choices"][0]["message"]["content"]
    except (OSError, RuntimeError, ValueError) as error:
        raise ProviderUnavailable(f"Local extraction failed: {error}") from error
    try:
        parsed = json.loads(content)
        result = ExtractionResult.model_validate(
            {"facts": parsed["facts"], "model_id": spec.model_id}
        )
    except (json.JSONDecodeError, KeyError, TypeError, ValueError) as error:
        raise ProviderUnavailable("The model returned an invalid extraction response.") from error

    source_folded = text.casefold()
    for fact in result.facts:
        if fact.evidence.casefold() not in source_folded:
            raise ProviderUnavailable(
                "The model returned evidence that does not exactly match the source. "
                "No facts were returned; review the source manually."
            )
    return result
