import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  acquireOrbitJson,
  buildFreshWalkerSnapshot,
  evaluateOrbitFreshness,
  seedOrbitCache,
  sha256,
  summarizeOrbitEpochAges,
} from "./experiments/freshOrbitAcquisition.mjs";
import { collectProspectiveRadar, collectProspectiveRipe } from "./experiments/experiment14bExternalSources.mjs";
import { compareOrbitEpochs } from "./experiments/crossEpochOrbitValidation.mjs";
import { medianEpoch } from "./experiments/experiment14Sources.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPORT = resolve(ROOT, "reports/experiment14b-prospective-external-validation");
const LIFECYCLE_DIRECTORY = join(REPORT, "source-lifecycle");
const PROTOCOL_PATH = resolve(ROOT, "scripts/experiments/experiment14b-source-lifecycle-protocol.json");
const PARENT_PROTOCOL_PATH = resolve(ROOT, "scripts/experiments/experiment14b-protocol.json");
const SCRIPT_PATH = resolve(ROOT, "scripts/runExperiment14BSourceLifecycle.mjs");
const CACHE_DIRECTORY = join(REPORT, "_source-cache");

function argValue(args, name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
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

async function removeIfPresent(path) {
  if (!(await exists(path))) return false;
  await rm(path, { recursive: true, force: true });
  return true;
}

function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

async function writeCsv(path, rows) {
  await mkdir(dirname(path), { recursive: true });
  if (!rows.length) return writeFile(path, "", "utf8");
  const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const content = [headers.join(","), ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(","))].join("\n");
  await writeFile(path, `${content}\n`, "utf8");
}

async function fileRecord(path) {
  const absolutePath = resolve(path);
  const bytes = await readFile(absolutePath);
  return {
    path: relative(ROOT, absolutePath).replaceAll("\\", "/"),
    bytes: bytes.length,
    sha256: sha256(bytes),
  };
}

async function freezeOrVerify() {
  const manifestPath = join(LIFECYCLE_DIRECTORY, "source-lifecycle-freeze.json");
  const sidecarPath = join(LIFECYCLE_DIRECTORY, "source-lifecycle-freeze.sha256");
  if (await exists(manifestPath)) {
    const manifest = await readJson(manifestPath);
    if ((await readFile(sidecarPath, "utf8")).trim() !== sha256(JSON.stringify(manifest))) throw new Error("Source lifecycle freeze manifest changed");
    const changed = [];
    for (const file of manifest.files) {
      const current = await fileRecord(resolve(ROOT, file.path));
      if (current.sha256 !== file.sha256 || current.bytes !== file.bytes) changed.push(file.path);
    }
    if (changed.length) throw new Error(`Source lifecycle frozen files changed: ${changed.join(", ")}`);
    return manifest;
  }
  const parentFreeze = await readJson(join(REPORT, "freeze-manifest.json"));
  const manifest = {
    schema: "int-telemetry-experiment14b-source-lifecycle-freeze/v1",
    frozen_at: new Date().toISOString(),
    orbit_input_state_at_freeze: "causally fresh source content not yet accepted",
    parent_freeze: {
      frozen_at: parentFreeze.frozen_at,
      protocol_sha256: parentFreeze.hashes.protocol_sha256,
      aggregate_code_and_config_sha256: parentFreeze.hashes.aggregate_code_and_config_sha256,
    },
    files: await Promise.all([SCRIPT_PATH, PROTOCOL_PATH].map(fileRecord)),
  };
  await writeJson(manifestPath, manifest);
  await writeFile(sidecarPath, `${sha256(JSON.stringify(manifest))}\n`, "utf8");
  return manifest;
}

async function writeBoundedStorageState() {
  const inputLockPath = join(LIFECYCLE_DIRECTORY, "orbit-input-lock.json");
  const validationLockPath = join(LIFECYCLE_DIRECTORY, "orbit-validation-lock.json");
  const inputLock = await exists(inputLockPath) ? await readJson(inputLockPath) : null;
  const validationLock = await exists(validationLockPath) ? await readJson(validationLockPath) : null;
  const snapshots = [];
  if (inputLock) {
    snapshots.push({
      role: "GP0-model-input",
      acquired_at: inputLock.source_acquired_at,
      source_content_sha256: inputLock.source_content_sha256,
      source_family: inputLock.model_input_source,
      artifact: inputLock.artifacts.model_gp,
    });
  }
  if (validationLock) {
    snapshots.push({
      role: "GP1-blind-future-reference",
      acquired_at: validationLock.source_acquired_at,
      source_content_sha256: validationLock.source_content_sha256,
      source_family: validationLock.model_input_source,
      artifact: validationLock.artifacts.model_gp,
    });
  }
  if (snapshots.length > 2) throw new Error(`Bounded orbit retention violated: ${snapshots.length} logical snapshots`);
  const state = {
    schema: "int-telemetry-experiment14b-bounded-orbit-storage/v1",
    checked_at: new Date().toISOString(),
    policy: "one immutable GP0 plus one immutable blind GP1",
    continuous_refresh: false,
    maximum_logical_snapshots: 2,
    retained_logical_snapshots: snapshots.length,
    retained_snapshot_bytes: snapshots.reduce((sum, snapshot) => sum + Number(snapshot.artifact?.bytes ?? 0), 0),
    snapshots,
    transient_storage: {
      model_input_cache_present: await exists(join(CACHE_DIRECTORY, "starlink-standard-gp-latest.json")) ||
        await exists(join(CACHE_DIRECTORY, "starlink-standard-gp-latest.metadata.json")),
      preflight_acquisition_present: await exists(join(LIFECYCLE_DIRECTORY, "preflight-acquisition")),
      future_validation_cache_present: await exists(join(CACHE_DIRECTORY, "future-validation")),
    },
  };
  await writeJson(join(LIFECYCLE_DIRECTORY, "bounded-storage-state.json"), state);
  return state;
}

function selectedMedianEpochHours(snapshot) {
  return new Date(summarizeOrbitEpochAges(snapshot.satellites, new Date()).epoch_median).getTime() / 3_600_000;
}

async function preflight() {
  const lockPath = join(LIFECYCLE_DIRECTORY, "orbit-input-lock.json");
  if (await exists(lockPath)) return { status: "locked", ready: true, lock: await verifyLock() };
  const acceptedPath = join(LIFECYCLE_DIRECTORY, "orbit-input-preflight-state.json");
  const parentProtocol = await readJson(PARENT_PROTOCOL_PATH);
  if (await exists(acceptedPath)) {
    const accepted = await readJson(acceptedPath);
    if (accepted.ready) {
      const cacheMetadata = await readJson(join(CACHE_DIRECTORY, "starlink-standard-gp-latest.metadata.json"));
      if (accepted.candidate.sha256 === cacheMetadata.sha256) return accepted;
    } else if (accepted.next_retry_at && Date.now() < new Date(accepted.next_retry_at).getTime()) {
      return { status: "pending-source-download-window", ready: false, available_at: accepted.next_retry_at };
    }
  }

  const lifecycleProtocol = await readJson(PROTOCOL_PATH);
  const parentFreeze = await readJson(join(REPORT, "freeze-manifest.json"));
  const dataPath = join(CACHE_DIRECTORY, "starlink-standard-gp-latest.json");
  const metadataPath = join(CACHE_DIRECTORY, "starlink-standard-gp-latest.metadata.json");
  const baselineBytes = await readFile(dataPath);
  const baselineMetadataBytes = await readFile(metadataPath);
  const baselineMetadata = JSON.parse(baselineMetadataBytes.toString("utf8"));
  const baselineRecords = JSON.parse(baselineBytes.toString("utf8"));
  const nextAllowed = new Date(baselineMetadata.next_download_allowed_at ?? new Date(baselineMetadata.acquired_at).getTime() + parentProtocol.orbit.minimum_download_interval_hours * 3_600_000);
  if (Date.now() < nextAllowed.getTime()) {
    return { status: "pending-source-download-window", ready: false, available_at: nextAllowed.toISOString() };
  }

  const candidate = await acquireOrbitJson({
    url: parentProtocol.orbit.standard_gp_url,
    sourceId: "starlink-standard-gp",
    cacheDirectory: CACHE_DIRECTORY,
    outputDirectory: join(LIFECYCLE_DIRECTORY, "preflight-acquisition"),
    minimumRecords: parentProtocol.orbit.minimum_catalog_records,
    minimumDownloadIntervalHours: parentProtocol.orbit.minimum_download_interval_hours,
    requireAcquiredAfter: parentFreeze.windows.orbit_input_not_before,
  });
  const baselineSnapshot = await buildFreshWalkerSnapshot(baselineRecords, {
    sourceUrl: parentProtocol.orbit.standard_gp_url,
    downloadedAt: baselineMetadata.acquired_at,
    planes: parentProtocol.orbit.planes,
    satellitesPerPlane: parentProtocol.orbit.satellites_per_plane,
    raanClusterThresholdDeg: parentProtocol.orbit.raan_cluster_threshold_deg,
  });
  const candidateSnapshot = await buildFreshWalkerSnapshot(candidate.records, {
    sourceUrl: parentProtocol.orbit.standard_gp_url,
    downloadedAt: candidate.acquisition.acquired_at,
    planes: parentProtocol.orbit.planes,
    satellitesPerPlane: parentProtocol.orbit.satellites_per_plane,
    raanClusterThresholdDeg: parentProtocol.orbit.raan_cluster_threshold_deg,
  });
  const baselineMedian = selectedMedianEpochHours(baselineSnapshot);
  const candidateMedian = selectedMedianEpochHours(candidateSnapshot);
  const epochAdvance = candidateMedian - baselineMedian;
  const hashChanged = candidate.acquisition.sha256 !== baselineMetadata.sha256;
  const ready = candidate.acquisition.causality_eligible && hashChanged &&
    epochAdvance >= lifecycleProtocol.input_acceptance.minimum_selected_shell_median_epoch_advance_hours;
  const state = {
    schema: "int-telemetry-experiment14b-orbit-input-preflight/v1",
    status: ready ? "causal-source-content-update-ready" : "pending-source-content-update",
    ready,
    checked_at: new Date().toISOString(),
    next_retry_at: new Date(Date.now() + parentProtocol.orbit.minimum_download_interval_hours * 3_600_000).toISOString(),
    baseline: { acquired_at: baselineMetadata.acquired_at, sha256: baselineMetadata.sha256, selected_epoch_median_hours: baselineMedian },
    candidate: {
      acquired_at: candidate.acquisition.acquired_at,
      sha256: candidate.acquisition.sha256,
      selected_epoch_median_hours: candidateMedian,
      immutable_path: candidate.acquisition.immutable_path ?? null,
    },
    hash_changed: hashChanged,
    selected_epoch_median_advance_hours: epochAdvance,
  };
  if (!ready) {
    await writeFile(dataPath, baselineBytes);
    await writeFile(metadataPath, baselineMetadataBytes);
    await removeIfPresent(join(LIFECYCLE_DIRECTORY, "preflight-acquisition"));
  }
  await writeJson(acceptedPath, state);
  return state;
}

async function lockInput() {
  const lockPath = join(LIFECYCLE_DIRECTORY, "orbit-input-lock.json");
  if (await exists(lockPath)) return verifyLock();
  const preflightState = await readJson(join(LIFECYCLE_DIRECTORY, "orbit-input-preflight-state.json"));
  if (!preflightState.ready) throw new Error("Orbit input preflight has not accepted a changed source version");
  const collection = await readJson(join(REPORT, "collection-status.json"));
  if (!collection.sources.orbit_input?.input_ready || collection.sources.topology?.status !== "complete") {
    throw new Error("Parent orbit input and topology must be complete before locking");
  }
  const parentProtocol = await readJson(PARENT_PROTOCOL_PATH);
  const modelSnapshot = await readJson(join(REPORT, "orbit", "fresh-model-input-walker-72x22.json"));
  const windowStart = new Date(collection.sources.topology.epoch_iso);
  const windowEnd = new Date(windowStart.getTime() +
    parentProtocol.topology_window.slices * parentProtocol.topology_window.step_minutes * 60_000);
  const windowEndFreshness = evaluateOrbitFreshness(modelSnapshot.satellites, windowEnd, {
    minimum_records: parentProtocol.orbit.planes * parentProtocol.orbit.satellites_per_plane,
    maximum_median_age_hours: parentProtocol.orbit.maximum_selected_median_age_hours,
    maximum_p95_age_hours: parentProtocol.orbit.maximum_selected_p95_age_hours,
    maximum_future_epoch_ratio: parentProtocol.orbit.maximum_future_epoch_ratio,
  });
  await writeJson(join(REPORT, "orbit", "selected-shell-window-end-freshness-gate.json"), windowEndFreshness);
  if (!windowEndFreshness.passed) {
    throw new Error("Selected shell fails the orbit-age gate at the end of the 48-slice propagation window");
  }
  const modelInputSource = collection.sources.orbit_input.model_input_source ?? "standard";
  if (!["standard", "supplemental"].includes(modelInputSource)) throw new Error(`Unsupported GP0 source: ${modelInputSource}`);
  const modelAcquisition = collection.sources.orbit_input[modelInputSource];
  if (!modelAcquisition?.sha256 || !modelAcquisition?.acquired_at) throw new Error(`GP0 ${modelInputSource} acquisition metadata is incomplete`);
  if (modelInputSource === "supplemental" && collection.sources.orbit_input.source_selection_gate?.passed !== true) {
    throw new Error("Supplemental GP0 requires a passed frozen source-selection gate");
  }
  const modelGpFilename = modelInputSource === "supplemental"
    ? "starlink-supplemental-gp-acquired.json"
    : "starlink-standard-gp-acquired.json";
  const artifacts = {
    model_gp: await fileRecord(join(REPORT, "orbit", modelGpFilename)),
    walker_snapshot: await fileRecord(join(REPORT, "orbit", "fresh-model-input-walker-72x22.json")),
    topology_nodes: await fileRecord(join(REPORT, "topology", "nodes.csv")),
    topology_links: await fileRecord(join(REPORT, "topology", "links.csv")),
    window_end_freshness_gate: await fileRecord(join(REPORT, "orbit", "selected-shell-window-end-freshness-gate.json")),
  };
  const sourceContentSha256 = modelAcquisition.sha256;
  if (modelInputSource === "standard" && sourceContentSha256 !== preflightState.candidate.sha256) {
    throw new Error("Parent standard GP source content does not match the preflight-accepted source hash");
  }
  const lock = {
    schema: "int-telemetry-experiment14b-orbit-input-lock/v1",
    locked_at: new Date().toISOString(),
    model_input_source: modelInputSource,
    source_id: modelAcquisition.source_id,
    source_url: modelAcquisition.source_url,
    source_acquired_at: modelAcquisition.acquired_at,
    source_content_sha256: sourceContentSha256,
    source_catalog_fingerprint: collection.sources.topology.source_catalog_fingerprint,
    refresh_allowed: false,
    validity_window: {
      start: windowStart.toISOString(),
      end: windowEnd.toISOString(),
      slices: parentProtocol.topology_window.slices,
      step_minutes: parentProtocol.topology_window.step_minutes,
      end_age_gate_passed: windowEndFreshness.passed,
    },
    preflight: preflightState,
    artifacts,
  };
  await writeJson(lockPath, lock);
  if (modelAcquisition.immutable_path) await removeIfPresent(modelAcquisition.immutable_path);
  const nonModelGpPath = join(REPORT, "orbit", modelInputSource === "supplemental"
    ? "starlink-standard-gp-acquired.json"
    : "starlink-supplemental-gp-acquired.json");
  await removeIfPresent(nonModelGpPath);
  await removeIfPresent(CACHE_DIRECTORY);
  await removeIfPresent(join(LIFECYCLE_DIRECTORY, "preflight-acquisition"));
  await writeBoundedStorageState();
  return lock;
}

async function verifyLock() {
  const lock = await readJson(join(LIFECYCLE_DIRECTORY, "orbit-input-lock.json"));
  const changed = [];
  for (const [name, artifact] of Object.entries(lock.artifacts)) {
    const current = await fileRecord(resolve(ROOT, artifact.path));
    if (current.sha256 !== artifact.sha256 || current.bytes !== artifact.bytes) changed.push(name);
  }
  if (changed.length) throw new Error(`Locked orbit/topology artifacts changed: ${changed.join(", ")}`);
  return lock;
}

async function verifyValidationLock() {
  const lock = await readJson(join(LIFECYCLE_DIRECTORY, "orbit-validation-lock.json"));
  const changed = [];
  for (const [name, artifact] of Object.entries(lock.artifacts)) {
    const current = await fileRecord(resolve(ROOT, artifact.path));
    if (current.sha256 !== artifact.sha256 || current.bytes !== artifact.bytes) changed.push(name);
  }
  if (changed.length) throw new Error(`Locked future orbit artifacts changed: ${changed.join(", ")}`);
  return lock;
}

async function collectFutureOrbit(parentProtocol, parentFreeze, lock) {
  const validationLockPath = join(LIFECYCLE_DIRECTORY, "orbit-validation-lock.json");
  if (await exists(validationLockPath)) {
    const validationLock = await verifyValidationLock();
    return {
      status: "complete",
      locked: true,
      acquisition: validationLock.acquisition,
      summary: validationLock.summary,
    };
  }
  if (Date.now() < new Date(parentFreeze.windows.orbit_validation_not_before).getTime()) {
    return { status: "pending-future-window", available_at: parentFreeze.windows.orbit_validation_not_before };
  }
  const directory = join(REPORT, "orbit", "future-validation");
  const cacheDirectory = join(REPORT, "_source-cache", "future-validation");
  const supplemental = lock.model_input_source === "supplemental";
  const sourceId = supplemental ? "starlink-supplemental-gp-validation" : "starlink-standard-gp-validation";
  const sourceUrl = supplemental ? parentProtocol.orbit.supplemental_gp_url : parentProtocol.orbit.standard_gp_url;
  const inputPath = resolve(ROOT, lock.artifacts.model_gp.path);
  await seedOrbitCache({
    cacheDirectory,
    sourceId,
    dataPath: inputPath,
    metadata: { source_url: sourceUrl, acquired_at: lock.source_acquired_at },
  });
  const validation = await acquireOrbitJson({
    url: sourceUrl,
    sourceId,
    cacheDirectory,
    outputDirectory: directory,
    minimumRecords: parentProtocol.orbit.minimum_catalog_records,
    minimumDownloadIntervalHours: parentProtocol.orbit.minimum_download_interval_hours,
    requireAcquiredAfter: parentFreeze.windows.orbit_validation_not_before,
  });
  if (!validation.acquisition.causality_eligible || validation.acquisition.sha256 === lock.source_content_sha256) {
    if (validation.acquisition.immutable_path) await removeIfPresent(validation.acquisition.immutable_path);
    return { status: "pending-source-content-update", acquisition: validation.acquisition };
  }
  const modelSnapshot = await readJson(resolve(ROOT, lock.artifacts.walker_snapshot.path));
  const comparison = compareOrbitEpochs({
    modelSnapshot,
    validationSnapshot: validation.records,
    comparisonTime: medianEpoch(validation.records),
  });
  await writeCsv(join(directory, "orbit-future-errors.csv"), comparison.rows);
  await writeJson(join(directory, "orbit-future-summary.json"), comparison.summary);
  const lockedAcquisition = {
    ...validation.acquisition,
    immutable_path_retained: false,
  };
  const validationLock = {
    schema: "int-telemetry-experiment14b-orbit-validation-lock/v1",
    locked_at: new Date().toISOString(),
    model_input_source_content_sha256: lock.source_content_sha256,
    model_input_source: lock.model_input_source,
    source_id: validation.acquisition.source_id,
    source_url: validation.acquisition.source_url,
    source_acquired_at: validation.acquisition.acquired_at,
    source_content_sha256: validation.acquisition.sha256,
    refresh_allowed: false,
    acquisition: lockedAcquisition,
    summary: comparison.summary,
    artifacts: {
      model_gp: await fileRecord(join(directory, `${sourceId}-acquired.json`)),
      acquisition: await fileRecord(join(directory, `${sourceId}-acquisition.json`)),
      errors: await fileRecord(join(directory, "orbit-future-errors.csv")),
      summary: await fileRecord(join(directory, "orbit-future-summary.json")),
    },
  };
  await writeJson(validationLockPath, validationLock);
  if (validation.acquisition.immutable_path) await removeIfPresent(validation.acquisition.immutable_path);
  await removeIfPresent(cacheDirectory);
  await writeBoundedStorageState();
  return { status: "complete", locked: true, acquisition: lockedAcquisition, summary: comparison.summary };
}

async function safe(operation, source) {
  try {
    return await operation();
  } catch (error) {
    return { status: "failed", source, error: error.stack ?? error.message };
  }
}

async function collectRemaining() {
  const lock = await verifyLock();
  const parentProtocol = await readJson(PARENT_PROTOCOL_PATH);
  const parentFreeze = await readJson(join(REPORT, "freeze-manifest.json"));
  const collectionPath = join(REPORT, "collection-status.json");
  const collection = await readJson(collectionPath);
  const radarToken = process.env[parentProtocol.radar.token_environment_variable] ?? "";
  const ripeKey = process.env[parentProtocol.ripe_atlas.api_key_environment_variable] ?? "";
  collection.generated_at = new Date().toISOString();
  collection.sources.orbit_input.locked = true;
  collection.sources.orbit_input.lock_path = relative(ROOT, join(LIFECYCLE_DIRECTORY, "orbit-input-lock.json")).replaceAll("\\", "/");
  collection.sources.orbit_future_validation = await safe(
    () => collectFutureOrbit(parentProtocol, parentFreeze, lock), "future-orbit",
  );
  collection.sources.radar = await safe(
    () => collectProspectiveRadar(parentProtocol.radar, parentFreeze, join(REPORT, "radar"), radarToken), "radar",
  );
  collection.sources.ripe_atlas = await safe(
    () => collectProspectiveRipe(parentProtocol.ripe_atlas, parentFreeze, join(REPORT, "ripe-atlas"), ripeKey), "ripe-atlas",
  );
  await writeJson(collectionPath, collection);
  return {
    status: "remaining-sources-collected-with-locked-input",
    orbit_future_validation: collection.sources.orbit_future_validation.status,
    radar: collection.sources.radar.status,
    ripe_atlas: collection.sources.ripe_atlas.status,
  };
}

const args = process.argv.slice(2);
const phase = argValue(args, "--phase", "preflight");
const freeze = await freezeOrVerify();
let result;
if (phase === "freeze") result = { status: "source-lifecycle-frozen", frozen_at: freeze.frozen_at };
else if (phase === "preflight") result = await preflight();
else if (phase === "lock") result = await lockInput();
else if (phase === "remaining") result = await collectRemaining();
else throw new Error(`Unknown source lifecycle phase: ${phase}`);
console.log(JSON.stringify({ phase, ...result }, null, 2));
