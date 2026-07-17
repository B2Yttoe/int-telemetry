import assert from "node:assert/strict";
import {
  classifyStrictExternalPair,
  summarizeStrictExternalPairs,
  uniqueTopologyTimes,
} from "./experiments/strictExternalPairing.mjs";

const topology = uniqueTopologyTimes([
  { slice_index: 0, time: "2026-07-16T00:00:00Z" },
  { slice_index: 1, time: "2026-07-16T00:05:00Z" },
]);
const policy = {
  minimum_pairs: { mlab_ndt7: 1 },
  maximum_topology_time_offset_seconds: 150,
  required: {
    modeled_status: "modeled",
    temporal_pairing: "exact-topology-window",
    server_location_source: "direct-measurement-target-coordinate",
    server_identity_present: true,
  },
};
const direct = classifyStrictExternalPair({
  status: "modeled",
  test_time: "2026-07-16T00:04:00Z",
  temporal_pairing: "exact-topology-window",
  client_latitude_deg: 1,
  client_longitude_deg: 2,
  server_latitude_deg: 3,
  server_longitude_deg: 4,
  server_location_source: "direct-measurement-target-coordinate",
  server_hostname: "ndt.example",
}, topology, policy);
assert.equal(direct.strict_pair, true);
assert.equal(direct.nearest_slice_index, 1);
const derived = classifyStrictExternalPair({
  ...direct,
  server_location_source: "training-client-city-centroid",
  server_hostname: "",
}, topology, policy);
assert.equal(derived.strict_pair, false);
assert.match(derived.strict_pair_rejection_reasons, /direct_server_location/);
assert.match(derived.strict_pair_rejection_reasons, /server_identity/);
const summary = summarizeStrictExternalPairs([direct, derived], "mlab_ndt7", policy);
assert.equal(summary.strict_pairs, 1);
assert.equal(summary.passed, true);

console.log("Experiment 14B strict-pairing tests passed.");
