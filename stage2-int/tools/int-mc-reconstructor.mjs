import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";

function argValue(args, name, fallback = "") {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  return args[index + 1] ?? fallback;
}

function numberArg(args, name, fallback) {
  const raw = argValue(args, name, "");
  if (raw === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === '"') {
      if (quoted && next === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell);
      if (row.some((value) => value.length > 0)) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    if (row.some((value) => value.length > 0)) rows.push(row);
  }

  if (rows.length === 0) return [];
  const headers = rows[0];
  return rows.slice(1).map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
}

function csvEscape(value) {
  const text = value === undefined || value === null ? "" : String(value);
  if (!/[",\n\r]/.test(text)) return text;
  return `"${text.replaceAll('"', '""')}"`;
}

function rowsToCsv(rows) {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]);
  return [
    headers.join(","),
    ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(",")),
  ].join("\n");
}

function boolValue(value) {
  if (typeof value === "boolean") return value;
  const text = String(value).toLowerCase();
  if (text === "true") return true;
  if (text === "false") return false;
  return false;
}

function numberValue(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value, digits = 4) {
  if (!Number.isFinite(value)) return "";
  return Number(value.toFixed(digits));
}

function mean(values) {
  if (values.length === 0) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function rmse(errors) {
  if (errors.length === 0) return 0;
  return Math.sqrt(mean(errors.map((value) => value * value)));
}

function groupBy(rows, keyFn) {
  const map = new Map();
  rows.forEach((row) => {
    const key = keyFn(row);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  });
  return map;
}

function indexBy(rows, keyFn) {
  const map = new Map();
  rows.forEach((row) => map.set(keyFn(row), row));
  return map;
}

function requireFile(path, label) {
  if (!existsSync(path)) throw new Error(`${label} not found: ${path}`);
}

async function readCsv(path) {
  return parseCsv(await readFile(path, "utf8"));
}

function multiplyMatrixVector(matrix, vector) {
  return matrix.map((row) => row.reduce((total, value, index) => total + value * vector[index], 0));
}

function dot(left, right) {
  return left.reduce((total, value, index) => total + value * right[index], 0);
}

function norm(vector) {
  return Math.sqrt(dot(vector, vector));
}

function topEigenvectorsSymmetric(matrix, rank) {
  const size = matrix.length;
  if (size === 0) return [];
  const working = matrix.map((row) => [...row]);
  const vectors = [];

  for (let component = 0; component < Math.min(rank, size); component += 1) {
    let vector = Array.from({ length: size }, (_, index) => Math.sin((index + 1) * (component + 1.37)));
    let vectorNorm = norm(vector) || 1;
    vector = vector.map((value) => value / vectorNorm);

    for (let iteration = 0; iteration < 80; iteration += 1) {
      let next = multiplyMatrixVector(working, vector);
      vectors.forEach((old) => {
        const projection = dot(next, old.vector);
        next = next.map((value, index) => value - projection * old.vector[index]);
      });
      vectorNorm = norm(next);
      if (vectorNorm < 1e-10) break;
      vector = next.map((value) => value / vectorNorm);
    }

    const mv = multiplyMatrixVector(working, vector);
    const eigenvalue = dot(vector, mv);
    if (!Number.isFinite(eigenvalue) || eigenvalue <= 1e-8) break;
    vectors.push({ vector, eigenvalue });

    for (let row = 0; row < size; row += 1) {
      for (let col = 0; col < size; col += 1) {
        working[row][col] -= eigenvalue * vector[row] * vector[col];
      }
    }
  }

  return vectors;
}

function lowRankApprox(matrix, activeMask, rank) {
  const rows = matrix.length;
  const cols = rows ? matrix[0].length : 0;
  const covariance = Array.from({ length: cols }, () => Array.from({ length: cols }, () => 0));

  for (let row = 0; row < rows; row += 1) {
    for (let left = 0; left < cols; left += 1) {
      if (!activeMask[row][left]) continue;
      for (let right = left; right < cols; right += 1) {
        if (!activeMask[row][right]) continue;
        covariance[left][right] += matrix[row][left] * matrix[row][right];
      }
    }
  }
  for (let left = 0; left < cols; left += 1) {
    for (let right = 0; right < left; right += 1) {
      covariance[left][right] = covariance[right][left];
    }
  }

  const components = topEigenvectorsSymmetric(covariance, rank);
  if (components.length === 0) return matrix.map((row) => [...row]);

  return matrix.map((row, rowIndex) => {
    const output = Array.from({ length: cols }, () => 0);
    components.forEach(({ vector }) => {
      let projection = 0;
      for (let col = 0; col < cols; col += 1) {
        if (activeMask[rowIndex][col]) projection += row[col] * vector[col];
      }
      for (let col = 0; col < cols; col += 1) {
        output[col] += projection * vector[col];
      }
    });
    return output;
  });
}

function completeMetricMatrix({ metric, linkIds, sliceIndexes, truthByKey, observedByKey, rank, iterations }) {
  const activeMask = linkIds.map((linkId) =>
    sliceIndexes.map((sliceIndex) => boolValue(truthByKey.get(`${sliceIndex}|${linkId}`)?.is_active)),
  );
  const observedMask = linkIds.map((linkId) =>
    sliceIndexes.map((sliceIndex) => boolValue(observedByKey.get(`${sliceIndex}|${linkId}`)?.observed)),
  );

  const observedValues = [];
  linkIds.forEach((linkId) => {
    sliceIndexes.forEach((sliceIndex) => {
      const observed = observedByKey.get(`${sliceIndex}|${linkId}`);
      const value = metric.observedValue(observed);
      if (boolValue(observed?.observed) && Number.isFinite(value)) observedValues.push(value);
    });
  });

  if (observedValues.length === 0) {
    return {
      metric: metric.name,
      estimates: new Map(),
      confidence: new Map(),
      summary: {
        metric: metric.name,
        observed_values: 0,
        completed_values: 0,
        global_mean: "",
        global_std: "",
      },
    };
  }

  const globalMean = mean(observedValues);
  const globalStd = Math.sqrt(mean(observedValues.map((value) => (value - globalMean) ** 2))) || 1;
  const cols = sliceIndexes.length;
  const columnSums = Array.from({ length: cols }, () => 0);
  const columnCounts = Array.from({ length: cols }, () => 0);
  const rowSums = Array.from({ length: linkIds.length }, () => 0);
  const rowCounts = Array.from({ length: linkIds.length }, () => 0);

  linkIds.forEach((linkId, rowIndex) => {
    sliceIndexes.forEach((sliceIndex, colIndex) => {
      const observed = observedByKey.get(`${sliceIndex}|${linkId}`);
      const value = metric.observedValue(observed);
      if (observedMask[rowIndex][colIndex] && Number.isFinite(value)) {
        const normalized = (value - globalMean) / globalStd;
        rowSums[rowIndex] += normalized;
        rowCounts[rowIndex] += 1;
        columnSums[colIndex] += normalized;
        columnCounts[colIndex] += 1;
      }
    });
  });

  const matrix = linkIds.map((linkId, rowIndex) =>
    sliceIndexes.map((sliceIndex, colIndex) => {
      if (!activeMask[rowIndex][colIndex]) return 0;
      const observed = observedByKey.get(`${sliceIndex}|${linkId}`);
      const value = metric.observedValue(observed);
      if (observedMask[rowIndex][colIndex] && Number.isFinite(value)) return (value - globalMean) / globalStd;
      if (rowCounts[rowIndex] > 0) return rowSums[rowIndex] / rowCounts[rowIndex];
      if (columnCounts[colIndex] > 0) return columnSums[colIndex] / columnCounts[colIndex];
      return 0;
    }),
  );

  let completed = matrix.map((row) => [...row]);
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    completed = lowRankApprox(completed, activeMask, rank);
    linkIds.forEach((linkId, rowIndex) => {
      sliceIndexes.forEach((sliceIndex, colIndex) => {
        if (!activeMask[rowIndex][colIndex]) {
          completed[rowIndex][colIndex] = 0;
          return;
        }
        if (observedMask[rowIndex][colIndex]) {
          completed[rowIndex][colIndex] = matrix[rowIndex][colIndex];
        }
      });
    });
  }

  const estimates = new Map();
  const confidence = new Map();
  let completedValues = 0;
  linkIds.forEach((linkId, rowIndex) => {
    sliceIndexes.forEach((sliceIndex, colIndex) => {
      if (!activeMask[rowIndex][colIndex]) return;
      const key = `${sliceIndex}|${linkId}`;
      const denormalized = completed[rowIndex][colIndex] * globalStd + globalMean;
      estimates.set(key, metric.clamp(denormalized));
      const rowDensity = rowCounts[rowIndex] / Math.max(sliceIndexes.length, 1);
      const columnDensity = columnCounts[colIndex] / Math.max(linkIds.length, 1);
      const activeDensity = activeMask[rowIndex].filter(Boolean).length / Math.max(sliceIndexes.length, 1);
      const value = Math.max(0.05, Math.min(0.95, 0.25 + 0.45 * rowDensity + 0.25 * columnDensity + 0.05 * activeDensity));
      confidence.set(key, value);
      completedValues += 1;
    });
  });

  return {
    metric: metric.name,
    estimates,
    confidence,
    summary: {
      metric: metric.name,
      observed_values: observedValues.length,
      completed_values: completedValues,
      global_mean: round(globalMean),
      global_std: round(globalStd),
    },
  };
}

function metricDefinitions() {
  return [
    {
      name: "utilization_percent",
      observedValue: (row) => (row ? numberValue(row.utilization_percent_estimate, NaN) : NaN),
      truthValue: (row) => numberValue(row.utilization_percent, NaN),
      clamp: (value) => Math.max(0, Math.min(100, value)),
    },
    {
      name: "latency_ms",
      observedValue: (row) => (row ? numberValue(row.latency_ms_estimate, NaN) : NaN),
      truthValue: (row) => numberValue(row.latency_ms, NaN),
      clamp: (value) => Math.max(0, value),
    },
    {
      name: "capacity_mbps",
      observedValue: (row) => (row ? numberValue(row.capacity_mbps_estimate, NaN) : NaN),
      truthValue: (row) => numberValue(row.effective_capacity_mbps || row.capacity_mbps, NaN),
      clamp: (value) => Math.max(0, value),
    },
    {
      name: "congestion_percent",
      observedValue: (row) => (row ? numberValue(row.congestion_percent_estimate, NaN) : NaN),
      truthValue: (row) => numberValue(row.congestion_percent, NaN),
      clamp: (value) => Math.max(0, Math.min(100, value)),
    },
  ];
}

function statusFromEstimate({ active, utilization, congestion, capacity }) {
  if (!active) return "down";
  if (capacity <= 0) return "down";
  if (congestion > 0 || utilization >= 85) return "warning";
  return "up";
}

function evaluate(reconstructionRows, truthByKey, metrics) {
  const activeRows = reconstructionRows.filter((row) => row.contact_state === "active");
  const observedRows = reconstructionRows.filter((row) => row.observation_source === "observed");
  const inferredRows = reconstructionRows.filter((row) => row.observation_source === "inferred");
  const topologyDownRows = reconstructionRows.filter((row) => row.observation_source === "topology-down");
  let statusMatches = 0;

  reconstructionRows.forEach((row) => {
    const truth = truthByKey.get(`${row.slice_index}|${row.link_id}`);
    if (truth && row.status_estimate === truth.status) statusMatches += 1;
  });

  const metricReports = {};
  metrics.forEach((metric) => {
    const allErrors = [];
    const inferredErrors = [];
    const truthValues = [];
    reconstructionRows.forEach((row) => {
      if (row.contact_state !== "active") return;
      const truth = truthByKey.get(`${row.slice_index}|${row.link_id}`);
      if (!truth) return;
      const estimate = numberValue(row[`${metric.name}_estimate`], NaN);
      const actual = metric.truthValue(truth);
      if (!Number.isFinite(estimate) || !Number.isFinite(actual)) return;
      const error = estimate - actual;
      allErrors.push(error);
      truthValues.push(actual);
      if (row.observation_source === "inferred") inferredErrors.push(error);
    });
    const denom = mean(truthValues.map((value) => value * value)) || 1;
    metricReports[metric.name] = {
      mae: round(mean(allErrors.map((value) => Math.abs(value)))),
      rmse: round(rmse(allErrors)),
      nmse: round(mean(allErrors.map((value) => value * value)) / denom),
      inferred_mae: round(mean(inferredErrors.map((value) => Math.abs(value)))),
      inferred_rmse: round(rmse(inferredErrors)),
      inferred_samples: inferredErrors.length,
    };
  });

  return {
    schema_version: "stage2-leo-int-mc-evaluation-v1",
    generated_at: new Date().toISOString(),
    reconstruction: {
      link_samples: reconstructionRows.length,
      active_link_samples: activeRows.length,
      observed_link_samples: observedRows.length,
      inferred_link_samples: inferredRows.length,
      topology_down_link_samples: topologyDownRows.length,
      unknown_link_samples: reconstructionRows.filter((row) => row.observation_source === "unknown").length,
      active_link_completion_coverage: round((observedRows.length + inferredRows.length) / Math.max(activeRows.length, 1)),
      direct_observation_rate_on_active: round(observedRows.length / Math.max(activeRows.length, 1)),
      inferred_rate_on_active: round(inferredRows.length / Math.max(activeRows.length, 1)),
      status_accuracy_all_links: round(statusMatches / Math.max(reconstructionRows.length, 1)),
    },
    metrics: metricReports,
  };
}

const args = process.argv.slice(2);
const inputDir = resolve(argValue(args, "--input", "exports/tmp-highload-check"));
const stage2Dir = resolve(argValue(args, "--stage2", `stage2-int/outputs/${basename(inputDir)}`));
const algorithm = argValue(args, "--algorithm", "int-mc");
const groundDir = resolve(argValue(args, "--ground", join(stage2Dir, `ground-probe-${algorithm}`)));
const outputDir = resolve(argValue(args, "--out", groundDir));
const rank = numberArg(args, "--rank", 5);
const iterations = numberArg(args, "--iterations", 12);
const windowSize = numberArg(args, "--window-size", 12);

const linksPath = resolve(argValue(args, "--links", join(inputDir, "links.csv")));
const groundLinksPath = resolve(argValue(args, "--ground-links", join(groundDir, "ground-reconstructed-links.csv")));

requireFile(linksPath, "links.csv");
requireFile(groundLinksPath, "ground reconstructed links");

const [truthLinks, observedLinks] = await Promise.all([readCsv(linksPath), readCsv(groundLinksPath)]);
const truthByKey = indexBy(truthLinks, (link) => `${link.slice_index}|${link.link_id}`);
const observedByKey = indexBy(observedLinks, (link) => `${link.slice_index}|${link.link_id}`);
const sliceIndexes = [...new Set(truthLinks.map((link) => String(link.slice_index)))].sort((left, right) => Number(left) - Number(right));
const linkIds = [...new Set(truthLinks.map((link) => link.link_id))].sort();
const firstTruthByLink = indexBy(truthLinks, (link) => link.link_id);
const metrics = metricDefinitions();
const completedByMetric = new Map();
const matrixSummaries = [];

metrics.forEach((metric) => {
  const completed = completeMetricMatrix({
    metric,
    linkIds,
    sliceIndexes,
    truthByKey,
    observedByKey,
    rank,
    iterations,
  });
  completedByMetric.set(metric.name, completed);
  matrixSummaries.push(completed.summary);
});

const reconstructionRows = [];
const errorRows = [];

sliceIndexes.forEach((sliceIndex) => {
  linkIds.forEach((linkId) => {
    const truth = truthByKey.get(`${sliceIndex}|${linkId}`);
    if (!truth) return;
    const observed = observedByKey.get(`${sliceIndex}|${linkId}`);
    const contactActive = boolValue(truth.is_active);
    const directlyObserved = boolValue(observed?.observed);
    const catalog = firstTruthByLink.get(linkId) ?? truth;
    const key = `${sliceIndex}|${linkId}`;
    const source = !contactActive ? "topology-down" : directlyObserved ? "observed" : "inferred";

    const estimates = {};
    const confidences = [];
    metrics.forEach((metric) => {
      const completed = completedByMetric.get(metric.name);
      if (!contactActive) {
        estimates[metric.name] = "";
      } else if (directlyObserved) {
        estimates[metric.name] = round(metric.observedValue(observed));
        confidences.push(1);
      } else {
        const value = completed.estimates.get(key);
        estimates[metric.name] = value === undefined ? "" : round(value);
        confidences.push(completed.confidence.get(key) ?? 0.25);
      }
    });

    const confidence = !contactActive ? 1 : directlyObserved ? 1 : round(mean(confidences));
    const statusEstimate = directlyObserved
      ? observed.status_estimate
      : statusFromEstimate({
          active: contactActive,
          utilization: numberValue(estimates.utilization_percent),
          congestion: numberValue(estimates.congestion_percent),
          capacity: numberValue(estimates.capacity_mbps),
        });

    const row = {
      slice_index: Number(sliceIndex),
      time: truth.time,
      link_id: linkId,
      source: catalog.source,
      target: catalog.target,
      kind: catalog.kind,
      contact_state: contactActive ? "active" : "topology-down",
      observation_source: source,
      observed: directlyObserved,
      inferred: source === "inferred",
      topology_down: source === "topology-down",
      last_observed_slice: directlyObserved ? observed.last_observed_slice : "",
      status_estimate: statusEstimate,
      active_estimate: contactActive,
      utilization_percent_estimate: estimates.utilization_percent,
      latency_ms_estimate: estimates.latency_ms,
      capacity_mbps_estimate: estimates.capacity_mbps,
      congestion_percent_estimate: estimates.congestion_percent,
      confidence,
      int_mc_rank: rank,
      int_mc_iterations: iterations,
      int_mc_window_size: windowSize,
      active_mask_source: "leo-contact-plan",
    };
    reconstructionRows.push(row);

    if (contactActive) {
      errorRows.push({
        slice_index: Number(sliceIndex),
        link_id: linkId,
        observation_source: source,
        truth_status: truth.status,
        status_estimate: statusEstimate,
        truth_utilization_percent: round(numberValue(truth.utilization_percent)),
        utilization_percent_estimate: row.utilization_percent_estimate,
        utilization_error: round(numberValue(row.utilization_percent_estimate) - numberValue(truth.utilization_percent)),
        truth_latency_ms: round(numberValue(truth.latency_ms)),
        latency_ms_estimate: row.latency_ms_estimate,
        latency_error_ms: round(numberValue(row.latency_ms_estimate) - numberValue(truth.latency_ms)),
        truth_capacity_mbps: round(numberValue(truth.effective_capacity_mbps || truth.capacity_mbps)),
        capacity_mbps_estimate: row.capacity_mbps_estimate,
        capacity_error_mbps: round(numberValue(row.capacity_mbps_estimate) - numberValue(truth.effective_capacity_mbps || truth.capacity_mbps)),
        truth_congestion_percent: round(numberValue(truth.congestion_percent)),
        congestion_percent_estimate: row.congestion_percent_estimate,
        congestion_error: round(numberValue(row.congestion_percent_estimate) - numberValue(truth.congestion_percent)),
      });
    }
  });
});

const evaluation = {
  ...evaluate(reconstructionRows, truthByKey, metrics),
  source: {
    input_dir: inputDir,
    stage2_dir: stage2Dir,
    ground_oam_dir: groundDir,
    truth_links_csv: linksPath,
    observed_ground_links_csv: groundLinksPath,
  },
  boundary: {
    matrix_completion_runs_at_ground_oam: true,
    satellites_run_no_matrix_completion: true,
    active_mask_from_predicted_contact_plan: true,
    observed_mask_from_delivered_int_reports: true,
    truth_metrics_used_only_for_evaluation: true,
    topology_down_not_completed: true,
  },
  parameters: {
    algorithm,
    rank,
    iterations,
    window_size: windowSize,
    metrics: metrics.map((metric) => metric.name),
  },
  matrix_summaries: matrixSummaries,
};

await mkdir(outputDir, { recursive: true });
await Promise.all([
  writeFile(join(outputDir, "ground-mc-reconstructed-links.csv"), rowsToCsv(reconstructionRows), "utf8"),
  writeFile(join(outputDir, "int-mc-link-errors.csv"), rowsToCsv(errorRows), "utf8"),
  writeFile(join(outputDir, "int-mc-matrix-summary.csv"), rowsToCsv(matrixSummaries), "utf8"),
  writeFile(join(outputDir, "int-mc-evaluation.json"), JSON.stringify(evaluation, null, 2), "utf8"),
]);

console.log(JSON.stringify({
  ok: true,
  outputDir,
  algorithm,
  rank,
  iterations,
  linkSamples: evaluation.reconstruction.link_samples,
  activeLinkSamples: evaluation.reconstruction.active_link_samples,
  observedLinkSamples: evaluation.reconstruction.observed_link_samples,
  inferredLinkSamples: evaluation.reconstruction.inferred_link_samples,
  activeLinkCompletionCoverage: evaluation.reconstruction.active_link_completion_coverage,
  statusAccuracyAllLinks: evaluation.reconstruction.status_accuracy_all_links,
}, null, 2));

