param(
  [int]$PollMinutes = 10,
  [double]$MaximumWaitHours = 12,
  [string]$Reason = "automatic-public-fixed-anchor"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$root = Split-Path -Parent $PSScriptRoot
$reportDirectory = Join-Path $root "reports\experiment14b-prospective-external-validation-v2-utc-corrected"
$automationDirectory = Join-Path $reportDirectory "automation"
New-Item -ItemType Directory -Force -Path $automationDirectory | Out-Null
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$safeReason = $Reason -replace "[^A-Za-z0-9._-]", "-"
$logPath = Join-Path $automationDirectory "$timestamp-$safeReason.log"
$deadline = [DateTimeOffset]::UtcNow.AddHours($MaximumWaitHours)
$gp0Path = Join-Path $reportDirectory "gp0-lock.json"

Set-Location -LiteralPath $root
Start-Transcript -LiteralPath $logPath -Force | Out-Null
try {
  Write-Host "Experiment 14B v2 public RIPE resume reason: $Reason"
  Write-Host "Started at: $((Get-Date).ToString('o'))"
  while ($true) {
    & npm.cmd run experiment14b:v2:ripe-public:preflight
    if ($LASTEXITCODE -eq 0) { break }
    if ([DateTimeOffset]::UtcNow -ge $deadline) {
      throw "RIPE fixed-anchor preflight did not pass before the automatic retry deadline"
    }
    Write-Host "RIPE preflight failed transiently; retrying after $PollMinutes minute(s)."
    Start-Sleep -Seconds ([math]::Max(60, $PollMinutes * 60))
  }

  while (-not (Test-Path -LiteralPath $gp0Path)) {
    if ([DateTimeOffset]::UtcNow -ge $deadline) {
      Write-Host "Timed out while waiting for GP0; no RIPE result values were fetched."
      return
    }
    Start-Sleep -Seconds ([math]::Max(60, $PollMinutes * 60))
  }

  $gp0 = Get-Content -Raw -LiteralPath $gp0Path | ConvertFrom-Json
  $windowEnd = [DateTimeOffset]::Parse($gp0.windows.topology_end)
  $remaining = [math]::Ceiling(($windowEnd - [DateTimeOffset]::UtcNow).TotalSeconds)
  if ($remaining -gt 0) {
    Write-Host "Waiting $remaining seconds for the frozen topology window to finish."
    Start-Sleep -Seconds $remaining
  }

  & npm.cmd run experiment14b:v2:ripe-public:collect
  if ($LASTEXITCODE -ne 0) { throw "RIPE public fixed-anchor collection failed" }
  & npm.cmd run experiment14b:v2:pairing:audit
  if ($LASTEXITCODE -ne 0) { throw "Strict pairing audit failed" }
  & npm.cmd run experiment14b:v2:strict-score
  if ($LASTEXITCODE -ne 0) { throw "Strict external scoring failed" }
  & npm.cmd run experiment14b:v2:completion:audit
  if ($LASTEXITCODE -ne 0) { throw "Strict completion audit failed" }
  & npm.cmd run experiment14b:v2:final-evidence:audit
  if ($LASTEXITCODE -ne 0) { throw "Final evidence-chain audit failed" }
  Write-Host "Finished at: $((Get-Date).ToString('o'))"
} finally {
  Stop-Transcript | Out-Null
}
