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

  const slices = [0, 1];
  const targetLink = "inter-plane:P01-S01->P02-S01";
  const truthLinks = [];
  const groundLinks = [];
  const truthNodes = [];
  const groundNodes = [];
  for (const slice of slices) {
    truthLinks.push({
      slice_index: slice,
      time: `2026-06-16T00:${String(slice * 5).padStart(2, "0")}:00.000Z`,
      link_id: targetLink,
      source: "P01-S01",
      target: "P02-S01",
      kind: "inter-plane",
      status: "up",
      is_active: true,
      p_available: 0.95,
      distance_km: 1500,
      latency_ms: 8,
      queue_latency_ms: 1,
      capacity_mbps: 1000,
      effective_capacity_mbps: 1000,
      utilization_percent: 32,
      congestion_percent: 0,
      queued_traffic_mb: 0,
      dropped_traffic_mb: 0,
      packet_error_rate: 0.001,
    });
    groundLinks.push({
      slice_index: slice,
      link_id: targetLink,
      observed: true,
      observation_source: "observed",
      last_observed_slice: slice,
      status_estimate: "up",
      active_estimate: true,
      utilization_percent_estimate: 32,
      latency_ms_estimate: 8,
      queue_latency_ms_estimate: 1,
      capacity_mbps_estimate: 1000,
      congestion_percent_estimate: 0,
      queued_traffic_mb_estimate: 0,
      dropped_traffic_mb_estimate: 0,
      packet_error_rate_estimate: 0.001,
      confidence: slice === 0 ? 0.42 : 1,
      confidence_state: slice === 0 ? "low" : "high",
      conflict_ratio: slice === 0 ? 0.62 : 0,
      conflict_severity: slice === 0 ? 0.62 : 0,
      fusion_confidence_penalty: slice === 0 ? 0.34 : 0,
    });

    for (const nodeId of ["P01-S01", "P02-S01"]) {
      const lowQualityNode = slice === 0 && nodeId === "P01-S01";
      truthNodes.push({
        slice_index: slice,
        time: `2026-06-16T00:${String(slice * 5).padStart(2, "0")}:00.000Z`,
        node_id: nodeId,
        label: nodeId,
        mode: "nominal",
        cpu_percent: 28,
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
        cpu_percent_estimate: 28,
        queue_depth_estimate: 2,
        queued_traffic_mb_estimate: 0,
        cache_used_mb_estimate: 10,
        energy_percent_estimate: 82,
        confidence: lowQualityNode ? 0.38 : 1,
        confidence_state: lowQualityNode ? "low" : "high",
        conflict_ratio: lowQualityNode ? 0.7 : 0,
        conflict_severity: lowQualityNode ? 0.7 : 0,
        fusion_confidence_penalty: lowQualityNode ? 0.38 : 0,
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

async function runScenario({ root, oamQualityFeedback }) {
  const { truthDir, groundDir, targetLink } = await createFixture(root);
  const outDir = join(root, oamQualityFeedback ? "out-quality" : "out-native");
  const args = [
    "--input", truthDir,
    "--ground", groundDir,
    "--out", outDir,
    "--algorithm", "int-mc",
    "--rank", "1",
    "--iterations", "1",
    "--window-size", "1",
    "--link-metrics", "utilization_percent",
    "--node-metrics", "cpu_percent",
  ];
  if (oamQualityFeedback) args.push("--oam-quality-feedback", "true");
  runReconstructor(args);
  return {
    links: await readCsv(join(outDir, "ground-mc-reconstructed-links.csv")),
    nodes: await readCsv(join(outDir, "ground-mc-reconstructed-nodes.csv")),
    retests: await readCsv(join(outDir, "int-mc-priority-retest.csv")),
    evaluation: JSON.parse(await readFile(join(outDir, "int-mc-evaluation.json"), "utf8")),
    targetLink,
  };
}

const root = resolve("stage2-int/runs/tmp-int-mc-oam-quality-feedback-test");
if (!root.includes("tmp-int-mc-oam-quality-feedback-test")) {
  throw new Error(`refusing to clean unexpected path: ${root}`);
}
if (existsSync(root)) rmSync(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });

const native = await runScenario({ root: join(root, "native"), oamQualityFeedback: false });
const quality = await runScenario({ root: join(root, "quality"), oamQualityFeedback: true });

const nativeLink = native.links.find((row) => String(row.slice_index) === "0" && row.link_id === native.targetLink);
const qualityLink = quality.links.find((row) => String(row.slice_index) === "0" && row.link_id === quality.targetLink);
const qualityNode = quality.nodes.find((row) => String(row.slice_index) === "0" && row.node_id === "P01-S01");
const linkRetest = quality.retests.find((row) => row.target_type === "link" && row.target_id === quality.targetLink);
const nodeRetest = quality.retests.find((row) => row.target_type === "node" && row.target_id === "P01-S01");

assert.ok(nativeLink, "native run should reconstruct the direct observed link");
assert.ok(qualityLink, "quality-aware run should reconstruct the direct observed link");
assert.equal(nativeLink.observation_source, "observed", "fixture link must be directly observed");
assert.equal(numberValue(nativeLink.confidence), 1, "native INT-MC keeps direct observations at full confidence");
assert.equal(quality.evaluation.parameters.oam_quality_feedback_enabled, true, "evaluation should record quality feedback as enabled");
assert.ok(numberValue(qualityLink.confidence) < 0.5, "quality feedback should lower direct observed link confidence");
assert.equal(String(qualityLink.oam_quality_feedback_applied), "true", "link row should mark quality feedback as applied");
assert.ok(numberValue(qualityNode.confidence) < 0.5, "quality feedback should lower direct observed node confidence");
assert.ok(linkRetest, "low-quality observed link should become a next-round retest target");
assert.ok(nodeRetest, "low-quality observed node should become a next-round retest target");
assert.ok(String(linkRetest.reason).includes("low-oam-observation-confidence"), "link retest reason should expose OAM quality pressure");
assert.ok(numberValue(quality.evaluation.context_prior_summary.oam_quality_feedback_low_confidence_observed_links) >= 1, "evaluation should count low-quality observed links");
assert.ok(numberValue(quality.evaluation.context_prior_summary.oam_quality_feedback_low_confidence_observed_nodes) >= 1, "evaluation should count low-quality observed nodes");

console.log(JSON.stringify({
  ok: true,
  native_confidence: numberValue(nativeLink.confidence),
  quality_link_confidence: numberValue(qualityLink.confidence),
  quality_node_confidence: numberValue(qualityNode.confidence),
  retest_targets: quality.retests.length,
}, null, 2));
