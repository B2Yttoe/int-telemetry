import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";

function argValue(args, name, fallback = "") {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  return args[index + 1] ?? fallback;
}

const args = process.argv.slice(2);
const reportDir = argValue(args, "--report-dir", "reports/stage1");
const baselineJsonPath = `${reportDir}/stage1-parameter-baseline.json`;
const baselineMdPath = `${reportDir}/stage1-parameter-baseline.md`;

const entry = `
  import { walkerNetworkConfig } from "./src/config/walkerNetworkConfig.ts";
  import { stableFingerprint } from "./src/simulation/export.ts";

  export function createBaseline() {
    const config = walkerNetworkConfig;
    const satelliteCount = config.constellation.planes * config.constellation.satellitesPerPlane;
    const solarPeakPowerW =
      config.operationalModel.solarConstantWPerM2 *
      config.operationalModel.solarArrayAreaM2 *
      config.operationalModel.solarArrayEfficiency;
    const nominalLoadPowerW =
      config.operationalModel.basePowerW +
      config.operationalModel.communicationPowerW +
      config.operationalModel.computePowerW +
      config.operationalModel.payloadPowerW;

    return {
      generated_at: new Date().toISOString(),
      baseline_schema_version: "stage1-parameter-baseline-v1",
      config_fingerprint: stableFingerprint(config),
      intended_use: "第一阶段 Walker/LEO 网络级仿真真值层，不包含第二阶段 INT 观测机制。",
      constellation: {
        walker_type: config.constellation.walkerType,
        shell_id: config.constellation.shellId,
        planes: config.constellation.planes,
        satellites_per_plane: config.constellation.satellitesPerPlane,
        satellite_count: satelliteCount,
        phasing: config.constellation.phasing,
        altitude_km: config.constellation.altitudeKm,
        inclination_deg: config.constellation.inclinationDeg,
        earth_radius_km: config.constellation.earthRadiusKm,
        gravitational_parameter_km3_s2: config.constellation.gravitationalParameterKm3S2,
      },
      time: {
        epoch_iso: config.time.epochIso,
        slices: config.time.slices,
        step_minutes: config.time.stepMinutes,
        duration_minutes: config.time.slices * config.time.stepMinutes,
      },
      orbit: {
        default_model: config.orbit.model,
        tle_catalog_source: config.orbit.tleCatalog.source,
        tle_note: "当前为 synthetic-walker TLE 风格数据；后续可替换为 CelesTrak/Space-Track 真实 TLE 数据源。",
        synthetic_eccentricity: config.orbit.tleCatalog.eccentricity,
        synthetic_bstar: config.orbit.tleCatalog.bstar,
      },
      topology_constraints: {
        inter_plane_max_distance_km: config.interPlane.maxDistanceKm,
        inter_plane_warning_margin_km: config.interPlane.warningMarginKm,
        max_links_per_node: config.interPlane.maxLinksPerNode,
        polar_region_enabled: config.polarRegion.enabled,
        polar_latitude_deg: config.polarRegion.latitudeDeg,
        earth_occlusion_enabled: config.earthOcclusion.enabled,
        earth_occlusion_clearance_km: config.earthOcclusion.clearanceKm,
      },
      node_resources: {
        node_type: config.nodeResourceDefaults.node_type,
        cpu_capacity: config.nodeResourceDefaults.cpu_capacity,
        gpu_capacity: config.nodeResourceDefaults.gpu_capacity,
        memory_gb: config.nodeResourceDefaults.memory,
        storage_gb: config.nodeResourceDefaults.storage,
        cache_capacity_mb: config.trafficModel.cacheCapacityMb,
        telemetry_buffer_capacity_mb: config.trafficModel.telemetryBufferCapacityMb,
      },
      energy_model: {
        solar_constant_w_m2: config.operationalModel.solarConstantWPerM2,
        solar_array_area_m2: config.operationalModel.solarArrayAreaM2,
        solar_array_efficiency: config.operationalModel.solarArrayEfficiency,
        solar_peak_power_w: Number(solarPeakPowerW.toFixed(2)),
        battery_capacity_wh: config.operationalModel.batteryCapacityWh,
        min_state_of_charge: config.operationalModel.minStateOfCharge,
        charge_efficiency: config.operationalModel.chargeEfficiency,
        discharge_efficiency: config.operationalModel.dischargeEfficiency,
        base_power_w: config.operationalModel.basePowerW,
        communication_power_w: config.operationalModel.communicationPowerW,
        compute_power_w: config.operationalModel.computePowerW,
        payload_power_w: config.operationalModel.payloadPowerW,
        nominal_load_power_w: nominalLoadPowerW,
      },
      resource_formulas: {
        cpu: "compute_cpu_percent + task_traffic_cpu_percent + forwarding_cpu_percent + queue_cpu_percent",
        task_traffic_cpu: "(ingress_traffic_mbps + egress_traffic_mbps) / 1000 * endpointCpuPercentPerGbps",
        network_compute_power: "(task_traffic_cpu_percent + forwarding_cpu_percent + queue_cpu_percent) / 100 * computePowerW",
        memory: "workload_memory_gb + queued_traffic_mb * queueMemoryGbPerQueuedGb / 1024 + telemetry_buffer_mb * telemetryMemoryGbPerBufferedGb / 1024",
        storage: "workload_storage_gb + cache_used_mb * cacheStorageGbPerBufferedGb / 1024",
        energy: "E(t+dt)=clip(E + charge_efficiency*max(Pgen-Pload,0)*dt - max(Pload-Pgen,0)/discharge_efficiency*dt)",
        temperature: "base_temperature + cpu_utilization*thermalRisePerCpuPercent + gpu_utilization*thermalRisePerGpuPercent + communication_power_w*thermalRisePerCommunicationW",
        queue: "queued traffic is driven by demand minus effective link capacity and capped by linkQueueCapacityMb",
      },
      operational_coefficients: {
        cpu_load_per_compute_unit: config.operationalModel.cpuLoadPerComputeUnit,
        gpu_load_per_gpu_unit: config.operationalModel.gpuLoadPerGpuUnit,
        memory_percent_per_gb: config.operationalModel.memoryPercentPerGb,
        storage_percent_per_gb: config.operationalModel.storagePercentPerGb,
        queue_depth_per_task: config.operationalModel.queueDepthPerTask,
        thermal_rise_per_cpu_percent: config.operationalModel.thermalRisePerCpuPercent,
        thermal_rise_per_gpu_percent: config.operationalModel.thermalRisePerGpuPercent,
        thermal_rise_per_communication_w: config.operationalModel.thermalRisePerCommunicationW,
      },
      traffic_model: {
        normal_flow_count: config.trafficModel.normalFlowCount,
        normal_flow_min_mbps: config.trafficModel.normalFlowMinMbps,
        normal_flow_max_mbps: config.trafficModel.normalFlowMaxMbps,
        normal_flow_duration_slices: config.trafficModel.normalFlowDurationSlices,
        normal_flow_compute_units: config.trafficModel.normalFlowComputeUnits,
        endpoint_cpu_percent_per_gbps: config.trafficModel.endpointCpuPercentPerGbps,
        endpoint_queue_depth_per_gbps: config.trafficModel.endpointQueueDepthPerGbps,
        forwarding_cpu_percent_per_gbps: config.trafficModel.forwardingCpuPercentPerGbps,
        forwarding_power_w_per_gbps: config.trafficModel.forwardingPowerWPerGbps,
        active_isl_link_power_w: config.trafficModel.activeIslLinkPowerW,
        active_sgl_link_power_w: config.trafficModel.activeSglLinkPowerW,
        queue_cpu_percent_per_gb: config.trafficModel.queueCpuPercentPerGb,
        queue_power_w_per_gb: config.trafficModel.queuePowerWPerGb,
        queue_carryover_ratio: config.trafficModel.queueCarryoverRatio,
        link_queue_capacity_mb: config.trafficModel.linkQueueCapacityMb,
        telemetry_generation_mb_per_slice: config.trafficModel.telemetryGenerationMbPerSlice,
        telemetry_cpu_mb_per_percent: config.trafficModel.telemetryCpuMbPerPercent,
        telemetry_traffic_mb_per_gbps: config.trafficModel.telemetryTrafficMbPerGbps,
        telemetry_congestion_mb_per_percent: config.trafficModel.telemetryCongestionMbPerPercent,
        telemetry_task_sampling_ratio: config.trafficModel.telemetryTaskSamplingRatio,
        downlink_task_sampling_ratio: config.trafficModel.downlinkTaskSamplingRatio,
      },
      antenna_model: config.antennaModel,
      link_budget: config.linkBudget,
      interference_model: config.interferenceModel,
      pointing_model: config.pointingModel,
      doppler_model: config.dopplerModel,
      noise_model: config.noiseModel,
      atmospheric_model: config.atmosphericModel,
      adaptive_coding: {
        isl_enabled: config.adaptiveCoding.isl.enabled,
        isl_scheme_count: config.adaptiveCoding.isl.schemes.length,
        isl_schemes: config.adaptiveCoding.isl.schemes.map((scheme) => scheme.id),
        sgl_enabled: config.adaptiveCoding.sgl.enabled,
        sgl_scheme_count: config.adaptiveCoding.sgl.schemes.length,
        sgl_schemes: config.adaptiveCoding.sgl.schemes.map((scheme) => scheme.id),
      },
      ground_stations: config.groundStations.map((station) => ({
        ground_station_id: station.ground_station_id,
        name: station.name,
        latitude_deg: station.latitudeDeg,
        longitude_deg: station.longitudeDeg,
        altitude_km: station.altitudeKm,
        min_elevation_deg: station.minElevationDeg,
        weather_timeline_points: station.weatherTimeline?.length ?? 0,
      })),
      simplifications: [
        "第一阶段保留全知真值层，不模拟 INT 报文采集过程。",
        "轨道模式支持 TLE-SGP4，但当前 TLE 来源仍是 synthetic-walker。",
        "链路预算采用 FSPL/SNR/SINR/容量等网络级公式，不展开完整物理层编码译码。",
        "天气以雨衰等高影响项为主，不引入高保真三维天气场。",
        "电池模型包含 SoC 和充放电效率，不模拟电池老化和热控结构细节。",
      ],
    };
  }
`;

const result = await build({
  stdin: {
    contents: entry,
    resolveDir: process.cwd(),
    sourcefile: "stage-one-baseline.ts",
    loader: "ts",
  },
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
  logLevel: "silent",
});

const moduleUrl = `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`;
const { createBaseline } = await import(moduleUrl);

function markdownTableRow(cells) {
  return `| ${cells.join(" | ")} |`;
}

function keyValueTable(title, values) {
  return [
    `## ${title}`,
    "",
    markdownTableRow(["参数", "值"]),
    markdownTableRow(["---", "---"]),
    ...Object.entries(values).map(([key, value]) =>
      markdownTableRow([key, typeof value === "object" ? JSON.stringify(value) : String(value)]),
    ),
    "",
  ];
}

function baselineMarkdown(baseline) {
  const lines = [
    "# 第一阶段参数基线",
    "",
    `生成时间：${baseline.generated_at}`,
    "",
    `配置指纹：${baseline.config_fingerprint}`,
    "",
    `用途：${baseline.intended_use}`,
    "",
    ...keyValueTable("星座与时间", { ...baseline.constellation, ...baseline.time }),
    ...keyValueTable("轨道与拓扑约束", { ...baseline.orbit, ...baseline.topology_constraints }),
    ...keyValueTable("节点资源与电源", { ...baseline.node_resources, ...baseline.energy_model }),
    ...keyValueTable("业务与队列模型", baseline.traffic_model),
    ...keyValueTable("ISL 天线", baseline.antenna_model.isl),
    ...keyValueTable("SGL 天线", baseline.antenna_model.sgl),
    ...keyValueTable("ISL 链路预算", baseline.link_budget.isl),
    ...keyValueTable("SGL 链路预算", baseline.link_budget.sgl),
    "## 公式关系",
    "",
    ...Object.entries(baseline.resource_formulas).map(([key, value]) => `- ${key}: ${value}`),
    "",
    "## 地面站",
    "",
    markdownTableRow(["站点", "纬度", "经度", "最低仰角", "天气时间点"]),
    markdownTableRow(["---", "---", "---", "---", "---"]),
    ...baseline.ground_stations.map((station) =>
      markdownTableRow([
        `${station.ground_station_id} ${station.name}`,
        String(station.latitude_deg),
        String(station.longitude_deg),
        String(station.min_elevation_deg),
        String(station.weather_timeline_points),
      ]),
    ),
    "",
    "## 简化边界",
    "",
    ...baseline.simplifications.map((item) => `- ${item}`),
    "",
  ];

  return `${lines.join("\n")}\n`;
}

const baseline = createBaseline();

await mkdir(reportDir, { recursive: true });
await writeFile(baselineJsonPath, JSON.stringify(baseline, null, 2), "utf8");
await writeFile(baselineMdPath, baselineMarkdown(baseline), "utf8");

console.log(
  JSON.stringify(
    {
      reportDir,
      config_fingerprint: baseline.config_fingerprint,
      files: [baselineJsonPath, baselineMdPath],
      satellite_count: baseline.constellation.satellite_count,
      duration_minutes: baseline.time.duration_minutes,
      solar_peak_power_w: baseline.energy_model.solar_peak_power_w,
      nominal_load_power_w: baseline.energy_model.nominal_load_power_w,
    },
    null,
    2,
  ),
);
