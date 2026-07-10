import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
import { buildExperiment4Variants } from "./runExperiment4Ablation.mjs";

export const SAMPLING_RATES = Object.freeze([0.05, 0.10, 0.15, 0.20, 0.25, 0.30, 0.40]);

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
  const raw = argValue(args, name, "");
  if (raw === "") return fallback;
  return numberValue(raw, fallback);
}

function listArg(args, name, fallback) {
  const raw = argValue(args, name, "");
  return raw ? raw.split(",").map((value) => value.trim()).filter(Boolean) : fallback;
}

export function buildExperiment6Matrix({
  profileIds = PROFILE_CATALOG.map((row) => row.id),
  rates = SAMPLING_RATES,
} = {}) {
  return profileIds.flatMap((profileId) => rates.flatMap((rate) => [
    { profile_id: profileId, rate, method_id: "before" },
    { profile_id: profileId, rate, method_id: "full" },
  ]));
}

export function markPareto(rows = []) {
  return rows.map((row, index) => ({
    ...row,
    pareto: !rows.some((candidate, candidateIndex) =>
      candidateIndex !== index &&
      numberValue(candidate.cost) <= numberValue(row.cost) &&
      numberValue(candidate.error) <= numberValue(row.error) &&
      (numberValue(candidate.cost) < numberValue(row.cost) || numberValue(candidate.error) < numberValue(row.error))
    ),
  }));
}

function mean(values) {
  const finite = values.filter(Number.isFinite);
  return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : 0;
}

function std(values) {
  const finite = values.filter(Number.isFinite);
  if (finite.length < 2) return 0;
  const average = mean(finite);
  return Math.sqrt(mean(finite.map((value) => (value - average) ** 2)));
}

function quantile(values, q) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function methodLabel(methodId) {
  return methodId === "before" ? "增强前 INT-MC" : "完整增强 LEO-INT-MC";
}

function aggregateRow(profile, rate, methodId, run, sliceRows, pass1Fingerprint) {
  const metrics = run.metrics;
  const values = (field) => sliceRows.map((row) => numberValue(row[field], NaN));
  return {
    constellation_profile_id: profile.id,
    constellation_label: profile.short_label,
    scale: profile.scale,
    node_count: profile.node_count,
    sampling_rate: rate,
    method_id: methodId,
    method_label: methodLabel(methodId),
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
    cpu_mae: metrics.cpu_mae,
    queue_depth_mae: metrics.queue_depth_mae,
    energy_percent_mae: metrics.energy_percent_mae,
    link_utilization_mae: metrics.link_utilization_mae,
    utilization_inferred_mae: metrics.utilization_inferred_mae,
    node_mode_accuracy: metrics.node_mode_accuracy,
    link_status_accuracy: metrics.link_status_accuracy,
    telemetry_bytes_slice_std: round(std(values("telemetry_bytes"))),
    telemetry_bytes_slice_p5: round(quantile(values("telemetry_bytes"), 0.05)),
    telemetry_bytes_slice_p50: round(quantile(values("telemetry_bytes"), 0.5)),
    telemetry_bytes_slice_p95: round(quantile(values("telemetry_bytes"), 0.95)),
    direct_coverage_slice_std: round(std(values("active_link_sampling_coverage"))),
    direct_coverage_slice_p5: round(quantile(values("active_link_sampling_coverage"), 0.05)),
    direct_coverage_slice_p95: round(quantile(values("active_link_sampling_coverage"), 0.95)),
    cpu_mae_slice_std: round(std(values("cpu_mae"))),
    queue_mae_slice_std: round(std(values("queue_depth_mae"))),
    energy_mae_slice_std: round(std(values("energy_percent_mae"))),
    link_utilization_mae_slice_std: round(std(values("link_utilization_mae"))),
    pass1_fingerprint: pass1Fingerprint,
  };
}

function minMaxNormalize(value, values) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  return max - min < 1e-12 ? 0 : (value - min) / (max - min);
}

function addParetoFields(rows) {
  const result = [];
  const groups = new Map();
  rows.forEach((row) => {
    const key = `${row.constellation_profile_id}|${row.method_id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  });
  groups.forEach((group) => {
    const costs = group.map((row) => numberValue(row.telemetry_bytes_per_node_slice));
    const metricFields = ["cpu_mae", "queue_depth_mae", "energy_percent_mae", "link_utilization_mae"];
    const metricValues = Object.fromEntries(metricFields.map((field) => [field, group.map((row) => numberValue(row[field]))]));
    const scored = group.map((row) => {
      const normalizedCost = minMaxNormalize(numberValue(row.telemetry_bytes_per_node_slice), costs);
      const normalizedError = mean(metricFields.map((field) => minMaxNormalize(numberValue(row[field]), metricValues[field])));
      return {
        ...row,
        normalized_cost: round(normalizedCost),
        normalized_error: round(normalizedError),
        ideal_point_distance: round(Math.hypot(normalizedCost, normalizedError)),
        cost: normalizedCost,
        error: normalizedError,
      };
    });
    const paretoRows = markPareto(scored);
    const paretoOnly = paretoRows.filter((row) => row.pareto);
    const knee = paretoOnly.slice().sort((left, right) => left.ideal_point_distance - right.ideal_point_distance)[0];
    paretoRows.forEach((row) => result.push({
      ...row,
      knee_point: row.sampling_rate === knee?.sampling_rate,
    }));
  });
  return result;
}

function formatNumber(value, digits = 4) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toFixed(digits) : "-";
}

function formatPercent(value) {
  return `${(numberValue(value) * 100).toFixed(2)}%`;
}

function lineChart(rows, field, title, percent = false) {
  const width = 980;
  const height = 360;
  const margin = { left: 65, right: 25, top: 42, bottom: 45 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const values = rows.map((row) => numberValue(row[field]));
  const max = Math.max(1e-9, ...values);
  const minRate = Math.min(...rows.map((row) => row.sampling_rate));
  const maxRate = Math.max(...rows.map((row) => row.sampling_rate));
  const x = (rate) => margin.left + (rate - minRate) / Math.max(maxRate - minRate, 1e-9) * plotWidth;
  const y = (value) => margin.top + plotHeight - value / max * plotHeight;
  const palette = ["#246b89", "#b4553d", "#2f846f", "#8565a1", "#9a7a2f", "#4e6573"];
  const groups = new Map();
  rows.forEach((row) => {
    const key = `${row.constellation_label} / ${row.method_label}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  });
  const lines = [...groups.entries()].map(([label, group], index) => {
    const sorted = group.slice().sort((a, b) => a.sampling_rate - b.sampling_rate);
    const points = sorted.map((row) => `${x(row.sampling_rate).toFixed(2)},${y(row[field]).toFixed(2)}`).join(" ");
    const dots = sorted.map((row) => `<circle cx="${x(row.sampling_rate).toFixed(2)}" cy="${y(row[field]).toFixed(2)}" r="3"><title>${escapeHtml(label)} ${row.sampling_rate}: ${percent ? formatPercent(row[field]) : formatNumber(row[field])}</title></circle>`).join("");
    return `<g fill="${palette[index % palette.length]}" stroke="${palette[index % palette.length]}"><polyline fill="none" stroke-width="2" points="${points}"/>${dots}<text x="${margin.left + (index % 3) * 290}" y="${18 + Math.floor(index / 3) * 16}" font-size="11" stroke="none">${escapeHtml(label)}</text></g>`;
  }).join("");
  const axes = `<line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${margin.top + plotHeight}" stroke="#52636d"/><line x1="${margin.left}" y1="${margin.top + plotHeight}" x2="${margin.left + plotWidth}" y2="${margin.top + plotHeight}" stroke="#52636d"/><text x="8" y="${margin.top + 8}" font-size="11">${percent ? formatPercent(max) : formatNumber(max)}</text><text x="8" y="${margin.top + plotHeight}" font-size="11">0</text><text x="${margin.left}" y="${height - 12}" font-size="11">${minRate}</text><text x="${margin.left + plotWidth - 20}" y="${height - 12}" font-size="11">${maxRate}</text>`;
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(title)}"><text x="${margin.left}" y="36" font-size="14" font-weight="700">${escapeHtml(title)}</text>${axes}${lines}</svg>`;
}

function paretoChart(rows) {
  const width = 980;
  const height = 380;
  const x = (value) => 70 + numberValue(value) * 850;
  const y = (value) => 320 - numberValue(value) * 260;
  const points = rows.map((row) => `<circle cx="${x(row.normalized_cost).toFixed(2)}" cy="${y(row.normalized_error).toFixed(2)}" r="${row.knee_point ? 7 : row.pareto ? 5 : 3}" fill="${row.knee_point ? "#b83c38" : row.pareto ? "#2d806d" : "#9aa6ac"}"><title>${escapeHtml(`${row.constellation_label}/${row.method_label} r=${row.sampling_rate} cost=${row.normalized_cost} error=${row.normalized_error}`)}</title></circle>`).join("");
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="采样率Pareto前沿"><line x1="70" y1="40" x2="70" y2="320" stroke="#52636d"/><line x1="70" y1="320" x2="930" y2="320" stroke="#52636d"/><text x="420" y="365" font-size="13">归一化遥测开销</text><text x="8" y="180" font-size="13" transform="rotate(-90 8 180)">归一化综合误差</text>${points}</svg>`;
}

function buildMarkdown(rows, htmlPath) {
  const knees = rows.filter((row) => row.knee_point).map((row) => `| ${row.constellation_label} | ${row.method_label} | ${row.sampling_rate} | ${formatNumber(row.telemetry_bytes_per_node_slice)} | ${formatNumber(row.cpu_mae)} | ${formatNumber(row.energy_percent_mae)} | ${formatNumber(row.link_utilization_mae)} |`).join("\n");
  return `# 实验 6：采样率敏感性实验\n\n## 实验做了什么\n\n本实验在 5%、10%、15%、20%、25%、30%、40% 七档采样率下，对增强前 INT-MC 和完整增强 LEO-INT-MC 进行三规模、48时间片扫描。每个采样率独立生成pass-1 OAM，禁止跨采样率复用反馈。详细曲线见 [实验6 HTML报告](${htmlPath.replaceAll("\\", "/")})。\n\n## 实验结果\n\n以下膝点是在各方法、各星座内部，将开销和CPU/队列/电量/链路利用率误差归一化后，到理想点距离最小的Pareto点：\n\n| 星座 | 方法 | 推荐折中采样率 | B/节点/片 | CPU MAE | 电量 MAE | 利用率 MAE |\n|---|---|---:|---:|---:|---:|---:|\n${knees}\n\n## 证明了什么\n\n实验展示算法优势是否只在25%单点成立，并给出降低采样率时误差、覆盖和逐片波动的变化。Pareto前沿说明哪些采样率在开销和误差上不被其他点同时支配。\n\n## 不能证明什么\n\n膝点是当前指标归一化下的描述性折中，不是所有业务和星座的唯一最优采样率；公开仿真结果不能替代真实运营网络在线调参。\n\n## 复现\n\n\`npm run experiment6:sampling\`\n`;
}

function buildHtml(rows, bySliceRows) {
  const kneeRows = rows.filter((row) => row.knee_point).map((row) => `<tr><td>${escapeHtml(row.constellation_label)}</td><td>${escapeHtml(row.method_label)}</td><td>${row.sampling_rate}</td><td>${formatNumber(row.telemetry_bytes_per_node_slice)}</td><td>${formatNumber(row.cpu_mae)}</td><td>${formatNumber(row.energy_percent_mae)}</td><td>${formatNumber(row.link_utilization_mae)}</td></tr>`).join("");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>实验6 采样率敏感性</title><style>body{font-family:Arial,"Microsoft YaHei",sans-serif;background:#f4f7f8;color:#17212b;margin:0}main{max-width:1180px;margin:auto;padding:28px}section{background:#fff;border:1px solid #d7e1e5;border-radius:6px;padding:18px;margin:16px 0}h1,h2{color:#153f57}svg{width:100%;height:auto}table{border-collapse:collapse;width:100%;font-size:12px}th,td{border:1px solid #d7e1e5;padding:7px;text-align:right}th:first-child,td:first-child,th:nth-child(2),td:nth-child(2){text-align:left}.note{color:#536773}</style></head><body><main><h1>实验 6：采样率敏感性实验</h1><p>七档采样率、三种规模、增强前后，共 ${rows.length} 个方法-参数组合和 ${bySliceRows.length} 条逐时间片记录。</p><section><h2>遥测开销曲线</h2>${lineChart(rows, "telemetry_bytes_per_node_slice", "采样率-字节/节点/时间片")}</section><section><h2>CPU MAE</h2>${lineChart(rows, "cpu_mae", "采样率-CPU MAE")}</section><section><h2>电量 MAE</h2>${lineChart(rows, "energy_percent_mae", "采样率-电量 MAE")}</section><section><h2>链路利用率 MAE</h2>${lineChart(rows, "link_utilization_mae", "采样率-链路利用率 MAE")}</section><section><h2>Pareto前沿</h2><p class="note">绿色为非支配点，红色为归一化理想点距离最小的描述性膝点。</p>${paretoChart(rows)}</section><section><h2>膝点</h2><table><thead><tr><th>星座</th><th>方法</th><th>采样率</th><th>B/节点/片</th><th>CPU MAE</th><th>电量 MAE</th><th>利用率 MAE</th></tr></thead><tbody>${kneeRows}</tbody></table></section><section><h2>结论边界</h2><p>膝点依赖当前指标归一化，不是固定部署阈值；报告同时保留全部七档原始结果。</p></section></main></body></html>`;
}

async function pruneEstimateGraphs(runManifest, outputDir) {
  const candidates = [
    join(runManifest.pass1_ground_dir, "ground-oam-estimate-graph.json"),
    join(dirname(runManifest.after.artifacts.evaluation_json), "ground-oam-estimate-graph.json"),
  ];
  let deletedBytes = 0;
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const resolvedPath = resolve(path);
    if (!resolvedPath.startsWith(resolve(outputDir) + "\\")) throw new Error(`Refusing to prune outside Experiment 6 output: ${resolvedPath}`);
    const { size } = await import("node:fs/promises").then(({ stat }) => stat(resolvedPath));
    deletedBytes += size;
    await rm(resolvedPath, { force: true });
  }
  return deletedBytes;
}

export async function runExperiment6({
  profiles,
  rates = SAMPLING_RATES,
  outputDir = resolve("reports/experiment6-sampling-sensitivity"),
  rootReportPath = resolve("EXPERIMENT_6_SAMPLING_SENSITIVITY_REPORT.md"),
  parameters = {},
  resume = true,
  formal = true,
  pruneBulkArtifacts = true,
} = {}) {
  if (!profiles?.length) throw new Error("Experiment 6 requires at least one profile.");
  await Promise.all([mkdir(outputDir, { recursive: true }), mkdir(dirname(rootReportPath), { recursive: true })]);
  const fullVariant = buildExperiment4Variants().find((row) => row.id === "full");
  const rawSummaryRows = [];
  const bySliceRows = [];
  const runManifests = [];
  let prunedBytes = 0;

  for (const profile of profiles) {
    for (const rate of rates) {
      const rateId = `rate-${rate.toFixed(2).replace(".", "p")}`;
      const variant = { ...fullVariant, id: `full-${rateId}`, label: `${fullVariant.label} ${rate}` };
      const run = await runTwoPassVariant({
        profile,
        variant,
        truthDir: profile.truthDir,
        candidatePathsPath: profile.candidatePathsPath,
        outputDir: join(outputDir, "runs", profile.id, rateId),
        parameters: {
          samplingRate: rate,
          targetActiveLinkSamplingRate: rate,
          rank: FORMAL_DEFAULTS.rank,
          windowSize: FORMAL_DEFAULTS.window_size,
          warmupSlices: FORMAL_DEFAULTS.warmup_slices,
          iterations: FORMAL_DEFAULTS.iterations,
          downlinkBudgetBytes: 1_000_000_000,
          maxPathsPerSlice: FORMAL_DEFAULTS.max_paths_per_slice,
          observabilityMode: FORMAL_DEFAULTS.observability_mode,
          feedbackLagSlices: FORMAL_DEFAULTS.feedback_lag_slices,
          ...parameters,
        },
        resume,
      });
      for (const [methodId, methodRun] of [["before", run.before], ["full", run.after]]) {
        const slices = await collectIntMcMetricsBySlice({
          stage2Dir: dirname(methodRun.artifacts.probe_summary_csv),
          groundDir: dirname(methodRun.artifacts.evaluation_json),
        });
        rawSummaryRows.push(aggregateRow(profile, rate, methodId, methodRun, slices, run.manifest.pass1_fingerprint));
        slices.forEach((row) => bySliceRows.push({
          constellation_profile_id: profile.id,
          constellation_label: profile.short_label,
          sampling_rate: rate,
          method_id: methodId,
          method_label: methodLabel(methodId),
          ...row,
        }));
      }
      runManifests.push({
        profile_id: profile.id,
        sampling_rate: rate,
        pass1_fingerprint: run.manifest.pass1_fingerprint,
        input_fingerprint: run.manifest.input_fingerprint,
        run_manifest: join(outputDir, "runs", profile.id, rateId, "run-manifest.json"),
        resumed: run.resumed,
      });
      if (pruneBulkArtifacts) prunedBytes += await pruneEstimateGraphs(run.manifest, outputDir);
    }
  }

  const summaryRows = addParetoFields(rawSummaryRows);
  const paretoRows = summaryRows.filter((row) => row.pareto);
  if (formal) {
    const expectedRows = profiles.length * rates.length * 2;
    if (profiles.length !== 3 || rates.length !== 7 || summaryRows.length !== expectedRows) throw new Error("Formal Experiment 6 requires 3 profiles, 7 rates, and 42 rows.");
    if (summaryRows.some((row) => row.slice_count !== 48)) throw new Error("Formal Experiment 6 requires 48 slices.");
    if (bySliceRows.length !== expectedRows * 48) throw new Error(`Expected ${expectedRows * 48} by-slice rows, received ${bySliceRows.length}.`);
  }
  const outputFiles = {
    summary_csv: join(outputDir, "experiment6-sampling-summary.csv"),
    by_slice_csv: join(outputDir, "experiment6-sampling-by-slice.csv"),
    pareto_csv: join(outputDir, "experiment6-pareto-front.csv"),
    summary_json: join(outputDir, "experiment6-sampling-summary.json"),
    report_html: join(outputDir, "experiment6-sampling-report.html"),
    manifest_json: join(outputDir, "experiment6-manifest.json"),
    root_report_md: rootReportPath,
  };
  const generatedAt = new Date().toISOString();
  const summary = { schema_version: "experiment6-sampling-sensitivity-v1", generated_at: generatedAt, formal, rates, rows: summaryRows, by_slice_row_count: bySliceRows.length, run_manifests: runManifests };
  const manifest = {
    schema_version: "experiment6-manifest-v1",
    generated_at: generatedAt,
    host: { platform: platform(), release: release(), cpu_model: cpus()[0]?.model ?? "unknown", logical_cpu_count: cpus().length, total_memory_bytes: totalmem(), free_memory_bytes_at_report: freemem(), node_version: process.version },
    pruned_bulk_artifact_bytes: prunedBytes,
    output_files: outputFiles,
    run_manifests: runManifests,
  };
  await Promise.all([
    writeFile(outputFiles.summary_csv, rowsToCsv(summaryRows), "utf8"),
    writeFile(outputFiles.by_slice_csv, rowsToCsv(bySliceRows), "utf8"),
    writeFile(outputFiles.pareto_csv, rowsToCsv(paretoRows), "utf8"),
    writeFile(outputFiles.summary_json, `${JSON.stringify(summary, null, 2)}\n`, "utf8"),
    writeFile(outputFiles.report_html, buildHtml(summaryRows, bySliceRows), "utf8"),
    writeFile(outputFiles.manifest_json, `${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
    writeFile(outputFiles.root_report_md, buildMarkdown(summaryRows, relative(dirname(rootReportPath), outputFiles.report_html)), "utf8"),
  ]);
  return { summaryRows, bySliceRows, paretoRows, runManifests, outputFiles, summary };
}

function resolveFormalProfiles(oldRoot, ids) {
  return ids.map((id) => {
    const profile = PROFILE_CATALOG.find((row) => row.id === id);
    if (!profile) throw new Error(`Unknown profile: ${id}`);
    return { ...profile, truthDir: join(oldRoot, id, "stage1-truth"), candidatePathsPath: join(oldRoot, id, "experiment2", "stage2", "full-probe-int", "probe-paths-path-balance.csv") };
  });
}

async function main() {
  const args = process.argv.slice(2);
  const oldRoot = resolve(argValue(args, "--old-root", "reports/experiment2-native-baseline-rerun-final"));
  const outputDir = resolve(argValue(args, "--out", "reports/experiment6-sampling-sensitivity"));
  const rootReportPath = resolve(argValue(args, "--root-report", "EXPERIMENT_6_SAMPLING_SENSITIVITY_REPORT.md"));
  const profileIds = listArg(args, "--profiles", PROFILE_CATALOG.map((row) => row.id));
  const rates = listArg(args, "--rates", SAMPLING_RATES.map(String)).map(Number).filter((value) => Number.isFinite(value) && value > 0 && value <= 1);
  const result = await runExperiment6({
    profiles: resolveFormalProfiles(oldRoot, profileIds),
    rates,
    outputDir,
    rootReportPath,
    parameters: {
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
    pruneBulkArtifacts: argValue(args, "--prune-bulk-artifacts", "true").toLowerCase() !== "false",
  });
  console.log(JSON.stringify({ ok: true, output_dir: outputDir, summary_rows: result.summaryRows.length, by_slice_rows: result.bySliceRows.length, pareto_rows: result.paretoRows.length, root_report: rootReportPath }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
