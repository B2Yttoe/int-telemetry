import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import {
  buildSeededPathPlan,
  hashObservationMask,
  pairedMovingBlockBootstrap,
  pairedWinTieLoss,
} from "./experiments/experiment3StrongBaselineStats.mjs";

const PROFILES = [
  { id: "telesat-1015-medium", label: "Telesat-1015 27x13", short: "Telesat 351", scale: "medium" },
  { id: "starlink-main-large", label: "Starlink main shell 72x22", short: "Starlink 1584", scale: "large" },
];

const BACKENDS = [
  { id: "low-rank", label: "原生低秩", family: "low-rank" },
  { id: "soft-impute", label: "SoftImpute", family: "nuclear-norm" },
  { id: "kalman-smoother", label: "Kalman/RTS", family: "offline-temporal" },
  { id: "graph-neighbor", label: "图邻居插值", family: "graph-interpolation" },
  { id: "graph-regularized", label: "图时序正则", family: "graph-temporal" },
  { id: "st-gnn", label: "ST-GNN", family: "graph-ml" },
  { id: "costco", label: "CoSTCo", family: "coordinate-tensor-ml" },
];

const METRICS = [
  { id: "cpu_percent", label: "CPU 利用率", scope: "node", errorColumn: "cpu_error", unit: "%" },
  { id: "queue_depth", label: "节点队列深度", scope: "node", errorColumn: "queue_depth_error", unit: "项" },
  { id: "energy_percent", label: "电量 SoC", scope: "node", errorColumn: "energy_error", unit: "%" },
  { id: "utilization_percent", label: "链路利用率", scope: "link", errorColumn: "utilization_error", unit: "%" },
];

function argValue(args, name, fallback = "") {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? fallback : fallback;
}

function hasArg(args, name) {
  return args.includes(name);
}

function numberArg(args, name, fallback) {
  const raw = argValue(args, name, "");
  if (String(raw).trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function listArg(args, name, fallback) {
  return argValue(args, name, fallback.join(","))
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function numberValue(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function optionalNumber(value) {
  if (value === "" || value === null || value === undefined) return NaN;
  return numberValue(value, NaN);
}

function round(value, digits = 6) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : "";
}

function mean(values) {
  const usable = values.filter(Number.isFinite);
  return usable.length > 0
    ? usable.reduce((total, value) => total + value, 0) / usable.length
    : 0;
}

function std(values) {
  const usable = values.filter(Number.isFinite);
  if (usable.length <= 1) return 0;
  const average = mean(usable);
  return Math.sqrt(mean(usable.map((value) => (value - average) ** 2)));
}

function percentile(values, quantile) {
  const usable = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (usable.length === 0) return 0;
  const position = Math.max(0, Math.min(1, quantile)) * (usable.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return usable[lower];
  return usable[lower] + (usable[upper] - usable[lower]) * (position - lower);
}

function groupBy(rows, keyFn) {
  const groups = new Map();
  rows.forEach((row) => {
    const key = keyFn(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  });
  return groups;
}

function indexBy(rows, keyFn) {
  return new Map(rows.map((row) => [keyFn(row), row]));
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

function csvEscape(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll("\"", "\"\"")}"` : text;
}

function rowsToCsv(rows) {
  if (rows.length === 0) return "";
  const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  return [headers.join(","), ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(","))].join("\n");
}

async function readCsv(path) {
  return parseCsv(await readFile(path, "utf8"));
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(path) {
  return sha256(await readFile(path));
}

function requireFile(path, label) {
  if (!existsSync(path)) throw new Error(`${label} 不存在: ${path}`);
}

function profileById(id) {
  const profile = PROFILES.find((item) => item.id === id);
  if (!profile) throw new Error(`未知星座配置: ${id}`);
  return profile;
}

function backendById(id) {
  const backend = BACKENDS.find((item) => item.id === id);
  if (!backend) throw new Error(`未知补全后端: ${id}`);
  return backend;
}

function metricById(id) {
  const metric = METRICS.find((item) => item.id === id);
  if (!metric) throw new Error(`未知指标: ${id}`);
  return metric;
}

function parseLastJson(stdout, label) {
  const trimmed = stdout.trim();
  if (!trimmed) return {};
  const start = trimmed.lastIndexOf("\n{");
  const jsonText = start >= 0 ? trimmed.slice(start + 1) : trimmed;
  try {
    return JSON.parse(jsonText);
  } catch (error) {
    throw new Error(`${label} 未返回合法 JSON: ${error.message}\n${trimmed.slice(-1600)}`);
  }
}

function runNode(label, script, args) {
  return new Promise((resolvePromise, reject) => {
    console.log(`[experiment3:stat] ${label}`);
    const child = spawn(process.execPath, [script, ...args], {
      cwd: process.cwd(),
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
      if (code !== 0) {
        reject(new Error(`${label} 失败 (${code})\n${stderr || stdout}`));
        return;
      }
      resolvePromise(parseLastJson(stdout, label));
    });
  });
}

async function removeIfExists(path) {
  if (existsSync(path)) await rm(path, { force: true, recursive: true });
}

function relativePath(path) {
  return relative(process.cwd(), path).replaceAll("\\", "/");
}

function observationFiles({ seedDir, algorithm, groundDir }) {
  return {
    probePlan: join(seedDir, `probe-paths-${algorithm}.csv`),
    probeSummary: join(seedDir, `probe-summary-${algorithm}.csv`),
    reportingPaths: join(seedDir, `reporting-paths-${algorithm}.csv`),
    hopRecords: join(seedDir, `probe-int-hop-records-${algorithm}.csv`),
    reports: join(seedDir, `probe-int-reports-${algorithm}.csv`),
    runReport: join(seedDir, `probe-int-run-report-${algorithm}.json`),
    overheadBySlice: join(seedDir, `probe-int-overhead-by-slice-${algorithm}.csv`),
    groundNodes: join(groundDir, "ground-reconstructed-nodes.csv"),
    groundLinks: join(groundDir, "ground-reconstructed-links.csv"),
    manifest: join(groundDir, "observation-manifest.json"),
  };
}

async function ensureContactPlan({ profile, truthDir, sharedDir, windowSize, resume }) {
  await mkdir(sharedDir, { recursive: true });
  const path = join(sharedDir, "predicted-contact-plan.json");
  if (!resume || !existsSync(path)) {
    await runNode(`${profile.short}: 生成共享接触预测`, "stage2-int/tools/predict-contact-plan.mjs", [
      "--input", truthDir,
      "--out", sharedDir,
      "--completion-window-slices", String(windowSize),
    ]);
  }
  requireFile(path, `${profile.short} 接触预测`);
  return path;
}

async function ensureObservation({
  profile,
  seed,
  oldRoot,
  outputDir,
  contactPlanPath,
  downlinkBudgetBytes,
  resume,
  retainBulk,
}) {
  const truthDir = join(oldRoot, profile.id, "stage1-truth");
  const experiment2Dir = join(oldRoot, profile.id, "experiment2", "stage2", "full-probe-int");
  const candidatePathsPath = join(experiment2Dir, "probe-paths-path-balance.csv");
  const referenceBudgetPath = join(experiment2Dir, "probe-summary-shortest-path-probe.csv");
  const seedRoot = join(outputDir, "observations", profile.id, `seed-${seed}`);
  const stage2Dir = join(seedRoot, "stage2");
  const groundDir = join(seedRoot, "ground-oam");
  const algorithm = `experiment3-mask-seed-${seed}`;
  const files = observationFiles({ seedDir: stage2Dir, algorithm, groundDir });
  await mkdir(stage2Dir, { recursive: true });
  await mkdir(groundDir, { recursive: true });

  if (resume && existsSync(files.manifest) && existsSync(files.groundNodes) && existsSync(files.groundLinks)) {
    return readJson(files.manifest);
  }

  requireFile(join(truthDir, "nodes.csv"), `${profile.short} truth nodes`);
  requireFile(join(truthDir, "links.csv"), `${profile.short} truth links`);
  requireFile(candidatePathsPath, `${profile.short} 全量候选路径`);
  requireFile(referenceBudgetPath, `${profile.short} 路径预算参考`);

  const [candidatePaths, truthLinks, referenceBudgetRows] = await Promise.all([
    readCsv(candidatePathsPath),
    readCsv(join(truthDir, "links.csv")),
    readCsv(referenceBudgetPath),
  ]);
  const pathLinkBudgetBySlice = new Map(referenceBudgetRows.map((row) => [
    String(row.slice_index),
    numberValue(row.selected_path_links, row.selected_path_link_budget),
  ]));
  const plan = buildSeededPathPlan({
    candidatePaths,
    truthLinks,
    pathLinkBudgetBySlice,
    seed,
    algorithm,
  });
  await Promise.all([
    writeFile(files.probePlan, rowsToCsv(plan.selectedRows), "utf8"),
    writeFile(files.probeSummary, rowsToCsv(plan.summaryRows), "utf8"),
  ]);

  await runNode(`${profile.short}/seed ${seed}: 回传路径`, "stage2-int/tools/reporting-path-planner.mjs", [
    "--input", truthDir,
    "--stage2", stage2Dir,
    "--out", stage2Dir,
    "--algorithm", algorithm,
    "--probes", files.probePlan,
  ]);
  await runNode(`${profile.short}/seed ${seed}: 逐跳 INT`, "stage2-int/tools/probe-int-runner.mjs", [
    "--input", truthDir,
    "--stage2", stage2Dir,
    "--out", stage2Dir,
    "--algorithm", algorithm,
  ]);
  await runNode(`${profile.short}/seed ${seed}: Ground OAM`, "stage2-int/tools/ground-oam-reconstructor.mjs", [
    "--input", truthDir,
    "--stage2", stage2Dir,
    "--out", groundDir,
    "--hops", files.hopRecords,
    "--reports", files.reports,
    "--downlink-budget-bytes", String(downlinkBudgetBytes),
    "--write-estimate-graph", "false",
  ]);

  const [metadata, runReport, groundNodes, groundLinks] = await Promise.all([
    readJson(join(truthDir, "metadata.json")),
    readJson(files.runReport),
    readCsv(files.groundNodes),
    readCsv(files.groundLinks),
  ]);
  const overhead = runReport.overhead ?? {};
  const nodeMaskHash = hashObservationMask(groundNodes, "node_id");
  const linkMaskHash = hashObservationMask(groundLinks, "link_id");
  const manifest = {
    schema_version: "experiment3-statistical-observation-v1",
    generated_at: new Date().toISOString(),
    constellation_profile_id: profile.id,
    constellation_label: profile.short,
    observation_seed: seed,
    selection_policy: "seeded-path-mask-with-fixed-per-slice-path-link-budget",
    truth_dir: truthDir,
    candidate_paths_csv: candidatePathsPath,
    reference_budget_csv: referenceBudgetPath,
    predicted_contact_plan_json: contactPlanPath,
    stage2_dir: stage2Dir,
    ground_oam_dir: groundDir,
    probe_plan_csv: files.probePlan,
    probe_plan_sha256: await sha256File(files.probePlan),
    node_observation_mask_sha256: nodeMaskHash,
    link_observation_mask_sha256: linkMaskHash,
    node_samples: groundNodes.length,
    observed_node_samples: groundNodes.filter((row) => String(row.observed).toLowerCase() === "true").length,
    link_samples: groundLinks.length,
    observed_link_samples: groundLinks.filter((row) => String(row.observed).toLowerCase() === "true").length,
    telemetry_total_bytes: numberValue(overhead.total_telemetry_generated_bytes),
    telemetry_total_energy_j: numberValue(overhead.total_telemetry_energy_j),
    hop_records: numberValue(overhead.hop_records),
    node_count: numberValue(metadata.node_count),
    slice_count: numberValue(metadata.slice_count),
    telemetry_bytes_per_node_slice: round(
      numberValue(overhead.total_telemetry_generated_bytes) /
      Math.max(numberValue(metadata.node_count) * numberValue(metadata.slice_count), 1),
    ),
    planned_mean_active_link_coverage: round(mean(plan.summaryRows.map((row) => numberValue(row.planned_active_link_coverage)))),
    mean_budget_fill_ratio: round(mean(plan.summaryRows.map((row) => numberValue(row.budget_fill_ratio)))),
    fairness_note: "同一 profile/seed 的所有补全后端复用该 OAM 观测和遥测字节。",
  };
  await writeFile(files.manifest, JSON.stringify(manifest, null, 2), "utf8");

  if (!retainBulk) {
    await Promise.all([
      removeIfExists(files.hopRecords),
      removeIfExists(files.reports),
      removeIfExists(join(stage2Dir, `probe-int-link-overhead-${algorithm}.csv`)),
      removeIfExists(join(stage2Dir, `probe-int-node-overhead-${algorithm}.csv`)),
      removeIfExists(files.reportingPaths),
    ]);
  }
  return manifest;
}

function collectMetricRows({ profile, seed, backend, observation, evaluation }) {
  const rows = [];
  METRICS.forEach((metric) => {
    const report = metric.scope === "node"
      ? evaluation.node_reconstruction?.metrics?.[metric.id]
      : evaluation.metrics?.[metric.id];
    if (!report) return;
    const matrixSummary = metric.scope === "node"
      ? (evaluation.node_matrix_summaries ?? []).find((row) => row.metric === metric.id) ?? {}
      : (evaluation.matrix_summaries ?? []).find((row) => row.metric === metric.id) ?? {};
    const scopeSummary = metric.scope === "node" ? evaluation.node_reconstruction ?? {} : evaluation.reconstruction ?? {};
    rows.push({
      constellation_profile_id: profile.id,
      constellation_label: profile.short,
      scale: profile.scale,
      observation_seed: seed,
      run_id: `${profile.id}|seed-${seed}`,
      completion_backend: backend.id,
      backend_label: backend.label,
      backend_family: backend.family,
      metric_scope: metric.scope,
      target_metric: metric.id,
      metric_label: metric.label,
      metric_unit: metric.unit,
      inferred_samples: numberValue(report.inferred_samples),
      inferred_mae: report.inferred_mae ?? "",
      inferred_rmse: report.inferred_rmse ?? "",
      inferred_p95_ae: report.inferred_p95_ae ?? "",
      inferred_max_ae: report.inferred_max_ae ?? "",
      inferred_nmse: report.inferred_nmse ?? "",
      inferred_smape: report.inferred_smape ?? "",
      inferred_r2: report.inferred_r2 ?? "",
      direct_observation_rate: metric.scope === "node"
        ? numberValue(scopeSummary.direct_observation_rate)
        : numberValue(scopeSummary.direct_observation_rate_on_active),
      completion_coverage: metric.scope === "node"
        ? numberValue(scopeSummary.node_completion_coverage)
        : numberValue(scopeSummary.active_link_completion_coverage),
      completion_wall_clock_ms: matrixSummary.completion_wall_clock_ms ?? "",
      completion_algorithm: matrixSummary.completion_algorithm ?? backend.id,
      online_causal: matrixSummary.online_causal ?? "",
      uses_future_delivered_observations: matrixSummary.uses_future_delivered_observations ?? "",
      ml_parameter_count: matrixSummary.ml_parameter_count ?? 0,
      telemetry_total_bytes: observation.telemetry_total_bytes,
      telemetry_bytes_per_node_slice: observation.telemetry_bytes_per_node_slice,
      probe_plan_sha256: observation.probe_plan_sha256,
      node_observation_mask_sha256: observation.node_observation_mask_sha256,
      link_observation_mask_sha256: observation.link_observation_mask_sha256,
    });
  });
  return rows;
}

function collectBySliceRows({ profile, seed, backend, nodeErrors, linkErrors }) {
  const result = [];
  METRICS.forEach((metric) => {
    const sourceRows = metric.scope === "node" ? nodeErrors : linkErrors;
    const grouped = groupBy(
      sourceRows.filter((row) => row.observation_source === "inferred"),
      (row) => String(row.slice_index),
    );
    [...grouped.entries()]
      .sort(([left], [right]) => Number(left) - Number(right))
      .forEach(([sliceIndex, rows]) => {
        const errors = rows.map((row) => optionalNumber(row[metric.errorColumn])).filter(Number.isFinite);
        const absolute = errors.map(Math.abs);
        result.push({
          constellation_profile_id: profile.id,
          constellation_label: profile.short,
          scale: profile.scale,
          observation_seed: seed,
          run_id: `${profile.id}|seed-${seed}`,
          completion_backend: backend.id,
          backend_label: backend.label,
          metric_scope: metric.scope,
          target_metric: metric.id,
          metric_label: metric.label,
          slice_index: Number(sliceIndex),
          inferred_samples: errors.length,
          inferred_mae: round(mean(absolute)),
          inferred_rmse: round(Math.sqrt(mean(errors.map((value) => value ** 2)))),
          inferred_p95_ae: round(percentile(absolute, 0.95)),
        });
      });
  });
  return result;
}

async function runCompletion({
  profile,
  seed,
  backend,
  observation,
  outputDir,
  rank,
  iterations,
  windowSize,
  mlEpochs,
  mlTrainingSamples,
  mlHiddenUnits,
  mlHiddenLayers,
  mlLatentRank,
  resume,
  retainBulk,
}) {
  const backendDir = join(outputDir, "runs", profile.id, `seed-${seed}`, backend.id);
  const compactSummaryPath = join(backendDir, "run-summary.json");
  const compactSlicePath = join(backendDir, "by-slice.csv");
  await mkdir(backendDir, { recursive: true });
  if (resume && existsSync(compactSummaryPath) && existsSync(compactSlicePath)) {
    return {
      rows: (await readJson(compactSummaryPath)).rows,
      bySliceRows: await readCsv(compactSlicePath),
      reused: true,
    };
  }

  const truthDir = observation.truth_dir;
  const stage2Dir = observation.stage2_dir;
  const groundDir = observation.ground_oam_dir;
  const args = [
    "--input", truthDir,
    "--stage2", stage2Dir,
    "--ground", groundDir,
    "--out", backendDir,
    "--algorithm", "int-mc",
    "--rank", String(rank),
    "--iterations", String(iterations),
    "--window-size", String(windowSize),
    "--completion-backend", backend.id,
    "--node-metrics", "cpu_percent,queue_depth,energy_percent",
    "--link-metrics", "utilization_percent",
    "--predicted-contact-plan", observation.predicted_contact_plan_json,
    "--ml-epochs", String(mlEpochs),
    "--ml-training-samples", String(mlTrainingSamples),
    "--ml-hidden-units", String(mlHiddenUnits),
    "--ml-hidden-layers", String(mlHiddenLayers),
    "--ml-latent-rank", String(mlLatentRank),
  ];
  await runNode(`${profile.short}/seed ${seed}: ${backend.label}`, "stage2-int/tools/int-mc-reconstructor.mjs", args);

  const evaluationPath = join(backendDir, "int-mc-evaluation.json");
  const nodeErrorsPath = join(backendDir, "int-mc-node-errors.csv");
  const linkErrorsPath = join(backendDir, "int-mc-link-errors.csv");
  const [evaluation, nodeErrors, linkErrors] = await Promise.all([
    readJson(evaluationPath),
    readCsv(nodeErrorsPath),
    readCsv(linkErrorsPath),
  ]);
  const rows = collectMetricRows({ profile, seed, backend, observation, evaluation });
  const bySliceRows = collectBySliceRows({ profile, seed, backend, nodeErrors, linkErrors });
  await Promise.all([
    writeFile(compactSummaryPath, JSON.stringify({
      schema_version: "experiment3-statistical-backend-run-v1",
      generated_at: new Date().toISOString(),
      profile: profile.id,
      seed,
      backend: backend.id,
      rows,
      evaluation_json: relativePath(evaluationPath),
    }, null, 2), "utf8"),
    writeFile(compactSlicePath, rowsToCsv(bySliceRows), "utf8"),
  ]);

  if (!retainBulk) {
    await Promise.all([
      removeIfExists(join(backendDir, "ground-mc-reconstructed-nodes.csv")),
      removeIfExists(join(backendDir, "ground-mc-reconstructed-links.csv")),
      removeIfExists(nodeErrorsPath),
      removeIfExists(linkErrorsPath),
      removeIfExists(join(backendDir, "int-mc-priority-retest.csv")),
      removeIfExists(join(backendDir, "int-mc-deployable-priority-retest.csv")),
    ]);
  }
  return { rows, bySliceRows, reused: false };
}

function aggregateRows(rows) {
  const groups = groupBy(rows, (row) => `${row.constellation_profile_id}|${row.target_metric}|${row.completion_backend}`);
  return [...groups.values()].map((group) => ({
    constellation_profile_id: group[0].constellation_profile_id,
    constellation_label: group[0].constellation_label,
    scale: group[0].scale,
    target_metric: group[0].target_metric,
    metric_label: group[0].metric_label,
    metric_scope: group[0].metric_scope,
    metric_unit: group[0].metric_unit,
    completion_backend: group[0].completion_backend,
    backend_label: group[0].backend_label,
    seed_count: new Set(group.map((row) => row.observation_seed)).size,
    mean_inferred_mae: round(mean(group.map((row) => optionalNumber(row.inferred_mae)))),
    std_inferred_mae: round(std(group.map((row) => optionalNumber(row.inferred_mae)))),
    mean_inferred_rmse: round(mean(group.map((row) => optionalNumber(row.inferred_rmse)))),
    mean_inferred_p95_ae: round(mean(group.map((row) => optionalNumber(row.inferred_p95_ae)))),
    mean_inferred_r2: round(mean(group.map((row) => optionalNumber(row.inferred_r2)))),
    mean_completion_wall_clock_ms: round(mean(group.map((row) => optionalNumber(row.completion_wall_clock_ms)))),
    mean_direct_observation_rate: round(mean(group.map((row) => optionalNumber(row.direct_observation_rate)))),
    mean_telemetry_bytes_per_node_slice: round(mean(group.map((row) => optionalNumber(row.telemetry_bytes_per_node_slice)))),
  }));
}

function buildPairedEvidence(bySliceRows, aggregate) {
  const baselineByKey = indexBy(
    bySliceRows.filter((row) => row.completion_backend === "low-rank"),
    (row) => `${row.constellation_profile_id}|${row.observation_seed}|${row.target_metric}|${row.slice_index}`,
  );
  const pairs = bySliceRows
    .filter((row) => row.completion_backend !== "low-rank")
    .map((row) => {
      const baseline = baselineByKey.get(`${row.constellation_profile_id}|${row.observation_seed}|${row.target_metric}|${row.slice_index}`);
      if (!baseline) return null;
      const candidateMae = optionalNumber(row.inferred_mae);
      const baselineMae = optionalNumber(baseline.inferred_mae);
      if (!Number.isFinite(candidateMae) || !Number.isFinite(baselineMae)) return null;
      return {
        constellation_profile_id: row.constellation_profile_id,
        constellation_label: row.constellation_label,
        target_metric: row.target_metric,
        metric_label: row.metric_label,
        completion_backend: row.completion_backend,
        backend_label: row.backend_label,
        run_id: row.run_id,
        observation_seed: row.observation_seed,
        slice_index: row.slice_index,
        baseline_mae: baselineMae,
        candidate_mae: candidateMae,
        delta: candidateMae - baselineMae,
        relative_delta: baselineMae > 1e-12 ? (candidateMae - baselineMae) / baselineMae : "",
      };
    })
    .filter(Boolean);
  const groups = groupBy(pairs, (row) => `${row.constellation_profile_id}|${row.target_metric}|${row.completion_backend}`);
  const evidence = [...groups.values()].map((group) => {
    const bootstrap = pairedMovingBlockBootstrap({
      pairs: group,
      blockLength: 4,
      iterations: 4000,
      seed: `${group[0].constellation_profile_id}|${group[0].target_metric}|${group[0].completion_backend}`,
    });
    const winTieLoss = pairedWinTieLoss(group, 1e-6);
    const baselineMean = mean(group.map((row) => row.baseline_mae));
    return {
      constellation_profile_id: group[0].constellation_profile_id,
      constellation_label: group[0].constellation_label,
      target_metric: group[0].target_metric,
      metric_label: group[0].metric_label,
      completion_backend: group[0].completion_backend,
      backend_label: group[0].backend_label,
      paired_slice_samples: bootstrap.paired_samples,
      observation_run_count: bootstrap.run_count,
      mean_baseline_mae: round(baselineMean),
      mean_candidate_mae: round(mean(group.map((row) => row.candidate_mae))),
      mean_mae_delta: bootstrap.mean_delta,
      mean_relative_mae_delta: round(bootstrap.mean_delta / Math.max(baselineMean, 1e-12)),
      ci95_low_delta: bootstrap.ci95_low,
      ci95_high_delta: bootstrap.ci95_high,
      probability_improved: bootstrap.probability_improved,
      wins: winTieLoss.wins,
      ties: winTieLoss.ties,
      losses: winTieLoss.losses,
      statistically_better_than_low_rank: numberValue(bootstrap.ci95_high, Infinity) < 0,
      statistically_noninferior_2pct: numberValue(bootstrap.ci95_high, Infinity) <= baselineMean * 0.02,
    };
  });

  const aggregateByKey = indexBy(aggregate, (row) => `${row.constellation_profile_id}|${row.target_metric}|${row.completion_backend}`);
  aggregate.forEach((row) => {
    const baseline = aggregateByKey.get(`${row.constellation_profile_id}|${row.target_metric}|low-rank`);
    row.relative_mae_vs_low_rank = row.completion_backend === "low-rank"
      ? 0
      : round((numberValue(row.mean_inferred_mae) - numberValue(baseline?.mean_inferred_mae)) /
        Math.max(numberValue(baseline?.mean_inferred_mae), 1e-12));
  });
  return { pairs, evidence };
}

function buildFairnessAudit(rows, observations, profiles, seeds, backends, metrics) {
  const cases = [];
  profiles.forEach((profile) => {
    seeds.forEach((seed) => {
      const caseRows = rows.filter((row) => row.constellation_profile_id === profile.id && Number(row.observation_seed) === Number(seed));
      const expected = backends.length * metrics.length;
      const observation = observations.find((item) => item.constellation_profile_id === profile.id && Number(item.observation_seed) === Number(seed));
      const audit = {
        constellation_profile_id: profile.id,
        constellation_label: profile.short,
        observation_seed: seed,
        expected_method_metric_rows: expected,
        actual_method_metric_rows: caseRows.length,
        same_probe_plan_all_backends: new Set(caseRows.map((row) => row.probe_plan_sha256)).size === 1,
        same_node_mask_all_backends: new Set(caseRows.map((row) => row.node_observation_mask_sha256)).size === 1,
        same_link_mask_all_backends: new Set(caseRows.map((row) => row.link_observation_mask_sha256)).size === 1,
        same_telemetry_bytes_all_backends: new Set(caseRows.map((row) => row.telemetry_total_bytes)).size === 1,
        telemetry_total_bytes: observation?.telemetry_total_bytes ?? 0,
      };
      audit.passed = audit.actual_method_metric_rows === audit.expected_method_metric_rows &&
        audit.same_probe_plan_all_backends &&
        audit.same_node_mask_all_backends &&
        audit.same_link_mask_all_backends &&
        audit.same_telemetry_bytes_all_backends;
      cases.push(audit);
    });
  });
  return { all_cases_passed: cases.every((row) => row.passed), cases };
}

function formatNumber(value, digits = 4) {
  const numeric = optionalNumber(value);
  return Number.isFinite(numeric) ? numeric.toFixed(digits) : "-";
}

function formatPercent(value, digits = 2) {
  const numeric = optionalNumber(value);
  return Number.isFinite(numeric) ? `${(numeric * 100).toFixed(digits)}%` : "-";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");
}

function chartSvg({ aggregate, profile, metric }) {
  const rows = aggregate.filter((row) => row.constellation_profile_id === profile.id && row.target_metric === metric.id);
  const width = 920;
  const height = 360;
  const margin = { left: 72, right: 24, top: 40, bottom: 86 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const maxValue = Math.max(...rows.map((row) => numberValue(row.mean_inferred_mae)), 1e-9) * 1.15;
  const barWidth = Math.min(74, plotWidth / Math.max(rows.length * 1.35, 1));
  const gap = (plotWidth - barWidth * rows.length) / Math.max(rows.length, 1);
  const colors = ["#334155", "#0f766e", "#7c3aed", "#0891b2", "#b45309", "#2563eb", "#be123c"];
  const bars = rows.map((row, index) => {
    const value = numberValue(row.mean_inferred_mae);
    const x = margin.left + gap / 2 + index * (barWidth + gap);
    const barHeight = value / maxValue * plotHeight;
    const y = margin.top + plotHeight - barHeight;
    return `<g><rect x="${x}" y="${y}" width="${barWidth}" height="${barHeight}" rx="3" fill="${colors[index % colors.length]}"/><text x="${x + barWidth / 2}" y="${Math.max(18, y - 8)}" text-anchor="middle" font-size="12" font-weight="700">${formatNumber(value, 3)}</text><text x="${x + barWidth / 2}" y="${margin.top + plotHeight + 22}" text-anchor="middle" font-size="11" transform="rotate(28 ${x + barWidth / 2} ${margin.top + plotHeight + 22})">${escapeHtml(row.backend_label)}</text></g>`;
  }).join("");
  const grid = [0, 0.25, 0.5, 0.75, 1].map((ratio) => {
    const y = margin.top + plotHeight * (1 - ratio);
    return `<line x1="${margin.left}" y1="${y}" x2="${width - margin.right}" y2="${y}" stroke="#dbe3ea"/><text x="${margin.left - 10}" y="${y + 4}" text-anchor="end" font-size="11" fill="#64748b">${formatNumber(maxValue * ratio, 2)}</text>`;
  }).join("");
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(profile.short)} ${escapeHtml(metric.label)} MAE 对比"><rect width="${width}" height="${height}" fill="#fff"/>${grid}<text x="${margin.left}" y="24" font-size="15" font-weight="700" fill="#173a5e">${escapeHtml(profile.short)} · ${escapeHtml(metric.label)} inferred MAE</text>${bars}</svg>`;
}

function buildHtml({ summary, aggregate, evidence }) {
  const profileMetricCharts = summary.profiles.flatMap((profileId) => {
    const profile = profileById(profileId);
    return summary.metrics.map((metricId) => {
      const metric = metricById(metricId);
      return `<section class="chart-card">${chartSvg({ aggregate, profile, metric })}</section>`;
    });
  }).join("");
  const heatmapRows = aggregate.map((row) => {
    const delta = numberValue(row.relative_mae_vs_low_rank);
    const intensity = Math.min(0.85, Math.abs(delta) * 1.8 + 0.08);
    const background = row.completion_backend === "low-rank"
      ? "#e2e8f0"
      : delta < 0
        ? `rgba(5,150,105,${intensity})`
        : `rgba(220,38,38,${intensity})`;
    const color = intensity > 0.45 ? "#fff" : "#0f172a";
    return `<tr><td>${escapeHtml(row.constellation_label)}</td><td>${escapeHtml(row.metric_label)}</td><td>${escapeHtml(row.backend_label)}</td><td>${formatNumber(row.mean_inferred_mae)}</td><td>${formatNumber(row.std_inferred_mae)}</td><td style="background:${background};color:${color};font-weight:800">${formatPercent(row.relative_mae_vs_low_rank)}</td><td>${formatNumber(row.mean_completion_wall_clock_ms, 2)} ms</td></tr>`;
  }).join("");
  const evidenceRows = evidence.map((row) => `<tr><td>${escapeHtml(row.constellation_label)}</td><td>${escapeHtml(row.metric_label)}</td><td>${escapeHtml(row.backend_label)}</td><td>${formatPercent(row.mean_relative_mae_delta)}</td><td>[${formatNumber(row.ci95_low_delta)}, ${formatNumber(row.ci95_high_delta)}]</td><td>${row.wins}/${row.ties}/${row.losses}</td><td>${formatPercent(row.probability_improved)}</td><td><span class="badge ${row.statistically_better_than_low_rank ? "good" : row.statistically_noninferior_2pct ? "neutral" : "warn"}">${row.statistically_better_than_low_rank ? "显著更优" : row.statistically_noninferior_2pct ? "2% 非劣" : "未通过"}</span></td></tr>`).join("");
  const fairnessRows = summary.fairness_audit.cases.map((row) => `<tr><td>${escapeHtml(row.constellation_label)}</td><td>${row.observation_seed}</td><td>${row.actual_method_metric_rows}/${row.expected_method_metric_rows}</td><td>${row.same_probe_plan_all_backends ? "是" : "否"}</td><td>${row.same_node_mask_all_backends && row.same_link_mask_all_backends ? "是" : "否"}</td><td>${row.same_telemetry_bytes_all_backends ? "是" : "否"}</td><td><span class="badge ${row.passed ? "good" : "warn"}">${row.passed ? "通过" : "失败"}</span></td></tr>`).join("");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>实验3 多种子多指标强基线</title><style>
  :root{font-family:"Microsoft YaHei","Noto Sans SC",sans-serif;color:#172033;background:#eef2f6}*{box-sizing:border-box}body{margin:0}.top{background:#102a43;color:white;padding:34px max(28px,calc((100vw - 1280px)/2)) 30px}.top h1{margin:0 0 10px;font-size:28px;letter-spacing:0}.top p{max-width:980px;margin:0;color:#d9e7f3;line-height:1.7}.wrap{max-width:1280px;margin:0 auto;padding:24px}.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-top:-45px}.kpi{background:#fff;border:1px solid #d8e1e8;border-radius:7px;padding:17px;box-shadow:0 4px 16px #102a4314}.kpi b{display:block;font-size:24px;color:#0f766e;margin-top:6px}.panel,.chart-card{background:#fff;border:1px solid #d8e1e8;border-radius:7px;padding:20px;margin:16px 0}.charts{display:grid;grid-template-columns:1fr 1fr;gap:14px}.chart-card{margin:0;padding:8px;overflow:hidden}.chart-card svg{width:100%;height:auto}.note{border-left:4px solid #0f766e;background:#ecfdf5;padding:13px 15px;line-height:1.7}.boundary{border-left-color:#b45309;background:#fff7ed}h2{font-size:20px;color:#173a5e;margin:0 0 14px}table{width:100%;border-collapse:collapse;font-size:13px}th{background:#eaf0f5;color:#173a5e;text-align:left;position:sticky;top:0}th,td{padding:9px 10px;border-bottom:1px solid #e2e8f0;white-space:nowrap}.table-wrap{overflow:auto;max-height:620px}.badge{display:inline-block;padding:3px 8px;border-radius:4px;font-weight:700}.good{background:#d1fae5;color:#065f46}.neutral{background:#dbeafe;color:#1e40af}.warn{background:#fee2e2;color:#991b1b}code{background:#eaf0f5;padding:2px 5px;border-radius:3px}@media(max-width:900px){.kpis,.charts{grid-template-columns:1fr}.wrap{padding:14px}.top{padding:26px 18px 70px}}
  </style></head><body><header class="top"><h1>实验 3：中大型星座多种子、多指标强补全基线</h1><p>在每个观测种子内固定同一 probe plan、Ground OAM observed mask 和遥测字节，仅切换补全后端。48 个时间片按长度 4 的移动时间块做配对 bootstrap，避免把相邻时间片误当作完全独立样本。</p></header><main class="wrap"><section class="kpis"><div class="kpi">星座<b>${summary.profiles.length}</b></div><div class="kpi">观测种子/星座<b>${summary.seeds.length}</b></div><div class="kpi">补全后端<b>${summary.backends.length}</b></div><div class="kpi">指标<b>${summary.metrics.length}</b></div></section>
  <section class="panel"><h2>预注册问题</h2><div class="note">在相同 INT 观测和相同遥测开销下，成熟补全后端是否能够稳定改变 CPU、队列、电量和链路利用率的 OAM 重构误差？本实验用于排除“结论仅来自一个较弱补全器”的质疑，不用于证明某个后端在所有星座上普遍最强。</div></section>
  <section class="panel"><h2>公平性门禁</h2><div class="table-wrap"><table><thead><tr><th>星座</th><th>seed</th><th>方法×指标</th><th>同路径</th><th>同 mask</th><th>同字节</th><th>结果</th></tr></thead><tbody>${fairnessRows}</tbody></table></div></section>
  <section class="panel"><h2>MAE 可视化</h2><div class="charts">${profileMetricCharts}</div></section>
  <section class="panel"><h2>相对原生低秩的误差热力表</h2><div class="table-wrap"><table><thead><tr><th>星座</th><th>指标</th><th>后端</th><th>平均 MAE</th><th>seed 标准差</th><th>相对低秩</th><th>补全计算时间</th></tr></thead><tbody>${heatmapRows}</tbody></table></div></section>
  <section class="panel"><h2>配对时间块统计</h2><div class="table-wrap"><table><thead><tr><th>星座</th><th>指标</th><th>后端</th><th>MAE 变化</th><th>均值差 95% CI</th><th>胜/平/负</th><th>改善概率</th><th>判定</th></tr></thead><tbody>${evidenceRows}</tbody></table></div></section>
  <section class="panel"><h2>证据边界</h2><div class="note boundary">本轮包含三个独立路径观测种子和一个 48 片物理运行窗口。它补强了 mask 敏感性与逐时间片统计证据，但不是三个独立轨道历元，也不能把离线 RTS 平滑解释为严格在线结果。ST-GNN 与 CoSTCo 是项目内研究实现，不冒充原论文官方代码。</div></section>
  </main></body></html>`;
}

function buildMarkdown({ summary, aggregate, evidence, outputFiles }) {
  const bestRows = summary.profiles.flatMap((profileId) => summary.metrics.map((metricId) => {
    const candidates = aggregate
      .filter((row) => row.constellation_profile_id === profileId && row.target_metric === metricId)
      .sort((left, right) => numberValue(left.mean_inferred_mae) - numberValue(right.mean_inferred_mae));
    return candidates[0];
  })).filter(Boolean);
  const significant = evidence.filter((row) => row.statistically_better_than_low_rank);
  return [
    "# 实验 3：中大型星座多种子、多指标强补全基线",
    "",
    `生成时间：${summary.generated_at}`,
    "",
    "## 实验问题",
    "",
    "在相同 INT 观测、相同 observed mask 和相同遥测开销下，比较原生低秩、SoftImpute、Kalman/RTS、图邻居、图时序正则、ST-GNN 与 CoSTCo。",
    "",
    "## 设计",
    "",
    `- 星座：${summary.profiles.join("、")}。`,
    `- 观测种子：${summary.seeds.join("、")}，每个种子覆盖 48 个时间片。`,
    `- 指标：${summary.metrics.join("、")}。`,
    "- 每个 profile/seed 内只切换补全后端，probe plan、节点/链路 mask 与实际遥测字节完全相同。",
    "- 统计：以原生低秩为配对基线，按 seed 保持序列结构，使用长度 4 的 moving-block bootstrap 计算 95% CI。",
    "- 真值只用于补全后评价，不进入采样、训练标签外的隐藏值选择或超参数回调。",
    "",
    "## 公平性",
    "",
    `- ${summary.fairness_audit.all_cases_passed ? "全部公平性门禁通过" : "存在公平性门禁失败"}。`,
    "",
    "## 各星座/指标最佳点估计",
    "",
    "| 星座 | 指标 | 最低 MAE 后端 | mean MAE | 相对低秩 |",
    "|---|---|---|---:|---:|",
    ...bestRows.map((row) => `| ${row.constellation_label} | ${row.metric_label} | ${row.backend_label} | ${formatNumber(row.mean_inferred_mae)} | ${formatPercent(row.relative_mae_vs_low_rank)} |`),
    "",
    "## 统计支持",
    "",
    significant.length > 0
      ? `共有 ${significant.length} 个“星座×指标×后端”组合的配对块 bootstrap 95% CI 完全低于 0。`
      : "尚无组合的配对块 bootstrap 95% CI 完全低于 0，当前只能报告点估计或非劣结果。",
    "",
    "| 星座 | 指标 | 后端 | MAE 变化 | 95% CI | 胜/平/负 | 判定 |",
    "|---|---|---|---:|---:|---:|---|",
    ...evidence.map((row) => `| ${row.constellation_label} | ${row.metric_label} | ${row.backend_label} | ${formatPercent(row.mean_relative_mae_delta)} | [${formatNumber(row.ci95_low_delta)}, ${formatNumber(row.ci95_high_delta)}] | ${row.wins}/${row.ties}/${row.losses} | ${row.statistically_better_than_low_rank ? "显著更优" : row.statistically_noninferior_2pct ? "2% 非劣" : "未通过"} |`),
    "",
    "## 可声明结论",
    "",
    "1. 项目已经不再依赖单一低秩补全器；所有后端具有独立调用接口和统一公平输入。",
    "2. 后端优劣具有星座与指标依赖性，不能宣称某个补全器普遍最强。",
    "3. 主创新应继续放在 LEO 主动遥测规划、拓扑版本、风险与硬预算；补全后端是可替换重构层和强基线。",
    "",
    "## 仍然保留的边界",
    "",
    "- 三个 seed 改变的是路径观测 mask；物理真值仍来自同一个 48 片运行窗口，并非三个独立轨道历元。",
    "- Kalman/RTS 是离线平滑参考，会使用窗口内未来已交付观测，不能作为严格在线部署结果。",
    "- ST-GNN、CoSTCo 是项目内研究实现，不是原论文官方代码。",
    "",
    "## 产物",
    "",
    ...Object.entries(outputFiles).map(([label, path]) => `- ${label}: \`${relativePath(path)}\``),
    "",
  ].join("\n");
}

const args = process.argv.slice(2);
const oldRoot = resolve(argValue(args, "--old-root", "reports/experiment2-native-baseline-rerun-final"));
const outputDir = resolve(argValue(args, "--out", "reports/experiment3-statistical-strong-baselines"));
const profiles = listArg(args, "--profiles", PROFILES.map((profile) => profile.id)).map(profileById);
const backends = listArg(args, "--backends", BACKENDS.map((backend) => backend.id)).map(backendById);
const metrics = listArg(args, "--metrics", METRICS.map((metric) => metric.id)).map(metricById);
const seeds = listArg(args, "--seeds", ["11", "23", "37"]).map(Number).filter(Number.isFinite);
const rank = Math.max(1, Math.floor(numberArg(args, "--rank", 5)));
const iterations = Math.max(1, Math.floor(numberArg(args, "--iterations", 12)));
const windowSize = Math.max(1, Math.floor(numberArg(args, "--window-size", 12)));
const mlEpochs = Math.max(1, Math.floor(numberArg(args, "--ml-epochs", 12)));
const mlTrainingSamples = Math.max(1, Math.floor(numberArg(args, "--ml-training-samples", 12000)));
const mlHiddenUnits = Math.max(16, Math.floor(numberArg(args, "--ml-hidden-units", 96)));
const mlHiddenLayers = Math.max(1, Math.floor(numberArg(args, "--ml-hidden-layers", 2)));
const mlLatentRank = Math.max(2, Math.floor(numberArg(args, "--ml-latent-rank", 64)));
const downlinkBudgetBytes = Math.max(0, Math.floor(numberArg(args, "--downlink-budget-bytes", 1_000_000_000)));
const resume = !hasArg(args, "--no-resume");
const retainBulk = hasArg(args, "--retain-bulk");

if (metrics.length !== METRICS.length || metrics.some((metric) => !METRICS.some((item) => item.id === metric.id))) {
  throw new Error("当前正式协议要求同时运行 cpu_percent、queue_depth、energy_percent 和 utilization_percent。可在测试时使用默认全集。");
}
if (seeds.length === 0) throw new Error("至少需要一个观测种子");
await mkdir(outputDir, { recursive: true });

const observations = [];
const rows = [];
const bySliceRows = [];

for (const profile of profiles) {
  const truthDir = join(oldRoot, profile.id, "stage1-truth");
  const sharedDir = join(outputDir, "observations", profile.id, "shared");
  const contactPlanPath = await ensureContactPlan({ profile, truthDir, sharedDir, windowSize, resume });
  for (const seed of seeds) {
    const observation = await ensureObservation({
      profile,
      seed,
      oldRoot,
      outputDir,
      contactPlanPath,
      downlinkBudgetBytes,
      resume,
      retainBulk,
    });
    observations.push(observation);
    for (const backend of backends) {
      const result = await runCompletion({
        profile,
        seed,
        backend,
        observation,
        outputDir,
        rank,
        iterations,
        windowSize,
        mlEpochs,
        mlTrainingSamples,
        mlHiddenUnits,
        mlHiddenLayers,
        mlLatentRank,
        resume,
        retainBulk,
      });
      rows.push(...result.rows);
      bySliceRows.push(...result.bySliceRows.map((row) => ({
        ...row,
        observation_seed: Number(row.observation_seed),
        slice_index: Number(row.slice_index),
        inferred_samples: Number(row.inferred_samples),
        inferred_mae: Number(row.inferred_mae),
        inferred_rmse: Number(row.inferred_rmse),
        inferred_p95_ae: Number(row.inferred_p95_ae),
      })));
      if (global.gc) global.gc();
    }
  }
}

const aggregate = aggregateRows(rows);
const { pairs, evidence } = buildPairedEvidence(bySliceRows, aggregate);
const fairnessAudit = buildFairnessAudit(rows, observations, profiles, seeds, backends, metrics);
if (!fairnessAudit.all_cases_passed) {
  throw new Error(`实验 3 公平性门禁失败: ${JSON.stringify(fairnessAudit.cases.filter((row) => !row.passed))}`);
}

const outputFiles = {
  raw_csv: join(outputDir, "experiment3-statistical-raw.csv"),
  by_slice_csv: join(outputDir, "experiment3-statistical-by-slice.csv"),
  aggregate_csv: join(outputDir, "experiment3-statistical-aggregate.csv"),
  paired_evidence_csv: join(outputDir, "experiment3-statistical-paired-evidence.csv"),
  paired_samples_csv: join(outputDir, "experiment3-statistical-paired-samples.csv"),
  summary_json: join(outputDir, "experiment3-statistical-summary.json"),
  report_md: join(outputDir, "EXPERIMENT_3_STATISTICAL_STRONG_BASELINES.md"),
  report_html: join(outputDir, "index.html"),
};

const summary = {
  schema_version: "experiment3-statistical-strong-baselines-v1",
  generated_at: new Date().toISOString(),
  objective: "同一 INT 观测和遥测开销下，对中大型 LEO 星座的多指标补全后端进行多观测种子配对统计。",
  status: "complete",
  old_root: oldRoot,
  output_dir: outputDir,
  profiles: profiles.map((profile) => profile.id),
  seeds,
  backends: backends.map((backend) => backend.id),
  metrics: metrics.map((metric) => metric.id),
  parameters: {
    rank,
    iterations,
    window_size: windowSize,
    ml_epochs: mlEpochs,
    ml_training_samples: mlTrainingSamples,
    ml_hidden_units: mlHiddenUnits,
    ml_hidden_layers: mlHiddenLayers,
    ml_latent_rank: mlLatentRank,
    bootstrap_type: "paired-moving-block",
    bootstrap_block_length_slices: 4,
    bootstrap_iterations: 4000,
  },
  protocol: {
    observation_seed_unit: "seeded path-level INT observation mask",
    slices_per_seed: 48,
    same_probe_plan_within_profile_seed: true,
    same_node_and_link_observed_mask_within_profile_seed: true,
    same_actual_telemetry_bytes_within_profile_seed: true,
    hidden_truth_used_only_for_posthoc_evaluation: true,
    low_rank_is_paired_reference: true,
    kalman_rts_is_offline_noncausal_reference: true,
    stage1_truth_window_count: 1,
    independent_orbit_epoch_count: 1,
  },
  fairness_audit: fairnessAudit,
  observations,
  row_counts: {
    raw: rows.length,
    by_slice: bySliceRows.length,
    aggregate: aggregate.length,
    paired_evidence: evidence.length,
    paired_samples: pairs.length,
  },
  output_files: Object.fromEntries(Object.entries(outputFiles).map(([key, path]) => [key, relativePath(path)])),
};

await Promise.all([
  writeFile(outputFiles.raw_csv, rowsToCsv(rows), "utf8"),
  writeFile(outputFiles.by_slice_csv, rowsToCsv(bySliceRows), "utf8"),
  writeFile(outputFiles.aggregate_csv, rowsToCsv(aggregate), "utf8"),
  writeFile(outputFiles.paired_evidence_csv, rowsToCsv(evidence), "utf8"),
  writeFile(outputFiles.paired_samples_csv, rowsToCsv(pairs), "utf8"),
  writeFile(outputFiles.summary_json, JSON.stringify({ ...summary, aggregate, paired_evidence: evidence }, null, 2), "utf8"),
  writeFile(outputFiles.report_md, buildMarkdown({ summary, aggregate, evidence, outputFiles }), "utf8"),
  writeFile(outputFiles.report_html, buildHtml({ summary, aggregate, evidence }), "utf8"),
]);

console.log(JSON.stringify({
  ok: true,
  output_dir: outputDir,
  report_html: outputFiles.report_html,
  report_md: outputFiles.report_md,
  profiles: summary.profiles,
  seeds,
  backends: summary.backends,
  metrics: summary.metrics,
  fairness_passed: fairnessAudit.all_cases_passed,
  statistically_better_combinations: evidence.filter((row) => row.statistically_better_than_low_rank).length,
}, null, 2));
