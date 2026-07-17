import assert from "node:assert/strict";

import {
  auditLinkPhysicalConsistency,
  auditNodePhysicalConsistency,
  projectLinkPhysicalConsistency,
  projectNodePhysicalConsistency,
} from "../stage2-int/tools/int-mc-physical-consistency.mjs";

const nodeRows = [
  { slice_index: 0, node_id: "N1", observation_source: "inferred", queue_depth_estimate: 10, queued_traffic_mb_estimate: 20, cache_used_mb_estimate: 15, energy_percent_estimate: 80 },
  { slice_index: 1, node_id: "N1", observation_source: "inferred", queue_depth_estimate: 5, queued_traffic_mb_estimate: 0, cache_used_mb_estimate: 1, energy_percent_estimate: 68 },
  { slice_index: 2, node_id: "N1", observation_source: "observed", queue_depth_estimate: 5, queued_traffic_mb_estimate: 0, cache_used_mb_estimate: 0, energy_percent_estimate: 20 },
  { slice_index: 0, node_id: "N2", observation_source: "inferred", queue_depth_estimate: 0, queued_traffic_mb_estimate: 0, cache_used_mb_estimate: 0, energy_percent_estimate: 60 },
  { slice_index: 1, node_id: "N2", observation_source: "inferred", queue_depth_estimate: 0, queued_traffic_mb_estimate: 0, cache_used_mb_estimate: 0, energy_percent_estimate: 58 },
];
const nodeAudit = auditNodePhysicalConsistency(nodeRows, { energyDeltaLimitPercentPerSlice: 5 });
assert.equal(nodeAudit.cache_covers_queued_traffic.violations, 1);
assert.equal(nodeAudit.positive_queue_has_traffic.violations, 1);
assert.equal(nodeAudit.energy_rate_bound.violations, 1);
assert.equal(nodeAudit.hidden_truth_fields_used, false);
assert.ok(nodeAudit.overall_violation_rate > 0);

const linkRows = [
  { observation_source: "inferred", contact_state: "active", queued_traffic_mb_estimate: 4, queue_latency_ms_estimate: 0, utilization_percent_estimate: 20, capacity_mbps_estimate: 100, route_traffic_mbps: 60, packet_error_rate_estimate: 0.1 },
  { observation_source: "inferred", contact_state: "active", queued_traffic_mb_estimate: 0, queue_latency_ms_estimate: 0, utilization_percent_estimate: 80, capacity_mbps_estimate: 100, route_traffic_mbps: 60, packet_error_rate_estimate: 1.2 },
  { observation_source: "observed", contact_state: "active", queued_traffic_mb_estimate: 10, queue_latency_ms_estimate: 0, utilization_percent_estimate: 0, capacity_mbps_estimate: 100, route_traffic_mbps: 90, packet_error_rate_estimate: 2 },
  { observation_source: "inferred", contact_state: "topology-down", queued_traffic_mb_estimate: 10, queue_latency_ms_estimate: 0, utilization_percent_estimate: 0, capacity_mbps_estimate: 0, route_traffic_mbps: 90, packet_error_rate_estimate: 0 },
];
const linkAudit = auditLinkPhysicalConsistency(linkRows);
assert.equal(linkAudit.queued_traffic_has_queue_latency.violations, 1);
assert.equal(linkAudit.route_load_utilization_floor.violations, 1);
assert.equal(linkAudit.packet_error_probability_bound.violations, 1);
assert.equal(linkAudit.inferred_active_samples, 2);
assert.equal(linkAudit.hidden_truth_fields_used, false);

const projectedNode = projectNodePhysicalConsistency({
  queue_depth: 3,
  queued_traffic_mb: 8,
  cache_used_mb: 2,
  energy_percent: 70,
}, {
  previousInferredEnergyPercent: 50,
  energyDeltaLimitPercentPerSlice: 5,
});
assert.equal(projectedNode.estimates.cache_used_mb, 8);
assert.equal(projectedNode.estimates.energy_percent, 55);
assert.equal(projectedNode.hidden_truth_used, false);

const projectedLink = projectLinkPhysicalConsistency({
  utilization_percent: 10,
  capacity_mbps: 100,
  queued_traffic_mb: 5,
  queue_latency_ms: 0,
  packet_error_rate: 2,
}, { routeTrafficMbps: 30 });
assert.equal(projectedLink.estimates.utilization_percent, 30);
assert.ok(projectedLink.estimates.queue_latency_ms > 0);
assert.equal(projectedLink.estimates.packet_error_rate, 1);
assert.equal(projectedLink.hidden_truth_used, false);

console.log(JSON.stringify({
  ok: true,
  node_violation_rate: nodeAudit.overall_violation_rate,
  link_violation_rate: linkAudit.overall_violation_rate,
}, null, 2));
