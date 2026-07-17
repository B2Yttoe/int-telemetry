import assert from "node:assert/strict";
import {
  buildPathMetadataPlan,
  buildRotatingPlaneRepresentatives,
  selectBudgetNeutralImportanceReplacements,
} from "../stage2-int/tools/importance-aware-telemetry.mjs";

const replacement = selectBudgetNeutralImportanceReplacements({
  baseRows: [
    {
      probe_id: "base-high",
      path: "P01-S01 > P01-S02",
      link_ids: "L1",
      importance_base_value: 1,
      importance_budget_bytes: 400,
    },
    {
      probe_id: "base-low",
      path: "P02-S01 > P02-S02",
      link_ids: "L2",
      importance_base_value: 0.5,
      importance_budget_bytes: 400,
    },
  ],
  candidateRows: [
    {
      probe_id: "target-efficient",
      path: "P02-S01 > P02-S02 > P03-S02",
      link_ids: "L2 > L3",
      importance_base_value: 0.49,
      importance_budget_bytes: 400,
    },
    {
      probe_id: "target-too-expensive",
      path: "P03-S02 > P03-S03",
      link_ids: "L4",
      importance_base_value: 0.6,
      importance_budget_bytes: 500,
    },
  ],
  targets: [{
    target_type: "node",
    target_id: "P03-S02",
    importance_score: 0.9,
    coverage_required: true,
    aoi_debt_severity: 2,
  }],
  maxTotalBytes: 800,
  maxReplacements: 1,
  maxBaseValueLossRatio: 0.05,
});

assert.equal(replacement.rows.length, 2, "replacement must preserve the total path count");
assert.deepEqual(replacement.rows.map((row) => row.probe_id), ["base-high", "target-efficient"]);
assert.equal(replacement.replacements.length, 1);
assert.equal(replacement.replacements[0].removed_probe_id, "base-low");
assert.equal(replacement.replacements[0].added_probe_id, "target-efficient");
assert.deepEqual(replacement.replacements[0].lost_direct_node_ids, []);
assert.deepEqual(replacement.replacements[0].lost_direct_link_ids, []);
assert.ok(replacement.after_bytes <= replacement.before_bytes);
assert.ok(replacement.after_bytes <= 800);
assert.ok(replacement.after_weighted_target_coverage > replacement.before_weighted_target_coverage);

const planes = [1, 2, 3].flatMap((plane) => [1, 2, 3, 4].map((slot) => ({
  node_id: `P${String(plane).padStart(2, "0")}-S${String(slot).padStart(2, "0")}`,
  plane_id: plane - 1,
  slot_id: slot - 1,
})));
const representatives0 = buildRotatingPlaneRepresentatives({ nodes: planes, sliceIndex: 0 });
const representatives1 = buildRotatingPlaneRepresentatives({ nodes: planes, sliceIndex: 1 });
const proportionalRepresentatives = buildRotatingPlaneRepresentatives({
  nodes: planes,
  sliceIndex: 0,
  representativeRatio: 0.5,
});
assert.equal(representatives0.size, 3);
assert.equal(representatives1.size, 3);
assert.equal([...representatives0].every((nodeId) => representatives1.has(nodeId)), false);
assert.equal(proportionalRepresentatives.size, 6);
assert.deepEqual(
  [...representatives0].map((nodeId) => nodeId.match(/P(\d+)-/)[1]).sort(),
  ["01", "02", "03"],
  "every orbit plane must contribute exactly one representative",
);

const strictMetadata = buildPathMetadataPlan({
  pathNodes: ["P01-S01", "P01-S02", "P02-S02", "P02-S03"],
  pathLinks: ["L1", "L2", "L3"],
  nodeTargets: new Set(["P01-S02"]),
  linkTargets: new Set(["L3"]),
  representativeNodes: new Set(["P02-S03"]),
  preserveCoreNodeCoverage: false,
  preserveCoreLinkMetrics: false,
  preserveNonTargetLinks: true,
});
assert.deepEqual(
  strictMetadata.hops.map((hop) => hop.profile),
  ["link-light", "node-full", "link-full", "node-core"],
);
assert.equal(strictMetadata.hops[0].node_fields_present.length, 0);
assert.equal(strictMetadata.hops[0].metadata_bytes, 20);
assert.equal(strictMetadata.hops[2].node_fields_present.length, 0);
assert.ok(strictMetadata.hops[3].node_fields_present.includes("cpu_percent"));

console.log("Budget-neutral importance telemetry tests passed.");
