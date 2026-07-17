import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { parseCsv } from "./experiments/reportUtils.mjs";

const execFileAsync = promisify(execFile);
const outputDir = resolve("reports/_scratch/tmp-scale-adaptive-budget-pipeline-test");
if (!outputDir.endsWith("tmp-scale-adaptive-budget-pipeline-test")) {
  throw new Error(`Unexpected test path: ${outputDir}`);
}
if (existsSync(outputDir)) rmSync(outputDir, { recursive: true, force: true });

await execFileAsync(process.execPath, [
  "stage2-int/tools/int-mc-path-selector.mjs",
  "--input", resolve("exports/tmp-highload-check"),
  "--stage2", resolve("stage2-int/outputs/tmp-highload-check"),
  "--out", outputDir,
  "--algorithm", "int-mc-scale-budget-test",
  "--candidate-algorithm", "path-balance",
  "--sampling-rate", "0.25",
  "--target-active-link-sampling-rate", "0.25",
  "--min-paths-per-slice", "1",
  "--max-paths-per-slice", "12",
  "--scale-adaptive-total-budget", "true",
  "--scale-budget-headroom-ratio", "0.1",
  "--scale-budget-path-headroom-ratio", "0.25",
], { cwd: process.cwd(), maxBuffer: 32 * 1024 * 1024 });

const summaryRows = parseCsv(await readFile(
  resolve(outputDir, "probe-summary-int-mc-scale-budget-test.csv"),
  "utf8",
));
const selectedRows = parseCsv(await readFile(
  resolve(outputDir, "probe-paths-int-mc-scale-budget-test.csv"),
  "utf8",
));
const report = JSON.parse(await readFile(
  resolve(outputDir, "probe-coverage-int-mc-scale-budget-test.json"),
  "utf8",
));

assert.ok(summaryRows.length > 0);
assert.equal(report.parameters.scale_adaptive_total_budget_enabled, true);
assert.equal(report.parameters.scale_budget_headroom_ratio, 0.1);
assert.equal(report.parameters.scale_budget_path_headroom_ratio, 0.25);

for (const row of summaryRows) {
  assert.equal(row.scale_budget_enabled, "true");
  assert.ok(Number(row.scale_budget_target_node_count) > 0);
  assert.ok(Number(row.scale_budget_target_active_link_count) > 0);
  assert.ok(Number(row.scale_budget_bytes) > 0);
  assert.ok(Number(row.scale_budget_safe_path_cap) > 0);
  assert.ok(Number(row.selected_paths) <= Number(row.scale_budget_safe_path_cap));
  assert.match(row.scale_budget_source, /coverage-derived|explicit-hard-cap/);
}

for (const row of selectedRows) {
  assert.equal(row.scale_budget_enabled, "true");
  assert.ok(Number(row.scale_budget_bytes) > 0);
  assert.ok(Number(row.scale_budget_safe_path_cap) > 0);
}

const runnerOutputDir = resolve(outputDir, "runner");
await execFileAsync(process.execPath, [
  "stage2-int/tools/probe-int-runner.mjs",
  "--input", resolve("exports/tmp-highload-check"),
  "--stage2", outputDir,
  "--out", runnerOutputDir,
  "--algorithm", "int-mc-scale-budget-test",
], { cwd: process.cwd(), maxBuffer: 64 * 1024 * 1024 });

const runReport = JSON.parse(await readFile(
  resolve(runnerOutputDir, "probe-int-run-report-int-mc-scale-budget-test.json"),
  "utf8",
));
assert.equal(runReport.planning.telemetry_byte_budget_enabled, true);
assert.equal(runReport.planning.telemetry_byte_budget_source, "scale-adaptive-path-plan");
assert.equal(runReport.planning.telemetry_byte_budget_cap_violations, 0);
assert.equal(runReport.planning.scale_adaptive_path_plan_budget_slices, summaryRows.length);
for (const row of runReport.planning.telemetry_byte_budget_by_slice) {
  assert.ok(Number(row.actual_bytes) <= Number(row.budget_bytes));
}

const frozenBudgetPath = resolve(outputDir, "frozen-budget-schedule.csv");
const frozenBudgetRows = summaryRows.map((row, index) => ({
  slice_index: row.slice_index,
  scale_budget_bytes: 20_000 + index * 137,
}));
await writeFile(
  frozenBudgetPath,
  `slice_index,scale_budget_bytes\n${frozenBudgetRows
    .map((row) => `${row.slice_index},${row.scale_budget_bytes}`)
    .join("\n")}\n`,
  "utf8",
);

const frozenOutputDir = resolve(outputDir, "frozen-selector");
await execFileAsync(process.execPath, [
  "stage2-int/tools/int-mc-path-selector.mjs",
  "--input", resolve("exports/tmp-highload-check"),
  "--stage2", resolve("stage2-int/outputs/tmp-highload-check"),
  "--out", frozenOutputDir,
  "--algorithm", "int-mc-frozen-budget-test",
  "--candidate-algorithm", "path-balance",
  "--sampling-rate", "0.25",
  "--target-active-link-sampling-rate", "0.25",
  "--min-paths-per-slice", "1",
  "--max-paths-per-slice", "12",
  "--scale-adaptive-total-budget", "true",
  "--scale-budget-reference-csv", frozenBudgetPath,
], { cwd: process.cwd(), maxBuffer: 32 * 1024 * 1024 });

const frozenSummaryRows = parseCsv(await readFile(
  resolve(frozenOutputDir, "probe-summary-int-mc-frozen-budget-test.csv"),
  "utf8",
));
const frozenBudgetBySlice = new Map(frozenBudgetRows.map((row) => [String(row.slice_index), row.scale_budget_bytes]));
for (const row of frozenSummaryRows) {
  assert.equal(Number(row.scale_budget_bytes), frozenBudgetBySlice.get(String(row.slice_index)));
  assert.equal(row.scale_budget_source, "reference-schedule-hard-cap");
}

const experimentRunnerSource = await readFile(
  resolve("scripts/runExperiment2IntMcEnhancementComparison.mjs"),
  "utf8",
);
assert.match(
  experimentRunnerSource,
  /scaleBudgetReferenceCsvPath/,
  "experiment2 comparison runner should accept a frozen scale-budget reference",
);
assert.match(
  experimentRunnerSource,
  /--scale-budget-reference-csv/,
  "experiment2 comparison runner should forward the frozen budget schedule to the enhanced selector",
);
assert.match(
  experimentRunnerSource,
  /planner:\s*"legacy-int-mc"[\s\S]*?adaptiveReuse:\s*false/,
  "experiment2 native INT-MC should fresh-plan every slice instead of shrinking a reused candidate pool",
);
assert.match(
  experimentRunnerSource,
  /planner:\s*"topology-versioned-risk-int"[\s\S]*?adaptiveReuse:\s*true[\s\S]*?adaptiveStructuralReuse:\s*true/,
  "experiment2 enhanced INT-MC should activate the unified topology-versioned planner",
);
assert.match(
  experimentRunnerSource,
  /原生与增强流程均已重跑/,
  "experiment2 report should state that both variants were rerun",
);
assert.match(
  experimentRunnerSource,
  /逐时间片复用同一份遥测字节硬预算/,
  "experiment2 report should explain the equal-budget comparison boundary",
);
assert.doesNotMatch(
  experimentRunnerSource,
  /增强前基线数据保持不变/,
  "experiment2 report should not claim that the native baseline was reused unchanged",
);

console.log("Scale-adaptive budget pipeline tests passed.");
