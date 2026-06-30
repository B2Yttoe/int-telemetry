import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";

function argValue(args, name, fallback = "") {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  return args[index + 1] ?? fallback;
}

const args = process.argv.slice(2);
const reportDir = argValue(args, "--report-dir");

const entry = `
  import { generateWalkerNetwork } from "./src/simulation/walker.ts";
  import { walkerNetworkConfig } from "./src/config/walkerNetworkConfig.ts";
  import { taskDatasetFingerprint } from "./src/simulation/export.ts";
  import { parseTaskDataset, scenarioTrafficTasks, validateTaskDataset } from "./src/simulation/traffic.ts";

  const templateHeaders = [
    "task_id",
    "time",
    "start_slice",
    "duration_slices",
    "source",
    "target",
    "node_id",
    "compute_units",
    "gpu_units",
    "memory_gb",
    "storage_gb",
    "traffic_mbps",
    "priority",
    "task_type",
  ];

  function csvEscape(value) {
    if (value === undefined || value === null) return "";
    const text = String(value);
    return /[",\\r\\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
  }

  function templateTasksToCsv(tasks) {
    const lines = [
      templateHeaders.join(","),
      ...tasks.map((task) =>
        templateHeaders.map((header) => {
          if (header === "time") return csvEscape(task.time ?? "T" + String(task.start_slice).padStart(2, "0"));
          if (header === "node_id") return csvEscape(task.node_id ?? "");
          if (header === "gpu_units") return csvEscape(task.gpu_units ?? 0);
          return csvEscape(task[header] ?? "");
        }).join(","),
      ),
    ];
    return lines.join("\\n") + "\\n";
  }

  export function runProfile(trafficProfile) {
    return generateWalkerNetwork(walkerNetworkConfig, {
      mode: "operational",
      tasks: [],
      trafficProfile,
      orbitModel: "tle-sgp4",
      routingAlgorithm: "shortest-path",
    });
  }

  export function runProfileWithDemoWaveStress(trafficProfile) {
    const config = {
      ...walkerNetworkConfig,
      stateProfiles: {
        ...walkerNetworkConfig.stateProfiles,
        nodeThermalWaveC: walkerNetworkConfig.stateProfiles.nodeThermalWaveC * 50,
        nodeLoadWavePercent: walkerNetworkConfig.stateProfiles.nodeLoadWavePercent * 50,
        queueWaveDepth: walkerNetworkConfig.stateProfiles.queueWaveDepth * 50,
        linkUtilizationWavePercent: walkerNetworkConfig.stateProfiles.linkUtilizationWavePercent * 50,
      },
    };
    return generateWalkerNetwork(config, {
      mode: "operational",
      tasks: [],
      trafficProfile,
      orbitModel: "tle-sgp4",
      routingAlgorithm: "shortest-path",
    });
  }

  export function runUploadedDataset(taskText, fileName) {
    const tasks = parseTaskDataset(taskText, fileName);
    const validation = validateTaskDataset(tasks, walkerNetworkConfig);
    return {
      tasks,
      validation,
      slices: generateWalkerNetwork(walkerNetworkConfig, {
        mode: "operational",
        tasks,
        trafficProfile: "uploaded",
        orbitModel: "tle-sgp4",
        routingAlgorithm: "shortest-path",
      }),
      };
  }

  export function runPowerSavingRoutingGate() {
    const minEnergyWh =
      walkerNetworkConfig.operationalModel.minStateOfCharge *
      walkerNetworkConfig.operationalModel.batteryCapacityWh;
    const config = {
      ...walkerNetworkConfig,
      nodeResourceDefaults: {
        ...walkerNetworkConfig.nodeResourceDefaults,
        energy_wh: minEnergyWh,
      },
      operationalModel: {
        ...walkerNetworkConfig.operationalModel,
        solarArrayAreaM2: 0,
      },
    };
    const tasks = [
      {
        task_id: "POWER-GATE-001",
        time: "T00",
        start_slice: 0,
        duration_slices: 2,
        source: "P01-S01",
        target: "P02-S02",
        compute_units: 0,
        gpu_units: 0,
        memory_gb: 0,
        storage_gb: 0,
        traffic_mbps: 120,
        priority: 1,
        task_type: "routing",
      },
    ];
    const validation = validateTaskDataset(tasks, config);
    return {
      tasks,
      validation,
      slices: generateWalkerNetwork(config, {
        mode: "operational",
        tasks,
        trafficProfile: "uploaded",
        orbitModel: "tle-sgp4",
        routingAlgorithm: "shortest-path",
      }),
    };
  }

  export function validateScenarioTemplates(profiles) {
    return profiles.map((profile) => {
      const tasks = profile === "empty" ? [] : scenarioTrafficTasks(walkerNetworkConfig, profile);
      const directValidation = validateTaskDataset(tasks, walkerNetworkConfig);
      const csvText = templateTasksToCsv(tasks);
      const parsedCsvTasks = parseTaskDataset(csvText, profile + ".csv");
      const csvRoundTripValidation = validateTaskDataset(parsedCsvTasks, walkerNetworkConfig);
      const jsonArrayText = JSON.stringify(tasks);
      const parsedJsonArrayTasks = parseTaskDataset(jsonArrayText, profile + ".json");
      const jsonArrayRoundTripValidation = validateTaskDataset(parsedJsonArrayTasks, walkerNetworkConfig);
      const jsonObjectText = JSON.stringify({ dataset_id: "stage1-" + profile, tasks });
      const parsedJsonObjectTasks = parseTaskDataset(jsonObjectText, profile + ".json");
      const jsonObjectRoundTripValidation = validateTaskDataset(parsedJsonObjectTasks, walkerNetworkConfig);
      const directFingerprint = taskDatasetFingerprint(profile, tasks);
      const csvFingerprint = taskDatasetFingerprint(profile, parsedCsvTasks);
      const jsonArrayFingerprint = taskDatasetFingerprint(profile, parsedJsonArrayTasks);
      const jsonObjectFingerprint = taskDatasetFingerprint(profile, parsedJsonObjectTasks);
      return {
        profile,
        generatedTasks: tasks.length,
        parsedTasks: parsedCsvTasks.length,
        parsedCsvTasks: parsedCsvTasks.length,
        parsedJsonArrayTasks: parsedJsonArrayTasks.length,
        parsedJsonObjectTasks: parsedJsonObjectTasks.length,
        directValidation,
        roundTripValidation: csvRoundTripValidation,
        csvRoundTripValidation,
        jsonArrayRoundTripValidation,
        jsonObjectRoundTripValidation,
        directFingerprint,
        csvFingerprint,
        jsonArrayFingerprint,
        jsonObjectFingerprint,
        fingerprintsEqual:
          directFingerprint === csvFingerprint &&
          directFingerprint === jsonArrayFingerprint &&
          directFingerprint === jsonObjectFingerprint,
      };
    });
  }

  export function auditConfigSnapshot() {
    return {
      constellation: walkerNetworkConfig.constellation,
      orbit: walkerNetworkConfig.orbit,
      polarRegion: walkerNetworkConfig.polarRegion,
      nodeResourceDefaults: walkerNetworkConfig.nodeResourceDefaults,
      nodeStateDefaults: walkerNetworkConfig.nodeStateDefaults,
      operationalModel: walkerNetworkConfig.operationalModel,
      trafficModel: walkerNetworkConfig.trafficModel,
      stateProfiles: walkerNetworkConfig.stateProfiles,
      time: walkerNetworkConfig.time,
    };
  }
`;

const result = await build({
  stdin: {
    contents: entry,
    resolveDir: process.cwd(),
    sourcefile: "stage-one-audit.ts",
    loader: "ts",
  },
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
  logLevel: "silent",
});

const moduleUrl = `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`;
const {
  runProfile,
  runProfileWithDemoWaveStress,
  runUploadedDataset,
  runPowerSavingRoutingGate,
  validateScenarioTemplates,
  auditConfigSnapshot,
} = await import(moduleUrl);
const auditConfig = auditConfigSnapshot();

const profiles = ["empty", "low-load", "normal", "high-load", "hotspot", "burst", "long-duration"];
const uploadedDatasetPath = "examples/datasets/stage1-standard-traffic.csv";
const uploadedJsonDatasetPath = "examples/datasets/stage1-standard-traffic.json";

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function summarize(slices) {
  const metrics = {
    slices: slices.length,
    nodes: slices[0]?.nodes.length ?? 0,
    links: slices[0]?.links.length ?? 0,
    activeRouteSlices: 0,
    activeTasks: 0,
    routedTasks: 0,
    unroutableTasks: 0,
    maxCpuPercent: 0,
    maxComputeCpuPercent: 0,
    maxForwardingCpuPercent: 0,
    maxQueueCpuPercent: 0,
    avgCpuPercent: 0,
    maxNodeQueueMb: 0,
    maxNodeDropMb: 0,
    maxCacheMb: 0,
    maxForwardingLoadMbps: 0,
    maxCommunicationPowerW: 0,
    maxNodeLinkOccupancyPercent: 0,
    maxMemoryPercent: 0,
    maxStoragePercent: 0,
    maxTemperatureC: 0,
    maxLoadPowerW: 0,
    maxTaskComputePowerW: 0,
    maxNetworkComputePowerW: 0,
    maxTelemetryBufferMb: 0,
    maxTelemetryDownlinkedMb: 0,
    maxLinkDemandMbps: 0,
    maxLinkCarriedMbps: 0,
    maxLinkUtilizationPercent: 0,
    maxLinkQueueMb: 0,
    maxLinkDropMb: 0,
    maxLinkCongestionPercent: 0,
    congestedLinkSamples: 0,
    minEnergyWh: Number.POSITIVE_INFINITY,
    maxEnergyWh: 0,
    sunlightNodeSamples: 0,
    eclipseNodeSamples: 0,
    activeLinkSamples: 0,
    linkBudgetSamples: 0,
    polarBlockedSamples: 0,
    solarBlockedSamples: 0,
  };

  for (const slice of slices) {
    if (slice.routes.length > 0) metrics.activeRouteSlices += 1;
    metrics.activeTasks += slice.routes.length;
    metrics.routedTasks += slice.routes.filter((route) => route.status === "routed").length;
    metrics.unroutableTasks += slice.routes.filter((route) => route.status === "unroutable").length;
    metrics.avgCpuPercent +=
      slice.nodes.reduce((total, node) => total + node.resources.cpu_utilization, 0) / Math.max(slice.nodes.length, 1);

    for (const node of slice.nodes) {
      metrics.maxCpuPercent = Math.max(metrics.maxCpuPercent, node.resources.cpu_utilization);
      metrics.maxComputeCpuPercent = Math.max(metrics.maxComputeCpuPercent, node.resources.compute_cpu_percent);
      metrics.maxForwardingCpuPercent = Math.max(metrics.maxForwardingCpuPercent, node.resources.forwarding_cpu_percent);
      metrics.maxQueueCpuPercent = Math.max(metrics.maxQueueCpuPercent, node.resources.queue_cpu_percent);
      metrics.maxNodeQueueMb = Math.max(metrics.maxNodeQueueMb, node.resources.queued_traffic_mb);
      metrics.maxNodeDropMb = Math.max(metrics.maxNodeDropMb, node.resources.dropped_traffic_mb);
      metrics.maxCacheMb = Math.max(metrics.maxCacheMb, node.resources.cache_used_mb);
      metrics.maxForwardingLoadMbps = Math.max(metrics.maxForwardingLoadMbps, node.resources.forwarding_load_mbps);
      metrics.maxCommunicationPowerW = Math.max(metrics.maxCommunicationPowerW, node.resources.communication_power_w);
      metrics.maxNodeLinkOccupancyPercent = Math.max(
        metrics.maxNodeLinkOccupancyPercent,
        node.resources.link_occupancy_percent,
      );
      metrics.maxMemoryPercent = Math.max(metrics.maxMemoryPercent, node.resources.memory_utilization);
      metrics.maxStoragePercent = Math.max(metrics.maxStoragePercent, node.resources.storage_utilization);
      metrics.maxTemperatureC = Math.max(metrics.maxTemperatureC, node.state.temperatureC);
      metrics.maxLoadPowerW = Math.max(metrics.maxLoadPowerW, node.resources.load_power_w);
      metrics.maxTaskComputePowerW = Math.max(metrics.maxTaskComputePowerW, node.resources.task_compute_power_w);
      metrics.maxNetworkComputePowerW = Math.max(metrics.maxNetworkComputePowerW, node.resources.network_compute_power_w);
      metrics.maxTelemetryBufferMb = Math.max(metrics.maxTelemetryBufferMb, node.resources.telemetry_buffer_mb);
      metrics.maxTelemetryDownlinkedMb = Math.max(metrics.maxTelemetryDownlinkedMb, node.resources.telemetry_downlinked_mb);
      metrics.minEnergyWh = Math.min(metrics.minEnergyWh, node.resources.energy_wh);
      metrics.maxEnergyWh = Math.max(metrics.maxEnergyWh, node.resources.energy_wh);
      if (node.timeState.inSunlight) {
        metrics.sunlightNodeSamples += 1;
      } else {
        metrics.eclipseNodeSamples += 1;
      }
    }

    for (const link of slice.links) {
      if (link.state.isActive) metrics.activeLinkSamples += 1;
      if (link.state.linkBudget) metrics.linkBudgetSamples += 1;
      if (link.state.restrictionReason === "polar-region") metrics.polarBlockedSamples += 1;
      if (link.state.restrictionReason === "solar-interference") metrics.solarBlockedSamples += 1;
      metrics.maxLinkDemandMbps = Math.max(metrics.maxLinkDemandMbps, link.state.demandTrafficMbps);
      metrics.maxLinkCarriedMbps = Math.max(metrics.maxLinkCarriedMbps, link.state.carriedTrafficMbps);
      metrics.maxLinkUtilizationPercent = Math.max(metrics.maxLinkUtilizationPercent, link.state.utilizationPercent);
      metrics.maxLinkQueueMb = Math.max(metrics.maxLinkQueueMb, link.state.queuedTrafficMb);
      metrics.maxLinkDropMb = Math.max(metrics.maxLinkDropMb, link.state.droppedTrafficMb);
      metrics.maxLinkCongestionPercent = Math.max(metrics.maxLinkCongestionPercent, link.state.congestionPercent);
      if (link.state.congestionPercent > 0) metrics.congestedLinkSamples += 1;
    }
  }

  metrics.avgCpuPercent = round(metrics.avgCpuPercent / Math.max(metrics.slices, 1));
  metrics.maxComputeCpuPercent = round(metrics.maxComputeCpuPercent);
  metrics.maxForwardingCpuPercent = round(metrics.maxForwardingCpuPercent);
  metrics.maxQueueCpuPercent = round(metrics.maxQueueCpuPercent);
  metrics.maxNodeQueueMb = round(metrics.maxNodeQueueMb);
  metrics.maxNodeDropMb = round(metrics.maxNodeDropMb);
  metrics.maxCacheMb = round(metrics.maxCacheMb);
  metrics.maxForwardingLoadMbps = round(metrics.maxForwardingLoadMbps);
  metrics.maxCommunicationPowerW = round(metrics.maxCommunicationPowerW);
  metrics.maxNodeLinkOccupancyPercent = round(metrics.maxNodeLinkOccupancyPercent);
  metrics.maxMemoryPercent = round(metrics.maxMemoryPercent);
  metrics.maxStoragePercent = round(metrics.maxStoragePercent);
  metrics.maxTemperatureC = round(metrics.maxTemperatureC, 1);
  metrics.maxLoadPowerW = round(metrics.maxLoadPowerW);
  metrics.maxTaskComputePowerW = round(metrics.maxTaskComputePowerW);
  metrics.maxNetworkComputePowerW = round(metrics.maxNetworkComputePowerW);
  metrics.maxTelemetryBufferMb = round(metrics.maxTelemetryBufferMb);
  metrics.maxTelemetryDownlinkedMb = round(metrics.maxTelemetryDownlinkedMb);
  metrics.maxLinkDemandMbps = round(metrics.maxLinkDemandMbps);
  metrics.maxLinkCarriedMbps = round(metrics.maxLinkCarriedMbps);
  metrics.maxLinkUtilizationPercent = round(metrics.maxLinkUtilizationPercent);
  metrics.maxLinkQueueMb = round(metrics.maxLinkQueueMb);
  metrics.maxLinkDropMb = round(metrics.maxLinkDropMb);
  metrics.maxLinkCongestionPercent = round(metrics.maxLinkCongestionPercent);
  metrics.minEnergyWh = round(metrics.minEnergyWh);
  metrics.maxEnergyWh = round(metrics.maxEnergyWh);

  return metrics;
}

function everyNode(slices) {
  return slices.flatMap((slice) => slice.nodes);
}

function everyLink(slices) {
  return slices.flatMap((slice) => slice.links);
}

function approxEqual(actual, expected, tolerance) {
  return Math.abs(actual - expected) <= tolerance;
}

function formulaMismatch(sample, slice, node, field, actual, expected, tolerance) {
  if (sample.length >= 16) return;
  sample.push({
    slice: slice.index,
    node_id: node.id,
    field,
    actual: round(actual, 4),
    expected: round(expected, 4),
    tolerance,
  });
}

function linkFormulaMismatch(sample, slice, link, field, actual, expected, tolerance) {
  if (sample.length >= 16) return;
  sample.push({
    slice: slice.index,
    link_id: link.id,
    field,
    actual: round(actual, 4),
    expected: round(expected, 4),
    tolerance,
  });
}

function routeFormulaMismatch(sample, slice, route, field, actual, expected, tolerance) {
  if (sample.length >= 16) return;
  sample.push({
    slice: slice.index,
    task_id: route.task_id,
    field,
    actual: typeof actual === "number" ? round(actual, 4) : actual,
    expected: typeof expected === "number" ? round(expected, 4) : expected,
    tolerance,
  });
}

function resourceFormulaConsistency(slices, config) {
  const op = config.operationalModel;
  const traffic = config.trafficModel;
  const defaults = config.nodeResourceDefaults;
  const timeStepHours = config.time.stepMinutes / 60;
  const batteryCapacityWh = op.batteryCapacityWh;
  const minEnergyWh = op.minStateOfCharge * batteryCapacityWh;
  const previousEnergyWhByNode = new Map();
  const mismatches = [];
  let checkedNodes = 0;

  for (const slice of slices) {
    if (slice.index === 0) previousEnergyWhByNode.clear();
    for (const node of slice.nodes) {
      checkedNodes += 1;
      const resources = node.resources;
      const taskLoad = node.taskLoad;
      const expectedCpu = Math.min(
        100,
        Math.max(
          0,
          resources.compute_cpu_percent +
            resources.task_traffic_cpu_percent +
            resources.forwarding_cpu_percent +
            resources.queue_cpu_percent,
        ),
      );
      if (!approxEqual(resources.cpu_utilization, Math.round(expectedCpu), 1.1)) {
        formulaMismatch(mismatches, slice, node, "cpu_utilization", resources.cpu_utilization, Math.round(expectedCpu), 1.1);
      }
      const expectedTaskTrafficCpuPercent = round(
        clamp(
          ((resources.ingress_traffic_mbps + resources.egress_traffic_mbps) / 1000) *
            traffic.endpointCpuPercentPerGbps,
          0,
          100,
        ),
        1,
      );
      if (!approxEqual(resources.task_traffic_cpu_percent, expectedTaskTrafficCpuPercent, 0.11)) {
        formulaMismatch(
          mismatches,
          slice,
          node,
          "task_traffic_cpu_percent",
          resources.task_traffic_cpu_percent,
          expectedTaskTrafficCpuPercent,
          0.11,
        );
      }
      const expectedNetworkComputePowerW = round(
        ((resources.task_traffic_cpu_percent + resources.forwarding_cpu_percent + resources.queue_cpu_percent) / 100) *
          op.computePowerW,
        2,
      );
      if (!approxEqual(resources.network_compute_power_w, expectedNetworkComputePowerW, 0.06)) {
        formulaMismatch(
          mismatches,
          slice,
          node,
          "network_compute_power_w",
          resources.network_compute_power_w,
          expectedNetworkComputePowerW,
          0.06,
        );
      }

      const queueGb = resources.queued_traffic_mb / 1024;
      const telemetryBufferGb = resources.telemetry_buffer_mb / 1024;
      const expectedMemoryGb = Math.min(
        resources.memory,
        Math.max(
          0,
          resources.workload_memory_gb +
            queueGb * op.queueMemoryGbPerQueuedGb +
            telemetryBufferGb * op.telemetryMemoryGbPerBufferedGb,
        ),
      );
      if (!approxEqual(resources.memory_used_gb, expectedMemoryGb, 0.03)) {
        formulaMismatch(mismatches, slice, node, "memory_used_gb", resources.memory_used_gb, expectedMemoryGb, 0.03);
      }

      const cacheUsedGb = resources.cache_used_mb / 1024;
      const expectedStorageGb = Math.min(
        resources.storage,
        Math.max(0, resources.workload_storage_gb + cacheUsedGb * op.cacheStorageGbPerBufferedGb),
      );
      if (!approxEqual(resources.storage_used_gb, expectedStorageGb, 0.03)) {
        formulaMismatch(mismatches, slice, node, "storage_used_gb", resources.storage_used_gb, expectedStorageGb, 0.03);
      }

      const expectedLoadPowerW =
        resources.base_power_w +
        op.communicationPowerW +
        op.computePowerW +
        resources.payload_power_w +
        resources.task_compute_power_w +
        resources.network_compute_power_w +
        resources.communication_power_w;
      if (!approxEqual(resources.load_power_w, expectedLoadPowerW, 0.06)) {
        formulaMismatch(mismatches, slice, node, "load_power_w", resources.load_power_w, expectedLoadPowerW, 0.06);
      }

      const expectedTemperatureC =
        config.nodeStateDefaults.temperatureC +
        Math.max(0, resources.cpu_utilization) * op.thermalRisePerCpuPercent +
        Math.max(0, resources.gpu_utilization ?? 0) * op.thermalRisePerGpuPercent +
        Math.max(0, resources.communication_power_w) * op.thermalRisePerCommunicationW;
      if (!approxEqual(node.state.temperatureC, Math.round(expectedTemperatureC * 10) / 10, 0.11)) {
        formulaMismatch(mismatches, slice, node, "temperatureC", node.state.temperatureC, expectedTemperatureC, 0.11);
      }

      const expectedQueueDepth = Math.round(
        Math.min(
          100,
          Math.max(
            0,
            taskLoad.taskCount * op.queueDepthPerTask +
              (taskLoad.trafficMbps / 1000) * traffic.endpointQueueDepthPerGbps,
            resources.queued_traffic_mb * traffic.queueDepthPerQueuedMb,
          ),
        ),
      );
      if (!approxEqual(node.state.queueDepth, expectedQueueDepth, 1)) {
        formulaMismatch(mismatches, slice, node, "queueDepth", node.state.queueDepth, expectedQueueDepth, 1);
      }

      const previousEnergyWh = Math.min(
        batteryCapacityWh,
        Math.max(minEnergyWh, previousEnergyWhByNode.get(node.id) ?? defaults.energy_wh),
      );
      const chargePowerW = Math.max(resources.solar_power_w - resources.load_power_w, 0);
      const dischargePowerW = Math.max(resources.load_power_w - resources.solar_power_w, 0);
      const expectedNetPowerW = op.chargeEfficiency * chargePowerW - dischargePowerW / op.dischargeEfficiency;
      const expectedEnergyWh = Math.min(
        batteryCapacityWh,
        Math.max(minEnergyWh, previousEnergyWh + Math.round(expectedNetPowerW * 100) / 100 * timeStepHours),
      );
      if (!approxEqual(resources.net_power_w, expectedNetPowerW, 0.06)) {
        formulaMismatch(mismatches, slice, node, "net_power_w", resources.net_power_w, expectedNetPowerW, 0.06);
      }
      if (!approxEqual(resources.energy_wh, expectedEnergyWh, 0.06)) {
        formulaMismatch(mismatches, slice, node, "energy_wh", resources.energy_wh, expectedEnergyWh, 0.06);
      }

      previousEnergyWhByNode.set(node.id, resources.energy_wh);
    }
  }

  return {
    passed: mismatches.length === 0,
    checkedNodes,
    mismatchCount: mismatches.length,
    sampleMismatches: mismatches,
  };
}

function linkTrafficFormulaConsistency(slices, config) {
  const dtSeconds = config.time.stepMinutes * 60;
  const previousQueueMbByLink = new Map();
  const mismatches = [];
  let checkedLinks = 0;
  let checkedRoutedLinks = 0;

  for (const slice of slices) {
    if (slice.index === 0) previousQueueMbByLink.clear();

    const newDemandByLink = new Map();
    slice.routes
      .filter((route) => route.status === "routed")
      .forEach((route) => {
        route.linkIds.forEach((linkId) => {
          newDemandByLink.set(linkId, (newDemandByLink.get(linkId) ?? 0) + route.trafficMbps);
        });
      });

    for (const link of slice.links) {
      checkedLinks += 1;
      const newDemandMbps = newDemandByLink.get(link.id) ?? 0;
      if (newDemandMbps > 0) checkedRoutedLinks += 1;

      const previousQueueMb = previousQueueMbByLink.get(link.id) ?? 0;
      const previousQueueMbps = (previousQueueMb * 8) / Math.max(dtSeconds, 1);
      const totalDemandMbps = link.state.isActive ? newDemandMbps + previousQueueMbps : 0;
      const capacityMbps = link.state.isActive ? Math.max(link.state.bandwidthMbps, 1) : 0;
      const carriedMbps = Math.min(totalDemandMbps, capacityMbps);
      const excessMb = (Math.max(totalDemandMbps - carriedMbps, 0) * dtSeconds) / 8;
      const queuedMb = Math.min(excessMb, config.trafficModel.linkQueueCapacityMb);
      const droppedMb = Math.max(excessMb - queuedMb, 0);
      const congestionPercent =
        capacityMbps > 0 ? Math.max(0, (totalDemandMbps / capacityMbps - 1) * 100) : 0;
      const utilizationPercent =
        totalDemandMbps > 0 && link.state.isActive
          ? Math.round(Math.min(100, Math.max(0, (carriedMbps / Math.max(link.state.bandwidthMbps, 1)) * 100)))
          : 0;

      previousQueueMbByLink.set(link.id, queuedMb);

      if (!approxEqual(link.state.demandTrafficMbps, totalDemandMbps, 0.03)) {
        linkFormulaMismatch(mismatches, slice, link, "demandTrafficMbps", link.state.demandTrafficMbps, totalDemandMbps, 0.03);
      }
      if (!approxEqual(link.state.carriedTrafficMbps, carriedMbps, 0.03)) {
        linkFormulaMismatch(mismatches, slice, link, "carriedTrafficMbps", link.state.carriedTrafficMbps, carriedMbps, 0.03);
      }
      if (!approxEqual(link.state.queuedTrafficMb, queuedMb, 0.03)) {
        linkFormulaMismatch(mismatches, slice, link, "queuedTrafficMb", link.state.queuedTrafficMb, queuedMb, 0.03);
      }
      if (!approxEqual(link.state.droppedTrafficMb, droppedMb, 0.03)) {
        linkFormulaMismatch(mismatches, slice, link, "droppedTrafficMb", link.state.droppedTrafficMb, droppedMb, 0.03);
      }
      if (!approxEqual(link.state.congestionPercent, Math.round(congestionPercent * 10) / 10, 0.11)) {
        linkFormulaMismatch(mismatches, slice, link, "congestionPercent", link.state.congestionPercent, congestionPercent, 0.11);
      }
      if (!approxEqual(link.state.utilizationPercent, utilizationPercent, 1)) {
        linkFormulaMismatch(mismatches, slice, link, "utilizationPercent", link.state.utilizationPercent, utilizationPercent, 1);
      }
    }
  }

  return {
    passed: mismatches.length === 0,
    checkedLinks,
    checkedRoutedLinks,
    mismatchCount: mismatches.length,
    sampleMismatches: mismatches,
  };
}

function nodeCanRouteTraffic(node) {
  return Boolean(node) && (node.operationMode !== "operational" || node.resources.can_accept_tasks);
}

function shortestLatencyInSlice(sourceId, targetId, links, nodes = []) {
  if (!sourceId || !targetId) return Number.POSITIVE_INFINITY;
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  if (!nodeCanRouteTraffic(nodesById.get(sourceId)) || !nodeCanRouteTraffic(nodesById.get(targetId))) {
    return Number.POSITIVE_INFINITY;
  }
  if (sourceId === targetId) return 0;

  const graph = new Map();
  const ensureNode = (nodeId) => {
    if (!graph.has(nodeId)) graph.set(nodeId, []);
    return graph.get(nodeId);
  };

  links.filter((link) => link.state.isActive).forEach((link) => {
    if (!nodeCanRouteTraffic(nodesById.get(link.source)) || !nodeCanRouteTraffic(nodesById.get(link.target))) {
      return;
    }
    ensureNode(link.source).push({ next: link.target, cost: link.state.latencyMs });
    ensureNode(link.target).push({ next: link.source, cost: link.state.latencyMs });
  });

  if (!graph.has(sourceId) || !graph.has(targetId)) return Number.POSITIVE_INFINITY;

  const distances = new Map([...graph.keys()].map((nodeId) => [nodeId, Number.POSITIVE_INFINITY]));
  const visited = new Set();
  distances.set(sourceId, 0);

  while (visited.size < graph.size) {
    let current;
    let currentDistance = Number.POSITIVE_INFINITY;
    distances.forEach((distance, nodeId) => {
      if (!visited.has(nodeId) && distance < currentDistance) {
        current = nodeId;
        currentDistance = distance;
      }
    });

    if (current === undefined || currentDistance === Number.POSITIVE_INFINITY) break;
    if (current === targetId) break;
    visited.add(current);

    graph.get(current).forEach(({ next, cost }) => {
      if (visited.has(next)) return;
      const candidateDistance = currentDistance + cost;
      if (candidateDistance < (distances.get(next) ?? Number.POSITIVE_INFINITY)) {
        distances.set(next, candidateDistance);
      }
    });
  }

  return distances.get(targetId) ?? Number.POSITIVE_INFINITY;
}

function routePathFormulaConsistency(slices) {
  const mismatches = [];
  let checkedRoutes = 0;
  let checkedShortestPaths = 0;

  for (const slice of slices) {
    const linksById = new Map(slice.links.map((link) => [link.id, link]));

    for (const route of slice.routes.filter((item) => item.status === "routed")) {
      checkedRoutes += 1;
      const firstNode = route.path[0];
      const lastNode = route.path[route.path.length - 1];
      if (firstNode !== route.source) {
        routeFormulaMismatch(mismatches, slice, route, "path source", firstNode ?? "", route.source ?? "", 0);
      }
      if (lastNode !== route.target) {
        routeFormulaMismatch(mismatches, slice, route, "path target", lastNode ?? "", route.target ?? "", 0);
      }
      const nodesById = new Map(slice.nodes.map((node) => [node.id, node]));
      const unavailablePathNode = route.path.find((nodeId) => !nodeCanRouteTraffic(nodesById.get(nodeId)));
      if (unavailablePathNode) {
        routeFormulaMismatch(mismatches, slice, route, "unavailable path node", unavailablePathNode, "routable node", 0);
      }

      const expectedHopCount = Math.max(0, route.path.length - 1);
      if (!approxEqual(route.hopCount, expectedHopCount, 0)) {
        routeFormulaMismatch(mismatches, slice, route, "hopCount", route.hopCount, expectedHopCount, 0);
      }
      if (!approxEqual(route.linkIds.length, expectedHopCount, 0)) {
        routeFormulaMismatch(mismatches, slice, route, "linkIds.length", route.linkIds.length, expectedHopCount, 0);
      }

      let distanceKm = 0;
      let latencyMs = 0;

      route.linkIds.forEach((linkId, index) => {
        const link = linksById.get(linkId);
        const from = route.path[index];
        const to = route.path[index + 1];
        if (!link) {
          routeFormulaMismatch(mismatches, slice, route, "missing link", linkId, "active route link", 0);
          return;
        }
        if (!link.state.isActive) {
          routeFormulaMismatch(mismatches, slice, route, "inactive link", link.id, "active", 0);
        }
        const endpointsMatch =
          (link.source === from && link.target === to) || (link.source === to && link.target === from);
        if (!endpointsMatch) {
          routeFormulaMismatch(mismatches, slice, route, "link endpoints", `${link.source}->${link.target}`, `${from}<->${to}`, 0);
        }
        distanceKm += link.state.distanceKm;
        latencyMs += link.state.latencyMs;
      });

      const expectedDistanceKm = Math.round(distanceKm * 10) / 10;
      const expectedLatencyMs = Math.round(latencyMs * 10) / 10;
      if (!approxEqual(route.distanceKm, expectedDistanceKm, 0.11)) {
        routeFormulaMismatch(mismatches, slice, route, "distanceKm", route.distanceKm, expectedDistanceKm, 0.11);
      }
      if (!approxEqual(route.latencyMs, expectedLatencyMs, 0.11)) {
        routeFormulaMismatch(mismatches, slice, route, "latencyMs", route.latencyMs, expectedLatencyMs, 0.11);
      }

      const shortestLatencyMs = shortestLatencyInSlice(route.source, route.target, slice.links, slice.nodes);
      if (Number.isFinite(shortestLatencyMs)) {
        checkedShortestPaths += 1;
        const expectedShortestLatencyMs = Math.round(shortestLatencyMs * 10) / 10;
        if (!approxEqual(route.latencyMs, expectedShortestLatencyMs, 0.11)) {
          routeFormulaMismatch(
            mismatches,
            slice,
            route,
            "shortest latency",
            route.latencyMs,
            expectedShortestLatencyMs,
            0.11,
          );
        }
      }
    }
  }

  return {
    passed: mismatches.length === 0,
    checkedRoutes,
    checkedShortestPaths,
    mismatchCount: mismatches.length,
    sampleMismatches: mismatches,
  };
}

function taskActiveSlices(task, sliceCount) {
  const start = Math.max(0, task.start_slice);
  const end = Math.min(sliceCount, task.start_slice + Math.max(1, task.duration_slices || 1));
  return Array.from({ length: Math.max(0, end - start) }, (_, offset) => start + offset);
}

function causalMismatch(sample, sliceIndex, subject, field, actual, expected, tolerance) {
  if (sample.length >= 16) return;
  sample.push({
    slice: sliceIndex,
    subject,
    field,
    actual: typeof actual === "number" ? round(actual, 4) : actual,
    expected: typeof expected === "number" ? round(expected, 4) : expected,
    tolerance,
  });
}

const routeLinkAllocationKey = (taskId, linkId) => `${taskId}::${linkId}`;

function priorityRouteAllocationsForSlice(slice, previousLinkQueueMb, config) {
  const dtSeconds = config.time.stepMinutes * 60;
  const routesByLink = new Map();
  const demandByLink = new Map();
  slice.routes
    .filter((route) => route.status === "routed")
    .forEach((route) => {
      route.linkIds.forEach((linkId) => {
        demandByLink.set(linkId, (demandByLink.get(linkId) ?? 0) + route.trafficMbps);
        const routes = routesByLink.get(linkId) ?? [];
        routes.push(route);
        routesByLink.set(linkId, routes);
      });
    });

  const routeLinkAllocations = new Map();
  const routeTotals = new Map();
  const totalForRoute = (taskId, trafficMbps) => {
    const total =
      routeTotals.get(taskId) ??
      {
        carriedTrafficMbps: trafficMbps,
        queuedTrafficMb: 0,
        droppedTrafficMb: 0,
      };
    routeTotals.set(taskId, total);
    return total;
  };

  slice.links.forEach((link) => {
    const linkRoutes = routesByLink.get(link.id) ?? [];
    const newDemandMbps = demandByLink.get(link.id) ?? 0;
    const previousQueueMb = previousLinkQueueMb.get(link.id) ?? 0;
    const previousQueueMbps = (previousQueueMb * 8) / Math.max(dtSeconds, 1);
    const totalDemandMbps = link.state.isActive ? newDemandMbps + previousQueueMbps : 0;
    const capacityMbps = link.state.isActive ? Math.max(link.state.bandwidthMbps, 1) : 0;
    const carriedMbps = Math.min(totalDemandMbps, capacityMbps);
    const excessMb = (Math.max(totalDemandMbps - carriedMbps, 0) * dtSeconds) / 8;
    const queuedMb = Math.min(excessMb, config.trafficModel.linkQueueCapacityMb);
    const droppedMb = Math.max(excessMb - queuedMb, 0);
    const carriedPreviousQueueMbps = Math.min(previousQueueMbps, carriedMbps);
    let remainingNewCapacityMbps = Math.max(carriedMbps - carriedPreviousQueueMbps, 0);
    const unsentByTask = new Map();
    let totalNewUnsentMb = 0;

    [...linkRoutes]
      .sort((a, b) => b.priority - a.priority || a.task_id.localeCompare(b.task_id))
      .forEach((route) => {
        const carriedNewMbps = Math.min(route.trafficMbps, remainingNewCapacityMbps);
        remainingNewCapacityMbps = Math.max(remainingNewCapacityMbps - carriedNewMbps, 0);
        const unsentMb = (Math.max(route.trafficMbps - carriedNewMbps, 0) * dtSeconds) / 8;
        unsentByTask.set(route.task_id, unsentMb);
        totalNewUnsentMb += unsentMb;
        routeLinkAllocations.set(routeLinkAllocationKey(route.task_id, link.id), {
          carriedMbps: carriedNewMbps,
          queuedMb: unsentMb,
          droppedMb: 0,
        });
        const total = totalForRoute(route.task_id, route.trafficMbps);
        total.carriedTrafficMbps = Math.min(total.carriedTrafficMbps, carriedNewMbps);
      });

    const dropFraction = totalNewUnsentMb > 0 ? clamp(droppedMb / totalNewUnsentMb, 0, 1) : 0;
    linkRoutes.forEach((route) => {
      const key = routeLinkAllocationKey(route.task_id, link.id);
      const allocation = routeLinkAllocations.get(key) ?? {
        carriedMbps: route.trafficMbps,
        queuedMb: 0,
        droppedMb: 0,
      };
      const unsentMb = unsentByTask.get(route.task_id) ?? 0;
      const routeDroppedMb = unsentMb * dropFraction;
      allocation.queuedMb = Math.max(unsentMb - routeDroppedMb, 0);
      allocation.droppedMb = routeDroppedMb;
      routeLinkAllocations.set(key, allocation);
      const total = totalForRoute(route.task_id, route.trafficMbps);
      total.queuedTrafficMb += allocation.queuedMb;
      total.droppedTrafficMb += allocation.droppedMb;
    });

    previousLinkQueueMb.set(link.id, queuedMb);
  });

  return { routeLinkAllocations, routeTotals };
}

function businessCausalityAudit(slices, tasks, config) {
  const dtSeconds = config.time.stepMinutes * 60;
  const mismatches = [];
  const previousNodeQueueMb = new Map();
  const previousLinkQueueMb = new Map();
  const previousTelemetryBufferMb = new Map();
  let checkedActiveTaskSlices = 0;
  let checkedTaskNodeLoads = 0;
  let checkedRouteRecords = 0;
  let checkedRouteNodeTraffic = 0;
  let checkedLinkDemandMappings = 0;
  let checkedForwardingNodes = 0;
  let checkedTelemetryNodes = 0;
  let checkedQueueNodes = 0;
  let routedTaskSliceCount = 0;
  let localTaskSliceCount = 0;
  let nodesWithForwardingLoad = 0;
  let nodesWithTelemetryBuffer = 0;
  let checkedTaskTelemetryEffects = 0;
  let taskTelemetryGeneratedMb = 0;

  const taskById = new Map(tasks.map((task) => [task.task_id, task]));
  const expectedActiveSlices = new Map();
  tasks.forEach((task) => {
    taskActiveSlices(task, slices.length).forEach((sliceIndex) => {
      const entries = expectedActiveSlices.get(sliceIndex) ?? [];
      entries.push(task);
      expectedActiveSlices.set(sliceIndex, entries);
      checkedActiveTaskSlices += 1;
      if (task.source && task.target) routedTaskSliceCount += 1;
      if (task.node_id && !task.source && !task.target) localTaskSliceCount += 1;
    });
  });

  for (const slice of slices) {
    if (slice.index === 0) {
      previousNodeQueueMb.clear();
      previousLinkQueueMb.clear();
      previousTelemetryBufferMb.clear();
    }

    const expectedTasks = expectedActiveSlices.get(slice.index) ?? [];
    const routesByTask = new Map(slice.routes.map((route) => [route.task_id, route]));
    const nodesById = new Map(slice.nodes.map((node) => [node.id, node]));
    const linksById = new Map(slice.links.map((link) => [link.id, link]));

    expectedTasks.forEach((task) => {
      const route = routesByTask.get(task.task_id);
      checkedRouteRecords += 1;
      if (!route) {
        causalMismatch(mismatches, slice.index, task.task_id, "route record", "missing", "present", 0);
        return;
      }

      const expectedStatus = task.source && task.target ? "routed" : "not-requested";
      if (route.status !== expectedStatus) {
        causalMismatch(mismatches, slice.index, task.task_id, "route status", route.status, expectedStatus, 0);
      }
      if (!approxEqual(route.trafficMbps, task.traffic_mbps ?? 0, 0.001)) {
        causalMismatch(mismatches, slice.index, task.task_id, "route trafficMbps", route.trafficMbps, task.traffic_mbps ?? 0, 0.001);
      }
      if (!approxEqual(route.priority, Math.max(0, Math.round(task.priority ?? 0)), 0)) {
        causalMismatch(mismatches, slice.index, task.task_id, "route priority", route.priority, Math.max(0, Math.round(task.priority ?? 0)), 0);
      }
      if ((route.taskType ?? "") !== (task.task_type ?? "")) {
        causalMismatch(mismatches, slice.index, task.task_id, "route taskType", route.taskType ?? "", task.task_type ?? "", 0);
      }
    });

    slice.routes.forEach((route) => {
      if (!taskById.has(route.task_id)) {
        causalMismatch(mismatches, slice.index, route.task_id, "route task id", route.task_id, "known uploaded task", 0);
      }
    });

    const expectedTaskLoadByNode = new Map();
    const taskLoadForNode = (nodeId) => {
      const load =
        expectedTaskLoadByNode.get(nodeId) ??
        {
          taskCount: 0,
          computeUnits: 0,
          gpuUnits: 0,
          memoryGb: 0,
          storageGb: 0,
          trafficMbps: 0,
        };
      expectedTaskLoadByNode.set(nodeId, load);
      return load;
    };

    expectedTasks.forEach((task) => {
      const targetNode = task.node_id && !task.source && !task.target ? task.node_id : task.source;
      if (!targetNode) return;
      const load = taskLoadForNode(targetNode);
      load.taskCount += 1;
      load.computeUnits += task.compute_units;
      load.gpuUnits += task.gpu_units ?? 0;
      load.memoryGb += task.memory_gb ?? 0;
      load.storageGb += task.storage_gb ?? 0;
      load.trafficMbps += task.traffic_mbps ?? 0;
    });

    expectedTaskLoadByNode.forEach((expectedLoad, nodeId) => {
      const node = nodesById.get(nodeId);
      checkedTaskNodeLoads += 1;
      if (!node) {
        causalMismatch(mismatches, slice.index, nodeId, "task target node", "missing", "present", 0);
        return;
      }
      if (!approxEqual(node.taskLoad.taskCount, expectedLoad.taskCount, 0)) {
        causalMismatch(mismatches, slice.index, nodeId, "taskLoad.taskCount", node.taskLoad.taskCount, expectedLoad.taskCount, 0);
      }
      if (!approxEqual(node.taskLoad.computeUnits, expectedLoad.computeUnits, 0.001)) {
        causalMismatch(mismatches, slice.index, nodeId, "taskLoad.computeUnits", node.taskLoad.computeUnits, expectedLoad.computeUnits, 0.001);
      }
      if (!approxEqual(node.taskLoad.memoryGb, expectedLoad.memoryGb, 0.001)) {
        causalMismatch(mismatches, slice.index, nodeId, "taskLoad.memoryGb", node.taskLoad.memoryGb, expectedLoad.memoryGb, 0.001);
      }
      if (!approxEqual(node.resources.assigned_task_count, expectedLoad.taskCount, 0)) {
        causalMismatch(mismatches, slice.index, nodeId, "assigned_task_count", node.resources.assigned_task_count, expectedLoad.taskCount, 0);
      }
      if (!approxEqual(node.resources.workload_memory_gb, expectedLoad.memoryGb, 0.001)) {
        causalMismatch(mismatches, slice.index, nodeId, "workload_memory_gb", node.resources.workload_memory_gb, expectedLoad.memoryGb, 0.001);
      }
      if (!approxEqual(node.resources.workload_storage_gb, expectedLoad.storageGb, 0.001)) {
        causalMismatch(mismatches, slice.index, nodeId, "workload_storage_gb", node.resources.workload_storage_gb, expectedLoad.storageGb, 0.001);
      }
    });

    const expectedLinkDemandById = new Map();
    const addNodeValue = (map, nodeId, value) => map.set(nodeId, (map.get(nodeId) ?? 0) + value);

    slice.routes
      .filter((route) => route.status === "routed")
      .forEach((route) => {
        route.linkIds.forEach((linkId) => {
          expectedLinkDemandById.set(linkId, (expectedLinkDemandById.get(linkId) ?? 0) + route.trafficMbps);
        });
      });

    expectedLinkDemandById.forEach((expectedDemand, linkId) => {
      const link = linksById.get(linkId);
      checkedLinkDemandMappings += 1;
      if (!link) {
        causalMismatch(mismatches, slice.index, linkId, "route link", "missing", "present", 0);
        return;
      }
      if (link.state.demandTrafficMbps + 0.03 < expectedDemand) {
        causalMismatch(mismatches, slice.index, linkId, "demandTrafficMbps", link.state.demandTrafficMbps, `>= ${round(expectedDemand, 4)}`, 0.03);
      }
    });

    const priorityAllocations = priorityRouteAllocationsForSlice(slice, previousLinkQueueMb, config);
    const expectedIngressByNode = new Map();
    const expectedEgressByNode = new Map();
    const expectedTransitByNode = new Map();
    const expectedTaskTelemetryByNode = new Map();
    priorityAllocations.routeTotals.forEach((total, taskId) => {
      const route = routesByTask.get(taskId);
      if (!route || route.status !== "routed") return;
      if (!approxEqual(route.carriedTrafficMbps, total.carriedTrafficMbps, 0.03)) {
        causalMismatch(mismatches, slice.index, taskId, "route carriedTrafficMbps", route.carriedTrafficMbps, total.carriedTrafficMbps, 0.03);
      }
      if (!approxEqual(route.queuedTrafficMb, total.queuedTrafficMb, 0.03)) {
        causalMismatch(mismatches, slice.index, taskId, "route queuedTrafficMb", route.queuedTrafficMb, total.queuedTrafficMb, 0.03);
      }
      if (!approxEqual(route.droppedTrafficMb, total.droppedTrafficMb, 0.03)) {
        causalMismatch(mismatches, slice.index, taskId, "route droppedTrafficMb", route.droppedTrafficMb, total.droppedTrafficMb, 0.03);
      }
    });
    slice.routes
      .filter((route) => route.status === "routed")
      .forEach((route) => {
        const taskType = String(route.taskType ?? "").toLowerCase();
        const deliveredMb = (route.carriedTrafficMbps * dtSeconds) / 8;
        const firstHopAllocation = route.linkIds[0]
          ? priorityAllocations.routeLinkAllocations.get(routeLinkAllocationKey(route.task_id, route.linkIds[0]))
          : undefined;
        addNodeValue(expectedEgressByNode, route.source, firstHopAllocation?.carriedMbps ?? route.carriedTrafficMbps);
        addNodeValue(expectedIngressByNode, route.target, route.carriedTrafficMbps);
        if (taskType === "telemetry") {
          const telemetryMb = round(deliveredMb * config.trafficModel.telemetryTaskSamplingRatio, 2);
          addNodeValue(expectedTaskTelemetryByNode, route.source, telemetryMb);
          if (route.taskTelemetryNodeId !== route.source) {
            causalMismatch(mismatches, slice.index, route.task_id, "taskTelemetryNodeId", route.taskTelemetryNodeId ?? "", route.source, 0);
          }
          if (!approxEqual(route.taskTelemetryGeneratedMb, telemetryMb, 0.03)) {
            causalMismatch(
              mismatches,
              slice.index,
              route.task_id,
              "taskTelemetryGeneratedMb",
              route.taskTelemetryGeneratedMb,
              telemetryMb,
              0.03,
            );
          }
          if (telemetryMb > 0) {
            checkedTaskTelemetryEffects += 1;
            taskTelemetryGeneratedMb += telemetryMb;
          }
        } else if (taskType === "downlink") {
          const telemetryMb = round(deliveredMb * config.trafficModel.downlinkTaskSamplingRatio, 2);
          addNodeValue(expectedTaskTelemetryByNode, route.target, telemetryMb);
          if (route.taskTelemetryNodeId !== route.target) {
            causalMismatch(mismatches, slice.index, route.task_id, "taskTelemetryNodeId", route.taskTelemetryNodeId ?? "", route.target, 0);
          }
          if (!approxEqual(route.taskTelemetryGeneratedMb, telemetryMb, 0.03)) {
            causalMismatch(
              mismatches,
              slice.index,
              route.task_id,
              "taskTelemetryGeneratedMb",
              route.taskTelemetryGeneratedMb,
              telemetryMb,
              0.03,
            );
          }
          if (telemetryMb > 0) {
            checkedTaskTelemetryEffects += 1;
            taskTelemetryGeneratedMb += telemetryMb;
          }
        } else if (!approxEqual(route.taskTelemetryGeneratedMb ?? 0, 0, 0.001)) {
          causalMismatch(
            mismatches,
            slice.index,
            route.task_id,
            "taskTelemetryGeneratedMb",
            route.taskTelemetryGeneratedMb,
            0,
            0.001,
          );
        }
        route.path.slice(1, -1).forEach((nodeId, offset) => {
          const outgoingLinkId = route.linkIds[offset + 1];
          const allocation = outgoingLinkId
            ? priorityAllocations.routeLinkAllocations.get(routeLinkAllocationKey(route.task_id, outgoingLinkId))
            : undefined;
          addNodeValue(expectedTransitByNode, nodeId, allocation?.carriedMbps ?? route.carriedTrafficMbps);
        });
      });

    const expectedQueuedEffectByNode = new Map();
    const expectedDroppedEffectByNode = new Map();
    slice.routes
      .filter((route) => route.status === "routed")
      .forEach((route) => {
        route.linkIds.forEach((linkId, index) => {
          const upstreamNodeId = route.path[index] ?? route.source;
          const allocation = priorityAllocations.routeLinkAllocations.get(routeLinkAllocationKey(route.task_id, linkId)) ?? {
            queuedMb: 0,
            droppedMb: 0,
          };
          expectedQueuedEffectByNode.set(
            upstreamNodeId,
            (expectedQueuedEffectByNode.get(upstreamNodeId) ?? 0) + allocation.queuedMb,
          );
          expectedDroppedEffectByNode.set(
            upstreamNodeId,
            (expectedDroppedEffectByNode.get(upstreamNodeId) ?? 0) + allocation.droppedMb,
          );
        });
      });

    const allTrafficNodes = new Set([
      ...expectedIngressByNode.keys(),
      ...expectedEgressByNode.keys(),
      ...expectedTransitByNode.keys(),
    ]);
    allTrafficNodes.forEach((nodeId) => {
      const node = nodesById.get(nodeId);
      checkedRouteNodeTraffic += 1;
      if (!node) {
        causalMismatch(mismatches, slice.index, nodeId, "route traffic node", "missing", "present", 0);
        return;
      }
      const expectedIngress = expectedIngressByNode.get(nodeId) ?? 0;
      const expectedEgress = expectedEgressByNode.get(nodeId) ?? 0;
      const expectedTransit = expectedTransitByNode.get(nodeId) ?? 0;
      if (!approxEqual(node.resources.ingress_traffic_mbps, expectedIngress, 0.03)) {
        causalMismatch(mismatches, slice.index, nodeId, "ingress_traffic_mbps", node.resources.ingress_traffic_mbps, expectedIngress, 0.03);
      }
      if (!approxEqual(node.resources.egress_traffic_mbps, expectedEgress, 0.03)) {
        causalMismatch(mismatches, slice.index, nodeId, "egress_traffic_mbps", node.resources.egress_traffic_mbps, expectedEgress, 0.03);
      }
      if (!approxEqual(node.resources.transit_traffic_mbps, expectedTransit, 0.03)) {
        causalMismatch(mismatches, slice.index, nodeId, "transit_traffic_mbps", node.resources.transit_traffic_mbps, expectedTransit, 0.03);
      }
    });

    const carriedTrafficByNode = new Map();
    const activeIslByNode = new Map();
    const maxCongestionByNode = new Map();
    const utilizationSumByNode = new Map();
    const incidentCountByNode = new Map();
    const addEndpoint = (nodeId, link) => {
      carriedTrafficByNode.set(nodeId, (carriedTrafficByNode.get(nodeId) ?? 0) + link.state.carriedTrafficMbps);
      activeIslByNode.set(nodeId, (activeIslByNode.get(nodeId) ?? 0) + 1);
      maxCongestionByNode.set(
        nodeId,
        Math.max(maxCongestionByNode.get(nodeId) ?? 0, link.state.congestionPercent),
      );
      utilizationSumByNode.set(nodeId, (utilizationSumByNode.get(nodeId) ?? 0) + link.state.utilizationPercent);
      incidentCountByNode.set(nodeId, (incidentCountByNode.get(nodeId) ?? 0) + 1);
    };

    slice.links.filter((link) => link.state.isActive).forEach((link) => {
      addEndpoint(link.source, link);
      addEndpoint(link.target, link);
    });

    const activeSglByNode = new Map();
    const downlinkCapacityMbByNode = new Map();
    slice.groundLinks.filter((window) => window.status === "available").forEach((window) => {
      activeSglByNode.set(window.satellite_id, (activeSglByNode.get(window.satellite_id) ?? 0) + 1);
      downlinkCapacityMbByNode.set(
        window.satellite_id,
        (downlinkCapacityMbByNode.get(window.satellite_id) ?? 0) + (window.reportCapacityMbps * dtSeconds) / 8,
      );
    });

    slice.nodes.forEach((node) => {
      const carriedTraffic = carriedTrafficByNode.get(node.id) ?? 0;
      const activeIsl = activeIslByNode.get(node.id) ?? 0;
      const activeSgl = activeSglByNode.get(node.id) ?? 0;
      checkedForwardingNodes += 1;
      checkedTelemetryNodes += 1;
      checkedQueueNodes += 1;
      if (carriedTraffic > 0) nodesWithForwardingLoad += 1;
      if (node.resources.telemetry_buffer_mb > 0) nodesWithTelemetryBuffer += 1;

      if (!approxEqual(node.resources.forwarding_load_mbps, carriedTraffic, 0.03)) {
        causalMismatch(mismatches, slice.index, node.id, "forwarding_load_mbps", node.resources.forwarding_load_mbps, carriedTraffic, 0.03);
      }
      if (!approxEqual(node.resources.active_isl_links, activeIsl, 0)) {
        causalMismatch(mismatches, slice.index, node.id, "active_isl_links", node.resources.active_isl_links, activeIsl, 0);
      }
      if (!approxEqual(node.resources.active_sgl_links, activeSgl, 0)) {
        causalMismatch(mismatches, slice.index, node.id, "active_sgl_links", node.resources.active_sgl_links, activeSgl, 0);
      }

      const expectedTelemetryGeneratedMb = round(
        config.trafficModel.telemetryGenerationMbPerSlice +
          node.resources.cpu_utilization * config.trafficModel.telemetryCpuMbPerPercent +
          (carriedTraffic / 1000) * config.trafficModel.telemetryTrafficMbPerGbps +
          (maxCongestionByNode.get(node.id) ?? 0) * config.trafficModel.telemetryCongestionMbPerPercent +
          (expectedTaskTelemetryByNode.get(node.id) ?? 0),
        2,
      );
      if (!approxEqual(node.resources.telemetry_generated_mb, expectedTelemetryGeneratedMb, 0.03)) {
        causalMismatch(mismatches, slice.index, node.id, "telemetry_generated_mb", node.resources.telemetry_generated_mb, expectedTelemetryGeneratedMb, 0.03);
      }

      const previousTelemetry = previousTelemetryBufferMb.get(node.id) ?? 0;
      const telemetryAvailableMb = previousTelemetry + expectedTelemetryGeneratedMb;
      const downlinkCapacityMb = downlinkCapacityMbByNode.get(node.id) ?? 0;
      const expectedDownlinkedMb = Math.min(telemetryAvailableMb, downlinkCapacityMb);
      const expectedTelemetryBufferMb = Math.min(
        Math.max(telemetryAvailableMb - expectedDownlinkedMb, 0),
        config.trafficModel.telemetryBufferCapacityMb,
      );
      if (!approxEqual(node.resources.telemetry_downlinked_mb, expectedDownlinkedMb, 0.03)) {
        causalMismatch(mismatches, slice.index, node.id, "telemetry_downlinked_mb", node.resources.telemetry_downlinked_mb, expectedDownlinkedMb, 0.03);
      }
      if (!approxEqual(node.resources.telemetry_buffer_mb, expectedTelemetryBufferMb, 0.03)) {
        causalMismatch(mismatches, slice.index, node.id, "telemetry_buffer_mb", node.resources.telemetry_buffer_mb, expectedTelemetryBufferMb, 0.03);
      }
      previousTelemetryBufferMb.set(node.id, node.resources.telemetry_buffer_mb);

      const previousQueue = previousNodeQueueMb.get(node.id) ?? 0;
      const queueAfterDrainMb =
        previousQueue * config.trafficModel.queueCarryoverRatio + (expectedQueuedEffectByNode.get(node.id) ?? 0);
      const expectedQueueDroppedMb = Math.max(queueAfterDrainMb - config.trafficModel.cacheCapacityMb, 0);
      const expectedQueueMb = Math.min(
        Math.max(queueAfterDrainMb, 0),
        config.trafficModel.cacheCapacityMb,
      );
      const expectedDroppedMb = (expectedDroppedEffectByNode.get(node.id) ?? 0) + expectedQueueDroppedMb;
      if (!approxEqual(node.resources.queued_traffic_mb, expectedQueueMb, 0.5)) {
        causalMismatch(mismatches, slice.index, node.id, "queued_traffic_mb", node.resources.queued_traffic_mb, expectedQueueMb, 0.5);
      }
      if (!approxEqual(node.resources.dropped_traffic_mb, expectedDroppedMb, 0.5)) {
        causalMismatch(mismatches, slice.index, node.id, "dropped_traffic_mb", node.resources.dropped_traffic_mb, expectedDroppedMb, 0.5);
      }
      previousNodeQueueMb.set(node.id, node.resources.queued_traffic_mb);
    });
  }

  return {
    passed: mismatches.length === 0,
    checkedActiveTaskSlices,
    checkedTaskNodeLoads,
    checkedRouteRecords,
    checkedRouteNodeTraffic,
    checkedLinkDemandMappings,
    checkedForwardingNodes,
    checkedTelemetryNodes,
    checkedQueueNodes,
    routedTaskSliceCount,
    localTaskSliceCount,
    nodesWithForwardingLoad,
    nodesWithTelemetryBuffer,
    checkedTaskTelemetryEffects,
    taskTelemetryGeneratedMb: round(taskTelemetryGeneratedMb, 2),
    mismatchCount: mismatches.length,
    sampleMismatches: mismatches,
  };
}

function normalizeDegrees(degrees) {
  return ((degrees % 360) + 360) % 360;
}

function angleDeltaDeg(a, b) {
  return Math.abs(((a - b + 540) % 360) - 180);
}

function vectorMagnitude(vector) {
  return Math.sqrt(vector.x * vector.x + vector.y * vector.y + vector.z * vector.z);
}

function orbitTopologyConsistency(slices, config) {
  const mismatches = [];
  const { constellation } = config;
  const expectedNodeCount = constellation.planes * constellation.satellitesPerPlane;
  const expectedPlaneSpacingDeg =
    (constellation.walkerType === "delta" ? 360 : 180) / constellation.planes;
  const expectedSemiMajorAxisKm = constellation.earthRadiusKm + constellation.altitudeKm;
  const expectedVelocityKmS = Math.sqrt(
    constellation.gravitationalParameterKm3S2 / expectedSemiMajorAxisKm,
  );
  let checkedNodes = 0;
  let checkedSlices = 0;
  let checkedPolarInterPlaneLinks = 0;

  const addMismatch = (slice, subject, field, actual, expected, tolerance) => {
    if (mismatches.length >= 16) return;
    mismatches.push({
      slice: slice.index,
      subject,
      field,
      actual: typeof actual === "number" ? round(actual, 4) : actual,
      expected: typeof expected === "number" ? round(expected, 4) : expected,
      tolerance,
    });
  };

  for (const slice of slices) {
    checkedSlices += 1;
    if (slice.nodes.length !== expectedNodeCount) {
      addMismatch(slice, "slice", "node count", slice.nodes.length, expectedNodeCount, 0);
    }

    const nodesById = new Map(slice.nodes.map((node) => [node.id, node]));
    const nodesByPlane = new Map();

    for (const node of slice.nodes) {
      checkedNodes += 1;
      const orbit = node.orbit;
      const expectedRaanDeg = normalizeDegrees(node.plane * expectedPlaneSpacingDeg);
      const actualRadiusKm = vectorMagnitude(node.timeState.eci);

      if (orbit.orbitModel !== "tle-sgp4") {
        addMismatch(slice, node.id, "orbitModel", orbit.orbitModel, "tle-sgp4", 0);
      }
      if (orbit.shellId !== constellation.shellId) {
        addMismatch(slice, node.id, "shellId", orbit.shellId, constellation.shellId, 0);
      }
      if (orbit.plane !== node.plane || orbit.slot !== node.slot) {
        addMismatch(slice, node.id, "plane/slot", `${orbit.plane}/${orbit.slot}`, `${node.plane}/${node.slot}`, 0);
      }
      if (!approxEqual(orbit.semiMajorAxisKm, expectedSemiMajorAxisKm, 0.001)) {
        addMismatch(slice, node.id, "semiMajorAxisKm", orbit.semiMajorAxisKm, expectedSemiMajorAxisKm, 0.001);
      }
      if (!approxEqual(orbit.inclinationDeg, constellation.inclinationDeg, 0.001)) {
        addMismatch(slice, node.id, "inclinationDeg", orbit.inclinationDeg, constellation.inclinationDeg, 0.001);
      }
      if (angleDeltaDeg(orbit.raanDeg, expectedRaanDeg) > 0.001) {
        addMismatch(slice, node.id, "raanDeg", orbit.raanDeg, expectedRaanDeg, 0.001);
      }
      if (!orbit.tleLine1 || !orbit.tleLine2 || !orbit.noradId || !orbit.satelliteName || !orbit.cosparId) {
        addMismatch(slice, node.id, "TLE metadata", "missing", "present", 0);
      }
      if (Math.abs(actualRadiusKm - expectedSemiMajorAxisKm) > 35) {
        addMismatch(slice, node.id, "ECI radius", actualRadiusKm, expectedSemiMajorAxisKm, 35);
      }
      if (Math.abs(node.timeState.altitudeKm - constellation.altitudeKm) > 35) {
        addMismatch(slice, node.id, "altitudeKm", node.timeState.altitudeKm, constellation.altitudeKm, 35);
      }
      if (Math.abs(node.timeState.orbitalVelocityKmS - expectedVelocityKmS) > 0.08) {
        addMismatch(slice, node.id, "orbitalVelocityKmS", node.timeState.orbitalVelocityKmS, expectedVelocityKmS, 0.08);
      }
      if (Math.abs(node.timeState.latitudeDeg) > constellation.inclinationDeg + 1) {
        addMismatch(slice, node.id, "latitudeDeg", node.timeState.latitudeDeg, `<= ${constellation.inclinationDeg + 1}`, 1);
      }

      const planeNodes = nodesByPlane.get(node.plane) ?? [];
      planeNodes.push(node);
      nodesByPlane.set(node.plane, planeNodes);
    }

    for (let plane = 0; plane < constellation.planes; plane += 1) {
      const planeNodes = nodesByPlane.get(plane) ?? [];
      if (planeNodes.length !== constellation.satellitesPerPlane) {
        addMismatch(slice, `plane-${plane}`, "satellitesPerPlane", planeNodes.length, constellation.satellitesPerPlane, 0);
      }
    }

    if (config.polarRegion.enabled) {
      for (const link of slice.links.filter((item) => item.kind === "inter-plane")) {
        const source = nodesById.get(link.source);
        const target = nodesById.get(link.target);
        if (!source || !target) continue;
        const endpointInPolarRegion =
          Math.abs(source.timeState.latitudeDeg) >= config.polarRegion.latitudeDeg ||
          Math.abs(target.timeState.latitudeDeg) >= config.polarRegion.latitudeDeg;
        if (!endpointInPolarRegion) continue;
        checkedPolarInterPlaneLinks += 1;
        if (link.state.isActive || link.state.restrictionReason !== "polar-region") {
          addMismatch(
            slice,
            link.id,
            "polar inter-plane restriction",
            `${link.state.status}/${link.state.restrictionReason ?? "none"}`,
            "down/polar-region",
            0,
          );
        }
      }
    }
  }

  return {
    passed: mismatches.length === 0,
    checkedSlices,
    checkedNodes,
    checkedPolarInterPlaneLinks,
    expectedNodeCount,
    expectedPlaneSpacingDeg,
    expectedVelocityKmS: round(expectedVelocityKmS, 4),
    mismatchCount: mismatches.length,
    sampleMismatches: mismatches,
  };
}

function emptyOperationalInvariants(slices) {
  const nodes = everyNode(slices);
  const links = everyLink(slices);
  const routes = slices.flatMap((slice) => slice.routes);

  return {
    hasNoRoutes: routes.length === 0,
    hasNoAssignedTasks: nodes.every((node) => node.resources.assigned_task_count === 0),
    hasNoCpuOrGpuLoad: nodes.every(
      (node) =>
        node.resources.cpu_utilization === 0 &&
        (node.resources.gpu_utilization === undefined || node.resources.gpu_utilization === 0) &&
        node.resources.workload_cpu_percent === 0 &&
        (node.resources.workload_gpu_percent === undefined || node.resources.workload_gpu_percent === 0),
    ),
    hasNoTaskMemoryOrStorage: nodes.every(
      (node) => node.resources.workload_memory_gb === 0 && node.resources.workload_storage_gb === 0,
    ),
    hasNoBusinessTraffic: nodes.every(
      (node) =>
        node.resources.ingress_traffic_mbps === 0 &&
        node.resources.egress_traffic_mbps === 0 &&
        node.resources.transit_traffic_mbps === 0 &&
        node.resources.forwarding_load_mbps === 0,
    ),
    hasNoBusinessQueues: nodes.every(
      (node) => node.resources.queued_traffic_mb === 0 && node.resources.dropped_traffic_mb === 0,
    ),
    hasNoLinkBusinessDemand: links.every(
      (link) =>
        link.state.demandTrafficMbps === 0 &&
        link.state.carriedTrafficMbps === 0 &&
        link.state.queuedTrafficMb === 0 &&
        link.state.droppedTrafficMb === 0 &&
        link.state.congestionPercent === 0,
    ),
    hasNoLinkUtilization: links.every((link) => link.state.utilizationPercent === 0),
  };
}

function uploadedOperationalInvariants(slices) {
  const routeSlices = slices.flatMap((slice) => slice.routes.map((route) => ({ slice, route })));
  const routedRouteSlices = routeSlices.filter(({ route }) => route.status === "routed");
  const localComputeNode = slices
    .find((slice) => slice.index === 8)
    ?.nodes.find((node) => node.id === "P03-S02");

  const routeLinksExist = routedRouteSlices.every(({ slice, route }) => {
    const linksById = new Map(slice.links.map((link) => [link.id, link]));
    return (
      route.linkIds.length > 0 &&
      route.linkIds.every((linkId) => {
        const link = linksById.get(linkId);
        return Boolean(
          link &&
            link.state.isActive &&
            link.state.demandTrafficMbps >= route.trafficMbps &&
            link.state.carriedTrafficMbps > 0,
        );
      })
    );
  });

  const routedTrafficReachesNodes = routedRouteSlices.some(({ slice, route }) => {
    const nodesById = new Map(slice.nodes.map((node) => [node.id, node]));
    const source = route.source ? nodesById.get(route.source) : undefined;
    const target = route.target ? nodesById.get(route.target) : undefined;
    const transitNode = route.path.slice(1, -1).map((nodeId) => nodesById.get(nodeId)).find(Boolean);
    const deliveredTrafficMbps = route.carriedTrafficMbps ?? route.trafficMbps;
    return Boolean(
      source &&
        target &&
        source.resources.egress_traffic_mbps >= deliveredTrafficMbps &&
        target.resources.ingress_traffic_mbps >= deliveredTrafficMbps &&
        transitNode &&
        transitNode.resources.transit_traffic_mbps >= deliveredTrafficMbps,
    );
  });

  const workloadMemoryAndStorageAreAccounted = everyNode(slices).every(
    (node) =>
      node.resources.memory_used_gb + 1e-9 >= node.resources.workload_memory_gb &&
      node.resources.storage_used_gb + 1e-9 >= node.resources.workload_storage_gb,
  );

  return {
    localComputeTaskUpdatesNode:
      Boolean(localComputeNode) &&
      localComputeNode.resources.assigned_task_count >= 1 &&
      localComputeNode.resources.cpu_utilization >= 25 &&
      (localComputeNode.resources.gpu_utilization ?? 0) >= 25 &&
      localComputeNode.resources.workload_memory_gb >= 4 &&
      localComputeNode.resources.workload_storage_gb >= 12,
    routeLinksExist,
    routedTrafficReachesNodes,
    workloadMemoryAndStorageAreAccounted,
    hasFormulaDrivenEnergyAndTelemetry: everyNode(slices).some(
      (node) =>
        node.resources.telemetry_generated_mb > 0 &&
        node.resources.load_power_w > 330 &&
        node.resources.net_power_w !== 0,
    ),
  };
}

function routeDynamicsInvariants(slices) {
  const routeSlices = slices.flatMap((slice) => slice.routes.map((route) => ({ slice, route })));
  const routedRouteSlices = routeSlices.filter(({ route }) => route.status === "routed");

  const allRoutesUseActiveLinks = routedRouteSlices.every(({ slice, route }) => {
    const linksById = new Map(slice.links.map((link) => [link.id, link]));
    return route.linkIds.every((linkId) => linksById.get(linkId)?.state.isActive);
  });

  const topologyConstraintsOccurDuringTraffic = routeSlices.some(
    ({ slice }) =>
      slice.routes.some((route) => route.status === "routed") &&
      slice.links.some((link) => !link.state.isActive && Boolean(link.state.restrictionReason)),
  );

  const routesByTask = new Map();
  routedRouteSlices.forEach(({ route }) => {
    const entries = routesByTask.get(route.task_id) ?? [];
    entries.push(route);
    routesByTask.set(route.task_id, entries);
  });

  const hasPersistentTaskWithPathChanges = [...routesByTask.values()].some((routes) => {
    const uniquePaths = new Set(routes.map((route) => route.linkIds.join("|")));
    return routes.length >= 3 && uniquePaths.size >= 2;
  });

  return {
    allRoutesUseActiveLinks,
    topologyConstraintsOccurDuringTraffic,
    hasPersistentTaskWithPathChanges,
  };
}

function truthFingerprint(slices) {
  return JSON.stringify(
    slices.map((slice) => ({
      index: slice.index,
      time: slice.time,
      nodes: slice.nodes.map((node) => ({
        id: node.id,
        mode: node.state.mode,
        batteryPercent: node.state.batteryPercent,
        cpuLoadPercent: node.state.cpuLoadPercent,
        temperatureC: node.state.temperatureC,
        queueDepth: node.state.queueDepth,
        latitudeDeg: round(node.timeState.latitudeDeg, 6),
        longitudeDeg: round(node.timeState.longitudeDeg, 6),
        altitudeKm: round(node.timeState.altitudeKm, 3),
        inSunlight: node.timeState.inSunlight,
        energyWh: node.resources.energy_wh,
        cpuUtilization: node.resources.cpu_utilization,
        computeCpuPercent: node.resources.compute_cpu_percent,
        forwardingCpuPercent: node.resources.forwarding_cpu_percent,
        queueCpuPercent: node.resources.queue_cpu_percent,
        memoryUsedGb: node.resources.memory_used_gb,
        storageUsedGb: node.resources.storage_used_gb,
        forwardingLoadMbps: node.resources.forwarding_load_mbps,
        communicationPowerW: node.resources.communication_power_w,
        queuedTrafficMb: node.resources.queued_traffic_mb,
        droppedTrafficMb: node.resources.dropped_traffic_mb,
        telemetryBufferMb: node.resources.telemetry_buffer_mb,
        telemetryDownlinkedMb: node.resources.telemetry_downlinked_mb,
      })),
      links: slice.links.map((link) => ({
        id: link.id,
        source: link.source,
        target: link.target,
        kind: link.kind,
        status: link.state.status,
        isActive: link.state.isActive,
        restrictionReason: link.state.restrictionReason ?? "",
        distanceKm: link.state.distanceKm,
        bandwidthMbps: link.state.bandwidthMbps,
        utilizationPercent: link.state.utilizationPercent,
        demandTrafficMbps: link.state.demandTrafficMbps,
        carriedTrafficMbps: link.state.carriedTrafficMbps,
        queuedTrafficMb: link.state.queuedTrafficMb,
        droppedTrafficMb: link.state.droppedTrafficMb,
        congestionPercent: link.state.congestionPercent,
        sinrDb: link.state.linkBudget?.sinr_db ?? null,
        capacityMbps: link.state.linkBudget?.capacity_mbps ?? null,
      })),
      routes: slice.routes.map((route) => ({
        taskId: route.task_id,
        source: route.source ?? "",
        target: route.target ?? "",
        status: route.status,
        path: route.path,
        linkIds: route.linkIds,
        hopCount: route.hopCount,
        latencyMs: route.latencyMs,
        trafficMbps: route.trafficMbps,
        reason: route.reason ?? "",
      })),
    })),
  );
}

function compactFingerprint(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

const scenarioSlices = Object.fromEntries(profiles.map((profile) => [profile, runProfile(profile)]));
const scenarioMetrics = Object.fromEntries(profiles.map((profile) => [profile, summarize(scenarioSlices[profile])]));
const repeatedHighLoadSlices = runProfile("high-load");
const demoWaveStressHighLoadSlices = runProfileWithDemoWaveStress("high-load");
const repeatHighLoad = summarize(repeatedHighLoadSlices);
const demoWaveStressHighLoad = summarize(demoWaveStressHighLoadSlices);
const highLoadFingerprint = truthFingerprint(scenarioSlices["high-load"]);
const repeatedHighLoadFingerprint = truthFingerprint(repeatedHighLoadSlices);
const demoWaveStressHighLoadFingerprint = truthFingerprint(demoWaveStressHighLoadSlices);
const deterministic = JSON.stringify(scenarioMetrics["high-load"]) === JSON.stringify(repeatHighLoad);
const highLoadTruthDeterministic = highLoadFingerprint === repeatedHighLoadFingerprint;
const demoWaveStressInvariant =
  JSON.stringify(scenarioMetrics["high-load"]) === JSON.stringify(demoWaveStressHighLoad) &&
  highLoadFingerprint === demoWaveStressHighLoadFingerprint;
const uploadedDatasetText = await readFile(uploadedDatasetPath, "utf8");
const uploadedRun = runUploadedDataset(uploadedDatasetText, uploadedDatasetPath);
const uploadedMetrics = summarize(uploadedRun.slices);
const uploadedJsonDatasetText = await readFile(uploadedJsonDatasetPath, "utf8");
const uploadedJsonRun = runUploadedDataset(uploadedJsonDatasetText, uploadedJsonDatasetPath);
const uploadedJsonMetrics = summarize(uploadedJsonRun.slices);
const repeatedUploadedRun = runUploadedDataset(uploadedDatasetText, uploadedDatasetPath);
const repeatedUploadedMetrics = summarize(repeatedUploadedRun.slices);
const uploadedFingerprint = truthFingerprint(uploadedRun.slices);
const uploadedJsonFingerprint = truthFingerprint(uploadedJsonRun.slices);
const repeatedUploadedFingerprint = truthFingerprint(repeatedUploadedRun.slices);
const uploadedDeterministic = JSON.stringify(uploadedMetrics) === JSON.stringify(repeatedUploadedMetrics);
const uploadedTruthDeterministic = uploadedFingerprint === repeatedUploadedFingerprint;
const standardDatasetFormatEquivalence = {
  csvPath: uploadedDatasetPath,
  jsonPath: uploadedJsonDatasetPath,
  csvAccepted: uploadedRun.validation.accepted,
  jsonAccepted: uploadedJsonRun.validation.accepted,
  csvErrors: uploadedRun.validation.errors.length,
  jsonErrors: uploadedJsonRun.validation.errors.length,
  metricsEqual: JSON.stringify(uploadedMetrics) === JSON.stringify(uploadedJsonMetrics),
  truthFingerprintEqual: uploadedFingerprint === uploadedJsonFingerprint,
  csvTruthFingerprintHash: compactFingerprint(uploadedFingerprint),
  jsonTruthFingerprintHash: compactFingerprint(uploadedJsonFingerprint),
  csvTruthFingerprintLength: uploadedFingerprint.length,
  jsonTruthFingerprintLength: uploadedJsonFingerprint.length,
};
const emptyInvariants = emptyOperationalInvariants(scenarioSlices.empty);
const uploadedInvariants = uploadedOperationalInvariants(uploadedRun.slices);
const routeDynamics = routeDynamicsInvariants(scenarioSlices["long-duration"]);
const uploadedRouteDynamics = routeDynamicsInvariants(uploadedRun.slices);
const resourceFormulaChecks = resourceFormulaConsistency(
  [...Object.values(scenarioSlices).flat(), ...uploadedRun.slices],
  auditConfig,
);
const linkTrafficFormulaChecks = linkTrafficFormulaConsistency(
  [...Object.values(scenarioSlices).flat(), ...uploadedRun.slices],
  auditConfig,
);
const routePathFormulaChecks = routePathFormulaConsistency(
  [...Object.values(scenarioSlices).flat(), ...uploadedRun.slices],
);
const orbitTopologyChecks = orbitTopologyConsistency(scenarioSlices.normal, auditConfig);
const businessCausalityChecks = businessCausalityAudit(uploadedRun.slices, uploadedRun.tasks, auditConfig);
const scenarioTemplateValidations = validateScenarioTemplates(profiles);
const invalidDatasetText = [
  "task_id,time,start_slice,duration_slices,source,target,node_id,compute_units,gpu_units,memory_gb,storage_gb,traffic_mbps,priority,task_type",
  "BAD-001,T00,0,2,P01-S01,,,10,0,1,1,120,1,missing-target",
  "BAD-002,T01,1,2,,,P02-S02,10,0,1,1,50,1,local-with-traffic",
  "BAD-003,T02,2,2,P01-S01,P02-S02,P03-S03,10,0,1,1,10,1,ambiguous-endpoints",
  "BAD-004,T03,3,2,P99-S99,P02-S02,,10,0,1,1,10,1,missing-node",
  "BAD-005,T04,4,2,P01-S01,P02-S02,,not-a-number,0,1,1,abc,1,malformed-numeric",
  "BAD-006,T05,5,2,P01-S01,P02-S02,,10,0,1,1,10,1,unsupported-type",
  "BAD-007,T06,6,2,P01-S01,P01-S01,,10,0,1,1,10,1,routing",
].join("\n");
const invalidDatasetRun = runUploadedDataset(invalidDatasetText, "invalid-stage1.csv");
const aliasDatasetText = [
  "flow_id,time,start,duration,src,dst,node,compute,gpu,memory,storage,traffic,priority,type",
  "ALIAS-001,T00,0,2,P01-S01,P02-S02,,10,0,1,1,120,1,routing",
  "ALIAS-002,T02,2,3,,,P03-S02,16,2,1.5,2,0,2,compute",
].join("\n");
const aliasDatasetRun = runUploadedDataset(aliasDatasetText, "alias-stage1.csv");
const aliasDatasetNormalized = {
  accepted: aliasDatasetRun.validation.accepted,
  errors: aliasDatasetRun.validation.errors.length,
  routedTasks: aliasDatasetRun.tasks.filter((task) => task.source && task.target).length,
  localTasks: aliasDatasetRun.tasks.filter((task) => task.node_id && !task.source && !task.target).length,
  firstTaskId: aliasDatasetRun.tasks[0]?.task_id ?? "",
  firstTaskSource: aliasDatasetRun.tasks[0]?.source ?? "",
  firstTaskTarget: aliasDatasetRun.tasks[0]?.target ?? "",
  secondTaskNodeId: aliasDatasetRun.tasks[1]?.node_id ?? "",
};
const powerSavingRoutingGateRun = runPowerSavingRoutingGate();
const powerSavingRoutingGate = {
  validationErrors: powerSavingRoutingGateRun.validation.errors.length,
  unavailableNodes: powerSavingRoutingGateRun.slices[0]?.nodes.filter((node) => !node.resources.can_accept_tasks).length ?? 0,
  totalNodes: powerSavingRoutingGateRun.slices[0]?.nodes.length ?? 0,
  activePhysicalLinks: powerSavingRoutingGateRun.slices[0]?.links.filter((link) => link.state.isActive).length ?? 0,
  routedRoutes: powerSavingRoutingGateRun.slices.flatMap((slice) => slice.routes).filter((route) => route.status === "routed").length,
  unroutableRoutes: powerSavingRoutingGateRun.slices.flatMap((slice) => slice.routes).filter((route) => route.status === "unroutable").length,
  routesBlockedByPower: powerSavingRoutingGateRun.slices
    .flatMap((slice) => slice.routes)
    .some((route) => route.status === "unroutable" && /节能|不可接收/.test(route.reason ?? "")),
};
const priorityDatasetText = [
  "task_id,time,start_slice,duration_slices,source,target,node_id,compute_units,gpu_units,memory_gb,storage_gb,traffic_mbps,priority,task_type",
  "PRIORITY-HIGH,T00,0,1,P01-S01,P01-S02,,0,0,0,0,3000,5,routing",
  "PRIORITY-LOW,T00,0,1,P01-S01,P01-S02,,0,0,0,0,3000,1,routing",
].join("\n");
const priorityDatasetRun = runUploadedDataset(priorityDatasetText, "priority-stage1.csv");
const priorityRoutes = priorityDatasetRun.slices[0]?.routes ?? [];
const highPriorityRoute = priorityRoutes.find((route) => route.task_id === "PRIORITY-HIGH");
const lowPriorityRoute = priorityRoutes.find((route) => route.task_id === "PRIORITY-LOW");
const priorityScheduling = {
  validationErrors: priorityDatasetRun.validation.errors.length,
  highPriority: highPriorityRoute?.priority ?? 0,
  lowPriority: lowPriorityRoute?.priority ?? 0,
  highCarriedMbps: highPriorityRoute?.carriedTrafficMbps ?? 0,
  lowCarriedMbps: lowPriorityRoute?.carriedTrafficMbps ?? 0,
  highQueuedMb: highPriorityRoute?.queuedTrafficMb ?? 0,
  lowQueuedMb: lowPriorityRoute?.queuedTrafficMb ?? 0,
  highDroppedMb: highPriorityRoute?.droppedTrafficMb ?? 0,
  lowDroppedMb: lowPriorityRoute?.droppedTrafficMb ?? 0,
  commonPath:
    Boolean(highPriorityRoute && lowPriorityRoute) &&
    highPriorityRoute.linkIds.join("|") === lowPriorityRoute.linkIds.join("|") &&
    highPriorityRoute.linkIds.length > 0,
};

const checks = [
  [
    "empty traffic keeps operational resources idle",
      scenarioMetrics.empty.activeTasks === 0 &&
      scenarioMetrics.empty.maxCpuPercent === 0 &&
      scenarioMetrics.empty.maxForwardingLoadMbps === 0 &&
      scenarioMetrics.empty.maxNodeQueueMb === 0 &&
      scenarioMetrics.empty.maxLinkUtilizationPercent === 0 &&
      scenarioMetrics.empty.maxNodeLinkOccupancyPercent === 0,
  ],
  [
    "empty traffic has no business-side effects",
    Object.values(emptyInvariants).every(Boolean),
  ],
  [
    "empty traffic still follows sunlight energy cycle",
    scenarioMetrics.empty.sunlightNodeSamples > 0 &&
      scenarioMetrics.empty.eclipseNodeSamples > 0 &&
      scenarioMetrics.empty.minEnergyWh >= 240 &&
      scenarioMetrics.empty.maxEnergyWh > scenarioMetrics.empty.minEnergyWh,
  ],
  [
    "low-load scenario routes without overload",
    scenarioMetrics["low-load"].routedTasks > 0 &&
      scenarioMetrics["low-load"].unroutableTasks === 0 &&
      scenarioMetrics["low-load"].maxLinkCongestionPercent < 1,
  ],
  [
    "high-load scenario stresses nodes and links more than low-load",
    scenarioMetrics["high-load"].maxCpuPercent > scenarioMetrics["low-load"].maxCpuPercent &&
      scenarioMetrics["high-load"].maxLinkDemandMbps > scenarioMetrics["low-load"].maxLinkDemandMbps &&
      scenarioMetrics["high-load"].maxCommunicationPowerW > scenarioMetrics["low-load"].maxCommunicationPowerW,
  ],
  [
    "node resource formulas respond to workload and cache pressure",
    scenarioMetrics["high-load"].maxMemoryPercent > scenarioMetrics["low-load"].maxMemoryPercent &&
      scenarioMetrics["high-load"].maxStoragePercent > scenarioMetrics["low-load"].maxStoragePercent &&
      scenarioMetrics["high-load"].maxTemperatureC > scenarioMetrics["low-load"].maxTemperatureC &&
      scenarioMetrics["high-load"].maxLoadPowerW > scenarioMetrics["low-load"].maxLoadPowerW &&
      scenarioMetrics["high-load"].maxForwardingCpuPercent > scenarioMetrics["low-load"].maxForwardingCpuPercent &&
      scenarioMetrics["high-load"].maxNetworkComputePowerW > scenarioMetrics["low-load"].maxNetworkComputePowerW,
  ],
  [
    "hotspot scenario creates localized pressure",
    scenarioMetrics.hotspot.maxNodeQueueMb > scenarioMetrics["low-load"].maxNodeQueueMb &&
      scenarioMetrics.hotspot.maxForwardingLoadMbps > scenarioMetrics["low-load"].maxForwardingLoadMbps,
  ],
  [
    "burst scenario creates visible queue or congestion",
    scenarioMetrics.burst.maxLinkQueueMb > 0 || scenarioMetrics.burst.maxLinkCongestionPercent > 0,
  ],
  [
    "long-duration scenario remains active across most time slices",
    scenarioMetrics["long-duration"].activeRouteSlices >= Math.floor(scenarioMetrics["long-duration"].slices * 0.75),
  ],
  [
    "business traffic updates telemetry and downlink buffers",
    scenarioMetrics.normal.maxTelemetryBufferMb > 0 && scenarioMetrics.normal.maxTelemetryDownlinkedMb > 0,
  ],
  [
    "node resource state matches configured formulas",
    resourceFormulaChecks.passed && resourceFormulaChecks.checkedNodes > 0,
  ],
  [
    "link traffic state matches configured queue formulas",
    linkTrafficFormulaChecks.passed && linkTrafficFormulaChecks.checkedLinks > 0,
  ],
  [
    "topology and link physics remain active during stage-one scenarios",
    scenarioMetrics.normal.activeLinkSamples > 0 &&
      scenarioMetrics.normal.linkBudgetSamples > 0 &&
      scenarioMetrics.normal.polarBlockedSamples > 0,
  ],
  [
    "walker orbit geometry and polar restrictions match configuration",
    orbitTopologyChecks.passed &&
      orbitTopologyChecks.checkedNodes > 0 &&
      orbitTopologyChecks.checkedPolarInterPlaneLinks > 0,
  ],
  [
    "routes avoid inactive links and reselect paths over time",
    Object.values(routeDynamics).every(Boolean) && Object.values(uploadedRouteDynamics).every(Boolean),
  ],
  [
    "route path state matches active shortest-path formulas",
    routePathFormulaChecks.passed && routePathFormulaChecks.checkedRoutes > 0,
  ],
  [
    "power-saving nodes are excluded from business routing",
    powerSavingRoutingGate.validationErrors === 0 &&
      powerSavingRoutingGate.unavailableNodes === powerSavingRoutingGate.totalNodes &&
      powerSavingRoutingGate.activePhysicalLinks > 0 &&
      powerSavingRoutingGate.routedRoutes === 0 &&
      powerSavingRoutingGate.unroutableRoutes > 0 &&
      powerSavingRoutingGate.routesBlockedByPower,
  ],
  [
    "task priority affects congested route service",
    priorityScheduling.validationErrors === 0 &&
      priorityScheduling.commonPath &&
      priorityScheduling.highPriority > priorityScheduling.lowPriority &&
      priorityScheduling.highCarriedMbps > priorityScheduling.lowCarriedMbps &&
      priorityScheduling.lowQueuedMb + priorityScheduling.lowDroppedMb >
        priorityScheduling.highQueuedMb + priorityScheduling.highDroppedMb,
  ],
  [
    "uploaded dataset validates and drives the operational model",
    uploadedRun.validation.accepted === 10 &&
      uploadedRun.validation.errors.length === 0 &&
      uploadedMetrics.routedTasks > 0 &&
      uploadedMetrics.maxCpuPercent > 0 &&
      uploadedMetrics.maxMemoryPercent > 0 &&
      uploadedMetrics.maxForwardingLoadMbps > 0 &&
      uploadedMetrics.maxLinkDemandMbps > 0,
  ],
  [
    "standard CSV and JSON uploaded datasets are equivalent",
    standardDatasetFormatEquivalence.csvAccepted === standardDatasetFormatEquivalence.jsonAccepted &&
      standardDatasetFormatEquivalence.csvErrors === 0 &&
      standardDatasetFormatEquivalence.jsonErrors === 0 &&
      standardDatasetFormatEquivalence.metricsEqual &&
      standardDatasetFormatEquivalence.truthFingerprintEqual,
  ],
  [
    "compatible alias dataset fields normalize through parser",
    aliasDatasetNormalized.accepted === 2 &&
      aliasDatasetNormalized.errors === 0 &&
      aliasDatasetNormalized.routedTasks === 1 &&
      aliasDatasetNormalized.localTasks === 1 &&
      aliasDatasetNormalized.firstTaskId === "ALIAS-001" &&
      aliasDatasetNormalized.firstTaskSource === "P01-S01" &&
      aliasDatasetNormalized.firstTaskTarget === "P02-S02" &&
      aliasDatasetNormalized.secondTaskNodeId === "P03-S02",
  ],
  [
    "invalid uploaded dataset is rejected",
    invalidDatasetRun.validation.errors.length >= 4,
  ],
  [
    "invalid uploaded dataset rejects malformed numeric fields",
    invalidDatasetRun.validation.errors.some((error) => /compute_units|traffic_mbps/.test(error)),
  ],
  [
    "invalid uploaded dataset rejects ambiguous routed semantics",
    invalidDatasetRun.validation.errors.some((error) => /task_type is not supported/.test(error)) &&
      invalidDatasetRun.validation.errors.some((error) => /source and target must be different/.test(error)),
  ],
  [
    "scenario dataset templates round-trip through the standard parser",
    scenarioTemplateValidations.every(
      (template) =>
        template.directValidation.errors.length === 0 &&
        template.csvRoundTripValidation.errors.length === 0 &&
        template.jsonArrayRoundTripValidation.errors.length === 0 &&
        template.jsonObjectRoundTripValidation.errors.length === 0 &&
        template.generatedTasks === template.parsedCsvTasks &&
        template.generatedTasks === template.parsedJsonArrayTasks &&
        template.generatedTasks === template.parsedJsonObjectTasks &&
        template.fingerprintsEqual === true,
    ),
  ],
  [
    "uploaded dataset satisfies node and route coupling invariants",
    Object.values(uploadedInvariants).every(Boolean),
  ],
  [
    "uploaded dataset has traceable task-to-state causality",
    businessCausalityChecks.passed &&
      businessCausalityChecks.checkedActiveTaskSlices > 0 &&
      businessCausalityChecks.checkedLinkDemandMappings > 0 &&
      businessCausalityChecks.checkedRouteNodeTraffic > 0 &&
      businessCausalityChecks.checkedTelemetryNodes > 0 &&
      businessCausalityChecks.checkedTaskTelemetryEffects > 0 &&
      businessCausalityChecks.taskTelemetryGeneratedMb > 0 &&
      businessCausalityChecks.nodesWithForwardingLoad > 0 &&
      businessCausalityChecks.nodesWithTelemetryBuffer > 0,
  ],
  ["uploaded dataset produces deterministic results", uploadedDeterministic && uploadedTruthDeterministic],
  ["same input produces deterministic results", deterministic && highLoadTruthDeterministic],
  ["operational mode ignores autonomous demo wave parameters", demoWaveStressInvariant],
];

const failures = checks.filter(([, passed]) => !passed).map(([name]) => name);
const checkMap = Object.fromEntries(checks);

const acceptanceItems = [
  {
    id: 1,
    title: "空业务资源空闲与光照能量周期",
    passed:
      checkMap["empty traffic keeps operational resources idle"] &&
      checkMap["empty traffic has no business-side effects"] &&
      checkMap["empty traffic still follows sunlight energy cycle"],
    evidence: {
      maxCpuPercent: scenarioMetrics.empty.maxCpuPercent,
      maxForwardingLoadMbps: scenarioMetrics.empty.maxForwardingLoadMbps,
      maxNodeQueueMb: scenarioMetrics.empty.maxNodeQueueMb,
      maxLinkUtilizationPercent: scenarioMetrics.empty.maxLinkUtilizationPercent,
      maxNodeLinkOccupancyPercent: scenarioMetrics.empty.maxNodeLinkOccupancyPercent,
      minEnergyWh: scenarioMetrics.empty.minEnergyWh,
      maxEnergyWh: scenarioMetrics.empty.maxEnergyWh,
      sunlightNodeSamples: scenarioMetrics.empty.sunlightNodeSamples,
      eclipseNodeSamples: scenarioMetrics.empty.eclipseNodeSamples,
    },
  },
  {
    id: 2,
    title: "低负载业务可路由且不过载",
    passed: checkMap["low-load scenario routes without overload"],
    evidence: {
      routedTasks: scenarioMetrics["low-load"].routedTasks,
      unroutableTasks: scenarioMetrics["low-load"].unroutableTasks,
      maxLinkCongestionPercent: scenarioMetrics["low-load"].maxLinkCongestionPercent,
      maxCpuPercent: scenarioMetrics["low-load"].maxCpuPercent,
    },
  },
  {
    id: 3,
    title: "高负载、热点和突发业务能形成压力响应",
    passed:
      checkMap["high-load scenario stresses nodes and links more than low-load"] &&
      checkMap["node resource formulas respond to workload and cache pressure"] &&
      checkMap["node resource state matches configured formulas"] &&
      checkMap["link traffic state matches configured queue formulas"] &&
      checkMap["hotspot scenario creates localized pressure"] &&
      checkMap["burst scenario creates visible queue or congestion"] &&
      checkMap["task priority affects congested route service"],
    evidence: {
      highLoadMaxCpuPercent: scenarioMetrics["high-load"].maxCpuPercent,
      highLoadMaxForwardingCpuPercent: scenarioMetrics["high-load"].maxForwardingCpuPercent,
      highLoadMaxQueueCpuPercent: scenarioMetrics["high-load"].maxQueueCpuPercent,
      highLoadMaxLinkCongestionPercent: scenarioMetrics["high-load"].maxLinkCongestionPercent,
      highLoadMaxCommunicationPowerW: scenarioMetrics["high-load"].maxCommunicationPowerW,
      highLoadMaxNetworkComputePowerW: scenarioMetrics["high-load"].maxNetworkComputePowerW,
      hotspotMaxNodeQueueMb: scenarioMetrics.hotspot.maxNodeQueueMb,
      burstMaxLinkCongestionPercent: scenarioMetrics.burst.maxLinkCongestionPercent,
      formulaCheckedNodes: resourceFormulaChecks.checkedNodes,
      formulaMismatchCount: resourceFormulaChecks.mismatchCount,
      linkFormulaCheckedLinks: linkTrafficFormulaChecks.checkedLinks,
      linkFormulaCheckedRoutedLinks: linkTrafficFormulaChecks.checkedRoutedLinks,
      linkFormulaMismatchCount: linkTrafficFormulaChecks.mismatchCount,
      priorityScheduling,
    },
  },
  {
    id: 4,
    title: "拓扑约束断链后路由避开不可用链路并随时间重选路径",
    passed:
      checkMap["topology and link physics remain active during stage-one scenarios"] &&
      checkMap["walker orbit geometry and polar restrictions match configuration"] &&
      checkMap["routes avoid inactive links and reselect paths over time"] &&
      checkMap["route path state matches active shortest-path formulas"] &&
      checkMap["power-saving nodes are excluded from business routing"],
    evidence: {
      activeLinkSamples: scenarioMetrics.normal.activeLinkSamples,
      linkBudgetSamples: scenarioMetrics.normal.linkBudgetSamples,
      polarBlockedSamples: scenarioMetrics.normal.polarBlockedSamples,
      orbitCheckedNodes: orbitTopologyChecks.checkedNodes,
      orbitExpectedNodeCount: orbitTopologyChecks.expectedNodeCount,
      orbitExpectedPlaneSpacingDeg: orbitTopologyChecks.expectedPlaneSpacingDeg,
      polarInterPlaneLinksChecked: orbitTopologyChecks.checkedPolarInterPlaneLinks,
      orbitMismatchCount: orbitTopologyChecks.mismatchCount,
      routeDynamics,
      uploadedRouteDynamics,
      routeFormulaCheckedRoutes: routePathFormulaChecks.checkedRoutes,
      routeFormulaCheckedShortestPaths: routePathFormulaChecks.checkedShortestPaths,
      routeFormulaMismatchCount: routePathFormulaChecks.mismatchCount,
      powerSavingRoutingGate,
      priorityScheduling,
    },
  },
  {
    id: 5,
    title: "相同配置与相同业务输入多次运行一致",
    passed:
      checkMap["same input produces deterministic results"] &&
      checkMap["uploaded dataset produces deterministic results"] &&
      checkMap["operational mode ignores autonomous demo wave parameters"],
    evidence: {
      highLoadDeterministic: checkMap["same input produces deterministic results"],
      uploadedDeterministic: checkMap["uploaded dataset produces deterministic results"],
      operationalIgnoresDemoWaves: checkMap["operational mode ignores autonomous demo wave parameters"],
      highLoadTruthFingerprintStable: highLoadTruthDeterministic,
      uploadedTruthFingerprintStable: uploadedTruthDeterministic,
      demoWaveStressTruthFingerprintStable: highLoadFingerprint === demoWaveStressHighLoadFingerprint,
      highLoadFingerprintLength: highLoadFingerprint.length,
      uploadedFingerprintLength: uploadedFingerprint.length,
    },
  },
  {
    id: 6,
    title: "仪表盘和真值层具备按时间片展示/导出节点、链路、业务、能量状态的数据基础",
    passed:
      uploadedMetrics.slices >= 2 &&
      uploadedMetrics.nodes > 0 &&
      uploadedMetrics.links > 0 &&
      uploadedMetrics.routedTasks > 0 &&
      uploadedMetrics.maxTelemetryBufferMb > 0 &&
      uploadedMetrics.maxTelemetryDownlinkedMb > 0,
    evidence: {
      slices: uploadedMetrics.slices,
      nodes: uploadedMetrics.nodes,
      links: uploadedMetrics.links,
      routedTasks: uploadedMetrics.routedTasks,
      maxTelemetryBufferMb: uploadedMetrics.maxTelemetryBufferMb,
      maxTelemetryDownlinkedMb: uploadedMetrics.maxTelemetryDownlinkedMb,
    },
  },
  {
    id: 7,
    title: "审计脚本输出关键指标并判断模型是否运行正常",
    passed: failures.length === 0,
    evidence: {
      checkCount: checks.length,
      failedChecks: failures,
      uploadedDatasetAccepted: uploadedRun.validation.accepted,
      uploadedDatasetErrors: uploadedRun.validation.errors.length,
      invalidDatasetErrors: invalidDatasetRun.validation.errors.length,
      aliasDatasetAccepted: aliasDatasetNormalized.accepted,
      aliasDatasetErrors: aliasDatasetNormalized.errors,
      aliasDatasetNormalized: checkMap["compatible alias dataset fields normalize through parser"],
      scenarioTemplateCount: scenarioTemplateValidations.length,
      standardDatasetFormatsEquivalent: checkMap["standard CSV and JSON uploaded datasets are equivalent"],
      standardCsvTruthFingerprintHash: standardDatasetFormatEquivalence.csvTruthFingerprintHash,
      standardJsonTruthFingerprintHash: standardDatasetFormatEquivalence.jsonTruthFingerprintHash,
      standardTruthFingerprintLength: standardDatasetFormatEquivalence.csvTruthFingerprintLength,
      businessCausalityPassed: businessCausalityChecks.passed,
      businessCausalityMismatchCount: businessCausalityChecks.mismatchCount,
    },
  },
];

const report = {
  generated_at: new Date().toISOString(),
  overall_passed: failures.length === 0 && acceptanceItems.every((item) => item.passed),
  acceptance_items: acceptanceItems,
  scenarioMetrics,
  emptyInvariants,
  routeDynamics,
  uploadedDataset: {
    path: uploadedDatasetPath,
    jsonPath: uploadedJsonDatasetPath,
    validation: uploadedRun.validation,
    metrics: uploadedMetrics,
    repeatedMetrics: repeatedUploadedMetrics,
    invariants: uploadedInvariants,
    routeDynamics: uploadedRouteDynamics,
    businessCausalityChecks,
    formatEquivalence: standardDatasetFormatEquivalence,
  },
  invalidDataset: {
    validation: invalidDatasetRun.validation,
  },
  aliasDataset: {
    validation: aliasDatasetRun.validation,
    normalized: aliasDatasetNormalized,
  },
  powerSavingRoutingGate,
  priorityScheduling,
  scenarioTemplates: scenarioTemplateValidations,
  resourceFormulaChecks,
  linkTrafficFormulaChecks,
  routePathFormulaChecks,
  orbitTopologyChecks,
  businessCausalityChecks,
  repeatedHighLoad: repeatHighLoad,
  determinism: {
    highLoadMetricsStable: deterministic,
    highLoadTruthFingerprintStable: highLoadTruthDeterministic,
    highLoadFingerprintLength: highLoadFingerprint.length,
    demoWaveStressInvariant,
    demoWaveStressTruthFingerprintStable: highLoadFingerprint === demoWaveStressHighLoadFingerprint,
    demoWaveStressFingerprintHash: compactFingerprint(demoWaveStressHighLoadFingerprint),
    uploadedMetricsStable: uploadedDeterministic,
    uploadedTruthFingerprintStable: uploadedTruthDeterministic,
    uploadedFingerprintLength: uploadedFingerprint.length,
  },
  checks: checkMap,
};

function markdownTableRow(cells) {
  return `| ${cells.join(" | ")} |`;
}

function metricList(metrics) {
  return Object.entries(metrics)
    .map(([key, value]) => `  - ${key}: ${typeof value === "object" ? JSON.stringify(value) : value}`)
    .join("\n");
}

function stageOneReportMarkdown(data) {
  const lines = [
    "# 第一阶段卫星网络仿真验收报告",
    "",
    `生成时间：${data.generated_at}`,
    "",
    `总体结论：${data.overall_passed ? "通过" : "未通过"}`,
    "",
    "## 合格标准",
    "",
    markdownTableRow(["编号", "标准", "结果"]),
    markdownTableRow(["---", "---", "---"]),
    ...data.acceptance_items.map((item) =>
      markdownTableRow([String(item.id), item.title, item.passed ? "通过" : "未通过"]),
    ),
    "",
    "## 关键证据",
    "",
    ...data.acceptance_items.flatMap((item) => [
      `### ${item.id}. ${item.title}`,
      "",
      `结果：${item.passed ? "通过" : "未通过"}`,
      "",
      metricList(item.evidence),
      "",
    ]),
    "## 自动检查项",
    "",
    markdownTableRow(["检查项", "结果"]),
    markdownTableRow(["---", "---"]),
    ...Object.entries(data.checks).map(([name, passed]) => markdownTableRow([name, passed ? "通过" : "未通过"])),
    "",
  ];

  return `${lines.join("\n")}\n`;
}

async function writeReportFiles(outputDir, data) {
  if (!outputDir) return;
  await mkdir(outputDir, { recursive: true });
  await writeFile(`${outputDir}/stage1-acceptance.json`, JSON.stringify(data, null, 2), "utf8");
  await writeFile(`${outputDir}/stage1-acceptance.md`, stageOneReportMarkdown(data), "utf8");
}

console.log(
  JSON.stringify(report, null, 2),
);

await writeReportFiles(reportDir, report);

if (failures.length > 0) {
  console.error(`Stage-one audit failed: ${failures.join(", ")}`);
  process.exitCode = 1;
}
