import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { cpus, freemem, platform, release, totalmem } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PROFILE_CATALOG, sha256File } from "./experiments/intMcExperimentCore.mjs";
import {
  DEFAULT_METRIC_DIRECTIONS,
  aggregateEqualBudgetRows,
  auditEqualBudgetFairness,
  buildPairedMethodEffects,
  validateEqualBudgetMatrix,
} from "./experiments/equalBudgetStatistics.mjs";
import { escapeHtml, rowsToCsv } from "./experiments/reportUtils.mjs";
import {
  experiment8ImplementationFingerprint,
  methodDefinitions,
  runExperiment8,
} from "./runExperiment8DynamicityCausality.mjs";
import { runStaticNativeBaseline } from "./runExperiment8StaticNativeBaseline.mjs";

export const EXPERIMENT10_STRESS_RATES = Object.freeze([0, 0.1, 0.25]);
export const EXPERIMENT10_METHOD_IDS = Object.freeze([
  "native-full-replan",
  "enhanced",
  "native-reference-replay",
]);
const EXPERIMENT10_SEED_SCHEMA_VERSION = "experiment10-seed-result-v2";

// Frozen from the maximum achieved B/node/slice among the excluded 0% calibration runs.
export const DEFAULT_PROFILE_BUDGETS = Object.freeze({
  "iridium-next-small": 476.2424,
  "telesat-1015-medium": 435.7265,
  "starlink-main-large": 21.3359,
});

const REPORTED_METRICS = Object.freeze([
  "telemetry_bytes_per_node_slice",
  "telemetry_padding_bytes_per_node_slice",
  "total_telemetry_energy_j",
  "planning_wall_time_ms",
  "reconstruction_wall_time_ms",
  "invalid_probe_path_ratio",
  "cpu_mae",
  "queue_depth_mae",
  "energy_percent_mae",
  "link_utilization_mae",
  "node_mode_accuracy",
  "link_status_accuracy",
]);

function argValue(args, name, fallback = "") {
  const index = args.indexOf(name);
  return index === -1 ? fallback : (args[index + 1] ?? fallback);
}

function listArg(args, name, fallback) {
  const raw = argValue(args, name, "");
  return raw ? raw.split(",").map((value) => value.trim()).filter(Boolean) : fallback;
}

function numberValue(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value, digits = 6) {
  return Number(numberValue(value).toFixed(digits));
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function stableHash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function buildExperiment10ConfigFingerprint({
  profiles,
  stressRates,
  seeds,
  budgets,
  sourceHashes,
  methodIds,
  implementationFingerprint,
  telemetryByteBudgetPadToCap,
}) {
  return stableHash({
    profiles,
    stressRates,
    seeds,
    budgets,
    sourceHashes,
    methodIds,
    implementationFingerprint,
    telemetryByteBudgetPadToCap,
  });
}

export function parseBudgetMap(raw = "") {
  if (!String(raw).trim()) return {};
  const result = {};
  for (const entry of String(raw).split(",")) {
    const [key, rawValue] = entry.split(":").map((value) => value.trim());
    const value = Number(rawValue);
    if (!key || !Number.isFinite(value) || value <= 0) throw new Error(`Budget entries must be positive: ${entry}`);
    result[key] = value;
  }
  return result;
}

function parseSeeds(raw = "10", prefix = "experiment10-seed") {
  const count = Number(raw);
  if (Number.isInteger(count) && count > 0) {
    return Array.from({ length: count }, (_, index) => `${prefix}-${String(index).padStart(2, "0")}`);
  }
  const seeds = String(raw).split(",").map((value) => value.trim()).filter(Boolean);
  if (!seeds.length) throw new Error("At least one seed is required");
  return seeds;
}

export function buildExperiment10Matrix({
  profileIds = PROFILE_CATALOG.map((profile) => profile.id),
  stressRates = EXPERIMENT10_STRESS_RATES,
  seeds = parseSeeds("10"),
  methodIds = EXPERIMENT10_METHOD_IDS,
} = {}) {
  return profileIds.flatMap((profileId) =>
    stressRates.flatMap((stressRate) =>
      seeds.flatMap((seed) => methodIds.map((methodId) => ({
        profile_id: profileId,
        stress_rate: Number(stressRate),
        seed,
        method_id: methodId,
      })))))
  ;
}

function methodColor(methodId) {
  if (methodId === "enhanced") return "#047857";
  if (methodId === "native-full-replan") return "#d97706";
  return "#b91c1c";
}

function ciChart(rows, metric, title) {
  if (!rows.length) return "";
  const width = 760;
  const height = 330;
  const left = 62;
  const right = 24;
  const top = 30;
  const bottom = 52;
  const values = rows.flatMap((row) => [numberValue(row[`${metric}_ci95_low`]), numberValue(row[`${metric}_ci95_high`])]);
  let minimum = Math.min(...values, 0);
  let maximum = Math.max(...values, 1);
  if (minimum === maximum) maximum = minimum + 1;
  const profiles = [...new Set(rows.map((row) => row.profile_id))];
  const stressRates = [...new Set(rows.map((row) => numberValue(row.stress_rate)))].sort((a, b) => a - b);
  const groupKeys = profiles.flatMap((profile) => stressRates.map((rate) => `${profile}|${rate}`));
  const x = (groupIndex, methodIndex) => left + ((groupIndex + 0.18 + methodIndex * 0.28) / Math.max(groupKeys.length, 1)) * (width - left - right);
  const y = (value) => top + (maximum - value) / Math.max(maximum - minimum, 1e-9) * (height - top - bottom);
  const marks = [];
  for (const row of rows) {
    const groupIndex = groupKeys.indexOf(`${row.profile_id}|${numberValue(row.stress_rate)}`);
    const methodIndex = EXPERIMENT10_METHOD_IDS.indexOf(row.method_id);
    const px = x(groupIndex, Math.max(methodIndex, 0));
    const center = y(numberValue(row[`${metric}_mean`]));
    const low = y(numberValue(row[`${metric}_ci95_low`]));
    const high = y(numberValue(row[`${metric}_ci95_high`]));
    const color = methodColor(row.method_id);
    marks.push(`<line x1="${px}" y1="${high}" x2="${px}" y2="${low}" stroke="${color}" stroke-width="2"/><line x1="${px-4}" y1="${high}" x2="${px+4}" y2="${high}" stroke="${color}"/><line x1="${px-4}" y1="${low}" x2="${px+4}" y2="${low}" stroke="${color}"/><circle cx="${px}" cy="${center}" r="4" fill="${color}"/>`);
  }
  const labels = groupKeys.map((key, index) => {
    const [profile, stress] = key.split("|");
    return `<text x="${x(index, 1)}" y="${height-18}" text-anchor="middle" font-size="9">${escapeHtml(profile.replace(/-.*/, ""))} ${(Number(stress)*100).toFixed(0)}%</text>`;
  }).join("");
  return `<section class="chart"><h3>${escapeHtml(title)}（均值与 95% CI）</h3><svg viewBox="0 0 ${width} ${height}" role="img"><line x1="${left}" y1="${top}" x2="${left}" y2="${height-bottom}" class="axis"/><line x1="${left}" y1="${height-bottom}" x2="${width-right}" y2="${height-bottom}" class="axis"/>${marks.join("")}${labels}<text x="${left-8}" y="${top+4}" text-anchor="end" font-size="10">${round(maximum, 3)}</text><text x="${left-8}" y="${height-bottom}" text-anchor="end" font-size="10">${round(minimum, 3)}</text></svg></section>`;
}

function aggregateTable(rows) {
  return `<table><thead><tr><th>星座</th><th>动态性</th><th>方法</th><th>样本</th><th>B/节点/片</th><th>其中 padding</th><th>CPU MAE</th><th>队列 MAE</th><th>电量 MAE</th><th>利用率 MAE</th><th>链路状态准确率</th><th>规划时间 ms</th></tr></thead><tbody>${rows.map((row) => `<tr><td>${escapeHtml(row.constellation_label || row.profile_id)}</td><td>${(numberValue(row.stress_rate)*100).toFixed(0)}%</td><td>${escapeHtml(row.method_label || row.method_id)}</td><td>${row.sample_count}</td><td>${row.telemetry_bytes_per_node_slice_mean}</td><td>${row.telemetry_padding_bytes_per_node_slice_mean}</td><td>${row.cpu_mae_mean}</td><td>${row.queue_depth_mae_mean}</td><td>${row.energy_percent_mae_mean}</td><td>${row.link_utilization_mae_mean}</td><td>${row.link_status_accuracy_mean}</td><td>${row.planning_wall_time_ms_mean}</td></tr>`).join("")}</tbody></table>`;
}

function effectTable(rows) {
  const headline = rows.filter((row) => ["cpu_mae", "queue_depth_mae", "energy_percent_mae", "link_utilization_mae", "telemetry_bytes_per_node_slice", "planning_wall_time_ms"].includes(row.metric));
  return `<table><thead><tr><th>星座</th><th>动态性</th><th>对照</th><th>指标</th><th>配对改进</th><th>95% CI</th><th>Cohen dz</th></tr></thead><tbody>${headline.map((row) => `<tr><td>${escapeHtml(row.constellation_label || row.profile_id)}</td><td>${(numberValue(row.stress_rate)*100).toFixed(0)}%</td><td>${escapeHtml(row.control_method_id)}</td><td>${escapeHtml(row.metric)}</td><td>${row.improvement_mean}</td><td>[${row.improvement_ci95_low}, ${row.improvement_ci95_high}]</td><td>${row.cohen_dz}</td></tr>`).join("")}</tbody></table>`;
}

function fairnessTable(rows) {
  const grouped = new Map();
  for (const row of rows) {
    const key = `${row.profile_id}|${row.stress_rate}`;
    const group = grouped.get(key) ?? [];
    group.push(row);
    grouped.set(key, group);
  }
  return `<table><thead><tr><th>星座</th><th>动态性</th><th>场景数</th><th>硬上限 B/节点/片</th><th>实际最小-最大</th><th>超限</th><th>通过</th></tr></thead><tbody>${[...grouped.values()].map((group) => { const first=group[0]; return `<tr><td>${escapeHtml(first.constellation_label || first.profile_id)}</td><td>${(numberValue(first.stress_rate)*100).toFixed(0)}%</td><td>${group.length}</td><td>${first.hard_cap_bytes_per_node_slice}</td><td>${round(Math.min(...group.map((row)=>row.actual_bytes_per_node_slice_min)),4)} - ${round(Math.max(...group.map((row)=>row.actual_bytes_per_node_slice_max)),4)}</td><td>${group.reduce((total,row)=>total+numberValue(row.cap_violations),0)}</td><td>${group.every((row)=>row.ok)?"是":"否"}</td></tr>`; }).join("")}</tbody></table>`;
}

const CONCLUSION_METRICS = Object.freeze({
  cpu_mae: "CPU MAE",
  queue_depth_mae: "队列 MAE",
  energy_percent_mae: "电量 MAE",
  link_utilization_mae: "链路利用率 MAE",
  node_mode_accuracy: "节点模式准确率",
  link_status_accuracy: "链路状态准确率",
  planning_wall_time_ms: "规划时间",
});

function summarizeNativeEffects(effectRows) {
  const rows = effectRows.filter((row) => row.control_method_id === "native-full-replan" && CONCLUSION_METRICS[row.metric]);
  const groups = new Map();
  for (const row of rows) {
    const key = row.profile_id;
    const group = groups.get(key) ?? {
      profile_id: key,
      constellation_label: row.constellation_label || key,
      wins: [],
      losses: [],
      uncertain: [],
    };
    const label = `${CONCLUSION_METRICS[row.metric]}@${(numberValue(row.stress_rate) * 100).toFixed(0)}%`;
    if (numberValue(row.improvement_ci95_low) > 0) group.wins.push(label);
    else if (numberValue(row.improvement_ci95_high) < 0) group.losses.push(label);
    else group.uncertain.push(label);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function conclusionHtml(effectRows) {
  const summaries = summarizeNativeEffects(effectRows);
  const body = summaries.map((row) => `<tr><td>${escapeHtml(row.constellation_label)}</td><td>${row.wins.length}</td><td>${row.losses.length}</td><td>${row.uncertain.length}</td><td>${escapeHtml(row.wins.join("、") || "无")}</td><td>${escapeHtml(row.losses.join("、") || "无")}</td></tr>`).join("");
  return `<h2>主要结论</h2><div class="band"><p>下表只比较增强 LEO-INT-MC 与原生每片全重规划，并按配对差值的 Student-t 95% 置信区间分类。正向表示增强方案更优，负向表示增强方案退化，跨 0 表示当前样本下没有稳定差异。</p><table><thead><tr><th>星座</th><th>稳定正向</th><th>稳定负向</th><th>不确定</th><th>稳定改善项</th><th>稳定退化项</th></tr></thead><tbody>${body}</tbody></table><p>结论必须按规模解释：中大型星座上的节点状态与规划收益可以作为主结果；小型星座和链路指标中的退化或不显著结果构成适用边界，不能删除或合并成“全指标全面优于”。</p></div>`;
}

export function buildExperiment10Html({ aggregateRows = [], effectRows = [], fairnessRows = [], parameters = {} } = {}) {
  const charts = [
    ["telemetry_bytes_per_node_slice", "实际遥测字节"],
    ["cpu_mae", "CPU 重构误差"],
    ["energy_percent_mae", "电量重构误差"],
    ["link_utilization_mae", "链路利用率重构误差"],
    ["planning_wall_time_ms", "在线规划开销"],
  ].map(([metric, title]) => ciChart(aggregateRows, metric, title)).join("");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>实验10 严格等预算动态多种子实验</title><style>body{font-family:"Microsoft YaHei",Arial,sans-serif;background:#f4f6f7;color:#17252c;margin:0}main{max-width:1540px;margin:auto;padding:28px}.band,.chart{background:#fff;border:1px solid #d6e0e3;padding:16px;margin:14px 0}.charts{display:grid;grid-template-columns:repeat(auto-fit,minmax(600px,1fr));gap:14px}.chart svg{width:100%}.axis{stroke:#7d8f97}table{width:100%;border-collapse:collapse;background:#fff;font-size:12px;margin:12px 0}th,td{border:1px solid #d6e0e3;padding:6px;text-align:right}th:first-child,td:first-child,th:nth-child(3),td:nth-child(3){text-align:left}th{background:#e8f0f2}.legend span{margin-right:18px}</style></head><body><main><h1>实验 10：严格等硬字节预算的动态多种子端到端比较</h1><div class="band"><p>三种方法在同一星座、种子和动态性场景下使用完全相同的每时间片硬字节上限。预算按实际 probe base、逐跳 metadata 和 report bytes 核算，超限 probe 在发送前被拒绝。</p><p>原生全重规划与增强方案用不携带观测信息的 padding 补齐未使用预算；padding 计入报告转发、链路字节和能耗，但不产生 metadata 或覆盖收益。参考计划回放不填充，以保留失效路径造成的预算利用不足。</p><p>种子数：${parameters.seed_count ?? 0}。误差条为 Student-t 95% CI；配对效应量使用同一场景内增强方法相对对照的 Cohen dz。</p></div><p class="legend"><span style="color:#d97706">● 原生每片全重规划</span><span style="color:#047857">● 增强 LEO-INT-MC</span><span style="color:#b91c1c">● 原生参考计划回放</span></p><h2>预算公平性</h2>${fairnessTable(fairnessRows)}${conclusionHtml(effectRows)}<div class="charts">${charts}</div><h2>综合指标</h2>${aggregateTable(aggregateRows)}<h2>配对效应量</h2>${effectTable(effectRows)}<h2>解释边界</h2><ul><li>主比较组实际消耗被对齐到同一上限；padding 比例单独报告，不能解释为有效遥测。</li><li>正的配对改进表示增强方法更优，置信区间跨 0 表示当前样本下优势不稳定。</li><li>CPU、电量和队列仍是第一阶段模型内部真值，不是运营商公开遥测。</li></ul></main></body></html>`;
}

function buildMarkdown({ aggregateRows, effectRows, fairnessRows, parameters, outputs }) {
  const summaries = summarizeNativeEffects(effectRows);
  const positiveCount = summaries.reduce((total, row) => total + row.wins.length, 0);
  const negativeCount = summaries.reduce((total, row) => total + row.losses.length, 0);
  const uncertainCount = summaries.reduce((total, row) => total + row.uncertain.length, 0);
  const profileLines = summaries.map((row) => `- ${row.constellation_label}：稳定改善 ${row.wins.length} 项，稳定退化 ${row.losses.length} 项，不确定 ${row.uncertain.length} 项。`).join("\n");
  return `# 实验 10：严格等硬字节预算动态多种子实验\n\n- 正式种子数：${parameters.seed_count}\n- 方法行：${parameters.method_row_count}\n- 公平场景：${fairnessRows.filter((row) => row.ok).length}/${fairnessRows.length}\n- 相对原生全重规划的稳定正向结果：${positiveCount}\n- 稳定负向结果：${negativeCount}\n- 置信区间跨 0：${uncertainCount}\n\n本实验在相同实际遥测硬上限下比较原生每片全重规划、增强 LEO-INT-MC 和原生参考计划回放。正的配对改进表示增强方法优于对应对照；所有负结果均保留。\n\n## 主要结论\n\n${profileLines}\n\n结论应按规模解释：中大型星座上的节点状态和规划收益构成主证据；小型星座以及链路指标的退化或不显著结果构成适用边界。padding 只用于对齐网络负载，不携带 metadata，也不计为有效覆盖收益。\n\n## 产物\n\n- HTML：${outputs.report_html}\n- 原始逐种子 CSV：${outputs.raw_csv}\n- 聚合 CSV：${outputs.aggregate_csv}\n- 配对效应 CSV：${outputs.effects_csv}\n- 公平性 CSV：${outputs.fairness_csv}\n`;
}

async function pruneSeedBulk(seedRoot) {
  const root = resolve(seedRoot);
  for (const child of [join(root, "dynamicity", "runs"), join(root, "dynamicity", "inputs"), join(root, "reference", "runs")]) {
    const target = resolve(child);
    if (!target.startsWith(`${root}${process.platform === "win32" ? "\\" : "/"}`)) throw new Error(`Unsafe prune target: ${target}`);
    await rm(target, { recursive: true, force: true });
  }
}

function normalizeComparisonRow(row, { profile, stressRate, seed, hardBudget }) {
  return {
    profile_id: profile.id,
    constellation_label: profile.short_label,
    node_count: profile.node_count,
    stress_rate: numberValue(stressRate),
    seed,
    method_id: row.method_id,
    method_label: row.method_label,
    hard_budget_bytes_per_node_slice: hardBudget,
    telemetry_byte_budget_per_node_slice: numberValue(row.telemetry_byte_budget_per_node_slice, hardBudget),
    telemetry_byte_budget_cap_violations: numberValue(row.telemetry_byte_budget_cap_violations),
    telemetry_byte_budget_utilization: numberValue(row.telemetry_byte_budget_utilization),
    telemetry_byte_budget_rejected_probe_paths: numberValue(row.telemetry_byte_budget_rejected_probe_paths),
    telemetry_byte_budget_padding_bytes: numberValue(row.telemetry_byte_budget_padding_bytes),
    telemetry_padding_bytes_per_node_slice: numberValue(row.telemetry_padding_bytes_per_node_slice),
    selected_paths: numberValue(row.selected_paths),
    invalid_probe_path_ratio: numberValue(row.invalid_probe_path_ratio),
    telemetry_bytes_per_node_slice: numberValue(row.telemetry_bytes_per_node_slice),
    total_telemetry_generated_bytes: numberValue(row.total_telemetry_generated_bytes),
    total_telemetry_energy_j: numberValue(row.total_telemetry_energy_j),
    cpu_mae: numberValue(row.cpu_mae),
    queue_depth_mae: numberValue(row.queue_depth_mae),
    energy_percent_mae: numberValue(row.energy_percent_mae),
    node_mode_accuracy: numberValue(row.node_mode_accuracy),
    link_utilization_mae: numberValue(row.link_utilization_mae),
    link_status_accuracy: numberValue(row.link_status_accuracy),
    planning_wall_time_ms: numberValue(row.planning_wall_time_ms),
    reconstruction_wall_time_ms: numberValue(row.matrix_completion_ms ?? row.reconstruction_wall_time_ms),
  };
}

export async function runExperiment10({
  profiles = PROFILE_CATALOG,
  stressRates = EXPERIMENT10_STRESS_RATES,
  seeds = parseSeeds("10"),
  budgets = DEFAULT_PROFILE_BUDGETS,
  oldRoot = resolve("reports/experiment2-native-baseline-rerun-final"),
  outputDir = resolve("reports/experiment10-equal-budget-dynamic-multiseed"),
  rootReportPath = resolve("EXPERIMENT_10_EQUAL_BUDGET_REPORT.md"),
  resume = true,
  retainBulk = false,
  formal = true,
} = {}) {
  await Promise.all([mkdir(outputDir, { recursive: true }), mkdir(dirname(rootReportPath), { recursive: true })]);
  const sourceHashes = {};
  for (const profile of profiles) {
    sourceHashes[profile.id] = {
      metadata_sha256: await sha256File(join(oldRoot, profile.id, "stage1-truth", "metadata.json")),
      candidate_paths_sha256: await sha256File(join(oldRoot, profile.id, "experiment2", "stage2", "full-probe-int", "probe-paths-path-balance.csv")),
    };
  }
  const implementationFingerprint = stableHash({
    experiment8: await experiment8ImplementationFingerprint(),
    referenceReplay: await sha256File(resolve("scripts/runExperiment8StaticNativeBaseline.mjs")),
    seedSchema: EXPERIMENT10_SEED_SCHEMA_VERSION,
  });
  const configFingerprint = buildExperiment10ConfigFingerprint({
    profiles: profiles.map((profile) => profile.id),
    stressRates,
    seeds,
    budgets,
    sourceHashes,
    methodIds: EXPERIMENT10_METHOD_IDS,
    implementationFingerprint,
    telemetryByteBudgetPadToCap: true,
  });
  const rawRows = [];
  const seedManifests = [];

  for (const profile of profiles) {
    const hardBudget = numberValue(budgets[profile.id]);
    if (hardBudget <= 0) throw new Error(`Missing positive hard budget for ${profile.id}`);
    for (const seed of seeds) {
      const seedRoot = join(outputDir, "runs", profile.id, seed);
      const seedResultPath = join(seedRoot, "seed-result.json");
      let seedResult = null;
      if (resume && existsSync(seedResultPath)) {
        const cached = await readJson(seedResultPath);
        if (cached.status === "complete" && cached.config_fingerprint === configFingerprint) seedResult = cached;
      }
      if (!seedResult) {
        const dynamicityDir = join(seedRoot, "dynamicity");
        const referenceDir = join(seedRoot, "reference");
        await runExperiment8({
          profiles: [profile],
          stressRates,
          methods: methodDefinitions(),
          oldRoot,
          outputDir: dynamicityDir,
          rootReportPath: join(seedRoot, "dynamicity-report.md"),
          seed: `experiment10:${seed}`,
          resume,
          formal,
          parameters: {
            telemetryByteBudgetPerNodeSlice: hardBudget,
            telemetryByteBudgetPadToCap: true,
            writeEstimateGraph: false,
          },
        });
        const reference = await runStaticNativeBaseline({
          baseDir: dynamicityDir,
          outputDir: referenceDir,
          rootReportPath: join(seedRoot, "reference-report.md"),
          profiles: [profile],
          stressRates,
          telemetryByteBudgetPerNodeSlice: hardBudget,
          resume,
          formal,
        });
        const rows = reference.comparisonRows.map((row) => normalizeComparisonRow(row, {
          profile,
          stressRate: row.stress_rate,
          seed,
          hardBudget,
        }));
        seedResult = {
          schema_version: EXPERIMENT10_SEED_SCHEMA_VERSION,
          status: "complete",
          generated_at: new Date().toISOString(),
          config_fingerprint: configFingerprint,
          profile_id: profile.id,
          seed,
          hard_budget_bytes_per_node_slice: hardBudget,
          rows,
        };
        await mkdir(seedRoot, { recursive: true });
        await writeJson(seedResultPath, seedResult);
        if (!retainBulk) await pruneSeedBulk(seedRoot);
      }
      rawRows.push(...seedResult.rows);
      seedManifests.push({ profile_id: profile.id, seed, result_json: seedResultPath });
    }
  }

  validateEqualBudgetMatrix(rawRows, {
    profileIds: profiles.map((profile) => profile.id),
    stressRates,
    seeds,
    methodIds: EXPERIMENT10_METHOD_IDS,
  });
  const fairnessRows = auditEqualBudgetFairness(rawRows, { requiredMethods: EXPERIMENT10_METHOD_IDS });
  if (formal && fairnessRows.some((row) => !row.ok)) throw new Error("Experiment 10 equal-budget fairness gate failed");
  const aggregateRows = aggregateEqualBudgetRows(rawRows, { metrics: REPORTED_METRICS });
  const effectRows = buildPairedMethodEffects(rawRows, {
    treatment: "enhanced",
    controls: ["native-full-replan", "native-reference-replay"],
    metricDirections: Object.fromEntries(REPORTED_METRICS.map((metric) => [metric, DEFAULT_METRIC_DIRECTIONS[metric]])),
  });
  const outputs = {
    raw_csv: join(outputDir, "experiment10-equal-budget-by-seed.csv"),
    aggregate_csv: join(outputDir, "experiment10-equal-budget-aggregate.csv"),
    effects_csv: join(outputDir, "experiment10-paired-effects.csv"),
    fairness_csv: join(outputDir, "experiment10-budget-fairness.csv"),
    summary_json: join(outputDir, "experiment10-equal-budget-summary.json"),
    manifest_json: join(outputDir, "experiment10-manifest.json"),
    report_html: join(outputDir, "experiment10-equal-budget-report.html"),
    root_report_md: rootReportPath,
  };
  const parameters = {
    profile_ids: profiles.map((profile) => profile.id),
    stress_rates: stressRates,
    seeds,
    seed_count: seeds.length,
    method_ids: EXPERIMENT10_METHOD_IDS,
    method_row_count: rawRows.length,
    hard_budgets_bytes_per_node_slice: budgets,
    budget_calibration: "maximum achieved B/node/slice across excluded Experiment 8 zero-stress calibration runs",
    retain_bulk: retainBulk,
  };
  const summary = {
    schema_version: "experiment10-equal-budget-dynamic-multiseed-v1",
    generated_at: new Date().toISOString(),
    formal,
    config_fingerprint: configFingerprint,
    implementation_fingerprint: implementationFingerprint,
    parameters,
    source_hashes: sourceHashes,
    raw_rows: rawRows,
    aggregate_rows: aggregateRows,
    paired_effect_rows: effectRows,
    fairness_rows: fairnessRows,
  };
  const manifest = {
    schema_version: "experiment10-manifest-v1",
    generated_at: summary.generated_at,
    status: "complete",
    host: { platform: platform(), release: release(), cpu_model: cpus()[0]?.model ?? "unknown", logical_cpu_count: cpus().length, total_memory_bytes: totalmem(), free_memory_bytes_at_report: freemem(), node_version: process.version },
    config_fingerprint: configFingerprint,
    implementation_fingerprint: implementationFingerprint,
    row_counts: { raw: rawRows.length, aggregate: aggregateRows.length, effects: effectRows.length, fairness: fairnessRows.length },
    outputs,
    seed_manifests: seedManifests,
  };
  await Promise.all([
    writeFile(outputs.raw_csv, rowsToCsv(rawRows), "utf8"),
    writeFile(outputs.aggregate_csv, rowsToCsv(aggregateRows), "utf8"),
    writeFile(outputs.effects_csv, rowsToCsv(effectRows), "utf8"),
    writeFile(outputs.fairness_csv, rowsToCsv(fairnessRows), "utf8"),
    writeJson(outputs.summary_json, summary),
    writeJson(outputs.manifest_json, manifest),
    writeFile(outputs.report_html, buildExperiment10Html({ aggregateRows, effectRows, fairnessRows, parameters }), "utf8"),
    writeFile(outputs.root_report_md, buildMarkdown({ aggregateRows, effectRows, fairnessRows, parameters, outputs }), "utf8"),
  ]);
  return { rawRows, aggregateRows, effectRows, fairnessRows, outputs, manifest };
}

async function main() {
  const args = process.argv.slice(2);
  const profileIds = listArg(args, "--profiles", PROFILE_CATALOG.map((profile) => profile.id));
  const profiles = profileIds.map((id) => {
    const profile = PROFILE_CATALOG.find((candidate) => candidate.id === id);
    if (!profile) throw new Error(`Unknown profile: ${id}`);
    return profile;
  });
  const budgets = { ...DEFAULT_PROFILE_BUDGETS, ...parseBudgetMap(argValue(args, "--budget-map", "")) };
  const result = await runExperiment10({
    profiles,
    stressRates: listArg(args, "--targets", EXPERIMENT10_STRESS_RATES).map(Number),
    seeds: parseSeeds(argValue(args, "--seeds", "10"), argValue(args, "--seed-prefix", "experiment10-seed")),
    budgets,
    oldRoot: resolve(argValue(args, "--old-root", "reports/experiment2-native-baseline-rerun-final")),
    outputDir: resolve(argValue(args, "--out", "reports/experiment10-equal-budget-dynamic-multiseed")),
    rootReportPath: resolve(argValue(args, "--root-report", "EXPERIMENT_10_EQUAL_BUDGET_REPORT.md")),
    resume: argValue(args, "--resume", "true").toLowerCase() !== "false",
    retainBulk: argValue(args, "--retain-bulk", "false").toLowerCase() === "true",
    formal: argValue(args, "--formal", "true").toLowerCase() !== "false",
  });
  console.log(JSON.stringify({ ok: true, rows: result.rawRows.length, aggregate_rows: result.aggregateRows.length, report: relative(process.cwd(), result.outputs.report_html) }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
