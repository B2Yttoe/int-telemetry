import type {
  AntennaRole,
  InterPlaneDirection,
  LinkKind,
  LinkPointingState,
  LinkRestrictionReason,
  LinkStatus,
  NetworkSlice,
  NodeMode,
  OrbitModel,
  OrbitPosition,
  SatelliteLink,
  SatelliteLinkState,
  SatelliteNode,
  NodeResourceState,
  SatelliteNodeState,
  SatelliteOrbitElements,
  SatelliteTimeState,
  SimulationInput,
  NodeTaskLoad,
  RoutedTaskPath,
  TleSatelliteRecord,
  Vector3Km,
  WalkerNetworkConfig,
} from "./types";
import {
  antennaByRole,
  antennaPointingForTarget,
  combinePointingEndpoints,
  commitAntennaPointing,
  createSatelliteAntennas,
  islRolesForLink,
  maxIslAntennaRangeKm,
  occupyAntenna,
  updateGroundLinkWindows,
} from "./antenna";
import type { AntennaPointingHistory } from "./antenna";
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
import { sunDirectionEci, sunlightState } from "./spaceEnvironment";
import { orbitElementsFromTleRecord, propagateTleRecord, syntheticWalkerTleRecord } from "./tle";
import { isScenarioTrafficProfile, scenarioTrafficTasks } from "./traffic";
import { parseOrbitEpochUtcMs } from "./utcEpoch";

const SIDEREAL_DAY_MINUTES = 1436.068;

const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
const toDegrees = (radians: number) => (radians * 180) / Math.PI;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const round = (value: number, digits = 1) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

const normalizeDegrees = (degrees: number) => ((degrees % 360) + 360) % 360;

const satelliteId = (plane: number, slot: number) =>
  `P${String(plane + 1).padStart(2, "0")}-S${String(slot + 1).padStart(2, "0")}`;

const seededWave = (plane: number, slot: number, slice: number, speed = 1) =>
  Math.sin((slice * speed + plane * 1.9 + slot * 0.83) * 0.65);

const defaultSimulationInput: SimulationInput = {
  mode: "autonomous",
  tasks: [],
  trafficProfile: "empty",
};

export function semiMajorAxisKm(config: WalkerNetworkConfig) {
  return config.constellation.earthRadiusKm + config.constellation.altitudeKm;
}

export function meanMotionRadPerSec(config: WalkerNetworkConfig) {
  const radius = semiMajorAxisKm(config);
  return Math.sqrt(config.constellation.gravitationalParameterKm3S2 / radius ** 3);
}

export function orbitalPeriodMinutes(config: WalkerNetworkConfig) {
  return (2 * Math.PI) / meanMotionRadPerSec(config) / 60;
}

export function circularOrbitVelocityKmS(config: WalkerNetworkConfig) {
  return Math.sqrt(config.constellation.gravitationalParameterKm3S2 / semiMajorAxisKm(config));
}

export function planeSpacingDeg(config: WalkerNetworkConfig) {
  return (config.constellation.walkerType === "delta" ? 360 : 180) / config.constellation.planes;
}

export function planeRaanDeg(plane: number, config: WalkerNetworkConfig) {
  return normalizeDegrees(plane * planeSpacingDeg(config));
}

export function simulationDateAtMinute(minute: number, config: WalkerNetworkConfig) {
  return new Date(new Date(config.time.epochIso).getTime() + minute * 60 * 1000);
}

function earthRotationAngleRad(minute: number) {
  return (2 * Math.PI * minute) / SIDEREAL_DAY_MINUTES;
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

function rotateX(vector: Vector3Km, angleRad: number): Vector3Km {
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  return {
    x: vector.x,
    y: vector.y * cos - vector.z * sin,
    z: vector.y * sin + vector.z * cos,
  };
}

function orbitalPlanePhaseDeg(node: SatelliteNode) {
  const afterRaan = rotateZ(node.timeState.eci, -toRadians(node.orbit.raanDeg));
  const orbitalFrame = rotateX(afterRaan, -toRadians(node.orbit.inclinationDeg));
  return normalizeDegrees(toDegrees(Math.atan2(orbitalFrame.y, orbitalFrame.x)));
}

function distanceKm(a: Vector3Km, b: Vector3Km) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function subtractVector(to: Vector3Km, from: Vector3Km): Vector3Km {
  return {
    x: to.x - from.x,
    y: to.y - from.y,
    z: to.z - from.z,
  };
}

function vectorMagnitude(vector: Vector3Km) {
  return Math.sqrt(vector.x * vector.x + vector.y * vector.y + vector.z * vector.z);
}

function dot(a: Vector3Km, b: Vector3Km) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
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

function velocityVector(node: SatelliteNode): Vector3Km {
  return {
    x: node.timeState.velocityEci.vx,
    y: node.timeState.velocityEci.vy,
    z: node.timeState.velocityEci.vz,
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

function angleBetweenDeg(a: Vector3Km, b: Vector3Km) {
  const normalizedA = normalizeVector(a);
  const normalizedB = normalizeVector(b);
  return toDegrees(Math.acos(clamp(dot(normalizedA, normalizedB), -1, 1)));
}

function signedAngleDeltaDeg(current: number, reference: number) {
  return ((current - reference + 540) % 360) - 180;
}

function segmentMinimumRadiusKm(a: Vector3Km, b: Vector3Km) {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const abz = b.z - a.z;
  const ab2 = abx * abx + aby * aby + abz * abz;
  const t = ab2 === 0 ? 0 : clamp(-(a.x * abx + a.y * aby + a.z * abz) / ab2, 0, 1);
  const px = a.x + abx * t;
  const py = a.y + aby * t;
  const pz = a.z + abz * t;
  return Math.sqrt(px * px + py * py + pz * pz);
}

function lineOfSight(source: SatelliteNode, target: SatelliteNode, config: WalkerNetworkConfig) {
  if (!config.earthOcclusion.enabled) return true;
  const minRadius = segmentMinimumRadiusKm(source.timeState.eci, target.timeState.eci);
  return minRadius > config.constellation.earthRadiusKm + config.earthOcclusion.clearanceKm;
}

function antennaById(node: SatelliteNode, antennaId?: string) {
  return node.antennas.find((antenna) => antenna.antenna_id === antennaId);
}

function directionalGainDbi(
  antenna: NonNullable<ReturnType<typeof antennaById>>,
  boresight: Vector3Km,
  direction: Vector3Km,
  config: WalkerNetworkConfig,
) {
  const model = config.interferenceModel.isl;
  const offAxisDeg = angleBetweenDeg(boresight, direction);
  const halfBeamDeg = Math.max(antenna.beamwidth_deg / 2, 0.001);

  if (offAxisDeg <= halfBeamDeg) {
    return antenna.gain_dbi - 3 * (offAxisDeg / halfBeamDeg) ** 2;
  }

  const offAxisRatio = Math.max(offAxisDeg / halfBeamDeg, 1);
  const sideLobeGain =
    antenna.gain_dbi -
    model.sideLobeSuppressionDb -
    model.offAxisRollOffDbPerDecade * Math.log10(offAxisRatio);
  const backLobeGain = antenna.gain_dbi - model.frontBackSuppressionDb;
  const envelopeGain = offAxisDeg > 90 ? Math.min(sideLobeGain, backLobeGain) : sideLobeGain;
  return Math.max(model.minSideLobeGainDbi, envelopeGain);
}

function totalIslLossDb(freeSpaceLossDb: number, config: WalkerNetworkConfig) {
  const budget = config.linkBudget.isl;
  return (
    freeSpaceLossDb +
    budget.implementationLossDb +
    budget.atmosphericLossDb +
    budget.polarizationLossDb +
    budget.pointingLossDb
  );
}

function normalizedChannelId(channelId: number, channelCount: number) {
  const normalizedChannelCount = Math.max(Math.round(channelCount), 1);
  return ((Math.round(channelId) % normalizedChannelCount) + normalizedChannelCount) % normalizedChannelCount;
}

function islChannelId(source: SatelliteNode, target: SatelliteNode, config: WalkerNetworkConfig) {
  const model = config.interferenceModel.isl;
  const channelCount = Math.max(Math.round(model.reuseChannelCount), 1);
  if (channelCount === 1) return 0;

  if (source.plane === target.plane) {
    const slotAnchor = Math.min(source.slot, target.slot);
    return normalizedChannelId(source.plane * 2 + (slotAnchor % 2), channelCount);
  }

  const planeAnchor = Math.min(source.plane, target.plane);
  const slotAnchor = Math.min(source.slot, target.slot);
  return normalizedChannelId(planeAnchor * 3 + slotAnchor, channelCount);
}

function budgetRestrictionReason(
  budget: SatelliteLinkState["linkBudget"],
  config: WalkerNetworkConfig,
): LinkRestrictionReason {
  if (budget?.solar_interference_blocked) return "solar-interference";
  if (budget && (budget.doppler_tracking_margin_hz < 0 || budget.doppler_residual_margin_hz < 0)) {
    return "doppler-shift";
  }
  if (budget && budget.capacity_mbps < config.linkBudget.isl.minCapacityMbps) {
    return "capacity-limit";
  }
  return "link-budget";
}

function islLinkBudget(
  source: SatelliteNode,
  target: SatelliteNode,
  sourceRole: AntennaRole,
  targetRole: AntennaRole,
  config: WalkerNetworkConfig,
  pointingHistory?: AntennaPointingHistory,
  fixedPointing = false,
) {
  const sourceAntenna = antennaByRole(source, sourceRole);
  const targetAntenna = antennaByRole(target, targetRole);
  if (!sourceAntenna || !targetAntenna) return undefined;

  const sourcePointing = antennaPointingForTarget(
    source,
    sourceAntenna,
    target.id,
    target.timeState.eci,
    config,
    pointingHistory,
  );
  const targetPointing = antennaPointingForTarget(
    target,
    targetAntenna,
    source.id,
    source.timeState.eci,
    config,
    pointingHistory,
  );
  const combinedPointingState = combinePointingEndpoints(sourcePointing, targetPointing);
  const pointingState: LinkPointingState = fixedPointing
    ? {
        ...combinedPointingState,
        switching_delay_s: 0,
        availability_factor: 1,
      }
    : combinedPointingState;
  const totalPointingLossDb = config.linkBudget.isl.pointingLossDb + pointingState.dynamic_pointing_loss_db;
  const radialVelocityKmS = relativeRadialVelocityKmS(
    source.timeState.eci,
    target.timeState.eci,
    velocityVector(source),
    velocityVector(target),
  );
  const dopplerState = calculateDopplerState(
    radialVelocityKmS,
    config.linkBudget.isl.frequencyGhz,
    config.dopplerModel.isl,
    config.dopplerModel.enabled,
  );
  const receiveBoresight = subtractVector(source.timeState.eci, target.timeState.eci);
  const sunSeparationDeg = angleBetweenDeg(
    receiveBoresight,
    sunDirectionEci(new Date(target.timeState.time)),
  );
  const noiseState = calculateNoiseState(
    sunSeparationDeg,
    targetAntenna.beamwidth_deg,
    config.noiseModel.isl,
    config.noiseModel.enabled,
  );
  const channelId = islChannelId(source, target, config);
  const channelOffset = channelOffsetMhz(
    channelId,
    config.interferenceModel.isl.reuseChannelCount,
    config.interferenceModel.isl.channelSpacingMhz,
  );
  const budget = calculateLinkBudget({
    distanceKm: distanceKm(source.timeState.eci, target.timeState.eci),
    txPowerW: sourceAntenna.max_tx_power_w,
    txGainDbi: sourceAntenna.gain_dbi,
    rxGainDbi: targetAntenna.gain_dbi,
    capacityLimitMbps: Math.min(sourceAntenna.bandwidth_mbps, targetAntenna.bandwidth_mbps),
    config: config.linkBudget.isl,
    lossBreakdown: {
      pointingLossDb: totalPointingLossDb,
    },
    pointingState,
    dopplerState,
    noiseState,
    adaptiveCoding: config.adaptiveCoding.isl,
    channelId,
    channelOffsetMhz: channelOffset,
  });

  return {
    budget,
    sourcePointing,
    targetPointing,
  };
}

export function satelliteOrbitElements(
  plane: number,
  slot: number,
  config: WalkerNetworkConfig,
): SatelliteOrbitElements {
  const { planes, satellitesPerPlane, phasing, inclinationDeg, shellId, walkerType } = config.constellation;
  const phaseOffsetDeg = (360 * phasing * plane) / (planes * satellitesPerPlane);
  const meanAnomalyDegAtEpoch = normalizeDegrees((360 * slot) / satellitesPerPlane + phaseOffsetDeg);

  return {
    satelliteId: satelliteId(plane, slot),
    orbitModel: "analytic-walker",
    shellId,
    walkerType,
    plane,
    slot,
    semiMajorAxisKm: semiMajorAxisKm(config),
    eccentricity: 0,
    inclinationDeg,
    raanDeg: planeRaanDeg(plane, config),
    argumentOfPerigeeDeg: 0,
    meanAnomalyDegAtEpoch,
    meanMotionRadPerSec: meanMotionRadPerSec(config),
    meanMotionRevPerDay: (meanMotionRadPerSec(config) * 86400) / (2 * Math.PI),
    orbitalPeriodMinutes: orbitalPeriodMinutes(config),
    epochIso: config.time.epochIso,
  };
}

export function propagateOrbitElements(
  orbit: SatelliteOrbitElements,
  minute: number,
  config: WalkerNetworkConfig,
): SatelliteTimeState {
  const meanAnomalyRad = toRadians(orbit.meanAnomalyDegAtEpoch) + orbit.meanMotionRadPerSec * minute * 60;
  const inclinationRad = toRadians(orbit.inclinationDeg);
  const raanRad = toRadians(orbit.raanDeg);
  const radius = orbit.semiMajorAxisKm;
  const speed = Math.sqrt(config.constellation.gravitationalParameterKm3S2 / radius);

  const orbitalPosition = {
    x: radius * Math.cos(meanAnomalyRad),
    y: radius * Math.sin(meanAnomalyRad),
    z: 0,
  };
  const orbitalVelocity = {
    x: -speed * Math.sin(meanAnomalyRad),
    y: speed * Math.cos(meanAnomalyRad),
    z: 0,
  };

  const inclinedPosition = {
    x: orbitalPosition.x,
    y: orbitalPosition.y * Math.cos(inclinationRad),
    z: orbitalPosition.y * Math.sin(inclinationRad),
  };
  const inclinedVelocity = {
    x: orbitalVelocity.x,
    y: orbitalVelocity.y * Math.cos(inclinationRad),
    z: orbitalVelocity.y * Math.sin(inclinationRad),
  };

  const eci = rotateZ(inclinedPosition, raanRad);
  const velocity = rotateZ(inclinedVelocity, raanRad);
  const ecef = rotateZ(eci, -earthRotationAngleRad(minute));
  const eciLongitudeDeg = ((toDegrees(Math.atan2(eci.y, eci.x)) + 540) % 360) - 180;
  const longitudeDeg = ((toDegrees(Math.atan2(ecef.y, ecef.x)) + 540) % 360) - 180;
  const latitudeDeg = toDegrees(Math.asin(clamp(ecef.z / radius, -1, 1)));
  const sunlight = sunlightState(eci, simulationDateAtMinute(minute, config));

  return {
    time: simulationDateAtMinute(minute, config).toISOString(),
    satelliteId: orbit.satelliteId,
    eci: {
      x: round(eci.x, 3),
      y: round(eci.y, 3),
      z: round(eci.z, 3),
    },
    ecef: {
      x: round(ecef.x, 3),
      y: round(ecef.y, 3),
      z: round(ecef.z, 3),
    },
    velocityEci: {
      vx: round(velocity.x, 5),
      vy: round(velocity.y, 5),
      vz: round(velocity.z, 5),
    },
    latitudeDeg: round(latitudeDeg, 5),
    longitudeDeg: round(longitudeDeg, 5),
    altitudeKm: round(radius - config.constellation.earthRadiusKm, 3),
    orbitalVelocityKmS: round(speed, 5),
    groundTrack: {
      latitudeDeg: round(latitudeDeg, 5),
      longitudeDeg: round(longitudeDeg, 5),
    },
    eastWestDriftDeg: round(signedAngleDeltaDeg(longitudeDeg, eciLongitudeDeg), 3),
    solarExposure: sunlight.solarExposure,
    inSunlight: sunlight.inSunlight,
    inEclipse: sunlight.inEclipse,
  };
}

export function calculatePosition(
  plane: number,
  slot: number,
  minute: number,
  config: WalkerNetworkConfig,
  orbitModel: OrbitModel = config.orbit.model,
): OrbitPosition {
  const tleRecord = orbitModel === "tle-sgp4" ? syntheticWalkerTleRecord(plane, slot, config) : undefined;
  const orbit = tleRecord ? orbitElementsFromTleRecord(tleRecord, config) : satelliteOrbitElements(plane, slot, config);
  const timeState = tleRecord ? propagateTleRecord(tleRecord, minute, config) : propagateOrbitElements(orbit, minute, config);
  return {
    x: timeState.eci.x,
    y: timeState.eci.y,
    z: timeState.eci.z,
    frame: "ECI",
    longitudeDeg: timeState.longitudeDeg,
    latitudeDeg: timeState.latitudeDeg,
    altitudeKm: timeState.altitudeKm,
  };
}

function positionFromTimeState(timeState: SatelliteTimeState): OrbitPosition {
  return {
    x: timeState.eci.x,
    y: timeState.eci.y,
    z: timeState.eci.z,
    frame: "ECI",
    longitudeDeg: timeState.longitudeDeg,
    latitudeDeg: timeState.latitudeDeg,
    altitudeKm: timeState.altitudeKm,
  };
}

function orbitModelFromInput(config: WalkerNetworkConfig, input: SimulationInput): OrbitModel {
  if (input.tleCatalogSnapshot) return "real-tle-sgp4";
  return input.orbitModel ?? config.orbit.model;
}

function configForSimulation(config: WalkerNetworkConfig, input: SimulationInput): WalkerNetworkConfig {
  const snapshot = input.tleCatalogSnapshot;
  if (!snapshot) return config;
  return {
    ...config,
    constellation: {
      ...config.constellation,
      shellId: snapshot.shell_id,
      planes: snapshot.layout.planes,
      satellitesPerPlane: snapshot.layout.satellites_per_plane,
      altitudeKm: snapshot.mean_altitude_km,
      inclinationDeg: snapshot.mean_inclination_deg,
    },
    orbit: {
      ...config.orbit,
      model: "real-tle-sgp4",
      tleCatalog: {
        ...config.orbit.tleCatalog,
        source: snapshot.source,
      },
    },
  };
}

function tlePhaseAtReference(record: TleSatelliteRecord, referenceIso: string) {
  const epochMs = parseOrbitEpochUtcMs(record.epoch);
  const referenceMs = parseOrbitEpochUtcMs(referenceIso);
  if (!Number.isFinite(epochMs) || !Number.isFinite(referenceMs)) {
    return normalizeDegrees(record.argument_of_perigee + record.mean_anomaly);
  }
  const deltaDays = (referenceMs - epochMs) / 86400000;
  return normalizeDegrees(record.argument_of_perigee + record.mean_anomaly + record.mean_motion * 360 * deltaDays);
}

function realTleRecordsFromInput(input: SimulationInput, config: WalkerNetworkConfig) {
  const records = input.tleCatalogSnapshot?.satellites;
  if (!records) return undefined;

  const byPlane = new Map<number, TleSatelliteRecord[]>();
  records.forEach((record) => {
    byPlane.set(record.plane_id, [...(byPlane.get(record.plane_id) ?? []), record]);
  });

  return [...byPlane.entries()]
    .sort(([left], [right]) => left - right)
    .flatMap(([plane, planeRecords]) =>
      [...planeRecords]
        .sort(
          (left, right) =>
            tlePhaseAtReference(left, config.time.epochIso) - tlePhaseAtReference(right, config.time.epochIso) ||
            left.norad_id - right.norad_id,
        )
        .map((record, slot) => ({
          ...record,
          satellite_id: satelliteId(plane, slot),
          plane_id: plane,
          slot_id: slot,
        })),
    );
}

function effectiveSimulationInput(config: WalkerNetworkConfig, input: SimulationInput): SimulationInput {
  const trafficProfile = input.trafficProfile ?? (input.tasks.length > 0 ? "uploaded" : "empty");
  if (isScenarioTrafficProfile(trafficProfile)) {
    return {
      ...input,
      trafficProfile,
      tasks: [...scenarioTrafficTasks(config, trafficProfile), ...input.tasks],
    };
  }
  return { ...input, trafficProfile, tasks: trafficProfile === "empty" ? [] : input.tasks };
}

export function isInPolarRegion(node: SatelliteNode, config: WalkerNetworkConfig) {
  return config.polarRegion.enabled && Math.abs(node.timeState.latitudeDeg) >= config.polarRegion.latitudeDeg;
}

function nodeState(plane: number, slot: number, slice: number, config: WalkerNetworkConfig): SatelliteNodeState {
  const base = config.nodeStateDefaults;
  const profile = config.stateProfiles;
  const loadWave = seededWave(plane, slot, slice, 1.2);
  const heatWave = seededWave(plane, slot, slice, 0.72);
  const queueWave = seededWave(plane, slot, slice, 1.8);
  const cpuLoadPercent = round(clamp(base.cpuLoadPercent + loadWave * profile.nodeLoadWavePercent, 4, 98), 0);
  const temperatureC = round(base.temperatureC + heatWave * profile.nodeThermalWaveC, 1);
  const queueDepth = round(clamp(base.queueDepth + queueWave * profile.queueWaveDepth, 0, 96), 0);
  const batteryPercent = round(clamp(base.batteryPercent - Math.max(0, cpuLoadPercent - 48) * 0.16, 12, 100), 0);
  const mode: NodeMode =
    cpuLoadPercent > 84 || temperatureC > 31 || batteryPercent < 35
      ? "degraded"
      : cpuLoadPercent > 68 || temperatureC > 27 || queueDepth > 38
        ? "warning"
        : base.mode;

  return { mode, batteryPercent, cpuLoadPercent, temperatureC, queueDepth };
}

function nodeResources(
  nodeId: string,
  plane: number,
  slot: number,
  slice: number,
  state: SatelliteNodeState,
  config: WalkerNetworkConfig,
  taskLoad: NodeTaskLoad,
  timeState: SatelliteTimeState,
  previousEnergyWhInput: number,
  mode: SimulationInput["mode"],
): NodeResourceState {
  const base = config.nodeResourceDefaults;
  const model = config.operationalModel;
  const batteryCapacityWh = model.batteryCapacityWh;
  const minEnergyWh = model.minStateOfCharge * batteryCapacityWh;
  const previousEnergyWh = clamp(previousEnergyWhInput, minEnergyWh, batteryCapacityWh);
  const canRunTasksThisSlice = mode === "operational" && previousEnergyWh > minEnergyWh;
  const effectiveTaskLoad = canRunTasksThisSlice ? taskLoad : emptyTaskLoad();
  const taskCpuLoad =
    base.cpu_capacity > 0 ? (effectiveTaskLoad.computeUnits / base.cpu_capacity) * 100 : 0;
  const taskGpuLoad =
    base.gpu_capacity && base.gpu_capacity > 0 ? (effectiveTaskLoad.gpuUnits / base.gpu_capacity) * 100 : 0;
  const memoryWave = seededWave(plane, slot, slice, 0.52);
  const storageWave = seededWave(plane, slot, slice, 0.28);
  const gpuWave = seededWave(plane + 2, slot + 5, slice, 0.91);
  const operationalMemoryUtilization = base.memory > 0 ? (effectiveTaskLoad.memoryGb / base.memory) * 100 : 0;
  const operationalStorageUtilization = base.storage > 0 ? (effectiveTaskLoad.storageGb / base.storage) * 100 : 0;
  const memoryUtilization =
    mode === "operational"
      ? round(clamp(operationalMemoryUtilization, 0, 100), 0)
      : round(
          clamp(base.memory_utilization + memoryWave * 16 + state.queueDepth * 0.18, 0, 100),
          0,
        );
  const storageUtilization =
    mode === "operational"
      ? round(clamp(operationalStorageUtilization, 0, 100), 0)
      : round(
          clamp(base.storage_utilization + storageWave * 7 + plane * 1.4 + slot * 0.35, 0, 100),
          0,
        );
  const gpuUtilization =
    base.gpu_capacity === undefined || base.gpu_utilization === undefined
      ? undefined
      : mode === "operational"
        ? round(clamp(taskGpuLoad, 0, 100), 0)
        : round(
            clamp(base.gpu_utilization + gpuWave * 22 + Math.max(0, state.cpuLoadPercent - 55) * 0.2, 0, 100),
            0,
          );
  const autonomousEnergy = state.batteryPercent;
  const timeStepHours = config.time.stepMinutes / 60;
  const nominalLoadPowerW =
    model.basePowerW + model.communicationPowerW + model.computePowerW + model.payloadPowerW;
  const taskExtraComputePowerW = (clamp(taskCpuLoad, 0, 100) / 100) * model.computePowerW;
  const loadPowerW = round(nominalLoadPowerW + taskExtraComputePowerW, 2);
  const solarPowerW = round(
    timeState.solarExposure * model.solarConstantWPerM2 * model.solarArrayAreaM2 * model.solarArrayEfficiency,
    2,
  );
  const chargePowerW = Math.max(solarPowerW - loadPowerW, 0);
  const dischargePowerW = Math.max(loadPowerW - solarPowerW, 0);
  const netPowerW = round(
    model.chargeEfficiency * chargePowerW - dischargePowerW / model.dischargeEfficiency,
    2,
  );
  const operationalEnergyWh = round(
    clamp(previousEnergyWh + netPowerW * timeStepHours, minEnergyWh, batteryCapacityWh),
    2,
  );
  const operationalEnergy = round((operationalEnergyWh / batteryCapacityWh) * 100, 0);
  const energy = mode === "operational" ? operationalEnergy : autonomousEnergy;
  const energyWh = mode === "operational" ? operationalEnergyWh : round((energy / 100) * batteryCapacityWh, 2);
  const stateOfCharge = round(energyWh / batteryCapacityWh, 4);
  const powerSavingMode = mode === "operational" ? stateOfCharge <= model.minStateOfCharge : false;
  const cpuUtilization =
    mode === "operational"
      ? round(clamp(taskCpuLoad, 0, 100), 0)
      : state.cpuLoadPercent;
  const computeCpuPercent = mode === "operational" ? round(clamp(taskCpuLoad, 0, 100), 1) : 0;
  const taskTrafficCpuPercent = 0;

  return {
    node_id: nodeId,
    node_type: base.node_type,
    cpu_capacity: base.cpu_capacity,
    gpu_capacity: base.gpu_capacity,
    memory: base.memory,
    storage: base.storage,
    energy,
    energy_wh: energyWh,
    battery_capacity_wh: batteryCapacityWh,
    state_of_charge: stateOfCharge,
    min_state_of_charge: model.minStateOfCharge,
    solar_power_w: solarPowerW,
    load_power_w: loadPowerW,
    net_power_w: netPowerW,
    power_saving_mode: powerSavingMode,
    cpu_utilization: cpuUtilization,
    compute_cpu_percent: computeCpuPercent,
    task_traffic_cpu_percent: taskTrafficCpuPercent,
    forwarding_cpu_percent: 0,
    queue_cpu_percent: 0,
    gpu_utilization: gpuUtilization,
    memory_utilization: memoryUtilization,
    storage_utilization: storageUtilization,
    can_accept_tasks: mode === "operational" ? !powerSavingMode : energy > 0,
    assigned_task_count: effectiveTaskLoad.taskCount,
    workload_cpu_percent: round(taskCpuLoad, 1),
    workload_gpu_percent: round(taskGpuLoad, 1),
    workload_memory_gb: round(effectiveTaskLoad.memoryGb, 2),
    workload_storage_gb: round(effectiveTaskLoad.storageGb, 2),
    memory_used_gb: round(effectiveTaskLoad.memoryGb, 2),
    storage_used_gb: round(effectiveTaskLoad.storageGb, 2),
    ingress_traffic_mbps: 0,
    egress_traffic_mbps: 0,
    transit_traffic_mbps: 0,
    forwarding_load_mbps: 0,
    downlink_load_mbps: 0,
    active_isl_links: 0,
    active_sgl_links: 0,
    link_occupancy_percent: 0,
    base_power_w: model.basePowerW,
    payload_power_w: model.payloadPowerW,
    task_compute_power_w: round(taskExtraComputePowerW, 2),
    network_compute_power_w: 0,
    communication_power_w: 0,
    queued_traffic_mb: 0,
    dropped_traffic_mb: 0,
    cache_used_mb: 0,
    cache_utilization: 0,
    telemetry_generated_mb: 0,
    telemetry_buffer_mb: 0,
    telemetry_downlinked_mb: 0,
    telemetry_dropped_mb: 0,
  };
}

function emptyTaskLoad(): NodeTaskLoad {
  return {
    taskCount: 0,
    computeUnits: 0,
    gpuUnits: 0,
    memoryGb: 0,
    storageGb: 0,
    trafficMbps: 0,
  };
}

function taskIsActiveInSlice(task: SimulationInput["tasks"][number], slice: number) {
  const duration = Math.max(1, task.duration_slices || 1);
  return slice >= task.start_slice && slice < task.start_slice + duration;
}

function taskTargetNodeId(task: SimulationInput["tasks"][number], nodes: Array<{ id: string }>) {
  if (task.node_id && !task.source && !task.target) return task.node_id;
  if (task.source && task.target && !task.node_id) return task.source;
  return undefined;
}

function taskLoadByNode(slice: number, tasks: SimulationInput["tasks"], nodeIds: Array<{ id: string }>) {
  const loads = new Map<string, NodeTaskLoad>();
  nodeIds.forEach((node) => loads.set(node.id, emptyTaskLoad()));

  tasks.filter((task) => taskIsActiveInSlice(task, slice)).forEach((task) => {
    const targetNodeId = taskTargetNodeId(task, nodeIds);
    if (!targetNodeId) return;
    const load = loads.get(targetNodeId);
    if (!load) return;
    load.taskCount += 1;
    load.computeUnits += task.compute_units;
    load.gpuUnits += task.gpu_units ?? 0;
    load.memoryGb += task.memory_gb ?? 0;
    load.storageGb += task.storage_gb ?? 0;
    load.trafficMbps += task.traffic_mbps ?? 0;
  });

  return loads;
}

function operationalNodeState(
  resources: NodeResourceState,
  taskLoad: NodeTaskLoad,
  config: WalkerNetworkConfig,
) {
  const cpuLoadPercent = resources.cpu_utilization;
  const queueDepth = round(
    clamp(
      Math.max(
        taskLoad.taskCount * config.operationalModel.queueDepthPerTask +
          (taskLoad.trafficMbps / 1000) * config.trafficModel.endpointQueueDepthPerGbps,
        resources.queued_traffic_mb * config.trafficModel.queueDepthPerQueuedMb,
      ),
      0,
      100,
    ),
    0,
  );
  const temperatureC = round(
    config.nodeStateDefaults.temperatureC +
      Math.max(0, cpuLoadPercent) * config.operationalModel.thermalRisePerCpuPercent +
      Math.max(0, resources.gpu_utilization ?? 0) * config.operationalModel.thermalRisePerGpuPercent +
      Math.max(0, resources.communication_power_w) * config.operationalModel.thermalRisePerCommunicationW,
    1,
  );
  const batteryPercent = resources.energy;
  const minEnergyPercent = config.operationalModel.minStateOfCharge * 100;
  const mode: NodeMode =
    cpuLoadPercent > 90 || temperatureC > 34
      ? "degraded"
      : resources.power_saving_mode || batteryPercent <= minEnergyPercent || cpuLoadPercent > 72 || queueDepth > 48
        ? "warning"
        : "nominal";

  return { mode, batteryPercent, cpuLoadPercent, temperatureC, queueDepth };
}

function createNodes(
  slice: number,
  config: WalkerNetworkConfig,
  input: SimulationInput,
  previousEnergyWhByNode: Map<string, number>,
): SatelliteNode[] {
  const minute = slice * config.time.stepMinutes;
  const orbitModel = orbitModelFromInput(config, input);
  const nodes: SatelliteNode[] = [];
  const realTleRecords = orbitModel === "real-tle-sgp4" ? realTleRecordsFromInput(input, config) : undefined;
  const nodeIds = realTleRecords
    ? realTleRecords.map((record) => ({ id: record.satellite_id }))
    : Array.from({ length: config.constellation.planes * config.constellation.satellitesPerPlane }, (_, index) => {
        const plane = Math.floor(index / config.constellation.satellitesPerPlane);
        const slot = index % config.constellation.satellitesPerPlane;
        return { id: satelliteId(plane, slot) };
      });
  const loads = taskLoadByNode(slice, input.tasks, nodeIds);

  if (realTleRecords) {
    [...realTleRecords]
      .sort((a, b) => a.plane_id - b.plane_id || a.slot_id - b.slot_id)
      .forEach((tleRecord) => {
        const plane = tleRecord.plane_id;
        const slot = tleRecord.slot_id;
        const orbit = orbitElementsFromTleRecord(tleRecord, config);
        const timeState = propagateTleRecord(tleRecord, minute, config);
        const position = positionFromTimeState(timeState);
        const autonomousState = nodeState(plane, slot, slice, config);
        const taskLoad = loads.get(orbit.satelliteId) ?? emptyTaskLoad();
        const previousEnergyWh = previousEnergyWhByNode.get(orbit.satelliteId) ?? config.nodeResourceDefaults.energy_wh;
        const resources = nodeResources(
          orbit.satelliteId,
          plane,
          slot,
          slice,
          autonomousState,
          config,
          taskLoad,
          timeState,
          previousEnergyWh,
          input.mode,
        );
        const state =
          input.mode === "operational"
            ? operationalNodeState(resources, taskLoad, config)
            : autonomousState;
        nodes.push({
          id: orbit.satelliteId,
          label: orbit.satelliteId,
          plane,
          slot,
          orbit,
          timeState,
          position,
          state,
          resources,
          antennas: createSatelliteAntennas(orbit.satelliteId, config),
          groundLinkWindows: [],
          taskLoad,
          operationMode: input.mode,
        });
      });

    return nodes;
  }

  for (let plane = 0; plane < config.constellation.planes; plane += 1) {
    for (let slot = 0; slot < config.constellation.satellitesPerPlane; slot += 1) {
      const tleRecord = orbitModel === "tle-sgp4" ? syntheticWalkerTleRecord(plane, slot, config) : undefined;
      const orbit = tleRecord ? orbitElementsFromTleRecord(tleRecord, config) : satelliteOrbitElements(plane, slot, config);
      const timeState = tleRecord ? propagateTleRecord(tleRecord, minute, config) : propagateOrbitElements(orbit, minute, config);
      const position = positionFromTimeState(timeState);
      const autonomousState = nodeState(plane, slot, slice, config);
      const taskLoad = loads.get(orbit.satelliteId) ?? emptyTaskLoad();
      const previousEnergyWh = previousEnergyWhByNode.get(orbit.satelliteId) ?? config.nodeResourceDefaults.energy_wh;
      const resources = nodeResources(
        orbit.satelliteId,
        plane,
        slot,
        slice,
        autonomousState,
        config,
        taskLoad,
        timeState,
        previousEnergyWh,
        input.mode,
      );
      const state =
        input.mode === "operational"
          ? operationalNodeState(resources, taskLoad, config)
          : autonomousState;
      nodes.push({
        id: orbit.satelliteId,
        label: orbit.satelliteId,
        plane,
        slot,
        orbit,
        timeState,
        position,
        state,
        resources,
        antennas: createSatelliteAntennas(orbit.satelliteId, config),
        groundLinkWindows: [],
        taskLoad,
        operationMode: input.mode,
      });
    }
  }

  return nodes;
}

function linkState(
  kind: LinkKind,
  source: SatelliteNode,
  target: SatelliteNode,
  slice: number,
  config: WalkerNetworkConfig,
  antennaMaxRangeKm = Number.POSITIVE_INFINITY,
  linkBudget?: SatelliteLinkState["linkBudget"],
): SatelliteLinkState {
  const base = config.linkStateDefaults;
  const distance = round(distanceKm(source.timeState.eci, target.timeState.eci), 1);
  const utilizationWave = seededWave(source.plane + target.plane, source.slot + target.slot, slice, 1.05);
  const isOperational = source.operationMode === "operational" || target.operationMode === "operational";
  const utilizationPercent = round(
    isOperational
      ? 0
      : clamp(base.utilizationPercent + utilizationWave * config.stateProfiles.linkUtilizationWavePercent, 0, 99),
    0,
  );
  const latencyMs = round(base.latencyMs + distance / config.stateProfiles.distanceLatencyDivisor, 1);

  let status: LinkStatus = "up";
  let restrictionReason: SatelliteLinkState["restrictionReason"];
  const hasLineOfSight = kind === "intra-plane" || lineOfSight(source, target, config);

  if (kind === "inter-plane") {
    const warningThreshold = config.interPlane.maxDistanceKm - config.interPlane.warningMarginKm;
    if (isInPolarRegion(source, config) || isInPolarRegion(target, config)) {
      status = "down";
      restrictionReason = "polar-region";
    } else if (!hasLineOfSight) {
      status = "down";
      restrictionReason = "earth-occluded";
    } else if (distance > config.interPlane.maxDistanceKm) {
      status = "down";
      restrictionReason = "distance-threshold";
    } else if (distance > antennaMaxRangeKm) {
      status = "down";
      restrictionReason = "antenna-range";
    } else {
      status = distance > warningThreshold ? "warning" : "up";
    }
  } else if (distance > antennaMaxRangeKm) {
    status = "down";
    restrictionReason = "antenna-range";
  } else if (utilizationPercent > 88) {
    status = "warning";
  }

  if (status !== "down" && linkBudget) {
    if (linkBudget.availability_factor < config.pointingModel.minAvailableFraction) {
      status = "down";
      restrictionReason = "pointing-switch";
    } else {
      const physicalStatus = budgetStatus(linkBudget, config.linkBudget.isl);
      if (physicalStatus === "down") {
        status = "down";
        restrictionReason = budgetRestrictionReason(linkBudget, config);
      } else if (
        physicalStatus === "warning" ||
        linkBudget.availability_factor < config.pointingModel.warningAvailableFraction
      ) {
        status = "warning";
      }
    }
  }

  return {
    status,
    bandwidthMbps: linkBudget ? Math.max(1, round(linkBudget.capacity_mbps, 0)) : base.bandwidthMbps,
    latencyMs,
    utilizationPercent,
    demandTrafficMbps: 0,
    carriedTrafficMbps: 0,
    queuedTrafficMb: 0,
    droppedTrafficMb: 0,
    congestionPercent: 0,
    distanceKm: distance,
    isActive: status !== "down",
    lineOfSight: hasLineOfSight,
    linkBudget,
    restrictionReason,
  };
}

function createLink(
  kind: LinkKind,
  source: SatelliteNode,
  target: SatelliteNode,
  slice: number,
  config: WalkerNetworkConfig,
  interPlaneDirection: InterPlaneDirection = "none",
  state?: SatelliteLinkState,
  sourceAntennaId?: string,
  targetAntennaId?: string,
): SatelliteLink {
  return {
    id: `${kind}:${source.id}->${target.id}`,
    source: source.id,
    target: target.id,
    kind,
    interPlaneDirection,
    designCandidate: true,
    sourceAntennaId,
    targetAntennaId,
    state: state ?? linkState(kind, source, target, slice, config),
  };
}

const endpointKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

function addLinkWithDegreeLimit(
  links: SatelliteLink[],
  usedEndpoints: Set<string>,
  degreeByNode: Map<string, number>,
  kind: LinkKind,
  source: SatelliteNode,
  target: SatelliteNode,
  slice: number,
  config: WalkerNetworkConfig,
  interPlaneDirection: InterPlaneDirection = "none",
  precomputedState?: SatelliteLinkState,
  pointingHistory?: AntennaPointingHistory,
) {
  const key = endpointKey(source.id, target.id);
  if (usedEndpoints.has(key)) return false;
  const sourceDegree = degreeByNode.get(source.id) ?? 0;
  const targetDegree = degreeByNode.get(target.id) ?? 0;
  const maxLinksPerNode = config.interPlane.maxLinksPerNode ?? 4;
  if (sourceDegree >= maxLinksPerNode || targetDegree >= maxLinksPerNode) {
    return false;
  }

  const { sourceRole, targetRole } = islRolesForLink(
    source,
    target,
    kind,
    config.constellation.satellitesPerPlane,
  );
  const sourceAntenna = antennaByRole(source, sourceRole);
  const targetAntenna = antennaByRole(target, targetRole);
  const antennaMaxRangeKm = maxIslAntennaRangeKm(source, target, sourceRole, targetRole);
  const budgetResult = islLinkBudget(
    source,
    target,
    sourceRole,
    targetRole,
    config,
    pointingHistory,
    kind === "intra-plane",
  );
  const state = precomputedState ?? linkState(kind, source, target, slice, config, antennaMaxRangeKm, budgetResult?.budget);
  const sourceAntennaReady =
    sourceAntenna && sourceAntenna.state !== "fault" && sourceAntenna.occupied_beams < sourceAntenna.max_simultaneous_beams;
  const targetAntennaReady =
    targetAntenna && targetAntenna.state !== "fault" && targetAntenna.occupied_beams < targetAntenna.max_simultaneous_beams;

  if (state.isActive && (!sourceAntennaReady || !targetAntennaReady)) {
    return false;
  }

  if (state.isActive) {
    const antennaState = (state.linkBudget?.switching_delay_s ?? 0) > 0 ? "switching" : "occupied";
    occupyAntenna(source, sourceRole, target.id, `${kind}:${source.id}->${target.id}`, antennaState);
    occupyAntenna(target, targetRole, source.id, `${kind}:${source.id}->${target.id}`, antennaState);
    commitAntennaPointing(pointingHistory, budgetResult?.sourcePointing);
    commitAntennaPointing(pointingHistory, budgetResult?.targetPointing);
  }

  links.push(
    createLink(
      kind,
      source,
      target,
      slice,
      config,
      interPlaneDirection,
      state,
      sourceAntenna?.antenna_id,
      targetAntenna?.antenna_id,
    ),
  );
  usedEndpoints.add(key);
  degreeByNode.set(source.id, sourceDegree + 1);
  degreeByNode.set(target.id, targetDegree + 1);
  return true;
}

function linkStatusRank(status: LinkStatus) {
  if (status === "up") return 0;
  if (status === "warning") return 1;
  return 2;
}

function addNearestInterPlaneLinks(
  links: SatelliteLink[],
  usedEndpoints: Set<string>,
  degreeByNode: Map<string, number>,
  sourcePlaneNodes: SatelliteNode[],
  targetPlaneNodes: SatelliteNode[],
  slice: number,
  config: WalkerNetworkConfig,
  interPlaneDirection: InterPlaneDirection,
  pointingHistory?: AntennaPointingHistory,
) {
  const sourceUsedInPair = new Set<string>();
  const targetUsedInPair = new Set<string>();
  const slotCount = config.constellation.satellitesPerPlane;
  const candidates = sourcePlaneNodes.flatMap((source) =>
    targetPlaneNodes.map((target) => {
      const { sourceRole, targetRole } = islRolesForLink(
        source,
        target,
        "inter-plane",
        config.constellation.satellitesPerPlane,
      );
      const budgetResult = islLinkBudget(source, target, sourceRole, targetRole, config, pointingHistory);
      const state = linkState(
        "inter-plane",
        source,
        target,
        slice,
        config,
        maxIslAntennaRangeKm(source, target, sourceRole, targetRole),
        budgetResult?.budget,
      );
      const rawSlotDelta = Math.abs(source.slot - target.slot);
      const slotDelta = Math.min(rawSlotDelta, slotCount - rawSlotDelta);
      return {
        source,
        target,
        state,
        slotDelta,
      };
    }),
  );

  candidates.sort((a, b) => {
    const statusOrder = linkStatusRank(a.state.status) - linkStatusRank(b.state.status);
    if (statusOrder !== 0) return statusOrder;
    const distanceOrder = a.state.distanceKm - b.state.distanceKm;
    if (distanceOrder !== 0) return distanceOrder;
    return a.slotDelta - b.slotDelta;
  });

  for (const candidate of candidates) {
    if (sourceUsedInPair.has(candidate.source.id) || targetUsedInPair.has(candidate.target.id)) {
      continue;
    }

    const added = addLinkWithDegreeLimit(
      links,
      usedEndpoints,
      degreeByNode,
      "inter-plane",
      candidate.source,
      candidate.target,
      slice,
      config,
      interPlaneDirection,
      candidate.state,
      pointingHistory,
    );
    if (!added) continue;

    sourceUsedInPair.add(candidate.source.id);
    targetUsedInPair.add(candidate.target.id);
    if (sourceUsedInPair.size >= sourcePlaneNodes.length || targetUsedInPair.size >= targetPlaneNodes.length) {
      break;
    }
  }
}

function createLinks(
  nodes: SatelliteNode[],
  slice: number,
  config: WalkerNetworkConfig,
  pointingHistory?: AntennaPointingHistory,
): SatelliteLink[] {
  const byKey = new Map(nodes.map((node) => [`${node.plane}:${node.slot}`, node]));
  const links: SatelliteLink[] = [];
  const usedEndpoints = new Set<string>();
  const degreeByNode = new Map(nodes.map((node) => [node.id, 0]));
  const { planes, satellitesPerPlane, walkerType } = config.constellation;

  for (let plane = 0; plane < planes; plane += 1) {
    const planeNodes = Array.from({ length: satellitesPerPlane }, (_, slot) => byKey.get(`${plane}:${slot}`)!)
      .filter(Boolean)
      .sort((a, b) => orbitalPlanePhaseDeg(a) - orbitalPlanePhaseDeg(b) || a.slot - b.slot);
    if (planeNodes.length < 2) continue;
    for (let index = 0; index < planeNodes.length; index += 1) {
      const source = planeNodes[index];
      const nextInPlane = planeNodes[(index + 1) % planeNodes.length];
      addLinkWithDegreeLimit(
        links,
        usedEndpoints,
        degreeByNode,
        "intra-plane",
        source,
        nextInPlane,
        slice,
        config,
        "none",
        undefined,
        pointingHistory,
      );
    }
  }

  const interPlanePairs = walkerType === "delta" ? planes : planes - 1;
  for (let plane = 0; plane < interPlanePairs; plane += 1) {
    const nextPlane = (plane + 1) % planes;
    if (walkerType === "star" && nextPlane === 0) continue;

    const sourcePlaneNodes = Array.from({ length: satellitesPerPlane }, (_, slot) => byKey.get(`${plane}:${slot}`)!);
    const targetPlaneNodes = Array.from({ length: satellitesPerPlane }, (_, slot) => byKey.get(`${nextPlane}:${slot}`)!);
    addNearestInterPlaneLinks(
      links,
      usedEndpoints,
      degreeByNode,
      sourcePlaneNodes,
      targetPlaneNodes,
      slice,
      config,
      "right",
      pointingHistory,
    );
  }

  return links;
}

type ActiveLinkGeometry = {
  link: SatelliteLink;
  source: SatelliteNode;
  target: SatelliteNode;
  sourceAntenna: NonNullable<ReturnType<typeof antennaById>>;
  targetAntenna: NonNullable<ReturnType<typeof antennaById>>;
};

function applyIslInterference(links: SatelliteLink[], nodes: SatelliteNode[], config: WalkerNetworkConfig) {
  const model = config.interferenceModel.isl;
  if (!model.enabled) return;

  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const activeLinks: ActiveLinkGeometry[] = links.flatMap((link) => {
    if (!link.state.isActive || !link.state.linkBudget) return [];
    const source = nodeById.get(link.source);
    const target = nodeById.get(link.target);
    if (!source || !target) return [];
    const sourceAntenna = antennaById(source, link.sourceAntennaId);
    const targetAntenna = antennaById(target, link.targetAntennaId);
    if (!sourceAntenna || !targetAntenna) return [];
    return [{ link, source, target, sourceAntenna, targetAntenna }];
  });

  activeLinks.forEach((victim) => {
    let interferenceMw = 0;
    let interferenceCount = 0;
    let coChannelCount = 0;
    let adjacentChannelCount = 0;
    let filteredChannelCount = 0;
    let strongestInterferenceDbm = Number.NEGATIVE_INFINITY;
    let dominantInterfererId: string | undefined;
    let dominantInterfererChannelDelta: number | undefined;
    const desiredIncomingDirection = subtractVector(victim.source.timeState.eci, victim.target.timeState.eci);

    activeLinks.forEach((interferer) => {
      if (interferer.link.id === victim.link.id) return;
      const channelState = channelIsolationState(
        victim.link.state.linkBudget!.channel_id,
        interferer.link.state.linkBudget!.channel_id,
        model,
      );
      if (channelState.filtered) {
        filteredChannelCount += 1;
        return;
      }

      const isolationDb = channelState.isolationDb + model.polarizationIsolationDb;
      let interferenceDbm: number;

      if (interferer.source.id === victim.target.id) {
        interferenceDbm =
          wattsToDbm(interferer.sourceAntenna.max_tx_power_w) -
          model.selfInterferenceIsolationDb -
          isolationDb;
      } else {
        if (!lineOfSight(interferer.source, victim.target, config)) return;

        const interfererToVictimDistanceKm = distanceKm(interferer.source.timeState.eci, victim.target.timeState.eci);
        const interfererBoresight = subtractVector(interferer.target.timeState.eci, interferer.source.timeState.eci);
        const interfererToVictimDirection = subtractVector(victim.target.timeState.eci, interferer.source.timeState.eci);
        const victimIncomingDirection = subtractVector(interferer.source.timeState.eci, victim.target.timeState.eci);
        const txGainTowardVictim = directionalGainDbi(
          interferer.sourceAntenna,
          interfererBoresight,
          interfererToVictimDirection,
          config,
        );
        const rxGainTowardInterferer = directionalGainDbi(
          victim.targetAntenna,
          desiredIncomingDirection,
          victimIncomingDirection,
          config,
        );
        const freeSpaceLossDb = freeSpacePathLossDb(interfererToVictimDistanceKm, config.linkBudget.isl.frequencyGhz);
        interferenceDbm =
          wattsToDbm(interferer.sourceAntenna.max_tx_power_w) +
          txGainTowardVictim +
          rxGainTowardInterferer -
          totalIslLossDb(freeSpaceLossDb, config) -
          isolationDb;
      }

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
        dominantInterfererId = interferer.link.id;
        dominantInterfererChannelDelta = channelState.channelDelta;
      }
    });

    const updatedBudget = applyInterferenceToLinkBudget(
      victim.link.state.linkBudget!,
      interferenceMw,
      interferenceCount,
      dominantInterfererId,
      config.linkBudget.isl,
      config.adaptiveCoding.isl,
      {
        coChannelCount,
        adjacentChannelCount,
        filteredChannelCount,
        dominantInterfererChannelDelta,
      },
    );
    victim.link.state.linkBudget = updatedBudget;
    victim.link.state.bandwidthMbps = Math.max(1, round(updatedBudget.capacity_mbps, 0));

    const physicalStatus = budgetStatus(updatedBudget, config.linkBudget.isl);
    if (physicalStatus === "down") {
      victim.link.state.status = "down";
      victim.link.state.isActive = false;
      victim.link.state.restrictionReason = budgetRestrictionReason(updatedBudget, config);
    } else if (physicalStatus === "warning" && victim.link.state.status === "up") {
      victim.link.state.status = "warning";
    }
  });
}

function applyControlledLinkOutages(
  links: SatelliteLink[],
  slice: number,
  schedule: SimulationInput["controlledLinkOutageSchedule"],
) {
  if (!schedule) return;
  const forcedDown = new Set(schedule.forced_down_link_ids_by_slice[String(slice)] ?? []);
  if (forcedDown.size === 0) return;
  links.forEach((link) => {
    if (!forcedDown.has(link.id)) return;
    link.state.status = "down";
    link.state.isActive = false;
    link.state.restrictionReason = schedule.reason;
    link.state.bandwidthMbps = 0;
    link.state.utilizationPercent = 0;
    link.state.demandTrafficMbps = 0;
    link.state.carriedTrafficMbps = 0;
    link.state.queuedTrafficMb = 0;
    link.state.droppedTrafficMb = 0;
    link.state.congestionPercent = 0;
    if (link.state.linkBudget) {
      link.state.linkBudget.capacity_mbps = 0;
      link.state.linkBudget.effective_capacity_mbps = 0;
      link.state.linkBudget.availability_factor = 0;
    }
  });
}

type ShortestPathResult = Pick<RoutedTaskPath, "path" | "linkIds" | "hopCount" | "distanceKm" | "latencyMs">;

function nodeCanRouteTraffic(node: SatelliteNode | undefined) {
  return Boolean(node) && (node!.operationMode !== "operational" || node!.resources.can_accept_tasks);
}

function routingNodeUnavailableReason(node: SatelliteNode | undefined) {
  if (!node) return "任务端点不存在于当前星座中";
  if (!nodeCanRouteTraffic(node)) return "节点处于节能或不可接收任务状态，不能参与业务路由";
  return "";
}

function routingLinkCost(
  link: SatelliteLink,
  plannedDemandMbps: number,
  taskTrafficMbps: number,
  algorithm: WalkerNetworkConfig["routing"]["algorithm"],
  config: WalkerNetworkConfig,
) {
  const baseLatencyMs = Math.max(link.state.latencyMs, 0.1);
  if (algorithm === "shortest-path") return baseLatencyMs;

  const capacityMbps = Math.max(link.state.bandwidthMbps, link.state.linkBudget?.effective_capacity_mbps ?? 1, 1);
  const projectedDemandMbps = Math.max(plannedDemandMbps, 0) + Math.max(taskTrafficMbps, 0);
  const projectedUtilization = projectedDemandMbps / capacityMbps;
  const utilizationPenaltyMs = Math.max(0, projectedUtilization - 0.65) * baseLatencyMs * 6;
  const excessMbps = Math.max(projectedDemandMbps - capacityMbps, 0);
  const excessMb = (excessMbps * config.time.stepMinutes * 60) / 8;
  const queuePenaltyMs = Math.min(
    config.trafficModel.maxRouteQueueDelayMs,
    capacityMbps > 0 ? (excessMb * 8 * 1000) / capacityMbps : config.trafficModel.maxRouteQueueDelayMs,
  );
  return baseLatencyMs + utilizationPenaltyMs + queuePenaltyMs;
}

type RouteQueueEntry = {
  node: string;
  distance: number;
};

function pushRouteQueue(heap: RouteQueueEntry[], entry: RouteQueueEntry) {
  heap.push(entry);
  let index = heap.length - 1;
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (heap[parent].distance <= entry.distance) break;
    heap[index] = heap[parent];
    index = parent;
  }
  heap[index] = entry;
}

function popRouteQueue(heap: RouteQueueEntry[]) {
  if (heap.length === 0) return undefined;
  const first = heap[0];
  const last = heap.pop()!;
  if (heap.length > 0) {
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      if (left >= heap.length) break;
      const child = right < heap.length && heap[right].distance < heap[left].distance ? right : left;
      if (heap[child].distance >= last.distance) break;
      heap[index] = heap[child];
      index = child;
    }
    heap[index] = last;
  }
  return first;
}

function shortestPathRoute(
  sourceId: string,
  targetId: string,
  nodes: SatelliteNode[],
  links: SatelliteLink[],
  algorithm: WalkerNetworkConfig["routing"]["algorithm"],
  config: WalkerNetworkConfig,
  plannedDemandByLink: Map<string, number>,
  taskTrafficMbps: number,
): ShortestPathResult | null {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const sourceNode = nodesById.get(sourceId);
  const targetNode = nodesById.get(targetId);
  if (!nodeCanRouteTraffic(sourceNode) || !nodeCanRouteTraffic(targetNode)) return null;
  if (sourceId === targetId) {
    return { path: [sourceId], linkIds: [], hopCount: 0, distanceKm: 0, latencyMs: 0 };
  }

  const graph = new Map<string, Array<{ next: string; link: SatelliteLink; cost: number }>>();
  nodes.forEach((node) => graph.set(node.id, []));
  links.filter((link) => link.state.isActive).forEach((link) => {
    if (!nodeCanRouteTraffic(nodesById.get(link.source)) || !nodeCanRouteTraffic(nodesById.get(link.target))) {
      return;
    }
    const cost = routingLinkCost(link, plannedDemandByLink.get(link.id) ?? 0, taskTrafficMbps, algorithm, config);
    graph.get(link.source)?.push({ next: link.target, link, cost });
    graph.get(link.target)?.push({ next: link.source, link, cost });
  });

  const distances = new Map<string, number>();
  const previous = new Map<string, { node: string; link: SatelliteLink }>();
  const visited = new Set<string>();
  nodes.forEach((node) => distances.set(node.id, Number.POSITIVE_INFINITY));
  distances.set(sourceId, 0);
  const queue: RouteQueueEntry[] = [];
  pushRouteQueue(queue, { node: sourceId, distance: 0 });

  while (queue.length > 0) {
    const currentEntry = popRouteQueue(queue);
    if (!currentEntry) break;
    const current = currentEntry.node;
    const currentDistance = currentEntry.distance;
    if (visited.has(current)) continue;
    if (currentDistance > (distances.get(current) ?? Number.POSITIVE_INFINITY)) continue;
    if (current === targetId) break;
    visited.add(current);

    graph.get(current)?.forEach(({ next, link, cost }) => {
      if (visited.has(next)) return;
      const candidateDistance = currentDistance + cost;
      const knownDistance = distances.get(next) ?? Number.POSITIVE_INFINITY;
      if (candidateDistance < knownDistance) {
        distances.set(next, candidateDistance);
        previous.set(next, { node: current!, link });
        pushRouteQueue(queue, { node: next, distance: candidateDistance });
      }
    });
  }

  if (!previous.has(targetId)) return null;

  const path = [targetId];
  const linkIds: string[] = [];
  let distanceKmTotal = 0;
  let latencyMsTotal = 0;
  let cursor = targetId;
  while (cursor !== sourceId) {
    const step = previous.get(cursor);
    if (!step) return null;
    path.unshift(step.node);
    linkIds.unshift(step.link.id);
    distanceKmTotal += step.link.state.distanceKm;
    latencyMsTotal += step.link.state.latencyMs;
    cursor = step.node;
  }

  return {
    path,
    linkIds,
    hopCount: Math.max(0, path.length - 1),
    distanceKm: round(distanceKmTotal, 1),
    latencyMs: round(latencyMsTotal, 1),
  };
}

function taskRouteEndpoints(task: SimulationInput["tasks"][number]) {
  if (task.source && task.target) {
    return { source: task.source, target: task.target };
  }
  return { source: undefined, target: undefined };
}

const taskPriority = (task: SimulationInput["tasks"][number]) => Math.max(0, Math.round(task.priority ?? 0));

function emptyRouteLatencyFields(config: WalkerNetworkConfig) {
  return {
    queueDelayMs: 0,
    queueBacklogDelayMs: 0,
    latencyCapped: false,
    timeoutMs: config.trafficModel.taskTimeoutMs,
  };
}

function createRoutes(
  slice: number,
  input: SimulationInput,
  nodes: SatelliteNode[],
  links: SatelliteLink[],
  config: WalkerNetworkConfig,
): RoutedTaskPath[] {
  const algorithm = input.routingAlgorithm ?? config.routing.algorithm;
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const plannedDemandByLink = new Map<string, number>();
  return input.tasks
    .filter((task) => taskIsActiveInSlice(task, slice))
    .sort((a, b) => taskPriority(b) - taskPriority(a) || a.task_id.localeCompare(b.task_id))
    .map((task) => {
    const { source, target } = taskRouteEndpoints(task);
    const trafficMbps = task.traffic_mbps ?? 0;
    const priority = taskPriority(task);
    const taskType = task.task_type;
    const latencyFields = emptyRouteLatencyFields(config);
    if (!source || !target) {
      return {
        task_id: task.task_id,
        source,
        target,
        algorithm,
        status: "not-requested",
        path: [],
        linkIds: [],
        hopCount: 0,
        distanceKm: 0,
        latencyMs: 0,
        ...latencyFields,
        trafficMbps,
        taskType,
        priority,
        carriedTrafficMbps: 0,
        queuedTrafficMb: 0,
        droppedTrafficMb: 0,
        taskTelemetryGeneratedMb: 0,
        reason: "任务未提供 source 和 target，当前只做节点资源投放",
      };
    }

    const sourceUnavailableReason = routingNodeUnavailableReason(nodesById.get(source));
    const targetUnavailableReason = routingNodeUnavailableReason(nodesById.get(target));
    if (sourceUnavailableReason || targetUnavailableReason) {
      return {
        task_id: task.task_id,
        source,
        target,
        algorithm,
        status: "unroutable",
        path: [],
        linkIds: [],
        hopCount: 0,
        distanceKm: 0,
        latencyMs: 0,
        ...latencyFields,
        trafficMbps,
        taskType,
        priority,
        carriedTrafficMbps: 0,
        queuedTrafficMb: 0,
        droppedTrafficMb: 0,
        taskTelemetryGeneratedMb: 0,
        reason: sourceUnavailableReason || targetUnavailableReason,
      };
    }

    if (source === target) {
      return {
        task_id: task.task_id,
        source,
        target,
        algorithm,
        status: "local",
        path: [source],
        linkIds: [],
        hopCount: 0,
        distanceKm: 0,
        latencyMs: 0,
        ...latencyFields,
        trafficMbps,
        taskType,
        priority,
        carriedTrafficMbps: trafficMbps,
        queuedTrafficMb: 0,
        droppedTrafficMb: 0,
        taskTelemetryGeneratedMb: 0,
      };
    }

    const result = shortestPathRoute(source, target, nodes, links, algorithm, config, plannedDemandByLink, trafficMbps);
    if (!result) {
      return {
        task_id: task.task_id,
        source,
        target,
        algorithm,
        status: "unroutable",
        path: [],
        linkIds: [],
        hopCount: 0,
        distanceKm: 0,
        latencyMs: 0,
        ...latencyFields,
        trafficMbps,
        taskType,
        priority,
        carriedTrafficMbps: 0,
        queuedTrafficMb: 0,
        droppedTrafficMb: 0,
        taskTelemetryGeneratedMb: 0,
        reason: "当前时间片拓扑中不存在可用路径",
      };
    }

    result.linkIds.forEach((linkId) => {
      plannedDemandByLink.set(linkId, (plannedDemandByLink.get(linkId) ?? 0) + trafficMbps);
    });

    return {
      task_id: task.task_id,
      source,
      target,
      algorithm,
      status: "routed",
      path: result.path,
      linkIds: result.linkIds,
      hopCount: result.hopCount,
      distanceKm: result.distanceKm,
      latencyMs: result.latencyMs,
      ...latencyFields,
      trafficMbps,
      taskType,
      priority,
      carriedTrafficMbps: trafficMbps,
      queuedTrafficMb: 0,
      droppedTrafficMb: 0,
      taskTelemetryGeneratedMb: 0,
    };
  });
}

type NodeNetworkEffect = {
  ingressTrafficMbps: number;
  egressTrafficMbps: number;
  transitTrafficMbps: number;
  queuedTrafficMb: number;
  droppedTrafficMb: number;
  taskTelemetryGeneratedMb: number;
};

const emptyNodeNetworkEffect = (): NodeNetworkEffect => ({
  ingressTrafficMbps: 0,
  egressTrafficMbps: 0,
  transitTrafficMbps: 0,
  queuedTrafficMb: 0,
  droppedTrafficMb: 0,
  taskTelemetryGeneratedMb: 0,
});

type NodeLinkOccupancy = {
  activeIslLinks: number;
  activeSglLinks: number;
  carriedIslTrafficMbps: number;
  maxLinkUtilizationPercent: number;
  maxLinkCongestionPercent: number;
  totalUtilizationPercent: number;
  incidentLinkCount: number;
};

const emptyNodeLinkOccupancy = (): NodeLinkOccupancy => ({
  activeIslLinks: 0,
  activeSglLinks: 0,
  carriedIslTrafficMbps: 0,
  maxLinkUtilizationPercent: 0,
  maxLinkCongestionPercent: 0,
  totalUtilizationPercent: 0,
  incidentLinkCount: 0,
});

type RouteLinkAllocation = {
  carriedMbps: number;
  queuedMb: number;
  droppedMb: number;
};

const routeLinkAllocationKey = (taskId: string, linkId: string) => `${taskId}::${linkId}`;

function nodeLinkOccupancy(
  links: SatelliteLink[],
  groundLinks: NetworkSlice["groundLinks"],
  nodes: SatelliteNode[],
) {
  const occupancyByNode = new Map(nodes.map((node) => [node.id, emptyNodeLinkOccupancy()]));
  const occupancyForNode = (nodeId: string) => {
    const occupancy = occupancyByNode.get(nodeId) ?? emptyNodeLinkOccupancy();
    occupancyByNode.set(nodeId, occupancy);
    return occupancy;
  };

  links.forEach((link) => {
    if (!link.state.isActive) return;
    [link.source, link.target].forEach((nodeId) => {
      const occupancy = occupancyForNode(nodeId);
      occupancy.activeIslLinks += 1;
      occupancy.carriedIslTrafficMbps += link.state.carriedTrafficMbps;
      occupancy.maxLinkUtilizationPercent = Math.max(
        occupancy.maxLinkUtilizationPercent,
        link.state.utilizationPercent,
      );
      occupancy.maxLinkCongestionPercent = Math.max(
        occupancy.maxLinkCongestionPercent,
        link.state.congestionPercent,
      );
      occupancy.totalUtilizationPercent += link.state.utilizationPercent;
      occupancy.incidentLinkCount += 1;
    });
  });

  groundLinks.filter((window) => window.status === "available").forEach((window) => {
    occupancyForNode(window.satellite_id).activeSglLinks += 1;
  });

  return occupancyByNode;
}

function applyRouteTrafficToLinks(
  links: SatelliteLink[],
  routes: RoutedTaskPath[],
  linkQueueMbById: Map<string, number>,
  config: WalkerNetworkConfig,
) {
  const trafficByLink = new Map<string, number>();
  const routesByLink = new Map<string, RoutedTaskPath[]>();
  routes.filter((route) => route.status === "routed").forEach((route) => {
    route.carriedTrafficMbps = route.trafficMbps;
    route.queuedTrafficMb = 0;
    route.droppedTrafficMb = 0;
    route.linkIds.forEach((linkId) => {
      trafficByLink.set(linkId, (trafficByLink.get(linkId) ?? 0) + route.trafficMbps);
      const linkRoutes = routesByLink.get(linkId) ?? [];
      linkRoutes.push(route);
      routesByLink.set(linkId, linkRoutes);
    });
  });

  const dtSeconds = config.time.stepMinutes * 60;
  const routeLinkAllocations = new Map<string, RouteLinkAllocation>();
  const routeDeliveredMbpsByTask = new Map<string, number>();
  const routeQueuedMbByTask = new Map<string, number>();
  const routeDroppedMbByTask = new Map<string, number>();
  const routeBacklogDelayMsByTask = new Map<string, number>();

  links.forEach((link) => {
    const newDemandMbps = trafficByLink.get(link.id) ?? 0;
    const linkRoutes = routesByLink.get(link.id) ?? [];
    const previousQueueMb = linkQueueMbById.get(link.id) ?? 0;
    const previousQueueMbps = (previousQueueMb * 8) / Math.max(dtSeconds, 1);
    const totalDemandMbps = link.state.isActive ? newDemandMbps + previousQueueMbps : 0;
    const capacityMbps = link.state.isActive ? Math.max(link.state.bandwidthMbps, 1) : 0;
    const carriedMbps = Math.min(totalDemandMbps, capacityMbps);
    const excessMb = Math.max(totalDemandMbps - carriedMbps, 0) * dtSeconds / 8;
    const queuedMb = Math.min(excessMb, config.trafficModel.linkQueueCapacityMb);
    const droppedMb = Math.max(excessMb - queuedMb, 0);
    const carriedPreviousQueueMbps = Math.min(previousQueueMbps, carriedMbps);
    let remainingNewCapacityMbps = Math.max(carriedMbps - carriedPreviousQueueMbps, 0);
    const unsentByTask = new Map<string, number>();
    let totalNewUnsentMb = 0;

    [...linkRoutes]
      .sort((a, b) => b.priority - a.priority || a.task_id.localeCompare(b.task_id))
      .forEach((route) => {
        const carriedNewMbps = Math.min(route.trafficMbps, remainingNewCapacityMbps);
        remainingNewCapacityMbps = Math.max(remainingNewCapacityMbps - carriedNewMbps, 0);
        const unsentMb = Math.max(route.trafficMbps - carriedNewMbps, 0) * dtSeconds / 8;
        unsentByTask.set(route.task_id, unsentMb);
        totalNewUnsentMb += unsentMb;
        routeLinkAllocations.set(routeLinkAllocationKey(route.task_id, link.id), {
          carriedMbps: carriedNewMbps,
          queuedMb: unsentMb,
          droppedMb: 0,
        });
        const previousRouteDelivered = routeDeliveredMbpsByTask.get(route.task_id);
        routeDeliveredMbpsByTask.set(
          route.task_id,
          previousRouteDelivered === undefined ? carriedNewMbps : Math.min(previousRouteDelivered, carriedNewMbps),
        );
      });

    const dropFraction = totalNewUnsentMb > 0 ? clamp(droppedMb / totalNewUnsentMb, 0, 1) : 0;
    linkRoutes.forEach((route) => {
      const key = routeLinkAllocationKey(route.task_id, link.id);
      const allocation = routeLinkAllocations.get(key) ?? { carriedMbps: route.trafficMbps, queuedMb: 0, droppedMb: 0 };
      const unsentMb = unsentByTask.get(route.task_id) ?? 0;
      const routeDroppedMb = unsentMb * dropFraction;
      allocation.queuedMb = Math.max(unsentMb - routeDroppedMb, 0);
      allocation.droppedMb = routeDroppedMb;
      routeLinkAllocations.set(key, allocation);
      routeQueuedMbByTask.set(route.task_id, (routeQueuedMbByTask.get(route.task_id) ?? 0) + allocation.queuedMb);
      routeDroppedMbByTask.set(route.task_id, (routeDroppedMbByTask.get(route.task_id) ?? 0) + allocation.droppedMb);
      if (allocation.queuedMb > 0 && capacityMbps > 0) {
        const allocationBacklogDelayMs = (allocation.queuedMb * 8 * 1000) / capacityMbps;
        routeBacklogDelayMsByTask.set(
          route.task_id,
          Math.max(routeBacklogDelayMsByTask.get(route.task_id) ?? 0, allocationBacklogDelayMs),
        );
      }
    });

    linkQueueMbById.set(link.id, queuedMb);

    link.state.demandTrafficMbps = round(totalDemandMbps, 2);
    link.state.carriedTrafficMbps = round(carriedMbps, 2);
    link.state.queuedTrafficMb = round(queuedMb, 2);
    link.state.droppedTrafficMb = round(droppedMb, 2);
    link.state.congestionPercent = round(
      capacityMbps > 0 ? Math.max(0, (totalDemandMbps / capacityMbps - 1) * 100) : 0,
      1,
    );

    if (totalDemandMbps <= 0 || !link.state.isActive) return;
    const routedUtilization = (carriedMbps / Math.max(link.state.bandwidthMbps, 1)) * 100;
    link.state.utilizationPercent = round(clamp(routedUtilization, 0, 100), 0);
    if (link.state.status === "up" && link.state.utilizationPercent > 88) {
      link.state.status = "warning";
    }
  });

  routes.filter((route) => route.status === "routed").forEach((route) => {
    route.carriedTrafficMbps = round(routeDeliveredMbpsByTask.get(route.task_id) ?? route.trafficMbps, 2);
    route.queuedTrafficMb = round(routeQueuedMbByTask.get(route.task_id) ?? 0, 2);
    route.droppedTrafficMb = round(routeDroppedMbByTask.get(route.task_id) ?? 0, 2);
    route.queueBacklogDelayMs = round(routeBacklogDelayMsByTask.get(route.task_id) ?? 0, 4);
    route.queueDelayMs = round(Math.min(route.queueBacklogDelayMs, config.trafficModel.maxRouteQueueDelayMs), 4);
    route.timeoutMs = config.trafficModel.taskTimeoutMs;
    route.latencyCapped = route.queueBacklogDelayMs > route.queueDelayMs || route.droppedTrafficMb > 0;
  });

  const nodeEffects = new Map<string, NodeNetworkEffect>();
  const effectForNode = (nodeId: string) => {
    const effect = nodeEffects.get(nodeId) ?? emptyNodeNetworkEffect();
    nodeEffects.set(nodeId, effect);
    return effect;
  };

  routes.filter((route) => route.status === "routed").forEach((route) => {
    if (route.path.length === 0) return;
    const source = route.path[0];
    const target = route.path[route.path.length - 1];
    const firstHopAllocation = route.linkIds[0]
      ? routeLinkAllocations.get(routeLinkAllocationKey(route.task_id, route.linkIds[0]))
      : undefined;
    effectForNode(source).egressTrafficMbps += firstHopAllocation?.carriedMbps ?? route.carriedTrafficMbps;
    effectForNode(target).ingressTrafficMbps += route.carriedTrafficMbps;
    const taskType = String(route.taskType ?? "").toLowerCase();
    const deliveredMb = (route.carriedTrafficMbps * dtSeconds) / 8;
    route.taskTelemetryGeneratedMb = 0;
    route.taskTelemetryNodeId = undefined;
    if (taskType === "telemetry") {
      const telemetryMb = round(deliveredMb * config.trafficModel.telemetryTaskSamplingRatio, 2);
      route.taskTelemetryGeneratedMb = telemetryMb;
      route.taskTelemetryNodeId = source;
      effectForNode(source).taskTelemetryGeneratedMb += telemetryMb;
    } else if (taskType === "downlink") {
      const telemetryMb = round(deliveredMb * config.trafficModel.downlinkTaskSamplingRatio, 2);
      route.taskTelemetryGeneratedMb = telemetryMb;
      route.taskTelemetryNodeId = target;
      effectForNode(target).taskTelemetryGeneratedMb += telemetryMb;
    }

    route.path.slice(1, -1).forEach((nodeId, offset) => {
      const outgoingLinkId = route.linkIds[offset + 1];
      const allocation = outgoingLinkId
        ? routeLinkAllocations.get(routeLinkAllocationKey(route.task_id, outgoingLinkId))
        : undefined;
      effectForNode(nodeId).transitTrafficMbps += allocation?.carriedMbps ?? route.carriedTrafficMbps;
    });

    route.linkIds.forEach((linkId, index) => {
      const upstreamNodeId = route.path[index] ?? source;
      const allocation = routeLinkAllocations.get(routeLinkAllocationKey(route.task_id, linkId)) ?? {
        carriedMbps: route.trafficMbps,
        queuedMb: 0,
        droppedMb: 0,
      };
      const effect = effectForNode(upstreamNodeId);
      effect.queuedTrafficMb += allocation.queuedMb;
      effect.droppedTrafficMb += allocation.droppedMb;
    });
  });

  return nodeEffects;
}

function recomputeOperationalEnergy(
  node: SatelliteNode,
  previousEnergyWhInput: number,
  additionalLoadPowerW: number,
  config: WalkerNetworkConfig,
) {
  const model = config.operationalModel;
  const batteryCapacityWh = model.batteryCapacityWh;
  const minEnergyWh = model.minStateOfCharge * batteryCapacityWh;
  const previousEnergyWh = clamp(previousEnergyWhInput, minEnergyWh, batteryCapacityWh);
  const loadPowerW = round(node.resources.load_power_w + additionalLoadPowerW, 2);
  const chargePowerW = Math.max(node.resources.solar_power_w - loadPowerW, 0);
  const dischargePowerW = Math.max(loadPowerW - node.resources.solar_power_w, 0);
  const netPowerW = round(
    model.chargeEfficiency * chargePowerW - dischargePowerW / model.dischargeEfficiency,
    2,
  );
  const energyWh = round(
    clamp(previousEnergyWh + netPowerW * (config.time.stepMinutes / 60), minEnergyWh, batteryCapacityWh),
    2,
  );

  node.resources.load_power_w = loadPowerW;
  node.resources.net_power_w = netPowerW;
  node.resources.energy_wh = energyWh;
  node.resources.energy = round((energyWh / batteryCapacityWh) * 100, 0);
  node.resources.state_of_charge = round(energyWh / batteryCapacityWh, 4);
  node.resources.power_saving_mode = node.resources.state_of_charge <= model.minStateOfCharge;
  node.resources.can_accept_tasks = !node.resources.power_saving_mode;
}

function applyNetworkEffectsToNodes(
  nodes: SatelliteNode[],
  links: SatelliteLink[],
  nodeEffects: Map<string, NodeNetworkEffect>,
  groundLinks: NetworkSlice["groundLinks"],
  nodeQueueMbByNode: Map<string, number>,
  telemetryBufferMbByNode: Map<string, number>,
  previousEnergyWhByNode: Map<string, number>,
  config: WalkerNetworkConfig,
  mode: SimulationInput["mode"],
) {
  const groundCapacityByNode = new Map<string, number>();
  const dtSeconds = config.time.stepMinutes * 60;
  const occupancyByNode = nodeLinkOccupancy(links, groundLinks, nodes);

  groundLinks.filter((window) => window.status === "available").forEach((window) => {
    const capacityMb = (window.reportCapacityMbps * dtSeconds) / 8;
    groundCapacityByNode.set(window.satellite_id, (groundCapacityByNode.get(window.satellite_id) ?? 0) + capacityMb);
  });

  nodes.forEach((node) => {
    const effect = nodeEffects.get(node.id) ?? emptyNodeNetworkEffect();
    const occupancy = occupancyByNode.get(node.id) ?? emptyNodeLinkOccupancy();

    const previousNodeQueueMb = nodeQueueMbByNode.get(node.id) ?? 0;
    const queueAfterDrainMb = previousNodeQueueMb * config.trafficModel.queueCarryoverRatio + effect.queuedTrafficMb;
    const cacheCapacityMb = config.trafficModel.cacheCapacityMb;
    const queueDroppedMb = Math.max(queueAfterDrainMb - cacheCapacityMb, 0);
    const nodeQueueMb = clamp(queueAfterDrainMb, 0, cacheCapacityMb);
    nodeQueueMbByNode.set(node.id, nodeQueueMb);

    const queueGb = nodeQueueMb / 1024;
    const forwardingCpuPercentRaw =
      (occupancy.carriedIslTrafficMbps / 1000) * config.trafficModel.forwardingCpuPercentPerGbps;
    const endpointTrafficCpuPercentRaw =
      ((effect.ingressTrafficMbps + effect.egressTrafficMbps) / 1000) *
      config.trafficModel.endpointCpuPercentPerGbps;
    const queueCpuPercentRaw = queueGb * config.trafficModel.queueCpuPercentPerGb;
    const forwardingCpuPercent = round(forwardingCpuPercentRaw, 1);
    const endpointTrafficCpuPercent = round(endpointTrafficCpuPercentRaw, 1);
    const queueCpuPercent = round(queueCpuPercentRaw, 1);
    const updatedCpuUtilization = round(
      clamp(
        node.resources.compute_cpu_percent + endpointTrafficCpuPercent + forwardingCpuPercent + queueCpuPercent,
        0,
        100,
      ),
      0,
    );
    const averageLinkUtilizationPercent =
      occupancy.incidentLinkCount > 0 ? occupancy.totalUtilizationPercent / occupancy.incidentLinkCount : 0;
    const linkOccupancyPercent = round(
      Math.max(averageLinkUtilizationPercent, occupancy.maxLinkUtilizationPercent),
      1,
    );

    const telemetryGeneratedMb = round(
      config.trafficModel.telemetryGenerationMbPerSlice +
        updatedCpuUtilization * config.trafficModel.telemetryCpuMbPerPercent +
        (occupancy.carriedIslTrafficMbps / 1000) * config.trafficModel.telemetryTrafficMbPerGbps +
        occupancy.maxLinkCongestionPercent * config.trafficModel.telemetryCongestionMbPerPercent +
        effect.taskTelemetryGeneratedMb,
      2,
    );
    const previousTelemetryBufferMb = telemetryBufferMbByNode.get(node.id) ?? 0;
    const downlinkCapacityMb = groundCapacityByNode.get(node.id) ?? 0;
    const telemetryAvailableMb = previousTelemetryBufferMb + telemetryGeneratedMb;
    const telemetryDownlinkedMb = Math.min(telemetryAvailableMb, downlinkCapacityMb);
    const telemetryBufferBeforeDropMb = telemetryAvailableMb - telemetryDownlinkedMb;
    const telemetryDroppedMb = Math.max(
      telemetryBufferBeforeDropMb - config.trafficModel.telemetryBufferCapacityMb,
      0,
    );
    const telemetryBufferMb = clamp(
      telemetryBufferBeforeDropMb,
      0,
      config.trafficModel.telemetryBufferCapacityMb,
    );
    telemetryBufferMbByNode.set(node.id, telemetryBufferMb);
    const downlinkTrafficMbps = (telemetryDownlinkedMb * 8) / Math.max(dtSeconds, 1);
    const communicationPowerW = round(
      occupancy.activeIslLinks * config.trafficModel.activeIslLinkPowerW +
        occupancy.activeSglLinks * config.trafficModel.activeSglLinkPowerW +
        ((occupancy.carriedIslTrafficMbps + downlinkTrafficMbps) / 1000) *
          config.trafficModel.forwardingPowerWPerGbps +
        queueGb * config.trafficModel.queuePowerWPerGb,
      2,
    );

    const cacheUsedMb = clamp(nodeQueueMb + telemetryBufferMb, 0, cacheCapacityMb);
    const networkComputePowerW = round(
      ((endpointTrafficCpuPercent + forwardingCpuPercent + queueCpuPercent) / 100) *
        config.operationalModel.computePowerW,
      2,
    );
    const telemetryBufferGb = telemetryBufferMb / 1024;
    const cacheUsedGb = cacheUsedMb / 1024;
    const memoryUsedGb = round(
      clamp(
        node.resources.workload_memory_gb +
          queueGb * config.operationalModel.queueMemoryGbPerQueuedGb +
          telemetryBufferGb * config.operationalModel.telemetryMemoryGbPerBufferedGb,
        0,
        node.resources.memory,
      ),
      3,
    );
    const storageUsedGb = round(
      clamp(
        node.resources.workload_storage_gb +
          cacheUsedGb * config.operationalModel.cacheStorageGbPerBufferedGb,
        0,
        node.resources.storage,
      ),
      3,
    );
    node.resources.ingress_traffic_mbps = round(effect.ingressTrafficMbps, 2);
    node.resources.egress_traffic_mbps = round(effect.egressTrafficMbps, 2);
    node.resources.transit_traffic_mbps = round(effect.transitTrafficMbps, 2);
    node.resources.forwarding_load_mbps = round(occupancy.carriedIslTrafficMbps, 2);
    node.resources.downlink_load_mbps = round(downlinkTrafficMbps, 2);
    node.resources.active_isl_links = occupancy.activeIslLinks;
    node.resources.active_sgl_links = occupancy.activeSglLinks;
    node.resources.link_occupancy_percent = linkOccupancyPercent;
    node.resources.forwarding_cpu_percent = forwardingCpuPercent;
    node.resources.task_traffic_cpu_percent = endpointTrafficCpuPercent;
    node.resources.queue_cpu_percent = queueCpuPercent;
    node.resources.network_compute_power_w = networkComputePowerW;
    node.resources.communication_power_w = communicationPowerW;
    node.resources.queued_traffic_mb = round(nodeQueueMb, 2);
    node.resources.dropped_traffic_mb = round(effect.droppedTrafficMb + queueDroppedMb, 2);
    node.resources.cache_used_mb = round(cacheUsedMb, 2);
    node.resources.cache_utilization = round((cacheUsedMb / Math.max(cacheCapacityMb, 1)) * 100, 1);
    node.resources.telemetry_generated_mb = telemetryGeneratedMb;
    node.resources.telemetry_buffer_mb = round(telemetryBufferMb, 2);
    node.resources.telemetry_downlinked_mb = round(telemetryDownlinkedMb, 2);
    node.resources.telemetry_dropped_mb = round(telemetryDroppedMb, 2);
    node.resources.cpu_utilization = updatedCpuUtilization;
    node.resources.workload_cpu_percent = round(
      clamp(
        node.resources.compute_cpu_percent + endpointTrafficCpuPercent + forwardingCpuPercent + queueCpuPercent,
        0,
        100,
      ),
      1,
    );
    node.resources.memory_used_gb = memoryUsedGb;
    node.resources.storage_used_gb = storageUsedGb;
    node.resources.memory_utilization = round(
      clamp((memoryUsedGb / Math.max(node.resources.memory, 1)) * 100, 0, 100),
      1,
    );
    node.resources.storage_utilization = round(
      clamp((storageUsedGb / Math.max(node.resources.storage, 1)) * 100, 0, 100),
      1,
    );

    if (mode === "operational") {
      const previousEnergyWh = previousEnergyWhByNode.get(node.id) ?? config.nodeResourceDefaults.energy_wh;
      recomputeOperationalEnergy(node, previousEnergyWh, communicationPowerW + networkComputePowerW, config);
      node.state = operationalNodeState(node.resources, node.taskLoad, config);
    }

    previousEnergyWhByNode.set(node.id, node.resources.energy_wh);
  });
}

export function generateWalkerNetwork(config: WalkerNetworkConfig, input: SimulationInput = defaultSimulationInput): NetworkSlice[] {
  const runtimeConfig = configForSimulation(config, input);
  const simulationInput = effectiveSimulationInput(runtimeConfig, input);
  const previousEnergyWhByNode = new Map<string, number>();
  const linkQueueMbById = new Map<string, number>();
  const nodeQueueMbByNode = new Map<string, number>();
  const telemetryBufferMbByNode = new Map<string, number>();
  const antennaPointingHistory: AntennaPointingHistory = new Map();
  const orbitModel = orbitModelFromInput(runtimeConfig, simulationInput);

  return Array.from({ length: runtimeConfig.time.slices }, (_, index) => {
    const nodes = createNodes(index, runtimeConfig, simulationInput, previousEnergyWhByNode);
    const minute = index * runtimeConfig.time.stepMinutes;
    const links = createLinks(nodes, index, runtimeConfig, antennaPointingHistory);
    applyControlledLinkOutages(links, index, simulationInput.controlledLinkOutageSchedule);
    applyIslInterference(links, nodes, runtimeConfig);
    const groundLinks = updateGroundLinkWindows(nodes, runtimeConfig, antennaPointingHistory);
    const routingAlgorithm = simulationInput.routingAlgorithm ?? runtimeConfig.routing.algorithm;
    const routes = createRoutes(index, { ...simulationInput, routingAlgorithm }, nodes, links, runtimeConfig);
    const nodeEffects = applyRouteTrafficToLinks(links, routes, linkQueueMbById, runtimeConfig);
    applyNetworkEffectsToNodes(
      nodes,
      links,
      nodeEffects,
      groundLinks,
      nodeQueueMbByNode,
      telemetryBufferMbByNode,
      previousEnergyWhByNode,
      runtimeConfig,
      simulationInput.mode,
    );
    return {
      index,
      minute,
      time: simulationDateAtMinute(minute, runtimeConfig).toISOString(),
      orbitModel,
      routingAlgorithm,
      nodes,
      links,
      groundLinks,
      routes,
    };
  });
}
