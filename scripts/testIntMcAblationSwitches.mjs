import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const outputRoot = resolve("reports/tmp-int-mc-ablation-switches-test");
if (!outputRoot.endsWith("tmp-int-mc-ablation-switches-test")) {
  throw new Error(`refusing to clean unexpected test directory: ${outputRoot}`);
}
if (existsSync(outputRoot)) rmSync(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });

function run(label, script, args) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`${label} failed\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  }
}

const truthDir = resolve("exports/tmp-highload-check");
const candidatePathsPath = resolve("stage2-int/outputs/tmp-highload-check/probe-paths-path-balance.csv");
const contactDir = resolve(outputRoot, "contact");
run("contact prediction", "stage2-int/tools/predict-contact-plan.mjs", [
  "--input", truthDir,
  "--out", contactDir,
  "--completion-window-slices", "6",
]);
const contactPath = resolve(contactDir, "predicted-contact-plan.json");

const feedbackPath = resolve(outputRoot, "feedback.csv");
await writeFile(feedbackPath, [
  "slice_index,target_type,target_id,priority_score,reason,confidence,confidence_pressure,observation_source,feedback_source,feedback_basis,completion_error_score",
  "20,link,intra-plane:P07-S08->P07-S01,0.95,low-confidence-link-state,0.2,0.8,inferred,ground-oam-direct,observable-uncertainty,",
].join("\n"), "utf8");

async function runSelector(id, extraArgs) {
  const out = resolve(outputRoot, id);
  run(id, "stage2-int/tools/int-mc-path-selector.mjs", [
    "--input", truthDir,
    "--stage2", out,
    "--out", out,
    "--algorithm", "int-mc",
    "--candidate-algorithm", "path-balance",
    "--candidate-paths", candidatePathsPath,
    "--sampling-rate", "0.25",
    "--target-active-link-sampling-rate", "0.25",
    "--rank", "3",
    "--selection-strategy", "int-mc-leverage",
    "--window-size", "6",
    "--warmup-slices", "2",
    "--max-paths-per-slice", "4",
    "--topology-class-threshold", "0.35",
    "--predicted-contact-plan", contactPath,
    "--observability-mode", "oam-only",
    "--feedback-lag-slices", "1",
    "--oam-priority-retest", feedbackPath,
    ...extraArgs,
  ]);
  return JSON.parse(await readFile(resolve(out, "probe-coverage-int-mc.json"), "utf8"));
}

const full = await runSelector("full", [
  "--adaptive-reuse", "true",
  "--incremental-topology-repair", "true",
  "--forecast-risk-scoring", "true",
]);
const noReuse = await runSelector("no-reuse", [
  "--adaptive-reuse", "false",
  "--incremental-topology-repair", "true",
  "--forecast-risk-scoring", "true",
]);
const noIncremental = await runSelector("no-incremental", [
  "--adaptive-reuse", "true",
  "--incremental-topology-repair", "false",
  "--forecast-risk-scoring", "true",
]);
const noForecast = await runSelector("no-forecast", [
  "--adaptive-reuse", "true",
  "--incremental-topology-repair", "true",
  "--forecast-risk-scoring", "false",
]);

assert.deepEqual(full.method.mechanism_flags, {
  adaptive_reuse: true,
  incremental_topology_repair: true,
  forecast_risk_scoring: true,
});
assert.deepEqual(noReuse.method.mechanism_flags, {
  adaptive_reuse: false,
  incremental_topology_repair: true,
  forecast_risk_scoring: true,
});
assert.deepEqual(noIncremental.method.mechanism_flags, {
  adaptive_reuse: true,
  incremental_topology_repair: false,
  forecast_risk_scoring: true,
});
assert.deepEqual(noForecast.method.mechanism_flags, {
  adaptive_reuse: true,
  incremental_topology_repair: true,
  forecast_risk_scoring: false,
});
assert.ok(full.coverage.reused_slice_plans > 0, "stable fixture should exercise topology-plan reuse");
assert.equal(noReuse.coverage.reused_slice_plans, 0);
assert.ok(full.coverage.incremental_delta_candidate_paths > 0, "fixture should exercise OAM delta candidates");
assert.equal(noIncremental.coverage.incremental_delta_candidate_paths, 0);
assert.equal(noForecast.method.uses_predicted_contact_plan, true);
assert.equal(noForecast.coverage.active_link_samples, full.coverage.active_link_samples);

console.log(JSON.stringify({
  ok: true,
  full_reused_slices: full.coverage.reused_slice_plans,
  no_reuse_reused_slices: noReuse.coverage.reused_slice_plans,
  full_incremental_delta_candidates: full.coverage.incremental_delta_candidate_paths,
  no_incremental_delta_candidates: noIncremental.coverage.incremental_delta_candidate_paths,
  active_link_samples: full.coverage.active_link_samples,
}, null, 2));
