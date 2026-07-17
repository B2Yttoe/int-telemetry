import assert from "node:assert/strict";

import {
  buildMultiObjectiveBudgetControl,
  multiObjectivePathScore,
} from "../stage2-int/tools/multi-objective-budget-controller.mjs";

const stableSmall = buildMultiObjectiveBudgetControl({
  enabled: true,
  nodeCount: 66,
  configuredMaxPathsPerSlice: 12,
  baseScale: 1,
  nodeSamplingScale: 1,
  sliceTrafficRisk: 0.04,
  oamPressure: 0.08,
  driftPressure: 0.12,
  reuseConfidence: 0.86,
  reuseMargin: 0.09,
  stableWindow: 3,
  lowConfidencePressure: 0.05,
  conflictPressure: 0.02,
  retestPressure: 0.04,
});

assert.equal(stableSmall.enabled, true);
assert.ok(stableSmall.path_budget_scale >= 0.98, "stable small constellation should preserve path budget before reducing observations");
assert.ok(stableSmall.metadata_floor_ratio <= 0.58, "stable small constellation should allow stronger metadata compression");
assert.ok(stableSmall.cost_weight_scale > 1, "stable small constellation should favor lower telemetry cost");
assert.ok(stableSmall.quality_guard_pressure < 0.35, "stable case should not trigger quality guard");

const highQualityPressure = buildMultiObjectiveBudgetControl({
  enabled: true,
  nodeCount: 351,
  configuredMaxPathsPerSlice: 12,
  baseScale: 1,
  nodeSamplingScale: 1.37,
  sliceTrafficRisk: 0.28,
  oamPressure: 0.72,
  driftPressure: 0.44,
  reuseConfidence: 0.61,
  reuseMargin: 0.01,
  stableWindow: 0,
  lowConfidencePressure: 0.66,
  conflictPressure: 0.3,
  retestPressure: 0.58,
});

assert.ok(highQualityPressure.path_budget_scale >= 0.98, "quality pressure should preserve probe budget");
assert.ok(highQualityPressure.metadata_floor_ratio >= 0.62, "quality pressure should avoid overly aggressive metadata compression");
assert.ok(highQualityPressure.metadata_floor_ratio <= 0.72, "quality pressure should still allow field compression to reduce telemetry bytes");
assert.ok(highQualityPressure.node_state_weight_scale > stableSmall.node_state_weight_scale, "quality pressure should raise node-state sampling value");
assert.ok(highQualityPressure.quality_guard_pressure > stableSmall.quality_guard_pressure, "quality pressure should be visible to selector");

const score = multiObjectivePathScore({
  baseScore: 1,
  nodeInformationGain: 2,
  linkInformationGain: 1,
  telemetryCostBytes: 1200,
  localRisk: 0.4,
  control: highQualityPressure,
});

assert.ok(score.score > 1, "multi-objective score should reward high-value node/link paths");
assert.ok(score.cost_penalty > 0, "multi-objective score should expose telemetry cost penalty");
assert.ok(score.quality_bonus > 0, "multi-objective score should expose quality recovery bonus");

const shortEfficientPath = multiObjectivePathScore({
  baseScore: 1,
  nodeInformationGain: 2,
  linkInformationGain: 2,
  telemetryCostBytes: 1200,
  localRisk: 0.15,
  control: stableSmall,
});
const longExpensivePath = multiObjectivePathScore({
  baseScore: 1,
  nodeInformationGain: 2,
  linkInformationGain: 10,
  telemetryCostBytes: 10000,
  localRisk: 0.15,
  control: stableSmall,
});

assert.ok(
  shortEfficientPath.score > longExpensivePath.score,
  "multi-objective score should not prefer a much longer expensive path just because it has more aggregate link gain",
);

console.log(JSON.stringify({
  ok: true,
  stableSmall,
  highQualityPressure,
  score,
}, null, 2));
