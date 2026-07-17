import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { readCsvStream } from "../stage2-int/tools/csv-stream.mjs";
import { uniqueTopologyTimes } from "./experiments/strictExternalPairing.mjs";
import { buildV2StrictPairingAudit } from "./experiments/experiment14bV2StrictPairAudit.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const OUTPUT = resolve(ROOT, "reports/experiment14b-prospective-external-validation-v2-utc-corrected");
const AUDIT_DIR = join(OUTPUT, "strict-pairing-addendum");
const PROTOCOL = resolve(ROOT, "scripts/experiments/experiment14b-v2-strict-pairing-addendum.json");
const DEPENDENCIES = [
  PROTOCOL,
  resolve(ROOT, "scripts/auditExperiment14BV2StrictPairing.mjs"),
  resolve(ROOT, "scripts/experiments/experiment14bV2StrictPairAudit.mjs"),
  resolve(ROOT, "scripts/experiments/strictExternalPairing.mjs"),
  resolve(ROOT, "stage2-int/tools/csv-stream.mjs"),
];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
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

async function record(path) {
  const content = await readFile(path);
  return {
    path: relative(ROOT, path).replaceAll("\\", "/"),
    bytes: content.length,
    sha256: sha256(content),
  };
}

async function freeze() {
  const v2Freeze = await readJson(join(OUTPUT, "freeze-manifest.json"));
  const manifest = {
    schema: "int-telemetry-experiment14b-v2-strict-pairing-freeze/v1",
    frozen_at: new Date().toISOString(),
    parent_freeze_sha256: sha256(await readFile(join(OUTPUT, "freeze-manifest.json"))),
    parent_frozen_at: v2Freeze.frozen_at,
    files: await Promise.all(DEPENDENCIES.map(record)),
    post_result_parameter_updates_allowed: false,
  };
  await writeJson(join(AUDIT_DIR, "freeze.json"), manifest);
  await writeFile(join(AUDIT_DIR, "freeze.sha256"), `${sha256(JSON.stringify(manifest))}\n`, "utf8");
  return manifest;
}

async function verifyFreeze() {
  const path = join(AUDIT_DIR, "freeze.json");
  if (!(await exists(path))) throw new Error("Strict-pairing addendum is not frozen; run with --freeze first");
  const frozen = await readJson(path);
  for (const expected of frozen.files) {
    const current = await record(resolve(ROOT, expected.path));
    if (current.bytes !== expected.bytes || current.sha256 !== expected.sha256) {
      throw new Error(`Strict-pairing dependency changed after freeze: ${expected.path}`);
    }
  }
  const parentHash = sha256(await readFile(join(OUTPUT, "freeze-manifest.json")));
  if (parentHash !== frozen.parent_freeze_sha256) throw new Error("Experiment 14B v2 parent freeze changed");
  return frozen;
}

async function audit() {
  const frozen = await verifyFreeze();
  const protocol = await readJson(PROTOCOL);
  const gp0Path = join(OUTPUT, "gp0-lock.json");
  const pending = {
    schema: "int-telemetry-experiment14b-v2-strict-pairing-audit/v1",
    generated_at: new Date().toISOString(),
    frozen_at: frozen.frozen_at,
    evidence_status: "strict-time-geography-server-pairing-in-progress",
    checks: {
      gp0_topology_available: false,
      mlab_minimum_strict_pairs: false,
      ripe_minimum_strict_pairs: false,
      both_sources_passed: false,
    },
    sources: {
      mlab_ndt7: { status: "pending-input" },
      ripe_atlas_exact_anchor: { status: "pending-input" },
    },
    claim_boundary: protocol.claim_boundary,
  };
  if (!(await exists(gp0Path))) {
    await writeJson(join(AUDIT_DIR, "audit.json"), pending);
    return pending;
  }

  const gp0 = await readJson(gp0Path);
  const nodesPath = resolve(ROOT, gp0.artifacts.nodes.path);
  const topologyTimes = uniqueTopologyTimes(await readCsvStream(nodesPath, { columns: ["slice_index", "time"] }));
  const mlabPath = join(OUTPUT, "mlab/strict-future/strict-paired-predictions.csv");
  const ripePath = join(OUTPUT, "ripe-atlas/ripe-paired-rtt.csv");
  const mlabRows = await exists(mlabPath) ? await readCsvStream(mlabPath) : [];
  const ripeRows = await exists(ripePath) ? await readCsvStream(ripePath) : [];
  const result = buildV2StrictPairingAudit({ mlabRows, ripeRows, topologyTimes, policy: protocol });
  const output = {
    schema: "int-telemetry-experiment14b-v2-strict-pairing-audit/v1",
    generated_at: new Date().toISOString(),
    frozen_at: frozen.frozen_at,
    topology: {
      slice_count: topologyTimes.length,
      time_start: topologyTimes[0]?.time ?? null,
      time_end: topologyTimes.at(-1)?.time ?? null,
    },
    evidence_status: result.evidence_status,
    checks: { gp0_topology_available: topologyTimes.length > 0, ...result.checks },
    sources: result.sources,
    claim_boundary: protocol.claim_boundary,
  };
  await writeJson(join(AUDIT_DIR, "audit.json"), output);
  return output;
}

const result = process.argv.includes("--freeze") ? await freeze() : await audit();
console.log(JSON.stringify(result, null, 2));
