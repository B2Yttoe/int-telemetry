import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { buildFreshWalkerSnapshot } from "./experiments/freshOrbitAcquisition.mjs";
import { generateFreshTopologyWindow } from "./experiments/freshTopologyWindow.mjs";
import {
  applyUserPerformanceCalibration,
  buildServerLocationIndex,
  buildUserPerformanceContexts,
  fitUserPerformanceCalibration,
  loadUserPerformanceTopology,
  scoreUserPerformance,
} from "./experiments/userPerformanceLayer.mjs";
import { readCsvStream } from "../stage2-int/tools/csv-stream.mjs";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (value) => value.slice(1))), "..");
const outputDirectory = resolve(ROOT, "reports/_scratch/experiment14b-user-performance-dry-run");

function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

async function writeCsv(path, rows) {
  await mkdir(dirname(path), { recursive: true });
  const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const content = [headers.join(","), ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(","))].join("\n");
  await writeFile(path, `${content}\n`, "utf8");
}

const protocol = JSON.parse(await readFile(resolve(ROOT, "scripts/experiments/experiment14b-protocol.json"), "utf8"));
const registry = JSON.parse(await readFile(resolve(ROOT, "reports/experiment14-multisource-external-blind-validation/external-source-registry.json"), "utf8"));
const source = registry.find((row) => row.source === "future-standard-gp");
if (!source) throw new Error("Experiment 14 audited standard-GP acquisition is missing");
const gpPath = resolve(ROOT, "reports/experiment14-multisource-external-blind-validation/external/celestrak-starlink-future-gp.json");
const records = JSON.parse(await readFile(gpPath, "utf8"));

const startedAt = Date.now();
const snapshot = await buildFreshWalkerSnapshot(records, {
  sourceUrl: source.url,
  downloadedAt: source.acquired_at,
  planes: protocol.orbit.planes,
  satellitesPerPlane: protocol.orbit.satellites_per_plane,
  raanClusterThresholdDeg: protocol.orbit.raan_cluster_threshold_deg,
});
const window = await generateFreshTopologyWindow(snapshot, {
  epochIso: source.acquired_at,
  slices: 4,
  stepMinutes: protocol.topology_window.step_minutes,
  mode: protocol.topology_window.mode,
  trafficProfile: protocol.topology_window.traffic_profile,
  routingAlgorithm: protocol.topology_window.routing_algorithm,
});
const nodesPath = join(outputDirectory, "nodes.csv");
const linksPath = join(outputDirectory, "links.csv");
await writeCsv(nodesPath, window.nodes);
await writeCsv(linksPath, window.links);
const topology = await loadUserPerformanceTopology(nodesPath, linksPath);

const mlabDirectory = resolve(ROOT, "reports/experiment14b-prospective-external-validation/mlab");
const trainingRows = await readCsvStream(join(mlabDirectory, "training-october-2025.csv"));
const testRows = await readCsvStream(join(mlabDirectory, "blind-test-november-2025-excluding-prior-date.csv"));
const locationIndex = buildServerLocationIndex(trainingRows);
const trainingSample = trainingRows.slice(0, 256);
const testSample = testRows.slice(0, 256);
const trainingContexts = buildUserPerformanceContexts(topology, trainingSample, protocol.user_performance, locationIndex);
const calibration = fitUserPerformanceCalibration(trainingContexts, protocol.user_performance);
const testContexts = buildUserPerformanceContexts(topology, testSample, protocol.user_performance, locationIndex);
const predictions = applyUserPerformanceCalibration(testContexts, calibration);
const score = scoreUserPerformance(predictions);

const result = {
  schema: "int-telemetry-experiment14b-user-performance-dry-run/v1",
  evidence_status: "engineering-dry-run-not-external-evidence",
  generated_at: new Date().toISOString(),
  source_gp_acquired_at: source.acquired_at,
  constellation: {
    planes: protocol.orbit.planes,
    satellites_per_plane: protocol.orbit.satellites_per_plane,
    satellites: snapshot.satellites.length,
  },
  topology: {
    slices: 4,
    node_rows: window.nodes.length,
    link_rows: window.links.length,
  },
  samples: {
    training: trainingSample.length,
    test: testSample.length,
    modeled_training: trainingContexts.filter((row) => row.status === "modeled").length,
    modeled_test: testContexts.filter((row) => row.status === "modeled").length,
  },
  calibration,
  score,
  elapsed_seconds: Math.round((Date.now() - startedAt) / 10) / 100,
  peak_process_rss_mb: Math.round(process.memoryUsage().rss / 1024 / 1024 * 100) / 100,
};
await mkdir(outputDirectory, { recursive: true });
await writeFile(join(outputDirectory, "dry-run-result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
console.log(JSON.stringify(result, null, 2));
