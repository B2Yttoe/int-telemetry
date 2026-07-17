import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { readCsvStream } from "../stage2-int/tools/csv-stream.mjs";
import { rowsToCsv } from "./experiments/reportUtils.mjs";
import { writeSystemValidationReport } from "./experiments/systemValidationReport.mjs";
import {
  SYSTEM_VALIDATION_CONFIG,
  boolValue,
  calibrateBusinessRates,
  comparePacketResults,
  normalizeMetadataBytes,
  numberValue,
  repairPathAgainstLinks,
  round,
  runPacketReference,
  splitPath,
  validatePathAgainstLinks,
} from "./experiments/systemPacketValidation.mjs";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_FIXTURE_DIR = join(PROJECT_ROOT, "stage3-system-validation", "fixtures", "iridium-66-20slice");
const DEFAULT_OUTPUT_DIR = join(PROJECT_ROOT, "reports", "experiment13-system-validation");
const NATIVE_ROOT = join(
  PROJECT_ROOT,
  "reports",
  "experiment2-native-baseline-rerun-final",
  "iridium-next-small",
);
const ENHANCED_ROOT = join(
  PROJECT_ROOT,
  "reports",
  "experiment2-int-mc-enhanced-comparison",
  "iridium-next-small",
  "stage2",
  "int-mc-enhanced",
);

const SOURCE_PATHS = Object.freeze({
  nodes: join(NATIVE_ROOT, "stage1-truth", "nodes.csv"),
  links: join(NATIVE_ROOT, "stage1-truth", "links.csv"),
  routes: join(NATIVE_ROOT, "stage1-truth", "routes.csv"),
  enhanced_probes: join(ENHANCED_ROOT, "probe-paths-int-mc.csv"),
});

function argValue(args, name, fallback) {
  const index = args.indexOf(name);
  if (index < 0 || index + 1 >= args.length) return fallback;
  return args[index + 1];
}

function asBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return boolValue(value);
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function sha256File(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function normalizedLinkRow(row, config) {
  const effectiveCapacity = numberValue(row.effective_capacity_mbps);
  const bandwidth = numberValue(row.bandwidth_mbps, 50);
  return {
    slice_index: Math.floor(numberValue(row.slice_index)),
    start_s: round(numberValue(row.slice_index) * config.slice_duration_s),
    link_id: row.link_id,
    source: row.source,
    target: row.target,
    kind: row.kind,
    is_active: boolValue(row.is_active),
    status: row.status,
    delay_ms: round(numberValue(row.latency_ms)),
    data_rate_mbps: round(Math.max(0.001, effectiveCapacity > 0 ? effectiveCapacity : bandwidth)),
    queue_packets: config.queue_packets,
    packet_error_rate: round(Math.max(0, Math.min(1, numberValue(row.packet_error_rate))), 12),
  };
}

function normalizeBusinessFlow(row, config, links) {
  const sliceIndex = Math.floor(numberValue(row.slice_index));
  const pathNodes = splitPath(row.path);
  const validation = validatePathAgainstLinks({ sliceIndex, pathNodes, linkRows: links });
  if (!validation.valid) return { rejected: true, validation, source: row };
  const carried = numberValue(row.carried_traffic_mbps);
  const demand = numberValue(row.traffic_mbps);
  return {
    rejected: false,
    row: {
      slice_index: sliceIndex,
      flow_id: row.task_id,
      source: pathNodes[0],
      sink: pathNodes.at(-1),
      path_nodes: pathNodes.join("|"),
      path_link_ids: validation.link_ids.join("|"),
      start_s: round(sliceIndex * config.slice_duration_s + 0.05),
      stop_s: round((sliceIndex + 1) * config.slice_duration_s - 0.05),
      packet_size_bytes: config.business_packet_bytes,
      raw_rate_mbps: round(Math.max(0.05, carried > 0 ? carried : demand)),
      task_type: row.task_type,
      priority: row.priority,
    },
  };
}

function normalizeProbeFlow(row, config, links, variant) {
  const sliceIndex = Math.floor(numberValue(row.slice_index));
  const originalPathNodes = splitPath(row.path);
  const originalMetadataBytes = variant === "full-int"
    ? Array.from({ length: originalPathNodes.length }, () => config.full_metadata_bytes_per_hop)
    : normalizeMetadataBytes(row.metadata_hop_bytes, originalPathNodes.length, config.full_metadata_bytes_per_hop);
  const validation = repairPathAgainstLinks({ sliceIndex, pathNodes: originalPathNodes, linkRows: links });
  if (!validation.valid) return { rejected: true, validation, source: row, variant };
  const pathNodes = validation.path_nodes;
  const metadataBytes = variant === "full-int"
    ? Array.from({ length: pathNodes.length }, () => config.full_metadata_bytes_per_hop)
    : validation.original_waypoint_indexes.map((waypointIndex) =>
      waypointIndex >= 0 ? originalMetadataBytes[waypointIndex] ?? 0 : 0);
  return {
    rejected: false,
    row: {
      variant,
      slice_index: sliceIndex,
      probe_id: `${variant}:${row.probe_id}`,
      planning_algorithm: variant === "full-int" ? "path-balance-full-int" : "leo-int-mc-selective",
      source: pathNodes[0],
      sink: pathNodes.at(-1),
      path_nodes: pathNodes.join("|"),
      path_link_ids: validation.link_ids.join("|"),
      original_path_nodes: originalPathNodes.join("|"),
      adapter_path_repair_count: validation.repair_count,
      adapter_inserted_transit_hops: validation.inserted_transit_hops,
      metadata_bytes_by_hop: metadataBytes.join("|"),
      metadata_hop_count: metadataBytes.filter((value) => value > 0).length,
      forward_only_hop_count: metadataBytes.filter((value) => value === 0).length,
      start_s: round(sliceIndex * config.slice_duration_s + 0.1),
      stop_s: round((sliceIndex + 1) * config.slice_duration_s - 0.1),
      interval_ms: config.probe_interval_ms,
      base_packet_bytes: config.probe_base_bytes,
      predicted_final_wire_bytes: config.probe_base_bytes +
        metadataBytes.reduce((sum, value) => sum + value, 0) +
        config.ipv4_udp_overhead_bytes,
    },
  };
}

async function loadSourceRows(config) {
  for (const [label, path] of Object.entries(SOURCE_PATHS)) {
    if (!existsSync(path)) throw new Error(`Missing Experiment 13 source ${label}: ${path}`);
  }
  const [nodes, links, routes, enhancedProbes] = await Promise.all([
    readCsvStream(SOURCE_PATHS.nodes, { columns: ["slice_index", "node_id", "plane", "slot"] }),
    readCsvStream(SOURCE_PATHS.links, {
      columns: [
        "slice_index", "link_id", "source", "target", "kind", "status", "is_active",
        "latency_ms", "bandwidth_mbps", "effective_capacity_mbps", "packet_error_rate",
      ],
    }),
    readCsvStream(SOURCE_PATHS.routes, {
      columns: [
        "slice_index", "task_id", "task_type", "priority", "status", "path",
        "traffic_mbps", "carried_traffic_mbps", "delivery_ratio",
      ],
    }),
    readCsvStream(SOURCE_PATHS.enhanced_probes, {
      columns: ["slice_index", "probe_id", "path", "metadata_hop_bytes", "planning_algorithm"],
    }),
  ]);
  const inWindow = (row) => numberValue(row.slice_index) >= 0 && numberValue(row.slice_index) < config.slice_count;
  return {
    nodes: nodes.filter(inWindow),
    links: links.filter(inWindow),
    routes: routes.filter(inWindow),
    enhancedProbes: enhancedProbes.filter(inWindow),
  };
}

export async function exportSystemValidationFixture({ fixtureDir = DEFAULT_FIXTURE_DIR } = {}) {
  const config = { ...SYSTEM_VALIDATION_CONFIG };
  const source = await loadSourceRows(config);
  const nodes = [...new Map(
    source.nodes.map((row) => [row.node_id, {
      node_index: 0,
      node_id: row.node_id,
      plane: Math.floor(numberValue(row.plane)),
      slot: Math.floor(numberValue(row.slot)),
    }]),
  ).values()]
    .sort((left, right) => left.node_id.localeCompare(right.node_id))
    .map((row, index) => ({ ...row, node_index: index }));
  const links = source.links.map((row) => normalizedLinkRow(row, config));

  const flowCandidates = source.routes
    .filter((row) => row.path && row.status !== "unrouted")
    .map((row) => normalizeBusinessFlow(row, config, links));
  const acceptedFlows = flowCandidates.filter((item) => !item.rejected).map((item) => item.row);
  const calibration = calibrateBusinessRates({
    flows: acceptedFlows,
    links,
    targetP90Utilization: config.target_p90_business_utilization,
  });

  const fullCandidates = source.enhancedProbes.map((row) => normalizeProbeFlow(row, config, links, "full-int"));
  const enhancedCandidates = source.enhancedProbes.map((row) => normalizeProbeFlow(row, config, links, "leo-selective"));
  const probeCandidates = [...fullCandidates, ...enhancedCandidates];
  const probeFlows = probeCandidates.filter((item) => !item.rejected).map((item) => item.row);
  const rejected = [
    ...flowCandidates.filter((item) => item.rejected).map((item) => ({
      record_type: "business",
      record_id: item.source.task_id,
      slice_index: item.source.slice_index,
      reason: item.validation.reason,
      failed_hop: item.validation.failed_hop,
    })),
    ...probeCandidates.filter((item) => item.rejected).map((item) => ({
      record_type: item.variant,
      record_id: item.source.probe_id,
      slice_index: item.source.slice_index,
      reason: item.validation.reason,
      failed_hop: item.validation.failed_hop,
    })),
  ];

  const fingerprints = Object.fromEntries(await Promise.all(
    Object.entries(SOURCE_PATHS).map(async ([key, path]) => [key, {
      path: path.slice(PROJECT_ROOT.length + 1).replaceAll("\\", "/"),
      sha256: await sha256File(path),
    }]),
  ));
  const fixtureConfig = {
    ...config,
    comparison_control: {
      policy: "same-probe-paths-same-intervals-different-per-hop-metadata-only",
      full_int_metadata: "96-bytes-at-every-physical-hop",
      leo_selective_metadata: "reuse-exported-full-compact-forward-only-hop-plan",
      inserted_repair_hops: "full-int-writes-96-bytes-leo-selective-is-forward-only",
    },
    business_rate_calibration: {
      policy: "global-scale-so-path-derived-active-link-utilization-p90-equals-target",
      target_p90_utilization: config.target_p90_business_utilization,
      raw_p90_utilization: calibration.raw_p90_utilization,
      scale: calibration.calibration_scale,
      calibrated_p90_utilization: calibration.calibrated_p90_utilization,
    },
  };
  const manifest = {
    schema_version: "experiment13-system-validation-fixture-manifest-v1",
    generated_at: new Date().toISOString(),
    evidence_boundary: "adapter-derived-from-frozen-stage1-and-stage2-artifacts-no-core-model-rerun",
    fixture: {
      node_count: nodes.length,
      slice_count: config.slice_count,
      link_rows: links.length,
      unique_links: new Set(links.map((row) => row.link_id)).size,
      business_flows: calibration.flows.length,
      probe_flows: probeFlows.length,
      rejected_records: rejected.length,
    },
    inputs: fingerprints,
    outputs: {
      config: "config.json",
      nodes: "nodes.csv",
      links: "links.csv",
      business_flows: "business-flows.csv",
      probe_flows: "probe-flows.csv",
      rejected_records: "rejected-records.csv",
    },
  };

  await mkdir(fixtureDir, { recursive: true });
  await Promise.all([
    writeJson(join(fixtureDir, "config.json"), fixtureConfig),
    writeJson(join(fixtureDir, "manifest.json"), manifest),
    writeFile(join(fixtureDir, "nodes.csv"), rowsToCsv(nodes), "utf8"),
    writeFile(join(fixtureDir, "links.csv"), rowsToCsv(links), "utf8"),
    writeFile(join(fixtureDir, "business-flows.csv"), rowsToCsv(calibration.flows), "utf8"),
    writeFile(join(fixtureDir, "probe-flows.csv"), rowsToCsv(probeFlows), "utf8"),
    writeFile(join(fixtureDir, "rejected-records.csv"), rowsToCsv(rejected), "utf8"),
  ]);
  return { fixtureDir, config: fixtureConfig, manifest, nodes, links, businessFlows: calibration.flows, probeFlows };
}

async function loadFixture(fixtureDir) {
  const [config, manifest, nodes, links, businessFlows, probeFlows] = await Promise.all([
    readFile(join(fixtureDir, "config.json"), "utf8").then(JSON.parse),
    readFile(join(fixtureDir, "manifest.json"), "utf8").then(JSON.parse),
    readCsvStream(join(fixtureDir, "nodes.csv")),
    readCsvStream(join(fixtureDir, "links.csv")),
    readCsvStream(join(fixtureDir, "business-flows.csv")),
    readCsvStream(join(fixtureDir, "probe-flows.csv")),
  ]);
  return { config, manifest, nodes, links, businessFlows, probeFlows };
}

export async function runReferencePacketReplay({ fixtureDir = DEFAULT_FIXTURE_DIR, outputDir = DEFAULT_OUTPUT_DIR } = {}) {
  const fixture = await loadFixture(fixtureDir);
  const results = [];
  const loadScales = [...fixture.config.load_scales, ...(fixture.config.stress_load_scales ?? [])];
  for (const loadScale of loadScales) {
    for (const variant of fixture.config.variants) {
      console.log(`[Experiment 13 reference] load=${loadScale} variant=${variant}`);
      results.push(runPacketReference({
        fixture,
        variant,
        loadScale,
        seed: fixture.config.seed,
      }));
    }
  }
  const compared = comparePacketResults(results);
  await mkdir(outputDir, { recursive: true });
  await Promise.all([
    writeJson(join(outputDir, "reference-packet-results.json"), {
      schema_version: "experiment13-reference-packet-results-v1",
      generated_at: new Date().toISOString(),
      evidence_role: "independent-implementation-smoke-not-ns3-system-evidence",
      fixture_manifest: fixture.manifest,
      results: compared,
    }),
    writeFile(join(outputDir, "reference-packet-results.csv"), rowsToCsv(compared), "utf8"),
  ]);
  return { fixture, results: compared };
}

function spawnPromise(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.once("error", rejectPromise);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`${command} exited with code ${code}`));
    });
  });
}

export async function runNs3IfAvailable({
  fixtureDir = DEFAULT_FIXTURE_DIR,
  outputDir = DEFAULT_OUTPUT_DIR,
  ns3Root = process.env.NS3_ROOT ?? "",
  requireNs3 = false,
} = {}) {
  const ns3StatusDir = join(outputDir, "ns3");
  await mkdir(ns3StatusDir, { recursive: true });
  const ns3Executable = ns3Root ? join(resolve(ns3Root), process.platform === "win32" ? "ns3" : "ns3") : "";
  if (!ns3Root || !existsSync(ns3Executable)) {
    const status = {
      status: "not-run",
      reason: "NS3_ROOT is unset or does not contain the ns3 launcher",
      evidence_available: false,
      official_windows_paths: ["WSL2", "MSYS2/MinGW64"],
      next_command: "NS3_ROOT=/path/to/ns-3 npm run experiment13:ns3",
    };
    await writeJson(join(ns3StatusDir, "ns3-status.json"), status);
    if (requireNs3) throw new Error(status.reason);
    return status;
  }
  const runner = join(PROJECT_ROOT, "stage3-system-validation", "ns3", "run-ns3.sh");
  await spawnPromise("bash", [runner, resolve(ns3Root), resolve(fixtureDir), resolve(ns3StatusDir)], {
    cwd: PROJECT_ROOT,
    env: { ...process.env },
  });
  const status = {
    status: "complete",
    evidence_available: true,
    ns3_root: resolve(ns3Root),
    completed_at: new Date().toISOString(),
  };
  await writeJson(join(ns3StatusDir, "ns3-status.json"), status);
  return status;
}

async function main() {
  const args = process.argv.slice(2);
  const phase = argValue(args, "--phase", "all").toLowerCase();
  const fixtureDir = resolve(argValue(args, "--fixture", DEFAULT_FIXTURE_DIR));
  const outputDir = resolve(argValue(args, "--out", DEFAULT_OUTPUT_DIR));
  const requireNs3 = asBoolean(argValue(args, "--require-ns3", "false"));
  const ns3Root = argValue(args, "--ns3-root", process.env.NS3_ROOT ?? "");
  if (["export", "all"].includes(phase)) await exportSystemValidationFixture({ fixtureDir });
  if (["reference", "all"].includes(phase)) await runReferencePacketReplay({ fixtureDir, outputDir });
  if (["ns3", "all"].includes(phase)) {
    await runNs3IfAvailable({ fixtureDir, outputDir, ns3Root, requireNs3 });
  }
  const summary = await writeSystemValidationReport({ fixtureDir, outputDir });
  console.log(JSON.stringify({
    status: "complete",
    phase,
    fixture_dir: fixtureDir,
    output_dir: outputDir,
    evidence_status: summary.evidence_status,
    report: join(outputDir, "EXPERIMENT_13_SYSTEM_VALIDATION.md"),
    visualization: join(outputDir, "index.html"),
  }, null, 2));
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
