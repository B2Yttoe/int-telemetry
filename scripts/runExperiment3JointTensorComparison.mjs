import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";

import {
  auditLinkPhysicalConsistency,
  auditNodePhysicalConsistency,
} from "../stage2-int/tools/int-mc-physical-consistency.mjs";

const PROFILES = [
  { id: "iridium-next-small", label: "Iridium 66", scale: "small" },
  { id: "telesat-1015-medium", label: "Telesat 351", scale: "medium" },
  { id: "starlink-main-large", label: "Starlink 1584", scale: "large" },
];

const METHODS = [
  { id: "low-rank", label: "逐指标二维低秩", kind: "independent-2d" },
  { id: "joint-cp", label: "多指标联合 CP", kind: "joint-3d" },
  { id: "joint-cp-physics", label: "联合 CP + 物理投影", kind: "joint-3d-physics" },
];

const NODE_METRICS = ["cpu_percent", "queue_depth", "queued_traffic_mb", "cache_used_mb", "energy_percent"];
const LINK_METRICS = [
  "utilization_percent",
  "latency_ms",
  "queue_latency_ms",
  "capacity_mbps",
  "congestion_percent",
  "queued_traffic_mb",
  "dropped_traffic_mb",
  "packet_error_rate",
];

function argValue(args, name, fallback = "") {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? fallback : fallback;
}

function numberArg(args, name, fallback) {
  const raw = argValue(args, name, "");
  if (raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function listArg(args, name, fallback) {
  return argValue(args, name, fallback.join(",")).split(",").map((value) => value.trim()).filter(Boolean);
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
      } else quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell);
      if (row.some((value) => value.length > 0)) rows.push(row);
      row = [];
      cell = "";
    } else cell += char;
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

function numberValue(value, fallback = 0) {
  if (value === "" || value === null || value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value, digits = 6) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(digits)) : "";
}

function mean(values) {
  const finite = values.filter(Number.isFinite);
  return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : 0;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function rowsHash(rows) {
  return sha256(rowsToCsv(rows));
}

function observationMaskHash(rows, idField, metricNames) {
  return sha256(rows.map((row) => [
    row.slice_index,
    row[idField],
    String(row.observed).toLowerCase(),
    ...metricNames.map((metric) => Number.isFinite(Number(row[`${metric}_estimate`])) ? 1 : 0),
  ].join("|")).sort().join("\n"));
}

function profileById(id) {
  const profile = PROFILES.find((item) => item.id === id);
  if (!profile) throw new Error(`Unknown constellation profile: ${id}`);
  return profile;
}

function methodById(id) {
  const method = METHODS.find((item) => item.id === id);
  if (!method) throw new Error(`Unknown completion method: ${id}`);
  return method;
}

function requireFile(path, label) {
  if (!existsSync(path)) throw new Error(`${label} not found: ${path}`);
}

function runNode(label, script, args) {
  return new Promise((resolvePromise, reject) => {
    console.log(`[experiment3:joint] ${label}`);
    const startedAt = performance.now();
    const child = spawn(process.execPath, [script, ...args], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`${label} failed (${code})\n${stderr || stdout}`));
        return;
      }
      resolvePromise({ wallClockMs: performance.now() - startedAt, stdout });
    });
  });
}

function filterSlices(rows, selected) {
  return rows.filter((row) => selected.has(String(row.slice_index)));
}

function telemetryOverhead(hops, reports, overheadModel) {
  const hopMetadataBytes = numberValue(overheadModel.hop_metadata_bytes, 96);
  const probePacketBaseBytes = numberValue(overheadModel.probe_packet_base_bytes, 64);
  const totalMetadataBytes = hops.length * hopMetadataBytes;
  const totalReportBytes = reports.reduce((sum, row) => sum + numberValue(row.report_size_bytes), 0);
  const totalProbeBaseBytes = reports.length * probePacketBaseBytes;
  const totalBytes = totalMetadataBytes + totalReportBytes + totalProbeBaseBytes;
  const processingEnergy =
    hops.length * numberValue(overheadModel.hop_processing_j, 0.02) +
    reports.length * numberValue(overheadModel.report_processing_j, 0.05);
  const txEnergy = totalBytes * numberValue(overheadModel.telemetry_tx_nj_per_byte, 120) * 1e-9;
  return {
    hop_records: hops.length,
    reports: reports.length,
    telemetry_total_bytes: round(totalBytes),
    telemetry_total_energy_j: round(processingEnergy + txEnergy),
  };
}

function observedMetricScales(rows, metricNames) {
  return Object.fromEntries(metricNames.map((metric) => {
    const values = rows
      .filter((row) => String(row.observed).toLowerCase() === "true")
      .map((row) => numberValue(row[`${metric}_estimate`], NaN))
      .filter(Number.isFinite);
    const center = mean(values);
    const std = Math.sqrt(mean(values.map((value) => (value - center) ** 2))) || 1;
    return [metric, { observed_values: values.length, mean: round(center), std: round(std) }];
  }));
}

async function prepareInput({ profile, truthRoot, observationRoot, outputDir, sliceLimit }) {
  const truthSource = join(truthRoot, profile.id, "stage1-truth");
  const observationSource = join(observationRoot, profile.id);
  const stage2Source = join(observationSource, "stage2", "int-mc-observation");
  const groundSource = join(observationSource, "ground-oam", "observed-int-mc");
  const paths = {
    truthLinks: join(truthSource, "links.csv"),
    truthNodes: join(truthSource, "nodes.csv"),
    routes: join(truthSource, "routes.csv"),
    groundLinks: join(groundSource, "ground-reconstructed-links.csv"),
    groundNodes: join(groundSource, "ground-reconstructed-nodes.csv"),
    probePlan: join(stage2Source, "probe-paths-int-mc.csv"),
    hops: join(stage2Source, "probe-int-hop-records-int-mc.csv"),
    reports: join(stage2Source, "probe-int-reports-int-mc.csv"),
    runReport: join(stage2Source, "probe-int-run-report-int-mc.json"),
    contactPlan: join(stage2Source, "predicted-contact-plan.json"),
  };
  Object.entries(paths).forEach(([label, path]) => requireFile(path, `${profile.label} ${label}`));
  const [truthLinks, truthNodes, routes, groundLinks, groundNodes, probePlan, hops, reports, runReport, contactPlan] = await Promise.all([
    readCsv(paths.truthLinks),
    readCsv(paths.truthNodes),
    readCsv(paths.routes),
    readCsv(paths.groundLinks),
    readCsv(paths.groundNodes),
    readCsv(paths.probePlan),
    readCsv(paths.hops),
    readCsv(paths.reports),
    readFile(paths.runReport, "utf8").then(JSON.parse),
    readFile(paths.contactPlan, "utf8").then(JSON.parse),
  ]);
  const allSlices = [...new Set(truthNodes.map((row) => String(row.slice_index)))].sort((left, right) => Number(left) - Number(right));
  const selectedSlices = sliceLimit > 0 ? allSlices.slice(0, sliceLimit) : allSlices;
  const selected = new Set(selectedSlices);
  const selectedRows = {
    truthLinks: filterSlices(truthLinks, selected),
    truthNodes: filterSlices(truthNodes, selected),
    routes: filterSlices(routes, selected),
    groundLinks: filterSlices(groundLinks, selected),
    groundNodes: filterSlices(groundNodes, selected),
    probePlan: filterSlices(probePlan, selected),
    hops: filterSlices(hops, selected),
    reports: filterSlices(reports, selected),
  };

  let inputDir = truthSource;
  let groundDir = groundSource;
  let stage2Dir = stage2Source;
  let contactPlanPath = paths.contactPlan;
  if (sliceLimit > 0) {
    const fixtureRoot = join(outputDir, profile.id, "fixture");
    inputDir = join(fixtureRoot, "truth");
    groundDir = join(fixtureRoot, "ground-oam");
    stage2Dir = join(fixtureRoot, "stage2");
    await Promise.all([mkdir(inputDir, { recursive: true }), mkdir(groundDir, { recursive: true }), mkdir(stage2Dir, { recursive: true })]);
    contactPlanPath = join(stage2Dir, "predicted-contact-plan.json");
    await Promise.all([
      writeFile(join(inputDir, "links.csv"), rowsToCsv(selectedRows.truthLinks), "utf8"),
      writeFile(join(inputDir, "nodes.csv"), rowsToCsv(selectedRows.truthNodes), "utf8"),
      writeFile(join(inputDir, "routes.csv"), rowsToCsv(selectedRows.routes), "utf8"),
      writeFile(join(groundDir, "ground-reconstructed-links.csv"), rowsToCsv(selectedRows.groundLinks), "utf8"),
      writeFile(join(groundDir, "ground-reconstructed-nodes.csv"), rowsToCsv(selectedRows.groundNodes), "utf8"),
      writeFile(contactPlanPath, JSON.stringify({ ...contactPlan, entries: filterSlices(contactPlan.entries ?? [], selected) }, null, 2), "utf8"),
    ]);
  }

  const overhead = telemetryOverhead(selectedRows.hops, selectedRows.reports, runReport.overhead ?? {});
  return {
    inputDir,
    groundDir,
    stage2Dir,
    contactPlanPath,
    selectedSlices,
    nodeCount: new Set(selectedRows.truthNodes.map((row) => row.node_id)).size,
    linkCount: new Set(selectedRows.truthLinks.map((row) => row.link_id)).size,
    groundNodes: selectedRows.groundNodes,
    groundLinks: selectedRows.groundLinks,
    nodeScales: observedMetricScales(selectedRows.groundNodes, NODE_METRICS),
    linkScales: observedMetricScales(selectedRows.groundLinks, LINK_METRICS),
    fingerprints: {
      node_observation_mask_sha256: observationMaskHash(selectedRows.groundNodes, "node_id", NODE_METRICS),
      link_observation_mask_sha256: observationMaskHash(selectedRows.groundLinks, "link_id", LINK_METRICS),
      ground_oam_nodes_sha256: rowsHash(selectedRows.groundNodes),
      ground_oam_links_sha256: rowsHash(selectedRows.groundLinks),
      probe_plan_sha256: rowsHash(selectedRows.probePlan),
    },
    overhead,
  };
}

async function runCompletion({ profile, method, prepared, outputDir, options, reuse }) {
  const methodDir = join(outputDir, profile.id, method.id);
  await mkdir(methodDir, { recursive: true });
  const evaluationPath = join(methodDir, "int-mc-evaluation.json");
  const reconstructedNodesPath = join(methodDir, "ground-mc-reconstructed-nodes.csv");
  const reconstructedLinksPath = join(methodDir, "ground-mc-reconstructed-links.csv");
  let processWallClockMs = "";
  if (!(reuse && existsSync(evaluationPath) && existsSync(reconstructedNodesPath) && existsSync(reconstructedLinksPath))) {
    const result = await runNode(`${profile.label}: ${method.label}`, "stage2-int/tools/int-mc-reconstructor.mjs", [
      "--input", prepared.inputDir,
      "--stage2", prepared.stage2Dir,
      "--ground", prepared.groundDir,
      "--out", methodDir,
      "--algorithm", "int-mc",
      "--completion-backend", method.id,
      "--link-metrics", LINK_METRICS.join(","),
      "--node-metrics", NODE_METRICS.join(","),
      "--predicted-contact-plan", prepared.contactPlanPath,
      "--rank", String(options.rank),
      "--iterations", String(options.iterations),
      "--window-size", String(options.windowSize),
      "--joint-tensor-rank", String(options.jointRank),
      "--joint-tensor-epochs", String(options.jointEpochs),
      "--joint-tensor-learning-rate", String(options.jointLearningRate),
      "--joint-tensor-l2", String(options.jointL2),
      "--joint-tensor-prediction-weight", String(options.jointPredictionWeight),
      "--joint-tensor-temporal-regularization", String(options.temporalRegularization),
      "--joint-tensor-orbit-regularization", String(options.orbitRegularization),
    ]);
    processWallClockMs = round(result.wallClockMs, 3);
  }

  const [evaluation, reconstructedNodes, reconstructedLinks] = await Promise.all([
    readFile(evaluationPath, "utf8").then(JSON.parse),
    readCsv(reconstructedNodesPath),
    readCsv(reconstructedLinksPath),
  ]);
  const nodeAudit = auditNodePhysicalConsistency(reconstructedNodes, { energyDeltaLimitPercentPerSlice: options.energyDeltaLimit });
  const linkAudit = auditLinkPhysicalConsistency(reconstructedLinks);
  const totalConsistencyChecks = nodeAudit.total_checks + linkAudit.total_checks;
  const totalConsistencyViolations = nodeAudit.total_violations + linkAudit.total_violations;
  const metricRows = [];

  NODE_METRICS.forEach((metric) => {
    const result = evaluation.node_reconstruction?.metrics?.[metric] ?? {};
    const scale = prepared.nodeScales[metric]?.std ?? 1;
    metricRows.push({
      constellation_profile_id: profile.id,
      constellation_label: profile.label,
      completion_backend: method.id,
      method_label: method.label,
      scope: "node",
      metric,
      observed_scale_std: scale,
      inferred_samples: result.inferred_samples ?? 0,
      inferred_mae: result.inferred_mae ?? "",
      inferred_rmse: result.inferred_rmse ?? "",
      inferred_p95_ae: result.inferred_p95_ae ?? "",
      inferred_r2: result.inferred_r2 ?? "",
      normalized_inferred_mae: round(numberValue(result.inferred_mae) / Math.max(scale, 1e-9)),
    });
  });
  LINK_METRICS.forEach((metric) => {
    const result = evaluation.metrics?.[metric] ?? {};
    const scale = prepared.linkScales[metric]?.std ?? 1;
    metricRows.push({
      constellation_profile_id: profile.id,
      constellation_label: profile.label,
      completion_backend: method.id,
      method_label: method.label,
      scope: "link",
      metric,
      observed_scale_std: scale,
      inferred_samples: result.inferred_samples ?? 0,
      inferred_mae: result.inferred_mae ?? "",
      inferred_rmse: result.inferred_rmse ?? "",
      inferred_p95_ae: result.inferred_p95_ae ?? "",
      inferred_r2: result.inferred_r2 ?? "",
      normalized_inferred_mae: round(numberValue(result.inferred_mae) / Math.max(scale, 1e-9)),
    });
  });

  const outputSizeBytes =
    (await stat(reconstructedNodesPath)).size +
    (await stat(reconstructedLinksPath)).size;
  const joint = evaluation.joint_tensor_completion ?? {};
  const result = {
    row: {
      constellation_profile_id: profile.id,
      constellation_label: profile.label,
      scale: profile.scale,
      completion_backend: method.id,
      method_label: method.label,
      method_kind: method.kind,
      node_count: prepared.nodeCount,
      link_count: prepared.linkCount,
      slice_count: prepared.selectedSlices.length,
      node_direct_observation_rate: evaluation.node_reconstruction?.direct_observation_rate ?? "",
      link_direct_observation_rate: evaluation.reconstruction?.direct_observation_rate_on_active ?? "",
      macro_inferred_nmae: round(mean(metricRows.map((row) => numberValue(row.normalized_inferred_mae, NaN)).filter(Number.isFinite))),
      node_macro_inferred_nmae: round(mean(metricRows.filter((row) => row.scope === "node").map((row) => numberValue(row.normalized_inferred_mae, NaN)).filter(Number.isFinite))),
      link_macro_inferred_nmae: round(mean(metricRows.filter((row) => row.scope === "link").map((row) => numberValue(row.normalized_inferred_mae, NaN)).filter(Number.isFinite))),
      node_mode_accuracy: evaluation.node_reconstruction?.mode_accuracy_all_nodes ?? "",
      link_status_accuracy: evaluation.reconstruction?.status_accuracy_all_links ?? "",
      node_physical_consistency_violation_rate: nodeAudit.overall_violation_rate,
      link_physical_consistency_violation_rate: linkAudit.overall_violation_rate,
      physical_consistency_checks: totalConsistencyChecks,
      physical_consistency_violations: totalConsistencyViolations,
      physical_consistency_violation_rate: round(totalConsistencyViolations / Math.max(totalConsistencyChecks, 1)),
      telemetry_total_bytes: prepared.overhead.telemetry_total_bytes,
      telemetry_total_energy_j: prepared.overhead.telemetry_total_energy_j,
      completion_process_wall_clock_ms: processWallClockMs,
      joint_tensor_wall_clock_ms: round(numberValue(joint.link?.wall_clock_ms) + numberValue(joint.node?.wall_clock_ms)),
      joint_tensor_parameter_count: numberValue(joint.link?.parameter_count) + numberValue(joint.node?.parameter_count),
      reconstructed_output_size_bytes: outputSizeBytes,
      detailed_reconstruction_artifacts_retained: options.retainReconstructions,
      ...prepared.fingerprints,
      evaluation_json: evaluationPath,
      reconstructed_nodes_csv: options.retainReconstructions ? reconstructedNodesPath : "",
      reconstructed_links_csv: options.retainReconstructions ? reconstructedLinksPath : "",
    },
    metricRows,
    physicalConsistency: { node: nodeAudit, link: linkAudit },
  };
  if (!options.retainReconstructions) {
    await Promise.all([
      reconstructedNodesPath,
      reconstructedLinksPath,
      join(methodDir, "int-mc-link-errors.csv"),
      join(methodDir, "int-mc-node-errors.csv"),
      join(methodDir, "int-mc-priority-retest.csv"),
      join(methodDir, "int-mc-deployable-priority-retest.csv"),
    ].map((path) => rm(path, { force: true })));
  }
  return result;
}

function fairnessAudit(rows, profiles, methods) {
  const byProfile = profiles.map((profile) => {
    const values = rows.filter((row) => row.constellation_profile_id === profile.id);
    const same = (field) => new Set(values.map((row) => row[field])).size === 1;
    const audit = {
      constellation_profile_id: profile.id,
      expected_methods: methods.length,
      actual_methods: values.length,
      same_node_observation_mask_all_methods: same("node_observation_mask_sha256"),
      same_link_observation_mask_all_methods: same("link_observation_mask_sha256"),
      same_ground_oam_nodes_all_methods: same("ground_oam_nodes_sha256"),
      same_ground_oam_links_all_methods: same("ground_oam_links_sha256"),
      same_probe_plan_all_methods: same("probe_plan_sha256"),
      same_telemetry_bytes_all_methods: same("telemetry_total_bytes"),
      same_telemetry_energy_all_methods: same("telemetry_total_energy_j"),
    };
    audit.passed = audit.actual_methods === audit.expected_methods && Object.entries(audit)
      .filter(([key]) => key.startsWith("same_"))
      .every(([, value]) => value === true);
    return audit;
  });
  return { all_profiles_passed: byProfile.every((row) => row.passed), by_profile: byProfile };
}

function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;");
}

function svgBars(rows, field, title, lowerIsBetter = true) {
  const width = 1060;
  const height = 330;
  const margin = { left: 76, right: 22, top: 54, bottom: 58 };
  const profiles = PROFILES.filter((profile) => rows.some((row) => row.constellation_profile_id === profile.id));
  const methods = METHODS.filter((method) => rows.some((row) => row.completion_backend === method.id));
  const values = rows.map((row) => numberValue(row[field], NaN)).filter(Number.isFinite);
  const maxValue = Math.max(...values, 1e-9) * 1.08;
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const groupWidth = plotWidth / Math.max(profiles.length, 1);
  const barWidth = Math.min(54, groupWidth / (methods.length + 1));
  const colors = { "low-rank": "#64748b", "joint-cp": "#2563eb", "joint-cp-physics": "#0f766e" };
  const y = (value) => margin.top + plotHeight - (value / maxValue) * plotHeight;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((ratio) => {
    const value = maxValue * ratio;
    const top = margin.top + plotHeight - ratio * plotHeight;
    return `<line x1="${margin.left}" x2="${width - margin.right}" y1="${top}" y2="${top}" stroke="#e2e8f0"/><text x="${margin.left - 8}" y="${top + 4}" text-anchor="end" font-size="11">${value.toFixed(3)}</text>`;
  }).join("");
  const bars = profiles.flatMap((profile, profileIndex) => methods.map((method, methodIndex) => {
    const row = rows.find((item) => item.constellation_profile_id === profile.id && item.completion_backend === method.id);
    const value = numberValue(row?.[field]);
    const x = margin.left + profileIndex * groupWidth + groupWidth / 2 - methods.length * barWidth / 2 + methodIndex * barWidth;
    const top = y(value);
    return `<rect x="${x}" y="${top}" width="${barWidth - 3}" height="${margin.top + plotHeight - top}" fill="${colors[method.id]}"><title>${escapeHtml(profile.label)} / ${escapeHtml(method.label)}: ${value}</title></rect>`;
  })).join("");
  const labels = profiles.map((profile, index) => `<text x="${margin.left + index * groupWidth + groupWidth / 2}" y="${height - 25}" text-anchor="middle" font-size="12">${escapeHtml(profile.label)}</text>`).join("");
  const legend = methods.map((method, index) => `<rect x="${margin.left + index * 230}" y="28" width="10" height="10" fill="${colors[method.id]}"/><text x="${margin.left + index * 230 + 14}" y="38" font-size="12">${escapeHtml(method.label)}</text>`).join("");
  return `<svg viewBox="0 0 ${width} ${height}" role="img"><text x="${margin.left}" y="18" font-size="16" font-weight="700">${escapeHtml(title)} (${lowerIsBetter ? "越低越好" : "越高越好"})</text>${legend}${ticks}<line x1="${margin.left}" x2="${margin.left}" y1="${margin.top}" y2="${margin.top + plotHeight}" stroke="#64748b"/>${bars}${labels}</svg>`;
}

function buildHtml(summary, outputDir) {
  const fairnessRows = summary.fairness_audit.by_profile.map((row) => `<tr><td>${escapeHtml(row.constellation_profile_id)}</td><td>${row.actual_methods}/${row.expected_methods}</td><td>${row.same_node_observation_mask_all_methods ? "通过" : "失败"}</td><td>${row.same_link_observation_mask_all_methods ? "通过" : "失败"}</td><td>${row.same_telemetry_bytes_all_methods ? "通过" : "失败"}</td><td>${row.same_telemetry_energy_all_methods ? "通过" : "失败"}</td><td>${row.passed ? "通过" : "失败"}</td></tr>`).join("");
  const resultRows = summary.rows.map((row) => `<tr><td>${escapeHtml(row.constellation_label)}</td><td>${escapeHtml(row.method_label)}</td><td>${row.macro_inferred_nmae}</td><td>${row.node_macro_inferred_nmae}</td><td>${row.link_macro_inferred_nmae}</td><td>${(row.physical_consistency_violation_rate * 100).toFixed(2)}%</td><td>${row.node_mode_accuracy}</td><td>${row.link_status_accuracy}</td><td>${row.telemetry_total_bytes}</td><td>${row.completion_process_wall_clock_ms || "复用"}</td></tr>`).join("");
  const metricRows = summary.metric_rows.map((row) => `<tr><td>${escapeHtml(row.constellation_label)}</td><td>${escapeHtml(row.method_label)}</td><td>${row.scope === "node" ? "节点" : "链路"}</td><td><code>${escapeHtml(row.metric)}</code></td><td>${row.inferred_mae}</td><td>${row.normalized_inferred_mae}</td><td>${row.inferred_p95_ae}</td><td>${row.inferred_r2}</td></tr>`).join("");
  const conclusions = summary.conclusions.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
  const verdictText = summary.verdict.universal_joint_error_improvement
    ? "纯联合 CP 在全部星座均降低宏误差。"
    : "纯联合 CP 尚未在全部星座降低宏误差，不能把物理投影收益归因于 CP 本身。";
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>实验3：多指标联合张量补全</title><style>body{margin:0;font-family:Arial,"Microsoft YaHei",sans-serif;color:#172033;background:#f5f7fa}header{background:#fff;border-bottom:1px solid #d8e0ea;padding:24px 32px}main{max-width:1280px;margin:auto;padding:22px 32px 44px}.panel{background:#fff;border:1px solid #d8e0ea;border-radius:8px;padding:16px;margin:14px 0}.grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}.formula{font-family:"Times New Roman",serif;font-size:17px;text-align:center;background:#f8fafc;border-left:3px solid #2563eb;padding:12px;margin:10px 0}.verdict{border-left:4px solid #0f766e;background:#ecfdf5}table{width:100%;border-collapse:collapse;background:#fff;margin-bottom:18px}th,td{padding:8px;border:1px solid #d8e0ea;text-align:right;font-size:13px}th{background:#eef3f8}th:first-child,td:first-child,th:nth-child(2),td:nth-child(2){text-align:left}svg{width:100%;height:auto}code{background:#eef3f8;padding:2px 4px}.muted{color:#64748b;line-height:1.6}@media(max-width:900px){.grid{grid-template-columns:1fr}}</style></head><body><header><h1>实验3：多指标联合张量补全</h1><p class="muted">验证在相同 INT 观测和相同遥测开销下，多指标联合补全是否降低误差并减少物理一致性违反。生成时间：${escapeHtml(summary.generated_at)}</p></header><main><section class="panel"><h2>实验边界</h2><p>节点张量：<code>T×N×5</code>；链路张量：<code>T×L×8</code>。类别状态不进入连续张量，topology-down 使用硬掩码。指标归一化只使用直接观测，隐藏真值只用于最终误差评价。</p><p class="muted">当前版本是离线补全而非未来预测；卫星编号只作为对象轴索引，不把 plane/slot 编号当作连续物理量做乘加；单次固定观测掩码不构成统计显著性。</p></section><section class="panel"><h2>方法与公式</h2><p>二维基线对每个指标独立恢复 <code>X^(m)∈R^(T×O)</code>。联合方法把标准化后的多个连续指标组成 <code>𝒳∈R^(T×O×M)</code>，使用 CP 分解共享时间因子和对象因子：</p><div class="formula">x̂<sub>t,o,m</sub> = μ<sub>m</sub> + σ<sub>m</sub> Σ<sub>r=1</sub><sup>R</sup> A<sub>t,r</sub>B<sub>o,r</sub>C<sub>m,r</sub></div><p>联合预测只修正缺失单元。有效联合权重同时受观测拟合、观测密度和与二维估计分歧约束：</p><div class="formula">w<sub>eff</sub> = w · q<sub>m</sub> · √ρ · [1 + |x̂<sub>CP</sub>−x̂<sub>2D</sub>|/σ<sub>m</sub>]<sup>−1</sup></div><p>物理投影仅使用重构状态、路由流量和上一推断片，约束缓存/队列、电量变化率、业务负载利用率、排队时延和 PER 概率范围；不读取隐藏真值。</p></section><section class="panel verdict"><h2>判定</h2><p>${escapeHtml(verdictText)}</p><p>物理一致性违反是否全部消除：<strong>${summary.verdict.all_physical_violations_eliminated ? "是" : "否"}</strong>。因此本报告分别陈述“CP 收益”和“物理投影收益”，不混合归因。</p></section><h2>公平性审计</h2><table><thead><tr><th>星座</th><th>方法数</th><th>节点掩码</th><th>链路掩码</th><th>遥测字节</th><th>遥测能量</th><th>结果</th></tr></thead><tbody>${fairnessRows}</tbody></table><div class="grid"><section class="panel">${svgBars(summary.rows,"macro_inferred_nmae","宏平均归一化 inferred MAE")}</section><section class="panel">${svgBars(summary.rows,"physical_consistency_violation_rate","物理一致性违反率")}</section></div><section class="panel"><h2>当前结论</h2><ul>${conclusions}</ul></section><h2>综合结果</h2><table><thead><tr><th>星座</th><th>方法</th><th>宏 NMAE</th><th>节点 NMAE</th><th>链路 NMAE</th><th>一致性违反</th><th>节点模式准确率</th><th>链路状态准确率</th><th>遥测字节</th><th>补全耗时(ms)</th></tr></thead><tbody>${resultRows}</tbody></table><details class="panel"><summary><strong>展开每指标结果</strong></summary><table><thead><tr><th>星座</th><th>方法</th><th>对象</th><th>指标</th><th>MAE</th><th>归一化 MAE</th><th>P95 AE</th><th>R²</th></tr></thead><tbody>${metricRows}</tbody></table></details><section class="panel"><h2>下载</h2><ul><li><a href="${relative(outputDir, join(outputDir,"summary.json")).replaceAll("\\","/")}">完整 JSON</a></li><li><a href="summary.csv">综合 CSV</a></li><li><a href="metric-results.csv">逐指标 CSV</a></li><li><a href="physical-consistency.json">物理一致性 JSON</a></li></ul></section></main></body></html>`;
}

function buildVerdict(rows, metricRows, profiles) {
  const profileResults = profiles.map((profile) => {
    const baseline = rows.find((row) => row.constellation_profile_id === profile.id && row.completion_backend === "low-rank");
    const joint = rows.find((row) => row.constellation_profile_id === profile.id && row.completion_backend === "joint-cp");
    const final = rows.find((row) => row.constellation_profile_id === profile.id && row.completion_backend === "joint-cp-physics");
    if (!baseline || !joint || !final) {
      return {
        constellation_profile_id: profile.id,
        available: false,
        reason: "low-rank, joint-cp, and joint-cp-physics are all required for the complete verdict",
      };
    }
    const baseMetrics = metricRows.filter((row) => row.constellation_profile_id === profile.id && row.completion_backend === "low-rank");
    let improved = 0;
    let equivalent = 0;
    let degraded = 0;
    baseMetrics.forEach((baseMetric) => {
      const finalMetric = metricRows.find((row) =>
        row.constellation_profile_id === profile.id &&
        row.completion_backend === "joint-cp-physics" &&
        row.scope === baseMetric.scope &&
        row.metric === baseMetric.metric,
      );
      const baseValue = numberValue(baseMetric.normalized_inferred_mae, NaN);
      const finalValue = numberValue(finalMetric?.normalized_inferred_mae, NaN);
      if (!Number.isFinite(baseValue) || !Number.isFinite(finalValue)) return;
      const tolerance = Math.max(1e-6, Math.abs(baseValue) * 0.005);
      if (finalValue < baseValue - tolerance) improved += 1;
      else if (finalValue > baseValue + tolerance) degraded += 1;
      else equivalent += 1;
    });
    return {
      constellation_profile_id: profile.id,
      available: true,
      joint_macro_relative_change: round((joint.macro_inferred_nmae - baseline.macro_inferred_nmae) / Math.max(baseline.macro_inferred_nmae, 1e-9)),
      final_macro_relative_change: round((final.macro_inferred_nmae - baseline.macro_inferred_nmae) / Math.max(baseline.macro_inferred_nmae, 1e-9)),
      final_metric_counts: { improved, equivalent, degraded },
      final_physical_violation_rate: final.physical_consistency_violation_rate,
    };
  });
  const comparable = profileResults.filter((row) => row.available);
  return {
    universal_joint_error_improvement: comparable.length > 0 && comparable.every((row) => row.joint_macro_relative_change < 0),
    final_method_non_degraded_with_half_percent_tolerance: comparable.length > 0 && comparable.every((row) => row.final_macro_relative_change <= 0.005),
    all_physical_violations_eliminated: comparable.length > 0 && comparable.every((row) => numberValue(row.final_physical_violation_rate) === 0),
    physics_gain_not_attributed_to_cp: true,
    profile_results: profileResults,
  };
}

function buildConclusions(rows, profiles) {
  const conclusions = [];
  profiles.forEach((profile) => {
    const profileRows = rows.filter((row) => row.constellation_profile_id === profile.id);
    const baseline = profileRows.find((row) => row.completion_backend === "low-rank");
    const joint = profileRows.find((row) => row.completion_backend === "joint-cp");
    const physics = profileRows.find((row) => row.completion_backend === "joint-cp-physics");
    if (!baseline || !joint || !physics) return;
    const jointErrorChange = ((joint.macro_inferred_nmae - baseline.macro_inferred_nmae) / Math.max(baseline.macro_inferred_nmae, 1e-9)) * 100;
    const finalErrorChange = ((physics.macro_inferred_nmae - baseline.macro_inferred_nmae) / Math.max(baseline.macro_inferred_nmae, 1e-9)) * 100;
    const violationChange = ((physics.physical_consistency_violation_rate - baseline.physical_consistency_violation_rate) / Math.max(baseline.physical_consistency_violation_rate, 1e-9)) * 100;
    conclusions.push(`${profile.label}：联合 CP 的宏归一化 MAE 变化 ${jointErrorChange.toFixed(2)}%；最终联合 CP+物理投影的宏 MAE 变化 ${finalErrorChange.toFixed(2)}%，一致性违反率变化 ${violationChange.toFixed(2)}%。`);
  });
  conclusions.push("结果只回答当前固定观测掩码下的可行性，不把相关性解释为因果，也不声称所有指标必然同时改善。");
  return conclusions;
}

const args = process.argv.slice(2);
const truthRoot = resolve(argValue(args, "--truth-root", "reports/experiment2-native-baseline-rerun-final"));
const observationRoot = resolve(argValue(args, "--observation-root", "reports/experiment3-cpu-single-metric-completion"));
const outputDir = resolve(argValue(args, "--out", "reports/experiment3-joint-tensor-completion"));
const profiles = listArg(args, "--profiles", PROFILES.map((profile) => profile.id)).map(profileById);
const methods = listArg(args, "--methods", METHODS.map((method) => method.id)).map(methodById);
const sliceLimit = Math.max(0, Math.floor(numberArg(args, "--slices", 0)));
const formal = argValue(args, "--formal", "true").toLowerCase() === "true";
const reuse = args.includes("--reuse");
const options = {
  rank: Math.max(1, Math.floor(numberArg(args, "--rank", 5))),
  iterations: Math.max(1, Math.floor(numberArg(args, "--iterations", 12))),
  windowSize: Math.max(1, Math.floor(numberArg(args, "--window-size", 12))),
  jointRank: Math.max(2, Math.floor(numberArg(args, "--joint-rank", 6))),
  jointEpochs: Math.max(1, Math.floor(numberArg(args, "--joint-epochs", 60))),
  jointLearningRate: numberArg(args, "--joint-learning-rate", 0.05),
  jointL2: numberArg(args, "--joint-l2", 0.001),
  jointPredictionWeight: Math.max(0, Math.min(1, numberArg(args, "--joint-prediction-weight", 0.35))),
  temporalRegularization: Math.max(0, Math.min(0.25, numberArg(args, "--temporal-regularization", 0.015))),
  orbitRegularization: Math.max(0, Math.min(0.25, numberArg(args, "--orbit-regularization", 0.015))),
  energyDeltaLimit: Math.max(0.1, numberArg(args, "--energy-delta-limit", 5)),
  retainReconstructions: argValue(args, "--retain-reconstructions", "false").toLowerCase() === "true",
};

if (args.includes("--report-only")) {
  const summaryPath = join(outputDir, "summary.json");
  requireFile(summaryPath, "existing joint tensor summary");
  const summary = JSON.parse(await readFile(summaryPath, "utf8"));
  const reportProfiles = summary.profiles.map(profileById);
  summary.verdict = buildVerdict(summary.rows, summary.metric_rows, reportProfiles);
  summary.conclusions = buildConclusions(summary.rows, reportProfiles);
  await Promise.all([
    writeFile(summaryPath, JSON.stringify(summary, null, 2), "utf8"),
    writeFile(join(outputDir, "report.html"), buildHtml(summary, outputDir), "utf8"),
  ]);
  console.log(JSON.stringify({ ok: true, report_only: true, output_dir: outputDir }, null, 2));
  process.exit(0);
}

await mkdir(outputDir, { recursive: true });
const rows = [];
const metricRows = [];
const consistency = [];
for (const profile of profiles) {
  const prepared = await prepareInput({ profile, truthRoot, observationRoot, outputDir, sliceLimit });
  for (const method of methods) {
    const result = await runCompletion({ profile, method, prepared, outputDir, options, reuse });
    rows.push(result.row);
    metricRows.push(...result.metricRows);
    consistency.push({ constellation_profile_id: profile.id, completion_backend: method.id, ...result.physicalConsistency });
  }
}

const audit = fairnessAudit(rows, profiles, methods);
if (!audit.all_profiles_passed) throw new Error(`Fairness audit failed: ${JSON.stringify(audit.by_profile)}`);
const summary = {
  schema_version: "experiment3-joint-tensor-comparison-v1",
  generated_at: new Date().toISOString(),
  formal_experiment: formal,
  purpose: "Compare independent 2D completion and multi-metric joint tensor completion under identical INT observations and overhead",
  profiles: profiles.map((profile) => profile.id),
  methods: methods.map((method) => method.id),
  node_metrics: NODE_METRICS,
  link_metrics: LINK_METRICS,
  parameters: { slice_limit: sliceLimit || null, ...options },
  fairness_boundary: {
    same_int_observations_and_same_telemetry_overhead: true,
    hidden_target_values_used_only_for_evaluation: true,
    observed_only_metric_normalization: true,
    categorical_mode_status_not_continuous_tensor_channels: true,
    topology_down_hard_mask: true,
    offline_reconstruction_not_future_prediction: true,
  },
  fairness_audit: audit,
  verdict: buildVerdict(rows, metricRows, profiles),
  conclusions: buildConclusions(rows, profiles),
  rows,
  metric_rows: metricRows,
};

await Promise.all([
  writeFile(join(outputDir, "summary.json"), JSON.stringify(summary, null, 2), "utf8"),
  writeFile(join(outputDir, "summary.csv"), rowsToCsv(rows), "utf8"),
  writeFile(join(outputDir, "metric-results.csv"), rowsToCsv(metricRows), "utf8"),
  writeFile(join(outputDir, "physical-consistency.json"), JSON.stringify(consistency, null, 2), "utf8"),
  writeFile(join(outputDir, "report.html"), buildHtml(summary, outputDir), "utf8"),
]);

console.log(JSON.stringify({
  ok: true,
  output_dir: outputDir,
  formal_experiment: formal,
  rows: rows.length,
  metric_rows: metricRows.length,
  fairness_passed: audit.all_profiles_passed,
  report_html: join(outputDir, "report.html"),
}, null, 2));
