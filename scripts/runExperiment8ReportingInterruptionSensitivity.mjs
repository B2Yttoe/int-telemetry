import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { cpus, freemem, platform, release, totalmem } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  PROFILE_CATALOG,
  runIntMcPostSelection,
  sha256File,
} from "./experiments/intMcExperimentCore.mjs";
import {
  experiment8ImplementationFingerprint,
  methodDefinitions,
} from "./runExperiment8DynamicityCausality.mjs";
import { escapeHtml, rowsToCsv } from "./experiments/reportUtils.mjs";

export const REPORTING_INTERRUPTION_RATES = Object.freeze([0, 0.05, 0.10, 0.15, 0.20]);

function argValue(args, name, fallback = "") {
  const index = args.indexOf(name);
  return index === -1 ? fallback : (args[index + 1] ?? fallback);
}

function listArg(args, name, fallback) {
  const raw = argValue(args, name, "");
  return raw ? raw.split(",").map((value) => value.trim()).filter(Boolean) : fallback;
}

function rateId(rate) {
  return `reporting-${String(Math.round(Number(rate) * 100)).padStart(2, "0")}`;
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

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function buildReportingSensitivityMatrix({
  profileIds = PROFILE_CATALOG.map((profile) => profile.id),
  methodIds = methodDefinitions().map((method) => method.id),
  rates = REPORTING_INTERRUPTION_RATES,
} = {}) {
  return profileIds.flatMap((profileId) =>
    rates.flatMap((rate) => methodIds.map((methodId) => ({
      profile_id: profileId,
      reporting_interruption_rate: Number(rate),
      method_id: methodId,
    }))),
  );
}

function lineChart(rows, { profileId, metric, title, percent = false }) {
  const selected = rows.filter((row) => row.profile_id === profileId);
  if (!selected.length) return "";
  const width = 620;
  const height = 250;
  const padding = { left: 58, right: 20, top: 35, bottom: 40 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const values = selected.map((row) => numberValue(row[metric]));
  let minimum = Math.min(...values);
  let maximum = Math.max(...values);
  if (maximum === minimum) maximum = minimum + 1;
  const margin = (maximum - minimum) * 0.08;
  minimum -= margin;
  maximum += margin;
  const x = (rate) => padding.left + (numberValue(rate) / 0.2) * plotWidth;
  const y = (value) => padding.top + (1 - (numberValue(value) - minimum) / (maximum - minimum)) * plotHeight;
  const colors = { native: "#d1495b", enhanced: "#00798c" };
  const paths = methodDefinitions().map((method) => {
    const points = selected
      .filter((row) => row.method_id === method.id)
      .sort((left, right) => left.reporting_interruption_rate - right.reporting_interruption_rate)
      .map((row) => `${x(row.reporting_interruption_rate)},${y(row[metric])}`)
      .join(" ");
    return `<polyline fill="none" stroke="${colors[method.id]}" stroke-width="3" points="${points}"/>`;
  }).join("");
  const dots = selected.map((row) => `<circle cx="${x(row.reporting_interruption_rate)}" cy="${y(row[metric])}" r="4" fill="${colors[row.method_id]}"/>`).join("");
  const xTicks = REPORTING_INTERRUPTION_RATES.map((rate) => `<text x="${x(rate)}" y="${height - 15}" text-anchor="middle">${Math.round(rate * 100)}%</text>`).join("");
  const format = (value) => percent ? `${(value * 100).toFixed(1)}%` : value.toFixed(3);
  return `<section class="chart"><h3>${escapeHtml(title)}</h3><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(title)}">
    <line x1="${padding.left}" y1="${padding.top}" x2="${padding.left}" y2="${height - padding.bottom}" class="axis"/>
    <line x1="${padding.left}" y1="${height - padding.bottom}" x2="${width - padding.right}" y2="${height - padding.bottom}" class="axis"/>
    <text x="${padding.left - 8}" y="${padding.top + 5}" text-anchor="end">${format(maximum)}</text>
    <text x="${padding.left - 8}" y="${height - padding.bottom}" text-anchor="end">${format(minimum)}</text>
    ${xTicks}${paths}${dots}
    <text x="${width / 2}" y="${height - 1}" text-anchor="middle">reporting path 中断率</text>
  </svg></section>`;
}

function resultTable(rows) {
  return `<table><thead><tr><th>星座</th><th>方法</th><th>目标中断率</th><th>实际中断率</th><th>交付率</th><th>CPU MAE</th><th>队列 MAE</th><th>电量 MAE</th><th>链路利用率 MAE</th><th>链路状态准确率</th><th>路径数</th><th>字节/节点/片</th></tr></thead><tbody>${rows.map((row) => `<tr>
    <td>${escapeHtml(row.constellation_label)}</td><td>${escapeHtml(row.method_label)}</td>
    <td>${(row.reporting_interruption_rate * 100).toFixed(0)}%</td><td>${(row.achieved_reporting_interruption_rate * 100).toFixed(2)}%</td><td>${(row.delivery_ratio * 100).toFixed(2)}%</td>
    <td>${row.cpu_mae}</td><td>${row.queue_depth_mae}</td><td>${row.energy_percent_mae}</td><td>${row.link_utilization_mae}</td><td>${(row.link_status_accuracy * 100).toFixed(2)}%</td>
    <td>${row.selected_paths}</td><td>${row.telemetry_bytes_per_node_slice}</td></tr>`).join("")}</tbody></table>`;
}

export function buildReportingSensitivityHtml({ rows = [], parameters = {} } = {}) {
  const charts = PROFILE_CATALOG.filter((profile) => rows.some((row) => row.profile_id === profile.id)).flatMap((profile) => [
    lineChart(rows, { profileId: profile.id, metric: "delivery_ratio", title: `${profile.short_label}：报告交付率`, percent: true }),
    lineChart(rows, { profileId: profile.id, metric: "link_utilization_mae", title: `${profile.short_label}：链路利用率 MAE` }),
  ]).join("");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>实验 8：reporting path 中断敏感性</title><style>
  body{font-family:"Microsoft YaHei",Arial,sans-serif;margin:0;background:#f4f7f8;color:#17242b}main{max-width:1500px;margin:auto;padding:28px}h1,h2,h3{letter-spacing:0}.band{background:#fff;border-left:5px solid #00798c;padding:18px;margin:18px 0}.charts{display:grid;grid-template-columns:repeat(auto-fit,minmax(460px,1fr));gap:14px}.chart{background:#fff;border:1px solid #d8e0e3;padding:12px}.chart svg{width:100%;height:auto}.axis{stroke:#82939b;stroke-width:1}svg text{font-size:12px;fill:#40545d}table{border-collapse:collapse;width:100%;background:#fff;font-size:13px}th,td{border:1px solid #d8e0e3;padding:7px;text-align:right}th:first-child,td:first-child,th:nth-child(2),td:nth-child(2){text-align:left}th{background:#e9f1f3;position:sticky;top:0}.legend span{margin-right:20px}.native{color:#d1495b}.enhanced{color:#00798c}</style></head><body><main>
  <h1>实验 8：reporting path 中断敏感性</h1>
  <div class="band"><strong>因果设计：</strong>固定 25% 拓扑扰动、固定业务、固定 probe plan、固定采样预算，仅将 reporting path 中断率从 0% 提高到 20%。中断发生在 sink 生成报告之后、Ground OAM 接收之前。</div>
  <p class="legend"><span class="native">● 原生 INT-MC</span><span class="enhanced">● 增强 LEO-INT-MC</span></p>
  <h2>可视化结果</h2><div class="charts">${charts}</div>
  <h2>综合数据</h2>${resultTable(rows)}
  <h2>解释边界</h2><ul><li>该实验验证报告回传中断对 OAM 可观测性和补全误差的因果影响。</li><li>固定采样预算指 probe 路径数、采样覆盖目标和生成遥测字节不随中断率改变。</li><li>中断后的报告已经生成，但不会计入 reporting path 转发和成功下传。</li><li>CPU、电量和队列仍是模型内部状态，只能用于算法重构误差评价，不是运营商公开真值。</li></ul>
  <p>拓扑扰动率：${numberValue(parameters.topology_stress_rate, 0.25) * 100}%</p>
  </main></body></html>`;
}

function markdownReport(rows, parameters) {
  const headers = "| 星座 | 方法 | 中断率 | 交付率 | CPU MAE | 队列 MAE | 电量 MAE | 利用率 MAE | 状态准确率 |\n|---|---|---:|---:|---:|---:|---:|---:|---:|";
  return `# 实验 8：reporting path 中断敏感性\n\n- 固定拓扑扰动：${numberValue(parameters.topology_stress_rate, 0.25) * 100}%\n- 固定 probe plan 与采样预算\n- 唯一自变量：reporting path 中断率\n\n${headers}\n${rows.map((row) => `| ${row.constellation_label} | ${row.method_label} | ${(row.achieved_reporting_interruption_rate * 100).toFixed(2)}% | ${(row.delivery_ratio * 100).toFixed(2)}% | ${row.cpu_mae} | ${row.queue_depth_mae} | ${row.energy_percent_mae} | ${row.link_utilization_mae} | ${(row.link_status_accuracy * 100).toFixed(2)}% |`).join("\n")}\n\n## 边界\n\n轨道、拓扑和传播时延可以由外部数据验证；CPU、电量、队列为模型内部状态，本实验只评价遥测重构误差。\n`;
}

export async function runReportingSensitivity({
  baseDir,
  outputDir,
  rootReportPath,
  profiles = PROFILE_CATALOG,
  methods = methodDefinitions(),
  rates = REPORTING_INTERRUPTION_RATES,
  topologyStressRate = 0.25,
  seed = "experiment8-reporting-sensitivity",
  resume = true,
  formal = true,
} = {}) {
  await mkdir(outputDir, { recursive: true });
  await mkdir(dirname(rootReportPath), { recursive: true });
  const fingerprint = await experiment8ImplementationFingerprint();
  const stressId = `stress-${String(Math.round(topologyStressRate * 100)).padStart(2, "0")}`;
  const rows = [];
  const manifests = [];

  for (const profile of profiles) {
    const truthDir = join(baseDir, "inputs", profile.id, stressId);
    for (const rate of rates) {
      for (const method of methods) {
        const sourceMethodDir = join(baseDir, "runs", profile.id, stressId, method.id);
        const sourceManifestPath = join(sourceMethodDir, "run-manifest.json");
        if (!existsSync(sourceManifestPath)) throw new Error(`Missing source run: ${sourceManifestPath}`);
        const sourceManifestHash = await sha256File(sourceManifestPath);
        const sourceManifest = await readJson(sourceManifestPath);
        const runDir = join(outputDir, "runs", profile.id, rateId(rate), method.id);
        const manifestPath = join(runDir, "run-manifest.json");
        let manifest = null;
        if (resume && existsSync(manifestPath)) {
          const candidate = await readJson(manifestPath);
          if (
            candidate.status === "complete" &&
            candidate.implementation_fingerprint === fingerprint &&
            candidate.source_manifest_sha256 === sourceManifestHash &&
            candidate.reporting_interruption_rate === rate
          ) manifest = candidate;
        }
        if (!manifest) {
          const sourceStage2Dir = join(sourceMethodDir, "stage2");
          const telemetryStage2Dir = join(runDir, "stage2");
          const groundDir = join(runDir, "ground-oam");
          const post = await runIntMcPostSelection({
            label: `${profile.short_label} ${method.id} reporting ${rate}`,
            truthDir,
            sourceStage2Dir,
            telemetryStage2Dir,
            groundDir,
            rank: sourceManifest.parameters.rank,
            windowSize: sourceManifest.parameters.windowSize,
            iterations: sourceManifest.parameters.iterations,
            downlinkBudgetBytes: sourceManifest.parameters.downlinkBudgetBytes,
            reportingInterruptionRate: rate,
            reportingInterruptionSeed: `${seed}:${profile.id}:${method.id}`,
            writeEstimateGraph: false,
            mechanisms: method.mechanisms,
          });
          const groundEvaluation = await readJson(post.artifacts.ground_evaluation_json);
          for (const field of ["selected_paths", "total_telemetry_generated_bytes", "active_link_sampling_coverage"]) {
            if (post.metrics[field] !== sourceManifest.run.metrics[field]) {
              throw new Error(`${profile.id}/${method.id}/${rate}: fixed-budget field changed: ${field}`);
            }
          }
          const row = {
            profile_id: profile.id,
            constellation_label: profile.short_label,
            node_count: profile.node_count,
            method_id: method.id,
            method_label: method.label,
            topology_stress_rate: topologyStressRate,
            reporting_interruption_rate: rate,
            achieved_reporting_interruption_rate: post.reporting_interruption.achieved_rate,
            eligible_reports: post.reporting_interruption.eligible_reports,
            interrupted_reports: post.reporting_interruption.interrupted_reports,
            delivery_ratio: numberValue(groundEvaluation.downlink_model?.delivery_ratio),
            delivered_reports: numberValue(groundEvaluation.downlink_model?.delivered_reports),
            queued_or_dropped_reports: numberValue(groundEvaluation.downlink_model?.queued_or_dropped_reports),
            selected_paths: post.metrics.selected_paths,
            telemetry_bytes_per_node_slice: post.metrics.telemetry_bytes_per_node_slice,
            total_telemetry_generated_bytes: post.metrics.total_telemetry_generated_bytes,
            total_isl_telemetry_link_bytes: post.metrics.total_isl_telemetry_link_bytes,
            cpu_mae: post.metrics.cpu_mae,
            queue_depth_mae: post.metrics.queue_depth_mae,
            energy_percent_mae: post.metrics.energy_percent_mae,
            node_mode_accuracy: post.metrics.node_mode_accuracy,
            link_utilization_mae: post.metrics.link_utilization_mae,
            link_status_accuracy: post.metrics.link_status_accuracy,
            probe_execution_ms: round(post.timings.probe_execution.wall_time_ms),
            ground_oam_ms: round(post.timings.ground_oam.wall_time_ms),
            matrix_completion_ms: round(post.timings.matrix_completion.wall_time_ms),
          };
          manifest = {
            schema_version: "experiment8-reporting-sensitivity-run-v1",
            status: "complete",
            generated_at: new Date().toISOString(),
            implementation_fingerprint: fingerprint,
            source_manifest: sourceManifestPath,
            source_manifest_sha256: sourceManifestHash,
            reporting_interruption_rate: rate,
            fixed_budget_verified: true,
            row,
            artifacts: post.artifacts,
          };
          await mkdir(runDir, { recursive: true });
          await writeJson(manifestPath, manifest);
        }
        rows.push(manifest.row);
        manifests.push({ profile_id: profile.id, method_id: method.id, rate, manifest: manifestPath });
      }
    }
  }

  if (formal) {
    const expected = profiles.length * methods.length * rates.length;
    if (rows.length !== expected) throw new Error(`Expected ${expected} rows, got ${rows.length}`);
    for (const profile of profiles) {
      for (const method of methods) {
        const group = rows.filter((row) => row.profile_id === profile.id && row.method_id === method.id);
        if (new Set(group.map((row) => row.selected_paths)).size !== 1) throw new Error(`${profile.id}/${method.id}: selected path budget changed`);
        if (new Set(group.map((row) => row.total_telemetry_generated_bytes)).size !== 1) throw new Error(`${profile.id}/${method.id}: generated telemetry budget changed`);
      }
    }
  }

  const parameters = { topology_stress_rate: topologyStressRate, rates, seed };
  const outputs = {
    summary_csv: join(outputDir, "experiment8-reporting-sensitivity-summary.csv"),
    summary_json: join(outputDir, "experiment8-reporting-sensitivity-summary.json"),
    report_html: join(outputDir, "experiment8-reporting-sensitivity-report.html"),
    report_md: rootReportPath,
    manifest_json: join(outputDir, "experiment8-reporting-sensitivity-manifest.json"),
  };
  const summary = {
    schema_version: "experiment8-reporting-interruption-sensitivity-v1",
    generated_at: new Date().toISOString(),
    implementation_fingerprint: fingerprint,
    parameters,
    rows,
    run_manifests: manifests,
  };
  const manifest = {
    schema_version: "experiment8-reporting-interruption-manifest-v1",
    generated_at: summary.generated_at,
    host: { platform: platform(), release: release(), cpu_model: cpus()[0]?.model ?? "unknown", logical_cpu_count: cpus().length, total_memory_bytes: totalmem(), free_memory_bytes_at_report: freemem(), node_version: process.version },
    implementation_fingerprint: fingerprint,
    row_count: rows.length,
    outputs,
    run_manifests: manifests,
  };
  await Promise.all([
    writeFile(outputs.summary_csv, rowsToCsv(rows), "utf8"),
    writeJson(outputs.summary_json, summary),
    writeFile(outputs.report_html, buildReportingSensitivityHtml({ rows, parameters }), "utf8"),
    writeFile(outputs.report_md, markdownReport(rows, parameters), "utf8"),
    writeJson(outputs.manifest_json, manifest),
  ]);
  return { rows, outputs, fingerprint };
}

async function main() {
  const args = process.argv.slice(2);
  const baseDir = resolve(argValue(args, "--base", "reports/experiment8-dynamicity-causality"));
  const outputDir = resolve(argValue(args, "--out", "reports/experiment8-reporting-interruption-sensitivity"));
  const rootReportPath = resolve(argValue(args, "--root-report", "EXPERIMENT_8_REPORTING_INTERRUPTION_REPORT.md"));
  const profileIds = listArg(args, "--profiles", PROFILE_CATALOG.map((profile) => profile.id));
  const methodIds = listArg(args, "--methods", methodDefinitions().map((method) => method.id));
  const rates = listArg(args, "--rates", REPORTING_INTERRUPTION_RATES).map(Number);
  const profiles = profileIds.map((id) => {
    const profile = PROFILE_CATALOG.find((candidate) => candidate.id === id);
    if (!profile) throw new Error(`Unknown profile: ${id}`);
    return profile;
  });
  const methods = methodIds.map((id) => {
    const method = methodDefinitions().find((candidate) => candidate.id === id);
    if (!method) throw new Error(`Unknown method: ${id}`);
    return method;
  });
  const result = await runReportingSensitivity({
    baseDir,
    outputDir,
    rootReportPath,
    profiles,
    methods,
    rates,
    topologyStressRate: numberValue(argValue(args, "--topology-stress-rate", "0.25"), 0.25),
    seed: argValue(args, "--seed", "experiment8-reporting-sensitivity"),
    resume: argValue(args, "--resume", "true").toLowerCase() !== "false",
    formal: argValue(args, "--formal", "true").toLowerCase() !== "false",
  });
  console.log(JSON.stringify({ ok: true, rows: result.rows.length, report: relative(process.cwd(), result.outputs.report_html) }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
