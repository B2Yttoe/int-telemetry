const DEFAULT_WEIGHTS = Object.freeze({
  bytes: 0.18,
  energy: 0.07,
  planning: 0.05,
  expectedError: 0.55,
  aoi: 0.15,
});

export const DEFAULT_TOPOLOGY_VERSIONED_OBJECTIVE_WEIGHTS = DEFAULT_WEIGHTS;

function finiteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, minimum = 0, maximum = 1) {
  return Math.max(minimum, Math.min(maximum, finiteNumber(value)));
}

function round(value, digits = 6) {
  return Number(finiteNumber(value).toFixed(digits));
}

function normalizedWeights(weights = {}) {
  const merged = {
    ...DEFAULT_WEIGHTS,
    ...weights,
  };
  const total = Object.values(merged).reduce((sum, value) => sum + Math.max(0, finiteNumber(value)), 0) || 1;
  return Object.fromEntries(
    Object.entries(merged).map(([key, value]) => [key, Math.max(0, finiteNumber(value)) / total]),
  );
}

function metadataObservationYield(profile) {
  switch (String(profile || "standard")) {
    case "reuse-compact":
    case "budget-compact":
      return 0.78;
    case "oam-target-aware":
      return 0.9;
    case "standard-light":
      return 0.95;
    default:
      return 1;
  }
}

function planningCost({ candidateSource, planningRepairCount }) {
  const source = String(candidateSource || "");
  const base = source.includes("topology-reuse-cache") ? 0.15 : source.includes("local") ? 0.45 : 1;
  return clamp(base + Math.min(Math.max(0, finiteNumber(planningRepairCount)), 4) * 0.12, 0, 1.5);
}

export function buildTopologyVersionId(topologyClassId, topologySignature) {
  const classId = String(topologyClassId || "TC-UNKNOWN");
  const signature = String(topologySignature || "unknown").slice(0, 12);
  return `${classId}@${signature}`;
}

export function chooseConservativeObjectiveCandidate({ legacy, objective, minInformationRatio = 0.98 } = {}) {
  if (!legacy && !objective) return { selected: "", reason: "no-candidate" };
  if (!legacy) return { selected: objective.id, reason: "objective-only-candidate" };
  if (!objective) return { selected: legacy.id, reason: "legacy-only-candidate" };
  if (legacy.id === objective.id) return { selected: objective.id, reason: "legacy-objective-agree" };

  const legacyNodes = new Set(Array.isArray(legacy.newNodeIds) ? legacy.newNodeIds : []);
  const objectiveNodes = new Set(Array.isArray(objective.newNodeIds) ? objective.newNodeIds : []);
  const preservesLegacyNodeCoverage = objectiveNodes.size >= legacyNodes.size;
  if (!preservesLegacyNodeCoverage) {
    return { selected: legacy.id, reason: "legacy-shadow-node-coverage-guard" };
  }

  const legacyBytes = Math.max(1, finiteNumber(legacy.telemetryBytes, 1));
  const objectiveBytes = Math.max(0, finiteNumber(objective.telemetryBytes));
  if (objectiveBytes > legacyBytes * 1.01) {
    return { selected: legacy.id, reason: "legacy-shadow-byte-noninferiority-guard" };
  }

  const legacyInformation = Math.max(0, finiteNumber(legacy.marginalInformationGain));
  const objectiveInformation = Math.max(0, finiteNumber(objective.marginalInformationGain));
  const informationFloor = clamp(finiteNumber(minInformationRatio, 0.98), 0.9, 1);
  if (legacyInformation > 0 && objectiveInformation < legacyInformation * informationFloor) {
    return { selected: legacy.id, reason: "legacy-shadow-information-noninferiority-guard" };
  }

  return { selected: objective.id, reason: "objective-admitted-by-legacy-shadow-guard" };
}

export function evaluateTopologyVersionedPathObjective({
  enabled = false,
  topologyClassId = "",
  topologySignature = "",
  candidateSource = "",
  planningRepairCount = 0,
  activeLinkCount = 0,
  linkSignals = [],
  nodeSignals = [],
  telemetryCost = {},
  costReferences = {},
  nodeInformationGain = 0,
  oamTargetScore = 0,
  metadataProfile = "standard",
  baselineRankingScore = 0,
  weights = DEFAULT_WEIGHTS,
  redundancyWeight = 0.3,
  confidenceThreshold = 0.45,
  maximumPromotion = 0.12,
  maximumDemotion = 0.06,
} = {}) {
  const topologyVersionId = buildTopologyVersionId(topologyClassId, topologySignature);
  if (!enabled) {
    return {
      enabled: false,
      topology_version_id: topologyVersionId,
      ranking_score: finiteNumber(baselineRankingScore),
      conservative_score_adjustment: 0,
      gate_decision: "disabled",
      objective_formula: "legacy-ranking",
    };
  }

  const safeSignals = Array.isArray(linkSignals) ? linkSignals : [];
  const safeNodeSignals = Array.isArray(nodeSignals) ? nodeSignals : [];
  const observationYield = metadataObservationYield(metadataProfile);
  let informationGain = 0;
  let redundancyPenalty = 0;
  let totalUncertainty = 0;
  let weightedAgeReduction = 0;
  let uncoveredCount = 0;
  let nodeMarginalInformation = 0;
  let nodeRedundancyPenalty = 0;
  let totalNodeUncertainty = 0;
  let weightedNodeAgeReduction = 0;
  let uncoveredNodeCount = 0;

  for (const signal of safeSignals) {
    const uncertainty = clamp(signal?.uncertainty);
    const topologyRisk = clamp(signal?.topology_risk);
    const age = clamp(signal?.age);
    const riskMultiplier = 0.5 + topologyRisk;
    const informationValue = uncertainty * riskMultiplier * observationYield;
    totalUncertainty += uncertainty;
    if (signal?.covered) {
      redundancyPenalty += informationValue;
      continue;
    }
    informationGain += informationValue;
    weightedAgeReduction += age * Math.max(uncertainty, 0.05);
    uncoveredCount += 1;
  }

  for (const signal of safeNodeSignals) {
    const uncertainty = clamp(signal?.uncertainty);
    const criticality = clamp(signal?.criticality);
    const age = clamp(signal?.age);
    const informationValue = uncertainty * (0.6 + criticality * 0.4) * observationYield;
    totalNodeUncertainty += uncertainty;
    if (signal?.covered) {
      nodeRedundancyPenalty += informationValue;
      continue;
    }
    nodeMarginalInformation += informationValue;
    weightedNodeAgeReduction += age * Math.max(uncertainty, 0.05);
    uncoveredNodeCount += 1;
  }

  const pathPotential = Math.max(safeSignals.length * 1.5 + safeNodeSignals.length, 1);
  const nodeBenefit = clamp(finiteNumber(nodeInformationGain) / Math.max(safeSignals.length + 1, 1));
  const oamBenefit = clamp(finiteNumber(oamTargetScore) / 2);
  const effectiveInformation = Math.max(
    0,
    informationGain + nodeMarginalInformation * 0.75 -
      Math.max(0, finiteNumber(redundancyWeight, 0.3)) * (redundancyPenalty + nodeRedundancyPenalty * 0.75),
  );
  const expectedErrorReduction = clamp(
    effectiveInformation / pathPotential + nodeBenefit * 0.1 + oamBenefit * 0.25,
  );
  const expectedResidualError = 1 - expectedErrorReduction;
  const meanUncoveredUncertainty = uncoveredCount > 0
    ? safeSignals.filter((signal) => !signal?.covered).reduce((sum, signal) => sum + clamp(signal?.uncertainty), 0) / uncoveredCount
    : 0;
  const expectedAoiReduction = uncoveredCount + uncoveredNodeCount > 0
    ? clamp((weightedAgeReduction + weightedNodeAgeReduction) / Math.max(totalUncertainty + totalNodeUncertainty, 0.05))
    : 0;
  const expectedResidualAoi = 1 - expectedAoiReduction;

  const byteReference = Math.max(1, finiteNumber(costReferences?.bytes, 4096));
  const energyReference = Math.max(1e-6, finiteNumber(costReferences?.energyJ, 0.4));
  const normalizedBytes = clamp(
    finiteNumber(telemetryCost?.estimated_total_telemetry_bytes) / byteReference,
    0,
    2,
  );
  const normalizedEnergy = clamp(
    finiteNumber(telemetryCost?.estimated_total_telemetry_energy_j) / energyReference,
    0,
    2,
  );
  const normalizedPlanning = planningCost({ candidateSource, planningRepairCount });
  const objectiveWeights = normalizedWeights(weights);
  const objectiveValue =
    objectiveWeights.bytes * normalizedBytes +
    objectiveWeights.energy * normalizedEnergy +
    objectiveWeights.planning * normalizedPlanning +
    objectiveWeights.expectedError * expectedResidualError +
    objectiveWeights.aoi * expectedResidualAoi;
  const noProbeObjective = objectiveWeights.expectedError + objectiveWeights.aoi;
  const objectiveAdvantage = noProbeObjective - objectiveValue;
  const pathTopologyShare = safeSignals.length / Math.max(finiteNumber(activeLinkCount, safeSignals.length), safeSignals.length, 1);
  const structuralGranularityScale = clamp(0.04 / Math.max(pathTopologyShare, 1e-6), 0.25, 1);
  const evidenceConfidence = clamp(
    Math.min(safeSignals.length + safeNodeSignals.length, 4) / 4 * 0.35 +
      meanUncoveredUncertainty * 0.4 +
      (uncoveredCount + uncoveredNodeCount > 0 ? 0.25 : 0),
  );

  let adjustment = 0;
  let gateDecision = "legacy-fallback-low-confidence";
  if (evidenceConfidence >= confidenceThreshold) {
    adjustment = objectiveAdvantage >= 0
      ? clamp(objectiveAdvantage * 0.35, 0, maximumPromotion)
      : -clamp(Math.abs(objectiveAdvantage) * 0.2, 0, maximumDemotion);
    adjustment *= structuralGranularityScale;
    gateDecision = adjustment > 0
      ? "conservative-promotion"
      : adjustment < 0
        ? "conservative-demotion"
        : "legacy-equivalent";
  }

  return {
    enabled: true,
    topology_version_id: topologyVersionId,
    information_gain: round(informationGain),
    redundancy_penalty: round(redundancyPenalty),
    node_information_gain: round(nodeMarginalInformation),
    node_redundancy_penalty: round(nodeRedundancyPenalty),
    effective_information_gain: round(effectiveInformation),
    expected_error_reduction: round(expectedErrorReduction),
    expected_residual_error: round(expectedResidualError),
    expected_aoi_reduction: round(expectedAoiReduction),
    expected_residual_aoi: round(expectedResidualAoi),
    normalized_bytes_cost: round(normalizedBytes),
    normalized_energy_cost: round(normalizedEnergy),
    normalized_planning_cost: round(normalizedPlanning),
    objective_value: round(objectiveValue),
    no_probe_objective: round(noProbeObjective),
    objective_advantage: round(objectiveAdvantage),
    evidence_confidence: round(evidenceConfidence),
    confidence_threshold: round(confidenceThreshold),
    path_topology_share: round(pathTopologyShare),
    structural_granularity_scale: round(structuralGranularityScale),
    metadata_observation_yield: round(observationYield),
    conservative_score_adjustment: round(adjustment),
    ranking_score: round(finiteNumber(baselineRankingScore) + adjustment),
    gate_decision: gateDecision,
    objective_formula: "lambda_bytes*C_bytes+lambda_energy*C_energy+lambda_planning*C_planning+lambda_error*E_residual+lambda_aoi*AoI_residual",
    information_formula: "sum(uncovered_uncertainty*risk_multiplier*metadata_yield)-gamma*redundancy",
    objective_weights: Object.fromEntries(
      Object.entries(objectiveWeights).map(([key, value]) => [key, round(value)]),
    ),
  };
}
