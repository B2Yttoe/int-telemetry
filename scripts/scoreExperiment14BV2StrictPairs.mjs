import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { readCsvStream } from "../stage2-int/tools/csv-stream.mjs";
import { uniqueTopologyTimes } from "./experiments/strictExternalPairing.mjs";
import { buildV2StrictPairingAudit } from "./experiments/experiment14bV2StrictPairAudit.mjs";
import { scoreV2StrictExternalRows } from "./experiments/strictExternalScoring.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const OUTPUT = resolve(ROOT, "reports/experiment14b-prospective-external-validation-v2-utc-corrected");
const DIRECTORY = join(OUTPUT, "strict-scoring-addendum");
const PAIR_PROTOCOL = resolve(ROOT, "scripts/experiments/experiment14b-v2-strict-pairing-addendum.json");
const SCORE_PROTOCOL = resolve(ROOT, "scripts/experiments/experiment14b-v2-strict-scoring-addendum.json");
const DEPENDENCIES = [
  PAIR_PROTOCOL,
  SCORE_PROTOCOL,
  resolve(ROOT, "scripts/scoreExperiment14BV2StrictPairs.mjs"),
  resolve(ROOT, "scripts/experiments/experiment14bV2StrictPairAudit.mjs"),
  resolve(ROOT, "scripts/experiments/strictExternalPairing.mjs"),
  resolve(ROOT, "scripts/experiments/strictExternalScoring.mjs"),
  resolve(ROOT, "stage2-int/tools/csv-stream.mjs"),
];

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
async function exists(path) { try { await stat(path); return true; } catch { return false; } }
async function readJson(path) { return JSON.parse(await readFile(path, "utf8")); }
async function writeJson(path, value) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8"); }
async function record(path) {
  const content = await readFile(path);
  return { path: relative(ROOT, path).replaceAll("\\", "/"), bytes: content.length, sha256: sha256(content) };
}

async function freeze() {
  const parentPairFreezePath = join(OUTPUT, "strict-pairing-addendum/freeze.json");
  const manifest = {
    schema: "int-telemetry-experiment14b-v2-strict-scoring-freeze/v1",
    frozen_at: new Date().toISOString(),
    parent_pairing_freeze_sha256: sha256(await readFile(parentPairFreezePath)),
    files: await Promise.all(DEPENDENCIES.map(record)),
    test_target_values_used_for_fit: 0,
    post_test_parameter_updates_allowed: false,
  };
  await writeJson(join(DIRECTORY, "freeze.json"), manifest);
  return manifest;
}

async function verifyFreeze() {
  const path = join(DIRECTORY, "freeze.json");
  if (!(await exists(path))) throw new Error("Strict-scoring addendum is not frozen; run with --freeze first");
  const manifest = await readJson(path);
  for (const expected of manifest.files) {
    const current = await record(resolve(ROOT, expected.path));
    if (current.bytes !== expected.bytes || current.sha256 !== expected.sha256) throw new Error(`Strict-scoring dependency changed: ${expected.path}`);
  }
  const pairingHash = sha256(await readFile(join(OUTPUT, "strict-pairing-addendum/freeze.json")));
  if (pairingHash !== manifest.parent_pairing_freeze_sha256) throw new Error("Strict-pairing freeze changed");
  return manifest;
}

async function score() {
  const frozen = await verifyFreeze();
  const scoreProtocol = await readJson(SCORE_PROTOCOL);
  const pairProtocol = await readJson(PAIR_PROTOCOL);
  const gp0Path = join(OUTPUT, "gp0-lock.json");
  if (!(await exists(gp0Path))) {
    const pending = {
      schema: "int-telemetry-experiment14b-v2-strict-score/v1",
      generated_at: new Date().toISOString(),
      evidence_status: "pending-gp0-and-strict-pairs",
      test_target_values_used_for_fit: 0,
      post_test_parameter_updates: 0,
      claim_boundary: scoreProtocol.claim_boundary,
    };
    await writeJson(join(DIRECTORY, "score.json"), pending);
    return pending;
  }
  const gp0 = await readJson(gp0Path);
  const topologyTimes = uniqueTopologyTimes(await readCsvStream(resolve(ROOT, gp0.artifacts.nodes.path), { columns: ["slice_index", "time"] }));
  const mlabPath = join(OUTPUT, "mlab/strict-future/strict-paired-predictions.csv");
  const ripePath = join(OUTPUT, "ripe-atlas/ripe-paired-rtt.csv");
  const mlabRows = await exists(mlabPath) ? await readCsvStream(mlabPath) : [];
  const ripeRows = await exists(ripePath) ? await readCsvStream(ripePath) : [];
  const pairing = buildV2StrictPairingAudit({ mlabRows, ripeRows, topologyTimes, policy: pairProtocol });
  const scores = scoreV2StrictExternalRows(pairing.classified);
  const complete = pairing.sources.mlab_ndt7.passed && pairing.sources.ripe_atlas_exact_anchor.passed &&
    scores.mlab_ndt7.rtt.status === "complete" && scores.mlab_ndt7.throughput.status === "complete" &&
    scores.ripe_atlas_exact_anchor.rtt.status === "complete";
  const output = {
    schema: "int-telemetry-experiment14b-v2-strict-score/v1",
    generated_at: new Date().toISOString(),
    frozen_at: frozen.frozen_at,
    evidence_status: complete ? "strict-external-metric-scoring-complete" : "strict-external-metric-scoring-in-progress",
    pairing: pairing.sources,
    scores,
    test_target_values_used_for_fit: 0,
    test_target_values_used_for_interval_calibration: 0,
    post_test_parameter_updates: 0,
    claim_boundary: scoreProtocol.claim_boundary,
  };
  await writeJson(join(DIRECTORY, "score.json"), output);
  return output;
}

const result = process.argv.includes("--freeze") ? await freeze() : await score();
console.log(JSON.stringify(result, null, 2));
