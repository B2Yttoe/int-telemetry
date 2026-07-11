import assert from "node:assert/strict";
import { compareOrbitEpochs } from "./experiments/crossEpochOrbitValidation.mjs";

const fixtureEpoch = "2026-07-06T16:51:50.622336Z";

function omm(meanAnomaly = 81.2078, epoch = fixtureEpoch) {
  return {
    OBJECT_NAME: "STARLINK-1008",
    OBJECT_ID: "2019-074B",
    EPOCH: epoch,
    MEAN_MOTION: 15.52687848,
    ECCENTRICITY: 0.0003008,
    INCLINATION: 53.151,
    RA_OF_ASC_NODE: 335.1193,
    ARG_OF_PERICENTER: 278.8592,
    MEAN_ANOMALY: meanAnomaly,
    EPHEMERIS_TYPE: 0,
    CLASSIFICATION_TYPE: "U",
    NORAD_CAT_ID: 44714,
    ELEMENT_SET_NO: 999,
    REV_AT_EPOCH: 36724,
    BSTAR: 0.00098527,
    MEAN_MOTION_DOT: 0.00061836,
    MEAN_MOTION_DDOT: 0,
  };
}

function snapshot(meanAnomaly = 81.2078, epoch = fixtureEpoch) {
  return {
    generated_at: fixtureEpoch,
    satellites: [{
      satellite_id: "P01-S01",
      norad_id: 44714,
      epoch,
      inclination: 53.151,
      raan: 335.1193,
      eccentricity: 0.0003008,
      mean_motion: 15.52687848,
      raw_omm: omm(meanAnomaly, epoch),
    }],
  };
}

const identical = compareOrbitEpochs({
  modelSnapshot: snapshot(),
  validationSnapshot: snapshot(),
  comparisonTime: fixtureEpoch,
});
assert.equal(identical.summary.matched_satellites, 1);
assert.ok(identical.summary.eci_position_mae_km < 1e-6);
assert.ok(Math.abs(identical.rows[0].radial_error_km) < 1e-6);
assert.ok(Math.abs(identical.rows[0].along_track_error_km) < 1e-6);
assert.ok(Math.abs(identical.rows[0].cross_track_error_km) < 1e-6);

const shifted = compareOrbitEpochs({
  modelSnapshot: snapshot(),
  validationSnapshot: snapshot(82.2078),
  comparisonTime: fixtureEpoch,
});
assert.equal(shifted.summary.propagation_failures, 0);
assert.ok(shifted.summary.eci_position_mae_km > 1);
assert.ok(Math.abs(shifted.rows[0].along_track_error_km) > 1);
assert.ok(Number.isFinite(shifted.rows[0].radial_error_km));
assert.ok(Number.isFinite(shifted.rows[0].cross_track_error_km));

const naiveUtcEpoch = "2026-07-06T16:51:50.622336";
const timezoneSafe = compareOrbitEpochs({
  modelSnapshot: snapshot(81.2078, naiveUtcEpoch),
  validationSnapshot: snapshot(81.2078, naiveUtcEpoch),
  comparisonTime: `${naiveUtcEpoch}Z`,
});
assert.equal(timezoneSafe.rows[0].model_epoch, "2026-07-06T16:51:50.622Z");

console.log("Experiment 9 cross-epoch orbit tests passed.");
