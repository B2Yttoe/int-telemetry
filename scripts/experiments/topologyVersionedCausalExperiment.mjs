export const EXPERIMENT12_PROFILE_IDS = Object.freeze([
  "telesat-1015-medium",
  "starlink-main-large",
]);

export const EXPERIMENT12_PROFILE_BUDGETS = Object.freeze({
  "telesat-1015-medium": 435.7265,
  "starlink-main-large": 21.3359,
});

export const EXPERIMENT12_PLANNING_FLAGS = Object.freeze([
  "plannerModes",
  "riskWeight",
  "informationGainMode",
  "metadataActions",
]);

const FROZEN_NON_PLANNING_MECHANISMS = Object.freeze({
  adaptiveProbeBudget: false,
  metricTensorCoupling: false,
  nodeStateCoupling: false,
  nodeEnergyPhysicsPrior: false,
  jointStateCoupling: false,
  orbitGraphRegularization: false,
  orbitPeriodicPrior: false,
  businessHotspotMigrationPrior: false,
  stateTensorJointCompletion: false,
  multiObjectiveBudget: false,
  oamTargetAwareMetadata: false,
  oamQualityFeedback: false,
});

const VARIANT_STEPS = Object.freeze([
  {
    id: "full-unified",
    label: "完整统一算法",
    contribution: "拓扑版本、风险、边际信息和 metadata 联合决策",
    ablation: "none",
    planning: {},
  },
  {
    id: "no-topology-version",
    label: "无拓扑版本",
    contribution: "检验复用与局部修复的规划开销贡献",
    ablation: "plannerModes",
    planning: { plannerModes: "fresh" },
  },
  {
    id: "no-risk",
    label: "无风险收益",
    contribution: "检验切换前风险采样贡献",
    ablation: "riskWeight",
    planning: { riskWeight: 0 },
  },
  {
    id: "no-marginal-information",
    label: "无边际信息",
    contribution: "检验不确定性和去冗余的单位字节收益",
    ablation: "informationGainMode",
    planning: { informationGainMode: "coverage-only" },
  },
  {
    id: "fixed-metadata",
    label: "固定完整 metadata",
    contribution: "检验逐跳 metadata 动作的通信开销贡献",
    ablation: "metadataActions",
    planning: { metadataActions: "full" },
  },
]);

const UNIFIED_PLANNING_DEFAULTS = Object.freeze({
  planner: "topology-versioned-risk-int",
  plannerModes: "reuse,repair,fresh",
  riskWeight: 0.35,
  redundancyWeight: 0.3,
  planningCostWeight: 0.05,
  predictionHorizon: 4,
  informationGainMode: "marginal",
  metadataActions: "full,compact,selective",
  adaptiveReuse: true,
  topologyVersionedObjective: false,
  incrementalTopologyRepair: true,
  forecastRiskScoring: true,
});

export function buildExperiment12Variants() {
  return VARIANT_STEPS.map((step, index) => Object.freeze({
    id: step.id,
    label: step.label,
    contribution: step.contribution,
    ablation: step.ablation,
    order: index,
    useOamFeedback: true,
    mechanisms: Object.freeze({
      ...FROZEN_NON_PLANNING_MECHANISMS,
      ...UNIFIED_PLANNING_DEFAULTS,
      ...step.planning,
    }),
  }));
}

export function buildExperiment12Matrix({
  profileIds = EXPERIMENT12_PROFILE_IDS,
  stressRates = [0, 0.1, 0.25],
  variants = buildExperiment12Variants(),
} = {}) {
  return profileIds.flatMap((profileId) =>
    stressRates.flatMap((stressRate) =>
      variants.map((variant) => ({
        profile_id: profileId,
        stress_rate: Number(stressRate),
        variant_id: variant.id,
      }))))
  ;
}

export function validateVariantLadder(variants = buildExperiment12Variants()) {
  const errors = [];
  const isolatedChanges = [];
  if (variants.length !== VARIANT_STEPS.length) {
    errors.push(`Expected ${VARIANT_STEPS.length} variants, received ${variants.length}`);
  }
  const full = variants[0];
  if (full?.id !== "full-unified") errors.push("The first variant must be full-unified");
  for (let index = 1; index < variants.length; index += 1) {
    const current = variants[index];
    const changed = EXPERIMENT12_PLANNING_FLAGS.filter(
      (flag) => full?.mechanisms?.[flag] !== current.mechanisms?.[flag],
    );
    const expected = current.ablation;
    if (changed.length !== 1 || changed[0] !== expected) {
      errors.push(`${current.id}: expected only ${expected} to differ from full-unified; changed=${changed.join(",") || "none"}`);
    }
    isolatedChanges.push(changed.length === 1 ? changed[0] : changed.join("+"));
  }
  const mechanismKeys = Object.keys(FROZEN_NON_PLANNING_MECHANISMS);
  for (const key of mechanismKeys) {
    const values = new Set(variants.map((variant) => variant.mechanisms?.[key]));
    if (values.size !== 1) errors.push(`${key}: non-planning mechanism must stay fixed`);
  }
  return {
    valid: errors.length === 0,
    errors,
    adjacent_changes: isolatedChanges,
    comparison_policy: "each-ablation-versus-full-unified",
  };
}

function finiteSlice(value) {
  if (value === "" || value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function causalViolations(rows, sourceField, rowType) {
  const violations = [];
  rows.forEach((row, rowIndex) => {
    const sourceSlice = finiteSlice(row[sourceField]);
    const targetSlice = finiteSlice(row.slice_index);
    if (sourceSlice === null || targetSlice === null) return;
    if (sourceSlice >= targetSlice) {
      violations.push({
        row_type: rowType,
        row_index: rowIndex,
        source_slice_index: sourceSlice,
        target_slice_index: targetSlice,
        reason: "non-causal-source-slice",
      });
    }
  });
  return violations;
}

export function auditStrictCausalReplay({
  manifest = {},
  selectorReport = {},
  feedbackRows = [],
  plannerRows = [],
} = {}) {
  const violations = [
    ...causalViolations(feedbackRows, "source_slice_index", "feedback"),
    ...causalViolations(plannerRows, "planner_state_source_slice_index", "planner-state"),
  ];
  const feedbackBasisLeaks = feedbackRows.filter((row) =>
    /truth|oracle|simulation-validation-error/i.test(String(row.feedback_basis ?? row.reason ?? ""))
  ).length;
  const selectorViolations = Number(selectorReport.coverage?.causal_feedback_violations ?? 0);
  const checks = [
    {
      id: "minimum-feedback-lag",
      passed: Number(manifest.feedback_lag_slices) >= 1,
      observed: manifest.feedback_lag_slices ?? "",
      expected: ">= 1",
    },
    {
      id: "truth-error-feedback-disabled",
      passed: manifest.truth_error_feedback_enabled === false && feedbackBasisLeaks === 0,
      observed: `${manifest.truth_error_feedback_enabled ?? "missing"}; basis_leaks=${feedbackBasisLeaks}`,
      expected: "false; basis_leaks=0",
    },
    {
      id: "oam-only-observability",
      passed: manifest.observability_mode === "oam-only",
      observed: manifest.observability_mode ?? "missing",
      expected: "oam-only",
    },
    {
      id: "selector-causal-boundary",
      passed: selectorReport.method?.causal_oam_boundary_enabled === true && selectorViolations === 0,
      observed: `${selectorReport.method?.causal_oam_boundary_enabled ?? "missing"}; violations=${selectorViolations}`,
      expected: "true; violations=0",
    },
    {
      id: "feedback-row-order",
      passed: violations.every((violation) => violation.row_type !== "feedback"),
      observed: violations.filter((violation) => violation.row_type === "feedback").length,
      expected: 0,
    },
    {
      id: "planner-row-order",
      passed: violations.every((violation) => violation.row_type !== "planner-state"),
      observed: violations.filter((violation) => violation.row_type === "planner-state").length,
      expected: 0,
    },
  ];
  return {
    passed: checks.every((check) => check.passed),
    violation_count: violations.length,
    violations,
    checks,
  };
}
