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
    ["intra-plane:P01-S01->P01-S02", "P01-S01", "P01-S02", "intra-plane"],
    ["intra-plane:P02-S01->P02-S02", "P02-S01", "P02-S02", "intra-plane"],
  ];
  const truthLinks = [];
  const groundLinks = [];
  for (const slice of slices) {
    for (const [linkId, source, target, kind] of linkCatalog) {
      const hotspot = slice === 1 && linkId === targetLink;
      truthLinks.push({
        slice_index: slice,
        time: time(slice),
        link_id: linkId,
        source,
        target,
        kind,
        status: hotspot ? "warning" : "up",
        is_active: true,
        p_available: hotspot ? 0.82 : 0.98,
        distance_km: kind === "inter-plane" ? 1500 : 900,
        latency_ms: hotspot ? 24 : 8,
        queue_latency_ms: hotspot ? 44 : 1,
        capacity_mbps: 1000,
        effective_capacity_mbps: 1000,
        utilization_percent: hotspot ? 96 : 18,
        congestion_percent: hotspot ? 48 : 0,
        queued_traffic_mb: hotspot ? 230 : 0,
        dropped_traffic_mb: hotspot ? 4 : 0,
        packet_error_rate: hotspot ? 0.04 : 0.001,
      });
      const observed = !hotspot;
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
        queue_latency_ms_estimate: observed && slice === 0 && linkId === targetLink ? 200000 : observed ? 1 : "",
        capacity_mbps_estimate: observed ? 1000 : "",
        congestion_percent_estimate: observed ? 0 : "",
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
        cpu_percent: 20,
        queue_depth: 2,
        queued_traffic_mb: 0,
        cache_used_mb: 10,
        energy_percent: 82,
        in_sunlight: true,
        solar_exposure: 0.8,
        net_power_w: 90,
      });
      groundNodes.push({
        slice_index: slice,
        node_id: nodeId,
        observed: true,
        observation_source: "observed",
        last_observed_slice: slice,
        mode_estimate: "nominal",
        cpu_percent_estimate: 20,
        queue_depth_estimate: 2,
        queued_traffic_mb_estimate: 0,
        cache_used_mb_estimate: 10,
        energy_percent_estimate: 82,
        confidence: 1,
      });
    }
  }

  await writeCsv(join(truthDir, "links.csv"), truthLinks);
  await writeCsv(join(truthDir, "nodes.csv"), truthNodes);
  await writeCsv(join(truthDir, "routes.csv"), [{
    slice_index: 1,
    task_id: "T-hotspot",
    status: "routed",
    source: "P01-S01",
    target: "P02-S01",
    traffic_mbps: 1450,
    priority: 3,
    queue_delay_ms: 50000,
    link_ids: targetLink,
  }]);
  await writeCsv(join(groundDir, "ground-reconstructed-links.csv"), groundLinks);
  await writeCsv(join(groundDir, "ground-reconstructed-nodes.csv"), groundNodes);

  return { truthDir, groundDir, targetLink };
}

async function runScenario({ root, metricTensorCoupling }) {
  const { truthDir, groundDir, targetLink } = await createFixture(root);
  const outDir = join(root, metricTensorCoupling ? "out-tensor" : "out-native");
  const args = [
    "--input", truthDir,
    "--ground", groundDir,
    "--out", outDir,
    "--algorithm", "int-mc",
    "--rank", "2",
    "--iterations", "4",
    "--window-size", "2",
  ];
  if (metricTensorCoupling) args.push("--metric-tensor-coupling", "true");
  runReconstructor(args);
  return {
    rows: await readCsv(join(outDir, "ground-mc-reconstructed-links.csv")),
    evaluation: JSON.parse(await readFile(join(outDir, "int-mc-evaluation.json"), "utf8")),
    targetLink,
  };
}

const root = resolve("stage2-int/runs/tmp-int-mc-metric-tensor-test");
if (!root.includes("tmp-int-mc-metric-tensor-test")) {
  throw new Error(`refusing to clean unexpected path: ${root}`);
}
if (existsSync(root)) rmSync(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });

const tensor = await runScenario({ root: join(root, "tensor"), metricTensorCoupling: true });
const tensorTarget = tensor.rows.find((row) => String(row.slice_index) === "1" && row.link_id === tensor.targetLink);
assert.ok(tensorTarget, "tensor fixture should reconstruct target hotspot link");
assert.equal(tensorTarget.observation_source, "inferred", "target hotspot link should be inferred rather than directly observed");
assert.equal(String(tensorTarget.metric_tensor_coupling_enabled), "true", "metric tensor coupling should be enabled in enhanced run");
assert.equal(String(tensorTarget.metric_tensor_coupling_applied), "true", "metric tensor coupling should adjust inconsistent inferred link-time metrics");
assert.ok(String(tensorTarget.metric_tensor_coupled_metrics).includes("queue_latency_ms"), "tensor coupling should report adjusted queue latency");
assert.ok(String(tensorTarget.metric_tensor_coupled_metrics).includes("packet_error_rate"), "tensor coupling should report adjusted packet error rate");
assert.ok(String(tensorTarget.metric_tensor_coupling_tags).includes("link-time-metric-tensor"), "tensor tags should identify the coupling model");
assert.ok(numberValue(tensorTarget.metric_tensor_coupling_pressure) >= 0.45, "high load should produce tensor coupling pressure");
assert.ok(numberValue(tensorTarget.queue_latency_ms_estimate) >= 20, "tensor coupling should raise queue latency under high pressure");
assert.ok(numberValue(tensorTarget.queue_latency_ms_estimate) <= 2500, "tensor coupling should cap implausible queue latency outliers");
assert.ok(numberValue(tensorTarget.congestion_percent_estimate) >= 20, "tensor coupling should raise congestion under high pressure");
assert.ok(numberValue(tensorTarget.packet_error_rate_estimate) >= 0.02, "tensor coupling should raise PER under high pressure");
assert.equal(tensor.evaluation.parameters.metric_tensor_coupling_enabled, true, "evaluation should record tensor coupling as enabled");
assert.ok(numberValue(tensor.evaluation.context_prior_summary.metric_tensor_coupled_link_samples) >= 1, "evaluation should count tensor-coupled link samples");

const native = await runScenario({ root: join(root, "native"), metricTensorCoupling: false });
const nativeTarget = native.rows.find((row) => String(row.slice_index) === "1" && row.link_id === native.targetLink);
assert.ok(nativeTarget, "native fixture should reconstruct target hotspot link");
assert.notEqual(String(nativeTarget.metric_tensor_coupling_applied), "true", "native INT-MC should not apply tensor coupling by default");
assert.equal(native.evaluation.parameters.metric_tensor_coupling_enabled, false, "evaluation should record tensor coupling as disabled by default");

console.log(JSON.stringify({
  ok: true,
  tensor_pressure: numberValue(tensorTarget.metric_tensor_coupling_pressure),
  tensor_metrics: tensorTarget.metric_tensor_coupled_metrics,
  tensor_queue_latency_ms: numberValue(tensorTarget.queue_latency_ms_estimate),
  tensor_packet_error_rate: numberValue(tensorTarget.packet_error_rate_estimate),
}, null, 2));
