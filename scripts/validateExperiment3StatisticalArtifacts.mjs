import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(
  process.argv.includes("--input")
    ? process.argv[process.argv.indexOf("--input") + 1]
    : "reports/experiment3-statistical-strong-baselines",
);

async function lineCount(file) {
  const text = await readFile(file, "utf8");
  return text.trimEnd().split(/\r?\n/u).length - 1;
}

const summaryPath = path.join(root, "experiment3-statistical-summary.json");
const summary = JSON.parse(await readFile(summaryPath, "utf8"));

assert.equal(summary.status, "complete");
assert.deepEqual(summary.profiles, ["telesat-1015-medium", "starlink-main-large"]);
assert.deepEqual(summary.seeds, [11, 23, 37]);
assert.equal(summary.backends.length, 7);
assert.deepEqual(summary.metrics, ["cpu_percent", "queue_depth", "energy_percent", "utilization_percent"]);
assert.equal(summary.protocol.slices_per_seed, 48);
assert.equal(summary.protocol.same_probe_plan_within_profile_seed, true);
assert.equal(summary.protocol.same_node_and_link_observed_mask_within_profile_seed, true);
assert.equal(summary.protocol.same_actual_telemetry_bytes_within_profile_seed, true);
assert.equal(summary.protocol.hidden_truth_used_only_for_posthoc_evaluation, true);
assert.equal(summary.protocol.kalman_rts_is_offline_noncausal_reference, true);
assert.equal(summary.fairness_audit.all_cases_passed, true);
assert.equal(summary.fairness_audit.cases.length, 6);
assert.ok(summary.fairness_audit.cases.every((entry) => entry.passed));

const expectedCounts = new Map([
  ["experiment3-statistical-raw.csv", 168],
  ["experiment3-statistical-by-slice.csv", 8064],
  ["experiment3-statistical-aggregate.csv", 56],
  ["experiment3-statistical-paired-evidence.csv", 48],
]);
for (const [file, expected] of expectedCounts) {
  assert.equal(await lineCount(path.join(root, file)), expected, `${file} 行数不完整`);
}

for (const profile of summary.profiles) {
  for (const seed of summary.seeds) {
    for (const backend of summary.backends) {
      await access(path.join(root, "runs", profile, `seed-${seed}`, backend, "run-summary.json"));
    }
  }
}

const html = await readFile(path.join(root, "index.html"), "utf8");
assert.ok(html.includes("实验 3：中大型星座多种子、多指标强补全基线"));
assert.ok(html.includes("公平性门禁"));
assert.ok(html.includes("离线 RTS 平滑"));
assert.ok(!html.includes("�"), "HTML 不应包含 Unicode replacement character");

const statisticallyBetter = summary.paired_evidence.filter((entry) => entry.statistically_better_than_low_rank);
assert.equal(statisticallyBetter.length, 6);

console.log(JSON.stringify({
  ok: true,
  root,
  raw_rows: 168,
  by_slice_rows: 8064,
  run_summaries: summary.profiles.length * summary.seeds.length * summary.backends.length,
  statistically_better_combinations: statisticallyBetter.length,
}, null, 2));
