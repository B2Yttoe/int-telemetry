import assert from "node:assert/strict";
import { auditStrictCausalReplay } from "./experiments/topologyVersionedCausalExperiment.mjs";

const valid = auditStrictCausalReplay({
  manifest: {
    feedback_lag_slices: 1,
    truth_error_feedback_enabled: false,
    observability_mode: "oam-only",
  },
  selectorReport: {
    method: { causal_oam_boundary_enabled: true },
    coverage: { causal_feedback_violations: 0 },
  },
  feedbackRows: [
    { source_slice_index: 0, slice_index: 1, feedback_basis: "observable-uncertainty" },
    { source_slice_index: 5, slice_index: 7, feedback_basis: "state-age" },
  ],
  plannerRows: [
    { planner_state_source_slice_index: "", slice_index: 0 },
    { planner_state_source_slice_index: 3, slice_index: 4 },
  ],
});

assert.equal(valid.passed, true);
assert.equal(valid.violation_count, 0);
assert.ok(valid.checks.every((check) => check.passed));

const sameSlice = auditStrictCausalReplay({
  manifest: { feedback_lag_slices: 1, truth_error_feedback_enabled: false, observability_mode: "oam-only" },
  selectorReport: { method: { causal_oam_boundary_enabled: true }, coverage: { causal_feedback_violations: 0 } },
  feedbackRows: [{ source_slice_index: 4, slice_index: 4, feedback_basis: "observable-uncertainty" }],
  plannerRows: [{ planner_state_source_slice_index: 6, slice_index: 6 }],
});

assert.equal(sameSlice.passed, false);
assert.equal(sameSlice.violation_count, 2);
assert.ok(sameSlice.violations.every((violation) => violation.reason === "non-causal-source-slice"));

const truthLeak = auditStrictCausalReplay({
  manifest: { feedback_lag_slices: 0, truth_error_feedback_enabled: true, observability_mode: "full-truth" },
  selectorReport: { method: { causal_oam_boundary_enabled: false }, coverage: { causal_feedback_violations: 1 } },
  feedbackRows: [{ source_slice_index: 0, slice_index: 1, feedback_basis: "truth-error" }],
  plannerRows: [],
});

assert.equal(truthLeak.passed, false);
assert.ok(truthLeak.checks.find((check) => check.id === "truth-error-feedback-disabled")?.passed === false);
assert.ok(truthLeak.checks.find((check) => check.id === "minimum-feedback-lag")?.passed === false);
assert.ok(truthLeak.checks.find((check) => check.id === "oam-only-observability")?.passed === false);
assert.ok(truthLeak.checks.find((check) => check.id === "selector-causal-boundary")?.passed === false);

console.log("Experiment 12 causal audit tests passed.");
