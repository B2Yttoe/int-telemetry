import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = lines[0].split(",");
  return lines.slice(1).map((line) => {
    const values = [];
    let cell = "";
    let quoted = false;
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index];
      if (char === '"') quoted = !quoted;
      else if (char === "," && !quoted) {
        values.push(cell);
        cell = "";
      } else cell += char;
    }
    values.push(cell);
    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]));
  });
}

const outputDir = resolve("reports/tmp-experiment2-oracle-free-boundary-test");
if (!outputDir.includes("tmp-experiment2-oracle-free-boundary-test")) {
  throw new Error(`refusing to clean unexpected path: ${outputDir}`);
}
if (existsSync(outputDir)) rmSync(outputDir, { recursive: true, force: true });

const result = spawnSync(process.execPath, [
  "scripts/runExperiment2IntMcEnhancementComparison.mjs",
  "--profiles", "iridium-next-small",
  "--out", outputDir,
  "--int-mc-sampling-rate", "0.25",
  "--int-mc-target-active-link-sampling-rate", "0.25",
  "--int-mc-iterations", "4",
  "--int-mc-window-size", "12",
  "--int-mc-warmup-slices", "6",
  "--int-mc-max-paths-per-slice", "12",
], { cwd: process.cwd(), encoding: "utf8" });
if (result.status !== 0) {
  throw new Error(`oracle-free boundary experiment failed\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
}

const summary = JSON.parse(await readFile(resolve(outputDir, "experiment2-int-mc-enhancement-comparison.json"), "utf8"));
const manifest = summary.run_manifests[0];
assert.equal(summary.parameters.observability_mode, "oam-only");
assert.equal(summary.parameters.truth_error_feedback_enabled, false);
assert.ok(String(manifest.deployable_feedback_csv).endsWith("int-mc-deployable-priority-retest.csv"));

const feedbackRows = parseCsv(await readFile(manifest.combined_feedback_csv, "utf8"));
assert.ok(feedbackRows.length > 0, "oracle-free comparison should still produce deployable feedback");
assert.ok(feedbackRows.every((row) => row.feedback_source !== "int-mc-completion"));
assert.ok(feedbackRows.every((row) => row.completion_error_score === ""));
assert.ok(feedbackRows.every((row) => !String(row.reason).includes("simulation-validation-error")));

const selector = JSON.parse(await readFile(manifest.pass2_selector_json, "utf8"));
assert.equal(selector.method.observability_mode, "oam-only");
assert.equal(selector.method.hidden_stage1_metrics_available_to_planner, false);
assert.equal(selector.method.planner_dynamic_state_source, "lagged-ground-oam-estimates");
assert.equal(selector.method.feedback_lag_slices, 1);
assert.equal(selector.coverage.causal_feedback_violations, 0);

const evaluation = JSON.parse(await readFile(manifest.pass2_evaluation_json, "utf8"));
assert.equal(evaluation.parameters.node_energy_physics_prior_enabled, true);
assert.equal(evaluation.boundary.truth_metrics_used_only_for_evaluation, true);
assert.equal(evaluation.boundary.node_energy_physics_prior_uses_predictable_solar_and_static_load_context, true);
assert.equal(evaluation.completion_feedback.uses_truth_error, false);

console.log(JSON.stringify({
  ok: true,
  outputDir,
  feedback_rows: feedbackRows.length,
  observability_mode: selector.method.observability_mode,
}, null, 2));
