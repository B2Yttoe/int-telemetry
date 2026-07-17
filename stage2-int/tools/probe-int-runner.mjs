import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { applyControlledReportingInterruptions } from "./reporting-interruption.mjs";
import { selectBudgetAdmittedProbeIds } from "./telemetry-byte-budget.mjs";

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

function effectiveHopMetadataBytesForProbe(probe, fallback) {
  const value = numberValue(probe?.effective_hop_metadata_bytes, NaN);
  if (Number.isFinite(value) && value > 0) return value;
  return fallback;
}

function mandatoryTargetsForProbe(probe) {
  const importanceNodes = new Set();
  const importanceLinks = new Set(splitPath(probe?.importance_adjacent_link_target_ids));
  splitPath(probe?.planning_importance_repair_target_ids).forEach((targetId) => {
    const separator = targetId.indexOf("|");
    if (separator <= 0) return;
    const type = targetId.slice(0, separator);
    const id = targetId.slice(separator + 1);
    if (!id) return;
    if (type === "node") importanceNodes.add(id);
    if (type === "link") importanceLinks.add(id);
  });
  return {
    nodes: new Set([
      ...splitPath(probe?.oam_feedback_mandatory_node_target_ids),
      ...splitPath(probe?.oam_control_mandatory_node_target_ids),
      ...importanceNodes,
    ]),
    links: new Set([
      ...splitPath(probe?.oam_feedback_mandatory_link_target_ids),
      ...splitPath(probe?.oam_control_mandatory_link_target_ids),
      ...importanceLinks,
    ]),
  };
}

function parseSelectiveMetadataPlan(probe, pathLength) {
  if (!boolValue(probe?.selective_metadata_enabled)) return [];
  try {
    const parsed = JSON.parse(String(probe?.selective_metadata_plan_json ?? "[]"));
    if (!Array.isArray(parsed) || parsed.length !== pathLength) return [];
    return parsed.map((item, hopIndex) => ({
      hop_index: hopIndex,
      profile: String(item?.profile ?? "forward-only"),
      node_fields_present: Array.isArray(item?.node_fields_present) ? item.node_fields_present.map(String) : [],
      link_fields_present: Array.isArray(item?.link_fields_present) ? item.link_fields_present.map(String) : [],
      metadata_bytes: Math.max(0, numberValue(item?.metadata_bytes)),
      writes_observation: item?.writes_observation === true ||
        (Array.isArray(item?.node_fields_present) && item.node_fields_present.length > 0) ||
        (Array.isArray(item?.link_fields_present) && item.link_fields_present.length > 0),
      reason: String(item?.reason ?? ""),
    }));
  } catch {
    return [];
  }
}

function maskedValue(enabled, fields, field, value, fallback = "") {
  if (!enabled) return value;
  return fields.has(field) ? value : fallback;
}

const SELECTIVE_LINK_LIGHT_FIELDS = Object.freeze([
  "link_id",
  "status",
  "is_active",
  "utilization_percent",
  "queue_latency_ms",
]);

const SELECTIVE_LINK_CORE_FIELDS = Object.freeze([
  "link_id",
  "status",
  "is_active",
  "utilization_percent",
  "latency_ms",
  "queue_latency_ms",
  "effective_capacity_mbps",
  "queued_traffic_mb",
  "dropped_traffic_mb",
  "congestion_percent",
  "packet_error_rate",
]);

function buildOverheadBySlice({
  allSlices = [],
  hopRecords,
  reports,
  probePaths = [],
  forwardingEvents = [],
  hopMetadataBytes,
  probePacketBaseBytes = 0,
  probeCountsBySlice = new Map(),
  reportHeaderBytes,
  hopProcessingJ,
  forwardOnlyProcessingJ,
  reportProcessingJ,
  telemetryTxNjPerByte,
}) {
  const hopsBySlice = groupBy(hopRecords, (record) => String(record.slice_index));
  const reportsBySlice = groupBy(reports, (report) => String(report.slice_index));
  const probesBySlice = groupBy(probePaths, (probe) => String(probe.slice_index));
  const forwardingBySlice = groupBy(forwardingEvents, (event) => String(event.slice_index));
  const sliceIndexes = [...new Set([...allSlices.map(String), ...hopsBySlice.keys(), ...reportsBySlice.keys()])];
  return sortedNumericKeys(new Map(sliceIndexes.map((sliceIndex) => [sliceIndex, true]))).map((sliceIndex) => {
    const hops = hopsBySlice.get(sliceIndex) ?? [];
    const sliceReports = reportsBySlice.get(sliceIndex) ?? [];
    const metadataBytes = hops.reduce((total, hop) => total + numberValue(hop.hop_metadata_bytes, hopMetadataBytes), 0);
    const reportBytes = sliceReports.reduce((total, report) => total + numberValue(report.report_size_bytes), 0);
    const baseBytes = (probeCountsBySlice.get(String(sliceIndex)) ?? 0) * probePacketBaseBytes;
    const targetMaskBytes = (probesBySlice.get(sliceIndex) ?? []).reduce(
      (total, probe) => total + Math.max(0, numberValue(probe.target_mask_bytes)),
      0,
    );
    const forwarding = forwardingBySlice.get(sliceIndex) ?? [];
    const forwardOnlyHops = forwarding.filter((event) => !event.writes_observation).length;
    const totalGeneratedBytes = metadataBytes + reportBytes + baseBytes + targetMaskBytes;
    const processingEnergyJ = hops.length * hopProcessingJ + forwardOnlyHops * forwardOnlyProcessingJ + sliceReports.length * reportProcessingJ;
    const txEnergyJ = totalGeneratedBytes * telemetryTxNjPerByte * 1e-9;
    return {
      slice_index: Number(sliceIndex),
      time: hops[0]?.time ?? sliceReports[0]?.time ?? "",
      hop_records: hops.length,
      reports: sliceReports.length,
      generated_reports: sliceReports.filter((report) => report.status === "generated").length,
      dropped_reports: sliceReports.filter((report) => report.status === "dropped").length,
      hop_metadata_bytes: hopMetadataBytes,
      mean_effective_hop_metadata_bytes: round(mean(hops.map((hop) => numberValue(hop.hop_metadata_bytes, hopMetadataBytes)))),
      probe_packet_base_bytes: probePacketBaseBytes,
      report_header_bytes: reportHeaderBytes,
      metadata_bytes: metadataBytes,
      report_bytes: reportBytes,
      total_probe_packet_base_bytes: baseBytes,
      target_mask_bytes: targetMaskBytes,
      metadata_writing_hops: hops.length,
      forward_only_hops: forwardOnlyHops,
      forwarding_hops: forwarding.length,
      total_int_bytes: metadataBytes + reportBytes + targetMaskBytes,
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
    const effectiveHopMetadataBytes = effectiveHopMetadataBytesForProbe(probe, hopMetadataBytes);
    const selectivePlan = parseSelectiveMetadataPlan(probe, splitPath(probe.path).length);
    const targetMaskBytes = selectivePlan ? Math.max(0, numberValue(probe.target_mask_bytes)) : 0;
    let cumulativeMetadataBytes = 0;
    splitPath(probe.link_ids).forEach((linkId, index) => {
      cumulativeMetadataBytes += selectivePlan
        ? Math.max(0, numberValue(selectivePlan[index]?.metadata_bytes))
        : effectiveHopMetadataBytes;
      addLinkLoad(map, {
        sliceIndex: probe.slice_index,
        time: probe.time,
        linkId,
        loadType: "probe",
        bytes: probePacketBaseBytes + targetMaskBytes + cumulativeMetadataBytes,
      });
    });
  });
  reports.forEach((report) => {
    if (String(report.status ?? "generated").toLowerCase() !== "generated") return;
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
  forwardingEvents = [],
  forwardOnlyProcessingJ = 0,
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
    const effectiveHopMetadataBytes = numberValue(record.hop_metadata_bytes, hopMetadataBytes);
    row.hop_records += 1;
    if (record.observation_scope === "local-adjacent-link") row.adjacent_scan_records += 1;
    else row.path_hop_records += 1;
    if (record.role === "source") row.source_hop_records += 1;
    else if (record.role === "sink") row.sink_hop_records += 1;
    else if (record.role === "transit") row.transit_hop_records += 1;
    row.metadata_bytes_added += effectiveHopMetadataBytes;
    row.processing_energy_j += hopProcessingJ;
    row.telemetry_cpu_cost_units += 1;
  });

  forwardingEvents.filter((event) => !event.writes_observation).forEach((event) => {
    const row = ensure(event.slice_index, event.node_id, event.time);
    row.path_hop_records += 1;
    if (event.role === "source") row.source_hop_records += 1;
    else if (event.role === "sink") row.sink_hop_records += 1;
    else if (event.role === "transit") row.transit_hop_records += 1;
    row.processing_energy_j += forwardOnlyProcessingJ;
    row.telemetry_cpu_cost_units += 0.1;
  });

  probePaths.forEach((probe) => {
    const path = splitPath(probe.path);
    const effectiveHopMetadataBytes = effectiveHopMetadataBytesForProbe(probe, hopMetadataBytes);
    const selectivePlan = parseSelectiveMetadataPlan(probe, path.length);
    const targetMaskBytes = selectivePlan ? Math.max(0, numberValue(probe.target_mask_bytes)) : 0;
    let cumulativeMetadataBytes = 0;
    splitPath(probe.link_ids).forEach((linkId, index) => {
      if (!linkId) return;
      const nodeId = path[index];
      if (!nodeId) return;
      const row = ensure(probe.slice_index, nodeId, probe.time);
      cumulativeMetadataBytes += selectivePlan
        ? Math.max(0, numberValue(selectivePlan[index]?.metadata_bytes))
        : effectiveHopMetadataBytes;
      row.probe_packet_tx_bytes += probePacketBaseBytes + targetMaskBytes + cumulativeMetadataBytes;
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
const forwardOnlyProcessingJ = numberValue(argValue(args, "--forward-only-processing-j", String(hopProcessingJ * 0.1)), hopProcessingJ * 0.1);
const reportProcessingJ = numberValue(argValue(args, "--report-processing-j", "0.05"), 0.05);
const telemetryTxNjPerByte = numberValue(argValue(args, "--telemetry-tx-nj-per-byte", "120"), 120);
const lowEnergyScanThresholdPercent = numberValue(argValue(args, "--low-energy-scan-threshold-percent", "20"), 20);
const lowEnergyAdjacentScanRatio = Math.max(0, Math.min(1, numberValue(argValue(args, "--low-energy-adjacent-scan-ratio", "0.25"), 0.25)));
const reportingInterruptionRate = Math.max(0, Math.min(1, numberValue(argValue(args, "--reporting-interruption-rate", "0"), 0)));
const reportingInterruptionSeed = argValue(args, "--reporting-interruption-seed", "reporting-interruption");
const invalidProbePolicy = argValue(args, "--invalid-probe-policy", "observe-down").toLowerCase();
const telemetryByteBudgetPerSlice = Math.max(0, numberValue(argValue(args, "--telemetry-byte-budget-per-slice", "0"), 0));
const telemetryByteBudgetPerNodeSlice = Math.max(0, numberValue(argValue(args, "--telemetry-byte-budget-per-node-slice", "0"), 0));
const telemetryByteBudgetPadToCap = argValue(args, "--telemetry-byte-budget-pad-to-cap", "false").toLowerCase() === "true";

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

let hopRecords = [];
let reports = [];
let forwardingEvents = [];
let invalidProbePaths = 0;
const scannedNodeKeys = new Set();
let lowEnergyScanLimitedNodes = 0;
let suppressedAdjacentLinkScans = 0;
let targetAwareSuppressedAdjacentScans = 0;

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
  effectiveHopMetadataBytes,
  effectiveLinkObservationMode,
  ingressLinkId,
  egressLinkId,
  observedLink,
  observationScope,
  localPortPeer,
  oamTargetRecord = false,
  oamTransitRecord = false,
  selectiveMetadataEnabled = false,
  selectiveMetadataProfile = "",
  nodeFieldsPresent = [],
  linkFieldsPresent = [],
}) {
  const node = nodesBySliceAndId.get(`${probe.slice_index}|${nodeId}`) ?? {};
  const totalLatencyMs = numberValue(observedLink.latency_ms);
  const queueLatencyMs = estimateQueueLatencyMs(observedLink);
  const nodeFieldSet = new Set(nodeFieldsPresent);
  const linkFieldSet = new Set(linkFieldsPresent);
  return {
    packet_id: packetId,
    probe_id: probe.probe_id,
    probe_type: "probe-int",
    planning_algorithm: probe.planning_algorithm || algorithm,
    task_id: probe.probe_id,
    slice_index: probe.slice_index,
    time: probe.time,
    hop_index: hopIndex,
    adaptive_metadata_profile: probe.adaptive_metadata_profile ?? "standard",
    adaptive_link_observation_mode: effectiveLinkObservationMode,
    hop_metadata_bytes: effectiveHopMetadataBytes,
    metadata_compression_ratio: probe.metadata_compression_ratio ?? "",
    selective_metadata_enabled: selectiveMetadataEnabled,
    selective_metadata_profile: selectiveMetadataProfile,
    node_fields_present: selectiveMetadataEnabled ? nodeFieldsPresent.join("|") : "legacy-all",
    link_fields_present: selectiveMetadataEnabled ? linkFieldsPresent.join("|") : "legacy-all",
    node_id: nodeId,
    role: roleForHop(path, hopIndex),
    previous_hop: hopIndex > 0 ? path[hopIndex - 1] : "",
    next_hop: hopIndex < path.length - 1 ? path[hopIndex + 1] : "",
    ingress_link_id: ingressLinkId,
    egress_link_id: egressLinkId,
    observation_scope: observationScope,
    local_port_peer: localPortPeer,
    oam_target_record: oamTargetRecord,
    oam_transit_record: oamTransitRecord,
    observed_node_mode: maskedValue(selectiveMetadataEnabled, nodeFieldSet, "mode", node.mode ?? "unknown"),
    observed_cpu_percent: maskedValue(selectiveMetadataEnabled, nodeFieldSet, "cpu_percent", numberValue(node.cpu_percent)),
    observed_queue_depth: maskedValue(selectiveMetadataEnabled, nodeFieldSet, "queue_depth", numberValue(node.queue_depth)),
    observed_queued_traffic_mb: maskedValue(selectiveMetadataEnabled, nodeFieldSet, "queued_traffic_mb", numberValue(node.queued_traffic_mb)),
    observed_cache_used_mb: maskedValue(selectiveMetadataEnabled, nodeFieldSet, "cache_used_mb", numberValue(node.cache_used_mb)),
    observed_energy_percent: maskedValue(selectiveMetadataEnabled, nodeFieldSet, "energy_percent", numberValue(node.energy_percent)),
    observed_can_accept_tasks: maskedValue(selectiveMetadataEnabled, nodeFieldSet, "can_accept_tasks", node.can_accept_tasks ?? ""),
    observed_link_id: maskedValue(selectiveMetadataEnabled, linkFieldSet, "link_id", observedLink.link_id ?? ""),
    observed_link_status: maskedValue(selectiveMetadataEnabled, linkFieldSet, "status", observedLink.status ?? ""),
    observed_link_active: maskedValue(selectiveMetadataEnabled, linkFieldSet, "is_active", observedLink.is_active ?? ""),
    observed_link_utilization_percent: maskedValue(selectiveMetadataEnabled, linkFieldSet, "utilization_percent", numberValue(observedLink.utilization_percent)),
    observed_link_latency_ms: maskedValue(selectiveMetadataEnabled, linkFieldSet, "latency_ms", totalLatencyMs),
    observed_link_queue_latency_ms: maskedValue(selectiveMetadataEnabled, linkFieldSet, "queue_latency_ms", queueLatencyMs),
    observed_link_propagation_latency_ms: maskedValue(
      selectiveMetadataEnabled,
      linkFieldSet,
      "latency_ms",
      round(Math.max(totalLatencyMs - queueLatencyMs, 0)),
    ),
    observed_link_queue_latency_formula: maskedValue(
      selectiveMetadataEnabled,
      linkFieldSet,
      "queue_latency_ms",
      observedLink.link_id ? "queued_traffic_mb*8*1000/effective_capacity_mbps" : "",
    ),
    observed_link_capacity_mbps: maskedValue(
      selectiveMetadataEnabled,
      linkFieldSet,
      "effective_capacity_mbps",
      numberValue(observedLink.effective_capacity_mbps || observedLink.capacity_mbps),
    ),
    observed_link_congestion_percent: maskedValue(selectiveMetadataEnabled, linkFieldSet, "congestion_percent", numberValue(observedLink.congestion_percent)),
    observed_link_queued_mb: maskedValue(selectiveMetadataEnabled, linkFieldSet, "queued_traffic_mb", numberValue(observedLink.queued_traffic_mb)),
    observed_link_dropped_mb: maskedValue(selectiveMetadataEnabled, linkFieldSet, "dropped_traffic_mb", numberValue(observedLink.dropped_traffic_mb)),
    observed_link_packet_error_rate: maskedValue(selectiveMetadataEnabled, linkFieldSet, "packet_error_rate", numberValue(observedLink.packet_error_rate)),
    carried_traffic_mbps: 0,
    demand_traffic_mbps: 0,
  };
}

probePaths.forEach((probe, probeIndex) => {
  const path = splitPath(probe.path);
  const linkIds = splitPath(probe.link_ids);
  const selectivePlan = parseSelectiveMetadataPlan(probe, path.length);
  const selectiveMetadataEnabled = selectivePlan.length === path.length && selectivePlan.length > 0;
  const targetMaskBytes = selectiveMetadataEnabled ? Math.max(0, numberValue(probe.target_mask_bytes)) : 0;
  const effectiveHopMetadataBytes = effectiveHopMetadataBytesForProbe(probe, hopMetadataBytes);
  const effectiveLinkObservationMode = probe.adaptive_link_observation_mode || linkObservationMode;
  const targetAware = probe.adaptive_metadata_profile === "oam-target-aware" || effectiveLinkObservationMode === "target-neighborhood";
  const mandatoryTargets = mandatoryTargetsForProbe(probe);
  const targetHopMetadataBytes = numberValue(probe.target_hop_metadata_bytes, hopMetadataBytes);
  const transitHopMetadataBytes = numberValue(probe.transit_hop_metadata_bytes, effectiveHopMetadataBytes);
  const reporting = reportingByProbeId.get(probe.probe_id) ?? {};
  const reportingStatus = reporting.reporting_status || "unknown";
  const packetId = `PROBE-INT-${probe.probe_id || `${String(probe.slice_index).padStart(2, "0")}-${probeIndex}`}`;
  const packetHopRecords = [];
  const invalidProbeLinkId = invalidProbePolicy === "drop"
    ? linkIds.find((linkId) => {
        const link = linksBySliceAndId.get(`${probe.slice_index}|${linkId}`);
        if (!link) return true;
        const status = String(link.status ?? "").toLowerCase();
        const active = String(link.is_active ?? "true").toLowerCase() !== "false";
        return status === "down" || !active;
      }) ?? ""
    : "";
  if (invalidProbeLinkId) {
    invalidProbePaths += 1;
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
      reporting_status: "probe-path-failed",
      reporting_hops: "",
      reporting_latency_ms: "",
      reporting_path: "",
      reporting_link_ids: "",
      record_count: 0,
      adaptive_metadata_profile: probe.adaptive_metadata_profile ?? "standard",
      adaptive_link_observation_mode: effectiveLinkObservationMode,
      hop_metadata_bytes: effectiveHopMetadataBytes,
      metadata_compression_ratio: probe.metadata_compression_ratio ?? "",
      selective_metadata_enabled: selectiveMetadataEnabled,
      target_mask_bytes: targetMaskBytes,
      report_size_bytes: 0,
      status: "dropped",
      drop_reason: `invalid-probe-path:${invalidProbeLinkId}`,
      invalid_probe_link_id: invalidProbeLinkId,
    });
    return;
  }

  path.forEach((nodeId, hopIndex) => {
    const ingressLinkId = hopIndex > 0 ? linkIds[hopIndex - 1] ?? "" : "";
    const egressLinkId = hopIndex < linkIds.length ? linkIds[hopIndex] ?? "" : "";
    const observedLink = egressLinkId
      ? linksBySliceAndId.get(`${probe.slice_index}|${egressLinkId}`) ?? {}
      : ingressLinkId
        ? linksBySliceAndId.get(`${probe.slice_index}|${ingressLinkId}`) ?? {}
        : {};
    const forwardingTargetRecord = targetAware && (
      mandatoryTargets.nodes.has(nodeId) ||
      mandatoryTargets.links.has(ingressLinkId) ||
      mandatoryTargets.links.has(egressLinkId)
    );
    const forwardingMetadataBytes = targetAware
      ? forwardingTargetRecord ? targetHopMetadataBytes : transitHopMetadataBytes
      : effectiveHopMetadataBytes;
    const selectiveDecision = selectiveMetadataEnabled ? selectivePlan[hopIndex] : null;
    forwardingEvents.push({
      probe_id: probe.probe_id,
      slice_index: probe.slice_index,
      time: probe.time,
      hop_index: hopIndex,
      node_id: nodeId,
      profile: selectiveDecision?.profile ?? "legacy-metadata",
      metadata_bytes: selectiveDecision?.metadata_bytes ?? forwardingMetadataBytes,
      writes_observation: selectiveDecision ? selectiveDecision.writes_observation : true,
      target_mask_bytes: targetMaskBytes,
    });
    if (selectiveDecision && !selectiveDecision.writes_observation) return;

    const record = buildRecord({
      packetId,
      probe,
      path,
      nodeId,
      hopIndex,
      effectiveHopMetadataBytes: selectiveDecision?.metadata_bytes ?? forwardingMetadataBytes,
      effectiveLinkObservationMode,
      ingressLinkId,
      egressLinkId,
      observedLink,
      observationScope: "forwarding-hop",
      localPortPeer: "",
      oamTargetRecord: forwardingTargetRecord,
      oamTransitRecord: targetAware && !forwardingTargetRecord,
      selectiveMetadataEnabled,
      selectiveMetadataProfile: selectiveDecision?.profile ?? "",
      nodeFieldsPresent: selectiveDecision?.node_fields_present ?? [],
      linkFieldsPresent: selectiveDecision?.link_fields_present ?? [],
    });
    hopRecords.push(record);
    packetHopRecords.push(record);

    const scannedNodeKey = `${probe.slice_index}|${nodeId}`;
    const adjacentLinks = linksBySliceAndEndpoint.get(scannedNodeKey) ?? [];
    const targetNeighborhoodNode = targetAware && mandatoryTargets.nodes.has(nodeId);
    const targetNeighborhoodLink = targetAware && adjacentLinks.some((link) => mandatoryTargets.links.has(link.link_id));
    const scansAdjacent = effectiveLinkObservationMode === "all-adjacent" || targetNeighborhoodNode || targetNeighborhoodLink;
    if (targetAware && effectiveLinkObservationMode === "target-neighborhood" && !scansAdjacent) {
      targetAwareSuppressedAdjacentScans += adjacentLinks.length;
    }
    if (scansAdjacent && !scannedNodeKeys.has(scannedNodeKey)) {
      scannedNodeKeys.add(scannedNodeKey);
      const node = nodesBySliceAndId.get(`${probe.slice_index}|${nodeId}`) ?? {};
      adjacentLinks.forEach((adjacentLink, adjacentIndex) => {
        const adjacentTargetRecord = targetAware && (
          targetNeighborhoodNode || mandatoryTargets.links.has(adjacentLink.link_id)
        );
        if (targetAware && effectiveLinkObservationMode === "target-neighborhood" && !adjacentTargetRecord) {
          targetAwareSuppressedAdjacentScans += 1;
          return;
        }
        if (!adjacentScanAllowed({ node, scannedNodeKey, adjacentIndex })) {
          suppressedAdjacentLinkScans += 1;
          return;
        }
        const peer = adjacentLink.source === nodeId ? adjacentLink.target : adjacentLink.source;
        const selectiveAdjacentProfile = String(probe.selective_adjacent_link_profile ?? "");
        const selectiveAdjacentLink = selectiveMetadataEnabled && ["link-light", "link-core"].includes(selectiveAdjacentProfile);
        const selectiveAdjacentLinkBytes = selectiveAdjacentProfile === "link-core" ? 48 : 20;
        const selectiveAdjacentLinkFields = selectiveAdjacentProfile === "link-core"
          ? SELECTIVE_LINK_CORE_FIELDS
          : SELECTIVE_LINK_LIGHT_FIELDS;
        const localRecord = buildRecord({
          packetId,
          probe,
          path,
          nodeId,
          hopIndex,
          effectiveHopMetadataBytes: selectiveAdjacentLink
            ? selectiveAdjacentLinkBytes
            : targetAware
              ? adjacentTargetRecord ? targetHopMetadataBytes : transitHopMetadataBytes
              : effectiveHopMetadataBytes,
          effectiveLinkObservationMode,
          ingressLinkId,
          egressLinkId,
          observedLink: adjacentLink,
          observationScope: "local-adjacent-link",
          localPortPeer: peer,
          oamTargetRecord: adjacentTargetRecord,
          oamTransitRecord: targetAware && !adjacentTargetRecord,
          selectiveMetadataEnabled: selectiveAdjacentLink,
          selectiveMetadataProfile: selectiveAdjacentLink ? `${selectiveAdjacentProfile}-adjacent` : "",
          nodeFieldsPresent: [],
          linkFieldsPresent: selectiveAdjacentLink ? selectiveAdjacentLinkFields : [],
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
    adaptive_metadata_profile: probe.adaptive_metadata_profile ?? "standard",
    adaptive_link_observation_mode: effectiveLinkObservationMode,
    hop_metadata_bytes: effectiveHopMetadataBytes,
    metadata_compression_ratio: probe.metadata_compression_ratio ?? "",
    selective_metadata_enabled: selectiveMetadataEnabled,
    target_mask_bytes: targetMaskBytes,
    report_size_bytes: reportHeaderBytes + packetHopRecords.reduce((total, record) => total + numberValue(record.hop_metadata_bytes, hopMetadataBytes), 0),
    status: reportingBlocked ? "dropped" : "generated",
    drop_reason: reportingBlocked ? "no-reporting-path" : "",
    invalid_probe_link_id: "",
  });
});

const nodeCountsBySlice = new Map(
  [...groupBy(nodes, (node) => String(node.slice_index)).entries()].map(([sliceIndex, rows]) => [
    Number(sliceIndex),
    new Set(rows.map((row) => row.node_id)).size,
  ]),
);
const plannedScaleBudgetBySlice = new Map();
for (const probe of probePaths) {
  if (String(probe.scale_budget_enabled ?? "").toLowerCase() !== "true") continue;
  const sliceIndex = numberValue(probe.slice_index, NaN);
  const plannedBudget = numberValue(probe.scale_budget_bytes, 0);
  if (!Number.isFinite(sliceIndex) || plannedBudget <= 0) continue;
  const current = plannedScaleBudgetBySlice.get(sliceIndex);
  plannedScaleBudgetBySlice.set(
    sliceIndex,
    current === undefined ? Math.floor(plannedBudget) : Math.min(current, Math.floor(plannedBudget)),
  );
}
const byteBudgetBySlice = telemetryByteBudgetPerSlice > 0
  ? new Map([...nodeCountsBySlice.keys()].map((sliceIndex) => [sliceIndex, telemetryByteBudgetPerSlice]))
  : telemetryByteBudgetPerNodeSlice > 0
    ? new Map([...nodeCountsBySlice.entries()].map(([sliceIndex, nodeCount]) => [
        sliceIndex,
        Math.floor(nodeCount * telemetryByteBudgetPerNodeSlice),
      ]))
    : plannedScaleBudgetBySlice.size > 0
      ? plannedScaleBudgetBySlice
      : 0;
const telemetryByteBudgetSource = telemetryByteBudgetPerSlice > 0
  ? "explicit-per-slice"
  : telemetryByteBudgetPerNodeSlice > 0
    ? "explicit-per-node-slice"
    : plannedScaleBudgetBySlice.size > 0
      ? "scale-adaptive-path-plan"
      : "disabled";
const byteBudget = selectBudgetAdmittedProbeIds({
  probes: probePaths,
  hopRecords,
  reports,
  probePacketBaseBytes,
  perSliceBudgetBytes: byteBudgetBySlice,
});
const executedProbePaths = byteBudget.enabled
  ? probePaths.filter((probe) => byteBudget.admittedProbeIds.has(String(probe.probe_id ?? "")))
  : probePaths;
if (byteBudget.enabled) {
  hopRecords = hopRecords.filter((record) => byteBudget.admittedProbeIds.has(String(record.probe_id ?? "")));
  reports = reports.filter((report) => byteBudget.admittedProbeIds.has(String(report.probe_id ?? "")));
  forwardingEvents = forwardingEvents.filter((event) => byteBudget.admittedProbeIds.has(String(event.probe_id ?? "")));
}
const byteBudgetRows = [...nodeCountsBySlice.entries()]
  .sort(([left], [right]) => left - right)
  .map(([sliceIndex, nodeCount]) => {
    const observed = byteBudget.bySlice.find((row) => row.slice_index === sliceIndex);
    const budgetBytes = byteBudget.enabled ? numberValue(byteBudgetBySlice.get(sliceIndex)) : 0;
    return observed ?? {
      slice_index: sliceIndex,
      node_count: nodeCount,
      budget_bytes: budgetBytes,
      actual_bytes: 0,
      admitted_probes: 0,
      rejected_probes: 0,
      budget_utilization: 0,
      budget_headroom_bytes: budgetBytes,
      cap_violation: false,
    };
  })
  .map((row) => ({ ...row, node_count: nodeCountsBySlice.get(row.slice_index) ?? 0 }));

let telemetryByteBudgetPaddingBytes = 0;
if (byteBudget.enabled && telemetryByteBudgetPadToCap) {
  for (const budgetRow of byteBudgetRows) {
    const headroom = Math.max(0, numberValue(budgetRow.budget_bytes) - numberValue(budgetRow.actual_bytes));
    if (headroom <= 0 || numberValue(budgetRow.admitted_probes) <= 0) {
      budgetRow.budget_padding_bytes = 0;
      continue;
    }
    let reportIndex = -1;
    for (let index = reports.length - 1; index >= 0; index -= 1) {
      const report = reports[index];
      if (numberValue(report.slice_index) !== numberValue(budgetRow.slice_index)) continue;
      if (String(report.status ?? "generated").toLowerCase() !== "generated") continue;
      if (numberValue(report.report_size_bytes) <= 0) continue;
      reportIndex = index;
      break;
    }
    if (reportIndex < 0) {
      budgetRow.budget_padding_bytes = 0;
      continue;
    }
    reports[reportIndex] = {
      ...reports[reportIndex],
      report_size_bytes: numberValue(reports[reportIndex].report_size_bytes) + headroom,
      budget_padding_bytes: numberValue(reports[reportIndex].budget_padding_bytes) + headroom,
    };
    budgetRow.actual_bytes = numberValue(budgetRow.actual_bytes) + headroom;
    budgetRow.budget_padding_bytes = headroom;
    budgetRow.budget_headroom_bytes = 0;
    budgetRow.budget_utilization = budgetRow.actual_bytes / Math.max(numberValue(budgetRow.budget_bytes), 1);
    telemetryByteBudgetPaddingBytes += headroom;
  }
}

const reportingInterruption = applyControlledReportingInterruptions(reports, {
  rate: reportingInterruptionRate,
  seed: reportingInterruptionSeed,
});
reports = reportingInterruption.reports;

const observedNodes = uniqueBy(
  hopRecords.filter((record) => !boolValue(record.selective_metadata_enabled) || String(record.node_fields_present ?? "").length > 0),
  (record) => `${record.slice_index}|${record.node_id}`,
);
const observedLinks = uniqueBy(hopRecords.filter((record) => record.observed_link_id), (record) => `${record.slice_index}|${record.observed_link_id}`);
const activeTruthLinks = links.filter((link) => boolValue(link.is_active));
const activeTruthLinkKeys = new Set(activeTruthLinks.map((link) => `${link.slice_index}|${link.link_id}`));
const observedActiveLinks = observedLinks.filter((record) => activeTruthLinkKeys.has(`${record.slice_index}|${record.observed_link_id}`));
const pathNodeCounts = executedProbePaths.map((probe) => numberValue(probe.path_node_count, splitPath(probe.path).length));
const totalReportBytes = reports.reduce((total, report) => total + numberValue(report.report_size_bytes), 0);
const totalMetadataBytes = hopRecords.reduce((total, record) => total + numberValue(record.hop_metadata_bytes, hopMetadataBytes), 0);
const totalProbePacketBaseBytes = executedProbePaths.length * probePacketBaseBytes;
const totalTargetMaskBytes = executedProbePaths.reduce((total, probe) => total + Math.max(0, numberValue(probe.target_mask_bytes)), 0);
const totalTelemetryGeneratedBytes = totalMetadataBytes + totalReportBytes + totalProbePacketBaseBytes + totalTargetMaskBytes;
const telemetryTxEnergyJ = totalTelemetryGeneratedBytes * telemetryTxNjPerByte * 1e-9;
const forwardOnlyHopCount = forwardingEvents.filter((event) => !event.writes_observation).length;
const telemetryProcessingEnergyJ = hopRecords.length * hopProcessingJ + forwardOnlyHopCount * forwardOnlyProcessingJ + reports.length * reportProcessingJ;
const allSlices = [...new Set(nodes.map((node) => String(node.slice_index)))];
const probeCountsBySlice = new Map(
  [...groupBy(executedProbePaths, (probe) => String(probe.slice_index)).entries()].map(([sliceIndex, rows]) => [sliceIndex, rows.length]),
);
const overheadBySlice = buildOverheadBySlice({
  allSlices,
  hopRecords,
  reports,
  probePaths: executedProbePaths,
  forwardingEvents,
  hopMetadataBytes,
  probePacketBaseBytes,
  probeCountsBySlice,
  reportHeaderBytes,
  hopProcessingJ,
  forwardOnlyProcessingJ,
  reportProcessingJ,
  telemetryTxNjPerByte,
});
const linkOverhead = buildLinkOverhead({
  probePaths: executedProbePaths,
  reports,
  reportingByProbeId,
  probePacketBaseBytes,
  hopMetadataBytes,
});
const nodeOverhead = buildNodeOverhead({
  nodes,
  hopRecords,
  reports,
  probePaths: executedProbePaths,
  reportingByProbeId,
  hopMetadataBytes,
  probePacketBaseBytes,
  hopProcessingJ,
  reportProcessingJ,
  telemetryTxNjPerByte,
  forwardingEvents,
  forwardOnlyProcessingJ,
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
    planned_probe_paths: probePaths.length,
    probe_paths: executedProbePaths.length,
    telemetry_byte_budget_enabled: byteBudget.enabled,
    telemetry_byte_budget_source: telemetryByteBudgetSource,
    scale_adaptive_path_plan_budget_slices: plannedScaleBudgetBySlice.size,
    telemetry_byte_budget_per_slice: telemetryByteBudgetPerSlice,
    telemetry_byte_budget_per_node_slice: telemetryByteBudgetPerNodeSlice,
    telemetry_byte_budget_pad_to_cap: telemetryByteBudgetPadToCap,
    telemetry_byte_budget_padding_bytes: telemetryByteBudgetPaddingBytes,
    telemetry_byte_budget_rejected_probe_paths: byteBudget.rejectedProbeIds.size,
    telemetry_byte_budget_cap_violations: byteBudget.capViolations,
    telemetry_byte_budget_actual_total_bytes: byteBudgetRows.reduce((total, row) => total + numberValue(row.actual_bytes), 0),
    telemetry_byte_budget_total_cap_bytes: byteBudgetRows.reduce((total, row) => total + numberValue(row.budget_bytes), 0),
    telemetry_byte_budget_by_slice: byteBudgetRows,
    path_only_probe_paths: executedProbePaths.filter((probe) => (probe.adaptive_link_observation_mode || linkObservationMode) === "path-only").length,
    all_adjacent_probe_paths: executedProbePaths.filter((probe) => (probe.adaptive_link_observation_mode || linkObservationMode) === "all-adjacent").length,
    target_aware_probe_paths: executedProbePaths.filter((probe) => probe.adaptive_metadata_profile === "oam-target-aware").length,
    target_neighborhood_probe_paths: executedProbePaths.filter((probe) => (probe.adaptive_link_observation_mode || linkObservationMode) === "target-neighborhood").length,
    target_aware_suppressed_adjacent_scans: targetAwareSuppressedAdjacentScans,
    reporting_paths_available: reportingPaths.length,
    planned_reporting_paths: reports.filter((report) => report.reporting_status === "planned").length,
    blocked_reporting_paths: reports.filter((report) => report.reporting_status === "blocked").length,
    controlled_reporting_interruption_rate: reportingInterruption.summary.requested_rate,
    controlled_reporting_interruption_seed: reportingInterruption.summary.seed,
    controlled_reporting_interruption_eligible_reports: reportingInterruption.summary.eligible_reports,
    controlled_reporting_interruptions: reportingInterruption.summary.interrupted_reports,
    controlled_reporting_interruption_achieved_rate: round(reportingInterruption.summary.achieved_rate),
    invalid_probe_policy: invalidProbePolicy,
    planned_invalid_probe_paths: invalidProbePaths,
    invalid_probe_paths: reports.filter((report) => report.reporting_status === "probe-path-failed").length,
    invalid_probe_path_ratio: round(reports.filter((report) => report.reporting_status === "probe-path-failed").length / Math.max(executedProbePaths.length, 1)),
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
    compact_metadata_hop_records: hopRecords.filter((record) => numberValue(record.hop_metadata_bytes, hopMetadataBytes) < hopMetadataBytes).length,
    target_metadata_hop_records: hopRecords.filter((record) => record.oam_target_record === true).length,
    transit_metadata_hop_records: hopRecords.filter((record) => record.oam_transit_record === true).length,
    target_neighborhood_adjacent_records: hopRecords.filter((record) =>
      record.adaptive_link_observation_mode === "target-neighborhood" && record.observation_scope === "local-adjacent-link"
    ).length,
    mean_effective_hop_metadata_bytes: round(mean(hopRecords.map((record) => numberValue(record.hop_metadata_bytes, hopMetadataBytes)))),
    metadata_bytes_saved_by_profile: round(hopRecords.reduce((total, record) =>
      total + Math.max(0, hopMetadataBytes - numberValue(record.hop_metadata_bytes, hopMetadataBytes)), 0)),
    target_aware_metadata_bytes_saved: round(hopRecords
      .filter((record) => record.adaptive_metadata_profile === "oam-target-aware")
      .reduce((total, record) => total + Math.max(0, hopMetadataBytes - numberValue(record.hop_metadata_bytes, hopMetadataBytes)), 0)),
    total_metadata_bytes: totalMetadataBytes,
    metadata_writing_hops: hopRecords.length,
    forward_only_hops: forwardingEvents.filter((event) => !event.writes_observation).length,
    forwarding_hops: forwardingEvents.length,
    total_target_mask_bytes: totalTargetMaskBytes,
    probe_packet_base_bytes: probePacketBaseBytes,
    total_probe_packet_base_bytes: totalProbePacketBaseBytes,
    reports: reports.length,
    report_header_bytes: reportHeaderBytes,
    total_report_bytes: totalReportBytes,
    total_int_bytes: totalMetadataBytes + totalReportBytes + totalTargetMaskBytes,
    total_telemetry_generated_bytes: totalTelemetryGeneratedBytes,
    link_overhead_rows: linkOverhead.length,
    node_overhead_rows: nodeOverhead.length,
    telemetry_energy_model: "hop_processing_plus_report_processing_plus_tx_bytes",
    hop_processing_j: hopProcessingJ,
    forward_only_processing_j: forwardOnlyProcessingJ,
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
  writeFile(join(outputDir, `probe-int-byte-budget-${algorithm}.csv`), rowsToCsv(byteBudget.decisions), "utf8"),
  writeFile(join(outputDir, `probe-int-admitted-paths-${algorithm}.csv`), rowsToCsv(executedProbePaths), "utf8"),
  writeFile(join(outputDir, `probe-int-run-report-${algorithm}.json`), JSON.stringify(coverageReport, null, 2), "utf8"),
]);

console.log(JSON.stringify({
  ok: true,
  outputDir,
  mode: "probe-int",
  algorithm,
  plannedProbePaths: probePaths.length,
  probePaths: executedProbePaths.length,
  budgetRejectedProbePaths: byteBudget.rejectedProbeIds.size,
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
