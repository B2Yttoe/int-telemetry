import { readCsvStream } from "../../stage2-int/tools/csv-stream.mjs";
import {
  compareDistributions,
  correlation,
  mae,
  quantile,
  rmse,
  round,
  spearmanCorrelation,
} from "./blindValidationMetrics.mjs";

const EARTH_RADIUS_KM = 6371;
const LIGHT_KM_PER_MS = 299.792458;

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function radians(value) {
  return (value * Math.PI) / 180;
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
  return (Math.asin(clamp(dot(line, observer) / denominator, -1, 1)) * 180) / Math.PI;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const phi1 = radians(lat1);
  const phi2 = radians(lat2);
  const dPhi = radians(lat2 - lat1);
  const dLambda = radians(lon2 - lon1);
  const value = Math.sin(dPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(value));
}

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
      if (this.items[parent].score <= item.score) break;
      this.items[index] = this.items[parent];
      index = parent;
    }
    this.items[index] = item;
  }

  pop() {
    if (!this.items.length) return null;
    const first = this.items[0];
    const tail = this.items.pop();
    if (this.items.length && tail) {
      let index = 0;
      while (true) {
        const left = index * 2 + 1;
        const right = left + 1;
        if (left >= this.items.length) break;
        const child = right < this.items.length && this.items[right].score < this.items[left].score ? right : left;
        if (this.items[child].score >= tail.score) break;
        this.items[index] = this.items[child];
        index = child;
      }
      this.items[index] = tail;
    }
    return first;
  }

  get length() {
    return this.items.length;
  }
}

function pathMetrics(adjacency, source, target, cache) {
  if (source === target) {
    return { latency_one_way_ms: 0, bottleneck_mbps: Infinity, packet_success: 1, hops: 0 };
  }
  if (cache.has(target)) return cache.get(target).get(source) ?? null;
  const best = new Map([[target, { score: 0, bottleneck: Infinity, success: 1, hops: 0 }]]);
  const queue = new MinHeap();
  queue.push({ node: target, score: 0, bottleneck: Infinity, success: 1, hops: 0 });
  while (queue.length) {
    const current = queue.pop();
    if (!current || current.score !== best.get(current.node)?.score) continue;
    for (const edge of adjacency.get(current.node) ?? []) {
      const score = current.score + edge.latency_ms + edge.queue_latency_ms;
      if (score >= (best.get(edge.target)?.score ?? Infinity)) continue;
      const state = {
        score,
        bottleneck: Math.min(current.bottleneck, edge.residual_capacity_mbps),
        success: current.success * (1 - edge.packet_error_rate),
        hops: current.hops + 1,
      };
      best.set(edge.target, state);
      queue.push({ node: edge.target, ...state });
    }
  }
  const metrics = new Map([...best].map(([node, state]) => [node, {
    latency_one_way_ms: state.score,
    bottleneck_mbps: state.bottleneck,
    packet_success: state.success,
    hops: state.hops,
  }]));
  cache.set(target, metrics);
  return metrics.get(source) ?? null;
}

function visibleCandidates(satellites, observer, minimumElevation, maximum) {
  return satellites.map((satellite) => ({
    satellite,
    distance_km: distanceKm(observer, satellite.position),
    elevation_deg: elevationDeg(observer, satellite.position),
  })).filter((candidate) => candidate.elevation_deg >= minimumElevation)
    .sort((left, right) => right.elevation_deg - left.elevation_deg)
    .slice(0, maximum);
}

export async function loadUserPerformanceTopology(nodesPath, linksPath) {
  const [nodeRows, linkRows] = await Promise.all([
    readCsvStream(nodesPath, { columns: ["slice_index", "time", "node_id", "latitude_deg", "longitude_deg", "altitude_km"] }),
    readCsvStream(linksPath, {
      columns: [
        "slice_index", "source", "target", "status", "is_active", "latency_ms", "queue_latency_ms",
        "effective_capacity_mbps", "capacity_mbps", "bandwidth_mbps", "utilization_percent", "packet_error_rate",
      ],
    }),
  ]);
  const satellitesBySlice = new Map();
  const timeBySlice = new Map();
  for (const row of nodeRows) {
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
    if (!timeBySlice.has(slice) && Number.isFinite(new Date(row.time).getTime())) timeBySlice.set(slice, row.time);
  }
  const adjacencyBySlice = new Map();
  for (const row of linkRows) {
    if (!boolish(row.is_active) || row.status === "down") continue;
    const slice = Number(row.slice_index);
    const latency = Number(row.latency_ms);
    if (!Number.isFinite(slice) || !Number.isFinite(latency)) continue;
    const effective = Number(row.effective_capacity_mbps ?? row.capacity_mbps ?? row.bandwidth_mbps);
    const utilization = clamp(Number(row.utilization_percent) || 0, 0, 100);
    const residual = Math.max(0.001, (Number.isFinite(effective) ? effective : 2500) * (1 - utilization / 100));
    const edge = {
      latency_ms: latency,
      queue_latency_ms: Math.max(0, Number(row.queue_latency_ms) || 0),
      residual_capacity_mbps: residual,
      packet_error_rate: clamp(Number(row.packet_error_rate) || 0, 0, 1),
    };
    if (!adjacencyBySlice.has(slice)) adjacencyBySlice.set(slice, new Map());
    const adjacency = adjacencyBySlice.get(slice);
    if (!adjacency.has(row.source)) adjacency.set(row.source, []);
    if (!adjacency.has(row.target)) adjacency.set(row.target, []);
    adjacency.get(row.source).push({ ...edge, target: row.target });
    adjacency.get(row.target).push({ ...edge, target: row.source });
  }
  const sliceIndexes = [...satellitesBySlice.keys()].sort((left, right) => left - right);
  const times = sliceIndexes.map((slice) => new Date(timeBySlice.get(slice)).getTime()).filter(Number.isFinite).sort((a, b) => a - b);
  const stepMs = times.length > 1 ? quantile(times.slice(1).map((time, index) => time - times[index]), 0.5) : 300_000;
  return {
    satellitesBySlice,
    adjacencyBySlice,
    sliceIndexes,
    epoch_ms: times[0] ?? 0,
    step_ms: stepMs,
    period_ms: stepMs * Math.max(sliceIndexes.length, 1),
    time_start: times.length ? new Date(times[0]).toISOString() : "",
    time_end: times.length ? new Date(times.at(-1)).toISOString() : "",
  };
}

function locationKey(city, country) {
  return `${String(country ?? "").trim().toUpperCase()}:${String(city ?? "").trim().toLowerCase()}`;
}

function median(values) {
  return quantile(values.filter(Number.isFinite), 0.5);
}

export function buildServerLocationIndex(trainingRows) {
  const cityPoints = new Map();
  const countryPoints = new Map();
  for (const row of trainingRows) {
    const latitude = Number(row.lat);
    const longitude = Number(row.lon);
    if (![latitude, longitude].every(Number.isFinite)) continue;
    const key = locationKey(row.client_city, row.client_country_code);
    if (!cityPoints.has(key)) cityPoints.set(key, []);
    cityPoints.get(key).push([latitude, longitude]);
    const country = String(row.client_country_code ?? "").trim().toUpperCase();
    if (!countryPoints.has(country)) countryPoints.set(country, []);
    countryPoints.get(country).push([latitude, longitude]);
  }
  const city = new Map([...cityPoints].map(([key, points]) => [key, {
    latitude_deg: median(points.map((point) => point[0])),
    longitude_deg: median(points.map((point) => point[1])),
    source: "training-client-city-centroid",
    support: points.length,
  }]));
  const country = new Map([...countryPoints].map(([key, points]) => [key, {
    latitude_deg: median(points.map((point) => point[0])),
    longitude_deg: median(points.map((point) => point[1])),
    source: "training-client-country-centroid",
    support: points.length,
  }]));
  const all = [...countryPoints.values()].flat();
  return {
    city,
    country,
    global: {
      latitude_deg: median(all.map((point) => point[0])),
      longitude_deg: median(all.map((point) => point[1])),
      source: "training-global-centroid",
      support: all.length,
    },
  };
}

function resolveServerLocation(row, index) {
  const directLatitude = Number(row.server_latitude_deg);
  const directLongitude = Number(row.server_longitude_deg);
  if ([directLatitude, directLongitude].every(Number.isFinite)) {
    return {
      latitude_deg: directLatitude,
      longitude_deg: directLongitude,
      source: "direct-measurement-target-coordinate",
      support: 1,
    };
  }
  const city = index.city.get(locationKey(row.server_city, row.server_country_code));
  if (city) return city;
  const country = index.country.get(String(row.server_country_code ?? "").trim().toUpperCase());
  return country ?? index.global;
}

function sliceForTime(topology, time) {
  const timestamp = new Date(time).getTime();
  if (!Number.isFinite(timestamp) || !topology.sliceIndexes.length) return { slice: topology.sliceIndexes[0], pairing: "invalid-time" };
  const withinWindow = timestamp >= topology.epoch_ms && timestamp < topology.epoch_ms + topology.period_ms;
  const normalized = ((timestamp - topology.epoch_ms) % topology.period_ms + topology.period_ms) % topology.period_ms;
  const offset = Math.min(topology.sliceIndexes.length - 1, Math.floor(normalized / topology.step_ms));
  return { slice: topology.sliceIndexes[offset], pairing: withinWindow ? "exact-topology-window" : "representative-periodic-phase" };
}

function sglGeometryFactor(elevation) {
  const sine = Math.sin(radians(clamp(elevation, 0, 90)));
  return clamp(0.15 + 0.85 * sine ** 0.75, 0.15, 1);
}

function candidateGateways(config, client, server) {
  const rows = config.gateway_candidates.map((gateway) => ({
    ...gateway,
    position: geodeticToEcef(gateway.latitude_deg, gateway.longitude_deg),
    client_distance_km: haversineKm(client.latitude_deg, client.longitude_deg, gateway.latitude_deg, gateway.longitude_deg),
    server_distance_km: haversineKm(server.latitude_deg, server.longitude_deg, gateway.latitude_deg, gateway.longitude_deg),
  }));
  const selected = new Map();
  rows.sort((a, b) => a.client_distance_km - b.client_distance_km).slice(0, config.maximum_gateway_candidates).forEach((row) => selected.set(row.id, row));
  rows.sort((a, b) => a.server_distance_km - b.server_distance_km).slice(0, config.maximum_gateway_candidates).forEach((row) => selected.set(row.id, row));
  return [...selected.values()];
}

export function buildUserPerformanceContexts(topology, rows, config, serverLocationIndex) {
  const pathCaches = new Map();
  return rows.map((row, sampleIndex) => {
    const clientLatitude = Number(row.lat ?? row.probe_latitude_deg);
    const clientLongitude = Number(row.lon ?? row.probe_longitude_deg);
    const time = row.test_time ?? row.time ?? (Number(row.timestamp) ? new Date(Number(row.timestamp) * 1000).toISOString() : "");
    const base = {
      sample_index: sampleIndex,
      observation_id: row.uuid ?? row.probe_id ?? row.prb_id ?? sampleIndex,
      test_time: time,
      client_city: row.client_city ?? "",
      client_country_code: row.client_country_code ?? row.probe_country ?? "",
      server_city: row.server_city ?? "",
      server_country_code: row.server_country_code ?? "",
      client_latitude_deg: clientLatitude,
      client_longitude_deg: clientLongitude,
      external_rtt_ms: Number(row.download_latency_ms ?? row.external_rtt_ms),
      external_throughput_mbps: Number(row.download_throughput_mbps),
      external_satellite_density: Number(row.sat_density),
    };
    if (![clientLatitude, clientLongitude].every(Number.isFinite)) return { ...base, status: "invalid-client-location" };
    const server = resolveServerLocation(row, serverLocationIndex);
    const sliceSelection = sliceForTime(topology, time);
    const satellites = topology.satellitesBySlice.get(sliceSelection.slice) ?? [];
    const adjacency = topology.adjacencyBySlice.get(sliceSelection.slice) ?? new Map();
    if (!pathCaches.has(sliceSelection.slice)) pathCaches.set(sliceSelection.slice, new Map());
    const pathCache = pathCaches.get(sliceSelection.slice);
    const clientPosition = geodeticToEcef(clientLatitude, clientLongitude);
    const access = visibleCandidates(satellites, clientPosition, config.minimum_elevation_deg, config.maximum_access_candidates).slice(0, 4);
    if (!access.length) return { ...base, status: "no-visible-access-satellite", slice_index: sliceSelection.slice };
    const gateways = candidateGateways(config, { latitude_deg: clientLatitude, longitude_deg: clientLongitude }, server);
    let best = null;
    for (const user of access) {
      for (const gateway of gateways) {
        const gatewayAccess = visibleCandidates(satellites, gateway.position, config.minimum_elevation_deg, config.maximum_access_candidates).slice(0, 2);
        for (const remote of gatewayAccess) {
          const path = pathMetrics(adjacency, user.satellite.id, remote.satellite.id, pathCache);
          if (!path) continue;
          const accessOneWay = user.distance_km / LIGHT_KM_PER_MS;
          const gatewayOneWay = remote.distance_km / LIGHT_KM_PER_MS;
          const terrestrialOneWay = gateway.server_distance_km * config.terrestrial_route_stretch / config.fiber_speed_km_per_ms;
          const processingOneWay = config.terminal_processing_one_way_ms + config.gateway_processing_one_way_ms + config.server_processing_one_way_ms;
          const baseRtt = 2 * (accessOneWay + path.latency_one_way_ms + gatewayOneWay + terrestrialOneWay + processingOneWay);
          const userSgl = config.sgl_capacity_mbps * sglGeometryFactor(user.elevation_deg);
          const gatewaySgl = config.sgl_capacity_mbps * sglGeometryFactor(remote.elevation_deg);
          const bottleneck = Math.min(userSgl, gatewaySgl, config.gateway_capacity_mbps, path.bottleneck_mbps);
          const physicalCapacity = Math.max(0.001, bottleneck * path.packet_success);
          const candidate = {
            ...base,
            status: "modeled",
            slice_index: sliceSelection.slice,
            temporal_pairing: sliceSelection.pairing,
            server_latitude_deg: server.latitude_deg,
            server_longitude_deg: server.longitude_deg,
            server_location_source: server.source,
            server_location_support: server.support,
            access_satellite_id: user.satellite.id,
            gateway_satellite_id: remote.satellite.id,
            gateway_id: gateway.id,
            access_elevation_deg: user.elevation_deg,
            gateway_elevation_deg: remote.elevation_deg,
            isl_hops: path.hops,
            access_propagation_rtt_ms: 2 * accessOneWay,
            isl_and_queue_rtt_ms: 2 * path.latency_one_way_ms,
            gateway_propagation_rtt_ms: 2 * gatewayOneWay,
            terrestrial_rtt_ms: 2 * terrestrialOneWay,
            processing_rtt_ms: 2 * processingOneWay,
            base_model_rtt_ms: baseRtt,
            physical_user_capacity_mbps: physicalCapacity,
            model_path_packet_loss_rate: 1 - path.packet_success,
          };
          if (!best || candidate.base_model_rtt_ms < best.base_model_rtt_ms) best = candidate;
        }
      }
    }
    return best ?? { ...base, status: "no-gateway-route", slice_index: sliceSelection.slice };
  });
}

function validModeled(rows) {
  return rows.filter((row) => row.status === "modeled" && Number.isFinite(row.base_model_rtt_ms) && Number.isFinite(row.physical_user_capacity_mbps));
}

export function fitUserPerformanceCalibration(trainingContexts, config) {
  const rows = validModeled(trainingContexts)
    .filter((row) => Number.isFinite(row.external_rtt_ms) && Number.isFinite(row.external_throughput_mbps))
    .sort((left, right) => new Date(left.test_time) - new Date(right.test_time));
  if (rows.length < 20) throw new Error(`User-performance calibration requires at least 20 modeled rows, found ${rows.length}`);
  const fitCount = Math.max(1, Math.floor(rows.length * 0.75));
  const fitRows = rows.slice(0, fitCount);
  const intervalRows = rows.slice(fitCount);
  const densityReference = median(fitRows.map((row) => row.external_satellite_density).filter((value) => Number.isFinite(value) && value > 0)) || 1;
  const densityFactor = (row) => Number.isFinite(row.external_satellite_density)
    ? clamp(row.external_satellite_density / densityReference, 0.65, 1.35)
    : 1;
  const rttOffset = clamp(
    median(fitRows.map((row) => row.external_rtt_ms - row.base_model_rtt_ms)),
    config.calibration.rtt_offset_min_ms,
    config.calibration.rtt_offset_max_ms,
  );
  const schedulerShare = clamp(
    median(fitRows.map((row) => row.external_throughput_mbps / (row.physical_user_capacity_mbps * densityFactor(row)))),
    config.calibration.scheduler_share_min,
    config.calibration.scheduler_share_max,
  );
  const rttResiduals = intervalRows.map((row) => Math.abs(row.external_rtt_ms - (row.base_model_rtt_ms + rttOffset)));
  const throughputResiduals = intervalRows.map((row) => Math.abs(
    row.external_throughput_mbps - row.physical_user_capacity_mbps * densityFactor(row) * schedulerShare,
  ));
  return {
    schema: "int-temerity-user-performance-calibration/v1",
    fitted_parameters: {
      rtt_access_and_transport_offset_ms: round(rttOffset),
      scheduler_and_transport_share: round(schedulerShare, 9),
      satellite_density_reference: round(densityReference),
    },
    intervals: {
      coverage: config.calibration.prediction_interval_coverage,
      rtt_absolute_residual_radius_ms: round(quantile(rttResiduals, config.calibration.prediction_interval_coverage)),
      throughput_absolute_residual_radius_mbps: round(quantile(throughputResiduals, config.calibration.prediction_interval_coverage)),
    },
    audit: {
      available_training_rows: trainingContexts.length,
      modeled_training_rows: rows.length,
      fit_rows: fitRows.length,
      interval_calibration_rows: intervalRows.length,
      test_rows_used_for_fit: 0,
      test_rows_used_for_interval_calibration: 0,
      free_fitted_parameter_count: 2,
    },
  };
}

export function applyUserPerformanceCalibration(contexts, calibration) {
  const parameters = calibration.fitted_parameters;
  const intervals = calibration.intervals;
  return contexts.map((row) => {
    if (row.status !== "modeled") return row;
    const densityFactor = Number.isFinite(row.external_satellite_density)
      ? clamp(row.external_satellite_density / parameters.satellite_density_reference, 0.65, 1.35)
      : 1;
    const predictedRtt = row.base_model_rtt_ms + parameters.rtt_access_and_transport_offset_ms;
    const predictedThroughput = row.physical_user_capacity_mbps * densityFactor * parameters.scheduler_and_transport_share;
    return {
      ...row,
      satellite_density_factor: densityFactor,
      predicted_user_rtt_ms: predictedRtt,
      predicted_user_throughput_mbps: predictedThroughput,
      predicted_rtt_lower_ms: Math.max(0, predictedRtt - intervals.rtt_absolute_residual_radius_ms),
      predicted_rtt_upper_ms: predictedRtt + intervals.rtt_absolute_residual_radius_ms,
      predicted_throughput_lower_mbps: Math.max(0, predictedThroughput - intervals.throughput_absolute_residual_radius_mbps),
      predicted_throughput_upper_mbps: predictedThroughput + intervals.throughput_absolute_residual_radius_mbps,
    };
  });
}

function metricSummary(actual, predicted) {
  return {
    sample_count: actual.length,
    pearson: round(correlation(actual, predicted)),
    spearman: round(spearmanCorrelation(actual, predicted)),
    mae: round(mae(actual, predicted)),
    rmse: round(rmse(actual, predicted)),
    ...compareDistributions(predicted, actual),
  };
}

export function scoreUserPerformance(predictedRows) {
  const rows = predictedRows.filter((row) => row.status === "modeled" &&
    Number.isFinite(row.external_rtt_ms) && Number.isFinite(row.external_throughput_mbps) &&
    Number.isFinite(row.predicted_user_rtt_ms) && Number.isFinite(row.predicted_user_throughput_mbps));
  const actualRtt = rows.map((row) => row.external_rtt_ms);
  const predictedRtt = rows.map((row) => row.predicted_user_rtt_ms);
  const actualThroughput = rows.map((row) => row.external_throughput_mbps);
  const predictedThroughput = rows.map((row) => row.predicted_user_throughput_mbps);
  const coverage = (actualField, lowerField, upperField) => rows.filter((row) =>
    row[actualField] >= row[lowerField] && row[actualField] <= row[upperField],
  ).length / Math.max(rows.length, 1);
  return {
    valid_paired_samples: rows.length,
    rtt: {
      ...metricSummary(actualRtt, predictedRtt),
      interval_coverage: round(coverage("external_rtt_ms", "predicted_rtt_lower_ms", "predicted_rtt_upper_ms")),
    },
    throughput: {
      ...metricSummary(actualThroughput, predictedThroughput),
      interval_coverage: round(coverage(
        "external_throughput_mbps",
        "predicted_throughput_lower_mbps",
        "predicted_throughput_upper_mbps",
      )),
    },
    pairing: {
      exact_topology_window_ratio: round(rows.filter((row) => row.temporal_pairing === "exact-topology-window").length / Math.max(rows.length, 1)),
      city_level_server_location_ratio: round(rows.filter((row) => row.server_location_source === "training-client-city-centroid").length / Math.max(rows.length, 1)),
      country_fallback_ratio: round(rows.filter((row) => row.server_location_source === "training-client-country-centroid").length / Math.max(rows.length, 1)),
      global_fallback_ratio: round(rows.filter((row) => row.server_location_source === "training-global-centroid").length / Math.max(rows.length, 1)),
    },
  };
}

export function performanceRowsForCsv(rows) {
  return rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key,
    typeof value === "number" ? round(value) : value,
  ])));
}
