# Optional local AI engine

The local engine is separate from the SynCareX API. It binds to `127.0.0.1`
only, does not call a hosted AI service, and does not download anything during
startup. The browser stores source audio/images and results in encrypted
IndexedDB before any local-engine request. AI artifacts stay on the device
that produced them, with two deliberate exceptions: a clinician-reviewed AI
summary synchronizes as its own `aiSummary` entity, and accepted facts reach
the record through the reviewed case file. Raw audio never leaves the device,
and nothing is inserted into clinical notes automatically.

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
`SYNCAREX_LLAMA_BIN`, `SYNCAREX_PDFTOPPM_BIN`, and `SYNCAREX_PDFINFO_BIN`.
On Windows, `.\ai_engine\setup_local_ai.ps1`
installs pinned, SHA-256-verified CPU builds of whisper.cpp and llama.cpp and
uses winget to install Tesseract OCR and FFmpeg. The runtime installer does
not download models; choose each model explicitly in the AI workspace. The
model directory
defaults to `%USERPROFILE%\.syncarex\models`. Never expose this loopback service
through a LAN interface or reverse proxy.

For PDF OCR, install Poppler for Windows and either add its `Library\bin`
directory to `PATH` or set the two Poppler variables to the full paths of
`pdftoppm.exe` and `pdfinfo.exe`. The default runner checks
`%USERPROFILE%\.syncarex\bin\poppler\Library\bin` automatically. The readiness
card reports whether the PDF tools are available.

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
- Accuracy is measured with the golden-set harness in `evals/` (WER for
  speech, CER for OCR, fact precision/recall for extraction — see
  `evals/README.md`). Numbers only count once `run_evals` produces them on
  real hardware; low-end device timings use the same directory's Android
  procedure plus the 4x-CPU-throttled Playwright spec.
- OCR accepts PNG, JPEG, TIFF, WebP, camera captures, and PDFs up to 10 pages.
  PDF pages are rendered one at a time by Poppler at a bounded image size.
  Tesseract 5 uses adaptive Sauvola thresholding; printed text is best supported.
  Handwriting recognition is experimental, may be inaccurate, and must be
  checked against the original. OCR requires Tesseract and the relevant
  `.traineddata` language files; PDF OCR additionally requires Poppler.
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
device; use synthetic data only. Handwriting recognition is not validated.
Model-download resume, model deletion, and automatic artifact synchronization
are not implemented.

Run engine tests from the repository root:

```powershell
.\.venv\Scripts\python.exe -m pytest ai_engine\tests
```
