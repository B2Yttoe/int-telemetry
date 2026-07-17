import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { createHash } from "node:crypto";

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
  if (!Number.isFinite(value)) return 0;
  return Number(value.toFixed(digits));
}

function mean(values) {
  if (values.length === 0) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function minFinite(values, fallback = 0) {
  let result = Infinity;
  for (const value of values) {
    if (Number.isFinite(value) && value < result) result = value;
  }
  return result === Infinity ? fallback : result;
}

function maxFinite(values, fallback = 0) {
  let result = -Infinity;
  for (const value of values) {
    if (Number.isFinite(value) && value > result) result = value;
  }
  return result === -Infinity ? fallback : result;
}

function percentile(values, q) {
  const usable = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (usable.length === 0) return NaN;
  const position = clamp(q, 0, 1) * (usable.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return usable[lower];
  return usable[lower] + (usable[upper] - usable[lower]) * (position - lower);
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

function requireFile(path, label) {
  if (!existsSync(path)) throw new Error(`${label} not found: ${path}`);
}

async function readCsv(path) {
  return parseCsv(await readFile(path, "utf8"));
}

async function readJsonIfExists(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(await readFile(path, "utf8"));
}

function hashText(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function probabilityFromMargin(value, threshold, warningMarginRatio = 0.12) {
  if (!Number.isFinite(value) || !Number.isFinite(threshold) || threshold <= 0) return 0.75;
  const margin = threshold - value;
  if (margin >= threshold * warningMarginRatio) return 0.98;
  if (margin >= 0) return clamp(0.55 + 0.43 * (margin / Math.max(threshold * warningMarginRatio, 1e-6)), 0.55, 0.98);
  return clamp(0.5 * Math.exp(margin / Math.max(threshold * warningMarginRatio, 1e-6)), 0.02, 0.5);
}

function probabilityFromLowerBound(value, threshold, warningMargin = 4) {
  if (!Number.isFinite(value) || !Number.isFinite(threshold)) return 0.75;
  if (value >= threshold + warningMargin) return 0.98;
  if (value >= threshold) return clamp(0.55 + 0.43 * ((value - threshold) / Math.max(warningMargin, 1e-6)), 0.55, 0.98);
  return clamp(0.5 * Math.exp((value - threshold) / Math.max(warningMargin, 1e-6)), 0.02, 0.5);
}

function jaccard(left, right) {
  if (left.size === 0 && right.size === 0) return 1;
  let intersection = 0;
  for (const item of left) {
    if (right.has(item)) intersection += 1;
  }
  return intersection / Math.max(left.size + right.size - intersection, 1);
}

function deriveStepMinutes(rows) {
  const minutes = [...new Set(rows.map((row) => numberValue(row.minute, NaN)).filter(Number.isFinite))]
    .sort((left, right) => left - right);
  if (minutes.length >= 2) return Math.max(1, minutes[1] - minutes[0]);
  const times = [...new Set(rows.map((row) => Date.parse(row.time)).filter(Number.isFinite))]
    .sort((left, right) => left - right);
  if (times.length >= 2) return Math.max(1, (times[1] - times[0]) / 60000);
  return 5;
}

function orbitalPeriodMinutes(altitudeKm) {
  const earthRadiusKm = 6371;
  const mu = 398600.4418;
  const semiMajorAxis = earthRadiusKm + Math.max(altitudeKm, 160);
  return (2 * Math.PI * Math.sqrt((semiMajorAxis ** 3) / mu)) / 60;
}

function deriveEngineeringParameters({ links, nodes, metadata, args }) {
  const sliceCount = numberValue(metadata?.slice_count, new Set(links.map((row) => row.slice_index)).size);
  const stepMinutes = deriveStepMinutes(links);
  const firstSlice = String(minFinite(links.map((row) => numberValue(row.slice_index)), 0));
  const firstSliceNodes = nodes.filter((node) => String(node.slice_index) === firstSlice);
  const altitudeFromNodes = mean(firstSliceNodes.map((node) => numberValue(node.altitude_km, NaN)).filter(Number.isFinite));
  const altitudeFromMetadata = numberValue(metadata?.tle_snapshot_mean_altitude_km, NaN);
  const representativeAltitudeKm = Number.isFinite(altitudeFromMetadata)
    ? altitudeFromMetadata
    : Number.isFinite(altitudeFromNodes)
      ? altitudeFromNodes
      : 550;
  const orbitPeriod = orbitalPeriodMinutes(representativeAltitudeKm);
  const orbitalWindowSlices = clamp(Math.round(orbitPeriod / Math.max(stepMinutes, 1)), 12, Math.max(12, sliceCount));
  const refreshSlicesDefault = Math.max(1, Math.round(30 / Math.max(stepMinutes, 1)));
  const horizonSlicesDefault = Math.min(sliceCount, Math.max(orbitalWindowSlices * 2, refreshSlicesDefault));
  const activeLinks = links.filter((link) => boolValue(link.is_active));
  const activeIslLinks = activeLinks.filter((link) => link.kind !== "star-ground");
  const activeInterPlaneLinks = activeLinks.filter((link) => link.kind === "inter-plane");
  const activeSglLinks = activeLinks.filter((link) => link.kind === "star-ground");
  const activeIslCapacities = activeIslLinks.map((link) => numberValue(link.capacity_mbps, NaN));
  const activeSglCapacities = activeSglLinks.map((link) => numberValue(link.capacity_mbps, NaN));
  const activeIslSnr = activeIslLinks.map((link) => numberValue(link.sinr_db || link.snr_db, NaN));
  const activeSglSnr = activeSglLinks.map((link) => numberValue(link.sinr_db || link.snr_db, NaN));
  const activeIslDistances = activeIslLinks.map((link) => numberValue(link.distance_km, NaN));
  const activeInterPlaneDistances = activeInterPlaneLinks.map((link) => numberValue(link.distance_km, NaN));
  const autoInterPlaneMaxDistanceKm = Math.max(3600, numberValue(percentile(activeInterPlaneDistances, 0.98) * 1.05, 3600));
  const autoIslMaxRangeKm = Math.max(autoInterPlaneMaxDistanceKm, numberValue(percentile(activeIslDistances, 0.98) * 1.05, 6500));
  const autoMinIslCapacityMbps = Math.max(1, numberValue(percentile(activeIslCapacities, 0.05) * 0.9, 100));
  const autoMinSglCapacityMbps = Math.max(0.5, numberValue(percentile(activeSglCapacities, 0.05) * 0.9, 50));
  const autoMinIslSnrDb = numberValue(percentile(activeIslSnr, 0.05) - 1, 6);
  const autoMinSglSnrDb = numberValue(percentile(activeSglSnr, 0.05) - 1, 5);

  return {
    slice_count: sliceCount,
    step_minutes: round(stepMinutes, 3),
    representative_altitude_km: round(representativeAltitudeKm, 3),
    estimated_orbital_period_minutes: round(orbitPeriod, 3),
    prediction_horizon_slices: numberArg(args, "--horizon-slices", horizonSlicesDefault),
    refresh_slices: numberArg(args, "--refresh-slices", refreshSlicesDefault),
    completion_window_slices: numberArg(args, "--completion-window-slices", orbitalWindowSlices),
    topology_class_threshold: numberArg(args, "--topology-class-threshold", 0.08),
    active_probability_threshold: numberArg(args, "--active-probability-threshold", 0.5),
    inter_plane_max_distance_km: numberArg(args, "--inter-plane-max-distance-km", autoInterPlaneMaxDistanceKm),
    isl_antenna_max_range_km: numberArg(args, "--isl-antenna-max-range-km", autoIslMaxRangeKm),
    sgl_antenna_max_range_km: numberArg(args, "--sgl-antenna-max-range-km", 4200),
    min_isl_capacity_mbps: numberArg(args, "--min-isl-capacity-mbps", autoMinIslCapacityMbps),
    min_sgl_capacity_mbps: numberArg(args, "--min-sgl-capacity-mbps", autoMinSglCapacityMbps),
    min_isl_snr_db: numberArg(args, "--min-isl-snr-db", autoMinIslSnrDb),
    min_sgl_snr_db: numberArg(args, "--min-sgl-snr-db", autoMinSglSnrDb),
    min_availability_factor: numberArg(args, "--min-availability-factor", 0.85),
  };
}

function distanceThresholdFor(link, params) {
  if (link.kind === "inter-plane") return Math.min(params.inter_plane_max_distance_km, params.isl_antenna_max_range_km);
  if (link.kind === "star-ground") return params.sgl_antenna_max_range_km;
  return params.isl_antenna_max_range_km;
}

function minCapacityFor(link, params) {
  return link.kind === "star-ground" ? params.min_sgl_capacity_mbps : params.min_isl_capacity_mbps;
}

function minSnrFor(link, params) {
  return link.kind === "star-ground" ? params.min_sgl_snr_db : params.min_isl_snr_db;
}

function predictLink(link, params) {
  const designCandidate = boolValue(link.design_candidate) || link.design_candidate === "";
  const lineOfSight = boolValue(link.line_of_sight);
  const distanceKm = numberValue(link.distance_km, NaN);
  const distanceThreshold = distanceThresholdFor(link, params);
  const capacity = numberValue(link.capacity_mbps || link.effective_capacity_mbps, NaN);
  const snr = numberValue(link.sinr_db || link.snr_db, NaN);
  const availabilityFactor = numberValue(link.availability_factor, 1);
  const solarBlocked = boolValue(link.solar_interference_blocked);
  const exportedRestriction = String(link.restriction_reason || "");

  const pDistance = probabilityFromMargin(distanceKm, distanceThreshold);
  const pLineOfSight = lineOfSight ? 0.99 : 0.03;
  const pCapacity = probabilityFromLowerBound(capacity, minCapacityFor(link, params), minCapacityFor(link, params) * 0.25);
  const pSnr = probabilityFromLowerBound(snr, minSnrFor(link, params), 4);
  const pPointing = probabilityFromLowerBound(availabilityFactor, params.min_availability_factor, 0.08);
  const pSolar = solarBlocked ? 0.02 : 0.98;
  const pRestriction = exportedRestriction ? 0.05 : 0.98;
  const pAvailable = designCandidate
    ? Math.min(pDistance, pLineOfSight, pCapacity, pSnr, pPointing, pSolar, pRestriction)
    : 0.01;

  let predictedReason = "";
  if (!designCandidate) predictedReason = "not-design-candidate";
  else if (!lineOfSight) predictedReason = "earth-occlusion";
  else if (Number.isFinite(distanceKm) && distanceKm > distanceThreshold) predictedReason = link.kind === "inter-plane" ? "distance-threshold" : "antenna-range";
  else if (exportedRestriction) predictedReason = exportedRestriction;
  else if (Number.isFinite(capacity) && capacity < minCapacityFor(link, params)) predictedReason = "capacity-threshold";
  else if (Number.isFinite(snr) && snr < minSnrFor(link, params)) predictedReason = "snr-threshold";
  else if (availabilityFactor < params.min_availability_factor) predictedReason = "pointing-switch";
  else if (solarBlocked) predictedReason = "solar-interference";

  const hardDown = Boolean(predictedReason);
  const predictedActive = !hardDown && pAvailable >= params.active_probability_threshold;
  return {
    predicted_active: predictedActive,
    p_available: round(pAvailable, 5),
    confidence: round(Math.abs(pAvailable - 0.5) * 2, 5),
    predicted_reason: predictedActive ? "" : predictedReason || "probability-threshold",
    distance_threshold_km: distanceThreshold,
  };
}

function buildTopologyClasses(rows, threshold) {
  const bySlice = groupBy(rows, (row) => String(row.slice_index));
  const classes = [];
  const sliceRows = [];
  [...bySlice.keys()].sort((left, right) => Number(left) - Number(right)).forEach((sliceIndex) => {
    const entries = bySlice.get(sliceIndex) ?? [];
    const activeSet = new Set(entries.filter((row) => boolValue(row.predicted_active)).map((row) => row.link_id));
    const signature = hashText([...activeSet].sort().join("|"));
    let item = classes.find((candidate) => 1 - jaccard(candidate.prototypeActiveSet, activeSet) <= threshold);
    if (!item) {
      item = {
        class_id: `TC-${String(classes.length + 1).padStart(3, "0")}`,
        prototype_signature: signature,
        prototypeActiveSet: new Set(activeSet),
        slices: [],
      };
      classes.push(item);
    }
    item.slices.push(Number(sliceIndex));
    sliceRows.push({
      slice_index: Number(sliceIndex),
      time: entries[0]?.time ?? "",
      topology_class_id: item.class_id,
      predicted_active_links: activeSet.size,
      predicted_active_intra_links: entries.filter((row) => row.kind === "intra-plane" && boolValue(row.predicted_active)).length,
      predicted_active_inter_links: entries.filter((row) => row.kind === "inter-plane" && boolValue(row.predicted_active)).length,
      truth_active_links: entries.filter((row) => boolValue(row.truth_active)).length,
      signature,
    });
  });
  return {
    per_slice: sliceRows,
    classes: classes.map((item) => ({
      class_id: item.class_id,
      prototype_signature: item.prototype_signature,
      slice_count: item.slices.length,
      slices: item.slices,
      prototype_active_links: item.prototypeActiveSet.size,
    })),
  };
}

function buildPredictionWindows(topology, params) {
  const rows = [...topology.per_slice].sort((left, right) => Number(left.slice_index) - Number(right.slice_index));
  const refreshSlices = Math.max(1, Number(params.refresh_slices) || 1);
  const horizonSlices = Math.max(1, Number(params.prediction_horizon_slices) || rows.length || 1);
  const windows = [];

  for (let startPosition = 0; startPosition < rows.length; startPosition += refreshSlices) {
    const windowRows = rows.slice(startPosition, startPosition + horizonSlices);
    if (windowRows.length === 0) continue;
    const classIds = [...new Set(windowRows.map((row) => row.topology_class_id).filter(Boolean))];
    let classTransitions = 0;
    for (let index = 1; index < windowRows.length; index += 1) {
      if (windowRows[index].topology_class_id !== windowRows[index - 1].topology_class_id) classTransitions += 1;
    }
    const freshClassPlans = classIds.length;
    const reusableSlices = Math.max(0, windowRows.length - freshClassPlans);
    windows.push({
      plan_slice_index: windowRows[0].slice_index,
      plan_time: windowRows[0].time,
      horizon_start_slice: windowRows[0].slice_index,
      horizon_end_slice: windowRows[windowRows.length - 1].slice_index,
      horizon_slices: windowRows.length,
      configured_prediction_horizon_slices: horizonSlices,
      refresh_slices: refreshSlices,
      topology_class_ids: classIds.join(">"),
      topology_class_count: classIds.length,
      class_transitions: classTransitions,
      fresh_class_plans: freshClassPlans,
      reusable_slices: reusableSlices,
      replan_slices: freshClassPlans,
      estimated_reuse_ratio: round(reusableSlices / Math.max(windowRows.length, 1)),
      mean_predicted_active_links: round(mean(windowRows.map((row) => numberValue(row.predicted_active_links)))),
      min_predicted_active_links: minFinite(windowRows.map((row) => numberValue(row.predicted_active_links))),
      max_predicted_active_links: maxFinite(windowRows.map((row) => numberValue(row.predicted_active_links))),
    });
  }

  return windows;
}

function buildTopologyForecastBySlice(rows, topology, params) {
  const bySlice = groupBy(rows, (row) => String(row.slice_index));
  const sliceRows = [...topology.per_slice].sort((left, right) => Number(left.slice_index) - Number(right.slice_index));
  const activeBySlice = new Map(
    sliceRows.map((slice) => [
      String(slice.slice_index),
      new Set((bySlice.get(String(slice.slice_index)) ?? [])
        .filter((row) => boolValue(row.predicted_active))
        .map((row) => row.link_id)),
    ]),
  );
  const horizonSlices = Math.max(1, Number(params.prediction_horizon_slices) || sliceRows.length || 1);
  const similarityThreshold = clamp(1 - Number(params.topology_class_threshold || 0.08), 0.7, 0.99);
  const majorDriftThreshold = Math.max(0.72, similarityThreshold - 0.06);

  return sliceRows.map((slice, position) => {
    const currentSet = activeBySlice.get(String(slice.slice_index)) ?? new Set();
    const futureRows = sliceRows.slice(position, position + horizonSlices);
    const similarities = futureRows.map((future) =>
      jaccard(currentSet, activeBySlice.get(String(future.slice_index)) ?? new Set()),
    );
    const futureOnly = futureRows.slice(1);
    const futureSimilarities = similarities.slice(1);
    let stableWindow = 0;
    for (const value of similarities) {
      if (value >= similarityThreshold) stableWindow += 1;
      else break;
    }
    const nextClassTransition = futureOnly.find((future) => future.topology_class_id !== slice.topology_class_id);
    const nextMajorDrift = futureRows.find((future, index) => index > 0 && similarities[index] < majorDriftThreshold);
    const minSimilarity = similarities.length ? minFinite(similarities, 1) : 1;
    const meanSimilarity = mean(similarities);
    const classTransitionCount = futureOnly.filter((future, index) =>
      future.topology_class_id !== futureRows[index].topology_class_id,
    ).length;
    const driftPressure = clamp(
      (1 - meanSimilarity) * 0.45 +
        (1 - minSimilarity) * 0.35 +
        classTransitionCount / Math.max(futureOnly.length, 1) * 0.2,
      0,
      1,
    );
    const reuseConfidence = clamp(
      (stableWindow / Math.max(futureRows.length, 1)) * 0.45 +
        meanSimilarity * 0.4 +
        (1 - driftPressure) * 0.15,
      0,
      1,
    );
    const hasFutureEvidence = futureOnly.length > 0;
    const recommendedMode = driftPressure >= 0.35 || (hasFutureEvidence && stableWindow <= 1)
      ? "preemptive-replan"
      : reuseConfidence >= 0.82
        ? "reuse-probe-plan"
        : "reuse-with-local-repair";

    return {
      slice_index: slice.slice_index,
      topology_forecast_horizon_slices: futureRows.length,
      topology_forecast_stable_window_slices: stableWindow,
      topology_forecast_next_class_transition_in_slices: nextClassTransition
        ? Number(nextClassTransition.slice_index) - Number(slice.slice_index)
        : "",
      topology_forecast_next_major_drift_in_slices: nextMajorDrift
        ? Number(nextMajorDrift.slice_index) - Number(slice.slice_index)
        : "",
      topology_forecast_mean_active_jaccard: round(meanSimilarity, 5),
      topology_forecast_min_active_jaccard: round(minSimilarity, 5),
      topology_forecast_class_transition_count: classTransitionCount,
      topology_forecast_drift_pressure: round(driftPressure, 5),
      topology_forecast_reuse_confidence: round(reuseConfidence, 5),
      topology_forecast_recommended_plan_mode: recommendedMode,
      topology_forecast_class_sequence: futureRows.map((row) => row.topology_class_id).join(">"),
      topology_forecast_policy: "rolling-active-set-jaccard-and-class-transition",
    };
  });
}

function evaluatePrediction(rows) {
  let tp = 0;
  let tn = 0;
  let fp = 0;
  let fn = 0;
  rows.forEach((row) => {
    const predicted = boolValue(row.predicted_active);
    const truth = boolValue(row.truth_active);
    if (predicted && truth) tp += 1;
    else if (!predicted && !truth) tn += 1;
    else if (predicted && !truth) fp += 1;
    else fn += 1;
  });
  const bySlice = groupBy(rows, (row) => String(row.slice_index));
  const perSlice = [...bySlice.entries()].sort((a, b) => Number(a[0]) - Number(b[0])).map(([sliceIndex, entries]) => {
    const predictedSet = new Set(entries.filter((row) => boolValue(row.predicted_active)).map((row) => row.link_id));
    const truthSet = new Set(entries.filter((row) => boolValue(row.truth_active)).map((row) => row.link_id));
    const editDistance = entries.filter((row) => boolValue(row.predicted_active) !== boolValue(row.truth_active)).length;
    return {
      slice_index: Number(sliceIndex),
      predicted_active_links: predictedSet.size,
      truth_active_links: truthSet.size,
      jaccard_similarity: round(jaccard(predictedSet, truthSet)),
      topology_edit_distance: editDistance,
      false_up: entries.filter((row) => boolValue(row.predicted_active) && !boolValue(row.truth_active)).length,
      false_down: entries.filter((row) => !boolValue(row.predicted_active) && boolValue(row.truth_active)).length,
    };
  });
  return {
    samples: rows.length,
    true_positive: tp,
    true_negative: tn,
    false_up: fp,
    false_down: fn,
    precision: round(tp / Math.max(tp + fp, 1)),
    recall: round(tp / Math.max(tp + fn, 1)),
    accuracy: round((tp + tn) / Math.max(rows.length, 1)),
    mean_slice_jaccard: round(mean(perSlice.map((row) => row.jaccard_similarity))),
    mean_topology_edit_distance: round(mean(perSlice.map((row) => row.topology_edit_distance))),
    per_slice: perSlice,
  };
}

const args = process.argv.slice(2);
const inputDir = resolve(argValue(args, "--input", "exports/tmp-highload-check"));
const outputDir = resolve(argValue(args, "--out", `stage2-int/outputs/${basename(inputDir)}`));
const linksPath = resolve(argValue(args, "--links", join(inputDir, "links.csv")));
const nodesPath = resolve(argValue(args, "--nodes", join(inputDir, "nodes.csv")));
const metadataPath = resolve(argValue(args, "--metadata", join(inputDir, "metadata.json")));

requireFile(linksPath, "links.csv");
requireFile(nodesPath, "nodes.csv");

const [links, nodes, metadata] = await Promise.all([
  readCsv(linksPath),
  readCsv(nodesPath),
  readJsonIfExists(metadataPath),
]);

const params = deriveEngineeringParameters({ links, nodes, metadata, args });
const predictionRows = links.map((link) => {
  const prediction = predictLink(link, params);
  return {
    slice_index: Number(link.slice_index),
    time: link.time,
    minute: numberValue(link.minute),
    link_id: link.link_id,
    source: link.source,
    target: link.target,
    kind: link.kind,
    predicted_active: prediction.predicted_active,
    truth_active: boolValue(link.is_active),
    p_available: prediction.p_available,
    confidence: prediction.confidence,
    predicted_reason: prediction.predicted_reason,
    truth_status: link.status,
    truth_restriction_reason: link.restriction_reason,
    line_of_sight: boolValue(link.line_of_sight),
    distance_km: numberValue(link.distance_km),
    distance_threshold_km: prediction.distance_threshold_km,
    capacity_mbps: numberValue(link.effective_capacity_mbps || link.capacity_mbps),
    sinr_db: numberValue(link.sinr_db || link.snr_db),
    availability_factor: numberValue(link.availability_factor, 1),
  };
});

const topology = buildTopologyClasses(predictionRows, params.topology_class_threshold);
const topologyForecastRows = buildTopologyForecastBySlice(predictionRows, topology, params);
const topologyForecastBySlice = new Map(topologyForecastRows.map((row) => [String(row.slice_index), row]));
const topologyPerSlice = topology.per_slice.map((row) => ({
  ...row,
  ...(topologyForecastBySlice.get(String(row.slice_index)) ?? {}),
}));
topology.per_slice = topologyPerSlice;
const predictionWindows = buildPredictionWindows(topology, params);
const evaluation = evaluatePrediction(predictionRows);
const contactPlan = {
  schema_version: "stage2-predicted-contact-plan-v1",
  generated_at: new Date().toISOString(),
  source: {
    input_dir: inputDir,
    links_csv: linksPath,
    nodes_csv: nodesPath,
    metadata_json: existsSync(metadataPath) ? metadataPath : "",
  },
  prediction_model: {
    name: "leo-rolling-contact-plan",
    execution_location: "ground-oam-planning",
    uses_business_load_state: false,
    uses_truth_for_runtime_state: false,
    fields_used: [
      "slice_index",
      "time",
      "source",
      "target",
      "kind",
      "line_of_sight",
      "distance_km",
      "capacity_mbps",
      "sinr_db",
      "availability_factor",
      "solar_interference_blocked",
      "restriction_reason as deterministic physical constraint label",
    ],
  },
  engineering_parameters: params,
  topology_classes: topology.classes,
  per_slice: topology.per_slice,
  topology_forecast: {
    policy: "rolling-active-set-jaccard-and-class-transition",
    mean_stable_window_slices: round(mean(topologyForecastRows.map((row) => numberValue(row.topology_forecast_stable_window_slices)))),
    mean_drift_pressure: round(mean(topologyForecastRows.map((row) => numberValue(row.topology_forecast_drift_pressure)))),
    preemptive_replan_slices: topologyForecastRows.filter((row) => row.topology_forecast_recommended_plan_mode === "preemptive-replan").length,
    reuse_recommended_slices: topologyForecastRows.filter((row) => row.topology_forecast_recommended_plan_mode === "reuse-probe-plan").length,
  },
  prediction_windows: predictionWindows,
  evaluation,
  entries: predictionRows,
};
const contactPlanMetadata = {
  ...contactPlan,
  entries_csv: join(outputDir, "predicted-contact-plan.csv"),
};
delete contactPlanMetadata.entries;

await mkdir(outputDir, { recursive: true });
// Write the large representations sequentially so their serialization buffers
// do not coexist at the Starlink scale.
await writeFile(join(outputDir, "predicted-contact-plan.json"), JSON.stringify(contactPlan, null, 2), "utf8");
await writeFile(join(outputDir, "predicted-contact-plan.csv"), rowsToCsv(predictionRows), "utf8");
await Promise.all([
  writeFile(join(outputDir, "predicted-contact-plan-metadata.json"), JSON.stringify(contactPlanMetadata, null, 2), "utf8"),
  writeFile(join(outputDir, "predicted-contact-plan-summary.csv"), rowsToCsv(topology.per_slice), "utf8"),
  writeFile(join(outputDir, "predicted-topology-forecast.csv"), rowsToCsv(topologyForecastRows), "utf8"),
  writeFile(join(outputDir, "predicted-contact-plan-windows.csv"), rowsToCsv(predictionWindows), "utf8"),
  writeFile(join(outputDir, "predicted-contact-plan-evaluation.json"), JSON.stringify(evaluation, null, 2), "utf8"),
]);

console.log(JSON.stringify({
  ok: true,
  outputDir,
  predictionHorizonSlices: params.prediction_horizon_slices,
  refreshSlices: params.refresh_slices,
  completionWindowSlices: params.completion_window_slices,
  predictionWindows: predictionWindows.length,
  topologyForecast: contactPlan.topology_forecast,
  stepMinutes: params.step_minutes,
  topologyClasses: topology.classes.length,
  precision: evaluation.precision,
  recall: evaluation.recall,
  accuracy: evaluation.accuracy,
  meanSliceJaccard: evaluation.mean_slice_jaccard,
}, null, 2));
