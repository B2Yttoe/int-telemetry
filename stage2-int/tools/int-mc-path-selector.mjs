import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
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
  const score =
    0.27 * active +
    0.13 * interPlane +
    0.1 * bottleneck +
    0.12 * routePath +
    0.18 * linkState +
    0.08 * utilization +
    0.06 * latency +
    0.06 * availability;
  return {
    score: round(score, 5),
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
    .map((item) => item.similarity.score)
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
    .map((futureProfile) => topologySimilarity(profile, futureProfile).score)
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
    .map((futureProfile) => topologySimilarity(profile, futureProfile).score)
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
      bottleneckPenalty +
      loadPenalty +
      contactUncertaintyPenalty +
      structuralDriftPenalty +
      linkStateDriftPenalty +
      routeDriftPenalty +
      oamPressurePenalty -
      stabilityCredit -
      overheadCredit +
      thresholdCalibration.net_adjustment,
    0.72,
    0.98,
  );
  const reasons = [
    volatilityPenalty > 0.005 ? "tighten-volatility" : "",
    bottleneckPenalty > 0.005 ? "tighten-bottleneck" : "",
    loadPenalty > 0.005 ? "tighten-load" : "",
    contactUncertaintyPenalty > 0.005 ? "tighten-contact-uncertainty" : "",
    structuralDriftPenalty > 0.005 ? "tighten-structural-drift" : "",
    linkStateDriftPenalty > 0.005 ? "tighten-link-state-drift" : "",
    routeDriftPenalty > 0.005 ? "tighten-route-drift" : "",
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
        bottleneckPenalty +
        loadPenalty +
        contactUncertaintyPenalty +
        structuralDriftPenalty +
        linkStateDriftPenalty +
        routeDriftPenalty +
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
    policy: "calibrated-tighten-on-drift-oam-risk-relax-on-stability-planning-pressure",
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
    const sliceIndex = String(row.slice_index ?? "");
    if (!sliceIndex) return;
    map.set(sliceIndex, {
      slice_index: numberValue(row.slice_index),
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
  const adjustedSamplingRate = hasSamplingRecommendation
    ? clamp(recommendedSamplingRate, 0.01, 1)
    : samplingRate;
  const adjustedTargetRate = hasTargetRecommendation
    ? clamp(recommendedTargetRate, adjustedSamplingRate, 1)
    : targetActiveLinkSamplingRate;
  const adjustedTelemetryBudget = hasTelemetryBudgetRecommendation
    ? Math.max(0, recommendedTelemetryBudget)
    : telemetryByteBudgetPerSlice;
  const applied = hasSamplingRecommendation || hasTargetRecommendation || hasTelemetryBudgetRecommendation;
  return {
    oam_budget_applied: applied,
    oam_budget_policy: applied ? "ground-oam-adaptive-budget" : "disabled",
    oam_budget_reason: applied
      ? oamControl.budget_recommendation_reason || oamControl.budget_recommendation_action || "ground-oam-control-action"
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
  };
}

function planningReuseMode(candidateSource, topologyReuseDecision) {
  if (candidateSource === "topology-reuse-cache") return "cache-reuse-with-validation";
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
    ? reuseValidationCost + repairCost + oamFeedbackCost
    : fullReplanCost + fallbackPenalty;
  const savedCost = Math.max(0, fullReplanCost - actualCost);
  const savingRatio = fullReplanCost > 0 ? savedCost / fullReplanCost : 0;

  return {
    planning_reuse_mode: mode,
    planning_cache_hit: mode === "cache-reuse-with-validation",
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
    scoredClasses.sort((left, right) => right.similarity.score - left.similarity.score);
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
    const reusableByTopology = bestClass && bestClass.similarity.score >= adaptiveThreshold;
    const oamFeedbackReplanTriggered = adaptiveReuse &&
      oamFeedbackPressure.pressure >= oamReplanPressureThreshold &&
      Boolean(reusableByTopology);
    const oamControlReplanTriggered = adaptiveReuse &&
      Boolean(reusableByTopology) &&
      (oamControl.recommended_action === "refresh-probe-plan" ||
        oamControl.oam_control_pressure >= oamControlReplanPressureThreshold);
    const oamReplanTriggered = oamFeedbackReplanTriggered || oamControlReplanTriggered;
    let contactClass = reusableByTopology ? bestClass.item : null;
    if (contactClass && oamReplanTriggered) contactClass = null;
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
      previousAcceptedSimilarity = bestClass.similarity.score;
    }
    contactClass.slices.push(Number(sliceIndex));
    perSlice.push({
      slice_index: Number(sliceIndex),
      time: links[0]?.time ?? "",
      topology_class_id: contactClass.class_id,
      topology_reused_from_class: reused,
      topology_reuse_decision: oamReplanTriggered
        ? oamControlReplanTriggered
          ? "oam-control-refresh-replan"
          : "oam-feedback-refresh-replan"
        : reused
          ? "reuse-probe-plan-with-local-repair"
          : "replan-new-topology-class",
      topology_similarity_score: bestClass?.similarity.score ?? 1,
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
      topology_reuse_margin: round((bestClass?.similarity.score ?? 1) - adaptiveThreshold, 5),
      ...topologyForecast,
      oam_feedback_pressure: oamFeedbackPressure.pressure,
      oam_replan_pressure: oamPressure.pressure,
      oam_replan_targets: oamPressure.target_count,
      oam_replan_urgent_targets: oamPressure.urgent_targets,
      oam_replan_mean_priority_score: oamPressure.mean_priority_score,
      oam_replan_max_priority_score: oamPressure.max_priority_score,
      oam_replan_pressure_threshold: oamReplanPressureThreshold,
      oam_replan_triggered: oamReplanTriggered,
      oam_control_action: oamControl.recommended_action,
      oam_control_probe_bias: oamControl.probe_bias,
      oam_control_confidence_budget: oamControl.confidence_budget,
      oam_control_pressure: oamControl.oam_control_pressure,
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
  const latencyValues = [];
  const distanceValues = [];
  const capacityValues = [];

  linkIds.forEach((linkId) => {
    const bySlice = linksById.get(linkId);
    sliceIndexes.forEach((sliceIndex) => {
      const link = bySlice.get(sliceIndex);
      if (!link || !planningActive(link)) return;
      latencyValues.push(numberValue(link.latency_ms));
      distanceValues.push(numberValue(link.distance_km));
      capacityValues.push(numberValue(link.effective_capacity_mbps || link.capacity_mbps));
    });
  });

  const latencyNorm = normalizeVector(latencyValues);
  const distanceNorm = normalizeVector(distanceValues);
  const capacityNorm = normalizeVector(capacityValues);
  let cursor = 0;
  const rows = [];
  const transitionRate = new Map();

  linkIds.forEach((linkId) => {
    const bySlice = linksById.get(linkId);
    const values = [];
    let previousActive = null;
    let transitions = 0;
    sliceIndexes.forEach((sliceIndex) => {
      const link = bySlice.get(sliceIndex);
      const active = link ? planningActive(link) : false;
      if (previousActive !== null && previousActive !== active) transitions += 1;
      previousActive = active;
      if (!active) {
        values.push(0);
        return;
      }
      const value =
        1 +
        0.2 * (latencyNorm[cursor] ?? 0) +
        0.15 * (distanceNorm[cursor] ?? 0) -
        0.1 * (capacityNorm[cursor] ?? 0);
      cursor += 1;
      values.push(value);
    });
    transitionRate.set(linkId, transitions / Math.max(sliceIndexes.length - 1, 1));
    rows.push(values);
  });

  const columns = sliceIndexes.length;
  const covariance = Array.from({ length: columns }, () => Array.from({ length: columns }, () => 0));
  rows.forEach((row) => {
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
  const rawScores = rows.map((row) => {
    if (components.length === 0) return 1;
    return components.reduce((total, component) => {
      const projection = dot(row, component.vector);
      return total + (projection * projection) / Math.max(component.eigenvalue, 1e-8);
    }, 0);
  });
  const avgScore = mean(rawScores) || 1;
  rawScores.forEach((score, index) => {
    const linkId = linkIds[index];
    scores.set(linkId, {
      leverage: Math.max(0.05, score / avgScore),
      transition_rate: transitionRate.get(linkId) ?? 0,
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
  probePacketBaseBytes,
  reportHeaderBytes,
  hopProcessingJ,
  reportProcessingJ,
  telemetryTxNjPerByte,
}) {
  const hopCount = Math.max(pathNodes.length, pathLinks.length + 1, 1);
  const metadataBytes = hopCount * hopMetadataBytes;
  const reportBytes = reportHeaderBytes + metadataBytes;
  const generatedBytes = metadataBytes + reportBytes + probePacketBaseBytes;
  const probeForwardBytes = pathLinks.reduce(
    (total, _linkId, index) => total + probePacketBaseBytes + (index + 1) * hopMetadataBytes,
    0,
  );
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

function costAwarePathScore({ score, cost, forecastProfile, diversity, oamFeedback, oamControl, weight }) {
  const totalKb = Math.max(numberValue(cost.estimated_total_telemetry_bytes) / 1024, 0.1);
  const positiveValue =
    Math.max(score, 0) +
    diversity * 0.4 +
    numberValue(forecastProfile.forecast_priority_score) * 0.45 +
    numberValue(forecastProfile.forecast_near_outage_score) * 0.25 +
    numberValue(oamFeedback.score) * 0.2 +
    numberValue(oamControl.score) * 0.18;
  const valuePerKb = positiveValue / totalKb;
  const costPenalty = clamp(totalKb / 24, 0, 1.2) * weight;
  const efficiencyBonus = clamp(valuePerKb / 4, 0, 0.35) * weight;
  return {
    cost_aware_score: round(score - costPenalty + efficiencyBonus),
    value_per_kb: round(valuePerKb),
    cost_penalty: round(costPenalty),
    efficiency_bonus: round(efficiencyBonus),
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
  const requestedPaths = Math.max(minPaths, Math.ceil(candidatePathCount * effectiveSamplingRate));
  const targetCoveredLinks = activeLinkCount > 0 ? Math.ceil(activeLinkCount * effectiveTargetRate) : 0;
  const selectedLimit = Math.max(
    requestedPaths,
    Math.min(baseSelectedLimit, Math.ceil(baseSelectedLimit * Math.max(scale, minSamplingRate))),
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

function repairCandidatePath({ path, activeSet, graph, linksBySliceAndId }) {
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

  const repaired = shortestPath(graph, source, sink);
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
    splitPath(row.link_ids).forEach((linkId) => {
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
      reason: row.reason ?? "",
      observation_source: row.observation_source ?? "",
    };
    old.priority_score = Math.max(old.priority_score, score);
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
      target_ids: "",
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
  const rawScore = hits.reduce((total, item) => total + numberValue(item.priority_score), 0);
  return {
    score: round(rawScore),
    target_count: hits.length,
    link_target_count: linkHits.length,
    node_target_count: nodeHits.length,
    target_ids: unique(hits.map((item) => item.target_id)).join(" > "),
    reasons: unique(hits.map((item) => item.reason)).join(" > "),
  };
}

function oamControlForPath({ sliceIndex, pathLinks, pathNodes, oamControlBySlice }) {
  const control = oamControlForSlice(oamControlBySlice, sliceIndex);
  const targetLinks = new Set(splitPath(control.top_link_targets));
  const targetNodes = new Set(splitPath(control.top_node_targets));
  const linkHits = pathLinks.filter((linkId) => targetLinks.has(linkId));
  const nodeHits = pathNodes.filter((nodeId) => targetNodes.has(nodeId));
  const hitCount = linkHits.length + nodeHits.length;
  const actionBoost = control.recommended_action === "refresh-probe-plan"
    ? 0.35
    : control.recommended_action === "schedule-priority-retest"
      ? 0.22
      : 0;
  const biasBoost = control.probe_bias === "bias-paths-to-oam-targets" ? 0.18 : 0;
  const targetHitBoost = hitCount > 0 ? Math.min(0.45, hitCount * 0.12) : 0;
  const score = control.oam_control_pressure * 0.65 + actionBoost + biasBoost + targetHitBoost;
  return {
    score: round(score),
    pressure: control.oam_control_pressure,
    action: control.recommended_action,
    probe_bias: control.probe_bias,
    confidence_budget: control.confidence_budget,
    target_count: hitCount,
    link_target_count: linkHits.length,
    node_target_count: nodeHits.length,
    target_ids: unique([...linkHits, ...nodeHits]).join(" > "),
    reasons: control.top_retest_reasons,
  };
}

function selectSlicePaths({
  slicePosition,
  slicePlan,
  candidatePaths,
  linksBySliceAndId,
  nodesBySliceAndId,
  leverageScores,
  forecastBySliceAndLink,
  selectedLastSeen,
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
  probePacketBaseBytes,
  reportHeaderBytes,
  hopProcessingJ,
  reportProcessingJ,
  telemetryTxNjPerByte,
}) {
  if (candidatePaths.length === 0) return { rows: [], summary: null };
  const sliceOamControl = oamControlForSlice(oamControlBySlice, slicePlan.slice_index);
  const oamBudget = applyOamControlBudget({
    oamControl: sliceOamControl,
    samplingRate,
    targetActiveLinkSamplingRate,
    telemetryByteBudgetPerSlice,
  });
  const planningSamplingRate = oamBudget.adjusted_sampling_rate;
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
  const planningTargetActiveLinkSamplingRate = clamp(
    oamBudget.adjusted_target_active_link_sampling_rate + topologyForecastTargetBoost,
    oamBudget.adjusted_target_active_link_sampling_rate,
    1,
  );
  const planningTelemetryByteBudgetPerSlice = oamBudget.adjusted_telemetry_byte_budget_per_slice;
  const activeLinks = [...slicePlan.activeSet];
  const activeSet = slicePlan.activeSet;
  const baseTargetCoveredLinks = Math.ceil(activeLinks.length * planningTargetActiveLinkSamplingRate);
  const basePathCount = Math.ceil(candidatePaths.length * planningSamplingRate);
  const baseRequestedPathCount = selectionStrategy === "full-int"
    ? candidatePaths.length
    : Math.max(minPaths, basePathCount);
  const baseSelectedLimit = selectionStrategy === "full-int"
    ? candidatePaths.length
    : Math.min(maxPaths > 0 ? maxPaths : candidatePaths.length, candidatePaths.length);
  const planningCandidates = candidatePaths
    .map((path) => repairCandidatePath({ path, activeSet, graph, linksBySliceAndId }))
    .filter(Boolean);

  const scored = planningCandidates.map((path, index) => {
    const pathLinks = activeLinkIdsForPath(path, activeSet);
    const pathNodes = splitPath(path.path);
    const forecastProfile = pathForecastProfile({
      sliceIndex: path.slice_index,
      pathLinks,
      forecastBySliceAndLink,
      horizon: predictionScoreHorizon,
    });
    const linkScores = pathLinks.map((linkId) => {
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
      const staleBonus = !Number.isFinite(stale) || stale > windowSize ? 0.75 : Math.max(0, stale / Math.max(windowSize, 1)) * 0.35;
      return score.leverage + score.transition_rate * 0.8 + kindBonus + staleBonus + confidenceBonus + forecastBonus;
    });
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
    const reuseBonus = candidateSource === "topology-reuse-cache" ? 0.15 : 0;
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
    const oamFeedbackBonus = oamFeedback.score * oamFeedbackWeight;
    const oamControlBonus = oamControl.score * oamControlWeight;
    const telemetryCost = estimatePathTelemetryCost({
      pathLinks,
      pathNodes,
      hopMetadataBytes,
      probePacketBaseBytes,
      reportHeaderBytes,
      hopProcessingJ,
      reportProcessingJ,
      telemetryTxNjPerByte,
    });
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
      forecastProfile.forecast_priority_score * 0.25;
    let strategyScore = baseScore;
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
        oamControlBonus;
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
        oamControlBonus;
    }
    const costScore = costAwarePathScore({
      score: strategyScore,
      cost: telemetryCost,
      forecastProfile,
      diversity,
      oamFeedback,
      oamControl,
      weight: costAwarenessWeight,
    });
    const rankingScore = costAwareSampling && !["full-int", "random-sampling"].includes(selectionStrategy)
      ? costScore.cost_aware_score
      : strategyScore;
    return {
      path,
      index,
      pathLinks,
      pathNodeCount: pathNodes.length,
      energyRisk,
      energyProfile,
      forecastProfile,
      telemetryCost,
      costScore,
      rankingScore,
      oamFeedback,
      oamControl,
      score: strategyScore,
      base_int_mc_score: baseScore,
    };
  });

  scored.sort((left, right) =>
    selectionStrategy === "full-int"
      ? left.index - right.index
      : right.rankingScore - left.rankingScore || right.score - left.score || left.index - right.index,
  );
  const selected = [];
  const covered = new Set();
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
    baseSelectedLimit,
    energyBudgetEnabled,
    energyBudgetMinActiveLinkSamplingRate,
    energyBudgetMaxReduction,
    slicePlan,
  });
  const targetCoveredLinks = energyBudget.energy_budget_target_covered_links;
  const requestedPathCount = energyBudget.energy_budget_requested_paths;
  const selectedLimit = energyBudget.energy_budget_selected_limit;
  const telemetryBudgetEnabled = costAwareSampling && selectionStrategy !== "full-int" && planningTelemetryByteBudgetPerSlice > 0;
  let telemetryBudgetUsedBytes = 0;
  let telemetryBudgetSuppressedPaths = 0;
  let telemetryBudgetOverridePaths = 0;

  for (const item of scored) {
    if (selected.length >= selectedLimit) break;
    const addsCoverage = item.pathLinks.some((linkId) => !covered.has(linkId));
    const coverageStillNeeded = covered.size < targetCoveredLinks;
    const highEnergyRisk = item.energyRisk >= energyGuardThreshold;
    const itemBytes = numberValue(item.telemetryCost.estimated_total_telemetry_bytes);
    const budgetWouldExceed = telemetryBudgetEnabled &&
      selected.length >= minPaths &&
      telemetryBudgetUsedBytes + itemBytes > planningTelemetryByteBudgetPerSlice;
    const criticalBudgetOverride = addsCoverage && coverageStillNeeded ||
      item.oamFeedback.target_count > 0 ||
      item.oamControl.target_count > 0 ||
      numberValue(item.forecastProfile.forecast_near_outage_score) >= 0.5;
    if (budgetWouldExceed && !criticalBudgetOverride) {
      telemetryBudgetSuppressedPaths += 1;
      continue;
    }
    if (highEnergyRisk && selected.length >= requestedPathCount && (!addsCoverage || !coverageStillNeeded)) {
      energyGuardSuppressedPaths += 1;
      continue;
    }
    if (selected.length < requestedPathCount || (covered.size < targetCoveredLinks && addsCoverage)) {
      if (budgetWouldExceed && criticalBudgetOverride) telemetryBudgetOverridePaths += 1;
      telemetryBudgetUsedBytes += itemBytes;
      item.telemetryBudgetDecision = telemetryBudgetEnabled
        ? budgetWouldExceed
          ? "critical-coverage-override"
          : "within-budget"
        : "budget-disabled";
      item.telemetryBudgetUsedBytesAfterSelection = telemetryBudgetUsedBytes;
      item.telemetryBudgetRemainingBytesAfterSelection = telemetryBudgetEnabled
        ? planningTelemetryByteBudgetPerSlice - telemetryBudgetUsedBytes
        : "";
      selected.push(item);
      item.pathLinks.forEach((linkId) => covered.add(linkId));
    }
  }

  selected.forEach((item) => item.pathLinks.forEach((linkId) => selectedLastSeen.set(linkId, slicePosition)));

  const repairedCandidatePaths = planningCandidates.filter((path) => numberValue(path.planning_repair_count) > 0).length;
  const selectedRepairedPaths = selected.filter((item) => numberValue(item.path.planning_repair_count) > 0).length;
  const planningCost = estimatePlanningCost({
    candidateSource,
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
    topology_class_id: slicePlan.topology_class_id,
    topology_forecast_horizon_slices: slicePlan.topology_forecast_horizon_slices,
    topology_forecast_stable_window_slices: slicePlan.topology_forecast_stable_window_slices,
    topology_forecast_next_major_drift_in_slices: slicePlan.topology_forecast_next_major_drift_in_slices,
    topology_forecast_mean_similarity: slicePlan.topology_forecast_mean_similarity,
    topology_forecast_min_similarity: slicePlan.topology_forecast_min_similarity,
    topology_forecast_drift_pressure: slicePlan.topology_forecast_drift_pressure,
    topology_forecast_reuse_confidence: slicePlan.topology_forecast_reuse_confidence,
    topology_forecast_recommended_plan_mode: slicePlan.topology_forecast_recommended_plan_mode,
    topology_forecast_target_sampling_boost: round(topologyForecastTargetBoost),
    int_mc_score: round(item.score),
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
    telemetry_byte_budget_enabled: telemetryBudgetEnabled,
    telemetry_byte_budget_per_slice: planningTelemetryByteBudgetPerSlice,
    telemetry_budget_decision: item.telemetryBudgetDecision ?? "not-evaluated",
    telemetry_budget_used_bytes_after_selection: item.telemetryBudgetUsedBytesAfterSelection ?? "",
    telemetry_budget_remaining_bytes_after_selection: item.telemetryBudgetRemainingBytesAfterSelection ?? "",
    cost_aware_score: item.costScore.cost_aware_score,
    cost_aware_value_per_kb: item.costScore.value_per_kb,
    cost_aware_cost_penalty: item.costScore.cost_penalty,
    cost_aware_efficiency_bonus: item.costScore.efficiency_bonus,
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
    oam_feedback_target_ids: item.oamFeedback.target_ids,
    oam_feedback_reasons: item.oamFeedback.reasons,
    oam_control_score: item.oamControl.score,
    oam_control_pressure: item.oamControl.pressure,
    oam_control_action: item.oamControl.action,
    oam_control_probe_bias: item.oamControl.probe_bias,
    oam_control_confidence_budget: item.oamControl.confidence_budget,
    oam_control_targets: item.oamControl.target_count,
    oam_control_link_targets: item.oamControl.link_target_count,
    oam_control_node_targets: item.oamControl.node_target_count,
    oam_control_target_ids: item.oamControl.target_ids,
    oam_control_reasons: item.oamControl.reasons,
    energy_guard_threshold: energyGuardThreshold,
    energy_guard_decision: item.energyRisk >= energyGuardThreshold
      ? "critical-coverage-override"
      : "normal-telemetry",
    planning_repair_count: item.path.planning_repair_count,
    candidate_source: candidateSource,
    planning_reuse_mode: planningCost.planning_reuse_mode,
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
      candidate_paths: candidatePaths.length,
      planning_candidate_paths: planningCandidates.length,
      selected_paths: rows.length,
      active_links: activeLinks.length,
      sampled_active_links: covered.size,
      active_link_sampling_coverage: round(covered.size / Math.max(activeLinks.length, 1)),
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
      candidate_source: candidateSource,
      topology_reuse_decision: slicePlan.topology_reuse_decision,
      topology_similarity_score: slicePlan.topology_similarity_score,
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
        ? oamBudget.oam_budget_applied
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
const reuseOverheadPressure = numberArg(args, "--reuse-overhead-pressure", 0.5);
const minEnergyPercent = numberArg(args, "--min-energy-percent", 20);
const energyGuardThreshold = numberArg(args, "--energy-guard-threshold", 0.45);
const energyBudgetEnabled = argValue(args, "--energy-budget", "true").toLowerCase() !== "false";
const energyBudgetMinActiveLinkSamplingRate = numberArg(args, "--energy-budget-min-active-link-sampling-rate", 0.08);
const energyBudgetMaxReduction = clamp(numberArg(args, "--energy-budget-max-reduction", 0.45), 0, 0.95);
const selectionStrategy = normalizeSelectionStrategy(argValue(args, "--selection-strategy", "int-mc-leverage"));
const thresholdCalibrationHorizon = Math.max(0, Math.floor(numberArg(args, "--threshold-calibration-horizon", 4)));
const predictionScoreHorizon = Math.max(1, Math.floor(numberArg(args, "--prediction-score-horizon", Math.max(1, thresholdCalibrationHorizon))));
const costAwareSampling = argValue(args, "--cost-aware-sampling", "true").toLowerCase() !== "false";
const costAwarenessWeight = clamp(numberArg(args, "--cost-awareness-weight", 0.28), 0, 1);
const telemetryByteBudgetPerSlice = Math.max(0, numberArg(args, "--telemetry-byte-budget-per-slice", 0));
const hopMetadataBytes = numberArg(args, "--hop-bytes", 96);
const probePacketBaseBytes = numberArg(args, "--probe-base-bytes", 64);
const reportHeaderBytes = numberArg(args, "--report-header-bytes", 128);
const hopProcessingJ = numberArg(args, "--hop-processing-j", 0.02);
const reportProcessingJ = numberArg(args, "--report-processing-j", 0.05);
const telemetryTxNjPerByte = numberArg(args, "--telemetry-tx-nj-per-byte", 120);
const predictedContactPlanPath = argValue(args, "--predicted-contact-plan", "");
const oamPriorityRetestPath = argValue(args, "--oam-priority-retest", "");
const oamControlActionsPath = argValue(args, "--oam-control-actions", "");
const oamFeedbackWeight = numberArg(args, "--oam-feedback-weight", 0.35);
const oamControlWeight = numberArg(args, "--oam-control-weight", 0.22);
const oamReplanPressureThreshold = numberArg(args, "--oam-replan-pressure-threshold", 0.68);
const oamControlReplanPressureThreshold = numberArg(args, "--oam-control-replan-pressure-threshold", 0.68);

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
if (oamPriorityRetestPath) requireFile(resolve(oamPriorityRetestPath), "Ground OAM priority retest feedback");
if (oamControlActionsPath) requireFile(resolve(oamControlActionsPath), "Ground OAM control actions");

const [links, nodes, routes, candidatePaths, predictedContactPlan, oamPriorityRetests, oamControlActions] = await Promise.all([
  readCsv(linksPath),
  existsSync(nodesPath) ? readCsv(nodesPath) : Promise.resolve([]),
  existsSync(routesPath) ? readCsv(routesPath) : Promise.resolve([]),
  readCsv(candidatePathsPath),
  predictedContactPlanPath ? readJson(resolve(predictedContactPlanPath)) : Promise.resolve(null),
  oamPriorityRetestPath ? readCsv(resolve(oamPriorityRetestPath)) : Promise.resolve([]),
  oamControlActionsPath ? readCsv(resolve(oamControlActionsPath)) : Promise.resolve([]),
]);
const planningLinks = buildPlanningLinks({ truthLinks: links, predictedPlan: predictedContactPlan });
const linksBySlice = groupBy(planningLinks, (link) => String(link.slice_index));
const routesBySlice = groupBy(routes, (route) => String(route.slice_index));
const pathsBySlice = groupBy(candidatePaths, (path) => String(path.slice_index));
const linksBySliceAndId = indexBy(planningLinks, (link) => `${link.slice_index}|${link.link_id}`);
const nodesBySliceAndId = indexBy(nodes, (node) => `${node.slice_index}|${node.node_id}`);
const sliceIndexes = [...linksBySlice.keys()].sort((left, right) => Number(left) - Number(right));
const linksById = buildLinksById(planningLinks);
const graphsBySlice = buildGraphsBySlice(planningLinks);
const forecastBySliceAndLink = buildPredictionForecasts({
  linksById,
  sliceIndexes,
  horizon: predictionScoreHorizon,
});
const oamFeedbackBySlice = buildOamFeedbackBySlice(oamPriorityRetests);
const oamControlBySlice = buildOamControlBySlice(oamControlActions);
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
const leverageScores = buildLeverageScores({ linksById, sliceIndexes, rank });
const selectedLastSeen = new Map();
const reusablePlansByClass = new Map();
const selectedRows = [];
const summaryRows = [];

contactPlan.perSlice.forEach((slicePlan, slicePosition) => {
  const currentCandidates = pathsBySlice.get(String(slicePlan.slice_index)) ?? [];
  const cachedCandidates = reusablePlansByClass.get(slicePlan.topology_class_id) ?? [];
  const useCached = adaptiveReuse && slicePlan.topology_reused_from_class && cachedCandidates.length > 0;
  const candidateSource = useCached ? "topology-reuse-cache" : "fresh-slice-plan";
  const candidateRows = (useCached ? cachedCandidates : currentCandidates).map((path) =>
    adaptCandidatePath(path, slicePlan, candidateSource),
  );
  let result = selectSlicePaths({
    slicePosition,
    slicePlan,
    candidatePaths: candidateRows,
    linksBySliceAndId,
    nodesBySliceAndId,
    leverageScores,
    forecastBySliceAndLink,
    selectedLastSeen,
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
    probePacketBaseBytes,
    reportHeaderBytes,
    hopProcessingJ,
    reportProcessingJ,
    telemetryTxNjPerByte,
  });
  if (useCached && result.rows.length === 0 && currentCandidates.length > 0) {
    result = selectSlicePaths({
      slicePosition,
      slicePlan: {
        ...slicePlan,
        topology_reuse_decision: "reuse-failed-fresh-replan",
      },
      candidatePaths: currentCandidates.map((path) => adaptCandidatePath(path, slicePlan, "fresh-slice-plan-fallback")),
      linksBySliceAndId,
      nodesBySliceAndId,
      leverageScores,
      forecastBySliceAndLink,
      selectedLastSeen,
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
      probePacketBaseBytes,
      reportHeaderBytes,
      hopProcessingJ,
      reportProcessingJ,
      telemetryTxNjPerByte,
    });
  }
  selectedRows.push(...result.rows);
  if (result.summary) {
    const reusableRows = result.rows.map((row) => ({
      ...row,
      source_candidate_probe_id: row.source_candidate_probe_id || row.probe_id,
    }));
    if (reusableRows.length > 0) reusablePlansByClass.set(slicePlan.topology_class_id, reusableRows);
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
    oam_priority_retest_csv: oamPriorityRetestPath ? resolve(oamPriorityRetestPath) : "",
    oam_control_actions_csv: oamControlActionsPath ? resolve(oamControlActionsPath) : "",
  },
  planning_algorithm: algorithm,
  method: {
    origin: "INT-MC path leverage sampling adapted for predictable LEO contact plans",
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
      "cost-aware marginal sampling estimates per-probe INT bytes and telemetry energy before ranking low-overhead paths",
      "optional per-slice telemetry byte budget suppresses noncritical probes while allowing critical coverage overrides",
      "route-path similarity included in topology reuse decisions",
      "link-state matrix similarity included in topology reuse decisions",
      "similar topology class reuses cached probe plans with local repair",
      "energy-aware path penalty for low-power satellites",
      "shadow and power-margin aware energy guard suppresses nonessential probe paths",
      "energy-aware slice budget lowers nonessential probe sampling rate in shadow, low-energy or negative-power-margin conditions",
      "optional Ground OAM priority-retest feedback biases future probe selection",
      "Ground OAM retest pressure can force fresh probe replanning when confidence or unknown-state risk is high",
      "optional Ground OAM control actions can force fresh replanning or bias probes toward OAM target nodes and links",
      "Ground OAM control actions can recommend per-slice sampling rates and telemetry byte budgets for closed-loop low-overhead telemetry",
      "local path repair when a predicted contact gap invalidates an old candidate route",
      "normalized planning-cost accounting estimates the benefit of topology reuse versus full per-slice replanning",
      "path selection runs on ground-side planning data, not on satellites",
    ],
    planning_overhead_model: {
      unit: "relative-normalized-planning-cost",
      full_replan_baseline: "active-link mask build plus candidate path scoring for every slice",
      reuse_path: "cached path validation plus local repair on the predicted active graph",
      scope: "ground-side planning overhead only; not satellite CPU telemetry processing energy",
    },
    mininet_code_not_ported: true,
    uses_predicted_contact_plan: Boolean(predictedContactPlan),
  },
  parameters: {
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
    threshold_calibration_horizon_slices: thresholdCalibrationHorizon,
    prediction_score_horizon_slices: predictionScoreHorizon,
    cost_aware_sampling_enabled: costAwareSampling,
    cost_awareness_weight: costAwarenessWeight,
    telemetry_byte_budget_per_slice: telemetryByteBudgetPerSlice,
    hop_metadata_bytes: hopMetadataBytes,
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
    oam_feedback_enabled: oamPriorityRetests.length > 0,
    oam_feedback_weight: oamFeedbackWeight,
    oam_priority_retest_targets: oamPriorityRetests.length,
    oam_replan_pressure_threshold: oamReplanPressureThreshold,
    oam_control_actions_enabled: oamControlActions.length > 0,
    oam_control_weight: oamControlWeight,
    oam_control_action_slices: oamControlBySlice.size,
    oam_control_replan_pressure_threshold: oamControlReplanPressureThreshold,
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
    selected_paths: selectedRows.length,
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
    reused_slice_plans: summaryRows.filter((row) => row.candidate_source === "topology-reuse-cache").length,
    fresh_slice_plans: summaryRows.filter((row) => row.candidate_source !== "topology-reuse-cache").length,
    estimated_full_replanning_avoided: summaryRows.filter((row) => row.candidate_source === "topology-reuse-cache").length,
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
    mean_cost_aware_score: round(mean(summaryRows.map((row) => numberValue(row.mean_cost_aware_score)))),
    mean_cost_aware_value_per_kb: round(mean(summaryRows.map((row) => numberValue(row.mean_cost_aware_value_per_kb)))),
    mean_estimated_total_telemetry_bytes_per_path: round(mean(summaryRows.map((row) => numberValue(row.mean_estimated_total_telemetry_bytes_per_path)))),
    mean_solar_exposure: round(mean(summaryRows.map((row) => numberValue(row.mean_solar_exposure, NaN)).filter(Number.isFinite))),
    mean_power_margin_w: round(mean(summaryRows.map((row) => numberValue(row.mean_power_margin_w, NaN)).filter(Number.isFinite))),
    mean_effective_sampling_rate: round(mean(summaryRows.map((row) => numberValue(row.effective_sampling_rate)))),
    mean_effective_target_active_link_sampling_rate: round(mean(summaryRows.map((row) => numberValue(row.effective_target_active_link_sampling_rate)))),
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
    oam_replan_triggered_slices: summaryRows.filter((row) => row.oam_replan_triggered === true).length,
    mean_oam_replan_pressure: round(mean(summaryRows.map((row) => numberValue(row.oam_replan_pressure)))),
    max_oam_replan_pressure: round(Math.max(0, ...summaryRows.map((row) => numberValue(row.oam_replan_pressure)))),
    oam_replan_targets: summaryRows.reduce((total, row) => total + numberValue(row.oam_replan_targets), 0),
    oam_replan_urgent_targets: summaryRows.reduce((total, row) => total + numberValue(row.oam_replan_urgent_targets), 0),
    oam_control_action_slices: oamControlBySlice.size,
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
