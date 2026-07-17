import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const scriptPath = "scripts/runExperiment3JointTensorComparison.mjs";
const source = existsSync(scriptPath) ? await readFile(scriptPath, "utf8") : "";
const packageJson = JSON.parse(await readFile("package.json", "utf8"));

for (const backend of ["low-rank", "joint-cp", "joint-cp-physics"]) {
  assert.ok(source.includes(`id: "${backend}"`), `comparison matrix is missing ${backend}`);
}
for (const metric of [
  "cpu_percent",
  "queue_depth",
  "queued_traffic_mb",
  "cache_used_mb",
  "energy_percent",
  "utilization_percent",
  "queue_latency_ms",
  "packet_error_rate",
]) {
  assert.ok(source.includes(`"${metric}"`), `comparison metric set is missing ${metric}`);
}
for (const field of [
  "node_observation_mask_sha256",
  "link_observation_mask_sha256",
  "ground_oam_nodes_sha256",
  "ground_oam_links_sha256",
  "probe_plan_sha256",
  "same_telemetry_bytes_all_methods",
  "same_telemetry_energy_all_methods",
  "macro_inferred_nmae",
  "physical_consistency_violation_rate",
]) {
  assert.ok(source.includes(field), `comparison fairness/result contract is missing ${field}`);
}
assert.ok(source.includes("experiment3-joint-tensor-comparison-v1"));
assert.ok(source.includes("相同 INT 观测和相同遥测开销"));
assert.ok(source.includes("CP 分解"));
assert.ok(source.includes("有效联合权重"));
assert.ok(source.includes("universal_joint_error_improvement"));
assert.ok(source.includes("physics_gain_not_attributed_to_cp"));
assert.match(source, /auditNodePhysicalConsistency/);
assert.match(source, /auditLinkPhysicalConsistency/);

assert.equal(packageJson.scripts["experiment3:joint-tensor"], "node scripts/runExperiment3JointTensorComparison.mjs");
assert.equal(
  packageJson.scripts["experiment3:joint-tensor-smoke"],
  "node scripts/runExperiment3JointTensorComparison.mjs --profiles iridium-next-small --slices 8 --out reports/_scratch/experiment3-joint-tensor-smoke --formal false",
);

const artifactPath = resolve("reports/experiment3-joint-tensor-completion/summary.json");
if (existsSync(artifactPath)) {
  const summary = JSON.parse(await readFile(artifactPath, "utf8"));
  assert.equal(summary.schema_version, "experiment3-joint-tensor-comparison-v1");
  assert.equal(summary.fairness_audit.all_profiles_passed, true);
  assert.equal(typeof summary.verdict?.universal_joint_error_improvement, "boolean");
  assert.equal(summary.verdict?.physics_gain_not_attributed_to_cp, true);
  for (const profileId of summary.profiles) {
    const rows = summary.rows.filter((row) => row.constellation_profile_id === profileId);
    assert.equal(rows.length, 3);
    assert.equal(new Set(rows.map((row) => row.node_observation_mask_sha256)).size, 1);
    assert.equal(new Set(rows.map((row) => row.link_observation_mask_sha256)).size, 1);
    assert.equal(new Set(rows.map((row) => row.telemetry_total_bytes)).size, 1);
    assert.equal(new Set(rows.map((row) => row.telemetry_total_energy_j)).size, 1);
  }
}

console.log(JSON.stringify({
  ok: true,
  script_present: existsSync(scriptPath),
  artifact_checked: existsSync(artifactPath),
}, null, 2));
