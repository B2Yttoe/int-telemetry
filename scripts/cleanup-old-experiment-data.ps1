param(
    [switch]$Execute
)

$ErrorActionPreference = 'Stop'

$workspaceRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path.TrimEnd('\')
$reportsRoot = Join-Path $workspaceRoot 'reports'
$metadataRoot = Join-Path $reportsRoot '_compact-run-metadata'
$deleted = [System.Collections.Generic.List[object]]::new()
$retained = [System.Collections.Generic.List[object]]::new()

function Resolve-SafePath {
    param([Parameter(Mandatory)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        return $null
    }

    $resolved = (Resolve-Path -LiteralPath $Path).Path
    $prefix = $workspaceRoot + [IO.Path]::DirectorySeparatorChar
    if ($resolved -eq $workspaceRoot -or
        -not $resolved.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to operate outside the workspace: $resolved"
    }

    return $resolved
}

function Get-RelativePathSafe {
    param(
        [Parameter(Mandatory)][string]$BasePath,
        [Parameter(Mandatory)][string]$Path
    )

    $baseFull = [IO.Path]::GetFullPath($BasePath).TrimEnd('\')
    $pathFull = [IO.Path]::GetFullPath($Path)
    $prefix = $baseFull + [IO.Path]::DirectorySeparatorChar
    if (-not $pathFull.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Path is not below the requested base: $pathFull"
    }

    return $pathFull.Substring($prefix.Length)
}

function Save-CompactMetadata {
    param(
        [Parameter(Mandatory)][string]$Source,
        [Parameter(Mandatory)][string]$Label
    )

    $resolvedSource = Resolve-SafePath $Source
    if (-not $resolvedSource) {
        return
    }

    $candidatePattern = '(?i)(manifest|summary|result|report|audit|preregistration|comparison|mechanism|delta|confidence|paired|scan|metric)'
    $maxBytes = 2MB
    $copiedCount = 0
    $copiedBytes = 0L

    if (-not $Execute) {
        Write-Host "[preview metadata] $resolvedSource -> $Label"
        return
    }

    Get-ChildItem -LiteralPath $resolvedSource -Recurse -File -Force -ErrorAction SilentlyContinue |
        Where-Object { $_.Length -le $maxBytes -and $_.Name -match $candidatePattern } |
        ForEach-Object {
            $relative = Get-RelativePathSafe -BasePath $resolvedSource -Path $_.FullName
            $destination = Join-Path (Join-Path $metadataRoot $Label) $relative
            $destinationDirectory = Split-Path -Parent $destination
            New-Item -ItemType Directory -Path $destinationDirectory -Force | Out-Null
            Copy-Item -LiteralPath $_.FullName -Destination $destination -Force
            $copiedCount += 1
            $copiedBytes += $_.Length
        }

    $retained.Add([pscustomobject]@{
        source = $resolvedSource
        destination = Join-Path $metadataRoot $Label
        file_count = $copiedCount
        bytes = $copiedBytes
    })
}

function Remove-SafeTarget {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Category
    )

    $resolved = Resolve-SafePath $Path
    if (-not $resolved) {
        return
    }

    if (-not $Execute) {
        Write-Host "[preview delete][$Category] $resolved"
        return
    }

    $item = Get-Item -LiteralPath $resolved -Force
    if ($item.PSIsContainer) {
        Remove-Item -LiteralPath $resolved -Recurse -Force
    } else {
        Remove-Item -LiteralPath $resolved -Force
    }

    $deleted.Add([pscustomobject]@{
        path = $resolved
        category = $Category
    })
    Write-Host "[deleted][$Category] $resolved"
}

# Generated caches and abandoned development outputs. No formal evidence is kept here.
$temporaryTargets = @(
    (Join-Path $workspaceRoot '.tmp'),
    (Join-Path $reportsRoot '_scratch')
)

# Full historical copies replaced by current formal results. Their compact reports are retained.
$supersededTargets = @(
    (Join-Path $reportsRoot '_archive'),
    (Join-Path $reportsRoot 'experiment2-int-mc-enhanced-comparison'),
    (Join-Path $reportsRoot 'experiment12-topology-causal-48slice-pilot'),
    (Join-Path $reportsRoot 'experiment12-topology-causal-48slice-stress00-pilot'),
    (Join-Path $reportsRoot 'experiment12-unified-topology-reuse-48slice-stress00'),
    (Join-Path $reportsRoot 'experiment12-unified-topology-reuse-48slice-optimized-stress00'),
    (Join-Path $reportsRoot 'experiment12-unified-topology-reuse-48slice-optimized-v2-stress00'),
    (Join-Path $reportsRoot 'experiment12-unified-topology-reuse-48slice-final-stress00'),
    (Join-Path $reportsRoot 'experiment12-topology-reuse-contribution-48slice-stress00')
)

# Formal reports stay in place. Only their reproducible expanded runs are removed.
$formalRawTargets = @(
    (Join-Path $reportsRoot 'experiment4-leo-int-mc-ablation\runs'),
    (Join-Path $reportsRoot 'experiment6-sampling-sensitivity\runs'),
    (Join-Path $reportsRoot 'experiment8-dynamicity-causality\runs'),
    (Join-Path $reportsRoot 'experiment8-reporting-interruption-sensitivity\runs'),
    (Join-Path $reportsRoot 'experiment8-native-reference-replay\runs'),
    (Join-Path $reportsRoot 'experiment3-cpu-single-metric-completion\iridium-next-small'),
    (Join-Path $reportsRoot 'experiment3-cpu-single-metric-completion\telesat-1015-medium'),
    (Join-Path $reportsRoot 'experiment3-cpu-single-metric-completion\starlink-main-large'),
    (Join-Path $reportsRoot 'importance-aware-telemetry-48slice-medium-large\telesat-1015-medium'),
    (Join-Path $reportsRoot 'importance-aware-telemetry-48slice-medium-large\starlink-main-large')
)

foreach ($target in $temporaryTargets) {
    Remove-SafeTarget -Path $target -Category 'temporary'
}

foreach ($target in $supersededTargets) {
    $label = 'superseded\' + (Split-Path -Leaf $target)
    Save-CompactMetadata -Source $target -Label $label
    Remove-SafeTarget -Path $target -Category 'superseded'
}

foreach ($target in $formalRawTargets) {
    $relative = Get-RelativePathSafe -BasePath $reportsRoot -Path $target
    Save-CompactMetadata -Source $target -Label ('formal-raw\' + $relative)
    Remove-SafeTarget -Path $target -Category 'reproducible-formal-raw'
}

# Experiment 12 statistical evidence keeps each case's result JSON/CSV/HTML in place.
# Only the nested full planner runs and regenerated stress roots are removed.
$statisticalCases = Join-Path $reportsRoot 'experiment12-topology-reuse-statistical-evidence\cases'
if (Test-Path -LiteralPath $statisticalCases) {
    $caseRawTargets = Get-ChildItem -LiteralPath $statisticalCases -Directory -Recurse -Force |
        Where-Object {
            ($_.Name -eq 'runs' -and $_.Parent.Name -eq 'experiment12') -or
            $_.Name -eq 'stress-root'
        } |
        Select-Object -ExpandProperty FullName

    foreach ($target in $caseRawTargets) {
        $relative = Get-RelativePathSafe -BasePath $statisticalCases -Path $target
        Save-CompactMetadata -Source $target -Label ('experiment12-statistical\' + $relative)
        Remove-SafeTarget -Path $target -Category 'experiment12-expanded-case-data'
    }
}

# Keep three small canonical Stage 2 examples; all other goal/smoke runs are reproducible.
$stage2Runs = Join-Path $workspaceRoot 'stage2-int\runs'
$stage2Keep = @('reproduce-int-process', 'reproduce-48-slices', 'ml-48-traffic')
if (Test-Path -LiteralPath $stage2Runs) {
    Get-ChildItem -LiteralPath $stage2Runs -Force |
        Where-Object { $_.Name -notin $stage2Keep } |
        ForEach-Object {
            Save-CompactMetadata -Source $_.FullName -Label ('stage2-runs\' + $_.Name)
            Remove-SafeTarget -Path $_.FullName -Category 'reproducible-stage2-run'
        }
}

# Top-level report smoke files and directories are not part of formal reports.
Get-ChildItem -LiteralPath $reportsRoot -Force |
    Where-Object { $_.Name -like 'tmp-*' -or $_.Name -like 'docx-render-*' } |
    ForEach-Object {
        Remove-SafeTarget -Path $_.FullName -Category 'temporary-report-output'
    }

if ($Execute) {
    New-Item -ItemType Directory -Path $metadataRoot -Force | Out-Null
    $manifest = [ordered]@{
        cleanup_time = (Get-Date).ToString('o')
        workspace = $workspaceRoot
        policy = 'Keep code, frozen external inputs, aggregate reports, charts, manifests, and per-case summaries; remove reproducible expanded runs and superseded copies.'
        retained_metadata = $retained
        deleted_targets = $deleted
        retained_stage2_runs = $stage2Keep
    }
    $manifestPath = Join-Path $metadataRoot 'cleanup-manifest.json'
    $manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $manifestPath -Encoding utf8
    Write-Host "Cleanup manifest: $manifestPath"
    Write-Host "Deleted target count: $($deleted.Count)"
} else {
    Write-Host 'Preview complete. Re-run with -Execute to perform the cleanup.'
}
