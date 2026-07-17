import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  PROFILE_CATALOG,
  runCommandTimed,
  runIntMcCompletion,
  sha256File,
} from "./experiments/intMcExperimentCore.mjs";
import {
  EXPERIMENT8_STRESS_RATES,
  experiment8ImplementationFingerprint,
  methodDefinitions,
} from "./runExperiment8DynamicityCausality.mjs";
import { escapeHtml, parseCsv, rowsToCsv } from "./experiments/reportUtils.mjs";

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

export function parseStaticBaselineCliParameters(args = []) {
  return {
    telemetryByteBudgetPerNodeSlice: Math.max(0, numberValue(argValue(args, "--telemetry-byte-budget-per-node-slice", "0"))),
  };
}

function round(value, digits = 4) {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function stressId(rate) {
  return `stress-${String(Math.round(Number(rate) * 100)).padStart(2, "0")}`;
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

export function replicateStaticProbePlan({ initialPlan = [], slices = [] } = {}) {
  return slices.flatMap((slice) => initialPlan.map((probe, index) => ({
    ...probe,
    probe_id: `static-${String(slice.slice_index).padStart(2, "0")}-${String(index).padStart(3, "0")}`,
    slice_index: Number(slice.slice_index),
    time: slice.time,
    planning_reuse_mode: Number(slice.slice_index) === Number(slices[0]?.slice_index) ? "static-initial-plan" : "static-plan-reuse",
    candidate_source: "slice-0-static-plan",
  })));
}

export function replayReferenceProbePlan({ referencePlan = [], slices = [] } = {}) {
  const timeBySlice = new Map(slices.map((slice) => [String(slice.slice_index), slice.time]));
  const ordinalBySlice = new Map();
  return referencePlan.map((probe) => {
    const sliceKey = String(probe.slice_index);
    const ordinal = ordinalBySlice.get(sliceKey) ?? 0;
    ordinalBySlice.set(sliceKey, ordinal + 1);
    return {
      ...probe,
      probe_id: `reference-${String(probe.slice_index).padStart(2, "0")}-${String(ordinal).padStart(3, "0")}`,
      time: timeBySlice.get(sliceKey) ?? probe.time,
      planning_reuse_mode: "reference-trajectory-replay",
      candidate_source: "stress-00-reference-plan",
    };
  });
}

export function buildStaticBaselineMatrix({
  profileIds = PROFILE_CATALOG.map((profile) => profile.id),
  stressRates = EXPERIMENT8_STRESS_RATES,
} = {}) {
  return profileIds.flatMap((profileId) => stressRates.map((stressRate) => ({ profile_id: profileId, stress_rate: Number(stressRate) })));
}

function polyline(rows, field, color, width, height, padding, maximumStress, minimum, maximum) {
  const x = (value) => padding + (numberValue(value) / maximumStress) * (width - padding * 2);
  const y = (value) => height - padding - ((numberValue(value) - minimum) / (maximum - minimum || 1)) * (height - padding * 2);
  const points = [...rows].sort((a, b) => a.stress_rate - b.stress_rate).map((row) => `${x(row.stress_rate)},${y(row[field])}`).join(" ");
  return `<polyline fill="none" stroke="${color}" stroke-width="3" points="${points}"/>`;
}

function chart(rows, profileId, field, title) {
  const group = rows.filter((row) => row.profile_id === profileId);
  if (!group.length) return "";
  const width = 620;
  const height = 250;
  const padding = 45;
  const values = group.map((row) => numberValue(row[field]));
  let minimum = Math.min(...values);
  let maximum = Math.max(...values);
  if (minimum === maximum) maximum = minimum + 1;
  const byMethod = new Map();
  group.forEach((row) => {
    const rowsForMethod = byMethod.get(row.method_id) ?? [];
    rowsForMethod.push(row);
    byMethod.set(row.method_id, rowsForMethod);
  });
  const colors = { "native-reference-replay": "#b91c1c", "native-static": "#b91c1c", "native-full-replan": "#d97706", enhanced: "#047857" };
  const lines = [...byMethod.entries()].map(([method, methodRows]) => polyline(methodRows, field, colors[method], width, height, padding, 0.25, minimum, maximum)).join("");
  return `<section class="chart"><h3>${escapeHtml(title)}</h3><svg viewBox="0 0 ${width} ${height}"><line x1="${padding}" y1="${padding}" x2="${padding}" y2="${height-padding}" class="axis"/><line x1="${padding}" y1="${height-padding}" x2="${width-padding}" y2="${height-padding}" class="axis"/>${lines}<text x="${width/2}" y="${height-8}" text-anchor="middle">受控拓扑变化率</text><text x="${padding-5}" y="${padding}" text-anchor="end">${maximum.toFixed(3)}</text><text x="${padding-5}" y="${height-padding}" text-anchor="end">${minimum.toFixed(3)}</text></svg></section>`;
}

function combinedTable(rows) {
  return `<table><thead><tr><th>星座</th><th>方法</th><th>拓扑变化率</th><th>实际失效 probe 比例</th><th>CPU MAE</th><th>队列 MAE</th><th>电量 MAE</th><th>利用率 MAE</th><th>状态准确率</th><th>重新规划片数</th></tr></thead><tbody>${rows.map((row) => `<tr><td>${escapeHtml(row.constellation_label)}</td><td>${escapeHtml(row.method_label)}</td><td>${(row.stress_rate*100).toFixed(0)}%</td><td>${(numberValue(row.invalid_probe_path_ratio)*100).toFixed(2)}%</td><td>${row.cpu_mae}</td><td>${row.queue_depth_mae}</td><td>${row.energy_percent_mae}</td><td>${row.link_utilization_mae}</td><td>${(numberValue(row.link_status_accuracy)*100).toFixed(2)}%</td><td>${row.replanned_slices}</td></tr>`).join("")}</tbody></table>`;
}

function causalConclusionHtml(rows) {
  const profiles = [...new Set(rows.map((row) => row.profile_id))];
  const items = profiles.map((profileId) => {
    const profileRows = rows.filter((row) => row.profile_id === profileId);
    const reference = profileRows.filter((row) => row.method_id === "native-reference-replay").sort((a, b) => a.stress_rate - b.stress_rate);
    if (reference.length < 2) return "";
    const low = reference[0];
    const high = reference.at(-1);
    const full = profileRows.find((row) => row.method_id === "native-full-replan" && row.stress_rate === high.stress_rate);
    const enhanced = profileRows.find((row) => row.method_id === "enhanced" && row.stress_rate === high.stress_rate);
    return `<article><h3>${escapeHtml(high.constellation_label)}</h3><p><strong>参考计划失效随扰动上升：</strong>${(low.invalid_probe_path_ratio * 100).toFixed(2)}% → ${(high.invalid_probe_path_ratio * 100).toFixed(2)}%。</p><p>利用率 MAE：${low.link_utilization_mae} → ${high.link_utilization_mae}；CPU MAE：${low.cpu_mae} → ${high.cpu_mae}。</p><p>25% 扰动时，全重规划原生组重新规划 ${full?.replanned_slices ?? "-"} 片、耗时 ${full?.planning_wall_time_ms ?? "-"} ms；增强组重新规划 ${enhanced?.replanned_slices ?? "-"} 片、耗时 ${enhanced?.planning_wall_time_ms ?? "-"} ms。</p></article>`;
  }).join("");
  return `<section class="conclusions"><h2>因果结论</h2>${items}<p><strong>审慎结论：</strong>参考计划在新增拓扑扰动下产生真实 probe 失效；每片全重规划能够避免失效，但需要持续规划计算。不能预设增强方法在所有指标上都占优，负结果和高扰动下的重规划退化必须一并报告。</p></section>`;
}

export function buildStaticBaselineHtml({ rows = [] } = {}) {
  const charts = PROFILE_CATALOG.filter((profile) => rows.some((row) => row.profile_id === profile.id)).flatMap((profile) => [
    chart(rows, profile.id, "invalid_probe_path_ratio", `${profile.short_label}：实际失效 probe 比例`),
    chart(rows, profile.id, "link_utilization_mae", `${profile.short_label}：链路利用率 MAE`),
  ]).join("");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>实验8 原生参考计划回放因果基线</title><style>body{font-family:"Microsoft YaHei",Arial,sans-serif;background:#f4f6f7;color:#16242b;margin:0}main{max-width:1500px;margin:auto;padding:28px}.band,.chart,.conclusions{background:#fff;border:1px solid #d7e0e3;padding:16px;margin:14px 0}.conclusions article{border-left:4px solid #047857;padding:4px 14px;margin:12px 0}.charts{display:grid;grid-template-columns:repeat(auto-fit,minmax(480px,1fr));gap:14px}.chart svg{width:100%}.axis{stroke:#82939b}table{width:100%;border-collapse:collapse;background:#fff;font-size:13px}th,td{border:1px solid #d7e0e3;padding:7px;text-align:right}th:first-child,td:first-child,th:nth-child(2),td:nth-child(2){text-align:left}th{background:#e8f0f2}.legend span{margin-right:18px}</style></head><body><main><h1>实验 8：原生参考计划在动态 LEO 中的因果基线</h1><div class="band"><strong>设计：</strong>原生参考回放组在 0% 受控扰动轨迹上预计算 48 片计划，随后把同一计划序列原样回放到 5%–25% 扰动轨迹，不读取新增变化；原生全重规划组每片重新选路；增强 LEO-INT-MC 根据拓扑类复用、局部修复或重规划。</div><p class="legend"><span style="color:#b91c1c">● 原生参考计划回放</span><span style="color:#d97706">● 原生每片全重规划</span><span style="color:#047857">● 增强 LEO-INT-MC</span></p>${causalConclusionHtml(rows)}<div class="charts">${charts}</div><h2>逐组合结果</h2>${combinedTable(rows)}<h2>解释边界</h2><ul><li>参考回放组的失效比例是 probe 实际执行时遇到 down 链路的比例，不是反事实 carryover 指标。</li><li>全重规划原生组展示通过高规划开销适应动态拓扑的上界。</li><li>增强组目标是在较低重规划开销下维持重构质量。</li></ul></main></body></html>`;
}

function buildMarkdown(rows) {
  return `# 实验 8：原生参考计划回放因果基线\n\n参考回放组使用 0% 受控扰动轨迹上预计算的逐片计划，在更高扰动下不重新规划；失效路径不会穿越 down 链路，也不会生成可交付报告。\n\n| 星座 | 方法 | 变化率 | 失效 probe | CPU MAE | 队列 MAE | 电量 MAE | 利用率 MAE | 在线重规划片数 |\n|---|---|---:|---:|---:|---:|---:|---:|---:|\n${rows.map((row) => `| ${row.constellation_label} | ${row.method_label} | ${(row.stress_rate*100).toFixed(0)}% | ${(numberValue(row.invalid_probe_path_ratio)*100).toFixed(2)}% | ${row.cpu_mae} | ${row.queue_depth_mae} | ${row.energy_percent_mae} | ${row.link_utilization_mae} | ${row.replanned_slices} |`).join("\n")}\n`;
}

export async function runStaticNativeBaseline({
  baseDir,
  outputDir,
  rootReportPath,
  profiles = PROFILE_CATALOG,
  stressRates = EXPERIMENT8_STRESS_RATES,
  planMode = "reference-trajectory",
  telemetryByteBudgetPerNodeSlice = 0,
  resume = true,
  formal = true,
} = {}) {
  await Promise.all([mkdir(outputDir, { recursive: true }), mkdir(dirname(rootReportPath), { recursive: true })]);
  const implementationFingerprint = await experiment8ImplementationFingerprint();
  const nativeMethod = methodDefinitions().find((method) => method.id === "native");
  const baseSummary = await readJson(join(baseDir, "experiment8-dynamicity-summary.json"));
  const staticRows = [];
  const runManifests = [];

  for (const profile of profiles) {
    const initialSourceDir = join(baseDir, "runs", profile.id, "stress-00", "native", "stage2");
    const referencePlanRows = await readCsv(join(initialSourceDir, "probe-paths-int-mc.csv"));
    const initialPlanRows = referencePlanRows.filter((row) => numberValue(row.slice_index) === 0);
    if (!referencePlanRows.length || !initialPlanRows.length) throw new Error(`${profile.id}: no native reference probe plan`);
    const initialPlanHash = await sha256File(join(initialSourceDir, "probe-paths-int-mc.csv"));
    for (const stressRate of stressRates) {
      const stress = stressId(stressRate);
      const truthDir = join(baseDir, "inputs", profile.id, stress);
      const sourceMethodDir = join(baseDir, "runs", profile.id, stress, "native");
      const sourceManifestPath = join(sourceMethodDir, "run-manifest.json");
      const sourceManifest = await readJson(sourceManifestPath);
      const sourceManifestHash = await sha256File(sourceManifestPath);
      const methodId = planMode === "single-t0" ? "native-static" : "native-reference-replay";
      const runDir = join(outputDir, "runs", profile.id, stress, methodId);
      const manifestPath = join(runDir, "run-manifest.json");
      let manifest = null;
      if (resume && existsSync(manifestPath)) {
        const candidate = await readJson(manifestPath);
        if (candidate.status === "complete" && candidate.implementation_fingerprint === implementationFingerprint && candidate.source_manifest_sha256 === sourceManifestHash && candidate.initial_plan_sha256 === initialPlanHash && candidate.plan_mode === planMode && numberValue(candidate.telemetry_byte_budget_per_node_slice) === numberValue(telemetryByteBudgetPerNodeSlice)) manifest = candidate;
      }
      if (!manifest) {
        const metricsRows = await readCsv(join(truthDir, "metrics.csv"));
        const slices = [...new Map(metricsRows.map((row) => [String(row.slice_index), { slice_index: numberValue(row.slice_index), time: row.time }])).values()].sort((a, b) => a.slice_index - b.slice_index);
        const staticPlan = planMode === "single-t0"
          ? replicateStaticProbePlan({ initialPlan: initialPlanRows, slices })
          : replayReferenceProbePlan({ referencePlan: referencePlanRows, slices });
        const telemetryStage2Dir = join(runDir, "stage2");
        const groundDir = join(runDir, "ground-oam");
        await mkdir(telemetryStage2Dir, { recursive: true });
        const staticPlanPath = join(telemetryStage2Dir, "probe-paths-int-mc.csv");
        await writeFile(staticPlanPath, rowsToCsv(staticPlan), "utf8");
        const timings = {};
        const reporting = await runCommandTimed({
          label: `${profile.short_label} ${stress} static reporting plan`,
          script: "stage2-int/tools/reporting-path-planner.mjs",
          args: ["--input", truthDir, "--stage2", join(sourceMethodDir, "stage2"), "--out", telemetryStage2Dir, "--algorithm", "int-mc", "--probes", staticPlanPath],
        });
        timings.reporting_plan = reporting.timing;
        const probe = await runCommandTimed({
          label: `${profile.short_label} ${stress} static probe`,
          script: "stage2-int/tools/probe-int-runner.mjs",
          args: ["--input", truthDir, "--stage2", join(sourceMethodDir, "stage2"), "--out", telemetryStage2Dir, "--algorithm", "int-mc", "--probe-paths", staticPlanPath, "--reporting-paths", join(telemetryStage2Dir, "reporting-paths-int-mc.csv"), "--invalid-probe-policy", "drop", "--telemetry-byte-budget-per-node-slice", String(telemetryByteBudgetPerNodeSlice)],
        });
        timings.probe_execution = probe.timing;
        const ground = await runCommandTimed({
          label: `${profile.short_label} ${stress} static Ground OAM`,
          script: "stage2-int/tools/ground-oam-reconstructor.mjs",
          args: ["--input", truthDir, "--stage2", join(sourceMethodDir, "stage2"), "--out", groundDir, "--hops", join(telemetryStage2Dir, "probe-int-hop-records-int-mc.csv"), "--reports", join(telemetryStage2Dir, "probe-int-reports-int-mc.csv"), "--downlink-budget-bytes", String(sourceManifest.parameters.downlinkBudgetBytes), "--write-estimate-graph", "false"],
        });
        timings.ground_oam = ground.timing;
        const completion = await runIntMcCompletion({
          label: `${profile.short_label} ${stress} static completion`,
          truthDir,
          stage2Dir: join(sourceMethodDir, "stage2"),
          telemetryStage2Dir,
          groundDir,
          rank: sourceManifest.parameters.rank,
          windowSize: sourceManifest.parameters.windowSize,
          iterations: sourceManifest.parameters.iterations,
          mechanisms: nativeMethod.mechanisms,
        });
        timings.matrix_completion = completion.timing;
        const runReport = await readJson(join(telemetryStage2Dir, "probe-int-run-report-int-mc.json"));
        const groundEvaluation = await readJson(join(groundDir, "ground-oam-evaluation.json"));
        const row = {
          profile_id: profile.id,
          constellation_label: profile.short_label,
          method_id: methodId,
          method_label: planMode === "single-t0" ? "原生 INT-MC（T00 静态计划）" : "原生 INT-MC（参考计划回放）",
          stress_rate: Number(stressRate),
          planned_probes: numberValue(runReport.planning?.planned_probe_paths, numberValue(runReport.planning?.probe_paths)),
          invalid_probe_paths: numberValue(runReport.planning?.invalid_probe_paths),
          invalid_probe_path_ratio: numberValue(runReport.planning?.invalid_probe_path_ratio),
          delivery_ratio: numberValue(groundEvaluation.downlink_model?.delivery_ratio),
          cpu_mae: completion.metrics.cpu_mae,
          queue_depth_mae: completion.metrics.queue_depth_mae,
          energy_percent_mae: completion.metrics.energy_percent_mae,
          node_mode_accuracy: completion.metrics.node_mode_accuracy,
          link_utilization_mae: completion.metrics.link_utilization_mae,
          link_status_accuracy: completion.metrics.link_status_accuracy,
          selected_paths: numberValue(runReport.planning?.probe_paths),
          telemetry_bytes_per_node_slice: completion.metrics.telemetry_bytes_per_node_slice,
          total_telemetry_generated_bytes: completion.metrics.total_telemetry_generated_bytes,
          total_telemetry_energy_j: completion.metrics.total_telemetry_energy_j,
          telemetry_byte_budget_enabled: completion.metrics.telemetry_byte_budget_enabled,
          telemetry_byte_budget_per_node_slice: completion.metrics.telemetry_byte_budget_per_node_slice,
          telemetry_byte_budget_padding_bytes: completion.metrics.telemetry_byte_budget_padding_bytes,
          telemetry_padding_bytes_per_node_slice: completion.metrics.telemetry_padding_bytes_per_node_slice,
          telemetry_byte_budget_total_cap_bytes: completion.metrics.telemetry_byte_budget_total_cap_bytes,
          telemetry_byte_budget_utilization: round(completion.metrics.telemetry_byte_budget_utilization, 6),
          telemetry_byte_budget_rejected_probe_paths: completion.metrics.telemetry_byte_budget_rejected_probe_paths,
          telemetry_byte_budget_cap_violations: completion.metrics.telemetry_byte_budget_cap_violations,
          replanned_slices: planMode === "single-t0" ? 1 : 0,
          planning_wall_time_ms: round(reporting.timing.wall_time_ms),
          probe_execution_ms: round(probe.timing.wall_time_ms),
          ground_oam_ms: round(ground.timing.wall_time_ms),
          matrix_completion_ms: round(completion.timing.wall_time_ms),
        };
        manifest = {
          schema_version: "experiment8-native-reference-replay-run-v1",
          status: "complete",
          generated_at: new Date().toISOString(),
          implementation_fingerprint: implementationFingerprint,
          source_manifest: sourceManifestPath,
          source_manifest_sha256: sourceManifestHash,
          initial_plan_sha256: initialPlanHash,
          fixed_initial_probe_count: initialPlanRows.length,
          reference_probe_count: referencePlanRows.length,
          plan_mode: planMode,
          telemetry_byte_budget_per_node_slice: telemetryByteBudgetPerNodeSlice,
          row,
        };
        await mkdir(runDir, { recursive: true });
        await writeJson(manifestPath, manifest);
      }
      staticRows.push(manifest.row);
      runManifests.push({ profile_id: profile.id, stress_rate: stressRate, manifest: manifestPath });
    }
  }

  const comparisonRows = [];
  for (const profile of profiles) {
    for (const stressRate of stressRates) {
      const staticRow = staticRows.find((row) => row.profile_id === profile.id && row.stress_rate === stressRate);
      comparisonRows.push(staticRow);
      for (const methodId of ["native", "enhanced"]) {
        const source = baseSummary.summary_rows.find((row) => row.constellation_profile_id === profile.id && row.method_id === methodId && numberValue(row.target_stress_rate) === stressRate);
        if (!source) continue;
        comparisonRows.push({
          profile_id: profile.id,
          constellation_label: profile.short_label,
          method_id: methodId === "native" ? "native-full-replan" : "enhanced",
          method_label: methodId === "native" ? "原生 INT-MC（每片全重规划）" : "增强 LEO-INT-MC",
          stress_rate: stressRate,
          invalid_probe_path_ratio: numberValue(source.path_failure_ratio),
          cpu_mae: source.cpu_mae,
          queue_depth_mae: source.queue_depth_mae,
          energy_percent_mae: source.energy_percent_mae,
          node_mode_accuracy: source.node_mode_accuracy,
          link_utilization_mae: source.link_utilization_mae,
          link_status_accuracy: source.link_status_accuracy,
          selected_paths: source.selected_paths,
          telemetry_bytes_per_node_slice: source.telemetry_bytes_per_node_slice,
          total_telemetry_generated_bytes: source.total_telemetry_generated_bytes,
          total_telemetry_energy_j: source.total_telemetry_energy_j,
          telemetry_byte_budget_enabled: source.telemetry_byte_budget_enabled,
          telemetry_byte_budget_per_node_slice: source.telemetry_byte_budget_per_node_slice,
          telemetry_byte_budget_padding_bytes: source.telemetry_byte_budget_padding_bytes,
          telemetry_padding_bytes_per_node_slice: source.telemetry_padding_bytes_per_node_slice,
          telemetry_byte_budget_total_cap_bytes: source.telemetry_byte_budget_total_cap_bytes,
          telemetry_byte_budget_utilization: source.telemetry_byte_budget_utilization,
          telemetry_byte_budget_rejected_probe_paths: source.telemetry_byte_budget_rejected_probe_paths,
          telemetry_byte_budget_cap_violations: source.telemetry_byte_budget_cap_violations,
          replanned_slices: methodId === "native" ? source.fresh_slice_plans : source.fresh_slice_plans,
          planning_wall_time_ms: source.planning_wall_time_ms,
        });
      }
    }
  }

  if (formal) {
    const expected = profiles.length * stressRates.length;
    if (staticRows.length !== expected) throw new Error(`Expected ${expected} static rows, got ${staticRows.length}`);
    const expectedOnlineReplans = planMode === "single-t0" ? 1 : 0;
    if (staticRows.some((row) => row.replanned_slices !== expectedOnlineReplans)) throw new Error("Reference baseline performed unexpected online replanning");
    if (comparisonRows.some((row) => numberValue(row.telemetry_byte_budget_cap_violations) !== 0)) throw new Error("Reference comparison exceeded a telemetry hard byte budget");
  }
  const outputs = {
    static_summary_csv: join(outputDir, "experiment8-native-static-summary.csv"),
    comparison_csv: join(outputDir, "experiment8-native-static-comparison.csv"),
    summary_json: join(outputDir, "experiment8-native-static-summary.json"),
    report_html: join(outputDir, "experiment8-native-static-report.html"),
    report_md: rootReportPath,
  };
  const summary = { schema_version: "experiment8-native-reference-replay-causal-baseline-v1", generated_at: new Date().toISOString(), implementation_fingerprint: implementationFingerprint, plan_mode: planMode, static_rows: staticRows, comparison_rows: comparisonRows, run_manifests: runManifests };
  await Promise.all([
    writeFile(outputs.static_summary_csv, rowsToCsv(staticRows), "utf8"),
    writeFile(outputs.comparison_csv, rowsToCsv(comparisonRows), "utf8"),
    writeJson(outputs.summary_json, summary),
    writeFile(outputs.report_html, buildStaticBaselineHtml({ rows: comparisonRows }), "utf8"),
    writeFile(outputs.report_md, buildMarkdown(comparisonRows), "utf8"),
  ]);
  return { staticRows, comparisonRows, outputs };
}

async function main() {
  const args = process.argv.slice(2);
  const cliParameters = parseStaticBaselineCliParameters(args);
  const profileIds = listArg(args, "--profiles", PROFILE_CATALOG.map((profile) => profile.id));
  const profiles = profileIds.map((id) => {
    const profile = PROFILE_CATALOG.find((candidate) => candidate.id === id);
    if (!profile) throw new Error(`Unknown profile: ${id}`);
    return profile;
  });
  const result = await runStaticNativeBaseline({
    baseDir: resolve(argValue(args, "--base", "reports/experiment8-dynamicity-causality")),
    outputDir: resolve(argValue(args, "--out", "reports/experiment8-native-reference-replay")),
    rootReportPath: resolve(argValue(args, "--root-report", "EXPERIMENT_8_NATIVE_REFERENCE_REPLAY_REPORT.md")),
    profiles,
    stressRates: listArg(args, "--targets", EXPERIMENT8_STRESS_RATES).map(Number),
    resume: argValue(args, "--resume", "true").toLowerCase() !== "false",
    formal: argValue(args, "--formal", "true").toLowerCase() !== "false",
    planMode: argValue(args, "--plan-mode", "reference-trajectory"),
    telemetryByteBudgetPerNodeSlice: cliParameters.telemetryByteBudgetPerNodeSlice,
  });
  console.log(JSON.stringify({ ok: true, static_rows: result.staticRows.length, report: relative(process.cwd(), result.outputs.report_html) }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
