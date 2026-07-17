import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildFreshWalkerSnapshot, summarizeOrbitEpochAges } from "./experiments/freshOrbitAcquisition.mjs";
import { medianEpoch } from "./experiments/experiment14Sources.mjs";
import { normalizeOrbitEpochUtc, parseOrbitEpochUtcMs } from "./experiments/utcEpoch.mjs";

const ROOT = resolve(import.meta.dirname, "..");

function record(id, raan, anomaly) {
  return {
    OBJECT_NAME: `UTC-TEST-${id}`,
    OBJECT_ID: `2026-001${String.fromCharCode(64 + id)}`,
    EPOCH: "2026-01-01T00:00:00.000000",
    MEAN_MOTION: 15.2 + id * 0.00001,
    ECCENTRICITY: 0.0001,
    INCLINATION: 43,
    RA_OF_ASC_NODE: raan,
    ARG_OF_PERICENTER: 0,
    MEAN_ANOMALY: anomaly,
    NORAD_CAT_ID: 90000 + id,
    BSTAR: 0,
  };
}

async function childMapping() {
  const records = [
    record(1, 0, 0), record(2, 0.2, 120), record(3, 359.8, 240),
    record(4, 180, 0), record(5, 180.2, 120), record(6, 179.8, 240),
  ];
  const snapshot = await buildFreshWalkerSnapshot(records, {
    group: "UTC-TEST",
    sourceUrl: "https://example.invalid/utc-test",
    downloadedAt: "2026-01-01T01:00:00.000Z",
    planes: 2,
    satellitesPerPlane: 2,
    raanClusterThresholdDeg: 2.5,
  });
  return snapshot.satellites.map((row) => ({
    norad_id: row.norad_id,
    plane_id: row.plane_id,
    slot_id: row.slot_id,
    epoch: row.epoch,
  }));
}

function mappingForTimezone(timezone) {
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--child"], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, TZ: timezone },
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  return JSON.parse(child.stdout);
}

if (process.argv.includes("--child")) {
  console.log(JSON.stringify(await childMapping()));
} else {
  const naive = "2026-01-01T00:00:00.000000";
  assert.equal(normalizeOrbitEpochUtc(naive), `${naive}Z`);
  assert.equal(normalizeOrbitEpochUtc(`${naive}Z`), `${naive}Z`);
  assert.equal(normalizeOrbitEpochUtc("2026-01-01T08:00:00+08:00"), "2026-01-01T08:00:00+08:00");
  assert.equal(parseOrbitEpochUtcMs(naive), Date.parse(`${naive}Z`));

  const age = summarizeOrbitEpochAges([{ EPOCH: naive }], new Date("2026-01-01T01:00:00.000Z"));
  assert.equal(age.age_p50_hours, 1);
  assert.equal(age.epoch_median, "2026-01-01T00:00:00.000Z");
  assert.equal(medianEpoch([{ EPOCH: naive }]), "2026-01-01T00:00:00.000Z");

  const shanghai = mappingForTimezone("Asia/Shanghai");
  const utc = mappingForTimezone("UTC");
  assert.deepEqual(shanghai, utc, "Walker sampling and plane-slot mapping must be timezone invariant");
  assert.ok(utc.every((row) => row.epoch.endsWith("Z")));
  console.log("Orbit UTC epoch normalization tests passed.");
}
