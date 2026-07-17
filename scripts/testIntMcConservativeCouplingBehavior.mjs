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

async function readCsv(path) {
  return parseCsv(await readFile(path, "utf8"));
}

async function createFixture(root) {
  const truthDir = join(root, "truth");
  const groundDir = join(root, "ground");
  await mkdir(truthDir, { recursive: true });
  await mkdir(groundDir, { recursive: true });

  const slices = [0, 1, 2];
  const time = (slice) => `2026-06-16T00:${String(slice * 5).padStart(2, "0")}:00.000Z`;
  const linkCatalog = [
    ["inter-plane:P01-S01->P02-S01", "P01-S01", "P02-S01", "inter-plane"],
    ["inter-plane:P01-S02->P02-S02", "P01-S02", "P02-S02", "inter-plane"],
    ["intra-plane:P01-S01->P01-S02", "P01-S01", "P01-S02", "intra-plane"],
    ["intra-plane:P02-S01->P02-S02", "P02-S01", "P02-S02", "intra-plane"],
  ];
  const truthLinks = [];
  const groundLinks = [];
  for (const slice of slices) {
    for (const [linkId, source, target, kind] of linkCatalog) {
      const targetMissing = slice === 1 && linkId === "inter-plane:P01-S01->P02-S01";
      truthLinks.push({
        slice_index: slice,
        time: time(slice),
        link_id: linkId,
        source,
        target,
        kind,
        status: "up",
        is_active: true,
        p_available: 0.98,
        distance_km: kind === "inter-plane" ? 1500 : 900,
        latency_ms: 8,
        queue_latency_ms: 1,
        capacity_mbps: 1000,
        effective_capacity_mbps: 1000,
        utilization_percent: targetMissing ? 12 : 10,
        congestion_percent: 0,
        queued_traffic_mb: 0,
        dropped_traffic_mb: 0,
        packet_error_rate: 0.001,
      });
      groundLinks.push({
        slice_index: slice,
        link_id: linkId,
        observed: !targetMissing,
        observation_source: targetMissing ? "unknown" : "observed",
        last_observed_slice: targetMissing ? "" : slice,
        status_estimate: targetMissing ? "unknown" : "up",
        active_estimate: targetMissing ? "unknown" : true,
        utilization_percent_estimate: targetMissing ? "" : 10,
        latency_ms_estimate: targetMissing ? "" : 8,
        queue_latency_ms_estimate: targetMissing ? "" : 1,
        capacity_mbps_estimate: targetMissing ? "" : 1000,
        congestion_percent_estimate: targetMissing ? "" : 0,
        queued_traffic_mb_estimate: targetMissing ? "" : 0,
        dropped_traffic_mb_estimate: targetMissing ? "" : 0,
        packet_error_rate_estimate: targetMissing ? "" : 0.001,
        confidence: targetMissing ? 0 : 1,
      });
    }
  }

  const nodeIds = ["P01-S01", "P01-S02", "P02-S01", "P02-S02"];
  const truthNodes = [];
  const groundNodes = [];
  for (const slice of slices) {
    for (const nodeId of nodeIds) {
      const targetMissing = slice === 1 && nodeId === "P01-S01";
      const queueWarningMissing = slice === 1 && nodeId === "P02-S02";
      const queueWarningNode = nodeId === "P02-S02";
      truthNodes.push({
        slice_index: slice,
        time: time(slice),
        node_id: nodeId,
        label: nodeId,
        plane: Number(nodeId.slice(1, 3)) - 1,
        slot: Number(nodeId.slice(5, 7)) - 1,
        mode: queueWarningNode ? "warning" : "nominal",
        cpu_percent: targetMissing ? 4 : 3,
        queue_depth: queueWarningNode ? 96 : targetMissing ? 1 : 0,
        queued_traffic_mb: queueWarningNode ? 7200 : 0,
        cache_used_mb: 10,
        energy_percent: targetMissing ? 76 : 78,
        in_sunlight: true,
        solar_exposure: 0.8,
        net_power_w: 80,
        transit_traffic_mbps: 0,
        power_saving_mode: false,
      });
      groundNodes.push({
        slice_index: slice,
        node_id: nodeId,
        observed: !targetMissing && !queueWarningMissing,
        observation_source: targetMissing || queueWarningMissing ? "unknown" : "observed",
        last_observed_slice: targetMissing || queueWarningMissing ? "" : slice,
        mode_estimate: targetMissing || queueWarningMissing ? "unknown" : queueWarningNode ? "warning" : "nominal",
        cpu_percent_estimate: targetMissing || queueWarningMissing ? "" : 3,
        queue_depth_estimate: targetMissing || queueWarningMissing ? "" : queueWarningNode ? 96 : 0,
        queued_traffic_mb_estimate: targetMissing || queueWarningMissing ? "" : queueWarningNode ? 7200 : 0,
        cache_used_mb_estimate: targetMissing ? "" : 10,
        energy_percent_estimate: targetMissing ? "" : 78,
        confidence: targetMissing ? 0 : 1,
      });
    }
  }

  await writeCsv(join(truthDir, "links.csv"), truthLinks);
  await writeCsv(join(truthDir, "nodes.csv"), truthNodes);
  await writeCsv(join(truthDir, "routes.csv"), [{
    slice_index: 1,
    task_id: "T-low-load",
    status: "routed",
    source: "P01-S01",
    target: "P02-S01",
    traffic_mbps: 130,
    priority: 1,
    queue_delay_ms: 0,
    link_ids: "inter-plane:P01-S01->P02-S01",
  }]);
  await writeCsv(join(groundDir, "ground-reconstructed-links.csv"), groundLinks);
  await writeCsv(join(groundDir, "ground-reconstructed-nodes.csv"), groundNodes);

  return { truthDir, groundDir };
}

async function runScenario(root) {
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
    "--metric-tensor-coupling", "true",
    "--node-state-coupling", "true",
    "--joint-state-coupling", "true",
    "--state-tensor-joint-completion", "true",
    "--link-metrics", "utilization_percent,capacity_mbps,latency_ms,queue_latency_ms,congestion_percent,queued_traffic_mb,dropped_traffic_mb,packet_error_rate",
  ]);
  return {
    links: await readCsv(join(outDir, "ground-mc-reconstructed-links.csv")),
    nodes: await readCsv(join(outDir, "ground-mc-reconstructed-nodes.csv")),
    evaluation: JSON.parse(await readFile(join(outDir, "int-mc-evaluation.json"), "utf8")),
  };
}

const root = resolve("stage2-int/runs/tmp-int-mc-conservative-coupling-test");
if (!root.includes("tmp-int-mc-conservative-coupling-test")) {
  throw new Error(`refusing to clean unexpected path: ${root}`);
}
if (existsSync(root)) rmSync(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });

const result = await runScenario(root);
const targetNode = result.nodes.find((row) => String(row.slice_index) === "1" && row.node_id === "P01-S01");
const queueWarningNode = result.nodes.find((row) => String(row.slice_index) === "1" && row.node_id === "P02-S02");
const targetLink = result.links.find((row) => String(row.slice_index) === "1" && row.link_id === "inter-plane:P01-S01->P02-S01");
assert.ok(targetNode, "target node should be reconstructed");
assert.ok(queueWarningNode, "queue warning node should be reconstructed");
assert.ok(targetLink, "target link should be reconstructed");
assert.equal(targetNode.observation_source, "inferred", "target node should be inferred");
assert.equal(queueWarningNode.observation_source, "inferred", "queue warning node should be inferred");
assert.equal(targetLink.observation_source, "inferred", "target link should be inferred");

assert.equal(String(targetNode.node_state_coupling_applied), "false", "low-evidence node coupling should not apply a workload floor");
assert.ok(numberValue(targetNode.cpu_percent_estimate) < 10, "low-load inferred CPU should stay near the idle baseline");
assert.ok(numberValue(targetNode.queue_depth_estimate) <= 5, "low-load inferred queue depth should stay near the idle baseline");
assert.equal(targetNode.mode_estimate, "nominal", "low-load inferred node should remain nominal");
assert.ok(numberValue(queueWarningNode.queue_depth_estimate) >= 48, "high-queue inferred node should retain backlog pressure");
assert.equal(queueWarningNode.mode_estimate, "warning", "high-queue inferred node should be reconstructed as warning even when CPU is low");

assert.equal(String(targetLink.state_tensor_joint_completion_applied), "false", "low-evidence state tensor completion should not apply warning floors");
assert.equal(targetLink.status_estimate, "up", "low-load inferred link should remain up");
assert.ok(numberValue(targetLink.congestion_percent_estimate) < 5, "low-load inferred congestion should remain low");
assert.ok(numberValue(targetLink.packet_error_rate_estimate) < 0.005, "low-load inferred PER should remain low");

console.log(JSON.stringify({
  ok: true,
  cpu_percent: numberValue(targetNode.cpu_percent_estimate),
  queue_depth: numberValue(targetNode.queue_depth_estimate),
  node_coupling_applied: targetNode.node_state_coupling_applied,
  link_status: targetLink.status_estimate,
  state_tensor_applied: targetLink.state_tensor_joint_completion_applied,
}, null, 2));
