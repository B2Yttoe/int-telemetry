import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseCsv } from "./experiments/reportUtils.mjs";

function argValue(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

function numberValue(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function relativeRegression(candidate, baseline) {
  return (numberValue(candidate) - numberValue(baseline)) / Math.max(Math.abs(numberValue(baseline)), 1e-9);
}

const inputDir = resolve(argValue(
  "--input",
  "reports/experiment12-topology-reuse-contribution-48slice-stress00",
));
const summaryPath = join(inputDir, "experiment12-summary.csv");
const benchmarkPath = join(inputDir, "planner-benchmark/planner-benchmark.json");
assert.ok(existsSync(summaryPath), `Missing summary: ${summaryPath}`);
assert.ok(existsSync(benchmarkPath), `Missing planner benchmark: ${benchmarkPath}`);

const rows = parseCsv(await readFile(summaryPath, "utf8"));
const benchmark = JSON.parse(await readFile(benchmarkPath, "utf8"));
const rowFor = (profileId, variantId) => rows.find(
  (row) => row.profile_id === profileId && row.variant_id === variantId && Number(row.stress_rate) === 0,
);
const starlinkFull = rowFor("starlink-main-large", "full-unified");
const starlinkFresh = rowFor("starlink-main-large", "no-topology-version");
const telesatFull = rowFor("telesat-1015-medium", "full-unified");
assert.ok(starlinkFull && starlinkFresh && telesatFull, "Missing required Experiment 12 rows");

assert.ok(numberValue(starlinkFull.unified_repair_slices) > 0, "Starlink must trigger local topology repair");
assert.equal(numberValue(starlinkFull.unified_hard_budget_violations), 0);
assert.equal(starlinkFull.strict_causal_passed, "true");
assert.equal(starlinkFresh.strict_causal_passed, "true");
assert.ok(
  numberValue(starlinkFull.planning_candidate_paths) < numberValue(starlinkFresh.planning_candidate_paths),
  "Topology reuse must reduce the candidate workload",
);
assert.ok(
  numberValue(starlinkFull.unified_planner_marginal_evaluations) <
    numberValue(starlinkFresh.unified_planner_marginal_evaluations),
  "Topology reuse must reduce marginal evaluations",
);
assert.ok(
  numberValue(starlinkFull.unified_planner_score_cache_recomputations) <
    numberValue(starlinkFresh.unified_planner_score_cache_recomputations),
  "Topology reuse must reduce score-cache recomputations",
);

for (const field of ["cpu_mae", "queue_depth_mae", "energy_percent_mae", "link_utilization_mae"]) {
  assert.ok(
    relativeRegression(starlinkFull[field], starlinkFresh[field]) <= 0.01 + 1e-9,
    `${field} regression must stay within 1%`,
  );
}
assert.ok(
  relativeRegression(starlinkFull.telemetry_bytes_per_node_slice, starlinkFresh.telemetry_bytes_per_node_slice) <= 0.01,
  "Telemetry bytes must remain within the 1% similar-cost gate",
);
assert.ok(
  relativeRegression(starlinkFull.total_telemetry_energy_j, starlinkFresh.total_telemetry_energy_j) <= 0.01,
  "Telemetry energy must remain within the 1% similar-cost gate",
);
assert.ok(
  numberValue(starlinkFull.invalid_probe_path_ratio) <= numberValue(starlinkFresh.invalid_probe_path_ratio) + 1e-9,
  "Topology reuse must not increase invalid probe paths",
);
assert.ok(
  numberValue(starlinkFull.active_link_direct_coverage) >= numberValue(starlinkFresh.active_link_direct_coverage),
  "Topology reuse must preserve direct active-link coverage",
);

assert.equal(numberValue(telesatFull.unified_reuse_slices) + numberValue(telesatFull.unified_repair_slices), 0);
assert.equal(telesatFull.mechanism_triggered, "false", "Untriggered Telesat reuse must remain an explicit boundary");

assert.ok(numberValue(benchmark.summary?.repetitions) >= 3, "Planner timing requires at least three repetitions");
assert.equal(benchmark.summary?.hard_budget_passed, true);
assert.equal(benchmark.summary?.causal_boundary_passed, true);
assert.ok(numberValue(benchmark.summary?.marginal_evaluation_reduction_percent) > 0);
assert.ok(numberValue(benchmark.summary?.score_cache_recomputation_reduction_percent) > 0);

console.log(JSON.stringify({
  ok: true,
  starlink_repair_slices: numberValue(starlinkFull.unified_repair_slices),
  maximum_mae_regression_percent: Math.max(
    0,
    ...["cpu_mae", "queue_depth_mae", "energy_percent_mae", "link_utilization_mae"]
      .map((field) => relativeRegression(starlinkFull[field], starlinkFresh[field]) * 100),
  ),
  telemetry_byte_change_percent:
    relativeRegression(starlinkFull.telemetry_bytes_per_node_slice, starlinkFresh.telemetry_bytes_per_node_slice) * 100,
  marginal_evaluation_reduction_percent: benchmark.summary.marginal_evaluation_reduction_percent,
  timing_conclusion: "single-run and repeated wall time are reported, but are not a hard acceptance gate",
}, null, 2));
