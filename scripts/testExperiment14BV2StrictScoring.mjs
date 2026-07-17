import assert from "node:assert/strict";
import { scoreV2StrictExternalRows } from "./experiments/strictExternalScoring.mjs";

const rows = Array.from({ length: 20 }, (_, index) => ({
  strict_pair: true,
  external_rtt_ms: 30 + index,
  predicted_user_rtt_ms: 31 + index,
  predicted_rtt_lower_ms: 25 + index,
  predicted_rtt_upper_ms: 35 + index,
  external_throughput_mbps: 100 + index,
  predicted_user_throughput_mbps: 98 + index,
  predicted_throughput_lower_mbps: 90 + index,
  predicted_throughput_upper_mbps: 110 + index,
}));
const rejected = {
  strict_pair: false,
  external_rtt_ms: 10000,
  predicted_user_rtt_ms: 1,
  external_throughput_mbps: 10000,
  predicted_user_throughput_mbps: 1,
};
const scores = scoreV2StrictExternalRows({ mlabRows: [...rows, rejected], ripeRows: [...rows, rejected] });
assert.equal(scores.mlab_ndt7.rtt.sample_count, 20);
assert.equal(scores.mlab_ndt7.rtt.mae, 1);
assert.equal(scores.mlab_ndt7.throughput.mae, 2);
assert.equal(scores.ripe_atlas_exact_anchor.rtt.sample_count, 20);
assert.equal(scores.ripe_atlas_exact_anchor.throughput.status, "not-applicable-no-throughput-target");
assert.equal(scores.mlab_ndt7.rtt.prediction_interval_coverage, 1);

console.log("Experiment 14B v2 strict-scoring tests passed.");
