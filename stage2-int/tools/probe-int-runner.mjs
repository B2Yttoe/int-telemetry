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

function round(value, digits = 4) {
  return Number(value.toFixed(digits));
}

function estimateQueueLatencyMs(link) {
  const queuedMb = numberValue(link?.queued_traffic_mb, 0);
  const capacityMbps = numberValue(link?.effective_capacity_mbps || link?.capacity_mbps || link?.bandwidth_mbps, 0);
  if (queuedMb <= 0 || capacityMbps <= 0) return 0;
  return round((queuedMb * 8 * 1000) / capacityMbps);
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
      processing_energy_j: round(processingEnergyJ),
      tx_energy_j: round(txEnergyJ),
      total_telemetry_energy_j: round(processingEnergyJ + txEnergyJ),
      total_telemetry_energy_wh: round((processingEnergyJ + txEnergyJ) / 3600, 8),
    };
  });
}

function buildLinkOverhead({ probePaths, reports, reportingByProbeId, probePacketBaseBytes, hopMetadataBytes }) {
  const map = new Map();
  probePaths.forEach((probe) => {
    splitPath(probe.link_ids).forEach((linkId, index) => {
      addLinkLoad(map, {
        sliceIndex: probe.slice_index,
        time: probe.time,
        linkId,
        loadType: "probe",
        bytes: probePacketBaseBytes + (index + 1) * hopMetadataBytes,
      });
    });
  });
  reports.forEach((report) => {
    const reporting = reportingByProbeId.get(report.probe_id) ?? {};
    splitPath(reporting.reporting_link_ids).forEach((linkId) => {
      addLinkLoad(map, {
        sliceIndex: report.slice_index,
        time: report.time,
        linkId,
        loadType: "report",
        bytes: numberValue(report.report_size_bytes),
      });
    });
  });
  return [...map.values()]
    .map((row) => ({
      ...row,
      probe_forward_bytes: round(row.probe_forward_bytes),
      report_forward_bytes: round(row.report_forward_bytes),
      total_telemetry_link_bytes: round(row.total_telemetry_link_bytes),
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
  probePaths,
  reportingByProbeId,
  hopMetadataBytes,
  probePacketBaseBytes,
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
    if (record.observation_scope === "local-adjacent-link") row.adjacent_scan_records += 1;
    else row.path_hop_records += 1;
    if (record.role === "source") row.source_hop_records += 1;
    else if (record.role === "sink") row.sink_hop_records += 1;
    else if (record.role === "transit") row.transit_hop_records += 1;
    row.metadata_bytes_added += hopMetadataBytes;
    row.processing_energy_j += hopProcessingJ;
    row.telemetry_cpu_cost_units += 1;
  });

  probePaths.forEach((probe) => {
    const path = splitPath(probe.path);
    splitPath(probe.link_ids).forEach((linkId, index) => {
      if (!linkId) return;
      const nodeId = path[index];
      if (!nodeId) return;
      const row = ensure(probe.slice_index, nodeId, probe.time);
      row.probe_packet_tx_bytes += probePacketBaseBytes + (index + 1) * hopMetadataBytes;
    });
  });

  reports.forEach((report) => {
    const sinkRow = ensure(report.slice_index, report.sink_node, report.time);
    if (report.status === "generated") sinkRow.generated_reports += 1;
    else sinkRow.dropped_reports += 1;
    sinkRow.generated_report_bytes += numberValue(report.report_size_bytes);
    sinkRow.processing_energy_j += reportProcessingJ;
    sinkRow.telemetry_cpu_cost_units += 0.5;

    const reporting = reportingByProbeId.get(report.probe_id) ?? {};
    const reportingPath = splitPath(reporting.reporting_path);
    if (report.status === "generated") {
      reportingPath.slice(0, -1).forEach((nodeId) => {
        const row = ensure(report.slice_index, nodeId, report.time);
        row.report_forward_count += 1;
        row.report_forward_bytes += numberValue(report.report_size_bytes);
      });
      const downlinkNode = reporting.direct_linked_satellite || reportingPath[reportingPath.length - 1] || "";
      if (downlinkNode) {
        const row = ensure(report.slice_index, downlinkNode, report.time);
        row.sgl_downlink_report_bytes += numberValue(report.report_size_bytes);
      }
    }
  });

  return [...map.values()]
    .map((row) => {
      const txBytes = row.probe_packet_tx_bytes + row.report_forward_bytes + row.sgl_downlink_report_bytes;
      const txEnergy = txBytes * telemetryTxNjPerByte * 1e-9;
      const totalEnergy = row.processing_energy_j + txEnergy;
      const energyWh = numberValue(row.energy_wh);
      return {
        ...row,
        metadata_bytes_added: round(row.metadata_bytes_added),
        probe_packet_tx_bytes: round(row.probe_packet_tx_bytes),
        generated_report_bytes: round(row.generated_report_bytes),
        report_forward_bytes: round(row.report_forward_bytes),
        sgl_downlink_report_bytes: round(row.sgl_downlink_report_bytes),
        processing_energy_j: round(row.processing_energy_j),
        tx_energy_j: round(txEnergy),
        total_telemetry_energy_j: round(totalEnergy),
        total_telemetry_energy_wh: round(totalEnergy / 3600, 8),
        telemetry_energy_soc_percent: round(energyWh > 0 ? (totalEnergy / 3600 / energyWh) * 100 : 0, 8),
        telemetry_cpu_cost_units: round(row.telemetry_cpu_cost_units),
      };
    })
    .sort((left, right) =>
      Number(left.slice_index) - Number(right.slice_index) ||
      Number(right.total_telemetry_energy_j) - Number(left.total_telemetry_energy_j) ||
      left.node_id.localeCompare(right.node_id),
    );
}

function stableHash(text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

async function readCsv(path) {
  return parseCsv(await readFile(path, "utf8"));
}

function requireFile(path, label) {
  if (!existsSync(path)) throw new Error(`${label} not found: ${path}`);
}

const args = process.argv.slice(2);
const inputDir = resolve(argValue(args, "--input", "exports/tmp-highload-check"));
const stage2Dir = resolve(argValue(args, "--stage2", `stage2-int/outputs/${basename(inputDir)}`));
const outputDir = resolve(argValue(args, "--out", stage2Dir));
const algorithm = argValue(args, "--algorithm", "path-balance");
const linkObservationMode = argValue(args, "--link-observation-mode", "all-adjacent");
const hopMetadataBytes = numberValue(argValue(args, "--hop-bytes", "96"), 96);
const probePacketBaseBytes = numberValue(argValue(args, "--probe-packet-base-bytes", "64"), 64);
const reportHeaderBytes = numberValue(argValue(args, "--report-header-bytes", "128"), 128);
const hopProcessingJ = numberValue(argValue(args, "--hop-processing-j", "0.02"), 0.02);
const reportProcessingJ = numberValue(argValue(args, "--report-processing-j", "0.05"), 0.05);
const telemetryTxNjPerByte = numberValue(argValue(args, "--telemetry-tx-nj-per-byte", "120"), 120);
const lowEnergyScanThresholdPercent = numberValue(argValue(args, "--low-energy-scan-threshold-percent", "20"), 20);
const lowEnergyAdjacentScanRatio = Math.max(0, Math.min(1, numberValue(argValue(args, "--low-energy-adjacent-scan-ratio", "0.25"), 0.25)));

const nodesPath = resolve(argValue(args, "--nodes", join(inputDir, "nodes.csv")));
const linksPath = resolve(argValue(args, "--links", join(inputDir, "links.csv")));
const probePathsPath = resolve(argValue(args, "--probe-paths", join(stage2Dir, `probe-paths-${algorithm}.csv`)));
const reportingPathsPath = resolve(argValue(args, "--reporting-paths", join(stage2Dir, `reporting-paths-${algorithm}.csv`)));

requireFile(nodesPath, "nodes.csv");
requireFile(linksPath, "links.csv");
requireFile(probePathsPath, "probe paths");

const [nodes, links, probePaths, reportingPaths] = await Promise.all([
  readCsv(nodesPath),
  readCsv(linksPath),
  readCsv(probePathsPath),
  existsSync(reportingPathsPath) ? readCsv(reportingPathsPath) : Promise.resolve([]),
]);

const nodesBySliceAndId = indexBy(nodes, (node) => `${node.slice_index}|${node.node_id}`);
const linksBySliceAndId = indexBy(links, (link) => `${link.slice_index}|${link.link_id}`);
const linksBySliceAndEndpoint = groupBy(links, (link) => `${link.slice_index}|${link.source}`);
links.forEach((link) => {
  const key = `${link.slice_index}|${link.target}`;
  if (!linksBySliceAndEndpoint.has(key)) linksBySliceAndEndpoint.set(key, []);
  linksBySliceAndEndpoint.get(key).push(link);
});
const reportingByProbeId = indexBy(reportingPaths, (reportingPath) => reportingPath.probe_id);

const hopRecords = [];
const reports = [];
const scannedNodeKeys = new Set();
let lowEnergyScanLimitedNodes = 0;
let suppressedAdjacentLinkScans = 0;

function adjacentScanAllowed({ node, scannedNodeKey, adjacentIndex }) {
  const energy = numberValue(node.energy_percent, 100);
  const mode = String(node.mode || "");
  const constrained = energy <= lowEnergyScanThresholdPercent || mode === "power-saving" || mode === "offline";
  if (!constrained) return true;
  lowEnergyScanLimitedNodes += adjacentIndex === 0 ? 1 : 0;
  if (lowEnergyAdjacentScanRatio <= 0) return false;
  if (lowEnergyAdjacentScanRatio >= 1) return true;
  const bucket = stableHash(`${scannedNodeKey}|${adjacentIndex}`) / 0xffffffff;
  return bucket <= lowEnergyAdjacentScanRatio;
}

function buildRecord({
  packetId,
  probe,
  path,
  nodeId,
  hopIndex,
  ingressLinkId,
  egressLinkId,
  observedLink,
  observationScope,
  localPortPeer,
}) {
  const node = nodesBySliceAndId.get(`${probe.slice_index}|${nodeId}`) ?? {};
  const totalLatencyMs = numberValue(observedLink.latency_ms);
  const queueLatencyMs = estimateQueueLatencyMs(observedLink);
  return {
    packet_id: packetId,
    probe_id: probe.probe_id,
    probe_type: "probe-int",
    planning_algorithm: probe.planning_algorithm || algorithm,
    task_id: probe.probe_id,
    slice_index: probe.slice_index,
    time: probe.time,
    hop_index: hopIndex,
    node_id: nodeId,
    role: roleForHop(path, hopIndex),
    previous_hop: hopIndex > 0 ? path[hopIndex - 1] : "",
    next_hop: hopIndex < path.length - 1 ? path[hopIndex + 1] : "",
    ingress_link_id: ingressLinkId,
    egress_link_id: egressLinkId,
    observation_scope: observationScope,
    local_port_peer: localPortPeer,
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
    observed_link_propagation_latency_ms: round(Math.max(totalLatencyMs - queueLatencyMs, 0)),
    observed_link_queue_latency_formula: observedLink.link_id ? "queued_traffic_mb*8*1000/effective_capacity_mbps" : "",
    observed_link_capacity_mbps: numberValue(observedLink.effective_capacity_mbps || observedLink.capacity_mbps),
    observed_link_congestion_percent: numberValue(observedLink.congestion_percent),
    observed_link_queued_mb: numberValue(observedLink.queued_traffic_mb),
    observed_link_dropped_mb: numberValue(observedLink.dropped_traffic_mb),
    observed_link_packet_error_rate: numberValue(observedLink.packet_error_rate),
    carried_traffic_mbps: 0,
    demand_traffic_mbps: 0,
  };
}

probePaths.forEach((probe, probeIndex) => {
  const path = splitPath(probe.path);
  const linkIds = splitPath(probe.link_ids);
  const reporting = reportingByProbeId.get(probe.probe_id) ?? {};
  const reportingStatus = reporting.reporting_status || "unknown";
  const packetId = `PROBE-INT-${probe.probe_id || `${String(probe.slice_index).padStart(2, "0")}-${probeIndex}`}`;
  const packetHopRecords = [];

  path.forEach((nodeId, hopIndex) => {
    const ingressLinkId = hopIndex > 0 ? linkIds[hopIndex - 1] ?? "" : "";
    const egressLinkId = hopIndex < linkIds.length ? linkIds[hopIndex] ?? "" : "";
    const observedLink = egressLinkId
      ? linksBySliceAndId.get(`${probe.slice_index}|${egressLinkId}`) ?? {}
      : ingressLinkId
        ? linksBySliceAndId.get(`${probe.slice_index}|${ingressLinkId}`) ?? {}
        : {};

    const record = buildRecord({
      packetId,
      probe,
      path,
      nodeId,
      hopIndex,
      ingressLinkId,
      egressLinkId,
      observedLink,
      observationScope: "forwarding-hop",
      localPortPeer: "",
    });
    hopRecords.push(record);
    packetHopRecords.push(record);

    const scannedNodeKey = `${probe.slice_index}|${nodeId}`;
    if (linkObservationMode === "all-adjacent" && !scannedNodeKeys.has(scannedNodeKey)) {
      scannedNodeKeys.add(scannedNodeKey);
      const node = nodesBySliceAndId.get(`${probe.slice_index}|${nodeId}`) ?? {};
      const adjacentLinks = linksBySliceAndEndpoint.get(scannedNodeKey) ?? [];
      adjacentLinks.forEach((adjacentLink, adjacentIndex) => {
        if (!adjacentScanAllowed({ node, scannedNodeKey, adjacentIndex })) {
          suppressedAdjacentLinkScans += 1;
          return;
        }
        const peer = adjacentLink.source === nodeId ? adjacentLink.target : adjacentLink.source;
        const localRecord = buildRecord({
          packetId,
          probe,
          path,
          nodeId,
          hopIndex,
          ingressLinkId,
          egressLinkId,
          observedLink: adjacentLink,
          observationScope: "local-adjacent-link",
          localPortPeer: peer,
        });
        hopRecords.push(localRecord);
        packetHopRecords.push(localRecord);
      });
    }
  });

  const reportingBlocked = reportingStatus === "blocked";
  reports.push({
    report_id: `REPORT-${packetId}`,
    packet_id: packetId,
    task_id: probe.probe_id,
    probe_id: probe.probe_id,
    probe_type: "probe-int",
    planning_algorithm: probe.planning_algorithm || algorithm,
    slice_index: probe.slice_index,
    time: probe.time,
    sink_node: probe.sink || path[path.length - 1] || "",
    ground_station: "",
    direct_linked_satellite: reporting.direct_linked_satellite ?? "",
    reporting_status: reportingStatus,
    reporting_hops: reporting.reporting_hops ?? "",
    reporting_latency_ms: reporting.reporting_latency_ms ?? "",
    reporting_path: reporting.reporting_path ?? "",
    reporting_link_ids: reporting.reporting_link_ids ?? "",
    record_count: packetHopRecords.length,
    report_size_bytes: reportHeaderBytes + packetHopRecords.length * hopMetadataBytes,
    status: reportingBlocked ? "dropped" : "generated",
    drop_reason: reportingBlocked ? "no-reporting-path" : "",
  });
});

const observedNodes = uniqueBy(hopRecords, (record) => `${record.slice_index}|${record.node_id}`);
const observedLinks = uniqueBy(hopRecords.filter((record) => record.observed_link_id), (record) => `${record.slice_index}|${record.observed_link_id}`);
const activeTruthLinks = links.filter((link) => boolValue(link.is_active));
const activeTruthLinkKeys = new Set(activeTruthLinks.map((link) => `${link.slice_index}|${link.link_id}`));
const observedActiveLinks = observedLinks.filter((record) => activeTruthLinkKeys.has(`${record.slice_index}|${record.observed_link_id}`));
const pathNodeCounts = probePaths.map((probe) => numberValue(probe.path_node_count, splitPath(probe.path).length));
const totalReportBytes = reports.reduce((total, report) => total + numberValue(report.report_size_bytes), 0);
const totalMetadataBytes = hopRecords.length * hopMetadataBytes;
const totalProbePacketBaseBytes = probePaths.length * probePacketBaseBytes;
const totalTelemetryGeneratedBytes = totalMetadataBytes + totalReportBytes + totalProbePacketBaseBytes;
const telemetryTxEnergyJ = totalTelemetryGeneratedBytes * telemetryTxNjPerByte * 1e-9;
const telemetryProcessingEnergyJ = hopRecords.length * hopProcessingJ + reports.length * reportProcessingJ;
const allSlices = [...new Set(nodes.map((node) => String(node.slice_index)))];
const probeCountsBySlice = new Map(
  [...groupBy(probePaths, (probe) => String(probe.slice_index)).entries()].map(([sliceIndex, rows]) => [sliceIndex, rows.length]),
);
const overheadBySlice = buildOverheadBySlice({
  allSlices,
  hopRecords,
  reports,
  hopMetadataBytes,
  probePacketBaseBytes,
  probeCountsBySlice,
  reportHeaderBytes,
  hopProcessingJ,
  reportProcessingJ,
  telemetryTxNjPerByte,
});
const linkOverhead = buildLinkOverhead({
  probePaths,
  reports,
  reportingByProbeId,
  probePacketBaseBytes,
  hopMetadataBytes,
});
const nodeOverhead = buildNodeOverhead({
  nodes,
  hopRecords,
  reports,
  probePaths,
  reportingByProbeId,
  hopMetadataBytes,
  probePacketBaseBytes,
  hopProcessingJ,
  reportProcessingJ,
  telemetryTxNjPerByte,
});

const coverageReport = {
  schema_version: "stage2-probe-int-run-report-v1",
  generated_at: new Date().toISOString(),
  source: {
    input_dir: inputDir,
    stage2_dir: stage2Dir,
    nodes_csv: nodesPath,
    links_csv: linksPath,
    probe_paths_csv: probePathsPath,
    reporting_paths_csv: existsSync(reportingPathsPath) ? reportingPathsPath : "",
  },
  mode: "probe-int",
  black_box_boundary: {
    first_stage_runtime_modified: false,
    runtime_scope: "probe-path-local observations only",
    unknown_policy: "unobserved nodes and links are not reconstructed by this runner",
  },
  planning: {
    algorithm,
    link_observation_mode: linkObservationMode,
    telemetry_scan_policy: "low-energy-adjacent-scan-thinning",
    low_energy_scan_threshold_percent: lowEnergyScanThresholdPercent,
    low_energy_adjacent_scan_ratio: lowEnergyAdjacentScanRatio,
    low_energy_scan_limited_nodes: lowEnergyScanLimitedNodes,
    suppressed_adjacent_link_scans: suppressedAdjacentLinkScans,
    probe_paths: probePaths.length,
    reporting_paths_available: reportingPaths.length,
    planned_reporting_paths: reports.filter((report) => report.reporting_status === "planned").length,
    blocked_reporting_paths: reports.filter((report) => report.reporting_status === "blocked").length,
  },
  coverage: {
    total_node_samples: nodes.length,
    observed_node_samples: observedNodes.length,
    node_sample_coverage: round(observedNodes.length / Math.max(nodes.length, 1)),
    total_active_link_samples: activeTruthLinks.length,
    observed_active_link_samples: observedActiveLinks.length,
    active_link_sample_coverage: round(observedActiveLinks.length / Math.max(activeTruthLinks.length, 1)),
  },
  path_balance_observation: {
    probe_path_count: pathNodeCounts.length,
    min_path_nodes: pathNodeCounts.length ? Math.min(...pathNodeCounts) : 0,
    max_path_nodes: pathNodeCounts.length ? Math.max(...pathNodeCounts) : 0,
    mean_path_nodes: round(mean(pathNodeCounts)),
  },
  overhead: {
    hop_records: hopRecords.length,
    hop_metadata_bytes: hopMetadataBytes,
    total_metadata_bytes: totalMetadataBytes,
    probe_packet_base_bytes: probePacketBaseBytes,
    total_probe_packet_base_bytes: totalProbePacketBaseBytes,
    reports: reports.length,
    report_header_bytes: reportHeaderBytes,
    total_report_bytes: totalReportBytes,
    total_int_bytes: totalMetadataBytes + totalReportBytes,
    total_telemetry_generated_bytes: totalTelemetryGeneratedBytes,
    link_overhead_rows: linkOverhead.length,
    node_overhead_rows: nodeOverhead.length,
    telemetry_energy_model: "hop_processing_plus_report_processing_plus_tx_bytes",
    hop_processing_j: hopProcessingJ,
    report_processing_j: reportProcessingJ,
    telemetry_tx_nj_per_byte: telemetryTxNjPerByte,
    processing_energy_j: round(telemetryProcessingEnergyJ),
    tx_energy_j: round(telemetryTxEnergyJ),
    total_telemetry_energy_j: round(telemetryProcessingEnergyJ + telemetryTxEnergyJ),
    total_telemetry_energy_wh: round((telemetryProcessingEnergyJ + telemetryTxEnergyJ) / 3600, 8),
  },
};

await mkdir(outputDir, { recursive: true });
await Promise.all([
  writeFile(join(outputDir, `probe-int-hop-records-${algorithm}.csv`), rowsToCsv(hopRecords), "utf8"),
  writeFile(join(outputDir, `probe-int-reports-${algorithm}.csv`), rowsToCsv(reports), "utf8"),
  writeFile(join(outputDir, `probe-int-overhead-by-slice-${algorithm}.csv`), rowsToCsv(overheadBySlice), "utf8"),
  writeFile(join(outputDir, `probe-int-link-overhead-${algorithm}.csv`), rowsToCsv(linkOverhead), "utf8"),
  writeFile(join(outputDir, `probe-int-node-overhead-${algorithm}.csv`), rowsToCsv(nodeOverhead), "utf8"),
  writeFile(join(outputDir, `probe-int-run-report-${algorithm}.json`), JSON.stringify(coverageReport, null, 2), "utf8"),
]);

console.log(JSON.stringify({
  ok: true,
  outputDir,
  mode: "probe-int",
  algorithm,
  probePaths: probePaths.length,
  hopRecords: hopRecords.length,
  reports: reports.length,
  observedNodeSamples: observedNodes.length,
  observedActiveLinkSamples: observedActiveLinks.length,
  nodeSampleCoverage: coverageReport.coverage.node_sample_coverage,
  activeLinkSampleCoverage: coverageReport.coverage.active_link_sample_coverage,
  blockedReportingPaths: coverageReport.planning.blocked_reporting_paths,
  overheadBySliceRows: overheadBySlice.length,
  linkOverheadRows: linkOverhead.length,
  nodeOverheadRows: nodeOverhead.length,
  totalIntBytes: coverageReport.overhead.total_int_bytes,
  totalTelemetryGeneratedBytes: coverageReport.overhead.total_telemetry_generated_bytes,
  totalTelemetryEnergyWh: coverageReport.overhead.total_telemetry_energy_wh,
}, null, 2));
