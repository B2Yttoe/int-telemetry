import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

const EARTH_RADIUS_KM = 6371;
const EARTH_MU_KM3_S2 = 398600.4418;
const C_KM_PER_MS = 299.792458;
const USER_PING_DEFAULTS = {
  minElevationDeg: 10,
  processingOneWayMs: 3,
  terrestrialTailOneWayMs: 4,
};
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

function argValue(args, name, fallback = "") {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  return args[index + 1] ?? fallback;
}

function hasArg(args, name) {
  return args.includes(name);
}

function rel(path) {
  return relative(process.cwd(), path).replaceAll("\\", "/");
}

function round(value, digits = 4) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function numeric(row, key, fallback = Number.NaN) {
  const value = Number(row?.[key]);
  return Number.isFinite(value) ? value : fallback;
}

function finiteNumber(value) {
  if (value === "" || value === null || value === undefined) return Number.NaN;
  const number = Number(value);
  return Number.isFinite(number) ? number : Number.NaN;
}

function average(values) {
  const clean = values.filter(Number.isFinite);
  return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : Number.NaN;
}

function percentile(values, p) {
  const clean = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!clean.length) return Number.NaN;
  const index = Math.max(0, Math.min(clean.length - 1, Math.floor((clean.length - 1) * p)));
  return clean[index];
}

function mae(pairs) {
  return average(pairs.map(([left, right]) => Math.abs(left - right)));
}

function correlation(pairs) {
  const clean = pairs.filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  if (clean.length < 2) return Number.NaN;
  const mx = average(clean.map(([x]) => x));
  const my = average(clean.map(([, y]) => y));
  const numerator = clean.reduce((sum, [x, y]) => sum + (x - mx) * (y - my), 0);
  const dx = Math.sqrt(clean.reduce((sum, [x]) => sum + (x - mx) ** 2, 0));
  const dy = Math.sqrt(clean.reduce((sum, [, y]) => sum + (y - my) ** 2, 0));
  return dx && dy ? numerator / (dx * dy) : Number.NaN;
}

function normalize(values) {
  const clean = values.filter(Number.isFinite);
  const min = Math.min(...clean);
  const max = Math.max(...clean);
  if (!Number.isFinite(min) || !Number.isFinite(max) || Math.abs(max - min) < 1e-9) {
    return values.map(() => 0);
  }
  return values.map((value) => (Number.isFinite(value) ? (value - min) / (max - min) : Number.NaN));
}

function resample(values, count) {
  if (!values.length || count <= 0) return [];
  if (values.length === count) return values;
  if (count === 1) return [average(values)];
  const result = [];
  for (let index = 0; index < count; index += 1) {
    const position = (index / (count - 1)) * (values.length - 1);
    const left = Math.floor(position);
    const right = Math.min(values.length - 1, left + 1);
    const ratio = position - left;
    result.push(values[left] * (1 - ratio) + values[right] * ratio);
  }
  return result;
}

function alignExternalRows(rows, count, windowMode = "latest") {
  const clean = rows.filter((row) => Number.isFinite(Number(row.value)));
  if (!clean.length || count <= 0) return [];
  if (clean.length < count || windowMode === "resample") {
    const values = resample(clean.map((row) => Number(row.value)), count);
    return values.map((value, index) => {
      const sourceIndex = Math.min(clean.length - 1, Math.round((index / Math.max(1, count - 1)) * (clean.length - 1)));
      return {
        index,
        time: clean[sourceIndex]?.time ?? String(index),
        value,
        source_column: clean[sourceIndex]?.source_column ?? "resampled",
        alignment: "resample",
      };
    });
  }
  if (windowMode === "earliest") {
    return clean.slice(0, count).map((row) => ({ ...row, alignment: "earliest" }));
  }
  const startMatch = /^start:(\d+)$/i.exec(windowMode);
  if (startMatch) {
    const start = Math.max(0, Math.min(Number(startMatch[1]), clean.length - count));
    return clean.slice(start, start + count).map((row) => ({ ...row, alignment: windowMode }));
  }
  return clean.slice(clean.length - count).map((row) => ({ ...row, alignment: "latest" }));
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (inQuotes) {
      if (char === '"' && next === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') inQuotes = true;
    else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  const header = rows.shift() ?? [];
  return rows
    .filter((item) => item.some((fieldValue) => fieldValue !== ""))
    .map((item) => Object.fromEntries(header.map((key, index) => [key, item[index] ?? ""])));
}

function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

async function writeCsv(path, rows) {
  await mkdir(dirname(path), { recursive: true });
  const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const text = [
    headers.join(","),
    ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(",")),
  ].join("\n");
  await writeFile(path, `${text}\n`, "utf8");
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function readCsv(path) {
  return parseCsv(await readFile(path, "utf8"));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function runNode(args, label) {
  return new Promise((resolvePromise, reject) => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const result = {
        label,
        command: `node ${args.join(" ")}`,
        code,
        duration_ms: Date.now() - startedAt,
        stdout,
        stderr,
      };
      if (code !== 0) {
        reject(new Error(`${label} failed with code ${code}\n${stderr || stdout}`));
        return;
      }
      resolvePromise(result);
    });
  });
}

async function fetchJson(url, { token = "", timeoutMs = 30000, headers = {} } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 240)}`);
    }
    return JSON.parse(text);
  } finally {
    clearTimeout(timeout);
  }
}

function altitudeFromMeanMotion(meanMotionRevPerDay) {
  const revPerSecond = meanMotionRevPerDay / 86400;
  const meanMotionRadPerSecond = revPerSecond * 2 * Math.PI;
  const semiMajorAxisKm = (EARTH_MU_KM3_S2 / meanMotionRadPerSecond ** 2) ** (1 / 3);
  return semiMajorAxisKm - EARTH_RADIUS_KM;
}

function externalRecordId(record) {
  return Number(record.NORAD_CAT_ID ?? record.norad_id ?? record.NORAD_ID);
}

function externalAltitude(record) {
  return altitudeFromMeanMotion(Number(record.MEAN_MOTION ?? record.mean_motion));
}

function externalInclination(record) {
  return Number(record.INCLINATION ?? record.inclination);
}

function externalRaan(record) {
  return Number(record.RA_OF_ASC_NODE ?? record.raan);
}

function angularDeltaDeg(left, right) {
  const delta = Math.abs((((left - right + 180) % 360) + 360) % 360 - 180);
  return Number.isFinite(delta) ? delta : Number.NaN;
}

function histogram(values, bins, min = 0, max = 360) {
  const result = Array.from({ length: bins }, () => 0);
  const width = (max - min) / bins;
  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    const normalized = ((value - min) % (max - min) + (max - min)) % (max - min);
    const index = Math.min(bins - 1, Math.floor(normalized / width));
    result[index] += 1;
  }
  return result;
}

function histogramSimilarity(leftCounts, rightCounts) {
  const leftSum = leftCounts.reduce((sum, value) => sum + value, 0) || 1;
  const rightSum = rightCounts.reduce((sum, value) => sum + value, 0) || 1;
  let l1 = 0;
  for (let index = 0; index < Math.max(leftCounts.length, rightCounts.length); index += 1) {
    const left = (leftCounts[index] ?? 0) / leftSum;
    const right = (rightCounts[index] ?? 0) / rightSum;
    l1 += Math.abs(left - right);
  }
  return Math.max(0, 1 - l1 / 2);
}

function groupBy(rows, key) {
  const groups = new Map();
  for (const row of rows) {
    const value = row[key];
    if (!groups.has(value)) groups.set(value, []);
    groups.get(value).push(row);
  }
  return groups;
}

function boolish(value) {
  const text = String(value ?? "").trim().toLowerCase();
  return text === "true" || text === "1" || text === "yes" || text === "up";
}

function degToRad(value) {
  return (value * Math.PI) / 180;
}

function radToDeg(value) {
  return (value * 180) / Math.PI;
}

function geodeticToEcef(latitudeDeg, longitudeDeg, altitudeKm = 0) {
  const latitude = degToRad(latitudeDeg);
  const longitude = degToRad(longitudeDeg);
  const radius = EARTH_RADIUS_KM + altitudeKm;
  return {
    x: radius * Math.cos(latitude) * Math.cos(longitude),
    y: radius * Math.cos(latitude) * Math.sin(longitude),
    z: radius * Math.sin(latitude),
  };
}

function vectorSubtract(left, right) {
  return { x: left.x - right.x, y: left.y - right.y, z: left.z - right.z };
}

function vectorNorm(value) {
  return Math.sqrt(value.x ** 2 + value.y ** 2 + value.z ** 2);
}

function vectorDot(left, right) {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}

function distanceKm(left, right) {
  return vectorNorm(vectorSubtract(left, right));
}

function elevationDeg(observerEcef, targetEcef) {
  const range = vectorSubtract(targetEcef, observerEcef);
  const rangeNorm = vectorNorm(range);
  const observerNorm = vectorNorm(observerEcef);
  if (!rangeNorm || !observerNorm) return Number.NaN;
  const sinElevation = vectorDot(range, observerEcef) / (rangeNorm * observerNorm);
  return radToDeg(Math.asin(Math.max(-1, Math.min(1, sinElevation))));
}

function haversineKm(leftLat, leftLon, rightLat, rightLon) {
  const dLat = degToRad(rightLat - leftLat);
  const dLon = degToRad(rightLon - leftLon);
  const left = degToRad(leftLat);
  const right = degToRad(rightLat);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(left) * Math.cos(right) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(Math.max(0, Math.min(1, a))));
}

function buildSatelliteSlices(nodes) {
  const slices = new Map();
  for (const row of nodes) {
    const sliceIndex = Number(row.slice_index);
    const latitude = numeric(row, "latitude_deg");
    const longitude = numeric(row, "longitude_deg");
    const altitude = numeric(row, "altitude_km");
    if (!Number.isFinite(sliceIndex) || !Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
    if (!slices.has(sliceIndex)) slices.set(sliceIndex, []);
    slices.get(sliceIndex).push({
      id: row.node_id,
      label: row.label ?? row.node_id,
      slice_index: sliceIndex,
      latitude_deg: latitude,
      longitude_deg: longitude,
      altitude_km: Number.isFinite(altitude) ? altitude : 550,
      position: geodeticToEcef(latitude, longitude, Number.isFinite(altitude) ? altitude : 550),
    });
  }
  return slices;
}

function visibleSatelliteCandidates(satellites, observerEcef, minElevationDeg) {
  return satellites
    .map((satellite) => {
      const distance = distanceKm(observerEcef, satellite.position);
      const elevation = elevationDeg(observerEcef, satellite.position);
      return { satellite, distance_km: distance, elevation_deg: elevation };
    })
    .filter((item) => Number.isFinite(item.elevation_deg) && item.elevation_deg >= minElevationDeg)
    .sort((left, right) => left.distance_km - right.distance_km);
}

function buildLinkAdjacencyBySlice(links) {
  const adjacencyBySlice = new Map();
  for (const row of links) {
    if (!boolish(row.is_active) || row.status === "down") continue;
    const sliceIndex = Number(row.slice_index);
    const source = row.source;
    const target = row.target;
    const latencyMs = numeric(row, "latency_ms");
    if (!Number.isFinite(sliceIndex) || !source || !target || !Number.isFinite(latencyMs)) continue;
    if (!adjacencyBySlice.has(sliceIndex)) adjacencyBySlice.set(sliceIndex, new Map());
    const adjacency = adjacencyBySlice.get(sliceIndex);
    if (!adjacency.has(source)) adjacency.set(source, []);
    if (!adjacency.has(target)) adjacency.set(target, []);
    adjacency.get(source).push({ target, latency_ms: latencyMs, link_id: row.link_id });
    adjacency.get(target).push({ target: source, latency_ms: latencyMs, link_id: row.link_id });
  }
  return adjacencyBySlice;
}

function shortestLatencyMs(adjacency, source, target) {
  if (!adjacency || source === target) return source === target ? 0 : Number.NaN;
  const distances = new Map([[source, 0]]);
  const visited = new Set();
  const queue = [{ node: source, distance: 0 }];
  while (queue.length) {
    queue.sort((left, right) => right.distance - left.distance);
    const current = queue.pop();
    if (!current || visited.has(current.node)) continue;
    if (current.node === target) return current.distance;
    visited.add(current.node);
    for (const edge of adjacency.get(current.node) ?? []) {
      if (visited.has(edge.target)) continue;
      const nextDistance = current.distance + edge.latency_ms;
      if (nextDistance < (distances.get(edge.target) ?? Infinity)) {
        distances.set(edge.target, nextDistance);
        queue.push({ node: edge.target, distance: nextDistance });
      }
    }
  }
  return Number.NaN;
}

function sortedGatewayCandidates(latitudeDeg, longitudeDeg) {
  return REGIONAL_GATEWAYS.map((gateway) => ({
    ...gateway,
    distance_to_probe_km: haversineKm(latitudeDeg, longitudeDeg, gateway.latitude_deg, gateway.longitude_deg),
    position: geodeticToEcef(gateway.latitude_deg, gateway.longitude_deg, 0),
  })).sort((left, right) => left.distance_to_probe_km - right.distance_to_probe_km);
}

function simulateUserFacingRttSamples({ nodes, links, ripeResults, config = USER_PING_DEFAULTS }) {
  const satellitesBySlice = buildSatelliteSlices(nodes);
  const adjacencyBySlice = buildLinkAdjacencyBySlice(links);
  const sliceIndexes = [...satellitesBySlice.keys()].sort((left, right) => left - right);
  const ripeOk = ripeResults
    .filter((row) => Number.isFinite(Number(row.avg)))
    .sort((left, right) => Number(left.timestamp ?? 0) - Number(right.timestamp ?? 0));
  if (!sliceIndexes.length) return [];

  const shortestCache = new Map();
  const firstTimestamp = Number(ripeOk[0]?.timestamp ?? 0);
  const stepSeconds = Number(ripeOk.find((row) => Number.isFinite(Number(row.step)))?.step ?? 240);

  return ripeOk.map((row, index) => {
    const probeLatitude = Number(row.probe_latitude_deg);
    const probeLongitude = Number(row.probe_longitude_deg);
    const externalRtt = Number(row.avg);
    const timestamp = Number(row.timestamp ?? firstTimestamp + index * stepSeconds);
    const sliceIndex =
      sliceIndexes[Math.abs(Math.floor((timestamp - firstTimestamp) / Math.max(stepSeconds, 1))) % sliceIndexes.length] ?? sliceIndexes[index % sliceIndexes.length];
    const base = {
      sample_index: index,
      probe_id: row.prb_id ?? row.probe_id,
      probe_country: row.probe_country,
      timestamp,
      slice_index: sliceIndex,
      external_ripe_rtt_ms: round(externalRtt, 4),
    };
    if (!Number.isFinite(probeLatitude) || !Number.isFinite(probeLongitude)) {
      return { ...base, status: "missing-probe-geometry" };
    }

    const satellites = satellitesBySlice.get(sliceIndex) ?? [];
    const userPosition = geodeticToEcef(probeLatitude, probeLongitude, 0);
    const userVisible = visibleSatelliteCandidates(satellites, userPosition, config.minElevationDeg).slice(0, 12);
    if (!userVisible.length) {
      return {
        ...base,
        probe_latitude_deg: round(probeLatitude, 5),
        probe_longitude_deg: round(probeLongitude, 5),
        status: "no-visible-access-satellite",
      };
    }

    const gateways = sortedGatewayCandidates(probeLatitude, probeLongitude).slice(0, 3);
    let best = null;
    const rememberBest = (candidate) => {
      if (!best || candidate.model_user_ping_rtt_ms < best.model_user_ping_rtt_ms) best = candidate;
    };

    for (const userCandidate of userVisible) {
      for (const gateway of gateways) {
        const gatewayElevation = elevationDeg(gateway.position, userCandidate.satellite.position);
        if (!Number.isFinite(gatewayElevation) || gatewayElevation < config.minElevationDeg) continue;
        const gatewayDistance = distanceKm(gateway.position, userCandidate.satellite.position);
        const oneWayMs =
          userCandidate.distance_km / C_KM_PER_MS +
          gatewayDistance / C_KM_PER_MS +
          config.processingOneWayMs +
          config.terrestrialTailOneWayMs;
        rememberBest({
          ...base,
          probe_latitude_deg: round(probeLatitude, 5),
          probe_longitude_deg: round(probeLongitude, 5),
          status: "same-satellite-gateway",
          access_satellite_id: userCandidate.satellite.id,
          gateway_satellite_id: userCandidate.satellite.id,
          gateway_id: gateway.id,
          gateway_label: gateway.label,
          access_elevation_deg: round(userCandidate.elevation_deg, 3),
          gateway_elevation_deg: round(gatewayElevation, 3),
          user_sat_distance_km: round(userCandidate.distance_km, 3),
          gateway_sat_distance_km: round(gatewayDistance, 3),
          isl_latency_one_way_ms: 0,
          model_user_ping_rtt_ms: round(2 * oneWayMs, 4),
        });
      }
    }

    if (!best) {
      const adjacency = adjacencyBySlice.get(sliceIndex);
      for (const userCandidate of userVisible.slice(0, 4)) {
        for (const gateway of gateways.slice(0, 2)) {
          const gatewayVisible = visibleSatelliteCandidates(satellites, gateway.position, config.minElevationDeg).slice(0, 4);
          for (const gatewayCandidate of gatewayVisible) {
            const cacheKey = `${sliceIndex}:${userCandidate.satellite.id}:${gatewayCandidate.satellite.id}`;
            let islLatency = shortestCache.get(cacheKey);
            if (islLatency === undefined) {
              islLatency = shortestLatencyMs(adjacency, userCandidate.satellite.id, gatewayCandidate.satellite.id);
              shortestCache.set(cacheKey, islLatency);
            }
            if (!Number.isFinite(islLatency)) continue;
            const oneWayMs =
              userCandidate.distance_km / C_KM_PER_MS +
              islLatency +
              gatewayCandidate.distance_km / C_KM_PER_MS +
              config.processingOneWayMs +
              config.terrestrialTailOneWayMs;
            rememberBest({
              ...base,
              probe_latitude_deg: round(probeLatitude, 5),
              probe_longitude_deg: round(probeLongitude, 5),
              status: "isl-assisted-gateway",
              access_satellite_id: userCandidate.satellite.id,
              gateway_satellite_id: gatewayCandidate.satellite.id,
              gateway_id: gateway.id,
              gateway_label: gateway.label,
              access_elevation_deg: round(userCandidate.elevation_deg, 3),
              gateway_elevation_deg: round(gatewayCandidate.elevation_deg, 3),
              user_sat_distance_km: round(userCandidate.distance_km, 3),
              gateway_sat_distance_km: round(gatewayCandidate.distance_km, 3),
              isl_latency_one_way_ms: round(islLatency, 4),
              model_user_ping_rtt_ms: round(2 * oneWayMs, 4),
            });
          }
        }
      }
    }

    return (
      best ?? {
        ...base,
        probe_latitude_deg: round(probeLatitude, 5),
        probe_longitude_deg: round(probeLongitude, 5),
        status: "no-gateway-route",
      }
    );
  });
}

function buildSourceStatus(name, url, status, detail, localPath = "") {
  return { name, url, status, detail, local_path: localPath };
}

async function loadExternalTle({ outDir, explicitPath, noLive }) {
  const url = "https://celestrak.org/NORAD/elements/gp.php?NAME=STARLINK&FORMAT=JSON";
  const sourcePath = join(outDir, "external", "celestrak-starlink-live.json");
  await mkdir(dirname(sourcePath), { recursive: true });
  if (explicitPath) {
    const data = await readJson(explicitPath);
    return {
      records: Array.isArray(data) ? data : data.satellites ?? [],
      status: buildSourceStatus("CelesTrak Starlink GP/TLE", explicitPath, "provided-file", "使用用户提供的外部 TLE/GP 文件。", rel(explicitPath)),
    };
  }
  if (!noLive) {
    try {
      const data = await fetchJson(url, { timeoutMs: 45000 });
      await writeFile(sourcePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
      return {
        records: data,
        status: buildSourceStatus("CelesTrak Starlink GP/TLE", url, "live-ok", `实时获取 ${data.length} 条 Starlink GP 记录。`, rel(sourcePath)),
      };
    } catch (error) {
      const fallback = resolve("data/tle-snapshots/celestrak-starlink-raw-gp.json");
      if (existsSync(fallback)) {
        const data = await readJson(fallback);
        return {
          records: Array.isArray(data) ? data : data.records ?? data.satellites ?? [],
          status: buildSourceStatus(
            "CelesTrak Starlink GP/TLE",
            url,
            "live-fallback-cache",
            `实时获取失败，使用本地缓存公开快照。错误：${error.message}`,
            rel(fallback),
          ),
        };
      }
      return {
        records: [],
        status: buildSourceStatus("CelesTrak Starlink GP/TLE", url, "failed", error.message),
      };
    }
  }
  return {
    records: [],
    status: buildSourceStatus("CelesTrak Starlink GP/TLE", url, "skipped", "用户跳过实时外部 TLE 获取。"),
  };
}

async function loadRipeAtlas({ outDir, skip, measurementId, maxProbes, hours }) {
  const probeUrl = "https://atlas.ripe.net/api/v2/probes/?asn_v4=14593&status=1&page_size=500";
  const sourceDir = join(outDir, "external", "ripe-atlas");
  await mkdir(sourceDir, { recursive: true });
  if (skip) {
    return {
      probes: [],
      results: [],
      status: buildSourceStatus("RIPE Atlas AS14593 probes", probeUrl, "skipped", "用户跳过 RIPE Atlas 外部测量。"),
    };
  }
  try {
    const probesPayload = await fetchJson(probeUrl, { timeoutMs: 30000 });
    await writeFile(join(sourceDir, "probes-as14593.json"), `${JSON.stringify(probesPayload, null, 2)}\n`, "utf8");
    const probes = probesPayload.results ?? [];
    const publicProbes = probes.filter((probe) => probe.is_public && probe.status?.id === 1).slice(0, maxProbes);
    const stop = Math.floor(Date.now() / 1000);
    const start = stop - hours * 3600;
    const results = [];
    for (const probe of publicProbes) {
      const url = `https://atlas.ripe.net/api/v2/measurements/${measurementId}/results/?probe_ids=${probe.id}&start=${start}&stop=${stop}`;
      const [probeLongitude, probeLatitude] = Array.isArray(probe.geometry?.coordinates) ? probe.geometry.coordinates : [];
      try {
        const probeResults = await fetchJson(url, { timeoutMs: 20000 });
        results.push(
          ...probeResults.map((item) => ({
            ...item,
            probe_country: probe.country_code,
            probe_id: probe.id,
            probe_latitude_deg: probeLatitude,
            probe_longitude_deg: probeLongitude,
          })),
        );
      } catch (error) {
        results.push({
          probe_id: probe.id,
          probe_country: probe.country_code,
          probe_latitude_deg: probeLatitude,
          probe_longitude_deg: probeLongitude,
          error: error.message,
        });
      }
    }
    await writeFile(join(sourceDir, `measurement-${measurementId}-results.json`), `${JSON.stringify(results, null, 2)}\n`, "utf8");
    const okResults = results.filter((item) => Number.isFinite(Number(item.avg)));
    return {
      probes,
      results,
      status: buildSourceStatus(
        "RIPE Atlas AS14593 probes",
        probeUrl,
        okResults.length ? "live-ok" : "partial",
        `在线 Starlink 探针 ${probesPayload.count ?? probes.length} 个，抽样公开探针 ${publicProbes.length} 个，获得 ping 结果 ${okResults.length} 条。`,
        rel(sourceDir),
      ),
    };
  } catch (error) {
    return {
      probes: [],
      results: [],
      status: buildSourceStatus("RIPE Atlas AS14593 probes", probeUrl, "failed", error.message),
    };
  }
}

function parseRadarCsv(rows) {
  if (!rows.length) return [];
  const headers = Object.keys(rows[0]);
  const valueHeader =
    headers.find((key) => /value|requests|traffic|bytes|normalized|http/i.test(key)) ??
    headers.find((key) => rows.some((row) => Number.isFinite(Number(row[key]))));
  const timeHeader = headers.find((key) => /time|date|timestamp/i.test(key)) ?? headers[0];
  if (!valueHeader) return [];
  return rows
    .map((row, index) => ({
      index,
      time: row[timeHeader] ?? String(index),
      value: Number(row[valueHeader]),
      source_column: valueHeader,
    }))
    .filter((row) => Number.isFinite(row.value));
}

function extractNumericSeriesFromRadarPayload(payload) {
  const candidates = [];
  function visit(value, path = []) {
    if (Array.isArray(value)) {
      const numericRows = value
        .map((item, index) => {
          if (typeof item === "number") return { index, value: item, time: String(index) };
          if (item && typeof item === "object") {
            const keys = Object.keys(item);
            const valueKey = keys.find((key) => /value|requests|traffic|bytes|count/i.test(key));
            const timeKey = keys.find((key) => /time|date|timestamp/i.test(key));
            if (valueKey && Number.isFinite(Number(item[valueKey]))) {
              return { index, value: Number(item[valueKey]), time: item[timeKey] ?? String(index) };
            }
          }
          return null;
        })
        .filter(Boolean);
      if (numericRows.length >= 4) candidates.push({ path: path.join("."), rows: numericRows });
      value.forEach((item, index) => visit(item, [...path, String(index)]));
    } else if (value && typeof value === "object") {
      if (Array.isArray(value.timestamps) && Array.isArray(value.values)) {
        const numericRows = value.values
          .map((entry, index) => ({
            index,
            value: Number(entry),
            time: value.timestamps[index] ?? String(index),
          }))
          .filter((row) => Number.isFinite(row.value));
        if (numericRows.length >= 4) candidates.push({ path: path.join("."), rows: numericRows });
      }
      for (const [key, child] of Object.entries(value)) visit(child, [...path, key]);
    }
  }
  visit(payload);
  candidates.sort((a, b) => b.rows.length - a.rows.length);
  return candidates[0]?.rows ?? [];
}

async function loadCloudflareRadar({ outDir, radarCsvPath, radarJsonPath, token, dateRange }) {
  const sourceDir = join(outDir, "external", "cloudflare-radar");
  await mkdir(sourceDir, { recursive: true });
  if (radarCsvPath) {
    try {
      const rows = await readCsv(radarCsvPath);
      const series = parseRadarCsv(rows);
      return {
        series,
        status: buildSourceStatus("Cloudflare Radar AS14593 traffic", radarCsvPath, series.length ? "provided-file" : "failed", `读取用户提供 Radar CSV，解析 ${series.length} 个数值点。`, rel(radarCsvPath)),
      };
    } catch (error) {
      return {
        series: [],
        status: buildSourceStatus("Cloudflare Radar AS14593 traffic", radarCsvPath, "failed", error.message),
      };
    }
  }
  if (radarJsonPath) {
    try {
      const payload = await readJson(radarJsonPath);
      const series = extractNumericSeriesFromRadarPayload(payload);
      return {
        series,
        status: buildSourceStatus(
          "Cloudflare Radar AS14593 traffic",
          radarJsonPath,
          series.length ? "provided-json" : "failed",
          `读取用户提供 Radar JSON，解析 ${series.length} 个数值点。`,
          rel(radarJsonPath),
        ),
      };
    } catch (error) {
      return {
        series: [],
        status: buildSourceStatus("Cloudflare Radar AS14593 traffic", radarJsonPath, "failed", error.message),
      };
    }
  }
  const docsUrl = "https://developers.cloudflare.com/radar/get-started/first-request/";
  if (!token) {
    return {
      series: [],
      status: buildSourceStatus(
        "Cloudflare Radar AS14593 traffic",
        "https://radar.cloudflare.com/traffic/as14593",
        "missing-token-or-csv",
        "未设置 CLOUDFLARE_API_TOKEN，也未提供 --radar-csv；业务流量暂不能完成强外部数值对照。",
      ),
      docsUrl,
    };
  }
  const candidates = [
    `https://api.cloudflare.com/client/v4/radar/http/timeseries_groups?asn=14593&dateRange=${encodeURIComponent(dateRange)}`,
    `https://api.cloudflare.com/client/v4/radar/http/timeseries?asn=14593&dateRange=${encodeURIComponent(dateRange)}`,
  ];
  const errors = [];
  for (const url of candidates) {
    try {
      const payload = await fetchJson(url, { token, timeoutMs: 30000 });
      await writeFile(join(sourceDir, "radar-as14593-traffic.json"), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      const series = extractNumericSeriesFromRadarPayload(payload);
      return {
        series,
        status: buildSourceStatus("Cloudflare Radar AS14593 traffic", url, series.length ? "live-ok" : "partial", `Radar API 返回成功，解析 ${series.length} 个数值点。`, rel(sourceDir)),
      };
    } catch (error) {
      errors.push(`${url}: ${error.message}`);
    }
  }
  return {
    series: [],
    status: buildSourceStatus("Cloudflare Radar AS14593 traffic", candidates[0], "failed", errors.join(" | ")),
  };
}

function analyzeOrbitExternal({ snapshot, nodes, externalRecords }) {
  const externalByNorad = new Map(externalRecords.map((record) => [externalRecordId(record), record]));
  const nodeRowsById = groupBy(nodes, "node_id");
  const rows = [];
  for (const satellite of snapshot.satellites ?? []) {
    const external = externalByNorad.get(Number(satellite.norad_id));
    if (!external) continue;
    const modelNodeAltitudes = (nodeRowsById.get(satellite.satellite_id) ?? []).map((row) => numeric(row, "altitude_km"));
    const externalAlt = externalAltitude(external);
    rows.push({
      satellite_id: satellite.satellite_id,
      norad_id: satellite.norad_id,
      satellite_name: satellite.satellite_name,
      model_snapshot_altitude_km: round(altitudeFromMeanMotion(Number(satellite.mean_motion)), 4),
      model_output_mean_altitude_km: round(average(modelNodeAltitudes), 4),
      external_altitude_km: round(externalAlt, 4),
      altitude_abs_error_km: round(Math.abs(average(modelNodeAltitudes) - externalAlt), 4),
      snapshot_inclination_deg: satellite.inclination,
      external_inclination_deg: externalInclination(external),
      inclination_abs_error_deg: round(Math.abs(Number(satellite.inclination) - externalInclination(external)), 6),
      snapshot_mean_motion_rev_day: satellite.mean_motion,
      external_mean_motion_rev_day: Number(external.MEAN_MOTION),
      mean_motion_abs_error: round(Math.abs(Number(satellite.mean_motion) - Number(external.MEAN_MOTION)), 8),
      snapshot_raan_deg: satellite.raan,
      external_raan_deg: externalRaan(external),
      raan_abs_error_deg: round(angularDeltaDeg(Number(satellite.raan), externalRaan(external)), 5),
      external_epoch: external.EPOCH,
    });
  }
  const altitudePairs = rows.map((row) => [Number(row.model_output_mean_altitude_km), Number(row.external_altitude_km)]);
  const inclinationPairs = rows.map((row) => [Number(row.snapshot_inclination_deg), Number(row.external_inclination_deg)]);
  const meanMotionPairs = rows.map((row) => [Number(row.snapshot_mean_motion_rev_day), Number(row.external_mean_motion_rev_day)]);
  return {
    rows,
    summary: {
      selected_satellites: snapshot.satellites?.length ?? 0,
      external_catalog_records: externalRecords.length,
      matched_satellites: rows.length,
      match_ratio: round(rows.length / Math.max(snapshot.satellites?.length ?? 0, 1), 4),
      output_altitude_mae_km: round(mae(altitudePairs), 4),
      output_altitude_corr: round(correlation(altitudePairs), 4),
      inclination_mae_deg: round(mae(inclinationPairs), 6),
      mean_motion_mae_rev_day: round(mae(meanMotionPairs), 8),
      raan_mae_deg: round(average(rows.map((row) => Number(row.raan_abs_error_deg))), 4),
    },
  };
}

function analyzeConstellationExternal({ snapshot, externalRecords, altitudeToleranceKm }) {
  const targetInclination = Number(snapshot.layout?.target_inclination_deg ?? snapshot.mean_inclination_deg ?? 53);
  const targetAltitude = Number(snapshot.layout?.target_altitude_km ?? snapshot.mean_altitude_km ?? 550);
  const shell = externalRecords.filter((record) => {
    const inclination = externalInclination(record);
    const altitude = externalAltitude(record);
    return Math.abs(inclination - targetInclination) <= 1.5 && Math.abs(altitude - targetAltitude) <= altitudeToleranceKm;
  });
  const selected = snapshot.satellites ?? [];
  const bins = Number(snapshot.layout?.planes ?? 47);
  const selectedHist = histogram(selected.map((satellite) => Number(satellite.raan)), bins);
  const externalHist = histogram(shell.map(externalRaan), bins);
  const distributionRows = selectedHist.map((count, index) => ({
    bin: index,
    raan_start_deg: round((360 / bins) * index, 3),
    raan_end_deg: round((360 / bins) * (index + 1), 3),
    model_selected_count: count,
    external_shell_count: externalHist[index] ?? 0,
  }));
  return {
    rows: distributionRows,
    summary: {
      target_inclination_deg: targetInclination,
      target_altitude_km: targetAltitude,
      shell_altitude_tolerance_km: altitudeToleranceKm,
      external_catalog_records: externalRecords.length,
      external_target_shell_count: shell.length,
      model_selected_count: selected.length,
      scale_coverage_ratio: round(selected.length / Math.max(shell.length, 1), 4),
      model_planes: snapshot.layout?.planes ?? null,
      model_satellites_per_plane: snapshot.layout?.satellites_per_plane ?? null,
      external_shell_mean_altitude_km: round(average(shell.map(externalAltitude)), 4),
      external_shell_mean_inclination_deg: round(average(shell.map(externalInclination)), 5),
      model_mean_altitude_km: round(Number(snapshot.mean_altitude_km), 4),
      model_mean_inclination_deg: round(Number(snapshot.mean_inclination_deg), 5),
      raan_distribution_similarity: round(histogramSimilarity(selectedHist, externalHist), 4),
    },
  };
}

function analyzeTrafficExternal({ tasks, radarSeries, calibrationProfile, slices, radarWindow = "latest" }) {
  const sliceCount = Math.max(
    slices,
    calibrationProfile.time_series?.length ?? 0,
    ...tasks.map((row) => numeric(row, "start_slice", numeric(row, "slice_index", 0)) + numeric(row, "duration_slices", 1)),
  );
  const modelRows = Array.from({ length: sliceCount }, (_, slice) => ({
    slice_index: slice,
    model_total_traffic_mbps: 0,
    model_task_count: 0,
  }));
  for (const task of tasks) {
    const startSlice = numeric(task, "start_slice", numeric(task, "slice_index", 0));
    const duration = Math.max(1, Math.round(numeric(task, "duration_slices", 1)));
    const traffic = numeric(task, "traffic_mbps", 0);
    for (let offset = 0; offset < duration; offset += 1) {
      const slice = startSlice + offset;
      if (slice < 0 || slice >= modelRows.length) continue;
      modelRows[slice].model_total_traffic_mbps += traffic;
      modelRows[slice].model_task_count += 1;
    }
  }
  for (const row of modelRows) row.model_total_traffic_mbps = round(row.model_total_traffic_mbps, 4);
  const modelValues = modelRows.map((row) => Number(row.model_total_traffic_mbps));
  const modelNorm = normalize(modelValues);
  const calibrationWeights = (calibrationProfile.time_series ?? []).map((row) => Number(row.traffic_weight));
  const calibrationNorm = normalize(resample(calibrationWeights, modelRows.length));
  const alignedRadarRows = alignExternalRows(radarSeries, modelRows.length, radarWindow);
  const radarValues = alignedRadarRows.map((row) => Number(row.value));
  const radarNorm = normalize(radarValues);
  const rows = modelRows.map((row, index) => ({
    ...row,
    model_normalized: round(modelNorm[index], 4),
    calibration_template_normalized: round(calibrationNorm[index], 4),
    external_radar_time: alignedRadarRows[index]?.time ?? "",
    external_radar_value: alignedRadarRows[index] ? round(Number(alignedRadarRows[index].value), 6) : "",
    external_radar_normalized: radarNorm.length ? round(radarNorm[index], 4) : "",
  }));
  const externalPairs = radarNorm.length ? modelNorm.map((value, index) => [value, radarNorm[index]]) : [];
  const calibrationPairs = calibrationNorm.length ? modelNorm.map((value, index) => [value, calibrationNorm[index]]) : [];
  return {
    rows,
    summary: {
      model_slices: modelRows.length,
      model_total_tasks: tasks.length,
      model_total_traffic_mbps_sum: round(modelValues.reduce((sum, value) => sum + value, 0), 4),
      external_radar_points: radarSeries.length,
      external_radar_aligned_points: alignedRadarRows.length,
      external_radar_alignment_method: alignedRadarRows[0]?.alignment ?? "none",
      external_radar_first_time: alignedRadarRows[0]?.time ?? null,
      external_radar_last_time: alignedRadarRows.at(-1)?.time ?? null,
      external_validation_status: radarSeries.length ? "computed" : "missing-external-radar-series",
      model_vs_external_radar_corr: round(correlation(externalPairs), 4),
      model_vs_external_radar_mae_normalized: round(mae(externalPairs), 4),
      model_vs_calibration_template_corr: round(correlation(calibrationPairs), 4),
      model_vs_calibration_template_mae_normalized: round(mae(calibrationPairs), 4),
      metric_scope:
        "Shape-only comparison after normalization: Cloudflare Radar AS14593 aggregate traffic index versus model task Mbps per slice.",
      note: radarSeries.length
        ? "业务流量已使用外部 Radar 数值序列对照。"
        : "未获得 Cloudflare Radar 数值序列；只展示模型曲线与本地校准模板的一致性，不把它计为强外部真实性证据。",
    },
  };
}

function analyzeNetworkPerformanceExternal({ nodes, links, routes, ripeResults, userPingConfig = USER_PING_DEFAULTS }) {
  const routed = routes.filter((row) => row.status === "routed");
  const allDelivery = routes.map((row) => numeric(row, "delivery_ratio", row.status === "routed" ? 1 : 0));
  const modelRouteLatency = routed.map((row) => numeric(row, "route_latency_ms"));
  const modelEstimatedLatency = routed.map((row) => numeric(row, "estimated_end_to_end_latency_ms"));
  const ripeOk = ripeResults.filter((row) => Number.isFinite(Number(row.avg)));
  const ripeRtt = ripeOk.map((row) => Number(row.avg));
  const ripeLoss = ripeOk.map((row) => {
    const sent = Number(row.sent);
    const received = Number(row.rcvd);
    return Number.isFinite(sent) && sent > 0 && Number.isFinite(received) ? (sent - received) / sent : Number.NaN;
  });
  const userPingRows = simulateUserFacingRttSamples({ nodes, links, ripeResults, config: userPingConfig });
  const userPingOk = userPingRows.filter((row) => Number.isFinite(Number(row.model_user_ping_rtt_ms)));
  const userPingRtt = userPingOk.map((row) => Number(row.model_user_ping_rtt_ms));
  const modelP50 = percentile(modelRouteLatency, 0.5);
  const externalP50 = percentile(ripeRtt, 0.5);
  const userP50 = percentile(userPingRtt, 0.5);
  const userUnavailableRatio = userPingRows.length ? 1 - userPingOk.length / userPingRows.length : Number.NaN;
  return {
    user_ping_rows: userPingRows,
    rows: [
      {
        metric: "p50_latency_ms",
        model_user_ping_rtt: round(userP50, 4),
        external_ripe_atlas_rtt: round(externalP50, 4),
        model_route_latency: round(modelP50, 4),
        model_estimated_latency: round(percentile(modelEstimatedLatency, 0.5), 4),
      },
      {
        metric: "p95_latency_ms",
        model_user_ping_rtt: round(percentile(userPingRtt, 0.95), 4),
        external_ripe_atlas_rtt: round(percentile(ripeRtt, 0.95), 4),
        model_route_latency: round(percentile(modelRouteLatency, 0.95), 4),
        model_estimated_latency: round(percentile(modelEstimatedLatency, 0.95), 4),
      },
      {
        metric: "mean_latency_ms",
        model_user_ping_rtt: round(average(userPingRtt), 4),
        external_ripe_atlas_rtt: round(average(ripeRtt), 4),
        model_route_latency: round(average(modelRouteLatency), 4),
        model_estimated_latency: round(average(modelEstimatedLatency), 4),
      },
      {
        metric: "loss_or_unavailable_ratio",
        model_user_ping_rtt: round(userUnavailableRatio, 4),
        external_ripe_atlas_rtt: round(average(ripeLoss), 6),
        model_route_latency: round(1 - average(allDelivery), 4),
        model_estimated_latency: "",
      },
    ],
    summary: {
      model_route_samples: routed.length,
      model_all_task_samples: routes.length,
      model_user_ping_samples: userPingOk.length,
      model_user_ping_total_samples: userPingRows.length,
      external_ripe_ping_samples: ripeOk.length,
      external_probe_count: new Set(ripeOk.map((row) => row.prb_id ?? row.probe_id)).size,
      model_user_ping_p50_ms: round(userP50, 4),
      model_user_ping_p95_ms: round(percentile(userPingRtt, 0.95), 4),
      model_user_ping_mean_ms: round(average(userPingRtt), 4),
      model_user_ping_unavailable_ratio: round(userUnavailableRatio, 4),
      model_user_ping_min_elevation_deg: userPingConfig.minElevationDeg,
      model_user_ping_processing_one_way_ms: userPingConfig.processingOneWayMs,
      model_user_ping_terrestrial_tail_one_way_ms: userPingConfig.terrestrialTailOneWayMs,
      model_user_ping_gateway_count: REGIONAL_GATEWAYS.length,
      model_route_latency_p50_ms: round(modelP50, 4),
      model_route_latency_p95_ms: round(percentile(modelRouteLatency, 0.95), 4),
      model_estimated_latency_p50_ms: round(percentile(modelEstimatedLatency, 0.5), 4),
      model_estimated_latency_p95_ms: round(percentile(modelEstimatedLatency, 0.95), 4),
      external_ripe_rtt_p50_ms: round(externalP50, 4),
      external_ripe_rtt_p95_ms: round(percentile(ripeRtt, 0.95), 4),
      model_user_ping_to_ripe_p50_latency_ratio: round(userP50 / externalP50, 4),
      model_to_ripe_p50_latency_ratio: round(modelP50 / externalP50, 4),
      model_mean_delivery_ratio: round(average(allDelivery), 4),
      external_ripe_mean_packet_loss: round(average(ripeLoss), 6),
      comparison_scope:
        "RIPE Atlas 是 Starlink 用户接入侧到公共目标的端到端 ping；本报告优先用用户-卫星-区域网关的模型 RTT 与其对照。模型内部任务路由时延仍保留为星座压力指标，但不再作为 RIPE RTT 的直接判定口径。",
    },
  };
}

function evidenceLevel(report) {
  const orbit = report.orbit_external.summary;
  const constellation = report.constellation_external.summary;
  const traffic = report.traffic_external.summary;
  const network = report.network_performance_external.summary;
  return [
    {
      item: "轨道真实性",
      status: orbit.matched_satellites > 0 && orbit.output_altitude_mae_km <= 30 ? "外部强支撑" : "需要补强",
      reason: `匹配 ${orbit.matched_satellites} 颗卫星，高度 MAE ${orbit.output_altitude_mae_km} km，倾角 MAE ${orbit.inclination_mae_deg} deg。`,
    },
    {
      item: "星座规模和壳层",
      status: constellation.scale_coverage_ratio >= 0.9 ? "规模接近" : "部分支撑",
      reason: `模型选取 ${constellation.model_selected_count} 颗，外部目标壳层约 ${constellation.external_target_shell_count} 颗，覆盖比 ${constellation.scale_coverage_ratio}。`,
    },
    {
      item: "业务流量真实性",
      status: traffic.external_radar_points > 0 ? "外部可计算" : "外部数值证据缺失",
      reason: traffic.note,
    },
    {
      item: "网络性能真实性",
      status:
        network.external_ripe_ping_samples > 0 && network.model_to_ripe_p50_latency_ratio >= 0.5 && network.model_to_ripe_p50_latency_ratio <= 3
          ? "量级接近"
          : "存在明显偏差或证据不足",
      reason: `模型 P50 路由时延 ${network.model_route_latency_p50_ms} ms，RIPE Atlas P50 RTT ${network.external_ripe_rtt_p50_ms} ms，比例 ${network.model_to_ripe_p50_latency_ratio}。`,
    },
  ];
}

function svgBars(rows, keys, { width = 900, height = 260, title = "" } = {}) {
  const margin = { left: 64, right: 24, top: 34, bottom: 52 };
  const values = rows.flatMap((row) => keys.map((key) => finiteNumber(row[key.id]))).filter(Number.isFinite);
  const maxValue = Math.max(...values, 1);
  const groupWidth = (width - margin.left - margin.right) / Math.max(rows.length, 1);
  const barWidth = Math.max(4, groupWidth / (keys.length + 1));
  const y = (value) => height - margin.bottom - (value / maxValue) * (height - margin.top - margin.bottom);
  const bars = rows
    .map((row, rowIndex) =>
      keys
        .map((key, keyIndex) => {
          const value = finiteNumber(row[key.id]);
          if (!Number.isFinite(value)) return "";
          const x = margin.left + rowIndex * groupWidth + keyIndex * barWidth + barWidth * 0.4;
          const yy = y(value);
          return `<rect x="${round(x, 2)}" y="${round(yy, 2)}" width="${round(barWidth * 0.82, 2)}" height="${round(height - margin.bottom - yy, 2)}" fill="${key.color}"><title>${escapeHtml(row.label ?? row.metric ?? row.bin)} ${key.label}: ${round(value, 4)}</title></rect>`;
        })
        .join(""),
    )
    .join("");
  const labels = rows
    .map((row, index) => {
      const x = margin.left + index * groupWidth + groupWidth * 0.1;
      return `<text x="${round(x, 2)}" y="${height - 24}" class="tick">${escapeHtml(row.label ?? row.metric ?? row.bin)}</text>`;
    })
    .join("");
  const legend = keys
    .map((key, index) => `<g transform="translate(${margin.left + index * 170},${height - 8})"><rect width="10" height="10" rx="2" fill="${key.color}"/><text x="16" y="9" class="tick">${escapeHtml(key.label)}</text></g>`)
    .join("");
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(title)}">
    <text x="${margin.left}" y="22" class="chart-title">${escapeHtml(title)}</text>
    <line x1="${margin.left}" y1="${height - margin.bottom}" x2="${width - margin.right}" y2="${height - margin.bottom}" class="axis"/>
    ${bars}
    ${labels}
    ${legend}
  </svg>`;
}

function svgLine(rows, keys, { width = 900, height = 260, title = "" } = {}) {
  const margin = { left: 54, right: 24, top: 34, bottom: 42 };
  const values = rows.flatMap((row) => keys.map((key) => finiteNumber(row[key.id]))).filter(Number.isFinite);
  const minValue = Math.min(...values, 0);
  const maxValue = Math.max(...values, 1);
  const spanY = Math.max(maxValue - minValue, 1e-9);
  const spanX = Math.max(rows.length - 1, 1);
  const x = (index) => margin.left + (index / spanX) * (width - margin.left - margin.right);
  const y = (value) => height - margin.bottom - ((value - minValue) / spanY) * (height - margin.top - margin.bottom);
  const paths = keys
    .map((key) => {
      const points = rows
        .map((row, index) => [index, finiteNumber(row[key.id])])
        .filter(([, value]) => Number.isFinite(value))
        .map(([index, value]) => `${round(x(index), 2)},${round(y(value), 2)}`)
        .join(" ");
      return `<polyline points="${points}" fill="none" stroke="${key.color}" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>`;
    })
    .join("");
  const legend = keys
    .map((key, index) => `<g transform="translate(${margin.left + index * 190},${height - 12})"><rect width="10" height="10" rx="2" fill="${key.color}"/><text x="16" y="9" class="tick">${escapeHtml(key.label)}</text></g>`)
    .join("");
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(title)}">
    <text x="${margin.left}" y="22" class="chart-title">${escapeHtml(title)}</text>
    <line x1="${margin.left}" y1="${height - margin.bottom}" x2="${width - margin.right}" y2="${height - margin.bottom}" class="axis"/>
    <line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${height - margin.bottom}" class="axis"/>
    ${paths}
    ${legend}
  </svg>`;
}

function table(rows, limit = 20) {
  const sample = rows.slice(0, limit);
  const headers = [...new Set(sample.flatMap((row) => Object.keys(row)))];
  return `<table><thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("")}</tr></thead><tbody>${sample
    .map((row) => `<tr>${headers.map((header) => `<td>${escapeHtml(row[header])}</td>`).join("")}</tr>`)
    .join("")}</tbody></table>`;
}

function htmlReport(report) {
  const cards = [
    ["外部轨道匹配", `${report.orbit_external.summary.matched_satellites}/${report.orbit_external.summary.selected_satellites}`, `高度 MAE ${report.orbit_external.summary.output_altitude_mae_km} km`],
    ["外部壳层覆盖", `${round(report.constellation_external.summary.scale_coverage_ratio * 100, 1)}%`, `${report.constellation_external.summary.model_selected_count}/${report.constellation_external.summary.external_target_shell_count} 颗`],
    ["Radar 数值点", String(report.traffic_external.summary.external_radar_points), report.traffic_external.summary.external_validation_status],
    [
      "用户侧 RTT 对照",
      `${report.network_performance_external.summary.model_user_ping_samples}/${report.network_performance_external.summary.external_ripe_ping_samples} 条`,
      `模型 P50 ${report.network_performance_external.summary.model_user_ping_p50_ms} ms / RIPE P50 ${report.network_performance_external.summary.external_ripe_rtt_p50_ms} ms`,
    ],
  ]
    .map(([title, value, note]) => `<section class="card"><span>${escapeHtml(title)}</span><strong>${escapeHtml(value)}</strong><em>${escapeHtml(note)}</em></section>`)
    .join("");
  const evidenceRows = report.evidence.map(
    (item) => `<tr><td>${escapeHtml(item.item)}</td><td>${escapeHtml(item.status)}</td><td>${escapeHtml(item.reason)}</td></tr>`,
  );
  const sourceRows = report.external_sources.map(
    (item) => `<tr><td>${escapeHtml(item.name)}</td><td><a href="${escapeHtml(item.url)}">${escapeHtml(item.url)}</a></td><td>${escapeHtml(item.status)}</td><td>${escapeHtml(item.detail)}</td></tr>`,
  );
  const constellationChartRows = [
    {
      label: "卫星数",
      model: report.constellation_external.summary.model_selected_count,
      external: report.constellation_external.summary.external_target_shell_count,
    },
    {
      label: "平均高度",
      model: report.constellation_external.summary.model_mean_altitude_km,
      external: report.constellation_external.summary.external_shell_mean_altitude_km,
    },
    {
      label: "平均倾角",
      model: report.constellation_external.summary.model_mean_inclination_deg,
      external: report.constellation_external.summary.external_shell_mean_inclination_deg,
    },
  ];
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>实验1：基于外部公开数据的卫星网络仿真真实性验证</title>
  <script>
    window.MathJax = { tex: { inlineMath: [["\\\\(", "\\\\)"]], displayMath: [["\\\\[", "\\\\]"]] }, svg: { fontCache: "global" } };
  </script>
  <script defer src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-svg.js"></script>
  <style>
    :root { color-scheme: light; --ink:#172033; --muted:#667085; --line:#d9e2ef; --bg:#f5f7fb; --panel:#fff; --blue:#2563eb; --green:#16835f; --orange:#c76b0a; --red:#b42318; }
    * { box-sizing:border-box; }
    body { margin:0; background:var(--bg); color:var(--ink); font-family:"Microsoft YaHei","Segoe UI",Arial,sans-serif; line-height:1.55; }
    header { background:#111827; color:#f8fafc; padding:34px 42px 70px; }
    header h1 { margin:0 0 8px; font-size:30px; letter-spacing:0; }
    header p { margin:0; max-width:1100px; color:#cbd5e1; }
    main { max-width:1280px; margin:0 auto; padding:0 42px 48px; }
    .cards { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:14px; margin-top:-42px; }
    .card,.panel { background:var(--panel); border:1px solid var(--line); border-radius:8px; box-shadow:0 8px 22px rgba(15,23,42,.07); }
    .card { padding:16px; }
    .card span,.card em,.note { color:var(--muted); font-size:13px; }
    .card strong { display:block; margin:4px 0; font-size:24px; }
    .card em { display:block; font-style:normal; }
    .panel { padding:18px; margin:16px 0; overflow:auto; }
    h2 { font-size:21px; margin:4px 0 12px; }
    h3 { font-size:16px; margin:18px 0 8px; }
    table { width:100%; border-collapse:collapse; font-size:13px; }
    th,td { border-bottom:1px solid var(--line); padding:9px 10px; text-align:left; vertical-align:top; }
    th { background:#f8fafc; color:#344054; }
    code { background:#eef4ff; padding:2px 5px; border-radius:4px; }
    pre { background:#0f172a; color:#e2e8f0; padding:12px; border-radius:8px; overflow:auto; }
    .grid2 { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
    .math-block { margin:10px 0; padding:12px; background:#fff; border:1px solid var(--line); border-radius:8px; overflow-x:auto; }
    svg { width:100%; height:auto; display:block; }
    .axis { stroke:#8aa0b7; stroke-width:1.1; }
    .tick { fill:#526174; font-size:11px; }
    .chart-title { fill:#172033; font-size:15px; font-weight:700; }
    a { color:var(--blue); }
    @media (max-width:900px) { main { padding:0 18px 32px; } header { padding:28px 18px 68px; } .cards,.grid2 { grid-template-columns:1fr; } }
  </style>
</head>
<body>
  <header>
    <h1>实验1：基于外部公开数据的卫星网络仿真真实性验证</h1>
    <p>本实验不再用内部约束自证模型真实性，而是把模型输出与 CelesTrak 公开 Starlink GP/TLE、Cloudflare Radar AS14593 业务数据入口、RIPE Atlas Starlink 探针公开测量进行对照。结果好坏都如实展示。</p>
  </header>
  <main>
    <div class="cards">${cards}</div>
    <section class="panel">
      <h2>结论概览</h2>
      <table><thead><tr><th>子实验</th><th>外部证据状态</th><th>解释</th></tr></thead><tbody>${evidenceRows.join("")}</tbody></table>
      <p class="note">注意：公开数据无法提供 Starlink 内部逐星 CPU、电池、队列、ISL 真实状态。本实验验证的是模型输出与外部可观测数据之间的吻合程度和边界。</p>
    </section>
    <section class="panel">
      <h2>实验原理与数学对照</h2>
      <div class="math-block">\\[
      h=\left(\\frac{\\mu}{n_{rad/s}^{2}}\\right)^{1/3}-R_E,
      \\quad
      MAE_h=\\frac{1}{N}\\sum_i |h_i^{sim}-h_i^{ext}|
      \\]</div>
      <div class="math-block">\\[
      J_{hist}=1-\\frac{1}{2}\\sum_b\\left|p_b^{sim}-p_b^{ext}\\right|,
      \\quad
      \\rho=\\frac{cov(X_{sim},X_{ext})}{\\sigma_{sim}\\sigma_{ext}}
      \\]</div>
      <div class="math-block">\\[
      RTT_{user}^{sim}=2\\left(\\frac{d_{user,sat}}{c}+\\frac{d_{sat,gateway}}{c}+\\tau_{proc}+\\tau_{terr}\\right)
      \\]</div>
      <p>轨道层比较同一 NORAD 卫星在模型快照/输出和外部 GP 目录中的高度、倾角、平均运动；星座层比较目标壳层规模、RAAN 分布相似度；业务层比较模型业务曲线和 Cloudflare Radar 数值序列；网络性能层优先比较模型用户侧 RTT 与 RIPE Atlas Starlink 探针 RTT 的量级，内部任务路由时延只作为星座压力参考。</p>
    </section>
    <section class="grid2">
      <div class="panel">
        <h2>轨道真实性外部对照</h2>
        <table><tbody>
          <tr><th>匹配卫星数</th><td>${report.orbit_external.summary.matched_satellites}</td></tr>
          <tr><th>输出高度 MAE</th><td>${report.orbit_external.summary.output_altitude_mae_km} km</td></tr>
          <tr><th>倾角 MAE</th><td>${report.orbit_external.summary.inclination_mae_deg} deg</td></tr>
          <tr><th>平均运动 MAE</th><td>${report.orbit_external.summary.mean_motion_mae_rev_day} rev/day</td></tr>
        </tbody></table>
      </div>
      <div class="panel">
        <h2>星座规模和壳层</h2>
        ${svgBars(constellationChartRows, [
          { id: "model", label: "模型", color: "#2563eb" },
          { id: "external", label: "外部公开数据", color: "#16a34a" },
        ], { title: "模型与外部目标壳层对照" })}
      </div>
    </section>
    <section class="panel">
      <h2>业务流量真实性验证</h2>
      <p class="note">${escapeHtml(report.traffic_external.summary.note)}</p>
      ${svgLine(report.traffic_external.rows, [
        { id: "model_normalized", label: "模型业务", color: "#2563eb" },
        { id: "external_radar_normalized", label: "Cloudflare Radar", color: "#16a34a" },
        { id: "calibration_template_normalized", label: "本地校准模板", color: "#c76b0a" },
      ], { title: "业务曲线归一化对照" })}
      <table><tbody>
        <tr><th>Radar 数值点</th><td>${report.traffic_external.summary.external_radar_points}</td></tr>
        <tr><th>模型 vs Radar 相关系数</th><td>${report.traffic_external.summary.model_vs_external_radar_corr}</td></tr>
        <tr><th>模型 vs Radar 归一化 MAE</th><td>${report.traffic_external.summary.model_vs_external_radar_mae_normalized}</td></tr>
        <tr><th>模型 vs 本地模板相关系数</th><td>${report.traffic_external.summary.model_vs_calibration_template_corr}</td></tr>
      </tbody></table>
    </section>
    <section class="panel">
      <h2>网络性能真实性验证</h2>
      ${svgBars(report.network_performance_external.rows.filter((row) => row.metric.includes("latency")), [
        { id: "model_user_ping_rtt", label: "模型用户侧 RTT", color: "#2563eb" },
        { id: "external_ripe_atlas_rtt", label: "RIPE Atlas RTT", color: "#16a34a" },
        { id: "model_route_latency", label: "内部任务路由时延", color: "#c76b0a" },
      ], { title: "用户侧 RTT 与 RIPE Atlas Starlink ping 对照" })}
      ${table(report.network_performance_external.rows)}
      <p class="note">${escapeHtml(report.network_performance_external.summary.comparison_scope)}</p>
    </section>
    <section class="panel">
      <h2>外部数据源状态</h2>
      <table><thead><tr><th>来源</th><th>URL</th><th>状态</th><th>说明</th></tr></thead><tbody>${sourceRows.join("")}</tbody></table>
    </section>
    <section class="panel">
      <h2>复现命令</h2>
      <pre><code>${escapeHtml(report.reproduce.command)}</code></pre>
    </section>
  </main>
</body>
</html>`;
}

function markdownReport(report) {
  return `# 实验1：基于外部公开数据的卫星网络仿真真实性验证

本实验不再使用内部一致性评分作为主要证据，而是把模型输出与外部公开数据对照。

## 结论概览

${report.evidence.map((item) => `- ${item.item}：${item.status}。${item.reason}`).join("\n")}

## 外部数据源

${report.external_sources.map((item) => `- ${item.name}：${item.url}，状态：${item.status}，说明：${item.detail}`).join("\n")}

## 子实验

### 轨道真实性

- 匹配卫星数：${report.orbit_external.summary.matched_satellites}
- 输出高度 MAE：${report.orbit_external.summary.output_altitude_mae_km} km
- 倾角 MAE：${report.orbit_external.summary.inclination_mae_deg} deg
- 平均运动 MAE：${report.orbit_external.summary.mean_motion_mae_rev_day} rev/day

### 星座规模和壳层

- 模型选取卫星数：${report.constellation_external.summary.model_selected_count}
- 外部目标壳层卫星数：${report.constellation_external.summary.external_target_shell_count}
- 规模覆盖比：${report.constellation_external.summary.scale_coverage_ratio}
- RAAN 分布相似度：${report.constellation_external.summary.raan_distribution_similarity}

### 业务流量真实性

- Radar 数值点：${report.traffic_external.summary.external_radar_points}
- 模型 vs Radar 相关系数：${report.traffic_external.summary.model_vs_external_radar_corr}
- 模型 vs Radar 归一化 MAE：${report.traffic_external.summary.model_vs_external_radar_mae_normalized}
- 说明：${report.traffic_external.summary.note}

### 网络性能真实性

- RIPE Atlas ping 样本：${report.network_performance_external.summary.external_ripe_ping_samples}
- 模型用户侧 P50 RTT：${report.network_performance_external.summary.model_user_ping_p50_ms} ms
- RIPE Atlas P50 RTT：${report.network_performance_external.summary.external_ripe_rtt_p50_ms} ms
- 用户侧 P50 比例：${report.network_performance_external.summary.model_user_ping_to_ripe_p50_latency_ratio}
- 内部任务 P50 路由时延：${report.network_performance_external.summary.model_route_latency_p50_ms} ms

## 复现命令

\`\`\`bash
${report.reproduce.command}
\`\`\`
`;
}

const args = process.argv.slice(2);
const snapshotPath = resolve(argValue(args, "--snapshot", "data/tle-snapshots/celestrak-starlink-real-walker-72x22.json"));
const tasksPath = resolve(argValue(args, "--tasks", "examples/datasets/radar-calibrated-starlink-72x22-48-traffic.csv"));
const calibrationProfilePath = resolve(argValue(args, "--calibration-profile", "traffic-calibration/cloudflare-radar-profile.json"));
const outDir = resolve(argValue(args, "--out", "reports/experiment1-external-realism-72x22"));
const truthDir = resolve(argValue(args, "--truth-dir", join(outDir, "stage1-truth")));
const slices = Number(argValue(args, "--slices", "48"));
const externalTlePath = argValue(args, "--external-tle", "");
const radarCsvPath = argValue(args, "--radar-csv", "");
const radarJsonPath = argValue(args, "--radar-json", "");
const radarWindow = argValue(args, "--radar-window", "latest");
const cloudflareDateRange = argValue(args, "--cloudflare-date-range", "7d");
const cloudflareToken = process.env.CLOUDFLARE_API_TOKEN ?? "";
const ripeMeasurementId = Number(argValue(args, "--ripe-measurement-id", "1001"));
const ripeMaxProbes = Number(argValue(args, "--ripe-max-probes", "16"));
const ripeHours = Number(argValue(args, "--ripe-hours", "4"));
const shellAltitudeToleranceKm = Number(argValue(args, "--shell-altitude-tolerance-km", "50"));
const reuseTruth = hasArg(args, "--reuse-truth");

if (!existsSync(snapshotPath)) throw new Error(`Snapshot not found: ${snapshotPath}`);
if (!existsSync(tasksPath)) throw new Error(`Task dataset not found: ${tasksPath}`);
if (!existsSync(calibrationProfilePath)) throw new Error(`Calibration profile not found: ${calibrationProfilePath}`);
if (!Number.isFinite(slices) || slices < 1) throw new Error("--slices must be a positive number");
if (!Number.isFinite(shellAltitudeToleranceKm) || shellAltitudeToleranceKm <= 0) {
  throw new Error("--shell-altitude-tolerance-km must be a positive number");
}

await mkdir(outDir, { recursive: true });

let truthRun = null;
if (!reuseTruth || !existsSync(join(truthDir, "nodes.csv"))) {
  await mkdir(truthDir, { recursive: true });
  truthRun = await runNode(
    [
      "scripts/exportScenario.mjs",
      "--tasks",
      tasksPath,
      "--orbit",
      "real-tle-sgp4",
      "--tle-snapshot",
      snapshotPath,
      "--mode",
      "operational",
      "--routing",
      "congestion-aware-shortest-path",
      "--slices",
      String(slices),
      "--out",
      truthDir,
    ],
    "export stage-one model output for external comparison",
  );
}

const [snapshot, calibrationProfile, nodes, links, routes, tasks] = await Promise.all([
  readJson(snapshotPath),
  readJson(calibrationProfilePath),
  readCsv(join(truthDir, "nodes.csv")),
  readCsv(join(truthDir, "links.csv")),
  readCsv(join(truthDir, "routes.csv")),
  readCsv(tasksPath),
]);

const externalTle = await loadExternalTle({
  outDir,
  explicitPath: externalTlePath ? resolve(externalTlePath) : "",
  noLive: hasArg(args, "--no-live-celestrak"),
});
const ripeAtlas = await loadRipeAtlas({
  outDir,
  skip: hasArg(args, "--skip-ripe"),
  measurementId: ripeMeasurementId,
  maxProbes: ripeMaxProbes,
  hours: ripeHours,
});
const cloudflareRadar = await loadCloudflareRadar({
  outDir,
  radarCsvPath: radarCsvPath ? resolve(radarCsvPath) : "",
  radarJsonPath: radarJsonPath ? resolve(radarJsonPath) : "",
  token: cloudflareToken,
  dateRange: cloudflareDateRange,
});

const orbitExternal = analyzeOrbitExternal({ snapshot, nodes, externalRecords: externalTle.records });
const constellationExternal = analyzeConstellationExternal({
  snapshot,
  externalRecords: externalTle.records,
  altitudeToleranceKm: shellAltitudeToleranceKm,
});
const trafficExternal = analyzeTrafficExternal({
  tasks,
  radarSeries: cloudflareRadar.series,
  calibrationProfile,
  slices,
  radarWindow,
});
const networkPerformanceExternal = analyzeNetworkPerformanceExternal({
  nodes,
  links,
  routes,
  ripeResults: ripeAtlas.results,
});

const outputs = {
  report_json: rel(join(outDir, "external-realism-report.json")),
  report_md: rel(join(outDir, "external-realism-report.md")),
  report_html: rel(join(outDir, "external-realism-report.html")),
  orbit_comparison_csv: rel(join(outDir, "orbit-external-comparison.csv")),
  constellation_comparison_csv: rel(join(outDir, "constellation-shell-comparison.csv")),
  traffic_comparison_csv: rel(join(outDir, "traffic-external-comparison.csv")),
  network_performance_csv: rel(join(outDir, "network-performance-external-comparison.csv")),
  user_facing_rtt_csv: rel(join(outDir, "user-facing-rtt-comparison.csv")),
  source_status_csv: rel(join(outDir, "external-source-status.csv")),
  stage1_truth_dir: rel(truthDir),
};

const report = {
  schema: "int-temerity-experiment1-external-realism/v1",
  generated_at: new Date().toISOString(),
  purpose:
    "Validate first-stage satellite-network simulation outputs against external public observations rather than relying on internal consistency checks.",
  inputs: {
    snapshot: rel(snapshotPath),
    tasks: rel(tasksPath),
    calibration_profile: rel(calibrationProfilePath),
    slices,
    radar_csv: radarCsvPath ? rel(resolve(radarCsvPath)) : "",
    radar_json: radarJsonPath ? rel(resolve(radarJsonPath)) : "",
    radar_window: radarWindow,
    truth_dir: rel(truthDir),
  },
  external_sources: [
    externalTle.status,
    cloudflareRadar.status,
    ripeAtlas.status,
    buildSourceStatus(
      "RIPE Atlas built-in measurements documentation",
      "https://atlas.ripe.net/docs/built-in-measurements/",
      "reference",
      "用于解释 RIPE Atlas 内置 ping/traceroute 等测量来源。",
    ),
    buildSourceStatus(
      "Cloudflare Radar API documentation",
      "https://developers.cloudflare.com/radar/get-started/first-request/",
      "reference",
      "说明 Radar API 需要 API Token；无 token 时不能把本地校准模板当作外部数值真值。",
    ),
  ],
  orbit_external: orbitExternal,
  constellation_external: constellationExternal,
  traffic_external: trafficExternal,
  network_performance_external: networkPerformanceExternal,
  limitations: [
    "新增用户侧 RTT 对照使用公开探针位置、模型卫星几何和区域网关启发式估计，适合做量级验证，不等同于 Starlink 真实网关/PoP 选路表。",
    "公开数据不能提供 Starlink 内部逐星 CPU、电池、队列和 ISL 真实遥测。",
    "CelesTrak/Space-Track 可验证轨道目录和壳层分布，但不能验证运营商内部路由策略。",
    "RIPE Atlas ping 与模型用户侧 RTT 是可比较的公开接入口径；模型内部任务路由时延仍不是同一测量点，只能作为星座压力指标。",
    "没有 Cloudflare Radar API token 或用户导出的 Radar CSV 时，业务流量只能展示模型曲线，不能完成强外部数值对照。",
  ],
  reproduce: {
    command: `npm run experiment:realism -- --out ${rel(outDir)} --snapshot ${rel(snapshotPath)} --tasks ${rel(tasksPath)} --slices ${slices} --radar-window ${radarWindow}${radarJsonPath ? ` --radar-json ${rel(resolve(radarJsonPath))}` : ""}${radarCsvPath ? ` --radar-csv ${rel(resolve(radarCsvPath))}` : ""}`,
    truth_run: truthRun,
  },
  outputs,
};
report.evidence = evidenceLevel(report);
{
  const network = report.network_performance_external.summary;
  const networkEvidence = report.evidence[3];
  if (networkEvidence) {
    const comparable =
      network.external_ripe_ping_samples > 0 &&
      network.model_user_ping_samples > 0 &&
      network.model_user_ping_to_ripe_p50_latency_ratio >= 0.5 &&
      network.model_user_ping_to_ripe_p50_latency_ratio <= 3;
    networkEvidence.status = comparable ? "用户侧量级接近" : "用户侧存在偏差或证据不足";
    networkEvidence.reason = `用户侧模型 P50 RTT ${network.model_user_ping_p50_ms} ms，RIPE Atlas P50 RTT ${network.external_ripe_rtt_p50_ms} ms，比例 ${network.model_user_ping_to_ripe_p50_latency_ratio}；内部任务路由 P50 ${network.model_route_latency_p50_ms} ms 仅作为星座压力指标。`;
  }
}

await Promise.all([
  writeCsv(join(outDir, "orbit-external-comparison.csv"), orbitExternal.rows),
  writeCsv(join(outDir, "constellation-shell-comparison.csv"), constellationExternal.rows),
  writeCsv(join(outDir, "traffic-external-comparison.csv"), trafficExternal.rows),
  writeCsv(join(outDir, "network-performance-external-comparison.csv"), networkPerformanceExternal.rows),
  writeCsv(join(outDir, "user-facing-rtt-comparison.csv"), networkPerformanceExternal.user_ping_rows),
  writeCsv(join(outDir, "external-source-status.csv"), report.external_sources),
]);
await writeFile(join(outDir, "external-realism-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
await writeFile(join(outDir, "external-realism-report.md"), markdownReport(report), "utf8");
await writeFile(join(outDir, "external-realism-report.html"), htmlReport(report), "utf8");

console.log(
  JSON.stringify(
    {
      ok: true,
      schema: report.schema,
      outputs,
      evidence: report.evidence,
      key_results: {
        orbit_altitude_mae_km: report.orbit_external.summary.output_altitude_mae_km,
        constellation_scale_coverage_ratio: report.constellation_external.summary.scale_coverage_ratio,
        traffic_external_radar_points: report.traffic_external.summary.external_radar_points,
        network_user_ping_to_ripe_p50_latency_ratio: report.network_performance_external.summary.model_user_ping_to_ripe_p50_latency_ratio,
        network_model_to_ripe_p50_latency_ratio: report.network_performance_external.summary.model_to_ripe_p50_latency_ratio,
      },
    },
    null,
    2,
  ),
);
