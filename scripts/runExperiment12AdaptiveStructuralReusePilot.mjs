import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildTopologyReuseEvidenceMatrix } from "./experiments/topologyReuseStatisticalEvidence.mjs";
import { rowsToCsv } from "./experiments/reportUtils.mjs";
import {
  runDirectedPair,
  runOpportunityScan,
} from "./runExperiment12DirectedReuseValidation.mjs";

const DEFAULT_NATURAL_ROOT = resolve("reports/experiment12-topology-reuse-statistical-evidence");
const DEFAULT_OUTPUT_DIR = resolve("reports/experiment12-adaptive-structural-reuse-pilot");

function argValue(args, name, fallback = "") {
  const index = args.indexOf(name);
  return index === -1 ? fallback : (args[index + 1] ?? fallback);
}

function numberValue(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function mean(values) {
  const finite = values.map(Number).filter(Number.isFinite);
  return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : 0;
}

function round(value, digits = 6) {
  return Number.isFinite(Number(value)) ? Number(Number(value).toFixed(digits)) : 0;
}

function percent(value) {
  return `${round(value, 2).toFixed(2)}%`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function flattenResult(row) {
  return {
    pair_id: row.adaptive.pair_id,
    case_id: row.pair.case_id,
    window_id: row.pair.window_id,
    historical_slice_index: row.pair.historical_slice_index,
    current_slice_index: row.pair.current_slice_index,
    topology_jaccard: row.pair.topology_jaccard,
    affected_cached_path_ratio: row.pair.affected_cached_path_ratio,
    fixed_mode: row.fixed.reuse.selected_mode,
    adaptive_mode: row.adaptive.reuse.selected_mode,
    effective_similarity_threshold: row.adaptive.reuse.structural_similarity_threshold,
    relaxation_factor: row.adaptive.reuse.structural_relaxation_factor,
    risk_pressure: row.adaptive.reuse.structural_risk_pressure,
    estimated_error_increase_proxy: row.adaptive.reuse.structural_estimated_error_increase_proxy,
    allowed_error_tolerance: row.adaptive.reuse.structural_error_tolerance,
    weighted_work_reduction_percent: row.adaptive.effects.weighted_work_reduction_percent,
    score_recomputation_reduction_percent: row.adaptive.effects.score_recomputation_reduction_percent,
    marginal_evaluation_reduction_percent: row.adaptive.effects.marginal_evaluation_reduction_percent,
    telemetry_byte_reduction_percent: row.adaptive.effects.telemetry_byte_reduction_percent,
    active_link_coverage_delta: row.adaptive.effects.active_link_coverage_delta,
    weighted_information_delta: row.adaptive.effects.weighted_information_delta,
    quality_gates_passed: row.adaptive.quality_gates.passed,
    failed_quality_checks: row.adaptive.quality_gates.checks
      .filter((check) => check.available && check.passed === false)
      .map((check) => check.id)
      .join(" > "),
    hard_budget_violations: row.adaptive.reuse.hard_budget_violations,
  };
}

function selectRiskStratifiedPairs(rows, limit) {
  const candidates = rows
    .filter((row) =>
      row.profile_id === "telesat-1015-medium" &&
      row.adaptive_structural_cache_eligible === true &&
      row.fixed_structural_cache_eligible !== true
    )
    .sort((left, right) =>
      numberValue(left.adaptive_structural_estimated_error_increase_proxy) -
        numberValue(right.adaptive_structural_estimated_error_increase_proxy) ||
      String(left.case_id).localeCompare(String(right.case_id)) ||
      numberValue(left.current_slice_index) - numberValue(right.current_slice_index)
    );
  if (candidates.length <= limit) return candidates;
  const selected = [];
  const used = new Set();
  const usedWindows = new Set();
  const targets = Array.from({ length: limit }, (_, index) =>
    limit === 1 ? 0.5 : 0.1 + index * (0.8 / (limit - 1)),
  );
  for (const quantile of targets) {
    const targetIndex = Math.round((candidates.length - 1) * quantile);
    const ranked = candidates
      .map((candidate, index) => ({ candidate, index, distance: Math.abs(index - targetIndex) }))
      .filter(({ candidate }) => !used.has(`${candidate.case_id}|${candidate.current_slice_index}`))
      .sort((left, right) =>
        Number(usedWindows.has(left.candidate.window_id)) - Number(usedWindows.has(right.candidate.window_id)) ||
        left.distance - right.distance ||
        String(left.candidate.case_id).localeCompare(String(right.candidate.case_id)) ||
        numberValue(left.candidate.current_slice_index) - numberValue(right.candidate.current_slice_index)
      );
    const chosen = ranked[0]?.candidate;
    if (!chosen) continue;
    const key = `${chosen.case_id}|${chosen.current_slice_index}`;
    used.add(key);
    usedWindows.add(chosen.window_id);
    selected.push({
      ...chosen,
      selection_stage: "adaptive-risk-stratified-pilot",
      selection_risk_quantile: quantile,
    });
  }
  return selected;
}

function buildMarkdown({ rows, summary }) {
  const table = rows.map((row) =>
    `| ${row.window_id} | ${row.historical_slice_index}->${row.current_slice_index} | ${numberValue(row.topology_jaccard).toFixed(4)} | ${row.fixed_mode} | ${row.adaptive_mode} | ${numberValue(row.effective_similarity_threshold).toFixed(4)} | ${percent(row.weighted_work_reduction_percent)} | ${percent(row.telemetry_byte_reduction_percent)} | ${(numberValue(row.active_link_coverage_delta) * 100).toFixed(2)} pp | ${row.quality_gates_passed ? "通过" : `未通过：${row.failed_quality_checks}`} |`,
  ).join("\n");
  return `# 实验 12：自适应结构复用 Pilot

## 实验目标

验证因果自适应门槛能否准入固定结构门禁拒绝的 Telesat 窗口，同时保持严格遥测字节预算和规划阶段质量代理。

运行时只使用历史拓扑、预测漂移、OAM 压力、缓存年龄、复用置信度和规划压力，不使用第一阶段真值作出复用决策。配置的相对误差容忍度为 2%，但本 Pilot 只测量在线误差风险代理和规划质量门禁，不测量实际重构 MAE。

## 实验结果

| 窗口 | 时间片对 | Jaccard | 固定门禁 | 自适应门禁 | 有效阈值 | 规划工作量下降 | 遥测字节下降 | 覆盖率变化 | 质量门禁 |
|---|---:|---:|---|---|---:|---:|---:|---:|---|
${table || "| 无可用配对 | - | - | - | - | - | - | - | - | - |"}

- 固定门禁拒绝而自适应门禁准入的配对：${summary.evaluated_pairs}
- Telesat 扫描候选：固定 ${summary.fixed_eligible_slices}/${summary.scanned_telesat_slices}，自适应 ${summary.adaptive_eligible_slices}/${summary.scanned_telesat_slices}
- 自适应机制实际触发：${summary.adaptive_triggered_pairs}/${summary.evaluated_pairs}
- 平均有效相似度门槛：${summary.mean_effective_similarity_threshold.toFixed(4)}
- 全部配对平均规划工作量下降：${percent(summary.mean_weighted_work_reduction_percent)}
- 触发条件下规划工作量下降：${percent(summary.conditional_mean_weighted_work_reduction_percent)}
- 触发条件下遥测字节下降：${percent(summary.conditional_mean_telemetry_byte_reduction_percent)}
- 平均估计误差增长代理：${percent(summary.mean_estimated_error_increase_proxy * 100)}
- 全部配对质量门禁通过：${summary.quality_gate_pass_pairs}/${summary.evaluated_pairs}
- 触发配对质量门禁通过：${summary.triggered_quality_gate_pass_pairs}/${summary.adaptive_triggered_pairs}
- 硬预算违规：${summary.hard_budget_violations}

## 证据边界

这是规划阶段 Pilot。正向结果可以证明门槛扩展与规划代理下的开销下降，但尚不能证明 CPU、队列、电量或链路利用率的实际重构 MAE 保持在 2% 以内。仍需对准入窗口执行小规模 probe-report-OAM-completion 完整回放。
`;
}

function buildHtml({ rows, summary }) {
  const tableRows = rows.map((row) => `<tr><td>${escapeHtml(row.window_id)}</td><td>${row.historical_slice_index}->${row.current_slice_index}</td><td>${numberValue(row.topology_jaccard).toFixed(4)}</td><td>${escapeHtml(row.fixed_mode)}</td><td>${escapeHtml(row.adaptive_mode)}</td><td>${numberValue(row.effective_similarity_threshold).toFixed(4)}</td><td>${percent(row.weighted_work_reduction_percent)}</td><td>${percent(row.telemetry_byte_reduction_percent)}</td><td>${(numberValue(row.active_link_coverage_delta) * 100).toFixed(2)} pp</td><td class="${row.quality_gates_passed ? "pass" : "fail"}">${row.quality_gates_passed ? "通过" : `未通过：${escapeHtml(row.failed_quality_checks)}`}</td></tr>`).join("");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>自适应拓扑复用 Pilot</title><style>*{box-sizing:border-box}body{margin:0;background:#f5f7fa;color:#17202a;font-family:system-ui,"Microsoft YaHei",sans-serif}main{max-width:1180px;margin:auto;padding:28px}header,section{background:#fff;border:1px solid #dfe4ea;border-radius:6px;padding:22px;margin-bottom:18px}header{background:#17202a;color:#fff}.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}.metrics article{border-left:4px solid #2471a3;background:#eef5fa;padding:14px}table{width:100%;border-collapse:collapse;font-size:14px}th,td{padding:10px;border-bottom:1px solid #e5e9ef;text-align:left}.pass{color:#196f3d}.fail{color:#a93226}.warning{border-left:4px solid #b9770e}@media(max-width:700px){main{padding:14px}section{overflow:auto}}</style></head><body><main><header><h1>自适应拓扑复用低成本 Pilot</h1><p>固定门槛拒绝、动态门槛接受的 Telesat 配对窗口</p></header><section class="metrics"><article><strong>触发</strong><p>${summary.adaptive_triggered_pairs}/${summary.evaluated_pairs}</p></article><article><strong>触发时规划下降</strong><p>${percent(summary.conditional_mean_weighted_work_reduction_percent)}</p></article><article><strong>触发时字节下降</strong><p>${percent(summary.conditional_mean_telemetry_byte_reduction_percent)}</p></article><article><strong>误差代理</strong><p>${percent(summary.mean_estimated_error_increase_proxy * 100)}</p></article></section><section><table><thead><tr><th>窗口</th><th>时间片</th><th>J</th><th>固定</th><th>自适应</th><th>动态门槛</th><th>规划下降</th><th>字节下降</th><th>覆盖变化</th><th>门禁</th></tr></thead><tbody>${tableRows}</tbody></table></section><section class="warning"><strong>证据边界</strong><p>本页只记录规划阶段和在线质量代理，不把 2% 容忍度冒充实际重构 MAE。下一步只需对这些已准入窗口做小规模完整遥测回放。</p></section></main></body></html>`;
}

async function main() {
  const args = process.argv.slice(2);
  const naturalRoot = resolve(argValue(args, "--natural-root", DEFAULT_NATURAL_ROOT));
  const outputDir = resolve(argValue(args, "--out", DEFAULT_OUTPUT_DIR));
  const pairLimit = Math.max(1, Math.floor(numberValue(argValue(args, "--pair-limit", "3"), 3)));
  const repetitions = Math.max(1, Math.floor(numberValue(argValue(args, "--wall-repetitions", "1"), 1)));
  const errorTolerance = Math.max(0, Math.min(0.1, numberValue(argValue(args, "--error-tolerance", "0.02"), 0.02)));
  await mkdir(outputDir, { recursive: true });
  const scan = await runOpportunityScan({
    naturalRoot,
    outputDir,
    scenarios: buildTopologyReuseEvidenceMatrix(),
  });
  const adaptiveCandidates = scan.allRows.filter((row) =>
    row.profile_id === "telesat-1015-medium" &&
    row.adaptive_structural_cache_eligible === true
  );
  const fixedCandidates = scan.allRows.filter((row) =>
    row.profile_id === "telesat-1015-medium" &&
    row.fixed_structural_cache_eligible === true
  );
  const pairs = selectRiskStratifiedPairs(scan.allRows, pairLimit);
  if (pairs.length === 0) throw new Error("No fixed-ineligible/adaptive-eligible Telesat pairs were found");

  const results = [];
  for (const pair of pairs) {
    const fixed = await runDirectedPair({
      naturalRoot,
      outputDir: join(outputDir, "fixed"),
      pair,
      repetitions,
      resume: false,
      adaptiveStructuralReuse: false,
    });
    const adaptive = await runDirectedPair({
      naturalRoot,
      outputDir: join(outputDir, "adaptive"),
      pair,
      repetitions,
      resume: false,
      adaptiveStructuralReuse: true,
      structuralReuseErrorTolerance: errorTolerance,
    });
    results.push({ pair, fixed, adaptive });
  }
  const rows = results.map(flattenResult);
  const triggeredRows = rows.filter((row) => ["reuse", "repair"].includes(row.adaptive_mode));
  const summary = {
    scanned_telesat_slices: scan.allRows.filter((row) => row.profile_id === "telesat-1015-medium").length,
    fixed_eligible_slices: fixedCandidates.length,
    adaptive_eligible_slices: adaptiveCandidates.length,
    newly_admitted_slices: adaptiveCandidates.filter((row) => row.fixed_structural_cache_eligible !== true).length,
    evaluated_pairs: rows.length,
    adaptive_triggered_pairs: rows.filter((row) => ["reuse", "repair"].includes(row.adaptive_mode)).length,
    fixed_triggered_pairs: rows.filter((row) => ["reuse", "repair"].includes(row.fixed_mode)).length,
    quality_gate_pass_pairs: rows.filter((row) => row.quality_gates_passed).length,
    mean_effective_similarity_threshold: round(mean(rows.map((row) => row.effective_similarity_threshold))),
    mean_weighted_work_reduction_percent: round(mean(rows.map((row) => row.weighted_work_reduction_percent))),
    mean_telemetry_byte_reduction_percent: round(mean(rows.map((row) => row.telemetry_byte_reduction_percent))),
    conditional_mean_weighted_work_reduction_percent: round(mean(
      triggeredRows.map((row) => row.weighted_work_reduction_percent),
    )),
    conditional_mean_telemetry_byte_reduction_percent: round(mean(
      triggeredRows.map((row) => row.telemetry_byte_reduction_percent),
    )),
    triggered_quality_gate_pass_pairs: triggeredRows.filter((row) => row.quality_gates_passed).length,
    mean_estimated_error_increase_proxy: round(mean(rows.map((row) => row.estimated_error_increase_proxy))),
    hard_budget_violations: rows.reduce((sum, row) => sum + numberValue(row.hard_budget_violations), 0),
  };
  const artifact = {
    schema_version: "experiment12-adaptive-structural-reuse-pilot-v1",
    generated_at: new Date().toISOString(),
    natural_root: naturalRoot,
    output_dir: outputDir,
    configured_relative_error_tolerance: errorTolerance,
    observability_boundary: "causal planner inputs only; Stage-1 truth is evaluation-only",
    evidence_boundary: "planning-only; actual reconstruction MAE not measured",
    summary,
    rows,
    results,
  };
  await Promise.all([
    writeJson(join(outputDir, "adaptive-structural-reuse-pilot.json"), artifact),
    writeFile(join(outputDir, "adaptive-structural-reuse-pilot.csv"), rowsToCsv(rows), "utf8"),
    writeFile(join(outputDir, "ADAPTIVE_STRUCTURAL_REUSE_PILOT.md"), buildMarkdown({ rows, summary }), "utf8"),
    writeFile(join(outputDir, "index.html"), buildHtml({ rows, summary }), "utf8"),
  ]);
  console.log(JSON.stringify({ status: "complete", output_dir: outputDir, summary }, null, 2));
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
