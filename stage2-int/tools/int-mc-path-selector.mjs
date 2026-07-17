import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { readCsvStream } from "./csv-stream.mjs";
import {
  buildMultiObjectiveBudgetControl,
  multiObjectivePathScore,
} from "./multi-objective-budget-controller.mjs";
import {
  buildObservablePlanningLinks,
  buildObservablePlanningNodes,
  buildObservableOamFeedback,
  buildObservableRoutes,
  scheduleObservableRows,
} from "./int-mc-observability.mjs";
import {
  DEFAULT_TOPOLOGY_VERSIONED_OBJECTIVE_WEIGHTS,
  buildTopologyVersionId,
  chooseConservativeObjectiveCandidate,
  evaluateTopologyVersionedPathObjective,
} from "./topology-versioned-active-telemetry.mjs";
import {
  assessCachedPathImpact,
  buildTopologyVersion,
  chooseTopologyVersionedPlan,
  prefilterTopologyPlanningModes,
  refillCandidatesToFixedBudget,
  selectIncrementalRepairCandidates,
  selectStructuralCacheBase,
} from "./topology-versioned-risk-planner.mjs";
import { buildScaleAdaptiveTelemetryBudget } from "./scale-adaptive-telemetry-budget.mjs";
import {
  attachImportanceAwareMetadataPlans,
  buildRotatingPlaneRepresentatives,
  buildTargetPreservingRepair,
  buildPathMetadataPlan,
  buildImportanceAwareTargetPlan,
  computeBoundedAdditiveRepairPathLimit,
  computeAoIAdjustedPathCount,
  currentSelectionImportanceRepairFields,
  selectBoundedImportanceRepairRows,
  selectBudgetNeutralImportanceReplacements,
  shouldUseAoIDebtOverride,
} from "./importance-aware-telemetry.mjs";

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
  return String(value).toLowerCase() === "true";
}

function numberValue(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function optionalNumber(value) {
  const text = String(value ?? "").trim();
  if (!text) return NaN;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function buildScaleBudgetReference(rows) {
  const budgets = new Map();
  for (const row of rows) {
    const sliceIndex = String(row.slice_index ?? "").trim();
    if (!sliceIndex) throw new Error("scale budget reference row is missing slice_index");
    if (budgets.has(sliceIndex)) {
      throw new Error(`scale budget reference contains duplicate slice_index: ${sliceIndex}`);
    }
    const rawBudget = row.scale_budget_bytes ?? row.budget_bytes;
    const budget = Math.floor(Number(rawBudget));
    if (!Number.isFinite(budget) || budget <= 0) {
      throw new Error(`scale budget reference has an invalid budget for slice ${sliceIndex}: ${rawBudget}`);
    }
    budgets.set(sliceIndex, budget);
  }
  return budgets;
}

function round(value, digits = 4) {
  if (!Number.isFinite(value)) return 0;
  return Number(value.toFixed(digits));
}

function mean(values) {
  if (values.length === 0) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function splitPath(value) {
  return String(value || "")
    .split(/\s+>\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
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

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

const TRUTH_LINK_PLANNER_COLUMNS = [
  "slice_index", "time", "minute", "link_id", "source", "target", "kind",
  "is_active", "p_available", "availability_factor", "design_candidate",
  "line_of_sight", "distance_km", "distance_threshold_km", "capacity_mbps",
  "effective_capacity_mbps", "sinr_db", "snr_db", "solar_interference_blocked",
  "restriction_reason",
];

const TRUTH_NODE_PLANNER_COLUMNS = [
  "slice_index", "time", "minute", "node_id", "label", "plane", "slot",
  "shell_id", "latitude", "longitude", "altitude_km", "x", "y", "z",
  "in_sunlight", "solar_exposure", "solar_power_w", "battery_capacity_wh",
  "min_state_of_charge", "base_power_w",
];

const ROUTE_PLANNER_COLUMNS = [
  "slice_index", "time", "minute", "task_id", "source", "target", "node_id",
  "link_ids", "path", "hop_count", "path_link_count", "status", "traffic_mbps",
  "priority", "created_slice",
];

const PREDICTED_LINK_PLANNER_COLUMNS = [
  "slice_index", "time", "minute", "link_id", "source", "target", "kind",
  "predicted_active", "p_available", "confidence", "predicted_reason",
  "line_of_sight", "distance_km", "distance_threshold_km", "capacity_mbps",
  "sinr_db", "availability_factor",
];

const OAM_LINK_PLANNER_COLUMNS = [
  "slice_index", "link_id", "status_estimate", "confidence", "state_age_slices",
  "last_observed_slice", "confidence_state", "conflict_severity",
  "oam_conflict_severity", "latency_ms_estimate", "queue_latency_ms_estimate",
  "utilization_percent_estimate", "congestion_percent_estimate",
  "queued_traffic_mb_estimate", "dropped_traffic_mb_estimate",
  "packet_error_rate_estimate", "observation_source",
];

const OAM_NODE_PLANNER_COLUMNS = [
  "slice_index", "node_id", "confidence", "state_age_slices", "last_observed_slice",
  "confidence_state", "conflict_severity", "oam_conflict_severity",
  "observation_source", "cpu_percent_estimate", "queue_depth_estimate",
  "queued_traffic_mb_estimate", "cache_used_mb_estimate", "energy_percent_estimate",
  "mode_estimate",
];

async function readPredictedContactPlan(path) {
  const metadataPath = join(resolve(path, ".."), "predicted-contact-plan-metadata.json");
  const entriesPath = join(resolve(path, ".."), "predicted-contact-plan.csv");
  if (!existsSync(metadataPath) || !existsSync(entriesPath)) return readJson(path);
  const [metadata, entries] = await Promise.all([
    readJson(metadataPath),
    readCsvStream(entriesPath, { columns: PREDICTED_LINK_PLANNER_COLUMNS }),
  ]);
  return { ...metadata, entries };
}

function hashText(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function jaccard(left, right) {
  if (left.size === 0 && right.size === 0) return 1;
  let intersection = 0;
  for (const item of left) {
    if (right.has(item)) intersection += 1;
  }
  return intersection / Math.max(left.size + right.size - intersection, 1);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function similarityFromDistance(left, right, scale) {
  if (!Number.isFinite(left) || !Number.isFinite(right)) return 1;
  return clamp(1 - Math.abs(left - right) / Math.max(scale, 1e-6), 0, 1);
}

function deterministicUnitInterval(value) {
  const hex = hashText(value).slice(0, 8);
  return parseInt(hex, 16) / 0xffffffff;
}

function normalizedLinkState(link) {
  return [
    planningActive(link) ? 1 : 0,
    clamp(numberValue(link.utilization_percent) / 100, 0, 1),
    clamp(numberValue(link.congestion_percent) / 100, 0, 1),
    clamp(numberValue(link.latency_ms) / 80, 0, 1),
    clamp(linkAvailability(link), 0, 1),
  ];
}

function linkStateMatrixSimilarity(leftMap, rightMap) {
  const ids = new Set([...leftMap.keys(), ...rightMap.keys()]);
  if (ids.size === 0) return 1;
  const zero = [0, 0, 0, 0, 0];
  const similarities = [...ids].map((linkId) => {
    const left = leftMap.get(linkId) ?? zero;
    const right = rightMap.get(linkId) ?? zero;
    const distance = mean(left.map((value, index) => Math.abs(value - right[index])));
    return clamp(1 - distance, 0, 1);
  });
  return mean(similarities);
}

function sliceTopologyProfile(links, routes = []) {
  const activeLinks = links.filter((link) => planningActive(link));
  const activeSet = new Set(activeLinks.map((link) => link.link_id));
  const interSet = new Set(activeLinks.filter((link) => link.kind === "inter-plane").map((link) => link.link_id));
  const bottleneckSet = new Set(
    activeLinks
      .filter((link) => numberValue(link.utilization_percent) >= 70 || numberValue(link.congestion_percent) > 0)
      .map((link) => link.link_id),
  );
  const meanUtilization = mean(activeLinks.map((link) => numberValue(link.utilization_percent)).filter(Number.isFinite));
  const meanLatency = mean(activeLinks.map((link) => numberValue(link.latency_ms)).filter(Number.isFinite));
  const meanAvailability = mean(activeLinks.map((link) => linkAvailability(link)).filter(Number.isFinite));
  const transitionSensitiveLinks = activeLinks.filter((link) => link.kind === "inter-plane" || linkAvailability(link) < 0.75);
  const linkStateMap = new Map(links.map((link) => [link.link_id, normalizedLinkState(link)]));
  const routedRoutes = routes.filter((route) => String(route.status || "routed") === "routed");
  const routePathSet = new Set(
    routedRoutes.map((route) =>
      String(route.link_ids || route.path || `${route.source || ""}->${route.target || ""}`)
        .replaceAll(" ", "")
        .trim(),
    ).filter(Boolean),
  );
  const meanRouteHops = mean(
    routedRoutes
      .map((route) => numberValue(route.hopCount ?? route.hop_count ?? route.path_link_count, NaN))
      .filter(Number.isFinite),
  );
  const totalRouteTrafficMbps = routedRoutes.reduce((total, route) => total + numberValue(route.carried_traffic_mbps || route.traffic_mbps), 0);

  return {
    activeSet,
    interSet,
    bottleneckSet,
    routePathSet,
    linkStateMap,
    active_count: activeSet.size,
    inter_count: interSet.size,
    bottleneck_count: bottleneckSet.size,
    routed_route_count: routedRoutes.length,
    mean_route_hops: meanRouteHops,
    total_route_traffic_mbps: totalRouteTrafficMbps,
    mean_utilization: meanUtilization,
    mean_latency: meanLatency,
    mean_availability: meanAvailability,
    volatility_hint: transitionSensitiveLinks.length / Math.max(activeLinks.length, 1),
  };
}

function topologySimilarity(left, right) {
  const active = jaccard(left.activeSet, right.activeSet);
  const interPlane = jaccard(left.interSet, right.interSet);
  const bottleneck = left.bottleneckSet.size === 0 && right.bottleneckSet.size === 0
    ? 1
    : jaccard(left.bottleneckSet, right.bottleneckSet);
  const routePath = left.routePathSet.size === 0 && right.routePathSet.size === 0
    ? 1
    : jaccard(left.routePathSet, right.routePathSet);
  const linkState = linkStateMatrixSimilarity(left.linkStateMap, right.linkStateMap);
  const utilization = similarityFromDistance(left.mean_utilization, right.mean_utilization, 35);
  const latency = similarityFromDistance(left.mean_latency, right.mean_latency, 45);
  const availability = similarityFromDistance(left.mean_availability, right.mean_availability, 0.35);
  const legacyCompositeScore =
    0.27 * active +
    0.13 * interPlane +
    0.1 * bottleneck +
    0.12 * routePath +
    0.18 * linkState +
    0.08 * utilization +
    0.06 * latency +
    0.06 * availability;
  const structuralScore = 0.8 * active + 0.2 * interPlane;
  const dynamicScore =
    0.2 * bottleneck +
    0.22 * routePath +
    0.28 * linkState +
    0.12 * utilization +
    0.09 * latency +
    0.09 * availability;
  return {
    score: round(legacyCompositeScore, 5),
    structural_score: round(structuralScore, 5),
    dynamic_score: round(dynamicScore, 5),
    active_jaccard: round(active, 5),
    inter_plane_jaccard: round(interPlane, 5),
    bottleneck_jaccard: round(bottleneck, 5),
    route_path_jaccard: round(routePath, 5),
    link_state_similarity: round(linkState, 5),
    utilization_similarity: round(utilization, 5),
    latency_similarity: round(latency, 5),
    availability_similarity: round(availability, 5),
  };
}

function percentile(values, q) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (sorted.length === 0) return 0;
  const position = clamp(q, 0, 1) * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function thresholdCalibrationDetails({ scoredClasses, profile, futureProfiles, baseThreshold }) {
  const scores = scoredClasses
    .map((item) => item.similarity.structural_score ?? item.similarity.score)
    .filter(Number.isFinite)
    .sort((left, right) => right - left);
  const bestScore = scores[0] ?? 1;
  const secondScore = scores[1] ?? 0;
  const bestSecondGap = scores.length > 1 ? bestScore - secondScore : 1;
  const nearBestClasses = scores.filter((score) => bestScore - score <= 0.035).length;
  const nearThresholdClasses = scores.filter((score) => Math.abs(score - baseThreshold) <= 0.035).length;
  const similarityP50 = percentile(scores, 0.5);
  const similarityP90 = percentile(scores, 0.9);
  const classDensity = scores.length > 0 ? nearThresholdClasses / scores.length : 0;
  const ambiguityPenalty = scores.length > 1
    ? clamp((0.08 - bestSecondGap) * 0.55 + classDensity * 0.03 + Math.max(0, nearBestClasses - 1) * 0.01, 0, 0.075)
    : 0;
  const separationCredit = bestScore >= baseThreshold && bestSecondGap > 0.12
    ? clamp((bestSecondGap - 0.12) * 0.18, 0, 0.045)
    : 0;
  const futureSimilarities = futureProfiles
    .map((futureProfile) => topologySimilarity(profile, futureProfile).structural_score)
    .filter(Number.isFinite);
  const futureMeanSimilarity = mean(futureSimilarities);
  const futureMinSimilarity = futureSimilarities.length ? Math.min(...futureSimilarities) : 1;
  const futureDriftPenalty = futureSimilarities.length
    ? clamp((0.9 - futureMeanSimilarity) * 0.08 + (0.82 - futureMinSimilarity) * 0.05, 0, 0.075)
    : 0;
  const futureStabilityCredit = futureSimilarities.length
    ? clamp((futureMeanSimilarity - 0.95) * 0.12 + (futureMinSimilarity - 0.92) * 0.08, 0, 0.045)
    : 0;
  const evidenceConfidence = clamp(
    Math.min(scores.length, 6) / 6 * 0.55 +
      Math.min(futureSimilarities.length, 4) / 4 * 0.45,
    0,
    1,
  );
  const sampleSupportCredit = evidenceConfidence >= 0.7 && ambiguityPenalty < 0.015 && futureDriftPenalty < 0.015
    ? clamp((evidenceConfidence - 0.7) * 0.06, 0, 0.025)
    : 0;
  const netAdjustment = ambiguityPenalty + futureDriftPenalty - separationCredit - futureStabilityCredit - sampleSupportCredit;

  return {
    evidence_count: scores.length + futureSimilarities.length,
    candidate_class_count: scores.length,
    future_window_slices: futureSimilarities.length,
    best_similarity: round(bestScore, 5),
    second_best_similarity: round(secondScore, 5),
    best_second_gap: round(bestSecondGap, 5),
    near_best_class_count: nearBestClasses,
    near_threshold_class_count: nearThresholdClasses,
    class_density: round(classDensity, 5),
    similarity_p50: round(similarityP50, 5),
    similarity_p90: round(similarityP90, 5),
    future_mean_similarity: round(futureMeanSimilarity, 5),
    future_min_similarity: round(futureMinSimilarity, 5),
    ambiguity_penalty: round(ambiguityPenalty, 5),
    future_drift_penalty: round(futureDriftPenalty, 5),
    separation_credit: round(separationCredit, 5),
    future_stability_credit: round(futureStabilityCredit, 5),
    sample_support_credit: round(sampleSupportCredit, 5),
    evidence_confidence: round(evidenceConfidence, 5),
    net_adjustment: round(netAdjustment, 5),
    policy: "windowed-similarity-distribution-calibration",
  };
}

function topologyForecastDetails({ profile, futureProfiles, similarityThreshold }) {
  const threshold = clamp(similarityThreshold, 0.7, 0.99);
  const similarities = futureProfiles
    .map((futureProfile) => topologySimilarity(profile, futureProfile).structural_score)
    .filter(Number.isFinite);
  let stableWindow = 1;
  for (const value of similarities) {
    if (value >= threshold) stableWindow += 1;
    else break;
  }
  const firstMajorDriftIndex = similarities.findIndex((value) => value < Math.max(0.72, threshold - 0.06));
  const minSimilarity = similarities.length ? Math.min(...similarities) : 1;
  const meanSimilarity = similarities.length ? mean(similarities) : 1;
  const driftCount = similarities.filter((value) => value < threshold).length;
  const driftPressure = clamp(
    (1 - meanSimilarity) * 0.42 +
      (1 - minSimilarity) * 0.36 +
      driftCount / Math.max(similarities.length, 1) * 0.22,
    0,
    1,
  );
  const reuseConfidence = clamp(
    (stableWindow / Math.max(similarities.length + 1, 1)) * 0.42 +
      meanSimilarity * 0.42 +
      (1 - driftPressure) * 0.16,
    0,
    1,
  );
  const hasFutureEvidence = similarities.length > 0;
  const recommendedMode = driftPressure >= 0.35 || (hasFutureEvidence && stableWindow <= 1)
    ? "preemptive-replan"
    : reuseConfidence >= 0.82
      ? "reuse-probe-plan"
      : "reuse-with-local-repair";
  return {
    topology_forecast_horizon_slices: similarities.length + 1,
    topology_forecast_stable_window_slices: stableWindow,
    topology_forecast_next_major_drift_in_slices: firstMajorDriftIndex >= 0 ? firstMajorDriftIndex + 1 : "",
    topology_forecast_mean_similarity: round(meanSimilarity, 5),
    topology_forecast_min_similarity: round(minSimilarity, 5),
    topology_forecast_drift_count: driftCount,
    topology_forecast_drift_pressure: round(driftPressure, 5),
    topology_forecast_reuse_confidence: round(reuseConfidence, 5),
    topology_forecast_recommended_plan_mode: recommendedMode,
    topology_forecast_policy: "rolling-profile-similarity-and-drift-pressure",
  };
}

function adaptiveReuseThresholdDetails({
  baseThreshold,
  profile,
  previousSimilarity,
  overheadPressure,
  oamPressure,
  bestSimilarity,
  calibration,
}) {
  const volatilityPenalty = clamp(profile.volatility_hint * 0.04, 0, 0.06);
  const bottleneckPenalty = clamp((profile.bottleneck_count / Math.max(profile.active_count, 1)) * 0.08, 0, 0.08);
  const loadPenalty = clamp((profile.mean_utilization - 55) / 400, 0, 0.06);
  const contactUncertaintyPenalty = clamp((0.82 - profile.mean_availability) * 0.08, 0, 0.06);
  const structuralDriftPenalty = bestSimilarity
    ? clamp((1 - bestSimilarity.active_jaccard) * 0.05 + (1 - bestSimilarity.inter_plane_jaccard) * 0.03, 0, 0.08)
    : 0;
  const linkStateDriftPenalty = bestSimilarity
    ? clamp((1 - bestSimilarity.link_state_similarity) * 0.06, 0, 0.06)
    : 0;
  const routeDriftPenalty = bestSimilarity
    ? clamp((1 - bestSimilarity.route_path_jaccard) * 0.04, 0, 0.04)
    : 0;
  const oamPressurePenalty = clamp((oamPressure?.pressure ?? 0) * 0.05, 0, 0.05);
  const stabilityCredit = Number.isFinite(previousSimilarity) ? clamp((previousSimilarity - baseThreshold) * 0.08, 0, 0.04) : 0;
  const overheadCredit = clamp(overheadPressure * 0.08, 0, 0.08);
  const thresholdCalibration = calibration ?? thresholdCalibrationDetails({
    scoredClasses: [],
    profile,
    futureProfiles: [],
    baseThreshold,
  });
  const threshold = clamp(
    baseThreshold +
      volatilityPenalty +
      structuralDriftPenalty +
      oamPressurePenalty -
      stabilityCredit -
      overheadCredit +
      thresholdCalibration.net_adjustment,
    0.72,
    0.98,
  );
  const reasons = [
    volatilityPenalty > 0.005 ? "tighten-volatility" : "",
    bottleneckPenalty > 0.005 ? "dynamic-score-bottleneck-risk" : "",
    loadPenalty > 0.005 ? "dynamic-score-load-risk" : "",
    contactUncertaintyPenalty > 0.005 ? "dynamic-score-contact-risk" : "",
    structuralDriftPenalty > 0.005 ? "tighten-structural-drift" : "",
    linkStateDriftPenalty > 0.005 ? "dynamic-score-link-state-drift" : "",
    routeDriftPenalty > 0.005 ? "dynamic-score-route-drift" : "",
    oamPressurePenalty > 0.005 ? "tighten-oam-pressure" : "",
    thresholdCalibration.ambiguity_penalty > 0.005 ? "tighten-calibrated-class-ambiguity" : "",
    thresholdCalibration.future_drift_penalty > 0.005 ? "tighten-calibrated-future-drift" : "",
    stabilityCredit > 0.005 ? "relax-stable-history" : "",
    overheadCredit > 0.005 ? "relax-planning-overhead-pressure" : "",
    thresholdCalibration.separation_credit > 0.005 ? "relax-calibrated-class-separation" : "",
    thresholdCalibration.future_stability_credit > 0.005 ? "relax-calibrated-future-stability" : "",
    thresholdCalibration.sample_support_credit > 0.005 ? "relax-calibrated-sample-support" : "",
  ].filter(Boolean);
  return {
    threshold: round(threshold, 5),
    base_threshold: round(baseThreshold, 5),
    volatility_penalty: round(volatilityPenalty, 5),
    bottleneck_penalty: round(bottleneckPenalty, 5),
    load_penalty: round(loadPenalty, 5),
    contact_uncertainty_penalty: round(contactUncertaintyPenalty, 5),
    structural_drift_penalty: round(structuralDriftPenalty, 5),
    link_state_drift_penalty: round(linkStateDriftPenalty, 5),
    route_drift_penalty: round(routeDriftPenalty, 5),
    oam_pressure_penalty: round(oamPressurePenalty, 5),
    stability_credit: round(stabilityCredit, 5),
    overhead_credit: round(overheadCredit, 5),
    calibration_policy: thresholdCalibration.policy,
    calibration_evidence_count: thresholdCalibration.evidence_count,
    calibration_candidate_class_count: thresholdCalibration.candidate_class_count,
    calibration_future_window_slices: thresholdCalibration.future_window_slices,
    calibration_best_second_gap: thresholdCalibration.best_second_gap,
    calibration_near_best_class_count: thresholdCalibration.near_best_class_count,
    calibration_near_threshold_class_count: thresholdCalibration.near_threshold_class_count,
    calibration_class_density: thresholdCalibration.class_density,
    calibration_similarity_p50: thresholdCalibration.similarity_p50,
    calibration_similarity_p90: thresholdCalibration.similarity_p90,
    calibration_future_mean_similarity: thresholdCalibration.future_mean_similarity,
    calibration_future_min_similarity: thresholdCalibration.future_min_similarity,
    calibration_ambiguity_penalty: thresholdCalibration.ambiguity_penalty,
    calibration_future_drift_penalty: thresholdCalibration.future_drift_penalty,
    calibration_separation_credit: thresholdCalibration.separation_credit,
    calibration_future_stability_credit: thresholdCalibration.future_stability_credit,
    calibration_sample_support_credit: thresholdCalibration.sample_support_credit,
    calibration_evidence_confidence: thresholdCalibration.evidence_confidence,
    calibration_net_adjustment: thresholdCalibration.net_adjustment,
    total_tightening: round(
      volatilityPenalty +
        structuralDriftPenalty +
        oamPressurePenalty +
        thresholdCalibration.ambiguity_penalty +
        thresholdCalibration.future_drift_penalty,
      5,
    ),
    total_relaxation: round(
      stabilityCredit +
        overheadCredit +
        thresholdCalibration.separation_credit +
        thresholdCalibration.future_stability_credit +
        thresholdCalibration.sample_support_credit,
      5,
    ),
    dynamic_score_risk: round(
      bottleneckPenalty + loadPenalty + contactUncertaintyPenalty + linkStateDriftPenalty + routeDriftPenalty,
      5,
    ),
    policy: "structural-cache-threshold-with-dynamic-state-rescoring",
    reason: reasons.length ? reasons.join(" > ") : "base-threshold",
  };
}

function oamSlicePressure(feedback) {
  if (!feedback) {
    return {
      pressure: 0,
      target_count: 0,
      urgent_targets: 0,
      mean_priority_score: 0,
      max_priority_score: 0,
    };
  }
  const targets = [...feedback.nodes.values(), ...feedback.links.values()];
  if (targets.length === 0) {
    return {
      pressure: 0,
      target_count: 0,
      urgent_targets: 0,
      mean_priority_score: 0,
      max_priority_score: 0,
    };
  }
  const scores = targets.map((item) => numberValue(item.priority_score));
  const urgentTargets = targets.filter((item) => {
    const reason = String(item.reason || "");
    return numberValue(item.priority_score) >= 0.9 || /unknown|conflict|warning|congestion|stale/.test(reason);
  }).length;
  const meanPriority = mean(scores);
  const maxPriority = Math.max(...scores);
  const densityPressure = clamp(targets.length / 12, 0, 1);
  const urgencyPressure = urgentTargets / Math.max(targets.length, 1);
  const scorePressure = clamp(meanPriority / 1.4, 0, 1);
  const peakPressure = clamp(maxPriority / 2, 0, 1);
  const pressure = clamp(
    scorePressure * 0.4 +
      densityPressure * 0.25 +
      urgencyPressure * 0.25 +
      peakPressure * 0.1,
    0,
    1,
  );
  return {
    pressure: round(pressure, 5),
    target_count: targets.length,
    urgent_targets: urgentTargets,
    mean_priority_score: round(meanPriority),
    max_priority_score: round(maxPriority),
  };
}

function buildOamControlBySlice(rows) {
  const map = new Map();
  rows.forEach((row) => {
    const currentSliceIndex = String(row.source_slice_index ?? row.slice_index ?? "").trim();
    const nextSliceIndex = String(row.next_slice_index ?? "").trim();
    const sliceIndex = String(row.slice_index ?? nextSliceIndex ?? currentSliceIndex).trim();
    if (!sliceIndex) return;
    map.set(sliceIndex, {
      slice_index: numberValue(row.slice_index),
      control_source_slice_index: currentSliceIndex,
      control_target_slice_index: sliceIndex,
      next_slice_index: nextSliceIndex,
      recommended_action: row.recommended_action || "maintain-current-plan",
      probe_bias: row.probe_bias || "normal-coverage",
      confidence_budget: row.confidence_budget || "healthy",
      oam_control_pressure: clamp(numberValue(row.oam_control_pressure), 0, 1),
      unknown_pressure: clamp(numberValue(row.unknown_pressure), 0, 1),
      stale_pressure: clamp(numberValue(row.stale_pressure), 0, 1),
      prior_estimate_pressure: clamp(numberValue(row.prior_estimate_pressure), 0, 1),
      low_confidence_pressure: clamp(numberValue(row.low_confidence_pressure), 0, 1),
      conflict_pressure: clamp(numberValue(row.conflict_pressure), 0, 1),
      downlink_pressure: clamp(numberValue(row.downlink_pressure), 0, 1),
      retest_pressure: clamp(numberValue(row.retest_pressure), 0, 1),
      coverage_demand_pressure: clamp(numberValue(row.coverage_demand_pressure), 0, 1),
      recommended_sampling_rate: numberValue(row.recommended_sampling_rate, NaN),
      recommended_target_active_link_sampling_rate: numberValue(row.recommended_target_active_link_sampling_rate, NaN),
      recommended_telemetry_byte_budget_per_slice: numberValue(row.recommended_telemetry_byte_budget_per_slice, NaN),
      recommended_downlink_budget_bytes: numberValue(row.recommended_downlink_budget_bytes, NaN),
      budget_recommendation_action: row.budget_recommendation_action || "maintain-nominal-budget",
      budget_recommendation_reason: row.budget_recommendation_reason || "",
      budget_recommendation_source: row.budget_recommendation_source || "",
      priority_retest_targets: numberValue(row.priority_retest_targets),
      top_node_targets: row.top_node_targets || "",
      top_link_targets: row.top_link_targets || "",
      top_retest_reasons: row.top_retest_reasons || "",
    });
  });
  return map;
}

function oamControlForSlice(oamControlBySlice, sliceIndex) {
  return oamControlBySlice?.get(String(sliceIndex)) ?? {
    slice_index: Number(sliceIndex),
    control_source_slice_index: "",
    control_target_slice_index: String(sliceIndex),
    next_slice_index: "",
    recommended_action: "maintain-current-plan",
    probe_bias: "normal-coverage",
    confidence_budget: "healthy",
    oam_control_pressure: 0,
    unknown_pressure: 0,
    stale_pressure: 0,
    prior_estimate_pressure: 0,
    low_confidence_pressure: 0,
    conflict_pressure: 0,
    downlink_pressure: 0,
    retest_pressure: 0,
    coverage_demand_pressure: 0,
    recommended_sampling_rate: NaN,
    recommended_target_active_link_sampling_rate: NaN,
    recommended_telemetry_byte_budget_per_slice: NaN,
    recommended_downlink_budget_bytes: NaN,
    budget_recommendation_action: "maintain-nominal-budget",
    budget_recommendation_reason: "",
    budget_recommendation_source: "",
    priority_retest_targets: 0,
    top_node_targets: "",
    top_link_targets: "",
    top_retest_reasons: "",
  };
}

function isMandatoryOamControl(control) {
  if (!control) return false;
  const action = String(control.recommended_action || "");
  const budget = String(control.confidence_budget || "");
  return action === "refresh-probe-plan" ||
    control.probe_bias === "force-fresh-replan" ||
    budget === "degraded" ||
    budget === "critical" ||
    numberValue(control.oam_control_pressure) >= 0.68 ||
    numberValue(control.unknown_pressure) >= 0.65 ||
    numberValue(control.low_confidence_pressure) >= 0.65 ||
    numberValue(control.conflict_pressure) >= 0.5;
}

function applyOamControlBudget({
  oamControl,
  samplingRate,
  targetActiveLinkSamplingRate,
  telemetryByteBudgetPerSlice,
}) {
  const recommendedSamplingRate = numberValue(oamControl.recommended_sampling_rate, NaN);
  const recommendedTargetRate = numberValue(oamControl.recommended_target_active_link_sampling_rate, NaN);
  const recommendedTelemetryBudget = numberValue(oamControl.recommended_telemetry_byte_budget_per_slice, NaN);
  const hasSamplingRecommendation = Number.isFinite(recommendedSamplingRate) && recommendedSamplingRate > 0;
  const hasTargetRecommendation = Number.isFinite(recommendedTargetRate) && recommendedTargetRate > 0;
  const hasTelemetryBudgetRecommendation = Number.isFinite(recommendedTelemetryBudget) && recommendedTelemetryBudget > 0;
  const structuralPressure = clamp(Math.max(
    numberValue(oamControl.oam_control_pressure),
    numberValue(oamControl.coverage_demand_pressure),
    numberValue(oamControl.unknown_pressure),
    numberValue(oamControl.low_confidence_pressure),
  ), 0, 1);
  const retestOnlyPressure = clamp(Math.max(
    numberValue(oamControl.retest_pressure) * 0.35,
    clamp(numberValue(oamControl.priority_retest_targets) / 24, 0, 0.35),
  ), 0, 1);
  const pressure = clamp(Math.max(structuralPressure, retestOnlyPressure), 0, 1);
  const forceFreshReplan = oamControl.recommended_action === "refresh-probe-plan" || oamControl.probe_bias === "force-fresh-replan";
  const hardDegradationPressure = clamp(Math.max(
    numberValue(oamControl.unknown_pressure),
    numberValue(oamControl.conflict_pressure),
    numberValue(oamControl.downlink_pressure),
    numberValue(oamControl.oam_control_pressure) >= 0.68 ? numberValue(oamControl.oam_control_pressure) : 0,
  ), 0, 1);
  const pressureBudgetApplied = forceFreshReplan || hardDegradationPressure >= 0.35;
  const pressureSamplingRate = pressureBudgetApplied
    ? clamp(samplingRate + Math.max(pressure, structuralPressure) * 0.18, samplingRate, 0.85)
    : samplingRate;
  const pressureTargetRate = pressureBudgetApplied
    ? clamp(targetActiveLinkSamplingRate + Math.max(pressure, structuralPressure) * 0.24, pressureSamplingRate, 0.95)
    : targetActiveLinkSamplingRate;
  const pressureTelemetryBudget = pressureBudgetApplied && telemetryByteBudgetPerSlice > 0
    ? telemetryByteBudgetPerSlice * (1 + Math.max(pressure, structuralPressure) * 0.45)
    : telemetryByteBudgetPerSlice;
  const adjustedSamplingRate = hasSamplingRecommendation
    ? clamp(pressureBudgetApplied ? Math.max(recommendedSamplingRate, pressureSamplingRate) : Math.min(recommendedSamplingRate, samplingRate), 0.01, 1)
    : pressureSamplingRate;
  const adjustedTargetRate = hasTargetRecommendation
    ? clamp(pressureBudgetApplied ? Math.max(recommendedTargetRate, pressureTargetRate) : Math.min(recommendedTargetRate, targetActiveLinkSamplingRate), adjustedSamplingRate, 1)
    : pressureTargetRate;
  const adjustedTelemetryBudget = hasTelemetryBudgetRecommendation
    ? Math.max(0, pressureBudgetApplied ? Math.max(recommendedTelemetryBudget, pressureTelemetryBudget) : Math.min(recommendedTelemetryBudget, telemetryByteBudgetPerSlice || recommendedTelemetryBudget))
    : pressureTelemetryBudget;
  const applied = hasSamplingRecommendation || hasTargetRecommendation || hasTelemetryBudgetRecommendation || pressureBudgetApplied;
  return {
    oam_budget_applied: applied,
    oam_budget_policy: applied
      ? pressureBudgetApplied
        ? "ground-oam-pressure-adaptive-budget"
        : "ground-oam-adaptive-budget"
      : "disabled",
    oam_budget_reason: applied
      ? oamControl.budget_recommendation_reason ||
        (pressureBudgetApplied ? "derived-from-ground-oam-pressure" : "") ||
        oamControl.budget_recommendation_action ||
        "ground-oam-control-action"
      : "no-oam-budget-recommendation",
    oam_budget_action: oamControl.budget_recommendation_action || "maintain-nominal-budget",
    oam_budget_source: oamControl.budget_recommendation_source || "",
    configured_sampling_rate: samplingRate,
    configured_target_active_link_sampling_rate: targetActiveLinkSamplingRate,
    configured_telemetry_byte_budget_per_slice: telemetryByteBudgetPerSlice,
    oam_recommended_sampling_rate: hasSamplingRecommendation ? round(recommendedSamplingRate) : "",
    oam_recommended_target_active_link_sampling_rate: hasTargetRecommendation ? round(recommendedTargetRate) : "",
    oam_recommended_telemetry_byte_budget_per_slice: hasTelemetryBudgetRecommendation ? round(recommendedTelemetryBudget) : "",
    oam_recommended_downlink_budget_bytes: Number.isFinite(numberValue(oamControl.recommended_downlink_budget_bytes, NaN))
      ? round(numberValue(oamControl.recommended_downlink_budget_bytes))
      : "",
    adjusted_sampling_rate: round(adjustedSamplingRate),
    adjusted_target_active_link_sampling_rate: round(adjustedTargetRate),
    adjusted_telemetry_byte_budget_per_slice: round(adjustedTelemetryBudget),
    coverage_demand_pressure: round(numberValue(oamControl.coverage_demand_pressure)),
    oam_budget_structural_pressure: round(structuralPressure),
    oam_budget_retest_only_pressure: round(retestOnlyPressure),
    oam_budget_hard_degradation_pressure: round(hardDegradationPressure),
    oam_budget_allows_global_escalation: pressureBudgetApplied,
    oam_budget_pressure: round(pressure),
  };
}

function buildAdaptiveProbeBudget({
  enabled,
  slicePlan,
  oamBudget,
  candidateSource,
  selectionStrategy,
  samplingRate,
  targetActiveLinkSamplingRate,
  telemetryByteBudgetPerSlice,
  minPaths,
  maxPaths,
  candidatePathCount,
  sliceTrafficRisk,
  nodeSamplingScale = 1,
}) {
  const configuredMaxPathsPerSlice = selectionStrategy === "full-int"
    ? candidatePathCount
    : Math.min(maxPaths > 0 ? maxPaths : candidatePathCount, candidatePathCount);
  const base = {
    adaptive_probe_budget_enabled: Boolean(enabled),
    adaptive_probe_budget_applied: false,
    adaptive_probe_budget_policy: enabled ? "nominal-adaptive-probe-budget" : "disabled",
    adaptive_probe_budget_reason: enabled ? "no-budget-shift" : "adaptive-probe-budget-disabled",
    adaptive_probe_budget_scale: 1,
    adaptive_probe_budget_sampling_rate: round(samplingRate),
    adaptive_probe_budget_target_active_link_sampling_rate: round(targetActiveLinkSamplingRate),
    adaptive_probe_budget_telemetry_byte_budget_per_slice: round(telemetryByteBudgetPerSlice),
    adaptive_probe_budget_oam_pressure: 0,
    adaptive_probe_budget_slice_traffic_risk: round(sliceTrafficRisk),
    adaptive_probe_budget_reuse_confidence: 0,
    adaptive_probe_budget_reuse_margin: round(numberValue(slicePlan.topology_reuse_margin)),
    adaptive_probe_budget_drift_pressure: round(numberValue(slicePlan.topology_forecast_drift_pressure)),
    adaptive_probe_budget_configured_max_paths_per_slice: configuredMaxPathsPerSlice,
    adaptive_probe_budget_effective_max_paths_per_slice: configuredMaxPathsPerSlice,
    adaptive_probe_budget_path_cap_policy: enabled ? "nominal-path-cap" : "disabled",
    adjusted_sampling_rate: round(samplingRate),
    adjusted_target_active_link_sampling_rate: round(targetActiveLinkSamplingRate),
    adjusted_telemetry_byte_budget_per_slice: round(telemetryByteBudgetPerSlice),
  };
  if (!enabled || selectionStrategy === "full-int") {
    return {
      ...base,
      adaptive_probe_budget_policy: selectionStrategy === "full-int"
        ? "full-int-baseline-no-adaptive-budget"
        : base.adaptive_probe_budget_policy,
      adaptive_probe_budget_reason: selectionStrategy === "full-int"
        ? "full-int-preserves-upper-bound"
        : base.adaptive_probe_budget_reason,
    };
  }

  const reuseMargin = numberValue(slicePlan.topology_reuse_margin);
  const topologySimilarity = numberValue(slicePlan.topology_similarity_score);
  const linkStateSimilarity = numberValue(slicePlan.link_state_similarity);
  const explicitReuseConfidence = optionalNumber(slicePlan.topology_forecast_reuse_confidence);
  const reuseConfidence = clamp(
    Number.isFinite(explicitReuseConfidence)
      ? explicitReuseConfidence
      : Math.max(topologySimilarity, linkStateSimilarity),
    0,
    1,
  );
  const stableWindow = numberValue(slicePlan.topology_forecast_stable_window_slices);
  const driftPressure = clamp(numberValue(slicePlan.topology_forecast_drift_pressure), 0, 1);
  const oamTriggered = boolValue(slicePlan.oam_replan_triggered) || boolValue(slicePlan.oam_control_replan_triggered);
  const triggeredReplanPressure = oamTriggered ? numberValue(slicePlan.oam_replan_pressure) : 0;
  const oamStructuralPressure = clamp(Math.max(
    triggeredReplanPressure,
    numberValue(slicePlan.oam_control_pressure),
    numberValue(oamBudget.oam_budget_structural_pressure),
    numberValue(oamBudget.coverage_demand_pressure),
  ), 0, 1);
  const oamRetestOnlyPressure = clamp(Math.max(
    numberValue(slicePlan.oam_control_retest_pressure) * 0.35,
    clamp(numberValue(slicePlan.oam_control_priority_retest_targets) / 24, 0, 0.35),
    numberValue(oamBudget.oam_budget_retest_only_pressure),
  ), 0, 1);
  const oamPressure = clamp(Math.max(oamStructuralPressure, oamRetestOnlyPressure), 0, 1);
  const allowGlobalOamEscalation = oamTriggered ||
    boolValue(oamBudget.oam_budget_allows_global_escalation);
  const minSamplingRate = candidatePathCount > 0 ? Math.min(1, minPaths / candidatePathCount) : 0;

  let policy = "nominal-adaptive-probe-budget";
  let reason = "no-budget-shift";
  let scale = 1;
  if (allowGlobalOamEscalation) {
    const escalationPressure = Math.max(oamStructuralPressure, oamPressure);
    scale = clamp(1 + escalationPressure * 0.32 + (oamTriggered ? 0.1 : 0), 1.05, 1.45);
    policy = "oam-pressure-coverage-escalation";
    reason = oamTriggered
      ? "ground-oam-replan-triggered"
      : "ground-oam-pressure-derived";
  } else if (oamPressure >= 0.25) {
    const lowRiskStableSlice = sliceTrafficRisk < 0.12 && oamStructuralPressure < 0.45 && driftPressure < 0.5;
    if (lowRiskStableSlice) {
      scale = 1;
      policy = "oam-feedback-gated-low-risk-slice";
      reason = "low-risk-slice-keeps-native-int-mc-plan";
    } else {
      const retestBudgetCredit = clamp(oamRetestOnlyPressure * 0.34, 0, 0.16);
      const denseCandidateRepresentativeCredit = candidatePathCount >= 100
        ? 0.055
        : candidatePathCount >= 40
          ? 0.025
          : 0;
      scale = clamp(0.9 + retestBudgetCredit * 0.18 + denseCandidateRepresentativeCredit - oamStructuralPressure * 0.015, 0.88, 0.98);
      policy = "oam-target-biased-metadata-reallocation";
      reason = "moderate-oam-pressure-preserves-multimetric-coverage-and-compresses-metadata";
    }
  } else if (candidateSource === "topology-reuse-cache" && reuseConfidence >= 0.82 && reuseMargin >= 0.03 && stableWindow >= 1 && driftPressure <= 0.35) {
    scale = clamp(
      1 -
        (reuseConfidence - 0.8) * 0.45 -
        Math.min(reuseMargin, 0.25) * 0.55 -
        Math.min(stableWindow, 6) * 0.035 +
        driftPressure * 0.08,
      0.86,
      0.96,
    );
    policy = "topology-reuse-confidence-throttle";
    reason = "high-confidence-stable-topology-reuse";
  } else if (reuseMargin < 0 || driftPressure >= 0.55) {
    scale = 1;
    policy = "topology-drift-reorder-without-extra-probes";
    reason = reuseMargin < 0 ? "reuse-margin-negative-reorder-only" : "forecast-drift-reorder-only";
  }

  if (scale < 1 && nodeSamplingScale > 1.25 && nodeSamplingScale < 1.5) {
    scale = 1;
    policy = "scale-aware-node-coverage-preserve-path-budget";
    reason = "medium-constellation-spends-metadata-savings-on-node-observation-density";
  }

  const applied = Math.abs(scale - 1) > 0.001;
  const adjustedSamplingRate = scale >= 1
    ? clamp(samplingRate * scale, samplingRate, 0.9)
    : clamp(samplingRate * scale, minSamplingRate, samplingRate);
  const adjustedTargetRate = scale >= 1
    ? clamp(Math.max(targetActiveLinkSamplingRate * scale, adjustedSamplingRate), adjustedSamplingRate, 0.98)
    : clamp(targetActiveLinkSamplingRate * scale, Math.min(targetActiveLinkSamplingRate, minSamplingRate), targetActiveLinkSamplingRate);
  const adjustedTelemetryBudget = telemetryByteBudgetPerSlice > 0
    ? telemetryByteBudgetPerSlice * scale
    : telemetryByteBudgetPerSlice;
  const effectiveMaxPathsPerSlice = scale < 1
    ? Math.max(minPaths, Math.min(configuredMaxPathsPerSlice, Math.floor(configuredMaxPathsPerSlice * scale)))
    : scale > 1
      ? Math.max(configuredMaxPathsPerSlice, Math.min(candidatePathCount, Math.ceil(configuredMaxPathsPerSlice * scale)))
      : configuredMaxPathsPerSlice;

  return {
    ...base,
    adaptive_probe_budget_applied: applied,
    adaptive_probe_budget_policy: policy,
    adaptive_probe_budget_reason: reason,
    adaptive_probe_budget_scale: round(scale),
    adaptive_probe_budget_sampling_rate: round(adjustedSamplingRate),
    adaptive_probe_budget_target_active_link_sampling_rate: round(adjustedTargetRate),
    adaptive_probe_budget_telemetry_byte_budget_per_slice: round(adjustedTelemetryBudget),
    adaptive_probe_budget_oam_pressure: round(oamPressure),
    adaptive_probe_budget_slice_traffic_risk: round(sliceTrafficRisk),
    adaptive_probe_budget_reuse_confidence: round(reuseConfidence),
    adaptive_probe_budget_reuse_margin: round(reuseMargin),
    adaptive_probe_budget_drift_pressure: round(driftPressure),
    adaptive_probe_budget_effective_max_paths_per_slice: effectiveMaxPathsPerSlice,
    adaptive_probe_budget_path_cap_policy: scale < 1
      ? "topology-reuse-communication-path-cap"
      : scale > 1
        ? "coverage-escalation-preserve-configured-cap"
        : policy === "oam-target-biased-metadata-reallocation"
          ? "preserve-path-cap-with-metadata-reallocation"
          : "nominal-path-cap",
    adjusted_sampling_rate: round(adjustedSamplingRate),
    adjusted_target_active_link_sampling_rate: round(adjustedTargetRate),
    adjusted_telemetry_byte_budget_per_slice: round(adjustedTelemetryBudget),
  };
}

function planningReuseMode(candidateSource, topologyReuseDecision) {
  if (candidateSource === "topology-reuse-cache") return "cache-reuse-with-validation";
  if (candidateSource === "topology-reuse-cache-local-repair") return "cache-reuse-with-local-repair";
  if (candidateSource === "fresh-slice-plan-fallback") return "fallback-fresh-replan";
  if (topologyReuseDecision === "oam-feedback-refresh-replan") return "oam-forced-fresh-replan";
  if (topologyReuseDecision === "oam-control-refresh-replan") return "oam-forced-fresh-replan";
  return "fresh-replan";
}

function estimatePlanningCost({
  candidateSource,
  topologyReuseDecision,
  activeLinkCount,
  candidatePathCount,
  planningCandidateCount,
  repairedCandidatePaths,
  selectedPaths,
  selectedRepairedPaths,
  oamReplanTargets,
}) {
  const candidates = Math.max(candidatePathCount, planningCandidateCount, 1);
  const activeLinks = Math.max(activeLinkCount, 1);
  const fullReplanCost =
    activeLinks * 1 +
    candidates * (1 + Math.log2(candidates + 1)) +
    Math.max(selectedPaths, 0) * 0.5 +
    Math.max(oamReplanTargets, 0) * 0.03;
  const reuseValidationCost = activeLinks * 0.18 + planningCandidateCount * 0.35;
  const repairCost = repairedCandidatePaths * 1.15 + selectedRepairedPaths * 0.35;
  const oamFeedbackCost = Math.max(oamReplanTargets, 0) * 0.03;
  const fallbackPenalty = candidateSource === "fresh-slice-plan-fallback" ? candidates * 0.2 : 0;
  const mode = planningReuseMode(candidateSource, topologyReuseDecision);
  const actualCost = mode === "cache-reuse-with-validation"
    ? reuseValidationCost + oamFeedbackCost
    : mode === "cache-reuse-with-local-repair"
      ? reuseValidationCost + repairCost + oamFeedbackCost
      : fullReplanCost + fallbackPenalty;
  const savedCost = Math.max(0, fullReplanCost - actualCost);
  const savingRatio = fullReplanCost > 0 ? savedCost / fullReplanCost : 0;

  return {
    planning_reuse_mode: mode,
    planning_cache_hit: mode === "cache-reuse-with-validation" || mode === "cache-reuse-with-local-repair",
    planning_local_repair_applied: repairedCandidatePaths > 0,
    planning_full_replan_cost_units: round(fullReplanCost),
    planning_actual_cost_units: round(actualCost),
    planning_cost_saved_units: round(savedCost),
    planning_cost_saving_ratio: round(savingRatio),
    planning_reuse_validation_cost_units: round(reuseValidationCost),
    planning_repair_cost_units: round(repairCost),
    planning_oam_feedback_cost_units: round(oamFeedbackCost),
  };
}

function normalizeVector(values) {
  const finite = values.filter((value) => Number.isFinite(value));
  const avg = mean(finite);
  const variance = mean(finite.map((value) => (value - avg) ** 2));
  const std = Math.sqrt(variance) || 1;
  return values.map((value) => (Number.isFinite(value) ? (value - avg) / std : 0));
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
    let vector = Array.from({ length: size }, (_, index) => Math.cos((index + 1) * (component + 1)));
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

function planningActive(link) {
  if (link.predicted_active !== undefined) return boolValue(link.predicted_active);
  return boolValue(link.is_active);
}

function linkAvailability(link) {
  const value = numberValue(link.p_available, NaN);
  if (Number.isFinite(value)) return Math.max(0.01, Math.min(0.99, value));
  return planningActive(link) ? 0.95 : 0.05;
}

function buildContactPlan({
  linksBySlice,
  routesBySlice,
  sliceIndexes,
  classThreshold,
  adaptiveReuse,
  overheadPressure,
  oamFeedbackBySlice,
  oamControlBySlice,
  oamReplanPressureThreshold,
  oamControlReplanPressureThreshold,
  thresholdCalibrationHorizon,
}) {
  const classes = [];
  const perSlice = [];
  const baseReuseSimilarity = clamp(1 - classThreshold, 0.72, 0.98);
  let previousAcceptedSimilarity = baseReuseSimilarity;
  const profilesBySlice = new Map(
    sliceIndexes.map((sliceIndex) => [
      sliceIndex,
      sliceTopologyProfile(linksBySlice.get(sliceIndex) ?? [], routesBySlice.get(sliceIndex) ?? []),
    ]),
  );

  sliceIndexes.forEach((sliceIndex, slicePosition) => {
    const links = linksBySlice.get(sliceIndex) ?? [];
    const routes = routesBySlice.get(sliceIndex) ?? [];
    const activeLinks = links.filter((link) => planningActive(link));
    const profile = profilesBySlice.get(sliceIndex) ?? sliceTopologyProfile(links, routes);
    const activeSet = profile.activeSet;
    const signature = hashText([...activeSet].sort().join("|"));
    const scoredClasses = classes.map((item) => ({
      item,
      similarity: topologySimilarity(profile, item.prototypeProfile),
    }));
    scoredClasses.sort((left, right) =>
      right.similarity.structural_score - left.similarity.structural_score ||
      right.similarity.score - left.similarity.score
    );
    const bestClass = scoredClasses[0] ?? null;
    const oamFeedbackPressure = oamSlicePressure(oamFeedbackBySlice?.get(String(sliceIndex)));
    const oamControl = oamControlForSlice(oamControlBySlice, sliceIndex);
    const oamPressure = {
      pressure: round(Math.max(oamFeedbackPressure.pressure, oamControl.oam_control_pressure)),
      target_count: oamFeedbackPressure.target_count + oamControl.priority_retest_targets,
      urgent_targets: oamFeedbackPressure.urgent_targets + (oamControl.recommended_action === "refresh-probe-plan" ? 1 : 0),
      mean_priority_score: oamFeedbackPressure.mean_priority_score,
      max_priority_score: Math.max(oamFeedbackPressure.max_priority_score, oamControl.oam_control_pressure),
    };
    const futureProfiles = sliceIndexes
      .slice(slicePosition + 1, slicePosition + 1 + Math.max(0, thresholdCalibrationHorizon))
      .map((futureSliceIndex) => profilesBySlice.get(futureSliceIndex))
      .filter(Boolean);
    const thresholdCalibration = thresholdCalibrationDetails({
      scoredClasses,
      profile,
      futureProfiles,
      baseThreshold: baseReuseSimilarity,
    });
    const thresholdDetails = adaptiveReuse
      ? adaptiveReuseThresholdDetails({
          baseThreshold: baseReuseSimilarity,
          profile,
          previousSimilarity: previousAcceptedSimilarity,
          overheadPressure,
          oamPressure,
          bestSimilarity: bestClass?.similarity ?? null,
          calibration: thresholdCalibration,
        })
      : {
          threshold: baseReuseSimilarity,
          base_threshold: baseReuseSimilarity,
          volatility_penalty: 0,
          bottleneck_penalty: 0,
          load_penalty: 0,
          contact_uncertainty_penalty: 0,
          structural_drift_penalty: 0,
          link_state_drift_penalty: 0,
          route_drift_penalty: 0,
          oam_pressure_penalty: 0,
          stability_credit: 0,
          overhead_credit: 0,
          calibration_policy: "disabled",
          calibration_evidence_count: 0,
          calibration_candidate_class_count: 0,
          calibration_future_window_slices: 0,
          calibration_best_second_gap: 0,
          calibration_near_best_class_count: 0,
          calibration_near_threshold_class_count: 0,
          calibration_class_density: 0,
          calibration_similarity_p50: 0,
          calibration_similarity_p90: 0,
          calibration_future_mean_similarity: 0,
          calibration_future_min_similarity: 0,
          calibration_ambiguity_penalty: 0,
          calibration_future_drift_penalty: 0,
          calibration_separation_credit: 0,
          calibration_future_stability_credit: 0,
          calibration_sample_support_credit: 0,
          calibration_evidence_confidence: 0,
          calibration_net_adjustment: 0,
          total_tightening: 0,
          total_relaxation: 0,
          policy: "fixed-threshold",
          reason: "adaptive-reuse-disabled",
        };
    const adaptiveThreshold = thresholdDetails.threshold;
    const topologyForecast = topologyForecastDetails({
      profile,
      futureProfiles,
      similarityThreshold: adaptiveThreshold,
    });
    const reusableByTopology = bestClass && bestClass.similarity.structural_score >= adaptiveThreshold;
    const oamFeedbackLocalRetargetTriggered = adaptiveReuse &&
      oamFeedbackPressure.pressure >= oamReplanPressureThreshold &&
      Boolean(reusableByTopology);
    const oamControlLocalRetargetTriggered = adaptiveReuse &&
      Boolean(reusableByTopology) &&
      (oamControl.recommended_action === "refresh-probe-plan" ||
        oamControl.oam_control_pressure >= oamControlReplanPressureThreshold);
    const oamLocalRetargetTriggered = oamFeedbackLocalRetargetTriggered || oamControlLocalRetargetTriggered;
    const oamFeedbackReplanTriggered = false;
    const oamControlReplanTriggered = false;
    const oamReplanTriggered = false;
    let contactClass = reusableByTopology ? bestClass.item : null;
    const reused = Boolean(contactClass);
    if (!contactClass) {
      contactClass = {
        class_id: `TC-${String(classes.length + 1).padStart(3, "0")}`,
        prototype_signature: signature,
        prototypeActiveSet: new Set(activeSet),
        prototypeProfile: profile,
        slices: [],
      };
      classes.push(contactClass);
    } else {
      previousAcceptedSimilarity = bestClass.similarity.structural_score;
    }
    contactClass.slices.push(Number(sliceIndex));
    perSlice.push({
      slice_index: Number(sliceIndex),
      time: links[0]?.time ?? "",
      topology_class_id: contactClass.class_id,
      topology_signature: signature,
      topology_version_id: buildTopologyVersionId(contactClass.class_id, signature),
      topology_reused_from_class: reused,
      topology_reuse_decision: reused
        ? oamControlLocalRetargetTriggered
          ? "reuse-probe-plan-with-local-oam-control-retarget"
          : oamFeedbackLocalRetargetTriggered
            ? "reuse-probe-plan-with-local-oam-feedback-retarget"
            : "reuse-probe-plan-with-local-repair"
        : "replan-new-topology-class",
      topology_similarity_score: bestClass?.similarity.structural_score ?? 1,
      topology_legacy_composite_similarity_score: bestClass?.similarity.score ?? 1,
      topology_dynamic_similarity_score: bestClass?.similarity.dynamic_score ?? 1,
      active_jaccard: bestClass?.similarity.active_jaccard ?? 1,
      inter_plane_jaccard: bestClass?.similarity.inter_plane_jaccard ?? 1,
      bottleneck_jaccard: bestClass?.similarity.bottleneck_jaccard ?? 1,
      route_path_jaccard: bestClass?.similarity.route_path_jaccard ?? 1,
      link_state_similarity: bestClass?.similarity.link_state_similarity ?? 1,
      adaptive_reuse_threshold: adaptiveThreshold,
      adaptive_threshold_base: thresholdDetails.base_threshold,
      adaptive_threshold_policy: thresholdDetails.policy,
      adaptive_threshold_reason: thresholdDetails.reason,
      adaptive_threshold_total_tightening: thresholdDetails.total_tightening,
      adaptive_threshold_total_relaxation: thresholdDetails.total_relaxation,
      adaptive_threshold_volatility_penalty: thresholdDetails.volatility_penalty,
      adaptive_threshold_bottleneck_penalty: thresholdDetails.bottleneck_penalty,
      adaptive_threshold_load_penalty: thresholdDetails.load_penalty,
      adaptive_threshold_contact_uncertainty_penalty: thresholdDetails.contact_uncertainty_penalty,
      adaptive_threshold_structural_drift_penalty: thresholdDetails.structural_drift_penalty,
      adaptive_threshold_link_state_drift_penalty: thresholdDetails.link_state_drift_penalty,
      adaptive_threshold_route_drift_penalty: thresholdDetails.route_drift_penalty,
      adaptive_threshold_oam_pressure_penalty: thresholdDetails.oam_pressure_penalty,
      adaptive_threshold_stability_credit: thresholdDetails.stability_credit,
      adaptive_threshold_overhead_credit: thresholdDetails.overhead_credit,
      adaptive_threshold_calibration_policy: thresholdDetails.calibration_policy,
      adaptive_threshold_calibration_evidence_count: thresholdDetails.calibration_evidence_count,
      adaptive_threshold_calibration_candidate_class_count: thresholdDetails.calibration_candidate_class_count,
      adaptive_threshold_calibration_future_window_slices: thresholdDetails.calibration_future_window_slices,
      adaptive_threshold_calibration_best_second_gap: thresholdDetails.calibration_best_second_gap,
      adaptive_threshold_calibration_near_best_class_count: thresholdDetails.calibration_near_best_class_count,
      adaptive_threshold_calibration_near_threshold_class_count: thresholdDetails.calibration_near_threshold_class_count,
      adaptive_threshold_calibration_class_density: thresholdDetails.calibration_class_density,
      adaptive_threshold_calibration_similarity_p50: thresholdDetails.calibration_similarity_p50,
      adaptive_threshold_calibration_similarity_p90: thresholdDetails.calibration_similarity_p90,
      adaptive_threshold_calibration_future_mean_similarity: thresholdDetails.calibration_future_mean_similarity,
      adaptive_threshold_calibration_future_min_similarity: thresholdDetails.calibration_future_min_similarity,
      adaptive_threshold_calibration_ambiguity_penalty: thresholdDetails.calibration_ambiguity_penalty,
      adaptive_threshold_calibration_future_drift_penalty: thresholdDetails.calibration_future_drift_penalty,
      adaptive_threshold_calibration_separation_credit: thresholdDetails.calibration_separation_credit,
      adaptive_threshold_calibration_future_stability_credit: thresholdDetails.calibration_future_stability_credit,
      adaptive_threshold_calibration_sample_support_credit: thresholdDetails.calibration_sample_support_credit,
      adaptive_threshold_calibration_evidence_confidence: thresholdDetails.calibration_evidence_confidence,
      adaptive_threshold_calibration_net_adjustment: thresholdDetails.calibration_net_adjustment,
      topology_reuse_margin: round((bestClass?.similarity.structural_score ?? 1) - adaptiveThreshold, 5),
      ...topologyForecast,
      oam_feedback_pressure: oamFeedbackPressure.pressure,
      oam_replan_pressure: oamPressure.pressure,
      oam_replan_targets: oamPressure.target_count,
      oam_replan_urgent_targets: oamPressure.urgent_targets,
      oam_replan_mean_priority_score: oamPressure.mean_priority_score,
      oam_replan_max_priority_score: oamPressure.max_priority_score,
      oam_replan_pressure_threshold: oamReplanPressureThreshold,
      oam_replan_triggered: oamReplanTriggered,
      oam_local_retarget_triggered: oamLocalRetargetTriggered,
      oam_feedback_local_retarget_triggered: oamFeedbackLocalRetargetTriggered,
      oam_control_local_retarget_triggered: oamControlLocalRetargetTriggered,
      oam_control_action: oamControl.recommended_action,
      oam_control_probe_bias: oamControl.probe_bias,
      oam_control_confidence_budget: oamControl.confidence_budget,
      oam_control_pressure: oamControl.oam_control_pressure,
      oam_control_source_slice_index: oamControl.control_source_slice_index,
      oam_control_target_slice_index: oamControl.control_target_slice_index,
      oam_control_next_slice_applied: Boolean(oamControl.control_source_slice_index && String(oamControl.control_source_slice_index) !== String(oamControl.control_target_slice_index)),
      oam_control_replan_pressure_threshold: oamControlReplanPressureThreshold,
      oam_control_replan_triggered: oamControlReplanTriggered,
      oam_control_priority_retest_targets: oamControl.priority_retest_targets,
      oam_control_unknown_pressure: oamControl.unknown_pressure,
      oam_control_stale_pressure: oamControl.stale_pressure,
      oam_control_prior_estimate_pressure: oamControl.prior_estimate_pressure,
      oam_control_low_confidence_pressure: oamControl.low_confidence_pressure,
      oam_control_conflict_pressure: oamControl.conflict_pressure,
      oam_control_downlink_pressure: oamControl.downlink_pressure,
      oam_control_retest_pressure: oamControl.retest_pressure,
      oam_control_top_node_targets: oamControl.top_node_targets,
      oam_control_top_link_targets: oamControl.top_link_targets,
      oam_control_retest_reasons: oamControl.top_retest_reasons,
      active_link_count: activeSet.size,
      active_intra_links: activeLinks.filter((link) => link.kind === "intra-plane").length,
      active_inter_links: activeLinks.filter((link) => link.kind === "inter-plane").length,
      bottleneck_links: profile.bottleneck_count,
      routed_routes: profile.routed_route_count,
      mean_route_hops: round(profile.mean_route_hops),
      total_route_traffic_mbps: round(profile.total_route_traffic_mbps),
      mean_utilization_percent: round(profile.mean_utilization),
      mean_predicted_availability: round(mean(activeLinks.map((link) => linkAvailability(link)))),
      signature,
      activeSet,
      topologyProfile: profile,
    });
  });

  return {
    perSlice,
    classes: classes.map((item) => ({
      class_id: item.class_id,
      prototype_signature: item.prototype_signature,
      slice_count: item.slices.length,
      slices: item.slices,
      prototype_active_links: item.prototypeActiveSet.size,
      prototype_inter_links: item.prototypeProfile.inter_count,
      prototype_bottleneck_links: item.prototypeProfile.bottleneck_count,
      prototype_routed_routes: item.prototypeProfile.routed_route_count,
    })),
  };
}

function buildLeverageScores({ linksById, sliceIndexes, rank }) {
  const linkIds = [...linksById.keys()].sort();
  const rows = [];
  const transitionRate = new Map();
  const temporalVariance = new Map();
  const stats = (values, fallback = 0) => {
    const finite = values.map((value) => numberValue(value, NaN)).filter(Number.isFinite);
    const safe = finite.length > 0 ? finite : [fallback];
    const avg = mean(safe);
    const variance = mean(safe.map((value) => (value - avg) ** 2));
    return {
      mean: avg,
      std: Math.sqrt(variance) || 0,
      min: Math.min(...safe),
      max: Math.max(...safe),
      last: safe[safe.length - 1],
    };
  };

  linkIds.forEach((linkId) => {
    const bySlice = linksById.get(linkId);
    const firstLink = sliceIndexes.map((sliceIndex) => bySlice.get(sliceIndex)).find(Boolean);
    const activeSeries = [];
    const utilizationSeries = [];
    const congestionSeries = [];
    const latencySeries = [];
    const queueSeries = [];
    const distanceSeries = [];
    const capacitySeries = [];
    const availabilitySeries = [];
    sliceIndexes.forEach((sliceIndex) => {
      const link = bySlice.get(sliceIndex);
      const active = link ? planningActive(link) : false;
      activeSeries.push(active ? 1 : 0);
      const utilization = active ? clamp(numberValue(link.utilization_percent) / 100, 0, 1) : 0;
      utilizationSeries.push(utilization);
      congestionSeries.push(active ? clamp(numberValue(link.congestion_percent) / 100, 0, 1) : 0);
      latencySeries.push(active ? clamp(numberValue(link.latency_ms) / 120, 0, 1.5) : 0);
      queueSeries.push(active ? clamp(numberValue(link.queue_latency_ms) / 200, 0, 2) : 0);
      distanceSeries.push(link ? clamp(numberValue(link.distance_km) / 8000, 0, 2) : 0);
      capacitySeries.push(active ? clamp(numberValue(link.effective_capacity_mbps || link.capacity_mbps) / 10000, 0, 2) : 0);
      availabilitySeries.push(link ? linkAvailability(link) : 0.05);
    });
    let transitions = 0;
    for (let index = 1; index < activeSeries.length; index += 1) {
      if (activeSeries[index] !== activeSeries[index - 1]) transitions += 1;
    }
    const diffs = [];
    for (let index = 1; index < utilizationSeries.length; index += 1) {
      diffs.push(Math.abs(utilizationSeries[index] - utilizationSeries[index - 1]));
    }
    const transition = transitions / Math.max(sliceIndexes.length - 1, 1);
    const temporalDiff = mean(diffs);
    transitionRate.set(linkId, transition);
    temporalVariance.set(linkId, temporalDiff);

    const activeStats = stats(activeSeries);
    const utilStats = stats(utilizationSeries);
    const congestionStats = stats(congestionSeries);
    const latencyStats = stats(latencySeries);
    const queueStats = stats(queueSeries);
    const distanceStats = stats(distanceSeries);
    const capacityStats = stats(capacitySeries);
    const availabilityStats = stats(availabilitySeries, 0.05);
    const sourceSlot = planeSlot(firstLink?.source);
    const targetSlot = planeSlot(firstLink?.target);
    const kind = firstLink?.kind ?? "";
    rows.push([
      activeStats.mean,
      activeStats.std,
      transition,
      utilStats.mean,
      utilStats.std,
      utilStats.max,
      utilStats.last,
      temporalDiff,
      congestionStats.mean,
      congestionStats.max,
      latencyStats.mean,
      latencyStats.std,
      queueStats.mean,
      queueStats.max,
      distanceStats.mean,
      distanceStats.std,
      capacityStats.mean,
      capacityStats.min,
      availabilityStats.mean,
      availabilityStats.min,
      sourceSlot.plane >= 0 ? sourceSlot.plane / 100 : 0,
      targetSlot.plane >= 0 ? targetSlot.plane / 100 : 0,
      sourceSlot.slot >= 0 ? sourceSlot.slot / 100 : 0,
      targetSlot.slot >= 0 ? targetSlot.slot / 100 : 0,
      kind === "intra-plane" ? 1 : 0,
      kind === "inter-plane" ? 1 : 0,
      kind === "star-ground" ? 1 : 0,
    ]);
  });

  const columns = rows[0]?.length ?? 0;
  const columnMeans = Array.from({ length: columns }, (_, col) => mean(rows.map((row) => row[col]).filter(Number.isFinite)));
  const columnStds = columnMeans.map((avg, col) => {
    const variance = mean(rows.map((row) => (numberValue(row[col]) - avg) ** 2));
    return Math.sqrt(variance) || 1;
  });
  const standardizedRows = rows.map((row) => row.map((value, col) => (numberValue(value) - columnMeans[col]) / columnStds[col]));
  const covariance = Array.from({ length: columns }, () => Array.from({ length: columns }, () => 0));
  standardizedRows.forEach((row) => {
    for (let left = 0; left < columns; left += 1) {
      for (let right = left; right < columns; right += 1) {
        covariance[left][right] += row[left] * row[right];
      }
    }
  });
  for (let left = 0; left < columns; left += 1) {
    for (let right = 0; right < left; right += 1) {
      covariance[left][right] = covariance[right][left];
    }
  }

  const components = topEigenvectorsSymmetric(covariance, rank);
  const scores = new Map();
  const rawScores = standardizedRows.map((row) => {
    if (components.length === 0) return 1;
    return components.reduce((total, component) => {
      const projection = dot(row, component.vector);
      return total + (projection * projection) / Math.max(component.eigenvalue, 1e-8);
    }, 0);
  });
  const avgScore = mean(rawScores) || 1;
  rawScores.forEach((score, index) => {
    const linkId = linkIds[index];
    const normalizedLeverage = Math.max(0.05, score / avgScore);
    scores.set(linkId, {
      leverage: normalizedLeverage,
      low_rank_leverage: normalizedLeverage,
      leverage_raw: round(score),
      leverage_matrix_columns: columns,
      leverage_rank: Math.min(rank, components.length),
      leverage_definition: "row-leverage-from-compact-low-rank-link-state-feature-matrix",
      transition_rate: transitionRate.get(linkId) ?? 0,
      temporal_variance: temporalVariance.get(linkId) ?? 0,
    });
  });
  return scores;
}

function emptyForecast(horizon) {
  return {
    forecast_horizon_slices: Math.max(0, horizon),
    forecast_observed_slices: 0,
    forecast_transition_count: 0,
    forecast_transition_score: 0,
    forecast_active_fraction: 0,
    forecast_future_active_fraction: 0,
    forecast_mean_availability: 0,
    forecast_min_availability: 0,
    forecast_first_change_in_slices: "",
    forecast_first_down_in_slices: "",
    forecast_first_up_in_slices: "",
    forecast_near_change_score: 0,
    forecast_near_outage_score: 0,
    forecast_contact_scarcity_score: 0,
    forecast_availability_risk: 0,
    forecast_priority_score: 0,
  };
}

function buildPredictionForecasts({ linksById, sliceIndexes, horizon }) {
  const orderedSlices = sliceIndexes.map(String).sort((left, right) => Number(left) - Number(right));
  const lookahead = Math.max(0, Math.floor(horizon));
  const forecasts = new Map();
  linksById.forEach((bySlice, linkId) => {
    orderedSlices.forEach((sliceIndex, slicePosition) => {
      const current = bySlice.get(sliceIndex);
      const currentActive = current ? planningActive(current) : false;
      const windowRows = [];
      for (let offset = 0; offset <= lookahead && slicePosition + offset < orderedSlices.length; offset += 1) {
        const nextSlice = orderedSlices[slicePosition + offset];
        const row = bySlice.get(nextSlice);
        windowRows.push({
          offset,
          active: row ? planningActive(row) : false,
          availability: row ? linkAvailability(row) : 0,
        });
      }
      if (windowRows.length === 0) {
        forecasts.set(`${sliceIndex}|${linkId}`, emptyForecast(lookahead));
        return;
      }

      const futureRows = windowRows.slice(1);
      let previousActive = currentActive;
      let transitions = 0;
      let firstChange = null;
      let firstDown = null;
      let firstUp = null;
      futureRows.forEach((row) => {
        if (row.active !== previousActive) {
          transitions += 1;
          if (firstChange === null) firstChange = row.offset;
          if (previousActive && !row.active && firstDown === null) firstDown = row.offset;
          if (!previousActive && row.active && firstUp === null) firstUp = row.offset;
        }
        previousActive = row.active;
      });

      const availabilityValues = windowRows.map((row) => row.availability);
      const activeFraction = windowRows.filter((row) => row.active).length / Math.max(windowRows.length, 1);
      const futureActiveFraction = futureRows.length
        ? futureRows.filter((row) => row.active).length / futureRows.length
        : activeFraction;
      const transitionScore = clamp(transitions / Math.max(futureRows.length, 1), 0, 1);
      const nearChangeScore = firstChange === null ? 0 : clamp((lookahead - firstChange + 1) / Math.max(lookahead, 1), 0, 1);
      const nearOutageScore = firstDown === null ? 0 : clamp((lookahead - firstDown + 1) / Math.max(lookahead, 1), 0, 1);
      const contactScarcityScore = currentActive ? clamp(1 - futureActiveFraction, 0, 1) : 0;
      const meanAvailability = mean(availabilityValues);
      const minAvailability = Math.min(...availabilityValues);
      const availabilityRisk = clamp(1 - meanAvailability, 0, 1);
      const priorityScore = clamp(
        transitionScore * 0.34 +
          nearChangeScore * 0.18 +
          nearOutageScore * 0.22 +
          contactScarcityScore * 0.16 +
          availabilityRisk * 0.1,
        0,
        1,
      );

      forecasts.set(`${sliceIndex}|${linkId}`, {
        forecast_horizon_slices: lookahead,
        forecast_observed_slices: futureRows.length,
        forecast_transition_count: transitions,
        forecast_transition_score: round(transitionScore),
        forecast_active_fraction: round(activeFraction),
        forecast_future_active_fraction: round(futureActiveFraction),
        forecast_mean_availability: round(meanAvailability),
        forecast_min_availability: round(minAvailability),
        forecast_first_change_in_slices: firstChange ?? "",
        forecast_first_down_in_slices: firstDown ?? "",
        forecast_first_up_in_slices: firstUp ?? "",
        forecast_near_change_score: round(nearChangeScore),
        forecast_near_outage_score: round(nearOutageScore),
        forecast_contact_scarcity_score: round(contactScarcityScore),
        forecast_availability_risk: round(availabilityRisk),
        forecast_priority_score: round(priorityScore),
      });
    });
  });
  return forecasts;
}

function forecastForLink(forecastBySliceAndLink, sliceIndex, linkId, horizon) {
  return forecastBySliceAndLink?.get(`${sliceIndex}|${linkId}`) ?? emptyForecast(horizon);
}

function pathForecastProfile({ sliceIndex, pathLinks, forecastBySliceAndLink, horizon }) {
  if (pathLinks.length === 0) return emptyForecast(horizon);
  const forecasts = pathLinks.map((linkId) => forecastForLink(forecastBySliceAndLink, sliceIndex, linkId, horizon));
  const firstChanges = forecasts
    .map((item) => optionalNumber(item.forecast_first_change_in_slices))
    .filter(Number.isFinite);
  const firstDowns = forecasts
    .map((item) => optionalNumber(item.forecast_first_down_in_slices))
    .filter(Number.isFinite);
  const firstUps = forecasts
    .map((item) => optionalNumber(item.forecast_first_up_in_slices))
    .filter(Number.isFinite);
  return {
    forecast_horizon_slices: horizon,
    forecast_observed_slices: round(mean(forecasts.map((item) => numberValue(item.forecast_observed_slices)))),
    forecast_transition_count: round(forecasts.reduce((total, item) => total + numberValue(item.forecast_transition_count), 0)),
    forecast_transition_score: round(mean(forecasts.map((item) => numberValue(item.forecast_transition_score)))),
    forecast_active_fraction: round(mean(forecasts.map((item) => numberValue(item.forecast_active_fraction)))),
    forecast_future_active_fraction: round(mean(forecasts.map((item) => numberValue(item.forecast_future_active_fraction)))),
    forecast_mean_availability: round(mean(forecasts.map((item) => numberValue(item.forecast_mean_availability)))),
    forecast_min_availability: round(Math.min(...forecasts.map((item) => numberValue(item.forecast_min_availability, 1)))),
    forecast_first_change_in_slices: firstChanges.length ? Math.min(...firstChanges) : "",
    forecast_first_down_in_slices: firstDowns.length ? Math.min(...firstDowns) : "",
    forecast_first_up_in_slices: firstUps.length ? Math.min(...firstUps) : "",
    forecast_near_change_score: round(mean(forecasts.map((item) => numberValue(item.forecast_near_change_score)))),
    forecast_near_outage_score: round(mean(forecasts.map((item) => numberValue(item.forecast_near_outage_score)))),
    forecast_contact_scarcity_score: round(mean(forecasts.map((item) => numberValue(item.forecast_contact_scarcity_score)))),
    forecast_availability_risk: round(mean(forecasts.map((item) => numberValue(item.forecast_availability_risk)))),
    forecast_priority_score: round(mean(forecasts.map((item) => numberValue(item.forecast_priority_score)))),
    forecast_upcoming_outage_links: firstDowns.length,
    forecast_upcoming_recovery_links: firstUps.length,
  };
}

function buildLinksById(links) {
  const map = new Map();
  links.forEach((link) => {
    if (!map.has(link.link_id)) map.set(link.link_id, new Map());
    map.get(link.link_id).set(String(link.slice_index), link);
  });
  return map;
}

function buildPlanningLinks({ truthLinks, predictedPlan }) {
  if (!predictedPlan) return truthLinks;
  const truthByKey = indexBy(truthLinks, (link) => `${link.slice_index}|${link.link_id}`);
  return (predictedPlan.entries ?? []).map((entry) => {
    const truth = truthByKey.get(`${entry.slice_index}|${entry.link_id}`) ?? {};
    return {
      ...truth,
      ...entry,
      is_active: entry.predicted_active,
      status: entry.predicted_active ? truth.status || "up" : "down",
      effective_capacity_mbps: entry.capacity_mbps || truth.effective_capacity_mbps || truth.capacity_mbps,
      latency_ms: truth.latency_ms,
      utilization_percent: truth.utilization_percent,
      congestion_percent: truth.congestion_percent,
    };
  });
}

function buildGraphsBySlice(links) {
  const graphs = new Map();
  links.forEach((link) => {
    if (!planningActive(link)) return;
    const sliceIndex = String(link.slice_index);
    if (!graphs.has(sliceIndex)) graphs.set(sliceIndex, new Map());
    const graph = graphs.get(sliceIndex);
    const addEdge = (from, to) => {
      if (!from || !to) return;
      if (!graph.has(from)) graph.set(from, []);
      graph.get(from).push({
        to,
        link_id: link.link_id,
        cost:
          1 +
          Math.max(0, numberValue(link.distance_km, 0)) / 6500 +
          (1 - linkAvailability(link)) * 3 +
          (link.kind === "inter-plane" ? 0.05 : 0),
      });
    };
    addEdge(link.source, link.target);
    addEdge(link.target, link.source);
  });
  return graphs;
}

function shortestPath(graph, source, sink) {
  if (!graph || !source || !sink) return null;
  if (source === sink) return { nodes: [source], linkIds: [], cost: 0 };
  const distances = new Map([[source, 0]]);
  const previous = new Map();
  const pending = new Set(graph.keys());
  pending.add(source);
  pending.add(sink);

  while (pending.size > 0) {
    let current = null;
    let best = Infinity;
    for (const node of pending) {
      const value = distances.get(node) ?? Infinity;
      if (value < best) {
        best = value;
        current = node;
      }
    }
    if (current === null || !Number.isFinite(best)) break;
    pending.delete(current);
    if (current === sink) break;
    (graph.get(current) ?? []).forEach((edge) => {
      const nextDistance = best + edge.cost;
      if (nextDistance < (distances.get(edge.to) ?? Infinity)) {
        distances.set(edge.to, nextDistance);
        previous.set(edge.to, { node: current, linkId: edge.link_id });
        pending.add(edge.to);
      }
    });
  }

  if (!previous.has(sink)) return null;
  const nodes = [sink];
  const linkIds = [];
  let cursor = sink;
  while (cursor !== source) {
    const step = previous.get(cursor);
    if (!step) return null;
    linkIds.unshift(step.linkId);
    nodes.unshift(step.node);
    cursor = step.node;
  }
  return { nodes, linkIds, cost: distances.get(sink) ?? 0 };
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function planeSlot(nodeId) {
  const match = /^P(\d+)-S(\d+)$/.exec(String(nodeId || ""));
  if (!match) return { plane: -1, slot: -1 };
  return { plane: Number(match[1]), slot: Number(match[2]) };
}

function pathRisk({ sliceIndex, linkIds, linksBySliceAndId }) {
  if (linkIds.length === 0) return 1;
  const risks = linkIds.map((linkId) => {
    const row = linksBySliceAndId.get(`${sliceIndex}|${linkId}`);
    return 1 - linkAvailability(row ?? {});
  });
  return round(mean(risks));
}

function pathEnergyRisk({ sliceIndex, nodeIds, nodesBySliceAndId, minEnergyPercent }) {
  return pathEnergyProfile({ sliceIndex, nodeIds, nodesBySliceAndId, minEnergyPercent }).risk;
}

function pathEnergyProfile({ sliceIndex, nodeIds, nodesBySliceAndId, minEnergyPercent }) {
  if (!nodesBySliceAndId || nodeIds.length === 0) {
    return {
      risk: 0,
      low_energy_nodes: 0,
      power_saving_nodes: 0,
      shadow_nodes: 0,
      low_solar_nodes: 0,
      mean_energy_percent: 100,
      mean_solar_exposure: 1,
      mean_power_margin_w: 0,
      mean_solar_load_ratio: 1,
    };
  }
  const profiles = nodeIds.map((nodeId) => {
    const node = nodesBySliceAndId.get(`${sliceIndex}|${nodeId}`);
    if (!node) {
      return {
        risk: 0,
        energy: 100,
        solarExposure: 1,
        powerMarginW: 0,
        solarLoadRatio: 1,
        lowEnergy: false,
        powerSaving: false,
        shadow: false,
        lowSolar: false,
      };
    }
    const energy = numberValue(node.energy_percent, 100);
    const mode = String(node.mode || "");
    const solarExposure = clamp(numberValue(node.solar_exposure, boolValue(node.in_sunlight) ? 1 : 0), 0, 1);
    const solarPowerW = numberValue(node.solar_power_w, 0);
    const loadPowerW = Math.max(numberValue(node.load_power_w, 0), 1);
    const netPowerW = numberValue(node.net_power_w, solarPowerW - loadPowerW);
    const powerMarginW = netPowerW;
    const solarLoadRatio = clamp(solarPowerW / loadPowerW, 0, 2);
    const belowMin = Math.max(0, minEnergyPercent - energy) / Math.max(minEnergyPercent, 1);
    const shadowPenalty = solarExposure < 0.1 ? 0.18 : solarExposure < 0.4 ? 0.1 : 0;
    const deficitPenalty = netPowerW < 0 ? clamp(Math.abs(netPowerW) / Math.max(loadPowerW, 1), 0, 0.25) : 0;
    const savingPenalty = mode === "power-saving" || mode === "offline" || boolValue(node.power_saving_mode) ? 0.5 : 0;
    return {
      risk: clamp(belowMin + savingPenalty + shadowPenalty + deficitPenalty, 0, 1),
      energy,
      solarExposure,
      powerMarginW,
      solarLoadRatio,
      lowEnergy: energy < minEnergyPercent,
      powerSaving: mode === "power-saving" || mode === "offline" || boolValue(node.power_saving_mode),
      shadow: solarExposure < 0.1 || boolValue(node.in_sunlight) === false,
      lowSolar: solarExposure < 0.4 || solarLoadRatio < 0.5,
    };
  });
  return {
    risk: round(mean(profiles.map((item) => item.risk))),
    low_energy_nodes: profiles.filter((item) => item.lowEnergy).length,
    power_saving_nodes: profiles.filter((item) => item.powerSaving).length,
    shadow_nodes: profiles.filter((item) => item.shadow).length,
    low_solar_nodes: profiles.filter((item) => item.lowSolar).length,
    mean_energy_percent: round(mean(profiles.map((item) => item.energy))),
    mean_solar_exposure: round(mean(profiles.map((item) => item.solarExposure))),
    mean_power_margin_w: round(mean(profiles.map((item) => item.powerMarginW))),
    mean_solar_load_ratio: round(mean(profiles.map((item) => item.solarLoadRatio))),
  };
}

function estimatePathTelemetryCost({
  pathLinks,
  pathNodes,
  hopMetadataBytes,
  perHopMetadataBytes = [],
  probePacketBaseBytes,
  reportHeaderBytes,
  hopProcessingJ,
  reportProcessingJ,
  telemetryTxNjPerByte,
  multiObjectiveBudgetEnabled,
}) {
  const hopCount = Math.max(pathNodes.length, pathLinks.length + 1, 1);
  const hopBytes = Array.from({ length: hopCount }, (_, index) =>
    numberValue(perHopMetadataBytes[index], hopMetadataBytes)
  );
  const metadataBytes = hopBytes.reduce((total, bytes) => total + bytes, 0);
  const reportBytes = reportHeaderBytes + metadataBytes;
  const generatedBytes = metadataBytes + reportBytes + probePacketBaseBytes;
  let accumulatedMetadataBytes = 0;
  const probeForwardBytes = pathLinks.reduce((total, _linkId, index) => {
    accumulatedMetadataBytes += hopBytes[index] ?? hopMetadataBytes;
    return total + probePacketBaseBytes + accumulatedMetadataBytes;
  }, 0);
  const totalBytes = generatedBytes + probeForwardBytes;
  const processingEnergyJ = hopCount * hopProcessingJ + reportProcessingJ;
  const txEnergyJ = totalBytes * telemetryTxNjPerByte * 1e-9;
  return {
    estimated_path_hops: hopCount,
    estimated_metadata_bytes: round(metadataBytes),
    estimated_report_bytes: round(reportBytes),
    estimated_probe_base_bytes: round(probePacketBaseBytes),
    estimated_probe_forward_bytes: round(probeForwardBytes),
    estimated_generated_telemetry_bytes: round(generatedBytes),
    estimated_total_telemetry_bytes: round(totalBytes),
    estimated_processing_energy_j: round(processingEnergyJ),
    estimated_tx_energy_j: round(txEnergyJ),
    estimated_total_telemetry_energy_j: round(processingEnergyJ + txEnergyJ),
  };
}

function adaptiveMetadataProfile({
  enabled,
  hopMetadataBytes,
  compactHopMetadataBytes,
  candidateSource,
  slicePlan,
  adaptiveProbeBudget,
  oamFeedback,
  oamControl,
  localAdaptive,
  nodeSamplingScale = 1,
  multiObjectiveControl,
  oamTargetAwareMetadataEnabled = false,
  oamTargetHopMetadataBytes,
  oamTransitHopMetadataBytes,
  oamTargetObservationLossRatio = 0,
  oamTargetNeighborhoodMaxLossRatio = 0.1,
}) {
  const standard = {
    profile: "standard",
    effective_hop_metadata_bytes: hopMetadataBytes,
    compression_ratio: 1,
    policy: enabled ? "standard-full-metadata" : "disabled",
    reason: enabled ? "metadata-compression-not-safe" : "adaptive-metadata-profile-disabled",
  };
  if (!enabled || hopMetadataBytes <= 0) return standard;
  const objectiveEnabled = Boolean(multiObjectiveControl?.enabled);
  const objectiveFloorRatio = objectiveEnabled
    ? clamp(numberValue(multiObjectiveControl.metadata_floor_ratio, 1), 0.16, 1)
    : numberValue(compactHopMetadataBytes, hopMetadataBytes) / Math.max(hopMetadataBytes, 1);
  const objectiveCompactHopMetadataBytes = round(clamp(
    hopMetadataBytes * objectiveFloorRatio,
    16,
    hopMetadataBytes,
  ));
  const objectiveLightRatio = objectiveEnabled
    ? clamp(Math.max(objectiveFloorRatio, 0.58), 0.5, 0.92)
    : 0.72;
  const reuseConfidence = numberValue(adaptiveProbeBudget.adaptive_probe_budget_reuse_confidence, 0);
  const reuseScale = numberValue(adaptiveProbeBudget.adaptive_probe_budget_scale, 1);
  const driftPressure = numberValue(slicePlan.topology_forecast_drift_pressure, 0);
  const oamPressure = Math.max(
    numberValue(adaptiveProbeBudget.adaptive_probe_budget_oam_pressure, 0),
    numberValue(oamFeedback.score, 0),
    numberValue(oamControl.score, 0),
  );
  const reusable = candidateSource === "topology-reuse-cache" && Boolean(slicePlan.topology_reused_from_class);
  const focusedOamRetest = numberValue(oamFeedback.target_count) > 0 ||
    numberValue(oamControl.target_count) > 0;
  const mandatoryOamRetest = numberValue(oamFeedback.mandatory_target_count) > 0 ||
    numberValue(oamControl.mandatory_target_count) > 0;
  const focusedRiskProbe = numberValue(localAdaptive?.risk) >= 0.35;
  if (oamTargetAwareMetadataEnabled && mandatoryOamRetest) {
    const targetBytes = clamp(numberValue(oamTargetHopMetadataBytes, hopMetadataBytes), 16, hopMetadataBytes);
    const transitBytes = clamp(numberValue(oamTransitHopMetadataBytes, hopMetadataBytes), 16, targetBytes);
    const preserveAdjacentScans = numberValue(oamTargetObservationLossRatio) > numberValue(oamTargetNeighborhoodMaxLossRatio, 0.1);
    return {
      profile: "oam-target-aware",
      observation_mode: preserveAdjacentScans ? "all-adjacent" : "target-neighborhood",
      effective_hop_metadata_bytes: round(transitBytes),
      target_hop_metadata_bytes: round(targetBytes),
      transit_hop_metadata_bytes: round(transitBytes),
      target_observation_loss_ratio: round(numberValue(oamTargetObservationLossRatio)),
      target_neighborhood_max_loss_ratio: round(numberValue(oamTargetNeighborhoodMaxLossRatio, 0.1)),
      compression_ratio: round(transitBytes / Math.max(hopMetadataBytes, 1)),
      policy: preserveAdjacentScans
        ? "oam-target-full-transit-light-preserve-adjacent"
        : "oam-target-full-transit-light",
      reason: preserveAdjacentScans
        ? "projected-observation-loss-preserves-adjacent-scans"
        : "mandatory-target-keeps-full-state-while-transit-records-are-packed",
    };
  }
  if (focusedOamRetest || focusedRiskProbe) {
    const objectiveFieldCompressionSafe = objectiveEnabled &&
      multiObjectiveControl?.scale_profile !== "small" &&
      driftPressure <= 0.65 &&
      oamPressure <= 0.9;
    const lightFullMetadataSafe = (reuseScale < 0.98 || objectiveFieldCompressionSafe) && driftPressure <= 0.65 && oamPressure <= 0.9;
    if (lightFullMetadataSafe) {
      const effective = clamp(Math.max(objectiveCompactHopMetadataBytes, hopMetadataBytes * objectiveLightRatio), objectiveCompactHopMetadataBytes, hopMetadataBytes);
      return {
        profile: "standard-light",
        effective_hop_metadata_bytes: round(effective),
        compression_ratio: round(effective / Math.max(hopMetadataBytes, 1)),
        policy: focusedOamRetest ? "focused-oam-retest-light-full-adjacent-metadata" : "focused-risk-light-full-adjacent-metadata",
        reason: focusedOamRetest
          ? "ground-oam-target-keeps-neighbor-context-with-field-compression"
          : "high-risk-path-keeps-neighbor-context-with-field-compression",
      };
    }
    return {
      ...standard,
      policy: focusedOamRetest ? "focused-oam-retest-full-metadata" : "focused-risk-full-metadata",
      reason: focusedOamRetest ? "ground-oam-target-needs-neighbor-context" : "high-risk-path-needs-neighbor-context",
    };
  }
  const metadataReallocation = adaptiveProbeBudget.adaptive_probe_budget_policy === "oam-target-biased-metadata-reallocation";
  const scaleAwareNodeCoverage = adaptiveProbeBudget.adaptive_probe_budget_policy === "scale-aware-node-coverage-preserve-path-budget";
  if (scaleAwareNodeCoverage && nodeSamplingScale > 1.25 && nodeSamplingScale < 1.5 && driftPressure <= 0.65 && oamPressure <= 0.9) {
    const effective = clamp(Math.max(objectiveCompactHopMetadataBytes, hopMetadataBytes * objectiveLightRatio), objectiveCompactHopMetadataBytes, hopMetadataBytes);
    return {
      profile: "standard-light",
      effective_hop_metadata_bytes: round(effective),
      compression_ratio: round(effective / Math.max(hopMetadataBytes, 1)),
      policy: "scale-aware-light-full-adjacent-metadata",
      reason: "medium-constellation-preserves-probe-paths-with-field-compressed-node-context",
    };
  }
  const budgetConstrained = reuseScale < 0.98 || metadataReallocation;
  const compactSafe = budgetConstrained && driftPressure <= 0.65 && oamPressure <= 0.9;
  if (!compactSafe) {
    return {
      ...standard,
      reason: [
        budgetConstrained ? "" : "not-budget-constrained",
        reusable || candidateSource === "fresh-slice-plan" || candidateSource === "fresh-slice-plan-oam-mandatory" ? "" : "unsupported-candidate-source",
        reuseConfidence < 0.45 && reusable ? "low-reuse-confidence" : "",
        driftPressure > 0.65 ? "forecast-drift-pressure" : "",
        oamPressure > 0.9 ? "hard-oam-pressure-needs-full-metadata" : "",
      ].filter(Boolean).join("|") || standard.reason,
      };
  }
  if (nodeSamplingScale > 1.25 && nodeSamplingScale < 1.5) {
    const effective = clamp(Math.max(objectiveCompactHopMetadataBytes, hopMetadataBytes * objectiveLightRatio), objectiveCompactHopMetadataBytes, hopMetadataBytes);
    return {
      profile: "standard-light",
      effective_hop_metadata_bytes: round(effective),
      compression_ratio: round(effective / Math.max(hopMetadataBytes, 1)),
      policy: "scale-aware-light-full-adjacent-metadata",
      reason: "medium-large-constellation-preserves-node-neighbor-context-with-field-compression",
    };
  }
  const effective = clamp(objectiveCompactHopMetadataBytes, 16, hopMetadataBytes);
  return {
    profile: reusable ? "reuse-compact" : "budget-compact",
    effective_hop_metadata_bytes: round(effective),
    compression_ratio: round(effective / Math.max(hopMetadataBytes, 1)),
    policy: reusable ? "topology-reuse-compact-metadata" : "budget-constrained-compact-metadata",
    reason: reusable
      ? "high-confidence-reused-topology-with-low-oam-pressure"
      : metadataReallocation
        ? "metadata-reallocation-keeps-path-budget"
        : "budget-constrained-fresh-plan-with-completion-priors",
  };
}

function standardMetadataProfile({ enabled, hopMetadataBytes, reason }) {
  return {
    profile: "standard",
    effective_hop_metadata_bytes: hopMetadataBytes,
    compression_ratio: 1,
    policy: enabled ? "standard-full-metadata" : "disabled",
    reason: reason || (enabled ? "metadata-compression-not-safe" : "adaptive-metadata-profile-disabled"),
  };
}

function unifiedCompactMetadataProfile({ hopMetadataBytes, compactHopMetadataBytes }) {
  const effectiveBytes = round(clamp(compactHopMetadataBytes, 16, hopMetadataBytes));
  return {
    profile: "budget-compact",
    observation_mode: "path-only",
    effective_hop_metadata_bytes: effectiveBytes,
    compression_ratio: round(effectiveBytes / Math.max(hopMetadataBytes, 1)),
    policy: "unified-planner-compact-metadata",
    reason: "selected-by-unit-cost-information-gain",
  };
}

function topologyObjectSimilarityGroup({ type, id, row }) {
  const plane = (nodeId) => String(nodeId ?? "").match(/^P(\d+)-/i)?.[1] ?? "unknown";
  if (type === "node") return `node-plane:${plane(id)}`;
  const sourcePlane = plane(row?.source);
  const targetPlane = plane(row?.target);
  return `link:${String(row?.kind ?? "unknown")}:${sourcePlane}:${targetPlane}`;
}

function unifiedPlannerObservationsForItem({ item, sliceIndex, linksBySliceAndId, metadataQuality = 1 }) {
  const quality = clamp(metadataQuality, 0, 1);
  const linkObservations = item.linkWeights.map((signal) => {
    const row = linksBySliceAndId.get(`${sliceIndex}|${signal.link_id}`) ?? {};
    return {
      id: signal.link_id,
      type: "link",
      uncertainty: signal.uncertainty_score,
      risk: signal.topology_risk_score,
      metadata_quality: quality,
      similarity_group: topologyObjectSimilarityGroup({ type: "link", id: signal.link_id, row }),
    };
  });
  const nodeObservations = item.nodeStateSignals.map((signal) => ({
    id: signal.node_id,
    type: "node",
    uncertainty: signal.uncertainty,
    risk: signal.criticality,
    metadata_quality: quality,
    similarity_group: topologyObjectSimilarityGroup({ type: "node", id: signal.node_id }),
  }));
  return [...linkObservations, ...nodeObservations];
}

function addInstructionMaskCost(cost, { targetMaskBytes = 0, pathLinkCount = 0 } = {}) {
  const maskBytes = Math.max(0, numberValue(targetMaskBytes));
  if (maskBytes <= 0) return cost;
  const forwardedMaskBytes = maskBytes * Math.max(0, numberValue(pathLinkCount));
  const totalMaskBytes = maskBytes + forwardedMaskBytes;
  return {
    ...cost,
    estimated_probe_base_bytes: round(numberValue(cost.estimated_probe_base_bytes) + maskBytes),
    estimated_probe_forward_bytes: round(numberValue(cost.estimated_probe_forward_bytes) + forwardedMaskBytes),
    estimated_generated_telemetry_bytes: round(numberValue(cost.estimated_generated_telemetry_bytes) + maskBytes),
    estimated_total_telemetry_bytes: round(numberValue(cost.estimated_total_telemetry_bytes) + totalMaskBytes),
  };
}

function buildUnifiedMetadataActions({
  item,
  itemIndex,
  sliceIndex,
  linksBySliceAndId,
  hopMetadataBytes,
  compactHopMetadataBytes,
  probePacketBaseBytes,
  reportHeaderBytes,
  hopProcessingJ,
  reportProcessingJ,
  telemetryTxNjPerByte,
  scaleBudgetEnabled,
  allowedMetadataActions = new Set(["full", "compact", "selective"]),
}) {
  const mode = String(item.path.unified_planning_mode ?? "fresh");
  const planningCost = mode === "reuse" ? 0.15 : mode === "repair" ? 0.55 : 1;
  const group = `${mode}|${candidateIdentity(item.path)}`;
  const actionBase = {
    planning_mode: mode,
    planning_cost: planningCost,
    exclusion_group: group,
    source_item_index: itemIndex,
  };
  const fullProfile = standardMetadataProfile({
    enabled: true,
    hopMetadataBytes,
    reason: "unified-planner-full-metadata",
  });
  const compactProfile = unifiedCompactMetadataProfile({ hopMetadataBytes, compactHopMetadataBytes });
  const costFor = (profile, perHopMetadataBytes = [], targetMaskBytes = 0) => addInstructionMaskCost(
    estimatePathTelemetryCost({
      pathLinks: item.pathLinks,
      pathNodes: item.pathNodes,
      hopMetadataBytes: profile.effective_hop_metadata_bytes,
      perHopMetadataBytes,
      probePacketBaseBytes,
      reportHeaderBytes,
      hopProcessingJ,
      reportProcessingJ,
      telemetryTxNjPerByte,
    }),
    { targetMaskBytes, pathLinkCount: item.pathLinks.length },
  );
  const actionBytes = (cost) => numberValue(
    scaleBudgetEnabled ? cost.estimated_generated_telemetry_bytes : cost.estimated_total_telemetry_bytes,
  );
  const fullCost = costFor(fullProfile);
  const compactCost = costFor(compactProfile);
  const compactQuality = clamp(
    0.55 + 0.35 * compactProfile.compression_ratio,
    0.55,
    0.9,
  );
  const actions = [
    {
      ...actionBase,
      id: `${group}|full`,
      metadata_action: "full",
      metadata_profile: fullProfile,
      telemetry_cost: fullCost,
      telemetry_bytes: actionBytes(fullCost),
      observations: unifiedPlannerObservationsForItem({
        item,
        sliceIndex,
        linksBySliceAndId,
        metadataQuality: 1,
      }),
    },
    {
      ...actionBase,
      id: `${group}|compact`,
      metadata_action: "compact",
      metadata_profile: compactProfile,
      telemetry_cost: compactCost,
      telemetry_bytes: actionBytes(compactCost),
      observations: unifiedPlannerObservationsForItem({
        item,
        sliceIndex,
        linksBySliceAndId,
        metadataQuality: compactQuality,
      }),
    },
  ];

  const allObservations = unifiedPlannerObservationsForItem({
    item,
    sliceIndex,
    linksBySliceAndId,
    metadataQuality: 1,
  });
  if (item.pathNodes.length >= 3 && allObservations.length > 1) {
    const ranked = [...allObservations].sort((left, right) =>
      numberValue(right.uncertainty) * (1 + numberValue(right.risk)) -
        numberValue(left.uncertainty) * (1 + numberValue(left.risk)) ||
      String(left.id).localeCompare(String(right.id))
    );
    const priorityValues = ranked.map((observation) =>
      numberValue(observation.uncertainty) * (1 + numberValue(observation.risk))
    );
    const priorityThreshold = percentile(priorityValues, 0.5);
    const selectedTargets = ranked.filter((observation, index) =>
      index === 0 || numberValue(observation.uncertainty) * (1 + numberValue(observation.risk)) >= priorityThreshold
    );
    const nodeTargets = new Set(selectedTargets.filter((item) => item.type === "node").map((item) => item.id));
    const linkTargets = new Set(selectedTargets.filter((item) => item.type === "link").map((item) => item.id));
    const selectivePlan = buildPathMetadataPlan({
      pathNodes: item.pathNodes,
      pathLinks: item.pathLinks,
      nodeTargets,
      linkTargets,
      preserveCoreNodeCoverage: false,
      preserveCoreLinkMetrics: true,
      preserveNonTargetLinks: false,
    });
    const selectiveProfile = {
      profile: "unified-selective",
      observation_mode: "path-only",
      effective_hop_metadata_bytes: round(
        selectivePlan.metadata_bytes / Math.max(item.pathNodes.length, 1),
      ),
      compression_ratio: round(
        selectivePlan.metadata_bytes / Math.max(item.pathNodes.length * hopMetadataBytes, 1),
      ),
      policy: "unified-planner-selective-per-hop-metadata",
      reason: "high-uncertainty-or-risk-objects-write-metadata-others-forward-only",
    };
    const perHopBytes = selectivePlan.hops.map((hop) => numberValue(hop.metadata_bytes));
    const selectiveCost = costFor(selectiveProfile, perHopBytes, selectivePlan.target_mask_bytes);
    const observedNodes = new Set(selectivePlan.observed_node_ids.map(String));
    const observedLinks = new Set(selectivePlan.observed_link_ids.map(String));
    actions.push({
      ...actionBase,
      id: `${group}|selective`,
      metadata_action: "selective",
      metadata_profile: selectiveProfile,
      selective_metadata_plan: selectivePlan,
      telemetry_cost: selectiveCost,
      telemetry_bytes: actionBytes(selectiveCost),
      observations: allObservations.filter((observation) =>
        observation.type === "node"
          ? observedNodes.has(observation.id)
          : observedLinks.has(observation.id)
      ),
    });
  }
  return actions.filter((action) => allowedMetadataActions.has(action.metadata_action));
}

function compactMetadataProfile(profile) {
  return profile === "reuse-compact" || profile === "budget-compact";
}

function targetAwareMetadataProfile(profile) {
  return profile === "oam-target-aware";
}

function metadataBytesForPath({ pathNodes, pathLinks, metadataProfile, oamFeedback, oamControl, fallbackBytes }) {
  if (!targetAwareMetadataProfile(metadataProfile?.profile)) {
    return pathNodes.map(() => numberValue(metadataProfile?.effective_hop_metadata_bytes, fallbackBytes));
  }
  const mandatoryNodes = new Set([
    ...splitPath(oamFeedback?.mandatory_node_target_ids),
    ...splitPath(oamControl?.mandatory_node_target_ids),
  ]);
  const mandatoryLinks = new Set([
    ...splitPath(oamFeedback?.mandatory_link_target_ids),
    ...splitPath(oamControl?.mandatory_link_target_ids),
  ]);
  const targetBytes = numberValue(metadataProfile.target_hop_metadata_bytes, fallbackBytes);
  const transitBytes = numberValue(metadataProfile.transit_hop_metadata_bytes, fallbackBytes);
  return pathNodes.map((nodeId, index) => {
    const ingressLinkId = index > 0 ? pathLinks[index - 1] ?? "" : "";
    const egressLinkId = index < pathLinks.length ? pathLinks[index] ?? "" : "";
    const target = mandatoryNodes.has(nodeId) || mandatoryLinks.has(ingressLinkId) || mandatoryLinks.has(egressLinkId);
    return target ? targetBytes : transitBytes;
  });
}

function legacyRankingHopMetadataBytes({ profile, hopMetadataBytes, compactHopMetadataBytes }) {
  if (profile === "standard-light") {
    return round(clamp(Math.max(compactHopMetadataBytes, hopMetadataBytes * 0.72), compactHopMetadataBytes, hopMetadataBytes));
  }
  if (compactMetadataProfile(profile)) {
    return round(clamp(compactHopMetadataBytes, 16, hopMetadataBytes));
  }
  return hopMetadataBytes;
}

function metadataPreservationPriority(item) {
  const novelty = numberValue(item.selectedMarginal?.novelty_ratio, 1);
  const newLinkCount = numberValue(item.selectedMarginal?.new_link_count, item.pathLinks.length);
  const pathLinkCount = Math.max(item.pathLinks.length, 1);
  const informationGain = numberValue(item.selectedMarginal?.information_gain, item.base_information_gain);
  const oamTargets = numberValue(item.oamFeedback?.target_count) + numberValue(item.oamControl?.target_count);
  const risk = Math.max(numberValue(item.localAdaptive?.risk), numberValue(item.path.predicted_path_risk));
  const lengthRepresentative = clamp(pathLinkCount / 8, 0, 1);
  return (
    novelty * 1.4 +
    clamp(newLinkCount / pathLinkCount, 0, 1) * 1.1 +
    clamp(informationGain / 8, 0, 1.5) * 0.75 +
    clamp(risk, 0, 1) * 0.8 +
    Math.min(oamTargets, 1) * 1.2 +
    lengthRepresentative * 0.35
  );
}

function enforceMetadataCompressionQuota({
  selected,
  adaptiveMetadataProfileEnabled,
  adaptiveProbeBudget,
  hopMetadataBytes,
  costAwarenessWeight,
  probePacketBaseBytes,
  reportHeaderBytes,
  hopProcessingJ,
  reportProcessingJ,
  telemetryTxNjPerByte,
  topologyVersionedObjectiveEnabled,
  topologyVersionedObjectiveWeights,
  topologyVersionedConfidenceThreshold,
}) {
  const compactItems = selected.filter((item) => compactMetadataProfile(item.metadataProfile?.profile));
  if (!adaptiveMetadataProfileEnabled || compactItems.length === 0) return;
  if (adaptiveProbeBudget.adaptive_probe_budget_policy !== "oam-target-biased-metadata-reallocation") return;
  const scale = numberValue(adaptiveProbeBudget.adaptive_probe_budget_scale, 1);
  const compactRatioLimit = clamp(0.12 + Math.max(0, 1 - scale) * 0.9, 0.12, 0.28);
  const minCompactQuota = scale < 0.98 ? 6 : 2;
  const maxCompactPaths = Math.max(minCompactQuota, Math.floor(selected.length * compactRatioLimit));
  if (compactItems.length <= maxCompactPaths) return;

  const promoteCount = compactItems.length - maxCompactPaths;
  compactItems
    .sort((left, right) =>
      metadataPreservationPriority(right) - metadataPreservationPriority(left) ||
      numberValue(right.selectedMarginal?.information_gain, right.base_information_gain) -
        numberValue(left.selectedMarginal?.information_gain, left.base_information_gain),
    )
    .slice(0, promoteCount)
    .forEach((item) => {
      item.metadataProfile = standardMetadataProfile({
        enabled: adaptiveMetadataProfileEnabled,
        hopMetadataBytes,
        reason: "representative-path-preserves-neighbor-context",
      });
      item.telemetryCost = estimatePathTelemetryCost({
        pathLinks: item.pathLinks,
        pathNodes: splitPath(item.path.path),
        hopMetadataBytes: item.metadataProfile.effective_hop_metadata_bytes,
        probePacketBaseBytes,
        reportHeaderBytes,
        hopProcessingJ,
        reportProcessingJ,
        telemetryTxNjPerByte,
      });
      const marginal = item.selectedMarginal ?? {
        information_gain: item.base_information_gain,
        base_information_gain: item.base_information_gain,
      };
      item.selectedCostScore = costAwarePathScore({
        score: item.score,
        informationGain: marginal.information_gain,
        cost: item.telemetryCost,
        forecastProfile: item.forecastProfile,
        diversity: numberValue(marginal.novelty_ratio, 1),
        oamFeedback: item.oamFeedback,
        oamControl: item.oamControl,
        weight: costAwarenessWeight,
      });
    });
}

function costAwarePathScore({ score, informationGain, cost, forecastProfile, diversity, oamFeedback, oamControl, weight }) {
  const totalKb = Math.max(numberValue(cost.estimated_total_telemetry_bytes) / 1024, 0.1);
  const positiveValue =
    Math.max(numberValue(informationGain, score), 0) +
    diversity * 0.4 +
    numberValue(forecastProfile.forecast_priority_score) * 0.45 +
    numberValue(forecastProfile.forecast_near_outage_score) * 0.25 +
    numberValue(oamFeedback.score) * 0.2 +
    numberValue(oamControl.score) * 0.18;
  const valuePerKb = positiveValue / totalKb;
  const costPenalty = clamp(totalKb / 24, 0, 1.2) * weight;
  const efficiencyBonus = clamp(valuePerKb / 4, 0, 0.35) * weight;
  return {
    cost_aware_score: round(valuePerKb),
    score_formula: "information_gain_per_telemetry_kb",
    score_numerator_information_gain: round(positiveValue),
    score_denominator_telemetry_kb: round(totalKb),
    value_per_kb: round(valuePerKb),
    cost_penalty: round(costPenalty),
    efficiency_bonus: round(efficiencyBonus),
  };
}

function localAdaptiveSamplingProfile({
  enabled,
  pathLinks,
  sliceIndex,
  linksBySliceAndId,
  forecastProfile,
  oamFeedback,
  oamControl,
  candidateSource,
}) {
  if (!enabled) {
    return {
      risk: 0,
      policy: "disabled",
      reason: "local-adaptive-sampling-disabled",
      score_bonus: 0,
      dominant_link_id: "",
      dominant_link_risk: 0,
      high_risk_link_count: 0,
    };
  }
  const linkRisks = pathLinks.map((linkId) => {
    const link = linksBySliceAndId.get(`${sliceIndex}|${linkId}`) ?? {};
    const utilization = numberValue(link.utilization_percent, 0);
    const congestion = numberValue(link.congestion_percent, 0);
    const queueLatency = numberValue(link.queue_latency_ms, 0);
    const droppedTraffic = numberValue(link.dropped_traffic_mb, 0);
    const packetErrorRate = numberValue(link.packet_error_rate, 0);
    const availability = linkAvailability(link);
    const warning = String(link.status || "").toLowerCase() === "warning" ? 0.1 : 0;
    const risk = clamp(
      clamp((utilization - 55) / 45, 0, 1) * 0.34 +
        clamp(congestion / 60, 0, 1) * 0.2 +
        clamp(queueLatency / 50, 0, 1) * 0.16 +
        clamp(droppedTraffic / 5, 0, 1) * 0.11 +
        clamp(packetErrorRate / 0.05, 0, 1) * 0.09 +
        clamp(1 - availability, 0, 1) * 0.1 +
        warning,
      0,
      1,
    );
    const reasons = [
      utilization >= 70 ? "high-utilization" : "",
      congestion > 0 ? "congestion" : "",
      queueLatency >= 20 ? "queue-latency" : "",
      droppedTraffic > 0 ? "dropped-traffic" : "",
      packetErrorRate >= 0.02 ? "packet-error" : "",
      availability < 0.9 ? "low-availability" : "",
      warning ? "warning-status" : "",
    ].filter(Boolean);
    return { link_id: linkId, risk, reasons };
  });
  const maxRiskItem = linkRisks.reduce((best, item) => (item.risk > best.risk ? item : best), { link_id: "", risk: 0, reasons: [] });
  const meanRisk = mean(linkRisks.map((item) => item.risk));
  const forecastRisk = clamp(
    numberValue(forecastProfile.forecast_near_outage_score) * 0.45 +
      numberValue(forecastProfile.forecast_transition_score) * 0.25 +
      numberValue(forecastProfile.forecast_contact_scarcity_score) * 0.2,
    0,
    0.4,
  );
  const oamRisk = clamp(
    numberValue(oamFeedback.score) * 0.16 +
      numberValue(oamControl.score) * 0.14 +
      numberValue(oamControl.pressure) * 0.18,
    0,
    0.35,
  );
  const risk = clamp(maxRiskItem.risk * 0.68 + meanRisk * 0.18 + forecastRisk + oamRisk, 0, 1);
  const reasons = unique([
    ...linkRisks.flatMap((item) => item.reasons),
    forecastRisk > 0.15 ? "forecast-risk" : "",
    oamRisk > 0.12 ? "oam-risk" : "",
    candidateSource === "topology-reuse-cache" && risk < 0.18 ? "stable-reuse-low-risk" : "",
  ].filter(Boolean));
  const policy = risk >= 0.6
    ? "local-risk-priority"
    : risk >= 0.35
      ? "local-watchlist-priority"
      : candidateSource === "topology-reuse-cache"
        ? "low-risk-sparse"
        : "normal";
  const scoreBonus = risk >= 0.6
    ? 0.85 + risk * 0.45
    : risk >= 0.35
      ? 0.32 + risk * 0.22
      : candidateSource === "topology-reuse-cache"
        ? -0.08
        : 0;
  return {
    risk: round(risk),
    policy,
    reason: reasons.join(" > ") || "nominal",
    score_bonus: round(scoreBonus),
    dominant_link_id: maxRiskItem.link_id,
    dominant_link_risk: round(maxRiskItem.risk),
    high_risk_link_count: linkRisks.filter((item) => item.risk >= 0.6).length,
  };
}

function buildEnergyAwareSamplingBudget({
  scored,
  selectionStrategy,
  samplingRate,
  targetActiveLinkSamplingRate,
  minPaths,
  candidatePathCount,
  activeLinkCount,
  baseRequestedPathCount,
  baseTargetCoveredLinks,
  baseSelectedLimit,
  energyBudgetEnabled,
  energyBudgetMinActiveLinkSamplingRate,
  energyBudgetMaxReduction,
  slicePlan,
}) {
  const baseBudget = {
    energy_budget_enabled: Boolean(energyBudgetEnabled),
    energy_budget_policy: energyBudgetEnabled ? "energy-aware-slice-budget" : "disabled",
    energy_budget_reason: energyBudgetEnabled ? "nominal-energy-budget" : "energy-budget-disabled",
    energy_budget_scale: 1,
    energy_budget_pressure: 0,
    energy_budget_critical_coverage_credit: 0,
    effective_sampling_rate: samplingRate,
    effective_target_active_link_sampling_rate: targetActiveLinkSamplingRate,
    base_requested_paths: baseRequestedPathCount,
    energy_budget_requested_paths: baseRequestedPathCount,
    base_target_covered_links: baseTargetCoveredLinks,
    energy_budget_target_covered_links: baseTargetCoveredLinks,
    base_selected_limit: baseSelectedLimit,
    energy_budget_selected_limit: baseSelectedLimit,
    energy_budget_suppressed_paths: 0,
    energy_budget_deferred_active_links: 0,
    energy_budget_mean_path_energy_risk: round(mean(scored.map((item) => item.energyRisk))),
    energy_budget_shadow_node_ratio: 0,
    energy_budget_low_energy_node_ratio: 0,
    energy_budget_low_solar_node_ratio: 0,
    energy_budget_power_saving_node_ratio: 0,
    energy_budget_power_deficit_pressure: 0,
  };
  if (!energyBudgetEnabled || selectionStrategy === "full-int" || scored.length === 0) {
    return {
      ...baseBudget,
      energy_budget_policy: selectionStrategy === "full-int"
        ? "full-int-baseline-no-throttle"
        : baseBudget.energy_budget_policy,
      energy_budget_reason: selectionStrategy === "full-int"
        ? "full-int-baseline-preserves-upper-bound"
        : baseBudget.energy_budget_reason,
    };
  }

  const nodeVisits = Math.max(1, scored.reduce((total, item) => total + Math.max(numberValue(item.pathNodeCount), 0), 0));
  const shadowRatio = scored.reduce((total, item) => total + item.energyProfile.shadow_nodes, 0) / nodeVisits;
  const lowEnergyRatio = scored.reduce((total, item) => total + item.energyProfile.low_energy_nodes, 0) / nodeVisits;
  const lowSolarRatio = scored.reduce((total, item) => total + item.energyProfile.low_solar_nodes, 0) / nodeVisits;
  const powerSavingRatio = scored.reduce((total, item) => total + item.energyProfile.power_saving_nodes, 0) / nodeVisits;
  const meanEnergyRisk = mean(scored.map((item) => item.energyRisk));
  const meanPowerMarginW = mean(scored.map((item) => item.energyProfile.mean_power_margin_w).filter(Number.isFinite));
  const powerDeficitPressure = clamp((-meanPowerMarginW) / 180, 0, 1);
  const energyPressure = clamp(
    meanEnergyRisk * 0.42 +
      shadowRatio * 0.22 +
      lowEnergyRatio * 0.16 +
      lowSolarRatio * 0.12 +
      powerSavingRatio * 0.05 +
      powerDeficitPressure * 0.03,
    0,
    1,
  );
  const criticalCoverageCredit = clamp(
    numberValue(slicePlan.oam_replan_pressure) * 0.18 +
      numberValue(slicePlan.oam_control_pressure) * 0.18 +
      (slicePlan.oam_replan_triggered ? 0.08 : 0) +
      (slicePlan.oam_control_replan_triggered ? 0.08 : 0),
    0,
    0.35,
  );
  const minTargetRate = Math.min(
    Math.max(0, targetActiveLinkSamplingRate),
    Math.max(0, energyBudgetMinActiveLinkSamplingRate),
  );
  const minScale = targetActiveLinkSamplingRate > 0
    ? clamp(minTargetRate / targetActiveLinkSamplingRate, 0, 1)
    : 0;
  const scale = clamp(1 - energyPressure * energyBudgetMaxReduction + criticalCoverageCredit, minScale, 1);
  const effectiveTargetRate = clamp(targetActiveLinkSamplingRate * scale, minTargetRate, targetActiveLinkSamplingRate);
  const minSamplingRate = candidatePathCount > 0 ? Math.min(1, minPaths / candidatePathCount) : 0;
  const effectiveSamplingRate = clamp(samplingRate * scale, minSamplingRate, samplingRate);
  const requestedPaths = Math.min(
    baseSelectedLimit,
    Math.max(minPaths, Math.ceil(candidatePathCount * effectiveSamplingRate)),
  );
  const targetCoveredLinks = activeLinkCount > 0 ? Math.ceil(activeLinkCount * effectiveTargetRate) : 0;
  const selectedLimit = Math.min(
    baseSelectedLimit,
    Math.max(
      requestedPaths,
      Math.min(baseSelectedLimit, Math.ceil(baseSelectedLimit * Math.max(scale, minSamplingRate))),
    ),
  );
  const reasons = [
    energyPressure > 0.25 ? "throttle-high-energy-pressure" : "",
    shadowRatio > 0.25 ? "shadow-region" : "",
    lowEnergyRatio > 0 ? "low-energy-nodes" : "",
    lowSolarRatio > 0.3 ? "low-solar-exposure" : "",
    powerDeficitPressure > 0.2 ? "negative-power-margin" : "",
    criticalCoverageCredit > 0.05 ? "preserve-oam-critical-coverage" : "",
  ].filter(Boolean);

  return {
    ...baseBudget,
    energy_budget_reason: reasons.length ? reasons.join(" > ") : "nominal-energy-budget",
    energy_budget_scale: round(scale),
    energy_budget_pressure: round(energyPressure),
    energy_budget_critical_coverage_credit: round(criticalCoverageCredit),
    effective_sampling_rate: round(effectiveSamplingRate),
    effective_target_active_link_sampling_rate: round(effectiveTargetRate),
    energy_budget_requested_paths: requestedPaths,
    energy_budget_target_covered_links: targetCoveredLinks,
    energy_budget_selected_limit: selectedLimit,
    energy_budget_suppressed_paths: Math.max(0, baseRequestedPathCount - requestedPaths),
    energy_budget_deferred_active_links: Math.max(0, baseTargetCoveredLinks - targetCoveredLinks),
    energy_budget_mean_path_energy_risk: round(meanEnergyRisk),
    energy_budget_shadow_node_ratio: round(shadowRatio),
    energy_budget_low_energy_node_ratio: round(lowEnergyRatio),
    energy_budget_low_solar_node_ratio: round(lowSolarRatio),
    energy_budget_power_saving_node_ratio: round(powerSavingRatio),
    energy_budget_power_deficit_pressure: round(powerDeficitPressure),
  };
}

function normalizeSelectionStrategy(value) {
  const text = String(value || "int-mc-leverage").toLowerCase();
  if (["full", "full-int", "full-probe", "all-probes", "all"].includes(text)) return "full-int";
  if (["random", "random-sampling", "deterministic-random"].includes(text)) return "random-sampling";
  if (["shortest", "shortest-path", "min-hop"].includes(text)) return "shortest-path";
  if (["topology", "topology-aware"].includes(text)) return "topology-aware";
  if (["orbit", "orbit-predicted", "prediction-aware", "contact-plan-aware"].includes(text)) return "orbit-predicted";
  return "int-mc-leverage";
}

function repairCandidatePath({ path, activeSet, graph, linksBySliceAndId, requiredNodeIds = new Set() }) {
  const originalLinkIds = splitPath(path.link_ids);
  const originalNodes = splitPath(path.path);
  const source = path.source || originalNodes[0] || "";
  const sink = path.sink || originalNodes[originalNodes.length - 1] || "";
  const originalUsable = originalLinkIds.length > 0 && originalLinkIds.every((linkId) => activeSet.has(linkId));
  if (originalUsable) {
    const pathLinks = unique(originalLinkIds);
    return {
      ...path,
      pathLinks,
      planning_repair_count: 0,
      predicted_path_risk: pathRisk({ sliceIndex: path.slice_index, linkIds: pathLinks, linksBySliceAndId }),
    };
  }

  const unifiedPlanningMode = String(path.unified_planning_mode ?? "");
  if (
    unifiedPlanningMode === "reuse" ||
    unifiedPlanningMode === "fresh" ||
    (unifiedPlanningMode === "repair" && boolValue(path.unified_fast_repair_no_reroute))
  ) return null;

  const targetPreservingRepair = buildTargetPreservingRepair({
    graph,
    source,
    sink,
    originalNodes,
    requiredNodeIds,
    shortestPath,
  });
  const repaired = targetPreservingRepair ?? shortestPath(graph, source, sink);
  if (!repaired || repaired.linkIds.length === 0) return null;
  const pathLinks = unique(repaired.linkIds);
  return {
    ...path,
    path_node_count: repaired.nodes.length,
    path_link_count: repaired.linkIds.length,
    covered_link_count: pathLinks.length,
    path: repaired.nodes.join(" > "),
    link_ids: repaired.linkIds.join(" > "),
    pathLinks,
    planning_repair_count: 1,
    planning_target_preserving_repair: Boolean(targetPreservingRepair),
    planning_preserved_importance_target_ids: targetPreservingRepair?.preservedTargetIds?.join(" > ") ?? "",
    predicted_path_risk: pathRisk({ sliceIndex: path.slice_index, linkIds: pathLinks, linksBySliceAndId }),
    original_unrepaired_path: path.path,
    original_unrepaired_link_ids: path.link_ids,
  };
}

function adaptCandidatePath(path, slicePlan, candidateSource) {
  return {
    ...path,
    slice_index: slicePlan.slice_index,
    time: slicePlan.time,
    reused_candidate_source: candidateSource,
  };
}

function activeLinkIdsForPath(path, activeSet) {
  if (Array.isArray(path.pathLinks)) return path.pathLinks.filter((linkId) => activeSet.has(linkId));
  return splitPath(path.link_ids).filter((linkId, index, list) => linkId && activeSet.has(linkId) && list.indexOf(linkId) === index);
}

function stablePathStructure({ path, activeSet, cache }) {
  const cacheKey = `${path.path ?? ""}|${path.link_ids ?? ""}`;
  const cached = cache?.get(cacheKey);
  if (cached) {
    return {
      ...cached,
      pathLinks: cached.pathLinks.filter((linkId) => activeSet.has(linkId)),
      cacheHit: true,
    };
  }
  const structure = {
    cacheKey,
    pathLinks: activeLinkIdsForPath(path, activeSet),
    pathNodes: splitPath(path.path),
  };
  cache?.set(cacheKey, structure);
  return { ...structure, cacheHit: false };
}

function buildSamplingMask({
  planningLinks,
  selectedRows,
  contactPlan,
  summaryRows,
  leverageScores,
  forecastBySliceAndLink,
  samplingRate,
  targetActiveLinkSamplingRate,
  selectionStrategy,
  predictionScoreHorizon,
}) {
  const selectedBySliceAndLink = new Map();
  selectedRows.forEach((row) => {
    splitPath(row.unified_observed_link_ids || row.link_ids).forEach((linkId) => {
      const key = `${row.slice_index}|${linkId}`;
      const old = selectedBySliceAndLink.get(key) ?? {
        probe_count: 0,
        probe_ids: [],
        first_probe_id: "",
        planning_reuse_mode: row.planning_reuse_mode ?? "",
        candidate_source: row.candidate_source ?? "",
        topology_reuse_decision: row.topology_reuse_decision ?? "",
      };
      old.probe_count += 1;
      old.probe_ids.push(row.probe_id);
      if (!old.first_probe_id) old.first_probe_id = row.probe_id;
      selectedBySliceAndLink.set(key, old);
    });
  });

  const slicePlanByIndex = new Map(contactPlan.perSlice.map((slicePlan) => [String(slicePlan.slice_index), slicePlan]));
  const summaryBySlice = new Map(summaryRows.map((row) => [String(row.slice_index), row]));
  return planningLinks
    .map((link) => {
      const key = `${link.slice_index}|${link.link_id}`;
      const selected = selectedBySliceAndLink.get(key);
      const active = planningActive(link);
      const sampled = Boolean(selected);
      const slicePlan = slicePlanByIndex.get(String(link.slice_index)) ?? {};
      const sliceSummary = summaryBySlice.get(String(link.slice_index)) ?? {};
      const leverage = leverageScores.get(link.link_id) ?? { leverage: 1, transition_rate: 0 };
      const forecast = forecastForLink(forecastBySliceAndLink, link.slice_index, link.link_id, predictionScoreHorizon);
      const slicePlanningMode = slicePlan.topology_reused_from_class
        ? "cache-reuse-with-validation"
        : slicePlan.topology_reuse_decision === "oam-feedback-refresh-replan" ||
            slicePlan.topology_reuse_decision === "oam-control-refresh-replan"
          ? "oam-forced-fresh-replan"
          : "fresh-replan";
      const completionRole = !active
        ? "topology-down-mask"
        : sampled
          ? "planned-sampled"
          : "active-unobserved-to-complete";
      return {
        slice_index: Number(link.slice_index),
        time: link.time,
        link_id: link.link_id,
        source: link.source,
        target: link.target,
        kind: link.kind,
        topology_class_id: slicePlan.topology_class_id ?? "",
        topology_signature: slicePlan.topology_signature ?? "",
        topology_version_id: slicePlan.topology_version_id ?? "",
        topology_forecast_horizon_slices: slicePlan.topology_forecast_horizon_slices ?? "",
        topology_forecast_stable_window_slices: slicePlan.topology_forecast_stable_window_slices ?? "",
        topology_forecast_next_major_drift_in_slices: slicePlan.topology_forecast_next_major_drift_in_slices ?? "",
        topology_forecast_mean_similarity: slicePlan.topology_forecast_mean_similarity ?? "",
        topology_forecast_min_similarity: slicePlan.topology_forecast_min_similarity ?? "",
        topology_forecast_drift_pressure: slicePlan.topology_forecast_drift_pressure ?? "",
        topology_forecast_reuse_confidence: slicePlan.topology_forecast_reuse_confidence ?? "",
        topology_forecast_recommended_plan_mode: slicePlan.topology_forecast_recommended_plan_mode ?? "",
        topology_forecast_target_sampling_boost: sliceSummary.topology_forecast_target_sampling_boost ?? "",
        topology_reuse_decision: slicePlan.topology_reuse_decision ?? "",
        topology_similarity_score: slicePlan.topology_similarity_score ?? "",
        planning_reuse_mode: selected?.planning_reuse_mode ?? slicePlanningMode,
        planning_cache_hit: selected?.planning_reuse_mode === "cache-reuse-with-validation",
        candidate_source: selected?.candidate_source ?? "",
        predicted_active: active,
        active_mask_value: active ? 1 : 0,
        sampled_by_probe_plan: sampled,
        sampling_mask_value: active && sampled ? 1 : 0,
        completion_role: completionRole,
        selected_probe_count: selected?.probe_count ?? 0,
        selected_probe_ids: selected?.probe_ids.join(" > ") ?? "",
        first_probe_id: selected?.first_probe_id ?? "",
        sampling_rate: samplingRate,
        target_active_link_sampling_rate: targetActiveLinkSamplingRate,
        configured_sampling_rate: sliceSummary.configured_sampling_rate ?? samplingRate,
        configured_target_active_link_sampling_rate: sliceSummary.configured_target_active_link_sampling_rate ?? targetActiveLinkSamplingRate,
        oam_budget_applied: sliceSummary.oam_budget_applied ?? "",
        oam_budget_policy: sliceSummary.oam_budget_policy ?? "",
        oam_budget_action: sliceSummary.oam_budget_action ?? "",
        oam_budget_reason: sliceSummary.oam_budget_reason ?? "",
        oam_budget_source: sliceSummary.oam_budget_source ?? "",
        oam_recommended_sampling_rate: sliceSummary.oam_recommended_sampling_rate ?? "",
        oam_recommended_target_active_link_sampling_rate: sliceSummary.oam_recommended_target_active_link_sampling_rate ?? "",
        oam_recommended_telemetry_byte_budget_per_slice: sliceSummary.oam_recommended_telemetry_byte_budget_per_slice ?? "",
        oam_recommended_downlink_budget_bytes: sliceSummary.oam_recommended_downlink_budget_bytes ?? "",
        oam_coverage_demand_pressure: sliceSummary.oam_coverage_demand_pressure ?? "",
        effective_sampling_rate: sliceSummary.effective_sampling_rate ?? samplingRate,
        effective_target_active_link_sampling_rate: sliceSummary.effective_target_active_link_sampling_rate ?? targetActiveLinkSamplingRate,
        energy_budget_enabled: sliceSummary.energy_budget_enabled ?? "",
        energy_budget_policy: sliceSummary.energy_budget_policy ?? "",
        energy_budget_reason: sliceSummary.energy_budget_reason ?? "",
        energy_budget_scale: sliceSummary.energy_budget_scale ?? "",
        energy_budget_pressure: sliceSummary.energy_budget_pressure ?? "",
        energy_budget_critical_coverage_credit: sliceSummary.energy_budget_critical_coverage_credit ?? "",
        energy_budget_requested_paths: sliceSummary.energy_budget_requested_paths ?? "",
        base_requested_paths: sliceSummary.base_requested_paths ?? "",
        energy_budget_target_covered_links: sliceSummary.energy_budget_target_covered_links ?? "",
        base_target_covered_links: sliceSummary.base_target_covered_links ?? "",
        energy_budget_selected_limit: sliceSummary.energy_budget_selected_limit ?? "",
        base_selected_limit: sliceSummary.base_selected_limit ?? "",
        energy_budget_suppressed_paths: sliceSummary.energy_budget_suppressed_paths ?? "",
        energy_budget_deferred_active_links: sliceSummary.energy_budget_deferred_active_links ?? "",
        energy_budget_mean_path_energy_risk: sliceSummary.energy_budget_mean_path_energy_risk ?? "",
        energy_budget_shadow_node_ratio: sliceSummary.energy_budget_shadow_node_ratio ?? "",
        energy_budget_low_energy_node_ratio: sliceSummary.energy_budget_low_energy_node_ratio ?? "",
        energy_budget_low_solar_node_ratio: sliceSummary.energy_budget_low_solar_node_ratio ?? "",
        energy_budget_power_saving_node_ratio: sliceSummary.energy_budget_power_saving_node_ratio ?? "",
        energy_budget_power_deficit_pressure: sliceSummary.energy_budget_power_deficit_pressure ?? "",
        telemetry_byte_budget_enabled: sliceSummary.telemetry_byte_budget_enabled ?? "",
        telemetry_byte_budget_per_slice: sliceSummary.telemetry_byte_budget_per_slice ?? "",
        telemetry_budget_policy: sliceSummary.telemetry_budget_policy ?? "",
        telemetry_budget_used_bytes: sliceSummary.telemetry_budget_used_bytes ?? "",
        telemetry_budget_remaining_bytes: sliceSummary.telemetry_budget_remaining_bytes ?? "",
        telemetry_budget_overrun_bytes: sliceSummary.telemetry_budget_overrun_bytes ?? "",
        telemetry_budget_utilization: sliceSummary.telemetry_budget_utilization ?? "",
        telemetry_budget_suppressed_paths: sliceSummary.telemetry_budget_suppressed_paths ?? "",
        telemetry_budget_override_paths: sliceSummary.telemetry_budget_override_paths ?? "",
        selection_strategy: selectionStrategy,
        leverage_score: round(leverage.leverage),
        transition_rate: round(leverage.transition_rate),
        forecast_horizon_slices: forecast.forecast_horizon_slices,
        forecast_observed_slices: forecast.forecast_observed_slices,
        forecast_transition_count: forecast.forecast_transition_count,
        forecast_transition_score: forecast.forecast_transition_score,
        forecast_active_fraction: forecast.forecast_active_fraction,
        forecast_future_active_fraction: forecast.forecast_future_active_fraction,
        forecast_mean_availability: forecast.forecast_mean_availability,
        forecast_min_availability: forecast.forecast_min_availability,
        forecast_first_change_in_slices: forecast.forecast_first_change_in_slices,
        forecast_first_down_in_slices: forecast.forecast_first_down_in_slices,
        forecast_first_up_in_slices: forecast.forecast_first_up_in_slices,
        forecast_near_change_score: forecast.forecast_near_change_score,
        forecast_near_outage_score: forecast.forecast_near_outage_score,
        forecast_contact_scarcity_score: forecast.forecast_contact_scarcity_score,
        forecast_availability_risk: forecast.forecast_availability_risk,
        forecast_priority_score: forecast.forecast_priority_score,
        p_available: round(linkAvailability(link)),
        distance_km: round(numberValue(link.distance_km)),
        utilization_percent: round(numberValue(link.utilization_percent)),
        congestion_percent: round(numberValue(link.congestion_percent)),
        latency_ms: round(numberValue(link.latency_ms)),
        capacity_mbps: round(numberValue(link.effective_capacity_mbps || link.capacity_mbps)),
        route_path_jaccard: slicePlan.route_path_jaccard ?? "",
        link_state_similarity: slicePlan.link_state_similarity ?? "",
        adaptive_reuse_threshold: slicePlan.adaptive_reuse_threshold ?? "",
        adaptive_threshold_base: slicePlan.adaptive_threshold_base ?? "",
        adaptive_threshold_policy: slicePlan.adaptive_threshold_policy ?? "",
        adaptive_threshold_reason: slicePlan.adaptive_threshold_reason ?? "",
        adaptive_threshold_total_tightening: slicePlan.adaptive_threshold_total_tightening ?? "",
        adaptive_threshold_total_relaxation: slicePlan.adaptive_threshold_total_relaxation ?? "",
        adaptive_threshold_volatility_penalty: slicePlan.adaptive_threshold_volatility_penalty ?? "",
        adaptive_threshold_bottleneck_penalty: slicePlan.adaptive_threshold_bottleneck_penalty ?? "",
        adaptive_threshold_load_penalty: slicePlan.adaptive_threshold_load_penalty ?? "",
        adaptive_threshold_contact_uncertainty_penalty: slicePlan.adaptive_threshold_contact_uncertainty_penalty ?? "",
        adaptive_threshold_structural_drift_penalty: slicePlan.adaptive_threshold_structural_drift_penalty ?? "",
        adaptive_threshold_link_state_drift_penalty: slicePlan.adaptive_threshold_link_state_drift_penalty ?? "",
        adaptive_threshold_route_drift_penalty: slicePlan.adaptive_threshold_route_drift_penalty ?? "",
        adaptive_threshold_oam_pressure_penalty: slicePlan.adaptive_threshold_oam_pressure_penalty ?? "",
        adaptive_threshold_stability_credit: slicePlan.adaptive_threshold_stability_credit ?? "",
        adaptive_threshold_overhead_credit: slicePlan.adaptive_threshold_overhead_credit ?? "",
        adaptive_threshold_calibration_policy: slicePlan.adaptive_threshold_calibration_policy ?? "",
        adaptive_threshold_calibration_evidence_count: slicePlan.adaptive_threshold_calibration_evidence_count ?? "",
        adaptive_threshold_calibration_candidate_class_count: slicePlan.adaptive_threshold_calibration_candidate_class_count ?? "",
        adaptive_threshold_calibration_future_window_slices: slicePlan.adaptive_threshold_calibration_future_window_slices ?? "",
        adaptive_threshold_calibration_best_second_gap: slicePlan.adaptive_threshold_calibration_best_second_gap ?? "",
        adaptive_threshold_calibration_near_best_class_count: slicePlan.adaptive_threshold_calibration_near_best_class_count ?? "",
        adaptive_threshold_calibration_near_threshold_class_count: slicePlan.adaptive_threshold_calibration_near_threshold_class_count ?? "",
        adaptive_threshold_calibration_class_density: slicePlan.adaptive_threshold_calibration_class_density ?? "",
        adaptive_threshold_calibration_similarity_p50: slicePlan.adaptive_threshold_calibration_similarity_p50 ?? "",
        adaptive_threshold_calibration_similarity_p90: slicePlan.adaptive_threshold_calibration_similarity_p90 ?? "",
        adaptive_threshold_calibration_future_mean_similarity: slicePlan.adaptive_threshold_calibration_future_mean_similarity ?? "",
        adaptive_threshold_calibration_future_min_similarity: slicePlan.adaptive_threshold_calibration_future_min_similarity ?? "",
        adaptive_threshold_calibration_ambiguity_penalty: slicePlan.adaptive_threshold_calibration_ambiguity_penalty ?? "",
        adaptive_threshold_calibration_future_drift_penalty: slicePlan.adaptive_threshold_calibration_future_drift_penalty ?? "",
        adaptive_threshold_calibration_separation_credit: slicePlan.adaptive_threshold_calibration_separation_credit ?? "",
        adaptive_threshold_calibration_future_stability_credit: slicePlan.adaptive_threshold_calibration_future_stability_credit ?? "",
        adaptive_threshold_calibration_sample_support_credit: slicePlan.adaptive_threshold_calibration_sample_support_credit ?? "",
        adaptive_threshold_calibration_evidence_confidence: slicePlan.adaptive_threshold_calibration_evidence_confidence ?? "",
        adaptive_threshold_calibration_net_adjustment: slicePlan.adaptive_threshold_calibration_net_adjustment ?? "",
        topology_reuse_margin: slicePlan.topology_reuse_margin ?? "",
        oam_feedback_pressure: slicePlan.oam_feedback_pressure ?? "",
        oam_replan_pressure: slicePlan.oam_replan_pressure ?? "",
        oam_control_action: slicePlan.oam_control_action ?? "",
        oam_control_probe_bias: slicePlan.oam_control_probe_bias ?? "",
        oam_control_confidence_budget: slicePlan.oam_control_confidence_budget ?? "",
        oam_control_pressure: slicePlan.oam_control_pressure ?? "",
        oam_control_replan_pressure_threshold: slicePlan.oam_control_replan_pressure_threshold ?? "",
        oam_control_replan_triggered: slicePlan.oam_control_replan_triggered ?? "",
        oam_control_priority_retest_targets: slicePlan.oam_control_priority_retest_targets ?? "",
        oam_control_unknown_pressure: slicePlan.oam_control_unknown_pressure ?? "",
        oam_control_stale_pressure: slicePlan.oam_control_stale_pressure ?? "",
        oam_control_prior_estimate_pressure: slicePlan.oam_control_prior_estimate_pressure ?? "",
        oam_control_low_confidence_pressure: slicePlan.oam_control_low_confidence_pressure ?? "",
        oam_control_conflict_pressure: slicePlan.oam_control_conflict_pressure ?? "",
        oam_control_downlink_pressure: slicePlan.oam_control_downlink_pressure ?? "",
        oam_control_retest_pressure: slicePlan.oam_control_retest_pressure ?? "",
        energy_sensitive_context: link.kind === "star-ground" || link.kind === "inter-plane" ? "yes" : "no",
      };
    })
    .sort((left, right) =>
      Number(left.slice_index) - Number(right.slice_index) ||
      left.link_id.localeCompare(right.link_id),
    );
}

function buildOamFeedbackBySlice(rows) {
  const map = new Map();
  rows.forEach((row) => {
    const sliceIndex = String(row.slice_index);
    const score = numberValue(row.priority_score);
    if (!sliceIndex || !row.target_id || score <= 0) return;
    if (!map.has(sliceIndex)) {
      map.set(sliceIndex, {
        nodes: new Map(),
        links: new Map(),
      });
    }
    const bucket = map.get(sliceIndex);
    const targetMap = row.target_type === "link" ? bucket.links : bucket.nodes;
    const old = targetMap.get(row.target_id) ?? {
      target_id: row.target_id,
      priority_score: 0,
      confidence_pressure: 0,
      completion_error_score: 0,
      reason: row.reason ?? "",
      observation_source: row.observation_source ?? "",
    };
    old.priority_score = Math.max(old.priority_score, score);
    old.confidence_pressure = Math.max(old.confidence_pressure, numberValue(row.confidence_pressure));
    old.completion_error_score = Math.max(old.completion_error_score, numberValue(row.completion_error_score));
    old.reason = old.reason || row.reason || "";
    old.observation_source = old.observation_source || row.observation_source || "";
    targetMap.set(row.target_id, old);
  });
  return map;
}

function oamFeedbackForPath({ sliceIndex, pathLinks, pathNodes, oamFeedbackBySlice }) {
  const feedback = oamFeedbackBySlice.get(String(sliceIndex));
  if (!feedback) {
    return {
      score: 0,
      target_count: 0,
      link_target_count: 0,
      node_target_count: 0,
      mandatory_target_count: 0,
      mandatory_link_target_count: 0,
      mandatory_node_target_count: 0,
      target_ids: "",
      mandatory_target_ids: "",
      mandatory_link_target_ids: "",
      mandatory_node_target_ids: "",
      reasons: "",
    };
  }
  const linkHits = pathLinks
    .map((linkId) => feedback.links.get(linkId))
    .filter(Boolean);
  const nodeHits = pathNodes
    .map((nodeId) => feedback.nodes.get(nodeId))
    .filter(Boolean);
  const hits = [...linkHits, ...nodeHits];
  const mandatoryLinkHits = linkHits.filter((item) => isMandatoryOamFeedbackTarget(item));
  const mandatoryNodeHits = nodeHits.filter((item) => isMandatoryOamFeedbackTarget(item));
  const mandatoryHits = [...mandatoryLinkHits, ...mandatoryNodeHits];
  const rawScore = hits.reduce((total, item) => total + oamFeedbackSelectionScore(item), 0);
  return {
    score: round(rawScore),
    target_count: hits.length,
    link_target_count: linkHits.length,
    node_target_count: nodeHits.length,
    mandatory_target_count: mandatoryHits.length,
    mandatory_link_target_count: mandatoryLinkHits.length,
    mandatory_node_target_count: mandatoryNodeHits.length,
    target_ids: unique(hits.map((item) => item.target_id)).join(" > "),
    mandatory_target_ids: unique(mandatoryHits.map((item) => item.target_id)).join(" > "),
    mandatory_link_target_ids: unique(mandatoryLinkHits.map((item) => item.target_id)).join(" > "),
    mandatory_node_target_ids: unique(mandatoryNodeHits.map((item) => item.target_id)).join(" > "),
    reasons: unique(hits.map((item) => item.reason)).join(" > "),
  };
}

function oamControlForPath({ sliceIndex, pathLinks, pathNodes, oamControlBySlice }) {
  const control = oamControlForSlice(oamControlBySlice, sliceIndex);
  const mandatoryControl = isMandatoryOamControl(control);
  const targetLinks = new Set(splitPath(control.top_link_targets));
  const targetNodes = new Set(splitPath(control.top_node_targets));
  const linkHits = pathLinks.filter((linkId) => targetLinks.has(linkId));
  const nodeHits = pathNodes.filter((nodeId) => targetNodes.has(nodeId));
  const hitCount = linkHits.length + nodeHits.length;
  const hitsOamTarget = hitCount > 0;
  const globalPressureScore = hitsOamTarget
    ? control.oam_control_pressure * 0.65
    : control.recommended_action === "refresh-probe-plan"
      ? control.oam_control_pressure * 0.22
      : control.oam_control_pressure * 0.15;
  const actionBoost = !hitsOamTarget
    ? 0
    : control.recommended_action === "refresh-probe-plan"
    ? 0.35
    : control.recommended_action === "schedule-priority-retest"
      ? 0.22
      : 0;
  const biasBoost = hitsOamTarget && control.probe_bias === "bias-paths-to-oam-targets" ? 0.18 : 0;
  const targetHitBoost = hitCount > 0 ? Math.min(0.45, hitCount * 0.12) : 0;
  const score = globalPressureScore + actionBoost + biasBoost + targetHitBoost;
  return {
    score: round(score),
    pressure: control.oam_control_pressure,
    action: control.recommended_action,
    probe_bias: control.probe_bias,
    confidence_budget: control.confidence_budget,
    source_slice_index: control.control_source_slice_index,
    target_slice_index: control.control_target_slice_index,
    next_slice_applied: Boolean(control.control_source_slice_index && String(control.control_source_slice_index) !== String(control.control_target_slice_index)),
    target_count: hitCount,
    link_target_count: linkHits.length,
    node_target_count: nodeHits.length,
    mandatory_target_count: mandatoryControl ? hitCount : 0,
    mandatory_link_target_count: mandatoryControl ? linkHits.length : 0,
    mandatory_node_target_count: mandatoryControl ? nodeHits.length : 0,
    target_ids: unique([...linkHits, ...nodeHits]).join(" > "),
    mandatory_target_ids: mandatoryControl ? unique([...linkHits, ...nodeHits]).join(" > ") : "",
    mandatory_link_target_ids: mandatoryControl ? unique(linkHits).join(" > ") : "",
    mandatory_node_target_ids: mandatoryControl ? unique(nodeHits).join(" > ") : "",
    reasons: control.top_retest_reasons,
  };
}

function linkEndpointSet(row) {
  return new Set([row?.source, row?.target].filter(Boolean));
}

function linkSimilarity({ leftId, rightId, sliceIndex, linksBySliceAndId }) {
  if (!leftId || !rightId) return 0;
  if (leftId === rightId) return 1;
  const left = linksBySliceAndId.get(`${sliceIndex}|${leftId}`);
  const right = linksBySliceAndId.get(`${sliceIndex}|${rightId}`);
  if (!left || !right) return 0;
  const leftEndpoints = linkEndpointSet(left);
  const rightEndpoints = linkEndpointSet(right);
  const sharedNodes = [...leftEndpoints].filter((node) => rightEndpoints.has(node)).length;
  const leftSource = planeSlot(left.source);
  const leftTarget = planeSlot(left.target);
  const rightSource = planeSlot(right.source);
  const rightTarget = planeSlot(right.target);
  const sameKind = left.kind === right.kind ? 1 : 0;
  const sameSourcePlane = leftSource.plane >= 0 && leftSource.plane === rightSource.plane ? 1 : 0;
  const sameTargetPlane = leftTarget.plane >= 0 && leftTarget.plane === rightTarget.plane ? 1 : 0;
  const sameSourceSlot = leftSource.slot >= 0 && leftSource.slot === rightSource.slot ? 1 : 0;
  const sameTargetSlot = leftTarget.slot >= 0 && leftTarget.slot === rightTarget.slot ? 1 : 0;
  const distanceSim = similarityFromDistance(numberValue(left.distance_km, NaN), numberValue(right.distance_km, NaN), 1200);
  const latencySim = similarityFromDistance(numberValue(left.latency_ms, NaN), numberValue(right.latency_ms, NaN), 20);
  const utilizationSim = similarityFromDistance(numberValue(left.utilization_percent, NaN), numberValue(right.utilization_percent, NaN), 35);
  return clamp(
    sameKind * 0.22 +
      Math.min(sharedNodes, 2) * 0.15 +
      (sameSourcePlane + sameTargetPlane) * 0.08 +
      (sameSourceSlot + sameTargetSlot) * 0.06 +
      distanceSim * 0.16 +
      latencySim * 0.14 +
      utilizationSim * 0.11,
    0,
    0.95,
  );
}

function marginalInformationForPath({ item, covered, sliceIndex, linksBySliceAndId }) {
  const coveredLinks = [...covered];
  const maxSimilaritySamples = 128;
  const selectedLinks = coveredLinks.length <= maxSimilaritySamples
    ? coveredLinks
    : coveredLinks.filter((_, index) => index % Math.ceil(coveredLinks.length / maxSimilaritySamples) === 0).slice(0, maxSimilaritySamples);
  let informationGain = 0;
  let baseInformation = 0;
  let redundancyPenalty = 0;
  let newLinkCount = 0;
  const marginalLinks = [];

  item.linkWeights.forEach((linkWeight) => {
    const baseWeight = Math.max(0, numberValue(linkWeight.weight));
    baseInformation += baseWeight;
    if (covered.has(linkWeight.link_id)) {
      redundancyPenalty += baseWeight;
      return;
    }
    const maxSimilarity = selectedLinks.length
      ? Math.max(...selectedLinks.map((selectedLinkId) =>
          linkSimilarity({ leftId: linkWeight.link_id, rightId: selectedLinkId, sliceIndex, linksBySliceAndId })
        ))
      : 0;
    const novelty = clamp(1 - maxSimilarity, 0.05, 1);
    const marginalGain = baseWeight * novelty;
    informationGain += marginalGain;
    redundancyPenalty += baseWeight * (1 - novelty);
    newLinkCount += 1;
    marginalLinks.push(`${linkWeight.link_id}:${round(marginalGain)}`);
  });

  return {
    information_gain: round(informationGain),
    base_information_gain: round(baseInformation),
    redundancy_penalty: round(redundancyPenalty),
    novelty_ratio: round(informationGain / Math.max(baseInformation, 1e-6)),
    new_link_count: newLinkCount,
    marginal_link_gains: marginalLinks.join(" > "),
    marginal_similarity_sample_size: selectedLinks.length,
    covered_link_count_when_scored: coveredLinks.length,
  };
}

function oamMandatoryTargetsForSlice({ sliceIndex, oamFeedbackBySlice, oamControlBySlice }) {
  const feedback = oamFeedbackBySlice?.get(String(sliceIndex));
  const control = oamControlForSlice(oamControlBySlice, sliceIndex);
  const links = new Set();
  const nodes = new Set();
  feedback?.links?.forEach((target) => {
    if (isMandatoryOamFeedbackTarget(target)) links.add(target.target_id);
  });
  feedback?.nodes?.forEach((target) => {
    if (isMandatoryOamFeedbackTarget(target)) nodes.add(target.target_id);
  });
  if (isMandatoryOamControl(control)) {
    splitPath(control.top_link_targets).forEach((targetId) => links.add(targetId));
    splitPath(control.top_node_targets).forEach((targetId) => nodes.add(targetId));
  }
  return {
    links,
    nodes,
    count: links.size + nodes.size,
  };
}

function isMandatoryOamFeedbackTarget(target) {
  const confidencePressure = numberValue(target.confidence_pressure);
  const completionError = numberValue(target.completion_error_score);
  const reason = String(target.reason || "").toLowerCase();
  return confidencePressure >= 0.6 ||
    reason.includes("unknown") ||
    reason.includes("conflict") ||
    (completionError >= 0.95 && confidencePressure >= 0.6);
}

function oamFeedbackSelectionScore(target) {
  const priority = numberValue(target.priority_score);
  if (isMandatoryOamFeedbackTarget(target)) return Math.min(priority, 1.2);
  const confidencePressure = numberValue(target.confidence_pressure);
  const completionError = numberValue(target.completion_error_score);
  const reason = String(target.reason || "").toLowerCase();
  if (reason.includes("stale") && confidencePressure <= 0 && completionError <= 0) {
    return Math.min(priority * 0.12, 0.18);
  }
  if (reason.includes("possible") || reason.includes("coverage")) {
    return Math.min(priority * 0.18, 0.22);
  }
  return Math.min(priority * 0.35, 0.45);
}

function mandatoryOamTargetIds(item) {
  return unique([
    ...splitPath(item?.oamFeedback?.mandatory_target_ids),
    ...splitPath(item?.oamControl?.mandatory_target_ids),
  ]);
}

function uncoveredMandatoryOamTargetIds(item, coveredTargets) {
  return mandatoryOamTargetIds(item).filter((targetId) => !coveredTargets.has(targetId));
}

function oamMandatoryCoverageForRows(rows, targets) {
  if (!targets || targets.count === 0) {
    return {
      covered_links: 0,
      covered_nodes: 0,
      missing_links: "",
      missing_nodes: "",
      covered_all: true,
    };
  }
  const coveredLinks = new Set();
  const coveredNodes = new Set();
  rows.forEach((row) => {
    splitPath(row.link_ids).forEach((linkId) => {
      if (targets.links.has(linkId)) coveredLinks.add(linkId);
    });
    splitPath(row.path).forEach((nodeId) => {
      if (targets.nodes.has(nodeId)) coveredNodes.add(nodeId);
    });
  });
  const missingLinks = [...targets.links].filter((targetId) => !coveredLinks.has(targetId));
  const missingNodes = [...targets.nodes].filter((targetId) => !coveredNodes.has(targetId));
  return {
    covered_links: coveredLinks.size,
    covered_nodes: coveredNodes.size,
    missing_links: missingLinks.join(" > "),
    missing_nodes: missingNodes.join(" > "),
    covered_all: missingLinks.length === 0 && missingNodes.length === 0,
  };
}

function candidateCoversMandatoryTarget(row, targets) {
  if (!targets || targets.count === 0) return false;
  const coversLink = splitPath(row.link_ids).some((linkId) => targets.links.has(linkId));
  const coversNode = splitPath(row.path).some((nodeId) => targets.nodes.has(nodeId));
  return coversLink || coversNode;
}

function candidateIdentity(row) {
  return [
    row.source_candidate_probe_id || row.probe_id || "",
    row.path || "",
    row.link_ids || "",
  ].join("|");
}

function appendOamDeltaCandidates({ cachedRows, currentCandidates, slicePlan, targets }) {
  if (!targets || targets.count === 0 || currentCandidates.length === 0) return cachedRows;
  const seen = new Set(cachedRows.map(candidateIdentity));
  const deltaRows = [];
  const affordableDeltaPathLinkLimit = 8;
  currentCandidates.forEach((path) => {
    if (!candidateCoversMandatoryTarget(path, targets)) return;
    const pathLinkCount = numberValue(path.path_link_count, splitPath(path.link_ids).length);
    if (pathLinkCount > affordableDeltaPathLinkLimit) return;
    const key = candidateIdentity(path);
    if (seen.has(key)) return;
    seen.add(key);
    deltaRows.push(adaptCandidatePath(path, slicePlan, "topology-reuse-cache-oam-delta"));
  });
  return deltaRows.length > 0 ? [...cachedRows, ...deltaRows] : cachedRows;
}

function appendTopologyRepairDeltaCandidates({
  cachedRows,
  currentCandidates,
  slicePlan,
  targets,
  changedLinkIds = [],
  candidateBudget = cachedRows.length,
}) {
  if (cachedRows.length === 0 || currentCandidates.length === 0) return cachedRows;
  const fixedCandidateBudget = Math.max(1, Math.floor(numberValue(candidateBudget, cachedRows.length)));
  const changedLinkSet = new Set(changedLinkIds.map(String));
  const affectedCachedPaths = cachedRows.filter((row) =>
    splitPath(row.link_ids).some((linkId) => changedLinkSet.has(linkId))
  ).length;
  const mandatoryTargetCount = (targets?.links?.size ?? 0) + (targets?.nodes?.size ?? 0);
  const replacementBudget = Math.max(1, Math.min(
    32,
    fixedCandidateBudget,
    Math.max(
      affectedCachedPaths,
      Math.ceil(changedLinkIds.length / 4),
      Math.ceil(mandatoryTargetCount / 4),
    ),
  ));
  const cachedPathLengths = cachedRows
    .map((row) => numberValue(row.path_link_count, splitPath(row.link_ids).length))
    .filter((value) => value > 0);
  const adaptiveRepairPathLimit = Math.max(
    8,
    Math.ceil(percentile(cachedPathLengths, 0.9) * 1.25),
  );
  const deltaCandidates = selectIncrementalRepairCandidates({
    cachedCandidateIds: cachedRows.map(candidateIdentity),
    currentCandidates: currentCandidates.map((path) => ({
      id: candidateIdentity(path),
      path,
      link_ids: splitPath(path.link_ids),
      node_ids: splitPath(path.path),
    })),
    changedLinkIds,
    mandatoryLinkIds: [...(targets?.links ?? [])],
    mandatoryNodeIds: [...(targets?.nodes ?? [])],
    maximumPathLinks: adaptiveRepairPathLimit,
    maximumDeltaCandidates: replacementBudget,
  });
  const retainedRows = cachedRows.slice(0, Math.max(0, fixedCandidateBudget - replacementBudget));
  const selectedCandidates = [
    ...retainedRows.map((row) => ({
      id: candidateIdentity(row),
      node_ids: splitPath(row.path),
      link_ids: splitPath(row.link_ids),
      row,
    })),
    ...deltaCandidates.map(({ id, path }) => ({
      id,
      node_ids: splitPath(path.path),
      link_ids: splitPath(path.link_ids),
      row: {
        ...adaptCandidatePath(path, slicePlan, "topology-reuse-cache-local-delta"),
        unified_budget_neutral_local_repair: true,
        unified_fast_repair_no_reroute: true,
        unified_adaptive_repair_path_limit: adaptiveRepairPathLimit,
      },
    })),
  ];
  const fallbackCandidates = currentCandidates.map((path) => ({
    id: candidateIdentity(path),
    node_ids: splitPath(path.path),
    link_ids: splitPath(path.link_ids),
    row: {
      ...adaptCandidatePath(path, slicePlan, "topology-reuse-cache-representative-rotation"),
      unified_budget_neutral_local_repair: true,
      unified_fast_repair_no_reroute: true,
    },
  }));
  const fixedBudgetRows = refillCandidatesToFixedBudget({
    selectedCandidates,
    fallbackCandidates,
    candidateBudget: fixedCandidateBudget,
  });
  return fixedBudgetRows.map(({ row }) => row);
}

function sliceTrafficRiskPressure({ activeLinks, sliceIndex, linksBySliceAndId }) {
  const risks = activeLinks
    .map((linkId) => {
      const link = linksBySliceAndId.get(`${sliceIndex}|${linkId}`) ?? {};
      const utilization = numberValue(link.utilization_percent, 0);
      const congestion = numberValue(link.congestion_percent, 0);
      const queueLatency = numberValue(link.queue_latency_ms, 0);
      const droppedTraffic = numberValue(link.dropped_traffic_mb, 0);
      const packetErrorRate = numberValue(link.packet_error_rate, 0);
      const warning = String(link.status || "").toLowerCase() === "warning" ? 0.18 : 0;
      return clamp(
        utilization / 100 * 0.45 +
          congestion / 100 * 0.25 +
          clamp(queueLatency / 200, 0, 1) * 0.12 +
          clamp(droppedTraffic / 20, 0, 1) * 0.1 +
          clamp(packetErrorRate / 0.08, 0, 1) * 0.08 +
          warning,
        0,
        1,
      );
    })
    .filter(Number.isFinite)
    .sort((left, right) => right - left);
  if (risks.length === 0) return 0;
  const topCount = Math.max(1, Math.ceil(risks.length * 0.1));
  return round(mean(risks.slice(0, topCount)));
}

function nodeStateInformationForPath({ sliceIndex, pathNodes, nodesBySliceAndId }) {
  if (!nodesBySliceAndId || pathNodes.length === 0) return 0;
  return pathNodes.reduce((total, nodeId) => {
    const node = nodesBySliceAndId.get(`${sliceIndex}|${nodeId}`);
    if (!node) return total;
    const queueDepth = numberValue(node.queue_depth, numberValue(node.queueDepth, 0));
    const queuedTrafficMb = numberValue(node.queued_traffic_mb, 0);
    const cpu = numberValue(node.cpu_percent, numberValue(node.cpuLoadPercent, 0));
    const energy = numberValue(node.energy_percent, numberValue(node.batteryPercent, 100));
    const warningMode = String(node.mode || "").toLowerCase() === "warning" ? 0.75 : 0;
    const powerRisk = energy < 20 ? 0.8 : energy < 35 ? 0.35 : 0;
    const score = clamp(
      clamp(queueDepth / 100, 0, 1) * 0.42 +
        clamp(queuedTrafficMb / 5000, 0, 1) * 0.24 +
        clamp(cpu / 100, 0, 1) * 0.14 +
        warningMode * 0.14 +
        powerRisk * 0.06,
      0,
      1.2,
    );
    return total + score;
  }, 0);
}

function nodeStateSignalsForPath({
  sliceIndex,
  slicePosition,
  pathNodes,
  nodesBySliceAndId,
  selectedNodeLastSeen,
  windowSize,
}) {
  return pathNodes.map((nodeId) => {
    const node = nodesBySliceAndId?.get(`${sliceIndex}|${nodeId}`) ?? {};
    const stale = slicePosition - (selectedNodeLastSeen?.get(nodeId) ?? -Infinity);
    const age = !Number.isFinite(stale) ? 1 : clamp(stale / Math.max(windowSize, 1), 0, 1);
    const queueDepth = numberValue(node.queue_depth, numberValue(node.queueDepth, 0));
    const queuedTrafficMb = numberValue(node.queued_traffic_mb, 0);
    const cpu = numberValue(node.cpu_percent, numberValue(node.cpuLoadPercent, 0));
    const energy = numberValue(node.energy_percent, numberValue(node.batteryPercent, 100));
    const warning = String(node.mode || node.mode_estimate || "").toLowerCase() === "warning" ? 1 : 0;
    const criticality = clamp(
      clamp(queueDepth / 100, 0, 1) * 0.32 +
        clamp(queuedTrafficMb / 5000, 0, 1) * 0.22 +
        clamp(cpu / 100, 0, 1) * 0.18 +
        clamp((35 - energy) / 35, 0, 1) * 0.16 +
        warning * 0.12,
      0,
      1,
    );
    const confidence = clamp(numberValue(node.confidence, numberValue(node.planner_state_confidence, 0.5)), 0, 1);
    const reportedAge = clamp(numberValue(node.state_age_slices) / Math.max(windowSize, 1), 0, 1);
    const effectiveAge = Math.max(age, reportedAge);
    const conflict = clamp(numberValue(node.conflict_severity, numberValue(node.oam_conflict_severity)), 0, 1);
    const uncertainty = clamp(
      effectiveAge * 0.4 +
        (1 - confidence) * 0.25 +
        conflict * 0.15 +
        criticality * 0.2,
      0,
      1,
    );
    return {
      node_id: nodeId,
      uncertainty: round(uncertainty),
      criticality: round(criticality),
      age: round(effectiveAge),
      prediction_variance: round(1 - confidence),
      report_conflict: round(conflict),
    };
  });
}

function nodeCountForSlice({ sliceIndex, nodesBySliceAndId }) {
  if (!nodesBySliceAndId) return 1;
  let nodeCount = 0;
  const prefix = `${sliceIndex}|`;
  for (const key of nodesBySliceAndId.keys()) {
    if (String(key).startsWith(prefix)) nodeCount += 1;
  }
  return Math.max(nodeCount, 1);
}

function rowsForSlice({ sliceIndex, rowsBySliceAndId }) {
  if (!rowsBySliceAndId) return [];
  const rows = [];
  const prefix = `${sliceIndex}|`;
  for (const [key, row] of rowsBySliceAndId.entries()) {
    if (String(key).startsWith(prefix)) rows.push(row);
  }
  return rows;
}

function nodeStateSamplingScale({ sliceIndex, nodesBySliceAndId }) {
  const nodeCount = nodeCountForSlice({ sliceIndex, nodesBySliceAndId });
  if (nodeCount <= 96) return 1;
  return round(1 + clamp(Math.log2(nodeCount / 96) / 5, 0, 0.55));
}

function importanceTargetKey(target) {
  return `${target.target_type}|${target.target_id}`;
}

function importanceGainForCandidate({
  pathNodes,
  pathLinks,
  targets = [],
  coveredTargetKeys = new Set(),
  probePacketBaseBytes = 64,
  reportHeaderBytes = 128,
  maxAoIDebtSeverity = 0,
  includeAdjacentLinkTargets = false,
}) {
  const nodeIds = new Set(pathNodes);
  const linkIds = new Set(pathLinks);
  const hits = targets.filter((target) => {
    if (coveredTargetKeys.has(importanceTargetKey(target))) return false;
    return target.target_type === "node"
      ? nodeIds.has(String(target.target_id))
      : linkIds.has(String(target.target_id)) || includeAdjacentLinkTargets && (
        nodeIds.has(String(target.source ?? "")) || nodeIds.has(String(target.target ?? ""))
      );
  });
  const nodeTargets = new Set(targets
    .filter((target) => target.target_type === "node")
    .filter((target) => !boolValue(target.coverage_required) || boolValue(target.mandatory))
    .map((target) => String(target.target_id)));
  const linkTargets = new Set(targets.filter((target) => target.target_type === "link").map((target) => String(target.target_id)));
  const metadataPlan = buildPathMetadataPlan({
    pathNodes,
    pathLinks,
    nodeTargets,
    linkTargets,
    preserveCoreNodeCoverage: true,
    preserveCoreLinkMetrics: true,
  });
  const informationGain = hits.reduce(
    (sum, target) => sum + numberValue(target.importance_score) + (boolValue(target.mandatory) ? 1 : 0),
    0,
  );
  const aoiDebtHits = hits.filter(
    (target) => boolValue(target.coverage_required) || numberValue(target.age_score) >= 1,
  );
  const adjacentLinkHits = hits.filter((target) =>
    target.target_type === "link" &&
    !linkIds.has(String(target.target_id)) &&
    (nodeIds.has(String(target.source ?? "")) || nodeIds.has(String(target.target ?? "")))
  );
  const adjacentLinkMetadataBytes = adjacentLinkHits.length * 48;
  const actualGeneratedBytes = probePacketBaseBytes + reportHeaderBytes + metadataPlan.target_mask_bytes +
    (metadataPlan.metadata_bytes + adjacentLinkMetadataBytes) * 2;
  return {
    target_ids: hits.map(importanceTargetKey),
    target_count: hits.length,
    mandatory_target_count: hits.filter((target) => boolValue(target.mandatory)).length,
    aoi_debt_target_ids: aoiDebtHits.map(importanceTargetKey),
    aoi_debt_target_count: aoiDebtHits.length,
    aoi_debt_severity: round(aoiDebtHits
      .reduce((sum, target) => sum + numberValue(target.aoi_debt_severity, 1), 0)),
    aoi_debt_max_severity: round(Math.max(
      0,
      ...aoiDebtHits.map((target) => numberValue(target.aoi_debt_severity, 1)),
    )),
    aoi_debt_oldest_target_count: aoiDebtHits.filter(
      (target) => numberValue(target.aoi_debt_severity, 1) >= maxAoIDebtSeverity - 1e-6,
    ).length,
    adjacent_link_target_ids: adjacentLinkHits.map(importanceTargetKey),
    adjacent_link_target_count: adjacentLinkHits.length,
    adjacent_link_metadata_bytes: adjacentLinkMetadataBytes,
    information_gain: round(informationGain),
    actual_generated_bytes: round(actualGeneratedBytes),
    gain_per_kb: round(informationGain / Math.max(actualGeneratedBytes / 1024, 1 / 1024)),
  };
}

function selectSlicePaths({
  slicePosition,
  slicePlan,
  candidatePaths,
  unifiedStablePathCache = null,
  unifiedRepairFallbackCandidates = [],
  unifiedRepairCandidateBudget = 0,
  linksBySliceAndId,
  nodesBySliceAndId,
  leverageScores,
  forecastBySliceAndLink,
  selectedLastSeen,
  selectedNodeLastSeen,
  algorithm,
  samplingRate,
  targetActiveLinkSamplingRate,
  minPaths,
  maxPaths,
  warmupSlices,
  windowSize,
  graph,
  candidateSource,
  minEnergyPercent,
  energyGuardThreshold,
  energyBudgetEnabled,
  energyBudgetMinActiveLinkSamplingRate,
  energyBudgetMaxReduction,
  adaptiveProbeBudgetEnabled,
  selectionStrategy,
  oamFeedbackBySlice,
  oamFeedbackWeight,
  oamControlBySlice,
  oamControlWeight,
  predictionScoreHorizon,
  costAwareSampling,
  costAwarenessWeight,
  telemetryByteBudgetPerSlice,
  hopMetadataBytes,
  adaptiveMetadataProfileEnabled,
  compactHopMetadataBytes,
  oamTargetAwareMetadataEnabled,
  oamTargetHopMetadataBytes,
  oamTransitHopMetadataBytes,
  oamTargetNeighborhoodMaxLossRatio,
  probePacketBaseBytes,
  reportHeaderBytes,
  hopProcessingJ,
  reportProcessingJ,
  telemetryTxNjPerByte,
  scaleAdaptiveTotalBudgetEnabled = false,
  scaleBudgetHeadroomRatio = 0.1,
  scaleBudgetPathHeadroomRatio = 0.25,
  scaleBudgetExplicitSource = "explicit-hard-cap",
  importancePathScoringEnabled = false,
  importanceTargets = [],
  importanceScoreWeight = 0.12,
  importanceShadowInformationFloor = 1,
  importanceAoIShadowInformationFloor = 1,
  importanceAoIDebtPathRatio = 0.1,
  importanceRepairByteBudgetRatio = 0.15,
  importanceBudgetNeutralReplacementEnabled = false,
  importanceReplacementRatio = 0.25,
  importanceReplacementMaxBaseLossRatio = 0.02,
}) {
  if (candidatePaths.length === 0) return { rows: [], summary: null };
  const activeLinks = [...slicePlan.activeSet];
  const activeSet = slicePlan.activeSet;
  const sliceTrafficRisk = sliceTrafficRiskPressure({
    activeLinks,
    sliceIndex: slicePlan.slice_index,
    linksBySliceAndId,
  });
  const sliceOamControl = oamControlForSlice(oamControlBySlice, slicePlan.slice_index);
  const oamBudget = applyOamControlBudget({
    oamControl: sliceOamControl,
    samplingRate,
    targetActiveLinkSamplingRate,
    telemetryByteBudgetPerSlice,
  });
  const topologyForecastPressure = clamp(numberValue(slicePlan.topology_forecast_drift_pressure), 0, 1);
  const nextMajorDrift = optionalNumber(slicePlan.topology_forecast_next_major_drift_in_slices);
  const topologyForecastTargetBoost = selectionStrategy === "full-int"
    ? 0
    : clamp(
        topologyForecastPressure * 0.1 +
          (Number.isFinite(nextMajorDrift) && nextMajorDrift <= 1 ? 0.05 : 0),
        0,
        0.16,
      );
  const topologyBoostedTargetActiveLinkSamplingRate = clamp(
    oamBudget.adjusted_target_active_link_sampling_rate + topologyForecastTargetBoost,
    oamBudget.adjusted_target_active_link_sampling_rate,
    1,
  );
  const nodeCount = nodeCountForSlice({
    sliceIndex: slicePlan.slice_index,
    nodesBySliceAndId,
  });
  const nodeSamplingScale = nodeStateSamplingScale({
    sliceIndex: slicePlan.slice_index,
    nodesBySliceAndId,
  });
  const scaleBudgetEnabled = Boolean(scaleAdaptiveTotalBudgetEnabled) && selectionStrategy !== "full-int";
  const scaleBudget = scaleBudgetEnabled
    ? buildScaleAdaptiveTelemetryBudget({
        nodes: rowsForSlice({
          sliceIndex: slicePlan.slice_index,
          rowsBySliceAndId: nodesBySliceAndId,
        }),
        activeLinks: activeLinks
          .map((linkId) => linksBySliceAndId.get(`${slicePlan.slice_index}|${linkId}`))
          .filter(Boolean),
        candidatePaths,
        samplingRate,
        targetActiveLinkSamplingRate,
        legacyPathFloor: maxPaths > 0 ? maxPaths : 12,
        explicitByteBudget: telemetryByteBudgetPerSlice,
        explicitBudgetSource: scaleBudgetExplicitSource,
        hopMetadataBytes,
        probePacketBaseBytes,
        reportHeaderBytes,
        budgetHeadroomRatio: scaleBudgetHeadroomRatio,
        pathHeadroomRatio: scaleBudgetPathHeadroomRatio,
      })
    : null;
  const scaleAwareMaxPaths = scaleBudgetEnabled
    ? scaleBudget.safe_path_cap
    : maxPaths;
  const adaptiveProbeBudget = buildAdaptiveProbeBudget({
    enabled: adaptiveProbeBudgetEnabled,
    slicePlan,
    oamBudget,
    candidateSource,
    selectionStrategy,
    samplingRate: oamBudget.adjusted_sampling_rate,
    targetActiveLinkSamplingRate: topologyBoostedTargetActiveLinkSamplingRate,
    telemetryByteBudgetPerSlice: oamBudget.adjusted_telemetry_byte_budget_per_slice,
    minPaths,
    maxPaths: scaleAwareMaxPaths,
    candidatePathCount: candidatePaths.length,
    sliceTrafficRisk,
    nodeSamplingScale,
  });
  const multiObjectiveControl = buildMultiObjectiveBudgetControl({
    enabled: multiObjectiveBudgetEnabled && adaptiveProbeBudgetEnabled,
    nodeCount,
    configuredMaxPathsPerSlice: scaleAwareMaxPaths > 0 ? scaleAwareMaxPaths : candidatePaths.length,
    baseScale: adaptiveProbeBudget.adaptive_probe_budget_scale,
    nodeSamplingScale,
    sliceTrafficRisk,
    oamPressure: Math.max(
      numberValue(adaptiveProbeBudget.adaptive_probe_budget_oam_pressure),
      numberValue(sliceOamControl.oam_control_pressure),
      numberValue(oamBudget.oam_budget_pressure),
    ),
    driftPressure: topologyForecastPressure,
    reuseConfidence: numberValue(adaptiveProbeBudget.adaptive_probe_budget_reuse_confidence),
    reuseMargin: numberValue(adaptiveProbeBudget.adaptive_probe_budget_reuse_margin),
    stableWindow: numberValue(slicePlan.topology_forecast_stable_window_slices),
    lowConfidencePressure: numberValue(sliceOamControl.low_confidence_pressure),
    conflictPressure: numberValue(sliceOamControl.conflict_pressure),
    retestPressure: Math.max(
      numberValue(sliceOamControl.retest_pressure),
      numberValue(sliceOamControl.priority_retest_targets) / 24,
    ),
  });
  const multiObjectiveScale = multiObjectiveControl.enabled
    ? numberValue(multiObjectiveControl.path_budget_scale, 1)
    : 1;
  const minSamplingRateForPaths = candidatePaths.length > 0 ? Math.min(1, minPaths / candidatePaths.length) : 0;
  const planningSamplingRate = multiObjectiveControl.enabled && multiObjectiveScale < 1
    ? clamp(adaptiveProbeBudget.adjusted_sampling_rate * multiObjectiveScale, minSamplingRateForPaths, adaptiveProbeBudget.adjusted_sampling_rate)
    : adaptiveProbeBudget.adjusted_sampling_rate;
  const planningTargetActiveLinkSamplingRate = multiObjectiveControl.enabled && multiObjectiveScale < 1
    ? clamp(
        adaptiveProbeBudget.adjusted_target_active_link_sampling_rate * multiObjectiveScale,
        Math.min(adaptiveProbeBudget.adjusted_target_active_link_sampling_rate, minSamplingRateForPaths),
        adaptiveProbeBudget.adjusted_target_active_link_sampling_rate,
      )
    : adaptiveProbeBudget.adjusted_target_active_link_sampling_rate;
  const planningTelemetryByteBudgetPerSlice = scaleBudgetEnabled
    ? scaleBudget.byte_budget
    : adaptiveProbeBudget.adjusted_telemetry_byte_budget_per_slice;
  const baseTargetCoveredLinks = scaleBudgetEnabled
    ? scaleBudget.target_active_link_count
    : Math.ceil(activeLinks.length * planningTargetActiveLinkSamplingRate);
  const basePathCount = scaleBudgetEnabled
    ? scaleBudget.witness_path_count
    : Math.ceil(candidatePaths.length * planningSamplingRate);
  const baseRequestedPathCount = selectionStrategy === "full-int"
    ? candidatePaths.length
    : Math.max(minPaths, basePathCount);
  const configuredSelectedLimit = selectionStrategy === "full-int"
    ? candidatePaths.length
    : Math.min(scaleAwareMaxPaths > 0 ? scaleAwareMaxPaths : candidatePaths.length, candidatePaths.length);
  const baseSelectedLimit = Math.min(
    candidatePaths.length,
    numberValue(adaptiveProbeBudget.adaptive_probe_budget_effective_max_paths_per_slice, configuredSelectedLimit),
  );
  const selectedLimitAfterMultiObjective = multiObjectiveControl.enabled && multiObjectiveScale < 1
    ? Math.max(minPaths, Math.min(baseSelectedLimit, numberValue(multiObjectiveControl.effective_max_paths_per_slice, baseSelectedLimit)))
    : baseSelectedLimit;
  // Base-path repair must be identical to the enhanced baseline. Importance
  // targets are only allowed to add paths after the base selector finishes.
  const requiredImportanceNodeIds = new Set();
  let planningCandidates = candidatePaths
    .map((path) => repairCandidatePath({
      path,
      activeSet,
      graph,
      linksBySliceAndId,
      requiredNodeIds: requiredImportanceNodeIds,
    }))
    .filter(Boolean);
  let unifiedRepairRefillPaths = 0;
  const repairModeSelected = splitPath(slicePlan.unified_mode_prefilter_selected_modes).includes("repair");
  if (
    topologyVersionedRiskPlannerEnabled &&
    repairModeSelected &&
    unifiedRepairCandidateBudget > 0 &&
    planningCandidates.length < unifiedRepairCandidateBudget
  ) {
    const fallbackCandidates = unifiedRepairFallbackCandidates
      .map((path) => ({
        id: candidateIdentity(path),
        node_ids: splitPath(path.path),
        link_ids: activeLinkIdsForPath(path, activeSet),
        path,
      }))
      .filter((candidate) =>
        candidate.link_ids.length > 0 &&
        candidate.node_ids.length > 1 &&
        splitPath(candidate.path.link_ids).every((linkId) => activeSet.has(linkId))
      );
    const refilled = refillCandidatesToFixedBudget({
      selectedCandidates: planningCandidates.map((path) => ({
        id: candidateIdentity(path),
        node_ids: splitPath(path.path),
        link_ids: activeLinkIdsForPath(path, activeSet),
        path,
      })),
      fallbackCandidates,
      candidateBudget: unifiedRepairCandidateBudget,
    });
    unifiedRepairRefillPaths = Math.max(0, refilled.length - planningCandidates.length);
    planningCandidates = refilled.map((candidate) => candidate.path);
  }
  const importanceMaxAoIDebtSeverity = Math.max(
    0,
    ...importanceTargets
      .filter((target) => boolValue(target.coverage_required) || numberValue(target.age_score) >= 1)
      .map((target) => numberValue(target.aoi_debt_severity, 1)),
  );
  const importanceOldestTargetCount = importanceTargets.filter(
    (target) => (boolValue(target.coverage_required) || numberValue(target.age_score) >= 1) &&
      numberValue(target.aoi_debt_severity, 1) >= importanceMaxAoIDebtSeverity - 1e-6,
  ).length;
  let unifiedStablePathCacheHits = 0;
  let unifiedStablePathCacheMisses = 0;
  const scored = planningCandidates.map((path, index) => {
    const itemCandidateSource = path.reused_candidate_source || candidateSource;
    const stableStructure = stablePathStructure({ path, activeSet, cache: unifiedStablePathCache });
    const pathLinks = stableStructure.pathLinks;
    const pathNodes = stableStructure.pathNodes;
    if (stableStructure.cacheHit) unifiedStablePathCacheHits += 1;
    else unifiedStablePathCacheMisses += 1;
    const nodeStateInformationGain = nodeStateInformationForPath({
      sliceIndex: path.slice_index,
      pathNodes,
      nodesBySliceAndId,
    });
    const nodeStateSignals = nodeStateSignalsForPath({
      sliceIndex: path.slice_index,
      slicePosition,
      pathNodes,
      nodesBySliceAndId,
      selectedNodeLastSeen,
      windowSize,
    });
    const forecastProfile = pathForecastProfile({
      sliceIndex: path.slice_index,
      pathLinks,
      forecastBySliceAndLink,
      horizon: predictionScoreHorizon,
    });
    const linkWeights = pathLinks.map((linkId) => {
      const score = leverageScores.get(linkId) ?? { leverage: 1, transition_rate: 0 };
      const row = linksBySliceAndId.get(`${path.slice_index}|${linkId}`);
      const forecast = forecastForLink(forecastBySliceAndLink, path.slice_index, linkId, predictionScoreHorizon);
      const kindBonus = row?.kind === "inter-plane" ? 0.35 : row?.kind === "star-ground" ? 0.25 : 0;
      const confidenceBonus = linkAvailability(row ?? {}) * 0.15;
      const forecastBonus =
        numberValue(forecast.forecast_priority_score) * 0.35 +
        numberValue(forecast.forecast_transition_score) * 0.15 +
        numberValue(forecast.forecast_near_outage_score) * 0.18;
      const stale = slicePosition - (selectedLastSeen.get(linkId) ?? -Infinity);
      const ageScore = !Number.isFinite(stale)
        ? 1
        : clamp(stale / Math.max(windowSize, 1), 0, 1);
      const staleBonus = !Number.isFinite(stale) || stale > windowSize ? 0.75 : ageScore * 0.35;
      const uncertaintyBonus =
        numberValue(score.temporal_variance) * 0.45 +
          (1 - linkAvailability(row ?? {})) * 0.22;
      const plannerConfidence = clamp(numberValue(row?.planner_state_confidence, row?.confidence ?? 0.5), 0, 1);
      const reportedAgeScore = clamp(numberValue(row?.state_age_slices) / Math.max(windowSize, 1), 0, 1);
      const conflictScore = clamp(numberValue(row?.conflict_severity, row?.oam_conflict_severity), 0, 1);
      const uncertaintyScore = clamp(
        clamp(numberValue(score.temporal_variance) * 4, 0, 1) * 0.28 +
          Math.max(ageScore, reportedAgeScore) * 0.3 +
          clamp(numberValue(score.low_rank_leverage ?? score.leverage, 1) / 3, 0, 1) * 0.15 +
          (1 - plannerConfidence) * 0.17 +
          conflictScore * 0.1,
        0,
        1,
      );
      const topologyRiskScore = clamp(
        numberValue(forecast.forecast_priority_score) * 0.35 +
          numberValue(forecast.forecast_transition_score) * 0.2 +
          numberValue(forecast.forecast_near_outage_score) * 0.3 +
          numberValue(forecast.forecast_contact_scarcity_score) * 0.15,
        0,
        1,
      );
      const weight =
        numberValue(score.low_rank_leverage ?? score.leverage, 1) +
        numberValue(score.transition_rate) * 0.8 +
        uncertaintyBonus +
        kindBonus +
        staleBonus +
        confidenceBonus +
        forecastBonus;
      return {
        link_id: linkId,
        weight: round(weight),
        low_rank_leverage: round(numberValue(score.low_rank_leverage ?? score.leverage, 1)),
        transition_rate: round(numberValue(score.transition_rate)),
        temporal_variance: round(numberValue(score.temporal_variance)),
        forecast_priority_score: forecast.forecast_priority_score,
        uncertainty_score: round(uncertaintyScore),
        topology_risk_score: round(topologyRiskScore),
        age_score: round(ageScore),
        prediction_variance_score: round(1 - plannerConfidence),
        report_conflict_score: round(conflictScore),
      };
    });
    const linkScores = linkWeights.map((item) => numberValue(item.weight));
    const baseInformationGain = linkWeights.reduce((total, item) => total + numberValue(item.weight), 0) +
      nodeStateInformationGain * (0.65 * nodeSamplingScale);
    const lengthPenalty = Math.log2(Math.max(numberValue(path.path_link_count, pathLinks.length), 1) + 1) * 0.04;
    const diversity = pathLinks.filter((linkId) => !selectedLastSeen.has(linkId)).length / Math.max(pathLinks.length, 1);
    const warmupBoost = slicePosition < warmupSlices ? diversity * 2 : 0;
    const riskPenalty = numberValue(path.predicted_path_risk, 0) * 0.25;
    const rawPathRisk = numberValue(path.predicted_path_risk, 0);
    const energyProfile = pathEnergyProfile({
      sliceIndex: path.slice_index,
      nodeIds: pathNodes,
      nodesBySliceAndId,
      minEnergyPercent,
    });
    const energyRisk = energyProfile.risk;
    const reuseBonus = itemCandidateSource === "topology-reuse-cache" ? 0.15 : 0;
    const interPlaneLinks = pathLinks.filter((linkId) => linksBySliceAndId.get(`${path.slice_index}|${linkId}`)?.kind === "inter-plane").length;
    const bottleneckLinks = pathLinks.filter((linkId) => {
      const row = linksBySliceAndId.get(`${path.slice_index}|${linkId}`);
      return numberValue(row?.utilization_percent) >= 70 || numberValue(row?.congestion_percent) > 0;
    }).length;
    const dynamicLinks = pathLinks.filter((linkId) => {
      const score = leverageScores.get(linkId) ?? { transition_rate: 0 };
      return score.transition_rate > 0;
    }).length;
    const oamFeedback = oamFeedbackForPath({
      sliceIndex: path.slice_index,
      pathLinks,
      pathNodes,
      oamFeedbackBySlice,
    });
    const oamControl = oamControlForPath({
      sliceIndex: path.slice_index,
      pathLinks,
      pathNodes,
      oamControlBySlice,
    });
    const oamInfluenceGated = adaptiveProbeBudget.adaptive_probe_budget_policy === "oam-feedback-gated-low-risk-slice";
    const oamFeedbackBonus = oamInfluenceGated ? 0 : oamFeedback.score * oamFeedbackWeight;
    const oamControlBonus = oamInfluenceGated ? 0 : oamControl.score * oamControlWeight;
    const mandatoryOamTargetBoost = oamFeedback.mandatory_target_count > 0 || oamControl.mandatory_target_count > 0 ? 3.2 : 0;
    const localAdaptive = localAdaptiveSamplingProfile({
      enabled: adaptiveProbeBudgetEnabled,
      pathLinks,
      sliceIndex: path.slice_index,
      linksBySliceAndId,
      forecastProfile,
      oamFeedback,
      oamControl,
      candidateSource: itemCandidateSource,
    });
    const metadataProfile = adaptiveMetadataProfile({
      enabled: adaptiveMetadataProfileEnabled,
      hopMetadataBytes,
      compactHopMetadataBytes,
      candidateSource: itemCandidateSource,
      slicePlan,
      adaptiveProbeBudget,
      oamFeedback,
      oamControl,
      localAdaptive,
      nodeSamplingScale,
      multiObjectiveControl,
      oamTargetAwareMetadataEnabled,
      oamTargetHopMetadataBytes,
      oamTransitHopMetadataBytes,
      oamTargetObservationLossRatio: clamp(pathNodes.length * 3 / Math.max(activeLinks.length, 1), 0, 1),
      oamTargetNeighborhoodMaxLossRatio,
    });
    const perHopMetadataBytes = metadataBytesForPath({
      pathNodes,
      pathLinks,
      metadataProfile,
      oamFeedback,
      oamControl,
      fallbackBytes: hopMetadataBytes,
    });
    const telemetryCost = estimatePathTelemetryCost({
      pathLinks,
      pathNodes,
      hopMetadataBytes: metadataProfile.effective_hop_metadata_bytes,
      perHopMetadataBytes,
      probePacketBaseBytes,
      reportHeaderBytes,
      hopProcessingJ,
      reportProcessingJ,
      telemetryTxNjPerByte,
    });
    const rankingTelemetryCost = multiObjectiveControl.enabled
      ? estimatePathTelemetryCost({
          pathLinks,
          pathNodes,
          hopMetadataBytes: legacyRankingHopMetadataBytes({
            profile: metadataProfile.profile,
            hopMetadataBytes,
            compactHopMetadataBytes,
          }),
          perHopMetadataBytes: targetAwareMetadataProfile(metadataProfile.profile) ? perHopMetadataBytes : [],
          probePacketBaseBytes,
          reportHeaderBytes,
          hopProcessingJ,
          reportProcessingJ,
          telemetryTxNjPerByte,
        })
      : telemetryCost;
    const baseScore =
      mean(linkScores) +
      diversity * 0.6 +
      warmupBoost +
      reuseBonus +
      oamFeedbackBonus +
      oamControlBonus -
      lengthPenalty -
      riskPenalty -
      energyRisk * 0.35 +
      forecastProfile.forecast_priority_score * 0.25 +
      localAdaptive.score_bonus +
      mandatoryOamTargetBoost;
    const multiMetricStateBonus = nodeStateInformationGain * (0.16 * nodeSamplingScale);
    const multiMetricBaseScore = baseScore + multiMetricStateBonus;
    let strategyScore = multiMetricBaseScore;
    if (selectionStrategy === "random-sampling") {
      strategyScore = deterministicUnitInterval(`${path.slice_index}|${path.probe_id}|${path.path}|${path.link_ids}`);
    } else if (selectionStrategy === "shortest-path") {
      strategyScore = -numberValue(path.path_link_count, pathLinks.length) - riskPenalty - energyRisk * 0.1;
    } else if (selectionStrategy === "topology-aware") {
      strategyScore =
        diversity * 1.2 +
        interPlaneLinks * 0.45 +
        bottleneckLinks * 0.6 +
        dynamicLinks * 0.35 +
        forecastProfile.forecast_priority_score * 0.55 +
        forecastProfile.forecast_transition_score * 0.3 +
        reuseBonus -
        lengthPenalty -
        riskPenalty -
        energyRisk * 0.25 +
        oamFeedbackBonus +
        oamControlBonus +
        multiMetricStateBonus;
    } else if (selectionStrategy === "orbit-predicted") {
      const meanAvailability = mean(pathLinks.map((linkId) => {
        const row = linksBySliceAndId.get(`${path.slice_index}|${linkId}`);
        return linkAvailability(row ?? {});
      }));
      strategyScore =
        meanAvailability * 1.4 +
        dynamicLinks * 0.45 +
        interPlaneLinks * 0.3 +
        forecastProfile.forecast_priority_score * 1 +
        forecastProfile.forecast_transition_score * 0.45 +
        forecastProfile.forecast_near_outage_score * 0.35 +
        diversity * 0.45 +
        reuseBonus -
        rawPathRisk * 0.8 -
        lengthPenalty -
        energyRisk * 0.2 +
        oamFeedbackBonus +
        oamControlBonus +
        multiMetricStateBonus;
    }
    const costScore = costAwarePathScore({
      score: strategyScore,
      informationGain: baseInformationGain,
      cost: rankingTelemetryCost,
      forecastProfile,
      diversity,
      oamFeedback,
      oamControl,
      weight: costAwarenessWeight,
    });
    const multiObjectiveScore = multiObjectivePathScore({
      baseScore: costAwareSampling && !["full-int", "random-sampling"].includes(selectionStrategy)
        ? costScore.cost_aware_score
        : strategyScore,
      nodeInformationGain: nodeStateInformationGain,
      linkInformationGain: linkWeights.reduce((total, item) => total + numberValue(item.weight), 0),
      telemetryCostBytes: rankingTelemetryCost.estimated_total_telemetry_bytes,
      localRisk: numberValue(localAdaptive?.risk),
      control: multiObjectiveControl,
    });
    const rankingScore = costAwareSampling && !["full-int", "random-sampling"].includes(selectionStrategy)
        ? costScore.cost_aware_score
        : strategyScore;
    const importanceGain = importanceGainForCandidate({
      pathNodes,
      pathLinks,
      targets: importanceTargets,
      probePacketBaseBytes,
      reportHeaderBytes,
      maxAoIDebtSeverity: importanceMaxAoIDebtSeverity,
      includeAdjacentLinkTargets: true,
    });
    return {
      path,
      index,
      pathLinks,
      pathNodes,
      pathNodeCount: pathNodes.length,
      nodeStateSignals,
      energyRisk,
      energyProfile,
      localAdaptive,
      metadataProfile,
      forecastProfile,
      telemetryCost,
      rankingTelemetryCost,
      costScore,
      multiObjectiveScore,
      linkWeights,
      rankingScore,
      importanceGain,
      oamFeedback,
      oamControl,
      score: strategyScore,
      base_int_mc_score: baseScore,
      node_state_information_gain: round(nodeStateInformationGain),
      base_information_gain: round(baseInformationGain),
      candidateSource: itemCandidateSource,
    };
  });

  const importanceEfficiencyReference = Math.max(
    1e-9,
    ...scored.map((item) => numberValue(item.importanceGain?.gain_per_kb)),
  );
  const importanceAoIDebtReference = Math.max(
    1,
    ...scored.map((item) => numberValue(item.importanceGain?.aoi_debt_severity)),
  );
  const importanceAoIDebtMaxReference = Math.max(
    1,
    ...scored.map((item) => numberValue(item.importanceGain?.aoi_debt_max_severity)),
  );
  const importanceOldestTargetsPerPath = Math.max(
    1,
    ...scored.map((item) => numberValue(item.importanceGain?.aoi_debt_oldest_target_count)),
  );

  const objectiveCostReferences = {
    bytes: Math.max(
      1,
      mean(scored.map((item) => numberValue(item.rankingTelemetryCost?.estimated_total_telemetry_bytes, NaN)).filter(Number.isFinite)),
    ),
    energyJ: Math.max(
      1e-6,
      mean(scored.map((item) => numberValue(item.rankingTelemetryCost?.estimated_total_telemetry_energy_j, NaN)).filter(Number.isFinite)),
    ),
  };
  if (topologyVersionedObjectiveEnabled && selectionStrategy === "int-mc-leverage") {
    scored.forEach((item) => {
      const objective = evaluateTopologyVersionedPathObjective({
        enabled: true,
        topologyClassId: slicePlan.topology_class_id,
        topologySignature: slicePlan.topology_signature,
        candidateSource: item.candidateSource,
        planningRepairCount: item.path.planning_repair_count,
        activeLinkCount: activeLinks.length,
        linkSignals: item.linkWeights.map((signal) => ({
          link_id: signal.link_id,
          uncertainty: signal.uncertainty_score,
          topology_risk: signal.topology_risk_score,
          age: signal.age_score,
          covered: false,
        })),
        nodeSignals: item.nodeStateSignals.map((signal) => ({ ...signal, covered: false })),
        telemetryCost: item.rankingTelemetryCost ?? item.telemetryCost,
        costReferences: objectiveCostReferences,
        nodeInformationGain: item.node_state_information_gain,
        oamTargetScore: numberValue(item.oamFeedback?.score) + numberValue(item.oamControl?.score),
        metadataProfile: item.metadataProfile?.profile,
        baselineRankingScore: item.rankingScore,
        weights: topologyVersionedObjectiveWeights,
        confidenceThreshold: topologyVersionedConfidenceThreshold,
      });
      item.topologyVersionedObjective = objective;
      item.rankingScore = objective.ranking_score;
    });
  }
  const importanceScoreScale = Math.max(
    0.1,
    percentile(scored.map((item) => numberValue(item.rankingScore)), 0.9) -
      percentile(scored.map((item) => numberValue(item.rankingScore)), 0.1),
  );
  if (importancePathScoringEnabled && selectionStrategy === "int-mc-leverage") {
    scored.forEach((item) => {
      item.importanceNormalizedGain = clamp(
        numberValue(item.importanceGain?.gain_per_kb) / importanceEfficiencyReference,
        0,
        1,
      );
      item.importanceScoreBonus = round(importanceScoreWeight * importanceScoreScale * item.importanceNormalizedGain);
      item.importanceAoIDebtScoreBonus = round(
        importanceScoreScale * 1.5 * (
          0.8 * numberValue(item.importanceGain?.aoi_debt_max_severity) / importanceAoIDebtMaxReference +
          0.1 * numberValue(item.importanceGain?.aoi_debt_severity) / importanceAoIDebtReference +
          0.1 * numberValue(item.importanceGain?.aoi_debt_oldest_target_count) / importanceOldestTargetsPerPath
        ),
      );
      // The deployable policy preserves the representative base ranking. Importance
      // targets are handled by the bounded additive repair phase below.
    });
  }

  scored.sort((left, right) =>
    selectionStrategy === "full-int"
      ? left.index - right.index
      : right.rankingScore - left.rankingScore || right.score - left.score || left.index - right.index,
  );
  const selected = [];
  const covered = new Set();
  const coveredNodes = new Set();
  const coveredMandatoryOamTargets = new Set();
  const coveredImportanceTargets = new Set();
  let energyGuardSuppressedPaths = 0;
  const energyBudget = buildEnergyAwareSamplingBudget({
    scored,
    selectionStrategy,
    samplingRate: planningSamplingRate,
    targetActiveLinkSamplingRate: planningTargetActiveLinkSamplingRate,
    minPaths,
    candidatePathCount: candidatePaths.length,
    activeLinkCount: activeLinks.length,
    baseRequestedPathCount,
    baseTargetCoveredLinks,
    baseSelectedLimit: selectedLimitAfterMultiObjective,
    energyBudgetEnabled,
    energyBudgetMinActiveLinkSamplingRate,
    energyBudgetMaxReduction,
    slicePlan,
  });
  const targetCoveredLinks = energyBudget.energy_budget_target_covered_links;
  const requestedPathCount = energyBudget.energy_budget_requested_paths;
  const selectedLimit = energyBudget.energy_budget_selected_limit;
  const importanceAoIDebtPathLimit = importancePathScoringEnabled && !importanceBudgetNeutralReplacementEnabled
    ? Math.min(
        selectedLimit,
        Math.max(
          1,
          Math.ceil(requestedPathCount * importanceAoIDebtPathRatio),
          Math.ceil(importanceOldestTargetCount / importanceOldestTargetsPerPath),
        ),
      )
    : 0;
  let importanceAoIDebtPromotedPaths = 0;
  const importanceAdjustedRequestedPathCount = importanceBudgetNeutralReplacementEnabled
    ? requestedPathCount
    : computeAoIAdjustedPathCount({
        requestedPathCount,
        aoiRepairPathLimit: importanceAoIDebtPathLimit,
        selectedLimit,
      });
  const telemetryBudgetEnabled = costAwareSampling && selectionStrategy !== "full-int" && planningTelemetryByteBudgetPerSlice > 0;
  let telemetryBudgetUsedBytes = 0;
  let telemetryBudgetSuppressedPaths = 0;
  let telemetryBudgetOverridePaths = 0;
  let reuseDuplicateSuppressedPaths = 0;
  let oamDuplicateTargetOnlySuppressedPaths = 0;
  let unifiedPlannerDecision = null;

  if (topologyVersionedRiskPlannerEnabled && selectionStrategy === "int-mc-leverage") {
    if (!telemetryBudgetEnabled) {
      throw new Error("topology-versioned-risk-int requires a positive telemetry byte budget");
    }
    const candidateActions = scored
      .map((item, itemIndex) => ({ item, itemIndex }))
      .filter(({ item }) =>
        item.energyRisk < energyGuardThreshold ||
        numberValue(item.localAdaptive?.risk) >= 0.6
      )
      .flatMap(({ item, itemIndex }) => buildUnifiedMetadataActions({
        item,
        itemIndex,
        sliceIndex: slicePlan.slice_index,
        linksBySliceAndId,
        hopMetadataBytes,
        compactHopMetadataBytes,
        probePacketBaseBytes,
        reportHeaderBytes,
        hopProcessingJ,
        reportProcessingJ,
        telemetryTxNjPerByte,
        scaleBudgetEnabled,
        allowedMetadataActions: topologyVersionedMetadataActions,
      }));
    if (topologyVersionedInformationGainMode === "coverage-only") {
      candidateActions.forEach((action) => {
        action.observations = action.observations.map((observation) => ({
          ...observation,
          uncertainty: 1,
          similarity_group: "",
        }));
      });
    }
    const candidatesByMode = Object.groupBy(
      candidateActions,
      (action) => action.planning_mode,
    );
    const topologyVersion = buildTopologyVersion({
      topologyClassId: slicePlan.topology_class_id,
      topologySignature: slicePlan.topology_signature,
      addedLinkIds: splitPath(slicePlan.unified_topology_added_link_ids),
      removedLinkIds: splitPath(slicePlan.unified_topology_removed_link_ids),
      nextChangeInSlices: optionalNumber(slicePlan.topology_forecast_next_major_drift_in_slices),
    });
    unifiedPlannerDecision = chooseTopologyVersionedPlan({
      topologyVersion,
      candidatesByMode,
      byteBudget: planningTelemetryByteBudgetPerSlice,
      riskWeight: topologyVersionedRiskWeight,
      redundancyWeight: topologyVersionedInformationGainMode === "coverage-only"
        ? 0
        : topologyVersionedRedundancyWeight,
      planningCostWeight: topologyVersionedPlanningCostWeight,
      selectionEngineByMode: {
        reuse: "cached-plan-greedy",
        repair: "cached-plan-greedy",
        fresh: "lazy-greedy",
      },
    });
    telemetryBudgetUsedBytes = unifiedPlannerDecision.used_bytes;
    unifiedPlannerDecision.selected_actions.forEach((action) => {
      const sourceItem = scored[numberValue(action.source_item_index, -1)];
      if (!sourceItem) return;
      const item = {
        ...sourceItem,
        path: {
          ...sourceItem.path,
          unified_planning_mode: action.planning_mode,
        },
        metadataProfile: action.metadata_profile,
        telemetryCost: action.telemetry_cost,
        unifiedSelectiveMetadataPlan: action.selective_metadata_plan ?? null,
        unifiedPlannerAction: action,
      };
      const observedLinkIds = new Set(
        action.observations.filter((observation) => observation.type === "link").map((observation) => observation.id),
      );
      const observedNodeIds = new Set(
        action.observations.filter((observation) => observation.type === "node").map((observation) => observation.id),
      );
      const newLinkIds = [...observedLinkIds].filter((linkId) => !covered.has(linkId));
      const marginal = {
        information_gain: action.marginal_information_gain,
        base_information_gain: sourceItem.base_information_gain,
        redundancy_penalty: action.marginal_redundancy_penalty,
        novelty_ratio: round(
          (newLinkIds.length + [...observedNodeIds].filter((nodeId) => !coveredNodes.has(nodeId)).length) /
            Math.max(observedLinkIds.size + observedNodeIds.size, 1),
        ),
        new_link_count: newLinkIds.length,
        marginal_link_gains: newLinkIds.join(" > "),
      };
      item.selectedMarginal = marginal;
      item.selectedCostScore = costAwarePathScore({
        score: sourceItem.score,
        informationGain: action.marginal_value,
        cost: action.telemetry_cost,
        forecastProfile: sourceItem.forecastProfile,
        diversity: marginal.novelty_ratio,
        oamFeedback: sourceItem.oamFeedback,
        oamControl: sourceItem.oamControl,
        weight: costAwarenessWeight,
      });
      item.selectedMultiObjectiveScore = sourceItem.multiObjectiveScore;
      item.selectedTopologyVersionedObjective = sourceItem.topologyVersionedObjective;
      item.selectedLegacyShadowGuardDecision = "unified-planner-selected-under-hard-budget";
      item.telemetryBudgetDecision = "unified-hard-budget-without-override";
      item.telemetryBudgetUsedBytesAfterSelection = action.budget_used_bytes_after_selection;
      item.telemetryBudgetRemainingBytesAfterSelection = action.budget_remaining_bytes_after_selection;
      item.selectedNewMandatoryTargetIds = uncoveredMandatoryOamTargetIds(item, coveredMandatoryOamTargets);
      item.selectedImportanceGain = item.importanceGain;
      item.selectedImportanceNormalizedGain = item.importanceNormalizedGain ?? 0;
      item.selectedImportanceScoreBonus = 0;
      item.selectedImportanceAoIDebtScoreBonus = 0;
      selected.push(item);
      observedLinkIds.forEach((linkId) => covered.add(linkId));
      observedNodeIds.forEach((nodeId) => coveredNodes.add(nodeId));
      mandatoryOamTargetIds(item).forEach((targetId) => coveredMandatoryOamTargets.add(targetId));
    });
  } else {
  const pending = [...scored];
  while (pending.length > 0 && selected.length < selectedLimit) {
    let item;
    if (!item && selectionStrategy === "int-mc-leverage") {
      const windowSize = Math.min(
        pending.length,
        Math.max(64, Math.min(512, Math.ceil(Math.max(requestedPathCount, minPaths) * 1.5))),
      );
      let bestIndex = 0;
      let bestRankingScore = -Infinity;
      let bestMarginalGain = -Infinity;
      let legacyBestIndex = 0;
      let legacyBestRankingScore = -Infinity;
      let legacyBestMarginalGain = -Infinity;
      for (let index = 0; index < windowSize; index += 1) {
        const candidate = pending[index];
        const marginal = marginalInformationForPath({
          item: candidate,
          covered,
          sliceIndex: slicePlan.slice_index,
          linksBySliceAndId,
        });
        const currentCostScore = costAwarePathScore({
          score: candidate.score,
          informationGain: marginal.information_gain,
          cost: candidate.rankingTelemetryCost ?? candidate.telemetryCost,
          forecastProfile: candidate.forecastProfile,
          diversity: candidate.pathLinks.filter((linkId) => !covered.has(linkId)).length / Math.max(candidate.pathLinks.length, 1),
          oamFeedback: candidate.oamFeedback,
          oamControl: candidate.oamControl,
          weight: costAwarenessWeight,
        });
        const currentMultiObjectiveScore = multiObjectivePathScore({
          baseScore: costAwareSampling ? currentCostScore.cost_aware_score : marginal.information_gain,
          nodeInformationGain: candidate.node_state_information_gain,
          linkInformationGain: marginal.information_gain,
          telemetryCostBytes: (candidate.rankingTelemetryCost ?? candidate.telemetryCost).estimated_total_telemetry_bytes,
          localRisk: numberValue(candidate.localAdaptive?.risk),
          control: multiObjectiveControl,
        });
        candidate.currentMarginal = marginal;
        candidate.currentCostScore = currentCostScore;
        candidate.currentMultiObjectiveScore = currentMultiObjectiveScore;
        const baselineGreedyScore = costAwareSampling
          ? currentCostScore.cost_aware_score
          : marginal.information_gain;
        const currentImportanceGain = importanceGainForCandidate({
          pathNodes: candidate.pathNodes,
          pathLinks: candidate.pathLinks,
          targets: importanceTargets,
          coveredTargetKeys: coveredImportanceTargets,
          probePacketBaseBytes,
          reportHeaderBytes,
          maxAoIDebtSeverity: importanceMaxAoIDebtSeverity,
        });
        const currentImportanceNormalizedGain = clamp(
          numberValue(currentImportanceGain.gain_per_kb) / importanceEfficiencyReference,
          0,
          1,
        );
        const currentImportanceScoreBonus = 0;
        const aoiDebtPromotionAvailable = false;
        const currentImportanceAoIDebtScoreBonus = 0;
        candidate.currentImportanceGain = currentImportanceGain;
        candidate.currentImportanceNormalizedGain = currentImportanceNormalizedGain;
        candidate.currentImportanceScoreBonus = currentImportanceScoreBonus;
        candidate.currentImportanceAoIDebtScoreBonus = currentImportanceAoIDebtScoreBonus;
        const topologyVersionedObjective = evaluateTopologyVersionedPathObjective({
          enabled: topologyVersionedObjectiveEnabled,
          topologyClassId: slicePlan.topology_class_id,
          topologySignature: slicePlan.topology_signature,
          candidateSource: candidate.candidateSource,
          planningRepairCount: candidate.path.planning_repair_count,
          activeLinkCount: activeLinks.length,
          linkSignals: candidate.linkWeights.map((signal) => ({
            link_id: signal.link_id,
            uncertainty: signal.uncertainty_score,
            topology_risk: signal.topology_risk_score,
            age: signal.age_score,
            covered: covered.has(signal.link_id),
          })),
          nodeSignals: candidate.nodeStateSignals.map((signal) => ({
            ...signal,
            covered: coveredNodes.has(signal.node_id),
          })),
          telemetryCost: candidate.rankingTelemetryCost ?? candidate.telemetryCost,
          costReferences: objectiveCostReferences,
          nodeInformationGain: candidate.node_state_information_gain,
          oamTargetScore: numberValue(candidate.oamFeedback?.score) + numberValue(candidate.oamControl?.score),
          metadataProfile: candidate.metadataProfile?.profile,
          baselineRankingScore: baselineGreedyScore,
          weights: topologyVersionedObjectiveWeights,
          confidenceThreshold: topologyVersionedConfidenceThreshold,
        });
        candidate.currentTopologyVersionedObjective = topologyVersionedObjective;
        const newMandatoryTargetIds = uncoveredMandatoryOamTargetIds(candidate, coveredMandatoryOamTargets);
        candidate.currentNewMandatoryTargetIds = newMandatoryTargetIds;
        const mandatoryOamGreedyBoost = newMandatoryTargetIds.length > 0
          ? 1000 + newMandatoryTargetIds.length * 25
          : 0;
        candidate.rankingScore = topologyVersionedObjective.ranking_score + mandatoryOamGreedyBoost +
          currentImportanceScoreBonus + currentImportanceAoIDebtScoreBonus;
        candidate.currentLegacyRankingScore = baselineGreedyScore + mandatoryOamGreedyBoost;
        candidate.currentNewNodeIds = candidate.pathNodes.filter((nodeId) => !coveredNodes.has(nodeId));
        const marginalGain = numberValue(marginal.information_gain);
        if (
          candidate.rankingScore > bestRankingScore ||
          (candidate.rankingScore === bestRankingScore && marginalGain > bestMarginalGain)
        ) {
          bestIndex = index;
          bestRankingScore = candidate.rankingScore;
          bestMarginalGain = marginalGain;
        }
        if (
          candidate.currentLegacyRankingScore > legacyBestRankingScore ||
          (candidate.currentLegacyRankingScore === legacyBestRankingScore && marginalGain > legacyBestMarginalGain)
        ) {
          legacyBestIndex = index;
          legacyBestRankingScore = candidate.currentLegacyRankingScore;
          legacyBestMarginalGain = marginalGain;
        }
      }
      const objectiveCandidate = pending[bestIndex];
      const legacyCandidate = pending[legacyBestIndex];
      const objectiveBestIndex = bestIndex;
      const shadowGuard = chooseConservativeObjectiveCandidate({
        legacy: {
          id: String(legacyBestIndex),
          newNodeIds: legacyCandidate.currentNewNodeIds,
          marginalInformationGain: legacyCandidate.currentMarginal?.information_gain,
          telemetryBytes: (legacyCandidate.rankingTelemetryCost ?? legacyCandidate.telemetryCost).estimated_total_telemetry_bytes,
        },
        objective: {
          id: String(bestIndex),
          newNodeIds: objectiveCandidate.currentNewNodeIds,
          marginalInformationGain: objectiveCandidate.currentMarginal?.information_gain,
          telemetryBytes: (objectiveCandidate.rankingTelemetryCost ?? objectiveCandidate.telemetryCost).estimated_total_telemetry_bytes,
        },
        minInformationRatio: 0.98,
      });
      const objectiveAoIDebtMax = numberValue(objectiveCandidate.currentImportanceGain?.aoi_debt_max_severity);
      const legacyAoIDebtMax = numberValue(legacyCandidate.currentImportanceGain?.aoi_debt_max_severity);
      const objectiveOldestTargets = numberValue(objectiveCandidate.currentImportanceGain?.aoi_debt_oldest_target_count);
      const legacyOldestTargets = numberValue(legacyCandidate.currentImportanceGain?.aoi_debt_oldest_target_count);
      const objectiveAoIDebt = numberValue(objectiveCandidate.currentImportanceGain?.aoi_debt_severity);
      const legacyAoIDebt = numberValue(legacyCandidate.currentImportanceGain?.aoi_debt_severity);
      const objectiveInformation = numberValue(objectiveCandidate.currentMarginal?.information_gain);
      const legacyInformation = numberValue(legacyCandidate.currentMarginal?.information_gain);
      const aoiDebtPromotionAvailable = false;
      const aoiDebtOverride = shouldUseAoIDebtOverride({
        promotionAvailable: aoiDebtPromotionAvailable,
        objective: {
          maxSeverity: objectiveAoIDebtMax,
          oldestTargets: objectiveOldestTargets,
          debtSeverity: objectiveAoIDebt,
          informationGain: objectiveInformation,
        },
        legacy: {
          maxSeverity: legacyAoIDebtMax,
          oldestTargets: legacyOldestTargets,
          debtSeverity: legacyAoIDebt,
          informationGain: legacyInformation,
        },
        informationFloor: importanceAoIShadowInformationFloor,
      });
      bestIndex = aoiDebtOverride ? objectiveBestIndex : Number(shadowGuard.selected);
      pending[bestIndex].currentLegacyShadowGuardDecision = aoiDebtOverride
        ? "aoi-debt-coverage-within-information-floor"
        : shadowGuard.reason;
      pending[bestIndex].currentImportanceAoIDebtPromotion = aoiDebtOverride || (
        aoiDebtPromotionAvailable &&
        bestIndex === objectiveBestIndex &&
        objectiveBestIndex !== legacyBestIndex &&
        numberValue(objectiveCandidate.currentImportanceGain?.aoi_debt_target_count) > 0
      );
      item = pending.splice(bestIndex, 1)[0];
    } else if (!item) {
      item = pending.shift();
    }
    const addsCoverage = item.pathLinks.some((linkId) => !covered.has(linkId));
    const coverageStillNeeded = covered.size < targetCoveredLinks;
    const highEnergyRisk = item.energyRisk >= energyGuardThreshold;
    const localRiskCritical = numberValue(item.localAdaptive?.risk) >= 0.6;
    const itemBytes = scaleBudgetEnabled
      ? numberValue(
          item.telemetryCost.estimated_generated_telemetry_bytes,
          item.telemetryCost.estimated_total_telemetry_bytes,
        )
      : numberValue(item.telemetryCost.estimated_total_telemetry_bytes);
    const itemMandatoryTargetIds = mandatoryOamTargetIds(item);
    const newMandatoryTargetIds = uncoveredMandatoryOamTargetIds(item, coveredMandatoryOamTargets);
    item.currentNewMandatoryTargetIds = newMandatoryTargetIds;
    const budgetWouldExceed = telemetryBudgetEnabled &&
      (scaleBudgetEnabled || selected.length >= minPaths) &&
      telemetryBudgetUsedBytes + itemBytes > planningTelemetryByteBudgetPerSlice;
    const criticalBudgetOverride = !scaleBudgetEnabled && (
      addsCoverage && coverageStillNeeded ||
        newMandatoryTargetIds.length > 0 ||
        localRiskCritical ||
        numberValue(item.forecastProfile.forecast_near_outage_score) >= 0.5
    );
    const repeatsOnlyOamTargets = itemMandatoryTargetIds.length > 0 &&
      newMandatoryTargetIds.length === 0 &&
      !addsCoverage &&
      !localRiskCritical &&
      numberValue(item.forecastProfile.forecast_near_outage_score) < 0.5;
    if (repeatsOnlyOamTargets) {
      oamDuplicateTargetOnlySuppressedPaths += 1;
      continue;
    }
    const stableReuseDuplicate = candidateSource === "topology-reuse-cache" &&
      adaptiveProbeBudgetEnabled &&
      numberValue(adaptiveProbeBudget.adaptive_probe_budget_scale, 1) < 1 &&
      !addsCoverage &&
      !criticalBudgetOverride &&
      selected.length >= minPaths;
    if (stableReuseDuplicate) {
      reuseDuplicateSuppressedPaths += 1;
      continue;
    }
    if (budgetWouldExceed && !criticalBudgetOverride) {
      telemetryBudgetSuppressedPaths += 1;
      continue;
    }
    if (highEnergyRisk && !localRiskCritical && selected.length >= requestedPathCount && (!addsCoverage || !coverageStillNeeded)) {
      energyGuardSuppressedPaths += 1;
      continue;
    }
    const activeRequestedPathCount = requestedPathCount;
    if (selected.length < activeRequestedPathCount || (covered.size < targetCoveredLinks && addsCoverage) || (localRiskCritical && addsCoverage)) {
      if (budgetWouldExceed && criticalBudgetOverride) telemetryBudgetOverridePaths += 1;
      telemetryBudgetUsedBytes += itemBytes;
      const marginal = item.currentMarginal ?? marginalInformationForPath({
        item,
        covered,
        sliceIndex: slicePlan.slice_index,
        linksBySliceAndId,
      });
      const currentCostScore = item.currentCostScore ?? costAwarePathScore({
        score: item.score,
        informationGain: marginal.information_gain,
        cost: item.telemetryCost,
        forecastProfile: item.forecastProfile,
        diversity: item.pathLinks.filter((linkId) => !covered.has(linkId)).length / Math.max(item.pathLinks.length, 1),
        oamFeedback: item.oamFeedback,
        oamControl: item.oamControl,
        weight: costAwarenessWeight,
      });
      item.selectedMarginal = marginal;
      item.selectedCostScore = currentCostScore;
      item.selectedMultiObjectiveScore = item.currentMultiObjectiveScore ?? item.multiObjectiveScore;
      item.selectedTopologyVersionedObjective = item.currentTopologyVersionedObjective ?? item.topologyVersionedObjective ??
        evaluateTopologyVersionedPathObjective({
          enabled: topologyVersionedObjectiveEnabled,
          topologyClassId: slicePlan.topology_class_id,
          topologySignature: slicePlan.topology_signature,
          candidateSource: item.candidateSource,
          planningRepairCount: item.path.planning_repair_count,
          activeLinkCount: activeLinks.length,
          linkSignals: item.linkWeights.map((signal) => ({
            link_id: signal.link_id,
            uncertainty: signal.uncertainty_score,
            topology_risk: signal.topology_risk_score,
            age: signal.age_score,
            covered: covered.has(signal.link_id),
          })),
          nodeSignals: item.nodeStateSignals.map((signal) => ({
            ...signal,
            covered: coveredNodes.has(signal.node_id),
          })),
          telemetryCost: item.rankingTelemetryCost ?? item.telemetryCost,
          costReferences: objectiveCostReferences,
          nodeInformationGain: item.node_state_information_gain,
          oamTargetScore: numberValue(item.oamFeedback?.score) + numberValue(item.oamControl?.score),
          metadataProfile: item.metadataProfile?.profile,
          baselineRankingScore: costAwareSampling ? currentCostScore.cost_aware_score : marginal.information_gain,
          weights: topologyVersionedObjectiveWeights,
          confidenceThreshold: topologyVersionedConfidenceThreshold,
        });
      item.selectedLegacyShadowGuardDecision = item.currentLegacyShadowGuardDecision ??
        (topologyVersionedObjectiveEnabled ? "legacy-shadow-not-evaluated" : "disabled");
      item.telemetryBudgetDecision = telemetryBudgetEnabled
        ? budgetWouldExceed
          ? "critical-coverage-override"
          : "within-budget"
        : "budget-disabled";
      item.telemetryBudgetUsedBytesAfterSelection = telemetryBudgetUsedBytes;
      item.telemetryBudgetRemainingBytesAfterSelection = telemetryBudgetEnabled
        ? planningTelemetryByteBudgetPerSlice - telemetryBudgetUsedBytes
        : "";
      item.selectedNewMandatoryTargetIds = newMandatoryTargetIds;
      item.selectedImportanceGain = item.currentImportanceGain ?? item.importanceGain;
      item.selectedImportanceNormalizedGain = item.currentImportanceNormalizedGain ?? item.importanceNormalizedGain ?? 0;
      item.selectedImportanceScoreBonus = item.currentImportanceScoreBonus ?? item.importanceScoreBonus ?? 0;
      item.selectedImportanceAoIDebtScoreBonus = item.currentImportanceAoIDebtScoreBonus ?? item.importanceAoIDebtScoreBonus ?? 0;
      selected.push(item);
      if (item.currentImportanceAoIDebtPromotion) importanceAoIDebtPromotedPaths += 1;
      item.pathLinks.forEach((linkId) => covered.add(linkId));
      item.pathNodes.forEach((nodeId) => coveredNodes.add(nodeId));
      itemMandatoryTargetIds.forEach((targetId) => coveredMandatoryOamTargets.add(targetId));
      (item.selectedImportanceGain?.target_ids ?? []).forEach((targetId) => coveredImportanceTargets.add(targetId));
    }
  }
  }

  const importanceBaseSelectedPathCount = selected.length;
  let importanceBudgetNeutralPlan = {
    rows: selected.map((item, index) => ({ __selected_index: index, ...item.path })),
    replacements: [],
    before_bytes: telemetryBudgetUsedBytes,
    after_bytes: telemetryBudgetUsedBytes,
    before_weighted_target_coverage: 0,
    after_weighted_target_coverage: 0,
    path_count_preserved: true,
  };
  if (
    !topologyVersionedRiskPlannerEnabled &&
    importancePathScoringEnabled &&
    importanceBudgetNeutralReplacementEnabled &&
    selected.length > 0 &&
    importanceTargets.length > 0
  ) {
    const selectedKeys = new Set(selected.map((item) => `${item.path.path}|${item.path.link_ids}`));
    const replacementCandidates = scored.filter(
      (item) => !selectedKeys.has(`${item.path.path}|${item.path.link_ids}`),
    );
    const descriptorForItem = (item, source, index) => ({
      ...item.path,
      [`__${source}_index`]: index,
      importance_base_value: numberValue(
        item.selectedMarginal?.information_gain,
        numberValue(item.base_information_gain, item.score),
      ),
      importance_budget_bytes: numberValue(
        item.telemetryCost?.estimated_generated_telemetry_bytes,
        item.telemetryCost?.estimated_total_telemetry_bytes,
      ),
    });
    importanceBudgetNeutralPlan = selectBudgetNeutralImportanceReplacements({
      baseRows: selected.map((item, index) => descriptorForItem(item, "selected", index)),
      candidateRows: replacementCandidates.map((item, index) => descriptorForItem(item, "candidate", index)),
      targets: importanceTargets,
      maxTotalBytes: planningTelemetryByteBudgetPerSlice > 0
        ? planningTelemetryByteBudgetPerSlice
        : telemetryBudgetUsedBytes,
      maxReplacements: Math.max(1, Math.ceil(selected.length * clamp(importanceReplacementRatio, 0, 0.5))),
      maxBaseValueLossRatio: importanceReplacementMaxBaseLossRatio,
    });
    const replacementItems = importanceBudgetNeutralPlan.rows.map((descriptor) => {
      if (descriptor.__candidate_index === undefined) {
        return selected[numberValue(descriptor.__selected_index, -1)];
      }
      const item = replacementCandidates[numberValue(descriptor.__candidate_index, -1)];
      if (!item) return null;
      item.path = {
        ...item.path,
        planning_importance_budget_neutral_replacement: true,
        planning_importance_replaced_probe_id: descriptor.planning_importance_replaced_probe_id ?? "",
        planning_importance_replacement_target_ids: descriptor.planning_importance_replacement_target_ids ?? "",
        planning_importance_replacement_target_gain: descriptor.planning_importance_replacement_target_gain ?? 0,
      };
      item.selectedMarginal = item.currentMarginal ?? {
        information_gain: item.base_information_gain,
        redundancy_penalty: 0,
        novelty_ratio: 1,
      };
      item.selectedCostScore = item.currentCostScore ?? item.costScore;
      item.selectedMultiObjectiveScore = item.currentMultiObjectiveScore ?? item.multiObjectiveScore;
      item.selectedTopologyVersionedObjective = item.currentTopologyVersionedObjective ?? item.topologyVersionedObjective;
      item.selectedLegacyShadowGuardDecision = "budget-neutral-low-value-path-replacement";
      item.telemetryBudgetDecision = "budget-neutral-replacement-within-hard-cap";
      item.selectedNewMandatoryTargetIds = uncoveredMandatoryOamTargetIds(item, new Set());
      item.selectedImportanceGain = item.importanceGain;
      item.selectedImportanceNormalizedGain = clamp(
        numberValue(item.importanceGain?.gain_per_kb) / importanceEfficiencyReference,
        0,
        1,
      );
      item.selectedImportanceScoreBonus = 0;
      item.selectedImportanceAoIDebtScoreBonus = 0;
      item.currentImportanceAoIDebtPromotion = true;
      item.selectedImportanceBudgetNeutralReplacement = true;
      return item;
    }).filter(Boolean);
    selected.splice(0, selected.length, ...replacementItems);
    covered.clear();
    coveredNodes.clear();
    coveredMandatoryOamTargets.clear();
    coveredImportanceTargets.clear();
    selected.forEach((item) => {
      item.pathLinks.forEach((linkId) => covered.add(linkId));
      item.pathNodes.forEach((nodeId) => coveredNodes.add(nodeId));
      mandatoryOamTargetIds(item).forEach((targetId) => coveredMandatoryOamTargets.add(targetId));
      (item.selectedImportanceGain?.target_ids ?? item.importanceGain?.target_ids ?? [])
        .forEach((targetId) => coveredImportanceTargets.add(targetId));
    });
    telemetryBudgetUsedBytes = selected.reduce((sum, item) => sum + numberValue(
      item.telemetryCost?.estimated_generated_telemetry_bytes,
      item.telemetryCost?.estimated_total_telemetry_bytes,
    ), 0);
    importanceAoIDebtPromotedPaths += importanceBudgetNeutralPlan.replacements.length;
  }
  const importanceOldestCoverageRepairFloor = !topologyVersionedRiskPlannerEnabled && importancePathScoringEnabled &&
    !importanceBudgetNeutralReplacementEnabled &&
    importanceMaxAoIDebtSeverity >= 1 &&
    importanceOldestTargetCount > importanceOldestTargetsPerPath
    ? importanceAoIDebtPathLimit
    : 0;
  const importanceAdditiveRepairPathLimit = !topologyVersionedRiskPlannerEnabled && importancePathScoringEnabled && !importanceBudgetNeutralReplacementEnabled
    ? computeBoundedAdditiveRepairPathLimit({
        basePathCount: selected.length,
        ratio: importanceAoIDebtPathRatio,
        remainingCandidateCount: Math.max(0, scored.length - selected.length),
        minimumPathCount: importanceOldestCoverageRepairFloor,
      })
    : 0;
  const importanceBaseEstimatedBytes = selected.reduce(
    (sum, item) => sum + numberValue(item.telemetryCost?.estimated_total_telemetry_bytes),
    0,
  );
  const importanceAdditiveRepairByteBudget = importanceBudgetNeutralReplacementEnabled
    ? 0
    : round(importanceBaseEstimatedBytes * clamp(importanceRepairByteBudgetRatio, 0, 0.5));
  const selectedBasePathKeys = new Set(selected.map((item) => `${item.path.path}|${item.path.link_ids}`));
  const importanceRepairCandidateItems = scored.filter(
    (item) => !selectedBasePathKeys.has(`${item.path.path}|${item.path.link_ids}`),
  );
  const importanceRepairPlan = selectBoundedImportanceRepairRows({
    baseRows: selected.map((item, index) => ({
      ...item.path,
      __selected_index: index,
    })),
    candidateRows: importanceRepairCandidateItems.map((item, index) => ({
      ...item.path,
      __repair_candidate_index: index,
    })),
    targets: importanceTargets,
    maxAdditionalPaths: importanceAdditiveRepairPathLimit,
    maxAdditionalBytes: importanceAdditiveRepairByteBudget,
    probePacketBaseBytes,
    reportHeaderBytes,
    requireStrongEvidence: true,
  });
  importanceRepairPlan.repair_rows.forEach((repairRow) => {
    const item = importanceRepairCandidateItems[numberValue(repairRow.__repair_candidate_index, -1)];
    if (!item) return;
    const marginal = marginalInformationForPath({
      item,
      covered,
      sliceIndex: slicePlan.slice_index,
      linksBySliceAndId,
    });
    const gain = importanceGainForCandidate({
      pathNodes: item.pathNodes,
      pathLinks: item.pathLinks,
      targets: importanceTargets,
      coveredTargetKeys: coveredImportanceTargets,
      probePacketBaseBytes,
      reportHeaderBytes,
      maxAoIDebtSeverity: importanceMaxAoIDebtSeverity,
      includeAdjacentLinkTargets: true,
    });
    if (numberValue(gain.target_count) <= 0) return;
    const costScore = costAwarePathScore({
      score: item.score,
      informationGain: marginal.information_gain,
      cost: item.telemetryCost,
      forecastProfile: item.forecastProfile,
      diversity: item.pathLinks.filter((linkId) => !covered.has(linkId)).length / Math.max(item.pathLinks.length, 1),
      oamFeedback: item.oamFeedback,
      oamControl: item.oamControl,
      weight: costAwarenessWeight,
    });
    item.path = {
      ...item.path,
      planning_importance_additive_repair: true,
      planning_importance_repair_actual_bytes: repairRow.importance_repair_actual_bytes,
      planning_importance_repair_target_ids: repairRow.importance_repair_target_ids,
    };
    item.selectedMarginal = marginal;
    item.selectedCostScore = costScore;
    item.selectedMultiObjectiveScore = item.multiObjectiveScore;
    item.selectedTopologyVersionedObjective = item.topologyVersionedObjective;
    item.selectedLegacyShadowGuardDecision = "bounded-additive-importance-repair-after-base-complete";
    item.telemetryBudgetDecision = "importance-repair-within-selective-byte-reserve";
    item.telemetryBudgetUsedBytesAfterSelection = telemetryBudgetUsedBytes + numberValue(repairRow.importance_repair_actual_bytes);
    item.telemetryBudgetRemainingBytesAfterSelection = Math.max(
      0,
      importanceAdditiveRepairByteBudget - numberValue(repairRow.importance_repair_actual_bytes),
    );
    item.selectedNewMandatoryTargetIds = uncoveredMandatoryOamTargetIds(item, coveredMandatoryOamTargets);
    item.selectedImportanceGain = gain;
    item.selectedImportanceNormalizedGain = clamp(
      numberValue(gain.gain_per_kb) / importanceEfficiencyReference,
      0,
      1,
    );
    item.selectedImportanceScoreBonus = 0;
    item.selectedImportanceAoIDebtScoreBonus = 0;
    item.currentImportanceAoIDebtPromotion = true;
    item.selectedImportanceAdditiveRepair = true;
    selected.push(item);
    importanceAoIDebtPromotedPaths += 1;
    telemetryBudgetUsedBytes += numberValue(repairRow.importance_repair_actual_bytes);
    item.pathLinks.forEach((linkId) => covered.add(linkId));
    item.pathNodes.forEach((nodeId) => coveredNodes.add(nodeId));
    mandatoryOamTargetIds(item).forEach((targetId) => coveredMandatoryOamTargets.add(targetId));
    gain.target_ids.forEach((targetId) => coveredImportanceTargets.add(targetId));
  });

  let finalizedTelemetryBudgetBytes = 0;
  selected.forEach((item) => {
    const selectedBytes = scaleBudgetEnabled
      ? numberValue(
          item.telemetryCost?.estimated_generated_telemetry_bytes,
          item.telemetryCost?.estimated_total_telemetry_bytes,
        )
      : numberValue(item.telemetryCost?.estimated_total_telemetry_bytes);
    finalizedTelemetryBudgetBytes += selectedBytes;
    item.telemetryBudgetUsedBytesAfterSelection = round(finalizedTelemetryBudgetBytes);
    item.telemetryBudgetRemainingBytesAfterSelection = telemetryBudgetEnabled
      ? round(Math.max(0, planningTelemetryByteBudgetPerSlice - finalizedTelemetryBudgetBytes))
      : "";
  });
  telemetryBudgetUsedBytes = finalizedTelemetryBudgetBytes;

  if (!topologyVersionedRiskPlannerEnabled) {
    enforceMetadataCompressionQuota({
      selected,
      adaptiveMetadataProfileEnabled,
      adaptiveProbeBudget,
      hopMetadataBytes,
      costAwarenessWeight,
      probePacketBaseBytes,
      reportHeaderBytes,
      hopProcessingJ,
      reportProcessingJ,
      telemetryTxNjPerByte,
      multiObjectiveBudgetEnabled,
    });
  }

  selected.forEach((item) => {
    const observations = item.unifiedPlannerAction?.observations;
    const observedLinks = observations
      ? observations.filter((observation) => observation.type === "link").map((observation) => observation.id)
      : item.pathLinks;
    const observedNodes = observations
      ? observations.filter((observation) => observation.type === "node").map((observation) => observation.id)
      : item.pathNodes;
    observedLinks.forEach((linkId) => selectedLastSeen.set(linkId, slicePosition));
    observedNodes.forEach((nodeId) => selectedNodeLastSeen.set(nodeId, slicePosition));
  });

  const repairedCandidatePaths = planningCandidates.filter((path) => numberValue(path.planning_repair_count) > 0).length;
  const selectedRepairedPaths = selected.filter((item) => numberValue(item.path.planning_repair_count) > 0).length;
  const unifiedPlanningMode = unifiedPlannerDecision?.selected_mode ?? "";
  const effectiveCandidateSource = unifiedPlanningMode === "reuse"
    ? "topology-reuse-cache"
    : unifiedPlanningMode === "repair"
      ? "topology-reuse-cache-local-repair"
      : unifiedPlanningMode === "fresh"
        ? "fresh-slice-plan"
        : candidateSource;
  const planningCost = estimatePlanningCost({
    candidateSource: effectiveCandidateSource,
    topologyReuseDecision: slicePlan.topology_reuse_decision,
    activeLinkCount: activeLinks.length,
    candidatePathCount: candidatePaths.length,
    planningCandidateCount: planningCandidates.length,
    repairedCandidatePaths,
    selectedPaths: selected.length,
    selectedRepairedPaths,
    oamReplanTargets: slicePlan.oam_replan_targets,
  });

  const rows = selected.map((item, index) => ({
    ...item.path,
    probe_id: `${algorithm}-${String(slicePlan.slice_index).padStart(2, "0")}-${String(index + 1).padStart(3, "0")}`,
    planning_algorithm: algorithm,
    source_candidate_probe_id: item.path.probe_id,
    source_candidate_algorithm: item.path.planning_algorithm,
    ...currentSelectionImportanceRepairFields({
      row: item.path,
      selectedAsRepair: item.selectedImportanceAdditiveRepair === true,
    }),
    topology_class_id: slicePlan.topology_class_id,
    topology_signature: slicePlan.topology_signature,
    topology_version_id: slicePlan.topology_version_id,
    topology_forecast_horizon_slices: slicePlan.topology_forecast_horizon_slices,
    topology_forecast_stable_window_slices: slicePlan.topology_forecast_stable_window_slices,
    topology_forecast_next_major_drift_in_slices: slicePlan.topology_forecast_next_major_drift_in_slices,
    topology_forecast_mean_similarity: slicePlan.topology_forecast_mean_similarity,
    topology_forecast_min_similarity: slicePlan.topology_forecast_min_similarity,
    topology_forecast_drift_pressure: slicePlan.topology_forecast_drift_pressure,
    topology_forecast_reuse_confidence: slicePlan.topology_forecast_reuse_confidence,
    topology_forecast_recommended_plan_mode: slicePlan.topology_forecast_recommended_plan_mode,
    topology_forecast_target_sampling_boost: round(topologyForecastTargetBoost),
    unified_planner_enabled: topologyVersionedRiskPlannerEnabled,
    unified_planner_mode: unifiedPlannerDecision?.selected_mode ?? "legacy",
    unified_mode_prefilter_policy: slicePlan.unified_mode_prefilter_policy ?? "legacy",
    unified_mode_prefilter_selected_modes: slicePlan.unified_mode_prefilter_selected_modes ?? "",
    unified_metadata_action: item.unifiedPlannerAction?.metadata_action ?? "legacy",
    unified_marginal_value: item.unifiedPlannerAction?.marginal_value ?? "",
    unified_marginal_risk_gain: item.unifiedPlannerAction?.marginal_risk_gain ?? "",
    unified_value_per_byte: item.unifiedPlannerAction?.marginal_value_per_byte ?? "",
    unified_observed_node_ids: item.unifiedPlannerAction
      ? item.unifiedPlannerAction.observations.filter((observation) => observation.type === "node").map((observation) => observation.id).join(" > ")
      : item.pathNodes.join(" > "),
    unified_observed_link_ids: item.unifiedPlannerAction
      ? item.unifiedPlannerAction.observations.filter((observation) => observation.type === "link").map((observation) => observation.id).join(" > ")
      : item.pathLinks.join(" > "),
    selective_metadata_enabled: Boolean(item.unifiedSelectiveMetadataPlan),
    selective_metadata_plan_json: item.unifiedSelectiveMetadataPlan
      ? JSON.stringify(item.unifiedSelectiveMetadataPlan.hops)
      : "",
    target_mask_bytes: item.unifiedSelectiveMetadataPlan?.target_mask_bytes ?? 0,
    selective_metadata_bytes: item.unifiedSelectiveMetadataPlan?.metadata_bytes ?? "",
    selective_metadata_saved_bytes: item.unifiedSelectiveMetadataPlan?.saved_payload_bytes ?? "",
    forward_only_hop_count: item.unifiedSelectiveMetadataPlan
      ? item.unifiedSelectiveMetadataPlan.hops.filter((hop) => !hop.writes_observation).length
      : 0,
    int_mc_score: item.selectedCostScore?.cost_aware_score ?? item.costScore.cost_aware_score,
    base_int_mc_score: round(item.base_int_mc_score),
    low_rank_path_information_gain: item.selectedMarginal?.information_gain ?? round(item.base_information_gain),
    base_path_information_gain: item.selectedMarginal?.base_information_gain ?? round(item.base_information_gain),
    marginal_information_gain: item.selectedMarginal?.information_gain ?? round(item.base_information_gain),
    marginal_redundancy_penalty: item.selectedMarginal?.redundancy_penalty ?? 0,
    marginal_novelty_ratio: item.selectedMarginal?.novelty_ratio ?? 1,
    marginal_new_link_count: item.selectedMarginal?.new_link_count ?? item.pathLinks.length,
    marginal_link_gains: item.selectedMarginal?.marginal_link_gains ?? "",
    score_formula: item.selectedCostScore?.score_formula ?? item.costScore.score_formula,
    score_numerator_information_gain: item.selectedCostScore?.score_numerator_information_gain ?? item.costScore.score_numerator_information_gain,
    score_denominator_telemetry_kb: item.selectedCostScore?.score_denominator_telemetry_kb ?? item.costScore.score_denominator_telemetry_kb,
    topology_versioned_objective_enabled: topologyVersionedObjectiveEnabled,
    topology_versioned_objective_value: item.selectedTopologyVersionedObjective?.objective_value ?? "",
    topology_versioned_no_probe_objective: item.selectedTopologyVersionedObjective?.no_probe_objective ?? "",
    topology_versioned_objective_advantage: item.selectedTopologyVersionedObjective?.objective_advantage ?? "",
    topology_versioned_information_gain: item.selectedTopologyVersionedObjective?.information_gain ?? "",
    topology_versioned_redundancy_penalty: item.selectedTopologyVersionedObjective?.redundancy_penalty ?? "",
    topology_versioned_node_information_gain: item.selectedTopologyVersionedObjective?.node_information_gain ?? "",
    topology_versioned_node_redundancy_penalty: item.selectedTopologyVersionedObjective?.node_redundancy_penalty ?? "",
    topology_versioned_expected_error_reduction: item.selectedTopologyVersionedObjective?.expected_error_reduction ?? "",
    topology_versioned_expected_residual_error: item.selectedTopologyVersionedObjective?.expected_residual_error ?? "",
    topology_versioned_expected_aoi_reduction: item.selectedTopologyVersionedObjective?.expected_aoi_reduction ?? "",
    topology_versioned_expected_residual_aoi: item.selectedTopologyVersionedObjective?.expected_residual_aoi ?? "",
    topology_versioned_normalized_bytes_cost: item.selectedTopologyVersionedObjective?.normalized_bytes_cost ?? "",
    topology_versioned_normalized_energy_cost: item.selectedTopologyVersionedObjective?.normalized_energy_cost ?? "",
    topology_versioned_normalized_planning_cost: item.selectedTopologyVersionedObjective?.normalized_planning_cost ?? "",
    topology_versioned_evidence_confidence: item.selectedTopologyVersionedObjective?.evidence_confidence ?? "",
    topology_versioned_path_topology_share: item.selectedTopologyVersionedObjective?.path_topology_share ?? "",
    topology_versioned_structural_granularity_scale: item.selectedTopologyVersionedObjective?.structural_granularity_scale ?? "",
    topology_versioned_gate_decision: item.selectedTopologyVersionedObjective?.gate_decision ?? "",
    topology_versioned_legacy_shadow_guard: item.selectedLegacyShadowGuardDecision,
    topology_versioned_score_adjustment: item.selectedTopologyVersionedObjective?.conservative_score_adjustment ?? 0,
    topology_versioned_ranking_score: item.selectedTopologyVersionedObjective?.ranking_score ?? item.rankingScore,
    topology_versioned_metadata_observation_yield: item.selectedTopologyVersionedObjective?.metadata_observation_yield ?? "",
    topology_versioned_objective_formula: item.selectedTopologyVersionedObjective?.objective_formula ?? "legacy-ranking",
    topology_versioned_information_formula: item.selectedTopologyVersionedObjective?.information_formula ?? "legacy-ranking",
    importance_path_scoring_enabled: importancePathScoringEnabled,
    importance_budget_neutral_replacement_enabled: importanceBudgetNeutralReplacementEnabled,
    importance_budget_neutral_replacement: Boolean(item.selectedImportanceBudgetNeutralReplacement),
    importance_replaced_probe_id: item.path.planning_importance_replaced_probe_id ?? "",
    importance_replacement_target_ids: item.path.planning_importance_replacement_target_ids ?? "",
    importance_replacement_target_gain: item.path.planning_importance_replacement_target_gain ?? 0,
    importance_target_gain: item.selectedImportanceGain?.information_gain ?? item.importanceGain?.information_gain ?? 0,
    importance_target_gain_per_kb: item.selectedImportanceGain?.gain_per_kb ?? item.importanceGain?.gain_per_kb ?? 0,
    importance_target_count: item.selectedImportanceGain?.target_count ?? item.importanceGain?.target_count ?? 0,
    importance_mandatory_target_count: item.selectedImportanceGain?.mandatory_target_count ?? item.importanceGain?.mandatory_target_count ?? 0,
    importance_aoi_debt_target_count: item.selectedImportanceGain?.aoi_debt_target_count ?? item.importanceGain?.aoi_debt_target_count ?? 0,
    importance_aoi_debt_severity: item.selectedImportanceGain?.aoi_debt_severity ?? item.importanceGain?.aoi_debt_severity ?? 0,
    importance_aoi_debt_max_severity: item.selectedImportanceGain?.aoi_debt_max_severity ?? item.importanceGain?.aoi_debt_max_severity ?? 0,
    importance_aoi_debt_oldest_target_count: item.selectedImportanceGain?.aoi_debt_oldest_target_count ?? item.importanceGain?.aoi_debt_oldest_target_count ?? 0,
    importance_aoi_debt_target_ids: (item.selectedImportanceGain?.aoi_debt_target_ids ?? item.importanceGain?.aoi_debt_target_ids ?? []).join(" > "),
    importance_target_ids: (item.selectedImportanceGain?.target_ids ?? item.importanceGain?.target_ids ?? []).join(" > "),
    importance_normalized_gain: item.selectedImportanceNormalizedGain ?? item.importanceNormalizedGain ?? 0,
    importance_score_bonus: item.selectedImportanceScoreBonus ?? item.importanceScoreBonus ?? 0,
    importance_aoi_debt_score_bonus: item.selectedImportanceAoIDebtScoreBonus ?? item.importanceAoIDebtScoreBonus ?? 0,
    importance_aoi_debt_promotion: Boolean(item.currentImportanceAoIDebtPromotion),
    cost_aware_sampling_enabled: costAwareSampling,
    cost_awareness_weight: costAwarenessWeight,
    oam_budget_applied: oamBudget.oam_budget_applied,
    oam_budget_policy: oamBudget.oam_budget_policy,
    oam_budget_action: oamBudget.oam_budget_action,
    oam_budget_reason: oamBudget.oam_budget_reason,
    oam_budget_source: oamBudget.oam_budget_source,
    configured_sampling_rate: oamBudget.configured_sampling_rate,
    configured_target_active_link_sampling_rate: oamBudget.configured_target_active_link_sampling_rate,
    configured_telemetry_byte_budget_per_slice: oamBudget.configured_telemetry_byte_budget_per_slice,
    oam_recommended_sampling_rate: oamBudget.oam_recommended_sampling_rate,
    oam_recommended_target_active_link_sampling_rate: oamBudget.oam_recommended_target_active_link_sampling_rate,
    oam_recommended_telemetry_byte_budget_per_slice: oamBudget.oam_recommended_telemetry_byte_budget_per_slice,
    oam_recommended_downlink_budget_bytes: oamBudget.oam_recommended_downlink_budget_bytes,
    oam_coverage_demand_pressure: oamBudget.coverage_demand_pressure,
    adaptive_probe_budget_enabled: adaptiveProbeBudget.adaptive_probe_budget_enabled,
    adaptive_probe_budget_applied: adaptiveProbeBudget.adaptive_probe_budget_applied,
    adaptive_probe_budget_policy: adaptiveProbeBudget.adaptive_probe_budget_policy,
    adaptive_probe_budget_reason: adaptiveProbeBudget.adaptive_probe_budget_reason,
    adaptive_probe_budget_scale: adaptiveProbeBudget.adaptive_probe_budget_scale,
    adaptive_probe_budget_sampling_rate: adaptiveProbeBudget.adaptive_probe_budget_sampling_rate,
    adaptive_probe_budget_target_active_link_sampling_rate: adaptiveProbeBudget.adaptive_probe_budget_target_active_link_sampling_rate,
    adaptive_probe_budget_telemetry_byte_budget_per_slice: adaptiveProbeBudget.adaptive_probe_budget_telemetry_byte_budget_per_slice,
    adaptive_probe_budget_oam_pressure: adaptiveProbeBudget.adaptive_probe_budget_oam_pressure,
    adaptive_probe_budget_slice_traffic_risk: adaptiveProbeBudget.adaptive_probe_budget_slice_traffic_risk,
    adaptive_probe_budget_reuse_confidence: adaptiveProbeBudget.adaptive_probe_budget_reuse_confidence,
    adaptive_probe_budget_reuse_margin: adaptiveProbeBudget.adaptive_probe_budget_reuse_margin,
    adaptive_probe_budget_drift_pressure: adaptiveProbeBudget.adaptive_probe_budget_drift_pressure,
    scale_budget_enabled: scaleBudgetEnabled,
    scale_budget_source: scaleBudget?.byte_budget_source ?? "disabled",
    scale_budget_bytes: scaleBudget?.byte_budget ?? 0,
    scale_budget_derived_bytes: scaleBudget?.derived_byte_budget ?? 0,
    scale_budget_witness_paths: scaleBudget?.witness_path_count ?? 0,
    scale_budget_safe_path_cap: scaleBudget?.safe_path_cap ?? configuredSelectedLimit,
    scale_budget_target_node_count: scaleBudget?.target_node_count ?? 0,
    scale_budget_target_active_link_count: scaleBudget?.target_active_link_count ?? 0,
    scale_budget_coverage_feasibility: scaleBudget?.coverage_feasibility ?? "disabled",
    scale_budget_feasible_aoi_bound_slices: scaleBudget?.feasible_aoi_bound_slices ?? "",
    configured_max_paths_per_slice: configuredSelectedLimit,
    adaptive_probe_budget_configured_max_paths_per_slice: adaptiveProbeBudget.adaptive_probe_budget_configured_max_paths_per_slice,
    adaptive_probe_budget_effective_max_paths_per_slice: adaptiveProbeBudget.adaptive_probe_budget_effective_max_paths_per_slice,
    adaptive_probe_budget_path_cap_policy: adaptiveProbeBudget.adaptive_probe_budget_path_cap_policy,
    adaptive_metadata_profile: item.metadataProfile.profile,
    adaptive_metadata_profile_policy: item.metadataProfile.policy,
    adaptive_metadata_profile_reason: item.metadataProfile.reason,
    adaptive_link_observation_mode: item.metadataProfile.observation_mode ??
      (compactMetadataProfile(item.metadataProfile.profile) ? "path-only" : "all-adjacent"),
    adaptive_link_observation_policy: targetAwareMetadataProfile(item.metadataProfile.profile)
      ? "mandatory-oam-target-neighborhood-observation"
      : compactMetadataProfile(item.metadataProfile.profile)
        ? "stable-reuse-path-only-observation"
        : "full-adjacent-link-observation",
    configured_hop_metadata_bytes: hopMetadataBytes,
    effective_hop_metadata_bytes: item.metadataProfile.effective_hop_metadata_bytes,
    target_hop_metadata_bytes: item.metadataProfile.target_hop_metadata_bytes ?? "",
    transit_hop_metadata_bytes: item.metadataProfile.transit_hop_metadata_bytes ?? "",
    oam_target_observation_loss_ratio: item.metadataProfile.target_observation_loss_ratio ?? "",
    oam_target_neighborhood_max_loss_ratio: item.metadataProfile.target_neighborhood_max_loss_ratio ?? "",
    metadata_compression_ratio: item.metadataProfile.compression_ratio,
    local_adaptive_sampling_policy: item.localAdaptive.policy,
    local_adaptive_sampling_reason: item.localAdaptive.reason,
    local_adaptive_sampling_risk: item.localAdaptive.risk,
    local_adaptive_sampling_score_bonus: item.localAdaptive.score_bonus,
    local_adaptive_dominant_link_id: item.localAdaptive.dominant_link_id,
    local_adaptive_dominant_link_risk: item.localAdaptive.dominant_link_risk,
    local_adaptive_high_risk_link_count: item.localAdaptive.high_risk_link_count,
    telemetry_byte_budget_enabled: telemetryBudgetEnabled,
    telemetry_byte_budget_per_slice: planningTelemetryByteBudgetPerSlice,
    telemetry_budget_decision: item.telemetryBudgetDecision ?? "not-evaluated",
    telemetry_budget_used_bytes_after_selection: item.telemetryBudgetUsedBytesAfterSelection ?? "",
    telemetry_budget_remaining_bytes_after_selection: item.telemetryBudgetRemainingBytesAfterSelection ?? "",
    cost_aware_score: item.selectedCostScore?.cost_aware_score ?? item.costScore.cost_aware_score,
    cost_aware_value_per_kb: item.selectedCostScore?.value_per_kb ?? item.costScore.value_per_kb,
    cost_aware_cost_penalty: item.selectedCostScore?.cost_penalty ?? item.costScore.cost_penalty,
    cost_aware_efficiency_bonus: item.selectedCostScore?.efficiency_bonus ?? item.costScore.efficiency_bonus,
    multi_objective_budget_enabled: multiObjectiveControl.enabled,
    multi_objective_policy: multiObjectiveControl.policy,
    multi_objective_reason: multiObjectiveControl.reason,
    multi_objective_quality_guard_pressure: multiObjectiveControl.quality_guard_pressure,
    multi_objective_cost_reduction_pressure: multiObjectiveControl.cost_reduction_pressure,
    multi_objective_path_budget_scale: multiObjectiveControl.path_budget_scale,
    multi_objective_metadata_floor_ratio: multiObjectiveControl.metadata_floor_ratio,
    multi_objective_cost_weight_scale: multiObjectiveControl.cost_weight_scale,
    multi_objective_node_state_weight_scale: multiObjectiveControl.node_state_weight_scale,
    multi_objective_link_state_weight_scale: multiObjectiveControl.link_state_weight_scale,
    multi_objective_score: item.selectedMultiObjectiveScore?.score ?? item.multiObjectiveScore.score,
    multi_objective_quality_bonus: item.selectedMultiObjectiveScore?.quality_bonus ?? item.multiObjectiveScore.quality_bonus,
    multi_objective_cost_penalty: item.selectedMultiObjectiveScore?.cost_penalty ?? item.multiObjectiveScore.cost_penalty,
    estimated_path_hops: item.telemetryCost.estimated_path_hops,
    estimated_metadata_bytes: item.telemetryCost.estimated_metadata_bytes,
    estimated_report_bytes: item.telemetryCost.estimated_report_bytes,
    estimated_probe_base_bytes: item.telemetryCost.estimated_probe_base_bytes,
    estimated_probe_forward_bytes: item.telemetryCost.estimated_probe_forward_bytes,
    estimated_generated_telemetry_bytes: item.telemetryCost.estimated_generated_telemetry_bytes,
    estimated_total_telemetry_bytes: item.telemetryCost.estimated_total_telemetry_bytes,
    estimated_processing_energy_j: item.telemetryCost.estimated_processing_energy_j,
    estimated_tx_energy_j: item.telemetryCost.estimated_tx_energy_j,
    estimated_total_telemetry_energy_j: item.telemetryCost.estimated_total_telemetry_energy_j,
    predicted_path_risk: item.path.predicted_path_risk,
    forecast_horizon_slices: item.forecastProfile.forecast_horizon_slices,
    forecast_observed_slices: item.forecastProfile.forecast_observed_slices,
    forecast_transition_count: item.forecastProfile.forecast_transition_count,
    forecast_transition_score: item.forecastProfile.forecast_transition_score,
    forecast_active_fraction: item.forecastProfile.forecast_active_fraction,
    forecast_future_active_fraction: item.forecastProfile.forecast_future_active_fraction,
    forecast_mean_availability: item.forecastProfile.forecast_mean_availability,
    forecast_min_availability: item.forecastProfile.forecast_min_availability,
    forecast_first_change_in_slices: item.forecastProfile.forecast_first_change_in_slices,
    forecast_first_down_in_slices: item.forecastProfile.forecast_first_down_in_slices,
    forecast_first_up_in_slices: item.forecastProfile.forecast_first_up_in_slices,
    forecast_near_change_score: item.forecastProfile.forecast_near_change_score,
    forecast_near_outage_score: item.forecastProfile.forecast_near_outage_score,
    forecast_contact_scarcity_score: item.forecastProfile.forecast_contact_scarcity_score,
    forecast_availability_risk: item.forecastProfile.forecast_availability_risk,
    forecast_priority_score: item.forecastProfile.forecast_priority_score,
    forecast_upcoming_outage_links: item.forecastProfile.forecast_upcoming_outage_links,
    forecast_upcoming_recovery_links: item.forecastProfile.forecast_upcoming_recovery_links,
    predicted_energy_risk: item.energyRisk,
    predicted_shadow_nodes: item.energyProfile.shadow_nodes,
    predicted_low_energy_nodes: item.energyProfile.low_energy_nodes,
    predicted_power_saving_nodes: item.energyProfile.power_saving_nodes,
    predicted_low_solar_nodes: item.energyProfile.low_solar_nodes,
    mean_path_energy_percent: item.energyProfile.mean_energy_percent,
    mean_path_solar_exposure: item.energyProfile.mean_solar_exposure,
    mean_path_power_margin_w: item.energyProfile.mean_power_margin_w,
    mean_path_solar_load_ratio: item.energyProfile.mean_solar_load_ratio,
    oam_feedback_score: item.oamFeedback.score,
    oam_feedback_targets: item.oamFeedback.target_count,
    oam_feedback_link_targets: item.oamFeedback.link_target_count,
    oam_feedback_node_targets: item.oamFeedback.node_target_count,
    oam_feedback_mandatory_targets: item.oamFeedback.mandatory_target_count,
    oam_feedback_mandatory_link_targets: item.oamFeedback.mandatory_link_target_count,
    oam_feedback_mandatory_node_targets: item.oamFeedback.mandatory_node_target_count,
    oam_feedback_target_ids: item.oamFeedback.target_ids,
    oam_feedback_mandatory_target_ids: item.oamFeedback.mandatory_target_ids,
    oam_feedback_mandatory_link_target_ids: item.oamFeedback.mandatory_link_target_ids,
    oam_feedback_mandatory_node_target_ids: item.oamFeedback.mandatory_node_target_ids,
    oam_feedback_reasons: item.oamFeedback.reasons,
    oam_control_score: item.oamControl.score,
    oam_control_pressure: item.oamControl.pressure,
    oam_control_action: item.oamControl.action,
    oam_control_probe_bias: item.oamControl.probe_bias,
    oam_control_confidence_budget: item.oamControl.confidence_budget,
    oam_control_source_slice_index: item.oamControl.source_slice_index,
    oam_control_target_slice_index: item.oamControl.target_slice_index,
    oam_control_next_slice_applied: item.oamControl.next_slice_applied,
    oam_control_targets: item.oamControl.target_count,
    oam_control_link_targets: item.oamControl.link_target_count,
    oam_control_node_targets: item.oamControl.node_target_count,
    oam_control_mandatory_targets: item.oamControl.mandatory_target_count,
    oam_control_mandatory_link_targets: item.oamControl.mandatory_link_target_count,
    oam_control_mandatory_node_targets: item.oamControl.mandatory_node_target_count,
    oam_control_target_ids: item.oamControl.target_ids,
    oam_control_mandatory_target_ids: item.oamControl.mandatory_target_ids,
    oam_control_mandatory_link_target_ids: item.oamControl.mandatory_link_target_ids,
    oam_control_mandatory_node_target_ids: item.oamControl.mandatory_node_target_ids,
    oam_control_reasons: item.oamControl.reasons,
    marginal_new_oam_target_count: item.selectedNewMandatoryTargetIds?.length ?? 0,
    marginal_new_oam_target_ids: (item.selectedNewMandatoryTargetIds ?? []).join(" > "),
    oam_mandatory_coverage_decision: item.oamFeedback.mandatory_target_count > 0 || item.oamControl.mandatory_target_count > 0
      ? "mandatory-oam-target-selected"
      : "not-oam-target",
    oam_mandatory_coverage_target_hits: item.oamFeedback.mandatory_target_count + item.oamControl.mandatory_target_count,
    energy_guard_threshold: energyGuardThreshold,
    energy_guard_decision: item.energyRisk >= energyGuardThreshold
      ? "critical-coverage-override"
      : "normal-telemetry",
    planning_repair_count: item.path.planning_repair_count,
    candidate_source: item.candidateSource ?? effectiveCandidateSource,
    planning_reuse_mode: unifiedPlanningMode || planningCost.planning_reuse_mode,
    planning_cache_hit: planningCost.planning_cache_hit,
    planning_cost_saving_ratio: planningCost.planning_cost_saving_ratio,
    oam_replan_pressure: slicePlan.oam_replan_pressure,
    oam_replan_targets: slicePlan.oam_replan_targets,
    oam_replan_urgent_targets: slicePlan.oam_replan_urgent_targets,
    oam_replan_pressure_threshold: slicePlan.oam_replan_pressure_threshold,
    oam_replan_triggered: slicePlan.oam_replan_triggered,
    adaptive_reuse_threshold: slicePlan.adaptive_reuse_threshold,
    adaptive_threshold_base: slicePlan.adaptive_threshold_base,
    adaptive_threshold_policy: slicePlan.adaptive_threshold_policy,
    adaptive_threshold_reason: slicePlan.adaptive_threshold_reason,
    adaptive_threshold_total_tightening: slicePlan.adaptive_threshold_total_tightening,
    adaptive_threshold_total_relaxation: slicePlan.adaptive_threshold_total_relaxation,
    adaptive_threshold_volatility_penalty: slicePlan.adaptive_threshold_volatility_penalty,
    adaptive_threshold_bottleneck_penalty: slicePlan.adaptive_threshold_bottleneck_penalty,
    adaptive_threshold_load_penalty: slicePlan.adaptive_threshold_load_penalty,
    adaptive_threshold_contact_uncertainty_penalty: slicePlan.adaptive_threshold_contact_uncertainty_penalty,
    adaptive_threshold_structural_drift_penalty: slicePlan.adaptive_threshold_structural_drift_penalty,
    adaptive_threshold_link_state_drift_penalty: slicePlan.adaptive_threshold_link_state_drift_penalty,
    adaptive_threshold_route_drift_penalty: slicePlan.adaptive_threshold_route_drift_penalty,
    adaptive_threshold_oam_pressure_penalty: slicePlan.adaptive_threshold_oam_pressure_penalty,
    adaptive_threshold_stability_credit: slicePlan.adaptive_threshold_stability_credit,
    adaptive_threshold_overhead_credit: slicePlan.adaptive_threshold_overhead_credit,
    adaptive_threshold_calibration_policy: slicePlan.adaptive_threshold_calibration_policy,
    adaptive_threshold_calibration_evidence_count: slicePlan.adaptive_threshold_calibration_evidence_count,
    adaptive_threshold_calibration_candidate_class_count: slicePlan.adaptive_threshold_calibration_candidate_class_count,
    adaptive_threshold_calibration_future_window_slices: slicePlan.adaptive_threshold_calibration_future_window_slices,
    adaptive_threshold_calibration_best_second_gap: slicePlan.adaptive_threshold_calibration_best_second_gap,
    adaptive_threshold_calibration_near_best_class_count: slicePlan.adaptive_threshold_calibration_near_best_class_count,
    adaptive_threshold_calibration_near_threshold_class_count: slicePlan.adaptive_threshold_calibration_near_threshold_class_count,
    adaptive_threshold_calibration_class_density: slicePlan.adaptive_threshold_calibration_class_density,
    adaptive_threshold_calibration_similarity_p50: slicePlan.adaptive_threshold_calibration_similarity_p50,
    adaptive_threshold_calibration_similarity_p90: slicePlan.adaptive_threshold_calibration_similarity_p90,
    adaptive_threshold_calibration_future_mean_similarity: slicePlan.adaptive_threshold_calibration_future_mean_similarity,
    adaptive_threshold_calibration_future_min_similarity: slicePlan.adaptive_threshold_calibration_future_min_similarity,
    adaptive_threshold_calibration_ambiguity_penalty: slicePlan.adaptive_threshold_calibration_ambiguity_penalty,
    adaptive_threshold_calibration_future_drift_penalty: slicePlan.adaptive_threshold_calibration_future_drift_penalty,
    adaptive_threshold_calibration_separation_credit: slicePlan.adaptive_threshold_calibration_separation_credit,
    adaptive_threshold_calibration_future_stability_credit: slicePlan.adaptive_threshold_calibration_future_stability_credit,
    adaptive_threshold_calibration_sample_support_credit: slicePlan.adaptive_threshold_calibration_sample_support_credit,
    adaptive_threshold_calibration_evidence_confidence: slicePlan.adaptive_threshold_calibration_evidence_confidence,
    adaptive_threshold_calibration_net_adjustment: slicePlan.adaptive_threshold_calibration_net_adjustment,
    topology_reuse_margin: slicePlan.topology_reuse_margin,
    topology_similarity_score: slicePlan.topology_similarity_score,
    link_state_similarity: slicePlan.link_state_similarity,
    sampling_rate: planningSamplingRate,
    target_active_link_sampling_rate: planningTargetActiveLinkSamplingRate,
    effective_sampling_rate: energyBudget.effective_sampling_rate,
    effective_target_active_link_sampling_rate: energyBudget.effective_target_active_link_sampling_rate,
    energy_budget_enabled: energyBudget.energy_budget_enabled,
    energy_budget_policy: energyBudget.energy_budget_policy,
    energy_budget_reason: energyBudget.energy_budget_reason,
    energy_budget_scale: energyBudget.energy_budget_scale,
    energy_budget_pressure: energyBudget.energy_budget_pressure,
    energy_budget_critical_coverage_credit: energyBudget.energy_budget_critical_coverage_credit,
    energy_budget_requested_paths: energyBudget.energy_budget_requested_paths,
    base_requested_paths: energyBudget.base_requested_paths,
    energy_budget_target_covered_links: energyBudget.energy_budget_target_covered_links,
    base_target_covered_links: energyBudget.base_target_covered_links,
    energy_budget_selected_limit: energyBudget.energy_budget_selected_limit,
    base_selected_limit: energyBudget.base_selected_limit,
    energy_budget_suppressed_paths: energyBudget.energy_budget_suppressed_paths,
    energy_budget_deferred_active_links: energyBudget.energy_budget_deferred_active_links,
    energy_budget_mean_path_energy_risk: energyBudget.energy_budget_mean_path_energy_risk,
    energy_budget_shadow_node_ratio: energyBudget.energy_budget_shadow_node_ratio,
    energy_budget_low_energy_node_ratio: energyBudget.energy_budget_low_energy_node_ratio,
    energy_budget_low_solar_node_ratio: energyBudget.energy_budget_low_solar_node_ratio,
    energy_budget_power_saving_node_ratio: energyBudget.energy_budget_power_saving_node_ratio,
    energy_budget_power_deficit_pressure: energyBudget.energy_budget_power_deficit_pressure,
    selection_strategy: selectionStrategy,
    selection_reason: candidateSource === "topology-reuse-cache"
      ? item.path.planning_repair_count > 0
        ? "topology-reuse-local-repair"
        : "topology-reuse-direct"
      : item.path.planning_repair_count > 0
        ? "predicted-contact-local-repair"
        : item.oamFeedback.target_count > 0
          ? "ground-oam-priority-retest-feedback"
        : item.oamControl.target_count > 0 || item.oamControl.action !== "maintain-current-plan"
          ? "ground-oam-control-action-feedback"
        : selectionStrategy === "full-int"
          ? "full-int-baseline"
          : slicePosition < warmupSlices
          ? "warmup-diversity"
          : selectionStrategy === "int-mc-leverage"
            ? "leverage-predicted-contact-plan"
            : `${selectionStrategy}-baseline`,
  }));

  return {
    rows,
    summary: {
      slice_index: slicePlan.slice_index,
      time: slicePlan.time,
      topology_class_id: slicePlan.topology_class_id,
      topology_signature: slicePlan.topology_signature,
      topology_version_id: slicePlan.topology_version_id,
      candidate_paths: candidatePaths.length,
      planning_candidate_paths: planningCandidates.length,
      selected_paths: rows.length,
      scale_budget_enabled: scaleBudgetEnabled,
      scale_budget_source: scaleBudget?.byte_budget_source ?? "disabled",
      scale_budget_bytes: scaleBudget?.byte_budget ?? 0,
      scale_budget_derived_bytes: scaleBudget?.derived_byte_budget ?? 0,
      scale_budget_witness_paths: scaleBudget?.witness_path_count ?? 0,
      scale_budget_safe_path_cap: scaleBudget?.safe_path_cap ?? configuredSelectedLimit,
      scale_budget_target_node_count: scaleBudget?.target_node_count ?? 0,
      scale_budget_target_active_link_count: scaleBudget?.target_active_link_count ?? 0,
      scale_budget_covered_nodes_within_budget: scaleBudget?.covered_nodes_within_budget ?? 0,
      scale_budget_covered_active_links_within_budget: scaleBudget?.covered_active_links_within_budget ?? 0,
      scale_budget_coverage_shortfall_nodes: scaleBudget?.coverage_shortfall_nodes ?? 0,
      scale_budget_coverage_shortfall_links: scaleBudget?.coverage_shortfall_links ?? 0,
      scale_budget_coverage_feasibility: scaleBudget?.coverage_feasibility ?? "disabled",
      scale_budget_feasible_aoi_bound_slices: scaleBudget?.feasible_aoi_bound_slices ?? "",
      configured_max_paths_per_slice: configuredSelectedLimit,
      adaptive_probe_budget_configured_max_paths_per_slice: adaptiveProbeBudget.adaptive_probe_budget_configured_max_paths_per_slice,
      adaptive_probe_budget_effective_max_paths_per_slice: adaptiveProbeBudget.adaptive_probe_budget_effective_max_paths_per_slice,
      adaptive_probe_budget_path_cap_policy: adaptiveProbeBudget.adaptive_probe_budget_path_cap_policy,
      active_links: activeLinks.length,
      sampled_active_links: covered.size,
      active_link_sampling_coverage: round(covered.size / Math.max(activeLinks.length, 1)),
      score_formula: topologyVersionedRiskPlannerEnabled
        ? "Score(a|S)=(information+risk_weight*risk-redundancy_weight*redundancy)/telemetry_bytes"
        : "Score(P)=marginal_information_gain(P|S)/telemetry_cost_kb(P)",
      unified_planner_enabled: topologyVersionedRiskPlannerEnabled,
      unified_planner_name: topologyVersionedRiskPlannerEnabled ? "topology-versioned-risk-int" : "legacy-int-mc",
      unified_planner_selected_mode: unifiedPlannerDecision?.selected_mode ?? "legacy",
      unified_mode_prefilter_policy: slicePlan.unified_mode_prefilter_policy ?? "legacy",
      unified_mode_prefilter_reason: slicePlan.unified_mode_prefilter_reason ?? "legacy-planner",
      unified_mode_prefilter_selected_modes: slicePlan.unified_mode_prefilter_selected_modes ?? "",
      unified_mode_prefilter_changed_link_ratio: slicePlan.unified_mode_prefilter_changed_link_ratio ?? "",
      unified_mode_prefilter_rejection_reasons: slicePlan.unified_mode_prefilter_rejection_reasons ?? "",
      unified_structural_cache_source_slice: slicePlan.unified_structural_cache_source_slice ?? "",
      unified_structural_cache_age_slices: slicePlan.unified_structural_cache_age_slices ?? "",
      unified_structural_cache_similarity: slicePlan.unified_structural_cache_similarity ?? "",
      unified_structural_cache_eligible: slicePlan.unified_structural_cache_eligible ?? false,
      unified_structural_cache_rejection_reasons: slicePlan.unified_structural_cache_rejection_reasons ?? "",
      unified_structural_cache_adaptive_enabled: slicePlan.unified_structural_cache_adaptive_enabled ?? false,
      unified_structural_cache_adaptive_policy: slicePlan.unified_structural_cache_adaptive_policy ?? "",
      unified_structural_cache_adaptive_reason: slicePlan.unified_structural_cache_adaptive_reason ?? "",
      unified_structural_cache_error_tolerance: slicePlan.unified_structural_cache_error_tolerance ?? 0,
      unified_structural_cache_estimated_error_increase_proxy:
        slicePlan.unified_structural_cache_estimated_error_increase_proxy ?? 0,
      unified_structural_cache_error_tolerance_utilization:
        slicePlan.unified_structural_cache_error_tolerance_utilization ?? 0,
      unified_structural_cache_relaxation_factor: slicePlan.unified_structural_cache_relaxation_factor ?? 0,
      unified_structural_cache_risk_pressure: slicePlan.unified_structural_cache_risk_pressure ?? 0,
      unified_structural_cache_effective_similarity_threshold:
        slicePlan.unified_structural_cache_effective_similarity_threshold ?? "",
      unified_structural_cache_effective_changed_link_limit:
        slicePlan.unified_structural_cache_effective_changed_link_limit ?? "",
      unified_structural_cache_effective_affected_path_limit:
        slicePlan.unified_structural_cache_effective_affected_path_limit ?? "",
      unified_structural_cache_effective_valid_path_floor:
        slicePlan.unified_structural_cache_effective_valid_path_floor ?? "",
      unified_cached_path_count: slicePlan.unified_cached_path_count ?? 0,
      unified_affected_cached_path_count: slicePlan.unified_affected_cached_path_count ?? 0,
      unified_affected_cached_path_ratio: slicePlan.unified_affected_cached_path_ratio ?? 0,
      unified_inactive_cached_path_count: slicePlan.unified_inactive_cached_path_count ?? 0,
      unified_retained_cached_path_count: slicePlan.unified_retained_cached_path_count ?? 0,
      unified_planner_plan_objective: unifiedPlannerDecision?.plan_objective ?? "",
      unified_planner_information_gain: unifiedPlannerDecision?.information_gain ?? "",
      unified_planner_risk_gain: unifiedPlannerDecision?.risk_gain ?? "",
      unified_planner_redundancy_penalty: unifiedPlannerDecision?.redundancy_penalty ?? "",
      unified_planner_planning_cost: unifiedPlannerDecision?.planning_cost ?? "",
      unified_planner_candidate_modes: unifiedPlannerDecision?.mode_results?.map((result) => result.mode).join(" > ") ?? "",
      unified_planner_budget_violations: unifiedPlannerDecision?.budget_violations ?? 0,
      unified_planner_selection_engine: unifiedPlannerDecision?.selection_engine ?? "legacy",
      unified_planner_marginal_evaluations: unifiedPlannerDecision?.marginal_evaluation_count ?? 0,
      unified_planner_score_cache_hits: unifiedPlannerDecision?.score_cache_hits ?? 0,
      unified_planner_score_cache_recomputations: unifiedPlannerDecision?.score_cache_recomputations ?? 0,
      unified_stable_path_cache_hits: unifiedStablePathCacheHits,
      unified_stable_path_cache_misses: unifiedStablePathCacheMisses,
      unified_repair_candidate_budget: unifiedRepairCandidateBudget,
      unified_repair_refill_paths: unifiedRepairRefillPaths,
      unified_planner_full_actions: selected.filter((item) => item.unifiedPlannerAction?.metadata_action === "full").length,
      unified_planner_compact_actions: selected.filter((item) => item.unifiedPlannerAction?.metadata_action === "compact").length,
      unified_planner_selective_actions: selected.filter((item) => item.unifiedPlannerAction?.metadata_action === "selective").length,
      unified_planner_forward_only_hops: selected.reduce(
        (sum, item) => sum + (item.unifiedSelectiveMetadataPlan?.hops ?? []).filter((hop) => !hop.writes_observation).length,
        0,
      ),
      unified_topology_added_links: splitPath(slicePlan.unified_topology_added_link_ids).length,
      unified_topology_removed_links: splitPath(slicePlan.unified_topology_removed_link_ids).length,
      importance_path_scoring_enabled: importancePathScoringEnabled,
      importance_budget_neutral_replacement_enabled: importanceBudgetNeutralReplacementEnabled,
      importance_budget_neutral_replacements: importanceBudgetNeutralPlan.replacements.length,
      importance_budget_neutral_before_bytes: importanceBudgetNeutralPlan.before_bytes,
      importance_budget_neutral_after_bytes: importanceBudgetNeutralPlan.after_bytes,
      importance_budget_neutral_before_weighted_target_coverage: importanceBudgetNeutralPlan.before_weighted_target_coverage,
      importance_budget_neutral_after_weighted_target_coverage: importanceBudgetNeutralPlan.after_weighted_target_coverage,
      importance_budget_neutral_path_count_preserved: importanceBudgetNeutralPlan.path_count_preserved,
      importance_replacement_ratio: importanceReplacementRatio,
      importance_replacement_max_base_loss_ratio: importanceReplacementMaxBaseLossRatio,
      importance_score_weight: importanceScoreWeight,
      importance_shadow_information_floor: importanceShadowInformationFloor,
      importance_aoi_shadow_information_floor: importanceAoIShadowInformationFloor,
      importance_aoi_debt_path_ratio: importanceAoIDebtPathRatio,
      importance_aoi_debt_path_limit: importanceAoIDebtPathLimit,
      importance_aoi_debt_promoted_paths: importanceAoIDebtPromotedPaths,
      importance_base_selected_paths: importanceBaseSelectedPathCount,
      importance_oldest_coverage_repair_floor: importanceOldestCoverageRepairFloor,
      importance_additive_repair_path_limit: importanceAdditiveRepairPathLimit,
      importance_additive_repair_paths: importanceRepairPlan.repair_rows.length,
      importance_additive_repair_byte_budget: importanceAdditiveRepairByteBudget,
      importance_additive_repair_estimated_bytes: importanceRepairPlan.estimated_additional_bytes,
      importance_aoi_debt_oldest_target_count: importanceOldestTargetCount,
      importance_aoi_debt_oldest_targets_per_path: importanceOldestTargetsPerPath,
      importance_adjusted_requested_paths: importanceAdjustedRequestedPathCount,
      importance_targets: importanceTargets.length,
      importance_covered_targets: coveredImportanceTargets.size,
      importance_target_coverage: round(coveredImportanceTargets.size / Math.max(importanceTargets.length, 1)),
      importance_mandatory_targets: importanceTargets.filter((target) => boolValue(target.mandatory)).length,
      importance_aoi_debt_targets: importanceTargets.filter(
        (target) => boolValue(target.coverage_required) || numberValue(target.age_score) >= 1,
      ).length,
      importance_covered_mandatory_targets: [...coveredImportanceTargets].filter((targetKey) =>
        importanceTargets.some((target) => importanceTargetKey(target) === targetKey && boolValue(target.mandatory))
      ).length,
      importance_covered_aoi_debt_targets: [...coveredImportanceTargets].filter((targetKey) =>
        importanceTargets.some((target) => importanceTargetKey(target) === targetKey &&
          (boolValue(target.coverage_required) || numberValue(target.age_score) >= 1))
      ).length,
      importance_selected_information_gain: round(selected.reduce(
        (sum, item) => sum + numberValue(item.selectedImportanceGain?.information_gain),
        0,
      )),
      mean_importance_gain_per_kb: round(mean(selected.map((item) => numberValue(item.selectedImportanceGain?.gain_per_kb)))),
      mean_importance_score_bonus: round(mean(selected.map((item) => numberValue(item.selectedImportanceScoreBonus)))),
      topology_versioned_objective_enabled: topologyVersionedObjectiveEnabled,
      topology_versioned_objective_formula: "lambda_bytes*C_bytes+lambda_energy*C_energy+lambda_planning*C_planning+lambda_error*E_residual+lambda_aoi*AoI_residual",
      topology_versioned_information_formula: "sum(uncovered_uncertainty*risk_multiplier*metadata_yield)-gamma*redundancy",
      topology_versioned_lambda_bytes: topologyVersionedObjectiveWeights.bytes,
      topology_versioned_lambda_energy: topologyVersionedObjectiveWeights.energy,
      topology_versioned_lambda_planning: topologyVersionedObjectiveWeights.planning,
      topology_versioned_lambda_expected_error: topologyVersionedObjectiveWeights.expectedError,
      topology_versioned_lambda_aoi: topologyVersionedObjectiveWeights.aoi,
      topology_versioned_confidence_threshold: topologyVersionedConfidenceThreshold,
      topology_versioned_bytes_reference: round(objectiveCostReferences.bytes),
      topology_versioned_energy_reference_j: round(objectiveCostReferences.energyJ),
      mean_topology_versioned_objective: round(mean(selected.map((item) => numberValue(item.selectedTopologyVersionedObjective?.objective_value, NaN)).filter(Number.isFinite))),
      mean_topology_versioned_objective_advantage: round(mean(selected.map((item) => numberValue(item.selectedTopologyVersionedObjective?.objective_advantage, NaN)).filter(Number.isFinite))),
      mean_topology_versioned_node_information_gain: round(mean(selected.map((item) => numberValue(item.selectedTopologyVersionedObjective?.node_information_gain, NaN)).filter(Number.isFinite))),
      mean_topology_versioned_node_redundancy_penalty: round(mean(selected.map((item) => numberValue(item.selectedTopologyVersionedObjective?.node_redundancy_penalty, NaN)).filter(Number.isFinite))),
      mean_topology_versioned_expected_error_reduction: round(mean(selected.map((item) => numberValue(item.selectedTopologyVersionedObjective?.expected_error_reduction, NaN)).filter(Number.isFinite))),
      mean_topology_versioned_expected_aoi_reduction: round(mean(selected.map((item) => numberValue(item.selectedTopologyVersionedObjective?.expected_aoi_reduction, NaN)).filter(Number.isFinite))),
      mean_topology_versioned_evidence_confidence: round(mean(selected.map((item) => numberValue(item.selectedTopologyVersionedObjective?.evidence_confidence, NaN)).filter(Number.isFinite))),
      mean_topology_versioned_path_topology_share: round(mean(selected.map((item) => numberValue(item.selectedTopologyVersionedObjective?.path_topology_share, NaN)).filter(Number.isFinite))),
      mean_topology_versioned_structural_granularity_scale: round(mean(selected.map((item) => numberValue(item.selectedTopologyVersionedObjective?.structural_granularity_scale, NaN)).filter(Number.isFinite))),
      mean_topology_versioned_score_adjustment: round(mean(selected.map((item) => numberValue(item.selectedTopologyVersionedObjective?.conservative_score_adjustment, NaN)).filter(Number.isFinite))),
      topology_versioned_promoted_paths: selected.filter((item) => item.selectedTopologyVersionedObjective?.gate_decision === "conservative-promotion").length,
      topology_versioned_demoted_paths: selected.filter((item) => item.selectedTopologyVersionedObjective?.gate_decision === "conservative-demotion").length,
      topology_versioned_legacy_fallback_paths: selected.filter((item) => String(item.selectedTopologyVersionedObjective?.gate_decision || "").startsWith("legacy-")).length,
      topology_versioned_shadow_guard_agree_paths: selected.filter((item) => item.selectedLegacyShadowGuardDecision === "legacy-objective-agree").length,
      topology_versioned_shadow_guard_admitted_paths: selected.filter((item) => item.selectedLegacyShadowGuardDecision === "objective-admitted-by-legacy-shadow-guard").length,
      topology_versioned_shadow_guard_node_fallbacks: selected.filter((item) => item.selectedLegacyShadowGuardDecision === "legacy-shadow-node-coverage-guard").length,
      topology_versioned_shadow_guard_byte_fallbacks: selected.filter((item) => item.selectedLegacyShadowGuardDecision === "legacy-shadow-byte-noninferiority-guard").length,
      topology_versioned_shadow_guard_information_fallbacks: selected.filter((item) => item.selectedLegacyShadowGuardDecision === "legacy-shadow-information-noninferiority-guard").length,
      mean_marginal_information_gain: round(mean(selected.map((item) => numberValue(item.selectedMarginal?.information_gain, item.base_information_gain)))),
      mean_base_information_gain: round(mean(selected.map((item) => numberValue(item.selectedMarginal?.base_information_gain, item.base_information_gain)))),
      node_state_sampling_scale: nodeSamplingScale,
      mean_node_state_information_gain: round(mean(selected.map((item) => numberValue(item.node_state_information_gain, NaN)).filter(Number.isFinite))),
      mean_marginal_redundancy_penalty: round(mean(selected.map((item) => numberValue(item.selectedMarginal?.redundancy_penalty)))),
      mean_marginal_novelty_ratio: round(mean(selected.map((item) => numberValue(item.selectedMarginal?.novelty_ratio, 1)))),
      mean_score_information_per_kb: round(mean(selected.map((item) => numberValue(item.selectedCostScore?.value_per_kb, item.costScore.value_per_kb)))),
      topology_forecast_horizon_slices: slicePlan.topology_forecast_horizon_slices,
      topology_forecast_stable_window_slices: slicePlan.topology_forecast_stable_window_slices,
      topology_forecast_next_major_drift_in_slices: slicePlan.topology_forecast_next_major_drift_in_slices,
      topology_forecast_mean_similarity: slicePlan.topology_forecast_mean_similarity,
      topology_forecast_min_similarity: slicePlan.topology_forecast_min_similarity,
      topology_forecast_drift_pressure: slicePlan.topology_forecast_drift_pressure,
      topology_forecast_reuse_confidence: slicePlan.topology_forecast_reuse_confidence,
      topology_forecast_recommended_plan_mode: slicePlan.topology_forecast_recommended_plan_mode,
      topology_forecast_target_sampling_boost: round(topologyForecastTargetBoost),
      target_active_link_sampling_rate: planningTargetActiveLinkSamplingRate,
      configured_sampling_rate: samplingRate,
      configured_target_active_link_sampling_rate: targetActiveLinkSamplingRate,
      oam_budget_applied: oamBudget.oam_budget_applied,
      oam_budget_policy: oamBudget.oam_budget_policy,
      oam_budget_action: oamBudget.oam_budget_action,
      oam_budget_reason: oamBudget.oam_budget_reason,
      oam_budget_source: oamBudget.oam_budget_source,
      oam_recommended_sampling_rate: oamBudget.oam_recommended_sampling_rate,
      oam_recommended_target_active_link_sampling_rate: oamBudget.oam_recommended_target_active_link_sampling_rate,
      oam_recommended_telemetry_byte_budget_per_slice: oamBudget.oam_recommended_telemetry_byte_budget_per_slice,
      oam_recommended_downlink_budget_bytes: oamBudget.oam_recommended_downlink_budget_bytes,
      oam_coverage_demand_pressure: oamBudget.coverage_demand_pressure,
      adaptive_probe_budget_enabled: adaptiveProbeBudget.adaptive_probe_budget_enabled,
      adaptive_probe_budget_applied: adaptiveProbeBudget.adaptive_probe_budget_applied,
      adaptive_probe_budget_policy: adaptiveProbeBudget.adaptive_probe_budget_policy,
      adaptive_probe_budget_reason: adaptiveProbeBudget.adaptive_probe_budget_reason,
      adaptive_probe_budget_scale: adaptiveProbeBudget.adaptive_probe_budget_scale,
      adaptive_probe_budget_sampling_rate: adaptiveProbeBudget.adaptive_probe_budget_sampling_rate,
      adaptive_probe_budget_target_active_link_sampling_rate: adaptiveProbeBudget.adaptive_probe_budget_target_active_link_sampling_rate,
      adaptive_probe_budget_telemetry_byte_budget_per_slice: adaptiveProbeBudget.adaptive_probe_budget_telemetry_byte_budget_per_slice,
      adaptive_probe_budget_oam_pressure: adaptiveProbeBudget.adaptive_probe_budget_oam_pressure,
      adaptive_probe_budget_slice_traffic_risk: adaptiveProbeBudget.adaptive_probe_budget_slice_traffic_risk,
      adaptive_probe_budget_reuse_confidence: adaptiveProbeBudget.adaptive_probe_budget_reuse_confidence,
      adaptive_probe_budget_reuse_margin: adaptiveProbeBudget.adaptive_probe_budget_reuse_margin,
      adaptive_probe_budget_drift_pressure: adaptiveProbeBudget.adaptive_probe_budget_drift_pressure,
      multi_objective_budget_enabled: multiObjectiveControl.enabled,
      multi_objective_scale_profile: multiObjectiveControl.scale_profile,
      multi_objective_policy: multiObjectiveControl.policy,
      multi_objective_reason: multiObjectiveControl.reason,
      multi_objective_quality_guard_pressure: multiObjectiveControl.quality_guard_pressure,
      multi_objective_cost_reduction_pressure: multiObjectiveControl.cost_reduction_pressure,
      multi_objective_path_budget_scale: multiObjectiveControl.path_budget_scale,
      multi_objective_effective_max_paths_per_slice: multiObjectiveControl.effective_max_paths_per_slice,
      multi_objective_metadata_floor_ratio: multiObjectiveControl.metadata_floor_ratio,
      multi_objective_cost_weight_scale: multiObjectiveControl.cost_weight_scale,
      multi_objective_node_state_weight_scale: multiObjectiveControl.node_state_weight_scale,
      multi_objective_link_state_weight_scale: multiObjectiveControl.link_state_weight_scale,
      mean_multi_objective_score: round(mean(selected.map((item) => numberValue(item.selectedMultiObjectiveScore?.score, item.multiObjectiveScore?.score)))),
      mean_multi_objective_quality_bonus: round(mean(selected.map((item) => numberValue(item.selectedMultiObjectiveScore?.quality_bonus, item.multiObjectiveScore?.quality_bonus)))),
      mean_multi_objective_cost_penalty: round(mean(selected.map((item) => numberValue(item.selectedMultiObjectiveScore?.cost_penalty, item.multiObjectiveScore?.cost_penalty)))),
      adaptive_metadata_profile_enabled: adaptiveMetadataProfileEnabled,
      adaptive_metadata_compact_paths: selected.filter((item) => compactMetadataProfile(item.metadataProfile?.profile)).length,
      adaptive_metadata_target_aware_paths: selected.filter((item) => targetAwareMetadataProfile(item.metadataProfile?.profile)).length,
      adaptive_metadata_standard_paths: selected.filter((item) =>
        !compactMetadataProfile(item.metadataProfile?.profile) && !targetAwareMetadataProfile(item.metadataProfile?.profile)
      ).length,
      adaptive_path_only_observation_paths: selected.filter((item) => compactMetadataProfile(item.metadataProfile?.profile)).length,
      adaptive_target_neighborhood_observation_paths: selected.filter((item) => targetAwareMetadataProfile(item.metadataProfile?.profile)).length,
      adaptive_all_adjacent_observation_paths: selected.filter((item) =>
        !compactMetadataProfile(item.metadataProfile?.profile) && !targetAwareMetadataProfile(item.metadataProfile?.profile)
      ).length,
      configured_hop_metadata_bytes: hopMetadataBytes,
      compact_hop_metadata_bytes: compactHopMetadataBytes,
      mean_effective_hop_metadata_bytes: round(mean(selected.map((item) => numberValue(item.metadataProfile?.effective_hop_metadata_bytes, hopMetadataBytes)))),
      mean_metadata_compression_ratio: round(mean(selected.map((item) => numberValue(item.metadataProfile?.compression_ratio, 1)))),
      estimated_metadata_bytes_saved_by_profile: round(selected.reduce((total, item) => {
        const hopCount = Math.max(item.pathNodeCount, item.pathLinks.length + 1, 1);
        return total + Math.max(0, hopCount * (hopMetadataBytes - numberValue(item.metadataProfile?.effective_hop_metadata_bytes, hopMetadataBytes)));
      }, 0)),
      local_adaptive_high_risk_paths: selected.filter((item) => numberValue(item.localAdaptive?.risk) >= 0.6).length,
      local_adaptive_watchlist_paths: selected.filter((item) => numberValue(item.localAdaptive?.risk) >= 0.35 && numberValue(item.localAdaptive?.risk) < 0.6).length,
      local_adaptive_low_risk_sparse_paths: selected.filter((item) => item.localAdaptive?.policy === "low-risk-sparse").length,
      reuse_duplicate_suppressed_paths: reuseDuplicateSuppressedPaths,
      oam_duplicate_target_only_suppressed_paths: oamDuplicateTargetOnlySuppressedPaths,
      unique_mandatory_oam_targets_covered: coveredMandatoryOamTargets.size,
      mean_local_adaptive_sampling_risk: round(mean(selected.map((item) => numberValue(item.localAdaptive?.risk, NaN)).filter(Number.isFinite))),
      max_local_adaptive_sampling_risk: round(Math.max(0, ...selected.map((item) => numberValue(item.localAdaptive?.risk, 0)))),
      effective_sampling_rate: energyBudget.effective_sampling_rate,
      effective_target_active_link_sampling_rate: energyBudget.effective_target_active_link_sampling_rate,
      energy_budget_enabled: energyBudget.energy_budget_enabled,
      energy_budget_policy: energyBudget.energy_budget_policy,
      energy_budget_reason: energyBudget.energy_budget_reason,
      energy_budget_scale: energyBudget.energy_budget_scale,
      energy_budget_pressure: energyBudget.energy_budget_pressure,
      energy_budget_critical_coverage_credit: energyBudget.energy_budget_critical_coverage_credit,
      base_requested_paths: energyBudget.base_requested_paths,
      energy_budget_requested_paths: energyBudget.energy_budget_requested_paths,
      base_target_covered_links: energyBudget.base_target_covered_links,
      energy_budget_target_covered_links: energyBudget.energy_budget_target_covered_links,
      base_selected_limit: energyBudget.base_selected_limit,
      energy_budget_selected_limit: energyBudget.energy_budget_selected_limit,
      energy_budget_suppressed_paths: energyBudget.energy_budget_suppressed_paths,
      energy_budget_deferred_active_links: energyBudget.energy_budget_deferred_active_links,
      energy_budget_mean_path_energy_risk: energyBudget.energy_budget_mean_path_energy_risk,
      energy_budget_shadow_node_ratio: energyBudget.energy_budget_shadow_node_ratio,
      energy_budget_low_energy_node_ratio: energyBudget.energy_budget_low_energy_node_ratio,
      energy_budget_low_solar_node_ratio: energyBudget.energy_budget_low_solar_node_ratio,
      energy_budget_power_saving_node_ratio: energyBudget.energy_budget_power_saving_node_ratio,
      energy_budget_power_deficit_pressure: energyBudget.energy_budget_power_deficit_pressure,
      repaired_candidate_paths: repairedCandidatePaths,
      selected_repaired_paths: selectedRepairedPaths,
      ...planningCost,
      energy_guard_suppressed_paths: energyGuardSuppressedPaths,
      selected_high_energy_paths: selected.filter((item) => item.energyRisk >= energyGuardThreshold).length,
      mean_forecast_priority_score: round(mean(selected.map((item) => item.forecastProfile.forecast_priority_score))),
      mean_forecast_transition_score: round(mean(selected.map((item) => item.forecastProfile.forecast_transition_score))),
      mean_forecast_near_outage_score: round(mean(selected.map((item) => item.forecastProfile.forecast_near_outage_score))),
      forecast_upcoming_outage_links: selected.reduce((total, item) => total + numberValue(item.forecastProfile.forecast_upcoming_outage_links), 0),
      forecast_upcoming_recovery_links: selected.reduce((total, item) => total + numberValue(item.forecastProfile.forecast_upcoming_recovery_links), 0),
      candidate_source: effectiveCandidateSource,
      topology_reuse_decision: slicePlan.topology_reuse_decision,
      topology_similarity_score: slicePlan.topology_similarity_score,
      topology_legacy_composite_similarity_score: slicePlan.topology_legacy_composite_similarity_score,
      topology_dynamic_similarity_score: slicePlan.topology_dynamic_similarity_score,
      active_jaccard: slicePlan.active_jaccard,
      inter_plane_jaccard: slicePlan.inter_plane_jaccard,
      bottleneck_jaccard: slicePlan.bottleneck_jaccard,
      route_path_jaccard: slicePlan.route_path_jaccard,
      link_state_similarity: slicePlan.link_state_similarity,
      adaptive_reuse_threshold: slicePlan.adaptive_reuse_threshold,
      adaptive_threshold_base: slicePlan.adaptive_threshold_base,
      adaptive_threshold_policy: slicePlan.adaptive_threshold_policy,
      adaptive_threshold_reason: slicePlan.adaptive_threshold_reason,
      adaptive_threshold_total_tightening: slicePlan.adaptive_threshold_total_tightening,
      adaptive_threshold_total_relaxation: slicePlan.adaptive_threshold_total_relaxation,
      adaptive_threshold_volatility_penalty: slicePlan.adaptive_threshold_volatility_penalty,
      adaptive_threshold_bottleneck_penalty: slicePlan.adaptive_threshold_bottleneck_penalty,
      adaptive_threshold_load_penalty: slicePlan.adaptive_threshold_load_penalty,
      adaptive_threshold_contact_uncertainty_penalty: slicePlan.adaptive_threshold_contact_uncertainty_penalty,
      adaptive_threshold_structural_drift_penalty: slicePlan.adaptive_threshold_structural_drift_penalty,
      adaptive_threshold_link_state_drift_penalty: slicePlan.adaptive_threshold_link_state_drift_penalty,
      adaptive_threshold_route_drift_penalty: slicePlan.adaptive_threshold_route_drift_penalty,
      adaptive_threshold_oam_pressure_penalty: slicePlan.adaptive_threshold_oam_pressure_penalty,
      adaptive_threshold_stability_credit: slicePlan.adaptive_threshold_stability_credit,
      adaptive_threshold_overhead_credit: slicePlan.adaptive_threshold_overhead_credit,
      adaptive_threshold_calibration_policy: slicePlan.adaptive_threshold_calibration_policy,
      adaptive_threshold_calibration_evidence_count: slicePlan.adaptive_threshold_calibration_evidence_count,
      adaptive_threshold_calibration_candidate_class_count: slicePlan.adaptive_threshold_calibration_candidate_class_count,
      adaptive_threshold_calibration_future_window_slices: slicePlan.adaptive_threshold_calibration_future_window_slices,
      adaptive_threshold_calibration_best_second_gap: slicePlan.adaptive_threshold_calibration_best_second_gap,
      adaptive_threshold_calibration_near_best_class_count: slicePlan.adaptive_threshold_calibration_near_best_class_count,
      adaptive_threshold_calibration_near_threshold_class_count: slicePlan.adaptive_threshold_calibration_near_threshold_class_count,
      adaptive_threshold_calibration_class_density: slicePlan.adaptive_threshold_calibration_class_density,
      adaptive_threshold_calibration_similarity_p50: slicePlan.adaptive_threshold_calibration_similarity_p50,
      adaptive_threshold_calibration_similarity_p90: slicePlan.adaptive_threshold_calibration_similarity_p90,
      adaptive_threshold_calibration_future_mean_similarity: slicePlan.adaptive_threshold_calibration_future_mean_similarity,
      adaptive_threshold_calibration_future_min_similarity: slicePlan.adaptive_threshold_calibration_future_min_similarity,
      adaptive_threshold_calibration_ambiguity_penalty: slicePlan.adaptive_threshold_calibration_ambiguity_penalty,
      adaptive_threshold_calibration_future_drift_penalty: slicePlan.adaptive_threshold_calibration_future_drift_penalty,
      adaptive_threshold_calibration_separation_credit: slicePlan.adaptive_threshold_calibration_separation_credit,
      adaptive_threshold_calibration_future_stability_credit: slicePlan.adaptive_threshold_calibration_future_stability_credit,
      adaptive_threshold_calibration_sample_support_credit: slicePlan.adaptive_threshold_calibration_sample_support_credit,
      adaptive_threshold_calibration_evidence_confidence: slicePlan.adaptive_threshold_calibration_evidence_confidence,
      adaptive_threshold_calibration_net_adjustment: slicePlan.adaptive_threshold_calibration_net_adjustment,
      topology_reuse_margin: slicePlan.topology_reuse_margin,
      oam_feedback_pressure: slicePlan.oam_feedback_pressure,
      oam_replan_pressure: slicePlan.oam_replan_pressure,
      oam_replan_targets: slicePlan.oam_replan_targets,
      oam_replan_urgent_targets: slicePlan.oam_replan_urgent_targets,
      oam_replan_mean_priority_score: slicePlan.oam_replan_mean_priority_score,
      oam_replan_max_priority_score: slicePlan.oam_replan_max_priority_score,
      oam_replan_pressure_threshold: slicePlan.oam_replan_pressure_threshold,
      oam_replan_triggered: slicePlan.oam_replan_triggered,
      oam_control_action: slicePlan.oam_control_action,
      oam_control_probe_bias: slicePlan.oam_control_probe_bias,
      oam_control_confidence_budget: slicePlan.oam_control_confidence_budget,
      oam_control_source_slice_index: slicePlan.oam_control_source_slice_index,
      oam_control_target_slice_index: slicePlan.oam_control_target_slice_index,
      oam_control_next_slice_applied: slicePlan.oam_control_next_slice_applied,
      oam_control_pressure: slicePlan.oam_control_pressure,
      oam_control_replan_pressure_threshold: slicePlan.oam_control_replan_pressure_threshold,
      oam_control_replan_triggered: slicePlan.oam_control_replan_triggered,
      oam_control_priority_retest_targets: slicePlan.oam_control_priority_retest_targets,
      oam_control_unknown_pressure: slicePlan.oam_control_unknown_pressure,
      oam_control_stale_pressure: slicePlan.oam_control_stale_pressure,
      oam_control_prior_estimate_pressure: slicePlan.oam_control_prior_estimate_pressure,
      oam_control_low_confidence_pressure: slicePlan.oam_control_low_confidence_pressure,
      oam_control_conflict_pressure: slicePlan.oam_control_conflict_pressure,
      oam_control_downlink_pressure: slicePlan.oam_control_downlink_pressure,
      oam_control_retest_pressure: slicePlan.oam_control_retest_pressure,
      oam_control_top_node_targets: slicePlan.oam_control_top_node_targets,
      oam_control_top_link_targets: slicePlan.oam_control_top_link_targets,
      oam_control_retest_reasons: slicePlan.oam_control_retest_reasons,
      selection_strategy: selectionStrategy,
      mean_energy_risk: round(mean(selected.map((item) => item.energyRisk))),
      cost_aware_sampling_enabled: costAwareSampling,
      cost_awareness_weight: costAwarenessWeight,
      telemetry_byte_budget_enabled: telemetryBudgetEnabled,
      telemetry_byte_budget_per_slice: planningTelemetryByteBudgetPerSlice,
      telemetry_budget_policy: telemetryBudgetEnabled
        ? topologyVersionedRiskPlannerEnabled
          ? "strict-hard-slice-byte-budget-without-override"
          : oamBudget.oam_budget_applied
            ? "oam-adaptive-soft-slice-byte-budget-with-critical-coverage-override"
            : "soft-slice-byte-budget-with-critical-coverage-override"
        : "disabled",
      telemetry_budget_used_bytes: round(telemetryBudgetUsedBytes),
      telemetry_budget_remaining_bytes: telemetryBudgetEnabled ? round(planningTelemetryByteBudgetPerSlice - telemetryBudgetUsedBytes) : "",
      telemetry_budget_overrun_bytes: telemetryBudgetEnabled ? round(Math.max(0, telemetryBudgetUsedBytes - planningTelemetryByteBudgetPerSlice)) : 0,
      telemetry_budget_utilization: telemetryBudgetEnabled ? round(telemetryBudgetUsedBytes / Math.max(planningTelemetryByteBudgetPerSlice, 1)) : 0,
      telemetry_budget_suppressed_paths: telemetryBudgetSuppressedPaths,
      telemetry_budget_override_paths: telemetryBudgetOverridePaths,
      estimated_metadata_bytes: round(selected.reduce((total, item) => total + numberValue(item.telemetryCost.estimated_metadata_bytes), 0)),
      estimated_report_bytes: round(selected.reduce((total, item) => total + numberValue(item.telemetryCost.estimated_report_bytes), 0)),
      estimated_probe_forward_bytes: round(selected.reduce((total, item) => total + numberValue(item.telemetryCost.estimated_probe_forward_bytes), 0)),
      estimated_generated_telemetry_bytes: round(selected.reduce((total, item) => total + numberValue(item.telemetryCost.estimated_generated_telemetry_bytes), 0)),
      estimated_total_telemetry_bytes: round(selected.reduce((total, item) => total + numberValue(item.telemetryCost.estimated_total_telemetry_bytes), 0)),
      estimated_total_telemetry_energy_j: round(selected.reduce((total, item) => total + numberValue(item.telemetryCost.estimated_total_telemetry_energy_j), 0)),
      mean_cost_aware_score: round(mean(selected.map((item) => item.costScore.cost_aware_score))),
      mean_cost_aware_value_per_kb: round(mean(selected.map((item) => item.costScore.value_per_kb))),
      mean_estimated_total_telemetry_bytes_per_path: round(mean(selected.map((item) => item.telemetryCost.estimated_total_telemetry_bytes))),
      mean_solar_exposure: round(mean(selected.map((item) => item.energyProfile.mean_solar_exposure))),
      mean_power_margin_w: round(mean(selected.map((item) => item.energyProfile.mean_power_margin_w))),
      low_energy_node_hits: selected.reduce((total, item) => total + item.energyProfile.low_energy_nodes, 0),
      shadow_node_hits: selected.reduce((total, item) => total + item.energyProfile.shadow_nodes, 0),
      oam_feedback_selected_paths: selected.filter((item) => item.oamFeedback.target_count > 0).length,
      oam_feedback_target_hits: selected.reduce((total, item) => total + item.oamFeedback.target_count, 0),
      oam_feedback_score_sum: round(selected.reduce((total, item) => total + item.oamFeedback.score, 0)),
      oam_control_selected_paths: selected.filter((item) => item.oamControl.target_count > 0 || item.oamControl.action !== "maintain-current-plan").length,
      oam_control_target_hits: selected.reduce((total, item) => total + item.oamControl.target_count, 0),
      oam_control_score_sum: round(selected.reduce((total, item) => total + item.oamControl.score, 0)),
      oam_mandatory_coverage_selected_paths: selected.filter((item) => item.oamFeedback.mandatory_target_count > 0 || item.oamControl.mandatory_target_count > 0).length,
      oam_mandatory_coverage_target_hits: selected.reduce((total, item) => total + item.oamFeedback.mandatory_target_count + item.oamControl.mandatory_target_count, 0),
      oam_mandatory_coverage_broke_reuse: Boolean(slicePlan.oam_mandatory_coverage_broke_reuse),
      oam_mandatory_coverage_missing_link_targets: slicePlan.oam_mandatory_coverage_missing_link_targets ?? "",
      oam_mandatory_coverage_missing_node_targets: slicePlan.oam_mandatory_coverage_missing_node_targets ?? "",
      mean_selected_score: round(mean(selected.map((item) => item.score))),
      mean_base_int_mc_score: round(mean(selected.map((item) => item.base_int_mc_score))),
      warmup: slicePosition < warmupSlices,
    },
  };
}

const args = process.argv.slice(2);
const inputDir = resolve(argValue(args, "--input", "exports/tmp-highload-check"));
const stage2Dir = resolve(argValue(args, "--stage2", `stage2-int/outputs/${basename(inputDir)}`));
const outputDir = resolve(argValue(args, "--out", stage2Dir));
const candidateAlgorithm = argValue(args, "--candidate-algorithm", "path-balance");
const algorithm = argValue(args, "--algorithm", "int-mc");
const samplingRate = numberArg(args, "--sampling-rate", 0.25);
const targetActiveLinkSamplingRate = numberArg(args, "--target-active-link-sampling-rate", samplingRate);
const warmupSlices = numberArg(args, "--warmup-slices", 3);
const windowSize = numberArg(args, "--window-size", 12);
const rank = numberArg(args, "--rank", 5);
const minPaths = numberArg(args, "--min-paths-per-slice", 1);
const maxPaths = numberArg(args, "--max-paths-per-slice", 0);
const topologyClassThreshold = numberArg(args, "--topology-class-threshold", 0.08);
const adaptiveReuse = argValue(args, "--adaptive-reuse", "true").toLowerCase() !== "false";
const incrementalTopologyRepair = argValue(args, "--incremental-topology-repair", "true").toLowerCase() !== "false";
const forecastRiskScoring = argValue(args, "--forecast-risk-scoring", "true").toLowerCase() !== "false";
const topologyVersionedObjectiveEnabled = argValue(args, "--topology-versioned-objective", "false").toLowerCase() === "true";
const topologyVersionedObjectiveWeights = {
  bytes: Math.max(0, numberArg(args, "--objective-lambda-bytes", DEFAULT_TOPOLOGY_VERSIONED_OBJECTIVE_WEIGHTS.bytes)),
  energy: Math.max(0, numberArg(args, "--objective-lambda-energy", DEFAULT_TOPOLOGY_VERSIONED_OBJECTIVE_WEIGHTS.energy)),
  planning: Math.max(0, numberArg(args, "--objective-lambda-planning", DEFAULT_TOPOLOGY_VERSIONED_OBJECTIVE_WEIGHTS.planning)),
  expectedError: Math.max(0, numberArg(args, "--objective-lambda-expected-error", DEFAULT_TOPOLOGY_VERSIONED_OBJECTIVE_WEIGHTS.expectedError)),
  aoi: Math.max(0, numberArg(args, "--objective-lambda-aoi", DEFAULT_TOPOLOGY_VERSIONED_OBJECTIVE_WEIGHTS.aoi)),
};
const topologyVersionedConfidenceThreshold = clamp(numberArg(args, "--objective-confidence-threshold", 0.45), 0, 1);
const reuseOverheadPressure = numberArg(args, "--reuse-overhead-pressure", 0.5);
const minEnergyPercent = numberArg(args, "--min-energy-percent", 20);
const energyGuardThreshold = numberArg(args, "--energy-guard-threshold", 0.45);
const energyBudgetEnabled = argValue(args, "--energy-budget", "true").toLowerCase() !== "false";
const energyBudgetMinActiveLinkSamplingRate = numberArg(args, "--energy-budget-min-active-link-sampling-rate", 0.08);
const energyBudgetMaxReduction = clamp(numberArg(args, "--energy-budget-max-reduction", 0.45), 0, 0.95);
const adaptiveProbeBudgetEnabled = argValue(args, "--adaptive-probe-budget", "false").toLowerCase() === "true";
const selectionStrategy = normalizeSelectionStrategy(argValue(args, "--selection-strategy", "int-mc-leverage"));
const thresholdCalibrationHorizon = Math.max(0, Math.floor(numberArg(args, "--threshold-calibration-horizon", 4)));
const predictionScoreHorizon = Math.max(1, Math.floor(numberArg(
  args,
  "--prediction-horizon",
  numberArg(args, "--prediction-score-horizon", Math.max(1, thresholdCalibrationHorizon)),
)));
const costAwareSampling = argValue(args, "--cost-aware-sampling", "true").toLowerCase() !== "false";
const costAwarenessWeight = clamp(numberArg(args, "--cost-awareness-weight", 0.28), 0, 1);
const telemetryByteBudgetPerSlice = Math.max(0, numberArg(
  args,
  "--telemetry-byte-budget",
  numberArg(args, "--telemetry-byte-budget-per-slice", 0),
));
const planner = argValue(args, "--planner", "legacy-int-mc").toLowerCase();
if (!["legacy-int-mc", "topology-versioned-risk-int"].includes(planner)) {
  throw new Error(`Unsupported planner: ${planner}`);
}
const topologyVersionedRiskPlannerEnabled = planner === "topology-versioned-risk-int";
const adaptiveStructuralReuseEnabled = topologyVersionedRiskPlannerEnabled &&
  argValue(args, "--adaptive-structural-reuse", "false").toLowerCase() === "true";
const structuralReuseErrorTolerance = clamp(
  numberArg(args, "--structural-reuse-error-tolerance", 0.02),
  0,
  0.1,
);
const structuralReuseSimilarityFloor = clamp(
  numberArg(args, "--structural-reuse-similarity-floor", 0.9),
  0.72,
  0.94,
);
const structuralReuseMaximumChangedLinkRatio = clamp(
  numberArg(args, "--structural-reuse-maximum-changed-link-ratio", 0.12),
  0.08,
  0.5,
);
const structuralReuseMaximumAffectedPathRatio = clamp(
  numberArg(args, "--structural-reuse-maximum-affected-path-ratio", 0.25),
  0.15,
  0.75,
);
const structuralReuseMinimumValidPathRatio = clamp(
  numberArg(args, "--structural-reuse-minimum-valid-path-ratio", 0.75),
  0.5,
  0.85,
);
const topologyVersionedRiskWeight = Math.max(0, numberArg(args, "--risk-weight", 0.35));
const topologyVersionedRedundancyWeight = Math.max(0, numberArg(args, "--redundancy-weight", 0.3));
const topologyVersionedPlanningCostWeight = Math.max(0, numberArg(args, "--planning-cost-weight", 0.05));
const topologyVersionedInformationGainMode = argValue(args, "--information-gain-mode", "marginal").toLowerCase();
if (!["marginal", "coverage-only"].includes(topologyVersionedInformationGainMode)) {
  throw new Error(`Unsupported information gain mode: ${topologyVersionedInformationGainMode}`);
}
const topologyVersionedMetadataActions = new Set(
  argValue(args, "--metadata-actions", "full,compact,selective")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => ["full", "compact", "selective"].includes(value)),
);
if (topologyVersionedRiskPlannerEnabled && topologyVersionedMetadataActions.size === 0) {
  throw new Error("topology-versioned-risk-int requires at least one metadata action");
}
const topologyVersionedAllowedModes = new Set(
  argValue(args, "--planner-modes", "reuse,repair,fresh")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => ["reuse", "repair", "fresh"].includes(value)),
);
if (topologyVersionedRiskPlannerEnabled && topologyVersionedAllowedModes.size === 0) {
  throw new Error("topology-versioned-risk-int requires at least one planner mode");
}
const hopMetadataBytes = numberArg(args, "--hop-bytes", 96);
const adaptiveMetadataProfileEnabled = argValue(args, "--adaptive-metadata-profile", adaptiveProbeBudgetEnabled ? "true" : "false").toLowerCase() === "true";
const compactHopMetadataBytes = Math.max(16, Math.min(hopMetadataBytes, numberArg(args, "--compact-hop-bytes", Math.round(hopMetadataBytes * 0.5))));
const oamTargetAwareMetadataEnabled = argValue(args, "--oam-target-aware-metadata", "false").toLowerCase() === "true";
const oamTargetHopMetadataBytes = Math.max(16, Math.min(hopMetadataBytes, numberArg(args, "--oam-target-hop-bytes", hopMetadataBytes)));
const oamTransitHopMetadataBytes = Math.max(16, Math.min(oamTargetHopMetadataBytes, numberArg(args, "--oam-transit-hop-bytes", Math.round(hopMetadataBytes * 0.92))));
const oamTargetNeighborhoodMaxLossRatio = clamp(numberArg(args, "--oam-target-neighborhood-max-loss-ratio", 0.1), 0, 1);
const probePacketBaseBytes = numberArg(args, "--probe-base-bytes", 64);
const reportHeaderBytes = numberArg(args, "--report-header-bytes", 128);
const hopProcessingJ = numberArg(args, "--hop-processing-j", 0.02);
const reportProcessingJ = numberArg(args, "--report-processing-j", 0.05);
const telemetryTxNjPerByte = numberArg(args, "--telemetry-tx-nj-per-byte", 120);
const scaleAdaptiveTotalBudgetEnabled = argValue(
  args,
  "--scale-adaptive-total-budget",
  "false",
).toLowerCase() === "true";
const scaleBudgetHeadroomRatio = clamp(numberArg(args, "--scale-budget-headroom-ratio", 0.1), 0, 1);
const scaleBudgetPathHeadroomRatio = clamp(numberArg(args, "--scale-budget-path-headroom-ratio", 0.25), 0, 1);
const scaleBudgetReferenceCsvPath = argValue(args, "--scale-budget-reference-csv", "");
const predictedContactPlanPath = argValue(args, "--predicted-contact-plan", "");
const observabilityMode = argValue(args, "--observability-mode", "oracle").toLowerCase();
const feedbackLagSlices = Math.max(
  0,
  Math.floor(numberArg(args, "--feedback-lag-slices", observabilityMode === "oam-only" ? 1 : 0)),
);
const plannerOamLinksPath = argValue(args, "--planner-oam-links", "");
const plannerOamNodesPath = argValue(args, "--planner-oam-nodes", "");
const oamPriorityRetestPath = argValue(args, "--oam-priority-retest", "");
const oamControlActionsPath = argValue(args, "--oam-control-actions", "");
const oamFeedbackWeight = numberArg(args, "--oam-feedback-weight", 0.35);
const oamControlWeight = numberArg(args, "--oam-control-weight", 0.22);
const oamReplanPressureThreshold = numberArg(args, "--oam-replan-pressure-threshold", 0.68);
const oamControlReplanPressureThreshold = numberArg(args, "--oam-control-replan-pressure-threshold", 0.68);
const multiObjectiveBudgetEnabled = argValue(args, "--multi-objective-budget", "false").toLowerCase() === "true";
const importanceAwareTargetsEnabled = argValue(args, "--importance-aware-targets", "false").toLowerCase() === "true";
const importanceMetadataOnly = argValue(args, "--importance-metadata-only", "true").toLowerCase() !== "false";
const importanceSelectiveMetadataEnabled = importanceAwareTargetsEnabled && argValue(
  args,
  "--importance-selective-metadata",
  "true",
).toLowerCase() !== "false";
const importancePathScoringEnabled = importanceAwareTargetsEnabled && argValue(
  args,
  "--importance-path-scoring",
  importanceMetadataOnly ? "false" : "true",
).toLowerCase() === "true";
const importanceScoreWeight = clamp(numberArg(args, "--importance-score-weight", 0.12), 0, 0.25);
const importanceShadowInformationFloor = clamp(numberArg(args, "--importance-shadow-information-floor", 1), 0.9, 1);
const importanceAoIShadowInformationFloor = clamp(
  numberArg(args, "--importance-aoi-shadow-information-floor", 1),
  0.9,
  1,
);
const importanceAoIDebtPathRatio = clamp(numberArg(args, "--importance-aoi-debt-path-ratio", 0.1), 0, 0.5);
const importanceRepairByteBudgetRatio = clamp(numberArg(args, "--importance-repair-byte-budget-ratio", 0.15), 0, 0.5);
const importanceBudgetNeutralReplacementEnabled = importanceAwareTargetsEnabled && argValue(
  args,
  "--importance-budget-neutral-replacement",
  "false",
).toLowerCase() === "true";
const importanceReplacementRatio = clamp(numberArg(args, "--importance-replacement-ratio", 0.25), 0, 0.5);
const importanceReplacementMaxBaseLossRatio = clamp(
  numberArg(args, "--importance-replacement-max-base-loss-ratio", 0.02),
  0,
  0.2,
);
const importanceStrictForwardOnlyEnabled = importanceAwareTargetsEnabled && argValue(
  args,
  "--importance-strict-forward-only",
  importanceBudgetNeutralReplacementEnabled ? "true" : "false",
).toLowerCase() === "true";
const importancePlaneRepresentativeRatio = clamp(
  numberArg(args, "--importance-plane-representative-ratio", 0),
  0,
  1,
);
const importanceTargetRatio = clamp(numberArg(args, "--importance-target-ratio", 0.25), 0, 1);
const importanceNodeTargetRatio = clamp(numberArg(args, "--importance-node-target-ratio", importanceTargetRatio), 0, 1);
const importanceLinkTargetRatio = clamp(numberArg(args, "--importance-link-target-ratio", importanceTargetRatio), 0, 1);
const importanceMaxAoISlices = Math.max(1, Math.floor(numberArg(args, "--importance-max-aoi-slices", 6)));
const importanceExplorationRatio = clamp(numberArg(args, "--importance-exploration-ratio", 0.08), 0, 1);
const importanceWindowSize = Math.max(2, Math.floor(numberArg(args, "--importance-window-size", 6)));

if (importanceAwareTargetsEnabled && observabilityMode !== "oam-only") {
  throw new Error("importance-aware telemetry requires --observability-mode oam-only to preserve the causal no-oracle boundary");
}

const linksPath = resolve(argValue(args, "--links", join(inputDir, "links.csv")));
const nodesPath = resolve(argValue(args, "--nodes", join(inputDir, "nodes.csv")));
const routesPath = resolve(argValue(args, "--routes", join(inputDir, "routes.csv")));
const candidatePathsPath = resolve(
  argValue(args, "--candidate-paths", join(stage2Dir, `probe-paths-${candidateAlgorithm}.csv`)),
);

requireFile(linksPath, "links.csv");
if (existsSync(nodesPath) === false) {
  console.warn(`nodes.csv not found for energy-aware path scoring: ${nodesPath}`);
}
if (existsSync(routesPath) === false) {
  console.warn(`routes.csv not found for route-similarity scoring: ${routesPath}`);
}
requireFile(candidatePathsPath, "candidate probe paths");
if (predictedContactPlanPath) requireFile(resolve(predictedContactPlanPath), "predicted contact plan");
if (plannerOamLinksPath) requireFile(resolve(plannerOamLinksPath), "planner Ground OAM links");
if (plannerOamNodesPath) requireFile(resolve(plannerOamNodesPath), "planner Ground OAM nodes");
if (oamPriorityRetestPath) requireFile(resolve(oamPriorityRetestPath), "Ground OAM priority retest feedback");
if (oamControlActionsPath) requireFile(resolve(oamControlActionsPath), "Ground OAM control actions");
if (scaleBudgetReferenceCsvPath) requireFile(resolve(scaleBudgetReferenceCsvPath), "scale budget reference schedule");

// Large Starlink runs can exceed the V8 heap when all source files and their
// intermediate parse matrices coexist. Read sequentially and retain only the
// fields used by the causal planner.
let links = await readCsvStream(linksPath, { columns: TRUTH_LINK_PLANNER_COLUMNS });
let nodes = existsSync(nodesPath)
  ? await readCsvStream(nodesPath, { columns: TRUTH_NODE_PLANNER_COLUMNS })
  : [];
let routes = existsSync(routesPath)
  ? await readCsvStream(routesPath, { columns: ROUTE_PLANNER_COLUMNS })
  : [];
const candidatePaths = await readCsvStream(candidatePathsPath);
const predictedContactPlan = predictedContactPlanPath
  ? await readPredictedContactPlan(resolve(predictedContactPlanPath))
  : null;
let plannerOamLinks = plannerOamLinksPath
  ? await readCsvStream(resolve(plannerOamLinksPath), { columns: OAM_LINK_PLANNER_COLUMNS })
  : [];
let plannerOamNodes = plannerOamNodesPath
  ? await readCsvStream(resolve(plannerOamNodesPath), { columns: OAM_NODE_PLANNER_COLUMNS })
  : [];
const oamPriorityRetests = oamPriorityRetestPath ? await readCsvStream(resolve(oamPriorityRetestPath)) : [];
const oamControlActions = oamControlActionsPath ? await readCsvStream(resolve(oamControlActionsPath)) : [];
const scaleBudgetReferenceRows = scaleBudgetReferenceCsvPath
  ? await readCsvStream(resolve(scaleBudgetReferenceCsvPath))
  : [];
const scaleBudgetReferenceBySlice = buildScaleBudgetReference(scaleBudgetReferenceRows);
const planningLinks = buildObservablePlanningLinks({
  truthLinks: links,
  predictedPlan: predictedContactPlan,
  oamLinks: plannerOamLinks,
  mode: observabilityMode,
  stateLagSlices: feedbackLagSlices,
});
const planningNodes = buildObservablePlanningNodes({
  truthNodes: nodes,
  oamNodes: plannerOamNodes,
  mode: observabilityMode,
  stateLagSlices: feedbackLagSlices,
});
const planningRoutes = buildObservableRoutes({ routes, mode: observabilityMode });
links = [];
nodes = [];
routes = [];
plannerOamLinks = [];
plannerOamNodes = [];
if (predictedContactPlan?.entries) predictedContactPlan.entries = [];
const observableOamPriorityRetests = scheduleObservableRows(buildObservableOamFeedback({
  rows: oamPriorityRetests,
  mode: observabilityMode,
}), { lagSlices: feedbackLagSlices });
const observableOamControlActions = scheduleObservableRows(oamControlActions, {
  lagSlices: feedbackLagSlices,
  sourceFieldCandidates: ["source_slice_index", "control_source_slice_index", "slice_index"],
  targetFieldCandidates: ["next_slice_index", "target_slice_index", "slice_index"],
});
const linksBySlice = groupBy(planningLinks, (link) => String(link.slice_index));
const nodesBySlice = groupBy(planningNodes, (node) => String(node.slice_index));
const routesBySlice = groupBy(planningRoutes, (route) => String(route.slice_index));
const pathsBySlice = groupBy(candidatePaths, (path) => String(path.slice_index));
const linksBySliceAndId = indexBy(planningLinks, (link) => `${link.slice_index}|${link.link_id}`);
const nodesBySliceAndId = indexBy(planningNodes, (node) => `${node.slice_index}|${node.node_id}`);
const sliceIndexes = [...linksBySlice.keys()].sort((left, right) => Number(left) - Number(right));
const linksById = buildLinksById(planningLinks);
const graphsBySlice = buildGraphsBySlice(planningLinks);
const forecastBySliceAndLink = forecastRiskScoring
  ? buildPredictionForecasts({
      linksById,
      sliceIndexes,
      horizon: predictionScoreHorizon,
    })
  : new Map();
const oamFeedbackBySlice = buildOamFeedbackBySlice(observableOamPriorityRetests);
const oamControlBySlice = buildOamControlBySlice(observableOamControlActions);
const causalPlannerStateRows = [...planningLinks, ...planningNodes]
  .filter((row) => row.planner_state_source_slice_index !== "" && row.planner_state_source_slice_index !== undefined);
const causalFeedbackRows = [...observableOamPriorityRetests, ...observableOamControlActions];
const causalFeedbackViolations = feedbackLagSlices < 1
  ? 0
  : causalFeedbackRows.filter((row) =>
      Number(row.source_slice_index) >= Number(row.slice_index)
    ).length + causalPlannerStateRows.filter((row) =>
      Number(row.planner_state_source_slice_index) >= Number(row.slice_index)
    ).length;
const importanceTargetPlan = importanceAwareTargetsEnabled
  ? buildImportanceAwareTargetPlan({
      slices: sliceIndexes.map(Number),
      nodes: planningNodes,
      links: planningLinks,
      routes: planningRoutes,
      options: {
        windowSize: importanceWindowSize,
        nodeTargetRatio: importanceNodeTargetRatio,
        linkTargetRatio: importanceLinkTargetRatio,
        maxAoISlices: importanceMaxAoISlices,
        explorationRatio: importanceExplorationRatio,
      },
    })
  : {
      rows: [],
      bySlice: new Map(),
      summary: {
        slice_count: sliceIndexes.length,
        target_count: 0,
        node_target_count: 0,
        link_target_count: 0,
        mandatory_target_count: 0,
        rejected_noncausal_rows: 0,
        causal_boundary: "disabled",
      },
    };
const planeRepresentativesBySlice = new Map(sliceIndexes.map((sliceIndex) => [
  numberValue(sliceIndex),
  buildRotatingPlaneRepresentatives({
    nodes: nodesBySlice.get(String(sliceIndex)) ?? [],
    sliceIndex: numberValue(sliceIndex),
    representativeRatio: importancePlaneRepresentativeRatio,
  }),
]));
function selectionImportanceTargetsForSlice(sliceIndex) {
  const baseTargets = importanceTargetPlan.bySlice.get(numberValue(sliceIndex)) ?? [];
  if (!importanceBudgetNeutralReplacementEnabled) return baseTargets;
  const representatives = planeRepresentativesBySlice.get(numberValue(sliceIndex)) ?? new Set();
  return [
    ...baseTargets,
    ...[...representatives].map((nodeId) => ({
      slice_index: numberValue(sliceIndex),
      target_type: "node",
      target_id: nodeId,
      importance_score: 0.2,
      mandatory: false,
      coverage_required: false,
      aoi_debt_severity: 0,
      target_class: "rotating-plane-representative",
      reason: "orbit-plane-representative-rotation",
    })),
  ];
}
const contactPlan = buildContactPlan({
  linksBySlice,
  routesBySlice,
  sliceIndexes,
  classThreshold: topologyClassThreshold,
  adaptiveReuse,
  overheadPressure: reuseOverheadPressure,
  oamFeedbackBySlice,
  oamControlBySlice,
  oamReplanPressureThreshold,
  oamControlReplanPressureThreshold,
  thresholdCalibrationHorizon,
});
if (scaleBudgetReferenceCsvPath) {
  const missingSlices = contactPlan.perSlice
    .map((slice) => String(slice.slice_index))
    .filter((sliceIndex) => !scaleBudgetReferenceBySlice.has(sliceIndex));
  if (missingSlices.length > 0) {
    throw new Error(`scale budget reference is missing slices: ${missingSlices.join(", ")}`);
  }
}
const leverageScores = buildLeverageScores({ linksById, sliceIndexes, rank });
const selectedLastSeen = new Map();
const selectedNodeLastSeen = new Map();
const reusablePlansByClass = new Map();
const unifiedRepairCandidateBudgetByClass = new Map();
const reusablePlansByVersion = [];
const unifiedStablePathCache = new Map();
const selectedRows = [];
const summaryRows = [];
const importanceMandatoryTargetsBySlice = new Map();
const importanceMetadataSummaryRows = [];
let incrementalDeltaCandidatePaths = 0;
const topologyVersionedObjectiveOptions = {
  topologyVersionedObjectiveEnabled,
  topologyVersionedObjectiveWeights,
  topologyVersionedConfidenceThreshold,
};
const scaleAdaptiveBudgetOptions = {
  scaleAdaptiveTotalBudgetEnabled,
  scaleBudgetHeadroomRatio,
  scaleBudgetPathHeadroomRatio,
};

contactPlan.perSlice.forEach((slicePlan, slicePosition) => {
  const previousSlicePlan = slicePosition > 0 ? contactPlan.perSlice[slicePosition - 1] : null;
  const previousActiveSet = previousSlicePlan?.activeSet ?? new Set();
  const topologyAddedLinkIds = previousSlicePlan
    ? [...slicePlan.activeSet].filter((linkId) => !previousActiveSet.has(linkId))
    : [...slicePlan.activeSet];
  const topologyRemovedLinkIds = previousSlicePlan
    ? [...previousActiveSet].filter((linkId) => !slicePlan.activeSet.has(linkId))
    : [];
  slicePlan.unified_topology_added_link_ids = topologyAddedLinkIds.join(" > ");
  slicePlan.unified_topology_removed_link_ids = topologyRemovedLinkIds.join(" > ");
  const referenceScaleBudget = scaleBudgetReferenceBySlice.get(String(slicePlan.slice_index));
  const sliceTelemetryByteBudget = referenceScaleBudget ?? telemetryByteBudgetPerSlice;
  const sliceScaleAdaptiveBudgetOptions = {
    ...scaleAdaptiveBudgetOptions,
    scaleBudgetExplicitSource: referenceScaleBudget === undefined
      ? "explicit-hard-cap"
      : "reference-schedule-hard-cap",
  };
  const currentCandidates = pathsBySlice.get(String(slicePlan.slice_index)) ?? [];
  const classCachedCandidates = reusablePlansByClass.get(slicePlan.topology_class_id) ?? [];
  const structuralCacheBase = topologyVersionedRiskPlannerEnabled && adaptiveReuse
    ? selectStructuralCacheBase({
        entries: reusablePlansByVersion,
        currentActiveLinkIds: [...slicePlan.activeSet],
        currentTopologySignature: slicePlan.topology_signature,
        currentSliceIndex: slicePlan.slice_index,
        cacheWindowSlices: windowSize,
        adaptivePolicy: {
          enabled: adaptiveStructuralReuseEnabled,
          relative_error_tolerance: structuralReuseErrorTolerance,
          minimum_similarity_floor: structuralReuseSimilarityFloor,
          maximum_changed_link_ratio_ceiling: structuralReuseMaximumChangedLinkRatio,
          maximum_affected_path_ratio_ceiling: structuralReuseMaximumAffectedPathRatio,
          minimum_valid_path_ratio_floor: structuralReuseMinimumValidPathRatio,
        },
        forecastDriftPressure: slicePlan.topology_forecast_drift_pressure,
        oamPressure: slicePlan.oam_replan_pressure,
        reuseConfidence: slicePlan.topology_forecast_reuse_confidence,
        planningOverheadPressure: reuseOverheadPressure,
        recommendedPlanMode: slicePlan.topology_forecast_recommended_plan_mode,
      })
    : null;
  const cachedCandidates = topologyVersionedRiskPlannerEnabled
    ? structuralCacheBase?.eligible
      ? structuralCacheBase.selected.entry.paths
      : []
    : classCachedCandidates;
  const unifiedRepairCandidateBudget = topologyVersionedRiskPlannerEnabled
    ? numberValue(structuralCacheBase?.selected?.entry?.candidate_budget, cachedCandidates.length)
    : unifiedRepairCandidateBudgetByClass.get(slicePlan.topology_class_id) ?? cachedCandidates.length;
  const cacheAddedLinkIds = structuralCacheBase?.eligible
    ? structuralCacheBase.selected.added_link_ids
    : topologyAddedLinkIds;
  const cacheRemovedLinkIds = structuralCacheBase?.eligible
    ? structuralCacheBase.selected.removed_link_ids
    : topologyRemovedLinkIds;
  const useCached = adaptiveReuse && slicePlan.topology_reused_from_class && cachedCandidates.length > 0;
  const unifiedCacheAvailable = topologyVersionedRiskPlannerEnabled && adaptiveReuse && cachedCandidates.length > 0;
  const unifiedCacheImpact = structuralCacheBase?.selected?.impact ?? assessCachedPathImpact({
    cachedPaths: cachedCandidates,
    currentActiveLinkIds: [...slicePlan.activeSet],
    changedLinkIds: [...cacheAddedLinkIds, ...cacheRemovedLinkIds],
  });
  const unifiedModePrefilter = topologyVersionedRiskPlannerEnabled
    ? prefilterTopologyPlanningModes({
        allowedModes: [...topologyVersionedAllowedModes],
        cacheAvailable: unifiedCacheAvailable,
        currentTopologySignature: slicePlan.topology_signature,
        cachedTopologySignature: structuralCacheBase?.selected?.entry?.topology_signature ?? cachedCandidates[0]?.topology_signature ?? "",
        addedLinkCount: cacheAddedLinkIds.length,
        removedLinkCount: cacheRemovedLinkIds.length,
        activeLinkCount: slicePlan.activeSet.size,
        reuseConfidence: slicePlan.topology_forecast_reuse_confidence,
        driftPressure: slicePlan.topology_forecast_drift_pressure,
        recommendedPlanMode: slicePlan.topology_forecast_recommended_plan_mode,
        oamReplanRequired: boolValue(slicePlan.oam_replan_triggered) ||
          boolValue(slicePlan.oam_control_replan_triggered),
        topologySimilarityScore: structuralCacheBase?.selected?.topology_similarity_score ?? slicePlan.topology_similarity_score,
        adaptiveReuseThreshold: slicePlan.adaptive_reuse_threshold,
        cachedPathAffectedRatio: unifiedCacheImpact.affected_cached_path_ratio,
        cachedPathValidRatio: 1 - unifiedCacheImpact.inactive_cached_path_ratio,
        structuralCacheGuards: structuralCacheBase?.selected?.effective_guards,
        structuralEstimatedErrorIncrease:
          structuralCacheBase?.selected?.estimated_relative_error_increase_proxy,
        structuralRelativeErrorTolerance:
          structuralCacheBase?.selected?.adaptive_assessment?.relative_error_tolerance,
      })
    : null;
  const unifiedEffectiveModes = new Set(
    unifiedModePrefilter?.selected_modes ?? [...topologyVersionedAllowedModes],
  );
  slicePlan.unified_mode_prefilter_policy = unifiedModePrefilter?.policy ?? "legacy";
  slicePlan.unified_mode_prefilter_reason = unifiedModePrefilter?.reason ?? "legacy-planner";
  slicePlan.unified_mode_prefilter_selected_modes = [...unifiedEffectiveModes].join(" > ");
  slicePlan.unified_mode_prefilter_changed_link_ratio = unifiedModePrefilter?.changed_link_ratio ?? "";
  slicePlan.unified_mode_prefilter_rejection_reasons = (unifiedModePrefilter?.rejection_reasons ?? []).join(" > ");
  slicePlan.unified_structural_cache_source_slice = structuralCacheBase?.selected?.slice_index ?? "";
  slicePlan.unified_structural_cache_age_slices = structuralCacheBase?.selected?.age_slices ?? "";
  slicePlan.unified_structural_cache_similarity = structuralCacheBase?.selected?.topology_similarity_score ?? "";
  slicePlan.unified_structural_cache_eligible = Boolean(structuralCacheBase?.eligible);
  slicePlan.unified_structural_cache_rejection_reasons = (structuralCacheBase?.rejection_reasons ?? []).join(" > ");
  slicePlan.unified_structural_cache_adaptive_enabled = Boolean(
    structuralCacheBase?.selected?.adaptive_assessment?.enabled,
  );
  slicePlan.unified_structural_cache_adaptive_policy =
    structuralCacheBase?.selected?.adaptive_assessment?.policy ?? "";
  slicePlan.unified_structural_cache_adaptive_reason =
    structuralCacheBase?.selected?.adaptive_assessment?.reason ?? "";
  slicePlan.unified_structural_cache_error_tolerance =
    structuralCacheBase?.selected?.adaptive_assessment?.relative_error_tolerance ?? 0;
  slicePlan.unified_structural_cache_estimated_error_increase_proxy =
    structuralCacheBase?.selected?.estimated_relative_error_increase_proxy ?? 0;
  slicePlan.unified_structural_cache_error_tolerance_utilization =
    structuralCacheBase?.selected?.error_tolerance_utilization ?? 0;
  slicePlan.unified_structural_cache_relaxation_factor =
    structuralCacheBase?.selected?.adaptive_assessment?.relaxation_factor ?? 0;
  slicePlan.unified_structural_cache_risk_pressure =
    structuralCacheBase?.selected?.adaptive_assessment?.risk_pressure ?? 0;
  slicePlan.unified_structural_cache_effective_similarity_threshold =
    structuralCacheBase?.selected?.effective_guards?.minimum_similarity ?? "";
  slicePlan.unified_structural_cache_effective_changed_link_limit =
    structuralCacheBase?.selected?.effective_guards?.maximum_changed_link_ratio ?? "";
  slicePlan.unified_structural_cache_effective_affected_path_limit =
    structuralCacheBase?.selected?.effective_guards?.maximum_affected_path_ratio ?? "";
  slicePlan.unified_structural_cache_effective_valid_path_floor =
    structuralCacheBase?.selected?.effective_guards?.minimum_valid_path_ratio ?? "";
  slicePlan.unified_cached_path_count = unifiedCacheImpact.cached_path_count;
  slicePlan.unified_affected_cached_path_count = unifiedCacheImpact.affected_cached_path_count;
  slicePlan.unified_affected_cached_path_ratio = unifiedCacheImpact.affected_cached_path_ratio;
  slicePlan.unified_inactive_cached_path_count = unifiedCacheImpact.inactive_cached_path_count;
  slicePlan.unified_retained_cached_path_count = unifiedCacheImpact.retained_cached_path_count;
  const candidateSource = topologyVersionedRiskPlannerEnabled
    ? "unified-topology-version-candidate-pool"
    : useCached
      ? "topology-reuse-cache"
      : "fresh-slice-plan";
  const mandatoryTargets = oamMandatoryTargetsForSlice({
    sliceIndex: slicePlan.slice_index,
    oamFeedbackBySlice,
    oamControlBySlice,
  });
  importanceMandatoryTargetsBySlice.set(numberValue(slicePlan.slice_index), mandatoryTargets);
  let baseCandidateRows;
  let candidateRows;
  if (topologyVersionedRiskPlannerEnabled) {
    const modeRows = [];
    if (unifiedEffectiveModes.has("fresh")) {
      modeRows.push(...currentCandidates.map((path) => ({
        ...adaptCandidatePath(path, slicePlan, "fresh-slice-plan"),
        unified_planning_mode: "fresh",
      })));
    }
    if (unifiedCacheAvailable && unifiedEffectiveModes.has("reuse")) {
      modeRows.push(...cachedCandidates.map((path) => ({
        ...adaptCandidatePath(path, slicePlan, "topology-reuse-cache"),
        unified_planning_mode: "reuse",
      })));
    }
    if (unifiedCacheAvailable && incrementalTopologyRepair && unifiedEffectiveModes.has("repair")) {
      const guardedStructuralRepair = slicePlan.unified_mode_prefilter_policy === "repair-guarded-structural-cache";
      const repairWithDelta = guardedStructuralRepair
        ? currentCandidates.map((path) => ({
            ...adaptCandidatePath(path, slicePlan, "topology-structural-cache-dynamic-rescore"),
            unified_planning_mode: "repair",
            unified_fast_repair_no_reroute: true,
            unified_structural_cache_dynamic_rescore: true,
          }))
        : appendTopologyRepairDeltaCandidates({
            cachedRows: cachedCandidates.map((path) => ({
              ...adaptCandidatePath(path, slicePlan, "topology-reuse-cache-local-repair"),
              unified_planning_mode: "repair",
              unified_fast_repair_no_reroute: true,
            })),
            currentCandidates,
            slicePlan,
            targets: mandatoryTargets,
            changedLinkIds: cacheAddedLinkIds,
            candidateBudget: unifiedRepairCandidateBudget,
          }).map((path) => ({
            ...path,
            reused_candidate_source: "topology-reuse-cache-local-repair",
            unified_planning_mode: "repair",
          }));
      modeRows.push(...repairWithDelta);
    }
    if (modeRows.length === 0 && topologyVersionedAllowedModes.has("fresh")) {
      slicePlan.unified_mode_prefilter_policy = "fresh-empty-prefilter-fallback";
      slicePlan.unified_mode_prefilter_reason = "prefiltered-mode-produced-no-candidates";
      slicePlan.unified_mode_prefilter_selected_modes = "fresh";
      modeRows.push(...currentCandidates.map((path) => ({
        ...adaptCandidatePath(path, slicePlan, "fresh-slice-plan"),
        unified_planning_mode: "fresh",
      })));
    }
    const seen = new Set();
    candidateRows = modeRows.filter((row) => {
      const key = `${row.unified_planning_mode}|${candidateIdentity(row)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    baseCandidateRows = candidateRows;
  } else {
    baseCandidateRows = (useCached ? cachedCandidates : currentCandidates).map((path) =>
      adaptCandidatePath(path, slicePlan, candidateSource),
    );
    candidateRows = useCached && incrementalTopologyRepair
      ? appendOamDeltaCandidates({
          cachedRows: baseCandidateRows,
          currentCandidates,
          slicePlan,
          targets: mandatoryTargets,
        })
      : baseCandidateRows;
  }
  incrementalDeltaCandidatePaths += candidateRows.filter(
    (row) => ["topology-reuse-cache-oam-delta", "topology-reuse-cache-local-delta"].includes(row.reused_candidate_source),
  ).length;
  let result = selectSlicePaths({
    slicePosition,
    slicePlan,
    candidatePaths: candidateRows,
    unifiedStablePathCache,
    unifiedRepairFallbackCandidates: currentCandidates.map((path) => ({
      ...adaptCandidatePath(path, slicePlan, "topology-reuse-cache-representative-refresh"),
      unified_planning_mode: "repair",
    })),
    unifiedRepairCandidateBudget,
    linksBySliceAndId,
    nodesBySliceAndId,
    leverageScores,
    forecastBySliceAndLink,
    selectedLastSeen,
    selectedNodeLastSeen,
    algorithm,
    samplingRate,
    targetActiveLinkSamplingRate,
    minPaths,
    maxPaths,
    warmupSlices,
    windowSize,
    graph: graphsBySlice.get(String(slicePlan.slice_index)),
    candidateSource,
    minEnergyPercent,
    energyGuardThreshold,
    energyBudgetEnabled,
    energyBudgetMinActiveLinkSamplingRate,
    energyBudgetMaxReduction,
    adaptiveProbeBudgetEnabled,
    selectionStrategy,
    oamFeedbackBySlice,
    oamFeedbackWeight,
    oamControlBySlice,
    oamControlWeight,
    predictionScoreHorizon,
    costAwareSampling,
    costAwarenessWeight,
    telemetryByteBudgetPerSlice: sliceTelemetryByteBudget,
    hopMetadataBytes,
    adaptiveMetadataProfileEnabled,
    compactHopMetadataBytes,
    oamTargetAwareMetadataEnabled,
    oamTargetHopMetadataBytes,
    oamTransitHopMetadataBytes,
    oamTargetNeighborhoodMaxLossRatio,
    probePacketBaseBytes,
    reportHeaderBytes,
    hopProcessingJ,
    reportProcessingJ,
    telemetryTxNjPerByte,
    importancePathScoringEnabled,
    importanceTargets: importancePathScoringEnabled
      ? selectionImportanceTargetsForSlice(slicePlan.slice_index)
      : [],
    importanceScoreWeight,
    importanceShadowInformationFloor,
    importanceAoIShadowInformationFloor,
    importanceAoIDebtPathRatio,
    importanceRepairByteBudgetRatio,
    importanceBudgetNeutralReplacementEnabled,
    importanceReplacementRatio,
    importanceReplacementMaxBaseLossRatio,
    ...sliceScaleAdaptiveBudgetOptions,
    ...topologyVersionedObjectiveOptions,
  });
  const mandatoryCoverage = oamMandatoryCoverageForRows(result.rows, mandatoryTargets);
  const candidateMandatoryCoverage = oamMandatoryCoverageForRows(candidateRows, mandatoryTargets);
  const allowWholeSliceMandatoryFallback = false;
  if (
    useCached &&
    mandatoryTargets.count > 0 &&
    !mandatoryCoverage.covered_all &&
    !candidateMandatoryCoverage.covered_all &&
    allowWholeSliceMandatoryFallback
  ) {
    result = selectSlicePaths({
      slicePosition,
      slicePlan: {
        ...slicePlan,
        topology_reuse_decision: "oam-mandatory-coverage-fresh-replan-uncovered-by-local-delta",
        oam_mandatory_coverage_broke_reuse: true,
        oam_mandatory_coverage_missing_link_targets: mandatoryCoverage.missing_links,
        oam_mandatory_coverage_missing_node_targets: mandatoryCoverage.missing_nodes,
      },
      candidatePaths: currentCandidates.map((path) => adaptCandidatePath(path, slicePlan, "fresh-slice-plan-oam-mandatory")),
      unifiedStablePathCache,
      linksBySliceAndId,
      nodesBySliceAndId,
      leverageScores,
      forecastBySliceAndLink,
      selectedLastSeen,
      selectedNodeLastSeen,
      algorithm,
      samplingRate,
      targetActiveLinkSamplingRate,
      minPaths,
      maxPaths,
      warmupSlices,
      windowSize,
      graph: graphsBySlice.get(String(slicePlan.slice_index)),
      candidateSource: "fresh-slice-plan-oam-mandatory",
      minEnergyPercent,
      energyGuardThreshold,
      energyBudgetEnabled,
      energyBudgetMinActiveLinkSamplingRate,
      energyBudgetMaxReduction,
      adaptiveProbeBudgetEnabled,
      selectionStrategy,
      oamFeedbackBySlice,
      oamFeedbackWeight,
      oamControlBySlice,
      oamControlWeight,
      predictionScoreHorizon,
      costAwareSampling,
      costAwarenessWeight,
      telemetryByteBudgetPerSlice: sliceTelemetryByteBudget,
      hopMetadataBytes,
      adaptiveMetadataProfileEnabled,
      compactHopMetadataBytes,
      oamTargetAwareMetadataEnabled,
      oamTargetHopMetadataBytes,
      oamTransitHopMetadataBytes,
      oamTargetNeighborhoodMaxLossRatio,
      probePacketBaseBytes,
      reportHeaderBytes,
      hopProcessingJ,
      reportProcessingJ,
      telemetryTxNjPerByte,
      importancePathScoringEnabled,
      importanceTargets: importancePathScoringEnabled
        ? selectionImportanceTargetsForSlice(slicePlan.slice_index)
        : [],
      importanceScoreWeight,
      importanceShadowInformationFloor,
      importanceAoIShadowInformationFloor,
      importanceAoIDebtPathRatio,
      importanceRepairByteBudgetRatio,
      importanceBudgetNeutralReplacementEnabled,
      importanceReplacementRatio,
      importanceReplacementMaxBaseLossRatio,
      multiObjectiveBudgetEnabled,
      ...sliceScaleAdaptiveBudgetOptions,
      ...topologyVersionedObjectiveOptions,
    });
  }
  if (useCached && result.rows.length === 0 && currentCandidates.length > 0) {
    result = selectSlicePaths({
      slicePosition,
      slicePlan: {
        ...slicePlan,
        topology_reuse_decision: "reuse-failed-fresh-replan",
      },
      candidatePaths: currentCandidates.map((path) => adaptCandidatePath(path, slicePlan, "fresh-slice-plan-fallback")),
      unifiedStablePathCache,
      linksBySliceAndId,
      nodesBySliceAndId,
      leverageScores,
      forecastBySliceAndLink,
      selectedLastSeen,
      selectedNodeLastSeen,
      algorithm,
      samplingRate,
      targetActiveLinkSamplingRate,
      minPaths,
      maxPaths,
      warmupSlices,
      windowSize,
      graph: graphsBySlice.get(String(slicePlan.slice_index)),
      candidateSource: "fresh-slice-plan-fallback",
      minEnergyPercent,
      energyGuardThreshold,
      energyBudgetEnabled,
      energyBudgetMinActiveLinkSamplingRate,
      energyBudgetMaxReduction,
      adaptiveProbeBudgetEnabled,
      selectionStrategy,
      oamFeedbackBySlice,
      oamFeedbackWeight,
      oamControlBySlice,
      oamControlWeight,
      predictionScoreHorizon,
      costAwareSampling,
      costAwarenessWeight,
      telemetryByteBudgetPerSlice: sliceTelemetryByteBudget,
      hopMetadataBytes,
      adaptiveMetadataProfileEnabled,
      compactHopMetadataBytes,
      oamTargetAwareMetadataEnabled,
      oamTargetHopMetadataBytes,
      oamTransitHopMetadataBytes,
      oamTargetNeighborhoodMaxLossRatio,
      probePacketBaseBytes,
      reportHeaderBytes,
      hopProcessingJ,
      reportProcessingJ,
      telemetryTxNjPerByte,
      importancePathScoringEnabled,
      importanceTargets: importancePathScoringEnabled
        ? selectionImportanceTargetsForSlice(slicePlan.slice_index)
        : [],
      importanceScoreWeight,
      importanceShadowInformationFloor,
      importanceAoIShadowInformationFloor,
      importanceAoIDebtPathRatio,
      importanceRepairByteBudgetRatio,
      importanceBudgetNeutralReplacementEnabled,
      importanceReplacementRatio,
      importanceReplacementMaxBaseLossRatio,
      multiObjectiveBudgetEnabled,
      ...sliceScaleAdaptiveBudgetOptions,
      ...topologyVersionedObjectiveOptions,
    });
  }
  if (importanceAwareTargetsEnabled && importanceSelectiveMetadataEnabled) {
    const attached = attachImportanceAwareMetadataPlans({
      rows: result.rows,
      targetsBySlice: importanceTargetPlan.bySlice,
      mandatoryTargetsBySlice: importanceMandatoryTargetsBySlice,
      representativeNodesBySlice: planeRepresentativesBySlice,
      // Keep one causal core observation for every newly encountered node. Strict
      // forward-only applies only after both the node and its local link state have
      // already been observed in this slice; it must not create a node-state blind spot.
      preserveCoreNodeCoverage: true,
      // The compact core profile keeps every reconstruction field. Only repeated
      // observations are omitted; first observations are never downgraded to a
      // partial feature vector that could bias multimetric completion.
      preserveCoreLinkMetrics: true,
      preserveAdjacentLinkCoverage: true,
      preserveNonTargetLinks: true,
      preserveEndpointNodeCoverage: importanceStrictForwardOnlyEnabled,
    });
    result = {
      ...result,
      rows: attached.rows,
      summary: result.summary
        ? {
            ...result.summary,
            importance_aware_targets_enabled: true,
            importance_metadata_only: importanceMetadataOnly,
            importance_selective_metadata_enabled: true,
            importance_metadata_bytes: attached.summary.metadata_bytes,
            importance_target_mask_bytes: attached.summary.target_mask_bytes,
            importance_saved_payload_bytes: attached.summary.saved_payload_bytes,
            importance_target_hits: attached.summary.target_hits,
            importance_mandatory_target_hits: attached.summary.mandatory_target_hits,
            importance_plane_representative_hops: attached.summary.plane_representative_hops,
            importance_forward_only_hops: attached.summary.forward_only_hops,
            importance_node_state_omitted_hops: attached.summary.node_state_omitted_hops,
          }
        : result.summary,
    };
    importanceMetadataSummaryRows.push({
      slice_index: slicePlan.slice_index,
      ...attached.summary,
    });
  }
  selectedRows.push(...result.rows);
  if (result.summary) {
    const reusableRows = result.rows.map((row) => ({
      ...row,
      source_candidate_probe_id: row.source_candidate_probe_id || row.probe_id,
    }));
    if (reusableRows.length > 0) {
      reusablePlansByClass.set(slicePlan.topology_class_id, reusableRows);
      if (!unifiedRepairCandidateBudgetByClass.has(slicePlan.topology_class_id)) {
        unifiedRepairCandidateBudgetByClass.set(slicePlan.topology_class_id, reusableRows.length);
      }
      reusablePlansByVersion.push({
        slice_index: numberValue(slicePlan.slice_index),
        topology_class_id: slicePlan.topology_class_id,
        topology_signature: slicePlan.topology_signature,
        active_link_ids: [...slicePlan.activeSet],
        paths: reusableRows,
        candidate_budget: reusableRows.length,
      });
      while (reusablePlansByVersion.length > Math.max(1, windowSize)) reusablePlansByVersion.shift();
    }
    summaryRows.push(result.summary);
  }
});

const activeLinkSamples = summaryRows.reduce((total, row) => total + row.active_links, 0);
const sampledActiveLinkSamples = summaryRows.reduce((total, row) => total + row.sampled_active_links, 0);
const fullPlanningCostUnits = summaryRows.reduce((total, row) => total + numberValue(row.planning_full_replan_cost_units), 0);
const actualPlanningCostUnits = summaryRows.reduce((total, row) => total + numberValue(row.planning_actual_cost_units), 0);
const savedPlanningCostUnits = Math.max(0, fullPlanningCostUnits - actualPlanningCostUnits);
const samplingMaskRows = buildSamplingMask({
  planningLinks,
  selectedRows,
  contactPlan,
  summaryRows,
  leverageScores,
  forecastBySliceAndLink,
  samplingRate,
  targetActiveLinkSamplingRate,
  selectionStrategy,
  predictionScoreHorizon,
});
const unifiedPrefilterRejectionReasonCounts = summaryRows.reduce((counts, row) => {
  splitPath(row.unified_mode_prefilter_rejection_reasons).forEach((reason) => {
    counts[reason] = (counts[reason] ?? 0) + 1;
  });
  return counts;
}, {});
const activeSamplingMaskRows = samplingMaskRows.filter((row) => row.active_mask_value === 1);
const sampledActiveSamplingMaskRows = samplingMaskRows.filter((row) => row.sampling_mask_value === 1);
const duplicateSamplingObservations = sampledActiveSamplingMaskRows.reduce((total, row) => total + Math.max(0, numberValue(row.selected_probe_count) - 1), 0);
const report = {
  schema_version: "stage2-leo-int-mc-path-selection-v1",
  generated_at: new Date().toISOString(),
  source: {
    input_dir: inputDir,
    stage2_dir: stage2Dir,
    links_csv: linksPath,
    nodes_csv: existsSync(nodesPath) ? nodesPath : "",
    routes_csv: existsSync(routesPath) ? routesPath : "",
    candidate_paths_csv: candidatePathsPath,
    candidate_algorithm: candidateAlgorithm,
    predicted_contact_plan_json: predictedContactPlanPath ? resolve(predictedContactPlanPath) : "",
    planner_oam_links_csv: plannerOamLinksPath ? resolve(plannerOamLinksPath) : "",
    planner_oam_nodes_csv: plannerOamNodesPath ? resolve(plannerOamNodesPath) : "",
    oam_priority_retest_csv: oamPriorityRetestPath ? resolve(oamPriorityRetestPath) : "",
    oam_control_actions_csv: oamControlActionsPath ? resolve(oamControlActionsPath) : "",
  },
  planning_algorithm: algorithm,
  method: {
    origin: topologyVersionedRiskPlannerEnabled
      ? "topology-versioned, risk-aware, unit-cost information-gain active telemetry for LEO"
      : "INT-MC path leverage sampling adapted for predictable LEO contact plans",
    satellite_adaptations: [
      "contact-plan topology classes from active link masks",
      "predicted contact plan uses first-stage orbital and link-budget parameters instead of business load state",
      "active topology mask separated from unobserved telemetry mask",
      "explicit slice-link sampling mask records planned sampled links and active-unobserved completion targets",
      "deterministic warmup instead of random sampling",
      "shared selection-strategy interface for full INT, random, shortest-path, topology-aware and INT-MC baselines",
      "rolling stale-link bonus for dynamic LEO links",
      "adaptive topology similarity threshold instead of fixed or random reuse",
      "adaptive threshold is explained by volatility, bottlenecks, load, contact uncertainty, topology drift, link-state drift, route drift, OAM pressure, stability history and planning pressure",
      "threshold calibration uses the distribution of reusable topology-class similarities plus a short predicted future window to avoid arbitrary reuse thresholds",
      "forecast-aware path scoring uses a rolling future contact window to prioritize links with upcoming topology changes, near outages or contact scarcity",
      "per-slice topology forecast estimates stable-window length and drift pressure, then boosts active-link sampling before predicted topology transitions",
      "standard low-rank row leverage is computed from a link-by-time-metadata matrix",
      "explicit greedy marginal information gain discounts links similar to already selected links",
      "path score is reported as Score(P)=marginal information gain divided by telemetry KB",
      "topology-versioned objective jointly evaluates predicted risk, uncertainty, metadata yield, telemetry bytes, energy, planning cost, expected reconstruction error and state age",
      "conservative objective gate falls back to the legacy ranking when evidence confidence is low and bounds every ranking adjustment",
      "cost-aware sampling estimates per-probe INT bytes and telemetry energy before ranking low-overhead paths",
      "optional per-slice telemetry byte budget suppresses noncritical probes while allowing critical coverage overrides",
      "route-path similarity included in topology reuse decisions",
      "link-state matrix similarity included in topology reuse decisions",
      "similar topology class reuses cached probe plans with local repair",
      "adaptive probe budget turns high-confidence topology reuse into fewer probe paths and lower telemetry byte pressure",
      "adaptive metadata profile turns stable topology-reuse probes into compact per-hop INT metadata and path-only observation while preserving full metadata/all-adjacent scans for OAM pressure and fresh replans",
      "adaptive probe budget escalates sampling when OAM confidence, unknown-state or retest pressure is high",
      "energy-aware path penalty for low-power satellites",
      "shadow and power-margin aware energy guard suppresses nonessential probe paths",
      "energy-aware slice budget lowers nonessential probe sampling rate in shadow, low-energy or negative-power-margin conditions",
      "optional Ground OAM priority-retest feedback biases future probe selection while only low-confidence targets become mandatory retests",
      "Ground OAM retest pressure first triggers local probe retargeting on reusable topology classes before any fresh fallback is considered",
      "optional Ground OAM control actions distinguish low-pressure soft retest bias from high-pressure mandatory local retargeting",
      "Ground OAM control actions can recommend per-slice sampling rates and telemetry byte budgets for closed-loop low-overhead telemetry",
      "local path repair when a predicted contact gap invalidates an old candidate route",
      "normalized planning-cost accounting estimates the benefit of topology reuse versus full per-slice replanning",
      "path selection runs on ground-side planning data, not on satellites",
      ...(topologyVersionedRiskPlannerEnabled ? [
        "reuse, repair and fresh plans compete under the same immutable per-slice byte cap",
        "optional error-budgeted adaptive structural guards relax topology reuse only when causal OAM, forecast, cache-age and path-validity risk leave sufficient tolerance",
        "risk is a positive sampling value for uncertain objects that may soon become unavailable",
        "full, compact and selective per-hop metadata are explicit actions in the same budgeted optimization",
        "selective actions emit executable forward-only hop masks instead of accounting-only compression",
        "no OAM, coverage or risk condition can override the hard telemetry byte budget",
      ] : []),
      ...(importanceAwareTargetsEnabled ? [
        "causal rolling importance targets combine lagged OAM uncertainty, state age, volatility, known workload, predictable contact risk and exploration fairness",
        "per-hop selective metadata masks let pure transit satellites forward probes without exposing unrequested node or link state",
        "target-mask bytes and delivered field bytes are explicitly accounted instead of treating metadata compression as accounting-only",
      ] : []),
    ],
    planning_overhead_model: {
      unit: "relative-normalized-planning-cost",
      full_replan_baseline: "active-link mask build plus candidate path scoring for every slice",
      reuse_path: "cached path validation plus local repair on the predicted active graph",
      scope: "ground-side planning overhead only; not satellite CPU telemetry processing energy",
    },
    mininet_code_not_ported: true,
    uses_predicted_contact_plan: Boolean(predictedContactPlan),
      mechanism_flags: {
        unified_planner: topologyVersionedRiskPlannerEnabled,
      adaptive_structural_reuse: adaptiveStructuralReuseEnabled,
      structural_reuse_error_tolerance: structuralReuseErrorTolerance,
      adaptive_reuse: adaptiveReuse,
      incremental_topology_repair: incrementalTopologyRepair,
      forecast_risk_scoring: forecastRiskScoring,
      topology_versioned_objective: topologyVersionedObjectiveEnabled,
      importance_aware_targets: importanceAwareTargetsEnabled,
      importance_metadata_only: importanceMetadataOnly,
      importance_path_scoring: importancePathScoringEnabled,
      importance_selective_metadata: importanceSelectiveMetadataEnabled,
      importance_budget_neutral_replacement: importanceBudgetNeutralReplacementEnabled,
      importance_strict_forward_only: importanceStrictForwardOnlyEnabled,
      scale_adaptive_total_budget: scaleAdaptiveTotalBudgetEnabled,
    },
    observability_mode: observabilityMode,
    feedback_lag_slices: feedbackLagSlices,
    causal_oam_boundary_enabled: feedbackLagSlices >= 1,
    hidden_stage1_metrics_available_to_planner: observabilityMode !== "oam-only",
    planner_dynamic_state_source: observabilityMode === "oam-only" ? "lagged-ground-oam-estimates" : "stage1-input",
  },
  parameters: {
    planner,
    topology_versioned_risk_weight: topologyVersionedRiskWeight,
    topology_versioned_redundancy_weight: topologyVersionedRedundancyWeight,
    topology_versioned_planning_cost_weight: topologyVersionedPlanningCostWeight,
    topology_versioned_information_gain_mode: topologyVersionedInformationGainMode,
    topology_versioned_metadata_actions: [...topologyVersionedMetadataActions],
    topology_versioned_allowed_modes: [...topologyVersionedAllowedModes],
    observability_mode: observabilityMode,
    feedback_lag_slices: feedbackLagSlices,
    sampling_rate: samplingRate,
    target_active_link_sampling_rate: targetActiveLinkSamplingRate,
    warmup_slices: warmupSlices,
    window_size: windowSize,
    rank,
    selection_strategy: selectionStrategy,
    min_paths_per_slice: minPaths,
    max_paths_per_slice: maxPaths,
    topology_class_threshold: topologyClassThreshold,
    adaptive_threshold_policy: "calibrated-tighten-on-drift-oam-risk-relax-on-stability-planning-pressure",
    adaptive_reuse_enabled: adaptiveReuse,
    incremental_topology_repair_enabled: incrementalTopologyRepair,
    forecast_risk_scoring_enabled: forecastRiskScoring,
    topology_versioned_objective_enabled: topologyVersionedObjectiveEnabled,
    topology_versioned_objective_weights: topologyVersionedObjectiveWeights,
    topology_versioned_confidence_threshold: topologyVersionedConfidenceThreshold,
    threshold_calibration_horizon_slices: thresholdCalibrationHorizon,
    prediction_score_horizon_slices: predictionScoreHorizon,
    cost_aware_sampling_enabled: costAwareSampling,
    cost_awareness_weight: costAwarenessWeight,
    telemetry_byte_budget_per_slice: telemetryByteBudgetPerSlice,
    scale_adaptive_total_budget_enabled: scaleAdaptiveTotalBudgetEnabled,
    scale_budget_headroom_ratio: scaleBudgetHeadroomRatio,
    scale_budget_path_headroom_ratio: scaleBudgetPathHeadroomRatio,
    hop_metadata_bytes: hopMetadataBytes,
    adaptive_metadata_profile_enabled: adaptiveMetadataProfileEnabled,
    compact_hop_metadata_bytes: compactHopMetadataBytes,
    multi_objective_budget_enabled: multiObjectiveBudgetEnabled,
    probe_packet_base_bytes: probePacketBaseBytes,
    report_header_bytes: reportHeaderBytes,
    hop_processing_j: hopProcessingJ,
    report_processing_j: reportProcessingJ,
    telemetry_tx_nj_per_byte: telemetryTxNjPerByte,
    reuse_overhead_pressure: reuseOverheadPressure,
    min_energy_percent: minEnergyPercent,
    energy_guard_threshold: energyGuardThreshold,
    energy_budget_enabled: energyBudgetEnabled,
    energy_budget_min_active_link_sampling_rate: energyBudgetMinActiveLinkSamplingRate,
    energy_budget_max_reduction: energyBudgetMaxReduction,
    adaptive_probe_budget_enabled: adaptiveProbeBudgetEnabled,
    oam_feedback_enabled: oamPriorityRetests.length > 0,
    oam_feedback_weight: oamFeedbackWeight,
    oam_priority_retest_targets: oamPriorityRetests.length,
    oam_replan_pressure_threshold: oamReplanPressureThreshold,
    oam_control_actions_enabled: oamControlActions.length > 0,
    oam_control_weight: oamControlWeight,
    oam_control_action_slices: oamControlBySlice.size,
    oam_control_replan_pressure_threshold: oamControlReplanPressureThreshold,
    importance_aware_targets_enabled: importanceAwareTargetsEnabled,
    importance_metadata_only: importanceMetadataOnly,
    importance_selective_metadata_enabled: importanceSelectiveMetadataEnabled,
    importance_path_scoring_enabled: importancePathScoringEnabled,
    importance_score_weight: importanceScoreWeight,
    importance_shadow_information_floor: importanceShadowInformationFloor,
    importance_aoi_shadow_information_floor: importanceAoIShadowInformationFloor,
    importance_aoi_debt_path_ratio: importanceAoIDebtPathRatio,
    importance_repair_byte_budget_ratio: importanceRepairByteBudgetRatio,
    importance_budget_neutral_replacement_enabled: importanceBudgetNeutralReplacementEnabled,
    importance_replacement_ratio: importanceReplacementRatio,
    importance_replacement_max_base_loss_ratio: importanceReplacementMaxBaseLossRatio,
    importance_strict_forward_only_enabled: importanceStrictForwardOnlyEnabled,
    importance_plane_representative_ratio: importancePlaneRepresentativeRatio,
    importance_node_target_ratio: importanceNodeTargetRatio,
    importance_link_target_ratio: importanceLinkTargetRatio,
    importance_max_aoi_slices: importanceMaxAoISlices,
    importance_exploration_ratio: importanceExplorationRatio,
    importance_window_size: importanceWindowSize,
    prediction_horizon_slices: predictedContactPlan?.engineering_parameters?.prediction_horizon_slices ?? null,
    refresh_slices: predictedContactPlan?.engineering_parameters?.refresh_slices ?? null,
    completion_window_slices: predictedContactPlan?.engineering_parameters?.completion_window_slices ?? null,
  },
  contact_plan: {
    source_schema_version: predictedContactPlan?.schema_version ?? "stage2-link-truth-derived-contact-plan-v1",
    slice_count: contactPlan.perSlice.length,
    topology_class_count: contactPlan.classes.length,
    classes: contactPlan.classes,
    prediction_evaluation: predictedContactPlan?.evaluation ?? null,
  },
  coverage: {
    candidate_paths: candidatePaths.length,
    incremental_delta_candidate_paths: incrementalDeltaCandidatePaths,
    causal_feedback_rows: causalFeedbackRows.length,
    causal_planner_state_rows: causalPlannerStateRows.length,
    causal_feedback_violations: causalFeedbackViolations,
    importance_rejected_noncausal_rows: importanceTargetPlan.summary.rejected_noncausal_rows,
    importance_target_count: importanceTargetPlan.summary.target_count,
    importance_node_target_count: importanceTargetPlan.summary.node_target_count,
    importance_link_target_count: importanceTargetPlan.summary.link_target_count,
    importance_mandatory_target_count: importanceTargetPlan.summary.mandatory_target_count,
    importance_path_scoring_enabled: importancePathScoringEnabled,
    importance_score_weight: importanceScoreWeight,
    importance_base_selected_paths: summaryRows.reduce((sum, row) => sum + numberValue(row.importance_base_selected_paths), 0),
    importance_budget_neutral_replacements: summaryRows.reduce(
      (sum, row) => sum + numberValue(row.importance_budget_neutral_replacements),
      0,
    ),
    importance_budget_neutral_path_count_violations: summaryRows.filter(
      (row) => row.importance_budget_neutral_path_count_preserved === false ||
        String(row.importance_budget_neutral_path_count_preserved).toLowerCase() === "false"
    ).length,
    importance_additive_repair_paths: summaryRows.reduce((sum, row) => sum + numberValue(row.importance_additive_repair_paths), 0),
    importance_additive_repair_byte_budget: round(summaryRows.reduce(
      (sum, row) => sum + numberValue(row.importance_additive_repair_byte_budget),
      0,
    )),
    importance_additive_repair_estimated_bytes: round(summaryRows.reduce(
      (sum, row) => sum + numberValue(row.importance_additive_repair_estimated_bytes),
      0,
    )),
    importance_path_covered_targets: summaryRows.reduce((sum, row) => sum + numberValue(row.importance_covered_targets), 0),
    importance_path_target_coverage: round(
      summaryRows.reduce((sum, row) => sum + numberValue(row.importance_covered_targets), 0) /
      Math.max(summaryRows.reduce((sum, row) => sum + numberValue(row.importance_targets), 0), 1),
    ),
    importance_metadata_bytes: round(importanceMetadataSummaryRows.reduce((sum, row) => sum + numberValue(row.metadata_bytes), 0)),
    importance_target_mask_bytes: round(importanceMetadataSummaryRows.reduce((sum, row) => sum + numberValue(row.target_mask_bytes), 0)),
    importance_saved_payload_bytes: round(importanceMetadataSummaryRows.reduce((sum, row) => sum + numberValue(row.saved_payload_bytes), 0)),
    importance_target_hits: importanceMetadataSummaryRows.reduce((sum, row) => sum + numberValue(row.target_hits), 0),
    importance_mandatory_target_hits: importanceMetadataSummaryRows.reduce((sum, row) => sum + numberValue(row.mandatory_target_hits), 0),
    importance_plane_representative_hops: importanceMetadataSummaryRows.reduce(
      (sum, row) => sum + numberValue(row.plane_representative_hops),
      0,
    ),
    importance_forward_only_hops: importanceMetadataSummaryRows.reduce(
      (sum, row) => sum + numberValue(row.forward_only_hops),
      0,
    ),
    importance_node_state_omitted_hops: importanceMetadataSummaryRows.reduce(
      (sum, row) => sum + numberValue(row.node_state_omitted_hops),
      0,
    ),
    selected_paths: selectedRows.length,
    unified_planner_enabled: topologyVersionedRiskPlannerEnabled,
    unified_reuse_slices: summaryRows.filter((row) => row.unified_planner_selected_mode === "reuse").length,
    unified_repair_slices: summaryRows.filter((row) => row.unified_planner_selected_mode === "repair").length,
    unified_fresh_slices: summaryRows.filter((row) => row.unified_planner_selected_mode === "fresh").length,
    unified_full_actions: summaryRows.reduce((sum, row) => sum + numberValue(row.unified_planner_full_actions), 0),
    unified_compact_actions: summaryRows.reduce((sum, row) => sum + numberValue(row.unified_planner_compact_actions), 0),
    unified_selective_actions: summaryRows.reduce((sum, row) => sum + numberValue(row.unified_planner_selective_actions), 0),
    unified_forward_only_hops: summaryRows.reduce((sum, row) => sum + numberValue(row.unified_planner_forward_only_hops), 0),
    unified_hard_budget_violations: summaryRows.reduce((sum, row) => sum + numberValue(row.unified_planner_budget_violations), 0),
    unified_mode_prefilter_reuse_slices: summaryRows.filter((row) => row.unified_mode_prefilter_selected_modes === "reuse").length,
    unified_mode_prefilter_repair_slices: summaryRows.filter((row) => row.unified_mode_prefilter_selected_modes === "repair").length,
    unified_mode_prefilter_fresh_slices: summaryRows.filter((row) => row.unified_mode_prefilter_selected_modes === "fresh").length,
    unified_mode_prefilter_ambiguous_slices: summaryRows.filter((row) => String(row.unified_mode_prefilter_selected_modes).includes(" > ")).length,
    unified_mode_prefilter_rejection_reason_counts: unifiedPrefilterRejectionReasonCounts,
    unified_cached_path_entries: summaryRows.reduce((sum, row) => sum + numberValue(row.unified_cached_path_count), 0),
    unified_affected_cached_path_entries: summaryRows.reduce((sum, row) => sum + numberValue(row.unified_affected_cached_path_count), 0),
    unified_inactive_cached_path_entries: summaryRows.reduce((sum, row) => sum + numberValue(row.unified_inactive_cached_path_count), 0),
    unified_retained_cached_path_entries: summaryRows.reduce((sum, row) => sum + numberValue(row.unified_retained_cached_path_count), 0),
    unified_adaptive_structural_cache_slices: summaryRows.filter(
      (row) => row.unified_structural_cache_adaptive_enabled === true,
    ).length,
    mean_unified_structural_cache_error_tolerance: round(mean(
      summaryRows.map((row) => numberValue(row.unified_structural_cache_error_tolerance, NaN)).filter(Number.isFinite),
    )),
    mean_unified_structural_cache_estimated_error_increase_proxy: round(mean(
      summaryRows
        .filter((row) => numberValue(row.unified_cached_path_count) > 0)
        .map((row) => numberValue(row.unified_structural_cache_estimated_error_increase_proxy, NaN))
        .filter(Number.isFinite),
    )),
    mean_unified_structural_cache_effective_similarity_threshold: round(mean(
      summaryRows
        .map((row) => numberValue(row.unified_structural_cache_effective_similarity_threshold, NaN))
        .filter(Number.isFinite),
    )),
    mean_unified_structural_cache_relaxation_factor: round(mean(
      summaryRows.map((row) => numberValue(row.unified_structural_cache_relaxation_factor, NaN)).filter(Number.isFinite),
    )),
    mean_unified_structural_cache_risk_pressure: round(mean(
      summaryRows.map((row) => numberValue(row.unified_structural_cache_risk_pressure, NaN)).filter(Number.isFinite),
    )),
    mean_unified_affected_cached_path_ratio: round(mean(
      summaryRows
        .filter((row) => numberValue(row.unified_cached_path_count) > 0)
        .map((row) => numberValue(row.unified_affected_cached_path_ratio)),
    )),
    unified_planner_marginal_evaluations: summaryRows.reduce((sum, row) => sum + numberValue(row.unified_planner_marginal_evaluations), 0),
    unified_planner_score_cache_hits: summaryRows.reduce((sum, row) => sum + numberValue(row.unified_planner_score_cache_hits), 0),
    unified_planner_score_cache_recomputations: summaryRows.reduce((sum, row) => sum + numberValue(row.unified_planner_score_cache_recomputations), 0),
    unified_stable_path_cache_hits: summaryRows.reduce((sum, row) => sum + numberValue(row.unified_stable_path_cache_hits), 0),
    unified_stable_path_cache_misses: summaryRows.reduce((sum, row) => sum + numberValue(row.unified_stable_path_cache_misses), 0),
    unified_repair_refill_paths: summaryRows.reduce((sum, row) => sum + numberValue(row.unified_repair_refill_paths), 0),
    mean_unified_plan_objective: round(mean(summaryRows.map((row) => numberValue(row.unified_planner_plan_objective, NaN)).filter(Number.isFinite))),
    mean_unified_information_gain: round(mean(summaryRows.map((row) => numberValue(row.unified_planner_information_gain, NaN)).filter(Number.isFinite))),
    mean_unified_risk_gain: round(mean(summaryRows.map((row) => numberValue(row.unified_planner_risk_gain, NaN)).filter(Number.isFinite))),
    sampling_mask_rows: samplingMaskRows.length,
    active_sampling_mask_rows: activeSamplingMaskRows.length,
    sampled_active_sampling_mask_rows: sampledActiveSamplingMaskRows.length,
    sampling_mask_density: round(sampledActiveSamplingMaskRows.length / Math.max(activeSamplingMaskRows.length, 1)),
    duplicate_sampling_observations: duplicateSamplingObservations,
    mean_probe_count_per_sampled_link: round(mean(sampledActiveSamplingMaskRows.map((row) => numberValue(row.selected_probe_count)))),
    active_link_samples: activeLinkSamples,
    sampled_active_link_samples: sampledActiveLinkSamples,
    active_link_sampling_coverage: round(sampledActiveLinkSamples / Math.max(activeLinkSamples, 1)),
    mean_selected_paths_per_slice: round(mean(summaryRows.map((row) => row.selected_paths))),
    repaired_candidate_paths: summaryRows.reduce((total, row) => total + numberValue(row.repaired_candidate_paths), 0),
    selected_repaired_paths: summaryRows.reduce((total, row) => total + numberValue(row.selected_repaired_paths), 0),
    reused_slice_plans: summaryRows.filter((row) => String(row.candidate_source).startsWith("topology-reuse-cache")).length,
    fresh_slice_plans: summaryRows.filter((row) => !String(row.candidate_source).startsWith("topology-reuse-cache")).length,
    estimated_full_replanning_avoided: summaryRows.filter((row) => String(row.candidate_source).startsWith("topology-reuse-cache")).length,
    planning_cache_hit_slices: summaryRows.filter((row) => row.planning_cache_hit === true).length,
    planning_cache_miss_slices: summaryRows.filter((row) => row.planning_cache_hit !== true).length,
    planning_local_repair_slices: summaryRows.filter((row) => row.planning_local_repair_applied === true).length,
    planning_oam_forced_replan_slices: summaryRows.filter((row) => row.planning_reuse_mode === "oam-forced-fresh-replan").length,
    estimated_full_replan_cost_units: round(fullPlanningCostUnits),
    estimated_actual_planning_cost_units: round(actualPlanningCostUnits),
    estimated_planning_cost_saved_units: round(savedPlanningCostUnits),
    estimated_planning_cost_saving_ratio: round(fullPlanningCostUnits > 0 ? savedPlanningCostUnits / fullPlanningCostUnits : 0),
    mean_planning_cost_saving_ratio: round(mean(summaryRows.map((row) => numberValue(row.planning_cost_saving_ratio)))),
    mean_topology_similarity_score: round(mean(summaryRows.map((row) => numberValue(row.topology_similarity_score)))),
    mean_topology_legacy_composite_similarity_score: round(mean(
      summaryRows.map((row) => numberValue(row.topology_legacy_composite_similarity_score)),
    )),
    mean_topology_dynamic_similarity_score: round(mean(
      summaryRows.map((row) => numberValue(row.topology_dynamic_similarity_score)),
    )),
    mean_route_path_jaccard: round(mean(summaryRows.map((row) => numberValue(row.route_path_jaccard)))),
    mean_link_state_similarity: round(mean(summaryRows.map((row) => numberValue(row.link_state_similarity)))),
    mean_topology_forecast_stable_window_slices: round(mean(summaryRows.map((row) => numberValue(row.topology_forecast_stable_window_slices, NaN)).filter(Number.isFinite))),
    mean_topology_forecast_drift_pressure: round(mean(summaryRows.map((row) => numberValue(row.topology_forecast_drift_pressure, NaN)).filter(Number.isFinite))),
    mean_topology_forecast_reuse_confidence: round(mean(summaryRows.map((row) => numberValue(row.topology_forecast_reuse_confidence, NaN)).filter(Number.isFinite))),
    topology_forecast_preemptive_replan_slices: summaryRows.filter((row) => row.topology_forecast_recommended_plan_mode === "preemptive-replan").length,
    topology_forecast_target_boosted_slices: summaryRows.filter((row) => numberValue(row.topology_forecast_target_sampling_boost) > 0).length,
    mean_adaptive_reuse_threshold: round(mean(summaryRows.map((row) => numberValue(row.adaptive_reuse_threshold)))),
    mean_adaptive_threshold_base: round(mean(summaryRows.map((row) => numberValue(row.adaptive_threshold_base)))),
    mean_adaptive_threshold_total_tightening: round(mean(summaryRows.map((row) => numberValue(row.adaptive_threshold_total_tightening)))),
    mean_adaptive_threshold_total_relaxation: round(mean(summaryRows.map((row) => numberValue(row.adaptive_threshold_total_relaxation)))),
    mean_adaptive_threshold_volatility_penalty: round(mean(summaryRows.map((row) => numberValue(row.adaptive_threshold_volatility_penalty)))),
    mean_adaptive_threshold_bottleneck_penalty: round(mean(summaryRows.map((row) => numberValue(row.adaptive_threshold_bottleneck_penalty)))),
    mean_adaptive_threshold_load_penalty: round(mean(summaryRows.map((row) => numberValue(row.adaptive_threshold_load_penalty)))),
    mean_adaptive_threshold_contact_uncertainty_penalty: round(mean(summaryRows.map((row) => numberValue(row.adaptive_threshold_contact_uncertainty_penalty)))),
    mean_adaptive_threshold_structural_drift_penalty: round(mean(summaryRows.map((row) => numberValue(row.adaptive_threshold_structural_drift_penalty)))),
    mean_adaptive_threshold_link_state_drift_penalty: round(mean(summaryRows.map((row) => numberValue(row.adaptive_threshold_link_state_drift_penalty)))),
    mean_adaptive_threshold_route_drift_penalty: round(mean(summaryRows.map((row) => numberValue(row.adaptive_threshold_route_drift_penalty)))),
    mean_adaptive_threshold_oam_pressure_penalty: round(mean(summaryRows.map((row) => numberValue(row.adaptive_threshold_oam_pressure_penalty)))),
    mean_adaptive_threshold_stability_credit: round(mean(summaryRows.map((row) => numberValue(row.adaptive_threshold_stability_credit)))),
    mean_adaptive_threshold_overhead_credit: round(mean(summaryRows.map((row) => numberValue(row.adaptive_threshold_overhead_credit)))),
    mean_adaptive_threshold_calibration_ambiguity_penalty: round(mean(summaryRows.map((row) => numberValue(row.adaptive_threshold_calibration_ambiguity_penalty)))),
    mean_adaptive_threshold_calibration_future_drift_penalty: round(mean(summaryRows.map((row) => numberValue(row.adaptive_threshold_calibration_future_drift_penalty)))),
    mean_adaptive_threshold_calibration_separation_credit: round(mean(summaryRows.map((row) => numberValue(row.adaptive_threshold_calibration_separation_credit)))),
    mean_adaptive_threshold_calibration_future_stability_credit: round(mean(summaryRows.map((row) => numberValue(row.adaptive_threshold_calibration_future_stability_credit)))),
    mean_adaptive_threshold_calibration_sample_support_credit: round(mean(summaryRows.map((row) => numberValue(row.adaptive_threshold_calibration_sample_support_credit)))),
    mean_adaptive_threshold_calibration_evidence_confidence: round(mean(summaryRows.map((row) => numberValue(row.adaptive_threshold_calibration_evidence_confidence)))),
    mean_adaptive_threshold_calibration_net_adjustment: round(mean(summaryRows.map((row) => numberValue(row.adaptive_threshold_calibration_net_adjustment)))),
    mean_adaptive_threshold_calibration_best_second_gap: round(mean(summaryRows.map((row) => numberValue(row.adaptive_threshold_calibration_best_second_gap)))),
    mean_adaptive_threshold_calibration_future_mean_similarity: round(mean(summaryRows.map((row) => numberValue(row.adaptive_threshold_calibration_future_mean_similarity)))),
    calibrated_threshold_slices: summaryRows.filter((row) => numberValue(row.adaptive_threshold_calibration_evidence_count) > 0).length,
    mean_topology_reuse_margin: round(mean(summaryRows.map((row) => numberValue(row.topology_reuse_margin)))),
    negative_reuse_margin_slices: summaryRows.filter((row) => numberValue(row.topology_reuse_margin) < 0).length,
    mean_energy_risk: round(mean(summaryRows.map((row) => numberValue(row.mean_energy_risk)))),
    mean_forecast_priority_score: round(mean(summaryRows.map((row) => numberValue(row.mean_forecast_priority_score)))),
    mean_forecast_transition_score: round(mean(summaryRows.map((row) => numberValue(row.mean_forecast_transition_score)))),
    mean_forecast_near_outage_score: round(mean(summaryRows.map((row) => numberValue(row.mean_forecast_near_outage_score)))),
    forecast_upcoming_outage_links: summaryRows.reduce((total, row) => total + numberValue(row.forecast_upcoming_outage_links), 0),
    forecast_upcoming_recovery_links: summaryRows.reduce((total, row) => total + numberValue(row.forecast_upcoming_recovery_links), 0),
    cost_aware_sampling_enabled: costAwareSampling,
    cost_awareness_weight: costAwarenessWeight,
    telemetry_byte_budget_per_slice: telemetryByteBudgetPerSlice,
    telemetry_budget_enabled_slices: summaryRows.filter((row) => row.telemetry_byte_budget_enabled === true).length,
    telemetry_budget_overrun_slices: summaryRows.filter((row) => numberValue(row.telemetry_budget_overrun_bytes) > 0).length,
    telemetry_budget_suppressed_paths: summaryRows.reduce((total, row) => total + numberValue(row.telemetry_budget_suppressed_paths), 0),
    telemetry_budget_override_paths: summaryRows.reduce((total, row) => total + numberValue(row.telemetry_budget_override_paths), 0),
    mean_telemetry_budget_utilization: round(mean(summaryRows.map((row) => numberValue(row.telemetry_budget_utilization)))),
    max_telemetry_budget_overrun_bytes: round(Math.max(0, ...summaryRows.map((row) => numberValue(row.telemetry_budget_overrun_bytes)))),
    estimated_metadata_bytes: round(summaryRows.reduce((total, row) => total + numberValue(row.estimated_metadata_bytes), 0)),
    estimated_report_bytes: round(summaryRows.reduce((total, row) => total + numberValue(row.estimated_report_bytes), 0)),
    estimated_probe_forward_bytes: round(summaryRows.reduce((total, row) => total + numberValue(row.estimated_probe_forward_bytes), 0)),
    estimated_generated_telemetry_bytes: round(summaryRows.reduce((total, row) => total + numberValue(row.estimated_generated_telemetry_bytes), 0)),
    estimated_total_telemetry_bytes: round(summaryRows.reduce((total, row) => total + numberValue(row.estimated_total_telemetry_bytes), 0)),
    estimated_total_telemetry_energy_j: round(summaryRows.reduce((total, row) => total + numberValue(row.estimated_total_telemetry_energy_j), 0)),
    adaptive_metadata_profile_enabled_slices: summaryRows.filter((row) => row.adaptive_metadata_profile_enabled === true).length,
    adaptive_metadata_compact_paths: summaryRows.reduce((total, row) => total + numberValue(row.adaptive_metadata_compact_paths), 0),
    adaptive_metadata_target_aware_paths: summaryRows.reduce((total, row) => total + numberValue(row.adaptive_metadata_target_aware_paths), 0),
    adaptive_metadata_standard_paths: summaryRows.reduce((total, row) => total + numberValue(row.adaptive_metadata_standard_paths), 0),
    adaptive_path_only_observation_paths: summaryRows.reduce((total, row) => total + numberValue(row.adaptive_path_only_observation_paths), 0),
    adaptive_target_neighborhood_observation_paths: summaryRows.reduce((total, row) => total + numberValue(row.adaptive_target_neighborhood_observation_paths), 0),
    adaptive_all_adjacent_observation_paths: summaryRows.reduce((total, row) => total + numberValue(row.adaptive_all_adjacent_observation_paths), 0),
    mean_effective_hop_metadata_bytes: round(mean(summaryRows.map((row) => numberValue(row.mean_effective_hop_metadata_bytes, NaN)).filter(Number.isFinite))),
    mean_metadata_compression_ratio: round(mean(summaryRows.map((row) => numberValue(row.mean_metadata_compression_ratio, NaN)).filter(Number.isFinite))),
    estimated_metadata_bytes_saved_by_profile: round(summaryRows.reduce((total, row) => total + numberValue(row.estimated_metadata_bytes_saved_by_profile), 0)),
    score_formula: topologyVersionedRiskPlannerEnabled
      ? "Score(a|S)=(information+risk_weight*risk-redundancy_weight*redundancy)/telemetry_bytes"
      : "Score(P)=marginal_information_gain(P|S)/telemetry_cost_kb(P)",
    mean_marginal_information_gain: round(mean(summaryRows.map((row) => numberValue(row.mean_marginal_information_gain, NaN)).filter(Number.isFinite))),
    mean_base_information_gain: round(mean(summaryRows.map((row) => numberValue(row.mean_base_information_gain, NaN)).filter(Number.isFinite))),
    mean_marginal_redundancy_penalty: round(mean(summaryRows.map((row) => numberValue(row.mean_marginal_redundancy_penalty, NaN)).filter(Number.isFinite))),
    mean_marginal_novelty_ratio: round(mean(summaryRows.map((row) => numberValue(row.mean_marginal_novelty_ratio, NaN)).filter(Number.isFinite))),
    mean_score_information_per_kb: round(mean(summaryRows.map((row) => numberValue(row.mean_score_information_per_kb, NaN)).filter(Number.isFinite))),
    mean_node_state_sampling_scale: round(mean(summaryRows.map((row) => numberValue(row.node_state_sampling_scale, NaN)).filter(Number.isFinite))),
    mean_node_state_information_gain: round(mean(summaryRows.map((row) => numberValue(row.mean_node_state_information_gain, NaN)).filter(Number.isFinite))),
    topology_versioned_objective_enabled: topologyVersionedObjectiveEnabled,
    mean_topology_versioned_objective: round(mean(summaryRows.map((row) => numberValue(row.mean_topology_versioned_objective, NaN)).filter(Number.isFinite))),
    mean_topology_versioned_objective_advantage: round(mean(summaryRows.map((row) => numberValue(row.mean_topology_versioned_objective_advantage, NaN)).filter(Number.isFinite))),
    mean_topology_versioned_node_information_gain: round(mean(summaryRows.map((row) => numberValue(row.mean_topology_versioned_node_information_gain, NaN)).filter(Number.isFinite))),
    mean_topology_versioned_node_redundancy_penalty: round(mean(summaryRows.map((row) => numberValue(row.mean_topology_versioned_node_redundancy_penalty, NaN)).filter(Number.isFinite))),
    mean_topology_versioned_expected_error_reduction: round(mean(summaryRows.map((row) => numberValue(row.mean_topology_versioned_expected_error_reduction, NaN)).filter(Number.isFinite))),
    mean_topology_versioned_expected_aoi_reduction: round(mean(summaryRows.map((row) => numberValue(row.mean_topology_versioned_expected_aoi_reduction, NaN)).filter(Number.isFinite))),
    mean_topology_versioned_evidence_confidence: round(mean(summaryRows.map((row) => numberValue(row.mean_topology_versioned_evidence_confidence, NaN)).filter(Number.isFinite))),
    mean_topology_versioned_path_topology_share: round(mean(summaryRows.map((row) => numberValue(row.mean_topology_versioned_path_topology_share, NaN)).filter(Number.isFinite))),
    mean_topology_versioned_structural_granularity_scale: round(mean(summaryRows.map((row) => numberValue(row.mean_topology_versioned_structural_granularity_scale, NaN)).filter(Number.isFinite))),
    mean_topology_versioned_score_adjustment: round(mean(summaryRows.map((row) => numberValue(row.mean_topology_versioned_score_adjustment, NaN)).filter(Number.isFinite))),
    topology_versioned_promoted_paths: summaryRows.reduce((total, row) => total + numberValue(row.topology_versioned_promoted_paths), 0),
    topology_versioned_demoted_paths: summaryRows.reduce((total, row) => total + numberValue(row.topology_versioned_demoted_paths), 0),
    topology_versioned_legacy_fallback_paths: summaryRows.reduce((total, row) => total + numberValue(row.topology_versioned_legacy_fallback_paths), 0),
    topology_versioned_shadow_guard_agree_paths: summaryRows.reduce((total, row) => total + numberValue(row.topology_versioned_shadow_guard_agree_paths), 0),
    topology_versioned_shadow_guard_admitted_paths: summaryRows.reduce((total, row) => total + numberValue(row.topology_versioned_shadow_guard_admitted_paths), 0),
    topology_versioned_shadow_guard_node_fallbacks: summaryRows.reduce((total, row) => total + numberValue(row.topology_versioned_shadow_guard_node_fallbacks), 0),
    topology_versioned_shadow_guard_byte_fallbacks: summaryRows.reduce((total, row) => total + numberValue(row.topology_versioned_shadow_guard_byte_fallbacks), 0),
    topology_versioned_shadow_guard_information_fallbacks: summaryRows.reduce((total, row) => total + numberValue(row.topology_versioned_shadow_guard_information_fallbacks), 0),
    mean_cost_aware_score: round(mean(summaryRows.map((row) => numberValue(row.mean_cost_aware_score)))),
    mean_cost_aware_value_per_kb: round(mean(summaryRows.map((row) => numberValue(row.mean_cost_aware_value_per_kb)))),
    mean_estimated_total_telemetry_bytes_per_path: round(mean(summaryRows.map((row) => numberValue(row.mean_estimated_total_telemetry_bytes_per_path)))),
    mean_solar_exposure: round(mean(summaryRows.map((row) => numberValue(row.mean_solar_exposure, NaN)).filter(Number.isFinite))),
    mean_power_margin_w: round(mean(summaryRows.map((row) => numberValue(row.mean_power_margin_w, NaN)).filter(Number.isFinite))),
    mean_effective_sampling_rate: round(mean(summaryRows.map((row) => numberValue(row.effective_sampling_rate)))),
    mean_effective_target_active_link_sampling_rate: round(mean(summaryRows.map((row) => numberValue(row.effective_target_active_link_sampling_rate)))),
    adaptive_probe_budget_enabled_slices: summaryRows.filter((row) => row.adaptive_probe_budget_enabled === true).length,
    adaptive_probe_budget_applied_slices: summaryRows.filter((row) => row.adaptive_probe_budget_applied === true).length,
    adaptive_probe_budget_throttled_slices: summaryRows.filter((row) => numberValue(row.adaptive_probe_budget_scale, 1) < 0.999).length,
    adaptive_probe_budget_escalated_slices: summaryRows.filter((row) => numberValue(row.adaptive_probe_budget_scale, 1) > 1.001).length,
    adaptive_probe_budget_path_cap_throttled_slices: summaryRows.filter((row) =>
      numberValue(row.adaptive_probe_budget_effective_max_paths_per_slice, Infinity) < numberValue(row.configured_max_paths_per_slice, -Infinity)
    ).length,
    adaptive_probe_budget_path_cap_escalated_slices: summaryRows.filter((row) =>
      numberValue(row.adaptive_probe_budget_effective_max_paths_per_slice, -Infinity) > numberValue(row.configured_max_paths_per_slice, Infinity)
    ).length,
    mean_adaptive_probe_budget_scale: round(mean(summaryRows.map((row) => numberValue(row.adaptive_probe_budget_scale, 1)))),
    mean_adaptive_probe_budget_sampling_rate: round(mean(summaryRows.map((row) => numberValue(row.adaptive_probe_budget_sampling_rate, NaN)).filter(Number.isFinite))),
    mean_adaptive_probe_budget_target_active_link_sampling_rate: round(mean(summaryRows.map((row) => numberValue(row.adaptive_probe_budget_target_active_link_sampling_rate, NaN)).filter(Number.isFinite))),
    mean_adaptive_probe_budget_effective_max_paths_per_slice: round(mean(summaryRows.map((row) => numberValue(row.adaptive_probe_budget_effective_max_paths_per_slice, NaN)).filter(Number.isFinite))),
    mean_adaptive_probe_budget_oam_pressure: round(mean(summaryRows.map((row) => numberValue(row.adaptive_probe_budget_oam_pressure, NaN)).filter(Number.isFinite))),
    mean_adaptive_probe_budget_slice_traffic_risk: round(mean(summaryRows.map((row) => numberValue(row.adaptive_probe_budget_slice_traffic_risk, NaN)).filter(Number.isFinite))),
    multi_objective_budget_enabled_slices: summaryRows.filter((row) => row.multi_objective_budget_enabled === true).length,
    multi_objective_cost_pressure_slices: summaryRows.filter((row) => numberValue(row.multi_objective_cost_reduction_pressure) >= 0.35).length,
    multi_objective_quality_guard_slices: summaryRows.filter((row) => numberValue(row.multi_objective_quality_guard_pressure) >= 0.55).length,
    mean_multi_objective_quality_guard_pressure: round(mean(summaryRows.map((row) => numberValue(row.multi_objective_quality_guard_pressure, NaN)).filter(Number.isFinite))),
    mean_multi_objective_cost_reduction_pressure: round(mean(summaryRows.map((row) => numberValue(row.multi_objective_cost_reduction_pressure, NaN)).filter(Number.isFinite))),
    mean_multi_objective_path_budget_scale: round(mean(summaryRows.map((row) => numberValue(row.multi_objective_path_budget_scale, NaN)).filter(Number.isFinite))),
    mean_multi_objective_metadata_floor_ratio: round(mean(summaryRows.map((row) => numberValue(row.multi_objective_metadata_floor_ratio, NaN)).filter(Number.isFinite))),
    mean_multi_objective_score: round(mean(summaryRows.map((row) => numberValue(row.mean_multi_objective_score, NaN)).filter(Number.isFinite))),
    mean_multi_objective_quality_bonus: round(mean(summaryRows.map((row) => numberValue(row.mean_multi_objective_quality_bonus, NaN)).filter(Number.isFinite))),
    mean_multi_objective_cost_penalty: round(mean(summaryRows.map((row) => numberValue(row.mean_multi_objective_cost_penalty, NaN)).filter(Number.isFinite))),
    mean_adaptive_probe_budget_reuse_confidence: round(mean(summaryRows.map((row) => numberValue(row.adaptive_probe_budget_reuse_confidence, NaN)).filter(Number.isFinite))),
    mean_adaptive_probe_budget_reuse_margin: round(mean(summaryRows.map((row) => numberValue(row.adaptive_probe_budget_reuse_margin, NaN)).filter(Number.isFinite))),
    local_adaptive_high_risk_paths: summaryRows.reduce((total, row) => total + numberValue(row.local_adaptive_high_risk_paths), 0),
    local_adaptive_watchlist_paths: summaryRows.reduce((total, row) => total + numberValue(row.local_adaptive_watchlist_paths), 0),
    local_adaptive_low_risk_sparse_paths: summaryRows.reduce((total, row) => total + numberValue(row.local_adaptive_low_risk_sparse_paths), 0),
    reuse_duplicate_suppressed_paths: summaryRows.reduce((total, row) => total + numberValue(row.reuse_duplicate_suppressed_paths), 0),
    oam_duplicate_target_only_suppressed_paths: summaryRows.reduce((total, row) => total + numberValue(row.oam_duplicate_target_only_suppressed_paths), 0),
    unique_mandatory_oam_targets_covered: summaryRows.reduce((total, row) => total + numberValue(row.unique_mandatory_oam_targets_covered), 0),
    mean_local_adaptive_sampling_risk: round(mean(summaryRows.map((row) => numberValue(row.mean_local_adaptive_sampling_risk, NaN)).filter(Number.isFinite))),
    max_local_adaptive_sampling_risk: round(Math.max(0, ...summaryRows.map((row) => numberValue(row.max_local_adaptive_sampling_risk, 0)))),
    mean_energy_budget_scale: round(mean(summaryRows.map((row) => numberValue(row.energy_budget_scale)))),
    mean_energy_budget_pressure: round(mean(summaryRows.map((row) => numberValue(row.energy_budget_pressure)))),
    mean_energy_budget_critical_coverage_credit: round(mean(summaryRows.map((row) => numberValue(row.energy_budget_critical_coverage_credit)))),
    energy_budget_throttled_slices: summaryRows.filter((row) => numberValue(row.energy_budget_scale) < 0.999).length,
    energy_budget_suppressed_paths: summaryRows.reduce((total, row) => total + numberValue(row.energy_budget_suppressed_paths), 0),
    energy_budget_deferred_active_links: summaryRows.reduce((total, row) => total + numberValue(row.energy_budget_deferred_active_links), 0),
    mean_energy_budget_shadow_node_ratio: round(mean(summaryRows.map((row) => numberValue(row.energy_budget_shadow_node_ratio)))),
    mean_energy_budget_low_energy_node_ratio: round(mean(summaryRows.map((row) => numberValue(row.energy_budget_low_energy_node_ratio)))),
    mean_energy_budget_low_solar_node_ratio: round(mean(summaryRows.map((row) => numberValue(row.energy_budget_low_solar_node_ratio)))),
    mean_energy_budget_power_deficit_pressure: round(mean(summaryRows.map((row) => numberValue(row.energy_budget_power_deficit_pressure)))),
    energy_guard_suppressed_paths: summaryRows.reduce((total, row) => total + numberValue(row.energy_guard_suppressed_paths), 0),
    selected_high_energy_paths: summaryRows.reduce((total, row) => total + numberValue(row.selected_high_energy_paths), 0),
    low_energy_node_hits: summaryRows.reduce((total, row) => total + numberValue(row.low_energy_node_hits), 0),
    shadow_node_hits: summaryRows.reduce((total, row) => total + numberValue(row.shadow_node_hits), 0),
    oam_feedback_targets: oamPriorityRetests.length,
    oam_feedback_slices: oamFeedbackBySlice.size,
    oam_feedback_selected_paths: summaryRows.reduce((total, row) => total + numberValue(row.oam_feedback_selected_paths), 0),
    oam_feedback_target_hits: summaryRows.reduce((total, row) => total + numberValue(row.oam_feedback_target_hits), 0),
    oam_feedback_score_sum: round(summaryRows.reduce((total, row) => total + numberValue(row.oam_feedback_score_sum), 0)),
    oam_mandatory_coverage_selected_paths: summaryRows.reduce((total, row) => total + numberValue(row.oam_mandatory_coverage_selected_paths), 0),
    oam_mandatory_coverage_target_hits: summaryRows.reduce((total, row) => total + numberValue(row.oam_mandatory_coverage_target_hits), 0),
    oam_mandatory_coverage_broke_reuse_slices: summaryRows.filter((row) => row.oam_mandatory_coverage_broke_reuse === true).length,
    oam_replan_triggered_slices: summaryRows.filter((row) => row.oam_replan_triggered === true).length,
    mean_oam_replan_pressure: round(mean(summaryRows.map((row) => numberValue(row.oam_replan_pressure)))),
    max_oam_replan_pressure: round(Math.max(0, ...summaryRows.map((row) => numberValue(row.oam_replan_pressure)))),
    oam_replan_targets: summaryRows.reduce((total, row) => total + numberValue(row.oam_replan_targets), 0),
    oam_replan_urgent_targets: summaryRows.reduce((total, row) => total + numberValue(row.oam_replan_urgent_targets), 0),
    oam_control_action_slices: oamControlBySlice.size,
    oam_control_next_slice_applied_slices: summaryRows.filter((row) => row.oam_control_next_slice_applied === true).length,
    oam_control_selected_paths: summaryRows.reduce((total, row) => total + numberValue(row.oam_control_selected_paths), 0),
    oam_control_target_hits: summaryRows.reduce((total, row) => total + numberValue(row.oam_control_target_hits), 0),
    oam_control_score_sum: round(summaryRows.reduce((total, row) => total + numberValue(row.oam_control_score_sum), 0)),
    oam_control_replan_triggered_slices: summaryRows.filter((row) => row.oam_control_replan_triggered === true).length,
    mean_oam_control_pressure: round(mean(summaryRows.map((row) => numberValue(row.oam_control_pressure)))),
    max_oam_control_pressure: round(Math.max(0, ...summaryRows.map((row) => numberValue(row.oam_control_pressure)))),
    oam_control_priority_retest_targets: summaryRows.reduce((total, row) => total + numberValue(row.oam_control_priority_retest_targets), 0),
    oam_budget_applied_slices: summaryRows.filter((row) => row.oam_budget_applied === true).length,
    mean_oam_coverage_demand_pressure: round(mean(summaryRows.map((row) => numberValue(row.oam_coverage_demand_pressure, NaN)).filter(Number.isFinite))),
    mean_oam_recommended_sampling_rate: round(mean(summaryRows.map((row) => numberValue(row.oam_recommended_sampling_rate, NaN)).filter(Number.isFinite))),
    mean_oam_recommended_target_active_link_sampling_rate: round(mean(summaryRows.map((row) => numberValue(row.oam_recommended_target_active_link_sampling_rate, NaN)).filter(Number.isFinite))),
    mean_oam_recommended_telemetry_byte_budget_per_slice: round(mean(summaryRows.map((row) => numberValue(row.oam_recommended_telemetry_byte_budget_per_slice, NaN)).filter(Number.isFinite))),
    mean_oam_recommended_downlink_budget_bytes: round(mean(summaryRows.map((row) => numberValue(row.oam_recommended_downlink_budget_bytes, NaN)).filter(Number.isFinite))),
  },
  per_slice: summaryRows,
};

await mkdir(outputDir, { recursive: true });
await Promise.all([
  writeFile(join(outputDir, `probe-paths-${algorithm}.csv`), rowsToCsv(selectedRows), "utf8"),
  writeFile(join(outputDir, `probe-summary-${algorithm}.csv`), rowsToCsv(summaryRows), "utf8"),
  writeFile(join(outputDir, `probe-sampling-mask-${algorithm}.csv`), rowsToCsv(samplingMaskRows), "utf8"),
  writeFile(join(outputDir, `probe-coverage-${algorithm}.json`), JSON.stringify(report, null, 2), "utf8"),
  writeFile(join(outputDir, `int-mc-contact-plan-${algorithm}.json`), JSON.stringify(contactPlan, null, 2), "utf8"),
  writeFile(join(outputDir, `importance-target-plan-${algorithm}.csv`), rowsToCsv(importanceTargetPlan.rows), "utf8"),
  writeFile(join(outputDir, `importance-target-plan-${algorithm}.json`), JSON.stringify({
    schema_version: "stage2-importance-target-plan-v1",
    generated_at: new Date().toISOString(),
    enabled: importanceAwareTargetsEnabled,
    summary: importanceTargetPlan.summary,
    per_slice_metadata: importanceMetadataSummaryRows,
    targets: importanceTargetPlan.rows,
  }, null, 2), "utf8"),
]);

console.log(JSON.stringify({
  ok: true,
  outputDir,
  algorithm,
  candidateAlgorithm,
  slices: contactPlan.perSlice.length,
  topologyClasses: contactPlan.classes.length,
  candidatePaths: candidatePaths.length,
  selectedPaths: selectedRows.length,
  importanceAwareTargetsEnabled,
  importanceTargets: importanceTargetPlan.rows.length,
  importanceSavedPayloadBytes: report.coverage.importance_saved_payload_bytes,
  samplingMaskRows: samplingMaskRows.length,
  samplingMaskDensity: report.coverage.sampling_mask_density,
  duplicateSamplingObservations: report.coverage.duplicate_sampling_observations,
  activeLinkSamplingCoverage: report.coverage.active_link_sampling_coverage,
  planningCacheHitSlices: report.coverage.planning_cache_hit_slices,
  estimatedPlanningCostSavingRatio: report.coverage.estimated_planning_cost_saving_ratio,
  estimatedPlanningCostSavedUnits: report.coverage.estimated_planning_cost_saved_units,
  calibratedThresholdSlices: report.coverage.calibrated_threshold_slices,
  meanAdaptiveThresholdCalibrationNetAdjustment: report.coverage.mean_adaptive_threshold_calibration_net_adjustment,
  meanAdaptiveThresholdCalibrationEvidenceConfidence: report.coverage.mean_adaptive_threshold_calibration_evidence_confidence,
  meanTopologyForecastDriftPressure: report.coverage.mean_topology_forecast_drift_pressure,
  topologyForecastTargetBoostedSlices: report.coverage.topology_forecast_target_boosted_slices,
  energyGuardSuppressedPaths: report.coverage.energy_guard_suppressed_paths,
  energyBudgetThrottledSlices: report.coverage.energy_budget_throttled_slices,
  meanEnergyBudgetPressure: report.coverage.mean_energy_budget_pressure,
  adaptiveProbeBudgetEnabledSlices: report.coverage.adaptive_probe_budget_enabled_slices,
  adaptiveProbeBudgetThrottledSlices: report.coverage.adaptive_probe_budget_throttled_slices,
  adaptiveProbeBudgetEscalatedSlices: report.coverage.adaptive_probe_budget_escalated_slices,
  adaptiveProbeBudgetPathCapThrottledSlices: report.coverage.adaptive_probe_budget_path_cap_throttled_slices,
  meanAdaptiveProbeBudgetScale: report.coverage.mean_adaptive_probe_budget_scale,
  meanAdaptiveProbeBudgetEffectiveMaxPathsPerSlice: report.coverage.mean_adaptive_probe_budget_effective_max_paths_per_slice,
  localAdaptiveHighRiskPaths: report.coverage.local_adaptive_high_risk_paths,
  localAdaptiveLowRiskSparsePaths: report.coverage.local_adaptive_low_risk_sparse_paths,
  maxLocalAdaptiveSamplingRisk: report.coverage.max_local_adaptive_sampling_risk,
  meanEffectiveTargetActiveLinkSamplingRate: report.coverage.mean_effective_target_active_link_sampling_rate,
  meanForecastPriorityScore: report.coverage.mean_forecast_priority_score,
  meanForecastTransitionScore: report.coverage.mean_forecast_transition_score,
  forecastUpcomingOutageLinks: report.coverage.forecast_upcoming_outage_links,
  estimatedTotalTelemetryBytes: report.coverage.estimated_total_telemetry_bytes,
  meanCostAwareValuePerKb: report.coverage.mean_cost_aware_value_per_kb,
  telemetryBudgetSuppressedPaths: report.coverage.telemetry_budget_suppressed_paths,
  telemetryBudgetOverridePaths: report.coverage.telemetry_budget_override_paths,
  selectedHighEnergyPaths: report.coverage.selected_high_energy_paths,
  oamFeedbackTargets: report.coverage.oam_feedback_targets,
  oamFeedbackSelectedPaths: report.coverage.oam_feedback_selected_paths,
  oamMandatoryCoverageSelectedPaths: report.coverage.oam_mandatory_coverage_selected_paths,
  oamMandatoryCoverageBrokeReuseSlices: report.coverage.oam_mandatory_coverage_broke_reuse_slices,
  oamReplanTriggeredSlices: report.coverage.oam_replan_triggered_slices,
  meanOamReplanPressure: report.coverage.mean_oam_replan_pressure,
  oamControlActionSlices: report.coverage.oam_control_action_slices,
  oamControlSelectedPaths: report.coverage.oam_control_selected_paths,
  oamControlReplanTriggeredSlices: report.coverage.oam_control_replan_triggered_slices,
  meanOamControlPressure: report.coverage.mean_oam_control_pressure,
  oamBudgetAppliedSlices: report.coverage.oam_budget_applied_slices,
  meanOamCoverageDemandPressure: report.coverage.mean_oam_coverage_demand_pressure,
  meanOamRecommendedSamplingRate: report.coverage.mean_oam_recommended_sampling_rate,
  meanSolarExposure: report.coverage.mean_solar_exposure,
  meanPowerMarginW: report.coverage.mean_power_margin_w,
  samplingRate,
  selectionStrategy,
  energyGuardThreshold,
  energyBudgetEnabled,
  adaptiveProbeBudgetEnabled,
  energyBudgetMinActiveLinkSamplingRate,
  energyBudgetMaxReduction,
  predictionScoreHorizon,
  costAwareSampling,
  costAwarenessWeight,
  telemetryByteBudgetPerSlice,
  oamReplanPressureThreshold,
  rank,
  windowSize,
}, null, 2));
