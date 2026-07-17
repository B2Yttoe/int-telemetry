import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { parseCsv } from "./experiments/reportUtils.mjs";

const execFileAsync = promisify(execFile);
const inputDir = resolve("exports/tmp-highload-check");
const stage2Dir = resolve("stage2-int/outputs/tmp-highload-check");
const outputDir = resolve("reports/tmp-probe-byte-budget-test");
if (!outputDir.endsWith("tmp-probe-byte-budget-test")) throw new Error(`Unexpected test path: ${outputDir}`);
if (existsSync(outputDir)) rmSync(outputDir, { recursive: true, force: true });

await execFileAsync(process.execPath, [
  "stage2-int/tools/probe-int-runner.mjs",
  "--input", inputDir,
  "--stage2", stage2Dir,
  "--out", outputDir,
  "--algorithm", "path-balance",
  "--telemetry-byte-budget-per-node-slice", "500",
  "--telemetry-byte-budget-pad-to-cap", "true",
], { cwd: process.cwd(), maxBuffer: 16 * 1024 * 1024 });

const runReport = JSON.parse(await readFile(resolve(outputDir, "probe-int-run-report-path-balance.json"), "utf8"));
const overhead = parseCsv(await readFile(resolve(outputDir, "probe-int-overhead-by-slice-path-balance.csv"), "utf8"));
const decisions = parseCsv(await readFile(resolve(outputDir, "probe-int-byte-budget-path-balance.csv"), "utf8"));
const admittedPaths = parseCsv(await readFile(resolve(outputDir, "probe-int-admitted-paths-path-balance.csv"), "utf8"));

assert.equal(runReport.planning.telemetry_byte_budget_enabled, true);
assert.equal(runReport.planning.telemetry_byte_budget_per_node_slice, 500);
assert.equal(runReport.planning.telemetry_byte_budget_cap_violations, 0);
assert.ok(runReport.planning.telemetry_byte_budget_padding_bytes > 0);
assert.ok(runReport.planning.telemetry_byte_budget_rejected_probe_paths > 0);
assert.ok(runReport.planning.probe_paths < runReport.planning.planned_probe_paths);
assert.equal(admittedPaths.length, runReport.planning.probe_paths);
assert.ok(decisions.some((row) => row.decision.startsWith("rejected")));

const budgetBySlice = new Map(runReport.planning.telemetry_byte_budget_by_slice.map((row) => [
  Number(row.slice_index),
  Number(row.budget_bytes),
]));
for (const row of overhead) {
  const budget = budgetBySlice.get(Number(row.slice_index));
  assert.ok(Number(row.total_telemetry_generated_bytes) <= budget, `slice ${row.slice_index} exceeded its hard byte budget`);
  const budgetRow = runReport.planning.telemetry_byte_budget_by_slice.find((candidate) => Number(candidate.slice_index) === Number(row.slice_index));
  if (Number(budgetRow.admitted_probes) > 0) {
    assert.equal(Number(row.total_telemetry_generated_bytes), budget, `slice ${row.slice_index} was not padded to its hard cap`);
  }
}

console.log("Probe telemetry byte budget policy tests passed.");
