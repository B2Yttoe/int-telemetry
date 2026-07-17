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

  const targetLink = "inter-plane:P01-S02->P02-S02";
  const links = [
    ["inter-plane:P01-S01->P02-S01", "P01-S01", "P02-S01", "inter-plane"],
    [targetLink, "P01-S02", "P02-S02", "inter-plane"],
    ["inter-plane:P01-S03->P02-S03", "P01-S03", "P02-S03", "inter-plane"],
    ["inter-plane:P02-S02->P03-S02", "P02-S02", "P03-S02", "inter-plane"],
  ];
  const truthLinks = [];
  const groundLinks = [];
  for (const slice of [0, 1]) {
    for (const [linkId, source, target, kind] of links) {
      const targetMissing = slice === 1 && linkId === targetLink;
      const temporalOutlier = slice === 0 && linkId === targetLink;
      truthLinks.push({
        slice_index: slice,
        time: `2026-06-16T00:${String(slice * 5).padStart(2, "0")}:00.000Z`,
        link_id: linkId,
        source,
        target,
        kind,
        status: "up",
        is_active: true,
        p_available: 0.98,
        distance_km: 1400,
        latency_ms: 8,
        queue_latency_ms: 1,
        capacity_mbps: 1000,
        effective_capacity_mbps: 1000,
        utilization_percent: 22,
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
        utilization_percent_estimate: targetMissing ? "" : temporalOutlier ? 96 : 22,
        latency_ms_estimate: targetMissing ? "" : 8,
        queue_latency_ms_estimate: targetMissing ? "" : temporalOutlier ? 80 : 1,
        capacity_mbps_estimate: targetMissing ? "" : 1000,
        congestion_percent_estimate: targetMissing ? "" : temporalOutlier ? 40 : 0,
        queued_traffic_mb_estimate: targetMissing ? "" : 0,
        dropped_traffic_mb_estimate: targetMissing ? "" : 0,
        packet_error_rate_estimate: targetMissing ? "" : temporalOutlier ? 0.03 : 0.001,
        confidence: targetMissing ? 0 : 1,
      });
    }
  }

  const nodeIds = ["P01-S01", "P01-S02", "P01-S03", "P02-S01", "P02-S02", "P02-S03", "P03-S02"];
  const truthNodes = [];
  const groundNodes = [];
  for (const slice of [0, 1]) {
    for (const nodeId of nodeIds) {
      truthNodes.push({
        slice_index: slice,
        time: `2026-06-16T00:${String(slice * 5).padStart(2, "0")}:00.000Z`,
        node_id: nodeId,
        label: nodeId,
        mode: "nominal",
        cpu_percent: 18,
        queue_depth: 1,
        queued_traffic_mb: 0,
        cache_used_mb: 8,
        energy_percent: 86,
        in_sunlight: true,
        solar_exposure: 0.9,
        net_power_w: 110,
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
  await writeCsv(join(truthDir, "routes.csv"), []);
  await writeCsv(join(groundDir, "ground-reconstructed-links.csv"), groundLinks);
  await writeCsv(join(groundDir, "ground-reconstructed-nodes.csv"), groundNodes);
  return { truthDir, groundDir, targetLink };
}

async function runScenario({ root, regularization }) {
  const { truthDir, groundDir, targetLink } = await createFixture(root);
  const outDir = join(root, regularization ? "out-regularized" : "out-native");
  const args = [
    "--input", truthDir,
    "--ground", groundDir,
    "--out", outDir,
    "--algorithm", "int-mc",
    "--rank", "2",
    "--iterations", "4",
    "--window-size", "2",
  ];
  if (regularization) args.push("--orbit-graph-regularization", "true");
  runReconstructor(args);
  return {
    rows: await readCsv(join(outDir, "ground-mc-reconstructed-links.csv")),
    evaluation: JSON.parse(await readFile(join(outDir, "int-mc-evaluation.json"), "utf8")),
    targetLink,
  };
}

const root = resolve("stage2-int/runs/tmp-int-mc-orbit-regularization-test");
if (!root.includes("tmp-int-mc-orbit-regularization-test")) {
  throw new Error(`refusing to clean unexpected path: ${root}`);
}
if (existsSync(root)) rmSync(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });

const native = await runScenario({ root: join(root, "native"), regularization: false });
const regularized = await runScenario({ root: join(root, "regularized"), regularization: true });
const nativeTarget = native.rows.find((row) => String(row.slice_index) === "1" && row.link_id === native.targetLink);
const regularizedTarget = regularized.rows.find((row) => String(row.slice_index) === "1" && row.link_id === regularized.targetLink);

assert.ok(nativeTarget, "native fixture should reconstruct target link");
assert.ok(regularizedTarget, "regularized fixture should reconstruct target link");
assert.equal(nativeTarget.observation_source, "inferred", "target link should be inferred");
assert.equal(regularizedTarget.observation_source, "inferred", "regularized target link should still be inferred");
assert.equal(String(nativeTarget.orbit_graph_regularization_applied), "false", "native INT-MC should keep orbit graph regularization disabled");
assert.equal(String(regularizedTarget.orbit_graph_regularization_applied), "true", "enhanced run should apply orbit graph regularization");
assert.ok(String(regularizedTarget.orbit_graph_regularized_metrics).includes("utilization_percent"), "regularization should report utilization adjustment");
assert.ok(
  numberValue(regularizedTarget.utilization_percent_estimate) < numberValue(nativeTarget.utilization_percent_estimate),
  "orbit graph regularization should pull the inferred utilization toward same-slice plane-slot neighbors",
);
assert.ok(numberValue(regularizedTarget.orbit_graph_regularization_neighbor_count) >= 2, "regularization should use multiple plane-slot neighbors");
assert.equal(regularized.evaluation.parameters.orbit_graph_regularization_enabled, true, "evaluation should record regularization as enabled");
assert.ok(numberValue(regularized.evaluation.context_prior_summary.orbit_graph_regularized_link_samples) >= 1, "evaluation should count regularized samples");

console.log(JSON.stringify({
  ok: true,
  native_utilization: numberValue(nativeTarget.utilization_percent_estimate),
  regularized_utilization: numberValue(regularizedTarget.utilization_percent_estimate),
  regularized_metrics: regularizedTarget.orbit_graph_regularized_metrics,
}, null, 2));
