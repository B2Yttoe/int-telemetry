import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";

function argValue(args, name, fallback = "") {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  return args[index + 1] ?? fallback;
}

function boolArg(args, name, fallback = true) {
  const value = argValue(args, name, "");
  if (!value) return fallback;
  return value !== "false";
}

function numberArg(args, name, fallback) {
  const raw = argValue(args, name, "");
  if (raw === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function sha256File(path) {
  const data = await readFile(path);
  return createHash("sha256").update(data).digest("hex");
}

async function countCsvRows(path) {
  const text = await readFile(path, "utf8");
  if (!text.trim()) return 0;
  let rowCount = 0;
  let quoted = false;
  let hasCellData = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === '"') {
      if (quoted && next === '"') index += 1;
      else quoted = !quoted;
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (hasCellData) rowCount += 1;
      hasCellData = false;
      if (char === "\r" && next === "\n") index += 1;
    } else if (char !== "," && char !== " " && char !== "\t") {
      hasCellData = true;
    }
  }
  if (hasCellData) rowCount += 1;
  return Math.max(rowCount - 1, 0);
}

async function csvHeaders(path) {
  const text = await readFile(path, "utf8");
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  return new Set(firstLine.split(",").map((header) => header.trim()).filter(Boolean));
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function resolveFromRun(runDir, value, fallback = "") {
  if (value) return resolve(String(value));
  return resolve(runDir, fallback);
}

function samePath(left, right) {
  if (!left || !right) return false;
  return resolve(String(left)) === resolve(String(right));
}

function nestedValue(object, path) {
  return path.split(".").reduce((current, part) => (current && current[part] !== undefined ? current[part] : undefined), object);
}

function nearlyAtLeast(value, threshold) {
  return typeof value === "number" && value + 1e-9 >= threshold;
}

function formatValue(value) {
  if (value === undefined || value === null || value === "") return "-";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(6)));
  return String(value);
}

function markdownTable(rows) {
  return [
    "| 检查项 | 结果 | 证据 |",
    "|---|---|---|",
    ...rows.map((row) => `| ${row.label} | ${row.passed ? "通过" : "未通过"} | ${row.evidence.replaceAll("|", "\\|")} |`),
  ].join("\n");
}

function fileIndexMarkdown(rows) {
  return [
    "| 角色 | 相对路径 | 字节数 | SHA-256 |",
    "|---|---|---:|---|",
    ...rows.map((row) => `| ${row.role} | ${row.relative_path.replaceAll("|", "\\|")} | ${row.size_bytes} | ${row.sha256} |`),
  ].join("\n");
}

const args = process.argv.slice(2);
const runArg = argValue(args, "--run", "");
const manifestArg = argValue(args, "--manifest", runArg ? join(runArg, "int-experiment-manifest.json") : "");
if (!manifestArg) {
  throw new Error("Usage: npm run int:verify -- --run stage2-int/runs/<run-name>");
}

const manifestPath = resolve(manifestArg);
if (!existsSync(manifestPath)) throw new Error(`Manifest not found: ${manifestPath}`);

const manifest = await readJson(manifestPath);
const runDir = resolve(runArg || manifest.run_dir || dirname(manifestPath));
const minProbeNodeCoverage = numberArg(args, "--min-probe-node-coverage", 1);
const minProbeLinkCoverage = numberArg(args, "--min-probe-link-coverage", 1);
const requireProbeFull = boolArg(args, "--require-probe-full", true);
const requireNoUnknownProbe = boolArg(args, "--require-no-unknown-probe", true);
const writeReport = boolArg(args, "--write", true);

const stage1Dir = resolveFromRun(runDir, manifest.outputs?.stage1_truth_dir, "stage1-truth");
const stage2Dir = resolveFromRun(runDir, manifest.outputs?.stage2_int_dir, "stage2-int");
const trafficGroundDir = resolveFromRun(runDir, manifest.outputs?.traffic_ground_oam_dir, "stage2-int/ground-traffic-int");
const probeGroundDir = resolveFromRun(
  runDir,
  manifest.outputs?.probe_ground_oam_dir,
  `stage2-int/ground-probe-${manifest.input?.algorithm ?? "path-balance"}`,
);
const algorithm = manifest.input?.algorithm ?? "path-balance";
const isIntMcRun = algorithm === "int-mc";

const checks = [];
function check(label, passed, evidence, extra = {}) {
  checks.push({
    label,
    passed: Boolean(passed),
    evidence,
    ...extra,
  });
}

function checkPath(label, path) {
  const exists = existsSync(path);
  const size = exists ? statSync(path).size : 0;
  check(label, exists && size >= 0, `${path}${exists ? ` (${size} bytes)` : " missing"}`, { path, size });
}

check("manifest schema", manifest.schema_version === "stage2-int-experiment-run-v1", formatValue(manifest.schema_version));
check("manifest objective", String(manifest.objective ?? "").includes("INT telemetry"), formatValue(manifest.objective));
check("stage1 runtime truth boundary", manifest.boundary?.stage1_truth_used_for_runtime === false, formatValue(manifest.boundary?.stage1_truth_used_for_runtime));
check("truth only for validation", manifest.boundary?.truth_used_only_for_validation === true, formatValue(manifest.boundary?.truth_used_only_for_validation));
check("ground OAM uses delivered reports", manifest.boundary?.ground_oam_uses_only_delivered_reports === true, formatValue(manifest.boundary?.ground_oam_uses_only_delivered_reports));
check("unknown not filled from truth", manifest.boundary?.unknown_not_filled_from_truth === true, formatValue(manifest.boundary?.unknown_not_filled_from_truth));
check("stage1 validation has no errors", (manifest.stage1?.validation?.errors ?? []).length === 0, `${(manifest.stage1?.validation?.errors ?? []).length} errors`);

const requiredFiles = {
  manifest: manifestPath,
  readme: resolveFromRun(runDir, manifest.outputs?.readme_md, "README.md"),
  inputValidationJson: resolveFromRun(runDir, manifest.outputs?.input_validation_json, "input-dataset-validation.json"),
  inputValidationMarkdown: resolveFromRun(runDir, manifest.outputs?.input_validation_md, "input-dataset-validation.md"),
  deliverablesJson: resolveFromRun(runDir, manifest.outputs?.deliverables_json, "int-telemetry-deliverables.json"),
  deliverablesMarkdown: resolveFromRun(runDir, manifest.outputs?.deliverables_md, "int-telemetry-deliverables.md"),
  processVisualizationJson: resolveFromRun(runDir, manifest.outputs?.process_visualization_json, "int-process-visualization.json"),
  processVisualizationMarkdown: resolveFromRun(runDir, manifest.outputs?.process_visualization_md, "int-process-visualization.md"),
  accuracyReportJson: resolveFromRun(runDir, manifest.outputs?.accuracy_report_json, "int-telemetry-accuracy-report.json"),
  accuracyReportMarkdown: resolveFromRun(runDir, manifest.outputs?.accuracy_report_md, "int-telemetry-accuracy-report.md"),
  report: resolveFromRun(runDir, manifest.outputs?.report_md, "int-experiment-report.md"),
  stage1Nodes: join(stage1Dir, "nodes.csv"),
  stage1Links: join(stage1Dir, "links.csv"),
  stage1Routes: join(stage1Dir, "routes.csv"),
  stage1Metrics: join(stage1Dir, "metrics.csv"),
  trafficHops: join(stage2Dir, "int-hop-records.csv"),
  trafficReports: join(stage2Dir, "int-reports.csv"),
  trafficOverheadBySlice: resolveFromRun(runDir, manifest.outputs?.traffic_overhead_by_slice_csv, "stage2-int/traffic-int-overhead-by-slice.csv"),
  trafficLinkOverhead: resolveFromRun(runDir, manifest.outputs?.traffic_link_overhead_csv, "stage2-int/traffic-int-link-overhead.csv"),
  trafficNodeOverhead: resolveFromRun(runDir, manifest.outputs?.traffic_node_overhead_csv, "stage2-int/traffic-int-node-overhead.csv"),
  probeHops: join(stage2Dir, `probe-int-hop-records-${algorithm}.csv`),
  probeReports: join(stage2Dir, `probe-int-reports-${algorithm}.csv`),
  probeOverheadBySlice: resolveFromRun(runDir, manifest.outputs?.probe_overhead_by_slice_csv, `stage2-int/probe-int-overhead-by-slice-${algorithm}.csv`),
  probeLinkOverhead: resolveFromRun(runDir, manifest.outputs?.probe_link_overhead_csv, `stage2-int/probe-int-link-overhead-${algorithm}.csv`),
  probeNodeOverhead: resolveFromRun(runDir, manifest.outputs?.probe_node_overhead_csv, `stage2-int/probe-int-node-overhead-${algorithm}.csv`),
  probePaths: join(stage2Dir, `probe-paths-${algorithm}.csv`),
  reportingPaths: join(stage2Dir, `reporting-paths-${algorithm}.csv`),
  trafficEvaluation: join(trafficGroundDir, "ground-oam-evaluation.json"),
  probeEvaluation: join(probeGroundDir, "ground-oam-evaluation.json"),
  trafficEstimateGraph: resolveFromRun(runDir, manifest.outputs?.traffic_ground_oam_estimate_graph_json, "stage2-int/ground-traffic-int/ground-oam-estimate-graph.json"),
  probeEstimateGraph: resolveFromRun(runDir, manifest.outputs?.probe_ground_oam_estimate_graph_json, `stage2-int/ground-probe-${algorithm}/ground-oam-estimate-graph.json`),
  trafficControlActions: resolveFromRun(runDir, manifest.outputs?.traffic_ground_oam_control_actions_csv, "stage2-int/ground-traffic-int/ground-oam-control-actions.csv"),
  probeControlActions: resolveFromRun(runDir, manifest.outputs?.probe_ground_oam_control_actions_csv, `stage2-int/ground-probe-${algorithm}/ground-oam-control-actions.csv`),
  coverageAudit: join(probeGroundDir, "full-telemetry-coverage-audit.json"),
  reconstructedNodes: join(probeGroundDir, "ground-reconstructed-nodes.csv"),
  reconstructedLinks: join(probeGroundDir, "ground-reconstructed-links.csv"),
  intMcReconstructedNodes: resolveFromRun(runDir, manifest.outputs?.int_mc_reconstructed_nodes_csv, "stage2-int/ground-probe-int-mc/ground-mc-reconstructed-nodes.csv"),
  intMcReconstructedLinks: resolveFromRun(runDir, manifest.outputs?.int_mc_reconstructed_links_csv, "stage2-int/ground-probe-int-mc/ground-mc-reconstructed-links.csv"),
  intMcLinkErrors: resolveFromRun(runDir, manifest.outputs?.int_mc_link_errors_csv, "stage2-int/ground-probe-int-mc/int-mc-link-errors.csv"),
  intMcNodeErrors: resolveFromRun(runDir, manifest.outputs?.int_mc_node_errors_csv, "stage2-int/ground-probe-int-mc/int-mc-node-errors.csv"),
  intMcNodeMatrixSummary: resolveFromRun(runDir, manifest.outputs?.int_mc_node_matrix_summary_csv, "stage2-int/ground-probe-int-mc/int-mc-node-matrix-summary.csv"),
  intMcMatrixSummary: resolveFromRun(runDir, manifest.outputs?.int_mc_matrix_summary_csv, "stage2-int/ground-probe-int-mc/int-mc-matrix-summary.csv"),
  intMcEvaluation: resolveFromRun(runDir, manifest.outputs?.int_mc_evaluation_json, "stage2-int/ground-probe-int-mc/int-mc-evaluation.json"),
  intMcContactPlan: resolveFromRun(runDir, manifest.outputs?.int_mc_contact_plan_json, "stage2-int/int-mc-contact-plan-int-mc.json"),
  intMcSamplingMask: resolveFromRun(runDir, manifest.outputs?.int_mc_sampling_mask_csv, "stage2-int/probe-sampling-mask-int-mc.csv"),
  intMcSelectionReport: resolveFromRun(runDir, manifest.outputs?.int_mc_selection_report_json, "stage2-int/probe-coverage-int-mc.json"),
  predictedContactPlanJson: resolveFromRun(runDir, manifest.outputs?.predicted_contact_plan_json, "stage2-int/predicted-contact-plan.json"),
  predictedContactPlanCsv: resolveFromRun(runDir, manifest.outputs?.predicted_contact_plan_csv, "stage2-int/predicted-contact-plan.csv"),
  predictedContactPlanSummary: resolveFromRun(runDir, manifest.outputs?.predicted_contact_plan_summary_csv, "stage2-int/predicted-contact-plan-summary.csv"),
  predictedTopologyForecast: resolveFromRun(runDir, manifest.outputs?.predicted_topology_forecast_csv, "stage2-int/predicted-topology-forecast.csv"),
  predictedContactPlanWindows: resolveFromRun(runDir, manifest.outputs?.predicted_contact_plan_windows_csv, "stage2-int/predicted-contact-plan-windows.csv"),
  predictedContactPlanEvaluation: resolveFromRun(runDir, manifest.outputs?.predicted_contact_plan_evaluation_json, "stage2-int/predicted-contact-plan-evaluation.json"),
};

Object.entries(requiredFiles).forEach(([label, path]) => {
  if (!isIntMcRun && label.startsWith("intMc")) return;
  if (!isIntMcRun && (label.startsWith("predictedContactPlan") || label.startsWith("predictedTopology"))) return;
  checkPath(`file exists: ${label}`, path);
});
if (manifest.input?.tasks_snapshot_path) {
  checkPath("file exists: taskDatasetSnapshot", resolve(String(manifest.input.tasks_snapshot_path)));
}

const csvExpectations = [
  ["stage1 nodes rows", requiredFiles.stage1Nodes, manifest.stage1?.counts?.nodes],
  ["stage1 links rows", requiredFiles.stage1Links, manifest.stage1?.counts?.links],
  ["stage1 routes rows", requiredFiles.stage1Routes, manifest.stage1?.counts?.routes],
  ["stage1 metrics rows", requiredFiles.stage1Metrics, manifest.stage1?.counts?.metrics],
  ["traffic hop rows", requiredFiles.trafficHops, manifest.int_pipeline?.traffic_int?.hopRecords],
  ["traffic report rows", requiredFiles.trafficReports, manifest.int_pipeline?.traffic_int?.reports],
  ["traffic overhead slice rows", requiredFiles.trafficOverheadBySlice, manifest.stage1?.counts?.metrics],
  ["traffic link overhead rows", requiredFiles.trafficLinkOverhead, manifest.int_pipeline?.traffic_int?.linkOverheadRows],
  ["traffic node overhead rows", requiredFiles.trafficNodeOverhead, manifest.stage1?.counts?.nodes],
  ["probe hop rows", requiredFiles.probeHops, manifest.int_pipeline?.probe_int?.hopRecords],
  ["probe report rows", requiredFiles.probeReports, manifest.int_pipeline?.probe_int?.reports],
  ["probe overhead slice rows", requiredFiles.probeOverheadBySlice, manifest.stage1?.counts?.metrics],
  ["probe link overhead rows", requiredFiles.probeLinkOverhead, manifest.int_pipeline?.probe_int?.linkOverheadRows],
  ["probe node overhead rows", requiredFiles.probeNodeOverhead, manifest.stage1?.counts?.nodes],
  ["probe path rows", requiredFiles.probePaths, manifest.int_pipeline?.probe_int?.probePaths],
  ["reporting path rows", requiredFiles.reportingPaths, manifest.int_pipeline?.reporting?.plannedReportingPaths],
  ["probe reconstructed node rows", requiredFiles.reconstructedNodes, manifest.stage1?.counts?.nodes],
  ["probe reconstructed link rows", requiredFiles.reconstructedLinks, manifest.stage1?.counts?.links],
  ["traffic OAM control action rows", requiredFiles.trafficControlActions, manifest.stage1?.counts?.metrics],
  ["probe OAM control action rows", requiredFiles.probeControlActions, manifest.stage1?.counts?.metrics],
  ...(isIntMcRun
    ? [
        ["int-mc reconstructed node rows", requiredFiles.intMcReconstructedNodes, manifest.stage1?.counts?.nodes],
        ["int-mc reconstructed link rows", requiredFiles.intMcReconstructedLinks, manifest.stage1?.counts?.links],
        ["int-mc sampling mask rows", requiredFiles.intMcSamplingMask, manifest.stage1?.counts?.links],
        ["predicted contact plan rows", requiredFiles.predictedContactPlanCsv, manifest.stage1?.counts?.links],
        ["predicted contact plan summary rows", requiredFiles.predictedContactPlanSummary, manifest.stage1?.counts?.metrics],
        ["predicted topology forecast rows", requiredFiles.predictedTopologyForecast, manifest.stage1?.counts?.metrics],
      ]
    : []),
];

for (const [label, path, expected] of csvExpectations) {
  if (!existsSync(path)) {
    check(label, false, `${path} missing`);
    continue;
  }
  const actual = await countCsvRows(path);
  check(label, actual === expected, `actual=${actual}, expected=${formatValue(expected)}`, { actual, expected });
}

for (const [label, path] of [
  ["traffic hop queue-latency schema", requiredFiles.trafficHops],
  ["probe hop queue-latency schema", requiredFiles.probeHops],
]) {
  if (!existsSync(path)) {
    check(label, false, `${path} missing`);
    continue;
  }
  const headers = await csvHeaders(path);
  const requiredHeaders = [
    "observed_link_latency_ms",
    "observed_link_queue_latency_ms",
    "observed_link_propagation_latency_ms",
    "observed_link_queue_latency_formula",
  ];
  const missing = requiredHeaders.filter((header) => !headers.has(header));
  check(label, missing.length === 0, missing.length ? `missing=${missing.join(",")}` : "hop queue-latency columns present");
}

for (const [label, path] of [
  ["traffic node overhead schema", requiredFiles.trafficNodeOverhead],
  ["probe node overhead schema", requiredFiles.probeNodeOverhead],
]) {
  if (!existsSync(path)) {
    check(label, false, `${path} missing`);
    continue;
  }
  const headers = await csvHeaders(path);
  const requiredHeaders = [
    "node_id",
    "energy_percent",
    "in_sunlight",
    "hop_records",
    "metadata_bytes_added",
    "generated_reports",
    "sgl_downlink_report_bytes",
    "processing_energy_j",
    "tx_energy_j",
    "total_telemetry_energy_j",
    "telemetry_energy_soc_percent",
  ];
  const missing = requiredHeaders.filter((header) => !headers.has(header));
  check(label, missing.length === 0, missing.length ? `missing=${missing.join(",")}` : "node telemetry overhead columns present");
}

for (const [label, path] of [
  ["traffic OAM control action schema", requiredFiles.trafficControlActions],
  ["probe OAM control action schema", requiredFiles.probeControlActions],
]) {
  if (!existsSync(path)) {
    check(label, false, `${path} missing`);
    continue;
  }
  const headers = await csvHeaders(path);
  const requiredHeaders = [
    "slice_index",
    "recommended_action",
    "probe_bias",
    "confidence_budget",
    "oam_control_pressure",
    "unknown_pressure",
    "stale_pressure",
    "stale_age_pressure",
    "confidence_debt_pressure",
    "fusion_conflict_pressure",
    "coverage_demand_pressure",
    "recommended_sampling_rate",
    "recommended_target_active_link_sampling_rate",
    "recommended_telemetry_byte_budget_per_slice",
    "recommended_downlink_budget_bytes",
    "budget_recommendation_action",
    "budget_recommendation_reason",
    "budget_recommendation_source",
    "priority_retest_targets",
    "top_node_targets",
    "top_link_targets",
    "control_boundary",
  ];
  const missing = requiredHeaders.filter((header) => !headers.has(header));
  check(label, missing.length === 0, missing.length ? `missing=${missing.join(",")}` : "OAM control action columns present");
}

for (const [label, path] of [
  ["probe reconstructed node OAM state schema", requiredFiles.reconstructedNodes],
  ["probe reconstructed link OAM state schema", requiredFiles.reconstructedLinks],
]) {
  if (!existsSync(path)) {
    check(label, false, `${path} missing`);
    continue;
  }
  const headers = await csvHeaders(path);
  const requiredHeaders = [
    "confidence_before_decay",
    "confidence_decay_factor",
    "confidence_state",
    "state_age_slices",
    "conflict_severity",
    "categorical_conflict_ratio",
    "numeric_conflict_ratio",
    "fusion_confidence_penalty",
    "fusion_sample_support",
    "fusion_method",
  ];
  const missing = requiredHeaders.filter((header) => !headers.has(header));
  check(label, missing.length === 0, missing.length ? `missing=${missing.join(",")}` : "OAM confidence and fusion columns present");
}

if (isIntMcRun) {
  const probePathHeaders = existsSync(requiredFiles.probePaths) ? await csvHeaders(requiredFiles.probePaths) : new Set();
  const requiredProbePathHeaders = [
    "cost_aware_sampling_enabled",
    "cost_aware_score",
    "cost_aware_value_per_kb",
    "topology_forecast_stable_window_slices",
    "topology_forecast_drift_pressure",
    "topology_forecast_recommended_plan_mode",
    "topology_forecast_target_sampling_boost",
    "oam_budget_applied",
    "oam_budget_policy",
    "oam_recommended_sampling_rate",
    "oam_recommended_telemetry_byte_budget_per_slice",
    "telemetry_byte_budget_enabled",
    "telemetry_byte_budget_per_slice",
    "telemetry_budget_decision",
    "telemetry_budget_used_bytes_after_selection",
    "telemetry_budget_remaining_bytes_after_selection",
    "estimated_metadata_bytes",
    "estimated_report_bytes",
    "estimated_probe_forward_bytes",
    "estimated_total_telemetry_bytes",
    "estimated_total_telemetry_energy_j",
  ];
  const missingProbePathHeaders = requiredProbePathHeaders.filter((header) => !probePathHeaders.has(header));
  check(
    "int-mc probe path cost-aware schema",
    missingProbePathHeaders.length === 0,
    missingProbePathHeaders.length ? `missing=${missingProbePathHeaders.join(",")}` : "probe path cost-aware columns present",
  );

  const samplingHeaders = existsSync(requiredFiles.intMcSamplingMask) ? await csvHeaders(requiredFiles.intMcSamplingMask) : new Set();
  const requiredSamplingHeaders = [
    "slice_index",
    "link_id",
    "topology_class_id",
    "predicted_active",
    "active_mask_value",
    "sampled_by_probe_plan",
    "sampling_mask_value",
    "completion_role",
    "selected_probe_count",
    "selection_strategy",
    "effective_target_active_link_sampling_rate",
    "energy_budget_scale",
    "energy_budget_pressure",
    "energy_budget_reason",
    "adaptive_reuse_threshold",
    "adaptive_threshold_reason",
    "topology_forecast_stable_window_slices",
    "topology_forecast_drift_pressure",
    "topology_forecast_target_sampling_boost",
    "adaptive_threshold_calibration_policy",
    "adaptive_threshold_calibration_evidence_count",
    "adaptive_threshold_calibration_net_adjustment",
    "topology_reuse_margin",
    "forecast_horizon_slices",
    "forecast_transition_score",
    "forecast_first_change_in_slices",
    "forecast_near_outage_score",
    "forecast_priority_score",
    "oam_control_action",
    "oam_control_pressure",
    "oam_control_replan_triggered",
    "oam_budget_policy",
    "oam_budget_applied",
    "oam_recommended_sampling_rate",
    "oam_recommended_telemetry_byte_budget_per_slice",
    "telemetry_budget_policy",
    "telemetry_budget_utilization",
    "telemetry_budget_suppressed_paths",
    "telemetry_budget_override_paths",
  ];
  const missingSamplingHeaders = requiredSamplingHeaders.filter((header) => !samplingHeaders.has(header));
  check(
    "int-mc sampling mask schema",
    missingSamplingHeaders.length === 0,
    missingSamplingHeaders.length ? `missing=${missingSamplingHeaders.join(",")}` : "slice-link sampling mask columns present",
  );

  const reconstructedLinkHeaders = existsSync(requiredFiles.intMcReconstructedLinks)
    ? await csvHeaders(requiredFiles.intMcReconstructedLinks)
    : new Set();
  const requiredReconstructedLinkHeaders = [
    "source_plane",
    "source_slot",
    "target_plane",
    "target_slot",
    "tensor_coordinate",
    "tensor_neighbor_count",
    "queue_latency_ms_estimate",
    "context_prior_risk",
    "context_prior_tags",
    "latitude_context",
    "link_availability_context",
    "completion_prior_stack",
  ];
  const missingReconstructedLinkHeaders = requiredReconstructedLinkHeaders.filter((header) => !reconstructedLinkHeaders.has(header));
  check(
    "int-mc reconstructed link tensor schema",
    missingReconstructedLinkHeaders.length === 0,
    missingReconstructedLinkHeaders.length ? `missing=${missingReconstructedLinkHeaders.join(",")}` : "link tensor coordinate columns present",
  );

  const reconstructedNodeHeaders = existsSync(requiredFiles.intMcReconstructedNodes)
    ? await csvHeaders(requiredFiles.intMcReconstructedNodes)
    : new Set();
  const requiredReconstructedNodeHeaders = [
    "tensor_plane",
    "tensor_slot",
    "tensor_coordinate",
    "tensor_neighbor_count",
    "context_prior_risk",
    "context_prior_tags",
    "latitude_context",
    "illumination_context",
    "completion_prior_stack",
  ];
  const missingReconstructedNodeHeaders = requiredReconstructedNodeHeaders.filter((header) => !reconstructedNodeHeaders.has(header));
  check(
    "int-mc reconstructed node tensor schema",
    missingReconstructedNodeHeaders.length === 0,
    missingReconstructedNodeHeaders.length ? `missing=${missingReconstructedNodeHeaders.join(",")}` : "node tensor coordinate columns present",
  );
}

const trafficEvaluation = existsSync(requiredFiles.trafficEvaluation) ? await readJson(requiredFiles.trafficEvaluation) : {};
const probeEvaluation = existsSync(requiredFiles.probeEvaluation) ? await readJson(requiredFiles.probeEvaluation) : {};
const trafficEstimateGraph = existsSync(requiredFiles.trafficEstimateGraph) ? await readJson(requiredFiles.trafficEstimateGraph) : {};
const probeEstimateGraph = existsSync(requiredFiles.probeEstimateGraph) ? await readJson(requiredFiles.probeEstimateGraph) : {};
const coverageAudit = existsSync(requiredFiles.coverageAudit) ? await readJson(requiredFiles.coverageAudit) : {};
const inputValidation = existsSync(requiredFiles.inputValidationJson) ? await readJson(requiredFiles.inputValidationJson) : {};
const deliverables = existsSync(requiredFiles.deliverablesJson) ? await readJson(requiredFiles.deliverablesJson) : {};
const processVisualization = existsSync(requiredFiles.processVisualizationJson) ? await readJson(requiredFiles.processVisualizationJson) : {};
const accuracyReport = existsSync(requiredFiles.accuracyReportJson) ? await readJson(requiredFiles.accuracyReportJson) : {};
const intMcEvaluation = isIntMcRun && existsSync(requiredFiles.intMcEvaluation) ? await readJson(requiredFiles.intMcEvaluation) : {};
const intMcSelectionReport = isIntMcRun && existsSync(requiredFiles.intMcSelectionReport) ? await readJson(requiredFiles.intMcSelectionReport) : {};
const predictedContactPlan = isIntMcRun && existsSync(requiredFiles.predictedContactPlanJson) ? await readJson(requiredFiles.predictedContactPlanJson) : {};

check("traffic OAM boundary", trafficEvaluation.boundary?.runtime_uses_only_delivered_int_reports === true, formatValue(trafficEvaluation.boundary?.runtime_uses_only_delivered_int_reports));
check("probe OAM boundary", probeEvaluation.boundary?.runtime_uses_only_delivered_int_reports === true, formatValue(probeEvaluation.boundary?.runtime_uses_only_delivered_int_reports));
check("traffic OAM estimate graph schema", trafficEstimateGraph.schema_version === "stage2-ground-oam-estimate-graph-v1", formatValue(trafficEstimateGraph.schema_version));
check("probe OAM estimate graph schema", probeEstimateGraph.schema_version === "stage2-ground-oam-estimate-graph-v1", formatValue(probeEstimateGraph.schema_version));
check("probe OAM estimate graph boundary", probeEstimateGraph.boundary?.truth_values_not_used_to_fill_state === true, formatValue(probeEstimateGraph.boundary?.truth_values_not_used_to_fill_state));
check("probe OAM prior not observed", probeEstimateGraph.boundary?.prior_estimates_not_counted_as_observed === true, formatValue(probeEstimateGraph.boundary?.prior_estimates_not_counted_as_observed));
check("probe OAM control action boundary", probeEstimateGraph.boundary?.control_actions_use_only_oam_estimates === true, formatValue(probeEstimateGraph.boundary?.control_actions_use_only_oam_estimates));
check("probe OAM confidence decay model", probeEstimateGraph.oam_state_model?.stale_confidence_decay === "exponential-half-life", formatValue(probeEstimateGraph.oam_state_model?.stale_confidence_decay));
check("probe OAM conflict-aware fusion model", String(probeEstimateGraph.oam_state_model?.report_fusion ?? "").includes("conflict-aware"), formatValue(probeEstimateGraph.oam_state_model?.report_fusion));
check("probe OAM estimate graph slice count", Array.isArray(probeEstimateGraph.slices) && probeEstimateGraph.slices.length === manifest.stage1?.counts?.metrics, `actual=${probeEstimateGraph.slices?.length ?? 0}, expected=${formatValue(manifest.stage1?.counts?.metrics)}`);
check("probe OAM control action slice count", Array.isArray(probeEstimateGraph.control_actions) && probeEstimateGraph.control_actions.length === manifest.stage1?.counts?.metrics, `actual=${probeEstimateGraph.control_actions?.length ?? 0}, expected=${formatValue(manifest.stage1?.counts?.metrics)}`);
check("probe OAM control pressure summary", typeof probeEstimateGraph.summary?.mean_oam_control_pressure === "number", formatValue(probeEstimateGraph.summary?.mean_oam_control_pressure));
check("probe OAM adaptive budget summary", typeof probeEstimateGraph.summary?.mean_recommended_sampling_rate === "number", formatValue(probeEstimateGraph.summary?.mean_recommended_sampling_rate));
check("probe OAM telemetry budget recommendation summary", typeof probeEstimateGraph.summary?.mean_recommended_telemetry_byte_budget_per_slice === "number", formatValue(probeEstimateGraph.summary?.mean_recommended_telemetry_byte_budget_per_slice));
check("probe OAM stale age summary", typeof probeEstimateGraph.summary?.mean_stale_age_slices === "number", formatValue(probeEstimateGraph.summary?.mean_stale_age_slices));
check("probe OAM conflict severity summary", typeof probeEstimateGraph.summary?.mean_conflict_severity === "number", formatValue(probeEstimateGraph.summary?.mean_conflict_severity));
check("input validation schema", inputValidation.schema_version === "stage2-int-input-dataset-validation-v1", formatValue(inputValidation.schema_version));
check("input validation pass", inputValidation.status?.pass === true, formatValue(inputValidation.status?.pass));
check("input validation stage1 errors", inputValidation.status?.stage1_effective_errors === 0, formatValue(inputValidation.status?.stage1_effective_errors));
check("input validation snapshot path", !manifest.input?.tasks_snapshot_path || samePath(inputValidation.input?.task_dataset_snapshot, manifest.input.tasks_snapshot_path), formatValue(inputValidation.input?.task_dataset_snapshot));
check("input validation stage1 fingerprint", inputValidation.fingerprints?.stage1_dataset === manifest.stage1?.fingerprints?.dataset, formatValue(inputValidation.fingerprints?.stage1_dataset));
check("deliverables schema", deliverables.schema_version === "stage2-int-telemetry-deliverables-v1", formatValue(deliverables.schema_version));
check(
  "deliverables primary node dataset",
  samePath(
    deliverables.primary_int_state_dataset?.node_state_csv,
    isIntMcRun ? requiredFiles.intMcReconstructedNodes : requiredFiles.reconstructedNodes,
  ),
  formatValue(deliverables.primary_int_state_dataset?.node_state_csv),
);
check(
  "deliverables primary link dataset",
  samePath(
    deliverables.primary_int_state_dataset?.link_state_csv,
    isIntMcRun ? requiredFiles.intMcReconstructedLinks : requiredFiles.reconstructedLinks,
  ),
  formatValue(deliverables.primary_int_state_dataset?.link_state_csv),
);
check("deliverables input validation", samePath(deliverables.input?.input_validation_json, requiredFiles.inputValidationJson), formatValue(deliverables.input?.input_validation_json));
check("deliverables final accuracy report", samePath(deliverables.validation?.final_accuracy_report_json, requiredFiles.accuracyReportJson), formatValue(deliverables.validation?.final_accuracy_report_json));
check("deliverables process visualization", samePath(deliverables.process_visualization?.visualization_json, requiredFiles.processVisualizationJson), formatValue(deliverables.process_visualization?.visualization_json));
check("deliverables traffic overhead by slice", samePath(deliverables.overhead_datasets?.traffic_overhead_by_slice_csv, requiredFiles.trafficOverheadBySlice), formatValue(deliverables.overhead_datasets?.traffic_overhead_by_slice_csv));
check("deliverables probe overhead by slice", samePath(deliverables.overhead_datasets?.probe_overhead_by_slice_csv, requiredFiles.probeOverheadBySlice), formatValue(deliverables.overhead_datasets?.probe_overhead_by_slice_csv));
check("deliverables probe link overhead", samePath(deliverables.overhead_datasets?.probe_link_overhead_csv, requiredFiles.probeLinkOverhead), formatValue(deliverables.overhead_datasets?.probe_link_overhead_csv));
check("deliverables traffic node overhead", samePath(deliverables.overhead_datasets?.traffic_node_overhead_csv, requiredFiles.trafficNodeOverhead), formatValue(deliverables.overhead_datasets?.traffic_node_overhead_csv));
check("deliverables probe node overhead", samePath(deliverables.overhead_datasets?.probe_node_overhead_csv, requiredFiles.probeNodeOverhead), formatValue(deliverables.overhead_datasets?.probe_node_overhead_csv));
check("deliverables primary estimate graph", samePath(deliverables.primary_int_state_dataset?.estimate_graph_json, requiredFiles.probeEstimateGraph), formatValue(deliverables.primary_int_state_dataset?.estimate_graph_json));
check("deliverables primary control actions", samePath(deliverables.primary_int_state_dataset?.control_actions_csv, requiredFiles.probeControlActions), formatValue(deliverables.primary_int_state_dataset?.control_actions_csv));
if (isIntMcRun) {
  check("deliverables int-mc sampling mask", samePath(deliverables.int_mc_outputs?.sampling_mask_csv, requiredFiles.intMcSamplingMask), formatValue(deliverables.int_mc_outputs?.sampling_mask_csv));
  check("int-mc prediction score horizon", Number.isFinite(Number(manifest.input?.int_mc?.prediction_score_horizon_slices)), formatValue(manifest.input?.int_mc?.prediction_score_horizon_slices));
  check(
    "int-mc forecast-aware selection policy",
    Array.isArray(intMcSelectionReport.method?.satellite_adaptations) &&
      intMcSelectionReport.method.satellite_adaptations.some((item) => String(item).includes("forecast-aware path scoring")),
    formatValue(intMcSelectionReport.method?.satellite_adaptations),
  );
  check(
    "int-mc topology forecast selection policy",
    Array.isArray(intMcSelectionReport.method?.satellite_adaptations) &&
      intMcSelectionReport.method.satellite_adaptations.some((item) => String(item).includes("stable-window length and drift pressure")),
    formatValue(intMcSelectionReport.method?.satellite_adaptations),
  );
  check("int-mc topology forecast drift summary", typeof intMcSelectionReport.coverage?.mean_topology_forecast_drift_pressure === "number", formatValue(intMcSelectionReport.coverage?.mean_topology_forecast_drift_pressure));
  check("int-mc forecast priority summary", typeof intMcSelectionReport.coverage?.mean_forecast_priority_score === "number", formatValue(intMcSelectionReport.coverage?.mean_forecast_priority_score));
  check("int-mc cost-aware sampling parameter", typeof intMcSelectionReport.parameters?.cost_awareness_weight === "number", formatValue(intMcSelectionReport.parameters?.cost_awareness_weight));
  check("int-mc cost-aware selection policy", Array.isArray(intMcSelectionReport.method?.satellite_adaptations) && intMcSelectionReport.method.satellite_adaptations.some((item) => String(item).includes("cost-aware marginal sampling")), formatValue(intMcSelectionReport.method?.satellite_adaptations));
  check("int-mc estimated telemetry byte summary", typeof intMcSelectionReport.coverage?.estimated_total_telemetry_bytes === "number", formatValue(intMcSelectionReport.coverage?.estimated_total_telemetry_bytes));
  check("int-mc cost-aware value summary", typeof intMcSelectionReport.coverage?.mean_cost_aware_value_per_kb === "number", formatValue(intMcSelectionReport.coverage?.mean_cost_aware_value_per_kb));
  check("int-mc telemetry byte budget parameter", typeof intMcSelectionReport.parameters?.telemetry_byte_budget_per_slice === "number", formatValue(intMcSelectionReport.parameters?.telemetry_byte_budget_per_slice));
  check("int-mc telemetry budget suppression summary", typeof intMcSelectionReport.coverage?.telemetry_budget_suppressed_paths === "number", formatValue(intMcSelectionReport.coverage?.telemetry_budget_suppressed_paths));
  check("int-mc telemetry budget override summary", typeof intMcSelectionReport.coverage?.telemetry_budget_override_paths === "number", formatValue(intMcSelectionReport.coverage?.telemetry_budget_override_paths));
  check("int-mc OAM adaptive budget selection policy", Array.isArray(intMcSelectionReport.method?.satellite_adaptations) && intMcSelectionReport.method.satellite_adaptations.some((item) => String(item).includes("Ground OAM control actions can recommend")), formatValue(intMcSelectionReport.method?.satellite_adaptations));
  check("int-mc OAM adaptive budget summary", typeof intMcSelectionReport.coverage?.oam_budget_applied_slices === "number", formatValue(intMcSelectionReport.coverage?.oam_budget_applied_slices));
}
check("deliverables probe node coverage", deliverables.primary_int_state_dataset?.coverage?.node_sample_coverage === manifest.accuracy?.probe_int?.node_sample_coverage, formatValue(deliverables.primary_int_state_dataset?.coverage?.node_sample_coverage));
check("deliverables probe link coverage", deliverables.primary_int_state_dataset?.coverage?.link_sample_coverage === manifest.accuracy?.probe_int?.link_sample_coverage, formatValue(deliverables.primary_int_state_dataset?.coverage?.link_sample_coverage));
check("deliverables validation truth boundary", deliverables.validation?.truth_boundary?.truth_used_only_for_validation === true, formatValue(deliverables.validation?.truth_boundary?.truth_used_only_for_validation));
check("deliverables unknown boundary", deliverables.validation?.truth_boundary?.unknown_not_filled_from_truth === true, formatValue(deliverables.validation?.truth_boundary?.unknown_not_filled_from_truth));
check("process visualization schema", processVisualization.schema_version === "stage2-int-process-visualization-v1", formatValue(processVisualization.schema_version));
check("process visualization slice count", Array.isArray(processVisualization.slices) && processVisualization.slices.length === manifest.stage1?.counts?.metrics, `actual=${processVisualization.slices?.length ?? 0}, expected=${formatValue(manifest.stage1?.counts?.metrics)}`);
check("process visualization has probes", (processVisualization.summary?.probes ?? 0) === manifest.int_pipeline?.probe_int?.probePaths, `actual=${formatValue(processVisualization.summary?.probes)}, expected=${formatValue(manifest.int_pipeline?.probe_int?.probePaths)}`);
check("process visualization has hop events", (processVisualization.summary?.hop_events ?? 0) === manifest.int_pipeline?.probe_int?.hopRecords, `actual=${formatValue(processVisualization.summary?.hop_events)}, expected=${formatValue(manifest.int_pipeline?.probe_int?.hopRecords)}`);
check("process visualization has report events", (processVisualization.summary?.report_events ?? 0) === manifest.int_pipeline?.probe_int?.reports, `actual=${formatValue(processVisualization.summary?.report_events)}, expected=${formatValue(manifest.int_pipeline?.probe_int?.reports)}`);
check("process visualization OAM snapshots", Array.isArray(processVisualization.slices) && processVisualization.slices.every((slice) => slice.oam_reconstruction?.nodes?.length > 0 && slice.oam_reconstruction?.links?.length > 0), "every slice has reconstructed nodes and links");
check("process visualization non-truth state boundary", processVisualization.boundary?.process_view_uses_truth_for_state === false, formatValue(processVisualization.boundary?.process_view_uses_truth_for_state));
check("accuracy report schema", accuracyReport.schema_version === "stage2-int-telemetry-accuracy-report-v1", formatValue(accuracyReport.schema_version));
check("accuracy report conclusion", accuracyReport.conclusion?.pass === true, formatValue(accuracyReport.conclusion?.pass));
check(
  "accuracy report primary node dataset",
  samePath(
    accuracyReport.primary_probe_int?.node_state_csv,
    isIntMcRun ? requiredFiles.intMcReconstructedNodes : requiredFiles.reconstructedNodes,
  ),
  formatValue(accuracyReport.primary_probe_int?.node_state_csv),
);
check(
  "accuracy report primary link dataset",
  samePath(
    accuracyReport.primary_probe_int?.link_state_csv,
    isIntMcRun ? requiredFiles.intMcReconstructedLinks : requiredFiles.reconstructedLinks,
  ),
  formatValue(accuracyReport.primary_probe_int?.link_state_csv),
);
check("accuracy report probe node coverage", accuracyReport.primary_probe_int?.metrics?.node_sample_coverage === manifest.accuracy?.probe_int?.node_sample_coverage, formatValue(accuracyReport.primary_probe_int?.metrics?.node_sample_coverage));
check("accuracy report probe link coverage", accuracyReport.primary_probe_int?.metrics?.link_sample_coverage === manifest.accuracy?.probe_int?.link_sample_coverage, formatValue(accuracyReport.primary_probe_int?.metrics?.link_sample_coverage));
check("accuracy report estimate graph", samePath(accuracyReport.primary_probe_int?.estimate_graph_json, requiredFiles.probeEstimateGraph), formatValue(accuracyReport.primary_probe_int?.estimate_graph_json));
if (isIntMcRun) {
  check("int-mc selection completed", manifest.int_pipeline?.int_mc_selection?.ok === true, formatValue(manifest.int_pipeline?.int_mc_selection?.ok));
  check("int-mc reconstruction completed", manifest.int_pipeline?.int_mc_reconstruction?.ok === true, formatValue(manifest.int_pipeline?.int_mc_reconstruction?.ok));
  check("int-mc selection report schema", intMcSelectionReport.schema_version === "stage2-leo-int-mc-path-selection-v1", formatValue(intMcSelectionReport.schema_version));
  check("int-mc adaptive threshold policy", intMcSelectionReport.parameters?.adaptive_threshold_policy === "calibrated-tighten-on-drift-oam-risk-relax-on-stability-planning-pressure", formatValue(intMcSelectionReport.parameters?.adaptive_threshold_policy));
  check("int-mc threshold calibration horizon parameter", typeof intMcSelectionReport.parameters?.threshold_calibration_horizon_slices === "number", formatValue(intMcSelectionReport.parameters?.threshold_calibration_horizon_slices));
  check("int-mc adaptive threshold tightening field", typeof intMcSelectionReport.coverage?.mean_adaptive_threshold_total_tightening === "number", formatValue(intMcSelectionReport.coverage?.mean_adaptive_threshold_total_tightening));
  check("int-mc adaptive threshold relaxation field", typeof intMcSelectionReport.coverage?.mean_adaptive_threshold_total_relaxation === "number", formatValue(intMcSelectionReport.coverage?.mean_adaptive_threshold_total_relaxation));
  check("int-mc adaptive threshold calibration ambiguity field", typeof intMcSelectionReport.coverage?.mean_adaptive_threshold_calibration_ambiguity_penalty === "number", formatValue(intMcSelectionReport.coverage?.mean_adaptive_threshold_calibration_ambiguity_penalty));
  check("int-mc adaptive threshold calibration future drift field", typeof intMcSelectionReport.coverage?.mean_adaptive_threshold_calibration_future_drift_penalty === "number", formatValue(intMcSelectionReport.coverage?.mean_adaptive_threshold_calibration_future_drift_penalty));
  check("int-mc adaptive threshold calibration confidence field", typeof intMcSelectionReport.coverage?.mean_adaptive_threshold_calibration_evidence_confidence === "number", formatValue(intMcSelectionReport.coverage?.mean_adaptive_threshold_calibration_evidence_confidence));
  check("int-mc adaptive threshold calibrated slice field", typeof intMcSelectionReport.coverage?.calibrated_threshold_slices === "number", formatValue(intMcSelectionReport.coverage?.calibrated_threshold_slices));
  check("int-mc topology reuse margin field", typeof intMcSelectionReport.coverage?.mean_topology_reuse_margin === "number", formatValue(intMcSelectionReport.coverage?.mean_topology_reuse_margin));
  check("int-mc energy guard parameter", typeof intMcSelectionReport.parameters?.energy_guard_threshold === "number", formatValue(intMcSelectionReport.parameters?.energy_guard_threshold));
  check("int-mc energy guard coverage field", typeof intMcSelectionReport.coverage?.energy_guard_suppressed_paths === "number", formatValue(intMcSelectionReport.coverage?.energy_guard_suppressed_paths));
  check("int-mc energy budget parameter", typeof intMcSelectionReport.parameters?.energy_budget_max_reduction === "number", formatValue(intMcSelectionReport.parameters?.energy_budget_max_reduction));
  check("int-mc energy budget effective rate field", typeof intMcSelectionReport.coverage?.mean_effective_target_active_link_sampling_rate === "number", formatValue(intMcSelectionReport.coverage?.mean_effective_target_active_link_sampling_rate));
  check("int-mc energy budget pressure field", typeof intMcSelectionReport.coverage?.mean_energy_budget_pressure === "number", formatValue(intMcSelectionReport.coverage?.mean_energy_budget_pressure));
  check("int-mc energy budget throttled slices field", typeof intMcSelectionReport.coverage?.energy_budget_throttled_slices === "number", formatValue(intMcSelectionReport.coverage?.energy_budget_throttled_slices));
  check("int-mc energy budget deferred links field", typeof intMcSelectionReport.coverage?.energy_budget_deferred_active_links === "number", formatValue(intMcSelectionReport.coverage?.energy_budget_deferred_active_links));
  check("int-mc shadow-aware field", typeof intMcSelectionReport.coverage?.shadow_node_hits === "number", formatValue(intMcSelectionReport.coverage?.shadow_node_hits));
  check("int-mc OAM feedback parameter", typeof intMcSelectionReport.parameters?.oam_feedback_weight === "number", formatValue(intMcSelectionReport.parameters?.oam_feedback_weight));
  check("int-mc OAM feedback coverage field", typeof intMcSelectionReport.coverage?.oam_feedback_selected_paths === "number", formatValue(intMcSelectionReport.coverage?.oam_feedback_selected_paths));
  check("int-mc OAM replan pressure parameter", typeof intMcSelectionReport.parameters?.oam_replan_pressure_threshold === "number", formatValue(intMcSelectionReport.parameters?.oam_replan_pressure_threshold));
  check("int-mc OAM replan pressure coverage field", typeof intMcSelectionReport.coverage?.mean_oam_replan_pressure === "number", formatValue(intMcSelectionReport.coverage?.mean_oam_replan_pressure));
  check("int-mc OAM replan trigger coverage field", typeof intMcSelectionReport.coverage?.oam_replan_triggered_slices === "number", formatValue(intMcSelectionReport.coverage?.oam_replan_triggered_slices));
  check("int-mc OAM control action parameter", typeof intMcSelectionReport.parameters?.oam_control_weight === "number", formatValue(intMcSelectionReport.parameters?.oam_control_weight));
  check("int-mc OAM control pressure parameter", typeof intMcSelectionReport.parameters?.oam_control_replan_pressure_threshold === "number", formatValue(intMcSelectionReport.parameters?.oam_control_replan_pressure_threshold));
  check("int-mc OAM control pressure coverage field", typeof intMcSelectionReport.coverage?.mean_oam_control_pressure === "number", formatValue(intMcSelectionReport.coverage?.mean_oam_control_pressure));
  check("int-mc OAM control selected paths field", typeof intMcSelectionReport.coverage?.oam_control_selected_paths === "number", formatValue(intMcSelectionReport.coverage?.oam_control_selected_paths));
  check("int-mc OAM control replan trigger field", typeof intMcSelectionReport.coverage?.oam_control_replan_triggered_slices === "number", formatValue(intMcSelectionReport.coverage?.oam_control_replan_triggered_slices));
  check("int-mc planning overhead model", intMcSelectionReport.method?.planning_overhead_model?.unit === "relative-normalized-planning-cost", formatValue(intMcSelectionReport.method?.planning_overhead_model?.unit));
  check("int-mc planning cache-hit field", typeof intMcSelectionReport.coverage?.planning_cache_hit_slices === "number", formatValue(intMcSelectionReport.coverage?.planning_cache_hit_slices));
  check("int-mc planning actual cost field", typeof intMcSelectionReport.coverage?.estimated_actual_planning_cost_units === "number", formatValue(intMcSelectionReport.coverage?.estimated_actual_planning_cost_units));
  check("int-mc planning saving ratio field", typeof intMcSelectionReport.coverage?.estimated_planning_cost_saving_ratio === "number", formatValue(intMcSelectionReport.coverage?.estimated_planning_cost_saving_ratio));
  check("int-mc sampling mask row field", typeof intMcSelectionReport.coverage?.sampling_mask_rows === "number", formatValue(intMcSelectionReport.coverage?.sampling_mask_rows));
  check("int-mc sampling mask density field", typeof intMcSelectionReport.coverage?.sampling_mask_density === "number", formatValue(intMcSelectionReport.coverage?.sampling_mask_density));
  check("int-mc evaluation schema", intMcEvaluation.schema_version === "stage2-leo-int-mc-evaluation-v1", formatValue(intMcEvaluation.schema_version));
  check("int-mc ground-side boundary", intMcEvaluation.boundary?.matrix_completion_runs_at_ground_oam === true, formatValue(intMcEvaluation.boundary?.matrix_completion_runs_at_ground_oam));
  check("int-mc topology down not completed", intMcEvaluation.boundary?.topology_down_not_completed === true, formatValue(intMcEvaluation.boundary?.topology_down_not_completed));
  check("int-mc temporal prior boundary", intMcEvaluation.boundary?.temporal_prior_uses_observed_neighbor_slices_only === true, formatValue(intMcEvaluation.boundary?.temporal_prior_uses_observed_neighbor_slices_only));
  check("int-mc tensor prior boundary", intMcEvaluation.boundary?.tensor_neighbor_prior_uses_same_slice_observed_neighbors_only === true, formatValue(intMcEvaluation.boundary?.tensor_neighbor_prior_uses_same_slice_observed_neighbors_only));
  check("int-mc context prior boundary", intMcEvaluation.boundary?.context_prior_uses_predictable_orbital_power_and_contact_context === true, formatValue(intMcEvaluation.boundary?.context_prior_uses_predictable_orbital_power_and_contact_context));
  check(
    "int-mc temporal prior summary",
    (intMcEvaluation.matrix_summaries ?? []).some((row) => Number(row.temporal_prior_values ?? 0) >= 0) &&
      (intMcEvaluation.node_matrix_summaries ?? []).some((row) => Number(row.temporal_prior_values ?? 0) >= 0),
    "link and node matrix summaries expose temporal_prior_values",
  );
  check(
    "int-mc tensor-neighbor prior summary",
    (intMcEvaluation.matrix_summaries ?? []).some((row) => Number(row.tensor_neighbor_prior_values ?? 0) >= 0) &&
      (intMcEvaluation.node_matrix_summaries ?? []).some((row) => Number(row.tensor_neighbor_prior_values ?? 0) >= 0),
    "link and node matrix summaries expose tensor_neighbor_prior_values",
  );
  check(
    "int-mc same-slice prior summary",
    (intMcEvaluation.matrix_summaries ?? []).some((row) => Number(row.same_slice_spatial_prior_groups ?? 0) >= 0) &&
      (intMcEvaluation.node_matrix_summaries ?? []).some((row) => Number(row.same_slice_spatial_prior_groups ?? 0) >= 0),
    "link and node matrix summaries expose same_slice_spatial_prior_groups",
  );
  check("int-mc context prior tag summary", intMcEvaluation.context_prior_summary?.link_context_tags_enabled === true && intMcEvaluation.context_prior_summary?.node_context_tags_enabled === true, formatValue(intMcEvaluation.context_prior_summary?.link_context_tags_enabled));
  check("int-mc context prior risk summary", typeof intMcEvaluation.context_prior_summary?.mean_link_context_prior_risk === "number" && typeof intMcEvaluation.context_prior_summary?.mean_node_context_prior_risk === "number", formatValue(intMcEvaluation.context_prior_summary?.mean_link_context_prior_risk));
  check("predicted contact plan schema", predictedContactPlan.schema_version === "stage2-predicted-contact-plan-v1", formatValue(predictedContactPlan.schema_version));
  check("predicted contact plan no business load state", predictedContactPlan.prediction_model?.uses_business_load_state === false, formatValue(predictedContactPlan.prediction_model?.uses_business_load_state));
  check("predicted contact plan no runtime truth state", predictedContactPlan.prediction_model?.uses_truth_for_runtime_state === false, formatValue(predictedContactPlan.prediction_model?.uses_truth_for_runtime_state));
  check("predicted contact plan entries", (predictedContactPlan.entries?.length ?? 0) === manifest.stage1?.counts?.links, `actual=${formatValue(predictedContactPlan.entries?.length)}, expected=${formatValue(manifest.stage1?.counts?.links)}`);
  check("predicted topology forecast summary", typeof predictedContactPlan.topology_forecast?.mean_drift_pressure === "number", formatValue(predictedContactPlan.topology_forecast?.mean_drift_pressure));
  check("predicted topology forecast per-slice fields", Array.isArray(predictedContactPlan.per_slice) && predictedContactPlan.per_slice.every((row) => row.topology_forecast_drift_pressure !== undefined), "every predicted slice has topology forecast pressure");
  check("predicted contact plan pipeline completed", manifest.int_pipeline?.contact_plan_prediction?.ok === true, formatValue(manifest.int_pipeline?.contact_plan_prediction?.ok));
  check("predicted contact precision", nearlyAtLeast(predictedContactPlan.evaluation?.precision, 0.95), formatValue(predictedContactPlan.evaluation?.precision));
  check("predicted contact recall", nearlyAtLeast(predictedContactPlan.evaluation?.recall, 0.95), formatValue(predictedContactPlan.evaluation?.recall));
  check("int-mc uses predicted contact mask", intMcEvaluation.boundary?.active_mask_from_predicted_contact_plan === true, formatValue(intMcEvaluation.boundary?.active_mask_from_predicted_contact_plan));
  check("int-mc active completion coverage", nearlyAtLeast(manifest.accuracy?.int_mc?.active_link_completion_coverage, 1), formatValue(manifest.accuracy?.int_mc?.active_link_completion_coverage));
  check("int-mc unknown link samples", manifest.accuracy?.int_mc?.unknown_link_samples === 0, formatValue(manifest.accuracy?.int_mc?.unknown_link_samples));
  check("int-mc has inferred links", (manifest.accuracy?.int_mc?.inferred_link_samples ?? 0) > 0, formatValue(manifest.accuracy?.int_mc?.inferred_link_samples));
  check("int-mc queued traffic metric", Boolean(intMcEvaluation.metrics?.queued_traffic_mb), formatValue(Boolean(intMcEvaluation.metrics?.queued_traffic_mb)));
  check("int-mc dropped traffic metric", Boolean(intMcEvaluation.metrics?.dropped_traffic_mb), formatValue(Boolean(intMcEvaluation.metrics?.dropped_traffic_mb)));
  check("int-mc packet error metric", Boolean(intMcEvaluation.metrics?.packet_error_rate), formatValue(Boolean(intMcEvaluation.metrics?.packet_error_rate)));
  check("int-mc accuracy report mode", accuracyReport.conclusion?.primary_mode === "leo-int-mc", formatValue(accuracyReport.conclusion?.primary_mode));
  check("probe OAM has prior link estimates", (manifest.accuracy?.probe_int?.oam_prior_link_estimates ?? 0) > 0, formatValue(manifest.accuracy?.probe_int?.oam_prior_link_estimates));
} else {
  check("accuracy report coverage audit pass", accuracyReport.primary_probe_int?.coverage_audit_summary?.pass === true, formatValue(accuracyReport.primary_probe_int?.coverage_audit_summary?.pass));
  check("probe node coverage threshold", nearlyAtLeast(manifest.accuracy?.probe_int?.node_sample_coverage, minProbeNodeCoverage), formatValue(manifest.accuracy?.probe_int?.node_sample_coverage));
  check("probe link coverage threshold", nearlyAtLeast(manifest.accuracy?.probe_int?.link_sample_coverage, minProbeLinkCoverage), formatValue(manifest.accuracy?.probe_int?.link_sample_coverage));
  check("probe active link coverage", nearlyAtLeast(manifest.accuracy?.probe_int?.active_link_sample_coverage, 1), formatValue(manifest.accuracy?.probe_int?.active_link_sample_coverage));
  check("probe mode accuracy", nearlyAtLeast(manifest.accuracy?.probe_int?.mode_accuracy, 1), formatValue(manifest.accuracy?.probe_int?.mode_accuracy));
  check("probe link status accuracy", nearlyAtLeast(manifest.accuracy?.probe_int?.link_status_accuracy, 1), formatValue(manifest.accuracy?.probe_int?.link_status_accuracy));
}

if (requireNoUnknownProbe && !isIntMcRun) {
  check("probe unknown node samples", manifest.accuracy?.probe_int?.unknown_node_samples === 0, formatValue(manifest.accuracy?.probe_int?.unknown_node_samples));
  check("probe unknown link samples", manifest.accuracy?.probe_int?.unknown_link_samples === 0, formatValue(manifest.accuracy?.probe_int?.unknown_link_samples));
}

if (requireProbeFull && !isIntMcRun) {
  check("probe full time-step pass", manifest.accuracy?.probe_int?.full_time_step_pass === true, formatValue(manifest.accuracy?.probe_int?.full_time_step_pass));
  check("coverage audit pass", coverageAudit.summary?.pass === true, formatValue(coverageAudit.summary?.pass));
  check("coverage audit passed slices", coverageAudit.summary?.passed_slices === manifest.stage1?.counts?.metrics, `passed=${formatValue(coverageAudit.summary?.passed_slices)}, slices=${formatValue(manifest.stage1?.counts?.metrics)}`);
  const failedSlices = Array.isArray(coverageAudit.slices) ? coverageAudit.slices.filter((slice) => !slice.pass) : [];
  check("coverage audit failed slice count", failedSlices.length === 0, `${failedSlices.length} failed slices`);
}

check("traffic INT remains partial or equal", (manifest.accuracy?.traffic_int?.node_sample_coverage ?? 0) <= 1, formatValue(manifest.accuracy?.traffic_int?.node_sample_coverage));
check("experiment report includes accuracy section", existsSync(requiredFiles.report) && (await readFile(requiredFiles.report, "utf8")).includes("准确率与覆盖率"), requiredFiles.report);

const passed = checks.filter((item) => item.passed).length;
const failed = checks.length - passed;
const report = {
  schema_version: "stage2-int-experiment-verification-v1",
  generated_at: new Date().toISOString(),
  run_dir: runDir,
  manifest_path: manifestPath,
  thresholds: {
    min_probe_node_coverage: minProbeNodeCoverage,
    min_probe_link_coverage: minProbeLinkCoverage,
    require_probe_full: requireProbeFull,
    require_no_unknown_probe: requireNoUnknownProbe,
  },
  summary: {
    pass: failed === 0,
    checks: checks.length,
    passed,
    failed,
    config_fingerprint: manifest.stage1?.fingerprints?.config ?? "",
    dataset_fingerprint: manifest.stage1?.fingerprints?.dataset ?? "",
    truth_fingerprint: manifest.stage1?.fingerprints?.truth ?? "",
    traffic_node_coverage: manifest.accuracy?.traffic_int?.node_sample_coverage ?? null,
    traffic_link_coverage: manifest.accuracy?.traffic_int?.link_sample_coverage ?? null,
    probe_node_coverage: manifest.accuracy?.probe_int?.node_sample_coverage ?? null,
    probe_link_coverage: manifest.accuracy?.probe_int?.link_sample_coverage ?? null,
    probe_full_time_step_pass: manifest.accuracy?.probe_int?.full_time_step_pass ?? null,
    int_mc_active_link_completion_coverage: manifest.accuracy?.int_mc?.active_link_completion_coverage ?? null,
    int_mc_inferred_rate_on_active: manifest.accuracy?.int_mc?.inferred_rate_on_active ?? null,
  },
  checks,
};

if (writeReport) {
  const outputJson = join(runDir, "int-experiment-verification.json");
  const outputMd = join(runDir, "int-experiment-verification.md");
  const fileIndexJson = join(runDir, "int-experiment-file-index.json");
  const fileIndexMd = join(runDir, "int-experiment-file-index.md");
  await mkdir(runDir, { recursive: true });
  await writeFile(outputJson, JSON.stringify(report, null, 2), "utf8");
  await writeFile(
    outputMd,
    [
      "# INT 实验验收报告",
      "",
      `- 结论：${report.summary.pass ? "通过" : "未通过"}`,
      `- 检查项：${passed}/${checks.length}`,
      `- 配置指纹：${formatValue(report.summary.config_fingerprint)}`,
      `- 数据集指纹：${formatValue(report.summary.dataset_fingerprint)}`,
      `- 真值指纹：${formatValue(report.summary.truth_fingerprint)}`,
      `- probe-int 节点/链路覆盖：${formatValue(report.summary.probe_node_coverage)} / ${formatValue(report.summary.probe_link_coverage)}`,
      `- 全网逐时间片：${formatValue(report.summary.probe_full_time_step_pass)}`,
      "",
      markdownTable(checks),
      "",
    ].join("\n"),
    "utf8",
  );

  const indexCandidates = new Map();
  const addIndexCandidate = (role, path) => {
    if (!path || !existsSync(path)) return;
    indexCandidates.set(resolve(path), role);
  };
  Object.entries(requiredFiles).forEach(([role, path]) => addIndexCandidate(role, path));
  if (manifest.input?.tasks_snapshot_path) addIndexCandidate("taskDatasetSnapshot", String(manifest.input.tasks_snapshot_path));
  addIndexCandidate("verificationJson", outputJson);
  addIndexCandidate("verificationMarkdown", outputMd);

  const fileRows = [];
  for (const [path, role] of [...indexCandidates.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const stats = statSync(path);
    fileRows.push({
      role,
      path,
      relative_path: path.startsWith(runDir) ? path.slice(runDir.length + 1) : path,
      size_bytes: stats.size,
      sha256: await sha256File(path),
    });
  }

  const fileIndex = {
    schema_version: "stage2-int-experiment-file-index-v1",
    generated_at: new Date().toISOString(),
    run_dir: runDir,
    manifest_path: manifestPath,
    hash_algorithm: "sha256",
    file_count: fileRows.length,
    files: fileRows,
  };
  await writeFile(fileIndexJson, JSON.stringify(fileIndex, null, 2), "utf8");
  await writeFile(
    fileIndexMd,
    [
      "# INT 实验文件完整性索引",
      "",
      `- 文件数：${fileRows.length}`,
      "- 哈希算法：SHA-256",
      "",
      fileIndexMarkdown(fileRows),
      "",
    ].join("\n"),
    "utf8",
  );

  report.outputs = {
    verification_json: outputJson,
    verification_md: outputMd,
    file_index_json: fileIndexJson,
    file_index_md: fileIndexMd,
  };
}

console.log(JSON.stringify(report, null, 2));
if (!report.summary.pass) process.exit(1);
