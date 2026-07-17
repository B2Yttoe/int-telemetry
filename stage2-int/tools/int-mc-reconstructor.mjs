import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolveTopologyAwareStatusEstimate } from "./int-mc-constraints.mjs";
import { basename, join, resolve } from "node:path";
import { buildDeployableCompletionPriorityRetests } from "./int-mc-feedback.mjs";
import {
  predictNetPowerFromObservableContext,
  propagateEnergyPercent,
} from "./int-mc-energy-prior.mjs";
import {
  ADDITIONAL_COMPLETION_BACKENDS,
  completeWithAdditionalBackend,
} from "./int-mc-additional-completion-backends.mjs";
import { completeJointMetricTensor } from "./int-mc-joint-tensor-completion.mjs";
import {
  projectLinkPhysicalConsistency,
  projectNodePhysicalConsistency,
} from "./int-mc-physical-consistency.mjs";

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

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function evidenceCount(items) {
  return items.filter(Boolean).length;
}

function mean(values) {
  if (values.length === 0) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function rmse(errors) {
  if (errors.length === 0) return 0;
  return Math.sqrt(mean(errors.map((value) => value * value)));
}

function percentile(values, percentileValue) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * percentileValue)));
  return sorted[index];
}

function errorMetricStats(pairs, metric) {
  if (pairs.length === 0) {
    return {
      samples: 0,
      mae: 0,
      rmse: 0,
      median_ae: 0,
      p90_ae: 0,
      p95_ae: 0,
      max_ae: 0,
      mean_error: 0,
      nmse: 0,
      nmae_range: 0,
      smape: 0,
      within_5_units_rate: 0,
      within_10_units_rate: 0,
    };
  }
  const errors = pairs.map((item) => item.estimate - item.actual);
  const absErrors = errors.map((value) => Math.abs(value));
  let maximumAbsoluteError = 0;
  let minimumActual = Number.POSITIVE_INFINITY;
  let maximumActual = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < pairs.length; index += 1) {
    maximumAbsoluteError = Math.max(maximumAbsoluteError, absErrors[index]);
    minimumActual = Math.min(minimumActual, pairs[index].actual);
    maximumActual = Math.max(maximumActual, pairs[index].actual);
  }
  const meanAbs = mean(absErrors);
  const range = numberValue(metric.range, NaN);
  const actualMean = mean(pairs.map((item) => item.actual));
  const sse = mean(errors.map((value) => value * value));
  const variance = mean(pairs.map((item) => (item.actual - actualMean) ** 2));
  const smapeValues = pairs.map((item, index) => {
    const denom = Math.abs(item.estimate) + Math.abs(item.actual);
    return denom > 1e-9 ? (2 * absErrors[index]) / denom : 0;
  });
  const result = {
    samples: pairs.length,
    mae: round(meanAbs),
    rmse: round(rmse(errors)),
    nmse: round(sse / Math.max(mean(pairs.map((item) => item.actual * item.actual)), 1e-9)),
    median_ae: round(percentile(absErrors, 0.5)),
    p90_ae: round(percentile(absErrors, 0.9)),
    p95_ae: round(percentile(absErrors, 0.95)),
    max_ae: round(maximumAbsoluteError),
    mean_error: round(mean(errors)),
    nmae_range: round(meanAbs / Math.max(Number.isFinite(range) ? range : maximumActual - minimumActual, 1)),
    smape: round(mean(smapeValues)),
    within_5_units_rate: round(absErrors.filter((value) => value <= 5).length / pairs.length),
    within_10_units_rate: round(absErrors.filter((value) => value <= 10).length / pairs.length),
    r2: round(1 - sse / Math.max(variance, 1e-9)),
  };
  if (Number.isFinite(numberValue(metric.classThreshold, NaN))) {
    const threshold = numberValue(metric.classThreshold);
    let tp = 0;
    let fp = 0;
    let tn = 0;
    let fn = 0;
    pairs.forEach((item) => {
      const actualHigh = item.actual >= threshold;
      const estimatedHigh = item.estimate >= threshold;
      if (actualHigh && estimatedHigh) tp += 1;
      else if (!actualHigh && estimatedHigh) fp += 1;
      else if (!actualHigh && !estimatedHigh) tn += 1;
      else fn += 1;
    });
    result.class_threshold = threshold;
    result.class_accuracy = round((tp + tn) / pairs.length);
    result.high_precision = round(tp / Math.max(tp + fp, 1));
    result.high_recall = round(tp / Math.max(tp + fn, 1));
    result.high_f1 = round((2 * tp) / Math.max(2 * tp + fp + fn, 1));
    result.high_actual_support = tp + fn;
    result.high_predicted_support = tp + fp;
    result.high_true_positive = tp;
    result.high_false_positive = fp;
    result.high_true_negative = tn;
    result.high_false_negative = fn;
  }
  return result;
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

function unique(values) {
  return [...new Set(values.filter((value) => value !== undefined && value !== ""))];
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

function contactActiveFor(contactByKey, truthRow, sliceIndex, linkId) {
  if (contactByKey) {
    return boolValue(contactByKey.get(`${sliceIndex}|${linkId}`)?.predicted_active);
  }
  return boolValue(truthRow?.is_active);
}

function planeSlot(nodeId) {
  const match = /^P(\d+)-S(\d+)$/.exec(String(nodeId || ""));
  if (!match) return { plane: -1, slot: -1 };
  return { plane: Number(match[1]), slot: Number(match[2]), plane_width: match[1].length, slot_width: match[2].length };
}

function maxPlaneSlotFromNodeIds(nodeIds) {
  return nodeIds.reduce(
    (limits, nodeId) => {
      const tensor = planeSlot(nodeId);
      return {
        plane: Math.max(limits.plane, tensor.plane),
        slot: Math.max(limits.slot, tensor.slot),
      };
    },
    { plane: 1, slot: 1 },
  );
}

function normalizedPlaneSlotFeatures(nodeId, limits) {
  const tensor = planeSlot(nodeId);
  if (tensor.plane < 0 || tensor.slot < 0) return [0, 0, 0, 0];
  const planeNorm = tensor.plane / Math.max(limits.plane, 1);
  const slotNorm = tensor.slot / Math.max(limits.slot, 1);
  return [
    planeNorm,
    slotNorm,
    Math.sin(2 * Math.PI * planeNorm),
    Math.cos(2 * Math.PI * slotNorm),
  ];
}

function buildNodeCompletionRowFeatures(nodeIds) {
  const limits = maxPlaneSlotFromNodeIds(nodeIds);
  return nodeIds.map((nodeId) => normalizedPlaneSlotFeatures(nodeId, limits));
}

function firstTruthForId({ ids, sliceIndexes, truthByKey }) {
  return ids.map((id) => {
    for (const sliceIndex of sliceIndexes) {
      const row = truthByKey.get(`${sliceIndex}|${id}`);
      if (row) return row;
    }
    return null;
  });
}

function buildLinkCompletionRowFeatures({ linkIds, sliceIndexes, truthByKey }) {
  const catalogRows = firstTruthForId({ ids: linkIds, sliceIndexes, truthByKey });
  const nodeIds = [];
  catalogRows.forEach((row) => {
    if (row?.source) nodeIds.push(row.source);
    if (row?.target) nodeIds.push(row.target);
  });
  const limits = maxPlaneSlotFromNodeIds(nodeIds);
  return catalogRows.map((row) => {
    const sourceFeatures = normalizedPlaneSlotFeatures(row?.source, limits).slice(0, 2);
    const targetFeatures = normalizedPlaneSlotFeatures(row?.target, limits).slice(0, 2);
    const source = planeSlot(row?.source);
    const target = planeSlot(row?.target);
    const samePlane = source.plane >= 0 && source.plane === target.plane ? 1 : 0;
    const interPlane = String(row?.kind || "").includes("inter") || samePlane === 0 ? 1 : 0;
    return [...sourceFeatures, ...targetFeatures, samePlane, interPlane];
  });
}

function circularGap(left, right, modulo = 9999) {
  const gap = Math.abs(left - right);
  return Math.min(gap, Math.max(modulo - gap, gap));
}

function spatialGroupKey(link) {
  const source = planeSlot(link?.source);
  const target = planeSlot(link?.target);
  if (source.plane < 0 || target.plane < 0) return `${link?.kind || "unknown"}|unknown`;
  const planeRelation = source.plane === target.plane ? "same-plane" : "cross-plane";
  const slotRelation = source.slot === target.slot ? "same-slot" : `slot-gap-${Math.min(Math.abs(source.slot - target.slot), 3)}`;
  const planeGap = planeRelation === "same-plane" ? 0 : Math.min(circularGap(source.plane, target.plane, 64), 3);
  return `${link?.kind || "unknown"}|${planeRelation}|plane-gap-${planeGap}|${slotRelation}`;
}

function nodeSpatialGroupKey(node) {
  const nodeId = node?.node_id ?? "";
  const parsed = planeSlot(nodeId);
  const plane = Number.isFinite(numberValue(node?.plane, NaN)) ? numberValue(node.plane) + 1 : parsed.plane;
  const slot = Number.isFinite(numberValue(node?.slot, NaN)) ? numberValue(node.slot) + 1 : parsed.slot;
  if (plane < 0 || slot < 0) return "unknown-node-group";
  const slotBand = Math.floor((slot - 1) / 4);
  const planeBand = Math.floor((plane - 1) / 4);
  return `plane-band-${planeBand}|slot-band-${slotBand}`;
}

function nodeIlluminationGroupKey(node) {
  const solarExposure = clamp(numberValue(node?.solar_exposure, boolValue(node?.in_sunlight) ? 1 : 0), 0, 1);
  if (solarExposure >= 0.65) return "sunlit";
  if (solarExposure <= 0.25) return "shadow";
  return "partial-sun";
}

function splitList(value) {
  return String(value || "")
    .split(/\s+>\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function padNumber(value, width) {
  return String(value).padStart(Math.max(width, 1), "0");
}

function wrapOneBased(value, max) {
  if (!Number.isFinite(value) || max <= 0) return value;
  return ((value - 1 + max) % max) + 1;
}

function buildNodeTensorIndex(nodeIds) {
  const byCoord = new Map();
  const idSet = new Set();
  let planeCount = 0;
  let slotCount = 0;
  let planeWidth = 2;
  let slotWidth = 2;
  nodeIds.forEach((nodeId) => {
    const parsed = planeSlot(nodeId);
    if (parsed.plane < 0 || parsed.slot < 0) return;
    planeCount = Math.max(planeCount, parsed.plane);
    slotCount = Math.max(slotCount, parsed.slot);
    planeWidth = Math.max(planeWidth, parsed.plane_width ?? 2);
    slotWidth = Math.max(slotWidth, parsed.slot_width ?? 2);
    byCoord.set(`${parsed.plane}|${parsed.slot}`, nodeId);
    idSet.add(nodeId);
  });
  return { byCoord, idSet, planeCount, slotCount, planeWidth, slotWidth };
}

function nodeIdAt(index, plane, slot) {
  const wrappedPlane = wrapOneBased(plane, index.planeCount);
  const wrappedSlot = wrapOneBased(slot, index.slotCount);
  return index.byCoord.get(`${wrappedPlane}|${wrappedSlot}`) ??
    `P${padNumber(wrappedPlane, index.planeWidth)}-S${padNumber(wrappedSlot, index.slotWidth)}`;
}

function nodeTensorNeighborIds(nodeId, index) {
  const parsed = planeSlot(nodeId);
  if (parsed.plane < 0 || parsed.slot < 0) return [];
  const candidates = [
    nodeIdAt(index, parsed.plane, parsed.slot - 1),
    nodeIdAt(index, parsed.plane, parsed.slot + 1),
    nodeIdAt(index, parsed.plane - 1, parsed.slot),
    nodeIdAt(index, parsed.plane + 1, parsed.slot),
  ];
  return [...new Set(candidates.filter((candidate) => candidate && candidate !== nodeId && index.idSet?.has(candidate)))];
}

function buildLinkTensorIndex({ linkIds, sliceIndexes, truthByKey }) {
  const linkIdSet = new Set(linkIds);
  const byLinkId = new Map();
  const nodeIds = new Set();
  linkIds.forEach((linkId) => {
    const truth = sliceIndexes.map((sliceIndex) => truthByKey.get(`${sliceIndex}|${linkId}`)).find(Boolean);
    if (!truth) return;
    nodeIds.add(truth.source);
    nodeIds.add(truth.target);
    byLinkId.set(linkId, {
      kind: truth.kind,
      source: truth.source,
      target: truth.target,
      sourceCoord: planeSlot(truth.source),
      targetCoord: planeSlot(truth.target),
    });
  });
  return {
    byLinkId,
    linkIdSet,
    nodeIndex: buildNodeTensorIndex([...nodeIds]),
  };
}

function linkTensorNeighborIds(linkId, index) {
  const item = index.byLinkId.get(linkId);
  if (!item || item.sourceCoord.plane < 0 || item.targetCoord.plane < 0) return [];
  const shifts = [
    { plane: 0, slot: -1 },
    { plane: 0, slot: 1 },
    { plane: -1, slot: 0 },
    { plane: 1, slot: 0 },
  ];
  const candidates = shifts.map((shift) => {
    const source = nodeIdAt(index.nodeIndex, item.sourceCoord.plane + shift.plane, item.sourceCoord.slot + shift.slot);
    const target = nodeIdAt(index.nodeIndex, item.targetCoord.plane + shift.plane, item.targetCoord.slot + shift.slot);
    return `${item.kind}:${source}->${target}`;
  });
  return [...new Set(candidates.filter((candidate) => candidate !== linkId && index.linkIdSet.has(candidate)))];
}

function tensorNeighborPriorValue({ id, sliceIndex, observedByKey, metric, neighborIds }) {
  const values = neighborIds
    .map((neighborId) => observedByKey.get(`${sliceIndex}|${neighborId}`))
    .map((observed) => (boolValue(observed?.observed) ? metric.observedValue(observed) : NaN))
    .filter(Number.isFinite);
  return {
    value: values.length ? mean(values) : NaN,
    count: values.length,
    quality: values.length ? clamp(values.length / Math.max(neighborIds.length, 1), 0, 1) : 0,
  };
}

function saturationProfile(values) {
  const finite = values.filter(Number.isFinite);
  const lowCount = finite.filter((value) => value <= 5).length;
  const highCount = finite.filter((value) => value >= 95).length;
  const midCount = finite.length - lowCount - highCount;
  const saturatedRatio = finite.length ? (lowCount + highCount) / finite.length : 0;
  const midRatio = finite.length ? midCount / finite.length : 1;
  const shapeStrength = clamp((saturatedRatio - 0.65) / 0.35, 0, 1) * clamp((0.35 - midRatio) / 0.35, 0, 1);
  return {
    enabled: finite.length >= 8 && saturatedRatio >= 0.65 && midRatio <= 0.35,
    low_ratio: finite.length ? lowCount / finite.length : 0,
    high_ratio: finite.length ? highCount / finite.length : 0,
    mid_ratio: midRatio,
    saturated_ratio: saturatedRatio,
    shape_strength: shapeStrength,
  };
}

function saturatedUtilizationEstimate({
  metric,
  rawEstimate,
  profile,
  temporal,
  tensorNeighbor,
  sameSliceGroup,
  sameSliceAll,
  rowValue,
  columnValue,
  historicalPrior,
  hotspot,
}) {
  if (!metric.saturationAware || !profile.enabled) {
    return { value: rawEstimate, applied: false, probability_high: "" };
  }
  const candidates = [];
  let evidenceWeight = 0;
  const addCandidate = (value, weight) => {
    if (!Number.isFinite(value) || weight <= 0) return;
    candidates.push({ probability: clamp(value / 100, 0, 1), weight });
    evidenceWeight += weight;
  };
  const hotspotScore = numberValue(hotspot?.business_hotspot_score);

  addCandidate(rawEstimate, 0.16);
  addCandidate(temporal.value, 0.34 + temporal.quality * 0.16);
  addCandidate(tensorNeighbor.value, 0.22 + tensorNeighbor.quality * 0.14);
  addCandidate(sameSliceGroup?.mean, 0.16);
  addCandidate(sameSliceAll?.mean, 0.08);
  addCandidate(rowValue, 0.12);
  addCandidate(columnValue, 0.1);
  addCandidate(historicalPrior?.mean, 0.08);
  candidates.push({
    probability: clamp(profile.high_ratio, 0, 1),
    weight: 0.06,
  });
  evidenceWeight += 0.06;
  if (hotspotScore > 0) {
    candidates.push({
      probability: clamp(0.45 + hotspotScore * 0.5, 0, 1),
      weight: 0.14,
    });
    evidenceWeight += 0.14;
  }
  if (candidates.length === 0) return { value: rawEstimate, applied: false, probability_high: "" };

  const weightTotal = candidates.reduce((total, item) => total + item.weight, 0);
  const probabilityHigh = candidates.reduce((total, item) => total + item.probability * item.weight, 0) / Math.max(weightTotal, 1e-9);
  const decisionConfidence = Math.abs(probabilityHigh - 0.5) * 2;
  const supportQuality = clamp(evidenceWeight / 1.2, 0, 1);
  const shapeStrength = clamp(numberValue(profile.shape_strength, 0), 0, 1);
  const highCutoff = 0.74 - shapeStrength * 0.04;
  const lowCutoff = 0.26 + shapeStrength * 0.04;
  const canSnap = supportQuality >= 0.35 && decisionConfidence >= 0.45;
  if (canSnap && probabilityHigh >= highCutoff) {
    return { value: 100, applied: rawEstimate < 95, probability_high: round(probabilityHigh) };
  }
  if (canSnap && probabilityHigh <= lowCutoff) {
    return { value: 0, applied: rawEstimate > 5, probability_high: round(probabilityHigh) };
  }
  const blendWeight = clamp(0.12 + shapeStrength * decisionConfidence * supportQuality * 0.45, 0.12, 0.5);
  const blended = rawEstimate * (1 - blendWeight) + probabilityHigh * 100 * blendWeight;
  return {
    value: blended,
    applied: Math.abs(blended - rawEstimate) >= 1,
    probability_high: round(probabilityHigh),
  };
}

function buildBusinessHotspots(routes) {
  const byKey = new Map();
  routes
    .filter((route) => String(route.status || "routed") === "routed")
    .forEach((route) => {
      const linkIds = splitList(route.link_ids);
      linkIds.forEach((linkId) => {
        const key = `${route.slice_index}|${linkId}`;
        const old = byKey.get(key) ?? {
          slice_index: Number(route.slice_index),
          link_id: linkId,
          route_task_count: 0,
          route_traffic_mbps: 0,
          route_priority_sum: 0,
          route_queue_delay_ms: 0,
        };
        old.route_task_count += 1;
        old.route_traffic_mbps += numberValue(route.traffic_mbps);
        old.route_priority_sum += numberValue(route.priority);
        old.route_queue_delay_ms += numberValue(route.queue_delay_ms);
        byKey.set(key, old);
      });
    });
  byKey.forEach((item) => {
    item.route_traffic_mbps = round(item.route_traffic_mbps);
    item.route_priority_mean = round(item.route_priority_sum / Math.max(item.route_task_count, 1));
    item.route_queue_delay_ms = round(item.route_queue_delay_ms);
    item.business_hotspot_score = round(
      Math.min(1, item.route_traffic_mbps / 1000) * 0.55 +
      Math.min(1, item.route_task_count / 4) * 0.3 +
      Math.min(1, item.route_priority_mean / 3) * 0.15,
    );
    delete item.route_priority_sum;
  });
  return byKey;
}

function hasBusinessHotspot(hotspot) {
  return numberValue(hotspot?.business_hotspot_score, 0) > 0 ||
    numberValue(hotspot?.route_traffic_mbps, 0) > 0 ||
    numberValue(hotspot?.route_task_count, 0) > 0;
}

function emptyBusinessHotspotMigrationPrior(enabled = false) {
  return {
    enabled,
    applied: false,
    source: enabled ? "no-migrating-business-hotspot" : "disabled",
    candidate_count: 0,
    score: 0,
    quality: 0,
    route_task_count: 0,
    route_traffic_mbps: 0,
    route_priority_mean: 0,
    route_queue_delay_ms: 0,
    hotspot: {},
  };
}

function businessHotspotMigrationPrior({
  enabled,
  linkId,
  sliceIndex,
  colIndex,
  sliceIndexes,
  businessHotspots,
  linkTensorIndex,
}) {
  if (!enabled || !businessHotspots || businessHotspots.size === 0) return emptyBusinessHotspotMigrationPrior(enabled);
  const candidates = [];
  const seen = new Set();
  const addCandidate = (candidateSlice, candidateLinkId, weight, source) => {
    const key = `${candidateSlice}|${candidateLinkId}`;
    if (seen.has(`${key}|${source}`)) return;
    seen.add(`${key}|${source}`);
    const hotspot = businessHotspots.get(key);
    if (!hasBusinessHotspot(hotspot) || weight <= 0) return;
    candidates.push({ hotspot, weight, source });
  };

  for (let distance = 1; distance <= 2; distance += 1) {
    const index = colIndex - distance;
    if (index >= 0) addCandidate(sliceIndexes[index], linkId, 0.72 / distance, `same-link-t-${distance}`);
  }

  const neighborIds = linkTensorNeighborIds(linkId, linkTensorIndex);
  neighborIds.forEach((neighborId) => {
    addCandidate(sliceIndex, neighborId, 0.42, "same-slice-orbit-neighbor");
  });
  for (let distance = 1; distance <= 1; distance += 1) {
    const index = colIndex - distance;
    if (index < 0) continue;
    neighborIds.forEach((neighborId) => {
      addCandidate(sliceIndexes[index], neighborId, 0.24 / distance, `orbit-neighbor-t-${distance}`);
    });
  }

  if (candidates.length === 0) return emptyBusinessHotspotMigrationPrior(true);

  const weightTotal = candidates.reduce((total, item) => total + item.weight, 0);
  const weightedMean = (field) =>
    candidates.reduce((total, item) => total + numberValue(item.hotspot?.[field], 0) * item.weight, 0) / Math.max(weightTotal, 1e-9);
  const hotspot = {
    route_task_count: round(weightedMean("route_task_count")),
    route_traffic_mbps: round(weightedMean("route_traffic_mbps")),
    route_priority_mean: round(weightedMean("route_priority_mean")),
    route_queue_delay_ms: round(weightedMean("route_queue_delay_ms")),
    business_hotspot_score: round(weightedMean("business_hotspot_score")),
  };
  const temporalSupport = candidates.filter((item) => String(item.source).startsWith("same-link")).length;
  const orbitSupport = candidates.length - temporalSupport;
  if (temporalSupport === 0) {
    return {
      ...emptyBusinessHotspotMigrationPrior(true),
      source: "orbit-neighbor-only-rejected",
      candidate_count: candidates.length,
    };
  }
  const quality = clamp(0.18 + Math.min(temporalSupport, 2) * 0.28 + Math.min(orbitSupport, 2) * 0.12, 0.1, 0.86);
  const source = unique(candidates.map((item) => item.source)).join("|");
  hotspot.business_hotspot_migration_quality = round(quality);
  hotspot.business_hotspot_migration_source = source;
  return {
    enabled: true,
    applied: hasBusinessHotspot(hotspot),
    source,
    candidate_count: candidates.length,
    score: round(hotspot.business_hotspot_score),
    quality: round(quality),
    route_task_count: hotspot.route_task_count,
    route_traffic_mbps: hotspot.route_traffic_mbps,
    route_priority_mean: hotspot.route_priority_mean,
    route_queue_delay_ms: hotspot.route_queue_delay_ms,
    hotspot,
  };
}

function businessHotspotMetricPriorValue(metric, migrationPrior) {
  if (!migrationPrior?.applied) return NaN;
  const score = clamp(numberValue(migrationPrior.score, 0), 0, 1);
  const quality = clamp(numberValue(migrationPrior.quality, 0), 0, 1);
  const traffic = numberValue(migrationPrior.route_traffic_mbps, 0);
  const taskCount = numberValue(migrationPrior.route_task_count, 0);
  const priority = numberValue(migrationPrior.route_priority_mean, 0);
  const routeQueueDelay = numberValue(migrationPrior.route_queue_delay_ms, 0);
  const evidence = clamp((score * 0.55 + quality * 0.45 - 0.35) / 0.65, 0, 1);
  if (evidence < 0.12) return NaN;
  if (metric.name === "utilization_percent") {
    const rawPrior = 10 +
      Math.min(traffic / 1400, 1) * 34 +
      Math.min(taskCount / 2, 1) * 6 +
      Math.min(priority / 3, 1) * 6 +
      score * 6;
    return clamp(rawPrior * evidence * 0.45, 0, 42);
  }
  if (metric.name === "queue_latency_ms") return clamp((3 + score * 22 + Math.min(routeQueueDelay, 300) * 0.04) * evidence * 0.5, 0, 90);
  if (metric.name === "congestion_percent") return clamp(score * 28 * evidence * 0.45, 0, 24);
  if (metric.name === "queued_traffic_mb") return clamp(traffic * score * 0.02 * evidence, 0, 120);
  if (metric.name === "dropped_traffic_mb") return score >= 0.9 && quality >= 0.78 ? clamp((score - 0.86) * 5 * evidence, 0, 3) : NaN;
  if (metric.name === "packet_error_rate") return clamp((0.001 + score * 0.012) * evidence, 0, 0.018);
  return NaN;
}

function linkEndpointIds(linkId, truthLink) {
  const ids = [];
  if (truthLink?.source) ids.push(truthLink.source);
  if (truthLink?.target) ids.push(truthLink.target);
  const text = String(linkId || "");
  const routePart = text.includes(":") ? text.split(":").slice(1).join(":") : text;
  const match = /(P\d+-S\d+)\s*->\s*(P\d+-S\d+)/.exec(routePart);
  if (match) {
    ids.push(match[1], match[2]);
  }
  return unique(ids);
}

function buildNodeWorkloads(routes, truthByKey) {
  const byKey = new Map();
  routes
    .filter((route) => String(route.status || "routed") === "routed")
    .forEach((route) => {
      const sliceIndex = Number(route.slice_index);
      const linkIds = splitList(route.link_ids);
      const nodes = [];
      if (route.node_id) nodes.push(route.node_id);
      if (route.source) nodes.push(route.source);
      if (route.target) nodes.push(route.target);
      linkIds.forEach((linkId) => {
        linkEndpointIds(linkId, truthByKey.get(`${route.slice_index}|${linkId}`)).forEach((nodeId) => nodes.push(nodeId));
      });
      unique(nodes).forEach((nodeId) => {
        const key = `${route.slice_index}|${nodeId}`;
        const old = byKey.get(key) ?? {
          slice_index: sliceIndex,
          node_id: nodeId,
          route_task_count: 0,
          source_task_count: 0,
          sink_task_count: 0,
          transit_task_count: 0,
          route_traffic_mbps: 0,
          route_priority_sum: 0,
          route_queue_delay_ms: 0,
        };
        old.route_task_count += 1;
        if (nodeId === route.node_id || nodeId === route.source) old.source_task_count += 1;
        else if (nodeId === route.target) old.sink_task_count += 1;
        else old.transit_task_count += 1;
        old.route_traffic_mbps += numberValue(route.traffic_mbps);
        old.route_priority_sum += numberValue(route.priority);
        old.route_queue_delay_ms += numberValue(route.queue_delay_ms);
        byKey.set(key, old);
      });
    });
  byKey.forEach((item) => {
    item.route_traffic_mbps = round(item.route_traffic_mbps);
    item.route_priority_mean = round(item.route_priority_sum / Math.max(item.route_task_count, 1));
    item.route_queue_delay_ms = round(item.route_queue_delay_ms);
    item.node_workload_score = round(
      Math.min(1, item.route_traffic_mbps / 1200) * 0.55 +
        Math.min(1, item.route_task_count / 4) * 0.22 +
        Math.min(1, item.route_priority_mean / 3) * 0.1 +
        Math.min(1, item.route_queue_delay_ms / 1000) * 0.13,
    );
    delete item.route_priority_sum;
  });
  return byKey;
}

function buildSpatialPriorStats({ metric, linkIds, sliceIndexes, truthByKey, observedByKey }) {
  const groups = new Map();
  linkIds.forEach((linkId) => {
    sliceIndexes.forEach((sliceIndex) => {
      const truth = truthByKey.get(`${sliceIndex}|${linkId}`);
      const observed = observedByKey.get(`${sliceIndex}|${linkId}`);
      const value = metric.observedValue(observed);
      if (!truth || !boolValue(observed?.observed) || !Number.isFinite(value)) return;
      const key = spatialGroupKey(truth);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(value);
    });
  });
  const stats = new Map();
  for (const [key, values] of groups.entries()) {
    stats.set(key, {
      count: values.length,
      mean: mean(values),
    });
  }
  return stats;
}

function buildSliceSpatialPriorStats({ metric, ids, sliceIndexes, truthByKey, observedByKey, groupFn }) {
  const groups = new Map();
  ids.forEach((id) => {
    sliceIndexes.forEach((sliceIndex) => {
      const key = `${sliceIndex}|${id}`;
      const truth = truthByKey.get(key);
      const observed = observedByKey.get(key);
      const value = metric.observedValue(observed);
      if (!truth || !boolValue(observed?.observed) || !Number.isFinite(value)) return;
      const group = groupFn(truth);
      [`${sliceIndex}|${group}`, `${sliceIndex}|__all__`].forEach((groupKey) => {
        if (!groups.has(groupKey)) groups.set(groupKey, []);
        groups.get(groupKey).push(value);
      });
    });
  });
  const stats = new Map();
  for (const [key, values] of groups.entries()) {
    stats.set(key, {
      count: values.length,
      mean: mean(values),
    });
  }
  return stats;
}

function temporalPriorValue({ id, colIndex, sliceIndexes, observedByKey, metric, windowSize }) {
  let weighted = 0;
  let weightTotal = 0;
  let count = 0;
  let nearestDistance = Infinity;
  const maxDistance = Math.max(Math.round(windowSize), 1);

  for (let distance = 1; distance <= maxDistance; distance += 1) {
    [-1, 1].forEach((direction) => {
      const index = colIndex + direction * distance;
      if (index < 0 || index >= sliceIndexes.length) return;
      const observed = observedByKey.get(`${sliceIndexes[index]}|${id}`);
      const value = metric.observedValue(observed);
      if (!boolValue(observed?.observed) || !Number.isFinite(value)) return;
      const weight = 1 / distance;
      weighted += value * weight;
      weightTotal += weight;
      count += 1;
      nearestDistance = Math.min(nearestDistance, distance);
    });
  }

  return {
    value: weightTotal > 0 ? weighted / weightTotal : NaN,
    count,
    nearest_distance: Number.isFinite(nearestDistance) ? nearestDistance : "",
    quality: count > 0 ? clamp(count / Math.max(maxDistance * 2, 1), 0, 1) : 0,
  };
}

function orbitPeriodicPriorValue({ id, colIndex, sliceIndexes, observedByKey, metric, periodSlices }) {
  const period = Math.max(1, Math.round(numberValue(periodSlices, 0)));
  if (!Number.isFinite(period) || period <= 0) {
    return { value: NaN, count: 0, nearest_period_distance: "", quality: 0 };
  }

  let weighted = 0;
  let weightTotal = 0;
  let count = 0;
  let nearestDistance = Infinity;
  const seen = new Set();
  const addCandidate = (index, distance) => {
    if (index < 0 || index >= sliceIndexes.length || seen.has(index)) return;
    seen.add(index);
    const observed = observedByKey.get(`${sliceIndexes[index]}|${id}`);
    const value = metric.observedValue(observed);
    if (!boolValue(observed?.observed) || !Number.isFinite(value)) return;
    const weight = 1 / Math.max(distance, 1);
    weighted += value * weight;
    weightTotal += weight;
    count += 1;
    nearestDistance = Math.min(nearestDistance, distance);
  };

  for (let multiple = 1; multiple <= 3; multiple += 1) {
    const distance = period * multiple;
    addCandidate(colIndex - distance, distance);
    addCandidate(colIndex + distance, distance);
  }

  return {
    value: weightTotal > 0 ? weighted / weightTotal : NaN,
    count,
    nearest_period_distance: Number.isFinite(nearestDistance) ? nearestDistance : "",
    quality: count > 0 ? clamp(count / 2, 0, 1) : 0,
  };
}

function oamObservationQuality(row, enabled) {
  if (!enabled || !row) {
    return {
      confidence: 1,
      source_confidence: "",
      confidence_state: "",
      conflict_severity: 0,
      confidence_penalty: 0,
      applied: false,
      tags: "disabled",
    };
  }
  const sourceConfidence = clamp(numberValue(row.confidence, 1), 0, 1);
  const conflict = clamp(Math.max(numberValue(row.conflict_severity, 0), numberValue(row.conflict_ratio, 0)), 0, 1);
  const conflictPenalty = clamp(conflict * 0.45, 0, 0.45);
  const adjustedConfidence = clamp(sourceConfidence * (1 - conflictPenalty), 0.05, 1);
  const confidencePenalty = clamp(1 - adjustedConfidence, 0, 1);
  const applied = adjustedConfidence < 0.995 || conflict > 0;
  return {
    confidence: adjustedConfidence,
    source_confidence: sourceConfidence,
    confidence_state: row.confidence_state ?? "",
    conflict_severity: conflict,
    confidence_penalty: confidencePenalty,
    applied,
    tags: [
      sourceConfidence < 0.5 ? "low-oam-confidence" : "",
      conflict > 0.2 ? "conflicting-oam-reports" : "",
      applied ? "quality-feedback-active" : "quality-feedback-clean",
    ].filter(Boolean).join("|") || "quality-feedback-clean",
  };
}

function linkContextStrength(truth, contactByKey, sliceIndex, linkId) {
  const contact = contactByKey?.get(`${sliceIndex}|${linkId}`);
  const availability = Number.isFinite(numberValue(contact?.p_available, NaN))
    ? numberValue(contact.p_available)
    : Number.isFinite(numberValue(truth?.availability_factor, NaN))
      ? numberValue(truth.availability_factor)
      : boolValue(truth?.is_active)
        ? 0.85
        : 0.2;
  const solarPenalty = boolValue(truth?.solar_interference_blocked) ? 0.18 : 0;
  const restrictionPenalty = truth?.restriction_reason ? 0.12 : 0;
  return clamp(availability - solarPenalty - restrictionPenalty, 0, 1);
}

function latitudeBand(node) {
  const absLat = Math.abs(numberValue(node?.latitude_deg, NaN));
  if (!Number.isFinite(absLat)) return "unknown-latitude";
  if (absLat >= 66) return "polar";
  if (absLat >= 55) return "high-latitude";
  if (absLat <= 20) return "equatorial";
  return "mid-latitude";
}

function linkContextDetails({ truth, contactByKey, sliceIndex, linkId, sourceNode, targetNode, hotspot }) {
  const contact = contactByKey?.get(`${sliceIndex}|${linkId}`);
  const strength = linkContextStrength(truth, contactByKey, sliceIndex, linkId);
  const tags = [truth?.kind || "unknown-link"];
  const availability = Number.isFinite(numberValue(contact?.p_available, NaN))
    ? numberValue(contact.p_available)
    : Number.isFinite(numberValue(truth?.availability_factor, NaN))
      ? numberValue(truth.availability_factor)
      : boolValue(truth?.is_active)
        ? 0.85
        : 0.2;
  const distance = numberValue(truth?.distance_km, NaN);
  const threshold = numberValue(contact?.distance_threshold_km, NaN);
  const distanceRatio = Number.isFinite(distance) && Number.isFinite(threshold) && threshold > 0
    ? distance / threshold
    : NaN;
  const sourceBand = latitudeBand(sourceNode);
  const targetBand = latitudeBand(targetNode);
  const polar = sourceBand === "polar" || targetBand === "polar";
  const highLatitude = polar || sourceBand === "high-latitude" || targetBand === "high-latitude";

  if (!boolValue(truth?.is_active)) tags.push("topology-down-or-warning");
  if (polar) tags.push("polar-region");
  else if (highLatitude) tags.push("high-latitude-region");
  if (truth?.kind === "inter-plane" && highLatitude) tags.push("inter-plane-latitude-sensitive");
  if (boolValue(truth?.solar_interference_blocked)) tags.push("solar-interference-risk");
  if (truth?.restriction_reason) tags.push(`restriction-${String(truth.restriction_reason).replaceAll(" ", "-")}`);
  if (availability < 0.55) tags.push("low-contact-availability");
  else if (availability < 0.8) tags.push("medium-contact-availability");
  if (Number.isFinite(distanceRatio) && distanceRatio > 0.9) tags.push("near-range-limit");
  if (numberValue(truth?.utilization_percent) >= 70) tags.push("high-utilization");
  if (numberValue(truth?.congestion_percent) > 0) tags.push("congested");
  if (numberValue(hotspot?.business_hotspot_score) > 0.35) tags.push("business-hotspot");

  const risk = clamp(
    (1 - strength) * 0.52 +
      (polar && truth?.kind === "inter-plane" ? 0.12 : 0) +
      (Number.isFinite(distanceRatio) ? clamp((distanceRatio - 0.75) * 0.35, 0, 0.12) : 0) +
      clamp(numberValue(truth?.congestion_percent) / 100, 0, 0.08) +
      clamp(numberValue(hotspot?.business_hotspot_score) * 0.08, 0, 0.08),
    0,
    1,
  );

  return {
    strength: round(strength),
    risk: round(risk),
    tags: unique(tags).join(" > "),
    latitude_context: `${sourceBand}->${targetBand}`,
    distance_to_threshold_ratio: Number.isFinite(distanceRatio) ? round(distanceRatio) : "",
    availability_context: round(availability),
  };
}

function nodeContextStrength(node) {
  const solarExposure = clamp(numberValue(node?.solar_exposure, boolValue(node?.in_sunlight) ? 1 : 0), 0, 1);
  const netPowerW = numberValue(node?.net_power_w, 0);
  const powerMargin = clamp((netPowerW + 400) / 800, 0, 1);
  const powerSavingPenalty = boolValue(node?.power_saving_mode) ? 0.18 : 0;
  return clamp(0.35 + 0.35 * solarExposure + 0.2 * powerMargin - powerSavingPenalty, 0.05, 0.95);
}

function nodeContextDetails(node) {
  const strength = nodeContextStrength(node);
  const solarExposure = clamp(numberValue(node?.solar_exposure, boolValue(node?.in_sunlight) ? 1 : 0), 0, 1);
  const energy = numberValue(node?.energy_percent, 100);
  const queueDepth = numberValue(node?.queue_depth);
  const transitTraffic = numberValue(node?.transit_traffic_mbps);
  const tags = [latitudeBand(node)];
  if (boolValue(node?.in_sunlight)) tags.push("sunlit");
  else tags.push("shadow");
  if (solarExposure < 0.2) tags.push("low-solar-exposure");
  if (energy < 30) tags.push("low-energy");
  if (boolValue(node?.power_saving_mode)) tags.push("power-saving");
  if (queueDepth >= 16) tags.push("high-queue");
  if (transitTraffic >= 250) tags.push("traffic-hotspot");
  if (numberValue(node?.dropped_traffic_mb) > 0) tags.push("dropped-traffic");
  const risk = clamp(
    (1 - strength) * 0.5 +
      clamp((30 - energy) / 100, 0, 0.12) +
      clamp(queueDepth / 128, 0, 0.12) +
      clamp(transitTraffic / 4000, 0, 0.08),
    0,
    1,
  );
  return {
    strength: round(strength),
    risk: round(risk),
    tags: unique(tags).join(" > "),
    latitude_context: latitudeBand(node),
    illumination_context: boolValue(node?.in_sunlight) ? "sunlit" : "shadow",
    solar_exposure_context: round(solarExposure),
  };
}

function buildNodeSpatialPriorStats({ metric, nodeIds, sliceIndexes, truthByKey, observedByKey }) {
  const groups = new Map();
  nodeIds.forEach((nodeId) => {
    sliceIndexes.forEach((sliceIndex) => {
      const truth = truthByKey.get(`${sliceIndex}|${nodeId}`);
      const observed = observedByKey.get(`${sliceIndex}|${nodeId}`);
      const value = metric.observedValue(observed);
      if (!truth || !boolValue(observed?.observed) || !Number.isFinite(value)) return;
      const key = nodeSpatialGroupKey(truth);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(value);
    });
  });
  const stats = new Map();
  for (const [key, values] of groups.entries()) {
    stats.set(key, {
      count: values.length,
      mean: mean(values),
    });
  }
  return stats;
}

function buildNodeEnergyContextPriorStats({ metric, nodeIds, sliceIndexes, truthByKey, observedByKey }) {
  if (metric.name !== "energy_percent") {
    return {
      bySliceAndGroup: new Map(),
      byGroup: new Map(),
    };
  }
  const bySliceAndGroupRaw = new Map();
  const byGroupRaw = new Map();
  const add = (map, key, value) => {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(value);
  };
  nodeIds.forEach((nodeId) => {
    sliceIndexes.forEach((sliceIndex) => {
      const truth = truthByKey.get(`${sliceIndex}|${nodeId}`);
      const observed = observedByKey.get(`${sliceIndex}|${nodeId}`);
      const value = metric.observedValue(observed);
      if (!truth || !boolValue(observed?.observed) || !Number.isFinite(value)) return;
      const group = nodeIlluminationGroupKey(truth);
      add(bySliceAndGroupRaw, `${sliceIndex}|${group}`, value);
      add(byGroupRaw, group, value);
    });
  });
  const summarize = (raw) => {
    const stats = new Map();
    for (const [key, values] of raw.entries()) {
      stats.set(key, {
        count: values.length,
        mean: mean(values),
      });
    }
    return stats;
  };
  return {
    bySliceAndGroup: summarize(bySliceAndGroupRaw),
    byGroup: summarize(byGroupRaw),
  };
}

function nodeEnergyContextPriorValue({ truth, sliceIndex, stats }) {
  if (!truth || !stats) return { value: NaN, weight: 0, source: "", group: "" };
  const group = nodeIlluminationGroupKey(truth);
  const sameSlice = stats.bySliceAndGroup.get(`${sliceIndex}|${group}`);
  if (sameSlice && sameSlice.count >= 3) {
    return {
      value: sameSlice.mean,
      weight: clamp(0.22 + Math.min(sameSlice.count, 24) / 24 * 0.22, 0.22, 0.44),
      source: "same-slice-illumination",
      group,
    };
  }
  const historical = stats.byGroup.get(group);
  if (historical && historical.count >= 6) {
    return {
      value: historical.mean,
      weight: clamp(0.16 + Math.min(historical.count, 96) / 96 * 0.18, 0.16, 0.34),
      source: "historical-illumination",
      group,
    };
  }
  return { value: NaN, weight: 0, source: "", group };
}

function inferNodeSliceStepHours({ nodeIds, sliceIndexes, truthByKey }) {
  const timestamps = [];
  for (const nodeId of nodeIds.slice(0, Math.min(nodeIds.length, 16))) {
    for (const sliceIndex of sliceIndexes) {
      const timeMs = Date.parse(truthByKey.get(`${sliceIndex}|${nodeId}`)?.time ?? "");
      if (Number.isFinite(timeMs)) timestamps.push(timeMs);
    }
    if (timestamps.length >= 4) break;
  }
  const uniqueTimes = [...new Set(timestamps)].sort((left, right) => left - right);
  const deltas = [];
  for (let index = 1; index < uniqueTimes.length; index += 1) {
    const deltaHours = (uniqueTimes[index] - uniqueTimes[index - 1]) / 3_600_000;
    if (deltaHours > 0 && deltaHours < 24) deltas.push(deltaHours);
  }
  return deltas.length > 0 ? percentile(deltas, 0.5) : 5 / 60;
}

function nodeEnergyPhysicsStepPercent({ previousPercent, truth, stepHours }) {
  return propagateEnergyPercent({ previousPercent, context: truth, stepHours });
}

function applyNodeEnergyPhysicsPrior({
  enabled,
  metric,
  nodeIds,
  sliceIndexes,
  truthByKey,
  observedMask,
  estimates,
  confidence,
}) {
  const prior = new Map();
  if (!enabled || metric.name !== "energy_percent") {
    return { prior, appliedValues: 0, meanWeight: 0 };
  }
  const stepHours = inferNodeSliceStepHours({ nodeIds, sliceIndexes, truthByKey });
  let appliedValues = 0;
  const weights = [];
  nodeIds.forEach((nodeId, rowIndex) => {
    let previousPercent = NaN;
    let previousSource = "";
    sliceIndexes.forEach((sliceIndex, colIndex) => {
      const key = `${sliceIndex}|${nodeId}`;
      const truth = truthByKey.get(key);
      const current = estimates.get(key);
      const observed = observedMask[rowIndex]?.[colIndex] === true;
      if (observed) {
        previousPercent = current;
        previousSource = "observed";
        return;
      }
      const predicted = nodeEnergyPhysicsStepPercent({ previousPercent, truth, stepHours });
      if (!Number.isFinite(predicted) || !Number.isFinite(current)) {
        previousPercent = Number.isFinite(current) ? current : previousPercent;
        previousSource = Number.isFinite(current) ? "matrix-completion" : previousSource;
        return;
      }
      const delta = Math.abs(predicted - current);
      const predictedNetPowerW = predictNetPowerFromObservableContext(truth);
      const netPowerW = Math.abs(predictedNetPowerW);
      const highConfidenceChain = previousSource === "observed" || previousSource === "physics-prior";
      const weight = highConfidenceChain
        ? clamp(0.78 + Math.min(netPowerW, 480) / 480 * 0.16 + Math.min(delta, 18) / 18 * 0.06, 0.78, 0.97)
        : clamp(0.42 + Math.min(netPowerW, 480) / 480 * 0.16 + Math.min(delta, 18) / 18 * 0.12, 0.42, 0.7);
      const corrected = metric.clamp(current * (1 - weight) + predicted * weight);
      estimates.set(key, corrected);
      const currentConfidence = confidence.get(key) ?? 0.25;
      confidence.set(key, clamp(currentConfidence + 0.05 * weight, 0.05, 0.95));
      prior.set(key, {
        applied: true,
        value: round(predicted),
        weight: round(weight),
        source: "battery-state-propagation",
        before: round(current),
        after: round(corrected),
        net_power_w: round(predictedNetPowerW),
        step_hours: round(stepHours, 6),
      });
      previousPercent = corrected;
      previousSource = "physics-prior";
      appliedValues += 1;
      weights.push(weight);
    });
  });
  return { prior, appliedValues, meanWeight: round(mean(weights)) };
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

const COMPLETION_BACKENDS = new Set([
  "low-rank",
  "st-gnn",
  "costco",
  "joint-cp",
  "joint-cp-physics",
  ...ADDITIONAL_COMPLETION_BACKENDS,
]);

function isJointTensorBackend(backend) {
  return backend === "joint-cp" || backend === "joint-cp-physics";
}

function normalizeCompletionBackend(value) {
  const text = String(value || "low-rank").trim().toLowerCase();
  if (["prior", "prior-initialization", "structural-prior", "initialization-only"].includes(text)) return "prior-only";
  if (["lowrank", "svd", "pca", "original", "legacy"].includes(text)) return "low-rank";
  if (["softimpute", "soft-imputation", "nuclear-norm", "svt"].includes(text)) return "soft-impute";
  if (["kalman", "kalman-filter", "rts", "rts-smoother", "temporal-kalman"].includes(text)) return "kalman-smoother";
  if (["graph-neighbors", "neighbor-interpolation", "graph-interpolation", "harmonic"].includes(text)) return "graph-neighbor";
  if (["graph", "graph-laplacian", "graph-regularization", "grmc"].includes(text)) return "graph-regularized";
  if (["joint", "joint-tensor", "multi-metric", "multi-metric-cp", "tensor-cp"].includes(text)) return "joint-cp";
  if (["joint-physics", "joint-tensor-physics", "multi-metric-physics", "physics-cp"].includes(text)) return "joint-cp-physics";
  if (["stgnn", "st-gcn", "gcn-gru", "spatio-temporal-gnn", "graph-temporal"].includes(text)) return "st-gnn";
  if (["co-stco", "tensor", "neural-tensor", "tensor-completion"].includes(text)) return "costco";
  if (COMPLETION_BACKENDS.has(text)) return text;
  throw new Error(
    `Unsupported INT-MC completion backend: ${value}. Use prior-only, low-rank, soft-impute, kalman-smoother, graph-neighbor, graph-regularized, st-gnn, costco, joint-cp, or joint-cp-physics.`,
  );
}

function completionBackendFamily(backend) {
  if (backend === "joint-cp") return "multi-metric-orbit-aware-cp-tensor-completion";
  if (backend === "joint-cp-physics") return "physics-projected-multi-metric-cp-tensor-completion";
  if (backend === "prior-only") return "structure-prior-no-learning-baseline";
  if (backend === "soft-impute") return "classical-nuclear-norm-matrix-completion";
  if (backend === "kalman-smoother") return "classical-offline-kalman-rts-temporal-smoothing";
  if (backend === "graph-neighbor") return "classical-orbit-graph-neighbor-interpolation";
  if (backend === "graph-regularized") return "graph-temporal-regularized-matrix-completion";
  if (backend === "st-gnn") return "machine-learning-spatio-temporal-graph";
  if (backend === "costco") return "machine-learning-coordinate-tensor";
  return "structure-prior-low-rank";
}

function completionStackLabel(backend, options = {}) {
  const priors = ["temporal-neighbor", "tensor-neighbor"];
  if (options.orbitPeriodicPriorEnabled) priors.push("orbit-periodic");
  if (options.businessHotspotMigrationPriorEnabled) priors.push("business-hotspot-migration");
  priors.push("same-slice-spatial", "historical-spatial");
  if (options.stateTensorJointCompletionEnabled) priors.push("state-tensor-joint");
  if (backend === "joint-cp") return [...priors, "multi-metric-joint-cp"].join("+");
  if (backend === "joint-cp-physics") return [...priors, "multi-metric-joint-cp", "physics-projection"].join("+");
  if (backend === "prior-only") return [...priors, "prior-only"].join("+");
  if (backend === "soft-impute") return [...priors, "soft-impute"].join("+");
  if (backend === "kalman-smoother") return [...priors, "kalman-rts-smoother"].join("+");
  if (backend === "graph-neighbor") return [...priors, "graph-neighbor"].join("+");
  if (backend === "graph-regularized") return [...priors, "graph-regularized"].join("+");
  if (backend === "st-gnn") return [...priors, "st-gnn"].join("+");
  if (backend === "costco") return [...priors, "costco"].join("+");
  return [...priors, "low-rank"].join("+");
}

function matrixMean(values) {
  const finite = values.filter(Number.isFinite);
  return finite.length ? mean(finite) : 0;
}

function observedPositions(activeMask, observedMask) {
  const positions = [];
  for (let row = 0; row < activeMask.length; row += 1) {
    for (let col = 0; col < activeMask[row].length; col += 1) {
      if (activeMask[row][col] && observedMask[row][col]) positions.push([row, col]);
    }
  }
  return positions;
}

function deterministicSamplePositions(positions, limit) {
  if (!Number.isFinite(limit) || limit <= 0 || positions.length <= limit) return positions;
  const step = positions.length / limit;
  return Array.from({ length: Math.max(1, Math.floor(limit)) }, (_, index) => positions[Math.min(positions.length - 1, Math.floor(index * step))]);
}

function lockObservedEntries(completed, sourceMatrix, activeMask, observedMask) {
  for (let row = 0; row < completed.length; row += 1) {
    for (let col = 0; col < completed[row].length; col += 1) {
      if (!activeMask[row][col]) completed[row][col] = 0;
      else if (observedMask[row][col]) completed[row][col] = sourceMatrix[row][col];
    }
  }
}

function neighborRowsFromIds(rowIds, neighborIdLists) {
  const rowIndexById = new Map(rowIds.map((id, index) => [id, index]));
  return rowIds.map((_, rowIndex) =>
    (neighborIdLists?.[rowIndex] ?? [])
      .map((id) => rowIndexById.get(id))
      .filter((index) => Number.isInteger(index) && index >= 0 && index !== rowIndex),
  );
}

function observedRowColumnStats(matrix, activeMask, observedMask) {
  const rows = matrix.length;
  const cols = rows ? matrix[0].length : 0;
  const rowSums = Array.from({ length: rows }, () => 0);
  const rowCounts = Array.from({ length: rows }, () => 0);
  const colSums = Array.from({ length: cols }, () => 0);
  const colCounts = Array.from({ length: cols }, () => 0);
  const values = [];

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      if (!activeMask[row][col] || !observedMask[row][col]) continue;
      const value = matrix[row][col];
      if (!Number.isFinite(value)) continue;
      rowSums[row] += value;
      rowCounts[row] += 1;
      colSums[col] += value;
      colCounts[col] += 1;
      values.push(value);
    }
  }

  const global = matrixMean(values);
  return {
    global,
    rowMeans: rowSums.map((sum, index) => (rowCounts[index] > 0 ? sum / rowCounts[index] : global)),
    colMeans: colSums.map((sum, index) => (colCounts[index] > 0 ? sum / colCounts[index] : global)),
    rowCounts,
    colCounts,
  };
}

function averageFinite(values, fallback) {
  const finite = values.filter(Number.isFinite);
  return finite.length ? mean(finite) : fallback;
}

function paddedFeatures(rowFeatures, rowIndex, count = 6) {
  const values = rowFeatures?.[rowIndex] ?? [];
  return Array.from({ length: count }, (_, index) => numberValue(values[index], 0));
}

function boundedFeatures(features) {
  return features.map((value) => clamp(numberValue(value, 0), -6, 6));
}

function featureDistance(left = [], right = []) {
  const length = Math.max(left.length, right.length);
  let total = 0;
  for (let index = 0; index < length; index += 1) {
    total += (numberValue(left[index], 0) - numberValue(right[index], 0)) ** 2;
  }
  return Math.sqrt(total);
}

function stGnnSpatialAggregate({ currentMatrix, activeMask, neighborRows, rowFeatures, rowIndex, colIndex, fallback }) {
  const neighborValues = [];
  const sourceFeatures = rowFeatures?.[rowIndex] ?? [];
  (neighborRows[rowIndex] ?? []).forEach((neighborIndex) => {
    if (!activeMask[neighborIndex]?.[colIndex]) return;
    const value = currentMatrix[neighborIndex]?.[colIndex];
    if (!Number.isFinite(value)) return;
    const distance = featureDistance(sourceFeatures, rowFeatures?.[neighborIndex] ?? []);
    const attention = Math.exp(-2.2 * distance);
    neighborValues.push({ value, attention });
  });
  if (neighborValues.length === 0) {
    return {
      mean: fallback,
      min: fallback,
      max: fallback,
      spread: 0,
      countNorm: 0,
    };
  }
  const weightTotal = neighborValues.reduce((total, item) => total + item.attention, 0) || 1;
  const weightedMean = neighborValues.reduce((total, item) => total + item.value * item.attention, 0) / weightTotal;
  const values = neighborValues.map((item) => item.value);
  return {
    mean: weightedMean,
    min: Math.min(...values),
    max: Math.max(...values),
    spread: Math.max(...values) - Math.min(...values),
    countNorm: clamp(neighborValues.length / 4, 0, 1),
  };
}

function stGnnFeatureVector({ priorMatrix, currentMatrix, activeMask, neighborRows, stats, rowFeatures, rowIndex, colIndex }) {
  const cols = currentMatrix[rowIndex].length;
  const selfPrior = priorMatrix[rowIndex][colIndex];
  const previous = colIndex > 0 && activeMask[rowIndex][colIndex - 1] ? currentMatrix[rowIndex][colIndex - 1] : selfPrior;
  const next = colIndex + 1 < cols && activeMask[rowIndex][colIndex + 1] ? currentMatrix[rowIndex][colIndex + 1] : selfPrior;
  const temporalValues = [previous, next].filter(Number.isFinite);
  const temporal = averageFinite(temporalValues, selfPrior);
  const temporalSlope = next - previous;
  const temporalSpread = Math.abs(next - previous);
  const spatial = stGnnSpatialAggregate({
    currentMatrix,
    activeMask,
    neighborRows,
    rowFeatures,
    rowIndex,
    colIndex,
    fallback: selfPrior,
  });
  const rowMean = stats.rowMeans[rowIndex] ?? stats.global;
  const colMean = stats.colMeans[colIndex] ?? stats.global;
  const rowDensity = (stats.rowCounts[rowIndex] ?? 0) / Math.max(cols, 1);
  const colDensity = (stats.colCounts[colIndex] ?? 0) / Math.max(currentMatrix.length, 1);
  const timeNorm = cols > 1 ? colIndex / (cols - 1) : 0;
  const context = paddedFeatures(rowFeatures, rowIndex, 6);
  return boundedFeatures([
    selfPrior,
    previous,
    next,
    temporal,
    temporalSlope,
    temporalSpread,
    spatial.mean,
    spatial.min,
    spatial.max,
    spatial.spread,
    spatial.countNorm,
    rowMean,
    colMean,
    rowDensity,
    colDensity,
    rowMean - colMean,
    temporal - selfPrior,
    spatial.mean - selfPrior,
    timeNorm,
    Math.sin(2 * Math.PI * timeNorm),
    Math.cos(2 * Math.PI * timeNorm),
    ...context,
  ]);
}

function dotFeatures(weights, features) {
  let total = 0;
  for (let index = 0; index < weights.length; index += 1) total += weights[index] * (features[index] ?? 0);
  return total;
}

function createMlpModel(inputSize, hiddenUnits, hiddenLayers, seed = 0, scale = 0.055) {
  const safeHiddenUnits = Math.max(4, Math.floor(hiddenUnits));
  const safeHiddenLayers = Math.max(1, Math.floor(hiddenLayers));
  const layerSizes = [inputSize, ...Array.from({ length: safeHiddenLayers }, () => safeHiddenUnits), 1];
  return {
    inputSize,
    hiddenUnits: safeHiddenUnits,
    hiddenLayers: safeHiddenLayers,
    weights: layerSizes.slice(1).map((outputSize, layerIndex) => {
      const inputLayerSize = layerSizes[layerIndex];
      const layerScale = scale / Math.sqrt(Math.max(inputLayerSize, 1));
      return Array.from({ length: outputSize }, (_, outputIndex) =>
        Array.from({ length: inputLayerSize }, (_, inputIndex) =>
          initialFactor(seed + layerIndex * 997 + outputIndex * 37 + inputIndex, outputIndex + layerIndex + 3, layerScale),
        ),
      );
    }),
    biases: layerSizes.slice(1).map((outputSize, layerIndex) =>
      Array.from({ length: outputSize }, (_, outputIndex) => initialFactor(seed + layerIndex * 101 + outputIndex, outputIndex + 5, 0.01)),
    ),
  };
}

function mlpParameterCount(model) {
  return model.weights.reduce((total, layer) => total + layer.reduce((sum, row) => sum + row.length, 0), 0) +
    model.biases.reduce((total, layer) => total + layer.length, 0);
}

function mlpForward(model, inputs) {
  const activations = [inputs];
  let current = inputs;
  model.weights.forEach((weights, layerIndex) => {
    const isOutputLayer = layerIndex === model.weights.length - 1;
    const next = weights.map((row, outputIndex) => {
      const value = dotFeatures(row, current) + model.biases[layerIndex][outputIndex];
      return isOutputLayer ? value : Math.tanh(value);
    });
    activations.push(next);
    current = next;
  });
  return {
    activations,
    output: current[0] ?? 0,
  };
}

function updateMlp(model, forward, outputGradient, learningRate, l2) {
  let delta = [clamp(outputGradient, -8, 8)];
  for (let layerIndex = model.weights.length - 1; layerIndex >= 0; layerIndex -= 1) {
    const previousActivations = forward.activations[layerIndex];
    const oldWeights = model.weights[layerIndex].map((row) => [...row]);
    const nextDelta = layerIndex > 0 ? Array.from({ length: previousActivations.length }, () => 0) : [];

    for (let outputIndex = 0; outputIndex < model.weights[layerIndex].length; outputIndex += 1) {
      for (let inputIndex = 0; inputIndex < model.weights[layerIndex][outputIndex].length; inputIndex += 1) {
        if (layerIndex > 0) {
          nextDelta[inputIndex] += delta[outputIndex] * oldWeights[outputIndex][inputIndex] * (1 - previousActivations[inputIndex] ** 2);
        }
        model.weights[layerIndex][outputIndex][inputIndex] -= learningRate * (
          delta[outputIndex] * previousActivations[inputIndex] +
          l2 * model.weights[layerIndex][outputIndex][inputIndex]
        );
      }
      model.biases[layerIndex][outputIndex] -= learningRate * delta[outputIndex];
    }
    delta = nextDelta;
  }
}

function researchScaleHiddenUnits(options, fallback = 64) {
  return Math.max(16, Math.floor(numberValue(options.hiddenUnits, fallback)));
}

function researchScaleHiddenLayers(options, fallback = 2) {
  return Math.max(1, Math.floor(numberValue(options.hiddenLayers, fallback)));
}

function stGnnForward(model, features) {
  const residual = mlpForward(model, features).output;
  return {
    correction: residual,
    prediction: features[0] + residual,
  };
}

function trainStGnnWeights({ matrix, activeMask, observedMask, neighborRows, rowFeatures, rank, iterations, options }) {
  const stats = observedRowColumnStats(matrix, activeMask, observedMask);
  const allPositions = observedPositions(activeMask, observedMask);
  const trainingLimit = Math.max(1, Math.floor(options.trainingSamples));
  const trainingPositions = deterministicSamplePositions(allPositions, trainingLimit);
  const sampleFeature = stGnnFeatureVector({
    priorMatrix: matrix,
    currentMatrix: matrix,
    activeMask,
    neighborRows,
    stats,
    rowFeatures,
    rowIndex: trainingPositions[0]?.[0] ?? 0,
    colIndex: trainingPositions[0]?.[1] ?? 0,
  });
  const featureCount = sampleFeature.length;
  const hiddenUnits = researchScaleHiddenUnits(options, Math.max(64, Math.floor(rank * 8 + 32)));
  const hiddenLayers = researchScaleHiddenLayers(options, 2);
  const model = createMlpModel(featureCount, hiddenUnits, hiddenLayers, 113, 0.07);
  const epochs = Math.max(1, Math.floor(options.epochs || iterations));
  const learningRate = numberValue(options.learningRate, 0.012);
  const l2 = 0.0009;
  let currentMatrix = matrix.map((row) => [...row]);

  for (let epoch = 0; epoch < epochs; epoch += 1) {
    trainingPositions.forEach(([rowIndex, colIndex]) => {
      const features = stGnnFeatureVector({
        priorMatrix: matrix,
        currentMatrix,
        activeMask,
        neighborRows,
        stats,
        rowFeatures,
        rowIndex,
        colIndex,
      });
      const forward = stGnnForward(model, features);
      const error = clamp(forward.prediction - matrix[rowIndex][colIndex], -6, 6);
      updateMlp(model, mlpForward(model, features), error, learningRate, l2);
    });
    if (epoch % 2 === 1) {
      const next = currentMatrix.map((row) => [...row]);
      for (let rowIndex = 0; rowIndex < matrix.length; rowIndex += 1) {
        for (let colIndex = 0; colIndex < matrix[rowIndex].length; colIndex += 1) {
          if (!activeMask[rowIndex][colIndex] || observedMask[rowIndex][colIndex]) continue;
          const features = stGnnFeatureVector({
            priorMatrix: matrix,
            currentMatrix,
            activeMask,
            neighborRows,
            stats,
            rowFeatures,
            rowIndex,
            colIndex,
          });
          next[rowIndex][colIndex] = 0.62 * stGnnForward(model, features).prediction + 0.38 * currentMatrix[rowIndex][colIndex];
        }
      }
      lockObservedEntries(next, matrix, activeMask, observedMask);
      currentMatrix = next;
    }
  }

  return { model, stats, trainingPositions: trainingPositions.length, featureCount, hiddenUnits, hiddenLayers };
}

function completeWithStGnn({ matrix, activeMask, observedMask, rank, iterations, neighborRows, rowFeatures, options }) {
  const trained = trainStGnnWeights({ matrix, activeMask, observedMask, neighborRows, rowFeatures, rank, iterations, options });
  let completed = matrix.map((row) => [...row]);
  const passes = Math.max(1, Math.min(Math.max(2, iterations), Math.max(2, rank * 2)));
  for (let pass = 0; pass < passes; pass += 1) {
    const next = completed.map((row) => [...row]);
    for (let rowIndex = 0; rowIndex < matrix.length; rowIndex += 1) {
      for (let colIndex = 0; colIndex < matrix[rowIndex].length; colIndex += 1) {
        if (!activeMask[rowIndex][colIndex] || observedMask[rowIndex][colIndex]) continue;
        const features = stGnnFeatureVector({
          priorMatrix: matrix,
          currentMatrix: completed,
          activeMask,
          neighborRows,
          stats: trained.stats,
          rowFeatures,
          rowIndex,
          colIndex,
        });
        next[rowIndex][colIndex] = 0.68 * stGnnForward(trained.model, features).prediction + 0.32 * matrix[rowIndex][colIndex];
      }
    }
    lockObservedEntries(next, matrix, activeMask, observedMask);
    completed = next;
  }
  return {
    completed,
    diagnostics: {
      ml_training_samples: trained.trainingPositions,
      ml_epochs: Math.max(1, Math.floor(options.epochs || iterations)),
      ml_message_passing_passes: passes,
      ml_feature_count: trained.featureCount,
      ml_hidden_units: trained.hiddenUnits,
      ml_hidden_layers: trained.hiddenLayers,
      ml_parameter_count: mlpParameterCount(trained.model),
      ml_model_architecture: "research-scale-attention-temporal-residual-mlp-st-gnn",
    },
  };
}

function initialFactor(index, component, scale = 0.06) {
  return scale * Math.sin((index + 1) * (component + 1) * 1.61803398875);
}

function costcoCoordFeatures(rowFeatures, rowIndex, colIndex, cols) {
  const timeNorm = cols > 1 ? colIndex / (cols - 1) : 0;
  const context = paddedFeatures(rowFeatures, rowIndex, 6);
  return boundedFeatures([
    1,
    timeNorm,
    timeNorm ** 2,
    Math.sin(2 * Math.PI * timeNorm),
    Math.cos(2 * Math.PI * timeNorm),
    ...context,
    ...context.map((value) => value * timeNorm),
  ]);
}

function completeWithCostco({ matrix, activeMask, observedMask, rank, iterations, rowFeatures, options }) {
  const rows = matrix.length;
  const cols = rows ? matrix[0].length : 0;
  const allPositions = observedPositions(activeMask, observedMask);
  const trainingPositions = deterministicSamplePositions(allPositions, Math.max(1, Math.floor(options.trainingSamples)));
  const stats = observedRowColumnStats(matrix, activeMask, observedMask);
  const latentRank = Math.max(16, Math.floor(numberValue(options.latentRank, Math.max(32, rank * 8))));
  const rowFactors = Array.from({ length: rows }, (_, rowIndex) =>
    Array.from({ length: latentRank }, (_, component) => initialFactor(rowIndex, component)),
  );
  const colFactors = Array.from({ length: cols }, (_, colIndex) =>
    Array.from({ length: latentRank }, (_, component) => initialFactor(colIndex + 17, component)),
  );
  const rowBias = Array.from({ length: rows }, () => 0);
  const colBias = Array.from({ length: cols }, () => 0);
  const contextFeatureCount = costcoCoordFeatures(rowFeatures, 0, 0, cols).length;
  const contextHiddenUnits = researchScaleHiddenUnits(options, 64);
  const contextHiddenLayers = researchScaleHiddenLayers(options, 2);
  const contextModel = createMlpModel(contextFeatureCount, contextHiddenUnits, contextHiddenLayers, 317, 0.06);
  let globalBias = stats.global;
  const epochs = Math.max(1, Math.floor(options.epochs || iterations));
  const learningRate = numberValue(options.learningRate, 0.009);
  const l2 = 0.0012;

  const predict = (rowIndex, colIndex) => {
    let value = globalBias + rowBias[rowIndex] + colBias[colIndex];
    for (let component = 0; component < latentRank; component += 1) {
      value += rowFactors[rowIndex][component] * colFactors[colIndex][component];
    }
    const coord = costcoCoordFeatures(rowFeatures, rowIndex, colIndex, cols);
    value += mlpForward(contextModel, coord).output;
    return value;
  };

  for (let epoch = 0; epoch < epochs; epoch += 1) {
    trainingPositions.forEach(([rowIndex, colIndex]) => {
      const predicted = predict(rowIndex, colIndex);
      const error = clamp(predicted - matrix[rowIndex][colIndex], -6, 6);
      globalBias -= learningRate * error * 0.1;
      rowBias[rowIndex] -= learningRate * (error + l2 * rowBias[rowIndex]);
      colBias[colIndex] -= learningRate * (error + l2 * colBias[colIndex]);
      for (let component = 0; component < latentRank; component += 1) {
        const rowValue = rowFactors[rowIndex][component];
        const colValue = colFactors[colIndex][component];
        rowFactors[rowIndex][component] -= learningRate * (error * colValue + l2 * rowValue);
        colFactors[colIndex][component] -= learningRate * (error * rowValue + l2 * colValue);
      }
      const coord = costcoCoordFeatures(rowFeatures, rowIndex, colIndex, cols);
      updateMlp(contextModel, mlpForward(contextModel, coord), error, learningRate, l2);
    });
  }

  const completed = matrix.map((row) => [...row]);
  for (let rowIndex = 0; rowIndex < rows; rowIndex += 1) {
    for (let colIndex = 0; colIndex < cols; colIndex += 1) {
      if (!activeMask[rowIndex][colIndex] || observedMask[rowIndex][colIndex]) continue;
      completed[rowIndex][colIndex] = 0.72 * predict(rowIndex, colIndex) + 0.28 * matrix[rowIndex][colIndex];
    }
  }
  lockObservedEntries(completed, matrix, activeMask, observedMask);

  return {
    completed,
    diagnostics: {
      ml_training_samples: trainingPositions.length,
      ml_epochs: epochs,
      ml_latent_rank: latentRank,
      ml_context_feature_count: contextFeatureCount,
      ml_hidden_units: contextHiddenUnits,
      ml_hidden_layers: contextHiddenLayers,
      ml_parameter_count: mlpParameterCount(contextModel) + rows * latentRank + cols * latentRank + rows + cols + 1,
      ml_model_architecture: "research-scale-neural-cp-coordinate-tensor-costco",
    },
  };
}

function completeWithBackend({ backend, matrix, activeMask, observedMask, rank, iterations, rowIds, neighborIdLists, rowFeatures, options }) {
  const normalizedBackend = normalizeCompletionBackend(backend);
  const startedAt = performance.now();
  const withTiming = (result) => ({
    ...result,
    diagnostics: {
      ...result.diagnostics,
      completion_wall_clock_ms: round(performance.now() - startedAt, 6),
    },
  });
  const neighborRows = neighborRowsFromIds(rowIds, neighborIdLists);

  if (ADDITIONAL_COMPLETION_BACKENDS.has(normalizedBackend)) {
    return withTiming(completeWithAdditionalBackend({
      backend: normalizedBackend,
      matrix,
      activeMask,
      observedMask,
      rank,
      iterations,
      neighborRows,
      options,
    }));
  }
  if (normalizedBackend === "low-rank") {
    let completed = matrix.map((row) => [...row]);
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      completed = lowRankApprox(completed, activeMask, rank);
      lockObservedEntries(completed, matrix, activeMask, observedMask);
    }
    return withTiming({
      completed,
      diagnostics: {
        ml_training_samples: 0,
        ml_epochs: 0,
      },
    });
  }

  if (normalizedBackend === "st-gnn") {
    return withTiming(completeWithStGnn({ matrix, activeMask, observedMask, rank, iterations, neighborRows, rowFeatures, options }));
  }
  return withTiming(completeWithCostco({ matrix, activeMask, observedMask, rank, iterations, rowFeatures, options }));
}

function completeMetricMatrix({ metric, linkIds, sliceIndexes, truthByKey, observedByKey, contactByKey, businessHotspots, rank, iterations, windowSize, completionBackend, completionOptions, orbitPeriodicPriorEnabled, orbitPeriodicPriorSlices, businessHotspotMigrationPriorEnabled }) {
  const activeMask = linkIds.map((linkId) =>
    sliceIndexes.map((sliceIndex) => contactActiveFor(contactByKey, truthByKey.get(`${sliceIndex}|${linkId}`), sliceIndex, linkId)),
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
        completion_backend: completionBackend,
        completion_backend_family: completionBackendFamily(completionBackend),
      },
    };
  }

  const globalMean = mean(observedValues);
  const globalStd = Math.sqrt(mean(observedValues.map((value) => (value - globalMean) ** 2))) || 1;
  const saturation = {
    ...saturationProfile(observedValues),
    refinement_policy: "topology-size-independent-observed-bimodality",
  };
  const linkTensorIndex = buildLinkTensorIndex({ linkIds, sliceIndexes, truthByKey });
  const spatialPriorStats = buildSpatialPriorStats({ metric, linkIds, sliceIndexes, truthByKey, observedByKey });
  const sliceSpatialPriorStats = buildSliceSpatialPriorStats({
    metric,
    ids: linkIds,
    sliceIndexes,
    truthByKey,
    observedByKey,
    groupFn: spatialGroupKey,
  });
  const cols = sliceIndexes.length;
  const columnSums = Array.from({ length: cols }, () => 0);
  const columnCounts = Array.from({ length: cols }, () => 0);
  const rowSums = Array.from({ length: linkIds.length }, () => 0);
  const rowCounts = Array.from({ length: linkIds.length }, () => 0);
  const priorUsage = {
    temporal_neighbor: 0,
    tensor_neighbor: 0,
    orbit_periodic: 0,
    same_slice_spatial_group: 0,
    same_slice_all_groups: 0,
    row_history: 0,
    column_observations: 0,
    historical_spatial_group: 0,
    business_hotspot_migration: 0,
    global_default: 0,
  };

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
      const truth = truthByKey.get(`${sliceIndex}|${linkId}`);
      const group = truth ? spatialGroupKey(truth) : "";
      const temporal = temporalPriorValue({ id: linkId, colIndex, sliceIndexes, observedByKey, metric, windowSize });
      const tensorNeighbor = tensorNeighborPriorValue({
        id: linkId,
        sliceIndex,
        observedByKey,
        metric,
        neighborIds: linkTensorNeighborIds(linkId, linkTensorIndex),
      });
      const orbitPeriodic = orbitPeriodicPriorEnabled
        ? orbitPeriodicPriorValue({ id: linkId, colIndex, sliceIndexes, observedByKey, metric, periodSlices: orbitPeriodicPriorSlices })
        : { value: NaN };
      const directHotspot = businessHotspots?.get(`${sliceIndex}|${linkId}`) ?? {};
      const migrationPrior = hasBusinessHotspot(directHotspot)
        ? emptyBusinessHotspotMigrationPrior(Boolean(businessHotspotMigrationPriorEnabled))
        : businessHotspotMigrationPrior({
            enabled: businessHotspotMigrationPriorEnabled,
            linkId,
            sliceIndex,
            colIndex,
            sliceIndexes,
            businessHotspots,
            linkTensorIndex,
          });
      // Predicted hotspot migration is an advisory sampling signal. Only current
      // direct route evidence may alter reconstructed numeric link state.
      const migrationMetricPrior = NaN;
      if (Number.isFinite(temporal.value) && Number.isFinite(tensorNeighbor.value)) {
        priorUsage.temporal_neighbor += 1;
        priorUsage.tensor_neighbor += 1;
        return ((temporal.value * 0.7 + tensorNeighbor.value * 0.3) - globalMean) / globalStd;
      }
      if (Number.isFinite(temporal.value)) {
        priorUsage.temporal_neighbor += 1;
        return (temporal.value - globalMean) / globalStd;
      }
      if (Number.isFinite(orbitPeriodic.value)) {
        priorUsage.orbit_periodic += 1;
        return (orbitPeriodic.value - globalMean) / globalStd;
      }
      if (Number.isFinite(tensorNeighbor.value)) {
        priorUsage.tensor_neighbor += 1;
        return (tensorNeighbor.value - globalMean) / globalStd;
      }
      const sameSliceGroup = group ? sliceSpatialPriorStats.get(`${sliceIndex}|${group}`) : null;
      if (sameSliceGroup && sameSliceGroup.count > 0) {
        priorUsage.same_slice_spatial_group += 1;
        return (sameSliceGroup.mean - globalMean) / globalStd;
      }
      const sameSliceAll = sliceSpatialPriorStats.get(`${sliceIndex}|__all__`);
      if (sameSliceAll && sameSliceAll.count > 0) {
        priorUsage.same_slice_all_groups += 1;
        return (sameSliceAll.mean - globalMean) / globalStd;
      }
      if (rowCounts[rowIndex] > 0) {
        priorUsage.row_history += 1;
        return rowSums[rowIndex] / rowCounts[rowIndex];
      }
      if (columnCounts[colIndex] > 0) {
        priorUsage.column_observations += 1;
        return columnSums[colIndex] / columnCounts[colIndex];
      }
      const prior = truth ? spatialPriorStats.get(group) : null;
      if (prior && prior.count > 0) {
        priorUsage.historical_spatial_group += 1;
        return (prior.mean - globalMean) / globalStd;
      }
      if (Number.isFinite(migrationMetricPrior)) {
        priorUsage.business_hotspot_migration += 1;
        return (migrationMetricPrior - globalMean) / globalStd;
      }
      priorUsage.global_default += 1;
      return 0;
    }),
  );

  const backendResult = completeWithBackend({
    backend: completionBackend,
    matrix,
    activeMask,
    observedMask,
    rank,
    iterations,
    rowIds: linkIds,
    neighborIdLists: linkIds.map((linkId) => linkTensorNeighborIds(linkId, linkTensorIndex)),
    rowFeatures: buildLinkCompletionRowFeatures({ linkIds, sliceIndexes, truthByKey }),
    options: completionOptions,
  });
  const completed = backendResult.completed;

  const estimates = new Map();
  const confidence = new Map();
  let completedValues = 0;
  let saturationRefinedValues = 0;
  let saturationHighValues = 0;
  let saturationLowValues = 0;
  let businessHotspotMigrationPriorValues = 0;
  linkIds.forEach((linkId, rowIndex) => {
    sliceIndexes.forEach((sliceIndex, colIndex) => {
      if (!activeMask[rowIndex][colIndex]) return;
      const key = `${sliceIndex}|${linkId}`;
      const denormalized = completed[rowIndex][colIndex] * globalStd + globalMean;
      const rawEstimate = metric.clamp(denormalized);
      const rowDensity = rowCounts[rowIndex] / Math.max(sliceIndexes.length, 1);
      const columnDensity = columnCounts[colIndex] / Math.max(linkIds.length, 1);
      const activeDensity = activeMask[rowIndex].filter(Boolean).length / Math.max(sliceIndexes.length, 1);
      const truth = truthByKey.get(`${sliceIndex}|${linkId}`);
      const group = truth ? spatialGroupKey(truth) : "";
      const prior = truth ? spatialPriorStats.get(group) : null;
      const priorDensity = Math.min((prior?.count ?? 0) / Math.max(sliceIndexes.length, 1), 1);
      const sameSlicePrior = group ? sliceSpatialPriorStats.get(`${sliceIndex}|${group}`) : null;
      const sameSliceAll = sliceSpatialPriorStats.get(`${sliceIndex}|__all__`);
      const sameSliceDensity = Math.min((sameSlicePrior?.count ?? 0) / Math.max(linkIds.length, 1), 1);
      const temporal = temporalPriorValue({ id: linkId, colIndex, sliceIndexes, observedByKey, metric, windowSize });
      const temporalQuality = temporal.quality;
      const tensorNeighbor = tensorNeighborPriorValue({
        id: linkId,
        sliceIndex,
        observedByKey,
        metric,
        neighborIds: linkTensorNeighborIds(linkId, linkTensorIndex),
      });
      const orbitPeriodic = orbitPeriodicPriorEnabled
        ? orbitPeriodicPriorValue({ id: linkId, colIndex, sliceIndexes, observedByKey, metric, periodSlices: orbitPeriodicPriorSlices })
        : { quality: 0 };
      const rowValue = rowCounts[rowIndex] > 0 ? (rowSums[rowIndex] / rowCounts[rowIndex]) * globalStd + globalMean : NaN;
      const columnValue = columnCounts[colIndex] > 0 ? (columnSums[colIndex] / columnCounts[colIndex]) * globalStd + globalMean : NaN;
      const directHotspot = businessHotspots?.get(key) ?? {};
      const migrationPrior = hasBusinessHotspot(directHotspot)
        ? emptyBusinessHotspotMigrationPrior(Boolean(businessHotspotMigrationPriorEnabled))
        : businessHotspotMigrationPrior({
            enabled: businessHotspotMigrationPriorEnabled,
            linkId,
            sliceIndex,
            colIndex,
            sliceIndexes,
            businessHotspots,
            linkTensorIndex,
          });
      const hotspot = hasBusinessHotspot(directHotspot) ? directHotspot : {};
      const refined = saturatedUtilizationEstimate({
        metric,
        rawEstimate,
        profile: saturation,
        temporal,
        tensorNeighbor,
        sameSliceGroup: sameSlicePrior,
        sameSliceAll,
        rowValue,
        columnValue,
        historicalPrior: prior,
        hotspot,
      });
      const migrationMetricPrior = NaN;
      let finalEstimate = metric.clamp(refined.value);
      if (Number.isFinite(migrationMetricPrior) && migrationMetricPrior > finalEstimate) {
        const blendWeight = clamp(0.35 + numberValue(migrationPrior.quality, 0) * 0.35, 0.35, 0.72);
        finalEstimate = metric.clamp(finalEstimate * (1 - blendWeight) + migrationMetricPrior * blendWeight);
        businessHotspotMigrationPriorValues += 1;
      }
      if (refined.applied) {
        saturationRefinedValues += 1;
        if (finalEstimate >= 95) saturationHighValues += 1;
        if (finalEstimate <= 5) saturationLowValues += 1;
      }
      estimates.set(key, finalEstimate);
      const contextStrength = truth ? linkContextStrength(truth, contactByKey, sliceIndex, linkId) : 0.5;
      const value = Math.max(
        0.05,
        Math.min(
          0.95,
          0.16 +
            0.32 * rowDensity +
            0.17 * columnDensity +
            0.06 * activeDensity +
            0.09 * priorDensity +
            0.1 * sameSliceDensity +
            0.08 * temporalQuality +
            0.06 * tensorNeighbor.quality +
            0.06 * (orbitPeriodic.quality ?? 0) +
            0.06 * numberValue(migrationPrior.quality, 0) +
            0.07 * contextStrength,
        ),
      );
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
      spatial_prior_groups: spatialPriorStats.size,
      spatial_prior_values: [...spatialPriorStats.values()].reduce((total, item) => total + item.count, 0),
      same_slice_spatial_prior_groups: sliceSpatialPriorStats.size,
      temporal_prior_values: priorUsage.temporal_neighbor,
      tensor_neighbor_prior_values: priorUsage.tensor_neighbor,
      orbit_periodic_prior_enabled: Boolean(orbitPeriodicPriorEnabled),
      orbit_periodic_prior_slices: orbitPeriodicPriorEnabled ? orbitPeriodicPriorSlices : "",
      orbit_periodic_prior_values: priorUsage.orbit_periodic,
      business_hotspot_migration_prior_enabled: Boolean(businessHotspotMigrationPriorEnabled),
      business_hotspot_migration_prior_values: priorUsage.business_hotspot_migration + businessHotspotMigrationPriorValues,
      same_slice_spatial_prior_values: priorUsage.same_slice_spatial_group,
      same_slice_global_prior_values: priorUsage.same_slice_all_groups,
      row_history_prior_values: priorUsage.row_history,
      column_prior_values: priorUsage.column_observations,
      historical_spatial_prior_values: priorUsage.historical_spatial_group,
      global_default_values: priorUsage.global_default,
      global_mean: round(globalMean),
      global_std: round(globalStd),
      saturation_refinement_enabled: Boolean(metric.saturationAware && saturation.enabled),
      saturation_observed_ratio: round(saturation.saturated_ratio),
      saturation_mid_ratio: round(saturation.mid_ratio),
      saturation_shape_strength: round(saturation.shape_strength),
      saturation_scale_guard_link_ids: linkIds.length,
      saturation_scale_guard_policy: saturation.refinement_policy,
      saturation_refined_values: saturationRefinedValues,
      saturation_refined_high_values: saturationHighValues,
      saturation_refined_low_values: saturationLowValues,
      completion_backend: completionBackend,
      completion_backend_family: completionBackendFamily(completionBackend),
      ...backendResult.diagnostics,
    },
  };
}

function completeNodeMetricMatrix({ metric, nodeIds, sliceIndexes, truthByKey, observedByKey, rank, iterations, windowSize, completionBackend, completionOptions, orbitPeriodicPriorEnabled, orbitPeriodicPriorSlices, nodeEnergyPhysicsPriorEnabled }) {
  const activeMask = nodeIds.map(() => sliceIndexes.map(() => true));
  const observedMask = nodeIds.map((nodeId) =>
    sliceIndexes.map((sliceIndex) => boolValue(observedByKey.get(`${sliceIndex}|${nodeId}`)?.observed)),
  );

  const observedValues = [];
  nodeIds.forEach((nodeId) => {
    sliceIndexes.forEach((sliceIndex) => {
      const observed = observedByKey.get(`${sliceIndex}|${nodeId}`);
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
        spatial_prior_groups: 0,
        spatial_prior_values: 0,
        global_mean: "",
        global_std: "",
        completion_backend: completionBackend,
        completion_backend_family: completionBackendFamily(completionBackend),
      },
    };
  }

  const globalMean = mean(observedValues);
  const globalStd = Math.sqrt(mean(observedValues.map((value) => (value - globalMean) ** 2))) || 1;
  const nodeTensorIndex = buildNodeTensorIndex(nodeIds);
  const spatialPriorStats = buildNodeSpatialPriorStats({ metric, nodeIds, sliceIndexes, truthByKey, observedByKey });
  const energyContextPriorStats = orbitPeriodicPriorEnabled
    ? buildNodeEnergyContextPriorStats({ metric, nodeIds, sliceIndexes, truthByKey, observedByKey })
    : { bySliceAndGroup: new Map(), byGroup: new Map() };
  const sliceSpatialPriorStats = buildSliceSpatialPriorStats({
    metric,
    ids: nodeIds,
    sliceIndexes,
    truthByKey,
    observedByKey,
    groupFn: nodeSpatialGroupKey,
  });
  const cols = sliceIndexes.length;
  const columnSums = Array.from({ length: cols }, () => 0);
  const columnCounts = Array.from({ length: cols }, () => 0);
  const rowSums = Array.from({ length: nodeIds.length }, () => 0);
  const rowCounts = Array.from({ length: nodeIds.length }, () => 0);
  const priorUsage = {
    temporal_neighbor: 0,
    tensor_neighbor: 0,
    orbit_periodic: 0,
    same_slice_spatial_group: 0,
    same_slice_all_groups: 0,
    row_history: 0,
    column_observations: 0,
    historical_spatial_group: 0,
    global_default: 0,
  };

  nodeIds.forEach((nodeId, rowIndex) => {
    sliceIndexes.forEach((sliceIndex, colIndex) => {
      const observed = observedByKey.get(`${sliceIndex}|${nodeId}`);
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

  const matrix = nodeIds.map((nodeId, rowIndex) =>
    sliceIndexes.map((sliceIndex, colIndex) => {
      const observed = observedByKey.get(`${sliceIndex}|${nodeId}`);
      const value = metric.observedValue(observed);
      if (observedMask[rowIndex][colIndex] && Number.isFinite(value)) return (value - globalMean) / globalStd;
      const truth = truthByKey.get(`${sliceIndex}|${nodeId}`);
      const group = truth ? nodeSpatialGroupKey(truth) : "";
      const temporal = temporalPriorValue({ id: nodeId, colIndex, sliceIndexes, observedByKey, metric, windowSize });
      const tensorNeighbor = tensorNeighborPriorValue({
        id: nodeId,
        sliceIndex,
        observedByKey,
        metric,
        neighborIds: nodeTensorNeighborIds(nodeId, nodeTensorIndex),
      });
      const orbitPeriodic = orbitPeriodicPriorEnabled
        ? orbitPeriodicPriorValue({ id: nodeId, colIndex, sliceIndexes, observedByKey, metric, periodSlices: orbitPeriodicPriorSlices })
        : { value: NaN };
      if (Number.isFinite(temporal.value) && Number.isFinite(tensorNeighbor.value)) {
        priorUsage.temporal_neighbor += 1;
        priorUsage.tensor_neighbor += 1;
        return ((temporal.value * 0.7 + tensorNeighbor.value * 0.3) - globalMean) / globalStd;
      }
      if (Number.isFinite(temporal.value)) {
        priorUsage.temporal_neighbor += 1;
        return (temporal.value - globalMean) / globalStd;
      }
      if (Number.isFinite(orbitPeriodic.value)) {
        priorUsage.orbit_periodic += 1;
        return (orbitPeriodic.value - globalMean) / globalStd;
      }
      if (Number.isFinite(tensorNeighbor.value)) {
        priorUsage.tensor_neighbor += 1;
        return (tensorNeighbor.value - globalMean) / globalStd;
      }
      const sameSliceGroup = group ? sliceSpatialPriorStats.get(`${sliceIndex}|${group}`) : null;
      if (sameSliceGroup && sameSliceGroup.count > 0) {
        priorUsage.same_slice_spatial_group += 1;
        return (sameSliceGroup.mean - globalMean) / globalStd;
      }
      const sameSliceAll = sliceSpatialPriorStats.get(`${sliceIndex}|__all__`);
      if (sameSliceAll && sameSliceAll.count > 0) {
        priorUsage.same_slice_all_groups += 1;
        return (sameSliceAll.mean - globalMean) / globalStd;
      }
      if (rowCounts[rowIndex] > 0) {
        priorUsage.row_history += 1;
        return rowSums[rowIndex] / rowCounts[rowIndex];
      }
      if (columnCounts[colIndex] > 0) {
        priorUsage.column_observations += 1;
        return columnSums[colIndex] / columnCounts[colIndex];
      }
      const prior = truth ? spatialPriorStats.get(group) : null;
      if (prior && prior.count > 0) {
        priorUsage.historical_spatial_group += 1;
        return (prior.mean - globalMean) / globalStd;
      }
      priorUsage.global_default += 1;
      return 0;
    }),
  );

  const backendResult = completeWithBackend({
    backend: completionBackend,
    matrix,
    activeMask,
    observedMask,
    rank,
    iterations,
    rowIds: nodeIds,
    neighborIdLists: nodeIds.map((nodeId) => nodeTensorNeighborIds(nodeId, nodeTensorIndex)),
    rowFeatures: buildNodeCompletionRowFeatures(nodeIds),
    options: completionOptions,
  });
  const completed = backendResult.completed;

  const estimates = new Map();
  const confidence = new Map();
  const energyContextPrior = new Map();
  let completedValues = 0;
  let energyContextPriorValues = 0;
  nodeIds.forEach((nodeId, rowIndex) => {
    sliceIndexes.forEach((sliceIndex, colIndex) => {
      const key = `${sliceIndex}|${nodeId}`;
      const denormalized = completed[rowIndex][colIndex] * globalStd + globalMean;
      const truth = truthByKey.get(`${sliceIndex}|${nodeId}`);
      const rowDensity = rowCounts[rowIndex] / Math.max(sliceIndexes.length, 1);
      const columnDensity = columnCounts[colIndex] / Math.max(nodeIds.length, 1);
      let estimate = metric.clamp(denormalized);
      const observed = observedMask[rowIndex][colIndex];
      const largeSparseEnergyPrior = nodeIds.length >= 512 && columnDensity < 0.12;
      if (!observed && metric.name === "energy_percent" && orbitPeriodicPriorEnabled && largeSparseEnergyPrior) {
        const contextPrior = nodeEnergyContextPriorValue({ truth, sliceIndex, stats: energyContextPriorStats });
        const effectiveWeight = contextPrior.weight;
        if (Number.isFinite(contextPrior.value) && effectiveWeight > 0) {
          const corrected = metric.clamp(estimate * (1 - effectiveWeight) + contextPrior.value * effectiveWeight);
          energyContextPrior.set(key, {
            applied: true,
            value: round(contextPrior.value),
            weight: round(effectiveWeight),
            source: contextPrior.source,
            group: contextPrior.group,
            before: round(estimate),
            after: round(corrected),
          });
          estimate = corrected;
          energyContextPriorValues += 1;
        }
      }
      estimates.set(key, estimate);
      const group = truth ? nodeSpatialGroupKey(truth) : "";
      const prior = truth ? spatialPriorStats.get(group) : null;
      const priorDensity = Math.min((prior?.count ?? 0) / Math.max(sliceIndexes.length, 1), 1);
      const sameSlicePrior = group ? sliceSpatialPriorStats.get(`${sliceIndex}|${group}`) : null;
      const sameSliceDensity = Math.min((sameSlicePrior?.count ?? 0) / Math.max(nodeIds.length, 1), 1);
      const temporal = temporalPriorValue({ id: nodeId, colIndex, sliceIndexes, observedByKey, metric, windowSize });
      const tensorNeighbor = tensorNeighborPriorValue({
        id: nodeId,
        sliceIndex,
        observedByKey,
        metric,
        neighborIds: nodeTensorNeighborIds(nodeId, nodeTensorIndex),
      });
      const orbitPeriodic = orbitPeriodicPriorEnabled
        ? orbitPeriodicPriorValue({ id: nodeId, colIndex, sliceIndexes, observedByKey, metric, periodSlices: orbitPeriodicPriorSlices })
        : { quality: 0 };
      const contextStrength = truth ? nodeContextStrength(truth) : 0.5;
      confidence.set(
        key,
        Math.max(
          0.05,
          Math.min(
            0.95,
            0.16 +
              0.32 * rowDensity +
              0.18 * columnDensity +
              0.11 * priorDensity +
              0.08 * sameSliceDensity +
              0.08 * temporal.quality +
              0.06 * tensorNeighbor.quality +
              0.06 * (orbitPeriodic.quality ?? 0) +
              0.07 * contextStrength,
          ),
        ),
      );
      completedValues += 1;
    });
  });
  const energyPhysicsPrior = applyNodeEnergyPhysicsPrior({
    enabled: nodeEnergyPhysicsPriorEnabled,
    metric,
    nodeIds,
    sliceIndexes,
    truthByKey,
    observedMask,
    estimates,
    confidence,
  });

  return {
    metric: metric.name,
    estimates,
    confidence,
    energyContextPrior,
    energyPhysicsPrior: energyPhysicsPrior.prior,
    summary: {
      metric: metric.name,
      observed_values: observedValues.length,
      completed_values: completedValues,
      spatial_prior_groups: spatialPriorStats.size,
      spatial_prior_values: [...spatialPriorStats.values()].reduce((total, item) => total + item.count, 0),
      same_slice_spatial_prior_groups: sliceSpatialPriorStats.size,
      temporal_prior_values: priorUsage.temporal_neighbor,
      tensor_neighbor_prior_values: priorUsage.tensor_neighbor,
      orbit_periodic_prior_enabled: Boolean(orbitPeriodicPriorEnabled),
      orbit_periodic_prior_slices: orbitPeriodicPriorEnabled ? orbitPeriodicPriorSlices : "",
      orbit_periodic_prior_values: priorUsage.orbit_periodic,
      energy_context_prior_groups: metric.name === "energy_percent" && orbitPeriodicPriorEnabled ? energyContextPriorStats.byGroup.size : 0,
      energy_context_prior_values: orbitPeriodicPriorEnabled ? energyContextPriorValues : 0,
      energy_physics_prior_enabled: Boolean(nodeEnergyPhysicsPriorEnabled && metric.name === "energy_percent"),
      energy_physics_prior_values: energyPhysicsPrior.appliedValues,
      mean_energy_physics_prior_weight: energyPhysicsPrior.meanWeight,
      same_slice_spatial_prior_values: priorUsage.same_slice_spatial_group,
      same_slice_global_prior_values: priorUsage.same_slice_all_groups,
      row_history_prior_values: priorUsage.row_history,
      column_prior_values: priorUsage.column_observations,
      historical_spatial_prior_values: priorUsage.historical_spatial_group,
      global_default_values: priorUsage.global_default,
      global_mean: round(globalMean),
      global_std: round(globalStd),
      completion_backend: completionBackend,
      completion_backend_family: completionBackendFamily(completionBackend),
      ...backendResult.diagnostics,
    },
  };
}

function applyJointTensorCompletion({
  scope,
  backend,
  metrics,
  objectIds,
  sliceIndexes,
  completedByMetric,
  observedByKey,
  isActive,
  neighborIdsFor,
  options,
}) {
  if (!isJointTensorBackend(backend) || metrics.length < 2) {
    return {
      enabled: false,
      scope,
      backend,
      reason: metrics.length < 2 ? "requires-at-least-two-metrics" : "backend-disabled",
    };
  }

  const metricSpecs = metrics.map((metric) => {
    const observedValues = new Map();
    sliceIndexes.forEach((sliceIndex) => {
      objectIds.forEach((objectId) => {
        if (!isActive({ sliceIndex, objectId, metric: metric.name })) return;
        const key = `${sliceIndex}|${objectId}`;
        const observed = observedByKey.get(key);
        const value = metric.observedValue(observed);
        if (boolValue(observed?.observed) && Number.isFinite(value)) observedValues.set(key, value);
      });
    });
    return {
      name: metric.name,
      priorEstimates: completedByMetric.get(metric.name)?.estimates ?? new Map(),
      observedValues,
      clamp: metric.clamp,
    };
  });
  const neighborObjectIds = new Map(objectIds.map((objectId) => [objectId, neighborIdsFor(objectId)]));
  const result = completeJointMetricTensor({
    timeIds: sliceIndexes,
    objectIds,
    metricSpecs,
    isActive: ({ timeId, objectId, metric }) => isActive({ sliceIndex: timeId, objectId, metric }),
    neighborObjectIds,
    rank: options.rank,
    epochs: options.epochs,
    learningRate: options.learningRate,
    l2: options.l2,
    jointPredictionWeight: options.jointPredictionWeight,
    temporalRegularization: options.temporalRegularization,
    orbitRegularization: options.orbitRegularization,
  });

  metrics.forEach((metric) => {
    const completed = completedByMetric.get(metric.name);
    if (!completed) return;
    completed.estimates = result.estimatesByMetric.get(metric.name) ?? completed.estimates;
    Object.assign(completed.summary, {
      completion_backend: backend,
      completion_backend_family: completionBackendFamily(backend),
      joint_tensor_enabled: true,
      joint_tensor_scope: scope,
      joint_tensor_shape: result.diagnostics.tensor_shape,
      joint_tensor_rank: result.diagnostics.rank,
      joint_tensor_epochs: result.diagnostics.epochs,
      joint_tensor_observed_cells: result.diagnostics.observed_cells,
      joint_tensor_parameter_count: result.diagnostics.parameter_count,
      joint_tensor_final_observed_loss: result.diagnostics.final_observed_loss,
      joint_tensor_prediction_weight: result.diagnostics.joint_prediction_weight,
      joint_tensor_wall_clock_ms: result.diagnostics.wall_clock_ms,
      joint_tensor_normalization_source: result.diagnostics.normalization_source,
    });
  });

  return {
    enabled: true,
    scope,
    backend,
    physics_projection_enabled: backend === "joint-cp-physics",
    ...result.diagnostics,
  };
}

function metricDefinitions() {
  return [
    {
      name: "utilization_percent",
      observedValue: (row) => (row ? numberValue(row.utilization_percent_estimate, NaN) : NaN),
      truthValue: (row) => numberValue(row.utilization_percent, NaN),
      clamp: (value) => Math.max(0, Math.min(100, value)),
      range: 100,
      classThreshold: 70,
      saturationAware: true,
    },
    {
      name: "latency_ms",
      observedValue: (row) => (row ? numberValue(row.latency_ms_estimate, NaN) : NaN),
      truthValue: (row) => numberValue(row.latency_ms, NaN),
      clamp: (value) => Math.max(0, value),
    },
    {
      name: "queue_latency_ms",
      observedValue: (row) => (row ? numberValue(row.queue_latency_ms_estimate, NaN) : NaN),
      truthValue: (row) => numberValue(row.queue_latency_ms, NaN),
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
      range: 100,
      classThreshold: 1,
    },
    {
      name: "queued_traffic_mb",
      observedValue: (row) => (row ? numberValue(row.queued_traffic_mb_estimate, NaN) : NaN),
      truthValue: (row) => numberValue(row.queued_traffic_mb, NaN),
      clamp: (value) => Math.max(0, value),
    },
    {
      name: "dropped_traffic_mb",
      observedValue: (row) => (row ? numberValue(row.dropped_traffic_mb_estimate, NaN) : NaN),
      truthValue: (row) => numberValue(row.dropped_traffic_mb, NaN),
      clamp: (value) => Math.max(0, value),
    },
    {
      name: "packet_error_rate",
      observedValue: (row) => (row ? numberValue(row.packet_error_rate_estimate, NaN) : NaN),
      truthValue: (row) => numberValue(row.packet_error_rate, NaN),
      clamp: (value) => Math.max(0, Math.min(1, value)),
    },
  ];
}

function nodeMetricDefinitions() {
  return [
    {
      name: "cpu_percent",
      observedValue: (row) => (row ? numberValue(row.cpu_percent_estimate, NaN) : NaN),
      truthValue: (row) => numberValue(row.cpu_percent, NaN),
      clamp: (value) => Math.max(0, Math.min(100, value)),
      range: 100,
      classThreshold: 80,
    },
    {
      name: "queue_depth",
      observedValue: (row) => (row ? numberValue(row.queue_depth_estimate, NaN) : NaN),
      truthValue: (row) => numberValue(row.queue_depth, NaN),
      clamp: (value) => Math.max(0, value),
    },
    {
      name: "queued_traffic_mb",
      observedValue: (row) => (row ? numberValue(row.queued_traffic_mb_estimate, NaN) : NaN),
      truthValue: (row) => numberValue(row.queued_traffic_mb, NaN),
      clamp: (value) => Math.max(0, value),
    },
    {
      name: "cache_used_mb",
      observedValue: (row) => (row ? numberValue(row.cache_used_mb_estimate, NaN) : NaN),
      truthValue: (row) => numberValue(row.cache_used_mb, NaN),
      clamp: (value) => Math.max(0, value),
    },
    {
      name: "energy_percent",
      observedValue: (row) => (row ? numberValue(row.energy_percent_estimate, NaN) : NaN),
      truthValue: (row) => numberValue(row.energy_percent, NaN),
      clamp: (value) => Math.max(0, Math.min(100, value)),
    },
  ];
}

function filterMetricsByName(metrics, rawNames, label) {
  const text = String(rawNames || "").trim();
  if (!text) return metrics;
  if (["none", "off", "false", "0"].includes(text.toLowerCase())) return [];
  const requested = text.split(",").map((item) => item.trim()).filter(Boolean);
  const requestedSet = new Set(requested);
  const filtered = metrics.filter((metric) => requestedSet.has(metric.name));
  const missing = requested.filter((name) => !metrics.some((metric) => metric.name === name));
  if (missing.length > 0) {
    throw new Error(`Unknown ${label} metric(s): ${missing.join(", ")}`);
  }
  return filtered;
}

function statusFromEstimate({ active, utilization, congestion, capacity, droppedTraffic, packetErrorRate, queueLatency, queuedTraffic }) {
  if (!active) return "down";
  if (capacity <= 0) return "down";
  const warningScore =
    (utilization >= 85 ? 1 : 0) +
    (congestion >= 10 ? 1 : 0) +
    (queueLatency >= 20 ? 1 : 0) +
    (queuedTraffic >= 40 ? 1 : 0) +
    (droppedTraffic >= 0.5 ? 1 : 0) +
    (packetErrorRate >= 0.02 ? 1 : 0) +
    (utilization >= 70 && (congestion >= 5 || queueLatency >= 10) ? 1 : 0);
  if (warningScore > 0) return "warning";
  return "up";
}

function utilizationLoadConsistency({ utilizationEstimate, capacityEstimate, hotspot }) {
  const current = numberValue(utilizationEstimate, NaN);
  const capacity = numberValue(capacityEstimate, NaN);
  const traffic = numberValue(hotspot?.route_traffic_mbps, 0);
  if (!Number.isFinite(current) || !Number.isFinite(capacity) || capacity <= 0) {
    return {
      value: current,
      load_ratio: "",
      utilization_floor: "",
      applied: false,
    };
  }
  if (traffic <= 0) {
    return {
      value: current,
      load_ratio: 0,
      utilization_floor: "",
      applied: false,
    };
  }
  const loadRatio = traffic / capacity;
  const utilizationFloor = loadRatio >= 0.7 ? clamp(loadRatio * 100, 70, 100) : NaN;
  if (Number.isFinite(utilizationFloor) && utilizationFloor > current) {
    const migratedQuality = Object.hasOwn(hotspot ?? {}, "business_hotspot_migration_quality")
      ? clamp(numberValue(hotspot.business_hotspot_migration_quality, 0), 0, 1)
      : NaN;
    const boundedFloor = Number.isFinite(migratedQuality)
      ? current + (utilizationFloor - current) * clamp(migratedQuality * 0.35, 0, 0.35)
      : utilizationFloor;
    return {
      value: boundedFloor,
      load_ratio: round(loadRatio),
      utilization_floor: round(boundedFloor),
      applied: true,
    };
  }
  return {
    value: current,
    load_ratio: round(loadRatio),
    utilization_floor: Number.isFinite(utilizationFloor) ? round(utilizationFloor) : "",
    applied: false,
  };
}

function metricTensorCoupling({ enabled, source, estimates, hotspot }) {
  const base = {
    applied: false,
    metrics: "",
    tags: enabled ? "no-link-time-metric-tensor-pressure" : "disabled",
    pressure: 0,
    utilization_pressure: 0,
    load_pressure: 0,
    evidence_score: 0,
    queue_latency_ceiling_ms: "",
  };
  if (!enabled || source !== "inferred") return { estimates, ...base };

  const output = { ...estimates };
  const hasMetric = (name) => Object.hasOwn(output, name);
  const utilization = numberValue(output.utilization_percent, NaN);
  const capacity = numberValue(output.capacity_mbps, NaN);
  const congestion = numberValue(output.congestion_percent, NaN);
  const queueLatency = numberValue(output.queue_latency_ms, NaN);
  const packetErrorRate = numberValue(output.packet_error_rate, NaN);
  const droppedTraffic = numberValue(output.dropped_traffic_mb, NaN);
  const traffic = numberValue(hotspot?.route_traffic_mbps, 0);
  const routeQueueDelay = numberValue(hotspot?.route_queue_delay_ms, 0);
  const hotspotScore = numberValue(hotspot?.business_hotspot_score, 0);
  const loadRatio = Number.isFinite(capacity) && capacity > 0 && traffic > 0 ? traffic / capacity : NaN;

  const utilizationPressure = Number.isFinite(utilization) ? clamp((utilization - 62) / 38, 0, 1) : 0;
  const loadPressure = Number.isFinite(loadRatio) ? clamp((loadRatio - 0.55) / 0.85, 0, 1) : 0;
  const congestionPressure = Number.isFinite(congestion) ? clamp(congestion / 58, 0, 1) : 0;
  const queuePressure = Number.isFinite(queueLatency) ? clamp(queueLatency / 900, 0, 1) : 0;
  const perPressure = Number.isFinite(packetErrorRate) ? clamp(packetErrorRate / 0.04, 0, 1) : 0;
  const dropPressure = Number.isFinite(droppedTraffic) ? clamp(droppedTraffic / 8, 0, 1) : 0;
  const businessPressure = clamp(hotspotScore, 0, 1);
  const dominantLoadPressure = Math.max(utilizationPressure, loadPressure);
  const utilizationEvidence = utilizationPressure >= 0.25;
  const loadEvidence = loadPressure >= 0.25 || traffic >= 600;
  const routeQueueEvidence = routeQueueDelay >= 1000;
  const queueEvidence =
    (Number.isFinite(queueLatency) && queueLatency >= 20) ||
    (routeQueueEvidence && loadEvidence);
  const lossEvidence = perPressure >= 0.25 || dropPressure >= 0.25;
  const hotspotEvidence = businessPressure >= 0.45 && (loadEvidence || utilizationEvidence);
  const evidenceScore = clamp(
    utilizationPressure * 0.26 +
      loadPressure * 0.28 +
      (queueEvidence ? 0.2 : 0) +
      Math.max(perPressure, dropPressure) * 0.16 +
      businessPressure * 0.1,
    0,
    1,
  );
  const evidenceAxes = evidenceCount([utilizationEvidence, loadEvidence, queueEvidence, lossEvidence, hotspotEvidence]);
  const pressure = clamp(
    dominantLoadPressure * 0.5 +
      congestionPressure * 0.14 +
      queuePressure * 0.12 +
      perPressure * 0.08 +
      dropPressure * 0.06 +
      businessPressure * 0.1,
    0,
    1,
  );
  const boundedRouteDelay = Math.min(routeQueueDelay, 300);
  const lowPressureQueueCeiling = 700 + boundedRouteDelay * 1.1;
  const updates = [];

  const applyFloor = (name, floor, digits = 4) => {
    if (!hasMetric(name) || !Number.isFinite(floor)) return;
    const current = numberValue(output[name], NaN);
    if (!Number.isFinite(current) || current < floor) {
      output[name] = round(floor, digits);
      updates.push(name);
    }
  };

  const strongWarningEvidence =
    routeQueueEvidence ||
    utilizationPressure >= 0.65 ||
    lossEvidence ||
    (loadPressure >= 0.7 && queuePressure >= 0.45);
  const allowMetricFloors = pressure >= 0.3 && evidenceAxes >= 2 && evidenceScore >= 0.25 && strongWarningEvidence;

  if (!allowMetricFloors) {
    if (hasMetric("queue_latency_ms") && Number.isFinite(queueLatency) && queueLatency > lowPressureQueueCeiling) {
      output.queue_latency_ms = round(lowPressureQueueCeiling);
      updates.push("queue_latency_ms_cap");
    }
    return {
      estimates: output,
      applied: updates.length > 0,
      metrics: updates.join("|"),
      tags: updates.length > 0
        ? "link-time-metric-tensor > low-pressure-queue-outlier-cap"
        : "no-link-time-metric-tensor-conservative-gate",
      pressure: round(pressure),
      utilization_pressure: round(utilizationPressure),
      load_pressure: round(loadPressure),
      evidence_score: round(evidenceScore),
      queue_latency_ceiling_ms: updates.length > 0 ? round(lowPressureQueueCeiling) : "",
    };
  }

  const queueFloor = 4 + pressure * 38 + boundedRouteDelay * 0.12;
  const queueCeiling = Math.max(queueFloor, 240 + pressure * 1450 + boundedRouteDelay * 1.15);
  const congestionFloor = pressure * 56;
  const packetErrorFloor = 0.003 + pressure * 0.034;
  const queuedTrafficFloor = traffic > 0 ? Math.min(384, traffic * pressure * 0.06) : pressure * 18;
  const droppedTrafficFloor = pressure >= 0.74 ? (pressure - 0.7) * 8 : 0;

  applyFloor("queue_latency_ms", queueFloor, 4);
  const currentQueueLatency = numberValue(output.queue_latency_ms, NaN);
  if (hasMetric("queue_latency_ms") && Number.isFinite(currentQueueLatency) && currentQueueLatency > queueCeiling) {
    output.queue_latency_ms = round(queueCeiling);
    updates.push("queue_latency_ms_cap");
  }
  applyFloor("congestion_percent", congestionFloor, 4);
  applyFloor("packet_error_rate", packetErrorFloor, 6);
  applyFloor("queued_traffic_mb", queuedTrafficFloor, 4);
  if (droppedTrafficFloor > 0) applyFloor("dropped_traffic_mb", droppedTrafficFloor, 4);

  return {
    estimates: output,
    applied: updates.length > 0,
    metrics: updates.join("|"),
    tags: [
      "link-time-metric-tensor",
      "same-cell-cross-metric-pressure",
      dominantLoadPressure > 0.4 ? "load-utilization-axis" : "",
      congestionPressure > 0.2 || queuePressure > 0.2 ? "queue-congestion-axis" : "",
      perPressure > 0.2 || dropPressure > 0.2 ? "loss-axis" : "",
      updates.length ? `updated:${updates.join("|")}` : "",
    ].filter(Boolean).join(" > "),
    pressure: round(pressure),
    utilization_pressure: round(utilizationPressure),
    load_pressure: round(loadPressure),
    evidence_score: round(evidenceScore),
    queue_latency_ceiling_ms: round(queueCeiling),
  };
}

function jointLinkStateCoupling({ enabled, source, estimates, hotspot }) {
  const base = {
    applied: false,
    tags: "disabled",
    pressure: 0,
    evidence_score: 0,
    load_ratio: "",
    queue_latency_floor_ms: "",
    queue_latency_ceiling_ms: "",
    congestion_floor_percent: "",
    packet_error_rate_floor: "",
    queued_traffic_floor_mb: "",
    dropped_traffic_floor_mb: "",
  };
  if (!enabled || source !== "inferred") return { estimates, ...base };

  const output = { ...estimates };
  const utilization = numberValue(output.utilization_percent, NaN);
  const capacity = numberValue(output.capacity_mbps, NaN);
  const traffic = numberValue(hotspot?.route_traffic_mbps, 0);
  const routeQueueDelay = numberValue(hotspot?.route_queue_delay_ms, 0);
  const hotspotScore = numberValue(hotspot?.business_hotspot_score, 0);
  const loadRatio = Number.isFinite(capacity) && capacity > 0 && traffic > 0 ? traffic / capacity : NaN;
  const utilizationPressure = Number.isFinite(utilization) ? clamp((utilization - 70) / 30, 0, 1) : 0;
  const loadPressure = Number.isFinite(loadRatio) ? clamp((loadRatio - 0.65) / 0.75, 0, 1) : 0;
  const hotspotPressure = clamp(hotspotScore, 0, 1) * 0.65;
  const routeDelayPressure = clamp(routeQueueDelay / 500, 0, 1);
  const utilizationEvidence = utilizationPressure >= 0.25;
  const loadEvidence = loadPressure >= 0.25 || traffic >= 600;
  const hotspotEvidence = hotspotPressure >= 0.3 && (loadEvidence || utilizationEvidence);
  const routeDelayEvidence = routeQueueDelay >= 1000 && loadEvidence;
  const strongWarningEvidence = routeDelayEvidence || utilizationPressure >= 0.65;
  const evidenceScore = clamp(
    utilizationPressure * 0.3 +
      loadPressure * 0.32 +
      hotspotPressure * 0.18 +
      (routeDelayEvidence ? 0.2 : 0),
    0,
    1,
  );
  const evidenceAxes = evidenceCount([utilizationEvidence, loadEvidence, hotspotEvidence, routeDelayEvidence]);
  const pressure = clamp(Math.max(utilizationPressure, loadPressure, hotspotPressure, routeDelayPressure * 0.6), 0, 1);
  const boundedRouteDelay = Math.min(routeQueueDelay, 250);
  const lowPressureQueueCeiling = 650 + boundedRouteDelay * 1.2;
  const currentQueueBeforePressure = numberValue(output.queue_latency_ms, NaN);
  const allowJointFloors = pressure >= 0.32 && evidenceAxes >= 2 && evidenceScore >= 0.28 && strongWarningEvidence;
  if (!allowJointFloors) {
    if (Number.isFinite(currentQueueBeforePressure) && currentQueueBeforePressure > lowPressureQueueCeiling) {
      output.queue_latency_ms = round(lowPressureQueueCeiling);
      return {
        estimates: output,
        applied: true,
        tags: "queue-latency-outlier-cap",
        pressure: round(pressure),
        evidence_score: round(evidenceScore),
        load_ratio: Number.isFinite(loadRatio) ? round(loadRatio) : "",
        queue_latency_floor_ms: "",
        queue_latency_ceiling_ms: round(lowPressureQueueCeiling),
        congestion_floor_percent: "",
        packet_error_rate_floor: "",
        queued_traffic_floor_mb: "",
        dropped_traffic_floor_mb: "",
      };
    }
    return {
      estimates: output,
      ...base,
      tags: "no-cross-metric-conservative-gate",
      pressure: round(pressure),
      evidence_score: round(evidenceScore),
      load_ratio: Number.isFinite(loadRatio) ? round(loadRatio) : "",
    };
  }

  const queueFloor = Math.max(3, 6 + pressure * 30 + boundedRouteDelay * 0.18);
  const queueCeiling = Math.max(queueFloor, 260 + pressure * 1450 + boundedRouteDelay * 1.2);
  const congestionFloor = pressure * 52;
  const packetErrorFloor = 0.004 + pressure * 0.032;
  const queuedTrafficFloor = traffic > 0 ? Math.min(512, traffic * pressure * 0.08) : pressure * 24;
  const droppedTrafficFloor = pressure >= 0.72 ? (pressure - 0.68) * 10 : 0;
  const updates = [];
  const applyFloor = (name, floor, digits = 4) => {
    const current = numberValue(output[name], NaN);
    if (!Number.isFinite(current) || current < floor) {
      output[name] = round(floor, digits);
      updates.push(name);
    }
  };

  applyFloor("queue_latency_ms", queueFloor, 4);
  const currentQueueLatency = numberValue(output.queue_latency_ms, NaN);
  if (Number.isFinite(currentQueueLatency) && currentQueueLatency > queueCeiling) {
    output.queue_latency_ms = round(queueCeiling);
    updates.push("queue_latency_ms_cap");
  }
  applyFloor("congestion_percent", congestionFloor, 4);
  applyFloor("packet_error_rate", packetErrorFloor, 6);
  applyFloor("queued_traffic_mb", queuedTrafficFloor, 4);
  if (droppedTrafficFloor > 0) applyFloor("dropped_traffic_mb", droppedTrafficFloor, 4);

  return {
    estimates: output,
    applied: updates.length > 0,
    tags: [
      "business-load-queue-coupling",
      utilizationPressure > 0.2 ? "utilization-pressure" : "",
      loadPressure > 0.2 ? "route-load-pressure" : "",
      hotspotPressure > 0.2 ? "business-hotspot-pressure" : "",
      updates.length ? `updated:${updates.join("|")}` : "",
    ].filter(Boolean).join(" > "),
    pressure: round(pressure),
    evidence_score: round(evidenceScore),
    load_ratio: Number.isFinite(loadRatio) ? round(loadRatio) : "",
    queue_latency_floor_ms: round(queueFloor),
    queue_latency_ceiling_ms: round(queueCeiling),
    congestion_floor_percent: round(congestionFloor),
    packet_error_rate_floor: round(packetErrorFloor, 6),
    queued_traffic_floor_mb: round(queuedTrafficFloor),
    dropped_traffic_floor_mb: round(droppedTrafficFloor),
  };
}

function stateTensorJointCompletion({ enabled, source, estimates, hotspot }) {
  const base = {
    applied: false,
    metrics: "",
    tags: enabled ? "no-state-tensor-pressure" : "disabled",
    pressure: 0,
    utilization_pressure: 0,
    load_pressure: 0,
    queue_pressure: 0,
    loss_pressure: 0,
    evidence_score: 0,
    load_ratio: "",
    queue_latency_floor_ms: "",
    congestion_floor_percent: "",
    packet_error_rate_floor: "",
    queued_traffic_floor_mb: "",
    dropped_traffic_floor_mb: "",
  };
  if (!enabled || source !== "inferred") return { estimates, ...base };

  const output = { ...estimates };
  const hasMetric = (name) => Object.hasOwn(output, name);
  const utilization = numberValue(output.utilization_percent, NaN);
  const capacity = numberValue(output.capacity_mbps, NaN);
  const queueLatency = numberValue(output.queue_latency_ms, NaN);
  const congestion = numberValue(output.congestion_percent, NaN);
  const queuedTraffic = numberValue(output.queued_traffic_mb, NaN);
  const droppedTraffic = numberValue(output.dropped_traffic_mb, NaN);
  const packetErrorRate = numberValue(output.packet_error_rate, NaN);
  const traffic = numberValue(hotspot?.route_traffic_mbps, 0);
  const taskCount = numberValue(hotspot?.route_task_count, 0);
  const routeQueueDelay = numberValue(hotspot?.route_queue_delay_ms, 0);
  const hotspotScore = numberValue(hotspot?.business_hotspot_score, 0);
  const loadRatio = Number.isFinite(capacity) && capacity > 0 && traffic > 0 ? traffic / capacity : NaN;

  const utilizationPressure = Number.isFinite(utilization) ? clamp((utilization - 58) / 42, 0, 1) : 0;
  const loadPressure = Number.isFinite(loadRatio) ? clamp((loadRatio - 0.45) / 0.65, 0, 1) : 0;
  const queuePressure = Math.max(
    Number.isFinite(queueLatency) ? clamp(queueLatency / 80, 0, 1) : 0,
    Number.isFinite(queuedTraffic) ? clamp(queuedTraffic / 220, 0, 1) : 0,
    clamp(routeQueueDelay / 400, 0, 1) * 0.75,
  );
  const lossPressure = Math.max(
    Number.isFinite(packetErrorRate) ? clamp(packetErrorRate / 0.035, 0, 1) : 0,
    Number.isFinite(droppedTraffic) ? clamp(droppedTraffic / 6, 0, 1) : 0,
  );
  const businessPressure = Math.max(
    clamp(hotspotScore, 0, 1),
    clamp(taskCount / 4, 0, 1) * 0.55,
  );
  const utilizationEvidence = utilizationPressure >= 0.25;
  const loadEvidence = loadPressure >= 0.25 || traffic >= 600;
  const routeQueueEvidence = routeQueueDelay >= 1000;
  const queueEvidence =
    (Number.isFinite(queueLatency) && queueLatency >= 20) ||
    (Number.isFinite(queuedTraffic) && queuedTraffic >= 40) ||
    (routeQueueEvidence && loadEvidence);
  const lossEvidence = lossPressure >= 0.25;
  const hotspotEvidence = businessPressure >= 0.45 && (loadEvidence || utilizationEvidence || queueEvidence);
  const evidenceScore = clamp(
    utilizationPressure * 0.28 +
      loadPressure * 0.3 +
      queuePressure * 0.18 +
      lossPressure * 0.14 +
      businessPressure * 0.1,
    0,
    1,
  );
  const evidenceAxes = evidenceCount([utilizationEvidence, loadEvidence, queueEvidence, lossEvidence, hotspotEvidence]);
  const pressure = clamp(
    utilizationPressure * 0.34 +
      loadPressure * 0.26 +
      queuePressure * 0.14 +
      lossPressure * 0.08 +
      businessPressure * 0.18,
    0,
    1,
  );
  const updates = [];

  const applyWarningUtilizationFloor = () => {
    if (!hasMetric("utilization_percent")) return false;
    const currentUtilization = numberValue(output.utilization_percent, NaN);
    const currentCongestion = numberValue(output.congestion_percent, NaN);
    const currentQueueLatency = numberValue(output.queue_latency_ms, NaN);
    const currentPacketErrorRate = numberValue(output.packet_error_rate, NaN);
    const warningUtilizationFloor = 80;
    const severeWarningState =
      Number.isFinite(currentUtilization) &&
      currentUtilization >= 45 &&
      currentUtilization < warningUtilizationFloor &&
      Number.isFinite(currentCongestion) &&
      currentCongestion >= 80 &&
      Number.isFinite(currentQueueLatency) &&
      currentQueueLatency >= 500 &&
      Number.isFinite(currentPacketErrorRate) &&
      currentPacketErrorRate >= 0.015;
    if (!severeWarningState) return false;
    output.utilization_percent = round(warningUtilizationFloor);
    updates.push("utilization_percent_warning_consistency_floor");
    return true;
  };

  const strongWarningEvidence =
    routeQueueEvidence ||
    utilizationPressure >= 0.65 ||
    lossEvidence ||
    (loadPressure >= 0.7 && queuePressure >= 0.45);
  const allowStateTensorFloors = pressure >= 0.34 && evidenceAxes >= 2 && evidenceScore >= 0.28 && strongWarningEvidence;

  if (!allowStateTensorFloors) {
    applyWarningUtilizationFloor();
    return {
      estimates: output,
      ...base,
      applied: updates.length > 0,
      metrics: [...new Set(updates)].join("|"),
      tags: updates.length > 0
        ? "state-tensor-joint-completion > warning-link-utilization-consistency"
        : "no-state-tensor-pressure",
      pressure: round(pressure),
      utilization_pressure: round(utilizationPressure),
      load_pressure: round(loadPressure),
      queue_pressure: round(queuePressure),
      loss_pressure: round(lossPressure),
      evidence_score: round(evidenceScore),
      load_ratio: Number.isFinite(loadRatio) ? round(loadRatio) : "",
    };
  }

  const boundedRouteDelay = Math.min(routeQueueDelay, 420);
  const queueFloor = 5 + pressure * 44 + boundedRouteDelay * 0.16;
  const congestionFloor = pressure * 58;
  const packetErrorFloor = 0.003 + pressure * 0.035;
  const queuedTrafficFloor = traffic > 0 ? Math.min(560, traffic * pressure * 0.075) : pressure * 24;
  const droppedTrafficFloor = pressure >= 0.68 ? (pressure - 0.62) * 9 : 0;

  const applyFloor = (name, floor, digits = 4) => {
    if (!hasMetric(name) || !Number.isFinite(floor)) return;
    const current = numberValue(output[name], NaN);
    if (!Number.isFinite(current) || current < floor) {
      output[name] = round(floor, digits);
      updates.push(name);
    }
  };

  applyFloor("queue_latency_ms", queueFloor, 4);
  applyFloor("congestion_percent", congestionFloor, 4);
  applyFloor("packet_error_rate", packetErrorFloor, 6);
  applyFloor("queued_traffic_mb", queuedTrafficFloor, 4);
  if (droppedTrafficFloor > 0) applyFloor("dropped_traffic_mb", droppedTrafficFloor, 4);
  applyWarningUtilizationFloor();

  return {
    estimates: output,
    applied: updates.length > 0,
    metrics: [...new Set(updates)].join("|"),
    tags: [
      "state-tensor-joint-completion",
      "same-link-cross-metric-consistency",
      utilizationPressure > 0.35 ? "utilization-axis" : "",
      loadPressure > 0.35 ? "route-load-axis" : "",
      queuePressure > 0.25 ? "queue-axis" : "",
      lossPressure > 0.25 ? "loss-axis" : "",
      businessPressure > 0.35 ? "business-hotspot-axis" : "",
    ].filter(Boolean).join(" > "),
    pressure: round(pressure),
    utilization_pressure: round(utilizationPressure),
    load_pressure: round(loadPressure),
    queue_pressure: round(queuePressure),
    loss_pressure: round(lossPressure),
    evidence_score: round(evidenceScore),
    load_ratio: Number.isFinite(loadRatio) ? round(loadRatio) : "",
    queue_latency_floor_ms: round(queueFloor),
    congestion_floor_percent: round(congestionFloor),
    packet_error_rate_floor: round(packetErrorFloor, 6),
    queued_traffic_floor_mb: round(queuedTrafficFloor),
    dropped_traffic_floor_mb: round(droppedTrafficFloor),
  };
}

function orbitGraphRegularization({
  enabled,
  source,
  estimates,
  metrics,
  sliceIndex,
  neighborIds,
  completedByMetric,
  observedByKey,
}) {
  const base = {
    estimates,
    applied: false,
    metrics: "",
    neighbor_count: 0,
    strength: 0,
    tags: enabled ? "no-orbit-graph-adjustment" : "disabled",
  };
  if (!enabled || source !== "inferred") return base;

  const output = { ...estimates };
  const adjusted = [];
  let maxStrength = 0;
  let maxNeighborCount = 0;
  metrics.forEach((metric) => {
    const current = numberValue(output[metric.name], NaN);
    if (!Number.isFinite(current)) return;
    const completed = completedByMetric.get(metric.name);
    const neighborValues = neighborIds
      .map((neighborId) => {
        const observed = observedByKey.get(`${sliceIndex}|${neighborId}`);
        const observedValue = metric.observedValue(observed);
        if (boolValue(observed?.observed) && Number.isFinite(observedValue)) return observedValue;
        return completed?.estimates.get(`${sliceIndex}|${neighborId}`);
      })
      .map((value) => numberValue(value, NaN))
      .filter(Number.isFinite);
    if (neighborValues.length < 2) return;
    const neighborMean = mean(neighborValues);
    const neighborSpread = Math.sqrt(mean(neighborValues.map((value) => (value - neighborMean) ** 2))) || 0;
    const scale = metric.range ?? Math.max(Math.abs(neighborMean), Math.abs(current), 1);
    const diff = Math.abs(current - neighborMean);
    const threshold = Math.max(scale * 0.12, neighborSpread * 2.5, metric.name === "packet_error_rate" ? 0.01 : 1);
    if (diff <= threshold) return;
    const strength = clamp(0.12 + neighborValues.length * 0.045 + clamp(diff / Math.max(scale, 1), 0, 1) * 0.18, 0.12, 0.38);
    output[metric.name] = round(metric.clamp(current * (1 - strength) + neighborMean * strength), metric.name === "packet_error_rate" ? 6 : 4);
    adjusted.push(metric.name);
    maxStrength = Math.max(maxStrength, strength);
    maxNeighborCount = Math.max(maxNeighborCount, neighborValues.length);
  });

  return {
    estimates: output,
    applied: adjusted.length > 0,
    metrics: adjusted.join("|"),
    neighbor_count: maxNeighborCount,
    strength: round(maxStrength),
    tags: adjusted.length > 0
      ? "plane-slot-neighbor-graph-regularization"
      : "no-orbit-graph-adjustment",
  };
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
    const allPairs = [];
    const inferredPairs = [];
    reconstructionRows.forEach((row) => {
      if (row.contact_state !== "active") return;
      const truth = truthByKey.get(`${row.slice_index}|${row.link_id}`);
      if (!truth) return;
      const estimate = numberValue(row[`${metric.name}_estimate`], NaN);
      const actual = metric.truthValue(truth);
      if (!Number.isFinite(estimate) || !Number.isFinite(actual)) return;
      const pair = { estimate, actual };
      allPairs.push(pair);
      if (row.observation_source === "inferred") inferredPairs.push(pair);
    });
    const allStats = errorMetricStats(allPairs, metric);
    const inferredStats = errorMetricStats(inferredPairs, metric);
    metricReports[metric.name] = {
      ...allStats,
      inferred_mae: inferredStats.mae,
      inferred_rmse: inferredStats.rmse,
      inferred_nmse: inferredStats.nmse,
      inferred_median_ae: inferredStats.median_ae,
      inferred_p90_ae: inferredStats.p90_ae,
      inferred_p95_ae: inferredStats.p95_ae,
      inferred_max_ae: inferredStats.max_ae,
      inferred_mean_error: inferredStats.mean_error,
      inferred_nmae_range: inferredStats.nmae_range,
      inferred_smape: inferredStats.smape,
      inferred_within_5_units_rate: inferredStats.within_5_units_rate,
      inferred_within_10_units_rate: inferredStats.within_10_units_rate,
      inferred_r2: inferredStats.r2,
      inferred_samples: inferredStats.samples,
      ...(metric.classThreshold !== undefined ? {
        inferred_class_accuracy: inferredStats.class_accuracy,
        inferred_high_precision: inferredStats.high_precision,
        inferred_high_recall: inferredStats.high_recall,
        inferred_high_f1: inferredStats.high_f1,
        inferred_high_actual_support: inferredStats.high_actual_support,
        inferred_high_predicted_support: inferredStats.high_predicted_support,
        inferred_high_true_positive: inferredStats.high_true_positive,
        inferred_high_false_positive: inferredStats.high_false_positive,
        inferred_high_true_negative: inferredStats.high_true_negative,
        inferred_high_false_negative: inferredStats.high_false_negative,
      } : {}),
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

function nodeModeFromEstimate({ cpu, energy, queueDepth }) {
  if (energy <= 0) return "offline";
  if (energy < 20) return "power-saving";
  if (cpu >= 80) return "busy";
  if (queueDepth > 48 || cpu > 72) return "warning";
  return "nominal";
}

function nodeStateCoupling({ enabled, source, estimates, workload, nodeContext, nodeCount = 0 }) {
  const base = {
    applied: false,
    metrics: "",
    tags: enabled ? "no-node-workload-energy-pressure" : "disabled",
    pressure: 0,
    evidence_score: 0,
    workload_traffic_mbps: round(numberValue(workload?.route_traffic_mbps)),
    workload_task_count: numberValue(workload?.route_task_count),
    energy_ceiling_percent: "",
  };
  if (!enabled || source !== "inferred") return { estimates, ...base };

  const output = { ...estimates };
  const hasMetric = (name) => Object.hasOwn(output, name);
  const traffic = numberValue(workload?.route_traffic_mbps, 0);
  const taskCount = numberValue(workload?.route_task_count, 0);
  const priorityMean = numberValue(workload?.route_priority_mean, 0);
  const routeQueueDelay = numberValue(workload?.route_queue_delay_ms, 0);
  const workloadScore = numberValue(workload?.node_workload_score, 0);
  const queueDepth = numberValue(output.queue_depth, NaN);
  const energy = numberValue(output.energy_percent, NaN);
  const solarExposure = clamp(numberValue(nodeContext?.solar_exposure_context, 1), 0, 1);
  const shadowPressure = String(nodeContext?.illumination_context) === "shadow"
    ? clamp(1 - solarExposure, 0.25, 1)
    : clamp((0.18 - solarExposure) / 0.18, 0, 0.35);
  const trafficPressure = clamp(traffic / 1200, 0, 1);
  const taskPressure = clamp(taskCount / 4, 0, 1);
  const priorityPressure = clamp(priorityMean / 3, 0, 1);
  const queueDelayPressure = clamp(routeQueueDelay / 1000, 0, 1);
  const estimateQueuePressure = Number.isFinite(queueDepth) ? clamp(queueDepth / 80, 0, 1) : 0;
  const currentCpu = numberValue(output.cpu_percent, NaN);
  const cpuEvidence = Number.isFinite(currentCpu) && currentCpu >= 45;
  const trafficEvidence = trafficPressure >= 0.45 || traffic >= 600;
  const taskEvidence = taskPressure >= 0.5;
  const priorityEvidence = priorityPressure >= 0.75;
  const routeQueueEvidence = routeQueueDelay >= 1000;
  const queueEvidence = estimateQueuePressure >= 0.35 || routeQueueEvidence;
  const energyEvidence = shadowPressure >= 0.45 && (trafficEvidence || queueEvidence);
  const evidenceScore = clamp(
    trafficPressure * 0.34 +
      taskPressure * 0.14 +
      priorityPressure * 0.12 +
      (queueEvidence ? 0.18 : 0) +
      estimateQueuePressure * 0.12 +
      (energyEvidence ? 0.1 : 0),
    0,
    1,
  );
  const evidenceAxes = evidenceCount([trafficEvidence, taskEvidence, priorityEvidence, queueEvidence, cpuEvidence, energyEvidence]);
  const pressure = clamp(
    Math.max(workloadScore, trafficPressure * 0.62 + taskPressure * 0.18 + priorityPressure * 0.08 + queueDelayPressure * 0.12) * 0.82 +
      estimateQueuePressure * 0.08 +
      shadowPressure * 0.1,
    0,
    1,
  );

  const updates = [];
  const idleWorkload =
    nodeCount >= 128 &&
    traffic <= 0 &&
    taskCount <= 0 &&
    routeQueueDelay <= 0 &&
    workloadScore <= 0.02;
  const applyFloor = (name, floor, digits = 4) => {
    if (!hasMetric(name) || !Number.isFinite(floor)) return;
    const current = numberValue(output[name], NaN);
    if (!Number.isFinite(current) || current < floor) {
      output[name] = round(floor, digits);
      updates.push(name);
    }
  };
  const applyCeiling = (name, ceiling, digits = 4) => {
    if (!hasMetric(name) || !Number.isFinite(ceiling)) return;
    const current = numberValue(output[name], NaN);
    if (Number.isFinite(current) && current > ceiling) {
      output[name] = round(ceiling, digits);
      updates.push(`${name}_idle_ceiling`);
    }
  };

  if (idleWorkload) {
    applyCeiling("cpu_percent", 0.5, 4);
    applyCeiling("queue_depth", 0.02, 4);
    applyCeiling("queued_traffic_mb", 0.02, 4);
    applyCeiling("cache_used_mb", 0.05, 4);
    return {
      estimates: output,
      applied: updates.length > 0,
      metrics: updates.join("|"),
      tags: updates.length > 0
        ? "node-idle-workload-consistency > no-routed-task-quiet-state"
        : "node-idle-workload-consistency > already-quiet",
      pressure: 0,
      evidence_score: 1,
      workload_traffic_mbps: round(traffic),
      workload_task_count: taskCount,
      energy_ceiling_percent: "",
    };
  }

  const workloadBacklogEvidence = queueEvidence || cpuEvidence || estimateQueuePressure >= 0.55;
  const allowComputeFloors =
    pressure >= 0.42 &&
    evidenceAxes >= 2 &&
    evidenceScore >= 0.34 &&
    trafficEvidence &&
    workloadBacklogEvidence;
  const allowQueueFloors =
    pressure >= 0.22 &&
    queueEvidence &&
    evidenceScore >= 0.2 &&
    (trafficEvidence || routeQueueEvidence || estimateQueuePressure >= 0.55);

  if (allowComputeFloors || allowQueueFloors) {
    const computeEvidence = priorityEvidence;
    const backlogEvidence = queueEvidence || estimateQueuePressure >= 0.55;
    if (allowComputeFloors && computeEvidence) applyFloor("cpu_percent", clamp(12 + pressure * 78, 0, 100), 4);
    if (allowQueueFloors && backlogEvidence) {
      const queueFloor = Math.max(2 + pressure * 68, routeQueueEvidence ? Math.min(100, routeQueueDelay / 600) : 0);
      applyFloor("queue_depth", queueFloor, 4);
      applyFloor("queued_traffic_mb", traffic > 0 ? Math.min(512, traffic * pressure * 0.045) : pressure * 24, 4);
      applyFloor("cache_used_mb", traffic > 0 ? Math.min(1024, traffic * pressure * 0.05) : pressure * 32, 4);
    }
  }

  let energyCeiling = "";
  if (hasMetric("energy_percent") && Number.isFinite(energy) && shadowPressure > 0.2 && allowComputeFloors && priorityEvidence) {
    energyCeiling = Math.max(20, 84 - pressure * 28 - shadowPressure * 18);
    if (energy > energyCeiling) {
      output.energy_percent = round(energyCeiling, 4);
      updates.push("energy_percent");
    }
  }

  return {
    estimates: output,
    applied: updates.length > 0,
    metrics: updates.join("|"),
    tags: [
      updates.length > 0 ? "node-workload-energy-coupling" : "node-workload-energy-conservative-gate",
      trafficPressure > 0.4 ? "route-traffic-pressure" : "",
      taskPressure > 0.25 ? "task-count-pressure" : "",
      queueEvidence ? "queue-evidence" : "",
      shadowPressure > 0.25 ? "shadow-energy-pressure" : "",
      updates.length ? `updated:${updates.join("|")}` : "",
    ].filter(Boolean).join(" > "),
    pressure: round(pressure),
    evidence_score: round(evidenceScore),
    workload_traffic_mbps: round(traffic),
    workload_task_count: taskCount,
    energy_ceiling_percent: Number.isFinite(energyCeiling) ? round(energyCeiling) : "",
  };
}

function evaluateNodeReconstruction(reconstructionRows, truthByKey, metrics) {
  const observedRows = reconstructionRows.filter((row) => row.observation_source === "observed");
  const inferredRows = reconstructionRows.filter((row) => row.observation_source === "inferred");
  let modeMatches = 0;

  reconstructionRows.forEach((row) => {
    const truth = truthByKey.get(`${row.slice_index}|${row.node_id}`);
    if (truth && row.mode_estimate === truth.mode) modeMatches += 1;
  });

  const metricReports = {};
  metrics.forEach((metric) => {
    const allPairs = [];
    const inferredPairs = [];
    reconstructionRows.forEach((row) => {
      const truth = truthByKey.get(`${row.slice_index}|${row.node_id}`);
      if (!truth) return;
      const estimate = numberValue(row[`${metric.name}_estimate`], NaN);
      const actual = metric.truthValue(truth);
      if (!Number.isFinite(estimate) || !Number.isFinite(actual)) return;
      const pair = { estimate, actual };
      allPairs.push(pair);
      if (row.observation_source === "inferred") inferredPairs.push(pair);
    });
    const allStats = errorMetricStats(allPairs, metric);
    const inferredStats = errorMetricStats(inferredPairs, metric);
    metricReports[metric.name] = {
      ...allStats,
      inferred_mae: inferredStats.mae,
      inferred_rmse: inferredStats.rmse,
      inferred_nmse: inferredStats.nmse,
      inferred_median_ae: inferredStats.median_ae,
      inferred_p90_ae: inferredStats.p90_ae,
      inferred_p95_ae: inferredStats.p95_ae,
      inferred_max_ae: inferredStats.max_ae,
      inferred_mean_error: inferredStats.mean_error,
      inferred_nmae_range: inferredStats.nmae_range,
      inferred_smape: inferredStats.smape,
      inferred_within_5_units_rate: inferredStats.within_5_units_rate,
      inferred_within_10_units_rate: inferredStats.within_10_units_rate,
      inferred_r2: inferredStats.r2,
      inferred_samples: inferredStats.samples,
      ...(metric.classThreshold !== undefined ? {
        inferred_class_accuracy: inferredStats.class_accuracy,
        inferred_high_precision: inferredStats.high_precision,
        inferred_high_recall: inferredStats.high_recall,
        inferred_high_f1: inferredStats.high_f1,
        inferred_high_actual_support: inferredStats.high_actual_support,
        inferred_high_predicted_support: inferredStats.high_predicted_support,
        inferred_high_true_positive: inferredStats.high_true_positive,
        inferred_high_false_positive: inferredStats.high_false_positive,
        inferred_high_true_negative: inferredStats.high_true_negative,
        inferred_high_false_negative: inferredStats.high_false_negative,
      } : {}),
    };
  });

  return {
    node_samples: reconstructionRows.length,
    observed_node_samples: observedRows.length,
    inferred_node_samples: inferredRows.length,
    node_completion_coverage: round((observedRows.length + inferredRows.length) / Math.max(reconstructionRows.length, 1)),
    direct_observation_rate: round(observedRows.length / Math.max(reconstructionRows.length, 1)),
    inferred_rate: round(inferredRows.length / Math.max(reconstructionRows.length, 1)),
    mode_accuracy_all_nodes: round(modeMatches / Math.max(reconstructionRows.length, 1)),
    metrics: metricReports,
  };
}

const args = process.argv.slice(2);
const inputDir = resolve(argValue(args, "--input", "exports/tmp-highload-check"));
const stage2Dir = resolve(argValue(args, "--stage2", `stage2-int/outputs/${basename(inputDir)}`));
const algorithm = argValue(args, "--algorithm", "int-mc");
const groundDir = resolve(argValue(args, "--ground", join(stage2Dir, `ground-probe-${algorithm}`)));
const outputDir = resolve(argValue(args, "--out", groundDir));
const writeLinkArtifacts = argValue(args, "--write-link-artifacts", "true").toLowerCase() !== "false";
const rank = numberArg(args, "--rank", 5);
const iterations = numberArg(args, "--iterations", 12);
const windowSize = numberArg(args, "--window-size", 12);
const completionBackend = normalizeCompletionBackend(argValue(args, "--completion-backend", "low-rank"));
const scalarCompletionBackend = isJointTensorBackend(completionBackend) ? "low-rank" : completionBackend;
const mlEpochs = Math.max(1, Math.floor(numberArg(args, "--ml-epochs", iterations)));
const mlLearningRate = numberArg(args, "--ml-learning-rate", completionBackend === "costco" ? 0.009 : 0.012);
const mlTrainingSamples = Math.max(1, Math.floor(numberArg(args, "--ml-training-samples", 12000)));
const mlHiddenUnits = Math.max(16, Math.floor(numberArg(args, "--ml-hidden-units", 96)));
const mlHiddenLayers = Math.max(1, Math.floor(numberArg(args, "--ml-hidden-layers", 2)));
const mlLatentRank = Math.max(2, Math.floor(numberArg(args, "--ml-latent-rank", Math.max(32, rank * 8))));
const softImputeLambdaRatio = clamp(numberArg(args, "--soft-impute-lambda-ratio", 0.08), 0, 1);
const kalmanProcessVariance = clamp(numberArg(args, "--kalman-process-variance", 0.05), 0.000001, 10);
const kalmanMeasurementVariance = clamp(numberArg(args, "--kalman-measurement-variance", 0.1), 0.000001, 10);
const kalmanInitialVariance = clamp(numberArg(args, "--kalman-initial-variance", 1), 0.000001, 100);
const graphRegularizationWeight = Math.max(0, numberArg(args, "--graph-regularization-weight", 0.4));
const temporalRegularizationWeight = Math.max(0, numberArg(args, "--temporal-regularization-weight", 0.25));
const priorRegularizationWeight = Math.max(0, numberArg(args, "--prior-regularization-weight", 0.2));
const lowRankRegularizationWeight = Math.max(0, numberArg(args, "--low-rank-regularization-weight", 0.15));
const jointTensorRank = Math.max(2, Math.floor(numberArg(args, "--joint-tensor-rank", Math.max(4, rank))));
const jointTensorEpochs = Math.max(1, Math.floor(numberArg(args, "--joint-tensor-epochs", 60)));
const jointTensorLearningRate = clamp(numberArg(args, "--joint-tensor-learning-rate", 0.05), 0.00001, 0.25);
const jointTensorL2 = clamp(numberArg(args, "--joint-tensor-l2", 0.001), 0, 0.1);
const jointTensorPredictionWeight = clamp(numberArg(args, "--joint-tensor-prediction-weight", 0.35), 0, 1);
const jointTensorTemporalRegularization = clamp(numberArg(args, "--joint-tensor-temporal-regularization", 0.015), 0, 0.25);
const jointTensorOrbitRegularization = clamp(numberArg(args, "--joint-tensor-orbit-regularization", 0.015), 0, 0.25);
const jointTensorPhysicsProjectionEnabled = completionBackend === "joint-cp-physics";
const metricTensorCouplingEnabled = argValue(args, "--metric-tensor-coupling", "false").toLowerCase() === "true";
const nodeStateCouplingEnabled = argValue(args, "--node-state-coupling", "false").toLowerCase() === "true";
const nodeEnergyPhysicsPriorEnabled = argValue(args, "--node-energy-physics-prior", "false").toLowerCase() === "true";
const jointStateCouplingEnabled = argValue(args, "--joint-state-coupling", "false").toLowerCase() === "true";
const orbitGraphRegularizationEnabled = argValue(args, "--orbit-graph-regularization", "false").toLowerCase() === "true";
const orbitPeriodicPriorEnabled = argValue(args, "--orbit-periodic-prior", "false").toLowerCase() === "true";
const orbitPeriodicPriorSlices = Math.max(1, Math.floor(numberArg(args, "--orbit-periodic-prior-slices", 19)));
const oamQualityFeedbackEnabled = argValue(args, "--oam-quality-feedback", "false").toLowerCase() === "true";
const businessHotspotMigrationPriorEnabled = argValue(args, "--business-hotspot-migration-prior", "false").toLowerCase() === "true";
const stateTensorJointCompletionEnabled = argValue(args, "--state-tensor-joint-completion", "false").toLowerCase() === "true";
const effectiveNodeStateCouplingEnabled = nodeStateCouplingEnabled;
const effectiveStateTensorJointCompletionEnabled = stateTensorJointCompletionEnabled;
const completionOptions = {
  epochs: mlEpochs,
  learningRate: mlLearningRate,
  trainingSamples: mlTrainingSamples,
  hiddenUnits: mlHiddenUnits,
  hiddenLayers: mlHiddenLayers,
  latentRank: mlLatentRank,
  softImputeLambdaRatio,
  kalmanProcessVariance,
  kalmanMeasurementVariance,
  kalmanInitialVariance,
  graphWeight: graphRegularizationWeight,
  temporalWeight: temporalRegularizationWeight,
  priorWeight: priorRegularizationWeight,
  lowRankWeight: lowRankRegularizationWeight,
};
const completionFeedbackMaxPerSlice = Math.max(1, Math.floor(numberArg(args, "--completion-feedback-max-per-slice", 24)));
const predictedContactPlanPath = argValue(args, "--predicted-contact-plan", "");
const linkMetricNames = argValue(args, "--link-metrics", "");
const nodeMetricNames = argValue(args, "--node-metrics", "");

const linksPath = resolve(argValue(args, "--links", join(inputDir, "links.csv")));
const nodesPath = resolve(argValue(args, "--nodes", join(inputDir, "nodes.csv")));
const routesPath = resolve(argValue(args, "--routes", join(inputDir, "routes.csv")));
const groundLinksPath = resolve(argValue(args, "--ground-links", join(groundDir, "ground-reconstructed-links.csv")));
const groundNodesPath = resolve(argValue(args, "--ground-nodes", join(groundDir, "ground-reconstructed-nodes.csv")));

requireFile(linksPath, "links.csv");
requireFile(nodesPath, "nodes.csv");
requireFile(groundLinksPath, "ground reconstructed links");
requireFile(groundNodesPath, "ground reconstructed nodes");
if (predictedContactPlanPath) requireFile(resolve(predictedContactPlanPath), "predicted contact plan");

const [truthLinks, truthNodes, routes, observedLinks, observedNodes, predictedContactPlan] = await Promise.all([
  readCsv(linksPath),
  readCsv(nodesPath),
  existsSync(routesPath) ? readCsv(routesPath) : Promise.resolve([]),
  readCsv(groundLinksPath),
  readCsv(groundNodesPath),
  predictedContactPlanPath ? readJson(resolve(predictedContactPlanPath)) : Promise.resolve(null),
]);
const truthByKey = indexBy(truthLinks, (link) => `${link.slice_index}|${link.link_id}`);
const truthNodeByKey = indexBy(truthNodes, (node) => `${node.slice_index}|${node.node_id}`);
const observedByKey = indexBy(observedLinks, (link) => `${link.slice_index}|${link.link_id}`);
const observedNodeByKey = indexBy(observedNodes, (node) => `${node.slice_index}|${node.node_id}`);
const contactByKey = predictedContactPlan
  ? indexBy(predictedContactPlan.entries ?? [], (link) => `${link.slice_index}|${link.link_id}`)
  : null;
const sliceIndexes = [...new Set(truthLinks.map((link) => String(link.slice_index)))].sort((left, right) => Number(left) - Number(right));
const linkIds = [...new Set(truthLinks.map((link) => link.link_id))].sort();
const nodeIds = [...new Set(truthNodes.map((node) => node.node_id))].sort();
const firstTruthByLink = indexBy(truthLinks, (link) => link.link_id);
const firstTruthByNode = indexBy(truthNodes, (node) => node.node_id);
const businessHotspots = buildBusinessHotspots(routes);
const nodeWorkloads = buildNodeWorkloads(routes, truthByKey);
const metrics = filterMetricsByName(metricDefinitions(), linkMetricNames, "link");
const nodeMetrics = filterMetricsByName(nodeMetricDefinitions(), nodeMetricNames, "node");
const completedByMetric = new Map();
const completedNodeByMetric = new Map();
const matrixSummaries = [];
const nodeMatrixSummaries = [];
const outputLinkTensorIndex = buildLinkTensorIndex({ linkIds, sliceIndexes, truthByKey });
const outputNodeTensorIndex = buildNodeTensorIndex(nodeIds);
const sliceColumnIndex = new Map(sliceIndexes.map((sliceIndex, index) => [String(sliceIndex), index]));

metrics.forEach((metric) => {
  const completed = completeMetricMatrix({
    metric,
    linkIds,
    sliceIndexes,
    truthByKey,
    observedByKey,
    contactByKey,
    businessHotspots,
    rank,
    iterations,
    windowSize,
    completionBackend: scalarCompletionBackend,
    completionOptions,
    orbitPeriodicPriorEnabled,
    orbitPeriodicPriorSlices,
    businessHotspotMigrationPriorEnabled,
  });
  completedByMetric.set(metric.name, completed);
  matrixSummaries.push(completed.summary);
});

nodeMetrics.forEach((metric) => {
  const completed = completeNodeMetricMatrix({
    metric,
    nodeIds,
    sliceIndexes,
    truthByKey: truthNodeByKey,
    observedByKey: observedNodeByKey,
    rank,
    iterations,
    windowSize,
    completionBackend: scalarCompletionBackend,
    completionOptions,
    orbitPeriodicPriorEnabled,
    orbitPeriodicPriorSlices,
    nodeEnergyPhysicsPriorEnabled,
  });
  completedNodeByMetric.set(metric.name, completed);
  nodeMatrixSummaries.push(completed.summary);
});

const jointTensorOptions = {
  rank: jointTensorRank,
  epochs: jointTensorEpochs,
  learningRate: jointTensorLearningRate,
  l2: jointTensorL2,
  jointPredictionWeight: jointTensorPredictionWeight,
  temporalRegularization: jointTensorTemporalRegularization,
  orbitRegularization: jointTensorOrbitRegularization,
};
const jointLinkTensorCompletion = applyJointTensorCompletion({
  scope: "link",
  backend: completionBackend,
  metrics,
  objectIds: linkIds,
  sliceIndexes,
  completedByMetric,
  observedByKey,
  isActive: ({ sliceIndex, objectId }) => contactActiveFor(
    contactByKey,
    truthByKey.get(`${sliceIndex}|${objectId}`),
    sliceIndex,
    objectId,
  ),
  neighborIdsFor: (linkId) => linkTensorNeighborIds(linkId, outputLinkTensorIndex),
  options: jointTensorOptions,
});
const jointNodeTensorCompletion = applyJointTensorCompletion({
  scope: "node",
  backend: completionBackend,
  metrics: nodeMetrics,
  objectIds: nodeIds,
  sliceIndexes,
  completedByMetric: completedNodeByMetric,
  observedByKey: observedNodeByKey,
  isActive: () => true,
  neighborIdsFor: (nodeId) => nodeTensorNeighborIds(nodeId, outputNodeTensorIndex),
  options: jointTensorOptions,
});

const reconstructionRows = [];
const errorRows = [];
const nodeReconstructionRows = [];
const nodeErrorRows = [];
const previousInferredNodeEnergy = new Map();

sliceIndexes.forEach((sliceIndex) => {
  linkIds.forEach((linkId) => {
    const truth = truthByKey.get(`${sliceIndex}|${linkId}`);
    if (!truth) return;
    const observed = observedByKey.get(`${sliceIndex}|${linkId}`);
    const contactActive = contactActiveFor(contactByKey, truth, sliceIndex, linkId);
    const directlyObserved = boolValue(observed?.observed);
    const catalog = firstTruthByLink.get(linkId) ?? truth;
    const key = `${sliceIndex}|${linkId}`;
    const colIndex = sliceColumnIndex.get(String(sliceIndex)) ?? 0;
    const directHotspot = businessHotspots.get(key) ?? {};
    const migrationPrior = hasBusinessHotspot(directHotspot)
      ? emptyBusinessHotspotMigrationPrior(Boolean(businessHotspotMigrationPriorEnabled))
      : businessHotspotMigrationPrior({
          enabled: businessHotspotMigrationPriorEnabled,
          linkId,
          sliceIndex,
          colIndex,
          sliceIndexes,
          businessHotspots,
          linkTensorIndex: outputLinkTensorIndex,
        });
    const hotspot = hasBusinessHotspot(directHotspot) ? directHotspot : {};
    const sourceNode = truthNodeByKey.get(`${sliceIndex}|${catalog.source}`);
    const targetNode = truthNodeByKey.get(`${sliceIndex}|${catalog.target}`);
    const linkContext = linkContextDetails({
      truth,
      contactByKey,
      sliceIndex,
      linkId,
      sourceNode,
      targetNode,
      hotspot,
    });
    const sourceTensor = planeSlot(catalog.source);
    const targetTensor = planeSlot(catalog.target);
    const linkTensorNeighbors = linkTensorNeighborIds(linkId, outputLinkTensorIndex);
    const source = !contactActive ? "topology-down" : directlyObserved ? "observed" : "inferred";
    const oamQuality = oamObservationQuality(observed, oamQualityFeedbackEnabled && directlyObserved);

    const estimates = {};
    const confidences = [];
    metrics.forEach((metric) => {
      const completed = completedByMetric.get(metric.name);
      if (!contactActive) {
        estimates[metric.name] = "";
      } else if (directlyObserved) {
        estimates[metric.name] = round(metric.observedValue(observed));
        confidences.push(oamQuality.confidence);
      } else {
        const value = completed.estimates.get(key);
        estimates[metric.name] = value === undefined ? "" : round(value);
        confidences.push(completed.confidence.get(key) ?? 0.25);
      }
    });

    const orbitGraph = orbitGraphRegularization({
      enabled: orbitGraphRegularizationEnabled,
      source,
      estimates,
      metrics,
      sliceIndex,
      neighborIds: linkTensorNeighbors,
      completedByMetric,
      observedByKey,
    });
    Object.assign(estimates, orbitGraph.estimates);

    const loadConsistency = source === "inferred"
      ? utilizationLoadConsistency({
          utilizationEstimate: estimates.utilization_percent,
          capacityEstimate: estimates.capacity_mbps,
          hotspot,
        })
      : {
          value: numberValue(estimates.utilization_percent, NaN),
          load_ratio: "",
          utilization_floor: "",
          applied: false,
        };
    if (source === "inferred" && loadConsistency.applied) {
      estimates.utilization_percent = round(loadConsistency.value);
    }
    const metricTensor = metricTensorCoupling({
      enabled: metricTensorCouplingEnabled,
      source,
      estimates,
      hotspot,
    });
    Object.assign(estimates, metricTensor.estimates);
    const jointCoupling = jointLinkStateCoupling({
      enabled: jointStateCouplingEnabled,
      source,
      estimates,
      hotspot,
    });
    Object.assign(estimates, jointCoupling.estimates);
    const stateTensorJoint = stateTensorJointCompletion({
      enabled: effectiveStateTensorJointCompletionEnabled,
      source,
      estimates,
      hotspot,
    });
    Object.assign(estimates, stateTensorJoint.estimates);
    const physicalProjection = source === "inferred" && jointTensorPhysicsProjectionEnabled
      ? projectLinkPhysicalConsistency(estimates, {
          routeTrafficMbps: hotspot.route_traffic_mbps,
        })
      : { estimates, applied: false, metrics: [], hidden_truth_used: false };
    Object.assign(estimates, physicalProjection.estimates);

    const confidence = !contactActive ? 1 : directlyObserved ? round(oamQuality.confidence) : round(mean(confidences));
    const derivedStatus = statusFromEstimate({
      active: contactActive,
      utilization: numberValue(estimates.utilization_percent),
      congestion: numberValue(estimates.congestion_percent),
      capacity: numberValue(estimates.capacity_mbps),
      droppedTraffic: numberValue(estimates.dropped_traffic_mb),
      packetErrorRate: numberValue(estimates.packet_error_rate),
      queueLatency: numberValue(estimates.queue_latency_ms),
      queuedTraffic: numberValue(estimates.queued_traffic_mb),
    });
    const statusEstimate = resolveTopologyAwareStatusEstimate({
      contactActive,
      directlyObserved,
      observedStatus: observed?.status_estimate,
      derivedStatus,
    });

    const row = {
      slice_index: Number(sliceIndex),
      time: truth.time,
      link_id: linkId,
      source: catalog.source,
      target: catalog.target,
      source_plane: sourceTensor.plane,
      source_slot: sourceTensor.slot,
      target_plane: targetTensor.plane,
      target_slot: targetTensor.slot,
      tensor_coordinate: sourceTensor.plane >= 0 && targetTensor.plane >= 0
        ? `T${sliceIndex}|P${padNumber(sourceTensor.plane, sourceTensor.plane_width)}-S${padNumber(sourceTensor.slot, sourceTensor.slot_width)}->P${padNumber(targetTensor.plane, targetTensor.plane_width)}-S${padNumber(targetTensor.slot, targetTensor.slot_width)}`
        : "",
      tensor_neighbor_count: linkTensorNeighbors.length,
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
      queue_latency_ms_estimate: estimates.queue_latency_ms,
      capacity_mbps_estimate: estimates.capacity_mbps,
      congestion_percent_estimate: estimates.congestion_percent,
      queued_traffic_mb_estimate: estimates.queued_traffic_mb,
      dropped_traffic_mb_estimate: estimates.dropped_traffic_mb,
      packet_error_rate_estimate: estimates.packet_error_rate,
      business_hotspot_direct_score: directHotspot.business_hotspot_score ?? 0,
      route_task_count: hotspot.route_task_count ?? 0,
      route_traffic_mbps: hotspot.route_traffic_mbps ?? 0,
      route_priority_mean: hotspot.route_priority_mean ?? 0,
      route_queue_delay_ms: hotspot.route_queue_delay_ms ?? 0,
      business_hotspot_score: hotspot.business_hotspot_score ?? 0,
      business_hotspot_migration_enabled: businessHotspotMigrationPriorEnabled,
      business_hotspot_migration_applied: source === "inferred" && migrationPrior.applied,
      business_hotspot_migration_source: migrationPrior.source,
      business_hotspot_migration_candidate_count: migrationPrior.candidate_count,
      business_hotspot_migration_score: migrationPrior.score,
      business_hotspot_migration_quality: migrationPrior.quality,
      business_hotspot_migration_route_task_count: migrationPrior.route_task_count,
      business_hotspot_migration_traffic_mbps: migrationPrior.route_traffic_mbps,
      business_load_ratio_estimate: loadConsistency.load_ratio,
      business_load_utilization_floor: loadConsistency.utilization_floor,
      business_load_consistency_applied: loadConsistency.applied,
      metric_tensor_coupling_enabled: metricTensorCouplingEnabled,
      metric_tensor_coupling_applied: metricTensor.applied,
      metric_tensor_coupled_metrics: metricTensor.metrics,
      metric_tensor_coupling_tags: metricTensor.tags,
      metric_tensor_coupling_pressure: metricTensor.pressure,
      metric_tensor_utilization_pressure: metricTensor.utilization_pressure,
      metric_tensor_load_pressure: metricTensor.load_pressure,
      metric_tensor_evidence_score: metricTensor.evidence_score,
      metric_tensor_queue_latency_ceiling_ms: metricTensor.queue_latency_ceiling_ms,
      orbit_graph_regularization_enabled: orbitGraphRegularizationEnabled,
      orbit_graph_regularization_applied: orbitGraph.applied,
      orbit_graph_regularized_metrics: orbitGraph.metrics,
      orbit_graph_regularization_neighbor_count: orbitGraph.neighbor_count,
      orbit_graph_regularization_strength: orbitGraph.strength,
      orbit_graph_regularization_tags: orbitGraph.tags,
      oam_quality_feedback_enabled: oamQualityFeedbackEnabled,
      oam_quality_feedback_applied: oamQuality.applied,
      oam_observation_confidence: oamQuality.source_confidence,
      oam_observation_confidence_state: oamQuality.confidence_state,
      oam_conflict_severity: oamQuality.conflict_severity,
      oam_quality_confidence_penalty: round(oamQuality.confidence_penalty),
      oam_quality_feedback_tags: oamQuality.tags,
      joint_state_coupling_enabled: jointStateCouplingEnabled,
      joint_state_coupling_applied: jointCoupling.applied,
      joint_state_coupling_tags: jointCoupling.tags,
      joint_state_coupling_pressure: jointCoupling.pressure,
      joint_state_coupling_evidence_score: jointCoupling.evidence_score,
      joint_state_coupling_load_ratio: jointCoupling.load_ratio,
      joint_state_queue_latency_floor_ms: jointCoupling.queue_latency_floor_ms,
      joint_state_queue_latency_ceiling_ms: jointCoupling.queue_latency_ceiling_ms,
      joint_state_congestion_floor_percent: jointCoupling.congestion_floor_percent,
      joint_state_packet_error_rate_floor: jointCoupling.packet_error_rate_floor,
      joint_state_queued_traffic_floor_mb: jointCoupling.queued_traffic_floor_mb,
      joint_state_dropped_traffic_floor_mb: jointCoupling.dropped_traffic_floor_mb,
      state_tensor_joint_completion_enabled: effectiveStateTensorJointCompletionEnabled,
      state_tensor_joint_completion_applied: stateTensorJoint.applied,
      state_tensor_joint_completion_metrics: stateTensorJoint.metrics,
      state_tensor_joint_completion_tags: stateTensorJoint.tags,
      state_tensor_joint_completion_pressure: stateTensorJoint.pressure,
      state_tensor_joint_utilization_pressure: stateTensorJoint.utilization_pressure,
      state_tensor_joint_load_pressure: stateTensorJoint.load_pressure,
      state_tensor_joint_queue_pressure: stateTensorJoint.queue_pressure,
      state_tensor_joint_loss_pressure: stateTensorJoint.loss_pressure,
      state_tensor_joint_evidence_score: stateTensorJoint.evidence_score,
      state_tensor_joint_load_ratio: stateTensorJoint.load_ratio,
      state_tensor_joint_queue_latency_floor_ms: stateTensorJoint.queue_latency_floor_ms,
      state_tensor_joint_congestion_floor_percent: stateTensorJoint.congestion_floor_percent,
      state_tensor_joint_packet_error_rate_floor: stateTensorJoint.packet_error_rate_floor,
      state_tensor_joint_queued_traffic_floor_mb: stateTensorJoint.queued_traffic_floor_mb,
      state_tensor_joint_dropped_traffic_floor_mb: stateTensorJoint.dropped_traffic_floor_mb,
      joint_tensor_physics_projection_enabled: jointTensorPhysicsProjectionEnabled,
      joint_tensor_physics_projection_applied: physicalProjection.applied,
      joint_tensor_physics_projection_metrics: physicalProjection.metrics.join("|"),
      confidence,
      spatial_group: spatialGroupKey(truth),
      context_prior_strength: linkContext.strength,
      context_prior_risk: linkContext.risk,
      context_prior_tags: linkContext.tags,
      latitude_context: linkContext.latitude_context,
      link_distance_to_threshold_ratio: linkContext.distance_to_threshold_ratio,
      link_availability_context: linkContext.availability_context,
      completion_prior_stack: directlyObserved
        ? "observed-int-report"
        : contactActive
          ? completionStackLabel(completionBackend, { orbitPeriodicPriorEnabled, businessHotspotMigrationPriorEnabled, stateTensorJointCompletionEnabled: effectiveStateTensorJointCompletionEnabled })
          : "topology-down-mask",
      int_mc_rank: rank,
      int_mc_iterations: iterations,
      int_mc_window_size: windowSize,
      int_mc_completion_backend: completionBackend,
      active_mask_source: contactByKey ? "predicted-contact-plan" : "leo-contact-plan",
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
        utilization_abs_error: round(Math.abs(numberValue(row.utilization_percent_estimate) - numberValue(truth.utilization_percent))),
        utilization_squared_error: round((numberValue(row.utilization_percent_estimate) - numberValue(truth.utilization_percent)) ** 2),
        utilization_high_truth: numberValue(truth.utilization_percent) >= 70,
        utilization_high_estimate: numberValue(row.utilization_percent_estimate) >= 70,
        truth_latency_ms: round(numberValue(truth.latency_ms)),
        latency_ms_estimate: row.latency_ms_estimate,
        latency_error_ms: round(numberValue(row.latency_ms_estimate) - numberValue(truth.latency_ms)),
        truth_queue_latency_ms: round(numberValue(truth.queue_latency_ms)),
        queue_latency_ms_estimate: row.queue_latency_ms_estimate,
        queue_latency_error_ms: round(numberValue(row.queue_latency_ms_estimate) - numberValue(truth.queue_latency_ms)),
        truth_capacity_mbps: round(numberValue(truth.effective_capacity_mbps || truth.capacity_mbps)),
        capacity_mbps_estimate: row.capacity_mbps_estimate,
        capacity_error_mbps: round(numberValue(row.capacity_mbps_estimate) - numberValue(truth.effective_capacity_mbps || truth.capacity_mbps)),
        truth_congestion_percent: round(numberValue(truth.congestion_percent)),
        congestion_percent_estimate: row.congestion_percent_estimate,
        congestion_error: round(numberValue(row.congestion_percent_estimate) - numberValue(truth.congestion_percent)),
        truth_queued_traffic_mb: round(numberValue(truth.queued_traffic_mb)),
        queued_traffic_mb_estimate: row.queued_traffic_mb_estimate,
        queued_traffic_error_mb: round(numberValue(row.queued_traffic_mb_estimate) - numberValue(truth.queued_traffic_mb)),
        truth_dropped_traffic_mb: round(numberValue(truth.dropped_traffic_mb)),
        dropped_traffic_mb_estimate: row.dropped_traffic_mb_estimate,
        dropped_traffic_error_mb: round(numberValue(row.dropped_traffic_mb_estimate) - numberValue(truth.dropped_traffic_mb)),
        truth_packet_error_rate: round(numberValue(truth.packet_error_rate), 6),
        packet_error_rate_estimate: row.packet_error_rate_estimate,
        packet_error_rate_error: round(numberValue(row.packet_error_rate_estimate) - numberValue(truth.packet_error_rate), 6),
      });
    }
  });

  nodeIds.forEach((nodeId) => {
    const truth = truthNodeByKey.get(`${sliceIndex}|${nodeId}`);
    if (!truth) return;
    const observed = observedNodeByKey.get(`${sliceIndex}|${nodeId}`);
    const directlyObserved = boolValue(observed?.observed);
    const catalog = firstTruthByNode.get(nodeId) ?? truth;
    const key = `${sliceIndex}|${nodeId}`;
    const source = directlyObserved ? "observed" : "inferred";
    const oamQuality = oamObservationQuality(observed, oamQualityFeedbackEnabled && directlyObserved);
    const estimates = {};
    const confidences = [];

    nodeMetrics.forEach((metric) => {
      const completed = completedNodeByMetric.get(metric.name);
      if (directlyObserved) {
        estimates[metric.name] = round(metric.observedValue(observed));
        confidences.push(oamQuality.confidence);
      } else {
        const value = completed.estimates.get(key);
        estimates[metric.name] = value === undefined ? "" : round(value);
        confidences.push(completed.confidence.get(key) ?? 0.25);
      }
    });
    const energyContextPrior = completedNodeByMetric.get("energy_percent")?.energyContextPrior?.get(key) ?? {};
    const energyPhysicsPrior = completedNodeByMetric.get("energy_percent")?.energyPhysicsPrior?.get(key) ?? {};

    const confidence = directlyObserved ? round(oamQuality.confidence) : round(mean(confidences));
    const nodeTensor = planeSlot(nodeId);
    const nodeTensorNeighbors = nodeTensorNeighborIds(nodeId, outputNodeTensorIndex);
    const nodeContext = nodeContextDetails(truth);
    const nodeWorkload = nodeWorkloads.get(key) ?? {};
    const nodeCoupling = nodeStateCoupling({
      enabled: effectiveNodeStateCouplingEnabled,
      source,
      estimates,
      workload: nodeWorkload,
      nodeContext,
      nodeCount: nodeIds.length,
    });
    Object.assign(estimates, nodeCoupling.estimates);
    const previousEnergy = previousInferredNodeEnergy.get(nodeId);
    const nodePhysicalProjection = source === "inferred" && jointTensorPhysicsProjectionEnabled
      ? projectNodePhysicalConsistency(estimates, {
          previousInferredEnergyPercent: previousEnergy?.sliceIndex === Number(sliceIndex) - 1
            ? previousEnergy.energyPercent
            : NaN,
          energyDeltaLimitPercentPerSlice: 5,
        })
      : { estimates, applied: false, metrics: [], hidden_truth_used: false };
    Object.assign(estimates, nodePhysicalProjection.estimates);
    const modeEstimate = directlyObserved
      ? observed.mode_estimate
      : nodeModeFromEstimate({
          cpu: numberValue(estimates.cpu_percent),
          energy: numberValue(estimates.energy_percent, 100),
          queueDepth: numberValue(estimates.queue_depth),
        });
    const row = {
      slice_index: Number(sliceIndex),
      time: truth.time,
      node_id: nodeId,
      label: catalog.label ?? nodeId,
      plane: catalog.plane,
      slot: catalog.slot,
      tensor_plane: nodeTensor.plane,
      tensor_slot: nodeTensor.slot,
      tensor_coordinate: nodeTensor.plane >= 0
        ? `T${sliceIndex}|P${padNumber(nodeTensor.plane, nodeTensor.plane_width)}-S${padNumber(nodeTensor.slot, nodeTensor.slot_width)}`
        : "",
      tensor_neighbor_count: nodeTensorNeighbors.length,
      observation_source: source,
      observed: directlyObserved,
      inferred: source === "inferred",
      last_observed_slice: directlyObserved ? observed.last_observed_slice : "",
      mode_estimate: modeEstimate,
      cpu_percent_estimate: estimates.cpu_percent,
      queue_depth_estimate: estimates.queue_depth,
      queued_traffic_mb_estimate: estimates.queued_traffic_mb,
      cache_used_mb_estimate: estimates.cache_used_mb,
      energy_percent_estimate: estimates.energy_percent,
      node_energy_context_prior_applied: boolValue(energyContextPrior.applied),
      node_energy_context_prior_source: energyContextPrior.source ?? "",
      node_energy_context_prior_group: energyContextPrior.group ?? "",
      node_energy_context_prior_weight: energyContextPrior.weight ?? "",
      node_energy_context_prior_value: energyContextPrior.value ?? "",
      node_energy_before_context_prior: energyContextPrior.before ?? "",
      node_energy_physics_prior_applied: boolValue(energyPhysicsPrior.applied),
      node_energy_physics_prior_source: energyPhysicsPrior.source ?? "",
      node_energy_physics_prior_weight: energyPhysicsPrior.weight ?? "",
      node_energy_physics_prior_value: energyPhysicsPrior.value ?? "",
      node_energy_before_physics_prior: energyPhysicsPrior.before ?? "",
      node_energy_physics_prior_net_power_w: energyPhysicsPrior.net_power_w ?? "",
      node_energy_physics_prior_step_hours: energyPhysicsPrior.step_hours ?? "",
      route_task_count: nodeWorkload.route_task_count ?? 0,
      route_traffic_mbps: nodeWorkload.route_traffic_mbps ?? 0,
      route_priority_mean: nodeWorkload.route_priority_mean ?? 0,
      route_queue_delay_ms: nodeWorkload.route_queue_delay_ms ?? 0,
      node_workload_score: nodeWorkload.node_workload_score ?? 0,
      node_state_coupling_enabled: effectiveNodeStateCouplingEnabled,
      node_state_coupling_applied: nodeCoupling.applied,
      node_state_coupled_metrics: nodeCoupling.metrics,
      node_state_coupling_tags: nodeCoupling.tags,
      node_state_coupling_pressure: nodeCoupling.pressure,
      node_state_coupling_evidence_score: nodeCoupling.evidence_score,
      node_state_workload_traffic_mbps: nodeCoupling.workload_traffic_mbps,
      node_state_workload_task_count: nodeCoupling.workload_task_count,
      node_state_energy_ceiling_percent: nodeCoupling.energy_ceiling_percent,
      joint_tensor_physics_projection_enabled: jointTensorPhysicsProjectionEnabled,
      joint_tensor_physics_projection_applied: nodePhysicalProjection.applied,
      joint_tensor_physics_projection_metrics: nodePhysicalProjection.metrics.join("|"),
      oam_quality_feedback_enabled: oamQualityFeedbackEnabled,
      oam_quality_feedback_applied: oamQuality.applied,
      oam_observation_confidence: oamQuality.source_confidence,
      oam_observation_confidence_state: oamQuality.confidence_state,
      oam_conflict_severity: oamQuality.conflict_severity,
      oam_quality_confidence_penalty: round(oamQuality.confidence_penalty),
      oam_quality_feedback_tags: oamQuality.tags,
      confidence,
      context_prior_strength: nodeContext.strength,
      context_prior_risk: nodeContext.risk,
      context_prior_tags: nodeContext.tags,
      latitude_context: nodeContext.latitude_context,
      illumination_context: nodeContext.illumination_context,
      solar_exposure_context: nodeContext.solar_exposure_context,
      completion_prior_stack: directlyObserved
        ? "observed-int-report"
        : completionStackLabel(completionBackend, { orbitPeriodicPriorEnabled }),
      int_mc_rank: rank,
      int_mc_iterations: iterations,
      int_mc_window_size: windowSize,
      int_mc_completion_backend: completionBackend,
      spatial_group: nodeSpatialGroupKey(truth),
    };
    nodeReconstructionRows.push(row);
    if (source === "inferred") {
      previousInferredNodeEnergy.set(nodeId, {
        sliceIndex: Number(sliceIndex),
        energyPercent: numberValue(row.energy_percent_estimate, NaN),
      });
    } else {
      previousInferredNodeEnergy.delete(nodeId);
    }

    nodeErrorRows.push({
      slice_index: Number(sliceIndex),
      node_id: nodeId,
      observation_source: source,
      truth_mode: truth.mode,
      mode_estimate: modeEstimate,
      truth_cpu_percent: round(numberValue(truth.cpu_percent)),
      cpu_percent_estimate: row.cpu_percent_estimate,
      cpu_error: round(numberValue(row.cpu_percent_estimate) - numberValue(truth.cpu_percent)),
      truth_queue_depth: round(numberValue(truth.queue_depth)),
      queue_depth_estimate: row.queue_depth_estimate,
      queue_depth_error: round(numberValue(row.queue_depth_estimate) - numberValue(truth.queue_depth)),
      truth_queued_traffic_mb: round(numberValue(truth.queued_traffic_mb)),
      queued_traffic_mb_estimate: row.queued_traffic_mb_estimate,
      queued_traffic_error_mb: round(numberValue(row.queued_traffic_mb_estimate) - numberValue(truth.queued_traffic_mb)),
      truth_energy_percent: round(numberValue(truth.energy_percent)),
      energy_percent_estimate: row.energy_percent_estimate,
      energy_error: round(numberValue(row.energy_percent_estimate) - numberValue(truth.energy_percent)),
    });
  });
});

const completionPriorityRetests = buildDeployableCompletionPriorityRetests({
  reconstructionRows,
  nodeReconstructionRows,
  sliceIndexes,
  maxPerSlice: completionFeedbackMaxPerSlice,
  oamQualityFeedbackEnabled,
});

const evaluation = {
  ...evaluate(reconstructionRows, truthByKey, metrics),
  node_reconstruction: evaluateNodeReconstruction(nodeReconstructionRows, truthNodeByKey, nodeMetrics),
  source: {
    input_dir: inputDir,
    stage2_dir: stage2Dir,
    ground_oam_dir: groundDir,
    truth_links_csv: linksPath,
    truth_nodes_csv: nodesPath,
    routes_csv: existsSync(routesPath) ? routesPath : "",
    observed_ground_links_csv: groundLinksPath,
    observed_ground_nodes_csv: groundNodesPath,
    predicted_contact_plan_json: predictedContactPlanPath ? resolve(predictedContactPlanPath) : "",
  },
  boundary: {
    matrix_completion_runs_at_ground_oam: true,
    satellites_run_no_matrix_completion: true,
    active_mask_from_predicted_contact_plan: Boolean(contactByKey),
    observed_mask_from_delivered_int_reports: true,
    truth_metrics_used_only_for_evaluation: true,
    topology_down_not_completed: true,
    satellite_spatial_prior_uses_observed_group_statistics_only: true,
    tensor_neighbor_prior_uses_same_slice_observed_neighbors_only: true,
    node_matrix_completion_uses_observed_ground_oam_nodes_only: true,
    link_artifacts_written: writeLinkArtifacts,
    temporal_prior_uses_observed_neighbor_slices_only: true,
    orbit_periodic_prior_uses_observed_same_entity_periodic_slices_only: orbitPeriodicPriorEnabled,
    oam_quality_feedback_uses_ground_oam_confidence_and_conflict_only: oamQualityFeedbackEnabled,
    context_prior_uses_predictable_orbital_power_and_contact_context: true,
    business_hotspot_uses_route_paths_not_link_truth_metrics: true,
    business_hotspot_migration_uses_route_paths_and_orbit_neighbors_not_link_truth_metrics: businessHotspotMigrationPriorEnabled,
    orbit_graph_regularization_uses_same_slice_reconstructed_or_observed_neighbors_only: orbitGraphRegularizationEnabled,
    utilization_load_consistency_uses_route_traffic_and_reconstructed_capacity: true,
    metric_tensor_coupling_uses_reconstructed_link_time_metrics_only: metricTensorCouplingEnabled,
    node_state_coupling_uses_reconstructed_node_metrics_and_route_workload_only: effectiveNodeStateCouplingEnabled,
    node_energy_physics_prior_uses_predictable_solar_and_static_load_context: nodeEnergyPhysicsPriorEnabled,
    joint_state_coupling_uses_reconstructed_metrics_and_routed_traffic_only: jointStateCouplingEnabled,
    state_tensor_joint_completion_uses_reconstructed_metrics_and_routed_traffic_only: effectiveStateTensorJointCompletionEnabled,
    completion_backend_runs_at_ground_oam: true,
    completion_backend_uses_delivered_int_observations_only: true,
    joint_tensor_normalization_uses_direct_observations_only: isJointTensorBackend(completionBackend),
    joint_tensor_direct_observations_locked: isJointTensorBackend(completionBackend),
    joint_tensor_physics_projection_uses_reconstructed_state_and_routed_context_only: jointTensorPhysicsProjectionEnabled,
    completion_feedback_targets_next_probe_round: true,
  },
  completion_feedback: {
    priority_retest_targets: completionPriorityRetests.length,
    max_targets_per_slice: completionFeedbackMaxPerSlice,
    source: "observable-confidence-model-disagreement-and-context-risk",
    uses_truth_error: false,
    target_slice_policy: "source-slice-plus-one-when-available",
  },
  parameters: {
    algorithm,
    completion_backend: completionBackend,
    completion_backend_family: completionBackendFamily(completionBackend),
    scalar_initialization_backend: scalarCompletionBackend,
    rank,
    iterations,
    window_size: windowSize,
    ml_epochs: ["st-gnn", "costco"].includes(completionBackend) ? mlEpochs : 0,
    ml_learning_rate: ["st-gnn", "costco"].includes(completionBackend) ? mlLearningRate : 0,
    ml_training_samples: ["st-gnn", "costco"].includes(completionBackend) ? mlTrainingSamples : 0,
    ml_hidden_units: ["st-gnn", "costco"].includes(completionBackend) ? mlHiddenUnits : 0,
    ml_hidden_layers: ["st-gnn", "costco"].includes(completionBackend) ? mlHiddenLayers : 0,
    ml_latent_rank: completionBackend === "costco" ? mlLatentRank : null,
    soft_impute_lambda_ratio: ["soft-impute", "graph-regularized"].includes(completionBackend)
      ? softImputeLambdaRatio
      : null,
    graph_regularization_weight: completionBackend === "graph-regularized" ? graphRegularizationWeight : null,
    temporal_regularization_weight: completionBackend === "graph-regularized" ? temporalRegularizationWeight : null,
    prior_regularization_weight: completionBackend === "graph-regularized" ? priorRegularizationWeight : null,
    low_rank_regularization_weight: completionBackend === "graph-regularized" ? lowRankRegularizationWeight : null,
    joint_tensor_rank: isJointTensorBackend(completionBackend) ? jointTensorRank : null,
    joint_tensor_epochs: isJointTensorBackend(completionBackend) ? jointTensorEpochs : null,
    joint_tensor_learning_rate: isJointTensorBackend(completionBackend) ? jointTensorLearningRate : null,
    joint_tensor_l2: isJointTensorBackend(completionBackend) ? jointTensorL2 : null,
    joint_tensor_prediction_weight: isJointTensorBackend(completionBackend) ? jointTensorPredictionWeight : null,
    joint_tensor_temporal_regularization: isJointTensorBackend(completionBackend) ? jointTensorTemporalRegularization : null,
    joint_tensor_orbit_regularization: isJointTensorBackend(completionBackend) ? jointTensorOrbitRegularization : null,
    joint_tensor_physics_projection_enabled: jointTensorPhysicsProjectionEnabled,
    metric_tensor_coupling_enabled: metricTensorCouplingEnabled,
    node_state_coupling_enabled: effectiveNodeStateCouplingEnabled,
    node_energy_physics_prior_enabled: nodeEnergyPhysicsPriorEnabled,
    orbit_periodic_prior_enabled: orbitPeriodicPriorEnabled,
    orbit_periodic_prior_slices: orbitPeriodicPriorEnabled ? orbitPeriodicPriorSlices : null,
    business_hotspot_migration_prior_enabled: businessHotspotMigrationPriorEnabled,
    orbit_graph_regularization_enabled: orbitGraphRegularizationEnabled,
    oam_quality_feedback_enabled: oamQualityFeedbackEnabled,
    joint_state_coupling_enabled: jointStateCouplingEnabled,
    state_tensor_joint_completion_enabled: effectiveStateTensorJointCompletionEnabled,
    completion_feedback_max_per_slice: completionFeedbackMaxPerSlice,
    spatial_priors: [
      "same-plane vs cross-plane link class",
      "bounded plane gap",
      "same-slot vs slot-gap group",
      "link kind group fallback",
      "node plane-band and slot-band group",
      "plane-slot-time tensor neighbor prior",
      "same-plane adjacent-slot and adjacent-plane same-slot neighbors",
      "same-slice spatial group statistics from delivered OAM observations",
      "temporal neighbor slices inside completion window",
      orbitPeriodicPriorEnabled ? `same-entity orbital periodic slices at lag ${orbitPeriodicPriorSlices}` : "",
      "illumination-group battery energy prior from delivered node observations",
      nodeEnergyPhysicsPriorEnabled ? "battery state propagation from predicted net power and previous OAM energy estimate" : "",
      businessHotspotMigrationPriorEnabled ? "business hotspot migration from routed paths on nearby time slices and orbit-tensor neighbors" : "",
      oamQualityFeedbackEnabled ? "Ground OAM confidence/conflict feedback for direct observations" : "",
      effectiveStateTensorJointCompletionEnabled ? "state tensor joint consistency among reconstructed utilization, queue, congestion, loss and routed traffic" : "",
      "contact availability, solar/shadow and power-margin context as confidence priors",
      "business hotspot tags from routed task paths",
    ].filter(Boolean),
    prediction_horizon_slices: predictedContactPlan?.engineering_parameters?.prediction_horizon_slices ?? null,
    refresh_slices: predictedContactPlan?.engineering_parameters?.refresh_slices ?? null,
    completion_window_slices: predictedContactPlan?.engineering_parameters?.completion_window_slices ?? null,
    metrics: metrics.map((metric) => metric.name),
    node_metrics: nodeMetrics.map((metric) => metric.name),
    business_hotspot_links: businessHotspots.size,
  },
  joint_tensor_completion: {
    enabled: isJointTensorBackend(completionBackend),
    backend: completionBackend,
    scalar_initialization_backend: scalarCompletionBackend,
    link: jointLinkTensorCompletion,
    node: jointNodeTensorCompletion,
  },
  context_prior_summary: {
    link_context_tags_enabled: true,
    node_context_tags_enabled: true,
    polar_link_context_samples: reconstructionRows.filter((row) => String(row.context_prior_tags).includes("polar-region")).length,
    high_latitude_link_context_samples: reconstructionRows.filter((row) => String(row.context_prior_tags).includes("high-latitude-region")).length,
    solar_interference_link_context_samples: reconstructionRows.filter((row) => String(row.context_prior_tags).includes("solar-interference-risk")).length,
    business_hotspot_link_context_samples: reconstructionRows.filter((row) => String(row.context_prior_tags).includes("business-hotspot")).length,
    business_hotspot_migration_applied_link_samples: reconstructionRows.filter((row) => boolValue(row.business_hotspot_migration_applied)).length,
    business_hotspot_migration_candidate_links: reconstructionRows.filter((row) => numberValue(row.business_hotspot_migration_candidate_count) > 0).length,
    mean_business_hotspot_migration_score: round(mean(reconstructionRows.map((row) => numberValue(row.business_hotspot_migration_score, NaN)).filter(Number.isFinite))),
    mean_business_hotspot_migration_quality: round(mean(reconstructionRows.map((row) => numberValue(row.business_hotspot_migration_quality, NaN)).filter(Number.isFinite))),
    shadow_node_context_samples: nodeReconstructionRows.filter((row) => String(row.context_prior_tags).includes("shadow")).length,
    low_energy_node_context_samples: nodeReconstructionRows.filter((row) => String(row.context_prior_tags).includes("low-energy")).length,
    traffic_hotspot_node_context_samples: nodeReconstructionRows.filter((row) => String(row.context_prior_tags).includes("traffic-hotspot")).length,
    node_workload_context_samples: nodeReconstructionRows.filter((row) => numberValue(row.route_traffic_mbps) > 0 || numberValue(row.route_task_count) > 0).length,
    node_energy_context_prior_values: nodeReconstructionRows.filter((row) => boolValue(row.node_energy_context_prior_applied)).length,
    mean_node_energy_context_prior_weight: round(mean(nodeReconstructionRows.map((row) => numberValue(row.node_energy_context_prior_weight, NaN)).filter(Number.isFinite))),
    node_energy_physics_prior_values: nodeReconstructionRows.filter((row) => boolValue(row.node_energy_physics_prior_applied)).length,
    mean_node_energy_physics_prior_weight: round(mean(nodeReconstructionRows.map((row) => numberValue(row.node_energy_physics_prior_weight, NaN)).filter(Number.isFinite))),
    node_state_coupled_samples: nodeReconstructionRows.filter((row) => boolValue(row.node_state_coupling_applied)).length,
    mean_node_state_coupling_pressure: round(mean(nodeReconstructionRows.map((row) => numberValue(row.node_state_coupling_pressure, NaN)).filter(Number.isFinite))),
    orbit_graph_regularized_link_samples: reconstructionRows.filter((row) => boolValue(row.orbit_graph_regularization_applied)).length,
    mean_orbit_graph_regularization_strength: round(mean(reconstructionRows.map((row) => numberValue(row.orbit_graph_regularization_strength, NaN)).filter(Number.isFinite))),
    utilization_load_consistency_samples: reconstructionRows.filter((row) => boolValue(row.business_load_consistency_applied)).length,
    metric_tensor_coupled_link_samples: reconstructionRows.filter((row) => boolValue(row.metric_tensor_coupling_applied)).length,
    mean_metric_tensor_coupling_pressure: round(mean(reconstructionRows.map((row) => numberValue(row.metric_tensor_coupling_pressure, NaN)).filter(Number.isFinite))),
    oam_quality_feedback_low_confidence_observed_links: reconstructionRows.filter((row) => row.observation_source === "observed" && boolValue(row.oam_quality_feedback_applied) && numberValue(row.confidence) < 0.5).length,
    oam_quality_feedback_low_confidence_observed_nodes: nodeReconstructionRows.filter((row) => row.observation_source === "observed" && boolValue(row.oam_quality_feedback_applied) && numberValue(row.confidence) < 0.5).length,
    oam_quality_feedback_conflicting_observed_links: reconstructionRows.filter((row) => row.observation_source === "observed" && numberValue(row.oam_conflict_severity) > 0.2).length,
    oam_quality_feedback_conflicting_observed_nodes: nodeReconstructionRows.filter((row) => row.observation_source === "observed" && numberValue(row.oam_conflict_severity) > 0.2).length,
    oam_quality_feedback_retest_targets: completionPriorityRetests.filter((row) => String(row.reason).includes("oam-observation")).length,
    joint_state_coupling_link_samples: reconstructionRows.filter((row) => boolValue(row.joint_state_coupling_applied)).length,
    mean_joint_state_coupling_pressure: round(mean(reconstructionRows.map((row) => numberValue(row.joint_state_coupling_pressure, NaN)).filter(Number.isFinite))),
    state_tensor_joint_completed_link_samples: reconstructionRows.filter((row) => boolValue(row.state_tensor_joint_completion_applied)).length,
    mean_state_tensor_joint_completion_pressure: round(mean(reconstructionRows.map((row) => numberValue(row.state_tensor_joint_completion_pressure, NaN)).filter(Number.isFinite))),
    mean_link_context_prior_strength: round(mean(reconstructionRows.map((row) => numberValue(row.context_prior_strength, NaN)).filter(Number.isFinite))),
    mean_link_context_prior_risk: round(mean(reconstructionRows.map((row) => numberValue(row.context_prior_risk, NaN)).filter(Number.isFinite))),
    mean_node_context_prior_strength: round(mean(nodeReconstructionRows.map((row) => numberValue(row.context_prior_strength, NaN)).filter(Number.isFinite))),
    mean_node_context_prior_risk: round(mean(nodeReconstructionRows.map((row) => numberValue(row.context_prior_risk, NaN)).filter(Number.isFinite))),
  },
  contact_plan_prediction: predictedContactPlan
    ? {
        schema_version: predictedContactPlan.schema_version,
        evaluation: predictedContactPlan.evaluation,
        topology_class_count: predictedContactPlan.topology_classes?.length ?? 0,
      }
    : null,
  matrix_summaries: matrixSummaries,
  node_matrix_summaries: nodeMatrixSummaries,
};

await mkdir(outputDir, { recursive: true });
const outputWrites = [
  writeFile(join(outputDir, "ground-mc-reconstructed-nodes.csv"), rowsToCsv(nodeReconstructionRows), "utf8"),
  writeFile(join(outputDir, "int-mc-node-errors.csv"), rowsToCsv(nodeErrorRows), "utf8"),
  writeFile(join(outputDir, "int-mc-priority-retest.csv"), rowsToCsv(completionPriorityRetests), "utf8"),
  writeFile(join(outputDir, "int-mc-deployable-priority-retest.csv"), rowsToCsv(completionPriorityRetests), "utf8"),
  writeFile(join(outputDir, "int-mc-matrix-summary.csv"), rowsToCsv(matrixSummaries), "utf8"),
  writeFile(join(outputDir, "int-mc-node-matrix-summary.csv"), rowsToCsv(nodeMatrixSummaries), "utf8"),
  writeFile(join(outputDir, "int-mc-evaluation.json"), JSON.stringify(evaluation, null, 2), "utf8"),
];
if (writeLinkArtifacts) {
  outputWrites.push(
    writeFile(join(outputDir, "ground-mc-reconstructed-links.csv"), rowsToCsv(reconstructionRows), "utf8"),
    writeFile(join(outputDir, "int-mc-link-errors.csv"), rowsToCsv(errorRows), "utf8"),
  );
}
await Promise.all(outputWrites);

console.log(JSON.stringify({
  ok: true,
  outputDir,
  algorithm,
  completionBackend,
  writeLinkArtifacts,
  rank,
  iterations,
  linkSamples: evaluation.reconstruction.link_samples,
  activeLinkSamples: evaluation.reconstruction.active_link_samples,
  observedLinkSamples: evaluation.reconstruction.observed_link_samples,
  inferredLinkSamples: evaluation.reconstruction.inferred_link_samples,
  activeLinkCompletionCoverage: evaluation.reconstruction.active_link_completion_coverage,
  nodeCompletionCoverage: evaluation.node_reconstruction.node_completion_coverage,
  inferredNodeSamples: evaluation.node_reconstruction.inferred_node_samples,
  statusAccuracyAllLinks: evaluation.reconstruction.status_accuracy_all_links,
  completionPriorityRetests: completionPriorityRetests.length,
}, null, 2));
