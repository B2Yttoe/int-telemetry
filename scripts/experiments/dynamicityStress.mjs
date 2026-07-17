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

function sortedByStableScore(rows, seed, phase, idFn = (row) => row.link_id) {
  return rows
    .map((row, index) => ({ row, index, score: stableScore(seed, phase, idFn(row)) }))
    .sort((left, right) => left.score.localeCompare(right.score) || left.index - right.index)
    .map(({ row }) => row);
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

function eligibleForSlice(rows, seed, phaseIndex) {
  return sortedByStableScore(
    rows.filter((row) => row.kind === "inter-plane" && isActive(row)),
    seed,
    phaseIndex,
  );
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
  initialMaskSeed = seed,
  tolerance = 0.01,
  forcedDownFraction = 0.25,
} = {}) {
  if (!Number.isFinite(targetStressRate) || targetStressRate < 0 || targetStressRate > 1) {
    throw new Error("targetStressRate must be within [0, 1]");
  }
  if (!Number.isFinite(tolerance) || tolerance < 0) throw new Error("tolerance must be non-negative");
  if (!Number.isFinite(forcedDownFraction) || forcedDownFraction < 0 || forcedDownFraction > 0.5) {
    throw new Error("forcedDownFraction must be within [0, 0.5]");
  }
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
  let cumulativeTransitionEligible = 0;
  let cumulativeSwapEvents = 0;
  let previousMask = new Set();

  slices.forEach((sliceIndex, position) => {
    const originalRows = grouped.get(sliceIndex).map((row) => ({ ...row }));
    const eligible = eligibleForSlice(originalRows, initialMaskSeed, `eligible:${sliceIndex}`);
    const eligibleIds = new Set(eligible.map((row) => String(row.link_id)));
    const targetMaskSize = Math.max(0, Math.min(eligible.length, Math.round(forcedDownFraction * eligible.length)));
    let mask = new Set([...previousMask].filter((id) => eligibleIds.has(id)));
    let naturalMaskReplacements = 0;
    if (position === 0) {
      mask = new Set(
        eligibleForSlice(originalRows, initialMaskSeed, "initial-mask")
          .slice(0, targetMaskSize)
          .map((row) => String(row.link_id)),
      );
    } else {
      const removeExcess = sortedByStableScore([...mask], seed, `trim:${sliceIndex}`, (id) => id);
      while (mask.size > targetMaskSize) {
        mask.delete(removeExcess.shift());
        naturalMaskReplacements += 1;
      }
      const fill = sortedByStableScore(
        eligible.filter((row) => !mask.has(String(row.link_id))),
        seed,
        `fill:${sliceIndex}`,
      );
      while (mask.size < targetMaskSize && fill.length > 0) {
        mask.add(String(fill.shift().link_id));
        naturalMaskReplacements += 1;
      }
    }

    let controlledSwapCount = 0;
    if (position > 0 && eligible.length > 0 && mask.size > 0 && mask.size < eligible.length) {
      cumulativeTransitionEligible += eligible.length;
      const desiredCumulativeSwaps = Math.round((targetStressRate * cumulativeTransitionEligible) / 2);
      const requestedSwaps = Math.max(0, desiredCumulativeSwaps - cumulativeSwapEvents);
      const removable = sortedByStableScore([...mask], seed, `swap-out:${sliceIndex}`, (id) => id);
      const addable = sortedByStableScore(
        eligible.map((row) => String(row.link_id)).filter((id) => !mask.has(id)),
        seed,
        `swap-in:${sliceIndex}`,
        (id) => id,
      );
      controlledSwapCount = Math.min(requestedSwaps, removable.length, addable.length);
      for (let index = 0; index < controlledSwapCount; index += 1) {
        mask.delete(removable[index]);
        mask.add(addable[index]);
      }
      cumulativeSwapEvents += controlledSwapCount;
    }
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
      achieved_stress_rate: position > 0 && eligible.length > 0 ? (2 * controlledSwapCount) / eligible.length : 0,
      jaccard_similarity: selectedMetric.jaccard_similarity,
      dynamicity: selectedMetric.dynamicity,
      active_links: activeIds(selected).size,
      eligible_inter_plane_links: eligible.length,
      controlled_mutations: mask.size,
      forced_down_fraction: eligible.length > 0 ? mask.size / eligible.length : 0,
      controlled_swap_count: controlledSwapCount,
      controlled_churn_rate: position > 0 && eligible.length > 0 ? (2 * controlledSwapCount) / eligible.length : 0,
      natural_mask_replacements: naturalMaskReplacements,
      transition_index: position === 0 ? "initial" : transitionCount,
    });
    previous = selected;
    previousMask = mask;
  });

  const achievedMean = mean(bySlice.slice(1).map((row) => row.dynamicity));
  const achievedStressRate = cumulativeTransitionEligible > 0
    ? (2 * cumulativeSwapEvents) / cumulativeTransitionEligible
    : 0;
  if (Math.abs(achievedStressRate - targetStressRate) > tolerance + 1e-12) {
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
      initial_mask_seed: initialMaskSeed,
      target_stress_rate: targetStressRate,
      achieved_stress_rate: achievedStressRate,
      achieved_controlled_churn_rate: achievedStressRate,
      achieved_mean_dynamicity: achievedMean,
      mean_jaccard_similarity: mean(bySlice.slice(1).map((row) => row.jaccard_similarity)),
      mean_forced_down_fraction: mean(bySlice.map((row) => row.forced_down_fraction)),
      forced_down_fraction_target: forcedDownFraction,
      transition_count: transitionCount,
      mutation_count: mutations.length,
      controlled_swap_events: cumulativeSwapEvents,
      maximum_active_degree: degree,
      baseline_maximum_active_degree: originalDegree,
    },
  };
}
