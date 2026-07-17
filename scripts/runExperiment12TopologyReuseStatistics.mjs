import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { freemem } from "node:os";
import {
  PROFILE_CATALOG,
  runCommandTimed,
  sha256File,
} from "./experiments/intMcExperimentCore.mjs";
import { escapeHtml, parseCsv, rowsToCsv } from "./experiments/reportUtils.mjs";
import { transformDynamicityTrace } from "./experiments/dynamicityStress.mjs";
import {
  auditCausalReplay,
  buildControlledOutageSchedule,
  compareCausalResponse,
} from "./experiments/dynamicityCausalReplay.mjs";
import {
  TOPOLOGY_REUSE_EVIDENCE_PROFILES,
  TOPOLOGY_REUSE_EVIDENCE_VARIANTS,
  aggregateTopologyReusePairedEffects,
  buildTopologyReuseEvidenceMatrix,
  buildTopologyReusePairedRows,
  buildTopologyReusePreregistration,
  evaluateTopologyReuseEvidence,
  scanTopologyReuseEligibility,
} from "./experiments/topologyReuseStatisticalEvidence.mjs";

const DEFAULT_OUTPUT_DIR = resolve("reports/experiment12-topology-reuse-statistical-evidence");
const SLICE_COUNT = 48;
const GIB = 1024 ** 3;

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

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function waitForFreeMemory(minimumFreeMemoryGb) {
  const minimumBytes = Math.max(0, numberValue(minimumFreeMemoryGb)) * GIB;
  while (minimumBytes > 0 && freemem() < minimumBytes) {
    console.log(`[Experiment 12 statistical] memory guard waiting: free=${round(freemem() / GIB, 2)} GiB, required=${minimumFreeMemoryGb} GiB`);
    await delay(10_000);
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function readCsv(path) {
  return parseCsv(await readFile(path, "utf8"));
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function profileLabel(profileId) {
  return PROFILE_CATALOG.find((profile) => profile.id === profileId)?.short_label ?? profileId;
}

function baselineDir(outputDir, scenario) {
  return join(outputDir, "inputs", scenario.profile_id, scenario.window_id, "baseline");
}

function scenarioDir(outputDir, scenario) {
  return join(outputDir, "cases", scenario.profile_id, scenario.case_id);
}

function causalTruthDir(outputDir, scenario) {
  return join(scenarioDir(outputDir, scenario), "stress-root", scenario.profile_id, scenario.stress_id);
}

function candidateOutputDir(outputDir, scenario) {
  return join(
    scenarioDir(outputDir, scenario),
    "source-root",
    scenario.profile_id,
    "experiment2",
    "stage2",
    "full-probe-int",
  );
}

function caseResultDir(outputDir, scenario) {
  return join(scenarioDir(outputDir, scenario), "experiment12");
}

function epochMatches(metadata, scenario) {
  return metadata?.slice_count === SLICE_COUNT &&
    String(metadata?.simulation_epoch_iso ?? "") === scenario.epoch_iso &&
    numberValue(metadata?.node_count) === numberValue(
      PROFILE_CATALOG.find((profile) => profile.id === scenario.profile_id)?.node_count,
    );
}

async function ensurePreregistration(outputDir, { reset = false } = {}) {
  const preregistration = buildTopologyReusePreregistration();
  const path = join(outputDir, "PREREGISTRATION.json");
  if (existsSync(path) && !reset) {
    const existing = await readJson(path);
    if (existing.design_sha256 !== preregistration.design_sha256) {
      throw new Error("The existing preregistration differs from the current design; use a new output directory");
    }
    return existing;
  }
  await mkdir(outputDir, { recursive: true });
  const artifact = { preregistered_at: new Date().toISOString(), ...preregistration };
  await writeJson(path, artifact);
  await writeFile(
    join(outputDir, "PREREGISTRATION.md"),
    `# 实验 12：拓扑复用统计证据预注册\n\n` +
      `- 设计指纹：\`${artifact.design_sha256}\`\n` +
      `- 设计：3 个时间窗口 × 3 个动态压力档 × 3 个扰动 seed 的 3×3 拉丁方。\n` +
      `- 配对方案：\`full-unified\` 对 \`no-topology-version\`，同一场景共享真值、pass-1 OAM、补全器和硬字节预算。\n` +
      `- 主指标：边际评估次数、评分缓存重算次数。墙钟时间只作为易受系统噪声影响的次指标。\n` +
      `- 非劣门禁：最大 MAE 退化不超过 1%，遥测字节增加不超过 1%，硬预算、因果和路径合法性全部通过。\n` +
      `- seed 含义：固定同一窗口的初始断链 mask，只改变后续受控链路交换顺序。\n` +
      `- 中性 pass-1：双方共同使用 \`efficient-fresh\` 统一规划器；它不启用拓扑复用，避免旧版预热规划器成为共同耗时瓶颈。\n` +
      `- 协议修订：最初两个实现试点使用旧版中性 pass-1；发现共同预热规划耗时 271 秒后作废并重跑。正式处理、预算、指标和门禁均未改变。\n` +
      `- 窗口和矩阵在读取 INT/OAM 结果前固定，拓扑扫描不得用于删除不利场景。\n`,
    "utf8",
  );
  return artifact;
}

async function ensureBaselineTruth({ outputDir, scenario, resume }) {
  const output = baselineDir(outputDir, scenario);
  const metadataPath = join(output, "metadata.json");
  if (resume && existsSync(metadataPath)) {
    const metadata = await readJson(metadataPath);
    if (epochMatches(metadata, scenario)) return { output, metadata, resumed: true };
  }
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  const command = await runCommandTimed({
    label: `Experiment 12 baseline ${scenario.profile_id}/${scenario.window_id}`,
    script: "scripts/exportScenario.mjs",
    args: [
      "--profile", "normal",
      "--constellation-profile", scenario.profile_id,
      "--orbit", "real-tle-sgp4",
      "--mode", "operational",
      "--routing", "congestion-aware-shortest-path",
      "--slices", String(SLICE_COUNT),
      "--epoch-iso", scenario.epoch_iso,
      "--out", output,
    ],
  });
  const metadata = await readJson(metadataPath);
  if (!epochMatches(metadata, scenario)) throw new Error(`Baseline epoch audit failed for ${scenario.case_id}`);
  return { output, metadata, resumed: false, timing: command.timing };
}

async function transformedTopology({ baseline, scenario }) {
  const links = await readCsv(join(baseline.output, "links.csv"));
  return transformDynamicityTrace({
    links,
    targetStressRate: scenario.stress_rate,
    seed: `experiment12-statistical:${scenario.profile_id}:${scenario.seed}`,
    initialMaskSeed: `experiment12-statistical-initial:${scenario.profile_id}:${scenario.window_id}`,
    tolerance: 0.01,
  });
}

async function runTopologyScan({ outputDir, scenarios, resume = true }) {
  const summaryRows = [];
  const perSliceRows = [];
  for (const scenario of scenarios) {
    console.log(`[Experiment 12 statistical scan] ${scenario.profile_id} ${scenario.case_id}`);
    const baseline = await ensureBaselineTruth({ outputDir, scenario, resume });
    const transformed = await transformedTopology({ baseline, scenario });
    const scan = scanTopologyReuseEligibility(transformed.links, { cacheWindowSlices: 12 });
    summaryRows.push({
      ...scenario,
      profile_label: profileLabel(scenario.profile_id),
      achieved_stress_rate: round(transformed.summary.achieved_stress_rate),
      achieved_mean_dynamicity: round(transformed.summary.achieved_mean_dynamicity),
      ...scan.summary,
    });
    perSliceRows.push(...scan.per_slice.map((row) => ({ ...scenario, ...row })));
  }
  await Promise.all([
    writeFile(join(outputDir, "topology-scan-summary.csv"), rowsToCsv(summaryRows), "utf8"),
    writeFile(join(outputDir, "topology-scan-by-slice.csv"), rowsToCsv(perSliceRows), "utf8"),
    writeJson(join(outputDir, "topology-scan.json"), {
      schema_version: "experiment12-topology-reuse-scan-v1",
      generated_at: new Date().toISOString(),
      role: "preregistered eligibility audit only; no scenario is removed based on scan outcomes",
      summary_rows: summaryRows,
    }),
  ]);
  return { summaryRows, perSliceRows };
}

async function ensureCausalTruth({ outputDir, scenario, baseline, resume }) {
  const output = causalTruthDir(outputDir, scenario);
  const metadataPath = join(output, "metadata.json");
  const expectedSeed = `experiment12-statistical:${scenario.profile_id}:${scenario.seed}`;
  if (resume && existsSync(metadataPath)) {
    const metadata = await readJson(metadataPath);
    const cached = metadata.experiment12_statistical_scenario;
    if (epochMatches(metadata, scenario) && cached?.case_id === scenario.case_id && cached?.seed === expectedSeed) {
      return { output, metadata, resumed: true };
    }
  }

  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  const transformed = await transformedTopology({ baseline, scenario });
  const outageSchedule = buildControlledOutageSchedule(transformed.links);
  const outagePath = join(output, "experiment12-outage-schedule.json");
  await writeJson(outagePath, outageSchedule);
  const replay = await runCommandTimed({
    label: `Experiment 12 causal truth ${scenario.profile_id}/${scenario.case_id}`,
    script: "scripts/exportScenario.mjs",
    args: [
      "--profile", "normal",
      "--constellation-profile", scenario.profile_id,
      "--orbit", "real-tle-sgp4",
      "--mode", "operational",
      "--routing", "congestion-aware-shortest-path",
      "--slices", String(SLICE_COUNT),
      "--epoch-iso", scenario.epoch_iso,
      "--link-outage-schedule", outagePath,
      "--out", output,
    ],
  });
  const [metadata, links, nodes, routes, taskTraces, baselineNodes, baselineLinks, baselineRoutes] = await Promise.all([
    readJson(metadataPath),
    readCsv(join(output, "links.csv")),
    readCsv(join(output, "nodes.csv")),
    readCsv(join(output, "routes.csv")),
    readCsv(join(output, "task-traces.csv")),
    readCsv(join(baseline.output, "nodes.csv")),
    readCsv(join(baseline.output, "links.csv")),
    readCsv(join(baseline.output, "routes.csv")),
  ]);
  const causalAudit = auditCausalReplay({ links, routes, taskTraces });
  if (!causalAudit.ok) throw new Error(`Causal truth audit failed for ${scenario.case_id}: ${causalAudit.violations.join("; ")}`);
  if (metadata.config_fingerprint !== baseline.metadata.config_fingerprint || metadata.dataset_fingerprint !== baseline.metadata.dataset_fingerprint) {
    throw new Error(`Causal truth changed config or workload fingerprint for ${scenario.case_id}`);
  }
  const causalResponse = compareCausalResponse({
    baselineNodes,
    replayNodes: nodes,
    baselineLinks,
    replayLinks: links,
    baselineRoutes,
    replayRoutes: routes,
  });
  metadata.experiment12_statistical_scenario = {
    ...scenario,
    seed: expectedSeed,
    initial_mask_seed: `experiment12-statistical-initial:${scenario.profile_id}:${scenario.window_id}`,
    achieved_stress_rate: transformed.summary.achieved_stress_rate,
    achieved_mean_dynamicity: transformed.summary.achieved_mean_dynamicity,
    causal_audit: causalAudit,
    causal_response: causalResponse,
    causal_replay_wall_time_ms: replay.timing.wall_time_ms,
  };
  await Promise.all([
    writeJson(metadataPath, metadata),
    writeJson(join(output, "experiment12-dynamicity.json"), transformed.summary),
    writeFile(join(output, "experiment12-dynamicity-by-slice.csv"), rowsToCsv(transformed.bySlice), "utf8"),
    writeFile(join(output, "experiment12-mutations.csv"), rowsToCsv(transformed.mutations), "utf8"),
  ]);
  return { output, metadata, resumed: false, timing: replay.timing };
}

async function ensureCandidatePaths({ outputDir, scenario, truth, resume }) {
  const output = candidateOutputDir(outputDir, scenario);
  const path = join(output, "probe-paths-path-balance.csv");
  const manifestPath = join(output, "candidate-manifest.json");
  const truthHash = await sha256File(join(truth.output, "links.csv"));
  if (resume && existsSync(path) && existsSync(manifestPath)) {
    const manifest = await readJson(manifestPath);
    if (manifest.truth_links_sha256 === truthHash) return { output, path, resumed: true };
  }
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  const command = await runCommandTimed({
    label: `Experiment 12 candidate paths ${scenario.profile_id}/${scenario.case_id}`,
    script: "stage2-int/tools/probe-path-planner.mjs",
    args: ["--input", truth.output, "--out", output, "--algorithm", "path-balance"],
  });
  await writeJson(manifestPath, {
    schema_version: "experiment12-statistical-candidate-manifest-v1",
    case_id: scenario.case_id,
    truth_links_sha256: truthHash,
    candidate_paths_sha256: await sha256File(path),
    planning_wall_time_ms: command.timing.wall_time_ms,
  });
  return { output, path, resumed: false, timing: command.timing };
}

async function runFormalCase({ outputDir, scenario, resume }) {
  const resultDir = caseResultDir(outputDir, scenario);
  const resultPath = join(resultDir, "experiment12-results.json");
  if (resume && existsSync(resultPath)) {
    const result = await readJson(resultPath);
    if (result.status === "complete" && result.parameters?.neutral_pass1_planner === "efficient-fresh") return result;
  }
  const baseline = await ensureBaselineTruth({ outputDir, scenario, resume });
  const truth = await ensureCausalTruth({ outputDir, scenario, baseline, resume });
  await ensureCandidatePaths({ outputDir, scenario, truth, resume });
  await mkdir(resultDir, { recursive: true });
  await runCommandTimed({
    label: `Experiment 12 paired run ${scenario.profile_id}/${scenario.case_id}`,
    script: "scripts/runExperiment12TopologyVersionedCausal.mjs",
    args: [
      "--profiles", scenario.profile_id,
      "--variants", TOPOLOGY_REUSE_EVIDENCE_VARIANTS.join(","),
      "--source-root", join(scenarioDir(outputDir, scenario), "source-root"),
      "--stress-root", join(scenarioDir(outputDir, scenario), "stress-root"),
      "--stress-rates", String(scenario.stress_rate),
      "--slices", String(SLICE_COUNT),
      "--formal", "true",
      "--resume", String(resume),
      "--neutral-pass1-planner", "efficient-fresh",
      "--out", resultDir,
    ],
    env: {
      ...process.env,
      NODE_OPTIONS: [process.env.NODE_OPTIONS ?? "", "--max-old-space-size=2560"].filter(Boolean).join(" "),
    },
  });
  return readJson(resultPath);
}

function annotatedRows(result, scenario, preregistration, truthMetadata) {
  const controlled = truthMetadata?.experiment12_statistical_scenario ?? {};
  return (result.summary_rows ?? []).map((row) => ({
    ...row,
    case_id: scenario.case_id,
    window_id: scenario.window_id,
    epoch_iso: scenario.epoch_iso,
    seed: scenario.seed,
    achieved_stress_rate: round(controlled.achieved_stress_rate),
    achieved_mean_dynamicity: round(controlled.achieved_mean_dynamicity),
    preregistration_sha256: preregistration.design_sha256,
  }));
}

async function loadCompletedRows(outputDir, matrix, preregistration) {
  const rows = [];
  for (const scenario of matrix) {
    const resultPath = join(caseResultDir(outputDir, scenario), "experiment12-results.json");
    const metadataPath = join(causalTruthDir(outputDir, scenario), "metadata.json");
    if (!existsSync(resultPath) || !existsSync(metadataPath)) continue;
    const [result, metadata] = await Promise.all([readJson(resultPath), readJson(metadataPath)]);
    if (result.status !== "complete" || result.parameters?.neutral_pass1_planner !== "efficient-fresh") continue;
    rows.push(...annotatedRows(result, scenario, preregistration, metadata));
  }
  return rows;
}

function aggregateRowsWithDimensions(pairedRows) {
  return [
    ...aggregateTopologyReusePairedEffects(pairedRows).map((row) => ({ ...row, aggregation_dimension: "profile" })),
    ...aggregateTopologyReusePairedEffects(pairedRows, { triggeredOnly: true }).map((row) => ({ ...row, aggregation_dimension: "profile" })),
    ...aggregateTopologyReusePairedEffects(pairedRows, { groupFields: ["profile_id", "window_id"] })
      .map((row) => ({ ...row, aggregation_dimension: "window" })),
    ...aggregateTopologyReusePairedEffects(pairedRows, { groupFields: ["profile_id", "stress_rate"] })
      .map((row) => ({ ...row, aggregation_dimension: "stress" })),
    ...aggregateTopologyReusePairedEffects(pairedRows, { groupFields: ["profile_id", "seed"] })
      .map((row) => ({ ...row, aggregation_dimension: "seed" })),
  ];
}

function formatPercent(value) {
  return `${round(value, 3).toFixed(3)}%`;
}

function evidenceLabel(status) {
  if (status === "supported") return "统计支持";
  if (status === "conditional") return "条件性支持";
  return "尚不支持";
}

function primaryEffectRows(aggregateRows) {
  return aggregateRows.filter((row) =>
    row.aggregation_dimension === "profile" &&
    row.scope === "all-preregistered-cases" &&
    ["marginal_evaluation_reduction_percent", "score_cache_recomputation_reduction_percent", "planning_wall_time_reduction_percent"].includes(row.metric)
  );
}

function buildMarkdown({ preregistration, matrix, rawRows, pairedRows, aggregateRows, evidenceRows, scanRows }) {
  const complete = rawRows.length === matrix.length * TOPOLOGY_REUSE_EVIDENCE_VARIANTS.length;
  const primaryRows = primaryEffectRows(aggregateRows);
  return `# 实验 12：拓扑复用跨窗口、跨压力、多种子统计证据\n\n` +
    `## 证据状态\n\n` +
    `当前完成 ${rawRows.length / 2}/${matrix.length} 个预注册配对场景，状态为 **${complete ? "完整" : "进行中"}**。设计指纹：\`${preregistration.design_sha256}\`。未完成矩阵不得写成最终普遍结论。\n\n` +
    `| 星座 | 结论 | 触发场景 | 支持场景 | 非劣通过率 | 覆盖窗口 | 覆盖压力 | 覆盖 seed |\n|---|---|---:|---:|---:|---|---|---|\n` +
    `${evidenceRows.map((row) => `| ${profileLabel(row.profile_id)} | ${evidenceLabel(row.evidence_status)} | ${row.mechanism_triggered_cases}/${row.preregistered_cases} | ${row.mechanism_supporting_cases} | ${formatPercent(row.noninferiority_pass_rate * 100)} | ${row.trigger_windows || "无"} | ${row.trigger_stress_rates || "无"} | ${row.trigger_seeds || "无"} |`).join("\n")}\n\n` +
    `## 主效应\n\n` +
    `正值表示完整算法相对 fresh-only 减少开销。墙钟时间受系统调度影响，只作为次指标。\n\n` +
    `| 星座 | 指标 | n | 均值 | 95% CI | 正/负/平 | 符号检验 p |\n|---|---|---:|---:|---:|---:|---:|\n` +
    `${primaryRows.map((row) => `| ${profileLabel(row.profile_id)} | ${row.metric} | ${row.sample_count} | ${formatPercent(row.mean)} | [${formatPercent(row.ci95_low)}, ${formatPercent(row.ci95_high)}] | ${row.sign_positive}/${row.sign_negative}/${row.sign_ties} | ${row.sign_test_p_value} |`).join("\n")}\n\n` +
    `## 结论边界\n\n` +
    `- 本实验只比较拓扑版本化完整算法与每片 fresh 重规划，保留现有单窗口结论，不把未触发机制的零差异解释为有效。\n` +
    `- 3×3 拉丁方用 9 个配对场景均衡覆盖 3 个窗口、3 个压力和 3 个 seed，估计主效应，但不等价于 27 个全因子组合。\n` +
    `- 拓扑扫描共有 ${scanRows.length} 条预注册场景摘要，只用于确认输入跨度，不用于删选结果。\n` +
    `- 只有当确定性工作量的配对 95% CI 为正、跨维度触发且全部非劣门禁通过时，才标记为“统计支持”。\n` +
    `- 即使墙钟时间没有显著下降，也只能声称规划工作量减少，不能声称实际延迟显著降低。\n`;
}

function ciPlot(rows) {
  const maximum = Math.max(1, ...rows.flatMap((row) => [Math.abs(row.ci95_low), Math.abs(row.ci95_high)]));
  const width = 760;
  const center = width / 2;
  const scale = (width / 2 - 70) / maximum;
  const height = Math.max(100, 54 + rows.length * 48);
  const marks = rows.map((row, index) => {
    const y = 42 + index * 48;
    const x1 = center + row.ci95_low * scale;
    const x2 = center + row.ci95_high * scale;
    const x = center + row.mean * scale;
    const label = `${profileLabel(row.profile_id)} / ${row.metric.replaceAll("_", " ")}`;
    return `<text x="8" y="${y + 4}" font-size="11">${escapeHtml(label)}</text><line x1="${x1}" x2="${x2}" y1="${y}" y2="${y}" stroke="#0f766e" stroke-width="3"/><circle cx="${x}" cy="${y}" r="5" fill="#0f766e"/><text x="${width - 58}" y="${y + 4}" font-size="11">${row.mean.toFixed(2)}%</text>`;
  }).join("");
  return `<svg viewBox="0 0 ${width} ${height}" role="img"><line x1="${center}" x2="${center}" y1="18" y2="${height - 18}" stroke="#94a3b8" stroke-dasharray="4 4"/>${marks}</svg>`;
}

function heatmap(pairedRows, profileId) {
  const rows = pairedRows.filter((row) => row.profile_id === profileId);
  if (!rows.length) return `<p>尚无正式结果。</p>`;
  return `<div class="matrix">${rows.map((row) => {
    const value = row.marginal_evaluation_reduction_percent;
    const tone = value > 0 ? "positive" : value < 0 ? "negative" : "neutral";
    return `<article class="cell ${tone}"><b>${escapeHtml(row.window_id)} / ${(row.stress_rate * 100).toFixed(0)}%</b><span>${escapeHtml(row.seed)}</span><strong>${value.toFixed(2)}%</strong><small>reuse ${row.reuse_slices} / repair ${row.repair_slices}<br>最大 MAE 退化 ${row.maximum_mae_regression_percent.toFixed(2)}%</small></article>`;
  }).join("")}</div>`;
}

function buildHtml({ preregistration, matrix, rawRows, pairedRows, aggregateRows, evidenceRows, scanRows }) {
  const complete = rawRows.length === matrix.length * TOPOLOGY_REUSE_EVIDENCE_VARIANTS.length;
  const primaryRows = primaryEffectRows(aggregateRows);
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>实验12 拓扑复用统计证据</title><style>
  :root{font-family:Inter,"Microsoft YaHei",sans-serif;color:#172033;background:#f3f5f7}body{margin:0}main{max-width:1280px;margin:auto;padding:26px}header,section{background:#fff;border:1px solid #d8e0e8;padding:20px;margin:14px 0;border-radius:6px}header{border-left:6px solid #0f766e}.status{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px}.card{border-left:4px solid #0f766e;background:#f8fafc;padding:14px}.matrix{display:grid;grid-template-columns:repeat(3,minmax(180px,1fr));gap:10px}.cell{display:grid;gap:6px;padding:12px;border:1px solid #cbd5e1}.cell.positive{background:#ecfdf5;border-color:#6ee7b7}.cell.negative{background:#fff1f2;border-color:#fda4af}.cell.neutral{background:#f8fafc}.cell strong{font-size:22px}.cell span,.cell small{color:#526273}table{width:100%;border-collapse:collapse;font-size:12px}th,td{padding:8px;border-bottom:1px solid #e2e8f0;text-align:right}th:first-child,td:first-child{text-align:left}.note{background:#fffbeb;border-color:#fcd34d}code{overflow-wrap:anywhere}@media(max-width:760px){main{padding:10px}.matrix{grid-template-columns:1fr}}
  </style></head><body><main><header><h1>实验 12：拓扑复用统计证据</h1><p>跨时间窗口、跨动态压力、多 seed 的严格配对实验。当前矩阵：${complete ? "完整" : "进行中"}（${rawRows.length / 2}/${matrix.length}）。</p><code>${escapeHtml(preregistration.design_sha256)}</code></header>
  <section class="status"><div class="card"><b>预注册场景</b><strong>${matrix.length}</strong></div><div class="card"><b>已完成配对</b><strong>${rawRows.length / 2}</strong></div><div class="card"><b>拓扑扫描场景</b><strong>${scanRows.length}</strong></div></section>
  <section><h2>结论状态</h2><table><thead><tr><th>星座</th><th>结论</th><th>触发</th><th>支持</th><th>非劣通过率</th><th>窗口/压力/seed 跨度</th></tr></thead><tbody>${evidenceRows.map((row) => `<tr><td>${escapeHtml(profileLabel(row.profile_id))}</td><td>${evidenceLabel(row.evidence_status)}</td><td>${row.mechanism_triggered_cases}/${row.preregistered_cases}</td><td>${row.mechanism_supporting_cases}</td><td>${formatPercent(row.noninferiority_pass_rate * 100)}</td><td>${escapeHtml(row.trigger_windows || "无")} / ${escapeHtml(row.trigger_stress_rates || "无")} / ${escapeHtml(row.trigger_seeds || "无")}</td></tr>`).join("")}</tbody></table></section>
  <section><h2>配对效应与 95% 置信区间</h2><p>横轴右侧代表完整算法减少规划工作；墙钟时间仅作次指标。</p>${ciPlot(primaryRows)}</section>
  ${TOPOLOGY_REUSE_EVIDENCE_PROFILES.map((profileId) => `<section><h2>${escapeHtml(profileLabel(profileId))} 场景矩阵</h2>${heatmap(pairedRows, profileId)}</section>`).join("")}
  <section class="note"><h2>论文口径</h2><p>未完成矩阵、未跨维度触发或置信区间跨过 0 时，只保留条件性结论。精确 reuse 与局部 repair 分开统计；局部 repair 的收益不能写成精确拓扑重复。墙钟时间若无显著改善，只声称确定性规划工作量减少。</p></section>
  </main></body></html>`;
}

async function writeEvidenceArtifacts({ outputDir, preregistration, matrix }) {
  const rawRows = await loadCompletedRows(outputDir, matrix, preregistration);
  const pairedRows = buildTopologyReusePairedRows(rawRows);
  const aggregateRows = aggregateRowsWithDimensions(pairedRows);
  const evidenceRows = evaluateTopologyReuseEvidence(pairedRows, aggregateRows);
  const scanPath = join(outputDir, "topology-scan-summary.csv");
  const scanRows = existsSync(scanPath) ? await readCsv(scanPath) : [];
  const result = {
    schema_version: "experiment12-topology-reuse-statistical-evidence-v1",
    generated_at: new Date().toISOString(),
    preregistration_sha256: preregistration.design_sha256,
    expected_paired_cases: matrix.length,
    completed_paired_cases: pairedRows.length,
    complete: pairedRows.length === matrix.length,
    raw_rows: rawRows,
    paired_rows: pairedRows,
    aggregate_rows: aggregateRows,
    evidence_rows: evidenceRows,
  };
  await Promise.all([
    writeJson(join(outputDir, "experiment12-statistical-evidence.json"), result),
    writeFile(join(outputDir, "experiment12-statistical-raw.csv"), rowsToCsv(rawRows), "utf8"),
    writeFile(join(outputDir, "experiment12-statistical-paired-effects.csv"), rowsToCsv(pairedRows), "utf8"),
    writeFile(join(outputDir, "experiment12-statistical-confidence-intervals.csv"), rowsToCsv(aggregateRows), "utf8"),
    writeFile(join(outputDir, "experiment12-statistical-evidence-status.csv"), rowsToCsv(evidenceRows), "utf8"),
    writeFile(join(outputDir, "EXPERIMENT_12_STATISTICAL_REPORT.md"), buildMarkdown({ preregistration, matrix, rawRows, pairedRows, aggregateRows, evidenceRows, scanRows }), "utf8"),
    writeFile(join(outputDir, "index.html"), buildHtml({ preregistration, matrix, rawRows, pairedRows, aggregateRows, evidenceRows, scanRows }), "utf8"),
  ]);
  return result;
}

export async function runTopologyReuseStatisticalEvidence({
  outputDir = DEFAULT_OUTPUT_DIR,
  phase = "scan",
  profileIds = TOPOLOGY_REUSE_EVIDENCE_PROFILES,
  caseIds = [],
  caseLimit = 0,
  resume = true,
  resetPreregistration = false,
  concurrency = 1,
  workerStaggerMs = 30_000,
  minimumFreeMemoryGb = 3,
} = {}) {
  if (!["scan", "formal", "report"].includes(phase)) throw new Error(`Unknown phase ${phase}`);
  const preregistration = await ensurePreregistration(outputDir, { reset: resetPreregistration });
  const fullMatrix = buildTopologyReuseEvidenceMatrix();
  let selected = fullMatrix.filter((row) => profileIds.includes(row.profile_id));
  if (caseIds.length) selected = selected.filter((row) => caseIds.includes(row.case_id));
  if (caseLimit > 0) selected = selected.slice(0, caseLimit);
  if (phase === "scan") {
    await runTopologyScan({ outputDir, scenarios: selected, resume });
  } else if (phase === "formal") {
    if (!existsSync(join(outputDir, "topology-scan-summary.csv"))) {
      await runTopologyScan({ outputDir, scenarios: selected, resume });
    }
    const workerCount = Math.max(1, Math.min(Math.floor(numberValue(concurrency, 1)), selected.length || 1));
    let cursor = 0;
    let completed = 0;
    let artifactWriteQueue = Promise.resolve();
    const queueArtifactWrite = () => {
      artifactWriteQueue = artifactWriteQueue.then(() =>
        writeEvidenceArtifacts({ outputDir, preregistration, matrix: fullMatrix })
      );
      return artifactWriteQueue;
    };
    const workers = Array.from({ length: workerCount }, (_, workerIndex) => (async () => {
      if (workerIndex > 0 && workerStaggerMs > 0) await delay(workerIndex * workerStaggerMs);
      while (true) {
        const scenarioIndex = cursor;
        cursor += 1;
        if (scenarioIndex >= selected.length) return;
        const scenario = selected[scenarioIndex];
        await waitForFreeMemory(minimumFreeMemoryGb);
        console.log(`[Experiment 12 statistical formal] worker ${workerIndex + 1}/${workerCount}; case ${scenarioIndex + 1}/${selected.length}; ${scenario.profile_id} ${scenario.case_id}`);
        await runFormalCase({ outputDir, scenario, resume });
        completed += 1;
        await queueArtifactWrite();
        console.log(`[Experiment 12 statistical formal] completed ${completed}/${selected.length}; free_memory_gib=${round(freemem() / GIB, 2)}`);
        global.gc?.();
      }
    })());
    const workerResults = await Promise.allSettled(workers);
    await artifactWriteQueue;
    const failures = workerResults.filter((result) => result.status === "rejected");
    if (failures.length > 0) {
      throw new Error(`Experiment 12 concurrent workers failed: ${failures.map((result) => result.reason?.message ?? result.reason).join("\n---\n")}`);
    }
  }
  const result = await writeEvidenceArtifacts({ outputDir, preregistration, matrix: fullMatrix });
  console.log(JSON.stringify({
    ok: true,
    phase,
    output_dir: outputDir,
    selected_cases: selected.length,
    completed_paired_cases: result.completed_paired_cases,
    expected_paired_cases: result.expected_paired_cases,
    complete: result.complete,
    concurrency: phase === "formal" ? Math.max(1, Math.floor(numberValue(concurrency, 1))) : 0,
    report: relative(process.cwd(), join(outputDir, "EXPERIMENT_12_STATISTICAL_REPORT.md")),
  }, null, 2));
  return result;
}

const invokedDirectly = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  const args = process.argv.slice(2);
  const profileIds = argValue(args, "--profiles", TOPOLOGY_REUSE_EVIDENCE_PROFILES.join(","))
    .split(",").map((value) => value.trim()).filter(Boolean);
  const caseIds = argValue(args, "--case-ids", "").split(",").map((value) => value.trim()).filter(Boolean);
  await runTopologyReuseStatisticalEvidence({
    outputDir: resolve(argValue(args, "--out", DEFAULT_OUTPUT_DIR)),
    phase: argValue(args, "--phase", "scan"),
    profileIds,
    caseIds,
    caseLimit: Math.max(0, Math.floor(numberValue(argValue(args, "--case-limit", "0")))),
    resume: boolValue(argValue(args, "--resume", "true"), true),
    resetPreregistration: boolValue(argValue(args, "--reset-preregistration", "false"), false),
    concurrency: Math.max(1, Math.floor(numberValue(argValue(args, "--concurrency", "1"), 1))),
    workerStaggerMs: Math.max(0, Math.floor(numberValue(argValue(args, "--worker-stagger-ms", "30000"), 30_000))),
    minimumFreeMemoryGb: Math.max(0, numberValue(argValue(args, "--minimum-free-memory-gb", "3"), 3)),
  });
}
