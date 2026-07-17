import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";

const PROFILE_CATALOG = [
  { id: "iridium-next-small", label: "Iridium NEXT 6x11", short_label: "Iridium 66", scale: "small" },
  { id: "telesat-1015-medium", label: "Telesat-1015 27x13", short_label: "Telesat 351", scale: "medium" },
  { id: "starlink-main-large", label: "Starlink main shell 72x22", short_label: "Starlink 1584", scale: "large" },
];

function argValue(args, name, fallback = "") {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  return args[index + 1] ?? fallback;
}

function numberArg(args, name, fallback) {
  const raw = argValue(args, name, "");
  if (raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function listArg(args, name, fallback) {
  return argValue(args, name, fallback.join(",")).split(",").map((item) => item.trim()).filter(Boolean);
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === '"') {
      if (quoted && next === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell);
      if (row.some((value) => value.length > 0)) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    if (row.some((value) => value.length > 0)) rows.push(row);
  }
  if (rows.length === 0) return [];
  const headers = rows[0];
  return rows.slice(1).map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
}

function csvEscape(value) {
  const text = value === undefined || value === null ? "" : String(value);
  if (!/[",\n\r]/.test(text)) return text;
  return `"${text.replaceAll('"', '""')}"`;
}

function rowsToCsv(rows) {
  if (rows.length === 0) return "";
  const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  return [
    headers.join(","),
    ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(",")),
  ].join("\n");
}

async function readCsv(path) {
  if (!existsSync(path)) return [];
  return parseCsv(await readFile(path, "utf8"));
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function numberValue(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value, digits = 4) {
  if (!Number.isFinite(value)) return 0;
  return Number(value.toFixed(digits));
}

function mean(values) {
  const usable = values.filter(Number.isFinite);
  if (usable.length === 0) return 0;
  return usable.reduce((total, value) => total + value, 0) / usable.length;
}

function formatPercent(value, digits = 2) {
  return `${(numberValue(value) * 100).toFixed(digits)}%`;
}

function formatBytes(value) {
  const bytes = numberValue(value);
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(2)} MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(2)} KB`;
  return `${bytes.toFixed(0)} B`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const BEFORE_VERSION_LABEL = "增强前 INT-MC";
const AFTER_VERSION_LABEL = "增强后 INT-MC";

const MECHANISM_COLUMN_LABELS = [
  "星座",
  "版本",
  "预算调整片数",
  "平均预算缩放因子",
  "平均有效每片路径上限",
  "元数据策略路径数",
  "平均每跳元数据字节",
  "元数据节省",
  "OAM 强制覆盖路径数",
  "OAM 目标去重",
  "OAM 目标感知采集",
  "OAM 建议重测目标",
  "局部风险路径数",
  "复用重复抑制路径数",
  "轨道周期先验样本",
  "节点电量光照先验",
  "节点电量物理先验",
  "业务热点迁移样本",
  "轨道图正则链路样本",
  "指标/状态耦合样本",
  "平均耦合压力",
];

function integerCell(value) {
  return Math.round(numberValue(value, 0)).toLocaleString("zh-CN");
}

function fixedCell(value, digits = 4) {
  if (value === "" || value === undefined || value === null) return "-";
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toFixed(digits) : "-";
}

function sumFields(row, fields) {
  return fields.reduce((total, field) => total + numberValue(row[field], 0), 0);
}

function meanFields(row, fields) {
  const values = fields.map((field) => numberValue(row[field], NaN)).filter(Number.isFinite);
  if (values.length === 0) return "-";
  return (values.reduce((total, value) => total + value, 0) / values.length).toFixed(4);
}

function preferredRuntimeValue(row, runtimeField, plannedField = "") {
  const runtimeValue = numberValue(row[runtimeField], NaN);
  if (Number.isFinite(runtimeValue) && runtimeValue > 0) return runtimeValue;
  return plannedField ? numberValue(row[plannedField], 0) : 0;
}

function mechanismCells(row) {
  const budgetSummary = [
    row.adaptive_probe_budget_enabled_slices ?? 0,
    row.adaptive_probe_budget_throttled_slices ?? 0,
    row.adaptive_probe_budget_escalated_slices ?? 0,
  ].map(integerCell).join("/");
  const metadataSummary = [
    `压缩 ${integerCell(row.adaptive_metadata_compact_paths ?? 0)}`,
    `路径 ${integerCell(row.adaptive_path_only_observation_paths ?? 0)}`,
    `邻接 ${integerCell(row.adaptive_all_adjacent_observation_paths ?? 0)}`,
  ].join(" / ");
  const riskSummary = [
    `高风险 ${integerCell(row.local_adaptive_high_risk_paths ?? 0)}`,
    `观察 ${integerCell(row.local_adaptive_watchlist_paths ?? 0)}`,
  ].join(" / ");
  const oamDedupSummary = [
    `抑制 ${integerCell(row.oam_duplicate_target_only_suppressed_paths ?? 0)}`,
    `唯一 ${integerCell(row.unique_mandatory_oam_targets_covered ?? 0)}`,
  ].join(" / ");
  const oamTargetAwareSummary = [
    `路径 ${integerCell(row.runtime_target_aware_probe_paths ?? 0)}`,
    `目标 ${integerCell(row.runtime_target_metadata_hop_records ?? 0)}`,
    `转发 ${integerCell(row.runtime_transit_metadata_hop_records ?? 0)}`,
    `省 ${formatBytes(row.runtime_target_aware_metadata_bytes_saved ?? 0)}`,
  ].join(" / ");
  const orbitPriorSamples = sumFields(row, [
    "link_orbit_periodic_prior_values",
    "node_orbit_periodic_prior_values",
  ]);
  const energyContextSummary = [
    integerCell(row.node_energy_context_prior_values ?? 0),
    fixedCell(row.mean_node_energy_context_prior_weight, 2),
  ].join(" / ");
  const energyPhysicsSummary = [
    integerCell(row.node_energy_physics_prior_values ?? 0),
    fixedCell(row.mean_node_energy_physics_prior_weight, 2),
  ].join(" / ");
  const businessPriorSamples = sumFields(row, [
    "business_hotspot_migration_applied_link_samples",
    "link_business_hotspot_migration_prior_values",
  ]);
  const couplingSamples = [
    `指标 ${integerCell(row.metric_tensor_coupled_link_samples ?? 0)}`,
    `节点 ${integerCell(row.node_state_coupled_samples ?? 0)}`,
    `联合 ${integerCell(row.joint_state_coupling_link_samples ?? 0)}`,
    `张量 ${integerCell(row.state_tensor_joint_completed_link_samples ?? 0)}`,
  ].join(" / ");
  const meanCouplingPressure = meanFields(row, [
    "mean_metric_tensor_coupling_pressure",
    "mean_node_state_coupling_pressure",
    "mean_joint_state_coupling_pressure",
    "mean_state_tensor_joint_completion_pressure",
  ]);
  return [
    row.constellation_short_label,
    row.version_label,
    budgetSummary,
    fixedCell(row.mean_adaptive_probe_budget_scale, 4),
    fixedCell(row.mean_adaptive_probe_budget_effective_max_paths_per_slice, 2),
    metadataSummary,
    `${fixedCell(preferredRuntimeValue(row, "runtime_mean_effective_hop_metadata_bytes", "mean_effective_hop_metadata_bytes"), 2)} B`,
    formatBytes(preferredRuntimeValue(row, "runtime_metadata_bytes_saved_by_profile", "estimated_metadata_bytes_saved_by_profile")),
    integerCell(row.oam_mandatory_coverage_selected_paths ?? 0),
    oamDedupSummary,
    oamTargetAwareSummary,
    integerCell(row.oam_quality_feedback_retest_targets ?? 0),
    riskSummary,
    integerCell(row.reuse_duplicate_suppressed_paths ?? 0),
    integerCell(orbitPriorSamples),
    energyContextSummary,
    energyPhysicsSummary,
    integerCell(businessPriorSamples),
    integerCell(row.orbit_graph_regularized_link_samples ?? 0),
    couplingSamples,
    meanCouplingPressure,
  ];
}

function markdownCell(value) {
  return String(value ?? "-").replaceAll("|", "\\|");
}

const OUTPUT_FILE_LABELS = {
  comparison_csv: "综合对比 CSV",
  comparison_json: "综合对比 JSON",
  report_md: "实验报告 Markdown",
  report_html: "实验报告 HTML",
};

function outputFileLabel(label) {
  return OUTPUT_FILE_LABELS[label] ?? label;
}

function htmlHeaderRow(labels) {
  return `<tr>${labels.map((label) => `<th>${escapeHtml(label)}</th>`).join("")}</tr>`;
}

function markdownHeader(labels) {
  const header = `| ${labels.join(" | ")} |`;
  const separator = `|${labels.map((_, index) => (index < 2 ? "---" : "---:")).join("|")}|`;
  return [header, separator];
}

function parseLastJson(stdout, label) {
  const trimmed = stdout.trim();
  if (!trimmed) return {};
  const start = trimmed.lastIndexOf("\n{");
  const jsonText = start >= 0 ? trimmed.slice(start + 1) : trimmed;
  try {
    return JSON.parse(jsonText);
  } catch (error) {
    throw new Error(`${label} did not end with JSON: ${error.message}\n${trimmed.slice(-1200)}`);
  }
}

function runNode(label, script, args) {
  return new Promise((resolvePromise, reject) => {
    console.log(`[experiment2:int-mc-enhanced] ${label}`);
    const child = spawn(process.execPath, [script, ...args], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      const lastLine = text.trim().split(/\r?\n/).filter(Boolean).at(-1);
      if (lastLine && !lastLine.startsWith("{")) console.log(`  ${lastLine}`);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Command failed: node ${script} ${args.join(" ")}\n${stderr || stdout}`));
        return;
      }
      resolvePromise(parseLastJson(stdout, label));
    });
  });
}

function requireFile(path, label) {
  if (!existsSync(path)) throw new Error(`${label} not found: ${path}`);
}

async function combineFeedbackCsv({ paths, outputPath }) {
  const rows = [];
  for (const item of paths) {
    const sourceRows = await readCsv(item.path);
    sourceRows.forEach((row) => {
      if (!row.target_id || numberValue(row.priority_score) <= 0) return;
      rows.push({
        ...row,
        feedback_source: item.source,
      });
    });
  }
  await mkdir(resolve(outputPath, ".."), { recursive: true }).catch(() => {});
  await writeFile(outputPath, rowsToCsv(rows), "utf8");
  return { path: outputPath, rows };
}

async function runIntMcPass({
  label,
  truthDir,
  candidatePathsPath,
  stage2Dir,
  groundDir,
  samplingRate,
  targetActiveLinkSamplingRate,
  rank,
  windowSize,
  warmupSlices,
  iterations,
  downlinkBudgetBytes,
  maxPathsPerSlice,
  feedbackPath,
  controlActionsPath,
  planner = "legacy-int-mc",
  plannerModes = "reuse,repair,fresh",
  adaptiveReuse = true,
  adaptiveStructuralReuse = false,
  structuralReuseErrorTolerance = 0.02,
  topologyVersionedObjective = false,
  adaptiveProbeBudget = false,
  metricTensorCoupling = false,
  nodeStateCoupling = false,
  nodeEnergyPhysicsPrior = false,
  jointStateCoupling = false,
  orbitGraphRegularization = false,
  orbitPeriodicPrior = false,
  orbitPeriodicPriorSlices = 19,
  oamQualityFeedback = false,
  businessHotspotMigrationPrior = false,
  stateTensorJointCompletion = false,
  multiObjectiveBudget = false,
  scaleAdaptiveTotalBudget = true,
  scaleBudgetHeadroomRatio = 0.1,
  scaleBudgetPathHeadroomRatio = 0.25,
  scaleBudgetReferenceCsvPath = "",
  importanceAwareTargets = false,
  importanceMetadataOnly = true,
  importanceSelectiveMetadata = true,
  importancePathScoring = false,
  importanceBudgetNeutralReplacement = false,
  importanceStrictForwardOnly = false,
  importancePlaneRepresentativeRatio = 0,
  importanceTargetRatio = 0.25,
  importanceMaxAoISlices = 6,
  importanceExplorationRatio = 0.08,
  oamTargetAwareMetadata = false,
  oamTargetHopBytes = 96,
  oamTransitHopBytes = 88,
  observabilityMode = "oracle",
  plannerOamLinksPath = "",
  plannerOamNodesPath = "",
}) {
  await mkdir(stage2Dir, { recursive: true });
  await mkdir(groundDir, { recursive: true });
  const predictedContactPlanPath = join(stage2Dir, "predicted-contact-plan.json");

  await runNode(`${label}: contact-plan prediction`, "stage2-int/tools/predict-contact-plan.mjs", [
    "--input", truthDir,
    "--out", stage2Dir,
    "--completion-window-slices", String(windowSize),
  ]);
  const selectorArgs = [
    "--input", truthDir,
    "--stage2", stage2Dir,
    "--out", stage2Dir,
    "--algorithm", "int-mc",
    "--candidate-algorithm", "path-balance",
    "--candidate-paths", candidatePathsPath,
    "--sampling-rate", String(samplingRate),
    "--target-active-link-sampling-rate", String(targetActiveLinkSamplingRate),
    "--rank", String(rank),
    "--selection-strategy", "int-mc-leverage",
    "--window-size", String(windowSize),
    "--warmup-slices", String(warmupSlices),
    "--max-paths-per-slice", String(maxPathsPerSlice),
    "--predicted-contact-plan", predictedContactPlanPath,
    "--observability-mode", observabilityMode,
    "--planner", planner,
    "--planner-modes", plannerModes,
    "--adaptive-reuse", String(Boolean(adaptiveReuse)),
    "--adaptive-structural-reuse", String(Boolean(adaptiveStructuralReuse)),
    "--structural-reuse-error-tolerance", String(structuralReuseErrorTolerance),
    "--scale-adaptive-total-budget", String(Boolean(scaleAdaptiveTotalBudget)),
    "--scale-budget-headroom-ratio", String(scaleBudgetHeadroomRatio),
    "--scale-budget-path-headroom-ratio", String(scaleBudgetPathHeadroomRatio),
  ];
  if (scaleBudgetReferenceCsvPath) {
    requireFile(scaleBudgetReferenceCsvPath, `${label} scale budget reference schedule`);
    selectorArgs.push("--scale-budget-reference-csv", scaleBudgetReferenceCsvPath);
  }
  if (plannerOamLinksPath) selectorArgs.push("--planner-oam-links", plannerOamLinksPath);
  if (plannerOamNodesPath) selectorArgs.push("--planner-oam-nodes", plannerOamNodesPath);
  if (topologyVersionedObjective) selectorArgs.push("--topology-versioned-objective", "true");
  if (adaptiveProbeBudget) selectorArgs.push("--adaptive-probe-budget", "true");
  if (multiObjectiveBudget) selectorArgs.push("--multi-objective-budget", "true");
  if (importanceAwareTargets) {
    selectorArgs.push(
      "--importance-aware-targets", "true",
      "--importance-metadata-only", String(Boolean(importanceMetadataOnly)),
      "--importance-selective-metadata", String(Boolean(importanceSelectiveMetadata)),
      "--importance-path-scoring", String(Boolean(importancePathScoring)),
      "--importance-budget-neutral-replacement", String(Boolean(importanceBudgetNeutralReplacement)),
      "--importance-strict-forward-only", String(Boolean(importanceStrictForwardOnly)),
      "--importance-plane-representative-ratio", String(importancePlaneRepresentativeRatio),
      "--importance-target-ratio", String(importanceTargetRatio),
      "--importance-max-aoi-slices", String(importanceMaxAoISlices),
      "--importance-exploration-ratio", String(importanceExplorationRatio),
    );
  }
  if (oamTargetAwareMetadata) {
    selectorArgs.push(
      "--oam-target-aware-metadata", "true",
      "--oam-target-hop-bytes", String(oamTargetHopBytes),
      "--oam-transit-hop-bytes", String(oamTransitHopBytes),
    );
  }
  if (feedbackPath) selectorArgs.push("--oam-priority-retest", feedbackPath);
  if (controlActionsPath) selectorArgs.push("--oam-control-actions", controlActionsPath);
  await runNode(`${label}: INT-MC path selection`, "stage2-int/tools/int-mc-path-selector.mjs", selectorArgs);
  await runNode(`${label}: reporting path planning`, "stage2-int/tools/reporting-path-planner.mjs", [
    "--input", truthDir,
    "--stage2", stage2Dir,
    "--out", stage2Dir,
    "--algorithm", "int-mc",
    "--probes", join(stage2Dir, "probe-paths-int-mc.csv"),
  ]);
  await runNode(`${label}: probe INT runner`, "stage2-int/tools/probe-int-runner.mjs", [
    "--input", truthDir,
    "--stage2", stage2Dir,
    "--out", stage2Dir,
    "--algorithm", "int-mc",
  ]);
  await runNode(`${label}: Ground OAM direct reconstruction`, "stage2-int/tools/ground-oam-reconstructor.mjs", [
    "--input", truthDir,
    "--stage2", stage2Dir,
    "--out", groundDir,
    "--hops", join(stage2Dir, "probe-int-hop-records-int-mc.csv"),
    "--reports", join(stage2Dir, "probe-int-reports-int-mc.csv"),
    "--downlink-budget-bytes", String(downlinkBudgetBytes),
  ]);
  const reconstructorArgs = [
    "--input", truthDir,
    "--stage2", stage2Dir,
    "--ground", groundDir,
    "--out", groundDir,
    "--algorithm", "int-mc",
    "--rank", String(rank),
    "--window-size", String(windowSize),
    "--iterations", String(iterations),
    "--predicted-contact-plan", predictedContactPlanPath,
  ];
  if (metricTensorCoupling) reconstructorArgs.push("--metric-tensor-coupling", "true");
  if (nodeStateCoupling) reconstructorArgs.push("--node-state-coupling", "true");
  if (nodeEnergyPhysicsPrior) reconstructorArgs.push("--node-energy-physics-prior", "true");
  if (jointStateCoupling) reconstructorArgs.push("--joint-state-coupling", "true");
  if (orbitGraphRegularization) reconstructorArgs.push("--orbit-graph-regularization", "true");
  if (orbitPeriodicPrior) reconstructorArgs.push("--orbit-periodic-prior", "true", "--orbit-periodic-prior-slices", String(orbitPeriodicPriorSlices));
  if (oamQualityFeedback) reconstructorArgs.push("--oam-quality-feedback", "true");
  if (businessHotspotMigrationPrior) reconstructorArgs.push("--business-hotspot-migration-prior", "true");
  if (stateTensorJointCompletion) reconstructorArgs.push("--state-tensor-joint-completion", "true");
  await runNode(`${label}: INT-MC matrix completion`, "stage2-int/tools/int-mc-reconstructor.mjs", reconstructorArgs);

  return collectEnhancedMetrics({ truthDir, stage2Dir, groundDir });
}

async function collectEnhancedMetrics({ truthDir, stage2Dir, groundDir }) {
  const [metadata, coverage, runReport, evaluation, summaryRows, linkOverheadRows] = await Promise.all([
    readJson(join(truthDir, "metadata.json")),
    readJson(join(stage2Dir, "probe-coverage-int-mc.json")),
    readJson(join(stage2Dir, "probe-int-run-report-int-mc.json")),
    readJson(join(groundDir, "int-mc-evaluation.json")),
    readCsv(join(stage2Dir, "probe-summary-int-mc.csv")),
    readCsv(join(stage2Dir, "probe-int-link-overhead-int-mc.csv")),
  ]);
  const reconstruction = evaluation.reconstruction ?? {};
  const utilizationMetrics = evaluation.metrics?.utilization_percent ?? {};
  const nodeReconstruction = evaluation.node_reconstruction ?? {};
  const nodeMetrics = nodeReconstruction.metrics ?? {};
  const linkMetrics = evaluation.metrics ?? {};
  const linkOrbitPeriodicPriorValues = (evaluation.matrix_summaries ?? [])
    .reduce((total, row) => total + numberValue(row.orbit_periodic_prior_values), 0);
  const nodeOrbitPeriodicPriorValues = (evaluation.node_matrix_summaries ?? [])
    .reduce((total, row) => total + numberValue(row.orbit_periodic_prior_values), 0);
  const linkBusinessHotspotMigrationPriorValues = (evaluation.matrix_summaries ?? [])
    .reduce((total, row) => total + numberValue(row.business_hotspot_migration_prior_values), 0);
  const overhead = runReport.overhead ?? {};
  const selectorCoverage = coverage.coverage ?? {};
  const nodeCount = numberValue(metadata.node_count ?? metadata.nodes_per_slice ?? metadata.constellation?.satellites, 0);
  const sliceCount = numberValue(metadata.slice_count ?? metadata.time_slices ?? selectorCoverage.slices, summaryRows.length || 1);
  const totalIslTelemetryLinkBytes = linkOverheadRows.reduce((total, row) => total + numberValue(row.total_telemetry_link_bytes), 0);
  const activeIslTelemetryLinkRows = linkOverheadRows.filter((row) => numberValue(row.total_telemetry_link_bytes) > 0).length;
  return {
    slice_count: sliceCount,
    nodes_per_slice: nodeCount,
    active_link_direct_coverage: reconstruction.direct_observation_rate_on_active ?? 0,
    active_link_effective_coverage: reconstruction.active_link_completion_coverage ?? 0,
    int_mc_inferred_rate_on_active: reconstruction.inferred_rate_on_active ?? 0,
    total_telemetry_generated_bytes: overhead.total_telemetry_generated_bytes ?? selectorCoverage.estimated_generated_telemetry_bytes ?? 0,
    telemetry_bytes_per_node_slice: round(numberValue(overhead.total_telemetry_generated_bytes) / Math.max(nodeCount * sliceCount, 1), 4),
    total_telemetry_energy_j: overhead.total_telemetry_energy_j ?? 0,
    hop_records: overhead.hop_records ?? 0,
    compact_metadata_hop_records: overhead.compact_metadata_hop_records ?? 0,
    runtime_mean_effective_hop_metadata_bytes: overhead.mean_effective_hop_metadata_bytes ?? "",
    runtime_metadata_bytes_saved_by_profile: overhead.metadata_bytes_saved_by_profile ?? 0,
    runtime_total_metadata_bytes: overhead.total_metadata_bytes ?? 0,
    runtime_total_report_bytes: overhead.total_report_bytes ?? 0,
    runtime_total_probe_packet_base_bytes: overhead.total_probe_packet_base_bytes ?? 0,
    runtime_total_int_bytes: overhead.total_int_bytes ?? 0,
    runtime_total_isl_telemetry_link_bytes: round(totalIslTelemetryLinkBytes),
    runtime_mean_isl_telemetry_link_bytes: round(totalIslTelemetryLinkBytes / Math.max(activeIslTelemetryLinkRows, 1)),
    runtime_report_count: overhead.reports ?? 0,
    runtime_path_only_probe_paths: runReport.planning?.path_only_probe_paths ?? 0,
    runtime_all_adjacent_probe_paths: runReport.planning?.all_adjacent_probe_paths ?? 0,
    runtime_target_aware_probe_paths: runReport.planning?.target_aware_probe_paths ?? 0,
    runtime_target_aware_suppressed_adjacent_scans: runReport.planning?.target_aware_suppressed_adjacent_scans ?? 0,
    runtime_target_metadata_hop_records: overhead.target_metadata_hop_records ?? 0,
    runtime_transit_metadata_hop_records: overhead.transit_metadata_hop_records ?? 0,
    runtime_target_neighborhood_adjacent_records: overhead.target_neighborhood_adjacent_records ?? 0,
    runtime_target_aware_metadata_bytes_saved: overhead.target_aware_metadata_bytes_saved ?? 0,
    unified_planner_enabled: selectorCoverage.unified_planner_enabled ?? false,
    unified_reuse_slices: selectorCoverage.unified_reuse_slices ?? 0,
    unified_repair_slices: selectorCoverage.unified_repair_slices ?? 0,
    unified_fresh_slices: selectorCoverage.unified_fresh_slices ?? 0,
    unified_full_actions: selectorCoverage.unified_full_actions ?? 0,
    unified_compact_actions: selectorCoverage.unified_compact_actions ?? 0,
    unified_selective_actions: selectorCoverage.unified_selective_actions ?? 0,
    unified_forward_only_hops: selectorCoverage.unified_forward_only_hops ?? 0,
    unified_hard_budget_violations: selectorCoverage.unified_hard_budget_violations ?? 0,
    selected_paths: selectorCoverage.selected_paths ?? 0,
    active_link_sampling_coverage: selectorCoverage.active_link_sampling_coverage ?? 0,
    mean_marginal_information_gain: selectorCoverage.mean_marginal_information_gain ?? 0,
    mean_marginal_redundancy_penalty: selectorCoverage.mean_marginal_redundancy_penalty ?? 0,
    mean_marginal_novelty_ratio: selectorCoverage.mean_marginal_novelty_ratio ?? 0,
    mean_score_information_per_kb: selectorCoverage.mean_score_information_per_kb ?? 0,
    mean_node_state_sampling_scale: selectorCoverage.mean_node_state_sampling_scale ?? "",
    mean_node_state_information_gain: selectorCoverage.mean_node_state_information_gain ?? "",
    adaptive_probe_budget_enabled_slices: selectorCoverage.adaptive_probe_budget_enabled_slices ?? 0,
    adaptive_probe_budget_applied_slices: selectorCoverage.adaptive_probe_budget_applied_slices ?? 0,
    adaptive_probe_budget_throttled_slices: selectorCoverage.adaptive_probe_budget_throttled_slices ?? 0,
    adaptive_probe_budget_escalated_slices: selectorCoverage.adaptive_probe_budget_escalated_slices ?? 0,
    adaptive_probe_budget_path_cap_throttled_slices: selectorCoverage.adaptive_probe_budget_path_cap_throttled_slices ?? 0,
    adaptive_probe_budget_path_cap_escalated_slices: selectorCoverage.adaptive_probe_budget_path_cap_escalated_slices ?? 0,
    mean_adaptive_probe_budget_scale: selectorCoverage.mean_adaptive_probe_budget_scale ?? "",
    mean_adaptive_probe_budget_effective_max_paths_per_slice: selectorCoverage.mean_adaptive_probe_budget_effective_max_paths_per_slice ?? "",
    mean_adaptive_probe_budget_reuse_confidence: selectorCoverage.mean_adaptive_probe_budget_reuse_confidence ?? "",
    mean_adaptive_probe_budget_oam_pressure: selectorCoverage.mean_adaptive_probe_budget_oam_pressure ?? "",
    multi_objective_budget_enabled_slices: selectorCoverage.multi_objective_budget_enabled_slices ?? 0,
    multi_objective_cost_pressure_slices: selectorCoverage.multi_objective_cost_pressure_slices ?? 0,
    multi_objective_quality_guard_slices: selectorCoverage.multi_objective_quality_guard_slices ?? 0,
    mean_multi_objective_quality_guard_pressure: selectorCoverage.mean_multi_objective_quality_guard_pressure ?? "",
    mean_multi_objective_cost_reduction_pressure: selectorCoverage.mean_multi_objective_cost_reduction_pressure ?? "",
    mean_multi_objective_path_budget_scale: selectorCoverage.mean_multi_objective_path_budget_scale ?? "",
    mean_multi_objective_metadata_floor_ratio: selectorCoverage.mean_multi_objective_metadata_floor_ratio ?? "",
    mean_multi_objective_score: selectorCoverage.mean_multi_objective_score ?? "",
    adaptive_metadata_profile_enabled_slices: selectorCoverage.adaptive_metadata_profile_enabled_slices ?? 0,
    adaptive_metadata_compact_paths: selectorCoverage.adaptive_metadata_compact_paths ?? 0,
    adaptive_metadata_target_aware_paths: selectorCoverage.adaptive_metadata_target_aware_paths ?? 0,
    adaptive_metadata_standard_paths: selectorCoverage.adaptive_metadata_standard_paths ?? 0,
    adaptive_path_only_observation_paths: selectorCoverage.adaptive_path_only_observation_paths ?? 0,
    adaptive_target_neighborhood_observation_paths: selectorCoverage.adaptive_target_neighborhood_observation_paths ?? 0,
    adaptive_all_adjacent_observation_paths: selectorCoverage.adaptive_all_adjacent_observation_paths ?? 0,
    mean_effective_hop_metadata_bytes: selectorCoverage.mean_effective_hop_metadata_bytes ?? "",
    mean_metadata_compression_ratio: selectorCoverage.mean_metadata_compression_ratio ?? "",
    estimated_metadata_bytes_saved_by_profile: selectorCoverage.estimated_metadata_bytes_saved_by_profile ?? 0,
    oam_mandatory_coverage_selected_paths: selectorCoverage.oam_mandatory_coverage_selected_paths ?? 0,
    oam_mandatory_coverage_broke_reuse_slices: selectorCoverage.oam_mandatory_coverage_broke_reuse_slices ?? 0,
    oam_control_next_slice_applied_slices: selectorCoverage.oam_control_next_slice_applied_slices ?? 0,
    local_adaptive_high_risk_paths: selectorCoverage.local_adaptive_high_risk_paths ?? 0,
    local_adaptive_watchlist_paths: selectorCoverage.local_adaptive_watchlist_paths ?? 0,
    local_adaptive_low_risk_sparse_paths: selectorCoverage.local_adaptive_low_risk_sparse_paths ?? 0,
    reuse_duplicate_suppressed_paths: selectorCoverage.reuse_duplicate_suppressed_paths ?? 0,
    oam_duplicate_target_only_suppressed_paths: selectorCoverage.oam_duplicate_target_only_suppressed_paths ?? 0,
    unique_mandatory_oam_targets_covered: selectorCoverage.unique_mandatory_oam_targets_covered ?? 0,
    mean_local_adaptive_sampling_risk: selectorCoverage.mean_local_adaptive_sampling_risk ?? "",
    max_local_adaptive_sampling_risk: selectorCoverage.max_local_adaptive_sampling_risk ?? "",
    orbit_periodic_prior_enabled: evaluation.parameters?.orbit_periodic_prior_enabled ?? false,
    orbit_periodic_prior_slices: evaluation.parameters?.orbit_periodic_prior_slices ?? "",
    link_orbit_periodic_prior_values: linkOrbitPeriodicPriorValues,
    node_orbit_periodic_prior_values: nodeOrbitPeriodicPriorValues,
    business_hotspot_migration_prior_enabled: evaluation.parameters?.business_hotspot_migration_prior_enabled ?? false,
    business_hotspot_migration_applied_link_samples: evaluation.context_prior_summary?.business_hotspot_migration_applied_link_samples ?? 0,
    business_hotspot_migration_candidate_links: evaluation.context_prior_summary?.business_hotspot_migration_candidate_links ?? 0,
    mean_business_hotspot_migration_score: evaluation.context_prior_summary?.mean_business_hotspot_migration_score ?? "",
    mean_business_hotspot_migration_quality: evaluation.context_prior_summary?.mean_business_hotspot_migration_quality ?? "",
    link_business_hotspot_migration_prior_values: linkBusinessHotspotMigrationPriorValues,
    oam_quality_feedback_enabled: evaluation.parameters?.oam_quality_feedback_enabled ?? false,
    oam_quality_feedback_low_confidence_observed_links: evaluation.context_prior_summary?.oam_quality_feedback_low_confidence_observed_links ?? 0,
    oam_quality_feedback_low_confidence_observed_nodes: evaluation.context_prior_summary?.oam_quality_feedback_low_confidence_observed_nodes ?? 0,
    oam_quality_feedback_conflicting_observed_links: evaluation.context_prior_summary?.oam_quality_feedback_conflicting_observed_links ?? 0,
    oam_quality_feedback_conflicting_observed_nodes: evaluation.context_prior_summary?.oam_quality_feedback_conflicting_observed_nodes ?? 0,
    oam_quality_feedback_retest_targets: evaluation.context_prior_summary?.oam_quality_feedback_retest_targets ?? 0,
    orbit_graph_regularization_enabled: evaluation.parameters?.orbit_graph_regularization_enabled ?? false,
    orbit_graph_regularized_link_samples: evaluation.context_prior_summary?.orbit_graph_regularized_link_samples ?? 0,
    mean_orbit_graph_regularization_strength: evaluation.context_prior_summary?.mean_orbit_graph_regularization_strength ?? "",
    completion_priority_retests: evaluation.completion_feedback?.priority_retest_targets ?? 0,
    utilization_load_consistency_samples: evaluation.context_prior_summary?.utilization_load_consistency_samples ?? 0,
    metric_tensor_coupling_enabled: evaluation.parameters?.metric_tensor_coupling_enabled ?? false,
    metric_tensor_coupled_link_samples: evaluation.context_prior_summary?.metric_tensor_coupled_link_samples ?? 0,
    mean_metric_tensor_coupling_pressure: evaluation.context_prior_summary?.mean_metric_tensor_coupling_pressure ?? "",
    node_state_coupling_enabled: evaluation.parameters?.node_state_coupling_enabled ?? false,
    node_state_coupled_samples: evaluation.context_prior_summary?.node_state_coupled_samples ?? 0,
    mean_node_state_coupling_pressure: evaluation.context_prior_summary?.mean_node_state_coupling_pressure ?? "",
    node_energy_context_prior_values: evaluation.context_prior_summary?.node_energy_context_prior_values ?? 0,
    mean_node_energy_context_prior_weight: evaluation.context_prior_summary?.mean_node_energy_context_prior_weight ?? "",
    node_energy_physics_prior_enabled: evaluation.parameters?.node_energy_physics_prior_enabled ?? false,
    node_energy_physics_prior_values: evaluation.context_prior_summary?.node_energy_physics_prior_values ?? 0,
    mean_node_energy_physics_prior_weight: evaluation.context_prior_summary?.mean_node_energy_physics_prior_weight ?? "",
    joint_state_coupling_enabled: evaluation.parameters?.joint_state_coupling_enabled ?? false,
    joint_state_coupling_link_samples: evaluation.context_prior_summary?.joint_state_coupling_link_samples ?? 0,
    mean_joint_state_coupling_pressure: evaluation.context_prior_summary?.mean_joint_state_coupling_pressure ?? "",
    state_tensor_joint_completion_enabled: evaluation.parameters?.state_tensor_joint_completion_enabled ?? false,
    state_tensor_joint_completed_link_samples: evaluation.context_prior_summary?.state_tensor_joint_completed_link_samples ?? 0,
    mean_state_tensor_joint_completion_pressure: evaluation.context_prior_summary?.mean_state_tensor_joint_completion_pressure ?? "",
    cpu_mae: nodeMetrics.cpu_percent?.mae ?? "",
    queue_depth_mae: nodeMetrics.queue_depth?.mae ?? "",
    energy_percent_mae: nodeMetrics.energy_percent?.mae ?? "",
    node_mode_accuracy: nodeReconstruction.mode_accuracy_all_nodes ?? "",
    link_status_accuracy: reconstruction.status_accuracy_all_links ?? "",
    link_utilization_mae: linkMetrics.utilization_percent?.mae ?? "",
    utilization_inferred_mae: utilizationMetrics.inferred_mae ?? "",
    utilization_inferred_rmse: utilizationMetrics.inferred_rmse ?? "",
    utilization_inferred_p95_ae: utilizationMetrics.inferred_p95_ae ?? "",
    utilization_inferred_max_ae: utilizationMetrics.inferred_max_ae ?? "",
    utilization_inferred_mean_error: utilizationMetrics.inferred_mean_error ?? "",
    utilization_inferred_nmae_range: utilizationMetrics.inferred_nmae_range ?? "",
    utilization_inferred_within_10_units_rate: utilizationMetrics.inferred_within_10_units_rate ?? "",
    utilization_inferred_high_f1: utilizationMetrics.inferred_high_f1 ?? "",
    utilization_inferred_high_recall: utilizationMetrics.inferred_high_recall ?? "",
    utilization_inferred_high_precision: utilizationMetrics.inferred_high_precision ?? "",
    utilization_inferred_high_actual_support: utilizationMetrics.inferred_high_actual_support ?? "",
    utilization_inferred_high_predicted_support: utilizationMetrics.inferred_high_predicted_support ?? "",
    latency_inferred_mae_ms: evaluation.metrics?.latency_ms?.inferred_mae ?? "",
    queue_latency_inferred_mae_ms: evaluation.metrics?.queue_latency_ms?.inferred_mae ?? "",
    report_json: join(groundDir, "int-mc-evaluation.json"),
    selector_json: join(stage2Dir, "probe-coverage-int-mc.json"),
  };
}

function oldIntMcRowsByProfile(oldRows) {
  const map = new Map();
  oldRows
    .filter((row) => row.method_id === "int-mc-selected-probe")
    .forEach((row) => map.set(row.constellation_profile_id, row));
  return map;
}

function oldRowToComparison(profile, row) {
  return {
    constellation_profile_id: profile.id,
    constellation_short_label: profile.short_label,
    scale: profile.scale,
    version: "before",
    version_label: BEFORE_VERSION_LABEL,
    active_link_direct_coverage: numberValue(row.active_link_direct_coverage),
    active_link_effective_coverage: numberValue(row.active_link_effective_coverage),
    int_mc_inferred_rate_on_active: numberValue(row.int_mc_inferred_rate_on_active),
    total_telemetry_generated_bytes: numberValue(row.total_telemetry_generated_bytes),
    telemetry_bytes_per_node_slice: numberValue(row.telemetry_bytes_per_node_slice),
    total_telemetry_energy_j: numberValue(row.total_telemetry_energy_j),
    hop_records: numberValue(row.hop_records),
    selected_paths: "",
    active_link_sampling_coverage: numberValue(row.int_mc_planned_active_link_sampling_coverage ?? row.active_link_direct_coverage),
    mean_marginal_information_gain: "",
    mean_marginal_redundancy_penalty: "",
    mean_marginal_novelty_ratio: "",
    mean_score_information_per_kb: "",
    completion_priority_retests: "",
    utilization_load_consistency_samples: "",
    utilization_inferred_mae: row.int_mc_utilization_inferred_mae ?? "",
    utilization_inferred_rmse: "",
    utilization_inferred_p95_ae: "",
    utilization_inferred_max_ae: "",
    utilization_inferred_mean_error: "",
    utilization_inferred_nmae_range: "",
    utilization_inferred_within_10_units_rate: "",
    utilization_inferred_high_f1: "",
    utilization_inferred_high_recall: "",
    utilization_inferred_high_precision: "",
    utilization_inferred_high_actual_support: "",
    utilization_inferred_high_predicted_support: "",
    latency_inferred_mae_ms: row.int_mc_latency_inferred_mae_ms ?? "",
  };
}

function baselineRowToComparison(profile, metrics) {
  return {
    constellation_profile_id: profile.id,
    constellation_short_label: profile.short_label,
    scale: profile.scale,
    version: "before",
    version_label: BEFORE_VERSION_LABEL,
    ...metrics,
  };
}

function enhancedRowToComparison(profile, metrics) {
  return {
    constellation_profile_id: profile.id,
    constellation_short_label: profile.short_label,
    scale: profile.scale,
    version: "after",
    version_label: AFTER_VERSION_LABEL,
    ...metrics,
  };
}

function svgBeforeAfterBars({ rows, field, title, formatter = (value) => String(value), width = 960, height = 320, maxValue = null }) {
  const margin = { top: 42, right: 22, bottom: 62, left: 78 };
  const groups = PROFILE_CATALOG.filter((profile) => rows.some((row) => row.constellation_profile_id === profile.id));
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const rawMax = maxValue ?? Math.max(1e-9, ...rows.map((row) => numberValue(row[field], NaN)).filter(Number.isFinite));
  const y = (value) => margin.top + plotHeight - (numberValue(value) / Math.max(rawMax, 1e-9)) * plotHeight;
  const groupWidth = plotWidth / Math.max(groups.length, 1);
  const barWidth = Math.max(28, groupWidth * 0.28);
  const colors = { before: "#64748b", after: "#dc2626" };
  const bars = groups.flatMap((profile, groupIndex) => ["before", "after"].map((version, index) => {
    const row = rows.find((item) => item.constellation_profile_id === profile.id && item.version === version) ?? {};
    const value = numberValue(row[field]);
    const x = margin.left + groupIndex * groupWidth + groupWidth / 2 + (index === 0 ? -barWidth - 3 : 3);
    const top = y(value);
    return `<rect x="${x}" y="${top}" width="${barWidth}" height="${Math.max(0, margin.top + plotHeight - top)}" rx="2" fill="${colors[version]}"><title>${escapeHtml(profile.short_label)} ${escapeHtml(row.version_label)}: ${escapeHtml(formatter(value))}</title></rect>`;
  })).join("");
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((ratio) => {
    const value = rawMax * ratio;
    const tickY = margin.top + plotHeight - ratio * plotHeight;
    return `<line x1="${margin.left}" x2="${width - margin.right}" y1="${tickY}" y2="${tickY}" stroke="#e2e8f0"></line><text x="${margin.left - 8}" y="${tickY + 4}" text-anchor="end" font-size="11">${escapeHtml(formatter(value))}</text>`;
  }).join("");
  const labels = groups.map((profile, index) =>
    `<text x="${margin.left + index * groupWidth + groupWidth / 2}" y="${height - 28}" text-anchor="middle" font-size="12">${escapeHtml(profile.short_label)}</text>`
  ).join("");
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(title)}">
    <text x="${margin.left}" y="24" font-size="16" font-weight="700">${escapeHtml(title)}</text>
    ${ticks}
    <line x1="${margin.left}" x2="${margin.left}" y1="${margin.top}" y2="${margin.top + plotHeight}" stroke="#64748b"></line>
    <line x1="${margin.left}" x2="${width - margin.right}" y1="${margin.top + plotHeight}" y2="${margin.top + plotHeight}" stroke="#64748b"></line>
    ${bars}
    ${labels}
    <rect x="${width - 220}" y="20" width="10" height="10" fill="${colors.before}"></rect><text x="${width - 205}" y="30" font-size="12">${BEFORE_VERSION_LABEL}</text>
    <rect x="${width - 130}" y="20" width="10" height="10" fill="${colors.after}"></rect><text x="${width - 115}" y="30" font-size="12">${AFTER_VERSION_LABEL}</text>
  </svg>`;
}

function buildHtml({ rows, outputDir, outputFiles, summary }) {
  const tableRows = rows.map((row) => {
    const highSupport = numberValue(row.utilization_inferred_high_actual_support, NaN);
    const highF1Text = row.utilization_inferred_high_f1 === "" || highSupport <= 0
      ? "-"
      : Number(row.utilization_inferred_high_f1).toFixed(4);
    const highSupportText = row.utilization_inferred_high_actual_support === ""
      ? "-"
      : `${row.utilization_inferred_high_actual_support}/${row.utilization_inferred_high_predicted_support}`;
    return `<tr>
    <td>${escapeHtml(row.constellation_short_label)}</td>
    <td>${escapeHtml(row.version_label)}</td>
    <td>${formatPercent(row.active_link_direct_coverage)}</td>
    <td>${formatPercent(row.active_link_effective_coverage)}</td>
    <td>${formatPercent(row.int_mc_inferred_rate_on_active)}</td>
    <td>${formatBytes(row.telemetry_bytes_per_node_slice)}</td>
    <td>${formatBytes(row.total_telemetry_generated_bytes)}</td>
    <td>${row.mean_marginal_information_gain === "" ? "-" : Number(row.mean_marginal_information_gain).toFixed(3)}</td>
    <td>${row.mean_score_information_per_kb === "" ? "-" : Number(row.mean_score_information_per_kb).toFixed(3)}</td>
    <td>${row.completion_priority_retests === "" ? "-" : row.completion_priority_retests}</td>
    <td>${row.utilization_load_consistency_samples === "" ? "-" : row.utilization_load_consistency_samples}</td>
    <td>${row.cpu_mae === "" ? "-" : Number(row.cpu_mae).toFixed(4)}</td>
    <td>${row.queue_depth_mae === "" ? "-" : Number(row.queue_depth_mae).toFixed(4)}</td>
    <td>${row.energy_percent_mae === "" ? "-" : Number(row.energy_percent_mae).toFixed(4)}</td>
    <td>${row.node_mode_accuracy === "" ? "-" : formatPercent(row.node_mode_accuracy)}</td>
    <td>${row.link_status_accuracy === "" ? "-" : formatPercent(row.link_status_accuracy)}</td>
    <td>${row.link_utilization_mae === "" ? "-" : Number(row.link_utilization_mae).toFixed(4)}</td>
    <td>${row.utilization_inferred_mae === "" ? "-" : Number(row.utilization_inferred_mae).toFixed(4)}</td>
    <td>${row.utilization_inferred_rmse === "" ? "-" : Number(row.utilization_inferred_rmse).toFixed(4)}</td>
    <td>${row.utilization_inferred_p95_ae === "" ? "-" : Number(row.utilization_inferred_p95_ae).toFixed(4)}</td>
    <td>${row.utilization_inferred_within_10_units_rate === "" ? "-" : formatPercent(row.utilization_inferred_within_10_units_rate)}</td>
    <td>${highF1Text}</td>
    <td>${escapeHtml(highSupportText)}</td>
  </tr>`;
  }).join("");
  const enhancementRows = rows.map((row) => `<tr>${
    mechanismCells(row).map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")
  }</tr>`).join("");
  const downloads = Object.entries(outputFiles).map(([label, path]) =>
    `<li><a href="${escapeHtml(relative(outputDir, path).replaceAll("\\", "/"))}">${escapeHtml(outputFileLabel(label))}</a></li>`
  ).join("");
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>实验2：INT-MC 增强前后对比</title>
  <style>
    body { margin:0; font-family: Arial, "Microsoft YaHei", sans-serif; color:#142033; background:#f6f8fb; }
    header { padding:28px 34px; background:#fff; border-bottom:1px solid #d8e0ea; position:sticky; top:0; z-index:5; }
    main { max-width:1220px; margin:0 auto; padding:24px 34px 42px; }
    h1 { margin:0 0 8px; font-size:28px; }
    h2 { margin:26px 0 12px; }
    .muted { color:#64748b; }
    .panel { background:#fff; border:1px solid #d8e0ea; border-radius:8px; padding:16px; margin-bottom:16px; }
    .grid { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
    svg { width:100%; height:auto; display:block; }
    table { width:100%; border-collapse:collapse; background:#fff; border:1px solid #d8e0ea; }
    th, td { padding:9px 10px; border-bottom:1px solid #d8e0ea; text-align:right; font-size:13px; }
    th:first-child, td:first-child, th:nth-child(2), td:nth-child(2) { text-align:left; }
    th { background:#eef3f8; }
    code { background:#eef3f8; padding:2px 5px; border-radius:4px; }
    @media (max-width:900px) { .grid { grid-template-columns:1fr; } header { position:static; } }
  </style>
</head>
<body>
  <header>
    <h1>实验2：INT-MC 增强前后对比</h1>
    <div class="muted">三种规模的原生与增强流程均已重跑；增强组逐时间片复用原生组预算日程。生成时间：${escapeHtml(summary.generated_at)}</div>
  </header>
  <main>
    <div class="panel">
      <p>增强后 LEO-INT-MC 保留原生低秩矩阵补全主体，并加入自适应探测预算、地面 OAM 反馈闭环、轨道周期先验、多指标/节点/联合状态耦合、状态张量联合补全，以及按单位遥测开销的信息增益路径评分：<code>路径得分 = 信息增益 / 遥测成本</code>。</p>
    </div>
    <div class="panel">
      <h2>参数与结果解读</h2>
      <p>启用规模自适应预算后，参数 <code>max_paths_per_slice=${escapeHtml(summary.parameters.max_paths_per_slice)}</code> 是兼容性的路径基准值，不是绝对路径上限。真正的硬约束是原生组先按覆盖目标推导预算，增强组再逐时间片复用同一份遥测字节硬预算；风险预测与 OAM 反馈只能调整预算内优先级，不能突破上限。</p>
      <p>本轮修正后，增强策略不再把所有 OAM 反馈都解释成“增加探测”。低风险稳定切片会保持原生 INT-MC 的路径计划；高风险路径仍保留邻接链路观测，但使用 <code>standard-light</code> 字段压缩降低每跳元数据字节；低价值路径才会切换为 <code>path-only</code> 观测。</p>
      <p>因此，直接观测覆盖率不能单独作为优劣判断。如果某个星座的直接覆盖率略有上升，但每节点每时间片字节下降且利用率补全 MAE 下降，说明算法通过字段压缩和更有效路径选择取得了更好的开销-精度折中；如果直接覆盖率下降而有效重构覆盖率保持 100%，则说明矩阵补全承担了更多全网状态恢复工作。</p>
    </div>
    <div class="grid">
      <div class="panel">${svgBeforeAfterBars({ rows, field: "active_link_direct_coverage", title: "活动链路直接观测覆盖率", formatter: (value) => formatPercent(value), maxValue: 1 })}</div>
      <div class="panel">${svgBeforeAfterBars({ rows, field: "active_link_effective_coverage", title: "活动链路有效重构覆盖率", formatter: (value) => formatPercent(value), maxValue: 1 })}</div>
    </div>
    <div class="grid">
      <div class="panel">${svgBeforeAfterBars({ rows, field: "telemetry_bytes_per_node_slice", title: "每节点每时间片遥测开销", formatter: formatBytes })}</div>
      <div class="panel">${svgBeforeAfterBars({ rows, field: "utilization_inferred_mae", title: "利用率补全 MAE", formatter: (value) => Number(value).toFixed(3) })}</div>
    </div>
    <h2>节点/链路重构指标图表</h2>
    <div class="panel">
      <p class="muted">以下六个指标用于直观看出增强前后在节点状态、链路状态和关键性能指标重构上的差异。CPU、队列、电量和链路利用率 MAE 越低越好；节点模式准确率和链路状态准确率越高越好。</p>
    </div>
    <div class="grid">
      <div class="panel">${svgBeforeAfterBars({ rows, field: "cpu_mae", title: "CPU MAE（越低越好）", formatter: (value) => Number(value).toFixed(3) })}</div>
      <div class="panel">${svgBeforeAfterBars({ rows, field: "queue_depth_mae", title: "队列 MAE（越低越好）", formatter: (value) => Number(value).toFixed(3) })}</div>
    </div>
    <div class="grid">
      <div class="panel">${svgBeforeAfterBars({ rows, field: "energy_percent_mae", title: "电量 MAE（越低越好）", formatter: (value) => Number(value).toFixed(3) })}</div>
      <div class="panel">${svgBeforeAfterBars({ rows, field: "node_mode_accuracy", title: "节点模式准确率（越高越好）", formatter: (value) => formatPercent(value), maxValue: 1 })}</div>
    </div>
    <div class="grid">
      <div class="panel">${svgBeforeAfterBars({ rows, field: "link_status_accuracy", title: "链路状态准确率（越高越好）", formatter: (value) => formatPercent(value), maxValue: 1 })}</div>
      <div class="panel">${svgBeforeAfterBars({ rows, field: "link_utilization_mae", title: "链路利用率 MAE（越低越好）", formatter: (value) => Number(value).toFixed(3) })}</div>
    </div>
    <h2>汇总表</h2>
    <table>
      <thead>${htmlHeaderRow(["星座", "版本", "直接观测覆盖率", "有效重构覆盖率", "推断占比", "字节/节点/时间片", "总遥测字节", "平均边际收益", "收益/KB", "反馈目标", "负载一致性样本", "CPU MAE", "队列 MAE", "电量 MAE", "节点模式准确率", "链路状态准确率", "链路利用率 MAE", "利用率 MAE", "利用率 RMSE", "利用率 P95 绝对误差", "10 点内比例", "高负载 F1", "高负载样本"])}</thead>
      <tbody>${tableRows}</tbody>
    </table>
    <h2>输出文件</h2>
    <h2>LEO-INT-MC 增强机制明细</h2>
    <div class="panel">
      <p class="muted">机制表只保留影响实验解释的关键项；运行期元数据字节、报告字节、候选链路数等细分审计字段仍保留在 CSV/JSON 中。</p>
      <table>
        <thead>${htmlHeaderRow(MECHANISM_COLUMN_LABELS)}</thead>
        <tbody>${enhancementRows}</tbody>
      </table>
    </div>
    <div class="panel"><ul>${downloads}</ul></div>
  </main>
</body>
</html>`;
}

function buildMarkdown({ rows, outputFiles, summary }) {
  const [summaryHeader, summarySeparator] = markdownHeader([
    "星座",
    "版本",
    "直接观测覆盖率",
    "有效重构覆盖率",
    "字节/节点/时间片",
    "负载一致性样本",
    "CPU MAE",
    "队列 MAE",
    "电量 MAE",
    "节点模式准确率",
    "链路状态准确率",
    "链路利用率 MAE",
    "利用率 MAE",
    "利用率 P95 绝对误差",
    "10 点内比例",
    "高负载 F1",
    "高负载样本",
  ]);
  const [mechanismHeader, mechanismSeparator] = markdownHeader(MECHANISM_COLUMN_LABELS);
  return [
    "# 实验2：INT-MC 增强前后对比",
    "",
    `生成时间：${summary.generated_at}`,
    "",
    "三种规模的原生与增强流程均已重跑；增强组逐时间片复用原生组预算日程。",
    `启用规模自适应预算后，参数 max_paths_per_slice=${summary.parameters.max_paths_per_slice} 是兼容性的路径基准值，不是绝对路径上限。真正的硬约束是原生组先按覆盖目标推导预算，增强组再逐时间片复用同一份遥测字节硬预算；风险预测与 OAM 反馈只能调整预算内优先级，不能突破上限。`,
    "本轮修正后，增强策略不再把所有 OAM 反馈都解释成增加探测。低风险稳定切片保持原生 INT-MC 路径计划；高风险路径保留邻接链路观测，但使用 `standard-light` 字段压缩降低每跳元数据字节；低价值路径才切换为 `path-only` 观测。",
    "因此，直接观测覆盖率不能单独作为优劣判断。若直接覆盖率略升，但字节/节点/时间片下降且利用率补全 MAE 下降，说明算法通过字段压缩和更有效路径选择取得了更好的开销-精度折中；若直接覆盖率下降而有效重构覆盖率保持 100%，说明矩阵补全承担了更多全网状态恢复工作。",
    "报告图表覆盖活动链路直接观测覆盖率、活动链路有效重构覆盖率、每节点每时间片遥测开销、利用率补全 MAE，以及 CPU MAE、队列 MAE、电量 MAE、节点模式准确率、链路状态准确率和链路利用率 MAE。",
    "其中 CPU、队列、电量和链路利用率 MAE 越低越好；节点模式准确率和链路状态准确率越高越好。",
    "",
    "## 节点/链路重构指标图表",
    "",
    "- CPU MAE（越低越好）",
    "- 队列 MAE（越低越好）",
    "- 电量 MAE（越低越好）",
    "- 节点模式准确率（越高越好）",
    "- 链路状态准确率（越高越好）",
    "- 链路利用率 MAE（越低越好）",
    "",
    summaryHeader,
    summarySeparator,
    ...rows.map((row) => {
      const highSupport = numberValue(row.utilization_inferred_high_actual_support, NaN);
      const highF1Text = row.utilization_inferred_high_f1 === "" || highSupport <= 0
        ? "-"
        : Number(row.utilization_inferred_high_f1).toFixed(4);
      const highSupportText = row.utilization_inferred_high_actual_support === ""
        ? "-"
        : `${row.utilization_inferred_high_actual_support}/${row.utilization_inferred_high_predicted_support}`;
      return `| ${row.constellation_short_label} | ${row.version_label} | ${formatPercent(row.active_link_direct_coverage)} | ${formatPercent(row.active_link_effective_coverage)} | ${formatBytes(row.telemetry_bytes_per_node_slice)} | ${row.utilization_load_consistency_samples === "" ? "-" : row.utilization_load_consistency_samples} | ${row.cpu_mae === "" ? "-" : Number(row.cpu_mae).toFixed(4)} | ${row.queue_depth_mae === "" ? "-" : Number(row.queue_depth_mae).toFixed(4)} | ${row.energy_percent_mae === "" ? "-" : Number(row.energy_percent_mae).toFixed(4)} | ${row.node_mode_accuracy === "" ? "-" : formatPercent(row.node_mode_accuracy)} | ${row.link_status_accuracy === "" ? "-" : formatPercent(row.link_status_accuracy)} | ${row.link_utilization_mae === "" ? "-" : Number(row.link_utilization_mae).toFixed(4)} | ${row.utilization_inferred_mae === "" ? "-" : Number(row.utilization_inferred_mae).toFixed(4)} | ${row.utilization_inferred_p95_ae === "" ? "-" : Number(row.utilization_inferred_p95_ae).toFixed(4)} | ${row.utilization_inferred_within_10_units_rate === "" ? "-" : formatPercent(row.utilization_inferred_within_10_units_rate)} | ${highF1Text} | ${highSupportText} |`;
    }),
    "",
    "## 输出文件",
    "",
    "## LEO-INT-MC 增强机制明细",
    "",
    "机制表只保留影响实验结论的关键项：探测预算、元数据压缩、OAM 反馈、局部风险采样、拓扑复用、轨道/业务先验、图正则和多指标状态耦合。更细的运行期字节拆分仍保留在 CSV/JSON 原始字段中，便于需要时审计。",
    "",
    mechanismHeader,
    mechanismSeparator,
    ...rows.map((row) => `| ${mechanismCells(row).map(markdownCell).join(" | ")} |`),
    "",
    ...Object.entries(outputFiles).map(([label, path]) => `- ${outputFileLabel(label)}：\`${path}\``),
    "",
  ].join("\n");
}

const args = process.argv.slice(2);
const oldRoot = resolve(argValue(args, "--old-root", "reports/experiment2-native-baseline-rerun-final"));
const outputDir = resolve(argValue(args, "--out", "reports/experiment2-int-mc-enhanced-comparison"));
const selectedProfiles = listArg(args, "--profiles", PROFILE_CATALOG.map((profile) => profile.id)).map((id) => {
  const profile = PROFILE_CATALOG.find((item) => item.id === id);
  if (!profile) throw new Error(`Unknown profile: ${id}`);
  return profile;
});
const samplingRate = Math.max(0.01, Math.min(1, numberArg(args, "--int-mc-sampling-rate", 0.25)));
const targetActiveLinkSamplingRate = Math.max(0.01, Math.min(1, numberArg(args, "--int-mc-target-active-link-sampling-rate", samplingRate)));
const rank = Math.max(1, Math.floor(numberArg(args, "--int-mc-rank", 5)));
const windowSize = Math.max(1, Math.floor(numberArg(args, "--int-mc-window-size", 12)));
const warmupSlices = Math.max(1, Math.floor(numberArg(args, "--int-mc-warmup-slices", 6)));
const iterations = Math.max(1, Math.floor(numberArg(args, "--int-mc-iterations", 12)));
const downlinkBudgetBytes = Math.max(0, Math.floor(numberArg(args, "--downlink-budget-bytes", 1_000_000_000)));
const maxPathsPerSlice = Math.max(1, Math.floor(numberArg(args, "--int-mc-max-paths-per-slice", 12)));
const oamTargetHopBytes = Math.max(16, numberArg(args, "--oam-target-hop-bytes", 96));
const oamTransitHopBytes = Math.max(16, Math.min(oamTargetHopBytes, numberArg(args, "--oam-transit-hop-bytes", 88)));
const observabilityMode = argValue(args, "--observability-mode", "oam-only").toLowerCase();
const scaleAdaptiveTotalBudget = argValue(args, "--scale-adaptive-total-budget", "true").toLowerCase() !== "false";
const scaleBudgetHeadroomRatio = Math.max(0, Math.min(1, numberArg(args, "--scale-budget-headroom-ratio", 0.1)));
const scaleBudgetPathHeadroomRatio = Math.max(0, Math.min(1, numberArg(args, "--scale-budget-path-headroom-ratio", 0.25)));

await mkdir(outputDir, { recursive: true });
const comparisonRows = [];
const runManifests = [];

for (const profile of selectedProfiles) {
  const truthDir = join(oldRoot, profile.id, "stage1-truth");
  const candidatePathsPath = join(oldRoot, profile.id, "experiment2", "stage2", "full-probe-int", "probe-paths-path-balance.csv");
  requireFile(join(truthDir, "links.csv"), `${profile.short_label} truth links`);
  requireFile(candidatePathsPath, `${profile.short_label} full-probe candidate paths`);

  const profileOut = join(outputDir, profile.id);
  const pass1Stage = join(profileOut, "stage2", "int-mc-pass1");
  const pass1Ground = join(profileOut, "ground-oam", "int-mc-pass1");
  const pass2Stage = join(profileOut, "stage2", "int-mc-enhanced");
  const pass2Ground = join(profileOut, "ground-oam", "int-mc-enhanced");

  const baselineMetrics = await runIntMcPass({
    label: `${profile.short_label} pass1`,
    truthDir,
    candidatePathsPath,
    stage2Dir: pass1Stage,
    groundDir: pass1Ground,
    samplingRate,
    targetActiveLinkSamplingRate,
    rank,
    windowSize,
    warmupSlices,
    iterations,
    downlinkBudgetBytes,
    maxPathsPerSlice,
    planner: "legacy-int-mc",
    adaptiveReuse: false,
    observabilityMode,
    scaleAdaptiveTotalBudget,
    scaleBudgetHeadroomRatio,
    scaleBudgetPathHeadroomRatio,
  });
  comparisonRows.push(baselineRowToComparison(profile, baselineMetrics));

  const combinedFeedbackPath = join(profileOut, "combined-int-mc-feedback.csv");
  const scaleBudgetReferenceCsvPath = join(pass1Stage, "probe-summary-int-mc.csv");
  const combinedFeedback = await combineFeedbackCsv({
    outputPath: combinedFeedbackPath,
    paths: [
      { source: "ground-oam-direct", path: join(pass1Ground, "ground-oam-priority-retest.csv") },
      { source: "int-mc-deployable", path: join(pass1Ground, "int-mc-deployable-priority-retest.csv") },
    ],
  });
  const deployableFeedbackPath = join(pass1Ground, "int-mc-deployable-priority-retest.csv");
  const enhancedMetrics = await runIntMcPass({
    label: `${profile.short_label} pass2 enhanced`,
    truthDir,
    candidatePathsPath,
    stage2Dir: pass2Stage,
    groundDir: pass2Ground,
    samplingRate,
    targetActiveLinkSamplingRate,
    rank,
    windowSize,
    warmupSlices,
    iterations,
    downlinkBudgetBytes,
    maxPathsPerSlice,
    planner: "topology-versioned-risk-int",
    plannerModes: "reuse,repair,fresh",
    adaptiveReuse: true,
    adaptiveStructuralReuse: true,
    structuralReuseErrorTolerance: 0.02,
    feedbackPath: combinedFeedbackPath,
    controlActionsPath: join(pass1Ground, "ground-oam-control-actions.csv"),
    topologyVersionedObjective: true,
    adaptiveProbeBudget: true,
    orbitGraphRegularization: true,
    orbitPeriodicPrior: true,
    orbitPeriodicPriorSlices: 19,
    oamQualityFeedback: true,
    businessHotspotMigrationPrior: false,
    metricTensorCoupling: true,
    nodeStateCoupling: true,
    nodeEnergyPhysicsPrior: true,
    jointStateCoupling: true,
    stateTensorJointCompletion: true,
    multiObjectiveBudget: true,
    oamTargetAwareMetadata: true,
    oamTargetHopBytes,
    oamTransitHopBytes,
    observabilityMode,
    scaleAdaptiveTotalBudget,
    scaleBudgetHeadroomRatio,
    scaleBudgetPathHeadroomRatio,
    scaleBudgetReferenceCsvPath,
    importanceAwareTargets: true,
    importanceMetadataOnly: false,
    importanceSelectiveMetadata: true,
    importancePathScoring: true,
    importanceBudgetNeutralReplacement: true,
    importanceStrictForwardOnly: true,
    plannerOamLinksPath: join(pass1Ground, "ground-mc-reconstructed-links.csv"),
    plannerOamNodesPath: join(pass1Ground, "ground-mc-reconstructed-nodes.csv"),
  });
  comparisonRows.push(enhancedRowToComparison(profile, enhancedMetrics));
  runManifests.push({
    constellation_profile_id: profile.id,
    old_baseline_root: oldRoot,
    truth_dir: truthDir,
    candidate_paths_csv: candidatePathsPath,
    pass1_stage2_dir: pass1Stage,
    pass1_ground_oam_dir: pass1Ground,
    pass2_stage2_dir: pass2Stage,
    pass2_ground_oam_dir: pass2Ground,
    combined_feedback_csv: combinedFeedbackPath,
    combined_feedback_rows: combinedFeedback.rows.length,
    scale_budget_reference_csv: scaleBudgetReferenceCsvPath,
    equal_scale_budget_schedule_enabled: true,
    deployable_feedback_csv: deployableFeedbackPath,
    pass1_selector_json: join(pass1Stage, "probe-coverage-int-mc.json"),
    pass1_evaluation_json: join(pass1Ground, "int-mc-evaluation.json"),
    pass2_selector_json: join(pass2Stage, "probe-coverage-int-mc.json"),
    pass2_evaluation_json: join(pass2Ground, "int-mc-evaluation.json"),
    observability_mode: observabilityMode,
    pass1_planner: "legacy-int-mc",
    pass1_adaptive_reuse: false,
    pass2_planner: "topology-versioned-risk-int",
    pass2_adaptive_reuse: true,
    pass2_adaptive_structural_reuse: true,
    truth_error_feedback_enabled: false,
  });
}

const summary = {
  schema_version: "experiment2-int-mc-enhancement-comparison-v1",
  generated_at: new Date().toISOString(),
  old_root: oldRoot,
  output_dir: outputDir,
  profiles: selectedProfiles.map((profile) => profile.id),
  parameters: {
    sampling_rate: samplingRate,
    target_active_link_sampling_rate: targetActiveLinkSamplingRate,
    rank,
    window_size: windowSize,
    warmup_slices: warmupSlices,
    iterations,
    downlink_budget_bytes: downlinkBudgetBytes,
    max_paths_per_slice: maxPathsPerSlice,
    equal_scale_budget_schedule_enabled: true,
    scale_budget_reference_source: "native-pass1-probe-summary",
    pass1_planner: "legacy-int-mc",
    pass1_adaptive_reuse: false,
    pass2_planner: "topology-versioned-risk-int",
    pass2_adaptive_reuse: true,
    pass2_adaptive_structural_reuse: true,
    observability_mode: observabilityMode,
    truth_error_feedback_enabled: false,
  },
  run_manifests: runManifests,
};

const outputFiles = {
  comparison_csv: join(outputDir, "experiment2-int-mc-enhancement-comparison.csv"),
  comparison_json: join(outputDir, "experiment2-int-mc-enhancement-comparison.json"),
  report_md: join(outputDir, "experiment2-int-mc-enhancement-comparison.md"),
  report_html: join(outputDir, "experiment2-int-mc-enhancement-comparison.html"),
};

await Promise.all([
  writeFile(outputFiles.comparison_csv, rowsToCsv(comparisonRows), "utf8"),
  writeFile(outputFiles.comparison_json, JSON.stringify({ ...summary, rows: comparisonRows, output_files: outputFiles }, null, 2), "utf8"),
  writeFile(outputFiles.report_md, buildMarkdown({ rows: comparisonRows, outputFiles, summary }), "utf8"),
  writeFile(outputFiles.report_html, `\uFEFF${buildHtml({ rows: comparisonRows, outputDir, outputFiles, summary })}`, "utf8"),
]);

console.log(JSON.stringify({
  ok: true,
  outputDir,
  reportHtml: outputFiles.report_html,
  comparisonCsv: outputFiles.comparison_csv,
  rows: comparisonRows.length,
  profiles: runManifests,
}, null, 2));
