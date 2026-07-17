import assert from "node:assert/strict";
import {
  buildStaticBaselineMatrix,
  buildStaticBaselineHtml,
  parseStaticBaselineCliParameters,
  replicateStaticProbePlan,
  replayReferenceProbePlan,
} from "./runExperiment8StaticNativeBaseline.mjs";

assert.deepEqual(parseStaticBaselineCliParameters([]), { telemetryByteBudgetPerNodeSlice: 0 });
assert.deepEqual(
  parseStaticBaselineCliParameters(["--telemetry-byte-budget-per-node-slice", "222.5"]),
  { telemetryByteBudgetPerNodeSlice: 222.5 },
);

const replicated = replicateStaticProbePlan({
  initialPlan: [
    { probe_id: "P0", slice_index: 0, time: "t0", source: "A", sink: "B", path: "A > B", link_ids: "L1" },
    { probe_id: "P1", slice_index: 0, time: "t0", source: "C", sink: "D", path: "C > D", link_ids: "L2" },
  ],
  slices: [
    { slice_index: 0, time: "t0" },
    { slice_index: 1, time: "t1" },
    { slice_index: 2, time: "t2" },
  ],
});
assert.equal(replicated.length, 6);
assert.equal(new Set(replicated.map((row) => row.probe_id)).size, 6);
assert.deepEqual([...new Set(replicated.map((row) => row.path))], ["A > B", "C > D"]);
assert.deepEqual(replicated.filter((row) => row.slice_index === 2).map((row) => row.time), ["t2", "t2"]);

const replayed = replayReferenceProbePlan({
  referencePlan: [
    { probe_id: "A", slice_index: 0, time: "old0", path: "A > B", link_ids: "L1" },
    { probe_id: "B", slice_index: 1, time: "old1", path: "C > D", link_ids: "L2" },
  ],
  slices: [
    { slice_index: 0, time: "new0" },
    { slice_index: 1, time: "new1" },
  ],
});
assert.deepEqual(replayed.map((row) => row.time), ["new0", "new1"]);
assert.deepEqual(replayed.map((row) => row.path), ["A > B", "C > D"]);
assert.equal(new Set(replayed.map((row) => row.probe_id)).size, 2);

const matrix = buildStaticBaselineMatrix({
  profileIds: ["small", "medium", "large"],
  stressRates: [0, 0.05, 0.1, 0.15, 0.2, 0.25],
});
assert.equal(matrix.length, 18);

const html = buildStaticBaselineHtml({
  rows: [
    { profile_id: "small", constellation_label: "Small", method_id: "native-reference-replay", method_label: "reference", stress_rate: 0, invalid_probe_path_ratio: 0, cpu_mae: 1, queue_depth_mae: 1, energy_percent_mae: 1, link_utilization_mae: 1, link_status_accuracy: 1, replanned_slices: 0 },
    { profile_id: "small", constellation_label: "Small", method_id: "native-reference-replay", method_label: "reference", stress_rate: 0.25, invalid_probe_path_ratio: 0.3, cpu_mae: 2, queue_depth_mae: 2, energy_percent_mae: 2, link_utilization_mae: 2, link_status_accuracy: 0.9, replanned_slices: 0 },
    { profile_id: "small", constellation_label: "Small", method_id: "native-full-replan", method_label: "full", stress_rate: 0.25, invalid_probe_path_ratio: 0, cpu_mae: 1, queue_depth_mae: 1, energy_percent_mae: 1, link_utilization_mae: 1, link_status_accuracy: 1, replanned_slices: 48, planning_wall_time_ms: 100 },
    { profile_id: "small", constellation_label: "Small", method_id: "enhanced", method_label: "enhanced", stress_rate: 0.25, invalid_probe_path_ratio: 0, cpu_mae: 0.8, queue_depth_mae: 0.8, energy_percent_mae: 0.8, link_utilization_mae: 0.8, link_status_accuracy: 1, replanned_slices: 20, planning_wall_time_ms: 70 },
  ],
});
assert.match(html, /参考计划失效随扰动上升/);
assert.match(html, /30\.00%/);
assert.match(html, /全重规划/);
assert.match(html, /不能预设增强方法在所有指标上都占优/);

console.log("Experiment 8 static native baseline tests passed.");
