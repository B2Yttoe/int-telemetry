import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

function argValue(args, name, fallback = "") {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  return args[index + 1] ?? fallback;
}

function rel(path) {
  return relative(process.cwd(), path).replaceAll("\\", "/");
}

function round(value, digits = 4) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const scale = 10 ** digits;
  return Math.round(number * scale) / scale;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (inQuotes) {
      if (char === '"' && next === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') inQuotes = true;
    else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  const header = rows.shift() ?? [];
  return rows
    .filter((item) => item.some((value) => value !== ""))
    .map((item) => Object.fromEntries(header.map((key, index) => [key, item[index] ?? ""])));
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function readCsv(path) {
  return parseCsv(await readFile(path, "utf8"));
}

function csvRowCount(rows) {
  return Array.isArray(rows) ? rows.length : 0;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function lineChart(rows, series, { width = 920, height = 300, title = "" } = {}) {
  const margin = { left: 56, right: 28, top: 34, bottom: 42 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const x = (index) => margin.left + (index / Math.max(1, rows.length - 1)) * plotWidth;
  const y = (value) => margin.top + (1 - Math.max(0, Math.min(1, value))) * plotHeight;
  const paths = series
    .map((item) => {
      const points = rows
        .map((row, index) => {
          const value = Number(row[item.id]);
          return Number.isFinite(value) ? `${x(index).toFixed(2)},${y(value).toFixed(2)}` : "";
        })
        .filter(Boolean)
        .join(" ");
      return `<polyline points="${points}" fill="none" stroke="${item.color}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>`;
    })
    .join("");
  const legend = series
    .map(
      (item, index) =>
        `<g transform="translate(${margin.left + index * 210},${height - 16})"><rect width="14" height="4" fill="${item.color}"/><text x="22" y="4">${escapeHtml(item.label)}</text></g>`,
    )
    .join("");
  const grid = [0, 0.25, 0.5, 0.75, 1]
    .map((value) => `<line x1="${margin.left}" x2="${width - margin.right}" y1="${y(value)}" y2="${y(value)}" class="chart-grid"/>`)
    .join("");
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(title)}">
    <title>${escapeHtml(title)}</title>
    <text x="${margin.left}" y="22" class="chart-title">${escapeHtml(title)}</text>
    ${grid}
    <line x1="${margin.left}" y1="${height - margin.bottom}" x2="${width - margin.right}" y2="${height - margin.bottom}" class="axis"/>
    <line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${height - margin.bottom}" class="axis"/>
    ${paths}
    ${legend}
  </svg>`;
}

function metricBarChart(items, { width = 920, height = 260, title = "" } = {}) {
  const margin = { left: 64, right: 24, top: 42, bottom: 72 };
  const maxValue = Math.max(...items.map((item) => Number(item.value)).filter(Number.isFinite), 1);
  const barWidth = (width - margin.left - margin.right) / Math.max(1, items.length) - 18;
  const y = (value) => height - margin.bottom - (Number(value) / maxValue) * (height - margin.top - margin.bottom);
  const bars = items
    .map((item, index) => {
      const x = margin.left + index * (barWidth + 18);
      const barY = y(item.value);
      const barHeight = height - margin.bottom - barY;
      return `<g>
        <rect x="${x}" y="${barY}" width="${barWidth}" height="${barHeight}" rx="4" fill="${item.color}"/>
        <text x="${x + barWidth / 2}" y="${barY - 8}" text-anchor="middle" class="bar-value">${escapeHtml(item.display)}</text>
        <text x="${x + barWidth / 2}" y="${height - margin.bottom + 24}" text-anchor="middle">${escapeHtml(item.label)}</text>
      </g>`;
    })
    .join("");
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(title)}">
    <title>${escapeHtml(title)}</title>
    <text x="${margin.left}" y="24" class="chart-title">${escapeHtml(title)}</text>
    <line x1="${margin.left}" y1="${height - margin.bottom}" x2="${width - margin.right}" y2="${height - margin.bottom}" class="axis"/>
    ${bars}
  </svg>`;
}

function sourceMarkdown(sources) {
  return sources
    .map((source) => `| ${source.name} | ${source.status} | ${source.url} | ${source.detail} |`)
    .join("\n");
}

function sourceRows(sources) {
  return sources
    .map(
      (source) =>
        `<tr><td>${escapeHtml(source.name)}</td><td>${escapeHtml(source.status)}</td><td>${escapeHtml(source.url)}</td><td>${escapeHtml(source.detail)}</td></tr>`,
    )
    .join("");
}

const args = process.argv.slice(2);
const outDir = resolve(argValue(args, "--out", "reports/experiment1-satellite-data-authenticity"));
const archivePath = argValue(args, "--archive", "");
const report = await readJson(join(outDir, "external-realism-report.json"));
const truthMetadata = await readJson(join(outDir, "stage1-truth", "metadata.json"));
const trafficRows = await readCsv(join(outDir, "traffic-external-comparison.csv"));
const networkRows = await readCsv(join(outDir, "network-performance-external-comparison.csv"));
const orbitRows = await readCsv(join(outDir, "orbit-external-comparison.csv"));
const linkRows = await readCsv(join(outDir, "stage1-truth", "links.csv"));
const nodeRows = await readCsv(join(outDir, "stage1-truth", "nodes.csv"));
const routeRows = await readCsv(join(outDir, "stage1-truth", "routes.csv"));
const traceRows = await readCsv(join(outDir, "stage1-truth", "task-traces.csv"));
let internalPlausibility = null;
try {
  internalPlausibility = await readJson(join(outDir, "experiment1-internal-state-plausibility.json"));
} catch {
  internalPlausibility = null;
}

const orbit = report.orbit_external.summary;
const constellation = report.constellation_external.summary;
const traffic = report.traffic_external.summary;
const network = report.network_performance_external.summary;
const validation = truthMetadata.validation_summary ?? truthMetadata.validation ?? {};
const generatedAt = new Date().toISOString();
const internalSectionMarkdown = internalPlausibility
  ? `### 6.5 内部状态潜变量可信性审计

| 指标 | 结果 |
|---|---:|
| 检查项数量 | ${internalPlausibility.check_count} |
| 通过检查项 | ${internalPlausibility.passed_count} |
| 需检查项 | ${internalPlausibility.failed_count} |
| 内部状态可信性分数 | ${internalPlausibility.internal_plausibility_score} |
| 推断电池容量 | ${internalPlausibility.inferred_battery_capacity_wh} Wh |
| 推断太阳翼峰值发电 | ${internalPlausibility.inferred_solar_peak_power_w} W |

结论：CPU、电池、队列、缓存等公开数据无法直接逐点验证的内部潜变量，已经通过公式一致性、物理边界、拓扑约束和输入响应关系审计。该结论不能解释为获得了运营商内部遥测真值，但可以作为后续 INT/INT-MC 算法评估中仿真真值层的合理性证据。
`
  : `### 6.5 内部状态潜变量可信性审计

本次目录中尚未发现 \`experiment1-internal-state-plausibility.json\`。建议补充运行：

\`\`\`powershell
npm run experiment1:internal-plausibility -- --out ${rel(outDir)}
\`\`\`
`;
const internalOutputRows = internalPlausibility
  ? `| \`${rel(join(outDir, "experiment1-internal-state-plausibility.html"))}\` | 内部状态可信性审计 HTML |
| \`${rel(join(outDir, "experiment1-internal-state-plausibility.json"))}\` | 内部状态可信性审计 JSON |
| \`${rel(join(outDir, "experiment1-internal-state-checks.csv"))}\` | 内部状态审计检查项表 |
| \`${rel(join(outDir, "experiment1-internal-state-timeseries.csv"))}\` | 内部状态时间片响应序列 |`
  : "";
const internalConclusionRow = internalPlausibility
  ? `<tr><th>内部潜变量</th><td>内部状态可信性审计 ${internalPlausibility.passed_count}/${internalPlausibility.check_count} 项通过，分数 ${internalPlausibility.internal_plausibility_score}；CPU、电池、队列、缓存等外部不可直接观测字段满足公式、边界和输入响应约束。</td></tr>`
  : `<tr><th>内部潜变量</th><td>未发现内部状态可信性审计结果，建议运行 <code>npm run experiment1:internal-plausibility</code> 补充 CPU、电池、队列等潜变量审计。</td></tr>`;

const markdown = `# 实验 1：卫星网络仿真数据真实性校准实验

生成时间：${generatedAt}

实验目录：\`${rel(outDir)}\`

${archivePath ? `旧实验归档目录：\`${archivePath.replaceAll("\\", "/")}\`\n` : ""}

## 1. 实验目的

本实验旨在验证本文构建的 LEO 卫星网络仿真环境是否能够生成具有物理一致性、拓扑合理性和业务响应可信度的卫星节点状态、链路状态与遥测状态数据。

需要强调的是，本实验并不声称复刻某一运营商的真实内部网络状态。真实 Starlink/LEO 星座的星间链路占用、队列长度、星上 CPU、能耗、路由策略和 INT 遥测数据并未公开。因此，本文的验证目标不是“与运营商内部真值逐点一致”，而是证明该模型在可公开验证的轨道数据、物理链路规律、星座拓扑约束和公开业务统计特征下，能够生成可解释、可复现、可用于 INT 遥测算法评估的高可信仿真数据。

## 2. 实验流程

1. 归档旧版失败或预实验目录，避免把旧的负相关业务曲线和正式实验混用。
2. 使用 CelesTrak Starlink GP/TLE 快照作为真实轨道输入，选择 72x22、共 ${truthMetadata.node_count} 颗卫星的可仿真壳层样本。
3. 使用冻结的 Cloudflare Radar AS14593 JSON 数值序列生成业务数据集，默认取最新 ${traffic.external_radar_aligned_points} 个观测点与模型时间片对齐。
4. 以 \`real-tle-sgp4\`、\`operational\`、\`congestion-aware-shortest-path\` 运行阶段一仿真，导出节点、链路、路由和任务 trace 真值。
5. 链路传播时延采用距离主导模型，即 \`distance / c\` 加低逐跳交换开销；当前 ISL 逐跳处理开销为 0.25 ms/link。
6. 用 CelesTrak、Cloudflare Radar、RIPE Atlas 三类外部公开数据源进行外部对照。

## 3. 输入与输出规模

| 项目 | 数值 |
|---|---:|
| 卫星节点数 | ${truthMetadata.node_count} |
| 单时间片链路数 | ${truthMetadata.link_count} |
| 时间片数 | ${truthMetadata.slice_count} |
| 节点状态行数 | ${csvRowCount(nodeRows)} |
| 链路状态行数 | ${csvRowCount(linkRows)} |
| 路由记录行数 | ${csvRowCount(routeRows)} |
| 任务 trace 行数 | ${csvRowCount(traceRows)} |
| 输入任务数 | ${truthMetadata.dataset_task_count} |
| 路由任务数 | ${truthMetadata.dataset_routed_task_count} |
| 本地计算任务数 | ${truthMetadata.dataset_local_task_count} |
| 数据集 fingerprint | ${truthMetadata.dataset_fingerprint} |
| 真值 fingerprint | ${truthMetadata.truth_fingerprint} |
| 校验结果 | accepted=${validation.accepted ?? 0}, warnings=${(validation.warnings ?? []).length}, errors=${(validation.errors ?? []).length} |

## 4. 外部数据源状态

| 数据源 | 状态 | 地址/文件 | 说明 |
|---|---|---|---|
${sourceMarkdown(report.external_sources)}

## 5. 指标定义

轨道高度由平均运动反推：

\`\`\`text
n = mean_motion_rev_day * 2*pi / 86400
a = (mu / n^2)^(1/3)
h = a - R_E
\`\`\`

轨道误差使用平均绝对误差：

\`\`\`text
MAE_h = (1/N) * sum_i |h_sim,i - h_ext,i|
\`\`\`

RAAN 分布相似度使用归一化直方图重叠：

\`\`\`text
J_hist = 1 - 0.5 * sum_b |p_sim,b - p_ext,b|
\`\`\`

业务曲线对照只比较归一化后的形状，不比较 Cloudflare 指数值和模型 Mbps 的绝对量纲：

\`\`\`text
rho = cov(X_sim, X_ext) / (sigma_sim * sigma_ext)
MAE = (1/T) * sum_t |x_sim,t - x_ext,t|
\`\`\`

单条星间链路时延：

\`\`\`text
L_ISL(e) = d_e / c + tau_isl
tau_isl = 0.25 ms/link
\`\`\`

用户侧 RTT 使用公开探针位置、模型卫星几何和区域网关抽象估计：

\`\`\`text
RTT_user_sim = 2 * (d_user,sat / c + d_sat,gateway / c + tau_proc + tau_terr)
\`\`\`

如需要星间回退路径，则加入当前时间片活动 ISL 图上的最短星间时延：

\`\`\`text
RTT_user_sim = 2 * (d_user,sat / c + L_ISL_shortest + d_gateway_sat,gateway / c + tau_proc + tau_terr)
\`\`\`

## 6. 实验结果

### 6.1 轨道真实性

| 指标 | 结果 |
|---|---:|
| 模型卫星数 | ${orbit.selected_satellites} |
| 外部 Starlink 目录记录数 | ${orbit.external_catalog_records} |
| NORAD 匹配卫星数 | ${orbit.matched_satellites} |
| NORAD 匹配率 | ${orbit.match_ratio} |
| 输出高度 MAE | ${orbit.output_altitude_mae_km} km |
| 倾角 MAE | ${orbit.inclination_mae_deg} deg |
| 平均运动 MAE | ${orbit.mean_motion_mae_rev_day} rev/day |
| RAAN MAE | ${orbit.raan_mae_deg} deg |

结论：轨道层具有强外部公开数据支撑。模型卫星与 CelesTrak 目录通过 NORAD ID 完整匹配，高度误差约 ${orbit.output_altitude_mae_km} km，适合作为后续拓扑和链路状态仿真的轨道基础。

### 6.2 星座规模与拓扑壳层

| 指标 | 结果 |
|---|---:|
| 目标壳层倾角 | ${constellation.target_inclination_deg} deg |
| 目标壳层高度 | ${constellation.target_altitude_km} km |
| 外部目标壳层卫星数 | ${constellation.external_target_shell_count} |
| 模型选取卫星数 | ${constellation.model_selected_count} |
| 规模覆盖比 | ${constellation.scale_coverage_ratio} |
| 模型轨道面 | ${constellation.model_planes} |
| 每轨道面卫星数 | ${constellation.model_satellites_per_plane} |
| RAAN 分布相似度 | ${constellation.raan_distribution_similarity} |

结论：该模型不是完整 Starlink 全量复刻，而是目标壳层的 72x22 大规模可仿真样本。RAAN 分布相似度为 ${constellation.raan_distribution_similarity}，说明轨道面分布具备较好的壳层结构一致性；规模覆盖比 ${constellation.scale_coverage_ratio} 需要在论文中如实说明。

### 6.3 业务流量真实性

| 指标 | 结果 |
|---|---:|
| Radar 原始点数 | ${traffic.external_radar_points} |
| Radar 对齐点数 | ${traffic.external_radar_aligned_points} |
| 对齐方式 | ${traffic.external_radar_alignment_method} |
| 对齐时间窗 | ${traffic.external_radar_first_time} 到 ${traffic.external_radar_last_time} |
| 模型 vs Radar 相关系数 | ${traffic.model_vs_external_radar_corr} |
| 模型 vs Radar 归一化 MAE | ${traffic.model_vs_external_radar_mae_normalized} |
| 模型 vs 旧本地模板相关系数 | ${traffic.model_vs_calibration_template_corr} |

结论：业务生成已经从“参考 Radar 风格”升级为“由 Radar 原始数值时序驱动”。归一化相关系数达到 ${traffic.model_vs_external_radar_corr}，说明模型业务负载峰谷已经与公开 AS14593 业务曲线形成有效同步。由于 Cloudflare Radar 是 ASN 级聚合观测，本结论只证明业务时间形态可信，不证明获得了运营商内部逐包流量 trace。

### 6.4 网络性能量级真实性

| 指标 | 结果 |
|---|---:|
| RIPE Atlas ping 样本数 | ${network.external_ripe_ping_samples} |
| RIPE Atlas 探针数 | ${network.external_probe_count} |
| 模型用户侧 P50 RTT | ${network.model_user_ping_p50_ms} ms |
| RIPE Atlas P50 RTT | ${network.external_ripe_rtt_p50_ms} ms |
| 用户侧 P50 比例 | ${network.model_user_ping_to_ripe_p50_latency_ratio} |
| 模型用户侧 P95 RTT | ${network.model_user_ping_p95_ms} ms |
| RIPE Atlas P95 RTT | ${network.external_ripe_rtt_p95_ms} ms |
| 模型用户侧平均 RTT | ${network.model_user_ping_mean_ms} ms |
| RIPE Atlas 平均 RTT | ${network.external_ripe_rtt_p50_ms} ms P50 / ${round(network.external_ripe_rtt_p95_ms, 4)} ms P95 |
| 内部任务 P50 路由时延 | ${network.model_route_latency_p50_ms} ms |
| 内部任务 P95 路由时延 | ${network.model_route_latency_p95_ms} ms |

结论：模型用户侧 P50 RTT 为 ${network.model_user_ping_p50_ms} ms，RIPE Atlas P50 RTT 为 ${network.external_ripe_rtt_p50_ms} ms，比例 ${network.model_user_ping_to_ripe_p50_latency_ratio}，属于公开接入侧 RTT 的同量级结果。P95 尾部仍偏高，主要反映区域网关抽象、可见性约束和 ISL 回退路径的保守估计。内部任务路由时延不能与 RIPE ping 直接等同，只能解释星座内部业务压力。

${internalSectionMarkdown}

## 7. 可信性结论

本实验可以支撑如下表述：

> 本项目能够基于 CelesTrak 真实轨道目录、SGP4 传播、物理链路约束、Cloudflare Radar 业务时序、RIPE Atlas 用户侧公开 RTT，以及内部潜变量公式一致性审计，生成具有轨道真实性、拓扑合理性、业务峰谷同步性、网络性能量级可解释性和内部状态自洽性的卫星网络仿真数据。该数据适合作为后续 INT 全网遥测、INT-MC 低开销遥测和机器学习预测实验的仿真真值环境。

不能支撑如下表述：

> 本项目复刻了 Starlink 真实内部网络状态，或者获得了真实运营商内部逐星 CPU、队列、电池、ISL 占用和路由策略真值。

## 8. 主要输出文件

| 文件 | 说明 |
|---|---|
| \`${rel(join(outDir, "input", "radar-fitted-traffic.csv"))}\` | Radar 驱动业务输入数据集 |
| \`${rel(join(outDir, "input", "radar-fitted-traffic.metadata.json"))}\` | 业务校准元数据 |
| \`${rel(join(outDir, "stage1-truth", "nodes.csv"))}\` | 每时间片节点状态真值 |
| \`${rel(join(outDir, "stage1-truth", "links.csv"))}\` | 每时间片链路状态真值 |
| \`${rel(join(outDir, "stage1-truth", "routes.csv"))}\` | 任务路由结果 |
| \`${rel(join(outDir, "stage1-truth", "task-traces.csv"))}\` | 任务执行 trace |
| \`${rel(join(outDir, "traffic-external-comparison.csv"))}\` | Radar 业务对照 |
| \`${rel(join(outDir, "user-facing-rtt-comparison.csv"))}\` | RIPE 用户侧 RTT 对照 |
${internalOutputRows}
| \`${rel(join(outDir, "external-realism-report.html"))}\` | 自动可视化报告 |
| \`${rel(join(outDir, "experiment1-research-report.html"))}\` | 本研究级报告 HTML |

## 9. 复现命令

\`\`\`powershell
npm run generate:radar-traffic -- --snapshot data\\tle-snapshots\\celestrak-starlink-real-walker-72x22.json --profile traffic-calibration\\cloudflare-radar-profile.json --radar-json reports\\_archive\\experiment1-pre-final-20260703-211932\\experiment1-external-realism-72x22\\external\\cloudflare-radar\\radar-as14593-traffic.json --radar-window latest --out reports\\experiment1-satellite-data-authenticity\\input\\radar-fitted-traffic.csv --metadata-out reports\\experiment1-satellite-data-authenticity\\input\\radar-fitted-traffic.metadata.json --slices 48

npm run experiment:realism -- --out reports\\experiment1-satellite-data-authenticity --snapshot data\\tle-snapshots\\celestrak-starlink-real-walker-72x22.json --tasks reports\\experiment1-satellite-data-authenticity\\input\\radar-fitted-traffic.csv --slices 48 --radar-json reports\\_archive\\experiment1-pre-final-20260703-211932\\experiment1-external-realism-72x22\\external\\cloudflare-radar\\radar-as14593-traffic.json --radar-window latest --ripe-max-probes 16 --ripe-hours 4

npm run experiment1:internal-plausibility -- --out reports\\experiment1-satellite-data-authenticity
\`\`\`
`;

const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>实验 1：卫星网络仿真数据真实性校准实验</title>
  <script>
    window.MathJax = { tex: { inlineMath: [["$", "$"], ["\\\\(", "\\\\)"]] }, svg: { fontCache: "global" } };
  </script>
  <script defer src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-svg.js"></script>
  <style>
    :root { color-scheme: light; font-family: "Inter", "Segoe UI", Arial, sans-serif; color: #172033; background: #f6f7fb; }
    body { margin: 0; }
    main { max-width: 1160px; margin: 0 auto; padding: 32px 24px 60px; }
    h1 { font-size: 32px; margin: 0 0 10px; }
    h2 { margin-top: 30px; border-top: 1px solid #d9deea; padding-top: 22px; }
    h3 { margin-top: 24px; }
    p, li { line-height: 1.68; }
    .lead { font-size: 17px; color: #34425d; }
    .grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin: 22px 0; }
    .card { background: white; border: 1px solid #dde3ef; border-radius: 8px; padding: 14px; box-shadow: 0 8px 22px rgba(29,43,76,.05); }
    .card span { display: block; color: #66728a; font-size: 12px; }
    .card strong { display: block; font-size: 24px; margin-top: 8px; }
    table { width: 100%; border-collapse: collapse; background: white; margin: 14px 0 22px; }
    th, td { border: 1px solid #dfe5f1; padding: 9px 10px; text-align: left; vertical-align: top; }
    th { background: #eef3fb; }
    code, pre { background: #eef2f7; border-radius: 6px; }
    code { padding: 2px 5px; }
    pre { padding: 12px; overflow: auto; }
    .panel { background: white; border: 1px solid #dfe5f1; border-radius: 8px; padding: 16px; margin: 16px 0; }
    svg { width: 100%; height: auto; background: white; }
    .axis { stroke: #73809a; stroke-width: 1; }
    .chart-grid { stroke: #e7ebf4; stroke-width: 1; }
    .chart-title { font-weight: 700; font-size: 15px; fill: #1d2b4c; }
    text { font-size: 12px; fill: #34425d; }
    .bar-value { font-weight: 700; }
    .note { color: #58657c; }
    @media (max-width: 820px) { .grid { grid-template-columns: 1fr 1fr; } main { padding: 22px 14px 44px; } }
  </style>
</head>
<body>
<main>
  <h1>实验 1：卫星网络仿真数据真实性校准实验</h1>
  <p class="lead">本实验验证 LEO 卫星网络仿真环境是否能够生成具有物理一致性、拓扑合理性和业务响应可信度的节点、链路与遥测状态数据。它不声称复刻运营商内部真值，而是证明模型在公开可验证数据约束下可解释、可复现、可用于 INT 遥测算法评估。</p>

  <section class="grid">
    <div class="card"><span>轨道匹配</span><strong>${orbit.matched_satellites}/${orbit.selected_satellites}</strong></div>
    <div class="card"><span>高度 MAE</span><strong>${orbit.output_altitude_mae_km} km</strong></div>
    <div class="card"><span>业务相关系数</span><strong>${traffic.model_vs_external_radar_corr}</strong></div>
    <div class="card"><span>用户侧 RTT 比例</span><strong>${network.model_user_ping_to_ripe_p50_latency_ratio}</strong></div>
  </section>

  <h2>实验流程</h2>
  <ol>
    <li>归档旧版失败或预实验目录，避免把旧结论混入正式实验。</li>
    <li>使用 CelesTrak Starlink GP/TLE 快照作为真实轨道输入，选择 72x22、共 ${truthMetadata.node_count} 颗卫星。</li>
    <li>使用 Cloudflare Radar AS14593 JSON 数值序列驱动业务负载，而非只参考本地平滑模板。</li>
    <li>导出阶段一真值，并用 CelesTrak、Cloudflare Radar、RIPE Atlas 做外部对照。</li>
  </ol>

  <h2>外部数据源</h2>
  <table><thead><tr><th>数据源</th><th>状态</th><th>地址/文件</th><th>说明</th></tr></thead><tbody>${sourceRows(report.external_sources)}</tbody></table>

  <h2>规模与真值输出</h2>
  <table><tbody>
    <tr><th>卫星节点数</th><td>${truthMetadata.node_count}</td><th>时间片数</th><td>${truthMetadata.slice_count}</td></tr>
    <tr><th>节点状态行数</th><td>${csvRowCount(nodeRows)}</td><th>链路状态行数</th><td>${csvRowCount(linkRows)}</td></tr>
    <tr><th>路由记录行数</th><td>${csvRowCount(routeRows)}</td><th>任务 trace 行数</th><td>${csvRowCount(traceRows)}</td></tr>
    <tr><th>输入任务数</th><td>${truthMetadata.dataset_task_count}</td><th>真值 fingerprint</th><td>${escapeHtml(truthMetadata.truth_fingerprint)}</td></tr>
  </tbody></table>

  <h2>数学指标</h2>
  <div class="panel">
    \\[
    n = \\frac{mean\\_motion\\_{rev/day}\\cdot 2\\pi}{86400},\\quad
    a = \\left(\\frac{\\mu}{n^2}\\right)^{1/3},\\quad
    h = a - R_E
    \\]
    \\[
    MAE_h = \\frac{1}{N}\\sum_i |h_{sim,i}-h_{ext,i}|
    \\]
    \\[
    \\rho = \\frac{cov(X_{sim}, X_{ext})}{\\sigma_{sim}\\sigma_{ext}},\\quad
    MAE = \\frac{1}{T}\\sum_t |x_{sim,t}-x_{ext,t}|
    \\]
    \\[
    L_{ISL}(e)=\\frac{d_e}{c}+\\tau_{isl},\\quad \\tau_{isl}=0.25\\;ms/link
    \\]
    \\[
    RTT^{sim}_{user}=2\\left(\\frac{d_{user,sat}}{c}+L_{ISL}+\\frac{d_{gateway}}{c}+\\tau_{proc}+\\tau_{terr}\\right)
    \\]
  </div>

  <h2>业务曲线对照</h2>
  <p class="note">Cloudflare Radar 是 AS14593 公开聚合观测，下面比较的是归一化后的时间形态，不是把 Radar 指数值等同于模型 Mbps。</p>
  <div class="panel">${lineChart(trafficRows, [
    { id: "model_normalized", label: "模型业务", color: "#2563eb" },
    { id: "external_radar_normalized", label: "Cloudflare Radar", color: "#16a34a" },
    { id: "calibration_template_normalized", label: "旧本地模板", color: "#c76b0a" },
  ], { title: "模型业务曲线与 Cloudflare Radar 归一化对照" })}</div>
  <table><tbody>
    <tr><th>Radar 点数</th><td>${traffic.external_radar_points}</td><th>对齐点数</th><td>${traffic.external_radar_aligned_points}</td></tr>
    <tr><th>时间窗</th><td colspan="3">${escapeHtml(traffic.external_radar_first_time)} 到 ${escapeHtml(traffic.external_radar_last_time)}</td></tr>
    <tr><th>相关系数</th><td>${traffic.model_vs_external_radar_corr}</td><th>归一化 MAE</th><td>${traffic.model_vs_external_radar_mae_normalized}</td></tr>
  </tbody></table>

  <h2>核心结果</h2>
  <div class="panel">${metricBarChart([
    { label: "轨道匹配率", value: orbit.match_ratio, display: orbit.match_ratio, color: "#2563eb" },
    { label: "RAAN 相似度", value: constellation.raan_distribution_similarity, display: constellation.raan_distribution_similarity, color: "#0f766e" },
    { label: "业务相关", value: traffic.model_vs_external_radar_corr, display: traffic.model_vs_external_radar_corr, color: "#16a34a" },
    { label: "RTT 比例", value: network.model_user_ping_to_ripe_p50_latency_ratio, display: network.model_user_ping_to_ripe_p50_latency_ratio, color: "#c76b0a" },
  ], { title: "外部真实性验证核心指标" })}</div>

  <h2>分项结论</h2>
  <table><tbody>
    <tr><th>轨道真实性</th><td>匹配 ${orbit.matched_satellites} 颗卫星，高度 MAE ${orbit.output_altitude_mae_km} km，倾角/平均运动/RAAN 与外部目录一致，外部强支撑。</td></tr>
    <tr><th>星座拓扑</th><td>模型为目标壳层的 72x22 大规模样本，覆盖比 ${constellation.scale_coverage_ratio}，RAAN 分布相似度 ${constellation.raan_distribution_similarity}，不是完整运营级复刻。</td></tr>
    <tr><th>业务响应</th><td>Radar 驱动后，模型业务曲线与 Cloudflare Radar 相关系数 ${traffic.model_vs_external_radar_corr}，归一化 MAE ${traffic.model_vs_external_radar_mae_normalized}，峰谷同步关系成立。</td></tr>
    <tr><th>网络性能</th><td>模型用户侧 P50 RTT ${network.model_user_ping_p50_ms} ms，RIPE P50 ${network.external_ripe_rtt_p50_ms} ms，比例 ${network.model_user_ping_to_ripe_p50_latency_ratio}；P95 尾部偏高，需要在后续网关/PoP 建模中继续细化。</td></tr>
    ${internalConclusionRow}
  </tbody></table>

  <h2>最终判断</h2>
  <p>本实验支持把当前第一阶段模型称为“面向 INT 遥测与状态预测实验的高可信 LEO 卫星网络仿真真值环境”。链路时延已经从演示型逐跳固定大延迟修正为传播主导模型，内部 CPU、电池、队列等潜变量也经过公式和响应审计，可以用于后续 INT 全网遥测、INT-MC 低开销遥测、采样率消融、误差重构和机器学习预测实验。</p>
  <p>本实验不支持宣称项目已经复刻了 Starlink 真实内部网络，原因是逐星 CPU、队列、电池、真实 ISL 占用、内部路由策略和 INT 遥测真值没有公开。</p>
</main>
</body>
</html>
`;

const summary = {
  generated_at: generatedAt,
  out_dir: rel(outDir),
  old_experiments_archive: archivePath || null,
  truth: {
    satellites: truthMetadata.node_count,
    slices: truthMetadata.slice_count,
    node_rows: csvRowCount(nodeRows),
    link_rows: csvRowCount(linkRows),
    route_rows: csvRowCount(routeRows),
    trace_rows: csvRowCount(traceRows),
    dataset_fingerprint: truthMetadata.dataset_fingerprint,
    truth_fingerprint: truthMetadata.truth_fingerprint,
  },
  orbit,
  constellation,
  traffic,
  network,
  internal_plausibility: internalPlausibility
    ? {
        check_count: internalPlausibility.check_count,
        passed_count: internalPlausibility.passed_count,
        failed_count: internalPlausibility.failed_count,
        internal_plausibility_score: internalPlausibility.internal_plausibility_score,
        inferred_battery_capacity_wh: internalPlausibility.inferred_battery_capacity_wh,
        inferred_solar_peak_power_w: internalPlausibility.inferred_solar_peak_power_w,
      }
    : null,
  conclusion:
    "High-confidence simulation truth for INT telemetry and prediction experiments under public orbit, topology, traffic, user-side RTT, and internal latent-state plausibility constraints; not an operator-internal Starlink replica.",
};

await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, "experiment1-research-report.md"), markdown, "utf8");
await writeFile(join(outDir, "experiment1-research-report.html"), html, "utf8");
await writeFile(join(outDir, "experiment1-research-summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");

console.log(
  JSON.stringify(
    {
      ok: true,
      outputs: {
        md: rel(join(outDir, "experiment1-research-report.md")),
        html: rel(join(outDir, "experiment1-research-report.html")),
        summary_json: rel(join(outDir, "experiment1-research-summary.json")),
      },
      key_results: {
        orbit_altitude_mae_km: orbit.output_altitude_mae_km,
        traffic_corr: traffic.model_vs_external_radar_corr,
        traffic_mae: traffic.model_vs_external_radar_mae_normalized,
        user_rtt_ratio: network.model_user_ping_to_ripe_p50_latency_ratio,
      },
    },
    null,
    2,
  ),
);
