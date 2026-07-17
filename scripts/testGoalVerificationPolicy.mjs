import assert from "node:assert/strict";
import {
  DEFAULT_GOAL_ALGORITHM,
  buildGoalCoverageChecks,
} from "./goalVerificationPolicy.mjs";

assert.equal(DEFAULT_GOAL_ALGORITHM, "int-mc");

const intMcChecks = buildGoalCoverageChecks({
  algorithm: "int-mc",
  accuracy: {
    conclusion: { pass: true, primary_mode: "leo-int-mc" },
    primary_probe_int: {
      metrics: { node_sample_coverage: 0.08, link_sample_coverage: 0.09 },
      int_mc_metrics: {
        active_link_completion_coverage: 1,
        node_completion_coverage: 1,
        unknown_link_samples: 0,
      },
    },
  },
});
assert.ok(intMcChecks.every((row) => row.passed), "INT-MC goal policy must accept partial direct coverage only after complete reconstruction");

const incompleteIntMcChecks = buildGoalCoverageChecks({
  algorithm: "int-mc",
  accuracy: {
    conclusion: { pass: false, primary_mode: "leo-int-mc" },
    primary_probe_int: {
      metrics: { node_sample_coverage: 0.08, link_sample_coverage: 0.09 },
      int_mc_metrics: {
        active_link_completion_coverage: 0.99,
        node_completion_coverage: 1,
        unknown_link_samples: 1,
      },
    },
  },
});
assert.ok(incompleteIntMcChecks.some((row) => !row.passed));

const partialProbeChecks = buildGoalCoverageChecks({
  algorithm: "path-balance",
  accuracy: {
    conclusion: { pass: false, primary_mode: "probe-int" },
    primary_probe_int: {
      metrics: {
        node_sample_coverage: 0.08,
        link_sample_coverage: 0.09,
        active_link_sample_coverage: 0.09,
        unknown_node_samples: 0,
        unknown_link_samples: 0,
        full_time_step_pass: false,
      },
      coverage_audit_summary: { pass: false, passed_slices: 0, slices: 48 },
    },
  },
});
assert.ok(partialProbeChecks.some((row) => !row.passed), "native probe goal policy must not silently lower full-coverage requirements");

console.log(JSON.stringify({
  ok: true,
  default_algorithm: DEFAULT_GOAL_ALGORITHM,
  int_mc_checks: intMcChecks.length,
  native_probe_checks: partialProbeChecks.length,
}, null, 2));
