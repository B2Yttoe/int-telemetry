param(
  [int]$PollMinutes = 30,
  [double]$MaximumWaitHoursAfterPublication = 48,
  [string]$Reason = "automatic-mlab-bigquery"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$root = Split-Path -Parent $PSScriptRoot
$reportDirectory = Join-Path $root "reports\experiment14b-prospective-external-validation-v2-utc-corrected"
$automationDirectory = Join-Path $reportDirectory "automation"
$gp0Path = Join-Path $reportDirectory "gp0-lock.json"
$resultPath = Join-Path $reportDirectory "mlab\bigquery-collector\result-lock.json"
New-Item -ItemType Directory -Force -Path $automationDirectory | Out-Null

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$safeReason = $Reason -replace "[^A-Za-z0-9._-]", "-"
$logPath = Join-Path $automationDirectory "$timestamp-$safeReason.log"

function Invoke-CheckedNpm([string]$script) {
  & npm.cmd run $script
  if ($LASTEXITCODE -ne 0) { throw "$script exited with code $LASTEXITCODE" }
}

function Sync-GoogleEnvironment {
  foreach ($name in @("GOOGLE_OAUTH_ACCESS_TOKEN", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT", "CLOUDSDK_CORE_PROJECT")) {
    foreach ($scope in @("User", "Machine")) {
      $value = [Environment]::GetEnvironmentVariable($name, $scope)
      if (-not [string]::IsNullOrWhiteSpace($value)) {
        [Environment]::SetEnvironmentVariable($name, $value, "Process")
        break
      }
    }
  }
}

Set-Location -LiteralPath $root
Start-Transcript -LiteralPath $logPath -Force | Out-Null
try {
  Write-Host "Experiment 14B v2 M-Lab BigQuery resume reason: $Reason"
  Write-Host "Started at: $((Get-Date).ToString('o'))"
  Invoke-CheckedNpm "experiment14b:v2:mlab-bigquery:freeze"
  $pollSeconds = [math]::Max(60, $PollMinutes * 60)
  $deadline = $null

  while (-not (Test-Path -LiteralPath $resultPath)) {
    if (-not (Test-Path -LiteralPath $gp0Path)) {
      Write-Host "GP0 is not locked yet; retrying in $pollSeconds seconds."
      Start-Sleep -Seconds $pollSeconds
      continue
    }
    $gp0 = Get-Content -Raw -LiteralPath $gp0Path | ConvertFrom-Json
    $availableAt = [DateTimeOffset]::Parse($gp0.windows.mlab_import_not_before)
    if ($null -eq $deadline) { $deadline = $availableAt.AddHours($MaximumWaitHoursAfterPublication) }
    if ([DateTimeOffset]::UtcNow -ge $deadline) {
      Write-Host "M-Lab bounded wait expired at $($deadline.ToString('o')); evidence remains pending."
      break
    }
    if ([DateTimeOffset]::UtcNow -lt $availableAt) {
      $remaining = [math]::Ceiling(($availableAt - [DateTimeOffset]::UtcNow).TotalSeconds)
      $sleepSeconds = [math]::Min($pollSeconds, [math]::Max(60, $remaining))
      Write-Host "M-Lab publication delay remains closed until $($availableAt.ToString('o')); retrying in $sleepSeconds seconds."
      Start-Sleep -Seconds $sleepSeconds
      continue
    }

    Sync-GoogleEnvironment
    & npm.cmd run experiment14b:v2:mlab-bigquery:collect
    if ($LASTEXITCODE -ne 0) {
      Write-Host "M-Lab collection attempt failed without substituting data; retrying in $pollSeconds seconds."
      Start-Sleep -Seconds $pollSeconds
      continue
    }
    if (-not (Test-Path -LiteralPath $resultPath)) {
      Write-Host "M-Lab credentials or qualifying results are not ready; retrying in $pollSeconds seconds."
      Start-Sleep -Seconds $pollSeconds
    }
  }

  Invoke-CheckedNpm "experiment14b:v2:mlab-bigquery:status"
  Invoke-CheckedNpm "experiment14b:v2:mlab:provenance:audit"
  Invoke-CheckedNpm "experiment14b:v2:pairing:audit"
  Invoke-CheckedNpm "experiment14b:v2:strict-score"
  Invoke-CheckedNpm "experiment14b:v2:completion:audit"
  Invoke-CheckedNpm "experiment14b:v2:final-evidence:audit"
  Write-Host "Finished at: $((Get-Date).ToString('o'))"
} finally {
  $env:GOOGLE_OAUTH_ACCESS_TOKEN = $null
  Stop-Transcript | Out-Null
}
