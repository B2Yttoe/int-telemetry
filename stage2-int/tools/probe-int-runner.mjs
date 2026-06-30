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
const reportHeaderBytes = numberValue(argValue(args, "--report-header-bytes", "128"), 128);

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
    observed_link_latency_ms: numberValue(observedLink.latency_ms),
    observed_link_capacity_mbps: numberValue(observedLink.effective_capacity_mbps || observedLink.capacity_mbps),
    observed_link_congestion_percent: numberValue(observedLink.congestion_percent),
    observed_link_queued_mb: numberValue(observedLink.queued_traffic_mb),
    observed_link_dropped_mb: numberValue(observedLink.dropped_traffic_mb),
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
      const adjacentLinks = linksBySliceAndEndpoint.get(scannedNodeKey) ?? [];
      adjacentLinks.forEach((adjacentLink) => {
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
    reports: reports.length,
    report_header_bytes: reportHeaderBytes,
    total_report_bytes: totalReportBytes,
  },
};

await mkdir(outputDir, { recursive: true });
await Promise.all([
  writeFile(join(outputDir, `probe-int-hop-records-${algorithm}.csv`), rowsToCsv(hopRecords), "utf8"),
  writeFile(join(outputDir, `probe-int-reports-${algorithm}.csv`), rowsToCsv(reports), "utf8"),
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
}, null, 2));
