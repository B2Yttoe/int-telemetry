[CmdletBinding()]
param(
  [string]$DistroName = $env:INT_TELEMETRY_WSL_DISTRO,
  [string]$InstallLocation = "E:\WSL\Debian",
  [string]$CacheDirectory = "E:\WSL\install-cache",
  [string]$LinuxUser = $env:USERNAME.ToLowerInvariant(),
  [int]$StartupDelaySeconds = 0
)

$ErrorActionPreference = "Stop"
$installedDistros = @(wsl.exe --list --quiet) |
  ForEach-Object { ($_ -replace "`0", "").Trim() } |
  Where-Object { $_ }
if (-not $DistroName) {
  if ($installedDistros -contains "INT-Telemetry-Debian") {
    $DistroName = "INT-Telemetry-Debian"
  } elseif ($installedDistros -contains "INT-Temerity-Debian") {
    $DistroName = "INT-Temerity-Debian"
  } else {
    $DistroName = "INT-Telemetry-Debian"
  }
}
$startupShortcutPath = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Startup\INT-Telemetry-Finish-WSL-ns3.lnk"
$LinuxUser = ($LinuxUser -replace "[^a-z0-9_-]", "")
if (-not $LinuxUser) { $LinuxUser = "ns3user" }
$logPath = "E:\WSL\finish-install.log"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$bundlePath = Join-Path $CacheDirectory "Debian-1.12.2.0.appxbundle"
$rootfsDirectory = Join-Path $CacheDirectory "debian-rootfs"
$rootfsPath = Join-Path $rootfsDirectory "install.tar.gz"
$ns3Archive = Join-Path $CacheDirectory "ns-allinone-3.44.tar.bz2"
$ns3Root = "/home/$LinuxUser/ns-allinone-3.44/ns-3.44"

function Invoke-Checked {
  param([scriptblock]$Action, [string]$Description)
  & $Action
  if ($LASTEXITCODE -ne 0) {
    throw "$Description failed with exit code $LASTEXITCODE"
  }
}

function Reset-CacheChild {
  param([string]$Path)
  $cacheFull = [IO.Path]::GetFullPath($CacheDirectory).TrimEnd("\") + "\"
  $targetFull = [IO.Path]::GetFullPath($Path)
  if (-not $targetFull.StartsWith($cacheFull, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to reset a path outside the cache: $targetFull"
  }
  if (Test-Path -LiteralPath $targetFull) {
    Remove-Item -LiteralPath $targetFull -Recurse -Force
  }
  New-Item -ItemType Directory -Path $targetFull -Force | Out-Null
}

function Ensure-DebianRootfs {
  if (Test-Path -LiteralPath $rootfsPath) { return }
  if (-not (Test-Path -LiteralPath $bundlePath)) {
    throw "Missing Debian bundle: $bundlePath"
  }
  $bundleExtract = Join-Path $CacheDirectory "debian-bundle-expanded"
  $appxExtract = Join-Path $CacheDirectory "debian-appx-expanded"
  Reset-CacheChild $bundleExtract
  Reset-CacheChild $appxExtract
  Invoke-Checked { tar.exe -xf $bundlePath -C $bundleExtract } "Debian bundle extraction"
  $x64Appx = Get-ChildItem -LiteralPath $bundleExtract -File |
    Where-Object { $_.Name -match "x64.*\.appx$" } |
    Select-Object -First 1
  if (-not $x64Appx) { throw "The Debian bundle does not contain an x64 appx" }
  Invoke-Checked { tar.exe -xf $x64Appx.FullName -C $appxExtract } "Debian x64 appx extraction"
  $foundRootfs = Get-ChildItem -LiteralPath $appxExtract -Recurse -File |
    Where-Object { $_.Name -in @("install.tar.gz", "install.tar") } |
    Select-Object -First 1
  if (-not $foundRootfs) { throw "Debian rootfs was not found in the x64 appx" }
  New-Item -ItemType Directory -Path $rootfsDirectory -Force | Out-Null
  Copy-Item -LiteralPath $foundRootfs.FullName -Destination $rootfsPath -Force
}

function Invoke-WslRoot {
  param([string]$Command, [string]$Description)
  Invoke-Checked { wsl.exe -d $DistroName --user root -- bash -lc $Command } $Description
}

function Invoke-WslUser {
  param([string]$Command, [string]$Description)
  Invoke-Checked { wsl.exe -d $DistroName --user $LinuxUser -- bash -lc $Command } $Description
}

New-Item -ItemType Directory -Path "E:\WSL" -Force | Out-Null
if ($StartupDelaySeconds -gt 0) { Start-Sleep -Seconds $StartupDelaySeconds }
Start-Transcript -LiteralPath $logPath -Append | Out-Null
try {
  if (-not (Test-Path -LiteralPath $ns3Archive)) {
    throw "Missing ns-3 archive: $ns3Archive"
  }
  Ensure-DebianRootfs

  Invoke-Checked { wsl.exe --set-default-version 2 } "Setting the WSL default version"
  $installed = @(wsl.exe --list --quiet) |
    ForEach-Object { ($_ -replace "`0", "").Trim() } |
    Where-Object { $_ }
  if ($installed -notcontains $DistroName) {
    if (Test-Path -LiteralPath $InstallLocation) {
      $entries = @(Get-ChildItem -LiteralPath $InstallLocation -Force -ErrorAction SilentlyContinue)
      if ($entries.Count -gt 0) {
        throw "Install location is not empty: $InstallLocation"
      }
    } else {
      New-Item -ItemType Directory -Path $InstallLocation -Force | Out-Null
    }
    Invoke-Checked {
      wsl.exe --import $DistroName $InstallLocation $rootfsPath --version 2
    } "Importing Debian into WSL2"
  }

  Invoke-WslRoot "id -u '$LinuxUser' >/dev/null 2>&1 || useradd -m -s /bin/bash '$LinuxUser'" "Creating the Linux user"
  Invoke-WslRoot "echo '[user]' > /etc/wsl.conf && echo 'default=$LinuxUser' >> /etc/wsl.conf && echo '[interop]' >> /etc/wsl.conf && echo 'appendWindowsPath=false' >> /etc/wsl.conf" "Configuring the default Linux user and an isolated Linux PATH"
  Invoke-Checked { wsl.exe --terminate $DistroName } "Applying the WSL distribution configuration"
  Invoke-WslRoot "sed -i '/[[:space:]]bullseye-backports[[:space:]]/d' /etc/apt/sources.list" "Removing the retired Debian 11 backports source"
  Invoke-WslRoot "apt-get update" "Refreshing Debian package indexes"
  Invoke-WslRoot "DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends build-essential cmake ninja-build python3 git pkg-config ccache ca-certificates bzip2" "Installing minimal ns-3 dependencies"

  $archiveLinux = "/mnt/e/WSL/install-cache/ns-allinone-3.44.tar.bz2"
  Invoke-WslRoot "test -d '$ns3Root' || tar -xjf '$archiveLinux' -C '/home/$LinuxUser'; chown -R '${LinuxUser}:${LinuxUser}' '/home/$LinuxUser/ns-allinone-3.44'" "Extracting ns-3.44"
  Invoke-WslUser "if grep -Eqs '/mnt/[a-z]/.*[Aa]naconda' '$ns3Root/cmake-cache/CMakeCache.txt' 2>/dev/null; then rm -rf '$ns3Root/build' '$ns3Root/cmake-cache'; fi" "Discarding a Windows-contaminated ns-3 build configuration when present"
  Invoke-WslUser "cd '$ns3Root' && ./ns3 configure --build-profile=optimized --disable-examples --disable-tests --enable-modules='core;network;internet;point-to-point'" "Configuring ns-3.44"
  Invoke-WslUser "cd '$ns3Root' && ./ns3 build" "Building ns-3.44"

  if ($projectRoot -notmatch "^([A-Za-z]):\\(.*)$") {
    throw "Unsupported project path for WSL conversion: $projectRoot"
  }
  $projectDrive = $Matches[1].ToLowerInvariant()
  $projectTail = $Matches[2] -replace "\\", "/"
  $projectLinux = "/mnt/$projectDrive/$projectTail"
  Invoke-WslUser "cp '$projectLinux/stage3-system-validation/ns3/scratch/leo-int-system-validation.cc' '$ns3Root/scratch/leo-int-system-validation.cc' && cd '$ns3Root' && ./ns3 build scratch/leo-int-system-validation" "Building the Experiment 13 ns-3 program"

  wsl.exe --set-default $DistroName | Out-Null
  [Environment]::SetEnvironmentVariable("INT_TELEMETRY_WSL_DISTRO", $DistroName, "User")
  [Environment]::SetEnvironmentVariable("INT_TELEMETRY_NS3_ROOT", $ns3Root, "User")
  $marker = [ordered]@{
    status = "complete"
    distro = $DistroName
    install_location = $InstallLocation
    linux_user = $LinuxUser
    ns3_root = $ns3Root
    completed_at = (Get-Date).ToString("o")
  } | ConvertTo-Json
  Set-Content -LiteralPath "E:\WSL\INSTALL_COMPLETE.json" -Value $marker -Encoding utf8
  Remove-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Name "INT-Telemetry-Finish-WSL-ns3" -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $startupShortcutPath -Force -ErrorAction SilentlyContinue
  Write-Output "WSL2, Debian and ns-3.44 installation completed."
} finally {
  Stop-Transcript | Out-Null
}
