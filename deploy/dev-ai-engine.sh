#!/bin/bash
# Local AI engine start for development, with every dev origin allowed.
cd "$(dirname "$0")/.."
export SYNCAREX_AI_TOKEN="local-dev-token-123"
export SYNCAREX_AI_ALLOWED_ORIGINS="http://localhost:5173,http://127.0.0.1:5173,https://localhost:5173,https://127.0.0.1:5173,https://192.168.2.217:5173,http://192.168.2.217:5173,http://localhost:4173,http://127.0.0.1:4173"
export SYNCAREX_WHISPER_BIN="$USERPROFILE/.syncarex/bin/whisper/Release/whisper-cli.exe"
export SYNCAREX_LLAMA_BIN="$USERPROFILE/.syncarex/bin/llama/llama-cli.exe"
export SYNCAREX_TESSERACT_BIN="C:\Program Files\Tesseract-OCR\tesseract.exe"
python -m uvicorn ai_engine.app.main:app --host 127.0.0.1 --port 8765 --log-level warning
