const PLANNING_MODES = Object.freeze(["reuse", "repair", "fresh"]);
const MODE_TIE_BREAK_PRIORITY = Object.freeze({ reuse: 0, repair: 1, fresh: 2 });

export const DEFAULT_STRUCTURAL_CACHE_GUARDS = Object.freeze({
  minimum_similarity: 0.94,
  maximum_changed_link_ratio: 0.08,
  maximum_affected_path_ratio: 0.15,
  minimum_valid_path_ratio: 0.85,
});

export const DEFAULT_ADAPTIVE_STRUCTURAL_CACHE_POLICY = Object.freeze({
  enabled: false,
  relative_error_tolerance: 0,
  full_relaxation_error_tolerance: 0.02,
  minimum_similarity_floor: 0.9,
  maximum_changed_link_ratio_ceiling: 0.12,
  maximum_affected_path_ratio_ceiling: 0.25,
  minimum_valid_path_ratio_floor: 0.75,
});

function finiteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, minimum = 0, maximum = 1) {
  return Math.min(maximum, Math.max(minimum, finiteNumber(value)));
}

function normalizedStructuralCacheGuards(guards = DEFAULT_STRUCTURAL_CACHE_GUARDS) {
  return {
    minimum_similarity: clamp(guards?.minimum_similarity ?? DEFAULT_STRUCTURAL_CACHE_GUARDS.minimum_similarity),
    maximum_changed_link_ratio: clamp(guards?.maximum_changed_link_ratio ?? DEFAULT_STRUCTURAL_CACHE_GUARDS.maximum_changed_link_ratio),
    maximum_affected_path_ratio: clamp(guards?.maximum_affected_path_ratio ?? DEFAULT_STRUCTURAL_CACHE_GUARDS.maximum_affected_path_ratio),
    minimum_valid_path_ratio: clamp(guards?.minimum_valid_path_ratio ?? DEFAULT_STRUCTURAL_CACHE_GUARDS.minimum_valid_path_ratio),
  };
}

export function deriveAdaptiveStructuralCacheGuards({
  baseGuards = DEFAULT_STRUCTURAL_CACHE_GUARDS,
  policy = DEFAULT_ADAPTIVE_STRUCTURAL_CACHE_POLICY,
  cacheAgeSlices = 0,
  cacheWindowSlices = 12,
  forecastDriftPressure = 0,
  oamPressure = 0,
  reuseConfidence = 0.5,
  planningOverheadPressure = 0.5,
  recommendedPlanMode = "",
} = {}) {
  const base = normalizedStructuralCacheGuards(baseGuards);
  const enabled = Boolean(policy?.enabled);
  const relativeErrorTolerance = enabled
    ? clamp(policy?.relative_error_tolerance, 0, 0.1)
    : 0;
  const fullRelaxationTolerance = clamp(
    policy?.full_relaxation_error_tolerance ?? DEFAULT_ADAPTIVE_STRUCTURAL_CACHE_POLICY.full_relaxation_error_tolerance,
    0.001,
    0.1,
  );
  const similarityFloor = clamp(
    policy?.minimum_similarity_floor ?? DEFAULT_ADAPTIVE_STRUCTURAL_CACHE_POLICY.minimum_similarity_floor,
    0.72,
    base.minimum_similarity,
  );
  const changedCeiling = clamp(
    policy?.maximum_changed_link_ratio_ceiling ?? DEFAULT_ADAPTIVE_STRUCTURAL_CACHE_POLICY.maximum_changed_link_ratio_ceiling,
    base.maximum_changed_link_ratio,
    0.5,
  );
  const affectedCeiling = clamp(
    policy?.maximum_affected_path_ratio_ceiling ?? DEFAULT_ADAPTIVE_STRUCTURAL_CACHE_POLICY.maximum_affected_path_ratio_ceiling,
    base.maximum_affected_path_ratio,
    0.75,
  );
  const validFloor = clamp(
    policy?.minimum_valid_path_ratio_floor ?? DEFAULT_ADAPTIVE_STRUCTURAL_CACHE_POLICY.minimum_valid_path_ratio_floor,
    0.5,
    base.minimum_valid_path_ratio,
  );
  const agePressure = clamp(
    finiteNumber(cacheAgeSlices) / Math.max(1, finiteNumber(cacheWindowSlices, 12)),
  );
  const confidence = clamp(reuseConfidence);
  const drift = clamp(forecastDriftPressure);
  const oam = clamp(oamPressure);
  const overhead = clamp(planningOverheadPressure);
  const recommendationPressure = /fresh|replan/i.test(String(recommendedPlanMode ?? "")) ? 1 : 0;
  const riskPressure = clamp(
    drift * 0.32 +
      oam * 0.25 +
      (1 - confidence) * 0.18 +
      agePressure * 0.15 +
      recommendationPressure * 0.1,
  );
  const toleranceScale = enabled ? clamp(relativeErrorTolerance / fullRelaxationTolerance) : 0;
  const availableRelaxation = clamp(
    0.55 + overhead * 0.25 + confidence * 0.2 - riskPressure * 0.75,
  );
  const relaxationFactor = clamp(toleranceScale * availableRelaxation);
  const interpolate = (conservative, permissive) =>
    conservative + (permissive - conservative) * relaxationFactor;
  const effectiveGuards = {
    minimum_similarity: round(interpolate(base.minimum_similarity, similarityFloor)),
    maximum_changed_link_ratio: round(interpolate(base.maximum_changed_link_ratio, changedCeiling)),
    maximum_affected_path_ratio: round(interpolate(base.maximum_affected_path_ratio, affectedCeiling)),
    minimum_valid_path_ratio: round(interpolate(base.minimum_valid_path_ratio, validFloor)),
  };
  const reasons = enabled
    ? [
        relativeErrorTolerance > 0 ? "relax-error-tolerance" : "zero-error-tolerance",
        overhead >= 0.5 ? "relax-planning-pressure" : "",
        confidence >= 0.75 ? "relax-reuse-confidence" : "",
        drift >= 0.35 ? "reserve-forecast-drift" : "",
        oam >= 0.35 ? "reserve-oam-pressure" : "",
        agePressure >= 0.5 ? "reserve-cache-age" : "",
        recommendationPressure > 0 ? "reserve-fresh-recommendation" : "",
      ].filter(Boolean)
    : ["adaptive-structural-reuse-disabled"];
  return {
    enabled,
    base_guards: base,
    effective_guards: effectiveGuards,
    relative_error_tolerance: round(relativeErrorTolerance),
    full_relaxation_error_tolerance: round(fullRelaxationTolerance),
    tolerance_scale: round(toleranceScale),
    relaxation_factor: round(relaxationFactor),
    risk_pressure: round(riskPressure),
    age_pressure: round(agePressure),
    forecast_drift_pressure: round(drift),
    oam_pressure: round(oam),
    reuse_confidence: round(confidence),
    planning_overhead_pressure: round(overhead),
    policy: enabled
      ? "error-budgeted-causal-adaptive-structural-guard"
      : "fixed-conservative-structural-guard",
    reason: reasons.join(" > "),
  };
}

function round(value, digits = 6) {
  const factor = 10 ** digits;
  return Math.round((finiteNumber(value) + Number.EPSILON) * factor) / factor;
}

function uniqueSorted(values) {
  return [...new Set((values ?? []).map((value) => String(value)).filter(Boolean))].sort();
}

function normalizedMode(value) {
  const mode = String(value ?? "fresh").toLowerCase();
  if (!PLANNING_MODES.includes(mode)) throw new Error(`Unsupported planning mode: ${value}`);
  return mode;
}

function objectKey(observation) {
  return `${String(observation?.type ?? "object")}:${String(observation?.id ?? "")}`;
}

function normalizedObservation(observation) {
  const id = String(observation?.id ?? "");
  if (!id) return null;
  return {
    id,
    type: String(observation?.type ?? "object"),
    uncertainty: clamp(observation?.uncertainty),
    risk: clamp(observation?.risk),
    metadata_quality: clamp(observation?.metadata_quality, 0, 1),
    similarity_group: String(observation?.similarity_group ?? ""),
  };
}

function normalizedAction(action, index) {
  const telemetryBytes = finiteNumber(action?.telemetry_bytes, NaN);
  if (!Number.isFinite(telemetryBytes) || telemetryBytes <= 0) {
    throw new Error(`Action ${action?.id ?? index} must have positive telemetry_bytes`);
  }
  return {
    ...action,
    id: String(action?.id ?? `action-${index}`),
    planning_mode: normalizedMode(action?.planning_mode),
    telemetry_bytes: telemetryBytes,
    planning_cost: Math.max(0, finiteNumber(action?.planning_cost)),
    exclusion_group: String(action?.exclusion_group ?? action?.id ?? `action-${index}`),
    observations: (action?.observations ?? []).map(normalizedObservation).filter(Boolean),
    __input_index: index,
  };
}

function normalizedLinkIds(path) {
  const value = path?.link_ids ?? path?.pathLinks ?? [];
  if (Array.isArray(value)) return uniqueSorted(value);
  return uniqueSorted(String(value ?? "").split(" > ").map((item) => item.trim()).filter(Boolean));
}

export function assessCachedPathImpact({
  cachedPaths = [],
  currentActiveLinkIds = [],
  changedLinkIds = [],
} = {}) {
  const active = new Set((currentActiveLinkIds ?? []).map(String));
  const changed = new Set((changedLinkIds ?? []).map(String));
  let affected = 0;
  let inactive = 0;
  let retained = 0;
  for (const path of cachedPaths ?? []) {
    const linkIds = normalizedLinkIds(path);
    const pathAffected = linkIds.some((linkId) => changed.has(linkId));
    const pathInactive = linkIds.some((linkId) => !active.has(linkId));
    if (pathAffected) affected += 1;
    if (pathInactive) inactive += 1;
    if (!pathAffected && !pathInactive) retained += 1;
  }
  const pathCount = cachedPaths.length;
  return {
    cached_path_count: pathCount,
    affected_cached_path_count: affected,
    affected_cached_path_ratio: round(affected / Math.max(pathCount, 1)),
    inactive_cached_path_count: inactive,
    inactive_cached_path_ratio: round(inactive / Math.max(pathCount, 1)),
    retained_cached_path_count: retained,
    retained_cached_path_ratio: round(retained / Math.max(pathCount, 1)),
  };
}

function setJaccard(left, right) {
  if (left.size === 0 && right.size === 0) return 1;
  let intersection = 0;
  for (const value of left) {
    if (right.has(value)) intersection += 1;
  }
  return intersection / Math.max(left.size + right.size - intersection, 1);
}

function structuralCacheGuardReasons({
  exactVersion,
  similarity,
  changedLinkRatio,
  affectedPathRatio,
  validPathRatio,
  estimatedRelativeErrorIncrease,
  relativeErrorTolerance,
  guards,
}) {
  if (exactVersion) return [];
  return [
    similarity < guards.minimum_similarity ? "structural-similarity-below-guard" : "",
    changedLinkRatio > guards.maximum_changed_link_ratio ? "changed-link-ratio-above-structural-guard" : "",
    affectedPathRatio > guards.maximum_affected_path_ratio ? "cached-path-impact-above-structural-guard" : "",
    validPathRatio < guards.minimum_valid_path_ratio ? "cached-path-validity-below-structural-guard" : "",
    estimatedRelativeErrorIncrease > relativeErrorTolerance + 1e-12
      ? "estimated-error-increase-above-tolerance"
      : "",
  ].filter(Boolean);
}

function normalizedDebt(value, conservative, permissive, direction = "increase") {
  const span = Math.max(Math.abs(permissive - conservative), 1e-12);
  const debt = direction === "decrease"
    ? (conservative - value) / span
    : (value - conservative) / span;
  return clamp(debt);
}

export function assessAdaptiveStructuralCacheCandidate({
  exactVersion = false,
  similarity = 0,
  changedLinkRatio = 1,
  affectedPathRatio = 1,
  validPathRatio = 0,
  baseGuards = DEFAULT_STRUCTURAL_CACHE_GUARDS,
  adaptivePolicy = DEFAULT_ADAPTIVE_STRUCTURAL_CACHE_POLICY,
  cacheAgeSlices = 0,
  cacheWindowSlices = 12,
  forecastDriftPressure = 0,
  oamPressure = 0,
  reuseConfidence = 0.5,
  planningOverheadPressure = 0.5,
  recommendedPlanMode = "",
} = {}) {
  const adaptation = deriveAdaptiveStructuralCacheGuards({
    baseGuards,
    policy: adaptivePolicy,
    cacheAgeSlices,
    cacheWindowSlices,
    forecastDriftPressure,
    oamPressure,
    reuseConfidence,
    planningOverheadPressure,
    recommendedPlanMode,
  });
  const base = adaptation.base_guards;
  const effective = adaptation.effective_guards;
  const similarityDebt = normalizedDebt(
    clamp(similarity),
    base.minimum_similarity,
    effective.minimum_similarity,
    "decrease",
  );
  const changedDebt = normalizedDebt(
    clamp(changedLinkRatio),
    base.maximum_changed_link_ratio,
    effective.maximum_changed_link_ratio,
  );
  const affectedDebt = normalizedDebt(
    clamp(affectedPathRatio),
    base.maximum_affected_path_ratio,
    effective.maximum_affected_path_ratio,
  );
  const validityDebt = normalizedDebt(
    clamp(validPathRatio),
    base.minimum_valid_path_ratio,
    effective.minimum_valid_path_ratio,
    "decrease",
  );
  const structuralDebt = clamp(
    similarityDebt * 0.35 +
      changedDebt * 0.2 +
      affectedDebt * 0.25 +
      validityDebt * 0.2,
  );
  const estimatedRelativeErrorIncrease = adaptation.enabled
    ? adaptation.relative_error_tolerance * structuralDebt * (0.5 + adaptation.risk_pressure * 0.5)
    : 0;
  const guardReasons = structuralCacheGuardReasons({
    exactVersion,
    similarity: clamp(similarity),
    changedLinkRatio: clamp(changedLinkRatio),
    affectedPathRatio: clamp(affectedPathRatio),
    validPathRatio: clamp(validPathRatio),
    estimatedRelativeErrorIncrease,
    relativeErrorTolerance: adaptation.relative_error_tolerance,
    guards: effective,
  });
  return {
    ...adaptation,
    exact_version_match: Boolean(exactVersion),
    eligible: Boolean(exactVersion || guardReasons.length === 0),
    estimated_relative_error_increase_proxy: round(estimatedRelativeErrorIncrease),
    error_tolerance_utilization: adaptation.relative_error_tolerance > 0
      ? round(estimatedRelativeErrorIncrease / adaptation.relative_error_tolerance)
      : 0,
    structural_debt: round(structuralDebt),
    similarity_debt: round(similarityDebt),
    changed_link_debt: round(changedDebt),
    affected_path_debt: round(affectedDebt),
    valid_path_debt: round(validityDebt),
    rejection_reasons: guardReasons,
  };
}

export function selectStructuralCacheBase({
  entries = [],
  currentActiveLinkIds = [],
  currentTopologySignature = "",
  currentSliceIndex = null,
  cacheWindowSlices = 12,
  guards = DEFAULT_STRUCTURAL_CACHE_GUARDS,
  adaptivePolicy = DEFAULT_ADAPTIVE_STRUCTURAL_CACHE_POLICY,
  forecastDriftPressure = 0,
  oamPressure = 0,
  reuseConfidence = 0.5,
  planningOverheadPressure = 0.5,
  recommendedPlanMode = "",
} = {}) {
  const currentActive = new Set((currentActiveLinkIds ?? []).map(String));
  const currentSlice = Number(currentSliceIndex);
  const window = Math.max(1, Math.floor(finiteNumber(cacheWindowSlices, 12)));
  const normalizedGuards = normalizedStructuralCacheGuards(guards);
  const candidates = [];

  for (const entry of entries ?? []) {
    const entrySlice = Number(entry?.slice_index);
    if (!Number.isFinite(entrySlice) || !Number.isFinite(currentSlice) || entrySlice >= currentSlice) continue;
    const age = currentSlice - entrySlice;
    if (age > window) continue;
    const paths = Array.isArray(entry?.paths) ? entry.paths : [];
    if (paths.length === 0) continue;

    const cachedActive = new Set((entry?.active_link_ids ?? []).map(String));
    const added = [...currentActive].filter((linkId) => !cachedActive.has(linkId));
    const removed = [...cachedActive].filter((linkId) => !currentActive.has(linkId));
    const changed = [...added, ...removed];
    const similarity = setJaccard(currentActive, cachedActive);
    const changedLinkRatio = changed.length / Math.max(currentActive.size, 1);
    const impact = assessCachedPathImpact({
      cachedPaths: paths,
      currentActiveLinkIds: [...currentActive],
      changedLinkIds: changed,
    });
    const validPathRatio = 1 - impact.inactive_cached_path_ratio;
    const exactVersion = Boolean(
      currentTopologySignature && entry?.topology_signature &&
        String(currentTopologySignature) === String(entry.topology_signature)
    );
    const adaptiveAssessment = assessAdaptiveStructuralCacheCandidate({
      exactVersion,
      similarity,
      changedLinkRatio,
      affectedPathRatio: impact.affected_cached_path_ratio,
      validPathRatio,
      baseGuards: normalizedGuards,
      adaptivePolicy,
      cacheAgeSlices: age,
      cacheWindowSlices: window,
      forecastDriftPressure,
      oamPressure,
      reuseConfidence,
      planningOverheadPressure,
      recommendedPlanMode,
    });
    const guardReasons = adaptiveAssessment.rejection_reasons;
    const eligible = adaptiveAssessment.eligible;
    const retainedShare = impact.retained_cached_path_ratio;
    const utility = similarity * 0.55 + retainedShare * 0.4 -
      (age / window) * 0.05 - adaptiveAssessment.error_tolerance_utilization * 0.05;
    candidates.push({
      entry,
      slice_index: entrySlice,
      age_slices: age,
      exact_version_match: exactVersion,
      topology_similarity_score: round(similarity),
      changed_link_ids: uniqueSorted(changed),
      added_link_ids: uniqueSorted(added),
      removed_link_ids: uniqueSorted(removed),
      changed_link_ratio: round(changedLinkRatio),
      cached_path_affected_ratio: impact.affected_cached_path_ratio,
      cached_path_valid_ratio: round(validPathRatio),
      cached_path_retained_ratio: impact.retained_cached_path_ratio,
      impact,
      adaptive_assessment: adaptiveAssessment,
      effective_guards: adaptiveAssessment.effective_guards,
      estimated_relative_error_increase_proxy: adaptiveAssessment.estimated_relative_error_increase_proxy,
      error_tolerance_utilization: adaptiveAssessment.error_tolerance_utilization,
      eligible,
      rejection_reasons: guardReasons,
      utility: round(utility),
    });
  }

  candidates.sort((left, right) =>
    Number(right.eligible) - Number(left.eligible) ||
    Number(right.exact_version_match) - Number(left.exact_version_match) ||
    right.utility - left.utility ||
    right.topology_similarity_score - left.topology_similarity_score ||
    right.slice_index - left.slice_index
  );
  const selected = candidates[0] ?? null;
  return {
    cache_available: candidates.length > 0,
    eligible: Boolean(selected?.eligible),
    selected,
    candidate_count: candidates.length,
    guards: selected?.effective_guards ?? normalizedGuards,
    adaptive_assessment: selected?.adaptive_assessment ?? deriveAdaptiveStructuralCacheGuards({
      baseGuards: normalizedGuards,
      policy: adaptivePolicy,
      cacheWindowSlices: window,
      forecastDriftPressure,
      oamPressure,
      reuseConfidence,
      planningOverheadPressure,
      recommendedPlanMode,
    }),
    rejection_reasons: selected?.rejection_reasons ?? ["no-causal-structural-cache-entry"],
  };
}

export function buildTopologyVersion({
  topologyClassId = "unclassified",
  topologySignature = "no-signature",
  addedLinkIds = [],
  removedLinkIds = [],
  nextChangeInSlices = null,
} = {}) {
  const added = uniqueSorted(addedLinkIds);
  const removed = uniqueSorted(removedLinkIds);
  const nextChange = Number.isFinite(Number(nextChangeInSlices))
    ? Math.max(0, Math.floor(Number(nextChangeInSlices)))
    : null;
  const classId = String(topologyClassId || "unclassified");
  const edgeHash = String(topologySignature || "no-signature");
  return {
    class_id: classId,
    active_edge_hash: edgeHash,
    added_link_ids: added,
    removed_link_ids: removed,
    changed_link_count: added.length + removed.length,
    next_change_in_slices: nextChange,
    version_id: `${classId}:${edgeHash}:+${added.length}:-${removed.length}:t${nextChange ?? "unknown"}`,
  };
}

export function prefilterTopologyPlanningModes({
  allowedModes = PLANNING_MODES,
  cacheAvailable = false,
  currentTopologySignature = "",
  cachedTopologySignature = "",
  addedLinkCount = 0,
  removedLinkCount = 0,
  activeLinkCount = 0,
  reuseConfidence = 0,
  driftPressure = 1,
  recommendedPlanMode = "",
  oamReplanRequired = false,
  topologySimilarityScore = null,
  adaptiveReuseThreshold = null,
  cachedPathAffectedRatio = null,
  cachedPathValidRatio = null,
  structuralCacheGuards = DEFAULT_STRUCTURAL_CACHE_GUARDS,
  structuralEstimatedErrorIncrease = 0,
  structuralRelativeErrorTolerance = 0,
} = {}) {
  const allowed = PLANNING_MODES.filter((mode) =>
    new Set((allowedModes ?? []).map((value) => String(value).toLowerCase())).has(mode)
  );
  if (allowed.length === 0) throw new Error("At least one topology planning mode is required");
  const fallbackFresh = allowed.includes("fresh") ? ["fresh"] : [allowed[0]];
  const changedLinkCount = Math.max(0, finiteNumber(addedLinkCount)) + Math.max(0, finiteNumber(removedLinkCount));
  const changedLinkRatio = changedLinkCount / Math.max(1, finiteNumber(activeLinkCount, 1));
  const confidence = clamp(reuseConfidence);
  const drift = clamp(driftPressure);
  const exactVersion = Boolean(
    cacheAvailable && currentTopologySignature && cachedTopologySignature &&
      String(currentTopologySignature) === String(cachedTopologySignature)
  );
  const recommended = String(recommendedPlanMode ?? "").toLowerCase();
  const similarity = Number.isFinite(Number(topologySimilarityScore))
    ? clamp(topologySimilarityScore)
    : null;
  const similarityThreshold = Number.isFinite(Number(adaptiveReuseThreshold))
    ? clamp(adaptiveReuseThreshold)
    : null;
  const affectedPathRatio = Number.isFinite(Number(cachedPathAffectedRatio))
    ? clamp(cachedPathAffectedRatio)
    : null;
  const validPathRatio = Number.isFinite(Number(cachedPathValidRatio))
    ? clamp(cachedPathValidRatio)
    : null;
  const effectiveStructuralGuards = normalizedStructuralCacheGuards(structuralCacheGuards);
  const estimatedErrorIncrease = Math.max(0, finiteNumber(structuralEstimatedErrorIncrease));
  const relativeErrorTolerance = clamp(structuralRelativeErrorTolerance, 0, 0.1);
  const structuralRepairEligible = Boolean(
    cacheAvailable && !exactVersion && allowed.includes("repair") &&
      similarity !== null && similarity >= effectiveStructuralGuards.minimum_similarity &&
      changedLinkRatio <= effectiveStructuralGuards.maximum_changed_link_ratio &&
      affectedPathRatio !== null && affectedPathRatio <= effectiveStructuralGuards.maximum_affected_path_ratio &&
      validPathRatio !== null && validPathRatio >= effectiveStructuralGuards.minimum_valid_path_ratio &&
      estimatedErrorIncrease <= relativeErrorTolerance + 1e-12
  );
  const rejectionReasons = () => {
    const reasons = [];
    if (!cacheAvailable) reasons.push("topology-class-cache-miss");
    if (oamReplanRequired) reasons.push("ground-oam-global-replan-request");
    if (similarity !== null && similarityThreshold !== null && similarity < similarityThreshold) {
      reasons.push("topology-similarity-below-adaptive-threshold");
    }
    if (!exactVersion && changedLinkRatio > 0.08) reasons.push("changed-link-ratio-above-local-repair-limit");
    if (!exactVersion && confidence < 0.9) reasons.push("reuse-confidence-below-local-repair-floor");
    if (!exactVersion && drift > 0.08) reasons.push("forecast-drift-above-local-repair-ceiling");
    if (recommended.includes("fresh") || recommended.includes("replan")) reasons.push("forecast-recommends-fresh-plan");
    if (!allowed.includes("repair") && !exactVersion) reasons.push("repair-mode-disabled");
    if (affectedPathRatio !== null && affectedPathRatio > 0.35) reasons.push("cached-path-impact-too-high");
    if (validPathRatio !== null && validPathRatio < 0.9) reasons.push("cached-path-validity-too-low");
    if (estimatedErrorIncrease > relativeErrorTolerance + 1e-12) {
      reasons.push("estimated-error-increase-above-tolerance");
    }
    return uniqueSorted(reasons);
  };
  const result = (selectedModes, policy, reason, rejected = []) => ({
    selected_modes: selectedModes.filter((mode) => allowed.includes(mode)),
    policy,
    reason,
    exact_version_match: exactVersion,
    changed_link_count: Math.round(changedLinkCount),
    changed_link_ratio: round(changedLinkRatio),
    reuse_confidence: round(confidence),
    drift_pressure: round(drift),
    oam_replan_required: Boolean(oamReplanRequired),
    topology_similarity_score: similarity === null ? "" : round(similarity),
    adaptive_reuse_threshold: similarityThreshold === null ? "" : round(similarityThreshold),
    cached_path_affected_ratio: affectedPathRatio === null ? "" : round(affectedPathRatio),
    cached_path_valid_ratio: validPathRatio === null ? "" : round(validPathRatio),
    structural_minimum_similarity: effectiveStructuralGuards.minimum_similarity,
    structural_maximum_changed_link_ratio: effectiveStructuralGuards.maximum_changed_link_ratio,
    structural_maximum_affected_path_ratio: effectiveStructuralGuards.maximum_affected_path_ratio,
    structural_minimum_valid_path_ratio: effectiveStructuralGuards.minimum_valid_path_ratio,
    structural_estimated_relative_error_increase_proxy: round(estimatedErrorIncrease),
    structural_relative_error_tolerance: round(relativeErrorTolerance),
    structural_cache_repair_eligible: structuralRepairEligible,
    rejection_reasons: uniqueSorted(rejected),
  });

  if (!cacheAvailable) {
    return result(fallbackFresh, "fresh-no-cache", "no-compatible-topology-plan-cache", rejectionReasons());
  }
  if (oamReplanRequired) {
    return result(fallbackFresh, "fresh-oam-replan", "ground-oam-requested-global-replan", rejectionReasons());
  }
  if (exactVersion && allowed.includes("reuse")) {
    return result(["reuse"], "reuse-exact-version", "active-edge-signature-exactly-matches-cache");
  }

  if (structuralRepairEligible) {
    return result(
      ["repair"],
      "repair-guarded-structural-cache",
      "causal-cache-retains-enough-valid-paths-under-structural-guard",
    );
  }

  const highConfidenceLocalDelta = allowed.includes("repair") &&
    changedLinkRatio <= 0.08 && confidence >= 0.9 && drift <= 0.08 &&
    !recommended.includes("fresh");
  if (highConfidenceLocalDelta) {
    return result(
      ["repair"],
      "repair-high-confidence-local-delta",
      "small-predicted-edge-delta-with-high-reuse-confidence",
    );
  }

  const ambiguousLocalDelta = allowed.includes("repair") && allowed.includes("fresh") &&
    changedLinkRatio <= 0.25 && confidence >= 0.55 && drift <= 0.3;
  if (ambiguousLocalDelta) {
    return result(
      ["fresh"],
      "fresh-ambiguous-version",
      "topology-version-is-not-confident-enough-for-cache-only-planning",
      rejectionReasons(),
    );
  }

  return result(
    fallbackFresh,
    "fresh-material-topology-drift",
    "cache-version-is-not-a-safe-local-repair-base",
    rejectionReasons(),
  );
}

export function selectIncrementalRepairCandidates({
  cachedCandidateIds = [],
  currentCandidates = [],
  changedLinkIds = [],
  mandatoryLinkIds = [],
  mandatoryNodeIds = [],
  maximumPathLinks = 8,
  maximumDeltaCandidates = Infinity,
} = {}) {
  const cached = new Set((cachedCandidateIds ?? []).map(String));
  const changedLinks = new Set((changedLinkIds ?? []).map(String));
  const mandatoryLinks = new Set((mandatoryLinkIds ?? []).map(String));
  const mandatoryNodes = new Set((mandatoryNodeIds ?? []).map(String));
  const linkLimit = Math.max(1, Math.floor(finiteNumber(maximumPathLinks, 8)));
  const candidateLimit = Number.isFinite(Number(maximumDeltaCandidates))
    ? Math.max(0, Math.floor(Number(maximumDeltaCandidates)))
    : Infinity;
  const seen = new Set();
  const ranked = [];
  for (const candidate of currentCandidates ?? []) {
    const id = String(candidate?.id ?? "");
    if (!id || cached.has(id) || seen.has(id)) continue;
    seen.add(id);
    const links = uniqueSorted(candidate?.link_ids ?? []);
    const nodes = uniqueSorted(candidate?.node_ids ?? []);
    if (links.length > linkLimit) continue;
    const mandatoryHits = links.filter((linkId) => mandatoryLinks.has(linkId)).length +
      nodes.filter((nodeId) => mandatoryNodes.has(nodeId)).length;
    const changedHits = links.filter((linkId) => changedLinks.has(linkId)).length;
    if (mandatoryHits === 0 && changedHits === 0) continue;
    ranked.push({ candidate, id, links, mandatoryHits, changedHits });
  }
  ranked.sort((left, right) =>
    right.mandatoryHits - left.mandatoryHits ||
    right.changedHits - left.changedHits ||
    left.links.length - right.links.length ||
    left.id.localeCompare(right.id)
  );
  return ranked.slice(0, candidateLimit).map((entry) => entry.candidate);
}

export function replaceCandidatesWithinFixedBudget({
  baseCandidates = [],
  replacementCandidates = [],
} = {}) {
  const capacity = baseCandidates.length;
  if (capacity === 0) return [];
  const baseIds = new Set(baseCandidates.map((candidate, index) => String(candidate?.id ?? `base-${index}`)));
  const seenReplacementIds = new Set();
  const replacements = [];
  for (let index = 0; index < replacementCandidates.length; index += 1) {
    const candidate = replacementCandidates[index];
    const id = String(candidate?.id ?? `replacement-${index}`);
    if (baseIds.has(id) || seenReplacementIds.has(id)) continue;
    seenReplacementIds.add(id);
    replacements.push(candidate);
    if (replacements.length >= capacity) break;
  }
  const retainedCount = Math.max(0, capacity - replacements.length);
  return [...baseCandidates.slice(0, retainedCount), ...replacements];
}

export function refillCandidatesToFixedBudget({
  selectedCandidates = [],
  fallbackCandidates = [],
  candidateBudget = 0,
} = {}) {
  const capacity = Math.max(0, Math.floor(finiteNumber(candidateBudget)));
  if (capacity === 0) return [];
  const selected = selectedCandidates.slice(0, capacity);
  const selectedIds = new Set(selected.map((candidate, index) => String(candidate?.id ?? `selected-${index}`)));
  const coveredNodes = new Set(selected.flatMap((candidate) => uniqueSorted(candidate?.node_ids ?? [])));
  const coveredLinks = new Set(selected.flatMap((candidate) => uniqueSorted(candidate?.link_ids ?? [])));
  const pending = fallbackCandidates
    .map((candidate, index) => ({
      candidate,
      id: String(candidate?.id ?? `fallback-${index}`),
      nodeIds: uniqueSorted(candidate?.node_ids ?? []),
      linkIds: uniqueSorted(candidate?.link_ids ?? []),
      inputIndex: index,
    }))
    .filter((entry) => !selectedIds.has(entry.id));
  const admit = (entry) => {
    if (selected.length >= capacity || selectedIds.has(entry.id)) return false;
    selected.push(entry.candidate);
    selectedIds.add(entry.id);
    entry.nodeIds.forEach((nodeId) => coveredNodes.add(nodeId));
    entry.linkIds.forEach((linkId) => coveredLinks.add(linkId));
    return true;
  };
  for (const entry of pending) {
    if (selected.length >= capacity) break;
    if (entry.nodeIds.some((nodeId) => !coveredNodes.has(nodeId))) admit(entry);
  }
  for (const entry of pending) {
    if (selected.length >= capacity) break;
    if (entry.linkIds.some((linkId) => !coveredLinks.has(linkId))) admit(entry);
  }
  for (const entry of pending) {
    if (selected.length >= capacity) break;
    admit(entry);
  }
  return selected;
}

export function evaluateMarginalActionValue({
  action,
  observedObjectKeys = new Set(),
  observedSimilarityGroups = new Set(),
  riskWeight = 0.35,
  redundancyWeight = 0.3,
} = {}) {
  const normalized = normalizedAction(action, finiteNumber(action?.__input_index));
  let informationGain = 0;
  let riskGain = 0;
  let redundancyPenalty = 0;
  const newObjectKeys = [];
  const newSimilarityGroups = [];

  for (const observation of normalized.observations) {
    const key = objectKey(observation);
    const baseValue = observation.metadata_quality * observation.uncertainty;
    if (observedObjectKeys.has(key)) {
      redundancyPenalty += baseValue;
      continue;
    }
    informationGain += baseValue;
    riskGain += baseValue * observation.risk;
    newObjectKeys.push(key);
    if (observation.similarity_group) {
      if (observedSimilarityGroups.has(observation.similarity_group)) {
        redundancyPenalty += baseValue;
      } else {
        newSimilarityGroups.push(observation.similarity_group);
      }
    }
  }

  const marginalValue = informationGain +
    Math.max(0, finiteNumber(riskWeight)) * riskGain -
    Math.max(0, finiteNumber(redundancyWeight)) * redundancyPenalty;
  return {
    action: normalized,
    information_gain: round(informationGain),
    risk_gain: round(riskGain),
    redundancy_penalty: round(redundancyPenalty),
    marginal_value: round(marginalValue),
    value_per_byte: round(marginalValue / normalized.telemetry_bytes, 9),
    new_object_keys: uniqueSorted(newObjectKeys),
    new_similarity_groups: uniqueSorted(newSimilarityGroups),
  };
}

function prepareHardBudgetSelection({ actions, byteBudget, maximumActions }) {
  const budget = finiteNumber(byteBudget, NaN);
  if (!Number.isFinite(budget) || budget <= 0) {
    throw new Error("A positive hard byte budget is required");
  }
  const limit = Number.isFinite(Number(maximumActions))
    ? Math.max(0, Math.floor(Number(maximumActions)))
    : Infinity;
  return {
    budget,
    limit,
    actions: (actions ?? []).map(normalizedAction),
  };
}

function evaluationIsBetter(candidate, current) {
  if (!current) return true;
  const evaluation = candidate.evaluation;
  const best = current.evaluation;
  const action = candidate.action;
  const bestAction = current.action;
  return evaluation.value_per_byte > best.value_per_byte ||
    (evaluation.value_per_byte === best.value_per_byte && evaluation.marginal_value > best.marginal_value) ||
    (evaluation.value_per_byte === best.value_per_byte &&
      evaluation.marginal_value === best.marginal_value &&
      action.telemetry_bytes < bestAction.telemetry_bytes) ||
    (evaluation.value_per_byte === best.value_per_byte &&
      evaluation.marginal_value === best.marginal_value &&
      action.telemetry_bytes === bestAction.telemetry_bytes &&
      action.__input_index < bestAction.__input_index);
}

function commitSelectedAction({
  action,
  evaluation,
  selectedActions,
  selectedGroups,
  observedObjectKeys,
  observedSimilarityGroups,
  budget,
  totals,
}) {
  selectedGroups.add(action.exclusion_group);
  evaluation.new_object_keys.forEach((key) => observedObjectKeys.add(key));
  evaluation.new_similarity_groups.forEach((group) => observedSimilarityGroups.add(group));
  totals.usedBytes += action.telemetry_bytes;
  totals.informationGain += evaluation.information_gain;
  totals.riskGain += evaluation.risk_gain;
  totals.redundancyPenalty += evaluation.redundancy_penalty;
  selectedActions.push({
    ...action,
    marginal_information_gain: evaluation.information_gain,
    marginal_risk_gain: evaluation.risk_gain,
    marginal_redundancy_penalty: evaluation.redundancy_penalty,
    marginal_value: evaluation.marginal_value,
    marginal_value_per_byte: evaluation.value_per_byte,
    budget_used_bytes_after_selection: round(totals.usedBytes),
    budget_remaining_bytes_after_selection: round(budget - totals.usedBytes),
  });
}

function buildHardBudgetSelectionResult({
  selectedActions,
  observedObjectKeys,
  budget,
  totals,
  riskWeight,
  redundancyWeight,
  candidateEvaluations,
  selectionEngine,
  marginalEvaluationCount,
  scoreCacheHits,
  scoreCacheRecomputations,
}) {
  return {
    selected_actions: selectedActions,
    selected_action_count: selectedActions.length,
    observed_object_count: observedObjectKeys.size,
    used_bytes: round(totals.usedBytes),
    remaining_bytes: round(budget - totals.usedBytes),
    budget_bytes: round(budget),
    budget_utilization: round(totals.usedBytes / budget),
    budget_violations: totals.usedBytes > budget + 1e-9 ? 1 : 0,
    information_gain: round(totals.informationGain),
    risk_gain: round(totals.riskGain),
    redundancy_penalty: round(totals.redundancyPenalty),
    evaluated_redundancy_penalty: round(totals.evaluatedRedundancyPenalty),
    total_value: round(
      totals.informationGain + Math.max(0, finiteNumber(riskWeight)) * totals.riskGain -
        Math.max(0, finiteNumber(redundancyWeight)) * totals.redundancyPenalty,
    ),
    candidate_evaluations: candidateEvaluations,
    selection_engine: selectionEngine,
    marginal_evaluation_count: marginalEvaluationCount,
    score_cache_hits: scoreCacheHits,
    score_cache_recomputations: scoreCacheRecomputations,
    policy: selectionEngine === "lazy-greedy"
      ? "cached-lazy-unit-cost-marginal-value-greedy-under-hard-byte-budget"
      : selectionEngine === "cached-plan-greedy"
        ? "cached-plan-static-rank-with-single-marginal-validation-under-hard-byte-budget"
        : "exhaustive-unit-cost-marginal-value-greedy-under-hard-byte-budget",
  };
}

function selectActionsUnderHardBudgetExhaustive({
  actions = [],
  byteBudget,
  riskWeight = 0.35,
  redundancyWeight = 0.3,
  maximumActions = Infinity,
} = {}) {
  const prepared = prepareHardBudgetSelection({ actions, byteBudget, maximumActions });
  const { budget, limit } = prepared;
  const pending = [...prepared.actions];
  const selectedActions = [];
  const selectedGroups = new Set();
  const observedObjectKeys = new Set();
  const observedSimilarityGroups = new Set();
  const candidateEvaluations = [];
  const totals = {
    usedBytes: 0,
    informationGain: 0,
    riskGain: 0,
    redundancyPenalty: 0,
    evaluatedRedundancyPenalty: 0,
  };
  let marginalEvaluationCount = 0;

  while (pending.length > 0 && selectedActions.length < limit) {
    const remainingBytes = budget - totals.usedBytes;
    let best = null;
    for (let index = 0; index < pending.length; index += 1) {
      const action = pending[index];
      if (selectedGroups.has(action.exclusion_group)) continue;
      const evaluation = evaluateMarginalActionValue({
        action,
        observedObjectKeys,
        observedSimilarityGroups,
        riskWeight,
        redundancyWeight,
      });
      marginalEvaluationCount += 1;
      totals.evaluatedRedundancyPenalty += evaluation.redundancy_penalty;
      candidateEvaluations.push({
        iteration: selectedActions.length,
        action_id: action.id,
        fits_budget: action.telemetry_bytes <= remainingBytes,
        information_gain: evaluation.information_gain,
        risk_gain: evaluation.risk_gain,
        redundancy_penalty: evaluation.redundancy_penalty,
        marginal_value: evaluation.marginal_value,
        value_per_byte: evaluation.value_per_byte,
      });
      if (action.telemetry_bytes > remainingBytes || evaluation.marginal_value <= 0) continue;
      if (evaluationIsBetter({ action, evaluation }, best)) {
        best = { action, evaluation, pendingIndex: index };
      }
    }
    if (!best) break;

    pending.splice(best.pendingIndex, 1);
    commitSelectedAction({
      action: best.action,
      evaluation: best.evaluation,
      selectedActions,
      selectedGroups,
      observedObjectKeys,
      observedSimilarityGroups,
      budget,
      totals,
    });
  }

  return buildHardBudgetSelectionResult({
    selectedActions,
    observedObjectKeys,
    budget,
    totals,
    riskWeight,
    redundancyWeight,
    candidateEvaluations,
    selectionEngine: "exhaustive",
    marginalEvaluationCount,
    scoreCacheHits: 0,
    scoreCacheRecomputations: marginalEvaluationCount,
  });
}

function selectActionsUnderHardBudgetLazy({
  actions = [],
  byteBudget,
  riskWeight = 0.35,
  redundancyWeight = 0.3,
  maximumActions = Infinity,
} = {}) {
  const prepared = prepareHardBudgetSelection({ actions, byteBudget, maximumActions });
  const { budget, limit } = prepared;
  const selectedActions = [];
  const selectedGroups = new Set();
  const observedObjectKeys = new Set();
  const observedSimilarityGroups = new Set();
  const candidateEvaluations = [];
  const totals = {
    usedBytes: 0,
    informationGain: 0,
    riskGain: 0,
    redundancyPenalty: 0,
    evaluatedRedundancyPenalty: 0,
  };
  let marginalEvaluationCount = 0;
  let scoreCacheHits = 0;
  let scoreCacheRecomputations = 0;

  const evaluate = (action, iteration, source) => {
    const evaluation = evaluateMarginalActionValue({
      action,
      observedObjectKeys,
      observedSimilarityGroups,
      riskWeight,
      redundancyWeight,
    });
    marginalEvaluationCount += 1;
    if (source === "cache-refresh") scoreCacheRecomputations += 1;
    totals.evaluatedRedundancyPenalty += evaluation.redundancy_penalty;
    candidateEvaluations.push({
      iteration,
      action_id: action.id,
      evaluation_source: source,
      fits_budget: action.telemetry_bytes <= budget - totals.usedBytes,
      information_gain: evaluation.information_gain,
      risk_gain: evaluation.risk_gain,
      redundancy_penalty: evaluation.redundancy_penalty,
      marginal_value: evaluation.marginal_value,
      value_per_byte: evaluation.value_per_byte,
    });
    return evaluation;
  };

  const queue = prepared.actions.map((action) => ({
    action,
    evaluation: evaluate(action, 0, "initial-upper-bound"),
    evaluatedIteration: 0,
  }));

  while (queue.length > 0 && selectedActions.length < limit) {
    const remainingBytes = budget - totals.usedBytes;
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      const entry = queue[index];
      if (selectedGroups.has(entry.action.exclusion_group) || entry.action.telemetry_bytes > remainingBytes) {
        queue.splice(index, 1);
      }
    }
    if (queue.length === 0) break;
    queue.sort((left, right) => evaluationIsBetter(left, right) ? -1 : evaluationIsBetter(right, left) ? 1 : 0);
    const entry = queue.shift();
    const iteration = selectedActions.length;
    if (entry.evaluatedIteration !== iteration) {
      entry.evaluation = evaluate(entry.action, iteration, "cache-refresh");
      entry.evaluatedIteration = iteration;
      if (entry.evaluation.marginal_value > 0) queue.push(entry);
      continue;
    }
    if (entry.evaluation.marginal_value <= 0) continue;
    scoreCacheHits += 1;
    commitSelectedAction({
      action: entry.action,
      evaluation: entry.evaluation,
      selectedActions,
      selectedGroups,
      observedObjectKeys,
      observedSimilarityGroups,
      budget,
      totals,
    });
  }

  return buildHardBudgetSelectionResult({
    selectedActions,
    observedObjectKeys,
    budget,
    totals,
    riskWeight,
    redundancyWeight,
    candidateEvaluations,
    selectionEngine: "lazy-greedy",
    marginalEvaluationCount,
    scoreCacheHits,
    scoreCacheRecomputations,
  });
}

function selectActionsUnderHardBudgetCachedPlan({
  actions = [],
  byteBudget,
  riskWeight = 0.35,
  redundancyWeight = 0.3,
  maximumActions = Infinity,
} = {}) {
  const prepared = prepareHardBudgetSelection({ actions, byteBudget, maximumActions });
  const { budget, limit } = prepared;
  const selectedActions = [];
  const selectedGroups = new Set();
  const observedObjectKeys = new Set();
  const observedSimilarityGroups = new Set();
  const candidateEvaluations = [];
  const totals = {
    usedBytes: 0,
    informationGain: 0,
    riskGain: 0,
    redundancyPenalty: 0,
    evaluatedRedundancyPenalty: 0,
  };
  let marginalEvaluationCount = 0;
  let scoreCacheHits = 0;
  let scoreCacheRecomputations = 0;

  const bestByGroup = new Map();
  for (const action of prepared.actions) {
    const evaluation = evaluateMarginalActionValue({
      action,
      observedObjectKeys,
      observedSimilarityGroups,
      riskWeight,
      redundancyWeight,
    });
    marginalEvaluationCount += 1;
    candidateEvaluations.push({
      iteration: 0,
      action_id: action.id,
      evaluation_source: "cached-plan-static-rank",
      fits_budget: action.telemetry_bytes <= budget,
      information_gain: evaluation.information_gain,
      risk_gain: evaluation.risk_gain,
      redundancy_penalty: evaluation.redundancy_penalty,
      marginal_value: evaluation.marginal_value,
      value_per_byte: evaluation.value_per_byte,
    });
    const entry = { action, evaluation };
    const current = bestByGroup.get(action.exclusion_group);
    if (evaluationIsBetter(entry, current)) bestByGroup.set(action.exclusion_group, entry);
  }

  const ranked = [...bestByGroup.values()].sort((left, right) =>
    evaluationIsBetter(left, right) ? -1 : evaluationIsBetter(right, left) ? 1 : 0
  );
  scoreCacheHits = ranked.length;
  for (const entry of ranked) {
    if (selectedActions.length >= limit) break;
    const { action } = entry;
    if (selectedGroups.has(action.exclusion_group)) continue;
    const remainingBytes = budget - totals.usedBytes;
    if (action.telemetry_bytes > remainingBytes) continue;
    const evaluation = evaluateMarginalActionValue({
      action,
      observedObjectKeys,
      observedSimilarityGroups,
      riskWeight,
      redundancyWeight,
    });
    marginalEvaluationCount += 1;
    scoreCacheRecomputations += 1;
    totals.evaluatedRedundancyPenalty += evaluation.redundancy_penalty;
    candidateEvaluations.push({
      iteration: selectedActions.length,
      action_id: action.id,
      evaluation_source: "cached-plan-single-validation",
      fits_budget: true,
      information_gain: evaluation.information_gain,
      risk_gain: evaluation.risk_gain,
      redundancy_penalty: evaluation.redundancy_penalty,
      marginal_value: evaluation.marginal_value,
      value_per_byte: evaluation.value_per_byte,
    });
    if (evaluation.marginal_value <= 0) continue;
    commitSelectedAction({
      action,
      evaluation,
      selectedActions,
      selectedGroups,
      observedObjectKeys,
      observedSimilarityGroups,
      budget,
      totals,
    });
  }

  return buildHardBudgetSelectionResult({
    selectedActions,
    observedObjectKeys,
    budget,
    totals,
    riskWeight,
    redundancyWeight,
    candidateEvaluations,
    selectionEngine: "cached-plan-greedy",
    marginalEvaluationCount,
    scoreCacheHits,
    scoreCacheRecomputations,
  });
}

export function selectActionsUnderHardBudget(options = {}) {
  const engine = String(options?.selectionEngine ?? "lazy-greedy").toLowerCase();
  if (engine === "exhaustive") return selectActionsUnderHardBudgetExhaustive(options);
  if (engine === "lazy" || engine === "lazy-greedy") return selectActionsUnderHardBudgetLazy(options);
  if (engine === "cached-plan" || engine === "cached-plan-greedy") {
    return selectActionsUnderHardBudgetCachedPlan(options);
  }
  throw new Error(`Unsupported hard-budget selection engine: ${options?.selectionEngine}`);
}

export function chooseTopologyVersionedPlan({
  topologyVersion = buildTopologyVersion(),
  candidatesByMode = {},
  byteBudget,
  riskWeight = 0.35,
  redundancyWeight = 0.3,
  planningCostWeight = 0.05,
  planningCostByMode = {},
  selectionEngineByMode = {},
  maximumActions = Infinity,
} = {}) {
  const modeResults = PLANNING_MODES
    .filter((mode) => Array.isArray(candidatesByMode?.[mode]) && candidatesByMode[mode].length > 0)
    .map((mode) => {
      const actions = candidatesByMode[mode].map((candidate) => ({
        ...candidate,
        planning_mode: mode,
      }));
      const selection = selectActionsUnderHardBudget({
        actions,
        byteBudget,
        riskWeight,
        redundancyWeight,
        selectionEngine: selectionEngineByMode?.[mode] ?? "lazy-greedy",
        maximumActions,
      });
      const inferredPlanningCost = Math.max(0, ...actions.map((action) => finiteNumber(action.planning_cost)));
      const planningCost = Math.max(0, finiteNumber(planningCostByMode?.[mode], inferredPlanningCost));
      return {
        mode,
        ...selection,
        planning_cost: round(planningCost),
        plan_objective: round(selection.total_value - Math.max(0, finiteNumber(planningCostWeight)) * planningCost),
      };
    });

  if (modeResults.length === 0) {
    return {
      selected_mode: "none",
      selected_actions: [],
      mode_results: [],
      topology_version: topologyVersion,
      budget_bytes: round(byteBudget),
      used_bytes: 0,
      budget_violations: 0,
      audit: {
        truth_fields_consumed: 0,
        decision_inputs: ["topology-version", "lagged-oam-uncertainty", "predictable-orbit-risk", "telemetry-byte-cost"],
      },
    };
  }

  modeResults.sort((left, right) =>
    right.plan_objective - left.plan_objective ||
    right.total_value - left.total_value ||
    left.used_bytes - right.used_bytes ||
    MODE_TIE_BREAK_PRIORITY[left.mode] - MODE_TIE_BREAK_PRIORITY[right.mode]
  );
  const selected = modeResults[0];
  const totalMarginalEvaluationCount = modeResults.reduce(
    (sum, result) => sum + finiteNumber(result.marginal_evaluation_count),
    0,
  );
  const totalScoreCacheHits = modeResults.reduce(
    (sum, result) => sum + finiteNumber(result.score_cache_hits),
    0,
  );
  const totalScoreCacheRecomputations = modeResults.reduce(
    (sum, result) => sum + finiteNumber(result.score_cache_recomputations),
    0,
  );
  return {
    selected_mode: selected.mode,
    selected_actions: selected.selected_actions,
    mode_results: modeResults,
    topology_version: topologyVersion,
    budget_bytes: selected.budget_bytes,
    used_bytes: selected.used_bytes,
    remaining_bytes: selected.remaining_bytes,
    budget_utilization: selected.budget_utilization,
    budget_violations: selected.budget_violations,
    information_gain: selected.information_gain,
    risk_gain: selected.risk_gain,
    redundancy_penalty: selected.redundancy_penalty,
    planning_cost: selected.planning_cost,
    plan_objective: selected.plan_objective,
    selection_engine: selected.selection_engine,
    marginal_evaluation_count: totalMarginalEvaluationCount,
    score_cache_hits: totalScoreCacheHits,
    score_cache_recomputations: totalScoreCacheRecomputations,
    objective_formula: "sum(marginal_information+risk_weight*risk_gain-redundancy_weight*redundancy)-planning_cost_weight*planning_cost",
    hard_constraint: "sum(telemetry_bytes)<=byte_budget",
    audit: {
      truth_fields_consumed: 0,
      decision_inputs: ["topology-version", "lagged-oam-uncertainty", "predictable-orbit-risk", "telemetry-byte-cost"],
      mode_tie_break_order: PLANNING_MODES,
    },
  };
}

export const TOPOLOGY_VERSIONED_RISK_PLANNER_MODES = PLANNING_MODES;
