import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readCsvStream } from "../stage2-int/tools/csv-stream.mjs";
import {
  classifyStrictExternalPair,
  summarizeStrictExternalPairs,
  uniqueTopologyTimes,
} from "./experiments/strictExternalPairing.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPORT = resolve(ROOT, "reports/experiment14b-prospective-external-validation");
const OUTPUT = join(REPORT, "strict-pairing");
const PROTOCOL_PATH = resolve(ROOT, "scripts/experiments/experiment14b-strict-pairing-addendum.json");
const SCRIPT_PATH = resolve(ROOT, "scripts/auditExperiment14BStrictPairing.mjs");
const MODULE_PATH = resolve(ROOT, "scripts/experiments/strictExternalPairing.mjs");
const FREEZE_PATH = join(OUTPUT, "strict-pairing-freeze.json");
const SIDECAR_PATH = join(OUTPUT, "strict-pairing-freeze.sha256");

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

async function fileRecord(path) {
  const bytes = await readFile(path);
  return {
    path: relative(ROOT, path).replaceAll("\\", "/"),
    bytes: bytes.length,
    sha256: sha256(bytes),
  };
}

async function freeze() {
  if (await exists(FREEZE_PATH)) return verifyFreeze();
  const parent = await readJson(join(REPORT, "freeze-manifest.json"));
  const manifest = {
    schema: "int-telemetry-experiment14b-strict-pairing-freeze/v1",
    frozen_at: new Date().toISOString(),
    evidence_state_at_freeze: "strict future M-Lab and exact-anchor RIPE pairing incomplete",
    parent_protocol_sha256: parent.hashes.protocol_sha256,
    files: await Promise.all([SCRIPT_PATH, MODULE_PATH, PROTOCOL_PATH].map(fileRecord)),
  };
  await writeJson(FREEZE_PATH, manifest);
  await writeFile(SIDECAR_PATH, `${sha256(JSON.stringify(manifest))}\n`, "utf8");
  return manifest;
}

async function verifyFreeze() {
  const manifest = await readJson(FREEZE_PATH);
  if ((await readFile(SIDECAR_PATH, "utf8")).trim() !== sha256(JSON.stringify(manifest))) {
    throw new Error("Strict-pairing freeze manifest changed");
  }
  const changed = [];
  for (const expected of manifest.files) {
    const current = await fileRecord(resolve(ROOT, expected.path));
    if (current.bytes !== expected.bytes || current.sha256 !== expected.sha256) changed.push(expected.path);
  }
  if (changed.length) throw new Error(`Strict-pairing frozen files changed: ${changed.join(", ")}`);
  return manifest;
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

async function auditSource(sourceId, inputPath, topologyTimes, policy) {
  if (!(await exists(inputPath))) return { source_id: sourceId, status: "pending-input", input_path: relative(ROOT, inputPath) };
  const rows = await readCsvStream(inputPath);
  const classified = rows.map((row) => classifyStrictExternalPair(row, topologyTimes, policy));
  const summary = summarizeStrictExternalPairs(classified, sourceId, policy);
  await writeCsv(join(OUTPUT, `${sourceId}-strict-pairs.csv`), classified);
  return { status: summary.passed ? "complete" : "insufficient-strict-pairs", input_path: relative(ROOT, inputPath), ...summary };
}

async function audit() {
  const frozen = await verifyFreeze();
  const policy = await readJson(PROTOCOL_PATH);
  const nodeRows = await readCsvStream(join(REPORT, "topology", "nodes.csv"), { columns: ["slice_index", "time"] });
  const topologyTimes = uniqueTopologyTimes(nodeRows);
  const mlab = await auditSource(
    "mlab_ndt7",
    join(REPORT, "user-performance", "blind-test-paired-predictions.csv"),
    topologyTimes,
    policy,
  );
  const ripe = await auditSource(
    "ripe_atlas_exact_anchor",
    join(REPORT, "ripe-atlas", "ripe-paired-rtt.csv"),
    topologyTimes,
    policy,
  );
  const allPassed = [mlab, ripe].every((source) => source.status === "complete");
  const result = {
    schema: "int-telemetry-experiment14b-strict-pairing-audit/v1",
    generated_at: new Date().toISOString(),
    freeze: { frozen_at: frozen.frozen_at },
    topology: {
      slice_count: topologyTimes.length,
      time_start: topologyTimes[0]?.time ?? "",
      time_end: topologyTimes.at(-1)?.time ?? "",
    },
    evidence_status: allPassed ? "strict-time-geography-server-pairing-complete" : "strict-time-geography-server-pairing-in-progress",
    sources: { mlab_ndt7: mlab, ripe_atlas_exact_anchor: ripe },
  };
  await writeJson(join(OUTPUT, "strict-pairing-audit.json"), result);
  const markdown = `# Experiment 14B strict external pairing audit\n\n- Status: \`${result.evidence_status}\`\n- Topology window: ${result.topology.time_start} to ${result.topology.time_end}\n\n| Source | Strict pairs | Minimum | Result |\n|---|---:|---:|---|\n| M-Lab NDT7 | ${mlab.strict_pairs ?? 0} | ${mlab.minimum_required_pairs ?? policy.minimum_pairs.mlab_ndt7} | ${mlab.status} |\n| RIPE Atlas exact anchor | ${ripe.strict_pairs ?? 0} | ${ripe.minimum_required_pairs ?? policy.minimum_pairs.ripe_atlas_exact_anchor} | ${ripe.status} |\n\nRepresentative periodic phase, derived server centroids, and public anycast targets do not pass this audit.\n`;
  await writeFile(join(OUTPUT, "STRICT_PAIRING_AUDIT.md"), markdown, "utf8");
  return result;
}

const args = process.argv.slice(2);
if (args.includes("--freeze")) console.log(JSON.stringify(await freeze(), null, 2));
else console.log(JSON.stringify(await audit(), null, 2));
