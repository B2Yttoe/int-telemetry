import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const OUTPUT = resolve(ROOT, "reports/experiment14b-prospective-external-validation-v2-utc-corrected");
const DIRECTORY = join(OUTPUT, "strict-completion-addendum");
const PROTOCOL_PATH = resolve(ROOT, "scripts/experiments/experiment14b-v2-completion-addendum.json");
const FROZEN_INPUTS = [
  resolve(ROOT, "scripts/auditExperiment14BV2Completion.mjs"),
  PROTOCOL_PATH,
  join(OUTPUT, "freeze-manifest.json"),
  join(OUTPUT, "strict-pairing-addendum/freeze.json"),
  join(OUTPUT, "strict-scoring-addendum/freeze.json"),
  join(OUTPUT, "ripe-public-fixed-anchor/freeze.json"),
  resolve(ROOT, "reports/experiment13-system-validation/experiment13-system-validation-summary.json"),
  resolve(ROOT, "project-docs/EXPERIMENT_14B_VALIDITY_BOUNDARIES.md"),
];

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
async function exists(path) { try { await stat(path); return true; } catch { return false; } }
async function readJson(path) { return JSON.parse(await readFile(path, "utf8")); }
async function writeJson(path, value) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8"); }
async function record(path) {
  const content = await readFile(path);
  return { path: relative(ROOT, path).replaceAll("\\", "/"), bytes: content.length, sha256: sha256(content) };
}
async function recordValid(expected) {
  if (!(await exists(resolve(ROOT, expected.path)))) return false;
  const current = await record(resolve(ROOT, expected.path));
  return current.bytes === expected.bytes && current.sha256 === expected.sha256;
}
async function allRecordsValid(records) {
  for (const row of records ?? []) if (!(await recordValid(row))) return false;
  return true;
}

async function freeze() {
  const path = join(DIRECTORY, "freeze.json");
  if (await exists(path)) return readJson(path);
  const manifest = {
    schema: "int-telemetry-experiment14b-v2-completion-freeze/v1",
    frozen_at: new Date().toISOString(),
    files: await Promise.all(FROZEN_INPUTS.map(record)),
    result_values_observed_by_freeze: 0,
    post_result_parameter_updates_allowed: false,
  };
  await writeJson(path, manifest);
  return manifest;
}

async function verifyCompletionFreeze() {
  const manifest = await readJson(join(DIRECTORY, "freeze.json"));
  if (!(await allRecordsValid(manifest.files))) throw new Error("Experiment 14B v2 completion freeze changed");
  return manifest;
}

async function verifyLock(path) {
  if (!(await exists(path))) return null;
  const lock = await readJson(path);
  const records = Object.values(lock.artifacts ?? {});
  if (lock.source_csv?.path) records.push(lock.source_csv);
  if (!records.length) return null;
  return await allRecordsValid(records) ? lock : null;
}

async function audit() {
  const frozen = await verifyCompletionFreeze();
  const protocol = await readJson(PROTOCOL_PATH);
  const gp0 = await verifyLock(join(OUTPUT, "gp0-lock.json"));
  const gp1 = await verifyLock(join(OUTPUT, "gp1-lock.json"));
  const mlab = await verifyLock(join(OUTPUT, "mlab/strict-future/import-lock.json"));
  const publicRipe = await verifyLock(join(OUTPUT, "ripe-public-fixed-anchor/result-lock.json"));
  const pairing = await exists(join(OUTPUT, "strict-pairing-addendum/audit.json"))
    ? await readJson(join(OUTPUT, "strict-pairing-addendum/audit.json")) : null;
  const strictScore = await exists(join(OUTPUT, "strict-scoring-addendum/score.json"))
    ? await readJson(join(OUTPUT, "strict-scoring-addendum/score.json")) : null;
  const external = await exists(join(OUTPUT, "external-collection-status.json"))
    ? await readJson(join(OUTPUT, "external-collection-status.json")) : null;
  const ns3 = await readJson(resolve(ROOT, "reports/experiment13-system-validation/experiment13-system-validation-summary.json"));
  const customRipeComplete = external?.ripe_atlas?.status === "complete-exact-anchor";
  const publicRipeComplete = Boolean(publicRipe?.source_validation?.passed && publicRipe?.test_values_used_for_fit === 0);
  const mlabPairs = Number(pairing?.sources?.mlab_ndt7?.strict_pairs ?? 0);
  const ripePairs = Number(pairing?.sources?.ripe_atlas_exact_anchor?.strict_pairs ?? 0);
  const scoreComplete = strictScore?.evidence_status === "strict-external-metric-scoring-complete" &&
    strictScore?.scores?.mlab_ndt7?.rtt?.sample_count >= 20 &&
    strictScore?.scores?.mlab_ndt7?.throughput?.sample_count >= 20 &&
    strictScore?.scores?.ripe_atlas_exact_anchor?.rtt?.sample_count >= 20;
  const radarComplete = external?.radar?.status === "complete" &&
    external?.radar?.test_values_used_for_fit === 0 && external?.radar?.post_test_parameter_updates === 0;
  const checks = {
    all_freezes_integral: true,
    gp0_fresh_and_locked: Boolean(gp0?.start_freshness?.passed && gp0?.window_end_freshness?.passed),
    gp1_blind_validation: Boolean(gp1?.differs_from_gp0 && gp1?.summary),
    radar_prospective_holdout: radarComplete,
    mlab_minimum_strict_pairs: mlabPairs >= 20 && Boolean(mlab),
    ripe_minimum_strict_pairs: ripePairs >= protocol.ripe_source_equivalence.minimum_strict_pairs && (customRipeComplete || publicRipeComplete),
    strict_metric_scores_complete: scoreComplete,
    test_target_fit_count_zero: Boolean(mlab?.test_values_used_for_fit === 0 && strictScore?.test_target_values_used_for_fit === 0 &&
      (!publicRipe || publicRipe.test_values_used_for_fit === 0)),
    post_test_updates_zero: Boolean(mlab?.post_test_parameter_updates === 0 && strictScore?.post_test_parameter_updates === 0 &&
      (!publicRipe || publicRipe.post_test_parameter_updates === 0)),
    ns3_system_cross_validation: ns3.evidence_status === "ns3-system-cross-validation-complete",
    internal_state_claim_boundary: await exists(resolve(ROOT, "project-docs/EXPERIMENT_14B_VALIDITY_BOUNDARIES.md")),
  };
  const complete = Object.values(checks).every(Boolean);
  const result = {
    schema: "int-telemetry-experiment14b-v2-completion-audit/v1",
    generated_at: new Date().toISOString(),
    frozen_at: frozen.frozen_at,
    evidence_status: complete ? "strict-prospective-validation-complete" : "strict-prospective-validation-in-progress",
    checks,
    completion_count: Object.values(checks).filter(Boolean).length,
    required_count: Object.keys(checks).length,
    ripe_source: customRipeComplete ? "project-created-fixed-anchor" : publicRipeComplete ? "pre-registered-public-fixed-anchor" : "pending",
    strict_pair_counts: { mlab_ndt7: mlabPairs, ripe_atlas_exact_anchor: ripePairs },
    claim_boundary: protocol.claim_boundary,
  };
  await writeJson(join(DIRECTORY, "audit.json"), result);
  return result;
}

const result = process.argv.includes("--freeze") ? await freeze() : await audit();
console.log(JSON.stringify(result, null, 2));
