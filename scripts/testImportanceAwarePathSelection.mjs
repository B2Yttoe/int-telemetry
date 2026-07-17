import assert from "node:assert/strict";
import {
  attachImportanceAwareMetadataPlans,
  buildTargetPreservingRepair,
  compareAoIRepairGains,
  computeBoundedAdditiveRepairPathLimit,
  computeAoIAdjustedPathCount,
  currentSelectionImportanceRepairFields,
  resolveImportanceSelectionPhase,
  rankPathsByImportanceEfficiency,
  selectBoundedImportanceRepairRows,
  shouldUseAoIDebtOverride,
} from "../stage2-int/tools/importance-aware-telemetry.mjs";

const canonicalRows = [
  {
    slice_index: 4,
    probe_id: "canonical-1",
    path: "A > B > C",
    link_ids: "L1 > L2",
  },
  {
    slice_index: 4,
    probe_id: "canonical-2",
    path: "C > D",
    link_ids: "L3",
  },
  {
    slice_index: 4,
    probe_id: "canonical-3",
    path: "A > E",
    link_ids: "L4",
  },
];
const targetsBySlice = new Map([[4, [
  { slice_index: 4, target_type: "node", target_id: "B", importance_score: 0.8, mandatory: false },
  { slice_index: 4, target_type: "link", target_id: "L2", importance_score: 0.7, mandatory: false },
  { slice_index: 4, target_type: "node", target_id: "D", importance_score: 0.95, mandatory: true },
  { slice_index: 4, target_type: "node", target_id: "E", importance_score: 0.2, coverage_required: true, aoi_debt_severity: 1.5 },
]]]);
const mandatoryTargetsBySlice = new Map([[4, {
  nodes: new Set(["D"]),
  links: new Set(),
}]]);

const attached = attachImportanceAwareMetadataPlans({
  rows: canonicalRows,
  targetsBySlice,
  mandatoryTargetsBySlice,
});

assert.deepEqual(
  attached.rows.map((row) => [row.probe_id, row.path, row.link_ids]),
  canonicalRows.map((row) => [row.probe_id, row.path, row.link_ids]),
  "metadata-only integration must preserve canonical path identities and order",
);
assert.equal(resolveImportanceSelectionPhase({
  enabled: true,
  selectedPathCount: 6,
  requestedPathCount: 7,
  adjustedPathCount: 12,
}), "conservative-base");
assert.equal(resolveImportanceSelectionPhase({
  enabled: true,
  selectedPathCount: 7,
  requestedPathCount: 7,
  adjustedPathCount: 12,
}), "aoi-repair");
assert.equal(resolveImportanceSelectionPhase({
  enabled: true,
  selectedPathCount: 12,
  requestedPathCount: 7,
  adjustedPathCount: 12,
}), "complete");

const pathByPair = new Map([
  ["A|X", { nodes: ["A", "B", "X"], linkIds: ["AB", "BX"], cost: 2 }],
  ["X|D", { nodes: ["X", "C", "D"], linkIds: ["XC", "CD"], cost: 2 }],
]);
const targetPreservingRepair = buildTargetPreservingRepair({
  graph: {},
  source: "A",
  sink: "D",
  originalNodes: ["A", "B", "X", "C", "D"],
  requiredNodeIds: new Set(["X"]),
  shortestPath: (_graph, source, sink) => pathByPair.get(`${source}|${sink}`) ?? null,
});
assert.deepEqual(targetPreservingRepair.nodes, ["A", "B", "X", "C", "D"]);
assert.deepEqual(targetPreservingRepair.preservedTargetIds, ["X"]);
assert.equal(attached.rows[0].selective_metadata_enabled, true);
assert.deepEqual(
  JSON.parse(attached.rows[0].selective_metadata_plan_json).map((hop) => hop.profile),
  ["node-core-link-core", "node-full", "node-core"],
);
assert.equal(attached.rows[0].importance_new_target_count, 2);
assert.equal(attached.rows[1].importance_mandatory_target_hits, 1);
assert.ok(attached.rows.every((row) => Number(row.selective_metadata_payload_bytes) > 0));

const additiveMetadata = attachImportanceAwareMetadataPlans({
  rows: [{
    slice_index: 4,
    probe_id: "repair-core",
    path: "A > B > C",
    link_ids: "L1 > L2",
    planning_importance_additive_repair: true,
  }],
  targetsBySlice: new Map([[4, [
    { slice_index: 4, target_type: "node", target_id: "B", importance_score: 0.9 },
    {
      slice_index: 4,
      target_type: "link",
      target_id: "L-adjacent",
      source: "B",
      target: "D",
      importance_score: 0.8,
      coverage_required: true,
      aoi_debt_severity: 1.5,
    },
  ]]]),
});
assert.deepEqual(
  JSON.parse(additiveMetadata.rows[0].selective_metadata_plan_json).map((hop) => hop.profile),
  ["node-core-link-core", "node-full", "node-core"],
  "a bounded repair path must retain low-cost core node state for opportunistic anomaly capture",
);
assert.equal(additiveMetadata.rows[0].adaptive_link_observation_mode, "target-neighborhood");
assert.equal(additiveMetadata.rows[0].selective_adjacent_link_profile, "link-core");

const ranked = rankPathsByImportanceEfficiency({
  rows: canonicalRows,
  targets: targetsBySlice.get(4),
  mandatoryTargets: mandatoryTargetsBySlice.get(4),
});
assert.equal(ranked[0].probe_id, "canonical-2", "mandatory target gain must dominate optional target gain per byte");
assert.equal(ranked[1].probe_id, "canonical-3", "AoI-debt coverage must outrank ordinary optional gain");
assert.equal(Number(ranked[1].importance_coverage_required_target_hits), 1);

assert.equal(shouldUseAoIDebtOverride({
  promotionAvailable: true,
  objective: { maxSeverity: 2, oldestTargets: 1, debtSeverity: 2, informationGain: 95 },
  legacy: { maxSeverity: 1, oldestTargets: 3, debtSeverity: 3, informationGain: 100 },
  informationFloor: 0.95,
}), true, "a more urgent AoI path may use the bounded 5% information margin");
assert.equal(shouldUseAoIDebtOverride({
  promotionAvailable: true,
  objective: { maxSeverity: 2, oldestTargets: 1, debtSeverity: 2, informationGain: 94.9 },
  legacy: { maxSeverity: 1, oldestTargets: 3, debtSeverity: 3, informationGain: 100 },
  informationFloor: 0.95,
}), false, "the AoI override must reject candidates below the explicit information floor");
assert.equal(computeAoIAdjustedPathCount({
  requestedPathCount: 7,
  aoiRepairPathLimit: 5,
  selectedLimit: 12,
}), 12, "AoI repair should use available path slots instead of replacing the conservative base set");
assert.equal(computeAoIAdjustedPathCount({
  requestedPathCount: 10,
  aoiRepairPathLimit: 5,
  selectedLimit: 12,
}), 12, "AoI repair paths must remain bounded by the configured selected-path limit");
assert.equal(computeBoundedAdditiveRepairPathLimit({
  basePathCount: 12,
  ratio: 0.1,
  remainingCandidateCount: 20,
}), 1, "a full legacy path cap must still permit one byte-budgeted additive repair path");
assert.equal(computeBoundedAdditiveRepairPathLimit({
  basePathCount: 12,
  ratio: 0.1,
  remainingCandidateCount: 20,
  minimumPathCount: 2,
}), 2, "an oldest-target set that no single path can cover must permit a second bounded repair path");
assert.equal(computeBoundedAdditiveRepairPathLimit({
  basePathCount: 0,
  ratio: 0.1,
  remainingCandidateCount: 20,
}), 0, "repair probes cannot exist without a conservative base path set");

const repairCandidates = [
  { id: "ordinary", aoi_debt_max_severity: 1, aoi_debt_oldest_target_count: 8, aoi_debt_severity: 8, gain_per_kb: 4 },
  { id: "oldest", aoi_debt_max_severity: 2, aoi_debt_oldest_target_count: 2, aoi_debt_severity: 4, gain_per_kb: 1 },
  { id: "oldest-efficient", aoi_debt_max_severity: 2, aoi_debt_oldest_target_count: 2, aoi_debt_severity: 4, gain_per_kb: 3 },
];
repairCandidates.sort(compareAoIRepairGains);
assert.deepEqual(
  repairCandidates.map((item) => item.id),
  ["oldest-efficient", "oldest", "ordinary"],
  "the additive repair phase must prioritize the most overdue targets, then information efficiency",
);

const boundedRepair = selectBoundedImportanceRepairRows({
  baseRows: [{ probe_id: "base", path: "A > B > C", link_ids: "AB > BC" }],
  candidateRows: [
    { probe_id: "critical", path: "C > D", link_ids: "CD" },
    { probe_id: "ordinary", path: "C > E", link_ids: "CE" },
  ],
  targets: [
    { target_type: "node", target_id: "D", importance_score: 0.9, criticality_score: 0.95 },
    { target_type: "node", target_id: "E", importance_score: 0.8, criticality_score: 0.1 },
  ],
  maxAdditionalPaths: 1,
  maxAdditionalBytes: 1024,
});
assert.deepEqual(
  boundedRepair.base_rows.map((row) => row.probe_id),
  ["base"],
  "bounded repair must leave the complete base path set untouched",
);
assert.deepEqual(
  boundedRepair.repair_rows.map((row) => row.probe_id),
  ["critical"],
  "bounded repair must spend its remaining slot on the highest causal critical-state gain",
);
assert.ok(boundedRepair.estimated_additional_bytes <= 1024, "repair paths must obey the explicit byte budget");
const weakRefreshOnly = selectBoundedImportanceRepairRows({
  baseRows: [{ probe_id: "base", path: "A > B", link_ids: "AB" }],
  candidateRows: [{ probe_id: "weak", path: "B > C", link_ids: "BC" }],
  targets: [{
    target_type: "node",
    target_id: "C",
    importance_score: 0.2,
    criticality_score: 0.1,
    coverage_required: true,
    aoi_debt_severity: 0,
  }],
  maxAdditionalPaths: 1,
  maxAdditionalBytes: 1024,
  requireStrongEvidence: true,
});
assert.equal(
  weakRefreshOnly.repair_rows.length,
  0,
  "a low-criticality pre-deadline refresh must not consume an additive repair probe",
);

assert.deepEqual(
  currentSelectionImportanceRepairFields({
    row: {
      planning_importance_additive_repair: true,
      planning_importance_repair_actual_bytes: 512,
      planning_importance_repair_target_ids: "node:A",
    },
    selectedAsRepair: false,
  }),
  {
    planning_importance_additive_repair: false,
    planning_importance_repair_actual_bytes: "",
    planning_importance_repair_target_ids: "",
  },
  "a topology-reused base path must not inherit a stale additive-repair role",
);
assert.deepEqual(
  currentSelectionImportanceRepairFields({
    row: {
      planning_importance_repair_actual_bytes: 512,
      planning_importance_repair_target_ids: "node:A",
    },
    selectedAsRepair: true,
  }),
  {
    planning_importance_additive_repair: true,
    planning_importance_repair_actual_bytes: 512,
    planning_importance_repair_target_ids: "node:A",
  },
  "only a repair path appended in the current slice may expose repair provenance",
);

const adjacentLinkRepair = selectBoundedImportanceRepairRows({
  baseRows: [{ probe_id: "base", path: "A > B", link_ids: "AB" }],
  candidateRows: [{ probe_id: "adjacent-link", path: "B > C", link_ids: "BC" }],
  targets: [{
    target_type: "link",
    target_id: "BD",
    source: "B",
    target: "D",
    importance_score: 0.8,
    coverage_required: true,
    aoi_debt_severity: 1.5,
  }],
  maxAdditionalPaths: 1,
  maxAdditionalBytes: 1024,
  requireStrongEvidence: true,
});
assert.deepEqual(
  adjacentLinkRepair.repair_rows.map((row) => row.probe_id),
  ["adjacent-link"],
  "a repair path touching one endpoint must be able to collect a nominated local-link state",
);

console.log(JSON.stringify({
  ok: true,
  canonical_probe_ids: attached.rows.map((row) => row.probe_id),
  metadata_bytes: attached.summary.metadata_bytes,
  target_mask_bytes: attached.summary.target_mask_bytes,
  saved_payload_bytes: attached.summary.saved_payload_bytes,
  ranked_probe_ids: ranked.map((row) => row.probe_id),
}, null, 2));
