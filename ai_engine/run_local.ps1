$ErrorActionPreference = "Stop"
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$python = Join-Path $repositoryRoot ".venv\Scripts\python.exe"

if (-not (Test-Path $python)) {
  throw "The project Python environment was not found. Create it and install backend\requirements.txt first."
}

$random = [Security.Cryptography.RandomNumberGenerator]::Create()
$bytes = New-Object byte[] 32
$random.GetBytes($bytes)
$random.Dispose()
$token = [Convert]::ToBase64String($bytes).TrimEnd("=").Replace("+", "-").Replace("/", "_")
$env:SYNCAREX_AI_TOKEN = $token

if (-not $env:SYNCAREX_AI_MODEL_DIR) {
  $env:SYNCAREX_AI_MODEL_DIR = Join-Path $env:USERPROFILE ".syncarex\models"
}

Write-Host "Local AI engine token (paste into the AI workspace; it is not saved by the browser):"
Write-Host $token
Write-Host "Listening on http://127.0.0.1:8765. Keep this terminal open."

Push-Location $repositoryRoot
try {
  & $python -m ai_engine.app.main
  exit $LASTEXITCODE
} finally {
  Pop-Location
  Remove-Item Env:SYNCAREX_AI_TOKEN -ErrorAction SilentlyContinue
}
