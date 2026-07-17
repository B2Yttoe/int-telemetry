import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  FORMAL_DEFAULTS,
  PROFILE_CATALOG,
  canonicalProbePlanHash,
  collectIntMcMetrics,
  runCommandTimed,
  runIntMcCompletion,
  runIntMcPostSelection,
  runIntMcPass,
  runTwoPassVariant,
  sha256File,
} from "./experiments/intMcExperimentCore.mjs";
import {
  escapeHtml,
  parseCsv,
  rowsToCsv,
} from "./experiments/reportUtils.mjs";

assert.deepEqual(
  PROFILE_CATALOG.map((row) => row.node_count),
  [66, 351, 1584],
);
assert.deepEqual(
  PROFILE_CATALOG.map((row) => row.id),
  ["iridium-next-small", "telesat-1015-medium", "starlink-main-large"],
);
assert.equal(FORMAL_DEFAULTS.slice_count, 48);
assert.equal(FORMAL_DEFAULTS.feedback_lag_slices, 1);
assert.equal(FORMAL_DEFAULTS.observability_mode, "oam-only");

const timed = await runCommandTimed({
  label: "json-smoke",
  script: "scripts/fixtures/printJson.mjs",
  args: [],
  cwd: process.cwd(),
});
assert.equal(timed.result.ok, true);
assert.equal(timed.timing.label, "json-smoke");
assert.equal(timed.timing.exit_code, 0);
assert.ok(timed.timing.wall_time_ms >= 0);
assert.ok(timed.timing.parent_user_cpu_ms >= 0);
assert.ok(timed.timing.parent_system_cpu_ms >= 0);

const planA = [
  {
    slice_index: 1,
    probe_id: "P2",
    source: "B",
    sink: "C",
    path: "B>C",
    metadata_profile: "compact",
    ignored_field: 999,
  },
  {
    slice_index: 0,
    probe_id: "P1",
    source: "A",
    sink: "B",
    path: "A>B",
    metadata_profile: "standard",
  },
];
const planB = [
  {
    metadata_profile: "standard",
    path: "A>B",
    sink: "B",
    source: "A",
    probe_id: "P1",
    slice_index: 0,
    another_ignored_field: "x",
  },
  {
    path: "B>C",
    probe_id: "P2",
    slice_index: 1,
    source: "B",
    sink: "C",
    metadata_profile: "compact",
  },
];
assert.equal(canonicalProbePlanHash(planA), canonicalProbePlanHash(planB));
assert.notEqual(
  canonicalProbePlanHash(planA),
  canonicalProbePlanHash(planB.map((row) => row.probe_id === "P2" ? { ...row, path: "B>D>C" } : row)),
);

const csvFixture = [
  { id: "1", label: "普通节点", detail: "A,B" },
  { id: "2", label: "含\"引号\"", detail: "第一行\n第二行" },
];
assert.deepEqual(parseCsv(rowsToCsv(csvFixture)), csvFixture);
assert.equal(escapeHtml("<节点 kind=\"A&B\">"), "&lt;节点 kind=&quot;A&amp;B&quot;&gt;");

const outputDir = resolve("reports/tmp-int-mc-experiment-core-test");
if (!outputDir.endsWith("tmp-int-mc-experiment-core-test")) {
  throw new Error(`unexpected test directory: ${outputDir}`);
}
if (existsSync(outputDir)) rmSync(outputDir, { recursive: true, force: true });
const truthDir = resolve(outputDir, "truth");
const stage2Dir = resolve(outputDir, "stage2");
const groundDir = resolve(outputDir, "ground");
await Promise.all([
  mkdir(truthDir, { recursive: true }),
  mkdir(stage2Dir, { recursive: true }),
  mkdir(groundDir, { recursive: true }),
]);
await Promise.all([
  writeFile(resolve(truthDir, "metadata.json"), JSON.stringify({
    slice_count: 2,
    node_count: 4,
    truth_fingerprint: "fixture-truth",
  }), "utf8"),
  writeFile(resolve(stage2Dir, "probe-coverage-int-mc.json"), JSON.stringify({
    coverage: {
      selected_paths: 3,
      active_link_sampling_coverage: 0.5,
      reused_slice_plans: 1,
      fresh_slice_plans: 1,
      causal_feedback_violations: 0,
    },
    method: {
      observability_mode: "oam-only",
      feedback_lag_slices: 1,
    },
  }), "utf8"),
  writeFile(resolve(stage2Dir, "probe-int-run-report-int-mc.json"), JSON.stringify({
    overhead: {
      total_telemetry_generated_bytes: 800,
      total_telemetry_energy_j: 2.5,
      hop_records: 12,
      reports: 3,
      total_metadata_bytes: 300,
      total_report_bytes: 400,
      total_probe_packet_base_bytes: 100,
      total_int_bytes: 700,
    },
  }), "utf8"),
  writeFile(resolve(stage2Dir, "probe-summary-int-mc.csv"), [
    "slice_index,selected_paths",
    "0,1",
    "1,2",
  ].join("\n"), "utf8"),
  writeFile(resolve(stage2Dir, "probe-int-link-overhead-int-mc.csv"), [
    "slice_index,link_id,total_telemetry_link_bytes",
    "0,L1,120",
    "1,L1,180",
  ].join("\n"), "utf8"),
  writeFile(resolve(groundDir, "int-mc-evaluation.json"), JSON.stringify({
    reconstruction: {
      direct_observation_rate_on_active: 0.5,
      active_link_completion_coverage: 1,
      inferred_rate_on_active: 0.5,
      status_accuracy_all_links: 0.91,
    },
    metrics: {
      utilization_percent: { mae: 2.1, rmse: 3.2, p95_ae: 5.4, inferred_mae: 4.2 },
      latency_ms: { mae: 0.3 },
    },
    node_reconstruction: {
      node_completion_coverage: 1,
      mode_accuracy_all_nodes: 0.93,
      metrics: {
        cpu_percent: { mae: 1.1, rmse: 2.2, p95_ae: 4.4 },
        queue_depth: { mae: 2.2, rmse: 3.3, p95_ae: 6.6 },
        energy_percent: { mae: 3.3, rmse: 4.4, p95_ae: 8.8 },
      },
    },
    boundary: { truth_metrics_used_only_for_evaluation: true },
    parameters: { node_energy_physics_prior_enabled: true },
  }), "utf8"),
]);

const collected = await collectIntMcMetrics({ truthDir, stage2Dir, groundDir });
assert.equal(collected.slice_count, 2);
assert.equal(collected.nodes_per_slice, 4);
assert.equal(collected.total_telemetry_generated_bytes, 800);
assert.equal(collected.telemetry_bytes_per_node_slice, 100);
assert.equal(collected.total_isl_telemetry_link_bytes, 300);
assert.equal(collected.cpu_mae, 1.1);
assert.equal(collected.queue_depth_mae, 2.2);
assert.equal(collected.energy_percent_mae, 3.3);
assert.equal(collected.node_mode_accuracy, 0.93);
assert.equal(collected.link_status_accuracy, 0.91);
assert.equal(collected.link_utilization_mae, 2.1);
assert.equal(collected.utilization_inferred_mae, 4.2);
assert.equal(collected.feedback_lag_slices, 1);
assert.equal(collected.causal_feedback_violations, 0);

const metadataHash = await sha256File(resolve(truthDir, "metadata.json"));
assert.match(metadataHash, /^[a-f0-9]{64}$/);

const passStage2Dir = resolve(outputDir, "pass-stage2");
const passGroundDir = resolve(outputDir, "pass-ground");
const pass = await runIntMcPass({
  label: "core-pass-smoke",
  truthDir: resolve("exports/tmp-highload-check"),
  candidatePathsPath: resolve("stage2-int/outputs/tmp-highload-check/probe-paths-path-balance.csv"),
  stage2Dir: passStage2Dir,
  groundDir: passGroundDir,
  samplingRate: 0.15,
  targetActiveLinkSamplingRate: 0.15,
  rank: 2,
  windowSize: 6,
  warmupSlices: 2,
  iterations: 1,
  downlinkBudgetBytes: 1_000_000_000,
  maxPathsPerSlice: 2,
  observabilityMode: "oam-only",
  feedbackLagSlices: 1,
  reportingInterruptionRate: 0.2,
  reportingInterruptionSeed: "core-fixture",
  mechanisms: {
    adaptiveReuse: false,
    incrementalTopologyRepair: false,
    forecastRiskScoring: false,
    adaptiveProbeBudget: false,
    metricTensorCoupling: false,
    nodeStateCoupling: false,
    nodeEnergyPhysicsPrior: false,
    jointStateCoupling: false,
    orbitGraphRegularization: false,
    orbitPeriodicPrior: false,
    oamQualityFeedback: false,
    stateTensorJointCompletion: false,
    multiObjectiveBudget: false,
    oamTargetAwareMetadata: false,
  },
});
assert.equal(pass.metrics.slice_count, 24);
assert.equal(pass.metrics.feedback_lag_slices, 1);
assert.equal(pass.metrics.causal_feedback_violations, 0);
assert.ok(pass.metrics.selected_paths > 0);
assert.deepEqual(Object.keys(pass.timings), [
  "contact_prediction",
  "path_selection",
  "reporting_plan",
  "probe_execution",
  "ground_oam",
  "matrix_completion",
]);
assert.ok(Object.values(pass.timings).every((timing) => timing.wall_time_ms >= 0));
assert.ok(existsSync(pass.artifacts.selector_report_json));
assert.ok(existsSync(pass.artifacts.evaluation_json));
const passSelectorReport = JSON.parse(await readFile(pass.artifacts.selector_report_json, "utf8"));
assert.deepEqual(passSelectorReport.method.mechanism_flags, {
  unified_planner: false,
  adaptive_reuse: false,
  incremental_topology_repair: false,
  forecast_risk_scoring: false,
  topology_versioned_objective: false,
  importance_aware_targets: false,
  importance_metadata_only: true,
  importance_path_scoring: false,
  importance_selective_metadata: false,
  importance_budget_neutral_replacement: false,
  importance_strict_forward_only: false,
  scale_adaptive_total_budget: true,
});
const passRunReport = JSON.parse(await readFile(pass.artifacts.run_report_json, "utf8"));
assert.ok(passRunReport.planning.controlled_reporting_interruptions > 0);

const completionOnly = await runIntMcCompletion({
  label: "core-completion-only-smoke",
  truthDir: resolve("exports/tmp-highload-check"),
  stage2Dir: passStage2Dir,
  groundDir: passGroundDir,
  rank: 2,
  windowSize: 6,
  iterations: 1,
  mechanisms: {
    metricTensorCoupling: false,
    nodeStateCoupling: false,
    nodeEnergyPhysicsPrior: false,
    jointStateCoupling: false,
    orbitGraphRegularization: false,
    orbitPeriodicPrior: false,
    oamQualityFeedback: false,
    businessHotspotMigrationPrior: false,
    stateTensorJointCompletion: false,
  },
});
assert.equal(completionOnly.metrics.slice_count, 24);
assert.ok(completionOnly.timing.wall_time_ms >= 0);
assert.equal(completionOnly.artifacts.evaluation_json, pass.artifacts.evaluation_json);

const postSelection = await runIntMcPostSelection({
  label: "core-post-selection-smoke",
  truthDir: resolve("exports/tmp-highload-check"),
  sourceStage2Dir: passStage2Dir,
  telemetryStage2Dir: resolve(outputDir, "post-selection-stage2"),
  groundDir: resolve(outputDir, "post-selection-ground"),
  rank: 2,
  windowSize: 6,
  iterations: 1,
  downlinkBudgetBytes: 1_000_000_000,
  reportingInterruptionRate: 0.2,
  reportingInterruptionSeed: "post-selection-fixture",
  writeEstimateGraph: false,
  mechanisms: {
    metricTensorCoupling: false,
    nodeStateCoupling: false,
    nodeEnergyPhysicsPrior: false,
    jointStateCoupling: false,
    orbitGraphRegularization: false,
    orbitPeriodicPrior: false,
    oamQualityFeedback: false,
    businessHotspotMigrationPrior: false,
    stateTensorJointCompletion: false,
  },
});
assert.equal(postSelection.metrics.selected_paths, pass.metrics.selected_paths);
assert.ok(postSelection.reporting_interruption.interrupted_reports > 0);
assert.equal(existsSync(resolve(outputDir, "post-selection-ground", "ground-oam-estimate-graph.json")), false);
assert.deepEqual(Object.keys(postSelection.timings), ["probe_execution", "ground_oam", "matrix_completion"]);

const twoPassOutputDir = resolve(outputDir, "two-pass");
const twoPassOptions = {
  profile: {
    id: "fixture-small",
    short_label: "Fixture 64",
    scale: "test",
    node_count: 64,
  },
  variant: {
    id: "fixture-enhanced",
    label: "测试增强组",
    useOamFeedback: true,
    mechanisms: {
      adaptiveReuse: false,
      adaptiveProbeBudget: false,
      metricTensorCoupling: false,
      nodeStateCoupling: false,
      nodeEnergyPhysicsPrior: false,
      jointStateCoupling: false,
      orbitGraphRegularization: false,
      orbitPeriodicPrior: false,
      oamQualityFeedback: false,
      stateTensorJointCompletion: false,
      multiObjectiveBudget: false,
      oamTargetAwareMetadata: false,
    },
  },
  truthDir: resolve("exports/tmp-highload-check"),
  candidatePathsPath: resolve("stage2-int/outputs/tmp-highload-check/probe-paths-path-balance.csv"),
  outputDir: twoPassOutputDir,
  parameters: {
    samplingRate: 0.15,
    targetActiveLinkSamplingRate: 0.15,
    rank: 2,
    windowSize: 6,
    warmupSlices: 2,
    iterations: 1,
    downlinkBudgetBytes: 1_000_000_000,
    maxPathsPerSlice: 2,
    observabilityMode: "oam-only",
    feedbackLagSlices: 1,
  },
  resume: true,
};
const twoPass = await runTwoPassVariant(twoPassOptions);
assert.equal(twoPass.resumed, false);
assert.equal(twoPass.before.metrics.slice_count, 24);
assert.equal(twoPass.after.metrics.slice_count, 24);
assert.equal(twoPass.manifest.status, "complete");
assert.equal(twoPass.manifest.feedback_lag_slices, 1);
assert.equal(twoPass.manifest.truth_error_feedback_enabled, false);
assert.match(twoPass.manifest.input_fingerprint, /^[a-f0-9]{64}$/);
assert.ok(twoPass.manifest.combined_feedback_rows > 0);
assert.ok(existsSync(resolve(twoPassOutputDir, "run-manifest.json")));

const resumedTwoPass = await runTwoPassVariant(twoPassOptions);
assert.equal(resumedTwoPass.resumed, true);
assert.equal(resumedTwoPass.manifest.input_fingerprint, twoPass.manifest.input_fingerprint);
assert.deepEqual(resumedTwoPass.before.metrics, twoPass.before.metrics);
assert.deepEqual(resumedTwoPass.after.metrics, twoPass.after.metrics);

const persistedManifest = JSON.parse(await readFile(resolve(twoPassOutputDir, "run-manifest.json"), "utf8"));
assert.equal(persistedManifest.status, "complete");
assert.equal(persistedManifest.variant_id, "fixture-enhanced");

console.log(JSON.stringify({
  ok: true,
  profile_count: PROFILE_CATALOG.length,
  slice_count: FORMAL_DEFAULTS.slice_count,
  feedback_lag_slices: FORMAL_DEFAULTS.feedback_lag_slices,
  command_wall_time_ms: timed.timing.wall_time_ms,
  canonical_plan_hash: canonicalProbePlanHash(planA),
  fixture_metadata_hash: metadataHash,
  pass_selected_paths: pass.metrics.selected_paths,
  pass_wall_time_ms: Object.values(pass.timings).reduce((total, timing) => total + timing.wall_time_ms, 0),
  two_pass_feedback_rows: twoPass.manifest.combined_feedback_rows,
  two_pass_resumed: resumedTwoPass.resumed,
}, null, 2));
