param(
  [int]$PollMinutes = 15,
  [double]$MaximumWaitHoursAfterWindow = 24,
  [string]$Reason = "automatic-radar-prospective"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$root = Split-Path -Parent $PSScriptRoot
$reportDirectory = Join-Path $root "reports\experiment14b-prospective-external-validation-v2-utc-corrected"
$automationDirectory = Join-Path $reportDirectory "automation"
$freezePath = Join-Path $reportDirectory "freeze-manifest.json"
$gp0Path = Join-Path $reportDirectory "gp0-lock.json"
$scorePath = Join-Path $reportDirectory "radar\radar-prospective-score.json"
New-Item -ItemType Directory -Force -Path $automationDirectory | Out-Null

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$safeReason = $Reason -replace "[^A-Za-z0-9._-]", "-"
$logPath = Join-Path $automationDirectory "$timestamp-$safeReason.log"

function Get-RadarToken {
  if (-not [string]::IsNullOrWhiteSpace($env:CLOUDFLARE_API_TOKEN)) {
    return $env:CLOUDFLARE_API_TOKEN
  }
  foreach ($scope in @("User", "Machine")) {
    $value = [Environment]::GetEnvironmentVariable("CLOUDFLARE_API_TOKEN", $scope)
    if (-not [string]::IsNullOrWhiteSpace($value)) { return $value }
  }
  return ""
}

function Invoke-CheckedNpm([string]$script) {
  & npm.cmd run $script
  if ($LASTEXITCODE -ne 0) { throw "$script exited with code $LASTEXITCODE" }
}

Set-Location -LiteralPath $root
Start-Transcript -LiteralPath $logPath -Force | Out-Null
try {
  Write-Host "Experiment 14B v2 Radar resume reason: $Reason"
  Write-Host "Started at: $((Get-Date).ToString('o'))"
  Invoke-CheckedNpm "experiment14b:v2:verify"

  if (-not (Test-Path -LiteralPath $freezePath)) { throw "Missing frozen v2 manifest: $freezePath" }
  $freeze = Get-Content -Raw -LiteralPath $freezePath | ConvertFrom-Json
  $windowEnd = [DateTimeOffset]::Parse($freeze.windows.radar_test_end)
  $deadline = $windowEnd.AddHours($MaximumWaitHoursAfterWindow)
  $pollSeconds = [math]::Max(60, $PollMinutes * 60)

  while (-not (Test-Path -LiteralPath $scorePath)) {
    $now = [DateTimeOffset]::UtcNow
    if ($now -ge $deadline) {
      Write-Host "Radar bounded wait expired at $($deadline.ToString('o')); evidence remains pending."
      break
    }
    if (-not (Test-Path -LiteralPath $gp0Path)) {
      Write-Host "GP0 is not locked yet; retrying in $pollSeconds seconds."
      Start-Sleep -Seconds $pollSeconds
      continue
    }
    if ($now -lt $windowEnd) {
      $remaining = [math]::Ceiling(($windowEnd - $now).TotalSeconds)
      $sleepSeconds = [math]::Min($pollSeconds, [math]::Max(60, $remaining))
      Write-Host "Prospective Radar window is open until $($windowEnd.ToString('o')); retrying in $sleepSeconds seconds."
      Start-Sleep -Seconds $sleepSeconds
      continue
    }

    $token = Get-RadarToken
    if ([string]::IsNullOrWhiteSpace($token)) {
      Write-Host "CLOUDFLARE_API_TOKEN is unavailable in process, user, or machine scope; retrying without substituting data."
      Start-Sleep -Seconds $pollSeconds
      continue
    }

    $env:CLOUDFLARE_API_TOKEN = $token
    Invoke-CheckedNpm "experiment14b:v2:external"
    if (Test-Path -LiteralPath $scorePath) {
      Write-Host "Radar prospective score is complete and will not be recollected."
      break
    }

    $statusPath = Join-Path $reportDirectory "external-collection-status.json"
    if (Test-Path -LiteralPath $statusPath) {
      $status = Get-Content -Raw -LiteralPath $statusPath | ConvertFrom-Json
      Write-Host "Radar collection status: $($status.radar.status)"
    }
    Start-Sleep -Seconds $pollSeconds
  }

  if (Test-Path -LiteralPath $scorePath) {
    Invoke-CheckedNpm "experiment14b:v2:radar-causality:finalize"
    Invoke-CheckedNpm "experiment14b:v2:radar-causality:audit"
  }
  Invoke-CheckedNpm "experiment14b:v2:audit"
  Invoke-CheckedNpm "experiment14b:v2:pairing:audit"
  Invoke-CheckedNpm "experiment14b:v2:strict-score"
  Invoke-CheckedNpm "experiment14b:v2:completion:audit"
  Invoke-CheckedNpm "experiment14b:v2:final-evidence:audit"
  Invoke-CheckedNpm "experiment14b:v2:status"
  Write-Host "Finished at: $((Get-Date).ToString('o'))"
} finally {
  $env:CLOUDFLARE_API_TOKEN = $null
  Stop-Transcript | Out-Null
}
