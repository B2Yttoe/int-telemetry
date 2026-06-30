import type {
  RealTleCatalogSnapshot,
  SatelliteOperationalStatus,
  TleCatalogSource,
  TleSatelliteRecord,
} from "./types";

const EARTH_RADIUS_KM = 6371;
const MU_KM3_S2 = 398600.4418;
const TWO_PI = Math.PI * 2;

export interface CelestrakGpJsonRecord {
  OBJECT_NAME?: string;
  OBJECT_ID?: string;
  EPOCH?: string;
  MEAN_MOTION?: number | string;
  ECCENTRICITY?: number | string;
  INCLINATION?: number | string;
  RA_OF_ASC_NODE?: number | string;
  ARG_OF_PERICENTER?: number | string;
  MEAN_ANOMALY?: number | string;
  MEAN_MOTION_DOT?: number | string;
  MEAN_MOTION_DDOT?: number | string;
  BSTAR?: number | string;
  NORAD_CAT_ID?: number | string;
  DECAY_DATE?: string;
  [key: string]: unknown;
}

export interface BuildRealTleSnapshotOptions {
  source: TleCatalogSource;
  group: string;
  sourceUrl: string;
  downloadedAt: string;
  planes?: number;
  satellitesPerPlane?: number;
  targetInclinationDeg?: number;
  targetAltitudeKm?: number;
  raanClusterThresholdDeg?: number;
}

type Candidate = {
  raw: CelestrakGpJsonRecord;
  noradId: number;
  satelliteName: string;
  cosparId: string;
  epoch: string;
  inclination: number;
  raan: number;
  eccentricity: number;
  argumentOfPerigee: number;
  meanAnomaly: number;
  meanMotion: number;
  bstar: number;
  altitudeKm: number;
  argumentOfLatitude: number;
  status: SatelliteOperationalStatus;
};

type RaanCluster = {
  centerRaan: number;
  candidates: Candidate[];
};

const round = (value: number, digits = 2) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

const normalizeDegrees = (degrees: number) => ((degrees % 360) + 360) % 360;

const toNumber = (value: unknown) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : Number.NaN;
};

const average = (values: number[]) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0);

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function fingerprint(value: unknown) {
  const text = stableStringify(value);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function altitudeFromMeanMotion(meanMotionRevPerDay: number) {
  const meanMotionRadPerSec = (meanMotionRevPerDay * TWO_PI) / 86400;
  const semiMajorAxisKm = (MU_KM3_S2 / meanMotionRadPerSec ** 2) ** (1 / 3);
  return semiMajorAxisKm - EARTH_RADIUS_KM;
}

function candidateFromCelestrak(raw: CelestrakGpJsonRecord): Candidate | undefined {
  const noradId = toNumber(raw.NORAD_CAT_ID);
  const meanMotion = toNumber(raw.MEAN_MOTION);
  const inclination = toNumber(raw.INCLINATION);
  const raan = toNumber(raw.RA_OF_ASC_NODE);
  const eccentricity = toNumber(raw.ECCENTRICITY);
  const argumentOfPerigee = toNumber(raw.ARG_OF_PERICENTER);
  const meanAnomaly = toNumber(raw.MEAN_ANOMALY);
  const bstar = Number.isFinite(toNumber(raw.BSTAR)) ? toNumber(raw.BSTAR) : 0;
  const epoch = typeof raw.EPOCH === "string" ? raw.EPOCH : "";
  const satelliteName = typeof raw.OBJECT_NAME === "string" ? raw.OBJECT_NAME : "";

  if (
    !satelliteName ||
    !epoch ||
    !Number.isFinite(noradId) ||
    !Number.isFinite(meanMotion) ||
    !Number.isFinite(inclination) ||
    !Number.isFinite(raan) ||
    !Number.isFinite(eccentricity) ||
    !Number.isFinite(argumentOfPerigee) ||
    !Number.isFinite(meanAnomaly)
  ) {
    return undefined;
  }

  const status: SatelliteOperationalStatus = raw.DECAY_DATE ? "decaying" : "active";
  if (status !== "active") return undefined;

  return {
    raw,
    noradId,
    satelliteName,
    cosparId: typeof raw.OBJECT_ID === "string" ? raw.OBJECT_ID : "",
    epoch,
    inclination,
    raan: normalizeDegrees(raan),
    eccentricity,
    argumentOfPerigee: normalizeDegrees(argumentOfPerigee),
    meanAnomaly: normalizeDegrees(meanAnomaly),
    meanMotion,
    bstar,
    altitudeKm: altitudeFromMeanMotion(meanMotion),
    argumentOfLatitude: normalizeDegrees(argumentOfPerigee + meanAnomaly),
    status,
  };
}

function shellKey(candidate: Candidate) {
  const inclinationBin = Math.round(candidate.inclination * 2) / 2;
  const altitudeBin = Math.round(candidate.altitudeKm / 50) * 50;
  return `${inclinationBin.toFixed(1)}deg-${altitudeBin}km`;
}

function pickShell(candidates: Candidate[], options: BuildRealTleSnapshotOptions) {
  if (options.targetInclinationDeg !== undefined || options.targetAltitudeKm !== undefined) {
    const targetInclination = options.targetInclinationDeg ?? average(candidates.map((candidate) => candidate.inclination));
    const targetAltitude = options.targetAltitudeKm ?? average(candidates.map((candidate) => candidate.altitudeKm));
    return candidates
      .map((candidate) => ({
        candidate,
        distance:
          Math.abs(candidate.inclination - targetInclination) * 100 +
          Math.abs(candidate.altitudeKm - targetAltitude),
      }))
      .sort((a, b) => a.distance - b.distance)
      .map((entry) => entry.candidate);
  }

  const bins = new Map<string, Candidate[]>();
  candidates.forEach((candidate) => {
    const key = shellKey(candidate);
    bins.set(key, [...(bins.get(key) ?? []), candidate]);
  });

  return [...bins.values()].sort((a, b) => b.length - a.length)[0] ?? [];
}

function circularMeanDeg(values: number[]) {
  const sin = values.reduce((sum, value) => sum + Math.sin((value * Math.PI) / 180), 0);
  const cos = values.reduce((sum, value) => sum + Math.cos((value * Math.PI) / 180), 0);
  return normalizeDegrees((Math.atan2(sin, cos) * 180) / Math.PI);
}

function clusterByRaan(candidates: Candidate[], thresholdDeg: number): RaanCluster[] {
  const sorted = [...candidates].sort((a, b) => a.raan - b.raan);
  const clusters: RaanCluster[] = [];

  sorted.forEach((candidate) => {
    const current = clusters[clusters.length - 1];
    if (!current || Math.abs(candidate.raan - current.centerRaan) > thresholdDeg) {
      clusters.push({ centerRaan: candidate.raan, candidates: [candidate] });
      return;
    }
    current.candidates.push(candidate);
    current.centerRaan = circularMeanDeg(current.candidates.map((entry) => entry.raan));
  });

  return clusters;
}

function sampleEvenly<T>(items: T[], count: number) {
  if (items.length <= count) return items;
  if (count <= 1) return [items[0]];
  const selected: T[] = [];
  for (let index = 0; index < count; index += 1) {
    selected.push(items[Math.round((index * (items.length - 1)) / (count - 1))]);
  }
  return selected;
}

export function buildRealTleSnapshotFromCelestrakJson(
  rawRecords: CelestrakGpJsonRecord[],
  options: BuildRealTleSnapshotOptions,
): RealTleCatalogSnapshot {
  const requestedPlanes = Math.max(1, Math.floor(options.planes ?? 72));
  const requestedSlots = Math.max(1, Math.floor(options.satellitesPerPlane ?? 22));
  const raanThreshold = options.raanClusterThresholdDeg ?? 1.5;
  const candidates = rawRecords
    .map(candidateFromCelestrak)
    .filter((candidate): candidate is Candidate => Boolean(candidate));
  const shellCandidates = pickShell(candidates, options);
  const clusters = clusterByRaan(shellCandidates, raanThreshold)
    .filter((cluster) => cluster.candidates.length >= requestedSlots)
    .sort((a, b) => b.candidates.length - a.candidates.length)
    .slice(0, requestedPlanes)
    .sort((a, b) => a.centerRaan - b.centerRaan);

  if (clusters.length < requestedPlanes) {
    throw new Error(
      `Only ${clusters.length} RAAN clusters have at least ${requestedSlots} satellites; requested ${requestedPlanes} planes.`,
    );
  }

  const selected = clusters.flatMap((cluster, planeIndex) =>
    sampleEvenly(
      [...cluster.candidates].sort((a, b) => a.argumentOfLatitude - b.argumentOfLatitude),
      requestedSlots,
    ).map((candidate, slotIndex) => ({ candidate, planeIndex, slotIndex })),
  );

  const shellId = `${options.group.toLowerCase()}-real-${round(average(selected.map((entry) => entry.candidate.inclination)), 1)}deg-${round(
    average(selected.map((entry) => entry.candidate.altitudeKm)),
    0,
  )}km`;

  const selectedFingerprintInput = selected.map(({ candidate, planeIndex, slotIndex }) => ({
    norad_id: candidate.noradId,
    epoch: candidate.epoch,
    plane_id: planeIndex,
    slot_id: slotIndex,
  }));
  const snapshotFingerprint = fingerprint({
    source: options.source,
    group: options.group,
    downloaded_at: options.downloadedAt,
    layout: [requestedPlanes, requestedSlots],
    satellites: selectedFingerprintInput,
  });

  const satellites: TleSatelliteRecord[] = selected.map(({ candidate, planeIndex, slotIndex }) => ({
    satellite_id: `P${String(planeIndex + 1).padStart(2, "0")}-S${String(slotIndex + 1).padStart(2, "0")}`,
    norad_id: candidate.noradId,
    satellite_name: candidate.satelliteName,
    cospar_id: candidate.cosparId,
    shell_id: shellId,
    plane_id: planeIndex,
    slot_id: slotIndex,
    epoch: candidate.epoch,
    inclination: candidate.inclination,
    raan: candidate.raan,
    eccentricity: candidate.eccentricity,
    argument_of_perigee: candidate.argumentOfPerigee,
    mean_anomaly: candidate.meanAnomaly,
    mean_motion: candidate.meanMotion,
    bstar: candidate.bstar,
    status: candidate.status,
    raw_omm: candidate.raw as Record<string, unknown>,
    source: options.source,
    source_url: options.sourceUrl,
    catalog_fingerprint: snapshotFingerprint,
  }));

  return {
    schema: "int-temerity-real-tle-snapshot/v1",
    source: options.source,
    group: options.group,
    format: "celestrak-gp-json",
    source_url: options.sourceUrl,
    downloaded_at: options.downloadedAt,
    generated_at: new Date().toISOString(),
    fingerprint: snapshotFingerprint,
    shell_id: shellId,
    catalog_count: candidates.length,
    shell_count: shellCandidates.length,
    selected_count: satellites.length,
    mean_altitude_km: round(average(selected.map((entry) => entry.candidate.altitudeKm)), 2),
    mean_inclination_deg: round(average(selected.map((entry) => entry.candidate.inclination)), 4),
    mean_mean_motion_rev_per_day: round(average(selected.map((entry) => entry.candidate.meanMotion)), 8),
    layout: {
      planes: requestedPlanes,
      satellites_per_plane: requestedSlots,
      selection_strategy: "largest-shell-raan-clusters-even-slot-sampling",
      raan_cluster_threshold_deg: raanThreshold,
    },
    satellites,
  };
}

export function verifyRealTleSnapshot(snapshot: RealTleCatalogSnapshot) {
  const errors: string[] = [];
  const expectedCount = snapshot.layout.planes * snapshot.layout.satellites_per_plane;
  const ids = new Set<string>();
  const planeSlotIds = new Set<string>();

  if (snapshot.schema !== "int-temerity-real-tle-snapshot/v1") errors.push("unsupported snapshot schema");
  if (snapshot.selected_count !== snapshot.satellites.length) errors.push("selected_count does not match satellites length");
  if (snapshot.satellites.length !== expectedCount) {
    errors.push(`expected ${expectedCount} satellites for layout, got ${snapshot.satellites.length}`);
  }

  snapshot.satellites.forEach((record) => {
    ids.add(record.satellite_id);
    planeSlotIds.add(`${record.plane_id}:${record.slot_id}`);
    if (!record.raw_omm && (!record.tle_line1 || !record.tle_line2)) {
      errors.push(`${record.satellite_id} has neither raw_omm nor TLE lines`);
    }
    if (!record.norad_id || !record.satellite_name || !record.epoch) {
      errors.push(`${record.satellite_id} misses identity metadata`);
    }
    if (record.plane_id < 0 || record.plane_id >= snapshot.layout.planes) {
      errors.push(`${record.satellite_id} plane_id out of range`);
    }
    if (record.slot_id < 0 || record.slot_id >= snapshot.layout.satellites_per_plane) {
      errors.push(`${record.satellite_id} slot_id out of range`);
    }
  });

  if (ids.size !== snapshot.satellites.length) errors.push("duplicate satellite_id values");
  if (planeSlotIds.size !== expectedCount) errors.push("plane/slot grid is incomplete");

  return { ok: errors.length === 0, errors };
}
