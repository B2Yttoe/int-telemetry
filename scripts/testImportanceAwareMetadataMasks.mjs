import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  DEFAULT_SELECTIVE_METADATA_PROFILE,
  buildPathMetadataPlan,
} from "../stage2-int/tools/importance-aware-telemetry.mjs";

const plan = buildPathMetadataPlan({
  pathNodes: ["P01-S01", "P01-S02", "P02-S02", "P02-S03"],
  pathLinks: ["L1", "L2", "L3"],
  nodeTargets: new Set(["P01-S02"]),
  linkTargets: new Set(["L2"]),
  observedNodes: new Set(),
  observedLinks: new Set(["L3"]),
  fieldProfile: DEFAULT_SELECTIVE_METADATA_PROFILE,
});

assert.deepEqual(
  plan.hops.map((hop) => hop.profile),
  ["link-light", "node-full", "forward-only", "forward-only"],
  "metadata profiles should reflect target value and already-covered observations",
);

const light = plan.hops[0];
assert.equal(light.writes_observation, true);
assert.deepEqual(light.node_fields_present, []);
assert.deepEqual(
  light.link_fields_present,
  ["link_id", "status", "is_active", "utilization_percent", "queue_latency_ms"],
);

const full = plan.hops[1];
assert.equal(full.writes_observation, true);
assert.ok(full.node_fields_present.includes("cpu_percent"));
assert.ok(full.node_fields_present.includes("energy_percent"));
assert.ok(full.link_fields_present.includes("dropped_traffic_mb"));
assert.equal(full.metadata_bytes, 96);

assert.equal(plan.hops[2].writes_observation, false);
assert.equal(plan.hops[2].metadata_bytes, 0);
assert.equal(plan.hops[3].writes_observation, false);
assert.equal(plan.target_mask_bytes, 6, "four three-bit hop profiles plus a four-byte instruction header require six bytes");
assert.equal(plan.metadata_bytes, 116);
assert.equal(plan.total_payload_bytes, 122);
assert.equal(plan.all_full_payload_bytes, 390);
assert.equal(plan.saved_payload_bytes, 268);
assert.ok(plan.total_payload_bytes < plan.all_full_payload_bytes);

const repeated = buildPathMetadataPlan({
  pathNodes: ["A", "B", "C"],
  pathLinks: ["X", "Y"],
  nodeTargets: new Set(["B"]),
  linkTargets: new Set(["Y"]),
  observedNodes: new Set(["B"]),
  observedLinks: new Set(["X", "Y"]),
});
assert.ok(
  repeated.hops.every((hop) => hop.profile === "forward-only"),
  "already observed targets should not emit duplicate metadata in the same slice",
);
assert.ok(repeated.target_mask_bytes > 0, "forward-only probes still carry a control mask");

const repairOnly = buildPathMetadataPlan({
  pathNodes: ["A", "B", "C"],
  pathLinks: ["X", "Y"],
  nodeTargets: new Set(["B"]),
  linkTargets: new Set(),
  preserveNonTargetLinks: false,
});
assert.deepEqual(
  repairOnly.hops.map((hop) => hop.profile),
  ["forward-only", "node-full", "forward-only"],
  "an additive repair probe must skip metadata on pure transit links and write only its nominated target",
);
assert.deepEqual(repairOnly.hops[1].link_fields_present, []);

const arrowLinkIds = buildPathMetadataPlan({
  pathNodes: "P01-S01 > P01-S02 > P02-S02",
  pathLinks: "intra-plane:P01-S01->P01-S02 > inter-plane:P01-S02->P02-S02",
  preserveCoreLinkMetrics: true,
});
assert.deepEqual(
  arrowLinkIds.hops.map((hop) => hop.egress_link_id),
  ["intra-plane:P01-S01->P01-S02", "inter-plane:P01-S02->P02-S02", ""],
  "the path delimiter must not split the -> arrow embedded in a physical link id",
);

const configured = JSON.parse(await readFile("stage2-int/config/telemetry-fields.json", "utf8"));
assert.equal(configured.selective_metadata_profiles.node_full.bytes, 96);
assert.equal(configured.selective_metadata_profiles.node_core.bytes, 32);
assert.equal(configured.selective_metadata_profiles.link_full.bytes, 48);
assert.equal(configured.selective_metadata_profiles.link_core.bytes, 48);
assert.equal(configured.selective_metadata_profiles.link_light.bytes, 20);
assert.equal(configured.selective_metadata_profiles.forward_only.bytes, 0);
assert.equal(configured.selective_metadata_control.instruction_header_bytes, 4);
assert.equal(configured.selective_metadata_control.profile_bits_per_hop, 3);

console.log(JSON.stringify({
  ok: true,
  profiles: plan.hops.map((hop) => hop.profile),
  metadata_bytes: plan.metadata_bytes,
  target_mask_bytes: plan.target_mask_bytes,
  saved_payload_bytes: plan.saved_payload_bytes,
}, null, 2));
