import { createHash } from "node:crypto";

function isActive(row) {
  return String(row?.is_active ?? "").toLowerCase() === "true";
}

function activeIds(rows = []) {
  return new Set(rows.filter(isActive).map((row) => String(row.link_id)));
}

function stableScore(seed, sliceIndex, linkId) {
  return createHash("sha256")
    .update(`${seed}\u0000${sliceIndex}\u0000${linkId}`)
    .digest("hex");
}

function numericSlice(row) {
  const value = Number(row?.slice_index);
  return Number.isFinite(value) ? value : 0;
}

function mean(values) {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

export function topologyDynamicity(previousRows = [], currentRows = []) {
  const previous = activeIds(previousRows);
  const current = activeIds(currentRows);
  let intersection = 0;
  previous.forEach((id) => {
    if (current.has(id)) intersection += 1;
  });
  const union = previous.size + current.size - intersection;
  const jaccard = union === 0 ? 1 : intersection / union;
  return {
    jaccard_similarity: jaccard,
    dynamicity: 1 - jaccard,
  };
}

export function maximumActiveDegree(rows = []) {
  const bySlice = new Map();
  rows.filter(isActive).forEach((row) => {
    const slice = numericSlice(row);
    const degrees = bySlice.get(slice) ?? new Map();
    const source = String(row.source ?? "");
    const target = String(row.target ?? "");
    if (source) degrees.set(source, (degrees.get(source) ?? 0) + 1);
    if (target) degrees.set(target, (degrees.get(target) ?? 0) + 1);
    bySlice.set(slice, degrees);
  });
  let maximum = 0;
  bySlice.forEach((degrees) => {
    degrees.forEach((degree) => {
      maximum = Math.max(maximum, degree);
    });
  });
  return maximum;
}

function downMutation(row) {
  return {
    ...row,
    status: "down",
    is_active: "false",
    restriction_reason: "experiment8-controlled-dynamicity",
    effective_capacity_mbps: "0",
    carried_traffic_mbps: "0",
    utilization_percent: "0",
    demand_traffic_mbps: "0",
    queued_traffic_mb: "0",
    congestion_percent: "0",
  };
}

function candidateForMask(rows, mask) {
  return rows.map((row) => (mask.has(String(row.link_id)) ? downMutation(row) : { ...row }));
}

function eligibleForSlice(rows, seed, sliceIndex) {
  return rows
    .filter((row) => row.kind === "inter-plane" && isActive(row))
    .sort((left, right) => stableScore(seed, sliceIndex, left.link_id).localeCompare(stableScore(seed, sliceIndex, right.link_id)));
}

function mutationRows(originalRows, transformedRows, targetStressRate) {
  const transformedById = new Map(transformedRows.map((row) => [String(row.link_id), row]));
  return originalRows.flatMap((row) => {
    const transformed = transformedById.get(String(row.link_id));
    if (!transformed || isActive(row) === isActive(transformed)) return [];
    return [{
      slice_index: numericSlice(row),
      time: row.time ?? "",
      link_id: row.link_id,
      source: row.source,
      target: row.target,
      kind: row.kind,
      target_stress_rate: targetStressRate,
      mutation_type: isActive(transformed) ? "forced-up" : "forced-down",
      original_status: row.status,
      original_is_active: row.is_active,
      transformed_status: transformed.status,
      transformed_is_active: transformed.is_active,
      reason: transformed.restriction_reason,
    }];
  });
}

export function transformDynamicityTrace({
  links = [],
  targetStressRate,
  seed = "experiment8",
  tolerance = 0.01,
} = {}) {
  if (!Number.isFinite(targetStressRate) || targetStressRate < 0 || targetStressRate > 1) {
    throw new Error("targetStressRate must be within [0, 1]");
  }
  if (!Number.isFinite(tolerance) || tolerance < 0) throw new Error("tolerance must be non-negative");
  const grouped = new Map();
  links.forEach((row) => {
    const slice = numericSlice(row);
    const rows = grouped.get(slice) ?? [];
    rows.push(row);
    grouped.set(slice, rows);
  });
  const slices = [...grouped.keys()].sort((left, right) => left - right);
  if (slices.length < 2) throw new Error("dynamicity stress requires at least two time slices");

  const transformed = [];
  const mutations = [];
  const bySlice = [];
  let previous = null;
  let dynamicitySum = 0;
  let transitionCount = 0;
  let cumulativeEligible = 0;
  let cumulativeMutations = 0;

  slices.forEach((sliceIndex, position) => {
    const originalRows = grouped.get(sliceIndex).map((row) => ({ ...row }));
    const eligible = eligibleForSlice(originalRows, seed, sliceIndex);
    cumulativeEligible += eligible.length;
    const desiredCumulativeMutations = Math.round(targetStressRate * cumulativeEligible);
    const mutationCount = Math.max(0, Math.min(eligible.length, desiredCumulativeMutations - cumulativeMutations));
    cumulativeMutations += mutationCount;
    const mask = new Set(eligible.slice(0, mutationCount).map((row) => String(row.link_id)));
    const selected = candidateForMask(originalRows, mask);
    let selectedMetric = { jaccard_similarity: 1, dynamicity: 0 };
    if (previous) {
      selectedMetric = topologyDynamicity(previous, selected);
      dynamicitySum += selectedMetric.dynamicity;
      transitionCount += 1;
    }
    mutations.push(...mutationRows(originalRows, selected, targetStressRate));
    transformed.push(...selected);
    bySlice.push({
      slice_index: sliceIndex,
      time: selected[0]?.time ?? "",
      target_stress_rate: targetStressRate,
      achieved_stress_rate: eligible.length > 0 ? mutationCount / eligible.length : 0,
      jaccard_similarity: selectedMetric.jaccard_similarity,
      dynamicity: selectedMetric.dynamicity,
      active_links: activeIds(selected).size,
      eligible_inter_plane_links: eligible.length,
      controlled_mutations: mutationCount,
      transition_index: position === 0 ? "initial" : transitionCount,
    });
    previous = selected;
  });

  const achievedMean = mean(bySlice.slice(1).map((row) => row.dynamicity));
  const achievedStressRate = cumulativeEligible > 0 ? cumulativeMutations / cumulativeEligible : 0;
  if (Math.abs(achievedStressRate - targetStressRate) > tolerance) {
    throw new Error(
      `Unable to achieve target stress rate ${targetStressRate} within tolerance ${tolerance}; achieved ${achievedStressRate}`,
    );
  }
  const degree = maximumActiveDegree(transformed);
  const originalDegree = maximumActiveDegree(links);
  if (degree > Math.max(4, originalDegree)) {
    throw new Error(`Controlled dynamicity violated active ISL degree bound: ${degree}`);
  }
  return {
    links: transformed,
    mutations,
    bySlice,
    summary: {
      seed,
      target_stress_rate: targetStressRate,
      achieved_stress_rate: achievedStressRate,
      achieved_mean_dynamicity: achievedMean,
      mean_jaccard_similarity: mean(bySlice.slice(1).map((row) => row.jaccard_similarity)),
      transition_count: transitionCount,
      mutation_count: mutations.length,
      maximum_active_degree: degree,
      baseline_maximum_active_degree: originalDegree,
    },
  };
}
