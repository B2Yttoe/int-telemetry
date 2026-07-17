import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  buildObservablePlanningLinks,
  buildObservablePlanningNodes,
  scheduleObservableRows,
} from "../stage2-int/tools/int-mc-observability.mjs";

const scheduledGroundFeedback = scheduleObservableRows([
  {
    slice_index: 4,
    target_type: "link",
    target_id: "L-ground",
    priority_score: 0.8,
  },
], { lagSlices: 1 });
assert.equal(scheduledGroundFeedback[0].source_slice_index, 4);
assert.equal(scheduledGroundFeedback[0].slice_index, 5);
assert.equal(scheduledGroundFeedback[0].causal_feedback_lag_slices, 1);

const scheduledDeployableFeedback = scheduleObservableRows([
  {
    source_slice_index: 4,
    slice_index: 5,
    target_type: "link",
    target_id: "L-deployable",
    priority_score: 0.7,
  },
], { lagSlices: 1 });
assert.equal(scheduledDeployableFeedback[0].source_slice_index, 4);
assert.equal(scheduledDeployableFeedback[0].slice_index, 5);
assert.equal(scheduledDeployableFeedback[0].causal_feedback_lag_slices, 1);

const predictedPlan = {
  entries: [
    {
      slice_index: 0,
      time: "2026-07-11T00:00:00.000Z",
      link_id: "L1",
      source: "N1",
      target: "N2",
      kind: "inter-plane",
      predicted_active: true,
      capacity_mbps: 1000,
      distance_km: 1200,
    },
    {
      slice_index: 5,
      time: "2026-07-11T00:05:00.000Z",
      link_id: "L1",
      source: "N1",
      target: "N2",
      kind: "inter-plane",
      predicted_active: true,
      capacity_mbps: 1000,
      distance_km: 1250,
    },
  ],
};

const truthLinks = predictedPlan.entries.map((row) => ({
  ...row,
  is_active: true,
  status: "up",
  utilization_percent: row.slice_index === 5 ? 99 : 1,
}));
const oamLinks = [
  {
    slice_index: 4,
    link_id: "L1",
    status_estimate: "warning",
    utilization_percent_estimate: 42,
    queue_latency_ms_estimate: 3.5,
    confidence: 0.72,
    observation_source: "observed",
  },
  {
    slice_index: 5,
    link_id: "L1",
    status_estimate: "down",
    utilization_percent_estimate: 98,
    queue_latency_ms_estimate: 999,
    confidence: 1,
    observation_source: "future-same-slice",
  },
];

const planningLinks = buildObservablePlanningLinks({
  truthLinks,
  predictedPlan,
  oamLinks,
  mode: "oam-only",
  stateLagSlices: 1,
});
const linkAtSlice0 = planningLinks.find((row) => row.slice_index === 0);
const linkAtSlice5 = planningLinks.find((row) => row.slice_index === 5);
assert.equal(linkAtSlice0.planner_state_source, "predictable-contact-only");
assert.equal(linkAtSlice0.planner_state_source_slice_index, "");
assert.equal(linkAtSlice5.planner_state_source, "ground-oam");
assert.equal(linkAtSlice5.planner_state_source_slice_index, 4);
assert.equal(linkAtSlice5.utilization_percent, 42);
assert.equal(linkAtSlice5.queue_latency_ms, 3.5);
assert.equal(linkAtSlice5.status, "warning");

const truthNodes = [0, 5].map((sliceIndex) => ({
  slice_index: sliceIndex,
  time: `2026-07-11T00:0${sliceIndex}:00.000Z`,
  node_id: "N1",
  plane: 0,
  slot: 0,
  cpu_percent: sliceIndex === 5 ? 99 : 1,
  energy_percent: sliceIndex === 5 ? 2 : 98,
}));
const oamNodes = [
  {
    slice_index: 4,
    node_id: "N1",
    cpu_percent_estimate: 31,
    queue_depth_estimate: 7,
    energy_percent_estimate: 68,
    mode_estimate: "nominal",
    confidence: 0.67,
    observation_source: "inferred",
  },
  {
    slice_index: 5,
    node_id: "N1",
    cpu_percent_estimate: 97,
    queue_depth_estimate: 100,
    energy_percent_estimate: 3,
    mode_estimate: "busy",
    confidence: 1,
    observation_source: "future-same-slice",
  },
];

const planningNodes = buildObservablePlanningNodes({
  truthNodes,
  oamNodes,
  mode: "oam-only",
  stateLagSlices: 1,
});
const nodeAtSlice0 = planningNodes.find((row) => row.slice_index === 0);
const nodeAtSlice5 = planningNodes.find((row) => row.slice_index === 5);
assert.equal(nodeAtSlice0.planner_state_source, "predictable-context-only");
assert.equal(nodeAtSlice0.planner_state_source_slice_index, "");
assert.equal(nodeAtSlice5.planner_state_source, "ground-oam");
assert.equal(nodeAtSlice5.planner_state_source_slice_index, 4);
assert.equal(nodeAtSlice5.cpu_percent, 31);
assert.equal(nodeAtSlice5.queue_depth, 7);
assert.equal(nodeAtSlice5.energy_percent, 68);

for (const row of [...planningLinks, ...planningNodes]) {
  if (row.planner_state_source_slice_index === "") continue;
  assert.ok(
    Number(row.planner_state_source_slice_index) < Number(row.slice_index),
    `planner state for slice ${row.slice_index} must come from an earlier slice`,
  );
}

const selectorOutputDir = resolve("reports/tmp-int-mc-causal-observability-test");
if (!selectorOutputDir.endsWith("tmp-int-mc-causal-observability-test")) {
  throw new Error(`refusing to clean unexpected test directory: ${selectorOutputDir}`);
}
if (existsSync(selectorOutputDir)) rmSync(selectorOutputDir, { recursive: true, force: true });
await mkdir(selectorOutputDir, { recursive: true });
const feedbackPath = resolve(selectorOutputDir, "causal-feedback.csv");
const controlsPath = resolve(selectorOutputDir, "causal-controls.csv");
await writeFile(feedbackPath, [
  "slice_index,target_type,target_id,priority_score,reason,confidence,observation_source,feedback_source,feedback_basis,completion_error_score",
  "0,link,intra-plane:P01-S01->P01-S02,0.8,low-confidence-link-state,0.4,inferred,ground-oam-direct,observable-uncertainty,",
].join("\n"), "utf8");
await writeFile(controlsPath, [
  "slice_index,next_slice_index,recommended_action,probe_bias,confidence_budget,oam_control_pressure,top_link_targets,top_node_targets",
  "0,1,schedule-priority-retest,bias-paths-to-oam-targets,healthy,0.2,intra-plane:P01-S01->P01-S02,P01-S01",
].join("\n"), "utf8");

const baselineRoot = resolve("exports/tmp-highload-check");
const existingStage2Root = resolve("stage2-int/outputs/tmp-highload-check");
const selectorResult = spawnSync(process.execPath, [
  "stage2-int/tools/int-mc-path-selector.mjs",
  "--input", baselineRoot,
  "--stage2", selectorOutputDir,
  "--out", selectorOutputDir,
  "--algorithm", "int-mc",
  "--candidate-algorithm", "path-balance",
  "--candidate-paths", resolve(existingStage2Root, "probe-paths-path-balance.csv"),
  "--sampling-rate", "0.25",
  "--target-active-link-sampling-rate", "0.25",
  "--rank", "5",
  "--selection-strategy", "int-mc-leverage",
  "--window-size", "12",
  "--warmup-slices", "6",
  "--max-paths-per-slice", "12",
  "--observability-mode", "oam-only",
  "--feedback-lag-slices", "1",
  "--planner-oam-links", resolve(existingStage2Root, "ground-reconstructed-links.csv"),
  "--planner-oam-nodes", resolve(existingStage2Root, "ground-reconstructed-nodes.csv"),
  "--oam-priority-retest", feedbackPath,
  "--oam-control-actions", controlsPath,
], { cwd: process.cwd(), encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
if (selectorResult.status !== 0) {
  throw new Error(`causal selector integration failed\nSTDOUT:\n${selectorResult.stdout}\nSTDERR:\n${selectorResult.stderr}`);
}
const selectorReport = JSON.parse(await readFile(
  resolve(selectorOutputDir, "probe-coverage-int-mc.json"),
  "utf8",
));
assert.equal(selectorReport.method.feedback_lag_slices, 1);
assert.equal(selectorReport.method.causal_oam_boundary_enabled, true);
assert.equal(selectorReport.coverage.causal_feedback_violations, 0);
assert.ok(selectorReport.coverage.causal_feedback_rows > 0);

console.log(JSON.stringify({
  ok: true,
  scheduled_ground_feedback_slice: scheduledGroundFeedback[0].slice_index,
  scheduled_deployable_feedback_slice: scheduledDeployableFeedback[0].slice_index,
  link_state_source_slice: linkAtSlice5.planner_state_source_slice_index,
  node_state_source_slice: nodeAtSlice5.planner_state_source_slice_index,
  selector_causal_feedback_rows: selectorReport.coverage.causal_feedback_rows,
}, null, 2));
