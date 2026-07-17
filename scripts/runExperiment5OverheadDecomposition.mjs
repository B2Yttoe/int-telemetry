import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { cpus, freemem, platform, release, totalmem } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PROFILE_CATALOG } from "./experiments/intMcExperimentCore.mjs";
import { escapeHtml, rowsToCsv } from "./experiments/reportUtils.mjs";

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

function listArg(args, name, fallback) {
  const raw = argValue(args, name, "");
  return raw ? raw.split(",").map((value) => value.trim()).filter(Boolean) : fallback;
}

export function decomposeOverhead({ metrics, effectiveReconstructedStateCount = 0 }) {
  const total = numberValue(metrics.total_telemetry_generated_bytes);
  const probeBase = numberValue(metrics.total_probe_packet_base_bytes);
  const metadata = numberValue(metrics.total_metadata_bytes);
  const reports = numberValue(metrics.total_report_bytes);
  const other = Math.max(0, total - probeBase - metadata - reports);
  const nodes = numberValue(metrics.nodes_per_slice);
  const slices = numberValue(metrics.slice_count);
  return {
    total_generated_bytes: total,
    probe_base_bytes: probeBase,
    metadata_bytes: metadata,
    report_bytes: reports,
    other_bytes: round(other),
    isl_carried_bytes: numberValue(metrics.total_isl_telemetry_link_bytes),
    bytes_per_node_slice: round(total / Math.max(nodes * slices, 1)),
    effective_reconstructed_state_count: numberValue(effectiveReconstructedStateCount),
    bytes_per_effective_state: round(total / Math.max(numberValue(effectiveReconstructedStateCount), 1)),
  };
}

async function effectiveStateCount(evaluationPath) {
  const evaluation = JSON.parse(await readFile(evaluationPath, "utf8"));
  const links = evaluation.reconstruction ?? {};
  const nodes = evaluation.node_reconstruction ?? {};
  return Math.round(
    numberValue(links.active_link_samples) * numberValue(links.active_link_completion_coverage) +
    numberValue(nodes.node_samples) * numberValue(nodes.node_completion_coverage)
  );
}

function methodLabel(methodId) {
  return methodId === "before" ? "增强前 INT-MC" : "完整增强 LEO-INT-MC";
}

async function summarizeMethod(profile, methodId, run) {
  const effectiveCount = await effectiveStateCount(run.artifacts.evaluation_json);
  const parts = decomposeOverhead({ metrics: run.metrics, effectiveReconstructedStateCount: effectiveCount });
  const totalWallTime = Object.values(run.timings ?? {}).reduce(
    (total, timing) => total + numberValue(timing.wall_time_ms),
    0,
  );
  const meanNormalizedError = (
    numberValue(run.metrics.cpu_mae) / 100 +
    numberValue(run.metrics.queue_depth_mae) / 100 +
    numberValue(run.metrics.energy_percent_mae) / 100 +
    numberValue(run.metrics.link_utilization_mae) / 100
  ) / 4;
  return {
    constellation_profile_id: profile.id,
    constellation_label: profile.short_label,
    scale: profile.scale,
    node_count: profile.node_count,
    method_id: methodId,
    method_label: methodLabel(methodId),
    slice_count: run.metrics.slice_count,
    ...parts,
    total_telemetry_energy_j: run.metrics.total_telemetry_energy_j,
    selected_paths: run.metrics.selected_paths,
    hop_records: run.metrics.hop_records,
    report_count: run.metrics.report_count,
    reused_slice_plans: run.metrics.reused_slice_plans,
    fresh_slice_plans: run.metrics.fresh_slice_plans,
    full_replanning_avoided: run.metrics.estimated_full_replanning_avoided,
    planning_avoidance_rate: round(numberValue(run.metrics.estimated_full_replanning_avoided) / Math.max(numberValue(run.metrics.slice_count), 1)),
    planning_local_repair_slices: run.metrics.planning_local_repair_slices,
    reuse_duplicate_suppressed_paths: run.metrics.reuse_duplicate_suppressed_paths,
    total_pipeline_wall_time_ms: round(totalWallTime, 3),
    cpu_mae: run.metrics.cpu_mae,
    queue_depth_mae: run.metrics.queue_depth_mae,
    energy_percent_mae: run.metrics.energy_percent_mae,
    link_utilization_mae: run.metrics.link_utilization_mae,
    node_mode_accuracy: run.metrics.node_mode_accuracy,
    link_status_accuracy: run.metrics.link_status_accuracy,
    error_cost_product: round(parts.bytes_per_node_slice * meanNormalizedError),
  };
}

function timingRowsFor(profile, methodId, run) {
  const total = Object.values(run.timings ?? {}).reduce((sum, timing) => sum + numberValue(timing.wall_time_ms), 0);
  return Object.entries(run.timings ?? {}).map(([stage, timing]) => ({
    constellation_profile_id: profile.id,
    constellation_label: profile.short_label,
    method_id: methodId,
    method_label: methodLabel(methodId),
    stage,
    wall_time_ms: numberValue(timing.wall_time_ms),
    wall_time_share: round(numberValue(timing.wall_time_ms) / Math.max(total, 1)),
    parent_user_cpu_ms: numberValue(timing.parent_user_cpu_ms),
    parent_system_cpu_ms: numberValue(timing.parent_system_cpu_ms),
    exit_code: numberValue(timing.exit_code),
  }));
}

function formatNumber(value, digits = 2) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toFixed(digits) : "-";
}

function formatPercent(value) {
  return `${(numberValue(value) * 100).toFixed(2)}%`;
}

function stackedByteChart(rows) {
  const width = 1000;
  const height = 70 + rows.length * 40;
  const max = Math.max(1, ...rows.map((row) => row.total_generated_bytes));
  const colors = { probe_base_bytes: "#346b87", metadata_bytes: "#2a8c76", report_bytes: "#d18b32", other_bytes: "#8b6aa8" };
  const fields = Object.keys(colors);
  const bars = rows.map((row, index) => {
    const y = 35 + index * 40;
    let x = 310;
    const segments = fields.map((field) => {
      const segmentWidth = row[field] / max * 620;
      const result = `<rect x="${x.toFixed(2)}" y="${y}" width="${Math.max(0.5, segmentWidth).toFixed(2)}" height="18" fill="${colors[field]}"/>`;
      x += segmentWidth;
      return result;
    }).join("");
    return `<text x="8" y="${y + 14}" font-size="12">${escapeHtml(`${row.constellation_label} / ${row.method_label}`)}</text>${segments}<text x="${Math.min(960, x + 6).toFixed(2)}" y="${y + 14}" font-size="11">${formatNumber(row.total_generated_bytes / 1e6)} MB</text>`;
  }).join("");
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="遥测字节分解">${bars}</svg>`;
}

function timingChart(rows) {
  const aggregates = new Map();
  rows.forEach((row) => {
    const key = `${row.constellation_profile_id}|${row.method_id}`;
    if (!aggregates.has(key)) aggregates.set(key, { label: `${row.constellation_label} / ${row.method_label}`, stages: [] });
    aggregates.get(key).stages.push(row);
  });
  const entries = [...aggregates.values()];
  const width = 1000;
  const height = 70 + entries.length * 40;
  const max = Math.max(1, ...entries.map((entry) => entry.stages.reduce((total, row) => total + row.wall_time_ms, 0)));
  const palette = ["#234f6d", "#2d7f79", "#6a8f3c", "#c08b32", "#b25c45", "#76568f"];
  const bars = entries.map((entry, index) => {
    const y = 35 + index * 40;
    let x = 310;
    const total = entry.stages.reduce((sum, row) => sum + row.wall_time_ms, 0);
    const segments = entry.stages.map((row, stageIndex) => {
      const segmentWidth = row.wall_time_ms / max * 620;
      const result = `<rect x="${x.toFixed(2)}" y="${y}" width="${Math.max(0.5, segmentWidth).toFixed(2)}" height="18" fill="${palette[stageIndex % palette.length]}"><title>${escapeHtml(row.stage)} ${formatNumber(row.wall_time_ms)} ms</title></rect>`;
      x += segmentWidth;
      return result;
    }).join("");
    return `<text x="8" y="${y + 14}" font-size="12">${escapeHtml(entry.label)}</text>${segments}<text x="${Math.min(960, x + 6).toFixed(2)}" y="${y + 14}" font-size="11">${formatNumber(total / 1000)} s</text>`;
  }).join("");
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="阶段耗时分解">${bars}</svg>`;
}

function tableRows(rows) {
  return rows.map((row) => `<tr><td>${escapeHtml(row.constellation_label)}</td><td>${escapeHtml(row.method_label)}</td><td>${formatNumber(row.bytes_per_node_slice)}</td><td>${formatNumber(row.bytes_per_effective_state)}</td><td>${formatNumber(row.isl_carried_bytes / 1e6)}</td><td>${formatNumber(row.total_telemetry_energy_j)}</td><td>${formatNumber(row.total_pipeline_wall_time_ms / 1000)}</td><td>${formatPercent(row.planning_avoidance_rate)}</td></tr>`).join("");
}

function buildMarkdown(rows, htmlPath) {
  const table = rows.map((row) => `| ${row.constellation_label} | ${row.method_label} | ${formatNumber(row.bytes_per_node_slice)} | ${formatNumber(row.bytes_per_effective_state)} | ${formatNumber(row.isl_carried_bytes / 1e6)} | ${formatNumber(row.total_telemetry_energy_j)} | ${formatNumber(row.total_pipeline_wall_time_ms / 1000)} | ${formatPercent(row.planning_avoidance_rate)} |`).join("\n");
  return `# 实验 5：遥测与计算开销分解实验\n\n## 实验做了什么\n\n本实验把增强前 INT-MC 与完整增强 LEO-INT-MC 的一次运行开销拆成网络生成开销、ISL累计承载开销、遥测能耗和六阶段本机计算时间。详细图表见 [实验5 HTML报告](${htmlPath.replaceAll("\\", "/")})。\n\n生成字节满足：\n\n\\[B_{total}=B_{probe}+B_{metadata}+B_{report}+B_{other}\\]\n\nISL累计承载字节按每跳累加，因此单独报告，不重复加入生成字节。\n\n## 实验结果\n\n| 星座 | 方法 | B/节点/片 | B/有效状态 | ISL承载MB | 遥测能耗J | 流水线时间s | 避免全量重规划率 |\n|---|---|---:|---:|---:|---:|---:|---:|\n${table}\n\n## 证明了什么\n\n该实验能够区分开销来自metadata、报告、路径长度还是地面计算，并量化拓扑复用避免全量重规划的比例。它避免仅用“遥测总字节”概括所有成本。\n\n## 不能证明什么\n\n墙钟时间只代表当前机器和Node.js实现上的相对计算开销，不等于真实卫星处理器执行时间；仿真遥测能耗也不是硬件功耗实测。\n\n## 产物索引\n\n- [HTML 可视化](reports/experiment5-overhead-decomposition/experiment5-overhead-report.html)\n- [汇总 CSV](reports/experiment5-overhead-decomposition/experiment5-overhead-summary.csv)\n- [汇总 JSON](reports/experiment5-overhead-decomposition/experiment5-overhead-summary.json)\n- [实验 manifest](reports/experiment5-overhead-decomposition/experiment5-manifest.json)\n\n## 复现\n\n\`npm run experiment5:overhead\`\n`;
}

function buildHtml(rows, timingRows) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>实验5 开销分解</title><style>body{font-family:Arial,"Microsoft YaHei",sans-serif;background:#f4f7f8;color:#17212b;margin:0}main{max-width:1180px;margin:auto;padding:28px}section{background:#fff;border:1px solid #d7e1e5;border-radius:6px;padding:18px;margin:16px 0}h1,h2{color:#153f57}table{border-collapse:collapse;width:100%;font-size:12px}th,td{border:1px solid #d7e1e5;padding:7px;text-align:right}th:first-child,td:first-child,th:nth-child(2),td:nth-child(2){text-align:left}svg{width:100%;height:auto}.note{color:#536773}</style></head><body><main><h1>实验 5：遥测与计算开销分解实验</h1><section><h2>网络开销分解</h2><p class="note">蓝：probe基础；绿：INT metadata；黄：报告；紫：其他生成字节。ISL累计承载字节另表展示。</p>${stackedByteChart(rows)}</section><section><h2>计算阶段耗时</h2><p class="note">接触预测、路径选择、回传规划、probe执行、Ground OAM、矩阵补全的本机墙钟时间。</p>${timingChart(timingRows)}</section><section><h2>综合表</h2><table><thead><tr><th>星座</th><th>方法</th><th>B/节点/片</th><th>B/有效状态</th><th>ISL承载MB</th><th>能耗J</th><th>时间s</th><th>避免重规划</th></tr></thead><tbody>${tableRows(rows)}</tbody></table></section><section><h2>结论边界</h2><p>墙钟时间是软件实现的机器相对指标，不代表星上硬件时延。ISL承载字节按每跳累加，不能与生成字节重复求和。</p></section></main></body></html>`;
}

export async function runExperiment5({
  runs,
  outputDir = resolve("reports/experiment5-overhead-decomposition"),
  rootReportPath = resolve("EXPERIMENT_5_OVERHEAD_REPORT.md"),
  formal = true,
} = {}) {
  if (!runs?.length) throw new Error("Experiment 5 requires at least one before/full run pair.");
  await Promise.all([mkdir(outputDir, { recursive: true }), mkdir(dirname(rootReportPath), { recursive: true })]);
  const summaryRows = [];
  const timingRows = [];
  for (const item of runs) {
    summaryRows.push(await summarizeMethod(item.profile, "before", item.before));
    summaryRows.push(await summarizeMethod(item.profile, "full", item.after));
    timingRows.push(...timingRowsFor(item.profile, "before", item.before));
    timingRows.push(...timingRowsFor(item.profile, "full", item.after));
  }
  if (formal) {
    if (runs.length !== 3) throw new Error(`Formal Experiment 5 requires three profiles, received ${runs.length}.`);
    if (summaryRows.some((row) => row.slice_count !== 48)) throw new Error("Formal Experiment 5 requires 48 slices.");
  }
  summaryRows.forEach((row) => {
    const sum = row.probe_base_bytes + row.metadata_bytes + row.report_bytes + row.other_bytes;
    if (Math.abs(sum - row.total_generated_bytes) > 1e-6) throw new Error(`Byte accounting mismatch for ${row.constellation_profile_id}/${row.method_id}`);
  });
  const outputFiles = {
    summary_csv: join(outputDir, "experiment5-overhead-summary.csv"),
    timings_csv: join(outputDir, "experiment5-stage-timings.csv"),
    summary_json: join(outputDir, "experiment5-overhead-summary.json"),
    report_html: join(outputDir, "experiment5-overhead-report.html"),
    manifest_json: join(outputDir, "experiment5-manifest.json"),
    root_report_md: rootReportPath,
  };
  const generatedAt = new Date().toISOString();
  const summary = { schema_version: "experiment5-overhead-decomposition-v1", generated_at: generatedAt, formal, rows: summaryRows, timing_rows: timingRows };
  const manifest = {
    schema_version: "experiment5-manifest-v1",
    generated_at: generatedAt,
    host: {
      platform: platform(),
      release: release(),
      cpu_model: cpus()[0]?.model ?? "unknown",
      logical_cpu_count: cpus().length,
      total_memory_bytes: totalmem(),
      free_memory_bytes_at_report: freemem(),
      node_version: process.version,
    },
    source_pass1_fingerprints: runs.map((row) => ({ profile_id: row.profile.id, pass1_fingerprint: row.pass1Fingerprint })),
    output_files: outputFiles,
  };
  await Promise.all([
    writeFile(outputFiles.summary_csv, rowsToCsv(summaryRows), "utf8"),
    writeFile(outputFiles.timings_csv, rowsToCsv(timingRows), "utf8"),
    writeFile(outputFiles.summary_json, `${JSON.stringify(summary, null, 2)}\n`, "utf8"),
    writeFile(outputFiles.report_html, buildHtml(summaryRows, timingRows), "utf8"),
    writeFile(outputFiles.manifest_json, `${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
    writeFile(outputFiles.root_report_md, buildMarkdown(summaryRows, relative(dirname(rootReportPath), outputFiles.report_html)), "utf8"),
  ]);
  return { summaryRows, timingRows, outputFiles, summary };
}

async function loadFormalRuns(sourceRoot, profileIds) {
  const runs = [];
  for (const id of profileIds) {
    const profile = PROFILE_CATALOG.find((row) => row.id === id);
    if (!profile) throw new Error(`Unknown profile: ${id}`);
    const manifestPath = join(sourceRoot, "runs", id, "full", "run-manifest.json");
    if (!existsSync(manifestPath)) throw new Error(`Experiment 4 full manifest missing: ${manifestPath}`);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    if (manifest.status !== "complete") throw new Error(`Experiment 4 full run incomplete: ${manifestPath}`);
    runs.push({ profile, before: manifest.before, after: manifest.after, pass1Fingerprint: manifest.pass1_fingerprint });
  }
  return runs;
}

async function main() {
  const args = process.argv.slice(2);
  const sourceRoot = resolve(argValue(args, "--source-root", "reports/experiment4-leo-int-mc-ablation"));
  const outputDir = resolve(argValue(args, "--out", "reports/experiment5-overhead-decomposition"));
  const rootReportPath = resolve(argValue(args, "--root-report", "EXPERIMENT_5_OVERHEAD_REPORT.md"));
  const profileIds = listArg(args, "--profiles", PROFILE_CATALOG.map((row) => row.id));
  const result = await runExperiment5({
    runs: await loadFormalRuns(sourceRoot, profileIds),
    outputDir,
    rootReportPath,
    formal: true,
  });
  console.log(JSON.stringify({ ok: true, output_dir: outputDir, summary_rows: result.summaryRows.length, timing_rows: result.timingRows.length, root_report: rootReportPath }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
