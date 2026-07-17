import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

function argValue(args, name, fallback = "") {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? fallback : fallback;
}

function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
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

function numberValue(value, fallback = NaN) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatNumber(value, digits = 3) {
  const parsed = numberValue(value);
  return Number.isFinite(parsed) ? parsed.toFixed(digits) : "-";
}

function formatBytes(value) {
  const bytes = numberValue(value);
  if (!Number.isFinite(bytes)) return "-";
  if (bytes >= 1000) return `${(bytes / 1000).toFixed(2)} KB`;
  return `${bytes.toFixed(1)} B`;
}

function formatPercent(value) {
  const parsed = numberValue(value);
  return Number.isFinite(parsed) ? `${(parsed * 100).toFixed(2)}%` : "-";
}

const METHOD_COLORS = {
  "traffic-int": "#0f766e",
  "full-probe-int": "#2563eb",
  "shortest-path-probe": "#9333ea",
  "random-sampling-aggregate": "#f59e0b",
  "int-mc-selected-probe": "#64748b",
  "leo-int-mc-enhanced": "#dc2626",
};

function chartScale(values, { log = false } = {}) {
  const finite = values.filter((value) => Number.isFinite(value) && (!log || value > 0));
  if (finite.length === 0) return { min: 0, max: 1 };
  const transformed = log ? finite.map((value) => Math.log10(value)) : finite;
  const min = Math.min(...transformed);
  const max = Math.max(...transformed);
  if (Math.abs(max - min) < 1e-9) return { min: min - 0.5, max: max + 0.5 };
  const pad = (max - min) * 0.08;
  return { min: min - pad, max: max + pad };
}

function scatter({ rows, yField, title, formatter = (value) => formatNumber(value, 3) }) {
  const width = 1120;
  const height = 430;
  const margin = { top: 52, right: 42, bottom: 86, left: 92 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const points = rows
    .map((row) => ({ row, x: numberValue(row.telemetry_bytes_per_node_slice), y: numberValue(row[yField]) }))
    .filter((point) => Number.isFinite(point.x) && point.x > 0 && Number.isFinite(point.y));
  if (points.length === 0) {
    return `<svg viewBox="0 0 ${width} ${height}"><text x="32" y="42" font-size="18" font-weight="700">${escapeHtml(title)}</text><text x="32" y="76" fill="#64748b">没有可绘制数据。</text></svg>`;
  }
  const xScale = chartScale(points.map((point) => point.x), { log: true });
  const yMax = Math.max(0.001, ...points.map((point) => point.y)) * 1.12;
  const x = (value) => margin.left + ((Math.log10(value) - xScale.min) / Math.max(xScale.max - xScale.min, 1e-9)) * plotWidth;
  const y = (value) => margin.top + plotHeight - (value / yMax) * plotHeight;
  const xTicks = [10, 20, 50, 100, 200, 500, 1000, 2000]
    .filter((value) => Math.log10(value) >= xScale.min && Math.log10(value) <= xScale.max)
    .map((value) => {
      const tx = x(value);
      return `<line x1="${tx}" x2="${tx}" y1="${margin.top}" y2="${margin.top + plotHeight}" stroke="#e2e8f0"/><text x="${tx}" y="${height - 52}" text-anchor="middle" font-size="11">${escapeHtml(formatBytes(value))}</text>`;
    }).join("");
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((ratio) => {
    const value = yMax * ratio;
    const ty = y(value);
    return `<line x1="${margin.left}" x2="${width - margin.right}" y1="${ty}" y2="${ty}" stroke="#e2e8f0"/><text x="${margin.left - 8}" y="${ty + 4}" text-anchor="end" font-size="11">${escapeHtml(formatter(value))}</text>`;
  }).join("");
  const profileYOffset = new Map([
    ["iridium-next-small", -7],
    ["telesat-1015-medium", 0],
    ["starlink-main-large", 7],
  ]);
  const circles = points.map((point) => {
    const row = point.row;
    const cx = x(point.x);
    const cy = y(point.y) + (profileYOffset.get(row.constellation_profile_id) ?? 0);
    return `<circle cx="${cx}" cy="${cy}" r="6" fill="${METHOD_COLORS[row.method_id] ?? "#334155"}" stroke="#fff" stroke-width="1.5" opacity="0.9"><title>${escapeHtml(row.constellation_short_label)} / ${escapeHtml(row.method_label)}\n开销 ${escapeHtml(formatBytes(point.x))}/节点/片\n误差 ${escapeHtml(formatter(point.y))}</title></circle>`;
  }).join("");
  const labels = points
    .filter((point) => ["int-mc-selected-probe", "leo-int-mc-enhanced"].includes(point.row.method_id))
    .map((point) => {
      const row = point.row;
      const cx = x(point.x);
      const cy = y(point.y) + (profileYOffset.get(row.constellation_profile_id) ?? 0);
      return `<text x="${cx + 9}" y="${cy + 4}" font-size="10" fill="#334155">${escapeHtml(row.constellation_short_label.replace(" ", ""))}/${escapeHtml(row.method_label.replace(" INT", ""))}</text>`;
    }).join("");
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(title)}">
    <text x="${margin.left}" y="26" font-size="17" font-weight="700">${escapeHtml(title)}</text>
    <text x="${margin.left}" y="44" font-size="12" fill="#64748b">横轴为遥测开销，对数刻度；纵轴为误差，越靠左下越优。</text>
    ${xTicks}
    ${yTicks}
    <line x1="${margin.left}" x2="${margin.left}" y1="${margin.top}" y2="${margin.top + plotHeight}" stroke="#64748b"/>
    <line x1="${margin.left}" x2="${width - margin.right}" y1="${margin.top + plotHeight}" y2="${margin.top + plotHeight}" stroke="#64748b"/>
    ${circles}
    ${labels}
  </svg>`;
}

function buildHtml(rows) {
  const enhanced = rows.filter((row) => row.method_id === "leo-int-mc-enhanced");
  const original = rows.filter((row) => row.method_id === "int-mc-selected-probe");
  const summaryRows = enhanced.map((row) => {
    const base = original.find((item) => item.constellation_profile_id === row.constellation_profile_id);
    return { row, base };
  });
  const cards = summaryRows.map(({ row, base }) => {
    const byteDelta = numberValue(row.telemetry_bytes_per_node_slice) - numberValue(base?.telemetry_bytes_per_node_slice);
    const bytePct = byteDelta / numberValue(base?.telemetry_bytes_per_node_slice) * 100;
    return `<div class="card"><h3>${escapeHtml(row.constellation_short_label)}</h3>
      <p>开销：${escapeHtml(formatBytes(base?.telemetry_bytes_per_node_slice))} -> ${escapeHtml(formatBytes(row.telemetry_bytes_per_node_slice))}，变化 ${Number.isFinite(bytePct) ? `${bytePct.toFixed(2)}%` : "-"}。</p>
      <p>CPU MAE：${escapeHtml(formatNumber(base?.cpu_mae, 4))} -> ${escapeHtml(formatNumber(row.cpu_mae, 4))}；电量 MAE：${escapeHtml(formatNumber(base?.energy_percent_mae, 4))} -> ${escapeHtml(formatNumber(row.energy_percent_mae, 4))}。</p>
      <p>链路状态准确率：${escapeHtml(formatPercent(base?.link_status_accuracy))} -> ${escapeHtml(formatPercent(row.link_status_accuracy))}；补全利用率 MAE：${escapeHtml(formatNumber(base?.utilization_inferred_mae, 4))} -> ${escapeHtml(formatNumber(row.utilization_inferred_mae, 4))}。</p>
    </div>`;
  }).join("");
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8"/>
  <title>实验2 多目标误差-开销权衡报告</title>
  <style>
    body{font-family:Arial,"Microsoft YaHei",sans-serif;background:#f8fafc;color:#0f172a;margin:0;padding:28px}
    main{max-width:1240px;margin:0 auto}
    h1{margin:0 0 8px}
    .muted{color:#64748b}
    .grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}
    .panel,.card{background:white;border:1px solid #e2e8f0;border-radius:8px;padding:16px;box-shadow:0 1px 2px rgba(15,23,42,.05)}
    .cards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;margin:18px 0}
    svg{width:100%;height:auto;display:block}
    @media(max-width:900px){.grid,.cards{grid-template-columns:1fr}}
  </style>
</head>
<body>
<main>
  <h1>实验2：多目标误差-开销权衡报告</h1>
  <p class="muted">本报告从 Pareto 视角展示遥测开销与节点/链路重构误差之间的关系。理想方法应尽量靠近左下区域。</p>
  <section class="cards">${cards}</section>
  <section class="grid">
    <div class="panel">${scatter({ rows, yField: "cpu_mae", title: "CPU MAE-遥测开销权衡图" })}</div>
    <div class="panel">${scatter({ rows, yField: "queue_depth_mae", title: "队列 MAE-遥测开销权衡图" })}</div>
    <div class="panel">${scatter({ rows, yField: "energy_percent_mae", title: "电量 MAE-遥测开销权衡图" })}</div>
    <div class="panel">${scatter({ rows, yField: "utilization_inferred_mae", title: "链路利用率补全 MAE-遥测开销权衡图" })}</div>
  </section>
</main>
</body>
</html>`;
}

const args = process.argv.slice(2);
const input = resolve(argValue(args, "--input", "reports/experiment2-baseline-comparison-oracle-free-replay/experiment2-comprehensive-baseline-summary.csv"));
const output = resolve(argValue(args, "--out", "reports/experiment2-baseline-comparison-oracle-free-replay/experiment2-multi-objective-pareto-report.html"));
const rows = parseCsv(await readFile(input, "utf8"));
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `\uFEFF${buildHtml(rows)}`, "utf8");
console.log(JSON.stringify({ ok: true, input, output, rows: rows.length }, null, 2));
