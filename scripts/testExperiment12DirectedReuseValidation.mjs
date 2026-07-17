import assert from "node:assert/strict";
import {
  buildDirectedReusePreregistration,
  classifyReuseOpportunity,
  evaluateDirectedQualityGates,
  pairedBootstrapMean,
  planningWorkUnits,
  scanDirectedReuseOpportunities,
  selectDirectedValidationPairs,
} from "./experiments/topologyReuseDirectedValidation.mjs";

assert.equal(classifyReuseOpportunity(0.99, 0.05), "high");
assert.equal(classifyReuseOpportunity(0.99, 0.2), "outside");
assert.equal(classifyReuseOpportunity(0.96, 0.4), "medium");
assert.equal(classifyReuseOpportunity(0.92, 0.4), "boundary");
assert.equal(classifyReuseOpportunity(0.89, 0), "outside");

const links = [
  ...["L1", "L2", "L3", "L4"].map((linkId) => ({ slice_index: 0, link_id: linkId, is_active: true })),
  ...["L1", "L2", "L3", "L5"].map((linkId) => ({ slice_index: 1, link_id: linkId, is_active: true })),
  ...["L1", "L2", "L3", "L4"].map((linkId) => ({ slice_index: 2, link_id: linkId, is_active: true })),
];
const paths = [
  { slice_index: 0, probe_id: "P0", link_ids: "L1 > L2" },
  { slice_index: 0, probe_id: "P1", link_ids: "L3 > L4" },
  { slice_index: 1, probe_id: "P2", link_ids: "L1 > L2" },
];
const scan = scanDirectedReuseOpportunities({ links, cachedProbePaths: paths, scenario: { case_id: "case-a" } });
assert.equal(scan.length, 3);
assert.equal(scan[2].historical_slice_index, 0);
assert.equal(scan[2].topology_jaccard, 1);
assert.equal(scan[2].affected_cached_path_ratio, 0);
assert.equal(scan[2].opportunity_class, "high");

const selectionRows = ["high", "medium", "boundary"].flatMap((opportunityClass) =>
  Array.from({ length: 4 }, (_, index) => ({
    profile_id: "starlink-main-large",
    case_id: `${opportunityClass}-${index}`,
    historical_slice_index: index,
    current_slice_index: index + 1,
    opportunity_class: opportunityClass,
  })),
);
const selection = selectDirectedValidationPairs(selectionRows);
assert.equal(selection.selected.length, 6);
assert.equal(selection.reserve.length, 6);
assert.equal(new Set(selection.selected.map((row) => row.case_id)).size, 6);
assert.deepEqual(
  selectDirectedValidationPairs(selectionRows).selected,
  selection.selected,
  "directed pair selection must be deterministic",
);

const preregistration = buildDirectedReusePreregistration();
assert.equal(preregistration.selection.initial_pair_count, 6);
assert.equal(preregistration.early_stopping.maximum_pairs, 12);
assert.equal(preregistration.design_sha256.length, 64);

const work = planningWorkUnits({
  candidate_inspections: 10,
  shortest_path_calls: 2,
  score_recomputations: 5,
  marginal_evaluations: 20,
  local_repairs: 1,
  graph_reconstructions: 1,
});
assert.equal(work, 47);

const interval = pairedBootstrapMean([5, 6, 7, 8], { samples: 1000, seed: "fixed" });
assert.equal(interval.sample_count, 4);
assert.ok(interval.ci95_low > 0);
assert.deepEqual(interval, pairedBootstrapMean([5, 6, 7, 8], { samples: 1000, seed: "fixed" }));

const gates = evaluateDirectedQualityGates({
  fresh: {
    active_link_coverage: 0.8,
    weighted_information: 100,
    delivered_report_ratio: 0.99,
    cpu_mae: 1,
    queue_depth_mae: 1,
    energy_percent_mae: 1,
    link_utilization_mae: 1,
    telemetry_bytes: 1000,
  },
  reuse: {
    active_link_coverage: 0.795,
    weighted_information: 99,
    mandatory_target_coverage: 1,
    delivered_report_ratio: 0.985,
    cpu_mae: 1.01,
    queue_depth_mae: 1.01,
    energy_percent_mae: 1.01,
    link_utilization_mae: 1.01,
    telemetry_bytes: 1005,
    hard_budget_violations: 0,
  },
});
assert.equal(gates.passed, true);
assert.equal(gates.unavailable_check_count, 0);

console.log("Experiment 12 directed reuse validation tests passed.");
