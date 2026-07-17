import assert from "node:assert/strict";
import {
  assessAdaptiveStructuralCacheCandidate,
  assessCachedPathImpact,
  buildTopologyVersion,
  chooseTopologyVersionedPlan,
  refillCandidatesToFixedBudget,
  prefilterTopologyPlanningModes,
  replaceCandidatesWithinFixedBudget,
  selectIncrementalRepairCandidates,
  selectActionsUnderHardBudget,
  selectStructuralCacheBase,
} from "../stage2-int/tools/topology-versioned-risk-planner.mjs";

function action({
  id,
  mode = "fresh",
  bytes = 100,
  observations = [],
  planningCost = 1,
}) {
  return {
    id,
    planning_mode: mode,
    telemetry_bytes: bytes,
    planning_cost: planningCost,
    observations,
  };
}

function observation({
  id,
  type = "link",
  uncertainty = 0.5,
  risk = 0,
  quality = 1,
  similarityGroup = "",
}) {
  return {
    id,
    type,
    uncertainty,
    risk,
    metadata_quality: quality,
    similarity_group: similarityGroup,
  };
}

const version = buildTopologyVersion({
  topologyClassId: "TC-004",
  topologySignature: "abc12345",
  addedLinkIds: ["L3"],
  removedLinkIds: ["L9"],
  nextChangeInSlices: 2,
});
assert.deepEqual(version, {
  class_id: "TC-004",
  active_edge_hash: "abc12345",
  added_link_ids: ["L3"],
  removed_link_ids: ["L9"],
  changed_link_count: 2,
  next_change_in_slices: 2,
  version_id: "TC-004:abc12345:+1:-1:t2",
});

const noCachePrefilter = prefilterTopologyPlanningModes({
  allowedModes: ["reuse", "repair", "fresh"],
  cacheAvailable: false,
  currentTopologySignature: "new",
});
assert.deepEqual(noCachePrefilter.selected_modes, ["fresh"]);
assert.equal(noCachePrefilter.policy, "fresh-no-cache");

const exactReusePrefilter = prefilterTopologyPlanningModes({
  allowedModes: ["reuse", "repair", "fresh"],
  cacheAvailable: true,
  currentTopologySignature: "same",
  cachedTopologySignature: "same",
  activeLinkCount: 1000,
  reuseConfidence: 0.99,
  driftPressure: 0.01,
});
assert.deepEqual(exactReusePrefilter.selected_modes, ["reuse"]);
assert.equal(exactReusePrefilter.policy, "reuse-exact-version");

const localRepairPrefilter = prefilterTopologyPlanningModes({
  allowedModes: ["reuse", "repair", "fresh"],
  cacheAvailable: true,
  currentTopologySignature: "new",
  cachedTopologySignature: "old",
  addedLinkCount: 45,
  removedLinkCount: 42,
  activeLinkCount: 2264,
  reuseConfidence: 0.989,
  driftPressure: 0.016,
  recommendedPlanMode: "reuse-probe-plan",
});
assert.deepEqual(localRepairPrefilter.selected_modes, ["repair"]);
assert.equal(localRepairPrefilter.policy, "repair-high-confidence-local-delta");
assert.ok(localRepairPrefilter.changed_link_ratio < 0.05);

const guardedStructuralRepair = prefilterTopologyPlanningModes({
  allowedModes: ["reuse", "repair", "fresh"],
  cacheAvailable: true,
  currentTopologySignature: "new-medium-version",
  cachedTopologySignature: "old-medium-version",
  addedLinkCount: 30,
  removedLinkCount: 25,
  activeLinkCount: 1000,
  reuseConfidence: 0.5,
  driftPressure: 0.4,
  recommendedPlanMode: "preemptive-replan",
  topologySimilarityScore: 0.945,
  adaptiveReuseThreshold: 0.98,
  cachedPathAffectedRatio: 0.12,
  cachedPathValidRatio: 0.88,
});
assert.deepEqual(guardedStructuralRepair.selected_modes, ["repair"]);
assert.equal(guardedStructuralRepair.policy, "repair-guarded-structural-cache");
assert.equal(guardedStructuralRepair.structural_cache_repair_eligible, true);

const cacheImpact = assessCachedPathImpact({
  cachedPaths: [
    { link_ids: ["L1", "L2"] },
    { link_ids: "L3 > L4" },
    { link_ids: ["L5"] },
  ],
  currentActiveLinkIds: ["L1", "L2", "L3", "L5"],
  changedLinkIds: ["L4", "L6"],
});
assert.equal(cacheImpact.cached_path_count, 3);
assert.equal(cacheImpact.affected_cached_path_count, 1);
assert.equal(cacheImpact.inactive_cached_path_count, 1);
assert.equal(cacheImpact.retained_cached_path_count, 2);

const structuralCache = selectStructuralCacheBase({
  entries: [
    {
      slice_index: 3,
      topology_signature: "old",
      active_link_ids: ["L1", "L2", "L3", "L4", "L5", "L6", "L7", "L8", "L9", "L10"],
      paths: [
        { id: "stable-a", link_ids: ["L1", "L2"] },
        { id: "stable-b", link_ids: ["L3", "L4"] },
        { id: "changed", link_ids: ["L9", "L10"] },
      ],
    },
    {
      slice_index: 5,
      topology_signature: "too-different",
      active_link_ids: ["X1", "X2", "X3"],
      paths: [{ id: "unusable", link_ids: ["X1", "X2"] }],
    },
  ],
  currentActiveLinkIds: ["L1", "L2", "L3", "L4", "L5", "L6", "L7", "L8", "L9", "L11"],
  currentTopologySignature: "current",
  currentSliceIndex: 6,
  cacheWindowSlices: 12,
  guards: {
    minimum_similarity: 0.8,
    maximum_changed_link_ratio: 0.25,
    maximum_affected_path_ratio: 0.4,
    minimum_valid_path_ratio: 0.6,
  },
});
assert.equal(structuralCache.eligible, true);
assert.equal(structuralCache.selected.slice_index, 3);
assert.equal(structuralCache.selected.entry.paths.length, 3);
assert.ok(structuralCache.selected.topology_similarity_score > 0.8);

const fixedBoundaryCandidate = assessAdaptiveStructuralCacheCandidate({
  similarity: 0.925,
  changedLinkRatio: 0.09,
  affectedPathRatio: 0.19,
  validPathRatio: 0.81,
});
assert.equal(fixedBoundaryCandidate.eligible, false);
assert.equal(fixedBoundaryCandidate.effective_guards.minimum_similarity, 0.94);

const adaptiveBoundaryCandidate = assessAdaptiveStructuralCacheCandidate({
  similarity: 0.925,
  changedLinkRatio: 0.09,
  affectedPathRatio: 0.19,
  validPathRatio: 0.81,
  adaptivePolicy: {
    enabled: true,
    relative_error_tolerance: 0.02,
    minimum_similarity_floor: 0.9,
    maximum_changed_link_ratio_ceiling: 0.12,
    maximum_affected_path_ratio_ceiling: 0.25,
    minimum_valid_path_ratio_floor: 0.75,
  },
  forecastDriftPressure: 0.05,
  oamPressure: 0.05,
  reuseConfidence: 0.95,
  planningOverheadPressure: 0.8,
});
assert.equal(adaptiveBoundaryCandidate.eligible, true);
assert.ok(adaptiveBoundaryCandidate.effective_guards.minimum_similarity < 0.925);
assert.ok(adaptiveBoundaryCandidate.estimated_relative_error_increase_proxy <= 0.02);

const highRiskBoundaryCandidate = assessAdaptiveStructuralCacheCandidate({
  similarity: 0.925,
  changedLinkRatio: 0.09,
  affectedPathRatio: 0.19,
  validPathRatio: 0.81,
  cacheAgeSlices: 11,
  cacheWindowSlices: 12,
  adaptivePolicy: {
    enabled: true,
    relative_error_tolerance: 0.02,
    minimum_similarity_floor: 0.9,
    maximum_changed_link_ratio_ceiling: 0.12,
    maximum_affected_path_ratio_ceiling: 0.25,
    minimum_valid_path_ratio_floor: 0.75,
  },
  forecastDriftPressure: 0.9,
  oamPressure: 0.9,
  reuseConfidence: 0.1,
  planningOverheadPressure: 0.2,
  recommendedPlanMode: "preemptive-replan",
});
assert.equal(highRiskBoundaryCandidate.eligible, false);
assert.ok(
  highRiskBoundaryCandidate.effective_guards.minimum_similarity >
    adaptiveBoundaryCandidate.effective_guards.minimum_similarity,
);

const adaptiveStructuralPrefilter = prefilterTopologyPlanningModes({
  allowedModes: ["reuse", "repair", "fresh"],
  cacheAvailable: true,
  currentTopologySignature: "adaptive-new",
  cachedTopologySignature: "adaptive-old",
  addedLinkCount: 48,
  removedLinkCount: 42,
  activeLinkCount: 1000,
  topologySimilarityScore: 0.925,
  cachedPathAffectedRatio: 0.19,
  cachedPathValidRatio: 0.81,
  structuralCacheGuards: adaptiveBoundaryCandidate.effective_guards,
  structuralEstimatedErrorIncrease: adaptiveBoundaryCandidate.estimated_relative_error_increase_proxy,
  structuralRelativeErrorTolerance: 0.02,
});
assert.deepEqual(adaptiveStructuralPrefilter.selected_modes, ["repair"]);
assert.equal(adaptiveStructuralPrefilter.policy, "repair-guarded-structural-cache");

const ambiguousPrefilter = prefilterTopologyPlanningModes({
  allowedModes: ["reuse", "repair", "fresh"],
  cacheAvailable: true,
  currentTopologySignature: "new",
  cachedTopologySignature: "old",
  addedLinkCount: 120,
  removedLinkCount: 90,
  activeLinkCount: 1000,
  reuseConfidence: 0.7,
  driftPressure: 0.18,
});
assert.deepEqual(ambiguousPrefilter.selected_modes, ["fresh"]);
assert.equal(ambiguousPrefilter.policy, "fresh-ambiguous-version");
assert.ok(ambiguousPrefilter.rejection_reasons.includes("changed-link-ratio-above-local-repair-limit"));
assert.ok(ambiguousPrefilter.rejection_reasons.includes("reuse-confidence-below-local-repair-floor"));

const repairDeltaCandidates = selectIncrementalRepairCandidates({
  cachedCandidateIds: ["cached"],
  currentCandidates: [
    { id: "cached", link_ids: ["L1"], node_ids: ["N1", "N2"] },
    { id: "unrelated", link_ids: ["L2"], node_ids: ["N3", "N4"] },
    { id: "changed-link", link_ids: ["L9", "L3"], node_ids: ["N5", "N6"] },
    { id: "mandatory-node", link_ids: ["L4"], node_ids: ["N7", "N8"] },
    { id: "too-long", link_ids: Array.from({ length: 12 }, (_, index) => `X${index}`), node_ids: ["N9"] },
  ],
  changedLinkIds: ["L9", "X1"],
  mandatoryNodeIds: ["N8", "N9"],
  maximumPathLinks: 8,
  maximumDeltaCandidates: 4,
});
assert.deepEqual(repairDeltaCandidates.map((candidate) => candidate.id), ["mandatory-node", "changed-link"]);

const budgetNeutralRepair = replaceCandidatesWithinFixedBudget({
  baseCandidates: [{ id: "base-1" }, { id: "base-2" }, { id: "base-3" }, { id: "base-4" }],
  replacementCandidates: [{ id: "delta-1" }, { id: "delta-2" }, { id: "delta-3" }],
});
assert.deepEqual(budgetNeutralRepair.map((candidate) => candidate.id), ["base-1", "delta-1", "delta-2", "delta-3"]);
assert.equal(budgetNeutralRepair.length, 4, "local repair must not grow the candidate budget");

const refilledRepair = refillCandidatesToFixedBudget({
  selectedCandidates: [
    { id: "stable", node_ids: ["N1", "N2"], link_ids: ["L1"] },
  ],
  fallbackCandidates: [
    { id: "duplicate", node_ids: ["N1", "N2"], link_ids: ["L2"] },
    { id: "representative-a", node_ids: ["N3", "N4"], link_ids: ["L3"] },
    { id: "representative-b", node_ids: ["N5"], link_ids: ["L4"] },
  ],
  candidateBudget: 3,
});
assert.deepEqual(refilledRepair.map((candidate) => candidate.id), ["stable", "representative-a", "representative-b"]);
assert.equal(refilledRepair.length, 3);

const riskPriority = selectActionsUnderHardBudget({
  actions: [
    action({
      id: "stable",
      observations: [observation({ id: "L1", uncertainty: 0.8, risk: 0 })],
    }),
    action({
      id: "at-risk",
      observations: [observation({ id: "L2", uncertainty: 0.7, risk: 1 })],
    }),
  ],
  byteBudget: 100,
  riskWeight: 0.5,
});
assert.deepEqual(riskPriority.selected_actions.map((item) => item.id), ["at-risk"]);
assert.equal(riskPriority.used_bytes, 100);
assert.equal(riskPriority.budget_violations, 0);

const efficient = selectActionsUnderHardBudget({
  actions: [
    action({
      id: "large",
      bytes: 200,
      observations: [observation({ id: "L1", uncertainty: 1 })],
    }),
    action({
      id: "small-a",
      bytes: 80,
      observations: [observation({ id: "L2", uncertainty: 0.65 })],
    }),
    action({
      id: "small-b",
      bytes: 80,
      observations: [observation({ id: "L3", uncertainty: 0.6 })],
    }),
  ],
  byteBudget: 160,
});
assert.deepEqual(efficient.selected_actions.map((item) => item.id), ["small-a", "small-b"]);
assert.ok(efficient.used_bytes <= 160, "hard byte budget must never be exceeded");

const redundancy = selectActionsUnderHardBudget({
  actions: [
    action({
      id: "first",
      bytes: 80,
      observations: [observation({ id: "L1", uncertainty: 1, similarityGroup: "orbit-a" })],
    }),
    action({
      id: "duplicate",
      bytes: 80,
      observations: [observation({ id: "L2", uncertainty: 0.95, similarityGroup: "orbit-a" })],
    }),
    action({
      id: "novel",
      bytes: 80,
      observations: [observation({ id: "L3", uncertainty: 0.8, similarityGroup: "orbit-b" })],
    }),
  ],
  byteBudget: 160,
  redundancyWeight: 0.5,
});
assert.deepEqual(redundancy.selected_actions.map((item) => item.id), ["first", "novel"]);
assert.ok(redundancy.evaluated_redundancy_penalty > 0);

const metadata = selectActionsUnderHardBudget({
  actions: [
    action({
      id: "full",
      bytes: 180,
      observations: [observation({ id: "N1", type: "node", uncertainty: 1, quality: 1 })],
    }),
    action({
      id: "compact",
      bytes: 100,
      observations: [observation({ id: "N1", type: "node", uncertainty: 1, quality: 0.75 })],
    }),
  ],
  byteBudget: 100,
});
assert.deepEqual(metadata.selected_actions.map((item) => item.id), ["compact"]);
assert.equal(metadata.observed_object_count, 1);

const cacheExerciseActions = Array.from({ length: 48 }, (_, index) => action({
  id: `cache-${String(index).padStart(2, "0")}`,
  bytes: 20 + index % 4,
  observations: [
    observation({
      id: `L${index}`,
      uncertainty: 1 - index * 0.01,
      risk: index % 7 === 0 ? 0.5 : 0.1,
      similarityGroup: `orbit-${index % 12}`,
    }),
  ],
}));
const exhaustiveCacheExercise = selectActionsUnderHardBudget({
  actions: cacheExerciseActions,
  byteBudget: 360,
  riskWeight: 0.35,
  redundancyWeight: 0.3,
  selectionEngine: "exhaustive",
});
const lazyCacheExercise = selectActionsUnderHardBudget({
  actions: cacheExerciseActions,
  byteBudget: 360,
  riskWeight: 0.35,
  redundancyWeight: 0.3,
  selectionEngine: "lazy-greedy",
});
const cachedPlanExercise = selectActionsUnderHardBudget({
  actions: cacheExerciseActions,
  byteBudget: 360,
  riskWeight: 0.35,
  redundancyWeight: 0.3,
  selectionEngine: "cached-plan-greedy",
});
assert.deepEqual(
  lazyCacheExercise.selected_actions.map((item) => item.id),
  exhaustiveCacheExercise.selected_actions.map((item) => item.id),
  "lazy greedy must preserve the deterministic exhaustive selection",
);
assert.equal(lazyCacheExercise.used_bytes, exhaustiveCacheExercise.used_bytes);
assert.equal(lazyCacheExercise.total_value, exhaustiveCacheExercise.total_value);
assert.equal(lazyCacheExercise.selection_engine, "lazy-greedy");
assert.equal(exhaustiveCacheExercise.selection_engine, "exhaustive");
assert.ok(
  lazyCacheExercise.marginal_evaluation_count < exhaustiveCacheExercise.marginal_evaluation_count * 0.5,
  `expected cached lazy evaluations to be less than half of exhaustive: lazy=${lazyCacheExercise.marginal_evaluation_count}, exhaustive=${exhaustiveCacheExercise.marginal_evaluation_count}`,
);
assert.ok(lazyCacheExercise.score_cache_hits > 0);
assert.equal(cachedPlanExercise.selection_engine, "cached-plan-greedy");
assert.equal(cachedPlanExercise.budget_violations, 0);
assert.ok(cachedPlanExercise.used_bytes <= 360);
assert.ok(
  cachedPlanExercise.marginal_evaluation_count <= cacheExerciseActions.length * 2,
  "cached-plan validation must evaluate each action at most once after its static score",
);
assert.ok(
  cachedPlanExercise.marginal_evaluation_count < lazyCacheExercise.marginal_evaluation_count,
  `expected cached-plan validation to use fewer evaluations: cached=${cachedPlanExercise.marginal_evaluation_count}, lazy=${lazyCacheExercise.marginal_evaluation_count}`,
);

const equalInformation = chooseTopologyVersionedPlan({
  topologyVersion: version,
  byteBudget: 100,
  planningCostWeight: 0.2,
  candidatesByMode: {
    reuse: [action({ id: "reuse-a", mode: "reuse", planningCost: 0.1, observations: [observation({ id: "L1", uncertainty: 1 })] })],
    repair: [action({ id: "repair-a", mode: "repair", planningCost: 0.5, observations: [observation({ id: "L1", uncertainty: 1 })] })],
    fresh: [action({ id: "fresh-a", mode: "fresh", planningCost: 1, observations: [observation({ id: "L1", uncertainty: 1 })] })],
  },
});
assert.equal(equalInformation.selected_mode, "reuse");
assert.equal(equalInformation.budget_violations, 0);

const freshWins = chooseTopologyVersionedPlan({
  topologyVersion: version,
  byteBudget: 200,
  planningCostWeight: 0.1,
  candidatesByMode: {
    reuse: [action({ id: "reuse-a", mode: "reuse", planningCost: 0.1, observations: [observation({ id: "L1", uncertainty: 0.4 })] })],
    repair: [action({ id: "repair-a", mode: "repair", planningCost: 0.5, observations: [observation({ id: "L1", uncertainty: 0.5 })] })],
    fresh: [
      action({ id: "fresh-a", mode: "fresh", planningCost: 1, observations: [observation({ id: "L1", uncertainty: 1 })] }),
      action({ id: "fresh-b", mode: "fresh", planningCost: 1, observations: [observation({ id: "L2", uncertainty: 1 })] }),
    ],
  },
});
assert.equal(freshWins.selected_mode, "fresh");
assert.deepEqual(freshWins.selected_actions.map((item) => item.id), ["fresh-a", "fresh-b"]);

const noTruthDependency = chooseTopologyVersionedPlan({
  topologyVersion: version,
  byteBudget: 100,
  candidatesByMode: {
    reuse: [
      {
        ...action({ id: "deployable", mode: "reuse", observations: [observation({ id: "L1", uncertainty: 0.7 })] }),
        truth_error: 999,
        simulation_truth: { utilization: 100 },
      },
    ],
  },
});
assert.equal(noTruthDependency.selected_mode, "reuse");
assert.equal(noTruthDependency.audit.truth_fields_consumed, 0);

assert.throws(
  () => selectActionsUnderHardBudget({ actions: [], byteBudget: 0 }),
  /positive hard byte budget/i,
);

console.log("Topology-versioned risk planner tests passed.");
