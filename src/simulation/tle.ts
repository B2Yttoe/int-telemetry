import {
  degreesLat,
  degreesLong,
  eciToEcf,
  eciToGeodetic,
  gstime,
  json2satrec,
  propagate,
  twoline2satrec,
  type SatRec,
} from "../vendor/satellitePure";
import type {
  SatelliteOrbitElements,
  SatelliteTimeState,
  TleSatelliteRecord,
  Vector3Km,
  WalkerNetworkConfig,
} from "./types";
import { sunlightState } from "./spaceEnvironment";

const TWO_PI = Math.PI * 2;

const round = (value: number, digits = 1) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

const toDegrees = (radians: number) => (radians * 180) / Math.PI;
const normalizeDegrees = (degrees: number) => ((degrees % 360) + 360) % 360;
const signedAngleDeltaDeg = (current: number, reference: number) => ((current - reference + 540) % 360) - 180;

const satrecCache = new Map<string, SatRec>();

function satelliteId(plane: number, slot: number) {
  return `P${String(plane + 1).padStart(2, "0")}-S${String(slot + 1).padStart(2, "0")}`;
}

function semiMajorAxisKm(config: WalkerNetworkConfig) {
  return config.constellation.earthRadiusKm + config.constellation.altitudeKm;
}

function meanMotionRevPerDay(config: WalkerNetworkConfig) {
  const radius = semiMajorAxisKm(config);
  const meanMotionRadPerSec = Math.sqrt(config.constellation.gravitationalParameterKm3S2 / radius ** 3);
  return (meanMotionRadPerSec * 86400) / TWO_PI;
}

function orbitalPeriodMinutesFromMeanMotion(meanMotion: number) {
  return 1440 / meanMotion;
}

function planeSpacingDeg(config: WalkerNetworkConfig) {
  return (config.constellation.walkerType === "delta" ? 360 : 180) / config.constellation.planes;
}

function planeRaanDeg(plane: number, config: WalkerNetworkConfig) {
  return normalizeDegrees(plane * planeSpacingDeg(config));
}

function phaseOffsetDeg(plane: number, config: WalkerNetworkConfig) {
  const { planes, satellitesPerPlane, phasing } = config.constellation;
  return (360 * phasing * plane) / (planes * satellitesPerPlane);
}

function meanAnomalyDeg(plane: number, slot: number, config: WalkerNetworkConfig) {
  return normalizeDegrees((360 * slot) / config.constellation.satellitesPerPlane + phaseOffsetDeg(plane, config));
}

function simulationDateAtMinute(minute: number, config: WalkerNetworkConfig) {
  return new Date(new Date(config.time.epochIso).getTime() + minute * 60 * 1000);
}

function epochToTleEpoch(date: Date) {
  const year = date.getUTCFullYear();
  const startOfYear = Date.UTC(year, 0, 1, 0, 0, 0, 0);
  const dayOfYear = (date.getTime() - startOfYear) / 86400000 + 1;
  return `${String(year % 100).padStart(2, "0")}${dayOfYear.toFixed(8).padStart(12, "0")}`;
}

function tleChecksum(lineWithoutChecksum: string) {
  let sum = 0;
  for (const char of lineWithoutChecksum) {
    if (char >= "0" && char <= "9") {
      sum += Number(char);
    } else if (char === "-") {
      sum += 1;
    }
  }
  return sum % 10;
}

function withChecksum(line: string) {
  const base = line.padEnd(68, " ").slice(0, 68);
  return `${base}${tleChecksum(base)}`;
}

function formatTleExponential(value: number) {
  if (value === 0) return " 00000+0";
  const sign = value < 0 ? "-" : " ";
  const absolute = Math.abs(value);
  let exponent = Math.floor(Math.log10(absolute)) + 1;
  let mantissa = absolute / 10 ** exponent;
  let digits = Math.round(mantissa * 100000);
  if (digits >= 100000) {
    digits = 10000;
    exponent += 1;
  }
  const exponentSign = exponent >= 0 ? "+" : "-";
  return `${sign}${String(digits).padStart(5, "0")}${exponentSign}${Math.abs(exponent)}`.slice(0, 8);
}

function pieceCode(index: number) {
  let value = index;
  let code = "";
  do {
    code = String.fromCharCode(65 + (value % 26)) + code;
    value = Math.floor(value / 26) - 1;
  } while (value >= 0);
  return code;
}

function cosparIds(index: number, config: WalkerNetworkConfig) {
  const { cosparYear, cosparLaunchNumber } = config.orbit.tleCatalog;
  const piece = pieceCode(index);
  const year2 = String(cosparYear % 100).padStart(2, "0");
  const launchNumber = String(cosparLaunchNumber).padStart(3, "0");
  return {
    cosparId: `${cosparYear}-${launchNumber}${piece}`,
    tleInternationalDesignator: `${year2}${launchNumber}${piece}`.padEnd(8, " ").slice(0, 8),
  };
}

function buildTleLines(record: Omit<TleSatelliteRecord, "tle_line1" | "tle_line2">, config: WalkerNetworkConfig) {
  const satnum = String(record.norad_id).padStart(5, "0").slice(-5);
  const index = record.plane_id * config.constellation.satellitesPerPlane + record.slot_id;
  const { tleInternationalDesignator } = cosparIds(index, config);
  const epoch = epochToTleEpoch(new Date(record.epoch));
  const ndot = " .00000000";
  const nddot = " 00000+0";
  const bstar = formatTleExponential(record.bstar);
  const elementNumber = " 999";
  const line1 = withChecksum(
    `1 ${satnum}U ${tleInternationalDesignator} ${epoch} ${ndot} ${nddot} ${bstar} 0 ${elementNumber}`,
  );

  const inclination = record.inclination.toFixed(4).padStart(8, " ");
  const raan = normalizeDegrees(record.raan).toFixed(4).padStart(8, " ");
  const eccentricity = String(Math.round(record.eccentricity * 10000000)).padStart(7, "0").slice(0, 7);
  const argumentOfPerigee = normalizeDegrees(record.argument_of_perigee).toFixed(4).padStart(8, " ");
  const meanAnomaly = normalizeDegrees(record.mean_anomaly).toFixed(4).padStart(8, " ");
  const meanMotion = record.mean_motion.toFixed(8).padStart(11, " ");
  const revolutionAtEpoch = "    0";
  const line2 = withChecksum(
    `2 ${satnum} ${inclination} ${raan} ${eccentricity} ${argumentOfPerigee} ${meanAnomaly} ${meanMotion}${revolutionAtEpoch}`,
  );

  return { line1, line2 };
}

export function syntheticWalkerTleRecord(
  plane: number,
  slot: number,
  config: WalkerNetworkConfig,
): TleSatelliteRecord {
  const index = plane * config.constellation.satellitesPerPlane + slot;
  const { cosparId } = cosparIds(index, config);
  const recordWithoutLines = {
    satellite_id: satelliteId(plane, slot),
    norad_id: config.orbit.tleCatalog.noradBaseId + index,
    satellite_name: `${config.orbit.tleCatalog.satelliteNamePrefix}-${String(index + 1).padStart(4, "0")}`,
    cospar_id: cosparId,
    shell_id: config.constellation.shellId,
    plane_id: plane,
    slot_id: slot,
    epoch: config.time.epochIso,
    inclination: config.constellation.inclinationDeg,
    raan: planeRaanDeg(plane, config),
    eccentricity: config.orbit.tleCatalog.eccentricity,
    argument_of_perigee: 0,
    mean_anomaly: meanAnomalyDeg(plane, slot, config),
    mean_motion: meanMotionRevPerDay(config),
    bstar: config.orbit.tleCatalog.bstar,
    status: "active" as const,
  };
  const { line1, line2 } = buildTleLines(recordWithoutLines, config);

  return {
    ...recordWithoutLines,
    tle_line1: line1,
    tle_line2: line2,
  };
}

export function generateSyntheticWalkerTleCatalog(config: WalkerNetworkConfig) {
  const records: TleSatelliteRecord[] = [];
  for (let plane = 0; plane < config.constellation.planes; plane += 1) {
    for (let slot = 0; slot < config.constellation.satellitesPerPlane; slot += 1) {
      records.push(syntheticWalkerTleRecord(plane, slot, config));
    }
  }
  return records;
}

export function orbitElementsFromTleRecord(
  record: TleSatelliteRecord,
  config: WalkerNetworkConfig,
): SatelliteOrbitElements {
  const meanMotionRadPerSec = (record.mean_motion * TWO_PI) / 86400;
  return {
    satelliteId: record.satellite_id,
    orbitModel: "tle-sgp4",
    noradId: record.norad_id,
    satelliteName: record.satellite_name,
    cosparId: record.cospar_id,
    shellId: record.shell_id,
    walkerType: config.constellation.walkerType,
    plane: record.plane_id,
    slot: record.slot_id,
    semiMajorAxisKm: semiMajorAxisKm(config),
    eccentricity: record.eccentricity,
    inclinationDeg: record.inclination,
    raanDeg: record.raan,
    argumentOfPerigeeDeg: record.argument_of_perigee,
    meanAnomalyDegAtEpoch: record.mean_anomaly,
    meanMotionRadPerSec,
    meanMotionRevPerDay: record.mean_motion,
    orbitalPeriodMinutes: orbitalPeriodMinutesFromMeanMotion(record.mean_motion),
    epochIso: record.epoch,
    tleLine1: record.tle_line1,
    tleLine2: record.tle_line2,
    bstar: record.bstar,
    status: record.status,
  };
}

function satrecFromRecord(record: TleSatelliteRecord) {
  const cacheKey = record.raw_omm
    ? `omm:${record.catalog_fingerprint ?? ""}:${record.norad_id}:${record.epoch}`
    : `tle:${record.tle_line1}\n${record.tle_line2}`;
  const cached = satrecCache.get(cacheKey);
  if (cached) return cached;
  const satrec = record.raw_omm
    ? json2satrec(record.raw_omm as never)
    : record.tle_line1 && record.tle_line2
      ? twoline2satrec(record.tle_line1, record.tle_line2)
      : undefined;
  if (!satrec) {
    throw new Error(`Missing TLE/OMM propagation data for ${record.satellite_id}`);
  }
  satrecCache.set(cacheKey, satrec);
  return satrec;
}

function vectorMagnitude(vector: Vector3Km) {
  return Math.sqrt(vector.x * vector.x + vector.y * vector.y + vector.z * vector.z);
}

export function propagateTleRecord(
  record: TleSatelliteRecord,
  minute: number,
  config: WalkerNetworkConfig,
): SatelliteTimeState {
  const date = simulationDateAtMinute(minute, config);
  const result = propagate(satrecFromRecord(record), date);
  if (!result) {
    throw new Error(`SGP4 propagation failed for ${record.satellite_id}`);
  }

  const gmst = gstime(date);
  const eci = result.position;
  const ecef = eciToEcf(eci, gmst);
  const geodetic = eciToGeodetic(eci, gmst);
  const eciLongitudeDeg = ((toDegrees(Math.atan2(eci.y, eci.x)) + 540) % 360) - 180;
  const longitudeDeg = degreesLong(geodetic.longitude);
  const latitudeDeg = degreesLat(geodetic.latitude);
  const velocityMagnitude = vectorMagnitude({
    x: result.velocity.x,
    y: result.velocity.y,
    z: result.velocity.z,
  });
  const sunlight = sunlightState(eci, date);

  return {
    time: date.toISOString(),
    satelliteId: record.satellite_id,
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
      vx: round(result.velocity.x, 5),
      vy: round(result.velocity.y, 5),
      vz: round(result.velocity.z, 5),
    },
    latitudeDeg: round(latitudeDeg, 5),
    longitudeDeg: round(longitudeDeg, 5),
    altitudeKm: round(geodetic.height, 3),
    orbitalVelocityKmS: round(velocityMagnitude, 5),
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
