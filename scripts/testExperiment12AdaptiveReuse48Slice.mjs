import assert from "node:assert/strict";
import {
  aggregatePlanning,
  buildOverall,
  evaluateQuality,
} from "./runExperiment12AdaptiveReuse48SliceGeneralization.mjs";

const planning = aggregatePlanning([
  {
    slice_index: "0",
    unified_planner_selected_mode: "fresh",
    unified_structural_cache_effective_similarity_threshold: "",
    unified_structural_cache_source_slice: "",
    planning_candidate_paths: "10",
    unified_planner_score_cache_recomputations: "8",
    unified_planner_marginal_evaluations: "12",
  },
  {
    slice_index: "1",
    unified_planner_selected_mode: "repair",
    unified_structural_cache_eligible: "true",
    unified_structural_cache_adaptive_enabled: "true",
    unified_structural_cache_effective_similarity_threshold: "0.92",
    unified_structural_cache_relaxation_factor: "0.5",
    unified_structural_cache_source_slice: "0",
    planning_candidate_paths: "10",
    unified_planner_score_cache_recomputations: "4",
    unified_planner_marginal_evaluations: "6",
    selected_repaired_paths: "2",
  },
]);

assert.equal(planning.trigger_slices, 1);
assert.equal(planning.modes.repair, 1);
assert.equal(planning.minimum_effective_similarity_threshold, 0.92);
assert.equal(planning.maximum_effective_similarity_threshold, 0.92);
assert.equal(planning.structural_source_causal_violations, 0);

const fresh = {
  planning: { hard_budget_violations: 0 },
  metrics: {
    cpu_mae: 1,
    queue_depth_mae: 1,
    energy_percent_mae: 1,
    link_utilization_mae: 1,
    node_mode_accuracy: 0.99,
    link_status_accuracy: 0.99,
    total_telemetry_generated_bytes: 1000,
    total_telemetry_energy_j: 100,
    telemetry_byte_budget_cap_violations: 0,
    causal_feedback_violations: 0,
    causal_oam_boundary_enabled: true,
  },
};
const adaptive = {
  planning: { hard_budget_violations: 0 },
  metrics: {
    ...fresh.metrics,
    cpu_mae: 1.01,
    total_telemetry_generated_bytes: 1005,
    total_telemetry_energy_j: 100.9,
  },
};
assert.equal(evaluateQuality(adaptive, fresh, { passed: true }).passed, true);
adaptive.metrics.total_telemetry_energy_j = 101.1;
assert.equal(evaluateQuality(adaptive, fresh, { passed: true }).passed, false);

const scenarioRow = {
  slices: 48,
  adaptive_trigger_slices: 10,
  adaptive_reuse_slices: 0,
  adaptive_repair_slices: 10,
  planning_work_reduction_vs_fresh_percent: 10,
  score_recomputation_reduction_vs_fresh_percent: 12,
  marginal_evaluation_reduction_vs_fresh_percent: 8,
  telemetry_byte_reduction_vs_fresh_percent: 1,
  telemetry_energy_reduction_vs_fresh_percent: -0.5,
  adaptive_similarity_threshold_mean: 0.92,
  adaptive_similarity_threshold_min: 0.91,
  adaptive_similarity_threshold_max: 0.93,
  hard_budget_violations: 0,
  causal_violations: 0,
  quality_gates_passed: true,
};
const overall = buildOverall([
  scenarioRow,
  { ...scenarioRow, adaptive_trigger_slices: 12, adaptive_repair_slices: 12 },
  { ...scenarioRow, adaptive_trigger_slices: 0, adaptive_repair_slices: 0 },
]);
assert.equal(overall.generalization_passed, true);
assert.equal(overall.generalization_type, "local-repair-only");
assert.equal(overall.total_slices, 144);

console.log("Experiment 12 adaptive 48-slice tests passed.");
