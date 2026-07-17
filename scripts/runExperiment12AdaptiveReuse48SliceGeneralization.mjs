import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectIntMcMetrics,
  runIntMcPass,
  sha256File,
} from "./experiments/intMcExperimentCore.mjs";
import {
  EXPERIMENT12_PROFILE_BUDGETS,
  buildExperiment12Variants,
} from "./experiments/topologyVersionedCausalExperiment.mjs";
import { planningWorkUnits } from "./experiments/topologyReuseDirectedValidation.mjs";
import { buildTopologyReuseEvidenceMatrix } from "./experiments/topologyReuseStatisticalEvidence.mjs";
import { naturalArtifacts } from "./runExperiment12DirectedReuseValidation.mjs";
import { escapeHtml, parseCsv, rowsToCsv } from "./experiments/reportUtils.mjs";

const DEFAULT_NATURAL_ROOT = resolve("reports/experiment12-topology-reuse-statistical-evidence");
const DEFAULT_OUTPUT_DIR = resolve("reports/experiment12-adaptive-reuse-48slice-generalization");
const PROFILE_ID = "telesat-1015-medium";
const SLICE_COUNT = 48;
const ERROR_TOLERANCE = 0.02;
const ACCURACY_DROP_TOLERANCE = 0.005;
const OVERHEAD_INCREASE_TOLERANCE = 0.01;
const IMPLEMENTATION_VERSION = "adaptive-structural-reuse-48slice-generalization-v1";

function argValue(args, name, fallback = "") {
  const index = args.indexOf(name);
  return index === -1 ? fallback : (args[index + 1] ?? fallback);
}

function boolValue(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function numberValue(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value, digits = 6) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Number(numeric.toFixed(digits)) : 0;
}

function sum(rows, field) {
  return rows.reduce((total, row) => total + numberValue(row[field]), 0);
}

function mean(values) {
  const finite = values.map(Number).filter(Number.isFinite);
  return finite.length ? finite.reduce((total, value) => total + value, 0) / finite.length : 0;
}

function percentageReduction(candidate, baseline) {
  const base = numberValue(baseline);
  return round((base - numberValue(candidate)) / Math.max(Math.abs(base), 1e-12) * 100);
}

function percentageChange(candidate, baseline) {
  const base = numberValue(baseline);
  return round((numberValue(candidate) - base) / Math.max(Math.abs(base), 1e-12) * 100);
}

async function readCsv(path) {
  return parseCsv(await readFile(path, "utf8"));
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function scenarioRunPaths(artifacts, scenario) {
  const runRoot = join(
    artifacts.root,
    "experiment12",
    "runs",
    scenario.profile_id,
    scenario.stress_id,
  );
  return {
    fixed_stage2_dir: join(runRoot, "full-unified", "stage2", "full-unified"),
    fixed_ground_dir: join(runRoot, "full-unified", "ground-oam", "full-unified"),
    fresh_stage2_dir: join(runRoot, "no-topology-version", "stage2", "no-topology-version"),
    fresh_ground_dir: join(runRoot, "no-topology-version", "ground-oam", "no-topology-version"),
    pass1_oam_links: join(artifacts.pass1_ground_dir, "ground-mc-reconstructed-links.csv"),
    pass1_oam_nodes: join(artifacts.pass1_ground_dir, "ground-mc-reconstructed-nodes.csv"),
    pass1_control_actions: join(artifacts.pass1_ground_dir, "ground-oam-control-actions.csv"),
  };
}

function requiredInputs(artifacts, paths) {
  return [
    join(artifacts.truth_dir, "metadata.json"),
    join(artifacts.truth_dir, "links.csv"),
    join(artifacts.truth_dir, "nodes.csv"),
    artifacts.candidate_paths_csv,
    artifacts.combined_feedback_csv,
    artifacts.full_summary_csv,
    paths.pass1_oam_links,
    paths.pass1_oam_nodes,
    paths.pass1_control_actions,
    join(paths.fixed_stage2_dir, "probe-coverage-int-mc.json"),
    join(paths.fixed_ground_dir, "int-mc-evaluation.json"),
    join(paths.fresh_stage2_dir, "probe-coverage-int-mc.json"),
    join(paths.fresh_ground_dir, "int-mc-evaluation.json"),
  ];
}

function aggregatePlanning(summaryRows) {
  const modes = { reuse: 0, repair: 0, fresh: 0, other: 0 };
  const rejectionReasons = new Map();
  for (const row of summaryRows) {
    const mode = String(row.unified_planner_selected_mode ?? "").trim();
    if (mode in modes) modes[mode] += 1;
    else modes.other += 1;
    String(row.unified_structural_cache_rejection_reasons ?? "")
      .split(/\s*>\s*|\s*;\s*/)
      .map((item) => item.trim())
      .filter(Boolean)
      .forEach((reason) => rejectionReasons.set(reason, (rejectionReasons.get(reason) ?? 0) + 1));
  }
  const thresholds = summaryRows
    .map((row) => String(row.unified_structural_cache_effective_similarity_threshold ?? "").trim())
    .filter(Boolean)
    .map(Number)
    .filter(Number.isFinite);
  const relaxation = summaryRows
    .map((row) => String(row.unified_structural_cache_relaxation_factor ?? "").trim())
    .filter(Boolean)
    .map(Number)
    .filter(Number.isFinite);
  const work = {
    candidate_inspections: sum(summaryRows, "planning_candidate_paths"),
    shortest_path_calls: 0,
    score_recomputations: sum(summaryRows, "unified_planner_score_cache_recomputations"),
    marginal_evaluations: sum(summaryRows, "unified_planner_marginal_evaluations"),
    local_repairs:
      sum(summaryRows, "selected_repaired_paths") +
      sum(summaryRows, "unified_repair_refill_paths"),
    graph_reconstructions: summaryRows.length,
  };
  return {
    slice_count: summaryRows.length,
    modes,
    trigger_slices: modes.reuse + modes.repair,
    trigger_rate: round((modes.reuse + modes.repair) / Math.max(summaryRows.length, 1)),
    structural_eligible_slices: summaryRows.filter((row) => boolValue(row.unified_structural_cache_eligible)).length,
    structural_adaptive_slices: summaryRows.filter((row) => boolValue(row.unified_structural_cache_adaptive_enabled)).length,
    ...work,
    weighted_planning_work_units: planningWorkUnits(work),
    stable_path_cache_hits: sum(summaryRows, "unified_stable_path_cache_hits"),
    score_cache_hits: sum(summaryRows, "unified_planner_score_cache_hits"),
    hard_budget_violations: sum(summaryRows, "unified_planner_budget_violations"),
    structural_source_causal_violations: summaryRows.filter((row) => {
      const source = String(row.unified_structural_cache_source_slice ?? "").trim();
      return source !== "" && numberValue(source, Number.POSITIVE_INFINITY) >=
        numberValue(row.slice_index, Number.NEGATIVE_INFINITY);
    }).length,
    estimated_telemetry_bytes: sum(summaryRows, "estimated_total_telemetry_bytes"),
    mean_effective_similarity_threshold: round(mean(thresholds)),
    minimum_effective_similarity_threshold: thresholds.length ? round(Math.min(...thresholds)) : 0,
    maximum_effective_similarity_threshold: thresholds.length ? round(Math.max(...thresholds)) : 0,
    mean_relaxation_factor: round(mean(relaxation)),
    rejection_reasons: Object.fromEntries([...rejectionReasons.entries()].sort((left, right) => right[1] - left[1])),
  };
}

function auditCausalInputs(adaptive, feedbackRows) {
  const feedbackOrderViolations = feedbackRows.filter((row) => {
    const source = String(row.source_slice_index ?? "").trim();
    // Feedback rows are source observations; the selector applies the configured one-slice lag.
    return source !== "" && numberValue(source, Number.POSITIVE_INFINITY) >
      numberValue(row.slice_index, Number.NEGATIVE_INFINITY);
  }).length;
  const truthLeakRows = feedbackRows.filter((row) =>
    /truth|oracle|simulation-validation-error/i.test(
      `${row.reason ?? ""} ${row.feedback_basis ?? ""} ${row.observation_source ?? ""}`,
    )
  ).length;
  const structuralSourceViolations = numberValue(
    adaptive.planning.structural_source_causal_violations,
  );
  return {
    feedback_rows: feedbackRows.length,
    feedback_order_violations: feedbackOrderViolations,
    feedback_truth_leak_rows: truthLeakRows,
    structural_source_order_violations: structuralSourceViolations,
    passed: feedbackOrderViolations === 0 && truthLeakRows === 0 && structuralSourceViolations === 0,
  };
}

async function loadVariant({ id, truthDir, stage2Dir, groundDir }) {
  const [metrics, summaryRows, pathsHash] = await Promise.all([
    collectIntMcMetrics({ truthDir, stage2Dir, groundDir }),
    readCsv(join(stage2Dir, "probe-summary-int-mc.csv")),
    sha256File(join(stage2Dir, "probe-paths-int-mc.csv")),
  ]);
  return {
    id,
    metrics,
    planning: aggregatePlanning(summaryRows),
    summary_rows: summaryRows,
    path_sha256: pathsHash,
  };
}

function evaluateQuality(adaptive, fresh, causalAudit = {}) {
  const lowerBetter = [
    ["cpu_mae", "CPU MAE"],
    ["queue_depth_mae", "队列 MAE"],
    ["energy_percent_mae", "电量 MAE"],
    ["link_utilization_mae", "链路利用率 MAE"],
  ];
  const higherBetter = [
    ["node_mode_accuracy", "节点模式准确率"],
    ["link_status_accuracy", "链路状态准确率"],
  ];
  const checks = lowerBetter.map(([field, label]) => ({
    id: field,
    label,
    baseline: fresh.metrics[field],
    adaptive: adaptive.metrics[field],
    relative_change_percent: percentageChange(adaptive.metrics[field], fresh.metrics[field]),
    passed: numberValue(adaptive.metrics[field]) <= numberValue(fresh.metrics[field]) * (1 + ERROR_TOLERANCE) + 1e-12,
    gate: `<= fresh x ${(1 + ERROR_TOLERANCE).toFixed(2)}`,
  }));
  checks.push(...higherBetter.map(([field, label]) => ({
    id: field,
    label,
    baseline: fresh.metrics[field],
    adaptive: adaptive.metrics[field],
    absolute_change: round(numberValue(adaptive.metrics[field]) - numberValue(fresh.metrics[field])),
    passed: numberValue(adaptive.metrics[field]) >= numberValue(fresh.metrics[field]) - ACCURACY_DROP_TOLERANCE - 1e-12,
    gate: `>= fresh - ${ACCURACY_DROP_TOLERANCE}`,
  })));
  checks.push(
    {
      id: "telemetry_bytes",
      label: "actual telemetry bytes",
      baseline: fresh.metrics.total_telemetry_generated_bytes,
      adaptive: adaptive.metrics.total_telemetry_generated_bytes,
      relative_change_percent: percentageChange(
        adaptive.metrics.total_telemetry_generated_bytes,
        fresh.metrics.total_telemetry_generated_bytes,
      ),
      passed: numberValue(adaptive.metrics.total_telemetry_generated_bytes) <=
        numberValue(fresh.metrics.total_telemetry_generated_bytes) * (1 + OVERHEAD_INCREASE_TOLERANCE),
      gate: `<= fresh x ${(1 + OVERHEAD_INCREASE_TOLERANCE).toFixed(2)}`,
    },
    {
      id: "telemetry_energy",
      label: "telemetry energy",
      baseline: fresh.metrics.total_telemetry_energy_j,
      adaptive: adaptive.metrics.total_telemetry_energy_j,
      relative_change_percent: percentageChange(
        adaptive.metrics.total_telemetry_energy_j,
        fresh.metrics.total_telemetry_energy_j,
      ),
      passed: numberValue(adaptive.metrics.total_telemetry_energy_j) <=
        numberValue(fresh.metrics.total_telemetry_energy_j) * (1 + OVERHEAD_INCREASE_TOLERANCE),
      gate: `<= fresh x ${(1 + OVERHEAD_INCREASE_TOLERANCE).toFixed(2)}`,
    },
    {
      id: "hard_budget",
      label: "硬预算越界",
      baseline: fresh.metrics.telemetry_byte_budget_cap_violations,
      adaptive: adaptive.metrics.telemetry_byte_budget_cap_violations,
      passed: numberValue(adaptive.metrics.telemetry_byte_budget_cap_violations) === 0 && adaptive.planning.hard_budget_violations === 0,
      gate: "0",
    },
    {
      id: "causal_boundary",
      label: "因果边界违规",
      baseline: fresh.metrics.causal_feedback_violations,
      adaptive: adaptive.metrics.causal_feedback_violations,
      passed: adaptive.metrics.causal_oam_boundary_enabled === true &&
        numberValue(adaptive.metrics.causal_feedback_violations) === 0 &&
        causalAudit.passed !== false,
      gate: "0，且 OAM 因果边界开启",
    },
  );
  return { passed: checks.every((check) => check.passed), checks };
}

function compareVariants(adaptive, baseline) {
  return {
    planning_work_reduction_percent: percentageReduction(
      adaptive.planning.weighted_planning_work_units,
      baseline.planning.weighted_planning_work_units,
    ),
    candidate_reduction_percent: percentageReduction(
      adaptive.planning.candidate_inspections,
      baseline.planning.candidate_inspections,
    ),
    score_recomputation_reduction_percent: percentageReduction(
      adaptive.planning.score_recomputations,
      baseline.planning.score_recomputations,
    ),
    marginal_evaluation_reduction_percent: percentageReduction(
      adaptive.planning.marginal_evaluations,
      baseline.planning.marginal_evaluations,
    ),
    telemetry_byte_reduction_percent: percentageReduction(
      adaptive.metrics.total_telemetry_generated_bytes,
      baseline.metrics.total_telemetry_generated_bytes,
    ),
    telemetry_energy_reduction_percent: percentageReduction(
      adaptive.metrics.total_telemetry_energy_j,
      baseline.metrics.total_telemetry_energy_j,
    ),
    active_link_coverage_delta: round(
      adaptive.metrics.active_link_direct_coverage - baseline.metrics.active_link_direct_coverage,
    ),
  };
}

async function inputFingerprint(artifacts, paths) {
  const hashes = await Promise.all([
    sha256File(join(artifacts.truth_dir, "metadata.json")),
    sha256File(join(artifacts.truth_dir, "links.csv")),
    sha256File(artifacts.candidate_paths_csv),
    sha256File(artifacts.combined_feedback_csv),
    sha256File(paths.pass1_oam_links),
    sha256File(paths.pass1_oam_nodes),
    sha256File(artifacts.full_summary_csv),
  ]);
  return createHash("sha256")
    .update(JSON.stringify({ version: IMPLEMENTATION_VERSION, hashes, tolerance: ERROR_TOLERANCE }))
    .digest("hex");
}

async function runAdaptiveScenario({ naturalRoot, outputDir, scenario, resume }) {
  const artifacts = naturalArtifacts(naturalRoot, scenario);
  const paths = scenarioRunPaths(artifacts, scenario);
  const missing = requiredInputs(artifacts, paths).filter((path) => !existsSync(path));
  if (missing.length) throw new Error(`场景 ${scenario.case_id} 缺少输入：\n${missing.join("\n")}`);
  const metadata = await readJson(join(artifacts.truth_dir, "metadata.json"));
  if (numberValue(metadata.slice_count) !== SLICE_COUNT) {
    throw new Error(`${scenario.case_id} 不是 ${SLICE_COUNT} 时间片：${metadata.slice_count}`);
  }
  const feedbackRows = await readCsv(artifacts.combined_feedback_csv);

  const caseDir = join(outputDir, "cases", scenario.case_id);
  const resultPath = join(caseDir, "case-result.json");
  const fingerprint = await inputFingerprint(artifacts, paths);
  if (resume && existsSync(resultPath)) {
    const cached = await readJson(resultPath);
    if (cached.input_fingerprint === fingerprint && cached.status === "complete") {
      console.log(`[Experiment 12 48-slice] resume ${scenario.case_id}`);
      for (const variant of Object.values(cached.variants ?? {})) {
        if (Array.isArray(variant.summary_rows)) variant.planning = aggregatePlanning(variant.summary_rows);
      }
      cached.causal_audit = auditCausalInputs(cached.variants.adaptive, feedbackRows);
      cached.quality_gates = evaluateQuality(
        cached.variants.adaptive,
        cached.variants.fresh,
        cached.causal_audit,
      );
      await writeJson(resultPath, cached);
      return cached;
    }
  }

  await mkdir(caseDir, { recursive: true });
  const fixed = await loadVariant({
    id: "fixed-threshold",
    truthDir: artifacts.truth_dir,
    stage2Dir: paths.fixed_stage2_dir,
    groundDir: paths.fixed_ground_dir,
  });
  const fresh = await loadVariant({
    id: "fresh-only",
    truthDir: artifacts.truth_dir,
    stage2Dir: paths.fresh_stage2_dir,
    groundDir: paths.fresh_ground_dir,
  });

  const fullMechanisms = buildExperiment12Variants().find((variant) => variant.id === "full-unified").mechanisms;
  const adaptiveStage2Dir = join(caseDir, "adaptive", "stage2");
  const adaptiveGroundDir = join(caseDir, "adaptive", "ground-oam");
  console.log(`[Experiment 12 48-slice] adaptive replay ${scenario.case_id}`);
  const adaptiveRun = await runIntMcPass({
    label: `Experiment 12 adaptive 48-slice ${scenario.case_id}`,
    truthDir: artifacts.truth_dir,
    candidatePathsPath: artifacts.candidate_paths_csv,
    stage2Dir: adaptiveStage2Dir,
    groundDir: adaptiveGroundDir,
    samplingRate: 0.25,
    targetActiveLinkSamplingRate: 0.25,
    rank: 5,
    windowSize: 12,
    warmupSlices: 6,
    iterations: 12,
    maxPathsPerSlice: 12,
    observabilityMode: "oam-only",
    feedbackLagSlices: 1,
    feedbackPath: artifacts.combined_feedback_csv,
    controlActionsPath: paths.pass1_control_actions,
    plannerOamLinksPath: paths.pass1_oam_links,
    plannerOamNodesPath: paths.pass1_oam_nodes,
    telemetryByteBudgetPerNodeSlice: EXPERIMENT12_PROFILE_BUDGETS[PROFILE_ID],
    telemetryByteBudgetPadToCap: false,
    scaleBudgetReferencePath: artifacts.full_summary_csv,
    writeEstimateGraph: false,
    mechanisms: {
      ...fullMechanisms,
      adaptiveStructuralReuse: true,
      structuralReuseErrorTolerance: ERROR_TOLERANCE,
    },
  });
  const adaptive = await loadVariant({
    id: "adaptive-threshold",
    truthDir: artifacts.truth_dir,
    stage2Dir: adaptiveStage2Dir,
    groundDir: adaptiveGroundDir,
  });
  adaptive.timings = adaptiveRun.timings;

  const causalAudit = auditCausalInputs(adaptive, feedbackRows);
  const quality = evaluateQuality(adaptive, fresh, causalAudit);
  const result = {
    schema_version: IMPLEMENTATION_VERSION,
    generated_at: new Date().toISOString(),
    status: "complete",
    input_fingerprint: fingerprint,
    scenario,
    inputs: {
      natural_case_root: artifacts.root,
      truth_dir: artifacts.truth_dir,
      candidate_paths_csv: artifacts.candidate_paths_csv,
      pass1_ground_dir: artifacts.pass1_ground_dir,
      feedback_csv: artifacts.combined_feedback_csv,
      scale_budget_reference_csv: artifacts.full_summary_csv,
    },
    policy: {
      adaptive: true,
      actual_error_tolerance: ERROR_TOLERANCE,
      threshold_decision_uses_truth: false,
      truth_role: "post-run-evaluation-only",
      observability_mode: "oam-only",
      feedback_lag_slices: 1,
    },
    variants: { fresh, fixed, adaptive },
    comparisons: {
      adaptive_vs_fresh: compareVariants(adaptive, fresh),
      adaptive_vs_fixed: compareVariants(adaptive, fixed),
      fixed_vs_fresh_identical_plan: fixed.path_sha256 === fresh.path_sha256,
    },
    causal_audit: causalAudit,
    quality_gates: quality,
  };
  await writeJson(resultPath, result);
  return result;
}

function flattenResult(result) {
  const { fresh, fixed, adaptive } = result.variants;
  return {
    case_id: result.scenario.case_id,
    window_id: result.scenario.window_id,
    epoch_iso: result.scenario.epoch_iso,
    slices: adaptive.planning.slice_count,
    adaptive_trigger_slices: adaptive.planning.trigger_slices,
    adaptive_trigger_rate: adaptive.planning.trigger_rate,
    adaptive_reuse_slices: adaptive.planning.modes.reuse,
    adaptive_repair_slices: adaptive.planning.modes.repair,
    adaptive_fresh_slices: adaptive.planning.modes.fresh,
    adaptive_structural_eligible_slices: adaptive.planning.structural_eligible_slices,
    adaptive_similarity_threshold_mean: adaptive.planning.mean_effective_similarity_threshold,
    adaptive_similarity_threshold_min: adaptive.planning.minimum_effective_similarity_threshold,
    adaptive_similarity_threshold_max: adaptive.planning.maximum_effective_similarity_threshold,
    fixed_trigger_slices: fixed.planning.trigger_slices,
    fresh_work_units: fresh.planning.weighted_planning_work_units,
    fixed_work_units: fixed.planning.weighted_planning_work_units,
    adaptive_work_units: adaptive.planning.weighted_planning_work_units,
    planning_work_reduction_vs_fresh_percent: result.comparisons.adaptive_vs_fresh.planning_work_reduction_percent,
    candidate_reduction_vs_fresh_percent: result.comparisons.adaptive_vs_fresh.candidate_reduction_percent,
    score_recomputation_reduction_vs_fresh_percent: result.comparisons.adaptive_vs_fresh.score_recomputation_reduction_percent,
    marginal_evaluation_reduction_vs_fresh_percent: result.comparisons.adaptive_vs_fresh.marginal_evaluation_reduction_percent,
    telemetry_byte_reduction_vs_fresh_percent: result.comparisons.adaptive_vs_fresh.telemetry_byte_reduction_percent,
    telemetry_energy_reduction_vs_fresh_percent: result.comparisons.adaptive_vs_fresh.telemetry_energy_reduction_percent,
    fresh_cpu_mae: fresh.metrics.cpu_mae,
    adaptive_cpu_mae: adaptive.metrics.cpu_mae,
    cpu_mae_change_percent: percentageChange(adaptive.metrics.cpu_mae, fresh.metrics.cpu_mae),
    fresh_queue_mae: fresh.metrics.queue_depth_mae,
    adaptive_queue_mae: adaptive.metrics.queue_depth_mae,
    queue_mae_change_percent: percentageChange(adaptive.metrics.queue_depth_mae, fresh.metrics.queue_depth_mae),
    fresh_energy_mae: fresh.metrics.energy_percent_mae,
    adaptive_energy_mae: adaptive.metrics.energy_percent_mae,
    energy_mae_change_percent: percentageChange(adaptive.metrics.energy_percent_mae, fresh.metrics.energy_percent_mae),
    fresh_link_utilization_mae: fresh.metrics.link_utilization_mae,
    adaptive_link_utilization_mae: adaptive.metrics.link_utilization_mae,
    link_utilization_mae_change_percent: percentageChange(adaptive.metrics.link_utilization_mae, fresh.metrics.link_utilization_mae),
    node_mode_accuracy_delta: round(adaptive.metrics.node_mode_accuracy - fresh.metrics.node_mode_accuracy),
    link_status_accuracy_delta: round(adaptive.metrics.link_status_accuracy - fresh.metrics.link_status_accuracy),
    hard_budget_violations: adaptive.metrics.telemetry_byte_budget_cap_violations + adaptive.planning.hard_budget_violations,
    causal_violations:
      numberValue(adaptive.metrics.causal_feedback_violations) +
      numberValue(result.causal_audit?.feedback_order_violations) +
      numberValue(result.causal_audit?.feedback_truth_leak_rows) +
      numberValue(result.causal_audit?.structural_source_order_violations),
    quality_gates_passed: result.quality_gates.passed,
    fixed_fresh_equivalent_outcome:
      fixed.planning.weighted_planning_work_units === fresh.planning.weighted_planning_work_units &&
      fixed.metrics.total_telemetry_generated_bytes === fresh.metrics.total_telemetry_generated_bytes &&
      fixed.metrics.cpu_mae === fresh.metrics.cpu_mae &&
      fixed.metrics.queue_depth_mae === fresh.metrics.queue_depth_mae &&
      fixed.metrics.energy_percent_mae === fresh.metrics.energy_percent_mae &&
      fixed.metrics.link_utilization_mae === fresh.metrics.link_utilization_mae,
  };
}

function perSliceRows(result) {
  return ["fresh", "fixed", "adaptive"].flatMap((key) => {
    const variant = result.variants[key];
    return variant.summary_rows.map((row) => ({
      case_id: result.scenario.case_id,
      window_id: result.scenario.window_id,
      variant: variant.id,
      slice_index: row.slice_index,
      mode: row.unified_planner_selected_mode,
      structural_source_slice: row.unified_structural_cache_source_slice,
      structural_similarity: row.unified_structural_cache_similarity,
      structural_eligible: row.unified_structural_cache_eligible,
      adaptive_enabled: row.unified_structural_cache_adaptive_enabled,
      effective_similarity_threshold: row.unified_structural_cache_effective_similarity_threshold,
      relaxation_factor: row.unified_structural_cache_relaxation_factor,
      estimated_error_increase_proxy: row.unified_structural_cache_estimated_error_increase_proxy,
      planning_candidate_paths: row.planning_candidate_paths,
      score_recomputations: row.unified_planner_score_cache_recomputations,
      marginal_evaluations: row.unified_planner_marginal_evaluations,
      selected_paths: row.selected_paths,
      estimated_telemetry_bytes: row.estimated_total_telemetry_bytes,
      hard_budget_violations: row.unified_planner_budget_violations,
      active_link_coverage: row.active_link_sampling_coverage,
      rejection_reasons: row.unified_structural_cache_rejection_reasons,
    }));
  });
}

function buildOverall(rows) {
  const totalSlices = rows.reduce((total, row) => total + row.slices, 0);
  const triggerSlices = rows.reduce((total, row) => total + row.adaptive_trigger_slices, 0);
  const exactReuseSlices = rows.reduce((total, row) => total + row.adaptive_reuse_slices, 0);
  const localRepairSlices = rows.reduce((total, row) => total + row.adaptive_repair_slices, 0);
  const qualityPasses = rows.filter((row) => row.quality_gates_passed).length;
  const triggeredWindows = rows.filter((row) => row.adaptive_trigger_slices > 0).length;
  const positiveWorkWindows = rows.filter((row) => row.planning_work_reduction_vs_fresh_percent > 0).length;
  const meanWorkReduction = round(mean(rows.map((row) => row.planning_work_reduction_vs_fresh_percent)));
  const allHardBudgetPass = rows.every((row) => numberValue(row.hard_budget_violations) === 0);
  const allCausalPass = rows.every((row) => numberValue(row.causal_violations) === 0);
  const generalizationPassed =
    triggeredWindows >= 2 &&
    positiveWorkWindows >= 2 &&
    qualityPasses === rows.length &&
    allHardBudgetPass &&
    allCausalPass;
  return {
    window_count: rows.length,
    total_slices: totalSlices,
    trigger_slices: triggerSlices,
    exact_reuse_slices: exactReuseSlices,
    local_repair_slices: localRepairSlices,
    trigger_rate: round(triggerSlices / Math.max(totalSlices, 1)),
    triggered_windows: triggeredWindows,
    positive_work_reduction_windows: positiveWorkWindows,
    quality_gate_pass_windows: qualityPasses,
    mean_planning_work_reduction_percent: meanWorkReduction,
    mean_score_recomputation_reduction_percent: round(mean(rows.map((row) => row.score_recomputation_reduction_vs_fresh_percent))),
    mean_marginal_evaluation_reduction_percent: round(mean(rows.map((row) => row.marginal_evaluation_reduction_vs_fresh_percent))),
    mean_adaptive_similarity_threshold: round(mean(rows.map((row) => row.adaptive_similarity_threshold_mean))),
    minimum_adaptive_similarity_threshold: round(Math.min(...rows.map((row) => row.adaptive_similarity_threshold_min))),
    maximum_adaptive_similarity_threshold: round(Math.max(...rows.map((row) => row.adaptive_similarity_threshold_max))),
    mean_telemetry_byte_reduction_percent: round(mean(rows.map((row) => row.telemetry_byte_reduction_vs_fresh_percent))),
    mean_telemetry_energy_reduction_percent: round(mean(rows.map((row) => row.telemetry_energy_reduction_vs_fresh_percent))),
    all_hard_budget_gates_passed: allHardBudgetPass,
    all_causal_gates_passed: allCausalPass,
    generalization_criterion: "至少 2/3 窗口触发且规划工作量下降，3/3 通过 2% 误差、1% 开销非劣、硬预算和因果门禁",
    generalization_passed: generalizationPassed,
    generalization_type: exactReuseSlices > 0
      ? "exact-reuse-and-local-repair"
      : "local-repair-only",
    claim_scope: "Telesat 351、三个自然起始窗口、每窗口 48 时间片、0% 外加动态压力",
  };
}

function modeStrip(result) {
  const rows = result.variants.adaptive.summary_rows;
  const cells = rows.map((row) => {
    const mode = String(row.unified_planner_selected_mode || "fresh");
    return `<span class="slice ${escapeHtml(mode)}" title="T${String(row.slice_index).padStart(2, "0")} ${escapeHtml(mode)}">${escapeHtml(row.slice_index)}</span>`;
  }).join("");
  return `<div class="strip">${cells}</div>`;
}

function metricTable(rows) {
  return rows.map((row) => `<tr>
    <td>${escapeHtml(row.window_id)}</td>
    <td>${row.adaptive_trigger_slices}/48</td>
    <td>${row.planning_work_reduction_vs_fresh_percent.toFixed(2)}%</td>
    <td>${row.telemetry_byte_reduction_vs_fresh_percent.toFixed(2)}%</td>
    <td>${row.telemetry_energy_reduction_vs_fresh_percent.toFixed(2)}%</td>
    <td>${row.cpu_mae_change_percent.toFixed(2)}%</td>
    <td>${row.queue_mae_change_percent.toFixed(2)}%</td>
    <td>${row.energy_mae_change_percent.toFixed(2)}%</td>
    <td>${row.link_utilization_mae_change_percent.toFixed(2)}%</td>
    <td class="${row.quality_gates_passed ? "pass" : "fail"}">${row.quality_gates_passed ? "通过" : "未通过"}</td>
  </tr>`).join("");
}

function buildHtml(results, rows, overall) {
  const conclusion = overall.generalization_passed
    ? "在本次预先固定的三个 48 片自然窗口中，自适应局部修复已通过推广性门禁。"
    : "本轮尚未通过预设推广性门禁，只能保留为边界或机制证据。";
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>实验12 48片拓扑复用推广性</title><style>
  :root{color-scheme:light;--ink:#17202a;--muted:#667085;--line:#d8dee7;--blue:#2563eb;--green:#16865b;--amber:#c57a08;--red:#c33b3b;--panel:#f7f9fc}*{box-sizing:border-box}body{margin:0;font-family:Inter,"Microsoft YaHei",sans-serif;color:var(--ink);background:white;line-height:1.55}header{padding:28px 5vw 20px;border-bottom:1px solid var(--line);background:#f4f7fb}main{max-width:1280px;margin:auto;padding:24px 5vw 56px}h1{font-size:28px;margin:0 0 8px}h2{font-size:20px;margin:28px 0 12px}p{margin:8px 0}.muted{color:var(--muted)}.cards{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}.card{border:1px solid var(--line);padding:14px;background:white}.card b{display:block;font-size:24px}.pass{color:var(--green);font-weight:700}.fail{color:var(--red);font-weight:700}.window{border-top:1px solid var(--line);padding:16px 0}.strip{display:grid;grid-template-columns:repeat(24,minmax(22px,1fr));gap:3px}.slice{height:24px;display:flex;align-items:center;justify-content:center;font-size:10px;color:white;border-radius:2px}.slice.fresh{background:#8b95a7}.slice.reuse{background:var(--green)}.slice.repair{background:var(--amber)}table{border-collapse:collapse;width:100%;font-size:13px}th,td{border:1px solid var(--line);padding:8px;text-align:right}th:first-child,td:first-child{text-align:left}th{background:var(--panel)}code{background:#eef2f7;padding:2px 5px}.legend{display:flex;gap:16px;font-size:13px}.dot{width:10px;height:10px;display:inline-block;margin-right:5px}.fresh-dot{background:#8b95a7}.reuse-dot{background:var(--green)}.repair-dot{background:var(--amber)}@media(max-width:900px){.cards{grid-template-columns:1fr 1fr}.strip{grid-template-columns:repeat(12,minmax(22px,1fr));}table{display:block;overflow:auto}}
  </style></head><body><header><h1>实验 12：48 时间片拓扑复用推广性检验</h1><p>完整因果回放，不以两时间片定向样本外推。三个 Telesat 351 自然起始窗口，共 ${overall.total_slices} 个时间片。</p></header><main>
  <section class="cards"><div class="card"><span>实际触发率</span><b>${(overall.trigger_rate * 100).toFixed(2)}%</b><small>${overall.trigger_slices}/${overall.total_slices} 片</small></div><div class="card"><span>触发窗口</span><b>${overall.triggered_windows}/${overall.window_count}</b><small>至少 2 个为门禁</small></div><div class="card"><span>平均规划工作量削减</span><b>${overall.mean_planning_work_reduction_percent.toFixed(2)}%</b><small>相对 fresh-only</small></div><div class="card"><span>推广性判定</span><b class="${overall.generalization_passed ? "pass" : "fail"}">${overall.generalization_passed ? "通过" : "未通过"}</b><small>2% 重构误差容忍</small></div></section>
  <h2>结论</h2><p><strong>${conclusion}</strong></p><p>触发的 ${overall.trigger_slices} 片中，exact reuse 为 ${overall.exact_reuse_slices} 片，local repair 为 ${overall.local_repair_slices} 片。因此本轮证明的是局部修复式拓扑复用的窗口级贡献，不是完全相同拓扑的整计划复用。</p><p>自适应相似度门槛均值为 ${overall.mean_adaptive_similarity_threshold.toFixed(4)}，范围为 ${overall.minimum_adaptive_similarity_threshold.toFixed(4)}～${overall.maximum_adaptive_similarity_threshold.toFixed(4)}；它由逐片风险和 OAM 压力计算，不是简单换用另一个固定阈值。</p><p>实际遥测字节平均下降 ${overall.mean_telemetry_byte_reduction_percent.toFixed(2)}%，遥测能耗平均变化 ${(-overall.mean_telemetry_energy_reduction_percent).toFixed(2)}%（正值表示增加）。能耗未下降，但增幅低于 1% 非劣门禁。</p><p class="muted">结论范围：${escapeHtml(overall.claim_scope)}。该实验不外推到额外动态压力、其他星座或真实运营商内部状态。</p>
  <h2>逐时间片规划模式</h2><div class="legend"><span><i class="dot fresh-dot"></i>fresh</span><span><i class="dot reuse-dot"></i>reuse</span><span><i class="dot repair-dot"></i>repair</span></div>
  ${results.map((result) => `<section class="window"><h3>${escapeHtml(result.scenario.window_id)} · ${escapeHtml(result.scenario.epoch_iso)}</h3>${modeStrip(result)}</section>`).join("")}
  <h2>窗口级结果</h2><table><thead><tr><th>窗口</th><th>触发片</th><th>规划工作量削减</th><th>遥测字节削减</th><th>遥测能耗削减</th><th>CPU MAE变化</th><th>队列 MAE变化</th><th>电量 MAE变化</th><th>利用率 MAE变化</th><th>质量门禁</th></tr></thead><tbody>${metricTable(rows)}</tbody></table>
  <h2>实验口径</h2><p>固定门槛、fresh-only 与自适应门槛共享第一阶段真值、候选路径、pass-1 Ground OAM、反馈时滞和逐片硬字节预算。自适应门槛只使用过去 OAM、缓存年龄和可预测拓扑风险；真值仅用于实验后误差检验。</p>
  <p>文件：<code>adaptive-reuse-48slice-summary.csv</code>、<code>adaptive-reuse-48slice-by-slice.csv</code>、<code>adaptive-reuse-48slice-results.json</code>。</p>
  </main></body></html>`;
}

function buildMarkdown(rows, overall) {
  const conclusion = overall.generalization_passed
    ? "通过预设的 48 片推广性门禁。"
    : "未通过预设的 48 片推广性门禁，不能声称具备窗口级推广性。";
  const tableRows = rows.map((row) =>
    `| ${row.window_id} | ${row.adaptive_trigger_slices}/48 | ${row.planning_work_reduction_vs_fresh_percent}% | ${row.telemetry_byte_reduction_vs_fresh_percent}% | ${row.telemetry_energy_reduction_vs_fresh_percent}% | ${row.quality_gates_passed ? "通过" : "未通过"} |`,
  ).join("\n");
  return `# 实验 12：48 时间片拓扑复用推广性检验\n\n` +
    `## 实验目的\n\n两时间片定向回放只能证明条件触发时的局部机制，不能外推为整个 48 时间片窗口的总体收益。本实验对三个预先固定的 Telesat 351 自然起始窗口执行完整 T00-T47 因果回放。\n\n` +
    `## 公平性与因果边界\n\n- 三种方案共享同一第一阶段真值、候选路径、pass-1 Ground OAM 和每片硬字节预算。\n- 自适应方案的结构误差预算为 ${(ERROR_TOLERANCE * 100).toFixed(0)}%，但门槛决策不读取真值误差。\n- Ground OAM 反馈至少滞后一片；第一阶段真值仅用于 probe 完成后的 MAE/准确率验收。\n- 冻结固定门槛基线在三个窗口均未触发复用，因此同时保留 fresh-only 作为规划工作量参照。\n\n` +
    `## 预设判据\n\n至少 2/3 窗口出现 reuse/repair 且规划工作量下降；3/3 窗口的 CPU、队列、电量和链路利用率 MAE 相对 fresh 退化不超过 2%；准确率下降不超过 0.005；遥测字节和能耗增幅不超过 1%；硬预算和因果违规均为 0。\n\n` +
    `## 结果\n\n| 窗口 | 自适应触发片 | 规划工作量削减 | 遥测字节削减 | 遥测能耗削减 | 质量门禁 |\n|---|---:|---:|---:|---:|---|\n${tableRows}\n\n` +
    `- 总触发率：${overall.trigger_slices}/${overall.total_slices} = ${(overall.trigger_rate * 100).toFixed(2)}%。\n` +
    `- 触发类型：exact reuse ${overall.exact_reuse_slices} 片，local repair ${overall.local_repair_slices} 片。\n` +
    `- 触发窗口：${overall.triggered_windows}/${overall.window_count}。\n` +
    `- 平均规划工作量削减：${overall.mean_planning_work_reduction_percent}%。\n` +
    `- 平均评分重算削减：${overall.mean_score_recomputation_reduction_percent}%；平均边际收益评估削减：${overall.mean_marginal_evaluation_reduction_percent}%。\n` +
    `- 自适应相似度门槛均值为 ${overall.mean_adaptive_similarity_threshold}，实际范围为 ${overall.minimum_adaptive_similarity_threshold}～${overall.maximum_adaptive_similarity_threshold}；它由每片风险和 OAM 压力计算，不是把固定 0.94 简单改成另一个常数。\n` +
    `- 平均实际遥测字节削减：${overall.mean_telemetry_byte_reduction_percent}%。\n` +
    `- 平均遥测能耗削减：${overall.mean_telemetry_energy_reduction_percent}%。\n` +
    `- 最终判定：**${conclusion}**\n` +
    `- 重要边界：本轮触发全部是局部修复，因此不能声称 exact reuse 已获得推广性证据。遥测能耗平均上升 ${round(-overall.mean_telemetry_energy_reduction_percent)}%，只满足 1% 非劣，并未得到能耗下降。\n\n` +
    `## 可声明边界\n\n该结论仅覆盖 Telesat 351、三个自然起始窗口、每窗口 48 时间片和 0% 外加动态压力。它检验了自然轨道动态下的窗口级推广性，但不能直接推广到更强人为断链压力、其他星座或真实运营商内部网络。\n`;
}

async function main() {
  const args = process.argv.slice(2);
  const naturalRoot = resolve(argValue(args, "--natural-root", DEFAULT_NATURAL_ROOT));
  const outputDir = resolve(argValue(args, "--out", DEFAULT_OUTPUT_DIR));
  const resume = boolValue(argValue(args, "--resume", "true"), true);
  const scenarios = buildTopologyReuseEvidenceMatrix({ profileIds: [PROFILE_ID] })
    .filter((scenario) => scenario.stress_rate === 0);
  if (scenarios.length !== 3) throw new Error(`Expected three natural windows, received ${scenarios.length}`);
  await mkdir(outputDir, { recursive: true });

  const results = [];
  for (const scenario of scenarios) {
    results.push(await runAdaptiveScenario({ naturalRoot, outputDir, scenario, resume }));
  }
  const rows = results.map(flattenResult);
  const bySlice = results.flatMap(perSliceRows);
  const overall = buildOverall(rows);
  const artifact = {
    schema_version: IMPLEMENTATION_VERSION,
    generated_at: new Date().toISOString(),
    experimental_design: {
      profile_id: PROFILE_ID,
      windows: scenarios.map((scenario) => ({
        window_id: scenario.window_id,
        epoch_iso: scenario.epoch_iso,
        seed: scenario.seed,
      })),
      slices_per_window: SLICE_COUNT,
      external_dynamicity_stress_rate: 0,
      adaptive_error_tolerance: ERROR_TOLERANCE,
      accuracy_drop_tolerance: ACCURACY_DROP_TOLERANCE,
      overhead_increase_tolerance: OVERHEAD_INCREASE_TOLERANCE,
      variants: ["fresh-only", "fixed-threshold", "adaptive-threshold"],
    },
    overall,
    rows,
    case_result_files: results.map((result) => relative(outputDir, join(outputDir, "cases", result.scenario.case_id, "case-result.json"))),
  };
  await Promise.all([
    writeFile(join(outputDir, "adaptive-reuse-48slice-summary.csv"), rowsToCsv(rows), "utf8"),
    writeFile(join(outputDir, "adaptive-reuse-48slice-by-slice.csv"), rowsToCsv(bySlice), "utf8"),
    writeJson(join(outputDir, "adaptive-reuse-48slice-results.json"), artifact),
    writeFile(join(outputDir, "ADAPTIVE_REUSE_48SLICE_REPORT.md"), buildMarkdown(rows, overall), "utf8"),
    writeFile(join(outputDir, "index.html"), buildHtml(results, rows, overall), "utf8"),
  ]);
  console.log(JSON.stringify({
    status: "complete",
    output_dir: outputDir,
    overall,
    report: join(outputDir, "ADAPTIVE_REUSE_48SLICE_REPORT.md"),
    visualization: join(outputDir, "index.html"),
  }, null, 2));
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

export {
  aggregatePlanning,
  buildOverall,
  evaluateQuality,
  flattenResult,
};
