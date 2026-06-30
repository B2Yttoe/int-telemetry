import { build } from "esbuild";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";

function argValue(args, name, fallback = "") {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  return args[index + 1] ?? fallback;
}

const args = process.argv.slice(2);
const reportDir = argValue(args, "--report-dir", "reports/stage1");
const tasksPath = argValue(args, "--tasks", "examples/datasets/stage1-standard-traffic.csv");
const traceJsonPath = `${reportDir}/stage1-business-trace.json`;
const taskTraceCsvPath = `${reportDir}/stage1-business-task-trace.csv`;
const linkImpactCsvPath = `${reportDir}/stage1-business-link-impact.csv`;
const nodeImpactCsvPath = `${reportDir}/stage1-business-node-impact.csv`;

const entry = `
  import { walkerNetworkConfig } from "./src/config/walkerNetworkConfig.ts";
  import { generateWalkerNetwork } from "./src/simulation/walker.ts";
  import {
    businessLinkImpactRows,
    businessNodeImpactRows,
    experimentMetadata,
    rowsToCsv,
    taskTraceRows as createTaskTraceRows,
  } from "./src/simulation/export.ts";
  import { parseTaskDataset, validateTaskDataset } from "./src/simulation/traffic.ts";

  function maxOf(values) {
    return values.length > 0 ? Math.max(...values) : 0;
  }

  function buildTrace(taskText, fileName) {
    const tasks = parseTaskDataset(taskText, fileName);
    const validation = validateTaskDataset(tasks, walkerNetworkConfig);
    const slices = generateWalkerNetwork(walkerNetworkConfig, {
      mode: "operational",
      tasks,
      trafficProfile: "uploaded",
      orbitModel: "tle-sgp4",
      routingAlgorithm: "shortest-path",
    });
    const metadata = experimentMetadata(
      {
        simulationMode: "operational",
        trafficProfile: "uploaded",
        orbitModel: "tle-sgp4",
        routingAlgorithm: "shortest-path",
        datasetName: fileName,
        configSnapshot: walkerNetworkConfig,
        taskRecords: tasks,
        validationSummary: validation,
      },
      slices,
    );
    const taskTraceRows = createTaskTraceRows(slices, tasks);
    const linkImpactRows = businessLinkImpactRows(slices, tasks);
    const nodeImpactRows = businessNodeImpactRows(slices, tasks);

    const taskStatusCounts = taskTraceRows.reduce((counts, row) => {
      counts[row.status] = (counts[row.status] ?? 0) + 1;
      return counts;
    }, {});
    const taskTelemetryRows = taskTraceRows.filter((row) => row.task_telemetry_generated_mb > 0);
    const taskTelemetryGeneratedMb = taskTelemetryRows.reduce(
      (total, row) => total + row.task_telemetry_generated_mb,
      0,
    );
    const summary = {
      trace_schema_version: "stage1-business-causality-trace-v2",
      generated_at: new Date().toISOString(),
      metadata,
      validation,
      counts: {
        slices: slices.length,
        tasks: tasks.length,
        task_trace_rows: taskTraceRows.length,
        link_impact_rows: linkImpactRows.length,
        node_impact_rows: nodeImpactRows.length,
        routed_task_trace_rows: taskStatusCounts.routed ?? 0,
        local_or_not_requested_rows: taskTraceRows.filter((row) => row.status === "not-requested" || row.status === "local").length,
        task_type_telemetry_trace_rows: taskTelemetryRows.length,
        task_type_telemetry_generated_mb: Number(taskTelemetryGeneratedMb.toFixed(2)),
        max_task_path_hops: maxOf(taskTraceRows.map((row) => row.hop_count)),
        max_observed_link_utilization_percent: maxOf(taskTraceRows.map((row) => row.max_link_utilization_percent)),
        max_observed_path_cpu_percent: maxOf(taskTraceRows.map((row) => row.max_path_cpu_percent)),
      },
      checks: {
        dataset_valid: validation.errors.length === 0,
        task_trace_rows_present: taskTraceRows.length > 0,
        routed_rows_have_links: taskTraceRows
          .filter((row) => row.status === "routed")
          .every((row) => row.link_ids.length > 0 && row.hop_count > 0),
        local_rows_have_nodes: taskTraceRows
          .filter((row) => row.status === "not-requested" || row.status === "local")
          .every((row) => row.impacted_node_count > 0),
        link_impacts_present: linkImpactRows.length > 0,
        node_impacts_present: nodeImpactRows.length > 0,
        task_type_telemetry_impacts_present:
          taskTelemetryRows.length > 0 &&
          taskTelemetryGeneratedMb > 0 &&
          nodeImpactRows.some((row) => row.task_telemetry_generated_mb > 0),
      },
      task_status_counts: taskStatusCounts,
    };

    return {
      summary,
      taskTraceRows,
      linkImpactRows,
      nodeImpactRows,
      taskTraceCsv: rowsToCsv(taskTraceRows),
      linkImpactCsv: rowsToCsv(linkImpactRows),
      nodeImpactCsv: rowsToCsv(nodeImpactRows),
    };
  }

  export { buildTrace };
`;

const result = await build({
  stdin: {
    contents: entry,
    resolveDir: process.cwd(),
    sourcefile: "stage-one-business-trace.ts",
    loader: "ts",
  },
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
  logLevel: "silent",
});

await mkdir(".tmp", { recursive: true });
const bundlePath = ".tmp/stage-one-business-trace.mjs";
await writeFile(bundlePath, result.outputFiles[0].text, "utf8");
const { buildTrace } = await import(`${pathToFileURL(bundlePath).href}?t=${Date.now()}`);
await rm(bundlePath, { force: true });

const taskText = await readFile(tasksPath, "utf8");
const trace = buildTrace(taskText, basename(tasksPath));

await mkdir(reportDir, { recursive: true });
await writeFile(traceJsonPath, JSON.stringify(trace.summary, null, 2), "utf8");
await writeFile(taskTraceCsvPath, trace.taskTraceCsv, "utf8");
await writeFile(linkImpactCsvPath, trace.linkImpactCsv, "utf8");
await writeFile(nodeImpactCsvPath, trace.nodeImpactCsv, "utf8");

console.log(
  JSON.stringify(
    {
      overall_passed: Object.values(trace.summary.checks).every(Boolean),
      files: [traceJsonPath, taskTraceCsvPath, linkImpactCsvPath, nodeImpactCsvPath],
      counts: trace.summary.counts,
      checks: trace.summary.checks,
      fingerprints: {
        config: trace.summary.metadata.config_fingerprint,
        dataset: trace.summary.metadata.dataset_fingerprint,
        truth: trace.summary.metadata.truth_fingerprint,
      },
    },
    null,
    2,
  ),
);

if (!Object.values(trace.summary.checks).every(Boolean)) {
  process.exitCode = 1;
}
