import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRadarBlindHoldout } from "./experiments/blindValidationMetrics.mjs";
import { extractRadarSeries } from "./experiments/experiment14Sources.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const OUTPUT = resolve(ROOT, "reports/experiment14b-prospective-external-validation-v2-utc-corrected");
const DIRECTORY = join(OUTPUT, "radar", "causality-status-addendum");
const PROTOCOL_PATH = resolve(ROOT, "scripts/experiments/experiment14b-v2-radar-causality-addendum.json");
const V2_PROTOCOL_PATH = resolve(ROOT, "scripts/experiments/experiment14b-v2-protocol.json");
const PARENT_PROTOCOL_PATH = resolve(ROOT, "scripts/experiments/experiment14b-protocol.json");
const FROZEN_INPUTS = [
  fileURLToPath(import.meta.url),
  PROTOCOL_PATH,
  V2_PROTOCOL_PATH,
  PARENT_PROTOCOL_PATH,
  resolve(ROOT, "scripts/runExperiment14BProspectiveValidationV2.mjs"),
  resolve(ROOT, "scripts/experiments/experiment14bExternalSources.mjs"),
  resolve(ROOT, "scripts/experiments/experiment14Sources.mjs"),
  resolve(ROOT, "scripts/experiments/blindValidationMetrics.mjs"),
];

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
async function exists(path) { try { await stat(path); return true; } catch { return false; } }
async function readJson(path) { return JSON.parse(await readFile(path, "utf8")); }
async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
async function fileRecord(path) {
  const content = await readFile(path);
  return { path: relative(ROOT, path).replaceAll("\\", "/"), bytes: content.length, sha256: sha256(content) };
}
async function recordValid(expected) {
  const path = resolve(ROOT, expected.path);
  if (!(await exists(path))) return false;
  const current = await fileRecord(path);
  return current.bytes === expected.bytes && current.sha256 === expected.sha256;
}
async function allRecordsValid(records) {
  for (const record of records ?? []) if (!(await recordValid(record))) return false;
  return true;
}
function timestamp(value) {
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}
function sameNumbers(left, right, tolerance = 1e-9) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  return left.every((value, index) => Math.abs(Number(value) - Number(right[index])) <= tolerance);
}

function seriesChecks(rows, start, end, maximumGapSeconds) {
  const times = rows.map((row) => timestamp(row.time));
  const finite = times.every((value) => value !== null) && rows.every((row) => Number.isFinite(Number(row.value)));
  const orderedUnique = finite && times.every((value, index) => index === 0 || value > times[index - 1]);
  const insideWindow = finite && times.every((value) => value >= start && value <= end);
  const maximumGap = times.length > 1
    ? Math.max(...times.slice(1).map((value, index) => (value - times[index]) / 1000))
    : Infinity;
  return {
    finite,
    ordered_unique_timestamps: orderedUnique,
    inside_window: insideWindow,
    maximum_gap_seconds: maximumGap,
    bounded_hourly_gaps: Number.isFinite(maximumGap) && maximumGap <= maximumGapSeconds,
  };
}

export function validateRadarCausalityEvidence({
  calibration,
  test,
  collectionMetadata,
  score,
  freezeManifest,
  parentRadar,
  addendum,
}) {
  const failures = [];
  const calibrationStart = timestamp(freezeManifest.windows.radar_calibration_start);
  const calibrationEnd = timestamp(freezeManifest.windows.radar_calibration_end);
  const testStart = timestamp(freezeManifest.windows.radar_test_start);
  const testEnd = timestamp(freezeManifest.windows.radar_test_end);
  const acquiredAt = timestamp(collectionMetadata.acquired_at);
  const calibrationAudit = seriesChecks(calibration, calibrationStart, calibrationEnd, addendum.maximum_hourly_gap_seconds);
  const testAudit = seriesChecks(test, testStart, testEnd, addendum.maximum_hourly_gap_seconds);
  const calibrationTimes = new Set(calibration.map((row) => String(row.time)));
  const overlap = test.filter((row) => calibrationTimes.has(String(row.time))).length;

  if (calibration.length < addendum.minimum_calibration_points) failures.push("insufficient-calibration-points");
  if (test.length < addendum.minimum_test_points) failures.push("insufficient-test-points");
  if (!(acquiredAt !== null && testEnd !== null && acquiredAt >= testEnd)) failures.push("collection-before-test-window-end");
  if (!calibrationAudit.finite || !calibrationAudit.inside_window) failures.push("calibration-outside-frozen-window");
  if (!testAudit.finite || !testAudit.inside_window) failures.push("test-outside-frozen-window");
  if (!calibrationAudit.ordered_unique_timestamps || !testAudit.ordered_unique_timestamps) failures.push("unordered-or-duplicate-timestamps");
  if (!calibrationAudit.bounded_hourly_gaps || !testAudit.bounded_hourly_gaps) failures.push("radar-timeseries-gap-too-large");
  if (overlap !== 0 || Number(collectionMetadata.timestamp_overlap) !== 0) failures.push("calibration-test-overlap");
  if (Number(collectionMetadata.calibration_points) !== calibration.length) failures.push("calibration-count-mismatch");
  if (Number(collectionMetadata.test_points) !== test.length) failures.push("test-count-mismatch");
  if (Number(collectionMetadata.test_values_used_for_fit) !== 0) failures.push("collection-test-values-used-for-fit");
  if (Number(score.test_values_used_for_fit) !== 0) failures.push("score-test-values-used-for-fit");
  if (Number(score.test_values_used_for_interval_calibration) !== 0) failures.push("test-values-used-for-interval-calibration");

  let recomputed = null;
  try {
    recomputed = buildRadarBlindHoldout([...calibration, ...test], {
      train_fraction: calibration.length / (calibration.length + test.length),
      fit_fraction_within_train: parentRadar.fit_fraction_within_calibration,
      ridge_lambda: parentRadar.ridge_lambda,
      prediction_interval_coverage: parentRadar.prediction_interval_coverage,
      traffic_weight_min: parentRadar.traffic_weight_min,
      traffic_weight_max: parentRadar.traffic_weight_max,
    });
    if (!sameNumbers(recomputed.coefficients, score.coefficients)) failures.push("score-coefficients-not-reproducible");
    for (const key of [
      "calibration_points", "fit_points", "interval_calibration_points", "blind_test_points",
      "calibration_start", "calibration_end", "blind_test_start", "blind_test_end",
    ]) {
      if (String(recomputed.summary[key]) !== String(score[key])) failures.push(`score-summary-mismatch:${key}`);
    }
  } catch (error) {
    failures.push(`score-recomputation-failed:${error.message}`);
  }

  return {
    schema: "int-telemetry-experiment14b-v2-radar-causality-validation/v1",
    generated_at: new Date().toISOString(),
    passed: failures.length === 0,
    failures,
    calibration_points: calibration.length,
    test_points: test.length,
    timestamp_overlap: overlap,
    calibration_series: calibrationAudit,
    test_series: testAudit,
    score_recomputed: Boolean(recomputed),
    score_coefficients_reproduced: Boolean(recomputed && sameNumbers(recomputed.coefficients, score.coefficients)),
    test_values_used_for_fit: 0,
    test_values_used_for_interval_calibration: 0,
    post_test_parameter_updates: 0,
  };
}

async function freeze() {
  const path = join(DIRECTORY, "freeze.json");
  if (await exists(path)) return verifyFreeze();
  if (await exists(join(OUTPUT, "radar", "radar-prospective-score.json"))) {
    throw new Error("Radar future score already exists; causality addendum is no longer pre-result");
  }
  const manifest = {
    schema: "int-telemetry-experiment14b-v2-radar-causality-freeze/v1",
    frozen_at: new Date().toISOString(),
    parent_freeze: await fileRecord(join(OUTPUT, "freeze-manifest.json")),
    files: await Promise.all(FROZEN_INPUTS.map(fileRecord)),
    future_radar_result_values_observed_by_freeze: 0,
    post_test_parameter_updates_allowed: false,
  };
  await writeJson(path, manifest);
  return manifest;
}

async function verifyFreeze() {
  const path = join(DIRECTORY, "freeze.json");
  if (!(await exists(path))) throw new Error("Radar causality addendum is not frozen");
  const frozen = await readJson(path);
  if (!(await recordValid(frozen.parent_freeze))) throw new Error("Experiment 14B v2 parent freeze changed");
  if (!(await allRecordsValid(frozen.files))) throw new Error("Radar causality addendum freeze changed");
  return frozen;
}

async function finalize() {
  const frozen = await verifyFreeze();
  const lockPath = join(DIRECTORY, "causality-lock.json");
  if (await exists(lockPath)) return audit();
  const requiredPaths = {
    calibration_payload: join(OUTPUT, "radar", "radar-calibration-payload.json"),
    test_payload: join(OUTPUT, "radar", "radar-prospective-test-payload.json"),
    collection_metadata: join(OUTPUT, "radar", "radar-collection-metadata.json"),
    score: join(OUTPUT, "radar", "radar-prospective-score.json"),
    external_status: join(OUTPUT, "external-collection-status.json"),
  };
  for (const [name, path] of Object.entries(requiredPaths)) {
    if (!(await exists(path))) return { status: `pending-${name.replaceAll("_", "-")}` };
  }
  const [calibrationPayload, testPayload, collectionMetadata, score, freezeManifest, parentProtocol, addendum, externalStatus] =
    await Promise.all([
      readJson(requiredPaths.calibration_payload),
      readJson(requiredPaths.test_payload),
      readJson(requiredPaths.collection_metadata),
      readJson(requiredPaths.score),
      readJson(join(OUTPUT, "freeze-manifest.json")),
      readJson(PARENT_PROTOCOL_PATH),
      readJson(PROTOCOL_PATH),
      readJson(requiredPaths.external_status),
    ]);
  if (externalStatus?.radar?.status !== "complete") throw new Error("Canonical Radar collection status is not complete");
  const validation = validateRadarCausalityEvidence({
    calibration: extractRadarSeries(calibrationPayload),
    test: extractRadarSeries(testPayload),
    collectionMetadata,
    score,
    freezeManifest,
    parentRadar: parentProtocol.radar,
    addendum,
  });
  await writeJson(join(DIRECTORY, "validation.json"), validation);
  if (!validation.passed) throw new Error(`Radar causality validation failed: ${validation.failures.join(", ")}`);

  const originalStatus = await fileRecord(requiredPaths.external_status);
  externalStatus.radar = {
    ...externalStatus.radar,
    test_values_used_for_fit: 0,
    test_values_used_for_interval_calibration: 0,
    post_test_parameter_updates: 0,
    causality_validation: "pre-registered-addendum-passed",
  };
  await writeJson(requiredPaths.external_status, externalStatus);
  const lock = {
    schema: "int-telemetry-experiment14b-v2-radar-causality-lock/v1",
    locked_at: new Date().toISOString(),
    frozen_at: frozen.frozen_at,
    validation,
    original_external_status: originalStatus,
    artifacts: {
      ...Object.fromEntries(await Promise.all(Object.entries(requiredPaths).map(async ([name, path]) => [name, await fileRecord(path)]))),
      validation: await fileRecord(join(DIRECTORY, "validation.json")),
    },
  };
  await writeJson(lockPath, lock);
  return audit();
}

async function audit() {
  const frozen = await verifyFreeze();
  const lockPath = join(DIRECTORY, "causality-lock.json");
  const lock = await exists(lockPath) ? await readJson(lockPath) : null;
  const artifactsIntegral = Boolean(lock && await allRecordsValid(Object.values(lock.artifacts ?? {})));
  const complete = Boolean(artifactsIntegral && lock.validation?.passed &&
    lock.validation?.test_values_used_for_fit === 0 &&
    lock.validation?.test_values_used_for_interval_calibration === 0 &&
    lock.validation?.post_test_parameter_updates === 0);
  const result = {
    schema: "int-telemetry-experiment14b-v2-radar-causality-audit/v1",
    generated_at: new Date().toISOString(),
    frozen_at: frozen.frozen_at,
    evidence_status: complete ? "radar-causality-status-complete" : "radar-causality-status-pending",
    checks: {
      causality_lock_present: Boolean(lock),
      artifacts_integral: artifactsIntegral,
      validation_passed: Boolean(lock?.validation?.passed),
      test_values_used_for_fit_zero: lock?.validation?.test_values_used_for_fit === 0,
      interval_calibration_uses_test_zero: lock?.validation?.test_values_used_for_interval_calibration === 0,
      post_test_updates_zero: lock?.validation?.post_test_parameter_updates === 0,
    },
  };
  await writeJson(join(DIRECTORY, "audit.json"), result);
  return result;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const args = process.argv.slice(2);
  let result;
  if (args.includes("--freeze")) result = await freeze();
  else if (args.includes("--finalize")) result = await finalize();
  else result = await audit();
  console.log(JSON.stringify(result, null, 2));
}
