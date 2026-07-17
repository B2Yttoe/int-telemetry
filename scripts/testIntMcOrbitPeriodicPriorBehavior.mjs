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

  const slices = [0, 1, 2, 3, 4];
  const targetLink = "inter-plane:P01-S01->P02-S01";
  const otherLinks = [
    ["intra-plane:P01-S01->P01-S02", "P01-S01", "P01-S02", "intra-plane"],
    ["intra-plane:P02-S01->P02-S02", "P02-S01", "P02-S02", "intra-plane"],
    ["inter-plane:P01-S02->P02-S02", "P01-S02", "P02-S02", "inter-plane"],
  ];
  const linkCatalog = [[targetLink, "P01-S01", "P02-S01", "inter-plane"], ...otherLinks];
  const truthLinks = [];
  const groundLinks = [];
  for (const slice of slices) {
    for (const [linkId, source, target, kind] of linkCatalog) {
      const isTargetLink = linkId === targetLink;
      const periodicObservation = isTargetLink && (slice === 0 || slice === 4);
      const targetMissing = isTargetLink && slice > 0 && slice < 4;
      const lowObserved = !targetMissing && !periodicObservation;
      const utilization = periodicObservation || targetMissing ? 88 : 12;
      truthLinks.push({
        slice_index: slice,
        time: `2026-06-16T00:${String(slice * 5).padStart(2, "0")}:00.000Z`,
        link_id: linkId,
        source,
        target,
        kind,
        status: utilization >= 70 ? "warning" : "up",
        is_active: true,
        p_available: 0.97,
        distance_km: kind === "inter-plane" ? 1500 : 900,
        latency_ms: 8,
        queue_latency_ms: utilization >= 70 ? 18 : 1,
        capacity_mbps: 1000,
        effective_capacity_mbps: 1000,
        utilization_percent: utilization,
        congestion_percent: utilization >= 70 ? 18 : 0,
        queued_traffic_mb: utilization >= 70 ? 90 : 0,
        dropped_traffic_mb: 0,
        packet_error_rate: utilization >= 70 ? 0.01 : 0.001,
      });
      groundLinks.push({
        slice_index: slice,
        link_id: linkId,
        observed: !targetMissing,
        observation_source: targetMissing ? "unknown" : "observed",
        last_observed_slice: targetMissing ? "" : slice,
        status_estimate: targetMissing ? "unknown" : utilization >= 70 ? "warning" : "up",
        active_estimate: targetMissing ? "unknown" : true,
        utilization_percent_estimate: targetMissing ? "" : utilization,
        latency_ms_estimate: targetMissing ? "" : 8,
        queue_latency_ms_estimate: targetMissing ? "" : utilization >= 70 ? 18 : 1,
        capacity_mbps_estimate: targetMissing ? "" : 1000,
        congestion_percent_estimate: targetMissing ? "" : utilization >= 70 ? 18 : 0,
        queued_traffic_mb_estimate: targetMissing ? "" : utilization >= 70 ? 90 : 0,
        dropped_traffic_mb_estimate: targetMissing ? "" : 0,
        packet_error_rate_estimate: targetMissing ? "" : utilization >= 70 ? 0.01 : 0.001,
        confidence: targetMissing ? 0 : 1,
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
        time: `2026-06-16T00:${String(slice * 5).padStart(2, "0")}:00.000Z`,
        node_id: nodeId,
        label: nodeId,
        mode: "nominal",
        cpu_percent: 20,
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
        cpu_percent_estimate: 20,
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

async function runScenario({ root, periodicPrior }) {
  const { truthDir, groundDir, targetLink } = await createFixture(root);
  const outDir = join(root, periodicPrior ? "out-periodic" : "out-native");
  const args = [
    "--input", truthDir,
    "--ground", groundDir,
    "--out", outDir,
    "--algorithm", "int-mc",
    "--rank", "1",
    "--iterations", "1",
    "--window-size", "1",
    "--link-metrics", "utilization_percent",
    "--node-metrics", "none",
  ];
  if (periodicPrior) args.push("--orbit-periodic-prior", "true", "--orbit-periodic-prior-slices", "2");
  runReconstructor(args);
  return {
    rows: await readCsv(join(outDir, "ground-mc-reconstructed-links.csv")),
    summaryRows: await readCsv(join(outDir, "int-mc-matrix-summary.csv")),
    evaluation: JSON.parse(await readFile(join(outDir, "int-mc-evaluation.json"), "utf8")),
    targetLink,
  };
}

const root = resolve("stage2-int/runs/tmp-int-mc-orbit-periodic-prior-test");
if (!root.includes("tmp-int-mc-orbit-periodic-prior-test")) {
  throw new Error(`refusing to clean unexpected path: ${root}`);
}
if (existsSync(root)) rmSync(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });

const native = await runScenario({ root: join(root, "native"), periodicPrior: false });
const periodic = await runScenario({ root: join(root, "periodic"), periodicPrior: true });

const nativeTarget = native.rows.find((row) => String(row.slice_index) === "2" && row.link_id === native.targetLink);
const periodicTarget = periodic.rows.find((row) => String(row.slice_index) === "2" && row.link_id === periodic.targetLink);
const periodicSummary = periodic.summaryRows.find((row) => row.metric === "utilization_percent");

assert.ok(nativeTarget, "native fixture should reconstruct the missing target link");
assert.ok(periodicTarget, "periodic fixture should reconstruct the missing target link");
assert.equal(nativeTarget.observation_source, "inferred", "target link should be inferred");
assert.equal(periodicTarget.observation_source, "inferred", "periodic target link should remain inferred");
assert.equal(periodic.evaluation.parameters.orbit_periodic_prior_enabled, true, "evaluation should record orbit periodic prior as enabled");
assert.equal(periodic.evaluation.parameters.orbit_periodic_prior_slices, 2, "evaluation should record the configured periodic lag");
assert.ok(numberValue(periodicSummary?.orbit_periodic_prior_values) >= 1, "matrix summary should count periodic prior uses");
assert.ok(
  String(periodicTarget.completion_prior_stack).includes("orbit-periodic"),
  "completion stack should expose that orbital periodicity can seed missing cells",
);
assert.ok(
  numberValue(periodicTarget.utilization_percent_estimate) > numberValue(nativeTarget.utilization_percent_estimate) + 20,
  "periodic prior should recover same-link periodic high-utilization observations better than native local smoothing",
);

console.log(JSON.stringify({
  ok: true,
  native_utilization: numberValue(nativeTarget.utilization_percent_estimate),
  periodic_utilization: numberValue(periodicTarget.utilization_percent_estimate),
  orbit_periodic_prior_values: numberValue(periodicSummary?.orbit_periodic_prior_values),
}, null, 2));
