import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  buildRadarBlindHoldout,
  compareDistributions,
  parseCsv,
} from "./experiments/blindValidationMetrics.mjs";

const protocol = JSON.parse(await readFile(resolve("scripts/experiments/experiment14-blind-protocol.json"), "utf8"));

function syntheticRadar(testShift = 0) {
  const start = Date.parse("2026-01-01T00:00:00Z");
  return Array.from({ length: 168 }, (_, index) => ({
    time: new Date(start + index * 3_600_000).toISOString(),
    value: 0.7 + 0.18 * Math.sin((2 * Math.PI * index) / 24) + 0.04 * Math.cos((2 * Math.PI * index) / 12) + (index >= 84 ? testShift : 0),
  }));
}

const baseline = buildRadarBlindHoldout(syntheticRadar(), protocol.radar);
const shiftedTest = buildRadarBlindHoldout(syntheticRadar(10), protocol.radar);
assert.equal(baseline.summary.calibration_points, 84);
assert.equal(baseline.summary.blind_test_points, 84);
assert.equal(baseline.summary.test_values_used_for_fit, 0);
assert.equal(baseline.summary.test_values_used_for_interval_calibration, 0);
assert.deepEqual(baseline.coefficients, shiftedTest.coefficients, "Changing blind-test values must not alter fitted parameters");
assert.deepEqual(
  baseline.rows.slice(0, 84).map((row) => row.model_predicted_value),
  shiftedTest.rows.slice(0, 84).map((row) => row.model_predicted_value),
  "Blind-test values must not feed back into calibration predictions",
);
assert.equal(new Set(baseline.rows.slice(0, 84).map((row) => row.time)).size, 84);
assert.equal(
  baseline.rows.slice(0, 84).some((row) => baseline.rows.slice(84).some((test) => test.time === row.time)),
  false,
  "Radar calibration and test timestamps must not overlap",
);

const parsed = parseCsv('id,label,note\r\n1,"alpha,beta","quoted ""text"""\r\n');
assert.deepEqual(parsed, [{ id: "1", label: "alpha,beta", note: 'quoted "text"' }]);

const comparison = compareDistributions([10, 20, 30, 40, 50], [12, 22, 32, 42, 52]);
assert.ok(comparison.ks_distance >= 0 && comparison.ks_distance <= 1);
assert.ok(Number.isFinite(comparison.wasserstein_distance));
assert.ok("p025" in comparison.model && "p975" in comparison.model);

const inputIndex = process.argv.indexOf("--input");
const artifactDir = resolve(inputIndex >= 0
  ? process.argv[inputIndex + 1]
  : "reports/experiment14-multisource-external-blind-validation");

if (existsSync(join(artifactDir, "experiment14-manifest.json"))) {
  const manifest = JSON.parse(await readFile(join(artifactDir, "experiment14-manifest.json"), "utf8"));
  const audit = JSON.parse(await readFile(join(artifactDir, manifest.outputs.causality_audit), "utf8"));
  const results = JSON.parse(await readFile(join(artifactDir, manifest.outputs.results_json), "utf8"));
  const registry = JSON.parse(await readFile(join(artifactDir, "external-source-registry.json"), "utf8"));
  assert.equal(audit.freeze_precedes_external_test_acquisition, true);
  assert.equal(audit.protocol_unchanged_after_scoring, true);
  assert.equal(audit.radar_test_values_used_for_fit, 0);
  assert.equal(audit.radar_test_values_used_for_interval_calibration, 0);
  assert.equal(audit.test_set_parameter_updates, 0);
  assert.equal(audit.strict_pipeline_holdout_passed, true);
  assert.equal(results.radar.blind_test_points, 84);
  assert.ok(results.confidence_interval_coverage.length >= 3);
  assert.ok(registry.some((row) => row.role === "external-blind-test" && String(row.source).includes("M-Lab")));
  assert.ok(registry.filter((row) => row.role === "external-blind-test").every((row) => row.used_for_parameter_fit === false));
  for (const output of Object.values(manifest.outputs)) {
    assert.ok(existsSync(join(artifactDir, output)), `Missing experiment 14 output: ${output}`);
  }
}

console.log("Experiment 14 blind-validation tests passed.");
