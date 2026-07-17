import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { cpus, freemem, platform, release, totalmem } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  FORMAL_DEFAULTS,
  PROFILE_CATALOG,
  collectIntMcMetricsBySlice,
  runCommandTimed,
  runIntMcPass,
  sha256File,
} from "./experiments/intMcExperimentCore.mjs";
import {
  auditFixedBudgetPair,
  calculateCarryoverPathValidity,
  calculatePathValidity,
  summarizePathValidity,
} from "./experiments/dynamicityExperimentMetrics.mjs";
import { transformDynamicityTrace } from "./experiments/dynamicityStress.mjs";
import {
  auditCausalReplay,
  buildControlledOutageSchedule,
  compareCausalResponse,
} from "./experiments/dynamicityCausalReplay.mjs";
import { escapeHtml, parseCsv, rowsToCsv } from "./experiments/reportUtils.mjs";

export const EXPERIMENT8_STRESS_RATES = Object.freeze([0, 0.05, 0.10, 0.15, 0.20, 0.25]);

const EXPERIMENT8_IMPLEMENTATION_FILES = Object.freeze([
  "scripts/experiments/intMcExperimentCore.mjs",
  "scripts/experiments/dynamicityStress.mjs",
  "scripts/experiments/dynamicityCausalReplay.mjs",
  "stage2-int/tools/int-mc-path-selector.mjs",
  "stage2-int/tools/reporting-path-planner.mjs",
  "stage2-int/tools/probe-int-runner.mjs",
  "stage2-int/tools/telemetry-byte-budget.mjs",
  "stage2-int/tools/reporting-interruption.mjs",
  "stage2-int/tools/int-mc-reconstructor.mjs",
  "stage2-int/tools/ground-oam-reconstructor.mjs",
  "stage2-int/tools/predict-contact-plan.mjs",
]);

export async function experiment8ImplementationFingerprint() {
  const hash = createHash("sha256");
  for (const path of EXPERIMENT8_IMPLEMENTATION_FILES) {
    hash.update(path);
    hash.update("\0");
    hash.update(await readFile(resolve(path)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function experiment8ParametersFingerprint(parameters = {}) {
  const ordered = Object.fromEntries(Object.entries(parameters).sort(([left], [right]) => left.localeCompare(right)));
  return createHash("sha256").update(JSON.stringify(ordered)).digest("hex");
}

const NATIVE_MECHANISMS = Object.freeze({
  adaptiveReuse: false,
  incrementalTopologyRepair: false,
  forecastRiskScoring: false,
  topologyVersionedObjective: false,
  adaptiveProbeBudget: false,
  metricTensorCoupling: false,
  nodeStateCoupling: false,
  nodeEnergyPhysicsPrior: false,
  jointStateCoupling: false,
  orbitGraphRegularization: false,
  orbitPeriodicPrior: false,
  oamQualityFeedback: false,
  businessHotspotMigrationPrior: false,
  stateTensorJointCompletion: false,
  multiObjectiveBudget: false,
  oamTargetAwareMetadata: false,
});

const ENHANCED_MECHANISMS = Object.freeze({
  adaptiveReuse: true,
  incrementalTopologyRepair: true,
  forecastRiskScoring: true,
  topologyVersionedObjective: true,
  adaptiveProbeBudget: false,
  metricTensorCoupling: true,
  nodeStateCoupling: true,
  nodeEnergyPhysicsPrior: true,
  jointStateCoupling: true,
  orbitGraphRegularization: true,
  orbitPeriodicPrior: true,
  orbitPeriodicPriorSlices: 19,
  oamQualityFeedback: false,
  businessHotspotMigrationPrior: true,
  stateTensorJointCompletion: true,
  multiObjectiveBudget: false,
  oamTargetAwareMetadata: false,
});

export function methodDefinitions() {
  return [
    { id: "native", label: "原生 INT-MC", mechanisms: NATIVE_MECHANISMS },
    { id: "enhanced", label: "增强 LEO-INT-MC", mechanisms: ENHANCED_MECHANISMS },
  ];
}

export function refreshCompletionManifest({
  manifest,
  completion,
  implementationFingerprint,
  refreshedAt = new Date().toISOString(),
} = {}) {
  return {
    ...manifest,
    generated_at: refreshedAt,
    implementation_fingerprint: implementationFingerprint,
    refresh: {
      scope: "matrix-completion-only",
      refreshed_at: refreshedAt,
      preserved_stages: ["contact_prediction", "path_selection", "reporting_plan", "probe_execution", "ground_oam"],
    },
    run: {
      ...manifest.run,
      metrics: completion.metrics,
      timings: {
        ...manifest.run?.timings,
        matrix_completion: completion.timing,
      },
      artifacts: {
        ...manifest.run?.artifacts,
        ...completion.artifacts,
      },
    },
  };
}

export function buildExperiment8Matrix({
  profileIds = PROFILE_CATALOG.map((row) => row.id),
  stressRates = EXPERIMENT8_STRESS_RATES,
  methodIds = methodDefinitions().map((row) => row.id),
} = {}) {
  return profileIds.flatMap((profileId) =>
    stressRates.flatMap((stressRate) =>
      methodIds.map((methodId) => ({ profile_id: profileId, stress_rate: stressRate, method_id: methodId })),
    ),
  );
}

function numberValue(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value, digits = 4) {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function mean(values) {
  const finite = values.filter(Number.isFinite);
  return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : 0;
}

function linearSlope(rows, xField, yField) {
  const points = rows
    .map((row) => ({ x: numberValue(row[xField], NaN), y: numberValue(row[yField], NaN) }))
    .filter((row) => Number.isFinite(row.x) && Number.isFinite(row.y));
  if (points.length < 2) return 0;
  const xMean = mean(points.map((point) => point.x));
  const yMean = mean(points.map((point) => point.y));
  const covariance = points.reduce((sum, point) => sum + (point.x - xMean) * (point.y - yMean), 0);
  const variance = points.reduce((sum, point) => sum + (point.x - xMean) ** 2, 0);
  return variance > 0 ? covariance / variance : 0;
}

function slopeRows(summaryRows) {
  const metrics = [
    "cpu_mae",
    "queue_depth_mae",
    "energy_percent_mae",
    "link_utilization_mae",
    "path_failure_ratio",
    "carryover_path_failure_ratio",
    "planning_wall_time_ms",
  ];
  const result = [];
  for (const profile of PROFILE_CATALOG) {
    for (const method of methodDefinitions()) {
      const rows = summaryRows.filter((row) => row.constellation_profile_id === profile.id && row.method_id === method.id);
      metrics.forEach((metric) => result.push({
        constellation_profile_id: profile.id,
        constellation_label: profile.short_label,
        method_id: method.id,
        method_label: method.label,
        metric,
        stress_slope: round(linearSlope(rows, "achieved_stress_rate", metric), 6),
        actual_dynamicity_slope: round(linearSlope(rows, "achieved_mean_dynamicity", metric), 6),
      }));
    }
  }
  return result;
}

function buildLowHighRows(summaryRows = []) {
  const result = [];
  for (const profile of [...new Set(summaryRows.map((row) => row.constellation_label))]) {
    for (const method of [...new Set(summaryRows.filter((row) => row.constellation_label === profile).map((row) => row.method_label))]) {
      const rows = summaryRows
        .filter((row) => row.constellation_label === profile && row.method_label === method)
        .sort((left, right) => numberValue(left.achieved_stress_rate) - numberValue(right.achieved_stress_rate));
      if (rows.length < 2) continue;
      const low = rows[0];
      const high = rows.at(-1);
      result.push({
        constellation_label: profile,
        method_label: method,
        low_stress_rate: low.achieved_stress_rate,
        high_stress_rate: high.achieved_stress_rate,
        dynamicity_delta: round(high.achieved_mean_dynamicity - low.achieved_mean_dynamicity, 6),
        carryover_path_failure_delta: round(high.carryover_path_failure_ratio - low.carryover_path_failure_ratio, 6),
        cpu_mae_delta: round(high.cpu_mae - low.cpu_mae, 6),
        queue_depth_mae_delta: round(high.queue_depth_mae - low.queue_depth_mae, 6),
        energy_percent_mae_delta: round(high.energy_percent_mae - low.energy_percent_mae, 6),
        link_utilization_mae_delta: round(high.link_utilization_mae - low.link_utilization_mae, 6),
        telemetry_bytes_per_node_slice_delta: round(high.telemetry_bytes_per_node_slice - low.telemetry_bytes_per_node_slice, 6),
        fresh_slice_plans_at_high: high.fresh_slice_plans,
        reused_slice_plans_at_low: low.reused_slice_plans,
      });
    }
  }
  return result;
}

function buildNegativeResults(summaryRows = []) {
  const metrics = [
    ["CPU MAE", "cpu_mae"],
    ["队列 MAE", "queue_depth_mae"],
    ["电量 MAE", "energy_percent_mae"],
    ["链路利用率 MAE", "link_utilization_mae"],
    ["遥测字节/节点/片", "telemetry_bytes_per_node_slice"],
    ["规划时间", "planning_wall_time_ms"],
  ];
  const result = [];
  for (const profile of [...new Set(summaryRows.map((row) => row.constellation_label))]) {
    const rows = summaryRows.filter((row) => row.constellation_label === profile);
    const maximumStress = Math.max(...rows.map((row) => numberValue(row.achieved_stress_rate)));
    const native = rows.find((row) => row.method_id === "native" && numberValue(row.achieved_stress_rate) === maximumStress);
    const enhanced = rows.find((row) => row.method_id === "enhanced" && numberValue(row.achieved_stress_rate) === maximumStress);
    if (!native || !enhanced) continue;
    metrics.forEach(([label, field]) => {
      const delta = numberValue(enhanced[field]) - numberValue(native[field]);
      if (delta <= 0) return;
      result.push({
        constellation_label: profile,
        stress_rate: maximumStress,
        metric: label,
        native_value: numberValue(native[field]),
        enhanced_value: numberValue(enhanced[field]),
        enhanced_minus_native: round(delta, 6),
        interpretation: "增强方法在该指标上未优于原生方法",
      });
    });
  }
  return result;
}

function lowHighHtml(rows = []) {
  const body = rows.map((row) => `<tr><td>${escapeHtml(row.constellation_label)}</td><td>${escapeHtml(row.method_label)}</td><td>${row.dynamicity_delta}</td><td>${row.carryover_path_failure_delta}</td><td>${row.cpu_mae_delta}</td><td>${row.queue_depth_mae_delta}</td><td>${row.energy_percent_mae_delta}</td><td>${row.link_utilization_mae_delta}</td><td>${row.reused_slice_plans_at_low}</td><td>${row.fresh_slice_plans_at_high}</td></tr>`).join("");
  return `<table><thead><tr><th>星座</th><th>方法</th><th>实际动态性 Δ</th><th>跨片失效 Δ</th><th>CPU MAE Δ</th><th>队列 MAE Δ</th><th>电量 MAE Δ</th><th>利用率 MAE Δ</th><th>低扰动复用片</th><th>高扰动新规划片</th></tr></thead><tbody>${body}</tbody></table>`;
}

function negativeHtml(rows = []) {
  if (!rows.length) return "<p>最高扰动档未发现增强方法高于原生方法的误差或开销项。</p>";
  return `<table><thead><tr><th>星座</th><th>指标</th><th>原生</th><th>增强</th><th>增强-原生</th><th>解释</th></tr></thead><tbody>${rows.map((row) => `<tr><td>${escapeHtml(row.constellation_label)}</td><td>${escapeHtml(row.metric)}</td><td>${row.native_value}</td><td>${row.enhanced_value}</td><td>${row.enhanced_minus_native}</td><td>${escapeHtml(row.interpretation)}</td></tr>`).join("")}</tbody></table>`;
}

function markdownTable(rows = []) {
  if (!rows.length) return "暂无可比较的低高扰动对。";
  return `| 星座 | 方法 | 动态性 Δ | 跨片失效 Δ | CPU MAE Δ | 队列 MAE Δ | 电量 MAE Δ | 利用率 MAE Δ |\n|---|---|---:|---:|---:|---:|---:|---:|\n${rows.map((row) => `| ${row.constellation_label} | ${row.method_label} | ${row.dynamicity_delta} | ${row.carryover_path_failure_delta} | ${row.cpu_mae_delta} | ${row.queue_depth_mae_delta} | ${row.energy_percent_mae_delta} | ${row.link_utilization_mae_delta} |`).join("\n")}`;
}

function negativeMarkdown(rows = []) {
  if (!rows.length) return "最高扰动档未发现增强方法高于原生方法的误差或开销项。";
  return `| 星座 | 指标 | 原生 | 增强 | 增强-原生 |\n|---|---|---:|---:|---:|\n${rows.map((row) => `| ${row.constellation_label} | ${row.metric} | ${row.native_value} | ${row.enhanced_value} | ${row.enhanced_minus_native} |`).join("\n")}`;
}

function argValue(args, name, fallback = "") {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1] ?? fallback;
}

function listArg(args, name, fallback) {
  const raw = argValue(args, name, "");
  return raw ? raw.split(",").map((value) => value.trim()).filter(Boolean) : fallback;
}

function numberArg(args, name, fallback) {
  const raw = argValue(args, name, "");
  return raw === "" ? fallback : numberValue(raw, fallback);
}

export function parseExperiment8CliParameters(args = []) {
  const samplingRate = numberArg(args, "--sampling-rate", FORMAL_DEFAULTS.sampling_rate);
  return {
    samplingRate,
    targetActiveLinkSamplingRate: numberArg(args, "--target-active-link-sampling-rate", samplingRate),
    maxPathsPerSlice: Math.max(1, Math.floor(numberArg(args, "--max-paths-per-slice", FORMAL_DEFAULTS.max_paths_per_slice))),
    reportingInterruptionRate: Math.max(0, Math.min(1, numberArg(args, "--reporting-interruption-rate", 0))),
    telemetryByteBudgetPerNodeSlice: Math.max(0, numberArg(args, "--telemetry-byte-budget-per-node-slice", 0)),
    telemetryByteBudgetPadToCap: argValue(args, "--telemetry-byte-budget-pad-to-cap", "false").toLowerCase() === "true",
    tolerance: numberArg(args, "--tolerance", 0.01),
  };
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

function safeRateId(rate) {
  return `stress-${String(Math.round(rate * 100)).padStart(2, "0")}`;
}

function comparablePath(path) {
  const normalized = resolve(String(path ?? ""));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function stressTruthCacheMatches({
  cachedMetadata,
  sourceMetadata,
  sourceTruthDir,
  targetStressRate,
  seed,
} = {}) {
  const stress = cachedMetadata?.experiment8_controlled_stress;
  return Boolean(
    stress?.causal_replay === true &&
    stress.seed === seed &&
    Math.abs(numberValue(stress.target_stress_rate, NaN) - numberValue(targetStressRate, NaN)) <= 1e-9 &&
    comparablePath(stress.source_truth_dir) === comparablePath(sourceTruthDir) &&
    cachedMetadata?.config_fingerprint === sourceMetadata?.config_fingerprint &&
    cachedMetadata?.dataset_fingerprint === sourceMetadata?.dataset_fingerprint
  );
}

async function loadCachedStressTruth({ outputDir, metadataPath, linksPath }) {
  const [links, metadata, summary, mutations, bySlice, outageSchedule] = await Promise.all([
    readCsv(linksPath),
    readJson(metadataPath),
    readJson(join(outputDir, "experiment8-dynamicity.json")),
    readCsv(join(outputDir, "experiment8-mutations.csv")),
    readCsv(join(outputDir, "experiment8-dynamicity-by-slice.csv")),
    readJson(join(outputDir, "experiment8-outage-schedule.json")),
  ]);
  const controlled = metadata.experiment8_controlled_stress;
  return {
    summary,
    mutations,
    bySlice,
    links,
    truth_dir: outputDir,
    outage_schedule: outageSchedule,
    causal_audit: controlled.causal_audit,
    causal_response: controlled.causal_response,
    causal_replay_timing: {
      label: "experiment8 causal Stage-1 replay (cached)",
      wall_time_ms: 0,
      resumed: true,
    },
    metadata_sha256: await sha256File(metadataPath),
    links_sha256: await sha256File(linksPath),
  };
}

async function prepareStressTruth({
  sourceTruthDir,
  outputDir,
  targetStressRate,
  seed,
  tolerance,
  constellationProfileId,
  resume = true,
}) {
  const linksPath = join(outputDir, "links.csv");
  const metadataPath = join(outputDir, "metadata.json");
  const sourceMetadata = await readJson(join(sourceTruthDir, "metadata.json"));
  const cacheFiles = [
    linksPath,
    metadataPath,
    join(outputDir, "experiment8-dynamicity.json"),
    join(outputDir, "experiment8-mutations.csv"),
    join(outputDir, "experiment8-dynamicity-by-slice.csv"),
    join(outputDir, "experiment8-outage-schedule.json"),
  ];
  if (resume && cacheFiles.every(existsSync)) {
    const cachedMetadata = await readJson(metadataPath);
    if (stressTruthCacheMatches({ cachedMetadata, sourceMetadata, sourceTruthDir, targetStressRate, seed })) {
      return loadCachedStressTruth({ outputDir, metadataPath, linksPath });
    }
  }

  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  const [sourceLinks, sourceNodes, sourceRoutes] = await Promise.all([
    readCsv(join(sourceTruthDir, "links.csv")),
    readCsv(join(sourceTruthDir, "nodes.csv")),
    readCsv(join(sourceTruthDir, "routes.csv")),
  ]);
  const transformed = transformDynamicityTrace({ links: sourceLinks, targetStressRate, seed, tolerance });
  const outageSchedule = buildControlledOutageSchedule(transformed.links);
  const outageSchedulePath = join(outputDir, "experiment8-outage-schedule.json");
  await writeJson(outageSchedulePath, outageSchedule);
  const replay = await runCommandTimed({
    label: `experiment8 causal Stage-1 replay ${constellationProfileId} ${targetStressRate}`,
    script: "scripts/exportScenario.mjs",
    args: [
      "--profile", sourceMetadata.traffic_profile || "normal",
      "--constellation-profile", constellationProfileId,
      "--orbit", sourceMetadata.orbit_model || "real-tle-sgp4",
      "--mode", sourceMetadata.simulation_mode || "operational",
      "--routing", sourceMetadata.routing_algorithm || "congestion-aware-shortest-path",
      "--slices", String(sourceMetadata.slice_count || FORMAL_DEFAULTS.slice_count),
      "--link-outage-schedule", outageSchedulePath,
      "--out", outputDir,
    ],
  });
  const [links, nodes, routes, taskTraces, metadata] = await Promise.all([
    readCsv(linksPath),
    readCsv(join(outputDir, "nodes.csv")),
    readCsv(join(outputDir, "routes.csv")),
    readCsv(join(outputDir, "task-traces.csv")),
    readJson(metadataPath),
  ]);
  const causalAudit = auditCausalReplay({ links, routes, taskTraces });
  if (!causalAudit.ok) {
    throw new Error(`Experiment 8 causal replay audit failed: ${causalAudit.violations.join("; ")}`);
  }
  if (metadata.config_fingerprint !== sourceMetadata.config_fingerprint || metadata.dataset_fingerprint !== sourceMetadata.dataset_fingerprint) {
    throw new Error("Experiment 8 causal replay changed the Stage-1 config or workload fingerprint");
  }
  const causalResponse = compareCausalResponse({
    baselineNodes: sourceNodes,
    replayNodes: nodes,
    baselineLinks: sourceLinks,
    replayLinks: links,
    baselineRoutes: sourceRoutes,
    replayRoutes: routes,
  });
  metadata.experiment8_controlled_stress = {
    seed,
    target_stress_rate: targetStressRate,
    achieved_stress_rate: transformed.summary.achieved_stress_rate,
    achieved_mean_dynamicity: transformed.summary.achieved_mean_dynamicity,
    source_truth_dir: resolve(sourceTruthDir),
    causal_replay: true,
    causal_replay_wall_time_ms: replay.timing.wall_time_ms,
    causal_audit: causalAudit,
    causal_response: causalResponse,
  };
  await Promise.all([
    writeJson(metadataPath, metadata),
    writeFile(join(outputDir, "experiment8-mutations.csv"), rowsToCsv(transformed.mutations), "utf8"),
    writeFile(join(outputDir, "experiment8-dynamicity-by-slice.csv"), rowsToCsv(transformed.bySlice), "utf8"),
    writeJson(join(outputDir, "experiment8-dynamicity.json"), transformed.summary),
  ]);
  return {
    ...transformed,
    links,
    truth_dir: outputDir,
    outage_schedule: outageSchedule,
    causal_audit: causalAudit,
    causal_response: causalResponse,
    causal_replay_timing: replay.timing,
    metadata_sha256: await sha256File(metadataPath),
    links_sha256: await sha256File(linksPath),
  };
}

function reportingSummary(rows) {
  const interrupted = rows.filter((row) => {
    const status = String(row.reporting_status ?? row.status ?? "").toLowerCase();
    return status.includes("unavailable") || status.includes("drop") || status.includes("interrupt") || status.includes("failed");
  }).length;
  return {
    reporting_records: rows.length,
    reporting_interrupted: interrupted,
    reporting_path_interruption_ratio: rows.length ? interrupted / rows.length : 0,
  };
}

function hotspotMigrationSpeed(taskRows) {
  const bySlice = new Map();
  taskRows.forEach((row) => {
    const slice = numberValue(row.slice_index);
    const match = String(row.source ?? "").match(/^P(\d+)-S(\d+)$/i);
    if (!match) return;
    const values = bySlice.get(slice) ?? [];
    values.push({ plane: Number(match[1]), slot: Number(match[2]), weight: Math.max(numberValue(row.traffic_mbps, 1), 1) });
    bySlice.set(slice, values);
  });
  const centroids = [...bySlice.entries()].sort((a, b) => a[0] - b[0]).map(([slice, rows]) => {
    const weight = rows.reduce((sum, row) => sum + row.weight, 0);
    return {
      slice,
      plane: rows.reduce((sum, row) => sum + row.plane * row.weight, 0) / weight,
      slot: rows.reduce((sum, row) => sum + row.slot * row.weight, 0) / weight,
    };
  });
  return mean(centroids.slice(1).map((row, index) =>
    Math.hypot(row.plane - centroids[index].plane, row.slot - centroids[index].slot),
  ));
}

function polarDisconnectionRatio(links) {
  const interPlane = links.filter((row) => row.kind === "inter-plane");
  const polar = interPlane.filter((row) => String(row.restriction_reason ?? "").toLowerCase().includes("polar"));
  return interPlane.length ? polar.length / interPlane.length : 0;
}

function fairnessView({ metadataHash, linksHash, candidateHash, parameters }) {
  return {
    truth_metadata_sha256: metadataHash,
    truth_links_sha256: linksHash,
    candidate_paths_sha256: candidateHash,
    parameters: {
      samplingRate: parameters.samplingRate,
      targetActiveLinkSamplingRate: parameters.targetActiveLinkSamplingRate,
      maxPathsPerSlice: parameters.maxPathsPerSlice,
      downlinkBudgetBytes: parameters.downlinkBudgetBytes,
      rank: parameters.rank,
      windowSize: parameters.windowSize,
      warmupSlices: parameters.warmupSlices,
      iterations: parameters.iterations,
      observabilityMode: parameters.observabilityMode,
      feedbackLagSlices: parameters.feedbackLagSlices,
      reportingInterruptionRate: parameters.reportingInterruptionRate,
      reportingInterruptionSeed: parameters.reportingInterruptionSeed,
      telemetryByteBudgetPerNodeSlice: parameters.telemetryByteBudgetPerNodeSlice,
      telemetryByteBudgetPadToCap: parameters.telemetryByteBudgetPadToCap,
      telemetryFieldsHash: parameters.telemetryFieldsHash ?? null,
    },
  };
}

function planningWallTime(run) {
  return round(
    numberValue(run.timings?.contact_prediction?.wall_time_ms) +
    numberValue(run.timings?.path_selection?.wall_time_ms) +
    numberValue(run.timings?.reporting_plan?.wall_time_ms),
  );
}

function summaryRow({ profile, method, stress, run, validity, carryoverValidity, candidateValidity, reporting, hotspotSpeed }) {
  const metrics = run.metrics;
  return {
    constellation_profile_id: profile.id,
    constellation_label: profile.short_label,
    scale: profile.scale,
    node_count: profile.node_count,
    method_id: method.id,
    method_label: method.label,
    target_stress_rate: stress.summary.target_stress_rate,
    achieved_stress_rate: round(stress.summary.achieved_stress_rate, 6),
    achieved_mean_dynamicity: round(stress.summary.achieved_mean_dynamicity, 6),
    mean_jaccard_similarity: round(stress.summary.mean_jaccard_similarity, 6),
    controlled_mutations: stress.summary.mutation_count,
    mean_forced_down_fraction: round(stress.summary.mean_forced_down_fraction, 6),
    causal_replay: true,
    causal_replay_wall_time_ms: stress.causal_replay_timing.wall_time_ms,
    causal_invalid_routes: stress.causal_audit.invalid_route_count,
    causal_invalid_task_traces: stress.causal_audit.invalid_task_trace_count,
    causal_changed_node_ratio: round(stress.causal_response.changed_node_ratio, 6),
    causal_changed_link_ratio: round(stress.causal_response.changed_link_ratio, 6),
    causal_changed_route_ratio: round(stress.causal_response.changed_route_ratio, 6),
    polar_disconnection_ratio: round(polarDisconnectionRatio(stress.links), 6),
    business_hotspot_migration_speed: round(hotspotSpeed, 6),
    ...reporting,
    candidate_path_failure_ratio: candidateValidity.path_failure_ratio,
    candidate_invalidated_paths: candidateValidity.invalidated_paths,
    carryover_path_failure_ratio: carryoverValidity.path_failure_ratio,
    carryover_invalidated_paths: carryoverValidity.invalidated_paths,
    ...validity,
    slice_count: metrics.slice_count,
    active_link_direct_coverage: metrics.active_link_direct_coverage,
    active_link_effective_coverage: metrics.active_link_effective_coverage,
    telemetry_bytes_per_node_slice: metrics.telemetry_bytes_per_node_slice,
    total_telemetry_generated_bytes: metrics.total_telemetry_generated_bytes,
    total_telemetry_energy_j: metrics.total_telemetry_energy_j,
    planned_selected_paths: metrics.planned_selected_paths,
    selected_paths: metrics.selected_paths,
    telemetry_byte_budget_enabled: metrics.telemetry_byte_budget_enabled,
    telemetry_byte_budget_per_node_slice: metrics.telemetry_byte_budget_per_node_slice,
    telemetry_byte_budget_pad_to_cap: metrics.telemetry_byte_budget_pad_to_cap,
    telemetry_byte_budget_padding_bytes: metrics.telemetry_byte_budget_padding_bytes,
    telemetry_padding_bytes_per_node_slice: metrics.telemetry_padding_bytes_per_node_slice,
    telemetry_byte_budget_total_cap_bytes: metrics.telemetry_byte_budget_total_cap_bytes,
    telemetry_byte_budget_utilization: round(metrics.telemetry_byte_budget_utilization, 6),
    telemetry_byte_budget_rejected_probe_paths: metrics.telemetry_byte_budget_rejected_probe_paths,
    telemetry_byte_budget_cap_violations: metrics.telemetry_byte_budget_cap_violations,
    cpu_mae: metrics.cpu_mae,
    queue_depth_mae: metrics.queue_depth_mae,
    energy_percent_mae: metrics.energy_percent_mae,
    node_mode_accuracy: metrics.node_mode_accuracy,
    link_utilization_mae: metrics.link_utilization_mae,
    link_status_accuracy: metrics.link_status_accuracy,
    reused_slice_plans: metrics.reused_slice_plans,
    fresh_slice_plans: metrics.fresh_slice_plans,
    planning_local_repair_slices: metrics.planning_local_repair_slices,
    planning_oam_forced_replan_slices: metrics.planning_oam_forced_replan_slices,
    planning_wall_time_ms: planningWallTime(run),
    reconstruction_wall_time_ms: numberValue(run.timings?.matrix_completion?.wall_time_ms),
    causal_feedback_violations: metrics.causal_feedback_violations,
    truth_metrics_used_only_for_evaluation: metrics.truth_metrics_used_only_for_evaluation,
  };
}

function chart(rows, yField, title) {
  const width = 900;
  const height = 320;
  const margin = 48;
  const values = rows.map((row) => numberValue(row[yField])).filter(Number.isFinite);
  const maximum = Math.max(...values, 1e-9);
  const xValues = rows.map((row) => numberValue(row.achieved_stress_rate)).filter(Number.isFinite);
  const xMin = Math.min(...xValues, 0);
  const xMax = Math.max(...xValues, 0.25);
  const x = (value) => margin + (width - margin * 2) * ((value - xMin) / Math.max(xMax - xMin, 1e-9));
  const y = (value) => height - margin - (height - margin * 2) * (value / maximum);
  const groups = new Map();
  rows.forEach((row) => {
    const key = `${row.constellation_label}/${row.method_label}`;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  });
  const colors = ["#155e75", "#dc2626", "#15803d", "#9333ea", "#b45309", "#475569"];
  const lines = [...groups.entries()].map(([label, group], index) => {
    const sorted = group.sort((a, b) => a.achieved_stress_rate - b.achieved_stress_rate);
    const points = sorted.map((row) => `${x(row.achieved_stress_rate)},${y(numberValue(row[yField]))}`).join(" ");
    return `<polyline fill="none" stroke="${colors[index % colors.length]}" stroke-width="2" points="${points}"><title>${escapeHtml(label)}</title></polyline>`;
  }).join("");
  return `<h3>${escapeHtml(title)}</h3><svg viewBox="0 0 ${width} ${height}" role="img"><line x1="${margin}" y1="${height-margin}" x2="${width-margin}" y2="${height-margin}" stroke="#64748b"/><line x1="${margin}" y1="${margin}" x2="${margin}" y2="${height-margin}" stroke="#64748b"/>${lines}<text x="${width/2}" y="${height-8}" text-anchor="middle">附加轨间扰动率</text></svg>`;
}

function resultTable(rows) {
  return rows.map((row) => `<tr><td>${escapeHtml(row.constellation_label)}</td><td>${escapeHtml(row.method_label)}</td><td>${round(row.achieved_stress_rate)}</td><td>${round(row.achieved_mean_dynamicity)}</td><td>${round(row.telemetry_bytes_per_node_slice)}</td><td>${round(row.cpu_mae)}</td><td>${round(row.queue_depth_mae)}</td><td>${round(row.energy_percent_mae)}</td><td>${round(row.link_utilization_mae)}</td><td>${round(row.link_status_accuracy)}</td><td>${round(row.candidate_path_failure_ratio)}</td><td>${round(row.carryover_path_failure_ratio)}</td><td>${round(row.path_failure_ratio)}</td><td>${round(row.fresh_slice_plans)}</td><td>${round(row.planning_wall_time_ms)}</td></tr>`).join("");
}

function causalReplaySummary(rows = []) {
  const replayRows = rows.filter((row) => row.causal_replay === true || String(row.causal_replay) === "true");
  return {
    replay_rows: replayRows.length,
    invalid_routes: replayRows.reduce((sum, row) => sum + numberValue(row.causal_invalid_routes), 0),
    invalid_task_traces: replayRows.reduce((sum, row) => sum + numberValue(row.causal_invalid_task_traces), 0),
    changed_node_ratio: round(mean(replayRows.map((row) => numberValue(row.causal_changed_node_ratio))), 6),
    changed_link_ratio: round(mean(replayRows.map((row) => numberValue(row.causal_changed_link_ratio))), 6),
    changed_route_ratio: round(mean(replayRows.map((row) => numberValue(row.causal_changed_route_ratio))), 6),
  };
}

function buildExperiment8HtmlLegacy({ parameters = {}, summaryRows = [], fairnessAudits = [], slopeRows: slopes = [] } = {}) {
  const fairnessPassed = fairnessAudits.filter((row) => row.ok).length;
  const lowHigh = buildLowHighRows(summaryRows);
  const negatives = buildNegativeResults(summaryRows);
  const causal = causalReplaySummary(summaryRows);
  return `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>实验8 LEO动态性因果实验</title><style>body{font-family:Arial,"Microsoft YaHei",sans-serif;margin:0;background:#f3f6f7;color:#17212b}main{max-width:1240px;margin:auto;padding:28px}section{background:#fff;border:1px solid #d6e0e4;margin:16px 0;padding:18px;border-radius:6px}table{border-collapse:collapse;width:100%;font-size:12px}th,td{border:1px solid #d6e0e4;padding:6px;text-align:right}th:first-child,td:first-child,th:nth-child(2),td:nth-child(2){text-align:left}svg{width:100%;height:auto}.note{color:#526672}</style></head><body><main><h1>实验 8：原生 INT-MC 的 LEO 动态性因果检验</h1><section><h2>实验定义</h2><p>横轴是固定轨间压力池中每片发生成员交换的受控 churn rate；各档保持相同平均链路密度，Jaccard 动态性是实际观测结果。这样不会把“链路更少”和“拓扑变化更快”混为同一个变量，也不会强行恢复物理不可用链路。</p><p>固定采样预算：采样率 ${parameters.sampling_rate ?? parameters.samplingRate ?? ""}，每片最多 ${parameters.max_paths_per_slice ?? parameters.maxPathsPerSlice ?? ""} 条路径。公平性审计 ${fairnessPassed}/${fairnessAudits.length} 通过。</p></section><section><h2>综合结果</h2><table><thead><tr><th>星座</th><th>方法</th><th>扰动率</th><th>实际动态性</th><th>B/节点/片</th><th>CPU MAE</th><th>队列 MAE</th><th>电量 MAE</th><th>利用率 MAE</th><th>链路状态准确率</th><th>候选路径失效率</th><th>跨片计划失效率</th><th>最终路径失效率</th><th>新规划片数</th><th>规划时间 ms</th></tr></thead><tbody>${resultTable(summaryRows)}</tbody></table></section><section><h2>低扰动到高扰动的变化</h2><p>正的误差 Δ 表示指标在高动态性下变差；跨片失效 Δ 直接反映旧 probe plan 对动态拓扑的敏感性。</p>${lowHighHtml(lowHigh)}</section><section>${chart(summaryRows,"link_utilization_mae","扰动率—链路利用率误差")}</section><section>${chart(summaryRows,"candidate_path_failure_ratio","扰动率—候选路径失效率")}</section><section>${chart(summaryRows,"carryover_path_failure_ratio","扰动率—跨片计划失效率")}</section><section>${chart(summaryRows,"path_failure_ratio","扰动率—最终路径失效率")}</section><section>${chart(summaryRows,"planning_wall_time_ms","扰动率—规划开销")}</section><section><h2>稳定性斜率</h2><p>斜率越小，表示指标随动态性增长越慢。完整数据保存在 JSON/CSV 中，共 ${slopes.length} 条斜率记录。</p></section><section><h2>负结果与边界</h2>${negativeHtml(negatives)}<p class="note">本实验是同一卫星真值上的受控压力因果实验，不是运营商真实故障记录。负结果和增强方法退化项不会删除。</p></section></main></body></html>`;
}

function buildExperiment8MarkdownLegacy({ parameters = {}, summaryRows = [], fairnessAudits = [], slopeRows: slopes = [] } = {}) {
  const lowHigh = buildLowHighRows(summaryRows);
  const negatives = buildNegativeResults(summaryRows);
  const causal = causalReplaySummary(summaryRows);
  return `# 实验 8：LEO 动态性因果检验\n\n## 目的\n\n在固定采样预算和相同平均链路密度下，逐步增加 5%–25% 的受控轨间 churn，比较原生 INT-MC 与增强 LEO-INT-MC 的节点/链路重构误差、路径失效和重新规划开销。\n\n## 口径\n\n- 采样率：${parameters.sampling_rate ?? parameters.samplingRate ?? ""}\n- 每时间片路径上限：${parameters.max_paths_per_slice ?? parameters.maxPathsPerSlice ?? ""}\n- 方法级结果：${summaryRows.length} 条\n- 公平性审计：${fairnessAudits.filter((row) => row.ok).length}/${fairnessAudits.length} 通过\n- 稳定性斜率：${slopes.length} 条\n\n受控 churn 是实验控制剂量，强制下线密度保持不变，实际拓扑变化使用 Jaccard 动态性另行记录。实验不会强行恢复物理上不可用的链路。\n\n## 低扰动到高扰动的变化\n\n${markdownTable(lowHigh)}\n\n跨片计划失效率的上升说明旧 probe plan 会随着拓扑 churn 失效。最终路径失效率为零时，表示方法通过新规划或局部修复保证了执行合法性，不代表旧计划仍然有效。\n\n## 负结果与边界\n\n${negativeMarkdown(negatives)}\n\n报告保留所有负结果，不预设增强方法必然优于原生方法。只有在相同输入指纹、固定采样预算和无真值泄漏审计均通过后，才比较误差斜率与开销。\n\n## 产物\n\n- [HTML 可视化](reports/experiment8-dynamicity-causality/experiment8-dynamicity-report.html)\n- [汇总 CSV](reports/experiment8-dynamicity-causality/experiment8-dynamicity-summary.csv)\n- [逐片 CSV](reports/experiment8-dynamicity-causality/experiment8-dynamicity-by-slice.csv)\n- [变换审计 CSV](reports/experiment8-dynamicity-causality/experiment8-dynamicity-mutations.csv)\n`;
}

function buildExperiment8HtmlBase({ parameters = {}, summaryRows = [], fairnessAudits = [], slopeRows: slopes = [] } = {}) {
  const fairnessPassed = fairnessAudits.filter((row) => row.ok).length;
  const lowHigh = buildLowHighRows(summaryRows);
  const negatives = buildNegativeResults(summaryRows);
  const causal = causalReplaySummary(summaryRows);
  return `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>实验8 LEO动态性因果实验</title><style>body{font-family:Arial,"Microsoft YaHei",sans-serif;margin:0;background:#f3f6f7;color:#17212b}main{max-width:1240px;margin:auto;padding:28px}section{background:#fff;border:1px solid #d6e0e4;margin:16px 0;padding:18px;border-radius:6px}table{border-collapse:collapse;width:100%;font-size:12px}th,td{border:1px solid #d6e0e4;padding:6px;text-align:right}th:first-child,td:first-child,th:nth-child(2),td:nth-child(2){text-align:left}svg{width:100%;height:auto}.note{color:#526672}</style></head><body><main><h1>实验 8：原生 INT-MC 的 LEO 动态性因果检验</h1><section><h2>控制变量</h2><p>在固定强制下线密度下，将受控 churn rate 从 0% 静态控制组逐步提高到 25%。0% 组保持断链成员不变，5%–25% 组只改变成员交换率；Jaccard 动态性作为实际拓扑变化结果单独记录。</p><p>固定采样预算是相同采样率 ${parameters.sampling_rate ?? parameters.samplingRate ?? ""} 和每片路径上限 ${parameters.max_paths_per_slice ?? parameters.maxPathsPerSlice ?? ""}。它是配置预算一致，不等同于强制最终遥测字节完全相等。公平性审计 ${fairnessPassed}/${fairnessAudits.length} 通过。</p></section><section><h2>因果回放门禁</h2><p>受控断链在第一阶段物理链路生成后、业务路由前注入，再重新计算路由、链路队列、节点 CPU 和电量。因果回放记录 ${causal.replay_rows} 条；非法路由为 ${causal.invalid_routes}，非法任务轨迹为 ${causal.invalid_task_traces}。</p><p>相对未扰动基线，平均变化比例：节点 ${causal.changed_node_ratio}，链路 ${causal.changed_link_ratio}，路由 ${causal.changed_route_ratio}。</p></section><section><h2>综合结果</h2><table><thead><tr><th>星座</th><th>方法</th><th>churn</th><th>实际动态性</th><th>B/节点/片</th><th>CPU MAE</th><th>队列 MAE</th><th>电量 MAE</th><th>利用率 MAE</th><th>链路状态准确率</th><th>候选路径失效率</th><th>跨片计划失效率</th><th>最终路径失效率</th><th>新规划片数</th><th>规划时间 ms</th></tr></thead><tbody>${resultTable(summaryRows)}</tbody></table></section><section><h2>低扰动到高扰动的变化</h2><p>正的误差差值表示指标随动态性增加而退化；跨片计划失效率直接表示旧 probe plan 在下一时间片失效。</p>${lowHighHtml(lowHigh)}</section><section>${chart(summaryRows,"link_utilization_mae","churn—链路利用率重构误差")}</section><section>${chart(summaryRows,"candidate_path_failure_ratio","churn—候选路径失效率")}</section><section>${chart(summaryRows,"carryover_path_failure_ratio","churn—跨片计划失效率")}</section><section>${chart(summaryRows,"planning_wall_time_ms","churn—重新规划开销")}</section><section><h2>稳定性斜率</h2><p>完整 CSV/JSON 保存 ${slopes.length} 条误差与开销斜率。</p></section><section><h2>负结果与边界</h2>${negativeHtml(negatives)}<p class="note">不预设增强方法必然优于原生方法。该实验是仿真环境中的受控因果压力实验，不是运营商真实故障记录。</p></section></main></body></html>`;
}

function buildExperiment8MarkdownBase({ parameters = {}, summaryRows = [], fairnessAudits = [], slopeRows: slopes = [] } = {}) {
  const lowHigh = buildLowHighRows(summaryRows);
  const negatives = buildNegativeResults(summaryRows);
  const causal = causalReplaySummary(summaryRows);
  return `# 实验 8：LEO 动态性因果检验\n\n## 目的\n\n在固定采样预算和相同平均链路密度下，以 0% churn 作为静态控制组，再逐步提高到 5%–25%，比较原生 INT-MC 与增强 LEO-INT-MC 的重构误差、路径失效和重新规划开销。\n\n## 因果真值生成\n\n受控断链不是在仿真结束后改写 CSV，而是在第一阶段物理链路生成之后、业务路由之前注入。随后由原有公式重新计算业务路由、链路利用率与队列、节点 CPU、缓存和电量。\n\n- 因果回放结果：${causal.replay_rows} 条\n- 非法路由：${causal.invalid_routes}\n- 非法任务轨迹：${causal.invalid_task_traces}\n- 平均节点变化比例：${causal.changed_node_ratio}\n- 平均链路变化比例：${causal.changed_link_ratio}\n- 平均路由变化比例：${causal.changed_route_ratio}\n\n## 固定预算口径\n\n- 采样率：${parameters.sampling_rate ?? parameters.samplingRate ?? ""}\n- 每时间片路径上限：${parameters.max_paths_per_slice ?? parameters.maxPathsPerSlice ?? ""}\n- 公平性审计：${fairnessAudits.filter((row) => row.ok).length}/${fairnessAudits.length} 通过\n- 稳定性斜率：${slopes.length} 条\n\n这里固定的是采样率、路径上限、补全参数、观测字段和下传预算配置；不同方法选择的实际路径不同，因此最终遥测字节仍作为结果变量报告，而不是伪装成完全相等。\n\n## 低扰动到高扰动的变化\n\n${markdownTable(lowHigh)}\n\n跨片计划失效率上升说明旧 probe plan 随拓扑 churn 失效。最终路径失效率为零只表示方法通过重新规划或局部修复保持执行合法，不代表旧计划仍然有效。\n\n## 负结果与边界\n\n${negativeMarkdown(negatives)}\n\n报告保留全部负结果，不预设增强方法必然优于原生方法。只有输入指纹、公平预算、因果回放、无真值泄漏和非法路径门禁全部通过后，相关结果才进入正式比较。\n\n## 产物\n\n- [HTML 可视化](reports/experiment8-dynamicity-causality/experiment8-dynamicity-report.html)\n- [汇总 CSV](reports/experiment8-dynamicity-causality/experiment8-dynamicity-summary.csv)\n- [逐片 CSV](reports/experiment8-dynamicity-causality/experiment8-dynamicity-by-slice.csv)\n- [变换审计 CSV](reports/experiment8-dynamicity-causality/experiment8-dynamicity-mutations.csv)\n`;
}

function controlVariableRows(summaryRows = []) {
  const unique = new Map();
  summaryRows.forEach((row) => {
    const key = `${row.constellation_profile_id}|${row.target_stress_rate}`;
    if (!unique.has(key)) unique.set(key, row);
  });
  return [...unique.values()].sort((left, right) =>
    String(left.constellation_label).localeCompare(String(right.constellation_label)) ||
    numberValue(left.target_stress_rate) - numberValue(right.target_stress_rate));
}

function controlAuditHtml(summaryRows = []) {
  const rows = controlVariableRows(summaryRows);
  const body = rows.map((row) => `<tr><td>${escapeHtml(row.constellation_label)}</td><td>${round(numberValue(row.target_stress_rate))}</td><td>${round(numberValue(row.achieved_mean_dynamicity))}</td><td>${round(numberValue(row.mean_forced_down_fraction))}</td><td>${round(numberValue(row.polar_disconnection_ratio))}</td><td>${round(numberValue(row.business_hotspot_migration_speed))}</td><td>${round(numberValue(row.reporting_path_interruption_ratio))}</td></tr>`).join("");
  return `<section><h2>控制变量审计</h2><p>固定断链密度、极区断链比例、业务热点迁移速度和 reporting 中断率均逐档记录；主自变量只有受控轨间 churn。0% 表示受控断链成员不交换，不表示卫星物理拓扑停止自然变化，因此实际 Jaccard 动态性仍可能大于 0。</p><table><thead><tr><th>星座</th><th>churn</th><th>实际动态性</th><th>固定断链密度</th><th>极区断链比例</th><th>热点迁移速度</th><th>reporting 中断率</th></tr></thead><tbody>${body}</tbody></table></section>`;
}

function controlAuditMarkdown(summaryRows = []) {
  const rows = controlVariableRows(summaryRows);
  return `## 控制变量审计\n\n0% 表示受控断链成员不交换，不表示卫星物理拓扑停止自然变化，因此实际 Jaccard 动态性仍可能大于 0。\n\n| 星座 | churn | 实际动态性 | 固定断链密度 | 极区断链比例 | 热点迁移速度 | reporting 中断率 |\n|---|---:|---:|---:|---:|---:|---:|\n${rows.map((row) => `| ${row.constellation_label} | ${round(numberValue(row.target_stress_rate))} | ${round(numberValue(row.achieved_mean_dynamicity))} | ${round(numberValue(row.mean_forced_down_fraction))} | ${round(numberValue(row.polar_disconnection_ratio))} | ${round(numberValue(row.business_hotspot_migration_speed))} | ${round(numberValue(row.reporting_path_interruption_ratio))} |`).join("\n")}\n\n`;
}

export function buildExperiment8Html(input = {}) {
  const html = buildExperiment8HtmlBase(input);
  return html.replace("<section><h2>因果回放门禁", `${controlAuditHtml(input.summaryRows)}<section><h2>因果回放门禁`);
}

export function buildExperiment8Markdown(input = {}) {
  const markdown = buildExperiment8MarkdownBase(input);
  return markdown.replace("## 因果真值生成", `${controlAuditMarkdown(input.summaryRows)}## 因果真值生成`);
}

export async function runExperiment8({
  profiles,
  stressRates = EXPERIMENT8_STRESS_RATES,
  methods = methodDefinitions(),
  oldRoot,
  outputDir,
  rootReportPath,
  parameters = {},
  seed = "experiment8-formal",
  tolerance = 0.01,
  resume = true,
  formal = true,
} = {}) {
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
    reportingInterruptionRate: 0,
    reportingInterruptionSeed: `${seed}:reporting`,
    ...parameters,
  };
  const implementationFingerprint = await experiment8ImplementationFingerprint();
  const parametersFingerprint = experiment8ParametersFingerprint(normalizedParameters);
  await Promise.all([mkdir(outputDir, { recursive: true }), mkdir(dirname(rootReportPath), { recursive: true })]);
  const summaryRows = [];
  const bySliceRows = [];
  const mutationRows = [];
  const pathValidityRows = [];
  const fairnessAudits = [];
  const runManifests = [];

  for (const profile of profiles) {
    const sourceTruthDir = join(oldRoot, profile.id, "stage1-truth");
    const candidatePathsPath = join(oldRoot, profile.id, "experiment2", "stage2", "full-probe-int", "probe-paths-path-balance.csv");
    if (!existsSync(join(sourceTruthDir, "links.csv"))) throw new Error(`Missing Stage-1 truth for ${profile.id}`);
    if (!existsSync(candidatePathsPath)) throw new Error(`Missing candidate paths for ${profile.id}`);
    const candidateHash = await sha256File(candidatePathsPath);
    const taskRows = await readCsv(join(sourceTruthDir, "task-traces.csv"));
    const hotspotSpeed = hotspotMigrationSpeed(taskRows);
    for (const stressRate of stressRates) {
      const stressId = safeRateId(stressRate);
      const stressDir = join(outputDir, "inputs", profile.id, stressId);
      const stress = await prepareStressTruth({
        sourceTruthDir,
        outputDir: stressDir,
        targetStressRate: stressRate,
        seed: `${seed}:${profile.id}`,
        tolerance,
        constellationProfileId: profile.id,
        resume,
      });
      stress.mutations.forEach((row) => mutationRows.push({ constellation_profile_id: profile.id, ...row }));
      const candidateProbeRows = await readCsv(candidatePathsPath);
      const candidatePathValidityRows = calculatePathValidity({ probeRows: candidateProbeRows, linkRows: stress.links });
      const candidateValidity = summarizePathValidity(candidatePathValidityRows);
      candidatePathValidityRows.forEach((row) => pathValidityRows.push({
        constellation_profile_id: profile.id,
        method_id: "candidate-plan",
        target_stress_rate: stressRate,
        ...row,
      }));
      const pairRuns = [];
      for (const method of methods) {
        const methodDir = join(outputDir, "runs", profile.id, stressId, method.id);
        const manifestPath = join(methodDir, "run-manifest.json");
        let run;
        let resumed = false;
        if (resume && existsSync(manifestPath)) {
          const manifest = await readJson(manifestPath);
          if (
            manifest.status === "complete" &&
            manifest.truth_links_sha256 === stress.links_sha256 &&
            manifest.implementation_fingerprint === implementationFingerprint &&
            manifest.parameters_fingerprint === parametersFingerprint
          ) {
            run = manifest.run;
            resumed = true;
          }
        }
        if (!run) {
          run = await runIntMcPass({
            label: `${profile.short_label} ${stressId} ${method.id}`,
            truthDir: stressDir,
            candidatePathsPath,
            stage2Dir: join(methodDir, "stage2"),
            groundDir: join(methodDir, "ground-oam"),
            ...normalizedParameters,
            mechanisms: method.mechanisms,
          });
          await mkdir(methodDir, { recursive: true });
          await writeJson(manifestPath, {
            schema_version: "experiment8-method-run-v1",
            status: "complete",
            generated_at: new Date().toISOString(),
            profile_id: profile.id,
            stress_rate: stressRate,
            method_id: method.id,
            truth_metadata_sha256: stress.metadata_sha256,
            truth_links_sha256: stress.links_sha256,
            candidate_paths_sha256: candidateHash,
            implementation_fingerprint: implementationFingerprint,
            parameters_fingerprint: parametersFingerprint,
            parameters: normalizedParameters,
            mechanisms: method.mechanisms,
            run,
          });
        }
        const probeRows = await readCsv(run.artifacts.executed_probe_paths_csv ?? run.artifacts.probe_paths_csv);
        const validityRows = calculatePathValidity({ probeRows, linkRows: stress.links });
        const validity = summarizePathValidity(validityRows);
        const carryoverRows = calculateCarryoverPathValidity({ probeRows, linkRows: stress.links });
        const carryoverValidity = summarizePathValidity(carryoverRows);
        const reportRows = await readCsv(join(dirname(run.artifacts.probe_paths_csv), "probe-int-reports-int-mc.csv"));
        const reporting = reportingSummary(reportRows);
        const sliceRows = await collectIntMcMetricsBySlice({
          stage2Dir: dirname(run.artifacts.probe_paths_csv),
          groundDir: dirname(run.artifacts.evaluation_json),
        });
        const stressBySlice = new Map(stress.bySlice.map((row) => [numberValue(row.slice_index), row]));
        sliceRows.forEach((row) => bySliceRows.push({
          constellation_profile_id: profile.id,
          constellation_label: profile.short_label,
          method_id: method.id,
          method_label: method.label,
          ...stressBySlice.get(row.slice_index),
          ...row,
        }));
        validityRows.forEach((row) => pathValidityRows.push({
          constellation_profile_id: profile.id,
          method_id: method.id,
          target_stress_rate: stressRate,
          path_validity_type: "selected-current-slice",
          ...row,
        }));
        carryoverRows.forEach((row) => pathValidityRows.push({
          constellation_profile_id: profile.id,
          method_id: method.id,
          target_stress_rate: stressRate,
          path_validity_type: "selected-plan-next-slice",
          ...row,
        }));
        summaryRows.push(summaryRow({ profile, method, stress, run, validity, carryoverValidity, candidateValidity, reporting, hotspotSpeed }));
        pairRuns.push({ method, run, resumed });
        runManifests.push({ profile_id: profile.id, stress_rate: stressRate, method_id: method.id, manifest: manifestPath, resumed });
      }
      const native = pairRuns.find((row) => row.method.id === "native");
      const enhanced = pairRuns.find((row) => row.method.id === "enhanced");
      if (native && enhanced) {
        const audit = auditFixedBudgetPair(
          fairnessView({ metadataHash: stress.metadata_sha256, linksHash: stress.links_sha256, candidateHash, parameters: normalizedParameters }),
          fairnessView({ metadataHash: stress.metadata_sha256, linksHash: stress.links_sha256, candidateHash, parameters: normalizedParameters }),
        );
        fairnessAudits.push({ constellation_profile_id: profile.id, stress_rate: stressRate, ...audit });
      }
    }
  }

  const slopes = slopeRows(summaryRows);
  const lowHigh = buildLowHighRows(summaryRows);
  const negativeResults = buildNegativeResults(summaryRows);
  if (formal) {
    const expected = profiles.length * stressRates.length * methods.length;
    if (summaryRows.length !== expected) throw new Error(`Experiment 8 expected ${expected} rows, got ${summaryRows.length}`);
    if (fairnessAudits.some((row) => !row.ok)) throw new Error("Experiment 8 fixed-budget fairness audit failed");
    if (summaryRows.some((row) => Math.abs(row.achieved_stress_rate - row.target_stress_rate) > tolerance)) {
      throw new Error("Experiment 8 stress calibration tolerance failed");
    }
    if (summaryRows.some((row) => row.slice_count !== FORMAL_DEFAULTS.slice_count)) {
      throw new Error("Formal Experiment 8 requires 48 slices");
    }
    if (summaryRows.some((row) => row.causal_replay !== true)) {
      throw new Error("Formal Experiment 8 requires route-before-state causal Stage-1 replay");
    }
    if (summaryRows.some((row) => row.causal_invalid_routes !== 0 || row.causal_invalid_task_traces !== 0)) {
      throw new Error("Formal Experiment 8 causal replay contains routes or task traces over inactive links");
    }
    if (summaryRows.some((row) => row.causal_changed_link_ratio <= 0 || row.causal_changed_route_ratio <= 0)) {
      throw new Error("Formal Experiment 8 controlled topology did not cause link and route state changes");
    }
    if (summaryRows.some((row) => row.telemetry_byte_budget_cap_violations !== 0)) {
      throw new Error("Formal Experiment 8 exceeded a telemetry hard byte budget");
    }
  }
  const outputFiles = {
    summary_csv: join(outputDir, "experiment8-dynamicity-summary.csv"),
    by_slice_csv: join(outputDir, "experiment8-dynamicity-by-slice.csv"),
    mutations_csv: join(outputDir, "experiment8-dynamicity-mutations.csv"),
    path_validity_csv: join(outputDir, "experiment8-path-validity.csv"),
    slopes_csv: join(outputDir, "experiment8-stability-slopes.csv"),
    summary_json: join(outputDir, "experiment8-dynamicity-summary.json"),
    manifest_json: join(outputDir, "experiment8-dynamicity-manifest.json"),
    report_html: join(outputDir, "experiment8-dynamicity-report.html"),
    root_report_md: rootReportPath,
  };
  const reportInput = { parameters: normalizedParameters, summaryRows, fairnessAudits, slopeRows: slopes };
  const summary = {
    schema_version: "experiment8-leo-dynamicity-causality-v1",
    generated_at: new Date().toISOString(),
    formal,
    parameters: normalizedParameters,
    implementation_fingerprint: implementationFingerprint,
    parameters_fingerprint: parametersFingerprint,
    stress_definition: "controlled-inter-plane-membership-churn-at-fixed-forced-down-density",
    summary_rows: summaryRows,
    fairness_audits: fairnessAudits,
    slope_rows: slopes,
    low_high_rows: lowHigh,
    negative_results: negativeResults,
    run_manifests: runManifests,
  };
  const manifest = {
    schema_version: "experiment8-manifest-v1",
    generated_at: summary.generated_at,
    host: { platform: platform(), release: release(), cpu_model: cpus()[0]?.model ?? "unknown", logical_cpu_count: cpus().length, total_memory_bytes: totalmem(), free_memory_bytes_at_report: freemem(), node_version: process.version },
    output_files: outputFiles,
    row_counts: { summary: summaryRows.length, by_slice: bySliceRows.length, mutations: mutationRows.length, path_validity: pathValidityRows.length },
    implementation_fingerprint: implementationFingerprint,
    parameters_fingerprint: parametersFingerprint,
    run_manifests: runManifests,
  };
  await Promise.all([
    writeFile(outputFiles.summary_csv, rowsToCsv(summaryRows), "utf8"),
    writeFile(outputFiles.by_slice_csv, rowsToCsv(bySliceRows), "utf8"),
    writeFile(outputFiles.mutations_csv, rowsToCsv(mutationRows), "utf8"),
    writeFile(outputFiles.path_validity_csv, rowsToCsv(pathValidityRows), "utf8"),
    writeFile(outputFiles.slopes_csv, rowsToCsv(slopes), "utf8"),
    writeJson(outputFiles.summary_json, summary),
    writeJson(outputFiles.manifest_json, manifest),
    writeFile(outputFiles.report_html, buildExperiment8Html(reportInput), "utf8"),
    writeFile(outputFiles.root_report_md, buildExperiment8Markdown(reportInput), "utf8"),
  ]);
  return { summaryRows, bySliceRows, mutationRows, pathValidityRows, fairnessAudits, slopeRows: slopes, outputFiles };
}

async function main() {
  const args = process.argv.slice(2);
  const oldRoot = resolve(argValue(args, "--old-root", "reports/experiment2-native-baseline-rerun-final"));
  const outputDir = resolve(argValue(args, "--out", "reports/experiment8-dynamicity-causality"));
  const rootReportPath = resolve(argValue(args, "--root-report", "EXPERIMENT_8_DYNAMICITY_CAUSALITY_REPORT.md"));
  const profileIds = listArg(args, "--profiles", PROFILE_CATALOG.map((row) => row.id));
  const stressRates = listArg(args, "--targets", EXPERIMENT8_STRESS_RATES).map(Number);
  const methodIds = listArg(args, "--methods", methodDefinitions().map((row) => row.id));
  const profiles = profileIds.map((id) => {
    const profile = PROFILE_CATALOG.find((row) => row.id === id);
    if (!profile) throw new Error(`Unknown constellation profile: ${id}`);
    return profile;
  });
  const methods = methodIds.map((id) => {
    const method = methodDefinitions().find((row) => row.id === id);
    if (!method) throw new Error(`Unknown Experiment 8 method: ${id}`);
    return method;
  });
  const cliParameters = parseExperiment8CliParameters(args);
  const experimentSeed = argValue(args, "--seed", "experiment8-formal");
  cliParameters.reportingInterruptionSeed = argValue(args, "--reporting-interruption-seed", `${experimentSeed}:reporting`);
  const result = await runExperiment8({
    profiles,
    stressRates,
    methods,
    oldRoot,
    outputDir,
    rootReportPath,
    seed: experimentSeed,
    tolerance: cliParameters.tolerance,
    resume: argValue(args, "--resume", "true").toLowerCase() !== "false",
    formal: argValue(args, "--formal", "true").toLowerCase() !== "false",
    parameters: cliParameters,
  });
  console.log(JSON.stringify({ ok: true, output_dir: outputDir, summary_rows: result.summaryRows.length, by_slice_rows: result.bySliceRows.length, fairness_audits: result.fairnessAudits.length, root_report: relative(process.cwd(), rootReportPath) }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
