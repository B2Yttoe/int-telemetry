import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";

function argValue(args, name, fallback = "") {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  return args[index + 1] ?? fallback;
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

function numberValue(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolValue(value) {
  return String(value).toLowerCase() === "true";
}

function mean(values) {
  if (values.length === 0) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function round(value, digits = 4) {
  return Number(value.toFixed(digits));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function roundBytes(value, step = 512) {
  return Math.max(0, Math.round(value / step) * step);
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

function uniqueLatestBy(rows, keyFn) {
  const map = new Map();
  rows.forEach((row) => {
    const key = keyFn(row);
    const old = map.get(key);
    if (!old || numberValue(row.hop_index) >= numberValue(old.hop_index)) map.set(key, row);
  });
  return [...map.values()];
}

function majority(values, fallback = "") {
  const counts = new Map();
  values.filter((value) => value !== undefined && value !== "").forEach((value) => {
    const key = String(value);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  });
  if (counts.size === 0) return fallback;
  return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0][0];
}

function unique(values) {
  return [...new Set(values.filter((value) => value !== undefined && value !== ""))];
}

function meanField(rows, field) {
  const values = rows.map((row) => numberValue(row[field], NaN)).filter(Number.isFinite);
  return values.length ? round(mean(values)) : "";
}

function disagreementRatio(rows, field) {
  const values = rows.map((row) => String(row[field] ?? "")).filter(Boolean);
  if (values.length <= 1) return 0;
  return 1 - Math.max(...[...groupBy(values, (value) => value).values()].map((items) => items.length)) / values.length;
}

function numericSpreadRatio(rows, fieldScales) {
  const spreads = Object.entries(fieldScales).map(([field, scale]) => {
    const values = rows.map((row) => numberValue(row[field], NaN)).filter(Number.isFinite);
    if (values.length <= 1) return 0;
    return clamp((Math.max(...values) - Math.min(...values)) / Math.max(scale, 1e-6), 0, 1);
  });
  return round(mean(spreads));
}

function fusionQuality({ rows, categoricalConflict, numericSpread }) {
  const conflictSeverity = clamp(categoricalConflict * 0.7 + numericSpread * 0.3, 0, 1);
  const sampleSupport = clamp(Math.log2(rows.length + 1) * 0.04, 0, 0.12);
  const confidencePenalty = clamp(conflictSeverity * 0.55, 0, 0.55);
  const confidence = clamp(1 - confidencePenalty + sampleSupport, 0.35, 1);
  return {
    conflict_severity: round(conflictSeverity),
    categorical_conflict_ratio: round(categoricalConflict),
    numeric_conflict_ratio: round(numericSpread),
    fusion_confidence_penalty: round(confidencePenalty),
    fusion_sample_support: round(sampleSupport),
    fusion_confidence: round(confidence),
    fusion_method: "majority-mean-conflict-aware-fusion",
  };
}

function aggregateHopRecords(rows, keyFn, type) {
  return [...groupBy(rows, keyFn).values()].map((items) => {
    const latest = items.reduce((best, item) => (numberValue(item.hop_index) >= numberValue(best.hop_index) ? item : best), items[0]);
    const categoricalConflict =
      type === "node"
        ? disagreementRatio(items, "observed_node_mode")
        : Math.max(disagreementRatio(items, "observed_link_status"), disagreementRatio(items, "observed_link_active"));
    const numericSpread = type === "node"
      ? numericSpreadRatio(items, {
          observed_cpu_percent: 100,
          observed_queue_depth: 128,
          observed_queued_traffic_mb: 256,
          observed_cache_used_mb: 1024,
          observed_energy_percent: 100,
        })
      : numericSpreadRatio(items, {
          observed_link_utilization_percent: 100,
          observed_link_latency_ms: 120,
          observed_link_queue_latency_ms: 120,
          observed_link_capacity_mbps: 10000,
          observed_link_congestion_percent: 100,
          observed_link_queued_mb: 256,
          observed_link_dropped_mb: 256,
          observed_link_packet_error_rate: 1,
        });
    const fusion = fusionQuality({ rows: items, categoricalConflict, numericSpread });
    if (type === "node") {
      return {
        ...latest,
        observed_node_mode: majority(items.map((item) => item.observed_node_mode), latest.observed_node_mode),
        observed_cpu_percent: meanField(items, "observed_cpu_percent"),
        observed_queue_depth: meanField(items, "observed_queue_depth"),
        observed_queued_traffic_mb: meanField(items, "observed_queued_traffic_mb"),
        observed_cache_used_mb: meanField(items, "observed_cache_used_mb"),
        observed_energy_percent: meanField(items, "observed_energy_percent"),
        observation_count: items.length,
        conflict_ratio: fusion.conflict_severity,
        ...fusion,
      };
    }
    return {
      ...latest,
      observed_link_status: majority(items.map((item) => item.observed_link_status), latest.observed_link_status),
      observed_link_active: majority(items.map((item) => item.observed_link_active), latest.observed_link_active),
      observed_link_utilization_percent: meanField(items, "observed_link_utilization_percent"),
      observed_link_latency_ms: meanField(items, "observed_link_latency_ms"),
      observed_link_queue_latency_ms: meanField(items, "observed_link_queue_latency_ms"),
      observed_link_capacity_mbps: meanField(items, "observed_link_capacity_mbps"),
      observed_link_congestion_percent: meanField(items, "observed_link_congestion_percent"),
      observed_link_queued_mb: meanField(items, "observed_link_queued_mb"),
      observed_link_dropped_mb: meanField(items, "observed_link_dropped_mb"),
      observed_link_packet_error_rate: meanField(items, "observed_link_packet_error_rate"),
      observation_count: items.length,
      conflict_ratio: fusion.conflict_severity,
      ...fusion,
    };
  });
}

function decayConfidence(ageSlices, halfLifeSlices) {
  if (!Number.isFinite(ageSlices) || ageSlices < 0) return 0;
  return round(0.5 ** (ageSlices / Math.max(halfLifeSlices, 1)));
}

function latestBefore(records, sliceIndex, minConfidence, halfLifeSlices) {
  let best = null;
  records.forEach((record) => {
    const recordSlice = numberValue(record.slice_index, NaN);
    if (!Number.isFinite(recordSlice) || recordSlice >= sliceIndex) return;
    if (!best || recordSlice > numberValue(best.slice_index)) best = record;
  });
  if (!best) return null;
  const ageSlices = sliceIndex - numberValue(best.slice_index);
  const decayFactor = decayConfidence(ageSlices, halfLifeSlices);
  const sourceConfidence = numberValue(best.fusion_confidence, 1);
  const confidence = decayFactor * sourceConfidence;
  if (confidence < minConfidence) return null;
  return {
    record: best,
    confidence: round(confidence),
    age_slices: ageSlices,
    decay_factor: round(decayFactor),
    confidence_before_decay: round(sourceConfidence),
  };
}

function confidenceState(confidence, source) {
  if (source === "unknown") return "unknown";
  if (confidence >= 0.75) return "high";
  if (confidence >= 0.5) return "medium";
  if (confidence > 0) return "low";
  return "none";
}

function parseNodeId(nodeId) {
  const match = /^P(\d+)-S(\d+)$/i.exec(String(nodeId || ""));
  if (!match) return { plane: -1, slot: -1 };
  return { plane: Number(match[1]), slot: Number(match[2]) };
}

function nodePriorGroup(node) {
  const parsed = parseNodeId(node.node_id);
  if (parsed.plane < 0 || parsed.slot < 0) return "node|unknown";
  return `node|plane-band-${Math.floor((parsed.plane - 1) / 2)}|slot-band-${Math.floor((parsed.slot - 1) / 4)}`;
}

function linkPriorGroup(linkCatalogRow) {
  const source = parseNodeId(linkCatalogRow?.source);
  const target = parseNodeId(linkCatalogRow?.target);
  const planeRelation = source.plane >= 0 && target.plane >= 0 && source.plane === target.plane ? "same-plane" : "cross-plane";
  const slotGap = source.slot >= 0 && target.slot >= 0 ? Math.min(Math.abs(source.slot - target.slot), 3) : "unknown";
  return `link|${linkCatalogRow?.kind || "unknown"}|${planeRelation}|slot-gap-${slotGap}`;
}

function meanEstimate(rows, field) {
  const values = rows.map((row) => numberValue(row[field], NaN)).filter(Number.isFinite);
  return values.length > 0 ? round(mean(values)) : "";
}

function confidenceFromPriorRows(rows, options) {
  if (rows.length === 0) return 0;
  const meanConfidence = mean(rows.map((row) => numberValue(row.confidence, 0)).filter(Number.isFinite));
  const sampleFactor = Math.min(1, Math.sqrt(rows.length) / 3);
  return round(clamp(meanConfidence * sampleFactor * 0.5, options.minPriorConfidence, options.maxPriorConfidence));
}

function selectPriorRows({ rows, sliceIndex, group, groupFn }) {
  const usable = rows.filter((row) => row.observation_source === "observed" || row.observation_source === "stale-carryover");
  const sameSlice = usable.filter((row) => String(row.slice_index) === String(sliceIndex));
  const sameSliceGroup = sameSlice.filter((row) => groupFn(row) === group);
  if (sameSliceGroup.length > 0) return { rows: sameSliceGroup, scope: "same-slice-spatial-group" };
  if (sameSlice.length > 0) return { rows: sameSlice, scope: "same-slice-all-groups" };
  const globalGroup = usable.filter((row) => groupFn(row) === group);
  if (globalGroup.length > 0) return { rows: globalGroup, scope: "historical-spatial-group" };
  return { rows: usable, scope: usable.length > 0 ? "historical-all-groups" : "none" };
}

async function readCsv(path) {
  return parseCsv(await readFile(path, "utf8"));
}

function requireFile(path, label) {
  if (!existsSync(path)) throw new Error(`${label} not found: ${path}`);
}

function deliverReports(reports, perSliceBudgetBytes, carryOver) {
  const bySlice = groupBy(reports, (report) => report.slice_index);
  const sliceIndexes = [...bySlice.keys()].sort((a, b) => Number(a) - Number(b));
  const delivered = [];
  const queued = [];
  let queue = [];

  sliceIndexes.forEach((sliceIndex) => {
    const generated = bySlice.get(sliceIndex) ?? [];
    queue = carryOver ? [...queue, ...generated] : [...generated];
    let budget = perSliceBudgetBytes;
    const nextQueue = [];

    queue.forEach((report) => {
      const size = numberValue(report.report_size_bytes);
      if (size <= budget) {
        budget -= size;
        delivered.push({
          ...report,
          ground_status: "downlinked",
          downlinked_slice: sliceIndex,
          delivery_delay_slices: Number(sliceIndex) - numberValue(report.slice_index),
        });
      } else {
        nextQueue.push({
          ...report,
          ground_status: carryOver ? "queued" : "dropped",
          downlinked_slice: "",
          delivery_delay_slices: "",
          drop_reason: carryOver ? "" : "slice-budget-exhausted",
        });
      }
    });

    if (!carryOver) {
      queued.push(...nextQueue);
      queue = [];
    } else {
      queue = nextQueue;
    }
  });

  if (carryOver && queue.length > 0) {
    queued.push(...queue.map((report) => ({
      ...report,
      ground_status: "queued",
      downlinked_slice: "",
      delivery_delay_slices: "",
      drop_reason: "",
    })));
  }

  return { delivered, queued };
}

function splitTransmittableReports(reports) {
  const transmittable = [];
  const preDropped = [];
  reports.forEach((report) => {
    const status = String(report.status || "generated").toLowerCase();
    const reportingStatus = String(report.reporting_status || "planned").toLowerCase();
    if (status === "dropped" || reportingStatus === "blocked") {
      preDropped.push({
        ...report,
        ground_status: "dropped",
        downlinked_slice: "",
        delivery_delay_slices: "",
        drop_reason: report.drop_reason || "not-transmittable",
      });
    } else {
      transmittable.push(report);
    }
  });
  return { transmittable, preDropped };
}

function reconstructNodes(deliveredHopRecords, truthNodes, options) {
  const observed = aggregateHopRecords(deliveredHopRecords, (record) => `${record.slice_index}|${record.node_id}`, "node");
  const observedMap = indexBy(observed, (record) => `${record.slice_index}|${record.node_id}`);
  const historyByNode = groupBy(observed, (record) => record.node_id);
  return truthNodes.map((truth) => {
    const record = observedMap.get(`${truth.slice_index}|${truth.node_id}`);
    if (!record) {
      const stale = options.staleCarryOver
        ? latestBefore(
            historyByNode.get(truth.node_id) ?? [],
            numberValue(truth.slice_index),
            options.minStaleConfidence,
            options.confidenceHalfLifeSlices,
          )
        : null;
      if (stale) {
        return {
          slice_index: truth.slice_index,
          node_id: truth.node_id,
          observed: false,
          observation_source: "stale-carryover",
          last_observed_slice: stale.record.slice_index,
          mode_estimate: stale.record.observed_node_mode,
          cpu_percent_estimate: stale.record.observed_cpu_percent,
          queue_depth_estimate: stale.record.observed_queue_depth,
          queued_traffic_mb_estimate: stale.record.observed_queued_traffic_mb,
          cache_used_mb_estimate: stale.record.observed_cache_used_mb,
          energy_percent_estimate: stale.record.observed_energy_percent,
          confidence: stale.confidence,
          confidence_before_decay: stale.confidence_before_decay,
          confidence_decay_factor: stale.decay_factor,
          confidence_state: confidenceState(stale.confidence, "stale-carryover"),
          state_age_slices: stale.age_slices,
          observation_count: stale.record.observation_count ?? 1,
          conflict_ratio: stale.record.conflict_ratio ?? 0,
          conflict_severity: stale.record.conflict_severity ?? stale.record.conflict_ratio ?? 0,
          categorical_conflict_ratio: stale.record.categorical_conflict_ratio ?? "",
          numeric_conflict_ratio: stale.record.numeric_conflict_ratio ?? "",
          fusion_confidence_penalty: stale.record.fusion_confidence_penalty ?? "",
          fusion_sample_support: stale.record.fusion_sample_support ?? "",
          fusion_method: stale.record.fusion_method ?? "stale-carryover",
        };
      }
      return {
        slice_index: truth.slice_index,
        node_id: truth.node_id,
        observed: false,
        observation_source: "unknown",
        last_observed_slice: "",
        mode_estimate: "unknown",
        cpu_percent_estimate: "",
        queue_depth_estimate: "",
        queued_traffic_mb_estimate: "",
        cache_used_mb_estimate: "",
        energy_percent_estimate: "",
        confidence: 0,
        confidence_before_decay: 0,
        confidence_decay_factor: 0,
        confidence_state: "unknown",
        state_age_slices: "",
        observation_count: 0,
        conflict_ratio: 0,
        conflict_severity: 0,
        categorical_conflict_ratio: "",
        numeric_conflict_ratio: "",
        fusion_confidence_penalty: "",
        fusion_sample_support: "",
        fusion_method: "none",
      };
    }
    const confidence = numberValue(record.fusion_confidence, 1);
    return {
      slice_index: record.slice_index,
      node_id: record.node_id,
      observed: true,
      observation_source: "observed",
      last_observed_slice: record.slice_index,
      mode_estimate: record.observed_node_mode,
      cpu_percent_estimate: record.observed_cpu_percent,
      queue_depth_estimate: record.observed_queue_depth,
      queued_traffic_mb_estimate: record.observed_queued_traffic_mb,
      cache_used_mb_estimate: record.observed_cache_used_mb,
      energy_percent_estimate: record.observed_energy_percent,
      confidence,
      confidence_before_decay: confidence,
      confidence_decay_factor: 1,
      confidence_state: confidenceState(confidence, "observed"),
      state_age_slices: 0,
      observation_count: record.observation_count ?? 1,
      conflict_ratio: record.conflict_ratio ?? 0,
      conflict_severity: record.conflict_severity ?? record.conflict_ratio ?? 0,
      categorical_conflict_ratio: record.categorical_conflict_ratio ?? "",
      numeric_conflict_ratio: record.numeric_conflict_ratio ?? "",
      fusion_confidence_penalty: record.fusion_confidence_penalty ?? "",
      fusion_sample_support: record.fusion_sample_support ?? "",
      fusion_method: record.fusion_method ?? "majority-mean-conflict-aware-fusion",
    };
  });
}

function reconstructLinks(deliveredHopRecords, truthLinks, options) {
  const observedRecords = deliveredHopRecords.filter((record) => record.observed_link_id);
  const observed = aggregateHopRecords(observedRecords, (record) => `${record.slice_index}|${record.observed_link_id}`, "link");
  const observedMap = indexBy(observed, (record) => `${record.slice_index}|${record.observed_link_id}`);
  const historyByLink = groupBy(observed, (record) => record.observed_link_id);
  return truthLinks.map((truth) => {
    const record = observedMap.get(`${truth.slice_index}|${truth.link_id}`);
    if (!record) {
      const stale = options.staleCarryOver
        ? latestBefore(
            historyByLink.get(truth.link_id) ?? [],
            numberValue(truth.slice_index),
            options.minStaleConfidence,
            options.confidenceHalfLifeSlices,
          )
        : null;
      if (stale) {
        return {
          slice_index: truth.slice_index,
          link_id: truth.link_id,
          observed: false,
          observation_source: "stale-carryover",
          last_observed_slice: stale.record.slice_index,
          status_estimate: stale.record.observed_link_status,
          active_estimate: stale.record.observed_link_active,
          utilization_percent_estimate: stale.record.observed_link_utilization_percent,
          latency_ms_estimate: stale.record.observed_link_latency_ms,
          queue_latency_ms_estimate: stale.record.observed_link_queue_latency_ms,
          capacity_mbps_estimate: stale.record.observed_link_capacity_mbps,
          congestion_percent_estimate: stale.record.observed_link_congestion_percent,
          queued_traffic_mb_estimate: stale.record.observed_link_queued_mb,
          dropped_traffic_mb_estimate: stale.record.observed_link_dropped_mb,
          packet_error_rate_estimate: stale.record.observed_link_packet_error_rate,
          confidence: stale.confidence,
          confidence_before_decay: stale.confidence_before_decay,
          confidence_decay_factor: stale.decay_factor,
          confidence_state: confidenceState(stale.confidence, "stale-carryover"),
          state_age_slices: stale.age_slices,
          observation_count: stale.record.observation_count ?? 1,
          conflict_ratio: stale.record.conflict_ratio ?? 0,
          conflict_severity: stale.record.conflict_severity ?? stale.record.conflict_ratio ?? 0,
          categorical_conflict_ratio: stale.record.categorical_conflict_ratio ?? "",
          numeric_conflict_ratio: stale.record.numeric_conflict_ratio ?? "",
          fusion_confidence_penalty: stale.record.fusion_confidence_penalty ?? "",
          fusion_sample_support: stale.record.fusion_sample_support ?? "",
          fusion_method: stale.record.fusion_method ?? "stale-carryover",
        };
      }
      return {
        slice_index: truth.slice_index,
        link_id: truth.link_id,
        observed: false,
        observation_source: "unknown",
        last_observed_slice: "",
        status_estimate: "unknown",
        active_estimate: "unknown",
        utilization_percent_estimate: "",
        latency_ms_estimate: "",
        queue_latency_ms_estimate: "",
        capacity_mbps_estimate: "",
        congestion_percent_estimate: "",
        queued_traffic_mb_estimate: "",
        dropped_traffic_mb_estimate: "",
        packet_error_rate_estimate: "",
        confidence: 0,
        confidence_before_decay: 0,
        confidence_decay_factor: 0,
        confidence_state: "unknown",
        state_age_slices: "",
        observation_count: 0,
        conflict_ratio: 0,
        conflict_severity: 0,
        categorical_conflict_ratio: "",
        numeric_conflict_ratio: "",
        fusion_confidence_penalty: "",
        fusion_sample_support: "",
        fusion_method: "none",
      };
    }
    const confidence = numberValue(record.fusion_confidence, 1);
    return {
      slice_index: record.slice_index,
      link_id: record.observed_link_id,
      observed: true,
      observation_source: "observed",
      last_observed_slice: record.slice_index,
      status_estimate: record.observed_link_status,
      active_estimate: record.observed_link_active,
      utilization_percent_estimate: record.observed_link_utilization_percent,
      latency_ms_estimate: record.observed_link_latency_ms,
      queue_latency_ms_estimate: record.observed_link_queue_latency_ms,
      capacity_mbps_estimate: record.observed_link_capacity_mbps,
      congestion_percent_estimate: record.observed_link_congestion_percent,
      queued_traffic_mb_estimate: record.observed_link_queued_mb,
      dropped_traffic_mb_estimate: record.observed_link_dropped_mb,
      packet_error_rate_estimate: record.observed_link_packet_error_rate,
      confidence,
      confidence_before_decay: confidence,
      confidence_decay_factor: 1,
      confidence_state: confidenceState(confidence, "observed"),
      state_age_slices: 0,
      observation_count: record.observation_count ?? 1,
      conflict_ratio: record.conflict_ratio ?? 0,
      conflict_severity: record.conflict_severity ?? record.conflict_ratio ?? 0,
      categorical_conflict_ratio: record.categorical_conflict_ratio ?? "",
      numeric_conflict_ratio: record.numeric_conflict_ratio ?? "",
      fusion_confidence_penalty: record.fusion_confidence_penalty ?? "",
      fusion_sample_support: record.fusion_sample_support ?? "",
      fusion_method: record.fusion_method ?? "majority-mean-conflict-aware-fusion",
    };
  });
}

function applyOamPriorEstimates({ reconstructedNodes, reconstructedLinks, truthLinks, options }) {
  if (!options.priorEstimatesEnabled) {
    return { nodes: reconstructedNodes, links: reconstructedLinks, nodePriorEstimates: 0, linkPriorEstimates: 0 };
  }

  const linkCatalog = indexBy(truthLinks, (link) => link.link_id);
  const nodeGroupFn = (node) => nodePriorGroup(node);
  const linkGroupFn = (link) => linkPriorGroup(linkCatalog.get(link.link_id) ?? {});
  let nodePriorEstimates = 0;
  let linkPriorEstimates = 0;

  const nodes = reconstructedNodes.map((node) => {
    if (node.observation_source !== "unknown") return node;
    const group = nodePriorGroup(node);
    const prior = selectPriorRows({
      rows: reconstructedNodes,
      sliceIndex: node.slice_index,
      group,
      groupFn: nodeGroupFn,
    });
    if (prior.rows.length === 0) return node;
    const confidence = confidenceFromPriorRows(prior.rows, options);
    if (confidence < options.minPriorConfidence) return node;
    nodePriorEstimates += 1;
    return {
      ...node,
      observation_source: "oam-prior-estimate",
      last_observed_slice: "",
      mode_estimate: majority(prior.rows.map((row) => row.mode_estimate), "unknown"),
      cpu_percent_estimate: meanEstimate(prior.rows, "cpu_percent_estimate"),
      queue_depth_estimate: meanEstimate(prior.rows, "queue_depth_estimate"),
      queued_traffic_mb_estimate: meanEstimate(prior.rows, "queued_traffic_mb_estimate"),
      cache_used_mb_estimate: meanEstimate(prior.rows, "cache_used_mb_estimate"),
      energy_percent_estimate: meanEstimate(prior.rows, "energy_percent_estimate"),
      confidence,
      confidence_before_decay: confidence,
      confidence_decay_factor: "",
      confidence_state: confidenceState(confidence, "oam-prior-estimate"),
      state_age_slices: "",
      observation_count: 0,
      conflict_ratio: round(mean(prior.rows.map((row) => numberValue(row.conflict_ratio)).filter(Number.isFinite))),
      conflict_severity: round(mean(prior.rows.map((row) => numberValue(row.conflict_severity ?? row.conflict_ratio)).filter(Number.isFinite))),
      categorical_conflict_ratio: round(mean(prior.rows.map((row) => numberValue(row.categorical_conflict_ratio, NaN)).filter(Number.isFinite))),
      numeric_conflict_ratio: round(mean(prior.rows.map((row) => numberValue(row.numeric_conflict_ratio, NaN)).filter(Number.isFinite))),
      fusion_confidence_penalty: "",
      fusion_sample_support: "",
      fusion_method: "oam-prior-spatial-statistical-fusion",
      prior_scope: prior.scope,
      prior_group: group,
      prior_sample_count: prior.rows.length,
    };
  });

  const links = reconstructedLinks.map((link) => {
    if (link.observation_source !== "unknown") return link;
    const group = linkGroupFn(link);
    const prior = selectPriorRows({
      rows: reconstructedLinks,
      sliceIndex: link.slice_index,
      group,
      groupFn: linkGroupFn,
    });
    if (prior.rows.length === 0) return link;
    const confidence = confidenceFromPriorRows(prior.rows, options);
    if (confidence < options.minPriorConfidence) return link;
    linkPriorEstimates += 1;
    return {
      ...link,
      observation_source: "oam-prior-estimate",
      last_observed_slice: "",
      status_estimate: majority(prior.rows.map((row) => row.status_estimate), "unknown"),
      active_estimate: majority(prior.rows.map((row) => row.active_estimate), "unknown"),
      utilization_percent_estimate: meanEstimate(prior.rows, "utilization_percent_estimate"),
      latency_ms_estimate: meanEstimate(prior.rows, "latency_ms_estimate"),
      queue_latency_ms_estimate: meanEstimate(prior.rows, "queue_latency_ms_estimate"),
      capacity_mbps_estimate: meanEstimate(prior.rows, "capacity_mbps_estimate"),
      congestion_percent_estimate: meanEstimate(prior.rows, "congestion_percent_estimate"),
      queued_traffic_mb_estimate: meanEstimate(prior.rows, "queued_traffic_mb_estimate"),
      dropped_traffic_mb_estimate: meanEstimate(prior.rows, "dropped_traffic_mb_estimate"),
      packet_error_rate_estimate: meanEstimate(prior.rows, "packet_error_rate_estimate"),
      confidence,
      confidence_before_decay: confidence,
      confidence_decay_factor: "",
      confidence_state: confidenceState(confidence, "oam-prior-estimate"),
      state_age_slices: "",
      observation_count: 0,
      conflict_ratio: round(mean(prior.rows.map((row) => numberValue(row.conflict_ratio)).filter(Number.isFinite))),
      conflict_severity: round(mean(prior.rows.map((row) => numberValue(row.conflict_severity ?? row.conflict_ratio)).filter(Number.isFinite))),
      categorical_conflict_ratio: round(mean(prior.rows.map((row) => numberValue(row.categorical_conflict_ratio, NaN)).filter(Number.isFinite))),
      numeric_conflict_ratio: round(mean(prior.rows.map((row) => numberValue(row.numeric_conflict_ratio, NaN)).filter(Number.isFinite))),
      fusion_confidence_penalty: "",
      fusion_sample_support: "",
      fusion_method: "oam-prior-spatial-statistical-fusion",
      prior_scope: prior.scope,
      prior_group: group,
      prior_sample_count: prior.rows.length,
    };
  });

  return { nodes, links, nodePriorEstimates, linkPriorEstimates };
}

function evaluateNodes(reconstructedNodes, truthNodes) {
  const truthByKey = indexBy(truthNodes, (node) => `${node.slice_index}|${node.node_id}`);
  const observed = reconstructedNodes.filter((node) => String(node.observed) === "true");
  const stale = reconstructedNodes.filter((node) => node.observation_source === "stale-carryover");
  const prior = reconstructedNodes.filter((node) => node.observation_source === "oam-prior-estimate");
  const unknown = reconstructedNodes.filter((node) => node.observation_source === "unknown");
  const cpuErrors = [];
  const queueErrors = [];
  const energyErrors = [];
  const staleCpuErrors = [];
  const staleQueueErrors = [];
  const staleEnergyErrors = [];
  const priorCpuErrors = [];
  const priorQueueErrors = [];
  const priorEnergyErrors = [];
  let modeMatches = 0;
  let staleModeMatches = 0;
  let priorModeMatches = 0;

  observed.forEach((node) => {
    const truth = truthByKey.get(`${node.slice_index}|${node.node_id}`);
    if (!truth) return;
    cpuErrors.push(Math.abs(numberValue(node.cpu_percent_estimate) - numberValue(truth.cpu_percent)));
    queueErrors.push(Math.abs(numberValue(node.queue_depth_estimate) - numberValue(truth.queue_depth)));
    energyErrors.push(Math.abs(numberValue(node.energy_percent_estimate) - numberValue(truth.energy_percent)));
    if (node.mode_estimate === truth.mode) modeMatches += 1;
  });
  stale.forEach((node) => {
    const truth = truthByKey.get(`${node.slice_index}|${node.node_id}`);
    if (!truth) return;
    staleCpuErrors.push(Math.abs(numberValue(node.cpu_percent_estimate) - numberValue(truth.cpu_percent)));
    staleQueueErrors.push(Math.abs(numberValue(node.queue_depth_estimate) - numberValue(truth.queue_depth)));
    staleEnergyErrors.push(Math.abs(numberValue(node.energy_percent_estimate) - numberValue(truth.energy_percent)));
    if (node.mode_estimate === truth.mode) staleModeMatches += 1;
  });
  prior.forEach((node) => {
    const truth = truthByKey.get(`${node.slice_index}|${node.node_id}`);
    if (!truth) return;
    priorCpuErrors.push(Math.abs(numberValue(node.cpu_percent_estimate) - numberValue(truth.cpu_percent)));
    priorQueueErrors.push(Math.abs(numberValue(node.queue_depth_estimate) - numberValue(truth.queue_depth)));
    priorEnergyErrors.push(Math.abs(numberValue(node.energy_percent_estimate) - numberValue(truth.energy_percent)));
    if (node.mode_estimate === truth.mode) priorModeMatches += 1;
  });

  return {
    truth_node_samples: truthNodes.length,
    observed_node_samples: observed.length,
    stale_node_estimates: stale.length,
    oam_prior_node_estimates: prior.length,
    node_sample_coverage: round(observed.length / Math.max(truthNodes.length, 1)),
    unobserved_node_samples: truthNodes.length - observed.length,
    unknown_node_samples: unknown.length,
    cpu_mae: round(mean(cpuErrors)),
    queue_depth_mae: round(mean(queueErrors)),
    energy_percent_mae: round(mean(energyErrors)),
    mode_accuracy: round(modeMatches / Math.max(observed.length, 1)),
    stale_cpu_mae: round(mean(staleCpuErrors)),
    stale_queue_depth_mae: round(mean(staleQueueErrors)),
    stale_energy_percent_mae: round(mean(staleEnergyErrors)),
    stale_mode_accuracy: round(staleModeMatches / Math.max(stale.length, 1)),
    prior_cpu_mae: round(mean(priorCpuErrors)),
    prior_queue_depth_mae: round(mean(priorQueueErrors)),
    prior_energy_percent_mae: round(mean(priorEnergyErrors)),
    prior_mode_accuracy: round(priorModeMatches / Math.max(prior.length, 1)),
    mean_confidence: round(mean(reconstructedNodes.map((node) => numberValue(node.confidence)).filter(Number.isFinite))),
  };
}

function evaluateLinks(reconstructedLinks, truthLinks) {
  const truthActiveLinks = truthLinks.filter((link) => boolValue(link.is_active));
  const truthAllByKey = indexBy(truthLinks, (link) => `${link.slice_index}|${link.link_id}`);
  const truthByKey = indexBy(truthActiveLinks, (link) => `${link.slice_index}|${link.link_id}`);
  const observed = reconstructedLinks.filter((link) => String(link.observed) === "true");
  const stale = reconstructedLinks.filter((link) => link.observation_source === "stale-carryover");
  const prior = reconstructedLinks.filter((link) => link.observation_source === "oam-prior-estimate");
  const unknown = reconstructedLinks.filter((link) => link.observation_source === "unknown");
  const observedActive = observed.filter((link) => {
    const truth = truthByKey.get(`${link.slice_index}|${link.link_id}`);
    return Boolean(truth);
  });
  const utilizationErrors = [];
  const latencyErrors = [];
  const queueLatencyErrors = [];
  const capacityErrors = [];
  const queuedTrafficErrors = [];
  const droppedTrafficErrors = [];
  const packetErrorRateErrors = [];
  const priorUtilizationErrors = [];
  const priorLatencyErrors = [];
  const priorQueueLatencyErrors = [];
  const priorCapacityErrors = [];
  const priorQueuedTrafficErrors = [];
  const priorDroppedTrafficErrors = [];
  const priorPacketErrorRateErrors = [];
  let statusMatches = 0;
  let priorStatusMatches = 0;
  let trueCongested = 0;
  let observedCongested = 0;
  let truePositiveCongested = 0;

  observed.forEach((link) => {
    const truth = truthAllByKey.get(`${link.slice_index}|${link.link_id}`);
    if (!truth) return;
    utilizationErrors.push(Math.abs(numberValue(link.utilization_percent_estimate) - numberValue(truth.utilization_percent)));
    latencyErrors.push(Math.abs(numberValue(link.latency_ms_estimate) - numberValue(truth.latency_ms)));
    queueLatencyErrors.push(Math.abs(numberValue(link.queue_latency_ms_estimate) - numberValue(truth.queue_latency_ms)));
    capacityErrors.push(Math.abs(numberValue(link.capacity_mbps_estimate) - numberValue(truth.effective_capacity_mbps || truth.capacity_mbps)));
    queuedTrafficErrors.push(Math.abs(numberValue(link.queued_traffic_mb_estimate) - numberValue(truth.queued_traffic_mb)));
    droppedTrafficErrors.push(Math.abs(numberValue(link.dropped_traffic_mb_estimate) - numberValue(truth.dropped_traffic_mb)));
    packetErrorRateErrors.push(Math.abs(numberValue(link.packet_error_rate_estimate) - numberValue(truth.packet_error_rate)));
    if (link.status_estimate === truth.status) statusMatches += 1;
    const truthCongested = numberValue(truth.congestion_percent) > 0;
    const estimateCongested = numberValue(link.congestion_percent_estimate) > 0;
    if (truthCongested) trueCongested += 1;
    if (estimateCongested) observedCongested += 1;
    if (truthCongested && estimateCongested) truePositiveCongested += 1;
  });
  prior.forEach((link) => {
    const truth = truthAllByKey.get(`${link.slice_index}|${link.link_id}`);
    if (!truth) return;
    priorUtilizationErrors.push(Math.abs(numberValue(link.utilization_percent_estimate) - numberValue(truth.utilization_percent)));
    priorLatencyErrors.push(Math.abs(numberValue(link.latency_ms_estimate) - numberValue(truth.latency_ms)));
    priorQueueLatencyErrors.push(Math.abs(numberValue(link.queue_latency_ms_estimate) - numberValue(truth.queue_latency_ms)));
    priorCapacityErrors.push(Math.abs(numberValue(link.capacity_mbps_estimate) - numberValue(truth.effective_capacity_mbps || truth.capacity_mbps)));
    priorQueuedTrafficErrors.push(Math.abs(numberValue(link.queued_traffic_mb_estimate) - numberValue(truth.queued_traffic_mb)));
    priorDroppedTrafficErrors.push(Math.abs(numberValue(link.dropped_traffic_mb_estimate) - numberValue(truth.dropped_traffic_mb)));
    priorPacketErrorRateErrors.push(Math.abs(numberValue(link.packet_error_rate_estimate) - numberValue(truth.packet_error_rate)));
    if (link.status_estimate === truth.status) priorStatusMatches += 1;
  });

  const totalTruthCongested = truthActiveLinks.filter((link) => numberValue(link.congestion_percent) > 0).length;

  return {
    truth_link_samples: truthLinks.length,
    observed_link_samples: observed.length,
    link_sample_coverage: round(observed.length / Math.max(truthLinks.length, 1)),
    unobserved_link_samples: truthLinks.length - observed.length,
    unknown_link_samples: unknown.length,
    truth_active_link_samples: truthActiveLinks.length,
    observed_active_link_samples: observedActive.length,
    stale_link_estimates: stale.length,
    oam_prior_link_estimates: prior.length,
    active_link_sample_coverage: round(observedActive.length / Math.max(truthActiveLinks.length, 1)),
    unknown_active_link_samples: truthActiveLinks.length - observedActive.length,
    utilization_mae: round(mean(utilizationErrors)),
    latency_mae_ms: round(mean(latencyErrors)),
    queue_latency_mae_ms: round(mean(queueLatencyErrors)),
    capacity_mae_mbps: round(mean(capacityErrors)),
    queued_traffic_mae_mb: round(mean(queuedTrafficErrors)),
    dropped_traffic_mae_mb: round(mean(droppedTrafficErrors)),
    packet_error_rate_mae: round(mean(packetErrorRateErrors), 6),
    status_accuracy: round(statusMatches / Math.max(observed.length, 1)),
    prior_utilization_mae: round(mean(priorUtilizationErrors)),
    prior_latency_mae_ms: round(mean(priorLatencyErrors)),
    prior_queue_latency_mae_ms: round(mean(priorQueueLatencyErrors)),
    prior_capacity_mae_mbps: round(mean(priorCapacityErrors)),
    prior_queued_traffic_mae_mb: round(mean(priorQueuedTrafficErrors)),
    prior_dropped_traffic_mae_mb: round(mean(priorDroppedTrafficErrors)),
    prior_packet_error_rate_mae: round(mean(priorPacketErrorRateErrors), 6),
    prior_status_accuracy: round(priorStatusMatches / Math.max(prior.length, 1)),
    observed_congested_links: observedCongested,
    truth_congested_links_seen_by_int: trueCongested,
    truth_congested_links_total: totalTruthCongested,
    congestion_precision: round(truePositiveCongested / Math.max(observedCongested, 1)),
    congestion_recall_over_observed_scope: round(truePositiveCongested / Math.max(trueCongested, 1)),
    congestion_recall_over_global_truth: round(truePositiveCongested / Math.max(totalTruthCongested, 1)),
    mean_confidence: round(mean(reconstructedLinks.map((link) => numberValue(link.confidence)).filter(Number.isFinite))),
  };
}

function buildPriorityRetests({ reconstructedNodes, reconstructedLinks, maxPerSlice }) {
  const nodeItems = reconstructedNodes.map((node) => {
    const confidence = numberValue(node.confidence);
    const conflict = Math.max(numberValue(node.conflict_ratio), numberValue(node.conflict_severity));
    const unknown = node.observation_source === "unknown";
    const stale = node.observation_source === "stale-carryover";
    const staleAge = numberValue(node.state_age_slices);
    const energy = numberValue(node.energy_percent_estimate, 100);
    const queue = numberValue(node.queue_depth_estimate);
    const score =
      (unknown ? 1 : 0) +
      (stale ? 0.55 : 0) +
      (1 - confidence) * 0.8 +
      clamp(staleAge / 6, 0, 0.35) +
      conflict * 0.65 +
      (energy < 25 ? 0.25 : 0) +
      (queue > 0 ? 0.15 : 0);
    return {
      slice_index: node.slice_index,
      target_type: "node",
      target_id: node.node_id,
      priority_score: round(score),
      reason: unknown
        ? "unknown-node-state"
        : stale
          ? "stale-node-state"
          : confidence < 0.5
            ? "low-confidence-node-state"
            : conflict > 0
              ? "conflicting-or-dispersed-node-reports"
              : energy < 25
                ? "low-energy-node"
                : "queue-risk-node",
      confidence,
      confidence_state: node.confidence_state,
      state_age_slices: node.state_age_slices,
      confidence_decay_factor: node.confidence_decay_factor,
      conflict_severity: node.conflict_severity,
      observation_source: node.observation_source,
      suggested_action: "include-node-in-next-probe-or-route-through-neighbor",
    };
  });

  const linkItems = reconstructedLinks.map((link) => {
    const confidence = numberValue(link.confidence);
    const conflict = Math.max(numberValue(link.conflict_ratio), numberValue(link.conflict_severity));
    const unknown = link.observation_source === "unknown";
    const stale = link.observation_source === "stale-carryover";
    const staleAge = numberValue(link.state_age_slices);
    const congestion = numberValue(link.congestion_percent_estimate);
    const utilization = numberValue(link.utilization_percent_estimate);
    const warning = link.status_estimate === "warning";
    const score =
      (unknown ? 1 : 0) +
      (stale ? 0.55 : 0) +
      (1 - confidence) * 0.8 +
      clamp(staleAge / 6, 0, 0.35) +
      conflict * 0.65 +
      (warning ? 0.35 : 0) +
      (congestion > 0 ? 0.35 : 0) +
      (utilization >= 75 ? 0.2 : 0);
    return {
      slice_index: link.slice_index,
      target_type: "link",
      target_id: link.link_id,
      priority_score: round(score),
      reason: unknown
        ? "unknown-link-state"
        : stale
          ? "stale-link-state"
          : confidence < 0.5
            ? "low-confidence-link-state"
            : conflict > 0
              ? "conflicting-or-dispersed-link-reports"
              : congestion > 0 || warning
                ? "possible-congestion-or-warning"
                : "high-utilization-link",
      confidence,
      confidence_state: link.confidence_state,
      state_age_slices: link.state_age_slices,
      confidence_decay_factor: link.confidence_decay_factor,
      conflict_severity: link.conflict_severity,
      observation_source: link.observation_source,
      suggested_action: "include-link-endpoints-in-next-probe",
    };
  });

  return [...nodeItems, ...linkItems]
    .filter((item) => item.priority_score > 0.2)
    .sort((left, right) =>
      numberValue(left.slice_index) - numberValue(right.slice_index) ||
      numberValue(right.priority_score) - numberValue(left.priority_score) ||
      left.target_id.localeCompare(right.target_id),
    )
    .filter((item, index, rows) => {
      const sameSliceBefore = rows.slice(0, index).filter((old) => String(old.slice_index) === String(item.slice_index)).length;
      return sameSliceBefore < maxPerSlice;
    });
}

function buildControlActions({
  reconstructedNodes,
  reconstructedLinks,
  delivered,
  undelivered,
  priorityRetests,
  baseTelemetryByteBudgetPerSlice,
  baseDownlinkBudgetBytes,
}) {
  const nodesBySlice = groupBy(reconstructedNodes, (node) => String(node.slice_index));
  const linksBySlice = groupBy(reconstructedLinks, (link) => String(link.slice_index));
  const deliveredBySlice = groupBy(delivered, (report) => String(report.slice_index));
  const undeliveredBySlice = groupBy(undelivered, (report) => String(report.slice_index));
  const retestsBySlice = groupBy(priorityRetests, (item) => String(item.slice_index));
  const sliceIndexes = [...new Set([...nodesBySlice.keys(), ...linksBySlice.keys()])].sort((left, right) => Number(left) - Number(right));

  return sliceIndexes.map((sliceIndex) => {
    const nodeRows = nodesBySlice.get(sliceIndex) ?? [];
    const linkRows = linksBySlice.get(sliceIndex) ?? [];
    const allRows = [...nodeRows, ...linkRows];
    const retestRows = retestsBySlice.get(sliceIndex) ?? [];
    const total = Math.max(allRows.length, 1);
    const unknown = allRows.filter((row) => row.observation_source === "unknown").length;
    const stale = allRows.filter((row) => row.observation_source === "stale-carryover").length;
    const prior = allRows.filter((row) => row.observation_source === "oam-prior-estimate").length;
    const lowConfidence = allRows.filter((row) => numberValue(row.confidence) < 0.5).length;
    const conflicts = allRows.filter((row) => Math.max(numberValue(row.conflict_ratio), numberValue(row.conflict_severity)) > 0).length;
    const deliveredReports = (deliveredBySlice.get(sliceIndex) ?? []).length;
    const undeliveredReports = (undeliveredBySlice.get(sliceIndex) ?? []).length;
    const meanNodeConfidence = round(mean(nodeRows.map((node) => numberValue(node.confidence)).filter(Number.isFinite)));
    const meanLinkConfidence = round(mean(linkRows.map((link) => numberValue(link.confidence)).filter(Number.isFinite)));
    const staleAges = allRows
      .filter((row) => row.observation_source === "stale-carryover")
      .map((row) => numberValue(row.state_age_slices, NaN))
      .filter(Number.isFinite);
    const meanStaleAgeSlices = round(mean(staleAges));
    const meanConflictSeverity = round(mean(allRows.map((row) => Math.max(numberValue(row.conflict_ratio), numberValue(row.conflict_severity))).filter(Number.isFinite)));
    const confidenceDebtPressure = clamp(mean(allRows.map((row) => 1 - numberValue(row.confidence)).filter(Number.isFinite)), 0, 1);
    const unknownPressure = unknown / total;
    const stalePressure = stale / total;
    const priorPressure = prior / total;
    const lowConfidencePressure = lowConfidence / total;
    const conflictPressure = conflicts / total;
    const staleAgePressure = clamp(meanStaleAgeSlices / 6, 0, 1);
    const fusionConflictPressure = clamp(meanConflictSeverity, 0, 1);
    const downlinkPressure = clamp(undeliveredReports / Math.max(deliveredReports + undeliveredReports, 1), 0, 1);
    const retestPressure = clamp(retestRows.length / 12, 0, 1);
    const coverageDemandPressure = clamp(
      unknownPressure * 0.33 +
        priorPressure * 0.16 +
        lowConfidencePressure * 0.24 +
        conflictPressure * 0.1 +
        confidenceDebtPressure * 0.08 +
        retestPressure * 0.09,
      0,
      1,
    );
    const oamControlPressure = round(clamp(
      unknownPressure * 0.23 +
        stalePressure * 0.11 +
        priorPressure * 0.11 +
        lowConfidencePressure * 0.14 +
        conflictPressure * 0.09 +
        staleAgePressure * 0.08 +
        confidenceDebtPressure * 0.08 +
        fusionConflictPressure * 0.04 +
        downlinkPressure * 0.07 +
        retestPressure * 0.05,
      0,
      1,
    ));
    const topNodes = retestRows.filter((item) => item.target_type === "node").slice(0, 6);
    const topLinks = retestRows.filter((item) => item.target_type === "link").slice(0, 6);
    const recommendedAction = oamControlPressure >= 0.68
      ? "refresh-probe-plan"
      : retestRows.length > 0
        ? "schedule-priority-retest"
        : "maintain-current-plan";
    const probeBias = oamControlPressure >= 0.68
      ? "force-fresh-replan"
      : retestRows.length > 0
        ? "bias-paths-to-oam-targets"
        : "normal-coverage";
    const confidenceBudget = oamControlPressure >= 0.68
      ? "degraded"
      : oamControlPressure >= 0.35
        ? "watch"
        : "healthy";
    const recommendedSamplingRate = round(clamp(
      0.1 + coverageDemandPressure * 0.45 + retestPressure * 0.12 - downlinkPressure * 0.08,
      0.08,
      0.7,
    ));
    const recommendedTargetActiveLinkSamplingRate = round(clamp(
      recommendedSamplingRate + unknownPressure * 0.16 + lowConfidencePressure * 0.08,
      recommendedSamplingRate,
      0.85,
    ));
    const telemetryBudgetScale = clamp(
      0.75 + coverageDemandPressure * 0.8 - downlinkPressure * 0.35,
      0.45,
      1.8,
    );
    const downlinkBudgetScale = clamp(
      1 + downlinkPressure * 0.35 + retestPressure * 0.15 - coverageDemandPressure * 0.08,
      0.75,
      1.6,
    );
    const recommendedTelemetryByteBudgetPerSlice = roundBytes(baseTelemetryByteBudgetPerSlice * telemetryBudgetScale);
    const recommendedDownlinkBudgetBytes = roundBytes(baseDownlinkBudgetBytes * downlinkBudgetScale, 1024);
    const budgetRecommendationAction = downlinkPressure > 0.4
      ? "protect-downlink-budget"
      : coverageDemandPressure > 0.4 || retestRows.length > 0
        ? "increase-critical-probe-budget"
        : "maintain-nominal-budget";
    const budgetRecommendationReason = [
      unknownPressure > 0.1 ? "unknown-state-pressure" : "",
      priorPressure > 0.1 ? "prior-estimate-pressure" : "",
      lowConfidencePressure > 0.1 ? "low-confidence-pressure" : "",
      conflictPressure > 0 ? "report-conflict-pressure" : "",
      retestRows.length > 0 ? "priority-retest-pressure" : "",
      downlinkPressure > 0.2 ? "downlink-pressure" : "",
    ].filter(Boolean).join(" > ") || "healthy-oam-state";

    return {
      slice_index: Number(sliceIndex),
      next_slice_index: Number(sliceIndex) + 1,
      control_epoch: `OAM-T${String(sliceIndex).padStart(2, "0")}`,
      recommended_action: recommendedAction,
      probe_bias: probeBias,
      confidence_budget: confidenceBudget,
      oam_control_pressure: oamControlPressure,
      unknown_pressure: round(unknownPressure),
      stale_pressure: round(stalePressure),
      prior_estimate_pressure: round(priorPressure),
      low_confidence_pressure: round(lowConfidencePressure),
      conflict_pressure: round(conflictPressure),
      stale_age_pressure: round(staleAgePressure),
      confidence_debt_pressure: round(confidenceDebtPressure),
      fusion_conflict_pressure: round(fusionConflictPressure),
      downlink_pressure: round(downlinkPressure),
      retest_pressure: round(retestPressure),
      coverage_demand_pressure: round(coverageDemandPressure),
      recommended_sampling_rate: recommendedSamplingRate,
      recommended_target_active_link_sampling_rate: recommendedTargetActiveLinkSamplingRate,
      recommended_telemetry_byte_budget_per_slice: recommendedTelemetryByteBudgetPerSlice,
      recommended_downlink_budget_bytes: recommendedDownlinkBudgetBytes,
      budget_recommendation_action: budgetRecommendationAction,
      budget_recommendation_reason: budgetRecommendationReason,
      budget_recommendation_source: "ground-oam-confidence-control",
      nodes_total: nodeRows.length,
      links_total: linkRows.length,
      unknown_nodes: nodeRows.filter((row) => row.observation_source === "unknown").length,
      unknown_links: linkRows.filter((row) => row.observation_source === "unknown").length,
      stale_nodes: nodeRows.filter((row) => row.observation_source === "stale-carryover").length,
      stale_links: linkRows.filter((row) => row.observation_source === "stale-carryover").length,
      prior_estimated_nodes: nodeRows.filter((row) => row.observation_source === "oam-prior-estimate").length,
      prior_estimated_links: linkRows.filter((row) => row.observation_source === "oam-prior-estimate").length,
      low_confidence_nodes: nodeRows.filter((row) => numberValue(row.confidence) < 0.5).length,
      low_confidence_links: linkRows.filter((row) => numberValue(row.confidence) < 0.5).length,
      conflicting_nodes: nodeRows.filter((row) => numberValue(row.conflict_ratio) > 0).length,
      conflicting_links: linkRows.filter((row) => numberValue(row.conflict_ratio) > 0).length,
      mean_stale_age_slices: meanStaleAgeSlices,
      mean_conflict_severity: meanConflictSeverity,
      mean_node_confidence: meanNodeConfidence,
      mean_link_confidence: meanLinkConfidence,
      delivered_reports: deliveredReports,
      undelivered_reports: undeliveredReports,
      priority_retest_targets: retestRows.length,
      top_node_targets: topNodes.map((item) => item.target_id).join(" > "),
      top_link_targets: topLinks.map((item) => item.target_id).join(" > "),
      top_retest_reasons: unique(retestRows.slice(0, 8).map((item) => item.reason)).join(" > "),
      control_boundary: "uses-oam-estimates-only-not-stage-one-truth",
    };
  });
}

function countBySource(rows) {
  const counts = { observed: 0, "stale-carryover": 0, "oam-prior-estimate": 0, unknown: 0 };
  rows.forEach((row) => {
    const source = row.observation_source || "unknown";
    counts[source] = (counts[source] ?? 0) + 1;
  });
  return counts;
}

function buildOamEstimateGraph({ reconstructedNodes, reconstructedLinks, truthLinks, delivered, undelivered, priorityRetests, controlActions, oamOptions }) {
  const linkCatalog = indexBy(truthLinks, (link) => link.link_id);
  const retestsBySliceAndTarget = indexBy(priorityRetests, (item) => `${item.slice_index}|${item.target_type}|${item.target_id}`);
  const controlBySlice = indexBy(controlActions, (item) => String(item.slice_index));
  const nodesBySlice = groupBy(reconstructedNodes, (node) => String(node.slice_index));
  const linksBySlice = groupBy(reconstructedLinks, (link) => String(link.slice_index));
  const deliveredBySlice = groupBy(delivered, (report) => String(report.slice_index));
  const undeliveredBySlice = groupBy(undelivered, (report) => String(report.slice_index));
  const sliceIndexes = [...new Set([...nodesBySlice.keys(), ...linksBySlice.keys()])].sort((left, right) => Number(left) - Number(right));

  const slices = sliceIndexes.map((sliceIndex) => {
    const nodeRows = nodesBySlice.get(sliceIndex) ?? [];
    const linkRows = linksBySlice.get(sliceIndex) ?? [];
    const nodeSourceCounts = countBySource(nodeRows);
    const linkSourceCounts = countBySource(linkRows);
    const retestRows = priorityRetests.filter((item) => String(item.slice_index) === String(sliceIndex));
    const control = controlBySlice.get(sliceIndex) ?? {};
    return {
      slice_index: Number(sliceIndex),
      summary: {
        nodes_total: nodeRows.length,
        links_total: linkRows.length,
        nodes_observed: nodeSourceCounts.observed ?? 0,
        nodes_stale: nodeSourceCounts["stale-carryover"] ?? 0,
        nodes_prior_estimated: nodeSourceCounts["oam-prior-estimate"] ?? 0,
        nodes_unknown: nodeSourceCounts.unknown ?? 0,
        links_observed: linkSourceCounts.observed ?? 0,
        links_stale: linkSourceCounts["stale-carryover"] ?? 0,
        links_prior_estimated: linkSourceCounts["oam-prior-estimate"] ?? 0,
        links_unknown: linkSourceCounts.unknown ?? 0,
        mean_node_confidence: round(mean(nodeRows.map((node) => numberValue(node.confidence)).filter(Number.isFinite))),
        mean_link_confidence: round(mean(linkRows.map((link) => numberValue(link.confidence)).filter(Number.isFinite))),
        mean_node_state_age_slices: round(mean(nodeRows.map((node) => numberValue(node.state_age_slices, NaN)).filter(Number.isFinite))),
        mean_link_state_age_slices: round(mean(linkRows.map((link) => numberValue(link.state_age_slices, NaN)).filter(Number.isFinite))),
        mean_node_conflict_severity: round(mean(nodeRows.map((node) => numberValue(node.conflict_severity, NaN)).filter(Number.isFinite))),
        mean_link_conflict_severity: round(mean(linkRows.map((link) => numberValue(link.conflict_severity, NaN)).filter(Number.isFinite))),
        delivered_reports: (deliveredBySlice.get(sliceIndex) ?? []).length,
        undelivered_reports: (undeliveredBySlice.get(sliceIndex) ?? []).length,
        priority_retest_targets: retestRows.length,
        oam_control_pressure: control.oam_control_pressure ?? 0,
        stale_age_pressure: control.stale_age_pressure ?? 0,
        confidence_debt_pressure: control.confidence_debt_pressure ?? 0,
        fusion_conflict_pressure: control.fusion_conflict_pressure ?? 0,
        coverage_demand_pressure: control.coverage_demand_pressure ?? 0,
        recommended_sampling_rate: control.recommended_sampling_rate ?? "",
        recommended_target_active_link_sampling_rate: control.recommended_target_active_link_sampling_rate ?? "",
        recommended_telemetry_byte_budget_per_slice: control.recommended_telemetry_byte_budget_per_slice ?? "",
        recommended_downlink_budget_bytes: control.recommended_downlink_budget_bytes ?? "",
        budget_recommendation_action: control.budget_recommendation_action ?? "",
        recommended_action: control.recommended_action ?? "maintain-current-plan",
        probe_bias: control.probe_bias ?? "normal-coverage",
        confidence_budget: control.confidence_budget ?? "healthy",
      },
      control_action: control,
      nodes: nodeRows.map((node) => {
        const retest = retestsBySliceAndTarget.get(`${node.slice_index}|node|${node.node_id}`);
        return {
          node_id: node.node_id,
          observation_source: node.observation_source,
          observed: String(node.observed) === "true",
          confidence: numberValue(node.confidence),
          confidence_before_decay: node.confidence_before_decay ?? "",
          confidence_decay_factor: node.confidence_decay_factor ?? "",
          confidence_state: node.confidence_state ?? "",
          state_age_slices: node.state_age_slices ?? "",
          last_observed_slice: node.last_observed_slice,
          mode_estimate: node.mode_estimate,
          cpu_percent_estimate: node.cpu_percent_estimate,
          queue_depth_estimate: node.queue_depth_estimate,
          queued_traffic_mb_estimate: node.queued_traffic_mb_estimate,
          cache_used_mb_estimate: node.cache_used_mb_estimate,
          energy_percent_estimate: node.energy_percent_estimate,
          observation_count: node.observation_count ?? "",
          conflict_ratio: node.conflict_ratio ?? 0,
          conflict_severity: node.conflict_severity ?? 0,
          categorical_conflict_ratio: node.categorical_conflict_ratio ?? "",
          numeric_conflict_ratio: node.numeric_conflict_ratio ?? "",
          fusion_confidence_penalty: node.fusion_confidence_penalty ?? "",
          fusion_sample_support: node.fusion_sample_support ?? "",
          fusion_method: node.fusion_method ?? "",
          priority_retest_score: retest?.priority_score ?? "",
          priority_retest_reason: retest?.reason ?? "",
        };
      }),
      links: linkRows.map((link) => {
        const catalog = linkCatalog.get(link.link_id) ?? {};
        const retest = retestsBySliceAndTarget.get(`${link.slice_index}|link|${link.link_id}`);
        return {
          link_id: link.link_id,
          source: catalog.source ?? "",
          target: catalog.target ?? "",
          kind: catalog.kind ?? "",
          observation_source: link.observation_source,
          observed: String(link.observed) === "true",
          confidence: numberValue(link.confidence),
          confidence_before_decay: link.confidence_before_decay ?? "",
          confidence_decay_factor: link.confidence_decay_factor ?? "",
          confidence_state: link.confidence_state ?? "",
          state_age_slices: link.state_age_slices ?? "",
          last_observed_slice: link.last_observed_slice,
          status_estimate: link.status_estimate,
          active_estimate: link.active_estimate,
          utilization_percent_estimate: link.utilization_percent_estimate,
          latency_ms_estimate: link.latency_ms_estimate,
          queue_latency_ms_estimate: link.queue_latency_ms_estimate,
          capacity_mbps_estimate: link.capacity_mbps_estimate,
          congestion_percent_estimate: link.congestion_percent_estimate,
          queued_traffic_mb_estimate: link.queued_traffic_mb_estimate,
          dropped_traffic_mb_estimate: link.dropped_traffic_mb_estimate,
          packet_error_rate_estimate: link.packet_error_rate_estimate,
          observation_count: link.observation_count ?? "",
          conflict_ratio: link.conflict_ratio ?? 0,
          conflict_severity: link.conflict_severity ?? 0,
          categorical_conflict_ratio: link.categorical_conflict_ratio ?? "",
          numeric_conflict_ratio: link.numeric_conflict_ratio ?? "",
          fusion_confidence_penalty: link.fusion_confidence_penalty ?? "",
          fusion_sample_support: link.fusion_sample_support ?? "",
          fusion_method: link.fusion_method ?? "",
          priority_retest_score: retest?.priority_score ?? "",
          priority_retest_reason: retest?.reason ?? "",
        };
      }),
    };
  });

  return {
    schema_version: "stage2-ground-oam-estimate-graph-v1",
    generated_at: new Date().toISOString(),
    boundary: {
      state_source: "delivered-int-reports-plus-stale-carryover-plus-oam-prior-estimates",
      topology_catalog_source: "stage-one-exported-node-link-inventory",
      truth_values_not_used_to_fill_state: true,
      unknown_not_filled_from_truth: true,
      prior_estimates_not_counted_as_observed: true,
      control_actions_use_only_oam_estimates: true,
    },
    oam_state_model: {
      stale_carry_over_enabled: oamOptions.staleCarryOver,
      prior_estimates_enabled: oamOptions.priorEstimatesEnabled,
      confidence_half_life_slices: oamOptions.confidenceHalfLifeSlices,
      min_stale_confidence: oamOptions.minStaleConfidence,
      min_prior_confidence: oamOptions.minPriorConfidence,
      max_prior_confidence: oamOptions.maxPriorConfidence,
      report_fusion: "majority-mean-conflict-aware-fusion-with-numeric-spread",
      stale_confidence_decay: "exponential-half-life",
    },
    summary: {
      slices: slices.length,
      total_node_estimates: reconstructedNodes.length,
      total_link_estimates: reconstructedLinks.length,
      oam_prior_node_estimates: reconstructedNodes.filter((node) => node.observation_source === "oam-prior-estimate").length,
      oam_prior_link_estimates: reconstructedLinks.filter((link) => link.observation_source === "oam-prior-estimate").length,
      delivered_reports: delivered.length,
      undelivered_reports: undelivered.length,
      priority_retest_targets: priorityRetests.length,
      control_action_slices: controlActions.length,
      refresh_probe_plan_slices: controlActions.filter((row) => row.recommended_action === "refresh-probe-plan").length,
      priority_retest_action_slices: controlActions.filter((row) => row.recommended_action === "schedule-priority-retest").length,
      mean_oam_control_pressure: round(mean(controlActions.map((row) => numberValue(row.oam_control_pressure)).filter(Number.isFinite))),
      mean_node_confidence: round(mean(reconstructedNodes.map((node) => numberValue(node.confidence)).filter(Number.isFinite))),
      mean_link_confidence: round(mean(reconstructedLinks.map((link) => numberValue(link.confidence)).filter(Number.isFinite))),
      mean_stale_age_slices: round(mean([...reconstructedNodes, ...reconstructedLinks].map((row) => numberValue(row.state_age_slices, NaN)).filter(Number.isFinite))),
      mean_conflict_severity: round(mean([...reconstructedNodes, ...reconstructedLinks].map((row) => numberValue(row.conflict_severity, NaN)).filter(Number.isFinite))),
      mean_confidence_decay_factor: round(mean([...reconstructedNodes, ...reconstructedLinks].map((row) => numberValue(row.confidence_decay_factor, NaN)).filter(Number.isFinite))),
      mean_coverage_demand_pressure: round(mean(controlActions.map((row) => numberValue(row.coverage_demand_pressure)).filter(Number.isFinite))),
      mean_recommended_sampling_rate: round(mean(controlActions.map((row) => numberValue(row.recommended_sampling_rate)).filter(Number.isFinite))),
      mean_recommended_target_active_link_sampling_rate: round(mean(controlActions.map((row) => numberValue(row.recommended_target_active_link_sampling_rate)).filter(Number.isFinite))),
      mean_recommended_telemetry_byte_budget_per_slice: round(mean(controlActions.map((row) => numberValue(row.recommended_telemetry_byte_budget_per_slice)).filter(Number.isFinite))),
      mean_recommended_downlink_budget_bytes: round(mean(controlActions.map((row) => numberValue(row.recommended_downlink_budget_bytes)).filter(Number.isFinite))),
    },
    control_actions: controlActions,
    slices,
  };
}

const args = process.argv.slice(2);
const inputDir = resolve(argValue(args, "--input", "exports/tmp-highload-check"));
const stage2Dir = resolve(argValue(args, "--stage2", `stage2-int/outputs/${basename(inputDir)}`));
const outputDir = resolve(argValue(args, "--out", stage2Dir));
const nodesPath = resolve(argValue(args, "--nodes", join(inputDir, "nodes.csv")));
const linksPath = resolve(argValue(args, "--links", join(inputDir, "links.csv")));
const hopRecordsPath = resolve(argValue(args, "--hops", join(stage2Dir, "int-hop-records.csv")));
const reportsPath = resolve(argValue(args, "--reports", join(stage2Dir, "int-reports.csv")));
const budgetBytes = numberValue(argValue(args, "--downlink-budget-bytes", "65536"), 65536);
const carryOver = argValue(args, "--carry-over", "true").toLowerCase() !== "false";
const staleCarryOver = argValue(args, "--stale-carry-over", "true").toLowerCase() !== "false";
const confidenceHalfLifeSlices = numberValue(argValue(args, "--confidence-half-life-slices", "3"), 3);
const minStaleConfidence = numberValue(argValue(args, "--min-stale-confidence", "0.15"), 0.15);
const priorEstimatesEnabled = argValue(args, "--oam-prior-estimates", "true").toLowerCase() !== "false";
const minPriorConfidence = numberValue(argValue(args, "--min-prior-confidence", "0.08"), 0.08);
const maxPriorConfidence = numberValue(argValue(args, "--max-prior-confidence", "0.35"), 0.35);
const maxRetestsPerSlice = numberValue(argValue(args, "--max-retests-per-slice", "12"), 12);
const baseTelemetryByteBudgetPerSlice = numberValue(argValue(args, "--base-telemetry-byte-budget-per-slice", "24000"), 24000);

requireFile(nodesPath, "nodes.csv");
requireFile(linksPath, "links.csv");
requireFile(hopRecordsPath, "int-hop-records.csv");
requireFile(reportsPath, "int-reports.csv");

const [truthNodes, truthLinks, hopRecords, reports] = await Promise.all([
  readCsv(nodesPath),
  readCsv(linksPath),
  readCsv(hopRecordsPath),
  readCsv(reportsPath),
]);

const { transmittable, preDropped } = splitTransmittableReports(reports);
const { delivered, queued } = deliverReports(transmittable, budgetBytes, carryOver);
const undelivered = [...queued, ...preDropped];
const deliveredPacketIds = new Set(delivered.map((report) => report.packet_id));
const deliveredHopRecords = hopRecords.filter((record) => deliveredPacketIds.has(record.packet_id));
const oamOptions = {
  staleCarryOver,
  confidenceHalfLifeSlices,
  minStaleConfidence,
  priorEstimatesEnabled,
  minPriorConfidence,
  maxPriorConfidence,
};
const baseReconstructedNodes = reconstructNodes(deliveredHopRecords, truthNodes, oamOptions);
const baseReconstructedLinks = reconstructLinks(deliveredHopRecords, truthLinks, oamOptions);
const priorApplied = applyOamPriorEstimates({
  reconstructedNodes: baseReconstructedNodes,
  reconstructedLinks: baseReconstructedLinks,
  truthLinks,
  options: oamOptions,
});
const reconstructedNodes = priorApplied.nodes;
const reconstructedLinks = priorApplied.links;
const nodeMetrics = evaluateNodes(reconstructedNodes, truthNodes);
const linkMetrics = evaluateLinks(reconstructedLinks, truthLinks);
const priorityRetests = buildPriorityRetests({ reconstructedNodes, reconstructedLinks, maxPerSlice: maxRetestsPerSlice });
const controlActions = buildControlActions({
  reconstructedNodes,
  reconstructedLinks,
  delivered,
  undelivered,
  priorityRetests,
  baseTelemetryByteBudgetPerSlice,
  baseDownlinkBudgetBytes: budgetBytes,
});
const estimateGraph = buildOamEstimateGraph({
  reconstructedNodes,
  reconstructedLinks,
  truthLinks,
  delivered,
  undelivered,
  priorityRetests,
  controlActions,
  oamOptions,
});

const reportMetrics = {
  schema_version: "stage2-ground-oam-evaluation-v1",
  generated_at: new Date().toISOString(),
  source: {
    input_dir: inputDir,
    stage2_dir: stage2Dir,
    nodes_csv: nodesPath,
    links_csv: linksPath,
    int_hop_records_csv: hopRecordsPath,
    int_reports_csv: reportsPath,
  },
  boundary: {
    runtime_uses_only_delivered_int_reports: true,
    truth_used_only_for_evaluation: true,
    unknown_not_filled_from_truth: true,
    stale_estimates_not_counted_as_observed: true,
    prior_estimates_not_counted_as_observed: true,
  },
  downlink_model: {
    per_slice_budget_bytes: budgetBytes,
    carry_over_enabled: carryOver,
    generated_reports: reports.length,
    transmittable_reports: transmittable.length,
    delivered_reports: delivered.length,
    queued_or_dropped_reports: undelivered.length,
    delivered_hop_records: deliveredHopRecords.length,
    delivery_ratio: round(delivered.length / Math.max(reports.length, 1)),
    mean_delivery_delay_slices: round(mean(delivered.map((report) => numberValue(report.delivery_delay_slices)))),
  },
  oam_state_model: {
    stale_carry_over_enabled: staleCarryOver,
    prior_estimates_enabled: priorEstimatesEnabled,
    confidence_half_life_slices: confidenceHalfLifeSlices,
    min_stale_confidence: minStaleConfidence,
    min_prior_confidence: minPriorConfidence,
    max_prior_confidence: maxPriorConfidence,
    report_fusion: "majority-mean-conflict-aware-fusion-with-numeric-spread",
    stale_confidence_decay: "exponential-half-life",
    prior_estimator: "same-slice-spatial-group-then-same-slice-then-history",
    priority_retest_enabled: true,
    max_retests_per_slice: maxRetestsPerSlice,
  },
  node_reconstruction: nodeMetrics,
  link_reconstruction: linkMetrics,
  priority_retest: {
    recommended_targets: priorityRetests.length,
    max_retests_per_slice: maxRetestsPerSlice,
    policy: "unknown-stale-low-confidence-conflict-warning",
  },
  control_plane: {
    control_actions: controlActions.length,
    policy: "confidence-debt-and-retest-pressure",
    refresh_probe_plan_slices: controlActions.filter((row) => row.recommended_action === "refresh-probe-plan").length,
    priority_retest_action_slices: controlActions.filter((row) => row.recommended_action === "schedule-priority-retest").length,
    mean_oam_control_pressure: round(mean(controlActions.map((row) => numberValue(row.oam_control_pressure)).filter(Number.isFinite))),
    mean_stale_age_pressure: round(mean(controlActions.map((row) => numberValue(row.stale_age_pressure)).filter(Number.isFinite))),
    mean_confidence_debt_pressure: round(mean(controlActions.map((row) => numberValue(row.confidence_debt_pressure)).filter(Number.isFinite))),
    mean_fusion_conflict_pressure: round(mean(controlActions.map((row) => numberValue(row.fusion_conflict_pressure)).filter(Number.isFinite))),
    mean_coverage_demand_pressure: round(mean(controlActions.map((row) => numberValue(row.coverage_demand_pressure)).filter(Number.isFinite))),
    mean_recommended_sampling_rate: round(mean(controlActions.map((row) => numberValue(row.recommended_sampling_rate)).filter(Number.isFinite))),
    mean_recommended_target_active_link_sampling_rate: round(mean(controlActions.map((row) => numberValue(row.recommended_target_active_link_sampling_rate)).filter(Number.isFinite))),
    mean_recommended_telemetry_byte_budget_per_slice: round(mean(controlActions.map((row) => numberValue(row.recommended_telemetry_byte_budget_per_slice)).filter(Number.isFinite))),
    mean_recommended_downlink_budget_bytes: round(mean(controlActions.map((row) => numberValue(row.recommended_downlink_budget_bytes)).filter(Number.isFinite))),
    budget_recommendation_source: "ground-oam-confidence-control",
    mean_stale_age_slices: round(mean([...reconstructedNodes, ...reconstructedLinks].map((row) => numberValue(row.state_age_slices, NaN)).filter(Number.isFinite))),
    mean_conflict_severity: round(mean([...reconstructedNodes, ...reconstructedLinks].map((row) => numberValue(row.conflict_severity, NaN)).filter(Number.isFinite))),
    mean_confidence_decay_factor: round(mean([...reconstructedNodes, ...reconstructedLinks].map((row) => numberValue(row.confidence_decay_factor, NaN)).filter(Number.isFinite))),
    boundary: "uses delivered INT reports, stale carry-over and OAM prior estimates; no stage-one truth for runtime actions",
  },
  outputs: {
    estimate_graph_json: join(outputDir, "ground-oam-estimate-graph.json"),
    control_actions_csv: join(outputDir, "ground-oam-control-actions.csv"),
  },
};

await mkdir(outputDir, { recursive: true });
await Promise.all([
  writeFile(join(outputDir, "ground-delivered-reports.csv"), rowsToCsv(delivered), "utf8"),
  writeFile(join(outputDir, "ground-undelivered-reports.csv"), rowsToCsv(undelivered), "utf8"),
  writeFile(join(outputDir, "ground-reconstructed-nodes.csv"), rowsToCsv(reconstructedNodes), "utf8"),
  writeFile(join(outputDir, "ground-reconstructed-links.csv"), rowsToCsv(reconstructedLinks), "utf8"),
  writeFile(join(outputDir, "ground-oam-priority-retest.csv"), rowsToCsv(priorityRetests), "utf8"),
  writeFile(join(outputDir, "ground-oam-control-actions.csv"), rowsToCsv(controlActions), "utf8"),
  writeFile(join(outputDir, "ground-oam-estimate-graph.json"), JSON.stringify(estimateGraph, null, 2), "utf8"),
  writeFile(join(outputDir, "ground-oam-evaluation.json"), JSON.stringify(reportMetrics, null, 2), "utf8"),
]);

console.log(JSON.stringify({
  ok: true,
  outputDir,
  generatedReports: reports.length,
  deliveredReports: delivered.length,
  deliveredHopRecords: deliveredHopRecords.length,
  nodeSampleCoverage: nodeMetrics.node_sample_coverage,
  linkSampleCoverage: linkMetrics.link_sample_coverage,
  activeLinkSampleCoverage: linkMetrics.active_link_sample_coverage,
  cpuMae: nodeMetrics.cpu_mae,
  linkUtilizationMae: linkMetrics.utilization_mae,
  congestionRecallGlobal: linkMetrics.congestion_recall_over_global_truth,
  priorityRetests: priorityRetests.length,
  controlActions: controlActions.length,
  meanOamControlPressure: reportMetrics.control_plane.mean_oam_control_pressure,
  oamPriorNodeEstimates: priorApplied.nodePriorEstimates,
  oamPriorLinkEstimates: priorApplied.linkPriorEstimates,
  estimateGraph: join(outputDir, "ground-oam-estimate-graph.json"),
}, null, 2));
