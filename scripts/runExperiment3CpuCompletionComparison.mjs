import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

const PROFILES = [
  { id: "iridium-next-small", label: "Iridium NEXT 6x11", short_label: "Iridium 66", scale: "small" },
  { id: "telesat-1015-medium", label: "Telesat-1015 27x13", short_label: "Telesat 351", scale: "medium" },
  { id: "starlink-main-large", label: "Starlink main shell 72x22", short_label: "Starlink 1584", scale: "large" },
];

const BACKENDS = [
  {
    id: "prior-only",
    label: "结构先验基线",
    family: "no-learning-structural-prior",
    principle: "只使用时间、轨道邻居和空间分组初始化，不执行后续学习",
  },
  {
    id: "low-rank",
    label: "原生低秩 INT-MC",
    family: "matrix-completion-baseline",
    principle: "迭代低秩投影并锁定直接观测值",
  },
  {
    id: "soft-impute",
    label: "Soft-Impute",
    family: "nuclear-norm-matrix-completion",
    principle: "通过奇异值软阈值近似核范数正则化",
  },
  {
    id: "kalman-smoother",
    label: "Kalman/RTS 时间平滑",
    family: "offline-state-space-temporal-baseline",
    principle: "对每个节点的已交付观测执行局部水平 Kalman 滤波和 RTS 后向平滑",
  },
  {
    id: "graph-neighbor",
    label: "轨道图邻居插值",
    family: "nonparametric-orbit-graph-baseline",
    principle: "只使用同一时间片活动轨道图邻居进行谐波式插值，不使用低秩或未来时间信息",
  },
  {
    id: "graph-regularized",
    label: "图正则补全",
    family: "graph-temporal-regularized-completion",
    principle: "联合轨道图邻居、时间连续性、先验和低秩目标",
  },
  {
    id: "st-gnn",
    label: "研究规模 ST-GNN",
    family: "spatio-temporal-graph-ml",
    principle: "图消息传递、时间残差特征和多层感知机",
  },
  {
    id: "costco",
    label: "研究规模 CoSTCo",
    family: "coordinate-tensor-ml",
    principle: "节点/时间坐标嵌入和非线性张量分解",
  },
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
  if (raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function listArg(args, name, fallback) {
  return argValue(args, name, fallback.join(",")).split(",").map((item) => item.trim()).filter(Boolean);
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
  const text = value === undefined || value === null ? "" : String(value);
  if (!/[",\n\r]/.test(text)) return text;
  return `"${text.replaceAll("\"", "\"\"")}"`;
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

function observationMaskSha256(rows) {
  const projection = rows
    .map((row) => `${row.slice_index}|${row.node_id}|${String(row.observed).toLowerCase()}`)
    .sort()
    .join("\n");
  return sha256(projection);
}

function numberValue(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function optionalNumber(value) {
  if (value === "" || value === null || value === undefined) return NaN;
  return numberValue(value, NaN);
}

function round(value, digits = 4) {
  if (!Number.isFinite(value)) return "";
  return Number(value.toFixed(digits));
}

function mean(values) {
  const usable = values.filter(Number.isFinite);
  return usable.length ? usable.reduce((total, value) => total + value, 0) / usable.length : 0;
}

function percentile(values, p) {
  const usable = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (usable.length === 0) return 0;
  return usable[Math.min(usable.length - 1, Math.max(0, Math.floor((usable.length - 1) * p)))];
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

function formatNumber(value, digits = 3) {
  const number = numberValue(value, NaN);
  return Number.isFinite(number) ? number.toFixed(digits) : "-";
}

function formatPercent(value, digits = 2) {
  const number = numberValue(value, NaN);
  return Number.isFinite(number) ? `${(number * 100).toFixed(digits)}%` : "-";
}

function formatSignedPercent(value, digits = 2) {
  const number = numberValue(value, NaN);
  if (!Number.isFinite(number)) return "-";
  const prefix = number > 0 ? "+" : "";
  return `${prefix}${(number * 100).toFixed(digits)}%`;
}

function formatBytes(value) {
  const bytes = numberValue(value, NaN);
  if (!Number.isFinite(bytes)) return "-";
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(2)} MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(2)} KB`;
  return `${bytes.toFixed(0)} B`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");
}

function parseLastJson(stdout, label) {
  const trimmed = stdout.trim();
  if (!trimmed) return {};
  const start = trimmed.lastIndexOf("\n{");
  const jsonText = start >= 0 ? trimmed.slice(start + 1) : trimmed;
  try {
    return JSON.parse(jsonText);
  } catch (error) {
    throw new Error(`${label} did not end with JSON: ${error.message}\n${trimmed.slice(-1200)}`);
  }
}

function runNode(label, script, args) {
  return new Promise((resolvePromise, reject) => {
    console.log(`[experiment3:cpu] ${label}`);
    const child = spawn(process.execPath, [script, ...args], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      const lastLine = text.trim().split(/\r?\n/).filter(Boolean).at(-1);
      if (lastLine && !lastLine.startsWith("{")) console.log(`  ${lastLine}`);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Command failed: node ${script} ${args.join(" ")}\n${stderr || stdout}`));
        return;
      }
      resolvePromise(parseLastJson(stdout, label));
    });
  });
}

function requireFile(path, label) {
  if (!existsSync(path)) throw new Error(`${label} not found: ${path}`);
}

function profileById(id) {
  const profile = PROFILES.find((item) => item.id === id);
  if (!profile) throw new Error(`Unknown profile: ${id}`);
  return profile;
}

function backendById(id) {
  const backend = BACKENDS.find((item) => item.id === id);
  if (!backend) throw new Error(`Unknown backend: ${id}`);
  return backend;
}

function buildFairnessAudit(rows, profiles, backends) {
  const byProfile = profiles.map((profile) => {
    const profileRows = rows.filter((row) => row.constellation_profile_id === profile.id);
    const audit = {
      constellation_profile_id: profile.id,
      expected_backend_count: backends.length,
      actual_backend_count: profileRows.length,
      same_observation_mask_all_backends: new Set(profileRows.map((row) => row.observation_mask_sha256)).size === 1,
      same_ground_oam_nodes_all_backends: new Set(profileRows.map((row) => row.ground_oam_nodes_sha256)).size === 1,
      same_probe_plan_all_backends: new Set(profileRows.map((row) => row.probe_plan_sha256)).size === 1,
      same_telemetry_bytes_all_backends: new Set(profileRows.map((row) => row.telemetry_total_bytes)).size === 1,
      same_direct_observation_rate_all_backends: new Set(profileRows.map((row) => row.direct_node_observation_rate)).size === 1,
    };
    audit.passed =
      audit.actual_backend_count === audit.expected_backend_count &&
      audit.same_observation_mask_all_backends &&
      audit.same_ground_oam_nodes_all_backends &&
      audit.same_probe_plan_all_backends &&
      audit.same_telemetry_bytes_all_backends &&
      audit.same_direct_observation_rate_all_backends;
    return audit;
  });
  return {
    all_profiles_passed: byProfile.every((row) => row.passed),
    by_profile: byProfile,
  };
}

function collectBySlice({ profile, backend, nodeErrorRows }) {
  const rowsBySlice = groupBy(nodeErrorRows.filter((row) => row.observation_source === "inferred"), (row) => row.slice_index);
  return [...rowsBySlice.entries()]
    .sort(([left], [right]) => Number(left) - Number(right))
    .map(([sliceIndex, rows]) => {
      const errors = rows.map((row) => numberValue(row.cpu_error, NaN)).filter(Number.isFinite);
      const absErrors = errors.map((value) => Math.abs(value));
      return {
        constellation_profile_id: profile.id,
        constellation_short_label: profile.short_label,
        scale: profile.scale,
        completion_backend: backend.id,
        backend_label: backend.label,
        slice_index: Number(sliceIndex),
        inferred_cpu_samples: rows.length,
        cpu_inferred_mae: round(mean(absErrors)),
        cpu_inferred_rmse: round(Math.sqrt(mean(errors.map((value) => value * value)))),
        cpu_inferred_p95_ae: round(percentile(absErrors, 0.95)),
        high_cpu_truth_samples: rows.filter((row) => String(row.cpu_percent_estimate) !== "" && numberValue(row.truth_cpu_percent) >= 80).length,
        high_cpu_estimate_samples: rows.filter((row) => String(row.cpu_percent_estimate) !== "" && numberValue(row.cpu_percent_estimate) >= 80).length,
      };
    });
}

async function runObservationPipeline({
  profile,
  truthDir,
  candidatePathsPath,
  stage2Dir,
  observedGroundDir,
  samplingRate,
  targetActiveLinkSamplingRate,
  rank,
  windowSize,
  warmupSlices,
  downlinkBudgetBytes,
  maxPathsPerSlice,
  skipExisting,
}) {
  await mkdir(stage2Dir, { recursive: true });
  await mkdir(observedGroundDir, { recursive: true });
  const predictedContactPlanPath = join(stage2Dir, "predicted-contact-plan.json");
  const observedNodesPath = join(observedGroundDir, "ground-reconstructed-nodes.csv");
  const observedLinksPath = join(observedGroundDir, "ground-reconstructed-links.csv");
  if (skipExisting && existsSync(predictedContactPlanPath) && existsSync(observedNodesPath) && existsSync(observedLinksPath)) {
    return { predictedContactPlanPath, reused: true };
  }

  await runNode(`${profile.short_label}: contact plan`, "stage2-int/tools/predict-contact-plan.mjs", [
    "--input", truthDir,
    "--out", stage2Dir,
    "--completion-window-slices", String(windowSize),
  ]);
  await runNode(`${profile.short_label}: INT-MC path selection`, "stage2-int/tools/int-mc-path-selector.mjs", [
    "--input", truthDir,
    "--stage2", stage2Dir,
    "--out", stage2Dir,
    "--algorithm", "int-mc",
    "--candidate-algorithm", "path-balance",
    "--candidate-paths", candidatePathsPath,
    "--sampling-rate", String(samplingRate),
    "--target-active-link-sampling-rate", String(targetActiveLinkSamplingRate),
    "--rank", String(rank),
    "--selection-strategy", "int-mc-leverage",
    "--window-size", String(windowSize),
    "--warmup-slices", String(warmupSlices),
    "--max-paths-per-slice", String(maxPathsPerSlice),
    "--predicted-contact-plan", predictedContactPlanPath,
  ]);
  await runNode(`${profile.short_label}: reporting paths`, "stage2-int/tools/reporting-path-planner.mjs", [
    "--input", truthDir,
    "--stage2", stage2Dir,
    "--out", stage2Dir,
    "--algorithm", "int-mc",
    "--probes", join(stage2Dir, "probe-paths-int-mc.csv"),
  ]);
  await runNode(`${profile.short_label}: probe INT`, "stage2-int/tools/probe-int-runner.mjs", [
    "--input", truthDir,
    "--stage2", stage2Dir,
    "--out", stage2Dir,
    "--algorithm", "int-mc",
  ]);
  await runNode(`${profile.short_label}: Ground OAM observed view`, "stage2-int/tools/ground-oam-reconstructor.mjs", [
    "--input", truthDir,
    "--stage2", stage2Dir,
    "--out", observedGroundDir,
    "--hops", join(stage2Dir, "probe-int-hop-records-int-mc.csv"),
    "--reports", join(stage2Dir, "probe-int-reports-int-mc.csv"),
    "--downlink-budget-bytes", String(downlinkBudgetBytes),
  ]);
  return { predictedContactPlanPath, reused: false };
}

async function runCompletionBackend({
  profile,
  backend,
  truthDir,
  stage2Dir,
  observedGroundDir,
  backendGroundDir,
  predictedContactPlanPath,
  rank,
  windowSize,
  iterations,
  mlEpochs,
  mlTrainingSamples,
  mlHiddenUnits,
  mlHiddenLayers,
  mlLatentRank,
  softImputeLambdaRatio,
  kalmanProcessVariance,
  kalmanMeasurementVariance,
  kalmanInitialVariance,
  graphRegularizationWeight,
  temporalRegularizationWeight,
  priorRegularizationWeight,
  lowRankRegularizationWeight,
  compactArtifacts,
  fingerprints,
  skipExisting,
}) {
  await mkdir(backendGroundDir, { recursive: true });
  const evaluationPath = join(backendGroundDir, "int-mc-evaluation.json");
  const completionReused = skipExisting && existsSync(evaluationPath);
  let completionProcessWallClockMs = "";
  if (!completionReused) {
    const args = [
      "--input", truthDir,
      "--stage2", stage2Dir,
      "--ground", observedGroundDir,
      "--out", backendGroundDir,
      "--algorithm", "int-mc",
      "--rank", String(rank),
      "--window-size", String(windowSize),
      "--iterations", String(iterations),
      "--completion-backend", backend.id,
      "--link-metrics", "none",
      "--node-metrics", "cpu_percent",
      "--predicted-contact-plan", predictedContactPlanPath,
      "--soft-impute-lambda-ratio", String(softImputeLambdaRatio),
      "--kalman-process-variance", String(kalmanProcessVariance),
      "--kalman-measurement-variance", String(kalmanMeasurementVariance),
      "--kalman-initial-variance", String(kalmanInitialVariance),
      "--graph-regularization-weight", String(graphRegularizationWeight),
      "--temporal-regularization-weight", String(temporalRegularizationWeight),
      "--prior-regularization-weight", String(priorRegularizationWeight),
      "--low-rank-regularization-weight", String(lowRankRegularizationWeight),
    ];
    if (compactArtifacts) args.push("--write-link-artifacts", "false");
    if (["st-gnn", "costco"].includes(backend.id)) {
      args.push(
        "--ml-epochs", String(mlEpochs),
        "--ml-training-samples", String(mlTrainingSamples),
        "--ml-hidden-units", String(mlHiddenUnits),
        "--ml-hidden-layers", String(mlHiddenLayers),
      );
      if (backend.id === "costco") args.push("--ml-latent-rank", String(mlLatentRank));
    }
    const startedAt = performance.now();
    await runNode(`${profile.short_label}: completion ${backend.id}`, "stage2-int/tools/int-mc-reconstructor.mjs", args);
    completionProcessWallClockMs = round(performance.now() - startedAt, 3);
  }

  const [metadata, runReport, evaluation, nodeErrors] = await Promise.all([
    readJson(join(truthDir, "metadata.json")),
    readJson(join(stage2Dir, "probe-int-run-report-int-mc.json")),
    readJson(evaluationPath),
    readCsv(join(backendGroundDir, "int-mc-node-errors.csv")),
  ]);
  const cpu = evaluation.node_reconstruction?.metrics?.cpu_percent ?? {};
  const nodeReconstruction = evaluation.node_reconstruction ?? {};
  const matrixSummary = (evaluation.node_matrix_summaries ?? []).find((row) => row.metric === "cpu_percent") ?? {};
  const overhead = runReport.overhead ?? {};
  const nodes = numberValue(metadata.node_count ?? metadata.nodes_per_slice, 0);
  const slices = numberValue(metadata.slice_count ?? metadata.time_slices, 0);
  const totalBytes = numberValue(overhead.total_telemetry_generated_bytes, 0);
  return {
    row: {
      constellation_profile_id: profile.id,
      constellation_short_label: profile.short_label,
      scale: profile.scale,
      completion_backend: backend.id,
      backend_label: backend.label,
      backend_family: backend.family,
      backend_principle: backend.principle,
      metric_scope: "node",
      target_metric: "cpu_percent",
      node_count: nodes,
      slice_count: slices,
      observed_node_samples: numberValue(nodeReconstruction.observed_node_samples),
      inferred_node_samples: numberValue(nodeReconstruction.inferred_node_samples),
      node_completion_coverage: round(numberValue(nodeReconstruction.node_completion_coverage)),
      direct_node_observation_rate: round(numberValue(nodeReconstruction.direct_observation_rate)),
      inferred_node_rate: round(numberValue(nodeReconstruction.inferred_rate)),
      cpu_mae: cpu.mae ?? "",
      cpu_rmse: cpu.rmse ?? "",
      cpu_p95_ae: cpu.p95_ae ?? "",
      cpu_r2: cpu.r2 ?? "",
      cpu_inferred_mae: cpu.inferred_mae ?? "",
      cpu_inferred_rmse: cpu.inferred_rmse ?? "",
      cpu_inferred_p95_ae: cpu.inferred_p95_ae ?? "",
      cpu_inferred_max_ae: cpu.inferred_max_ae ?? "",
      cpu_inferred_smape: cpu.inferred_smape ?? "",
      cpu_inferred_r2: cpu.inferred_r2 ?? "",
      cpu_inferred_within_5_units_rate: cpu.inferred_within_5_units_rate ?? "",
      cpu_inferred_within_10_units_rate: cpu.inferred_within_10_units_rate ?? "",
      cpu_high_threshold: cpu.class_threshold ?? 80,
      cpu_high_precision: cpu.inferred_high_precision ?? "",
      cpu_high_recall: cpu.inferred_high_recall ?? "",
      cpu_high_f1: cpu.inferred_high_f1 ?? "",
      cpu_high_actual_support: cpu.inferred_high_actual_support ?? "",
      cpu_high_predicted_support: cpu.inferred_high_predicted_support ?? "",
      telemetry_total_bytes: totalBytes,
      telemetry_bytes_per_node_slice: round(totalBytes / Math.max(nodes * slices, 1), 4),
      telemetry_total_energy_j: numberValue(overhead.total_telemetry_energy_j),
      hop_records: numberValue(overhead.hop_records),
      observation_mask_sha256: fingerprints.observation_mask_sha256,
      ground_oam_nodes_sha256: fingerprints.ground_oam_nodes_sha256,
      probe_plan_sha256: fingerprints.probe_plan_sha256,
      completion_reused: completionReused,
      completion_wall_clock_ms: matrixSummary.completion_wall_clock_ms ?? "",
      completion_process_wall_clock_ms: completionProcessWallClockMs,
      completion_algorithm: matrixSummary.completion_algorithm ?? backend.id,
      artifact_scope: compactArtifacts ? "node-metric-compact" : "full",
      link_artifacts_written: evaluation.boundary?.link_artifacts_written ?? !compactArtifacts,
      completion_iterations: matrixSummary.completion_iterations ?? iterations,
      effective_rank: matrixSummary.effective_rank ?? matrixSummary.low_rank_target_effective_rank ?? "",
      soft_impute_lambda_ratio: matrixSummary.soft_impute_lambda_ratio ?? "",
      kalman_process_variance: matrixSummary.kalman_process_variance ?? "",
      kalman_measurement_variance: matrixSummary.kalman_measurement_variance ?? "",
      kalman_initial_variance: matrixSummary.kalman_initial_variance ?? "",
      uses_future_delivered_observations: matrixSummary.uses_future_delivered_observations ?? "",
      online_causal: matrixSummary.online_causal ?? "",
      graph_neighbor_weight: matrixSummary.graph_neighbor_weight ?? "",
      graph_neighbor_prior_weight: matrixSummary.graph_neighbor_prior_weight ?? "",
      graph_regularization_weight: matrixSummary.graph_regularization_weight ?? "",
      temporal_regularization_weight: matrixSummary.temporal_regularization_weight ?? "",
      prior_regularization_weight: matrixSummary.prior_regularization_weight ?? "",
      low_rank_regularization_weight: matrixSummary.low_rank_regularization_weight ?? "",
      ml_model_architecture: matrixSummary.ml_model_architecture ?? "",
      ml_epochs: matrixSummary.ml_epochs ?? "",
      ml_training_samples: matrixSummary.ml_training_samples ?? "",
      ml_hidden_units: matrixSummary.ml_hidden_units ?? "",
      ml_hidden_layers: matrixSummary.ml_hidden_layers ?? "",
      ml_latent_rank: matrixSummary.ml_latent_rank ?? "",
      ml_parameter_count: matrixSummary.ml_parameter_count ?? "",
      report_json: evaluationPath,
      reconstructed_nodes_csv: join(backendGroundDir, "ground-mc-reconstructed-nodes.csv"),
      node_errors_csv: join(backendGroundDir, "int-mc-node-errors.csv"),
    },
    bySlice: collectBySlice({ profile, backend, nodeErrorRows: nodeErrors }),
  };
}

function svgGroupedBars({ rows, field, title, formatter = formatNumber, lowerIsBetter = true, width = 1080, height = 380 }) {
  const profiles = PROFILES.filter((profile) => rows.some((row) => row.constellation_profile_id === profile.id));
  const backends = BACKENDS.filter((backend) => rows.some((row) => row.completion_backend === backend.id));
  const legendColumns = Math.min(4, Math.max(backends.length, 1));
  const legendRows = Math.ceil(backends.length / legendColumns);
  const margin = { top: 48 + legendRows * 20, right: 24, bottom: 64, left: 84 };
  const values = rows.map((row) => optionalNumber(row[field])).filter(Number.isFinite);
  const rawMin = Math.min(0, ...values);
  const rawMax = Math.max(0, ...values);
  const valueRange = Math.max(rawMax - rawMin, 1e-9);
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const groupWidth = plotWidth / Math.max(profiles.length, 1);
  const barWidth = Math.max(18, Math.min(46, groupWidth / Math.max(backends.length + 1, 1)));
  const colors = {
    "prior-only": "#94a3b8",
    "low-rank": "#475569",
    "soft-impute": "#0f766e",
    "kalman-smoother": "#7c3aed",
    "graph-neighbor": "#0891b2",
    "graph-regularized": "#a16207",
    "st-gnn": "#2563eb",
    costco: "#dc2626",
  };
  const y = (value) => margin.top + plotHeight - ((numberValue(value) - rawMin) / valueRange) * plotHeight;
  const zeroBaselineY = y(0);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((ratio) => {
    const value = rawMin + valueRange * ratio;
    const tickY = margin.top + plotHeight - ratio * plotHeight;
    return `<line x1="${margin.left}" x2="${width - margin.right}" y1="${tickY}" y2="${tickY}" stroke="#e2e8f0"></line><text x="${margin.left - 8}" y="${tickY + 4}" text-anchor="end" font-size="11">${escapeHtml(formatter(value))}</text>`;
  }).join("");
  const bars = profiles.flatMap((profile, profileIndex) =>
    backends.map((backend, backendIndex) => {
      const row = rows.find((item) => item.constellation_profile_id === profile.id && item.completion_backend === backend.id) ?? {};
      const value = optionalNumber(row[field]);
      if (!Number.isFinite(value)) return "";
      const x = margin.left + profileIndex * groupWidth + groupWidth / 2 - (backends.length * barWidth) / 2 + backendIndex * barWidth;
      const valueY = y(value);
      const top = Math.min(valueY, zeroBaselineY);
      const barHeight = Math.max(1, Math.abs(valueY - zeroBaselineY));
      return `<rect x="${x}" y="${top}" width="${barWidth - 2}" height="${barHeight}" rx="2" fill="${colors[backend.id]}"><title>${escapeHtml(profile.short_label)} / ${escapeHtml(backend.label)}: ${escapeHtml(formatter(value))}</title></rect>`;
    })
  ).join("");
  const labels = profiles.map((profile, index) =>
    `<text x="${margin.left + index * groupWidth + groupWidth / 2}" y="${height - 34}" text-anchor="middle" font-size="12">${escapeHtml(profile.short_label)}</text>`
  ).join("");
  const legend = backends.map((backend, index) => {
    const x = margin.left + (index % legendColumns) * 235;
    const y = 32 + Math.floor(index / legendColumns) * 20;
    return `<rect x="${x}" y="${y}" width="10" height="10" fill="${colors[backend.id]}"></rect><text x="${x + 14}" y="${y + 10}" font-size="11">${escapeHtml(backend.label)}</text>`;
  }).join("");
  const note = lowerIsBetter ? "lower is better" : "higher is better";
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(title)}">
    <text x="${margin.left}" y="18" font-size="16" font-weight="700">${escapeHtml(title)} (${note})</text>
    ${legend}
    ${ticks}
    <line x1="${margin.left}" x2="${margin.left}" y1="${margin.top}" y2="${margin.top + plotHeight}" stroke="#64748b"></line>
    <line x1="${margin.left}" x2="${width - margin.right}" y1="${margin.top + plotHeight}" y2="${margin.top + plotHeight}" stroke="#64748b"></line>
    <line x1="${margin.left}" x2="${width - margin.right}" y1="${zeroBaselineY}" y2="${zeroBaselineY}" stroke="#475569" stroke-width="1.2"></line>
    ${bars}
    ${labels}
  </svg>`;
}

function buildLowRankDeltaRows(rows) {
  return PROFILES.filter((profile) => rows.some((row) => row.constellation_profile_id === profile.id)).flatMap((profile) => {
    const baseline = rows.find((row) => row.constellation_profile_id === profile.id && row.completion_backend === "low-rank");
    if (!baseline) return [];
    const relativeDelta = (field, candidate) => {
      const reference = optionalNumber(baseline[field]);
      const value = optionalNumber(candidate[field]);
      return Number.isFinite(reference) && Number.isFinite(value)
        ? (value - reference) / Math.max(Math.abs(reference), 1e-9)
        : NaN;
    };
    return rows
      .filter((row) => row.constellation_profile_id === profile.id && row.completion_backend !== "low-rank")
      .map((row) => ({
        constellation_profile_id: profile.id,
        constellation_short_label: profile.short_label,
        completion_backend: row.completion_backend,
        backend_label: row.backend_label,
        mae_delta_ratio: relativeDelta("cpu_inferred_mae", row),
        rmse_delta_ratio: relativeDelta("cpu_inferred_rmse", row),
        p95_delta_ratio: relativeDelta("cpu_inferred_p95_ae", row),
        r2_delta: optionalNumber(row.cpu_inferred_r2) - optionalNumber(baseline.cpu_inferred_r2),
        runtime_delta_ratio: relativeDelta("completion_wall_clock_ms", row),
        telemetry_delta_ratio: relativeDelta("telemetry_total_bytes", row),
      }));
  });
}

function buildHtml({ rows, bySliceRows, outputFiles, outputDir, summary }) {
  const methodCount = new Set(rows.map((row) => row.completion_backend)).size;
  const methodRows = BACKENDS.filter((backend) => rows.some((row) => row.completion_backend === backend.id))
    .map((backend) => `<tr><td>${escapeHtml(backend.label)}</td><td><code>${backend.id}</code></td><td>${escapeHtml(backend.family)}</td><td>${escapeHtml(backend.principle)}</td></tr>`)
    .join("");
  const fairnessRows = summary.fairness_audit.by_profile.map((audit) => `<tr>
    <td>${escapeHtml(PROFILES.find((profile) => profile.id === audit.constellation_profile_id)?.short_label ?? audit.constellation_profile_id)}</td>
    <td>${audit.actual_backend_count}/${audit.expected_backend_count}</td>
    <td>${audit.same_observation_mask_all_backends ? "通过" : "失败"}</td>
    <td>${audit.same_ground_oam_nodes_all_backends ? "通过" : "失败"}</td>
    <td>${audit.same_probe_plan_all_backends ? "通过" : "失败"}</td>
    <td>${audit.same_telemetry_bytes_all_backends ? "通过" : "失败"}</td>
    <td>${audit.passed ? "通过" : "失败"}</td>
  </tr>`).join("");
  const bestRows = PROFILES.filter((profile) => rows.some((row) => row.constellation_profile_id === profile.id)).map((profile) => {
    const candidates = rows
      .filter((row) => row.constellation_profile_id === profile.id && row.cpu_inferred_mae !== "")
      .sort((left, right) => numberValue(left.cpu_inferred_mae, Infinity) - numberValue(right.cpu_inferred_mae, Infinity));
    const best = candidates[0];
    return `<li><strong>${escapeHtml(profile.short_label)}</strong>：最低 inferred MAE 为 <code>${best ? escapeHtml(best.backend_label) : "-"}</code>，${best ? formatNumber(best.cpu_inferred_mae, 4) : "-"}。</li>`;
  }).join("");
  const stGnnPriorDeltas = PROFILES.map((profile) => {
    const prior = rows.find((row) => row.constellation_profile_id === profile.id && row.completion_backend === "prior-only");
    const stGnn = rows.find((row) => row.constellation_profile_id === profile.id && row.completion_backend === "st-gnn");
    return Math.abs(optionalNumber(prior?.cpu_inferred_mae) - optionalNumber(stGnn?.cpu_inferred_mae));
  }).filter(Number.isFinite);
  const maximumStGnnPriorDelta = stGnnPriorDeltas.length ? Math.max(...stGnnPriorDeltas) : NaN;
  const stGnnConclusionItem = stGnnPriorDeltas.length
    ? `<li><strong>ST-GNN 与结构先验几乎重合：</strong>已运行规模中的 inferred MAE 最大差值仅 ${formatNumber(maximumStGnnPriorDelta, 4)}，说明当前训练配置没有学习到稳定的额外残差，应作为后续改进对象，而不是性能提升证据。</li>`
    : "";
  const bestBackendIds = PROFILES.filter((profile) => rows.some((row) => row.constellation_profile_id === profile.id))
    .map((profile) => rows
      .filter((row) => row.constellation_profile_id === profile.id && row.cpu_inferred_mae !== "")
      .sort((left, right) => numberValue(left.cpu_inferred_mae, Infinity) - numberValue(right.cpu_inferred_mae, Infinity))[0]?.completion_backend)
    .filter(Boolean);
  const universalBest = new Set(bestBackendIds).size === 1
    ? BACKENDS.find((backend) => backend.id === bestBackendIds[0])
    : null;
  const scaleConclusion = universalBest
    ? `当前固定掩码下，${universalBest.label} 在所有已运行规模取得最低 inferred MAE。`
    : "当前固定掩码下不存在跨全部规模统一最优的补全后端，方法优劣具有规模依赖性。";
  const kalmanTradeoffRows = PROFILES.filter((profile) => rows.some((row) => row.constellation_profile_id === profile.id))
    .map((profile) => {
      const lowRank = rows.find((row) => row.constellation_profile_id === profile.id && row.completion_backend === "low-rank");
      const kalman = rows.find((row) => row.constellation_profile_id === profile.id && row.completion_backend === "kalman-smoother");
      if (!lowRank || !kalman) return null;
      const lowRankMae = optionalNumber(lowRank.cpu_inferred_mae);
      const kalmanMae = optionalNumber(kalman.cpu_inferred_mae);
      const lowRankTime = optionalNumber(lowRank.completion_wall_clock_ms);
      const kalmanTime = optionalNumber(kalman.completion_wall_clock_ms);
      return {
        label: profile.short_label,
        maeDeltaRatio: (kalmanMae - lowRankMae) / Math.max(Math.abs(lowRankMae), 1e-9),
        runtimeReductionRatio: Number.isFinite(lowRankTime) && Number.isFinite(kalmanTime)
          ? (lowRankTime - kalmanTime) / Math.max(lowRankTime, 1e-9)
          : NaN,
      };
    })
    .filter(Boolean);
  const kalmanTradeoffItems = kalmanTradeoffRows.map((row) =>
    `<li><strong>${escapeHtml(row.label)} 的 Kalman/RTS 权衡：</strong>相对低秩 MAE 变化 ${formatPercent(row.maeDeltaRatio)}，补全墙钟时间下降 ${formatPercent(row.runtimeReductionRatio)}。</li>`).join("");
  const lowRankDeltaRows = buildLowRankDeltaRows(rows);
  const strongBaselineItems = lowRankDeltaRows
    .filter((row) => ["soft-impute", "graph-regularized"].includes(row.completion_backend))
    .map((row) => `<li><strong>${escapeHtml(row.constellation_short_label)} / ${escapeHtml(row.backend_label)}：</strong>相对低秩，MAE ${formatSignedPercent(row.mae_delta_ratio)}、RMSE ${formatSignedPercent(row.rmse_delta_ratio)}、P95 ${formatSignedPercent(row.p95_delta_ratio)}，R² 差值 ${row.r2_delta > 0 ? "+" : ""}${formatNumber(row.r2_delta, 4)}；遥测开销不变。</li>`)
    .join("");
  const lowRankComparisonRows = lowRankDeltaRows.map((row) => `<tr>
    <td>${escapeHtml(row.constellation_short_label)}</td>
    <td>${escapeHtml(row.backend_label)}</td>
    <td>${formatSignedPercent(row.mae_delta_ratio)}</td>
    <td>${formatSignedPercent(row.rmse_delta_ratio)}</td>
    <td>${formatSignedPercent(row.p95_delta_ratio)}</td>
    <td>${Number.isFinite(row.r2_delta) ? `${row.r2_delta > 0 ? "+" : ""}${formatNumber(row.r2_delta, 4)}` : "-"}</td>
    <td>${formatSignedPercent(row.runtime_delta_ratio)}</td>
    <td>${formatSignedPercent(row.telemetry_delta_ratio)}</td>
  </tr>`).join("");
  const tableRows = rows.map((row) => `<tr data-profile="${escapeHtml(row.constellation_profile_id)}" data-backend="${escapeHtml(row.completion_backend)}">
    <td>${escapeHtml(row.constellation_short_label)}</td>
    <td>${escapeHtml(row.backend_label)}</td>
    <td>${escapeHtml(row.backend_family)}</td>
    <td>${formatPercent(row.direct_node_observation_rate)}</td>
    <td>${formatPercent(row.node_completion_coverage)}</td>
    <td>${row.cpu_inferred_mae === "" ? "-" : formatNumber(row.cpu_inferred_mae, 4)}</td>
    <td>${row.cpu_inferred_rmse === "" ? "-" : formatNumber(row.cpu_inferred_rmse, 4)}</td>
    <td>${row.cpu_inferred_p95_ae === "" ? "-" : formatNumber(row.cpu_inferred_p95_ae, 4)}</td>
    <td>${row.cpu_inferred_r2 === "" ? "-" : formatNumber(row.cpu_inferred_r2, 4)}</td>
    <td>${row.cpu_high_f1 === "" ? "-" : formatNumber(row.cpu_high_f1, 4)}</td>
    <td>${row.cpu_high_actual_support === "" ? "-" : `${row.cpu_high_actual_support}/${row.cpu_high_predicted_support}`}</td>
    <td>${formatBytes(row.telemetry_bytes_per_node_slice)}</td>
    <td>${row.completion_wall_clock_ms === "" ? (row.completion_reused ? "复用旧结果" : "-") : `${formatNumber(row.completion_wall_clock_ms, 3)} ms`}</td>
    <td>${row.ml_model_architecture || "-"}</td>
    <td>${row.ml_parameter_count || "-"}</td>
  </tr>`).join("");
  const bySlicePreview = bySliceRows.slice(0, 120).map((row) => `<tr>
    <td>${escapeHtml(row.constellation_short_label)}</td>
    <td>${escapeHtml(row.backend_label)}</td>
    <td>${row.slice_index}</td>
    <td>${row.inferred_cpu_samples}</td>
    <td>${formatNumber(row.cpu_inferred_mae, 4)}</td>
    <td>${formatNumber(row.cpu_inferred_p95_ae, 4)}</td>
  </tr>`).join("");
  const downloads = Object.entries(outputFiles).map(([label, path]) =>
    `<li><a href="${escapeHtml(relative(outputDir, path).replaceAll("\\", "/"))}">${escapeHtml(label)}</a></li>`
  ).join("");
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>实验3：节点 CPU 单指标 INT-MC 补全对比</title>
  <style>
    body { margin:0; font-family: Arial, "Microsoft YaHei", sans-serif; color:#172033; background:#f6f8fb; }
    header { padding:28px 34px; background:#fff; border-bottom:1px solid #d8e0ea; position:sticky; top:0; z-index:5; }
    main { max-width:1280px; margin:0 auto; padding:24px 34px 44px; }
    h1 { margin:0 0 8px; font-size:28px; }
    h2 { margin:26px 0 12px; }
    .muted { color:#64748b; line-height:1.65; }
    .panel { background:#fff; border:1px solid #d8e0ea; border-radius:8px; padding:16px; margin-bottom:16px; }
    .grid { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
    table { width:100%; border-collapse:collapse; background:#fff; border:1px solid #d8e0ea; }
    th, td { padding:9px 10px; border-bottom:1px solid #d8e0ea; text-align:right; font-size:13px; vertical-align:top; }
    th:first-child, td:first-child, th:nth-child(2), td:nth-child(2), th:nth-child(3), td:nth-child(3), th:nth-child(14), td:nth-child(14) { text-align:left; }
    th { background:#eef3f8; position:sticky; top:91px; }
    code { background:#eef3f8; padding:2px 5px; border-radius:4px; }
    svg { width:100%; height:auto; display:block; }
    @media (max-width:900px) { .grid { grid-template-columns:1fr; } header, th { position:static; } }
  </style>
</head>
<body>
  <header>
    <h1>实验3：节点 CPU 单指标多方法补全对比</h1>
    <div class="muted">目标指标：<code>node.cpu_percent</code>。${methodCount} 种方法复用同一份 INT-MC probe、report 与 Ground OAM 观测输入，只切换补全后端。生成时间：${escapeHtml(summary.generated_at)}</div>
  </header>
  <main>
    <section class="panel">
      <h2>实验口径</h2>
      <p class="muted">本实验暂不做多指标联合张量补全，而是固定为节点 CPU 单指标二维矩阵：<code>node_id x time_slice</code>。每个星座只运行一次 INT-MC 遥测观测流程，随后运行 ${methodCount} 个补全后端，因此遥测开销和观测样本完全一致。</p>
      <p class="muted">公平性边界：所有补全后端共享相同的 probe 路径、hop 观测、report 回传和 Ground OAM 输入；第一阶段隐藏 CPU 目标值只在实验后用于误差评价，不参与补全或后端选择。节点 ID、轨道面/槽位和时间片等可预测结构上下文对所有后端一致开放。</p>
      <p class="muted"><code>kalman-smoother</code> 是离线 RTS 平滑基线，会使用窗口内未来已交付观测，但不会使用隐藏真值；它用于衡量时间平滑能力，不作为严格在线因果部署结果。</p>
      <p class="muted">本次归档真值来自 normal 业务负载，高 CPU 判定阈值 <code>cpu_percent >= 80</code> 通常不会被触发，因此 High CPU F1 仅作为诊断字段。主要结论应优先参考 inferred-only MAE、RMSE、P95 AE 和 R2。</p>
      <p class="muted"><strong>统计边界：</strong>当前每种星座与方法只有一次确定性运行，不构成统计显著性证据；本页用于方法可行性、误差量级和计算代价筛选，正式论文结论仍需对候选方法做多种子或多时段重复。</p>
    </section>
    <h2>补全方法</h2>
    <table><thead><tr><th>方法</th><th>后端 ID</th><th>类别</th><th>核心原理</th></tr></thead><tbody>${methodRows}</tbody></table>
    <h2>公平性审计</h2>
    <table><thead><tr><th>星座</th><th>方法数</th><th>观测掩码</th><th>Ground OAM 输入</th><th>Probe plan</th><th>遥测字节</th><th>总结果</th></tr></thead><tbody>${fairnessRows}</tbody></table>
    <div class="grid">
      <div class="panel">${svgGroupedBars({ rows, field: "cpu_inferred_mae", title: "节点 CPU inferred MAE", formatter: (value) => formatNumber(value, 3), lowerIsBetter: true })}</div>
      <div class="panel">${svgGroupedBars({ rows, field: "cpu_inferred_p95_ae", title: "节点 CPU inferred P95 AE", formatter: (value) => formatNumber(value, 3), lowerIsBetter: true })}</div>
    </div>
    <div class="grid">
      <div class="panel">${svgGroupedBars({ rows, field: "cpu_inferred_rmse", title: "节点 CPU inferred RMSE", formatter: (value) => formatNumber(value, 3), lowerIsBetter: true })}</div>
      <div class="panel">${svgGroupedBars({ rows, field: "cpu_inferred_r2", title: "节点 CPU inferred R²", formatter: (value) => formatNumber(value, 3), lowerIsBetter: false })}</div>
    </div>
    <div class="grid">
      <div class="panel"><p class="muted">仅显示本轮实际执行并写入计时诊断的后端；复用旧结果的方法不按 0 ms 处理，也不参与本轮耗时结论。</p>${svgGroupedBars({ rows, field: "completion_wall_clock_ms", title: "矩阵补全算法墙钟时间", formatter: (value) => `${formatNumber(value, 1)} ms`, lowerIsBetter: true })}</div>
      <div class="panel">${svgGroupedBars({ rows, field: "telemetry_bytes_per_node_slice", title: "遥测字节 / 节点 / 时间片（公平性对照）", formatter: formatBytes, lowerIsBetter: true })}</div>
    </div>
    <section class="panel">
      <h2>同预算相对低秩变化</h2>
      <p class="muted">以同一星座的原生低秩 INT-MC 为 0。MAE、RMSE、P95 和耗时列的负值表示下降；R² 列的正值表示拟合改善。遥测字节应严格为 0%，否则公平性审计失败。</p>
      <table><thead><tr><th>星座</th><th>方法</th><th>MAE 变化</th><th>RMSE 变化</th><th>P95 变化</th><th>R² 差值</th><th>耗时变化</th><th>遥测字节变化</th></tr></thead><tbody>${lowRankComparisonRows}</tbody></table>
    </section>
    <section class="panel"><h2>当前单次运行结论</h2><ul>${bestRows}</ul><ul>
      <li><strong>跨规模结果：</strong>${escapeHtml(scaleConclusion)}</li>
      ${strongBaselineItems}
      ${kalmanTradeoffItems}
      ${stGnnConclusionItem}
      <li><strong>跨规模不能只比较绝对误差：</strong>不同星座的直接节点观测率不同，方法结论应在同一星座、同一掩码内横向比较。</li>
    </ul><p class="muted">这些“最优”只描述当前固定观测掩码，不代表方法在所有采样率、业务场景或轨道时段下普遍最优。</p></section>
    <h2>综合对比表</h2>
    <table>
      <thead><tr><th>星座</th><th>补全后端</th><th>方法类别</th><th>直接节点观测</th><th>节点补全覆盖</th><th>CPU MAE</th><th>CPU RMSE</th><th>CPU P95 AE</th><th>CPU R2</th><th>High CPU F1</th><th>High CPU 样本</th><th>遥测字节/节点/片</th><th>补全耗时</th><th>模型架构</th><th>参数量</th></tr></thead>
      <tbody>${tableRows}</tbody>
    </table>
    <details class="panel"><summary><strong>展开逐时间片预览（前 120 行）</strong></summary>
      <table>
        <thead><tr><th>星座</th><th>补全后端</th><th>时间片</th><th>inferred CPU 样本</th><th>CPU MAE</th><th>CPU P95 AE</th></tr></thead>
        <tbody>${bySlicePreview}</tbody>
      </table>
    </details>
    <h2>输出文件</h2>
    <div class="panel"><ul>${downloads}</ul></div>
  </main>
</body>
</html>`;
}

function buildMarkdown({ rows, outputFiles, summary }) {
  const methodCount = new Set(rows.map((row) => row.completion_backend)).size;
  const bestBackendIds = PROFILES.filter((profile) => rows.some((row) => row.constellation_profile_id === profile.id))
    .map((profile) => rows
      .filter((row) => row.constellation_profile_id === profile.id && row.cpu_inferred_mae !== "")
      .sort((left, right) => numberValue(left.cpu_inferred_mae, Infinity) - numberValue(right.cpu_inferred_mae, Infinity))[0]?.completion_backend)
    .filter(Boolean);
  const universalBest = new Set(bestBackendIds).size === 1
    ? BACKENDS.find((backend) => backend.id === bestBackendIds[0])
    : null;
  const lowRankDeltaRows = buildLowRankDeltaRows(rows);
  const strongBaselineLines = lowRankDeltaRows
    .filter((row) => ["soft-impute", "graph-regularized"].includes(row.completion_backend))
    .map((row) => `- ${row.constellation_short_label} / ${row.backend_label} 相对低秩：MAE ${formatSignedPercent(row.mae_delta_ratio)}，RMSE ${formatSignedPercent(row.rmse_delta_ratio)}，P95 ${formatSignedPercent(row.p95_delta_ratio)}，R² 差值 ${row.r2_delta > 0 ? "+" : ""}${formatNumber(row.r2_delta, 4)}，遥测开销不变。`);
  const stGnnPriorDeltas = PROFILES.map((profile) => {
    const prior = rows.find((row) => row.constellation_profile_id === profile.id && row.completion_backend === "prior-only");
    const stGnn = rows.find((row) => row.constellation_profile_id === profile.id && row.completion_backend === "st-gnn");
    return Math.abs(optionalNumber(prior?.cpu_inferred_mae) - optionalNumber(stGnn?.cpu_inferred_mae));
  }).filter(Number.isFinite);
  const stGnnConclusionLine = stGnnPriorDeltas.length
    ? `- ST-GNN 与结构先验在已运行规模上的 inferred MAE 最大差值为 ${formatNumber(Math.max(...stGnnPriorDeltas), 4)}；当前训练配置没有形成稳定的额外残差收益。`
    : null;
  const kalmanTradeoffLines = PROFILES.filter((profile) => rows.some((row) => row.constellation_profile_id === profile.id))
    .map((profile) => {
      const lowRank = rows.find((row) => row.constellation_profile_id === profile.id && row.completion_backend === "low-rank");
      const kalman = rows.find((row) => row.constellation_profile_id === profile.id && row.completion_backend === "kalman-smoother");
      if (!lowRank || !kalman) return null;
      const maeDelta = (optionalNumber(kalman.cpu_inferred_mae) - optionalNumber(lowRank.cpu_inferred_mae)) /
        Math.max(Math.abs(optionalNumber(lowRank.cpu_inferred_mae)), 1e-9);
      const runtimeReduction = (optionalNumber(lowRank.completion_wall_clock_ms) - optionalNumber(kalman.completion_wall_clock_ms)) /
        Math.max(optionalNumber(lowRank.completion_wall_clock_ms), 1e-9);
      return `- ${profile.short_label} 的 Kalman/RTS 相对低秩 MAE 变化 ${formatPercent(maeDelta)}，补全墙钟时间下降 ${formatPercent(runtimeReduction)}。`;
    })
    .filter(Boolean);
  return [
    "# 实验3：节点 CPU 单指标多方法补全对比",
    "",
    `生成时间：${summary.generated_at}`,
    "",
    `目标指标：\`node.cpu_percent\`。${methodCount} 种方法复用同一份 INT-MC 遥测观测输入，只切换矩阵补全后端。`,
    "",
    "## 实验口径",
    "",
    "- 矩阵形态：`node_id x time_slice`，元素为 `cpu_percent`。",
    "- 公平性边界：同一星座内所有后端共享相同的 probe 路径、hop 观测、report 回传和 Ground OAM 输入。",
    "- 真值使用：第一阶段隐藏 CPU 目标值只在实验后用于误差评价，不参与补全或后端选择；节点 ID、轨道面/槽位和时间片结构上下文对所有后端一致开放。",
    "- Kalman 边界：`kalman-smoother` 使用窗口内未来已交付观测进行离线 RTS 平滑，不使用隐藏真值，也不作为严格在线因果结果。",
    "- 指标重点：normal 业务负载下 `cpu_percent >= 80` 通常不会触发，因此主要看 inferred-only MAE、RMSE、P95 AE 和 R2。",
    "- 统计边界：当前每种星座与方法只有一次确定性运行，不构成统计显著性证据；正式论文结论仍需多种子或多时段重复。",
    "",
    "## 方法",
    "",
    ...BACKENDS.filter((backend) => rows.some((row) => row.completion_backend === backend.id))
      .map((backend) => `- \`${backend.id}\`：${backend.principle}`),
    "",
    "## 公平性审计",
    "",
    ...summary.fairness_audit.by_profile.map((audit) =>
      `- ${audit.constellation_profile_id}：${audit.passed ? "通过" : "失败"}；方法 ${audit.actual_backend_count}/${audit.expected_backend_count}，观测掩码一致=${audit.same_observation_mask_all_backends}，Ground OAM 一致=${audit.same_ground_oam_nodes_all_backends}，probe plan 一致=${audit.same_probe_plan_all_backends}。`),
    "",
    "| 星座 | 补全后端 | 方法类别 | 直接节点观测 | CPU inferred MAE | CPU inferred RMSE | CPU inferred P95 AE | CPU inferred R2 | 补全耗时 | 遥测字节/节点/片 | 参数量 |",
    "|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...rows.map((row) => `| ${row.constellation_short_label} | ${row.backend_label} | ${row.backend_family} | ${formatPercent(row.direct_node_observation_rate)} | ${row.cpu_inferred_mae === "" ? "-" : formatNumber(row.cpu_inferred_mae, 4)} | ${row.cpu_inferred_rmse === "" ? "-" : formatNumber(row.cpu_inferred_rmse, 4)} | ${row.cpu_inferred_p95_ae === "" ? "-" : formatNumber(row.cpu_inferred_p95_ae, 4)} | ${row.cpu_inferred_r2 === "" ? "-" : formatNumber(row.cpu_inferred_r2, 4)} | ${row.completion_wall_clock_ms === "" ? "-" : `${formatNumber(row.completion_wall_clock_ms, 3)} ms`} | ${formatBytes(row.telemetry_bytes_per_node_slice)} | ${row.ml_parameter_count || "-"} |`),
    "",
    "## 同预算相对低秩变化",
    "",
    "负的误差/耗时变化表示下降，正的 R² 差值表示改善。所有遥测字节变化必须为 0%。",
    "",
    "| 星座 | 方法 | MAE 变化 | RMSE 变化 | P95 变化 | R² 差值 | 耗时变化 | 遥测字节变化 |",
    "|---|---|---:|---:|---:|---:|---:|---:|",
    ...lowRankDeltaRows.map((row) => `| ${row.constellation_short_label} | ${row.backend_label} | ${formatSignedPercent(row.mae_delta_ratio)} | ${formatSignedPercent(row.rmse_delta_ratio)} | ${formatSignedPercent(row.p95_delta_ratio)} | ${row.r2_delta > 0 ? "+" : ""}${formatNumber(row.r2_delta, 4)} | ${formatSignedPercent(row.runtime_delta_ratio)} | ${formatSignedPercent(row.telemetry_delta_ratio)} |`),
    "",
    "## 当前结论",
    "",
    universalBest
      ? `- 当前固定掩码下，${universalBest.label} 在所有已运行规模取得最低 inferred MAE。`
      : "- 当前固定掩码下不存在跨全部规模统一最优的补全后端，方法优劣具有规模依赖性。",
    ...strongBaselineLines,
    ...kalmanTradeoffLines,
    ...(stGnnConclusionLine ? [stGnnConclusionLine] : []),
    "- 不同星座规模的直接节点观测率不同，跨规模绝对误差不应被解释为纯粹的算法规模效应。",
    "- 单次固定掩码结果用于筛选候选方法，不替代多种子或多时段统计检验。",
    "",
    "## 输出文件",
    "",
    ...Object.entries(outputFiles).map(([label, path]) => `- ${label}: \`${path}\``),
    "",
  ].join("\n");
}

const args = process.argv.slice(2);
const oldRoot = resolve(argValue(args, "--old-root", "reports/experiment2-native-baseline-rerun-final"));
const outputDir = resolve(argValue(args, "--out", "reports/experiment3-cpu-single-metric-completion"));
const observationRoot = resolve(argValue(args, "--observation-root", outputDir));
const profiles = listArg(args, "--profiles", PROFILES.map((profile) => profile.id)).map(profileById);
const backends = listArg(args, "--backends", BACKENDS.map((backend) => backend.id)).map(backendById);
const samplingRate = Math.max(0.01, Math.min(1, numberArg(args, "--int-mc-sampling-rate", 0.25)));
const targetActiveLinkSamplingRate = Math.max(0.01, Math.min(1, numberArg(args, "--int-mc-target-active-link-sampling-rate", samplingRate)));
const rank = Math.max(1, Math.floor(numberArg(args, "--int-mc-rank", 5)));
const windowSize = Math.max(1, Math.floor(numberArg(args, "--int-mc-window-size", 12)));
const warmupSlices = Math.max(1, Math.floor(numberArg(args, "--int-mc-warmup-slices", 6)));
const iterations = Math.max(1, Math.floor(numberArg(args, "--int-mc-iterations", 12)));
const downlinkBudgetBytes = Math.max(0, Math.floor(numberArg(args, "--downlink-budget-bytes", 1_000_000_000)));
const maxPathsPerSlice = Math.max(1, Math.floor(numberArg(args, "--int-mc-max-paths-per-slice", 12)));
const mlEpochs = Math.max(1, Math.floor(numberArg(args, "--int-mc-ml-epochs", 12)));
const mlTrainingSamples = Math.max(1, Math.floor(numberArg(args, "--int-mc-ml-training-samples", 50000)));
const mlHiddenUnits = Math.max(16, Math.floor(numberArg(args, "--int-mc-ml-hidden-units", 96)));
const mlHiddenLayers = Math.max(1, Math.floor(numberArg(args, "--int-mc-ml-hidden-layers", 2)));
const mlLatentRank = Math.max(2, Math.floor(numberArg(args, "--int-mc-ml-latent-rank", 64)));
const softImputeLambdaRatio = Math.max(0, Math.min(1, numberArg(args, "--soft-impute-lambda-ratio", 0.08)));
const kalmanProcessVariance = Math.max(0.000001, Math.min(10, numberArg(args, "--kalman-process-variance", 0.05)));
const kalmanMeasurementVariance = Math.max(0.000001, Math.min(10, numberArg(args, "--kalman-measurement-variance", 0.1)));
const kalmanInitialVariance = Math.max(0.000001, Math.min(100, numberArg(args, "--kalman-initial-variance", 1)));
const graphRegularizationWeight = Math.max(0, numberArg(args, "--graph-regularization-weight", 0.4));
const temporalRegularizationWeight = Math.max(0, numberArg(args, "--temporal-regularization-weight", 0.25));
const priorRegularizationWeight = Math.max(0, numberArg(args, "--prior-regularization-weight", 0.2));
const lowRankRegularizationWeight = Math.max(0, numberArg(args, "--low-rank-regularization-weight", 0.15));
const skipExisting = hasArg(args, "--reuse");
const compactArtifacts = hasArg(args, "--compact-artifacts");

await mkdir(outputDir, { recursive: true });

const rows = [];
const bySliceRows = [];
const runManifests = [];

for (const profile of profiles) {
  const truthDir = join(oldRoot, profile.id, "stage1-truth");
  const candidatePathsPath = join(oldRoot, profile.id, "experiment2", "stage2", "full-probe-int", "probe-paths-path-balance.csv");
  requireFile(join(truthDir, "nodes.csv"), `${profile.short_label} truth nodes`);
  requireFile(join(truthDir, "links.csv"), `${profile.short_label} truth links`);
  requireFile(candidatePathsPath, `${profile.short_label} candidate probe paths`);

  const profileOut = join(outputDir, profile.id);
  const observationProfileOut = join(observationRoot, profile.id);
  const stage2Dir = join(observationProfileOut, "stage2", "int-mc-observation");
  const observedGroundDir = join(observationProfileOut, "ground-oam", "observed-int-mc");
  const predictedContactPlanPath = join(stage2Dir, "predicted-contact-plan.json");
  let observation;
  if (observationRoot !== outputDir) {
    requireFile(predictedContactPlanPath, `${profile.short_label} shared predicted contact plan`);
    requireFile(join(stage2Dir, "probe-paths-int-mc.csv"), `${profile.short_label} shared probe plan`);
    requireFile(join(stage2Dir, "probe-int-run-report-int-mc.json"), `${profile.short_label} shared probe report`);
    requireFile(join(observedGroundDir, "ground-reconstructed-nodes.csv"), `${profile.short_label} shared Ground OAM nodes`);
    requireFile(join(observedGroundDir, "ground-reconstructed-links.csv"), `${profile.short_label} shared Ground OAM links`);
    observation = { predictedContactPlanPath, reused: true, external_observation_root: true };
  } else {
    observation = await runObservationPipeline({
      profile,
      truthDir,
      candidatePathsPath,
      stage2Dir,
      observedGroundDir,
      samplingRate,
      targetActiveLinkSamplingRate,
      rank,
      windowSize,
      warmupSlices,
      downlinkBudgetBytes,
      maxPathsPerSlice,
      skipExisting,
    });
  }
  const groundOamNodesPath = join(observedGroundDir, "ground-reconstructed-nodes.csv");
  const probePlanPath = join(stage2Dir, "probe-paths-int-mc.csv");
  const observedGroundNodes = await readCsv(groundOamNodesPath);
  const fingerprints = {
    observation_mask_sha256: observationMaskSha256(observedGroundNodes),
    ground_oam_nodes_sha256: await sha256File(groundOamNodesPath),
    probe_plan_sha256: await sha256File(probePlanPath),
  };

  for (const backend of backends) {
    const backendGroundDir = join(profileOut, "ground-oam", `cpu-${backend.id}`);
    const result = await runCompletionBackend({
      profile,
      backend,
      truthDir,
      stage2Dir,
      observedGroundDir,
      backendGroundDir,
      predictedContactPlanPath: observation.predictedContactPlanPath,
      rank,
      windowSize,
      iterations,
      mlEpochs,
      mlTrainingSamples,
      mlHiddenUnits,
      mlHiddenLayers,
      mlLatentRank,
      softImputeLambdaRatio,
      kalmanProcessVariance,
      kalmanMeasurementVariance,
      kalmanInitialVariance,
      graphRegularizationWeight,
      temporalRegularizationWeight,
      priorRegularizationWeight,
      lowRankRegularizationWeight,
      compactArtifacts,
      fingerprints,
      skipExisting,
    });
    rows.push(result.row);
    bySliceRows.push(...result.bySlice);
  }

  runManifests.push({
    constellation_profile_id: profile.id,
    truth_dir: truthDir,
    candidate_paths_csv: candidatePathsPath,
    stage2_observation_dir: stage2Dir,
    observed_ground_oam_dir: observedGroundDir,
    observation_root: observationRoot,
    predicted_contact_plan_json: observation.predictedContactPlanPath,
    reused_observation: observation.reused,
    ...fingerprints,
  });
}

const outputFiles = {
  summary_csv: join(outputDir, "experiment3-cpu-completion-summary.csv"),
  summary_json: join(outputDir, "experiment3-cpu-completion-summary.json"),
  by_slice_csv: join(outputDir, "experiment3-cpu-completion-by-slice.csv"),
  report_md: join(outputDir, "experiment3-cpu-completion-report.md"),
  report_html: join(outputDir, "experiment3-cpu-completion-report.html"),
};

const fairnessAudit = buildFairnessAudit(rows, profiles, backends);
if (!fairnessAudit.all_profiles_passed) {
  throw new Error(`Experiment 3 fairness audit failed: ${JSON.stringify(fairnessAudit.by_profile)}`);
}

const summary = {
  schema_version: "experiment3-cpu-single-metric-completion-v3",
  generated_at: new Date().toISOString(),
  old_root: oldRoot,
  observation_root: observationRoot,
  output_dir: outputDir,
  target_metric: "node.cpu_percent",
  matrix_shape: "node_id x time_slice, one metric only",
  profiles: profiles.map((profile) => profile.id),
  backends: backends.map((backend) => backend.id),
  parameters: {
    sampling_rate: samplingRate,
    target_active_link_sampling_rate: targetActiveLinkSamplingRate,
    rank,
    window_size: windowSize,
    warmup_slices: warmupSlices,
    iterations,
    downlink_budget_bytes: downlinkBudgetBytes,
    max_paths_per_slice: maxPathsPerSlice,
    ml_epochs: mlEpochs,
    ml_training_samples: mlTrainingSamples,
    ml_hidden_units: mlHiddenUnits,
    ml_hidden_layers: mlHiddenLayers,
    ml_latent_rank: mlLatentRank,
    soft_impute_lambda_ratio: softImputeLambdaRatio,
    kalman_process_variance: kalmanProcessVariance,
    kalman_measurement_variance: kalmanMeasurementVariance,
    kalman_initial_variance: kalmanInitialVariance,
    graph_regularization_weight: graphRegularizationWeight,
    temporal_regularization_weight: temporalRegularizationWeight,
    prior_regularization_weight: priorRegularizationWeight,
    low_rank_regularization_weight: lowRankRegularizationWeight,
    compact_artifacts: compactArtifacts,
  },
  fairness_boundary: {
    same_int_mc_probe_paths_per_constellation: true,
    same_ground_oam_observed_nodes_per_constellation: true,
    shared_observation_root_is_read_only_input: observationRoot !== outputDir,
    only_completion_backend_changes: true,
    stage_one_hidden_cpu_truth_used_only_for_evaluation: true,
    stage_one_orbit_topology_context_shared_by_all_backends: true,
    truth_used_for_backend_selection: false,
    completion_is_offline_reconstruction_not_future_prediction: true,
    compact_artifacts_only_omit_unused_link_csv_outputs: compactArtifacts,
  },
  fairness_audit: fairnessAudit,
  run_manifests: runManifests,
  output_files: outputFiles,
};

await Promise.all([
  writeFile(outputFiles.summary_csv, rowsToCsv(rows), "utf8"),
  writeFile(outputFiles.by_slice_csv, rowsToCsv(bySliceRows), "utf8"),
  writeFile(outputFiles.summary_json, JSON.stringify({ ...summary, rows, by_slice_rows: bySliceRows }, null, 2), "utf8"),
  writeFile(outputFiles.report_md, buildMarkdown({ rows, outputFiles, summary }), "utf8"),
  writeFile(outputFiles.report_html, buildHtml({ rows, bySliceRows, outputFiles, outputDir, summary }), "utf8"),
]);

console.log(JSON.stringify({
  ok: true,
  outputDir,
  reportHtml: outputFiles.report_html,
  summaryCsv: outputFiles.summary_csv,
  bySliceCsv: outputFiles.by_slice_csv,
  rows: rows.length,
  bySliceRows: bySliceRows.length,
  profiles: profiles.map((profile) => profile.id),
  backends: backends.map((backend) => backend.id),
}, null, 2));
