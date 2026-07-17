import assert from "node:assert/strict";

import {
  aggregateContributionSamples,
  buildContributionSamples,
  buildDynamicityInteractions,
} from "./experiments/dynamicAblationStatistics.mjs";

const rows = [
  { profile_id: "p", stress_rate: 0, seed: "s0", method_id: "full-enhanced", cpu_mae: 1, link_status_accuracy: 0.9 },
  { profile_id: "p", stress_rate: 0, seed: "s0", method_id: "without-x", cpu_mae: 2, link_status_accuracy: 0.8 },
  { profile_id: "p", stress_rate: 0.25, seed: "s0", method_id: "full-enhanced", cpu_mae: 1, link_status_accuracy: 0.9 },
  { profile_id: "p", stress_rate: 0.25, seed: "s0", method_id: "without-x", cpu_mae: 4, link_status_accuracy: 0.6 },
  { profile_id: "p", stress_rate: 0, seed: "s1", method_id: "full-enhanced", cpu_mae: 2, link_status_accuracy: 0.8 },
  { profile_id: "p", stress_rate: 0, seed: "s1", method_id: "without-x", cpu_mae: 4, link_status_accuracy: 0.7 },
  { profile_id: "p", stress_rate: 0.25, seed: "s1", method_id: "full-enhanced", cpu_mae: 2, link_status_accuracy: 0.8 },
  { profile_id: "p", stress_rate: 0.25, seed: "s1", method_id: "without-x", cpu_mae: 6, link_status_accuracy: 0.5 },
];

const options = {
  fullMethodId: "full-enhanced",
  ablationMethodIds: ["without-x"],
  metricDirections: { cpu_mae: "lower", link_status_accuracy: "higher" },
};
const samples = buildContributionSamples(rows, options);

assert.equal(samples.length, 8);
assert.equal(
  samples.find((row) => row.metric === "cpu_mae" && row.stress_rate === 0 && row.seed === "s0").contribution,
  1,
);
assert.equal(
  samples.find((row) => row.metric === "link_status_accuracy" && row.stress_rate === 0.25 && row.seed === "s0").contribution,
  0.3,
);

const aggregates = aggregateContributionSamples(samples);
const cpuStatic = aggregates.find((row) => row.metric === "cpu_mae" && row.stress_rate === 0);
assert.equal(cpuStatic.sample_count, 2);
assert.equal(cpuStatic.contribution_mean, 1.5);
assert.equal(cpuStatic.contribution_std, 0.707107);
assert.equal(cpuStatic.cohen_dz, 2.12132);

const interactions = buildDynamicityInteractions(samples, { lowStress: 0, highStress: 0.25 });
const cpuInteraction = interactions.find((row) => row.metric === "cpu_mae");
assert.equal(cpuInteraction.sample_count, 2);
assert.equal(cpuInteraction.interaction_mean, 2);
assert.equal(cpuInteraction.interaction_std, 0);
assert.equal(cpuInteraction.interaction_ci95_low, 2);
assert.equal(cpuInteraction.interaction_ci95_high, 2);

assert.throws(
  () => buildContributionSamples(rows.slice(0, -1), options),
  /Missing ablation pair/,
);
assert.throws(
  () => buildDynamicityInteractions(samples.filter((row) => !(row.seed === "s1" && row.stress_rate === 0.25)), {
    lowStress: 0,
    highStress: 0.25,
  }),
  /Missing dynamicity pair/,
);

console.log("Dynamic ablation statistics tests passed.");
