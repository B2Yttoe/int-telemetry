import assert from "node:assert/strict";
import {
  aggregateTopologyReusePairedEffects,
  buildTopologyReuseEvidenceMatrix,
  buildTopologyReusePairedRows,
  buildTopologyReusePreregistration,
  evaluateTopologyReuseEvidence,
  pairedSignTest,
  scanTopologyReuseEligibility,
} from "./experiments/topologyReuseStatisticalEvidence.mjs";

const matrix = buildTopologyReuseEvidenceMatrix();
assert.equal(matrix.length, 18);
for (const profileId of ["telesat-1015-medium", "starlink-main-large"]) {
  const rows = matrix.filter((row) => row.profile_id === profileId);
  assert.equal(rows.length, 9);
  assert.equal(new Set(rows.map((row) => `${row.window_id}|${row.stress_rate}`)).size, 9);
  for (const windowId of new Set(rows.map((row) => row.window_id))) {
    assert.equal(new Set(rows.filter((row) => row.window_id === windowId).map((row) => row.seed)).size, 3);
  }
  for (const stressRate of new Set(rows.map((row) => row.stress_rate))) {
    assert.equal(new Set(rows.filter((row) => row.stress_rate === stressRate).map((row) => row.seed)).size, 3);
  }
}

const preregistration = buildTopologyReusePreregistration();
assert.equal(preregistration.design_sha256, buildTopologyReusePreregistration().design_sha256);
assert.equal(preregistration.matrix.length, 18);
assert.deepEqual(preregistration.variants, ["full-unified", "no-topology-version"]);

const baseIds = Array.from({ length: 100 }, (_, index) => `L${index}`);
const links = [
  ...baseIds.map((linkId) => ({ slice_index: 0, link_id: linkId, is_active: "true" })),
  ...baseIds.map((linkId) => ({ slice_index: 1, link_id: linkId, is_active: "true" })),
  ...baseIds.slice(0, 98).map((linkId) => ({ slice_index: 2, link_id: linkId, is_active: "true" })),
  { slice_index: 2, link_id: "N1", is_active: "true" },
  { slice_index: 2, link_id: "N2", is_active: "true" },
];
const scan = scanTopologyReuseEligibility(links);
assert.equal(scan.summary.exact_reuse_eligible_slices, 1);
assert.equal(scan.summary.local_repair_eligible_slices, 1);
assert.equal(scan.per_slice[0].topology_mode_eligibility, "fresh");
assert.equal(scan.per_slice[1].topology_mode_eligibility, "reuse");
assert.equal(scan.per_slice[2].topology_mode_eligibility, "repair");

function summaryRow({ caseId, windowId, stressRate, seed, variant, multiplier = 1 }) {
  const full = variant === "full-unified";
  return {
    profile_id: "starlink-main-large",
    profile_label: "Starlink 1584",
    case_id: caseId,
    window_id: windowId,
    epoch_iso: "2026-07-03T00:00:00.000Z",
    stress_rate: stressRate,
    achieved_stress_rate: stressRate,
    seed,
    variant_id: variant,
    unified_reuse_slices: 0,
    unified_repair_slices: full ? 8 : 0,
    unified_fresh_slices: full ? 40 : 48,
    planning_candidate_paths: full ? 900 * multiplier : 1000 * multiplier,
    unified_planner_marginal_evaluations: full ? 800 * multiplier : 1000 * multiplier,
    unified_planner_score_cache_recomputations: full ? 700 * multiplier : 1000 * multiplier,
    planning_wall_time_ms: full ? 980 : 1000,
    telemetry_bytes_per_node_slice: full ? 20.05 : 20,
    total_telemetry_energy_j: full ? 99 : 100,
    active_link_direct_coverage: full ? 0.11 : 0.1,
    cpu_mae: full ? 1.005 : 1,
    queue_depth_mae: full ? 1 : 1,
    energy_percent_mae: full ? 1.004 : 1,
    link_utilization_mae: full ? 1.002 : 1,
    telemetry_byte_budget_cap_violations: 0,
    unified_hard_budget_violations: 0,
    strict_causal_passed: true,
    invalid_probe_path_ratio: 0,
  };
}

const syntheticRows = [
  ["case-a", "window-00", 0, "seed-00", 1],
  ["case-b", "window-08", 0.1, "seed-01", 1.1],
  ["case-c", "window-16", 0.25, "seed-02", 0.9],
].flatMap(([caseId, windowId, stressRate, seed, multiplier]) => [
  summaryRow({ caseId, windowId, stressRate, seed, multiplier, variant: "full-unified" }),
  summaryRow({ caseId, windowId, stressRate, seed, multiplier, variant: "no-topology-version" }),
]);

const paired = buildTopologyReusePairedRows(syntheticRows);
assert.equal(paired.length, 3);
assert.ok(paired.every((row) => row.noninferiority_passed));
assert.ok(paired.every((row) => row.marginal_evaluation_reduction_percent > 0));
assert.ok(paired.every((row) => row.maximum_mae_regression_percent <= 1));

const aggregate = aggregateTopologyReusePairedEffects(paired);
const marginal = aggregate.find((row) => row.metric === "marginal_evaluation_reduction_percent");
assert.ok(marginal.ci95_low > 0);
const evidence = evaluateTopologyReuseEvidence(paired, aggregate);
assert.equal(evidence[0].evidence_status, "supported");
assert.equal(pairedSignTest([1, 1, 1]).p_value_two_sided, 0.25);

console.log(JSON.stringify({
  ok: true,
  preregistered_cases: matrix.length,
  design_sha256: preregistration.design_sha256,
  scan_summary: scan.summary,
  synthetic_evidence_status: evidence[0].evidence_status,
}, null, 2));
