import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runIntMcPass } from "./experiments/intMcExperimentCore.mjs";

const outputDir = resolve("reports/tmp-equal-budget-pipeline-test");
if (!outputDir.endsWith("tmp-equal-budget-pipeline-test")) throw new Error(`Unexpected test path: ${outputDir}`);
if (existsSync(outputDir)) rmSync(outputDir, { recursive: true, force: true });

const run = await runIntMcPass({
  label: "equal-budget-pipeline-test",
  truthDir: resolve("exports/tmp-highload-check"),
  candidatePathsPath: resolve("stage2-int/outputs/tmp-highload-check/probe-paths-path-balance.csv"),
  stage2Dir: resolve(outputDir, "stage2"),
  groundDir: resolve(outputDir, "ground-oam"),
  samplingRate: 0.1,
  targetActiveLinkSamplingRate: 0.1,
  rank: 2,
  windowSize: 4,
  warmupSlices: 1,
  iterations: 1,
  maxPathsPerSlice: 2,
  telemetryByteBudgetPerNodeSlice: 500,
  telemetryByteBudgetPadToCap: true,
  writeEstimateGraph: false,
});

const report = JSON.parse(await readFile(run.artifacts.run_report_json, "utf8"));
assert.equal(report.planning.telemetry_byte_budget_enabled, true);
assert.equal(report.planning.telemetry_byte_budget_per_node_slice, 500);
assert.equal(report.planning.telemetry_byte_budget_pad_to_cap, true);
assert.ok(report.planning.telemetry_byte_budget_padding_bytes > 0);
assert.ok(run.metrics.telemetry_padding_bytes_per_node_slice > 0);
assert.equal(report.planning.telemetry_byte_budget_cap_violations, 0);
assert.equal(run.metrics.telemetry_byte_budget_cap_violations, 0);
assert.equal(run.metrics.telemetry_byte_budget_per_node_slice, 500);
assert.equal(existsSync(resolve(outputDir, "ground-oam/ground-oam-estimate-graph.json")), false);

console.log("Equal-budget pipeline propagation tests passed.");
