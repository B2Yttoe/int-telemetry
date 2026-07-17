function finiteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, finiteNumber(value, minimum)));
}

function clipFinite(value, minimum, maximum, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function round(value, digits = 6) {
  return Number(finiteNumber(value).toFixed(digits));
}

function initialFactor(index, component, salt, scale = 0.16) {
  return scale * Math.sin((index + 1) * (component + 1) * (salt + 1.61803398875));
}

function tensorKey(timeId, objectId) {
  return `${timeId}|${objectId}`;
}

function predictNormalized(timeFactors, objectFactors, metricFactors, timeIndex, objectIndex, metricIndex) {
  let value = 0;
  for (let component = 0; component < timeFactors[timeIndex].length; component += 1) {
    value +=
      timeFactors[timeIndex][component] *
      objectFactors[objectIndex][component] *
      metricFactors[metricIndex][component];
  }
  return value;
}

function smoothFactorRows(factors, neighborIndexes, strength) {
  if (strength <= 0) return;
  const next = factors.map((row) => [...row]);
  for (let rowIndex = 0; rowIndex < factors.length; rowIndex += 1) {
    const neighbors = neighborIndexes[rowIndex] ?? [];
    if (neighbors.length === 0) continue;
    for (let component = 0; component < factors[rowIndex].length; component += 1) {
      const neighborMean = mean(neighbors.map((index) => factors[index][component]));
      next[rowIndex][component] =
        factors[rowIndex][component] * (1 - strength) + neighborMean * strength;
    }
  }
  for (let rowIndex = 0; rowIndex < factors.length; rowIndex += 1) {
    factors[rowIndex] = next[rowIndex];
  }
}

function temporalNeighborIndexes(length) {
  return Array.from({ length }, (_, index) => [index - 1, index + 1].filter((neighbor) => neighbor >= 0 && neighbor < length));
}

function objectNeighborIndexes(objectIds, neighborObjectIds) {
  const indexById = new Map(objectIds.map((objectId, index) => [String(objectId), index]));
  return objectIds.map((objectId, objectIndex) =>
    (neighborObjectIds?.get(String(objectId)) ?? [])
      .map((neighborId) => indexById.get(String(neighborId)))
      .filter((index) => Number.isInteger(index) && index !== objectIndex),
  );
}

function validateInputs(timeIds, objectIds, metricSpecs) {
  if (!Array.isArray(timeIds) || timeIds.length === 0) throw new Error("timeIds must be a non-empty array");
  if (!Array.isArray(objectIds) || objectIds.length === 0) throw new Error("objectIds must be a non-empty array");
  if (!Array.isArray(metricSpecs) || metricSpecs.length < 2) {
    throw new Error("joint tensor completion requires at least two metric specifications");
  }
  const names = metricSpecs.map((metric) => String(metric?.name || ""));
  if (names.some((name) => !name) || new Set(names).size !== names.length) {
    throw new Error("joint tensor metric names must be non-empty and unique");
  }
  metricSpecs.forEach((metric) => {
    if (!(metric.observedValues instanceof Map) || !(metric.priorEstimates instanceof Map)) {
      throw new Error(`metric ${metric.name} must provide observedValues and priorEstimates maps`);
    }
  });
}

export function completeJointMetricTensor({
  timeIds,
  objectIds,
  metricSpecs,
  isActive = () => true,
  neighborObjectIds = new Map(),
  rank = 5,
  epochs = 60,
  learningRate = 0.05,
  l2 = 0.001,
  jointPredictionWeight = 0.35,
  temporalRegularization = 0.015,
  orbitRegularization = 0.015,
} = {}) {
  validateInputs(timeIds, objectIds, metricSpecs);
  const startedAt = performance.now();
  const safeRank = Math.max(1, Math.floor(finiteNumber(rank, 5)));
  const safeEpochs = Math.max(1, Math.floor(finiteNumber(epochs, 60)));
  const safeLearningRate = clamp(learningRate, 1e-5, 0.25);
  const safeL2 = clamp(l2, 0, 0.1);
  const safeJointWeight = clamp(jointPredictionWeight, 0, 1);
  const safeTemporalRegularization = clamp(temporalRegularization, 0, 0.25);
  const safeOrbitRegularization = clamp(orbitRegularization, 0, 0.25);

  const metricStats = metricSpecs.map((metric) => {
    const values = [];
    for (const timeId of timeIds) {
      for (const objectId of objectIds) {
        if (!isActive({ timeId, objectId, metric: metric.name })) continue;
        const value = Number(metric.observedValues.get(tensorKey(timeId, objectId)));
        if (Number.isFinite(value)) values.push(value);
      }
    }
    const observedMean = mean(values);
    const observedStd = Math.sqrt(mean(values.map((value) => (value - observedMean) ** 2))) || 1;
    return {
      name: metric.name,
      mean: observedMean,
      std: observedStd,
      observed: values.length,
    };
  });

  const observedCells = [];
  metricSpecs.forEach((metric, metricIndex) => {
    const stats = metricStats[metricIndex];
    timeIds.forEach((timeId, timeIndex) => {
      objectIds.forEach((objectId, objectIndex) => {
        if (!isActive({ timeId, objectId, metric: metric.name })) return;
        const value = Number(metric.observedValues.get(tensorKey(timeId, objectId)));
        if (!Number.isFinite(value)) return;
        observedCells.push({
          timeIndex,
          objectIndex,
          metricIndex,
          normalizedValue: (value - stats.mean) / stats.std,
        });
      });
    });
  });
  if (observedCells.length === 0) throw new Error("joint tensor completion requires directly observed cells");
  const activeCellCount = metricSpecs.reduce((total, metric) => total + timeIds.reduce(
    (timeTotal, timeId) => timeTotal + objectIds.filter((objectId) =>
      isActive({ timeId, objectId, metric: metric.name })).length,
    0,
  ), 0);
  const observationDensity = observedCells.length / Math.max(activeCellCount, 1);
  const observationDensityConfidence = Math.sqrt(clamp(observationDensity, 0, 1));

  const timeFactors = timeIds.map((_, index) =>
    Array.from({ length: safeRank }, (_, component) => initialFactor(index, component, 1)),
  );
  const objectFactors = objectIds.map((_, index) =>
    Array.from({ length: safeRank }, (_, component) => initialFactor(index, component, 2)),
  );
  const metricFactors = metricSpecs.map((_, index) =>
    Array.from({ length: safeRank }, (_, component) => initialFactor(index, component, 3, 0.22)),
  );
  const timeNeighbors = temporalNeighborIndexes(timeIds.length);
  const objectNeighbors = objectNeighborIndexes(objectIds, neighborObjectIds);

  let finalObservedLoss = 0;
  for (let epoch = 0; epoch < safeEpochs; epoch += 1) {
    let squaredError = 0;
    for (let offset = 0; offset < observedCells.length; offset += 1) {
      const cell = observedCells[(offset + epoch * 17) % observedCells.length];
      const { timeIndex, objectIndex, metricIndex, normalizedValue } = cell;
      const prediction = predictNormalized(
        timeFactors,
        objectFactors,
        metricFactors,
        timeIndex,
        objectIndex,
        metricIndex,
      );
      const error = clamp(prediction - normalizedValue, -6, 6);
      squaredError += error * error;
      for (let component = 0; component < safeRank; component += 1) {
        const timeValue = timeFactors[timeIndex][component];
        const objectValue = objectFactors[objectIndex][component];
        const metricValue = metricFactors[metricIndex][component];
        const timeGradient = clipFinite(error * objectValue * metricValue + safeL2 * timeValue, -8, 8);
        const objectGradient = clipFinite(error * timeValue * metricValue + safeL2 * objectValue, -8, 8);
        const metricGradient = clipFinite(error * timeValue * objectValue + safeL2 * metricValue, -8, 8);
        timeFactors[timeIndex][component] = clipFinite(timeValue - safeLearningRate * timeGradient, -3, 3);
        objectFactors[objectIndex][component] = clipFinite(objectValue - safeLearningRate * objectGradient, -3, 3);
        metricFactors[metricIndex][component] = clipFinite(metricValue - safeLearningRate * metricGradient, -3, 3);
      }
    }
    smoothFactorRows(timeFactors, timeNeighbors, safeTemporalRegularization);
    smoothFactorRows(objectFactors, objectNeighbors, safeOrbitRegularization);
    finalObservedLoss = squaredError / observedCells.length;
  }

  const metricFitQuality = metricSpecs.map((metric, metricIndex) => {
    const cells = observedCells.filter((cell) => cell.metricIndex === metricIndex);
    const squaredError = cells.reduce((total, cell) => {
      const prediction = predictNormalized(
        timeFactors,
        objectFactors,
        metricFactors,
        cell.timeIndex,
        cell.objectIndex,
        cell.metricIndex,
      );
      return total + (prediction - cell.normalizedValue) ** 2;
    }, 0);
    const observedNormalizedRmse = Math.sqrt(squaredError / Math.max(cells.length, 1));
    return {
      metric: metric.name,
      observed_normalized_rmse: observedNormalizedRmse,
      fit_confidence: Number.isFinite(observedNormalizedRmse)
        ? clamp(1 - observedNormalizedRmse, 0.05, 1)
        : 0,
      effective_weights: [],
    };
  });

  const estimatesByMetric = new Map();
  let nonFinitePredictionFallbackCells = 0;
  metricSpecs.forEach((metric, metricIndex) => {
    const estimates = new Map();
    const stats = metricStats[metricIndex];
    timeIds.forEach((timeId, timeIndex) => {
      objectIds.forEach((objectId, objectIndex) => {
        if (!isActive({ timeId, objectId, metric: metric.name })) return;
        const key = tensorKey(timeId, objectId);
        const observedValue = Number(metric.observedValues.get(key));
        if (Number.isFinite(observedValue)) {
          estimates.set(key, observedValue);
          return;
        }
        const rawNormalizedPrediction = predictNormalized(
          timeFactors,
          objectFactors,
          metricFactors,
          timeIndex,
          objectIndex,
          metricIndex,
        );
        const normalizedPrediction = Number.isFinite(rawNormalizedPrediction)
          ? clipFinite(rawNormalizedPrediction, -6, 6)
          : NaN;
        const jointPrediction = normalizedPrediction * stats.std + stats.mean;
        const priorValue = Number(metric.priorEstimates.get(key));
        if (!Number.isFinite(jointPrediction)) {
          nonFinitePredictionFallbackCells += 1;
          const fallback = Number.isFinite(priorValue) ? priorValue : stats.mean;
          estimates.set(key, typeof metric.clamp === "function" ? metric.clamp(fallback) : fallback);
          metricFitQuality[metricIndex].effective_weights.push(0);
          return;
        }
        const disagreement = Number.isFinite(priorValue)
          ? Math.abs(jointPrediction - priorValue) / Math.max(stats.std, 1e-9)
          : 0;
        const agreementConfidence = 1 / (1 + disagreement);
        const effectiveJointWeight = Number.isFinite(priorValue)
          ? safeJointWeight * metricFitQuality[metricIndex].fit_confidence * agreementConfidence * observationDensityConfidence
          : 1;
        metricFitQuality[metricIndex].effective_weights.push(effectiveJointWeight);
        const blended = Number.isFinite(priorValue)
          ? jointPrediction * effectiveJointWeight + priorValue * (1 - effectiveJointWeight)
          : jointPrediction;
        estimates.set(key, typeof metric.clamp === "function" ? metric.clamp(blended) : blended);
      });
    });
    estimatesByMetric.set(metric.name, estimates);
  });

  return {
    estimatesByMetric,
    diagnostics: {
      completion_algorithm: "orbit-aware-multi-metric-cp",
      tensor_shape: `${timeIds.length}x${objectIds.length}x${metricSpecs.length}`,
      time_slices: timeIds.length,
      objects: objectIds.length,
      metrics: metricSpecs.length,
      metric_names: metricSpecs.map((metric) => metric.name),
      observed_cells: observedCells.length,
      active_cells: activeCellCount,
      observation_density: round(observationDensity),
      observation_density_confidence: round(observationDensityConfidence),
      normalization_source: "direct-observations-only",
      normalization: metricStats.map((stats) => ({
        metric: stats.name,
        observed_values: stats.observed,
        mean: round(stats.mean),
        std: round(stats.std),
      })),
      rank: safeRank,
      epochs: safeEpochs,
      learning_rate: safeLearningRate,
      l2: safeL2,
      joint_prediction_weight: safeJointWeight,
      prior_weight: round(1 - safeJointWeight),
      temporal_regularization: safeTemporalRegularization,
      orbit_regularization: safeOrbitRegularization,
      final_observed_loss: round(finalObservedLoss),
      numerical_stability_guard: true,
      factor_clip_absolute: 3,
      gradient_clip_absolute: 8,
      normalized_prediction_clip_absolute: 6,
      non_finite_prediction_fallback_cells: nonFinitePredictionFallbackCells,
      adaptive_trust_gate: true,
      adaptive_trust_gate_inputs: [
        "direct-observation-fit",
        "standardized-prior-disagreement",
        "observation-density-confidence",
      ],
      metric_fit_quality: metricFitQuality.map((quality) => ({
        metric: quality.metric,
        observed_normalized_rmse: round(quality.observed_normalized_rmse),
        fit_confidence: round(quality.fit_confidence),
        mean_effective_joint_weight: round(mean(quality.effective_weights)),
      })),
      parameter_count: (timeIds.length + objectIds.length + metricSpecs.length) * safeRank,
      wall_clock_ms: round(performance.now() - startedAt),
      observed_values_locked: true,
      inactive_cells_excluded: true,
      hidden_truth_used: false,
    },
  };
}
