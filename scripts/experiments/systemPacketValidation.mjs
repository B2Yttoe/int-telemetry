import { createHash } from "node:crypto";

export const SYSTEM_VALIDATION_CONFIG = Object.freeze({
  schema_version: "experiment13-system-validation-config-v1",
  profile_id: "iridium-next-small",
  profile_label: "Iridium NEXT 66",
  slice_count: 20,
  slice_duration_s: 1,
  load_scales: [0.6, 1, 1.4],
  stress_load_scales: [2],
  variants: ["no-int", "full-int", "leo-selective"],
  seed: 11,
  mtu_bytes: 1500,
  ipv4_udp_overhead_bytes: 28,
  queue_packets: 100,
  business_packet_bytes: 1200,
  probe_base_bytes: 128,
  full_metadata_bytes_per_hop: 96,
  probe_interval_ms: 50,
  target_p90_business_utilization: 0.6,
  report_timeout_s: 2,
});

export function numberValue(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function boolValue(value) {
  return value === true || String(value).toLowerCase() === "true" || String(value) === "1";
}

export function round(value, digits = 6) {
  const scale = 10 ** digits;
  return Math.round((numberValue(value) + Number.EPSILON) * scale) / scale;
}

export function splitPath(value) {
  return String(value ?? "")
    .split(/\s*(?:>|\|)\s*/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function endpointKey(source, target) {
  return [String(source), String(target)].sort().join("<->");
}

export function percentile(values, probability) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return 0;
  const position = Math.min(sorted.length - 1, Math.max(0, (sorted.length - 1) * probability));
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const weight = position - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

export function normalizeMetadataBytes(rawValue, nodeCount, fallback = 96) {
  const parsed = splitPath(rawValue).map((value) => Math.max(0, Math.round(numberValue(value, fallback))));
  if (!parsed.length) return Array.from({ length: nodeCount }, () => fallback);
  if (parsed.length >= nodeCount) return parsed.slice(0, nodeCount);
  return [...parsed, ...Array.from({ length: nodeCount - parsed.length }, () => fallback)];
}

export function validatePathAgainstLinks({ sliceIndex, pathNodes, linkRows }) {
  const available = new Map(
    linkRows
      .filter((row) => numberValue(row.slice_index) === numberValue(sliceIndex))
      .map((row) => [endpointKey(row.source, row.target), row]),
  );
  const pathLinkIds = [];
  for (let index = 0; index < pathNodes.length - 1; index += 1) {
    const row = available.get(endpointKey(pathNodes[index], pathNodes[index + 1]));
    if (!row || !boolValue(row.is_active)) {
      return {
        valid: false,
        reason: row ? "path-link-inactive" : "path-link-missing",
        failed_hop: `${pathNodes[index]}->${pathNodes[index + 1]}`,
        link_ids: pathLinkIds,
      };
    }
    pathLinkIds.push(row.link_id);
  }
  return { valid: pathNodes.length >= 2, reason: "", failed_hop: "", link_ids: pathLinkIds };
}

function shortestActivePath(adjacency, source, target) {
  if (source === target) return [source];
  const queue = [source];
  const previous = new Map([[source, null]]);
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor];
    for (const neighbor of adjacency.get(current) ?? []) {
      if (previous.has(neighbor)) continue;
      previous.set(neighbor, current);
      if (neighbor === target) {
        const path = [target];
        let walker = current;
        while (walker !== null) {
          path.push(walker);
          walker = previous.get(walker) ?? null;
        }
        return path.reverse();
      }
      queue.push(neighbor);
    }
  }
  return [];
}

export function repairPathAgainstLinks({ sliceIndex, pathNodes, linkRows }) {
  const sliceLinks = linkRows.filter((row) =>
    numberValue(row.slice_index) === numberValue(sliceIndex) && boolValue(row.is_active));
  const available = new Map(sliceLinks.map((row) => [endpointKey(row.source, row.target), row]));
  const adjacency = new Map();
  sliceLinks.forEach((row) => {
    if (!adjacency.has(row.source)) adjacency.set(row.source, []);
    if (!adjacency.has(row.target)) adjacency.set(row.target, []);
    adjacency.get(row.source).push(row.target);
    adjacency.get(row.target).push(row.source);
  });
  adjacency.forEach((neighbors) => neighbors.sort());
  if (pathNodes.length < 2) {
    return { valid: false, reason: "path-too-short", failed_hop: "", path_nodes: pathNodes };
  }

  const repairedNodes = [pathNodes[0]];
  const originalWaypointIndexes = [0];
  let repairCount = 0;
  let insertedTransitHops = 0;
  for (let index = 0; index < pathNodes.length - 1; index += 1) {
    const source = pathNodes[index];
    const target = pathNodes[index + 1];
    let segment = [source, target];
    if (!available.has(endpointKey(source, target))) {
      segment = shortestActivePath(adjacency, source, target);
      if (!segment.length) {
        return {
          valid: false,
          reason: "path-segment-disconnected",
          failed_hop: `${source}->${target}`,
          path_nodes: repairedNodes,
          original_waypoint_indexes: originalWaypointIndexes,
          repair_count: repairCount,
          inserted_transit_hops: insertedTransitHops,
        };
      }
      repairCount += 1;
      insertedTransitHops += Math.max(0, segment.length - 2);
    }
    for (let segmentIndex = 1; segmentIndex < segment.length; segmentIndex += 1) {
      repairedNodes.push(segment[segmentIndex]);
      originalWaypointIndexes.push(segmentIndex === segment.length - 1 ? index + 1 : -1);
    }
  }
  const validation = validatePathAgainstLinks({ sliceIndex, pathNodes: repairedNodes, linkRows });
  return {
    ...validation,
    path_nodes: repairedNodes,
    original_waypoint_indexes: originalWaypointIndexes,
    repair_count: repairCount,
    inserted_transit_hops: insertedTransitHops,
  };
}

export function calibrateBusinessRates({ flows, links, targetP90Utilization = 0.6 }) {
  const capacityBySliceEndpoint = new Map();
  links.forEach((row) => {
    const capacity = Math.max(0.001, numberValue(row.data_rate_mbps, 50));
    capacityBySliceEndpoint.set(`${row.slice_index}|${endpointKey(row.source, row.target)}`, capacity);
  });
  const loadBySliceEndpoint = new Map();
  flows.forEach((flow) => {
    const nodes = splitPath(flow.path_nodes);
    const rawRate = Math.max(0, numberValue(flow.raw_rate_mbps));
    for (let index = 0; index < nodes.length - 1; index += 1) {
      const key = `${flow.slice_index}|${endpointKey(nodes[index], nodes[index + 1])}`;
      loadBySliceEndpoint.set(key, (loadBySliceEndpoint.get(key) ?? 0) + rawRate);
    }
  });
  const rawUtilizations = [...loadBySliceEndpoint.entries()]
    .map(([key, load]) => load / Math.max(0.001, capacityBySliceEndpoint.get(key) ?? 50));
  const rawP90 = percentile(rawUtilizations, 0.9);
  const calibrationScale = rawP90 > 0 ? Math.min(1, targetP90Utilization / rawP90) : 1;
  return {
    calibration_scale: round(calibrationScale),
    raw_p90_utilization: round(rawP90),
    calibrated_p90_utilization: round(rawP90 * calibrationScale),
    flows: flows.map((flow) => ({
      ...flow,
      base_rate_mbps: round(Math.max(0.05, numberValue(flow.raw_rate_mbps) * calibrationScale)),
    })),
  };
}

class MinHeap {
  constructor() {
    this.items = [];
  }

  push(item) {
    this.items.push(item);
    let index = this.items.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.items[parent].time <= item.time) break;
      this.items[index] = this.items[parent];
      index = parent;
    }
    this.items[index] = item;
  }

  pop() {
    if (!this.items.length) return null;
    const first = this.items[0];
    const last = this.items.pop();
    if (this.items.length && last) {
      let index = 0;
      while (true) {
        const left = index * 2 + 1;
        const right = left + 1;
        if (left >= this.items.length) break;
        const child = right < this.items.length && this.items[right].time < this.items[left].time ? right : left;
        if (this.items[child].time >= last.time) break;
        this.items[index] = this.items[child];
        index = child;
      }
      this.items[index] = last;
    }
    return first;
  }

  get size() {
    return this.items.length;
  }
}

function deterministicProbability(key) {
  const digest = createHash("sha256").update(key).digest();
  return digest.readUInt32BE(0) / 0x100000000;
}

function metricDrop(metrics, packet, reason) {
  metrics[`${reason}_drop_packets`] += 1;
  if (packet.kind === "business") metrics.business_dropped_packets += 1;
  if (packet.kind === "probe" && packet.direction === -1) metrics.report_dropped_packets += 1;
  if (packet.kind === "probe" && packet.direction === 1) metrics.probe_forward_dropped_packets += 1;
}

function computeOamAoi(metrics, simulationEnd, reportTimeout) {
  let totalArea = 0;
  let totalDuration = 0;
  const peaksMs = [];
  for (const [flowId, window] of metrics.probe_streams.entries()) {
    const start = numberValue(window.start_s);
    const end = Math.min(simulationEnd, numberValue(window.stop_s) + reportTimeout);
    if (end <= start) continue;
    let lastTime = start;
    let lastGeneration = start;
    const updates = metrics.report_updates
      .filter((update) => update.flow_id === flowId)
      .sort((left, right) => left.delivered_s - right.delivered_s);
    for (const update of updates) {
      if (update.delivered_s < start || update.delivered_s > end ||
          update.generated_s < lastGeneration) continue;
      const startAge = Math.max(0, lastTime - lastGeneration);
      const endAge = Math.max(0, update.delivered_s - lastGeneration);
      totalArea += 0.5 * (endAge ** 2 - startAge ** 2);
      peaksMs.push(endAge * 1000);
      lastTime = update.delivered_s;
      lastGeneration = update.generated_s;
    }
    const finalStartAge = Math.max(0, lastTime - lastGeneration);
    const finalEndAge = Math.max(0, end - lastGeneration);
    totalArea += 0.5 * (finalEndAge ** 2 - finalStartAge ** 2);
    peaksMs.push(finalEndAge * 1000);
    totalDuration += end - start;
  }
  return {
    oam_time_average_aoi_ms: totalDuration > 0 ? round(totalArea / totalDuration * 1000) : null,
    oam_peak_aoi_p95_ms: peaksMs.length ? round(percentile(peaksMs, 0.95)) : null,
  };
}

function scheduleTraffic(heap, fixture, variant, loadScale, metrics) {
  fixture.businessFlows.forEach((flow) => {
    const rateMbps = Math.max(0.001, numberValue(flow.base_rate_mbps) * loadScale);
    const packetBytes = numberValue(flow.packet_size_bytes, fixture.config.business_packet_bytes);
    const interval = (packetBytes * 8) / (rateMbps * 1e6);
    const start = numberValue(flow.start_s);
    const stop = numberValue(flow.stop_s);
    let sequence = 0;
    for (let time = start; time < stop - 1e-12; time += interval) {
      heap.push({
        time,
        type: "inject",
        packet: {
          id: `B:${flow.flow_id}:${sequence}`,
          kind: "business",
          direction: 1,
          hop_index: 0,
          path_nodes: splitPath(flow.path_nodes),
          metadata_bytes: [],
          size_bytes: packetBytes,
          payload_bytes: packetBytes,
          created_s: time,
          flow_id: flow.flow_id,
        },
      });
      metrics.business_sent_packets += 1;
      metrics.business_offered_payload_bytes += packetBytes;
      sequence += 1;
    }
  });

  if (variant === "no-int") return;
  fixture.probeFlows.filter((flow) => flow.variant === variant).forEach((flow) => {
    const interval = numberValue(flow.interval_ms, fixture.config.probe_interval_ms) / 1000;
    const start = numberValue(flow.start_s);
    const stop = numberValue(flow.stop_s);
    const pathNodes = splitPath(flow.path_nodes);
    const metadataBytes = splitPath(flow.metadata_bytes_by_hop).map((value) => numberValue(value));
    metrics.probe_streams.set(flow.probe_id, { start_s: start, stop_s: stop });
    let forwardSize = numberValue(flow.base_packet_bytes, fixture.config.probe_base_bytes);
    let plannedBytesPerProbe = 0;
    for (let index = 0; index < pathNodes.length - 1; index += 1) {
      forwardSize += Math.max(0, metadataBytes[index] ?? 0);
      plannedBytesPerProbe += forwardSize + fixture.config.ipv4_udp_overhead_bytes;
    }
    forwardSize += Math.max(0, metadataBytes[pathNodes.length - 1] ?? 0);
    plannedBytesPerProbe += Math.max(0, pathNodes.length - 1) *
      (forwardSize + fixture.config.ipv4_udp_overhead_bytes);
    let sequence = 0;
    for (let time = start; time < stop - 1e-12; time += interval) {
      heap.push({
        time,
        type: "inject",
        packet: {
          id: `P:${flow.probe_id}:${sequence}`,
          kind: "probe",
          direction: 1,
          hop_index: 0,
          path_nodes: pathNodes,
          metadata_bytes: metadataBytes,
          size_bytes: numberValue(flow.base_packet_bytes, fixture.config.probe_base_bytes),
          payload_bytes: 0,
          created_s: time,
          flow_id: flow.probe_id,
          metadata_written_at: new Set(),
        },
      });
      metrics.probe_sent_packets += 1;
      metrics.planned_telemetry_network_bytes += plannedBytesPerProbe;
      sequence += 1;
    }
  });
}

function makeMetrics({ variant, loadScale, seed }) {
  return {
    engine: "independent-js-packet-reference",
    evidence_role: "interface-and-trend-smoke-not-ns3-system-evidence",
    variant,
    load_scale: loadScale,
    seed,
    business_sent_packets: 0,
    business_delivered_packets: 0,
    business_dropped_packets: 0,
    business_offered_payload_bytes: 0,
    business_delivered_payload_bytes: 0,
    probe_sent_packets: 0,
    probe_forward_dropped_packets: 0,
    report_delivered_packets: 0,
    report_dropped_packets: 0,
    business_network_bytes: 0,
    telemetry_network_bytes: 0,
    planned_telemetry_network_bytes: 0,
    attempted_telemetry_network_bytes: 0,
    metadata_generated_bytes: 0,
    mtu_exceeded_packets: 0,
    mtu_drop_packets: 0,
    queue_drop_packets: 0,
    link_down_drop_packets: 0,
    packet_error_drop_packets: 0,
    max_wire_packet_bytes: 0,
    business_delays_ms: [],
    report_rtts_ms: [],
    queue_delays_ms: [],
    business_queue_delays_ms: [],
    telemetry_queue_delays_ms: [],
    probe_streams: new Map(),
    report_updates: [],
  };
}

export function runPacketReference({ fixture, variant, loadScale = 1, seed = 11 }) {
  const config = fixture.config;
  const linkBySliceEndpoint = new Map();
  fixture.links.forEach((row) => {
    linkBySliceEndpoint.set(`${row.slice_index}|${endpointKey(row.source, row.target)}`, row);
  });
  const queueAvailableAt = new Map();
  const heap = new MinHeap();
  const metrics = makeMetrics({ variant, loadScale, seed });
  scheduleTraffic(heap, fixture, variant, loadScale, metrics);
  const simulationEnd = config.slice_count * config.slice_duration_s + config.report_timeout_s;

  const transmit = (packet, time) => {
    const lastIndex = packet.path_nodes.length - 1;
    const current = packet.hop_index;
    if (packet.kind === "probe" && packet.direction === 1 && !packet.metadata_written_at.has(current)) {
      const metadataBytes = Math.max(0, numberValue(packet.metadata_bytes[current]));
      packet.size_bytes += metadataBytes;
      packet.metadata_written_at.add(current);
      metrics.metadata_generated_bytes += metadataBytes;
    }

    if (packet.kind === "business" && current === lastIndex) {
      metrics.business_delivered_packets += 1;
      metrics.business_delivered_payload_bytes += packet.payload_bytes;
      metrics.business_delays_ms.push((time - packet.created_s) * 1000);
      return;
    }
    if (packet.kind === "probe" && packet.direction === 1 && current === lastIndex) {
      packet.direction = -1;
      if (lastIndex === 0) {
        metrics.report_delivered_packets += 1;
        metrics.report_rtts_ms.push((time - packet.created_s) * 1000);
        metrics.report_updates.push({
          flow_id: packet.flow_id,
          generated_s: packet.created_s,
          delivered_s: time,
        });
        return;
      }
    } else if (packet.kind === "probe" && packet.direction === -1 && current === 0) {
      metrics.report_delivered_packets += 1;
      metrics.report_rtts_ms.push((time - packet.created_s) * 1000);
      metrics.report_updates.push({
        flow_id: packet.flow_id,
        generated_s: packet.created_s,
        delivered_s: time,
      });
      return;
    }

    const next = current + packet.direction;
    if (next < 0 || next > lastIndex) {
      metricDrop(metrics, packet, "link_down");
      return;
    }
    const source = packet.path_nodes[current];
    const target = packet.path_nodes[next];
    const currentSlice = Math.min(
      config.slice_count - 1,
      Math.max(0, Math.floor(time / config.slice_duration_s)),
    );
    const link = linkBySliceEndpoint.get(`${currentSlice}|${endpointKey(source, target)}`);
    if (!link || !boolValue(link.is_active)) {
      metricDrop(metrics, packet, "link_down");
      return;
    }

    const wireBytes = packet.size_bytes + config.ipv4_udp_overhead_bytes;
    metrics.max_wire_packet_bytes = Math.max(metrics.max_wire_packet_bytes, wireBytes);
    if (packet.kind === "probe") metrics.attempted_telemetry_network_bytes += wireBytes;
    if (wireBytes > config.mtu_bytes) {
      metrics.mtu_exceeded_packets += 1;
      metricDrop(metrics, packet, "mtu");
      return;
    }
    const rateMbps = Math.max(0.001, numberValue(link.data_rate_mbps, 50));
    const directionKey = `${link.link_id}|${source}->${target}`;
    const availableAt = queueAvailableAt.get(directionKey) ?? time;
    const queueDelay = Math.max(0, availableAt - time);
    const queuedBytes = queueDelay * rateMbps * 1e6 / 8;
    if (queuedBytes + wireBytes > config.queue_packets * config.mtu_bytes) {
      metricDrop(metrics, packet, "queue");
      return;
    }
    const txStart = Math.max(time, availableAt);
    const txDuration = wireBytes * 8 / (rateMbps * 1e6);
    const txEnd = txStart + txDuration;
    queueAvailableAt.set(directionKey, txEnd);
    metrics.queue_delays_ms.push(queueDelay * 1000);
    if (packet.kind === "business") {
      metrics.business_network_bytes += wireBytes;
      metrics.business_queue_delays_ms.push(queueDelay * 1000);
    } else {
      metrics.telemetry_network_bytes += wireBytes;
      metrics.telemetry_queue_delays_ms.push(queueDelay * 1000);
    }

    const errorRate = Math.max(0, Math.min(1, numberValue(link.packet_error_rate)));
    const errorDraw = deterministicProbability(`${seed}|${packet.id}|${current}|${packet.direction}|${currentSlice}`);
    if (errorDraw < errorRate) {
      metricDrop(metrics, packet, "packet_error");
      return;
    }
    const delay = Math.max(0, numberValue(link.delay_ms, 0)) / 1000;
    heap.push({
      time: txEnd + delay,
      type: "arrive",
      packet: { ...packet, hop_index: next },
    });
  };

  while (heap.size) {
    const event = heap.pop();
    if (!event || event.time > simulationEnd) break;
    transmit(event.packet, event.time);
  }

  const duration = config.slice_count * config.slice_duration_s;
  const reportDenominator = Math.max(1, metrics.probe_sent_packets);
  const aoi = computeOamAoi(metrics, simulationEnd, config.report_timeout_s);
  const result = {
    ...metrics,
    business_delivery_ratio: round(metrics.business_delivered_packets / Math.max(1, metrics.business_sent_packets)),
    business_throughput_mbps: round(metrics.business_delivered_payload_bytes * 8 / (duration * 1e6)),
    business_delay_p50_ms: round(percentile(metrics.business_delays_ms, 0.5)),
    business_delay_p95_ms: round(percentile(metrics.business_delays_ms, 0.95)),
    queue_delay_p95_ms: round(percentile(metrics.queue_delays_ms, 0.95)),
    business_queue_delay_p95_ms: round(percentile(metrics.business_queue_delays_ms, 0.95)),
    telemetry_queue_delay_p95_ms: variant === "no-int"
      ? null
      : round(percentile(metrics.telemetry_queue_delays_ms, 0.95)),
    report_delivery_ratio: variant === "no-int" ? null : round(metrics.report_delivered_packets / reportDenominator),
    report_rtt_p95_ms: variant === "no-int" ? null : round(percentile(metrics.report_rtts_ms, 0.95)),
    ...aoi,
    useful_reports_per_telemetry_mb: variant === "no-int" ? null : round(
      metrics.report_delivered_packets / Math.max(1e-9, metrics.telemetry_network_bytes / 1e6),
    ),
    useful_reports_per_planned_telemetry_mb: variant === "no-int" ? null : round(
      metrics.report_delivered_packets / Math.max(1e-9, metrics.planned_telemetry_network_bytes / 1e6),
    ),
  };
  delete result.business_delays_ms;
  delete result.report_rtts_ms;
  delete result.queue_delays_ms;
  delete result.business_queue_delays_ms;
  delete result.telemetry_queue_delays_ms;
  delete result.probe_streams;
  delete result.report_updates;
  return result;
}

export function comparePacketResults(rows = []) {
  return rows.map((row) => {
    const peers = rows.filter((candidate) => numberValue(candidate.load_scale) === numberValue(row.load_scale));
    const noInt = peers.find((candidate) => candidate.variant === "no-int");
    const full = peers.find((candidate) => candidate.variant === "full-int");
    return {
      ...row,
      telemetry_byte_reduction_vs_full_percent: row.variant === "no-int" || !full
        ? null
        : round((numberValue(full.planned_telemetry_network_bytes) - numberValue(row.planned_telemetry_network_bytes)) /
          Math.max(1, numberValue(full.planned_telemetry_network_bytes)) * 100),
      successful_telemetry_byte_reduction_vs_full_percent: row.variant === "no-int" || !full
        ? null
        : round((numberValue(full.telemetry_network_bytes) - numberValue(row.telemetry_network_bytes)) /
          Math.max(1, numberValue(full.telemetry_network_bytes)) * 100),
      business_throughput_delta_vs_no_int_percent: !noInt
        ? null
        : round((numberValue(row.business_throughput_mbps) - numberValue(noInt.business_throughput_mbps)) /
          Math.max(1e-9, numberValue(noInt.business_throughput_mbps)) * 100),
      business_delay_p95_delta_vs_no_int_percent: !noInt || numberValue(noInt.business_delay_p95_ms) === 0
        ? null
        : round((numberValue(row.business_delay_p95_ms) - numberValue(noInt.business_delay_p95_ms)) /
          numberValue(noInt.business_delay_p95_ms) * 100),
    };
  });
}
