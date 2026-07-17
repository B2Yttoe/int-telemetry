import { existsSync } from "node:fs";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { cpus, freemem, platform, release, totalmem } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { compareOrbitEpochs } from "./experiments/crossEpochOrbitValidation.mjs";
import { aggregateOrbitEpochComparisons } from "./experiments/multiEpochOrbitValidation.mjs";
import {
  auditEpochIndependence,
  buildEpochRecord,
} from "./experiments/externalEpochRegistry.mjs";
import { runCommandTimed } from "./experiments/intMcExperimentCore.mjs";
import { escapeHtml, rowsToCsv } from "./experiments/reportUtils.mjs";

function argValue(args, name, fallback = "") {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1] ?? fallback;
}

function listArg(args, name, fallback = []) {
  const value = argValue(args, name, "");
  return value ? value.split(",").map((item) => item.trim()).filter(Boolean) : fallback;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function numberValue(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value, digits = 4) {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function timestamp(value) {
  const parsed = new Date(String(value ?? "")).getTime();
  return Number.isFinite(parsed) ? parsed : NaN;
}

function normalizedEvidencePath(value) {
  if (!value) return "";
  return resolve(String(value)).replaceAll("\\", "/").toLowerCase();
}

export function classifyRadarEvidence({ externalReport = {}, trafficMetadata = {} } = {}) {
  const validation = externalReport.traffic_external?.summary ?? {};
  const calibration = trafficMetadata.radar_calibration ?? {};
  const validationSource = normalizedEvidencePath(externalReport.inputs?.radar_json || externalReport.inputs?.radar_csv);
  const calibrationSource = normalizedEvidencePath(calibration.source_path);
  const validationStart = timestamp(validation.external_radar_first_time);
  const validationEnd = timestamp(validation.external_radar_last_time);
  const calibrationStart = timestamp(calibration.first_selected_time);
  const calibrationEnd = timestamp(calibration.last_selected_time);
  const hasRanges = [validationStart, validationEnd, calibrationStart, calibrationEnd].every(Number.isFinite);
  const overlaps = hasRanges && validationStart <= calibrationEnd && calibrationStart <= validationEnd;
  const sameSource = Boolean(validationSource && calibrationSource && validationSource === calibrationSource);
  const classification = sameSource && overlaps
    ? "calibration-fit"
    : hasRanges && !overlaps
      ? "temporal-holdout"
      : validationSource && calibrationSource && !sameSource
        ? "independent-source"
        : "insufficient-provenance";
  return {
    classification,
    independent_holdout: classification === "temporal-holdout" || classification === "independent-source",
    same_source: sameSource,
    time_window_overlap: overlaps,
    calibration_source: calibrationSource,
    validation_source: validationSource,
    calibration_start: calibration.first_selected_time ?? "",
    calibration_end: calibration.last_selected_time ?? "",
    validation_start: validation.external_radar_first_time ?? "",
    validation_end: validation.external_radar_last_time ?? "",
  };
}

async function ensureValidationSnapshot({ validationSnapshotPath, validationRawPath, sourceRawPath, refresh }) {
  if (!refresh && existsSync(validationSnapshotPath)) return validationSnapshotPath;
  if (!existsSync(sourceRawPath)) throw new Error(`Validation GP/TLE raw source not found: ${sourceRawPath}`);
  await mkdir(dirname(validationSnapshotPath), { recursive: true });
  await cp(sourceRawPath, validationRawPath, { force: true });
  await runCommandTimed({
    label: "build independent validation TLE snapshot",
    script: "scripts/fetchRealTleSnapshot.mjs",
    args: [
      "--cache-only",
      "--planes", "72",
      "--satellites-per-plane", "22",
      "--target-inclination", "43",
      "--target-altitude", "490",
      "--raw-out", validationRawPath,
      "--out", validationSnapshotPath,
    ],
  });
  return validationSnapshotPath;
}

function externalSummaries(report = {}) {
  return {
    traffic: report.traffic_external?.summary ?? {},
    network: report.network_performance_external?.summary ?? {},
    source_status: report.external_sources ?? [],
    limitations: report.limitations ?? [],
  };
}

function epochTable(records = []) {
  return records.map((row) => `<tr><td>${escapeHtml(row.name)}</td><td>${escapeHtml(row.role)}</td><td>${escapeHtml(row.epoch_start)}</td><td>${escapeHtml(row.epoch_end)}</td><td>${row.record_count}</td><td><code>${escapeHtml(row.sha256)}</code></td></tr>`).join("");
}

function sourceTable(rows = []) {
  return rows.map((row) => `<tr><td>${escapeHtml(row.name)}</td><td>${escapeHtml(row.status)}</td><td>${escapeHtml(row.url)}</td><td>${escapeHtml(row.detail)}</td></tr>`).join("");
}

function buildExperiment9HtmlLegacy({ evidenceStatus, epochRecords = [], independenceAudit = {}, orbit = {}, external = {} } = {}) {
  const o = orbit.summary ?? {};
  const traffic = external.traffic ?? {};
  const network = external.network ?? {};
  return `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>实验9 多历元外部验证</title><style>body{font-family:Arial,"Microsoft YaHei",sans-serif;margin:0;background:#f3f6f7;color:#17212b}main{max-width:1120px;margin:auto;padding:28px}section{background:#fff;border:1px solid #d6e0e4;margin:16px 0;padding:18px;border-radius:6px}table{border-collapse:collapse;width:100%;font-size:13px}th,td{border:1px solid #d6e0e4;padding:7px;text-align:left}code{font-size:11px;word-break:break-all}.ok{color:#166534}.warn{color:#b45309}</style></head><body><main><h1>实验 9：多历元公开数据外部验证</h1><p class="${evidenceStatus === "complete" ? "ok" : "warn"}">证据状态：${escapeHtml(evidenceStatus)}</p><section><h2>历元与独立性</h2><p>模型输入和外部验证快照按 SHA-256 隔离，独立性审计：${independenceAudit.ok ? "通过" : "失败"}。</p><table><thead><tr><th>来源</th><th>角色</th><th>历元开始</th><th>历元结束</th><th>记录数</th><th>SHA-256</th></tr></thead><tbody>${epochTable(epochRecords)}</tbody></table></section><section><h2>CelesTrak 跨历元轨道对照</h2><table><tbody><tr><th>匹配卫星</th><td>${o.matched_satellites ?? 0}</td></tr><tr><th>平均历元间隔</th><td>${o.epoch_separation_mean_hours ?? 0} h</td></tr><tr><th>ECI 位置 MAE</th><td>${o.eci_position_mae_km ?? 0} km</td></tr><tr><th>径向 MAE</th><td>${o.radial_mae_km ?? 0} km</td></tr><tr><th>沿轨 MAE</th><td>${o.along_track_mae_km ?? 0} km</td></tr><tr><th>横轨 MAE</th><td>${o.cross_track_mae_km ?? 0} km</td></tr></tbody></table><p>误差包含 TLE/SGP4 跨历元传播误差和公开目录后续更新，不代表精密定轨误差。</p></section><section><h2>Cloudflare Radar 业务形状</h2><p>外部点数 ${traffic.external_radar_points ?? 0}，模型与 Radar 归一化曲线相关系数 ${traffic.model_vs_external_radar_corr ?? "未计算"}。Radar 只支持聚合时序形状校准，不是逐卫星业务 trace。</p></section><section><h2>RIPE Atlas 用户侧网络性能</h2><p>公开样本 ${network.external_ripe_ping_samples ?? 0}，模型用户侧 P50 RTT ${network.model_user_ping_p50_ms ?? "未计算"} ms，公开 P50 RTT ${network.external_ripe_rtt_p50_ms ?? "未计算"} ms。内部任务路由时延不与用户侧 RTT 混用。</p></section><section><h2>可验证边界</h2><p>CelesTrak 支持轨道、位置和传播一致性；Cloudflare Radar 支持业务形状；RIPE Atlas 支持用户侧 RTT、丢包和可达性量级。</p><p><strong>CPU、电量和队列是公式驱动的内部潜变量。</strong>它们只能进行物理一致性、守恒关系和业务响应合理性检验，不能声称是 Starlink 或其他运营商内部真值。</p></section><section><h2>外部来源状态</h2><table><thead><tr><th>来源</th><th>状态</th><th>地址</th><th>说明</th></tr></thead><tbody>${sourceTable(external.source_status)}</tbody></table></section></main></body></html>`;
}

function buildExperiment9MarkdownLegacy({ evidenceStatus, epochRecords = [], independenceAudit = {}, orbit = {}, external = {} } = {}) {
  const o = orbit.summary ?? {};
  const traffic = external.traffic ?? {};
  const network = external.network ?? {};
  return `# 实验 9：多历元公开数据外部验证\n\n## 证据状态\n\n- 状态：${evidenceStatus}\n- 历元记录：${epochRecords.length}\n- 输入/检验独立性：${independenceAudit.ok ? "通过" : "失败"}\n\n## CelesTrak 轨道证据\n\n- 匹配卫星：${o.matched_satellites ?? 0}\n- 平均历元间隔：${o.epoch_separation_mean_hours ?? 0} h\n- ECI 位置 MAE：${o.eci_position_mae_km ?? 0} km\n- 径向 MAE：${o.radial_mae_km ?? 0} km\n- 沿轨 MAE：${o.along_track_mae_km ?? 0} km\n- 横轨 MAE：${o.cross_track_mae_km ?? 0} km\n\n以上误差同时包含 TLE/SGP4 跨历元传播误差和 CelesTrak 后续目录更新，不是精密定轨误差。\n\n## Cloudflare Radar 业务证据\n\n- 外部数值点：${traffic.external_radar_points ?? 0}\n- 归一化曲线相关系数：${traffic.model_vs_external_radar_corr ?? "未计算"}\n\nRadar 只用于聚合业务时序形状校准，不能解释成真实逐卫星流量 trace。\n\n## RIPE Atlas 网络证据\n\n- 公开 ping 样本：${network.external_ripe_ping_samples ?? 0}\n- 模型用户侧 P50 RTT：${network.model_user_ping_p50_ms ?? "未计算"} ms\n- 公开 P50 RTT：${network.external_ripe_rtt_p50_ms ?? "未计算"} ms\n\n## 内部潜变量边界\n\nCPU、电量和队列是模型公式生成的内部潜变量，只能通过物理一致性、守恒关系和业务响应合理性进行验证。它们不能被描述为 Starlink 或其他运营商内部真值。\n\n因此，本实验能支持“公开可观测维度与真实数据一致或量级相符”的结论，不能证明所有星上内部状态逐点等于运营商内部真值。\n\n## 产物\n\n- [HTML 报告](reports/experiment9-multi-epoch-external-validation/experiment9-external-validation-report.html)\n- [历元注册表](reports/experiment9-multi-epoch-external-validation/external-epoch-registry.csv)\n- [轨道逐星对照](reports/experiment9-multi-epoch-external-validation/orbit-cross-epoch-comparison.csv)\n`;
}

function radarEvidenceLabel(evidence = {}) {
  if (evidence.classification === "calibration-fit") return "校准拟合（不是独立留出验证）";
  if (evidence.classification === "temporal-holdout") return "时间留出验证";
  if (evidence.classification === "independent-source") return "独立来源验证";
  return "证据来源不足";
}

function orbitEpochRows(perEpoch = []) {
  return perEpoch.map((row) => `<tr><td>${escapeHtml(row.validation_id)}</td><td>${escapeHtml(row.comparison_time)}</td><td>${round(numberValue(row.epoch_separation_mean_hours), 3)}</td><td>${numberValue(row.matched_satellites)}</td><td>${round(numberValue(row.eci_position_mae_km), 3)}</td><td>${round(numberValue(row.radial_mae_km), 3)}</td><td>${round(numberValue(row.along_track_mae_km), 3)}</td><td>${round(numberValue(row.cross_track_mae_km), 3)}</td></tr>`).join("");
}

export function buildExperiment9Html({ evidenceStatus, epochRecords = [], independenceAudit = {}, orbit = {}, external = {} } = {}) {
  const o = orbit.summary ?? {};
  const traffic = external.traffic ?? {};
  const network = external.network ?? {};
  const radar = external.radar_evidence ?? {};
  const validationEpochs = numberValue(o.validation_epoch_count, epochRecords.filter((row) => row.role === "external-validation").length);
  return `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>实验9 多历元外部验证</title><style>body{font-family:Arial,"Microsoft YaHei",sans-serif;margin:0;background:#f3f6f7;color:#17212b}main{max-width:1180px;margin:auto;padding:28px}section{background:#fff;border:1px solid #d6e0e4;margin:16px 0;padding:18px;border-radius:6px}table{border-collapse:collapse;width:100%;font-size:13px}th,td{border:1px solid #d6e0e4;padding:7px;text-align:left}code{font-size:11px;word-break:break-all}.ok{color:#166534}.warn{color:#b45309}</style></head><body><main><h1>实验 9：多历元公开数据外部验证</h1><p class="${evidenceStatus === "complete" ? "ok" : "warn"}">证据状态：${escapeHtml(evidenceStatus)}</p><section><h2>历元独立性</h2><p>共使用 ${validationEpochs} 个独立验证历元；模型输入与验证原始数据按 SHA-256、角色和历元顺序隔离。独立性审计：${independenceAudit.ok ? "通过" : "未通过"}。</p><table><thead><tr><th>来源</th><th>角色</th><th>历元开始</th><th>历元结束</th><th>记录数</th><th>SHA-256</th></tr></thead><tbody>${epochTable(epochRecords)}</tbody></table></section><section><h2>CelesTrak 跨历元轨道验证</h2><p>${validationEpochs} 个独立验证历元，卫星-历元配对 ${o.matched_satellite_epoch_pairs ?? 0}，传播失败 ${o.propagation_failures ?? 0}。</p><table><thead><tr><th>验证历元</th><th>比较时刻</th><th>平均间隔 h</th><th>匹配卫星</th><th>ECI MAE km</th><th>径向</th><th>沿轨</th><th>横轨</th></tr></thead><tbody>${orbitEpochRows(orbit.per_epoch)}</tbody></table><p>综合平均历元间隔 ${o.epoch_separation_mean_hours ?? 0} h，ECI 位置 MAE ${o.eci_position_mae_km ?? 0} km，其中沿轨 MAE ${o.along_track_mae_km ?? 0} km。误差包含 TLE/SGP4 跨历元预测误差和公开目录更新差异，不是精密定轨误差。</p></section><section><h2>Cloudflare Radar 业务证据</h2><p>证据类型：<strong>${escapeHtml(radarEvidenceLabel(radar))}</strong>。归一化相关系数 ${traffic.model_vs_external_radar_corr ?? "未计算"}，外部点数 ${traffic.external_radar_points ?? 0}。该数值只能说明模型拟合了用于驱动业务的聚合时序，不能当作独立泛化证据，也不是逐卫星流量 trace。</p></section><section><h2>RIPE Atlas 网络证据</h2><p>公开样本 ${network.external_ripe_ping_samples ?? 0}；模型用户侧 P50 RTT ${network.model_user_ping_p50_ms ?? "未计算"} ms，公开 P50 RTT ${network.external_ripe_rtt_p50_ms ?? "未计算"} ms。该证据只支持用户侧 RTT、丢包和可达性量级。</p></section><section><h2>结论边界</h2><p>CelesTrak 支持轨道、位置和传播验证；Radar 当前属于校准拟合；RIPE Atlas 支持公开网络性能量级。<strong>CPU、电量和队列属于公式驱动的内部潜变量，只能验证物理一致性和业务响应合理性，不能宣称为 Starlink 或其他运营商内部真值。</strong></p></section><section><h2>外部来源状态</h2><table><thead><tr><th>来源</th><th>状态</th><th>地址</th><th>说明</th></tr></thead><tbody>${sourceTable(external.source_status)}</tbody></table></section></main></body></html>`;
}

export function buildExperiment9Markdown({ evidenceStatus, epochRecords = [], independenceAudit = {}, orbit = {}, external = {} } = {}) {
  const o = orbit.summary ?? {};
  const traffic = external.traffic ?? {};
  const network = external.network ?? {};
  const radar = external.radar_evidence ?? {};
  const validationEpochs = numberValue(o.validation_epoch_count, epochRecords.filter((row) => row.role === "external-validation").length);
  const perEpoch = (orbit.per_epoch ?? []).map((row) => `| ${row.validation_id} | ${row.comparison_time} | ${round(numberValue(row.epoch_separation_mean_hours), 3)} | ${row.matched_satellites} | ${round(numberValue(row.eci_position_mae_km), 3)} | ${round(numberValue(row.radial_mae_km), 3)} | ${round(numberValue(row.along_track_mae_km), 3)} | ${round(numberValue(row.cross_track_mae_km), 3)} |`).join("\n");
  return `# 实验 9：多历元公开数据外部验证\n\n## 证据状态\n\n- 状态：${evidenceStatus}\n- 独立验证历元：${validationEpochs}\n- 输入/验证独立性：${independenceAudit.ok ? "通过" : "未通过"}\n- 卫星-历元配对：${o.matched_satellite_epoch_pairs ?? 0}\n- SGP4 传播失败：${o.propagation_failures ?? 0}\n\n## CelesTrak 轨道证据\n\n本实验使用 ${validationEpochs} 个独立验证历元。\n\n| 验证历元 | 比较时刻 | 平均历元间隔 h | 匹配卫星 | ECI MAE km | 径向 MAE | 沿轨 MAE | 横轨 MAE |\n|---|---|---:|---:|---:|---:|---:|---:|\n${perEpoch}\n\n综合平均历元间隔为 ${o.epoch_separation_mean_hours ?? 0} h，ECI 位置 MAE 为 ${o.eci_position_mae_km ?? 0} km。误差包含 TLE/SGP4 跨历元预测误差和 CelesTrak 后续目录更新差异，不是精密定轨误差。\n\n## Cloudflare Radar 业务证据\n\n- 证据类型：${radarEvidenceLabel(radar)}\n- 外部数值点：${traffic.external_radar_points ?? 0}\n- 归一化曲线相关系数：${traffic.model_vs_external_radar_corr ?? "未计算"}\n\n当前 0.9134 一类相关系数来自与业务生成相同的 Radar 数据和重叠时间窗，因此属于校准拟合，不是独立留出验证。它不能解释成真实逐卫星流量 trace。\n\n## RIPE Atlas 网络证据\n\n- 公开 ping 样本：${network.external_ripe_ping_samples ?? 0}\n- 模型用户侧 P50 RTT：${network.model_user_ping_p50_ms ?? "未计算"} ms\n- 公开 P50 RTT：${network.external_ripe_rtt_p50_ms ?? "未计算"} ms\n\n## 内部潜变量边界\n\nCPU、电量和队列是模型公式生成的内部潜变量，只能通过物理一致性、守恒关系和业务响应合理性进行验证，不能被描述为 Starlink 或其他运营商内部真值。\n\n因此，本实验支持“公开可观测轨道和网络性能维度具有外部证据”的结论，但不能证明所有星上内部状态逐点等于运营商内部真值。\n\n## 产物\n\n- [HTML 报告](reports/experiment9-multi-epoch-external-validation/experiment9-external-validation-report.html)\n- [历元注册表](reports/experiment9-multi-epoch-external-validation/external-epoch-registry.csv)\n- [逐历元汇总](reports/experiment9-multi-epoch-external-validation/orbit-validation-per-epoch.csv)\n- [轨道逐星对照](reports/experiment9-multi-epoch-external-validation/orbit-cross-epoch-comparison.csv)\n`;
}

export async function runExperiment9({
  modelSnapshotPath,
  validationSnapshotPath,
  validationRawPath,
  sourceRawPath,
  additionalValidationRawPaths = [],
  existingExternalReportPath,
  outputDir,
  rootReportPath,
  refreshValidation = false,
  formal = true,
} = {}) {
  await Promise.all([mkdir(outputDir, { recursive: true }), mkdir(dirname(rootReportPath), { recursive: true })]);
  await ensureValidationSnapshot({ validationSnapshotPath, validationRawPath, sourceRawPath, refresh: refreshValidation });
  const validationRawPaths = [validationRawPath, ...additionalValidationRawPaths];
  validationRawPaths.forEach((path) => {
    if (!existsSync(path)) throw new Error(`Validation GP/TLE raw source not found: ${path}`);
  });
  const [modelSnapshot, validationSnapshot, validationRawCatalogs] = await Promise.all([
    readJson(modelSnapshotPath),
    readJson(validationSnapshotPath),
    Promise.all(validationRawPaths.map((path) => readJson(path))),
  ]);
  const baseEpochRecords = await Promise.all([
    buildEpochRecord({
      name: "CelesTrak Starlink 模型输入快照",
      url: modelSnapshot.source_url,
      path: modelSnapshotPath,
      role: "model-input",
      parserVersion: "int-telemetry-real-tle-snapshot/v1",
      retrievedAt: modelSnapshot.downloaded_at,
    }),
    buildEpochRecord({
      name: "CelesTrak Starlink 外部检验原始 GP",
      url: validationSnapshot.source_url,
      path: validationRawPath,
      role: "external-validation",
      parserVersion: "celestrak-gp-json/v1",
    }),
    buildEpochRecord({
      name: "CelesTrak Starlink 外部检验派生 72x22 快照",
      url: validationSnapshot.source_url,
      path: validationSnapshotPath,
      role: "context-only",
      parserVersion: "int-telemetry-real-tle-snapshot/v1",
      retrievedAt: validationSnapshot.downloaded_at,
    }),
  ]);
  const additionalValidationEpochRecords = await Promise.all(additionalValidationRawPaths.map((path, index) => buildEpochRecord({
    name: `CelesTrak Starlink external-validation raw GP ${index + 2}`,
    url: validationSnapshot.source_url,
    path,
    role: "external-validation",
    parserVersion: "celestrak-gp-json/v1",
  })));
  const firstValidationEpochRecord = baseEpochRecords.find((row) => row.role === "external-validation");
  const contextEpochRecords = baseEpochRecords.filter((row) => row.role === "context-only");
  const epochRecords = [
    ...baseEpochRecords.filter((row) => row.role === "model-input"),
    firstValidationEpochRecord,
    ...additionalValidationEpochRecords,
    ...contextEpochRecords,
  ].filter(Boolean);
  const independenceAudit = auditEpochIndependence(epochRecords, {
    minimumValidationEpochs: formal ? 2 : 1,
  });
  const validationEpochRecords = epochRecords.filter((row) => row.role === "external-validation");
  const orbit = aggregateOrbitEpochComparisons(validationEpochRecords.map((record, index) => ({
    validation_id: `validation-${index + 1}`,
    validation_sha256: record.sha256,
    result: compareOrbitEpochs({
      modelSnapshot,
      validationSnapshot: validationRawCatalogs[index],
      comparisonTime: record.epoch_median || record.epoch_end,
    }),
  })));
  const existingExternalReport = existsSync(existingExternalReportPath)
    ? await readJson(existingExternalReportPath)
    : {};
  const external = externalSummaries(existingExternalReport);
  const taskInputPath = existingExternalReport.inputs?.tasks ? resolve(existingExternalReport.inputs.tasks) : "";
  const trafficMetadataPath = taskInputPath.toLowerCase().endsWith(".csv")
    ? `${taskInputPath.slice(0, -4)}.metadata.json`
    : "";
  const trafficMetadata = trafficMetadataPath && existsSync(trafficMetadataPath)
    ? await readJson(trafficMetadataPath)
    : {};
  external.radar_evidence = classifyRadarEvidence({ externalReport: existingExternalReport, trafficMetadata });
  const evidenceStatus = independenceAudit.ok && orbit.summary.successful_propagations > 0
    ? "complete"
    : "incomplete";
  if (formal && evidenceStatus !== "complete") {
    throw new Error(`Experiment 9 external evidence is incomplete: ${independenceAudit.violations.join("; ")}`);
  }
  const reportInput = { evidenceStatus, epochRecords, independenceAudit, orbit, external };
  const outputFiles = {
    epoch_registry_csv: join(outputDir, "external-epoch-registry.csv"),
    independence_audit_json: join(outputDir, "external-independence-audit.json"),
    orbit_comparison_csv: join(outputDir, "orbit-cross-epoch-comparison.csv"),
    orbit_summary_json: join(outputDir, "orbit-cross-epoch-summary.json"),
    orbit_per_epoch_csv: join(outputDir, "orbit-validation-per-epoch.csv"),
    source_status_csv: join(outputDir, "external-source-status.csv"),
    report_json: join(outputDir, "experiment9-external-validation-report.json"),
    report_html: join(outputDir, "experiment9-external-validation-report.html"),
    root_report_md: rootReportPath,
    manifest_json: join(outputDir, "experiment9-manifest.json"),
  };
  const report = {
    schema_version: "experiment9-multi-epoch-external-validation-v1",
    generated_at: new Date().toISOString(),
    evidence_status: evidenceStatus,
    claim_boundaries: {
      public_observables: ["orbit", "position", "propagation", "traffic-shape", "user-rtt", "packet-loss", "reachability"],
      simulator_internal_latent_state: ["cpu", "battery", "queue"],
      operator_internal_truth_claimed: false,
    },
    epoch_records: epochRecords,
    independence_audit: independenceAudit,
    orbit_cross_epoch: orbit,
    external_observations: external,
  };
  const manifest = {
    schema_version: "experiment9-manifest-v1",
    generated_at: report.generated_at,
    host: { platform: platform(), release: release(), cpu_model: cpus()[0]?.model ?? "unknown", logical_cpu_count: cpus().length, total_memory_bytes: totalmem(), free_memory_bytes_at_report: freemem(), node_version: process.version },
    inputs: { model_snapshot: modelSnapshotPath, validation_snapshot: validationSnapshotPath, validation_raws: validationRawPaths, external_report: existingExternalReportPath },
    output_files: outputFiles,
    evidence_status: evidenceStatus,
  };
  await Promise.all([
    writeFile(outputFiles.epoch_registry_csv, rowsToCsv(epochRecords), "utf8"),
    writeJson(outputFiles.independence_audit_json, independenceAudit),
    writeFile(outputFiles.orbit_comparison_csv, rowsToCsv(orbit.rows), "utf8"),
    writeJson(outputFiles.orbit_summary_json, orbit.summary),
    writeFile(outputFiles.orbit_per_epoch_csv, rowsToCsv(orbit.per_epoch), "utf8"),
    writeFile(outputFiles.source_status_csv, rowsToCsv(external.source_status), "utf8"),
    writeJson(outputFiles.report_json, report),
    writeFile(outputFiles.report_html, buildExperiment9Html(reportInput), "utf8"),
    writeFile(outputFiles.root_report_md, buildExperiment9Markdown(reportInput), "utf8"),
    writeJson(outputFiles.manifest_json, manifest),
  ]);
  return { report, manifest, outputFiles };
}

async function main() {
  const args = process.argv.slice(2);
  const outputDir = resolve(argValue(args, "--out", "reports/experiment9-multi-epoch-external-validation"));
  const inputDir = join(outputDir, "input");
  const defaultAdditionalValidationRaw = join(inputDir, "celestrak-validation-raw-latest.json");
  const result = await runExperiment9({
    modelSnapshotPath: resolve(argValue(args, "--model-snapshot", "data/tle-snapshots/celestrak-starlink-real-walker-72x22.json")),
    validationSnapshotPath: resolve(argValue(args, "--validation-snapshot", join(inputDir, "celestrak-validation-72x22.json"))),
    validationRawPath: resolve(argValue(args, "--validation-raw", join(inputDir, "celestrak-validation-raw.json"))),
    sourceRawPath: resolve(argValue(args, "--source-raw", "data/tle-snapshots/celestrak-starlink-raw-gp.json")),
    additionalValidationRawPaths: listArg(
      args,
      "--additional-validation-raws",
      existsSync(defaultAdditionalValidationRaw) ? [defaultAdditionalValidationRaw] : [],
    ).map((path) => resolve(path)),
    existingExternalReportPath: resolve(argValue(args, "--external-report", "reports/experiment1-satellite-data-authenticity/external-realism-report.json")),
    outputDir,
    rootReportPath: resolve(argValue(args, "--root-report", "EXPERIMENT_9_EXTERNAL_VALIDATION_REPORT.md")),
    refreshValidation: argValue(args, "--refresh-validation", "false").toLowerCase() === "true",
    formal: argValue(args, "--formal", "true").toLowerCase() !== "false",
  });
  console.log(JSON.stringify({
    ok: true,
    output_dir: outputDir,
    evidence_status: result.report.evidence_status,
    matched_satellites: result.report.orbit_cross_epoch.summary.matched_satellites,
    root_report: relative(process.cwd(), result.outputFiles.root_report_md),
    validation_snapshot: basename(result.manifest.inputs.validation_snapshot),
    validation_epochs: result.report.orbit_cross_epoch.summary.validation_epoch_count,
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
