import assert from "node:assert/strict";

import {
  ADDITIONAL_COMPLETION_BACKENDS,
  completeWithAdditionalBackend,
  softThresholdSpectrum,
} from "../stage2-int/tools/int-mc-additional-completion-backends.mjs";

assert.deepEqual(
  [...ADDITIONAL_COMPLETION_BACKENDS].sort(),
  ["graph-neighbor", "graph-regularized", "kalman-smoother", "prior-only", "soft-impute"],
  "the additional backend registry must expose the five classical experiment-3 methods",
);

assert.deepEqual(
  softThresholdSpectrum([5, 2, 0.5], 1),
  [4, 1, 0],
  "Soft-Impute must apply the nuclear-norm proximal operator to singular values",
);

const matrix = [
  [1, 2, 3],
  [8, 0, 8],
  [9, 10, 11],
];
const activeMask = [
  [true, true, true],
  [true, true, false],
  [true, true, true],
];
const observedMask = [
  [true, true, true],
  [true, false, false],
  [true, true, true],
];

const priorOnly = completeWithAdditionalBackend({
  backend: "prior-only",
  matrix,
  activeMask,
  observedMask,
  rank: 2,
  iterations: 4,
  neighborRows: [[1], [0, 2], [1]],
});
assert.equal(priorOnly.completed[0][0], 1, "prior-only must preserve observed entries");
assert.equal(priorOnly.completed[1][1], 0, "prior-only must retain the supplied structural prior");
assert.equal(priorOnly.completed[1][2], 0, "inactive cells must remain zero");
assert.equal(priorOnly.diagnostics.completion_algorithm, "structural-prior-only");

const softImpute = completeWithAdditionalBackend({
  backend: "soft-impute",
  matrix,
  activeMask,
  observedMask,
  rank: 2,
  iterations: 5,
  neighborRows: [[1], [0, 2], [1]],
  options: { softImputeLambdaRatio: 0.08 },
});
assert.equal(softImpute.completed[0][0], 1, "Soft-Impute must lock observed entries after every iteration");
assert.equal(softImpute.completed[1][2], 0, "Soft-Impute must respect the active mask");
assert.ok(Number.isFinite(softImpute.completed[1][1]), "Soft-Impute must produce finite missing-cell estimates");
assert.ok(softImpute.diagnostics.effective_rank <= 2, "Soft-Impute must respect the configured rank cap");

const kalmanSmoother = completeWithAdditionalBackend({
  backend: "kalman-smoother",
  matrix: [[0, 0, 10, 5]],
  activeMask: [[true, true, true, false]],
  observedMask: [[true, false, true, false]],
  options: {
    kalmanProcessVariance: 0.05,
    kalmanMeasurementVariance: 0.1,
    kalmanInitialVariance: 1,
  },
});
assert.equal(kalmanSmoother.completed[0][0], 0, "Kalman/RTS must lock the first observation");
assert.equal(kalmanSmoother.completed[0][2], 10, "Kalman/RTS must lock the last observation");
assert.equal(kalmanSmoother.completed[0][3], 0, "Kalman/RTS must lock topology-down cells");
assert.ok(
  kalmanSmoother.completed[0][1] > 0 && kalmanSmoother.completed[0][1] < 10,
  "RTS smoothing must interpolate a missing temporal state between delivered observations",
);
assert.equal(kalmanSmoother.diagnostics.uses_future_delivered_observations, true);
assert.equal(kalmanSmoother.diagnostics.online_causal, false);

const graphNeighbor = completeWithAdditionalBackend({
  backend: "graph-neighbor",
  matrix,
  activeMask,
  observedMask,
  iterations: 6,
  neighborRows: [[1], [0, 2], [1]],
  options: { graphWeight: 0.8, priorWeight: 0.2 },
});
assert.equal(graphNeighbor.completed[0][1], 2, "graph-neighbor must lock observed entries");
assert.equal(graphNeighbor.completed[1][2], 0, "graph-neighbor must lock topology-down cells");
assert.ok(graphNeighbor.completed[1][1] > 0, "graph-neighbor must interpolate from active same-slice neighbors");
assert.equal(graphNeighbor.diagnostics.temporal_information_used, false);
assert.equal(graphNeighbor.diagnostics.low_rank_information_used, false);

const graphRegularized = completeWithAdditionalBackend({
  backend: "graph-regularized",
  matrix,
  activeMask,
  observedMask,
  rank: 2,
  iterations: 8,
  neighborRows: [[1], [0, 2], [1]],
  options: {
    graphWeight: 0.55,
    temporalWeight: 0.1,
    priorWeight: 0.2,
    lowRankWeight: 0.15,
  },
});
assert.equal(graphRegularized.completed[0][1], 2, "graph regularization must preserve observed entries");
assert.equal(graphRegularized.completed[1][2], 0, "graph regularization must preserve inactive cells");
assert.ok(
  graphRegularized.completed[1][1] > priorOnly.completed[1][1],
  "same-slice graph neighbors must raise a missing value above its zero prior",
);
assert.equal(graphRegularized.diagnostics.completion_algorithm, "graph-temporal-laplacian-regularized");

assert.throws(
  () => completeWithAdditionalBackend({ backend: "does-not-exist", matrix, activeMask, observedMask }),
  /Unsupported additional completion backend/,
);

console.log(JSON.stringify({
  ok: true,
  backends: [...ADDITIONAL_COMPLETION_BACKENDS],
  soft_impute_middle: softImpute.completed[1][1],
  kalman_smoothed_middle: kalmanSmoother.completed[0][1],
  graph_neighbor_middle: graphNeighbor.completed[1][1],
  graph_regularized_middle: graphRegularized.completed[1][1],
}, null, 2));
