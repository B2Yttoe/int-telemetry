import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  PROFILE_CATALOG,
  canonicalProbePlanHash,
  runIntMcPass,
  runTwoPassVariant,
  sha256File,
} from "./experiments/intMcExperimentCore.mjs";
import { parseCsv, rowsToCsv } from "./experiments/reportUtils.mjs";

const SOURCE_ROOT = resolve("reports/experiment2-native-baseline-rerun-final");
const DEFAULT_OUTPUT = resolve("reports/_scratch/importance-aware-telemetry-pilot");
const DEFAULT_SLICES = Object.freeze({
  "iridium-next-small": 8,
  "telesat-1015-medium": 12,
});

const ENHANCED_MECHANISMS = Object.freeze({
  adaptiveReuse: true,
  incrementalTopologyRepair: true,
  forecastRiskScoring: true,
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
});

export const PILOT_VARIANTS = Object.freeze([
  Object.freeze({
    id: "enhanced-current",
    label: "当前增强方案（全量目标字段）",
    mechanisms: Object.freeze({ ...ENHANCED_MECHANISMS }),
  }),
  Object.freeze({
    id: "importance-mask-only",
    label: "重要性感知选择性写入",
    mechanisms: Object.freeze({
      ...ENHANCED_MECHANISMS,
      importanceAwareTargets: true,
      importanceMetadataOnly: true,
      importanceSelectiveMetadata: true,
      importancePathScoring: false,
      importanceBudgetNeutralReplacement: true,
      importanceStrictForwardOnly: true,
      importancePlaneRepresentativeRatio: 0,
      importanceSelectiveTelemetryVersion: "budget-neutral-direct-coverage-core-v7",
    }),
  }),
  Object.freeze({
    id: "importance-path-full-metadata",
    label: "重要性路径评分（全量字段）",
    mechanisms: Object.freeze({
      ...ENHANCED_MECHANISMS,
      oamTargetAwareMetadata: false,
      importanceAwareTargets: true,
      importanceMetadataOnly: false,
      importanceSelectiveMetadata: false,
      importancePathScoring: true,
      importanceBudgetNeutralReplacement: true,
      importanceStrictForwardOnly: true,
      importancePlaneRepresentativeRatio: 0,
      importanceSelectiveTelemetryVersion: "budget-neutral-direct-coverage-core-v7",
    }),
  }),
  Object.freeze({
    id: "importance-path-selective",
    label: "重要性路径评分 + 选择性写入",
    mechanisms: Object.freeze({
      ...ENHANCED_MECHANISMS,
      importanceAwareTargets: true,
      importanceMetadataOnly: false,
      importanceSelectiveMetadata: true,
      importancePathScoring: true,
      importanceBudgetNeutralReplacement: true,
      importanceStrictForwardOnly: true,
      importancePlaneRepresentativeRatio: 0,
      importanceSelectiveTelemetryVersion: "budget-neutral-direct-coverage-core-v7",
    }),
  }),
]);

function argValue(args, name, fallback = "") {
  const index = args.indexOf(name);
  return index === -1 ? fallback : (args[index + 1] ?? fallback);
}

function boolValue(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function numberValue(value, fallback = 0) {
  if (value === "" || value === null || value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value, digits = 6) {
  return Number(numberValue(value).toFixed(digits));
}

function mean(values) {
  const finite = values.filter(Number.isFinite);
  return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : 0;
}

export function maxNumberOrZero(values) {
  let maximum = 0;
  for (const value of values) {
    if (Number.isFinite(value) && value > maximum) maximum = value;
  }
  return maximum;
}

function percentile(values, quantile) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(quantile * sorted.length) - 1));
  return sorted[index];
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readCsv(path) {
  return parseCsv(await readFile(path, "utf8"));
}

export function resolvePilotProfile(profileId, customProfiles = []) {
  const profile = PROFILE_CATALOG.find((item) => item.id === profileId) ??
    customProfiles.find((item) => item.id === profileId);
  if (!profile) throw new Error(`Unknown profile: ${profileId}`);
  return profile;
}

function filterRowsBySlice(rows, sliceCount) {
  if (!rows.length || !("slice_index" in rows[0])) return rows;
  return rows.filter((row) => numberValue(row.slice_index, Number.POSITIVE_INFINITY) < sliceCount);
}

async function prepareFixture({ profile, sliceCount, outputDir }) {
  const sourceTruthDir = profile.source_truth_dir
    ? resolve(profile.source_truth_dir)
    : join(SOURCE_ROOT, profile.id, "stage1-truth");
  const sourceCandidatePath = profile.source_candidate_paths
    ? resolve(profile.source_candidate_paths)
    : join(
        SOURCE_ROOT,
        profile.id,
        "experiment2",
        "stage2",
        "full-probe-int",
        "probe-paths-path-balance.csv",
      );
  if (!existsSync(join(sourceTruthDir, "metadata.json")) || !existsSync(sourceCandidatePath)) {
    throw new Error(`Missing formal source artifacts for ${profile.id}`);
  }
  const fixtureDir = join(outputDir, profile.id, "fixture");
  await mkdir(fixtureDir, { recursive: true });
  const metadata = await readJson(join(sourceTruthDir, "metadata.json"));
  for (const entry of await readdir(sourceTruthDir, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name === "metadata.json") continue;
    const source = join(sourceTruthDir, entry.name);
    const destination = join(fixtureDir, entry.name);
    if (extname(entry.name).toLowerCase() !== ".csv") {
      await copyFile(source, destination);
      continue;
    }
    await writeFile(
      destination,
      rowsToCsv(filterRowsBySlice(await readCsv(source), sliceCount)),
      "utf8",
    );
  }
  const fixtureMetadata = {
    ...metadata,
    slice_count: sliceCount,
    truth_fingerprint: `${metadata.truth_fingerprint ?? "truth"}:importance-pilot-${sliceCount}`,
    importance_pilot_fixture: {
      source_truth_dir: sourceTruthDir,
      source_slice_count: numberValue(metadata.slice_count),
      retained_slice_count: sliceCount,
      truth_role: "post-run-evaluation-only",
    },
  };
  await writeJson(join(fixtureDir, "metadata.json"), fixtureMetadata);
  const candidatePath = join(fixtureDir, "candidate-paths.csv");
  await writeFile(
    candidatePath,
    rowsToCsv(filterRowsBySlice(await readCsv(sourceCandidatePath), sliceCount)),
    "utf8",
  );
  return { truthDir: fixtureDir, candidatePath, metadata: fixtureMetadata };
}

function keyForTarget(row) {
  return `${row.slice_index}|${row.target_id}`;
}

function meanAbsolute(rows, field) {
  return round(mean(rows.map((row) => Math.abs(numberValue(row[field], Number.NaN)))));
}

function classification(rows, truthField, estimateField, threshold) {
  const usable = rows.filter((row) => Number.isFinite(numberValue(row[truthField], Number.NaN)));
  const positives = usable.filter((row) => numberValue(row[truthField]) >= threshold);
  const predicted = usable.filter((row) => numberValue(row[estimateField]) >= threshold);
  const truePositive = positives.filter((row) => numberValue(row[estimateField]) >= threshold).length;
  const recall = positives.length ? truePositive / positives.length : 1;
  const precision = predicted.length ? truePositive / predicted.length : 1;
  return {
    support: positives.length,
    precision: round(precision),
    recall: round(recall),
    f1: round((2 * precision * recall) / Math.max(precision + recall, Number.EPSILON)),
  };
}

async function collectCriticalMetrics({ groundDir, targetRows }) {
  const [nodeErrors, linkErrors] = await Promise.all([
    readCsv(join(groundDir, "int-mc-node-errors.csv")),
    readCsv(join(groundDir, "int-mc-link-errors.csv")),
  ]);
  const nodeTargets = new Set(targetRows.filter((row) => row.target_type === "node").map(keyForTarget));
  const linkTargets = new Set(targetRows.filter((row) => row.target_type === "link").map(keyForTarget));
  const criticalNodes = nodeErrors.filter((row) => nodeTargets.has(`${row.slice_index}|${row.node_id}`));
  const criticalLinks = linkErrors.filter((row) => linkTargets.has(`${row.slice_index}|${row.link_id}`));
  return {
    critical_node_samples: criticalNodes.length,
    critical_link_samples: criticalLinks.length,
    critical_cpu_mae: meanAbsolute(criticalNodes, "cpu_error"),
    critical_queue_depth_mae: meanAbsolute(criticalNodes, "queue_depth_error"),
    critical_energy_percent_mae: meanAbsolute(criticalNodes, "energy_error"),
    critical_link_utilization_mae: meanAbsolute(criticalLinks, "utilization_error"),
    critical_cpu_anomaly: classification(criticalNodes, "truth_cpu_percent", "cpu_percent_estimate", 80),
    critical_link_utilization_anomaly: classification(
      criticalLinks,
      "truth_utilization_percent",
      "utilization_percent_estimate",
      70,
    ),
  };
}

async function collectAoI({ truthDir, groundDir, targetRows, maxAoI }) {
  const [nodes, links, truthLinks] = await Promise.all([
    readCsv(join(groundDir, "ground-reconstructed-nodes.csv")),
    readCsv(join(groundDir, "ground-reconstructed-links.csv")),
    readCsv(join(truthDir, "links.csv")),
  ]);
  const activeLinks = new Set(
    truthLinks
      .filter((row) => boolValue(row.is_active))
      .map((row) => `${row.slice_index}|${row.link_id}`),
  );
  const nodeTargets = new Set(targetRows.filter((row) => row.target_type === "node").map(keyForTarget));
  const linkTargets = new Set(targetRows.filter((row) => row.target_type === "link").map(keyForTarget));
  const usableLinks = links.filter((row) => activeLinks.has(`${row.slice_index}|${row.link_id}`));
  const age = (row) => row.state_age_slices === ""
    ? numberValue(row.slice_index) + 1
    : numberValue(row.state_age_slices);
  const allAges = [...nodes.map(age), ...usableLinks.map(age)];
  const targetAges = [
    ...nodes.filter((row) => nodeTargets.has(`${row.slice_index}|${row.node_id}`)).map(age),
    ...usableLinks.filter((row) => linkTargets.has(`${row.slice_index}|${row.link_id}`)).map(age),
  ];
  return {
    aoi_samples: allAges.length,
    aoi_p50_slices: round(percentile(allAges, 0.5)),
    aoi_p95_slices: round(percentile(allAges, 0.95)),
    aoi_max_slices: round(maxNumberOrZero(allAges)),
    aoi_overdue_ratio: round(allAges.filter((value) => value > maxAoI).length / Math.max(allAges.length, 1)),
    target_aoi_p95_slices: round(percentile(targetAges, 0.95)),
    target_aoi_max_slices: round(maxNumberOrZero(targetAges)),
  };
}

async function collectVariantEvidence({ run, truthDir, targetRows, maxAoI }) {
  const groundDir = dirname(run.after.artifacts.evaluation_json);
  const [report, evaluation, probeRows, critical, aoi] = await Promise.all([
    readJson(run.after.artifacts.run_report_json),
    readJson(run.after.artifacts.evaluation_json),
    readCsv(run.after.artifacts.probe_paths_csv),
    collectCriticalMetrics({ groundDir, targetRows }),
    collectAoI({ truthDir, groundDir, targetRows, maxAoI }),
  ]);
  const overhead = report.overhead ?? {};
  const evaluationMetrics = evaluation.metrics ?? {};
  const nodeMetrics = evaluation.node_reconstruction?.metrics ?? {};
  const anomalyRecalls = [
    numberValue(nodeMetrics.cpu_percent?.high_recall, Number.NaN),
    numberValue(evaluationMetrics.utilization_percent?.high_recall, Number.NaN),
    numberValue(evaluationMetrics.congestion_percent?.high_recall, Number.NaN),
  ].filter(Number.isFinite);
  return {
    ...run.after.metrics,
    probe_plan_hash: canonicalProbePlanHash(probeRows),
    planning_wall_time_ms: numberValue(run.after.timings?.path_selection?.wall_time_ms),
    total_metadata_bytes: numberValue(overhead.total_metadata_bytes),
    total_target_mask_bytes: numberValue(overhead.total_target_mask_bytes),
    total_report_bytes: numberValue(overhead.total_report_bytes),
    total_probe_packet_base_bytes: numberValue(overhead.total_probe_packet_base_bytes),
    metadata_writing_hops: numberValue(overhead.metadata_writing_hops),
    forward_only_hops: numberValue(overhead.forward_only_hops),
    processing_energy_j: numberValue(overhead.processing_energy_j),
    tx_energy_j: numberValue(overhead.tx_energy_j),
    cpu_anomaly_recall: numberValue(nodeMetrics.cpu_percent?.high_recall),
    cpu_anomaly_support: numberValue(nodeMetrics.cpu_percent?.high_actual_support),
    utilization_anomaly_recall: numberValue(evaluationMetrics.utilization_percent?.high_recall),
    utilization_anomaly_support: numberValue(evaluationMetrics.utilization_percent?.high_actual_support),
    utilization_anomaly_f1: numberValue(evaluationMetrics.utilization_percent?.high_f1),
    congestion_anomaly_recall: numberValue(evaluationMetrics.congestion_percent?.high_recall),
    congestion_anomaly_support: numberValue(evaluationMetrics.congestion_percent?.high_actual_support),
    congestion_anomaly_f1: numberValue(evaluationMetrics.congestion_percent?.high_f1),
    anomaly_macro_recall: round(mean(anomalyRecalls)),
    ...critical,
    ...aoi,
  };
}

function relativeRegression(baseline, candidate) {
  return (candidate - baseline) / Math.max(Math.abs(baseline), 1e-9);
}

export function evaluatePilotGate(baseline, candidate, options = {}) {
  const numericTolerance = numberValue(options.numericTolerance, 0.01);
  const accuracyTolerance = numberValue(options.accuracyTolerance, 0.005);
  const maxAoI = numberValue(options.maxAoI, 6);
  const numericFields = ["cpu_mae", "queue_depth_mae", "energy_percent_mae", "link_utilization_mae"];
  const accuracyFields = ["node_mode_accuracy", "link_status_accuracy"];
  const criticalFields = [
    "critical_cpu_mae",
    "critical_queue_depth_mae",
    "critical_energy_percent_mae",
    "critical_link_utilization_mae",
  ];
  const anomalyFields = ["cpu_anomaly_recall", "utilization_anomaly_recall", "congestion_anomaly_recall"];
  const anomalySupportFields = {
    cpu_anomaly_recall: "cpu_anomaly_support",
    utilization_anomaly_recall: "utilization_anomaly_support",
    congestion_anomaly_recall: "congestion_anomaly_support",
  };
  const supportedAnomalyFields = anomalyFields.filter((field) =>
    numberValue(baseline[anomalySupportFields[field]]) > 0
  );
  const numericRegressions = Object.fromEntries(
    numericFields.map((field) => [field, round(relativeRegression(numberValue(baseline[field]), numberValue(candidate[field])))]),
  );
  const accuracyLosses = Object.fromEntries(
    accuracyFields.map((field) => [field, round(numberValue(baseline[field]) - numberValue(candidate[field]))]),
  );
  const criticalRegressions = Object.fromEntries(
    criticalFields.map((field) => [field, round(relativeRegression(numberValue(baseline[field]), numberValue(candidate[field])))]),
  );
  const anomalyDeltas = Object.fromEntries(
    supportedAnomalyFields.map((field) => [field, round(numberValue(candidate[field]) - numberValue(baseline[field]))]),
  );
  const bytesReduced = numberValue(candidate.total_telemetry_generated_bytes) < numberValue(baseline.total_telemetry_generated_bytes);
  const globalNonInferior = Object.values(numericRegressions).every((value) => value <= numericTolerance);
  const categoricalNonInferior = Object.values(accuracyLosses).every((value) => value <= accuracyTolerance);
  const criticalNonInferior = Object.values(criticalRegressions).every((value) => value <= numericTolerance);
  const anomalyNonInferior = Object.values(anomalyDeltas).every((value) => value >= -accuracyTolerance);
  const aoiBounded = numberValue(candidate.aoi_max_slices) <= maxAoI;
  const criticalImproved = Object.values(criticalRegressions).some((value) => value < -0.001);
  const anomalyImproved = Object.values(anomalyDeltas).some((value) => value > 0.001);
  return {
    gate_passed: bytesReduced && globalNonInferior && categoricalNonInferior && criticalNonInferior && anomalyNonInferior && aoiBounded,
    primary_goal_achieved: bytesReduced && globalNonInferior && categoricalNonInferior && criticalImproved && anomalyImproved && aoiBounded,
    bytes_reduced: bytesReduced,
    byte_reduction_ratio: round(
      1 - numberValue(candidate.total_telemetry_generated_bytes) /
      Math.max(numberValue(baseline.total_telemetry_generated_bytes), 1),
    ),
    global_noninferior: globalNonInferior,
    categorical_noninferior: categoricalNonInferior,
    critical_noninferior: criticalNonInferior,
    critical_improved: criticalImproved,
    anomaly_noninferior: anomalyNonInferior,
    anomaly_improved: anomalyImproved,
    aoi_bounded: aoiBounded,
    numeric_regressions: numericRegressions,
    accuracy_losses: accuracyLosses,
    critical_regressions: criticalRegressions,
    anomaly_deltas: anomalyDeltas,
    anomaly_supported_metric_count: supportedAnomalyFields.length,
  };
}

function flattenRow({ profile, variant, evidence, gate, baselineHash, targetPlanHash }) {
  return {
    profile_id: profile.id,
    profile_label: profile.short_label,
    scale: profile.scale,
    variant_id: variant.id,
    variant_label: variant.label,
    slice_count: evidence.slice_count,
    target_plan_sha256: targetPlanHash,
    probe_plan_hash: evidence.probe_plan_hash,
    same_probe_plan_as_baseline: evidence.probe_plan_hash === baselineHash,
    total_telemetry_generated_bytes: evidence.total_telemetry_generated_bytes,
    telemetry_bytes_per_node_slice: evidence.telemetry_bytes_per_node_slice,
    total_metadata_bytes: evidence.total_metadata_bytes,
    total_target_mask_bytes: evidence.total_target_mask_bytes,
    total_report_bytes: evidence.total_report_bytes,
    total_probe_packet_base_bytes: evidence.total_probe_packet_base_bytes,
    total_telemetry_energy_j: evidence.total_telemetry_energy_j,
    processing_energy_j: evidence.processing_energy_j,
    tx_energy_j: evidence.tx_energy_j,
    planning_wall_time_ms: evidence.planning_wall_time_ms,
    selected_paths: evidence.selected_paths,
    metadata_writing_hops: evidence.metadata_writing_hops,
    forward_only_hops: evidence.forward_only_hops,
    cpu_mae: evidence.cpu_mae,
    queue_depth_mae: evidence.queue_depth_mae,
    energy_percent_mae: evidence.energy_percent_mae,
    link_utilization_mae: evidence.link_utilization_mae,
    node_mode_accuracy: evidence.node_mode_accuracy,
    link_status_accuracy: evidence.link_status_accuracy,
    critical_cpu_mae: evidence.critical_cpu_mae,
    critical_queue_depth_mae: evidence.critical_queue_depth_mae,
    critical_energy_percent_mae: evidence.critical_energy_percent_mae,
    critical_link_utilization_mae: evidence.critical_link_utilization_mae,
    cpu_anomaly_recall: evidence.cpu_anomaly_recall,
    cpu_anomaly_support: evidence.cpu_anomaly_support,
    utilization_anomaly_recall: evidence.utilization_anomaly_recall,
    utilization_anomaly_support: evidence.utilization_anomaly_support,
    congestion_anomaly_recall: evidence.congestion_anomaly_recall,
    congestion_anomaly_support: evidence.congestion_anomaly_support,
    anomaly_macro_recall: evidence.anomaly_macro_recall,
    aoi_p50_slices: evidence.aoi_p50_slices,
    aoi_p95_slices: evidence.aoi_p95_slices,
    aoi_max_slices: evidence.aoi_max_slices,
    aoi_overdue_ratio: evidence.aoi_overdue_ratio,
    target_aoi_p95_slices: evidence.target_aoi_p95_slices,
    target_aoi_max_slices: evidence.target_aoi_max_slices,
    gate_passed: gate?.gate_passed ?? true,
    primary_goal_achieved: gate?.primary_goal_achieved ?? false,
    byte_reduction_ratio: gate?.byte_reduction_ratio ?? 0,
    global_noninferior: gate?.global_noninferior ?? true,
    critical_noninferior: gate?.critical_noninferior ?? true,
    critical_improved: gate?.critical_improved ?? false,
    anomaly_noninferior: gate?.anomaly_noninferior ?? true,
    anomaly_improved: gate?.anomaly_improved ?? false,
    aoi_bounded: gate?.aoi_bounded ?? (evidence.aoi_max_slices <= 6),
    observability_mode: evidence.observability_mode,
    feedback_lag_slices: evidence.feedback_lag_slices,
    causal_feedback_violations: evidence.causal_feedback_violations,
    truth_metrics_used_only_for_evaluation: evidence.truth_metrics_used_only_for_evaluation,
  };
}

function buildMarkdown(results) {
  const lines = [
    "# 重要性感知选择性遥测短试验",
    "",
    "本试验在同一第一阶段真值、同一滞后 Ground OAM 输入和同一采样预算下，仅切换重要目标、路径评分和逐跳 metadata 写入策略。第一阶段真值只在运行结束后用于误差评估。",
    "",
    "| 星座 | 方案 | 字节/节点/片 | 字节下降 | CPU MAE | 队列 MAE | 电量 MAE | 链路利用率 MAE | 关键 CPU MAE | 异常宏召回 | 最大 AoI | 门禁 | 主目标 |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|",
  ];
  for (const row of results.summary_rows) {
    lines.push(`| ${row.profile_label} | ${row.variant_label} | ${round(row.telemetry_bytes_per_node_slice, 3)} | ${(100 * numberValue(row.byte_reduction_ratio)).toFixed(2)}% | ${round(row.cpu_mae, 3)} | ${round(row.queue_depth_mae, 3)} | ${round(row.energy_percent_mae, 3)} | ${round(row.link_utilization_mae, 3)} | ${round(row.critical_cpu_mae, 3)} | ${round(row.anomaly_macro_recall, 3)} | ${round(row.aoi_max_slices, 1)} | ${row.gate_passed ? "通过" : "未通过"} | ${row.primary_goal_achieved ? "达到" : "未达到"} |`);
  }
  lines.push(
    "",
    "## 判定口径",
    "",
    "- 实际遥测总字节必须下降，目标 mask、报告、探测包基础头均计入。",
    "- CPU、队列、电量和链路利用率 MAE 相对退化不超过 1%。",
    "- 节点模式与链路状态准确率下降不超过 0.5 个百分点。",
    "- 关键目标误差和异常召回至少不退化；只有二者均出现严格改善时，才标记主目标达到。",
    `- 全网最大 AoI 上限为 ${results.parameters.max_aoi_slices} 个时间片。`,
    "",
    "## 结论边界",
    "",
    results.primary_goal_achieved
      ? "至少一个候选在本次短试验中同时实现字节下降、关键误差下降、异常召回提高和 AoI 受控。仍需 48 时间片与多种子正式实验确认泛化。"
      : "短试验尚未完整证明主目标。通过基础门禁的方案只能证明低开销且全局质量不退化；关键误差或异常召回未严格改善的部分不得写成已证明结论。",
  );
  return `${lines.join("\n")}\n`;
}

async function loadOrRunSharedPass1({ profile, fixture, profileDir, parameters, resume }) {
  const manifestPath = join(profileDir, "shared-pass1.json");
  if (resume && existsSync(manifestPath)) {
    const manifest = await readJson(manifestPath);
    const required = manifest.run?.artifacts?.selector_report_json;
    if (manifest.status === "complete" && required && existsSync(required)) return manifest;
  }
  const stage2Dir = join(profileDir, "shared-pass1", "stage2");
  const groundDir = join(profileDir, "shared-pass1", "ground-oam");
  const run = await runIntMcPass({
    label: `${profile.short_label} shared pass1`,
    truthDir: fixture.truthDir,
    candidatePathsPath: fixture.candidatePath,
    stage2Dir,
    groundDir,
    ...parameters,
    mechanisms: { adaptiveReuse: true },
  });
  const manifest = {
    status: "complete",
    run,
    stage2Dir,
    groundDir,
    fingerprint: await sha256File(run.artifacts.selector_report_json),
  };
  await writeJson(manifestPath, manifest);
  return manifest;
}

export async function runImportanceAwareTelemetryPilot(options = {}) {
  const outputDir = resolve(options.outputDir ?? DEFAULT_OUTPUT);
  const profileIds = options.profileIds ?? ["iridium-next-small", "telesat-1015-medium"];
  const variantIds = options.variantIds ?? PILOT_VARIANTS.map((variant) => variant.id);
  const activeVariants = PILOT_VARIANTS.filter((variant) => variantIds.includes(variant.id));
  if (!activeVariants.some((variant) => variant.id === "enhanced-current")) {
    throw new Error("Pilot variants must include enhanced-current as the comparison baseline");
  }
  const resume = options.resume !== false;
  const selfFeedback = options.selfFeedback !== false;
  const customProfiles = options.customProfiles ?? [];
  const maxAoI = numberValue(options.maxAoI, 6);
  await mkdir(outputDir, { recursive: true });
  const profileResults = [];
  const summaryRows = [];

  for (const profileId of profileIds) {
    const profile = resolvePilotProfile(profileId, customProfiles);
    const sliceCount = numberValue(options.sliceCount, DEFAULT_SLICES[profile.id] ?? profile.slice_count ?? 8);
    const profileDir = join(outputDir, profile.id);
    const fixture = await prepareFixture({ profile, sliceCount, outputDir });
    const parameters = {
      samplingRate: 0.25,
      targetActiveLinkSamplingRate: 0.25,
      rank: 5,
      windowSize: Math.min(12, sliceCount),
      warmupSlices: Math.min(6, Math.max(2, Math.floor(sliceCount / 2))),
      iterations: 12,
      maxPathsPerSlice: 12,
      observabilityMode: "oam-only",
      feedbackLagSlices: 1,
    };
    const sharedPass1 = selfFeedback
      ? null
      : await loadOrRunSharedPass1({
          profile,
          fixture,
          profileDir,
          parameters,
          resume,
        }).then((sharedManifest) => ({
          run: sharedManifest.run,
          stage2Dir: sharedManifest.stage2Dir,
          groundDir: sharedManifest.groundDir,
          fingerprint: sharedManifest.fingerprint,
        }));
    const runs = [];
    for (const variant of activeVariants) {
      const variantDir = join(profileDir, variant.id);
      const run = await runTwoPassVariant({
        profile,
        variant,
        truthDir: fixture.truthDir,
        candidatePathsPath: fixture.candidatePath,
        outputDir: variantDir,
        parameters,
        resume,
        sharedPass1,
        selfFeedbackPass1: selfFeedback,
      });
      runs.push({ variant, run });
      global.gc?.();
    }

    const targetRun = runs.find((item) => item.variant.id === "importance-mask-only") ??
      runs.find((item) => item.variant.mechanisms.importanceAwareTargets);
    if (!targetRun || !existsSync(targetRun.run.after.artifacts.importance_target_plan_csv)) {
      throw new Error(`Importance target plan missing for ${profile.id}`);
    }
    const targetRows = await readCsv(targetRun.run.after.artifacts.importance_target_plan_csv);
    const targetPlanHash = await sha256File(targetRun.run.after.artifacts.importance_target_plan_csv);
    const evidence = [];
    for (const item of runs) {
      evidence.push({
        ...item,
        evidence: await collectVariantEvidence({
          run: item.run,
          truthDir: fixture.truthDir,
          targetRows,
          maxAoI,
        }),
      });
    }
    const baseline = evidence.find((item) => item.variant.id === "enhanced-current").evidence;
    for (const item of evidence) {
      const gate = item.variant.id === "enhanced-current"
        ? null
        : evaluatePilotGate(baseline, item.evidence, { maxAoI });
      summaryRows.push(flattenRow({
        profile,
        variant: item.variant,
        evidence: item.evidence,
        gate,
        baselineHash: baseline.probe_plan_hash,
        targetPlanHash,
      }));
    }
    profileResults.push({
      profile,
      slice_count: sliceCount,
      target_plan_sha256: targetPlanHash,
      target_count: targetRows.length,
      fixture_truth_fingerprint: fixture.metadata.truth_fingerprint,
    });
  }

  const candidates = summaryRows.filter((row) => row.variant_id !== "enhanced-current");
  const results = {
    schema_version: "importance-aware-telemetry-pilot-v1",
    generated_at: new Date().toISOString(),
    status: "complete",
    scope: {
      truth_role: "post-run-evaluation-only",
      planner_runtime_inputs: ["lagged-ground-oam", "known-routes", "predicted-contact-state"],
      hidden_stage1_metrics_used_by_planner: false,
      feedback_source: selfFeedback ? "variant-self-oam" : "shared-pass1-oam",
      short_pilot_is_formal_multiseed_evidence: false,
    },
    parameters: {
      profile_ids: profileIds,
      max_aoi_slices: maxAoI,
      numeric_mae_regression_limit: 0.01,
      categorical_accuracy_loss_limit: 0.005,
    feedback_lag_slices: 1,
      self_feedback: selfFeedback,
    },
    profiles: profileResults,
    variants: activeVariants,
    summary_rows: summaryRows,
    gate_passed: candidates.some((row) => row.gate_passed),
    primary_goal_achieved: candidates.some((row) => row.primary_goal_achieved),
  };
  await Promise.all([
    writeJson(join(outputDir, "importance-aware-pilot-summary.json"), results),
    writeFile(join(outputDir, "importance-aware-pilot-summary.csv"), rowsToCsv(summaryRows), "utf8"),
    writeFile(join(outputDir, "importance-aware-pilot-summary.md"), buildMarkdown(results), "utf8"),
  ]);
  return results;
}

const invokedDirectly = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  const args = process.argv.slice(2);
  const profileIds = argValue(args, "--profiles", "iridium-next-small,telesat-1015-medium")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const variantIds = argValue(args, "--variants", PILOT_VARIANTS.map((variant) => variant.id).join(","))
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const sliceText = argValue(args, "--slices", "");
  const results = await runImportanceAwareTelemetryPilot({
    outputDir: argValue(args, "--out", DEFAULT_OUTPUT),
    profileIds,
    variantIds,
    sliceCount: sliceText ? numberValue(sliceText) : undefined,
    maxAoI: numberValue(argValue(args, "--max-aoi", "6"), 6),
    resume: boolValue(argValue(args, "--resume", "true"), true),
    selfFeedback: boolValue(argValue(args, "--self-feedback", "true"), true),
  });
  console.log(JSON.stringify({
    status: results.status,
    output_dir: resolve(argValue(args, "--out", DEFAULT_OUTPUT)),
    gate_passed: results.gate_passed,
    primary_goal_achieved: results.primary_goal_achieved,
  }, null, 2));
}
