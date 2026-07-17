import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readCsvStream } from "../../stage2-int/tools/csv-stream.mjs";
import { escapeHtml } from "./reportUtils.mjs";
import { comparePacketResults, numberValue, round } from "./systemPacketValidation.mjs";

function formatPercent(value) {
  return value === null || value === undefined || value === "" ? "-" : `${round(value, 2).toFixed(2)}%`;
}

function formatNumber(value, digits = 3) {
  return value === null || value === undefined || value === "" ? "-" : numberValue(value).toFixed(digits);
}

async function loadFixture(fixtureDir) {
  const [config, manifest] = await Promise.all([
    readFile(join(fixtureDir, "config.json"), "utf8").then(JSON.parse),
    readFile(join(fixtureDir, "manifest.json"), "utf8").then(JSON.parse),
  ]);
  return { config, manifest };
}

async function loadNs3Results(outputDir) {
  const ns3Dir = join(outputDir, "ns3");
  if (!existsSync(ns3Dir)) return [];
  const names = await readdir(ns3Dir);
  const rows = [];
  for (const name of names.filter((value) => /^ns3-result-.*\.csv$/i.test(value)).sort()) {
    rows.push(...await readCsvStream(join(ns3Dir, name)));
  }
  return rows;
}

function enrichNs3Rows(rows) {
  const order = new Map([["no-int", 0], ["full-int", 1], ["leo-selective", 2]]);
  return comparePacketResults(rows.map((row) => ({
    ...row,
    report_delivery_ratio: row.variant === "no-int" ? null : numberValue(row.report_delivery_ratio),
    queue_delay_p95_ms: numberValue(row.queue_delay_p95_ms),
    business_queue_delay_p95_ms: numberValue(row.business_queue_delay_p95_ms),
    telemetry_queue_delay_p95_ms: row.variant === "no-int"
      ? null
      : numberValue(row.telemetry_queue_delay_p95_ms),
    oam_time_average_aoi_ms: row.variant === "no-int"
      ? null
      : numberValue(row.oam_time_average_aoi_ms),
    oam_peak_aoi_p95_ms: row.variant === "no-int"
      ? null
      : numberValue(row.oam_peak_aoi_p95_ms),
    useful_reports_per_telemetry_mb: row.variant === "no-int"
      ? null
      : round(numberValue(row.report_delivered_packets) /
        Math.max(1e-9, numberValue(row.telemetry_network_bytes) / 1e6)),
    useful_reports_per_planned_telemetry_mb: row.variant === "no-int"
      ? null
      : round(numberValue(row.report_delivered_packets) /
        Math.max(1e-9, numberValue(row.planned_telemetry_network_bytes) / 1e6)),
    queue_drop_packets: numberValue(row.device_queue_drop_packets),
    mtu_drop_packets: numberValue(row.mtu_drop_packets),
  }))).sort((left, right) =>
    numberValue(left.load_scale) - numberValue(right.load_scale) ||
    (order.get(left.variant) ?? 99) - (order.get(right.variant) ?? 99));
}

function relativeErrorPercent(actual, expected) {
  const baseline = Math.abs(numberValue(expected));
  return baseline <= 1e-12 ? null : round((numberValue(actual) - numberValue(expected)) / baseline * 100);
}

function buildCrossEngineRows(referenceRows, ns3Rows) {
  return ns3Rows.map((ns3) => {
    const reference = referenceRows.find((row) =>
      numberValue(row.load_scale) === numberValue(ns3.load_scale) && row.variant === ns3.variant);
    if (!reference) return null;
    return {
      load_scale: numberValue(ns3.load_scale),
      variant: ns3.variant,
      planned_byte_error_percent: relativeErrorPercent(
        ns3.planned_telemetry_network_bytes,
        reference.planned_telemetry_network_bytes,
      ),
      business_delivery_error_pp: round(
        (numberValue(ns3.business_delivery_ratio) - numberValue(reference.business_delivery_ratio)) * 100,
      ),
      business_delay_p95_error_percent: relativeErrorPercent(
        ns3.business_delay_p95_ms,
        reference.business_delay_p95_ms,
      ),
      queue_delay_p95_error_percent: relativeErrorPercent(
        ns3.queue_delay_p95_ms,
        reference.queue_delay_p95_ms,
      ),
      queue_delay_p95_absolute_error_ms: round(
        numberValue(ns3.queue_delay_p95_ms) - numberValue(reference.queue_delay_p95_ms),
      ),
      reference_queue_drop_packets: numberValue(reference.queue_drop_packets),
      ns3_queue_drop_packets: numberValue(ns3.queue_drop_packets),
      queue_drop_difference_packets: numberValue(ns3.queue_drop_packets) -
        numberValue(reference.queue_drop_packets),
      report_delivery_error_pp: ns3.variant === "no-int" ? null : round(
        (numberValue(ns3.report_delivery_ratio) - numberValue(reference.report_delivery_ratio)) * 100,
      ),
      oam_average_aoi_error_percent: ns3.variant === "no-int" ? null : relativeErrorPercent(
        ns3.oam_time_average_aoi_ms,
        reference.oam_time_average_aoi_ms,
      ),
    };
  }).filter(Boolean);
}

function average(values) {
  const finite = values.filter((value) => value !== null && value !== undefined && Number.isFinite(Number(value)));
  return finite.length ? finite.reduce((sum, value) => sum + Number(value), 0) / finite.length : null;
}

function absoluteAverage(values) {
  return average(values.map((value) => value === null || value === undefined ? null : Math.abs(Number(value))));
}

function summarizeCrossEngine(rows) {
  return {
    mean_absolute_planned_byte_error_percent: round(
      absoluteAverage(rows.map((row) => row.planned_byte_error_percent)) ?? 0,
      3,
    ),
    mean_absolute_business_delivery_error_pp: round(
      absoluteAverage(rows.map((row) => row.business_delivery_error_pp)) ?? 0,
      3,
    ),
    mean_absolute_business_delay_p95_error_percent: round(
      absoluteAverage(rows.map((row) => row.business_delay_p95_error_percent)) ?? 0,
      3,
    ),
    mean_absolute_queue_delay_p95_error_ms: round(
      absoluteAverage(rows.map((row) => row.queue_delay_p95_absolute_error_ms)) ?? 0,
      6,
    ),
    mean_absolute_report_delivery_error_pp: round(
      absoluteAverage(rows.map((row) => row.report_delivery_error_pp)) ?? 0,
      3,
    ),
    mean_absolute_oam_aoi_error_percent: round(
      absoluteAverage(rows.map((row) => row.oam_average_aoi_error_percent)) ?? 0,
      3,
    ),
    aggregate_reference_queue_drop_packets: rows.reduce((sum, row) =>
      sum + numberValue(row.reference_queue_drop_packets), 0),
    ns3_queue_drop_packets: rows.reduce((sum, row) =>
      sum + numberValue(row.ns3_queue_drop_packets), 0),
  };
}

function pairedFindings(rows, loadScales) {
  const pairs = loadScales.map((loadScale) => ({
    full: rows.find((row) => numberValue(row.load_scale) === numberValue(loadScale) &&
      row.variant === "full-int"),
    selective: rows.find((row) => numberValue(row.load_scale) === numberValue(loadScale) &&
      row.variant === "leo-selective"),
  })).filter((pair) => pair.full && pair.selective);
  return {
    pairs,
    planned_byte_reduction_percent: round(average(pairs.map((pair) =>
      pair.selective.telemetry_byte_reduction_vs_full_percent)) ?? 0, 2),
    report_delivery_gain_percentage_points: round(average(pairs.map((pair) =>
      (numberValue(pair.selective.report_delivery_ratio) - numberValue(pair.full.report_delivery_ratio)) * 100)) ?? 0, 2),
    reports_per_planned_mb_ratio: round(average(pairs.map((pair) =>
      numberValue(pair.selective.useful_reports_per_planned_telemetry_mb) /
      Math.max(1e-9, numberValue(pair.full.useful_reports_per_planned_telemetry_mb)))) ?? 0, 2),
    full_int_average_mtu_drops: round(average(pairs.map((pair) => pair.full.mtu_drop_packets)) ?? 0, 2),
    selective_average_mtu_drops: round(average(pairs.map((pair) => pair.selective.mtu_drop_packets)) ?? 0, 2),
    full_int_report_rtt_p95_ms: round(average(pairs.map((pair) => pair.full.report_rtt_p95_ms)) ?? 0, 3),
    selective_report_rtt_p95_ms: round(average(pairs.map((pair) => pair.selective.report_rtt_p95_ms)) ?? 0, 3),
    business_delay_delta_percent: round(average(pairs.map((pair) =>
      (numberValue(pair.selective.business_delay_p95_ms) - numberValue(pair.full.business_delay_p95_ms)) /
      Math.max(1e-9, numberValue(pair.full.business_delay_p95_ms)) * 100)) ?? 0, 2),
    average_aoi_delta_percent: round(average(pairs.map((pair) =>
      (numberValue(pair.selective.oam_time_average_aoi_ms) - numberValue(pair.full.oam_time_average_aoi_ms)) /
      Math.max(1e-9, numberValue(pair.full.oam_time_average_aoi_ms)) * 100)) ?? 0, 2),
  };
}

function buildTrendAgreement(referenceRows, ns3Rows, loadScales) {
  const checks = [];
  for (const loadScale of loadScales) {
    const findPair = (rows) => ({
      full: rows.find((row) => numberValue(row.load_scale) === numberValue(loadScale) &&
        row.variant === "full-int"),
      selective: rows.find((row) => numberValue(row.load_scale) === numberValue(loadScale) &&
        row.variant === "leo-selective"),
    });
    const reference = findPair(referenceRows);
    const ns3 = findPair(ns3Rows);
    if (!reference.full || !reference.selective || !ns3.full || !ns3.selective) continue;
    const definitions = [
      ["计划遥测字节下降", (pair) => numberValue(pair.selective.planned_telemetry_network_bytes) <
        numberValue(pair.full.planned_telemetry_network_bytes)],
      ["报告交付率不降低", (pair) => numberValue(pair.selective.report_delivery_ratio) >=
        numberValue(pair.full.report_delivery_ratio)],
      ["OAM 平均 AoI 不升高", (pair) => numberValue(pair.selective.oam_time_average_aoi_ms) <=
        numberValue(pair.full.oam_time_average_aoi_ms)],
      ["业务 P95 时延不升高", (pair) => numberValue(pair.selective.business_delay_p95_ms) <=
        numberValue(pair.full.business_delay_p95_ms)],
    ];
    for (const [metric, evaluate] of definitions) {
      const referenceDirection = evaluate(reference);
      const ns3Direction = evaluate(ns3);
      checks.push({
        load_scale: numberValue(loadScale),
        metric,
        reference_direction: referenceDirection,
        ns3_direction: ns3Direction,
        agrees: referenceDirection === ns3Direction,
      });
    }
  }
  return {
    checks,
    agreement_ratio: checks.length ? round(checks.filter((item) => item.agrees).length / checks.length) : null,
  };
}

function evidenceLabel(status) {
  if (status === "ns3-system-cross-validation-complete") return "ns-3 包级系统交叉验证已完整运行";
  if (status === "ns3-system-cross-validation-partial") return "检测到部分 ns-3 结果，尚未完成全部预注册组合";
  return "ns-3 适配器已就绪，当前只有独立参考回放";
}

function markdownRows(rows) {
  if (!rows.length) return "| - | 尚未运行 | - | - | - | - | - | - | - | - | - | - | - | - |";
  return rows.map((row) =>
    `| ${row.load_scale} | ${row.variant} | ${formatPercent(numberValue(row.business_delivery_ratio) * 100)} | ${formatNumber(row.business_delay_p95_ms)} | ${formatNumber(row.queue_delay_p95_ms)} | ${formatNumber(row.telemetry_queue_delay_p95_ms)} | ${numberValue(row.queue_drop_packets)} | ${numberValue(row.planned_telemetry_network_bytes)} | ${numberValue(row.telemetry_network_bytes)} | ${row.report_delivery_ratio === null ? "-" : formatPercent(numberValue(row.report_delivery_ratio) * 100)} | ${formatNumber(row.oam_time_average_aoi_ms)} | ${formatPercent(row.telemetry_byte_reduction_vs_full_percent)} | ${formatNumber(row.useful_reports_per_planned_telemetry_mb, 2)} | ${numberValue(row.mtu_drop_packets)} |`,
  ).join("\n");
}

function htmlRows(rows) {
  return rows.map((row) => `<tr><td>${row.load_scale}</td><td>${escapeHtml(row.variant)}</td><td>${formatPercent(numberValue(row.business_delivery_ratio) * 100)}</td><td>${formatNumber(row.business_delay_p95_ms)}</td><td>${formatNumber(row.queue_delay_p95_ms)}</td><td>${formatNumber(row.telemetry_queue_delay_p95_ms)}</td><td>${numberValue(row.queue_drop_packets)}</td><td>${numberValue(row.planned_telemetry_network_bytes).toLocaleString()}</td><td>${numberValue(row.telemetry_network_bytes).toLocaleString()}</td><td>${row.report_delivery_ratio === null ? "-" : formatPercent(numberValue(row.report_delivery_ratio) * 100)}</td><td>${formatNumber(row.oam_time_average_aoi_ms)}</td><td>${formatPercent(row.telemetry_byte_reduction_vs_full_percent)}</td><td>${formatNumber(row.useful_reports_per_planned_telemetry_mb, 2)}</td><td>${numberValue(row.mtu_drop_packets)}</td></tr>`).join("");
}

function crossEngineMarkdownRows(rows) {
  if (!rows.length) return "| - | - | 尚无配对结果 | - | - | - | - | - | - | - |";
  return rows.map((row) =>
    `| ${row.scope} | ${row.load_scale} | ${row.variant} | ${formatPercent(row.planned_byte_error_percent)} | ${formatNumber(row.business_delivery_error_pp)} | ${formatPercent(row.business_delay_p95_error_percent)} | ${formatNumber(row.queue_delay_p95_absolute_error_ms, 6)} | ${row.ns3_queue_drop_packets}/${row.reference_queue_drop_packets} | ${row.report_delivery_error_pp === null ? "-" : formatNumber(row.report_delivery_error_pp)} | ${formatPercent(row.oam_average_aoi_error_percent)} |`,
  ).join("\n");
}

function crossEngineHtmlRows(rows) {
  return rows.map((row) => `<tr><td>${escapeHtml(row.scope)}</td><td>${row.load_scale}</td><td>${escapeHtml(row.variant)}</td><td>${formatPercent(row.planned_byte_error_percent)}</td><td>${formatNumber(row.business_delivery_error_pp)}</td><td>${formatPercent(row.business_delay_p95_error_percent)}</td><td>${formatNumber(row.queue_delay_p95_absolute_error_ms, 6)}</td><td>${row.ns3_queue_drop_packets}/${row.reference_queue_drop_packets}</td><td>${row.report_delivery_error_pp === null ? "-" : formatNumber(row.report_delivery_error_pp)}</td><td>${formatPercent(row.oam_average_aoi_error_percent)}</td></tr>`).join("");
}

export async function writeSystemValidationReport({ fixtureDir, outputDir }) {
  const fixture = await loadFixture(fixtureDir);
  const referenceArtifact = existsSync(join(outputDir, "reference-packet-results.json"))
    ? JSON.parse(await readFile(join(outputDir, "reference-packet-results.json"), "utf8"))
    : { results: [] };
  const referenceRows = referenceArtifact.results ?? [];
  const ns3Rows = enrichNs3Rows(await loadNs3Results(outputDir));
  const coreLoadScales = fixture.config.load_scales;
  const stressLoadScales = fixture.config.stress_load_scales ?? [];
  const expectedKeys = coreLoadScales.flatMap((loadScale) =>
    fixture.config.variants.map((variant) => `${numberValue(loadScale)}|${variant}`));
  const stressExpectedKeys = stressLoadScales.flatMap((loadScale) =>
    fixture.config.variants.map((variant) => `${numberValue(loadScale)}|${variant}`));
  const allActualKeys = new Set(ns3Rows.map((row) => `${numberValue(row.load_scale)}|${row.variant}`));
  const completedCoreKeys = expectedKeys.filter((key) => allActualKeys.has(key));
  const completedStressKeys = stressExpectedKeys.filter((key) => allActualKeys.has(key));
  const ns3Complete = completedCoreKeys.length === expectedKeys.length;
  const stressComplete = completedStressKeys.length === stressExpectedKeys.length;
  const evidenceStatus = ns3Complete
    ? "ns3-system-cross-validation-complete"
    : ns3Rows.length
      ? "ns3-system-cross-validation-partial"
      : "adapter-ready-reference-only-not-system-evidence";
  const maxTelemetry = Math.max(1, ...referenceRows.map((row) =>
    numberValue(row.planned_telemetry_network_bytes)));
  const referenceFinding = pairedFindings(referenceRows, coreLoadScales);
  const ns3Finding = pairedFindings(ns3Rows, coreLoadScales);
  const stressNs3Finding = pairedFindings(ns3Rows, stressLoadScales);
  const crossEngineRows = buildCrossEngineRows(referenceRows, ns3Rows).map((row) => ({
    ...row,
    scope: stressLoadScales.some((value) => numberValue(value) === numberValue(row.load_scale))
      ? "压力扩展"
      : "核心",
  }));
  const coreCrossEngineRows = crossEngineRows.filter((row) => row.scope === "核心");
  const stressCrossEngineRows = crossEngineRows.filter((row) => row.scope === "压力扩展");
  const trendAgreement = buildTrendAgreement(referenceRows, ns3Rows, coreLoadScales);
  const crossEngineFinding = {
    ...summarizeCrossEngine(coreCrossEngineRows),
    directional_trend_agreement_ratio: trendAgreement.agreement_ratio,
  };
  const stressCrossEngineFinding = summarizeCrossEngine(stressCrossEngineRows);
  const ns3Section = ns3Rows.length
    ? `核心组合已完成 ${completedCoreKeys.length}/${expectedKeys.length} 组，定向压力扩展已完成 ${completedStressKeys.length}/${stressExpectedKeys.length} 组。只有核心组合齐备时，证据状态才会升级为完成。\n\n| 负载 | 方案 | 业务交付率 | 业务 P95/ms | 总队列 P95/ms | 遥测队列 P95/ms | 队列丢包 | 计划遥测字节 | 提交链路字节 | 报告交付率 | OAM 平均 AoI/ms | 相对 full 计划字节下降 | 成功报告/计划 MB | MTU 丢弃 |\n|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n${markdownRows(ns3Rows)}`
    : "当前机器没有可用的 WSL2/MSYS2 ns-3 环境，因此尚未生成 ns-3 结果。可在 Linux/WSL2 中设置 `NS3_ROOT` 后执行 `npm run experiment13:ns3`，或直接运行仓库提供的 GitHub Actions 工作流。";

  const report = `# 实验 13：经济型包级系统交叉验证

## 当前状态

**${evidenceLabel(evidenceStatus)}**。证据状态代码：\`${evidenceStatus}\`。

本实验冻结 ${fixture.manifest.fixture.node_count} 星的 ${fixture.manifest.fixture.slice_count} 个时间片，只把第一阶段链路快照、业务路径和第二阶段 probe plan 转换为独立包级输入，不修改或重跑第一阶段核心模型。

## 预注册设计

- 方案：\`no-int\`、\`full-int\`、\`leo-selective\`。后两者使用相同 probe 路径和发送频率，只改变逐跳 metadata。
- 核心负载：${coreLoadScales.join("、")} 倍统一基准，共 9 组；定向压力扩展：${stressLoadScales.join("、")} 倍，共 3 组，不并入核心平均收益。
- 业务校准：路径导出的活动链路负载 P90 固定为 ${formatPercent(fixture.config.business_rate_calibration.target_p90_utilization * 100)}。
- MTU：${fixture.config.mtu_bytes} B；队列：${fixture.config.queue_packets} 包；完整 metadata：每跳 ${fixture.config.full_metadata_bytes_per_hop} B。
- 主指标：计划/实际遥测字节、业务吞吐与 P95 时延、真实设备队列 P95、队列丢包、MTU 丢弃、report 交付率、report RTT 和 Ground OAM AoI。
- MTU 策略：先计算真实线上包长，超过 ${fixture.config.mtu_bytes} B 时按“不允许 INT 分片”策略在发送前丢弃，并单独记录超限次数。
- AoI 口径：每条 probe 流在首个采样时刻具有初始状态，随后随时间线性增长；Ground OAM 收到更新时重置为该报告的实际交付年龄。

## 冻结输入

| 节点 | 时间片 | 链路记录 | 唯一链路 | 业务流 | Probe 流 | 拒绝记录 |
|---:|---:|---:|---:|---:|---:|---:|
| ${fixture.manifest.fixture.node_count} | ${fixture.manifest.fixture.slice_count} | ${fixture.manifest.fixture.link_rows} | ${fixture.manifest.fixture.unique_links} | ${fixture.manifest.fixture.business_flows} | ${fixture.manifest.fixture.probe_flows} | ${fixture.manifest.fixture.rejected_records} |

## 聚合侧参考回放

该回放使用第一阶段导出的时间片链路容量、传播时延、误包率和业务路径，以及第二阶段导出的 probe plan。它用于给出当前聚合模型侧的确定性参考趋势，**不是 ns-3 系统证据，也不是运营商真值**。

| 负载 | 方案 | 业务交付率 | 业务 P95/ms | 总队列 P95/ms | 遥测队列 P95/ms | 队列丢包 | 计划遥测字节 | 提交链路字节 | 报告交付率 | OAM 平均 AoI/ms | 相对 full 计划字节下降 | 成功报告/计划 MB | MTU 丢弃 |
|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
${markdownRows(referenceRows)}

计划遥测字节假设 probe/report 完整走完路径；提交链路字节只统计通过 MTU 门禁并提交发送的字节。若全量 INT 因 MTU 提前丢弃，后者会虚假偏小，因此开销主比较采用计划字节并同时报告交付率。

## 参考趋势摘要

- 选择性方案的计划遥测字节平均下降 ${formatPercent(referenceFinding.planned_byte_reduction_percent)}。
- 报告交付率平均提高 ${referenceFinding.report_delivery_gain_percentage_points.toFixed(2)} 个百分点。
- 每计划 MB 的成功报告数约为全量 INT 的 ${referenceFinding.reports_per_planned_mb_ratio.toFixed(2)} 倍。
- 全量 INT 每个负载场景平均发生 ${referenceFinding.full_int_average_mtu_drops.toFixed(2)} 次 MTU 丢弃；选择性方案为 ${referenceFinding.selective_average_mtu_drops.toFixed(2)} 次。

这些只是待 ns-3 检验的预期趋势，不是最终系统级结论。

## ns-3 交叉验证

${ns3Section}

${ns3Complete ? `### ns-3 中的方案效应

- 选择性 INT 相对 full INT 的计划遥测字节平均下降 ${formatPercent(ns3Finding.planned_byte_reduction_percent)}。
- report 交付率平均变化 ${ns3Finding.report_delivery_gain_percentage_points.toFixed(2)} 个百分点。
- 业务 P95 时延平均变化 ${formatPercent(ns3Finding.business_delay_delta_percent)}，OAM 平均 AoI 平均变化 ${formatPercent(ns3Finding.average_aoi_delta_percent)}；负值代表改善。
- 每计划 MB 的成功报告数约为 full INT 的 ${ns3Finding.reports_per_planned_mb_ratio.toFixed(2)} 倍。
- full INT 平均 MTU 丢弃 ${ns3Finding.full_int_average_mtu_drops.toFixed(2)} 个包，选择性 INT 为 ${ns3Finding.selective_average_mtu_drops.toFixed(2)} 个包。
- full INT 的已交付 report RTT P95 为 ${ns3Finding.full_int_report_rtt_p95_ms.toFixed(3)} ms，选择性 INT 为 ${ns3Finding.selective_report_rtt_p95_ms.toFixed(3)} ms。前者更低主要因为超长 full INT 包提前被 MTU 门禁淘汰，只剩较短路径报告，属于幸存者偏差；必须与报告交付率和 AoI 联合解释。

定向压力扩展只用于检查接近过载时的队列竞争。在 ${stressLoadScales.join("、")} 倍负载下，选择性 INT 相对 full INT 的计划字节下降 ${formatPercent(stressNs3Finding.planned_byte_reduction_percent)}，业务 P95 时延变化 ${formatPercent(stressNs3Finding.business_delay_delta_percent)}，OAM 平均 AoI 变化 ${formatPercent(stressNs3Finding.average_aoi_delta_percent)}。该扩展不用于替换核心 9 组结论。

### 聚合侧与 ns-3 配对偏差

| 范围 | 负载 | 方案 | 计划字节误差 | 业务交付误差/pp | 业务 P95 误差 | 队列 P95 绝对误差/ms | 队列丢包 ns-3/聚合 | 报告交付误差/pp | OAM AoI 误差 |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|
${crossEngineMarkdownRows(crossEngineRows)}

核心 9 组中，计划字节平均绝对误差为 ${formatPercent(crossEngineFinding.mean_absolute_planned_byte_error_percent)}，业务 P95 平均绝对误差为 ${formatPercent(crossEngineFinding.mean_absolute_business_delay_p95_error_percent)}，队列 P95 平均绝对误差为 ${formatNumber(crossEngineFinding.mean_absolute_queue_delay_p95_error_ms, 6)} ms，业务交付率平均绝对误差为 ${crossEngineFinding.mean_absolute_business_delivery_error_pp.toFixed(3)} pp，预注册方向性趋势一致率为 ${formatPercent(numberValue(crossEngineFinding.directional_trend_agreement_ratio) * 100)}。

2.0 倍压力扩展中，业务 P95 平均绝对误差增至 ${formatPercent(stressCrossEngineFinding.mean_absolute_business_delay_p95_error_percent)}，队列 P95 平均绝对误差为 ${formatNumber(stressCrossEngineFinding.mean_absolute_queue_delay_p95_error_ms, 6)} ms。这说明聚合模型在核心负载下能保持趋势和量级，但在过载区会低估逐包尾时延；压力扩展用于公开这个适用边界，而不是合并后稀释核心结果。` : "完整 9 组 ns-3 结果尚未齐备，暂不生成正式配对结论。"}

队列丢包方面，核心回放聚合侧累计预测 ${crossEngineFinding.aggregate_reference_queue_drop_packets} 次，而 ns-3 设备队列记录 ${crossEngineFinding.ns3_queue_drop_packets} 次；压力扩展分别为 ${stressCrossEngineFinding.aggregate_reference_queue_drop_packets} 和 ${stressCrossEngineFinding.ns3_queue_drop_packets} 次。因此当前聚合队列丢包估计偏保守，不能把其绝对值直接当作逐包系统真值。

## 结论边界

- ns-3 结果完整前，本实验只能证明接口和包级流程可执行，不能作为系统级交叉验证完成的证据。
- ns-3 完成后可检验 INT header、MTU、逐包排队、动态断链和 report 丢失趋势，但仍不代表真实卫星硬件。
- 本实验采用“不允许 INT 分片”的明确策略，只证明 MTU 超限检测与丢弃语义；不声称已经评估所有 IP 分片实现。
- 本实验只采用小型代表窗口控制成本，不替代第一阶段的大规模 Walker/TLE 仿真和第二阶段 OAM 重构实验。
`;

  const bars = referenceRows.map((row) => {
    const width = Math.max(0, numberValue(row.planned_telemetry_network_bytes) / maxTelemetry * 100);
    return `<div class="bar-row"><span>${escapeHtml(`${row.load_scale}x ${row.variant}`)}</span><div class="track"><i style="width:${width.toFixed(2)}%"></i></div><strong>${numberValue(row.planned_telemetry_network_bytes).toLocaleString()}</strong></div>`;
  }).join("");
  const maxNs3Telemetry = Math.max(1, ...ns3Rows.map((row) =>
    numberValue(row.planned_telemetry_network_bytes)));
  const ns3Bars = ns3Rows.filter((row) => row.variant !== "no-int").map((row) => {
    const width = Math.max(0, numberValue(row.planned_telemetry_network_bytes) / maxNs3Telemetry * 100);
    const delivery = numberValue(row.report_delivery_ratio) * 100;
    return `<div class="bar-row"><span>${escapeHtml(`${row.load_scale}x ${row.variant}`)}</span><div class="track"><i class="${row.variant === "leo-selective" ? "selective" : "full"}" style="width:${width.toFixed(2)}%"></i></div><strong>${numberValue(row.planned_telemetry_network_bytes).toLocaleString()} B · ${delivery.toFixed(1)}%</strong></div>`;
  }).join("");
  const statusClass = ns3Complete ? "ok" : ns3Rows.length ? "partial" : "pending";
  const ns3Html = ns3Rows.length
    ? `<table><thead><tr><th>负载</th><th>方案</th><th>业务交付率</th><th>业务 P95/ms</th><th>总队列 P95/ms</th><th>遥测队列 P95/ms</th><th>队列丢包</th><th>计划字节</th><th>提交链路字节</th><th>报告交付率</th><th>OAM 平均 AoI/ms</th><th>计划字节下降</th><th>成功报告/计划 MB</th><th>MTU 丢弃</th></tr></thead><tbody>${htmlRows(ns3Rows)}</tbody></table>`
    : "<p>尚无 ns-3 结果；当前页面不能作为系统级交叉验证完成的证据。</p>";
  const crossEngineHtml = crossEngineRows.length
    ? `<table><thead><tr><th>范围</th><th>负载</th><th>方案</th><th>计划字节误差</th><th>业务交付误差/pp</th><th>业务 P95 误差</th><th>队列 P95 绝对误差/ms</th><th>队列丢包 ns-3/聚合</th><th>报告交付误差/pp</th><th>OAM AoI 误差</th></tr></thead><tbody>${crossEngineHtmlRows(crossEngineRows)}</tbody></table>`
    : "<p>等待完整配对结果。</p>";
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>实验 13 系统交叉验证</title>
<style>*{box-sizing:border-box}body{margin:0;background:#f4f6f8;color:#17202a;font-family:system-ui,"Microsoft YaHei",sans-serif;letter-spacing:0}main{max-width:1240px;margin:auto;padding:28px}header{background:#17202a;color:#fff;padding:28px;border-radius:6px}section{background:#fff;border:1px solid #d9e0e6;border-radius:6px;margin-top:20px;padding:22px;overflow:auto}.status{border-left:5px solid}.status.ok{border-color:#1e8449}.status.partial{border-color:#2874a6}.status.pending{border-color:#b9770e}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}.grid article{padding:14px;background:#edf3f7;border-left:4px solid #2874a6}.bar-row{display:grid;grid-template-columns:190px minmax(260px,1fr) 220px;gap:12px;align-items:center;margin:10px 0}.track{height:18px;background:#e8edf1}.track i{display:block;height:100%;background:#2874a6}.track i.selective{background:#1e8449}.track i.full{background:#b9770e}table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:9px;border-bottom:1px solid #e3e8ec;white-space:nowrap}.warning{color:#922b21}.note{color:#566573}@media(max-width:700px){main{padding:14px}.bar-row{grid-template-columns:1fr}.grid{grid-template-columns:1fr}}</style></head>
<body><main><header><h1>实验 13：经济型包级系统交叉验证</h1><p>${fixture.manifest.fixture.node_count} 星 · ${fixture.manifest.fixture.slice_count} 时间片 · no-int / full-int / LEO selective INT</p></header>
<section class="status ${statusClass}"><h2>证据状态</h2><p><strong>${escapeHtml(evidenceLabel(evidenceStatus))}</strong></p><code>${evidenceStatus}</code></section>
<section><h2>冻结输入</h2><div class="grid"><article><b>节点</b><p>${fixture.manifest.fixture.node_count}</p></article><article><b>时间片</b><p>${fixture.manifest.fixture.slice_count}</p></article><article><b>唯一链路</b><p>${fixture.manifest.fixture.unique_links}</p></article><article><b>业务流</b><p>${fixture.manifest.fixture.business_flows}</p></article><article><b>Probe 流</b><p>${fixture.manifest.fixture.probe_flows}</p></article></div></section>
<section><h2>ns-3 方案效应</h2><div class="grid"><article><b>核心计划字节下降</b><p>${ns3Complete ? formatPercent(ns3Finding.planned_byte_reduction_percent) : "待完成"}</p></article><article><b>核心交付率变化</b><p>${ns3Complete ? `${ns3Finding.report_delivery_gain_percentage_points.toFixed(2)} pp` : "待完成"}</p></article><article><b>核心报告效率倍率</b><p>${ns3Complete ? `${ns3Finding.reports_per_planned_mb_ratio.toFixed(2)}x` : "待完成"}</p></article><article><b>核心趋势一致率</b><p>${ns3Complete ? formatPercent(numberValue(trendAgreement.agreement_ratio) * 100) : "待完成"}</p></article><article><b>2.0x 压力扩展</b><p>${stressComplete ? "3/3 完成" : `${completedStressKeys.length}/${stressExpectedKeys.length}`}</p></article></div></section>
<section><h2>ns-3 计划字节与报告交付</h2><p class="note">条长为计划遥测链路字节，末尾百分比为 report 交付率；橙色为 full INT，绿色为选择性 INT。</p>${ns3Bars || "<p>尚未运行。</p>"}</section>
<section><h2>聚合侧参考回放</h2><p class="note">该回放使用模型导出的同一冻结输入，只作为配对参考。</p>${bars || "<p>尚未运行。</p>"}<table><thead><tr><th>负载</th><th>方案</th><th>业务交付率</th><th>业务 P95/ms</th><th>总队列 P95/ms</th><th>遥测队列 P95/ms</th><th>队列丢包</th><th>计划字节</th><th>提交链路字节</th><th>报告交付率</th><th>OAM 平均 AoI/ms</th><th>计划字节下降</th><th>成功报告/计划 MB</th><th>MTU 丢弃</th></tr></thead><tbody>${htmlRows(referenceRows)}</tbody></table></section>
<section><h2>ns-3 逐包结果</h2>${ns3Html}</section>
<section><h2>聚合侧与 ns-3 偏差</h2>${crossEngineHtml}<p class="note">核心业务 P95 平均绝对误差为 ${formatPercent(crossEngineFinding.mean_absolute_business_delay_p95_error_percent)}；2.0x 压力扩展为 ${formatPercent(stressCrossEngineFinding.mean_absolute_business_delay_p95_error_percent)}。核心队列丢包累计为 ns-3 ${crossEngineFinding.ns3_queue_drop_packets} / 聚合 ${crossEngineFinding.aggregate_reference_queue_drop_packets}，说明聚合丢包估计偏保守。逐包排队具有非线性，本实验比较量级与方向，不要求逐点完全一致。</p></section>
<section><h2>结论边界</h2><p class="warning">${ns3Complete ? "已生成完整 ns-3 包级结果，但它仍不代表真实卫星硬件或运营商内部真值。" : "当前证据尚未达到完整 ns-3 系统交叉验证。"}</p><p>MTU 采用不允许 INT 分片的显式策略；本实验不覆盖所有 IP 分片实现。</p></section>
</main></body></html>`;

  const summary = {
    schema_version: "experiment13-system-validation-summary-v1",
    generated_at: new Date().toISOString(),
    evidence_status: evidenceStatus,
    ns3_expected_combinations: expectedKeys.length,
    ns3_completed_combinations: completedCoreKeys.length,
    ns3_stress_expected_combinations: stressExpectedKeys.length,
    ns3_stress_completed_combinations: completedStressKeys.length,
    fixture: fixture.manifest.fixture,
    reference_results: referenceRows,
    ns3_results: ns3Rows,
    reference_findings: referenceFinding,
    ns3_findings: ns3Finding,
    ns3_stress_findings: stressNs3Finding,
    cross_engine_results: crossEngineRows,
    cross_engine_findings: crossEngineFinding,
    stress_cross_engine_findings: stressCrossEngineFinding,
    trend_agreement: trendAgreement,
    selective_reference_summary: referenceRows.filter((row) => row.variant === "leo-selective"),
  };
  await mkdir(outputDir, { recursive: true });
  await Promise.all([
    writeFile(join(outputDir, "EXPERIMENT_13_SYSTEM_VALIDATION.md"), report, "utf8"),
    writeFile(join(outputDir, "index.html"), html, "utf8"),
    writeFile(join(outputDir, "experiment13-system-validation-summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8"),
  ]);
  return summary;
}
