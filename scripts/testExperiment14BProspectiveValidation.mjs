import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  buildFreshWalkerSnapshot,
  evaluateOrbitFreshness,
  summarizeOrbitEpochAges,
} from "./experiments/freshOrbitAcquisition.mjs";
import { generateFreshTopologyWindow } from "./experiments/freshTopologyWindow.mjs";
import { parseCsvRecord } from "./experiments/remoteZipCsvSampler.mjs";
import {
  applyUserPerformanceCalibration,
  fitUserPerformanceCalibration,
} from "./experiments/userPerformanceLayer.mjs";

const protocol = JSON.parse(await readFile(resolve("scripts/experiments/experiment14b-protocol.json"), "utf8"));
assert.equal(protocol.orbit.planes * protocol.orbit.satellites_per_plane, 1584);
assert.notEqual(protocol.mlab.training_member.name, protocol.mlab.test_member.name);
assert.ok(protocol.mlab.excluded_test_dates_due_to_prior_repository_exposure.includes("2025-11-24"));
assert.equal(protocol.causality.allow_test_target_values_for_fit, false);
assert.equal(protocol.system_cross_validation.required_evidence_status, "ns3-system-cross-validation-complete");

const reference = new Date("2026-01-02T00:00:00Z");
const freshRecords = Array.from({ length: 4 }, (_, index) => ({ EPOCH: new Date(reference.getTime() - (index + 1) * 3_600_000).toISOString() }));
const summary = summarizeOrbitEpochAges(freshRecords, reference);
assert.equal(summary.record_count, 4);
assert.ok(summary.age_p50_hours > 0 && summary.age_p50_hours < 4);
const pass = evaluateOrbitFreshness(freshRecords, reference, {
  minimum_records: 4,
  maximum_median_age_hours: 4,
  maximum_p95_age_hours: 5,
  maximum_future_epoch_ratio: 0,
});
assert.equal(pass.passed, true);
const fail = evaluateOrbitFreshness(freshRecords, reference, {
  minimum_records: 4,
  maximum_median_age_hours: 1,
  maximum_p95_age_hours: 2,
  maximum_future_epoch_ratio: 0,
});
assert.equal(fail.passed, false);

const miniCatalog = JSON.parse(await readFile(resolve("examples/tle/celestrak-mini-starlink.json"), "utf8"));
const miniSnapshot = await buildFreshWalkerSnapshot(miniCatalog, {
  sourceUrl: "fixture://experiment14b-mini-catalog",
  downloadedAt: "2026-06-26T00:00:00.000Z",
  planes: 2,
  satellitesPerPlane: 2,
  raanClusterThresholdDeg: 2.5,
});
const miniTopology = await generateFreshTopologyWindow(miniSnapshot, {
  epochIso: "2026-06-26T00:00:00.000Z",
  slices: 2,
  stepMinutes: 5,
  mode: "operational",
  trafficProfile: "empty",
  routingAlgorithm: "congestion-aware-shortest-path",
});
assert.equal(miniTopology.nodes.length, 8);
assert.ok(miniTopology.links.length > 0);
assert.ok(miniTopology.links.every((row) => "effective_capacity_mbps" in row && "packet_error_rate" in row));

assert.deepEqual(parseCsvRecord('one,"two,three","four""five"'), ["one", "two,three", 'four"five']);

function calibrationRows() {
  return Array.from({ length: 40 }, (_, index) => ({
    status: "modeled",
    test_time: new Date(Date.parse("2025-10-01T00:00:00Z") + index * 3_600_000).toISOString(),
    base_model_rtt_ms: 20 + index * 0.1,
    physical_user_capacity_mbps: 400 - index,
    external_satellite_density: 20 + (index % 4),
    external_rtt_ms: 50 + index * 0.1,
    external_throughput_mbps: (400 - index) * 0.2,
  }));
}

const calibration = fitUserPerformanceCalibration(calibrationRows(), protocol.user_performance);
assert.equal(calibration.audit.test_rows_used_for_fit, 0);
assert.equal(calibration.audit.test_rows_used_for_interval_calibration, 0);
assert.equal(calibration.audit.free_fitted_parameter_count, 2);
const testContexts = [{
  status: "modeled",
  base_model_rtt_ms: 31,
  physical_user_capacity_mbps: 350,
  external_satellite_density: 22,
  external_rtt_ms: 75,
  external_throughput_mbps: 80,
}];
const baselinePrediction = applyUserPerformanceCalibration(testContexts, calibration);
const changedTargets = applyUserPerformanceCalibration([{ ...testContexts[0], external_rtt_ms: 9000, external_throughput_mbps: 9000 }], calibration);
assert.equal(baselinePrediction[0].predicted_user_rtt_ms, changedTargets[0].predicted_user_rtt_ms);
assert.equal(baselinePrediction[0].predicted_user_throughput_mbps, changedTargets[0].predicted_user_throughput_mbps);

const inputIndex = process.argv.indexOf("--input");
const artifactDirectory = resolve(inputIndex >= 0
  ? process.argv[inputIndex + 1]
  : "reports/experiment14b-prospective-external-validation");
if (existsSync(join(artifactDirectory, "freeze-manifest.json"))) {
  const freeze = JSON.parse(await readFile(join(artifactDirectory, "freeze-manifest.json"), "utf8"));
  const frozenProtocol = await readFile(join(artifactDirectory, "frozen-protocol.json"));
  const { createHash } = await import("node:crypto");
  assert.equal(createHash("sha256").update(frozenProtocol).digest("hex"), freeze.hashes.protocol_sha256);
  assert.equal(freeze.causality.test_target_values_allowed_for_fit, false);
  if (existsSync(join(artifactDirectory, "mlab", "mlab-split-metadata.json"))) {
    const mlab = JSON.parse(await readFile(join(artifactDirectory, "mlab", "mlab-split-metadata.json"), "utf8"));
    assert.equal(mlab.train_test_uuid_overlap, 0);
    assert.equal(mlab.test_target_values_used_for_fit, 0);
  }
  if (existsSync(join(artifactDirectory, "experiment14b-results.json"))) {
    const results = JSON.parse(await readFile(join(artifactDirectory, "experiment14b-results.json"), "utf8"));
    assert.equal(results.causality_audit.protocol_unchanged, true);
    assert.equal(results.causality_audit.mlab_test_values_used_for_fit, 0);
    assert.equal(results.causality_audit.post_test_parameter_updates, 0);
    assert.equal(results.ns3_cross_validation.evidence_status, "ns3-system-cross-validation-complete");
  }
}

console.log("Experiment 14B prospective-validation tests passed.");
