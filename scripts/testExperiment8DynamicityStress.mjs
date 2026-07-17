import assert from "node:assert/strict";
import {
  maximumActiveDegree,
  topologyDynamicity,
  transformDynamicityTrace,
} from "./experiments/dynamicityStress.mjs";

function link({ slice, id, source, target, kind, active = true }) {
  return {
    slice_index: String(slice),
    time: `2026-07-11T00:${String(slice).padStart(2, "0")}:00.000Z`,
    link_id: id,
    source,
    target,
    kind,
    status: active ? "up" : "down",
    is_active: String(active),
    restriction_reason: active ? "" : "fixture-down",
    effective_capacity_mbps: active ? "100" : "0",
    carried_traffic_mbps: active ? "20" : "0",
    utilization_percent: active ? "20" : "0",
  };
}

function fixtureLinks() {
  const rows = [];
  for (let slice = 0; slice < 6; slice += 1) {
    rows.push(
      link({ slice, id: "intra:A-B", source: "A", target: "B", kind: "intra-plane" }),
      link({ slice, id: "intra:C-D", source: "C", target: "D", kind: "intra-plane" }),
      link({ slice, id: "inter:A-C", source: "A", target: "C", kind: "inter-plane" }),
      link({ slice, id: "inter:B-D", source: "B", target: "D", kind: "inter-plane" }),
      link({ slice, id: "inter:A-D", source: "A", target: "D", kind: "inter-plane" }),
      link({ slice, id: "inter:B-C", source: "B", target: "C", kind: "inter-plane" }),
    );
  }
  return rows;
}

const metric = topologyDynamicity(
  [
    { link_id: "a", is_active: "true" },
    { link_id: "b", is_active: "true" },
  ],
  [
    { link_id: "b", is_active: "true" },
    { link_id: "c", is_active: "true" },
  ],
);
assert.equal(metric.jaccard_similarity, 1 / 3);
assert.ok(Math.abs(metric.dynamicity - 2 / 3) < 1e-12);

const links = fixtureLinks();
const first = transformDynamicityTrace({
  links,
  targetStressRate: 0.25,
  seed: "experiment8-test",
  tolerance: 0.05,
});
const second = transformDynamicityTrace({
  links,
  targetStressRate: 0.25,
  seed: "experiment8-test",
  tolerance: 0.05,
});

assert.deepEqual(first, second, "same seed must produce byte-equivalent output");

const seededA = transformDynamicityTrace({
  links,
  targetStressRate: 0.25,
  seed: "transition-a",
  initialMaskSeed: "shared-initial-mask",
  tolerance: 0.05,
});
const seededB = transformDynamicityTrace({
  links,
  targetStressRate: 0.25,
  seed: "transition-b",
  initialMaskSeed: "shared-initial-mask",
  tolerance: 0.05,
});
const activeSignature = (rows, slice) => rows
  .filter((row) => Number(row.slice_index) === slice && row.is_active === "true")
  .map((row) => row.link_id)
  .sort();
assert.deepEqual(activeSignature(seededA.links, 0), activeSignature(seededB.links, 0));
assert.notDeepEqual(
  [1, 2, 3, 4, 5].map((slice) => activeSignature(seededA.links, slice)),
  [1, 2, 3, 4, 5].map((slice) => activeSignature(seededB.links, slice)),
  "different transition seeds should be able to produce distinct post-T00 churn schedules",
);
assert.ok(
  Math.abs(first.summary.achieved_stress_rate - 0.25) <= 0.05,
  `stress ${first.summary.achieved_stress_rate} must approach requested 0.25`,
);
assert.ok(first.summary.achieved_mean_dynamicity >= 0, "actual Jaccard dynamicity remains an observed outcome");
assert.ok(first.mutations.length > 0, "controlled stress must emit an audit row for every mutation");
assert.equal(first.bySlice.length, 6);

const originalIntra = links.filter((row) => row.kind === "intra-plane");
const transformedIntra = first.links.filter((row) => row.kind === "intra-plane");
assert.deepEqual(transformedIntra, originalIntra, "intra-plane links are immutable");
assert.ok(maximumActiveDegree(first.links) <= 4, "active ISL degree must remain within four antennas");
assert.equal(
  first.links.some((row) => row.kind === "inter-plane" && row.restriction_reason === "experiment8-controlled-dynamicity"),
  true,
);

const lowStructuredStress = transformDynamicityTrace({
  links,
  targetStressRate: 0.05,
  seed: "structured-stress",
  tolerance: 0.06,
});
const staticStructuredStress = transformDynamicityTrace({
  links,
  targetStressRate: 0,
  seed: "structured-stress",
  tolerance: 0.001,
});
const highStructuredStress = transformDynamicityTrace({
  links,
  targetStressRate: 0.25,
  seed: "structured-stress",
  tolerance: 0.05,
});
assert.ok(
  highStructuredStress.summary.achieved_controlled_churn_rate > lowStructuredStress.summary.achieved_controlled_churn_rate,
  "higher stress must produce more controlled inter-plane churn",
);
assert.equal(staticStructuredStress.summary.achieved_controlled_churn_rate, 0);
assert.ok(staticStructuredStress.summary.mean_forced_down_fraction > 0, "0% churn control retains the fixed outage density");
assert.ok(
  Math.abs(staticStructuredStress.summary.mean_forced_down_fraction - highStructuredStress.summary.mean_forced_down_fraction) < 1e-12,
  "0% churn and dynamic groups must use the same forced-down density",
);
assert.ok(
  Math.abs(lowStructuredStress.summary.mean_forced_down_fraction - highStructuredStress.summary.mean_forced_down_fraction) < 1e-12,
  "all stress levels must preserve the same mean forced-down density",
);

assert.throws(
  () => transformDynamicityTrace({ links, targetStressRate: 1.1, seed: "invalid", tolerance: 0.001 }),
  /within \[0, 1\]/i,
  "invalid stress rates must be rejected",
);

console.log("Experiment 8 dynamicity stress tests passed.");
