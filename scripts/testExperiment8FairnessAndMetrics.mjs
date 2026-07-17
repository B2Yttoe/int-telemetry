import assert from "node:assert/strict";
import {
  auditFixedBudgetPair,
  calculateCarryoverPathValidity,
  calculatePathValidity,
} from "./experiments/dynamicityExperimentMetrics.mjs";

function fixtureRun({ samplingRate = 0.25, maxPaths = 12, truthHash = "same", truthLinksHash = "same-links", candidateHash = "paths" } = {}) {
  return {
    truth_metadata_sha256: truthHash,
    truth_links_sha256: truthLinksHash,
    candidate_paths_sha256: candidateHash,
    parameters: {
      samplingRate,
      targetActiveLinkSamplingRate: samplingRate,
      maxPathsPerSlice: maxPaths,
      downlinkBudgetBytes: 1_000_000_000,
      rank: 5,
      windowSize: 12,
      warmupSlices: 6,
      iterations: 12,
      observabilityMode: "oam-only",
      feedbackLagSlices: 1,
    },
  };
}

const matchingAudit = auditFixedBudgetPair(fixtureRun(), fixtureRun());
assert.equal(matchingAudit.ok, true);
assert.deepEqual(matchingAudit.violations, []);
assert.match(matchingAudit.fingerprint, /^[a-f0-9]{64}$/);

const samplingMismatch = auditFixedBudgetPair(
  fixtureRun({ samplingRate: 0.20 }),
  fixtureRun({ samplingRate: 0.25 }),
);
assert.equal(samplingMismatch.ok, false);
assert.ok(samplingMismatch.violations.some((message) => message.includes("samplingRate")));

const truthMismatch = auditFixedBudgetPair(
  fixtureRun({ truthHash: "truth-a" }),
  fixtureRun({ truthHash: "truth-b" }),
);
assert.equal(truthMismatch.ok, false);
assert.ok(truthMismatch.violations.some((message) => message.includes("truth_metadata_sha256")));

const linksMismatch = auditFixedBudgetPair(
  fixtureRun({ truthLinksHash: "links-a" }),
  fixtureRun({ truthLinksHash: "links-b" }),
);
assert.equal(linksMismatch.ok, false);
assert.ok(linksMismatch.violations.some((message) => message.includes("truth_links_sha256")));

const pathRows = calculatePathValidity({
  probeRows: [
    {
      slice_index: "0",
      probe_id: "probe-1",
      path: "A > B > C",
      link_ids: "intra:A->B > inter:B->C",
    },
    {
      slice_index: "0",
      probe_id: "probe-2",
      path: "A > B",
      link_ids: "intra:A->B",
    },
  ],
  linkRows: [
    { slice_index: "0", link_id: "intra:A->B", source: "A", target: "B", is_active: "true" },
    { slice_index: "0", link_id: "inter:B->C", source: "B", target: "C", is_active: "false" },
  ],
});

assert.equal(pathRows.length, 2);
assert.equal(pathRows[0].invalid, true);
assert.equal(pathRows[0].failed_link_id, "inter:B->C");
assert.equal(pathRows[0].failed_hop, "B>C");
assert.equal(pathRows[1].invalid, false);
assert.equal(pathRows[1].failed_link_id, "");

const carryoverRows = calculateCarryoverPathValidity({
  probeRows: [{ slice_index: "0", probe_id: "carry-1", path: "A > B", link_ids: "intra:A->B" }],
  linkRows: [
    { slice_index: "0", link_id: "intra:A->B", source: "A", target: "B", is_active: "true" },
    { slice_index: "1", link_id: "intra:A->B", source: "A", target: "B", is_active: "false" },
  ],
});
assert.equal(carryoverRows.length, 1);
assert.equal(carryoverRows[0].plan_slice_index, 0);
assert.equal(carryoverRows[0].evaluation_slice_index, 1);
assert.equal(carryoverRows[0].invalid, true);

console.log("Experiment 8 fairness and path metric tests passed.");
