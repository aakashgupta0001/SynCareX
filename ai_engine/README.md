# Optional local AI engine

The local engine is separate from the SynCareX API. It binds to `127.0.0.1`
only, does not call a hosted AI service, and does not download anything during
startup. The browser stores source audio/images and results in encrypted
IndexedDB before any local-engine request. AI artifacts remain local and are
not synchronized or inserted into clinical notes automatically.

## Start the engine

Create the repository Python environment and install `backend/requirements.txt`
first. Then run from PowerShell at the repository root:

```powershell
.\ai_engine\run_local.ps1
```

The script generates a random process-scoped bearer token and prints it once.
Paste it into the AI workspace. The frontend keeps the token in page memory
only. Keep the service terminal open; closing it stops the engine and invalidates
the token. Only the Vite origins `localhost:5173` and `127.0.0.1:5173` are
allowed by default. For another trusted frontend origin, set
`SYNCAREX_AI_ALLOWED_ORIGINS` before starting the service.

The service also supports `SYNCAREX_AI_MODEL_DIR`,
`SYNCAREX_WHISPER_BIN`, and `SYNCAREX_TESSERACT_BIN`. The model directory
defaults to `%USERPROFILE%\.syncarex\models`. Never expose this loopback service
through a LAN interface or reverse proxy.

## Runtimes and models

The catalog contains multilingual Whisper.cpp tiny/base/small models and a
small Qwen GGUF model. Catalog size and SHA-256 values were checked against
their Hugging Face model repositories. A download happens only after a user
presses the corresponding model button; installation uses a temporary file,
enforces the catalog byte limit, verifies SHA-256, then atomically renames it.
No model binary is committed or included in the PWA.

- Transcription requires a separately installed `whisper-cli` executable.
  Configure its full path with `SYNCAREX_WHISPER_BIN` when it is not on PATH.
  Mixed Hindi-English (Hinglish) uses automatic language detection and has not
  been accuracy-validated.
- OCR requires Tesseract OCR and the relevant `.traineddata` language files.
  The current interface supports image files, not PDF conversion.
- Structured extraction requires the optional CPU `llama-cpp-python` package.
  Install it explicitly with `python -m pip install -r ai_engine/requirements-optional.txt`.
- Each model declares a conservative free-RAM threshold. The engine rechecks
  current memory and verifies model integrity before every inference. It will
  refuse inference when either prerequisite is missing.

Voice and OCR outputs are plain transcription/extraction results, not clinical
interpretations. Fact extraction returns only schema-validated statements
whose evidence quotes occur verbatim in the submitted text. Every statement
still requires clinician review. The editable summary feature is constructed
only from facts the user selects and retains their source quotes; it does not
generate diagnoses, recommendations, or prescriptions.

## Current limitations

Model metadata, readiness reporting, verified downloads, encrypted local
artifacts, evidence-linked review, and optional adapters are implemented.
Actual transcription, OCR, and extraction are unavailable until their runtime
and model prerequisites are installed. This checkout has no AI model weights;
do not use real patient data. PDF OCR, background recording, model-download
resume, model deletion, and automatic artifact synchronization are not
implemented. Verify the readiness panel on the target device before any
download or inference.

Run engine tests from the repository root:

```powershell
.\.venv\Scripts\python.exe -m pytest ai_engine\tests
```
