import assert from "node:assert/strict";
import {
  aggregateEqualBudgetRows,
  auditEqualBudgetFairness,
  buildPairedMethodEffects,
  validateEqualBudgetMatrix,
} from "./experiments/equalBudgetStatistics.mjs";

const rows = [
  { profile_id: "small", stress_rate: 0.25, seed: "s1", method_id: "native-full-replan", cpu_mae: 10, link_status_accuracy: 0.90, telemetry_bytes_per_node_slice: 90, telemetry_byte_budget_per_node_slice: 100, telemetry_byte_budget_cap_violations: 0 },
  { profile_id: "small", stress_rate: 0.25, seed: "s1", method_id: "enhanced", cpu_mae: 8, link_status_accuracy: 0.94, telemetry_bytes_per_node_slice: 92, telemetry_byte_budget_per_node_slice: 100, telemetry_byte_budget_cap_violations: 0 },
  { profile_id: "small", stress_rate: 0.25, seed: "s1", method_id: "native-reference-replay", cpu_mae: 11, link_status_accuracy: 0.87, telemetry_bytes_per_node_slice: 88, telemetry_byte_budget_per_node_slice: 100, telemetry_byte_budget_cap_violations: 0 },
  { profile_id: "small", stress_rate: 0.25, seed: "s2", method_id: "native-full-replan", cpu_mae: 12, link_status_accuracy: 0.88, telemetry_bytes_per_node_slice: 91, telemetry_byte_budget_per_node_slice: 100, telemetry_byte_budget_cap_violations: 0 },
  { profile_id: "small", stress_rate: 0.25, seed: "s2", method_id: "enhanced", cpu_mae: 9, link_status_accuracy: 0.93, telemetry_bytes_per_node_slice: 93, telemetry_byte_budget_per_node_slice: 100, telemetry_byte_budget_cap_violations: 0 },
  { profile_id: "small", stress_rate: 0.25, seed: "s2", method_id: "native-reference-replay", cpu_mae: 14, link_status_accuracy: 0.84, telemetry_bytes_per_node_slice: 87, telemetry_byte_budget_per_node_slice: 100, telemetry_byte_budget_cap_violations: 0 },
];

const aggregate = aggregateEqualBudgetRows(rows, { metrics: ["cpu_mae", "link_status_accuracy"] });
assert.equal(aggregate.length, 3);
const enhanced = aggregate.find((row) => row.method_id === "enhanced");
assert.equal(enhanced.sample_count, 2);
assert.equal(enhanced.cpu_mae_mean, 8.5);
assert.equal(enhanced.cpu_mae_std, 0.707107);
assert.ok(enhanced.cpu_mae_ci95_low < 8.5 && enhanced.cpu_mae_ci95_high > 8.5);

const effects = buildPairedMethodEffects(rows, {
  treatment: "enhanced",
  controls: ["native-full-replan", "native-reference-replay"],
  metricDirections: { cpu_mae: "lower", link_status_accuracy: "higher" },
});
const cpuVsNative = effects.find((row) => row.control_method_id === "native-full-replan" && row.metric === "cpu_mae");
assert.equal(cpuVsNative.paired_samples, 2);
assert.equal(cpuVsNative.improvement_mean, 2.5);
assert.equal(cpuVsNative.improvement_std, 0.707107);
assert.equal(cpuVsNative.cohen_dz, 3.535534);
const accuracyVsNative = effects.find((row) => row.control_method_id === "native-full-replan" && row.metric === "link_status_accuracy");
assert.equal(accuracyVsNative.improvement_mean, 0.045);

const fairness = auditEqualBudgetFairness(rows, {
  requiredMethods: ["native-full-replan", "enhanced", "native-reference-replay"],
});
assert.equal(fairness.length, 2);
assert.ok(fairness.every((row) => row.ok));
assert.ok(fairness.every((row) => row.method_count === 3));
assert.equal(fairness[0].hard_cap_spread, 0);
assert.equal(fairness[0].primary_method_actual_spread, 2);
assert.equal(fairness[0].primary_method_actual_spread_ratio, 0.02);
assert.equal(fairness[0].primary_achieved_budget_match_ok, true);

assert.doesNotThrow(() => validateEqualBudgetMatrix(rows, {
  profileIds: ["small"],
  stressRates: [0.25],
  seeds: ["s1", "s2"],
  methodIds: ["native-full-replan", "enhanced", "native-reference-replay"],
}));
assert.throws(() => validateEqualBudgetMatrix(rows.slice(1), {
  profileIds: ["small"],
  stressRates: [0.25],
  seeds: ["s1", "s2"],
  methodIds: ["native-full-replan", "enhanced", "native-reference-replay"],
}), /missing combinations/i);

console.log("Equal-budget statistics tests passed.");
