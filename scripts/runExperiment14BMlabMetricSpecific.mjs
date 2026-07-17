import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sampleRemoteZipCsv } from "./experiments/remoteZipCsvSampler.mjs";
import {
  applyUserPerformanceCalibration,
  buildServerLocationIndex,
  buildUserPerformanceContexts,
  fitUserPerformanceCalibration,
  loadUserPerformanceTopology,
  performanceRowsForCsv,
  scoreUserPerformance,
} from "./experiments/userPerformanceLayer.mjs";
import { readCsvStream } from "../stage2-int/tools/csv-stream.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUTPUT = resolve(ROOT, "reports/experiment14b-prospective-external-validation/mlab-metric-specific");
const SELECTED_FIELDS = [
  "uuid", "test_time", "data_source", "client_city", "client_country_code",
  "server_city", "server_country_code", "packet_loss_rate", "download_throughput_mbps",
  "download_latency_ms", "download_jitter_ms", "lat", "lon", "sat_density",
  "client_server_distance_km",
];

function argValue(args, name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
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
  const content = [headers.join(","), ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(","))].join("\n");
  await writeFile(path, `${content}\n`, "utf8");
}

async function metadata(path) {
  const absolutePath = resolve(path);
  const bytes = await readFile(absolutePath);
  return {
    path: relative(ROOT, absolutePath).replaceAll("\\", "/"),
    bytes: bytes.length,
    sha256: sha256(bytes),
  };
}

async function freezeOrVerify(protocolPath, outputDirectory) {
  const manifestPath = join(outputDirectory, "amendment-freeze-manifest.json");
  const sidecarPath = join(outputDirectory, "amendment-freeze-manifest.sha256");
  if (await exists(manifestPath)) {
    const manifest = await readJson(manifestPath);
    const expected = (await readFile(sidecarPath, "utf8")).trim();
    if (expected !== sha256(JSON.stringify(manifest))) throw new Error("Metric-specific amendment freeze manifest changed");
    const mismatches = [];
    for (const file of manifest.files) {
      const current = await metadata(resolve(ROOT, file.path));
      if (current.sha256 !== file.sha256 || current.bytes !== file.bytes) mismatches.push(file.path);
    }
    if (mismatches.length) throw new Error(`Metric-specific amendment frozen files changed: ${mismatches.join(", ")}`);
    return manifest;
  }
  const parentFreezePath = resolve(ROOT, "reports/experiment14b-prospective-external-validation/freeze-manifest.json");
  const parentFreeze = await readJson(parentFreezePath);
  const relevant = [
    protocolPath,
    resolve(ROOT, "scripts/runExperiment14BMlabMetricSpecific.mjs"),
    resolve(ROOT, "scripts/experiments/remoteZipCsvSampler.mjs"),
    resolve(ROOT, "scripts/experiments/userPerformanceLayer.mjs"),
    resolve(ROOT, "stage2-int/tools/csv-stream.mjs"),
  ];
  const manifest = {
    schema: "int-telemetry-experiment14b-metric-specific-freeze/v1",
    frozen_at: new Date().toISOString(),
    acquisition_state_at_freeze: "latency monthly member values not acquired",
    engineering_dry_run_seen_before_freeze: true,
    dry_run_triggered_change: "external RTT member selection only",
    model_or_parameter_change_after_dry_run: false,
    parent_freeze: {
      frozen_at: parentFreeze.frozen_at,
      protocol_sha256: parentFreeze.hashes.protocol_sha256,
      aggregate_code_and_config_sha256: parentFreeze.hashes.aggregate_code_and_config_sha256,
    },
    files: await Promise.all(relevant.map(metadata)),
  };
  await mkdir(outputDirectory, { recursive: true });
  await writeJson(manifestPath, manifest);
  await writeFile(sidecarPath, `${sha256(JSON.stringify(manifest))}\n`, "utf8");
  await writeFile(join(outputDirectory, "frozen-amendment-protocol.json"), await readFile(protocolPath));
  return manifest;
}

function validRow(row, sourceFilter) {
  return row.data_source === sourceFilter &&
    Number.isFinite(new Date(row.test_time).getTime()) &&
    Number.isFinite(Number(row.download_latency_ms)) &&
    Number.isFinite(Number(row.download_throughput_mbps)) &&
    Number.isFinite(Number(row.lat)) && Number.isFinite(Number(row.lon));
}

async function collectLatencySplit(protocol, outputDirectory) {
  const metadataPath = join(outputDirectory, "latency-split-metadata.json");
  const trainingPath = join(outputDirectory, "latency-training-october-2025.csv");
  const testPath = join(outputDirectory, "latency-blind-test-november-2025.csv");
  if (await exists(metadataPath) && await exists(trainingPath) && await exists(testPath)) return readJson(metadataPath);
  const source = protocol.dataset;
  const training = await sampleRemoteZipCsv({
    url: source.url,
    member: source.latency_training_member,
    maximumRows: source.maximum_training_samples,
    seed: source.training_seed,
    selectedFields: SELECTED_FIELDS,
    filter: (row) => validRow(row, source.source_filter),
  });
  const excluded = new Set(source.excluded_test_dates_due_to_prior_repository_exposure ?? []);
  const test = await sampleRemoteZipCsv({
    url: source.url,
    member: source.latency_test_member,
    maximumRows: source.maximum_test_samples,
    seed: source.test_seed,
    selectedFields: SELECTED_FIELDS,
    filter: (row) => validRow(row, source.source_filter) && !excluded.has(String(row.test_time).slice(0, 10)),
  });
  const trainingIds = new Set(training.rows.map((row) => row.uuid));
  const overlap = test.rows.filter((row) => trainingIds.has(row.uuid)).length;
  if (overlap) throw new Error(`Latency train/test UUID overlap: ${overlap}`);
  await writeCsv(trainingPath, training.rows);
  await writeCsv(testPath, test.rows);
  const result = {
    schema: "int-telemetry-experiment14b-latency-split/v1",
    status: "complete",
    acquired_at: new Date().toISOString(),
    dataset_doi: source.doi,
    dataset_url: source.url,
    license: source.license,
    training: training.metadata,
    test: test.metadata,
    excluded_test_dates_due_to_prior_repository_exposure: [...excluded],
    train_test_uuid_overlap: overlap,
    test_target_values_used_for_fit: 0,
    training_csv: "latency-training-october-2025.csv",
    test_csv: "latency-blind-test-november-2025.csv",
  };
  await writeJson(metadataPath, result);
  return result;
}

function mergedCalibration(latencyCalibration, throughputCalibration) {
  return {
    schema: "int-telemetry-user-performance-metric-specific-calibration/v1",
    fitted_parameters: {
      rtt_access_and_transport_offset_ms: latencyCalibration.fitted_parameters.rtt_access_and_transport_offset_ms,
      scheduler_and_transport_share: throughputCalibration.fitted_parameters.scheduler_and_transport_share,
      satellite_density_reference: throughputCalibration.fitted_parameters.satellite_density_reference,
    },
    intervals: {
      coverage: latencyCalibration.intervals.coverage,
      rtt_absolute_residual_radius_ms: latencyCalibration.intervals.rtt_absolute_residual_radius_ms,
      throughput_absolute_residual_radius_mbps: throughputCalibration.intervals.throughput_absolute_residual_radius_mbps,
    },
    audit: {
      latency: latencyCalibration.audit,
      throughput: throughputCalibration.audit,
      test_rows_used_for_fit: 0,
      test_rows_used_for_interval_calibration: 0,
      free_fitted_parameter_count: 2,
      parameter_definitions_changed_after_dry_run: false,
    },
  };
}

async function scoreMetricSpecific(protocol, outputDirectory) {
  const parentDirectory = resolve(ROOT, "reports/experiment14b-prospective-external-validation");
  const topologyMetadataPath = join(parentDirectory, "topology", "metadata.json");
  if (!(await exists(topologyMetadataPath))) {
    return { evidence_status: "pending-parent-fresh-topology", detail: "Wait for the frozen parent experiment to pass its fresh-orbit gate." };
  }
  const topologyMetadata = await readJson(topologyMetadataPath);
  if (topologyMetadata.status !== "complete") return { evidence_status: "pending-parent-fresh-topology" };
  const topology = await loadUserPerformanceTopology(
    join(parentDirectory, "topology", "nodes.csv"),
    join(parentDirectory, "topology", "links.csv"),
  );
  const latencyTraining = await readCsvStream(join(outputDirectory, "latency-training-october-2025.csv"));
  const latencyTest = await readCsvStream(join(outputDirectory, "latency-blind-test-november-2025.csv"));
  const throughputTraining = await readCsvStream(join(parentDirectory, "mlab", "training-october-2025.csv"));
  const throughputTest = await readCsvStream(join(parentDirectory, "mlab", "blind-test-november-2025-excluding-prior-date.csv"));
  const locationIndex = buildServerLocationIndex([...latencyTraining, ...throughputTraining]);
  const config = (await readJson(resolve(ROOT, "scripts/experiments/experiment14b-protocol.json"))).user_performance;

  const latencyTrainingContexts = buildUserPerformanceContexts(topology, latencyTraining, config, locationIndex);
  const throughputTrainingContexts = buildUserPerformanceContexts(topology, throughputTraining, config, locationIndex);
  const latencyCalibration = fitUserPerformanceCalibration(latencyTrainingContexts, config);
  const throughputCalibration = fitUserPerformanceCalibration(throughputTrainingContexts, config);
  const calibration = mergedCalibration(latencyCalibration, throughputCalibration);
  const latencyPredictions = applyUserPerformanceCalibration(
    buildUserPerformanceContexts(topology, latencyTest, config, locationIndex), calibration,
  );
  const throughputPredictions = applyUserPerformanceCalibration(
    buildUserPerformanceContexts(topology, throughputTest, config, locationIndex), calibration,
  );
  const latencyScore = scoreUserPerformance(latencyPredictions);
  const throughputScore = scoreUserPerformance(throughputPredictions);
  const result = {
    schema: "int-telemetry-experiment14b-metric-specific-result/v1",
    evidence_status: "metric-specific-blind-validation-complete",
    generated_at: new Date().toISOString(),
    topology: topologyMetadata,
    calibration,
    rtt: latencyScore.rtt,
    throughput: throughputScore.throughput,
    pairing: {
      rtt: latencyScore.pairing,
      throughput: throughputScore.pairing,
      exact_historical_path_claim_allowed: false,
    },
    sample_counts: {
      latency_test: latencyScore.valid_paired_samples,
      throughput_test: throughputScore.valid_paired_samples,
    },
    claim_boundary: protocol.claim_boundary,
  };
  await writeJson(join(outputDirectory, "metric-specific-calibration.json"), calibration);
  await writeJson(join(outputDirectory, "metric-specific-result.json"), result);
  await writeCsv(join(outputDirectory, "latency-blind-predictions.csv"), performanceRowsForCsv(latencyPredictions));
  await writeCsv(join(outputDirectory, "throughput-blind-predictions.csv"), performanceRowsForCsv(throughputPredictions));
  const report = `# 实验 14B：M-Lab 分指标同口径补充验证\n\n` +
    `- 证据状态：\`${result.evidence_status}\`\n` +
    `- RTT 测试样本：${result.sample_counts.latency_test}\n` +
    `- 吞吐测试样本：${result.sample_counts.throughput_test}\n` +
    `- RTT MAE：${result.rtt.mae} ms，P50 比：${result.rtt.p50_ratio_model_to_external}，P95 比：${result.rtt.p95_ratio_model_to_external}\n` +
    `- 吞吐 MAE：${result.throughput.mae} Mbps，P50 比：${result.throughput.p50_ratio_model_to_external}，P95 比：${result.throughput.p95_ratio_model_to_external}\n\n` +
    `## 解释边界\n\n${protocol.claim_boundary}\n`;
  await writeFile(join(outputDirectory, "EXPERIMENT_14B_MLAB_METRIC_SPECIFIC.md"), report, "utf8");
  return result;
}

const args = process.argv.slice(2);
const phase = argValue(args, "--phase", "all");
const protocolPath = resolve(ROOT, argValue(args, "--protocol", "scripts/experiments/experiment14b-mlab-metric-specific-protocol.json"));
const outputDirectory = resolve(ROOT, argValue(args, "--out", DEFAULT_OUTPUT));
const protocol = await readJson(protocolPath);
const freeze = await freezeOrVerify(protocolPath, outputDirectory);
let collection;
let result;
if (["collect", "all"].includes(phase)) collection = await collectLatencySplit(protocol, outputDirectory);
if (["score", "all"].includes(phase)) result = await scoreMetricSpecific(protocol, outputDirectory);
console.log(JSON.stringify({
  ok: true,
  phase,
  frozen_at: freeze.frozen_at,
  collection_status: collection?.status,
  evidence_status: result?.evidence_status,
  output_directory: outputDirectory,
}, null, 2));
