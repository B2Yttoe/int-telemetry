import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";

function argValue(args, name, fallback = "") {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  return args[index + 1] ?? fallback;
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

function numberValue(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolValue(value) {
  return String(value).toLowerCase() === "true";
}

function mean(values) {
  if (values.length === 0) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function round(value, digits = 4) {
  return Number(value.toFixed(digits));
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

function uniqueLatestBy(rows, keyFn) {
  const map = new Map();
  rows.forEach((row) => {
    const key = keyFn(row);
    const old = map.get(key);
    if (!old || numberValue(row.hop_index) >= numberValue(old.hop_index)) map.set(key, row);
  });
  return [...map.values()];
}

async function readCsv(path) {
  return parseCsv(await readFile(path, "utf8"));
}

function requireFile(path, label) {
  if (!existsSync(path)) throw new Error(`${label} not found: ${path}`);
}

function deliverReports(reports, perSliceBudgetBytes, carryOver) {
  const bySlice = groupBy(reports, (report) => report.slice_index);
  const sliceIndexes = [...bySlice.keys()].sort((a, b) => Number(a) - Number(b));
  const delivered = [];
  const queued = [];
  let queue = [];

  sliceIndexes.forEach((sliceIndex) => {
    const generated = bySlice.get(sliceIndex) ?? [];
    queue = carryOver ? [...queue, ...generated] : [...generated];
    let budget = perSliceBudgetBytes;
    const nextQueue = [];

    queue.forEach((report) => {
      const size = numberValue(report.report_size_bytes);
      if (size <= budget) {
        budget -= size;
        delivered.push({
          ...report,
          ground_status: "downlinked",
          downlinked_slice: sliceIndex,
          delivery_delay_slices: Number(sliceIndex) - numberValue(report.slice_index),
        });
      } else {
        nextQueue.push({
          ...report,
          ground_status: carryOver ? "queued" : "dropped",
          downlinked_slice: "",
          delivery_delay_slices: "",
          drop_reason: carryOver ? "" : "slice-budget-exhausted",
        });
      }
    });

    if (!carryOver) {
      queued.push(...nextQueue);
      queue = [];
    } else {
      queue = nextQueue;
    }
  });

  if (carryOver && queue.length > 0) {
    queued.push(...queue.map((report) => ({
      ...report,
      ground_status: "queued",
      downlinked_slice: "",
      delivery_delay_slices: "",
      drop_reason: "",
    })));
  }

  return { delivered, queued };
}

function splitTransmittableReports(reports) {
  const transmittable = [];
  const preDropped = [];
  reports.forEach((report) => {
    const status = String(report.status || "generated").toLowerCase();
    const reportingStatus = String(report.reporting_status || "planned").toLowerCase();
    if (status === "dropped" || reportingStatus === "blocked") {
      preDropped.push({
        ...report,
        ground_status: "dropped",
        downlinked_slice: "",
        delivery_delay_slices: "",
        drop_reason: report.drop_reason || "not-transmittable",
      });
    } else {
      transmittable.push(report);
    }
  });
  return { transmittable, preDropped };
}

function reconstructNodes(deliveredHopRecords, truthNodes) {
  const observed = uniqueLatestBy(deliveredHopRecords, (record) => `${record.slice_index}|${record.node_id}`);
  const observedMap = indexBy(observed, (record) => `${record.slice_index}|${record.node_id}`);
  return truthNodes.map((truth) => {
    const record = observedMap.get(`${truth.slice_index}|${truth.node_id}`);
    if (!record) {
      return {
        slice_index: truth.slice_index,
        node_id: truth.node_id,
        observed: false,
        last_observed_slice: "",
        mode_estimate: "unknown",
        cpu_percent_estimate: "",
        queue_depth_estimate: "",
        queued_traffic_mb_estimate: "",
        cache_used_mb_estimate: "",
        energy_percent_estimate: "",
        confidence: 0,
      };
    }
    return {
      slice_index: record.slice_index,
      node_id: record.node_id,
      observed: true,
      last_observed_slice: record.slice_index,
      mode_estimate: record.observed_node_mode,
      cpu_percent_estimate: record.observed_cpu_percent,
      queue_depth_estimate: record.observed_queue_depth,
      queued_traffic_mb_estimate: record.observed_queued_traffic_mb,
      cache_used_mb_estimate: record.observed_cache_used_mb,
      energy_percent_estimate: record.observed_energy_percent,
      confidence: 1,
    };
  });
}

function reconstructLinks(deliveredHopRecords, truthLinks) {
  const observedRecords = deliveredHopRecords.filter((record) => record.observed_link_id);
  const observed = uniqueLatestBy(observedRecords, (record) => `${record.slice_index}|${record.observed_link_id}`);
  const observedMap = indexBy(observed, (record) => `${record.slice_index}|${record.observed_link_id}`);
  return truthLinks.map((truth) => {
    const record = observedMap.get(`${truth.slice_index}|${truth.link_id}`);
    if (!record) {
      return {
        slice_index: truth.slice_index,
        link_id: truth.link_id,
        observed: false,
        last_observed_slice: "",
        status_estimate: "unknown",
        active_estimate: "unknown",
        utilization_percent_estimate: "",
        latency_ms_estimate: "",
        capacity_mbps_estimate: "",
        congestion_percent_estimate: "",
        confidence: 0,
      };
    }
    return {
      slice_index: record.slice_index,
      link_id: record.observed_link_id,
      observed: true,
      last_observed_slice: record.slice_index,
      status_estimate: record.observed_link_status,
      active_estimate: record.observed_link_active,
      utilization_percent_estimate: record.observed_link_utilization_percent,
      latency_ms_estimate: record.observed_link_latency_ms,
      capacity_mbps_estimate: record.observed_link_capacity_mbps,
      congestion_percent_estimate: record.observed_link_congestion_percent,
      confidence: 1,
    };
  });
}

function evaluateNodes(reconstructedNodes, truthNodes) {
  const truthByKey = indexBy(truthNodes, (node) => `${node.slice_index}|${node.node_id}`);
  const observed = reconstructedNodes.filter((node) => String(node.observed) === "true");
  const cpuErrors = [];
  const queueErrors = [];
  const energyErrors = [];
  let modeMatches = 0;

  observed.forEach((node) => {
    const truth = truthByKey.get(`${node.slice_index}|${node.node_id}`);
    if (!truth) return;
    cpuErrors.push(Math.abs(numberValue(node.cpu_percent_estimate) - numberValue(truth.cpu_percent)));
    queueErrors.push(Math.abs(numberValue(node.queue_depth_estimate) - numberValue(truth.queue_depth)));
    energyErrors.push(Math.abs(numberValue(node.energy_percent_estimate) - numberValue(truth.energy_percent)));
    if (node.mode_estimate === truth.mode) modeMatches += 1;
  });

  return {
    truth_node_samples: truthNodes.length,
    observed_node_samples: observed.length,
    node_sample_coverage: round(observed.length / Math.max(truthNodes.length, 1)),
    unknown_node_samples: truthNodes.length - observed.length,
    cpu_mae: round(mean(cpuErrors)),
    queue_depth_mae: round(mean(queueErrors)),
    energy_percent_mae: round(mean(energyErrors)),
    mode_accuracy: round(modeMatches / Math.max(observed.length, 1)),
  };
}

function evaluateLinks(reconstructedLinks, truthLinks) {
  const truthActiveLinks = truthLinks.filter((link) => boolValue(link.is_active));
  const truthAllByKey = indexBy(truthLinks, (link) => `${link.slice_index}|${link.link_id}`);
  const truthByKey = indexBy(truthActiveLinks, (link) => `${link.slice_index}|${link.link_id}`);
  const observed = reconstructedLinks.filter((link) => String(link.observed) === "true");
  const observedActive = observed.filter((link) => {
    const truth = truthByKey.get(`${link.slice_index}|${link.link_id}`);
    return Boolean(truth);
  });
  const utilizationErrors = [];
  const latencyErrors = [];
  const capacityErrors = [];
  let statusMatches = 0;
  let trueCongested = 0;
  let observedCongested = 0;
  let truePositiveCongested = 0;

  observed.forEach((link) => {
    const truth = truthAllByKey.get(`${link.slice_index}|${link.link_id}`);
    if (!truth) return;
    utilizationErrors.push(Math.abs(numberValue(link.utilization_percent_estimate) - numberValue(truth.utilization_percent)));
    latencyErrors.push(Math.abs(numberValue(link.latency_ms_estimate) - numberValue(truth.latency_ms)));
    capacityErrors.push(Math.abs(numberValue(link.capacity_mbps_estimate) - numberValue(truth.effective_capacity_mbps || truth.capacity_mbps)));
    if (link.status_estimate === truth.status) statusMatches += 1;
    const truthCongested = numberValue(truth.congestion_percent) > 0;
    const estimateCongested = numberValue(link.congestion_percent_estimate) > 0;
    if (truthCongested) trueCongested += 1;
    if (estimateCongested) observedCongested += 1;
    if (truthCongested && estimateCongested) truePositiveCongested += 1;
  });

  const totalTruthCongested = truthActiveLinks.filter((link) => numberValue(link.congestion_percent) > 0).length;

  return {
    truth_link_samples: truthLinks.length,
    observed_link_samples: observed.length,
    link_sample_coverage: round(observed.length / Math.max(truthLinks.length, 1)),
    unknown_link_samples: truthLinks.length - observed.length,
    truth_active_link_samples: truthActiveLinks.length,
    observed_active_link_samples: observedActive.length,
    active_link_sample_coverage: round(observedActive.length / Math.max(truthActiveLinks.length, 1)),
    unknown_active_link_samples: truthActiveLinks.length - observedActive.length,
    utilization_mae: round(mean(utilizationErrors)),
    latency_mae_ms: round(mean(latencyErrors)),
    capacity_mae_mbps: round(mean(capacityErrors)),
    status_accuracy: round(statusMatches / Math.max(observed.length, 1)),
    observed_congested_links: observedCongested,
    truth_congested_links_seen_by_int: trueCongested,
    truth_congested_links_total: totalTruthCongested,
    congestion_precision: round(truePositiveCongested / Math.max(observedCongested, 1)),
    congestion_recall_over_observed_scope: round(truePositiveCongested / Math.max(trueCongested, 1)),
    congestion_recall_over_global_truth: round(truePositiveCongested / Math.max(totalTruthCongested, 1)),
  };
}

const args = process.argv.slice(2);
const inputDir = resolve(argValue(args, "--input", "exports/tmp-highload-check"));
const stage2Dir = resolve(argValue(args, "--stage2", `stage2-int/outputs/${basename(inputDir)}`));
const outputDir = resolve(argValue(args, "--out", stage2Dir));
const nodesPath = resolve(argValue(args, "--nodes", join(inputDir, "nodes.csv")));
const linksPath = resolve(argValue(args, "--links", join(inputDir, "links.csv")));
const hopRecordsPath = resolve(argValue(args, "--hops", join(stage2Dir, "int-hop-records.csv")));
const reportsPath = resolve(argValue(args, "--reports", join(stage2Dir, "int-reports.csv")));
const budgetBytes = numberValue(argValue(args, "--downlink-budget-bytes", "65536"), 65536);
const carryOver = argValue(args, "--carry-over", "true").toLowerCase() !== "false";

requireFile(nodesPath, "nodes.csv");
requireFile(linksPath, "links.csv");
requireFile(hopRecordsPath, "int-hop-records.csv");
requireFile(reportsPath, "int-reports.csv");

const [truthNodes, truthLinks, hopRecords, reports] = await Promise.all([
  readCsv(nodesPath),
  readCsv(linksPath),
  readCsv(hopRecordsPath),
  readCsv(reportsPath),
]);

const { transmittable, preDropped } = splitTransmittableReports(reports);
const { delivered, queued } = deliverReports(transmittable, budgetBytes, carryOver);
const undelivered = [...queued, ...preDropped];
const deliveredPacketIds = new Set(delivered.map((report) => report.packet_id));
const deliveredHopRecords = hopRecords.filter((record) => deliveredPacketIds.has(record.packet_id));
const reconstructedNodes = reconstructNodes(deliveredHopRecords, truthNodes);
const reconstructedLinks = reconstructLinks(deliveredHopRecords, truthLinks);
const nodeMetrics = evaluateNodes(reconstructedNodes, truthNodes);
const linkMetrics = evaluateLinks(reconstructedLinks, truthLinks);

const reportMetrics = {
  schema_version: "stage2-ground-oam-evaluation-v1",
  generated_at: new Date().toISOString(),
  source: {
    input_dir: inputDir,
    stage2_dir: stage2Dir,
    nodes_csv: nodesPath,
    links_csv: linksPath,
    int_hop_records_csv: hopRecordsPath,
    int_reports_csv: reportsPath,
  },
  boundary: {
    runtime_uses_only_delivered_int_reports: true,
    truth_used_only_for_evaluation: true,
    unknown_not_filled_from_truth: true,
  },
  downlink_model: {
    per_slice_budget_bytes: budgetBytes,
    carry_over_enabled: carryOver,
    generated_reports: reports.length,
    transmittable_reports: transmittable.length,
    delivered_reports: delivered.length,
    queued_or_dropped_reports: undelivered.length,
    delivered_hop_records: deliveredHopRecords.length,
    delivery_ratio: round(delivered.length / Math.max(reports.length, 1)),
    mean_delivery_delay_slices: round(mean(delivered.map((report) => numberValue(report.delivery_delay_slices)))),
  },
  node_reconstruction: nodeMetrics,
  link_reconstruction: linkMetrics,
};

await mkdir(outputDir, { recursive: true });
await Promise.all([
  writeFile(join(outputDir, "ground-delivered-reports.csv"), rowsToCsv(delivered), "utf8"),
  writeFile(join(outputDir, "ground-undelivered-reports.csv"), rowsToCsv(undelivered), "utf8"),
  writeFile(join(outputDir, "ground-reconstructed-nodes.csv"), rowsToCsv(reconstructedNodes), "utf8"),
  writeFile(join(outputDir, "ground-reconstructed-links.csv"), rowsToCsv(reconstructedLinks), "utf8"),
  writeFile(join(outputDir, "ground-oam-evaluation.json"), JSON.stringify(reportMetrics, null, 2), "utf8"),
]);

console.log(JSON.stringify({
  ok: true,
  outputDir,
  generatedReports: reports.length,
  deliveredReports: delivered.length,
  deliveredHopRecords: deliveredHopRecords.length,
  nodeSampleCoverage: nodeMetrics.node_sample_coverage,
  linkSampleCoverage: linkMetrics.link_sample_coverage,
  activeLinkSampleCoverage: linkMetrics.active_link_sample_coverage,
  cpuMae: nodeMetrics.cpu_mae,
  linkUtilizationMae: linkMetrics.utilization_mae,
  congestionRecallGlobal: linkMetrics.congestion_recall_over_global_truth,
}, null, 2));
