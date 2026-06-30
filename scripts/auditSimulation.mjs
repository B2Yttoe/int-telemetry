import { build } from "esbuild";

const entry = `
  import { generateWalkerNetwork } from "./src/simulation/walker.ts";
  import { walkerNetworkConfig } from "./src/config/walkerNetworkConfig.ts";

  export const slices = generateWalkerNetwork(walkerNetworkConfig, {
    mode: "operational",
    tasks: [],
    trafficProfile: "normal",
    orbitModel: "tle-sgp4",
    routingAlgorithm: "shortest-path",
  });
`;

const result = await build({
  stdin: {
    contents: entry,
    resolveDir: process.cwd(),
    sourcefile: "simulation-audit.ts",
    loader: "ts",
  },
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
  logLevel: "silent",
});

const moduleUrl = `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`;
const { slices } = await import(moduleUrl);

const metrics = {
  slices: slices.length,
  nodes: slices[0]?.nodes.length ?? 0,
  links: slices[0]?.links.length ?? 0,
  activeTasks: 0,
  routedTasks: 0,
  unroutableTasks: 0,
  maxCpuPercent: 0,
  avgCpuPercent: 0,
  maxNodeQueueMb: 0,
  maxNodeDropMb: 0,
  maxCacheMb: 0,
  maxForwardingLoadMbps: 0,
  maxCommunicationPowerW: 0,
  maxNodeLinkOccupancyPercent: 0,
  maxActiveIslLinksPerNode: 0,
  maxActiveSglLinksPerNode: 0,
  maxTelemetryBufferMb: 0,
  maxTelemetryDownlinkedMb: 0,
  maxLinkDemandMbps: 0,
  maxLinkCarriedMbps: 0,
  maxLinkQueueMb: 0,
  maxLinkDropMb: 0,
  maxLinkCongestionPercent: 0,
  congestedLinkSamples: 0,
  minIslSnrDb: Number.POSITIVE_INFINITY,
  maxIslSnrDb: Number.NEGATIVE_INFINITY,
  minIslSinrDb: Number.POSITIVE_INFINITY,
  maxInterferenceToNoiseDb: Number.NEGATIVE_INFINITY,
  interferenceAffectedLinkSamples: 0,
  coChannelInterferenceSamples: 0,
  adjacentChannelInterferenceSamples: 0,
  filteredChannelInterferenceSamples: 0,
  maxIslPacketErrorRate: 0,
  maxDynamicPointingLossDb: 0,
  maxSwitchingDelayS: 0,
  minAvailabilityFactor: 1,
  maxEnvironmentalNoiseIncreaseDb: 0,
  maxSunNoiseTemperatureK: 0,
  minSunSeparationDeg: Number.POSITIVE_INFINITY,
  maxSolarInterferenceLossDb: 0,
  minSolarExclusionMarginDeg: Number.POSITIVE_INFINITY,
  solarInterferenceAffectedLinkSamples: 0,
  solarInterferenceBlockedLinkSamples: 0,
  maxAbsDopplerShiftKhz: 0,
  maxDopplerResidualKhz: 0,
  maxDopplerLossDb: 0,
  minDopplerTrackingMarginKhz: Number.POSITIVE_INFINITY,
  availableGroundLinkSamples: 0,
  minSglSnrDb: Number.POSITIVE_INFINITY,
  minAvailableSglSnrDb: Number.POSITIVE_INFINITY,
  maxAvailableSglPacketErrorRate: 0,
  maxSglPacketErrorRate: 0,
  maxAvailableSglAtmosphericLossDb: 0,
  maxSglAtmosphericLossDb: 0,
  maxSglRainAttenuationDb: 0,
  minGroundRainRateMmPerHour: Number.POSITIVE_INFINITY,
  maxGroundRainRateMmPerHour: 0,
  maxGroundCloudWaterKgPerM2: 0,
  sglInterferenceAffectedSamples: 0,
  maxSglInterferenceToNoiseDb: Number.NEGATIVE_INFINITY,
  sglAdjacentChannelInterferenceSamples: 0,
  sglFilteredChannelInterferenceSamples: 0,
  minEnergyWh: Number.POSITIVE_INFINITY,
  maxEnergyWh: 0,
  sunlightNodeSamples: 0,
  eclipseNodeSamples: 0,
};

const restrictions = {};
const mcsIds = new Set();
const rainRateSamples = new Set();
const islChannelIds = new Set();
const sglChannelIds = new Set();

for (const slice of slices) {
  metrics.activeTasks += slice.routes.length;
  metrics.routedTasks += slice.routes.filter((route) => route.status === "routed").length;
  metrics.unroutableTasks += slice.routes.filter((route) => route.status === "unroutable").length;
  metrics.avgCpuPercent +=
    slice.nodes.reduce((total, node) => total + node.resources.cpu_utilization, 0) / Math.max(slice.nodes.length, 1);

  for (const node of slice.nodes) {
    metrics.maxCpuPercent = Math.max(metrics.maxCpuPercent, node.resources.cpu_utilization);
    metrics.maxNodeQueueMb = Math.max(metrics.maxNodeQueueMb, node.resources.queued_traffic_mb);
    metrics.maxNodeDropMb = Math.max(metrics.maxNodeDropMb, node.resources.dropped_traffic_mb);
    metrics.maxCacheMb = Math.max(metrics.maxCacheMb, node.resources.cache_used_mb);
    metrics.maxForwardingLoadMbps = Math.max(metrics.maxForwardingLoadMbps, node.resources.forwarding_load_mbps);
    metrics.maxCommunicationPowerW = Math.max(metrics.maxCommunicationPowerW, node.resources.communication_power_w);
    metrics.maxNodeLinkOccupancyPercent = Math.max(
      metrics.maxNodeLinkOccupancyPercent,
      node.resources.link_occupancy_percent,
    );
    metrics.maxActiveIslLinksPerNode = Math.max(metrics.maxActiveIslLinksPerNode, node.resources.active_isl_links);
    metrics.maxActiveSglLinksPerNode = Math.max(metrics.maxActiveSglLinksPerNode, node.resources.active_sgl_links);
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
    metrics.maxLinkDemandMbps = Math.max(metrics.maxLinkDemandMbps, link.state.demandTrafficMbps);
    metrics.maxLinkCarriedMbps = Math.max(metrics.maxLinkCarriedMbps, link.state.carriedTrafficMbps);
    metrics.maxLinkQueueMb = Math.max(metrics.maxLinkQueueMb, link.state.queuedTrafficMb);
    metrics.maxLinkDropMb = Math.max(metrics.maxLinkDropMb, link.state.droppedTrafficMb);
    metrics.maxLinkCongestionPercent = Math.max(metrics.maxLinkCongestionPercent, link.state.congestionPercent);
    if (link.state.congestionPercent > 0) metrics.congestedLinkSamples += 1;

    if (link.state.linkBudget) {
      metrics.minIslSnrDb = Math.min(metrics.minIslSnrDb, link.state.linkBudget.snr_db);
      metrics.maxIslSnrDb = Math.max(metrics.maxIslSnrDb, link.state.linkBudget.snr_db);
      metrics.minIslSinrDb = Math.min(metrics.minIslSinrDb, link.state.linkBudget.sinr_db);
      metrics.maxInterferenceToNoiseDb = Math.max(
        metrics.maxInterferenceToNoiseDb,
        link.state.linkBudget.interference_to_noise_db,
      );
      metrics.maxIslPacketErrorRate = Math.max(metrics.maxIslPacketErrorRate, link.state.linkBudget.packet_error_rate);
      metrics.maxDynamicPointingLossDb = Math.max(
        metrics.maxDynamicPointingLossDb,
        link.state.linkBudget.dynamic_pointing_loss_db,
      );
      metrics.maxSwitchingDelayS = Math.max(metrics.maxSwitchingDelayS, link.state.linkBudget.switching_delay_s);
      metrics.maxEnvironmentalNoiseIncreaseDb = Math.max(
        metrics.maxEnvironmentalNoiseIncreaseDb,
        link.state.linkBudget.environmental_noise_increase_db,
      );
      metrics.maxSunNoiseTemperatureK = Math.max(
        metrics.maxSunNoiseTemperatureK,
        link.state.linkBudget.sun_noise_temperature_k,
      );
      metrics.minSunSeparationDeg = Math.min(metrics.minSunSeparationDeg, link.state.linkBudget.sun_separation_deg);
      metrics.maxSolarInterferenceLossDb = Math.max(
        metrics.maxSolarInterferenceLossDb,
        link.state.linkBudget.solar_interference_loss_db,
      );
      metrics.minSolarExclusionMarginDeg = Math.min(
        metrics.minSolarExclusionMarginDeg,
        link.state.linkBudget.solar_exclusion_margin_deg,
      );
      if (link.state.linkBudget.solar_interference_loss_db > 0) metrics.solarInterferenceAffectedLinkSamples += 1;
      if (link.state.linkBudget.solar_interference_blocked) metrics.solarInterferenceBlockedLinkSamples += 1;
      metrics.minAvailabilityFactor = Math.min(
        metrics.minAvailabilityFactor,
        link.state.linkBudget.availability_factor,
      );
      metrics.maxAbsDopplerShiftKhz = Math.max(
        metrics.maxAbsDopplerShiftKhz,
        Math.abs(link.state.linkBudget.doppler_shift_hz) / 1000,
      );
      metrics.maxDopplerResidualKhz = Math.max(
        metrics.maxDopplerResidualKhz,
        Math.abs(link.state.linkBudget.doppler_residual_hz) / 1000,
      );
      metrics.maxDopplerLossDb = Math.max(metrics.maxDopplerLossDb, link.state.linkBudget.doppler_loss_db);
      metrics.minDopplerTrackingMarginKhz = Math.min(
        metrics.minDopplerTrackingMarginKhz,
        link.state.linkBudget.doppler_tracking_margin_hz / 1000,
      );
      mcsIds.add(link.state.linkBudget.mcs_id);
      islChannelIds.add(link.state.linkBudget.channel_id);
      if (link.state.linkBudget.interference_count > 0) metrics.interferenceAffectedLinkSamples += 1;
      if (link.state.linkBudget.co_channel_interference_count > 0) metrics.coChannelInterferenceSamples += 1;
      if (link.state.linkBudget.adjacent_channel_interference_count > 0) metrics.adjacentChannelInterferenceSamples += 1;
      if (link.state.linkBudget.filtered_channel_interference_count > 0) metrics.filteredChannelInterferenceSamples += 1;
    }

    const key = link.state.restrictionReason ?? (link.state.isActive ? "active" : "down-unknown");
    restrictions[key] = (restrictions[key] ?? 0) + 1;
  }

  for (const window of slice.groundLinks) {
    if (window.status === "available") metrics.availableGroundLinkSamples += 1;
    metrics.minGroundRainRateMmPerHour = Math.min(metrics.minGroundRainRateMmPerHour, window.rainRateMmPerHour);
    metrics.maxGroundRainRateMmPerHour = Math.max(metrics.maxGroundRainRateMmPerHour, window.rainRateMmPerHour);
    metrics.maxGroundCloudWaterKgPerM2 = Math.max(metrics.maxGroundCloudWaterKgPerM2, window.cloudLiquidWaterKgPerM2);
    rainRateSamples.add(window.rainRateMmPerHour.toFixed(2));
    if (!window.linkBudget) continue;
    metrics.minSglSnrDb = Math.min(metrics.minSglSnrDb, window.linkBudget.snr_db);
    metrics.maxSglAtmosphericLossDb = Math.max(
      metrics.maxSglAtmosphericLossDb,
      window.linkBudget.atmospheric_loss_db,
    );
    metrics.maxSglRainAttenuationDb = Math.max(
      metrics.maxSglRainAttenuationDb,
      window.linkBudget.rain_attenuation_db,
    );
    metrics.maxSglPacketErrorRate = Math.max(metrics.maxSglPacketErrorRate, window.linkBudget.packet_error_rate);
    if (window.linkBudget.interference_count > 0) metrics.sglInterferenceAffectedSamples += 1;
    if (window.linkBudget.adjacent_channel_interference_count > 0) metrics.sglAdjacentChannelInterferenceSamples += 1;
    if (window.linkBudget.filtered_channel_interference_count > 0) metrics.sglFilteredChannelInterferenceSamples += 1;
    sglChannelIds.add(window.linkBudget.channel_id);
    metrics.maxSglInterferenceToNoiseDb = Math.max(
      metrics.maxSglInterferenceToNoiseDb,
      window.linkBudget.interference_to_noise_db,
    );
    metrics.maxDynamicPointingLossDb = Math.max(
      metrics.maxDynamicPointingLossDb,
      window.linkBudget.dynamic_pointing_loss_db,
    );
    metrics.maxSwitchingDelayS = Math.max(metrics.maxSwitchingDelayS, window.linkBudget.switching_delay_s);
    metrics.maxEnvironmentalNoiseIncreaseDb = Math.max(
      metrics.maxEnvironmentalNoiseIncreaseDb,
      window.linkBudget.environmental_noise_increase_db,
    );
    metrics.maxSunNoiseTemperatureK = Math.max(metrics.maxSunNoiseTemperatureK, window.linkBudget.sun_noise_temperature_k);
    metrics.minSunSeparationDeg = Math.min(metrics.minSunSeparationDeg, window.linkBudget.sun_separation_deg);
    metrics.minAvailabilityFactor = Math.min(metrics.minAvailabilityFactor, window.linkBudget.availability_factor);
    metrics.maxAbsDopplerShiftKhz = Math.max(
      metrics.maxAbsDopplerShiftKhz,
      Math.abs(window.linkBudget.doppler_shift_hz) / 1000,
    );
    metrics.maxDopplerResidualKhz = Math.max(
      metrics.maxDopplerResidualKhz,
      Math.abs(window.linkBudget.doppler_residual_hz) / 1000,
    );
    metrics.maxDopplerLossDb = Math.max(metrics.maxDopplerLossDb, window.linkBudget.doppler_loss_db);
    metrics.minDopplerTrackingMarginKhz = Math.min(
      metrics.minDopplerTrackingMarginKhz,
      window.linkBudget.doppler_tracking_margin_hz / 1000,
    );
    mcsIds.add(window.linkBudget.mcs_id);
    if (window.status === "available") {
      metrics.minAvailableSglSnrDb = Math.min(metrics.minAvailableSglSnrDb, window.linkBudget.snr_db);
      metrics.maxAvailableSglPacketErrorRate = Math.max(
        metrics.maxAvailableSglPacketErrorRate,
        window.linkBudget.packet_error_rate,
      );
      metrics.maxAvailableSglAtmosphericLossDb = Math.max(
        metrics.maxAvailableSglAtmosphericLossDb,
        window.linkBudget.atmospheric_loss_db,
      );
    }
  }
}

metrics.avgCpuPercent = Number((metrics.avgCpuPercent / Math.max(slices.length, 1)).toFixed(2));
metrics.maxNodeQueueMb = Number(metrics.maxNodeQueueMb.toFixed(2));
metrics.maxNodeDropMb = Number(metrics.maxNodeDropMb.toFixed(2));
metrics.maxCacheMb = Number(metrics.maxCacheMb.toFixed(2));
metrics.maxForwardingLoadMbps = Number(metrics.maxForwardingLoadMbps.toFixed(2));
metrics.maxCommunicationPowerW = Number(metrics.maxCommunicationPowerW.toFixed(2));
metrics.maxNodeLinkOccupancyPercent = Number(metrics.maxNodeLinkOccupancyPercent.toFixed(2));
metrics.maxTelemetryBufferMb = Number(metrics.maxTelemetryBufferMb.toFixed(2));
metrics.maxTelemetryDownlinkedMb = Number(metrics.maxTelemetryDownlinkedMb.toFixed(2));
metrics.maxLinkQueueMb = Number(metrics.maxLinkQueueMb.toFixed(2));
metrics.maxLinkDropMb = Number(metrics.maxLinkDropMb.toFixed(2));
metrics.minEnergyWh = Number(metrics.minEnergyWh.toFixed(2));
metrics.maxEnergyWh = Number(metrics.maxEnergyWh.toFixed(2));
metrics.minIslSinrDb = Number(metrics.minIslSinrDb.toFixed(2));
metrics.maxInterferenceToNoiseDb = Number(metrics.maxInterferenceToNoiseDb.toFixed(2));
metrics.maxIslPacketErrorRate = Number(metrics.maxIslPacketErrorRate.toPrecision(4));
metrics.maxDynamicPointingLossDb = Number(metrics.maxDynamicPointingLossDb.toFixed(4));
metrics.maxSwitchingDelayS = Number(metrics.maxSwitchingDelayS.toFixed(2));
metrics.minAvailabilityFactor = Number(metrics.minAvailabilityFactor.toFixed(4));
metrics.maxEnvironmentalNoiseIncreaseDb = Number(metrics.maxEnvironmentalNoiseIncreaseDb.toFixed(4));
metrics.maxSunNoiseTemperatureK = Number(metrics.maxSunNoiseTemperatureK.toFixed(2));
metrics.minSunSeparationDeg = Number.isFinite(metrics.minSunSeparationDeg)
  ? Number(metrics.minSunSeparationDeg.toFixed(2))
  : null;
metrics.maxSolarInterferenceLossDb = Number(metrics.maxSolarInterferenceLossDb.toFixed(4));
metrics.minSolarExclusionMarginDeg = Number.isFinite(metrics.minSolarExclusionMarginDeg)
  ? Number(metrics.minSolarExclusionMarginDeg.toFixed(2))
  : null;
metrics.maxAbsDopplerShiftKhz = Number(metrics.maxAbsDopplerShiftKhz.toFixed(2));
metrics.maxDopplerResidualKhz = Number(metrics.maxDopplerResidualKhz.toFixed(2));
metrics.maxDopplerLossDb = Number(metrics.maxDopplerLossDb.toFixed(4));
metrics.minDopplerTrackingMarginKhz = Number.isFinite(metrics.minDopplerTrackingMarginKhz)
  ? Number(metrics.minDopplerTrackingMarginKhz.toFixed(2))
  : null;
metrics.minSglSnrDb = Number.isFinite(metrics.minSglSnrDb) ? Number(metrics.minSglSnrDb.toFixed(2)) : null;
metrics.minAvailableSglSnrDb = Number.isFinite(metrics.minAvailableSglSnrDb)
  ? Number(metrics.minAvailableSglSnrDb.toFixed(2))
  : null;
metrics.maxAvailableSglPacketErrorRate = Number(metrics.maxAvailableSglPacketErrorRate.toPrecision(4));
metrics.maxSglPacketErrorRate = Number(metrics.maxSglPacketErrorRate.toPrecision(4));
metrics.maxAvailableSglAtmosphericLossDb = Number(metrics.maxAvailableSglAtmosphericLossDb.toFixed(2));
metrics.maxSglAtmosphericLossDb = Number(metrics.maxSglAtmosphericLossDb.toFixed(2));
metrics.maxSglRainAttenuationDb = Number(metrics.maxSglRainAttenuationDb.toFixed(2));
metrics.minGroundRainRateMmPerHour = Number.isFinite(metrics.minGroundRainRateMmPerHour)
  ? Number(metrics.minGroundRainRateMmPerHour.toFixed(2))
  : null;
metrics.maxGroundRainRateMmPerHour = Number(metrics.maxGroundRainRateMmPerHour.toFixed(2));
metrics.maxGroundCloudWaterKgPerM2 = Number(metrics.maxGroundCloudWaterKgPerM2.toFixed(3));
metrics.maxSglInterferenceToNoiseDb = Number.isFinite(metrics.maxSglInterferenceToNoiseDb)
  ? Number(metrics.maxSglInterferenceToNoiseDb.toFixed(2))
  : null;
metrics.mcsSchemeCount = mcsIds.size;
metrics.mcsIds = [...mcsIds].sort();
metrics.rainRateSampleCount = rainRateSamples.size;
metrics.islChannelCount = islChannelIds.size;
metrics.sglChannelCount = sglChannelIds.size;
metrics.islChannels = [...islChannelIds].sort((a, b) => a - b);
metrics.sglChannels = [...sglChannelIds].sort((a, b) => a - b);

const checks = [
  ["normal traffic creates routed tasks", metrics.routedTasks > 0 && metrics.unroutableTasks === 0],
  ["node CPU is driven by workload", metrics.maxCpuPercent > 0],
  ["link congestion is observable", metrics.maxLinkCongestionPercent > 0 && metrics.maxLinkQueueMb > 0],
  [
    "node link occupancy drives forwarding load and communication power",
    metrics.maxForwardingLoadMbps > 0 &&
      metrics.maxCommunicationPowerW > 0 &&
      metrics.maxNodeLinkOccupancyPercent > 0 &&
      metrics.maxActiveIslLinksPerNode > 0,
  ],
  ["telemetry is generated and buffered", metrics.maxTelemetryBufferMb > 0],
  ["ground downlink can drain telemetry", metrics.maxTelemetryDownlinkedMb > 0],
  ["link budget is computed", Number.isFinite(metrics.minIslSnrDb) && metrics.minIslSnrDb > 0],
  ["interference model affects SINR", metrics.interferenceAffectedLinkSamples > 0 && metrics.minIslSinrDb < metrics.minIslSnrDb],
  [
    "frequency reuse and adjacent-channel filtering are active",
    metrics.islChannelCount > 1 &&
      metrics.coChannelInterferenceSamples > 0 &&
      metrics.adjacentChannelInterferenceSamples > 0 &&
      metrics.filteredChannelInterferenceSamples > 0,
  ],
  ["SGL co-channel interference is computed", metrics.sglInterferenceAffectedSamples > 0 && metrics.maxSglInterferenceToNoiseDb !== null],
  ["SGL atmospheric loss is computed", metrics.maxSglAtmosphericLossDb > 0 && metrics.maxSglRainAttenuationDb > 0],
  ["dynamic weather drives SGL rain fade", metrics.rainRateSampleCount > 4 && metrics.maxGroundRainRateMmPerHour > metrics.minGroundRainRateMmPerHour],
  ["environmental noise is computed", metrics.maxEnvironmentalNoiseIncreaseDb > 0 && metrics.maxSunNoiseTemperatureK > 0],
  [
    "solar exclusion constrains optical ISL",
    metrics.solarInterferenceAffectedLinkSamples > 0 &&
      metrics.solarInterferenceBlockedLinkSamples > 0 &&
      restrictions["solar-interference"] > 0,
  ],
  ["antenna pointing loss is computed", metrics.maxDynamicPointingLossDb > 0],
  ["antenna switching affects availability", metrics.maxSwitchingDelayS > 0 && metrics.minAvailabilityFactor < 1],
  ["doppler shift is computed from motion", metrics.maxAbsDopplerShiftKhz > 0],
  ["doppler residual affects link budget", metrics.maxDopplerResidualKhz > 0 && metrics.maxDopplerLossDb > 0],
  ["adaptive coding selects MCS", metrics.mcsSchemeCount >= 2],
  ["packet error model is computed", metrics.maxSglPacketErrorRate > 0 && metrics.maxAvailableSglPacketErrorRate <= 0.001],
  ["sunlight and eclipse samples exist", metrics.sunlightNodeSamples > 0 && metrics.eclipseNodeSamples > 0],
  ["battery remains above safe floor", metrics.minEnergyWh >= 240],
];

const failures = checks.filter(([, passed]) => !passed).map(([name]) => name);

console.log(JSON.stringify({ metrics, restrictions, checks: Object.fromEntries(checks) }, null, 2));

if (failures.length > 0) {
  console.error(`Simulation audit failed: ${failures.join(", ")}`);
  process.exitCode = 1;
}
