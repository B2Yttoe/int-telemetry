import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const EXPECTED_PROFILES = ["telesat-1015-medium", "starlink-main-large"];
const EXPECTED_BACKENDS = [
  "low-rank",
  "soft-impute",
  "kalman-smoother",
  "graph-neighbor",
  "graph-regularized",
];
const outputDir = resolve(process.argv[2] ?? "reports/experiment3-medium-large-strong-baselines");
const summaryPath = join(outputDir, "experiment3-cpu-completion-summary.json");
const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const command = packageJson.scripts["experiment3:medium-large-baselines"] ?? "";

for (const profile of EXPECTED_PROFILES) {
  assert.ok(command.includes(profile), `experiment command is missing ${profile}`);
}
for (const backend of EXPECTED_BACKENDS) {
  assert.ok(command.includes(backend), `experiment command is missing ${backend}`);
}
assert.ok(command.includes("--observation-root"), "experiment must reuse one frozen INT observation source");
assert.ok(command.includes("--compact-artifacts"), "experiment must use compact node-only artifacts");

if (existsSync(summaryPath)) {
  const summary = JSON.parse(await readFile(summaryPath, "utf8"));
  assert.deepEqual([...summary.profiles].sort(), [...EXPECTED_PROFILES].sort());
  assert.deepEqual([...summary.backends].sort(), [...EXPECTED_BACKENDS].sort());
  assert.equal(summary.parameters.compact_artifacts, true);
  assert.equal(summary.fairness_audit.all_profiles_passed, true);
  assert.equal(summary.fairness_boundary.stage_one_hidden_cpu_truth_used_only_for_evaluation, true);
  assert.equal(summary.fairness_boundary.truth_used_for_backend_selection, false);
  assert.equal(summary.fairness_boundary.compact_artifacts_only_omit_unused_link_csv_outputs, true);
  assert.equal(summary.rows.length, EXPECTED_PROFILES.length * EXPECTED_BACKENDS.length);
  const reportMarkdown = await readFile(join(outputDir, "experiment3-cpu-completion-report.md"), "utf8");
  assert.ok(reportMarkdown.includes("## 同预算相对低秩变化"));
  assert.equal(reportMarkdown.includes("ST-GNN 与结构先验"), false, "report must not discuss an unexecuted backend");

  for (const profile of EXPECTED_PROFILES) {
    const rows = summary.rows.filter((row) => row.constellation_profile_id === profile);
    assert.equal(rows.length, EXPECTED_BACKENDS.length, `${profile} must contain every baseline`);
    assert.ok(rows.every((row) => Number(row.slice_count) === 48), `${profile} must use all 48 slices`);
    assert.ok(rows.every((row) => row.artifact_scope === "node-metric-compact"));
    assert.ok(rows.every((row) => row.link_artifacts_written === false));
    assert.equal(new Set(rows.map((row) => row.observation_mask_sha256)).size, 1, `${profile} observation masks differ`);
    assert.equal(new Set(rows.map((row) => row.ground_oam_nodes_sha256)).size, 1, `${profile} OAM inputs differ`);
    assert.equal(new Set(rows.map((row) => row.probe_plan_sha256)).size, 1, `${profile} probe plans differ`);
    assert.equal(new Set(rows.map((row) => row.telemetry_total_bytes)).size, 1, `${profile} telemetry budgets differ`);
    assert.equal(new Set(rows.map((row) => row.direct_node_observation_rate)).size, 1, `${profile} direct observation rates differ`);

    for (const backend of EXPECTED_BACKENDS) {
      const row = rows.find((item) => item.completion_backend === backend);
      assert.ok(row, `${profile} is missing ${backend}`);
      assert.ok(Number.isFinite(Number(row.cpu_inferred_mae)), `${profile}/${backend} has no inferred MAE`);
      assert.ok(Number.isFinite(Number(row.cpu_inferred_rmse)), `${profile}/${backend} has no inferred RMSE`);
      assert.ok(Number.isFinite(Number(row.cpu_inferred_p95_ae)), `${profile}/${backend} has no inferred P95 AE`);
      const backendDir = join(outputDir, profile, "ground-oam", `cpu-${backend}`);
      assert.equal(existsSync(join(backendDir, "ground-mc-reconstructed-links.csv")), false, `${profile}/${backend} wrote an unused link reconstruction`);
      assert.equal(existsSync(join(backendDir, "int-mc-link-errors.csv")), false, `${profile}/${backend} wrote unused link errors`);
      assert.equal(existsSync(join(backendDir, "ground-mc-reconstructed-nodes.csv")), true, `${profile}/${backend} is missing node reconstruction evidence`);
    }
  }
}

console.log(JSON.stringify({
  ok: true,
  artifact_checked: existsSync(summaryPath),
  profiles: EXPECTED_PROFILES,
  backends: EXPECTED_BACKENDS,
}, null, 2));
