import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  SAMPLING_RATES,
  buildExperiment6Matrix,
  markPareto,
  runExperiment6,
} from "./runExperiment6SamplingSensitivity.mjs";
import { parseCsv } from "./experiments/reportUtils.mjs";

assert.deepEqual(SAMPLING_RATES, [0.05, 0.10, 0.15, 0.20, 0.25, 0.30, 0.40]);
const matrix = buildExperiment6Matrix();
assert.equal(matrix.length, 42);
assert.equal(new Set(matrix.map((row) => `${row.profile_id}|${row.rate}|${row.method_id}`)).size, 42);
assert.deepEqual([...new Set(matrix.map((row) => row.rate))], SAMPLING_RATES);

const pareto = markPareto([
  { id: "a", cost: 1, error: 3 },
  { id: "b", cost: 2, error: 2 },
  { id: "c", cost: 3, error: 4 },
  { id: "d", cost: 4, error: 1 },
]);
assert.equal(pareto.find((row) => row.id === "a").pareto, true);
assert.equal(pareto.find((row) => row.id === "b").pareto, true);
assert.equal(pareto.find((row) => row.id === "c").pareto, false);
assert.equal(pareto.find((row) => row.id === "d").pareto, true);

const outputDir = resolve("reports/tmp-experiment6-sampling-smoke");
if (!outputDir.endsWith("tmp-experiment6-sampling-smoke")) {
  throw new Error(`refusing to clean unexpected test directory: ${outputDir}`);
}
if (existsSync(outputDir)) rmSync(outputDir, { recursive: true, force: true });
const rootReportPath = resolve(outputDir, "EXPERIMENT_6_SAMPLING_SENSITIVITY_REPORT.md");
const result = await runExperiment6({
  profiles: [{
    id: "fixture-small",
    short_label: "Fixture 64",
    scale: "test",
    node_count: 64,
    truthDir: resolve("exports/tmp-highload-check"),
    candidatePathsPath: resolve("stage2-int/outputs/tmp-highload-check/probe-paths-path-balance.csv"),
  }],
  rates: [0.10, 0.25],
  outputDir,
  rootReportPath,
  parameters: {
    rank: 2,
    windowSize: 6,
    warmupSlices: 2,
    iterations: 1,
    downlinkBudgetBytes: 1_000_000_000,
    maxPathsPerSlice: 2,
    observabilityMode: "oam-only",
    feedbackLagSlices: 1,
  },
  resume: true,
  formal: false,
  pruneBulkArtifacts: false,
});
assert.equal(result.summaryRows.length, 4);
assert.equal(result.bySliceRows.length, 96);
assert.equal(new Set(result.runManifests.map((row) => row.pass1_fingerprint)).size, 2);
assert.ok(result.summaryRows.every((row) => row.slice_count === 24));
assert.ok(result.summaryRows.every((row) => row.feedback_lag_slices === 1));
assert.ok(result.summaryRows.every((row) => row.causal_feedback_violations === 0));
assert.ok(result.summaryRows.some((row) => row.pareto));

const expectedFiles = [
  rootReportPath,
  resolve(outputDir, "experiment6-sampling-summary.csv"),
  resolve(outputDir, "experiment6-sampling-by-slice.csv"),
  resolve(outputDir, "experiment6-pareto-front.csv"),
  resolve(outputDir, "experiment6-sampling-summary.json"),
  resolve(outputDir, "experiment6-sampling-report.html"),
  resolve(outputDir, "experiment6-manifest.json"),
];
assert.ok(expectedFiles.every(existsSync));
assert.equal(parseCsv(await readFile(expectedFiles[1], "utf8")).length, 4);
const markdown = await readFile(rootReportPath, "utf8");
assert.match(markdown, /实验做了什么/);
assert.match(markdown, /证明了什么/);
assert.match(markdown, /不能证明什么/);
const html = await readFile(expectedFiles[5], "utf8");
assert.match(html, /<meta charset="UTF-8">/);
assert.match(html, /实验 6：采样率敏感性实验/);
assert.ok(!html.includes("�"));

console.log(JSON.stringify({
  ok: true,
  formal_matrix_rows: matrix.length,
  smoke_summary_rows: result.summaryRows.length,
  smoke_by_slice_rows: result.bySliceRows.length,
  unique_pass1_fingerprints: new Set(result.runManifests.map((row) => row.pass1_fingerprint)).size,
}, null, 2));
