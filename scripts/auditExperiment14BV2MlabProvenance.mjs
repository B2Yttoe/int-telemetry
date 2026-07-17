import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readCsvStream } from "../stage2-int/tools/csv-stream.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const OUTPUT = resolve(ROOT, "reports/experiment14b-prospective-external-validation-v2-utc-corrected");
const DIRECTORY = join(OUTPUT, "mlab", "provenance-addendum");
const PROTOCOL_PATH = resolve(ROOT, "scripts/experiments/experiment14b-v2-mlab-provenance-addendum.json");
const V2_PROTOCOL_PATH = resolve(ROOT, "scripts/experiments/experiment14b-v2-protocol.json");
const MAIN_RUNNER = resolve(ROOT, "scripts/runExperiment14BProspectiveValidationV2.mjs");
const FROZEN_INPUTS = [
  fileURLToPath(import.meta.url),
  PROTOCOL_PATH,
  V2_PROTOCOL_PATH,
  MAIN_RUNNER,
  resolve(ROOT, "stage2-int/tools/csv-stream.mjs"),
  join(OUTPUT, "freeze-manifest.json"),
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
  for (const row of records ?? []) if (!(await recordValid(row))) return false;
  return true;
}
function finiteTime(value) {
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}
function numeric(value) { return Number.isFinite(Number(value)); }
function nonempty(value) { return String(value ?? "").trim().length > 0; }

export async function validateMlabExportEvidence({
  csvPath,
  metadataPath,
  queryPath,
  gp0,
  provenanceProtocol,
  v2Protocol,
}) {
  const [rows, metadata, queryContent, csvContent] = await Promise.all([
    readCsvStream(csvPath),
    readJson(metadataPath),
    readFile(queryPath),
    readFile(csvPath),
  ]);
  const failures = [];
  for (const field of provenanceProtocol.required_metadata_fields ?? []) {
    if (!Object.hasOwn(metadata, field)) failures.push(`missing-metadata:${field}`);
  }
  if (metadata.official_table !== provenanceProtocol.official_table) failures.push("official-table-mismatch");
  if (metadata.query_sha256 !== sha256(queryContent)) failures.push("query-sha256-mismatch");
  if (metadata.source_csv_sha256 !== sha256(csvContent)) failures.push("source-csv-sha256-mismatch");
  if (Number(metadata.row_count) !== rows.length) failures.push("row-count-mismatch");
  if (!nonempty(metadata.bigquery_job_id)) failures.push("missing-bigquery-job-id");
  if (!nonempty(metadata.source_url)) failures.push("missing-source-url");
  if (!nonempty(metadata.license)) failures.push("missing-license");
  if (Number(metadata.test_values_used_for_fit) !== 0) failures.push("test-values-used-for-fit");
  if (Number(metadata.post_test_parameter_updates) !== 0) failures.push("post-test-parameter-updates");

  const startedAt = finiteTime(metadata.query_started_at);
  const completedAt = finiteTime(metadata.query_completed_at);
  const exportedAt = finiteTime(metadata.exported_at);
  const importNotBefore = finiteTime(gp0?.windows?.mlab_import_not_before);
  if (startedAt === null) failures.push("invalid-query-started-at");
  if (completedAt === null) failures.push("invalid-query-completed-at");
  if (exportedAt === null) failures.push("invalid-exported-at");
  if (completedAt !== null && startedAt !== null && completedAt < startedAt) failures.push("query-completed-before-start");
  if (exportedAt !== null && completedAt !== null && exportedAt < completedAt) failures.push("exported-before-query-completed");
  if (completedAt !== null && importNotBefore !== null && completedAt < importNotBefore) failures.push("queried-before-publication-delay");

  const requiredColumns = v2Protocol.mlab_strict.required_columns ?? [];
  const columns = new Set(rows.flatMap((row) => Object.keys(row)));
  for (const column of requiredColumns) if (!columns.has(column)) failures.push(`missing-column:${column}`);
  const topologyStart = finiteTime(gp0?.windows?.topology_start);
  const topologyEnd = finiteTime(gp0?.windows?.topology_end);
  let eligibleRows = 0;
  let invalidRows = 0;
  for (const row of rows) {
    const time = finiteTime(row.test_time);
    const valid = time !== null && topologyStart !== null && topologyEnd !== null &&
      time >= topologyStart && time < topologyEnd &&
      Number(row.client_asn) === Number(v2Protocol.mlab_strict.source_asn) &&
      String(row.data_source).toLowerCase() === String(v2Protocol.mlab_strict.protocol).toLowerCase() &&
      nonempty(row.uuid) && nonempty(row.server_id) &&
      numeric(row.lat) && numeric(row.lon) && numeric(row.server_latitude_deg) && numeric(row.server_longitude_deg) &&
      numeric(row.download_latency_ms) && numeric(row.download_throughput_mbps);
    if (valid) eligibleRows += 1;
    else invalidRows += 1;
  }
  if (rows.length < Number(provenanceProtocol.minimum_rows)) failures.push("insufficient-source-rows");
  if (invalidRows) failures.push("rows-outside-frozen-query-contract");

  return {
    schema: "int-telemetry-experiment14b-v2-mlab-provenance-preflight/v1",
    generated_at: new Date().toISOString(),
    passed: failures.length === 0,
    failures,
    official_table: metadata.official_table ?? "",
    bigquery_job_id: metadata.bigquery_job_id ?? "",
    query_sha256: sha256(queryContent),
    source_csv_sha256: sha256(csvContent),
    source_rows: rows.length,
    eligible_rows: eligibleRows,
    invalid_rows: invalidRows,
    test_values_used_for_fit: Number(metadata.test_values_used_for_fit),
    post_test_parameter_updates: Number(metadata.post_test_parameter_updates),
  };
}

async function freeze() {
  const path = join(DIRECTORY, "freeze.json");
  if (await exists(path)) return readJson(path);
  const manifest = {
    schema: "int-telemetry-experiment14b-v2-mlab-provenance-freeze/v1",
    frozen_at: new Date().toISOString(),
    files: await Promise.all(FROZEN_INPUTS.map(fileRecord)),
    result_values_observed_by_freeze: 0,
    post_result_parameter_updates_allowed: false,
  };
  await writeJson(path, manifest);
  return manifest;
}

async function verifyFreeze() {
  const path = join(DIRECTORY, "freeze.json");
  if (!(await exists(path))) throw new Error("M-Lab provenance addendum is not frozen");
  const frozen = await readJson(path);
  if (!(await allRecordsValid(frozen.files))) throw new Error("M-Lab provenance addendum freeze changed");
  return frozen;
}

async function verifiedGp0() {
  const path = join(OUTPUT, "gp0-lock.json");
  if (!(await exists(path))) throw new Error("GP0 is not locked yet");
  const gp0 = await readJson(path);
  if (!(await allRecordsValid(Object.values(gp0.artifacts ?? {})))) throw new Error("GP0 artifact hash verification failed");
  return gp0;
}

async function preflight(csvPath, metadataPath) {
  await verifyFreeze();
  const gp0 = await verifiedGp0();
  const queryPath = join(OUTPUT, "mlab", "strict-window-query.sql");
  const result = await validateMlabExportEvidence({
    csvPath: resolve(csvPath),
    metadataPath: resolve(metadataPath),
    queryPath,
    gp0,
    provenanceProtocol: await readJson(PROTOCOL_PATH),
    v2Protocol: await readJson(V2_PROTOCOL_PATH),
  });
  await writeJson(join(DIRECTORY, "preflight.json"), result);
  return result;
}

async function lockAndImport(csvPath, metadataPath) {
  const inputLockPath = join(DIRECTORY, "input-lock.json");
  const existingImportPath = join(OUTPUT, "mlab", "strict-future", "import-lock.json");
  if (await exists(inputLockPath) || await exists(existingImportPath)) {
    throw new Error("M-Lab input or import is already locked; overwrite is forbidden");
  }
  const result = await preflight(csvPath, metadataPath);
  if (!result.passed) throw new Error(`M-Lab provenance preflight failed: ${result.failures.join(", ")}`);
  const queryPath = join(OUTPUT, "mlab", "strict-window-query.sql");
  await writeJson(inputLockPath, {
    schema: "int-telemetry-experiment14b-v2-mlab-provenance-input-lock/v1",
    locked_at: new Date().toISOString(),
    validation: result,
    artifacts: {
      query: await fileRecord(queryPath),
      source_csv: await fileRecord(resolve(csvPath)),
      source_metadata: await fileRecord(resolve(metadataPath)),
    },
  });
  const child = spawnSync(process.execPath, [
    MAIN_RUNNER,
    "--phase", "mlab-import",
    "--mlab-csv", resolve(csvPath),
    "--mlab-metadata", resolve(metadataPath),
  ], { cwd: ROOT, stdio: "inherit", env: process.env });
  if (child.status !== 0) throw new Error(`Frozen M-Lab importer exited with code ${child.status}`);
  return audit();
}

async function audit() {
  const frozen = await verifyFreeze();
  const inputLockPath = join(DIRECTORY, "input-lock.json");
  const importLockPath = join(OUTPUT, "mlab", "strict-future", "import-lock.json");
  const inputLock = await exists(inputLockPath) ? await readJson(inputLockPath) : null;
  const importLock = await exists(importLockPath) ? await readJson(importLockPath) : null;
  const inputIntegral = Boolean(inputLock && await allRecordsValid(Object.values(inputLock.artifacts ?? {})));
  const importedCsvIntegral = Boolean(importLock?.source_csv && await recordValid(importLock.source_csv));
  const complete = Boolean(inputIntegral && importedCsvIntegral && inputLock.validation?.passed &&
    importLock.strict_pairing?.passed && importLock.test_values_used_for_fit === 0 &&
    importLock.post_test_parameter_updates === 0);
  const result = {
    schema: "int-telemetry-experiment14b-v2-mlab-provenance-audit/v1",
    generated_at: new Date().toISOString(),
    frozen_at: frozen.frozen_at,
    evidence_status: complete ? "strict-mlab-provenance-complete" : "strict-mlab-provenance-pending",
    checks: {
      input_lock_integral: inputIntegral,
      normalized_import_csv_integral: importedCsvIntegral,
      provenance_preflight_passed: Boolean(inputLock?.validation?.passed),
      strict_pairing_passed: Boolean(importLock?.strict_pairing?.passed),
      test_values_used_for_fit_zero: importLock?.test_values_used_for_fit === 0,
      post_test_updates_zero: importLock?.post_test_parameter_updates === 0,
    },
  };
  await writeJson(join(DIRECTORY, "audit.json"), result);
  return result;
}

function argValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : "";
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const args = process.argv.slice(2);
  const csvPath = argValue(args, "--mlab-csv");
  const metadataPath = argValue(args, "--mlab-metadata");
  let result;
  if (args.includes("--freeze")) result = await freeze();
  else if (args.includes("--preflight")) result = await preflight(csvPath, metadataPath);
  else if (args.includes("--import")) result = await lockAndImport(csvPath, metadataPath);
  else result = await audit();
  console.log(JSON.stringify(result, null, 2));
  if (result?.passed === false) process.exitCode = 1;
}
