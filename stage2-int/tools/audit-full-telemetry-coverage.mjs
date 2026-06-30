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

function groupBy(rows, keyFn) {
  const map = new Map();
  rows.forEach((row) => {
    const key = keyFn(row);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  });
  return map;
}

function boolValue(value) {
  return String(value).toLowerCase() === "true";
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
const groundDir = resolve(argValue(args, "--ground", `stage2-int/outputs/${basename(inputDir)}/ground-probe-path-balance`));
const outputDir = resolve(argValue(args, "--out", groundDir));

const truthNodesPath = resolve(argValue(args, "--truth-nodes", join(inputDir, "nodes.csv")));
const truthLinksPath = resolve(argValue(args, "--truth-links", join(inputDir, "links.csv")));
const reconstructedNodesPath = resolve(argValue(args, "--reconstructed-nodes", join(groundDir, "ground-reconstructed-nodes.csv")));
const reconstructedLinksPath = resolve(argValue(args, "--reconstructed-links", join(groundDir, "ground-reconstructed-links.csv")));

requireFile(truthNodesPath, "truth nodes.csv");
requireFile(truthLinksPath, "truth links.csv");
requireFile(reconstructedNodesPath, "ground-reconstructed-nodes.csv");
requireFile(reconstructedLinksPath, "ground-reconstructed-links.csv");

const [truthNodes, truthLinks, reconstructedNodes, reconstructedLinks] = await Promise.all([
  readCsv(truthNodesPath),
  readCsv(truthLinksPath),
  readCsv(reconstructedNodesPath),
  readCsv(reconstructedLinksPath),
]);

const truthNodesBySlice = groupBy(truthNodes, (node) => node.slice_index);
const truthLinksBySlice = groupBy(truthLinks, (link) => link.slice_index);
const reconstructedNodesBySlice = groupBy(reconstructedNodes, (node) => node.slice_index);
const reconstructedLinksBySlice = groupBy(reconstructedLinks, (link) => link.slice_index);
const sliceIndexes = [...new Set([...truthNodesBySlice.keys(), ...truthLinksBySlice.keys()])]
  .sort((a, b) => Number(a) - Number(b));

const slices = sliceIndexes.map((sliceIndex) => {
  const truthNodeSamples = truthNodesBySlice.get(sliceIndex) ?? [];
  const truthLinkSamples = truthLinksBySlice.get(sliceIndex) ?? [];
  const observedNodeSamples = (reconstructedNodesBySlice.get(sliceIndex) ?? []).filter((node) => boolValue(node.observed));
  const observedLinkSamples = (reconstructedLinksBySlice.get(sliceIndex) ?? []).filter((link) => boolValue(link.observed));
  const nodeCoverage = observedNodeSamples.length / Math.max(truthNodeSamples.length, 1);
  const linkCoverage = observedLinkSamples.length / Math.max(truthLinkSamples.length, 1);
  return {
    slice_index: sliceIndex,
    truth_node_samples: truthNodeSamples.length,
    observed_node_samples: observedNodeSamples.length,
    node_sample_coverage: round(nodeCoverage),
    missing_node_samples: Math.max(truthNodeSamples.length - observedNodeSamples.length, 0),
    truth_link_samples: truthLinkSamples.length,
    observed_link_samples: observedLinkSamples.length,
    link_sample_coverage: round(linkCoverage),
    missing_link_samples: Math.max(truthLinkSamples.length - observedLinkSamples.length, 0),
    pass: nodeCoverage === 1 && linkCoverage === 1,
  };
});

const failedSlices = slices.filter((slice) => !slice.pass);
const totalTruthNodes = truthNodes.length;
const totalTruthLinks = truthLinks.length;
const totalObservedNodes = reconstructedNodes.filter((node) => boolValue(node.observed)).length;
const totalObservedLinks = reconstructedLinks.filter((link) => boolValue(link.observed)).length;

const report = {
  schema_version: "stage2-full-telemetry-coverage-audit-v1",
  generated_at: new Date().toISOString(),
  source: {
    input_dir: inputDir,
    ground_dir: groundDir,
    truth_nodes_csv: truthNodesPath,
    truth_links_csv: truthLinksPath,
    reconstructed_nodes_csv: reconstructedNodesPath,
    reconstructed_links_csv: reconstructedLinksPath,
  },
  requirement: {
    every_time_step_node_state_observed: true,
    every_time_step_link_state_observed: true,
    full_link_state_scope: "all link rows exported by first-stage links.csv, including inactive links",
  },
  summary: {
    slices: slices.length,
    passed_slices: slices.length - failedSlices.length,
    failed_slices: failedSlices.length,
    total_truth_node_samples: totalTruthNodes,
    total_observed_node_samples: totalObservedNodes,
    node_sample_coverage: round(totalObservedNodes / Math.max(totalTruthNodes, 1)),
    total_truth_link_samples: totalTruthLinks,
    total_observed_link_samples: totalObservedLinks,
    link_sample_coverage: round(totalObservedLinks / Math.max(totalTruthLinks, 1)),
    pass: failedSlices.length === 0,
  },
  slices,
};

await mkdir(outputDir, { recursive: true });
await writeFile(join(outputDir, "full-telemetry-coverage-audit.json"), JSON.stringify(report, null, 2), "utf8");

console.log(JSON.stringify({
  ok: true,
  outputDir,
  slices: report.summary.slices,
  passedSlices: report.summary.passed_slices,
  failedSlices: report.summary.failed_slices,
  nodeSampleCoverage: report.summary.node_sample_coverage,
  linkSampleCoverage: report.summary.link_sample_coverage,
  pass: report.summary.pass,
}, null, 2));

if (!report.summary.pass) {
  process.exitCode = 1;
}
