export const ADDITIONAL_COMPLETION_BACKENDS = new Set([
  "prior-only",
  "soft-impute",
  "kalman-smoother",
  "graph-neighbor",
  "graph-regularized",
]);

function finiteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, finiteNumber(value, minimum)));
}

function cloneMatrix(matrix) {
  return matrix.map((row) => row.map((value) => finiteNumber(value)));
}

function assertCompatibleMatrices(matrix, activeMask, observedMask) {
  if (!Array.isArray(matrix) || !Array.isArray(activeMask) || !Array.isArray(observedMask)) {
    throw new TypeError("matrix, activeMask and observedMask must be arrays");
  }
  const columns = matrix[0]?.length ?? 0;
  if (
    matrix.length !== activeMask.length ||
    matrix.length !== observedMask.length ||
    matrix.some((row) => row.length !== columns) ||
    activeMask.some((row) => row.length !== columns) ||
    observedMask.some((row) => row.length !== columns)
  ) {
    throw new Error("matrix, activeMask and observedMask must have identical rectangular shapes");
  }
}

function lockObservedAndInactive(completed, source, activeMask, observedMask) {
  for (let row = 0; row < completed.length; row += 1) {
    for (let col = 0; col < completed[row].length; col += 1) {
      if (!activeMask[row][col]) completed[row][col] = 0;
      else if (observedMask[row][col]) completed[row][col] = source[row][col];
      else if (!Number.isFinite(completed[row][col])) completed[row][col] = source[row][col];
    }
  }
}

function dot(left, right) {
  let total = 0;
  for (let index = 0; index < left.length; index += 1) total += left[index] * right[index];
  return total;
}

function multiplyMatrixVector(matrix, vector) {
  return matrix.map((row) => dot(row, vector));
}

function topEigenvectorsSymmetric(matrix, rank) {
  const size = matrix.length;
  const working = matrix.map((row) => [...row]);
  const components = [];
  for (let component = 0; component < Math.min(rank, size); component += 1) {
    let vector = Array.from({ length: size }, (_, index) =>
      Math.sin((index + 1) * (component + 1.61803398875)),
    );
    let magnitude = Math.sqrt(dot(vector, vector)) || 1;
    vector = vector.map((value) => value / magnitude);

    for (let iteration = 0; iteration < 80; iteration += 1) {
      let next = multiplyMatrixVector(working, vector);
      components.forEach((old) => {
        const projection = dot(next, old.vector);
        next = next.map((value, index) => value - projection * old.vector[index]);
      });
      magnitude = Math.sqrt(dot(next, next));
      if (magnitude < 1e-10) break;
      vector = next.map((value) => value / magnitude);
    }

    const eigenvalue = dot(vector, multiplyMatrixVector(working, vector));
    if (!Number.isFinite(eigenvalue) || eigenvalue <= 1e-10) break;
    components.push({ vector, eigenvalue });
    for (let row = 0; row < size; row += 1) {
      for (let col = 0; col < size; col += 1) {
        working[row][col] -= eigenvalue * vector[row] * vector[col];
      }
    }
  }
  return components;
}

export function softThresholdSpectrum(singularValues, threshold) {
  const safeThreshold = Math.max(0, finiteNumber(threshold));
  return singularValues.map((value) => Math.max(0, finiteNumber(value) - safeThreshold));
}

function softThresholdApproximation(matrix, activeMask, rank, lambdaRatio) {
  const rows = matrix.length;
  const columns = matrix[0]?.length ?? 0;
  if (rows === 0 || columns === 0) {
    return { matrix: cloneMatrix(matrix), effectiveRank: 0, threshold: 0, singularValues: [] };
  }

  const covariance = Array.from({ length: columns }, () => Array.from({ length: columns }, () => 0));
  for (let row = 0; row < rows; row += 1) {
    for (let left = 0; left < columns; left += 1) {
      if (!activeMask[row][left]) continue;
      for (let right = left; right < columns; right += 1) {
        if (!activeMask[row][right]) continue;
        covariance[left][right] += matrix[row][left] * matrix[row][right];
      }
    }
  }
  for (let left = 0; left < columns; left += 1) {
    for (let right = 0; right < left; right += 1) covariance[left][right] = covariance[right][left];
  }

  const components = topEigenvectorsSymmetric(covariance, Math.max(1, Math.floor(rank)));
  const singularValues = components.map(({ eigenvalue }) => Math.sqrt(Math.max(0, eigenvalue)));
  const threshold = (singularValues[0] ?? 0) * clamp(lambdaRatio, 0, 1);
  const shrunk = softThresholdSpectrum(singularValues, threshold);
  const output = Array.from({ length: rows }, () => Array.from({ length: columns }, () => 0));

  components.forEach(({ vector }, componentIndex) => {
    const singular = singularValues[componentIndex];
    const retained = shrunk[componentIndex];
    if (singular <= 1e-12 || retained <= 0) return;
    const shrinkScale = retained / singular;
    for (let row = 0; row < rows; row += 1) {
      let projection = 0;
      for (let col = 0; col < columns; col += 1) {
        if (activeMask[row][col]) projection += matrix[row][col] * vector[col];
      }
      for (let col = 0; col < columns; col += 1) {
        if (activeMask[row][col]) output[row][col] += projection * shrinkScale * vector[col];
      }
    }
  });

  return {
    matrix: output,
    effectiveRank: shrunk.filter((value) => value > 1e-10).length,
    threshold,
    singularValues,
  };
}

function completePriorOnly({ matrix, activeMask, observedMask }) {
  const completed = cloneMatrix(matrix);
  lockObservedAndInactive(completed, matrix, activeMask, observedMask);
  return {
    completed,
    diagnostics: {
      completion_algorithm: "structural-prior-only",
      completion_iterations: 0,
      ml_training_samples: 0,
      ml_epochs: 0,
      ml_parameter_count: 0,
      ml_model_architecture: "none",
    },
  };
}

function completeSoftImpute({ matrix, activeMask, observedMask, rank, iterations, options }) {
  const safeIterations = Math.max(1, Math.floor(finiteNumber(iterations, 12)));
  const lambdaRatio = clamp(options?.softImputeLambdaRatio ?? 0.08, 0, 1);
  let completed = cloneMatrix(matrix);
  let approximation = { effectiveRank: 0, threshold: 0, singularValues: [] };
  lockObservedAndInactive(completed, matrix, activeMask, observedMask);

  for (let iteration = 0; iteration < safeIterations; iteration += 1) {
    approximation = softThresholdApproximation(completed, activeMask, rank, lambdaRatio);
    completed = approximation.matrix;
    lockObservedAndInactive(completed, matrix, activeMask, observedMask);
  }

  return {
    completed,
    diagnostics: {
      completion_algorithm: "prior-initialized-soft-impute",
      completion_iterations: safeIterations,
      soft_impute_lambda_ratio: lambdaRatio,
      soft_impute_threshold: approximation.threshold,
      effective_rank: approximation.effectiveRank,
      retained_singular_values: approximation.singularValues.length,
      ml_training_samples: 0,
      ml_epochs: 0,
      ml_parameter_count: 0,
      ml_model_architecture: "none",
    },
  };
}

function activeSegments(mask) {
  const segments = [];
  let start = -1;
  for (let index = 0; index <= mask.length; index += 1) {
    if (mask[index] && start < 0) start = index;
    if ((!mask[index] || index === mask.length) && start >= 0) {
      segments.push([start, index - 1]);
      start = -1;
    }
  }
  return segments;
}

function smoothKalmanSegment({ source, observed, start, end, processVariance, measurementVariance, initialVariance }) {
  const length = end - start + 1;
  const observedIndexes = [];
  for (let col = start; col <= end; col += 1) {
    if (observed[col]) observedIndexes.push(col);
  }
  if (observedIndexes.length === 0) {
    return {
      values: source.slice(start, end + 1),
      observedUpdates: 0,
      smoothedMissingCells: 0,
    };
  }

  const filtered = Array.from({ length }, () => 0);
  const filteredVariance = Array.from({ length }, () => 0);
  const predicted = Array.from({ length }, () => 0);
  const predictedVariance = Array.from({ length }, () => 0);
  let state = finiteNumber(source[start]);
  let variance = initialVariance;
  let observedUpdates = 0;

  for (let offset = 0; offset < length; offset += 1) {
    const col = start + offset;
    const statePrediction = state;
    const variancePrediction = Math.max(1e-9, variance + processVariance);
    predicted[offset] = statePrediction;
    predictedVariance[offset] = variancePrediction;
    if (observed[col]) {
      const innovationVariance = variancePrediction + measurementVariance;
      const gain = variancePrediction / Math.max(innovationVariance, 1e-9);
      state = statePrediction + gain * (finiteNumber(source[col]) - statePrediction);
      variance = Math.max(1e-9, (1 - gain) * variancePrediction);
      observedUpdates += 1;
    } else {
      state = statePrediction;
      variance = variancePrediction;
    }
    filtered[offset] = state;
    filteredVariance[offset] = variance;
  }

  const smoothed = [...filtered];
  for (let offset = length - 2; offset >= 0; offset -= 1) {
    const gain = filteredVariance[offset] / Math.max(predictedVariance[offset + 1], 1e-9);
    smoothed[offset] = filtered[offset] + gain * (smoothed[offset + 1] - predicted[offset + 1]);
  }

  return {
    values: smoothed,
    observedUpdates,
    smoothedMissingCells: observedIndexes.length > 0
      ? Array.from({ length }, (_, offset) => start + offset).filter((col) => !observed[col]).length
      : 0,
  };
}

function completeKalmanSmoother({ matrix, activeMask, observedMask, options }) {
  const processVariance = clamp(options?.kalmanProcessVariance ?? 0.05, 1e-6, 10);
  const measurementVariance = clamp(options?.kalmanMeasurementVariance ?? 0.1, 1e-6, 10);
  const initialVariance = clamp(options?.kalmanInitialVariance ?? 1, 1e-6, 100);
  const completed = cloneMatrix(matrix);
  let segmentCount = 0;
  let observedUpdates = 0;
  let smoothedMissingCells = 0;

  for (let row = 0; row < matrix.length; row += 1) {
    for (const [start, end] of activeSegments(activeMask[row])) {
      segmentCount += 1;
      const result = smoothKalmanSegment({
        source: matrix[row],
        observed: observedMask[row],
        start,
        end,
        processVariance,
        measurementVariance,
        initialVariance,
      });
      observedUpdates += result.observedUpdates;
      smoothedMissingCells += result.smoothedMissingCells;
      for (let offset = 0; offset < result.values.length; offset += 1) {
        const col = start + offset;
        if (!observedMask[row][col]) completed[row][col] = result.values[offset];
      }
    }
  }
  lockObservedAndInactive(completed, matrix, activeMask, observedMask);

  return {
    completed,
    diagnostics: {
      completion_algorithm: "local-level-kalman-rts-smoother",
      completion_iterations: 1,
      kalman_process_variance: processVariance,
      kalman_measurement_variance: measurementVariance,
      kalman_initial_variance: initialVariance,
      kalman_active_segments: segmentCount,
      kalman_observed_updates: observedUpdates,
      kalman_smoothed_missing_cells: smoothedMissingCells,
      uses_future_delivered_observations: true,
      online_causal: false,
      ml_training_samples: 0,
      ml_epochs: 0,
      ml_parameter_count: 0,
      ml_model_architecture: "scalar-local-level-kalman-rts",
    },
  };
}

function activeNeighborMean(completed, activeMask, indexes, colIndex) {
  const values = indexes
    .filter((rowIndex) => activeMask[rowIndex]?.[colIndex])
    .map((rowIndex) => completed[rowIndex]?.[colIndex])
    .filter(Number.isFinite);
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : NaN;
}

function temporalNeighborMean(completed, activeMask, rowIndex, colIndex) {
  const values = [];
  if (colIndex > 0 && activeMask[rowIndex][colIndex - 1]) values.push(completed[rowIndex][colIndex - 1]);
  if (colIndex + 1 < completed[rowIndex].length && activeMask[rowIndex][colIndex + 1]) {
    values.push(completed[rowIndex][colIndex + 1]);
  }
  const finite = values.filter(Number.isFinite);
  return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : NaN;
}

function completeGraphNeighbor({ matrix, activeMask, observedMask, iterations, neighborRows, options }) {
  const safeIterations = Math.max(1, Math.floor(finiteNumber(iterations, 12)));
  const graphWeight = Math.max(0, finiteNumber(options?.graphWeight, 0.8));
  const priorWeight = Math.max(0, finiteNumber(options?.priorWeight, 0.2));
  const weightFallback = graphWeight + priorWeight > 0 ? { graphWeight, priorWeight } : {
    graphWeight: 1,
    priorWeight: 0,
  };
  let completed = cloneMatrix(matrix);
  let graphUpdatedCells = 0;
  lockObservedAndInactive(completed, matrix, activeMask, observedMask);

  for (let iteration = 0; iteration < safeIterations; iteration += 1) {
    const next = cloneMatrix(completed);
    let updatesThisIteration = 0;
    for (let row = 0; row < completed.length; row += 1) {
      for (let col = 0; col < completed[row].length; col += 1) {
        if (!activeMask[row][col] || observedMask[row][col]) continue;
        const graphMean = activeNeighborMean(completed, activeMask, neighborRows?.[row] ?? [], col);
        if (!Number.isFinite(graphMean)) {
          next[row][col] = matrix[row][col];
          continue;
        }
        const totalWeight = weightFallback.graphWeight + weightFallback.priorWeight;
        next[row][col] = (
          graphMean * weightFallback.graphWeight + matrix[row][col] * weightFallback.priorWeight
        ) / Math.max(totalWeight, 1e-9);
        updatesThisIteration += 1;
      }
    }
    graphUpdatedCells = Math.max(graphUpdatedCells, updatesThisIteration);
    lockObservedAndInactive(next, matrix, activeMask, observedMask);
    completed = next;
  }

  return {
    completed,
    diagnostics: {
      completion_algorithm: "same-slice-orbit-graph-neighbor-interpolation",
      completion_iterations: safeIterations,
      graph_neighbor_weight: weightFallback.graphWeight,
      graph_neighbor_prior_weight: weightFallback.priorWeight,
      graph_neighbor_updated_cells: graphUpdatedCells,
      temporal_information_used: false,
      low_rank_information_used: false,
      ml_training_samples: 0,
      ml_epochs: 0,
      ml_parameter_count: 0,
      ml_model_architecture: "none",
    },
  };
}

function completeGraphRegularized({ matrix, activeMask, observedMask, rank, iterations, neighborRows, options }) {
  const safeIterations = Math.max(1, Math.floor(finiteNumber(iterations, 12)));
  const weights = {
    graph: Math.max(0, finiteNumber(options?.graphWeight, 0.4)),
    temporal: Math.max(0, finiteNumber(options?.temporalWeight, 0.25)),
    prior: Math.max(0, finiteNumber(options?.priorWeight, 0.2)),
    lowRank: Math.max(0, finiteNumber(options?.lowRankWeight, 0.15)),
  };
  if (Object.values(weights).every((value) => value === 0)) weights.prior = 1;
  const lowRankTarget = softThresholdApproximation(
    matrix,
    activeMask,
    rank,
    clamp(options?.softImputeLambdaRatio ?? 0.05, 0, 1),
  );
  let completed = cloneMatrix(matrix);
  lockObservedAndInactive(completed, matrix, activeMask, observedMask);

  for (let iteration = 0; iteration < safeIterations; iteration += 1) {
    const next = cloneMatrix(completed);
    for (let row = 0; row < completed.length; row += 1) {
      for (let col = 0; col < completed[row].length; col += 1) {
        if (!activeMask[row][col] || observedMask[row][col]) continue;
        const candidates = [
          { value: matrix[row][col], weight: weights.prior },
          { value: activeNeighborMean(completed, activeMask, neighborRows?.[row] ?? [], col), weight: weights.graph },
          { value: temporalNeighborMean(completed, activeMask, row, col), weight: weights.temporal },
          { value: lowRankTarget.matrix[row][col], weight: weights.lowRank },
        ].filter((item) => item.weight > 0 && Number.isFinite(item.value));
        const weightTotal = candidates.reduce((sum, item) => sum + item.weight, 0);
        next[row][col] = weightTotal > 0
          ? candidates.reduce((sum, item) => sum + item.value * item.weight, 0) / weightTotal
          : matrix[row][col];
      }
    }
    lockObservedAndInactive(next, matrix, activeMask, observedMask);
    completed = next;
  }

  return {
    completed,
    diagnostics: {
      completion_algorithm: "graph-temporal-laplacian-regularized",
      completion_iterations: safeIterations,
      graph_regularization_weight: weights.graph,
      temporal_regularization_weight: weights.temporal,
      prior_regularization_weight: weights.prior,
      low_rank_regularization_weight: weights.lowRank,
      low_rank_target_effective_rank: lowRankTarget.effectiveRank,
      ml_training_samples: 0,
      ml_epochs: 0,
      ml_parameter_count: 0,
      ml_model_architecture: "none",
    },
  };
}

export function completeWithAdditionalBackend({
  backend,
  matrix,
  activeMask,
  observedMask,
  rank = 5,
  iterations = 12,
  neighborRows = [],
  options = {},
} = {}) {
  assertCompatibleMatrices(matrix, activeMask, observedMask);
  if (backend === "prior-only") return completePriorOnly({ matrix, activeMask, observedMask });
  if (backend === "soft-impute") {
    return completeSoftImpute({ matrix, activeMask, observedMask, rank, iterations, options });
  }
  if (backend === "kalman-smoother") {
    return completeKalmanSmoother({ matrix, activeMask, observedMask, options });
  }
  if (backend === "graph-neighbor") {
    return completeGraphNeighbor({
      matrix,
      activeMask,
      observedMask,
      iterations,
      neighborRows,
      options,
    });
  }
  if (backend === "graph-regularized") {
    return completeGraphRegularized({
      matrix,
      activeMask,
      observedMask,
      rank,
      iterations,
      neighborRows,
      options,
    });
  }
  throw new Error(`Unsupported additional completion backend: ${backend}`);
}
