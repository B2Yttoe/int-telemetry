import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  acquireOrbitJson,
  evaluateOrbitFreshness,
  seedOrbitCache,
  sha256,
} from "./experiments/freshOrbitAcquisition.mjs";
import { compareOrbitEpochs } from "./experiments/crossEpochOrbitValidation.mjs";
import { medianEpoch } from "./experiments/experiment14Sources.mjs";
import {
  collectProspectiveRadar,
  collectProspectiveRipe,
} from "./experiments/experiment14bExternalSources.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPORT = resolve(ROOT, "reports/experiment14b-prospective-external-validation");
const RECOVERY_DIRECTORY = join(REPORT, "relocation-recovery");
const LIFECYCLE_DIRECTORY = join(REPORT, "source-lifecycle");
const PROTOCOL_PATH = resolve(ROOT, "scripts/experiments/experiment14b-relocation-recovery-protocol.json");
const PARENT_PROTOCOL_PATH = resolve(ROOT, "scripts/experiments/experiment14b-protocol.json");
const SCRIPT_PATH = resolve(ROOT, "scripts/runExperiment14BRelocationRecovery.mjs");
const FREEZE_PATH = join(RECOVERY_DIRECTORY, "recovery-freeze.json");
const FREEZE_SIDECAR_PATH = join(RECOVERY_DIRECTORY, "recovery-freeze.sha256");

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

function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

async function writeCsv(path, rows) {
  await mkdir(dirname(path), { recursive: true });
  if (!rows.length) {
    await writeFile(path, "", "utf8");
    return;
  }
  const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const lines = [headers.join(","), ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(","))];
  await writeFile(path, `${lines.join("\n")}\n`, "utf8");
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

function parentFreezeGuard() {
  const guard = resolve(ROOT, "scripts/runExperiment14BGuarded.mjs");
  const result = spawnSync(process.execPath, [guard, "--verify-only"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (result.status !== 0 || !result.stdout.includes("freeze-integrity-verified")) {
    throw new Error((result.stderr || result.stdout || "Parent Experiment 14B freeze verification failed").trim());
  }
  return JSON.parse(result.stdout);
}

async function freezeRecovery() {
  if (await exists(FREEZE_PATH)) return verifyRecoveryFreeze();
  const parentFreeze = await readJson(join(REPORT, "freeze-manifest.json"));
  const protocol = await readFile(PROTOCOL_PATH);
  const manifest = {
    schema: "int-telemetry-experiment14b-relocation-recovery-freeze/v1",
    frozen_at: new Date().toISOString(),
    evidence_state_at_freeze: "GP0 locked; GP1 and strict future external sources incomplete",
    parent_freeze: {
      frozen_at: parentFreeze.frozen_at,
      protocol_sha256: parentFreeze.hashes.protocol_sha256,
      aggregate_code_and_config_sha256: parentFreeze.hashes.aggregate_code_and_config_sha256,
    },
    recovery_protocol_sha256: sha256(protocol),
    files: await Promise.all([SCRIPT_PATH, PROTOCOL_PATH].map(fileRecord)),
  };
  await writeJson(FREEZE_PATH, manifest);
  await writeFile(FREEZE_SIDECAR_PATH, `${sha256(JSON.stringify(manifest))}\n`, "utf8");
  return manifest;
}

async function verifyRecoveryFreeze() {
  if (!(await exists(FREEZE_PATH))) throw new Error("Relocation recovery is not frozen; run --phase freeze first");
  const manifest = await readJson(FREEZE_PATH);
  const sidecar = (await readFile(FREEZE_SIDECAR_PATH, "utf8")).trim();
  if (sidecar !== sha256(JSON.stringify(manifest))) throw new Error("Relocation recovery freeze manifest changed");
  const changed = [];
  for (const record of manifest.files) if (!(await verifyRecord(record))) changed.push(record.path);
  if (changed.length) throw new Error(`Relocation recovery frozen files changed: ${changed.join(", ")}`);
  const parent = parentFreezeGuard();
  if (parent.protocol_sha256 !== manifest.parent_freeze.protocol_sha256) throw new Error("Parent protocol hash changed");
  return manifest;
}

async function verifyInputLock() {
  const lockPath = join(LIFECYCLE_DIRECTORY, "orbit-input-lock.json");
  if (!(await exists(lockPath))) throw new Error("Immutable GP0 input lock is missing");
  const lock = await readJson(lockPath);
  const changed = [];
  for (const [name, record] of Object.entries(lock.artifacts ?? {})) {
    if (!(await verifyRecord(record))) changed.push(name);
  }
  if (changed.length) throw new Error(`Locked GP0/topology artifacts changed: ${changed.join(", ")}`);
  return lock;
}

async function verifyValidationLock() {
  const lockPath = join(LIFECYCLE_DIRECTORY, "orbit-validation-lock.json");
  const lock = await readJson(lockPath);
  const changed = [];
  for (const [name, record] of Object.entries(lock.artifacts ?? {})) {
    if (!(await verifyRecord(record))) changed.push(name);
  }
  if (changed.length) throw new Error(`Locked GP1 artifacts changed: ${changed.join(", ")}`);
  return lock;
}

async function removeTransient(path) {
  const absolute = resolve(path);
  if (!absolute.startsWith(`${REPORT}${sep}`)) throw new Error(`Refusing to remove path outside Experiment 14B: ${absolute}`);
  if (await exists(absolute)) await rm(absolute, { recursive: true, force: true });
}

async function restoreLockedOrbitInput(lock) {
  const resultsPath = join(REPORT, "experiment14b-results.json");
  const priorResults = await readJson(resultsPath);
  const prior = priorResults.orbit_input ?? {};
  const freshness = await readJson(resolve(ROOT, lock.artifacts.window_end_freshness_gate.path.replace("window-end-", ""))).catch(async () => {
    const startPath = resolve(ROOT, "reports/experiment14b-prospective-external-validation/orbit/selected-shell-freshness-gate.json");
    return readJson(startPath);
  });
  const windowEndFreshness = await readJson(resolve(ROOT, lock.artifacts.window_end_freshness_gate.path));
  const selection = await readJson(join(REPORT, "orbit-source-failover", "source-selection-result.json"));
  if (!freshness.passed || !windowEndFreshness.passed || selection.source_selection_gate?.passed !== true) {
    throw new Error("Locked GP0 no longer has complete age/source-selection evidence");
  }
  return {
    ...prior,
    status: "complete-supplemental-gp-failover",
    input_ready: true,
    freshness,
    window_end_freshness: windowEndFreshness,
    snapshot_path: lock.artifacts.walker_snapshot.path,
    model_input_source: lock.model_input_source,
    source_selection_gate: selection.source_selection_gate,
    locked: true,
    lock_path: relative(ROOT, join(LIFECYCLE_DIRECTORY, "orbit-input-lock.json")).replaceAll("\\", "/"),
  };
}

async function writeBoundedStorageState(inputLock, validationLock = null) {
  const snapshots = [{
    role: "GP0-model-input",
    acquired_at: inputLock.source_acquired_at,
    source_content_sha256: inputLock.source_content_sha256,
    source_family: inputLock.model_input_source,
    artifact: inputLock.artifacts.model_gp,
  }];
  if (validationLock) snapshots.push({
    role: "GP1-blind-future-reference",
    acquired_at: validationLock.source_acquired_at,
    source_content_sha256: validationLock.source_content_sha256,
    source_family: validationLock.model_input_source,
    artifact: validationLock.artifacts.model_gp,
  });
  if (snapshots.length > 2) throw new Error("Bounded orbit retention violated");
  const state = {
    schema: "int-telemetry-experiment14b-bounded-orbit-storage/v2",
    checked_at: new Date().toISOString(),
    policy: "one immutable GP0 plus one immutable blind GP1",
    continuous_refresh: false,
    maximum_logical_snapshots: 2,
    retained_logical_snapshots: snapshots.length,
    retained_snapshot_bytes: snapshots.reduce((sum, row) => sum + Number(row.artifact?.bytes ?? 0), 0),
    snapshots,
  };
  await writeJson(join(LIFECYCLE_DIRECTORY, "bounded-storage-state.json"), state);
  return state;
}

async function collectFutureOrbit(parentProtocol, parentFreeze, inputLock) {
  const validationLockPath = join(LIFECYCLE_DIRECTORY, "orbit-validation-lock.json");
  if (await exists(validationLockPath)) {
    const validationLock = await verifyValidationLock();
    return { status: "complete", locked: true, acquisition: validationLock.acquisition, freshness: validationLock.freshness, summary: validationLock.summary };
  }
  const notBefore = new Date(parentFreeze.windows.orbit_validation_not_before).getTime();
  if (Date.now() < notBefore) return { status: "pending-future-window", available_at: parentFreeze.windows.orbit_validation_not_before };

  const directory = join(REPORT, "orbit", "future-validation");
  const cacheDirectory = join(REPORT, "_source-cache", "future-validation");
  const supplemental = inputLock.model_input_source === "supplemental";
  const sourceId = supplemental ? "starlink-supplemental-gp-validation" : "starlink-standard-gp-validation";
  const sourceUrl = supplemental ? parentProtocol.orbit.supplemental_gp_url : parentProtocol.orbit.standard_gp_url;
  await seedOrbitCache({
    cacheDirectory,
    sourceId,
    dataPath: resolve(ROOT, inputLock.artifacts.model_gp.path),
    metadata: { source_url: sourceUrl, acquired_at: inputLock.source_acquired_at },
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
  if (!validation.acquisition.causality_eligible || validation.acquisition.sha256 === inputLock.source_content_sha256) {
    if (validation.acquisition.immutable_path) await removeTransient(validation.acquisition.immutable_path);
    return { status: "pending-source-content-update", acquisition: validation.acquisition };
  }
  const freshness = evaluateOrbitFreshness(validation.records, new Date(validation.acquisition.acquired_at), {
    minimum_records: parentProtocol.orbit.minimum_catalog_records,
    maximum_median_age_hours: parentProtocol.orbit.maximum_selected_median_age_hours,
    maximum_p95_age_hours: parentProtocol.orbit.maximum_selected_p95_age_hours,
    maximum_future_epoch_ratio: parentProtocol.orbit.maximum_future_epoch_ratio,
  });
  if (!freshness.passed) return { status: "failed-freshness-gate", acquisition: validation.acquisition, freshness };

  const modelSnapshot = await readJson(resolve(ROOT, inputLock.artifacts.walker_snapshot.path));
  const comparison = compareOrbitEpochs({
    modelSnapshot,
    validationSnapshot: validation.records,
    comparisonTime: medianEpoch(validation.records),
  });
  await writeCsv(join(directory, "orbit-future-errors.csv"), comparison.rows);
  await writeJson(join(directory, "orbit-future-summary.json"), comparison.summary);
  const lockedAcquisition = { ...validation.acquisition, immutable_path_retained: false };
  const validationLock = {
    schema: "int-telemetry-experiment14b-orbit-validation-lock/v2",
    locked_at: new Date().toISOString(),
    model_input_source_content_sha256: inputLock.source_content_sha256,
    model_input_source: inputLock.model_input_source,
    source_id: validation.acquisition.source_id,
    source_url: validation.acquisition.source_url,
    source_acquired_at: validation.acquisition.acquired_at,
    source_content_sha256: validation.acquisition.sha256,
    refresh_allowed: false,
    acquisition: lockedAcquisition,
    freshness,
    summary: comparison.summary,
    artifacts: {
      model_gp: await fileRecord(join(directory, `${sourceId}-acquired.json`)),
      acquisition: await fileRecord(join(directory, `${sourceId}-acquisition.json`)),
      errors: await fileRecord(join(directory, "orbit-future-errors.csv")),
      summary: await fileRecord(join(directory, "orbit-future-summary.json")),
    },
  };
  await writeJson(validationLockPath, validationLock);
  if (validation.acquisition.immutable_path) await removeTransient(validation.acquisition.immutable_path);
  await removeTransient(cacheDirectory);
  await writeBoundedStorageState(inputLock, validationLock);
  return { status: "complete", locked: true, acquisition: lockedAcquisition, freshness, summary: comparison.summary };
}

async function safe(source, operation) {
  try {
    return await operation();
  } catch (error) {
    return { status: "failed", source, error: error.stack ?? error.message };
  }
}

async function collect() {
  await verifyRecoveryFreeze();
  const inputLock = await verifyInputLock();
  const parentProtocol = await readJson(PARENT_PROTOCOL_PATH);
  const parentFreeze = await readJson(join(REPORT, "freeze-manifest.json"));
  const collectionPath = join(REPORT, "collection-status.json");
  const collection = await readJson(collectionPath);
  collection.generated_at = new Date().toISOString();
  collection.sources.orbit_input = await restoreLockedOrbitInput(inputLock);
  collection.sources.orbit_future_validation = await safe("future-orbit", () => collectFutureOrbit(parentProtocol, parentFreeze, inputLock));
  collection.sources.radar = await safe("radar", () => collectProspectiveRadar(
    parentProtocol.radar,
    parentFreeze,
    join(REPORT, "radar"),
    process.env[parentProtocol.radar.token_environment_variable] ?? "",
  ));
  collection.sources.ripe_atlas = await safe("ripe-atlas", () => collectProspectiveRipe(
    parentProtocol.ripe_atlas,
    parentFreeze,
    join(REPORT, "ripe-atlas"),
    process.env[parentProtocol.ripe_atlas.api_key_environment_variable] ?? "",
  ));
  await writeJson(collectionPath, collection);
  const state = {
    schema: "int-telemetry-experiment14b-relocation-recovery-state/v1",
    generated_at: new Date().toISOString(),
    parent_freeze_verified: true,
    gp0_lock_verified: true,
    statuses: Object.fromEntries(Object.entries(collection.sources).map(([name, value]) => [name, value.status])),
    strict_claims_promoted: false,
  };
  await writeJson(join(RECOVERY_DIRECTORY, "recovery-state.json"), state);
  return state;
}

const args = process.argv.slice(2);
const phase = argValue(args, "--phase", "verify");
let result;
if (phase === "freeze") result = await freezeRecovery();
else if (phase === "verify") result = await verifyRecoveryFreeze();
else if (phase === "collect") result = await collect();
else throw new Error(`Unknown relocation recovery phase: ${phase}`);
console.log(JSON.stringify({ phase, ...result }, null, 2));
