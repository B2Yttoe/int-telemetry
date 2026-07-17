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
  const targetNode = "P01-S01";
  const targetLink = "inter-plane:P01-S01->P02-S01";
  const linkCatalog = [
    [targetLink, "P01-S01", "P02-S01", "inter-plane"],
    ["intra-plane:P01-S01->P01-S02", "P01-S01", "P01-S02", "intra-plane"],
    ["intra-plane:P02-S01->P02-S02", "P02-S01", "P02-S02", "intra-plane"],
  ];
  const truthLinks = [];
  const groundLinks = [];
  for (const slice of slices) {
    for (const [linkId, source, target, kind] of linkCatalog) {
      truthLinks.push({
        slice_index: slice,
        time: time(slice),
        link_id: linkId,
        source,
        target,
        kind,
        status: "up",
        is_active: true,
        p_available: 0.96,
        distance_km: kind === "inter-plane" ? 1500 : 900,
        latency_ms: 8,
        queue_latency_ms: 1,
        capacity_mbps: 1000,
        effective_capacity_mbps: 1000,
        utilization_percent: slice === 1 && linkId === targetLink ? 88 : 20,
        congestion_percent: slice === 1 && linkId === targetLink ? 26 : 0,
        queued_traffic_mb: slice === 1 && linkId === targetLink ? 90 : 0,
        dropped_traffic_mb: 0,
        packet_error_rate: slice === 1 && linkId === targetLink ? 0.02 : 0.001,
      });
      groundLinks.push({
        slice_index: slice,
        link_id: linkId,
        observed: true,
        observation_source: "observed",
        last_observed_slice: slice,
        status_estimate: "up",
        active_estimate: true,
        utilization_percent_estimate: 20,
        latency_ms_estimate: 8,
        queue_latency_ms_estimate: 1,
        capacity_mbps_estimate: 1000,
        congestion_percent_estimate: 0,
        queued_traffic_mb_estimate: 0,
        dropped_traffic_mb_estimate: 0,
        packet_error_rate_estimate: 0.001,
        confidence: 1,
      });
    }
  }

  const nodeIds = ["P01-S01", "P01-S02", "P02-S01", "P02-S02"];
  const truthNodes = [];
  const groundNodes = [];
  for (const slice of slices) {
    for (const nodeId of nodeIds) {
      const target = slice === 1 && nodeId === targetNode;
      truthNodes.push({
        slice_index: slice,
        time: time(slice),
        node_id: nodeId,
        label: nodeId,
        plane: Number(nodeId.slice(1, 3)) - 1,
        slot: Number(nodeId.slice(5, 7)) - 1,
        mode: target ? "nominal" : "nominal",
        cpu_percent: target ? 82 : 20,
        queue_depth: target ? 56 : 2,
        queued_traffic_mb: target ? 70 : 0,
        cache_used_mb: target ? 95 : 10,
        energy_percent: target ? 54 : 82,
        in_sunlight: target ? false : true,
        solar_exposure: target ? 0.02 : 0.8,
        net_power_w: target ? -180 : 90,
        transit_traffic_mbps: target ? 1350 : 0,
        power_saving_mode: false,
      });
      const observed = !target;
      groundNodes.push({
        slice_index: slice,
        node_id: nodeId,
        observed,
        observation_source: observed ? "observed" : "unknown",
        last_observed_slice: observed ? slice : "",
        mode_estimate: observed ? "nominal" : "unknown",
        cpu_percent_estimate: observed ? 20 : "",
        queue_depth_estimate: observed ? 2 : "",
        queued_traffic_mb_estimate: observed ? 0 : "",
        cache_used_mb_estimate: observed ? 10 : "",
        energy_percent_estimate: observed ? 82 : "",
        confidence: observed ? 1 : 0,
      });
    }
  }

  await writeCsv(join(truthDir, "links.csv"), truthLinks);
  await writeCsv(join(truthDir, "nodes.csv"), truthNodes);
  await writeCsv(join(truthDir, "routes.csv"), [{
    slice_index: 1,
    task_id: "T-node-hotspot",
    status: "routed",
    source: "P01-S01",
    target: "P02-S01",
    traffic_mbps: 1350,
    priority: 3,
    queue_delay_ms: 42000,
    link_ids: targetLink,
  }]);
  await writeCsv(join(groundDir, "ground-reconstructed-links.csv"), groundLinks);
  await writeCsv(join(groundDir, "ground-reconstructed-nodes.csv"), groundNodes);

  return { truthDir, groundDir, targetNode };
}

async function runScenario({ root, nodeStateCoupling }) {
  const { truthDir, groundDir, targetNode } = await createFixture(root);
  const outDir = join(root, nodeStateCoupling ? "out-node-coupled" : "out-native");
  const args = [
    "--input", truthDir,
    "--ground", groundDir,
    "--out", outDir,
    "--algorithm", "int-mc",
    "--rank", "2",
    "--iterations", "4",
    "--window-size", "2",
  ];
  if (nodeStateCoupling) args.push("--node-state-coupling", "true");
  runReconstructor(args);
  return {
    rows: await readCsv(join(outDir, "ground-mc-reconstructed-nodes.csv")),
    evaluation: JSON.parse(await readFile(join(outDir, "int-mc-evaluation.json"), "utf8")),
    targetNode,
  };
}

const root = resolve("stage2-int/runs/tmp-int-mc-node-state-coupling-test");
if (!root.includes("tmp-int-mc-node-state-coupling-test")) {
  throw new Error(`refusing to clean unexpected path: ${root}`);
}
if (existsSync(root)) rmSync(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });

const coupled = await runScenario({ root: join(root, "coupled"), nodeStateCoupling: true });
const coupledTarget = coupled.rows.find((row) => String(row.slice_index) === "1" && row.node_id === coupled.targetNode);
assert.ok(coupledTarget, "coupled fixture should reconstruct target node");
assert.equal(coupledTarget.observation_source, "inferred", "target node should be inferred rather than directly observed");
assert.equal(String(coupledTarget.node_state_coupling_enabled), "true", "node state coupling should be enabled in enhanced run");
assert.equal(String(coupledTarget.node_state_coupling_applied), "true", "node state coupling should adjust inferred node metrics");
assert.ok(String(coupledTarget.node_state_coupled_metrics).includes("cpu_percent"), "coupling should report adjusted CPU");
assert.ok(String(coupledTarget.node_state_coupled_metrics).includes("queue_depth"), "coupling should report adjusted queue depth");
assert.ok(String(coupledTarget.node_state_coupled_metrics).includes("energy_percent"), "coupling should report adjusted energy");
assert.ok(String(coupledTarget.node_state_coupling_tags).includes("node-workload-energy-coupling"), "tags should explain node workload coupling");
assert.ok(numberValue(coupledTarget.node_state_coupling_pressure) >= 0.45, "high routed workload should create node pressure");
assert.ok(numberValue(coupledTarget.cpu_percent_estimate) >= 60, "high routed workload should raise inferred CPU");
assert.ok(numberValue(coupledTarget.queue_depth_estimate) >= 20, "high routed workload should raise inferred queue depth");
assert.ok(numberValue(coupledTarget.queued_traffic_mb_estimate) >= 20, "high routed workload should raise inferred queued traffic");
assert.ok(numberValue(coupledTarget.energy_percent_estimate) <= 70, "shadowed high-workload node should not keep a high energy estimate");
assert.equal(coupled.evaluation.parameters.node_state_coupling_enabled, true, "evaluation should record node coupling as enabled");
assert.ok(numberValue(coupled.evaluation.context_prior_summary.node_state_coupled_samples) >= 1, "evaluation should count node-coupled samples");

const native = await runScenario({ root: join(root, "native"), nodeStateCoupling: false });
const nativeTarget = native.rows.find((row) => String(row.slice_index) === "1" && row.node_id === native.targetNode);
assert.ok(nativeTarget, "native fixture should reconstruct target node");
assert.notEqual(String(nativeTarget.node_state_coupling_applied), "true", "native INT-MC should not apply node state coupling by default");
assert.equal(native.evaluation.parameters.node_state_coupling_enabled, false, "evaluation should record node coupling as disabled by default");

console.log(JSON.stringify({
  ok: true,
  node_pressure: numberValue(coupledTarget.node_state_coupling_pressure),
  node_metrics: coupledTarget.node_state_coupled_metrics,
  cpu_percent: numberValue(coupledTarget.cpu_percent_estimate),
  queue_depth: numberValue(coupledTarget.queue_depth_estimate),
  energy_percent: numberValue(coupledTarget.energy_percent_estimate),
}, null, 2));
