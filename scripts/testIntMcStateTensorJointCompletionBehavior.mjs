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
  const targetLink = "inter-plane:P01-S01->P02-S01";
  const linkCatalog = [
    [targetLink, "P01-S01", "P02-S01", "inter-plane"],
    ["inter-plane:P01-S02->P02-S02", "P01-S02", "P02-S02", "inter-plane"],
    ["intra-plane:P01-S01->P01-S02", "P01-S01", "P01-S02", "intra-plane"],
    ["intra-plane:P02-S01->P02-S02", "P02-S01", "P02-S02", "intra-plane"],
  ];

  const truthLinks = [];
  const groundLinks = [];
  for (const slice of slices) {
    for (const [linkId, source, target, kind] of linkCatalog) {
      const hiddenHotspot = slice === 1 && linkId === targetLink;
      truthLinks.push({
        slice_index: slice,
        time: time(slice),
        link_id: linkId,
        source,
        target,
        kind,
        status: hiddenHotspot ? "warning" : "up",
        is_active: true,
        p_available: hiddenHotspot ? 0.83 : 0.98,
        distance_km: kind === "inter-plane" ? 1550 : 920,
        latency_ms: hiddenHotspot ? 25 : 8,
        queue_latency_ms: hiddenHotspot ? 52 : 2,
        capacity_mbps: 1000,
        effective_capacity_mbps: 1000,
        utilization_percent: hiddenHotspot ? 92 : 18,
        congestion_percent: hiddenHotspot ? 42 : 1,
        queued_traffic_mb: hiddenHotspot ? 180 : 0,
        dropped_traffic_mb: hiddenHotspot ? 2.5 : 0,
        packet_error_rate: hiddenHotspot ? 0.033 : 0.001,
      });

      const observed = !hiddenHotspot;
      groundLinks.push({
        slice_index: slice,
        link_id: linkId,
        observed,
        observation_source: observed ? "observed" : "unknown",
        last_observed_slice: observed ? slice : "",
        status_estimate: observed ? "up" : "unknown",
        active_estimate: observed ? true : "unknown",
        utilization_percent_estimate: observed ? 18 : "",
        latency_ms_estimate: observed ? 8 : "",
        queue_latency_ms_estimate: observed ? 2 : "",
        capacity_mbps_estimate: observed ? 1000 : "",
        congestion_percent_estimate: observed ? 1 : "",
        queued_traffic_mb_estimate: observed ? 0 : "",
        dropped_traffic_mb_estimate: observed ? 0 : "",
        packet_error_rate_estimate: observed ? 0.001 : "",
        confidence: observed ? 1 : 0,
      });
    }
  }

  const nodeIds = ["P01-S01", "P01-S02", "P02-S01", "P02-S02"];
  const truthNodes = [];
  const groundNodes = [];
  for (const slice of slices) {
    for (const nodeId of nodeIds) {
      truthNodes.push({
        slice_index: slice,
        time: time(slice),
        node_id: nodeId,
        label: nodeId,
        mode: "nominal",
        cpu_percent: 18,
        queue_depth: 1,
        queued_traffic_mb: 0,
        cache_used_mb: 8,
        energy_percent: 86,
        in_sunlight: true,
        solar_exposure: 0.85,
        net_power_w: 100,
      });
      groundNodes.push({
        slice_index: slice,
        node_id: nodeId,
        observed: true,
        observation_source: "observed",
        last_observed_slice: slice,
        mode_estimate: "nominal",
        cpu_percent_estimate: 18,
        queue_depth_estimate: 1,
        queued_traffic_mb_estimate: 0,
        cache_used_mb_estimate: 8,
        energy_percent_estimate: 86,
        confidence: 1,
      });
    }
  }

  await writeCsv(join(truthDir, "links.csv"), truthLinks);
  await writeCsv(join(truthDir, "nodes.csv"), truthNodes);
  await writeCsv(join(truthDir, "routes.csv"), [{
    slice_index: 1,
    task_id: "T-state-tensor-hotspot",
    status: "routed",
    source: "P01-S01",
    target: "P02-S01",
    traffic_mbps: 900,
    priority: 3,
    queue_delay_ms: 140,
    link_ids: targetLink,
  }]);
  await writeCsv(join(groundDir, "ground-reconstructed-links.csv"), groundLinks);
  await writeCsv(join(groundDir, "ground-reconstructed-nodes.csv"), groundNodes);

  return { truthDir, groundDir, targetLink };
}

async function runScenario({ root, stateTensorJointCompletion }) {
  const { truthDir, groundDir, targetLink } = await createFixture(root);
  const outDir = join(root, stateTensorJointCompletion ? "out-state-tensor" : "out-native");
  const args = [
    "--input", truthDir,
    "--ground", groundDir,
    "--out", outDir,
    "--algorithm", "int-mc",
    "--rank", "2",
    "--iterations", "4",
    "--window-size", "2",
    "--link-metrics", "utilization_percent,capacity_mbps,latency_ms,queue_latency_ms,congestion_percent,queued_traffic_mb,dropped_traffic_mb,packet_error_rate",
  ];
  if (stateTensorJointCompletion) args.push("--state-tensor-joint-completion", "true");
  runReconstructor(args);
  return {
    rows: await readCsv(join(outDir, "ground-mc-reconstructed-links.csv")),
    evaluation: JSON.parse(await readFile(join(outDir, "int-mc-evaluation.json"), "utf8")),
    targetLink,
  };
}

const root = resolve("stage2-int/runs/tmp-int-mc-state-tensor-test");
if (!root.includes("tmp-int-mc-state-tensor-test")) {
  throw new Error(`refusing to clean unexpected path: ${root}`);
}
if (existsSync(root)) rmSync(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });

const native = await runScenario({ root: join(root, "native"), stateTensorJointCompletion: false });
const enhanced = await runScenario({ root: join(root, "enhanced"), stateTensorJointCompletion: true });

const nativeTarget = native.rows.find((row) => String(row.slice_index) === "1" && row.link_id === native.targetLink);
const enhancedTarget = enhanced.rows.find((row) => String(row.slice_index) === "1" && row.link_id === enhanced.targetLink);
assert.ok(nativeTarget, "native fixture should reconstruct target link");
assert.ok(enhancedTarget, "enhanced fixture should reconstruct target link");
assert.equal(nativeTarget.observation_source, "inferred", "target link should be inferred in native run");
assert.equal(enhancedTarget.observation_source, "inferred", "target link should be inferred in enhanced run");
assert.notEqual(String(nativeTarget.state_tensor_joint_completion_applied), "true", "native INT-MC should not apply state tensor completion");
assert.equal(String(enhancedTarget.state_tensor_joint_completion_enabled), "true", "state tensor completion should be explicitly enabled");
assert.equal(String(enhancedTarget.state_tensor_joint_completion_applied), "true", "state tensor completion should adjust inconsistent inferred metrics");
assert.ok(String(enhancedTarget.state_tensor_joint_completion_metrics).includes("queue_latency_ms"), "state tensor completion should report adjusted queue latency");
assert.ok(String(enhancedTarget.state_tensor_joint_completion_metrics).includes("congestion_percent"), "state tensor completion should report adjusted congestion");
assert.ok(String(enhancedTarget.state_tensor_joint_completion_metrics).includes("packet_error_rate"), "state tensor completion should report adjusted PER");
assert.ok(String(enhancedTarget.state_tensor_joint_completion_tags).includes("state-tensor-joint-completion"), "state tensor tags should identify the model");
assert.ok(numberValue(enhancedTarget.state_tensor_joint_completion_pressure) >= 0.45, "business load should create strong joint pressure");
assert.ok(numberValue(enhancedTarget.queue_latency_ms_estimate) > numberValue(nativeTarget.queue_latency_ms_estimate) + 20, "joint completion should materially raise queue latency");
assert.ok(numberValue(enhancedTarget.congestion_percent_estimate) > numberValue(nativeTarget.congestion_percent_estimate) + 20, "joint completion should materially raise congestion");
assert.ok(numberValue(enhancedTarget.packet_error_rate_estimate) > numberValue(nativeTarget.packet_error_rate_estimate) + 0.01, "joint completion should materially raise PER");
assert.equal(enhanced.evaluation.parameters.state_tensor_joint_completion_enabled, true, "evaluation should record state tensor completion as enabled");
assert.ok(numberValue(enhanced.evaluation.context_prior_summary.state_tensor_joint_completed_link_samples) >= 1, "evaluation should count state tensor completed samples");

console.log(JSON.stringify({
  ok: true,
  native_queue_latency_ms: numberValue(nativeTarget.queue_latency_ms_estimate),
  enhanced_queue_latency_ms: numberValue(enhancedTarget.queue_latency_ms_estimate),
  enhanced_congestion_percent: numberValue(enhancedTarget.congestion_percent_estimate),
  enhanced_packet_error_rate: numberValue(enhancedTarget.packet_error_rate_estimate),
  state_tensor_pressure: numberValue(enhancedTarget.state_tensor_joint_completion_pressure),
}, null, 2));
