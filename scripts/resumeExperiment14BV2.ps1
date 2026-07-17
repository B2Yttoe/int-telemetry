param(
  [switch]$WaitForGp0,
  [switch]$TryExternal,
  [int]$PollMinutes = 15,
  [double]$MaximumWaitHours = 6,
  [string]$Reason = "manual-resume"
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

Set-Location -LiteralPath $root
Start-Transcript -LiteralPath $logPath -Force | Out-Null
try {
  Write-Host "Experiment 14B v2 resume reason: $Reason"
  Write-Host "Started at: $((Get-Date).ToString('o'))"

  & npm.cmd run experiment14b:v2:verify
  if ($LASTEXITCODE -ne 0) { throw "experiment14b:v2:verify exited with code $LASTEXITCODE" }

  $freeze = Get-Content -Raw -LiteralPath (Join-Path $reportDirectory "freeze-manifest.json") | ConvertFrom-Json
  $notBefore = [DateTimeOffset]::Parse($freeze.windows.gp0_not_before)
  if ($WaitForGp0) {
    $remaining = [math]::Ceiling(($notBefore - [DateTimeOffset]::UtcNow).TotalSeconds)
    if ($remaining -gt 0) {
      Write-Host "Waiting $remaining seconds for the frozen GP0 acquisition gate."
      Start-Sleep -Seconds $remaining
    }
  }

  $gp0Path = Join-Path $reportDirectory "gp0-lock.json"
  $deadline = $notBefore.AddHours($MaximumWaitHours)
  do {
    & npm.cmd run experiment14b:v2:gp0
    if ($LASTEXITCODE -ne 0) { throw "experiment14b:v2:gp0 exited with code $LASTEXITCODE" }
    if (Test-Path -LiteralPath $gp0Path) { break }
    if (-not $WaitForGp0 -or [DateTimeOffset]::UtcNow -ge $deadline) { break }
    $seconds = [math]::Max(60, $PollMinutes * 60)
    Write-Host "No changed, age-valid GP source is available; retrying in $seconds seconds."
    Start-Sleep -Seconds $seconds
  } while ($true)

  if ($TryExternal -and (Test-Path -LiteralPath $gp0Path)) {
    & npm.cmd run experiment14b:v2:external
    if ($LASTEXITCODE -ne 0) { throw "experiment14b:v2:external exited with code $LASTEXITCODE" }
  }

  & npm.cmd run experiment14b:v2:audit
  if ($LASTEXITCODE -ne 0) { throw "experiment14b:v2:audit exited with code $LASTEXITCODE" }
  & npm.cmd run experiment14b:v2:pairing:audit
  if ($LASTEXITCODE -ne 0) { throw "experiment14b:v2:pairing:audit exited with code $LASTEXITCODE" }
  & npm.cmd run experiment14b:v2:strict-score
  if ($LASTEXITCODE -ne 0) { throw "experiment14b:v2:strict-score exited with code $LASTEXITCODE" }
  & npm.cmd run experiment14b:v2:status
  if ($LASTEXITCODE -ne 0) { throw "experiment14b:v2:status exited with code $LASTEXITCODE" }
  & npm.cmd run experiment14b:v2:final-evidence:audit
  if ($LASTEXITCODE -ne 0) { throw "experiment14b:v2:final-evidence:audit exited with code $LASTEXITCODE" }

  Write-Host "Finished at: $((Get-Date).ToString('o'))"
} finally {
  Stop-Transcript | Out-Null
}
