import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildFreshWalkerSnapshot,
  evaluateOrbitFreshness,
  sha256,
  summarizeOrbitEpochAges,
} from "./experiments/freshOrbitAcquisition.mjs";
import { generateFreshTopologyWindow } from "./experiments/freshTopologyWindow.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPORT = resolve(ROOT, "reports/experiment14b-prospective-external-validation");
const OUTPUT = join(REPORT, "orbit-source-failover");
const PROTOCOL_PATH = resolve(ROOT, "scripts/experiments/experiment14b-orbit-source-failover-protocol.json");
const SCRIPT_PATH = resolve(ROOT, "scripts/runExperiment14BOrbitSourceFailover.mjs");
const PARENT_PROTOCOL_PATH = resolve(ROOT, "scripts/experiments/experiment14b-protocol.json");
const BASELINE_REGISTRY_PATH = resolve(ROOT, "reports/experiment14-multisource-external-blind-validation/external-source-registry.json");
const BASELINE_SUPPLEMENTAL_PATH = resolve(ROOT, "reports/experiment14-multisource-external-blind-validation/external/celestrak-starlink-future-supgp.json");

function argValue(args, name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

async function writeCsv(path, rows) {
  await mkdir(dirname(path), { recursive: true });
  if (!rows.length) return writeFile(path, "", "utf8");
  const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const body = [headers.join(","), ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(","))].join("\n");
  await writeFile(path, `${body}\n`, "utf8");
}

async function fileRecord(path) {
  const absolute = resolve(path);
  const bytes = await readFile(absolute);
  return {
    path: relative(ROOT, absolute).replaceAll("\\", "/"),
    bytes: bytes.length,
    sha256: sha256(bytes),
  };
}

async function freezeOrVerify() {
  const manifestPath = join(OUTPUT, "amendment-freeze.json");
  const sidecarPath = join(OUTPUT, "amendment-freeze.sha256");
  if (await exists(manifestPath)) {
    const manifest = await readJson(manifestPath);
    if ((await readFile(sidecarPath, "utf8")).trim() !== sha256(JSON.stringify(manifest))) {
      throw new Error("Orbit source failover freeze manifest changed");
    }
    const changed = [];
    for (const file of manifest.files) {
      const current = await fileRecord(resolve(ROOT, file.path));
      if (current.bytes !== file.bytes || current.sha256 !== file.sha256) changed.push(file.path);
    }
    if (changed.length) throw new Error(`Orbit source failover frozen files changed: ${changed.join(", ")}`);
    return manifest;
  }
  const parentFreeze = await readJson(join(REPORT, "freeze-manifest.json"));
  const standardGate = await readJson(join(REPORT, "orbit", "selected-shell-freshness-gate.json"));
  if (standardGate.passed !== false) throw new Error("Failover can only be frozen after the standard GP age gate fails");
  const manifest = {
    schema: "int-telemetry-experiment14b-orbit-source-failover-freeze/v1",
    frozen_at: new Date().toISOString(),
    evidence_state_at_freeze: "standard GP failed original age gate; topology and user-performance score absent",
    parent_freeze: {
      frozen_at: parentFreeze.frozen_at,
      protocol_sha256: parentFreeze.hashes.protocol_sha256,
    },
    observed_trigger_only: {
      standard_gate_passed: standardGate.passed,
      failed_checks: Object.entries(standardGate.checks).filter(([, passed]) => !passed).map(([name]) => name),
    },
    files: await Promise.all([SCRIPT_PATH, PROTOCOL_PATH].map(fileRecord)),
  };
  await writeJson(manifestPath, manifest);
  await writeFile(sidecarPath, `${sha256(JSON.stringify(manifest))}\n`, "utf8");
  return manifest;
}

function medianEpochHours(snapshot) {
  return new Date(summarizeOrbitEpochAges(snapshot.satellites, new Date()).epoch_median).getTime() / 3_600_000;
}

function agePolicy(parentProtocol) {
  return {
    minimum_records: parentProtocol.orbit.planes * parentProtocol.orbit.satellites_per_plane,
    maximum_median_age_hours: parentProtocol.orbit.maximum_selected_median_age_hours,
    maximum_p95_age_hours: parentProtocol.orbit.maximum_selected_p95_age_hours,
    maximum_future_epoch_ratio: parentProtocol.orbit.maximum_future_epoch_ratio,
  };
}

async function verifyApplied() {
  const result = await readJson(join(OUTPUT, "source-selection-result.json"));
  const changed = [];
  for (const [name, artifact] of Object.entries(result.artifacts)) {
    const current = await fileRecord(resolve(ROOT, artifact.path));
    if (current.bytes !== artifact.bytes || current.sha256 !== artifact.sha256) changed.push(name);
  }
  if (changed.length) throw new Error(`Applied supplemental GP artifacts changed: ${changed.join(", ")}`);
  return result;
}

async function applyFailover() {
  const resultPath = join(OUTPUT, "source-selection-result.json");
  if (await exists(resultPath)) return verifyApplied();
  const parentProtocol = await readJson(PARENT_PROTOCOL_PATH);
  const amendment = await readJson(PROTOCOL_PATH);
  const parentFreeze = await readJson(join(REPORT, "freeze-manifest.json"));
  const collectionPath = join(REPORT, "collection-status.json");
  const collection = await readJson(collectionPath);
  const standardGatePath = join(REPORT, "orbit", "selected-shell-freshness-gate.json");
  const standardGate = await readJson(standardGatePath);
  if (standardGate.passed !== false || collection.sources.topology?.status === "complete") {
    throw new Error("Failover trigger is not valid or topology already exists");
  }
  const supplemental = collection.sources.orbit_input?.supplemental;
  if (!supplemental?.causality_eligible || supplemental.source_url !== parentProtocol.orbit.supplemental_gp_url) {
    throw new Error("Supplemental GP acquisition is not causally eligible or does not match the preregistered URL");
  }
  if (new Date(supplemental.acquired_at).getTime() < new Date(parentFreeze.windows.orbit_input_not_before).getTime()) {
    throw new Error("Supplemental GP was acquired before the parent freeze");
  }
  const rawCurrentPath = resolve(supplemental.immutable_path);
  const rawCurrentBytes = await readFile(rawCurrentPath);
  if (sha256(rawCurrentBytes) !== supplemental.sha256) throw new Error("Supplemental GP raw source hash mismatch");
  const baselineRegistry = await readJson(BASELINE_REGISTRY_PATH);
  const baselineEntry = baselineRegistry.find((row) => row.source === "future-spacex-supgp");
  if (!baselineEntry) throw new Error("Pre-freeze supplemental GP registry entry is absent");
  if (supplemental.sha256 === baselineEntry.sha256) throw new Error("Supplemental GP content did not change after the parent freeze");

  const currentRecords = await readJson(join(REPORT, "orbit", "starlink-supplemental-gp-acquired.json"));
  const baselineRecords = await readJson(BASELINE_SUPPLEMENTAL_PATH);
  const options = {
    sourceUrl: parentProtocol.orbit.supplemental_gp_url,
    planes: parentProtocol.orbit.planes,
    satellitesPerPlane: parentProtocol.orbit.satellites_per_plane,
    raanClusterThresholdDeg: parentProtocol.orbit.raan_cluster_threshold_deg,
  };
  const baselineSnapshot = await buildFreshWalkerSnapshot(baselineRecords, {
    ...options,
    downloadedAt: baselineEntry.acquired_at,
  });
  const snapshot = await buildFreshWalkerSnapshot(currentRecords, {
    ...options,
    downloadedAt: supplemental.acquired_at,
  });
  const epochAdvanceHours = medianEpochHours(snapshot) - medianEpochHours(baselineSnapshot);
  const minimumAdvance = amendment.supplemental_acceptance.minimum_selected_shell_median_epoch_advance_hours;
  const windowStart = new Date(supplemental.acquired_at);
  const windowEnd = new Date(windowStart.getTime() +
    parentProtocol.topology_window.slices * parentProtocol.topology_window.step_minutes * 60_000);
  const freshness = evaluateOrbitFreshness(snapshot.satellites, windowStart, agePolicy(parentProtocol));
  const windowEndFreshness = evaluateOrbitFreshness(snapshot.satellites, windowEnd, agePolicy(parentProtocol));
  const sourceSelectionGate = {
    schema: "int-telemetry-experiment14b-orbit-source-selection-gate/v1",
    evaluated_at: new Date().toISOString(),
    primary_source: "standard-gp",
    selected_source: "supplemental-gp",
    reason: "standard GP failed unchanged preregistered median-age gate",
    thresholds_relaxed: false,
    downstream_scores_consulted: false,
    checks: {
      standard_gp_failed_original_gate: standardGate.passed === false,
      supplemental_acquired_after_parent_freeze: new Date(supplemental.acquired_at) >= new Date(parentFreeze.windows.orbit_input_not_before),
      supplemental_content_hash_changed: supplemental.sha256 !== baselineEntry.sha256,
      supplemental_selected_epoch_advanced: epochAdvanceHours >= minimumAdvance,
      supplemental_start_age_gate: freshness.passed,
      supplemental_window_end_age_gate: windowEndFreshness.passed,
      selected_satellite_count: snapshot.selected_count === parentProtocol.orbit.planes * parentProtocol.orbit.satellites_per_plane,
    },
    selected_epoch_median_advance_hours: epochAdvanceHours,
    passed: false,
  };
  sourceSelectionGate.passed = Object.values(sourceSelectionGate.checks).every(Boolean);
  if (!sourceSelectionGate.passed) throw new Error(`Supplemental GP failover gate failed: ${JSON.stringify(sourceSelectionGate.checks)}`);

  await writeJson(join(OUTPUT, "standard-gp-failure-evidence.json"), {
    schema: "int-telemetry-experiment14b-standard-gp-failure-evidence/v1",
    source: collection.sources.orbit_input.standard,
    freshness: standardGate,
    snapshot_before_replacement: await fileRecord(join(REPORT, "orbit", "fresh-model-input-walker-72x22.json")),
  });
  await writeJson(join(REPORT, "orbit", "standard-gp-selected-shell-freshness-gate.json"), standardGate);
  await writeJson(join(REPORT, "orbit", "fresh-model-input-walker-72x22.json"), snapshot);
  await writeJson(join(REPORT, "orbit", "selected-shell-freshness-gate.json"), freshness);
  await writeJson(join(REPORT, "orbit", "selected-shell-window-end-freshness-gate.json"), windowEndFreshness);
  await writeJson(join(REPORT, "orbit", "model-input-source-selection-gate.json"), sourceSelectionGate);

  const topology = await generateFreshTopologyWindow(snapshot, {
    epochIso: supplemental.acquired_at,
    slices: parentProtocol.topology_window.slices,
    stepMinutes: parentProtocol.topology_window.step_minutes,
    mode: parentProtocol.topology_window.mode,
    trafficProfile: parentProtocol.topology_window.traffic_profile,
    routingAlgorithm: parentProtocol.topology_window.routing_algorithm,
  });
  const expectedNodeRows = snapshot.selected_count * parentProtocol.topology_window.slices;
  if (topology.nodes.length !== expectedNodeRows) {
    throw new Error(`Topology node row count mismatch: ${topology.nodes.length} != ${expectedNodeRows}`);
  }
  const topologyDirectory = join(REPORT, "topology");
  const nodesPath = join(topologyDirectory, "nodes.csv");
  const linksPath = join(topologyDirectory, "links.csv");
  const topologyMetadata = {
    schema: topology.schema,
    status: "complete",
    generated_at: topology.generated_at,
    source_role: "supplemental-gp-model-input",
    source_catalog_fingerprint: topology.source_catalog_fingerprint,
    epoch_iso: topology.epoch_iso,
    slices: topology.slices,
    step_minutes: topology.step_minutes,
    node_rows: topology.nodes.length,
    link_rows: topology.links.length,
    nodes_csv: relative(ROOT, nodesPath).replaceAll("\\", "/"),
    links_csv: relative(ROOT, linksPath).replaceAll("\\", "/"),
  };
  await writeCsv(nodesPath, topology.nodes);
  await writeCsv(linksPath, topology.links);
  await writeJson(join(topologyDirectory, "metadata.json"), topologyMetadata);

  collection.generated_at = new Date().toISOString();
  collection.sources.orbit_input = {
    ...collection.sources.orbit_input,
    status: "complete-supplemental-gp-failover",
    model_input_source: "supplemental",
    source_selection_gate: sourceSelectionGate,
    freshness,
    window_end_freshness: windowEndFreshness,
    snapshot_path: "reports/experiment14b-prospective-external-validation/orbit/fresh-model-input-walker-72x22.json",
    input_ready: true,
  };
  collection.sources.topology = topologyMetadata;
  collection.sources.orbit_future_validation = {
    status: "pending-future-window",
    source_family: "supplemental-gp",
    available_at: parentFreeze.windows.orbit_validation_not_before,
  };
  await writeJson(collectionPath, collection);

  const artifacts = {
    model_snapshot: await fileRecord(join(REPORT, "orbit", "fresh-model-input-walker-72x22.json")),
    start_age_gate: await fileRecord(join(REPORT, "orbit", "selected-shell-freshness-gate.json")),
    window_end_age_gate: await fileRecord(join(REPORT, "orbit", "selected-shell-window-end-freshness-gate.json")),
    source_selection_gate: await fileRecord(join(REPORT, "orbit", "model-input-source-selection-gate.json")),
    topology_nodes: await fileRecord(nodesPath),
    topology_links: await fileRecord(linksPath),
    topology_metadata: await fileRecord(join(topologyDirectory, "metadata.json")),
  };
  const result = {
    schema: "int-telemetry-experiment14b-orbit-source-failover-result/v1",
    status: "supplemental-gp-model-input-complete",
    completed_at: new Date().toISOString(),
    amendment_freeze: relative(ROOT, join(OUTPUT, "amendment-freeze.json")).replaceAll("\\", "/"),
    source_selection_gate: sourceSelectionGate,
    selected_shell: {
      shell_id: snapshot.shell_id,
      selected_count: snapshot.selected_count,
      mean_altitude_km: snapshot.mean_altitude_km,
      mean_inclination_deg: snapshot.mean_inclination_deg,
      layout: snapshot.layout,
    },
    validity_window: { start: windowStart.toISOString(), end: windowEnd.toISOString() },
    artifacts,
  };
  await writeJson(resultPath, result);
  return result;
}

const phase = argValue(process.argv.slice(2), "--phase", "apply");
const freeze = await freezeOrVerify();
const result = phase === "freeze"
  ? { status: "orbit-source-failover-frozen", frozen_at: freeze.frozen_at }
  : phase === "apply"
    ? await applyFailover()
    : (() => { throw new Error(`Unknown phase: ${phase}`); })();
console.log(JSON.stringify({ phase, ...result }, null, 2));
