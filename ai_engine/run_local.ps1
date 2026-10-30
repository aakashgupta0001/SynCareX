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

$runtimeRoot = Join-Path $env:USERPROFILE ".syncarex\bin"
$runtimeDefaults = @{
  SYNCAREX_WHISPER_BIN = Join-Path $runtimeRoot "whisper\Release\whisper-cli.exe"
  SYNCAREX_LLAMA_BIN = Join-Path $runtimeRoot "llama\llama-cli.exe"
  SYNCAREX_TESSERACT_BIN = Join-Path $env:ProgramFiles "Tesseract-OCR\tesseract.exe"
}
foreach ($name in $runtimeDefaults.Keys) {
  if (-not (Get-Item "Env:$name" -ErrorAction SilentlyContinue) -and (Test-Path $runtimeDefaults[$name])) {
    Set-Item "Env:$name" $runtimeDefaults[$name]
  }
}
if (-not $env:SYNCAREX_FFMPEG_BIN) {
  $ffmpeg = Get-Command ffmpeg -ErrorAction SilentlyContinue
  if ($ffmpeg) {
    $env:SYNCAREX_FFMPEG_BIN = $ffmpeg.Source
  } else {
    $wingetFfmpeg = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Links\ffmpeg.exe"
    if (Test-Path $wingetFfmpeg) {
      $env:SYNCAREX_FFMPEG_BIN = $wingetFfmpeg
    } else {
      $packageRoot = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe"
      $installedFfmpeg = Get-ChildItem $packageRoot -Filter "ffmpeg.exe" -File -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($installedFfmpeg) {
        $env:SYNCAREX_FFMPEG_BIN = $installedFfmpeg.FullName
      }
    }
  }
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
