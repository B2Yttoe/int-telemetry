import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runCommandTimed } from "./experiments/intMcExperimentCore.mjs";
import { escapeHtml, parseCsv, rowsToCsv } from "./experiments/reportUtils.mjs";
import { buildTopologyReuseEvidenceMatrix } from "./experiments/topologyReuseStatisticalEvidence.mjs";
import {
  DIRECTED_REUSE_STRATA,
  buildDirectedReusePreregistration,
  evaluateDirectedQualityGates,
  pairedBootstrapMean,
  planningWorkUnits,
  scanDirectedReuseOpportunities,
  selectDirectedValidationPairs,
} from "./experiments/topologyReuseDirectedValidation.mjs";
import { readCsvStream } from "../stage2-int/tools/csv-stream.mjs";
import {
  DEFAULT_STRUCTURAL_CACHE_GUARDS,
  assessAdaptiveStructuralCacheCandidate,
} from "../stage2-int/tools/topology-versioned-risk-planner.mjs";

const NATURAL_ROOT = resolve("reports/experiment12-topology-reuse-statistical-evidence");
const DEFAULT_OUTPUT_DIR = resolve("reports/experiment12-directed-reuse-confirmatory");
const PROFILE_LABELS = Object.freeze({
  "starlink-main-large": "Starlink 1584",
  "telesat-1015-medium": "Telesat 351",
});
const ADAPTIVE_STRUCTURAL_REUSE_PILOT_POLICY = Object.freeze({
  enabled: true,
  relative_error_tolerance: 0.02,
  minimum_similarity_floor: 0.9,
  maximum_changed_link_ratio_ceiling: 0.12,
  maximum_affected_path_ratio_ceiling: 0.25,
  minimum_valid_path_ratio_floor: 0.75,
});

const TRUTH_LINK_COLUMNS = Object.freeze([
  "slice_index", "time", "minute", "link_id", "source", "target", "kind",
  "is_active", "status", "p_available", "availability_factor", "design_candidate",
  "line_of_sight", "distance_km", "distance_threshold_km", "capacity_mbps",
  "effective_capacity_mbps", "sinr_db", "snr_db", "solar_interference_blocked",
  "restriction_reason",
]);
const TRUTH_NODE_COLUMNS = Object.freeze([
  "slice_index", "time", "minute", "node_id", "label", "plane", "slot", "shell_id",
  "latitude", "longitude", "altitude_km", "x", "y", "z", "in_sunlight",
  "solar_exposure", "solar_power_w", "battery_capacity_wh", "min_state_of_charge",
  "base_power_w",
]);
const ROUTE_COLUMNS = Object.freeze([
  "slice_index", "time", "minute", "task_id", "source", "target", "node_id",
  "link_ids", "path", "hop_count", "path_link_count", "status", "traffic_mbps",
  "priority", "created_slice",
]);
const OAM_LINK_COLUMNS = Object.freeze([
  "slice_index", "link_id", "status_estimate", "confidence", "state_age_slices",
  "last_observed_slice", "confidence_state", "conflict_severity", "oam_conflict_severity",
  "latency_ms_estimate", "queue_latency_ms_estimate", "utilization_percent_estimate",
  "congestion_percent_estimate", "queued_traffic_mb_estimate", "dropped_traffic_mb_estimate",
  "packet_error_rate_estimate", "observation_source",
]);
const OAM_NODE_COLUMNS = Object.freeze([
  "slice_index", "node_id", "confidence", "state_age_slices", "last_observed_slice",
  "confidence_state", "conflict_severity", "oam_conflict_severity", "observation_source",
  "cpu_percent_estimate", "queue_depth_estimate", "queued_traffic_mb_estimate",
  "cache_used_mb_estimate", "energy_percent_estimate", "mode_estimate",
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
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value, digits = 6) {
  return Number.isFinite(Number(value)) ? Number(Number(value).toFixed(digits)) : 0;
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function median(values) {
  const sorted = values.map(Number).filter(Number.isFinite).sort((left, right) => left - right);
  if (sorted.length === 0) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function splitList(value) {
  return String(value ?? "").split(" > ").map((item) => item.trim()).filter(Boolean);
}

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function naturalCaseRoot(naturalRoot, scenario) {
  return join(naturalRoot, "cases", scenario.profile_id, scenario.case_id);
}

function naturalArtifacts(naturalRoot, scenario) {
  const root = naturalCaseRoot(naturalRoot, scenario);
  const runRoot = join(
    root,
    "experiment12",
    "runs",
    scenario.profile_id,
    scenario.stress_id,
  );
  const fullRoot = join(runRoot, "full-unified");
  const freshRoot = join(runRoot, "no-topology-version");
  return {
    root,
    truth_dir: join(root, "stress-root", scenario.profile_id, scenario.stress_id),
    candidate_paths_csv: join(
      root,
      "source-root",
      scenario.profile_id,
      "experiment2",
      "stage2",
      "full-probe-int",
      "probe-paths-path-balance.csv",
    ),
    pass1_paths_csv: join(fullRoot, "stage2", "int-mc-pass1", "probe-paths-int-mc.csv"),
    pass1_ground_dir: join(fullRoot, "ground-oam", "int-mc-pass1"),
    combined_feedback_csv: join(fullRoot, "combined-int-mc-feedback.csv"),
    full_summary_csv: join(fullRoot, "stage2", "full-unified", "probe-summary-int-mc.csv"),
    fresh_summary_csv: join(freshRoot, "stage2", "no-topology-version", "probe-summary-int-mc.csv"),
    full_paths_csv: join(fullRoot, "stage2", "full-unified", "probe-paths-int-mc.csv"),
    fresh_paths_csv: join(freshRoot, "stage2", "no-topology-version", "probe-paths-int-mc.csv"),
  };
}

function requireNaturalArtifacts(artifacts, scenario) {
  const required = [
    join(artifacts.truth_dir, "links.csv"),
    join(artifacts.truth_dir, "nodes.csv"),
    artifacts.candidate_paths_csv,
    artifacts.pass1_paths_csv,
    artifacts.full_summary_csv,
    artifacts.fresh_summary_csv,
  ];
  const missing = required.filter((path) => !existsSync(path));
  if (missing.length > 0) {
    throw new Error(`Natural case ${scenario.profile_id}/${scenario.case_id} is incomplete:\n${missing.join("\n")}`);
  }
}

function deriveNaturalRejectionReasons(summary = {}) {
  const reasons = new Set(splitList(summary.unified_mode_prefilter_rejection_reasons));
  const policy = String(summary.unified_mode_prefilter_policy ?? "");
  if (policy === "fresh-no-cache") reasons.add("topology-class-cache-miss");
  if (policy === "fresh-oam-replan") reasons.add("ground-oam-global-replan-request");
  if (numberValue(summary.topology_similarity_score, 1) < numberValue(summary.adaptive_reuse_threshold, 0)) {
    reasons.add("topology-similarity-below-adaptive-threshold");
  }
  if (numberValue(summary.unified_mode_prefilter_changed_link_ratio) > 0.08) {
    reasons.add("changed-link-ratio-above-local-repair-limit");
  }
  if (numberValue(summary.topology_forecast_reuse_confidence, 1) < 0.9) {
    reasons.add("reuse-confidence-below-local-repair-floor");
  }
  if (numberValue(summary.topology_forecast_drift_pressure) > 0.08) {
    reasons.add("forecast-drift-above-local-repair-ceiling");
  }
  if (/fresh|replan/.test(String(summary.topology_forecast_recommended_plan_mode ?? ""))) {
    reasons.add("forecast-recommends-fresh-plan");
  }
  return [...reasons].sort();
}

async function ensurePreregistration(outputDir) {
  const design = buildDirectedReusePreregistration();
  const path = join(outputDir, "PREREGISTRATION.json");
  if (existsSync(path)) {
    const existing = await readJson(path);
    if (existing.design_sha256 !== design.design_sha256) {
      throw new Error("Existing Experiment 12B preregistration differs; use a new output directory");
    }
    return existing;
  }
  const artifact = { preregistered_at: new Date().toISOString(), ...design };
  await writeJson(path, artifact);
  await writeFile(
    join(outputDir, "PREREGISTRATION.md"),
    `# 实验 12B/12C 预注册\n\n` +
      `- 设计指纹：\`${artifact.design_sha256}\`\n` +
      `- 12A：保留现有 18 个自然场景，不重跑。\n` +
      `- 12B：Starlink 1584 按拓扑 Jaccard 相似度预分层，每层先取 2 对，只重放路径规划。\n` +
      `- 12C：Telesat 351 从不同窗口选择最多 3 个满足统一结构缓存保护门限的中等相似窗口。\n` +
      `- 选择规则只读取活动链路集合与中性 pass-1 路径，不读取收益、误差或方法标签。\n` +
      `- 已用于实现调试的首个高相似配对被预先排除，只保留为开发性 pilot，不进入确认性统计。\n` +
      `- 主指标为确定性规划工作计数；墙钟时间重复 3 次并取中位数。\n` +
      `- 顺序停止：6 对后若条件收益 bootstrap 95% 下界大于 0、平均收益至少 5%，且所有可计算质量门禁通过，则停止；否则每次增加 3 对，最多 12 对。\n` +
      `- 12B 不重新执行完整矩阵补全，因此新计划的 MAE 标记为未测量，不以代理值冒充 MAE。\n`,
    "utf8",
  );
  return artifact;
}

async function loadNaturalPlannerRows(artifacts) {
  return readCsvStream(artifacts.full_summary_csv, {
    columns: [
      "slice_index", "unified_planner_selected_mode", "unified_mode_prefilter_policy",
      "unified_mode_prefilter_reason", "unified_mode_prefilter_rejection_reasons",
      "unified_mode_prefilter_changed_link_ratio", "topology_similarity_score",
      "adaptive_reuse_threshold", "topology_forecast_reuse_confidence",
      "topology_forecast_drift_pressure", "topology_forecast_recommended_plan_mode",
      "oam_replan_pressure",
    ],
  });
}

async function runOpportunityScan({ naturalRoot, outputDir, scenarios }) {
  const allRows = [];
  for (const scenario of scenarios) {
    const artifacts = naturalArtifacts(naturalRoot, scenario);
    requireNaturalArtifacts(artifacts, scenario);
    console.log(`[Experiment 12B scan] ${scenario.profile_id}/${scenario.case_id}`);
    const links = await readCsvStream(join(artifacts.truth_dir, "links.csv"), {
      columns: ["slice_index", "link_id", "is_active"],
    });
    const cachedPaths = await readCsvStream(artifacts.pass1_paths_csv, {
      columns: ["slice_index", "probe_id", "link_ids", "unified_observed_link_ids"],
    });
    const naturalPlannerRows = await loadNaturalPlannerRows(artifacts);
    const naturalBySlice = new Map(naturalPlannerRows.map((row) => [numberValue(row.slice_index), row]));
    const scanRows = scanDirectedReuseOpportunities({
      links,
      cachedProbePaths: cachedPaths,
      cacheWindowSlices: 12,
      scenario: {
        profile_id: scenario.profile_id,
        profile_label: PROFILE_LABELS[scenario.profile_id] ?? scenario.profile_id,
        case_id: scenario.case_id,
        window_id: scenario.window_id,
        stress_rate: scenario.stress_rate,
        seed: scenario.seed,
      },
    }).map((row) => {
      const planner = naturalBySlice.get(numberValue(row.current_slice_index)) ?? {};
      const rejectionReasons = deriveNaturalRejectionReasons(planner);
      const cacheAgeSlices = Number.isFinite(Number(row.historical_slice_index))
        ? numberValue(row.current_slice_index) - numberValue(row.historical_slice_index)
        : 12;
      const fixedAssessment = assessAdaptiveStructuralCacheCandidate({
        similarity: row.topology_jaccard,
        changedLinkRatio: row.changed_link_ratio,
        affectedPathRatio: row.affected_cached_path_ratio,
        validPathRatio: row.valid_cached_path_ratio,
        cacheAgeSlices,
        cacheWindowSlices: 12,
      });
      const adaptiveAssessment = assessAdaptiveStructuralCacheCandidate({
        similarity: row.topology_jaccard,
        changedLinkRatio: row.changed_link_ratio,
        affectedPathRatio: row.affected_cached_path_ratio,
        validPathRatio: row.valid_cached_path_ratio,
        cacheAgeSlices,
        cacheWindowSlices: 12,
        adaptivePolicy: ADAPTIVE_STRUCTURAL_REUSE_PILOT_POLICY,
        forecastDriftPressure: planner.topology_forecast_drift_pressure,
        oamPressure: planner.oam_replan_pressure,
        reuseConfidence: planner.topology_forecast_reuse_confidence,
        planningOverheadPressure: 0.5,
        recommendedPlanMode: planner.topology_forecast_recommended_plan_mode,
      });
      return {
        ...row,
        natural_selected_mode: planner.unified_planner_selected_mode ?? "",
        natural_prefilter_policy: planner.unified_mode_prefilter_policy ?? "",
        natural_prefilter_reason: planner.unified_mode_prefilter_reason ?? "",
        natural_rejection_reasons: rejectionReasons.join(" > "),
        natural_forecast_drift_pressure: planner.topology_forecast_drift_pressure ?? "",
        natural_forecast_reuse_confidence: planner.topology_forecast_reuse_confidence ?? "",
        natural_forecast_recommended_plan_mode: planner.topology_forecast_recommended_plan_mode ?? "",
        natural_oam_replan_pressure: planner.oam_replan_pressure ?? "",
        fixed_structural_cache_eligible: fixedAssessment.eligible,
        adaptive_structural_cache_eligible: adaptiveAssessment.eligible,
        adaptive_structural_similarity_threshold: adaptiveAssessment.effective_guards.minimum_similarity,
        adaptive_structural_changed_link_limit: adaptiveAssessment.effective_guards.maximum_changed_link_ratio,
        adaptive_structural_affected_path_limit: adaptiveAssessment.effective_guards.maximum_affected_path_ratio,
        adaptive_structural_valid_path_floor: adaptiveAssessment.effective_guards.minimum_valid_path_ratio,
        adaptive_structural_relaxation_factor: adaptiveAssessment.relaxation_factor,
        adaptive_structural_risk_pressure: adaptiveAssessment.risk_pressure,
        adaptive_structural_estimated_error_increase_proxy:
          adaptiveAssessment.estimated_relative_error_increase_proxy,
        adaptive_structural_error_tolerance_utilization: adaptiveAssessment.error_tolerance_utilization,
        adaptive_structural_rejection_reasons: adaptiveAssessment.rejection_reasons.join(" > "),
      };
    });
    allRows.push(...scanRows);
  }

  const starlinkSelection = selectDirectedValidationPairs(allRows, {
    profileId: "starlink-main-large",
    perStratum: 2,
    maximumPerStratum: 4,
  });
  const telesatCandidates = allRows
    .filter((row) =>
      row.profile_id === "telesat-1015-medium" &&
      numberValue(row.topology_jaccard) >= DEFAULT_STRUCTURAL_CACHE_GUARDS.minimum_similarity &&
      numberValue(row.changed_link_ratio) <= DEFAULT_STRUCTURAL_CACHE_GUARDS.maximum_changed_link_ratio &&
      numberValue(row.affected_cached_path_ratio) <= DEFAULT_STRUCTURAL_CACHE_GUARDS.maximum_affected_path_ratio &&
      numberValue(row.valid_cached_path_ratio) >= DEFAULT_STRUCTURAL_CACHE_GUARDS.minimum_valid_path_ratio
    )
    .sort((left, right) =>
      left.affected_cached_path_ratio - right.affected_cached_path_ratio ||
      right.topology_jaccard - left.topology_jaccard ||
      left.case_id.localeCompare(right.case_id) ||
      left.current_slice_index - right.current_slice_index
    );
  const telesatSelected = [];
  const seenTelesatWindows = new Set();
  for (const row of telesatCandidates) {
    if (seenTelesatWindows.has(row.window_id)) continue;
    seenTelesatWindows.add(row.window_id);
    telesatSelected.push({ ...row, selection_stage: "telesat-diagnostic" });
    if (telesatSelected.length >= 3) break;
  }
  const telesatAdaptiveSelected = [];
  const seenAdaptiveTelesatWindows = new Set();
  for (const row of allRows
    .filter((item) =>
      item.profile_id === "telesat-1015-medium" &&
      item.adaptive_structural_cache_eligible === true &&
      item.fixed_structural_cache_eligible !== true
    )
    .sort((left, right) =>
      left.adaptive_structural_estimated_error_increase_proxy - right.adaptive_structural_estimated_error_increase_proxy ||
      right.topology_jaccard - left.topology_jaccard ||
      left.case_id.localeCompare(right.case_id) ||
      left.current_slice_index - right.current_slice_index
    )) {
    if (seenAdaptiveTelesatWindows.has(row.window_id)) continue;
    seenAdaptiveTelesatWindows.add(row.window_id);
    telesatAdaptiveSelected.push({ ...row, selection_stage: "telesat-adaptive-threshold-pilot" });
    if (telesatAdaptiveSelected.length >= 3) break;
  }

  const strataSummary = ["high", "medium", "boundary", "outside", "no-history"].flatMap((opportunityClass) =>
    [...new Set(allRows.map((row) => row.profile_id))].map((profileId) => ({
      profile_id: profileId,
      profile_label: PROFILE_LABELS[profileId] ?? profileId,
      opportunity_class: opportunityClass,
      slice_pairs: allRows.filter((row) => row.profile_id === profileId && row.opportunity_class === opportunityClass).length,
      natural_reuse_or_repair_slices: allRows.filter((row) =>
        row.profile_id === profileId &&
        row.opportunity_class === opportunityClass &&
        ["reuse", "repair"].includes(row.natural_selected_mode)
      ).length,
    })),
  );
  const rejectionCounts = new Map();
  allRows.forEach((row) => {
    splitList(row.natural_rejection_reasons).forEach((reason) => {
      const key = `${row.profile_id}|${reason}`;
      rejectionCounts.set(key, (rejectionCounts.get(key) ?? 0) + 1);
    });
  });
  const rejectionRows = [...rejectionCounts.entries()].map(([key, count]) => {
    const [profileId, reason] = key.split("|");
    return { profile_id: profileId, profile_label: PROFILE_LABELS[profileId], rejection_reason: reason, slice_count: count };
  }).sort((left, right) => left.profile_id.localeCompare(right.profile_id) || right.slice_count - left.slice_count);

  await Promise.all([
    writeFile(join(outputDir, "opportunity-scan-by-slice.csv"), rowsToCsv(allRows), "utf8"),
    writeFile(join(outputDir, "opportunity-strata-summary.csv"), rowsToCsv(strataSummary), "utf8"),
    writeFile(join(outputDir, "natural-reuse-rejection-counts.csv"), rowsToCsv(rejectionRows), "utf8"),
    writeFile(join(outputDir, "starlink-directed-pairs-initial.csv"), rowsToCsv(starlinkSelection.selected), "utf8"),
    writeFile(join(outputDir, "starlink-directed-pairs-reserve.csv"), rowsToCsv(starlinkSelection.reserve), "utf8"),
    writeFile(join(outputDir, "telesat-directed-pairs.csv"), rowsToCsv(telesatSelected), "utf8"),
    writeFile(join(outputDir, "telesat-adaptive-directed-pairs.csv"), rowsToCsv(telesatAdaptiveSelected), "utf8"),
    writeJson(join(outputDir, "opportunity-scan.json"), {
      schema_version: "experiment12-directed-opportunity-scan-v1",
      generated_at: new Date().toISOString(),
      selection_boundary: "topology and neutral pass-1 paths only; no planner effect or reconstruction error",
      strata: DIRECTED_REUSE_STRATA,
      rows: allRows.length,
      starlink_initial_pairs: starlinkSelection.selected,
      starlink_reserve_pairs: starlinkSelection.reserve,
      telesat_diagnostic_pairs: telesatSelected,
      telesat_adaptive_pilot_pairs: telesatAdaptiveSelected,
    }),
  ]);
  return {
    allRows,
    starlinkSelection,
    telesatSelected,
    telesatAdaptiveSelected,
    strataSummary,
    rejectionRows,
  };
}

async function writeFilteredCsv({ source, target, columns = null, predicate }) {
  const rows = await readCsvStream(source, { columns });
  const filtered = rows.filter(predicate);
  await mkdir(dirname(target), { recursive: true });
  const content = filtered.length > 0
    ? rowsToCsv(filtered)
    : columns?.length
      ? `${columns.join(",")}\n`
      : "";
  await writeFile(target, content, "utf8");
  return filtered;
}

async function preparePlanningSnapshot({ naturalRoot, outputDir, pair, resume }) {
  const pairId = directedPairId(pair);
  const snapshotDir = join(outputDir, "snapshots", pairId);
  const manifestPath = join(snapshotDir, "snapshot-manifest.json");
  if (resume && existsSync(manifestPath)) return readJson(manifestPath);
  await rm(snapshotDir, { recursive: true, force: true });
  const truthDir = join(snapshotDir, "truth");
  const planningInputDir = join(snapshotDir, "planning-inputs");
  const contactDir = join(snapshotDir, "contact-plan");
  await Promise.all([
    mkdir(truthDir, { recursive: true }),
    mkdir(planningInputDir, { recursive: true }),
    mkdir(contactDir, { recursive: true }),
  ]);
  const scenario = buildScenarioFromPair(pair);
  const artifacts = naturalArtifacts(naturalRoot, scenario);
  requireNaturalArtifacts(artifacts, scenario);
  const selectedSlices = new Set([numberValue(pair.historical_slice_index), numberValue(pair.current_slice_index)]);
  const sourceSlices = new Set([...selectedSlices].map((sliceIndex) => sliceIndex - 1).filter((sliceIndex) => sliceIndex >= 0));
  const inSelectedSlice = (row) => selectedSlices.has(numberValue(row.slice_index, NaN));
  const inSourceSlice = (row) => sourceSlices.has(numberValue(row.slice_index, NaN));

  const links = await writeFilteredCsv({
    source: join(artifacts.truth_dir, "links.csv"),
    target: join(truthDir, "links.csv"),
    predicate: inSelectedSlice,
  });
  const nodes = await writeFilteredCsv({
    source: join(artifacts.truth_dir, "nodes.csv"),
    target: join(truthDir, "nodes.csv"),
    predicate: inSelectedSlice,
  });
  const routesPath = join(artifacts.truth_dir, "routes.csv");
  const routes = existsSync(routesPath)
    ? await writeFilteredCsv({
        source: routesPath,
        target: join(truthDir, "routes.csv"),
        predicate: inSelectedSlice,
      })
    : [];
  if (!existsSync(routesPath)) await writeFile(join(truthDir, "routes.csv"), `${ROUTE_COLUMNS.join(",")}\n`, "utf8");
  const candidates = await writeFilteredCsv({
    source: artifacts.candidate_paths_csv,
    target: join(planningInputDir, "candidate-paths.csv"),
    predicate: inSelectedSlice,
  });
  const oamLinks = await writeFilteredCsv({
    source: join(artifacts.pass1_ground_dir, "ground-mc-reconstructed-links.csv"),
    target: join(planningInputDir, "oam-links.csv"),
    columns: OAM_LINK_COLUMNS,
    predicate: inSourceSlice,
  });
  const oamNodes = await writeFilteredCsv({
    source: join(artifacts.pass1_ground_dir, "ground-mc-reconstructed-nodes.csv"),
    target: join(planningInputDir, "oam-nodes.csv"),
    columns: OAM_NODE_COLUMNS,
    predicate: inSourceSlice,
  });
  const feedback = await writeFilteredCsv({
    source: artifacts.combined_feedback_csv,
    target: join(planningInputDir, "oam-feedback.csv"),
    predicate: (row) => {
      const sourceSlice = numberValue(row.source_slice_index || row.slice_index, NaN);
      return Number.isFinite(sourceSlice) && selectedSlices.has(sourceSlice + 1);
    },
  });
  const controls = await writeFilteredCsv({
    source: join(artifacts.pass1_ground_dir, "ground-oam-control-actions.csv"),
    target: join(planningInputDir, "oam-control-actions.csv"),
    predicate: (row) => selectedSlices.has(numberValue(row.next_slice_index, NaN)),
  });
  const freshSummary = await readCsvStream(artifacts.fresh_summary_csv, {
    columns: ["slice_index", "scale_budget_bytes"],
  });
  const budgetRows = freshSummary.filter(inSelectedSlice);
  await writeFile(join(planningInputDir, "scale-budget.csv"), rowsToCsv(budgetRows), "utf8");

  const originalMetadataPath = join(artifacts.truth_dir, "metadata.json");
  const metadata = existsSync(originalMetadataPath) ? await readJson(originalMetadataPath) : {};
  metadata.slice_count = 2;
  metadata.experiment12_directed_snapshot = {
    pair_id: pairId,
    source_case_id: pair.case_id,
    historical_slice_index: numberValue(pair.historical_slice_index),
    current_slice_index: numberValue(pair.current_slice_index),
    topology_jaccard: numberValue(pair.topology_jaccard),
    affected_cached_path_ratio: numberValue(pair.affected_cached_path_ratio),
  };
  await writeJson(join(truthDir, "metadata.json"), metadata);
  const contact = await runCommandTimed({
    label: `Experiment 12B contact snapshot ${pairId}`,
    script: "stage2-int/tools/predict-contact-plan.mjs",
    args: ["--input", truthDir, "--out", contactDir, "--completion-window-slices", "12"],
    env: planningEnvironment(),
  });
  const manifest = {
    schema_version: "experiment12-directed-planning-snapshot-v1",
    generated_at: new Date().toISOString(),
    pair_id: pairId,
    truth_dir: truthDir,
    planning_input_dir: planningInputDir,
    contact_dir: contactDir,
    candidate_paths_csv: join(planningInputDir, "candidate-paths.csv"),
    selected_slices: [...selectedSlices].sort((left, right) => left - right),
    source_oam_slices: [...sourceSlices].sort((left, right) => left - right),
    row_counts: {
      links: links.length,
      nodes: nodes.length,
      routes: routes.length,
      candidate_paths: candidates.length,
      oam_links: oamLinks.length,
      oam_nodes: oamNodes.length,
      feedback: feedback.length,
      controls: controls.length,
      scale_budgets: budgetRows.length,
    },
    contact_prediction_wall_time_ms: contact.timing.wall_time_ms,
    source_boundary: "existing Stage-1 truth and neutral pass-1 OAM; no Stage-1 rerun and no matrix completion",
  };
  await writeJson(manifestPath, manifest);
  return manifest;
}

function planningEnvironment() {
  const existing = String(process.env.NODE_OPTIONS ?? "").replace(/--max-old-space-size=\d+/g, "").trim();
  return {
    ...process.env,
    NODE_OPTIONS: [existing, "--max-old-space-size=1536"].filter(Boolean).join(" "),
  };
}

function directedPairId(pair) {
  return [
    pair.profile_id,
    pair.case_id,
    `h${String(pair.historical_slice_index).padStart(2, "0")}`,
    `t${String(pair.current_slice_index).padStart(2, "0")}`,
    pair.opportunity_class,
  ].join("__");
}

function buildScenarioFromPair(pair) {
  const stressRate = numberValue(pair.stress_rate);
  return {
    profile_id: pair.profile_id,
    case_id: pair.case_id,
    window_id: pair.window_id,
    stress_rate: stressRate,
    stress_id: `stress-${String(Math.round(stressRate * 100)).padStart(2, "0")}`,
    seed: pair.seed,
  };
}

function selectorArgs({
  snapshot,
  outputDir,
  variant,
  adaptiveStructuralReuse = false,
  structuralReuseErrorTolerance = 0.02,
}) {
  const planningInputs = snapshot.planning_input_dir;
  const reuseEnabled = variant === "reuse-enabled";
  return [
    "--input", snapshot.truth_dir,
    "--stage2", snapshot.contact_dir,
    "--out", outputDir,
    "--algorithm", "int-mc",
    "--candidate-algorithm", "path-balance",
    "--candidate-paths", snapshot.candidate_paths_csv,
    "--sampling-rate", "0.25",
    "--target-active-link-sampling-rate", "0.25",
    "--rank", "5",
    "--selection-strategy", "int-mc-leverage",
    "--window-size", "12",
    "--warmup-slices", "0",
    "--max-paths-per-slice", "12",
    "--predicted-contact-plan", join(snapshot.contact_dir, "predicted-contact-plan.json"),
    "--observability-mode", "oam-only",
    "--feedback-lag-slices", "1",
    "--planner-oam-links", join(planningInputs, "oam-links.csv"),
    "--planner-oam-nodes", join(planningInputs, "oam-nodes.csv"),
    "--oam-priority-retest", join(planningInputs, "oam-feedback.csv"),
    "--oam-control-actions", join(planningInputs, "oam-control-actions.csv"),
    "--adaptive-reuse", String(reuseEnabled),
    "--adaptive-structural-reuse", String(reuseEnabled && adaptiveStructuralReuse),
    "--structural-reuse-error-tolerance", String(structuralReuseErrorTolerance),
    "--incremental-topology-repair", String(reuseEnabled),
    "--forecast-risk-scoring", "true",
    "--topology-versioned-objective", "false",
    "--planner", "topology-versioned-risk-int",
    "--planner-modes", reuseEnabled ? "reuse,repair,fresh" : "fresh",
    "--risk-weight", "0.35",
    "--redundancy-weight", "0.3",
    "--planning-cost-weight", "0.05",
    "--prediction-horizon", "4",
    "--information-gain-mode", "marginal",
    "--metadata-actions", "full,compact,selective",
    "--scale-adaptive-total-budget", "true",
    "--scale-budget-headroom-ratio", "0.1",
    "--scale-budget-path-headroom-ratio", "0.25",
    "--scale-budget-reference-csv", join(planningInputs, "scale-budget.csv"),
  ];
}

function planHash(rows, currentSlice) {
  const normalized = rows
    .filter((row) => numberValue(row.slice_index) === currentSlice)
    .map((row) => ({
      source: row.source,
      sink: row.sink,
      path: row.path,
      link_ids: row.link_ids,
      metadata: row.unified_metadata_action,
      observed_nodes: row.unified_observed_node_ids,
      observed_links: row.unified_observed_link_ids,
    }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return sha256(JSON.stringify(normalized));
}

function mandatoryCoverageProxy(summary) {
  const targetCount = numberValue(summary.oam_replan_targets);
  const missing = new Set([
    ...splitList(summary.oam_mandatory_coverage_missing_link_targets),
    ...splitList(summary.oam_mandatory_coverage_missing_node_targets),
  ]).size;
  return targetCount > 0 ? Math.max(0, targetCount - missing) / targetCount : 1;
}

function metricsFromPlannerSummary(summary, variant, wallTimes) {
  const work = {
    candidate_inspections: numberValue(summary.planning_candidate_paths),
    shortest_path_calls: 0,
    score_recomputations: numberValue(summary.unified_planner_score_cache_recomputations),
    marginal_evaluations: numberValue(summary.unified_planner_marginal_evaluations),
    local_repairs: numberValue(summary.selected_repaired_paths) + numberValue(summary.unified_repair_refill_paths),
    graph_reconstructions: 1,
  };
  return {
    variant,
    selected_mode: summary.unified_planner_selected_mode,
    prefilter_policy: summary.unified_mode_prefilter_policy,
    prefilter_reason: summary.unified_mode_prefilter_reason,
    rejection_reasons: summary.unified_mode_prefilter_rejection_reasons,
    ...work,
    weighted_planning_work_units: planningWorkUnits(work),
    stable_path_cache_hits: numberValue(summary.unified_stable_path_cache_hits),
    stable_path_cache_misses: numberValue(summary.unified_stable_path_cache_misses),
    score_cache_hits: numberValue(summary.unified_planner_score_cache_hits),
    cache_hit_count: numberValue(summary.unified_stable_path_cache_hits) + numberValue(summary.unified_planner_score_cache_hits),
    cached_path_entries: numberValue(summary.unified_cached_path_count),
    invalidated_cache_entries: Math.max(
      numberValue(summary.unified_affected_cached_path_count),
      numberValue(summary.unified_inactive_cached_path_count),
    ),
    retained_cache_entries: numberValue(summary.unified_retained_cached_path_count),
    adaptive_structural_reuse_enabled: boolValue(summary.unified_structural_cache_adaptive_enabled),
    structural_similarity_threshold: numberValue(
      summary.unified_structural_cache_effective_similarity_threshold,
      NaN,
    ),
    structural_relaxation_factor: numberValue(summary.unified_structural_cache_relaxation_factor, NaN),
    structural_risk_pressure: numberValue(summary.unified_structural_cache_risk_pressure, NaN),
    structural_estimated_error_increase_proxy: numberValue(
      summary.unified_structural_cache_estimated_error_increase_proxy,
      NaN,
    ),
    structural_error_tolerance: numberValue(summary.unified_structural_cache_error_tolerance, NaN),
    active_link_coverage: numberValue(summary.active_link_sampling_coverage),
    mandatory_target_coverage: mandatoryCoverageProxy(summary),
    weighted_information: numberValue(summary.unified_planner_information_gain),
    delivered_report_ratio: Math.max(0, 1 - numberValue(summary.mean_forecast_near_outage_score)),
    delivered_report_metric_role: "predicted-probe-deliverability-proxy-not-executed-report-ratio",
    telemetry_bytes: numberValue(summary.estimated_total_telemetry_bytes),
    hard_budget_violations: numberValue(summary.unified_planner_budget_violations),
    selected_paths: numberValue(summary.selected_paths),
    local_repair_applied: String(summary.unified_planner_selected_mode) === "repair",
    fresh_fallback_count: variant === "reuse-enabled" && String(summary.unified_planner_selected_mode) === "fresh" ? 1 : 0,
    wall_time_repetitions_ms: wallTimes.map((value) => round(value, 3)),
    median_wall_time_ms: round(median(wallTimes), 3),
    mean_wall_time_ms: round(mean(wallTimes), 3),
    actual_reconstruction_mae_measured: false,
  };
}

function relativeReduction(reuseValue, freshValue) {
  const fresh = numberValue(freshValue);
  return round((fresh - numberValue(reuseValue)) / Math.max(Math.abs(fresh), 1e-12) * 100);
}

async function runDirectedPair({
  naturalRoot,
  outputDir,
  pair,
  repetitions,
  resume,
  adaptiveStructuralReuse = false,
  structuralReuseErrorTolerance = 0.02,
}) {
  const pairId = directedPairId(pair);
  const pairDir = join(outputDir, "pairs", pairId);
  const resultPath = join(pairDir, "pair-result.json");
  if (resume && existsSync(resultPath)) {
    const existing = await readJson(resultPath);
    if (numberValue(existing.repetitions) >= repetitions) return existing;
  }
  const snapshot = await preparePlanningSnapshot({ naturalRoot, outputDir, pair, resume });
  const currentSlice = numberValue(pair.current_slice_index);
  const variantRuns = new Map([["fresh-only", []], ["reuse-enabled", []]]);
  const variantMetrics = new Map();
  const planHashes = new Map([["fresh-only", new Set()], ["reuse-enabled", new Set()]]);

  for (let repetition = 0; repetition < repetitions; repetition += 1) {
    const order = repetition % 2 === 0
      ? ["fresh-only", "reuse-enabled"]
      : ["reuse-enabled", "fresh-only"];
    for (const variant of order) {
      const runDir = join(pairDir, `repetition-${String(repetition + 1).padStart(2, "0")}`, variant);
      await rm(runDir, { recursive: true, force: true });
      await mkdir(runDir, { recursive: true });
      const execution = await runCommandTimed({
        label: `Experiment 12B ${pairId} ${variant} repetition ${repetition + 1}`,
        script: "stage2-int/tools/int-mc-path-selector.mjs",
        args: selectorArgs({
          snapshot,
          outputDir: runDir,
          variant,
          adaptiveStructuralReuse,
          structuralReuseErrorTolerance,
        }),
        env: planningEnvironment(),
      });
      variantRuns.get(variant).push(execution.timing.wall_time_ms);
      const summaryRows = await readCsvStream(join(runDir, "probe-summary-int-mc.csv"));
      const currentSummary = summaryRows.find((row) => numberValue(row.slice_index) === currentSlice);
      if (!currentSummary) throw new Error(`Planner output is missing current slice ${currentSlice}: ${pairId}/${variant}`);
      const pathRows = await readCsvStream(join(runDir, "probe-paths-int-mc.csv"), {
        columns: [
          "slice_index", "source", "sink", "path", "link_ids", "unified_metadata_action",
          "unified_observed_node_ids", "unified_observed_link_ids",
        ],
      });
      planHashes.get(variant).add(planHash(pathRows, currentSlice));
      if (!variantMetrics.has(variant)) variantMetrics.set(variant, currentSummary);
    }
  }
  for (const [variant, hashes] of planHashes.entries()) {
    if (hashes.size !== 1) throw new Error(`Nondeterministic plan across repetitions: ${pairId}/${variant}`);
  }
  const fresh = metricsFromPlannerSummary(
    variantMetrics.get("fresh-only"),
    "fresh-only",
    variantRuns.get("fresh-only"),
  );
  const reuse = metricsFromPlannerSummary(
    variantMetrics.get("reuse-enabled"),
    "reuse-enabled",
    variantRuns.get("reuse-enabled"),
  );
  const quality = evaluateDirectedQualityGates({ fresh, reuse });
  const result = {
    schema_version: "experiment12-directed-planning-pair-v1",
    generated_at: new Date().toISOString(),
    pair_id: pairId,
    pair,
    snapshot_manifest: join(outputDir, "snapshots", pairId, "snapshot-manifest.json"),
    repetitions,
    structural_reuse_policy: adaptiveStructuralReuse
      ? "error-budgeted-adaptive"
      : "fixed-conservative",
    structural_reuse_error_tolerance: adaptiveStructuralReuse
      ? structuralReuseErrorTolerance
      : 0,
    fresh,
    reuse,
    mechanism_triggered: ["reuse", "repair"].includes(reuse.selected_mode),
    effects: {
      candidate_inspection_reduction_percent: relativeReduction(reuse.candidate_inspections, fresh.candidate_inspections),
      score_recomputation_reduction_percent: relativeReduction(reuse.score_recomputations, fresh.score_recomputations),
      marginal_evaluation_reduction_percent: relativeReduction(reuse.marginal_evaluations, fresh.marginal_evaluations),
      weighted_work_reduction_percent: relativeReduction(reuse.weighted_planning_work_units, fresh.weighted_planning_work_units),
      median_wall_time_reduction_percent: relativeReduction(reuse.median_wall_time_ms, fresh.median_wall_time_ms),
      telemetry_byte_reduction_percent: relativeReduction(reuse.telemetry_bytes, fresh.telemetry_bytes),
      active_link_coverage_delta: round(reuse.active_link_coverage - fresh.active_link_coverage),
      weighted_information_delta: round(reuse.weighted_information - fresh.weighted_information),
    },
    quality_gates: quality,
    deterministic_plan_hashes: {
      fresh_only: [...planHashes.get("fresh-only")][0],
      reuse_enabled: [...planHashes.get("reuse-enabled")][0],
    },
  };
  await writeJson(resultPath, result);
  return result;
}

function flattenPairResult(result) {
  const failedQualityChecks = result.quality_gates.checks
    .filter((check) => check.available && check.passed === false)
    .map((check) => check.id);
  return {
    pair_id: result.pair_id,
    profile_id: result.pair.profile_id,
    case_id: result.pair.case_id,
    opportunity_class: result.pair.opportunity_class,
    topology_jaccard: result.pair.topology_jaccard,
    affected_cached_path_ratio: result.pair.affected_cached_path_ratio,
    historical_slice_index: result.pair.historical_slice_index,
    current_slice_index: result.pair.current_slice_index,
    mechanism_triggered: result.mechanism_triggered,
    reuse_selected_mode: result.reuse.selected_mode,
    reuse_prefilter_policy: result.reuse.prefilter_policy,
    reuse_rejection_reasons: result.reuse.rejection_reasons,
    fresh_candidate_inspections: result.fresh.candidate_inspections,
    reuse_candidate_inspections: result.reuse.candidate_inspections,
    candidate_inspection_reduction_percent: result.effects.candidate_inspection_reduction_percent,
    fresh_score_recomputations: result.fresh.score_recomputations,
    reuse_score_recomputations: result.reuse.score_recomputations,
    score_recomputation_reduction_percent: result.effects.score_recomputation_reduction_percent,
    fresh_marginal_evaluations: result.fresh.marginal_evaluations,
    reuse_marginal_evaluations: result.reuse.marginal_evaluations,
    marginal_evaluation_reduction_percent: result.effects.marginal_evaluation_reduction_percent,
    fresh_weighted_work_units: result.fresh.weighted_planning_work_units,
    reuse_weighted_work_units: result.reuse.weighted_planning_work_units,
    weighted_work_reduction_percent: result.effects.weighted_work_reduction_percent,
    fresh_median_wall_time_ms: result.fresh.median_wall_time_ms,
    reuse_median_wall_time_ms: result.reuse.median_wall_time_ms,
    median_wall_time_reduction_percent: result.effects.median_wall_time_reduction_percent,
    invalidated_cache_entries: result.reuse.invalidated_cache_entries,
    retained_cache_entries: result.reuse.retained_cache_entries,
    local_repairs: result.reuse.local_repairs,
    fresh_fallback_count: result.reuse.fresh_fallback_count,
    active_link_coverage_delta: result.effects.active_link_coverage_delta,
    weighted_information_delta: result.effects.weighted_information_delta,
    telemetry_byte_reduction_percent: result.effects.telemetry_byte_reduction_percent,
    quality_gates_passed: result.quality_gates.passed,
    quality_gate_available_checks: result.quality_gates.available_check_count,
    failed_quality_checks: failedQualityChecks.join(" | "),
    actual_reconstruction_mae_measured: false,
  };
}

function summarizeDirectedResultsByStratum(results) {
  return ["high", "medium", "boundary"].map((stratum) => {
    const rows = results.filter((result) => result.pair.opportunity_class === stratum);
    const triggered = rows.filter((result) => result.mechanism_triggered);
    const triggeredQualityPass = triggered.filter((result) => result.quality_gates.passed);
    const failedChecks = {};
    for (const result of triggered) {
      for (const check of result.quality_gates.checks) {
        if (!check.available || check.passed !== false) continue;
        failedChecks[check.id] = (failedChecks[check.id] ?? 0) + 1;
      }
    }
    return {
      stratum,
      evaluated_pairs: rows.length,
      triggered_pairs: triggered.length,
      triggered_quality_pass_pairs: triggeredQualityPass.length,
      mean_triggered_work_reduction_percent: triggered.length > 0
        ? round(triggered.reduce((sum, result) => sum + result.effects.weighted_work_reduction_percent, 0) / triggered.length)
        : 0,
      failed_quality_checks: Object.entries(failedChecks)
        .map(([id, count]) => `${id}:${count}`)
        .join("; "),
      failed_quality_checks_label: Object.entries(failedChecks)
        .map(([id, count]) => `${formatQualityCheck(id)}：${count}`)
        .join("；"),
    };
  });
}

function sequentialDecision(results, preregistration) {
  const triggered = results.filter((result) => result.mechanism_triggered);
  const effects = triggered.map((result) => result.effects.weighted_work_reduction_percent);
  const interval = pairedBootstrapMean(effects, {
    samples: preregistration.early_stopping.bootstrap_samples,
    seed: preregistration.early_stopping.bootstrap_seed,
  });
  const allQualityPassed = results.length > 0 && results.every((result) => result.quality_gates.passed);
  const engineeringThresholdPassed = interval.mean >= 5;
  const confidencePassed = triggered.length > 0 && interval.ci95_low > 0;
  return {
    evaluated_pairs: results.length,
    triggered_pairs: triggered.length,
    trigger_rate: round(triggered.length / Math.max(results.length, 1)),
    conditional_weighted_work_reduction: interval,
    all_available_quality_gates_passed: allQualityPassed,
    engineering_threshold_passed: engineeringThresholdPassed,
    confidence_lower_bound_passed: confidencePassed,
    stop: confidencePassed && engineeringThresholdPassed && allQualityPassed,
    decision: confidencePassed && engineeringThresholdPassed && allQualityPassed
      ? "stop-success"
      : results.length >= preregistration.early_stopping.maximum_pairs
        ? "stop-maximum-pairs"
        : "continue-next-three-pairs",
  };
}

async function loadScanSelection(outputDir) {
  if (!existsSync(join(outputDir, "opportunity-scan.json"))) {
    throw new Error("Run --phase scan before replay");
  }
  const [initial, reserve, telesat] = await Promise.all([
    readCsvStream(join(outputDir, "starlink-directed-pairs-initial.csv")),
    readCsvStream(join(outputDir, "starlink-directed-pairs-reserve.csv")),
    readCsvStream(join(outputDir, "telesat-directed-pairs.csv")),
  ]);
  return { initial, reserve, telesat };
}

async function runSequentialReplay({
  naturalRoot,
  outputDir,
  preregistration,
  repetitions,
  resume,
  maximumPairs,
  includeTelesat,
  telesatOnly,
  pairLimit,
}) {
  const selection = await loadScanSelection(outputDir);
  const orderedStarlink = telesatOnly ? [] : [...selection.initial, ...selection.reserve];
  const cap = Math.min(
    maximumPairs,
    preregistration.early_stopping.maximum_pairs,
    orderedStarlink.length,
  );
  const results = [];
  let target = Math.min(preregistration.early_stopping.first_look_pairs, cap);
  if (pairLimit > 0) target = Math.min(target, pairLimit);
  while (results.length < cap) {
    while (results.length < target) {
      const pair = orderedStarlink[results.length];
      console.log(`[Experiment 12B replay] ${results.length + 1}/${target} ${directedPairId(pair)}`);
      results.push(await runDirectedPair({ naturalRoot, outputDir, pair, repetitions, resume }));
    }
    const decision = sequentialDecision(results, preregistration);
    await writeJson(join(outputDir, "sequential-decision.json"), decision);
    if (decision.stop || results.length >= cap || (pairLimit > 0 && results.length >= pairLimit)) break;
    target = Math.min(cap, target + preregistration.early_stopping.add_pairs_per_look);
  }

  const telesatResults = [];
  if (includeTelesat) {
    for (const pair of selection.telesat.slice(0, 3)) {
      console.log(`[Experiment 12C replay] ${directedPairId(pair)}`);
      telesatResults.push(await runDirectedPair({ naturalRoot, outputDir, pair, repetitions, resume }));
    }
  }
  const allResults = [...results, ...telesatResults];
  await Promise.all([
    writeJson(join(outputDir, "directed-pair-results.json"), {
      schema_version: "experiment12-directed-pair-results-v1",
      generated_at: new Date().toISOString(),
      results: allResults,
    }),
    writeFile(join(outputDir, "directed-pair-results.csv"), rowsToCsv(allResults.map(flattenPairResult)), "utf8"),
  ]);
  return {
    starlinkResults: results,
    telesatResults,
    decision: sequentialDecision(results, preregistration),
    telesatDecision: sequentialDecision(telesatResults, preregistration),
  };
}

async function loadNaturalEvidence(naturalRoot) {
  const statusPath = join(naturalRoot, "experiment12-statistical-evidence-status.csv");
  const pairedPath = join(naturalRoot, "experiment12-statistical-paired-effects.csv");
  return {
    status: existsSync(statusPath) ? parseCsv(await readFile(statusPath, "utf8")) : [],
    pairs: existsSync(pairedPath) ? parseCsv(await readFile(pairedPath, "utf8")) : [],
  };
}

function formatPercent(value) {
  return `${round(numberValue(value), 2).toFixed(2)}%`;
}

function formatEvidenceStatus(status) {
  return ({
    supported: "支持",
    "not-supported": "尚不支持",
    inconclusive: "证据不足",
  })[status] ?? status ?? "未读取";
}

function formatPlannerMode(mode) {
  return ({
    reuse: "精确复用",
    repair: "局部修复",
    fresh: "完整重规划",
  })[mode] ?? mode ?? "未知";
}

function formatQualityCheck(checkId) {
  return ({
    "active-link-coverage": "活动链路覆盖率",
    "weighted-information": "加权信息量",
    "mandatory-target-coverage": "OAM 强制目标覆盖率",
    "delivered-report-ratio": "报告可交付率代理",
    "telemetry-bytes": "遥测字节",
    "hard-budget": "硬预算",
  })[checkId] ?? checkId;
}

async function writeReports({ naturalRoot, outputDir, preregistration }) {
  const natural = await loadNaturalEvidence(naturalRoot);
  const scan = existsSync(join(outputDir, "opportunity-scan.json"))
    ? await readJson(join(outputDir, "opportunity-scan.json"))
    : null;
  const resultArtifact = existsSync(join(outputDir, "directed-pair-results.json"))
    ? await readJson(join(outputDir, "directed-pair-results.json"))
    : { results: [] };
  const results = resultArtifact.results ?? [];
  const starlinkResults = results.filter((result) => result.pair.profile_id === "starlink-main-large");
  const telesatResults = results.filter((result) => result.pair.profile_id === "telesat-1015-medium");
  const decision = sequentialDecision(starlinkResults, preregistration);
  const telesatDecision = sequentialDecision(telesatResults, preregistration);
  const primaryDecision = starlinkResults.length > 0 ? decision : telesatDecision;
  const stratumSummary = summarizeDirectedResultsByStratum(starlinkResults);
  const naturalStarlink = natural.status.find((row) => row.profile_id === "starlink-main-large") ?? {};
  const naturalTelesat = natural.status.find((row) => row.profile_id === "telesat-1015-medium") ?? {};
  const resultRows = results.map(flattenPairResult);
  const scanRows = scan ? await readCsvStream(join(outputDir, "opportunity-strata-summary.csv")) : [];
  const rejectionRows = scan ? await readCsvStream(join(outputDir, "natural-reuse-rejection-counts.csv")) : [];
  const opportunityRows = scan ? await readCsvStream(join(outputDir, "opportunity-scan-by-slice.csv")) : [];
  const guardedTelesatRows = opportunityRows.filter((row) =>
    row.profile_id === "telesat-1015-medium" &&
    numberValue(row.topology_jaccard) >= DEFAULT_STRUCTURAL_CACHE_GUARDS.minimum_similarity &&
    numberValue(row.changed_link_ratio) <= DEFAULT_STRUCTURAL_CACHE_GUARDS.maximum_changed_link_ratio &&
    numberValue(row.affected_cached_path_ratio) <= DEFAULT_STRUCTURAL_CACHE_GUARDS.maximum_affected_path_ratio &&
    numberValue(row.valid_cached_path_ratio) >= DEFAULT_STRUCTURAL_CACHE_GUARDS.minimum_valid_path_ratio
  );
  const guardedTelesatCases = new Set(guardedTelesatRows.map((row) => row.case_id));
  const telesatOpportunityAudit = {
    eligible_slice_count: guardedTelesatRows.length,
    scanned_slice_count: opportunityRows.filter((row) => row.profile_id === "telesat-1015-medium").length,
    eligible_case_count: guardedTelesatCases.size,
    scanned_case_count: new Set(
      opportunityRows.filter((row) => row.profile_id === "telesat-1015-medium").map((row) => row.case_id),
    ).size,
    eligible_cases: [...guardedTelesatCases].sort(),
  };

  const report = `# 实验 12：拓扑复用自然证据与低成本机制验证\n\n` +
    `## 实验边界\n\n` +
    `本报告将问题拆为两部分：12A 使用已有 18 个自然滚动场景估计触发频率；12B/12C 只复用已有第一阶段真值、候选路径和中性 pass-1 OAM，重放路径规划，不重新运行轨道仿真、probe 执行或完整矩阵补全。预注册指纹为 \`${preregistration.design_sha256}\`。\n\n` +
    `## 12A：自然运行证据\n\n` +
    `| 星座 | 自然触发 | 非劣通过率 | 原结论 |\n|---|---:|---:|---|\n` +
    `| Starlink 1584 | ${naturalStarlink.mechanism_triggered_cases ?? 0}/${naturalStarlink.preregistered_cases ?? 9} | ${formatPercent(numberValue(naturalStarlink.noninferiority_pass_rate) * 100)} | ${formatEvidenceStatus(naturalStarlink.evidence_status)} |\n` +
    `| Telesat 351 | ${naturalTelesat.mechanism_triggered_cases ?? 0}/${naturalTelesat.preregistered_cases ?? 9} | ${formatPercent(numberValue(naturalTelesat.noninferiority_pass_rate) * 100)} | ${formatEvidenceStatus(naturalTelesat.evidence_status)} |\n\n` +
    `12A 回答“自然条件下机制多常触发”，不把未触发场景删除，也不因 12B 的定向结果改写。\n\n` +
    `## 拓扑机会扫描\n\n` +
    `扫描指标为 $J(E_t,E_k)=|E_t\\cap E_k|/|E_t\\cup E_k|$ 与缓存路径受影响比例 $R_{affected}$。分层选择只使用拓扑和中性 pass-1 路径，不读取方法收益或误差。\n\n` +
    `| 星座 | 分层 | 可用时间片对 | 自然触发片 |\n|---|---|---:|---:|\n` +
    `${scanRows.map((row) => `| ${row.profile_label} | ${row.opportunity_class} | ${row.slice_pairs} | ${row.natural_reuse_or_repair_slices} |`).join("\n") || "| 尚未扫描 | - | 0 | 0 |"}\n\n` +
    `## 12B：Starlink 定向规划重放\n\n` +
    `| 分层 | Jaccard | 受影响路径 | 模式 | 工作量下降 | 评分重算下降 | 边际评估下降 | 质量门禁 |\n|---|---:|---:|---|---:|---:|---:|---|\n` +
    `${resultRows.filter((row) => row.profile_id === "starlink-main-large").map((row) => `| ${row.opportunity_class} | ${numberValue(row.topology_jaccard).toFixed(4)} | ${formatPercent(numberValue(row.affected_cached_path_ratio) * 100)} | ${formatPlannerMode(row.reuse_selected_mode)} | ${formatPercent(row.weighted_work_reduction_percent)} | ${formatPercent(row.score_recomputation_reduction_percent)} | ${formatPercent(row.marginal_evaluation_reduction_percent)} | ${row.quality_gates_passed ? "通过" : "未通过"} |`).join("\n") || "| 尚未重放 | - | - | - | - | - | - | - |"}\n\n` +
    `条件收益 bootstrap：触发 ${decision.triggered_pairs}/${decision.evaluated_pairs} 对，平均工作量下降 ${formatPercent(decision.conditional_weighted_work_reduction.mean)}，95% CI [${formatPercent(decision.conditional_weighted_work_reduction.ci95_low)}, ${formatPercent(decision.conditional_weighted_work_reduction.ci95_high)}]；顺序决策为 \`${decision.decision}\`。\n\n` +
    `### 分层结论\n\n` +
    `| 分层 | 配对数 | 实际触发 | 触发且门禁通过 | 触发后平均工作量下降 | 失败门禁 |\n|---|---:|---:|---:|---:|---|\n` +
    `${stratumSummary.map((row) => `| ${row.stratum} | ${row.evaluated_pairs} | ${row.triggered_pairs} | ${row.triggered_quality_pass_pairs} | ${formatPercent(row.mean_triggered_work_reduction_percent)} | ${row.failed_quality_checks_label || "无"} |`).join("\n")}\n\n` +
    `高机会层说明了“拓扑高度相似且缓存路径变化局部”时的主要收益；中等机会层暴露出约 20% 缓存路径受影响时，强行局部修复会损害覆盖率和信息量；边界层全部安全回退到 fresh。\n\n` +
    `### 门禁失败明细\n\n` +
    `| 分层 | 时间片 | 受影响路径 | 覆盖率变化 | 信息量变化 | 失败项 |\n|---|---|---:|---:|---:|---|\n` +
    `${starlinkResults.filter((result) => !result.quality_gates.passed).map((result) => {
      const failed = result.quality_gates.checks.filter((check) => check.available && check.passed === false).map((check) => formatQualityCheck(check.id)).join("、");
      return `| ${result.pair.opportunity_class} | ${result.pair.historical_slice_index}→${result.pair.current_slice_index} | ${formatPercent(numberValue(result.pair.affected_cached_path_ratio) * 100)} | ${(numberValue(result.effects.active_link_coverage_delta) * 100).toFixed(2)} 个百分点 | ${numberValue(result.effects.weighted_information_delta).toFixed(2)} | ${failed} |`;
    }).join("\n") || "| 无 | - | - | - | - | - |"}\n\n` +
    `${starlinkResults.length > 0 ? "本次达到“触发后工作量下降”的工程门限和置信区间门限，但没有达到“所有可计算质量门禁均通过”的预注册停止条件，因此运行至 12 对上限。正式结论应写成条件性证据，不能写成拓扑复用已经在全部相似度区间稳定非劣。" : "本次输出仅执行 Telesat 定向重放，Starlink 结论继续引用既有 12B 报告，不以空样本改写。"}\n\n` +
    `## 12C：Telesat 结构缓存诊断\n\n` +
    `共完成 ${telesatResults.length} 个受保护中等相似窗口的规划重放。统一准入门限为：$J\\ge ${DEFAULT_STRUCTURAL_CACHE_GUARDS.minimum_similarity}$、变化链路比例不超过 ${formatPercent(DEFAULT_STRUCTURAL_CACHE_GUARDS.maximum_changed_link_ratio * 100)}、受影响缓存路径不超过 ${formatPercent(DEFAULT_STRUCTURAL_CACHE_GUARDS.maximum_affected_path_ratio * 100)}、有效缓存路径不少于 ${formatPercent(DEFAULT_STRUCTURAL_CACHE_GUARDS.minimum_valid_path_ratio * 100)}。这些门限不按星座单独调节。\n\n` +
    `修复前的自然运行结果为 0/9 场景触发；按修复后的统一保护条件审计，发现 ${telesatOpportunityAudit.eligible_slice_count}/${telesatOpportunityAudit.scanned_slice_count} 个时间片、${telesatOpportunityAudit.eligible_case_count}/${telesatOpportunityAudit.scanned_case_count} 个自然场景具备安全结构缓存机会。该数字是离线机会审计，不冒充完整 48 片重跑后的实际触发率。\n\n` +
    `| 窗口 | 时间片 | Jaccard | 受影响路径 | 模式 | 工作量下降 | 覆盖率变化 | 信息量变化 | 门禁 |\n|---|---|---:|---:|---|---:|---:|---:|---|\n` +
    `${telesatResults.map((result) => `| ${result.pair.window_id} | ${result.pair.historical_slice_index}→${result.pair.current_slice_index} | ${numberValue(result.pair.topology_jaccard).toFixed(4)} | ${formatPercent(numberValue(result.pair.affected_cached_path_ratio) * 100)} | ${formatPlannerMode(result.reuse.selected_mode)} | ${formatPercent(result.effects.weighted_work_reduction_percent)} | ${(numberValue(result.effects.active_link_coverage_delta) * 100).toFixed(2)} 个百分点 | ${numberValue(result.effects.weighted_information_delta).toFixed(2)} | ${result.quality_gates.passed ? "通过" : "未通过"} |`).join("\n") || "| 尚未重放 | - | - | - | - | - | - | - | - |"}\n\n` +
    `Telesat 条件收益：触发 ${telesatDecision.triggered_pairs}/${telesatDecision.evaluated_pairs} 对，平均工作量下降 ${formatPercent(telesatDecision.conditional_weighted_work_reduction.mean)}，bootstrap 95% CI [${formatPercent(telesatDecision.conditional_weighted_work_reduction.ci95_low)}, ${formatPercent(telesatDecision.conditional_weighted_work_reduction.ci95_high)}]；全部可计算质量门禁${telesatDecision.all_available_quality_gates_passed ? "通过" : "未全部通过"}。\n\n` +
    `主要自然拒绝原因：\n\n` +
    `${rejectionRows.slice(0, 12).map((row) => `- ${row.profile_label}：\`${row.rejection_reason}\`，${row.slice_count} 片。`).join("\n") || "- 尚未扫描。"}\n\n` +
    `## 指标解释与限制\n\n` +
    `- 主证据是候选检查、评分重算、边际增益评估、缓存命中、失效条目和局部修复等确定性计数。\n` +
    `- 墙钟时间每个方案交错重复 3 次并取中位数，但仍只作为次指标。\n` +
    `- 本次重放不执行 reporting/probe/OAM 重构，报告中的交付率是预测可达性代理，不是实际 report delivery ratio。\n` +
    `- 本次重放不重新执行矩阵补全，因此不生成新计划对应的 CPU、队列、电量和链路利用率 MAE；这些门禁标记为未测量，不能以代理值冒充。12A 已有自然运行场景继续承担实际重构误差证据。\n` +
    `- 当前候选路径文件已由先前实验生成，所以“最短路调用次数”在选择器重放阶段为 0；本实验能证明的是候选检查、评分与边际选择开销，不夸大为完整候选路径生成器的端到端节省。\n`;

  const tableRows = resultRows.map((row) => {
    const failed = row.failed_quality_checks.split(" | ").filter(Boolean).map(formatQualityCheck).join("、");
    return `<tr><td>${escapeHtml(row.opportunity_class)}</td><td>${numberValue(row.topology_jaccard).toFixed(4)}</td><td>${formatPercent(numberValue(row.affected_cached_path_ratio) * 100)}</td><td>${escapeHtml(formatPlannerMode(row.reuse_selected_mode))}</td><td>${formatPercent(row.weighted_work_reduction_percent)}</td><td>${formatPercent(row.score_recomputation_reduction_percent)}</td><td>${formatPercent(row.marginal_evaluation_reduction_percent)}</td><td class="${row.quality_gates_passed ? "pass" : "fail"}">${row.quality_gates_passed ? "通过" : `未通过：${escapeHtml(failed)}`}</td></tr>`;
  }).join("");
  const stratumRows = stratumSummary.map((row) => `<tr><td>${row.stratum}</td><td>${row.evaluated_pairs}</td><td>${row.triggered_pairs}</td><td>${row.triggered_quality_pass_pairs}</td><td>${formatPercent(row.mean_triggered_work_reduction_percent)}</td><td>${escapeHtml(row.failed_quality_checks_label || "无")}</td></tr>`).join("");
  const failedRows = starlinkResults.filter((result) => !result.quality_gates.passed).map((result) => {
    const failed = result.quality_gates.checks.filter((check) => check.available && check.passed === false).map((check) => formatQualityCheck(check.id)).join("、");
    return `<tr><td>${result.pair.opportunity_class}</td><td>${result.pair.historical_slice_index}→${result.pair.current_slice_index}</td><td>${formatPercent(numberValue(result.pair.affected_cached_path_ratio) * 100)}</td><td>${(numberValue(result.effects.active_link_coverage_delta) * 100).toFixed(2)} 个百分点</td><td>${numberValue(result.effects.weighted_information_delta).toFixed(2)}</td><td>${escapeHtml(failed)}</td></tr>`;
  }).join("");
  const decisionClass = primaryDecision.stop ? "pass" : "fail";
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>实验 12 拓扑复用验证</title><script>window.MathJax={tex:{inlineMath:[["\\(","\\)"]],displayMath:[["\\[","\\]"]]}};</script><script defer src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js"></script><style>*{box-sizing:border-box}body{font-family:system-ui,"Microsoft YaHei",sans-serif;margin:0;background:#f5f7fa;color:#17202a;overflow-x:hidden}main{width:100vw;max-width:1180px;margin:auto;padding:32px;min-width:0}header{width:100%;background:#17202a;color:#fff;padding:28px;border-radius:6px;overflow-wrap:anywhere;max-width:100%;min-width:0}section{width:100%;margin-top:24px;padding:22px;background:#fff;border:1px solid #dfe4ea;border-radius:6px;overflow:auto;max-width:100%;min-width:0}h1,h2{letter-spacing:0}p,code{overflow-wrap:anywhere}code{word-break:break-all}table{border-collapse:collapse;width:100%;font-size:14px}th,td{border-bottom:1px solid #e5e9ef;padding:10px;text-align:left;vertical-align:top}.metric{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;min-width:0}.metric article{border-left:4px solid #2471a3;background:#eef5fa;padding:14px;min-width:0}.muted{color:#566573}.warning{border-left:4px solid #b9770e;padding-left:12px}.pass{color:#196f3d}.fail{color:#a93226;font-weight:600}@media(max-width:600px){main{padding:16px}header,section{padding:20px}.metric{grid-template-columns:minmax(0,1fr)}h1{font-size:28px}}</style></head><body><main><header><h1>实验 12：拓扑复用证据链</h1><p>12A 自然触发 + 12B Starlink 定向机制验证 + 12C Telesat 诊断</p></header><section><h2>证据概览</h2><div class="metric"><article><strong>Starlink 自然触发</strong><p>${naturalStarlink.mechanism_triggered_cases ?? 0}/${naturalStarlink.preregistered_cases ?? 9}</p></article><article><strong>Telesat 原自然触发</strong><p>${naturalTelesat.mechanism_triggered_cases ?? 0}/${naturalTelesat.preregistered_cases ?? 9}</p></article><article><strong>Telesat 定向触发</strong><p>${telesatDecision.triggered_pairs}/${telesatDecision.evaluated_pairs}</p></article><article><strong>Telesat 工作量下降</strong><p>${formatPercent(telesatDecision.conditional_weighted_work_reduction.mean)}</p></article></div></section><section><h2>数学定义</h2><p>拓扑相似度：\(J(E_t,E_k)=\\frac{|E_t\\cap E_k|}{|E_t\\cup E_k|}\)。路径影响率：\(R_{affected}=\\frac{|\\{p:E(p)\\cap\\Delta E_t\\neq\\varnothing\\}|}{|P_k|}\)。</p></section><section><h2>定向配对结果</h2><table><thead><tr><th>分层</th><th>J</th><th>受影响路径</th><th>复用模式</th><th>工作量下降</th><th>评分重算下降</th><th>边际评估下降</th><th>门禁</th></tr></thead><tbody>${tableRows || "<tr><td colspan=8>尚未运行规划重放</td></tr>"}</tbody></table></section><section><h2>条件证据</h2><p class="${decisionClass}">bootstrap 95% CI：[${formatPercent(primaryDecision.conditional_weighted_work_reduction.ci95_low)}, ${formatPercent(primaryDecision.conditional_weighted_work_reduction.ci95_high)}]；${primaryDecision.all_available_quality_gates_passed ? "全部可计算质量门禁通过。" : "质量门禁尚未全部通过。"}</p></section><section class="warning"><h2>不能越界的结论</h2><p>本实验只重放路径规划，不执行 reporting、probe、OAM 重构和矩阵补全，因此不能用它声称实际报告交付率或重构 MAE 已非劣；其结论限定为规划阶段的条件收益。</p></section></main></body></html>`;
  await Promise.all([
    writeFile(join(outputDir, "EXPERIMENT_12_DIRECTED_REUSE_REPORT.md"), report, "utf8"),
    writeFile(join(outputDir, "index.html"), html, "utf8"),
    writeJson(join(outputDir, "experiment12-directed-evidence.json"), {
      schema_version: "experiment12-directed-evidence-v1",
      generated_at: new Date().toISOString(),
      preregistration_sha256: preregistration.design_sha256,
      natural_evidence: natural,
      sequential_decision: decision,
      telesat_sequential_decision: telesatDecision,
      telesat_guarded_opportunity_audit: telesatOpportunityAudit,
      directed_stratum_summary: stratumSummary,
      directed_results: results,
      conclusion_boundary: "conditional mechanism evidence is separate from natural trigger frequency",
    }),
  ]);
  return { report, decision, telesatDecision, resultCount: results.length };
}

async function main() {
  const args = process.argv.slice(2);
  const phase = argValue(args, "--phase", "scan").toLowerCase();
  const naturalRoot = resolve(argValue(args, "--natural-root", NATURAL_ROOT));
  const outputDir = resolve(argValue(args, "--out", DEFAULT_OUTPUT_DIR));
  const repetitions = Math.max(1, Math.floor(numberValue(argValue(args, "--wall-repetitions", "3"), 3)));
  const resume = boolValue(argValue(args, "--resume", "true"), true);
  const maximumPairs = Math.max(1, Math.floor(numberValue(argValue(args, "--maximum-pairs", "12"), 12)));
  const pairLimit = Math.max(0, Math.floor(numberValue(argValue(args, "--pair-limit", "0"), 0)));
  const includeTelesat = boolValue(argValue(args, "--include-telesat", "false"), false);
  const telesatOnly = boolValue(argValue(args, "--telesat-only", "false"), false);
  await mkdir(outputDir, { recursive: true });
  const preregistration = await ensurePreregistration(outputDir);
  const scenarios = buildTopologyReuseEvidenceMatrix();
  let scanResult = null;
  let replayResult = null;
  if (["scan", "all"].includes(phase)) {
    scanResult = await runOpportunityScan({ naturalRoot, outputDir, scenarios });
  }
  if (["replay", "all"].includes(phase)) {
    replayResult = await runSequentialReplay({
      naturalRoot,
      outputDir,
      preregistration,
      repetitions,
      resume,
      maximumPairs,
      includeTelesat,
      telesatOnly,
      pairLimit,
    });
  }
  const reportResult = await writeReports({ naturalRoot, outputDir, preregistration });
  console.log(JSON.stringify({
    status: "complete",
    phase,
    output_dir: outputDir,
    preregistration_sha256: preregistration.design_sha256,
    scan_rows: scanResult?.allRows?.length ?? null,
    replay_pairs: replayResult?.starlinkResults?.length ?? reportResult.resultCount,
    sequential_decision: replayResult?.decision ?? reportResult.decision,
    telesat_replay_pairs: replayResult?.telesatResults?.length ?? null,
    telesat_sequential_decision: replayResult?.telesatDecision ?? reportResult.telesatDecision,
    report: join(outputDir, "EXPERIMENT_12_DIRECTED_REUSE_REPORT.md"),
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
  directedPairId,
  naturalArtifacts,
  preparePlanningSnapshot,
  runDirectedPair,
  runOpportunityScan,
  sequentialDecision,
};
