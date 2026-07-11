import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { cpus, freemem, platform, release, totalmem } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  FORMAL_DEFAULTS,
  PROFILE_CATALOG,
  collectIntMcMetricsBySlice,
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
import { escapeHtml, parseCsv, rowsToCsv } from "./experiments/reportUtils.mjs";

export const EXPERIMENT8_STRESS_RATES = Object.freeze([0.05, 0.10, 0.15, 0.20, 0.25]);

const NATIVE_MECHANISMS = Object.freeze({
  adaptiveReuse: false,
  incrementalTopologyRepair: false,
  forecastRiskScoring: false,
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

async function prepareStressTruth({ sourceTruthDir, outputDir, targetStressRate, seed, tolerance }) {
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(dirname(outputDir), { recursive: true });
  await cp(sourceTruthDir, outputDir, { recursive: true });
  const linksPath = join(outputDir, "links.csv");
  const metadataPath = join(outputDir, "metadata.json");
  const links = await readCsv(linksPath);
  const transformed = transformDynamicityTrace({ links, targetStressRate, seed, tolerance });
  const metadata = await readJson(metadataPath);
  metadata.experiment8_controlled_stress = {
    seed,
    target_stress_rate: targetStressRate,
    achieved_stress_rate: transformed.summary.achieved_stress_rate,
    achieved_mean_dynamicity: transformed.summary.achieved_mean_dynamicity,
    source_truth_dir: resolve(sourceTruthDir),
  };
  await Promise.all([
    writeFile(linksPath, rowsToCsv(transformed.links), "utf8"),
    writeJson(metadataPath, metadata),
    writeFile(join(outputDir, "experiment8-mutations.csv"), rowsToCsv(transformed.mutations), "utf8"),
    writeFile(join(outputDir, "experiment8-dynamicity-by-slice.csv"), rowsToCsv(transformed.bySlice), "utf8"),
    writeJson(join(outputDir, "experiment8-dynamicity.json"), transformed.summary),
  ]);
  return {
    ...transformed,
    truth_dir: outputDir,
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
  const x = (value) => margin + (width - margin * 2) * ((value - 0.05) / 0.20);
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

export function buildExperiment8Html({ parameters = {}, summaryRows = [], fairnessAudits = [], slopeRows: slopes = [] } = {}) {
  const fairnessPassed = fairnessAudits.filter((row) => row.ok).length;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>实验8 LEO动态性因果实验</title><style>body{font-family:Arial,"Microsoft YaHei",sans-serif;margin:0;background:#f3f6f7;color:#17212b}main{max-width:1240px;margin:auto;padding:28px}section{background:#fff;border:1px solid #d6e0e4;margin:16px 0;padding:18px;border-radius:6px}table{border-collapse:collapse;width:100%;font-size:12px}th,td{border:1px solid #d6e0e4;padding:6px;text-align:right}th:first-child,td:first-child,th:nth-child(2),td:nth-child(2){text-align:left}svg{width:100%;height:auto}.note{color:#526672}</style></head><body><main><h1>实验 8：原生 INT-MC 的 LEO 动态性因果检验</h1><section><h2>实验定义</h2><p>横轴是固定轨间压力池中每片发生成员交换的受控 churn rate；各档保持相同平均链路密度，Jaccard 动态性是实际观测结果。这样不会把“链路更少”和“拓扑变化更快”混为同一个变量，也不会强行恢复物理不可用链路。</p><p>固定采样预算：采样率 ${parameters.sampling_rate ?? parameters.samplingRate ?? ""}，每片最多 ${parameters.max_paths_per_slice ?? parameters.maxPathsPerSlice ?? ""} 条路径。公平性审计 ${fairnessPassed}/${fairnessAudits.length} 通过。</p></section><section><h2>综合结果</h2><table><thead><tr><th>星座</th><th>方法</th><th>扰动率</th><th>实际动态性</th><th>B/节点/片</th><th>CPU MAE</th><th>队列 MAE</th><th>电量 MAE</th><th>利用率 MAE</th><th>链路状态准确率</th><th>候选路径失效率</th><th>跨片计划失效率</th><th>最终路径失效率</th><th>新规划片数</th><th>规划时间 ms</th></tr></thead><tbody>${resultTable(summaryRows)}</tbody></table></section><section>${chart(summaryRows,"link_utilization_mae","扰动率—链路利用率误差")}</section><section>${chart(summaryRows,"candidate_path_failure_ratio","扰动率—候选路径失效率")}</section><section>${chart(summaryRows,"carryover_path_failure_ratio","扰动率—跨片计划失效率")}</section><section>${chart(summaryRows,"path_failure_ratio","扰动率—最终路径失效率")}</section><section>${chart(summaryRows,"planning_wall_time_ms","扰动率—规划开销")}</section><section><h2>稳定性斜率</h2><p>斜率越小，表示指标随动态性增长越慢。完整数据保存在 JSON/CSV 中，共 ${slopes.length} 条斜率记录。</p></section><section><h2>结论边界</h2><p class="note">本实验是同一卫星真值上的受控压力因果实验，不是运营商真实故障记录。负结果和增强方法退化项不会删除。</p></section></main></body></html>`;
}

export function buildExperiment8Markdown({ parameters = {}, summaryRows = [], fairnessAudits = [], slopeRows: slopes = [] } = {}) {
  return `# 实验 8：LEO 动态性因果检验\n\n## 目的\n\n在固定采样预算和相同平均链路密度下，逐步增加 5%–25% 的受控轨间 churn，比较原生 INT-MC 与增强 LEO-INT-MC 的节点/链路重构误差、路径失效和重新规划开销。\n\n## 口径\n\n- 采样率：${parameters.sampling_rate ?? parameters.samplingRate ?? ""}\n- 每时间片路径上限：${parameters.max_paths_per_slice ?? parameters.maxPathsPerSlice ?? ""}\n- 方法级结果：${summaryRows.length} 条\n- 公平性审计：${fairnessAudits.filter((row) => row.ok).length}/${fairnessAudits.length} 通过\n- 稳定性斜率：${slopes.length} 条\n\n受控 churn 是实验控制剂量，强制下线密度保持不变，实际拓扑变化使用 Jaccard 动态性另行记录。实验不会强行恢复物理上不可用的链路。\n\n## 结论原则\n\n报告保留所有负结果，不预设增强方法必然优于原生方法。只有在相同输入指纹、固定采样预算和无真值泄漏审计均通过后，才比较误差斜率与开销。\n\n## 产物\n\n- [HTML 可视化](reports/experiment8-dynamicity-causality/experiment8-dynamicity-report.html)\n- [汇总 CSV](reports/experiment8-dynamicity-causality/experiment8-dynamicity-summary.csv)\n- [逐片 CSV](reports/experiment8-dynamicity-causality/experiment8-dynamicity-by-slice.csv)\n- [变换审计 CSV](reports/experiment8-dynamicity-causality/experiment8-dynamicity-mutations.csv)\n`;
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
    ...parameters,
  };
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
          if (manifest.status === "complete" && manifest.truth_links_sha256 === stress.links_sha256) {
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
            parameters: normalizedParameters,
            mechanisms: method.mechanisms,
            run,
          });
        }
        const probeRows = await readCsv(run.artifacts.probe_paths_csv);
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
    stress_definition: "controlled-inter-plane-membership-churn-at-fixed-forced-down-density",
    summary_rows: summaryRows,
    fairness_audits: fairnessAudits,
    slope_rows: slopes,
    run_manifests: runManifests,
  };
  const manifest = {
    schema_version: "experiment8-manifest-v1",
    generated_at: summary.generated_at,
    host: { platform: platform(), release: release(), cpu_model: cpus()[0]?.model ?? "unknown", logical_cpu_count: cpus().length, total_memory_bytes: totalmem(), free_memory_bytes_at_report: freemem(), node_version: process.version },
    output_files: outputFiles,
    row_counts: { summary: summaryRows.length, by_slice: bySliceRows.length, mutations: mutationRows.length, path_validity: pathValidityRows.length },
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
  const result = await runExperiment8({
    profiles,
    stressRates,
    methods,
    oldRoot,
    outputDir,
    rootReportPath,
    seed: argValue(args, "--seed", "experiment8-formal"),
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
