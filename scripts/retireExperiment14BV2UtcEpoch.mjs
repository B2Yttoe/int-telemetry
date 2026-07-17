import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { buildFreshWalkerSnapshot } from "./experiments/freshOrbitAcquisition.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const OUTPUT = resolve(ROOT, "reports/experiment14b-prospective-external-validation-v2");
const RETIREMENT_PATH = resolve(OUTPUT, "UTC_EPOCH_RETIREMENT.json");
const FUTURE_RESULTS = [
  "gp1-lock.json",
  "radar/radar-prospective-score.json",
  "radar/causality-status-addendum/causality-lock.json",
  "ripe-public-fixed-anchor/result-lock.json",
  "mlab/bigquery-collector/result-lock.json",
  "mlab/provenance-addendum/input-lock.json",
  "mlab/strict-future/import-lock.json",
];
const SOURCE_PATHS = [
  "src/simulation/realTleCatalog.ts",
  "src/simulation/walker.ts",
  "src/simulation/tle.ts",
  "scripts/experiments/freshOrbitAcquisition.mjs",
  "scripts/experiments/experiment14Sources.mjs",
];

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
async function exists(path) { try { await stat(path); return true; } catch { return false; } }
async function readJson(path) { return JSON.parse(await readFile(path, "utf8")); }
async function fileRecord(path) {
  const content = await readFile(path);
  return { path: relative(ROOT, path).replaceAll("\\", "/"), bytes: content.length, sha256: sha256(content) };
}

async function buildMapping() {
  const gp0 = await readJson(resolve(OUTPUT, "gp0-lock.json"));
  const records = await readJson(resolve(ROOT, gp0.artifacts.gp.path));
  const snapshot = await buildFreshWalkerSnapshot(records, {
    group: "STARLINK",
    sourceUrl: gp0.source_url,
    downloadedAt: gp0.source_acquired_at,
    planes: 72,
    satellitesPerPlane: 22,
    raanClusterThresholdDeg: 2.5,
  });
  const sampleEpoch = snapshot.satellites[0]?.epoch ?? "";
  return {
    timezone: process.env.TZ ?? "system-default",
    sample_epoch: sampleEpoch,
    sample_epoch_ms: Date.parse(sampleEpoch),
    mapping: snapshot.satellites.map((row) => ({
      norad_id: row.norad_id,
      plane_id: row.plane_id,
      slot_id: row.slot_id,
    })),
  };
}

function childMapping(timezone) {
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--mapping-child"], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, TZ: timezone },
    maxBuffer: 32 * 1024 * 1024,
  });
  if (child.status !== 0) throw new Error(`Mapping child (${timezone}) failed: ${child.stderr || child.stdout}`);
  return JSON.parse(child.stdout);
}

function compareMappings(local, utc) {
  const localById = new Map(local.mapping.map((row) => [String(row.norad_id), row]));
  const utcById = new Map(utc.mapping.map((row) => [String(row.norad_id), row]));
  const shared = [...localById.keys()].filter((id) => utcById.has(id));
  const samePlane = shared.filter((id) => localById.get(id).plane_id === utcById.get(id).plane_id);
  const sameSlot = shared.filter((id) => {
    const left = localById.get(id);
    const right = utcById.get(id);
    return left.plane_id === right.plane_id && left.slot_id === right.slot_id;
  });
  return {
    local_selected_satellites: local.mapping.length,
    utc_selected_satellites: utc.mapping.length,
    shared_satellites: shared.length,
    selected_set_overlap_ratio: shared.length / Math.max(utc.mapping.length, 1),
    changed_selected_satellites: utc.mapping.length - shared.length,
    same_plane_satellites: samePlane.length,
    same_plane_ratio_among_shared: samePlane.length / Math.max(shared.length, 1),
    same_plane_slot_satellites: sameSlot.length,
    same_plane_slot_ratio_among_shared: sameSlot.length / Math.max(shared.length, 1),
    naive_epoch_parse_difference_hours: (utc.sample_epoch_ms - local.sample_epoch_ms) / 3_600_000,
    freshness_age_overstatement_hours_in_utc_plus_8: (utc.sample_epoch_ms - local.sample_epoch_ms) / 3_600_000,
  };
}

async function retire() {
  if (await exists(RETIREMENT_PATH)) return readJson(RETIREMENT_PATH);
  const observed = [];
  for (const path of FUTURE_RESULTS) if (await exists(resolve(OUTPUT, path))) observed.push(path);
  if (observed.length) throw new Error(`Cannot claim pre-result retirement; future artifacts exist: ${observed.join(", ")}`);
  const local = childMapping("Asia/Shanghai");
  const utc = childMapping("UTC");
  const comparison = compareMappings(local, utc);
  if (Math.abs(comparison.naive_epoch_parse_difference_hours - 8) > 1e-9) {
    throw new Error(`Expected an 8-hour UTC parsing difference, found ${comparison.naive_epoch_parse_difference_hours}`);
  }
  const gp0 = await readJson(resolve(OUTPUT, "gp0-lock.json"));
  const record = {
    schema: "int-telemetry-experiment14b-v2-utc-epoch-retirement/v1",
    retired_at: new Date().toISOString(),
    status: "retired-before-gp1-radar-ripe-mlab-future-results",
    reason: "CelesTrak OMM EPOCH values without an explicit zone were interpreted as local time in freshness and Walker plane-slot phase calculations. OMM epochs are UTC.",
    propagation_scope: "satellite.js json2satrec already appends Z and propagated ECI/ECEF positions with UTC semantics; the defect affects orbit-age evidence, satellite sampling, and plane-slot identity used by Walker topology construction.",
    scientific_disposition: "This run is retained only as an audit trail and must not be used as final Experiment 14B evidence.",
    future_result_artifacts_observed_by_retirement: 0,
    gp0_source_acquired_at: gp0.source_acquired_at,
    gp0_source_content_sha256: gp0.source_content_sha256,
    comparison,
    sample_epoch: utc.sample_epoch,
    frozen_artifacts: await Promise.all([
      resolve(OUTPUT, "freeze-manifest.json"),
      resolve(OUTPUT, "gp0-lock.json"),
      resolve(OUTPUT, "orbit/gp0/gp0-walker-72x22.json"),
      resolve(OUTPUT, "final-evidence-chain-addendum/freeze.json"),
    ].map(fileRecord)),
    affected_source_before_fix: await Promise.all(SOURCE_PATHS.map((path) => fileRecord(resolve(ROOT, path)))),
  };
  await writeFile(RETIREMENT_PATH, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  await writeFile(`${RETIREMENT_PATH}.sha256`, `${sha256(await readFile(RETIREMENT_PATH))}\n`, "utf8");
  return record;
}

const direct = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (direct) {
  if (process.argv.includes("--mapping-child")) console.log(JSON.stringify(await buildMapping()));
  else console.log(JSON.stringify(await retire(), null, 2));
}
