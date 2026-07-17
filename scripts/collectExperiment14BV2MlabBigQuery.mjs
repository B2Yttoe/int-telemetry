import { createHash, createSign } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(import.meta.dirname, "..");
const OUTPUT = resolve(ROOT, "reports/experiment14b-prospective-external-validation-v2-utc-corrected");
const DIRECTORY = join(OUTPUT, "mlab", "bigquery-collector");
const QUERY_PATH = join(OUTPUT, "mlab", "strict-window-query.sql");
const QUERY_CORRECTION_DIRECTORY = join(OUTPUT, "mlab", "query-semantics-correction");
const PROTOCOL_PATH = resolve(ROOT, "scripts/experiments/experiment14b-v2-mlab-bigquery-collector-addendum.json");
const V2_PROTOCOL_PATH = resolve(ROOT, "scripts/experiments/experiment14b-v2-protocol.json");
const PROVENANCE_AUDITOR = resolve(ROOT, "scripts/auditExperiment14BV2MlabProvenance.mjs");
const FROZEN_INPUTS = [
  fileURLToPath(import.meta.url),
  PROTOCOL_PATH,
  V2_PROTOCOL_PATH,
  PROVENANCE_AUDITOR,
  resolve(ROOT, "scripts/applyExperiment14BV2MlabQueryCorrection.mjs"),
];

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const base64url = (value) => Buffer.from(value).toString("base64url");
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
function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
async function writeCsv(path, columns, rows) {
  await mkdir(dirname(path), { recursive: true });
  const lines = [columns.join(","), ...rows.map((row) => columns.map((column) => csvEscape(row[column])).join(","))];
  await writeFile(path, `${lines.join("\n")}\n`, "utf8");
}

export function decodeBigQueryRows(schema, rows = []) {
  const columns = (schema?.fields ?? []).map((field) => field.name);
  return rows.map((row) => Object.fromEntries(columns.map((column, index) => [column, row?.f?.[index]?.v ?? ""])));
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let payload;
  try { payload = text ? JSON.parse(text) : {}; }
  catch { throw new Error(`${url} returned non-JSON HTTP ${response.status}`); }
  if (!response.ok) {
    const message = payload?.error?.message ?? payload?.error_description ?? `HTTP ${response.status}`;
    throw new Error(`${url} failed: ${message}`);
  }
  return payload;
}

async function serviceAccountAccessToken(path) {
  const credentials = await readJson(path);
  if (credentials.type !== "service_account" || !credentials.client_email || !credentials.private_key) {
    throw new Error("GOOGLE_APPLICATION_CREDENTIALS must reference a service-account JSON file");
  }
  const now = Math.floor(Date.now() / 1000);
  const tokenUri = credentials.token_uri || "https://oauth2.googleapis.com/token";
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(JSON.stringify({
    iss: credentials.client_email,
    scope: "https://www.googleapis.com/auth/bigquery",
    aud: tokenUri,
    iat: now,
    exp: now + 3600,
  }));
  const unsigned = `${header}.${claims}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const assertion = `${unsigned}.${signer.sign(credentials.private_key).toString("base64url")}`;
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion,
  });
  const response = await fetchJson(tokenUri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.access_token) throw new Error("Google OAuth token response did not contain access_token");
  return { token: response.access_token, projectId: credentials.project_id ?? "", method: "service-account" };
}

async function credentials() {
  const direct = String(process.env.GOOGLE_OAUTH_ACCESS_TOKEN ?? "").trim();
  const requestedProject = String(process.env.GOOGLE_CLOUD_PROJECT ?? process.env.CLOUDSDK_CORE_PROJECT ?? "").trim();
  if (direct) {
    if (!requestedProject) return { status: "pending-google-cloud-project" };
    return { status: "ready", token: direct, projectId: requestedProject, method: "oauth-access-token" };
  }
  const credentialPath = String(process.env.GOOGLE_APPLICATION_CREDENTIALS ?? "").trim();
  if (!credentialPath) return { status: "pending-google-credentials" };
  const auth = await serviceAccountAccessToken(resolve(credentialPath));
  const projectId = requestedProject || auth.projectId;
  if (!projectId) return { status: "pending-google-cloud-project" };
  return { status: "ready", ...auth, projectId };
}

export async function queryBigQuery({ query, projectId, token, protocol }) {
  const base = `https://bigquery.googleapis.com/bigquery/v2/projects/${encodeURIComponent(projectId)}`;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const startedAt = new Date().toISOString();
  let response = await fetchJson(`${base}/queries`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      query,
      useLegacySql: false,
      useQueryCache: false,
      maxResults: protocol.page_size,
      timeoutMs: protocol.poll_timeout_ms,
      maximumBytesBilled: protocol.maximum_bytes_billed,
      labels: { experiment: "int_telemetry_14b_v2" },
    }),
  });
  const job = response.jobReference;
  if (!job?.jobId) throw new Error("BigQuery did not return a job reference");
  let attempts = 0;
  while (!response.jobComplete) {
    if (++attempts > protocol.maximum_poll_attempts) throw new Error("BigQuery query polling limit exceeded");
    const params = new URLSearchParams({ timeoutMs: String(protocol.poll_timeout_ms), maxResults: String(protocol.page_size) });
    if (job.location) params.set("location", job.location);
    response = await fetchJson(`${base}/queries/${encodeURIComponent(job.jobId)}?${params}`, { headers });
  }
  if (response.errors?.length) throw new Error(`BigQuery query errors: ${response.errors.map((row) => row.message).join("; ")}`);

  const schema = response.schema;
  const rows = [...(response.rows ?? [])];
  let pageToken = response.pageToken;
  while (pageToken) {
    const params = new URLSearchParams({ pageToken, maxResults: String(protocol.page_size) });
    if (job.location) params.set("location", job.location);
    const page = await fetchJson(`${base}/queries/${encodeURIComponent(job.jobId)}?${params}`, { headers });
    if (!page.jobComplete) throw new Error("BigQuery returned an incomplete paginated result");
    rows.push(...(page.rows ?? []));
    pageToken = page.pageToken;
  }
  return {
    startedAt,
    completedAt: new Date().toISOString(),
    job,
    schema,
    rows: decodeBigQueryRows(schema, rows),
    statistics: {
      total_rows: Number(response.totalRows ?? rows.length),
      total_bytes_processed: response.totalBytesProcessed ?? "",
      total_bytes_billed: response.totalBytesBilled ?? "",
      cache_hit: Boolean(response.cacheHit),
    },
  };
}

async function freeze() {
  const path = join(DIRECTORY, "freeze.json");
  if (await exists(path)) return verifyFreeze();
  const gp0Present = await exists(join(OUTPUT, "gp0-lock.json"));
  const importPresent = await exists(join(OUTPUT, "mlab", "provenance-addendum", "input-lock.json"));
  if (importPresent) throw new Error("M-Lab future result is already locked; collector freeze is no longer causal");
  const manifest = {
    schema: "int-telemetry-experiment14b-v2-mlab-bigquery-collector-freeze/v1",
    frozen_at: new Date().toISOString(),
    parent_freeze: await fileRecord(join(OUTPUT, "freeze-manifest.json")),
    query_correction_freeze: await fileRecord(join(QUERY_CORRECTION_DIRECTORY, "freeze.json")),
    files: await Promise.all(FROZEN_INPUTS.map(fileRecord)),
    gp0_present_at_freeze: gp0Present,
    future_mlab_result_values_observed_by_freeze: 0,
    test_values_used_for_fit: 0,
    post_test_parameter_updates_allowed: false,
  };
  await writeJson(path, manifest);
  return manifest;
}

async function verifyFreeze() {
  const path = join(DIRECTORY, "freeze.json");
  if (!(await exists(path))) throw new Error("M-Lab BigQuery collector is not frozen");
  const frozen = await readJson(path);
  if (!(await recordValid(frozen.parent_freeze))) throw new Error("Experiment 14B v2 parent freeze changed");
  if (!(await recordValid(frozen.query_correction_freeze))) throw new Error("M-Lab query correction freeze changed");
  if (!(await allRecordsValid(frozen.files))) throw new Error("M-Lab BigQuery collector freeze changed");
  return frozen;
}

async function status() {
  const gp0Path = join(OUTPUT, "gp0-lock.json");
  const gp0 = await exists(gp0Path) ? await readJson(gp0Path) : null;
  const correctionAudit = await exists(join(QUERY_CORRECTION_DIRECTORY, "audit.json"))
    ? await readJson(join(QUERY_CORRECTION_DIRECTORY, "audit.json")) : null;
  const readyAt = gp0?.windows?.mlab_import_not_before ?? null;
  const auth = await credentials();
  return {
    schema: "int-telemetry-experiment14b-v2-mlab-bigquery-collector-status/v1",
    generated_at: new Date().toISOString(),
    gp0: gp0 ? "complete" : "pending",
    query_correction: correctionAudit?.evidence_status ?? "pending",
    publication_gate: readyAt && Date.now() >= new Date(readyAt).getTime() ? "open" : "pending",
    available_at: readyAt,
    authentication: auth.status,
    result: await exists(join(DIRECTORY, "result-lock.json")) ? "complete" : "pending",
  };
}

async function collect() {
  const frozen = await verifyFreeze();
  const resultLockPath = join(DIRECTORY, "result-lock.json");
  if (await exists(resultLockPath)) return { status: "complete", lock: await readJson(resultLockPath) };
  if (await exists(join(OUTPUT, "mlab", "provenance-addendum", "input-lock.json"))) {
    throw new Error("A M-Lab input is already locked; refusing to query or overwrite it");
  }
  const gp0Path = join(OUTPUT, "gp0-lock.json");
  if (!(await exists(gp0Path))) return { status: "pending-gp0" };
  const gp0 = await readJson(gp0Path);
  const availableAt = new Date(gp0.windows.mlab_import_not_before);
  if (Date.now() < availableAt.getTime()) return { status: "pending-publication-delay", available_at: availableAt.toISOString() };
  const correctionAudit = await readJson(join(QUERY_CORRECTION_DIRECTORY, "audit.json"));
  if (correctionAudit.evidence_status !== "query-semantics-correction-complete") {
    throw new Error("M-Lab query semantics correction is not complete");
  }
  const auth = await credentials();
  if (auth.status !== "ready") return { status: auth.status };

  const protocol = await readJson(PROTOCOL_PATH);
  const query = await readFile(QUERY_PATH, "utf8");
  const result = await queryBigQuery({ query, projectId: auth.projectId, token: auth.token, protocol });
  const columns = (result.schema?.fields ?? []).map((field) => field.name);
  const requiredColumns = (await readJson(V2_PROTOCOL_PATH)).mlab_strict.required_columns;
  if (columns.join("|") !== requiredColumns.join("|")) {
    throw new Error(`BigQuery result schema mismatch: ${columns.join(",")}`);
  }
  const csvPath = join(DIRECTORY, "future-window-export.csv");
  await writeCsv(csvPath, columns, result.rows);
  const csv = await readFile(csvPath);
  const metadataPath = join(DIRECTORY, "future-window-export-metadata.json");
  const jobId = `${result.job.projectId ?? auth.projectId}:${result.job.location ?? "unknown"}.${result.job.jobId}`;
  const metadata = {
    schema: "int-telemetry-experiment14b-v2-mlab-bigquery-export-metadata/v1",
    official_table: protocol.official_table,
    query_sha256: sha256(Buffer.from(query)),
    bigquery_job_id: jobId,
    query_started_at: result.startedAt,
    query_completed_at: result.completedAt,
    exported_at: new Date().toISOString(),
    row_count: result.rows.length,
    source_csv_sha256: sha256(csv),
    source_url: "https://console.cloud.google.com/bigquery?project=measurement-lab",
    license: "Measurement Lab open data; see https://www.measurementlab.net/about/",
    authentication_method: auth.method,
    billing_project: auth.projectId,
    statistics: result.statistics,
    test_values_used_for_fit: 0,
    post_test_parameter_updates: 0,
  };
  await writeJson(metadataPath, metadata);

  const child = spawnSync(process.execPath, [
    PROVENANCE_AUDITOR,
    "--import",
    "--mlab-csv", csvPath,
    "--mlab-metadata", metadataPath,
  ], { cwd: ROOT, stdio: "inherit", env: process.env });
  if (child.status !== 0) throw new Error(`M-Lab provenance importer exited with code ${child.status}`);
  const lock = {
    schema: "int-telemetry-experiment14b-v2-mlab-bigquery-collector-result-lock/v1",
    locked_at: new Date().toISOString(),
    frozen_at: frozen.frozen_at,
    bigquery_job_id: jobId,
    test_values_used_for_fit: 0,
    post_test_parameter_updates: 0,
    artifacts: {
      query: await fileRecord(QUERY_PATH),
      source_csv: await fileRecord(csvPath),
      source_metadata: await fileRecord(metadataPath),
      provenance_input_lock: await fileRecord(join(OUTPUT, "mlab", "provenance-addendum", "input-lock.json")),
    },
  };
  await writeJson(resultLockPath, lock);
  return { status: "complete", lock };
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const args = process.argv.slice(2);
  let result;
  if (args.includes("--freeze")) result = await freeze();
  else if (args.includes("--collect")) result = await collect();
  else result = await status();
  console.log(JSON.stringify(result, null, 2));
}
