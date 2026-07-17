import assert from "node:assert/strict";
import {
  EXPERIMENT12_PROFILE_BUDGETS,
  EXPERIMENT12_PROFILE_IDS,
  buildExperiment12Matrix,
  buildExperiment12Variants,
  validateVariantLadder,
} from "./experiments/topologyVersionedCausalExperiment.mjs";

const variants = buildExperiment12Variants();

assert.deepEqual(EXPERIMENT12_PROFILE_IDS, [
  "telesat-1015-medium",
  "starlink-main-large",
]);
assert.equal(EXPERIMENT12_PROFILE_BUDGETS["telesat-1015-medium"], 435.7265);
assert.equal(EXPERIMENT12_PROFILE_BUDGETS["starlink-main-large"], 21.3359);
assert.deepEqual(variants.map((variant) => variant.id), [
  "full-unified",
  "no-topology-version",
  "no-risk",
  "no-marginal-information",
  "fixed-metadata",
]);

const planningFlags = [
  "plannerModes",
  "riskWeight",
  "informationGainMode",
  "metadataActions",
];
const expectedChangedFlags = [
  "plannerModes",
  "riskWeight",
  "informationGainMode",
  "metadataActions",
];

for (let index = 1; index < variants.length; index += 1) {
  const previous = variants[0].mechanisms;
  const current = variants[index].mechanisms;
  const changed = planningFlags.filter((flag) => previous[flag] !== current[flag]);
  assert.deepEqual(changed, [expectedChangedFlags[index - 1]]);
}

const frozenCompletionFlags = [
  "metricTensorCoupling",
  "nodeStateCoupling",
  "nodeEnergyPhysicsPrior",
  "jointStateCoupling",
  "orbitGraphRegularization",
  "orbitPeriodicPrior",
  "businessHotspotMigrationPrior",
  "stateTensorJointCompletion",
  "adaptiveProbeBudget",
  "multiObjectiveBudget",
  "oamTargetAwareMetadata",
];

for (const flag of frozenCompletionFlags) {
  assert.equal(new Set(variants.map((variant) => variant.mechanisms[flag])).size, 1, `${flag} must stay fixed`);
}

assert.deepEqual(validateVariantLadder(variants), {
  valid: true,
  errors: [],
  adjacent_changes: expectedChangedFlags,
  comparison_policy: "each-ablation-versus-full-unified",
});

const matrix = buildExperiment12Matrix({
  profileIds: EXPERIMENT12_PROFILE_IDS,
  stressRates: [0, 0.1, 0.25],
  variants,
});
assert.equal(matrix.length, 30);
assert.deepEqual(matrix[0], {
  profile_id: "telesat-1015-medium",
  stress_rate: 0,
  variant_id: "full-unified",
});
assert.deepEqual(matrix.at(-1), {
  profile_id: "starlink-main-large",
  stress_rate: 0.25,
  variant_id: "fixed-metadata",
});

const invalid = structuredClone(variants);
invalid[2].mechanisms.metadataActions = "full";
const invalidAudit = validateVariantLadder(invalid);
assert.equal(invalidAudit.valid, false);
assert.ok(invalidAudit.errors.some((message) => message.includes("no-risk")));

console.log("Experiment 12 variant definition tests passed.");
