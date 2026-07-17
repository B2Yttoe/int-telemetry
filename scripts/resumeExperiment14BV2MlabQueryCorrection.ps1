param(
  [int]$PollMinutes = 5,
  [double]$MaximumWaitHours = 8,
  [string]$Reason = "automatic-mlab-query-correction"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$root = Split-Path -Parent $PSScriptRoot
$reportDirectory = Join-Path $root "reports\experiment14b-prospective-external-validation-v2-utc-corrected"
$automationDirectory = Join-Path $reportDirectory "automation"
$gp0Path = Join-Path $reportDirectory "gp0-lock.json"
$auditPath = Join-Path $reportDirectory "mlab\query-semantics-correction\audit.json"
New-Item -ItemType Directory -Force -Path $automationDirectory | Out-Null

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$safeReason = $Reason -replace "[^A-Za-z0-9._-]", "-"
$logPath = Join-Path $automationDirectory "$timestamp-$safeReason.log"

function Invoke-CheckedNpm([string]$script) {
  & npm.cmd run $script
  if ($LASTEXITCODE -ne 0) { throw "$script exited with code $LASTEXITCODE" }
}

Set-Location -LiteralPath $root
Start-Transcript -LiteralPath $logPath -Force | Out-Null
try {
  Write-Host "Experiment 14B v2 M-Lab query correction reason: $Reason"
  Write-Host "Started at: $((Get-Date).ToString('o'))"
  Invoke-CheckedNpm "test:experiment14b:v2:mlab-query-correction"
  Invoke-CheckedNpm "experiment14b:v2:mlab-query-correction:freeze"

  $deadline = [DateTimeOffset]::UtcNow.AddHours($MaximumWaitHours)
  $pollSeconds = [math]::Max(60, $PollMinutes * 60)
  while (-not (Test-Path -LiteralPath $gp0Path)) {
    if ([DateTimeOffset]::UtcNow -ge $deadline) {
      Write-Host "Bounded GP0 wait expired; query correction remains frozen and pending."
      return
    }
    Write-Host "GP0 is not locked yet; retrying in $pollSeconds seconds."
    Start-Sleep -Seconds $pollSeconds
  }

  Invoke-CheckedNpm "experiment14b:v2:mlab-query-correction:apply"
  Invoke-CheckedNpm "experiment14b:v2:mlab-query-correction:audit"
  $audit = Get-Content -Raw -LiteralPath $auditPath | ConvertFrom-Json
  if ($audit.evidence_status -ne "query-semantics-correction-complete") {
    throw "M-Lab query correction did not reach complete status"
  }
  Invoke-CheckedNpm "experiment14b:v2:verify"
  Write-Host "Finished at: $((Get-Date).ToString('o'))"
} finally {
  Stop-Transcript | Out-Null
}
