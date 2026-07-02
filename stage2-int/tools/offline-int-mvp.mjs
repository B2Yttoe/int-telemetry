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

function splitPath(value) {
  if (!value) return [];
  return value.split(" > ").map((item) => item.trim()).filter(Boolean);
}

function stableHash(text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function sampled(route, sampleRate) {
  if (sampleRate >= 1) return true;
  if (sampleRate <= 0) return false;
  const bucket = stableHash(`${route.slice_index}|${route.task_id}`) / 0xffffffff;
  return bucket <= sampleRate;
}

function roleForHop(path, index) {
  if (path.length <= 1) return "local";
  if (index === 0) return "source";
  if (index === path.length - 1) return "sink";
  return "transit";
}

function indexBy(rows, keyFn) {
  const map = new Map();
  rows.forEach((row) => map.set(keyFn(row), row));
  return map;
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

function uniqueBy(rows, keyFn) {
  const map = new Map();
  rows.forEach((row) => {
    const key = keyFn(row);
    if (!map.has(key)) map.set(key, row);
  });
  return [...map.values()];
}

function mean(values) {
  if (values.length === 0) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function toFixedNumber(value, digits = 3) {
  return Number(value.toFixed(digits));
}

function estimateQueueLatencyMs(link) {
  const queuedMb = numberValue(link?.queued_traffic_mb, 0);
  const capacityMbps = numberValue(link?.effective_capacity_mbps || link?.capacity_mbps || link?.bandwidth_mbps, 0);
  if (queuedMb <= 0 || capacityMbps <= 0) return 0;
  return toFixedNumber((queuedMb * 8 * 1000) / capacityMbps, 4);
}

function sortedNumericKeys(map) {
  return [...map.keys()].sort((left, right) => Number(left) - Number(right));
}

function addLinkLoad(map, { sliceIndex, time, linkId, loadType, bytes, packets = 1 }) {
  if (!linkId) return;
  const key = `${sliceIndex}|${linkId}`;
  const row = map.get(key) ?? {
    slice_index: Number(sliceIndex),
    time,
    link_id: linkId,
    probe_packet_count: 0,
    probe_forward_bytes: 0,
    report_packet_count: 0,
    report_forward_bytes: 0,
    total_telemetry_link_bytes: 0,
  };
  if (loadType === "probe") {
    row.probe_packet_count += packets;
    row.probe_forward_bytes += bytes;
  } else {
    row.report_packet_count += packets;
    row.report_forward_bytes += bytes;
  }
  row.total_telemetry_link_bytes += bytes;
  map.set(key, row);
}

function buildOverheadBySlice({
  allSlices = [],
  hopRecords,
  reports,
  hopMetadataBytes,
  probePacketBaseBytes = 0,
  probeCountsBySlice = new Map(),
  reportHeaderBytes,
  hopProcessingJ,
  reportProcessingJ,
  telemetryTxNjPerByte,
}) {
  const hopsBySlice = groupBy(hopRecords, (record) => String(record.slice_index));
  const reportsBySlice = groupBy(reports, (report) => String(report.slice_index));
  const sliceIndexes = [...new Set([...allSlices.map(String), ...hopsBySlice.keys(), ...reportsBySlice.keys()])];
  return sortedNumericKeys(new Map(sliceIndexes.map((sliceIndex) => [sliceIndex, true]))).map((sliceIndex) => {
    const hops = hopsBySlice.get(sliceIndex) ?? [];
    const sliceReports = reportsBySlice.get(sliceIndex) ?? [];
    const metadataBytes = hops.length * hopMetadataBytes;
    const reportBytes = sliceReports.reduce((total, report) => total + numberValue(report.report_size_bytes), 0);
    const baseBytes = (probeCountsBySlice.get(String(sliceIndex)) ?? 0) * probePacketBaseBytes;
    const totalGeneratedBytes = metadataBytes + reportBytes + baseBytes;
    const processingEnergyJ = hops.length * hopProcessingJ + sliceReports.length * reportProcessingJ;
    const txEnergyJ = totalGeneratedBytes * telemetryTxNjPerByte * 1e-9;
    return {
      slice_index: Number(sliceIndex),
      time: hops[0]?.time ?? sliceReports[0]?.time ?? "",
      hop_records: hops.length,
      reports: sliceReports.length,
      generated_reports: sliceReports.filter((report) => report.status === "generated").length,
      dropped_reports: sliceReports.filter((report) => report.status === "dropped").length,
      hop_metadata_bytes: hopMetadataBytes,
      probe_packet_base_bytes: probePacketBaseBytes,
      report_header_bytes: reportHeaderBytes,
      metadata_bytes: metadataBytes,
      report_bytes: reportBytes,
      total_probe_packet_base_bytes: baseBytes,
      total_int_bytes: metadataBytes + reportBytes,
      total_telemetry_generated_bytes: totalGeneratedBytes,
      processing_energy_j: toFixedNumber(processingEnergyJ),
      tx_energy_j: toFixedNumber(txEnergyJ),
      total_telemetry_energy_j: toFixedNumber(processingEnergyJ + txEnergyJ),
      total_telemetry_energy_wh: toFixedNumber((processingEnergyJ + txEnergyJ) / 3600, 8),
    };
  });
}

function buildLinkOverhead({ routes, hopMetadataBytes }) {
  const map = new Map();
  routes.forEach((route) => {
    splitPath(route.link_ids).forEach((linkId, index) => {
      addLinkLoad(map, {
        sliceIndex: route.slice_index,
        time: route.time,
        linkId,
        loadType: "probe",
        bytes: (index + 1) * hopMetadataBytes,
      });
    });
  });
  return [...map.values()]
    .map((row) => ({
      ...row,
      probe_forward_bytes: toFixedNumber(row.probe_forward_bytes),
      report_forward_bytes: toFixedNumber(row.report_forward_bytes),
      total_telemetry_link_bytes: toFixedNumber(row.total_telemetry_link_bytes),
    }))
    .sort((left, right) =>
      Number(left.slice_index) - Number(right.slice_index) ||
      Number(right.total_telemetry_link_bytes) - Number(left.total_telemetry_link_bytes) ||
      left.link_id.localeCompare(right.link_id),
    );
}

function buildNodeOverhead({
  nodes,
  hopRecords,
  reports,
  routes,
  hopMetadataBytes,
  hopProcessingJ,
  reportProcessingJ,
  telemetryTxNjPerByte,
}) {
  const nodeByKey = indexBy(nodes, (node) => `${node.slice_index}|${node.node_id}`);
  const map = new Map();
  const ensure = (sliceIndex, nodeId, fallbackTime = "") => {
    const key = `${sliceIndex}|${nodeId}`;
    if (!map.has(key)) {
      const node = nodeByKey.get(key) ?? {};
      map.set(key, {
        slice_index: Number(sliceIndex),
        time: node.time ?? fallbackTime,
        node_id: nodeId,
        mode: node.mode ?? "",
        energy_percent: numberValue(node.energy_percent, 0),
        energy_wh: numberValue(node.energy_wh, 0),
        in_sunlight: node.in_sunlight ?? "",
        solar_exposure: numberValue(node.solar_exposure, 0),
        net_power_w: numberValue(node.net_power_w, 0),
        power_saving_mode: node.power_saving_mode ?? "",
        can_accept_tasks: node.can_accept_tasks ?? "",
        hop_records: 0,
        path_hop_records: 0,
        adjacent_scan_records: 0,
        source_hop_records: 0,
        transit_hop_records: 0,
        sink_hop_records: 0,
        metadata_bytes_added: 0,
        probe_packet_tx_bytes: 0,
        generated_reports: 0,
        dropped_reports: 0,
        generated_report_bytes: 0,
        report_forward_count: 0,
        report_forward_bytes: 0,
        sgl_downlink_report_bytes: 0,
        processing_energy_j: 0,
        tx_energy_j: 0,
        total_telemetry_energy_j: 0,
        total_telemetry_energy_wh: 0,
        telemetry_energy_soc_percent: 0,
        telemetry_cpu_cost_units: 0,
      });
    }
    return map.get(key);
  };

  nodes.forEach((node) => ensure(node.slice_index, node.node_id, node.time));

  hopRecords.forEach((record) => {
    const row = ensure(record.slice_index, record.node_id, record.time);
    row.hop_records += 1;
    row.path_hop_records += 1;
    if (record.role === "source") row.source_hop_records += 1;
    else if (record.role === "sink") row.sink_hop_records += 1;
    else if (record.role === "transit") row.transit_hop_records += 1;
    row.metadata_bytes_added += hopMetadataBytes;
    row.processing_energy_j += hopProcessingJ;
    row.telemetry_cpu_cost_units += 1;
  });

  routes.forEach((route) => {
    const path = splitPath(route.path);
    splitPath(route.link_ids).forEach((linkId, index) => {
      if (!linkId) return;
      const nodeId = path[index];
      if (!nodeId) return;
      const row = ensure(route.slice_index, nodeId, route.time);
      row.probe_packet_tx_bytes += (index + 1) * hopMetadataBytes;
    });
  });

  reports.forEach((report) => {
    const row = ensure(report.slice_index, report.sink_node, report.time);
    if (report.status === "generated") row.generated_reports += 1;
    else row.dropped_reports += 1;
    row.generated_report_bytes += numberValue(report.report_size_bytes);
    row.sgl_downlink_report_bytes += report.status === "generated" ? numberValue(report.report_size_bytes) : 0;
    row.processing_energy_j += reportProcessingJ;
    row.telemetry_cpu_cost_units += 0.5;
  });

  return [...map.values()]
    .map((row) => {
      const txBytes = row.probe_packet_tx_bytes + row.report_forward_bytes + row.sgl_downlink_report_bytes;
      const txEnergy = txBytes * telemetryTxNjPerByte * 1e-9;
      const totalEnergy = row.processing_energy_j + txEnergy;
      const energyWh = numberValue(row.energy_wh);
      return {
        ...row,
        metadata_bytes_added: toFixedNumber(row.metadata_bytes_added),
        probe_packet_tx_bytes: toFixedNumber(row.probe_packet_tx_bytes),
        generated_report_bytes: toFixedNumber(row.generated_report_bytes),
        report_forward_bytes: toFixedNumber(row.report_forward_bytes),
        sgl_downlink_report_bytes: toFixedNumber(row.sgl_downlink_report_bytes),
        processing_energy_j: toFixedNumber(row.processing_energy_j),
        tx_energy_j: toFixedNumber(txEnergy),
        total_telemetry_energy_j: toFixedNumber(totalEnergy),
        total_telemetry_energy_wh: toFixedNumber(totalEnergy / 3600, 8),
        telemetry_energy_soc_percent: toFixedNumber(energyWh > 0 ? (totalEnergy / 3600 / energyWh) * 100 : 0, 8),
        telemetry_cpu_cost_units: toFixedNumber(row.telemetry_cpu_cost_units),
      };
    })
    .sort((left, right) =>
      Number(left.slice_index) - Number(right.slice_index) ||
      Number(right.total_telemetry_energy_j) - Number(left.total_telemetry_energy_j) ||
      left.node_id.localeCompare(right.node_id),
    );
}

async function readCsv(path) {
  return parseCsv(await readFile(path, "utf8"));
}

function inferPaths(inputDir, args) {
  return {
    nodesPath: resolve(argValue(args, "--nodes", join(inputDir, "nodes.csv"))),
    linksPath: resolve(argValue(args, "--links", join(inputDir, "links.csv"))),
    routesPath: resolve(argValue(args, "--routes", join(inputDir, "routes.csv"))),
  };
}

function requireFile(path, label) {
  if (!existsSync(path)) {
    throw new Error(`${label} not found: ${path}`);
  }
}

const args = process.argv.slice(2);
const inputDir = resolve(argValue(args, "--input", "exports/tmp-highload-check"));
const outputDir = resolve(argValue(args, "--out", `stage2-int/outputs/${basename(inputDir)}`));
const sampleRate = numberValue(argValue(args, "--sample-rate", "1"), 1);
const hopMetadataBytes = numberValue(argValue(args, "--hop-bytes", "96"), 96);
const reportHeaderBytes = numberValue(argValue(args, "--report-header-bytes", "128"), 128);
const hopProcessingJ = numberValue(argValue(args, "--hop-processing-j", "0.02"), 0.02);
const reportProcessingJ = numberValue(argValue(args, "--report-processing-j", "0.05"), 0.05);
const telemetryTxNjPerByte = numberValue(argValue(args, "--telemetry-tx-nj-per-byte", "120"), 120);
const { nodesPath, linksPath, routesPath } = inferPaths(inputDir, args);

requireFile(nodesPath, "nodes.csv");
requireFile(linksPath, "links.csv");
requireFile(routesPath, "routes.csv");

const [nodes, links, routes] = await Promise.all([
  readCsv(nodesPath),
  readCsv(linksPath),
  readCsv(routesPath),
]);

const nodesBySliceAndId = indexBy(nodes, (node) => `${node.slice_index}|${node.node_id}`);
const linksBySliceAndId = indexBy(links, (link) => `${link.slice_index}|${link.link_id}`);
const routedRoutes = routes.filter((route) => route.status === "routed");
const sampledRoutes = routedRoutes.filter((route) => sampled(route, sampleRate));

const hopRecords = [];
const reports = [];

sampledRoutes.forEach((route, routeIndex) => {
  const path = splitPath(route.path);
  const linkIds = splitPath(route.link_ids);
  const packetId = `TRAFFIC-INT-${String(route.slice_index).padStart(2, "0")}-${route.task_id}-${routeIndex}`;
  const packetHopRecords = [];

  path.forEach((nodeId, hopIndex) => {
    const node = nodesBySliceAndId.get(`${route.slice_index}|${nodeId}`) ?? {};
    const ingressLinkId = hopIndex > 0 ? linkIds[hopIndex - 1] ?? "" : "";
    const egressLinkId = hopIndex < linkIds.length ? linkIds[hopIndex] ?? "" : "";
    const observedLink = egressLinkId
      ? linksBySliceAndId.get(`${route.slice_index}|${egressLinkId}`) ?? {}
      : ingressLinkId
        ? linksBySliceAndId.get(`${route.slice_index}|${ingressLinkId}`) ?? {}
        : {};
    const totalLatencyMs = numberValue(observedLink.latency_ms);
    const queueLatencyMs = estimateQueueLatencyMs(observedLink);
    const record = {
      packet_id: packetId,
      probe_type: "traffic-int",
      task_id: route.task_id,
      slice_index: route.slice_index,
      time: route.time,
      hop_index: hopIndex,
      node_id: nodeId,
      role: roleForHop(path, hopIndex),
      previous_hop: hopIndex > 0 ? path[hopIndex - 1] : "",
      next_hop: hopIndex < path.length - 1 ? path[hopIndex + 1] : "",
      ingress_link_id: ingressLinkId,
      egress_link_id: egressLinkId,
      observed_node_mode: node.mode ?? "unknown",
      observed_cpu_percent: numberValue(node.cpu_percent),
      observed_queue_depth: numberValue(node.queue_depth),
      observed_queued_traffic_mb: numberValue(node.queued_traffic_mb),
      observed_cache_used_mb: numberValue(node.cache_used_mb),
      observed_energy_percent: numberValue(node.energy_percent),
      observed_can_accept_tasks: node.can_accept_tasks ?? "",
      observed_link_id: observedLink.link_id ?? "",
      observed_link_status: observedLink.status ?? "",
      observed_link_active: observedLink.is_active ?? "",
      observed_link_utilization_percent: numberValue(observedLink.utilization_percent),
      observed_link_latency_ms: totalLatencyMs,
      observed_link_queue_latency_ms: queueLatencyMs,
      observed_link_propagation_latency_ms: toFixedNumber(Math.max(totalLatencyMs - queueLatencyMs, 0), 4),
      observed_link_queue_latency_formula: observedLink.link_id ? "queued_traffic_mb*8*1000/effective_capacity_mbps" : "",
      observed_link_capacity_mbps: numberValue(observedLink.effective_capacity_mbps || observedLink.capacity_mbps),
      observed_link_congestion_percent: numberValue(observedLink.congestion_percent),
      observed_link_queued_mb: numberValue(observedLink.queued_traffic_mb),
      observed_link_dropped_mb: numberValue(observedLink.dropped_traffic_mb),
      observed_link_packet_error_rate: numberValue(observedLink.packet_error_rate),
      carried_traffic_mbps: numberValue(route.carried_traffic_mbps),
      demand_traffic_mbps: numberValue(route.traffic_mbps),
    };
    hopRecords.push(record);
    packetHopRecords.push(record);
  });

  const sinkNode = path[path.length - 1] ?? route.target ?? "";
  reports.push({
    report_id: `REPORT-${packetId}`,
    packet_id: packetId,
    task_id: route.task_id,
    slice_index: route.slice_index,
    time: route.time,
    sink_node: sinkNode,
    ground_station: "",
    record_count: packetHopRecords.length,
    report_size_bytes: reportHeaderBytes + packetHopRecords.length * hopMetadataBytes,
    status: "generated",
    drop_reason: "",
  });
});

const reconstructedNodes = uniqueBy(hopRecords, (record) => `${record.slice_index}|${record.node_id}`).map((record) => ({
  slice_index: record.slice_index,
  node_id: record.node_id,
  observed: true,
  last_observed_slice: record.slice_index,
  mode_estimate: record.observed_node_mode,
  cpu_percent_estimate: record.observed_cpu_percent,
  queue_depth_estimate: record.observed_queue_depth,
  queued_traffic_mb_estimate: record.observed_queued_traffic_mb,
  cache_used_mb_estimate: record.observed_cache_used_mb,
  energy_percent_estimate: record.observed_energy_percent,
  confidence: 1,
}));

const linkObservations = hopRecords.filter((record) => record.observed_link_id);
const reconstructedLinks = uniqueBy(linkObservations, (record) => `${record.slice_index}|${record.observed_link_id}`).map((record) => ({
  slice_index: record.slice_index,
  link_id: record.observed_link_id,
  observed: true,
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
  confidence: 1,
}));

const totalNodeSamples = nodes.length;
const totalActiveLinkSamples = links.filter((link) => boolValue(link.is_active)).length;
const observedNodeSamples = reconstructedNodes.length;
const observedActiveLinkSamples = reconstructedLinks.filter((link) => {
  const truth = linksBySliceAndId.get(`${link.slice_index}|${link.link_id}`);
  return truth ? boolValue(truth.is_active) : false;
}).length;
const pathLengths = sampledRoutes.map((route) => splitPath(route.path).length);
const reportBytes = reports.reduce((total, report) => total + numberValue(report.report_size_bytes), 0);
const totalMetadataBytes = hopRecords.length * hopMetadataBytes;
const carriedTrafficMbps = sampledRoutes.reduce((total, route) => total + numberValue(route.carried_traffic_mbps), 0);
const telemetryTxEnergyJ = (totalMetadataBytes + reportBytes) * telemetryTxNjPerByte * 1e-9;
const telemetryProcessingEnergyJ = hopRecords.length * hopProcessingJ + reports.length * reportProcessingJ;
const allSlices = [...new Set(nodes.map((node) => String(node.slice_index)))];
const overheadBySlice = buildOverheadBySlice({
  allSlices,
  hopRecords,
  reports,
  hopMetadataBytes,
  reportHeaderBytes,
  hopProcessingJ,
  reportProcessingJ,
  telemetryTxNjPerByte,
});
const linkOverhead = buildLinkOverhead({
  routes: sampledRoutes,
  hopMetadataBytes,
});
const nodeOverhead = buildNodeOverhead({
  nodes,
  hopRecords,
  reports,
  routes: sampledRoutes,
  hopMetadataBytes,
  hopProcessingJ,
  reportProcessingJ,
  telemetryTxNjPerByte,
});

const coverageReport = {
  schema_version: "stage2-int-coverage-report-v1",
  generated_at: new Date().toISOString(),
  source: {
    input_dir: inputDir,
    nodes_csv: nodesPath,
    links_csv: linksPath,
    routes_csv: routesPath,
  },
  mode: "traffic-int-mvp",
  black_box_boundary: {
    first_stage_runtime_modified: false,
    runtime_scope: "path-local observations only",
    unknown_policy: "unobserved nodes and links are not reconstructed",
  },
  sampling: {
    sample_rate: sampleRate,
    routed_routes: routedRoutes.length,
    sampled_routes: sampledRoutes.length,
    route_coverage: toFixedNumber(sampledRoutes.length / Math.max(routedRoutes.length, 1)),
  },
  coverage: {
    total_node_samples: totalNodeSamples,
    observed_node_samples: observedNodeSamples,
    node_sample_coverage: toFixedNumber(observedNodeSamples / Math.max(totalNodeSamples, 1)),
    total_active_link_samples: totalActiveLinkSamples,
    observed_active_link_samples: observedActiveLinkSamples,
    active_link_sample_coverage: toFixedNumber(observedActiveLinkSamples / Math.max(totalActiveLinkSamples, 1)),
  },
  path_balance_observation: {
    sampled_path_count: pathLengths.length,
    min_path_nodes: pathLengths.length ? Math.min(...pathLengths) : 0,
    max_path_nodes: pathLengths.length ? Math.max(...pathLengths) : 0,
    mean_path_nodes: toFixedNumber(mean(pathLengths)),
  },
  overhead: {
    hop_records: hopRecords.length,
    hop_metadata_bytes: hopMetadataBytes,
    total_metadata_bytes: totalMetadataBytes,
    reports: reports.length,
    report_header_bytes: reportHeaderBytes,
    total_report_bytes: reportBytes,
    total_int_bytes: totalMetadataBytes + reportBytes,
    total_telemetry_generated_bytes: totalMetadataBytes + reportBytes,
    link_overhead_rows: linkOverhead.length,
    node_overhead_rows: nodeOverhead.length,
    sampled_carried_traffic_mbps_sum: toFixedNumber(carriedTrafficMbps),
    telemetry_energy_model: "hop_processing_plus_report_processing_plus_tx_bytes",
    hop_processing_j: hopProcessingJ,
    report_processing_j: reportProcessingJ,
    telemetry_tx_nj_per_byte: telemetryTxNjPerByte,
    processing_energy_j: toFixedNumber(telemetryProcessingEnergyJ),
    tx_energy_j: toFixedNumber(telemetryTxEnergyJ),
    total_telemetry_energy_j: toFixedNumber(telemetryProcessingEnergyJ + telemetryTxEnergyJ),
    total_telemetry_energy_wh: toFixedNumber((telemetryProcessingEnergyJ + telemetryTxEnergyJ) / 3600, 8),
  },
};

await mkdir(outputDir, { recursive: true });
await Promise.all([
  writeFile(join(outputDir, "int-hop-records.csv"), rowsToCsv(hopRecords), "utf8"),
  writeFile(join(outputDir, "int-reports.csv"), rowsToCsv(reports), "utf8"),
  writeFile(join(outputDir, "reconstructed-nodes.csv"), rowsToCsv(reconstructedNodes), "utf8"),
  writeFile(join(outputDir, "reconstructed-links.csv"), rowsToCsv(reconstructedLinks), "utf8"),
  writeFile(join(outputDir, "traffic-int-overhead-by-slice.csv"), rowsToCsv(overheadBySlice), "utf8"),
  writeFile(join(outputDir, "traffic-int-link-overhead.csv"), rowsToCsv(linkOverhead), "utf8"),
  writeFile(join(outputDir, "traffic-int-node-overhead.csv"), rowsToCsv(nodeOverhead), "utf8"),
  writeFile(join(outputDir, "coverage-report.json"), JSON.stringify(coverageReport, null, 2), "utf8"),
]);

console.log(JSON.stringify({
  ok: true,
  outputDir,
  mode: "traffic-int-mvp",
  routedRoutes: routedRoutes.length,
  sampledRoutes: sampledRoutes.length,
  hopRecords: hopRecords.length,
  reports: reports.length,
  observedNodeSamples,
  observedActiveLinkSamples,
  nodeSampleCoverage: coverageReport.coverage.node_sample_coverage,
  activeLinkSampleCoverage: coverageReport.coverage.active_link_sample_coverage,
  overheadBySliceRows: overheadBySlice.length,
  linkOverheadRows: linkOverhead.length,
  nodeOverheadRows: nodeOverhead.length,
  totalIntBytes: coverageReport.overhead.total_int_bytes,
  totalTelemetryGeneratedBytes: coverageReport.overhead.total_telemetry_generated_bytes,
  totalTelemetryEnergyWh: coverageReport.overhead.total_telemetry_energy_wh,
}, null, 2));
