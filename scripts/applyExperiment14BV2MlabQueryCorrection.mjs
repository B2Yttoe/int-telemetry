import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(import.meta.dirname, "..");
const OUTPUT = resolve(ROOT, "reports/experiment14b-prospective-external-validation-v2-utc-corrected");
const DIRECTORY = join(OUTPUT, "mlab", "query-semantics-correction");
const QUERY_PATH = join(OUTPUT, "mlab", "strict-window-query.sql");
const PROTOCOL_PATH = resolve(ROOT, "scripts/experiments/experiment14b-v2-mlab-query-correction-addendum.json");
const V2_PROTOCOL_PATH = resolve(ROOT, "scripts/experiments/experiment14b-v2-protocol.json");
const MAIN_RUNNER = resolve(ROOT, "scripts/runExperiment14BProspectiveValidationV2.mjs");
const PROVENANCE_AUDITOR = resolve(ROOT, "scripts/auditExperiment14BV2MlabProvenance.mjs");
const FROZEN_INPUTS = [
  fileURLToPath(import.meta.url),
  PROTOCOL_PATH,
  V2_PROTOCOL_PATH,
  MAIN_RUNNER,
  PROVENANCE_AUDITOR,
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
  return {
    path: relative(ROOT, path).replaceAll("\\", "/"),
    bytes: content.length,
    sha256: sha256(content),
  };
}
async function recordValid(expected) {
  const path = resolve(ROOT, expected.path);
  if (!(await exists(path))) return false;
  const current = await fileRecord(path);
  return current.bytes === expected.bytes && current.sha256 === expected.sha256;
}
async function allRecordsValid(records) {
  for (const row of records ?? []) if (!(await recordValid(row))) return false;
  return true;
}

function requireIsoTime(value, name) {
  const time = new Date(value);
  if (!Number.isFinite(time.getTime())) throw new Error(`Invalid ${name}: ${value}`);
  return time.toISOString();
}

export function buildCorrectedMlabQuery(gp0) {
  const start = requireIsoTime(gp0?.windows?.topology_start, "GP0 topology start");
  const end = requireIsoTime(gp0?.windows?.topology_end, "GP0 topology end");
  return `-- Experiment 14B v2 prospective M-Lab query.\n` +
`-- Query-semantics correction addendum: node._Instruments is a scalar field.\n` +
`-- This query is locked before any future M-Lab result is observed.\n` +
`SELECT\n` +
`  a.UUID AS uuid,\n  a.TestTime AS test_time,\n  'NDT7' AS data_source,\n` +
`  client.Network.ASNumber AS client_asn,\n  client.Geo.city AS client_city,\n` +
`  client.Geo.countryCode AS client_country_code,\n  client.Geo.latitude AS lat,\n` +
`  client.Geo.longitude AS lon,\n  server.Machine AS server_id,\n` +
`  server.Geo.city AS server_city,\n  server.Geo.countryCode AS server_country_code,\n` +
`  server.Geo.latitude AS server_latitude_deg,\n  server.Geo.longitude AS server_longitude_deg,\n` +
`  a.MeanThroughputMbps AS download_throughput_mbps,\n  a.MinRTT AS download_latency_ms\n` +
`FROM \`measurement-lab.ndt.unified_downloads\`\n` +
`WHERE date BETWEEN DATE(TIMESTAMP('${start}')) AND DATE(TIMESTAMP('${end}'))\n` +
`  AND a.TestTime >= TIMESTAMP('${start}')\n` +
`  AND a.TestTime < TIMESTAMP('${end}')\n` +
`  AND client.Network.ASNumber = 14593\n` +
`  AND node._Instruments = 'ndt7'\n` +
`ORDER BY a.TestTime, a.UUID;\n`;
}

async function verifyParentFreeze() {
  const path = join(OUTPUT, "freeze-manifest.json");
  if (!(await exists(path))) throw new Error("Experiment 14B v2 parent freeze is missing");
  const manifest = await readJson(path);
  if (!(await allRecordsValid(manifest.files))) throw new Error("Experiment 14B v2 parent freeze changed");
  return manifest;
}

async function verifyGp0() {
  const path = join(OUTPUT, "gp0-lock.json");
  if (!(await exists(path))) return null;
  const lock = await readJson(path);
  if (!(await allRecordsValid(Object.values(lock.artifacts ?? {})))) throw new Error("GP0 artifact hash verification failed");
  return lock;
}

async function futureMlabEvidenceExists() {
  const paths = [
    join(OUTPUT, "mlab", "provenance-addendum", "input-lock.json"),
    join(OUTPUT, "mlab", "strict-future", "import-lock.json"),
    join(OUTPUT, "mlab", "strict-future", "source-lock.json"),
  ];
  for (const path of paths) if (await exists(path)) return true;
  return false;
}

async function freeze() {
  const path = join(DIRECTORY, "freeze.json");
  if (await exists(path)) return verifyFreeze();
  if (await exists(join(OUTPUT, "gp0-lock.json"))) throw new Error("Query correction must be frozen before GP0");
  if (await futureMlabEvidenceExists()) throw new Error("Future M-Lab evidence already exists; correction freeze is no longer causal");
  const protocol = await readJson(PROTOCOL_PATH);
  const manifest = {
    schema: "int-telemetry-experiment14b-v2-mlab-query-correction-freeze/v1",
    frozen_at: new Date().toISOString(),
    parent_freeze: await fileRecord(join(OUTPUT, "freeze-manifest.json")),
    files: await Promise.all(FROZEN_INPUTS.map(fileRecord)),
    official_evidence: protocol.official_evidence,
    superseded_predicate: protocol.superseded_predicate,
    replacement_predicate: protocol.replacement_predicate,
    gp0_present_at_freeze: false,
    future_mlab_result_values_observed_by_freeze: 0,
    post_test_parameter_updates_allowed: false,
  };
  await writeJson(path, manifest);
  return manifest;
}

async function verifyFreeze() {
  const path = join(DIRECTORY, "freeze.json");
  if (!(await exists(path))) throw new Error("M-Lab query correction addendum is not frozen");
  const manifest = await readJson(path);
  if (!(await allRecordsValid(manifest.files))) throw new Error("M-Lab query correction freeze changed");
  if (!(await recordValid(manifest.parent_freeze))) throw new Error("M-Lab query correction parent freeze changed");
  return manifest;
}

async function applyCorrection() {
  const frozen = await verifyFreeze();
  await verifyParentFreeze();
  const gp0 = await verifyGp0();
  if (!gp0) return { status: "pending-gp0" };
  if (await futureMlabEvidenceExists()) throw new Error("Future M-Lab evidence is already locked; query correction is forbidden");
  const lockPath = join(DIRECTORY, "query-lock.json");
  if (await exists(lockPath)) return audit();

  const previous = await exists(QUERY_PATH) ? await fileRecord(QUERY_PATH) : null;
  const corrected = buildCorrectedMlabQuery(gp0);
  await mkdir(dirname(QUERY_PATH), { recursive: true });
  await writeFile(QUERY_PATH, corrected, "utf8");
  const query = await fileRecord(QUERY_PATH);
  const lock = {
    schema: "int-telemetry-experiment14b-v2-mlab-query-correction-lock/v1",
    applied_at: new Date().toISOString(),
    frozen_at: frozen.frozen_at,
    applied_before_future_mlab_results: true,
    test_values_used_for_fit: 0,
    post_test_parameter_updates: 0,
    previous_parent_query: previous,
    corrected_query: query,
    gp0_lock: await fileRecord(join(OUTPUT, "gp0-lock.json")),
    topology_window: {
      start: gp0.windows.topology_start,
      end: gp0.windows.topology_end,
    },
  };
  await writeJson(lockPath, lock);
  return audit();
}

async function audit() {
  const frozen = await verifyFreeze();
  await verifyParentFreeze();
  const gp0 = await verifyGp0();
  const lockPath = join(DIRECTORY, "query-lock.json");
  const lock = await exists(lockPath) ? await readJson(lockPath) : null;
  const queryIntegral = Boolean(lock?.corrected_query && await recordValid(lock.corrected_query));
  let exactContent = false;
  if (gp0 && await exists(QUERY_PATH)) {
    exactContent = await readFile(QUERY_PATH, "utf8") === buildCorrectedMlabQuery(gp0);
  }
  const noArrayPredicate = exactContent && !(await readFile(QUERY_PATH, "utf8")).includes("UNNEST(node_instruments)");
  const noPrematureEvidence = lock ? lock.applied_before_future_mlab_results === true : !(await futureMlabEvidenceExists());
  const complete = Boolean(gp0 && lock && queryIntegral && exactContent && noArrayPredicate && noPrematureEvidence &&
    lock.test_values_used_for_fit === 0 && lock.post_test_parameter_updates === 0);
  const result = {
    schema: "int-telemetry-experiment14b-v2-mlab-query-correction-audit/v1",
    generated_at: new Date().toISOString(),
    frozen_at: frozen.frozen_at,
    evidence_status: complete ? "query-semantics-correction-complete" : "query-semantics-correction-pending",
    checks: {
      gp0_locked: Boolean(gp0),
      correction_lock_present: Boolean(lock),
      corrected_query_integral: queryIntegral,
      corrected_query_exact: exactContent,
      scalar_instrument_predicate: noArrayPredicate,
      applied_before_future_mlab_results: noPrematureEvidence,
      test_values_used_for_fit_zero: lock?.test_values_used_for_fit === 0,
      post_test_updates_zero: lock?.post_test_parameter_updates === 0,
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
  else if (args.includes("--apply")) result = await applyCorrection();
  else result = await audit();
  console.log(JSON.stringify(result, null, 2));
}
