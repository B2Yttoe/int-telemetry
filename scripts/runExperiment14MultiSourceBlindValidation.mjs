import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { compareOrbitEpochs } from "./experiments/crossEpochOrbitValidation.mjs";
import {
  bootstrapInterval,
  buildRadarBlindHoldout,
  compareDistributions,
  distributionSummary,
  empiricalCdfRows,
  geographicBoxRows,
  mean,
  quantile,
  round,
  sha256,
} from "./experiments/blindValidationMetrics.mjs";
import {
  deterministicObservationSubset,
  extractRadarSeries,
  fetchJson,
  fetchRipeBlindWindow,
  hashFile,
  loadHistoricalOrbitRates,
  loadMlabMember,
  loadModelThroughput,
  loadRttTopology,
  medianEpoch,
  simulateUserRtt,
} from "./experiments/experiment14Sources.mjs";

const args = process.argv.slice(2);

function argValue(name, fallback = "") {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? fallback : fallback;
}

function hasArg(name) {
  return args.includes(name);
}

function rel(path) {
  return relative(process.cwd(), path).replaceAll("\\", "/");
}

function csvEscape(value) {
  const text = value === null || value === undefined ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

async function writeCsv(path, rows) {
  await mkdir(dirname(path), { recursive: true });
  const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const lines = [headers.join(","), ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(","))];
  await writeFile(path, `${lines.join("\n")}\n`, "utf8");
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function listFiles(path) {
  if (!existsSync(path)) return [];
  const info = await stat(path);
  if (info.isFile()) return [path];
  const entries = await readdir(path, { withFileTypes: true });
  const output = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    output.push(...await listFiles(join(path, entry.name)));
  }
  return output;
}

function gitText(parameters, fallback = "") {
  try {
    return execFileSync("git", parameters, { cwd: process.cwd(), encoding: "utf8", windowsHide: true }).trim();
  } catch {
    return fallback;
  }
}

function categoryFor(path) {
  const normalized = rel(path);
  if (normalized.startsWith("src/") || normalized.endsWith(".mjs")) return "code";
  if (normalized.endsWith(".json") && normalized.includes("protocol")) return "parameters";
  if (normalized.includes("traffic-calibration") || normalized.includes("constellationProfiles")) return "configuration";
  return "frozen-input";
}

function aggregateHash(records, category = null) {
  const hash = createHash("sha256");
  records.filter((record) => !category || record.category === category)
    .sort((left, right) => left.path.localeCompare(right.path))
    .forEach((record) => hash.update(`${record.path}\0${record.sha256}\n`));
  return hash.digest("hex");
}

async function createFreezeManifest({ outDir, protocolPath, protocol }) {
  const roots = [
    resolve("src/simulation"),
    resolve("src/config/constellationProfiles.ts"),
    resolve("package.json"),
    resolve("package-lock.json"),
    resolve("scripts/generateRadarCalibratedTraffic.mjs"),
    resolve("scripts/runExternalRealismExperiment.mjs"),
    resolve("scripts/experiments/crossEpochOrbitValidation.mjs"),
    resolve("scripts/experiments/blindValidationMetrics.mjs"),
    resolve("scripts/experiments/experiment14Sources.mjs"),
    resolve("scripts/runExperiment14MultiSourceBlindValidation.mjs"),
    protocolPath,
    resolve(protocol.model.orbit_input),
    resolve(protocol.model.traffic_calibration_profile),
    resolve(protocol.model.truth_root, "metadata.json"),
    resolve(protocol.model.truth_root, "nodes.csv"),
    resolve(protocol.model.truth_root, "links.csv"),
    resolve(protocol.model.truth_root, "routes.csv"),
    resolve(protocol.orbit.historical_calibration_csv),
  ];
  const files = [...new Set((await Promise.all(roots.map(listFiles))).flat())].sort();
  const records = [];
  for (const path of files) {
    const info = await stat(path);
    records.push({
      path: rel(path),
      category: categoryFor(path),
      bytes: info.size,
      sha256: await hashFile(path),
    });
  }
  const frozenAt = new Date().toISOString();
  const manifest = {
    schema: "int-telemetry-experiment14-freeze-manifest/v1",
    experiment_id: protocol.experiment_id,
    frozen_at: frozenAt,
    policy: {
      external_test_acquisition_starts_after_freeze: true,
      test_set_parameter_updates_allowed: false,
      test_results_may_not_modify_protocol: true,
    },
    git: {
      commit: gitText(["rev-parse", "HEAD"], "not-a-git-commit"),
      branch: gitText(["branch", "--show-current"], "unknown"),
      dirty: gitText(["status", "--porcelain"], "").length > 0,
      status_sha256: sha256(gitText(["status", "--porcelain=v1", "--untracked-files=all"], "")),
    },
    hashes: {
      aggregate_sha256: aggregateHash(records),
      code_sha256: aggregateHash(records, "code"),
      parameter_sha256: aggregateHash(records, "parameters"),
      configuration_sha256: aggregateHash(records, "configuration"),
      frozen_input_sha256: aggregateHash(records, "frozen-input"),
    },
    files: records,
  };
  const manifestPath = join(outDir, "freeze-manifest.json");
  await writeJson(manifestPath, manifest);
  await writeFile(join(outDir, "freeze-manifest.sha256"), `${await hashFile(manifestPath)}  freeze-manifest.json\n`, "utf8");
  return manifest;
}

function normalizeOrbitRecords(payload) {
  if (Array.isArray(payload)) return payload;
  return payload.satellites ?? payload.records ?? [];
}

function orbitReferenceSummary(id, result, envelopeRate) {
  const successful = result.rows.filter((row) => Number.isFinite(Number(row.eci_position_error_km)));
  const covered = successful.filter((row) =>
    Number(row.eci_position_error_km) <= envelopeRate * Math.max(1, Math.abs(Number(row.epoch_separation_hours))),
  );
  return {
    reference_id: id,
    ...result.summary,
    historical_p95_error_rate_km_per_hour: round(envelopeRate),
    envelope_coverage: round(covered.length / Math.max(successful.length, 1)),
  };
}

function addOrbitEnvelope(id, rows, envelopeRate) {
  return rows.map((row) => {
    const hours = Math.max(1, Math.abs(Number(row.epoch_separation_hours)));
    const upper = envelopeRate * hours;
    return {
      reference_id: id,
      ...row,
      predicted_error_upper_km: round(upper),
      covered_by_historical_envelope: Number(row.eci_position_error_km) <= upper,
    };
  });
}

function detectRadarPriorExposure(trafficMetadata, radarResult) {
  const previous = trafficMetadata?.radar_calibration?.selected_time_series ?? [];
  const testTimes = new Set(radarResult.rows.filter((row) => row.split === "blind-test").map((row) => row.time));
  const overlaps = previous.map((row) => row.radar_time).filter((time) => testTimes.has(time));
  return {
    prior_selected_points: previous.length,
    blind_test_points: testTimes.size,
    overlapping_points: overlaps.length,
    overlap_ratio_of_blind_test: round(overlaps.length / Math.max(testTimes.size, 1)),
    overlapping_start: overlaps[0] ?? "",
    overlapping_end: overlaps.at(-1) ?? "",
    fully_investigator_blind: overlaps.length === 0,
    pipeline_frozen_for_experiment14: true,
    interpretation: overlaps.length
      ? "实验 14 流水线未用测试半段拟合，但同一 Radar 文件的末 48 点曾用于实验 1 业务生成，因此这是严格代码冻结的时间留出，不是完全无历史暴露的研究者盲测。"
      : "测试半段未在既有业务元数据中出现。",
  };
}

function boxPlotSvg(rows, title, { width = 1060, rowHeight = 28 } = {}) {
  const usable = rows.filter((row) => Number.isFinite(Number(row.p05)) && Number.isFinite(Number(row.p95)));
  if (!usable.length) return `<p class="empty">无可绘制数据</p>`;
  const height = Math.max(180, 70 + usable.length * rowHeight);
  const left = 190;
  const right = 40;
  const max = Math.max(...usable.map((row) => Number(row.p95))) * 1.05;
  const scale = (value) => left + (Number(value) / Math.max(max, 1e-9)) * (width - left - right);
  const colors = ["#176b87", "#c76b0a", "#2f855a", "#8b5cf6"];
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(title)}">
    <text x="${left}" y="24" class="chart-title">${escapeHtml(title)}</text>
    <line x1="${left}" y1="42" x2="${width - right}" y2="42" class="axis"/>
    ${[0, 0.25, 0.5, 0.75, 1].map((p) => `<g><line x1="${scale(max * p)}" y1="38" x2="${scale(max * p)}" y2="${height - 20}" class="grid"/><text x="${scale(max * p)}" y="36" class="tick">${round(max * p, 1)}</text></g>`).join("")}
    ${usable.map((row, index) => {
      const y = 60 + index * rowHeight;
      const color = colors[index % colors.length];
      const label = `${row.geographic_group} · ${row.source}`;
      return `<g><text x="${left - 8}" y="${y + 5}" text-anchor="end" class="label">${escapeHtml(label)}</text><line x1="${scale(row.p05)}" y1="${y}" x2="${scale(row.p95)}" y2="${y}" stroke="${color}" stroke-width="2"/><rect x="${scale(row.p25)}" y="${y - 7}" width="${Math.max(1, scale(row.p75) - scale(row.p25))}" height="14" fill="${color}" fill-opacity=".22" stroke="${color}"/><line x1="${scale(row.p50)}" y1="${y - 9}" x2="${scale(row.p50)}" y2="${y + 9}" stroke="${color}" stroke-width="2"/></g>`;
    }).join("")}
  </svg>`;
}

function lineChartSvg(rows, series, title, { width = 1060, height = 320 } = {}) {
  if (!rows.length) return `<p class="empty">无可绘制数据</p>`;
  const left = 58;
  const right = 24;
  const top = 42;
  const bottom = 42;
  const values = rows.flatMap((row) => series.map((item) => Number(row[item.key]))).filter(Number.isFinite);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = Math.max(max - min, 1e-9);
  const x = (index) => left + (index / Math.max(rows.length - 1, 1)) * (width - left - right);
  const y = (value) => top + ((max - value) / span) * (height - top - bottom);
  const paths = series.map((item) => {
    const points = rows.map((row, index) => Number.isFinite(Number(row[item.key])) ? `${x(index)},${y(Number(row[item.key]))}` : null);
    const segments = [];
    let current = [];
    for (const point of points) {
      if (point) current.push(point);
      else if (current.length) {
        segments.push(current);
        current = [];
      }
    }
    if (current.length) segments.push(current);
    return segments.map((segment) => `<polyline points="${segment.join(" ")}" fill="none" stroke="${item.color}" stroke-width="2"/>`).join("");
  }).join("");
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(title)}"><text x="${left}" y="24" class="chart-title">${escapeHtml(title)}</text>${[0, .25, .5, .75, 1].map((p) => {
    const value = min + span * p;
    return `<g><line x1="${left}" y1="${y(value)}" x2="${width - right}" y2="${y(value)}" class="grid"/><text x="${left - 8}" y="${y(value) + 4}" text-anchor="end" class="tick">${round(value, 2)}</text></g>`;
  }).join("")}<line x1="${left}" y1="${height - bottom}" x2="${width - right}" y2="${height - bottom}" class="axis"/>${paths}<g transform="translate(${left},${height - 14})">${series.map((item, index) => `<g transform="translate(${index * 190},0)"><line x1="0" y1="-4" x2="22" y2="-4" stroke="${item.color}" stroke-width="3"/><text x="28" y="0" class="label">${escapeHtml(item.label)}</text></g>`).join("")}</g></svg>`;
}

function cdfChartSvg(rows, series, title, unit) {
  const expanded = rows.map((row) => ({ ...row, probability_percent: Number(row.probability) * 100 }));
  return lineChartSvg(expanded, series, `${title}（横轴为 0–100% 分位，纵轴单位 ${unit}）`);
}

function barChartSvg(rows, key, labelKey, title, expected = null) {
  if (!rows.length) return `<p class="empty">无可绘制数据</p>`;
  const width = 1060;
  const height = 270;
  const left = 70;
  const bottom = 60;
  const top = 42;
  const barWidth = Math.min(120, (width - left - 40) / rows.length * .55);
  const xStep = (width - left - 40) / rows.length;
  const y = (value) => top + (1 - Math.max(0, Math.min(1, Number(value)))) * (height - top - bottom);
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(title)}"><text x="${left}" y="24" class="chart-title">${escapeHtml(title)}</text>${[0,.25,.5,.75,1].map((value) => `<g><line x1="${left}" y1="${y(value)}" x2="${width - 20}" y2="${y(value)}" class="grid"/><text x="${left - 8}" y="${y(value)+4}" text-anchor="end" class="tick">${round(value*100,0)}%</text></g>`).join("")}${expected !== null ? `<line x1="${left}" y1="${y(expected)}" x2="${width - 20}" y2="${y(expected)}" stroke="#b91c1c" stroke-dasharray="6 5"/>` : ""}${rows.map((row,index)=>{const center=left+xStep*(index+.5);const value=Number(row[key]);return `<g><rect x="${center-barWidth/2}" y="${y(value)}" width="${barWidth}" height="${height-bottom-y(value)}" fill="#176b87"/><text x="${center}" y="${y(value)-7}" text-anchor="middle" class="label">${round(value*100,1)}%</text><text x="${center}" y="${height-bottom+20}" text-anchor="middle" class="label">${escapeHtml(row[labelKey])}</text></g>`;}).join("")}</svg>`;
}

function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function metricTable(rows) {
  return `<table><thead><tr>${Object.keys(rows[0] ?? {}).map((key) => `<th>${escapeHtml(key)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${Object.keys(rows[0]).map((key) => `<td>${escapeHtml(row[key])}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}

function buildConclusions({ radar, radarExposure, orbitSummaries, ripeComparison, mlabRttComparison, throughputComparison }) {
  const successes = [];
  const biases = [];
  if (orbitSummaries.some((row) => Number(row.successful_propagations) > 0)) {
    successes.push(`新的 GP/SupGP 参考共完成 ${orbitSummaries.reduce((sum, row) => sum + Number(row.successful_propagations ?? 0), 0)} 次同 NORAD 卫星传播对照，轨道证据不再只依赖内部约束。`);
  }
  if (Number(radar.summary.blind_pearson_correlation) > 0.5) successes.push(`Radar 后半段相关系数为 ${radar.summary.blind_pearson_correlation}，训练半段学到的日周期对留出窗口具有可见解释力。`);
  else biases.push(`Radar 后半段相关系数仅为 ${radar.summary.blind_pearson_correlation}，当前周期校准不能充分解释留出窗口波动。`);
  if (ripeComparison?.p50_ratio_model_to_external >= 0.5 && ripeComparison?.p50_ratio_model_to_external <= 2) {
    successes.push(`模型与新 RIPE Atlas 盲测的 RTT P50 比例为 ${ripeComparison.p50_ratio_model_to_external}，中位数量级一致。`);
  } else if (ripeComparison) biases.push(`模型与 RIPE Atlas RTT P50 比例为 ${ripeComparison.p50_ratio_model_to_external}，存在明显量级偏差。`);
  if (mlabRttComparison) biases.push(`M-Lab RTT 的 KS 距离为 ${mlabRttComparison.ks_distance}；它包含用户接入、地面骨干和测量服务器距离，不能要求与简化网关模型逐点相等。`);
  if (throughputComparison) biases.push(`吞吐 P50 比例为 ${throughputComparison.p50_ratio_model_to_external}，但模型列是内部任务承载速率代理，M-Lab 列是用户 NDT7 下载吞吐；该图用于暴露分布差距，不作为同口径拟合分数。`);
  if (!radarExposure.fully_investigator_blind) biases.push(radarExposure.interpretation);
  biases.push("CPU、电量、队列等运营商内部状态没有公开逐星真值，本实验不把这些内部潜变量包装为外部盲测通过项。");
  return { successes, biases };
}

async function main() {
  const protocolPath = resolve(argValue("--protocol", "scripts/experiments/experiment14-blind-protocol.json"));
  const outDir = resolve(argValue("--out", "reports/experiment14-multisource-external-blind-validation"));
  if (existsSync(join(outDir, "freeze-manifest.json")) && !hasArg("--replace")) {
    throw new Error(`实验 14 已冻结：${rel(outDir)}。为保护盲测证据，默认拒绝覆盖；明确重做时使用新的 --out 目录。`);
  }
  await mkdir(outDir, { recursive: true });
  const protocol = JSON.parse(await readFile(protocolPath, "utf8"));
  if (protocol.reporting.allow_test_set_parameter_updates !== false) throw new Error("Protocol must forbid test-set parameter updates");
  const freeze = await createFreezeManifest({ outDir, protocolPath, protocol });
  const externalDir = join(outDir, "external");
  await mkdir(externalDir, { recursive: true });
  const sourceRegistry = [];
  const sourceStatus = [];

  const modelSnapshotPath = resolve(protocol.model.orbit_input);
  const modelSnapshot = JSON.parse(await readFile(modelSnapshotPath, "utf8"));
  sourceRegistry.push({
    source: "CelesTrak 标准 GP 模型输入",
    role: "frozen-model-input",
    url: modelSnapshot.source_url ?? "https://celestrak.org/NORAD/elements/gp.php?NAME=STARLINK&FORMAT=JSON",
    acquired_at: modelSnapshot.generated_at ?? modelSnapshot.downloaded_at ?? "",
    sha256: await hashFile(modelSnapshotPath),
    records: normalizeOrbitRecords(modelSnapshot).length,
    used_for_parameter_fit: true,
    used_for_test_scoring: false,
  });

  const historicalOrbitRates = await loadHistoricalOrbitRates(
    resolve(protocol.orbit.historical_calibration_csv),
    protocol.orbit.minimum_epoch_separation_hours,
  );
  const orbitEnvelopeRate = quantile(
    historicalOrbitRates.map((row) => row.error_rate_km_per_hour),
    protocol.orbit.error_envelope_quantile,
  );
  sourceRegistry.push({
    source: "实验 9 历史未来 GP 误差",
    role: "confidence-envelope-calibration",
    url: rel(resolve(protocol.orbit.historical_calibration_csv)),
    acquired_at: freeze.frozen_at,
    sha256: await hashFile(resolve(protocol.orbit.historical_calibration_csv)),
    records: historicalOrbitRates.length,
    used_for_parameter_fit: false,
    used_for_interval_calibration: true,
    used_for_test_scoring: false,
  });

  const orbitRows = [];
  const orbitSummaries = [];
  for (const reference of [
    { id: "future-standard-gp", url: protocol.orbit.live_gp_url, filename: "celestrak-starlink-future-gp.json" },
    { id: "future-spacex-supgp", url: protocol.orbit.live_supgp_url, filename: "celestrak-starlink-future-supgp.json" },
  ]) {
    const acquiredAt = new Date().toISOString();
    try {
      const payload = await fetchJson(reference.url, { timeoutMs: 120_000 });
      const records = normalizeOrbitRecords(payload);
      if (!records.length) throw new Error("返回数据不含轨道记录");
      const sourcePath = join(externalDir, reference.filename);
      await writeJson(sourcePath, payload);
      const comparisonTime = medianEpoch(records);
      const result = compareOrbitEpochs({
        modelSnapshot,
        validationSnapshot: { satellites: records, downloaded_at: acquiredAt },
        comparisonTime,
      });
      orbitRows.push(...addOrbitEnvelope(reference.id, result.rows, orbitEnvelopeRate));
      orbitSummaries.push(orbitReferenceSummary(reference.id, result, orbitEnvelopeRate));
      sourceRegistry.push({
        source: reference.id,
        role: "external-blind-test",
        url: reference.url,
        acquired_at: acquiredAt,
        reference_epoch: comparisonTime,
        sha256: await hashFile(sourcePath),
        records: records.length,
        used_for_parameter_fit: false,
        used_for_test_scoring: true,
      });
      sourceStatus.push({ source: reference.id, status: "成功", detail: `${result.summary.successful_propagations} 个匹配传播` });
    } catch (error) {
      sourceStatus.push({ source: reference.id, status: "失败", detail: error.message });
    }
  }
  await writeCsv(join(outDir, "orbit-errors.csv"), orbitRows);
  await writeCsv(join(outDir, "orbit-summary.csv"), orbitSummaries);

  const radarSourcePath = resolve(protocol.radar.source);
  const radarPayload = JSON.parse(await readFile(radarSourcePath, "utf8"));
  const radarSeries = extractRadarSeries(radarPayload);
  const radarResult = buildRadarBlindHoldout(radarSeries, protocol.radar);
  const trafficMetadataPath = resolve(protocol.model.traffic_metadata);
  const trafficMetadata = existsSync(trafficMetadataPath) ? JSON.parse(await readFile(trafficMetadataPath, "utf8")) : {};
  const radarExposure = detectRadarPriorExposure(trafficMetadata, radarResult);
  await writeCsv(join(outDir, "radar-holdout-timeseries.csv"), radarResult.rows);
  await writeJson(join(outDir, "radar-holdout-summary.json"), { ...radarResult.summary, coefficients: radarResult.coefficients, prior_exposure_audit: radarExposure });
  const radarTrain = radarResult.rows.filter((row) => row.split !== "blind-test");
  const radarTest = radarResult.rows.filter((row) => row.split === "blind-test");
  sourceRegistry.push(
    {
      source: "Cloudflare Radar AS14593 前半段",
      role: "traffic-calibration-only",
      url: "https://radar.cloudflare.com/traffic/as14593",
      acquired_at: new Date().toISOString(),
      data_start: radarTrain[0]?.time ?? "",
      data_end: radarTrain.at(-1)?.time ?? "",
      sha256: sha256(JSON.stringify(radarTrain.map((row) => [row.time, row.external_radar_value]))),
      records: radarTrain.length,
      used_for_parameter_fit: true,
      used_for_test_scoring: false,
    },
    {
      source: "Cloudflare Radar AS14593 后半段",
      role: "temporal-holdout-test",
      url: "https://radar.cloudflare.com/traffic/as14593",
      acquired_at: new Date().toISOString(),
      data_start: radarTest[0]?.time ?? "",
      data_end: radarTest.at(-1)?.time ?? "",
      sha256: sha256(JSON.stringify(radarTest.map((row) => [row.time, row.external_radar_value]))),
      records: radarTest.length,
      used_for_parameter_fit: false,
      used_for_test_scoring: true,
      prior_repository_exposure_points: radarExposure.overlapping_points,
    },
  );
  sourceStatus.push({ source: "Cloudflare Radar", status: "成功", detail: `前 ${radarTrain.length} 点校准，后 ${radarTest.length} 点评分；历史暴露 ${radarExposure.overlapping_points} 点` });

  let mlabThroughput = { rows: [], metadata: {} };
  let mlabLatency = { rows: [], metadata: {} };
  try {
    const acquiredAt = new Date().toISOString();
    mlabThroughput = await loadMlabMember({
      url: protocol.mlab.dataset_url,
      member: protocol.mlab.throughput_member,
      config: protocol.mlab,
      metric: "download_throughput_mbps",
    });
    mlabLatency = await loadMlabMember({
      url: protocol.mlab.dataset_url,
      member: protocol.mlab.latency_member,
      config: protocol.mlab,
      metric: "download_latency_ms",
    });
    const mlabColumns = ["uuid", "test_time", "data_source", "client_city", "client_country_code", "server_city", "server_country_code", "packet_loss_rate", "download_throughput_mbps", "download_latency_ms", "download_jitter_ms", "lat", "lon", "sat_density", "client_server_distance_km"];
    await writeCsv(join(externalDir, "mlab-ndt7-throughput-test-sample.csv"), mlabThroughput.rows.map((row) => Object.fromEntries(mlabColumns.map((key) => [key, row[key]]))));
    await writeCsv(join(externalDir, "mlab-ndt7-latency-test-sample.csv"), mlabLatency.rows.map((row) => Object.fromEntries(mlabColumns.map((key) => [key, row[key]]))));
    await writeJson(join(externalDir, "mlab-source-metadata.json"), { throughput: mlabThroughput.metadata, latency: mlabLatency.metadata });
    sourceRegistry.push(
      {
        source: "M-Lab NDT7 Starlink throughput via Horizon",
        role: "external-blind-test",
        url: protocol.mlab.dataset_doi,
        acquired_at: acquiredAt,
        data_start: protocol.mlab.test_start,
        data_end: protocol.mlab.test_end,
        sha256: mlabThroughput.metadata.content_sha256,
        records: mlabThroughput.rows.length,
        used_for_parameter_fit: false,
        used_for_test_scoring: true,
        license: protocol.mlab.license,
      },
      {
        source: "M-Lab NDT7 Starlink latency via Horizon",
        role: "external-blind-test",
        url: protocol.mlab.dataset_doi,
        acquired_at: acquiredAt,
        data_start: protocol.mlab.test_start,
        data_end: protocol.mlab.test_end,
        sha256: mlabLatency.metadata.content_sha256,
        records: mlabLatency.rows.length,
        used_for_parameter_fit: false,
        used_for_test_scoring: true,
        license: protocol.mlab.license,
      },
    );
    sourceStatus.push({ source: "M-Lab NDT7", status: "成功", detail: `吞吐 ${mlabThroughput.rows.length}，时延 ${mlabLatency.rows.length} 个确定性抽样` });
  } catch (error) {
    sourceStatus.push({ source: "M-Lab NDT7", status: "失败", detail: error.message });
  }

  let ripe = null;
  try {
    ripe = await fetchRipeBlindWindow(protocol.ripe_atlas, freeze.frozen_at);
    await writeJson(join(externalDir, "ripe-atlas-probes-as14593.json"), ripe.probes_payload);
    await writeJson(join(externalDir, `ripe-atlas-measurement-${protocol.ripe_atlas.measurement_id}-results.json`), ripe.results);
    const ripePath = join(externalDir, `ripe-atlas-measurement-${protocol.ripe_atlas.measurement_id}-results.json`);
    sourceRegistry.push({
      source: "RIPE Atlas AS14593 public probes",
      role: "external-blind-test",
      url: ripe.window.results_url,
      acquired_at: new Date().toISOString(),
      data_start: ripe.window.start,
      data_end: ripe.window.stop,
      sha256: await hashFile(ripePath),
      records: ripe.results.filter((row) => Number.isFinite(Number(row.avg))).length,
      used_for_parameter_fit: false,
      used_for_test_scoring: true,
    });
    sourceStatus.push({ source: "RIPE Atlas", status: "成功", detail: `${ripe.selected_probes.length} 个探针，${ripe.results.filter((row) => Number.isFinite(Number(row.avg))).length} 个结果` });
  } catch (error) {
    sourceStatus.push({ source: "RIPE Atlas", status: "失败", detail: error.message });
  }

  const truthRoot = resolve(protocol.model.truth_root);
  const topology = await loadRttTopology(join(truthRoot, "nodes.csv"), join(truthRoot, "links.csv"));
  const rttConfig = {
    minimum_elevation_deg: protocol.ripe_atlas.minimum_elevation_deg,
    processing_one_way_ms: protocol.ripe_atlas.processing_one_way_ms,
    terrestrial_tail_one_way_ms: protocol.ripe_atlas.terrestrial_tail_one_way_ms,
  };
  const ripePaired = ripe ? simulateUserRtt({
    topology,
    observations: ripe.results,
    config: rttConfig,
    externalField: "avg",
    sourceLabel: "RIPE Atlas",
  }) : [];
  const mlabPairedInput = deterministicObservationSubset(
    mlabLatency.rows,
    protocol.mlab.maximum_paired_model_samples,
    protocol.mlab.deterministic_sample_seed + 1,
  );
  const mlabPaired = simulateUserRtt({
    topology,
    observations: mlabPairedInput,
    config: rttConfig,
    externalField: "download_latency_ms",
    sourceLabel: "M-Lab NDT7",
  });
  const pairedRtt = [...ripePaired, ...mlabPaired];
  await writeCsv(join(outDir, "rtt-paired-blind-samples.csv"), pairedRtt);

  const validRipe = ripePaired.filter((row) => Number.isFinite(Number(row.model_rtt_ms)) && Number.isFinite(Number(row.external_rtt_ms)));
  const validMlab = mlabPaired.filter((row) => Number.isFinite(Number(row.model_rtt_ms)) && Number.isFinite(Number(row.external_rtt_ms)));
  const ripeComparison = validRipe.length ? compareDistributions(
    validRipe.map((row) => Number(row.model_rtt_ms)),
    validRipe.map((row) => Number(row.external_rtt_ms)),
  ) : null;
  const mlabRttComparison = validMlab.length ? compareDistributions(
    validMlab.map((row) => Number(row.model_rtt_ms)),
    validMlab.map((row) => Number(row.external_rtt_ms)),
  ) : null;

  const modelThroughputRows = await loadModelThroughput(join(truthRoot, "routes.csv"));
  const modelThroughput = modelThroughputRows.map((row) => row.model_carried_traffic_mbps);
  const externalThroughput = mlabThroughput.rows.map((row) => Number(row.download_throughput_mbps)).filter(Number.isFinite);
  const throughputComparison = modelThroughput.length && externalThroughput.length
    ? compareDistributions(modelThroughput, externalThroughput)
    : null;
  await writeCsv(join(outDir, "model-throughput-proxy.csv"), modelThroughputRows);

  const rttCdf = empiricalCdfRows({
    model_matched_ripe_rtt_ms: validRipe.map((row) => Number(row.model_rtt_ms)),
    external_ripe_rtt_ms: validRipe.map((row) => Number(row.external_rtt_ms)),
    model_matched_mlab_rtt_ms: validMlab.map((row) => Number(row.model_rtt_ms)),
    external_mlab_rtt_ms: validMlab.map((row) => Number(row.external_rtt_ms)),
  }, protocol.statistics.cdf_points);
  const throughputCdf = empiricalCdfRows({
    model_internal_task_rate_mbps: modelThroughput,
    external_mlab_ndt7_download_mbps: externalThroughput,
  }, protocol.statistics.cdf_points);
  await writeCsv(join(outDir, "rtt-cdf.csv"), rttCdf);
  await writeCsv(join(outDir, "throughput-cdf.csv"), throughputCdf);

  const geoOptions = {
    groupField: "country",
    minimumSamples: protocol.statistics.minimum_geographic_samples,
    maximumGroups: protocol.statistics.maximum_geographic_groups,
  };
  const geographicRows = [
    ...geographicBoxRows(validRipe, "external_rtt_ms", { ...geoOptions, source: "RIPE Atlas 外部" }).map((row) => ({ ...row, metric: "rtt_ms" })),
    ...geographicBoxRows(validRipe, "model_rtt_ms", { ...geoOptions, source: "模型配对 RIPE" }).map((row) => ({ ...row, metric: "rtt_ms" })),
    ...geographicBoxRows(validMlab, "external_rtt_ms", { ...geoOptions, source: "M-Lab 外部" }).map((row) => ({ ...row, metric: "rtt_ms" })),
    ...geographicBoxRows(validMlab, "model_rtt_ms", { ...geoOptions, source: "模型配对 M-Lab" }).map((row) => ({ ...row, metric: "rtt_ms" })),
    ...geographicBoxRows(mlabThroughput.rows, "download_throughput_mbps", {
      groupField: "client_country_code",
      minimumSamples: protocol.statistics.minimum_geographic_samples,
      maximumGroups: protocol.statistics.maximum_geographic_groups,
      source: "M-Lab NDT7 外部",
    }).map((row) => ({ ...row, metric: "throughput_mbps" })),
  ];
  await writeCsv(join(outDir, "geographic-boxplots.csv"), geographicRows);

  const intervalCoverage = [];
  intervalCoverage.push({
    evidence: "Cloudflare Radar 后半段",
    interval_source: "前半段 split-conformal",
    expected_coverage: protocol.radar.prediction_interval_coverage,
    observed_coverage: radarResult.summary.blind_interval_coverage,
    sample_count: radarResult.summary.blind_test_points,
    note: "点预测和区间半径均未读取后半段数值。",
  });
  for (const summary of orbitSummaries) {
    intervalCoverage.push({
      evidence: summary.reference_id,
      interval_source: "实验 9 历史 GP 每小时误差率 P95",
      expected_coverage: protocol.orbit.error_envelope_quantile,
      observed_coverage: summary.envelope_coverage,
      sample_count: summary.successful_propagations,
      note: `固定误差率上界 ${round(orbitEnvelopeRate)} km/h，按历元间隔线性缩放。`,
    });
  }
  for (const [label, comparison] of [["RIPE Atlas RTT", ripeComparison], ["M-Lab RTT", mlabRttComparison], ["M-Lab 吞吐", throughputComparison]]) {
    if (!comparison) continue;
    intervalCoverage.push({
      evidence: label,
      interval_source: "冻结模型经验 P2.5–P97.5",
      expected_coverage: 0.95,
      observed_coverage: comparison.external_coverage_by_model_empirical_95_interval,
      sample_count: comparison.external.count,
      note: "覆盖率反映外部样本是否落入模型分布范围，不等价于逐点预测置信区间。",
    });
  }
  await writeCsv(join(outDir, "confidence-interval-coverage.csv"), intervalCoverage);

  const bootstrapOptions = {
    iterations: protocol.statistics.bootstrap_iterations,
    seed: protocol.statistics.bootstrap_seed,
    confidence: protocol.statistics.confidence_level,
  };
  const bootstrapRows = [];
  for (const [source, metric, values] of [
    ["模型配对 RIPE", "rtt_ms", validRipe.map((row) => Number(row.model_rtt_ms))],
    ["RIPE Atlas", "rtt_ms", validRipe.map((row) => Number(row.external_rtt_ms))],
    ["模型配对 M-Lab", "rtt_ms", validMlab.map((row) => Number(row.model_rtt_ms))],
    ["M-Lab NDT7", "rtt_ms", validMlab.map((row) => Number(row.external_rtt_ms))],
    ["模型内部任务代理", "throughput_mbps", modelThroughput],
    ["M-Lab NDT7", "throughput_mbps", externalThroughput],
  ]) {
    if (!values.length) continue;
    for (const [statisticName, statistic] of [["mean", mean], ["p50", (sample) => quantile(sample, 0.5)]]) {
      bootstrapRows.push({ source, metric, statistic: statisticName, ...bootstrapInterval(values, statistic, bootstrapOptions) });
    }
  }
  await writeCsv(join(outDir, "bootstrap-confidence-intervals.csv"), bootstrapRows);

  await writeCsv(join(outDir, "external-source-registry.csv"), sourceRegistry);
  await writeJson(join(outDir, "external-source-registry.json"), sourceRegistry);
  await writeCsv(join(outDir, "external-source-status.csv"), sourceStatus);

  const finalProtocolHash = await hashFile(protocolPath);
  const frozenProtocolRecord = freeze.files.find((row) => row.path === rel(protocolPath));
  const acquisitionTimes = sourceRegistry.filter((row) => row.role?.includes("test") || row.role === "temporal-holdout-test")
    .map((row) => new Date(row.acquired_at).getTime()).filter(Number.isFinite);
  const causalityAudit = {
    freeze_time: freeze.frozen_at,
    earliest_external_test_acquisition: acquisitionTimes.length ? new Date(Math.min(...acquisitionTimes)).toISOString() : "",
    freeze_precedes_external_test_acquisition: acquisitionTimes.every((time) => time >= new Date(freeze.frozen_at).getTime()),
    protocol_sha256_at_freeze: frozenProtocolRecord?.sha256 ?? "",
    protocol_sha256_after_scoring: finalProtocolHash,
    protocol_unchanged_after_scoring: frozenProtocolRecord?.sha256 === finalProtocolHash,
    radar_train_test_timestamp_overlap: 0,
    radar_test_values_used_for_fit: radarResult.summary.test_values_used_for_fit,
    radar_test_values_used_for_interval_calibration: radarResult.summary.test_values_used_for_interval_calibration,
    test_set_parameter_updates: 0,
    radar_prior_repository_exposure: radarExposure,
    strict_pipeline_holdout_passed:
      acquisitionTimes.every((time) => time >= new Date(freeze.frozen_at).getTime()) &&
      frozenProtocolRecord?.sha256 === finalProtocolHash &&
      radarResult.summary.test_values_used_for_fit === 0,
  };
  await writeJson(join(outDir, "blind-test-causality-audit.json"), causalityAudit);

  const conclusions = buildConclusions({ radar: radarResult, radarExposure, orbitSummaries, ripeComparison, mlabRttComparison, throughputComparison });
  const result = {
    schema: "int-telemetry-experiment14-multisource-blind-validation/v1",
    generated_at: new Date().toISOString(),
    experiment_id: protocol.experiment_id,
    evidence_status: causalityAudit.strict_pipeline_holdout_passed ? "pipeline-frozen-holdout-complete" : "holdout-audit-failed",
    claim_boundary: protocol.reporting.claim_boundary,
    freeze: { frozen_at: freeze.frozen_at, hashes: freeze.hashes, git: freeze.git },
    causality_audit: causalityAudit,
    orbit: {
      historical_error_rate_p95_km_per_hour: round(orbitEnvelopeRate),
      historical_calibration_rows: historicalOrbitRates.length,
      references: orbitSummaries,
    },
    radar: { ...radarResult.summary, coefficients: radarResult.coefficients, prior_exposure_audit: radarExposure },
    network_performance: {
      ripe_atlas_rtt: ripeComparison,
      mlab_ndt7_rtt: mlabRttComparison,
      throughput_proxy_vs_mlab: throughputComparison,
      throughput_comparison_scope: "模型为星座内部已交付任务速率，M-Lab 为用户侧 NDT7 下载吞吐；只报告分布差异，不声明逐点同口径。",
    },
    confidence_interval_coverage: intervalCoverage,
    conclusions,
    source_status: sourceStatus,
  };
  await writeJson(join(outDir, "experiment14-results.json"), result);

  const overviewRows = [
    { 证据: "轨道 GP", 样本: orbitSummaries.find((row) => row.reference_id === "future-standard-gp")?.successful_propagations ?? 0, 主要结果: `ECI MAE ${orbitSummaries.find((row) => row.reference_id === "future-standard-gp")?.eci_position_mae_km ?? "-"} km` },
    { 证据: "轨道 SupGP", 样本: orbitSummaries.find((row) => row.reference_id === "future-spacex-supgp")?.successful_propagations ?? 0, 主要结果: `ECI MAE ${orbitSummaries.find((row) => row.reference_id === "future-spacex-supgp")?.eci_position_mae_km ?? "-"} km` },
    { 证据: "Radar 时间留出", 样本: radarResult.summary.blind_test_points, 主要结果: `Pearson ${radarResult.summary.blind_pearson_correlation} / MAE ${radarResult.summary.blind_normalized_mae}` },
    { 证据: "RIPE Atlas RTT", 样本: ripeComparison?.external.count ?? 0, 主要结果: `P50 比 ${ripeComparison?.p50_ratio_model_to_external ?? "-"} / KS ${ripeComparison?.ks_distance ?? "-"}` },
    { 证据: "M-Lab RTT", 样本: mlabRttComparison?.external.count ?? 0, 主要结果: `P50 比 ${mlabRttComparison?.p50_ratio_model_to_external ?? "-"} / KS ${mlabRttComparison?.ks_distance ?? "-"}` },
    { 证据: "M-Lab 吞吐", 样本: throughputComparison?.external.count ?? 0, 主要结果: `代理 P50 比 ${throughputComparison?.p50_ratio_model_to_external ?? "-"} / KS ${throughputComparison?.ks_distance ?? "-"}` },
  ];
  const radarTestChart = radarResult.rows.filter((row) => row.split === "blind-test");
  const rttGeo = geographicRows.filter((row) => row.metric === "rtt_ms").slice(0, 20);
  const throughputGeo = geographicRows.filter((row) => row.metric === "throughput_mbps");
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>实验 14：多源外部盲测验证</title><style>
  :root{--ink:#16232c;--muted:#60717b;--line:#d7e0e3;--paper:#fff;--bg:#eef3f4;--accent:#176b87;--warn:#a64b18;--ok:#17633b}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:Arial,"Microsoft YaHei",sans-serif;line-height:1.65}header{background:#102f3a;color:#fff;padding:30px max(24px,calc((100vw - 1180px)/2));border-bottom:5px solid #d58b32}header h1{margin:0;font-size:30px;letter-spacing:0}header p{margin:8px 0 0;color:#dce9ed}main{max-width:1180px;margin:auto;padding:24px}nav{position:sticky;top:0;z-index:4;background:#fff;border:1px solid var(--line);padding:10px 14px;margin-bottom:16px;display:flex;gap:18px;flex-wrap:wrap}nav a{color:var(--accent);text-decoration:none;font-weight:700}section{background:var(--paper);border:1px solid var(--line);margin:16px 0;padding:20px;border-radius:6px}h2{font-size:21px;margin:0 0 12px;border-left:4px solid #d58b32;padding-left:10px}h3{font-size:16px;margin-top:20px}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px}.card{border:1px solid var(--line);padding:14px;background:#f9fbfb}.card span{display:block;color:var(--muted);font-size:12px}.card strong{font-size:20px}table{border-collapse:collapse;width:100%;font-size:13px;display:block;overflow:auto}th,td{border:1px solid var(--line);padding:7px 9px;text-align:left;white-space:nowrap}th{background:#edf4f5}.ok{color:var(--ok)}.warn{color:var(--warn)}.callout{border-left:4px solid var(--accent);padding:10px 14px;background:#f1f8fa}.warning{border-left-color:var(--warn);background:#fff7ed}svg{width:100%;height:auto;border:1px solid var(--line);background:#fff;margin:8px 0}.chart-title{font-weight:700;font-size:14px}.axis{stroke:#52646d;stroke-width:1}.grid{stroke:#dfe7e9;stroke-width:1}.tick{font-size:10px;fill:#61727a}.label{font-size:10px;fill:#34464f}.empty{color:var(--muted)}code{font-size:12px;word-break:break-all}.two{display:grid;grid-template-columns:1fr 1fr;gap:16px}@media(max-width:800px){.two{grid-template-columns:1fr}header{padding:22px}main{padding:12px}}
  </style></head><body><header><h1>实验 14：多源外部盲测验证</h1><p>冻结参数后，用未来轨道、Radar 留出窗口、RIPE Atlas 与 M-Lab NDT7 检验公开可观测维度。</p></header><main><nav><a href="#protocol">协议</a><a href="#orbit">轨道</a><a href="#traffic">业务</a><a href="#network">网络性能</a><a href="#geo">地域</a><a href="#coverage">置信覆盖</a><a href="#conclusion">结论</a></nav>
  <section><h2>结论概览</h2><p class="callout">本实验验证的是公开可观测维度的外部一致性，不声称复刻 Starlink 运营商内部 CPU、电量、队列或真实路由策略。测试结果无论好坏均保留，测试集没有回调参数。</p>${metricTable(overviewRows)}</section>
  <section id="protocol"><h2>冻结与盲测协议</h2><div class="cards"><div class="card"><span>冻结时间</span><strong>${escapeHtml(freeze.frozen_at)}</strong></div><div class="card"><span>模型/输入总哈希</span><strong>${escapeHtml(freeze.hashes.aggregate_sha256.slice(0,12))}</strong></div><div class="card"><span>参数哈希</span><strong>${escapeHtml(freeze.hashes.parameter_sha256.slice(0,12))}</strong></div><div class="card"><span>测试集回调</span><strong>${causalityAudit.test_set_parameter_updates}</strong></div></div><p>Git 提交 <code>${escapeHtml(freeze.git.commit)}</code>，工作树${freeze.git.dirty ? "包含未提交修改，已逐文件哈希冻结" : "干净"}。协议评分后哈希${causalityAudit.protocol_unchanged_after_scoring ? "未变化" : "发生变化"}；冻结先于外部测试获取：${causalityAudit.freeze_precedes_external_test_acquisition ? "是" : "否"}。</p><p class="callout warning"><strong>Radar 历史暴露审计：</strong>${escapeHtml(radarExposure.interpretation)}</p>${metricTable(sourceStatus)}</section>
  <section id="orbit"><h2>轨道盲测</h2><p>冻结的标准 GP 通过 SGP4 传播到新参考历元，再与同一 NORAD ID 的未来标准 GP 和 SpaceX 来源 SupGP 比较。误差包络由实验 9 历史 GP 的 <code>|ECI error| / epoch hours</code> P95 固定得到：${round(orbitEnvelopeRate)} km/h。</p>${metricTable(orbitSummaries.map((row)=>({参考:row.reference_id,匹配:row.successful_propagations,历元间隔小时:row.epoch_separation_mean_hours,ECI_MAE_km:row.eci_position_mae_km,ECI_P95_km:row.eci_position_p95_km,径向_MAE:row.radial_mae_km,沿轨_MAE:row.along_track_mae_km,横轨_MAE:row.cross_track_mae_km,包络覆盖率:row.envelope_coverage})))}</section>
  <section id="traffic"><h2>Radar 业务时间留出</h2><p>前半段 ${radarTrain.length} 点内部再分为 ${radarResult.summary.fit_points} 点拟合与 ${radarResult.summary.interval_calibration_points} 点区间校准；后半段 ${radarTest.length} 点完全不参与求解。固定特征为线性趋势、24 小时与 12 小时谐波。</p><div class="cards"><div class="card"><span>留出 Pearson</span><strong>${radarResult.summary.blind_pearson_correlation}</strong></div><div class="card"><span>留出 Spearman</span><strong>${radarResult.summary.blind_spearman_correlation}</strong></div><div class="card"><span>归一化 MAE</span><strong>${radarResult.summary.blind_normalized_mae}</strong></div><div class="card"><span>95% 区间覆盖</span><strong>${round(radarResult.summary.blind_interval_coverage*100,1)}%</strong></div></div>${lineChartSvg(radarTestChart,[{key:"external_radar_train_normalized",label:"Radar 留出真值",color:"#2f855a"},{key:"model_predicted_train_normalized",label:"训练半段预测",color:"#176b87"},{key:"prediction_lower_train_normalized",label:"预测下界",color:"#c76b0a"},{key:"prediction_upper_train_normalized",label:"预测上界",color:"#8b5cf6"}],"Radar 后半段盲测业务时序")}</section>
  <section id="network"><h2>RTT 与吞吐 CDF</h2><div class="two"><div><h3>RTT 分布</h3><p>模型 RTT 对每个 RIPE/M-Lab 位置独立计算可见卫星、区域网关和必要 ISL 路径；外部 RTT 数值不参与路径选择。</p>${cdfChartSvg(rttCdf,[{key:"model_matched_ripe_rtt_ms",label:"模型配对 RIPE",color:"#176b87"},{key:"external_ripe_rtt_ms",label:"RIPE Atlas",color:"#2f855a"},{key:"external_mlab_rtt_ms",label:"M-Lab NDT7",color:"#c76b0a"}],"RTT CDF","ms")}</div><div><h3>吞吐分布</h3><p class="callout warning">模型是内部已交付任务速率代理，M-Lab 是用户侧 NDT7 下载吞吐。两者不是同测量点；图表只暴露量级与分布偏差。</p>${cdfChartSvg(throughputCdf,[{key:"model_internal_task_rate_mbps",label:"模型内部任务代理",color:"#176b87"},{key:"external_mlab_ndt7_download_mbps",label:"M-Lab NDT7",color:"#c76b0a"}],"吞吐 CDF","Mbps")}</div></div>${metricTable([{对照:"模型 vs RIPE RTT",P50比例:ripeComparison?.p50_ratio_model_to_external??"-",P95比例:ripeComparison?.p95_ratio_model_to_external??"-",KS:ripeComparison?.ks_distance??"-",Wasserstein:ripeComparison?.wasserstein_distance??"-"},{对照:"模型 vs M-Lab RTT",P50比例:mlabRttComparison?.p50_ratio_model_to_external??"-",P95比例:mlabRttComparison?.p95_ratio_model_to_external??"-",KS:mlabRttComparison?.ks_distance??"-",Wasserstein:mlabRttComparison?.wasserstein_distance??"-"},{对照:"任务速率代理 vs M-Lab 吞吐",P50比例:throughputComparison?.p50_ratio_model_to_external??"-",P95比例:throughputComparison?.p95_ratio_model_to_external??"-",KS:throughputComparison?.ks_distance??"-",Wasserstein:throughputComparison?.wasserstein_distance??"-"}])}</section>
  <section id="geo"><h2>地域箱线图</h2><p>箱体为 P25–P75，中线为 P50，须线为 P05–P95。仅展示样本数达到协议门槛的国家/地区。</p>${boxPlotSvg(rttGeo,"按国家/地区的 RTT 分布（ms）")}${boxPlotSvg(throughputGeo,"M-Lab NDT7 按国家/地区的下载吞吐（Mbps）")}</section>
  <section id="coverage"><h2>置信区间覆盖率</h2><p>红色虚线为名义 95%。Radar 使用逐点 split-conformal 区间；轨道使用历史跨历元误差率包络；RTT/吞吐使用冻结模型经验范围，三者含义不同，不能混成单一“真实性分数”。</p>${barChartSvg(intervalCoverage,"observed_coverage","evidence","外部盲测置信/经验区间覆盖率",.95)}${metricTable(intervalCoverage)}</section>
  <section id="conclusion"><h2>成功、偏差与可声明边界</h2><h3 class="ok">得到支持的证据</h3><ul>${conclusions.successes.map((item)=>`<li>${escapeHtml(item)}</li>`).join("")}</ul><h3 class="warn">如实保留的偏差</h3><ul>${conclusions.biases.map((item)=>`<li>${escapeHtml(item)}</li>`).join("")}</ul><p class="callout"><strong>最终边界：</strong>${escapeHtml(protocol.reporting.claim_boundary)}。本实验提升外部真实性证据，但不会把“外部量级一致”改写成“运营商内部逐点真值”。</p></section>
  <section><h2>复现与产物</h2><p><code>npm run experiment14:external-blind</code></p><p>关键文件：<code>freeze-manifest.json</code>、<code>blind-test-causality-audit.json</code>、<code>orbit-errors.csv</code>、<code>radar-holdout-timeseries.csv</code>、<code>rtt-cdf.csv</code>、<code>throughput-cdf.csv</code>、<code>geographic-boxplots.csv</code>、<code>confidence-interval-coverage.csv</code>。</p></section>
  </main></body></html>`;
  await writeFile(join(outDir, "experiment14-multisource-blind-validation.html"), html, "utf8");

  const markdown = `# 实验 14：多源外部盲测验证

## 实验目的

冻结当前模型代码、配置、输入和参数后，以未来 GP/SupGP、Cloudflare Radar 时间留出、RIPE Atlas 与 M-Lab NDT7 检验公开可观测维度。测试集不用于调参，成功和偏差同时报告。

## 冻结审计

- 冻结时间：${freeze.frozen_at}
- 总哈希：\`${freeze.hashes.aggregate_sha256}\`
- 参数哈希：\`${freeze.hashes.parameter_sha256}\`
- 协议评分后未变化：${causalityAudit.protocol_unchanged_after_scoring}
- 测试集参数更新：${causalityAudit.test_set_parameter_updates}
- 流水线留出审计：${causalityAudit.strict_pipeline_holdout_passed ? "通过" : "失败"}

> Radar 注意：${radarExposure.interpretation}

## 轨道结果

${orbitSummaries.map((row)=>`- ${row.reference_id}：匹配 ${row.successful_propagations}，ECI MAE ${row.eci_position_mae_km} km，P95 ${row.eci_position_p95_km} km，历史包络覆盖率 ${row.envelope_coverage}。`).join("\n")}

## 业务留出

- 前半段校准：${radarTrain.length} 点
- 后半段盲测：${radarTest.length} 点
- Pearson：${radarResult.summary.blind_pearson_correlation}
- Spearman：${radarResult.summary.blind_spearman_correlation}
- 归一化 MAE：${radarResult.summary.blind_normalized_mae}
- 区间覆盖率：${radarResult.summary.blind_interval_coverage}

## 网络性能

- RIPE RTT P50 比：${ripeComparison?.p50_ratio_model_to_external ?? "未获得"}，KS：${ripeComparison?.ks_distance ?? "未获得"}
- M-Lab RTT P50 比：${mlabRttComparison?.p50_ratio_model_to_external ?? "未获得"}，KS：${mlabRttComparison?.ks_distance ?? "未获得"}
- 任务速率代理 / M-Lab 吞吐 P50 比：${throughputComparison?.p50_ratio_model_to_external ?? "未获得"}，KS：${throughputComparison?.ks_distance ?? "未获得"}

吞吐对照不是同口径逐点验证：模型列为星座内部已交付任务速率，M-Lab 列为用户侧 NDT7 下载吞吐。

## 得到支持的证据

${conclusions.successes.map((item)=>`- ${item}`).join("\n")}

## 如实保留的偏差

${conclusions.biases.map((item)=>`- ${item}`).join("\n")}

## 结论边界

${protocol.reporting.claim_boundary}。CPU、电量和队列仍是物理公式驱动的仿真潜变量，不是运营商公开真值。
`;
  await writeFile(join(outDir, "EXPERIMENT_14_REPORT.md"), markdown, "utf8");

  const manifest = {
    schema: "int-telemetry-experiment14-manifest/v1",
    generated_at: result.generated_at,
    experiment_id: protocol.experiment_id,
    protocol: rel(protocolPath),
    freeze_hash: freeze.hashes.aggregate_sha256,
    evidence_status: result.evidence_status,
    outputs: {
      report_html: "experiment14-multisource-blind-validation.html",
      report_markdown: "EXPERIMENT_14_REPORT.md",
      results_json: "experiment14-results.json",
      freeze_manifest: "freeze-manifest.json",
      causality_audit: "blind-test-causality-audit.json",
      source_registry: "external-source-registry.csv",
      orbit_errors: "orbit-errors.csv",
      radar_timeseries: "radar-holdout-timeseries.csv",
      rtt_cdf: "rtt-cdf.csv",
      throughput_cdf: "throughput-cdf.csv",
      geographic_boxplots: "geographic-boxplots.csv",
      interval_coverage: "confidence-interval-coverage.csv",
      bootstrap_intervals: "bootstrap-confidence-intervals.csv"
    },
  };
  await writeJson(join(outDir, "experiment14-manifest.json"), manifest);
  console.log(JSON.stringify({
    out: rel(outDir),
    evidence_status: result.evidence_status,
    freeze_hash: freeze.hashes.aggregate_sha256,
    orbit_references: orbitSummaries.length,
    radar_test_points: radarTest.length,
    ripe_samples: ripeComparison?.external.count ?? 0,
    mlab_throughput_samples: throughputComparison?.external.count ?? 0,
  }, null, 2));
}

await main();
