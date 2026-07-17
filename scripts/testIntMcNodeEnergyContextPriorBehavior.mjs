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

function runReconstructor(args) {
  const result = spawnSync(process.execPath, ["stage2-int/tools/int-mc-reconstructor.mjs", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`reconstructor failed\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  }
}

async function createFixture(root) {
  const truthDir = join(root, "truth");
  const groundDir = join(root, "ground");
  await mkdir(truthDir, { recursive: true });
  await mkdir(groundDir, { recursive: true });

  const slices = [0, 1, 2];
  const pad = (value) => String(value).padStart(2, "0");
  const nodeIds = Array.from({ length: 600 }, (_, index) => {
    const plane = Math.floor(index / 12) + 1;
    const slot = (index % 12) + 1;
    return `P${pad(plane)}-S${pad(slot)}`;
  });
  const sparseObservedAnchors = new Set(nodeIds.slice(1, 7));
  const time = (slice) => `2026-06-16T00:${String(slice * 5).padStart(2, "0")}:00.000Z`;
  const truthNodes = [];
  const groundNodes = [];
  for (const slice of slices) {
    for (const nodeId of nodeIds) {
      const target = slice === 1 && nodeId === "P01-S01";
      const targetHistory = nodeId === "P01-S01" && slice !== 1;
      const sunlit = slice === 1;
      const sparseAnchor = sparseObservedAnchors.has(nodeId);
      const energy = target
        ? 94
        : targetHistory
          ? 70
          : sunlit
            ? 95
            : 72;
      truthNodes.push({
        slice_index: slice,
        time: time(slice),
        node_id: nodeId,
        label: nodeId,
        plane: Number(nodeId.slice(1, 3)) - 1,
        slot: Number(nodeId.slice(5, 7)) - 1,
        mode: "nominal",
        cpu_percent: 5,
        queue_depth: 0,
        queued_traffic_mb: 0,
        cache_used_mb: 12,
        energy_percent: energy,
        in_sunlight: sunlit,
        solar_exposure: sunlit ? 0.98 : 0,
        net_power_w: sunlit ? 140 : -80,
        transit_traffic_mbps: 0,
        power_saving_mode: false,
      });
      const observed = targetHistory || sparseAnchor;
      groundNodes.push({
        slice_index: slice,
        node_id: nodeId,
        observed,
        observation_source: observed ? "observed" : "unknown",
        last_observed_slice: observed ? slice : "",
        mode_estimate: observed ? "nominal" : "unknown",
        cpu_percent_estimate: observed ? 5 : "",
        queue_depth_estimate: observed ? 0 : "",
        queued_traffic_mb_estimate: observed ? 0 : "",
        cache_used_mb_estimate: observed ? 12 : "",
        energy_percent_estimate: observed ? energy : "",
        confidence: observed ? 1 : 0,
      });
    }
  }

  const truthLinks = slices.map((slice) => ({
    slice_index: slice,
    time: time(slice),
    link_id: "intra-plane:P01-S01->P01-S02",
    source: "P01-S01",
    target: "P01-S02",
    kind: "intra-plane",
    status: "up",
    is_active: true,
    p_available: 0.98,
    latency_ms: 7,
    queue_latency_ms: 1,
    capacity_mbps: 1000,
    effective_capacity_mbps: 1000,
    utilization_percent: 5,
    congestion_percent: 0,
    queued_traffic_mb: 0,
    dropped_traffic_mb: 0,
    packet_error_rate: 0.001,
  }));
  const groundLinks = truthLinks.map((link) => ({
    slice_index: link.slice_index,
    link_id: link.link_id,
    observed: true,
    observation_source: "observed",
    last_observed_slice: link.slice_index,
    status_estimate: "up",
    active_estimate: true,
    utilization_percent_estimate: link.utilization_percent,
    latency_ms_estimate: link.latency_ms,
    queue_latency_ms_estimate: link.queue_latency_ms,
    capacity_mbps_estimate: link.capacity_mbps,
    congestion_percent_estimate: link.congestion_percent,
    queued_traffic_mb_estimate: link.queued_traffic_mb,
    dropped_traffic_mb_estimate: link.dropped_traffic_mb,
    packet_error_rate_estimate: link.packet_error_rate,
    confidence: 1,
  }));

  await writeCsv(join(truthDir, "nodes.csv"), truthNodes);
  await writeCsv(join(truthDir, "links.csv"), truthLinks);
  await writeCsv(join(truthDir, "routes.csv"), []);
  await writeCsv(join(groundDir, "ground-reconstructed-links.csv"), groundLinks);
  await writeCsv(join(groundDir, "ground-reconstructed-nodes.csv"), groundNodes);
  return { truthDir, groundDir };
}

const root = resolve("stage2-int/runs/tmp-int-mc-node-energy-context-prior-test");
if (!root.includes("tmp-int-mc-node-energy-context-prior-test")) {
  throw new Error(`refusing to clean unexpected path: ${root}`);
}
if (existsSync(root)) rmSync(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });

const { truthDir, groundDir } = await createFixture(root);
const outDir = join(root, "out");
runReconstructor([
  "--input", truthDir,
  "--ground", groundDir,
  "--out", outDir,
  "--algorithm", "int-mc",
  "--rank", "2",
  "--iterations", "4",
  "--window-size", "2",
  "--node-metrics", "energy_percent",
  "--orbit-periodic-prior", "true",
  "--orbit-periodic-prior-slices", "19",
]);

const rows = parseCsv(await readFile(join(outDir, "ground-mc-reconstructed-nodes.csv"), "utf8"));
const target = rows.find((row) => String(row.slice_index) === "1" && row.node_id === "P01-S01");
assert.ok(target, "target node should be reconstructed");
assert.equal(target.observation_source, "inferred", "target should be inferred");
assert.equal(String(target.node_energy_context_prior_applied), "true", "sunlit missing node should use illumination energy prior");
assert.equal(target.node_energy_context_prior_source, "same-slice-illumination", "same-slice sunlit observations should be preferred");
assert.ok(
  numberValue(target.energy_percent_estimate) >= 80,
  "sunlit context should keep inferred battery energy from collapsing to stale shadow history",
);

const evaluation = JSON.parse(await readFile(join(outDir, "int-mc-evaluation.json"), "utf8"));
assert.ok(
  numberValue(evaluation.context_prior_summary.node_energy_context_prior_values) >= 1,
  "evaluation should count energy context prior applications",
);

console.log(JSON.stringify({
  ok: true,
  energy_percent_estimate: numberValue(target.energy_percent_estimate),
  context_prior_weight: numberValue(target.node_energy_context_prior_weight),
  context_prior_value: numberValue(target.node_energy_context_prior_value),
}, null, 2));
