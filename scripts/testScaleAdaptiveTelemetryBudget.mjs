import assert from "node:assert/strict";
import { buildScaleAdaptiveTelemetryBudget } from "../stage2-int/tools/scale-adaptive-telemetry-budget.mjs";

function fixture({ nodeCount, pathSpan = 8 }) {
  const nodes = Array.from({ length: nodeCount }, (_, index) => ({
    node_id: `P${String(Math.floor(index / 22) + 1).padStart(2, "0")}-S${String(index % 22 + 1).padStart(2, "0")}`,
  }));
  const activeLinks = nodes.map((node, index) => ({
    link_id: `L${index}`,
    source: node.node_id,
    target: nodes[(index + 1) % nodes.length].node_id,
    is_active: true,
  }));
  const candidatePaths = [];
  for (let start = 0; start < nodeCount; start += Math.max(2, Math.floor(pathSpan / 2))) {
    const pathNodes = Array.from({ length: Math.min(pathSpan, nodeCount) }, (_, offset) =>
      nodes[(start + offset) % nodes.length].node_id
    );
    const pathLinks = Array.from({ length: Math.max(0, pathNodes.length - 1) }, (_, offset) =>
      `L${(start + offset) % nodeCount}`
    );
    candidatePaths.push({
      probe_id: `probe-${start}`,
      path: pathNodes.join(" > "),
      link_ids: pathLinks.join(" > "),
    });
  }
  return { nodes, activeLinks, candidatePaths };
}

const common = {
  samplingRate: 0.25,
  targetActiveLinkSamplingRate: 0.25,
  legacyPathFloor: 12,
  hopMetadataBytes: 96,
  probePacketBaseBytes: 64,
  reportHeaderBytes: 128,
};

const small = buildScaleAdaptiveTelemetryBudget({ ...fixture({ nodeCount: 96 }), ...common });
const medium = buildScaleAdaptiveTelemetryBudget({ ...fixture({ nodeCount: 351 }), ...common });
const large = buildScaleAdaptiveTelemetryBudget({ ...fixture({ nodeCount: 1584 }), ...common });

assert.ok(small.target_node_count < medium.target_node_count);
assert.ok(medium.target_node_count < large.target_node_count);
assert.ok(small.derived_byte_budget < medium.derived_byte_budget);
assert.ok(medium.derived_byte_budget < large.derived_byte_budget);
assert.ok(small.safe_path_cap <= medium.safe_path_cap);
assert.ok(medium.safe_path_cap <= large.safe_path_cap);

const shortPaths = buildScaleAdaptiveTelemetryBudget({
  ...fixture({ nodeCount: 351, pathSpan: 4 }),
  ...common,
});
const longPaths = buildScaleAdaptiveTelemetryBudget({
  ...fixture({ nodeCount: 351, pathSpan: 16 }),
  ...common,
});
assert.ok(
  longPaths.witness_path_count <= shortPaths.witness_path_count,
  "higher-coverage paths must not require more witness paths",
);

const hardLimited = buildScaleAdaptiveTelemetryBudget({
  ...fixture({ nodeCount: 1584 }),
  ...common,
  explicitByteBudget: Math.floor(large.derived_byte_budget / 4),
});
assert.equal(hardLimited.byte_budget_source, "explicit-hard-cap");
assert.equal(hardLimited.byte_budget, Math.floor(large.derived_byte_budget / 4));
assert.equal(hardLimited.coverage_feasibility, "coverage-infeasible");
assert.ok(hardLimited.coverage_shortfall_nodes > 0 || hardLimited.coverage_shortfall_links > 0);

console.log(JSON.stringify({
  ok: true,
  small_budget: small.derived_byte_budget,
  medium_budget: medium.derived_byte_budget,
  large_budget: large.derived_byte_budget,
  small_path_cap: small.safe_path_cap,
  medium_path_cap: medium.safe_path_cap,
  large_path_cap: large.safe_path_cap,
}, null, 2));
