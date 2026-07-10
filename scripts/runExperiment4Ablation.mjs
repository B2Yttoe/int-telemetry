import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { cpus, freemem, platform, release, totalmem } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  FORMAL_DEFAULTS,
  PROFILE_CATALOG,
  collectIntMcMetricsBySlice,
  runTwoPassVariant,
} from "./experiments/intMcExperimentCore.mjs";
import { escapeHtml, rowsToCsv } from "./experiments/reportUtils.mjs";

const FULL_MECHANISMS = Object.freeze({
  adaptiveReuse: true,
  incrementalTopologyRepair: true,
  forecastRiskScoring: true,
  adaptiveProbeBudget: true,
  metricTensorCoupling: true,
  nodeStateCoupling: true,
  nodeEnergyPhysicsPrior: true,
  jointStateCoupling: true,
  orbitGraphRegularization: true,
  orbitPeriodicPrior: true,
  orbitPeriodicPriorSlices: 19,
  oamQualityFeedback: true,
  businessHotspotMigrationPrior: false,
  stateTensorJointCompletion: true,
  multiObjectiveBudget: true,
  oamTargetAwareMetadata: true,
});

function variant(id, label, description, disabledFlags = []) {
  const mechanisms = { ...FULL_MECHANISMS };
  let useOamFeedback = true;
  disabledFlags.forEach((flag) => {
    if (flag === "useOamFeedback") useOamFeedback = false;
    else mechanisms[flag] = false;
  });
  return Object.freeze({
    id,
    label,
    description,
    useOamFeedback,
    mechanisms: Object.freeze(mechanisms),
  });
}

export function buildExperiment4Variants() {
  return [
    variant(
      "full",
      "完整增强 LEO-INT-MC",
      "启用动态拓扑适配、OAM闭环、自适应开销、轨道先验和多状态耦合。",
    ),
    variant(
      "no-topology-adaptation",
      "移除拓扑适配",
      "关闭拓扑类probe plan复用与OAM局部增量候选，保留星历活动链路掩码。",
      ["adaptiveReuse", "incrementalTopologyRepair"],
    ),
    variant(
      "no-oam-feedback",
      "移除 OAM 闭环",
      "不把Ground OAM反馈、控制动作和OAM质量反馈用于下一时间片。",
      ["useOamFeedback", "oamQualityFeedback"],
    ),
    variant(
      "no-adaptive-overhead",
      "移除自适应开销控制",
      "关闭自适应probe预算、多目标预算和目标感知metadata。",
      ["adaptiveProbeBudget", "multiObjectiveBudget", "oamTargetAwareMetadata"],
    ),
    variant(
      "no-orbit-priors",
      "移除轨道时空先验",
      "关闭未来接触风险评分、轨道图正则和轨道周期先验。",
      ["forecastRiskScoring", "orbitGraphRegularization", "orbitPeriodicPrior"],
    ),
    variant(
      "no-state-coupling",
      "移除状态耦合",
      "关闭链路指标、节点状态、联合张量和电量物理先验。",
      [
        "metricTensorCoupling",
        "nodeStateCoupling",
        "nodeEnergyPhysicsPrior",
        "jointStateCoupling",
        "stateTensorJointCompletion",
      ],
    ),
  ];
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

function argValue(args, name, fallback = "") {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1] ?? fallback;
}

function numberArg(args, name, fallback) {
  return numberValue(argValue(args, name, ""), fallback);
}

function listArg(args, name, fallback) {
  const raw = argValue(args, name, "");
  return raw ? raw.split(",").map((value) => value.trim()).filter(Boolean) : fallback;
}

function relativeDelta(value, baseline) {
  return round((numberValue(value) - numberValue(baseline)) / Math.max(Math.abs(numberValue(baseline)), 1e-9));
}

const ERROR_FIELDS = [
  "cpu_mae",
  "queue_depth_mae",
  "energy_percent_mae",
  "link_utilization_mae",
  "utilization_inferred_mae",
];
const ACCURACY_FIELDS = ["node_mode_accuracy", "link_status_accuracy"];
const COST_FIELDS = ["telemetry_bytes_per_node_slice", "total_telemetry_energy_j"];

function summaryRow(profile, variantRow, run) {
  const metrics = run.after.metrics;
  return {
    constellation_profile_id: profile.id,
    constellation_label: profile.short_label,
    scale: profile.scale,
    node_count: profile.node_count,
    variant_id: variantRow.id,
    variant_label: variantRow.label,
    slice_count: metrics.slice_count,
    feedback_lag_slices: metrics.feedback_lag_slices,
    causal_feedback_violations: metrics.causal_feedback_violations,
    active_link_direct_coverage: metrics.active_link_direct_coverage,
    active_link_effective_coverage: metrics.active_link_effective_coverage,
    telemetry_bytes_per_node_slice: metrics.telemetry_bytes_per_node_slice,
    total_telemetry_generated_bytes: metrics.total_telemetry_generated_bytes,
    total_telemetry_energy_j: metrics.total_telemetry_energy_j,
    selected_paths: metrics.selected_paths,
    hop_records: metrics.hop_records,
    reused_slice_plans: metrics.reused_slice_plans,
    fresh_slice_plans: metrics.fresh_slice_plans,
    planning_local_repair_slices: metrics.planning_local_repair_slices,
    cpu_mae: metrics.cpu_mae,
    cpu_rmse: metrics.cpu_rmse,
    cpu_p95_ae: metrics.cpu_p95_ae,
    queue_depth_mae: metrics.queue_depth_mae,
    queue_depth_rmse: metrics.queue_depth_rmse,
    queue_depth_p95_ae: metrics.queue_depth_p95_ae,
    energy_percent_mae: metrics.energy_percent_mae,
    energy_percent_rmse: metrics.energy_percent_rmse,
    energy_percent_p95_ae: metrics.energy_percent_p95_ae,
    node_mode_accuracy: metrics.node_mode_accuracy,
    link_status_accuracy: metrics.link_status_accuracy,
    link_utilization_mae: metrics.link_utilization_mae,
    link_utilization_rmse: metrics.link_utilization_rmse,
    link_utilization_p95_ae: metrics.link_utilization_p95_ae,
    utilization_inferred_mae: metrics.utilization_inferred_mae,
    pass1_fingerprint: run.manifest.pass1_fingerprint,
    input_fingerprint: run.manifest.input_fingerprint,
    resumed: run.resumed,
  };
}

function addContributionDeltas(rows) {
  const fullByProfile = new Map(
    rows.filter((row) => row.variant_id === "full").map((row) => [row.constellation_profile_id, row]),
  );
  return rows.map((row) => {
    const full = fullByProfile.get(row.constellation_profile_id);
    const deltas = {};
    ERROR_FIELDS.forEach((field) => {
      deltas[`${field}_relative_increase_vs_full`] = full ? relativeDelta(row[field], full[field]) : 0;
    });
    ACCURACY_FIELDS.forEach((field) => {
      deltas[`${field}_loss_vs_full`] = full ? round(numberValue(full[field]) - numberValue(row[field])) : 0;
    });
    COST_FIELDS.forEach((field) => {
      deltas[`${field}_relative_change_vs_full`] = full ? relativeDelta(row[field], full[field]) : 0;
    });
    return { ...row, ...deltas };
  });
}

function formatNumber(value, digits = 4) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toFixed(digits) : "-";
}

function formatPercent(value, digits = 2) {
  return `${(numberValue(value) * 100).toFixed(digits)}%`;
}

function barChart(rows, field, title) {
  const width = 980;
  const rowHeight = 24;
  const height = Math.max(120, 48 + rows.length * rowHeight);
  const max = Math.max(1e-9, ...rows.map((row) => numberValue(row[field])));
  const bars = rows.map((row, index) => {
    const y = 34 + index * rowHeight;
    const barWidth = Math.max(1, numberValue(row[field]) / max * 520);
    const label = `${row.constellation_label} / ${row.variant_label}`;
    return `<text x="8" y="${y + 13}" font-size="11">${escapeHtml(label)}</text><rect x="340" y="${y}" width="${barWidth.toFixed(2)}" height="15" fill="#2d6a8a"/><text x="${(348 + barWidth).toFixed(2)}" y="${y + 13}" font-size="11">${escapeHtml(formatNumber(row[field]))}</text>`;
  }).join("");
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(title)}"><text x="8" y="18" font-size="14" font-weight="700">${escapeHtml(title)}</text>${bars}</svg>`;
}

function contributionHeatmap(rows) {
  const ablations = rows.filter((row) => row.variant_id !== "full");
  const fields = ["cpu_mae", "queue_depth_mae", "energy_percent_mae", "link_utilization_mae"];
  const cellWidth = 135;
  const cellHeight = 28;
  const width = 320 + fields.length * cellWidth;
  const height = 58 + ablations.length * cellHeight;
  const cells = ablations.map((row, rowIndex) => {
    const y = 50 + rowIndex * cellHeight;
    const label = `<text x="8" y="${y + 18}" font-size="11">${escapeHtml(`${row.constellation_label} / ${row.variant_label}`)}</text>`;
    const values = fields.map((field, columnIndex) => {
      const value = numberValue(row[`${field}_relative_increase_vs_full`]);
      const intensity = Math.min(1, Math.abs(value));
      const color = value >= 0
        ? `rgba(186,54,54,${(0.15 + intensity * 0.75).toFixed(2)})`
        : `rgba(31,122,85,${(0.15 + intensity * 0.75).toFixed(2)})`;
      const x = 300 + columnIndex * cellWidth;
      return `<rect x="${x}" y="${y}" width="${cellWidth - 2}" height="${cellHeight - 2}" fill="${color}"/><text x="${x + 8}" y="${y + 18}" font-size="11">${escapeHtml(formatPercent(value))}</text>`;
    }).join("");
    return label + values;
  }).join("");
  const headers = fields.map((field, index) => `<text x="${308 + index * cellWidth}" y="40" font-size="11" font-weight="700">${escapeHtml(field)}</text>`).join("");
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="机制贡献热力图">${headers}${cells}</svg>`;
}

function resultTableRows(rows) {
  return rows.map((row) => `<tr><td>${escapeHtml(row.constellation_label)}</td><td>${escapeHtml(row.variant_label)}</td><td>${formatNumber(row.telemetry_bytes_per_node_slice, 2)}</td><td>${formatNumber(row.cpu_mae)}</td><td>${formatNumber(row.queue_depth_mae)}</td><td>${formatNumber(row.energy_percent_mae)}</td><td>${formatNumber(row.link_utilization_mae)}</td><td>${formatPercent(row.node_mode_accuracy)}</td><td>${formatPercent(row.link_status_accuracy)}</td></tr>`).join("");
}

function buildMarkdown({ rows, parameters, htmlRelativePath }) {
  const table = rows.map((row) => `| ${row.constellation_label} | ${row.variant_label} | ${formatNumber(row.telemetry_bytes_per_node_slice, 2)} | ${formatNumber(row.cpu_mae)} | ${formatNumber(row.queue_depth_mae)} | ${formatNumber(row.energy_percent_mae)} | ${formatNumber(row.link_utilization_mae)} | ${formatPercent(row.node_mode_accuracy)} | ${formatPercent(row.link_status_accuracy)} |`).join("\n");
  return `# 实验 4：LEO-INT-MC 消融实验\n\n## 实验做了什么\n\n本实验在相同第一阶段真值、候选路径和 pass-1 OAM 观测上，每次只移除一类增强机制，用于识别动态拓扑适配、OAM闭环、自适应开销、轨道时空先验和多状态耦合的独立贡献。详细可视化见 [实验4 HTML报告](${htmlRelativePath.replaceAll("\\", "/")})。\n\n固定参数：采样率 ${parameters.samplingRate}，秩 ${parameters.rank}，窗口 ${parameters.windowSize}，预热 ${parameters.warmupSlices}，迭代 ${parameters.iterations}，OAM反馈延迟 ${parameters.feedbackLagSlices} 个时间片。\n\n## 实验结果\n\n| 星座 | 实验组 | B/节点/片 | CPU MAE | 队列 MAE | 电量 MAE | 链路利用率 MAE | 节点模式准确率 | 链路状态准确率 |\n|---|---|---:|---:|---:|---:|---:|---:|---:|\n${table}\n\n## 证明了什么\n\n消融组与完整组共享同一个 pass-1 指纹，因此差异来自被关闭的机制组，而不是不同初始采样。正的误差相对增量表示移除机制后重构变差，该机制提供了可测量贡献；负值则表示该机制在对应规模或指标上可能存在代价，报告不将其隐藏。\n\n## 不能证明什么\n\n本实验能证明各机制在当前三类仿真星座和业务输入上的因果消融效果，不能直接证明真实运营商硬件中的绝对性能，也不能把单个规模上的优势外推到所有LEO星座。墙钟时间只适用于本机软件实现。\n\n## 复现\n\n\`npm run experiment4:ablation\`\n`;
}

function buildHtml({ rows, bySliceRows, parameters }) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>实验4 LEO-INT-MC消融实验</title><style>body{font-family:Arial,"Microsoft YaHei",sans-serif;margin:0;background:#f4f7f8;color:#17212b}main{max-width:1180px;margin:auto;padding:28px}h1,h2{color:#153f57}section{background:white;border:1px solid #d8e1e5;margin:16px 0;padding:18px;border-radius:6px}table{border-collapse:collapse;width:100%;font-size:12px}th,td{border:1px solid #d8e1e5;padding:7px;text-align:right}th:first-child,td:first-child,th:nth-child(2),td:nth-child(2){text-align:left}svg{width:100%;height:auto;background:#fff}.note{color:#536773;font-size:13px}</style></head><body><main><h1>实验 4：LEO-INT-MC 消融实验</h1><p>逐项移除增强机制，检验其对节点状态、链路状态、遥测开销和规划复用的独立贡献。</p><section><h2>实验口径</h2><p>采样率 ${parameters.samplingRate}，rank=${parameters.rank}，window=${parameters.windowSize}，反馈延迟=${parameters.feedbackLagSlices}片。所有组使用相同第一阶段输入与共享pass-1。</p></section><section><h2>综合结果</h2><table><thead><tr><th>星座</th><th>实验组</th><th>B/节点/片</th><th>CPU MAE</th><th>队列 MAE</th><th>电量 MAE</th><th>利用率 MAE</th><th>节点模式</th><th>链路状态</th></tr></thead><tbody>${resultTableRows(rows)}</tbody></table></section><section><h2>开销</h2>${barChart(rows, "telemetry_bytes_per_node_slice", "遥测字节/节点/时间片")}</section><section><h2>CPU重构误差</h2>${barChart(rows, "cpu_mae", "CPU MAE")}</section><section><h2>机制贡献热力图</h2><p class="note">红色表示移除机制后误差上升，绿色表示移除后误差下降。数值为相对完整组变化。</p>${contributionHeatmap(rows)}</section><section><h2>逐时间片证据</h2><p>共 ${bySliceRows.length} 条方法-时间片记录，保存在 experiment4-ablation-by-slice.csv，可用于检查均值是否掩盖局部波动。</p></section><section><h2>结论边界</h2><p>该实验验证软件仿真环境内的机制贡献，不等价于真实星上硬件部署测试；不显著和负向结果均保留。</p></section></main></body></html>`;
}

export async function runExperiment4({
  profiles,
  variants = buildExperiment4Variants(),
  outputDir = resolve("reports/experiment4-leo-int-mc-ablation"),
  rootReportPath = resolve("EXPERIMENT_4_ABLATION_REPORT.md"),
  parameters = {},
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
  if (!profiles?.length) throw new Error("Experiment 4 requires at least one profile.");
  if (!variants.some((row) => row.id === "full")) throw new Error("Experiment 4 requires the full variant as shared baseline.");
  await Promise.all([mkdir(outputDir, { recursive: true }), mkdir(dirname(rootReportPath), { recursive: true })]);
  const rawRows = [];
  const bySliceRows = [];
  const runManifests = [];

  for (const profile of profiles) {
    if (!existsSync(join(profile.truthDir, "links.csv"))) throw new Error(`Missing truth links for ${profile.id}: ${profile.truthDir}`);
    if (!existsSync(profile.candidatePathsPath)) throw new Error(`Missing candidate paths for ${profile.id}: ${profile.candidatePathsPath}`);
    const profileDir = join(outputDir, "runs", profile.id);
    const fullVariant = variants.find((row) => row.id === "full");
    const fullRun = await runTwoPassVariant({
      profile,
      variant: fullVariant,
      truthDir: profile.truthDir,
      candidatePathsPath: profile.candidatePathsPath,
      outputDir: join(profileDir, fullVariant.id),
      parameters: normalizedParameters,
      resume,
    });
    const sharedPass1 = {
      run: fullRun.before,
      stage2Dir: fullRun.manifest.pass1_stage2_dir,
      groundDir: fullRun.manifest.pass1_ground_dir,
      fingerprint: fullRun.manifest.pass1_fingerprint,
    };
    const orderedRuns = [[fullVariant, fullRun]];
    for (const variantRow of variants.filter((row) => row.id !== "full")) {
      const run = await runTwoPassVariant({
        profile,
        variant: variantRow,
        truthDir: profile.truthDir,
        candidatePathsPath: profile.candidatePathsPath,
        outputDir: join(profileDir, variantRow.id),
        parameters: normalizedParameters,
        resume,
        sharedPass1,
      });
      orderedRuns.push([variantRow, run]);
    }
    for (const [variantRow, run] of orderedRuns) {
      rawRows.push(summaryRow(profile, variantRow, run));
      const sliceRows = await collectIntMcMetricsBySlice({
        stage2Dir: run.after.artifacts.probe_summary_csv ? dirname(run.after.artifacts.probe_summary_csv) : join(profileDir, variantRow.id, "stage2", variantRow.id),
        groundDir: dirname(run.after.artifacts.evaluation_json),
      });
      sliceRows.forEach((row) => bySliceRows.push({
        constellation_profile_id: profile.id,
        constellation_label: profile.short_label,
        variant_id: variantRow.id,
        variant_label: variantRow.label,
        ...row,
      }));
      runManifests.push({
        profile_id: profile.id,
        variant_id: variantRow.id,
        pass1_fingerprint: run.manifest.pass1_fingerprint,
        input_fingerprint: run.manifest.input_fingerprint,
        run_manifest: join(profileDir, variantRow.id, "run-manifest.json"),
        resumed: run.resumed,
      });
    }
  }

  const summaryRows = addContributionDeltas(rawRows);
  if (formal) {
    const allowedProfiles = new Set(PROFILE_CATALOG.map((row) => row.id));
    if (profiles.some((profile) => !allowedProfiles.has(profile.id))) throw new Error("Formal Experiment 4 contains an unsupported profile.");
    if (summaryRows.some((row) => row.slice_count !== FORMAL_DEFAULTS.slice_count)) throw new Error("Formal Experiment 4 requires exactly 48 slices per row.");
  }
  const outputFiles = {
    summary_csv: join(outputDir, "experiment4-ablation-summary.csv"),
    by_slice_csv: join(outputDir, "experiment4-ablation-by-slice.csv"),
    summary_json: join(outputDir, "experiment4-ablation-summary.json"),
    report_html: join(outputDir, "experiment4-ablation-report.html"),
    manifest_json: join(outputDir, "experiment4-manifest.json"),
    root_report_md: rootReportPath,
  };
  const summary = {
    schema_version: "experiment4-leo-int-mc-ablation-v1",
    generated_at: new Date().toISOString(),
    formal,
    parameters: normalizedParameters,
    profiles: profiles.map((profile) => ({ id: profile.id, label: profile.short_label, node_count: profile.node_count })),
    variants: variants.map((row) => ({ id: row.id, label: row.label, description: row.description, use_oam_feedback: row.useOamFeedback, mechanisms: row.mechanisms })),
    rows: summaryRows,
    by_slice_row_count: bySliceRows.length,
    run_manifests: runManifests,
  };
  const manifest = {
    schema_version: "experiment4-manifest-v1",
    generated_at: summary.generated_at,
    host: {
      platform: platform(),
      release: release(),
      cpu_model: cpus()[0]?.model ?? "unknown",
      logical_cpu_count: cpus().length,
      total_memory_bytes: totalmem(),
      free_memory_bytes_at_report: freemem(),
      node_version: process.version,
    },
    output_files: outputFiles,
    run_manifests: runManifests,
  };
  const html = buildHtml({ rows: summaryRows, bySliceRows, parameters: normalizedParameters });
  const markdown = buildMarkdown({
    rows: summaryRows,
    parameters: normalizedParameters,
    htmlRelativePath: relative(dirname(rootReportPath), outputFiles.report_html),
  });
  await Promise.all([
    writeFile(outputFiles.summary_csv, rowsToCsv(summaryRows), "utf8"),
    writeFile(outputFiles.by_slice_csv, rowsToCsv(bySliceRows), "utf8"),
    writeFile(outputFiles.summary_json, `${JSON.stringify(summary, null, 2)}\n`, "utf8"),
    writeFile(outputFiles.report_html, html, "utf8"),
    writeFile(outputFiles.manifest_json, `${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
    writeFile(outputFiles.root_report_md, markdown, "utf8"),
  ]);
  return { summaryRows, bySliceRows, runManifests, outputFiles, summary };
}

function resolveFormalProfiles(oldRoot, ids) {
  return ids.map((id) => {
    const profile = PROFILE_CATALOG.find((row) => row.id === id);
    if (!profile) throw new Error(`Unknown formal profile: ${id}`);
    return {
      ...profile,
      truthDir: join(oldRoot, id, "stage1-truth"),
      candidatePathsPath: join(oldRoot, id, "experiment2", "stage2", "full-probe-int", "probe-paths-path-balance.csv"),
    };
  });
}

async function main() {
  const args = process.argv.slice(2);
  const oldRoot = resolve(argValue(args, "--old-root", "reports/experiment2-native-baseline-rerun-final"));
  const outputDir = resolve(argValue(args, "--out", "reports/experiment4-leo-int-mc-ablation"));
  const rootReportPath = resolve(argValue(args, "--root-report", "EXPERIMENT_4_ABLATION_REPORT.md"));
  const profileIds = listArg(args, "--profiles", PROFILE_CATALOG.map((row) => row.id));
  const variantIds = listArg(args, "--variants", buildExperiment4Variants().map((row) => row.id));
  const selectedVariants = variantIds.map((id) => {
    const row = buildExperiment4Variants().find((item) => item.id === id);
    if (!row) throw new Error(`Unknown Experiment 4 variant: ${id}`);
    return row;
  });
  const result = await runExperiment4({
    profiles: resolveFormalProfiles(oldRoot, profileIds),
    variants: selectedVariants,
    outputDir,
    rootReportPath,
    parameters: {
      samplingRate: numberArg(args, "--sampling-rate", FORMAL_DEFAULTS.sampling_rate),
      targetActiveLinkSamplingRate: numberArg(args, "--target-active-link-sampling-rate", FORMAL_DEFAULTS.target_active_link_sampling_rate),
      rank: Math.max(1, Math.floor(numberArg(args, "--rank", FORMAL_DEFAULTS.rank))),
      windowSize: Math.max(1, Math.floor(numberArg(args, "--window-size", FORMAL_DEFAULTS.window_size))),
      warmupSlices: Math.max(1, Math.floor(numberArg(args, "--warmup-slices", FORMAL_DEFAULTS.warmup_slices))),
      iterations: Math.max(1, Math.floor(numberArg(args, "--iterations", FORMAL_DEFAULTS.iterations))),
      downlinkBudgetBytes: Math.max(0, Math.floor(numberArg(args, "--downlink-budget-bytes", 1_000_000_000))),
      maxPathsPerSlice: Math.max(1, Math.floor(numberArg(args, "--max-paths-per-slice", FORMAL_DEFAULTS.max_paths_per_slice))),
      observabilityMode: "oam-only",
      feedbackLagSlices: Math.max(1, Math.floor(numberArg(args, "--feedback-lag-slices", 1))),
    },
    resume: argValue(args, "--resume", "true").toLowerCase() !== "false",
    formal: true,
  });
  console.log(JSON.stringify({
    ok: true,
    output_dir: outputDir,
    summary_rows: result.summaryRows.length,
    by_slice_rows: result.bySliceRows.length,
    root_report: rootReportPath,
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
