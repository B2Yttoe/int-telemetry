import type {
  AntennaState,
  AntennaRole,
  AntennaTemplateConfig,
  LinkPointingState,
  GroundLinkWindow,
  GroundStation,
  GroundStationWeather,
  SatelliteAntenna,
  SatelliteNode,
  WalkerNetworkConfig,
  Vector3Km,
} from "./types";
import {
  applyInterferenceToLinkBudget,
  budgetStatus,
  calculateDopplerState,
  calculateLinkBudget,
  calculateNoiseState,
  channelIsolationState,
  channelOffsetMhz,
  dbmToMilliwatts,
  freeSpacePathLossDb,
  wattsToDbm,
} from "./linkBudget";
import { sunDirectionEci } from "./spaceEnvironment";

const SIDEREAL_DAY_MINUTES = 1436.068;
const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
const toDegrees = (radians: number) => (radians * 180) / Math.PI;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const round = (value: number, digits = 1) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

function vectorMagnitude(vector: Vector3Km) {
  return Math.sqrt(vector.x * vector.x + vector.y * vector.y + vector.z * vector.z);
}

function normalizeVector(vector: Vector3Km): Vector3Km {
  const magnitude = vectorMagnitude(vector);
  if (magnitude === 0) return { x: 1, y: 0, z: 0 };
  return {
    x: vector.x / magnitude,
    y: vector.y / magnitude,
    z: vector.z / magnitude,
  };
}

function subtractVector(to: Vector3Km, from: Vector3Km): Vector3Km {
  return {
    x: to.x - from.x,
    y: to.y - from.y,
    z: to.z - from.z,
  };
}

function dot(a: Vector3Km, b: Vector3Km) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function cross(a: Vector3Km, b: Vector3Km): Vector3Km {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function scaleVector(vector: Vector3Km, scale: number): Vector3Km {
  return {
    x: vector.x * scale,
    y: vector.y * scale,
    z: vector.z * scale,
  };
}

function vectorFromVelocity(node: SatelliteNode): Vector3Km {
  return {
    x: node.timeState.velocityEci.vx,
    y: node.timeState.velocityEci.vy,
    z: node.timeState.velocityEci.vz,
  };
}

function distanceKm(a: Vector3Km, b: Vector3Km) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function angleBetweenDeg(a: Vector3Km, b: Vector3Km) {
  const normalizedA = normalizeVector(a);
  const normalizedB = normalizeVector(b);
  return toDegrees(Math.acos(clamp(dot(normalizedA, normalizedB), -1, 1)));
}

function antennaPatternGainDbi(
  peakGainDbi: number,
  beamwidthDeg: number,
  boresight: Vector3Km,
  direction: Vector3Km,
  config: WalkerNetworkConfig,
) {
  const model = config.interferenceModel.sgl;
  const offAxisDeg = angleBetweenDeg(boresight, direction);
  const halfBeamDeg = Math.max(beamwidthDeg / 2, 0.001);

  if (offAxisDeg <= halfBeamDeg) {
    return peakGainDbi - 3 * (offAxisDeg / halfBeamDeg) ** 2;
  }

  const offAxisRatio = Math.max(offAxisDeg / halfBeamDeg, 1);
  const sideLobeGain =
    peakGainDbi -
    model.sideLobeSuppressionDb -
    model.offAxisRollOffDbPerDecade * Math.log10(offAxisRatio);
  const backLobeGain = peakGainDbi - model.frontBackSuppressionDb;
  const envelopeGain = offAxisDeg > 90 ? Math.min(sideLobeGain, backLobeGain) : sideLobeGain;
  return Math.max(model.minSideLobeGainDbi, envelopeGain);
}

function rotateZ(vector: Vector3Km, angleRad: number): Vector3Km {
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  return {
    x: vector.x * cos - vector.y * sin,
    y: vector.x * sin + vector.y * cos,
    z: vector.z,
  };
}

function earthRotationAngleRad(minute: number) {
  return (2 * Math.PI * minute) / SIDEREAL_DAY_MINUTES;
}

function fallbackAlongTrack(radial: Vector3Km) {
  const reference = Math.abs(radial.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 };
  return normalizeVector(cross(reference, radial));
}

function localOrbitalDirection(node: SatelliteNode, targetEci: Vector3Km): Vector3Km {
  const radial = normalizeVector(node.timeState.eci);
  const velocity = vectorFromVelocity(node);
  const tangentialVelocity = subtractVector(velocity, scaleVector(radial, dot(velocity, radial)));
  const alongTrack = vectorMagnitude(tangentialVelocity) > 1e-6
    ? normalizeVector(tangentialVelocity)
    : fallbackAlongTrack(radial);
  const crossTrack = normalizeVector(cross(radial, alongTrack));
  const targetDirection = normalizeVector(subtractVector(targetEci, node.timeState.eci));

  return normalizeVector({
    x: dot(targetDirection, alongTrack),
    y: dot(targetDirection, crossTrack),
    z: dot(targetDirection, radial),
  });
}

function minutesSinceEpoch(node: SatelliteNode, config: WalkerNetworkConfig) {
  return (new Date(node.timeState.time).getTime() - new Date(config.time.epochIso).getTime()) / 60000;
}

function pointingLossFromError(errorDeg: number, beamwidthDeg: number) {
  const normalizedError = Math.max(errorDeg, 0) / Math.max(beamwidthDeg, 0.001);
  return 12 * normalizedError * normalizedError;
}

export interface AntennaPointingHistoryEntry {
  targetId: string;
  direction: Vector3Km;
}

export type AntennaPointingHistory = Map<string, AntennaPointingHistoryEntry>;

export interface AntennaPointingEndpointState {
  antennaId: string;
  targetId: string;
  direction: Vector3Km;
  slewAngleDeg: number;
  pointingErrorDeg: number;
  dynamicPointingLossDb: number;
  switchingDelaySeconds: number;
  availabilityFactor: number;
}

export function antennaPointingForTarget(
  node: SatelliteNode,
  antenna: SatelliteAntenna,
  targetId: string,
  targetEci: Vector3Km,
  config: WalkerNetworkConfig,
  history?: AntennaPointingHistory,
): AntennaPointingEndpointState {
  const desiredDirection = localOrbitalDirection(node, targetEci);
  const previous = history?.get(antenna.antenna_id);
  const model = config.pointingModel;
  const stepSeconds = Math.max(config.time.stepMinutes * 60, 1);

  if (!model.enabled) {
    return {
      antennaId: antenna.antenna_id,
      targetId,
      direction: desiredDirection,
      slewAngleDeg: 0,
      pointingErrorDeg: 0,
      dynamicPointingLossDb: 0,
      switchingDelaySeconds: 0,
      availabilityFactor: 1,
    };
  }

  const slewAngleDeg = previous ? angleBetweenDeg(previous.direction, desiredDirection) : 0;
  const targetChanged = !previous || previous.targetId !== targetId;
  const switchingSlewDeg = targetChanged ? slewAngleDeg : 0;
  const switchingDelaySeconds =
    (targetChanged ? model.acquisitionTimeSeconds : 0) +
    switchingSlewDeg / Math.max(antenna.slew_rate_deg_per_s, 0.001);
  const angularRateDegPerSec = previous ? slewAngleDeg / stepSeconds : 0;
  const jitterDeg = antenna.type === "SGL" ? model.sgl.pointingJitterDeg : model.isl.pointingJitterDeg;
  const pointingErrorDeg = jitterDeg + angularRateDegPerSec * model.trackingLoopLagSeconds;
  const dynamicPointingLossDb = pointingLossFromError(pointingErrorDeg, antenna.beamwidth_deg);

  return {
    antennaId: antenna.antenna_id,
    targetId,
    direction: desiredDirection,
    slewAngleDeg,
    pointingErrorDeg,
    dynamicPointingLossDb,
    switchingDelaySeconds,
    availabilityFactor: clamp(1 - switchingDelaySeconds / stepSeconds, 0, 1),
  };
}

export function combinePointingEndpoints(
  source?: AntennaPointingEndpointState,
  target?: AntennaPointingEndpointState,
): LinkPointingState {
  return {
    source_pointing_error_deg: source?.pointingErrorDeg ?? 0,
    target_pointing_error_deg: target?.pointingErrorDeg ?? 0,
    source_slew_angle_deg: source?.slewAngleDeg ?? 0,
    target_slew_angle_deg: target?.slewAngleDeg ?? 0,
    switching_delay_s: Math.max(source?.switchingDelaySeconds ?? 0, target?.switchingDelaySeconds ?? 0),
    availability_factor: Math.min(source?.availabilityFactor ?? 1, target?.availabilityFactor ?? 1),
    dynamic_pointing_loss_db: (source?.dynamicPointingLossDb ?? 0) + (target?.dynamicPointingLossDb ?? 0),
  };
}

export function commitAntennaPointing(
  history: AntennaPointingHistory | undefined,
  endpoint?: AntennaPointingEndpointState,
) {
  if (!history || !endpoint) return;
  history.set(endpoint.antennaId, {
    targetId: endpoint.targetId,
    direction: endpoint.direction,
  });
}

function antennaId(satelliteId: string, role: AntennaRole) {
  return `${satelliteId}-ANT-${role.toUpperCase()}`;
}

function pointingForRole(role: AntennaRole) {
  if (role === "front") {
    return {
      azimuthRangeDeg: [-20, 20] as [number, number],
      elevationRangeDeg: [-15, 15] as [number, number],
      description: "轨内前向指向",
    };
  }
  if (role === "back") {
    return {
      azimuthRangeDeg: [160, 200] as [number, number],
      elevationRangeDeg: [-15, 15] as [number, number],
      description: "轨内后向指向",
    };
  }
  if (role === "left") {
    return {
      azimuthRangeDeg: [250, 290] as [number, number],
      elevationRangeDeg: [-20, 20] as [number, number],
      description: "左侧轨间指向",
    };
  }
  if (role === "right") {
    return {
      azimuthRangeDeg: [70, 110] as [number, number],
      elevationRangeDeg: [-20, 20] as [number, number],
      description: "右侧轨间指向",
    };
  }
  if (role === "earth-facing") {
    return {
      azimuthRangeDeg: [-180, 180] as [number, number],
      elevationRangeDeg: [0, 70] as [number, number],
      description: "地向可转向覆盖",
    };
  }
  return {
    azimuthRangeDeg: [-180, 180] as [number, number],
    elevationRangeDeg: [-60, 60] as [number, number],
    description: "用户链路预留指向",
  };
}

function antennaFromTemplate(
  satelliteId: string,
  role: AntennaRole,
  type: SatelliteAntenna["type"],
  template: AntennaTemplateConfig,
): SatelliteAntenna {
  return {
    antenna_id: antennaId(satelliteId, role),
    satellite_id: satelliteId,
    type,
    role,
    band: template.band,
    gain_dbi: template.gainDbi,
    beamwidth_deg: template.beamwidthDeg,
    max_range_km: template.maxRangeKm,
    max_tx_power_w: template.maxTxPowerW,
    bandwidth_mbps: template.bandwidthMbps,
    max_simultaneous_beams: template.maxSimultaneousBeams,
    pointing: pointingForRole(role),
    slew_rate_deg_per_s: template.slewRateDegPerSec,
    state: "idle",
    occupied_beams: 0,
    target_ids: [],
    link_ids: [],
  };
}

export function createSatelliteAntennas(satelliteId: string, config: WalkerNetworkConfig): SatelliteAntenna[] {
  return [
    antennaFromTemplate(satelliteId, "front", "ISL", config.antennaModel.isl),
    antennaFromTemplate(satelliteId, "back", "ISL", config.antennaModel.isl),
    antennaFromTemplate(satelliteId, "left", "ISL", config.antennaModel.isl),
    antennaFromTemplate(satelliteId, "right", "ISL", config.antennaModel.isl),
    antennaFromTemplate(satelliteId, "earth-facing", "SGL", config.antennaModel.sgl),
  ];
}

export function antennaByRole(node: SatelliteNode, role: AntennaRole) {
  return node.antennas.find((antenna) => antenna.role === role);
}

export function occupyAntenna(
  node: SatelliteNode,
  role: AntennaRole,
  targetId: string,
  linkId: string,
  state: AntennaState = "occupied",
) {
  const antenna = antennaByRole(node, role);
  if (!antenna || antenna.state === "fault") return undefined;
  if (antenna.occupied_beams >= antenna.max_simultaneous_beams) return undefined;

  antenna.occupied_beams += 1;
  antenna.state = antenna.occupied_beams > 0 ? state : "idle";
  antenna.target_ids.push(targetId);
  antenna.link_ids.push(linkId);
  return antenna.antenna_id;
}

export function islRolesForLink(
  source: SatelliteNode,
  target: SatelliteNode,
  kind: "intra-plane" | "inter-plane",
  satellitesPerPlane: number,
): { sourceRole: AntennaRole; targetRole: AntennaRole } {
  if (kind === "inter-plane") {
    return source.plane < target.plane
      ? { sourceRole: "right", targetRole: "left" }
      : { sourceRole: "left", targetRole: "right" };
  }

  const nextSlot = (source.slot + 1) % satellitesPerPlane;
  return target.slot === nextSlot
    ? { sourceRole: "front", targetRole: "back" }
    : { sourceRole: "back", targetRole: "front" };
}

export function maxIslAntennaRangeKm(source: SatelliteNode, target: SatelliteNode, sourceRole: AntennaRole, targetRole: AntennaRole) {
  const sourceAntenna = antennaByRole(source, sourceRole);
  const targetAntenna = antennaByRole(target, targetRole);
  return Math.min(sourceAntenna?.max_range_km ?? 0, targetAntenna?.max_range_km ?? 0);
}

function groundStationEcef(station: GroundStation, earthRadiusKm: number): Vector3Km {
  const latitudeRad = toRadians(station.latitudeDeg);
  const longitudeRad = toRadians(station.longitudeDeg);
  const radius = earthRadiusKm + station.altitudeKm;
  return {
    x: radius * Math.cos(latitudeRad) * Math.cos(longitudeRad),
    y: radius * Math.cos(latitudeRad) * Math.sin(longitudeRad),
    z: radius * Math.sin(latitudeRad),
  };
}

function elevationDegFromStationEcef(satelliteEcef: Vector3Km, stationEcef: Vector3Km) {
  const stationToSatellite = subtractVector(satelliteEcef, stationEcef);
  const zenith = normalizeVector(stationEcef);
  return toDegrees(Math.asin(clamp(dot(normalizeVector(stationToSatellite), zenith), -1, 1)));
}

function groundStationEci(station: GroundStation, node: SatelliteNode, config: WalkerNetworkConfig): Vector3Km {
  return rotateZ(
    groundStationEcef(station, config.constellation.earthRadiusKm),
    earthRotationAngleRad(minutesSinceEpoch(node, config)),
  );
}

function groundStationVelocityEci(stationEci: Vector3Km): Vector3Km {
  const earthRotationRadPerSecond = (2 * Math.PI) / (SIDEREAL_DAY_MINUTES * 60);
  return {
    x: -earthRotationRadPerSecond * stationEci.y,
    y: earthRotationRadPerSecond * stationEci.x,
    z: 0,
  };
}

function relativeRadialVelocityKmS(
  sourcePosition: Vector3Km,
  targetPosition: Vector3Km,
  sourceVelocity: Vector3Km,
  targetVelocity: Vector3Km,
) {
  const lineOfSightDirection = normalizeVector(subtractVector(targetPosition, sourcePosition));
  const relativeVelocity = subtractVector(targetVelocity, sourceVelocity);
  return dot(relativeVelocity, lineOfSightDirection);
}

function defaultGroundStationWeather(station: GroundStation): GroundStationWeather {
  return station.weather ?? {
    rainRateMmPerHour: 0,
    rainHeightKm: station.altitudeKm,
    gaseousZenithLossDb: 0,
    cloudLiquidWaterKgPerM2: 0,
    scintillationFadeDb: 0,
  };
}

function interpolateWeatherValue(
  before: GroundStationWeather,
  after: GroundStationWeather,
  ratio: number,
  key: keyof GroundStationWeather,
) {
  return before[key] + (after[key] - before[key]) * ratio;
}

function weatherAtMinute(station: GroundStation, minute: number): GroundStationWeather & { sampleMinute: number } {
  const timeline = [...(station.weatherTimeline ?? [])].sort((a, b) => a.minute - b.minute);
  if (timeline.length === 0) {
    return {
      ...defaultGroundStationWeather(station),
      sampleMinute: minute,
    };
  }

  if (minute <= timeline[0].minute) {
    return {
      ...timeline[0],
      sampleMinute: timeline[0].minute,
    };
  }

  const last = timeline.at(-1)!;
  if (minute >= last.minute) {
    return {
      ...last,
      sampleMinute: last.minute,
    };
  }

  const upperIndex = timeline.findIndex((sample) => sample.minute >= minute);
  const before = timeline[upperIndex - 1];
  const after = timeline[upperIndex];
  const ratio = (minute - before.minute) / Math.max(after.minute - before.minute, 1e-9);
  return {
    rainRateMmPerHour: interpolateWeatherValue(before, after, ratio, "rainRateMmPerHour"),
    rainHeightKm: interpolateWeatherValue(before, after, ratio, "rainHeightKm"),
    gaseousZenithLossDb: interpolateWeatherValue(before, after, ratio, "gaseousZenithLossDb"),
    cloudLiquidWaterKgPerM2: interpolateWeatherValue(before, after, ratio, "cloudLiquidWaterKgPerM2"),
    scintillationFadeDb: interpolateWeatherValue(before, after, ratio, "scintillationFadeDb"),
    sampleMinute: minute,
  };
}

function minuteFromIso(timeIso: string, config: WalkerNetworkConfig) {
  return (new Date(timeIso).getTime() - new Date(config.time.epochIso).getTime()) / 60000;
}

function stableHash(text: string) {
  return [...text].reduce((total, char) => total + char.charCodeAt(0), 0);
}

function normalizedChannelId(channelId: number, channelCount: number) {
  const normalizedChannelCount = Math.max(Math.round(channelCount), 1);
  return ((Math.round(channelId) % normalizedChannelCount) + normalizedChannelCount) % normalizedChannelCount;
}

function sglChannelId(node: SatelliteNode, station: GroundStation, config: WalkerNetworkConfig) {
  const model = config.interferenceModel.sgl;
  const channelCount = Math.max(Math.round(model.reuseChannelCount), 1);
  if (channelCount === 1) return 0;
  return normalizedChannelId(node.plane + stableHash(station.ground_station_id), channelCount);
}

function sglAtmosphericLoss(
  station: GroundStation,
  elevationDeg: number,
  config: WalkerNetworkConfig,
  minute: number,
) {
  const model = config.atmosphericModel.sgl;
  const weather = weatherAtMinute(station, minute);
  if (!model.enabled) {
    return {
      atmosphericLossDb: config.linkBudget.sgl.atmosphericLossDb,
      rainAttenuationDb: 0,
      gaseousAttenuationDb: 0,
      cloudAttenuationDb: 0,
      scintillationLossDb: 0,
      weather,
    };
  }

  const elevationRad = toRadians(Math.max(elevationDeg, model.minElevationForLossDeg));
  const cosecantElevation = 1 / Math.max(Math.sin(elevationRad), 0.01);
  const rainDepthKm = Math.max(weather.rainHeightKm - station.altitudeKm, 0);
  const slantRainPathKm = rainDepthKm * cosecantElevation;
  const pathReductionFactor = 1 / (1 + slantRainPathKm / model.rainPathReductionReferenceKm);
  const specificRainAttenuationDbPerKm =
    model.rainSpecificAttenuationK * Math.max(weather.rainRateMmPerHour, 0) ** model.rainSpecificAttenuationAlpha;
  const rainAttenuationDb = specificRainAttenuationDbPerKm * slantRainPathKm * pathReductionFactor;
  const gaseousAttenuationDb = weather.gaseousZenithLossDb * cosecantElevation;
  const cloudAttenuationDb =
    model.cloudSpecificAttenuationDbPerKgM2 * weather.cloudLiquidWaterKgPerM2 * cosecantElevation;
  const scintillationLossDb = weather.scintillationFadeDb * Math.sqrt(cosecantElevation);
  const atmosphericLossDb =
    rainAttenuationDb + gaseousAttenuationDb + cloudAttenuationDb + scintillationLossDb;

  return {
    atmosphericLossDb: round(atmosphericLossDb, 3),
    rainAttenuationDb: round(rainAttenuationDb, 3),
    gaseousAttenuationDb: round(gaseousAttenuationDb, 3),
    cloudAttenuationDb: round(cloudAttenuationDb, 3),
    scintillationLossDb: round(scintillationLossDb, 3),
    weather,
  };
}

function groundWindowForStation(
  node: SatelliteNode,
  station: GroundStation,
  config: WalkerNetworkConfig,
  pointingHistory?: AntennaPointingHistory,
): Omit<GroundLinkWindow, "id" | "time" | "satellite_id" | "antenna_id" | "status" | "capacityMbps" | "reportCapacityMbps"> & {
  status: GroundLinkWindow["status"];
  capacityMbps: number;
  reportCapacityMbps: number;
  sourcePointing?: AntennaPointingEndpointState;
} {
  const sgl = config.antennaModel.sgl;
  const satelliteAntenna = antennaByRole(node, "earth-facing");
  const groundEcef = groundStationEcef(station, config.constellation.earthRadiusKm);
  const groundEci = groundStationEci(station, node, config);
  const groundVelocityEci = groundStationVelocityEci(groundEci);
  const radialVelocityKmS = relativeRadialVelocityKmS(
    node.timeState.eci,
    groundEci,
    vectorFromVelocity(node),
    groundVelocityEci,
  );
  const dopplerState = calculateDopplerState(
    radialVelocityKmS,
    config.linkBudget.sgl.frequencyGhz,
    config.dopplerModel.sgl,
    config.dopplerModel.enabled,
  );
  const groundReceiveBoresight = subtractVector(node.timeState.eci, groundEci);
  const sunSeparationDeg = angleBetweenDeg(groundReceiveBoresight, sunDirectionEci(new Date(node.timeState.time)));
  const noiseState = calculateNoiseState(
    sunSeparationDeg,
    config.interferenceModel.sgl.groundAntennaBeamwidthDeg,
    config.noiseModel.sgl,
    config.noiseModel.enabled,
  );
  const sourcePointing = satelliteAntenna
    ? antennaPointingForTarget(node, satelliteAntenna, station.ground_station_id, groundEci, config, pointingHistory)
    : undefined;
  const pointingState = combinePointingEndpoints(sourcePointing);
  const totalPointingLossDb = config.linkBudget.sgl.pointingLossDb + pointingState.dynamic_pointing_loss_db;
  const slantRangeKm = distanceKm(node.timeState.ecef, groundEcef);
  const elevationDeg = elevationDegFromStationEcef(node.timeState.ecef, groundEcef);
  const currentMinute = minutesSinceEpoch(node, config);
  const minElevationDeg = Math.max(station.minElevationDeg ?? sgl.minElevationDeg, sgl.minElevationDeg);
  const withinElevation = elevationDeg >= minElevationDeg;
  const withinRange = slantRangeKm <= sgl.maxRangeKm;
  const atmosphericLoss = sglAtmosphericLoss(station, elevationDeg, config, currentMinute);
  const channelId = sglChannelId(node, station, config);
  const channelOffset = channelOffsetMhz(
    channelId,
    config.interferenceModel.sgl.reuseChannelCount,
    config.interferenceModel.sgl.channelSpacingMhz,
  );
  const linkBudget = satelliteAntenna
    ? calculateLinkBudget({
        distanceKm: slantRangeKm,
        txPowerW: satelliteAntenna.max_tx_power_w,
        txGainDbi: satelliteAntenna.gain_dbi,
        rxGainDbi: config.linkBudget.sgl.groundStationGainDbi ?? satelliteAntenna.gain_dbi,
        capacityLimitMbps: Math.min(sgl.bandwidthMbps, sgl.reportCapacityMbps),
        config: config.linkBudget.sgl,
        lossBreakdown: {
          ...atmosphericLoss,
          pointingLossDb: totalPointingLossDb,
        },
        pointingState,
        dopplerState,
        noiseState,
        adaptiveCoding: config.adaptiveCoding.sgl,
        channelId,
        channelOffsetMhz: channelOffset,
      })
    : undefined;
  const physicalStatus = linkBudget ? budgetStatus(linkBudget, config.linkBudget.sgl) : "down";
  const withinBudget = physicalStatus !== "down";
  const withinDoppler =
    !linkBudget || (linkBudget.doppler_tracking_margin_hz >= 0 && linkBudget.doppler_residual_margin_hz >= 0);
  const withinPointing = pointingState.availability_factor >= config.pointingModel.minAvailableFraction;
  const visible = withinElevation && withinRange && withinPointing && withinBudget;
  const capacityMbps = visible ? Math.min(sgl.reportCapacityMbps, linkBudget?.capacity_mbps ?? 0) : 0;

  return {
    ground_station_id: station.ground_station_id,
    ground_station_name: station.name,
    visible,
    elevationDeg: round(elevationDeg, 2),
    slantRangeKm: round(slantRangeKm, 1),
    rainRateMmPerHour: round(atmosphericLoss.weather.rainRateMmPerHour, 3),
    cloudLiquidWaterKgPerM2: round(atmosphericLoss.weather.cloudLiquidWaterKgPerM2, 3),
    scintillationFadeDb: round(atmosphericLoss.weather.scintillationFadeDb, 3),
    weatherSampleMinute: round(atmosphericLoss.weather.sampleMinute, 2),
    capacityMbps,
    reportCapacityMbps: capacityMbps,
    linkBudget,
    sourcePointing,
    status: visible ? "available" : "blocked",
    reason: !withinElevation
      ? "below-elevation"
      : !withinRange
        ? "antenna-range"
        : !withinPointing
          ? "pointing-switch"
          : !withinDoppler
            ? "doppler-shift"
          : !withinBudget
            ? (linkBudget?.solar_interference_blocked
              ? "solar-interference"
              : linkBudget && linkBudget.capacity_mbps < config.linkBudget.sgl.minCapacityMbps
                ? "capacity-limit"
                : "link-budget")
            : undefined,
  };
}

type ActiveGroundLinkGeometry = {
  window: GroundLinkWindow;
  satellite: SatelliteNode;
  antenna: SatelliteAntenna;
  station: GroundStation;
  stationEcef: Vector3Km;
  stationEci: Vector3Km;
};

function activeGroundLinkGeometry(
  windows: GroundLinkWindow[],
  nodes: SatelliteNode[],
  config: WalkerNetworkConfig,
) {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const stationById = new Map(config.groundStations.map((station) => [station.ground_station_id, station]));

  return windows.flatMap((window): ActiveGroundLinkGeometry[] => {
    if (window.status !== "available" || !window.linkBudget) return [];
    const satellite = nodeById.get(window.satellite_id);
    const station = stationById.get(window.ground_station_id);
    if (!satellite || !station) return [];
    const antenna = antennaByRole(satellite, "earth-facing");
    if (!antenna) return [];
    return [
      {
        window,
        satellite,
        antenna,
        station,
        stationEcef: groundStationEcef(station, config.constellation.earthRadiusKm),
        stationEci: groundStationEci(station, satellite, config),
      },
    ];
  });
}

function applySglInterference(windows: GroundLinkWindow[], nodes: SatelliteNode[], config: WalkerNetworkConfig) {
  const model = config.interferenceModel.sgl;
  if (!model.enabled) return;

  const activeLinks = activeGroundLinkGeometry(windows, nodes, config);
  const groundStationGainDbi = config.linkBudget.sgl.groundStationGainDbi ?? config.antennaModel.sgl.gainDbi;

  activeLinks.forEach((victim) => {
    let interferenceMw = 0;
    let interferenceCount = 0;
    let coChannelCount = 0;
    let adjacentChannelCount = 0;
    let filteredChannelCount = 0;
    let strongestInterferenceDbm = Number.NEGATIVE_INFINITY;
    let dominantInterfererId: string | undefined;
    let dominantInterfererChannelDelta: number | undefined;
    const victimGroundBoresight = subtractVector(victim.satellite.timeState.eci, victim.stationEci);

    activeLinks.forEach((interferer) => {
      if (interferer.window.id === victim.window.id) return;
      const channelState = channelIsolationState(
        victim.window.linkBudget!.channel_id,
        interferer.window.linkBudget!.channel_id,
        model,
      );
      if (channelState.filtered) {
        filteredChannelCount += 1;
        return;
      }

      const interfererElevationAtVictimDeg = elevationDegFromStationEcef(
        interferer.satellite.timeState.ecef,
        victim.stationEcef,
      );
      if (interfererElevationAtVictimDeg <= 0) return;

      const interfererTargetEci = groundStationEci(interferer.station, interferer.satellite, config);
      const transmitBoresight = subtractVector(interfererTargetEci, interferer.satellite.timeState.eci);
      const transmitDirectionToVictimStation = subtractVector(victim.stationEci, interferer.satellite.timeState.eci);
      const receiveDirectionFromInterferer = subtractVector(interferer.satellite.timeState.eci, victim.stationEci);
      const txGainTowardVictimStation = antennaPatternGainDbi(
        interferer.antenna.gain_dbi,
        interferer.antenna.beamwidth_deg,
        transmitBoresight,
        transmitDirectionToVictimStation,
        config,
      );
      const rxGainTowardInterferer = antennaPatternGainDbi(
        groundStationGainDbi,
        model.groundAntennaBeamwidthDeg,
        victimGroundBoresight,
        receiveDirectionFromInterferer,
        config,
      );
      const pathDistanceKm = distanceKm(interferer.satellite.timeState.eci, victim.stationEci);
      const atmosphericLoss = sglAtmosphericLoss(
        victim.station,
        interfererElevationAtVictimDeg,
        config,
        minuteFromIso(victim.window.time, config),
      );
      const totalLossDb =
        freeSpacePathLossDb(pathDistanceKm, config.linkBudget.sgl.frequencyGhz) +
        config.linkBudget.sgl.implementationLossDb +
        atmosphericLoss.atmosphericLossDb +
        config.linkBudget.sgl.polarizationLossDb +
        channelState.isolationDb +
        model.polarizationIsolationDb;
      const interferenceDbm =
        wattsToDbm(interferer.antenna.max_tx_power_w) +
        txGainTowardVictimStation +
        rxGainTowardInterferer -
        totalLossDb;

      if (interferenceDbm < model.minInterferencePowerDbm) return;
      interferenceMw += dbmToMilliwatts(interferenceDbm);
      interferenceCount += 1;
      if (channelState.relation === "co-channel") {
        coChannelCount += 1;
      } else {
        adjacentChannelCount += 1;
      }
      if (interferenceDbm > strongestInterferenceDbm) {
        strongestInterferenceDbm = interferenceDbm;
        dominantInterfererId = interferer.window.id;
        dominantInterfererChannelDelta = channelState.channelDelta;
      }
    });

    const updatedBudget = applyInterferenceToLinkBudget(
      victim.window.linkBudget!,
      interferenceMw,
      interferenceCount,
      dominantInterfererId,
      config.linkBudget.sgl,
      config.adaptiveCoding.sgl,
      {
        coChannelCount,
        adjacentChannelCount,
        filteredChannelCount,
        dominantInterfererChannelDelta,
      },
    );
    victim.window.linkBudget = updatedBudget;

    const physicalStatus = budgetStatus(updatedBudget, config.linkBudget.sgl);
    if (physicalStatus === "down") {
      victim.window.status = "blocked";
      victim.window.visible = false;
      victim.window.capacityMbps = 0;
      victim.window.reportCapacityMbps = 0;
      victim.window.reason =
        updatedBudget.solar_interference_blocked
          ? "solar-interference"
          : updatedBudget.doppler_tracking_margin_hz < 0 || updatedBudget.doppler_residual_margin_hz < 0
          ? "doppler-shift"
          : updatedBudget.capacity_mbps < config.linkBudget.sgl.minCapacityMbps
            ? "capacity-limit"
            : "link-budget";
      return;
    }

    const capacityMbps = Math.min(config.antennaModel.sgl.reportCapacityMbps, updatedBudget.capacity_mbps);
    victim.window.capacityMbps = capacityMbps;
    victim.window.reportCapacityMbps = capacityMbps;
  });
}

export function updateGroundLinkWindows(
  nodes: SatelliteNode[],
  config: WalkerNetworkConfig,
  pointingHistory?: AntennaPointingHistory,
) {
  const windows: GroundLinkWindow[] = [];

  nodes.forEach((node) => {
    const antenna = antennaByRole(node, "earth-facing");
    if (!antenna) return;

    const candidates = config.groundStations
      .map((station) => groundWindowForStation(node, station, config, pointingHistory))
      .sort((a, b) => {
        const visibleOrder = Number(b.visible) - Number(a.visible);
        if (visibleOrder !== 0) return visibleOrder;
        return b.elevationDeg - a.elevationDeg;
      });

    let occupiedBeams = 0;
    node.groundLinkWindows = candidates.map((candidate) => {
      const canOccupy =
        candidate.visible &&
        antenna.state !== "fault" &&
        occupiedBeams < antenna.max_simultaneous_beams;
      const status: GroundLinkWindow["status"] = canOccupy
        ? "available"
        : candidate.visible
          ? "occupied"
          : "blocked";
      const reason = canOccupy ? undefined : candidate.visible ? "antenna-occupied" : candidate.reason;
      const capacityMbps = canOccupy ? candidate.capacityMbps : 0;
      const { sourcePointing, ...candidateWindow } = candidate;
      const window: GroundLinkWindow = {
        ...candidateWindow,
        id: `SGL:${node.id}->${candidate.ground_station_id}`,
        time: node.timeState.time,
        satellite_id: node.id,
        antenna_id: antenna.antenna_id,
        status,
        capacityMbps,
        reportCapacityMbps: capacityMbps,
        reason,
      };

      if (canOccupy) {
        occupiedBeams += 1;
        const antennaState = (sourcePointing?.switchingDelaySeconds ?? 0) > 0 ? "switching" : "occupied";
        occupyAntenna(node, "earth-facing", candidate.ground_station_id, window.id, antennaState);
        commitAntennaPointing(pointingHistory, sourcePointing);
      }

      return window;
    });
    windows.push(...node.groundLinkWindows);
  });

  applySglInterference(windows, nodes, config);

  return windows;
}
