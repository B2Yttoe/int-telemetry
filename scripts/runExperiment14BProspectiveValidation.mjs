import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { readCsvStream } from "../stage2-int/tools/csv-stream.mjs";
import {
  buildRadarBlindHoldout,
  compareDistributions,
  empiricalCdfRows,
} from "./experiments/blindValidationMetrics.mjs";
import {
  acquireOrbitJson,
  buildFreshWalkerSnapshot,
  evaluateOrbitFreshness,
  fileMetadata,
  seedOrbitCache,
  sha256,
} from "./experiments/freshOrbitAcquisition.mjs";
import { generateFreshTopologyWindow } from "./experiments/freshTopologyWindow.mjs";
import {
  collectProspectiveRadar,
  collectProspectiveRipe,
  collectUntouchedMlabSplit,
} from "./experiments/experiment14bExternalSources.mjs";
import { compareOrbitEpochs } from "./experiments/crossEpochOrbitValidation.mjs";
import { extractRadarSeries, medianEpoch } from "./experiments/experiment14Sources.mjs";
import {
  applyUserPerformanceCalibration,
  buildServerLocationIndex,
  buildUserPerformanceContexts,
  fitUserPerformanceCalibration,
  loadUserPerformanceTopology,
  performanceRowsForCsv,
  scoreUserPerformance,
} from "./experiments/userPerformanceLayer.mjs";

const ROOT = process.cwd();

function argValue(args, name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? fallback : fallback;
}

function hasArg(args, name) {
  return args.includes(name);
}

async function exists(path) {
  try {
    await access(path);
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
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

async function writeCsv(path, rows) {
  await mkdir(dirname(path), { recursive: true });
  if (!rows.length) {
    await writeFile(path, "", "utf8");
    return;
  }
  const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const content = [headers.join(","), ...rows.map((row) => headers.map((key) => csvEscape(row[key])).join(","))].join("\n");
  await writeFile(path, `${content}\n`, "utf8");
}

function git(command, fallback = "") {
  try {
    return execFileSync("git", command, { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return fallback;
  }
}

function ceilHour(date) {
  const value = new Date(date);
  value.setUTCMinutes(0, 0, 0);
  if (value.getTime() < new Date(date).getTime()) value.setUTCHours(value.getUTCHours() + 1);
  return value;
}

function addHours(date, hours) {
  return new Date(new Date(date).getTime() + hours * 3_600_000);
}

function relativePath(path) {
  return relative(ROOT, path).replaceAll("\\", "/");
}

async function freezeProtocol({ protocolPath, protocol, outputDirectory }) {
  const manifestPath = join(outputDirectory, "freeze-manifest.json");
  if (await exists(manifestPath)) {
    const existing = await readJson(manifestPath);
    const currentProtocolHash = sha256(await readFile(protocolPath));
    if (existing.hashes.protocol_sha256 !== currentProtocolHash) {
      throw new Error("Experiment 14B protocol changed after freeze; use a new output directory instead of overwriting the frozen run");
    }
    return existing;
  }
  await mkdir(outputDirectory, { recursive: true });
  const frozenAt = new Date();
  const radarTestStart = ceilHour(frozenAt);
  const radarCalibrationEnd = new Date(radarTestStart.getTime() - 1);
  const radarCalibrationStart = addHours(radarTestStart, -protocol.radar.calibration_hours_before_freeze);
  const ripeTestStart = new Date(frozenAt.getTime() + 10 * 60_000);
  const ripeTestEnd = addHours(ripeTestStart, protocol.ripe_atlas.prospective_test_hours);
  const relevantFiles = [
    protocolPath,
    resolve("scripts/runExperiment14BProspectiveValidation.mjs"),
    resolve("scripts/experiments/freshOrbitAcquisition.mjs"),
    resolve("scripts/experiments/freshTopologyWindow.mjs"),
    resolve("scripts/experiments/experiment14bExternalSources.mjs"),
    resolve("scripts/experiments/remoteZipCsvSampler.mjs"),
    resolve("scripts/experiments/userPerformanceLayer.mjs"),
    resolve(protocol.internal_state_validity_boundary),
    resolve("src/config/walkerNetworkConfig.ts"),
    resolve("src/simulation/walker.ts"),
    resolve("src/simulation/antenna.ts"),
    resolve("src/simulation/tle.ts"),
  ];
  const files = [];
  for (const path of relevantFiles) files.push(await fileMetadata(path));
  const aggregate = createHash("sha256");
  for (const file of files.sort((left, right) => left.path.localeCompare(right.path))) {
    aggregate.update(`${file.path}\0${file.sha256}\n`);
  }
  const protocolBytes = await readFile(protocolPath);
  const status = git(["status", "--porcelain"]);
  const manifest = {
    schema: "int-temerity-experiment14b-freeze/v1",
    experiment_id: protocol.experiment_id,
    frozen_at: frozenAt.toISOString(),
    protocol_status: protocol.protocol_status,
    hashes: {
      protocol_sha256: sha256(protocolBytes),
      aggregate_code_and_config_sha256: aggregate.digest("hex"),
      git_status_sha256: sha256(status),
    },
    git: {
      commit: git(["rev-parse", "HEAD"], "unavailable"),
      branch: git(["branch", "--show-current"], "unavailable"),
      dirty: Boolean(status),
    },
    files: files.map((file) => ({ ...file, path: relativePath(file.path) })),
    windows: {
      orbit_input_not_before: frozenAt.toISOString(),
      orbit_validation_not_before: addHours(frozenAt, protocol.orbit.future_validation_delay_hours).toISOString(),
      radar_calibration_start: radarCalibrationStart.toISOString(),
      radar_calibration_end: radarCalibrationEnd.toISOString(),
      radar_test_start: radarTestStart.toISOString(),
      radar_test_end: addHours(radarTestStart, protocol.radar.prospective_test_hours).toISOString(),
      ripe_test_start: ripeTestStart.toISOString(),
      ripe_test_end: ripeTestEnd.toISOString(),
    },
    causality: {
      external_test_values_available_to_fit_at_freeze: false,
      test_target_values_allowed_for_fit: false,
      post_test_parameter_updates_allowed: false,
    },
  };
  await copyFile(protocolPath, join(outputDirectory, "frozen-protocol.json"));
  await writeJson(manifestPath, manifest);
  await writeFile(join(outputDirectory, "freeze-manifest.sha256"), `${sha256(JSON.stringify(manifest))}\n`, "utf8");
  return manifest;
}

async function seedAuditedOrbitCaches(cacheDirectory) {
  const registryPath = resolve("reports/experiment14-multisource-external-blind-validation/external-source-registry.json");
  if (!(await exists(registryPath))) return;
  const registry = await readJson(registryPath);
  const standard = registry.find((row) => row.source === "future-standard-gp");
  const supplemental = registry.find((row) => row.source === "future-spacex-supgp");
  if (standard) {
    await seedOrbitCache({
      cacheDirectory,
      sourceId: "starlink-standard-gp",
      dataPath: resolve("reports/experiment14-multisource-external-blind-validation/external/celestrak-starlink-future-gp.json"),
      metadata: { source_url: standard.url, acquired_at: standard.acquired_at },
    });
  }
  if (supplemental) {
    await seedOrbitCache({
      cacheDirectory,
      sourceId: "starlink-supplemental-gp",
      dataPath: resolve("reports/experiment14-multisource-external-blind-validation/external/celestrak-starlink-future-supgp.json"),
      metadata: { source_url: supplemental.url, acquired_at: supplemental.acquired_at },
    });
  }
}

async function acquireFreshOrbit({ protocol, freeze, outputDirectory, forceRefresh }) {
  const orbitDirectory = join(outputDirectory, "orbit");
  const cacheDirectory = join(outputDirectory, "_source-cache");
  await seedAuditedOrbitCaches(cacheDirectory);
  const standard = await acquireOrbitJson({
    url: protocol.orbit.standard_gp_url,
    sourceId: "starlink-standard-gp",
    cacheDirectory,
    outputDirectory: orbitDirectory,
    minimumRecords: protocol.orbit.minimum_catalog_records,
    minimumDownloadIntervalHours: protocol.orbit.minimum_download_interval_hours,
    requireAcquiredAfter: freeze.windows.orbit_input_not_before,
    force: forceRefresh,
  });
  const supplemental = await acquireOrbitJson({
    url: protocol.orbit.supplemental_gp_url,
    sourceId: "starlink-supplemental-gp",
    cacheDirectory,
    outputDirectory: orbitDirectory,
    minimumRecords: protocol.orbit.minimum_catalog_records,
    minimumDownloadIntervalHours: protocol.orbit.minimum_download_interval_hours,
    requireAcquiredAfter: freeze.windows.orbit_input_not_before,
    force: forceRefresh,
  });
  const result = {
    status: "pending-causal-fresh-acquisition",
    standard: standard.acquisition,
    supplemental: supplemental.acquisition,
    input_ready: false,
  };
  if (!standard.acquisition.causality_eligible) return result;
  const snapshot = await buildFreshWalkerSnapshot(standard.records, {
    sourceUrl: protocol.orbit.standard_gp_url,
    downloadedAt: standard.acquisition.acquired_at,
    planes: protocol.orbit.planes,
    satellitesPerPlane: protocol.orbit.satellites_per_plane,
    raanClusterThresholdDeg: protocol.orbit.raan_cluster_threshold_deg,
  });
  const freshness = evaluateOrbitFreshness(snapshot.satellites, standard.acquisition.acquired_at, {
    minimum_records: protocol.orbit.planes * protocol.orbit.satellites_per_plane,
    maximum_median_age_hours: protocol.orbit.maximum_selected_median_age_hours,
    maximum_p95_age_hours: protocol.orbit.maximum_selected_p95_age_hours,
    maximum_future_epoch_ratio: protocol.orbit.maximum_future_epoch_ratio,
  });
  await writeJson(join(orbitDirectory, "selected-shell-freshness-gate.json"), freshness);
  await writeJson(join(orbitDirectory, "fresh-model-input-walker-72x22.json"), snapshot);
  result.freshness = freshness;
  result.snapshot_path = relativePath(join(orbitDirectory, "fresh-model-input-walker-72x22.json"));
  result.input_ready = freshness.passed;
  result.status = freshness.passed ? "complete" : "failed-freshness-gate";
  return result;
}

async function ensureFreshTopology({ protocol, orbitStatus, outputDirectory }) {
  const topologyDirectory = join(outputDirectory, "topology");
  const nodesPath = join(topologyDirectory, "nodes.csv");
  const linksPath = join(topologyDirectory, "links.csv");
  const metadataPath = join(topologyDirectory, "metadata.json");
  if (await exists(metadataPath) && await exists(nodesPath) && await exists(linksPath)) return await readJson(metadataPath);
  if (!orbitStatus.input_ready) return { status: "pending-fresh-orbit-input" };
  const snapshot = await readJson(resolve(orbitStatus.snapshot_path));
  const window = await generateFreshTopologyWindow(snapshot, {
    epochIso: orbitStatus.standard.acquired_at,
    slices: protocol.topology_window.slices,
    stepMinutes: protocol.topology_window.step_minutes,
    mode: protocol.topology_window.mode,
    trafficProfile: protocol.topology_window.traffic_profile,
    routingAlgorithm: protocol.topology_window.routing_algorithm,
  });
  await writeCsv(nodesPath, window.nodes);
  await writeCsv(linksPath, window.links);
  const metadata = {
    schema: window.schema,
    status: "complete",
    generated_at: window.generated_at,
    source_catalog_fingerprint: window.source_catalog_fingerprint,
    epoch_iso: window.epoch_iso,
    slices: window.slices,
    step_minutes: window.step_minutes,
    node_rows: window.nodes.length,
    link_rows: window.links.length,
    nodes_csv: relativePath(nodesPath),
    links_csv: relativePath(linksPath),
  };
  await writeJson(metadataPath, metadata);
  return metadata;
}

async function collectMlabIfNeeded(protocol, outputDirectory) {
  const directory = join(outputDirectory, "mlab");
  const metadataPath = join(directory, "mlab-split-metadata.json");
  const trainingPath = join(directory, "training-october-2025.csv");
  const testPath = join(directory, "blind-test-november-2025-excluding-prior-date.csv");
  if (await exists(metadataPath) && await exists(trainingPath) && await exists(testPath)) {
    return { status: "complete", ...(await readJson(metadataPath)), training_path: trainingPath, test_path: testPath };
  }
  const collected = await collectUntouchedMlabSplit(protocol.mlab, directory);
  await writeCsv(trainingPath, collected.training.rows);
  await writeCsv(testPath, collected.test.rows);
  return { status: "complete", ...collected.metadata, training_path: trainingPath, test_path: testPath };
}

async function collectFutureOrbitValidation({ protocol, freeze, orbitStatus, outputDirectory, forceRefresh }) {
  if (!orbitStatus.input_ready) return { status: "pending-fresh-orbit-input" };
  if (Date.now() < new Date(freeze.windows.orbit_validation_not_before).getTime()) {
    return { status: "pending-future-window", available_at: freeze.windows.orbit_validation_not_before };
  }
  const directory = join(outputDirectory, "orbit", "future-validation");
  const cacheDirectory = join(outputDirectory, "_source-cache", "future-validation");
  const inputDataPath = join(outputDirectory, "orbit", "starlink-standard-gp-acquired.json");
  await seedOrbitCache({
    cacheDirectory,
    sourceId: "starlink-standard-gp-validation",
    dataPath: inputDataPath,
    metadata: { source_url: protocol.orbit.standard_gp_url, acquired_at: orbitStatus.standard.acquired_at },
  });
  const validation = await acquireOrbitJson({
    url: protocol.orbit.standard_gp_url,
    sourceId: "starlink-standard-gp-validation",
    cacheDirectory,
    outputDirectory: directory,
    minimumRecords: protocol.orbit.minimum_catalog_records,
    minimumDownloadIntervalHours: protocol.orbit.minimum_download_interval_hours,
    requireAcquiredAfter: freeze.windows.orbit_validation_not_before,
    force: forceRefresh,
  });
  if (!validation.acquisition.causality_eligible) {
    return { status: "pending-source-update", acquisition: validation.acquisition };
  }
  const modelSnapshot = await readJson(resolve(orbitStatus.snapshot_path));
  const comparison = compareOrbitEpochs({
    modelSnapshot,
    validationSnapshot: validation.records,
    comparisonTime: medianEpoch(validation.records),
  });
  await writeCsv(join(directory, "orbit-future-errors.csv"), comparison.rows);
  await writeJson(join(directory, "orbit-future-summary.json"), comparison.summary);
  return { status: "complete", acquisition: validation.acquisition, summary: comparison.summary };
}

async function safeCollect(label, operation) {
  try {
    return await operation();
  } catch (error) {
    return { status: "failed", source: label, error: error.stack ?? error.message };
  }
}

async function collectSources({ protocol, freeze, outputDirectory, forceRefresh }) {
  const status = { generated_at: new Date().toISOString(), sources: {} };
  status.sources.orbit_input = await safeCollect("orbit-input", () => acquireFreshOrbit({ protocol, freeze, outputDirectory, forceRefresh }));
  status.sources.topology = await safeCollect("fresh-topology", () => ensureFreshTopology({
    protocol,
    orbitStatus: status.sources.orbit_input,
    outputDirectory,
  }));
  status.sources.mlab = await safeCollect("mlab", () => collectMlabIfNeeded(protocol, outputDirectory));
  status.sources.radar = await safeCollect("radar", () => collectProspectiveRadar(
    protocol.radar,
    freeze,
    join(outputDirectory, "radar"),
    process.env[protocol.radar.token_environment_variable] ?? "",
  ));
  status.sources.ripe_atlas = await safeCollect("ripe-atlas", () => collectProspectiveRipe(
    protocol.ripe_atlas,
    freeze,
    join(outputDirectory, "ripe-atlas"),
    process.env[protocol.ripe_atlas.api_key_environment_variable] ?? "",
  ));
  status.sources.orbit_future_validation = await safeCollect("orbit-future-validation", () => collectFutureOrbitValidation({
    protocol,
    freeze,
    orbitStatus: status.sources.orbit_input,
    outputDirectory,
    forceRefresh,
  }));
  const ns3 = await safeCollect("ns3-cross-validation", async () => {
    const summary = await readJson(resolve(protocol.system_cross_validation.summary));
    return {
      status: summary.evidence_status === protocol.system_cross_validation.required_evidence_status ? "complete" : "incomplete",
      evidence_status: summary.evidence_status,
      completed_core_combinations: summary.ns3_completed_combinations,
      expected_core_combinations: summary.ns3_expected_combinations,
      completed_stress_combinations: summary.ns3_stress_completed_combinations,
      expected_stress_combinations: summary.ns3_stress_expected_combinations,
      summary_path: protocol.system_cross_validation.summary,
      report_path: protocol.system_cross_validation.report,
    };
  });
  status.sources.ns3_cross_validation = ns3;
  await writeJson(join(outputDirectory, "collection-status.json"), status);
  return status;
}

async function scoreMlab({ protocol, outputDirectory, collection }) {
  if (collection.sources.mlab?.status !== "complete" || collection.sources.topology?.status !== "complete") {
    return { status: "pending-inputs" };
  }
  const training = await readCsvStream(collection.sources.mlab.training_path);
  const test = await readCsvStream(collection.sources.mlab.test_path);
  const topology = await loadUserPerformanceTopology(
    resolve(collection.sources.topology.nodes_csv),
    resolve(collection.sources.topology.links_csv),
  );
  const locationIndex = buildServerLocationIndex(training);
  const trainingContexts = buildUserPerformanceContexts(topology, training, protocol.user_performance, locationIndex);
  const calibration = fitUserPerformanceCalibration(trainingContexts, protocol.user_performance);
  const testContexts = buildUserPerformanceContexts(topology, test, protocol.user_performance, locationIndex);
  const predictions = applyUserPerformanceCalibration(testContexts, calibration);
  const score = scoreUserPerformance(predictions);
  const directory = join(outputDirectory, "user-performance");
  await writeJson(join(directory, "calibration.json"), calibration);
  await writeJson(join(directory, "score.json"), score);
  await writeCsv(join(directory, "training-physical-context.csv"), performanceRowsForCsv(trainingContexts));
  await writeCsv(join(directory, "blind-test-paired-predictions.csv"), performanceRowsForCsv(predictions));
  await writeCsv(join(directory, "rtt-cdf.csv"), empiricalCdfRows({
    predicted_user_rtt_ms: predictions.map((row) => row.predicted_user_rtt_ms).filter(Number.isFinite),
    external_mlab_ndt7_rtt_ms: predictions.map((row) => row.external_rtt_ms).filter(Number.isFinite),
  }));
  await writeCsv(join(directory, "throughput-cdf.csv"), empiricalCdfRows({
    predicted_user_throughput_mbps: predictions.map((row) => row.predicted_user_throughput_mbps).filter(Number.isFinite),
    external_mlab_ndt7_throughput_mbps: predictions.map((row) => row.external_throughput_mbps).filter(Number.isFinite),
  }));
  return { status: "complete", calibration, score, training_rows: training.length, test_rows: test.length };
}

async function scoreRadar(protocol, outputDirectory, collection) {
  if (collection.sources.radar?.status !== "complete") return { status: collection.sources.radar?.status ?? "pending" };
  const calibrationPayload = await readJson(join(outputDirectory, "radar", "radar-calibration-payload.json"));
  const testPayload = await readJson(join(outputDirectory, "radar", "radar-prospective-test-payload.json"));
  const calibration = extractRadarSeries(calibrationPayload);
  const test = extractRadarSeries(testPayload);
  const all = [...calibration, ...test];
  const result = buildRadarBlindHoldout(all, {
    train_fraction: calibration.length / all.length,
    fit_fraction_within_train: protocol.radar.fit_fraction_within_calibration,
    ridge_lambda: protocol.radar.ridge_lambda,
    prediction_interval_coverage: protocol.radar.prediction_interval_coverage,
    traffic_weight_min: protocol.radar.traffic_weight_min,
    traffic_weight_max: protocol.radar.traffic_weight_max,
  });
  await writeJson(join(outputDirectory, "radar", "radar-prospective-score.json"), { ...result.summary, coefficients: result.coefficients });
  await writeCsv(join(outputDirectory, "radar", "radar-prospective-timeseries.csv"), result.rows);
  return { status: "complete", ...result.summary };
}

async function scoreRipe({ protocol, outputDirectory, collection, mlabScore }) {
  const source = collection.sources.ripe_atlas;
  if (!String(source?.status ?? "").startsWith("complete")) return { status: source?.status ?? "pending" };
  if (mlabScore.status !== "complete" || collection.sources.topology?.status !== "complete") return { status: "pending-user-performance-calibration" };
  const resultPath = source.status === "complete-exact-anchor"
    ? join(outputDirectory, "ripe-atlas", "ripe-custom-anchor-results.json")
    : join(outputDirectory, "ripe-atlas", "ripe-public-fallback-results.json");
  const raw = await readJson(resultPath);
  const rows = source.rows ?? [];
  if (!rows.length) return { status: "complete-no-valid-results", raw_result_count: Array.isArray(raw) ? raw.length : 0 };
  const training = await readCsvStream(collection.sources.mlab.training_path);
  const topology = await loadUserPerformanceTopology(
    resolve(collection.sources.topology.nodes_csv),
    resolve(collection.sources.topology.links_csv),
  );
  const contexts = buildUserPerformanceContexts(topology, rows, protocol.user_performance, buildServerLocationIndex(training));
  const predictions = applyUserPerformanceCalibration(contexts, mlabScore.calibration);
  const valid = predictions.filter((row) => Number.isFinite(row.predicted_user_rtt_ms) && Number.isFinite(row.external_rtt_ms));
  const comparison = compareDistributions(
    valid.map((row) => row.predicted_user_rtt_ms),
    valid.map((row) => row.external_rtt_ms),
  );
  await writeCsv(join(outputDirectory, "ripe-atlas", "ripe-paired-rtt.csv"), performanceRowsForCsv(predictions));
  await writeJson(join(outputDirectory, "ripe-atlas", "ripe-rtt-score.json"), comparison);
  return { status: "complete", semantics: source.status, valid_pairs: valid.length, comparison };
}

function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function statusTable(sources) {
  return `<table><thead><tr><th>来源</th><th>状态</th><th>说明</th></tr></thead><tbody>${Object.entries(sources).map(([name, value]) =>
    `<tr><td>${escapeHtml(name)}</td><td><span class="status ${String(value.status).startsWith("complete") ? "ok" : "pending"}">${escapeHtml(value.status)}</span></td><td>${escapeHtml(value.detail ?? value.available_at ?? value.error ?? value.evidence_status ?? "")}</td></tr>`,
  ).join("")}</tbody></table>`;
}

async function writeReport({ protocol, freeze, collection, results, outputDirectory }) {
  const mlab = results.user_performance;
  const cards = mlab.status === "complete" ? [
    ["M-Lab 测试样本", mlab.score.valid_paired_samples],
    ["用户 RTT P50 比", mlab.score.rtt.p50_ratio_model_to_external],
    ["用户吞吐 P50 比", mlab.score.throughput.p50_ratio_model_to_external],
    ["ns-3 核心组合", `${collection.sources.ns3_cross_validation.completed_core_combinations}/${collection.sources.ns3_cross_validation.expected_core_combinations}`],
  ] : [["当前证据状态", results.evidence_status]];
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(protocol.title)}</title><style>
  :root{font-family:Inter,"Microsoft YaHei",sans-serif;color:#18212b;background:#f4f7f8}body{margin:0}main{max-width:1180px;margin:auto;padding:32px 24px 64px}header{background:#102f3b;color:white;padding:38px 0;border-bottom:5px solid #d97706}header>div{max-width:1180px;margin:auto;padding:0 24px}h1{font-size:30px;margin:0 0 10px}h2{margin-top:34px;border-bottom:1px solid #cad5d9;padding-bottom:8px}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px}.card{background:white;border:1px solid #d7e0e3;border-radius:6px;padding:16px}.card span{display:block;color:#60717a;font-size:13px}.card strong{font-size:24px;display:block;margin-top:7px;color:#0f596e}table{width:100%;border-collapse:collapse;background:white}th,td{padding:10px;border:1px solid #dce4e7;text-align:left;font-size:13px}th{background:#eaf0f2}.status{padding:3px 7px;border-radius:4px;background:#fff3cd}.status.ok{background:#dff3e5;color:#17643a}.callout{padding:14px 16px;border-left:4px solid #d97706;background:#fff8eb}.code{font-family:Consolas,monospace;font-size:12px;word-break:break-all}</style></head><body><header><div><h1>${escapeHtml(protocol.title)}</h1><p>冻结参数后采集外部测试数据，测试目标值不参与拟合或区间校准。</p></div></header><main>
  <section class="cards">${cards.map(([label, value]) => `<div class="card"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join("")}</section>
  <h2>冻结与因果</h2><p>冻结时间：${escapeHtml(freeze.frozen_at)}</p><p class="code">协议 SHA-256：${escapeHtml(freeze.hashes.protocol_sha256)}</p><p class="callout">正式结论只使用冻结后获取且通过因果门禁的数据。尚未结束的未来窗口保留为 pending，不使用旧数据或合成数据替代。</p>
  <h2>采集状态</h2>${statusTable(collection.sources)}
  <h2>同口径用户性能</h2>${mlab.status === "complete" ? `<table><thead><tr><th>指标</th><th>P50 比</th><th>P95 比</th><th>MAE</th><th>KS</th><th>区间覆盖</th></tr></thead><tbody><tr><td>用户 RTT</td><td>${mlab.score.rtt.p50_ratio_model_to_external}</td><td>${mlab.score.rtt.p95_ratio_model_to_external}</td><td>${mlab.score.rtt.mae}</td><td>${mlab.score.rtt.ks_distance}</td><td>${mlab.score.rtt.interval_coverage}</td></tr><tr><td>NDT7 用户吞吐</td><td>${mlab.score.throughput.p50_ratio_model_to_external}</td><td>${mlab.score.throughput.p95_ratio_model_to_external}</td><td>${mlab.score.throughput.mae}</td><td>${mlab.score.throughput.ks_distance}</td><td>${mlab.score.throughput.interval_coverage}</td></tr></tbody></table><p>只拟合两个参数：接入/传输 RTT 偏置与调度/传输份额。测试月吞吐和 RTT 不参与拟合。</p>` : `<p>等待新鲜轨道输入和拓扑窗口后评分。</p>`}
  <h2>结论边界</h2><p>${escapeHtml(protocol.claim_boundary)}</p><ul><li>轨道必须通过年龄门禁，旧 GP 不再静默进入正式实验。</li><li>M-Lab 对照使用用户侧预测吞吐，不再使用星座内部任务承载速率。</li><li>历史 M-Lab 测试按时间、客户端地域和服务器城市配对；没有对应历史 GP 时明确标记为代表性轨道相位。</li><li>ns-3 证据验证逐包队列、MTU、INT 字节与报告交付趋势，不代表真实卫星硬件。</li></ul>
  </main></body></html>`;
  await writeFile(join(outputDirectory, "index.html"), html, "utf8");
  const markdown = `# ${protocol.title}\n\n## 当前状态\n\n- 证据状态：\`${results.evidence_status}\`\n- 冻结时间：${freeze.frozen_at}\n- 协议哈希：\`${freeze.hashes.protocol_sha256}\`\n\n## 采集状态\n\n${Object.entries(collection.sources).map(([name, value]) => `- ${name}: ${value.status}${value.available_at ? `，最早可用 ${value.available_at}` : ""}`).join("\n")}\n\n## 同口径用户性能\n\n${mlab.status === "complete" ? `- 配对样本：${mlab.score.valid_paired_samples}\n- RTT P50 比：${mlab.score.rtt.p50_ratio_model_to_external}，KS：${mlab.score.rtt.ks_distance}\n- 吞吐 P50 比：${mlab.score.throughput.p50_ratio_model_to_external}，KS：${mlab.score.throughput.ks_distance}\n- 测试目标用于拟合：0` : "等待新鲜轨道和拓扑窗口。"}\n\n## 声明边界\n\n${protocol.claim_boundary}\n`;
  await writeFile(join(outputDirectory, "EXPERIMENT_14B_REPORT.md"), markdown, "utf8");
}

async function scoreAll({ protocol, freeze, outputDirectory }) {
  const collectionPath = join(outputDirectory, "collection-status.json");
  if (!(await exists(collectionPath))) throw new Error("Run experiment14B collect before score");
  const collection = await readJson(collectionPath);
  const userPerformance = await safeCollect("user-performance-score", () => scoreMlab({ protocol, outputDirectory, collection }));
  const radar = await safeCollect("radar-score", () => scoreRadar(protocol, outputDirectory, collection));
  const ripe = await safeCollect("ripe-score", () => scoreRipe({ protocol, outputDirectory, collection, mlabScore: userPerformance }));
  const complete = [
    collection.sources.orbit_input?.input_ready,
    collection.sources.topology?.status === "complete",
    userPerformance.status === "complete",
    radar.status === "complete",
    ripe.status === "complete",
    collection.sources.orbit_future_validation?.status === "complete",
    collection.sources.ns3_cross_validation?.status === "complete",
  ];
  const results = {
    schema: "int-temerity-experiment14b-results/v1",
    generated_at: new Date().toISOString(),
    evidence_status: complete.every(Boolean)
      ? "prospective-multisource-validation-complete"
      : "prospective-validation-in-progress-no-substitution",
    claim_boundary: protocol.claim_boundary,
    freeze: freeze.hashes,
    orbit_input: collection.sources.orbit_input,
    orbit_future_validation: collection.sources.orbit_future_validation,
    user_performance: userPerformance,
    radar,
    ripe_atlas: ripe,
    ns3_cross_validation: collection.sources.ns3_cross_validation,
    causality_audit: {
      protocol_hash_at_freeze: freeze.hashes.protocol_sha256,
      protocol_hash_at_score: sha256(await readFile(resolve("scripts/experiments/experiment14b-protocol.json"))),
      protocol_unchanged: freeze.hashes.protocol_sha256 === sha256(await readFile(resolve("scripts/experiments/experiment14b-protocol.json"))),
      mlab_test_values_used_for_fit: userPerformance.calibration?.audit?.test_rows_used_for_fit ?? 0,
      mlab_test_values_used_for_interval_calibration: userPerformance.calibration?.audit?.test_rows_used_for_interval_calibration ?? 0,
      post_test_parameter_updates: 0,
    },
  };
  await writeJson(join(outputDirectory, "experiment14b-results.json"), results);
  await writeReport({ protocol, freeze, collection, results, outputDirectory });
  await writeJson(join(outputDirectory, "experiment14b-manifest.json"), {
    schema: "int-temerity-experiment14b-manifest/v1",
    experiment_id: protocol.experiment_id,
    evidence_status: results.evidence_status,
    outputs: {
      freeze_manifest: "freeze-manifest.json",
      frozen_protocol: "frozen-protocol.json",
      collection_status: "collection-status.json",
      results: "experiment14b-results.json",
      report_markdown: "EXPERIMENT_14B_REPORT.md",
      report_html: "index.html",
      user_performance_calibration: "user-performance/calibration.json",
      user_performance_score: "user-performance/score.json",
      user_performance_predictions: "user-performance/blind-test-paired-predictions.csv",
    },
  });
  return results;
}

const args = process.argv.slice(2);
const phase = argValue(args, "--phase", "all");
const protocolPath = resolve(argValue(args, "--protocol", "scripts/experiments/experiment14b-protocol.json"));
const outputDirectory = resolve(argValue(args, "--out", "reports/experiment14b-prospective-external-validation"));
const forceRefresh = hasArg(args, "--force-refresh");
const protocol = await readJson(protocolPath);
const freeze = await freezeProtocol({ protocolPath, protocol, outputDirectory });
let collection = null;
let results = null;
if (["collect", "all"].includes(phase)) collection = await collectSources({ protocol, freeze, outputDirectory, forceRefresh });
if (["score", "all"].includes(phase)) results = await scoreAll({ protocol, freeze, outputDirectory });
console.log(JSON.stringify({
  ok: true,
  phase,
  output_directory: outputDirectory,
  frozen_at: freeze.frozen_at,
  collection_status: collection ? Object.fromEntries(Object.entries(collection.sources).map(([key, value]) => [key, value.status ?? (value.input_ready ? "complete" : "pending")])) : undefined,
  evidence_status: results?.evidence_status,
}, null, 2));
