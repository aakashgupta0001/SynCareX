# Wake all SynCareX Fly.io machines. Run whenever the cloud URL shows 502.
& "$env:USERPROFILE\.syncarex\bin\flyctl\flyctl.exe" machine start 84e4d0c2723e68 -a syncarex-pg-1de1
& "$env:USERPROFILE\.syncarex\bin\flyctl\flyctl.exe" machine start 2873455ce05e28 -a syncarex-api-1de1
& "$env:USERPROFILE\.syncarex\bin\flyctl\flyctl.exe" machine start e827171a641dd8 -a syncarex-api-1de1
Write-Host "`nWaiting 20s for machines to boot..." -ForegroundColor Cyan
Start-Sleep -Seconds 20
try {
  $health = (Invoke-WebRequest -Uri "https://syncarex-api-1de1.fly.dev/health" -UseBasicParsing -TimeoutSec 30).StatusCode
  Write-Host "Cloud app is UP: /health returned $health" -ForegroundColor Green
} catch {
  Write-Host "Still waking up - refresh the browser in 30 seconds." -ForegroundColor Yellow
}
