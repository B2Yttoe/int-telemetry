import {
  classifyStrictExternalPair,
  summarizeStrictExternalPairs,
} from "./strictExternalPairing.mjs";

function appendRejection(row, reason) {
  const reasons = new Set(String(row.strict_pair_rejection_reasons ?? "").split("|").filter(Boolean));
  reasons.add(reason);
  return {
    ...row,
    strict_pair: false,
    strict_pair_rejection_reasons: [...reasons].join("|"),
  };
}

export function classifyMlabStrictPairs(rows, topologyTimes, policy) {
  return rows.map((row) => classifyStrictExternalPair(row, topologyTimes, policy));
}

export function classifyRipeStrictPairs(rows, topologyTimes, policy) {
  return rows.map((row) => {
    const classified = classifyStrictExternalPair(row, topologyTimes, policy);
    if (String(row.target_semantics ?? "") !== policy.required.ripe_target_semantics) {
      return appendRejection(classified, "fixed_anchor_semantics");
    }
    return classified;
  });
}

export function buildV2StrictPairingAudit({ mlabRows, ripeRows, topologyTimes, policy }) {
  const mlabClassified = classifyMlabStrictPairs(mlabRows, topologyTimes, policy);
  const ripeClassified = classifyRipeStrictPairs(ripeRows, topologyTimes, policy);
  const mlab = summarizeStrictExternalPairs(mlabClassified, "mlab_ndt7", policy);
  const ripe = summarizeStrictExternalPairs(ripeClassified, "ripe_atlas_exact_anchor", policy);
  const complete = mlab.passed && ripe.passed;
  return {
    evidence_status: complete
      ? "strict-time-geography-server-pairing-complete"
      : "strict-time-geography-server-pairing-in-progress",
    checks: {
      mlab_minimum_strict_pairs: mlab.passed,
      ripe_minimum_strict_pairs: ripe.passed,
      both_sources_passed: complete,
    },
    sources: { mlab_ndt7: mlab, ripe_atlas_exact_anchor: ripe },
    classified: { mlab: mlabClassified, ripe: ripeClassified },
  };
}
