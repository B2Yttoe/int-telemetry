import assert from "node:assert/strict";
import {
  buildMultiSeedMatrix,
  addPairedBaselineDeltas,
  summarizeConfidenceInterval,
} from "./runExperiment8MultiSeedRobustness.mjs";

const constant = summarizeConfidenceInterval([2, 2, 2, 2]);
assert.deepEqual(constant, { count: 4, mean: 2, standard_deviation: 0, ci95_low: 2, ci95_high: 2 });
const varied = summarizeConfidenceInterval([1, 2, 3, 4]);
assert.equal(varied.count, 4);
assert.equal(varied.mean, 2.5);
assert.ok(varied.ci95_low < varied.mean && varied.ci95_high > varied.mean);

const matrix = buildMultiSeedMatrix({
  profileIds: ["small", "medium", "large"],
  stressRates: [0, 0.05, 0.1, 0.15, 0.2, 0.25],
  seedCount: 30,
});
assert.equal(matrix.length, 540);
assert.equal(new Set(matrix.map((row) => row.seed)).size, 30);

const paired = addPairedBaselineDeltas([
  { profile_id: "small", seed: "a", stress_rate: 0, path_failure_ratio: 0.2 },
  { profile_id: "small", seed: "a", stress_rate: 0.25, path_failure_ratio: 0.5 },
  { profile_id: "small", seed: "b", stress_rate: 0, path_failure_ratio: 0.1 },
  { profile_id: "small", seed: "b", stress_rate: 0.25, path_failure_ratio: 0.2 },
]);
assert.deepEqual(paired.map((row) => row.excess_path_failure_ratio), [0, 0.3, 0, 0.1]);

console.log("Experiment 8 multi-seed robustness tests passed.");
