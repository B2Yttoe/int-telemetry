import assert from "node:assert/strict";
import {
  EXPERIMENT8_STRESS_RATES,
  buildExperiment8Html,
  buildExperiment8Matrix,
  buildExperiment8Markdown,
  methodDefinitions,
  parseExperiment8CliParameters,
} from "./runExperiment8DynamicityCausality.mjs";

const matrix = buildExperiment8Matrix({
  profileIds: ["small", "medium", "large"],
  stressRates: EXPERIMENT8_STRESS_RATES,
  methodIds: ["native", "enhanced"],
});
assert.equal(matrix.length, 30);
assert.deepEqual([...new Set(matrix.map((row) => row.stress_rate))], [0.05, 0.10, 0.15, 0.20, 0.25]);

const methods = methodDefinitions();
assert.deepEqual(methods.map((method) => method.id), ["native", "enhanced"]);
assert.equal(Object.values(methods[0].mechanisms).some(Boolean), false, "native baseline must disable LEO enhancements");
assert.equal(methods[1].mechanisms.adaptiveReuse, true);
assert.equal(methods[1].mechanisms.incrementalTopologyRepair, true);
assert.equal(methods[1].mechanisms.forecastRiskScoring, true);

assert.deepEqual(parseExperiment8CliParameters([]), {
  samplingRate: 0.25,
  targetActiveLinkSamplingRate: 0.25,
  maxPathsPerSlice: 12,
  tolerance: 0.01,
});

const fixture = {
  parameters: { sampling_rate: 0.25, max_paths_per_slice: 12 },
  summaryRows: [
    {
      constellation_label: "Iridium 66",
      method_label: "原生 INT-MC",
      target_stress_rate: 0.05,
      achieved_stress_rate: 0.05,
      achieved_mean_dynamicity: 0.18,
      telemetry_bytes_per_node_slice: 100,
      cpu_mae: 1,
      queue_depth_mae: 2,
      energy_percent_mae: 3,
      link_utilization_mae: 4,
      link_status_accuracy: 0.9,
      path_failure_ratio: 0.1,
      fresh_slice_plans: 10,
      planning_wall_time_ms: 20,
    },
  ],
  fairnessAudits: [{ ok: true }],
  slopeRows: [{ constellation_label: "Iridium 66", method_label: "原生 INT-MC", metric: "link_utilization_mae", slope: 1.2 }],
};

const html = buildExperiment8Html(fixture);
const markdown = buildExperiment8Markdown(fixture);
assert.match(html, /受控 churn rate/);
assert.match(html, /Jaccard/);
assert.match(html, /路径失效率/);
assert.match(html, /候选路径失效率/);
assert.match(html, /跨片计划失效率/);
assert.match(markdown, /固定采样预算/);
assert.match(markdown, /负结果/);
assert.match(markdown, /不预设增强方法必然优于/);

console.log("Experiment 8 matrix and artifact tests passed.");
