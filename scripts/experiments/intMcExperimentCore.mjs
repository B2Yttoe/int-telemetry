import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { join } from "node:path";
import { parseCsv, rowsToCsv } from "./reportUtils.mjs";

export const PROFILE_CATALOG = Object.freeze([
  Object.freeze({
    id: "iridium-next-small",
    short_label: "Iridium 66",
    scale: "small",
    node_count: 66,
  }),
  Object.freeze({
    id: "telesat-1015-medium",
    short_label: "Telesat 351",
    scale: "medium",
    node_count: 351,
  }),
  Object.freeze({
    id: "starlink-main-large",
    short_label: "Starlink 1584",
    scale: "large",
    node_count: 1584,
  }),
]);

export const FORMAL_DEFAULTS = Object.freeze({
  slice_count: 48,
  sampling_rate: 0.25,
  target_active_link_sampling_rate: 0.25,
  rank: 5,
  window_size: 12,
  warmup_slices: 6,
  iterations: 12,
  max_paths_per_slice: 12,
  feedback_lag_slices: 1,
  observability_mode: "oam-only",
});

function round(value, digits = 3) {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function parseLastJson(stdout, label) {
  const trimmed = String(stdout ?? "").trim();
  if (!trimmed) return {};
  const start = trimmed.lastIndexOf("\n{");
  const jsonText = start >= 0 ? trimmed.slice(start + 1) : trimmed;
  try {
    return JSON.parse(jsonText);
  } catch (error) {
    throw new Error(`${label} did not end with JSON: ${error.message}\n${trimmed.slice(-1200)}`);
  }
}

export function runCommandTimed({ label, script, args = [], cwd = process.cwd(), env = process.env }) {
  return new Promise((resolvePromise, reject) => {
    const startedAt = performance.now();
    const usageBefore = process.resourceUsage();
    const child = spawn(process.execPath, [script, ...args], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const usageAfter = process.resourceUsage();
      const timing = {
        label,
        wall_time_ms: round(performance.now() - startedAt),
        parent_user_cpu_ms: round((usageAfter.userCPUTime - usageBefore.userCPUTime) / 1000),
        parent_system_cpu_ms: round((usageAfter.systemCPUTime - usageBefore.systemCPUTime) / 1000),
        exit_code: code,
      };
      if (code !== 0) {
        reject(new Error(`Command failed: node ${script} ${args.join(" ")}\n${stderr || stdout}`));
        return;
      }
      try {
        resolvePromise({ result: parseLastJson(stdout, label), timing, stdout, stderr });
      } catch (error) {
        reject(error);
      }
    });
  });
}

function normalizedProbePlanRows(rows) {
  return (rows ?? [])
    .map((row) => ({
      slice_index: Number(row.slice_index ?? 0),
      probe_id: String(row.probe_id ?? ""),
      source: String(row.source ?? ""),
      sink: String(row.sink ?? row.target ?? ""),
      path: String(row.path ?? ""),
      metadata_profile: String(row.metadata_profile ?? ""),
    }))
    .sort((left, right) =>
      left.slice_index - right.slice_index ||
      left.probe_id.localeCompare(right.probe_id) ||
      left.source.localeCompare(right.source) ||
      left.sink.localeCompare(right.sink) ||
      left.path.localeCompare(right.path) ||
      left.metadata_profile.localeCompare(right.metadata_profile),
    );
}

export function canonicalProbePlanHash(rows) {
  return createHash("sha256")
    .update(JSON.stringify(normalizedProbePlanRows(rows)))
    .digest("hex");
}

export async function sha256File(path) {
  const content = await readFile(path);
  return createHash("sha256").update(content).digest("hex");
}

function numberValue(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function readCsv(path) {
  return parseCsv(await readFile(path, "utf8"));
}

function metricFields(prefix, metrics = {}) {
  return {
    [`${prefix}_mae`]: numberValue(metrics.mae),
    [`${prefix}_rmse`]: numberValue(metrics.rmse),
    [`${prefix}_p95_ae`]: numberValue(metrics.p95_ae),
    [`${prefix}_inferred_mae`]: numberValue(metrics.inferred_mae),
    [`${prefix}_inferred_rmse`]: numberValue(metrics.inferred_rmse),
    [`${prefix}_inferred_p95_ae`]: numberValue(metrics.inferred_p95_ae),
  };
}

export async function collectIntMcMetrics({ truthDir, stage2Dir, groundDir }) {
  const [metadata, coverageReport, runReport, evaluation, summaryRows, linkOverheadRows] = await Promise.all([
    readJson(join(truthDir, "metadata.json")),
    readJson(join(stage2Dir, "probe-coverage-int-mc.json")),
    readJson(join(stage2Dir, "probe-int-run-report-int-mc.json")),
    readJson(join(groundDir, "int-mc-evaluation.json")),
    readCsv(join(stage2Dir, "probe-summary-int-mc.csv")),
    readCsv(join(stage2Dir, "probe-int-link-overhead-int-mc.csv")),
  ]);
  const coverage = coverageReport.coverage ?? {};
  const method = coverageReport.method ?? {};
  const overhead = runReport.overhead ?? {};
  const reconstruction = evaluation.reconstruction ?? {};
  const linkMetrics = evaluation.metrics ?? {};
  const nodeReconstruction = evaluation.node_reconstruction ?? {};
  const nodeMetrics = nodeReconstruction.metrics ?? {};
  const sliceCount = numberValue(metadata.slice_count ?? metadata.time_slices, summaryRows.length || 1);
  const nodeCount = numberValue(metadata.node_count ?? metadata.nodes_per_slice ?? metadata.constellation?.satellites);
  const generatedBytes = numberValue(overhead.total_telemetry_generated_bytes ?? coverage.estimated_generated_telemetry_bytes);
  const islLinkBytes = linkOverheadRows.reduce(
    (total, row) => total + numberValue(row.total_telemetry_link_bytes),
    0,
  );

  return {
    slice_count: sliceCount,
    nodes_per_slice: nodeCount,
    truth_fingerprint: metadata.truth_fingerprint ?? "",
    observability_mode: method.observability_mode ?? coverageReport.parameters?.observability_mode ?? "",
    feedback_lag_slices: numberValue(method.feedback_lag_slices ?? coverageReport.parameters?.feedback_lag_slices),
    causal_oam_boundary_enabled: Boolean(method.causal_oam_boundary_enabled),
    causal_feedback_rows: numberValue(coverage.causal_feedback_rows),
    causal_planner_state_rows: numberValue(coverage.causal_planner_state_rows),
    causal_feedback_violations: numberValue(coverage.causal_feedback_violations),
    active_link_direct_coverage: numberValue(reconstruction.direct_observation_rate_on_active),
    active_link_effective_coverage: numberValue(reconstruction.active_link_completion_coverage),
    int_mc_inferred_rate_on_active: numberValue(reconstruction.inferred_rate_on_active),
    node_completion_coverage: numberValue(nodeReconstruction.node_completion_coverage),
    total_telemetry_generated_bytes: generatedBytes,
    telemetry_bytes_per_node_slice: round(generatedBytes / Math.max(nodeCount * sliceCount, 1), 4),
    total_telemetry_energy_j: numberValue(overhead.total_telemetry_energy_j),
    hop_records: numberValue(overhead.hop_records),
    report_count: numberValue(overhead.reports),
    total_metadata_bytes: numberValue(overhead.total_metadata_bytes),
    total_report_bytes: numberValue(overhead.total_report_bytes),
    total_probe_packet_base_bytes: numberValue(overhead.total_probe_packet_base_bytes),
    total_int_bytes: numberValue(overhead.total_int_bytes),
    total_isl_telemetry_link_bytes: round(islLinkBytes),
    selected_paths: numberValue(coverage.selected_paths),
    active_link_sampling_coverage: numberValue(coverage.active_link_sampling_coverage),
    reused_slice_plans: numberValue(coverage.reused_slice_plans),
    fresh_slice_plans: numberValue(coverage.fresh_slice_plans),
    estimated_full_replanning_avoided: numberValue(coverage.estimated_full_replanning_avoided),
    planning_local_repair_slices: numberValue(coverage.planning_local_repair_slices),
    planning_oam_forced_replan_slices: numberValue(coverage.planning_oam_forced_replan_slices),
    reuse_duplicate_suppressed_paths: numberValue(coverage.reuse_duplicate_suppressed_paths),
    node_mode_accuracy: numberValue(nodeReconstruction.mode_accuracy_all_nodes),
    link_status_accuracy: numberValue(reconstruction.status_accuracy_all_links),
    ...metricFields("cpu", nodeMetrics.cpu_percent),
    ...metricFields("queue_depth", nodeMetrics.queue_depth),
    ...metricFields("energy_percent", nodeMetrics.energy_percent),
    ...metricFields("link_utilization", linkMetrics.utilization_percent),
    ...metricFields("link_latency_ms", linkMetrics.latency_ms),
    utilization_inferred_mae: numberValue(linkMetrics.utilization_percent?.inferred_mae),
    truth_metrics_used_only_for_evaluation: Boolean(evaluation.boundary?.truth_metrics_used_only_for_evaluation),
    node_energy_physics_prior_enabled: Boolean(evaluation.parameters?.node_energy_physics_prior_enabled),
  };
}

function groupBy(rows, keyFn) {
  const map = new Map();
  (rows ?? []).forEach((row) => {
    const key = keyFn(row);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  });
  return map;
}

function mean(values) {
  const finite = values.filter(Number.isFinite);
  return finite.length ? finite.reduce((total, value) => total + value, 0) / finite.length : 0;
}

function absoluteMean(rows, field) {
  return round(mean(rows.map((row) => Math.abs(numberValue(row[field], NaN)))), 4);
}

function equalityRate(rows, leftField, rightField) {
  if (!rows.length) return 0;
  return round(rows.filter((row) => String(row[leftField]) === String(row[rightField])).length / rows.length, 4);
}

export async function collectIntMcMetricsBySlice({ stage2Dir, groundDir }) {
  const [summaryRows, overheadRows, linkErrorRows, nodeErrorRows] = await Promise.all([
    readCsv(join(stage2Dir, "probe-summary-int-mc.csv")),
    readCsv(join(stage2Dir, "probe-int-overhead-by-slice-int-mc.csv")),
    readCsv(join(groundDir, "int-mc-link-errors.csv")),
    readCsv(join(groundDir, "int-mc-node-errors.csv")),
  ]);
  const summaryBySlice = new Map(summaryRows.map((row) => [String(row.slice_index), row]));
  const overheadBySlice = new Map(overheadRows.map((row) => [String(row.slice_index), row]));
  const linksBySlice = groupBy(linkErrorRows, (row) => String(row.slice_index));
  const nodesBySlice = groupBy(nodeErrorRows, (row) => String(row.slice_index));
  const sliceIndexes = [...new Set([
    ...summaryBySlice.keys(),
    ...overheadBySlice.keys(),
    ...linksBySlice.keys(),
    ...nodesBySlice.keys(),
  ])].sort((left, right) => Number(left) - Number(right));

  return sliceIndexes.map((sliceIndex) => {
    const summary = summaryBySlice.get(sliceIndex) ?? {};
    const overhead = overheadBySlice.get(sliceIndex) ?? {};
    const links = linksBySlice.get(sliceIndex) ?? [];
    const nodes = nodesBySlice.get(sliceIndex) ?? [];
    const inferredLinks = links.filter((row) => row.observation_source === "inferred");
    return {
      slice_index: Number(sliceIndex),
      time: summary.time ?? "",
      selected_paths: numberValue(summary.selected_paths),
      active_links: numberValue(summary.active_links),
      sampled_active_links: numberValue(summary.sampled_active_links),
      active_link_sampling_coverage: numberValue(summary.active_link_sampling_coverage),
      candidate_source: summary.candidate_source ?? "",
      planning_reuse_mode: summary.planning_reuse_mode ?? "",
      planning_cost_saved_units: numberValue(summary.planning_cost_saved_units),
      telemetry_bytes: numberValue(overhead.total_telemetry_generated_bytes),
      telemetry_energy_j: numberValue(overhead.total_telemetry_energy_j),
      hop_records: numberValue(overhead.hop_records),
      report_count: numberValue(overhead.reports),
      cpu_mae: absoluteMean(nodes, "cpu_error"),
      queue_depth_mae: absoluteMean(nodes, "queue_depth_error"),
      energy_percent_mae: absoluteMean(nodes, "energy_error"),
      node_mode_accuracy: equalityRate(nodes, "truth_mode", "mode_estimate"),
      link_utilization_mae: absoluteMean(links, "utilization_error"),
      utilization_inferred_mae: absoluteMean(inferredLinks, "utilization_error"),
      link_status_accuracy: equalityRate(links, "truth_status", "status_estimate"),
    };
  });
}

const DEFAULT_MECHANISMS = Object.freeze({
  adaptiveReuse: true,
  incrementalTopologyRepair: true,
  forecastRiskScoring: true,
  adaptiveProbeBudget: false,
  metricTensorCoupling: false,
  nodeStateCoupling: false,
  nodeEnergyPhysicsPrior: false,
  jointStateCoupling: false,
  orbitGraphRegularization: false,
  orbitPeriodicPrior: false,
  orbitPeriodicPriorSlices: 19,
  oamQualityFeedback: false,
  businessHotspotMigrationPrior: false,
  stateTensorJointCompletion: false,
  multiObjectiveBudget: false,
  oamTargetAwareMetadata: false,
});

function pushTrueFlag(args, enabled, flag) {
  if (enabled) args.push(flag, "true");
}

export async function runIntMcPass({
  label,
  truthDir,
  candidatePathsPath,
  stage2Dir,
  groundDir,
  samplingRate = FORMAL_DEFAULTS.sampling_rate,
  targetActiveLinkSamplingRate = FORMAL_DEFAULTS.target_active_link_sampling_rate,
  rank = FORMAL_DEFAULTS.rank,
  windowSize = FORMAL_DEFAULTS.window_size,
  warmupSlices = FORMAL_DEFAULTS.warmup_slices,
  iterations = FORMAL_DEFAULTS.iterations,
  downlinkBudgetBytes = 1_000_000_000,
  maxPathsPerSlice = FORMAL_DEFAULTS.max_paths_per_slice,
  observabilityMode = FORMAL_DEFAULTS.observability_mode,
  feedbackLagSlices = FORMAL_DEFAULTS.feedback_lag_slices,
  feedbackPath = "",
  controlActionsPath = "",
  plannerOamLinksPath = "",
  plannerOamNodesPath = "",
  oamTargetHopBytes = 96,
  oamTransitHopBytes = 88,
  mechanisms = {},
} = {}) {
  const flags = { ...DEFAULT_MECHANISMS, ...mechanisms };
  await Promise.all([
    mkdir(stage2Dir, { recursive: true }),
    mkdir(groundDir, { recursive: true }),
  ]);
  const timings = {};
  const predictedContactPlanPath = join(stage2Dir, "predicted-contact-plan.json");

  const contact = await runCommandTimed({
    label: `${label}: contact prediction`,
    script: "stage2-int/tools/predict-contact-plan.mjs",
    args: [
      "--input", truthDir,
      "--out", stage2Dir,
      "--completion-window-slices", String(windowSize),
    ],
  });
  timings.contact_prediction = contact.timing;

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
    "--feedback-lag-slices", String(feedbackLagSlices),
    "--adaptive-reuse", String(Boolean(flags.adaptiveReuse)),
    "--incremental-topology-repair", String(Boolean(flags.incrementalTopologyRepair)),
    "--forecast-risk-scoring", String(Boolean(flags.forecastRiskScoring)),
  ];
  if (plannerOamLinksPath) selectorArgs.push("--planner-oam-links", plannerOamLinksPath);
  if (plannerOamNodesPath) selectorArgs.push("--planner-oam-nodes", plannerOamNodesPath);
  if (feedbackPath) selectorArgs.push("--oam-priority-retest", feedbackPath);
  if (controlActionsPath) selectorArgs.push("--oam-control-actions", controlActionsPath);
  pushTrueFlag(selectorArgs, flags.adaptiveProbeBudget, "--adaptive-probe-budget");
  pushTrueFlag(selectorArgs, flags.multiObjectiveBudget, "--multi-objective-budget");
  if (flags.oamTargetAwareMetadata) {
    selectorArgs.push(
      "--oam-target-aware-metadata", "true",
      "--oam-target-hop-bytes", String(oamTargetHopBytes),
      "--oam-transit-hop-bytes", String(oamTransitHopBytes),
    );
  }
  const selection = await runCommandTimed({
    label: `${label}: path selection`,
    script: "stage2-int/tools/int-mc-path-selector.mjs",
    args: selectorArgs,
  });
  timings.path_selection = selection.timing;

  const reporting = await runCommandTimed({
    label: `${label}: reporting plan`,
    script: "stage2-int/tools/reporting-path-planner.mjs",
    args: [
      "--input", truthDir,
      "--stage2", stage2Dir,
      "--out", stage2Dir,
      "--algorithm", "int-mc",
      "--probes", join(stage2Dir, "probe-paths-int-mc.csv"),
    ],
  });
  timings.reporting_plan = reporting.timing;

  const probe = await runCommandTimed({
    label: `${label}: probe execution`,
    script: "stage2-int/tools/probe-int-runner.mjs",
    args: [
      "--input", truthDir,
      "--stage2", stage2Dir,
      "--out", stage2Dir,
      "--algorithm", "int-mc",
    ],
  });
  timings.probe_execution = probe.timing;

  const ground = await runCommandTimed({
    label: `${label}: Ground OAM`,
    script: "stage2-int/tools/ground-oam-reconstructor.mjs",
    args: [
      "--input", truthDir,
      "--stage2", stage2Dir,
      "--out", groundDir,
      "--hops", join(stage2Dir, "probe-int-hop-records-int-mc.csv"),
      "--reports", join(stage2Dir, "probe-int-reports-int-mc.csv"),
      "--downlink-budget-bytes", String(downlinkBudgetBytes),
    ],
  });
  timings.ground_oam = ground.timing;

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
  pushTrueFlag(reconstructorArgs, flags.metricTensorCoupling, "--metric-tensor-coupling");
  pushTrueFlag(reconstructorArgs, flags.nodeStateCoupling, "--node-state-coupling");
  pushTrueFlag(reconstructorArgs, flags.nodeEnergyPhysicsPrior, "--node-energy-physics-prior");
  pushTrueFlag(reconstructorArgs, flags.jointStateCoupling, "--joint-state-coupling");
  pushTrueFlag(reconstructorArgs, flags.orbitGraphRegularization, "--orbit-graph-regularization");
  if (flags.orbitPeriodicPrior) {
    reconstructorArgs.push(
      "--orbit-periodic-prior", "true",
      "--orbit-periodic-prior-slices", String(flags.orbitPeriodicPriorSlices),
    );
  }
  pushTrueFlag(reconstructorArgs, flags.oamQualityFeedback, "--oam-quality-feedback");
  pushTrueFlag(reconstructorArgs, flags.businessHotspotMigrationPrior, "--business-hotspot-migration-prior");
  pushTrueFlag(reconstructorArgs, flags.stateTensorJointCompletion, "--state-tensor-joint-completion");
  const completion = await runCommandTimed({
    label: `${label}: matrix completion`,
    script: "stage2-int/tools/int-mc-reconstructor.mjs",
    args: reconstructorArgs,
  });
  timings.matrix_completion = completion.timing;

  const metrics = await collectIntMcMetrics({ truthDir, stage2Dir, groundDir });
  return {
    metrics,
    timings,
    mechanisms: flags,
    artifacts: {
      predicted_contact_plan_json: predictedContactPlanPath,
      selector_report_json: join(stage2Dir, "probe-coverage-int-mc.json"),
      probe_paths_csv: join(stage2Dir, "probe-paths-int-mc.csv"),
      probe_summary_csv: join(stage2Dir, "probe-summary-int-mc.csv"),
      run_report_json: join(stage2Dir, "probe-int-run-report-int-mc.json"),
      ground_links_csv: join(groundDir, "ground-mc-reconstructed-links.csv"),
      ground_nodes_csv: join(groundDir, "ground-mc-reconstructed-nodes.csv"),
      evaluation_json: join(groundDir, "int-mc-evaluation.json"),
      deployable_feedback_csv: join(groundDir, "int-mc-deployable-priority-retest.csv"),
    },
  };
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

function stableHash(value) {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(value)))
    .digest("hex");
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function combineDeployableFeedback({ groundDir, outputPath }) {
  const sources = [
    {
      path: join(groundDir, "ground-oam-priority-retest.csv"),
      source: "ground-oam-direct",
    },
    {
      path: join(groundDir, "int-mc-deployable-priority-retest.csv"),
      source: "int-mc-deployable",
    },
  ];
  const rows = [];
  for (const item of sources) {
    if (!existsSync(item.path)) continue;
    const sourceRows = await readCsv(item.path);
    sourceRows.forEach((row) => {
      if (!row.target_id || numberValue(row.priority_score) <= 0) return;
      rows.push({
        ...row,
        feedback_source: item.source,
      });
    });
  }
  await writeFile(outputPath, rowsToCsv(rows), "utf8");
  return rows;
}

export async function runTwoPassVariant({
  profile,
  variant,
  truthDir,
  candidatePathsPath,
  outputDir,
  parameters = {},
  resume = true,
  sharedPass1 = null,
} = {}) {
  await mkdir(outputDir, { recursive: true });
  const manifestPath = join(outputDir, "run-manifest.json");
  const metadataPath = join(truthDir, "metadata.json");
  const [truthMetadataHash, candidatePathsHash] = await Promise.all([
    sha256File(metadataPath),
    sha256File(candidatePathsPath),
  ]);
  const normalizedParameters = {
    samplingRate: FORMAL_DEFAULTS.sampling_rate,
    targetActiveLinkSamplingRate: FORMAL_DEFAULTS.target_active_link_sampling_rate,
    rank: FORMAL_DEFAULTS.rank,
    windowSize: FORMAL_DEFAULTS.window_size,
    warmupSlices: FORMAL_DEFAULTS.warmup_slices,
    iterations: FORMAL_DEFAULTS.iterations,
    downlinkBudgetBytes: 1_000_000_000,
    maxPathsPerSlice: FORMAL_DEFAULTS.max_paths_per_slice,
    observabilityMode: FORMAL_DEFAULTS.observability_mode,
    feedbackLagSlices: FORMAL_DEFAULTS.feedback_lag_slices,
    ...parameters,
  };
  const inputFingerprint = stableHash({
    profile,
    variant,
    parameters: normalizedParameters,
    truth_metadata_sha256: truthMetadataHash,
    candidate_paths_sha256: candidatePathsHash,
    shared_pass1_fingerprint: sharedPass1?.fingerprint ?? "",
  });

  if (resume && existsSync(manifestPath)) {
    const oldManifest = await readJson(manifestPath);
    if (oldManifest.status === "complete" && oldManifest.input_fingerprint === inputFingerprint) {
      return {
        before: oldManifest.before,
        after: oldManifest.after,
        manifest: oldManifest,
        resumed: true,
      };
    }
  }

  const pass1Stage2Dir = sharedPass1?.stage2Dir ?? join(outputDir, "stage2", "int-mc-pass1");
  const pass1GroundDir = sharedPass1?.groundDir ?? join(outputDir, "ground-oam", "int-mc-pass1");
  const pass2Stage2Dir = join(outputDir, "stage2", variant.id);
  const pass2GroundDir = join(outputDir, "ground-oam", variant.id);
  await writeJson(manifestPath, {
    schema_version: "int-mc-two-pass-run-v1",
    status: "running",
    started_at: new Date().toISOString(),
    profile_id: profile.id,
    variant_id: variant.id,
    input_fingerprint: inputFingerprint,
  });

  const before = sharedPass1?.run ?? await runIntMcPass({
      label: `${profile.short_label} pass1`,
      truthDir,
      candidatePathsPath,
      stage2Dir: pass1Stage2Dir,
      groundDir: pass1GroundDir,
      ...normalizedParameters,
      mechanisms: {
        adaptiveReuse: true,
      },
    });
  const pass1Fingerprint = sharedPass1?.fingerprint ?? stableHash({
    truth_metadata_sha256: truthMetadataHash,
    candidate_paths_sha256: candidatePathsHash,
    selector_report_sha256: await sha256File(before.artifacts.selector_report_json),
    evaluation_sha256: await sha256File(before.artifacts.evaluation_json),
    parameters: normalizedParameters,
  });

  const combinedFeedbackPath = join(outputDir, "combined-int-mc-feedback.csv");
  const combinedFeedbackRows = await combineDeployableFeedback({
    groundDir: pass1GroundDir,
    outputPath: combinedFeedbackPath,
  });
  const useOamFeedback = variant.useOamFeedback !== false;
  const after = await runIntMcPass({
    label: `${profile.short_label} ${variant.id}`,
    truthDir,
    candidatePathsPath,
    stage2Dir: pass2Stage2Dir,
    groundDir: pass2GroundDir,
    ...normalizedParameters,
    feedbackPath: useOamFeedback ? combinedFeedbackPath : "",
    controlActionsPath: useOamFeedback ? join(pass1GroundDir, "ground-oam-control-actions.csv") : "",
    plannerOamLinksPath: join(pass1GroundDir, "ground-mc-reconstructed-links.csv"),
    plannerOamNodesPath: join(pass1GroundDir, "ground-mc-reconstructed-nodes.csv"),
    mechanisms: variant.mechanisms ?? {},
  });

  const manifest = {
    schema_version: "int-mc-two-pass-run-v1",
    status: "complete",
    started_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    profile_id: profile.id,
    profile_label: profile.short_label,
    variant_id: variant.id,
    variant_label: variant.label,
    input_fingerprint: inputFingerprint,
    truth_metadata_sha256: truthMetadataHash,
    candidate_paths_sha256: candidatePathsHash,
    parameters: normalizedParameters,
    mechanisms: variant.mechanisms ?? {},
    observability_mode: normalizedParameters.observabilityMode,
    feedback_lag_slices: normalizedParameters.feedbackLagSlices,
    truth_error_feedback_enabled: false,
    combined_feedback_csv: combinedFeedbackPath,
    combined_feedback_rows: combinedFeedbackRows.length,
    pass1_stage2_dir: pass1Stage2Dir,
    pass1_ground_dir: pass1GroundDir,
    pass1_fingerprint: pass1Fingerprint,
    before,
    after,
  };
  await writeJson(manifestPath, manifest);
  return { before, after, manifest, resumed: false };
}
