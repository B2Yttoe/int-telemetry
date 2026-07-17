import assert from "node:assert/strict";

import { completeJointMetricTensor } from "../stage2-int/tools/int-mc-joint-tensor-completion.mjs";

const timeIds = ["0", "1", "2"];
const objectIds = ["P01-S01", "P01-S02", "P02-S01"];
const key = (timeId, objectId) => `${timeId}|${objectId}`;

function observed(entries) {
  return new Map(entries.map(([timeId, objectId, value]) => [key(timeId, objectId), value]));
}

function priors(defaultValue) {
  return new Map(timeIds.flatMap((timeId) => objectIds.map((objectId) => [key(timeId, objectId), defaultValue])));
}

const targetObserved = observed([
  ["0", "P01-S01", 10],
  ["0", "P01-S02", 20],
  ["0", "P02-S01", 30],
  ["1", "P01-S01", 15],
  ["1", "P01-S02", 25],
  ["2", "P01-S01", 20],
  ["2", "P02-S01", 40],
]);
const auxiliaryLow = observed([
  ["0", "P01-S01", 1],
  ["0", "P01-S02", 2],
  ["0", "P02-S01", 3],
  ["1", "P01-S01", 1.5],
  ["1", "P01-S02", 2.5],
  ["1", "P02-S01", 3.5],
  ["2", "P01-S01", 2],
  ["2", "P01-S02", 3],
  ["2", "P02-S01", 4],
]);
const auxiliaryHigh = new Map([...auxiliaryLow].map(([entryKey, value]) => [
  entryKey,
  value + (entryKey.includes("P02-S01") ? 12 : entryKey.startsWith("2|") ? 5 : 0),
]));
const inactiveKey = key("2", "P01-S02");
const isActive = ({ timeId, objectId }) => key(timeId, objectId) !== inactiveKey;
const neighbors = new Map([
  ["P01-S01", ["P01-S02", "P02-S01"]],
  ["P01-S02", ["P01-S01"]],
  ["P02-S01", ["P01-S01"]],
]);

function run(auxiliaryObserved) {
  return completeJointMetricTensor({
    timeIds,
    objectIds,
    metricSpecs: [
      {
        name: "cpu_percent",
        priorEstimates: priors(18),
        observedValues: targetObserved,
        clamp: (value) => Math.max(0, Math.min(100, value)),
      },
      {
        name: "queue_depth",
        priorEstimates: priors(2),
        observedValues: auxiliaryObserved,
        clamp: (value) => Math.max(0, value),
      },
    ],
    isActive,
    neighborObjectIds: neighbors,
    rank: 3,
    epochs: 30,
    learningRate: 0.02,
    jointPredictionWeight: 0.45,
    temporalRegularization: 0.02,
    orbitRegularization: 0.02,
  });
}

const low = run(auxiliaryLow);
const repeated = run(auxiliaryLow);
const high = run(auxiliaryHigh);

assert.deepEqual(low.estimatesByMetric, repeated.estimatesByMetric, "joint tensor completion must be deterministic");
assert.equal(
  low.estimatesByMetric.get("cpu_percent").get(key("0", "P01-S01")),
  10,
  "directly observed target values must be locked",
);
assert.equal(
  low.estimatesByMetric.get("queue_depth").get(key("1", "P02-S01")),
  3.5,
  "directly observed auxiliary values must be locked",
);
assert.equal(
  low.estimatesByMetric.get("cpu_percent").has(inactiveKey),
  false,
  "inactive object-time cells must not be completed",
);

const missingTargetKey = key("1", "P02-S01");
const lowPrediction = low.estimatesByMetric.get("cpu_percent").get(missingTargetKey);
const highPrediction = high.estimatesByMetric.get("cpu_percent").get(missingTargetKey);
assert.ok(Number.isFinite(lowPrediction) && Number.isFinite(highPrediction));
assert.ok(
  Math.abs(lowPrediction - highPrediction) > 1e-8,
  "changing only an observed auxiliary metric must influence a missing target-metric prediction",
);

assert.equal(low.diagnostics.tensor_shape, "3x3x2");
assert.equal(low.diagnostics.normalization_source, "direct-observations-only");
assert.equal(low.diagnostics.observed_cells, targetObserved.size + auxiliaryLow.size - 1);
assert.ok(low.diagnostics.parameter_count > 0);
assert.ok(Number.isFinite(low.diagnostics.final_observed_loss));
assert.equal(low.diagnostics.hidden_truth_used, false);
assert.equal(low.diagnostics.numerical_stability_guard, true);
assert.equal(low.diagnostics.non_finite_prediction_fallback_cells, 0);
assert.equal(low.diagnostics.adaptive_trust_gate, true);
assert.ok(low.diagnostics.observation_density > 0 && low.diagnostics.observation_density <= 1);
assert.ok(low.diagnostics.observation_density_confidence > 0 && low.diagnostics.observation_density_confidence <= 1);
assert.equal(low.diagnostics.metric_fit_quality.length, 2);
for (const metric of low.diagnostics.metric_fit_quality) {
  assert.ok(metric.observed_normalized_rmse >= 0);
  assert.ok(metric.fit_confidence >= 0 && metric.fit_confidence <= 1);
  assert.ok(metric.mean_effective_joint_weight >= 0);
  assert.ok(metric.mean_effective_joint_weight <= low.diagnostics.joint_prediction_weight);
}

console.log(JSON.stringify({
  ok: true,
  tensor_shape: low.diagnostics.tensor_shape,
  observed_cells: low.diagnostics.observed_cells,
  target_prediction_aux_low: lowPrediction,
  target_prediction_aux_high: highPrediction,
  cross_metric_delta: Math.abs(lowPrediction - highPrediction),
}, null, 2));
