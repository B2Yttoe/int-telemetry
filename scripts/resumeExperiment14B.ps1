param(
  [string]$Reason = "manual-resume"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$root = Split-Path -Parent $PSScriptRoot
$reportDirectory = Join-Path $root "reports\experiment14b-prospective-external-validation"
$logDirectory = Join-Path $reportDirectory "automation"
New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$safeReason = $Reason -replace "[^A-Za-z0-9._-]", "-"
$logPath = Join-Path $logDirectory "$timestamp-$safeReason.log"

Set-Location -LiteralPath $root
Start-Transcript -LiteralPath $logPath -Force | Out-Null
try {
  Write-Host "Experiment 14B resume reason: $Reason"
  Write-Host "Started at: $((Get-Date).ToString('o'))"
  & npm.cmd run experiment14b:dependencies:verify
  if ($LASTEXITCODE -ne 0) { throw "experiment14b:dependencies:verify exited with code $LASTEXITCODE" }
  & npm.cmd run experiment14b:source:preflight
  if ($LASTEXITCODE -ne 0) { throw "experiment14b:source:preflight exited with code $LASTEXITCODE" }

  $lifecycleDirectory = Join-Path $reportDirectory "source-lifecycle"
  $lockPath = Join-Path $lifecycleDirectory "orbit-input-lock.json"
  $preflightPath = Join-Path $lifecycleDirectory "orbit-input-preflight-state.json"
  $inputReady = Test-Path -LiteralPath $lockPath
  if (-not $inputReady -and (Test-Path -LiteralPath $preflightPath)) {
    $preflight = Get-Content -Raw -LiteralPath $preflightPath | ConvertFrom-Json
    $inputReady = [bool]$preflight.ready
  }
  if (-not $inputReady) {
    Write-Host "A changed post-freeze GP version is not available yet; no topology was generated."
    & npm.cmd run experiment14b:audit
    if ($LASTEXITCODE -ne 0) { throw "experiment14b:audit exited with code $LASTEXITCODE" }
    return
  }

  if (-not (Test-Path -LiteralPath $lockPath)) {
    & npm.cmd run experiment14b:collect
    if ($LASTEXITCODE -ne 0) { throw "experiment14b:collect exited with code $LASTEXITCODE" }
    $collectionPath = Join-Path $reportDirectory "collection-status.json"
    $collection = Get-Content -Raw -LiteralPath $collectionPath | ConvertFrom-Json
    if (-not [bool]$collection.sources.orbit_input.input_ready) {
      & npm.cmd run experiment14b:orbit:failover
      if ($LASTEXITCODE -ne 0) { throw "experiment14b:orbit:failover exited with code $LASTEXITCODE" }
    }
    & npm.cmd run experiment14b:score
    if ($LASTEXITCODE -ne 0) { throw "experiment14b:score exited with code $LASTEXITCODE" }
    & npm.cmd run experiment14b:source:lock
    if ($LASTEXITCODE -ne 0) { throw "experiment14b:source:lock exited with code $LASTEXITCODE" }
  } else {
    & npm.cmd run experiment14b:source:remaining
    if ($LASTEXITCODE -ne 0) { throw "experiment14b:source:remaining exited with code $LASTEXITCODE" }
    & npm.cmd run experiment14b:score
    if ($LASTEXITCODE -ne 0) { throw "experiment14b:score exited with code $LASTEXITCODE" }
  }
  & npm.cmd run experiment14b:mlab:score
  if ($LASTEXITCODE -ne 0) { throw "experiment14b:mlab:score exited with code $LASTEXITCODE" }
  & npm.cmd run experiment14b:audit
  if ($LASTEXITCODE -ne 0) { throw "experiment14b:audit exited with code $LASTEXITCODE" }
  Write-Host "Finished at: $((Get-Date).ToString('o'))"
} finally {
  Stop-Transcript | Out-Null
}
