import { walkerNetworkConfig } from "./walkerNetworkConfig";
import iridiumNextSnapshot from "../../data/tle-snapshots/celestrak-iridium-next-real-walker-6x11.json";
import telesat1015Snapshot from "../../data/tle-snapshots/synthetic-telesat-1015-hypatia-walker-27x13.json";
import starlinkLargeSnapshot from "../../data/tle-snapshots/celestrak-starlink-real-walker-72x22.json";
import type { RealTleCatalogSnapshot, WalkerNetworkConfig } from "../simulation/types";

export type ConstellationProfileId = "iridium-next-small" | "telesat-1015-medium" | "starlink-main-large";

export interface ConstellationProfile {
  id: ConstellationProfileId;
  label: string;
  shortLabel: string;
  scale: "small" | "medium" | "large";
  operator: string;
  sourceSummary: string;
  architectureSummary: string;
  experimentUse: string;
  config: WalkerNetworkConfig;
  snapshot: RealTleCatalogSnapshot;
}

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends Array<unknown> ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K];
};

function cloneConfig(overrides: DeepPartial<WalkerNetworkConfig> = {}): WalkerNetworkConfig {
  const base = walkerNetworkConfig;
  return {
    ...base,
    constellation: { ...base.constellation, ...overrides.constellation },
    time: { ...base.time, ...overrides.time },
    orbit: {
      ...base.orbit,
      ...overrides.orbit,
      tleCatalog: { ...base.orbit.tleCatalog, ...overrides.orbit?.tleCatalog },
    },
    interPlane: { ...base.interPlane, ...overrides.interPlane },
    polarRegion: { ...base.polarRegion, ...overrides.polarRegion },
    earthOcclusion: { ...base.earthOcclusion, ...overrides.earthOcclusion },
    nodeStateDefaults: { ...base.nodeStateDefaults, ...overrides.nodeStateDefaults },
    nodeResourceDefaults: { ...base.nodeResourceDefaults, ...overrides.nodeResourceDefaults },
    operationalModel: { ...base.operationalModel, ...overrides.operationalModel },
    routing: { ...base.routing, ...overrides.routing },
    trafficModel: { ...base.trafficModel, ...overrides.trafficModel },
    antennaModel: {
      isl: { ...base.antennaModel.isl, ...overrides.antennaModel?.isl },
      sgl: { ...base.antennaModel.sgl, ...overrides.antennaModel?.sgl },
    },
    linkBudget: {
      isl: { ...base.linkBudget.isl, ...overrides.linkBudget?.isl },
      sgl: { ...base.linkBudget.sgl, ...overrides.linkBudget?.sgl },
    },
    interferenceModel: {
      isl: { ...base.interferenceModel.isl, ...overrides.interferenceModel?.isl },
      sgl: { ...base.interferenceModel.sgl, ...overrides.interferenceModel?.sgl },
    },
    pointingModel: {
      ...base.pointingModel,
      ...overrides.pointingModel,
      isl: { ...base.pointingModel.isl, ...overrides.pointingModel?.isl },
      sgl: { ...base.pointingModel.sgl, ...overrides.pointingModel?.sgl },
    },
    dopplerModel: {
      ...base.dopplerModel,
      ...overrides.dopplerModel,
      isl: { ...base.dopplerModel.isl, ...overrides.dopplerModel?.isl },
      sgl: { ...base.dopplerModel.sgl, ...overrides.dopplerModel?.sgl },
    },
    noiseModel: {
      ...base.noiseModel,
      ...overrides.noiseModel,
      isl: { ...base.noiseModel.isl, ...overrides.noiseModel?.isl },
      sgl: { ...base.noiseModel.sgl, ...overrides.noiseModel?.sgl },
    },
    atmosphericModel: {
      sgl: { ...base.atmosphericModel.sgl, ...overrides.atmosphericModel?.sgl },
    },
    adaptiveCoding: {
      isl: { ...base.adaptiveCoding.isl, ...overrides.adaptiveCoding?.isl },
      sgl: { ...base.adaptiveCoding.sgl, ...overrides.adaptiveCoding?.sgl },
    },
    groundStations: overrides.groundStations ?? base.groundStations,
    linkStateDefaults: { ...base.linkStateDefaults, ...overrides.linkStateDefaults },
    stateProfiles: { ...base.stateProfiles, ...overrides.stateProfiles },
  };
}

function configFromSnapshot(snapshot: RealTleCatalogSnapshot, overrides: DeepPartial<WalkerNetworkConfig> = {}) {
  return cloneConfig({
    ...overrides,
    constellation: {
      ...overrides.constellation,
      walkerType: "star",
      shellId: snapshot.shell_id,
      planes: snapshot.layout.planes,
      satellitesPerPlane: snapshot.layout.satellites_per_plane,
      altitudeKm: snapshot.mean_altitude_km,
      inclinationDeg: snapshot.mean_inclination_deg,
    },
    orbit: {
      ...overrides.orbit,
      model: "real-tle-sgp4",
      tleCatalog: {
        ...overrides.orbit?.tleCatalog,
        source: snapshot.source,
        satelliteNamePrefix: snapshot.group,
      },
    },
  });
}

const iridiumConfig = configFromSnapshot(iridiumNextSnapshot as RealTleCatalogSnapshot, {
  interPlane: {
    maxDistanceKm: 5200,
    warningMarginKm: 500,
    maxLinksPerNode: 4,
  },
  polarRegion: {
    enabled: true,
    latitudeDeg: 72,
  },
  antennaModel: {
    isl: {
      band: "Ka",
      gainDbi: 38,
      beamwidthDeg: 4,
      maxRangeKm: 5200,
      maxTxPowerW: 25,
      bandwidthMbps: 50,
      maxSimultaneousBeams: 1,
      slewRateDegPerSec: 2,
    },
    sgl: {
      band: "Ka",
      gainDbi: 30,
      beamwidthDeg: 12,
      maxRangeKm: 5000,
      maxTxPowerW: 20,
      bandwidthMbps: 25,
      maxSimultaneousBeams: 1,
      slewRateDegPerSec: 3,
      minElevationDeg: 10,
      reportCapacityMbps: 20,
    },
  },
  linkBudget: {
    isl: {
      frequencyGhz: 23,
      channelBandwidthMhz: 50,
      noiseFigureDb: 3,
      capacityEfficiency: 0.55,
      minCapacityMbps: 1,
      minSnrDb: 5,
    },
    sgl: {
      frequencyGhz: 20,
      channelBandwidthMhz: 25,
      minCapacityMbps: 0.5,
    },
  },
  trafficModel: {
    maxRouteQueueDelayMs: 30000,
    taskTimeoutMs: 30000,
    telemetryBufferCapacityMb: 512,
  },
});

const telesat1015Config = configFromSnapshot(telesat1015Snapshot as RealTleCatalogSnapshot, {
  interPlane: {
    maxDistanceKm: 7000,
    warningMarginKm: 800,
    maxLinksPerNode: 4,
  },
  polarRegion: {
    enabled: true,
    latitudeDeg: 80,
  },
  antennaModel: {
    isl: {
      band: "laser",
      gainDbi: 102,
      beamwidthDeg: 1.5,
      maxRangeKm: 7000,
      maxTxPowerW: 35,
      bandwidthMbps: 10000,
      maxSimultaneousBeams: 1,
      slewRateDegPerSec: 1.5,
    },
    sgl: {
      band: "Ka",
      gainDbi: 36,
      beamwidthDeg: 7,
      maxRangeKm: 6500,
      maxTxPowerW: 35,
      bandwidthMbps: 1500,
      maxSimultaneousBeams: 1,
      slewRateDegPerSec: 4,
      minElevationDeg: 20,
      reportCapacityMbps: 700,
    },
  },
  linkBudget: {
    isl: {
      frequencyGhz: 193500,
      channelBandwidthMhz: 5000,
      capacityEfficiency: 0.6,
      minCapacityMbps: 100,
      minSnrDb: 6,
    },
    sgl: {
      frequencyGhz: 20,
      channelBandwidthMhz: 700,
      capacityEfficiency: 0.58,
      minCapacityMbps: 50,
      groundStationGainDbi: 48,
    },
  },
  trafficModel: {
    telemetryBufferCapacityMb: 1536,
  },
});

const starlinkLargeConfig = configFromSnapshot(starlinkLargeSnapshot as RealTleCatalogSnapshot, {
  interPlane: {
    maxDistanceKm: 4200,
    warningMarginKm: 500,
    maxLinksPerNode: 4,
  },
});

export const constellationProfiles: ConstellationProfile[] = [
  {
    id: "iridium-next-small",
    label: "小型：Iridium NEXT 6x11",
    shortLabel: "Iridium 66",
    scale: "small",
    operator: "Iridium",
    sourceSummary: "CelesTrak IRIDIUM-NEXT GP 快照，6 个近极轨道面，每面 11 颗，合计 66 颗。",
    architectureSummary: "真实 crosslinked Walker-Star 小规模网络，保留四向 ISL、极区和 seam 约束。",
    experimentUse: "小规模基线、低开销 INT、极区和 seam 约束敏感性实验。",
    config: iridiumConfig,
    snapshot: iridiumNextSnapshot as RealTleCatalogSnapshot,
  },
  {
    id: "telesat-1015-medium",
    label: "中型：Telesat-1015 27x13",
    shortLabel: "Telesat 351",
    scale: "medium",
    operator: "Telesat / Hypatia reference",
    sourceSummary: "Hypatia 研究仿真常用 Telesat-1015 设计参数生成的合成 TLE 快照：27 个轨道面，每面 13 颗，合计 351 颗，1015 km / 98.98°。",
    architectureSummary: "中等规模近极轨 ISL 网络，保留四向 OISL、极区断链、seam、地球遮挡和链路预算约束。",
    experimentUse: "中规模原生 INT、INT-MC / CoSTCo 补全、覆盖率-开销曲线、传统 LEO 仿真方案对照实验。",
    config: telesat1015Config,
    snapshot: telesat1015Snapshot as RealTleCatalogSnapshot,
  },
  {
    id: "starlink-main-large",
    label: "大型：Starlink 主实验 72x22",
    shortLabel: "Starlink 1584",
    scale: "large",
    operator: "SpaceX Starlink",
    sourceSummary: "CelesTrak STARLINK GP 快照，72 个轨道面，每面 22 颗，合计 1584 颗。",
    architectureSummary: "当前第一阶段正式高可信真值模型，保留 Starlink-like ISL、链路预算、业务负载和能耗耦合。",
    experimentUse: "最终真实性实验、原生 INT 基线、低开销遥测补全与消融实验。",
    config: starlinkLargeConfig,
    snapshot: starlinkLargeSnapshot as RealTleCatalogSnapshot,
  },
];

export const defaultConstellationProfileId: ConstellationProfileId = "iridium-next-small";

export function getConstellationProfile(id: ConstellationProfileId) {
  return constellationProfiles.find((profile) => profile.id === id) ?? constellationProfiles[0];
}
