import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  acquireOrbitJson,
  buildFreshWalkerSnapshot,
  evaluateOrbitFreshness,
  sha256,
} from "./experiments/freshOrbitAcquisition.mjs";
import { generateFreshTopologyWindow } from "./experiments/freshTopologyWindow.mjs";
import { compareOrbitEpochs } from "./experiments/crossEpochOrbitValidation.mjs";
import { medianEpoch } from "./experiments/experiment14Sources.mjs";
import {
  collectProspectiveRadar,
  collectProspectiveRipe,
} from "./experiments/experiment14bExternalSources.mjs";
import {
  applyUserPerformanceCalibration,
  buildServerLocationIndex,
  buildUserPerformanceContexts,
  loadUserPerformanceTopology,
  performanceRowsForCsv,
  scoreUserPerformance,
} from "./experiments/userPerformanceLayer.mjs";
import {
  classifyStrictExternalPair,
  summarizeStrictExternalPairs,
  uniqueTopologyTimes,
} from "./experiments/strictExternalPairing.mjs";
import { buildRadarBlindHoldout } from "./experiments/blindValidationMetrics.mjs";
import { extractRadarSeries } from "./experiments/experiment14Sources.mjs";
import { readCsvStream } from "../stage2-int/tools/csv-stream.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUTPUT = resolve(ROOT, "reports/experiment14b-prospective-external-validation-v2-utc-corrected");
const PROTOCOL_PATH = resolve(ROOT, "scripts/experiments/experiment14b-v2-protocol.json");
const UTC_CORRECTION_PATH = resolve(ROOT, "scripts/experiments/experiment14b-v2-utc-epoch-correction.json");
const SCRIPT_PATH = resolve(ROOT, "scripts/runExperiment14BProspectiveValidationV2.mjs");
const DEPENDENCY_PATHS = [
  SCRIPT_PATH,
  PROTOCOL_PATH,
  UTC_CORRECTION_PATH,
  resolve(ROOT, "reports/experiment14b-prospective-external-validation-v2/UTC_EPOCH_RETIREMENT.json"),
  resolve(ROOT, "scripts/experiments/experiment14b-protocol.json"),
  resolve(ROOT, "scripts/experiments/freshOrbitAcquisition.mjs"),
  resolve(ROOT, "scripts/experiments/utcEpoch.mjs"),
  resolve(ROOT, "scripts/experiments/freshTopologyWindow.mjs"),
  resolve(ROOT, "scripts/experiments/crossEpochOrbitValidation.mjs"),
  resolve(ROOT, "scripts/experiments/experiment14Sources.mjs"),
  resolve(ROOT, "scripts/experiments/experiment14bExternalSources.mjs"),
  resolve(ROOT, "scripts/experiments/userPerformanceLayer.mjs"),
  resolve(ROOT, "scripts/experiments/strictExternalPairing.mjs"),
  resolve(ROOT, "scripts/experiments/blindValidationMetrics.mjs"),
  resolve(ROOT, "stage2-int/tools/csv-stream.mjs"),
  resolve(ROOT, "src/config/walkerNetworkConfig.ts"),
  resolve(ROOT, "src/simulation/walker.ts"),
  resolve(ROOT, "src/simulation/antenna.ts"),
  resolve(ROOT, "src/simulation/tle.ts"),
  resolve(ROOT, "src/simulation/realTleCatalog.ts"),
  resolve(ROOT, "src/simulation/utcEpoch.ts"),
];

function argValue(args, name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

function addHours(value, hours) {
  return new Date(new Date(value).getTime() + hours * 3_600_000);
}

function ceilHour(value) {
  const date = new Date(value);
  date.setUTCMinutes(0, 0, 0);
  if (date.getTime() < new Date(value).getTime()) date.setUTCHours(date.getUTCHours() + 1);
  return date;
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

async function writeCsv(path, rows) {
  await mkdir(dirname(path), { recursive: true });
  if (!rows.length) return writeFile(path, "", "utf8");
  const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const lines = [headers.join(","), ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(","))];
  return writeFile(path, `${lines.join("\n")}\n`, "utf8");
}

async function fileRecord(path) {
  const absolute = resolve(path);
  const bytes = await readFile(absolute);
  return {
    path: relative(ROOT, absolute).replaceAll("\\", "/"),
    bytes: bytes.length,
    sha256: sha256(bytes),
  };
}

async function verifyRecord(record) {
  const current = await fileRecord(resolve(ROOT, record.path));
  return current.bytes === record.bytes && current.sha256 === record.sha256;
}

async function removeTransient(outputDirectory, path) {
  const absolute = resolve(path);
  if (!absolute.startsWith(`${outputDirectory}${sep}`)) throw new Error(`Refusing to remove outside v2 output: ${absolute}`);
  if (await exists(absolute)) await rm(absolute, { recursive: true, force: true });
}

async function baselineAcquisitions() {
  const oldOrbit = resolve(ROOT, "reports/experiment14b-prospective-external-validation/orbit");
  const rows = {};
  for (const source of ["standard", "supplemental"]) {
    const path = join(oldOrbit, `starlink-${source}-gp-acquisition.json`);
    const value = await readJson(path);
    rows[source] = {
      acquired_at: value.acquired_at,
      sha256: value.sha256,
      source_url: value.source_url,
    };
  }
  return rows;
}

async function freeze(outputDirectory) {
  const manifestPath = join(outputDirectory, "freeze-manifest.json");
  const sidecarPath = join(outputDirectory, "freeze-manifest.sha256");
  if (await exists(manifestPath)) return verifyFreeze(outputDirectory);
  const protocol = await readJson(PROTOCOL_PATH);
  const parentProtocol = await readJson(resolve(ROOT, protocol.parent_protocol_path));
  const frozenAt = new Date();
  const gp0NotBefore = addHours(frozenAt, protocol.orbit.minimum_source_update_hours_after_freeze);
  const radarStart = ceilHour(frozenAt);
  const calibrationPath = resolve(ROOT, protocol.mlab_strict.frozen_calibration_path);
  const files = await Promise.all([...DEPENDENCY_PATHS, calibrationPath].map(fileRecord));
  const manifest = {
    schema: "int-telemetry-experiment14b-v2-freeze/v1",
    experiment_id: protocol.experiment_id,
    frozen_at: frozenAt.toISOString(),
    protocol_sha256: sha256(await readFile(PROTOCOL_PATH)),
    code_and_config_sha256: sha256(Buffer.from(files.map((row) => `${row.path}\0${row.sha256}`).join("\n"))),
    baseline_sources: await baselineAcquisitions(),
    windows: {
      gp0_not_before: gp0NotBefore.toISOString(),
      radar_calibration_start: addHours(radarStart, -protocol.radar.calibration_hours).toISOString(),
      radar_calibration_end: new Date(radarStart.getTime() - 1).toISOString(),
      radar_test_start: radarStart.toISOString(),
      radar_test_end: addHours(radarStart, protocol.radar.prospective_test_hours).toISOString(),
    },
    fixed_parameters: {
      orbit: parentProtocol.orbit,
      topology_window: parentProtocol.topology_window,
      user_performance: parentProtocol.user_performance,
      radar: parentProtocol.radar,
      ripe_atlas: parentProtocol.ripe_atlas,
    },
    causality: protocol.causality,
    files,
  };
  await mkdir(outputDirectory, { recursive: true });
  await copyFile(PROTOCOL_PATH, join(outputDirectory, "frozen-protocol.json"));
  await writeJson(manifestPath, manifest);
  await writeFile(sidecarPath, `${sha256(JSON.stringify(manifest))}\n`, "utf8");
  return manifest;
}

async function verifyFreeze(outputDirectory) {
  const manifest = await readJson(join(outputDirectory, "freeze-manifest.json"));
  const sidecar = (await readFile(join(outputDirectory, "freeze-manifest.sha256"), "utf8")).trim();
  if (sidecar !== sha256(JSON.stringify(manifest))) throw new Error("Experiment 14B v2 freeze manifest changed");
  const changed = [];
  for (const record of manifest.files) if (!(await verifyRecord(record))) changed.push(record.path);
  if (changed.length) throw new Error(`Experiment 14B v2 frozen dependencies changed: ${changed.join(", ")}`);
  return manifest;
}

function freshnessPolicy(parentProtocol) {
  return {
    minimum_records: parentProtocol.orbit.planes * parentProtocol.orbit.satellites_per_plane,
    maximum_median_age_hours: parentProtocol.orbit.maximum_selected_median_age_hours,
    maximum_p95_age_hours: parentProtocol.orbit.maximum_selected_p95_age_hours,
    maximum_future_epoch_ratio: parentProtocol.orbit.maximum_future_epoch_ratio,
  };
}

async function sourceCandidate(source, acquisition, parentProtocol) {
  const snapshot = await buildFreshWalkerSnapshot(acquisition.records, {
    sourceUrl: acquisition.acquisition.source_url,
    downloadedAt: acquisition.acquisition.acquired_at,
    planes: parentProtocol.orbit.planes,
    satellitesPerPlane: parentProtocol.orbit.satellites_per_plane,
    raanClusterThresholdDeg: parentProtocol.orbit.raan_cluster_threshold_deg,
  });
  const start = evaluateOrbitFreshness(snapshot.satellites, new Date(acquisition.acquisition.acquired_at), freshnessPolicy(parentProtocol));
  const windowEnd = evaluateOrbitFreshness(
    snapshot.satellites,
    addHours(acquisition.acquisition.acquired_at, parentProtocol.topology_window.slices * parentProtocol.topology_window.step_minutes / 60),
    freshnessPolicy(parentProtocol),
  );
  return { source, acquisition, snapshot, start_freshness: start, window_end_freshness: windowEnd, passed: start.passed && windowEnd.passed };
}

async function verifyLock(outputDirectory, name) {
  const lock = await readJson(join(outputDirectory, `${name}-lock.json`));
  const changed = [];
  for (const [artifact, record] of Object.entries(lock.artifacts ?? {})) if (!(await verifyRecord(record))) changed.push(artifact);
  if (changed.length) throw new Error(`${name} immutable artifacts changed: ${changed.join(", ")}`);
  return lock;
}

async function collectGp0(outputDirectory) {
  const frozen = await verifyFreeze(outputDirectory);
  const lockPath = join(outputDirectory, "gp0-lock.json");
  if (await exists(lockPath)) return { status: "complete", lock: await verifyLock(outputDirectory, "gp0") };
  if (Date.now() < new Date(frozen.windows.gp0_not_before).getTime()) {
    return { status: "pending-future-source-update-window", available_at: frozen.windows.gp0_not_before };
  }
  const orbitDirectory = join(outputDirectory, "orbit", "gp0");
  const cacheDirectory = join(outputDirectory, "_source-cache", "gp0");
  const parentProtocol = frozen.fixed_parameters;
  const acquisitions = {};
  for (const source of ["standard", "supplemental"]) {
    const sourceId = `starlink-${source}-gp-v2`;
    const url = source === "standard" ? parentProtocol.orbit.standard_gp_url : parentProtocol.orbit.supplemental_gp_url;
    acquisitions[source] = await acquireOrbitJson({
      url,
      sourceId,
      cacheDirectory,
      outputDirectory: orbitDirectory,
      minimumRecords: parentProtocol.orbit.minimum_catalog_records,
      minimumDownloadIntervalHours: parentProtocol.orbit.minimum_download_interval_hours,
      requireAcquiredAfter: frozen.windows.gp0_not_before,
      force: true,
    });
  }
  const candidates = [];
  for (const source of ["standard", "supplemental"]) {
    const acquisition = acquisitions[source];
    if (!acquisition.acquisition.causality_eligible) continue;
    if (acquisition.acquisition.sha256 === frozen.baseline_sources[source].sha256) continue;
    candidates.push(await sourceCandidate(source, acquisition, parentProtocol));
  }
  const passing = candidates.filter((row) => row.passed).sort((left, right) =>
    left.window_end_freshness.age_p50_hours - right.window_end_freshness.age_p50_hours ||
    left.source.localeCompare(right.source));
  if (!passing.length) {
    await writeJson(join(outputDirectory, "gp0-candidate-status.json"), {
      generated_at: new Date().toISOString(),
      candidates: candidates.map(({ snapshot, acquisition, ...row }) => ({
        ...row,
        acquisition: acquisition.acquisition,
        selected_count: snapshot.satellites.length,
      })),
    });
    return { status: "pending-no-changed-source-passed-age-gates", candidate_count: candidates.length };
  }
  const selected = passing[0];
  const selectedId = `starlink-${selected.source}-gp-v2`;
  const selectedGpPath = join(orbitDirectory, `${selectedId}-acquired.json`);
  const snapshotPath = join(orbitDirectory, "gp0-walker-72x22.json");
  await writeJson(snapshotPath, selected.snapshot);
  await writeJson(join(orbitDirectory, "gp0-start-freshness.json"), selected.start_freshness);
  await writeJson(join(orbitDirectory, "gp0-window-end-freshness.json"), selected.window_end_freshness);
  const topology = await generateFreshTopologyWindow(selected.snapshot, {
    epochIso: selected.acquisition.acquisition.acquired_at,
    slices: parentProtocol.topology_window.slices,
    stepMinutes: parentProtocol.topology_window.step_minutes,
    mode: parentProtocol.topology_window.mode,
    trafficProfile: parentProtocol.topology_window.traffic_profile,
    routingAlgorithm: parentProtocol.topology_window.routing_algorithm,
  });
  const topologyDirectory = join(outputDirectory, "topology");
  const nodesPath = join(topologyDirectory, "nodes.csv");
  const linksPath = join(topologyDirectory, "links.csv");
  await writeCsv(nodesPath, topology.nodes);
  await writeCsv(linksPath, topology.links);
  await writeJson(join(topologyDirectory, "metadata.json"), {
    schema: topology.schema,
    generated_at: topology.generated_at,
    source_catalog_fingerprint: topology.source_catalog_fingerprint,
    epoch_iso: topology.epoch_iso,
    slices: topology.slices,
    step_minutes: topology.step_minutes,
    node_rows: topology.nodes.length,
    link_rows: topology.links.length,
  });
  const gp1NotBefore = addHours(selected.acquisition.acquisition.acquired_at, (await readJson(PROTOCOL_PATH)).orbit.future_validation_delay_hours_after_gp0);
  const topologyEnd = addHours(
    selected.acquisition.acquisition.acquired_at,
    parentProtocol.topology_window.slices * parentProtocol.topology_window.step_minutes / 60,
  );
  const lock = {
    schema: "int-telemetry-experiment14b-v2-gp0-lock/v1",
    locked_at: new Date().toISOString(),
    source_family: selected.source,
    source_id: selectedId,
    source_url: selected.acquisition.acquisition.source_url,
    source_acquired_at: selected.acquisition.acquisition.acquired_at,
    source_content_sha256: selected.acquisition.acquisition.sha256,
    source_content_changed_after_freeze: true,
    start_freshness: selected.start_freshness,
    window_end_freshness: selected.window_end_freshness,
    windows: {
      topology_start: selected.acquisition.acquisition.acquired_at,
      topology_end: topologyEnd.toISOString(),
      gp1_not_before: gp1NotBefore.toISOString(),
      mlab_import_not_before: addHours(topologyEnd, (await readJson(PROTOCOL_PATH)).mlab_strict.minimum_publication_delay_hours).toISOString(),
    },
    refresh_allowed: false,
    artifacts: {
      gp: await fileRecord(selectedGpPath),
      snapshot: await fileRecord(snapshotPath),
      nodes: await fileRecord(nodesPath),
      links: await fileRecord(linksPath),
      start_freshness: await fileRecord(join(orbitDirectory, "gp0-start-freshness.json")),
      window_end_freshness: await fileRecord(join(orbitDirectory, "gp0-window-end-freshness.json")),
    },
  };
  await writeJson(lockPath, lock);
  await writeMlabQueryTemplate(outputDirectory, lock);
  for (const source of ["standard", "supplemental"]) {
    if (source === selected.source) continue;
    await removeTransient(outputDirectory, join(orbitDirectory, `starlink-${source}-gp-v2-acquired.json`));
    await removeTransient(outputDirectory, join(orbitDirectory, `starlink-${source}-gp-v2-acquisition.json`));
  }
  for (const acquisition of Object.values(acquisitions)) {
    if (acquisition.acquisition.immutable_path) await removeTransient(outputDirectory, acquisition.acquisition.immutable_path);
  }
  await removeTransient(outputDirectory, cacheDirectory);
  await writeStatus(outputDirectory);
  return { status: "complete", lock };
}

async function writeMlabQueryTemplate(outputDirectory, gp0) {
  await mkdir(join(outputDirectory, "mlab"), { recursive: true });
  const sql = `-- Run with the official M-Lab BigQuery dataset after its publication delay.\n` +
`SELECT\n` +
`  a.UUID AS uuid,\n  a.TestTime AS test_time,\n  'NDT7' AS data_source,\n` +
`  client.Network.ASNumber AS client_asn,\n  client.Geo.city AS client_city,\n` +
`  client.Geo.countryCode AS client_country_code,\n  client.Geo.latitude AS lat,\n` +
`  client.Geo.longitude AS lon,\n  server.Machine AS server_id,\n` +
`  server.Geo.city AS server_city,\n  server.Geo.countryCode AS server_country_code,\n` +
`  server.Geo.latitude AS server_latitude_deg,\n  server.Geo.longitude AS server_longitude_deg,\n` +
`  a.MeanThroughputMbps AS download_throughput_mbps,\n  a.MinRTT AS download_latency_ms\n` +
`FROM \`measurement-lab.ndt.unified_downloads\`\n` +
`WHERE a.TestTime >= TIMESTAMP('${gp0.windows.topology_start}')\n` +
`  AND a.TestTime < TIMESTAMP('${gp0.windows.topology_end}')\n` +
`  AND client.Network.ASNumber = 14593\n` +
`  AND 'ndt7' IN UNNEST(node_instruments)\n` +
`ORDER BY a.TestTime, a.UUID;\n`;
  await writeFile(join(outputDirectory, "mlab", "strict-window-query.sql"), sql, "utf8");
}

async function collectGp1(outputDirectory) {
  const frozen = await verifyFreeze(outputDirectory);
  const gp0 = await verifyLock(outputDirectory, "gp0");
  const gp1Path = join(outputDirectory, "gp1-lock.json");
  if (await exists(gp1Path)) return { status: "complete", lock: await verifyLock(outputDirectory, "gp1") };
  if (Date.now() < new Date(gp0.windows.gp1_not_before).getTime()) return { status: "pending-future-window", available_at: gp0.windows.gp1_not_before };
  const protocol = await readJson(PROTOCOL_PATH);
  const parent = frozen.fixed_parameters;
  const directory = join(outputDirectory, "orbit", "gp1");
  const cacheDirectory = join(outputDirectory, "_source-cache", "gp1");
  const sourceId = `starlink-${gp0.source_family}-gp-v2-validation`;
  const acquisition = await acquireOrbitJson({
    url: gp0.source_url,
    sourceId,
    cacheDirectory,
    outputDirectory: directory,
    minimumRecords: parent.orbit.minimum_catalog_records,
    minimumDownloadIntervalHours: parent.orbit.minimum_download_interval_hours,
    requireAcquiredAfter: gp0.windows.gp1_not_before,
    force: true,
  });
  if (!acquisition.acquisition.causality_eligible || acquisition.acquisition.sha256 === gp0.source_content_sha256) {
    return { status: "pending-source-content-update", acquisition: acquisition.acquisition };
  }
  const candidate = await sourceCandidate(gp0.source_family, acquisition, parent);
  if (!candidate.passed) return { status: "failed-freshness-gate", freshness: candidate.start_freshness, acquisition: acquisition.acquisition };
  const modelSnapshot = await readJson(resolve(ROOT, gp0.artifacts.snapshot.path));
  const comparison = compareOrbitEpochs({
    modelSnapshot,
    validationSnapshot: acquisition.records,
    comparisonTime: medianEpoch(acquisition.records),
  });
  const errorsPath = join(directory, "gp0-to-gp1-errors.csv");
  const summaryPath = join(directory, "gp0-to-gp1-summary.json");
  await writeCsv(errorsPath, comparison.rows);
  await writeJson(summaryPath, comparison.summary);
  const gpPath = join(directory, `${sourceId}-acquired.json`);
  const lock = {
    schema: "int-telemetry-experiment14b-v2-gp1-lock/v1",
    locked_at: new Date().toISOString(),
    source_family: gp0.source_family,
    source_acquired_at: acquisition.acquisition.acquired_at,
    source_content_sha256: acquisition.acquisition.sha256,
    differs_from_gp0: true,
    freshness: candidate.start_freshness,
    summary: comparison.summary,
    refresh_allowed: false,
    artifacts: {
      gp: await fileRecord(gpPath),
      acquisition: await fileRecord(join(directory, `${sourceId}-acquisition.json`)),
      errors: await fileRecord(errorsPath),
      summary: await fileRecord(summaryPath),
    },
  };
  await writeJson(gp1Path, lock);
  await removeTransient(outputDirectory, cacheDirectory);
  await writeStatus(outputDirectory);
  return { status: "complete", lock };
}

async function ensureRipeWindowLock(outputDirectory, key) {
  const path = join(outputDirectory, "ripe-atlas", "measurement-window-lock.json");
  if (await exists(path)) return readJson(path);
  if (!key) return null;
  const protocol = await readJson(PROTOCOL_PATH);
  const start = new Date(Date.now() + 120_000);
  const lock = {
    schema: "int-telemetry-experiment14b-v2-ripe-window-lock/v1",
    locked_at: new Date().toISOString(),
    start_time: start.toISOString(),
    stop_time: addHours(start, protocol.ripe_strict.measurement_hours).toISOString(),
    duration_hours: protocol.ripe_strict.measurement_hours,
    target_selection_uses_results: false,
  };
  await writeJson(path, lock);
  await writeFile(`${path}.sha256`, `${sha256(JSON.stringify(lock))}\n`, "utf8");
  return lock;
}

async function collectExternal(outputDirectory) {
  const frozen = await verifyFreeze(outputDirectory);
  const gp0 = await verifyLock(outputDirectory, "gp0");
  const protocol = await readJson(PROTOCOL_PATH);
  const parent = frozen.fixed_parameters;
  const radarFreeze = { windows: {
    radar_calibration_start: frozen.windows.radar_calibration_start,
    radar_calibration_end: frozen.windows.radar_calibration_end,
    radar_test_start: frozen.windows.radar_test_start,
    radar_test_end: frozen.windows.radar_test_end,
  } };
  const radar = await safe("radar", () => collectProspectiveRadar(
    parent.radar,
    radarFreeze,
    join(outputDirectory, "radar"),
    process.env[parent.radar.token_environment_variable] ?? "",
  ));
  const ripeKey = process.env[parent.ripe_atlas.api_key_environment_variable] ?? "";
  const ripeWindow = await ensureRipeWindowLock(outputDirectory, ripeKey);
  const ripe = ripeWindow
    ? await safe("ripe-atlas", () => collectProspectiveRipe(
      parent.ripe_atlas,
      { windows: { ripe_test_start: ripeWindow.start_time, ripe_test_end: ripeWindow.stop_time } },
      join(outputDirectory, "ripe-atlas"),
      ripeKey,
    ))
    : { status: "pending-missing-api-key", detail: `Set ${parent.ripe_atlas.api_key_environment_variable}; no public proxy can satisfy strict v2.` };
  await writeJson(join(outputDirectory, "external-collection-status.json"), {
    generated_at: new Date().toISOString(),
    gp0_sha256: gp0.source_content_sha256,
    radar,
    ripe_atlas: ripe,
    proxy_promotes_strict_evidence: false,
  });
  await scoreRadar(outputDirectory, protocol, parent, radar);
  if (ripe.status === "complete-exact-anchor") await scoreRipe(outputDirectory, parent, ripe);
  await writeStatus(outputDirectory);
  return { radar: radar.status, ripe_atlas: ripe.status };
}

async function scoreRadar(outputDirectory, protocol, parent, source) {
  if (source.status !== "complete") return { status: source.status };
  const calibration = extractRadarSeries(await readJson(join(outputDirectory, "radar", "radar-calibration-payload.json")));
  const test = extractRadarSeries(await readJson(join(outputDirectory, "radar", "radar-prospective-test-payload.json")));
  const result = buildRadarBlindHoldout([...calibration, ...test], {
    train_fraction: calibration.length / (calibration.length + test.length),
    fit_fraction_within_train: parent.radar.fit_fraction_within_calibration,
    ridge_lambda: parent.radar.ridge_lambda,
    prediction_interval_coverage: parent.radar.prediction_interval_coverage,
    traffic_weight_min: parent.radar.traffic_weight_min,
    traffic_weight_max: parent.radar.traffic_weight_max,
  });
  await writeJson(join(outputDirectory, "radar", "radar-prospective-score.json"), { ...result.summary, coefficients: result.coefficients });
  await writeCsv(join(outputDirectory, "radar", "radar-prospective-timeseries.csv"), result.rows);
  return { status: "complete", ...result.summary, test_values_used_for_fit: 0, post_test_parameter_updates: 0 };
}

async function importMlab(outputDirectory, inputPath, metadataPath) {
  const frozen = await verifyFreeze(outputDirectory);
  const gp0 = await verifyLock(outputDirectory, "gp0");
  if (!inputPath || !metadataPath) return { status: "pending-input", required: ["--mlab-csv", "--mlab-metadata"] };
  if (Date.now() < new Date(gp0.windows.mlab_import_not_before).getTime()) {
    return { status: "pending-publication-delay", available_at: gp0.windows.mlab_import_not_before };
  }
  const protocol = await readJson(PROTOCOL_PATH);
  const parent = frozen.fixed_parameters;
  const rows = await readCsvStream(resolve(inputPath));
  const metadata = await readJson(resolve(metadataPath));
  const required = protocol.mlab_strict.required_columns;
  const missing = required.filter((column) => !rows.some((row) => Object.hasOwn(row, column)));
  if (missing.length) throw new Error(`Strict M-Lab input is missing columns: ${missing.join(", ")}`);
  const start = new Date(gp0.windows.topology_start).getTime();
  const end = new Date(gp0.windows.topology_end).getTime();
  const eligible = rows.filter((row) => {
    const time = new Date(row.test_time).getTime();
    return Number(row.client_asn) === protocol.mlab_strict.source_asn &&
      String(row.data_source).toLowerCase() === protocol.mlab_strict.protocol &&
      Number.isFinite(time) && time >= start && time < end;
  });
  const importDirectory = join(outputDirectory, "mlab", "strict-future");
  await mkdir(importDirectory, { recursive: true });
  const normalizedPath = join(importDirectory, "strict-window-input.csv");
  await writeCsv(normalizedPath, eligible);
  await copyFile(resolve(metadataPath), join(importDirectory, "source-metadata.json"));
  const calibrationPath = resolve(ROOT, protocol.mlab_strict.frozen_calibration_path);
  const frozenCalibrationRecord = frozen.files.find((row) => row.path === relative(ROOT, calibrationPath).replaceAll("\\", "/"));
  if (!frozenCalibrationRecord || !(await verifyRecord(frozenCalibrationRecord))) throw new Error("Frozen user-performance calibration changed");
  const calibration = await readJson(calibrationPath);
  const topology = await loadUserPerformanceTopology(resolve(ROOT, gp0.artifacts.nodes.path), resolve(ROOT, gp0.artifacts.links.path));
  const contexts = buildUserPerformanceContexts(topology, eligible, parent.user_performance, buildServerLocationIndex([]));
  const byId = new Map(eligible.map((row) => [String(row.uuid), row]));
  const predictions = applyUserPerformanceCalibration(contexts, calibration).map((row) => {
    const raw = byId.get(String(row.observation_id)) ?? {};
    return {
      ...row,
      server_id: raw.server_id ?? "",
      server_hostname: raw.server_id ?? "",
      client_asn: raw.client_asn ?? "",
    };
  });
  const nodeRows = await readCsvStream(resolve(ROOT, gp0.artifacts.nodes.path), { columns: ["slice_index", "time"] });
  const topologyTimes = uniqueTopologyTimes(nodeRows);
  const pairingPolicy = {
    minimum_pairs: { mlab_ndt7: protocol.mlab_strict.minimum_exact_pairs },
    maximum_topology_time_offset_seconds: protocol.mlab_strict.maximum_topology_time_offset_seconds,
    required: {
      modeled_status: "modeled",
      temporal_pairing: "exact-topology-window",
      server_location_source: "direct-measurement-target-coordinate",
      server_identity_present: true,
    },
  };
  const classified = predictions.map((row) => classifyStrictExternalPair(row, topologyTimes, pairingPolicy));
  const strictSummary = summarizeStrictExternalPairs(classified, "mlab_ndt7", pairingPolicy);
  const score = scoreUserPerformance(predictions);
  await writeCsv(join(importDirectory, "strict-paired-predictions.csv"), performanceRowsForCsv(classified));
  await writeJson(join(importDirectory, "strict-pairing-summary.json"), strictSummary);
  await writeJson(join(importDirectory, "user-performance-score.json"), score);
  const importRecord = {
    schema: "int-telemetry-experiment14b-v2-mlab-import/v1",
    imported_at: new Date().toISOString(),
    official_table: protocol.mlab_strict.official_table,
    source_csv: await fileRecord(normalizedPath),
    source_metadata_sha256: sha256(await readFile(resolve(metadataPath))),
    metadata,
    total_input_rows: rows.length,
    eligible_rows: eligible.length,
    strict_pairing: strictSummary,
    test_values_used_for_fit: 0,
    test_values_used_for_interval_calibration: 0,
    post_test_parameter_updates: 0,
  };
  await writeJson(join(importDirectory, "import-lock.json"), importRecord);
  await writeStatus(outputDirectory);
  return { status: strictSummary.passed ? "complete" : "insufficient-strict-pairs", strictSummary, score };
}

async function scoreRipe(outputDirectory, parent, source) {
  const calibration = await readJson(resolve(ROOT, (await readJson(PROTOCOL_PATH)).mlab_strict.frozen_calibration_path));
  const gp0 = await verifyLock(outputDirectory, "gp0");
  const topology = await loadUserPerformanceTopology(resolve(ROOT, gp0.artifacts.nodes.path), resolve(ROOT, gp0.artifacts.links.path));
  const contexts = buildUserPerformanceContexts(topology, source.rows ?? [], parent.user_performance, buildServerLocationIndex([]));
  const byId = new Map((source.rows ?? []).map((row) => [String(row.uuid), row]));
  const predictions = applyUserPerformanceCalibration(contexts, calibration).map((row) => {
    const raw = byId.get(String(row.observation_id)) ?? {};
    return { ...row, anchor_id: source.state?.anchor?.id ?? "", server_id: source.state?.anchor?.id ?? "", target_semantics: raw.target_semantics ?? "" };
  });
  await writeCsv(join(outputDirectory, "ripe-atlas", "ripe-paired-rtt.csv"), performanceRowsForCsv(predictions));
  return { status: "complete", valid_pairs: predictions.filter((row) => row.status === "modeled").length };
}

async function safe(source, operation) {
  try {
    return await operation();
  } catch (error) {
    return { status: "failed", source, error: error.stack ?? error.message };
  }
}

async function writeStatus(outputDirectory) {
  const status = {
    schema: "int-telemetry-experiment14b-v2-status/v1",
    generated_at: new Date().toISOString(),
    freeze: await exists(join(outputDirectory, "freeze-manifest.json")) ? "complete" : "missing",
    gp0: await exists(join(outputDirectory, "gp0-lock.json")) ? "complete" : "pending",
    gp1: await exists(join(outputDirectory, "gp1-lock.json")) ? "complete" : "pending",
    mlab_strict: await exists(join(outputDirectory, "mlab", "strict-future", "import-lock.json")) ? "imported" : "pending",
    radar: await exists(join(outputDirectory, "radar", "radar-prospective-score.json")) ? "complete" : "pending",
    ripe_exact_anchor: await exists(join(outputDirectory, "ripe-atlas", "ripe-measurement-state.json")) ? "created-or-complete" : "pending",
    ns3: await exists(resolve(ROOT, "reports/experiment13-system-validation/experiment13-system-validation-summary.json")) ? "complete" : "missing",
    internal_state_claim_boundary: await exists(resolve(ROOT, "project-docs/EXPERIMENT_14B_VALIDITY_BOUNDARIES.md")) ? "complete" : "missing",
  };
  await writeJson(join(outputDirectory, "status.json"), status);
  return status;
}

async function audit(outputDirectory) {
  const frozen = await verifyFreeze(outputDirectory);
  const protocol = await readJson(PROTOCOL_PATH);
  const status = await writeStatus(outputDirectory);
  const gp0 = status.gp0 === "complete" ? await verifyLock(outputDirectory, "gp0") : null;
  const gp1 = status.gp1 === "complete" ? await verifyLock(outputDirectory, "gp1") : null;
  const mlab = await exists(join(outputDirectory, "mlab", "strict-future", "import-lock.json"))
    ? await readJson(join(outputDirectory, "mlab", "strict-future", "import-lock.json")) : null;
  const external = await exists(join(outputDirectory, "external-collection-status.json"))
    ? await readJson(join(outputDirectory, "external-collection-status.json")) : null;
  const ns3 = await readJson(resolve(ROOT, "reports/experiment13-system-validation/experiment13-system-validation-summary.json"));
  const checks = {
    freeze_integrity: true,
    gp0_fresh_and_locked: Boolean(gp0?.start_freshness?.passed && gp0?.window_end_freshness?.passed),
    gp1_blind_validation: Boolean(gp1?.differs_from_gp0 && gp1?.summary),
    mlab_strict_pairs: Boolean(mlab?.strict_pairing?.strict_pairs >= protocol.mlab_strict.minimum_exact_pairs),
    radar_prospective: external?.radar?.status === "complete",
    ripe_exact_anchor: external?.ripe_atlas?.status === "complete-exact-anchor",
    ns3_complete: ns3.evidence_status === "ns3-system-cross-validation-complete",
    internal_claim_boundary: status.internal_state_claim_boundary === "complete",
    test_target_fit_count_zero: mlab == null || mlab.test_values_used_for_fit === 0,
    post_test_updates_zero: mlab == null || mlab.post_test_parameter_updates === 0,
  };
  const complete = Object.values(checks).every(Boolean);
  const result = {
    schema: "int-telemetry-experiment14b-v2-audit/v1",
    generated_at: new Date().toISOString(),
    frozen_at: frozen.frozen_at,
    evidence_status: complete ? "strict-prospective-validation-complete" : "strict-prospective-validation-in-progress",
    checks,
    completion_count: Object.values(checks).filter(Boolean).length,
    required_count: Object.keys(checks).length,
    claim_boundary: protocol.claim_boundary,
  };
  await writeJson(join(outputDirectory, "strict-audit.json"), result);
  return result;
}

const args = process.argv.slice(2);
const phase = argValue(args, "--phase", "status");
const outputDirectory = resolve(ROOT, argValue(args, "--out", relative(ROOT, DEFAULT_OUTPUT)));
let result;
if (phase === "freeze") result = await freeze(outputDirectory);
else if (phase === "verify") result = await verifyFreeze(outputDirectory);
else if (phase === "gp0") result = await collectGp0(outputDirectory);
else if (phase === "gp1") result = await collectGp1(outputDirectory);
else if (phase === "external") result = await collectExternal(outputDirectory);
else if (phase === "mlab-import") result = await importMlab(
  outputDirectory,
  argValue(args, "--mlab-csv", ""),
  argValue(args, "--mlab-metadata", ""),
);
else if (phase === "audit") result = await audit(outputDirectory);
else if (phase === "status") result = await writeStatus(outputDirectory);
else throw new Error(`Unknown Experiment 14B v2 phase: ${phase}`);
console.log(JSON.stringify({ phase, output_directory: outputDirectory, ...result }, null, 2));
