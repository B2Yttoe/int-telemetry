import { createHash } from "node:crypto";

export const TOPOLOGY_REUSE_EVIDENCE_PROFILES = Object.freeze([
  "telesat-1015-medium",
  "starlink-main-large",
]);

export const TOPOLOGY_REUSE_EVIDENCE_STRESS_RATES = Object.freeze([0, 0.1, 0.25]);
export const TOPOLOGY_REUSE_EVIDENCE_SEEDS = Object.freeze(["seed-00", "seed-01", "seed-02"]);
export const TOPOLOGY_REUSE_EVIDENCE_VARIANTS = Object.freeze(["full-unified", "no-topology-version"]);

export const TOPOLOGY_REUSE_EVIDENCE_WINDOWS = Object.freeze({
  "telesat-1015-medium": Object.freeze([
    Object.freeze({ id: "window-00", epoch_iso: "2026-06-16T00:00:00.000Z" }),
    Object.freeze({ id: "window-08", epoch_iso: "2026-06-16T08:00:00.000Z" }),
    Object.freeze({ id: "window-16", epoch_iso: "2026-06-16T16:00:00.000Z" }),
  ]),
  "starlink-main-large": Object.freeze([
    Object.freeze({ id: "window-00", epoch_iso: "2026-07-02T20:00:00.000Z" }),
    Object.freeze({ id: "window-08", epoch_iso: "2026-07-03T04:00:00.000Z" }),
    Object.freeze({ id: "window-16", epoch_iso: "2026-07-03T12:00:00.000Z" }),
  ]),
});

const LOWER_BETTER_EFFECTS = Object.freeze({
  planning_candidate_paths: "planning_candidate_reduction_percent",
  unified_planner_marginal_evaluations: "marginal_evaluation_reduction_percent",
  unified_planner_score_cache_recomputations: "score_cache_recomputation_reduction_percent",
  planning_wall_time_ms: "planning_wall_time_reduction_percent",
  telemetry_bytes_per_node_slice: "telemetry_byte_reduction_percent",
  total_telemetry_energy_j: "telemetry_energy_reduction_percent",
});

export const TOPOLOGY_REUSE_PRIMARY_EFFECTS = Object.freeze([
  "marginal_evaluation_reduction_percent",
  "score_cache_recomputation_reduction_percent",
]);

function numberValue(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value, digits = 6) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : 0;
}

function mean(values) {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0;
}

function sampleStandardDeviation(values) {
  if (values.length < 2) return 0;
  const center = mean(values);
  return Math.sqrt(values.reduce((total, value) => total + (value - center) ** 2, 0) / (values.length - 1));
}

function tCritical95(degreesOfFreedom) {
  const table = [
    0, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262,
    2.228, 2.201, 2.179, 2.160, 2.145, 2.131, 2.120, 2.110, 2.101, 2.093,
    2.086, 2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045, 2.042,
  ];
  if (degreesOfFreedom <= 0) return 0;
  if (degreesOfFreedom < table.length) return table[degreesOfFreedom];
  if (degreesOfFreedom <= 40) return 2.021;
  if (degreesOfFreedom <= 60) return 2;
  if (degreesOfFreedom <= 120) return 1.98;
  return 1.96;
}

export function confidenceSummary(values = []) {
  const finite = values.map(Number).filter(Number.isFinite);
  const center = mean(finite);
  const standardDeviation = sampleStandardDeviation(finite);
  const halfWidth = finite.length > 1
    ? tCritical95(finite.length - 1) * standardDeviation / Math.sqrt(finite.length)
    : 0;
  return {
    sample_count: finite.length,
    mean: round(center),
    std: round(standardDeviation),
    ci95_low: round(center - halfWidth),
    ci95_high: round(center + halfWidth),
    minimum: finite.length ? round(Math.min(...finite)) : 0,
    maximum: finite.length ? round(Math.max(...finite)) : 0,
  };
}

function combination(n, k) {
  if (k < 0 || k > n) return 0;
  const effective = Math.min(k, n - k);
  let result = 1;
  for (let index = 1; index <= effective; index += 1) {
    result = result * (n - effective + index) / index;
  }
  return result;
}

export function pairedSignTest(values = []) {
  const finite = values.map(Number).filter(Number.isFinite);
  const positive = finite.filter((value) => value > 1e-12).length;
  const negative = finite.filter((value) => value < -1e-12).length;
  const nonzero = positive + negative;
  if (nonzero === 0) return { positive, negative, ties: finite.length, nonzero, p_value_two_sided: 1 };
  const tail = Math.min(positive, negative);
  let probability = 0;
  for (let k = 0; k <= tail; k += 1) probability += combination(nonzero, k) * (0.5 ** nonzero);
  return {
    positive,
    negative,
    ties: finite.length - nonzero,
    nonzero,
    p_value_two_sided: round(Math.min(1, 2 * probability), 9),
  };
}

function stableObject(value) {
  if (Array.isArray(value)) return value.map(stableObject);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableObject(value[key])]));
}

export function designFingerprint(value) {
  return createHash("sha256").update(JSON.stringify(stableObject(value))).digest("hex");
}

export function buildTopologyReuseEvidenceMatrix({
  profileIds = TOPOLOGY_REUSE_EVIDENCE_PROFILES,
  stressRates = TOPOLOGY_REUSE_EVIDENCE_STRESS_RATES,
  seeds = TOPOLOGY_REUSE_EVIDENCE_SEEDS,
} = {}) {
  if (stressRates.length !== seeds.length) {
    throw new Error("The preregistered Latin-square design requires equal stress and seed level counts");
  }
  return profileIds.flatMap((profileId) => {
    const windows = TOPOLOGY_REUSE_EVIDENCE_WINDOWS[profileId];
    if (!windows) throw new Error(`No preregistered windows for ${profileId}`);
    if (windows.length !== seeds.length) {
      throw new Error(`The preregistered Latin-square design requires ${seeds.length} windows for ${profileId}`);
    }
    return windows.flatMap((window, windowIndex) => stressRates.map((stressRate, stressIndex) => {
      const seed = seeds[(windowIndex + stressIndex) % seeds.length];
      const stressId = `stress-${String(Math.round(numberValue(stressRate) * 100)).padStart(2, "0")}`;
      return Object.freeze({
        profile_id: profileId,
        window_id: window.id,
        window_index: windowIndex,
        epoch_iso: window.epoch_iso,
        stress_rate: numberValue(stressRate),
        stress_id: stressId,
        seed,
        case_id: `${window.id}-${stressId}-${seed}`,
      });
    }));
  });
}

export function buildTopologyReusePreregistration(options = {}) {
  const matrix = buildTopologyReuseEvidenceMatrix(options);
  const design = {
    schema_version: "experiment12-topology-reuse-preregistration-v2",
    design: "three-by-three-latin-square-paired-comparison",
    slice_count: 48,
    cache_window_slices: 12,
    profiles: [...new Set(matrix.map((row) => row.profile_id))],
    windows: TOPOLOGY_REUSE_EVIDENCE_WINDOWS,
    stress_rates: [...new Set(matrix.map((row) => row.stress_rate))],
    seeds: [...new Set(matrix.map((row) => row.seed))].sort(),
    variants: [...TOPOLOGY_REUSE_EVIDENCE_VARIANTS],
    neutral_pass1_planner: "efficient-fresh",
    matrix,
    primary_hypothesis: "Topology-versioned reuse and local repair reduce deterministic planner work under the same hard telemetry budget without more than 1% reconstruction-MAE regression.",
    primary_effects: [...TOPOLOGY_REUSE_PRIMARY_EFFECTS],
    secondary_effects: [
      "planning_candidate_reduction_percent",
      "planning_wall_time_reduction_percent",
      "telemetry_byte_reduction_percent",
      "telemetry_energy_reduction_percent",
      "active_link_direct_coverage_delta",
    ],
    noninferiority_gates: {
      maximum_metric_mae_regression_percent: 1,
      telemetry_byte_increase_percent: 1,
      hard_budget_violations: 0,
      causal_violations: 0,
      invalid_probe_path_ratio: 0,
    },
    inference: {
      paired_unit: "same profile, epoch window, stress rate and seed",
      interval: "two-sided Student-t 95% confidence interval over paired effects",
      robustness: "two-sided paired sign test",
      wall_time_role: "secondary noisy metric; deterministic work counters are primary",
      trigger_conditioning: "reported separately and never used to remove preregistered cases",
    },
    truth_boundary: "Planner inputs remain past Ground OAM plus predictable orbital topology; Stage-1 truth is evaluation-only.",
    protocol_amendment: "The first two implementation-pilot cases used the legacy neutral pass-1 planner. After observing 271 seconds of common pass-1 planning time, the preregistered formal matrix was amended to use the same fresh-only unified planner for both variants. Pilot outcomes are invalidated and rerun; treatment planners, budgets, metrics and gates are unchanged.",
  };
  return { ...design, design_sha256: designFingerprint(design) };
}

function activeLinkSet(rows = []) {
  return new Set(rows
    .filter((row) => ["true", "1"].includes(String(row.is_active).toLowerCase()))
    .map((row) => String(row.link_id)));
}

function setDifferenceCount(left, right) {
  let count = 0;
  left.forEach((value) => {
    if (!right.has(value)) count += 1;
  });
  return count;
}

function setSimilarity(left, right) {
  let intersection = 0;
  left.forEach((value) => {
    if (right.has(value)) intersection += 1;
  });
  const union = left.size + right.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

export function scanTopologyReuseEligibility(links = [], { cacheWindowSlices = 12 } = {}) {
  const bySlice = new Map();
  links.forEach((row) => {
    const slice = numberValue(row.slice_index);
    if (!bySlice.has(slice)) bySlice.set(slice, []);
    bySlice.get(slice).push(row);
  });
  const slices = [...bySlice.keys()].sort((left, right) => left - right);
  const history = [];
  const perSlice = [];
  for (const sliceIndex of slices) {
    const current = activeLinkSet(bySlice.get(sliceIndex));
    const candidates = history.slice(-Math.max(1, cacheWindowSlices));
    let best = null;
    candidates.forEach((candidate) => {
      const similarity = setSimilarity(current, candidate.active);
      const changed = setDifferenceCount(current, candidate.active) + setDifferenceCount(candidate.active, current);
      const changedRatio = changed / Math.max(1, current.size);
      if (!best || similarity > best.similarity || (similarity === best.similarity && candidate.slice_index > best.slice_index)) {
        best = { slice_index: candidate.slice_index, similarity, changed, changedRatio };
      }
    });
    const exact = Boolean(best && best.changed === 0);
    const repairEligible = Boolean(best && !exact && best.changedRatio <= 0.08);
    perSlice.push({
      slice_index: sliceIndex,
      active_links: current.size,
      historical_slice_index: best?.slice_index ?? "",
      best_historical_jaccard: round(best?.similarity ?? 0),
      changed_link_count: best?.changed ?? current.size,
      changed_link_ratio: round(best?.changedRatio ?? 1),
      exact_reuse_eligible: exact,
      local_repair_eligible: repairEligible,
      topology_mode_eligibility: exact ? "reuse" : repairEligible ? "repair" : "fresh",
    });
    history.push({ slice_index: sliceIndex, active: current });
  }
  return {
    per_slice: perSlice,
    summary: {
      slice_count: perSlice.length,
      exact_reuse_eligible_slices: perSlice.filter((row) => row.exact_reuse_eligible).length,
      local_repair_eligible_slices: perSlice.filter((row) => row.local_repair_eligible).length,
      fresh_only_slices: perSlice.filter((row) => row.topology_mode_eligibility === "fresh").length,
      mean_best_historical_jaccard: round(mean(perSlice.map((row) => row.best_historical_jaccard))),
      mean_changed_link_ratio: round(mean(perSlice.map((row) => row.changed_link_ratio))),
      scan_role: "topology-only eligibility audit; not an observed algorithm trigger",
    },
  };
}

function scenarioKey(row) {
  return `${row.profile_id}|${row.case_id}`;
}

function relativeReduction(fullValue, freshValue) {
  const full = numberValue(fullValue);
  const fresh = numberValue(freshValue);
  return round((fresh - full) / Math.max(Math.abs(fresh), 1e-12) * 100);
}

function relativeRegression(fullValue, freshValue) {
  const full = numberValue(fullValue);
  const fresh = numberValue(freshValue);
  return round((full - fresh) / Math.max(Math.abs(fresh), 1e-12) * 100);
}

export function buildTopologyReusePairedRows(summaryRows = []) {
  const groups = new Map();
  summaryRows.forEach((row) => {
    const key = scenarioKey(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  });
  return [...groups.values()].map((rows) => {
    const full = rows.find((row) => row.variant_id === "full-unified");
    const fresh = rows.find((row) => row.variant_id === "no-topology-version");
    if (!full || !fresh) throw new Error(`Incomplete paired scenario ${scenarioKey(rows[0])}`);
    const paired = {
      profile_id: full.profile_id,
      profile_label: full.profile_label,
      case_id: full.case_id,
      window_id: full.window_id,
      epoch_iso: full.epoch_iso,
      stress_rate: numberValue(full.stress_rate),
      achieved_stress_rate: numberValue(full.achieved_stress_rate),
      seed: full.seed,
      reuse_slices: numberValue(full.unified_reuse_slices),
      repair_slices: numberValue(full.unified_repair_slices),
      fresh_slices: numberValue(full.unified_fresh_slices),
      topology_action_slices: numberValue(full.unified_reuse_slices) + numberValue(full.unified_repair_slices),
      hard_budget_passed: numberValue(full.telemetry_byte_budget_cap_violations) === 0 &&
        numberValue(fresh.telemetry_byte_budget_cap_violations) === 0 &&
        numberValue(full.unified_hard_budget_violations) === 0 &&
        numberValue(fresh.unified_hard_budget_violations) === 0,
      strict_causal_passed: full.strict_causal_passed === true && fresh.strict_causal_passed === true,
      invalid_path_passed: numberValue(full.invalid_probe_path_ratio) === 0 && numberValue(fresh.invalid_probe_path_ratio) === 0,
      active_link_direct_coverage_delta: round(numberValue(full.active_link_direct_coverage) - numberValue(fresh.active_link_direct_coverage)),
      cpu_mae_regression_percent: relativeRegression(full.cpu_mae, fresh.cpu_mae),
      queue_depth_mae_regression_percent: relativeRegression(full.queue_depth_mae, fresh.queue_depth_mae),
      energy_percent_mae_regression_percent: relativeRegression(full.energy_percent_mae, fresh.energy_percent_mae),
      link_utilization_mae_regression_percent: relativeRegression(full.link_utilization_mae, fresh.link_utilization_mae),
    };
    for (const [sourceField, effectField] of Object.entries(LOWER_BETTER_EFFECTS)) {
      paired[effectField] = relativeReduction(full[sourceField], fresh[sourceField]);
    }
    paired.maximum_mae_regression_percent = round(Math.max(
      0,
      paired.cpu_mae_regression_percent,
      paired.queue_depth_mae_regression_percent,
      paired.energy_percent_mae_regression_percent,
      paired.link_utilization_mae_regression_percent,
    ));
    paired.telemetry_byte_increase_percent = round(Math.max(0, -paired.telemetry_byte_reduction_percent));
    paired.mechanism_triggered = paired.topology_action_slices > 0;
    paired.noninferiority_passed = paired.maximum_mae_regression_percent <= 1 + 1e-9 &&
      paired.telemetry_byte_increase_percent <= 1 + 1e-9 &&
      paired.hard_budget_passed && paired.strict_causal_passed && paired.invalid_path_passed;
    paired.deterministic_work_reduced = TOPOLOGY_REUSE_PRIMARY_EFFECTS.some((field) => numberValue(paired[field]) > 0);
    paired.case_supports_mechanism = paired.mechanism_triggered && paired.noninferiority_passed && paired.deterministic_work_reduced;
    return paired;
  }).sort((left, right) => left.profile_id.localeCompare(right.profile_id) || left.case_id.localeCompare(right.case_id));
}

const PAIRED_EFFECT_FIELDS = Object.freeze([
  ...Object.values(LOWER_BETTER_EFFECTS),
  "active_link_direct_coverage_delta",
  "cpu_mae_regression_percent",
  "queue_depth_mae_regression_percent",
  "energy_percent_mae_regression_percent",
  "link_utilization_mae_regression_percent",
  "maximum_mae_regression_percent",
]);

function groupRows(rows, fields) {
  const groups = new Map();
  rows.forEach((row) => {
    const key = fields.map((field) => String(row[field] ?? "")).join("|");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  });
  return groups;
}

export function aggregateTopologyReusePairedEffects(pairedRows = [], {
  groupFields = ["profile_id"],
  triggeredOnly = false,
} = {}) {
  const eligibleRows = triggeredOnly ? pairedRows.filter((row) => row.mechanism_triggered) : pairedRows;
  return [...groupRows(eligibleRows, groupFields).values()].flatMap((rows) => {
    const first = rows[0];
    return PAIRED_EFFECT_FIELDS.map((metric) => {
      const values = rows.map((row) => numberValue(row[metric]));
      const interval = confidenceSummary(values);
      const sign = pairedSignTest(values);
      return {
        ...Object.fromEntries(groupFields.map((field) => [field, first[field]])),
        scope: triggeredOnly ? "mechanism-triggered-preregistered-cases" : "all-preregistered-cases",
        metric,
        ...interval,
        sign_positive: sign.positive,
        sign_negative: sign.negative,
        sign_ties: sign.ties,
        sign_test_p_value: sign.p_value_two_sided,
      };
    });
  });
}

function dimensionCoverage(rows, field) {
  return [...new Set(rows.filter((row) => row.mechanism_triggered).map((row) => String(row[field])))].sort();
}

export function evaluateTopologyReuseEvidence(pairedRows = [], aggregateRows = []) {
  return [...groupRows(pairedRows, ["profile_id"]).values()].map((rows) => {
    const profileId = rows[0].profile_id;
    const overall = aggregateRows.filter((row) => row.profile_id === profileId && row.scope === "all-preregistered-cases");
    const marginal = overall.find((row) => row.metric === "marginal_evaluation_reduction_percent");
    const cache = overall.find((row) => row.metric === "score_cache_recomputation_reduction_percent");
    const triggerWindows = dimensionCoverage(rows, "window_id");
    const triggerStressRates = dimensionCoverage(rows, "stress_rate");
    const triggerSeeds = dimensionCoverage(rows, "seed");
    const allGatesPassed = rows.every((row) => row.noninferiority_passed);
    const deterministicCiPositive = numberValue(marginal?.ci95_low) > 0 || numberValue(cache?.ci95_low) > 0;
    const crossDimensionTrigger = triggerWindows.length >= 2 && triggerStressRates.length >= 2 && triggerSeeds.length >= 2;
    const supported = allGatesPassed && deterministicCiPositive && crossDimensionTrigger;
    const conditional = !supported && rows.some((row) => row.case_supports_mechanism);
    return {
      profile_id: profileId,
      preregistered_cases: rows.length,
      mechanism_triggered_cases: rows.filter((row) => row.mechanism_triggered).length,
      mechanism_supporting_cases: rows.filter((row) => row.case_supports_mechanism).length,
      noninferiority_pass_rate: round(rows.filter((row) => row.noninferiority_passed).length / Math.max(rows.length, 1)),
      trigger_windows: triggerWindows.join(" > "),
      trigger_stress_rates: triggerStressRates.join(" > "),
      trigger_seeds: triggerSeeds.join(" > "),
      deterministic_work_ci_positive: deterministicCiPositive,
      cross_dimension_triggered: crossDimensionTrigger,
      evidence_status: supported ? "supported" : conditional ? "conditional" : "not-supported",
      claim: supported
        ? "Cross-window, cross-pressure and multi-seed paired evidence supports deterministic planner-work reduction under the preregistered non-inferiority gates."
        : conditional
          ? "Some preregistered cases support local repair, but the cross-dimension statistical claim remains conditional."
          : "The preregistered evidence does not support a topology-reuse contribution claim for this profile.",
    };
  });
}

export { PAIRED_EFFECT_FIELDS };
