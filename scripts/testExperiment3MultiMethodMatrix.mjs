import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

function argValue(args, name, fallback = "") {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? fallback : fallback;
}

const expectedBackends = [
  "prior-only",
  "low-rank",
  "soft-impute",
  "kalman-smoother",
  "graph-neighbor",
  "graph-regularized",
  "st-gnn",
  "costco",
];
const source = await readFile("scripts/runExperiment3CpuCompletionComparison.mjs", "utf8");
const packageJson = JSON.parse(await readFile("package.json", "utf8"));

for (const backend of expectedBackends) {
  assert.ok(source.includes(`id: "${backend}"`), `experiment 3 is missing ${backend}`);
}
for (const field of [
  "observation_mask_sha256",
  "ground_oam_nodes_sha256",
  "probe_plan_sha256",
  "completion_wall_clock_ms",
  "same_observation_mask_all_backends",
  "--observation-root",
]) {
  assert.ok(source.includes(field), `experiment 3 fairness/report contract is missing ${field}`);
}
assert.ok(source.includes("experiment3-cpu-single-metric-completion-v3"), "experiment 3 schema must be v3");
assert.ok(source.includes("不构成统计显著性"), "the report must state the single-run statistical limitation");
assert.ok(source.includes("ST-GNN 与结构先验"), "the report must disclose the observed ST-GNN/prior-only collapse");
assert.ok(source.includes("不存在跨全部规模统一最优"), "the report must state the scale-dependent method conclusion");
assert.ok(source.includes("离线 RTS 平滑基线"), "the report must disclose the Kalman smoother's offline boundary");
assert.ok(source.includes("zeroBaselineY"), "grouped bar charts must render negative R2 values around a zero baseline");
assert.ok(source.includes("optionalNumber"), "charts must distinguish missing runtime values from numeric zero");
assert.equal(
  packageJson.scripts["experiment3:smoke"],
  "node scripts/runExperiment3MultiMethodSmoke.mjs",
  "package.json must expose the bounded eight-backend smoke run",
);
assert.equal(
  packageJson.scripts["test:experiment3"],
  "node scripts/testIntMcAdditionalCompletionBackends.mjs && node scripts/testIntMcCompletionBackendRegistry.mjs && node scripts/testExperiment3MultiMethodMatrix.mjs",
  "package.json must expose the experiment-3 verification suite",
);

const input = resolve(argValue(process.argv.slice(2), "--input", "reports/experiment3-cpu-single-metric-completion/experiment3-cpu-completion-summary.json"));
const smokeInput = resolve("reports/_scratch/experiment3-multi-method-smoke/summary.json");
if (existsSync(smokeInput)) {
  const smoke = JSON.parse(await readFile(smokeInput, "utf8"));
  assert.equal(smoke.slice_count, 8, "the default bounded smoke must use eight slices");
  assert.deepEqual([...smoke.backends].sort(), [...expectedBackends].sort());
  assert.equal(smoke.rows.length, expectedBackends.length);
  assert.equal(smoke.all_observed_locks_passed, true);
  assert.equal(smoke.all_truth_boundaries_passed, true);
}
if (existsSync(input)) {
  const summary = JSON.parse(await readFile(input, "utf8"));
  if (summary.schema_version === "experiment3-cpu-single-metric-completion-v3") {
    assert.deepEqual([...summary.backends].sort(), [...expectedBackends].sort());
    assert.equal(summary.fairness_boundary.stage_one_hidden_cpu_truth_used_only_for_evaluation, true);
    assert.equal(summary.fairness_boundary.stage_one_orbit_topology_context_shared_by_all_backends, true);
    assert.equal("stage_one_truth_used_only_for_evaluation" in summary.fairness_boundary, false);
    assert.equal(summary.fairness_boundary.truth_used_for_backend_selection, false);
    assert.equal(summary.fairness_audit.all_profiles_passed, true);

    for (const profileId of summary.profiles) {
      const rows = summary.rows.filter((row) => row.constellation_profile_id === profileId);
      assert.equal(rows.length, expectedBackends.length, `${profileId} must contain all eight backends`);
      assert.equal(new Set(rows.map((row) => row.observation_mask_sha256)).size, 1, `${profileId} mask hashes differ`);
      assert.equal(new Set(rows.map((row) => row.ground_oam_nodes_sha256)).size, 1, `${profileId} Ground OAM hashes differ`);
      assert.equal(new Set(rows.map((row) => row.probe_plan_sha256)).size, 1, `${profileId} probe hashes differ`);
      assert.equal(new Set(rows.map((row) => row.telemetry_total_bytes)).size, 1, `${profileId} telemetry bytes differ`);
      assert.equal(new Set(rows.map((row) => row.direct_node_observation_rate)).size, 1, `${profileId} direct observation rates differ`);
    }
  }
}

console.log(JSON.stringify({
  ok: true,
  expected_backends: expectedBackends,
  artifact_checked: existsSync(input),
}, null, 2));
