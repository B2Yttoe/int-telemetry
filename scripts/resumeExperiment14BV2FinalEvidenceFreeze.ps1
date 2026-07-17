param(
  [int]$PollMinutes = 1,
  [double]$MaximumWaitHours = 8,
  [string]$Reason = "automatic-final-evidence-freeze"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$root = Split-Path -Parent $PSScriptRoot
$reportDirectory = Join-Path $root "reports\experiment14b-prospective-external-validation-v2-utc-corrected"
$automationDirectory = Join-Path $reportDirectory "automation"
$gp0Path = Join-Path $reportDirectory "gp0-lock.json"
$queryLockPath = Join-Path $reportDirectory "mlab\query-semantics-correction\query-lock.json"
$finalFreezePath = Join-Path $reportDirectory "final-evidence-chain-addendum\freeze.json"
$futureResultPaths = @(
  (Join-Path $reportDirectory "gp1-lock.json"),
  (Join-Path $reportDirectory "radar\radar-prospective-score.json"),
  (Join-Path $reportDirectory "ripe-public-fixed-anchor\result-lock.json"),
  (Join-Path $reportDirectory "mlab\bigquery-collector\result-lock.json")
)

New-Item -ItemType Directory -Force -Path $automationDirectory | Out-Null
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$safeReason = $Reason -replace "[^A-Za-z0-9._-]", "-"
$logPath = Join-Path $automationDirectory "final-evidence-freeze-$timestamp-$safeReason.log"
$deadline = [DateTimeOffset]::UtcNow.AddHours($MaximumWaitHours)
$pollSeconds = [math]::Max(30, $PollMinutes * 60)

function Write-Log([string]$Message) {
  $line = "[$([DateTimeOffset]::UtcNow.ToString('o'))] $Message"
  Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8
}

try {
  Set-Location -LiteralPath $root
  Write-Log "Waiting for GP0 and corrected M-Lab query locks."

  while (-not ((Test-Path -LiteralPath $gp0Path) -and (Test-Path -LiteralPath $queryLockPath))) {
    if ([DateTimeOffset]::UtcNow -ge $deadline) {
      throw "Timed out before GP0 and query locks became available."
    }
    Start-Sleep -Seconds $pollSeconds
  }

  if (Test-Path -LiteralPath $finalFreezePath) {
    Write-Log "Final evidence chain is already frozen; auditing it instead."
    & npm.cmd run experiment14b:v2:final-evidence:audit *>> $logPath
    if ($LASTEXITCODE -ne 0) { throw "Existing final evidence audit failed with code $LASTEXITCODE." }
    exit 0
  }

  $prematureResults = @($futureResultPaths | Where-Object { Test-Path -LiteralPath $_ })
  if ($prematureResults.Count -gt 0) {
    throw "Future result artifacts appeared before the final evidence freeze: $($prematureResults -join ', ')"
  }

  Write-Log "GP0 and query locks are present; freezing the final evidence chain."
  & npm.cmd run experiment14b:v2:final-evidence:freeze *>> $logPath
  if ($LASTEXITCODE -ne 0) { throw "Final evidence freeze failed with code $LASTEXITCODE." }

  & npm.cmd run experiment14b:v2:final-evidence:audit *>> $logPath
  if ($LASTEXITCODE -ne 0) { throw "Final evidence audit failed with code $LASTEXITCODE." }
  Write-Log "Final evidence chain freeze completed."
}
catch {
  Write-Log "ERROR: $($_.Exception.Message)"
  throw
}
