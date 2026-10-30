$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$runtimeRoot = Join-Path $env:USERPROFILE ".syncarex\bin"
New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null

function Install-VerifiedRuntime {
  param(
    [string]$Name,
    [string]$Url,
    [string]$Sha256,
    [string]$Executable
  )

  $target = Join-Path $runtimeRoot $Name
  if (Test-Path $target) {
    if (Test-Path (Join-Path $target $Executable)) {
      Write-Host "$Name is already installed in $target"
      return
    }
    throw "Refusing to overwrite an incomplete runtime directory: $target"
  }

  $staging = Join-Path $env:TEMP ("syncarex-" + [guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Path $staging | Out-Null
  try {
    $archive = Join-Path $staging "runtime.zip"
    & curl.exe -L --fail --silent --show-error --max-time 180 --output $archive $Url
    if ($LASTEXITCODE -ne 0) {
      throw "Could not download the $Name runtime."
    }
    $actualHash = (Get-FileHash -Algorithm SHA256 $archive).Hash.ToLowerInvariant()
    if ($actualHash -ne $Sha256) {
      throw "SHA-256 verification failed for the $Name runtime."
    }
    $unpacked = Join-Path $staging "unpacked"
    Expand-Archive -LiteralPath $archive -DestinationPath $unpacked
    if (-not (Test-Path (Join-Path $unpacked $Executable))) {
      throw "The $Name archive did not contain its expected executable."
    }
    Move-Item -LiteralPath $unpacked -Destination $target
    Write-Host "Installed $Name under $target"
  } finally {
    if (Test-Path $staging) {
      Remove-Item -LiteralPath $staging -Recurse -Force
    }
  }
}

Install-VerifiedRuntime `
  -Name "whisper" `
  -Url "https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip" `
  -Sha256 "6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb" `
  -Executable "Release\whisper-cli.exe"

Install-VerifiedRuntime `
  -Name "llama" `
  -Url "https://github.com/ggml-org/llama.cpp/releases/download/b12015/llama-b12015-bin-win-cpu-x64.zip" `
  -Sha256 "f3a0097934526c7c937fbe33b8352ee305aa6605cceef1744427a84686edbc48" `
  -Executable "llama-cli.exe"

if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
  throw "Install Tesseract OCR and FFmpeg manually; winget was not found."
}

if (-not (Test-Path (Join-Path $env:ProgramFiles "Tesseract-OCR\tesseract.exe"))) {
  & winget install --id UB-Mannheim.TesseractOCR --exact --silent --accept-package-agreements --accept-source-agreements --disable-interactivity
  if ($LASTEXITCODE -ne 0) {
    throw "Tesseract OCR installation failed."
  }
}

$ffmpegLink = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Links\ffmpeg.exe"
$ffmpegPackage = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe"
$ffmpegExecutable = Get-ChildItem $ffmpegPackage -Filter "ffmpeg.exe" -File -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue) -and -not (Test-Path $ffmpegLink) -and -not $ffmpegExecutable) {
  & winget install --id Gyan.FFmpeg --exact --silent --accept-package-agreements --accept-source-agreements --disable-interactivity
  if ($LASTEXITCODE -ne 0) {
    throw "FFmpeg installation failed."
  }
  $ffmpegExecutable = Get-ChildItem $ffmpegPackage -Filter "ffmpeg.exe" -File -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
}

if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue) -and -not (Test-Path $ffmpegLink) -and -not $ffmpegExecutable) {
  throw "FFmpeg was installed but its executable could not be located."
}

Write-Host "Local AI runtimes are installed. Run .\ai_engine\run_local.ps1, then download models from the AI workspace."
