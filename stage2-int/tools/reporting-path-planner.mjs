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

function boolValue(value) {
  return String(value).toLowerCase() === "true";
}

function numberValue(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function splitPath(value) {
  if (!value) return [];
  return value.split(" > ").map((item) => item.trim()).filter(Boolean);
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

function requireFile(path, label) {
  if (!existsSync(path)) throw new Error(`${label} not found: ${path}`);
}

async function readCsv(path) {
  return parseCsv(await readFile(path, "utf8"));
}

function buildGraph(links) {
  const graph = new Map();
  links.filter((link) => boolValue(link.is_active)).forEach((link) => {
    const latency = numberValue(link.latency_ms, numberValue(link.distance_km, 1));
    if (!graph.has(link.source)) graph.set(link.source, []);
    if (!graph.has(link.target)) graph.set(link.target, []);
    graph.get(link.source).push({ next: link.target, link_id: link.link_id, latency });
    graph.get(link.target).push({ next: link.source, link_id: link.link_id, latency });
  });
  return graph;
}

function dijkstraToAny(graph, source, targets) {
  if (targets.has(source)) {
    return { target: source, path: [source], linkIds: [], latencyMs: 0 };
  }

  const distances = new Map([[source, 0]]);
  const previous = new Map();
  const visited = new Set();

  while (true) {
    let current = "";
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const [node, distance] of distances.entries()) {
      if (!visited.has(node) && distance < bestDistance) {
        current = node;
        bestDistance = distance;
      }
    }
    if (!current) break;
    if (targets.has(current)) {
      const path = [current];
      const linkIds = [];
      let cursor = current;
      while (previous.has(cursor)) {
        const prev = previous.get(cursor);
        path.unshift(prev.node);
        linkIds.unshift(prev.link_id);
        cursor = prev.node;
      }
      return { target: current, path, linkIds, latencyMs: bestDistance };
    }
    visited.add(current);

    for (const edge of graph.get(current) ?? []) {
      if (visited.has(edge.next)) continue;
      const nextDistance = bestDistance + edge.latency;
      if (nextDistance < (distances.get(edge.next) ?? Number.POSITIVE_INFINITY)) {
        distances.set(edge.next, nextDistance);
        previous.set(edge.next, { node: current, link_id: edge.link_id });
      }
    }
  }

  return null;
}

function round(value, digits = 3) {
  return Number(value.toFixed(digits));
}

function mean(values) {
  if (values.length === 0) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

const args = process.argv.slice(2);
const inputDir = resolve(argValue(args, "--input", "exports/tmp-highload-check"));
const stage2Dir = resolve(argValue(args, "--stage2", `stage2-int/outputs/${basename(inputDir)}`));
const outputDir = resolve(argValue(args, "--out", stage2Dir));
const nodesPath = resolve(argValue(args, "--nodes", join(inputDir, "nodes.csv")));
const linksPath = resolve(argValue(args, "--links", join(inputDir, "links.csv")));
const probePathsPath = resolve(argValue(args, "--probes", join(stage2Dir, "probe-paths-path-balance.csv")));
const algorithm = argValue(args, "--algorithm", "path-balance");

requireFile(nodesPath, "nodes.csv");
requireFile(linksPath, "links.csv");
requireFile(probePathsPath, "probe paths csv");

const [nodes, links, probes] = await Promise.all([
  readCsv(nodesPath),
  readCsv(linksPath),
  readCsv(probePathsPath),
]);

const nodesBySlice = groupBy(nodes, (node) => node.slice_index);
const linksBySlice = groupBy(links, (link) => link.slice_index);
const probesBySlice = groupBy(probes, (probe) => probe.slice_index);

const reportingRows = [];
const sliceSummaries = [];

for (const [sliceIndex, sliceProbes] of probesBySlice.entries()) {
  const sliceNodes = nodesBySlice.get(sliceIndex) ?? [];
  const sliceLinks = linksBySlice.get(sliceIndex) ?? [];
  const graph = buildGraph(sliceLinks);
  const directLinkedSatellites = new Set(
    sliceNodes
      .filter((node) => numberValue(node.active_sgl_links) > 0)
      .map((node) => node.node_id),
  );

  let delivered = 0;
  let blocked = 0;
  const pathHops = [];
  const latencies = [];

  sliceProbes.forEach((probe) => {
    const sink = probe.sink;
    const result = directLinkedSatellites.size > 0 ? dijkstraToAny(graph, sink, directLinkedSatellites) : null;
    const status = result ? "planned" : "blocked";
    if (result) {
      delivered += 1;
      pathHops.push(result.linkIds.length);
      latencies.push(result.latencyMs);
    } else {
      blocked += 1;
    }
    reportingRows.push({
      slice_index: sliceIndex,
      time: probe.time,
      probe_id: probe.probe_id,
      planning_algorithm: algorithm,
      sink_node: sink,
      direct_linked_satellite: result?.target ?? "",
      reporting_status: status,
      reporting_hops: result?.linkIds.length ?? 0,
      reporting_latency_ms: result ? round(result.latencyMs) : 0,
      reporting_path: result?.path.join(" > ") ?? "",
      reporting_link_ids: result?.linkIds.join(" > ") ?? "",
      direct_linked_candidates: directLinkedSatellites.size,
    });
  });

  sliceSummaries.push({
    slice_index: sliceIndex,
    planning_algorithm: algorithm,
    probes: sliceProbes.length,
    direct_linked_candidates: directLinkedSatellites.size,
    planned_reporting_paths: delivered,
    blocked_reporting_paths: blocked,
    mean_reporting_hops: round(mean(pathHops)),
    max_reporting_hops: pathHops.length ? Math.max(...pathHops) : 0,
    mean_reporting_latency_ms: round(mean(latencies)),
    max_reporting_latency_ms: latencies.length ? round(Math.max(...latencies)) : 0,
  });
}

const allHops = reportingRows.filter((row) => row.reporting_status === "planned").map((row) => numberValue(row.reporting_hops));
const allLatencies = reportingRows.filter((row) => row.reporting_status === "planned").map((row) => numberValue(row.reporting_latency_ms));
const report = {
  schema_version: "stage2-reporting-path-summary-v1",
  generated_at: new Date().toISOString(),
  source: {
    input_dir: inputDir,
    probe_paths_csv: probePathsPath,
    nodes_csv: nodesPath,
    links_csv: linksPath,
  },
  planning_algorithm: algorithm,
  direct_linked_satellite_policy: "active_sgl_links > 0",
  path_algorithm: "dijkstra",
  probes: reportingRows.length,
  planned_reporting_paths: reportingRows.filter((row) => row.reporting_status === "planned").length,
  blocked_reporting_paths: reportingRows.filter((row) => row.reporting_status === "blocked").length,
  mean_reporting_hops: round(mean(allHops)),
  max_reporting_hops: allHops.length ? Math.max(...allHops) : 0,
  mean_reporting_latency_ms: round(mean(allLatencies)),
  max_reporting_latency_ms: allLatencies.length ? round(Math.max(...allLatencies)) : 0,
  per_slice: sliceSummaries,
};

await mkdir(outputDir, { recursive: true });
await Promise.all([
  writeFile(join(outputDir, `reporting-paths-${algorithm}.csv`), rowsToCsv(reportingRows), "utf8"),
  writeFile(join(outputDir, `reporting-summary-${algorithm}.csv`), rowsToCsv(sliceSummaries), "utf8"),
  writeFile(join(outputDir, `reporting-coverage-${algorithm}.json`), JSON.stringify(report, null, 2), "utf8"),
]);

console.log(JSON.stringify({
  ok: true,
  outputDir,
  algorithm,
  probes: report.probes,
  plannedReportingPaths: report.planned_reporting_paths,
  blockedReportingPaths: report.blocked_reporting_paths,
  meanReportingHops: report.mean_reporting_hops,
  maxReportingHops: report.max_reporting_hops,
}, null, 2));

