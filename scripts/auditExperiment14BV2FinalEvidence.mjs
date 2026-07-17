import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(import.meta.dirname, "..");
const OUTPUT = resolve(ROOT, "reports/experiment14b-prospective-external-validation-v2-utc-corrected");
const DIRECTORY = join(OUTPUT, "final-evidence-chain-addendum");
const PROTOCOL_PATH = resolve(ROOT, "scripts/experiments/experiment14b-v2-final-evidence-addendum.json");

const CHILD_FREEZES = [
  join(OUTPUT, "freeze-manifest.json"),
  join(OUTPUT, "strict-completion-addendum/freeze.json"),
  join(OUTPUT, "strict-pairing-addendum/freeze.json"),
  join(OUTPUT, "strict-scoring-addendum/freeze.json"),
  join(OUTPUT, "ripe-public-fixed-anchor/freeze.json"),
  join(OUTPUT, "radar/causality-status-addendum/freeze.json"),
  join(OUTPUT, "mlab/provenance-addendum/freeze.json"),
  join(OUTPUT, "mlab/query-semantics-correction/freeze.json"),
  join(OUTPUT, "mlab/bigquery-collector/freeze.json"),
];

const FROZEN_INPUTS = [
  fileURLToPath(import.meta.url),
  PROTOCOL_PATH,
  ...CHILD_FREEZES,
  join(OUTPUT, "gp0-lock.json"),
  join(OUTPUT, "mlab/query-semantics-correction/query-lock.json"),
  join(OUTPUT, "mlab/strict-window-query.sql"),
  resolve(ROOT, "reports/experiment13-system-validation/experiment13-system-validation-summary.json"),
  resolve(ROOT, "project-docs/EXPERIMENT_14B_VALIDITY_BOUNDARIES.md"),
];

const FUTURE_RESULT_PATHS = [
  join(OUTPUT, "gp1-lock.json"),
  join(OUTPUT, "radar/radar-prospective-score.json"),
  join(OUTPUT, "radar/causality-status-addendum/causality-lock.json"),
  join(OUTPUT, "ripe-public-fixed-anchor/result-lock.json"),
  join(OUTPUT, "mlab/bigquery-collector/result-lock.json"),
  join(OUTPUT, "mlab/provenance-addendum/input-lock.json"),
  join(OUTPUT, "mlab/strict-future/import-lock.json"),
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
  if (!expected?.path || !(await exists(resolve(ROOT, expected.path)))) return false;
  const current = await fileRecord(resolve(ROOT, expected.path));
  return current.bytes === expected.bytes && current.sha256 === expected.sha256;
}
async function allRecordsValid(records) {
  for (const record of records ?? []) if (!(await recordValid(record))) return false;
  return true;
}
function recordObjects(value, output = []) {
  if (!value || typeof value !== "object") return output;
  if (typeof value.path === "string" && Number.isFinite(Number(value.bytes)) && typeof value.sha256 === "string") {
    output.push(value);
    return output;
  }
  for (const child of Array.isArray(value) ? value : Object.values(value)) recordObjects(child, output);
  return output;
}
async function childFreezeIntegral(path) {
  if (!(await exists(path))) return false;
  const freeze = await readJson(path);
  const records = recordObjects(freeze);
  return records.length > 0 && await allRecordsValid(records);
}
async function readIfExists(path) { return await exists(path) ? await readJson(path) : null; }
async function lockWithIntegrity(path) {
  const lock = await readIfExists(path);
  if (!lock) return { lock: null, integral: false };
  const records = [
    ...recordObjects(lock.artifacts ?? {}),
    ...(lock.source_csv?.path ? [lock.source_csv] : []),
    ...(lock.corrected_query?.path ? [lock.corrected_query] : []),
  ];
  return { lock, integral: records.length > 0 && await allRecordsValid(records) };
}

export function evaluateFinalEvidence(evidence) {
  const minimumPairs = Number(evidence.minimumPairs ?? 20);
  const mlabPairs = Number(evidence.pairing?.sources?.mlab_ndt7?.strict_pairs ?? 0);
  const ripePairs = Number(evidence.pairing?.sources?.ripe_atlas_exact_anchor?.strict_pairs ?? 0);
  const checks = {
    freeze_chain_integral: evidence.freezeChainIntegral === true,
    gp0_fresh_input_locked: Boolean(evidence.gp0Integral && evidence.gp0?.start_freshness?.passed &&
      evidence.gp0?.window_end_freshness?.passed && evidence.gp0?.source_content_changed_after_freeze),
    gp1_blind_orbit_validation: Boolean(evidence.gp1Integral && evidence.gp1?.differs_from_gp0 && evidence.gp1?.summary),
    radar_prospective_causality: evidence.radarAudit?.evidence_status === "radar-causality-status-complete" &&
      evidence.radarLockIntegral === true,
    mlab_query_semantics_locked: evidence.queryAudit?.evidence_status === "query-semantics-correction-complete" &&
      evidence.queryLockIntegral === true,
    mlab_bigquery_provenance: evidence.bigQueryResultIntegral === true &&
      evidence.provenanceAudit?.evidence_status === "strict-mlab-provenance-complete" &&
      evidence.mlabImportIntegral === true,
    ripe_fixed_anchor_future_window: evidence.ripeResultIntegral === true &&
      evidence.ripeResult?.source_validation?.passed === true &&
      Number(evidence.ripeResult?.result_count ?? 0) >= minimumPairs,
    strict_pairing_complete: evidence.pairing?.evidence_status === "strict-time-geography-server-pairing-complete" &&
      mlabPairs >= minimumPairs && ripePairs >= minimumPairs,
    strict_scoring_complete: evidence.strictScore?.evidence_status === "strict-external-metric-scoring-complete" &&
      Number(evidence.strictScore?.scores?.mlab_ndt7?.rtt?.sample_count ?? 0) >= minimumPairs &&
      Number(evidence.strictScore?.scores?.mlab_ndt7?.throughput?.sample_count ?? 0) >= minimumPairs &&
      Number(evidence.strictScore?.scores?.ripe_atlas_exact_anchor?.rtt?.sample_count ?? 0) >= minimumPairs,
    ns3_cross_validation_complete: evidence.ns3?.evidence_status === "ns3-system-cross-validation-complete",
    internal_claim_boundary_locked: evidence.claimBoundaryIntegral === true,
    zero_test_leakage_and_updates: evidence.queryLock?.test_values_used_for_fit === 0 &&
      evidence.queryLock?.post_test_parameter_updates === 0 &&
      evidence.bigQueryResult?.test_values_used_for_fit === 0 &&
      evidence.bigQueryResult?.post_test_parameter_updates === 0 &&
      evidence.mlabImport?.test_values_used_for_fit === 0 &&
      evidence.mlabImport?.post_test_parameter_updates === 0 &&
      evidence.ripeResult?.test_values_used_for_fit === 0 &&
      evidence.ripeResult?.post_test_parameter_updates === 0 &&
      evidence.radarAudit?.checks?.test_values_used_for_fit_zero === true &&
      evidence.radarAudit?.checks?.interval_calibration_uses_test_zero === true &&
      evidence.radarAudit?.checks?.post_test_updates_zero === true &&
      evidence.strictScore?.test_target_values_used_for_fit === 0 &&
      evidence.strictScore?.post_test_parameter_updates === 0,
    canonical_completion_complete: evidence.completion?.evidence_status === "strict-prospective-validation-complete",
  };
  return {
    checks,
    complete: Object.values(checks).every(Boolean),
    completion_count: Object.values(checks).filter(Boolean).length,
    required_count: Object.keys(checks).length,
    strict_pair_counts: { mlab_ndt7: mlabPairs, ripe_atlas_exact_anchor: ripePairs },
  };
}

async function freeze() {
  const path = join(DIRECTORY, "freeze.json");
  if (await exists(path)) return verifyFreeze();
  const missing = [];
  for (const input of FROZEN_INPUTS) if (!(await exists(input))) missing.push(relative(ROOT, input).replaceAll("\\", "/"));
  if (missing.length) throw new Error(`Final evidence inputs are missing: ${missing.join(", ")}`);
  const observed = [];
  for (const resultPath of FUTURE_RESULT_PATHS) if (await exists(resultPath)) observed.push(relative(ROOT, resultPath).replaceAll("\\", "/"));
  if (observed.length) throw new Error(`Future result artifacts already exist: ${observed.join(", ")}`);
  for (const childFreeze of CHILD_FREEZES) {
    if (!(await childFreezeIntegral(childFreeze))) throw new Error(`Child freeze is not integral: ${relative(ROOT, childFreeze)}`);
  }
  const gp0 = await readJson(join(OUTPUT, "gp0-lock.json"));
  const manifest = {
    schema: "int-telemetry-experiment14b-v2-final-evidence-freeze/v1",
    frozen_at: new Date().toISOString(),
    freeze_stage: "after-gp0-before-gp1-radar-ripe-mlab-results",
    files: await Promise.all(FROZEN_INPUTS.map(fileRecord)),
    gp0_source_acquired_at: gp0.source_acquired_at,
    gp0_source_content_sha256: gp0.source_content_sha256,
    future_result_artifacts_observed_by_freeze: 0,
    post_result_parameter_updates_allowed: false,
  };
  await writeJson(path, manifest);
  return manifest;
}

async function verifyFreeze() {
  const path = join(DIRECTORY, "freeze.json");
  if (!(await exists(path))) throw new Error("Final evidence chain addendum is not frozen");
  const manifest = await readJson(path);
  if (!(await allRecordsValid(manifest.files))) throw new Error("Final evidence chain freeze changed");
  for (const childFreeze of CHILD_FREEZES) {
    if (!(await childFreezeIntegral(childFreeze))) throw new Error(`Child freeze changed: ${relative(ROOT, childFreeze)}`);
  }
  return manifest;
}

async function audit() {
  const frozen = await verifyFreeze();
  const protocol = await readJson(PROTOCOL_PATH);
  const gp0State = await lockWithIntegrity(join(OUTPUT, "gp0-lock.json"));
  const gp1State = await lockWithIntegrity(join(OUTPUT, "gp1-lock.json"));
  const queryState = await lockWithIntegrity(join(OUTPUT, "mlab/query-semantics-correction/query-lock.json"));
  const bigQueryState = await lockWithIntegrity(join(OUTPUT, "mlab/bigquery-collector/result-lock.json"));
  const mlabImportState = await lockWithIntegrity(join(OUTPUT, "mlab/strict-future/import-lock.json"));
  const ripeState = await lockWithIntegrity(join(OUTPUT, "ripe-public-fixed-anchor/result-lock.json"));
  const radarState = await lockWithIntegrity(join(OUTPUT, "radar/causality-status-addendum/causality-lock.json"));
  const ns3Path = resolve(ROOT, "reports/experiment13-system-validation/experiment13-system-validation-summary.json");
  const boundaryPath = resolve(ROOT, "project-docs/EXPERIMENT_14B_VALIDITY_BOUNDARIES.md");
  const evidence = {
    minimumPairs: protocol.minimum_strict_pairs_per_source,
    freezeChainIntegral: true,
    gp0: gp0State.lock,
    gp0Integral: gp0State.integral,
    gp1: gp1State.lock,
    gp1Integral: gp1State.integral,
    queryLock: queryState.lock,
    queryLockIntegral: queryState.integral,
    queryAudit: await readIfExists(join(OUTPUT, "mlab/query-semantics-correction/audit.json")),
    bigQueryResult: bigQueryState.lock,
    bigQueryResultIntegral: bigQueryState.integral,
    provenanceAudit: await readIfExists(join(OUTPUT, "mlab/provenance-addendum/audit.json")),
    mlabImport: mlabImportState.lock,
    mlabImportIntegral: mlabImportState.integral,
    ripeResult: ripeState.lock,
    ripeResultIntegral: ripeState.integral,
    radarAudit: await readIfExists(join(OUTPUT, "radar/causality-status-addendum/audit.json")),
    radarLockIntegral: radarState.integral,
    pairing: await readIfExists(join(OUTPUT, "strict-pairing-addendum/audit.json")),
    strictScore: await readIfExists(join(OUTPUT, "strict-scoring-addendum/score.json")),
    completion: await readIfExists(join(OUTPUT, "strict-completion-addendum/audit.json")),
    ns3: await readJson(ns3Path),
    claimBoundaryIntegral: await recordValid(frozen.files.find((row) => row.path === relative(ROOT, boundaryPath).replaceAll("\\", "/"))),
  };
  const evaluation = evaluateFinalEvidence(evidence);
  const result = {
    schema: "int-telemetry-experiment14b-v2-final-evidence-audit/v1",
    generated_at: new Date().toISOString(),
    frozen_at: frozen.frozen_at,
    evidence_status: evaluation.complete ? "strict-final-evidence-chain-complete" : "strict-final-evidence-chain-in-progress",
    ...evaluation,
    source_status: {
      gp0: gp0State.integral ? "complete" : "pending",
      gp1: gp1State.integral ? "complete" : "pending",
      radar: radarState.integral ? "complete" : "pending",
      ripe: ripeState.integral ? "complete" : "pending",
      mlab: bigQueryState.integral && mlabImportState.integral ? "complete" : "pending",
    },
    claim_boundary: protocol.claim_boundary,
  };
  await writeJson(join(DIRECTORY, "audit.json"), result);
  return result;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const result = process.argv.includes("--freeze") ? await freeze() : await audit();
  console.log(JSON.stringify(result, null, 2));
}
