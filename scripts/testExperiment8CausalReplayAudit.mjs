import assert from "node:assert/strict";
import {
  auditCausalReplay,
  buildControlledOutageSchedule,
  compareCausalResponse,
} from "./experiments/dynamicityCausalReplay.mjs";

const transformedLinks = [
  { slice_index: "0", link_id: "L1", is_active: "false", restriction_reason: "experiment8-controlled-dynamicity", carried_traffic_mbps: "0" },
  { slice_index: "0", link_id: "L2", is_active: "true", restriction_reason: "", carried_traffic_mbps: "10" },
  { slice_index: "1", link_id: "L1", is_active: "true", restriction_reason: "", carried_traffic_mbps: "5" },
];

assert.deepEqual(buildControlledOutageSchedule(transformedLinks), {
  schema_version: "int-telemetry-controlled-link-outage/v1",
  reason: "experiment8-controlled-dynamicity",
  forced_down_link_ids_by_slice: { "0": ["L1"] },
});

const valid = auditCausalReplay({
  links: transformedLinks,
  routes: [{ slice_index: "0", task_id: "T1", status: "routed", link_ids: "L2" }],
  taskTraces: [{ slice_index: "0", task_id: "T1", status: "routed", link_ids: "L2" }],
});
assert.equal(valid.ok, true);
assert.equal(valid.invalid_route_count, 0);
assert.equal(valid.invalid_task_trace_count, 0);
assert.equal(valid.forced_down_nonzero_count, 0);

const arrowIdsRemainAtomic = auditCausalReplay({
  links: [
    { slice_index: "0", link_id: "inter-plane:A->B", is_active: "true", restriction_reason: "" },
    { slice_index: "0", link_id: "inter-plane:B->C", is_active: "false", restriction_reason: "experiment8-controlled-dynamicity", carried_traffic_mbps: "0", effective_capacity_mbps: "0" },
  ],
  routes: [{ slice_index: "0", task_id: "T-arrow", status: "routed", link_ids: "inter-plane:A->B" }],
  taskTraces: [],
});
assert.equal(arrowIdsRemainAtomic.ok, true, "the -> inside a link id is not a path delimiter");

const invalid = auditCausalReplay({
  links: transformedLinks,
  routes: [{ slice_index: "0", task_id: "T1", status: "routed", link_ids: "L1" }],
  taskTraces: [{ slice_index: "0", task_id: "T1", status: "routed", link_ids: "L1" }],
});
assert.equal(invalid.ok, false);
assert.equal(invalid.invalid_route_count, 1);
assert.equal(invalid.invalid_task_trace_count, 1);

const response = compareCausalResponse({
  baselineNodes: [{ slice_index: "0", node_id: "A", cpu_utilization: "10", queued_traffic_mb: "0" }],
  replayNodes: [{ slice_index: "0", node_id: "A", cpu_utilization: "12", queued_traffic_mb: "5" }],
  baselineLinks: [{ slice_index: "0", link_id: "L1", utilization_percent: "20" }],
  replayLinks: [{ slice_index: "0", link_id: "L1", utilization_percent: "0" }],
  baselineRoutes: [{ slice_index: "0", task_id: "T1", link_ids: "L1" }],
  replayRoutes: [{ slice_index: "0", task_id: "T1", link_ids: "L2" }],
});
assert.equal(response.changed_node_ratio, 1);
assert.equal(response.changed_link_ratio, 1);
assert.equal(response.changed_route_ratio, 1);

console.log("Experiment 8 causal replay audit tests passed.");
