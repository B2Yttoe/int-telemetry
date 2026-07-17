import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildDeployableCompletionPriorityRetests } from "../stage2-int/tools/int-mc-feedback.mjs";

const reconstructionRows = [
  {
    slice_index: 0,
    link_id: "inter-plane:P01-S01->P02-S01",
    observation_source: "inferred",
    confidence: 0.22,
    context_prior_risk: 0.6,
    state_tensor_joint_completion_pressure: 0.7,
    joint_state_coupling_pressure: 0.4,
    orbit_graph_regularization_strength: 0.2,
    business_hotspot_score: 0.5,
  },
];
const nodeRows = [
  {
    slice_index: 0,
    node_id: "P01-S01",
    observation_source: "inferred",
    confidence: 0.3,
    context_prior_risk: 0.55,
    node_state_coupling_pressure: 0.65,
    tensor_neighbor_count: 2,
  },
];

function build(hiddenError) {
  return buildDeployableCompletionPriorityRetests({
    reconstructionRows: reconstructionRows.map((row) => ({
      ...row,
      truth_utilization_percent: hiddenError,
      utilization_error: hiddenError,
    })),
    nodeReconstructionRows: nodeRows.map((row) => ({
      ...row,
      truth_cpu_percent: hiddenError,
      cpu_error: hiddenError,
    })),
    sliceIndexes: [0, 1],
    maxPerSlice: 24,
    oamQualityFeedbackEnabled: false,
  });
}

const lowError = build(1);
const highError = build(9999);
assert.deepEqual(highError, lowError, "deployable retest feedback must be invariant to hidden truth errors");
assert.equal(lowError.length, 2, "low-confidence inferred node and link should become deployable retest targets");
assert.ok(lowError.every((row) => row.feedback_basis === "observable-uncertainty"));
assert.ok(lowError.every((row) => !String(row.reason).includes("simulation-validation-error")));
assert.ok(lowError.every((row) => String(row.slice_index) === "1"), "feedback should target the next slice");

const reconstructorSource = await readFile(
  new URL("../stage2-int/tools/int-mc-reconstructor.mjs", import.meta.url),
  "utf8",
);
assert.ok(
  !reconstructorSource.includes("buildCompletionPriorityRetests") &&
    !reconstructorSource.includes("high-simulation-validation-error"),
  "deployment reconstructor must not retain the legacy truth-error feedback builder",
);

console.log(JSON.stringify({
  ok: true,
  deployable_targets: lowError.length,
  reasons: lowError.map((row) => row.reason),
}, null, 2));
