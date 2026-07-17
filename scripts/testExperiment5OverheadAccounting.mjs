import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  decomposeOverhead,
  runExperiment5,
} from "./runExperiment5OverheadDecomposition.mjs";
import { parseCsv } from "./experiments/reportUtils.mjs";

const parts = decomposeOverhead({
  metrics: {
    total_telemetry_generated_bytes: 900,
    total_probe_packet_base_bytes: 100,
    total_metadata_bytes: 300,
    total_report_bytes: 450,
    total_isl_telemetry_link_bytes: 1500,
    nodes_per_slice: 5,
    slice_count: 2,
  },
  effectiveReconstructedStateCount: 20,
});
assert.equal(parts.probe_base_bytes, 100);
assert.equal(parts.metadata_bytes, 300);
assert.equal(parts.report_bytes, 450);
assert.equal(parts.other_bytes, 50);
assert.equal(
  parts.probe_base_bytes + parts.metadata_bytes + parts.report_bytes + parts.other_bytes,
  parts.total_generated_bytes,
);
assert.equal(parts.isl_carried_bytes, 1500);
assert.equal(parts.bytes_per_node_slice, 90);
assert.equal(parts.bytes_per_effective_state, 45);

const outputDir = resolve("reports/tmp-experiment5-overhead-smoke");
if (!outputDir.endsWith("tmp-experiment5-overhead-smoke")) {
  throw new Error(`refusing to clean unexpected test directory: ${outputDir}`);
}
if (existsSync(outputDir)) rmSync(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });
const evaluationPath = resolve(outputDir, "evaluation.json");
await writeFile(evaluationPath, JSON.stringify({
  reconstruction: { link_samples: 30, active_link_samples: 20, active_link_completion_coverage: 1 },
  node_reconstruction: { node_samples: 10, node_completion_coverage: 1 },
}), "utf8");

const stageNames = [
  "contact_prediction",
  "path_selection",
  "reporting_plan",
  "probe_execution",
  "ground_oam",
  "matrix_completion",
];
function timings(scale) {
  return Object.fromEntries(stageNames.map((stage, index) => [stage, {
    label: stage,
    wall_time_ms: (index + 1) * scale,
    parent_user_cpu_ms: index,
    parent_system_cpu_ms: index / 2,
    exit_code: 0,
  }]));
}
function methodRun(multiplier) {
  return {
    metrics: {
      slice_count: 2,
      nodes_per_slice: 5,
      total_telemetry_generated_bytes: 900 * multiplier,
      total_probe_packet_base_bytes: 100 * multiplier,
      total_metadata_bytes: 300 * multiplier,
      total_report_bytes: 450 * multiplier,
      total_isl_telemetry_link_bytes: 1500 * multiplier,
      total_telemetry_energy_j: 2 * multiplier,
      hop_records: 12 * multiplier,
      report_count: 3 * multiplier,
      selected_paths: 3 * multiplier,
      reused_slice_plans: multiplier === 1 ? 0 : 1,
      fresh_slice_plans: multiplier === 1 ? 2 : 1,
      estimated_full_replanning_avoided: multiplier === 1 ? 0 : 1,
      planning_local_repair_slices: multiplier === 1 ? 0 : 1,
      cpu_mae: 1 / multiplier,
      queue_depth_mae: 2 / multiplier,
      energy_percent_mae: 3 / multiplier,
      link_utilization_mae: 4 / multiplier,
      node_mode_accuracy: 0.9,
      link_status_accuracy: 0.8,
    },
    timings: timings(multiplier),
    artifacts: { evaluation_json: evaluationPath },
  };
}

const rootReportPath = resolve(outputDir, "EXPERIMENT_5_OVERHEAD_REPORT.md");
const result = await runExperiment5({
  runs: [{
    profile: { id: "fixture-small", short_label: "Fixture 5", scale: "test", node_count: 5 },
    before: methodRun(1),
    after: methodRun(2),
    pass1Fingerprint: "fixture-pass1",
  }],
  outputDir,
  rootReportPath,
  formal: false,
});
assert.equal(result.summaryRows.length, 2);
assert.equal(result.timingRows.length, 12);
assert.ok(result.timingRows.every((row) => row.wall_time_ms >= 0));
assert.ok(result.summaryRows.every((row) =>
  row.probe_base_bytes + row.metadata_bytes + row.report_bytes + row.other_bytes === row.total_generated_bytes
));

const expectedFiles = [
  rootReportPath,
  resolve(outputDir, "experiment5-overhead-summary.csv"),
  resolve(outputDir, "experiment5-stage-timings.csv"),
  resolve(outputDir, "experiment5-overhead-summary.json"),
  resolve(outputDir, "experiment5-overhead-report.html"),
  resolve(outputDir, "experiment5-manifest.json"),
];
assert.ok(expectedFiles.every(existsSync));
assert.equal(parseCsv(await readFile(expectedFiles[1], "utf8")).length, 2);
const markdown = await readFile(rootReportPath, "utf8");
assert.match(markdown, /实验做了什么/);
assert.match(markdown, /证明了什么/);
assert.match(markdown, /不能证明什么/);
const html = await readFile(expectedFiles[4], "utf8");
assert.match(html, /<meta charset="UTF-8">/);
assert.match(html, /实验 5：遥测与计算开销分解实验/);
assert.ok(!html.includes("�"));

console.log(JSON.stringify({
  ok: true,
  summary_rows: result.summaryRows.length,
  timing_rows: result.timingRows.length,
  byte_identity: parts.total_generated_bytes,
}, null, 2));
