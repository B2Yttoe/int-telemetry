import assert from "node:assert/strict";
import { aggregateOrbitEpochComparisons } from "./experiments/multiEpochOrbitValidation.mjs";

const aggregate = aggregateOrbitEpochComparisons([
  {
    validation_id: "epoch-a",
    validation_sha256: "a".repeat(64),
    result: {
      summary: { matched_satellites: 2, successful_propagations: 2, propagation_failures: 0, comparison_time: "2026-07-06T00:00:00.000Z" },
      rows: [
        { norad_id: 1, epoch_separation_hours: 72, eci_position_error_km: 10, radial_error_km: 2, along_track_error_km: 9, cross_track_error_km: 1 },
        { norad_id: 2, epoch_separation_hours: 72, eci_position_error_km: 20, radial_error_km: -4, along_track_error_km: 18, cross_track_error_km: -2 },
      ],
    },
  },
  {
    validation_id: "epoch-b",
    validation_sha256: "b".repeat(64),
    result: {
      summary: { matched_satellites: 1, successful_propagations: 1, propagation_failures: 0, comparison_time: "2026-07-10T00:00:00.000Z" },
      rows: [
        { norad_id: 1, epoch_separation_hours: 168, eci_position_error_km: 30, radial_error_km: 6, along_track_error_km: 27, cross_track_error_km: 3 },
      ],
    },
  },
]);

assert.equal(aggregate.summary.validation_epoch_count, 2);
assert.equal(aggregate.summary.matched_satellite_epoch_pairs, 3);
assert.equal(aggregate.summary.eci_position_mae_km, 20);
assert.equal(aggregate.summary.radial_mae_km, 4);
assert.equal(aggregate.summary.epoch_separation_min_hours, 72);
assert.equal(aggregate.summary.epoch_separation_max_hours, 168);
assert.equal(aggregate.rows.length, 3);
assert.deepEqual([...new Set(aggregate.rows.map((row) => row.validation_id))], ["epoch-a", "epoch-b"]);
assert.equal(aggregate.per_epoch.length, 2);

assert.throws(() => aggregateOrbitEpochComparisons([]), /at least one/i);

console.log("Experiment 9 multi-epoch orbit aggregation tests passed.");
