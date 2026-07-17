import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { spawn } from "node:child_process";

function argValue(args, name, fallback = "") {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  return args[index + 1] ?? fallback;
}

function numberArg(args, name, fallback) {
  const raw = argValue(args, name, "");
  if (raw === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
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

function csvEscape(value) {
  const text = value === undefined || value === null ? "" : String(value);
  if (!/[",\n\r]/.test(text)) return text;
  return `"${text.replaceAll('"', '""')}"`;
}

function rowsToCsv(rows) {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]);
  return [
    headers.join(","),
    ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(",")),
  ].join("\n");
}

async function readCsv(path) {
  return parseCsv(await readFile(path, "utf8"));
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function requireFile(path, label) {
  if (!existsSync(path)) throw new Error(`${label} not found: ${path}`);
}

function numberValue(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolValue(value) {
  return String(value).toLowerCase() === "true";
}

function splitPath(value) {
  return String(value || "")
    .split(/\s+>\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function groupBy(rows, keyFn) {
  const map = new Map();
  rows.forEach((row) => {
    const key = keyFn(row);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  });
  return map;
}

function indexBy(rows, keyFn) {
  const map = new Map();
  rows.forEach((row) => map.set(keyFn(row), row));
  return map;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function mean(values) {
  const usable = values.filter(Number.isFinite);
  if (usable.length === 0) return 0;
  return usable.reduce((total, value) => total + value, 0) / usable.length;
}

function std(values) {
  const usable = values.filter(Number.isFinite);
  if (usable.length <= 1) return 0;
  const avg = mean(usable);
  return Math.sqrt(mean(usable.map((value) => (value - avg) ** 2)));
}

function percentile(values, q) {
  const usable = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (usable.length === 0) return 0;
  const position = Math.max(0, Math.min(1, q)) * (usable.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return usable[lower];
  return usable[lower] + (usable[upper] - usable[lower]) * (position - lower);
}

function round(value, digits = 4) {
  if (!Number.isFinite(value)) return 0;
  return Number(value.toFixed(digits));
}

function formatPercent(value, digits = 2) {
  return `${(numberValue(value) * 100).toFixed(digits)}%`;
}

function formatBytes(value) {
  const bytes = numberValue(value);
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(2)} MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(2)} KB`;
  return `${bytes.toFixed(0)} B`;
}

function stableHash(text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededShuffle(rows, seed) {
  return [...rows].sort((left, right) => {
    const leftScore = stableHash(`${seed}|${left.slice_index}|${left.probe_id}|${left.path}|${left.link_ids}`);
    const rightScore = stableHash(`${seed}|${right.slice_index}|${right.probe_id}|${right.path}|${right.link_ids}`);
    return leftScore - rightScore || String(left.probe_id).localeCompare(String(right.probe_id));
  });
}

function runNode(script, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: options.cwd ?? process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0 && !options.allowFailure) {
        reject(new Error(`Command failed: node ${script} ${args.join(" ")}\n${stderr || stdout}`));
        return;
      }
      resolvePromise({ stdout, stderr, code });
    });
  });
}

function parseLastJson(stdout, label) {
  const trimmed = stdout.trim();
  if (!trimmed) return {};
  const start = trimmed.lastIndexOf("\n{");
  const jsonText = start >= 0 ? trimmed.slice(start + 1) : trimmed;
  try {
    return JSON.parse(jsonText);
  } catch (error) {
    throw new Error(`${label} did not end with JSON: ${error.message}\n${trimmed.slice(-1000)}`);
  }
}

async function runStep(label, script, args, options = {}) {
  console.log(`[experiment2] ${label}`);
  const result = await runNode(script, args, options);
  return parseLastJson(result.stdout, label);
}

function activeLinkSetsBySlice(links) {
  const bySlice = groupBy(links, (link) => String(link.slice_index));
  return new Map(
    [...bySlice.entries()].map(([sliceIndex, sliceLinks]) => [
      sliceIndex,
      new Set(sliceLinks.filter((link) => boolValue(link.is_active)).map((link) => link.link_id)),
    ]),
  );
}

function pathActiveLinks(row, activeSet) {
  return unique(splitPath(row.link_ids)).filter((linkId) => activeSet.has(linkId));
}

function selectProbeSubset({
  candidatePaths,
  links,
  algorithm,
  strategy,
  targetActiveLinkCoverage,
  pathLimitBySlice = null,
  pathLinkBudgetBySlice = null,
  seed = 0,
  outputDir,
}) {
  const activeBySlice = activeLinkSetsBySlice(links);
  const candidatesBySlice = groupBy(candidatePaths, (row) => String(row.slice_index));
  const selectedRows = [];
  const summaryRows = [];

  for (const [sliceIndex, activeSet] of [...activeBySlice.entries()].sort((a, b) => Number(a[0]) - Number(b[0]))) {
    const candidates = candidatesBySlice.get(sliceIndex) ?? [];
    const ordered = strategy === "random-sampling"
      ? seededShuffle(candidates, seed)
      : [...candidates].sort((left, right) =>
          numberValue(left.path_link_count, splitPath(left.link_ids).length) -
            numberValue(right.path_link_count, splitPath(right.link_ids).length) ||
          numberValue(left.path_node_count, splitPath(left.path).length) -
            numberValue(right.path_node_count, splitPath(right.path).length) ||
          String(left.probe_id).localeCompare(String(right.probe_id)),
        );
    const covered = new Set();
    const selected = [];
    const targetCount = Math.ceil(activeSet.size * targetActiveLinkCoverage);
    const pathLimit = pathLimitBySlice?.get(String(sliceIndex)) ?? 0;
    const pathLinkBudget = pathLinkBudgetBySlice?.get(String(sliceIndex)) ?? 0;
    let selectedPathLinkBudget = 0;

    for (const candidate of ordered) {
      const candidatePathLinks = numberValue(candidate.path_link_count, splitPath(candidate.link_ids).length);
      if (pathLimit > 0 && selected.length >= pathLimit) break;
      if (pathLinkBudget > 0 && selected.length > 0 && selectedPathLinkBudget + candidatePathLinks > pathLinkBudget) break;
      if (pathLimit <= 0 && pathLinkBudget <= 0 && selected.length > 0 && covered.size >= targetCount) break;
      selected.push(candidate);
      selectedPathLinkBudget += candidatePathLinks;
      pathActiveLinks(candidate, activeSet).forEach((linkId) => covered.add(linkId));
    }

    selected.forEach((row, index) => {
      const path = splitPath(row.path);
      const linkIds = splitPath(row.link_ids);
      selectedRows.push({
        ...row,
        probe_id: `${algorithm}-${String(sliceIndex).padStart(2, "0")}-${String(index + 1).padStart(3, "0")}`,
        planning_algorithm: algorithm,
        source: path[0] ?? row.source ?? "",
        sink: path[path.length - 1] ?? row.sink ?? "",
        path_node_count: path.length,
        path_link_count: linkIds.length,
        covered_link_count: unique(linkIds).length,
        path: path.join(" > "),
        link_ids: linkIds.join(" > "),
      });
    });

    const selectedPathLengths = selected.map((row) => numberValue(row.path_link_count, splitPath(row.link_ids).length));
    summaryRows.push({
      planning_algorithm: algorithm,
      selection_strategy: strategy,
      random_seed: strategy === "random-sampling" ? seed : "",
      slice_index: Number(sliceIndex),
      active_links: activeSet.size,
      selected_paths: selected.length,
      selected_path_links: selected.reduce((total, row) => total + numberValue(row.path_link_count, splitPath(row.link_ids).length), 0),
      selected_unique_active_links: covered.size,
      planned_active_link_coverage: round(covered.size / Math.max(activeSet.size, 1)),
      target_active_link_coverage: targetActiveLinkCoverage,
      path_budget_source: pathLinkBudget > 0 ? "fixed-path-link-budget" : pathLimit > 0 ? "fixed-path-count" : "target-active-link-coverage",
      path_budget_limit: pathLimit || "",
      path_link_budget_limit: pathLinkBudget || "",
      selected_path_link_budget: selectedPathLinkBudget,
      min_path_links: selectedPathLengths.length ? Math.min(...selectedPathLengths) : 0,
      max_path_links: selectedPathLengths.length ? Math.max(...selectedPathLengths) : 0,
      mean_path_links: round(mean(selectedPathLengths)),
    });
  }

  return Promise.all([
    writeFile(join(outputDir, `probe-paths-${algorithm}.csv`), rowsToCsv(selectedRows), "utf8"),
    writeFile(join(outputDir, `probe-summary-${algorithm}.csv`), rowsToCsv(summaryRows), "utf8"),
    writeFile(join(outputDir, `probe-coverage-${algorithm}.json`), JSON.stringify({
      schema_version: "experiment2-selected-probe-paths-v1",
      generated_at: new Date().toISOString(),
      algorithm,
      strategy,
      random_seed: strategy === "random-sampling" ? seed : null,
      target_active_link_coverage: targetActiveLinkCoverage,
      selected_paths: selectedRows.length,
      planned_active_link_coverage: round(mean(summaryRows.map((row) => row.planned_active_link_coverage))),
      per_slice: summaryRows,
    }, null, 2), "utf8"),
  ]).then(() => ({ selectedRows, summaryRows }));
}

async function collectPerSliceMetrics({ methodId, methodLabel, inputDir, groundDir, overheadPath }) {
  const [truthNodes, truthLinks, reconstructedNodes, reconstructedLinks, overheadRows] = await Promise.all([
    readCsv(join(inputDir, "nodes.csv")),
    readCsv(join(inputDir, "links.csv")),
    readCsv(join(groundDir, "ground-reconstructed-nodes.csv")),
    readCsv(join(groundDir, "ground-reconstructed-links.csv")),
    existsSync(overheadPath) ? readCsv(overheadPath) : Promise.resolve([]),
  ]);

  const truthNodesBySlice = groupBy(truthNodes, (row) => String(row.slice_index));
  const truthLinksBySlice = groupBy(truthLinks, (row) => String(row.slice_index));
  const nodesBySlice = groupBy(reconstructedNodes, (row) => String(row.slice_index));
  const linksBySlice = groupBy(reconstructedLinks, (row) => String(row.slice_index));
  const overheadBySlice = indexBy(overheadRows, (row) => String(row.slice_index));
  const sliceIndexes = [...new Set([...truthNodesBySlice.keys(), ...truthLinksBySlice.keys()])].sort((a, b) => Number(a) - Number(b));

  return sliceIndexes.map((sliceIndex) => {
    const truthNodeRows = truthNodesBySlice.get(sliceIndex) ?? [];
    const truthLinkRows = truthLinksBySlice.get(sliceIndex) ?? [];
    const reconstructedNodeRows = nodesBySlice.get(sliceIndex) ?? [];
    const reconstructedLinkRows = linksBySlice.get(sliceIndex) ?? [];
    const observedNodes = reconstructedNodeRows.filter((row) => boolValue(row.observed));
    const observedLinks = reconstructedLinkRows.filter((row) => boolValue(row.observed));
    const truthActiveLinks = truthLinkRows.filter((row) => boolValue(row.is_active));
    const truthLinkById = indexBy(truthLinkRows, (row) => row.link_id);
    const observedActiveLinks = observedLinks.filter((row) => boolValue(truthLinkById.get(row.link_id)?.is_active));
    const overhead = overheadBySlice.get(sliceIndex) ?? {};
    return {
      method_id: methodId,
      method_label: methodLabel,
      slice_index: Number(sliceIndex),
      time: truthNodeRows[0]?.time ?? truthLinkRows[0]?.time ?? overhead.time ?? "",
      truth_nodes: truthNodeRows.length,
      observed_nodes: observedNodes.length,
      node_coverage: round(observedNodes.length / Math.max(truthNodeRows.length, 1)),
      truth_links: truthLinkRows.length,
      observed_links: observedLinks.length,
      link_coverage: round(observedLinks.length / Math.max(truthLinkRows.length, 1)),
      truth_active_links: truthActiveLinks.length,
      observed_active_links: observedActiveLinks.length,
      active_link_coverage: round(observedActiveLinks.length / Math.max(truthActiveLinks.length, 1)),
      active_link_direct_coverage: round(observedActiveLinks.length / Math.max(truthActiveLinks.length, 1)),
      active_link_effective_coverage: round(observedActiveLinks.length / Math.max(truthActiveLinks.length, 1)),
      completed_active_links: observedActiveLinks.length,
      inferred_active_links: 0,
      hop_records: numberValue(overhead.hop_records),
      reports: numberValue(overhead.reports),
      total_int_bytes: numberValue(overhead.total_int_bytes),
      total_telemetry_generated_bytes: numberValue(overhead.total_telemetry_generated_bytes),
      total_telemetry_energy_j: numberValue(overhead.total_telemetry_energy_j),
    };
  });
}

async function collectIntMcPerSliceMetrics({ methodId, methodLabel, inputDir, groundDir, overheadPath }) {
  const [truthNodes, truthLinks, reconstructedNodes, reconstructedLinks, overheadRows] = await Promise.all([
    readCsv(join(inputDir, "nodes.csv")),
    readCsv(join(inputDir, "links.csv")),
    readCsv(join(groundDir, "ground-mc-reconstructed-nodes.csv")),
    readCsv(join(groundDir, "ground-mc-reconstructed-links.csv")),
    existsSync(overheadPath) ? readCsv(overheadPath) : Promise.resolve([]),
  ]);

  const truthNodesBySlice = groupBy(truthNodes, (row) => String(row.slice_index));
  const truthLinksBySlice = groupBy(truthLinks, (row) => String(row.slice_index));
  const nodesBySlice = groupBy(reconstructedNodes, (row) => String(row.slice_index));
  const linksBySlice = groupBy(reconstructedLinks, (row) => String(row.slice_index));
  const overheadBySlice = indexBy(overheadRows, (row) => String(row.slice_index));
  const sliceIndexes = [...new Set([...truthNodesBySlice.keys(), ...truthLinksBySlice.keys()])].sort((a, b) => Number(a) - Number(b));

  return sliceIndexes.map((sliceIndex) => {
    const truthNodeRows = truthNodesBySlice.get(sliceIndex) ?? [];
    const truthLinkRows = truthLinksBySlice.get(sliceIndex) ?? [];
    const reconstructedNodeRows = nodesBySlice.get(sliceIndex) ?? [];
    const reconstructedLinkRows = linksBySlice.get(sliceIndex) ?? [];
    const truthActiveLinks = truthLinkRows.filter((row) => boolValue(row.is_active));
    const truthLinkById = indexBy(truthLinkRows, (row) => row.link_id);
    const observedNodes = reconstructedNodeRows.filter((row) => boolValue(row.observed) || row.observation_source === "observed");
    const completedNodes = reconstructedNodeRows.filter((row) =>
      boolValue(row.observed) || boolValue(row.inferred) || row.observation_source === "observed" || row.observation_source === "inferred"
    );
    const observedLinks = reconstructedLinkRows.filter((row) => boolValue(row.observed) || row.observation_source === "observed");
    const completedLinks = reconstructedLinkRows.filter((row) =>
      boolValue(row.observed) || boolValue(row.inferred) || row.observation_source === "observed" || row.observation_source === "inferred"
    );
    const observedActiveLinks = observedLinks.filter((row) => boolValue(truthLinkById.get(row.link_id)?.is_active));
    const completedActiveLinks = completedLinks.filter((row) => boolValue(truthLinkById.get(row.link_id)?.is_active));
    const inferredActiveLinks = completedActiveLinks.filter((row) => boolValue(row.inferred) || row.observation_source === "inferred");
    const overhead = overheadBySlice.get(sliceIndex) ?? {};
    return {
      method_id: methodId,
      method_label: methodLabel,
      slice_index: Number(sliceIndex),
      time: truthNodeRows[0]?.time ?? truthLinkRows[0]?.time ?? overhead.time ?? "",
      truth_nodes: truthNodeRows.length,
      observed_nodes: observedNodes.length,
      completed_nodes: completedNodes.length,
      node_coverage: round(completedNodes.length / Math.max(truthNodeRows.length, 1)),
      node_direct_coverage: round(observedNodes.length / Math.max(truthNodeRows.length, 1)),
      truth_links: truthLinkRows.length,
      observed_links: observedLinks.length,
      completed_links: completedLinks.length,
      link_coverage: round(completedLinks.length / Math.max(truthLinkRows.length, 1)),
      link_direct_coverage: round(observedLinks.length / Math.max(truthLinkRows.length, 1)),
      truth_active_links: truthActiveLinks.length,
      observed_active_links: observedActiveLinks.length,
      completed_active_links: completedActiveLinks.length,
      inferred_active_links: inferredActiveLinks.length,
      active_link_coverage: round(completedActiveLinks.length / Math.max(truthActiveLinks.length, 1)),
      active_link_direct_coverage: round(observedActiveLinks.length / Math.max(truthActiveLinks.length, 1)),
      active_link_effective_coverage: round(completedActiveLinks.length / Math.max(truthActiveLinks.length, 1)),
      hop_records: numberValue(overhead.hop_records),
      reports: numberValue(overhead.reports),
      total_int_bytes: numberValue(overhead.total_int_bytes),
      total_telemetry_generated_bytes: numberValue(overhead.total_telemetry_generated_bytes),
      total_telemetry_energy_j: numberValue(overhead.total_telemetry_energy_j),
    };
  });
}

function meanField(rows, field) {
  const values = rows.map((row) => numberValue(row[field], NaN)).filter(Number.isFinite);
  return values.length ? round(mean(values)) : "";
}

function majority(values, fallback = "") {
  const counts = new Map();
  values.filter((value) => value !== undefined && value !== "").forEach((value) => {
    const key = String(value);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  });
  if (counts.size === 0) return fallback;
  return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0][0];
}

function observedBool(value) {
  const text = String(value ?? "").toLowerCase();
  if (text === "true") return true;
  if (text === "false") return false;
  return "";
}

function mae(rows, estimateField, truthMap, truthField, keyField) {
  const values = rows
    .map((row) => {
      const truth = truthMap.get(`${row.slice_index}|${row[keyField]}`);
      const estimate = numberValue(row[estimateField], NaN);
      const truthValue = numberValue(truth?.[truthField], NaN);
      if (!Number.isFinite(estimate) || !Number.isFinite(truthValue)) return NaN;
      return Math.abs(estimate - truthValue);
    })
    .filter(Number.isFinite);
  return values.length ? round(mean(values)) : 0;
}

async function buildDirectOamEvaluation({ inputDir, hopRecordsPath, reportsPath, groundDir, downlinkBudgetBytes }) {
  const [truthNodes, truthLinks, hopRecords, reports] = await Promise.all([
    readCsv(join(inputDir, "nodes.csv")),
    readCsv(join(inputDir, "links.csv")),
    readCsv(hopRecordsPath),
    readCsv(reportsPath),
  ]);

  const transmittableReports = reports.filter((report) => {
    const status = String(report.status || "generated").toLowerCase();
    const reportingStatus = String(report.reporting_status || "planned").toLowerCase();
    return status !== "dropped" && reportingStatus !== "blocked";
  });
  const deliveredReports = [];
  const undeliveredReports = [];
  const bySlice = groupBy(transmittableReports, (report) => String(report.slice_index));
  for (const [sliceIndex, sliceReports] of [...bySlice.entries()].sort((a, b) => Number(a[0]) - Number(b[0]))) {
    let remaining = Number(downlinkBudgetBytes);
    for (const report of sliceReports) {
      const size = numberValue(report.report_size_bytes);
      if (size <= remaining) {
        remaining -= size;
        deliveredReports.push({
          ...report,
          ground_status: "downlinked",
          downlinked_slice: sliceIndex,
          delivery_delay_slices: 0,
        });
      } else {
        undeliveredReports.push({
          ...report,
          ground_status: "queued",
          downlinked_slice: "",
          delivery_delay_slices: "",
          drop_reason: "slice-budget-exhausted",
        });
      }
    }
  }
  reports
    .filter((report) => !transmittableReports.includes(report))
    .forEach((report) => undeliveredReports.push({
      ...report,
      ground_status: "dropped",
      downlinked_slice: "",
      delivery_delay_slices: "",
      drop_reason: report.drop_reason || "not-transmittable",
    }));

  const deliveredPacketIds = new Set(deliveredReports.map((report) => report.packet_id));
  const deliveredHopRecords = hopRecords.filter((record) => deliveredPacketIds.has(record.packet_id));
  const nodeObservationGroups = groupBy(deliveredHopRecords, (record) => `${record.slice_index}|${record.node_id}`);
  const linkObservationGroups = groupBy(
    deliveredHopRecords.filter((record) => record.observed_link_id),
    (record) => `${record.slice_index}|${record.observed_link_id}`,
  );
  const nodeObservations = new Map(
    [...nodeObservationGroups.entries()].map(([key, rows]) => [key, {
      observed: true,
      mode_estimate: majority(rows.map((row) => row.observed_node_mode), "unknown"),
      cpu_percent_estimate: meanField(rows, "observed_cpu_percent"),
      queue_depth_estimate: meanField(rows, "observed_queue_depth"),
      queued_traffic_mb_estimate: meanField(rows, "observed_queued_traffic_mb"),
      cache_used_mb_estimate: meanField(rows, "observed_cache_used_mb"),
      energy_percent_estimate: meanField(rows, "observed_energy_percent"),
      observation_count: rows.length,
    }]),
  );
  const linkObservations = new Map(
    [...linkObservationGroups.entries()].map(([key, rows]) => [key, {
      observed: true,
      status_estimate: majority(rows.map((row) => row.observed_link_status), "unknown"),
      active_estimate: majority(rows.map((row) => row.observed_link_active), ""),
      utilization_percent_estimate: meanField(rows, "observed_link_utilization_percent"),
      latency_ms_estimate: meanField(rows, "observed_link_latency_ms"),
      queue_latency_ms_estimate: meanField(rows, "observed_link_queue_latency_ms"),
      capacity_mbps_estimate: meanField(rows, "observed_link_capacity_mbps"),
      congestion_percent_estimate: meanField(rows, "observed_link_congestion_percent"),
      queued_traffic_mb_estimate: meanField(rows, "observed_link_queued_mb"),
      dropped_traffic_mb_estimate: meanField(rows, "observed_link_dropped_mb"),
      packet_error_rate_estimate: meanField(rows, "observed_link_packet_error_rate"),
      observation_count: rows.length,
    }]),
  );

  const reconstructedNodes = truthNodes.map((truth) => {
    const observation = nodeObservations.get(`${truth.slice_index}|${truth.node_id}`);
    if (!observation) {
      return {
        slice_index: truth.slice_index,
        node_id: truth.node_id,
        observed: false,
        observation_source: "unknown",
        last_observed_slice: "",
        mode_estimate: "unknown",
        cpu_percent_estimate: "",
        queue_depth_estimate: "",
        queued_traffic_mb_estimate: "",
        cache_used_mb_estimate: "",
        energy_percent_estimate: "",
        confidence: 0,
        observation_count: 0,
      };
    }
    return {
      slice_index: truth.slice_index,
      node_id: truth.node_id,
      observed: true,
      observation_source: "observed",
      last_observed_slice: truth.slice_index,
      ...observation,
      confidence: 1,
    };
  });

  const reconstructedLinks = truthLinks.map((truth) => {
    const observation = linkObservations.get(`${truth.slice_index}|${truth.link_id}`);
    if (!observation) {
      return {
        slice_index: truth.slice_index,
        link_id: truth.link_id,
        observed: false,
        observation_source: "unknown",
        last_observed_slice: "",
        status_estimate: "unknown",
        active_estimate: "",
        utilization_percent_estimate: "",
        latency_ms_estimate: "",
        queue_latency_ms_estimate: "",
        capacity_mbps_estimate: "",
        congestion_percent_estimate: "",
        queued_traffic_mb_estimate: "",
        dropped_traffic_mb_estimate: "",
        packet_error_rate_estimate: "",
        confidence: 0,
        observation_count: 0,
      };
    }
    return {
      slice_index: truth.slice_index,
      link_id: truth.link_id,
      observed: true,
      observation_source: "observed",
      last_observed_slice: truth.slice_index,
      ...observation,
      confidence: 1,
    };
  });

  const truthNodeByKey = indexBy(truthNodes, (row) => `${row.slice_index}|${row.node_id}`);
  const truthLinkByKey = indexBy(truthLinks, (row) => `${row.slice_index}|${row.link_id}`);
  const observedNodes = reconstructedNodes.filter((row) => boolValue(row.observed));
  const observedLinks = reconstructedLinks.filter((row) => boolValue(row.observed));
  const activeTruthLinks = truthLinks.filter((row) => boolValue(row.is_active));
  const observedActiveLinks = observedLinks.filter((row) => boolValue(truthLinkByKey.get(`${row.slice_index}|${row.link_id}`)?.is_active));
  const modeMatches = observedNodes.filter((row) => {
    const truth = truthNodeByKey.get(`${row.slice_index}|${row.node_id}`);
    return truth && String(row.mode_estimate) === String(truth.mode);
  }).length;
  const statusMatches = observedLinks.filter((row) => {
    const truth = truthLinkByKey.get(`${row.slice_index}|${row.link_id}`);
    return truth && String(row.status_estimate) === String(truth.status);
  }).length;
  const truthCongested = truthLinks.filter((row) => numberValue(row.congestion_percent) > 0 || numberValue(row.queued_traffic_mb) > 0);
  const observedCongestedKeys = new Set(
    observedLinks
      .filter((row) => numberValue(row.congestion_percent_estimate) > 0 || numberValue(row.queued_traffic_mb_estimate) > 0)
      .map((row) => `${row.slice_index}|${row.link_id}`),
  );
  const congestionRecall = truthCongested.filter((row) => observedCongestedKeys.has(`${row.slice_index}|${row.link_id}`)).length /
    Math.max(truthCongested.length, 1);

  const reportMetrics = {
    schema_version: "experiment2-direct-ground-oam-evaluation-v1",
    generated_at: new Date().toISOString(),
    source: {
      input_dir: inputDir,
      int_hop_records_csv: hopRecordsPath,
      int_reports_csv: reportsPath,
    },
    boundary: {
      runtime_uses_only_delivered_int_reports: true,
      truth_used_only_for_evaluation: true,
      unknown_not_filled_from_truth: true,
      stale_estimates_not_counted_as_observed: true,
      prior_estimates_not_counted_as_observed: true,
      direct_evaluator: true,
    },
    downlink_model: {
      per_slice_budget_bytes: Number(downlinkBudgetBytes),
      carry_over_enabled: false,
      generated_reports: reports.length,
      transmittable_reports: transmittableReports.length,
      delivered_reports: deliveredReports.length,
      queued_or_dropped_reports: undeliveredReports.length,
      delivered_hop_records: deliveredHopRecords.length,
      delivery_ratio: round(deliveredReports.length / Math.max(reports.length, 1)),
      mean_delivery_delay_slices: 0,
    },
    oam_state_model: {
      stale_carry_over_enabled: false,
      prior_estimates_enabled: false,
      report_fusion: "direct-observed-majority-mean-fusion",
    },
    node_reconstruction: {
      total_node_samples: truthNodes.length,
      observed_node_samples: observedNodes.length,
      node_sample_coverage: round(observedNodes.length / Math.max(truthNodes.length, 1)),
      unknown_node_samples: truthNodes.length - observedNodes.length,
      cpu_mae: mae(observedNodes, "cpu_percent_estimate", truthNodeByKey, "cpu_percent", "node_id"),
      queue_depth_mae: mae(observedNodes, "queue_depth_estimate", truthNodeByKey, "queue_depth", "node_id"),
      energy_percent_mae: mae(observedNodes, "energy_percent_estimate", truthNodeByKey, "energy_percent", "node_id"),
      mode_accuracy: round(modeMatches / Math.max(observedNodes.length, 1)),
    },
    link_reconstruction: {
      total_link_samples: truthLinks.length,
      observed_link_samples: observedLinks.length,
      link_sample_coverage: round(observedLinks.length / Math.max(truthLinks.length, 1)),
      total_active_link_samples: activeTruthLinks.length,
      observed_active_link_samples: observedActiveLinks.length,
      active_link_sample_coverage: round(observedActiveLinks.length / Math.max(activeTruthLinks.length, 1)),
      unknown_link_samples: truthLinks.length - observedLinks.length,
      status_accuracy: round(statusMatches / Math.max(observedLinks.length, 1)),
      utilization_mae: mae(observedLinks, "utilization_percent_estimate", truthLinkByKey, "utilization_percent", "link_id"),
      latency_ms_mae: mae(observedLinks, "latency_ms_estimate", truthLinkByKey, "latency_ms", "link_id"),
      queue_latency_ms_mae: mae(observedLinks, "queue_latency_ms_estimate", truthLinkByKey, "queue_latency_ms", "link_id"),
      congestion_recall_over_global_truth: round(congestionRecall),
    },
  };

  await mkdir(groundDir, { recursive: true });
  await Promise.all([
    writeFile(join(groundDir, "ground-delivered-reports.csv"), rowsToCsv(deliveredReports), "utf8"),
    writeFile(join(groundDir, "ground-undelivered-reports.csv"), rowsToCsv(undeliveredReports), "utf8"),
    writeFile(join(groundDir, "ground-reconstructed-nodes.csv"), rowsToCsv(reconstructedNodes), "utf8"),
    writeFile(join(groundDir, "ground-reconstructed-links.csv"), rowsToCsv(reconstructedLinks), "utf8"),
    writeFile(join(groundDir, "ground-oam-evaluation.json"), JSON.stringify(reportMetrics, null, 2), "utf8"),
  ]);
  return reportMetrics;
}

async function collectBaselineMetrics({ methodId, methodLabel, methodFamily, evaluationPath, runReportPath, perSliceRows, seed = "" }) {
  const evaluation = await readJson(evaluationPath);
  const runReport = await readJson(runReportPath);
  const node = evaluation.node_reconstruction ?? {};
  const link = evaluation.link_reconstruction ?? {};
  const overhead = runReport.overhead ?? {};
  const coverage = runReport.coverage ?? {};
  const downlink = evaluation.downlink_model ?? {};

  return {
    method_id: methodId,
    method_label: methodLabel,
    method_family: methodFamily,
    random_seed: seed,
    generated_reports: downlink.generated_reports ?? overhead.reports ?? 0,
    delivered_reports: downlink.delivered_reports ?? "",
    delivery_ratio: downlink.delivery_ratio ?? "",
    hop_records: overhead.hop_records ?? 0,
    total_int_bytes: overhead.total_int_bytes ?? 0,
    total_telemetry_generated_bytes: overhead.total_telemetry_generated_bytes ?? 0,
    total_telemetry_energy_j: overhead.total_telemetry_energy_j ?? 0,
    total_telemetry_energy_wh: overhead.total_telemetry_energy_wh ?? 0,
    node_sample_coverage: node.node_sample_coverage ?? coverage.node_sample_coverage ?? 0,
    link_sample_coverage: link.link_sample_coverage ?? 0,
    active_link_sample_coverage: link.active_link_sample_coverage ?? coverage.active_link_sample_coverage ?? 0,
    active_link_direct_coverage: link.active_link_sample_coverage ?? coverage.active_link_sample_coverage ?? 0,
    active_link_effective_coverage: link.active_link_sample_coverage ?? coverage.active_link_sample_coverage ?? 0,
    int_mc_inferred_rate_on_active: "",
    int_mc_active_link_completion_coverage: "",
    int_mc_utilization_inferred_mae: "",
    int_mc_latency_inferred_mae_ms: "",
    cpu_mae: node.cpu_mae ?? "",
    queue_depth_mae: node.queue_depth_mae ?? "",
    energy_percent_mae: node.energy_percent_mae ?? "",
    node_mode_accuracy: node.mode_accuracy ?? "",
    link_status_accuracy: link.status_accuracy ?? "",
    link_utilization_mae: link.utilization_mae ?? "",
    link_latency_mae_ms: link.latency_ms_mae ?? link.latency_mae ?? "",
    congestion_recall_global: link.congestion_recall_over_global_truth ?? "",
    unknown_node_samples: node.unknown_node_samples ?? "",
    unknown_link_samples: link.unknown_link_samples ?? "",
    observed_node_samples: node.observed_node_samples ?? "",
    observed_link_samples: link.observed_link_samples ?? "",
    observed_active_link_samples: link.observed_active_link_samples ?? "",
    per_slice_active_coverage_mean: round(mean(perSliceRows.map((row) => numberValue(row.active_link_coverage, NaN)).filter(Number.isFinite))),
    per_slice_active_coverage_std: round(std(perSliceRows.map((row) => numberValue(row.active_link_coverage, NaN)).filter(Number.isFinite))),
    per_slice_direct_active_coverage_mean: round(mean(perSliceRows.map((row) => numberValue(row.active_link_direct_coverage, NaN)).filter(Number.isFinite))),
    per_slice_effective_active_coverage_mean: round(mean(perSliceRows.map((row) => numberValue(row.active_link_effective_coverage, NaN)).filter(Number.isFinite))),
    per_slice_node_coverage_mean: round(mean(perSliceRows.map((row) => numberValue(row.node_coverage, NaN)).filter(Number.isFinite))),
    per_slice_node_coverage_std: round(std(perSliceRows.map((row) => numberValue(row.node_coverage, NaN)).filter(Number.isFinite))),
    notes: "",
  };
}

async function collectIntMcBaselineMetrics({ methodId, methodLabel, methodFamily, evaluationPath, selectorReportPath, runReportPath, perSliceRows }) {
  const [evaluation, selectorReport, runReport] = await Promise.all([
    readJson(evaluationPath),
    readJson(selectorReportPath),
    readJson(runReportPath),
  ]);
  const reconstruction = evaluation.reconstruction ?? {};
  const node = evaluation.node_reconstruction ?? {};
  const overhead = runReport.overhead ?? {};
  const selectionCoverage = selectorReport.coverage ?? {};
  const utilization = evaluation.metrics?.utilization_percent ?? {};
  const latency = evaluation.metrics?.latency_ms ?? {};
  const queueLatency = evaluation.metrics?.queue_latency_ms ?? {};

  return {
    method_id: methodId,
    method_label: methodLabel,
    method_family: methodFamily,
    random_seed: "",
    generated_reports: overhead.reports ?? 0,
    delivered_reports: "",
    delivery_ratio: "",
    hop_records: overhead.hop_records ?? 0,
    total_int_bytes: overhead.total_int_bytes ?? 0,
    total_telemetry_generated_bytes: overhead.total_telemetry_generated_bytes ?? 0,
    total_telemetry_energy_j: overhead.total_telemetry_energy_j ?? 0,
    total_telemetry_energy_wh: overhead.total_telemetry_energy_wh ?? 0,
    node_sample_coverage: node.node_completion_coverage ?? 0,
    link_sample_coverage: reconstruction.link_samples
      ? round((reconstruction.observed_link_samples + reconstruction.inferred_link_samples) / Math.max(reconstruction.link_samples, 1))
      : 0,
    active_link_sample_coverage: reconstruction.active_link_completion_coverage ?? 0,
    active_link_direct_coverage: reconstruction.direct_observation_rate_on_active ?? 0,
    active_link_effective_coverage: reconstruction.active_link_completion_coverage ?? 0,
    int_mc_inferred_rate_on_active: reconstruction.inferred_rate_on_active ?? "",
    int_mc_active_link_completion_coverage: reconstruction.active_link_completion_coverage ?? "",
    int_mc_direct_observation_rate_on_active: reconstruction.direct_observation_rate_on_active ?? "",
    int_mc_planned_active_link_sampling_coverage: selectionCoverage.active_link_sampling_coverage ?? "",
    int_mc_planning_cost_saving_ratio: selectionCoverage.estimated_planning_cost_saving_ratio ?? "",
    int_mc_utilization_inferred_mae: utilization.inferred_mae ?? "",
    int_mc_latency_inferred_mae_ms: latency.inferred_mae ?? "",
    int_mc_queue_latency_inferred_mae_ms: queueLatency.inferred_mae ?? "",
    cpu_mae: evaluation.node_reconstruction?.metrics?.cpu_percent?.mae ?? "",
    queue_depth_mae: evaluation.node_reconstruction?.metrics?.queue_depth?.mae ?? "",
    energy_percent_mae: evaluation.node_reconstruction?.metrics?.energy_percent?.mae ?? "",
    node_mode_accuracy: node.mode_accuracy_all_nodes ?? "",
    link_status_accuracy: reconstruction.status_accuracy_all_links ?? "",
    link_utilization_mae: utilization.mae ?? "",
    link_latency_mae_ms: latency.mae ?? "",
    congestion_recall_global: "",
    unknown_node_samples: node.unknown_node_samples ?? "",
    unknown_link_samples: reconstruction.unknown_link_samples ?? "",
    observed_node_samples: node.observed_node_samples ?? "",
    observed_link_samples: reconstruction.observed_link_samples ?? "",
    observed_active_link_samples: round((reconstruction.direct_observation_rate_on_active ?? 0) * Math.max(reconstruction.active_link_samples ?? 0, 1)),
    inferred_link_samples: reconstruction.inferred_link_samples ?? "",
    per_slice_active_coverage_mean: round(mean(perSliceRows.map((row) => numberValue(row.active_link_coverage, NaN)).filter(Number.isFinite))),
    per_slice_active_coverage_std: round(std(perSliceRows.map((row) => numberValue(row.active_link_coverage, NaN)).filter(Number.isFinite))),
    per_slice_direct_active_coverage_mean: round(mean(perSliceRows.map((row) => numberValue(row.active_link_direct_coverage, NaN)).filter(Number.isFinite))),
    per_slice_effective_active_coverage_mean: round(mean(perSliceRows.map((row) => numberValue(row.active_link_effective_coverage, NaN)).filter(Number.isFinite))),
    per_slice_node_coverage_mean: round(mean(perSliceRows.map((row) => numberValue(row.node_coverage, NaN)).filter(Number.isFinite))),
    per_slice_node_coverage_std: round(std(perSliceRows.map((row) => numberValue(row.node_coverage, NaN)).filter(Number.isFinite))),
    notes: "selected probe + Ground OAM matrix completion",
  };
}

function aggregateRandomRows(randomRows) {
  const fields = [
    "node_sample_coverage",
    "link_sample_coverage",
    "active_link_sample_coverage",
    "active_link_direct_coverage",
    "active_link_effective_coverage",
    "total_telemetry_generated_bytes",
    "total_telemetry_energy_j",
    "hop_records",
  ];
  const aggregate = {
    method_id: "random-sampling-aggregate",
    method_label: "random sampling mean/std",
    method_family: "random-sampling",
    random_seed: "aggregate",
    generated_reports: round(mean(randomRows.map((row) => numberValue(row.generated_reports, NaN)).filter(Number.isFinite))),
    delivered_reports: round(mean(randomRows.map((row) => numberValue(row.delivered_reports, NaN)).filter(Number.isFinite))),
    delivery_ratio: round(mean(randomRows.map((row) => numberValue(row.delivery_ratio, NaN)).filter(Number.isFinite))),
  };
  fields.forEach((field) => {
    const values = randomRows.map((row) => numberValue(row[field], NaN)).filter(Number.isFinite);
    aggregate[field] = round(mean(values));
    aggregate[`${field}_std`] = round(std(values));
    aggregate[`${field}_min`] = round(Math.min(...values));
    aggregate[`${field}_max`] = round(Math.max(...values));
  });
  aggregate.total_int_bytes = round(mean(randomRows.map((row) => numberValue(row.total_int_bytes, NaN)).filter(Number.isFinite)));
  aggregate.total_telemetry_energy_wh = round(mean(randomRows.map((row) => numberValue(row.total_telemetry_energy_wh, NaN)).filter(Number.isFinite)), 8);
  aggregate.cpu_mae = round(mean(randomRows.map((row) => numberValue(row.cpu_mae, NaN)).filter(Number.isFinite)));
  aggregate.queue_depth_mae = round(mean(randomRows.map((row) => numberValue(row.queue_depth_mae, NaN)).filter(Number.isFinite)));
  aggregate.energy_percent_mae = round(mean(randomRows.map((row) => numberValue(row.energy_percent_mae, NaN)).filter(Number.isFinite)));
  aggregate.node_mode_accuracy = round(mean(randomRows.map((row) => numberValue(row.node_mode_accuracy, NaN)).filter(Number.isFinite)));
  aggregate.link_status_accuracy = round(mean(randomRows.map((row) => numberValue(row.link_status_accuracy, NaN)).filter(Number.isFinite)));
  aggregate.link_utilization_mae = round(mean(randomRows.map((row) => numberValue(row.link_utilization_mae, NaN)).filter(Number.isFinite)));
  aggregate.congestion_recall_global = round(mean(randomRows.map((row) => numberValue(row.congestion_recall_global, NaN)).filter(Number.isFinite)));
  aggregate.per_slice_active_coverage_mean = round(mean(randomRows.map((row) => numberValue(row.per_slice_active_coverage_mean, NaN)).filter(Number.isFinite)));
  aggregate.per_slice_active_coverage_std = round(mean(randomRows.map((row) => numberValue(row.per_slice_active_coverage_std, NaN)).filter(Number.isFinite)));
  aggregate.notes = "mean/std over random seeds";
  return aggregate;
}

function aggregateRandomPerSliceRows(perSliceRows) {
  const randomRowsBySlice = groupBy(
    perSliceRows.filter((row) => String(row.method_id).startsWith("random-sampling-seed-")),
    (row) => String(row.slice_index),
  );
  return [...randomRowsBySlice.entries()]
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([sliceIndex, rows]) => ({
      method_id: "random-sampling-aggregate",
      method_label: "random sampling mean",
      slice_index: Number(sliceIndex),
      time: rows[0]?.time ?? "",
      truth_nodes: round(mean(rows.map((row) => numberValue(row.truth_nodes, NaN)).filter(Number.isFinite))),
      observed_nodes: round(mean(rows.map((row) => numberValue(row.observed_nodes, NaN)).filter(Number.isFinite))),
      node_coverage: round(mean(rows.map((row) => numberValue(row.node_coverage, NaN)).filter(Number.isFinite))),
      truth_links: round(mean(rows.map((row) => numberValue(row.truth_links, NaN)).filter(Number.isFinite))),
      observed_links: round(mean(rows.map((row) => numberValue(row.observed_links, NaN)).filter(Number.isFinite))),
      link_coverage: round(mean(rows.map((row) => numberValue(row.link_coverage, NaN)).filter(Number.isFinite))),
      truth_active_links: round(mean(rows.map((row) => numberValue(row.truth_active_links, NaN)).filter(Number.isFinite))),
      observed_active_links: round(mean(rows.map((row) => numberValue(row.observed_active_links, NaN)).filter(Number.isFinite))),
      active_link_coverage: round(mean(rows.map((row) => numberValue(row.active_link_coverage, NaN)).filter(Number.isFinite))),
      active_link_direct_coverage: round(mean(rows.map((row) => numberValue(row.active_link_direct_coverage, NaN)).filter(Number.isFinite))),
      active_link_effective_coverage: round(mean(rows.map((row) => numberValue(row.active_link_effective_coverage, NaN)).filter(Number.isFinite))),
      completed_active_links: round(mean(rows.map((row) => numberValue(row.completed_active_links, NaN)).filter(Number.isFinite))),
      inferred_active_links: 0,
      hop_records: round(mean(rows.map((row) => numberValue(row.hop_records, NaN)).filter(Number.isFinite))),
      reports: round(mean(rows.map((row) => numberValue(row.reports, NaN)).filter(Number.isFinite))),
      total_int_bytes: round(mean(rows.map((row) => numberValue(row.total_int_bytes, NaN)).filter(Number.isFinite))),
      total_telemetry_generated_bytes: round(mean(rows.map((row) => numberValue(row.total_telemetry_generated_bytes, NaN)).filter(Number.isFinite))),
      total_telemetry_energy_j: round(mean(rows.map((row) => numberValue(row.total_telemetry_energy_j, NaN)).filter(Number.isFinite))),
    }));
}

function svgLineChart({ rows, methods, field, width = 900, height = 280, title, yLabel }) {
  const margin = { top: 34, right: 24, bottom: 34, left: 54 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const slices = unique(rows.map((row) => String(row.slice_index))).sort((a, b) => Number(a) - Number(b));
  const maxSlice = Math.max(1, ...slices.map(Number));
  const values = rows.map((row) => numberValue(row[field], NaN)).filter(Number.isFinite);
  const maxValue = Math.max(1, ...values);
  const colors = ["#2563eb", "#dc2626", "#16a34a", "#9333ea", "#f97316", "#0891b2"];
  const x = (slice) => margin.left + (Number(slice) / Math.max(maxSlice, 1)) * plotWidth;
  const y = (value) => margin.top + plotHeight - (numberValue(value) / maxValue) * plotHeight;
  const paths = methods.map((method, index) => {
    const bySlice = indexBy(rows.filter((row) => row.method_id === method.method_id), (row) => String(row.slice_index));
    const points = slices
      .map((slice) => bySlice.get(slice))
      .filter(Boolean)
      .map((row) => `${x(row.slice_index).toFixed(2)},${y(row[field]).toFixed(2)}`)
      .join(" ");
    return `<polyline points="${points}" fill="none" stroke="${colors[index % colors.length]}" stroke-width="2.5" />`;
  }).join("\n");
  const legend = methods.map((method, index) => `
    <g transform="translate(${margin.left + index * 160}, ${height - 8})">
      <rect width="10" height="10" fill="${colors[index % colors.length]}"></rect>
      <text x="16" y="10" font-size="12">${method.method_label}</text>
    </g>`).join("");
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((tick) => {
    const value = maxValue <= 1.0001 ? tick : tick * maxValue;
    return `
      <line x1="${margin.left}" x2="${width - margin.right}" y1="${y(value)}" y2="${y(value)}" stroke="#e5e7eb" />
      <text x="${margin.left - 8}" y="${y(value) + 4}" text-anchor="end" font-size="11">${maxValue <= 1.0001 ? `${Math.round(tick * 100)}%` : round(value, 0)}</text>`;
  }).join("");
  return `
  <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${title}">
    <text x="${margin.left}" y="20" font-size="16" font-weight="700">${title}</text>
    <text x="16" y="${margin.top + 12}" font-size="11" transform="rotate(-90 16 ${margin.top + 12})">${yLabel}</text>
    ${yTicks}
    <line x1="${margin.left}" x2="${width - margin.right}" y1="${margin.top + plotHeight}" y2="${margin.top + plotHeight}" stroke="#9ca3af" />
    <line x1="${margin.left}" x2="${margin.left}" y1="${margin.top}" y2="${margin.top + plotHeight}" stroke="#9ca3af" />
    ${paths}
    ${legend}
  </svg>`;
}

function svgBarChart({ rows, field, width = 900, height = 260, title, formatter = (value) => String(value) }) {
  const margin = { top: 34, right: 24, bottom: 54, left: 74 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const values = rows.map((row) => numberValue(row[field], 0));
  const maxValue = Math.max(1e-9, ...values);
  const barGap = 16;
  const barWidth = Math.max(22, (plotWidth - barGap * (rows.length - 1)) / Math.max(rows.length, 1));
  const colors = ["#2563eb", "#dc2626", "#16a34a", "#9333ea", "#f97316"];
  const bars = rows.map((row, index) => {
    const value = numberValue(row[field], 0);
    const h = (value / maxValue) * plotHeight;
    const x = margin.left + index * (barWidth + barGap);
    const y = margin.top + plotHeight - h;
    return `
      <rect x="${x}" y="${y}" width="${barWidth}" height="${h}" rx="3" fill="${colors[index % colors.length]}"></rect>
      <text x="${x + barWidth / 2}" y="${y - 6}" text-anchor="middle" font-size="11">${formatter(value)}</text>
      <text x="${x + barWidth / 2}" y="${height - 22}" text-anchor="middle" font-size="11">${row.method_label}</text>`;
  }).join("");
  return `
  <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${title}">
    <text x="${margin.left}" y="20" font-size="16" font-weight="700">${title}</text>
    <line x1="${margin.left}" x2="${width - margin.right}" y1="${margin.top + plotHeight}" y2="${margin.top + plotHeight}" stroke="#9ca3af" />
    <line x1="${margin.left}" x2="${margin.left}" y1="${margin.top}" y2="${margin.top + plotHeight}" stroke="#9ca3af" />
    ${bars}
  </svg>`;
}

function svgScatter({ rows, width = 900, height = 300 }) {
  const margin = { top: 38, right: 34, bottom: 58, left: 78 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const byteValues = rows.map((row) => numberValue(row.total_telemetry_generated_bytes, NaN)).filter((value) => Number.isFinite(value) && value > 0);
  const coverageValues = rows.map((row) => numberValue(row.active_link_effective_coverage ?? row.active_link_sample_coverage, NaN)).filter(Number.isFinite);
  const logValues = byteValues.map((value) => Math.log10(value));
  const rawMinLog = Math.min(...logValues);
  const rawMaxLog = Math.max(...logValues);
  const logSpan = Math.max(rawMaxLog - rawMinLog, 0.001);
  const minLog = rawMinLog - logSpan * 0.08;
  const maxLog = rawMaxLog + logSpan * 0.08;
  const minCoverage = Math.min(...coverageValues);
  const maxCoverage = Math.max(...coverageValues);
  const coverageSpan = Math.max(maxCoverage - minCoverage, 0.001);
  const minY = Math.max(0, minCoverage - Math.max(0.04, coverageSpan * 0.12));
  const maxY = Math.min(1, maxCoverage + Math.max(0.04, coverageSpan * 0.12));
  const ySpan = Math.max(maxY - minY, 0.001);
  const x = (value) => {
    const logValue = Math.log10(Math.max(numberValue(value), 1));
    return margin.left + ((logValue - minLog) / Math.max(maxLog - minLog, 0.001)) * plotWidth;
  };
  const y = (value) => margin.top + plotHeight - ((numberValue(value) - minY) / ySpan) * plotHeight;
  const colors = ["#2563eb", "#dc2626", "#16a34a", "#9333ea", "#f97316"];
  const points = rows.map((row, index) => `
    <circle cx="${x(row.total_telemetry_generated_bytes)}" cy="${y(row.active_link_effective_coverage ?? row.active_link_sample_coverage)}" r="7" fill="${colors[index % colors.length]}"></circle>
    <text x="${x(row.total_telemetry_generated_bytes) + (x(row.total_telemetry_generated_bytes) > width - 190 ? -10 : 10)}" y="${y(row.active_link_effective_coverage ?? row.active_link_sample_coverage) + 4}" text-anchor="${x(row.total_telemetry_generated_bytes) > width - 190 ? "end" : "start"}" font-size="12">${row.method_label}</text>`).join("");
  const xTicks = [minLog, (minLog + maxLog) / 2, maxLog].map((tick) => {
    const tickX = margin.left + ((tick - minLog) / Math.max(maxLog - minLog, 0.001)) * plotWidth;
    return `
      <line x1="${tickX}" x2="${tickX}" y1="${margin.top}" y2="${margin.top + plotHeight}" stroke="#e5e7eb" />
      <text x="${tickX}" y="${height - 28}" text-anchor="middle" font-size="11">${formatBytes(10 ** tick)}</text>`;
  }).join("");
  const yTicks = [minY, (minY + maxY) / 2, maxY].map((tick) => `
    <line x1="${margin.left}" x2="${width - margin.right}" y1="${y(tick)}" y2="${y(tick)}" stroke="#e5e7eb" />
    <text x="${margin.left - 8}" y="${y(tick) + 4}" text-anchor="end" font-size="11">${formatPercent(tick, 1)}</text>`).join("");
  return `
  <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="coverage overhead tradeoff">
    <text x="${margin.left}" y="20" font-size="16" font-weight="700">覆盖率-开销权衡图</text>
    <text x="${width / 2}" y="${height - 8}" text-anchor="middle" font-size="12">Telemetry generated bytes, min-max log scale</text>
    <text x="16" y="${margin.top + 26}" font-size="12" transform="rotate(-90 16 ${margin.top + 26})">Active link effective coverage</text>
    ${xTicks}
    ${yTicks}
    <line x1="${margin.left}" x2="${width - margin.right}" y1="${margin.top + plotHeight}" y2="${margin.top + plotHeight}" stroke="#9ca3af" />
    <line x1="${margin.left}" x2="${margin.left}" y1="${margin.top}" y2="${margin.top + plotHeight}" stroke="#9ca3af" />
    ${points}
  </svg>`;
}

function buildHtmlReport({ summary, primaryRows, randomRows, perSliceRows, outputFiles }) {
  const chartMethods = primaryRows.map((row) => ({ method_id: row.method_id, method_label: row.method_label }));
  const randomActiveValues = randomRows.map((row) => numberValue(row.active_link_sample_coverage));
  const randomBox = randomRows.length ? {
    min: Math.min(...randomActiveValues),
    p25: percentile(randomActiveValues, 0.25),
    p50: percentile(randomActiveValues, 0.5),
    p75: percentile(randomActiveValues, 0.75),
    max: Math.max(...randomActiveValues),
    std: std(randomActiveValues),
  } : null;
  const tableRows = primaryRows.map((row) => `
      <tr>
        <td>${row.method_label}</td>
        <td>${formatPercent(row.node_sample_coverage)}</td>
        <td>${formatPercent(row.active_link_direct_coverage ?? row.active_link_sample_coverage)}</td>
        <td>${formatPercent(row.active_link_effective_coverage ?? row.active_link_sample_coverage)}</td>
        <td>${row.int_mc_inferred_rate_on_active === "" ? "-" : formatPercent(row.int_mc_inferred_rate_on_active)}</td>
        <td>${formatBytes(row.total_telemetry_generated_bytes)}</td>
        <td>${numberValue(row.total_telemetry_energy_j).toFixed(3)} J</td>
        <td>${numberValue(row.hop_records).toLocaleString("en-US")}</td>
        <td>${row.notes || ""}</td>
      </tr>`).join("");
  const randomTableRows = randomRows.map((row) => `
      <tr>
        <td>${row.random_seed}</td>
        <td>${formatPercent(row.node_sample_coverage)}</td>
        <td>${formatPercent(row.active_link_direct_coverage ?? row.active_link_sample_coverage)}</td>
        <td>${formatPercent(row.active_link_effective_coverage ?? row.active_link_sample_coverage)}</td>
        <td>${formatBytes(row.total_telemetry_generated_bytes)}</td>
        <td>${numberValue(row.per_slice_active_coverage_std).toFixed(4)}</td>
      </tr>`).join("");

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>实验 2：原生 INT 基线对照</title>
  <style>
    :root { color-scheme: light; --text: #111827; --muted: #6b7280; --line: #e5e7eb; --panel: #ffffff; --bg: #f8fafc; }
    body { margin: 0; background: var(--bg); color: var(--text); font-family: "Microsoft YaHei", "Segoe UI", sans-serif; line-height: 1.55; }
    header { padding: 32px 40px 24px; background: #0f172a; color: white; }
    header p { max-width: 1080px; color: #cbd5e1; }
    main { padding: 24px 40px 48px; max-width: 1280px; margin: 0 auto; }
    section { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 22px; margin-bottom: 18px; box-shadow: 0 1px 2px rgba(15,23,42,.04); }
    h1, h2, h3 { margin: 0 0 12px; line-height: 1.25; }
    h1 { font-size: 30px; }
    h2 { font-size: 22px; }
    h3 { font-size: 16px; }
    .grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; }
    .card { border: 1px solid var(--line); border-radius: 8px; padding: 14px; background: #fff; }
    .metric { font-size: 25px; font-weight: 750; margin: 4px 0; }
    .muted { color: var(--muted); font-size: 13px; }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    th, td { border-bottom: 1px solid var(--line); padding: 9px 8px; text-align: left; vertical-align: top; }
    th { background: #f8fafc; font-weight: 700; }
    code { background: #f1f5f9; padding: 2px 5px; border-radius: 4px; }
    .chart { overflow-x: auto; border: 1px solid var(--line); border-radius: 8px; margin-top: 12px; background: white; }
    .formula { background: #f8fafc; border: 1px solid var(--line); border-radius: 8px; padding: 12px; font-family: "Consolas", monospace; }
    .two { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
    @media (max-width: 980px) { .grid, .two { grid-template-columns: 1fr; } main, header { padding-left: 18px; padding-right: 18px; } }
  </style>
</head>
<body>
  <header>
    <h1>实验 2：原生 INT 基线对照实验</h1>
    <p>本实验固定使用第一阶段高仿真 LEO 网络真值，只改变第二阶段 INT 遥测策略，比较 traffic-int、全量 probe-int、最短路径 probe 和随机采样 probe 在覆盖率、遥测开销、逐时间片稳定性上的差异。</p>
  </header>
  <main>
    <section>
      <h2>实验设置</h2>
      <div class="grid">
        <div class="card"><div class="muted">输入真值目录</div><div class="metric">${basename(summary.input_dir)}</div><div class="muted">${summary.input_dir}</div></div>
        <div class="card"><div class="muted">时间片</div><div class="metric">${summary.slice_count}</div><div class="muted">逐时间片重构与评估</div></div>
        <div class="card"><div class="muted">卫星节点</div><div class="metric">${summary.node_count}</div><div class="muted">每个时间片</div></div>
        <div class="card"><div class="muted">链路样本</div><div class="metric">${summary.link_sample_count.toLocaleString("en-US")}</div><div class="muted">全时间片累计</div></div>
      </div>
    </section>

    <section>
      <h2>实验思路</h2>
      <p><b>traffic-int</b> 只在业务流路径上采集 INT metadata，不额外发探测包，因此开销最低，但只能看见业务经过的区域。</p>
      <p><b>full probe-int</b> 主动规划覆盖全网的 probe path，并在经过节点执行本地邻接链路扫描，作为原生 INT 的高覆盖、高开销上界。</p>
      <p><b>shortest-path probe</b> 在相同候选路径集合中优先选择跳数更短的路径，代表低路径代价但存在路径偏置的主动探测。</p>
      <p><b>random sampling</b> 继承 shortest-path probe 在每个时间片消耗的路径链路数预算，并随机选择 probe path；多 seed 结果用于刻画其覆盖效率和稳定性。</p>
      <div class="formula">
        NodeCoverage = observed_nodes / truth_nodes<br />
        ActiveLinkCoverage = observed_active_links / truth_active_links<br />
        TelemetryOverhead = generated_INT_bytes = metadata_bytes + report_bytes + probe_base_bytes<br />
        Stability = Std(coverage over slices/seeds)
      </div>
    </section>

    <section>
      <h2>总体结果</h2>
      <table>
        <thead><tr><th>方法</th><th>节点有效覆盖率</th><th>活动链路直接观测</th><th>活动链路有效覆盖</th><th>INT-MC 推断占比</th><th>遥测字节</th><th>遥测能耗</th><th>Hop records</th><th>说明</th></tr></thead>
        <tbody>${tableRows}</tbody>
      </table>
      <div class="chart">${svgBarChart({ rows: primaryRows, field: "active_link_effective_coverage", title: "活动链路有效覆盖率", formatter: (value) => formatPercent(value) })}</div>
      <div class="chart">${svgBarChart({ rows: primaryRows, field: "total_telemetry_generated_bytes", title: "遥测生成字节", formatter: formatBytes })}</div>
      <p class="muted">覆盖率-开销权衡图是方法级汇总图，每个点代表一种基线方法的全实验结果；横轴是遥测生成字节，纵轴是活动链路覆盖率，越靠左上表示单位开销下覆盖越好。</p>
      <div class="chart">${svgScatter({ rows: primaryRows })}</div>
    </section>

    <section>
      <h2>逐时间片表现</h2>
      <p>LEO 网络拓扑随时间片变化，单看总体均值会掩盖某些时间片下的覆盖断崖。下面的折线图用于观察每种基线在 T00-T${String(summary.slice_count - 1).padStart(2, "0")} 上的覆盖波动。</p>
      <div class="chart">${svgLineChart({ rows: perSliceRows.filter((row) => chartMethods.some((method) => method.method_id === row.method_id)), methods: chartMethods, field: "active_link_coverage", title: "逐时间片活动链路覆盖率", yLabel: "coverage" })}</div>
      <div class="chart">${svgLineChart({ rows: perSliceRows.filter((row) => chartMethods.some((method) => method.method_id === row.method_id)), methods: chartMethods, field: "total_telemetry_generated_bytes", title: "逐时间片遥测字节", yLabel: "bytes" })}</div>
    </section>

    <section>
      <h2>随机采样稳定性</h2>
      <p>随机采样采用多个 seed 重复运行。若在相近路径链路数预算下覆盖率低于结构化路径选择，或 seed/时间片间波动更大，说明它没有充分利用 LEO 星座的轨道和拓扑结构。</p>
      ${randomBox ? `<div class="grid">
        <div class="card"><div class="muted">min</div><div class="metric">${formatPercent(randomBox.min)}</div></div>
        <div class="card"><div class="muted">p50</div><div class="metric">${formatPercent(randomBox.p50)}</div></div>
        <div class="card"><div class="muted">max</div><div class="metric">${formatPercent(randomBox.max)}</div></div>
        <div class="card"><div class="muted">std</div><div class="metric">${randomBox.std.toFixed(4)}</div></div>
      </div>` : ""}
      <table>
        <thead><tr><th>seed</th><th>节点覆盖率</th><th>活动链路直接观测</th><th>活动链路有效覆盖</th><th>遥测字节</th><th>逐片覆盖标准差</th></tr></thead>
        <tbody>${randomTableRows}</tbody>
      </table>
    </section>

    <section>
      <h2>产物索引</h2>
      <table>
        <thead><tr><th>文件</th><th>说明</th></tr></thead>
        <tbody>
          <tr><td><code>${outputFiles.summaryCsv}</code></td><td>四类基线总体指标。</td></tr>
          <tr><td><code>${outputFiles.coverageCsv}</code></td><td>逐时间片覆盖率与遥测开销。</td></tr>
          <tr><td><code>${outputFiles.randomCsv}</code></td><td>随机采样各 seed 指标。</td></tr>
          <tr><td><code>${outputFiles.reportJson}</code></td><td>机器可读完整报告。</td></tr>
          <tr><td><code>${outputFiles.reportMd}</code></td><td>论文/文档友好的文字报告。</td></tr>
        </tbody>
      </table>
    </section>
  </main>
</body>
</html>`;
}

function buildMarkdownReport({ summary, primaryRows, randomRows, outputFiles }) {
  const lines = [
    "# 实验 2：原生 INT 基线对照实验",
    "",
    "## 实验目的",
    "",
    "本实验固定第一阶段卫星网络真值，只改变第二阶段 INT 遥测策略，用于建立后续 LEO-INT-MC 或改进方法的对照基线。",
    "",
    "## 基线方法",
    "",
    "- `traffic-int`：只沿业务流路径采集，低开销但覆盖依赖业务分布。",
    "- `full probe-int`：主动探测全网，高覆盖但高开销。",
    "- `shortest-path probe`：在相同候选集合中优先选择短路径，低代价但存在路径偏置。",
    "- `random sampling`：继承 shortest-path probe 的逐片路径链路数预算，随机选择 probe path，多 seed 评估覆盖效率和稳定性。",
    "",
    "## 指标定义",
    "",
    "```text",
    "NodeCoverage = observed_nodes / truth_nodes",
    "ActiveLinkCoverage = observed_active_links / truth_active_links",
    "TelemetryOverhead = metadata_bytes + report_bytes + probe_base_bytes",
    "RandomStability = Std(coverage over random seeds)",
    "```",
    "",
    "## 实验环境",
    "",
    `- 输入真值目录：\`${summary.input_dir}\``,
    `- 时间片：${summary.slice_count}`,
    `- 每片卫星节点数：${summary.node_count}`,
    `- 累计链路样本：${summary.link_sample_count}`,
    "",
    "## 总体结果",
    "",
    "| 方法 | 节点覆盖率 | 活动链路覆盖率 | 遥测字节 | 遥测能耗 J | Hop records |",
    "|---|---:|---:|---:|---:|---:|",
    ...primaryRows.map((row) =>
      `| ${row.method_label} | ${formatPercent(row.node_sample_coverage)} | ${formatPercent(row.active_link_sample_coverage)} | ${formatBytes(row.total_telemetry_generated_bytes)} | ${numberValue(row.total_telemetry_energy_j).toFixed(3)} | ${numberValue(row.hop_records).toLocaleString("en-US")} |`
    ),
    "",
    "## 随机采样 seed 结果",
    "",
    "| seed | 节点覆盖率 | 活动链路覆盖率 | 遥测字节 | 逐片覆盖标准差 |",
    "|---:|---:|---:|---:|---:|",
    ...randomRows.map((row) =>
      `| ${row.random_seed} | ${formatPercent(row.node_sample_coverage)} | ${formatPercent(row.active_link_sample_coverage)} | ${formatBytes(row.total_telemetry_generated_bytes)} | ${numberValue(row.per_slice_active_coverage_std).toFixed(4)} |`
    ),
    "",
    "## 结论读法",
    "",
    "1. 如果 `traffic-int` 开销明显低但覆盖率低，说明业务随路遥测不能保证全网感知。",
    "2. 如果 `full probe-int` 覆盖最高但字节和能耗最高，说明原生全量探测可以作为精度上界，但不适合长期高频运行。",
    "3. 如果 `shortest-path probe` 比随机更稳定但覆盖不足，说明单纯短路径存在结构性偏置。",
    "4. 如果 `random sampling` 在相近预算下覆盖率低于结构化路径选择，或 seed/时间片间波动更大，说明后续改进方法需要利用卫星拓扑、轨道预测和历史状态，而不是盲采样。",
    "",
    "## 输出文件",
    "",
    `- 总体指标：\`${outputFiles.summaryCsv}\``,
    `- 逐时间片指标：\`${outputFiles.coverageCsv}\``,
    `- 随机 seed 指标：\`${outputFiles.randomCsv}\``,
    `- HTML 可视化报告：\`${outputFiles.reportHtml}\``,
    `- JSON 完整报告：\`${outputFiles.reportJson}\``,
  ];
  return `${lines.join("\n")}\n`;
}

const args = process.argv.slice(2);
const inputDir = resolve(argValue(args, "--input", "reports/experiment1-satellite-data-authenticity/stage1-truth"));
const outputDir = resolve(argValue(args, "--out", "reports/experiment2-native-int-baselines"));
const targetActiveLinkCoverage = Math.max(0.01, Math.min(1, numberArg(args, "--target-active-link-coverage", 0.25)));
const randomSeeds = argValue(args, "--random-seeds", "11,23,37,51,73")
  .split(",")
  .map((item) => Number(item.trim()))
  .filter(Number.isFinite);
const downlinkBudgetBytes = String(Math.floor(numberArg(args, "--downlink-budget-bytes", 1_000_000_000_000)));
const includeIntMc = argValue(args, "--include-int-mc", "true").toLowerCase() !== "false";
const intMcSamplingRate = Math.max(0.01, Math.min(1, numberArg(args, "--int-mc-sampling-rate", targetActiveLinkCoverage)));
const intMcTargetActiveLinkSamplingRate = Math.max(
  0.01,
  Math.min(1, numberArg(args, "--int-mc-target-active-link-sampling-rate", intMcSamplingRate)),
);
const intMcRank = Math.max(1, Math.floor(numberArg(args, "--int-mc-rank", 5)));
const intMcWindowSize = Math.max(1, Math.floor(numberArg(args, "--int-mc-window-size", 12)));
const intMcWarmupSlices = Math.max(1, Math.floor(numberArg(args, "--int-mc-warmup-slices", 3)));
const intMcIterations = Math.max(1, Math.floor(numberArg(args, "--int-mc-iterations", 12)));
const intMcMaxPathsPerSlice = Math.max(1, Math.floor(numberArg(args, "--int-mc-max-paths-per-slice", 12)));
const candidateAlgorithm = "path-balance";

requireFile(join(inputDir, "nodes.csv"), "stage-one nodes.csv");
requireFile(join(inputDir, "links.csv"), "stage-one links.csv");
requireFile(join(inputDir, "routes.csv"), "stage-one routes.csv");

await mkdir(outputDir, { recursive: true });
const stage2Root = join(outputDir, "stage2");
const groundRoot = join(outputDir, "ground-oam");
await mkdir(stage2Root, { recursive: true });
await mkdir(groundRoot, { recursive: true });

const [truthNodes, truthLinks] = await Promise.all([
  readCsv(join(inputDir, "nodes.csv")),
  readCsv(join(inputDir, "links.csv")),
]);
const metadata = existsSync(join(inputDir, "metadata.json")) ? await readJson(join(inputDir, "metadata.json")) : {};
const sliceCount = unique(truthNodes.map((row) => String(row.slice_index))).length;
const nodeCount = unique(truthNodes.filter((row) => String(row.slice_index) === "0").map((row) => row.node_id)).length;

const baselineRows = [];
const perSliceRows = [];
const randomRows = [];
const commands = [];

async function runTrafficInt() {
  const methodId = "traffic-int";
  const methodLabel = "traffic-int";
  const stage2Dir = join(stage2Root, methodId);
  const groundDir = join(groundRoot, methodId);
  await mkdir(stage2Dir, { recursive: true });
  await mkdir(groundDir, { recursive: true });
  commands.push(`node stage2-int/tools/offline-int-mvp.mjs --input ${inputDir} --out ${stage2Dir}`);
  await runStep("traffic-int hop/report generation", "stage2-int/tools/offline-int-mvp.mjs", [
    "--input", inputDir,
    "--out", stage2Dir,
  ]);
  commands.push(`direct OAM evaluation --hops ${join(stage2Dir, "int-hop-records.csv")} --reports ${join(stage2Dir, "int-reports.csv")}`);
  await buildDirectOamEvaluation({
    inputDir,
    hopRecordsPath: join(stage2Dir, "int-hop-records.csv"),
    reportsPath: join(stage2Dir, "int-reports.csv"),
    groundDir,
    downlinkBudgetBytes,
  });
  const rows = await collectPerSliceMetrics({
    methodId,
    methodLabel,
    inputDir,
    groundDir,
    overheadPath: join(stage2Dir, "traffic-int-overhead-by-slice.csv"),
  });
  perSliceRows.push(...rows);
  const metrics = await collectBaselineMetrics({
    methodId,
    methodLabel,
    methodFamily: "traffic-int",
    evaluationPath: join(groundDir, "ground-oam-evaluation.json"),
    runReportPath: join(stage2Dir, "coverage-report.json"),
    perSliceRows: rows,
  });
  metrics.notes = "只沿业务流路径携带 INT metadata";
  baselineRows.push(metrics);
}

async function planFullCandidatePaths() {
  const fullDir = join(stage2Root, "full-probe-int");
  await mkdir(fullDir, { recursive: true });
  commands.push(`node stage2-int/tools/probe-path-planner.mjs --input ${inputDir} --out ${fullDir} --algorithm ${candidateAlgorithm}`);
  await runStep("full probe candidate planning", "stage2-int/tools/probe-path-planner.mjs", [
    "--input", inputDir,
    "--out", fullDir,
    "--algorithm", candidateAlgorithm,
  ]);
  return fullDir;
}

async function runProbeMethod({ methodId, methodLabel, methodFamily, stage2Dir, algorithm, seed = "" }) {
  const groundDir = join(groundRoot, methodId);
  await mkdir(groundDir, { recursive: true });
  commands.push(`node stage2-int/tools/reporting-path-planner.mjs --input ${inputDir} --stage2 ${stage2Dir} --out ${stage2Dir} --algorithm ${algorithm}`);
  await runStep(`${methodLabel} reporting path planning`, "stage2-int/tools/reporting-path-planner.mjs", [
    "--input", inputDir,
    "--stage2", stage2Dir,
    "--out", stage2Dir,
    "--algorithm", algorithm,
    "--probes", join(stage2Dir, `probe-paths-${algorithm}.csv`),
  ]);
  commands.push(`node stage2-int/tools/probe-int-runner.mjs --input ${inputDir} --stage2 ${stage2Dir} --out ${stage2Dir} --algorithm ${algorithm}`);
  await runStep(`${methodLabel} probe INT runner`, "stage2-int/tools/probe-int-runner.mjs", [
    "--input", inputDir,
    "--stage2", stage2Dir,
    "--out", stage2Dir,
    "--algorithm", algorithm,
  ]);
  commands.push(`direct OAM evaluation --hops ${join(stage2Dir, `probe-int-hop-records-${algorithm}.csv`)} --reports ${join(stage2Dir, `probe-int-reports-${algorithm}.csv`)}`);
  await buildDirectOamEvaluation({
    inputDir,
    hopRecordsPath: join(stage2Dir, `probe-int-hop-records-${algorithm}.csv`),
    reportsPath: join(stage2Dir, `probe-int-reports-${algorithm}.csv`),
    groundDir,
    downlinkBudgetBytes,
  });
  if (methodId === "full-probe-int") {
    await runStep("full probe coverage audit", "stage2-int/tools/audit-full-telemetry-coverage.mjs", [
      "--input", inputDir,
      "--ground", groundDir,
      "--out", groundDir,
    ], { allowFailure: true });
  }
  const rows = await collectPerSliceMetrics({
    methodId,
    methodLabel,
    inputDir,
    groundDir,
    overheadPath: join(stage2Dir, `probe-int-overhead-by-slice-${algorithm}.csv`),
  });
  perSliceRows.push(...rows);
  const metrics = await collectBaselineMetrics({
    methodId,
    methodLabel,
    methodFamily,
    seed,
    evaluationPath: join(groundDir, "ground-oam-evaluation.json"),
    runReportPath: join(stage2Dir, `probe-int-run-report-${algorithm}.json`),
    perSliceRows: rows,
  });
  baselineRows.push(metrics);
  if (methodFamily === "random-sampling") randomRows.push(metrics);
}

async function runIntMcMethod({ candidateDir }) {
  if (!includeIntMc) return;
  const methodId = "int-mc-selected-probe";
  const methodLabel = "INT-MC selected probe";
  const methodFamily = "int-mc-selected-probe";
  const algorithm = "int-mc";
  const stage2Dir = join(stage2Root, methodId);
  const groundDir = join(groundRoot, methodId);
  const predictedContactPlanPath = join(stage2Dir, "predicted-contact-plan.json");
  await mkdir(stage2Dir, { recursive: true });
  await mkdir(groundDir, { recursive: true });

  commands.push(`node stage2-int/tools/predict-contact-plan.mjs --input ${inputDir} --out ${stage2Dir}`);
  await runStep("INT-MC contact-plan prediction", "stage2-int/tools/predict-contact-plan.mjs", [
    "--input", inputDir,
    "--out", stage2Dir,
    "--completion-window-slices", String(intMcWindowSize),
  ]);

  commands.push(`node stage2-int/tools/int-mc-path-selector.mjs --input ${inputDir} --stage2 ${stage2Dir} --algorithm ${algorithm}`);
  await runStep("INT-MC selected probe planning", "stage2-int/tools/int-mc-path-selector.mjs", [
    "--input", inputDir,
    "--stage2", stage2Dir,
    "--out", stage2Dir,
    "--algorithm", algorithm,
    "--candidate-algorithm", candidateAlgorithm,
    "--candidate-paths", join(candidateDir, `probe-paths-${candidateAlgorithm}.csv`),
    "--sampling-rate", String(intMcSamplingRate),
    "--target-active-link-sampling-rate", String(intMcTargetActiveLinkSamplingRate),
    "--rank", String(intMcRank),
    "--selection-strategy", "int-mc-leverage",
    "--window-size", String(intMcWindowSize),
    "--warmup-slices", String(intMcWarmupSlices),
    "--max-paths-per-slice", String(intMcMaxPathsPerSlice),
    "--predicted-contact-plan", predictedContactPlanPath,
  ]);

  commands.push(`node stage2-int/tools/reporting-path-planner.mjs --input ${inputDir} --stage2 ${stage2Dir} --algorithm ${algorithm}`);
  await runStep("INT-MC reporting path planning", "stage2-int/tools/reporting-path-planner.mjs", [
    "--input", inputDir,
    "--stage2", stage2Dir,
    "--out", stage2Dir,
    "--algorithm", algorithm,
    "--probes", join(stage2Dir, `probe-paths-${algorithm}.csv`),
  ]);

  commands.push(`node stage2-int/tools/probe-int-runner.mjs --input ${inputDir} --stage2 ${stage2Dir} --algorithm ${algorithm}`);
  await runStep("INT-MC probe INT runner", "stage2-int/tools/probe-int-runner.mjs", [
    "--input", inputDir,
    "--stage2", stage2Dir,
    "--out", stage2Dir,
    "--algorithm", algorithm,
  ]);

  await buildDirectOamEvaluation({
    inputDir,
    hopRecordsPath: join(stage2Dir, `probe-int-hop-records-${algorithm}.csv`),
    reportsPath: join(stage2Dir, `probe-int-reports-${algorithm}.csv`),
    groundDir,
    downlinkBudgetBytes,
  });

  commands.push(`node stage2-int/tools/int-mc-reconstructor.mjs --input ${inputDir} --stage2 ${stage2Dir} --ground ${groundDir}`);
  await runStep("INT-MC Ground OAM matrix completion", "stage2-int/tools/int-mc-reconstructor.mjs", [
    "--input", inputDir,
    "--stage2", stage2Dir,
    "--ground", groundDir,
    "--out", groundDir,
    "--algorithm", algorithm,
    "--rank", String(intMcRank),
    "--window-size", String(intMcWindowSize),
    "--iterations", String(intMcIterations),
    "--predicted-contact-plan", predictedContactPlanPath,
  ]);

  const rows = await collectIntMcPerSliceMetrics({
    methodId,
    methodLabel,
    inputDir,
    groundDir,
    overheadPath: join(stage2Dir, `probe-int-overhead-by-slice-${algorithm}.csv`),
  });
  perSliceRows.push(...rows);
  const metrics = await collectIntMcBaselineMetrics({
    methodId,
    methodLabel,
    methodFamily,
    evaluationPath: join(groundDir, "int-mc-evaluation.json"),
    selectorReportPath: join(stage2Dir, `probe-coverage-${algorithm}.json`),
    runReportPath: join(stage2Dir, `probe-int-run-report-${algorithm}.json`),
    perSliceRows: rows,
  });
  baselineRows.push(metrics);
}

await runTrafficInt();
const fullDir = await planFullCandidatePaths();
await runProbeMethod({
  methodId: "full-probe-int",
  methodLabel: "full probe-int",
  methodFamily: "full-probe-int",
  stage2Dir: fullDir,
  algorithm: candidateAlgorithm,
});
baselineRows.find((row) => row.method_id === "full-probe-int").notes = "主动探测全网，覆盖上界";
await runIntMcMethod({ candidateDir: fullDir });

const candidatePaths = await readCsv(join(fullDir, `probe-paths-${candidateAlgorithm}.csv`));
const shortestSelection = await selectProbeSubset({
  candidatePaths,
  links: truthLinks,
  algorithm: "shortest-path-probe",
  strategy: "shortest-path",
  targetActiveLinkCoverage,
  outputDir: fullDir,
});
const shortestPathLinkBudgetBySlice = new Map(
  shortestSelection.summaryRows.map((row) => [String(row.slice_index), numberValue(row.selected_path_links)]),
);
await runProbeMethod({
  methodId: "shortest-path-probe",
  methodLabel: "shortest-path probe",
  methodFamily: "shortest-path-probe",
  stage2Dir: fullDir,
  algorithm: "shortest-path-probe",
});
baselineRows.find((row) => row.method_id === "shortest-path-probe").notes =
  `目标活动链路采样率 ${formatPercent(targetActiveLinkCoverage)}`;

for (const seed of randomSeeds) {
  const methodId = `random-sampling-seed-${seed}`;
  const algorithm = `random-sampling-seed-${seed}`;
  await selectProbeSubset({
    candidatePaths,
    links: truthLinks,
    algorithm,
    strategy: "random-sampling",
    targetActiveLinkCoverage,
    pathLinkBudgetBySlice: shortestPathLinkBudgetBySlice,
    seed,
    outputDir: fullDir,
  });
  await runProbeMethod({
    methodId,
    methodLabel: `random seed ${seed}`,
    methodFamily: "random-sampling",
    stage2Dir: fullDir,
    algorithm,
    seed,
  });
  baselineRows.find((row) => row.method_id === methodId).notes = `随机采样 seed=${seed}`;
}

const randomAggregate = aggregateRandomRows(randomRows);
const randomAggregatePerSliceRows = aggregateRandomPerSliceRows(perSliceRows);
perSliceRows.push(...randomAggregatePerSliceRows);
const primaryRows = [
  baselineRows.find((row) => row.method_id === "traffic-int"),
  baselineRows.find((row) => row.method_id === "full-probe-int"),
  baselineRows.find((row) => row.method_id === "shortest-path-probe"),
  randomAggregate,
  baselineRows.find((row) => row.method_id === "int-mc-selected-probe"),
].filter(Boolean);

const summary = {
  schema_version: "experiment2-native-int-baselines-v1",
  generated_at: new Date().toISOString(),
  objective: "Build native INT baselines for dynamic LEO network telemetry: traffic-int, full probe-int, shortest-path probe, random sampling and INT-MC selected probe.",
  input_dir: inputDir,
  output_dir: outputDir,
  target_active_link_coverage: targetActiveLinkCoverage,
  int_mc_max_paths_per_slice: intMcMaxPathsPerSlice,
  random_seeds: randomSeeds,
  downlink_budget_bytes: Number(downlinkBudgetBytes),
  stage1_metadata: metadata,
  slice_count: sliceCount,
  node_count: nodeCount,
  link_sample_count: truthLinks.length,
  active_link_sample_count: truthLinks.filter((row) => boolValue(row.is_active)).length,
  baseline_summary: primaryRows,
  random_seed_summary: randomRows,
  commands,
  interpretation: {
    traffic_int: "Low overhead, but coverage follows business path distribution.",
    full_probe_int: "High coverage upper bound with high telemetry overhead.",
    shortest_path_probe: "Lower-cost active probing baseline with path-bias risk.",
    random_sampling: "Weak baseline; stability must be judged by multi-seed variance.",
    int_mc_selected_probe: "Information-aware active probing plus matrix completion; the process reports both direct observation and reconstructed effective coverage.",
  },
};

const outputFiles = {
  summaryCsv: join(outputDir, "experiment2-baseline-summary.csv"),
  coverageCsv: join(outputDir, "experiment2-coverage-by-slice.csv"),
  randomCsv: join(outputDir, "experiment2-random-seed-summary.csv"),
  reportJson: join(outputDir, "experiment2-native-int-baselines-report.json"),
  reportMd: join(outputDir, "experiment2-native-int-baselines-report.md"),
  reportHtml: join(outputDir, "experiment2-native-int-baselines-report.html"),
};

await Promise.all([
  writeFile(outputFiles.summaryCsv, rowsToCsv(primaryRows), "utf8"),
  writeFile(outputFiles.coverageCsv, rowsToCsv(perSliceRows), "utf8"),
  writeFile(outputFiles.randomCsv, rowsToCsv(randomRows), "utf8"),
  writeFile(outputFiles.reportJson, JSON.stringify({ ...summary, outputs: outputFiles, per_slice: perSliceRows }, null, 2), "utf8"),
  writeFile(outputFiles.reportMd, buildMarkdownReport({ summary, primaryRows, randomRows, outputFiles }), "utf8"),
  writeFile(outputFiles.reportHtml, buildHtmlReport({ summary, primaryRows, randomRows, perSliceRows, outputFiles }), "utf8"),
]);

console.log(JSON.stringify({
  ok: true,
  outputDir,
  reportHtml: outputFiles.reportHtml,
  reportMd: outputFiles.reportMd,
  reportJson: outputFiles.reportJson,
  summaryCsv: outputFiles.summaryCsv,
  coverageCsv: outputFiles.coverageCsv,
  randomCsv: outputFiles.randomCsv,
  baselines: primaryRows.map((row) => ({
    method: row.method_label,
    nodeCoverage: row.node_sample_coverage,
    activeLinkDirectCoverage: row.active_link_direct_coverage ?? row.active_link_sample_coverage,
    activeLinkEffectiveCoverage: row.active_link_effective_coverage ?? row.active_link_sample_coverage,
    intMcInferredRateOnActive: row.int_mc_inferred_rate_on_active,
    telemetryBytes: row.total_telemetry_generated_bytes,
    telemetryEnergyJ: row.total_telemetry_energy_j,
  })),
}, null, 2));
