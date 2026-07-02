import { build } from "esbuild";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const entry = `
  import { walkerNetworkConfig } from "./src/config/walkerNetworkConfig.ts";
  import { generateWalkerNetwork } from "./src/simulation/walker.ts";
  import {
    businessLinkImpactRows,
    businessNodeImpactRows,
    experimentJson,
    linkSnapshotRows,
    networkMetricRows,
    nodeSnapshotRows,
    routeSnapshotRows,
    rowsToCsv,
    taskTraceRows,
  } from "./src/simulation/export.ts";
  import { effectiveTrafficTasks } from "./src/simulation/traffic.ts";

  const slices = generateWalkerNetwork(walkerNetworkConfig, {
    mode: "operational",
    tasks: [],
    trafficProfile: "normal",
    orbitModel: "tle-sgp4",
    routingAlgorithm: "shortest-path",
  });

  const taskRecords = effectiveTrafficTasks(walkerNetworkConfig, "normal", []);
  const context = {
    simulationMode: "operational",
    trafficProfile: "normal",
    orbitModel: "tle-sgp4",
    routingAlgorithm: "shortest-path",
    datasetName: "audit-normal",
    configSnapshot: walkerNetworkConfig,
    taskRecords,
  };

  export const payload = {
    slices,
    nodes: nodeSnapshotRows(slices),
    links: linkSnapshotRows(slices),
    routes: routeSnapshotRows(slices),
    metrics: networkMetricRows(slices),
    taskTrace: taskTraceRows(slices, taskRecords),
    linkImpact: businessLinkImpactRows(slices, taskRecords),
    nodeImpact: businessNodeImpactRows(slices, taskRecords),
    nodeCsv: rowsToCsv(nodeSnapshotRows(slices)),
    linkCsv: rowsToCsv(linkSnapshotRows(slices)),
    routeCsv: rowsToCsv(routeSnapshotRows(slices)),
    metricCsv: rowsToCsv(networkMetricRows(slices)),
    taskTraceCsv: rowsToCsv(taskTraceRows(slices, taskRecords)),
    linkImpactCsv: rowsToCsv(businessLinkImpactRows(slices, taskRecords)),
    nodeImpactCsv: rowsToCsv(businessNodeImpactRows(slices, taskRecords)),
    jsonText: experimentJson(context, slices),
  };
`;

const result = await build({
  stdin: {
    contents: entry,
    resolveDir: process.cwd(),
    sourcefile: "export-audit.ts",
    loader: "ts",
  },
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
  logLevel: "silent",
});

await mkdir(".tmp", { recursive: true });
const bundlePath = ".tmp/export-audit.mjs";
await writeFile(bundlePath, result.outputFiles[0].text, "utf8");
const { payload } = await import(`${pathToFileURL(bundlePath).href}?t=${Date.now()}`);
await rm(bundlePath, { force: true });

const parsedJson = JSON.parse(payload.jsonText);
let baseline = null;
try {
  baseline = JSON.parse(await readFile("reports/stage1/stage1-parameter-baseline.json", "utf8"));
} catch {
  baseline = null;
}
const expectedNodeRows = payload.slices.length * payload.slices[0].nodes.length;
const expectedLinkRows = payload.slices.length * payload.slices[0].links.length;
const expectedMetricRows = payload.slices.length;

const checks = [
  ["node export has every node in every time slice", payload.nodes.length === expectedNodeRows],
  ["link export has every candidate link in every time slice", payload.links.length === expectedLinkRows],
  ["route export contains routed traffic records", payload.routes.length > 0],
  ["metric export has one row per time slice", payload.metrics.length === expectedMetricRows],
  ["task trace export contains active business records", payload.taskTrace.length > 0],
  ["link impact export contains routed link impact records", payload.linkImpact.length > 0],
  ["node impact export contains route node impact records", payload.nodeImpact.length > 0],
  [
    "node csv includes resource columns",
    payload.nodeCsv.startsWith("slice_index,time,minute,node_id") &&
      payload.nodeCsv.includes("memory_used_gb") &&
      payload.nodeCsv.includes("compute_cpu_percent") &&
      payload.nodeCsv.includes("forwarding_cpu_percent") &&
      payload.nodeCsv.includes("network_compute_power_w"),
  ],
  ["link csv includes budget columns", payload.linkCsv.includes("sinr_db") && payload.linkCsv.includes("packet_error_rate")],
  ["route csv includes path columns", payload.routeCsv.includes("path") && payload.routeCsv.includes("link_ids")],
  ["metric csv includes workload columns", payload.metricCsv.includes("total_forwarding_mbps")],
  [
    "business trace csv includes causal columns",
    payload.taskTraceCsv.includes("bottleneck_link_id") &&
      payload.taskTraceCsv.includes("estimated_end_to_end_latency_ms") &&
      payload.taskTraceCsv.includes("delivery_state") &&
      payload.linkImpactCsv.includes("sinr_db") &&
      payload.nodeImpactCsv.includes("forwarding_cpu_percent"),
  ],
  [
    "json export includes metadata and full slices",
    parsedJson.metadata?.traffic_profile === "normal" && parsedJson.slices.length === payload.slices.length,
  ],
  [
    "metadata includes reproducibility fingerprints",
    parsedJson.metadata?.export_schema_version === "stage1-truth-v1" &&
      typeof parsedJson.metadata?.config_fingerprint === "string" &&
      parsedJson.metadata.config_fingerprint.length > 0 &&
      typeof parsedJson.metadata?.dataset_fingerprint === "string" &&
      parsedJson.metadata.dataset_fingerprint.length > 0 &&
      typeof parsedJson.metadata?.truth_fingerprint === "string" &&
      parsedJson.metadata.truth_fingerprint.length > 0,
  ],
  [
    "metadata config fingerprint matches parameter baseline when present",
    !baseline || parsedJson.metadata?.config_fingerprint === baseline.config_fingerprint,
  ],
  [
    "normal profile metadata includes generated scenario task input",
    parsedJson.metadata?.dataset_task_count === 24 &&
      parsedJson.metadata?.dataset_total_traffic_mbps > 0 &&
      parsedJson.metadata?.dataset_total_compute_units > 0,
  ],
];

const failures = checks.filter(([, passed]) => !passed).map(([name]) => name);

console.log(
  JSON.stringify(
    {
      counts: {
        slices: payload.slices.length,
        nodeRows: payload.nodes.length,
        linkRows: payload.links.length,
        routeRows: payload.routes.length,
        metricRows: payload.metrics.length,
        taskTraceRows: payload.taskTrace.length,
        linkImpactRows: payload.linkImpact.length,
        nodeImpactRows: payload.nodeImpact.length,
        jsonBytes: payload.jsonText.length,
      },
      checks: Object.fromEntries(checks),
    },
    null,
    2,
  ),
);

if (failures.length > 0) {
  console.error(`Export audit failed: ${failures.join(", ")}`);
  process.exitCode = 1;
}
