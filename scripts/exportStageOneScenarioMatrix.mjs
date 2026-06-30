import { build } from "esbuild";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

function argValue(args, name, fallback = "") {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  return args[index + 1] ?? fallback;
}

const args = process.argv.slice(2);
const reportDir = argValue(args, "--report-dir", "reports/stage1");
const uploadedDatasetPath = argValue(args, "--tasks", "examples/datasets/stage1-standard-traffic.csv");
const matrixJsonPath = `${reportDir}/stage1-scenario-matrix.json`;
const matrixCsvPath = `${reportDir}/stage1-scenario-matrix.csv`;
const matrixMdPath = `${reportDir}/stage1-scenario-matrix.md`;

const profiles = ["empty", "low-load", "normal", "high-load", "hotspot", "burst", "long-duration"];

const entry = `
  import { walkerNetworkConfig } from "./src/config/walkerNetworkConfig.ts";
  import { generateWalkerNetwork } from "./src/simulation/walker.ts";
  import { experimentMetadata } from "./src/simulation/export.ts";
  import { parseTaskDataset, scenarioTrafficTasks, validateTaskDataset } from "./src/simulation/traffic.ts";

  const profiles = ["empty", "low-load", "normal", "high-load", "hotspot", "burst", "long-duration"];

  function round(value, digits = 2) {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
  }

  function taskTotals(tasks) {
    return {
      task_count: tasks.length,
      routed_task_count: tasks.filter((task) => task.source && task.target).length,
      local_task_count: tasks.filter((task) => task.node_id).length,
      total_traffic_mbps: round(tasks.reduce((total, task) => total + (task.traffic_mbps ?? 0), 0), 3),
      total_compute_units: round(tasks.reduce((total, task) => total + (task.compute_units ?? 0), 0), 3),
      total_memory_gb: round(tasks.reduce((total, task) => total + (task.memory_gb ?? 0), 0), 3),
      total_storage_gb: round(tasks.reduce((total, task) => total + (task.storage_gb ?? 0), 0), 3),
    };
  }

  function summarizeSlices(slices) {
    const metrics = {
      slices: slices.length,
      nodes: slices[0]?.nodes.length ?? 0,
      links: slices[0]?.links.length ?? 0,
      active_route_slices: 0,
      active_tasks: 0,
      routed_tasks: 0,
      unroutable_tasks: 0,
      avg_cpu_percent: 0,
      max_cpu_percent: 0,
      max_compute_cpu_percent: 0,
      max_forwarding_cpu_percent: 0,
      max_queue_cpu_percent: 0,
      max_memory_percent: 0,
      max_storage_percent: 0,
      max_temperature_c: 0,
      max_load_power_w: 0,
      max_network_compute_power_w: 0,
      max_forwarding_load_mbps: 0,
      max_node_queue_mb: 0,
      max_node_drop_mb: 0,
      max_cache_mb: 0,
      max_telemetry_buffer_mb: 0,
      max_telemetry_downlinked_mb: 0,
      max_link_demand_mbps: 0,
      max_link_carried_mbps: 0,
      max_link_utilization_percent: 0,
      max_link_queue_mb: 0,
      max_link_drop_mb: 0,
      max_link_congestion_percent: 0,
      congested_link_samples: 0,
      active_link_samples: 0,
      constrained_link_samples: 0,
      polar_blocked_samples: 0,
      min_energy_wh: Number.POSITIVE_INFINITY,
      max_energy_wh: 0,
      sunlight_node_samples: 0,
      eclipse_node_samples: 0,
    };

    for (const slice of slices) {
      if (slice.routes.length > 0) metrics.active_route_slices += 1;
      metrics.active_tasks += slice.routes.length;
      metrics.routed_tasks += slice.routes.filter((route) => route.status === "routed").length;
      metrics.unroutable_tasks += slice.routes.filter((route) => route.status === "unroutable").length;
      metrics.avg_cpu_percent +=
        slice.nodes.reduce((total, node) => total + node.resources.cpu_utilization, 0) / Math.max(slice.nodes.length, 1);

      for (const node of slice.nodes) {
        metrics.max_cpu_percent = Math.max(metrics.max_cpu_percent, node.resources.cpu_utilization);
        metrics.max_compute_cpu_percent = Math.max(metrics.max_compute_cpu_percent, node.resources.compute_cpu_percent);
        metrics.max_forwarding_cpu_percent = Math.max(metrics.max_forwarding_cpu_percent, node.resources.forwarding_cpu_percent);
        metrics.max_queue_cpu_percent = Math.max(metrics.max_queue_cpu_percent, node.resources.queue_cpu_percent);
        metrics.max_memory_percent = Math.max(metrics.max_memory_percent, node.resources.memory_utilization);
        metrics.max_storage_percent = Math.max(metrics.max_storage_percent, node.resources.storage_utilization);
        metrics.max_temperature_c = Math.max(metrics.max_temperature_c, node.state.temperatureC);
        metrics.max_load_power_w = Math.max(metrics.max_load_power_w, node.resources.load_power_w);
        metrics.max_network_compute_power_w = Math.max(metrics.max_network_compute_power_w, node.resources.network_compute_power_w);
        metrics.max_forwarding_load_mbps = Math.max(metrics.max_forwarding_load_mbps, node.resources.forwarding_load_mbps);
        metrics.max_node_queue_mb = Math.max(metrics.max_node_queue_mb, node.resources.queued_traffic_mb);
        metrics.max_node_drop_mb = Math.max(metrics.max_node_drop_mb, node.resources.dropped_traffic_mb);
        metrics.max_cache_mb = Math.max(metrics.max_cache_mb, node.resources.cache_used_mb);
        metrics.max_telemetry_buffer_mb = Math.max(metrics.max_telemetry_buffer_mb, node.resources.telemetry_buffer_mb);
        metrics.max_telemetry_downlinked_mb = Math.max(metrics.max_telemetry_downlinked_mb, node.resources.telemetry_downlinked_mb);
        metrics.min_energy_wh = Math.min(metrics.min_energy_wh, node.resources.energy_wh);
        metrics.max_energy_wh = Math.max(metrics.max_energy_wh, node.resources.energy_wh);
        if (node.timeState.inSunlight) metrics.sunlight_node_samples += 1;
        else metrics.eclipse_node_samples += 1;
      }

      for (const link of slice.links) {
        if (link.state.isActive) metrics.active_link_samples += 1;
        if (!link.state.isActive && link.state.restrictionReason) metrics.constrained_link_samples += 1;
        if (link.state.restrictionReason === "polar-region") metrics.polar_blocked_samples += 1;
        metrics.max_link_demand_mbps = Math.max(metrics.max_link_demand_mbps, link.state.demandTrafficMbps);
        metrics.max_link_carried_mbps = Math.max(metrics.max_link_carried_mbps, link.state.carriedTrafficMbps);
        metrics.max_link_utilization_percent = Math.max(metrics.max_link_utilization_percent, link.state.utilizationPercent);
        metrics.max_link_queue_mb = Math.max(metrics.max_link_queue_mb, link.state.queuedTrafficMb);
        metrics.max_link_drop_mb = Math.max(metrics.max_link_drop_mb, link.state.droppedTrafficMb);
        metrics.max_link_congestion_percent = Math.max(metrics.max_link_congestion_percent, link.state.congestionPercent);
        if (link.state.congestionPercent > 0) metrics.congested_link_samples += 1;
      }
    }

    for (const key of Object.keys(metrics)) {
      if (typeof metrics[key] === "number") metrics[key] = round(metrics[key], key.endsWith("_c") ? 1 : 2);
    }
    metrics.avg_cpu_percent = round(metrics.avg_cpu_percent / Math.max(metrics.slices, 1));
    return metrics;
  }

  function runScenario(profile, tasks, datasetName) {
    const validation = validateTaskDataset(tasks, walkerNetworkConfig);
    const slices = generateWalkerNetwork(walkerNetworkConfig, {
      mode: "operational",
      tasks: profile === "uploaded" ? tasks : [],
      trafficProfile: profile,
      orbitModel: "tle-sgp4",
      routingAlgorithm: "shortest-path",
    });
    const metadata = experimentMetadata(
      {
        simulationMode: "operational",
        trafficProfile: profile,
        orbitModel: "tle-sgp4",
        routingAlgorithm: "shortest-path",
        datasetName,
        configSnapshot: walkerNetworkConfig,
        taskRecords: tasks,
        validationSummary: validation,
      },
      slices,
    );

    return {
      profile,
      dataset_name: datasetName,
      validation,
      metadata: {
        config_fingerprint: metadata.config_fingerprint,
        dataset_fingerprint: metadata.dataset_fingerprint,
        truth_fingerprint: metadata.truth_fingerprint,
      },
      input: taskTotals(tasks),
      output: summarizeSlices(slices),
    };
  }

  export function createScenarioMatrix(uploadedText, uploadedFileName) {
    const scenarios = profiles.map((profile) => {
      const tasks = profile === "empty" ? [] : scenarioTrafficTasks(walkerNetworkConfig, profile);
      return runScenario(profile, tasks, "scenario:" + profile);
    });
    const uploadedTasks = parseTaskDataset(uploadedText, uploadedFileName);
    scenarios.push(runScenario("uploaded", uploadedTasks, uploadedFileName));
    const scenarioByProfile = Object.fromEntries(scenarios.map((scenario) => [scenario.profile, scenario]));
    const empty = scenarioByProfile.empty;
    const lowLoad = scenarioByProfile["low-load"];
    const normal = scenarioByProfile.normal;
    const highLoad = scenarioByProfile["high-load"];
    const hotspot = scenarioByProfile.hotspot;
    const burst = scenarioByProfile.burst;
    const longDuration = scenarioByProfile["long-duration"];
    const uploaded = scenarioByProfile.uploaded;
    return {
      generated_at: new Date().toISOString(),
      matrix_schema_version: "stage1-scenario-matrix-v2",
      scenarios,
      response_checks: {
        empty_idle:
          empty?.output.max_cpu_percent === 0 &&
          empty?.output.max_forwarding_load_mbps === 0 &&
          empty?.output.max_node_queue_mb === 0 &&
          empty?.output.max_link_demand_mbps === 0 &&
          empty?.output.max_link_utilization_percent === 0,
        low_load_routes_without_pressure:
          lowLoad?.output.routed_tasks > 0 &&
          lowLoad?.output.unroutable_tasks === 0 &&
          lowLoad?.output.max_link_congestion_percent === 0 &&
          lowLoad?.output.max_node_queue_mb === 0 &&
          lowLoad?.output.max_link_queue_mb === 0 &&
          lowLoad?.output.max_cpu_percent > empty?.output.max_cpu_percent,
        normal_exceeds_low_load:
          normal?.output.max_link_demand_mbps > lowLoad?.output.max_link_demand_mbps &&
          normal?.output.max_cpu_percent > lowLoad?.output.max_cpu_percent &&
          normal?.output.max_forwarding_load_mbps > lowLoad?.output.max_forwarding_load_mbps &&
          normal?.output.max_telemetry_buffer_mb > lowLoad?.output.max_telemetry_buffer_mb,
        high_load_exceeds_low_load:
          highLoad?.output.max_link_demand_mbps > lowLoad?.output.max_link_demand_mbps &&
          highLoad?.output.max_cpu_percent > lowLoad?.output.max_cpu_percent,
        high_load_exceeds_normal_pressure:
          highLoad?.output.max_link_demand_mbps > normal?.output.max_link_demand_mbps &&
          highLoad?.output.max_link_congestion_percent > normal?.output.max_link_congestion_percent &&
          highLoad?.output.max_load_power_w > normal?.output.max_load_power_w &&
          highLoad?.output.max_network_compute_power_w > normal?.output.max_network_compute_power_w,
        hotspot_or_burst_creates_queue:
          hotspot?.output.max_node_queue_mb > 0 ||
          burst?.output.max_link_queue_mb > 0 ||
          burst?.output.max_link_congestion_percent > 0,
        burst_exceeds_normal_congestion:
          burst?.output.max_link_demand_mbps > normal?.output.max_link_demand_mbps &&
          burst?.output.max_link_congestion_percent > normal?.output.max_link_congestion_percent,
        long_duration_spans_all_slices:
          longDuration?.output.active_route_slices === longDuration?.output.slices &&
          longDuration?.output.routed_tasks > normal?.output.routed_tasks,
        uploaded_dataset_drives_routes:
          uploaded?.validation.errors.length === 0 &&
          uploaded?.output.routed_tasks > 0 &&
          uploaded?.output.max_cpu_percent > empty?.output.max_cpu_percent &&
          uploaded?.output.max_link_demand_mbps > empty?.output.max_link_demand_mbps,
      },
    };
  }
`;

const result = await build({
  stdin: {
    contents: entry,
    resolveDir: process.cwd(),
    sourcefile: "stage-one-scenario-matrix.ts",
    loader: "ts",
  },
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
  logLevel: "silent",
});

await mkdir(".tmp", { recursive: true });
const bundlePath = ".tmp/stage-one-scenario-matrix.mjs";
await writeFile(bundlePath, result.outputFiles[0].text, "utf8");
const { createScenarioMatrix } = await import(`${pathToFileURL(bundlePath).href}?t=${Date.now()}`);
await rm(bundlePath, { force: true });

const uploadedDatasetText = await readFile(uploadedDatasetPath, "utf8");
const uploadedFileName = uploadedDatasetPath.split(/[\\/]/).pop() ?? uploadedDatasetPath;
const matrix = createScenarioMatrix(uploadedDatasetText, uploadedFileName);

const csvColumns = [
  "profile",
  "dataset_name",
  "config_fingerprint",
  "dataset_fingerprint",
  "truth_fingerprint",
  "input_task_count",
  "input_total_traffic_mbps",
  "input_total_compute_units",
  "routed_tasks",
  "unroutable_tasks",
  "max_cpu_percent",
  "max_forwarding_load_mbps",
  "max_link_demand_mbps",
  "max_link_congestion_percent",
  "max_node_queue_mb",
  "max_link_queue_mb",
  "max_load_power_w",
  "max_network_compute_power_w",
  "max_telemetry_buffer_mb",
  "max_telemetry_downlinked_mb",
  "min_energy_wh",
  "max_energy_wh",
  "polar_blocked_samples",
];

function csvEscape(value) {
  if (value === undefined || value === null) return "";
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function scenarioToRow(scenario) {
  return {
    profile: scenario.profile,
    dataset_name: scenario.dataset_name,
    config_fingerprint: scenario.metadata.config_fingerprint,
    dataset_fingerprint: scenario.metadata.dataset_fingerprint,
    truth_fingerprint: scenario.metadata.truth_fingerprint,
    input_task_count: scenario.input.task_count,
    input_total_traffic_mbps: scenario.input.total_traffic_mbps,
    input_total_compute_units: scenario.input.total_compute_units,
    routed_tasks: scenario.output.routed_tasks,
    unroutable_tasks: scenario.output.unroutable_tasks,
    max_cpu_percent: scenario.output.max_cpu_percent,
    max_forwarding_load_mbps: scenario.output.max_forwarding_load_mbps,
    max_link_demand_mbps: scenario.output.max_link_demand_mbps,
    max_link_congestion_percent: scenario.output.max_link_congestion_percent,
    max_node_queue_mb: scenario.output.max_node_queue_mb,
    max_link_queue_mb: scenario.output.max_link_queue_mb,
    max_load_power_w: scenario.output.max_load_power_w,
    max_network_compute_power_w: scenario.output.max_network_compute_power_w,
    max_telemetry_buffer_mb: scenario.output.max_telemetry_buffer_mb,
    max_telemetry_downlinked_mb: scenario.output.max_telemetry_downlinked_mb,
    min_energy_wh: scenario.output.min_energy_wh,
    max_energy_wh: scenario.output.max_energy_wh,
    polar_blocked_samples: scenario.output.polar_blocked_samples,
  };
}

function matrixCsv(data) {
  const rows = data.scenarios.map(scenarioToRow);
  return [
    csvColumns.join(","),
    ...rows.map((row) => csvColumns.map((column) => csvEscape(row[column])).join(",")),
  ].join("\n") + "\n";
}

function markdownTableRow(cells) {
  return `| ${cells.join(" | ")} |`;
}

function matrixMarkdown(data) {
  const lines = [
    "# 第一阶段场景矩阵",
    "",
    `生成时间：${data.generated_at}`,
    "",
    "## 业务输入到网络状态响应",
    "",
    markdownTableRow([
      "场景",
      "任务数",
      "输入流量 Mbps",
      "路由样本",
      "最大 CPU %",
      "最大转发 Mbps",
      "最大链路需求 Mbps",
      "最大拥塞 %",
      "节点队列 MB",
      "链路队列 MB",
      "真值指纹",
    ]),
    markdownTableRow(["---", "---", "---", "---", "---", "---", "---", "---", "---", "---", "---"]),
    ...data.scenarios.map((scenario) =>
      markdownTableRow([
        scenario.profile,
        String(scenario.input.task_count),
        String(scenario.input.total_traffic_mbps),
        String(scenario.output.routed_tasks),
        String(scenario.output.max_cpu_percent),
        String(scenario.output.max_forwarding_load_mbps),
        String(scenario.output.max_link_demand_mbps),
        String(scenario.output.max_link_congestion_percent),
        String(scenario.output.max_node_queue_mb),
        String(scenario.output.max_link_queue_mb),
        scenario.metadata.truth_fingerprint,
      ]),
    ),
    "",
    "## 响应检查",
    "",
    ...Object.entries(data.response_checks).map(([key, passed]) => `- ${key}: ${passed ? "通过" : "未通过"}`),
    "",
  ];
  return `${lines.join("\n")}\n`;
}

await mkdir(reportDir, { recursive: true });
await writeFile(matrixJsonPath, JSON.stringify(matrix, null, 2), "utf8");
await writeFile(matrixCsvPath, matrixCsv(matrix), "utf8");
await writeFile(matrixMdPath, matrixMarkdown(matrix), "utf8");

const failedChecks = Object.entries(matrix.response_checks)
  .filter(([, passed]) => !passed)
  .map(([key]) => key);

console.log(
  JSON.stringify(
    {
      reportDir,
      files: [matrixJsonPath, matrixCsvPath, matrixMdPath],
      scenarioCount: matrix.scenarios.length,
      response_checks: matrix.response_checks,
    },
    null,
    2,
  ),
);

if (failedChecks.length > 0) {
  console.error(`Stage-one scenario matrix failed: ${failedChecks.join(", ")}`);
  process.exitCode = 1;
}
