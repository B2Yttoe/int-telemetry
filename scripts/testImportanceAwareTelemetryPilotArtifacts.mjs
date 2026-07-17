import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  PILOT_VARIANTS,
  evaluatePilotGate,
  resolvePilotProfile,
} from "./runImportanceAwareTelemetryPilot.mjs";
import { parseCsv } from "./experiments/reportUtils.mjs";

function argValue(args, name, fallback = "") {
  const index = args.indexOf(name);
  return index === -1 ? fallback : (args[index + 1] ?? fallback);
}

function numberValue(value, fallback = 0) {
  if (value === "" || value === null || value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const baseline = {
  total_telemetry_generated_bytes: 1000,
  cpu_mae: 10,
  queue_depth_mae: 20,
  energy_percent_mae: 5,
  link_utilization_mae: 8,
  node_mode_accuracy: 0.95,
  link_status_accuracy: 0.96,
  critical_cpu_mae: 12,
  critical_queue_depth_mae: 22,
  critical_energy_percent_mae: 6,
  critical_link_utilization_mae: 9,
  cpu_anomaly_recall: 0.7,
  cpu_anomaly_support: 10,
  utilization_anomaly_recall: 0.8,
  utilization_anomaly_support: 10,
  congestion_anomaly_recall: 0.75,
  congestion_anomaly_support: 10,
  aoi_max_slices: 6,
};

const accepted = evaluatePilotGate(baseline, {
  ...baseline,
  total_telemetry_generated_bytes: 700,
  critical_cpu_mae: 11,
  cpu_anomaly_recall: 0.72,
});
assert.equal(accepted.gate_passed, true);
assert.equal(accepted.primary_goal_achieved, true);
assert.equal(accepted.bytes_reduced, true);
assert.equal(accepted.anomaly_supported_metric_count, 3);

const rejected = evaluatePilotGate(baseline, {
  ...baseline,
  total_telemetry_generated_bytes: 700,
  cpu_mae: 10.2,
});
assert.equal(rejected.gate_passed, false, "a 2% global MAE regression must fail the 1% gate");

const subUnitBaseline = {
  ...baseline,
  link_utilization_mae: 0.45,
};
const rejectedSubUnitRegression = evaluatePilotGate(subUnitBaseline, {
  ...subUnitBaseline,
  total_telemetry_generated_bytes: 700,
  link_utilization_mae: 0.455,
});
assert.equal(
  rejectedSubUnitRegression.gate_passed,
  false,
  "a greater-than-1% regression must fail even when the baseline MAE is below one",
);

assert.equal(PILOT_VARIANTS.length, 4);
const maskOnly = PILOT_VARIANTS.find((item) => item.id === "importance-mask-only");
const pathFull = PILOT_VARIANTS.find((item) => item.id === "importance-path-full-metadata");
const pathSelective = PILOT_VARIANTS.find((item) => item.id === "importance-path-selective");
assert.equal(maskOnly.mechanisms.importanceSelectiveMetadata, true);
assert.equal(maskOnly.mechanisms.importancePathScoring, false);
assert.equal(maskOnly.mechanisms.oamTargetAwareMetadata, true);
assert.equal(pathFull.mechanisms.importanceSelectiveMetadata, false);
assert.equal(pathFull.mechanisms.importancePathScoring, true);
assert.equal(pathSelective.mechanisms.oamTargetAwareMetadata, true);

const customProfile = {
  id: "anomaly-highload-small",
  short_label: "高负载异常场景",
  scale: "small",
  node_count: 64,
};
assert.equal(resolvePilotProfile("anomaly-highload-small", [customProfile]), customProfile);
assert.throws(() => resolvePilotProfile("missing-profile", []), /Unknown profile/);

const input = argValue(process.argv.slice(2), "--input", "");
if (input) {
  const root = resolve(input);
  const jsonPath = join(root, "importance-aware-pilot-summary.json");
  const csvPath = join(root, "importance-aware-pilot-summary.csv");
  const markdownPath = join(root, "importance-aware-pilot-summary.md");
  for (const path of [jsonPath, csvPath, markdownPath]) {
    assert.equal(existsSync(path), true, `missing pilot artifact: ${path}`);
  }
  const [result, rows] = await Promise.all([
    readFile(jsonPath, "utf8").then(JSON.parse),
    readFile(csvPath, "utf8").then(parseCsv),
  ]);
  assert.equal(result.schema_version, "importance-aware-telemetry-pilot-v1");
  assert.equal(result.status, "complete");
  assert.equal(result.scope.truth_role, "post-run-evaluation-only");
  assert.equal(result.scope.hidden_stage1_metrics_used_by_planner, false);
  assert.equal(rows.length, result.profiles.length * result.variants.length);

  for (const row of rows) {
    const componentBytes = [
      "total_metadata_bytes",
      "total_target_mask_bytes",
      "total_report_bytes",
      "total_probe_packet_base_bytes",
    ].reduce((sum, field) => sum + numberValue(row[field]), 0);
    assert.equal(
      componentBytes,
      numberValue(row.total_telemetry_generated_bytes),
      `${row.profile_id}/${row.variant_id} byte decomposition must equal actual total`,
    );
    assert.equal(row.observability_mode, "oam-only");
    assert.equal(numberValue(row.feedback_lag_slices), 1);
    assert.equal(numberValue(row.causal_feedback_violations), 0);
    assert.equal(row.truth_metrics_used_only_for_evaluation, "true");
    for (const field of [
      "cpu_mae",
      "queue_depth_mae",
      "energy_percent_mae",
      "link_utilization_mae",
      "aoi_max_slices",
    ]) {
      assert.equal(Number.isFinite(numberValue(row[field], Number.NaN)), true, `${field} must be finite`);
    }
  }

  for (const profile of result.profiles) {
    const profileRows = rows.filter((row) => row.profile_id === profile.profile.id);
    const baselineRow = profileRows.find((row) => row.variant_id === "enhanced-current");
    const maskRow = profileRows.find((row) => row.variant_id === "importance-mask-only");
    assert.ok(baselineRow);
    if (maskRow) {
      assert.equal(maskRow.probe_plan_hash, baselineRow.probe_plan_hash, "metadata-only mode must preserve probe paths");
      assert.equal(maskRow.same_probe_plan_as_baseline, "true");
    }
    const selectiveRows = profileRows.filter((row) => row.variant_id.includes("selective") || row.variant_id === "importance-mask-only");
    assert.ok(selectiveRows.every((row) => numberValue(row.total_target_mask_bytes) > 0), "selective metadata must account for target masks");
    assert.ok(numberValue(profile.target_count) > 0, "importance target plan must be non-empty");

    const pathSelectiveRow = profileRows.find((row) => row.variant_id === "importance-path-selective");
    if (pathSelectiveRow) {
      const [candidatePaths, candidateSummary] = await Promise.all([
        readFile(join(root, profile.profile.id, "importance-path-selective", "stage2", "importance-path-selective", "probe-paths-int-mc.csv"), "utf8").then(parseCsv),
        readFile(join(root, profile.profile.id, "importance-path-selective", "stage2", "importance-path-selective", "probe-summary-int-mc.csv"), "utf8").then(parseCsv),
      ]);
      const baseCount = candidateSummary.reduce(
        (sum, row) => sum + numberValue(row.importance_base_selected_paths),
        0,
      );
      const summaryRepairCount = candidateSummary.reduce(
        (sum, row) => sum + numberValue(row.importance_additive_repair_paths),
        0,
      );
      assert.equal(
        candidatePaths.length,
        baseCount + summaryRepairCount,
        "the online candidate must finish its complete base selection before appending bounded repair paths",
      );
      const declaredRepairCount = candidatePaths.filter(
        (row) => String(row.planning_importance_additive_repair).toLowerCase() === "true",
      ).length;
      assert.equal(declaredRepairCount, summaryRepairCount, "every additive repair path must be explicitly marked in the path artifact");
    }
  }
}

console.log(JSON.stringify({
  status: "passed",
  artifact_validation: Boolean(input),
  input: input ? resolve(input) : "",
}, null, 2));
