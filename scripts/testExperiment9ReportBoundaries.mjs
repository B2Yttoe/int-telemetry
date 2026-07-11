import assert from "node:assert/strict";
import {
  buildExperiment9Html,
  buildExperiment9Markdown,
} from "./runExperiment9ExternalValidation.mjs";

const fixture = {
  evidenceStatus: "complete",
  epochRecords: [
    { name: "input", role: "model-input", epoch_start: "2026-07-02T00:00:00.000Z", sha256: "a".repeat(64) },
    { name: "validation", role: "external-validation", epoch_start: "2026-07-06T00:00:00.000Z", sha256: "b".repeat(64) },
  ],
  independenceAudit: { ok: true, violations: [], comparisons: [{ elapsed_hours: 96 }] },
  orbit: {
    summary: {
      matched_satellites: 100,
      eci_position_mae_km: 10,
      radial_mae_km: 1,
      along_track_mae_km: 9,
      cross_track_mae_km: 2,
    },
  },
  external: {
    traffic: { external_radar_points: 168, model_vs_external_radar_corr: 0.9 },
    network: { external_ripe_ping_samples: 958, model_user_ping_p50_ms: 24, external_ripe_rtt_p50_ms: 29 },
  },
};

const markdown = buildExperiment9Markdown(fixture);
const html = buildExperiment9Html(fixture);
for (const text of [markdown, html]) {
  assert.match(text, /CelesTrak/);
  assert.match(text, /Cloudflare Radar/);
  assert.match(text, /RIPE Atlas/);
  assert.match(text, /CPU.*内部潜变量/s);
  assert.match(text, /电量.*内部潜变量/s);
  assert.match(text, /队列.*内部潜变量/s);
  assert.match(text, /不能.*运营商内部真值/s);
  assert.doesNotMatch(text, /CPU 是.*运营商.*真值/s);
}

console.log("Experiment 9 report boundary tests passed.");
