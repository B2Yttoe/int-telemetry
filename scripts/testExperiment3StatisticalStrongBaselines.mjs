import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  buildSeededPathPlan,
  pairedMovingBlockBootstrap,
  pairedWinTieLoss,
} from "./experiments/experiment3StrongBaselineStats.mjs";

const candidatePaths = [
  { slice_index: 0, probe_id: "a", path: "n1 > n2", link_ids: "e1", path_link_count: 1 },
  { slice_index: 0, probe_id: "b", path: "n2 > n3 > n4", link_ids: "e2 > e3", path_link_count: 2 },
  { slice_index: 0, probe_id: "c", path: "n4 > n1", link_ids: "e4", path_link_count: 1 },
  { slice_index: 1, probe_id: "d", path: "n1 > n3", link_ids: "e5", path_link_count: 1 },
  { slice_index: 1, probe_id: "e", path: "n3 > n4", link_ids: "e6", path_link_count: 1 },
];
const truthLinks = [
  { slice_index: 0, link_id: "e1", is_active: true },
  { slice_index: 0, link_id: "e2", is_active: true },
  { slice_index: 0, link_id: "e3", is_active: true },
  { slice_index: 0, link_id: "e4", is_active: true },
  { slice_index: 1, link_id: "e5", is_active: true },
  { slice_index: 1, link_id: "e6", is_active: true },
];
const budgets = new Map([["0", 2], ["1", 1]]);
const first = buildSeededPathPlan({
  candidatePaths,
  truthLinks,
  pathLinkBudgetBySlice: budgets,
  seed: 11,
  algorithm: "seed-11",
});
const repeated = buildSeededPathPlan({
  candidatePaths,
  truthLinks,
  pathLinkBudgetBySlice: budgets,
  seed: 11,
  algorithm: "seed-11",
});
assert.deepEqual(first, repeated, "同一 seed 必须得到相同路径计划");
assert.ok(first.summaryRows.every((row) => row.selected_path_links <= row.path_link_budget));
assert.ok(first.selectedRows.every((row) => row.experiment3_observation_seed === 11));

const pairs = [];
for (const runId of ["seed-11", "seed-23", "seed-37"]) {
  for (let sliceIndex = 0; sliceIndex < 48; sliceIndex += 1) {
    pairs.push({ run_id: runId, slice_index: sliceIndex, delta: -0.5 - (sliceIndex % 4) * 0.01 });
  }
}
const bootstrap = pairedMovingBlockBootstrap({ pairs, blockLength: 4, iterations: 1000, seed: "test" });
assert.ok(bootstrap.ci95_high < 0, "稳定负差值的置信区间上界应小于 0");
assert.equal(bootstrap.run_count, 3);
assert.equal(bootstrap.paired_samples, 144);
assert.deepEqual(pairedWinTieLoss(pairs), { wins: 144, ties: 0, losses: 0, total: 144 });

const runnerSource = await readFile(new URL("./runExperiment3StatisticalStrongBaselines.mjs", import.meta.url), "utf8");
assert.ok(runnerSource.includes("same_actual_telemetry_bytes_within_profile_seed"));
assert.ok(runnerSource.includes("hidden_truth_used_only_for_posthoc_evaluation"));
assert.ok(runnerSource.includes("paired-moving-block"));
assert.ok(runnerSource.includes("kalman_rts_is_offline_noncausal_reference"));
assert.ok(runnerSource.includes("cpu_percent,queue_depth,energy_percent"));
assert.ok(runnerSource.includes("utilization_percent"));

console.log("experiment 3 statistical strong-baseline tests passed");
