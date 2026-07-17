function finitePairs(rows, actualKey, predictedKey) {
  return rows
    .filter((row) => row.strict_pair === true)
    .map((row) => ({ actual: Number(row[actualKey]), predicted: Number(row[predictedKey]), row }))
    .filter(({ actual, predicted }) => Number.isFinite(actual) && Number.isFinite(predicted));
}

function quantile(values, probability) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function pearson(actual, predicted) {
  if (actual.length < 2) return null;
  const meanActual = actual.reduce((sum, value) => sum + value, 0) / actual.length;
  const meanPredicted = predicted.reduce((sum, value) => sum + value, 0) / predicted.length;
  let numerator = 0;
  let actualVariance = 0;
  let predictedVariance = 0;
  for (let index = 0; index < actual.length; index += 1) {
    const left = actual[index] - meanActual;
    const right = predicted[index] - meanPredicted;
    numerator += left * right;
    actualVariance += left * left;
    predictedVariance += right * right;
  }
  const denominator = Math.sqrt(actualVariance * predictedVariance);
  return denominator > 0 ? numerator / denominator : null;
}

function round(value) {
  return Number.isFinite(value) ? Number(value.toFixed(6)) : value;
}

export function scoreStrictMetric(rows, {
  actualKey,
  predictedKey,
  lowerKey = null,
  upperKey = null,
  unit,
}) {
  const pairs = finitePairs(rows, actualKey, predictedKey);
  if (!pairs.length) return { status: "pending-strict-pairs", sample_count: 0, unit };
  const actual = pairs.map((pair) => pair.actual);
  const predicted = pairs.map((pair) => pair.predicted);
  const errors = pairs.map((pair) => pair.predicted - pair.actual);
  const absoluteErrors = errors.map(Math.abs);
  const squaredErrors = errors.map((value) => value * value);
  const intervalPairs = lowerKey && upperKey
    ? pairs.filter(({ row }) => Number.isFinite(Number(row[lowerKey])) && Number.isFinite(Number(row[upperKey])))
    : [];
  const intervalHits = intervalPairs.filter(({ actual: value, row }) =>
    value >= Number(row[lowerKey]) && value <= Number(row[upperKey])).length;
  return {
    status: "complete",
    sample_count: pairs.length,
    unit,
    mae: round(absoluteErrors.reduce((sum, value) => sum + value, 0) / pairs.length),
    rmse: round(Math.sqrt(squaredErrors.reduce((sum, value) => sum + value, 0) / pairs.length)),
    bias: round(errors.reduce((sum, value) => sum + value, 0) / pairs.length),
    p50_absolute_error: round(quantile(absoluteErrors, 0.5)),
    p95_absolute_error: round(quantile(absoluteErrors, 0.95)),
    pearson_correlation: round(pearson(actual, predicted)),
    prediction_interval_sample_count: intervalPairs.length,
    prediction_interval_coverage: intervalPairs.length ? round(intervalHits / intervalPairs.length) : null,
    actual_p50: round(quantile(actual, 0.5)),
    predicted_p50: round(quantile(predicted, 0.5)),
  };
}

export function scoreV2StrictExternalRows({ mlabRows, ripeRows }) {
  return {
    mlab_ndt7: {
      rtt: scoreStrictMetric(mlabRows, {
        actualKey: "external_rtt_ms",
        predictedKey: "predicted_user_rtt_ms",
        lowerKey: "predicted_rtt_lower_ms",
        upperKey: "predicted_rtt_upper_ms",
        unit: "ms",
      }),
      throughput: scoreStrictMetric(mlabRows, {
        actualKey: "external_throughput_mbps",
        predictedKey: "predicted_user_throughput_mbps",
        lowerKey: "predicted_throughput_lower_mbps",
        upperKey: "predicted_throughput_upper_mbps",
        unit: "Mbit/s",
      }),
    },
    ripe_atlas_exact_anchor: {
      rtt: scoreStrictMetric(ripeRows, {
        actualKey: "external_rtt_ms",
        predictedKey: "predicted_user_rtt_ms",
        lowerKey: "predicted_rtt_lower_ms",
        upperKey: "predicted_rtt_upper_ms",
        unit: "ms",
      }),
      throughput: { status: "not-applicable-no-throughput-target", sample_count: 0, unit: "Mbit/s" },
    },
  };
}
