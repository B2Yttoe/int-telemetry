import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const profiles = ["iridium-next-small", "telesat-1015-medium", "starlink-main-large"];

function row(profile, version, overrides = {}) {
  return {
    constellation_profile_id: profile,
    version,
    telemetry_bytes_per_node_slice: version === "before" ? 100 : 90,
    cpu_mae: 1,
    queue_depth_mae: 1,
    energy_percent_mae: 1,
    link_utilization_mae: 1,
    node_mode_accuracy: 0.99,
    link_status_accuracy: 0.98,
    ...overrides,
  };
}

function payload(overrides = {}) {
  return {
    rows: profiles.flatMap((profile) => [
      row(profile, "before", overrides[`${profile}|before`]),
      row(profile, "after", overrides[`${profile}|after`]),
    ]),
  };
}

function runVerifier({ reference, candidate }) {
  return spawnSync(process.execPath, [
    "scripts/verifyExperiment2OamOptimizationGoal.mjs",
    "--reference", reference,
    "--candidate", candidate,
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
}

const root = resolve("reports/tmp-experiment2-oam-goal-test");
if (!root.includes("tmp-experiment2-oam-goal-test")) {
  throw new Error(`refusing to clean unexpected path: ${root}`);
}
if (existsSync(root)) rmSync(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });

const referencePath = join(root, "reference.json");
const passingPath = join(root, "passing.json");
const byteFailurePath = join(root, "byte-failure.json");
const maeFailurePath = join(root, "mae-failure.json");
const accuracyFailurePath = join(root, "accuracy-failure.json");

await writeFile(referencePath, JSON.stringify(payload(), null, 2), "utf8");
await writeFile(passingPath, JSON.stringify(payload({
  "starlink-main-large|after": { telemetry_bytes_per_node_slice: 99, cpu_mae: 1.01, link_status_accuracy: 0.979 },
}), null, 2), "utf8");
await writeFile(byteFailurePath, JSON.stringify(payload({
  "starlink-main-large|after": { telemetry_bytes_per_node_slice: 100.0001 },
}), null, 2), "utf8");
await writeFile(maeFailurePath, JSON.stringify(payload({
  "telesat-1015-medium|after": { energy_percent_mae: 1.0101 },
}), null, 2), "utf8");
await writeFile(accuracyFailurePath, JSON.stringify(payload({
  "iridium-next-small|after": { node_mode_accuracy: 0.9889 },
}), null, 2), "utf8");

const passing = runVerifier({ reference: referencePath, candidate: passingPath });
assert.equal(passing.status, 0, `passing fixture should satisfy all gates\n${passing.stdout}\n${passing.stderr}`);

const byteFailure = runVerifier({ reference: referencePath, candidate: byteFailurePath });
assert.notEqual(byteFailure.status, 0, "candidate above native bytes should fail");
assert.match(`${byteFailure.stdout}\n${byteFailure.stderr}`, /telemetry_bytes_per_node_slice/);

const maeFailure = runVerifier({ reference: referencePath, candidate: maeFailurePath });
assert.notEqual(maeFailure.status, 0, "candidate above the 1% MAE tolerance should fail");
assert.match(`${maeFailure.stdout}\n${maeFailure.stderr}`, /energy_percent_mae/);

const accuracyFailure = runVerifier({ reference: referencePath, candidate: accuracyFailurePath });
assert.notEqual(accuracyFailure.status, 0, "candidate below the accuracy tolerance should fail");
assert.match(`${accuracyFailure.stdout}\n${accuracyFailure.stderr}`, /node_mode_accuracy/);

console.log(JSON.stringify({
  ok: true,
  profiles,
  rejected: ["byte-failure", "mae-failure", "accuracy-failure"],
}, null, 2));
