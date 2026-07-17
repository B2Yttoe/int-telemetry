import assert from "node:assert/strict";
import { buildRadarBlindHoldout } from "./experiments/blindValidationMetrics.mjs";
import { validateRadarCausalityEvidence } from "./finalizeExperiment14BV2RadarCausality.mjs";

const hour = 3_600_000;
const calibrationStart = Date.parse("2026-07-09T04:00:00.000Z");
const calibration = Array.from({ length: 48 }, (_, index) => ({
  time: new Date(calibrationStart + index * hour).toISOString(),
  value: 0.5 + 0.2 * Math.sin((2 * Math.PI * index) / 24),
}));
const testStart = calibrationStart + 48 * hour;
const test = Array.from({ length: 24 }, (_, index) => ({
  time: new Date(testStart + index * hour).toISOString(),
  value: 0.52 + 0.2 * Math.sin((2 * Math.PI * (index + 48)) / 24),
}));
const parentRadar = {
  fit_fraction_within_calibration: 0.75,
  ridge_lambda: 0.000001,
  prediction_interval_coverage: 0.95,
  traffic_weight_min: 0.5,
  traffic_weight_max: 1.5,
};
const recomputed = buildRadarBlindHoldout([...calibration, ...test], {
  train_fraction: calibration.length / (calibration.length + test.length),
  fit_fraction_within_train: parentRadar.fit_fraction_within_calibration,
  ridge_lambda: parentRadar.ridge_lambda,
  prediction_interval_coverage: parentRadar.prediction_interval_coverage,
  traffic_weight_min: parentRadar.traffic_weight_min,
  traffic_weight_max: parentRadar.traffic_weight_max,
});
const score = { ...recomputed.summary, coefficients: recomputed.coefficients };
const freezeManifest = { windows: {
  radar_calibration_start: new Date(calibrationStart).toISOString(),
  radar_calibration_end: new Date(testStart - 1).toISOString(),
  radar_test_start: new Date(testStart).toISOString(),
  radar_test_end: new Date(testStart + 24 * hour).toISOString(),
} };
const collectionMetadata = {
  acquired_at: new Date(testStart + 24 * hour + 1000).toISOString(),
  calibration_points: calibration.length,
  test_points: test.length,
  timestamp_overlap: 0,
  test_values_used_for_fit: 0,
};
const addendum = { minimum_calibration_points: 24, minimum_test_points: 24, maximum_hourly_gap_seconds: 5400 };
const valid = validateRadarCausalityEvidence({
  calibration, test, collectionMetadata, score, freezeManifest, parentRadar, addendum,
});
assert.equal(valid.passed, true);
assert.equal(valid.score_coefficients_reproduced, true);

const overlapping = validateRadarCausalityEvidence({
  calibration,
  test: [{ ...test[0], time: calibration[0].time }, ...test.slice(1)],
  collectionMetadata,
  score,
  freezeManifest,
  parentRadar,
  addendum,
});
assert.equal(overlapping.passed, false);
assert.ok(overlapping.failures.includes("calibration-test-overlap"));
console.log("Experiment 14B v2 Radar causality tests passed.");
