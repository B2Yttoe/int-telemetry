import assert from "node:assert/strict";
import { evaluateFinalEvidence } from "./auditExperiment14BV2FinalEvidence.mjs";

const complete = {
  minimumPairs: 20,
  freezeChainIntegral: true,
  gp0Integral: true,
  gp0: { source_content_changed_after_freeze: true, start_freshness: { passed: true }, window_end_freshness: { passed: true } },
  gp1Integral: true,
  gp1: { differs_from_gp0: true, summary: { matched_satellites: 1584 } },
  radarLockIntegral: true,
  radarAudit: {
    evidence_status: "radar-causality-status-complete",
    checks: { test_values_used_for_fit_zero: true, interval_calibration_uses_test_zero: true, post_test_updates_zero: true },
  },
  queryLockIntegral: true,
  queryLock: { test_values_used_for_fit: 0, post_test_parameter_updates: 0 },
  queryAudit: { evidence_status: "query-semantics-correction-complete" },
  bigQueryResultIntegral: true,
  bigQueryResult: { test_values_used_for_fit: 0, post_test_parameter_updates: 0 },
  provenanceAudit: { evidence_status: "strict-mlab-provenance-complete" },
  mlabImportIntegral: true,
  mlabImport: { test_values_used_for_fit: 0, post_test_parameter_updates: 0 },
  ripeResultIntegral: true,
  ripeResult: { result_count: 40, source_validation: { passed: true }, test_values_used_for_fit: 0, post_test_parameter_updates: 0 },
  pairing: {
    evidence_status: "strict-time-geography-server-pairing-complete",
    sources: { mlab_ndt7: { strict_pairs: 25 }, ripe_atlas_exact_anchor: { strict_pairs: 40 } },
  },
  strictScore: {
    evidence_status: "strict-external-metric-scoring-complete",
    test_target_values_used_for_fit: 0,
    post_test_parameter_updates: 0,
    scores: {
      mlab_ndt7: { rtt: { sample_count: 25 }, throughput: { sample_count: 25 } },
      ripe_atlas_exact_anchor: { rtt: { sample_count: 40 } },
    },
  },
  ns3: { evidence_status: "ns3-system-cross-validation-complete" },
  claimBoundaryIntegral: true,
  completion: { evidence_status: "strict-prospective-validation-complete" },
};

const passed = evaluateFinalEvidence(complete);
assert.equal(passed.complete, true);
assert.equal(passed.completion_count, passed.required_count);

const pendingRadar = evaluateFinalEvidence({ ...complete, radarLockIntegral: false, radarAudit: { evidence_status: "radar-causality-status-pending", checks: {} } });
assert.equal(pendingRadar.complete, false);
assert.equal(pendingRadar.checks.radar_prospective_causality, false);
assert.equal(pendingRadar.checks.zero_test_leakage_and_updates, false);

const insufficientPairs = evaluateFinalEvidence({
  ...complete,
  pairing: { ...complete.pairing, sources: { ...complete.pairing.sources, mlab_ndt7: { strict_pairs: 19 } } },
});
assert.equal(insufficientPairs.checks.strict_pairing_complete, false);

console.log("Experiment 14B v2 final evidence-chain tests passed.");
