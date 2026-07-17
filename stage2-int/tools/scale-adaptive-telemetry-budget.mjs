function numberValue(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, minimum = 0, maximum = 1) {
  return Math.min(maximum, Math.max(minimum, numberValue(value)));
}

function splitPath(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  return String(value ?? "")
    .split(/\s+>\s+|\s*\|\s*/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function standardGeneratedBytes({
  pathNodeCount,
  pathLinkCount,
  adjacentRecordCount = 0,
  hopMetadataBytes,
  probePacketBaseBytes,
  reportHeaderBytes,
}) {
  const forwardingHopCount = Math.max(pathNodeCount, pathLinkCount + 1, 1);
  const observationRecordCount = forwardingHopCount + Math.max(0, numberValue(adjacentRecordCount));
  const metadataBytes = observationRecordCount * Math.max(0, numberValue(hopMetadataBytes, 96));
  return Math.ceil(
    Math.max(0, numberValue(probePacketBaseBytes, 64)) +
    metadataBytes +
    Math.max(0, numberValue(reportHeaderBytes, 128)) +
    metadataBytes,
  );
}

function buildIncidentLinks(activeLinks) {
  const byNode = new Map();
  for (const link of activeLinks) {
    const linkId = String(link.link_id ?? "");
    if (!linkId) continue;
    for (const nodeId of [link.source, link.target].filter(Boolean).map(String)) {
      if (!byNode.has(nodeId)) byNode.set(nodeId, new Set());
      byNode.get(nodeId).add(linkId);
    }
  }
  return byNode;
}

function candidateCoverageProfile({
  candidate,
  eligibleNodes,
  eligibleLinks,
  incidentLinks,
  hopMetadataBytes,
  probePacketBaseBytes,
  reportHeaderBytes,
}) {
  const pathNodes = splitPath(candidate.path).filter((nodeId) => eligibleNodes.has(nodeId));
  const pathLinks = splitPath(candidate.link_ids).filter((linkId) => eligibleLinks.has(linkId));
  const coveredLinks = new Set(pathLinks);
  let adjacentRecordCount = 0;
  for (const nodeId of pathNodes) {
    const adjacentLinks = incidentLinks.get(nodeId) ?? [];
    adjacentRecordCount += adjacentLinks.size ?? adjacentLinks.length ?? 0;
    for (const linkId of adjacentLinks) coveredLinks.add(linkId);
  }
  return {
    probe_id: String(candidate.probe_id ?? `${candidate.path ?? ""}|${candidate.link_ids ?? ""}`),
    source: candidate,
    nodes: new Set(pathNodes),
    links: coveredLinks,
    standard_generated_bytes: standardGeneratedBytes({
      pathNodeCount: pathNodes.length,
      pathLinkCount: pathLinks.length,
      adjacentRecordCount,
      hopMetadataBytes,
      probePacketBaseBytes,
      reportHeaderBytes,
    }),
  };
}

function uncoveredCount(values, covered) {
  let count = 0;
  for (const value of values) {
    if (!covered.has(value)) count += 1;
  }
  return count;
}

function addCoverage(values, covered) {
  for (const value of values) covered.add(value);
}

function coverageGain(profile, coveredNodes, coveredLinks, remainingNodeTarget, remainingLinkTarget, targetNodes, targetLinks) {
  const newNodes = Math.min(remainingNodeTarget, uncoveredCount(profile.nodes, coveredNodes));
  const newLinks = Math.min(remainingLinkTarget, uncoveredCount(profile.links, coveredLinks));
  const normalizedNodeGain = targetNodes > 0 ? newNodes / targetNodes : 0;
  const normalizedLinkGain = targetLinks > 0 ? newLinks / targetLinks : 0;
  const normalizedGain = normalizedNodeGain + normalizedLinkGain;
  return {
    newNodes,
    newLinks,
    normalizedGain,
    gainPerByte: normalizedGain / Math.max(profile.standard_generated_bytes, 1),
  };
}

function greedyCoverageWitness({ profiles, targetNodes, targetLinks }) {
  const pending = [...profiles];
  const coveredNodes = new Set();
  const coveredLinks = new Set();
  const selected = [];

  while (
    pending.length > 0 &&
    (coveredNodes.size < targetNodes || coveredLinks.size < targetLinks)
  ) {
    const remainingNodeTarget = Math.max(0, targetNodes - coveredNodes.size);
    const remainingLinkTarget = Math.max(0, targetLinks - coveredLinks.size);
    let bestIndex = -1;
    let bestGain = null;
    for (let index = 0; index < pending.length; index += 1) {
      const gain = coverageGain(
        pending[index],
        coveredNodes,
        coveredLinks,
        remainingNodeTarget,
        remainingLinkTarget,
        targetNodes,
        targetLinks,
      );
      if (
        !bestGain ||
        gain.gainPerByte > bestGain.gainPerByte + 1e-12 ||
        Math.abs(gain.gainPerByte - bestGain.gainPerByte) <= 1e-12 &&
          (gain.normalizedGain > bestGain.normalizedGain + 1e-12 ||
            Math.abs(gain.normalizedGain - bestGain.normalizedGain) <= 1e-12 &&
              String(pending[index].probe_id).localeCompare(String(pending[bestIndex].probe_id)) < 0)
      ) {
        bestIndex = index;
        bestGain = gain;
      }
    }
    if (bestIndex < 0 || !bestGain || bestGain.normalizedGain <= 0) break;
    const [profile] = pending.splice(bestIndex, 1);
    addCoverage(profile.nodes, coveredNodes);
    addCoverage(profile.links, coveredLinks);
    selected.push(profile);
  }

  return { selected, coveredNodes, coveredLinks };
}

function coverageWithinBudget(witness, byteBudget) {
  const coveredNodes = new Set();
  const coveredLinks = new Set();
  let bytes = 0;
  let paths = 0;
  for (const profile of witness) {
    if (bytes + profile.standard_generated_bytes > byteBudget) break;
    bytes += profile.standard_generated_bytes;
    paths += 1;
    addCoverage(profile.nodes, coveredNodes);
    addCoverage(profile.links, coveredLinks);
  }
  return { coveredNodes, coveredLinks, bytes, paths };
}

export function buildScaleAdaptiveTelemetryBudget({
  nodes = [],
  activeLinks = [],
  candidatePaths = [],
  samplingRate = 0.25,
  targetActiveLinkSamplingRate = samplingRate,
  legacyPathFloor = 12,
  explicitByteBudget = 0,
  explicitBudgetSource = "explicit-hard-cap",
  hopMetadataBytes = 96,
  probePacketBaseBytes = 64,
  reportHeaderBytes = 128,
  budgetHeadroomRatio = 0.1,
  pathHeadroomRatio = 0.25,
} = {}) {
  const nodeIds = new Set(nodes.map((node) => String(node.node_id ?? node.id ?? "")).filter(Boolean));
  const active = activeLinks.filter((link) => {
    const explicit = link.is_active ?? link.active;
    return explicit === undefined || explicit === true || String(explicit).toLowerCase() === "true" || Number(explicit) === 1;
  });
  const linkIds = new Set(active.map((link) => String(link.link_id ?? link.id ?? "")).filter(Boolean));
  const targetNodeCount = Math.min(nodeIds.size, Math.ceil(nodeIds.size * clamp(samplingRate)));
  const targetLinkCount = Math.min(linkIds.size, Math.ceil(linkIds.size * clamp(targetActiveLinkSamplingRate)));
  const incidentLinks = buildIncidentLinks(active);
  const profiles = candidatePaths.map((candidate) => candidateCoverageProfile({
    candidate,
    eligibleNodes: nodeIds,
    eligibleLinks: linkIds,
    incidentLinks,
    hopMetadataBytes,
    probePacketBaseBytes,
    reportHeaderBytes,
  }));
  const witness = greedyCoverageWitness({
    profiles,
    targetNodes: targetNodeCount,
    targetLinks: targetLinkCount,
  });
  const witnessBytes = witness.selected.reduce(
    (sum, profile) => sum + profile.standard_generated_bytes,
    0,
  );
  const derivedByteBudget = witnessBytes > 0
    ? Math.ceil(witnessBytes * (1 + clamp(budgetHeadroomRatio, 0, 1)))
    : 0;
  const hardCap = Math.max(0, Math.floor(numberValue(explicitByteBudget)));
  const byteBudget = hardCap > 0 ? hardCap : derivedByteBudget;
  const admittedWitness = coverageWithinBudget(witness.selected, byteBudget);
  const coverageShortfallNodes = Math.max(0, targetNodeCount - admittedWitness.coveredNodes.size);
  const coverageShortfallLinks = Math.max(0, targetLinkCount - admittedWitness.coveredLinks.size);
  const targetCoverageFeasible = coverageShortfallNodes === 0 && coverageShortfallLinks === 0;
  const observableObjectCount = admittedWitness.coveredNodes.size + admittedWitness.coveredLinks.size;
  const eligibleObjectCount = nodeIds.size + linkIds.size;
  const feasibleAoIBound = eligibleObjectCount > 0
    ? Math.ceil(eligibleObjectCount / Math.max(observableObjectCount, 1))
    : 0;
  const safePathCap = Math.min(
    profiles.length,
    Math.max(
      Math.max(0, Math.floor(numberValue(legacyPathFloor))),
      Math.ceil(witness.selected.length * (1 + clamp(pathHeadroomRatio, 0, 1))),
    ),
  );

  return {
    enabled: true,
    node_count: nodeIds.size,
    active_link_count: linkIds.size,
    candidate_path_count: profiles.length,
    target_node_coverage_rate: clamp(samplingRate),
    target_active_link_coverage_rate: clamp(targetActiveLinkSamplingRate),
    target_node_count: targetNodeCount,
    target_active_link_count: targetLinkCount,
    witness_path_count: witness.selected.length,
    witness_probe_ids: witness.selected.map((profile) => profile.probe_id),
    witness_standard_bytes: witnessBytes,
    derived_byte_budget: derivedByteBudget,
    byte_budget: byteBudget,
    byte_budget_source: hardCap > 0 ? explicitBudgetSource : "coverage-derived-standard-metadata",
    safe_path_cap: safePathCap,
    covered_nodes_within_budget: admittedWitness.coveredNodes.size,
    covered_active_links_within_budget: admittedWitness.coveredLinks.size,
    coverage_shortfall_nodes: coverageShortfallNodes,
    coverage_shortfall_links: coverageShortfallLinks,
    node_coverage_feasible: admittedWitness.coveredNodes.size >= targetNodeCount,
    link_coverage_feasible: admittedWitness.coveredLinks.size >= targetLinkCount,
    coverage_feasibility: targetCoverageFeasible ? "coverage-feasible" : "coverage-infeasible",
    feasible_aoi_bound_slices: feasibleAoIBound,
    budget_headroom_ratio: clamp(budgetHeadroomRatio, 0, 1),
    path_headroom_ratio: clamp(pathHeadroomRatio, 0, 1),
  };
}
