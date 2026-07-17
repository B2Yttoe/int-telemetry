import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

function numberValue(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function pct(value, digits = 2) {
  return `${(numberValue(value) * 100).toFixed(digits)}%`;
}

function endpointRows(reference = {}) {
  const rows = reference.static_rows ?? [];
  const result = [];
  for (const profileId of [...new Set(rows.map((row) => row.profile_id))]) {
    const group = rows.filter((row) => row.profile_id === profileId).sort((left, right) => left.stress_rate - right.stress_rate);
    if (group.length < 2) continue;
    const low = group[0];
    const high = group.at(-1);
    const full = (reference.comparison_rows ?? []).find((row) => row.profile_id === profileId && row.method_id === "native-full-replan" && row.stress_rate === high.stress_rate);
    const enhanced = (reference.comparison_rows ?? []).find((row) => row.profile_id === profileId && row.method_id === "enhanced" && row.stress_rate === high.stress_rate);
    result.push({ low, high, full, enhanced });
  }
  return result;
}

function referenceTable(reference) {
  const rows = endpointRows(reference);
  if (!rows.length) return "暂无正式结果。";
  return `| 星座 | 参考计划失效 0%→25% | CPU MAE 0%→25% | 队列 MAE 0%→25% | 电量 MAE 0%→25% | 利用率 MAE 0%→25% | 原生全重规划片数 | 增强重规划片数 |\n|---|---:|---:|---:|---:|---:|---:|---:|\n${rows.map(({ low, high, full, enhanced }) => `| ${high.constellation_label} | ${pct(low.invalid_probe_path_ratio)} → ${pct(high.invalid_probe_path_ratio)} | ${low.cpu_mae} → ${high.cpu_mae} | ${low.queue_depth_mae} → ${high.queue_depth_mae} | ${low.energy_percent_mae} → ${high.energy_percent_mae} | ${low.link_utilization_mae} → ${high.link_utilization_mae} | ${full?.replanned_slices ?? "-"} | ${enhanced?.replanned_slices ?? "-"} |`).join("\n")}`;
}

function multiSeedTable(multiSeed) {
  const rows = (multiSeed.summary_rows ?? []).filter((row) => numberValue(row.stress_rate) === 0.25);
  if (!rows.length) return "暂无正式结果。";
  return `| 星座 | seed 数 | 25% 相对 0% 的额外失效 | 95% CI | Jaccard | forced-down 密度 |\n|---|---:|---:|---:|---:|---:|\n${rows.map((row) => `| ${row.constellation_label} | ${row.seeds} | ${pct(row.excess_path_failure_mean)} | [${pct(row.excess_path_failure_ci95_low)}, ${pct(row.excess_path_failure_ci95_high)}] | ${row.jaccard_mean} | ${pct(row.forced_down_fraction_mean)} |`).join("\n")}`;
}

function reportingTable(reporting) {
  const rows = reporting.rows ?? [];
  const result = [];
  for (const profileId of [...new Set(rows.map((row) => row.profile_id))]) {
    for (const methodId of ["native", "enhanced"]) {
      const group = rows.filter((row) => row.profile_id === profileId && row.method_id === methodId).sort((left, right) => left.reporting_interruption_rate - right.reporting_interruption_rate);
      if (group.length < 2) continue;
      result.push({ low: group[0], high: group.at(-1) });
    }
  }
  if (!result.length) return "暂无正式结果。";
  return `| 星座 | 方法 | 交付率 0%→20% | CPU MAE 变化 | 队列 MAE 变化 | 电量 MAE 变化 | 利用率 MAE 变化 | 路径数是否固定 |\n|---|---|---:|---:|---:|---:|---:|---:|\n${result.map(({ low, high }) => `| ${high.constellation_label} | ${high.method_label} | ${pct(low.delivery_ratio)} → ${pct(high.delivery_ratio)} | ${(high.cpu_mae-low.cpu_mae).toFixed(4)} | ${(high.queue_depth_mae-low.queue_depth_mae).toFixed(4)} | ${(high.energy_percent_mae-low.energy_percent_mae).toFixed(4)} | ${(high.link_utilization_mae-low.link_utilization_mae).toFixed(4)} | ${low.selected_paths === high.selected_paths ? "是" : "否"} |`).join("\n")}`;
}

function externalSection(external) {
  const orbit = external.orbit_cross_epoch?.summary ?? {};
  const observations = external.external_observations ?? {};
  return `- 证据状态：${external.evidence_status ?? "unknown"}\n- 独立 CelesTrak 验证历元：${orbit.validation_epoch_count ?? 0}\n- 卫星-历元配对：${orbit.matched_satellite_epoch_pairs ?? 0}\n- SGP4 传播失败：${orbit.propagation_failures ?? 0}\n- 综合 ECI MAE：${orbit.eci_position_mae_km ?? "-"} km\n- RIPE Atlas：模型用户侧 P50 RTT ${observations.network?.model_user_ping_p50_ms ?? "-"} ms，公开 P50 RTT ${observations.network?.external_ripe_rtt_p50_ms ?? "-"} ms\n- Cloudflare Radar：${observations.radar_evidence?.classification === "calibration-fit" ? "校准拟合，不是独立留出验证" : observations.radar_evidence?.classification ?? "未分类"}`;
}

export function buildInfocomEvidenceMarkdown({ causal = {}, reference = {}, multiSeed = {}, reporting = {}, external = {} } = {}) {
  const negative = causal.negative_results ?? [];
  const negativeText = negative.length
    ? negative.map((row) => `- ${row.constellation_label}，${row.metric}：增强 ${row.enhanced_value}，原生 ${row.native_value}，差值 ${row.enhanced_minus_native}。`).join("\n")
    : "- 当前汇总未提供负结果列表；正式论文仍需逐指标检查。";
  return `# INFOCOM 因果证据与外部真实性汇总\n\n## 1. 原生 INT-MC 为什么不适应动态 LEO\n\n原生参考回放组使用 0% 受控扰动轨迹上预计算的逐时间片 probe plan，在更高扰动下不重新规划。probe 执行器会在 down 链路处真实失败，不能穿越失效链路生成报告。\n\n${referenceTable(reference)}\n\n这条对照把两个极端分开：参考计划复用的计算开销低但会失效；原生每片全重规划能避免实际路径失效，但付出持续规划开销。增强 LEO-INT-MC 位于两者之间，低扰动时可以复用和局部修复，高扰动时仍可能退化为频繁重规划。\n\n## 2. 固定采样预算与多种子证据\n\n主实验固定采样参数、业务输入、forced-down 密度和星座真值。额外的多种子分析固定 T00 初始 mask，只改变后续受控交换顺序；统计同一 seed 相对 0% 组的额外失效比例。\n\n${multiSeedTable(multiSeed)}\n\n置信区间只证明“受控拓扑交换导致参考计划额外失效”的统计稳定性，不用轻量后处理拓扑生成 CPU、队列或电量真值。\n\n## 3. reporting path 中断\n\n在固定 25% 拓扑扰动、固定 probe plan 和固定生成遥测字节下，将 reporting path 中断率从 0% 提高到 20%。报告在 sink 生成后、Ground OAM 接收前被丢弃。\n\n${reportingTable(reporting)}\n\n这证明 OAM 重构不仅受 probe 覆盖影响，也受星地回传成功率约束。部分大型指标不随中断单调恶化，应视为状态分布、先验和平滑共同作用的真实负结果。\n\n## 4. 外部真实性\n\n${externalSection(external)}\n\n可验证边界必须保持：轨道、位置、接触关系和传播/用户侧 RTT 可以使用公开数据外部验证；CPU、电量和队列是模型公式生成的内部潜变量，只能证明物理一致性、守恒关系和业务响应合理性，不能声称为 Starlink 运营真值。\n\n## 5. 负结果与审慎结论\n\n${negativeText}\n\n当前证据支持：静态或参考 probe plan 不能无代价地适应动态 LEO；全量重规划能够保持路径有效但计算开销高；增强方法在多数节点状态指标上改善重构，但不能宣称在所有星座、所有指标和所有动态性水平下都严格优于原生方案。\n\n## 6. 关键产物\n\n- [拓扑动态性因果报告](reports/experiment8-dynamicity-causality/experiment8-dynamicity-report.html)\n- [原生参考计划回放报告](reports/experiment8-native-reference-replay/experiment8-native-static-report.html)\n- [30-seed 鲁棒性报告](reports/experiment8-multi-seed-robustness/experiment8-multi-seed-report.html)\n- [reporting 中断敏感性报告](reports/experiment8-reporting-interruption-sensitivity/experiment8-reporting-sensitivity-report.html)\n- [多历元外部验证报告](reports/experiment9-multi-epoch-external-validation/experiment9-external-validation-report.html)\n`;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function main() {
  const causal = await readJson(resolve("reports/experiment8-dynamicity-causality/experiment8-dynamicity-summary.json"));
  const reference = await readJson(resolve("reports/experiment8-native-reference-replay/experiment8-native-static-summary.json"));
  const multiSeed = await readJson(resolve("reports/experiment8-multi-seed-robustness/experiment8-multi-seed-summary.json"));
  const reporting = await readJson(resolve("reports/experiment8-reporting-interruption-sensitivity/experiment8-reporting-sensitivity-summary.json"));
  const external = await readJson(resolve("reports/experiment9-multi-epoch-external-validation/experiment9-external-validation-report.json"));
  const output = resolve("INFOCOM_CAUSAL_EXTERNAL_EVIDENCE.md");
  await writeFile(output, buildInfocomEvidenceMarkdown({ causal, reference, multiSeed, reporting, external }), "utf8");
  console.log(JSON.stringify({ ok: true, output }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
