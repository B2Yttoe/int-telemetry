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
    if (char === '"') {
      if (quoted && next === '"') {
        cell += '"';
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

function runSelector(args) {
  const result = spawnSync(process.execPath, ["stage2-int/tools/int-mc-path-selector.mjs", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`selector failed\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  }
}

async function readCsv(path) {
  return parseCsv(await readFile(path, "utf8"));
}

function pathRow(slice, index, path, linkIds) {
  return {
    slice_index: slice,
    time: `2026-06-16T00:${String(slice * 5).padStart(2, "0")}:00.000Z`,
    probe_id: `path-balance-${String(slice).padStart(2, "0")}-${String(index).padStart(3, "0")}`,
    planning_algorithm: "path-balance",
    source: path[0],
    sink: path.at(-1),
    path_node_count: path.length,
    path_link_count: linkIds.length,
    covered_link_count: linkIds.length,
    path: path.join(" > "),
    link_ids: linkIds.join(" > "),
  };
}

async function createFixture(root, options = {}) {
  const truthDir = join(root, "truth");
  const stage2Dir = join(root, "stage2");
  await mkdir(truthDir, { recursive: true });
  await mkdir(stage2Dir, { recursive: true });

  const slices = [0, 1, 2, 3];
  const nodes = [];
  const nodeIds = ["P01-S01", "P01-S02", "P01-S03", "P01-S04", "P02-S01", "P02-S02", "P02-S03", "P02-S04"];
  for (const slice of slices) {
    for (const nodeId of nodeIds) {
      nodes.push({
        slice_index: slice,
        time: `2026-06-16T00:${String(slice * 5).padStart(2, "0")}:00.000Z`,
        node_id: nodeId,
        mode: "nominal",
        cpu_percent: 12,
        queue_depth: 1,
        queued_traffic_mb: 0,
        cache_used_mb: 8,
        energy_percent: 88,
        power_saving_mode: false,
        in_sunlight: true,
        solar_exposure: 0.92,
        net_power_w: 120,
      });
    }
  }

  const linkCatalog = [
    ["intra-plane:P01-S01->P01-S02", "P01-S01", "P01-S02", "intra-plane"],
    ["intra-plane:P01-S02->P01-S03", "P01-S02", "P01-S03", "intra-plane"],
    ["intra-plane:P01-S03->P01-S04", "P01-S03", "P01-S04", "intra-plane"],
    ["intra-plane:P01-S04->P01-S01", "P01-S04", "P01-S01", "intra-plane"],
    ["intra-plane:P02-S01->P02-S02", "P02-S01", "P02-S02", "intra-plane"],
    ["intra-plane:P02-S02->P02-S03", "P02-S02", "P02-S03", "intra-plane"],
    ["intra-plane:P02-S03->P02-S04", "P02-S03", "P02-S04", "intra-plane"],
    ["intra-plane:P02-S04->P02-S01", "P02-S04", "P02-S01", "intra-plane"],
    ["inter-plane:P01-S01->P02-S01", "P01-S01", "P02-S01", "inter-plane"],
    ["inter-plane:P01-S02->P02-S02", "P01-S02", "P02-S02", "inter-plane"],
    ["inter-plane:P01-S03->P02-S03", "P01-S03", "P02-S03", "inter-plane"],
    ["inter-plane:P01-S04->P02-S04", "P01-S04", "P02-S04", "inter-plane"],
  ];
  const links = [];
  for (const slice of slices) {
    for (const [linkId, source, target, kind] of linkCatalog) {
      const congested = options.congestedLink === linkId && slice === 1;
      links.push({
        slice_index: slice,
        time: `2026-06-16T00:${String(slice * 5).padStart(2, "0")}:00.000Z`,
        link_id: linkId,
        source,
        target,
        kind,
        is_active: true,
        status: congested ? "warning" : "up",
        p_available: congested ? 0.82 : 0.97,
        distance_km: kind === "inter-plane" ? 2100 : 1200,
        latency_ms: kind === "inter-plane" ? 15 : 8,
        queue_latency_ms: congested ? 38 : 2 + slice,
        capacity_mbps: 9000,
        effective_capacity_mbps: congested ? 5200 : 9000,
        utilization_percent: congested ? 94 : 22 + slice,
        congestion_percent: congested ? 36 : 0,
        queued_traffic_mb: congested ? 180 : 0,
        dropped_traffic_mb: congested ? 3.5 : 0,
        packet_error_rate: congested ? 0.035 : 0.001,
      });
    }
  }

  const candidatePaths = [];
  const pathDefs = [
    [["P01-S01", "P01-S02", "P01-S03"], ["intra-plane:P01-S01->P01-S02", "intra-plane:P01-S02->P01-S03"]],
    [["P01-S03", "P01-S04", "P01-S01"], ["intra-plane:P01-S03->P01-S04", "intra-plane:P01-S04->P01-S01"]],
    [["P02-S01", "P02-S02", "P02-S03"], ["intra-plane:P02-S01->P02-S02", "intra-plane:P02-S02->P02-S03"]],
    [["P02-S03", "P02-S04", "P02-S01"], ["intra-plane:P02-S03->P02-S04", "intra-plane:P02-S04->P02-S01"]],
    [["P01-S01", "P02-S01", "P02-S02"], ["inter-plane:P01-S01->P02-S01", "intra-plane:P02-S01->P02-S02"]],
    [["P01-S02", "P02-S02", "P02-S03"], ["inter-plane:P01-S02->P02-S02", "intra-plane:P02-S02->P02-S03"]],
  ];
  for (const slice of slices) {
    const slicePathDefs = [...pathDefs];
    if (options.includeOamOnlyPath && slice > 0) {
      slicePathDefs.push([
        ["P01-S04", "P02-S04", "P02-S01"],
        ["inter-plane:P01-S04->P02-S04", "intra-plane:P02-S04->P02-S01"],
      ]);
      if (options.duplicateOamTargetPaths) {
        slicePathDefs.push(
          [
            ["P01-S04", "P02-S04", "P02-S01"],
            ["inter-plane:P01-S04->P02-S04", "intra-plane:P02-S04->P02-S01"],
          ],
          [
            ["P01-S04", "P02-S04", "P02-S01"],
            ["inter-plane:P01-S04->P02-S04", "intra-plane:P02-S04->P02-S01"],
          ],
        );
      }
    }
    if (options.duplicateStablePaths) {
      for (let repeat = 0; repeat < 3; repeat += 1) {
        slicePathDefs.push(...pathDefs.slice(0, 4));
      }
    }
    slicePathDefs.forEach(([path, linkIds], index) => candidatePaths.push(pathRow(slice, index + 1, path, linkIds)));
  }

  await writeCsv(join(truthDir, "nodes.csv"), nodes);
  await writeCsv(join(truthDir, "links.csv"), links);
  await writeCsv(join(truthDir, "routes.csv"), []);
  await writeFile(join(truthDir, "metadata.json"), JSON.stringify({ slice_count: slices.length, node_count: nodeIds.length }, null, 2), "utf8");
  await writeCsv(join(stage2Dir, "probe-paths-path-balance.csv"), candidatePaths);

  return { truthDir, stage2Dir };
}

async function runAdaptiveScenario({ root, controlActions = false, adaptive = true }) {
  const { truthDir, stage2Dir } = await createFixture(root);
  const outputDir = join(root, controlActions ? "out-oam" : "out-reuse");
  const args = [
    "--input", truthDir,
    "--stage2", stage2Dir,
    "--out", outputDir,
    "--algorithm", "int-mc",
    "--candidate-algorithm", "path-balance",
    "--candidate-paths", join(stage2Dir, "probe-paths-path-balance.csv"),
    "--sampling-rate", "0.6",
    "--target-active-link-sampling-rate", "0.6",
    "--warmup-slices", "1",
    "--window-size", "4",
    "--rank", "3",
    "--max-paths-per-slice", "6",
  ];
  if (adaptive) args.push("--adaptive-probe-budget", "true");
  if (controlActions) {
    const controlPath = join(root, "ground-oam-control-actions.csv");
    await writeCsv(controlPath, [{
      slice_index: 1,
      recommended_action: "refresh-probe-plan",
      probe_bias: "force-fresh-replan",
      confidence_budget: "degraded",
      oam_control_pressure: 0.92,
      unknown_pressure: 0.8,
      stale_pressure: 0.1,
      prior_estimate_pressure: 0.5,
      low_confidence_pressure: 0.8,
      conflict_pressure: 0.2,
      downlink_pressure: 0,
      retest_pressure: 0.8,
      coverage_demand_pressure: 0.9,
      priority_retest_targets: 2,
      top_node_targets: "",
      top_link_targets: "intra-plane:P01-S01->P01-S02",
      top_retest_reasons: "unknown-state-pressure",
    }]);
    args.push("--oam-control-actions", controlPath);
  }
  runSelector(args);
  return readCsv(join(outputDir, "probe-summary-int-mc.csv"));
}

async function runLocalRiskScenario({ root, adaptive = true }) {
  const congestedLink = "inter-plane:P01-S01->P02-S01";
  const { truthDir, stage2Dir } = await createFixture(root, { congestedLink });
  const outputDir = join(root, "out-local-risk");
  const args = [
    "--input", truthDir,
    "--stage2", stage2Dir,
    "--out", outputDir,
    "--algorithm", "int-mc",
    "--candidate-algorithm", "path-balance",
    "--candidate-paths", join(stage2Dir, "probe-paths-path-balance.csv"),
    "--sampling-rate", "0.2",
    "--target-active-link-sampling-rate", "0.2",
    "--warmup-slices", "1",
    "--window-size", "4",
    "--rank", "3",
    "--max-paths-per-slice", "2",
    "--topology-versioned-objective", "true",
  ];
  if (adaptive) args.push("--adaptive-probe-budget", "true");
  runSelector(args);
  return {
    rows: await readCsv(join(outputDir, "probe-paths-int-mc.csv")),
    summary: await readCsv(join(outputDir, "probe-summary-int-mc.csv")),
    congestedLink,
  };
}

async function runMandatoryOamCoverageScenario({ root }) {
  const targetLink = "inter-plane:P01-S04->P02-S04";
  const { truthDir, stage2Dir } = await createFixture(root, {
    includeOamOnlyPath: true,
    duplicateOamTargetPaths: true,
  });
  const outputDir = join(root, "out-mandatory-oam");
  const retestPath = join(root, "int-mc-priority-retest.csv");
  await writeCsv(retestPath, [{
    slice_index: 1,
    source_slice_index: 0,
    target_type: "link",
    target_id: targetLink,
    priority_score: 0.96,
    confidence: 0.12,
    completion_error_score: 0.7,
    confidence_pressure: 0.88,
    observation_source: "inferred",
    reason: "low-confidence-and-stale-oam-target",
  }]);
  const args = [
    "--input", truthDir,
    "--stage2", stage2Dir,
    "--out", outputDir,
    "--algorithm", "int-mc",
    "--candidate-algorithm", "path-balance",
    "--candidate-paths", join(stage2Dir, "probe-paths-path-balance.csv"),
    "--oam-priority-retest", retestPath,
    "--sampling-rate", "0.15",
    "--target-active-link-sampling-rate", "0.15",
    "--warmup-slices", "1",
    "--window-size", "4",
    "--rank", "3",
    "--max-paths-per-slice", "3",
    "--adaptive-probe-budget", "true",
    "--oam-target-aware-metadata", "true",
    "--oam-target-hop-bytes", "96",
    "--oam-transit-hop-bytes", "88",
  ];
  runSelector(args);
  return {
    rows: await readCsv(join(outputDir, "probe-paths-int-mc.csv")),
    summary: await readCsv(join(outputDir, "probe-summary-int-mc.csv")),
    targetLink,
  };
}

async function runNextSliceOamControlScenario({ root }) {
  const targetLink = "inter-plane:P01-S04->P02-S04";
  const { truthDir, stage2Dir } = await createFixture(root, { includeOamOnlyPath: true });
  const outputDir = join(root, "out-next-slice-oam");
  const controlPath = join(root, "ground-oam-control-actions-next-slice.csv");
  await writeCsv(controlPath, [{
    slice_index: 0,
    next_slice_index: 1,
    recommended_action: "refresh-probe-plan",
    probe_bias: "force-fresh-replan",
    confidence_budget: "degraded",
    oam_control_pressure: 0.9,
    unknown_pressure: 0.82,
    stale_pressure: 0.1,
    prior_estimate_pressure: 0.2,
    low_confidence_pressure: 0.75,
    conflict_pressure: 0,
    downlink_pressure: 0,
    retest_pressure: 0.85,
    coverage_demand_pressure: 0.9,
    priority_retest_targets: 1,
    top_node_targets: "",
    top_link_targets: targetLink,
    top_retest_reasons: "low-confidence-link-state",
  }]);
  const args = [
    "--input", truthDir,
    "--stage2", stage2Dir,
    "--out", outputDir,
    "--algorithm", "int-mc",
    "--candidate-algorithm", "path-balance",
    "--candidate-paths", join(stage2Dir, "probe-paths-path-balance.csv"),
    "--oam-control-actions", controlPath,
    "--sampling-rate", "0.15",
    "--target-active-link-sampling-rate", "0.15",
    "--warmup-slices", "1",
    "--window-size", "4",
    "--rank", "3",
    "--max-paths-per-slice", "1",
    "--adaptive-probe-budget", "true",
  ];
  runSelector(args);
  return {
    rows: await readCsv(join(outputDir, "probe-paths-int-mc.csv")),
    summary: await readCsv(join(outputDir, "probe-summary-int-mc.csv")),
    targetLink,
  };
}

async function runOamBudgetEscalationScenario({ root }) {
  const { truthDir, stage2Dir } = await createFixture(root);
  const outputDir = join(root, "out-oam-budget-escalation");
  const controlPath = join(root, "ground-oam-control-actions-budget.csv");
  await writeCsv(controlPath, [{
    slice_index: 1,
    recommended_action: "refresh-probe-plan",
    probe_bias: "force-fresh-replan",
    confidence_budget: "degraded",
    oam_control_pressure: 0.95,
    unknown_pressure: 0.86,
    stale_pressure: 0.18,
    prior_estimate_pressure: 0.42,
    low_confidence_pressure: 0.82,
    conflict_pressure: 0.1,
    downlink_pressure: 0,
    retest_pressure: 0.92,
    coverage_demand_pressure: 0.94,
    recommended_sampling_rate: 0.82,
    recommended_target_active_link_sampling_rate: 0.9,
    recommended_telemetry_byte_budget_per_slice: 200000,
    budget_recommendation_action: "increase-critical-probe-budget",
    budget_recommendation_reason: "unknown-state-pressure > low-confidence-pressure > priority-retest-pressure",
    budget_recommendation_source: "test-ground-oam-confidence-control",
    priority_retest_targets: 4,
    top_node_targets: "",
    top_link_targets: "intra-plane:P01-S01->P01-S02 > inter-plane:P01-S01->P02-S01",
    top_retest_reasons: "unknown-link-state > low-confidence-link-state",
  }]);
  const args = [
    "--input", truthDir,
    "--stage2", stage2Dir,
    "--out", outputDir,
    "--algorithm", "int-mc",
    "--candidate-algorithm", "path-balance",
    "--candidate-paths", join(stage2Dir, "probe-paths-path-balance.csv"),
    "--oam-control-actions", controlPath,
    "--sampling-rate", "0.15",
    "--target-active-link-sampling-rate", "0.15",
    "--telemetry-byte-budget-per-slice", "120000",
    "--warmup-slices", "1",
    "--window-size", "4",
    "--rank", "3",
    "--max-paths-per-slice", "1",
    "--adaptive-probe-budget", "true",
  ];
  runSelector(args);
  return {
    rows: await readCsv(join(outputDir, "probe-paths-int-mc.csv")),
    summary: await readCsv(join(outputDir, "probe-summary-int-mc.csv")),
  };
}

async function runModerateOamBudgetScenario({ root }) {
  const { truthDir, stage2Dir } = await createFixture(root);
  const outputDir = join(root, "out-moderate-oam-budget");
  const controlPath = join(root, "ground-oam-control-actions-moderate.csv");
  await writeCsv(controlPath, [{
    slice_index: 1,
    recommended_action: "schedule-priority-retest",
    probe_bias: "bias-paths-to-oam-targets",
    confidence_budget: "watch",
    oam_control_pressure: 0.32,
    unknown_pressure: 0.08,
    stale_pressure: 0.08,
    prior_estimate_pressure: 0.12,
    low_confidence_pressure: 0.18,
    conflict_pressure: 0,
    downlink_pressure: 0,
    retest_pressure: 0.55,
    coverage_demand_pressure: 0.28,
    recommended_sampling_rate: 0.38,
    recommended_target_active_link_sampling_rate: 0.42,
    budget_recommendation_action: "increase-critical-probe-budget",
    budget_recommendation_reason: "priority-retest-pressure",
    budget_recommendation_source: "test-ground-oam-confidence-control",
    priority_retest_targets: 2,
    top_node_targets: "",
    top_link_targets: "intra-plane:P01-S01->P01-S02 > inter-plane:P01-S01->P02-S01",
    top_retest_reasons: "moderate-priority-retest",
  }]);
  const args = [
    "--input", truthDir,
    "--stage2", stage2Dir,
    "--out", outputDir,
    "--algorithm", "int-mc",
    "--candidate-algorithm", "path-balance",
    "--candidate-paths", join(stage2Dir, "probe-paths-path-balance.csv"),
    "--oam-control-actions", controlPath,
    "--sampling-rate", "0.25",
    "--target-active-link-sampling-rate", "0.25",
    "--warmup-slices", "1",
    "--window-size", "4",
    "--rank", "3",
    "--max-paths-per-slice", "3",
    "--adaptive-probe-budget", "true",
  ];
  runSelector(args);
  return {
    rows: await readCsv(join(outputDir, "probe-paths-int-mc.csv")),
    summary: await readCsv(join(outputDir, "probe-summary-int-mc.csv")),
  };
}

async function runDuplicateReuseScenario({ root }) {
  const { truthDir, stage2Dir } = await createFixture(root, { duplicateStablePaths: true });
  const outputDir = join(root, "out-duplicate-reuse");
  const args = [
    "--input", truthDir,
    "--stage2", stage2Dir,
    "--out", outputDir,
    "--algorithm", "int-mc",
    "--candidate-algorithm", "path-balance",
    "--candidate-paths", join(stage2Dir, "probe-paths-path-balance.csv"),
    "--sampling-rate", "0.9",
    "--target-active-link-sampling-rate", "0.3",
    "--warmup-slices", "1",
    "--window-size", "4",
    "--rank", "3",
    "--max-paths-per-slice", "12",
    "--adaptive-probe-budget", "true",
  ];
  runSelector(args);
  return {
    rows: await readCsv(join(outputDir, "probe-paths-int-mc.csv")),
    summary: await readCsv(join(outputDir, "probe-summary-int-mc.csv")),
  };
}

const root = resolve("stage2-int/runs/tmp-int-mc-adaptive-behavior-test");
if (!root.includes("tmp-int-mc-adaptive-behavior-test")) {
  throw new Error(`refusing to clean unexpected path: ${root}`);
}
if (existsSync(root)) rmSync(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });

const reuseRows = await runAdaptiveScenario({ root: join(root, "reuse") });
const reusedRows = reuseRows.filter((row) => row.candidate_source === "topology-reuse-cache");
assert.ok(reusedRows.length > 0, "fixture should produce topology-reuse-cache slices");
assert.ok(
  reusedRows.some((row) => String(row.adaptive_probe_budget_policy).includes("topology-reuse-confidence-throttle")),
  "high-confidence topology reuse should throttle probe communication budget",
);
assert.ok(
  reusedRows.some((row) => numberValue(row.adaptive_probe_budget_scale, 1) < 1),
  "high-confidence topology reuse should reduce effective probe sampling scale",
);
assert.ok(
  reusedRows.some((row) => numberValue(row.adaptive_probe_budget_effective_max_paths_per_slice, NaN) < numberValue(row.configured_max_paths_per_slice, Infinity)),
  "high-confidence topology reuse should reduce the actual per-slice probe path cap, not only the sampling rate",
);
assert.ok(
  reusedRows.every((row) => numberValue(row.selected_paths) <= numberValue(row.adaptive_probe_budget_effective_max_paths_per_slice, Infinity)),
  "selected probe paths should obey the adaptive communication path cap",
);
assert.ok(
  reusedRows.some((row) => numberValue(row.adaptive_metadata_compact_paths) > 0),
  "high-confidence topology reuse should switch selected probes to a compact metadata profile",
);
assert.ok(
  reusedRows.some((row) => numberValue(row.mean_effective_hop_metadata_bytes, 96) < 96),
  "compact metadata profile should reduce per-hop INT metadata bytes",
);
assert.ok(
  reusedRows.some((row) => numberValue(row.mean_metadata_compression_ratio, 1) < 1),
  "compact metadata profile should expose a compression ratio for experiment accounting",
);
assert.ok(
  reusedRows.some((row) => numberValue(row.adaptive_path_only_observation_paths) > 0),
  "compact topology reuse should reduce observation scope to path-only probes",
);

const nativeReuseRows = await runAdaptiveScenario({ root: join(root, "native-reuse"), adaptive: false });
const nativeReusedRows = nativeReuseRows.filter((row) => row.candidate_source === "topology-reuse-cache");
assert.ok(nativeReusedRows.length > 0, "native fixture should also produce topology-reuse-cache slices for comparison");
const adaptiveReuseSelectedPaths = reusedRows.reduce((total, row) => total + numberValue(row.selected_paths), 0);
const nativeReuseSelectedPaths = nativeReusedRows.reduce((total, row) => total + numberValue(row.selected_paths), 0);
const adaptiveReuseTelemetryBytes = reusedRows.reduce((total, row) => total + numberValue(row.estimated_total_telemetry_bytes), 0);
const nativeReuseTelemetryBytes = nativeReusedRows.reduce((total, row) => total + numberValue(row.estimated_total_telemetry_bytes), 0);
assert.ok(
  adaptiveReuseSelectedPaths < nativeReuseSelectedPaths,
  "topology reuse throttling should lower actual selected probe path count versus native INT-MC reuse slices",
);
assert.ok(
  adaptiveReuseTelemetryBytes < nativeReuseTelemetryBytes,
  "topology reuse throttling should lower estimated telemetry communication bytes versus native INT-MC reuse slices",
);

const oamRows = await runAdaptiveScenario({ root: join(root, "oam"), controlActions: true });
const oamSlice = oamRows.find((row) => String(row.slice_index) === "1");
assert.ok(oamSlice, "OAM fixture should include slice 1");
assert.equal(String(oamSlice.candidate_source), "topology-reuse-cache", "high OAM pressure should keep topology reuse when the topology is still similar");
assert.equal(String(oamSlice.oam_control_replan_triggered), "false", "high OAM pressure should not force whole-slice fresh replanning on a reusable topology");
assert.ok(
  String(oamSlice.topology_reuse_decision).includes("reuse"),
  "high OAM pressure should use a local retarget/repair reuse decision instead of a global fresh replan",
);
assert.ok(
  numberValue(oamSlice.planning_cost_saving_ratio) > 0,
  "OAM local retargeting should preserve planning-cost savings from topology reuse",
);
assert.ok(
  String(oamSlice.adaptive_probe_budget_policy).includes("oam-pressure-coverage-escalation"),
  "high OAM pressure should escalate adaptive probe communication budget",
);
assert.ok(
  numberValue(oamSlice.effective_target_active_link_sampling_rate) > numberValue(oamSlice.configured_target_active_link_sampling_rate),
  "OAM pressure should raise the effective active-link sampling target",
);

const localRisk = await runLocalRiskScenario({ root: join(root, "local-risk") });
const localRiskSliceRows = localRisk.rows.filter((row) => String(row.slice_index) === "1");
assert.ok(localRiskSliceRows.length > 0, "local risk fixture should select at least one slice-1 probe path");
assert.ok(
  localRiskSliceRows.some((row) => String(row.link_ids).includes(localRisk.congestedLink)),
  "high-load congested links should be locally prioritized even when global topology reuse is sparse",
);
assert.ok(
  localRiskSliceRows.some((row) => String(row.local_adaptive_sampling_policy).includes("local-risk-priority")),
  "selected high-load paths should explain the local adaptive sampling policy",
);
assert.ok(
  localRiskSliceRows.some((row) => numberValue(row.local_adaptive_sampling_risk) >= 0.6),
  "selected high-load paths should expose a high local adaptive sampling risk score",
);
assert.ok(
  localRiskSliceRows.every((row) => String(row.topology_version_id).includes("@")),
  "selected paths should expose an exact topology version in addition to the reusable topology class",
);
assert.ok(
  localRiskSliceRows.every((row) => String(row.topology_versioned_objective_enabled) === "true"),
  "the unified active-telemetry objective should be auditable on every selected path",
);
assert.ok(
  localRiskSliceRows.every((row) => Number.isFinite(numberValue(row.topology_versioned_objective_value, NaN))),
  "selected paths should export the unified bytes-energy-planning-error-AoI objective",
);
assert.ok(
  localRiskSliceRows.every((row) => Math.abs(numberValue(row.topology_versioned_score_adjustment)) <= 0.12),
  "the conservative gate must bound ranking changes",
);

const nativeLocalRisk = await runLocalRiskScenario({ root: join(root, "native-local-risk"), adaptive: false });
const nativeLocalRiskRows = nativeLocalRisk.rows.filter((row) => String(row.slice_index) === "1");
assert.ok(nativeLocalRiskRows.length > 0, "native local risk fixture should select at least one slice-1 probe path");
assert.ok(
  nativeLocalRiskRows.every((row) => String(row.local_adaptive_sampling_policy) === "disabled"),
  "native INT-MC should keep local adaptive sampling disabled unless the enhanced budget flag is enabled",
);
assert.ok(
  nativeLocalRiskRows.every((row) => numberValue(row.local_adaptive_sampling_risk) === 0),
  "native INT-MC should not expose local adaptive sampling risk scores as active control signals",
);

const mandatoryOam = await runMandatoryOamCoverageScenario({ root: join(root, "mandatory-oam") });
const mandatoryOamRows = mandatoryOam.rows.filter((row) => String(row.slice_index) === "1");
const mandatoryOamSummary = mandatoryOam.summary.find((row) => String(row.slice_index) === "1");
assert.ok(mandatoryOamSummary, "mandatory OAM fixture should include slice-1 summary");
assert.ok(
  mandatoryOamRows.some((row) => String(row.link_ids).includes(mandatoryOam.targetLink)),
  "OAM priority retest target should be covered even when the reused cached plan does not contain it",
);
assert.ok(
  mandatoryOamRows.some((row) => String(row.oam_mandatory_coverage_decision).includes("mandatory-oam-target")),
  "selected OAM target path should explain mandatory OAM coverage decision",
);
const mandatoryTargetRow = mandatoryOamRows.find((row) => String(row.link_ids).includes(mandatoryOam.targetLink));
assert.equal(String(mandatoryTargetRow?.adaptive_metadata_profile), "oam-target-aware", "mandatory OAM path should use target-aware metadata");
assert.equal(String(mandatoryTargetRow?.adaptive_link_observation_mode), "all-adjacent", "high projected observation loss should preserve adjacent scans even with target-aware metadata");
assert.ok(
  numberValue(mandatoryTargetRow?.oam_target_observation_loss_ratio) > 0.1,
  "small active graphs should expose why target-neighborhood pruning is unsafe",
);
assert.equal(numberValue(mandatoryTargetRow?.target_hop_metadata_bytes), 96, "mandatory target records should retain full metadata bytes");
assert.equal(numberValue(mandatoryTargetRow?.transit_hop_metadata_bytes), 88, "mandatory path transit records should use packed metadata bytes");
assert.ok(
  String(mandatoryTargetRow?.oam_feedback_mandatory_link_target_ids).includes(mandatoryOam.targetLink),
  "selector should export the mandatory link target ID separately",
);
assert.ok(
  String(mandatoryOamSummary.oam_mandatory_coverage_broke_reuse).includes("false"),
  "OAM mandatory target should be covered by local delta probes without breaking topology reuse",
);
assert.equal(
  String(mandatoryOamSummary.candidate_source),
  "topology-reuse-cache",
  "mandatory OAM local delta probes should keep the slice on the topology reuse cache path",
);
assert.ok(
  String(mandatoryOamSummary.topology_reuse_decision).includes("reuse"),
  "mandatory OAM local delta probes should preserve the topology reuse decision",
);
assert.ok(
  numberValue(mandatoryOamSummary.oam_mandatory_coverage_selected_paths) >= 1,
  "summary should count OAM mandatory coverage selected paths",
);
assert.equal(
  mandatoryOamRows.filter((row) => String(row.link_ids).includes(mandatoryOam.targetLink)).length,
  1,
  "the same mandatory OAM target path should not be transmitted repeatedly",
);
assert.ok(
  numberValue(mandatoryOamSummary.oam_duplicate_target_only_suppressed_paths) >= 1,
  "summary should count paths suppressed because they only repeat an already-covered OAM target",
);
assert.ok(
  numberValue(mandatoryOamSummary.unique_mandatory_oam_targets_covered) >= 1,
  "summary should expose unique mandatory OAM target coverage",
);

const nextSliceOam = await runNextSliceOamControlScenario({ root: join(root, "next-slice-oam") });
const nextSliceOamRows = nextSliceOam.rows.filter((row) => String(row.slice_index) === "1");
const nextSliceOamSummary = nextSliceOam.summary.find((row) => String(row.slice_index) === "1");
assert.ok(nextSliceOamSummary, "next-slice OAM fixture should include slice-1 summary");
assert.equal(String(nextSliceOamSummary.oam_control_replan_triggered), "false", "Ground OAM action from slice 0 should locally retarget next slice 1 without whole-slice replanning");
assert.equal(String(nextSliceOamSummary.candidate_source), "topology-reuse-cache", "next-slice Ground OAM action should preserve topology reuse when the topology is still reusable");
assert.equal(String(nextSliceOamSummary.oam_control_source_slice_index), "0", "next-slice OAM summary should expose the source slice that generated the action");
assert.equal(String(nextSliceOamSummary.oam_control_target_slice_index), "1", "next-slice OAM summary should expose the controlled target slice");
assert.equal(String(nextSliceOamSummary.oam_control_next_slice_applied), "true", "next-slice OAM control should be explicitly auditable");
assert.ok(
  nextSliceOamRows.some((row) => String(row.link_ids).includes(nextSliceOam.targetLink)),
  "next-slice Ground OAM action should force coverage of the low-confidence target in the next slice",
);
assert.ok(
  numberValue(nextSliceOamSummary.oam_control_selected_paths) >= 1,
  "next-slice Ground OAM action should be counted as selected OAM control paths",
);

const moderateOamBudget = await runModerateOamBudgetScenario({ root: join(root, "moderate-oam-budget") });
const moderateOamBudgetSummary = moderateOamBudget.summary.find((row) => String(row.slice_index) === "1");
assert.ok(moderateOamBudgetSummary, "moderate OAM fixture should include slice-1 summary");
assert.ok(
  numberValue(moderateOamBudgetSummary.oam_control_selected_paths) >= 1,
  "moderate OAM retest should still bias selection toward OAM targets",
);
const moderateSliceRows = moderateOamBudget.rows.filter((row) => String(row.slice_index) === "1");
assert.ok(
  moderateSliceRows.some((row) => numberValue(row.oam_control_targets) > 0),
  "moderate OAM retest should select at least one path that actually hits an OAM target",
);
assert.ok(
  moderateSliceRows
    .filter((row) => numberValue(row.oam_control_targets) === 0)
    .every((row) => numberValue(row.oam_control_score) < 0.25),
  "paths that miss OAM targets must not receive a broad OAM action/bias score",
);
assert.ok(
  numberValue(moderateOamBudgetSummary.adaptive_probe_budget_effective_max_paths_per_slice) <=
    numberValue(moderateOamBudgetSummary.configured_max_paths_per_slice),
  "moderate OAM retest pressure must not raise the effective path cap above the native cap",
);
assert.ok(
  numberValue(moderateOamBudgetSummary.selected_paths) <= numberValue(moderateOamBudgetSummary.configured_max_paths_per_slice),
  "moderate OAM retest pressure should not increase actual probe path count above native INT-MC",
);

const oamBudgetEscalation = await runOamBudgetEscalationScenario({ root: join(root, "oam-budget-escalation") });
const oamBudgetEscalationSummary = oamBudgetEscalation.summary.find((row) => String(row.slice_index) === "1");
assert.ok(oamBudgetEscalationSummary, "OAM budget escalation fixture should include slice-1 summary");
assert.equal(String(oamBudgetEscalationSummary.oam_budget_applied), "true", "Ground OAM budget recommendation should be applied");
assert.ok(
  numberValue(oamBudgetEscalationSummary.oam_recommended_sampling_rate) >= 0.8,
  "summary should expose the high Ground OAM sampling recommendation",
);
assert.ok(
  numberValue(oamBudgetEscalationSummary.adaptive_probe_budget_effective_max_paths_per_slice) >
    numberValue(oamBudgetEscalationSummary.configured_max_paths_per_slice),
  "high OAM pressure should temporarily raise the effective probe path cap above the configured native cap",
);
assert.ok(
  numberValue(oamBudgetEscalationSummary.selected_paths) > numberValue(oamBudgetEscalationSummary.configured_max_paths_per_slice),
  "high OAM pressure should translate into more actual selected probe paths, not only summary metadata",
);

const duplicateReuse = await runDuplicateReuseScenario({ root: join(root, "duplicate-reuse") });
const duplicateReuseRows = duplicateReuse.rows.filter((row) => row.candidate_source === "topology-reuse-cache");
const duplicateReuseSummaryRows = duplicateReuse.summary.filter((row) => row.candidate_source === "topology-reuse-cache");
assert.ok(duplicateReuseRows.length > 0, "duplicate fixture should produce topology-reuse-cache probe rows");
assert.ok(
  duplicateReuseRows.every((row) => numberValue(row.marginal_new_link_count) > 0 || numberValue(row.local_adaptive_sampling_risk) >= 0.6 || numberValue(row.oam_feedback_targets) > 0 || numberValue(row.oam_control_targets) > 0),
  "stable topology reuse should suppress duplicate low-risk probes that add no new link coverage",
);
assert.ok(
  duplicateReuseSummaryRows.some((row) => numberValue(row.reuse_duplicate_suppressed_paths) > 0),
  "summary should count duplicate reuse probes suppressed from telemetry communication",
);

console.log(JSON.stringify({
  ok: true,
  reuse_rows: reuseRows.length,
  reused_slices: reusedRows.length,
  oam_slice_selected_paths: numberValue(oamSlice.selected_paths),
  next_slice_oam_selected_paths: numberValue(nextSliceOamSummary.oam_control_selected_paths),
  oam_budget_escalation_selected_paths: numberValue(oamBudgetEscalationSummary.selected_paths),
  local_risk_slice_paths: localRiskSliceRows.length,
  mandatory_oam_selected_paths: numberValue(mandatoryOamSummary.oam_mandatory_coverage_selected_paths),
  duplicate_reuse_suppressed_paths: duplicateReuseSummaryRows.reduce((total, row) => total + numberValue(row.reuse_duplicate_suppressed_paths), 0),
}, null, 2));
