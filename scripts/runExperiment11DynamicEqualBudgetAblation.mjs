import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { cpus, freemem, platform, release, totalmem } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  DEFAULT_METRIC_DIRECTIONS,
  aggregateEqualBudgetRows,
  auditEqualBudgetFairness,
  validateEqualBudgetMatrix,
} from "./experiments/equalBudgetStatistics.mjs";
import {
  aggregateContributionSamples,
  buildContributionSamples,
  buildDynamicityInteractions,
} from "./experiments/dynamicAblationStatistics.mjs";
import {
  EXPERIMENT11_FULL_METHOD_ID,
  EXPERIMENT11_VARIANT_IDS,
  buildExperiment11Variants,
} from "./experiments/dynamicAblationVariants.mjs";
import { PROFILE_CATALOG, sha256File } from "./experiments/intMcExperimentCore.mjs";
import { escapeHtml, rowsToCsv } from "./experiments/reportUtils.mjs";
import { DEFAULT_PROFILE_BUDGETS } from "./runExperiment10EqualBudgetDynamicity.mjs";
import {
  experiment8ImplementationFingerprint,
  runExperiment8,
} from "./runExperiment8DynamicityCausality.mjs";

export const EXPERIMENT11_STRESS_RATES = Object.freeze([0, 0.25]);
export const EXPERIMENT11_REPORTED_METRICS = Object.freeze([
  "cpu_mae",
  "queue_depth_mae",
  "energy_percent_mae",
  "node_mode_accuracy",
  "link_utilization_mae",
  "link_status_accuracy",
  "planning_wall_time_ms",
  "reconstruction_wall_time_ms",
  "telemetry_padding_bytes_per_node_slice",
  "invalid_probe_path_ratio",
]);

const SEED_SCHEMA_VERSION = "experiment11-seed-result-v1";
const CONFIG_SCHEMA_VERSION = "experiment11-config-v1";

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

function stableHash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function parseSeeds(raw = "10", prefix = "experiment11-seed") {
  const count = Number(raw);
  if (Number.isInteger(count) && count > 0) {
    return Array.from({ length: count }, (_, index) => `${prefix}-${String(index).padStart(2, "0")}`);
  }
  const seeds = String(raw).split(",").map((value) => value.trim()).filter(Boolean);
  if (!seeds.length) throw new Error("At least one Experiment 11 seed is required");
  return seeds;
}

export function buildExperiment11Matrix({
  profileIds = PROFILE_CATALOG.map((profile) => profile.id),
  stressRates = EXPERIMENT11_STRESS_RATES,
  seeds = parseSeeds("10"),
  methodIds = EXPERIMENT11_VARIANT_IDS,
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

export function normalizeExperiment11Row(row, { profile, stressRate, seed, hardBudget }) {
  return {
    profile_id: profile.id,
    constellation_label: profile.short_label,
    node_count: profile.node_count,
    stress_rate: numberValue(stressRate),
    achieved_stress_rate: numberValue(row.achieved_stress_rate),
    achieved_mean_dynamicity: numberValue(row.achieved_mean_dynamicity),
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
    invalid_probe_path_ratio: numberValue(row.invalid_probe_path_ratio ?? row.path_failure_ratio),
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

export function buildExperiment11ConfigFingerprint(input) {
  return stableHash({ schema_version: CONFIG_SCHEMA_VERSION, ...input });
}

async function implementationFingerprint() {
  return stableHash({
    experiment8: await experiment8ImplementationFingerprint(),
    variants: await sha256File(resolve("scripts/experiments/dynamicAblationVariants.mjs")),
    statistics: await sha256File(resolve("scripts/experiments/dynamicAblationStatistics.mjs")),
    seed_schema_version: SEED_SCHEMA_VERSION,
  });
}

async function pruneSeedBulk(seedRoot) {
  const root = resolve(seedRoot);
  for (const child of [join(root, "dynamicity", "runs"), join(root, "dynamicity", "inputs")]) {
    const target = resolve(child);
    const separator = process.platform === "win32" ? "\\" : "/";
    if (!target.startsWith(`${root}${separator}`)) throw new Error(`Unsafe prune target: ${target}`);
    await rm(target, { recursive: true, force: true });
  }
}

function assertFairness(fairnessRows, formal) {
  const absoluteSpreadFailures = fairnessRows.filter((row) => numberValue(row.actual_bytes_per_node_slice_spread) > 1e-4);
  if (formal && (fairnessRows.some((row) => !row.ok) || absoluteSpreadFailures.length)) {
    throw new Error(`Experiment 11 equal-budget fairness gate failed (${absoluteSpreadFailures.length} absolute-spread failures)`);
  }
}

const METRIC_LABELS = Object.freeze({
  cpu_mae: "CPU MAE",
  queue_depth_mae: "队列 MAE",
  energy_percent_mae: "电量 MAE",
  node_mode_accuracy: "节点模式准确率",
  link_utilization_mae: "链路利用率 MAE",
  link_status_accuracy: "链路状态准确率",
  planning_wall_time_ms: "规划时间",
  reconstruction_wall_time_ms: "重构时间",
  telemetry_padding_bytes_per_node_slice: "无信息 padding",
  invalid_probe_path_ratio: "无效探测路径比例",
});

function resultClass(low, high) {
  if (numberValue(low) > 0) return "positive";
  if (numberValue(high) < 0) return "negative";
  return "uncertain";
}

function methodColor(methodId) {
  const index = EXPERIMENT11_VARIANT_IDS.indexOf(methodId);
  return ["#006d77", "#d97706", "#7c3aed", "#b91c1c", "#3f6212", "#0369a1"][Math.max(index, 0) % 6];
}

function ciChart(rows, metric, title) {
  const width = 900;
  const height = 360;
  const margin = { left: 70, right: 20, top: 28, bottom: 92 };
  const values = rows.flatMap((row) => [
    numberValue(row[`${metric}_ci95_low`]),
    numberValue(row[`${metric}_ci95_high`]),
  ]);
  const minimum = Math.min(...values, 0);
  const maximum = Math.max(...values, minimum + 1e-9);
  const groups = [...new Set(rows.map((row) => `${row.profile_id}|${row.stress_rate}`))];
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const x = (groupIndex, methodIndex) => margin.left
    + ((groupIndex + 0.08 + (methodIndex + 0.5) * 0.14) / Math.max(groups.length, 1)) * plotWidth;
  const y = (value) => margin.top + ((maximum - value) / Math.max(maximum - minimum, 1e-12)) * plotHeight;
  const marks = rows.map((row) => {
    const groupIndex = groups.indexOf(`${row.profile_id}|${row.stress_rate}`);
    const methodIndex = EXPERIMENT11_VARIANT_IDS.indexOf(row.method_id);
    const px = x(groupIndex, Math.max(methodIndex, 0));
    const center = y(numberValue(row[`${metric}_mean`]));
    const low = y(numberValue(row[`${metric}_ci95_low`]));
    const high = y(numberValue(row[`${metric}_ci95_high`]));
    const color = methodColor(row.method_id);
    return `<g><title>${escapeHtml(row.method_label)}：${row[`${metric}_mean`]}</title><line x1="${px}" y1="${high}" x2="${px}" y2="${low}" stroke="${color}" stroke-width="2"/><line x1="${px - 4}" y1="${high}" x2="${px + 4}" y2="${high}" stroke="${color}"/><line x1="${px - 4}" y1="${low}" x2="${px + 4}" y2="${low}" stroke="${color}"/><circle cx="${px}" cy="${center}" r="4" fill="${color}"/></g>`;
  }).join("");
  const labels = groups.map((key, index) => {
    const [profileId, stressRate] = key.split("|");
    const label = profileId.includes("small") ? "小型" : profileId.includes("medium") ? "中型" : "大型";
    return `<text x="${x(index, 2.5)}" y="${height - 58}" text-anchor="middle" font-size="11">${label} / ${(Number(stressRate) * 100).toFixed(0)}%</text>`;
  }).join("");
  return `<section><h3>${escapeHtml(title)}（均值与 Student-t 95% CI）</h3><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(title)}"><line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${height - margin.bottom}" class="axis"/><line x1="${margin.left}" y1="${height - margin.bottom}" x2="${width - margin.right}" y2="${height - margin.bottom}" class="axis"/>${marks}${labels}<text x="${margin.left - 8}" y="${margin.top + 4}" text-anchor="end" font-size="10">${round(maximum, 3)}</text><text x="${margin.left - 8}" y="${height - margin.bottom}" text-anchor="end" font-size="10">${round(minimum, 3)}</text></svg></section>`;
}

function legendHtml(variants) {
  return `<div class="legend">${variants.map((variant) => `<span><i style="background:${methodColor(variant.id)}"></i>${escapeHtml(variant.label)}</span>`).join("")}</div>`;
}

function fairnessHtml(rows) {
  const grouped = new Map();
  for (const row of rows) {
    const key = `${row.profile_id}|${row.stress_rate}`;
    const group = grouped.get(key) ?? [];
    group.push(row);
    grouped.set(key, group);
  }
  const body = [...grouped.values()].map((group) => {
    const first = group[0];
    return `<tr><td>${escapeHtml(first.constellation_label || first.profile_id)}</td><td>${(numberValue(first.stress_rate) * 100).toFixed(0)}%</td><td>${group.length}</td><td>${round(first.hard_cap_bytes_per_node_slice, 4)}</td><td>${round(Math.max(...group.map((row) => numberValue(row.actual_bytes_per_node_slice_spread))), 6)}</td><td>${group.reduce((total, row) => total + numberValue(row.cap_violations), 0)}</td><td>${group.every((row) => row.ok) ? "通过" : "失败"}</td></tr>`;
  }).join("");
  return `<table><thead><tr><th>星座</th><th>动态压力</th><th>配对种子</th><th>硬上限 B/节点/片</th><th>最大实际字节差</th><th>超限次数</th><th>门禁</th></tr></thead><tbody>${body}</tbody></table>`;
}

function contributionHeatmap(rows, variantLabels) {
  const displayRows = rows.filter((row) => !["telemetry_padding_bytes_per_node_slice"].includes(row.metric));
  const body = displayRows.map((row) => {
    const classification = resultClass(row.contribution_ci95_low, row.contribution_ci95_high);
    return `<tr><td>${escapeHtml(row.constellation_label || row.profile_id)}</td><td>${(numberValue(row.stress_rate) * 100).toFixed(0)}%</td><td>${escapeHtml(variantLabels.get(row.ablation_method_id) ?? row.ablation_method_id)}</td><td>${escapeHtml(METRIC_LABELS[row.metric] ?? row.metric)}</td><td class="heat ${classification}">${row.contribution_mean}</td><td>[${row.contribution_ci95_low}, ${row.contribution_ci95_high}]</td><td>${row.cohen_dz}</td><td>${classification === "positive" ? "有贡献" : classification === "negative" ? "负贡献" : "不确定"}</td></tr>`;
  }).join("");
  return `<div class="table-scroll"><table><thead><tr><th>星座</th><th>动态压力</th><th>被移除机制组</th><th>指标</th><th>完整方案贡献</th><th>95% CI</th><th>Cohen dz</th><th>判定</th></tr></thead><tbody>${body}</tbody></table></div>`;
}

function interactionHtml(rows, variantLabels) {
  const body = rows.map((row) => {
    const classification = resultClass(row.interaction_ci95_low, row.interaction_ci95_high);
    return `<tr><td>${escapeHtml(row.constellation_label || row.profile_id)}</td><td>${escapeHtml(variantLabels.get(row.ablation_method_id) ?? row.ablation_method_id)}</td><td>${escapeHtml(METRIC_LABELS[row.metric] ?? row.metric)}</td><td class="heat ${classification}">${row.interaction_mean}</td><td>[${row.interaction_ci95_low}, ${row.interaction_ci95_high}]</td><td>${classification === "positive" ? "动态环境下价值增加" : classification === "negative" ? "动态环境下价值下降" : "交互不确定"}</td></tr>`;
  }).join("");
  return `<div class="table-scroll"><table><thead><tr><th>星座</th><th>被移除机制组</th><th>指标</th><th>25%-0% 贡献差</th><th>95% CI</th><th>解释</th></tr></thead><tbody>${body}</tbody></table></div>`;
}

function conclusionSummary(contributionRows, interactionRows) {
  const classify = (rows, lowField, highField) => rows.reduce((counts, row) => {
    counts[resultClass(row[lowField], row[highField])] += 1;
    return counts;
  }, { positive: 0, negative: 0, uncertain: 0 });
  return {
    contribution: classify(contributionRows, "contribution_ci95_low", "contribution_ci95_high"),
    interaction: classify(interactionRows, "interaction_ci95_low", "interaction_ci95_high"),
  };
}

export function buildExperiment11Html({
  aggregateRows = [], contributionRows = [], interactionRows = [], fairnessRows = [], parameters = {}, variants = [],
} = {}) {
  const labels = new Map(variants.map((variant) => [variant.id, variant.label]));
  const conclusions = conclusionSummary(contributionRows, interactionRows);
  const charts = [
    ["cpu_mae", "CPU 状态重构误差"],
    ["energy_percent_mae", "电量状态重构误差"],
    ["link_utilization_mae", "链路利用率重构误差"],
    ["planning_wall_time_ms", "在线路径规划计算开销"],
  ].map(([metric, title]) => ciChart(aggregateRows, metric, title)).join("");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>实验 11 动态等预算机制消融</title><style>body{margin:0;background:#f3f6f7;color:#18272e;font-family:"Microsoft YaHei",Arial,sans-serif}main{max-width:1540px;margin:auto;padding:28px}header{border-bottom:4px solid #006d77;padding-bottom:18px}section{background:#fff;border:1px solid #d6e0e3;margin:16px 0;padding:18px;border-radius:4px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(560px,1fr));gap:14px}.grid section{margin:0}svg{width:100%;height:auto}.axis{stroke:#6b7f87}.legend{display:flex;flex-wrap:wrap;gap:12px;margin:14px 0}.legend span{display:flex;align-items:center;font-size:12px}.legend i{width:10px;height:10px;margin-right:5px}.table-scroll{max-height:680px;overflow:auto;border:1px solid #d6e0e3}table{width:100%;border-collapse:collapse;font-size:12px}th,td{border:1px solid #d6e0e3;padding:7px;text-align:right}th{position:sticky;top:0;background:#e7eff1;z-index:1}th:first-child,td:first-child,th:nth-child(3),td:nth-child(3),th:nth-child(4),td:nth-child(4){text-align:left}.heat.positive{background:#d7f2e3;color:#14532d}.heat.negative{background:#fee2e2;color:#991b1b}.heat.uncertain{background:#fef3c7;color:#854d0e}.callout{border-left:4px solid #d97706;padding:10px 14px;background:#fff8e8}.metric-strip{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}.metric-strip div{background:#e7eff1;padding:12px}.metric-strip strong{font-size:24px;display:block}@media(max-width:720px){main{padding:14px}.grid{grid-template-columns:1fr}.metric-strip{grid-template-columns:1fr}}</style></head><body><main><header><h1>实验 11：动态 LEO 环境下严格等实际字节预算的机制消融</h1><p>三种星座规模、0% 与 25% 受控拓扑扰动、${parameters.seed_count ?? 0} 个配对种子、六种机制配置。每个同场景变体共享第一阶段真值，并使用相同实际遥测硬上限。</p></header><section><h2>实验定义</h2><p>完整增强版依次移除五类机制组。对于误差和耗时，贡献定义为“消融值减完整值”；对于准确率，贡献定义为“完整值减消融值”。因此所有指标中，正值均表示保留该机制有益。</p><p>动态性交互效应定义为 25% 压力下贡献减去 0% 压力下贡献。正值表示该机制在高动态环境中更重要。</p><div class="callout">未使用的预算通过不携带观测信息的 padding 补齐。padding 计入网络字节与能耗，但不会增加覆盖率或改善重构结果。</div>${legendHtml(variants)}</section><section><h2>预算公平性</h2>${fairnessHtml(fairnessRows)}</section><section><h2>主要结论</h2><div class="metric-strip"><div><strong>${conclusions.contribution.positive}</strong>稳定正贡献</div><div><strong>${conclusions.contribution.negative}</strong>稳定负贡献</div><div><strong>${conclusions.contribution.uncertain}</strong>统计不确定</div></div><p>结论按星座规模、动态压力和指标逐项报告。稳定负贡献不会删除；置信区间跨 0 的结果不解释为优势。</p></section><div class="grid">${charts}</div><section><h2>机制贡献热力表</h2>${contributionHeatmap(contributionRows, labels)}</section><section><h2>动态性交互效应</h2><p>该表回答“某项机制是否因为 LEO 拓扑更动态而变得更有价值”，而不是只回答静态平均效果。</p>${interactionHtml(interactionRows, labels)}</section><section><h2>负结果与边界</h2><p>本实验是第一阶段仿真真值上的因果消融证据，不是 Starlink 运营商内部遥测。节点 CPU、电量与队列指标的可信度仍取决于第一阶段模型；严格等预算消除了网络字节差异，但 padding 比例较高时说明方法没有充分利用可用预算。</p><p>贡献统计共 ${contributionRows.length} 项，其中 ${conclusions.contribution.negative} 项稳定为负；交互统计共 ${interactionRows.length} 项，其中 ${conclusions.interaction.negative} 项在高动态条件下表现更差。所有结果均保留在 CSV。</p></section></main></body></html>`;
}

function buildExperiment11Markdown({ contributionRows, interactionRows, fairnessRows, parameters, outputs }) {
  const conclusions = conclusionSummary(contributionRows, interactionRows);
  return `# 实验 11：动态等预算机制消融\n\n- 星座规模：${parameters.profile_ids.length}\n- 动态压力：${parameters.stress_rates.join("、")}\n- 配对种子：${parameters.seed_count}\n- 机制配置：${parameters.variant_ids.length}\n- 公平性门禁：${fairnessRows.filter((row) => row.ok).length}/${fairnessRows.length}\n- 稳定正贡献：${conclusions.contribution.positive}\n- 稳定负贡献：${conclusions.contribution.negative}\n- 统计不确定：${conclusions.contribution.uncertain}\n\n本实验在完全相同的实际遥测字节上限下，对完整增强版 LEO-INT-MC 的五类机制组进行逐组移除。正贡献表示移除机制后结果变差，即该机制对完整方案有实质帮助。动态性交互效应为 25% 与 0% 压力下贡献之差。\n\n## 严格等预算\n\n所有变体均采用发送前硬预算准入，并用无信息 padding 对齐实际网络负载。padding 计入网络字节和能耗，不携带 metadata，也不产生覆盖收益。\n\n## 结果边界\n\n报告保留 ${conclusions.contribution.negative} 项稳定负贡献和 ${conclusions.contribution.uncertain} 项统计不确定结果。本实验用于识别增强机制的因果贡献，不能替代真实运营网络或独立包级仿真验证。\n\n## 产物\n\n- 可视化报告：${outputs.report_html}\n- 逐种子结果：${outputs.raw_csv}\n- 机制贡献：${outputs.contribution_csv}\n- 动态性交互：${outputs.interaction_csv}\n- 公平性审计：${outputs.fairness_csv}\n`;
}

export async function runExperiment11({
  profiles = PROFILE_CATALOG,
  stressRates = EXPERIMENT11_STRESS_RATES,
  seeds = parseSeeds("10"),
  budgets = DEFAULT_PROFILE_BUDGETS,
  oldRoot = resolve("reports/experiment2-native-baseline-rerun-final"),
  outputDir = resolve("reports/experiment11-dynamic-equal-budget-ablation"),
  rootReportPath = resolve("EXPERIMENT_11_DYNAMIC_ABLATION_REPORT.md"),
  resume = true,
  retainBulk = false,
  formal = true,
} = {}) {
  await Promise.all([mkdir(outputDir, { recursive: true }), mkdir(dirname(rootReportPath), { recursive: true })]);
  const variants = buildExperiment11Variants();
  const sourceHashes = {};
  for (const profile of profiles) {
    sourceHashes[profile.id] = {
      metadata_sha256: await sha256File(join(oldRoot, profile.id, "stage1-truth", "metadata.json")),
      candidate_paths_sha256: await sha256File(join(oldRoot, profile.id, "experiment2", "stage2", "full-probe-int", "probe-paths-path-balance.csv")),
    };
  }
  const implementation = await implementationFingerprint();
  const configFingerprint = buildExperiment11ConfigFingerprint({
    profile_ids: profiles.map((profile) => profile.id),
    stress_rates: stressRates,
    seeds,
    budgets,
    source_hashes: sourceHashes,
    variant_ids: EXPERIMENT11_VARIANT_IDS,
    variant_mechanisms: variants.map((variant) => ({ id: variant.id, mechanisms: variant.mechanisms })),
    implementation_fingerprint: implementation,
    telemetry_byte_budget_pad_to_cap: true,
  });
  const rawRows = [];
  const seedManifests = [];

  for (const profile of profiles) {
    const hardBudget = numberValue(budgets[profile.id]);
    if (hardBudget <= 0) throw new Error(`Missing positive Experiment 11 hard budget for ${profile.id}`);
    for (const seed of seeds) {
      const seedRoot = join(outputDir, "runs", profile.id, seed);
      const seedConfigPath = join(seedRoot, "seed-config.json");
      const seedResultPath = join(seedRoot, "seed-result.json");
      let seedResult = null;
      if (resume && existsSync(seedResultPath)) {
        const cached = await readJson(seedResultPath);
        if (cached.status === "complete" && cached.config_fingerprint === configFingerprint) seedResult = cached;
      }
      if (!seedResult) {
        let retainPartial = false;
        if (resume && existsSync(seedConfigPath)) {
          const previousConfig = await readJson(seedConfigPath);
          retainPartial = previousConfig.config_fingerprint === configFingerprint;
        }
        if (!retainPartial) await rm(join(seedRoot, "dynamicity"), { recursive: true, force: true });
        await mkdir(seedRoot, { recursive: true });
        await writeJson(seedConfigPath, {
          schema_version: CONFIG_SCHEMA_VERSION,
          config_fingerprint: configFingerprint,
          profile_id: profile.id,
          seed,
          variants: variants.map((variant) => ({ id: variant.id, mechanisms: variant.mechanisms })),
        });
        const run = await runExperiment8({
          profiles: [profile],
          stressRates,
          methods: variants,
          oldRoot,
          outputDir: join(seedRoot, "dynamicity"),
          rootReportPath: join(seedRoot, "dynamicity-report.md"),
          seed: `experiment11:${seed}`,
          resume,
          formal,
          parameters: {
            telemetryByteBudgetPerNodeSlice: hardBudget,
            telemetryByteBudgetPadToCap: true,
            writeEstimateGraph: false,
          },
        });
        const rows = run.summaryRows.map((row) => normalizeExperiment11Row(row, {
          profile,
          stressRate: row.target_stress_rate,
          seed,
          hardBudget,
        }));
        seedResult = {
          schema_version: SEED_SCHEMA_VERSION,
          status: "complete",
          generated_at: new Date().toISOString(),
          config_fingerprint: configFingerprint,
          profile_id: profile.id,
          seed,
          hard_budget_bytes_per_node_slice: hardBudget,
          rows,
        };
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
    methodIds: EXPERIMENT11_VARIANT_IDS,
  });
  const fairnessRows = auditEqualBudgetFairness(rawRows, {
    requiredMethods: EXPERIMENT11_VARIANT_IDS,
    primaryMatchedMethods: EXPERIMENT11_VARIANT_IDS,
    achievedBudgetToleranceRatio: 1e-7,
  });
  assertFairness(fairnessRows, formal);
  const aggregateRows = aggregateEqualBudgetRows(rawRows, { metrics: EXPERIMENT11_REPORTED_METRICS });
  const metricDirections = Object.fromEntries(
    EXPERIMENT11_REPORTED_METRICS.map((metric) => [metric, DEFAULT_METRIC_DIRECTIONS[metric]]),
  );
  const ablationMethodIds = EXPERIMENT11_VARIANT_IDS.filter((id) => id !== EXPERIMENT11_FULL_METHOD_ID);
  const contributionSamples = buildContributionSamples(rawRows, {
    fullMethodId: EXPERIMENT11_FULL_METHOD_ID,
    ablationMethodIds,
    metricDirections,
  });
  const contributionRows = aggregateContributionSamples(contributionSamples);
  const interactionRows = buildDynamicityInteractions(contributionSamples, {
    lowStress: Math.min(...stressRates),
    highStress: Math.max(...stressRates),
  });
  const outputs = {
    raw_csv: join(outputDir, "experiment11-ablation-by-seed.csv"),
    aggregate_csv: join(outputDir, "experiment11-ablation-aggregate.csv"),
    contribution_samples_csv: join(outputDir, "experiment11-contribution-samples.csv"),
    contribution_csv: join(outputDir, "experiment11-mechanism-contributions.csv"),
    interaction_csv: join(outputDir, "experiment11-dynamicity-interactions.csv"),
    fairness_csv: join(outputDir, "experiment11-budget-fairness.csv"),
    summary_json: join(outputDir, "experiment11-summary.json"),
    manifest_json: join(outputDir, "experiment11-manifest.json"),
    report_html: join(outputDir, "experiment11-dynamic-ablation-report.html"),
    root_report_md: rootReportPath,
  };
  const generatedAt = new Date().toISOString();
  const parameters = {
    profile_ids: profiles.map((profile) => profile.id),
    stress_rates: stressRates,
    seeds,
    seed_count: seeds.length,
    variant_ids: EXPERIMENT11_VARIANT_IDS,
    hard_budgets_bytes_per_node_slice: budgets,
    telemetry_byte_budget_pad_to_cap: true,
    retain_bulk: retainBulk,
  };
  const summary = {
    schema_version: "experiment11-dynamic-equal-budget-ablation-v1",
    generated_at: generatedAt,
    formal,
    status: "complete",
    config_fingerprint: configFingerprint,
    implementation_fingerprint: implementation,
    parameters,
    source_hashes: sourceHashes,
    raw_rows: rawRows,
    aggregate_rows: aggregateRows,
    contribution_rows: contributionRows,
    dynamicity_interaction_rows: interactionRows,
    fairness_rows: fairnessRows,
  };
  const manifest = {
    schema_version: "experiment11-manifest-v1",
    generated_at: generatedAt,
    status: "complete",
    formal,
    host: {
      platform: platform(), release: release(), cpu_model: cpus()[0]?.model ?? "unknown",
      logical_cpu_count: cpus().length, total_memory_bytes: totalmem(),
      free_memory_bytes_at_report: freemem(), node_version: process.version,
    },
    config_fingerprint: configFingerprint,
    implementation_fingerprint: implementation,
    row_counts: {
      raw: rawRows.length,
      aggregate: aggregateRows.length,
      contribution_samples: contributionSamples.length,
      contributions: contributionRows.length,
      interactions: interactionRows.length,
      fairness: fairnessRows.length,
    },
    outputs,
    seed_manifests: seedManifests,
  };
  await Promise.all([
    writeFile(outputs.raw_csv, rowsToCsv(rawRows), "utf8"),
    writeFile(outputs.aggregate_csv, rowsToCsv(aggregateRows), "utf8"),
    writeFile(outputs.contribution_samples_csv, rowsToCsv(contributionSamples), "utf8"),
    writeFile(outputs.contribution_csv, rowsToCsv(contributionRows), "utf8"),
    writeFile(outputs.interaction_csv, rowsToCsv(interactionRows), "utf8"),
    writeFile(outputs.fairness_csv, rowsToCsv(fairnessRows), "utf8"),
    writeJson(outputs.summary_json, summary),
    writeJson(outputs.manifest_json, manifest),
    writeFile(outputs.report_html, buildExperiment11Html({
      aggregateRows,
      contributionRows,
      interactionRows,
      fairnessRows,
      parameters,
      variants,
    }), "utf8"),
    writeFile(outputs.root_report_md, buildExperiment11Markdown({
      contributionRows,
      interactionRows,
      fairnessRows,
      parameters,
      outputs,
    }), "utf8"),
  ]);
  return {
    rawRows, aggregateRows, contributionSamples, contributionRows, interactionRows,
    fairnessRows, outputs, manifest,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const profileIds = listArg(args, "--profiles", PROFILE_CATALOG.map((profile) => profile.id));
  const profiles = profileIds.map((id) => {
    const profile = PROFILE_CATALOG.find((candidate) => candidate.id === id);
    if (!profile) throw new Error(`Unknown profile: ${id}`);
    return profile;
  });
  const result = await runExperiment11({
    profiles,
    stressRates: listArg(args, "--targets", EXPERIMENT11_STRESS_RATES).map(Number),
    seeds: parseSeeds(argValue(args, "--seeds", "10"), argValue(args, "--seed-prefix", "experiment11-seed")),
    oldRoot: resolve(argValue(args, "--old-root", "reports/experiment2-native-baseline-rerun-final")),
    outputDir: resolve(argValue(args, "--out", "reports/experiment11-dynamic-equal-budget-ablation")),
    rootReportPath: resolve(argValue(args, "--root-report", "EXPERIMENT_11_DYNAMIC_ABLATION_REPORT.md")),
    resume: argValue(args, "--resume", "true").toLowerCase() !== "false",
    retainBulk: argValue(args, "--retain-bulk", "false").toLowerCase() === "true",
    formal: argValue(args, "--formal", "true").toLowerCase() !== "false",
  });
  console.log(JSON.stringify({
    ok: true,
    rows: result.rawRows.length,
    aggregate_rows: result.aggregateRows.length,
    report: relative(process.cwd(), result.outputs.report_html),
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
