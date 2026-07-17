import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === "\"") {
      if (quoted && next === "\"") {
        cell += "\"";
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell);
      if (row.some((value) => value.length > 0)) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    if (row.some((value) => value.length > 0)) rows.push(row);
  }
  if (rows.length === 0) return [];
  const headers = rows[0];
  return rows.slice(1).map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
}

function runExperiment(outputDir) {
  const result = spawnSync(
    process.execPath,
    [
      "scripts/runExperiment2IntMcEnhancementComparison.mjs",
      "--profiles",
      "iridium-next-small",
      "--out",
      outputDir,
      "--int-mc-max-paths-per-slice",
      "4",
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
    },
  );
  if (result.status !== 0) {
    throw new Error(`experiment2 report run failed\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  }
}

function numberValue(value, fallback = NaN) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function assertEveryTextVisible(text, labels, targetName) {
  labels.forEach((label) => {
    assert.ok(text.includes(label), `${targetName} should expose ${label}`);
  });
}

function assertEveryTextHidden(text, labels, targetName) {
  labels.forEach((label) => {
    assert.ok(!text.includes(label), `${targetName} should not expose ${label}`);
  });
}

const outputDir = resolve("reports/tmp-experiment2-report-fields-test");
if (!outputDir.includes("tmp-experiment2-report-fields-test")) {
  throw new Error(`refusing to clean unexpected path: ${outputDir}`);
}
if (existsSync(outputDir)) rmSync(outputDir, { recursive: true, force: true });
runExperiment(outputDir);

const csvPath = resolve(outputDir, "experiment2-int-mc-enhancement-comparison.csv");
const htmlPath = resolve(outputDir, "experiment2-int-mc-enhancement-comparison.html");
const mdPath = resolve(outputDir, "experiment2-int-mc-enhancement-comparison.md");
const rows = parseCsv(await readFile(csvPath, "utf8"));
const html = await readFile(htmlPath, "utf8");
const md = await readFile(mdPath, "utf8");
const enhanced = rows.find((row) => row.version === "after");
const baseline = rows.find((row) => row.version === "before");

assert.ok(enhanced, "comparison CSV should include enhanced row");
assert.ok(baseline, "comparison CSV should include baseline row");
[
  "adaptive_probe_budget_enabled_slices",
  "adaptive_probe_budget_throttled_slices",
  "adaptive_probe_budget_escalated_slices",
  "mean_adaptive_probe_budget_scale",
  "mean_adaptive_probe_budget_effective_max_paths_per_slice",
  "adaptive_metadata_compact_paths",
  "adaptive_path_only_observation_paths",
  "adaptive_all_adjacent_observation_paths",
  "runtime_metadata_bytes_saved_by_profile",
  "runtime_total_metadata_bytes",
  "runtime_total_report_bytes",
  "oam_mandatory_coverage_selected_paths",
  "oam_quality_feedback_retest_targets",
  "local_adaptive_high_risk_paths",
  "local_adaptive_watchlist_paths",
  "reuse_duplicate_suppressed_paths",
  "oam_duplicate_target_only_suppressed_paths",
  "runtime_target_aware_probe_paths",
  "runtime_target_metadata_hop_records",
  "runtime_transit_metadata_hop_records",
  "runtime_target_neighborhood_adjacent_records",
  "runtime_target_aware_suppressed_adjacent_scans",
  "runtime_target_aware_metadata_bytes_saved",
  "unified_planner_enabled",
  "unified_reuse_slices",
  "unified_repair_slices",
  "unified_fresh_slices",
  "unified_compact_actions",
  "unified_selective_actions",
  "unified_forward_only_hops",
  "unified_hard_budget_violations",
  "link_orbit_periodic_prior_values",
  "node_orbit_periodic_prior_values",
  "business_hotspot_migration_applied_link_samples",
  "link_business_hotspot_migration_prior_values",
  "orbit_graph_regularized_link_samples",
  "metric_tensor_coupled_link_samples",
  "node_state_coupled_samples",
  "joint_state_coupling_link_samples",
  "state_tensor_joint_completed_link_samples",
  "mean_metric_tensor_coupling_pressure",
  "mean_node_state_coupling_pressure",
  "mean_joint_state_coupling_pressure",
  "mean_state_tensor_joint_completion_pressure",
].forEach((field) => assert.ok(Object.hasOwn(enhanced, field), `comparison CSV missing ${field}`));

assert.equal(String(baseline.joint_state_coupling_enabled), "false", "baseline should keep joint coupling disabled");
assert.equal(String(enhanced.joint_state_coupling_enabled), "true", "enhanced pass should enable joint coupling");
assert.equal(String(baseline.state_tensor_joint_completion_enabled), "false", "baseline should keep state tensor joint completion disabled");
assert.equal(String(enhanced.state_tensor_joint_completion_enabled), "true", "enhanced pass should enable state tensor joint completion");
assert.equal(String(baseline.metric_tensor_coupling_enabled), "false", "baseline should keep metric tensor coupling disabled");
assert.equal(String(enhanced.metric_tensor_coupling_enabled), "true", "enhanced pass should enable metric tensor coupling");
assert.equal(String(baseline.node_state_coupling_enabled), "false", "baseline should keep node state coupling disabled");
assert.equal(String(enhanced.node_state_coupling_enabled), "true", "enhanced pass should enable node state coupling");
assert.equal(String(baseline.orbit_periodic_prior_enabled), "false", "baseline should keep orbit periodic prior disabled");
assert.equal(String(enhanced.orbit_periodic_prior_enabled), "true", "enhanced pass should enable orbit periodic prior");
assert.equal(String(baseline.oam_quality_feedback_enabled), "false", "baseline should keep OAM quality feedback disabled");
assert.equal(String(enhanced.oam_quality_feedback_enabled), "true", "enhanced pass should enable OAM quality feedback");
assert.ok(Number.isFinite(numberValue(baseline.link_utilization_mae)), "baseline link utilization MAE should be populated");
assert.ok(Number.isFinite(numberValue(enhanced.link_utilization_mae)), "enhanced link utilization MAE should be populated");
assert.ok(
  numberValue(enhanced.runtime_target_aware_probe_paths) > 0 ||
    numberValue(enhanced.unified_compact_actions) + numberValue(enhanced.unified_selective_actions) > 0,
  "enhanced pass should execute legacy target-aware probes or unified compact/selective metadata actions",
);
assert.ok(
  numberValue(enhanced.oam_mandatory_coverage_selected_paths) > 0,
  "enhanced metadata actions should cover mandatory OAM targets",
);
assert.equal(numberValue(enhanced.unified_hard_budget_violations), 0, "unified planner must respect the hard byte budget");
assert.equal(numberValue(baseline.runtime_target_aware_probe_paths, 0), 0, "baseline pass should not execute target-aware OAM probes");

const visibleLabels = [
  "实验2：INT-MC 增强前后对比",
  "LEO-INT-MC 增强机制明细",
  "节点/链路重构指标图表",
  "CPU MAE（越低越好）",
  "队列 MAE（越低越好）",
  "电量 MAE（越低越好）",
  "节点模式准确率（越高越好）",
  "链路状态准确率（越高越好）",
  "链路利用率 MAE（越低越好）",
  "预算调整片数",
  "平均预算缩放因子",
  "平均有效每片路径上限",
  "元数据策略路径数",
  "平均每跳元数据字节",
  "元数据节省",
  "OAM 强制覆盖路径数",
  "OAM 建议重测目标",
  "局部风险路径数",
  "复用重复抑制路径数",
  "轨道周期先验样本",
  "业务热点迁移样本",
  "轨道图正则链路样本",
  "指标/状态耦合样本",
  "平均耦合压力",
];

const hiddenDetailedLabels = [
  "自适应预算启用片数",
  "自适应预算降采样片数",
  "自适应预算升采样片数",
  "路径上限降低片数",
  "路径上限提高片数",
  "自适应元数据配置启用片数",
  "压缩元数据跳记录",
  "运行期元数据总字节",
  "运行期报告总字节",
  "运行期探测包基础字节",
  "运行期 INT 总字节",
  "星间遥测链路总字节",
  "平均星间遥测链路字节",
  "OAM 低置信观测链路",
  "OAM 冲突观测节点",
  "业务迁移候选链路",
  "平均业务迁移分数",
  "平均业务迁移质量",
  "平均轨道图正则强度",
  "平均指标张量耦合压力",
  "平均节点状态耦合压力",
  "平均联合状态耦合压力",
  "平均状态张量补全压力",
  "runtime_total_metadata_bytes",
  "runtime_total_report_bytes",
  "metric_tensor_coupling_enabled",
  "state_tensor_joint_completion_enabled",
  "Active link direct coverage",
  "Enhanced LEO-INT-MC mechanisms",
];

assertEveryTextVisible(html, visibleLabels, "HTML report");
assertEveryTextVisible(md, visibleLabels, "Markdown report");
assertEveryTextHidden(html, hiddenDetailedLabels, "HTML report");
assertEveryTextHidden(md, hiddenDetailedLabels, "Markdown report");

console.log(JSON.stringify({
  ok: true,
  outputDir,
  mechanismColumnCount: visibleLabels.length - 2,
  enhancedAdaptiveSlices: enhanced.adaptive_probe_budget_enabled_slices,
  enhancedRuntimeMetadataBytesSaved: enhanced.runtime_metadata_bytes_saved_by_profile,
  enhancedOamQualityFeedbackRetests: enhanced.oam_quality_feedback_retest_targets,
}, null, 2));
