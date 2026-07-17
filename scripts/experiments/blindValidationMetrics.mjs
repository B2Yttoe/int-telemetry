import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";

export function round(value, digits = 6) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function mean(values) {
  const clean = values.filter(Number.isFinite);
  return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : Number.NaN;
}

export function quantile(values, probability) {
  const clean = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!clean.length) return Number.NaN;
  const p = Math.max(0, Math.min(1, probability));
  const position = (clean.length - 1) * p;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return clean[lower];
  return clean[lower] + (clean[upper] - clean[lower]) * (position - lower);
}

export function standardDeviation(values) {
  const clean = values.filter(Number.isFinite);
  if (clean.length < 2) return Number.NaN;
  const center = mean(clean);
  return Math.sqrt(clean.reduce((sum, value) => sum + (value - center) ** 2, 0) / (clean.length - 1));
}

export function mae(actual, predicted) {
  const pairs = actual.map((value, index) => [value, predicted[index]])
    .filter(([left, right]) => Number.isFinite(left) && Number.isFinite(right));
  return mean(pairs.map(([left, right]) => Math.abs(left - right)));
}

export function rmse(actual, predicted) {
  const pairs = actual.map((value, index) => [value, predicted[index]])
    .filter(([left, right]) => Number.isFinite(left) && Number.isFinite(right));
  return Math.sqrt(mean(pairs.map(([left, right]) => (left - right) ** 2)));
}

export function correlation(left, right) {
  const pairs = left.map((value, index) => [value, right[index]])
    .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  if (pairs.length < 2) return Number.NaN;
  const leftMean = mean(pairs.map(([value]) => value));
  const rightMean = mean(pairs.map(([, value]) => value));
  const numerator = pairs.reduce((sum, [x, y]) => sum + (x - leftMean) * (y - rightMean), 0);
  const leftScale = Math.sqrt(pairs.reduce((sum, [x]) => sum + (x - leftMean) ** 2, 0));
  const rightScale = Math.sqrt(pairs.reduce((sum, [, y]) => sum + (y - rightMean) ** 2, 0));
  return leftScale > 0 && rightScale > 0 ? numerator / (leftScale * rightScale) : Number.NaN;
}

function ranks(values) {
  const indexed = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const output = Array(values.length).fill(Number.NaN);
  for (let start = 0; start < indexed.length;) {
    let end = start + 1;
    while (end < indexed.length && indexed[end].value === indexed[start].value) end += 1;
    const rank = (start + 1 + end) / 2;
    for (let index = start; index < end; index += 1) output[indexed[index].index] = rank;
    start = end;
  }
  return output;
}

export function spearmanCorrelation(left, right) {
  const pairs = left.map((value, index) => [value, right[index]])
    .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  if (pairs.length < 2) return Number.NaN;
  return correlation(ranks(pairs.map(([value]) => value)), ranks(pairs.map(([, value]) => value)));
}

export function parseCsv(text) {
  const matrix = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        cell += character;
      }
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === ",") {
      row.push(cell);
      cell = "";
    } else if (character === "\n") {
      row.push(cell);
      matrix.push(row);
      row = [];
      cell = "";
    } else if (character !== "\r") {
      cell += character;
    }
  }
  if (cell.length || row.length) {
    row.push(cell);
    matrix.push(row);
  }
  const headers = matrix.shift() ?? [];
  if (headers[0]?.charCodeAt(0) === 0xfeff) headers[0] = headers[0].slice(1);
  return matrix.filter((cells) => cells.some((value) => value !== "")).map((cells) =>
    Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ""])),
  );
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function gaussianSolve(matrix, vector) {
  const size = vector.length;
  const augmented = matrix.map((row, index) => [...row, vector[index]]);
  for (let pivot = 0; pivot < size; pivot += 1) {
    let best = pivot;
    for (let row = pivot + 1; row < size; row += 1) {
      if (Math.abs(augmented[row][pivot]) > Math.abs(augmented[best][pivot])) best = row;
    }
    [augmented[pivot], augmented[best]] = [augmented[best], augmented[pivot]];
    const divisor = augmented[pivot][pivot];
    if (Math.abs(divisor) < 1e-12) throw new Error("Radar regression matrix is singular");
    for (let column = pivot; column <= size; column += 1) augmented[pivot][column] /= divisor;
    for (let row = 0; row < size; row += 1) {
      if (row === pivot) continue;
      const factor = augmented[row][pivot];
      for (let column = pivot; column <= size; column += 1) {
        augmented[row][column] -= factor * augmented[pivot][column];
      }
    }
  }
  return augmented.map((row) => row[size]);
}

function radarFeatures(index, firstTimestamp) {
  const elapsedHours = index;
  const timestamp = new Date(firstTimestamp + elapsedHours * 3_600_000);
  const utcHour = timestamp.getUTCHours() + timestamp.getUTCMinutes() / 60;
  return [
    1,
    elapsedHours / 24,
    Math.sin((2 * Math.PI * utcHour) / 24),
    Math.cos((2 * Math.PI * utcHour) / 24),
    Math.sin((2 * Math.PI * utcHour) / 12),
    Math.cos((2 * Math.PI * utcHour) / 12),
  ];
}

function fitRidge(features, targets, lambda) {
  const width = features[0]?.length ?? 0;
  const gram = Array.from({ length: width }, () => Array(width).fill(0));
  const rhs = Array(width).fill(0);
  for (let row = 0; row < features.length; row += 1) {
    for (let left = 0; left < width; left += 1) {
      rhs[left] += features[row][left] * targets[row];
      for (let right = 0; right < width; right += 1) {
        gram[left][right] += features[row][left] * features[row][right];
      }
    }
  }
  for (let index = 1; index < width; index += 1) gram[index][index] += lambda;
  return gaussianSolve(gram, rhs);
}

function dot(left, right) {
  return left.reduce((sum, value, index) => sum + value * right[index], 0);
}

function conformalRadius(residuals, coverage) {
  const sorted = residuals.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return Number.NaN;
  const rank = Math.min(sorted.length, Math.ceil((sorted.length + 1) * coverage));
  return sorted[Math.max(0, rank - 1)];
}

export function buildRadarBlindHoldout(series, config) {
  if (series.length < 48) throw new Error("Radar series needs at least 48 ordered points");
  const rows = [...series].sort((left, right) => new Date(left.time) - new Date(right.time));
  const trainCount = Math.floor(rows.length * config.train_fraction);
  const fitCount = Math.floor(trainCount * config.fit_fraction_within_train);
  if (fitCount < 24 || trainCount - fitCount < 8) throw new Error("Radar calibration split is too small");
  const firstTimestamp = new Date(rows[0].time).getTime();
  const featureRows = rows.map((_, index) => radarFeatures(index, firstTimestamp));
  const targets = rows.map((row) => Number(row.value));
  const coefficients = fitRidge(featureRows.slice(0, fitCount), targets.slice(0, fitCount), config.ridge_lambda);
  const predictions = featureRows.map((features) => dot(features, coefficients));
  const calibrationResiduals = targets.slice(fitCount, trainCount)
    .map((value, offset) => Math.abs(value - predictions[fitCount + offset]));
  const radius = conformalRadius(calibrationResiduals, config.prediction_interval_coverage);
  const trainValues = targets.slice(0, trainCount);
  const trainMin = Math.min(...trainValues);
  const trainMax = Math.max(...trainValues);
  const trainRange = Math.max(trainMax - trainMin, 1e-12);
  const normalize = (value) => (value - trainMin) / trainRange;
  const outputRows = rows.map((row, index) => ({
    index,
    time: row.time,
    split: index < fitCount ? "calibration-fit" : index < trainCount ? "calibration-interval" : "blind-test",
    external_radar_value: round(targets[index], 8),
    external_radar_train_normalized: round(normalize(targets[index]), 8),
    model_predicted_value: round(predictions[index], 8),
    model_predicted_train_normalized: round(normalize(predictions[index]), 8),
    prediction_lower: round(predictions[index] - radius, 8),
    prediction_upper: round(predictions[index] + radius, 8),
    prediction_lower_train_normalized: round(normalize(predictions[index] - radius), 8),
    prediction_upper_train_normalized: round(normalize(predictions[index] + radius), 8),
    traffic_weight: round(
      config.traffic_weight_min +
      Math.max(0, Math.min(1, normalize(predictions[index]))) * (config.traffic_weight_max - config.traffic_weight_min),
      8,
    ),
    absolute_error: round(Math.abs(targets[index] - predictions[index]), 8),
    covered_by_interval: targets[index] >= predictions[index] - radius && targets[index] <= predictions[index] + radius,
  }));
  const testRows = outputRows.slice(trainCount);
  const actual = testRows.map((row) => row.external_radar_train_normalized);
  const predicted = testRows.map((row) => row.model_predicted_train_normalized);
  return {
    rows: outputRows,
    coefficients: coefficients.map((value) => round(value, 10)),
    summary: {
      total_points: rows.length,
      calibration_points: trainCount,
      fit_points: fitCount,
      interval_calibration_points: trainCount - fitCount,
      blind_test_points: rows.length - trainCount,
      calibration_start: rows[0].time,
      calibration_end: rows[trainCount - 1].time,
      blind_test_start: rows[trainCount].time,
      blind_test_end: rows.at(-1).time,
      train_min: round(trainMin, 8),
      train_max: round(trainMax, 8),
      conformal_radius_raw: round(radius, 8),
      blind_pearson_correlation: round(correlation(actual, predicted)),
      blind_spearman_correlation: round(spearmanCorrelation(actual, predicted)),
      blind_normalized_mae: round(mae(actual, predicted)),
      blind_normalized_rmse: round(rmse(actual, predicted)),
      blind_interval_coverage: round(mean(testRows.map((row) => row.covered_by_interval ? 1 : 0))),
      test_values_used_for_fit: 0,
      test_values_used_for_interval_calibration: 0,
    },
  };
}

export async function fetchZipMember(url, member) {
  const headerResponse = await fetch(url, {
    headers: { Range: `bytes=${member.local_header_offset}-${member.local_header_offset + 1023}` },
  });
  if (headerResponse.status !== 206) throw new Error(`ZIP header range request returned HTTP ${headerResponse.status}`);
  const header = Buffer.from(await headerResponse.arrayBuffer());
  if (header.readUInt32LE(0) !== 0x04034b50) throw new Error(`Invalid ZIP local header for ${member.name}`);
  const method = header.readUInt16LE(8);
  const filenameLength = header.readUInt16LE(26);
  const extraLength = header.readUInt16LE(28);
  const filename = header.subarray(30, 30 + filenameLength).toString("utf8");
  if (filename !== member.name) throw new Error(`ZIP member mismatch: expected ${member.name}, found ${filename}`);
  if (method !== member.compression_method) throw new Error(`Unexpected ZIP compression method ${method}`);
  const dataStart = member.local_header_offset + 30 + filenameLength + extraLength;
  const dataEnd = dataStart + member.compressed_size - 1;
  const dataResponse = await fetch(url, { headers: { Range: `bytes=${dataStart}-${dataEnd}` } });
  if (dataResponse.status !== 206) throw new Error(`ZIP data range request returned HTTP ${dataResponse.status}`);
  const compressed = Buffer.from(await dataResponse.arrayBuffer());
  if (compressed.length !== member.compressed_size) {
    throw new Error(`ZIP member length mismatch: expected ${member.compressed_size}, got ${compressed.length}`);
  }
  const content = method === 8 ? inflateRawSync(compressed) : compressed;
  return {
    filename,
    content,
    compressed_sha256: sha256(compressed),
    content_sha256: sha256(content),
    compressed_bytes: compressed.length,
    uncompressed_bytes: content.length,
  };
}

export function deterministicSample(rows, maximum, seed, keyField = "uuid") {
  if (rows.length <= maximum) return [...rows];
  return rows
    .map((row, index) => ({
      row,
      score: sha256(`${seed}:${row[keyField] ?? index}`),
    }))
    .sort((left, right) => left.score.localeCompare(right.score))
    .slice(0, maximum)
    .map(({ row }) => row);
}

export function empiricalCdfRows(seriesByName, points = 101) {
  const names = Object.keys(seriesByName);
  const clean = Object.fromEntries(names.map((name) => [name, seriesByName[name].filter(Number.isFinite)]));
  return Array.from({ length: points }, (_, index) => {
    const probability = points === 1 ? 0.5 : index / (points - 1);
    const row = { probability: round(probability, 4) };
    for (const name of names) row[name] = round(quantile(clean[name], probability));
    return row;
  });
}

export function ksDistance(left, right) {
  const a = left.filter(Number.isFinite).sort((x, y) => x - y);
  const b = right.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length || !b.length) return Number.NaN;
  const values = [...new Set([...a, ...b])].sort((x, y) => x - y);
  let ai = 0;
  let bi = 0;
  let maximum = 0;
  for (const value of values) {
    while (ai < a.length && a[ai] <= value) ai += 1;
    while (bi < b.length && b[bi] <= value) bi += 1;
    maximum = Math.max(maximum, Math.abs(ai / a.length - bi / b.length));
  }
  return maximum;
}

export function wassersteinDistance(left, right, points = 1001) {
  if (!left.some(Number.isFinite) || !right.some(Number.isFinite)) return Number.NaN;
  const differences = Array.from({ length: points }, (_, index) => {
    const probability = index / (points - 1);
    return Math.abs(quantile(left, probability) - quantile(right, probability));
  });
  return mean(differences);
}

export function distributionSummary(values) {
  const clean = values.filter(Number.isFinite);
  return {
    count: clean.length,
    mean: round(mean(clean)),
    standard_deviation: round(standardDeviation(clean)),
    min: round(Math.min(...clean)),
    p025: round(quantile(clean, 0.025)),
    p05: round(quantile(clean, 0.05)),
    p25: round(quantile(clean, 0.25)),
    p50: round(quantile(clean, 0.5)),
    p75: round(quantile(clean, 0.75)),
    p95: round(quantile(clean, 0.95)),
    p975: round(quantile(clean, 0.975)),
    max: round(Math.max(...clean)),
  };
}

export function compareDistributions(model, external) {
  const modelSummary = distributionSummary(model);
  const externalSummary = distributionSummary(external);
  return {
    model: modelSummary,
    external: externalSummary,
    p50_ratio_model_to_external: round(modelSummary.p50 / externalSummary.p50),
    p95_ratio_model_to_external: round(modelSummary.p95 / externalSummary.p95),
    ks_distance: round(ksDistance(model, external)),
    wasserstein_distance: round(wassersteinDistance(model, external)),
    external_coverage_by_model_empirical_95_interval: round(mean(external.map((value) =>
      value >= modelSummary.p025 && value <= modelSummary.p975 ? 1 : 0,
    ))),
  };
}

function createPrng(seed) {
  let state = (Number(seed) >>> 0) || 1;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

export function bootstrapInterval(values, statistic, { iterations = 1000, seed = 1401, confidence = 0.95 } = {}) {
  const clean = values.filter(Number.isFinite);
  if (!clean.length) return { lower: null, upper: null, estimate: null, iterations: 0 };
  const random = createPrng(seed);
  const samples = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const resample = Array.from({ length: clean.length }, () => clean[Math.floor(random() * clean.length)]);
    samples.push(statistic(resample));
  }
  const alpha = (1 - confidence) / 2;
  return {
    estimate: round(statistic(clean)),
    lower: round(quantile(samples, alpha)),
    upper: round(quantile(samples, 1 - alpha)),
    iterations,
    confidence,
  };
}

export function geographicBoxRows(rows, metric, {
  groupField = "client_country_code",
  minimumSamples = 20,
  maximumGroups = 12,
  source = "external",
} = {}) {
  const groups = new Map();
  for (const row of rows) {
    const group = String(row[groupField] ?? "").trim() || "unknown";
    const value = Number(row[metric]);
    if (!Number.isFinite(value)) continue;
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(value);
  }
  return [...groups.entries()]
    .filter(([, values]) => values.length >= minimumSamples)
    .sort((left, right) => right[1].length - left[1].length)
    .slice(0, maximumGroups)
    .map(([group, values]) => ({
      source,
      metric,
      geographic_group: group,
      ...distributionSummary(values),
    }));
}

export function intervalCoverageRow({ evidence, intervalSource, expectedCoverage, values, lower, upper, note = "" }) {
  const clean = values.filter(Number.isFinite);
  const covered = clean.filter((value) => value >= lower && value <= upper).length;
  return {
    evidence,
    interval_source: intervalSource,
    expected_coverage: round(expectedCoverage, 4),
    observed_coverage: round(covered / Math.max(clean.length, 1), 6),
    sample_count: clean.length,
    interval_lower: round(lower),
    interval_upper: round(upper),
    note,
  };
}
