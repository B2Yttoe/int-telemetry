import assert from "node:assert/strict";

import {
  EXPERIMENT11_STRESS_RATES,
  buildExperiment11Matrix,
  normalizeExperiment11Row,
} from "./runExperiment11DynamicEqualBudgetAblation.mjs";
import { EXPERIMENT11_VARIANT_IDS } from "./experiments/dynamicAblationVariants.mjs";

const profileIds = ["small", "medium", "large"];
const seeds = Array.from({ length: 10 }, (_, index) => `seed-${index}`);
const matrix = buildExperiment11Matrix({ profileIds, seeds });

assert.deepEqual(EXPERIMENT11_STRESS_RATES, [0, 0.25]);
assert.equal(matrix.length, 360);
assert.equal(
  new Set(matrix.map((row) => `${row.profile_id}|${row.stress_rate}|${row.seed}|${row.method_id}`)).size,
  360,
);
assert.deepEqual(new Set(matrix.map((row) => row.method_id)), new Set(EXPERIMENT11_VARIANT_IDS));

const normalized = normalizeExperiment11Row({
  method_id: "without-node-state-coupling",
  method_label: "test",
  telemetry_byte_budget_per_node_slice: 123,
  telemetry_byte_budget_cap_violations: 0,
  telemetry_byte_budget_padding_bytes: 456,
  telemetry_padding_bytes_per_node_slice: 7.5,
  selected_paths: 8,
  invalid_probe_path_ratio: 0.01,
  telemetry_bytes_per_node_slice: 123,
  total_telemetry_generated_bytes: 789,
  total_telemetry_energy_j: 1.25,
  cpu_mae: 2,
  queue_depth_mae: 3,
  energy_percent_mae: 4,
  node_mode_accuracy: 0.95,
  link_utilization_mae: 0.05,
  link_status_accuracy: 0.96,
  planning_wall_time_ms: 25,
  matrix_completion_ms: 35,
}, {
  profile: { id: "small", short_label: "Small", node_count: 66 },
  stressRate: 0.25,
  seed: "seed-0",
  hardBudget: 123,
});

assert.equal(normalized.profile_id, "small");
assert.equal(normalized.node_count, 66);
assert.equal(normalized.stress_rate, 0.25);
assert.equal(normalized.seed, "seed-0");
assert.equal(normalized.method_id, "without-node-state-coupling");
assert.equal(normalized.telemetry_byte_budget_per_node_slice, 123);
assert.equal(normalized.telemetry_padding_bytes_per_node_slice, 7.5);
assert.equal(normalized.cpu_mae, 2);
assert.equal(normalized.queue_depth_mae, 3);
assert.equal(normalized.energy_percent_mae, 4);
assert.equal(normalized.node_mode_accuracy, 0.95);
assert.equal(normalized.link_utilization_mae, 0.05);
assert.equal(normalized.link_status_accuracy, 0.96);
assert.equal(normalized.planning_wall_time_ms, 25);
assert.equal(normalized.reconstruction_wall_time_ms, 35);

console.log("Experiment 11 matrix tests passed.");
