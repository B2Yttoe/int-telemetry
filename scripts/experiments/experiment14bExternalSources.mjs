import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { extractRadarSeries, fetchJson } from "./experiment14Sources.mjs";
import { sampleRemoteZipCsv } from "./remoteZipCsvSampler.mjs";

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function validMlabRow(row, sourceFilter) {
  return row.data_source === sourceFilter &&
    Number.isFinite(new Date(row.test_time).getTime()) &&
    Number.isFinite(Number(row.download_throughput_mbps)) &&
    Number.isFinite(Number(row.download_latency_ms)) &&
    Number.isFinite(Number(row.lat)) &&
    Number.isFinite(Number(row.lon));
}

export async function collectUntouchedMlabSplit(protocol, outputDirectory) {
  const fields = [...new Set([...protocol.required_fields, "packet_loss_rate", "download_jitter_ms", "client_server_distance_km"] )];
  const training = await sampleRemoteZipCsv({
    url: protocol.dataset_url,
    member: protocol.training_member,
    maximumRows: protocol.maximum_training_samples,
    seed: protocol.deterministic_sample_seed,
    selectedFields: fields,
    filter: (row) => validMlabRow(row, protocol.data_source_filter),
  });
  const excludedDates = new Set(protocol.excluded_test_dates_due_to_prior_repository_exposure ?? []);
  const test = await sampleRemoteZipCsv({
    url: protocol.dataset_url,
    member: protocol.test_member,
    maximumRows: protocol.maximum_test_samples,
    seed: protocol.deterministic_sample_seed + 1,
    selectedFields: fields,
    filter: (row) => validMlabRow(row, protocol.data_source_filter) &&
      !excludedDates.has(String(row.test_time).slice(0, 10)),
  });
  const trainingIds = new Set(training.rows.map((row) => row.uuid));
  const overlap = test.rows.filter((row) => trainingIds.has(row.uuid)).length;
  const metadata = {
    schema: "int-temerity-experiment14b-mlab-split/v1",
    acquired_at: new Date().toISOString(),
    dataset_doi: protocol.dataset_doi,
    dataset_url: protocol.dataset_url,
    license: protocol.license,
    training: training.metadata,
    test: test.metadata,
    excluded_test_dates_due_to_prior_repository_exposure: [...excludedDates],
    train_test_uuid_overlap: overlap,
    test_target_values_used_for_fit: 0,
  };
  await writeJson(join(outputDirectory, "mlab-split-metadata.json"), metadata);
  return { training, test, metadata };
}

function radarUrl(protocol, start, end, name) {
  const query = new URLSearchParams({
    asn: String(protocol.asn),
    dateStart: start,
    dateEnd: end,
    aggInterval: protocol.aggregation_interval,
    botClass: protocol.bot_class,
    normalization: protocol.normalization,
    format: "JSON",
    name,
  });
  return `https://api.cloudflare.com/client/v4/radar/http/timeseries?${query}`;
}

async function fetchRadar(url, token) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "User-Agent": "INT-Temerity-Experiment14B/1.0 research-validation",
      },
      signal: controller.signal,
    });
    const payload = await response.json();
    if (!response.ok || payload?.success === false) {
      throw new Error(`Cloudflare Radar HTTP ${response.status}: ${JSON.stringify(payload?.errors ?? payload).slice(0, 500)}`);
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

export async function collectProspectiveRadar(protocol, freeze, outputDirectory, token) {
  if (!token) {
    return {
      status: "pending-missing-api-token",
      detail: `Set ${protocol.token_environment_variable}; no test data was substituted or synthesized.`,
    };
  }
  if (Date.now() < new Date(freeze.windows.radar_test_end).getTime()) {
    return {
      status: "pending-future-window",
      available_at: freeze.windows.radar_test_end,
    };
  }
  const calibrationUrl = radarUrl(protocol, freeze.windows.radar_calibration_start, freeze.windows.radar_calibration_end, "calibration");
  const testUrl = radarUrl(protocol, freeze.windows.radar_test_start, freeze.windows.radar_test_end, "prospective-test");
  const calibrationPayload = await fetchRadar(calibrationUrl, token);
  const testPayload = await fetchRadar(testUrl, token);
  const calibration = extractRadarSeries(calibrationPayload);
  const test = extractRadarSeries(testPayload);
  if (calibration.length < 24 || test.length < 24) {
    throw new Error(`Radar prospective split is too short: calibration ${calibration.length}, test ${test.length}`);
  }
  const calibrationTimes = new Set(calibration.map((row) => row.time));
  const overlap = test.filter((row) => calibrationTimes.has(row.time)).length;
  if (overlap) throw new Error(`Radar prospective train/test timestamps overlap at ${overlap} points`);
  await writeJson(join(outputDirectory, "radar-calibration-payload.json"), calibrationPayload);
  await writeJson(join(outputDirectory, "radar-prospective-test-payload.json"), testPayload);
  await writeJson(join(outputDirectory, "radar-collection-metadata.json"), {
    acquired_at: new Date().toISOString(),
    calibration_url: calibrationUrl,
    test_url: testUrl,
    calibration_points: calibration.length,
    test_points: test.length,
    timestamp_overlap: overlap,
    test_values_used_for_fit: 0,
  });
  return { status: "complete", calibration, test, calibrationPayload, testPayload };
}

async function activeAnchorNearCentroid(sourceProbes) {
  const payload = await fetchJson("https://atlas.ripe.net/api/v2/anchors/?page_size=500");
  const coordinates = sourceProbes.map((probe) => probe.geometry?.coordinates).filter((value) => Array.isArray(value));
  const centroid = coordinates.length ? {
    longitude: coordinates.reduce((sum, value) => sum + Number(value[0]), 0) / coordinates.length,
    latitude: coordinates.reduce((sum, value) => sum + Number(value[1]), 0) / coordinates.length,
  } : { longitude: 8.68, latitude: 50.11 };
  return (payload.results ?? [])
    .filter((anchor) => !anchor.is_disabled && anchor.ip_v4 && Array.isArray(anchor.geometry?.coordinates))
    .map((anchor) => {
      const [longitude, latitude] = anchor.geometry.coordinates;
      return { ...anchor, distance: Math.hypot(latitude - centroid.latitude, longitude - centroid.longitude) };
    })
    .sort((left, right) => left.distance - right.distance)[0];
}

async function sourceProbes(protocol) {
  const payload = await fetchJson(`https://atlas.ripe.net/api/v2/probes/?asn_v4=${protocol.source_asn}&status=1&page_size=500`);
  return (payload.results ?? [])
    .filter((probe) => probe.is_public && probe.status?.id === 1 && Array.isArray(probe.geometry?.coordinates))
    .sort((left, right) => Number(left.id) - Number(right.id))
    .slice(0, protocol.requested_probes);
}

async function createRipeMeasurement(protocol, freeze, key, outputDirectory) {
  const probes = await sourceProbes(protocol);
  if (!probes.length) throw new Error(`No public RIPE Atlas probes found for AS${protocol.source_asn}`);
  const anchor = await activeAnchorNearCentroid(probes);
  if (!anchor) throw new Error("No active IPv4 RIPE Atlas anchor is available");
  const start = Math.max(Math.floor(Date.now() / 1000) + 60, Math.floor(new Date(freeze.windows.ripe_test_start).getTime() / 1000));
  const stop = Math.max(start + 600, Math.floor(new Date(freeze.windows.ripe_test_end).getTime() / 1000));
  const payload = {
    definitions: [{
      target: anchor.fqdn,
      description: `INT-Temerity experiment14B AS${protocol.source_asn} to anchor ${anchor.id}`,
      type: "ping",
      af: protocol.address_family,
      interval: protocol.measurement_interval_seconds,
      resolve_on_probe: true,
    }],
    probes: [{
      requested: protocol.requested_probes,
      type: "probes",
      value: probes.map((probe) => probe.id).join(","),
    }],
    start_time: start,
    stop_time: stop,
    is_oneoff: false,
  };
  const response = await fetch("https://atlas.ripe.net/api/v2/measurements/", {
    method: "POST",
    headers: {
      Authorization: `Key ${key}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(payload),
  });
  const result = await response.json();
  if (!response.ok || !Array.isArray(result.measurements) || !result.measurements.length) {
    throw new Error(`RIPE Atlas measurement creation failed: HTTP ${response.status} ${JSON.stringify(result).slice(0, 800)}`);
  }
  const state = {
    schema: "int-temerity-experiment14b-ripe-measurement/v1",
    created_at: new Date().toISOString(),
    measurement_id: result.measurements[0],
    start_time: new Date(start * 1000).toISOString(),
    stop_time: new Date(stop * 1000).toISOString(),
    anchor: {
      id: anchor.id,
      fqdn: anchor.fqdn,
      country: anchor.country,
      city: anchor.city,
      latitude_deg: anchor.geometry.coordinates[1],
      longitude_deg: anchor.geometry.coordinates[0],
    },
    probes: probes.map((probe) => ({
      id: probe.id,
      country_code: probe.country_code,
      latitude_deg: probe.geometry.coordinates[1],
      longitude_deg: probe.geometry.coordinates[0],
    })),
    request: payload,
  };
  await writeJson(join(outputDirectory, "ripe-measurement-state.json"), state);
  return state;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function rttFromAtlasResult(result) {
  const values = (result.result ?? []).map((entry) => Number(entry.rtt)).filter(Number.isFinite);
  if (Number.isFinite(Number(result.avg))) return Number(result.avg);
  if (!values.length) return Number.NaN;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export async function collectProspectiveRipe(protocol, freeze, outputDirectory, apiKey) {
  const statePath = join(outputDirectory, "ripe-measurement-state.json");
  let state = null;
  try {
    state = await readJson(statePath);
  } catch {
    if (apiKey) state = await createRipeMeasurement(protocol, freeze, apiKey, outputDirectory);
  }
  if (!state && !apiKey) {
    if (Date.now() < new Date(freeze.windows.ripe_test_end).getTime()) {
      return {
        status: "pending-missing-api-key",
        available_at: freeze.windows.ripe_test_end,
        detail: `Set ${protocol.api_key_environment_variable} for exact-anchor pairing; public fallback will be acquired after the window.`,
      };
    }
    const probes = await sourceProbes(protocol);
    const ids = probes.map((probe) => probe.id).join(",");
    const start = Math.floor(new Date(freeze.windows.ripe_test_start).getTime() / 1000);
    const stop = Math.floor(new Date(freeze.windows.ripe_test_end).getTime() / 1000);
    const url = `https://atlas.ripe.net/api/v2/measurements/${protocol.fallback_public_measurement_id}/results/?probe_ids=${ids}&start=${start}&stop=${stop}`;
    const payload = await fetchJson(url);
    const byProbe = new Map(probes.map((probe) => [Number(probe.id), probe]));
    const rows = (Array.isArray(payload) ? payload : payload.results ?? []).map((result) => {
      const probe = byProbe.get(Number(result.prb_id));
      return {
        uuid: `ripe-${result.prb_id}-${result.timestamp}`,
        test_time: new Date(Number(result.timestamp) * 1000).toISOString(),
        probe_id: result.prb_id,
        client_country_code: probe?.country_code ?? "",
        lat: probe?.geometry?.coordinates?.[1],
        lon: probe?.geometry?.coordinates?.[0],
        external_rtt_ms: rttFromAtlasResult(result),
        target_semantics: "K-root-anycast-public-fallback",
      };
    }).filter((row) => Number.isFinite(row.external_rtt_ms));
    await writeJson(join(outputDirectory, "ripe-public-fallback-results.json"), payload);
    return { status: "complete-public-proxy", rows, measurement_id: protocol.fallback_public_measurement_id, url };
  }
  if (Date.now() < new Date(state.stop_time).getTime()) {
    return { status: "measurement-running", available_at: state.stop_time, measurement_id: state.measurement_id };
  }
  const url = `https://atlas.ripe.net/api/v2/measurements/${state.measurement_id}/results/?start=${Math.floor(new Date(state.start_time).getTime() / 1000)}&stop=${Math.floor(new Date(state.stop_time).getTime() / 1000)}`;
  const payload = await fetchJson(url);
  const byProbe = new Map(state.probes.map((probe) => [Number(probe.id), probe]));
  const rows = (Array.isArray(payload) ? payload : payload.results ?? []).map((result) => {
    const probe = byProbe.get(Number(result.prb_id));
    return {
      uuid: `ripe-${result.prb_id}-${result.timestamp}`,
      test_time: new Date(Number(result.timestamp) * 1000).toISOString(),
      probe_id: result.prb_id,
      client_country_code: probe?.country_code ?? "",
      lat: probe?.latitude_deg,
      lon: probe?.longitude_deg,
      server_city: state.anchor.city,
      server_country_code: state.anchor.country,
      server_latitude_deg: state.anchor.latitude_deg,
      server_longitude_deg: state.anchor.longitude_deg,
      external_rtt_ms: rttFromAtlasResult(result),
      target_semantics: "fixed-ripe-atlas-anchor",
    };
  }).filter((row) => Number.isFinite(row.external_rtt_ms));
  await writeJson(join(outputDirectory, "ripe-custom-anchor-results.json"), payload);
  return { status: "complete-exact-anchor", rows, measurement_id: state.measurement_id, url, state };
}
