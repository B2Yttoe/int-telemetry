import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { uniqueTopologyTimes } from "./experiments/strictExternalPairing.mjs";
import { buildV2StrictPairingAudit } from "./experiments/experiment14bV2StrictPairAudit.mjs";

const policy = JSON.parse(await readFile(resolve("scripts/experiments/experiment14b-v2-strict-pairing-addendum.json"), "utf8"));
const topology = uniqueTopologyTimes(Array.from({ length: 48 }, (_, slice) => ({
  slice_index: slice,
  time: new Date(Date.parse("2026-07-16T05:00:00Z") + slice * 300_000).toISOString(),
})));
const direct = (index, extra = {}) => ({
  status: "modeled",
  test_time: new Date(Date.parse("2026-07-16T05:00:00Z") + index * 60_000).toISOString(),
  temporal_pairing: "exact-topology-window",
  client_latitude_deg: 40,
  client_longitude_deg: -75,
  server_latitude_deg: 39,
  server_longitude_deg: -77,
  server_location_source: "direct-measurement-target-coordinate",
  server_id: `server-${index}`,
  target_semantics: "fixed-ripe-atlas-anchor",
  ...extra,
});
const mlab = Array.from({ length: 20 }, (_, index) => direct(index));
const ripe = Array.from({ length: 20 }, (_, index) => direct(index));
const complete = buildV2StrictPairingAudit({ mlabRows: mlab, ripeRows: ripe, topologyTimes: topology, policy });
assert.equal(complete.evidence_status, "strict-time-geography-server-pairing-complete");
assert.equal(complete.sources.mlab_ndt7.strict_pairs, 20);
assert.equal(complete.sources.ripe_atlas_exact_anchor.strict_pairs, 20);

const anycast = buildV2StrictPairingAudit({
  mlabRows: mlab,
  ripeRows: ripe.map((row) => ({ ...row, target_semantics: "public-anycast-proxy" })),
  topologyTimes: topology,
  policy,
});
assert.equal(anycast.sources.ripe_atlas_exact_anchor.strict_pairs, 0);
assert.equal(anycast.sources.ripe_atlas_exact_anchor.rejection_counts.fixed_anchor_semantics, 20);
assert.equal(anycast.evidence_status, "strict-time-geography-server-pairing-in-progress");

const derivedServer = buildV2StrictPairingAudit({
  mlabRows: mlab.map((row) => ({ ...row, server_location_source: "training-client-city-centroid" })),
  ripeRows: ripe,
  topologyTimes: topology,
  policy,
});
assert.equal(derivedServer.sources.mlab_ndt7.strict_pairs, 0);
assert.equal(derivedServer.sources.mlab_ndt7.rejection_counts.direct_server_location, 20);

console.log("Experiment 14B v2 strict-pairing addendum tests passed.");
