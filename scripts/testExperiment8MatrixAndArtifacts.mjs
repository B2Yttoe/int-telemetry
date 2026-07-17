import assert from "node:assert/strict";
import {
  EXPERIMENT8_STRESS_RATES,
  buildExperiment8Html,
  buildExperiment8Matrix,
  buildExperiment8Markdown,
  experiment8ImplementationFingerprint,
  experiment8ParametersFingerprint,
  methodDefinitions,
  parseExperiment8CliParameters,
  refreshCompletionManifest,
  stressTruthCacheMatches,
} from "./runExperiment8DynamicityCausality.mjs";

assert.match(await experiment8ImplementationFingerprint(), /^[a-f0-9]{64}$/);
assert.match(experiment8ParametersFingerprint({ samplingRate: 0.25, telemetryByteBudgetPerNodeSlice: 100 }), /^[a-f0-9]{64}$/);
assert.notEqual(
  experiment8ParametersFingerprint({ samplingRate: 0.25, telemetryByteBudgetPerNodeSlice: 100 }),
  experiment8ParametersFingerprint({ samplingRate: 0.25, telemetryByteBudgetPerNodeSlice: 101 }),
);

const matrix = buildExperiment8Matrix({
  profileIds: ["small", "medium", "large"],
  stressRates: EXPERIMENT8_STRESS_RATES,
  methodIds: ["native", "enhanced"],
});
assert.equal(matrix.length, 36);
assert.deepEqual([...new Set(matrix.map((row) => row.stress_rate))], [0, 0.05, 0.10, 0.15, 0.20, 0.25]);

const methods = methodDefinitions();
assert.deepEqual(methods.map((method) => method.id), ["native", "enhanced"]);
assert.equal(Object.values(methods[0].mechanisms).some(Boolean), false, "native baseline must disable LEO enhancements");
assert.equal(methods[1].mechanisms.adaptiveReuse, true);
assert.equal(methods[1].mechanisms.incrementalTopologyRepair, true);
assert.equal(methods[1].mechanisms.forecastRiskScoring, true);

const refreshedManifest = refreshCompletionManifest({
  manifest: {
    status: "complete",
    implementation_fingerprint: "old",
    run: {
      metrics: { selected_paths: 10, link_utilization_mae: 3 },
      timings: {
        path_selection: { wall_time_ms: 100 },
        matrix_completion: { wall_time_ms: 20 },
      },
      artifacts: { probe_paths_csv: "fixed-plan.csv", evaluation_json: "old-evaluation.json" },
    },
  },
  completion: {
    metrics: { selected_paths: 10, link_utilization_mae: 1 },
    timing: { wall_time_ms: 30 },
    artifacts: { evaluation_json: "new-evaluation.json" },
  },
  implementationFingerprint: "new",
});
assert.equal(refreshedManifest.implementation_fingerprint, "new");
assert.equal(refreshedManifest.run.metrics.link_utilization_mae, 1);
assert.equal(refreshedManifest.run.metrics.selected_paths, 10);
assert.equal(refreshedManifest.run.timings.path_selection.wall_time_ms, 100);
assert.equal(refreshedManifest.run.timings.matrix_completion.wall_time_ms, 30);
assert.equal(refreshedManifest.run.artifacts.probe_paths_csv, "fixed-plan.csv");
assert.equal(refreshedManifest.run.artifacts.evaluation_json, "new-evaluation.json");
assert.equal(refreshedManifest.refresh.scope, "matrix-completion-only");

assert.equal(stressTruthCacheMatches({
  cachedMetadata: {
    config_fingerprint: "config",
    dataset_fingerprint: "dataset",
    experiment8_controlled_stress: {
      seed: "seed:small",
      target_stress_rate: 0.1,
      source_truth_dir: "E:/truth/small",
      causal_replay: true,
    },
  },
  sourceMetadata: { config_fingerprint: "config", dataset_fingerprint: "dataset" },
  sourceTruthDir: "E:/truth/small",
  targetStressRate: 0.1,
  seed: "seed:small",
}), true);
assert.equal(stressTruthCacheMatches({
  cachedMetadata: {
    config_fingerprint: "config",
    dataset_fingerprint: "dataset",
    experiment8_controlled_stress: {
      seed: "seed:small",
      target_stress_rate: 0.1,
      source_truth_dir: "E:/truth/small",
      causal_replay: true,
    },
  },
  sourceMetadata: { config_fingerprint: "config", dataset_fingerprint: "dataset" },
  sourceTruthDir: "E:/truth/small",
  targetStressRate: 0.15,
  seed: "seed:small",
}), false);

assert.deepEqual(parseExperiment8CliParameters([]), {
  samplingRate: 0.25,
  targetActiveLinkSamplingRate: 0.25,
  maxPathsPerSlice: 12,
  reportingInterruptionRate: 0,
  telemetryByteBudgetPerNodeSlice: 0,
  telemetryByteBudgetPadToCap: false,
  tolerance: 0.01,
});
assert.equal(parseExperiment8CliParameters(["--reporting-interruption-rate", "0.1"]).reportingInterruptionRate, 0.1);
assert.equal(
  parseExperiment8CliParameters(["--telemetry-byte-budget-per-node-slice", "321.5"]).telemetryByteBudgetPerNodeSlice,
  321.5,
);
assert.equal(parseExperiment8CliParameters(["--telemetry-byte-budget-pad-to-cap", "true"]).telemetryByteBudgetPadToCap, true);

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
      causal_replay: true,
      causal_invalid_routes: 0,
      causal_invalid_task_traces: 0,
      causal_changed_node_ratio: 0.6,
      causal_changed_link_ratio: 0.2,
      causal_changed_route_ratio: 0.5,
      mean_forced_down_fraction: 0.25,
      polar_disconnection_ratio: 0.1,
      business_hotspot_migration_speed: 0.2,
      reporting_path_interruption_ratio: 0,
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
assert.match(html, /低扰动到高扰动的变化/);
assert.match(html, /因果回放/);
assert.match(html, /非法路由为 0/);
assert.match(html, /控制变量审计/);
assert.match(html, /固定断链密度/);
assert.match(html, /热点迁移速度/);
assert.match(html, /reporting 中断率/);
assert.match(markdown, /固定采样预算/);
assert.match(markdown, /路由之前注入/);
assert.match(markdown, /0% churn/);
assert.match(markdown, /负结果/);
assert.match(markdown, /不预设增强方法必然优于/);
assert.match(markdown, /负结果与边界/);

console.log("Experiment 8 matrix and artifact tests passed.");
