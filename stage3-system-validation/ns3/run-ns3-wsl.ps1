[CmdletBinding()]
param(
  [string]$DistroName = $env:INT_TELEMETRY_WSL_DISTRO,
  [string]$Ns3Root = $(if ($env:INT_TELEMETRY_NS3_ROOT) { $env:INT_TELEMETRY_NS3_ROOT } else { "/home/$($env:USERNAME.ToLowerInvariant())/ns-allinone-3.44/ns-3.44" })
)

$ErrorActionPreference = "Stop"
$installedDistros = @(wsl.exe --list --quiet) |
  ForEach-Object { ($_ -replace "`0", "").Trim() } |
  Where-Object { $_ }
if (-not $DistroName) {
  if ($installedDistros -contains "INT-Telemetry-Debian") {
    $DistroName = "INT-Telemetry-Debian"
  } elseif ($installedDistros -contains "INT-Temerity-Debian") {
    # Keep the installed ns-3 environment usable without a risky WSL export/import rename.
    $DistroName = "INT-Temerity-Debian"
  } else {
    $DistroName = "INT-Telemetry-Debian"
  }
}
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
if ($projectRoot -notmatch "^([A-Za-z]):\\(.*)$") {
  throw "Unsupported project path for WSL conversion: $projectRoot"
}
$projectDrive = $Matches[1].ToLowerInvariant()
$projectTail = $Matches[2] -replace "\\", "/"
$projectLinux = "/mnt/$projectDrive/$projectTail"
$fixture = "$projectLinux/stage3-system-validation/fixtures/iridium-66-20slice"
$output = "$projectLinux/reports/experiment13-system-validation/ns3"
$runner = "$projectLinux/stage3-system-validation/ns3/run-ns3.sh"
$command = "cd '$projectLinux' && bash '$runner' '$Ns3Root' '$fixture' '$output'"

wsl.exe -d $DistroName -- bash -lc $command
if ($LASTEXITCODE -ne 0) { throw "Experiment 13 ns-3 run failed with exit code $LASTEXITCODE" }
node (Join-Path $projectRoot "scripts\runExperiment13SystemValidation.mjs") --phase report
if ($LASTEXITCODE -ne 0) { throw "Experiment 13 report generation failed" }
