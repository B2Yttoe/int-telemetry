import assert from "node:assert/strict";

import {
  EXPERIMENT11_FULL_METHOD_ID,
  EXPERIMENT11_VARIANT_IDS,
  buildExperiment11Variants,
} from "./experiments/dynamicAblationVariants.mjs";

const variants = buildExperiment11Variants();

assert.equal(EXPERIMENT11_FULL_METHOD_ID, "full-enhanced");
assert.equal(variants.length, 6);
assert.deepEqual(
  variants.map((variant) => variant.id),
  EXPERIMENT11_VARIANT_IDS,
);
assert.equal(new Set(variants.map((variant) => variant.id)).size, 6);

const full = variants[0].mechanisms;
assert.equal(full.adaptiveReuse, true);
assert.equal(full.incrementalTopologyRepair, true);
assert.equal(full.businessHotspotMigrationPrior, true);
assert.equal(full.orbitPeriodicPriorSlices, 19);

const topology = variants.find((variant) => variant.id === "without-topology-adaptation");
assert.equal(topology.mechanisms.adaptiveReuse, false);
assert.equal(topology.mechanisms.incrementalTopologyRepair, false);
assert.equal(topology.mechanisms.forecastRiskScoring, true);

const forecastOrbit = variants.find((variant) => variant.id === "without-forecast-orbit-priors");
assert.equal(forecastOrbit.mechanisms.forecastRiskScoring, false);
assert.equal(forecastOrbit.mechanisms.orbitGraphRegularization, false);
assert.equal(forecastOrbit.mechanisms.orbitPeriodicPrior, false);

const nodeState = variants.find((variant) => variant.id === "without-node-state-coupling");
assert.equal(nodeState.mechanisms.nodeStateCoupling, false);
assert.equal(nodeState.mechanisms.jointStateCoupling, false);

const energy = variants.find((variant) => variant.id === "without-energy-physics-prior");
assert.equal(energy.mechanisms.nodeEnergyPhysicsPrior, false);

const tensorTraffic = variants.find((variant) => variant.id === "without-tensor-traffic-context");
assert.equal(tensorTraffic.mechanisms.metricTensorCoupling, false);
assert.equal(tensorTraffic.mechanisms.stateTensorJointCompletion, false);
assert.equal(tensorTraffic.mechanisms.businessHotspotMigrationPrior, false);

assert.ok(
  variants.slice(1).every((variant) =>
    Object.keys(variant.mechanisms).some((key) => variant.mechanisms[key] !== full[key]),
  ),
);
assert.notEqual(variants[0].mechanisms, variants[1].mechanisms);
assert.ok(variants.every((variant) => Object.isFrozen(variant.mechanisms)));

console.log("Experiment 11 variant definition tests passed.");
