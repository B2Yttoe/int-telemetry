import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  PROFILE_CATALOG,
  canonicalProbePlanHash,
  runCommandTimed,
} from "./experiments/intMcExperimentCore.mjs";
import { escapeHtml, parseCsv, rowsToCsv } from "./experiments/reportUtils.mjs";
import {
  buildObservableOamFeedback,
  buildObservablePlanningLinks,
  buildObservablePlanningNodes,
  buildObservableRoutes,
  scheduleObservableRows,
} from "../stage2-int/tools/int-mc-observability.mjs";

export const EXPERIMENT7_CHECK_IDS = Object.freeze([
  "observable-schema",
  "illegal-feedback-rejection",
  "hidden-truth-invariance",
  "future-feedback-invariance",
  "causal-lag",
  "observed-value-lock",
  "inactive-mask-lock",
  "truth-use-audit",
]);

const CHECK_LABELS = Object.freeze({
  "observable-schema": "规划视图字段合法",
  "illegal-feedback-rejection": "非法真值反馈拒绝",
  "hidden-truth-invariance": "隐藏真值反事实不变",
  "future-feedback-invariance": "未来反馈反事实不变",
  "causal-lag": "反馈时间因果合法",
  "observed-value-lock": "直接观测值锁定",
  "inactive-mask-lock": "不可用链路掩码锁定",
  "truth-use-audit": "真值使用边界审计",
});

const FORBIDDEN_PLANNER_FIELDS = new Set([
  "truth_cpu_percent",
  "truth_queue_depth",
  "truth_energy_percent",
  "truth_mode",
  "truth_utilization_percent",
  "truth_status",
  "truth_queue_latency_ms",
  "truth_congestion_percent",
  "completion_error_score",
  "utilization_error",
  "cpu_error",
  "queue_depth_error",
  "energy_error",
]);

function numberValue(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolValue(value) {
  if (typeof value === "boolean") return value;
  return ["true", "1", "yes"].includes(String(value ?? "").trim().toLowerCase());
}

function round(value, digits = 4) {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function argValue(args, name, fallback = "") {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1] ?? fallback;
}

function listArg(args, name, fallback) {
  const raw = argValue(args, name, "");
  return raw ? raw.split(",").map((value) => value.trim()).filter(Boolean) : fallback;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function stableHash(value) {
  return createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

function sortRows(rows, idField) {
  return rows.slice().sort((left, right) =>
    numberValue(left.slice_index) - numberValue(right.slice_index) ||
    String(left[idField] ?? "").localeCompare(String(right[idField] ?? "")),
  );
}

async function readCsv(path) {
  return parseCsv(await readFile(path, "utf8"));
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function fieldValue(row, names) {
  for (const name of names) {
    if (row?.[name] !== undefined && row?.[name] !== null && row?.[name] !== "") return row[name];
  }
  return undefined;
}

function equalValue(left, right) {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
    return Math.abs(leftNumber - rightNumber) <= 1e-8;
  }
  return String(left ?? "") === String(right ?? "");
}

export function perturbHiddenTruthRows(rows = [], type = "link") {
  return rows.map((row, index) => {
    if (type === "node") {
      return {
        ...row,
        cpu_percent: round(99 - numberValue(row.cpu_percent, 0) * 0.37 + index % 3),
        queue_depth: round(numberValue(row.queue_depth, 0) + 777 + index % 11),
        queued_traffic_mb: round(numberValue(row.queued_traffic_mb, 0) + 9876 + index % 17),
        energy_percent: round(Math.max(0, 100 - numberValue(row.energy_percent, 100) * 0.63)),
        mode: String(row.mode ?? "") === "nominal" ? "busy" : "nominal",
      };
    }
    const active = boolValue(row.is_active ?? row.active ?? true);
    return {
      ...row,
      status: active ? (String(row.status ?? "up") === "up" ? "warning" : "up") : "down",
      utilization_percent: round(99 - numberValue(row.utilization_percent, 0) * 0.41 + index % 2),
      congestion_percent: round(numberValue(row.congestion_percent, 0) + 73 + index % 13),
      queue_latency_ms: round(numberValue(row.queue_latency_ms, 0) + 999 + index % 19),
      queued_traffic_mb: round(numberValue(row.queued_traffic_mb, 0) + 5000 + index % 23),
      dropped_traffic_mb: round(numberValue(row.dropped_traffic_mb, 0) + 500 + index % 7),
      packet_error_rate: round(Math.min(1, numberValue(row.packet_error_rate, 0) + 0.35), 6),
    };
  });
}

export function buildObservablePlannerHash({
  truthLinks = [],
  truthNodes = [],
  routes = [],
  predictedPlan = null,
  oamLinks = [],
  oamNodes = [],
  feedback = [],
  stateLagSlices = 1,
  protectedThroughSlice = Number.POSITIVE_INFINITY,
} = {}) {
  const links = buildObservablePlanningLinks({
    truthLinks,
    predictedPlan,
    oamLinks,
    mode: "oam-only",
    stateLagSlices,
  }).filter((row) => numberValue(row.slice_index) <= protectedThroughSlice);
  const nodes = buildObservablePlanningNodes({
    truthNodes,
    oamNodes,
    mode: "oam-only",
    stateLagSlices,
  }).filter((row) => numberValue(row.slice_index) <= protectedThroughSlice);
  const observableRoutes = buildObservableRoutes({ routes, mode: "oam-only" })
    .filter((row) => numberValue(row.slice_index) <= protectedThroughSlice);
  const scheduledFeedback = scheduleObservableRows(
    buildObservableOamFeedback({ rows: feedback, mode: "oam-only" }),
    { lagSlices: stateLagSlices },
  ).filter((row) => numberValue(row.slice_index) <= protectedThroughSlice);
  return stableHash({
    links: sortRows(links, "link_id"),
    nodes: sortRows(nodes, "node_id"),
    routes: sortRows(observableRoutes, "task_id"),
    feedback: sortRows(scheduledFeedback, "target_id"),
  });
}

export function auditReconstructionInvariants({
  observedNodes = [],
  completedNodes = [],
  observedLinks = [],
  completedLinks = [],
  predictedPlan = null,
} = {}) {
  const completedNodeByKey = new Map(completedNodes.map((row) => [`${row.slice_index}|${row.node_id}`, row]));
  const completedLinkByKey = new Map(completedLinks.map((row) => [`${row.slice_index}|${row.link_id}`, row]));
  const mismatches = [];
  const compare = (observedRows, completedByKey, idField, fields) => {
    observedRows.filter((row) => row.observed === undefined || boolValue(row.observed)).forEach((observed) => {
      const key = `${observed.slice_index}|${observed[idField]}`;
      const completed = completedByKey.get(key);
      if (!completed) {
        mismatches.push({ key, field: "missing-completed-row" });
        return;
      }
      if (idField === "link_id" && boolValue(completed.topology_down)) return;
      fields.forEach(({ observedNames, completedNames, label }) => {
        const expected = fieldValue(observed, observedNames);
        if (expected === undefined) return;
        const actual = fieldValue(completed, completedNames);
        if (!equalValue(expected, actual)) mismatches.push({ key, field: label, expected, actual });
      });
    });
  };
  compare(observedNodes, completedNodeByKey, "node_id", [
    { label: "cpu", observedNames: ["cpu_percent_estimate", "cpu_percent"], completedNames: ["cpu_percent_estimate", "cpu_percent"] },
    { label: "queue", observedNames: ["queue_depth_estimate", "queue_depth"], completedNames: ["queue_depth_estimate", "queue_depth"] },
    { label: "energy", observedNames: ["energy_percent_estimate", "energy_percent"], completedNames: ["energy_percent_estimate", "energy_percent"] },
    { label: "mode", observedNames: ["mode_estimate", "mode"], completedNames: ["mode_estimate", "mode"] },
  ]);
  compare(observedLinks, completedLinkByKey, "link_id", [
    { label: "utilization", observedNames: ["utilization_percent_estimate", "utilization_percent"], completedNames: ["utilization_percent_estimate", "utilization_percent"] },
    { label: "status", observedNames: ["status_estimate", "status"], completedNames: ["status_estimate", "status"] },
  ]);
  const inactiveViolations = [];
  (predictedPlan?.entries ?? []).filter((entry) => !boolValue(entry.predicted_active)).forEach((entry) => {
    const key = `${entry.slice_index}|${entry.link_id}`;
    const completed = completedLinkByKey.get(key);
    if (!completed) return;
    if (String(completed.status_estimate ?? completed.status).toLowerCase() !== "down" ||
      boolValue(completed.active_estimate ?? completed.active)) {
      inactiveViolations.push({ key, status: completed.status_estimate, active: completed.active_estimate });
    }
  });
  return {
    observed_value_mismatches: mismatches.length,
    inactive_mask_violations: inactiveViolations.length,
    observed_value_samples: mismatches.slice(0, 10),
    inactive_mask_samples: inactiveViolations.slice(0, 10),
  };
}

function illegalFeedbackFixture() {
  return [
    { slice_index: 1, target_type: "link", target_id: "safe", priority_score: 0.7, feedback_source: "int-mc-deployable", feedback_basis: "observable-uncertainty", reason: "low-confidence", completion_error_score: "" },
    { slice_index: 1, target_type: "link", target_id: "bad-source", priority_score: 1, feedback_source: "int-mc-completion", feedback_basis: "observable-uncertainty", reason: "legacy", completion_error_score: "" },
    { slice_index: 1, target_type: "link", target_id: "bad-basis", priority_score: 1, feedback_source: "int-mc-deployable", feedback_basis: "truth-error", reason: "legacy", completion_error_score: "" },
    { slice_index: 1, target_type: "link", target_id: "bad-reason", priority_score: 1, feedback_source: "int-mc-deployable", feedback_basis: "observable-uncertainty", reason: "high-simulation-validation-error", completion_error_score: "" },
    { slice_index: 1, target_type: "link", target_id: "bad-score", priority_score: 1, feedback_source: "int-mc-deployable", feedback_basis: "observable-uncertainty", reason: "legacy", completion_error_score: "0.9" },
  ];
}

function fixtureData() {
  const truthLinks = [0, 1, 2].map((sliceIndex) => ({
    slice_index: sliceIndex, link_id: "L1", source: "N1", target: "N2", kind: "inter-plane",
    is_active: true, status: "up", utilization_percent: 10 + sliceIndex, queue_latency_ms: 1,
  }));
  const truthNodes = [0, 1, 2].map((sliceIndex) => ({
    slice_index: sliceIndex, node_id: "N1", plane: 0, slot: 0, latitude: 10, longitude: 20,
    cpu_percent: 5, queue_depth: 1, energy_percent: 90, mode: "nominal",
  }));
  const predictedPlan = { entries: truthLinks.map((row) => ({
    slice_index: row.slice_index, link_id: row.link_id, source: row.source, target: row.target,
    kind: row.kind, predicted_active: true, capacity_mbps: 1000, distance_km: 1200,
  })) };
  const oamLinks = [0, 1].map((slice_index) => ({ slice_index, link_id: "L1", status_estimate: "up", utilization_percent_estimate: 40, confidence: 0.7, observation_source: "inferred" }));
  const oamNodes = [0, 1].map((slice_index) => ({ slice_index, node_id: "N1", cpu_percent_estimate: 30, queue_depth_estimate: 4, energy_percent_estimate: 70, mode_estimate: "nominal", confidence: 0.7, observation_source: "inferred" }));
  const feedback = [{ source_slice_index: 0, slice_index: 1, target_type: "link", target_id: "L1", feedback_source: "int-mc-deployable", feedback_basis: "observable-uncertainty", reason: "low-confidence", priority_score: 0.8, completion_error_score: "" }];
  return { truthLinks, truthNodes, predictedPlan, oamLinks, oamNodes, feedback };
}

function makeCheck(profile, checkId, passed, expected, observed, evidencePaths = [], protectedSliceRange = "all") {
  return {
    profile: profile.id,
    profile_label: profile.short_label,
    check_id: checkId,
    check_label: CHECK_LABELS[checkId],
    status: passed ? "PASS" : "FAIL",
    expected,
    observed: typeof observed === "string" ? observed : JSON.stringify(observed),
    protected_slice_range: protectedSliceRange,
    evidence_paths: evidencePaths.join(" | "),
  };
}

async function sourceBoundaryAudit() {
  const [selectorSource, observabilitySource, reconstructorSource] = await Promise.all([
    readFile(resolve("stage2-int/tools/int-mc-path-selector.mjs"), "utf8"),
    readFile(resolve("stage2-int/tools/int-mc-observability.mjs"), "utf8"),
    readFile(resolve("stage2-int/tools/int-mc-reconstructor.mjs"), "utf8"),
  ]);
  const conditions = {
    selector_imports_observable_links: selectorSource.includes("buildObservablePlanningLinks"),
    selector_imports_observable_nodes: selectorSource.includes("buildObservablePlanningNodes"),
    selector_filters_feedback: selectorSource.includes("buildObservableOamFeedback"),
    observable_feedback_rejects_legacy_truth_source: observabilitySource.includes('source !== "int-mc-completion"'),
    observable_feedback_rejects_truth_basis: observabilitySource.includes('!basis.includes("truth")'),
    deployment_reconstructor_has_no_legacy_truth_retest: !reconstructorSource.includes("buildCompletionPriorityRetests") && !reconstructorSource.includes("high-simulation-validation-error"),
  };
  return { passed: Object.values(conditions).every(Boolean), conditions };
}

async function fixtureChecks(profile) {
  const data = fixtureData();
  const observableLinks = buildObservablePlanningLinks({ ...data, mode: "oam-only", stateLagSlices: 1 });
  const observableNodes = buildObservablePlanningNodes({ ...data, mode: "oam-only", stateLagSlices: 1 });
  const leakedFields = [...observableLinks, ...observableNodes].flatMap((row) => Object.keys(row).filter((key) => FORBIDDEN_PLANNER_FIELDS.has(key)));
  const legalFeedback = buildObservableOamFeedback({ rows: illegalFeedbackFixture(), mode: "oam-only" });
  const baselineHash = buildObservablePlannerHash({ ...data, stateLagSlices: 1, protectedThroughSlice: 2 });
  const hiddenHash = buildObservablePlannerHash({
    ...data,
    truthLinks: perturbHiddenTruthRows(data.truthLinks, "link"),
    truthNodes: perturbHiddenTruthRows(data.truthNodes, "node"),
    stateLagSlices: 1,
    protectedThroughSlice: 2,
  });
  const futureHash = buildObservablePlannerHash({
    ...data,
    feedback: [...data.feedback, { source_slice_index: 2, slice_index: 2, target_type: "node", target_id: "N1", feedback_source: "int-mc-deployable", feedback_basis: "observable-uncertainty", reason: "future", priority_score: 1, completion_error_score: "" }],
    stateLagSlices: 1,
    protectedThroughSlice: 2,
  });
  const scheduled = scheduleObservableRows(data.feedback, { lagSlices: 1 });
  const causalViolations = scheduled.filter((row) => numberValue(row.source_slice_index) >= numberValue(row.slice_index)).length;
  const invariants = auditReconstructionInvariants({
    observedNodes: [{ slice_index: 0, node_id: "N1", cpu_percent: 30, mode: "nominal" }],
    completedNodes: [{ slice_index: 0, node_id: "N1", cpu_percent_estimate: 30, mode_estimate: "nominal" }],
    observedLinks: [{ slice_index: 0, link_id: "L1", utilization_percent: 40, status: "up" }],
    completedLinks: [{ slice_index: 0, link_id: "L1", utilization_percent_estimate: 40, status_estimate: "up" }, { slice_index: 1, link_id: "L2", status_estimate: "down", active_estimate: false }],
    predictedPlan: { entries: [{ slice_index: 1, link_id: "L2", predicted_active: false }] },
  });
  const sourceAudit = await sourceBoundaryAudit();
  return {
    checkRows: [
      makeCheck(profile, "observable-schema", leakedFields.length === 0, "0 forbidden fields", { forbidden_field_count: leakedFields.length }),
      makeCheck(profile, "illegal-feedback-rejection", legalFeedback.length === 1 && legalFeedback[0].target_id === "safe", "only safe observable feedback accepted", { accepted_ids: legalFeedback.map((row) => row.target_id) }),
      makeCheck(profile, "hidden-truth-invariance", hiddenHash === baselineHash, baselineHash, hiddenHash, [], "T00-T02"),
      makeCheck(profile, "future-feedback-invariance", futureHash === baselineHash, baselineHash, futureHash, [], "T00-T02"),
      makeCheck(profile, "causal-lag", causalViolations === 0, "0 causal violations", { causal_violations: causalViolations, lag_slices: 1 }),
      makeCheck(profile, "observed-value-lock", invariants.observed_value_mismatches === 0, "0 observed-value changes", invariants.observed_value_mismatches),
      makeCheck(profile, "inactive-mask-lock", invariants.inactive_mask_violations === 0, "0 inactive-mask violations", invariants.inactive_mask_violations),
      makeCheck(profile, "truth-use-audit", sourceAudit.passed, "all source boundary conditions true", sourceAudit.conditions),
    ],
    planHashRows: [
      { profile: profile.id, scenario: "baseline", protected_slice_range: "T00-T02", plan_hash: baselineHash, matches_baseline: true },
      { profile: profile.id, scenario: "hidden-truth-perturbed", protected_slice_range: "T00-T02", plan_hash: hiddenHash, matches_baseline: hiddenHash === baselineHash },
      { profile: profile.id, scenario: "future-feedback-injected", protected_slice_range: "T00-T02", plan_hash: futureHash, matches_baseline: futureHash === baselineHash },
    ],
  };
}

function profilePaths(profile, baselineRoot, experiment4Root) {
  return {
    truthDir: join(baselineRoot, profile.id, "stage1-truth"),
    candidatePaths: join(baselineRoot, profile.id, "experiment2", "stage2", "full-probe-int", "probe-paths-path-balance.csv"),
    manifestPath: join(experiment4Root, "runs", profile.id, "full", "run-manifest.json"),
  };
}

async function prepareCounterfactualInputs({ profile, paths, manifest, outputDir, cutoffSlice }) {
  const [metadata, truthLinks, truthNodes, routes, candidates, predictedPlan, oamLinks, oamNodes, feedback, controls] = await Promise.all([
    readJson(join(paths.truthDir, "metadata.json")),
    readCsv(join(paths.truthDir, "links.csv")),
    readCsv(join(paths.truthDir, "nodes.csv")),
    readCsv(join(paths.truthDir, "routes.csv")),
    readCsv(paths.candidatePaths),
    readJson(manifest.after.artifacts.predicted_contact_plan_json),
    readCsv(manifest.before.artifacts.ground_links_csv),
    readCsv(manifest.before.artifacts.ground_nodes_csv),
    readCsv(manifest.combined_feedback_csv),
    readCsv(join(manifest.pass1_ground_dir, "ground-oam-control-actions.csv")),
  ]);
  const through = (rows, extra = 0) => rows.filter((row) => numberValue(row.slice_index) <= cutoffSlice + extra);
  const baseLinks = through(truthLinks);
  const baseNodes = through(truthNodes);
  const baseRoutes = through(routes);
  const baseCandidates = through(candidates);
  const basePredicted = { ...predictedPlan, entries: through(predictedPlan.entries ?? [], 5) };
  const baseOamLinks = through(oamLinks);
  const baseOamNodes = through(oamNodes);
  const baseFeedback = feedback.filter((row) => numberValue(row.source_slice_index, numberValue(row.slice_index)) <= cutoffSlice);
  const baseControls = controls.filter((row) => numberValue(row.slice_index) <= cutoffSlice);
  const inputDir = join(outputDir, "counterfactual-input");
  await mkdir(inputDir, { recursive: true });
  const files = {
    metadata: join(inputDir, "metadata.json"),
    baseLinks: join(inputDir, "links-base.csv"),
    hiddenLinks: join(inputDir, "links-hidden.csv"),
    baseNodes: join(inputDir, "nodes-base.csv"),
    hiddenNodes: join(inputDir, "nodes-hidden.csv"),
    routes: join(inputDir, "routes.csv"),
    candidates: join(inputDir, "candidate-paths.csv"),
    predicted: join(inputDir, "predicted-contact-plan.json"),
    oamLinks: join(inputDir, "planner-oam-links.csv"),
    oamNodes: join(inputDir, "planner-oam-nodes.csv"),
    feedback: join(inputDir, "feedback.csv"),
    futureFeedback: join(inputDir, "feedback-future.csv"),
    controls: join(inputDir, "controls.csv"),
  };
  const firstTarget = baseFeedback[0]?.target_id ?? baseLinks[0]?.link_id ?? baseNodes[0]?.node_id;
  const futureFeedback = [...baseFeedback, {
    source_slice_index: cutoffSlice,
    slice_index: cutoffSlice,
    target_type: "link",
    target_id: firstTarget,
    priority_score: 1,
    reason: "counterfactual-future-observable-feedback",
    confidence: 0.1,
    observation_source: "inferred",
    feedback_source: "int-mc-deployable",
    feedback_basis: "observable-uncertainty",
    completion_error_score: "",
  }];
  await Promise.all([
    writeJson(files.metadata, { ...metadata, slice_count: cutoffSlice + 1 }),
    writeFile(files.baseLinks, rowsToCsv(baseLinks), "utf8"),
    writeFile(files.hiddenLinks, rowsToCsv(perturbHiddenTruthRows(baseLinks, "link")), "utf8"),
    writeFile(files.baseNodes, rowsToCsv(baseNodes), "utf8"),
    writeFile(files.hiddenNodes, rowsToCsv(perturbHiddenTruthRows(baseNodes, "node")), "utf8"),
    writeFile(files.routes, rowsToCsv(baseRoutes), "utf8"),
    writeFile(files.candidates, rowsToCsv(baseCandidates), "utf8"),
    writeJson(files.predicted, basePredicted),
    writeFile(files.oamLinks, rowsToCsv(baseOamLinks), "utf8"),
    writeFile(files.oamNodes, rowsToCsv(baseOamNodes), "utf8"),
    writeFile(files.feedback, rowsToCsv(baseFeedback), "utf8"),
    writeFile(files.futureFeedback, rowsToCsv(futureFeedback), "utf8"),
    writeFile(files.controls, rowsToCsv(baseControls), "utf8"),
  ]);
  return { files, baseLinks, baseNodes, baseRoutes, basePredicted, baseOamLinks, baseOamNodes, baseFeedback };
}

async function runSelectorScenario({ profile, manifest, prepared, outputDir, scenario, hiddenTruth = false, futureFeedback = false, cutoffSlice }) {
  await mkdir(outputDir, { recursive: true });
  const parameters = manifest.parameters;
  const args = [
    "--input", dirname(prepared.files.metadata),
    "--stage2", outputDir,
    "--out", outputDir,
    "--algorithm", "int-mc",
    "--candidate-algorithm", "path-balance",
    "--candidate-paths", prepared.files.candidates,
    "--links", hiddenTruth ? prepared.files.hiddenLinks : prepared.files.baseLinks,
    "--nodes", hiddenTruth ? prepared.files.hiddenNodes : prepared.files.baseNodes,
    "--routes", prepared.files.routes,
    "--sampling-rate", String(parameters.samplingRate),
    "--target-active-link-sampling-rate", String(parameters.targetActiveLinkSamplingRate),
    "--rank", String(parameters.rank),
    "--selection-strategy", "int-mc-leverage",
    "--window-size", String(parameters.windowSize),
    "--warmup-slices", String(parameters.warmupSlices),
    "--max-paths-per-slice", String(parameters.maxPathsPerSlice),
    "--predicted-contact-plan", prepared.files.predicted,
    "--observability-mode", "oam-only",
    "--feedback-lag-slices", String(parameters.feedbackLagSlices),
    "--planner-oam-links", prepared.files.oamLinks,
    "--planner-oam-nodes", prepared.files.oamNodes,
    "--oam-priority-retest", futureFeedback ? prepared.files.futureFeedback : prepared.files.feedback,
    "--oam-control-actions", prepared.files.controls,
    "--adaptive-reuse", String(Boolean(manifest.mechanisms.adaptiveReuse)),
    "--incremental-topology-repair", String(Boolean(manifest.mechanisms.incrementalTopologyRepair)),
    "--forecast-risk-scoring", String(Boolean(manifest.mechanisms.forecastRiskScoring)),
  ];
  if (manifest.mechanisms.adaptiveProbeBudget) args.push("--adaptive-probe-budget", "true");
  if (manifest.mechanisms.multiObjectiveBudget) args.push("--multi-objective-budget", "true");
  if (manifest.mechanisms.oamTargetAwareMetadata) args.push("--oam-target-aware-metadata", "true", "--oam-target-hop-bytes", "96", "--oam-transit-hop-bytes", "88");
  const command = await runCommandTimed({
    label: `${profile.short_label} Experiment 7 ${scenario}`,
    script: "stage2-int/tools/int-mc-path-selector.mjs",
    args,
  });
  const paths = (await readCsv(join(outputDir, "probe-paths-int-mc.csv")))
    .filter((row) => numberValue(row.slice_index) <= cutoffSlice);
  return {
    scenario,
    hash: canonicalProbePlanHash(paths),
    path_count: paths.length,
    timing_ms: command.timing.wall_time_ms,
    paths_csv: join(outputDir, "probe-paths-int-mc.csv"),
    selector_report_json: join(outputDir, "probe-coverage-int-mc.json"),
  };
}

async function formalProfileChecks({ profile, baselineRoot, experiment4Root, outputDir, cutoffSlice }) {
  const paths = profilePaths(profile, baselineRoot, experiment4Root);
  const manifest = await readJson(paths.manifestPath);
  const profileDir = join(outputDir, "counterfactual", profile.id);
  const prepared = await prepareCounterfactualInputs({ profile, paths, manifest, outputDir: profileDir, cutoffSlice });
  const [baselinePlan, hiddenPlan, futurePlan] = await Promise.all([
    runSelectorScenario({ profile, manifest, prepared, outputDir: join(profileDir, "baseline"), scenario: "baseline", cutoffSlice }),
    runSelectorScenario({ profile, manifest, prepared, outputDir: join(profileDir, "hidden-truth-perturbed"), scenario: "hidden-truth-perturbed", hiddenTruth: true, cutoffSlice }),
    runSelectorScenario({ profile, manifest, prepared, outputDir: join(profileDir, "future-feedback-injected"), scenario: "future-feedback-injected", futureFeedback: true, cutoffSlice }),
  ]);
  const [completedLinks, completedNodes, observedLinks, observedNodes, predictedPlan, selectorReport, evaluation, sourceAudit] = await Promise.all([
    readCsv(manifest.after.artifacts.ground_links_csv),
    readCsv(manifest.after.artifacts.ground_nodes_csv),
    readCsv(join(dirname(manifest.after.artifacts.ground_links_csv), "ground-reconstructed-links.csv")),
    readCsv(join(dirname(manifest.after.artifacts.ground_nodes_csv), "ground-reconstructed-nodes.csv")),
    readJson(manifest.after.artifacts.predicted_contact_plan_json),
    readJson(manifest.after.artifacts.selector_report_json),
    readJson(manifest.after.artifacts.evaluation_json),
    sourceBoundaryAudit(),
  ]);
  const observableLinks = buildObservablePlanningLinks({ truthLinks: prepared.baseLinks, predictedPlan: prepared.basePredicted, oamLinks: prepared.baseOamLinks, mode: "oam-only", stateLagSlices: 1 });
  const observableNodes = buildObservablePlanningNodes({ truthNodes: prepared.baseNodes, oamNodes: prepared.baseOamNodes, mode: "oam-only", stateLagSlices: 1 });
  const leakedFields = [...observableLinks, ...observableNodes].flatMap((row) => Object.keys(row).filter((key) => FORBIDDEN_PLANNER_FIELDS.has(key)));
  const acceptedSyntheticFeedback = buildObservableOamFeedback({ rows: illegalFeedbackFixture(), mode: "oam-only" });
  const acceptedFormalFeedback = buildObservableOamFeedback({ rows: prepared.baseFeedback, mode: "oam-only" });
  const formalFeedbackRejected = prepared.baseFeedback.length - acceptedFormalFeedback.length;
  const scheduledFeedback = scheduleObservableRows(acceptedFormalFeedback, { lagSlices: manifest.feedback_lag_slices });
  const causalViolations = scheduledFeedback.filter((row) => numberValue(row.source_slice_index) >= numberValue(row.slice_index)).length;
  const plannerLagViolations = [...observableLinks, ...observableNodes].filter((row) => row.planner_state_source_slice_index !== "" && numberValue(row.planner_state_source_slice_index) >= numberValue(row.slice_index)).length;
  const invariants = auditReconstructionInvariants({ observedNodes, completedNodes, observedLinks, completedLinks, predictedPlan });
  const truthBoundaryConditions = {
    manifest_oam_only: manifest.observability_mode === "oam-only",
    manifest_truth_error_feedback_disabled: manifest.truth_error_feedback_enabled === false,
    selector_hides_stage1_dynamic_metrics: selectorReport.method?.hidden_stage1_metrics_available_to_planner === false,
    selector_uses_lagged_ground_oam: selectorReport.method?.planner_dynamic_state_source === "lagged-ground-oam-estimates",
    evaluation_truth_only: evaluation.boundary?.truth_metrics_used_only_for_evaluation === true,
    no_formal_illegal_feedback: formalFeedbackRejected === 0,
    source_boundary_passed: sourceAudit.passed,
  };
  const evidence = [paths.manifestPath, manifest.after.artifacts.selector_report_json, manifest.after.artifacts.evaluation_json];
  const protectedRange = `T00-T${String(cutoffSlice).padStart(2, "0")}`;
  return {
    checkRows: [
      makeCheck(profile, "observable-schema", leakedFields.length === 0, "0 forbidden fields", { forbidden_field_count: leakedFields.length }, evidence, protectedRange),
      makeCheck(profile, "illegal-feedback-rejection", acceptedSyntheticFeedback.length === 1 && acceptedSyntheticFeedback[0].target_id === "safe" && formalFeedbackRejected === 0, "synthetic illegal rows rejected and formal feedback legal", { accepted_synthetic_ids: acceptedSyntheticFeedback.map((row) => row.target_id), formal_feedback_rows: prepared.baseFeedback.length, formal_rejected_rows: formalFeedbackRejected }, evidence, protectedRange),
      makeCheck(profile, "hidden-truth-invariance", hiddenPlan.hash === baselinePlan.hash, baselinePlan.hash, hiddenPlan.hash, [baselinePlan.paths_csv, hiddenPlan.paths_csv], protectedRange),
      makeCheck(profile, "future-feedback-invariance", futurePlan.hash === baselinePlan.hash, baselinePlan.hash, futurePlan.hash, [baselinePlan.paths_csv, futurePlan.paths_csv], protectedRange),
      makeCheck(profile, "causal-lag", causalViolations === 0 && plannerLagViolations === 0 && numberValue(selectorReport.coverage?.causal_feedback_violations) === 0, "0 causal violations and lag >= 1", { feedback_violations: causalViolations, planner_state_violations: plannerLagViolations, formal_selector_violations: numberValue(selectorReport.coverage?.causal_feedback_violations), lag_slices: manifest.feedback_lag_slices }, evidence, "T00-T47"),
      makeCheck(profile, "observed-value-lock", invariants.observed_value_mismatches === 0, "0 observed-value changes", { mismatch_count: invariants.observed_value_mismatches, samples: invariants.observed_value_samples }, evidence, "T00-T47"),
      makeCheck(profile, "inactive-mask-lock", invariants.inactive_mask_violations === 0, "0 inactive-mask violations", { violation_count: invariants.inactive_mask_violations, samples: invariants.inactive_mask_samples }, evidence, "T00-T47"),
      makeCheck(profile, "truth-use-audit", Object.values(truthBoundaryConditions).every(Boolean), "all truth-boundary conditions true", truthBoundaryConditions, evidence, "T00-T47"),
    ],
    planHashRows: [baselinePlan, hiddenPlan, futurePlan].map((row) => ({
      profile: profile.id,
      profile_label: profile.short_label,
      scenario: row.scenario,
      protected_slice_range: protectedRange,
      plan_hash: row.hash,
      baseline_hash: baselinePlan.hash,
      matches_baseline: row.hash === baselinePlan.hash,
      selected_paths: row.path_count,
      selector_wall_time_ms: row.timing_ms,
      evidence_path: row.paths_csv,
    })),
  };
}

function relativePath(fromPath, toPath) {
  return relative(dirname(fromPath), toPath).replaceAll("\\", "/");
}

function buildMarkdown({ checkRows, planHashRows, rootReportPath, outputDir }) {
  const passed = checkRows.filter((row) => row.status === "PASS").length;
  const profileRows = [...new Set(checkRows.map((row) => row.profile))].map((profileId) => {
    const rows = checkRows.filter((row) => row.profile === profileId);
    return `| ${rows[0]?.profile_label ?? profileId} | ${rows.filter((row) => row.status === "PASS").length}/${rows.length} | ${rows.every((row) => row.status === "PASS") ? "通过" : "失败"} |`;
  }).join("\n");
  const htmlPath = relativePath(rootReportPath, join(outputDir, "experiment7-report.html"));
  return `# 实验 7：无真值泄漏合法性验证实验

## 实验做了什么

本实验不比较重构误差大小，而是检查实验 2、4-6 使用的增强 LEO-INT-MC 是否遵守可部署遥测边界。它对三种规模分别执行八项检查，并用反事实数据重新运行路径选择器。详细证据见 [实验7 HTML报告](${htmlPath})。

## 实验结果

共执行 ${checkRows.length} 项检查，通过 ${passed} 项；生成 ${planHashRows.length} 条规划哈希证据。

| 星座/夹具 | 通过检查 | 结论 |
|---|---:|---|
${profileRows}

## 无真值数值泄漏

在保持拓扑标识、轨道接触预测、业务请求和 OAM 输入不变的情况下，大幅改写隐藏 CPU、队列、电量、链路利用率和状态。若选出的 probe plan 哈希保持一致，说明路径选择不依赖这些未观测真值。非法的 truth-error、simulation-validation 和 completion-error 反馈必须被拒绝。

## 时间因果合法

Ground OAM 和补全置信度反馈至少滞后一片进入规划。实验注入来源时间片不早于截止点的未来反馈，并要求截止点之前的 probe plan 不发生变化；同时审计所有规划状态来源满足 source_slice < target_slice。

## 真值仅用于事后评估

第一阶段真值允许用于轨道/链路可用性预测和实验结束后的 MAE、RMSE、准确率计算，但不得直接进入动态状态评分、复测目标生成和当前时间片路径选择。报告分别核验 manifest、路径选择器边界字段、补全评估边界和源码数据流入口。

## 证明了什么

本实验能证明当前实现满足所声明的 OAM-only、单时间片因果滞后和事后真值评估边界；观察值锁定与不可用链路锁定也防止矩阵补全覆盖直接测量或创造不存在的链路。

## 不能证明什么

通过合法性审计不等于真实硬件部署已经安全，也不证明观测噪声、时钟误差或攻击条件下仍然成立。反事实检查覆盖当前代码路径与正式配置，后续修改路径选择器或反馈格式后必须重新运行。

## 产物索引

- [HTML 可视化](reports/experiment7-no-truth-leakage/experiment7-report.html)
- [检查 CSV](reports/experiment7-no-truth-leakage/experiment7-checks.csv)
- [汇总 JSON](reports/experiment7-no-truth-leakage/experiment7-summary.json)
- [实验 manifest](reports/experiment7-no-truth-leakage/experiment7-manifest.json)

## 复现

\`npm run experiment7:legality\`
`;
}

function buildHtml(checkRows, planHashRows) {
  const checks = checkRows.map((row) => `<tr><td>${escapeHtml(row.profile_label)}</td><td>${escapeHtml(row.check_label)}</td><td class="${row.status === "PASS" ? "pass" : "fail"}">${row.status}</td><td>${escapeHtml(row.expected)}</td><td>${escapeHtml(row.observed)}</td><td>${escapeHtml(row.protected_slice_range)}</td></tr>`).join("");
  const hashes = planHashRows.map((row) => `<tr><td>${escapeHtml(row.profile_label ?? row.profile)}</td><td>${escapeHtml(row.scenario)}</td><td>${escapeHtml(row.protected_slice_range)}</td><td><code>${escapeHtml(row.plan_hash)}</code></td><td class="${String(row.matches_baseline) === "true" ? "pass" : "fail"}">${String(row.matches_baseline) === "true" ? "一致" : "不一致"}</td></tr>`).join("");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>实验7 无真值泄漏合法性验证</title><style>body{font-family:Arial,"Microsoft YaHei",sans-serif;background:#f4f7f8;color:#17212b;margin:0}main{max-width:1250px;margin:auto;padding:28px}section{background:#fff;border:1px solid #d7e1e5;border-radius:6px;padding:18px;margin:16px 0}h1,h2{color:#153f57}table{border-collapse:collapse;width:100%;font-size:12px}th,td{border:1px solid #d7e1e5;padding:7px;text-align:left;vertical-align:top}.pass{color:#1b6f54;font-weight:700}.fail{color:#b43c35;font-weight:700}code{font-size:10px;word-break:break-all}</style></head><body><main><h1>实验 7：无真值泄漏合法性验证</h1><section><h2>八项合法性检查</h2><table><thead><tr><th>星座</th><th>检查</th><th>状态</th><th>预期</th><th>观测</th><th>保护范围</th></tr></thead><tbody>${checks}</tbody></table></section><section><h2>反事实 probe plan 哈希</h2><table><thead><tr><th>星座</th><th>场景</th><th>保护范围</th><th>SHA-256</th><th>与基线关系</th></tr></thead><tbody>${hashes}</tbody></table></section><section><h2>结论边界</h2><p>无真值数值泄漏、时间因果合法、真值仅用于事后评估是三个独立主张；任一检查失败都不能把该轮结果作为可部署算法证据。</p></section></main></body></html>`;
}

export async function runExperiment7({
  profiles = PROFILE_CATALOG,
  outputDir = resolve("reports/experiment7-no-truth-leakage"),
  rootReportPath = resolve("EXPERIMENT_7_NO_TRUTH_LEAKAGE_REPORT.md"),
  baselineRoot = resolve("reports/experiment2-native-baseline-rerun-final"),
  experiment4Root = resolve("reports/experiment4-leo-int-mc-ablation"),
  fixtureOnly = false,
  cutoffSlice = 7,
} = {}) {
  await mkdir(outputDir, { recursive: true });
  const checkRows = [];
  const planHashRows = [];
  for (const profile of profiles) {
    const result = fixtureOnly
      ? await fixtureChecks(profile)
      : await formalProfileChecks({ profile, baselineRoot, experiment4Root, outputDir, cutoffSlice });
    checkRows.push(...result.checkRows);
    planHashRows.push(...result.planHashRows);
  }
  const failedChecks = checkRows.filter((row) => row.status !== "PASS");
  const generatedAt = new Date().toISOString();
  const summary = {
    schema_version: "experiment7-no-truth-leakage-v1",
    generated_at: generatedAt,
    fixture_only: fixtureOnly,
    profile_count: profiles.length,
    check_count: checkRows.length,
    passed_checks: checkRows.length - failedChecks.length,
    failed_checks: failedChecks.length,
    all_required_checks_passed: failedChecks.length === 0,
    check_ids: EXPERIMENT7_CHECK_IDS,
    claims: {
      no_hidden_truth_numeric_leakage: failedChecks.every((row) => !["observable-schema", "illegal-feedback-rejection", "hidden-truth-invariance"].includes(row.check_id)),
      temporal_causality_legal: failedChecks.every((row) => !["future-feedback-invariance", "causal-lag"].includes(row.check_id)),
      truth_used_only_for_posthoc_evaluation: failedChecks.every((row) => row.check_id !== "truth-use-audit"),
      reconstruction_constraints_hold: failedChecks.every((row) => !["observed-value-lock", "inactive-mask-lock"].includes(row.check_id)),
    },
  };
  const manifest = {
    schema_version: "experiment7-manifest-v1",
    generated_at: generatedAt,
    status: failedChecks.length === 0 ? "complete" : "failed",
    parameters: { fixture_only: fixtureOnly, cutoff_slice: cutoffSlice, feedback_lag_slices: 1, observability_mode: "oam-only" },
    profiles: profiles.map((profile) => profile.id),
    outputs: {
      checks_csv: join(outputDir, "experiment7-checks.csv"),
      plan_hashes_csv: join(outputDir, "experiment7-plan-hashes.csv"),
      summary_json: join(outputDir, "experiment7-summary.json"),
      report_html: join(outputDir, "experiment7-report.html"),
      root_report_markdown: rootReportPath,
    },
    summary,
  };
  await Promise.all([
    writeFile(join(outputDir, "experiment7-checks.csv"), rowsToCsv(checkRows), "utf8"),
    writeFile(join(outputDir, "experiment7-plan-hashes.csv"), rowsToCsv(planHashRows), "utf8"),
    writeJson(join(outputDir, "experiment7-summary.json"), { ...summary, checks: checkRows, plan_hashes: planHashRows }),
    writeFile(join(outputDir, "experiment7-report.html"), buildHtml(checkRows, planHashRows), "utf8"),
    writeJson(join(outputDir, "experiment7-manifest.json"), manifest),
    writeFile(rootReportPath, buildMarkdown({ checkRows, planHashRows, rootReportPath, outputDir }), "utf8"),
  ]);
  return { checkRows, planHashRows, summary, manifest };
}

async function main() {
  const args = process.argv.slice(2);
  const profileIds = listArg(args, "--profiles", PROFILE_CATALOG.map((profile) => profile.id));
  const profiles = profileIds.map((id) => {
    const profile = PROFILE_CATALOG.find((candidate) => candidate.id === id);
    if (!profile) throw new Error(`Unknown Experiment 7 profile: ${id}`);
    return profile;
  });
  const outputDir = resolve(argValue(args, "--out", "reports/experiment7-no-truth-leakage"));
  const rootReportPath = resolve(argValue(args, "--root-report", "EXPERIMENT_7_NO_TRUTH_LEAKAGE_REPORT.md"));
  const result = await runExperiment7({
    profiles,
    outputDir,
    rootReportPath,
    baselineRoot: resolve(argValue(args, "--old-root", "reports/experiment2-native-baseline-rerun-final")),
    experiment4Root: resolve(argValue(args, "--experiment4-root", "reports/experiment4-leo-int-mc-ablation")),
    cutoffSlice: numberValue(argValue(args, "--counterfactual-cutoff-slice", "7"), 7),
  });
  console.log(JSON.stringify({
    ok: result.summary.all_required_checks_passed,
    checks: result.summary.check_count,
    passed: result.summary.passed_checks,
    failed: result.summary.failed_checks,
    output_dir: outputDir,
    root_report: rootReportPath,
  }, null, 2));
  if (!result.summary.all_required_checks_passed) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  });
}
