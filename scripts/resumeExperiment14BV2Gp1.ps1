param(
  [int]$PollMinutes = 30,
  [double]$MaximumGp0WaitHours = 12,
  [double]$MaximumGp1SourceWaitHours = 12,
  [string]$Reason = "automatic-gp1"
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
$gp0Path = Join-Path $reportDirectory "gp0-lock.json"
$gp1Path = Join-Path $reportDirectory "gp1-lock.json"
$gp0Deadline = [DateTimeOffset]::UtcNow.AddHours($MaximumGp0WaitHours)

Set-Location -LiteralPath $root
Start-Transcript -LiteralPath $logPath -Force | Out-Null
try {
  Write-Host "Experiment 14B v2 GP1 resume reason: $Reason"
  Write-Host "Started at: $((Get-Date).ToString('o'))"
  & npm.cmd run experiment14b:v2:verify
  if ($LASTEXITCODE -ne 0) { throw "Experiment 14B v2 freeze verification failed" }

  while (-not (Test-Path -LiteralPath $gp0Path)) {
    if ([DateTimeOffset]::UtcNow -ge $gp0Deadline) {
      Write-Host "Timed out while waiting for GP0; GP1 was not requested."
      return
    }
    Start-Sleep -Seconds ([math]::Max(60, $PollMinutes * 60))
  }

  $gp0 = Get-Content -Raw -LiteralPath $gp0Path | ConvertFrom-Json
  $notBefore = [DateTimeOffset]::Parse($gp0.windows.gp1_not_before)
  $remaining = [math]::Ceiling(($notBefore - [DateTimeOffset]::UtcNow).TotalSeconds)
  if ($remaining -gt 0) {
    Write-Host "Waiting $remaining seconds for the frozen GP1 delay gate."
    Start-Sleep -Seconds $remaining
  }

  $sourceDeadline = $notBefore.AddHours($MaximumGp1SourceWaitHours)
  do {
    & npm.cmd run experiment14b:v2:gp1
    if ($LASTEXITCODE -ne 0) { throw "experiment14b:v2:gp1 exited with code $LASTEXITCODE" }
    if (Test-Path -LiteralPath $gp1Path) { break }
    if ([DateTimeOffset]::UtcNow -ge $sourceDeadline) { break }
    Start-Sleep -Seconds ([math]::Max(60, $PollMinutes * 60))
  } while ($true)

  & npm.cmd run experiment14b:v2:audit
  if ($LASTEXITCODE -ne 0) { throw "experiment14b:v2:audit exited with code $LASTEXITCODE" }
  & npm.cmd run experiment14b:v2:completion:audit
  if ($LASTEXITCODE -ne 0) { throw "experiment14b:v2:completion:audit exited with code $LASTEXITCODE" }
  & npm.cmd run experiment14b:v2:final-evidence:audit
  if ($LASTEXITCODE -ne 0) { throw "experiment14b:v2:final-evidence:audit exited with code $LASTEXITCODE" }
  Write-Host "Finished at: $((Get-Date).ToString('o'))"
} finally {
  Stop-Transcript | Out-Null
}
