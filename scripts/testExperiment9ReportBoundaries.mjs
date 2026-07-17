import assert from "node:assert/strict";
import {
  buildExperiment9Html,
  buildExperiment9Markdown,
  classifyRadarEvidence,
} from "./runExperiment9ExternalValidation.mjs";

const calibrationFit = classifyRadarEvidence({
  externalReport: {
    inputs: { radar_json: "radar.json" },
    traffic_external: { summary: { external_radar_first_time: "2026-07-01T00:00:00Z", external_radar_last_time: "2026-07-02T23:00:00Z" } },
  },
  trafficMetadata: {
    radar_calibration: {
      source_path: "radar.json",
      first_selected_time: "2026-07-01T00:00:00Z",
      last_selected_time: "2026-07-02T23:00:00Z",
    },
  },
});
assert.equal(calibrationFit.classification, "calibration-fit");
assert.equal(calibrationFit.independent_holdout, false);

const heldOut = classifyRadarEvidence({
  externalReport: {
    inputs: { radar_json: "radar-validation.json" },
    traffic_external: { summary: { external_radar_first_time: "2026-07-08T00:00:00Z", external_radar_last_time: "2026-07-09T23:00:00Z" } },
  },
  trafficMetadata: {
    radar_calibration: {
      source_path: "radar-training.json",
      first_selected_time: "2026-07-01T00:00:00Z",
      last_selected_time: "2026-07-02T23:00:00Z",
    },
  },
});
assert.equal(heldOut.classification, "temporal-holdout");
assert.equal(heldOut.independent_holdout, true);

const fixture = {
  evidenceStatus: "complete",
  epochRecords: [
    { name: "input", role: "model-input", epoch_start: "2026-07-02T00:00:00.000Z", sha256: "a".repeat(64) },
    { name: "validation", role: "external-validation", epoch_start: "2026-07-06T00:00:00.000Z", sha256: "b".repeat(64) },
    { name: "validation 2", role: "external-validation", epoch_start: "2026-07-10T00:00:00.000Z", sha256: "c".repeat(64) },
  ],
  independenceAudit: { ok: true, violations: [], comparisons: [{ elapsed_hours: 96 }] },
  orbit: {
    summary: {
      matched_satellites: 100,
      validation_epoch_count: 2,
      eci_position_mae_km: 10,
      radial_mae_km: 1,
      along_track_mae_km: 9,
      cross_track_mae_km: 2,
    },
    per_epoch: [
      { validation_id: "validation-1", comparison_time: "2026-07-06T00:00:00Z", epoch_separation_mean_hours: 96, matched_satellites: 100, eci_position_mae_km: 10 },
      { validation_id: "validation-2", comparison_time: "2026-07-10T00:00:00Z", epoch_separation_mean_hours: 192, matched_satellites: 100, eci_position_mae_km: 25 },
    ],
  },
  external: {
    traffic: { external_radar_points: 168, model_vs_external_radar_corr: 0.9 },
    network: { external_ripe_ping_samples: 958, model_user_ping_p50_ms: 24, external_ripe_rtt_p50_ms: 29 },
    radar_evidence: { classification: "calibration-fit", independent_holdout: false },
  },
};

const markdown = buildExperiment9Markdown(fixture);
const html = buildExperiment9Html(fixture);
for (const text of [markdown, html]) {
  assert.match(text, /CelesTrak/);
  assert.match(text, /平均历元间隔/);
  assert.match(text, /Cloudflare Radar/);
  assert.match(text, /RIPE Atlas/);
  assert.match(text, /2 个独立验证历元/);
  assert.match(text, /校准拟合/);
  assert.match(text, /不是独立留出验证/);
  assert.match(text, /CPU.*内部潜变量/s);
  assert.match(text, /电量.*内部潜变量/s);
  assert.match(text, /队列.*内部潜变量/s);
  assert.match(text, /不能.*运营商内部真值/s);
  assert.doesNotMatch(text, /CPU 是.*运营商.*真值/s);
}

console.log("Experiment 9 report boundary tests passed.");
