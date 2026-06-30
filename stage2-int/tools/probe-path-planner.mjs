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

function nodeSortKey(nodeId) {
  const match = /^P(\d+)-S(\d+)$/.exec(nodeId);
  if (!match) return nodeId;
  return `${match[1].padStart(4, "0")}-${match[2].padStart(4, "0")}`;
}

function edgeKey(a, b) {
  return [a, b].sort().join("|");
}

function mean(values) {
  if (values.length === 0) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function std(values) {
  if (values.length <= 1) return 0;
  const avg = mean(values);
  const variance = mean(values.map((value) => (value - avg) ** 2));
  return Math.sqrt(variance);
}

function round(value, digits = 3) {
  return Number(value.toFixed(digits));
}

async function readCsv(path) {
  return parseCsv(await readFile(path, "utf8"));
}

function requireFile(path, label) {
  if (!existsSync(path)) throw new Error(`${label} not found: ${path}`);
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

function buildAdjacency(edges) {
  const adjacency = new Map();
  edges.forEach((edge, index) => {
    if (!adjacency.has(edge.source)) adjacency.set(edge.source, []);
    if (!adjacency.has(edge.target)) adjacency.set(edge.target, []);
    adjacency.get(edge.source).push({ edgeIndex: index, next: edge.target });
    adjacency.get(edge.target).push({ edgeIndex: index, next: edge.source });
  });
  for (const list of adjacency.values()) {
    list.sort((a, b) => nodeSortKey(a.next).localeCompare(nodeSortKey(b.next)));
  }
  return adjacency;
}

function connectedEdgeComponents(edges) {
  const adjacency = buildAdjacency(edges);
  const visitedEdges = new Set();
  const components = [];

  edges.forEach((edge, startIndex) => {
    if (visitedEdges.has(startIndex)) return;
    const stack = [edge.source, edge.target];
    const componentEdgeIndexes = new Set();

    while (stack.length > 0) {
      const node = stack.pop();
      for (const item of adjacency.get(node) ?? []) {
        if (visitedEdges.has(item.edgeIndex)) continue;
        visitedEdges.add(item.edgeIndex);
        componentEdgeIndexes.add(item.edgeIndex);
        stack.push(item.next);
      }
    }

    components.push([...componentEdgeIndexes].map((edgeIndex) => edges[edgeIndex]));
  });

  return components;
}

function eulerDecompose(inputEdges, pairMode = "original") {
  if (inputEdges.length === 0) return [];
  const nodes = [...new Set(inputEdges.flatMap((edge) => [edge.source, edge.target]))].sort((a, b) =>
    nodeSortKey(a).localeCompare(nodeSortKey(b)),
  );
  const degree = new Map(nodes.map((node) => [node, 0]));
  inputEdges.forEach((edge) => {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  });

  const oddNodes = [...degree.entries()]
    .filter(([, value]) => value % 2 === 1)
    .map(([node]) => node)
    .sort((a, b) => nodeSortKey(a).localeCompare(nodeSortKey(b)));

  const dummyEdges = [];
  const remainingOdd = [...oddNodes];
  if (pairMode === "balance") {
    while (remainingOdd.length > 0) {
      const first = remainingOdd.shift();
      let bestIndex = 0;
      let bestScore = Number.POSITIVE_INFINITY;
      remainingOdd.forEach((candidate, index) => {
        const score = Math.abs(nodeSortKey(first).localeCompare(nodeSortKey(candidate)));
        if (score < bestScore) {
          bestScore = score;
          bestIndex = index;
        }
      });
      const second = remainingOdd.splice(bestIndex, 1)[0];
      dummyEdges.push({ id: `__dummy_${dummyEdges.length}`, source: first, target: second, dummy: true });
    }
  } else {
    while (remainingOdd.length > 0) {
      const first = remainingOdd.shift();
      const second = remainingOdd.shift();
      dummyEdges.push({ id: `__dummy_${dummyEdges.length}`, source: first, target: second, dummy: true });
    }
  }

  const edges = [
    ...inputEdges.map((edge) => ({ ...edge, dummy: false })),
    ...dummyEdges,
  ];
  const adjacency = buildAdjacency(edges);
  const used = new Array(edges.length).fill(false);
  const start = oddNodes[0] ?? nodes[0];
  const stack = [{ node: start, edgeIndex: -1 }];
  const circuit = [];

  while (stack.length > 0) {
    const top = stack[stack.length - 1];
    const list = adjacency.get(top.node) ?? [];
    while (list.length > 0 && used[list[list.length - 1].edgeIndex]) list.pop();
    if (list.length === 0) {
      circuit.push(stack.pop());
    } else {
      const item = list.pop();
      if (used[item.edgeIndex]) continue;
      used[item.edgeIndex] = true;
      stack.push({ node: item.next, edgeIndex: item.edgeIndex });
    }
  }

  const states = circuit.reverse();
  const paths = [];
  let currentNodes = states.length > 0 ? [states[0].node] : [];
  let currentEdges = [];

  for (let index = 1; index < states.length; index += 1) {
    const edge = edges[states[index].edgeIndex];
    if (!edge) continue;
    if (edge.dummy) {
      if (currentEdges.length > 0) {
        paths.push({ nodes: currentNodes, edgeIds: currentEdges });
      }
      currentNodes = [states[index].node];
      currentEdges = [];
    } else {
      currentEdges.push(edge.id);
      currentNodes.push(states[index].node);
    }
  }

  if (currentEdges.length > 0) {
    paths.push({ nodes: currentNodes, edgeIds: currentEdges });
  }

  return paths;
}

function buildNodePlaneMap(nodes) {
  const map = new Map();
  nodes.forEach((node) => map.set(node.node_id, numberValue(node.plane)));
  return map;
}

function rotateCircuit(circuit, touchNode) {
  if (circuit.nodes.length === 0) return circuit;
  const nodes = circuit.nodes[0] === circuit.nodes[circuit.nodes.length - 1]
    ? circuit.nodes.slice(0, -1)
    : [...circuit.nodes];
  const startIndex = Math.max(0, nodes.indexOf(touchNode));
  const rotatedNodes = [...nodes.slice(startIndex), ...nodes.slice(0, startIndex), nodes[startIndex]];
  const rotatedEdges = [...circuit.edgeIds.slice(startIndex), ...circuit.edgeIds.slice(0, startIndex)];
  return { ...circuit, nodes: rotatedNodes, edgeIds: rotatedEdges };
}

function spliceSegmentWithCircuit(circuit, segment) {
  const circuitNodeSet = new Set(circuit.nodes);
  const touchIndex = segment.nodes.findIndex((node) => circuitNodeSet.has(node));
  if (touchIndex === -1) return null;

  const touchNode = segment.nodes[touchIndex];
  const rotatedCircuit = rotateCircuit(circuit, touchNode);
  const beforeNodes = segment.nodes.slice(0, touchIndex + 1);
  const beforeEdges = segment.edgeIds.slice(0, touchIndex);
  const afterNodes = segment.nodes.slice(touchIndex + 1);
  const afterEdges = segment.edgeIds.slice(touchIndex);

  return {
    nodes: [...beforeNodes, ...rotatedCircuit.nodes.slice(1), ...afterNodes],
    edgeIds: [...beforeEdges, ...rotatedCircuit.edgeIds, ...afterEdges],
    source: segment.source,
    kind: "spliced",
  };
}

function edgeRowsToEdges(rows) {
  return rows.map((row) => ({
    id: row.link_id,
    source: row.source,
    target: row.target,
    kind: row.kind,
    row,
  }));
}

function makePathRows({ sliceIndex, time, algorithm, paths }) {
  return paths.map((path, index) => ({
    slice_index: sliceIndex,
    time,
    probe_id: `${algorithm}-${String(sliceIndex).padStart(2, "0")}-${String(index + 1).padStart(3, "0")}`,
    planning_algorithm: algorithm,
    source: path.nodes[0] ?? "",
    sink: path.nodes[path.nodes.length - 1] ?? "",
    path_node_count: path.nodes.length,
    path_link_count: path.edgeIds.length,
    covered_link_count: new Set(path.edgeIds).size,
    path: path.nodes.join(" > "),
    link_ids: path.edgeIds.join(" > "),
  }));
}

function planTopologyByDecomposition({ sliceIndex, time, nodes, links, algorithm }) {
  const activeEdges = edgeRowsToEdges(links.filter((link) => boolValue(link.is_active)));
  const intraEdges = activeEdges.filter((edge) => edge.kind === "intra-plane");
  const interEdges = activeEdges.filter((edge) => edge.kind === "inter-plane");
  const nodePlane = buildNodePlaneMap(nodes);

  const intraByPlane = groupBy(intraEdges, (edge) => nodePlane.get(edge.source) ?? -1);
  const circuits = [...intraByPlane.entries()]
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .flatMap(([plane, edges]) =>
      eulerDecompose(edges, "original").map((path) => ({
        ...path,
        plane: Number(plane),
        nodeSet: new Set(path.nodes),
      })),
    );

  const interSegments = connectedEdgeComponents(interEdges)
    .flatMap((componentEdges) => eulerDecompose(componentEdges, algorithm === "path-balance" ? "balance" : "original"))
    .map((path, index) => ({
      ...path,
      segment_id: `segment-${index + 1}`,
      nodeSet: new Set(path.nodes),
    }));

  const orderedSegments = algorithm === "path-balance"
    ? [...interSegments].sort((a, b) => a.edgeIds.length - b.edgeIds.length || a.segment_id.localeCompare(b.segment_id))
    : [...interSegments];

  const usedSegments = new Set();
  const paths = [];

  circuits.forEach((circuit) => {
    const segment = orderedSegments.find(
      (candidate) => !usedSegments.has(candidate.segment_id) && candidate.nodes.some((node) => circuit.nodeSet.has(node)),
    );
    if (!segment) {
      paths.push({ ...circuit, source: "intra-orbit-circuit" });
      return;
    }
    const spliced = spliceSegmentWithCircuit(circuit, segment);
    if (!spliced) {
      paths.push({ ...circuit, source: "intra-orbit-circuit" });
      return;
    }
    usedSegments.add(segment.segment_id);
    paths.push(spliced);
  });

  orderedSegments
    .filter((segment) => !usedSegments.has(segment.segment_id))
    .forEach((segment) => paths.push({ ...segment, source: "inter-orbit-segment", kind: "segment" }));

  const pathRows = makePathRows({ sliceIndex, time, algorithm, paths });
  const coveredLinks = new Set(pathRows.flatMap((row) => row.link_ids ? row.link_ids.split(" > ") : []));
  const duplicateProbeLinkCount = pathRows.reduce((total, row) => total + numberValue(row.path_link_count), 0) - coveredLinks.size;
  return {
    sliceIndex,
    time,
    algorithm,
    activeLinkCount: activeEdges.length,
    activeIntraLinkCount: intraEdges.length,
    activeInterLinkCount: interEdges.length,
    circuitCount: circuits.length,
    segmentCount: interSegments.length,
    probeCount: pathRows.length,
    coveredLinkCount: coveredLinks.size,
    duplicateProbeLinkCount,
    pathRows,
  };
}

function summarizeAlgorithm({ algorithm, sliceResults }) {
  const pathRows = sliceResults.flatMap((result) => result.pathRows);
  const pathLengths = pathRows.map((row) => numberValue(row.path_link_count));
  const activeLinkSamples = sliceResults.reduce((total, result) => total + result.activeLinkCount, 0);
  const coveredLinkSamples = sliceResults.reduce((total, result) => total + result.coveredLinkCount, 0);
  return {
    schema_version: "stage2-probe-path-summary-v1",
    generated_at: new Date().toISOString(),
    planning_algorithm: algorithm,
    slice_count: sliceResults.length,
    active_link_samples: activeLinkSamples,
    covered_link_samples: coveredLinkSamples,
    link_coverage: round(coveredLinkSamples / Math.max(activeLinkSamples, 1)),
    probe_count: pathRows.length,
    min_path_length: pathLengths.length ? Math.min(...pathLengths) : 0,
    max_path_length: pathLengths.length ? Math.max(...pathLengths) : 0,
    mean_path_length: round(mean(pathLengths)),
    path_length_std: round(std(pathLengths)),
    duplicate_probe_link_count: sliceResults.reduce((total, result) => total + result.duplicateProbeLinkCount, 0),
    per_slice: sliceResults.map((result) => ({
      slice_index: result.sliceIndex,
      active_links: result.activeLinkCount,
      active_intra_links: result.activeIntraLinkCount,
      active_inter_links: result.activeInterLinkCount,
      circuits: result.circuitCount,
      inter_segments: result.segmentCount,
      probes: result.probeCount,
      covered_links: result.coveredLinkCount,
      duplicate_probe_links: result.duplicateProbeLinkCount,
    })),
  };
}

const args = process.argv.slice(2);
const inputDir = resolve(argValue(args, "--input", "exports/tmp-highload-check"));
const outputDir = resolve(argValue(args, "--out", `stage2-int/outputs/${basename(inputDir)}`));
const nodesPath = resolve(argValue(args, "--nodes", join(inputDir, "nodes.csv")));
const linksPath = resolve(argValue(args, "--links", join(inputDir, "links.csv")));
const algorithmArg = argValue(args, "--algorithm", "both");
const sliceArg = argValue(args, "--slice", "all");
const algorithms = algorithmArg === "both" ? ["path-original", "path-balance"] : [algorithmArg];

requireFile(nodesPath, "nodes.csv");
requireFile(linksPath, "links.csv");

const [nodes, links] = await Promise.all([readCsv(nodesPath), readCsv(linksPath)]);
const nodesBySlice = groupBy(nodes, (node) => node.slice_index);
const linksBySlice = groupBy(links, (link) => link.slice_index);
const sliceIndexes = [...linksBySlice.keys()]
  .filter((sliceIndex) => sliceArg === "all" || String(sliceIndex) === String(sliceArg))
  .sort((a, b) => Number(a) - Number(b));

await mkdir(outputDir, { recursive: true });

const output = {};
for (const algorithm of algorithms) {
  if (!["path-original", "path-balance"].includes(algorithm)) {
    throw new Error(`Unknown --algorithm ${algorithm}`);
  }

  const sliceResults = sliceIndexes.map((sliceIndex) => {
    const sliceNodes = nodesBySlice.get(sliceIndex) ?? [];
    const sliceLinks = linksBySlice.get(sliceIndex) ?? [];
    const time = sliceLinks[0]?.time ?? sliceNodes[0]?.time ?? "";
    return planTopologyByDecomposition({
      sliceIndex,
      time,
      nodes: sliceNodes,
      links: sliceLinks,
      algorithm,
    });
  });

  const pathRows = sliceResults.flatMap((result) => result.pathRows);
  const summary = summarizeAlgorithm({ algorithm, sliceResults });
  const summaryRows = summary.per_slice.map((row) => ({ planning_algorithm: algorithm, ...row }));

  await Promise.all([
    writeFile(join(outputDir, `probe-paths-${algorithm}.csv`), rowsToCsv(pathRows), "utf8"),
    writeFile(join(outputDir, `probe-summary-${algorithm}.csv`), rowsToCsv(summaryRows), "utf8"),
    writeFile(join(outputDir, `probe-coverage-${algorithm}.json`), JSON.stringify(summary, null, 2), "utf8"),
  ]);

  output[algorithm] = {
    probeCount: summary.probe_count,
    linkCoverage: summary.link_coverage,
    maxPathLength: summary.max_path_length,
    pathLengthStd: summary.path_length_std,
    duplicateProbeLinkCount: summary.duplicate_probe_link_count,
  };
}

console.log(JSON.stringify({
  ok: true,
  inputDir,
  outputDir,
  slices: sliceIndexes.length,
  algorithms: output,
}, null, 2));

