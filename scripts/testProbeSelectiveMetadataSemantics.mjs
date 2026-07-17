import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

function csvEscape(value) {
  const text = value === undefined || value === null ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function rowsToCsv(rows) {
  const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  return [
    headers.join(","),
    ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(",")),
  ].join("\n");
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === '"') {
      if (quoted && next === '"') {
        cell += '"';
        index += 1;
      } else quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell);
      if (row.some((value) => value.length > 0)) rows.push(row);
      row = [];
      cell = "";
    } else cell += char;
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    if (row.some((value) => value.length > 0)) rows.push(row);
  }
  const headers = rows[0] ?? [];
  return rows.slice(1).map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
}

function numberValue(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

const root = resolve("stage2-int/runs/tmp-selective-metadata-semantics-test");
if (!root.includes("tmp-selective-metadata-semantics-test")) throw new Error(`unsafe test root: ${root}`);
if (existsSync(root)) rmSync(root, { recursive: true, force: true });
const inputDir = join(root, "truth");
const stage2Dir = join(root, "stage2");
await mkdir(inputDir, { recursive: true });
await mkdir(stage2Dir, { recursive: true });

const nodes = ["A", "B", "C", "D"].map((nodeId, index) => ({
  slice_index: 0,
  time: "2026-07-13T00:00:00.000Z",
  node_id: nodeId,
  mode: index === 1 ? "warning" : "nominal",
  cpu_percent: 20 + index * 10,
  queue_depth: 2 + index,
  queued_traffic_mb: 4 + index,
  cache_used_mb: 8 + index,
  energy_percent: 90 - index * 5,
  can_accept_tasks: true,
}));
const links = [
  { link_id: "L1", source: "A", target: "B", utilization_percent: 31 },
  { link_id: "L2", source: "B", target: "C", utilization_percent: 67 },
  { link_id: "L3", source: "B", target: "D", utilization_percent: 82 },
].map((link) => ({
  ...link,
  slice_index: 0,
  time: "2026-07-13T00:00:00.000Z",
  kind: "inter-plane",
  is_active: true,
  status: "up",
  latency_ms: 8,
  queue_latency_ms: 2,
  effective_capacity_mbps: 1000,
  congestion_percent: 5,
  queued_traffic_mb: 1,
  dropped_traffic_mb: 0,
  packet_error_rate: 0.001,
}));
const hopPlan = [
  {
    hop_index: 0,
    profile: "link-light",
    node_fields_present: [],
    link_fields_present: ["link_id", "status", "is_active", "utilization_percent", "queue_latency_ms"],
    metadata_bytes: 20,
    writes_observation: true,
  },
  {
    hop_index: 1,
    profile: "node-full",
    node_fields_present: ["node_id", "mode", "cpu_percent", "queue_depth", "queued_traffic_mb", "cache_used_mb", "energy_percent", "can_accept_tasks"],
    link_fields_present: ["link_id", "status", "is_active", "utilization_percent", "latency_ms", "queue_latency_ms", "effective_capacity_mbps", "queued_traffic_mb", "dropped_traffic_mb", "congestion_percent", "packet_error_rate"],
    metadata_bytes: 96,
    writes_observation: true,
  },
  {
    hop_index: 2,
    profile: "forward-only",
    node_fields_present: [],
    link_fields_present: [],
    metadata_bytes: 0,
    writes_observation: false,
  },
];
const probes = [{
  slice_index: 0,
  time: "2026-07-13T00:00:00.000Z",
  probe_id: "selective-probe",
  planning_algorithm: "int-mc",
  source: "A",
  sink: "C",
  path: "A > B > C",
  link_ids: "L1 > L2",
  adaptive_metadata_profile: "importance-selective",
  adaptive_link_observation_mode: "path-only",
  selective_metadata_enabled: true,
  selective_metadata_plan_json: JSON.stringify(hopPlan),
  target_mask_bytes: 5,
}];

await writeFile(join(inputDir, "nodes.csv"), rowsToCsv(nodes), "utf8");
await writeFile(join(inputDir, "links.csv"), rowsToCsv(links), "utf8");
await writeFile(join(stage2Dir, "probe-paths-int-mc.csv"), rowsToCsv(probes), "utf8");

const result = spawnSync(process.execPath, [
  "stage2-int/tools/probe-int-runner.mjs",
  "--input", inputDir,
  "--stage2", stage2Dir,
  "--out", stage2Dir,
  "--algorithm", "int-mc",
  "--link-observation-mode", "path-only",
  "--hop-bytes", "96",
  "--probe-packet-base-bytes", "64",
  "--report-header-bytes", "128",
], { cwd: process.cwd(), encoding: "utf8" });
if (result.status !== 0) throw new Error(`runner failed\n${result.stdout}\n${result.stderr}`);

const hops = parseCsv(await readFile(join(stage2Dir, "probe-int-hop-records-int-mc.csv"), "utf8"));
const reports = parseCsv(await readFile(join(stage2Dir, "probe-int-reports-int-mc.csv"), "utf8"));
const report = JSON.parse(await readFile(join(stage2Dir, "probe-int-run-report-int-mc.json"), "utf8"));

assert.equal(hops.length, 2, "forward-only hop must not become an OAM observation row");
assert.deepEqual(hops.map((row) => row.selective_metadata_profile), ["link-light", "node-full"]);

const light = hops[0];
assert.equal(light.node_id, "A", "routing identity remains available for the collector envelope");
assert.equal(light.observed_cpu_percent, "", "link-light hop must not expose CPU state");
assert.equal(light.observed_energy_percent, "", "link-light hop must not expose energy state");
assert.equal(numberValue(light.observed_link_utilization_percent), 31);
assert.equal(light.node_fields_present, "");
assert.match(light.link_fields_present, /utilization_percent/);

const full = hops[1];
assert.equal(numberValue(full.observed_cpu_percent), 30);
assert.equal(numberValue(full.observed_energy_percent), 85);
assert.equal(numberValue(full.observed_link_utilization_percent), 67);
assert.match(full.node_fields_present, /cpu_percent/);

assert.equal(numberValue(reports[0].record_count), 2);
assert.equal(numberValue(reports[0].report_size_bytes), 244);
assert.equal(numberValue(reports[0].target_mask_bytes), 5);
assert.equal(numberValue(report.overhead.total_metadata_bytes), 116);
assert.equal(numberValue(report.overhead.total_target_mask_bytes), 5);
assert.equal(numberValue(report.overhead.metadata_writing_hops), 2);
assert.equal(numberValue(report.overhead.forward_only_hops), 1);
assert.equal(numberValue(report.overhead.forwarding_hops), 3);
assert.equal(numberValue(report.overhead.total_telemetry_generated_bytes), 429);

const neighborhoodDir = join(root, "target-neighborhood");
await mkdir(neighborhoodDir, { recursive: true });
const neighborhoodPlan = [0, 1, 2].map((hopIndex) => ({
  hop_index: hopIndex,
  profile: "node-core",
  node_fields_present: ["cpu_percent"],
  link_fields_present: [],
  metadata_bytes: 32,
  writes_observation: true,
}));
await writeFile(join(neighborhoodDir, "probe-paths-int-mc.csv"), rowsToCsv([{
  slice_index: 0,
  time: "2026-07-13T00:00:00.000Z",
  probe_id: "target-neighborhood-probe",
  planning_algorithm: "int-mc",
  source: "A",
  sink: "C",
  path: "A > B > C",
  link_ids: "L1 > L2",
  adaptive_metadata_profile: "importance-selective",
  adaptive_link_observation_mode: "target-neighborhood",
  selective_adjacent_link_profile: "link-core",
  selective_metadata_enabled: true,
  selective_metadata_plan_json: JSON.stringify(neighborhoodPlan),
  importance_adjacent_link_target_ids: "L3",
  planning_importance_repair_target_ids: "link|L3",
  target_mask_bytes: 5,
}]), "utf8");
const neighborhoodRun = spawnSync(process.execPath, [
  "stage2-int/tools/probe-int-runner.mjs",
  "--input", inputDir,
  "--stage2", neighborhoodDir,
  "--out", neighborhoodDir,
  "--algorithm", "int-mc",
  "--link-observation-mode", "path-only",
  "--hop-bytes", "96",
  "--probe-packet-base-bytes", "64",
  "--report-header-bytes", "128",
], { cwd: process.cwd(), encoding: "utf8" });
if (neighborhoodRun.status !== 0) {
  throw new Error(`target-neighborhood runner failed\n${neighborhoodRun.stdout}\n${neighborhoodRun.stderr}`);
}
const neighborhoodHops = parseCsv(
  await readFile(join(neighborhoodDir, "probe-int-hop-records-int-mc.csv"), "utf8"),
);
const adjacentRecords = neighborhoodHops.filter((row) => row.observation_scope === "local-adjacent-link");
assert.deepEqual(
  adjacentRecords.map((row) => row.observed_link_id),
  ["L3"],
  "target-neighborhood mode must scan only the nominated adjacent link",
);
assert.equal(adjacentRecords[0].selective_metadata_profile, "link-core-adjacent");
assert.equal(numberValue(adjacentRecords[0].hop_metadata_bytes), 48);

console.log(JSON.stringify({
  ok: true,
  forwarding_hops: report.overhead.forwarding_hops,
  observation_rows: hops.length,
  metadata_bytes: report.overhead.total_metadata_bytes,
  target_mask_bytes: report.overhead.total_target_mask_bytes,
  total_bytes: report.overhead.total_telemetry_generated_bytes,
}, null, 2));
