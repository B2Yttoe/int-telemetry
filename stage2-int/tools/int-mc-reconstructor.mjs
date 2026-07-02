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

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
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

function completeMetricMatrix({ metric, linkIds, sliceIndexes, truthByKey, observedByKey, contactByKey, rank, iterations, windowSize }) {
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
      },
    };
  }

  const globalMean = mean(observedValues);
  const globalStd = Math.sqrt(mean(observedValues.map((value) => (value - globalMean) ** 2))) || 1;
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
    same_slice_spatial_group: 0,
    same_slice_all_groups: 0,
    row_history: 0,
    column_observations: 0,
    historical_spatial_group: 0,
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
      if (Number.isFinite(temporal.value) && Number.isFinite(tensorNeighbor.value)) {
        priorUsage.temporal_neighbor += 1;
        priorUsage.tensor_neighbor += 1;
        return ((temporal.value * 0.7 + tensorNeighbor.value * 0.3) - globalMean) / globalStd;
      }
      if (Number.isFinite(temporal.value)) {
        priorUsage.temporal_neighbor += 1;
        return (temporal.value - globalMean) / globalStd;
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
      const truth = truthByKey.get(`${sliceIndex}|${linkId}`);
      const group = truth ? spatialGroupKey(truth) : "";
      const prior = truth ? spatialPriorStats.get(group) : null;
      const priorDensity = Math.min((prior?.count ?? 0) / Math.max(sliceIndexes.length, 1), 1);
      const sameSlicePrior = group ? sliceSpatialPriorStats.get(`${sliceIndex}|${group}`) : null;
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
      same_slice_spatial_prior_values: priorUsage.same_slice_spatial_group,
      same_slice_global_prior_values: priorUsage.same_slice_all_groups,
      row_history_prior_values: priorUsage.row_history,
      column_prior_values: priorUsage.column_observations,
      historical_spatial_prior_values: priorUsage.historical_spatial_group,
      global_default_values: priorUsage.global_default,
      global_mean: round(globalMean),
      global_std: round(globalStd),
    },
  };
}

function completeNodeMetricMatrix({ metric, nodeIds, sliceIndexes, truthByKey, observedByKey, rank, iterations, windowSize }) {
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
      },
    };
  }

  const globalMean = mean(observedValues);
  const globalStd = Math.sqrt(mean(observedValues.map((value) => (value - globalMean) ** 2))) || 1;
  const nodeTensorIndex = buildNodeTensorIndex(nodeIds);
  const spatialPriorStats = buildNodeSpatialPriorStats({ metric, nodeIds, sliceIndexes, truthByKey, observedByKey });
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
      if (Number.isFinite(temporal.value) && Number.isFinite(tensorNeighbor.value)) {
        priorUsage.temporal_neighbor += 1;
        priorUsage.tensor_neighbor += 1;
        return ((temporal.value * 0.7 + tensorNeighbor.value * 0.3) - globalMean) / globalStd;
      }
      if (Number.isFinite(temporal.value)) {
        priorUsage.temporal_neighbor += 1;
        return (temporal.value - globalMean) / globalStd;
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

  let completed = matrix.map((row) => [...row]);
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    completed = lowRankApprox(completed, activeMask, rank);
    nodeIds.forEach((nodeId, rowIndex) => {
      sliceIndexes.forEach((sliceIndex, colIndex) => {
        if (observedMask[rowIndex][colIndex]) completed[rowIndex][colIndex] = matrix[rowIndex][colIndex];
      });
    });
  }

  const estimates = new Map();
  const confidence = new Map();
  let completedValues = 0;
  nodeIds.forEach((nodeId, rowIndex) => {
    sliceIndexes.forEach((sliceIndex, colIndex) => {
      const key = `${sliceIndex}|${nodeId}`;
      const denormalized = completed[rowIndex][colIndex] * globalStd + globalMean;
      estimates.set(key, metric.clamp(denormalized));
      const rowDensity = rowCounts[rowIndex] / Math.max(sliceIndexes.length, 1);
      const columnDensity = columnCounts[colIndex] / Math.max(nodeIds.length, 1);
      const truth = truthByKey.get(`${sliceIndex}|${nodeId}`);
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
              0.07 * contextStrength,
          ),
        ),
      );
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
      same_slice_spatial_prior_values: priorUsage.same_slice_spatial_group,
      same_slice_global_prior_values: priorUsage.same_slice_all_groups,
      row_history_prior_values: priorUsage.row_history,
      column_prior_values: priorUsage.column_observations,
      historical_spatial_prior_values: priorUsage.historical_spatial_group,
      global_default_values: priorUsage.global_default,
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

function statusFromEstimate({ active, utilization, congestion, capacity, droppedTraffic, packetErrorRate }) {
  if (!active) return "down";
  if (capacity <= 0) return "down";
  if (congestion > 0 || utilization >= 85 || droppedTraffic > 0 || packetErrorRate >= 0.02) return "warning";
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

function nodeModeFromEstimate({ cpu, energy }) {
  if (energy <= 0) return "offline";
  if (energy < 20) return "power-saving";
  if (cpu >= 80) return "busy";
  return "nominal";
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
    const allErrors = [];
    const inferredErrors = [];
    const truthValues = [];
    reconstructionRows.forEach((row) => {
      const truth = truthByKey.get(`${row.slice_index}|${row.node_id}`);
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
const rank = numberArg(args, "--rank", 5);
const iterations = numberArg(args, "--iterations", 12);
const windowSize = numberArg(args, "--window-size", 12);
const predictedContactPlanPath = argValue(args, "--predicted-contact-plan", "");

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
const metrics = metricDefinitions();
const nodeMetrics = nodeMetricDefinitions();
const completedByMetric = new Map();
const completedNodeByMetric = new Map();
const matrixSummaries = [];
const nodeMatrixSummaries = [];
const outputLinkTensorIndex = buildLinkTensorIndex({ linkIds, sliceIndexes, truthByKey });
const outputNodeTensorIndex = buildNodeTensorIndex(nodeIds);

metrics.forEach((metric) => {
  const completed = completeMetricMatrix({
    metric,
    linkIds,
    sliceIndexes,
    truthByKey,
    observedByKey,
    contactByKey,
    rank,
    iterations,
    windowSize,
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
  });
  completedNodeByMetric.set(metric.name, completed);
  nodeMatrixSummaries.push(completed.summary);
});

const reconstructionRows = [];
const errorRows = [];
const nodeReconstructionRows = [];
const nodeErrorRows = [];

sliceIndexes.forEach((sliceIndex) => {
  linkIds.forEach((linkId) => {
    const truth = truthByKey.get(`${sliceIndex}|${linkId}`);
    if (!truth) return;
    const observed = observedByKey.get(`${sliceIndex}|${linkId}`);
    const contactActive = contactActiveFor(contactByKey, truth, sliceIndex, linkId);
    const directlyObserved = boolValue(observed?.observed);
    const catalog = firstTruthByLink.get(linkId) ?? truth;
    const key = `${sliceIndex}|${linkId}`;
    const hotspot = businessHotspots.get(key) ?? {};
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
          droppedTraffic: numberValue(estimates.dropped_traffic_mb),
          packetErrorRate: numberValue(estimates.packet_error_rate),
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
      route_task_count: hotspot.route_task_count ?? 0,
      route_traffic_mbps: hotspot.route_traffic_mbps ?? 0,
      route_priority_mean: hotspot.route_priority_mean ?? 0,
      route_queue_delay_ms: hotspot.route_queue_delay_ms ?? 0,
      business_hotspot_score: hotspot.business_hotspot_score ?? 0,
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
          ? "temporal-neighbor+tensor-neighbor+same-slice-spatial+historical-spatial+low-rank"
          : "topology-down-mask",
      int_mc_rank: rank,
      int_mc_iterations: iterations,
      int_mc_window_size: windowSize,
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
    const estimates = {};
    const confidences = [];

    nodeMetrics.forEach((metric) => {
      const completed = completedNodeByMetric.get(metric.name);
      if (directlyObserved) {
        estimates[metric.name] = round(metric.observedValue(observed));
        confidences.push(1);
      } else {
        const value = completed.estimates.get(key);
        estimates[metric.name] = value === undefined ? "" : round(value);
        confidences.push(completed.confidence.get(key) ?? 0.25);
      }
    });

    const confidence = directlyObserved ? 1 : round(mean(confidences));
    const nodeTensor = planeSlot(nodeId);
    const nodeTensorNeighbors = nodeTensorNeighborIds(nodeId, outputNodeTensorIndex);
    const nodeContext = nodeContextDetails(truth);
    const modeEstimate = directlyObserved
      ? observed.mode_estimate
      : nodeModeFromEstimate({
          cpu: numberValue(estimates.cpu_percent),
          energy: numberValue(estimates.energy_percent, 100),
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
      confidence,
      context_prior_strength: nodeContext.strength,
      context_prior_risk: nodeContext.risk,
      context_prior_tags: nodeContext.tags,
      latitude_context: nodeContext.latitude_context,
      illumination_context: nodeContext.illumination_context,
      solar_exposure_context: nodeContext.solar_exposure_context,
      completion_prior_stack: directlyObserved
        ? "observed-int-report"
        : "temporal-neighbor+tensor-neighbor+same-slice-spatial+historical-spatial+low-rank",
      int_mc_rank: rank,
      int_mc_iterations: iterations,
      int_mc_window_size: windowSize,
      spatial_group: nodeSpatialGroupKey(truth),
    };
    nodeReconstructionRows.push(row);

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
    temporal_prior_uses_observed_neighbor_slices_only: true,
    context_prior_uses_predictable_orbital_power_and_contact_context: true,
    business_hotspot_uses_route_paths_not_link_truth_metrics: true,
  },
  parameters: {
    algorithm,
    rank,
    iterations,
    window_size: windowSize,
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
      "contact availability, solar/shadow and power-margin context as confidence priors",
      "business hotspot tags from routed task paths",
    ],
    prediction_horizon_slices: predictedContactPlan?.engineering_parameters?.prediction_horizon_slices ?? null,
    refresh_slices: predictedContactPlan?.engineering_parameters?.refresh_slices ?? null,
    completion_window_slices: predictedContactPlan?.engineering_parameters?.completion_window_slices ?? null,
    metrics: metrics.map((metric) => metric.name),
    node_metrics: nodeMetrics.map((metric) => metric.name),
    business_hotspot_links: businessHotspots.size,
  },
  context_prior_summary: {
    link_context_tags_enabled: true,
    node_context_tags_enabled: true,
    polar_link_context_samples: reconstructionRows.filter((row) => String(row.context_prior_tags).includes("polar-region")).length,
    high_latitude_link_context_samples: reconstructionRows.filter((row) => String(row.context_prior_tags).includes("high-latitude-region")).length,
    solar_interference_link_context_samples: reconstructionRows.filter((row) => String(row.context_prior_tags).includes("solar-interference-risk")).length,
    business_hotspot_link_context_samples: reconstructionRows.filter((row) => String(row.context_prior_tags).includes("business-hotspot")).length,
    shadow_node_context_samples: nodeReconstructionRows.filter((row) => String(row.context_prior_tags).includes("shadow")).length,
    low_energy_node_context_samples: nodeReconstructionRows.filter((row) => String(row.context_prior_tags).includes("low-energy")).length,
    traffic_hotspot_node_context_samples: nodeReconstructionRows.filter((row) => String(row.context_prior_tags).includes("traffic-hotspot")).length,
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
await Promise.all([
  writeFile(join(outputDir, "ground-mc-reconstructed-links.csv"), rowsToCsv(reconstructionRows), "utf8"),
  writeFile(join(outputDir, "ground-mc-reconstructed-nodes.csv"), rowsToCsv(nodeReconstructionRows), "utf8"),
  writeFile(join(outputDir, "int-mc-link-errors.csv"), rowsToCsv(errorRows), "utf8"),
  writeFile(join(outputDir, "int-mc-node-errors.csv"), rowsToCsv(nodeErrorRows), "utf8"),
  writeFile(join(outputDir, "int-mc-matrix-summary.csv"), rowsToCsv(matrixSummaries), "utf8"),
  writeFile(join(outputDir, "int-mc-node-matrix-summary.csv"), rowsToCsv(nodeMatrixSummaries), "utf8"),
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
  nodeCompletionCoverage: evaluation.node_reconstruction.node_completion_coverage,
  inferredNodeSamples: evaluation.node_reconstruction.inferred_node_samples,
  statusAccuracyAllLinks: evaluation.reconstruction.status_accuracy_all_links,
}, null, 2));
