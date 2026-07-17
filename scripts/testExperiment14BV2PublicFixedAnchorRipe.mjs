import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  normalizePublicFixedAnchorResults,
  validatePublicFixedAnchorMetadata,
} from "./experiments/publicFixedAnchorRipe.mjs";

const protocol = JSON.parse(await readFile(resolve("scripts/experiments/experiment14b-v2-ripe-public-fixed-anchor-addendum.json"), "utf8"));
const measurement = {
  id: 34468267, type: "ping", af: 4, interval: 240, stop_time: null,
  status: { name: "Ongoing" }, target: protocol.measurement.target_fqdn,
  target_ip: protocol.measurement.target_ipv4, resolved_ips: [protocol.measurement.target_ipv4],
};
const anchor = {
  id: 2825, fqdn: protocol.measurement.target_fqdn, ip_v4: protocol.measurement.target_ipv4,
  is_disabled: false, date_decommissioned: null, city: "Dubai", country: "AE",
  geometry: { coordinates: [55.1868599, 25.0264601] },
};
const probe = {
  id: 1003040, asn_v4: 14593, is_public: true, status: { id: 1 }, country_code: "US",
  geometry: { coordinates: [-74.6805, 40.8875] },
};
assert.equal(validatePublicFixedAnchorMetadata({ protocol, measurement, anchor, probe }).passed, true);
assert.equal(validatePublicFixedAnchorMetadata({ protocol, measurement: { ...measurement, target_ip: "1.1.1.1" }, anchor, probe }).passed, false);
const start = "2026-07-16T05:00:00Z";
const results = Array.from({ length: 20 }, (_, index) => ({
  msm_id: 34468267, prb_id: 1003040, type: "ping", af: 4,
  timestamp: Date.parse(start) / 1000 + index * 240, min: 20 + index, sent: 3, rcvd: 3,
}));
results.push({ ...results[0], prb_id: 999 });
const normalized = normalizePublicFixedAnchorResults(results, {
  protocol, anchor, probe, startTime: start, endTime: "2026-07-16T09:00:00Z",
});
assert.equal(normalized.length, 20);
assert.equal(normalized[0].external_rtt_ms, 20);
assert.equal(normalized[0].target_semantics, "fixed-ripe-atlas-anchor");
assert.equal(normalized[0].client_asn, 14593);

console.log("Experiment 14B v2 public fixed-anchor RIPE tests passed.");
