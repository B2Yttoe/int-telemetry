function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

function round(value, digits = 4) {
  return Number(value.toFixed(digits));
}

function numberValue(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function scaleProfile(nodeCount) {
  if (nodeCount <= 96) {
    return {
      label: "small",
      maxPathReduction: 0,
      maxMetadataCompression: 0.58,
      qualityMetadataFloor: 0.58,
      costBias: 0.34,
      qualitySensitivity: 0.9,
    };
  }
  if (nodeCount <= 512) {
    return {
      label: "medium",
      maxPathReduction: 0,
      maxMetadataCompression: 0.44,
      qualityMetadataFloor: 0.64,
      costBias: 0.24,
      qualitySensitivity: 1.1,
    };
  }
  return {
    label: "large",
    maxPathReduction: 0,
    maxMetadataCompression: 0.24,
    qualityMetadataFloor: 0.72,
    costBias: 0.08,
    qualitySensitivity: 1.25,
  };
}

export function buildMultiObjectiveBudgetControl({
  enabled = false,
  nodeCount = 0,
  configuredMaxPathsPerSlice = 1,
  baseScale = 1,
  nodeSamplingScale = 1,
  sliceTrafficRisk = 0,
  oamPressure = 0,
  driftPressure = 0,
  reuseConfidence = 0,
  reuseMargin = 0,
  stableWindow = 0,
  lowConfidencePressure = 0,
  conflictPressure = 0,
  retestPressure = 0,
} = {}) {
  const profile = scaleProfile(Math.max(0, Math.floor(numberValue(nodeCount, 0))));
  if (!enabled) {
    return {
      enabled: false,
      scale_profile: profile.label,
      policy: "disabled",
      reason: "multi-objective-controller-disabled",
      quality_guard_pressure: 0,
      cost_reduction_pressure: 0,
      path_budget_scale: round(numberValue(baseScale, 1)),
      effective_max_paths_per_slice: Math.max(1, Math.floor(numberValue(configuredMaxPathsPerSlice, 1))),
      metadata_floor_ratio: 1,
      cost_weight_scale: 1,
      node_state_weight_scale: 1,
      link_state_weight_scale: 1,
      energy_weight_scale: 1,
      queue_weight_scale: 1,
      mode_weight_scale: 1,
    };
  }

  const normalizedReuseMargin = clamp(numberValue(reuseMargin, 0) / 0.18, -0.5, 1);
  const normalizedStableWindow = clamp(numberValue(stableWindow, 0) / 6, 0, 1);
  const qualityGuardPressure = clamp(Math.max(
    numberValue(oamPressure) * 0.9,
    numberValue(lowConfidencePressure) * 0.95,
    numberValue(conflictPressure) * 0.85,
    numberValue(retestPressure) * 0.8,
    numberValue(driftPressure) * 0.62,
    numberValue(sliceTrafficRisk) * 0.55,
  ));
  const stabilityCredit = clamp(
    numberValue(reuseConfidence) * 0.36 +
      normalizedReuseMargin * 0.22 +
      normalizedStableWindow * 0.24 +
      (1 - clamp(numberValue(driftPressure))) * 0.18,
  );
  const scaleCostBias = profile.costBias * (1 + clamp(numberValue(nodeSamplingScale, 1) - 1, 0, 0.55) * 0.35);
  const costReductionPressure = clamp(
    scaleCostBias + stabilityCredit * 0.62 - qualityGuardPressure * profile.qualitySensitivity * 0.58,
  );
  const qualityPreserve = qualityGuardPressure >= 0.55;
  const pathBudgetScale = qualityPreserve
    ? Math.max(0.98, numberValue(baseScale, 1))
    : clamp(numberValue(baseScale, 1) - profile.maxPathReduction * costReductionPressure, 0.78, 1.08);
  const metadataFloorRatio = qualityPreserve
    ? clamp(Math.max(profile.qualityMetadataFloor, 0.52 + qualityGuardPressure * 0.12), profile.qualityMetadataFloor, 0.78)
    : clamp(0.94 - profile.maxMetadataCompression * (0.68 + costReductionPressure * 0.32), 0.38, 0.9);
  const nodePressure = clamp(
    qualityGuardPressure * 0.62 +
      Math.max(0, numberValue(nodeSamplingScale, 1) - 1) * 0.42 +
      numberValue(lowConfidencePressure) * 0.24,
  );
  const linkPressure = clamp(
    qualityGuardPressure * 0.48 +
      numberValue(driftPressure) * 0.26 +
      numberValue(conflictPressure) * 0.18,
  );

  return {
    enabled: true,
    scale_profile: profile.label,
    policy: qualityPreserve
      ? "quality-guard-preserve-observation-budget"
      : costReductionPressure >= 0.45
        ? "cost-pressure-compress-stable-observations"
        : "balanced-quality-cost-control",
    reason: qualityPreserve
      ? "oam-or-drift-pressure-keeps-quality-above-cost-saving"
      : "stable-topology-and-low-quality-pressure-allow-overhead-reduction",
    quality_guard_pressure: round(qualityGuardPressure),
    stability_credit: round(stabilityCredit),
    cost_reduction_pressure: round(costReductionPressure),
    path_budget_scale: round(pathBudgetScale),
    effective_max_paths_per_slice: Math.max(1, Math.floor(numberValue(configuredMaxPathsPerSlice, 1) * pathBudgetScale)),
    metadata_floor_ratio: round(metadataFloorRatio),
    cost_weight_scale: round(1 + costReductionPressure * 0.72),
    node_state_weight_scale: round(1 + nodePressure * 0.78),
    link_state_weight_scale: round(1 + linkPressure * 0.62),
    energy_weight_scale: round(1 + nodePressure * 0.45),
    queue_weight_scale: round(1 + Math.max(nodePressure, linkPressure) * 0.42),
    mode_weight_scale: round(1 + nodePressure * 0.32),
  };
}

export function multiObjectivePathScore({
  baseScore = 0,
  nodeInformationGain = 0,
  linkInformationGain = 0,
  telemetryCostBytes = 0,
  localRisk = 0,
  control,
} = {}) {
  const activeControl = control ?? buildMultiObjectiveBudgetControl();
  const telemetryKb = Math.max(numberValue(telemetryCostBytes, 0) / 1024, 0);
  const qualityBonus =
    Math.log1p(Math.max(0, numberValue(nodeInformationGain))) * 0.24 * numberValue(activeControl.node_state_weight_scale, 1) +
    Math.log1p(Math.max(0, numberValue(linkInformationGain))) * 0.12 * numberValue(activeControl.link_state_weight_scale, 1) +
    numberValue(localRisk) * numberValue(activeControl.quality_guard_pressure, 0) * 0.42;
  const costPenalty = telemetryKb * 0.12 * numberValue(activeControl.cost_weight_scale, 1);
  const score = numberValue(baseScore) + qualityBonus - costPenalty;
  return {
    score: round(score),
    quality_bonus: round(qualityBonus),
    cost_penalty: round(costPenalty),
    telemetry_kb: round(telemetryKb),
  };
}
