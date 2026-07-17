import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { readCsvStream } from "../stage2-int/tools/csv-stream.mjs";
import {
  applyUserPerformanceCalibration,
  buildServerLocationIndex,
  buildUserPerformanceContexts,
  loadUserPerformanceTopology,
  performanceRowsForCsv,
} from "./experiments/userPerformanceLayer.mjs";
import {
  normalizePublicFixedAnchorResults,
  validatePublicFixedAnchorMetadata,
} from "./experiments/publicFixedAnchorRipe.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const OUTPUT = resolve(ROOT, "reports/experiment14b-prospective-external-validation-v2-utc-corrected");
const DIRECTORY = join(OUTPUT, "ripe-public-fixed-anchor");
const PROTOCOL_PATH = resolve(ROOT, "scripts/experiments/experiment14b-v2-ripe-public-fixed-anchor-addendum.json");
const V2_PROTOCOL_PATH = resolve(ROOT, "scripts/experiments/experiment14b-v2-protocol.json");
const DEPENDENCIES = [
  PROTOCOL_PATH,
  resolve(ROOT, "scripts/runExperiment14BV2PublicFixedAnchorRipe.mjs"),
  resolve(ROOT, "scripts/experiments/publicFixedAnchorRipe.mjs"),
  resolve(ROOT, "scripts/experiments/userPerformanceLayer.mjs"),
  resolve(ROOT, "stage2-int/tools/csv-stream.mjs"),
];

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
async function exists(path) { try { await stat(path); return true; } catch { return false; } }
async function readJson(path) { return JSON.parse(await readFile(path, "utf8")); }
async function writeJson(path, value) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8"); }
function csvEscape(value) { const text = String(value ?? ""); return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text; }
async function writeCsv(path, rows) {
  await mkdir(dirname(path), { recursive: true });
  if (!rows.length) return writeFile(path, "", "utf8");
  const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const lines = [headers.join(","), ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(","))];
  return writeFile(path, `${lines.join("\n")}\n`, "utf8");
}
async function record(path) {
  const content = await readFile(path);
  return { path: relative(ROOT, path).replaceAll("\\", "/"), bytes: content.length, sha256: sha256(content) };
}
async function fetchJson(url) {
  const response = await fetch(url, { headers: { accept: "application/json", "user-agent": "INT-Telemetry-Experiment14B-v2/1.0" } });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.json();
}
async function sourceMetadata(protocol) {
  const measurementUrl = `https://atlas.ripe.net/api/v2/measurements/${protocol.measurement.id}/`;
  const anchorUrl = `https://atlas.ripe.net/api/v2/anchors/?search=${encodeURIComponent(protocol.measurement.target_fqdn)}&page_size=20`;
  const probeUrl = `https://atlas.ripe.net/api/v2/probes/${protocol.source_probe.id}/`;
  const [measurement, anchorPayload, probe] = await Promise.all([
    fetchJson(measurementUrl), fetchJson(anchorUrl), fetchJson(probeUrl),
  ]);
  const anchor = (anchorPayload.results ?? []).find((row) => Number(row.id) === Number(protocol.anchor.id));
  if (!anchor) throw new Error(`RIPE Anchor ${protocol.anchor.id} was not returned`);
  return { measurement, anchor, probe, urls: { measurement: measurementUrl, anchor: anchorUrl, probe: probeUrl } };
}

async function freeze() {
  const manifestPath = join(DIRECTORY, "freeze.json");
  if (await exists(manifestPath)) return readJson(manifestPath);
  const protocol = await readJson(PROTOCOL_PATH);
  const source = await sourceMetadata(protocol);
  const validation = validatePublicFixedAnchorMetadata({ protocol, ...source });
  if (!validation.passed) throw new Error(`Public fixed-anchor preflight failed: ${validation.failures.join(", ")}`);
  await writeJson(join(DIRECTORY, "frozen-measurement.json"), source.measurement);
  await writeJson(join(DIRECTORY, "frozen-anchor.json"), source.anchor);
  await writeJson(join(DIRECTORY, "frozen-probe.json"), source.probe);
  const manifest = {
    schema: "int-telemetry-experiment14b-v2-ripe-public-fixed-anchor-freeze/v1",
    frozen_at: new Date().toISOString(),
    parent_v2_freeze_sha256: sha256(await readFile(join(OUTPUT, "freeze-manifest.json"))),
    protocol: await record(PROTOCOL_PATH),
    dependencies: await Promise.all(DEPENDENCIES.map(record)),
    source_validation: validation,
    source_urls: source.urls,
    source_artifacts: {
      measurement: await record(join(DIRECTORY, "frozen-measurement.json")),
      anchor: await record(join(DIRECTORY, "frozen-anchor.json")),
      probe: await record(join(DIRECTORY, "frozen-probe.json")),
    },
    future_result_values_observed_by_freeze: 0,
    future_result_values_used_for_selection: 0,
    post_test_parameter_updates_allowed: false,
  };
  await writeJson(manifestPath, manifest);
  return manifest;
}

async function verifyFreeze() {
  const manifest = await readJson(join(DIRECTORY, "freeze.json"));
  for (const expected of [manifest.protocol, ...manifest.dependencies, ...Object.values(manifest.source_artifacts)]) {
    const current = await record(resolve(ROOT, expected.path));
    if (current.bytes !== expected.bytes || current.sha256 !== expected.sha256) throw new Error(`Public fixed-anchor freeze dependency changed: ${expected.path}`);
  }
  const parentHash = sha256(await readFile(join(OUTPUT, "freeze-manifest.json")));
  if (parentHash !== manifest.parent_v2_freeze_sha256) throw new Error("Experiment 14B v2 parent freeze changed");
  return manifest;
}

async function preflight() {
  await verifyFreeze();
  const protocol = await readJson(PROTOCOL_PATH);
  const source = await sourceMetadata(protocol);
  const validation = validatePublicFixedAnchorMetadata({ protocol, ...source });
  return { schema: "int-telemetry-experiment14b-v2-ripe-public-preflight/v1", generated_at: new Date().toISOString(), ...validation, source_urls: source.urls };
}

async function collect() {
  const frozen = await verifyFreeze();
  const protocol = await readJson(PROTOCOL_PATH);
  const gp0Path = join(OUTPUT, "gp0-lock.json");
  if (!(await exists(gp0Path))) return { status: "pending-gp0" };
  const gp0 = await readJson(gp0Path);
  const endTime = new Date(gp0.windows.topology_end);
  if (Date.now() < endTime.getTime()) return { status: "pending-topology-window-end", available_at: endTime.toISOString() };
  const lockPath = join(DIRECTORY, "result-lock.json");
  if (await exists(lockPath)) return { status: "complete", lock: await readJson(lockPath) };

  const source = await sourceMetadata(protocol);
  const validation = validatePublicFixedAnchorMetadata({ protocol, ...source });
  if (!validation.passed) throw new Error(`Public fixed-anchor collection preflight failed: ${validation.failures.join(", ")}`);
  const start = Math.floor(new Date(gp0.windows.topology_start).getTime() / 1000);
  const stop = Math.floor(endTime.getTime() / 1000);
  const resultsUrl = `https://atlas.ripe.net/api/v2/measurements/${protocol.measurement.id}/results/?probe_ids=${protocol.source_probe.id}&start=${start}&stop=${stop}`;
  const results = await fetchJson(resultsUrl);
  const normalized = normalizePublicFixedAnchorResults(results, {
    protocol, anchor: source.anchor, probe: source.probe,
    startTime: gp0.windows.topology_start, endTime: gp0.windows.topology_end,
  });
  const rawPath = join(DIRECTORY, "future-window-raw-results.json");
  const normalizedPath = join(DIRECTORY, "future-window-rtt.csv");
  await writeJson(rawPath, results);
  await writeCsv(normalizedPath, normalized);
  if (normalized.length < protocol.window.minimum_results) {
    const status = { status: "insufficient-results", result_count: normalized.length, minimum_required: protocol.window.minimum_results, results_url: resultsUrl };
    await writeJson(join(DIRECTORY, "collection-status.json"), status);
    return status;
  }

  const v2 = await readJson(V2_PROTOCOL_PATH);
  const calibrationPath = resolve(ROOT, v2.mlab_strict.frozen_calibration_path);
  const calibrationRecord = (await readJson(join(OUTPUT, "freeze-manifest.json"))).files.find((row) => row.path === relative(ROOT, calibrationPath).replaceAll("\\", "/"));
  const currentCalibration = await record(calibrationPath);
  if (!calibrationRecord || currentCalibration.sha256 !== calibrationRecord.sha256 || currentCalibration.bytes !== calibrationRecord.bytes) {
    throw new Error("Frozen user-performance calibration changed");
  }
  const calibration = await readJson(calibrationPath);
  const topology = await loadUserPerformanceTopology(resolve(ROOT, gp0.artifacts.nodes.path), resolve(ROOT, gp0.artifacts.links.path));
  const contexts = buildUserPerformanceContexts(topology, normalized, (await readJson(join(OUTPUT, "freeze-manifest.json"))).fixed_parameters.user_performance, buildServerLocationIndex([]));
  const byId = new Map(normalized.map((row) => [String(row.uuid), row]));
  const predictions = applyUserPerformanceCalibration(contexts, calibration).map((row) => {
    const raw = byId.get(String(row.observation_id)) ?? {};
    return {
      ...row,
      server_id: raw.server_id ?? "",
      anchor_id: raw.anchor_id ?? "",
      client_asn: raw.client_asn ?? "",
      target_semantics: raw.target_semantics ?? "",
      source_provenance: raw.source_provenance ?? "",
    };
  });
  const canonicalPath = join(OUTPUT, "ripe-atlas", "ripe-paired-rtt.csv");
  if (await exists(canonicalPath)) throw new Error("Canonical RIPE paired RTT output already exists; refusing to overwrite another frozen source");
  await writeCsv(canonicalPath, performanceRowsForCsv(predictions));
  const lock = {
    schema: "int-telemetry-experiment14b-v2-ripe-public-fixed-anchor-result-lock/v1",
    locked_at: new Date().toISOString(),
    source_freeze_sha256: sha256(await readFile(join(DIRECTORY, "freeze.json"))),
    gp0_source_sha256: gp0.source_content_sha256,
    topology_window: { start: gp0.windows.topology_start, end: gp0.windows.topology_end },
    results_url: resultsUrl,
    result_count: normalized.length,
    modeled_count: predictions.filter((row) => row.status === "modeled").length,
    test_values_used_for_fit: 0,
    post_test_parameter_updates: 0,
    artifacts: {
      raw: await record(rawPath), normalized: await record(normalizedPath), predictions: await record(canonicalPath),
    },
    source_validation: validation,
    frozen_at: frozen.frozen_at,
  };
  await writeJson(lockPath, lock);
  return { status: "complete", lock };
}

const phaseIndex = process.argv.indexOf("--phase");
const phase = phaseIndex >= 0 ? process.argv[phaseIndex + 1] : "status";
let result;
if (phase === "freeze") result = await freeze();
else if (phase === "preflight") result = await preflight();
else if (phase === "collect") result = await collect();
else result = {
  phase: "status",
  freeze: await exists(join(DIRECTORY, "freeze.json")) ? "complete" : "pending",
  gp0: await exists(join(OUTPUT, "gp0-lock.json")) ? "complete" : "pending",
  result: await exists(join(DIRECTORY, "result-lock.json")) ? "complete" : "pending",
};
console.log(JSON.stringify(result, null, 2));
