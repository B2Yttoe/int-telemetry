import { createHash } from "node:crypto";
import { DEFAULT_STRUCTURAL_CACHE_GUARDS } from "../../stage2-int/tools/topology-versioned-risk-planner.mjs";

export const DIRECTED_REUSE_STRATA = Object.freeze([
  Object.freeze({
    id: "high",
    label: "high-reuse-opportunity",
    minimum_jaccard: 0.98,
    maximum_jaccard: 1,
    maximum_affected_path_ratio: 0.1,
  }),
  Object.freeze({
    id: "medium",
    label: "local-repair-opportunity",
    minimum_jaccard: 0.94,
    maximum_jaccard: 0.98,
    maximum_affected_path_ratio: 1,
  }),
  Object.freeze({
    id: "boundary",
    label: "reuse-boundary",
    minimum_jaccard: 0.9,
    maximum_jaccard: 0.94,
    maximum_affected_path_ratio: 1,
  }),
]);

const DEFAULT_WORK_WEIGHTS = Object.freeze({
  candidate_inspections: 1,
  shortest_path_calls: 4,
  score_recomputations: 1,
  marginal_evaluations: 1,
  local_repairs: 2,
  graph_reconstructions: 2,
});

export const DIRECTED_REUSE_DEVELOPMENT_PAIR_KEYS = Object.freeze([
  "starlink-main-large|window-00-stress-00-seed-00|0|1|high",
]);

function numberValue(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value, digits = 6) {
  return Number.isFinite(Number(value)) ? Number(Number(value).toFixed(digits)) : 0;
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function splitPath(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  return String(value ?? "")
    .split(" > ")
    .map((item) => item.trim())
    .filter(Boolean);
}

function activeLink(row) {
  const value = row?.predicted_active ?? row?.is_active;
  return ["true", "1"].includes(String(value).toLowerCase());
}

function jaccard(left, right) {
  let intersection = 0;
  left.forEach((value) => {
    if (right.has(value)) intersection += 1;
  });
  const union = left.size + right.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

function symmetricDifference(left, right) {
  const changed = new Set();
  left.forEach((value) => {
    if (!right.has(value)) changed.add(value);
  });
  right.forEach((value) => {
    if (!left.has(value)) changed.add(value);
  });
  return changed;
}

function groupBySlice(rows, mapper) {
  const grouped = new Map();
  for (const row of rows ?? []) {
    const sliceIndex = numberValue(row.slice_index, NaN);
    if (!Number.isFinite(sliceIndex)) continue;
    if (!grouped.has(sliceIndex)) grouped.set(sliceIndex, []);
    const mapped = mapper(row);
    if (mapped !== null && mapped !== undefined) grouped.get(sliceIndex).push(mapped);
  }
  return grouped;
}

export function classifyReuseOpportunity(jaccardScore, affectedPathRatio, strata = DIRECTED_REUSE_STRATA) {
  const similarity = numberValue(jaccardScore, -1);
  const affected = numberValue(affectedPathRatio, 1);
  return strata.find((stratum) =>
    similarity >= stratum.minimum_jaccard &&
    similarity < stratum.maximum_jaccard + (stratum.maximum_jaccard === 1 ? 1e-12 : 0) &&
    affected <= stratum.maximum_affected_path_ratio + 1e-12
  )?.id ?? "outside";
}

export function scanDirectedReuseOpportunities({
  links = [],
  cachedProbePaths = [],
  cacheWindowSlices = 12,
  scenario = {},
  strata = DIRECTED_REUSE_STRATA,
} = {}) {
  const activeRowsBySlice = groupBySlice(links, (row) => activeLink(row) ? String(row.link_id ?? "") : null);
  const activeBySlice = new Map(
    [...activeRowsBySlice.entries()].map(([sliceIndex, linkIds]) => [sliceIndex, new Set(linkIds.filter(Boolean))]),
  );
  const pathsBySlice = groupBySlice(cachedProbePaths, (row) => ({
    probe_id: String(row.probe_id ?? ""),
    link_ids: splitPath(row.unified_observed_link_ids || row.link_ids),
  }));
  const slices = [...activeBySlice.keys()].sort((left, right) => left - right);
  const rows = [];

  for (let position = 0; position < slices.length; position += 1) {
    const currentSlice = slices[position];
    const currentActive = activeBySlice.get(currentSlice) ?? new Set();
    const history = slices.slice(Math.max(0, position - Math.max(1, cacheWindowSlices)), position);
    let best = null;
    for (const historicalSlice of history) {
      const historicalActive = activeBySlice.get(historicalSlice) ?? new Set();
      const changed = symmetricDifference(currentActive, historicalActive);
      const cachedPaths = pathsBySlice.get(historicalSlice) ?? [];
      const affectedPaths = cachedPaths.filter((path) => path.link_ids.some((linkId) => changed.has(linkId)));
      const inactivePaths = cachedPaths.filter((path) => path.link_ids.some((linkId) => !currentActive.has(linkId)));
      const similarity = jaccard(currentActive, historicalActive);
      const affectedRatio = affectedPaths.length / Math.max(cachedPaths.length, 1);
      const candidate = {
        historical_slice_index: historicalSlice,
        topology_jaccard: similarity,
        changed_link_count: changed.size,
        changed_link_ratio: changed.size / Math.max(currentActive.size, 1),
        cached_path_count: cachedPaths.length,
        affected_cached_path_count: affectedPaths.length,
        affected_cached_path_ratio: affectedRatio,
        inactive_cached_path_count: inactivePaths.length,
        valid_cached_path_ratio: (cachedPaths.length - inactivePaths.length) / Math.max(cachedPaths.length, 1),
      };
      if (
        !best ||
        candidate.topology_jaccard > best.topology_jaccard + 1e-12 ||
        (Math.abs(candidate.topology_jaccard - best.topology_jaccard) <= 1e-12 &&
          candidate.affected_cached_path_ratio < best.affected_cached_path_ratio - 1e-12) ||
        (Math.abs(candidate.topology_jaccard - best.topology_jaccard) <= 1e-12 &&
          Math.abs(candidate.affected_cached_path_ratio - best.affected_cached_path_ratio) <= 1e-12 &&
          historicalSlice > best.historical_slice_index)
      ) {
        best = candidate;
      }
    }

    const opportunityClass = best
      ? classifyReuseOpportunity(best.topology_jaccard, best.affected_cached_path_ratio, strata)
      : "no-history";
    rows.push({
      ...scenario,
      current_slice_index: currentSlice,
      active_link_count: currentActive.size,
      historical_slice_index: best?.historical_slice_index ?? "",
      topology_jaccard: round(best?.topology_jaccard ?? 0),
      changed_link_count: best?.changed_link_count ?? currentActive.size,
      changed_link_ratio: round(best?.changed_link_ratio ?? 1),
      cached_path_count: best?.cached_path_count ?? 0,
      affected_cached_path_count: best?.affected_cached_path_count ?? 0,
      affected_cached_path_ratio: round(best?.affected_cached_path_ratio ?? 1),
      inactive_cached_path_count: best?.inactive_cached_path_count ?? 0,
      valid_cached_path_ratio: round(best?.valid_cached_path_ratio ?? 0),
      opportunity_class: opportunityClass,
      eligible_for_directed_validation: strata.some((stratum) => stratum.id === opportunityClass),
    });
  }
  return rows;
}

function selectionRank(row, selectionSeed) {
  return createHash("sha256")
    .update([
      selectionSeed,
      row.profile_id,
      row.case_id,
      row.historical_slice_index,
      row.current_slice_index,
      row.opportunity_class,
    ].join("|"))
    .digest("hex");
}

export function selectDirectedValidationPairs(rows = [], {
  profileId = "starlink-main-large",
  perStratum = 2,
  maximumPerStratum = 4,
  selectionSeed = "experiment12b-directed-selection-v2",
  strata = DIRECTED_REUSE_STRATA,
  excludedPairKeys = DIRECTED_REUSE_DEVELOPMENT_PAIR_KEYS,
} = {}) {
  const exclusions = new Set(excludedPairKeys);
  const selected = [];
  const reserveByStratum = [];
  for (const stratum of strata) {
    const eligible = rows
      .filter((row) =>
        row.profile_id === profileId &&
        row.opportunity_class === stratum.id &&
        !exclusions.has([
          row.profile_id,
          row.case_id,
          row.historical_slice_index,
          row.current_slice_index,
          row.opportunity_class,
        ].join("|"))
      )
      .map((row) => ({ ...row, selection_rank: selectionRank(row, selectionSeed) }))
      .sort((left, right) => left.selection_rank.localeCompare(right.selection_rank));
    const diverse = [];
    const seenCases = new Set();
    for (const row of eligible) {
      if (seenCases.has(row.case_id)) continue;
      diverse.push(row);
      seenCases.add(row.case_id);
      if (diverse.length >= maximumPerStratum) break;
    }
    if (diverse.length < maximumPerStratum) {
      for (const row of eligible) {
        if (diverse.some((candidate) => candidate.selection_rank === row.selection_rank)) continue;
        diverse.push(row);
        if (diverse.length >= maximumPerStratum) break;
      }
    }
    selected.push(...diverse.slice(0, perStratum).map((row) => ({ ...row, selection_stage: "initial" })));
    reserveByStratum.push(diverse.slice(perStratum).map((row) => ({ ...row, selection_stage: "reserve" })));
  }
  const reserve = [];
  const reserveDepth = Math.max(0, ...reserveByStratum.map((rowsForStratum) => rowsForStratum.length));
  for (let index = 0; index < reserveDepth; index += 1) {
    reserveByStratum.forEach((rowsForStratum) => {
      if (rowsForStratum[index]) reserve.push(rowsForStratum[index]);
    });
  }
  return { selected, reserve };
}

export function buildDirectedReusePreregistration() {
  const design = {
    schema_version: "experiment12-directed-reuse-preregistration-v2",
    implementation_freeze: "causal-version-cache-guarded-local-repair-v2",
    experiment_parts: {
      natural_evidence: "12A-existing-18-paired-cases-no-rerun",
      directed_validation: "12B-starlink-similarity-stratified-planning-only-replay",
      medium_diagnosis: "12C-telesat-guarded-medium-similarity-scan-plus-three-planning-only-pairs",
    },
    source_boundary: "reuse existing Stage-1 truth, candidate paths, neutral pass-1 OAM, seeds and stress inputs",
    strata: DIRECTED_REUSE_STRATA,
    selection: {
      policy: "deterministic-hash-ranking-with-distinct-case-preference; planner outcomes are unavailable to selection",
      seed: "experiment12b-directed-selection-v2",
      excluded_development_pairs: DIRECTED_REUSE_DEVELOPMENT_PAIR_KEYS,
      initial_pairs_per_stratum: 2,
      initial_pair_count: 6,
      increment_pair_count: 3,
      maximum_pair_count: 12,
    },
    paired_variants: ["fresh-only", "reuse-enabled"],
    telesat_structural_cache_guards: DEFAULT_STRUCTURAL_CACHE_GUARDS,
    wall_clock_repetitions: 3,
    primary_metrics: [
      "candidate_inspections",
      "score_recomputations",
      "marginal_evaluations",
      "cache_hit_count",
      "invalidated_cache_entries",
    ],
    secondary_metrics: [
      "weighted_planning_work_units",
      "median_wall_time_ms",
      "local_repair_count",
      "fresh_fallback_count",
    ],
    work_weights: DEFAULT_WORK_WEIGHTS,
    quality_gates: {
      active_link_coverage_absolute_drop_maximum: 0.01,
      weighted_information_relative_drop_maximum: 0.02,
      mandatory_target_coverage_minimum: 1,
      delivered_report_ratio_absolute_drop_maximum: 0.01,
      reconstruction_mae_relative_increase_maximum: 0.02,
      telemetry_byte_relative_increase_maximum: 0.01,
      hard_budget_violations: 0,
    },
    early_stopping: {
      first_look_pairs: 6,
      add_pairs_per_look: 3,
      maximum_pairs: 12,
      stop_when: "paired-bootstrap-95%-lower-bound>0 AND mean-work-reduction>=5% AND all-available-quality-gates-pass",
      bootstrap_samples: 10000,
      bootstrap_seed: "experiment12b-bootstrap-v1",
    },
    inference_boundary: "12B is a mechanism validation conditional on preregistered topology-opportunity strata; 12A estimates natural trigger frequency",
    implementation_pilot_disclosure: "One high-opportunity pair was used to identify structural/dynamic cache coupling and an oversized fixed local-replacement budget. It is excluded from confirmatory selection and retained only as a development artifact.",
  };
  return {
    ...design,
    design_sha256: createHash("sha256").update(JSON.stringify(design)).digest("hex"),
  };
}

export function planningWorkUnits(metrics = {}, weights = DEFAULT_WORK_WEIGHTS) {
  const components = {
    candidate_inspections: numberValue(metrics.candidate_inspections),
    shortest_path_calls: numberValue(metrics.shortest_path_calls),
    score_recomputations: numberValue(metrics.score_recomputations),
    marginal_evaluations: numberValue(metrics.marginal_evaluations),
    local_repairs: numberValue(metrics.local_repairs),
    graph_reconstructions: numberValue(metrics.graph_reconstructions),
  };
  return round(Object.entries(components).reduce(
    (sum, [key, value]) => sum + value * numberValue(weights[key], 0),
    0,
  ));
}

function mulberry32(seed) {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let result = value;
    result = Math.imul(result ^ result >>> 15, result | 1);
    result ^= result + Math.imul(result ^ result >>> 7, result | 61);
    return ((result ^ result >>> 14) >>> 0) / 4294967296;
  };
}

function numericSeed(value) {
  return Number.parseInt(createHash("sha256").update(String(value)).digest("hex").slice(0, 8), 16);
}

function percentile(sorted, q) {
  if (sorted.length === 0) return 0;
  const position = Math.max(0, Math.min(1, q)) * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

export function pairedBootstrapMean(values = [], {
  samples = 10000,
  seed = "experiment12b-bootstrap-v1",
} = {}) {
  const finite = values.map(Number).filter(Number.isFinite);
  if (finite.length === 0) return { sample_count: 0, mean: 0, ci95_low: 0, ci95_high: 0 };
  const random = mulberry32(numericSeed(seed));
  const estimates = [];
  for (let sample = 0; sample < Math.max(1, Math.floor(samples)); sample += 1) {
    let total = 0;
    for (let index = 0; index < finite.length; index += 1) {
      total += finite[Math.floor(random() * finite.length)];
    }
    estimates.push(total / finite.length);
  }
  estimates.sort((left, right) => left - right);
  return {
    sample_count: finite.length,
    mean: round(mean(finite)),
    ci95_low: round(percentile(estimates, 0.025)),
    ci95_high: round(percentile(estimates, 0.975)),
  };
}

function relativeIncrease(reuseValue, freshValue) {
  const fresh = numberValue(freshValue);
  return (numberValue(reuseValue) - fresh) / Math.max(Math.abs(fresh), 1e-12);
}

function relativeDrop(reuseValue, freshValue) {
  const fresh = numberValue(freshValue);
  return (fresh - numberValue(reuseValue)) / Math.max(Math.abs(fresh), 1e-12);
}

export function evaluateDirectedQualityGates({ fresh = {}, reuse = {}, thresholds = {} } = {}) {
  const limits = {
    active_link_coverage_absolute_drop_maximum: 0.01,
    weighted_information_relative_drop_maximum: 0.02,
    mandatory_target_coverage_minimum: 1,
    delivered_report_ratio_absolute_drop_maximum: 0.01,
    reconstruction_mae_relative_increase_maximum: 0.02,
    telemetry_byte_relative_increase_maximum: 0.01,
    hard_budget_violations: 0,
    ...thresholds,
  };
  const checks = [];
  const add = (id, available, passed, detail) => checks.push({ id, available, passed: available ? Boolean(passed) : null, detail });
  const freshCoverage = numberValue(fresh.active_link_coverage, NaN);
  const reuseCoverage = numberValue(reuse.active_link_coverage, NaN);
  add(
    "active-link-coverage",
    Number.isFinite(freshCoverage) && Number.isFinite(reuseCoverage),
    reuseCoverage >= freshCoverage - limits.active_link_coverage_absolute_drop_maximum,
    { fresh: freshCoverage, reuse: reuseCoverage },
  );
  const freshInformation = numberValue(fresh.weighted_information, NaN);
  const reuseInformation = numberValue(reuse.weighted_information, NaN);
  add(
    "weighted-information",
    Number.isFinite(freshInformation) && Number.isFinite(reuseInformation),
    relativeDrop(reuseInformation, freshInformation) <= limits.weighted_information_relative_drop_maximum,
    {
      fresh: freshInformation,
      reuse: reuseInformation,
      relative_drop: round(relativeDrop(reuseInformation, freshInformation)),
    },
  );
  const mandatoryCoverage = numberValue(reuse.mandatory_target_coverage, NaN);
  add(
    "mandatory-target-coverage",
    Number.isFinite(mandatoryCoverage),
    mandatoryCoverage >= limits.mandatory_target_coverage_minimum,
    { reuse: mandatoryCoverage },
  );
  const freshDelivery = numberValue(fresh.delivered_report_ratio, NaN);
  const reuseDelivery = numberValue(reuse.delivered_report_ratio, NaN);
  add(
    "delivered-report-ratio",
    Number.isFinite(freshDelivery) && Number.isFinite(reuseDelivery),
    reuseDelivery >= freshDelivery - limits.delivered_report_ratio_absolute_drop_maximum,
    { fresh: freshDelivery, reuse: reuseDelivery },
  );
  const metricNames = ["cpu_mae", "queue_depth_mae", "energy_percent_mae", "link_utilization_mae"];
  for (const metric of metricNames) {
    const freshValue = numberValue(fresh[metric], NaN);
    const reuseValue = numberValue(reuse[metric], NaN);
    add(
      metric,
      Number.isFinite(freshValue) && Number.isFinite(reuseValue),
      relativeIncrease(reuseValue, freshValue) <= limits.reconstruction_mae_relative_increase_maximum,
      { fresh: freshValue, reuse: reuseValue, relative_increase: round(relativeIncrease(reuseValue, freshValue)) },
    );
  }
  const freshBytes = numberValue(fresh.telemetry_bytes, NaN);
  const reuseBytes = numberValue(reuse.telemetry_bytes, NaN);
  add(
    "telemetry-bytes",
    Number.isFinite(freshBytes) && Number.isFinite(reuseBytes),
    relativeIncrease(reuseBytes, freshBytes) <= limits.telemetry_byte_relative_increase_maximum,
    { fresh: freshBytes, reuse: reuseBytes, relative_increase: round(relativeIncrease(reuseBytes, freshBytes)) },
  );
  const violations = numberValue(reuse.hard_budget_violations, NaN);
  add(
    "hard-budget",
    Number.isFinite(violations),
    violations <= limits.hard_budget_violations,
    { reuse_violations: violations },
  );
  const availableChecks = checks.filter((check) => check.available);
  return {
    passed: availableChecks.length > 0 && availableChecks.every((check) => check.passed),
    available_check_count: availableChecks.length,
    unavailable_check_count: checks.length - availableChecks.length,
    checks,
  };
}

export const DIRECTED_REUSE_WORK_WEIGHTS = DEFAULT_WORK_WEIGHTS;
