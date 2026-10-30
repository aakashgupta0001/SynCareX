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
`SYNCAREX_WHISPER_BIN`, `SYNCAREX_TESSERACT_BIN`, `SYNCAREX_FFMPEG_BIN`,
and `SYNCAREX_LLAMA_BIN`. On Windows, `.\ai_engine\setup_local_ai.ps1`
installs pinned, SHA-256-verified CPU builds of whisper.cpp and llama.cpp and
uses winget to install Tesseract OCR and FFmpeg. The runtime installer does
not download models; choose each model explicitly in the AI workspace. The
model directory
defaults to `%USERPROFILE%\.syncarex\models`. Never expose this loopback service
through a LAN interface or reverse proxy.

## Runtimes and models

The catalog contains multilingual Whisper.cpp tiny/base/small models and a
small Qwen GGUF model. Catalog size and SHA-256 values were checked against
their Hugging Face model repositories. A download happens only after a user
presses the corresponding model button; installation uses a temporary file,
enforces the catalog byte limit, verifies SHA-256, then atomically renames it.
No model binary is committed or included in the PWA.

- Transcription uses the pinned CPU `whisper-cli` executable on Windows.
  Configure its full path with `SYNCAREX_WHISPER_BIN` when it is not in the
  setup script's default location or on PATH. Browser WebM/M4A recordings are
  converted to bounded, mono 16 kHz WAV by FFmpeg before inference; WAV, MP3,
  OGG and FLAC are read directly.
  Mixed Hindi-English (Hinglish) uses automatic language detection and has not
  been accuracy-validated.
- OCR requires Tesseract OCR and the relevant `.traineddata` language files.
  The current interface supports image files, not PDF conversion.
- Structured extraction uses the pinned CPU `llama-cli` executable on Windows.
  Configure `SYNCAREX_LLAMA_BIN` when it is not in the setup script's default
  location. The existing optional `llama-cpp-python` adapter remains supported
  and takes precedence when installed.
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
artifacts, evidence-linked review, and runtime adapters are implemented.
Windows setup installs CPU runtimes but does not automatically download models;
use the AI workspace's explicit download actions. Verify the readiness panel
before inference. This is an experimental documentation aid, not a medical
device; use synthetic data only. PDF OCR, model-download resume, model deletion,
and automatic artifact synchronization are not implemented.

Run engine tests from the repository root:

```powershell
.\.venv\Scripts\python.exe -m pytest ai_engine\tests
```
