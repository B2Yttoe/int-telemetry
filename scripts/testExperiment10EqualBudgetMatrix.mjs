import assert from "node:assert/strict";
import {
  DEFAULT_PROFILE_BUDGETS,
  EXPERIMENT10_METHOD_IDS,
  EXPERIMENT10_STRESS_RATES,
  buildExperiment10ConfigFingerprint,
  buildExperiment10Html,
  buildExperiment10Matrix,
  parseBudgetMap,
} from "./runExperiment10EqualBudgetDynamicity.mjs";

assert.deepEqual(EXPERIMENT10_STRESS_RATES, [0, 0.1, 0.25]);
assert.deepEqual(EXPERIMENT10_METHOD_IDS, ["native-full-replan", "enhanced", "native-reference-replay"]);
assert.ok(DEFAULT_PROFILE_BUDGETS["iridium-next-small"] > 0);
assert.ok(DEFAULT_PROFILE_BUDGETS["telesat-1015-medium"] > 0);
assert.ok(DEFAULT_PROFILE_BUDGETS["starlink-main-large"] > 0);

const matrix = buildExperiment10Matrix({
  profileIds: ["iridium-next-small", "telesat-1015-medium", "starlink-main-large"],
  stressRates: EXPERIMENT10_STRESS_RATES,
  seeds: Array.from({ length: 10 }, (_, index) => `seed-${String(index).padStart(2, "0")}`),
  methodIds: EXPERIMENT10_METHOD_IDS,
});
assert.equal(matrix.length, 270);
assert.equal(new Set(matrix.map((row) => row.seed)).size, 10);

assert.deepEqual(parseBudgetMap("small:100,medium:50.5"), { small: 100, medium: 50.5 });
assert.throws(() => parseBudgetMap("small:-1"), /positive/i);

const baseFingerprintInput = {
  profiles: ["small"],
  stressRates: [0],
  seeds: ["seed-00"],
  budgets: { small: 100 },
  sourceHashes: { small: { metadata_sha256: "a", candidate_paths_sha256: "b" } },
  methodIds: EXPERIMENT10_METHOD_IDS,
  implementationFingerprint: "implementation-a",
  telemetryByteBudgetPadToCap: true,
};
assert.notEqual(
  buildExperiment10ConfigFingerprint(baseFingerprintInput),
  buildExperiment10ConfigFingerprint({ ...baseFingerprintInput, implementationFingerprint: "implementation-b" }),
);
assert.notEqual(
  buildExperiment10ConfigFingerprint(baseFingerprintInput),
  buildExperiment10ConfigFingerprint({ ...baseFingerprintInput, telemetryByteBudgetPadToCap: false }),
);

const html = buildExperiment10Html({
  aggregateRows: [{
    profile_id: "small",
    constellation_label: "Small",
    stress_rate: 0.25,
    method_id: "enhanced",
    method_label: "增强",
    sample_count: 10,
    telemetry_bytes_per_node_slice_mean: 90,
    telemetry_bytes_per_node_slice_ci95_low: 88,
    telemetry_bytes_per_node_slice_ci95_high: 92,
    cpu_mae_mean: 1,
    cpu_mae_ci95_low: 0.8,
    cpu_mae_ci95_high: 1.2,
    energy_percent_mae_mean: 2,
    energy_percent_mae_ci95_low: 1.5,
    energy_percent_mae_ci95_high: 2.5,
    link_utilization_mae_mean: 3,
    link_utilization_mae_ci95_low: 2.5,
    link_utilization_mae_ci95_high: 3.5,
    planning_wall_time_ms_mean: 100,
    planning_wall_time_ms_ci95_low: 90,
    planning_wall_time_ms_ci95_high: 110,
  }],
  effectRows: [{ profile_id: "small", stress_rate: 0.25, control_method_id: "native-full-replan", metric: "cpu_mae", improvement_mean: 1, improvement_ci95_low: 0.5, improvement_ci95_high: 1.5, cohen_dz: 1 }],
  fairnessRows: [{ profile_id: "small", stress_rate: 0.25, seed: "seed-00", hard_cap_bytes_per_node_slice: 100, actual_bytes_per_node_slice_min: 88, actual_bytes_per_node_slice_max: 92, cap_violations: 0, ok: true }],
  parameters: { seed_count: 10 },
});
assert.match(html, /严格等硬字节预算/);
assert.match(html, /95% CI/);
assert.match(html, /主要结论/);
assert.match(html, /配对效应量/);
assert.match(html, /预算公平性/);
assert.match(html, /<svg/);

console.log("Experiment 10 equal-budget matrix tests passed.");
