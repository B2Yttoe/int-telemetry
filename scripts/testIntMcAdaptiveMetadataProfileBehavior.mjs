import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

function csvEscape(value) {
  const text = value === undefined || value === null ? "" : String(value);
  if (!/[",\n\r]/.test(text)) return text;
  return `"${text.replaceAll('"', '""')}"`;
}

function rowsToCsv(rows) {
  if (rows.length === 0) return "";
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
    if (char === "\"") {
      if (quoted && next === "\"") {
        cell += "\"";
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell);
      if (row.some((value) => value.length > 0)) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    if (row.some((value) => value.length > 0)) rows.push(row);
  }
  if (rows.length === 0) return [];
  const headers = rows[0];
  return rows.slice(1).map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
}

function numberValue(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function writeCsv(path, rows) {
  await writeFile(path, rowsToCsv(rows), "utf8");
}

async function readCsv(path) {
  return parseCsv(await readFile(path, "utf8"));
}

function runNode(script, args) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`${script} failed\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  }
}

async function createRunnerFixture(root) {
  const inputDir = join(root, "truth");
  const stage2Dir = join(root, "stage2");
  await mkdir(inputDir, { recursive: true });
  await mkdir(stage2Dir, { recursive: true });

  const nodes = ["P01-S01", "P01-S02", "P01-S03"].map((nodeId) => ({
    slice_index: 0,
    time: "2026-06-16T00:00:00.000Z",
    node_id: nodeId,
    mode: "nominal",
    cpu_percent: 20,
    queue_depth: 1,
    queued_traffic_mb: 0,
    cache_used_mb: 8,
    energy_percent: 88,
  }));
  const links = [
    ["intra-plane:P01-S01->P01-S02", "P01-S01", "P01-S02"],
    ["intra-plane:P01-S02->P01-S03", "P01-S02", "P01-S03"],
  ].map(([linkId, source, target]) => ({
    slice_index: 0,
    time: "2026-06-16T00:00:00.000Z",
    link_id: linkId,
    source,
    target,
    kind: "intra-plane",
    is_active: true,
    status: "up",
    latency_ms: 8,
    queue_latency_ms: 1,
    capacity_mbps: 1000,
    effective_capacity_mbps: 1000,
    utilization_percent: 20,
    congestion_percent: 0,
    queued_traffic_mb: 0,
    dropped_traffic_mb: 0,
    packet_error_rate: 0.001,
  }));
  const probePaths = [
    {
      slice_index: 0,
      time: "2026-06-16T00:00:00.000Z",
      probe_id: "compact-probe",
      planning_algorithm: "int-mc",
      source: "P01-S01",
      sink: "P01-S03",
      path_node_count: 3,
      path_link_count: 2,
      covered_link_count: 2,
      path: "P01-S01 > P01-S02 > P01-S03",
      link_ids: "intra-plane:P01-S01->P01-S02 > intra-plane:P01-S02->P01-S03",
      adaptive_metadata_profile: "reuse-compact",
      effective_hop_metadata_bytes: 48,
      metadata_compression_ratio: 0.5,
      adaptive_link_observation_mode: "path-only",
    },
    {
      slice_index: 0,
      time: "2026-06-16T00:00:00.000Z",
      probe_id: "normal-probe",
      planning_algorithm: "int-mc",
      source: "P01-S01",
      sink: "P01-S03",
      path_node_count: 3,
      path_link_count: 2,
      covered_link_count: 2,
      path: "P01-S01 > P01-S02 > P01-S03",
      link_ids: "intra-plane:P01-S01->P01-S02 > intra-plane:P01-S02->P01-S03",
    },
    {
      slice_index: 0,
      time: "2026-06-16T00:00:00.000Z",
      probe_id: "oam-target-aware-probe",
      planning_algorithm: "int-mc",
      source: "P01-S01",
      sink: "P01-S03",
      path_node_count: 3,
      path_link_count: 2,
      covered_link_count: 2,
      path: "P01-S01 > P01-S02 > P01-S03",
      link_ids: "intra-plane:P01-S01->P01-S02 > intra-plane:P01-S02->P01-S03",
      adaptive_metadata_profile: "oam-target-aware",
      adaptive_link_observation_mode: "target-neighborhood",
      target_hop_metadata_bytes: 96,
      transit_hop_metadata_bytes: 88,
      oam_feedback_mandatory_node_target_ids: "P01-S02",
      oam_feedback_mandatory_link_target_ids: "intra-plane:P01-S01->P01-S02",
    },
  ];

  await writeCsv(join(inputDir, "nodes.csv"), nodes);
  await writeCsv(join(inputDir, "links.csv"), links);
  await writeCsv(join(stage2Dir, "probe-paths-int-mc.csv"), probePaths);
  return { inputDir, stage2Dir };
}

async function runRunnerScenario(root) {
  const { inputDir, stage2Dir } = await createRunnerFixture(root);
  runNode("stage2-int/tools/probe-int-runner.mjs", [
    "--input", inputDir,
    "--stage2", stage2Dir,
    "--out", stage2Dir,
    "--algorithm", "int-mc",
    "--link-observation-mode", "all-adjacent",
    "--hop-bytes", "96",
    "--probe-packet-base-bytes", "64",
    "--report-header-bytes", "128",
  ]);
  return {
    hops: await readCsv(join(stage2Dir, "probe-int-hop-records-int-mc.csv")),
    reports: await readCsv(join(stage2Dir, "probe-int-reports-int-mc.csv")),
    runReport: JSON.parse(await readFile(join(stage2Dir, "probe-int-run-report-int-mc.json"), "utf8")),
  };
}

const root = resolve("stage2-int/runs/tmp-int-mc-adaptive-metadata-profile-test");
if (!root.includes("tmp-int-mc-adaptive-metadata-profile-test")) {
  throw new Error(`refusing to clean unexpected path: ${root}`);
}
if (existsSync(root)) rmSync(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });

const runner = await runRunnerScenario(join(root, "runner"));
const compactHops = runner.hops.filter((row) => row.probe_id === "compact-probe");
const normalHops = runner.hops.filter((row) => row.probe_id === "normal-probe");
const targetAwareHops = runner.hops.filter((row) => row.probe_id === "oam-target-aware-probe");
const compactReport = runner.reports.find((row) => row.probe_id === "compact-probe");
const normalReport = runner.reports.find((row) => row.probe_id === "normal-probe");
const targetAwareReport = runner.reports.find((row) => row.probe_id === "oam-target-aware-probe");

assert.equal(compactHops.length, 3, "compact probe should emit one hop record per path node");
assert.ok(normalHops.length > 3, "normal all-adjacent probe should emit path hops plus adjacent-link scan records");
assert.ok(compactHops.every((row) => row.observation_scope === "forwarding-hop"), "compact probe should suppress adjacent-link scan records");
assert.ok(normalHops.some((row) => row.observation_scope === "local-adjacent-link"), "normal probe should keep adjacent-link scan records");
assert.ok(compactHops.every((row) => numberValue(row.hop_metadata_bytes) === 48), "compact probe hop records should use per-probe compact metadata bytes");
assert.ok(normalHops.every((row) => numberValue(row.hop_metadata_bytes) === 96), "normal probe should keep default metadata bytes");
assert.equal(numberValue(compactReport.report_size_bytes), 128 + 3 * 48, "compact report size should use compact hop metadata bytes");
assert.equal(numberValue(normalReport.report_size_bytes), 128 + normalHops.length * 96, "normal report size should include adjacent-link scan metadata");
assert.equal(
  numberValue(runner.runReport.overhead.total_metadata_bytes),
  [...compactHops, ...normalHops, ...targetAwareHops]
    .reduce((total, row) => total + numberValue(row.hop_metadata_bytes), 0),
  "run report should sum per-hop metadata bytes",
);
assert.equal(
  numberValue(runner.runReport.overhead.compact_metadata_hop_records),
  runner.hops.filter((row) => numberValue(row.hop_metadata_bytes) < 96).length,
  "run report should count every record below the configured metadata size",
);
assert.equal(
  numberValue(runner.runReport.overhead.metadata_bytes_saved_by_profile),
  runner.hops.reduce((total, row) => total + Math.max(0, 96 - numberValue(row.hop_metadata_bytes)), 0),
  "run report should expose metadata bytes saved by all adaptive profiles",
);
assert.equal(numberValue(runner.runReport.planning.path_only_probe_paths), 1, "run report should count compact path-only probes");
assert.equal(numberValue(runner.runReport.planning.all_adjacent_probe_paths), 1, "run report should count standard all-adjacent probes");

const targetRecords = targetAwareHops.filter((row) => row.oam_target_record === "true");
const transitRecords = targetAwareHops.filter((row) => row.oam_transit_record === "true");
assert.ok(targetRecords.length > 0, "target-aware probe should mark mandatory target records");
assert.ok(transitRecords.length > 0, "target-aware probe should mark transit-only records");
assert.ok(targetRecords.every((row) => numberValue(row.hop_metadata_bytes) === 96), "mandatory target records should retain full metadata bytes");
assert.ok(transitRecords.every((row) => numberValue(row.hop_metadata_bytes) === 88), "transit-only records should use lightweight metadata bytes");
assert.ok(
  targetAwareHops
    .filter((row) => row.observation_scope === "local-adjacent-link")
    .every((row) => row.node_id === "P01-S02" || row.observed_link_id === "intra-plane:P01-S01->P01-S02"),
  "target-neighborhood mode should not scan unrelated adjacent links at transit-only nodes",
);
assert.equal(
  numberValue(targetAwareReport.report_size_bytes),
  128 + targetAwareHops.reduce((total, row) => total + numberValue(row.hop_metadata_bytes), 0),
  "target-aware report size should sum actual per-record metadata bytes",
);
assert.equal(numberValue(runner.runReport.planning.target_aware_probe_paths), 1, "run report should count target-aware OAM probe paths");
assert.equal(
  numberValue(runner.runReport.overhead.target_metadata_hop_records),
  targetRecords.length,
  "run report should count full target metadata records",
);
assert.equal(
  numberValue(runner.runReport.overhead.transit_metadata_hop_records),
  transitRecords.length,
  "run report should count lightweight transit metadata records",
);
assert.equal(
  numberValue(runner.runReport.overhead.target_aware_metadata_bytes_saved),
  targetAwareHops.reduce((total, row) => total + Math.max(0, 96 - numberValue(row.hop_metadata_bytes)), 0),
  "run report should isolate bytes saved by target-aware metadata",
);

console.log(JSON.stringify({
  ok: true,
  compact_report_bytes: numberValue(compactReport.report_size_bytes),
  normal_report_bytes: numberValue(normalReport.report_size_bytes),
  total_metadata_bytes: numberValue(runner.runReport.overhead.total_metadata_bytes),
  metadata_bytes_saved_by_profile: numberValue(runner.runReport.overhead.metadata_bytes_saved_by_profile),
}, null, 2));
