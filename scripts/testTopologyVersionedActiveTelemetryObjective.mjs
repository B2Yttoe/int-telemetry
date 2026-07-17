import assert from "node:assert/strict";
import {
  DEFAULT_TOPOLOGY_VERSIONED_OBJECTIVE_WEIGHTS,
  buildTopologyVersionId,
  chooseConservativeObjectiveCandidate,
  evaluateTopologyVersionedPathObjective,
} from "../stage2-int/tools/topology-versioned-active-telemetry.mjs";

const common = {
  enabled: true,
  topologyClassId: "TC-004",
  topologySignature: "abc12345",
  candidateSource: "topology-reuse-cache",
  planningRepairCount: 0,
  telemetryCost: {
    estimated_total_telemetry_bytes: 2048,
    estimated_total_telemetry_energy_j: 0.2,
  },
  costReferences: {
    bytes: 4096,
    energyJ: 0.4,
  },
  nodeInformationGain: 0.4,
  oamTargetScore: 0,
  metadataProfile: "standard",
  baselineRankingScore: 2,
  weights: DEFAULT_TOPOLOGY_VERSIONED_OBJECTIVE_WEIGHTS,
};

const highValue = evaluateTopologyVersionedPathObjective({
  ...common,
  linkSignals: [
    { link_id: "L1", uncertainty: 0.9, topology_risk: 0.8, age: 1, covered: false },
    { link_id: "L2", uncertainty: 0.8, topology_risk: 0.7, age: 0.9, covered: false },
  ],
});

const redundant = evaluateTopologyVersionedPathObjective({
  ...common,
  linkSignals: [
    { link_id: "L1", uncertainty: 0.9, topology_risk: 0.8, age: 1, covered: true },
    { link_id: "L2", uncertainty: 0.8, topology_risk: 0.7, age: 0.9, covered: true },
  ],
});

assert.ok(highValue.information_gain > redundant.information_gain, "new high-risk links must add more information");
assert.ok(highValue.objective_value < redundant.objective_value, "new high-risk links must lower the minimization objective");
assert.ok(highValue.conservative_score_adjustment > 0, "high-confidence benefit should conservatively promote a path");
assert.ok(
  Math.abs(highValue.conservative_score_adjustment) <= 0.12,
  "the objective must not make a large ranking change",
);

const expensive = evaluateTopologyVersionedPathObjective({
  ...common,
  telemetryCost: {
    estimated_total_telemetry_bytes: 16384,
    estimated_total_telemetry_energy_j: 1.6,
  },
  linkSignals: [
    { link_id: "L3", uncertainty: 0.15, topology_risk: 0.1, age: 0.1, covered: false },
  ],
});
assert.ok(expensive.objective_value > highValue.objective_value, "bytes and energy must be represented in the objective");

const lowConfidence = evaluateTopologyVersionedPathObjective({
  ...common,
  linkSignals: [],
});
assert.equal(lowConfidence.conservative_score_adjustment, 0, "missing evidence must fall back to the legacy ranking");
assert.equal(lowConfidence.gate_decision, "legacy-fallback-low-confidence");

const coarseTopology = evaluateTopologyVersionedPathObjective({
  ...common,
  activeLinkCount: 8,
  linkSignals: [
    { link_id: "L1", uncertainty: 0.9, topology_risk: 0.8, age: 1, covered: false },
    { link_id: "L2", uncertainty: 0.8, topology_risk: 0.7, age: 0.9, covered: false },
  ],
});
const fineTopology = evaluateTopologyVersionedPathObjective({
  ...common,
  activeLinkCount: 800,
  linkSignals: [
    { link_id: "L1", uncertainty: 0.9, topology_risk: 0.8, age: 1, covered: false },
    { link_id: "L2", uncertainty: 0.8, topology_risk: 0.7, age: 0.9, covered: false },
  ],
});
assert.ok(
  coarseTopology.structural_granularity_scale < fineTopology.structural_granularity_scale,
  "paths covering a large topology share must receive a more conservative adjustment",
);
assert.ok(
  coarseTopology.conservative_score_adjustment < fineTopology.conservative_score_adjustment,
  "the granularity gate must avoid scale-specific special cases",
);

const newNodeCoverage = evaluateTopologyVersionedPathObjective({
  ...common,
  activeLinkCount: 100,
  linkSignals: [{ link_id: "L1", uncertainty: 0.4, topology_risk: 0.2, age: 0.5, covered: false }],
  nodeSignals: [
    { node_id: "N1", uncertainty: 0.9, criticality: 0.8, age: 1, covered: false },
    { node_id: "N2", uncertainty: 0.8, criticality: 0.6, age: 0.9, covered: false },
  ],
});
const repeatedNodeCoverage = evaluateTopologyVersionedPathObjective({
  ...common,
  activeLinkCount: 100,
  linkSignals: [{ link_id: "L1", uncertainty: 0.4, topology_risk: 0.2, age: 0.5, covered: false }],
  nodeSignals: [
    { node_id: "N1", uncertainty: 0.9, criticality: 0.8, age: 1, covered: true },
    { node_id: "N2", uncertainty: 0.8, criticality: 0.6, age: 0.9, covered: true },
  ],
});
assert.ok(
  newNodeCoverage.node_information_gain > repeatedNodeCoverage.node_information_gain,
  "new node observations must contribute to the joint path information gain",
);
assert.ok(
  newNodeCoverage.objective_value < repeatedNodeCoverage.objective_value,
  "node novelty must protect CPU and energy observability",
);

const nodeLossGuard = chooseConservativeObjectiveCandidate({
  legacy: {
    id: "legacy",
    newNodeIds: ["N1", "N2"],
    marginalInformationGain: 2,
    telemetryBytes: 2000,
  },
  objective: {
    id: "objective",
    newNodeIds: ["N1"],
    marginalInformationGain: 2.2,
    telemetryBytes: 1800,
  },
});
assert.equal(nodeLossGuard.selected, "legacy", "the unified objective must not discard legacy node novelty");
assert.equal(nodeLossGuard.reason, "legacy-shadow-node-coverage-guard");

const safeReplacement = chooseConservativeObjectiveCandidate({
  legacy: {
    id: "legacy",
    newNodeIds: ["N1", "N2"],
    marginalInformationGain: 2,
    telemetryBytes: 2000,
  },
  objective: {
    id: "objective",
    newNodeIds: ["N1", "N2", "N3"],
    marginalInformationGain: 2.1,
    telemetryBytes: 1800,
  },
});
assert.equal(safeReplacement.selected, "objective", "a cheaper non-inferior candidate should be admitted");
assert.equal(safeReplacement.reason, "objective-admitted-by-legacy-shadow-guard");

const disabled = evaluateTopologyVersionedPathObjective({
  ...common,
  enabled: false,
  linkSignals: [{ link_id: "L4", uncertainty: 1, topology_risk: 1, age: 1, covered: false }],
});
assert.equal(disabled.ranking_score, common.baselineRankingScore, "disabled mode must preserve legacy behavior exactly");
assert.equal(disabled.gate_decision, "disabled");

assert.equal(buildTopologyVersionId("TC-004", "abc12345"), "TC-004@abc12345");

console.log(JSON.stringify({
  ok: true,
  high_value_objective: highValue.objective_value,
  redundant_objective: redundant.objective_value,
  high_value_adjustment: highValue.conservative_score_adjustment,
  low_confidence_gate: lowConfidence.gate_decision,
}, null, 2));
