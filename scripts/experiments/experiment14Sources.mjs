import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { readCsvStream } from "../../stage2-int/tools/csv-stream.mjs";
import { deterministicSample, parseCsv, round, sha256 } from "./blindValidationMetrics.mjs";
import { parseOrbitEpochUtcMs } from "./utcEpoch.mjs";

const EARTH_RADIUS_KM = 6371;
const LIGHT_KM_PER_MS = 299.792458;

export async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function fetchJson(url, { timeoutMs = 60_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "INT-Telemetry-Experiment14/1.0 research-validation",
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

export function extractRadarSeries(payload) {
  const candidates = [];
  function visit(value, path = []) {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value.timestamps) && Array.isArray(value.values)) {
      const rows = value.values.map((entry, index) => ({
        index,
        time: value.timestamps[index] ?? String(index),
        value: Number(entry),
        source_path: path.join("."),
      })).filter((row) => Number.isFinite(row.value));
      if (rows.length >= 4) candidates.push(rows);
    }
    for (const [key, child] of Object.entries(value)) visit(child, [...path, key]);
  }
  visit(payload);
  candidates.sort((left, right) => right.length - left.length);
  return candidates[0] ?? [];
}

export async function loadModelThroughput(routesPath) {
  const rows = await readCsvStream(routesPath, {
    columns: ["slice_index", "task_id", "status", "delivery_state", "delivered", "carried_traffic_mbps"],
  });
  return rows.filter((row) =>
    (String(row.delivered).toLowerCase() === "true" || row.delivery_state === "delivered") &&
    Number.isFinite(Number(row.carried_traffic_mbps)),
  ).map((row) => ({
    slice_index: Number(row.slice_index),
    task_id: row.task_id,
    model_carried_traffic_mbps: Number(row.carried_traffic_mbps),
  }));
}

export async function loadHistoricalOrbitRates(path, minimumHours = 1) {
  const rows = await readCsvStream(path, {
    columns: ["validation_id", "norad_id", "epoch_separation_hours", "eci_position_error_km"],
  });
  return rows.map((row) => {
    const hours = Math.abs(Number(row.epoch_separation_hours));
    const error = Math.abs(Number(row.eci_position_error_km));
    return {
      validation_id: row.validation_id,
      norad_id: row.norad_id,
      epoch_separation_hours: hours,
      eci_position_error_km: error,
      error_rate_km_per_hour: hours >= minimumHours && Number.isFinite(error) ? error / hours : Number.NaN,
    };
  }).filter((row) => Number.isFinite(row.error_rate_km_per_hour));
}

export function medianEpoch(records) {
  const epochs = records.map((record) => parseOrbitEpochUtcMs(
    record.EPOCH ?? record.epoch ?? record.raw_omm?.EPOCH ?? record.CREATION_DATE,
  )).filter(Number.isFinite).sort((left, right) => left - right);
  if (!epochs.length) throw new Error("External orbit reference has no valid epochs");
  return new Date(epochs[Math.floor(epochs.length / 2)]).toISOString();
}

export async function loadMlabMember({ url, member, config, metric }) {
  const { fetchZipMember } = await import("./blindValidationMetrics.mjs");
  const fetched = await fetchZipMember(url, member);
  const allRows = parseCsv(fetched.content.toString("utf8"));
  const start = new Date(`${config.test_start}T00:00:00Z`).getTime();
  const end = new Date(`${config.test_end}T23:59:59.999Z`).getTime();
  const sourceRows = allRows.filter((row) => {
    const time = new Date(row.test_time).getTime();
    return row.data_source === config.data_source_filter &&
      Number.isFinite(time) && time >= start && time <= end &&
      Number.isFinite(Number(row[metric]));
  });
  const sampled = deterministicSample(
    sourceRows,
    config.maximum_samples_per_metric,
    config.deterministic_sample_seed,
    "uuid",
  );
  return {
    rows: sampled,
    metadata: {
      member_name: fetched.filename,
      compressed_sha256: fetched.compressed_sha256,
      content_sha256: fetched.content_sha256,
      compressed_bytes: fetched.compressed_bytes,
      uncompressed_bytes: fetched.uncompressed_bytes,
      full_csv_rows: allRows.length,
      matching_ndt7_rows: sourceRows.length,
      retained_rows: sampled.length,
      metric,
      test_start: config.test_start,
      test_end: config.test_end,
    },
  };
}

export async function fetchRipeBlindWindow(config, freezeTime) {
  const probeUrl = `https://atlas.ripe.net/api/v2/probes/?asn_v4=${config.asn}&status=1&page_size=500`;
  const probesPayload = await fetchJson(probeUrl);
  const publicProbes = (probesPayload.results ?? [])
    .filter((probe) => probe.is_public && probe.status?.id === 1 && Array.isArray(probe.geometry?.coordinates))
    .sort((left, right) => Number(left.id) - Number(right.id))
    .slice(0, config.maximum_public_probes);
  const stop = Math.floor((new Date(freezeTime).getTime() / 1000 - 3600) / 3600) * 3600;
  const start = stop - config.window_hours * 3600;
  const ids = publicProbes.map((probe) => probe.id).join(",");
  if (!ids) throw new Error("RIPE Atlas returned no public AS14593 probes");
  const resultsUrl = `https://atlas.ripe.net/api/v2/measurements/${config.measurement_id}/results/?probe_ids=${ids}&start=${start}&stop=${stop}`;
  const payload = await fetchJson(resultsUrl);
  const probeById = new Map(publicProbes.map((probe) => [Number(probe.id), probe]));
  const results = (Array.isArray(payload) ? payload : payload.results ?? []).map((row) => {
    const probe = probeById.get(Number(row.prb_id ?? row.probe_id));
    const [longitude, latitude] = probe?.geometry?.coordinates ?? [];
    return {
      ...row,
      probe_id: row.prb_id ?? row.probe_id,
      probe_country: probe?.country_code ?? "",
      probe_latitude_deg: latitude,
      probe_longitude_deg: longitude,
    };
  });
  return {
    probes_payload: probesPayload,
    selected_probes: publicProbes,
    results,
    window: {
      start_epoch_seconds: start,
      stop_epoch_seconds: stop,
      start: new Date(start * 1000).toISOString(),
      stop: new Date(stop * 1000).toISOString(),
      probe_url: probeUrl,
      results_url: resultsUrl,
    },
  };
}

function radians(degrees) {
  return (degrees * Math.PI) / 180;
}

function geodeticToEcef(latitudeDeg, longitudeDeg, altitudeKm = 0) {
  const latitude = radians(latitudeDeg);
  const longitude = radians(longitudeDeg);
  const radius = EARTH_RADIUS_KM + altitudeKm;
  const cosLatitude = Math.cos(latitude);
  return {
    x: radius * cosLatitude * Math.cos(longitude),
    y: radius * cosLatitude * Math.sin(longitude),
    z: radius * Math.sin(latitude),
  };
}

function subtract(left, right) {
  return { x: left.x - right.x, y: left.y - right.y, z: left.z - right.z };
}

function dot(left, right) {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}

function norm(value) {
  return Math.hypot(value.x, value.y, value.z);
}

function distanceKm(left, right) {
  return norm(subtract(left, right));
}

function elevationDeg(observer, satellite) {
  const line = subtract(satellite, observer);
  const denominator = norm(line) * norm(observer);
  if (!(denominator > 0)) return Number.NaN;
  const sine = Math.max(-1, Math.min(1, dot(line, observer) / denominator));
  return (Math.asin(sine) * 180) / Math.PI;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const phi1 = radians(lat1);
  const phi2 = radians(lat2);
  const dPhi = radians(lat2 - lat1);
  const dLambda = radians(lon2 - lon1);
  const a = Math.sin(dPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a));
}

const REGIONAL_GATEWAYS = [
  { id: "na-west", label: "North America West", latitude_deg: 45.52, longitude_deg: -122.68 },
  { id: "na-central", label: "North America Central", latitude_deg: 39.1, longitude_deg: -94.58 },
  { id: "na-east", label: "North America East", latitude_deg: 39.04, longitude_deg: -77.49 },
  { id: "na-south", label: "North America South", latitude_deg: 32.78, longitude_deg: -96.8 },
  { id: "canada-east", label: "Canada East", latitude_deg: 43.65, longitude_deg: -79.38 },
  { id: "europe-west", label: "Europe West", latitude_deg: 50.11, longitude_deg: 8.68 },
  { id: "europe-uk", label: "Europe UK", latitude_deg: 51.51, longitude_deg: -0.13 },
  { id: "europe-central", label: "Europe Central", latitude_deg: 48.14, longitude_deg: 11.58 },
  { id: "europe-north", label: "Europe North", latitude_deg: 59.91, longitude_deg: 10.75 },
  { id: "south-america", label: "South America", latitude_deg: -23.55, longitude_deg: -46.63 },
  { id: "south-america-west", label: "South America West", latitude_deg: -33.45, longitude_deg: -70.66 },
  { id: "africa-east", label: "Africa East", latitude_deg: -1.29, longitude_deg: 36.82 },
  { id: "africa-south", label: "Africa South", latitude_deg: -26.2, longitude_deg: 28.04 },
  { id: "east-asia", label: "East Asia", latitude_deg: 35.68, longitude_deg: 139.76 },
  { id: "oceania", label: "Oceania", latitude_deg: -33.87, longitude_deg: 151.21 },
  { id: "new-zealand", label: "New Zealand", latitude_deg: -36.85, longitude_deg: 174.76 },
];

function boolish(value) {
  return value === true || value === 1 || String(value).toLowerCase() === "true" || String(value) === "1";
}

class MinHeap {
  constructor() {
    this.items = [];
  }

  push(item) {
    this.items.push(item);
    let index = this.items.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.items[parent].distance <= item.distance) break;
      this.items[index] = this.items[parent];
      index = parent;
    }
    this.items[index] = item;
  }

  pop() {
    if (!this.items.length) return null;
    const root = this.items[0];
    const tail = this.items.pop();
    if (this.items.length && tail) {
      let index = 0;
      while (true) {
        const left = index * 2 + 1;
        const right = left + 1;
        if (left >= this.items.length) break;
        const child = right < this.items.length && this.items[right].distance < this.items[left].distance ? right : left;
        if (this.items[child].distance >= tail.distance) break;
        this.items[index] = this.items[child];
        index = child;
      }
      this.items[index] = tail;
    }
    return root;
  }

  get length() {
    return this.items.length;
  }
}

function shortestLatencyMs(adjacency, source, target) {
  if (source === target) return 0;
  const distances = new Map([[source, 0]]);
  const queue = new MinHeap();
  queue.push({ node: source, distance: 0 });
  while (queue.length) {
    const current = queue.pop();
    if (!current || current.distance !== distances.get(current.node)) continue;
    if (current.node === target) return current.distance;
    for (const edge of adjacency.get(current.node) ?? []) {
      const distance = current.distance + edge.latency_ms;
      if (distance < (distances.get(edge.target) ?? Infinity)) {
        distances.set(edge.target, distance);
        queue.push({ node: edge.target, distance });
      }
    }
  }
  return Number.NaN;
}

function visibleCandidates(satellites, observer, minimumElevation) {
  return satellites.map((satellite) => ({
    satellite,
    distance_km: distanceKm(observer, satellite.position),
    elevation_deg: elevationDeg(observer, satellite.position),
  })).filter((candidate) => candidate.elevation_deg >= minimumElevation)
    .sort((left, right) => left.distance_km - right.distance_km);
}

export async function loadRttTopology(nodesPath, linksPath) {
  const [nodes, links] = await Promise.all([
    readCsvStream(nodesPath, { columns: ["slice_index", "node_id", "latitude_deg", "longitude_deg", "altitude_km"] }),
    readCsvStream(linksPath, { columns: ["slice_index", "source", "target", "status", "is_active", "latency_ms"] }),
  ]);
  const satellitesBySlice = new Map();
  for (const row of nodes) {
    const slice = Number(row.slice_index);
    const latitude = Number(row.latitude_deg);
    const longitude = Number(row.longitude_deg);
    const altitude = Number(row.altitude_km);
    if (![slice, latitude, longitude].every(Number.isFinite)) continue;
    if (!satellitesBySlice.has(slice)) satellitesBySlice.set(slice, []);
    satellitesBySlice.get(slice).push({
      id: row.node_id,
      position: geodeticToEcef(latitude, longitude, Number.isFinite(altitude) ? altitude : 550),
    });
  }
  const adjacencyBySlice = new Map();
  for (const row of links) {
    if (!boolish(row.is_active) || row.status === "down") continue;
    const slice = Number(row.slice_index);
    const latency = Number(row.latency_ms);
    if (!Number.isFinite(slice) || !Number.isFinite(latency)) continue;
    if (!adjacencyBySlice.has(slice)) adjacencyBySlice.set(slice, new Map());
    const adjacency = adjacencyBySlice.get(slice);
    if (!adjacency.has(row.source)) adjacency.set(row.source, []);
    if (!adjacency.has(row.target)) adjacency.set(row.target, []);
    adjacency.get(row.source).push({ target: row.target, latency_ms: latency });
    adjacency.get(row.target).push({ target: row.source, latency_ms: latency });
  }
  return {
    satellitesBySlice,
    adjacencyBySlice,
    sliceIndexes: [...satellitesBySlice.keys()].sort((left, right) => left - right),
  };
}

export function simulateUserRtt({ topology, observations, config, externalField, sourceLabel }) {
  const valid = observations.filter((row) =>
    Number.isFinite(Number(row[externalField])) &&
    Number.isFinite(Number(row.probe_latitude_deg ?? row.lat)) &&
    Number.isFinite(Number(row.probe_longitude_deg ?? row.lon)),
  ).sort((left, right) => new Date(left.test_time ?? Number(left.timestamp) * 1000) - new Date(right.test_time ?? Number(right.timestamp) * 1000));
  if (!valid.length || !topology.sliceIndexes.length) return [];
  const firstTime = observationTime(valid[0]);
  const shortestCache = new Map();
  return valid.map((row, index) => {
    const latitude = Number(row.probe_latitude_deg ?? row.lat);
    const longitude = Number(row.probe_longitude_deg ?? row.lon);
    const time = observationTime(row);
    const sliceOffset = Math.max(0, Math.floor((time - firstTime) / 240_000));
    const sliceIndex = topology.sliceIndexes[sliceOffset % topology.sliceIndexes.length];
    const satellites = topology.satellitesBySlice.get(sliceIndex) ?? [];
    const userPosition = geodeticToEcef(latitude, longitude, 0);
    const access = visibleCandidates(satellites, userPosition, config.minimum_elevation_deg).slice(0, 12);
    const base = {
      source: sourceLabel,
      sample_index: index,
      observation_id: row.uuid ?? row.probe_id ?? row.prb_id ?? index,
      time: new Date(time).toISOString(),
      country: row.probe_country ?? row.client_country_code ?? "",
      latitude_deg: round(latitude, 5),
      longitude_deg: round(longitude, 5),
      slice_index: sliceIndex,
      external_rtt_ms: round(Number(row[externalField])),
    };
    if (!access.length) return { ...base, status: "no-visible-access-satellite" };
    const gateways = REGIONAL_GATEWAYS.map((gateway) => ({
      ...gateway,
      distance_to_user_km: haversineKm(latitude, longitude, gateway.latitude_deg, gateway.longitude_deg),
      position: geodeticToEcef(gateway.latitude_deg, gateway.longitude_deg, 0),
    })).sort((left, right) => left.distance_to_user_km - right.distance_to_user_km).slice(0, 3);
    let best = null;
    const remember = (candidate) => {
      if (!best || candidate.model_rtt_ms < best.model_rtt_ms) best = candidate;
    };
    for (const user of access) {
      for (const gateway of gateways) {
        const gatewayElevation = elevationDeg(gateway.position, user.satellite.position);
        if (gatewayElevation < config.minimum_elevation_deg) continue;
        const gatewayDistance = distanceKm(gateway.position, user.satellite.position);
        const oneWay = user.distance_km / LIGHT_KM_PER_MS + gatewayDistance / LIGHT_KM_PER_MS +
          config.processing_one_way_ms + config.terrestrial_tail_one_way_ms;
        remember({
          ...base,
          status: "same-satellite-gateway",
          access_satellite_id: user.satellite.id,
          gateway_satellite_id: user.satellite.id,
          gateway_id: gateway.id,
          access_elevation_deg: round(user.elevation_deg, 3),
          gateway_elevation_deg: round(gatewayElevation, 3),
          isl_latency_one_way_ms: 0,
          model_rtt_ms: round(2 * oneWay),
        });
      }
    }
    if (!best) {
      const adjacency = topology.adjacencyBySlice.get(sliceIndex) ?? new Map();
      for (const user of access.slice(0, 4)) {
        for (const gateway of gateways.slice(0, 2)) {
          const gatewayAccess = visibleCandidates(satellites, gateway.position, config.minimum_elevation_deg).slice(0, 4);
          for (const remote of gatewayAccess) {
            const cacheKey = `${sliceIndex}:${user.satellite.id}:${remote.satellite.id}`;
            let islLatency = shortestCache.get(cacheKey);
            if (islLatency === undefined) {
              islLatency = shortestLatencyMs(adjacency, user.satellite.id, remote.satellite.id);
              shortestCache.set(cacheKey, islLatency);
            }
            if (!Number.isFinite(islLatency)) continue;
            const oneWay = user.distance_km / LIGHT_KM_PER_MS + islLatency + remote.distance_km / LIGHT_KM_PER_MS +
              config.processing_one_way_ms + config.terrestrial_tail_one_way_ms;
            remember({
              ...base,
              status: "isl-assisted-gateway",
              access_satellite_id: user.satellite.id,
              gateway_satellite_id: remote.satellite.id,
              gateway_id: gateway.id,
              access_elevation_deg: round(user.elevation_deg, 3),
              gateway_elevation_deg: round(remote.elevation_deg, 3),
              isl_latency_one_way_ms: round(islLatency),
              model_rtt_ms: round(2 * oneWay),
            });
          }
        }
      }
    }
    return best ?? { ...base, status: "no-gateway-route" };
  });
}

function observationTime(row) {
  const epoch = Number(row.timestamp);
  if (Number.isFinite(epoch)) return epoch * 1000;
  const parsed = new Date(row.test_time ?? row.time).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

export function deterministicObservationSubset(rows, maximum, seed) {
  return deterministicSample(rows, maximum, seed, "uuid");
}

export async function sourceFileRecord(path, role) {
  const contents = await readFile(path);
  return {
    source_name: basename(path),
    role,
    path,
    bytes: contents.length,
    sha256: sha256(contents),
  };
}
